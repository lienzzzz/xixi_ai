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
 * V0.3 P2-A adds one thing above that: `mountPluginTools` / `buildPluginRuntime`, the **one**
 * place where the plugin kernel (`@xixi/plugins`) and the tool chain meet. Nothing about the
 * existing chain changes — a plugin tool is copied into the same registry the four built-ins live
 * in, so it is subject to the same permission policy, round cap and timeout.
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
import { createPluginRuntime, type PluginAuditRecord, type PluginRuntime, type PluginSource } from '@xixi/plugins';

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
}

/** Everything a live entry needs to run plugins: the shared tool chain and the plugin kernel. */
export interface PluginRuntimeMount {
  readonly registry: ToolRegistry;
  readonly runtime: PluginRuntime;
}

/**
 * Assemble the shared tool chain **and** a plugin runtime around it.
 *
 * The direction of the dependency is the point: the plugin kernel depends on the tool registry's
 * types, never the other way round, and this function is the single call site that knows both.
 * Nothing is loaded here — `runtime.start()` runs the nine-step lifecycle.
 *
 * There is no separate "mount" step, and that is a design decision rather than an omission: a
 * plugin's tool enters the core `CapabilityRegistry` during the lifecycle, and the two guards that
 * matter — the reserved `xixi_` namespace and the scope check — fire there, while the plugin is
 * loading. Copying the tool into the core registry afterwards would be a second, weaker place to
 * make the same decision (铁律 12 applies to adding machinery as much as to adding packages).
 * What the model is given is still this registry: a plugin tool is mounted by registering what the
 * capability registry holds.
 */
export function buildPluginRuntime(config: XixiConfig, options: PluginChainOptions = {}): PluginRuntimeMount {
  const registry = options.registry ?? buildToolChain(config, options);
  const permission = options.permission ?? new ToolPermission();
  const runtime = createPluginRuntime({
    tools: registry,
    permission,
    ...(options.sources === undefined ? {} : { sources: options.sources }),
    ...(options.pluginDirectory === undefined ? {} : { pluginDirectory: options.pluginDirectory }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { registry, runtime };
}
