/**
 * Step A of pack `04_RUNTIME_CONSOLIDATION.md` §1: the tool chain every live entry shares.
 *
 * Moved here **verbatim** from `scripts/field-test.ts` (V0.3 P0-A). Two facts about the move:
 *
 *   * `scripts/field-test.ts` still re-exports both symbols, so every old import keeps
 *     working while the call sites are migrated one by one (pack `01_ARCHITECTURE.md` §3:
 *     never move everything at once, keep the compatibility re-export until the last
 *     caller is gone);
 *   * the console is no longer the file that *owns* the assembly point — it is a caller of
 *     it, like the trial page and the four CLI entries. That is the whole point of the
 *     extraction: 「语音和文字走同一条工具链」 stops being a property of `field-test.ts`.
 *
 * The four built-ins, the permission policy and the round cap are unchanged: this file only
 * flattens `ToolChainOptions` into `createToolRegistry`'s inputs, exactly as before.
 *
 * V0.3 P2-A/P2-C add one thing above that: `mountPluginTools` / `buildPluginRuntime`, the **one**
 * place where the plugin kernel (`@xixi/plugins`), the MCP adapter (`@xixi/plugins/mcp`) and the tool
 * chain meet. Nothing about the existing chain changes — a plugin (or MCP) tool is copied into the
 * same registry the four built-ins live in, so it is subject to the same permission policy, round
 * cap and timeout.
 *
 * **接线状态（一句话口径，细节见 `PluginRuntimeMount`）：内核已交付且本装配点已接线——`start()` 跑完
 * 生命周期并挂载，插件工具对模型可见；但四个 live 入口（`scripts/chat.ts`、`scripts/serve-chat.ts`、
 * `scripts/field-test.ts`、`scripts/voice-turn.ts`）今天仍只调 `buildToolChain`，**入口尚未接线**；
 * 提示词侧的 `verifyOnAssemble` 也还没有调用点。这两条是下一阶段的显式接线项。**
 */
import {
  createToolRegistry,
  ToolPermission,
  type AgentScope,
  type NewsProvider,
  type ReminderSink,
  type ToolApprovalGate,
  type ToolCallRecord,
  type ToolPermissionPolicy,
  type ToolRegistry,
  type ToolRole,
} from '@xixi/brain-adapter';
import { parseToolApprovalSettings, type ToolApprovalSettings, type XixiConfig } from '@xixi/domain';
import type { WeatherClient } from '@xixi/model-adapters';
import {
  createPluginRuntime,
  type CapabilityRegistry,
  type Disposable,
  type InlinePlugin,
  type PluginAuditRecord,
  type PluginInstance,
  type PluginRuntime,
  type PluginSource,
  type PluginToolSpec,
} from '@xixi/plugins';
import { createMcpPlugin, type McpClientAdapter, type McpServerSpec } from '@xixi/plugins/mcp';

/**
 * The agent scope a conversation runs in.
 *
 * Annotated as `AgentScope` (rather than imported from the model client package or left as a
 * bare literal) so the compiler checks it against the registry's own union: renaming it there
 * becomes a `check:types` error instead of a silent drift. The registry still owns the full
 * scope list (`tools.ts`, `AgentScope`); this is the one value the runtime needs.
 */
export const CONVERSATION_SCOPE: AgentScope = 'conversation';

/** Overrides on the built-in tool set. The data sources are injectable so an offline run needs no network. */
export interface ToolChainOptions {
  readonly defaultPlace?: string;
  readonly now?: () => Date;
  readonly weatherClient?: WeatherClient;
  readonly newsProvider?: NewsProvider | null;
  readonly reminderSink?: ReminderSink;
  readonly onToolCall?: (record: ToolCallRecord) => void;
  readonly maxToolRounds?: number;
  readonly role?: ToolRole;
  /** 显式的权限策略；不给就按审批设置构造（`askTools` 来自声明）。 */
  readonly permission?: ToolPermissionPolicy;
  /**
   * 工具审批的声明面（pack §5）。不给就读 `config.tools`（`tools.approval.ask` / `ttl_seconds`）。
   * **两边都没有 = 没有任何工具需要 ASK**：审批要先声明，不是「默认先问一句」。
   */
  readonly approval?: ToolApprovalSettings;
  /**
   * 审批宿主（`ToolApprovalManager`）。给了它，`ask` 的工具调用才会被**持久化**成待批请求；
   * 不给就退回到 P2 之前的行为：模型被要求先问一句，但不落库。
   */
  readonly approvalGate?: ToolApprovalGate;
}

/**
 * 审批声明的解析：显式传入优先，其次 `config.tools`，都没有就是出厂默认（空表）。
 *
 * 单独导出是为了让「声明从哪来」这件事只有一个答案：`buildToolChain` 与
 * `buildPluginRuntime` 走同一个函数，入口构造 `ToolApprovalManager` 时也用它。
 */
export function resolveToolApprovalSettings(
  config: XixiConfig,
  override?: ToolApprovalSettings | undefined,
): ToolApprovalSettings {
  return override ?? parseToolApprovalSettings(config.tools);
}

/**
 * The shared tool chain the text path and the voice path both use.
 *
 * This is the single assembly point: `scripts/field-test.ts` (console voice + text),
 * `scripts/serve-chat.ts` (trial page voice + text), `scripts/voice-turn.ts` (file-driven
 * voice) and the four CLI entries all build their adapter from the registry this returns, so
 * "语音和文字走同一条工具链" is a property of the code rather than of a call site, and the
 * four built-ins are registered exactly once.
 *
 * V0.3 P2-B adds one input: the permission policy is built **here** from the declared ask list
 * (`config.tools.approval.ask`), so every entry that already calls `buildToolChain` inherits the
 * same approval policy without a per-entry wiring step. No ask list declared → no ASK anywhere.
 */
export function buildToolChain(config: XixiConfig, options: ToolChainOptions = {}): ToolRegistry {
  const approval = resolveToolApprovalSettings(config, options.approval);
  const permission = options.permission ?? new ToolPermission({
    ...(options.role === undefined ? {} : { role: options.role }),
    askTools: approval.ask,
  });
  return createToolRegistry({
    defaultPlace: options.defaultPlace ?? config.identity.place ?? '',
    permission,
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.weatherClient === undefined ? {} : { weatherClient: options.weatherClient }),
    ...(options.newsProvider === undefined ? {} : { newsProvider: options.newsProvider }),
    ...(options.reminderSink === undefined ? {} : { reminderSink: options.reminderSink }),
    ...(options.maxToolRounds === undefined ? {} : { maxToolRounds: options.maxToolRounds }),
    ...(options.onToolCall === undefined ? {} : { onToolCall: options.onToolCall }),
    ...(options.approvalGate === undefined ? {} : { approval: options.approvalGate }),
  });
}

export interface PluginChainOptions extends ToolChainOptions {
  readonly sources?: readonly PluginSource[];
  readonly pluginDirectory?: string;
  readonly registry?: ToolRegistry;
  readonly permission?: ToolPermissionPolicy;
  readonly audit?: (record: PluginAuditRecord) => void;
  /**
   * MCP servers to bring in as one plugin (pack `03_AGENT_PLUGIN.md` §4).
   *
   * A server is reached **only** when a tool is called; there is no polling and no subscription, so
   * this option cannot turn the tool chain into a high-frequency sensor path.
   */
  readonly mcpServers?: readonly McpServerSpec[];
  /** Plugins the host already holds, loaded alongside the MCP one. */
  readonly inline?: readonly InlinePlugin[];
}

/** What one `mountPluginTools` call did, so a caller can say it out loud instead of guessing. */
export interface PluginMountReport {
  readonly mounted: readonly string[];
  /** Names the core already owns: skipped, never overwritten. */
  readonly skipped: readonly string[];
  /** Registered but not offered in the conversations this runtime serves: withdrawn again. */
  readonly refused: readonly string[];
  readonly disposable: Disposable;
}

/**
 * Copy every capability-registered tool into the core `ToolRegistry` — the step that makes a plugin
 * (or MCP) tool visible to the model.
 *
 * Why the mount lives **here** and not in the plugin kernel: only the host knows which registry the
 * model is actually given. The kernel owns registration and its guards (manifest declaration,
 * permission, reserved namespace); the runtime owns this one copy.
 *
 * Three properties are load-bearing:
 *
 *  * it copies the same `AgentTool` object, so `ToolPermission`, the round cap and `executeTool`'s
 *    timeout apply unchanged (pack §3 boundary「不能绕过 ToolPermission」);
 *  * a name the core already owns is **skipped, never overwritten** — `xixi_get_weather` stays the
 *    core's;
 *  * a tool the policy refuses in this scope is registered, judged, and then **withdrawn** — it is
 *    not offered as something the model can ask for.
 *
 * One case refreshes instead of skipping: a name whose capability this plugin **re-registered** (the
 * `deactivate → activate` cycle builds new tool objects) is replaced, so the model-facing copy is
 * always the current activation's. A core tool is never in the capability registry, so that branch
 * cannot reach it.
 */
export function mountPluginTools(registry: ToolRegistry, capabilities: CapabilityRegistry): PluginMountReport {
  const owned = new Set(registry.names());
  const mounted: string[] = [];
  const skipped: string[] = [];
  const refused: string[] = [];
  const releases: Disposable[] = [];

  for (const spec of capabilities.values<PluginToolSpec>('tool')) {
    const name = spec.tool.name;
    if (owned.has(name)) {
      const currentInCore = registry.all().find((tool) => tool.name === name);
      const ownedByCapability = capabilities.ownerOf('tool', name) !== undefined;
      if (currentInCore === undefined || !ownedByCapability || currentInCore === spec.tool) {
        skipped.push(name);
        continue;
      }
      // Same name, different object, and the capability registry says this plugin owns that name:
      // the mounted copy is from a previous activation. Refresh it rather than leaving it behind.
      registry.unregister(name);
    }
    const release = registry.register(spec.tool);
    const verdict = registry.check(name, CONVERSATION_SCOPE);
    if (verdict.verdict === 'deny') {
      release.dispose();
      refused.push(name);
      continue;
    }
    releases.push(release);
    mounted.push(name);
  }

  return {
    mounted,
    skipped,
    refused,
    disposable: {
      dispose: () => {
        for (const release of [...releases].reverse()) release.dispose();
      },
    },
  };
}

/** What a shutdown released, so the host can log it rather than guess. */
export interface PluginShutdownReport {
  /** Capabilities the plugin runtime released (deactivate + dispose per plugin). */
  readonly pluginsDisposed: number;
  /** Names `mount()` had copied into the chain, now withdrawn from it. */
  readonly unmounted: readonly string[];
  /** Tools still in the chain after the unmount — the four built-ins, until the final clear. */
  readonly remainingBeforeClear: readonly string[];
}

/**
 * Everything a live entry needs to run plugins: the shared tool chain and the plugin kernel.
 *
 * **接线状态（诚实记录，AGENTS §9.24）：**
 *
 *  * **已接**：`start()` 跑完九步生命周期**并**调用 `mountPluginTools`，所以启动之后插件/MCP 工具真的
 *    在模型可见的工具链里（`definitionsForRound` 能查到、能被核心执行）——这条有 `runtime-wiring`
 *    用例钉住。
 *  * **未接**：四个 live 入口（`scripts/chat.ts` 等）今天仍然只调 `buildToolChain`，也就是说
 *    **内核已交付、入口尚未接线**。把 `buildPluginRuntime` 接到入口，是下一阶段的显式接线项之一。
 *  * **未接**：提示词侧的 `verify`（`verifyOnAssemble`）也还没有调用点，真实装配点
 *    `packages/conversation` 的 `PromptAssembler` 不在本任务的 inScope 里。同样登记为下一阶段的
 *    显式接线项。
 *
 * 这两条「未接」是状态，不是待办装饰：任何文档/回报都不得把它们写成已接线。
 */
export interface PluginRuntimeMount {
  readonly registry: ToolRegistry;
  readonly runtime: PluginRuntime;
  /** Present when `mcpServers` was configured: the adapter's status/health outside the lifecycle. */
  readonly mcp?: McpClientAdapter | undefined;
  /**
   * Run the nine-step lifecycle for every configured plugin **and** mount what they registered.
   *
   * One call, not two: a host that starts a runtime and then forgets to mount would have a kernel
   * that looks healthy and tools the model cannot see. `mount()` stays public for a re-mount after a
   * hot-plug (a plugin loaded later than the initial `start()`).
   */
  start(): Promise<readonly PluginInstance[]>;
  /** Copies the currently registered plugin tools into the tool chain; call after a hot-plug. */
  mount(): PluginMountReport;
  /**
   * The host's shutdown handle, in three steps: stop the plugins, withdraw what `mount()` copied in,
   * then clear what is left.
   *
   * **它与 per-registration Disposable 的关系**（这是 F4 要求说清的那句话）：
   *  * 细粒度那一档是 `ToolRegistry.register()` 返回的 Disposable——一次只放掉**一个**工具，插件
   *    `deactivate` 走的就是它（放掉这个插件贡献的那几个）；
   *  * `shutdown()` 是宿主那一档：先让插件运行时 `disposeAll()`（释放能力登记、断开 MCP 连接），
   *    再用 `mount()` 那次的 Disposable 撤回自己复制进工具链的副本，最后 `ToolRegistry.dispose()`
   *    一次清空——那一步**连四个内置工具也一起清掉**，且**不碰** `CapabilityRegistry`（能力是插件层
   *    的事，上面两步已经处理完了）。
   * 三步都幂等，重复关停不会抛。
   */
  shutdown(): Promise<PluginShutdownReport>;
  /** What the last `mount()` did, for a caller that only keeps the handle. */
  readonly notes: { mounted: string[]; skipped: string[]; refused: string[] };
}

/**
 * Assemble the shared tool chain **and** a plugin runtime around it.
 *
 * The direction of the dependency is the point: the plugin kernel depends on the tool registry's
 * types, never the other way round, and this function is the single call site that knows both —
 * plus the one place an MCP server is turned into a plugin.
 *
 * Nothing is connected or loaded here. `start()` runs the nine-step lifecycle (which is where MCP
 * discovery happens) and then mounts the result; `shutdown()` is the other end of it.
 */
export function buildPluginRuntime(config: XixiConfig, options: PluginChainOptions = {}): PluginRuntimeMount {
  const approval = resolveToolApprovalSettings(config, options.approval);
  // The plugin kernel gets the **same** policy as the built-ins: a plugin tool declared `ask` in
  // `config.tools.approval.ask` is confirmed before it runs, and one that is not declared never ASKs.
  const registry = options.registry ?? buildToolChain(config, { ...options, approval });
  const permission =
    options.permission ??
    new ToolPermission({ ...(options.role === undefined ? {} : { role: options.role }), askTools: approval.ask });
  const mcp =
    options.mcpServers === undefined || options.mcpServers.length === 0
      ? undefined
      : createMcpPlugin({
          servers: options.mcpServers,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
  const inline: InlinePlugin[] = [...(options.inline ?? []), ...(mcp === undefined ? [] : [mcp.plugin])];

  const runtime = createPluginRuntime({
    tools: registry,
    permission,
    ...(options.sources === undefined ? {} : { sources: options.sources }),
    ...(options.pluginDirectory === undefined ? {} : { pluginDirectory: options.pluginDirectory }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(inline.length === 0 ? {} : { inline }),
  });

  const notes = { mounted: [] as string[], skipped: [] as string[], refused: [] as string[] };
  let lastMount: PluginMountReport | undefined;

  const mount = (): PluginMountReport => {
    const report = mountPluginTools(registry, runtime.capabilities);
    lastMount = report;
    notes.mounted = [...report.mounted];
    notes.skipped = [...report.skipped];
    notes.refused = [...report.refused];
    return report;
  };

  return {
    registry,
    runtime,
    ...(mcp === undefined ? {} : { mcp: mcp.adapter }),
    notes,
    mount,
    async start() {
      const instances = await runtime.start();
      mount();
      return instances;
    },
    async shutdown() {
      // Order matters: release the plugins first (their capabilities and connections go), then
      // withdraw the copies, then clear what is left. Each step is idempotent.
      const pluginsDisposed = await runtime.stop();
      const unmounted = [...(lastMount?.mounted ?? [])];
      lastMount?.disposable.dispose();
      lastMount = undefined;
      const remainingBeforeClear = registry.names();
      registry.dispose();
      return { pluginsDisposed, unmounted, remainingBeforeClear };
    },
  };
}
