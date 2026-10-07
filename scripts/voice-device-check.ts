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
 *                                                      #   （含插件提供的 news.search / news.latest / news.for_interests）
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { FakeBrainAdapter, MimoBrainAdapter } from '@xixi/brain-adapter';
import { MimoClient } from '@xixi/model-adapters';
// V0.3 P0-A: the shared tool chain lives in `@xixi/runtime` now (pack `04_RUNTIME_CONSOLIDATION.md`
// §1 Step A); `scripts/field-test.ts` keeps a compatibility re-export for un-migrated callers.
// V0.3 P2.5-C: 工具链、插件内核（news 从这里进来）、审批宿主、durable 提醒、提取与引擎全部来自常驻
// 装配点 `createResidentRuntime` —— 本文件不再自己拼链，也不再自己 new 引擎。
import {
  CONVERSATION_SCOPE,
  createResidentRuntime,
  type PluginChainOptions,
  type ResidentModelInput,
  type XixiResidentRuntime,
} from '@xixi/runtime';
import { openXixiStore, type XixiConfig, type XixiStore } from '@xixi/domain';
import { createRssNewsSource } from '@xixi/plugins/news';

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
 * 这个部署的新闻来源（V0.3 P2.5-C，与另外几个入口同一份口径）。
 *
 * 今天它是**入口里显式给出**的一条公开 RSS（与 `node scripts/probe-tools.ts --news-live` 的默认
 * feed 相同）；P2.5-H 会把它换成 `config.plugins.news.sources`。不给来源不行：`news.*` 三个工具
 * 照样会被广告给模型，而没有来源的调用只有 `items: []`，模型很容易读成「今天没什么新闻」。
 */
const NEWS_FEED_URL = 'https://feeds.bbci.co.uk/news/world/rss.xml';

/** `--print-wiring` 的离线保证：给插件网络授权的 fetch 一用即抛。 */
const offlinePluginFetch = (async (input: string | URL | Request) => {
  throw new Error(`--print-wiring 是离线报告，不允许联网：${String(input)}`);
}) as unknown as typeof fetch;

/** 这个入口的插件层入参：来源是新闻插件，离线开关换掉它的网络授权。 */
function devicePluginLayer(offline: boolean): Pick<PluginChainOptions, 'news' | 'fetchImpl'> {
  return {
    ...(offline ? { fetchImpl: offlinePluginFetch } : {}),
    news: { sources: [(env) => createRssNewsSource({ name: 'BBC World', url: NEWS_FEED_URL, fetchImpl: env.fetchImpl })] },
  };
}

export interface DeviceCheckRuntimeOptions {
  readonly config: XixiConfig;
  readonly store: XixiStore;
  /** 真实自检用已经建好的 MiMo 客户端（ASR 与 TTS 也用它）；不给就由适配器自己建。 */
  readonly client?: MimoClient | undefined;
  /** 覆盖模型装配（`--print-wiring` 给一个永不被调用的替身）。 */
  readonly model?: ResidentModelInput | undefined;
  /** 报告路径：插件的网络授权换成一用即抛的 fetch。 */
  readonly offlinePlugins?: boolean | undefined;
  /** 生命周期横幅往哪写（默认 stdout）；报告路径改成 stderr，好让 stdout 只剩报告那一行 JSON。 */
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * 这个入口的常驻运行时（V0.3 P2.5-C）：工具链、插件内核、审批宿主、durable 提醒、记忆提取与引擎
 * 一次装好 —— 真实麦克风问一句天气，走的就是控制台/文字入口同一条链与同一份权限政策。
 */
export function createDeviceCheckRuntime(options: DeviceCheckRuntimeOptions): XixiResidentRuntime {
  const { config, store } = options;
  return createResidentRuntime({
    config,
    store,
    ...devicePluginLayer(options.offlinePlugins === true),
    onToolCall: (record) => console.log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`),
    log: options.log ?? ((line) => console.log(line)),
    conversation: { turnTimeoutMs: 60_000 },
    model:
      options.model ??
      (({ toolChain }) =>
        new MimoBrainAdapter({
          ...(options.client === undefined ? {} : { client: options.client }),
          maxCompletionTokens: 400,
          registry: toolChain,
          scope: CONVERSATION_SCOPE,
          timezone: config.identity.timezone,
          language: config.identity.language,
        })),
  });
}

/** The offline wiring report (`--print-wiring`): what this entry hands the model, without a model call. */
async function printWiring(config: XixiConfig): Promise<void> {
  // 与真实一轮**同一个装配函数**（`createDeviceCheckRuntime`），三处差别都是为了离线：一次性内存库、
  // 一用即抛的 fetch、永不被调用的替身模型。
  const runtime = createDeviceCheckRuntime({
    config,
    store: openXixiStore({ dbPath: ':memory:' }),
    offlinePlugins: true,
    // 报告的 stdout 只有那一行 JSON（脚本要能直接管道给 jq）：装配点自己的横幅改走 stderr。
    log: (line) => process.stderr.write(`${line}\n`),
    model: ({ toolChain }) => new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE }),
  });
  try {
    const started = await runtime.start();
    const chain = runtime.toolChain;
    console.log(
      JSON.stringify({
        entry: 'voice-device-check',
        language: config.identity.language,
        maxToolRounds: chain.maxToolRounds,
        tools: chain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name),
        permissions: Object.fromEntries(chain.names().map((name) => [name, chain.check(name, CONVERSATION_SCOPE).verdict])),
        plugins: { mounted: [...started.mounted], skipped: [...started.skipped], refused: [...started.refused] },
      }),
    );
  } finally {
    await runtime.stop();
    runtime.store.close();
  }
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
  /**
   * V0.3 P2.5-C：装配一次（链 + 插件内核 + 审批宿主 + durable 提醒 + 提取 + 引擎），然后在回答之前
   * `start()` —— 插件/MCP/news 的工具是在那一步挂进链的，所以从「透过空气录进来的第一句话」起，
   * 模型看到的就是带插件工具的那条链。
   */
  const runtime = createDeviceCheckRuntime({ config, store, client });
  await runtime.start();
  const engine = runtime.conversation;
  const turn = await engine.respond({ sessionId: session.sessionId, text: transcription.text, addressed: true });
  let replyWav: string | null = null;
  if (turn.action === 'SPEAK' && turn.text !== null) {
    const audio = await client.synthesize(turn.text);
    replyWav = join(REPO_ROOT, 'data', 'voice', 'device-reply.wav');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(replyWav, audio);
  }
  // 关库之前先关停运行时（它内含提取的 drain，并撤下插件工具）；关停报告要读库，所以顺序不能反。
  await runtime.stop();
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
  // P2.5-C：报告要起一次常驻装配（挂上插件工具再读链），所以这里 await —— 不等它跑完进程就结束了。
  if (args.includes('--print-wiring')) await printWiring(loadConfig());
  else await runDeviceCheck();
}
