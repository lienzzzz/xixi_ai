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
  openXixiStore,
  XixiStore,
  type ReadEventsQuery,
  type RecordTurnInput,
  type SelfProfileChange,
  type SelfProfileEntry,
  type SessionRecord,
  type StoreOptions,
  type StoredEvent,
  type TurnAction,
  type TurnRecord,
  type TurnRole,
} from './store.ts';
