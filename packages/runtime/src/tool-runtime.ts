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
 */
import {
  createToolRegistry,
  ToolPermission,
  type AgentScope,
  type NewsProvider,
  type ReminderSink,
  type ToolCallRecord,
  type ToolPermissionPolicy,
  type ToolRegistry,
} from '@xixi/brain-adapter';
import type { XixiConfig } from '@xixi/domain';
import type { WeatherClient } from '@xixi/model-adapters';
import {
  createPluginRuntime,
  type CapabilityRegistry,
  type Disposable,
  type InlinePlugin,
  type PluginAuditRecord,
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
}

/**
 * The shared tool chain the text path and the voice path both use.
 *
 * This is the single assembly point: `scripts/field-test.ts` (console voice + text),
 * `scripts/serve-chat.ts` (trial page voice + text), `scripts/voice-turn.ts` (file-driven
 * voice) and the four CLI entries all build their adapter from the registry this returns, so
 * "语音和文字走同一条工具链" is a property of the code rather than of a call site, and the
 * four built-ins are registered exactly once.
 */
export function buildToolChain(config: XixiConfig, options: ToolChainOptions = {}): ToolRegistry {
  return createToolRegistry({
    defaultPlace: options.defaultPlace ?? config.identity.place ?? '',
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.weatherClient === undefined ? {} : { weatherClient: options.weatherClient }),
    ...(options.newsProvider === undefined ? {} : { newsProvider: options.newsProvider }),
    ...(options.reminderSink === undefined ? {} : { reminderSink: options.reminderSink }),
    ...(options.maxToolRounds === undefined ? {} : { maxToolRounds: options.maxToolRounds }),
    ...(options.onToolCall === undefined ? {} : { onToolCall: options.onToolCall }),
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
      skipped.push(name);
      continue;
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

/** Everything a live entry needs to run plugins: the shared tool chain and the plugin kernel. */
export interface PluginRuntimeMount {
  readonly registry: ToolRegistry;
  readonly runtime: PluginRuntime;
  /** Present when `mcpServers` was configured: the adapter's status/health outside the lifecycle. */
  readonly mcp?: McpClientAdapter | undefined;
  /** Copies the currently registered plugin tools into the tool chain; call after `start()`. */
  mount(): PluginMountReport;
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
 * Nothing is connected or loaded here. `runtime.start()` runs the nine-step lifecycle (which is
 * where MCP discovery happens), `mount()` copies the result into the chain the model is given.
 */
export function buildPluginRuntime(config: XixiConfig, options: PluginChainOptions = {}): PluginRuntimeMount {
  const registry = options.registry ?? buildToolChain(config, options);
  const permission = options.permission ?? new ToolPermission();
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
  return {
    registry,
    runtime,
    ...(mcp === undefined ? {} : { mcp: mcp.adapter }),
    notes,
    mount() {
      const report = mountPluginTools(registry, runtime.capabilities);
      notes.mounted = [...report.mounted];
      notes.skipped = [...report.skipped];
      notes.refused = [...report.refused];
      return report;
    },
  };
}
