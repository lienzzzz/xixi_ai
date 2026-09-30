/**
 * `@xixi/brain-adapter` — the harness boundary from 《方案》§25.
 *
 * Only this package may know about DSH. Everything above it sees domain
 * vocabulary (`UserTurnInput`, `BrainTurnResult`), which is what keeps the
 * harness swappable (§3.2, §44).
 */
export {
  DshBrainAdapter,
  type BrainSessionStore,
  type DshBrainAdapterOptions,
  type DshTransport,
  type DshTurnRequest,
  type DshTurnResponse,
} from './dsh.ts';
export {
  BrainError,
  brainErrorCodeFor,
  toBrainErrorCauseCode,
  type BrainErrorCauseCode,
  type BrainErrorCode,
} from './errors.ts';
export { FakeBrainAdapter, type FakeBrainOptions, type ScriptedOutcome } from './fake.ts';
export { isSilenceReply, MimoBrainAdapter, SILENCE_TOKEN, type MimoBrainAdapterOptions } from './mimo.ts';
/**
 * t7 reply hygiene, re-exported so the layer above can use it without depending on the model
 * client package directly: `sanitizeSpokenReply` is the deterministic gate the engine applies
 * to every adapter's text (markup always, English reasoning when the deployment speaks Chinese).
 */
export {
  createSpokenTextFilter,
  isChineseLanguage,
  sanitizeSpokenReply,
  stripForeignReasoning,
  stripToolCallMarkup,
  type ReplyHygieneResult,
  type SpokenReplyOptions,
  type SpokenTextFilter,
} from '@xixi/model-adapters';
export {
  createCurrentTimeTool,
  createWeatherTool,
  defaultTools,
  type ToolCallRecord,
  type ToolContext,
  type WeatherToolOptions,
  type XixiTool,
} from './tools.ts';
export { ScriptedDshTransport, type ScriptedTransportOptions, type ScriptedTurn } from './scripted.ts';
export {
  collectTurn,
  createBrainTurnStream,
  flattenPrompt,
  splitIntoChunks,
  type AssembledPromptLike,
  type BrainAdapter,
  type BrainContext,
  type BrainDescription,
  type BrainImageInput,
  type BrainTurnChunk,
  type BrainTurnResult,
  type BrainTurnStream,
  type ConversationTurnView,
  type FeedbackAdjustment,
  type FeedbackDecision,
  type FeedbackInput,
  type MemoryCandidate,
  type MemoryExtractionInput,
  type ProactiveContext,
  type ProactiveDecision,
  type ReflectionInput,
  type ReflectionResult,
  type UserTurnInput,
} from './types.ts';
