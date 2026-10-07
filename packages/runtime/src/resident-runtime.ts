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
 * 这个文件是**装配点**，不是**接线**。今天的事实是：
 *
 *  * **入口尚未接线**：四个 live 入口（`scripts/chat.ts`、`scripts/serve-chat.ts`、
 *    `scripts/field-test.ts`、`scripts/voice-turn.ts`）仍然各自调 `buildToolChain` /
 *    `buildPluginRuntime`，一个都还没有走 `createResidentRuntime`。P2.5-B（四个入口改走本装配点）
 *    是后续任务；在那之前，「插件工具对模型可见」这条**已经成立的能力，在真实入口里还看不到**。
 *  * **提醒回路尚未接线**：`ReminderScheduler` 只是被装配出来（`runtime.reminders`），
 *    **没有任何 tick 调用点**，也没有接进 `ProactiveLoop`（那是 P2.5-F）。也就是说「到点她会说出来」
 *    今天仍然只是**手调 `tick()` 才看得见**的事，不是活的。
 *  * **提示词权威在本装配点上是接上的**：`ConversationEngine` 拿到的 assembler 是
 *    `verifyOnAssemble(...)` 包过的（插件贡献要进提示词就得先过 `verify`）。但**没有 live 入口经过本装配点**，
 *    所以「生产 Prompt 被守住」这句话今天同样只在装配点内部为真 —— 不要写成已经守住真实入口的提示词。
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
   * Loud on a second call: `start()` once is the contract, and a silent second start would hide a
   * host bug behind 「状态看起来是对的」 (the plan's option B for the resident runtime).
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
  let stopPromise: Promise<ResidentShutdownReport> | undefined;

  async function shutdown(): Promise<ResidentShutdownReport> {
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
