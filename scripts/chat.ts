/**
 * Talk to Xixi from the terminal.
 *
 * This is the runnable demo the objective asks for: real multi-turn conversation
 * with continuity, personality and silence, plus per-turn latency numbers.
 *
 * Addressing (until M2 has a wake word): the same rule as the trial page — a line
 * typed while the FSM is IDLE counts as calling her, and while a session is open
 * the FSM treats the line as a continuation. A follow-up-window timeout returns
 * the session to IDLE, so the next line is accepted again instead of being
 * rejected for the rest of the process.
 *
 * Usage:
 *   node scripts/chat.ts                     # direct MiMo (realtime path)
 *   node scripts/chat.ts --fake              # offline deterministic adapter
 *   node scripts/chat.ts --dsh               # through the DSH harness (slower)
 *   node scripts/chat.ts --personality verbosity=0.1,talkativeness=0.2
 *   node scripts/chat.ts --personality=verbosity=0.1
 *   node scripts/chat.ts --print-wiring   # 离线：打印这条入口交给模型的工具链，然后退出
 *                                         #   （不调模型、不建库、不联网；工具集里含插件提供的
 *                                         #    news.search / news.latest / news.for_interests）
 *   echo "西西，明天天气怎么样？`n那后天呢？" | node scripts/chat.ts
 *
 * `--personality` is an administrative baseline override (the M3 seam), applied
 * before the engine is built, so the banner and the follow-up window show the
 * overridden values and the very next prompt carries them.
 *
 * Commands inside the session: /state /prompt /quiet /resume /exit
 */
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { DshBrainAdapter, FakeBrainAdapter, MimoBrainAdapter, type ToolCallRecord, type ToolRegistry, type TurnModelProvider } from '@xixi/brain-adapter';
import { CliDshTransport } from '@xixi/brain-dsh';
import { openXixiStore, PERSONALITY_PROPERTIES, personalityProperty, resolveCanonicalDataDir, type XixiConfig, type XixiStore } from '@xixi/domain';
import { WeatherClient, type MimoClient } from '@xixi/model-adapters';
import { createRssNewsSource } from '@xixi/plugins/news';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, readDotEnv } from './lib/harness.ts';
// V0.3 P0-A: the shared tool chain moved to `@xixi/runtime`; `scripts/field-test.ts` still
// re-exports it for anyone that has not migrated yet (this entry has — it no longer imports
// the console script at all). See pack `04_RUNTIME_CONSOLIDATION.md` §1 Step A.
// V0.3 P2.5-C: 这个入口的工具链、插件内核（news 从这里进来）、审批宿主、durable 提醒、提取与引擎
// 全部来自常驻装配点 `createResidentRuntime` —— 本文件不再自己拼链，也不再自己 new 引擎。
import {
  CONVERSATION_SCOPE,
  createResidentRuntime,
  type PluginChainOptions,
  type ResidentModelInput,
  type XixiResidentRuntime,
} from '@xixi/runtime';

export interface PersonalityArgsResult {
  /**
   * Validated `property → value` pairs (later wins on duplicates).
   *
   * Empty whenever `problems` is non-empty: the result is all-or-nothing, so a
   * caller cannot apply the valid half of a typo'd override by accident.
   */
  readonly values: Record<string, number>;
  /** Human-readable problems; any entry means nothing may be applied. */
  readonly problems: readonly string[];
}

const PERSONALITY_NAMES = PERSONALITY_PROPERTIES.map((property) => property.name).join('、');

/**
 * Parse `--personality`.
 *
 * Both forms the usage line documents must work, and the old parser supported
 * neither:
 *   `--personality a=1,b=2`   (separate token — the value used to be dropped)
 *   `--personality=a=1,b=2`   (was split on the first `=`, yielding `a`)
 * Values are validated here rather than left to the store, so a typo produces a
 * readable sentence instead of a stack trace or a silent no-op. Nothing is
 * applied when any problem is found: a half-applied personality is worse than a
 * refusal, because the user would have no way to tell which knobs moved.
 */
export function parsePersonalityArgs(argv: readonly string[]): PersonalityArgsResult {
  const problems: string[] = [];
  const specifications: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--personality') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        problems.push('`--personality` 后面缺少设置；例如 `--personality verbosity=0.1,talkativeness=0.2`。');
        continue;
      }
      specifications.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--personality=')) {
      specifications.push(argument.slice('--personality='.length));
    }
  }

  const values: Record<string, number> = {};
  for (const item of specifications.flatMap((specification) => specification.split(','))) {
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      problems.push('人格设置里出现了空项（多余的逗号，或 `--personality=` 后面没写东西）。');
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      problems.push(`人格设置「${trimmed}」缺少「=」，应写成 \`属性=数值\`，例如 \`verbosity=0.1\`。`);
      continue;
    }
    const name = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const definition = personalityProperty(name);
    if (definition === undefined) {
      problems.push(`未知的人格属性「${name}」；可用属性：${PERSONALITY_NAMES}。`);
      continue;
    }
    if (rawValue.length === 0) {
      problems.push(`人格属性「${name}」的值为空；应填 ${definition.min}~${definition.max} 之间的数字。`);
      continue;
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      problems.push(`人格属性「${name}」的值「${rawValue}」不是数字。`);
      continue;
    }
    if (value < definition.min || value > definition.max) {
      problems.push(
        `人格属性「${name}」的值 ${value} 超出允许范围 [${definition.min}, ${definition.max}]（${definition.description}）。`,
      );
      continue;
    }
    values[name] = value;
  }

  return { values: problems.length > 0 ? {} : values, problems };
}

/** How the CLI talks to the model: a scripted stand-in, the DSH harness, or a direct MiMo call. */
export type ChatMode = 'fake' | 'dsh' | 'mimo';

/**
 * The weather source `--fake` uses.
 *
 * `npm run chat -- --fake` is documented as a **completely offline** demo (AGENTS §7), and that
 * promise has to survive the tools being wired in: without this, a question about the weather would
 * reach the real provider from a run that is supposed to touch nothing. The payload is the same
 * fields a live lookup returns — code, temperatures, precipitation probability — so the tool derives
 * the same summary, range and umbrella advice from it as it would from the network.
 */
function offlineWeatherSource(): WeatherClient {
  const reply = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const fetchImpl = (async (input: string | URL | Request) =>
    String(input).includes('geocoding')
      ? reply({ results: [{ name: '成都', latitude: 30.66, longitude: 104.06, timezone: 'Asia/Shanghai', admin1: '四川省' }] })
      : reply({
          timezone: 'Asia/Shanghai',
          daily: {
            time: ['2026-10-01', '2026-10-02', '2026-10-03'],
            weather_code: [61, 3, 0],
            temperature_2m_max: [24.4, 25.1, 27.8],
            temperature_2m_min: [18.2, 19.0, 20.1],
            precipitation_probability_max: [80, 8, 0],
          },
        })) as unknown as typeof fetch;
  return new WeatherClient({ fetchImpl });
}

/**
 * 这个部署的新闻来源（V0.3 P2.5-C）。
 *
 * 今天它是**入口里显式给出**的一条公开 RSS —— 与手动探针 `node scripts/probe-tools.ts --news-live`
 * 用的是同一个默认 feed。为什么不能「先不配来源」：`news.*` 三个工具是插件的 manifest 声明的，
 * 没有来源时它们**照样会被广告给模型**，而调用只会得到 `items: []`（`asked: 0`）—— 模型很容易把它
 * 读成「今天没什么新闻」，那正是这个仓库反复禁止的「拿不到就编」。真来源取不到时，`problems` 里带着
 * 来源自己的话进返回，模型能如实说「我这边取不到」。
 *
 * P2.5-H（`config.plugins.news.sources`）会把这一段换成配置驱动；在那之前它是**每个入口一份**的
 * 显式声明，改的时候四处一起改（四个入口的工具集由 `tests/console/live-entry-tool-chain.test.ts`
 * 钉成同一条，来源差异只能靠这份注释人工核对）。
 */
const NEWS_FEED_URL = 'https://feeds.bbci.co.uk/news/world/rss.xml';

/**
 * `--fake`（以及 `--print-wiring`）的离线保证：**给插件网络授权的 fetch 一用即抛**。
 *
 * `--fake` 的天气走一个离线夹具（它是**固定读数**的演示数据），新闻不一样：离线桩提供的是**编出来的
 * 标题**，让用户会看到的入口念出假新闻比编天气危险得多（铁律 8 的精神）。所以 `--fake` 只保证
 * 「绝不联网」——真去取就抛在这里，而不是悄悄发出去、也不是拿假头条顶上。
 */
const offlinePluginFetch = (async (input: string | URL | Request) => {
  throw new Error(`这次运行是离线的，不允许联网：${String(input)}`);
}) as unknown as typeof fetch;

/** 这个入口的插件层入参：来源是新闻插件，离线开关换掉它的网络授权。 */
function chatPluginLayer(mode: ChatMode, offline: boolean): Pick<PluginChainOptions, 'news' | 'fetchImpl' | 'weatherClient'> {
  return {
    ...(mode === 'fake' ? { weatherClient: offlineWeatherSource() } : {}),
    ...(offline ? { fetchImpl: offlinePluginFetch } : {}),
    news: {
      // The factory form: the real source is built from the **granted** fetch (`ctx.network`), so the
      // manifest's `network` permission is load-bearing rather than decorative — and the offline
      // switch above reaches the source instead of being bypassed by a captured global.
      sources: [(env) => createRssNewsSource({ name: 'BBC World', url: NEWS_FEED_URL, fetchImpl: env.fetchImpl })],
    },
  };
}

export interface ChatRuntimeOptions {
  readonly config: XixiConfig;
  /** 这个进程的库。报告路径传一个一次性内存库，真实路径传 household/`XIXI_CHAT_DATA_DIR`。 */
  readonly store: XixiStore;
  readonly mode: ChatMode;
  /** 覆盖模型装配（测试注入替身走这里；不给就按 `mode` 决定）。 */
  readonly model?: ResidentModelInput | undefined;
  readonly onToolCall?: ((record: ToolCallRecord) => void) | undefined;
  /**
   * 把插件的 `network` 授权换成「一用即抛」的 fetch（`--fake` 自动开，`--print-wiring` 显式开）。
   * 开着就**结构上不可能联网**：任何插件请求都会在 `offlinePluginFetch` 里抛出来。
   */
  readonly offlinePlugins?: boolean | undefined;
  /** 生命周期横幅往哪写（默认 stdout）。报告路径改成 stderr，好让 stdout 只剩报告那一行 JSON。 */
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * 这个入口的常驻运行时（V0.3 P2.5-C）：**工具链、插件内核、审批宿主、durable 提醒、记忆提取与引擎
 * 一次装好**，本文件只决定「哪一个模型」与「插件层配了什么」。
 *
 * 为什么要有这个函数而不在 `main()` 里直接 `createResidentRuntime(...)`：`--print-wiring` 与真实一轮
 * 必须是**同一份装配**（报告里的工具集就是真一轮交给模型的工具集），差别只允许有三处，而且都是为了
 * 离线报告：一次性内存库、一用即抛的 fetch、注入的替身模型 —— 见 `printWiring`。
 */
export function createChatRuntime(options: ChatRuntimeOptions): XixiResidentRuntime {
  const { config, store, mode } = options;
  const offline = options.offlinePlugins === true || mode === 'fake';
  return createResidentRuntime({
    config,
    store,
    ...chatPluginLayer(mode, offline),
    onToolCall:
      options.onToolCall ??
      ((record) => process.stderr.write(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}\n`)),
    log: options.log ?? ((line) => console.log(line)),
    conversation: { turnTimeoutMs: 60_000 },
    model: options.model ?? (({ toolChain }) => buildChatAdapter({ mode, config, store, toolChain })),
  });
}

/**
 * 这个入口的**核心链**（不含插件工具），留给离线用例驱动适配器。
 *
 * 兼容表面（V0.3 P2.5-C）：入口自己不再调它 —— `main()` 与 `--print-wiring` 都走 `createChatRuntime`。
 * 保留它是因为 `tests/console/chat-reply-language.test.ts`（不在本次改动范围）用它拿一个注册表来跑
 * `buildDirectAdapter`；而这里给的是**同一个装配点的链**，不是第二条 `buildToolChain`：权限政策、
 * 轮数上限、`--fake` 的离线天气源因此只有一处定义，改一处两条路一起变。
 *
 * 未启动，所以看到的是三个内置工具（插件工具要 `runtime.start()` 之后才挂进来）；库是一次性内存库，
 * 不落盘、不碰 household 库。
 */
export function buildChatToolChain(mode: ChatMode, config: XixiConfig, onToolCall?: (record: ToolCallRecord) => void): ToolRegistry {
  return createChatRuntime({
    config,
    mode,
    store: openXixiStore({ dbPath: ':memory:' }),
    ...(onToolCall === undefined ? {} : { onToolCall }),
  }).toolChain;
}

export interface ChatDirectAdapterOptions {
  readonly config: XixiConfig;
  readonly toolChain: ToolRegistry;
  /** Injected by a test; the CLI lets the adapter build its client from the environment. */
  readonly client?: MimoClient;
}

/**
 * The direct-MiMo adapter with this entry's exact wiring — exported so an offline test can drive the
 * real thing instead of a lookalike.
 *
 * Two t14 fixes live here. T5-F1: the adapter is handed the shared *registry* (not a bare
 * `defaultTools` list), so this CLI gets the same built-ins (three since P2-D), the same permissions
 * and the same four-round cap as the console. T5-F3: the reply-hygiene filter is told the **deployment
 * language** from the config; the adapter's own default is a hard-coded `zh-CN`, and a deployment that
 * speaks something else must not silently inherit that assumption.
 */
export function buildDirectAdapter(options: ChatDirectAdapterOptions): MimoBrainAdapter {
  return new MimoBrainAdapter({
    ...(options.client === undefined ? {} : { client: options.client }),
    maxCompletionTokens: 400,
    registry: options.toolChain,
    scope: CONVERSATION_SCOPE,
    timezone: options.config.identity.timezone,
    language: options.config.identity.language,
  });
}

/**
 * 按 `mode` 选这一轮的模型适配器（V0.3 P2.5-C：链由装配点给，本函数只决定「哪一个模型」）。
 *
 * 适配器在装配时就构造好了，但**只在这一轮真的说话时才会被调用** —— `--print-wiring` 因此可以走
 * 同一个装配而不碰模型（`MimoClient` 的构造不读密钥、不发请求；缺密钥只在真正发起请求时才报）。
 */
export function buildChatAdapter(options: { readonly mode: ChatMode; readonly config: XixiConfig; readonly store: XixiStore; readonly toolChain: ToolRegistry }): TurnModelProvider {
  if (options.mode === 'fake') return new FakeBrainAdapter({ registry: options.toolChain, scope: CONVERSATION_SCOPE });
  if (options.mode === 'dsh') {
    const transport = new CliDshTransport({
      dshHome: DSH_HOME,
      profile: DSH_PROFILE,
      cwd: REPO_ROOT,
      env: harnessEnv(),
      timeoutMs: 240_000,
      onDiagnostic: (line) => process.stderr.write(`[dsh] ${line}\n`),
    });
    return new DshBrainAdapter({ transport, store: options.store });
  }
  return buildDirectAdapter({ config: options.config, toolChain: options.toolChain });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const useFake = argv.includes('--fake');
  const useDsh = argv.includes('--dsh');
  const { values: personalityOverride, problems } = parsePersonalityArgs(argv);

  if (problems.length > 0) {
    console.error('[参数错误] 人格覆盖没有生效：');
    for (const problem of problems) console.error(` - ${problem}`);
    console.error('用法：node scripts/chat.ts [--fake] [--dsh] [--personality 属性=数值,...]');
    process.exitCode = 2;
    return;
  }

  // The direct adapter reads the key from the environment or .env (§20.4: never from source).
  for (const [key, value] of Object.entries(readDotEnv())) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  const config = loadConfig();
  const mode: ChatMode = useFake ? 'fake' : useDsh ? 'dsh' : 'mimo';

  // The offline wiring report (t14, P2.5-C): what this entry hands the model, with no model call and
  // no store.
  if (argv.includes('--print-wiring')) {
    await printWiring(config, mode);
    return;
  }

  /**
   * V0.3 P0-B: the household canonical store by default (`XIXI_DATA_DIR`, else `data/xixi`), so the
   * CLI, the trial page, the console and the perception ingest all read and write **one** Xixi.
   * `XIXI_CHAT_DATA_DIR` is still honoured (tests and parallel instances), but it now sits *below*
   * the household switch — see `resolveCanonicalDataDir` for the precedence table.
   */
  const store = openXixiStore({ dataDir: resolveCanonicalDataDir({ legacyEnv: 'XIXI_CHAT_DATA_DIR', cwd: REPO_ROOT }) });
  const session = store.latestSession() ?? store.createSession();
  store.seedSelfProfile(config.personality.base);
  if (Object.keys(personalityOverride).length > 0) {
    // Explicitly an administrative override, not learned adjustment (M3).
    // The engine is built after this point, so the follow-up window and the next
    // prompt both see the overridden values.
    store.overrideSelfProfile(personalityOverride, 'cli:override');
    const applied = Object.entries(personalityOverride)
      .map(([name, value]) => `${name}=${value}`)
      .join(', ');
    console.log(`人格已按命令行覆盖：${applied}`);
    console.log(`生效人格（已写入 self_profile，重启后仍是它）：${JSON.stringify(store.selfProfile())}`);
  }

  /**
   * V0.3 P2.5-C：**装配一次** —— 工具链、插件内核、审批宿主、durable 提醒、记忆提取与引擎都在
   * `runtime` 上。`afterTurn` 由装配点内部接到共享提取器（V0.3 P1-b 的同一份工厂：只入队不 await），
   * 而 `runtime.stop()` 内含 `extraction.drain()`，所以关库之前的那条纪律还在。
   *
   * 插件/MCP/news 的工具是在 `start()` 里挂进链的（九步生命周期跑完再 mount），所以**说话之前**
   * 先启动：第一轮起模型看到的就是「插件已经在链上」的那条链。
   */
  const runtime = createChatRuntime({ config, store, mode });
  await runtime.start();
  const engine = runtime.conversation;

  const described = engine.adapter.describe();
  console.log(`西西（${described.provider} / ${described.model}）已就绪。`);
  console.log(`会话 ${session.sessionId}，已有 ${session.turnCount} 轮；人格 ${JSON.stringify(store.selfProfile())}`);
  console.log(
    `跟进窗口 ${engine.lingerMs}ms（由人格 silence_tolerance=${engine.silenceTolerance} 缩放）；` +
      'IDLE 时直接说话即为叫醒，会话开了就按继续处理。输入 /exit 结束。\n',
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });

  async function handle(line: string): Promise<void> {
    const text = line.trim();
    if (text.length === 0) return;
    if (text === '/exit') {
      rl.close();
      return;
    }
    if (text === '/state') {
      console.log(`state=${engine.state} ${JSON.stringify(engine.snapshot())}\n`);
      return;
    }
    if (text === '/prompt') {
      const prompt = engine.buildPrompt({ sessionId: session.sessionId, text: '(预览)' });
      console.log(`--- system ---\n${prompt.system}\n--- user ---\n${prompt.user}\n`);
      return;
    }
    if (text === '/quiet') {
      engine.quiet();
      console.log('已进入安静模式（/resume 恢复）。\n');
      return;
    }
    if (text === '/resume') {
      engine.resume();
      console.log('已恢复。\n');
      return;
    }

    try {
      // Same rule as the trial page (`scripts/serve-chat.ts`): the terminal has no
      // wake word yet (M2), so a line typed while the session is idle counts as
      // calling her — a follow-up-window timeout returns the FSM to IDLE, and the
      // next line must be accepted again. While a session is open, `addressed` is
      // ignored by the FSM (continuation), so mirroring the page is enough.
      const addressed = engine.state === 'IDLE';
      /**
       * Say the reply the way ADR-0010 means it to be said: **segment by segment**, with the
       * real pause between them, instead of one wall of text. `onSegment` and `onTextChunk`
       * are mutually exclusive by design (the engine stops handing out raw deltas once the
       * playback seam is supplied), so the printing happens here and the summary below stays
       * quiet — otherwise every reply would appear twice.
       */
      const played: string[] = [];
      /**
       * preflight ⑧: 引擎的 `onNotice` 是「这一轮为什么什么也没说 / 被剔掉了什么」的唯一出口
       * （试用页与控制台早就订阅了，这个终端入口以前没有：`ARTIFACT_ONLY_REPLY`（整句被清洗掉）
       * 与 `MODEL_SILENCE`（模型自己不说）在这里看起来一模一样）。先收集，这一轮说完再打。
       */
      const notices: { readonly code: string; readonly detail: string }[] = [];
      const turn = await engine.respond(
        { sessionId: session.sessionId, text, addressed },
        {
          onSegment: async (segment) => {
            const label = segment.total > 1 ? `【第 ${segment.index + 1}/${segment.total} 段】` : '';
            process.stdout.write(`\n西西${label}：${segment.text}`);
            played.push(segment.text);
            if (segment.gapMsAfter !== null && segment.index + 1 < segment.total) {
              process.stdout.write(`\n（停 ${segment.gapMsAfter}ms 再说下一段…）`);
              await delay(segment.gapMsAfter);
            }
          },
          onNotice: (notice) => void notices.push({ code: notice.code, detail: notice.detail }),
        },
      );
      const timing = `[${turn.action} ${turn.latencyMs}ms${turn.firstTokenMs === null ? '' : ` 首字${turn.firstTokenMs}ms`} state=${turn.state} linger=${engine.lingerMs}ms 人格=${engine.silenceTolerance}${turn.segments.length > 1 ? ` 分${turn.segments.length}段/间隔${turn.segmentGapMs}ms` : ''}]`;
      if (!turn.accepted) {
        // Say what this means instead of just refusing.
        console.log(`未接受（${turn.reason}）：西西正处在安静模式，用 /resume 恢复。`);
      } else if (turn.action === 'SILENCE') {
        console.log(`（沉默）${timing}`);
      } else if (played.length > 0) {
        console.log(`\n${timing}`);
      } else {
        console.log(`${turn.text ?? ''}\n${timing}`);
      }
      // 沉默的原因 / 被剔掉的内容（preflight ⑧）：一行一条，带 code，便于对照文档里的原因码。
      for (const notice of notices) console.log(`[提示 ${notice.code}] ${notice.detail}`);
    } catch (error) {
      console.log(`\n[错误] ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log('');
  }

  for await (const line of rl) {
    await handle(line);
  }
  store.recordHealth('chat', 'ok', 'session ended');
  /**
   * 关库之前先关停常驻运行时（t9 F3 的同一纪律：数据丢失不能是无声的）：`stop()` 的第一件事就是
   * `extraction.drain()`（排队与在飞的提取跑完），然后才关停插件层、清空链。**顺序不能反** ——
   * 关停报告里的「还有几条提醒 / 几条待批」要读得到库。
   */
  await runtime.stop();
  store.close();
}

/**
 * `--print-wiring` 的报告（V0.3 P2.5-C）：这条入口交给模型的工具集，**离线**打印。
 *
 * 三条离线保证，都是结构性的，而不是「这次恰好没发生」：
 *
 *  * **不建库**：库是一次性内存库（`StoreOptions.dbPath` 给测试用的那条 `:memory:`），不落盘、
 *    不碰 household 库；
 *  * **不联网**：插件的 `network` 授权被换成「一用即抛」的 `offlinePluginFetch`；
 *  * **不调模型**：注入一个**永不被调用**的替身（`--fake` 用的那个 `FakeBrainAdapter`），而不是按
 *    `mode` 装配真适配器 —— 真适配器会解析 DSH 安装路径 / 建客户端，那些与本报告无关，却能让报告
 *    因为一台没装 DSH 的机器失败。所以**无密钥、无 DSH 也能 exit 0**。
 *
 * 工具集**不是手写清单**：它是 `start()` 跑完九步生命周期、插件工具真的挂进链**之后**的注册表，
 * 而 `plugins.mounted` 是那次挂载自己的记录 —— 两句话互相印证，不可能各写一份。
 */
async function printWiring(config: XixiConfig, mode: ChatMode): Promise<void> {
  const runtime = createChatRuntime({
    config,
    mode,
    store: openXixiStore({ dbPath: ':memory:' }),
    offlinePlugins: true,
    // 报告的 stdout 只有那一行 JSON（脚本要能直接管道给 jq）：装配点自己的横幅改走 stderr。
    log: (line) => process.stderr.write(`${line}\n`),
    // 替身模型：报告只读工具链，这条路径从不发起一轮（见上面的三条保证）。
    model: ({ toolChain }) => new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE }),
  });
  try {
    const started = await runtime.start();
    const chain = runtime.toolChain;
    console.log(
      JSON.stringify({
        entry: 'chat',
        language: config.identity.language,
        maxToolRounds: chain.maxToolRounds,
        tools: chain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name),
        permissions: Object.fromEntries(chain.names().map((name) => [name, chain.check(name, CONVERSATION_SCOPE).verdict])),
        // 插件那一层的实况：这次 `start()` 挂了什么进来、拒了什么（内置工具不会被覆盖，所以
        // 「工具集里多出来的那三个」只能来自这里）。
        plugins: { mounted: [...started.mounted], skipped: [...started.skipped], refused: [...started.refused] },
      }),
    );
  } finally {
    await runtime.stop();
    runtime.store.close();
  }
}

// Guarded so tests can import `parsePersonalityArgs` without opening the store,
// reading `.env` or starting a REPL (`import.meta.main` is true only for the
// entry module).
if (import.meta.main) {
  await main();
}
