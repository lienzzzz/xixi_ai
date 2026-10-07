/**
 * The one resident assembly point — V0.3 P2.5-A (`XIXI_CURRENT_REVIEW_AND_NEXT_PLAN_2026-10-07.md` §6).
 *
 * P2 delivered a plugin kernel, an MCP adapter, a news plugin, tool approvals, durable reminders and
 * the core prompt authority. Every one of them was assembled **somewhere else** — mostly by a test —
 * so a real user still met the old runtime: 「代码里已经有 Agent 能力」 is not 「活的西西有这些能力」.
 *
 * This file is that "somewhere else". One factory takes what an entry already owns (its config, its
 * store, and the model adapter it decided to talk to) and returns one object holding the tool chain,
 * the plugin kernel (MCP and news ride in through it), the approval host, the durable reminder sink
 * and scheduler, the post-turn extraction, and a `ConversationEngine` whose prompts pass the core
 * prompt authority. A live entry then calls `start()` once, talks through `conversation`, reads
 * `toolChain` when it needs the model-facing list, and calls `stop()` once at the end.
 *
 * Why the tool chain is built **here** rather than by the caller: `buildPluginRuntime` needs the
 * approval host (`approvalGate`) and the durable reminder sink (`reminderSink`) at construction time,
 * and the approval host needs the registry back (`useRegistry`) to execute a confirmed call. That is
 * a cycle no caller can assemble correctly twice in a row — which is exactly what a single assembly
 * point is for.
 *
 * What it deliberately does **not** do:
 *
 *  * it never constructs a model client. The adapter is the caller's, or a builder that receives the
 *    finished tool chain: `chat` passes `FakeBrainAdapter` / `MimoBrainAdapter` / `DshBrainAdapter`,
 *    the console keeps its own composer. Nothing here reads a key, a DSH profile or a network.
 *  * it does not open the store. The entry owns that lifetime (`close()` is the entry's last step,
 *    after `stop()`); this factory only holds the handle it was handed. There is no `mode` option
 *    either: `fake` / `dsh` / `mimo` is a decision about the adapter, and the adapter is injected.
 *  * it does not build a `ProactiveLoop`. The loop needs seams only the entry has (session, presence,
 *    settings, TTS), and the reminder feed into it is P2.5-F: `reminders` is here ready to be ticked,
 *    and the two options the loop takes for it (`readDueReminders` / `onReminderDelivered`) are
 *    handed out as `runtime.reminderSeams` — writing that one line is the entry's job, not this
 *    factory's. The same is true of the plugin-topic feed (P2.5-C): `capabilities` is assembled (and
 *    reads this runtime's own capability registry), but `ProactiveLoopOptions.readPluginTopics` is the
 *    entry's line to write — there is no call site in `scripts/` yet, and this file does not claim one.
 *
 * ## 接线状态（诚实记录，AGENTS §9.24）
 *
 * 这个文件是**装配点**。要看「谁接了线」，请复核下面两条命令的命中，**不要引用写死在文档里的名单或计数**
 * （名单会随代码变化而过期，命令不会）：
 *
 * ```text
 * git grep -n 'createResidentRuntime(' -- scripts   # 已经走本装配点的入口（每个 live 入口都该命中）
 * git grep -n 'buildToolChain(' -- scripts          # 还在自己拼链的地方（入口不该命中：命中就是漏接线）
 * ```
 *
 * 事实是：
 *
 *  * **P2.5-A 写下的「入口尚未接线」是一条已经还清的债**：上面第一条命令的命中就是还款凭证。
 *    现场测试控制台、试用页、文字 CLI、语音单轮，以及三个附带入口（设备自检、真人感评测、对话评测）
 *    的工具链都是**本装配点的链**（`runtime.toolChain`），插件/MCP/news 的工具在 `start()` 里挂进
 *    同一个注册表 —— 所以「插件工具对模型可见」在真实入口里成立。
 *    两个例外都不算入口：`scripts/probe-tools.ts` 是**诊断探针**，仍然直接调 `buildPluginRuntime`（故意不
 *    经本装配点）；`scripts/eval-proactive-timeline.ts` 是**确定性仿真**（假大脑 + 模拟时钟、不带工具），
 *    它自己 `new ConversationEngine` 是设计的一部分，不是漏接线。
 *    （「入口尚未接线」这几个字只作为**历史引文**留在这里：P2.5-A 就是这么写下这条债的，而它已经还清。
 *    口径的现状一律用上面两条命令核，不要读这半句。）
 *  * **提醒回路尚未接线**：接缝已经在本装配点上（`runtime.reminderSeams`，入口一行展开即可），但
 *    **还没有调用点** —— `git grep -n 'new ProactiveLoop(' -- scripts` 那三处都在 `scripts/` 下，
 *    不在本装配点的 inScope 里。所以「到点她会说出来」今天仍然只是**手调 tick() 才看得见**的事，不是活的；
 *    真正接上以后，这句话与钉它的那条用例要一起改（AGENTS §9.24 的口径纪律）。
 *  * **配置真的能管插件了（P2.5-H）**：`xixi.plugins` 段由 `@xixi/domain` 的 `parsePluginSettings` **严格**解析
 *    （越界的值、写错的键名、拼错的 transport 都在**加载配置**时带路径报错，而不是留一个看起来生效的键），
 *    本文件在装配时消费它：`directories` → 内核的插件来源、`news` → 新闻来源、`mcp.servers` → MCP 服务器的
 *    **连接函数**（`mcpServerSpecs` 是「命令或地址 → 开连接」的唯一一层，SDK 在 `connect()` 里动态 import）。
 *    合并规则是「配置声明了就由配置说了算，没声明就照旧」；出厂配置里 `news.enabled` 是 `false`、`mcp.servers`
 *    是空表，所以默认工具集与接线前逐字相同。**仍未接的一环**：入口脚本今天各自带一条 RSS 来源
 *    （`git grep -n 'createRssNewsSource' -- scripts` 是这条事实的复核命令），
 *    要让「来源全部来自配置」成立，得先有一条 `scripts/` 的任务把入口里那份显式来源删掉，再把
 *    `plugins.news.enabled` 翻成 `true` —— 在那之前，配置这一路真正生效的是**没有自带来源的入口**
 *    （现场测试控制台、试用页）与 `mcp.servers`。
 *  * **提示词权威的调用点在本装配点上**：`ConversationEngine` 拿到的 assembler 是
 *    `verifyOnAssemble(...)` 包过的（插件贡献要进提示词就得先过 `verify`），而上面那些入口的引擎都是
 *    本装配点给的 `runtime.conversation`。这句话只说「入口的提示词真的路过了校验包装」；**校验器自己能
 *    拦住什么，以 `packages/plugins/src/prompt-authority.ts` 的接线状态为准**（那份文件顶部的口径是唯一出处）。
 */
import type { TurnModelProvider } from '@xixi/brain-adapter';
import type { StructuredMemoryExtractor } from '@xixi/context';
import { ConversationEngine, PromptAssembler, type ConversationEngineOptions } from '@xixi/conversation';
import {
  DEFAULT_PLUGIN_SETTINGS,
  parseReminderSettings,
  type PluginMcpServerSetting,
  type PluginSettings,
  type XixiConfig,
  type XixiStore,
} from '@xixi/domain';
import { FilePluginSource, verifyOnAssemble, type PluginState } from '@xixi/plugins';
import { createRssNewsSource, type NewsPluginOptions, type NewsSourceEnv } from '@xixi/plugins/news';
import type { McpServerSpec, McpTransport } from '@xixi/plugins/mcp';
import type { ToolRegistry } from '@xixi/brain-adapter';

import { createPluginCapabilityBridge, type PluginCapabilityBridge } from './capability-bridge.ts';
import { RuntimeError } from './errors.ts';
import type { ProactiveLoopOptions } from './proactive-runtime.ts';
import { DurableReminderSink, ReminderScheduler } from './reminder-runtime.ts';
import { ToolApprovalManager } from './tool-approval.ts';
import {
  buildPluginRuntime,
  resolveToolApprovalSettings,
  type PluginChainOptions,
  type PluginRuntimeMount,
  type PluginShutdownReport,
} from './tool-runtime.ts';
import { createTurnExtraction, type TurnExtraction } from './turn-extraction.ts';

/** Where the runtime is in its one start/stop life. */
export type ResidentRuntimeState = 'created' | 'started' | 'stopped';

/**
 * What a model-adapter **builder** is handed once the tool chain exists.
 *
 * The order matters and is the reason this type exists: `plugin → tool` mounts into the same
 * `ToolRegistry` object the adapter closes over, and it mounts in `start()`, i.e. **after** this
 * builder ran. An adapter must therefore read the registry per round (`definitionsForRound`) instead
 * of snapshotting the tool list when it is constructed — which is exactly what this repo's adapters
 * do, and what makes "build the adapter, then mount the plugins" correct rather than lucky.
 */
export interface ResidentModelContext {
  readonly config: XixiConfig;
  readonly store: XixiStore;
  /** The one tool chain every model call in this runtime talks through. */
  readonly toolChain: ToolRegistry;
  readonly approvals: ToolApprovalManager;
  readonly reminders: ReminderScheduler;
  readonly reminderSink: DurableReminderSink;
}

/**
 * The model adapter: given directly, or built from {@link ResidentModelContext}.
 *
 * Both forms are accepted because entries differ: a CLI can build its adapter from the finished chain
 * (`({ toolChain }) => new MimoBrainAdapter({ registry: toolChain, … })`), while a caller that already
 * holds an adapter passes it as is. A function adapter is not a thing in this repo, so the two forms
 * cannot be confused (`TurnModelProvider` is an object: `provider` / `describe()` / `handleUserTurn()`).
 */
export type ResidentModelInput = TurnModelProvider | ((context: ResidentModelContext) => TurnModelProvider);

/**
 * The engine's own seams, passed through — minus the four this assembly point owns.
 *
 * `adapter` / `store` / `config` / `afterTurn` are the runtime's: a second source for any of them
 * would be a way for an entry to silently leave the shared wiring (a second store is a second Xixi,
 * which is the defect V0.3 P0-B fixed once already).
 */
export type ResidentConversationOptions = Omit<ConversationEngineOptions, 'adapter' | 'store' | 'config' | 'afterTurn'>;

/** The post-turn extraction's seams (what gets asked of the model; the write policy stays in `@xixi/context`). */
export interface ResidentMemoryOptions {
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly structuredExtractor?: StructuredMemoryExtractor | undefined;
}

/**
 * Everything the factory takes.
 *
 * The chain options are inherited flat (so `now`, `weatherClient`, `fetchImpl`, `mcpServers`, `news`,
 * `inline`, `audit`, `pluginDirectory`, `permission`, `maxToolRounds`, `role`, `onToolCall`,
 * `defaultPlace` are all accepted exactly as {@link PluginChainOptions} spells them), with **three
 * seams deliberately removed**:
 *
 *  * `registry` — the chain is built here; the caller reads it back as `runtime.toolChain`;
 *  * `approvalGate` — the approval host *is* `runtime.approvals`; a second host would put two rows
 *    behind one 「谁在等谁点头」 question and break the frozen-arguments invariant (pack §5);
 *  * `reminderSink` — the durable sink is built here (`runtime.reminderSink`); accepting another one
 *    would let a caller replace persistence with an in-memory array without any error.
 *
 * There is one more source for `news` / `mcpServers` / `pluginDirectory` since P2.5-H: the deployment
 * config (`xixi.plugins`, parsed by `@xixi/domain`'s `parsePluginSettings`). The two combine by one
 * rule — **配置声明了这一段就由配置说了算，没声明就照旧用这里给的**（`pluginChainOptions` 是唯一实现）：
 *
 *  * `plugins.enabled: false`（总开关）盖过一切，连这里给的 `inline` 也不装；
 *  * `plugins.news.enabled: true` / 非空的 `plugins.mcp.servers` = 这个部署接管了新闻/MCP，
 *    入口自己写的那一份被顶掉；
 *  * 出厂配置（`config/xixi.example.yaml`）里 `news.enabled` 是 `false`、`servers` 是空的，所以
 *    「没写就是照旧」这条路就是今天的行为 —— 加配置**不改变**任何入口的默认工具集。
 */
export interface ResidentRuntimeOptions extends Omit<PluginChainOptions, 'registry' | 'approvalGate' | 'reminderSink'> {
  readonly config: XixiConfig;
  readonly store: XixiStore;
  readonly model: ResidentModelInput;
  /** One line per lifecycle event (start/stop), for an entry that prints or records a banner. Omitted = silent. */
  readonly log?: ((line: string) => void) | undefined;
  readonly conversation?: ResidentConversationOptions | undefined;
  readonly memory?: ResidentMemoryOptions | undefined;
}

/** One plugin's state right after `start()`, without handing the caller a mutable handle. */
export interface ResidentPluginStartSummary {
  readonly pluginId: string;
  readonly state: PluginState;
}

/** What `start()` did, so an entry can say it out loud (and `--print-wiring` can print `tools`). */
export interface ResidentStartReport {
  readonly state: 'started';
  readonly plugins: readonly ResidentPluginStartSummary[];
  /** Plugin/MCP/news tool names copied into the chain by this start. */
  readonly mounted: readonly string[];
  /** Names the core already owned: skipped, never overwritten. */
  readonly skipped: readonly string[];
  /** Registered by a plugin but withdrawn again — the permission policy refuses them in this scope. */
  readonly refused: readonly string[];
  /** Every tool the model may ask for right now (built-ins + mounted plugin tools, scope-filtered). */
  readonly tools: readonly string[];
}

/** What `stop()` released, in the same shape `PluginRuntimeMount.shutdown()` reports it. */
export interface ResidentShutdownReport {
  readonly state: 'stopped';
  /** Plugin lifecycle stopped, mounted copies withdrawn, the chain then cleared (built-ins included). */
  readonly plugins: PluginShutdownReport;
  /** Whether the background post-turn extraction finished before the plugin layer went down. */
  readonly extractionDrained: true;
  /** Reminders still waiting to be said — they are rows, so they survive this process. `null` = 库已关，读不到. */
  readonly remindersWaiting: number | null;
  /**
   * Approvals still waiting for a person's answer.
   *
   * **Shutdown deliberately decides nothing about them** (neither approves nor expires): a pending
   * request is somebody else's decision, it is durable, and its TTL will expire it if nobody answers.
   * `stop()` reports the count so the next process knows what it inherits.
   */
  readonly pendingApprovals: number | null;
}

/**
 * The resident runtime: everything a live entry needs, assembled once.
 *
 * `start()` and `stop()` are terminal and idempotent respectively — see the implementation notes on
 * each. `toolChain` and `plugins.registry` are the same object.
 */
export interface XixiResidentRuntime {
  readonly config: XixiConfig;
  readonly store: XixiStore;
  /** The model-facing tool chain (same object as `plugins.registry`). */
  readonly toolChain: ToolRegistry;
  readonly conversation: ConversationEngine;
  readonly plugins: PluginRuntimeMount;
  readonly approvals: ToolApprovalManager;
  readonly reminders: ReminderScheduler;
  readonly reminderSink: DurableReminderSink;
  /**
   * 主动循环的两个提醒接缝（V0.3 P2.5-F）——入口那一处 `new ProactiveLoop` 一行展开：
   *
   * ```ts
   * new ProactiveLoop({ ..., ...runtime.reminderSeams });
   * ```
   *
   * 两条必须**成对**接线，所以做成一个对象而不是两个散字段：
   *
   *   * `readDueReminders`：**先跑到点、再取候选** —— `markDue()`（`pending → due`，全库唯一比时钟的地方）
   *     加 `candidateInputs()`（`due → candidate`，然后返回**全部** `candidate` 行：上一个 tick 成为候选、
   *     当时没说的话，这一 tick 仍在列表里，不会被静默丢掉）。只做后半句是个隐形陷阱：`candidateInputs`
   *     从不让 `pending` 行变老，于是没人 tick 过的提醒会永远停在 `pending`，循环连看都看不到它；
   *   * `onReminderDelivered`：`candidate → delivered` 的记账。循环只在「决定了要说、内容也生成了」
   *     之后才调它（见 `proactive-runtime.ts` 的调用点），所以这里不判该不该说 ——
   *     **到点只是成为候选，说不说由主动路径判定**（铁律 3）。只接一半的后果是提醒被反复提议却
   *     永远停在 `candidate`。
   *
   * 类型直接取自 `ProactiveLoopOptions`（而不是在这里另写一份形状），所以「接缝恰好是循环要的那两个」
   * 由编译器保证，改了一边另一边立刻红。
   *
   * **接缝没有参数**：`readDueReminders()` 读的是本 runtime 的 `now`，所以入口要把**同一个时钟**交给
   * 循环与装配点（两处给不同的时钟 = 「到点」判定与候选读取各看一个时刻，那正是这个仓库最讨厌的隐形不一致）。
   *
   * **怎么接进主动循环**（放给入口那一行，与 `capabilities` 同一个先例）。今天仓库里还没有调用点：
   * 那三处在 `scripts/` 下（`git grep -n 'new ProactiveLoop(' -- scripts`），本任务的 inScope 之外。
   * 本文件只保证**接缝可用**，不声称「活的西西已经在说到点提醒」。
   */
  readonly reminderSeams: {
    readonly readDueReminders: NonNullable<ProactiveLoopOptions['readDueReminders']>;
    readonly onReminderDelivered: NonNullable<ProactiveLoopOptions['onReminderDelivered']>;
  };
  /** Post-turn memory extraction, already wired into the engine as `afterTurn`. */
  readonly extraction: TurnExtraction;
  /**
   * 插件能力的宿主侧桥（V0.3 P2.5-C）：今天只消费 `topic_source`，也就是「插件想说什么话题」。
   *
   * 它读的是 `plugins.runtime.capabilities` 这一份注册表（与工具链同一个内核），所以 `start()` 之后
   * 注册的能力立刻可见、插件停用后随之消失 —— 桥不缓存任何名单。
   *
   * **怎么接进主动循环**（一行，给入口/控制台的那一处 `new ProactiveLoop`）：
   *
   * ```ts
   * readPluginTopics: async (now) => (await runtime.capabilities.topics.propose({ now })).candidates,
   * ```
   *
   * 今天仓库里还没有调用点：那一处在 `scripts/` 下（本任务的 inScope 之外）。本文件只保证**能力可见**
   * 与**形状可用**，不声称「活的西西已经在用新闻话题」——那句要等入口接上以后才成立。
   */
  readonly capabilities: PluginCapabilityBridge;
  readonly state: ResidentRuntimeState;
  /**
   * Run the nine-step plugin lifecycle **and** mount what the plugins registered.
   *
   * Loud on a second call — and loud after `stop()` too: `start()` once is the contract, and a silent
   * second start would hide a host bug behind 「状态看起来是对的」 (the plan's option B for the resident
   * runtime). The two refusals are distinct because they are different facts:
   * `RESIDENT_RUNTIME_ALREADY_STARTED` (it did start before) and `RESIDENT_RUNTIME_ALREADY_STOPPED`
   * (it never started, but `stop()` already disposed the chain — starting then would report
   * `state: 'started'` while handing back an **empty** tool chain).
   */
  start(): Promise<ResidentStartReport>;
  /** Stop the plugins, release the chain, drain the extraction. Idempotent: the second call returns the same report. */
  stop(): Promise<ResidentShutdownReport>;
}

/** A count that is `null`, not a lie, when the store is already closed — shutdown must not fail to report. */
function countIfReadable(read: () => number): number | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * 配置里的新闻来源 → 新闻插件的入参（V0.3 P2.5-H）。
 *
 * 规则只有一条：**配置声明了就由配置说了算**。`plugins.news` 段没写（`null`）或写了 `enabled: false`
 * 时配置**不管这一段**，入口自己声明的 `news` 原样生效（今天入口脚本各自带一条 RSS，控制台与试用页
 * 一个都不带 —— 出厂配置正是 `enabled: false`，所以这些日子照旧）；`enabled: true` 时配置**接管**：
 * 下面这些来源就是所有入口的来源，入口自带的那份被顶掉（顶掉是故意的：一个部署想换 feed，不该因为
 * 几个入口各写了一份就改不动）。
 *
 * 来源用工厂形式（`(env) => …`）而不是直接给一个 `NewsSource`：真来源必须建在**插件拿到的网络授权**
 * （`ctx.network.fetch`）之上，否则 manifest 里的 `network` 权限就只是装饰，离线开关也绕不过去 ——
 * 这与 `scripts/chat.ts` 里那一段显式声明是同一个形状。
 */
function newsOptionsFromConfig(settings: PluginSettings, declared: NewsPluginOptions | undefined): NewsPluginOptions | undefined {
  const news = settings.news;
  if (news === null || !news.enabled) return declared;
  return {
    sources: news.sources.map(
      (source) =>
        (env: NewsSourceEnv): ReturnType<typeof createRssNewsSource> =>
          createRssNewsSource({ name: source.name, url: source.url, fetchImpl: env.fetchImpl }),
    ),
    ...(news.interests.length === 0 ? {} : { interests: [...news.interests] }),
  };
}

/**
 * 配置里的 MCP 服务器 → `McpServerSpec[]` —— **「命令或地址」变成「开连接的函数」的那一层，全仓唯一一处**。
 *
 * 为什么这一层必须存在：`McpServerSpec.connect` 是一个工厂，而 YAML 里只能写 `command`/`args` 或
 * `url`（`packages/domain/src/plugin-settings.ts` 的配置类型里**没有**函数）。翻译发生在这里，所以
 * 「配置」与「连接」两边各自只有一种形状。
 *
 * 为什么连接体里是**动态** `import()`：`@modelcontextprotocol/client` 是 `@xixi/plugins` 的依赖，
 * 而那件事本身就是 `./mcp` 子路径存在的理由（「不跑 MCP 的部署不付这份代价」，见
 * `packages/plugins/mcp/index.ts`）。写成静态 import 会把 SDK 连同它的依赖（jose / cross-spawn /
 * eventsource…）拖进**每一个** live 入口的加载图，哪怕一个 MCP 服务器都没配；放进 `connect()`，
 * 代价只在那台服务器真的被连的时候付一次。
 *
 * 连接是**惰性**的：构造 spec 与调用 `connect()` 都不发生在这里 —— 内核在自己的 `activate()` 里才连，
 * 那时失败了也只记成一条 `degraded` 健康报告（`McpClientAdapter.discover()` 契约规定不抛），
 * 启动不会因为一台服务器不在而崩。
 */
function mcpServerSpecs(servers: readonly PluginMcpServerSetting[]): McpServerSpec[] {
  return servers
    .filter((server) => server.enabled)
    .map((server): McpServerSpec => {
      const common = {
        name: server.name,
        risk: server.risk,
        ...(server.timeoutMs === null ? {} : { timeoutMs: server.timeoutMs }),
      };
      if (server.transport === 'stdio') {
        const { command, args } = server;
        return {
          ...common,
          connect: async (): Promise<McpTransport> => {
            const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
            return new StdioClientTransport({ command, args: [...args] });
          },
        };
      }
      const { url } = server;
      return {
        ...common,
        connect: async (): Promise<McpTransport> => {
          const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
          return new StreamableHTTPClientTransport(new URL(url));
        },
      };
    });
}

/**
 * MCP 的那一半，规则与新闻相同：配置声明了服务器就由配置说了算（包括「一台都别连」——
 * 服务器全写 `enabled: false` 也是**声明**，不是「没声明」），没声明就照旧用入口给的那份。
 */
function mcpServersFromConfig(settings: PluginSettings, declared: readonly McpServerSpec[] | undefined): McpServerSpec[] | undefined {
  if (settings.mcpServers.length === 0) return declared === undefined ? undefined : [...declared];
  return mcpServerSpecs(settings.mcpServers);
}

/**
 * 装配点的插件层入参：把入口自己的声明（`PluginChainOptions`）与配置文件里的声明合成一份。
 *
 * 合并规则（P2.5-H，逐条可核）：
 *
 *  * `plugins.enabled: false` —— 插件层**总开关**，它盖过一切：news / MCP / 目录 / inline 都不装
 *    （一个部署想退回「没有插件内核」的西西，这是唯一的键）。
 *  * `plugins.news` / `plugins.mcp.servers` —— **声明了就是配置说了算**（见上面两个函数）。
 *  * `plugins.directories` —— 本地插件目录，作为**额外的来源**追加在内核的来源列表后面（内核本来
 *    就吃一个来源列表，多一个目录不会顶掉任何一个入口自己给的来源；`pluginDirectory` 那条老接缝照旧）。
 *    目录不存在时内核发现不到插件、也不抛（`FilePluginSource` 的既有口径），这是配置管不到的运行期事实。
 */
function pluginChainOptions(options: PluginChainOptions, settings: PluginSettings): PluginChainOptions {
  const layer = settings.enabled;
  const directories = layer ? settings.directories.map((directory) => new FilePluginSource(directory)) : [];
  return {
    ...options,
    inline: layer ? [...(options.inline ?? [])] : [],
    news: layer ? newsOptionsFromConfig(settings, options.news) : undefined,
    mcpServers: layer ? mcpServersFromConfig(settings, options.mcpServers) : undefined,
    sources: layer ? [...(options.sources ?? []), ...directories] : undefined,
    pluginDirectory: layer ? options.pluginDirectory : undefined,
  };
}

/**
 * Build the resident runtime.
 *
 * Construction is synchronous and touches no I/O: the store is the caller's already-open handle, the
 * plugin kernel is only *constructed* (discovery, MCP connection and news activation all happen in
 * `start()`), and the engine builds nothing but its own in-memory state. Awaiting this value is
 * harmless, but it is not a promise — there is no asynchronous step here, and pretending otherwise
 * would only move the first failure into a `Promise.all` somewhere else.
 */
export function createResidentRuntime(options: ResidentRuntimeOptions): XixiResidentRuntime {
  const { config, store } = options;
  const log = options.log;
  const now = options.now;
  const approval = resolveToolApprovalSettings(config, options.approval);

  // The approval host first: `buildPluginRuntime` needs it as the registry's `approvalGate`, and it
  // needs the registry back afterwards (`useRegistry`) to execute the call a person confirmed.
  const approvals = new ToolApprovalManager({
    store,
    settings: approval,
    ...(now === undefined ? {} : { now }),
  });

  // The durable reminder sink: the tool `xixi_set_reminder_stub` writes through this, in the same
  // `reminders` table the scheduler walks. Built before the chain because the chain takes it.
  const reminderSink = new DurableReminderSink({
    store,
    timezone: config.identity.timezone,
    settings: parseReminderSettings(config.reminders),
    ...(now === undefined ? {} : { now }),
  });

  // The chain and the plugin kernel: the same `buildPluginRuntime` P2 already had, with the two hosts
  // injected plus whatever the deployment config declares (P2.5-H: directories / news / MCP).
  // Everything else (built-ins, permission policy, round cap) is unchanged.
  const pluginSettings = config.plugins ?? DEFAULT_PLUGIN_SETTINGS;
  const plugins = buildPluginRuntime(
    config,
    {
      ...pluginChainOptions(options, pluginSettings),
      approval,
      approvalGate: approvals,
      reminderSink,
    },
  );
  const toolChain = plugins.registry;
  approvals.useRegistry(toolChain);

  // Passive on purpose: no timer, no tick. Whoever wants 「到点」 — the proactive loop (P2.5-F) or a
  // test — calls `runtime.reminders.tick(now)`; this factory does not decide when the clock advances.
  const reminders = new ReminderScheduler({ store, ...(now === undefined ? {} : { now }) });

  /**
   * The two seams the proactive loop takes for reminders (P2.5-F), in one pair so an entry cannot wire
   * half of them (see the interface doc).
   *
   * `readDueReminders` is the **whole clock pass**: `markDue` (pending → due, the only place the clock
   * is compared) and then `candidateInputs` (due → candidate, then *every* candidate row as an input).
   * Doing only the second half is a silent trap — `candidateInputs` never ages a `pending` row, so a
   * reminder nobody else ticked would stay `pending` forever and the loop would never even see it
   * (the counterexample test in `tests/integration/reminder/durable-reminder.test.ts` reds on it).
   *
   * `onReminderDelivered` is pure accounting: the loop calls it only after she actually spoke.
   */
  const reminderSeams = {
    readDueReminders: () => {
      reminders.markDue();
      return reminders.candidateInputs();
    },
    onReminderDelivered: (reminderId: string, at: Date) => {
      reminders.deliver(reminderId, at);
    },
  };

  // 插件能力的宿主侧桥（P2.5-C）：只读上面那一份 `CapabilityRegistry`，无缓存、无副作用，所以 `start()`
  // 之后新注册的 `topic_source` 立刻可见，停用的插件随之不再提案。它**不含**任何判定：插件只提案。
  const capabilities = createPluginCapabilityBridge({
    capabilities: plugins.runtime.capabilities,
    timezone: config.identity.timezone,
    ...(log === undefined ? {} : { log }),
  });

  const extraction = createTurnExtraction({
    store,
    config,
    ...(options.memory?.onError === undefined ? {} : { onError: options.memory.onError }),
    ...(options.memory?.structuredExtractor === undefined ? {} : { structuredExtractor: options.memory.structuredExtractor }),
  });

  const modelContext: ResidentModelContext = { config, store, toolChain, approvals, reminders, reminderSink };
  const adapter = typeof options.model === 'function' ? options.model(modelContext) : options.model;

  // 提示词权威（pack §3）：谁给的 assembler 都要过 `verify` —— 插件贡献进提示词的那条路只能通过校验器。
  // 包一层而不是「另建一个」，所以调用方自己的 assembler（测试/回放）仍然是那个被校验的装配器。
  const assembler = verifyOnAssemble(options.conversation?.assembler ?? new PromptAssembler(), {
    pluginId: 'xixi.resident-runtime',
  });
  const conversationOptions = options.conversation ?? {};
  const conversation = new ConversationEngine({
    adapter,
    store,
    config,
    ...conversationOptions,
    assembler,
    afterTurn: extraction.afterTurn,
  });

  let state: ResidentRuntimeState = 'created';
  /**
   * Sticky independently of `state`: `state` reports what actually happened, this reports that
   * `start()` was asked for. A start that threw therefore still refuses a retry (the kernel may be
   * half up — the honest move is a new runtime, not a second `start()` on a partly-loaded one).
   */
  let startCalled = false;
  /**
   * Terminal once `stop()` is called — set **synchronously**, before `shutdown()`'s first `await`, so
   * there is no window in which a `start()` can slip in behind a `stop()` that is already under way.
   *
   * Why this exists (P2.5-C round 3): `shutdown()` disposes the tool chain, built-ins included, and
   * shuts the plugin kernel down. `startCalled` alone therefore did **not** close the door on the
   * 「stop 了但没 start 过」 path: that runtime still passed the first guard, `plugins.start()` came
   * back empty (the kernel is disposed; `loadAll` is a bring-up-what-you-can entry point), and the
   * object reported `state: 'started'` with an **empty** chain — 「看起来起来了、其实什么都调不了」.
   */
  let closed = false;
  let stopPromise: Promise<ResidentShutdownReport> | undefined;

  async function shutdown(): Promise<ResidentShutdownReport> {
    closed = true;
    // ① The engine's background work first: Tier-2 extraction is in flight, and 「数据丢失不能是无声的」
    //    (the same discipline every entry follows before closing the store).
    await extraction.drain();
    // ② Then the plugin layer: lifecycle stop (MCP connections close here) → withdraw the copies
    //    `mount()` made → clear what is left, built-ins included. All three steps are idempotent.
    const pluginsReport = await plugins.shutdown();
    state = 'stopped';
    const report: ResidentShutdownReport = {
      state: 'stopped',
      plugins: pluginsReport,
      extractionDrained: true,
      remindersWaiting: countIfReadable(() => reminders.waiting().length),
      pendingApprovals: countIfReadable(() => approvals.pending().length),
    };
    log?.(
      `[resident-runtime] 已关停：撤回 ${pluginsReport.unmounted.length} 个插件工具，清空前链上剩 ${pluginsReport.remainingBeforeClear.length} 个；` +
        `还有 ${report.remindersWaiting ?? '?'} 条提醒、${report.pendingApprovals ?? '?'} 条待批留给下一个进程`,
    );
    return report;
  }

  return {
    config,
    store,
    toolChain,
    conversation,
    plugins,
    approvals,
    reminders,
    reminderSink,
    reminderSeams,
    extraction,
    capabilities,
    get state(): ResidentRuntimeState {
      return state;
    },
    async start(): Promise<ResidentStartReport> {
      if (startCalled) {
        throw new RuntimeError(
          'RESIDENT_RUNTIME_ALREADY_STARTED',
          `这个常驻 runtime 已经启动过（当前状态 ${state}）：start() 只该调一次。`,
          '重复启动是宿主 bug，静默返回会让「插件到底起来了没有」看不出来；关停是终态，要重启就新建一个 runtime。',
        );
      }
      if (closed) {
        // 这条路径上它**没有**启动过，所以措辞不能是「已经启动过」（那是另一条路上的事实）。
        throw new RuntimeError(
          'RESIDENT_RUNTIME_ALREADY_STOPPED',
          `这个常驻 runtime 已经关停（当前状态 ${state}）：关停是终态，start() 不会再把它拉起来，要重启就新建一个 runtime。`,
          '它一次都没启动过，所以这不是「重复启动」；但关停已经 dispose 了工具链（内置工具也一起清掉）与插件层，' +
            '再 start 一次只会得到一条空链 —— 那正是「状态看起来是 started、其实什么都调不了」。',
        );
      }
      startCalled = true;
      const instances = await plugins.start();
      state = 'started';
      const report: ResidentStartReport = {
        state: 'started',
        plugins: instances.map((instance) => ({ pluginId: instance.pluginId, state: instance.state })),
        mounted: [...plugins.notes.mounted],
        skipped: [...plugins.notes.skipped],
        refused: [...plugins.notes.refused],
        tools: toolChain.listForAgent('conversation').map((tool) => tool.name),
      };
      log?.(
        `[resident-runtime] 插件已启动：新挂载 ${report.mounted.length} 个（${report.mounted.join('、') || '无'}），` +
          `模型可见 ${report.tools.length} 个工具`,
      );
      return report;
    },
    stop(): Promise<ResidentShutdownReport> {
      // Idempotent, and a failed stop is retried rather than cached: every step it calls is idempotent.
      stopPromise ??= shutdown().catch((error: unknown) => {
        stopPromise = undefined;
        throw error;
      });
      return stopPromise;
    },
  };
}
