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
 */
import { createToolRegistry, type AgentScope, type NewsProvider, type ReminderSink, type ToolCallRecord, type ToolRegistry } from '@xixi/brain-adapter';
import type { XixiConfig } from '@xixi/domain';
import type { WeatherClient } from '@xixi/model-adapters';

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
