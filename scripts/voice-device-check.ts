/**
 * Device acceptance (真实麦克风与扬声器验收).
 *
 * Uses a loopback recording (speaker → air → microphone) instead of a clean
 * fixture, so it exercises everything a fixture cannot: the playback path, the
 * capture path, room noise/reverb, and resampling. Then it runs the real
 * pipeline on that recording — VAD → ASR → conversation — and compares the
 * transcription with the text that was spoken.
 *
 * Usage:
 *   python -m voice_edge.loopback tests/audio-fixtures/direct-question.wav data/voice/loopback.wav
 *   node scripts/voice-device-check.ts --wav data/voice/loopback.wav --expect "西西，明天天气怎么样？"
 *   node scripts/voice-device-check.ts --print-wiring   # 离线：打印这条入口交给模型的工具链，然后退出
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { MimoBrainAdapter, type ToolCallRecord, type ToolRegistry } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { MimoClient } from '@xixi/model-adapters';
// V0.3 P0-A: the shared tool chain lives in `@xixi/runtime` now (pack `04_RUNTIME_CONSOLIDATION.md`
// §1 Step A); `scripts/field-test.ts` keeps a compatibility re-export for un-migrated callers.
import { CONVERSATION_SCOPE, buildToolChain } from '@xixi/runtime';
import { openXixiStore, type XixiConfig } from '@xixi/domain';

import { REPO_ROOT, loadConfig, printEvidence, readDotEnv, resolvePython } from './lib/harness.ts';
import { characterSimilarity } from './lib/similarity.ts';
import { readWav, sliceWav } from './lib/wav.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const PYTHON = resolvePython({ venvs: ['voice-pipecat'] });
/** Acoustic capture is imperfect; this is a floor for "the pipeline works through the air". */
const MIN_SIMILARITY = 0.5;

const args = process.argv.slice(2);
function argValue(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? (args[index + 1] as string) : fallback;
}

const wavPath = argValue('--wav', join(REPO_ROOT, 'data', 'voice', 'loopback.wav'));
const expected = argValue('--expect', '西西，明天天气怎么样？');

interface Segmentation {
  segments: { startMs: number; endMs: number; endpointDelayMs: number | null }[];
  energyStartMs: number | null;
  bargeInDecisionMs: number | null;
  timings?: { loadMs: number; processMs: number };
}

function runPython(pythonArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, pythonArgs, { cwd: join(REPO_ROOT, 'services', 'voice-edge'), windowsHide: true });
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
    child.on('close', (code) => (code === 0 || code === 2 ? resolve(stdout) : reject(new Error(`VAD failed (${code}): ${stderr.slice(-300)}`))));
  });
}

/** Character-level similarity after removing punctuation and spaces (shared with verify-voice-noise). */
function similarity(a: string, b: string): number {
  return characterSimilarity(a, b);
}

/**
 * The one tool chain this entry talks through (pack Phase 2, extended in t14/T5-F1): the console's
 * own factory, so the device check runs the same four built-ins, the same permissions and the same
 * round cap as every other live entry — a real microphone question about the weather now reaches the
 * weather tool instead of being answered from memory.
 */
function deviceToolChain(config: XixiConfig, onToolCall?: (record: ToolCallRecord) => void): ToolRegistry {
  return buildToolChain(config, onToolCall === undefined ? {} : { onToolCall });
}

/** The offline wiring report (`--print-wiring`): what this entry hands the model, without a model call. */
function printWiring(config: XixiConfig): void {
  const chain = deviceToolChain(config);
  console.log(
    JSON.stringify({
      entry: 'voice-device-check',
      language: config.identity.language,
      maxToolRounds: chain.maxToolRounds,
      tools: chain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name),
      permissions: Object.fromEntries(chain.names().map((name) => [name, chain.check(name, CONVERSATION_SCOPE).verdict])),
    }),
  );
}

async function runDeviceCheck(): Promise<void> {
  const segmentation = JSON.parse(await runPython(['-m', 'voice_edge.segment', wavPath])) as Segmentation;
  const speech = segmentation.segments[0];
  if (speech === undefined) {
    printEvidence('设备验收', { wav: wavPath, result: 'FAILED', reason: 'VAD 在录音里没有检测到语音' });
    console.error('设备验收 FAILED：录音里没有可用的语音段（麦克风静音、音量过低或设备选错？）');
    process.exit(1);
  }

  const client = new MimoClient();
  const speechBuffer = sliceWav(readWav(wavPath), speech.startMs, speech.endMs);
  const asrStarted = Date.now();
  const transcription = await client.transcribe(speechBuffer);
  const asrMs = Date.now() - asrStarted;
  const score = similarity(transcription.text, expected);

  // Then run a real conversation turn from that acoustic input, to prove the whole
  // loop — not just ASR — works on recorded audio.
  const config = loadConfig();
  const store = openXixiStore({ dataDir: join(REPO_ROOT, 'data', 'voice-device') });
  store.seedSelfProfile(config.personality.base);
  const session = store.createSession();
  const engine = new ConversationEngine({
    adapter: new MimoBrainAdapter({
      client,
      maxCompletionTokens: 400,
      registry: deviceToolChain(config, (record) => console.log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`)),
      scope: CONVERSATION_SCOPE,
      timezone: config.identity.timezone,
      language: config.identity.language,
    }),
    store,
    config,
    turnTimeoutMs: 60_000,
  });
  const turn = await engine.respond({ sessionId: session.sessionId, text: transcription.text, addressed: true });
  let replyWav: string | null = null;
  if (turn.action === 'SPEAK' && turn.text !== null) {
    const audio = await client.synthesize(turn.text);
    replyWav = join(REPO_ROOT, 'data', 'voice', 'device-reply.wav');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(replyWav, audio);
  }
  store.close();

  const ok = score >= MIN_SIMILARITY;
  printEvidence('设备验收（扬声器 → 空气 → 麦克风 → VAD → ASR → 对话 → TTS）', {
    recording: wavPath,
    expected,
    transcription: transcription.text,
    similarity: score,
    threshold: MIN_SIMILARITY,
    asrMs,
    vad: { startMs: segmentation.segments[0]?.startMs, endMs: segmentation.segments[0]?.endMs, endpointDelayMs: segmentation.segments[0]?.endpointDelayMs, bargeInDecisionMs: segmentation.bargeInDecisionMs, processMs: segmentation.timings?.processMs },
    conversation: { action: turn.action, text: turn.text, latencyMs: turn.latencyMs, toolName: turn.toolName },
    replyWav,
    verdict: ok ? 'PASS' : 'FAIL',
  });

  if (!ok) {
    console.error(`设备验收 FAILED：转写与原文相似度 ${score} < ${MIN_SIMILARITY}（转写：「${transcription.text}」）`);
    process.exit(1);
  }
  console.log(`\n设备验收 PASS：录音转写相似度 ${score}；对话回复「${turn.text ?? '(沉默)'}」；回复音频 ${replyWav ?? '(无)'}`);
}

// The body is behind the entry guard so the wiring above can be read (and imported) without a
// device: the check itself needs a real recording, a Python venv and a live ASR call.
if (import.meta.main) {
  if (args.includes('--print-wiring')) printWiring(loadConfig());
  else await runDeviceCheck();
}
