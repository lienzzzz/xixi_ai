/**
 * Voice turn: WAV in → VAD → ASR → conversation → TTS → WAV out.
 *
 * This is the M1 slice the plan asks for, minus the microphone: the audio source
 * is a fixture, everything after it is the real pipeline. It is runnable,
 * repeatable, and its per-stage timings come straight from 《方案》§46.4
 * (`vad`, `asr`, `llm_ttft`, `tts_first_chunk`, `e2e`).
 *
 * Privacy (§20.1): only the VAD-detected speech spans are uploaded, never the whole
 * recording, and raw audio is never stored beyond the explicit output files.
 *
 * Multi-segment: a recording that contains more than one speech segment (a pause
 * in the middle of a test sentence is the normal case) now feeds *all* of them to
 * ASR, stitched in order with a short gap. Anything left out by the per-call caps
 * is reported in `droppedSegments` with a reason — never dropped silently.
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
import { concatWav, readWavInfo, readWav } from './lib/wav.ts';
// Shared with the field-test console: the multi-segment planner and the
// speech-only slicer, so "use every segment" lives in exactly one place.
// `buildToolChain`/`CONVERSATION_SCOPE` come from the same file for the same reason:
// this voice entry and the console must not drift into two tool chains (pack Phase 2).
import { buildSpeechAudio, buildToolChain, CONVERSATION_SCOPE, planSpeechSegments, type DroppedSegment } from './field-test.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const PYTHON = process.env.XIXI_PYTHON ?? join(REPO_ROOT, '.venvs', 'voice-pipecat', 'Scripts', 'python.exe');
const OUT_DIR = join(REPO_ROOT, 'data', 'voice');

interface VoiceTurnResult {
  readonly wav: string;
  readonly speech: { startMs: number; endMs: number; endpointDelayMs: number | null } | null;
  /** Every VAD segment of this file, in order (not just the first one). */
  readonly segments: readonly { startMs: number; endMs: number; durationMs: number }[];
  readonly segmentsTotal: number;
  readonly segmentsUsed: number;
  /** Anything left out, with the reason — never a silent drop. */
  readonly droppedSegments: readonly DroppedSegment[];
  readonly transcript: string | null;
  readonly reply: string | null;
  readonly action: string;
  /** Pack Phase 2: the tool that backed this voice turn, when one ran. */
  readonly toolName: string | null;
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
/**
 * Pack Phase 2: the file-driven voice entry uses the *same* tool chain as the text
 * entries (`buildToolChain` → one registry with the four built-ins). Before this, the
 * voice path had no tools at all: asking about the weather by voice could only be
 * answered from memory.
 */
const toolChain = buildToolChain(config, {
  onToolCall: (record) => console.log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`),
});
const adapter: BrainAdapter = useFake
  ? new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE })
  : new (await import('@xixi/brain-adapter')).MimoBrainAdapter({
      maxCompletionTokens: 400,
      registry: toolChain,
      scope: CONVERSATION_SCOPE,
      timezone: config.identity.timezone,
      language: config.identity.language,
    });
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
  const rawWav = readWav(absolute);
  // Use every detected segment (§20.1: only speech is uploaded; and a second
  // sentence in the same recording must not be dropped silently).
  const plan = planSpeechSegments(segmentation.segments);
  const speech = plan.used[0] ?? null;

  if (speech === null) {
    results.push({
      wav: wavPath,
      speech: null,
      segments: [],
      segmentsTotal: 0,
      segmentsUsed: 0,
      droppedSegments: [],
      transcript: null,
      reply: null,
      action: 'SILENCE',
      accepted: false,
      toolName: null,
      reason: 'NO_SPEECH_DETECTED',
      replyWav: null,
      timings: { vadMs, sourceDurationMs: Math.round(info.durationMs) },
    });
    continue;
  }

  // Only the speech spans are uploaded (§20.1); several segments are stitched
  // with a short silence so ASR does not fuse the words across the gap.
  const speechBuffer = buildSpeechAudio(rawWav, plan);
  const lastUsed = plan.used[plan.used.length - 1] as (typeof plan.used)[number];

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
    speech: { startMs: speech.startMs, endMs: speech.endMs, endpointDelayMs: speech.endpointDelayMs ?? null },
    segments: plan.used.map((item) => ({
      startMs: item.startMs,
      endMs: item.endMs,
      durationMs: item.durationMs ?? Math.round(item.endMs - item.startMs),
    })),
    segmentsTotal: segmentation.segments.length,
    segmentsUsed: plan.used.length,
    droppedSegments: plan.dropped,
    transcript,
    reply: turn.text,
    action: turn.action,
    accepted: turn.accepted,
    toolName: turn.toolName,
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
          : Math.round((lastUsed.endpointDelayMs ?? 0) + asrMs + (firstChunkAt - llmStart)),
      e2eToFirstReplyAudioMs:
        ttsMs === null || firstChunkAt === null
          ? null
          : Math.round((lastUsed.endpointDelayMs ?? 0) + asrMs + (firstChunkAt - llmStart) + ttsMs),
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
  note: 'e2e 估算含 VAD 端点延迟；每段文件的 segmentsTotal/segmentsUsed/droppedSegments 说明是否丢弃了语音段（不再静默丢弃）；真实麦克风与扬声器验收见 docs/recon/field-test-report-<日期>.md（§33 的 P50 < 500ms 打断目标不在本次证据内）',
});
store.recordHealth('voice-edge', 'ok', `voice turn batch of ${wavs.length}`);
store.close();
