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
 *    settings, TTS), and the reminder feed into it is P2.5-F. `reminders` is here, ready to be ticked.
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
 *  * **提醒回路尚未接线**：`ReminderScheduler` 只是被装配出来（`runtime.reminders`），
 *    **没有任何 tick 调用点**，也没有接进 `ProactiveLoop`（那是 P2.5-F）。也就是说「到点她会说出来」
 *    今天仍然只是**手调 `tick()` 才看得见**的事，不是活的。
 *  * **提示词权威的调用点在本装配点上**：`ConversationEngine` 拿到的 assembler 是
 *    `verifyOnAssemble(...)` 包过的（插件贡献要进提示词就得先过 `verify`），而上面那些入口的引擎都是
 *    本装配点给的 `runtime.conversation`。这句话只说「入口的提示词真的路过了校验包装」；**校验器自己能
 *    拦住什么，以 `packages/plugins/src/prompt-authority.ts` 的接线状态为准**（那份文件顶部的口径是唯一出处）。
 */
import type { TurnModelProvider } from '@xixi/brain-adapter';
import type { StructuredMemoryExtractor } from '@xixi/context';
import { ConversationEngine, PromptAssembler, type ConversationEngineOptions } from '@xixi/conversation';
import { parseReminderSettings, type XixiConfig, type XixiStore } from '@xixi/domain';
import { verifyOnAssemble, type PluginState } from '@xixi/plugins';
import type { ToolRegistry } from '@xixi/brain-adapter';

import { RuntimeError } from './errors.ts';
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
 * There is no `news` / `mcpServers` source other than this argument today: `XixiConfig` has no
 * `plugins` section yet (`packages/domain/src/config.ts`), so reading one would be reading a key
 * nothing writes. Wiring 「配置文件 → 插件」 is P2.5-H; until then `config/xixi.example.yaml` documents
 * those options as comments, and the honest position is that they are passed in explicitly.
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
  /** Post-turn memory extraction, already wired into the engine as `afterTurn`. */
  readonly extraction: TurnExtraction;
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
  // injected. Everything else (built-ins, permission policy, round cap, MCP, news) is unchanged.
  const plugins = buildPluginRuntime(config, { ...options, approval, approvalGate: approvals, reminderSink });
  const toolChain = plugins.registry;
  approvals.useRegistry(toolChain);

  // Passive on purpose: no timer, no tick. Whoever wants 「到点」 — the proactive loop (P2.5-F) or a
  // test — calls `runtime.reminders.tick(now)`; this factory does not decide when the clock advances.
  const reminders = new ReminderScheduler({ store, ...(now === undefined ? {} : { now }) });

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
    extraction,
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
