/**
 * `@xixi/conversation` — the deterministic half of a conversation: the state
 * machine that decides whether a turn is accepted (§12/§13), the prompt
 * assembly that decides what the model sees (§26), and the engine that ties
 * them to the adapter and the event log.
 */
export {
  ConversationEngine,
  type ConversationEngineOptions,
  type ConversationTurn,
  type ReplySegmentPlayback,
  type RespondHooks,
  type RespondInput,
} from './engine.ts';
export {
  ConversationStateMachine,
  DEFAULT_FSM_CONFIG,
  type ConversationState,
  type FsmConfig,
  type FsmSnapshot,
  type TurnAcceptance,
  type TurnAcceptanceReason,
} from './fsm.ts';
export {
  CORE_IDENTITY,
  describeTimeOfDay,
  HARD_POLICY,
  personalityDirectives,
  PromptAssembler,
  SILENCE_TOKEN,
  worldStateLite,
  type AssembleInput,
  type AssembledPrompt,
  type PromptTurn,
  type WorldStateLite,
} from './prompt.ts';
export { DEFAULT_SILENCE_TOLERANCE } from './personality.ts';
export {
  normalizeReplyText,
  REPLY_LIMITS,
  resolveReplyLimits,
  splitReplyIntoSegments,
  type ReplySegmentOptions,
  type SegmentedReply,
} from './segments.ts';
export {
  DEFAULT_PROACTIVE_SETTINGS,
  DEFAULT_PROACTIVITY,
  evaluateProactiveGates,
  isWithinQuietHours,
  localDayOf,
  localMinutesOf,
  parseClockMinutes,
  parseProactiveSettings,
  PROACTIVE_REASON_CODES,
  PROACTIVE_SCORE_WEIGHTS,
  PROACTIVE_TRIGGERS,
  ProactiveEngine,
  proactiveThreshold,
  readProactiveHistory,
  scoreProactiveCandidate,
  type ProactiveCandidate,
  type ProactiveConsiderInput,
  type ProactiveDelivery,
  type ProactiveDeliveryRecord,
  type ProactiveEngineOptions,
  type ProactiveGateContext,
  type ProactiveGateResult,
  type ProactiveOutcome,
  type ProactiveReasonCode,
  type ProactiveSettings,
  type ProactiveTrigger,
} from './proactive.ts';
