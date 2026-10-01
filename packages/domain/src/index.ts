/**
 * `@xixi/domain` — Xixi's durable state: event log, sessions, personality
 * baseline. This is the only package that opens SQLite.
 */
export { type Clock, fixedClock, systemClock } from './clock.ts';
export { loadXixiConfig, parseXixiConfig, type XixiConfig } from './config.ts';
export { DomainError, type DomainErrorCode } from './errors.ts';
export {
  isFollowUpDue,
  normalizeThreadSummary,
  OPEN_THREAD_ACTIVE_STATUSES,
  OPEN_THREAD_SETTLED_STATUSES,
  OPEN_THREAD_STATUSES,
  OpenThreadStore,
  threadIdFromSourceEvent,
  type NewOpenThread,
  type OpenThread,
  type OpenThreadChange,
  type OpenThreadQuery,
  type OpenThreadStatus,
  type TransitionOpenThreadOptions,
} from './open-threads.ts';
export { appliedMigrations, listMigrationFiles, migrate, type AppliedMigration, type MigrationFile } from './migrations.ts';
export {
  MEMORY_SOURCE_CONFIDENCE,
  MEMORY_SOURCE_TYPES,
  MemoryStore,
  RELATIONSHIP_ANSWER_WINDOW_MINUTES,
  type EpisodicKind,
  type EpisodicMemory,
  type MemoryQuery,
  type MemorySourceType,
  type NewEpisodicMemory,
  type NewRelationshipNote,
  type NewSemanticMemory,
  type RelationshipNote,
  type RelationshipSnapshot,
  type SemanticMemory,
} from './memory.ts';
export {
  DEFAULT_SELF_MODEL_SETTINGS,
  effectivePersonality,
  localDayOf,
  NEUTRAL_PROFILE_VALUE,
  parseSelfModelSettings,
  SELF_MODEL_SOURCES,
  SELF_MODEL_SOURCE_WEIGHTS,
  SelfModel,
  type LearnedDelta,
  type LearnedDeltaInput,
  type LearnedDeltaResult,
  type SelfModelSettings,
  type SelfModelSource,
  type SessionOverride,
  type SessionOverrideInput,
} from './self-model.ts';
export {
  clampPersonality,
  PERSONALITY_PROPERTIES,
  personalityProperty,
  type PersonalityProperty,
} from './personality.ts';
export {
  DEFAULT_DATA_DIR,
  DEFAULT_DB_FILE,
  DEFAULT_PRESENCE_TTL_SECONDS,
  openXixiStore,
  PRESENCE_KEY,
  XixiStore,
  type ReadEventsQuery,
  type RecordPresenceInput,
  type RecordTurnInput,
  type SelfProfileChange,
  type SelfProfileEntry,
  type SessionRecord,
  type SetWorldStateInput,
  type StoreOptions,
  type StoredEvent,
  type TurnAction,
  type TurnRecord,
  type TurnRole,
  type WorldState,
  type WorldStateEntry,
  type WorldStateQuery,
} from './store.ts';
