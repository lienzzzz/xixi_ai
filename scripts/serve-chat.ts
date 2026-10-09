/**
 * 本地试用页面（浏览器里和西西对话）。
 *
 * 为什么需要它：`npm run chat` 要开终端，而「试试」最省事的方式是点开一个网页。
 * 这个服务只监听 127.0.0.1，用一次性进程 + 同一套对话引擎，不改变任何既有行为。
 *
 * 说明（对应《方案》§M1）：页面上的「发送」按钮就是 M2 之前唤醒词的替身——
 * 状态为 IDLE 时视为直呼，会话已开启时按「继续」处理（不必再喊名字）。
 *
 * 用法：node scripts/serve-chat.ts [--port 8791] [--no-tts]
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DshBrainAdapter, FakeBrainAdapter, MimoBrainAdapter, type ToolRegistry, type TurnModelProvider } from '@xixi/brain-adapter';
import { CliDshTransport } from '@xixi/brain-dsh';
import { TopicEngine } from '@xixi/conversation';
import { MimoClient } from '@xixi/model-adapters';
import { openXixiStore, resolveCanonicalDataDir, type XixiStore } from '@xixi/domain';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, readDotEnv, resolvePython } from './lib/harness.ts';
import {
  RuntimeError,
  DEFAULT_LOOP_INTERVAL_MS,
  LIVE_PRIVACY_NOTE,
  LiveSensors,
  MIN_LOOP_INTERVAL_MS,
  PERCEPTION_SERVICE_DIR,
  PROACTIVE_PANEL_CSS,
  ProactiveLoop,
  segmentTtsNote,
  XIXI_DB_ENTRIES,
  applyAndPersistProactivePatch,
  createModelComposer,
  createPerceptionLiveRunner,
  databaseNoteHtml,
  effectiveProactivity,
  handleVoiceTurn,
  lastUserTurnAt,
  proactiveConsoleState,
  proactiveDrill,
  proactivePanelHtml,
  proactivePanelScript,
  pruneVoiceDir,
  readPresence,
  recentUserTopics,
  resolvePerceptionPython,
  retentionPolicy,
  restoreProactiveSettings,
  segmentPlan,
  storeNoteText,
  type ProactiveConsoleState,
  type VoiceDeps,
  type VoiceTurnBody,
} from './field-test.ts';
// V0.3 P2.5-B: 试用页的工具链、插件内核、审批宿主、提醒与引擎都从装配点取（`createResidentRuntime`）；
// 本文件不再直接调 `buildToolChain`，也不再自己 new `ConversationEngine` / 建提取器。
import {
  CONVERSATION_SCOPE,
  createResidentRuntime,
  ingestPerceptionLine,
  type PluginChainOptions,
  type ResidentModelInput,
  type XixiResidentRuntime,
} from '@xixi/runtime';
import { toOffsetIso } from '@xixi/contracts';
// Pack Phase 8: the streaming speech pieces. Chunking itself lives in `handleVoiceTurn` (one
// `ClauseChunker` for every entry), so this file no longer imports the chunker at all — the
// clause text it sends to the page comes from the payload the sink produced.
import { AssentBank, XIXI_PLAYBACK_JS, XIXI_PLAYBACK_THRESHOLDS } from '../services/voice-edge/voice_edge/voice_stream.ts';
import { concatWav } from './lib/wav.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 && args[portArg + 1] !== undefined ? args[portArg + 1] : (process.env.XIXI_WEB_PORT ?? 8791));
const TTS_ENABLED = !args.includes('--no-tts');
// t78: 朗读 is a runtime switch here too, so the page can turn it off without a restart.
let ttsOn = TTS_ENABLED;
/** `--dsh` runs the same page through the DSH harness instead of the direct path (slower). */
const USE_DSH = args.includes('--dsh');
/**
 * `--fake` runs the page against the deterministic offline adapter: no key, no network, no cost.
 *
 * Added in t42 so the multi-segment / proactive behaviour can be *demonstrated and tested*
 * without spending a real call (the console tests drive this page end-to-end).
 */
const USE_FAKE = args.includes('--fake');
const PYTHON = resolvePython({ venvs: ['voice-pipecat'] });
const VOICE_DIR = join(REPO_ROOT, 'data', 'voice-web');

const config = loadConfig();
const client = new MimoClient();
/**
 * V0.3 P0-B: the trial page defaults to the household canonical store (`XIXI_DATA_DIR`, else
 * `data/xixi`) — the same one `npm run chat`, the console and the perception ingest use.
 * `XIXI_WEB_DATA_DIR` stays supported for tests/parallel instances, below the household switch.
 */
const DATA_DIR = resolveCanonicalDataDir({ legacyEnv: 'XIXI_WEB_DATA_DIR', cwd: REPO_ROOT });
const store = openXixiStore({ dataDir: DATA_DIR });
store.seedSelfProfile(config.personality.base);
const policy = retentionPolicy(config);
// Same privacy fix as the field-test console: apply the retention policy to any
// whole-recording files older versions left behind (audit finding, §20.1).
const pruned = pruneVoiceDir(VOICE_DIR, policy);
if (pruned.removed.length > 0) {
  console.log(`[privacy] 按保留策略清理 ${pruned.removed.length} 个音频文件（${Math.round(pruned.bytesFreed / 1024)} KB）：${pruned.removed.map((item) => item.name).join('、')}`);
}

function buildAdapter(registry: ToolRegistry): TurnModelProvider {
  // V0.3 P2.5-B: 这条链**不再由本入口拼**，它是常驻运行时（`createResidentRuntime`）给出的那一条
  // （`runtime.plugins.registry`）：内置工具、权限政策、轮数上限都在装配点里定，插件/MCP/news
  // 的工具也是在 `runtime.start()` 里挂进同一个注册表的。本函数只决定「哪一个模型」。
  if (USE_FAKE) return new FakeBrainAdapter({ registry, scope: CONVERSATION_SCOPE });
  if (!USE_DSH) {
    return new MimoBrainAdapter({
      client,
      maxCompletionTokens: 400,
      registry,
      scope: CONVERSATION_SCOPE,
      timezone: config.identity.timezone,
      // t21/t14: the reply-hygiene filter tells English reasoning from speech by judging it against the
      // deployment language. Omitting it is not a pass-through — the adapter falls back to `zh-CN`,
      // which would apply the Chinese rules to a deployment that may not speak Chinese — so the
      // configured language is passed explicitly (T5-F3).
      language: config.identity.language,
    });
  }
  return new DshBrainAdapter({
    transport: new CliDshTransport({
      dshHome: DSH_HOME,
      profile: DSH_PROFILE,
      cwd: REPO_ROOT,
      env: harnessEnv(),
      timeoutMs: 240_000,
      onDiagnostic: (line) => console.log(`[dsh] ${line}`),
    }),
    store,
  });
}

/** 这个页面的插件层接缝（V0.3 P2.5-B）：`inline` / `news` / `mcpServers` / `pluginDirectory`。 */
export interface TrialRuntimeOptions {
  /**
   * 插件链选项。入口自己**不给**——生产路径的插件来源是配置：`XixiConfig` 自 P2.5-H 起有 `plugins` 段
   * （`news` / `mcp` / `directories` / `enabled`），装配点的 `pluginChainOptions()` 按「配置声明了就由
   * 配置说了算、没声明才用这里给的」合并。所以这个接缝是**测试与「配置没声明时」的注入点**，
   * 不再是「生产路径就是没有插件」。
   */
  readonly plugins?: PluginChainOptions;
  /** 覆盖模型（默认按 `--fake` / `--dsh` / 直连 MiMo 决定；测试注入替身走这里）。 */
  readonly model?: ResidentModelInput;
}

/**
 * 试用页的常驻运行时（V0.3 P2.5-B）：**链 + 插件内核 + 审批宿主 + durable 提醒 + 引擎**一次装配。
 *
 * 为什么要有这个函数而不在模块顶层直接 `createResidentRuntime(...)`：入口自己的参数是进程级常量
 * （`--fake` / `--dsh` / 端口都在模块作用域读出来），测试要证明「启用插件之后这个入口仍然跑得完一轮
 * 文字对话」就得在**同一个装配函数**上多传一个插件。所以装配只有这一处，入口调它用默认参数，
 * 测试调它注入插件与替身模型——两者走的是同一条代码路径，不是两份。
 */
export function createTrialRuntime(options: TrialRuntimeOptions = {}): XixiResidentRuntime {
  return createResidentRuntime({
    config,
    store,
    ...(options.plugins ?? {}),
    onToolCall: (record) => console.log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`),
    log: (line) => console.log(line),
    // pack Phase 4：长期记忆与反馈学习。一轮说完之后**异步**提取（`afterTurn` 只入队，不 await），
    // 所以试用页的回复速度与「她要不要写记忆」无关；学习到的偏移通过 `store.selfProfile()` 影响提示词。
    // V0.3 P1-b/P2.5-B：这份装配（含 `createTurnExtraction` 的纠错闭环与 Tier 2 政策）现在只在装配点里，
    // 入口之间不会再各写一份。
    memory: { onError: (error: unknown) => console.log(`[memory] 后台提取出错（不影响这一轮）：${error instanceof Error ? error.message : String(error)}`) },
    conversation: { turnTimeoutMs: 90_000 },
    model: options.model ?? (({ toolChain }) => buildAdapter(toolChain)),
  });
}

/**
 * 本进程的常驻运行时：工具链、插件内核、审批宿主、提醒调度器、记忆提取与引擎都在它身上。
 * 插件工具是在 `start()` 里挂进链的，所以 `import.meta.main` 块在监听之前先 `await runtime.start()`。
 */
export const runtime: XixiResidentRuntime = createTrialRuntime();
const extractor = runtime.extraction.extractor;
const engine = runtime.conversation;

let session = store.latestSession() ?? store.createSession();

// ---------------------------------------------------------------- proactive card (t42)
// Same core as the field-test console (imported from `scripts/field-test.ts`), its own store
// (`data/web-chat`): tuning this page does not silently retune the console's dataset.
let proactiveSnapshot = restoreProactiveSettings(store, config.proactive as unknown as Record<string, unknown>);
/**
 * 话题引擎（pack Phase 3）：与现场测试控制台共用同一个实现，只是各自的库不同。
 *
 * 试用页也要能「第二天追问昨天说的事」，否则同一个机制在两个入口行为不一致 —— 用户会以为
 * 「这页不会惦记」。`config.open_threads` 段控制窗口与次数上限。
 */
const topicEngine = new TopicEngine({ store, config: config.openThreads, clock: () => new Date() });
/**
 * 面板状态：**只读**（pack v03-preflight ②，与现场测试控制台同一个修正）。
 *
 * 以前这里会 `topicEngine.reconcile(at)`：刷新一次页面就在写库（提取话题、收口、作废）。
 * 读接口不写库；对齐发生在写路径上（考虑循环的 tick、以及 `POST /api/proactive/drill`）。
 */
function proactivePayload(): ProactiveConsoleState & { readonly ok: true } {
  const at = new Date();
  return {
    ok: true,
    ...proactiveConsoleState({
      store,
      settings: proactiveSnapshot.settings,
      source: proactiveSnapshot.source,
      updatedAt: proactiveSnapshot.updatedAt,
      changes: proactiveSnapshot.changes,
      now: at,
      personality: store.selfProfile(),
      topicEngine,
    }),
  };
}

// Resident consideration loop (t70): same core as the console, off until the page asks for it.
let turnInFlight = false;
/**
 * 「一个西西」：在场投影用**本页自己的**库，不是仓库根的 `data/`。
 *
 * 这一行原本是 `join(REPO_ROOT, 'data')`，写在这里的时候没有后果——因为那时只有**读**
 * （考虑循环读一眼「有人在吗」）。摄像头接进来之后它开始**写**：再指着 `data/` 就会让画面看到的
 * 事与对话/人格分家，而且凭空多出一个 `data/xixi.sqlite`。现场测试控制台早就统一成这条规矩
 * （`presenceDataDir = options.presenceDataDir ?? dataDir`，注释写着「what the camera writes is
 * what the page reads」），这里跟着它走。
 */
const presenceStorePath = DATA_DIR;
const loopSynthesizeProvider = (): ((text: string) => Promise<Buffer>) | undefined =>
  ttsOn && client.hasKey ? async (text: string): Promise<Buffer> => await client.synthesize(text) : undefined;
const proactiveLoop = new ProactiveLoop({
  store,
  readSettings: () => proactiveSnapshot.settings,
  readState: () => engine.state,
  readInFlightTurn: () => turnInFlight,
  readProactivity: () => effectiveProactivity(store.selfProfile()),
  readPresence: async () => {
    const view = await readPresence({ store: openXixiStore({ dataDir: presenceStorePath }) });
    return view === null ? null : { present: view.present, updatedAt: view.updatedAt, source: view.source };
  },
  readLastUserTurnAt: () => lastUserTurnAt(store, session.sessionId),
  readRecentUserTopics: () => recentUserTopics(store, session.sessionId),
  // pack Phase 3：先对齐（提取 / 标记已说过 / 按回答收口），再取「现在该追问的」。
  readOpenThreads: () => {
    const at = new Date();
    topicEngine.reconcile(at);
    return topicEngine.followUps(at);
  },
  /**
   * V0.3 D1.1（把 P2.5-F 的接缝接进 live 入口）：到点的 durable 提醒。
   *
   * `...runtime.reminderSeams` 展开成**一对**：
   *   * `readDueReminders` —— 先跑到点（`markDue`，全库唯一比时钟的地方）再取候选，所以「到点」是循环
   *     自己判断出来的，而不是谁替它 tick 过一遍；
   *   * `onReminderDelivered` —— 说出口之后的记账（`candidate → delivered`）。
   * 只接一半的后果写在装配点 `XixiResidentRuntime.reminderSeams` 的文档里：只接读接缝时提醒会被反复
   * 提议却永远停在 `candidate`；只接送达接缝则循环永远读不到东西。
   *
   * 时钟：本入口的运行时与循环都用真实时钟（本文件没有注入 `now`），所以「到点」判定与候选读取看的是
   * 同一个时刻 —— 装配点的接口文档专门警告过「两处给不同时钟」这种隐形不一致。
   */
  ...runtime.reminderSeams,
  /**
   * V0.3 D1.2（把 P2.5-C 的能力桥接进 live 入口）：插件提案的话题。
   *
   * 参数是**这一 tick 的 `now`**（提案用它判断新鲜度，所以必须是评分用的那一刻）。插件只提供候选与依据：
   * 说不说仍由硬底线与既有评分决定（铁律 3）；插件候选也只在既有来源之后**追加**，挤不掉它们。
   */
  readPluginTopics: async (now) => (await runtime.capabilities.topics.propose({ now })).candidates,
  readSessionId: () => session.sessionId,
  replyLimits: config.reply,
  synthesizeProvider: loopSynthesizeProvider,
  /**
   * V0.3 P1-b（pack §6 §7）：读空气时也让它看到关系摘要与未完话题。
   *
   * 检索查询用**这一条候选自己的确定性依据**（`basis` 那几行：在场、沉默多久、话题池…）——
   * 主动开口没有「对方刚说的一句话」，`basis` 就是这一轮最接近事实的文本。
   * 没接线（`contextBuilder: false`）时返回 `null`，决策输入逐字不变。
   */
  readContext: (input) =>
    engine.buildProactiveDecisionContext({ fact: input.basis.join('；'), at: input.now }),
  // Same composer as the console: the model writes the line (tools included), from inside the
  // delivery seam only — the gates have already decided by then (t74).
  compose: createModelComposer({
    engine,
    sessionId: () => session.sessionId,
    available: !USE_FAKE && !USE_DSH && client.hasKey,
    recentLines: () => proactiveLoop.spokenLines(),
    log: (line) => console.log(line),
  }),
  log: (line) => console.log(line),
});

/** 本文件自己的日志行（和控制台一样，前缀只是习惯，方便 grep 现场）。 */
const logLine = (line: string): void => { console.log(line); };

// ---------------------------------------------------------------- 摄像头预览（复用控制台那份）
/**
 * The trial page shows the camera, and it does so through **the console's own sensor class** —
 * `LiveSensors` + `createPerceptionLiveRunner` are imported, not re-implemented (AGENTS §10.2:
 * one implementation per platform, or the second copy drifts).
 *
 * What that buys beyond a picture: the very same child process that feeds the `<img>` also
 * produces the `presence.changed` events, and they enter the canonical store through
 * `ingestPerceptionLine` — so 「画面里有人」 and WorldState can never disagree about what the
 * camera saw. The child gets no `--db` of its own (V0.3 P0-B).
 *
 * The presence store is opened once and reused: it used to be `openXixiStore(...)` per read.
 */
let presenceStore: XixiStore | null = null;
function getPresenceStore(): XixiStore | null {
  if (presenceStore !== null) return presenceStore;
  try {
    presenceStore = openXixiStore({ dataDir: presenceStorePath });
  } catch (error) {
    logLine(`[presence] 在场投影的库打不开：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  return presenceStore;
}
let cameraIndex = 0;
const liveSensors = new LiveSensors({
  runner: createPerceptionLiveRunner({
    python: () => resolvePerceptionPython(logLine),
    serviceDir: PERCEPTION_SERVICE_DIR,
    repoRoot: REPO_ROOT,
    log: logLine,
  }),
  ingest: (line) => {
    const target = getPresenceStore();
    if (target === undefined || target === null) {
      logLine('[perception] 在场投影的库打不开，这条在场事件没有入库');
      return;
    }
    ingestPerceptionLine(line, { store: target, log: logLine });
  },
  cameraIndex: () => cameraIndex,
  log: logLine,
});
function cameraPayload(): Record<string, unknown> {
  return {
    ok: true,
    status: liveSensors.status(),
    // t103: 「拿不到画面」 is its own fact, never 「房间没人」.
    problem: liveSensors.cameraProblem(),
    privacy: LIVE_PRIVACY_NOTE,
    hint: '画面只在内存里编码、经 localhost 进这个页面：不产生图像文件、不上传。在场事件照常写进本地库。',
  };
}

function loopPayload(cursor: number): Record<string, unknown> {
  const since = proactiveLoop.messagesSince(Number.isFinite(cursor) ? cursor : 0);
  return {
    ok: true,
    status: proactiveLoop.status(),
    cursor: since.cursor,
    entries: since.entries,
    minIntervalMs: MIN_LOOP_INTERVAL_MS,
    defaultIntervalMs: DEFAULT_LOOP_INTERVAL_MS,
    tts: {
      available: loopSynthesizeProvider() !== undefined,
      note:
        loopSynthesizeProvider() !== undefined
          ? '放行时会用真实 TTS 逐段合成，并在页面上逐条播出来。'
          : '当前没有可用密钥或朗读被关掉：放行时只显示文字，不会发声（这会在每条记录里写明）。',
    },
  };
}

interface TurnBody {
  readonly text?: string;
  readonly speak?: boolean;
  /** Base64 WAV captured by the browser (16-bit PCM). */
  readonly audioBase64?: string;
}

/**
 * The voice dependencies. A function, not a frozen object: `ttsEnabled` and the streaming sink are
 * read at call time, so flipping 朗读 on the page changes what the next turn does — and the page's
 * sentence about granularity is derived from the same source (t11).
 */
function voiceDeps(): VoiceDeps {
  const sink = streamingSpeechSink();
  return {
    python: PYTHON,
    voiceDir: VOICE_DIR,
    client,
    engine,
    currentSessionId: () => session.sessionId,
    ttsEnabled: ttsOn,
    policy,
    ...(sink === undefined ? {} : { speakStream: sink }),
    log: (line) => console.log(line),
  };
}

/**
 * Voice turn, delegated to the shared core in `scripts/field-test.ts`.
 *
 * Why not inline any more: this handler used to write the whole recording to
 * `data/voice-web/capture-*.wav` *before* the VAD (even when there was no speech,
 * and with no cleanup), and it silently kept only `segments[0]`. Both are fixed in
 * one place now, so this page and the field-test console cannot drift apart.
 */
async function handleVoice(body: TurnBody, response: ServerResponse): Promise<void> {
  const result = await handleVoiceTurn(voiceDeps(), body as VoiceTurnBody);
  // The voice path returns the same reply text; re-deriving the plan with the same pure
  // function the engine uses keeps the page's playback identical to a typed turn.
  const plan = segmentPlan(typeof result.reply === 'string' ? result.reply : null, config.reply);
  json(response, 200, { ...result, source: 'reply', sourceLabel: '回应你', segments: plan.segments, segmentGapMs: plan.gapMs, segmentSummary: plan.summary });
}

/* ======================================================================================
 * Pack Phase 8: streaming voice, backchannel, barge-in
 * ====================================================================================== */

/**
 * The short 「嗯」 clips, synthesized once and cached for the life of the process.
 *
 * Pre-generation is the point: a backchannel that has to be synthesized *inside* the father's
 * pause would arrive after he started talking again, which is worse than not saying it. The
 * bank is lazy (nothing is synthesized until the first pause needs a clip) but each clip costs
 * one TTS call ever, not one per interjection.
 */
const assentBank = new AssentBank((text) => client.synthesize(text));

/**
 * The streaming TTS sink for this entry: one clause in, that clause's WAV out.
 *
 * It is also *the* place this process synthesizes a reply. `streamVoice` used to synthesize each
 * clause a second time itself, so every clause cost two TTS calls — the reviewer's 「streamVoice
 * 走 sink」 finding. Now there is exactly one call per clause and the count is asserted in
 * `tests/console/voice-streaming-console.test.ts`.
 *
 * Returns `undefined` when nothing can be synthesized (no key, or 朗读 off): `handleVoiceTurn`
 * then reports `stream: null` and no audio, instead of pretending it spoke.
 */
function streamingSpeechSink(): VoiceDeps['speakStream'] {
  if (!ttsOn || !client.hasKey) return undefined;
  return async ({ text }) => Buffer.from(await client.synthesize(text));
}

/**
 * The NDJSON event mapping, as a **pure function** (t13).
 *
 * It exists so the wire format can be asserted without a server: given the incremental clauses the
 * sink produced and the finished payload, it yields the events to write. Two properties are
 * the whole point of the streaming voice path, and both are checked in
 * `tests/console/voice-streaming-console.test.ts`:
 *
 *   * one `clause` event **per clause**, in order, carrying that clause's audio verbatim;
 *   * the `turn` event carries **counts and timings only** — no base64 audio anywhere on it. A blob
 *     there would mean the browser received everything at once and could not start speaking before
 *     the reply ended.
 *
 * ## Exactly once: the two producers must not overlap (t20, B1 blocker)
 *
 * Clause events have **one writer pair**, and each clause belongs to exactly one half:
 *
 *   * `streamVoice`'s `onClause` hook writes every clause **the moment it is synthesized** — that is
 *     what makes the first clause reach the browser before the reply exists, and it is the only path
 *     that can do so. The number it has written is passed in as `sentClauses`;
 *   * this mapper then writes **the rest** — the clauses that never went through the hook. In the
 *     current wiring that is none of them, but the mapper stays correct on its own (it is called
 *     from tests and could be reused by a caller that only maps a finished turn), so it must never
 *     assume the hook ran.
 *
 * Before this, both halves wrote **all** clauses: the wire carried `[0,1,0,1]` for a two-clause reply
 * (measured through `/api/voice` in a real process, `end.clauses` = 2) and the trial page called
 * `xixiSpeakClause` twice per clause — every chunk of audio played twice, and the bytes doubled. The
 * route-level test now merges both channels and asserts each index appears exactly once.
 *
 * `synthesize` is injected purely so the test can assert the mapper never calls it: the audio is
 * produced once, by the sink, while the reply is being generated.
 */
export function voiceStreamEvents(input: {
  readonly result: Record<string, unknown>;
  readonly clauses: readonly VoiceClauseEvent[];
  readonly segments: readonly string[];
  readonly segmentGapMs: number;
  readonly ttsMode: 'streaming' | 'none';
  /** How many clauses the caller's `onClause` hook already wrote, in index order. `0` = none. */
  readonly sentClauses?: number;
  readonly synthesize?: (text: string) => unknown;
}): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const stitchedAudio: string[] = [];
  const ordered = [...input.clauses].sort((left, right) => left.index - right.index);
  const written = Math.max(0, Math.min(input.sentClauses ?? 0, ordered.length));
  ordered.forEach((clause, position) => {
    stitchedAudio.push(clause.audio);
    // Already on the wire via `onClause` — this mapper must not send it a second time.
    if (position < written) return;
    events.push({
      type: 'clause',
      index: clause.index,
      text: clause.text,
      audio: clause.audio,
      ttsMs: clause.synthMs,
      of: ordered.length,
    });
  });
  const stream = input.result['stream'] as { readonly enabled?: boolean; readonly ttsSegments?: number; readonly errors?: readonly string[] } | null | undefined;
  events.push({
    type: 'turn',
    // Counts and timings only: the reply's text lives in `reply` (one string, not one per clause),
    // and **no audio** of any kind is attached — not the clauses' and not the stitched blob. The
    // clause audio already went out on its own events, and the stitched one travels on `end`; a blob
    // here would mean the browser received everything at once and could not start speaking early.
    ...input.result,
    audio: null,
    clauseAudio: null,
    stream: stream === null || stream === undefined ? stream ?? null : {
      enabled: stream.enabled === true,
      ttsSegments: stream.ttsSegments ?? input.clauses.length,
      errors: stream.errors ?? [],
    },
    sourceLabel: '回应你',
  });
  events.push({
    type: 'end',
    segments: input.segments,
    segmentGapMs: input.segmentGapMs,
    clauses: input.clauses.length,
    ttsMode: input.ttsMode,
    // The same stitched WAV the single-object shape carries, for a caller that wants one blob.
    audio: stitchedAudio.length > 0 ? concatWav(stitchedAudio.map((item) => Buffer.from(item, 'base64')), 0).toString('base64') : null,
  });
  return events;
}

/** One clause on its way to the wire: the audio the sink produced, plus its timing. */
export interface VoiceClauseEvent {
  readonly index: number;
  readonly text: string;
  readonly audio: string;
  readonly durationMs: number;
  readonly synthMs: number | null;
}

/**
 * One voice turn, streamed. Writes newline-delimited JSON events as they happen — the reply's
 * first clause is on the wire before the rest of the reply exists, which is what the browser
 * needs in order to start speaking while she is still generating (pack Phase 8).
 *
 * The order is: each `clause` event the moment the sink finishes it, then `turn` (counts and
 * timings), then `end` (the segment plan and, for convenience, the stitched WAV). Chunking happens
 * inside `handleVoiceTurn` with the same `ClauseChunker` the offline pipeline uses, so the page and
 * the CLI cannot drift.
 */
async function streamVoice(body: TurnBody, response: ServerResponse): Promise<void> {
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Without this the browser buffers the whole body and the streaming buys nothing.
    'x-accel-buffering': 'no',
  });
  let open = true;
  const send = (event: Record<string, unknown>): void => {
    if (!open) return;
    try {
      response.write(`${JSON.stringify(event)}\n`);
    } catch {
      open = false; // the client hung up (page closed / reloaded)
    }
  };
  const sink = streamingSpeechSink();
  // Clauses are written as they are synthesized: `onClause` is awaited by the delivery chain, so a
  // slow socket back-pressures the hand-off instead of buffering the reply in memory.
  const clauses: VoiceClauseEvent[] = [];
  // How many `clause` events `onClause` has already put on the wire. Passed to the mapper so the two
  // writers partition the clauses instead of both sending all of them (t20, B1 blocker).
  let sentClauses = 0;
  try {
    const result = await handleVoiceTurn(
      {
        ...voiceDeps(),
        onClause: async (clause) => {
          const event: VoiceClauseEvent = { index: clause.index, text: clause.text, audio: clause.audio, durationMs: clause.durationMs, synthMs: clause.synthMs };
          clauses.push(event);
          // The only writer of this clause's event: `voiceStreamEvents` is told how many went out
          // here and skips them, so the wire carries each index exactly once (t20, B1).
          sentClauses += 1;
          send({ type: 'clause', index: event.index, text: event.text, audio: event.audio, ttsMs: event.synthMs, of: null });
        },
      },
      body as VoiceTurnBody,
    );
    const plan = segmentPlan(result.reply, config.reply);
    const events = voiceStreamEvents({
      result: result as unknown as Record<string, unknown>,
      clauses,
      segments: plan.segments,
      segmentGapMs: plan.gapMs,
      ttsMode: sink === undefined ? 'none' : 'streaming',
      sentClauses,
    });
    for (const event of events) send(event);
    console.log(
      `[voice] streaming ${result.action} vad=${result.vadMs}ms asr=${result.asrMs ?? '-'}ms first=${result.firstTokenMs ?? '-'}ms clauses=${clauses.length} (one TTS call each)`,
    );
  } catch (error) {
    const consoleError = error instanceof RuntimeError ? error : null;
    send({
      type: 'error',
      error: consoleError?.message ?? (error instanceof Error ? error.message : String(error)),
      code: consoleError?.code ?? 'VOICE_FAILED',
      hint: consoleError?.hint ?? '重试一次；仍然失败请刷新页面并看终端日志',
    });
  } finally {
    open = false;
    response.end();
  }
}

/** What the page needs to run the backchannel and to stop her the moment the father speaks. */
async function assentPayload(): Promise<Record<string, unknown>> {
  const clips: Record<string, string> = {};
  if (ttsOn) {
    for (const text of assentBank.clips) {
      const wav = await assentBank.get(text);
      if (wav !== null) clips[text] = Buffer.from(wav).toString('base64');
    }
  }
  return {
    available: Object.keys(clips).length > 0,
    clips,
    thresholds: XIXI_PLAYBACK_THRESHOLDS,
    note: Object.keys(clips).length
      ? '已经预生成，用在你说话的自然停顿处；它不会打断你，也不结束你的这一轮。'
      : '没有可用的 TTS（或朗读被关掉）：不会应和，只在你停下之后回答。',
  };
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

/**
 * One JPEG frame as raw bytes, for `<img src="/api/camera/frame.jpg">`.
 *
 * Deliberately not JSON+base64 like the console's `/api/field/live`: the browser decodes
 * `image/jpeg` natively, so base64 would inflate every frame by a third for no gain, and this
 * route keeps the JSON channel free for status. `no-store` matters — a cached frame would look
 * like a frozen picture rather than a stalled camera.
 */
function sendJpeg(response: ServerResponse, bytes: Buffer): void {
  response.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': bytes.length,
    'cache-control': 'no-store, no-cache, must-revalidate',
  });
  response.end(bytes);
}

/**
 * V0.3 D0.1/D0.2: 交互原型（`apps/demo-ui/`）的三个静态资源。
 *
 * 为什么不内联成模板字符串：`PAGE` 那种写法（1000+ 行 HTML/CSS/JS 挤在 TypeScript 里）正是这次要
 * 避免的东西——原型改一行 CSS 不该牵动 tsc 与测试。`/` 上的旧页面**逐字节保留**，仍是调试 fallback。
 *
 * 每次请求现读而不是启动时读一次：这是本地开发页，改完刷新即生效，不必重启服务；三个文件都很小。
 */
const DEMO_UI_DIR = join(REPO_ROOT, 'apps', 'demo-ui');
const DEMO_UI_TYPES: Readonly<Record<'index.html' | 'styles.css' | 'app.js', string>> = {
  'index.html': 'text/html; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
};

function sendDemoAsset(response: ServerResponse, file: 'index.html' | 'styles.css' | 'app.js'): void {
  let body: Buffer;
  try {
    body = readFileSync(join(DEMO_UI_DIR, file));
  } catch {
    // 500 而不是 404：这三个文件是仓库的一部分，读不到是部署/工作区坏了，不是「这个地址没有东西」。
    throw new RuntimeError(
      'DEMO_ASSET_MISSING',
      `原型资源读不到：${file}`,
      `它应该由仓库提供（${DEMO_UI_DIR}）；确认 apps/demo-ui/ 下的三个文件还在`,
      500,
    );
  }
  response.writeHead(200, {
    'content-type': DEMO_UI_TYPES[file],
    'content-length': body.length,
    // 本地开发页：不缓存，改完刷新就能看到最新的样式与脚本。
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** 收尾要用的几样东西（收窄成接口，测试可以直接驱动真收尾而不必起一个进程）。 */
export interface ShutdownDeps {
  readonly server: { close(): unknown; closeAllConnections?: () => void };
  readonly extractor: { flush(): Promise<void>; readonly pending: number };
  readonly store: { close(): void };
  /**
   * V0.3 P2.5-B：本页的常驻运行时（`createResidentRuntime` 的返回值）。给了它就多走一步
   * `stop()`，而且**必须在 `store.close()` 之前**：
   *
   *  * 插件层走完关停（九步生命周期收尾、MCP 连接在这里断开）→ 撤回 `mount()` 复制进链的副本 →
   *    清空前链；
   *  * `stop()` 的第一步本来就是 `extraction.drain()`，也就是上面那次 `flush()` 的完整形态；
   *  * 关停报告（还有几条提醒、几条待批）要读得到库，所以顺序不能反。
   *
   * 不给它的调用方（测试里的窄替身）只走原来的三步，行为不变。
   */
  readonly resident?: { stop(): Promise<unknown> } | undefined;
  readonly log?: (line: string) => void;
}

/** 收尾结果：跑掉了多少轮排队的后台提取。 */
export interface ShutdownReport {
  readonly flushed: number;
}

/**
 * 退出前的收尾（pack v03-preflight ⑦）：「回复之后还有活没跑」的那部分必须跑完再走。
 *
 * 为什么必须有它：`afterTurn` 只把提取**入队**（`setTimeout(run, 0)`，而且是 `unref` 过的宏任务），
 * 所以「说完最后一句 → 按 Ctrl+C」这一瞬间队列里通常还有一轮。进程默认的 SIGINT 行为是直接终止，
 * `extractor` 的 `exit` 兜底**不一定来得及**，而且库也不是正常关闭的 —— 记忆会少一条，日志里什么也看不出来。
 *
 * 顺序就是它写在代码里的理由：先停止接受新连接（不再有新轮次入队），再跑完队列，再让常驻运行时
 * 停下来（插件层），最后关库。`closeAllConnections` 是给浏览器 keep-alive 用的：不关掉它，
 * `server.close()` 会等长连接自己结束，于是「Ctrl+C 之后还挂在那里」。
 */
export async function shutdownAll(deps: ShutdownDeps): Promise<ShutdownReport> {
  const log = deps.log ?? ((line: string): void => console.log(line));
  const flushed = deps.extractor.pending;
  deps.server.close();
  deps.server.closeAllConnections?.();
  await deps.extractor.flush();
  await deps.resident?.stop();
  deps.store.close();
  log(`[shutdown] 已停止接受新请求，跑掉 ${flushed} 轮排队的后台提取${deps.resident === undefined ? '' : '，插件层已关停'}，库已正常关闭`);
  return { flushed };
}

/**
 * 把收尾接到进程信号上：SIGINT（Ctrl+C）与 SIGTERM（`kill` / 任务管理器结束进程）走同一条路。
 *
 * 只挂一次（`once`）并用一个开关挡住第二条信号：收尾途中再来一条不许把库关两遍。
 * `exit` 可注入，于是这条接线可以在测试里被**真触发**（`process.emit('SIGTERM')`）而不结束测试进程；
 * 生产默认就是 `process.exit`。
 */
export function installShutdownHandlers(deps: ShutdownDeps & { readonly exit?: (code: number) => void }): {
  shutdown: (signal: string) => Promise<void>;
  dispose: () => void;
} {
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const log = deps.log ?? ((line: string): void => console.log(line));
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n收到 ${signal}：先跑完排队的后台提取再退出…`);
    try {
      await shutdownAll({
        server: deps.server,
        extractor: deps.extractor,
        store: deps.store,
        ...(deps.resident === undefined ? {} : { resident: deps.resident }),
        log,
      });
      exit(0);
    } catch (error) {
      log(`[shutdown] 收尾失败：${error instanceof Error ? error.message : String(error)}`);
      exit(1);
    }
  };
  const onSigint = (): void => void shutdown('SIGINT');
  const onSigterm = (): void => void shutdown('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return {
    shutdown,
    dispose: () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    },
  };
}

async function readBody(request: IncomingMessage): Promise<TurnBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as TurnBody;
  } catch {
    return {};
  }
}

async function handleTurn(body: TurnBody, response: ServerResponse): Promise<void> {
  const text = (body.text ?? '').trim();
  if (text.length === 0) throw new RuntimeError('EMPTY_MESSAGE', '没有输入文字', '在输入框里打一句话再按发送');
  // IDLE 时把这一次点击当作直呼（M2 之前用按钮代替唤醒词），会话开着就按继续处理。
  const addressed = engine.state === 'IDLE';
  // t21 (t12 F2): the engine's notices are the only way to see *why* a turn said nothing —
  // 「标记/推理被剔干净」 and 「模型自己决定不说」 used to look identical here.
  const notices: { readonly code: string; readonly detail: string }[] = [];
  const turn = await engine.respond(
    { sessionId: session.sessionId, text, addressed },
    { onNotice: (notice) => void notices.push({ code: notice.code, detail: notice.detail }) },
  );

  let audio: string | null = null;
  if (ttsOn && body.speak !== false && turn.action === 'SPEAK' && turn.text !== null) {
    audio = (await client.synthesize(turn.text)).toString('base64');
  }
  // `segments`/`segmentGapMs` are the engine's own plan (ADR-0010): the page plays them one by
  // one with that pause instead of dropping a wall of text, and labels the source as 回应你.
  const plan = segmentPlan(turn.text, config.reply);
  json(response, 200, {
    reply: turn.text,
    action: turn.action,
    accepted: turn.accepted,
    reason: turn.reason,
    state: turn.state,
    latencyMs: turn.latencyMs,
    firstTokenMs: turn.firstTokenMs,
    model: turn.model,
    // t21: why it was silent (ARTIFACT_ONLY_REPLY vs MODEL_SILENCE), what was removed, and whether
    // the provider cut the reply short (`finish_reason=length`).
    silenceReason: turn.silenceReason,
    silenceReasonLabel: silenceReasonLabel(turn.silenceReason),
    hygiene: turn.hygiene,
    finishReason: turn.finishReason,
    toolName: turn.toolName,
    notices,
    audio,
    at: toOffsetIso(),
    source: 'reply',
    sourceLabel: '回应你',
    segments: turn.segments.length > 0 ? turn.segments : plan.segments,
    segmentGapMs: turn.segments.length > 0 ? turn.segmentGapMs : plan.gapMs,
    segmentSummary: plan.summary,
  });
}

/**
 * t21: the sentence a person can read when a turn said nothing.
 *
 * The two cases are not the same thing and the page must not pretend they are: one is the model's
 * choice, the other is the hygiene gate having removed the whole reply (t12 F2).
 */
export function silenceReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'ARTIFACT_ONLY_REPLY':
      return '整轮只剩工具标记/英文推理这类不能念出来的内容，已经剔除干净，所以这轮什么都没说';
    case 'MODEL_SILENCE':
      return '模型自己选择不说话（沉默是一等结果，不是失败）';
    default:
      return '';
  }
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE);
        return;
      }
      // V0.3 D0.1/D0.2: 交互原型（`apps/demo-ui/`）走这三条静态路由。`/demo/` 才是正式地址（末尾
      // 带斜杠，页面里的 `./styles.css` 才会解析到 `/demo/styles.css`）；`/demo?mode=live` 这种少一个
      // 斜杠的写法重定向过去，并且**保留查询串**——`mode=live` 在重定向里丢掉的话，页面会静默退回模拟模式。
      if (request.method === 'GET' && url.pathname === '/demo') {
        response.writeHead(302, { location: `/demo/${url.search}` });
        response.end();
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/demo/' || url.pathname === '/demo/index.html')) {
        sendDemoAsset(response, 'index.html');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/demo/styles.css') {
        sendDemoAsset(response, 'styles.css');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/demo/app.js') {
        sendDemoAsset(response, 'app.js');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const recent = store.recentTurns(session.sessionId, 20).map((turn) => ({
          role: turn.role,
          text: turn.text,
          action: turn.action,
          toolName: turn.toolName,
        }));
        json(response, 200, {
          sessionId: session.sessionId,
          turnCount: store.getSession(session.sessionId).turnCount,
          state: engine.state,
          personality: store.selfProfile(),
          identity: config.identity,
          adapter: engine.adapter.describe(),
          recent,
          // Which SQLite file this page writes to (t42 acceptance item 3). V0.3 P0-B: the note is
          // derived from `CANONICAL_STORE_ENTRIES` — the entries share one canonical store now, and
          // the sentence has to say what the code does instead of freezing yesterday's design.
          database: { path: DATA_DIR, entries: XIXI_DB_ENTRIES, note: storeNoteText() },
          segmentPlayback: (() => {
            // Derived from the wiring (`streamVoice` → `AssentBank`/`client.synthesize`), so the
            // page's sentence changes with the runtime 朗读 switch and with a missing key
            // instead of freezing one version of the truth.
            const mode: 'streaming' | 'whole-reply' | 'none' = !ttsOn ? 'none' : client.hasKey ? 'streaming' : 'none';
            return { textSegmented: true, ttsSegmented: mode === 'streaming', mode, note: segmentTtsNote(mode) };
          })(),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/turn') {
        await handleTurn(await readBody(request), response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/voice') {
        // Pack Phase 8: the trial page gets the streaming path (clause by clause, first clause
        // played while the rest is generated). `?single=1` keeps the old whole-reply shape for
        // a caller that wants one JSON object — the field-test console still does.
        const body = await readBody(request);
        if (url.searchParams.get('single') === '1') await handleVoice(body, response);
        else await streamVoice(body, response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/voice/assent') {
        json(response, 200, await assentPayload());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/quiet') {
        const body = await readBody(request);
        if (body.text === 'resume') engine.resume();
        else engine.quiet();
        json(response, 200, { state: engine.state });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/session') {
        session = store.createSession();
        engine.resume();
        json(response, 200, { sessionId: session.sessionId });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/camera') {
        json(response, 200, cameraPayload());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/camera/frame.jpg') {
        const frame = liveSensors.frame();
        const prefix = 'data:image/jpeg;base64,';
        if (frame === null || !frame.dataUrl.startsWith(prefix)) {
          // 204, not an error page: 「还没有画面」 is a normal state of a loop that just started,
          // and the page keeps showing the last frame it already has.
          response.writeHead(204, { 'cache-control': 'no-store' });
          response.end();
          return;
        }
        sendJpeg(response, Buffer.from(frame.dataUrl.slice(prefix.length), 'base64'));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/camera') {
        const body = (await readBody(request)) as Record<string, unknown>;
        const action = typeof body['action'] === 'string' ? body['action'] : 'start';
        if (typeof body['cameraIndex'] === 'number') cameraIndex = body['cameraIndex'];
        if (action === 'start') {
          // Open (and migrate) the presence store *before* the child starts writing: the child
          // has no database of its own any more (V0.3 P0-B).
          getPresenceStore();
          liveSensors.start({ source: 'camera' });
          logLine(`[camera] 预览已启动（pid ${liveSensors.status().child.pid ?? '?'}）：画面只进这个页面，在场事件照常入库`);
        } else if (action === 'stop') {
          liveSensors.stop();
          logLine('[camera] 预览已停止（子进程退出，摄像头释放）');
        } else {
          throw new RuntimeError('UNKNOWN_CAMERA_ACTION', `不认识的摄像头操作「${action}」`, '可用：start（打开预览）、stop（关掉预览）');
        }
        json(response, 200, cameraPayload());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/proactive') {
        json(response, 200, proactivePayload());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/proactive/loop') {
        json(response, 200, loopPayload(Number(url.searchParams.get('cursor') ?? '0')));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/tts') {
        // t78: the trial page gets the same runtime 朗读 switch as the console.
        const body = (await readBody(request)) as Record<string, unknown>;
        if (typeof body['enabled'] !== 'boolean') {
          throw new RuntimeError('TTS_SWITCH_INVALID', 'TTS 开关需要一个布尔值', '页面上的复选框会传 true / false');
        }
        ttsOn = body['enabled'];
        console.log(`[tts] 朗读已${ttsOn ? '打开' : '关闭'}（回复与主动开口都生效）`);
        json(response, 200, { ok: true, ttsEnabled: ttsOn, ttsAvailable: loopSynthesizeProvider() !== undefined });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/proactive/loop') {
        const body = (await readBody(request)) as Record<string, unknown>;
        const action = typeof body['action'] === 'string' ? body['action'] : 'tick';
        if (action === 'start') proactiveLoop.start(typeof body['intervalMs'] === 'number' ? body['intervalMs'] : undefined);
        else if (action === 'stop') proactiveLoop.stop();
        else if (action === 'tick') await proactiveLoop.tickOnce();
        else throw new RuntimeError('UNKNOWN_LOOP_ACTION', `不认识的循环操作「${action}」`, '可用：start（开始自动考虑）、stop（停止）、tick（立刻考虑一次）');
        json(response, 200, loopPayload(Number(body['cursor'] ?? 0)));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/proactive/settings') {
        const body = (await readBody(request)) as Record<string, unknown>;
        // Shared with the field-test console (t63): engine settings + the personality write
        // (proactivity → self_profile) + one audit row, in that order.
        const applied = applyAndPersistProactivePatch({
          store,
          settings: proactiveSnapshot.settings,
          patch: body,
          personalityBefore: store.selfProfile(),
          log: (line) => console.log(line),
        });
        if (applied.changes.length > 0) {
          proactiveSnapshot = { settings: applied.settings, source: 'console', updatedAt: applied.auditAt ?? proactiveSnapshot.updatedAt, changes: applied.changes };
        }
        json(response, 200, {
          ok: true,
          changes: applied.changes,
          rejected: applied.rejected,
          personality: applied.personality,
          auditSequence: applied.auditSequence,
          state: proactivePayload(),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/proactive/drill') {
        const body = (await readBody(request)) as Record<string, unknown>;
        const drill = await proactiveDrill({
          store,
          settings: proactiveSnapshot.settings,
          now: new Date(),
          conversationState: engine.state,
          inFlightTurn: false,
          proactivity: effectiveProactivity(store.selfProfile()),
          sessionId: session.sessionId,
          replyLimits: config.reply,
          synthesize: loopSynthesizeProvider(),
          request: body,
        });
        console.log(`[proactive] 演练 ${drill.trigger} → ${drill.reasonCode}（分数 ${drill.score}/${drill.threshold}${drill.speak ? `，分 ${drill.segments.length} 段` : ''}）`);
        // 写路径可以对齐（读接口不行，见 `proactivePayload`）：演练可能真的说出口，话题要跟着日志走。
        topicEngine.reconcile(new Date());
        json(response, 200, { ok: true, drill, state: proactivePayload() });
        return;
      }
      json(response, 404, { error: 'not found' });
    } catch (error) {
      // Readable Chinese errors, never a blank page or a raw stack (§20 audit item).
      if (error instanceof RuntimeError) {
        json(response, error.status, { ok: false, error: error.message, hint: error.hint, code: error.code });
        return;
      }
      console.error(`[error] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      const message = error instanceof Error ? error.message : String(error);
      const missingKey = /MISSING_KEY|api.?key is not set/i.test(message);
      json(response, missingKey ? 503 : 500, {
        ok: false,
        error: missingKey ? '缺少 MIMO_API_KEY：模型调用用不了' : `服务端出错了：${message}`,
        hint: missingKey
          ? '把 .env.example 复制成 .env 并填入 MIMO_API_KEY，然后重启；没有密钥时可用 npm run chat -- --fake 或 npm run field-test -- --offline'
          : '页面不会白屏；完整堆栈在这个终端里，请发给维护者。想用「一条命令」的现场测试控制台：npm run field-test',
      });
    }
  })();
});

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>和西西说话</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font-family: system-ui, "Microsoft YaHei", sans-serif; background:#0f1115; color:#e8e8ea; }
  header { padding:14px 18px; border-bottom:1px solid #262a33; display:flex; gap:12px; align-items:center; flex-wrap:wrap; font-size:13px; color:#9aa3b2; }
  header b { color:#e8e8ea; font-size:15px; }
  #log { padding:16px; display:flex; flex-direction:column; gap:10px; max-width:820px; margin:0 auto; }
  .row { display:flex; }
  .row.user { justify-content:flex-end; }
  .bubble { max-width:78%; padding:10px 13px; border-radius:14px; line-height:1.55; white-space:pre-wrap; }
  .user .bubble { background:#2b6cb0; color:#fff; border-bottom-right-radius:4px; }
  .xixi .bubble { background:#1c2028; border:1px solid #2a2f3a; border-bottom-left-radius:4px; }
  .silent .bubble { background:transparent; border:1px dashed #3a4150; color:#8b93a3; font-style:italic; }
  .meta { font-size:11px; color:#7c869a; margin-top:5px; }
  footer { position:sticky; bottom:0; background:#0f1115; border-top:1px solid #262a33; padding:12px; }
  form { max-width:820px; margin:0 auto; display:flex; gap:8px; }
  input[type=text] { flex:1; padding:12px 14px; border-radius:12px; border:1px solid #2a2f3a; background:#161a21; color:#e8e8ea; font-size:15px; }
  button { padding:12px 16px; border-radius:12px; border:1px solid #2a2f3a; background:#1c2028; color:#e8e8ea; font-size:14px; cursor:pointer; }
  button.primary { background:#2b6cb0; border-color:#2b6cb0; color:#fff; }
  label { font-size:12px; color:#9aa3b2; display:flex; align-items:center; gap:6px; }
  .hint { max-width:820px; margin:8px auto 0; font-size:12px; color:#7c869a; }
  .badge { font-size:11px; color:#9aa3b2; margin-bottom:4px; }
  .badge.reply { color:#8fb8ff; }
  .badge.proactive { color:#ffd479; }
  .seg { font-size:11px; color:#7c869a; margin-top:3px; }
  .card { max-width:820px; margin:14px auto; padding:12px 14px; border:1px solid #262a33; border-radius:12px; background:#13161c; }
  .card h2 { font-size:15px; margin:0 0 8px; }
  .card h3 { color:#c8cfdb; font-weight:600; }
  .card input[type=number], .card input[type=text] { padding:6px 8px; border-radius:8px; border:1px solid #2a2f3a; background:#161a21; color:#e8e8ea; font-size:13px; }
  .card button { padding:8px 12px; font-size:13px; }
  .muted { color:#7c869a; font-size:12px; }
${PROACTIVE_PANEL_CSS}
</style></head>
<body>
<header>
  <b>西西</b>
  <span id="banner">加载中…</span>
  <span style="flex:1"></span>
  <label><input type="checkbox" id="speak" checked /> 朗读回复</label>
  <button id="quiet">今天安静点</button>
  <button id="new">新会话</button>
</header>
<div id="log"></div>
<section class="card" id="cam-card">
  <h2 style="font-size:15px;margin:0 0 8px">摄像头</h2>
  <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
    <div>
      <img id="cam-img" alt="摄像头画面" style="width:320px;max-width:100%;border-radius:10px;border:1px solid #2a2f3a;background:#0b0d11;display:block" />
      <div class="muted" id="cam-state" style="margin-top:6px">未启用。</div>
    </div>
    <div style="flex:1;min-width:240px">
      <div style="margin-bottom:8px">
        <button id="cam-toggle" class="primary">打开摄像头</button>
        <span class="muted" id="cam-frames"></span>
      </div>
      <div class="muted" id="cam-problem" style="display:none;border:1px solid #7a3030;background:#2a1414;color:#ffb4b4;border-radius:10px;padding:8px 10px"></div>
      <div class="muted">${LIVE_PRIVACY_NOTE}</div>
    </div>
  </div>
</section>
<div class="card">${databaseNoteHtml(DATA_DIR)}</div>
<div class="card" style="border-color:#5c4a22; background:#2a2314; color:#ffe6b8">${segmentTtsNote(!ttsOn ? 'none' : client.hasKey ? 'streaming' : 'none')}</div>
${proactivePanelHtml()}
<footer>
  <form id="form">
    <input type="text" id="input" placeholder="直接打字，或按住右边的麦克风说话" autocomplete="off" />
    <button class="primary" type="submit">发送</button>
    <button type="button" id="mic" title="按住说话，松开结束">🎤 按住说</button>
  </form>
  <div class="hint" id="hint">打字或按麦克风说话（第一句视为叫醒西西）。语音只把 VAD 检出的语音段送去识别，整段录音不落盘；回复由浏览器播放。</div>
</footer>
<script>
${proactivePanelScript('/api')}
${XIXI_PLAYBACK_JS}
// Pack Phase 8: the pre-generated 「嗯」 clips + the barge-in thresholds the server enforces.
let assent = { available: false, clips: {}, thresholds: null };
fetch('/api/voice/assent')
  .then((response) => response.json())
  .then((data) => { assent = data; })
  .catch(() => {});
const log = document.getElementById('log');
const banner = document.getElementById('banner');
const input = document.getElementById('input');
const speakBox = document.getElementById('speak');
const form = document.getElementById('form');
const micButton = document.getElementById('mic');
const hint = document.getElementById('hint');

function setBanner(state) {
  banner.textContent = '会话 ' + state.sessionId.slice(5, 13) + ' · ' + state.turnCount + ' 轮 · ' + state.state
    + ' · ' + (state.adapter ? state.adapter.provider : '?')
    + ' · 地点 ' + (state.identity.place ?? '未设置')
    + (state.database ? ' · 库 ' + state.database.path : '');
}

/** Float32 samples → 16-bit PCM WAV (mono). */
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeText(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

let recorder = null;
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (event) => {
    const frame = new Float32Array(event.inputBuffer.getChannelData(0));
    chunks.push(frame);
    // Pack Phase 8, two jobs on one frame stream:
    //   ① barge-in — while SHE is talking, 150 ms of voiced frames stop her playback and drop
    //      the un-played queue;
    //   ② backchannel — while the user is talking, a 250 ms quiet stretch is a natural pause
    //      and gets one pre-generated 「嗯」. Neither ends the user's turn: the recorder keeps
    //      sampling while the button is held, whatever is said over her voice.
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / (frame.length || 1));
    if (xixiWatchBargeIn(rms)) { hint.textContent = '听到你说话了，已经停下（未播的部分丢掉）'; return; }
    if (rms > XIXI_PLAYBACK_THRESHOLDS.voiceRms) {
      recorder.voicedMs += 20;
      recorder.pauseMs = 0;
      recorder.voicedSincePauseMs += 20;
    } else {
      recorder.pauseMs += 20;
      if (xixiOnUserPause(recorder.pauseMs) && assent.available && recorder.voicedMs >= 1200) {
        const texts = Object.keys(assent.clips);
        const clip = assent.clips[texts[recorder.assents % texts.length]];
        if (clip) xixiPlayClip(clip);
      }
    }
  };
  source.connect(processor);
  processor.connect(context.destination);
  recorder = { stream, context, source, processor, chunks, sampleRate: context.sampleRate, startedAt: Date.now(), voicedMs: 0, pauseMs: 0, backchannels: 0, voicedSincePauseMs: 0 };
  micButton.textContent = '⏺ 松开发送';
  hint.textContent = '正在录音…（松开按钮结束）';
}

/**
 * The streaming consumer: reads the newline-delimited events and plays each clause the moment
 * its audio arrives. xixiSpeakClause resolves when the clause has started, so the
 * 「首段可听」 time is what the browser actually heard, not what the server finished sending.
 */
async function readVoiceStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const clauseTimings = [];
  let turn = null;
  let end = null;
  let failure = null;
  const handle = async (event) => {
    if (event.type === 'error') { failure = event; return; }
    if (event.type === 'turn') { turn = event; return; }
    if (event.type === 'clause') {
      clauseTimings.push({ index: event.index, ttsMs: event.ttsMs, text: event.text });
      // Play it NOW — while the engine is still generating the rest of the reply. This is the
      // behaviour Phase 8 exists for: waiting for the end event would put 「首音」 back on the
      // length of the whole reply.
      if (event.audio) await xixiSpeakClause(event.audio);
      return;
    }
    if (event.type === 'end') end = event;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) await handle(JSON.parse(line));
      newline = buffer.indexOf('\\n');
    }
  }
  return { turn, end, failure, clauseTimings };
}

/**
 * Attach a replayable player to a message (user request, 2026-10-08: 「我录的音要能播，西西说的
 * 也要能重复播，方便我检查」).
 *
 * The bytes are already in this page — the browser's own recording for 「你」, and the stitched WAV
 * the server sends on the end event for her reply — so this is a blob URL, no extra round trip.
 * Native audio controls on purpose: 播放 / 暂停 / 拖回去重听 all come for free, which is what
 * 「重复播放」 actually needs; a custom button would have to re-implement seeking.
 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function attachAudio(bubble, base64, label, fileName) {
  if (!bubble || !base64) return null;
  const url = URL.createObjectURL(new Blob([base64ToBytes(base64)], { type: 'audio/wav' }));
  const row = document.createElement('div');
  row.style.marginTop = '6px';
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = url;
  audio.style.height = '30px';
  audio.style.maxWidth = '100%';
  row.appendChild(audio);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.textContent = '⬇ 存到本地';
  link.style.marginLeft = '8px';
  link.style.fontSize = '12px';
  link.style.color = '#8fb8ff';
  row.appendChild(link);
  const tag = document.createElement('div');
  tag.className = 'seg';
  tag.textContent = label;
  row.appendChild(tag);
  bubble.parentElement.appendChild(row);
  return audio;
}

async function stopRecording() {
  if (!recorder) return;
  const current = recorder;
  recorder = null;
  micButton.textContent = '🎤 按住说';
  current.processor.disconnect();
  current.source.disconnect();
  current.stream.getTracks().forEach((track) => track.stop());
  await current.context.close();

  const total = current.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const seconds = total / current.sampleRate;
  if (seconds < 0.3) { hint.textContent = '太短了，按住多说一会儿。'; return; }

  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of current.chunks) { merged.set(chunk, offset); offset += chunk.length; }
  // Encoded once: the same bytes go to /api/voice and become the 「你的录音」 player below.
  const userWavBase64 = toBase64(encodeWav(merged, current.sampleRate));

  hint.textContent = '录音 ' + seconds.toFixed(1) + 's，正在识别…';
  const pending = add('xixi', '…');
  try {
    const response = await fetch('/api/voice', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: userWavBase64, speak: speakBox.checked }),
    });
    const { turn: raw, end, failure, clauseTimings } = await readVoiceStream(response);
    pending.parentElement.remove();
    if (failure) {
      add('xixi', '语音没成功：' + failure.error, failure.hint ?? '');
      hint.textContent = '语音没成功：' + failure.error + (failure.hint ? '（' + failure.hint + '）' : '');
      return;
    }
    const data = raw ?? {};
    if (data.ok === false) {
      add('xixi', '语音没成功：' + data.error, data.hint ?? '');
      hint.textContent = '语音没成功：' + data.error + (data.hint ? '（' + data.hint + '）' : '');
      return;
    }
    if (data.reason === 'NO_SPEECH_DETECTED') {
      add('xixi silent', '（没有听清：麦克风里没检测到语音）', data.notes ? data.notes[data.notes.length - 1] : '');
      attachAudio(add('user', '（这次录到的声音）'), userWavBase64, '你刚录的 ' + seconds.toFixed(1) + 's（麦克风里没有语音，放出来听听是什么）', 'my-voice.wav');
    } else if (data.reason === 'ASSENT_ONLY') {
      // Pack Phase 8: a nod is not a turn. Before this branch the page said 「这句不是对西西说的」
      // — the wording of a *rejected* turn — for the one case where she is listening on purpose.
      if (data.transcript) attachAudio(add('user', data.transcript), userWavBase64, '你的录音 · ' + seconds.toFixed(1) + 's（可重复播放）', 'my-voice.wav');
      const ackMeta = (data.actionText ?? data.action) + ' · ' + (data.reasonText ?? data.reason) + ' · ' + data.state;
      add('xixi silent', '（应和：这一轮不算，西西继续听着）', ackMeta);
      hint.textContent = data.privacy ? data.privacy.note : '应和不算一轮：想让她回话就说一句完整的话。';
    } else {
      if (data.transcript) attachAudio(add('user', data.transcript), userWavBase64, '你的录音 · ' + seconds.toFixed(1) + 's（可重复播放）', 'my-voice.wav');
      else attachAudio(add('user', '（这次录到的声音）'), userWavBase64, '你刚录的 ' + seconds.toFixed(1) + 's', 'my-voice.wav');
      const stages = data.stages ?? {};
      const firstClause = clauseTimings.length > 0 ? clauseTimings[0].ttsMs : null;
      const meta = (data.actionText ?? data.action) + ' · ' + (data.reasonText ?? data.reason)
        + ' · VAD ' + Math.round(stages.vadMs ?? 0) + 'ms · ASR ' + Math.round(stages.asrMs ?? 0) + 'ms'
        + ' · 首字 ' + (stages.llmFirstChunkMs == null ? '—' : Math.round(stages.llmFirstChunkMs) + 'ms')
        + ' · 首段音频 ' + (firstClause == null ? '—' : Math.round(firstClause) + 'ms')
        + ' · ' + clauseTimings.length + ' 块'
        + ' · 总 ' + Math.round(stages.totalMs ?? data.totalMs ?? 0) + 'ms'
        + ' · 语音段 ' + data.segmentsUsed + '/' + data.segmentsTotal + (data.droppedSegments && data.droppedSegments.length ? '（丢弃' + data.droppedSegments.length + '段）' : '')
        + ' · ' + data.state;
      const plan = end ? { segments: end.segments, gapMs: end.segmentGapMs } : { segments: [data.reply], gapMs: 450 };
      if (data.action === 'SILENCE' || data.accepted === false) add('xixi silent', data.accepted === false ? '（这句不是对西西说的）' : '（西西选择沉默）', meta);
      else {
        const firstBubble = addSegmented('xixi', data.sourceLabel ?? '回应你', plan.segments, plan.gapMs, meta);
        // The stitched WAV of the whole reply, so 「再听一遍」 does not mean replaying 3 段 by hand.
        attachAudio(firstBubble, end ? end.audio : null, '西西这段话的录音（可重复播放）', 'xixi-reply.wav');
      }
      if (data.privacy) hint.textContent = data.privacy.note;
    }
    setBanner(await (await fetch('/api/state')).json());
    hint.textContent = '说完松开即发送。你的录音和她的回复都带播放器，可以反复听——两者都只留在本页内存里（要留档就点「⬇ 存到本地」）。';
  } catch (error) {
    pending.parentElement.remove();
    add('xixi', '语音出错：' + error.message);
    hint.textContent = '语音出错：' + error.message;
  }
}

micButton.addEventListener('pointerdown', async (event) => {
  event.preventDefault();
  try { await startRecording(); } catch (error) { hint.textContent = '无法访问麦克风：' + error.message; }
});
micButton.addEventListener('pointerup', (event) => { event.preventDefault(); stopRecording(); });
micButton.addEventListener('pointerleave', () => { if (recorder) stopRecording(); });

function add(role, text, meta, source) {
  const row = document.createElement('div');
  row.className = 'row ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  const wrap = document.createElement('div');
  wrap.appendChild(bubble);
  if (meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; wrap.appendChild(m); }
  row.appendChild(wrap);
  log.appendChild(row);
  window.scrollTo(0, document.body.scrollHeight);
  return bubble;
}

/**
 * Say a reply the way the engine says it: one segment at a time, gapMs apart (ADR-0010).
 *
 * The first segment replaces the "…" placeholder; each later one is appended after the real
 * pause, and every bubble carries 「第 i/N 段 · 间隔 xms」 so a user watching the screen can
 * tell "还有一段没到" from "只回了一句".
 */
/**
 * A spoken proactive message also belongs in the conversation log (t70): the shared panel
 * calls this hook when the resident loop actually says something, so the page shows
 * 「主动开口」 in the same stream as replies — with the same per-segment playback.
 */
window.pxOnProactiveMessage = function (entry) {
  if (!entry || entry.speak !== true) return;
  addSegmented('xixi', '主动开口', entry.segments, entry.gapMs, '触发源 ' + entry.trigger + ' · 分数 ' + entry.score + '/' + entry.threshold);
};

function addSegmented(role, label, segments, gapMs, meta) {  const list = Array.isArray(segments) && segments.length > 0 ? segments : [''];
  const badgeText = label ? label + ' · 第 1/' + list.length + ' 段' : null;
  const first = add(role, list[0], null);
  const wrap = first.parentElement;
  if (badgeText) {
    const badge = document.createElement('div');
    badge.className = 'badge ' + (label === '主动开口' ? 'proactive' : 'reply');
    badge.textContent = badgeText + (list.length > 1 ? '（段间 ' + gapMs + 'ms，会逐条出现）' : '');
    wrap.insertBefore(badge, first);
  }
  if (meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; wrap.appendChild(m); }
  for (let index = 1; index < list.length; index += 1) {
    window.setTimeout(function () {
      const bubble = add(role, list[index]);
      const badge = document.createElement('div');
      badge.className = 'badge ' + (label === '主动开口' ? 'proactive' : 'reply');
      badge.textContent = (label ? label + ' · ' : '') + '第 ' + (index + 1) + '/' + list.length + ' 段';
      bubble.parentElement.insertBefore(badge, bubble);
    }, gapMs * index);
  }
  return first;
}

async function refresh() {
  const state = await (await fetch('/api/state')).json();
  setBanner(state);
  log.innerHTML = '';
  for (const turn of state.recent) {
    if (turn.role === 'user') add('user', turn.text ?? '');
    else if (turn.action === 'SILENCE') add('xixi silent', '（西西选择沉默）', 'SILENCE');
    else add('xixi', turn.text ?? '', (turn.toolName ? '工具：' + turn.toolName : ''));
  }
  if (state.recent.length === 0) add('xixi', '我在。想说什么就说吧。');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.disabled = true;
  add('user', text);
  const pending = add('xixi', '…');
  try {
    const response = await fetch('/api/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, speak: speakBox.checked }),
    });
    const data = await response.json();
    const meta = (data.actionText ?? (data.accepted ? data.action : '未接受(' + data.reason + ')'))
      + ' · ' + data.latencyMs + 'ms' + (data.firstTokenMs == null ? '' : ' · 首字' + data.firstTokenMs + 'ms')
      + ' · ' + data.state;
    pending.parentElement.remove();
    if (data.ok === false) { add('xixi', '出错了：' + data.error, data.hint ?? ''); return; }
    if (data.action === 'SILENCE' || !data.accepted) {
      // t21: 「整轮只剩制品所以没说」 vs 「模型自己选择沉默」 must read differently, and a truncated
      // reply (finish_reason=length) must be visible instead of looking like a finished sentence.
      const why = data.accepted ? (data.silenceReasonLabel || '（西西选择沉默）') : '（这句不是对西西说的）';
      add('xixi silent', why, meta + (data.finishReason ? ' · finish=' + data.finishReason : ''));
      if (data.hygiene) add('xixi silent', '剔除了 ' + (data.hygiene.removedMarkupChars + data.hygiene.removedMarkdownChars + data.hygiene.removedReasoningChars) + ' 字不能念的内容', 'hygiene');
    }
    else {
      const firstBubble = addSegmented('xixi', data.sourceLabel ?? '回应你', data.segments, data.segmentGapMs ?? 450, meta + (data.finishReason === 'length' ? ' · ⚠ 被 token 上限截断' : ''));
      attachAudio(firstBubble, data.audio ?? null, '西西这句话的录音（可重复播放）', 'xixi-reply.wav');
    }
    if (data.audio) { const audio = new Audio('data:audio/wav;base64,' + data.audio); audio.play().catch(() => {}); }
    setBanner(await (await fetch('/api/state')).json());
  } catch (error) {
    pending.parentElement.remove();
    add('xixi', '出错了：' + error.message);
  } finally {
    input.disabled = false;
    input.focus();
  }
});

document.getElementById('quiet').addEventListener('click', async () => {
  const state = await (await fetch('/api/quiet', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' })).json();
  banner.textContent = banner.textContent.split(' · ')[0] + ' · ' + banner.textContent.split(' · ')[1] + ' · ' + state.state;
  add('xixi silent', '（安静模式：现在叫西西也不接话，点“新会话”或刷新可恢复）');
});
document.getElementById('new').addEventListener('click', async () => {
  await fetch('/api/session', { method: 'POST' });
  await refresh();
});

/**
 * 摄像头画面（复用控制台那套 LiveSensors：同一个子进程既给画面、也给在场事件）。
 *
 * 每帧是 /api/camera/frame.jpg 的原始 JPEG，浏览器直接解码 —— 不走 JSON+base64，省掉三分之一的
 * 体积，也让 JSON 通道留给状态。取下一帧用 onload 闸门：摄像头慢的时候不许请求堆积。
 */
const camImg = document.getElementById('cam-img');
const camState = document.getElementById('cam-state');
const camToggle = document.getElementById('cam-toggle');
const camFrames = document.getElementById('cam-frames');
const camProblem = document.getElementById('cam-problem');
let cameraOn = false;
let cameraTimer = null;
let frameBusy = false;

function renderCamera(payload) {
  const status = payload.status ?? {};
  const child = status.child ?? {};
  const frame = status.lastFrame;
  const problem = payload.problem;
  cameraOn = child.running === true;
  camToggle.textContent = cameraOn ? '关掉摄像头' : '打开摄像头';
  camState.textContent = cameraOn
    ? (child.frames > 0 ? '运行中（pid ' + child.pid + '）' : '正在打开摄像头…（第一次要等一两秒）')
    : (child.startedAt ? '已停止（这次一共收到 ' + child.frames + ' 帧）' : '未启用。');
  camFrames.textContent = child.frames > 0 && frame
    ? '已收到 ' + child.frames + ' 帧｜最新 ' + frame.width + '×' + frame.height + '、' + Math.round(frame.jpegBytes / 1024) + 'KB'
      + '｜' + (frame.present ? '画面里有人' : '画面里没人') + '（置信度 ' + frame.confidence.toFixed(2) + '）'
    : '';
  if (problem) {
    camProblem.style.display = 'block';
    camProblem.textContent = '⚠ ' + problem.title + '｜' + problem.note + '　可以试：' + problem.steps.join('；') + '（诊断命令：' + problem.command + '）';
  } else {
    camProblem.style.display = 'none';
  }
}
function pumpFrame() {
  if (!cameraOn || frameBusy) return;
  frameBusy = true;
  camImg.src = '/api/camera/frame.jpg?t=' + Date.now();
}
camImg.addEventListener('load', () => { frameBusy = false; });
camImg.addEventListener('error', () => { frameBusy = false; });
function startFrameTimer() {
  if (cameraTimer !== null) return;
  cameraTimer = window.setInterval(pumpFrame, 250);
  pumpFrame();
}
function stopFrameTimer() {
  if (cameraTimer !== null) { window.clearInterval(cameraTimer); cameraTimer = null; }
}
async function camPost(action) {
  const payload = await (await fetch('/api/camera', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })).json();
  renderCamera(payload);
  if (action === 'start') startFrameTimer(); else stopFrameTimer();
}
camToggle.addEventListener('click', () => { void camPost(cameraOn ? 'stop' : 'start'); });
// Status every 1.5s (frames, presence, 「交不出画面」), so the numbers below the picture are live.
window.setInterval(async () => {
  try { renderCamera(await (await fetch('/api/camera')).json()); } catch (error) { /* 页面正在关就算了 */ }
}, 1500);

/**
 * 主动开口默认打开（用户要求 2026-10-08）。
 *
 * The switch itself lives in the shared panel; this only carries the *default*: opening the page
 * brings the resident loop up, so 「她会自己开口」 needs no clicking. localStorage remembers an
 * explicit 「关掉」 so a reload does not silently undo the user's decision — a default that keeps
 * re-asserting itself after being switched off is a bug, not a default.
 */
(async function autoProactive() {
  try {
    if (localStorage.getItem('xixi.proactive') === 'off') return;
    const state = await (await fetch('/api/proactive')).json();
    if (state.settings && state.settings.enabled === false) return; // 服务端总开关是关的，不要偷偷开
    await fetch('/api/proactive/loop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
  } catch (error) { /* 面板上的总开关还能手动开 */ }
})();
const masterBox = document.getElementById('px-enabled');
if (masterBox) {
  masterBox.addEventListener('change', () => {
    try {
      if (masterBox.checked) localStorage.removeItem('xixi.proactive');
      else localStorage.setItem('xixi.proactive', 'off');
    } catch (error) { /* 隐私模式下 localStorage 会抛，忽略即可 */ }
  });
}
// 摄像头默认也打开：要看画面不该先找按钮。想省 CPU 就点「关掉摄像头」。
void camPost('start');

refresh();
input.focus();
</script>
</body></html>`;

/**
 * t21: the trial page's own helpers are importable (`silenceReasonLabel` is asserted in
 * `tests/console/reply-pipeline-console.test.ts`), so the listener only starts when this file *is*
 * the program — importing it must not bind a port.
 */
if (import.meta.main) {
  // V0.3 P2.5-B：插件/MCP/news 的工具是在 `start()` 里挂进工具链的（九步生命周期跑完再 mount），
  // 所以**监听之前**先启动常驻运行时 —— 页面从第一轮起看到的就是「插件已经在链上」的那条链。
  // 启动失败如实抛出（在 `main` 的 catch 里以中文原因结束），绝不静默降级成「这个部署没有插件」。
  await runtime.start();

  // preflight ⑦: Ctrl+C（SIGINT）与 kill / 任务管理器结束进程（SIGTERM）都走同一条收尾：
  // 停止接受新连接 → 跑完排队的后台提取 → 停插件层 → 关库 → 退出码 0。
  installShutdownHandlers({ server, extractor, store, resident: runtime });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用（可能已经开着一个 npm run web 或现场测试控制台）。`);
      console.error(`换一个端口：npm run web -- --port ${PORT + 1}；或先关掉占用该端口的程序。`);
      console.error('想用「一条命令」的现场测试控制台（含设备验收）：npm run field-test');
    } else {
      console.error(`无法在本机监听 ${PORT}：${error.message}`);
    }
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    // `--port 0` binds an ephemeral port; printing the *bound* one lets the console tests
    // drive this page without guessing (and is more honest for a user who typed 0 by accident).
    const bound = server.address();
    const actualPort = typeof bound === 'object' && bound !== null ? bound.port : PORT;
    console.log(`西西试用页面： http://127.0.0.1:${actualPort}`);
    console.log(
      `大脑 ${USE_FAKE ? '离线替身（--fake，不联网、不花钱）' : USE_DSH ? 'DSH Harness（每轮启动 profile，较慢）' : '直连 MiMo（实时路径）'}` +
        `｜身份 ${config.identity.name}｜地点 ${config.identity.place ?? '未设置'}｜朗读回复 ${TTS_ENABLED ? '开' : '关'}`,
    );
    console.log(`会话 ${session.sessionId}`);
    console.log('多段回复（ADR-0010）：西西的回复会按段逐条出现，段间停 450ms；页面上标着「第 i/N 段」。');
    console.log('主动性：页面底部那块可以开关主动开口、调冷却/额度/静默时段，并能看每道门禁的判定。');
    console.log('语音输入：页面按住🎤说话（浏览器采集，只把 VAD 检出的语音段送去识别，整段录音不落盘）。按 Ctrl+C 结束。');
    console.log('现场测试（一条命令、含设备验收与实时状态页）：npm run field-test');
  });
}
