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
export { FakeBrainAdapter, scriptedToolPlan, sayToolResult, type FakeBrainOptions, type ScriptedOutcome, type ScriptedToolPlan, type ScriptedToolRequest } from './fake.ts';
export { isSilenceReply, MimoBrainAdapter, runInferJson, SILENCE_TOKEN, type MimoBrainAdapterOptions } from './mimo.ts';
/**
 * Pack Phase 2 agent runtime, re-exported so every entry point (text or voice) builds
 * its tool chain in one place: `createToolRegistry` → `MimoBrainAdapter`/`FakeBrainAdapter`
 * → `runAgentLoop`, with the round cap and the permission checks owned by the registry.
 */
export {
  MAX_TOOL_ROUNDS,
  ToolPermission,
  ToolRegistry,
  canonicalToolArguments,
  createToolRegistry,
  executeTool,
  parseToolArguments,
  toolArgumentsDigest,
  type BuiltinToolRegistryOptions,
  type ToolApprovalGate,
  type ToolApprovalGrant,
  type ToolApprovalOutcome,
  type ToolApprovalRequest,
  type ToolCall,
  type ToolExecutionContext,
  type ToolExecution,
  type ToolExecutionOptions,
  type ToolPermissionDecision,
  type ToolPermissionOptions,
  type ToolPermissionPolicy,
  type ToolPermissionRequest,
  type ToolPermissionVerdict,
  type ToolRegistryOptions,
  type ToolRegistration,
  type ToolRole,
} from './tool-registry.ts';
export { runAgentLoop, type AgentLoopOptions, type AgentLoopResult, type AgentStep, type AgentStepOutcome, type AgentToolCall } from './agent-loop.ts';
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
  asAgentTool,
  createCurrentTimeTool,
  createMemoryReminderSink,
  createNewsTool,
  createReminderTool,
  createWeatherTool,
  defaultTools,
  type AgentScope,
  type AgentTool,
  type DefaultToolsOptions,
  type NewsItem,
  type NewsLookup,
  type NewsProvider,
  type NewsToolOptions,
  type ReminderSink,
  type ReminderToolOptions,
  type ScheduledReminder,
  type ToolCallRecord,
  type ToolContext,
  type ToolRisk,
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
  type InferJsonOptions,
  type InferJsonResult,
  type MemoryCandidate,
  type MemoryExtractionInput,
  type MultimodalTurnProvider,
  type ProactiveContext,
  type ProactiveDecision,
  type ReflectionInput,
  type ReflectionResult,
  type StructuredInferenceProvider,
  type TurnModelProvider,
  type UserTurnInput,
} from './types.ts';
