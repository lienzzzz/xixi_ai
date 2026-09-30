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
