/**
 * `@xixi/domain` — Xixi's durable state: event log, sessions, personality
 * baseline. This is the only package that opens SQLite.
 */
export { type Clock, fixedClock, systemClock } from './clock.ts';
export { loadXixiConfig, parseXixiConfig, type XixiConfig } from './config.ts';
export { DomainError, type DomainErrorCode } from './errors.ts';
export { appliedMigrations, listMigrationFiles, migrate, type AppliedMigration, type MigrationFile } from './migrations.ts';
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
