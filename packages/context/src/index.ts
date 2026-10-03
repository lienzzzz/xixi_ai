/**
 * `@xixi/context` —— V0.3 P1 的上下文装配层（pack `docs/02_MEMORY_CONTEXT.md` §1 §2 §3 §6）。
 *
 * 公开面只有三样东西：`ContextBuilder`（唯一入口）、它产出的类型、以及可单独核对的
 * 排序算术（`lexicalRelevance` / `recencyScore` / …）。渲染函数也导出，因为「提示词里没有 UUID
 * 与调试数字」这条纪律的判据就挂在它们身上，测试要能单独压。
 */
export {
  ContextBuilder,
  describeTimeOfDay,
  offsetIso,
  type ContextBuilderOptions,
} from './context-builder.ts';
export {
  DEFAULT_CANDIDATE_LIMIT,
  DEFAULT_MIN_CONFIDENCE,
  fromEpisodic,
  fromNote,
  fromSemantic,
  isMemoryKind,
  MAX_INJECTED,
  MEMORY_SCORE_FLOOR,
  MEMORY_SCORE_WEIGHTS,
  MEMORY_STRONG_SCORE_FLOOR,
  MemoryRetriever,
  MIN_INJECTED,
  usefulText,
  visibleTo,
  type MemoryCandidate,
  type RetrieveMemoriesInput,
} from './memory-retriever.ts';
export {
  alreadyMentionedPenalty,
  ALREADY_MENTIONED_THRESHOLD,
  bestBigramCoverage,
  GENERIC_SUBJECTS,
  lexicalRelevance,
  MAX_ALREADY_MENTIONED_PENALTY,
  MAX_STALE_PENALTY,
  MIN_BIGRAM_RELEVANCE,
  MIN_LEXICAL_RELEVANCE,
  NEGATION_MARKERS,
  openThreadScore,
  POLARITY_CONFLICT_PENALTY,
  polarityConflict,
  recencyScore,
  RECENCY_HALF_LIFE_DAYS,
  STALE_AFTER_DAYS,
  stalePenalty,
  subjectScore,
} from './memory-score.ts';
export {
  buildRelationshipContext,
  DEFAULT_AUDIENCE,
  RELATIONSHIP_NOTE_LIMIT,
  RELATIONSHIP_WINDOW_DAYS,
  relationshipRecentStats,
  relationshipStyleHints,
  renderRelationshipProse,
  type RelationshipInputs,
} from './relationship-context.ts';
export {
  MEMORY_HEADING,
  memoryTags,
  renderGate,
  renderMemoryLines,
  renderOpenThreadLines,
  renderSelfLines,
  renderWorldLines,
  type MemoryRenderResult,
} from './render.ts';
export { parseContextMemorySettings, type ContextMemorySettings } from './settings.ts';
export type { PromptTurnLike, TurnRoleLike } from './prompt-turn.ts';
export {
  MEMORY_KINDS,
  MEMORY_VISIBILITIES,
  type AudienceContext,
  type ConversationContext,
  type ContextSources,
  type DroppedMemory,
  type EffectiveSelfContext,
  type MemoryKind,
  type MemoryProvenance,
  type MemoryRetrievalDiagnostics,
  type MemoryRetrievalResult,
  type MemoryScoreWeights,
  type MemoryVisibility,
  type OpenThreadContext,
  type ProactiveContext,
  type ProactiveTurnContextInput,
  type RelationshipContext,
  type RelationshipRecentStats,
  type RelationshipStyleHints,
  type RenderedContext,
  type RetrievedMemory,
  type UserTurnContextInput,
  type WorldContext,
} from './types.ts';
