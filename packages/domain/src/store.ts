import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  buildEvent,
  newSessionId,
  toOffsetIso,
  validateEvent,
  type Actor,
  type EventEnvelope,
  type JsonValue,
} from '@xixi/contracts';

import { type Clock, systemClock } from './clock.ts';
import { DomainError } from './errors.ts';
import { migrate, type AppliedMigration } from './migrations.ts';
import { clampPersonality, personalityProperty } from './personality.ts';

export const DEFAULT_DATA_DIR = 'data';
export const DEFAULT_DB_FILE = 'xixi.sqlite';

export interface StoreOptions {
  /** Directory holding the SQLite database. Created when missing. */
  readonly dataDir?: string;
  /** Override the database file entirely (used by tests for throwaway stores). */
  readonly dbPath?: string;
  readonly clock?: Clock;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly endedAt: string | null;
  readonly turnCount: number;
  /** Which brain provider currently serves this session (e.g. `dsh`), or null. */
  readonly brainProvider: string | null;
  /** That provider's own session id, so a swapped harness does not lose the thread. */
  readonly brainSessionId: string | null;
}

export type TurnRole = 'user' | 'assistant';
export type TurnAction = 'SPEAK' | 'BACKCHANNEL' | 'WAIT' | 'SILENCE' | 'TOOL';

export interface TurnRecord {
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly role: TurnRole;
  readonly action: TurnAction;
  readonly text: string | null;
  readonly toolName: string | null;
  readonly createdAt: string;
  readonly eventId: string;
}

export interface RecordTurnInput {
  readonly sessionId: string;
  readonly role: TurnRole;
  readonly action: TurnAction;
  readonly text?: string | null;
  readonly toolName?: string | null;
  readonly source?: string;
  readonly confidence?: number;
}

export interface StoredEvent extends EventEnvelope {
  readonly sequence: number;
}

export interface ReadEventsQuery {
  readonly limit?: number;
  readonly sinceSequence?: number;
  readonly type?: string;
  readonly sessionId?: string;
}

export interface SelfProfileEntry {
  readonly property: string;
  readonly value: number;
  readonly source: string;
  readonly updatedAt: string;
}

export interface SelfProfileChange {
  readonly changeId: string;
  readonly property: string;
  readonly beforeValue: number | null;
  readonly afterValue: number;
  readonly sourceType: string;
  readonly sourceEventId: string | null;
  readonly summary: string | null;
  readonly confidence: number;
  readonly createdAt: string;
}

interface EventRow {
  sequence: number;
  event_id: string;
  event_type: string;
  schema_version: number;
  timestamp: string;
  source: string;
  room: string | null;
  actor: string;
  confidence: number;
  correlation_id: string;
  session_id: string | null;
  payload_json: string;
}

interface SessionRow {
  session_id: string;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
  turn_count: number;
  brain_provider: string | null;
  brain_session_id: string | null;
}

interface ProfileRow {
  property: string;
  value: number;
  source: string;
  updated_at: string;
}

/**
 * The durable side of Xixi: one SQLite database, WAL mode, all writes in
 * transactions, and the event log as the single source of truth.
 *
 * Everything the brain needs to survive a restart lives here — session
 * identity, conversation turns and the effective personality baseline — so a
 * new process can pick up the same "西西" instead of starting over (§21.6).
 */
export class XixiStore {
  readonly dbPath: string;
  readonly clock: Clock;

  #db: DatabaseSync;
  #closed = false;

  constructor(options: StoreOptions = {}) {
    const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    if (options.dbPath === undefined) mkdirSync(dataDir, { recursive: true });
    this.dbPath = options.dbPath ?? join(dataDir, DEFAULT_DB_FILE);
    this.clock = options.clock ?? systemClock;
    this.#db = new DatabaseSync(this.dbPath);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#applied = migrate(this.#db, this.#now());
  }

  #applied: AppliedMigration[];

  /** Migrations applied by this process at open time (empty when already current). */
  get appliedMigrations(): readonly AppliedMigration[] {
    return this.#applied;
  }

  #now(): string {
    return toOffsetIso(this.clock());
  }

  #assertOpen(): void {
    if (this.#closed) throw new DomainError('MIGRATION_FAILED', 'store is closed');
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (cause) {
      this.#db.exec('ROLLBACK');
      throw cause;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  // ---------------------------------------------------------------- events

  /** Append a validated event and return its log position. */
  appendEvent(event: EventEnvelope): StoredEvent {
    this.#assertOpen();
    const validated = validateEvent(event);
    const sessionId = sessionIdOf(validated);
    try {
      const result = this.#db
        .prepare(
          `INSERT INTO events (
             event_id, event_type, schema_version, timestamp, source, room, actor,
             confidence, correlation_id, session_id, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validated.event_id,
          validated.event_type,
          validated.schema_version,
          validated.timestamp,
          validated.source,
          validated.room,
          validated.actor,
          validated.confidence,
          validated.correlation_id,
          sessionId,
          JSON.stringify(validated.payload),
        );
      return { ...validated, sequence: Number(result.lastInsertRowid) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes('UNIQUE') && message.includes('events.event_id')) {
        throw new DomainError('DUPLICATE_EVENT', `event ${validated.event_id} is already in the log`);
      }
      throw cause;
    }
  }

  readEvents(query: ReadEventsQuery = {}): StoredEvent[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.sinceSequence !== undefined) {
      clauses.push('sequence > ?');
      params.push(query.sinceSequence);
    }
    if (query.type !== undefined) {
      clauses.push('event_type = ?');
      params.push(query.type);
    }
    if (query.sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(query.sessionId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = query.limit ?? 100;
    const rows = this.#db
      .prepare(`SELECT * FROM events ${where} ORDER BY sequence ASC LIMIT ?`)
      .all(...params, limit) as unknown as EventRow[];
    return rows.map(toStoredEvent);
  }

  eventCount(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS count FROM events').get() as unknown as { count: number };
    return Number(row.count);
  }

  /** Convenience for §21/§22 health events. */
  recordHealth(service: string, status: 'ok' | 'degraded' | 'down', detail: string | null = null): StoredEvent {
    return this.appendEvent(
      buildEvent({
        event_type: 'system.health',
        source: service,
        actor: 'system',
        confidence: 1,
        payload: { service, status, detail },
        timestamp: this.#now(),
      }),
    );
  }

  // -------------------------------------------------------------- sessions

  createSession(): SessionRecord {
    this.#assertOpen();
    const now = this.#now();
    const sessionId = newSessionId();
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO conversation_sessions (
             session_id, schema_version, started_at, last_activity_at, ended_at, turn_count, brain_provider, brain_session_id
           ) VALUES (?, 1, ?, ?, NULL, 0, NULL, NULL)`,
        )
        .run(sessionId, now, now);
      return {
        sessionId,
        startedAt: now,
        lastActivityAt: now,
        endedAt: null,
        turnCount: 0,
        brainProvider: null,
        brainSessionId: null,
      };
    });
  }

  getSession(sessionId: string): SessionRecord {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM conversation_sessions WHERE session_id = ?').get(sessionId) as
      | unknown
      | undefined;
    if (row === undefined) {
      throw new DomainError('UNKNOWN_SESSION', `no session ${sessionId}`);
    }
    return toSession(row as SessionRow);
  }

  /** Most recently active session, or null when the store has never held one. */
  latestSession(): SessionRecord | null {
    this.#assertOpen();
    const row = this.#db
      .prepare('SELECT * FROM conversation_sessions ORDER BY last_activity_at DESC, rowid DESC LIMIT 1')
      .get() as unknown;
    return row === undefined ? null : toSession(row as SessionRow);
  }

  endSession(sessionId: string): SessionRecord {
    this.#assertOpen();
    const session = this.getSession(sessionId);
    if (session.endedAt !== null) throw new DomainError('SESSION_ALREADY_ENDED', `session ${sessionId} already ended`);
    const now = this.#now();
    this.#db.prepare('UPDATE conversation_sessions SET ended_at = ? WHERE session_id = ?').run(now, sessionId);
    return { ...session, endedAt: now };
  }

  /**
   * Remember which brain session serves this conversation.
   *
   * The mapping is keyed by provider, so replacing the harness (DSH → something
   * else) swaps the provider name and keeps the Xixi session — the relationship
   * survives (§3.2, §25, §44).
   */
  attachBrainSession(sessionId: string, provider: string, brainSessionId: string): SessionRecord {
    this.#assertOpen();
    const session = this.getSession(sessionId);
    if (session.endedAt !== null) {
      throw new DomainError('SESSION_ALREADY_ENDED', `session ${sessionId} already ended`);
    }
    this.#db
      .prepare(
        'UPDATE conversation_sessions SET brain_provider = ?, brain_session_id = ?, last_activity_at = ? WHERE session_id = ?',
      )
      .run(provider, brainSessionId, this.#now(), sessionId);
    return this.getSession(sessionId);
  }

  /** That provider's session id for this conversation, or null when another provider owns it. */
  brainSessionId(sessionId: string, provider: string): string | null {
    const session = this.getSession(sessionId);
    return session.brainProvider === provider ? session.brainSessionId : null;
  }

  /**
   * Record one turn of a conversation.
   *
   * The event append and the session projection happen in one transaction, so
   * the projection can never disagree with the log it is derived from.
   */
  recordTurn(input: RecordTurnInput): { event: StoredEvent; turn: TurnRecord } {
    this.#assertOpen();
    const session = this.getSession(input.sessionId);
    if (session.endedAt !== null) {
      throw new DomainError('SESSION_ALREADY_ENDED', `session ${input.sessionId} already ended`);
    }
    const at = this.#now();
    const turnIndex = session.turnCount;

    return this.#transaction(() => {
      const event = this.appendEvent(
        buildEvent({
          event_type: 'conversation.turn',
          source: input.source ?? 'brain',
          actor: input.role === 'user' ? 'father' : 'xixi',
          confidence: input.confidence ?? 1,
          timestamp: at,
          payload: {
            session_id: session.sessionId,
            turn_index: turnIndex,
            role: input.role,
            action: input.action,
            text: input.text ?? null,
            tool_name: input.toolName ?? null,
          },
        }),
      );
      this.#db
        .prepare('UPDATE conversation_sessions SET last_activity_at = ?, turn_count = ? WHERE session_id = ?')
        .run(at, turnIndex + 1, session.sessionId);
      return {
        event,
        turn: {
          sessionId: session.sessionId,
          turnIndex,
          role: input.role,
          action: input.action,
          text: input.text ?? null,
          toolName: input.toolName ?? null,
          createdAt: at,
          eventId: event.event_id,
        },
      };
    });
  }

  /** Turns in chronological order; the log is the source of truth, not a second table. */
  recentTurns(sessionId: string, limit = 4): TurnRecord[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare(
        `SELECT payload_json, timestamp, event_id FROM events
         WHERE event_type = 'conversation.turn' AND session_id = ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(sessionId, limit) as unknown as Array<{ payload_json: string; timestamp: string; event_id: string }>;
    return rows
      .map((row) => {
        const payload = JSON.parse(row.payload_json) as {
          session_id: string;
          turn_index: number;
          role: TurnRole;
          action: TurnAction;
          text: string | null;
          tool_name?: string | null;
        };
        return {
          sessionId: payload.session_id,
          turnIndex: payload.turn_index,
          role: payload.role,
          action: payload.action,
          text: payload.text,
          toolName: payload.tool_name ?? null,
          createdAt: row.timestamp,
          eventId: row.event_id,
        } satisfies TurnRecord;
      })
      .reverse();
  }

  /**
   * Everything a fresh process needs to continue the same relationship:
   * the session, its recent turns and the effective personality.
   */
  resume(sessionId?: string): { session: SessionRecord; turns: TurnRecord[]; personality: Record<string, number> } {
    const session = sessionId === undefined ? this.latestSession() : this.getSession(sessionId);
    if (session === null) {
      throw new DomainError('UNKNOWN_SESSION', 'store holds no session to resume');
    }
    return { session, turns: this.recentTurns(session.sessionId, 8), personality: this.selfProfile() };
  }

  // ---------------------------------------------------------- self profile

  /**
   * Seed the personality baseline once per property. Existing values are never
   * overwritten, which is what makes a restart restore rather than reset.
   * Records a history row per seeded property (§7.5).
   */
  seedSelfProfile(values: Record<string, number>, source = 'config:base'): SelfProfileEntry[] {
    this.#assertOpen();
    const now = this.#now();
    this.#transaction(() => {
      const insertValue = this.#db.prepare(
        `INSERT INTO self_profile (property, schema_version, value, source, updated_at)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(property) DO NOTHING`,
      );
      const insertHistory = this.#db.prepare(
        `INSERT INTO self_profile_history (
           change_id, schema_version, property, before_value, after_value, source_type,
           source_event_id, summary, confidence, created_at
         ) VALUES (?, 1, ?, NULL, ?, ?, NULL, ?, 1, ?)`,
      );
      for (const [property, rawValue] of Object.entries(values)) {
        const definition = personalityProperty(property);
        if (definition === undefined) {
          throw new DomainError('UNKNOWN_PERSONALITY_PROPERTY', `"${property}" is not a self-model property`);
        }
        if (!Number.isFinite(rawValue) || rawValue < definition.min || rawValue > definition.max) {
          throw new DomainError(
            'PROPERTY_OUT_OF_RANGE',
            `"${property}" must be within [${definition.min}, ${definition.max}]`,
            String(rawValue),
          );
        }
        const inserted = insertValue.run(property, clampPersonality(property, rawValue), source, now);
        if (Number(inserted.changes) > 0) {
          insertHistory.run(
            `selfchg_${randomUUID()}`,
            property,
            clampPersonality(property, rawValue),
            source,
            `基线值来自 ${source}`,
            now,
          );
        }
      }
    });
    return this.selfProfileEntries();
  }

  /**
   * Administrative override of the personality baseline (config, CLI, an
   * experiment), with a history row per changed property.
   *
   * This is deliberately not the M3 learning engine: nothing here interprets
   * user feedback, computes a delta, or enforces the per-source limits from
   * 《方案》§7.4. Model-driven adjustment does not exist yet, and this method is the
   * seam it will be built on rather than a substitute for it.
   */
  overrideSelfProfile(values: Record<string, number>, reason = 'admin:override'): SelfProfileEntry[] {
    this.#assertOpen();
    const now = this.#now();
    this.#transaction(() => {
      const read = this.#db.prepare('SELECT value FROM self_profile WHERE property = ?');
      const write = this.#db.prepare(
        `INSERT INTO self_profile (property, schema_version, value, source, updated_at)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(property) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`,
      );
      const history = this.#db.prepare(
        `INSERT INTO self_profile_history (
           change_id, schema_version, property, before_value, after_value, source_type,
           source_event_id, summary, confidence, created_at
         ) VALUES (?, 1, ?, ?, ?, ?, NULL, ?, 1, ?)`,
      );
      for (const [property, rawValue] of Object.entries(values)) {
        const definition = personalityProperty(property);
        if (definition === undefined) {
          throw new DomainError('UNKNOWN_PERSONALITY_PROPERTY', `"${property}" is not a self-model property`);
        }
        if (!Number.isFinite(rawValue) || rawValue < definition.min || rawValue > definition.max) {
          throw new DomainError(
            'PROPERTY_OUT_OF_RANGE',
            `"${property}" must be within [${definition.min}, ${definition.max}]`,
            String(rawValue),
          );
        }
        const before = (read.get(property) as { value: number } | undefined)?.value ?? null;
        const after = clampPersonality(property, rawValue);
        write.run(property, after, reason, now);
        history.run(`selfchg_${randomUUID()}`, property, before, after, reason, reason, now);
      }
    });
    return this.selfProfileEntries();
  }

  selfProfile(): Record<string, number> {
    this.#assertOpen();
    const rows = this.#db.prepare('SELECT property, value FROM self_profile ORDER BY property').all() as unknown as Array<{
      property: string;
      value: number;
    }>;
    return Object.fromEntries(rows.map((row) => [row.property, row.value]));
  }

  selfProfileEntries(): SelfProfileEntry[] {
    this.#assertOpen();
    const rows = this.#db.prepare('SELECT * FROM self_profile ORDER BY property').all() as unknown as ProfileRow[];
    return rows.map((row) => ({
      property: row.property,
      value: row.value,
      source: row.source,
      updatedAt: row.updated_at,
    }));
  }

  selfProfileHistory(property?: string): SelfProfileChange[] {
    this.#assertOpen();
    const rows = (
      property === undefined
        ? this.#db.prepare('SELECT * FROM self_profile_history ORDER BY created_at ASC, rowid ASC').all()
        : this.#db.prepare('SELECT * FROM self_profile_history WHERE property = ? ORDER BY created_at ASC, rowid ASC').all(property)
    ) as unknown as Array<{
      change_id: string;
      property: string;
      before_value: number | null;
      after_value: number;
      source_type: string;
      source_event_id: string | null;
      summary: string | null;
      confidence: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      changeId: row.change_id,
      property: row.property,
      beforeValue: row.before_value,
      afterValue: row.after_value,
      sourceType: row.source_type,
      sourceEventId: row.source_event_id,
      summary: row.summary,
      confidence: row.confidence,
      createdAt: row.created_at,
    }));
  }
}

function sessionIdOf(event: EventEnvelope): string | null {
  const payload = event.payload as JsonValue;
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const candidate = (payload as Record<string, JsonValue>).session_id;
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    sequence: row.sequence,
    schema: 'xixi.event.v1',
    schema_version: row.schema_version,
    event_id: row.event_id,
    event_type: row.event_type,
    timestamp: row.timestamp,
    source: row.source,
    room: row.room,
    actor: row.actor as Actor,
    confidence: row.confidence,
    correlation_id: row.correlation_id,
    payload: JSON.parse(row.payload_json) as JsonValue,
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    endedAt: row.ended_at,
    turnCount: row.turn_count,
    brainProvider: row.brain_provider,
    brainSessionId: row.brain_session_id,
  };
}

/** Open (and migrate) the store. Migrations run before the instance escapes. */
export function openXixiStore(options: StoreOptions = {}): XixiStore {
  return new XixiStore(options);
}
