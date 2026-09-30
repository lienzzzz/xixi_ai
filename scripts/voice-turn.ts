/**
 * Voice turn: WAV in → VAD → ASR → conversation → TTS → WAV out.
 *
 * This is the M1 slice the plan asks for, minus the microphone: the audio source
 * is a fixture, everything after it is the real pipeline. It is runnable,
 * repeatable, and its per-stage timings come straight from 《方案》§46.4
 * (`vad`, `asr`, `llm_ttft`, `tts_first_chunk`, `e2e`).
 *
 * Privacy (§20.1): only the VAD-detected speech span is uploaded, never the whole
 * recording, and raw audio is never stored beyond the explicit output files.
 *
 * Usage:
 *   node scripts/voice-turn.ts --wav tests/audio-fixtures/direct-question.wav
 *   node scripts/voice-turn.ts --wav a.wav --wav b.wav --wav c.wav   # one voice session
 *   node scripts/voice-turn.ts --wav x.wav --fake                    # offline plumbing test
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FakeBrainAdapter, type BrainAdapter } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { MimoClient } from '@xixi/model-adapters';
import { openXixiStore } from '@xixi/domain';

import { REPO_ROOT, loadConfig, printEvidence, readDotEnv } from './lib/harness.ts';
import { concatWav, readWavInfo, sliceWav, readWav } from './lib/wav.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const PYTHON = process.env.XIXI_PYTHON ?? join(REPO_ROOT, '.venvs', 'voice-pipecat', 'Scripts', 'python.exe');
const OUT_DIR = join(REPO_ROOT, 'data', 'voice');

interface VoiceTurnResult {
  readonly wav: string;
  readonly speech: { startMs: number; endMs: number; endpointDelayMs: number | null } | null;
  readonly transcript: string | null;
  readonly reply: string | null;
  readonly action: string;
  readonly accepted: boolean;
  readonly reason: string;
  readonly replyWav: string | null;
  readonly timings: Record<string, number | null>;
}

interface SegmentationResult {
  readonly segments: { startMs: number; endMs: number; endpointDelayMs: number | null }[];
  readonly durationMs: number;
  readonly timings?: { loadMs: number; processMs: number; audioMs: number };
}

function runPython(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, { cwd: join(REPO_ROOT, 'services', 'voice-edge'), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
    });
    child.stderr.on('data', (data: string) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // Exit 2 means "no speech segments", which is a result, not a failure.
      if (code === 0 || code === 2) resolve(stdout);
      else reject(new Error(`VAD failed (exit ${code}): ${stderr.slice(-400)}`));
    });
  });
}

async function segment(wavPath: string): Promise<SegmentationResult> {
  const stdout = await runPython(['-m', 'voice_edge.segment', wavPath]);
  return JSON.parse(stdout) as SegmentationResult;
}

const args = process.argv.slice(2);
const useFake = args.includes('--fake');
const wavs: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--wav' && args[index + 1] !== undefined) wavs.push(args[index + 1]);
}
if (wavs.length === 0) {
  console.error('用法：node scripts/voice-turn.ts --wav <file.wav> [--wav <file2.wav> ...] [--fake]');
  process.exit(2);
}

const config = loadConfig();
const client = useFake ? null : new MimoClient();
const store = openXixiStore({ dataDir: join(REPO_ROOT, 'data', 'voice') });
store.seedSelfProfile(config.personality.base);
const session = store.latestSession() ?? store.createSession();
const adapter: BrainAdapter = useFake ? new FakeBrainAdapter() : new (await import('@xixi/brain-adapter')).MimoBrainAdapter({ maxCompletionTokens: 400 });
const engine = new ConversationEngine({ adapter, store, config, turnTimeoutMs: 60_000 });
mkdirSync(OUT_DIR, { recursive: true });

const results: VoiceTurnResult[] = [];
const replyBuffers: Buffer[] = [];
let first = true;

for (const wavPath of wavs) {
  const absolute = wavPath.startsWith('.') || wavPath.includes(':') ? wavPath : join(REPO_ROOT, wavPath);
  const info = readWavInfo(readWav(absolute));

  const vadStart = Date.now();
  const segmentation = await segment(absolute);
  const vadMs = Date.now() - vadStart;
  const speech = segmentation.segments[0] ?? null;

  if (speech === null) {
    results.push({
      wav: wavPath,
      speech: null,
      transcript: null,
      reply: null,
      action: 'SILENCE',
      accepted: false,
      reason: 'NO_SPEECH_DETECTED',
      replyWav: null,
      timings: { vadMs, sourceDurationMs: Math.round(info.durationMs) },
    });
    continue;
  }

  // Only the speech span is uploaded (§20.1).
  const speechBuffer = sliceWav(readWav(absolute), speech.startMs, speech.endMs);

  const asrStart = Date.now();
  const transcript = client === null ? `（离线模拟）${wavPath}` : (await client.transcribe(speechBuffer)).text;
  const asrMs = Date.now() - asrStart;

  const chunks: string[] = [];
  let firstChunkAt: number | null = null;
  const llmStart = Date.now();
  const turn = await engine.respond(
    { sessionId: session.sessionId, text: transcript, addressed: first },
    {
      onTextChunk: (chunk) => {
        if (firstChunkAt === null) firstChunkAt = Date.now();
        chunks.push(chunk);
      },
    },
  );
  const llmMs = Date.now() - llmStart;
  first = false;

  let replyWav: string | null = null;
  let ttsMs: number | null = null;
  if (turn.action === 'SPEAK' && turn.text !== null && client !== null) {
    const ttsStart = Date.now();
    const audio = await client.synthesize(turn.text);
    ttsMs = Date.now() - ttsStart;
    replyWav = join(OUT_DIR, `reply-${results.length + 1}.wav`);
    writeFileSync(replyWav, audio);
    replyBuffers.push(audio);
  }

  results.push({
    wav: wavPath,
    speech: { startMs: speech.startMs, endMs: speech.endMs, endpointDelayMs: speech.endpointDelayMs },
    transcript,
    reply: turn.text,
    action: turn.action,
    accepted: turn.accepted,
    reason: turn.reason,
    replyWav,
    timings: {
      sourceDurationMs: Math.round(info.durationMs),
      vadMs,
      // `processMs` is the streaming cost a resident voice process would pay;
      // `loadMs` + interpreter start are one-off cold-start costs.
      vadProcessMs: segmentation.timings?.processMs ?? null,
      vadModelLoadMs: segmentation.timings?.loadMs ?? null,
      asrMs,
      llmFirstChunkMs: firstChunkAt === null ? null : firstChunkAt - llmStart,
      llmTotalMs: llmMs,
      ttsMs,
      e2eSpeechEndToFirstChunkMs:
        firstChunkAt === null
          ? null
          : Math.round((speech.endpointDelayMs ?? 0) + asrMs + (firstChunkAt - llmStart)),
      e2eToFirstReplyAudioMs:
        ttsMs === null || firstChunkAt === null
          ? null
          : Math.round((speech.endpointDelayMs ?? 0) + asrMs + (firstChunkAt - llmStart) + ttsMs),
    },
  });
}

let conversationWav: string | null = null;
if (replyBuffers.length > 0) {
  conversationWav = join(OUT_DIR, 'voice-replies.wav');
  writeFileSync(conversationWav, concatWav(replyBuffers, 400));
}

printEvidence('语音闭环（夹具音频 → VAD → ASR → 对话 → TTS）', {
  adapter: adapter.describe(),
  sessionId: session.sessionId,
  turns: results,
  stitchedReplyWav: conversationWav,
  note: 'e2e 估算含 VAD 端点延迟；真实麦克风与扬声器仍未验收（§33 的 P50 < 500ms 打断目标不在本次证据内）',
});
store.recordHealth('voice-edge', 'ok', `voice turn batch of ${wavs.length}`);
store.close();
