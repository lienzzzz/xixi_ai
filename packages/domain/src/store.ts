import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
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
import {
  MEMORY_STATUSES,
  type EpisodicMemory,
  type MemoryQuery,
  type MemoryStatus,
  type NewEpisodicMemory,
  type NewRelationshipNote,
  type NewSemanticMemory,
  type RelationshipNote,
  type SemanticMemory,
} from './memory.ts';
import { migrate, type AppliedMigration } from './migrations.ts';
import {
  OPEN_THREAD_SETTLED_STATUSES,
  type NewOpenThread,
  type OpenThread,
  type OpenThreadChange,
  type OpenThreadQuery,
  type OpenThreadStatus,
  type TransitionOpenThreadOptions,
} from './open-threads.ts';
import { clampPersonality, personalityProperty } from './personality.ts';
import {
  clampMood,
  clampMoodValue,
  MOOD_SIGNAL_CODES,
  NEUTRAL_MOOD,
  type MoodSignalCode,
  type MoodState,
} from './mood.ts';
import {
  effectivePersonality,
  localDayOf,
  type LearnedDelta,
  type SessionOverride,
} from './self-model.ts';

export const DEFAULT_DATA_DIR = 'data';
export const DEFAULT_DB_FILE = 'xixi.sqlite';

/**
 * The household's canonical store directory (V0.3 P0-B, pack `04_RUNTIME_CONSOLIDATION.md` §2).
 *
 * Before this, each live entry opened its own SQLite file (`data/chat`, `data/web-chat`,
 * `data/voice`, `data/field-test`) and the perception edge wrote a fifth one (`data/`) — so
 * 「在 chat 里设的人格不会带到控制台」 was true, and being a long-lived companion (one identity, one
 * history) was not. `data/xixi` is where they all point by default now.
 *
 * The name is deliberately a **new** directory: `data/xixi.sqlite` already exists on this machine
 * from the M6 camera line, and a canonical store must not adopt (or overwrite) a file whose schema
 * history it did not create.
 */
export const CANONICAL_DATA_DIR = 'data/xixi';

/** Environment variable that overrides {@link CANONICAL_DATA_DIR} for every household entry. */
export const CANONICAL_DATA_DIR_ENV = 'XIXI_DATA_DIR';

/** True when a path may be handed to `openXixiStore` as-is (absolute, or a drive-relative Windows path). */
function isAbsolutePath(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(path);
}

/**
 * Resolve the canonical store directory for a household entry point.
 *
 * Precedence, and why:
 *
 *   1. `options`/`--data-dir` — an explicit instruction (the console's `--data-dir`, a test's
 *      temp directory). Nothing may override it.
 *   2. `XIXI_DATA_DIR` — the household-wide override, so one variable moves every entry at once.
 *   3. `legacyEnv` (e.g. `XIXI_CHAT_DATA_DIR` / `XIXI_WEB_DATA_DIR`) — the per-entry seam that
 *      existed before P0-B. Kept **above** the default so a test that sets only its own variable
 *      still gets its own store, and below `XIXI_DATA_DIR` so the household switch wins when both
 *      are set (that is what "canonical" has to mean).
 *   4. `CANONICAL_DATA_DIR` (relative paths resolved against `cwd`, i.e. the repository root when
 *      scripts are started from there).
 */
export function resolveCanonicalDataDir(options: {
  readonly dataDir?: string | undefined;
  readonly legacyEnv?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> | undefined;
  readonly cwd?: string | undefined;
} = {}): string {
  const env = options.env ?? process.env;
  const explicit = options.dataDir;
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
  const household = env[CANONICAL_DATA_DIR_ENV];
  if (typeof household === 'string' && household.trim().length > 0) {
    const value = household.trim();
    return isAbsolutePath(value) ? value : join(options.cwd ?? process.cwd(), value);
  }
  const legacy = options.legacyEnv === undefined ? undefined : env[options.legacyEnv];
  if (typeof legacy === 'string' && legacy.trim().length > 0) {
    const value = legacy.trim();
    return isAbsolutePath(value) ? value : join(options.cwd ?? process.cwd(), value);
  }
  /**
   * Under the test runner, "the default store" must never be the one in the repository.
   *
   * A test that imports a live entry module (`scripts/serve-chat.ts` builds its store at import time)
   * would otherwise create and write `data/xixi` — the household database — from `npm test`. Node's
   * test runner sets `NODE_TEST_CONTEXT`, so that is the signal: fall back to a per-process temp
   * directory instead. Nothing to configure, and production is untouched (the variable is not set
   * for `npm run chat` / `web` / `field-test`).
   */
  if (env['NODE_TEST_CONTEXT'] !== undefined || env['NODE_ENV'] === 'test') {
    return join(tmpdir(), `xixi-test-store-${process.pid}`, CANONICAL_DATA_DIR);
  }
  return join(options.cwd ?? process.cwd(), CANONICAL_DATA_DIR);
}

/**
 * Which entry points share the canonical store, and what each one may still use instead.
 *
 * Exported so the pages print the **same** table the code follows (V0.3 P0-B), instead of a
 * hard-coded list in `scripts/field-test.ts` drifting from the wiring.
 */
export const CANONICAL_STORE_ENTRIES: readonly {
  readonly entry: string;
  readonly command: string;
  readonly dir: string;
  readonly legacyEnv: string | null;
  /** True when this entry is pure measurement and may be pointed at an isolated store by a flag. */
  readonly measurement?: boolean;
}[] = Object.freeze([
  { entry: '终端对话', command: 'npm run chat', dir: CANONICAL_DATA_DIR, legacyEnv: 'XIXI_CHAT_DATA_DIR' },
  { entry: '试用页', command: 'npm run web', dir: CANONICAL_DATA_DIR, legacyEnv: 'XIXI_WEB_DATA_DIR' },
  { entry: '现场测试控制台', command: 'npm run field-test', dir: CANONICAL_DATA_DIR, legacyEnv: null },
  { entry: '语音闭环（测量）', command: 'npm run voice:turn -- --wav <file> [--isolated-store]', dir: CANONICAL_DATA_DIR, legacyEnv: 'XIXI_VOICE_DATA_DIR', measurement: true },
]);

/**
 * WorldState key for "is somebody at home". One key for M6; the table is not specialised
 * for it, so `living_room` / `quiet_hours` style keys can join later without a migration.
 */
export const PRESENCE_KEY = 'presence.home';

/**
 * How long a presence reading counts as "now" before it must be treated as unknown (§5.3).
 *
 * 60 s is chosen against the producer: `services/perception-edge` writes a row on every
 * transition and the verify script keeps refreshing while it runs, so a healthy, running
 * loop always produces a value well inside this window. If the loop died, 60 s later the
 * reading is `stale` and consumers must say "unknown" rather than reuse an old "someone is
 * here" — the failure mode §5.3 exists to prevent.
 */
export const DEFAULT_PRESENCE_TTL_SECONDS = 60;

export interface StoreOptions {
  /** Directory holding the SQLite database. Created when missing. */
  readonly dataDir?: string;
  /** Override the database file entirely (used by tests for throwaway stores). */
  readonly dbPath?: string;
  readonly clock?: Clock;
  /**
   * UTC offset (minutes east) used when **writing** timestamps (V0.3 P0-D, repair round 2).
   *
   * Default: this machine's offset at the moment of the write — right for a live household entry,
   * whose log is about the machine it runs on. A **replay** passes the fixture's own offset instead,
   * so a replayed artefact does not depend on where it was replayed: without this, the same script
   * produced `+08:00` timestamps here and `+00:00` timestamps on a UTC machine, which made the
   * replay a different document per host (and made "the window is judged in +08:00" untrue).
   *
   * Only the *rendering* changes: sorting, comparison and expiry all go through `Date.parse`, which
   * reads the offset, so the instant is never shifted.
   */
  readonly offsetMinutes?: number;
}

/** One row of the `world_state` projection, as stored. */
export interface WorldStateEntry {
  readonly key: string;
  readonly value: string | null;
  readonly source: string;
  readonly updatedAt: string;
  readonly confidence: number;
  readonly ttlSeconds: number;
}

export interface WorldStateQuery {
  /**
   * Override "now" (tests, replays). Defaults to the store clock.
   *
   * **Give it an ISO-8601 string with milliseconds and an explicit offset** — the same shape the
   * row's `updatedAt` / `staleAfter` use. Do **not** pass a `Date`: `stale` is computed as
   * `Date.parse(now) >= Date.parse(staleAfter)`, and a `Date` reaches `Date.parse` through
   * `Date#toString`, which **drops the milliseconds**. Measured on this machine (t102) that shifted
   * a boundary by 410 ms; the loss is anywhere in 0–999 ms depending on the moment, e.g.
   * `node -e "const d=new Date(); console.log(Date.parse(d.toString())-d.getTime())"` prints a
   * negative number (−576 when this comment was written). A store-level boundary test must inject a
   * **string**: take the row's own `staleAfter` (same string → `stale === true`, the boundary case)
   * and/or 1 ms before it, never a `Date` or a `toISOString()`-less form.
   */
  readonly now?: string;
}

/** A projection row plus the derived staleness verdict and the presence shortcut. */
export interface WorldState extends WorldStateEntry {
  readonly stale: boolean;
  /** `updatedAt + ttlSeconds`, pre-computed so callers do not redo the arithmetic. */
  readonly staleAfter: string;
  /** Present only for `presence.home`; `null` for other keys. */
  readonly present: boolean | null;
  /** What the same key said before this write (only set by `recordPresenceChanged`). */
  readonly previousState?: string | null;
}

export interface SetWorldStateInput {
  readonly key: string;
  readonly value: string | null;
  readonly source: string;
  readonly confidence: number;
  readonly ttlSeconds?: number;
  readonly timestamp?: string;
}

export interface RecordPresenceInput {
  readonly present: boolean;
  readonly source?: string;
  readonly confidence?: number;
  /** Envelope `source_detail`; the detector puts its evidence summary here (≤200 chars). */
  readonly sourceDetail?: string | null;
  readonly room?: string | null;
  readonly actor?: Actor;
  readonly timestamp?: string;
  readonly ttlSeconds?: number;
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

/** `mood_state` 的唯一键：心情是「现在」的一个点，所以只有一行（005_mood.sql）。 */
export const MOOD_STATE_KEY = 'mood.now';

/**
 * 存下来的心情（`mood_state` 一行）。
 *
 * `evidence` 是**累计**的信号次数 —— 它让面板回答「她为什么是这个心情」，也让审计不必回读整份日志。
 * 数值本身有硬边界（`mood.ts` 的 `clampMoodValue` 是唯一写入路径），读回来时再夹一次，
 * 所以「库里存了一个越界值」这种状态不会传到消费方。
 */
export interface StoredMood {
  readonly valence: number;
  readonly energy: number;
  readonly evidence: Readonly<Partial<Record<string, number>>>;
  readonly lastBeatAt: string | null;
  /**
   * 已经吸收到哪一条事件（`events.sequence`）。
   *
   * 为什么时间戳不够：`respond()` 先把这一轮落库、再评估心情，两者可能是**同一个时刻**，
   * 于是「严格晚于上次评估」这个条件会把这一轮排除掉（夸奖要到下一拍才算）。而放宽成「不早于」
   * 又会让同一拍被重复吸收。**序号**是唯一能同时满足「不漏」与「不重」的游标。
   */
  readonly lastEventSequence: number;
  readonly source: string;
  readonly summary: string;
  readonly updatedAt: string;
}

export interface MoodSnapshot {
  /** 此刻事件日志的最大序号（调用方可以吸收到这儿为止）。 */
  readonly cursorSequence: number;
  readonly mood: StoredMood | null;
  /** 最近若干条变更，老的在前。 */
  readonly history: readonly MoodChange[];
}

export interface RecordMoodInput {
  readonly state: MoodState;
  readonly previous: MoodState | null;
  /** 程序标识符：`mood:praised` / `mood:reset` / `mood:quiet`。 */
  readonly source: string;
  /** 渲染好的中文摘要（面板显示它，不显示 code）。 */
  readonly summary: string;
  /** 本拍用到的信号次数（code → 次数）。 */
  readonly signals: Readonly<Partial<Record<string, number>>>;
  readonly signalCount: number;
  readonly droppedCount?: number;
  /** 这一次是不是复位；复位也写历史，否则「她为什么突然平静了」没有答案。 */
  readonly reset?: boolean;
  readonly evidence: Readonly<Partial<Record<string, number>>>;
  /** 本拍读到的事件序号上界（下一次评估从它之后开始）。省略 = 保持原值。 */
  readonly cursorSequence?: number;
  readonly at?: string;
}

export interface MoodChange {
  readonly changeId: string;
  readonly before: MoodState;
  readonly after: MoodState;
  readonly delta: MoodState;
  readonly reset: boolean;
  readonly signals: Readonly<Partial<Record<string, number>>>;
  readonly signalCount: number;
  readonly droppedCount: number;
  readonly note: string;
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

interface WorldStateRow {
  key: string;
  value: string | null;
  source: string;
  updated_at: string;
  confidence: number;
  ttl_seconds: number;
}

interface MoodStateRow {
  key: string;
  schema_version: number;
  valence: number;
  energy: number;
  evidence_json: string;
  last_beat_at: string | null;
  cursor_json: string;
  source: string;
  summary: string;
  updated_at: string;
}

interface MoodHistoryRow {
  change_id: string;
  before_valence: number;
  before_energy: number;
  after_valence: number;
  after_energy: number;
  delta_valence: number;
  delta_energy: number;
  reset: number;
  signals_json: string;
  signal_count: number;
  dropped_count: number;
  note: string;
  created_at: string;
}

interface OpenThreadRow {
  thread_id: string;
  summary: string;
  subject: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  follow_after: string | null;
  expire_at: string | null;
  follow_up_hint: string | null;
  importance: number;
  attempts: number;
  last_offered_at: string | null;
  source_event_id: string | null;
  note: string | null;
}

interface EpisodicMemoryRow {
  memory_id: string;
  occurred_at: string;
  summary: string;
  kind: string;
  source_type: string;
  source_event_id: string | null;
  session_id: string | null;
  importance: number;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface SemanticMemoryRow {
  memory_id: string;
  property: string;
  statement: string;
  source_type: string;
  source_event_id: string | null;
  confidence: number;
  /** 006_memory_status.sql 加的三列（老库里的行由迁移的 DEFAULT 填成 active）。 */
  status: string;
  superseded_by: string | null;
  status_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RelationshipNoteRow {
  note_id: string;
  aspect: string;
  note: string;
  source_type: string;
  source_event_id: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface LearnedDeltaRow {
  property: string;
  delta: number;
  source_type: string;
  evidence: string | null;
  confidence: number;
  updated_at: string;
}

interface SessionOverrideRow {
  override_id: string;
  session_id: string | null;
  property: string;
  delta: number;
  reason: string;
  source_type: string;
  valid_day: string;
  created_at: string;
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
  /** UTC offset (minutes east) used to render timestamps; `null` = this machine, per write. */
  readonly #writeOffsetMinutes: number | null;

  constructor(options: StoreOptions = {}) {
    const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    // `null` = render each write in this machine's offset (the live case); a number = the caller's
    // zone (the replay case) — see `StoreOptions.offsetMinutes`.
    this.#writeOffsetMinutes = options.offsetMinutes ?? null;
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
    const at = this.clock();
    return this.#writeOffsetMinutes === null ? toOffsetIso(at) : toOffsetIso(at, this.#writeOffsetMinutes);
  }

  #assertOpen(): void {
    if (this.#closed) throw new DomainError('MIGRATION_FAILED', 'store is closed');
  }

  /**
   * 库还开着吗（`close()` 之后为 false）。
   *
   * 给「一轮提取里某一步失败」与「整轮都写不进去」分层用（preflight ③）：退出兜底要把后者
   * 记成丢掉的一轮，而它不是任何**一步**的错。
   */
  get isOpen(): boolean {
    return !this.#closed;
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

  /**
   * 基础层（`self_profile` 原始行）：配置种子与管理员覆盖的结果。
   *
   * 这是三层里的**第一层**；要「她现在实际上按什么来说话」请用 {@link selfProfile}。
   */
  baseProfile(): Record<string, number> {
    this.#assertOpen();
    const rows = this.#db.prepare('SELECT property, value FROM self_profile ORDER BY property').all() as unknown as Array<{
      property: string;
      value: number;
    }>;
    return Object.fromEntries(rows.map((row) => [row.property, row.value]));
  }

  /**
   * **有效人格**：基础 + 学习 + 当天会话覆盖（《方案》§13）。
   *
   * 所有消费方（提示词、FSM 窗口、主动引擎的 `base_proactivity`、控制台面板）读的都是这一个方法，
   * 所以「父亲说了一句『你话太多了』」不需要在四个地方各接一次线。三层都空时它与 `baseProfile()`
   * 逐字相同（旧行为不变）。
   */
  selfProfile(query: { readonly now?: Date } = {}): Record<string, number> {
    this.#assertOpen();
    const at = query.now ?? this.clock();
    return effectivePersonality(this.baseProfile(), this.learnedDeltas(), this.sessionOverrides({ day: localDayOf(at) }));
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

  selfProfileHistory(property?: string): SelfProfileChange[] {    this.#assertOpen();
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

  // ------------------------------------------------------------ world state (§5.3)

  /**
   * Write one row of the current-state projection.
   *
   * This table answers "what is true now"; it is not a history. Callers that have a durable
   * fact (a sensor transition, a decision) must append an event too — see
   * `recordPresenceChanged`, which does both in one transaction.
   */
  setWorldState(input: SetWorldStateInput): WorldStateEntry {
    this.#assertOpen();
    if (input.key.trim().length === 0) {
      throw new DomainError('INVALID_WORLD_STATE', 'world state key must not be empty');
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new DomainError('INVALID_WORLD_STATE', `confidence ${input.confidence} is outside [0,1]`, input.key);
    }
    const ttl = input.ttlSeconds ?? DEFAULT_PRESENCE_TTL_SECONDS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new DomainError('INVALID_WORLD_STATE', `ttlSeconds ${ttl} must be > 0`, input.key);
    }
    const at = input.timestamp ?? this.#now();
    this.#db
      .prepare(
        `INSERT INTO world_state (key, schema_version, value, source, updated_at, confidence, ttl_seconds)
         VALUES (?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           source = excluded.source,
           updated_at = excluded.updated_at,
           confidence = excluded.confidence,
           ttl_seconds = excluded.ttl_seconds`,
      )
      .run(input.key, input.value, input.source, at, input.confidence, ttl);
    return {
      key: input.key,
      value: input.value,
      source: input.source,
      updatedAt: at,
      confidence: input.confidence,
      ttlSeconds: ttl,
    };
  }

  /** Read the projection; `stale` is computed against the store clock unless overridden. */
  worldState(key: string, query: WorldStateQuery = {}): WorldState | null {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM world_state WHERE key = ?').get(key) as unknown;
    if (row === undefined) return null;
    const stored = toWorldStateEntry(row as WorldStateRow);
    // `query.now` must be a string: a `Date` here loses its milliseconds on the way into
    // `Date.parse` (see `WorldStateQuery.now`), which silently moves this boundary.
    const now = query.now ?? this.#now();
    const staleAfter = addSecondsToIso(stored.updatedAt, stored.ttlSeconds, this.#writeOffsetMinutes);
    return {
      ...stored,
      stale: Date.parse(now) >= Date.parse(staleAfter),
      staleAfter,
      present: key === PRESENCE_KEY ? stored.value === 'present' : null,
    };
  }

  /** Every projection row, ordered by key (WorldState-lite is one row today, not forever). */
  worldStateEntries(query: WorldStateQuery = {}): WorldState[] {
    this.#assertOpen();
    const rows = this.#db.prepare('SELECT * FROM world_state ORDER BY key').all() as unknown as WorldStateRow[];
    return rows.map((row) => {
      const entry = toWorldStateEntry(row);
      // Same rule as `worldState()` above: the override is a string, not a `Date`.
      const now = query.now ?? this.#now();
      const staleAfter = addSecondsToIso(entry.updatedAt, entry.ttlSeconds, this.#writeOffsetMinutes);
      return {
        ...entry,
        stale: Date.parse(now) >= Date.parse(staleAfter),
        staleAfter,
        present: entry.key === PRESENCE_KEY ? entry.value === 'present' : null,
      };
    });
  }

  // ------------------------------------------------------------------ mood (005)

  /**
   * The current mood, or `null` when nothing has ever moved it (a fresh database).
   *
   * Both dimensions are **clamped on read** as well as on write: a row that was written by an older
   * build (or edited by hand) must never be able to hand a consumer a value outside `[0,1]`.
   * `staleHours` is not stored — it is derived from `lastBeatAt` by the caller, which owns the clock.
   */
  mood(): StoredMood | null {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM mood_state WHERE key = ?').get(MOOD_STATE_KEY) as unknown;
    if (row === undefined) return null;
    return toStoredMood(row as MoodStateRow);
  }

  /**
   * 冷静地看一眼心情：**一个事务里**读三样东西，而且不写任何一行。
   *
   * 为什么需要它（实测换来的）：`ConversationEngine.respond()` 先把这一轮落库、再组装提示词并评估心情，
   * 两者常常是**同一个时刻**。若「读到哪一条事件」与「读到哪儿为止」分两次读，就可能出现
   * 「事件在这两次读之间落库、但游标已经前进」的窗口 —— 那一轮就被永久跳过了（本机实测：夸奖
   * 在 `respond()` 里第一次评估时被漏掉，要等到下一拍才算）。一个只读快照把这两件事绑在一起：
   *   * `cursorSequence` 是此刻事件日志的最大序号（下一个该被吸收的位置）；
   *   * `mood` / `moodHistory` 是同一瞬间的行。
   * 心情与日志的一致性因此不依赖「两次读之间没人写」，而是由**单次读**保证。
   */
  moodSnapshot(options: { readonly historyLimit?: number } = {}): MoodSnapshot {
    this.#assertOpen();
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT MAX(sequence) AS last FROM events').get() as unknown as { last: number | null };
      const historyLimit = Math.max(1, Math.floor(options.historyLimit ?? 20));
      const historyRows = this.#db
        .prepare('SELECT * FROM mood_history ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(historyLimit) as unknown as MoodHistoryRow[];
      const moodRow = this.#db.prepare('SELECT * FROM mood_state WHERE key = ?').get(MOOD_STATE_KEY) as unknown;
      return {
        cursorSequence: Number(row.last ?? 0),
        mood: moodRow === undefined ? null : toStoredMood(moodRow as MoodStateRow),
        history: historyRows.map(toMoodChange).reverse(),
      };
    });
  }

  /**
   * Persist one mood beat: the current row plus — only when it actually changed — one history row.
   *
   * Why "only when it changed": the breaker loop beats every tick, so writing a history row per beat
   * would bury the answer to "why is she low today" under hundreds of identical rows. A beat that
   * changes nothing is not an event worth keeping; the current row still gets its `lastBeatAt`
   * advanced, because that timestamp is what the next decay is computed from.
   *
   * Timestamps are written with the **local** offset (`toOffsetIso`, the repo's convention, see
   * `domain-model.md` §4.1), not `Date#toISOString()`: everything that compares them
   * (`worldState`, `moodHistory`, the engine's "since the last beat" window) goes through
   * `Date.parse`, and a UTC stamp mixed with local ones shifts every boundary by the offset —
   * measured as an 8-hour error on this machine, which silently dropped same-evening events.
   *
   * preflight ④: the caller's `at` goes through {@link moodInstant} **here**, in the one write
   * funnel, so a `Z`-shaped string cannot introduce a second spelling. `mood_history` is ordered by
   * the *string* `created_at`, and two spellings of the same instant compare in the wrong order
   * (`…T14:00:00.000Z` < `…T21:00:00.000+08:00` even though it is an hour later) — that is exactly
   * how the fifth round's verification made `moodHistory()` report a stale row as the newest one.
   */
  recordMood(input: RecordMoodInput): StoredMood {
    this.#assertOpen();
    const at = input.at === undefined ? this.#now() : moodInstant(input.at);
    const next = clampMood(input.state);
    const before = input.previous === null ? null : clampMood(input.previous);
    const changed =
      before === null ||
      input.reset === true ||
      Math.abs(before.valence - next.valence) > 1e-9 ||
      Math.abs(before.energy - next.energy) > 1e-9;

    this.#transaction(() => {
      const current = this.#db.prepare('SELECT cursor_json FROM mood_state WHERE key = ?').get(MOOD_STATE_KEY) as unknown as
        | { cursor_json: string }
        | undefined;
      const cursor = input.cursorSequence ?? (current === undefined ? 0 : parseCursor(current.cursor_json));
      this.#db
        .prepare(
          `INSERT INTO mood_state (
             key, schema_version, valence, energy, evidence_json, last_beat_at, cursor_json, source, summary, updated_at
           )
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             valence = excluded.valence,
             energy = excluded.energy,
             evidence_json = excluded.evidence_json,
             last_beat_at = excluded.last_beat_at,
             cursor_json = excluded.cursor_json,
             source = excluded.source,
             summary = excluded.summary,
             updated_at = excluded.updated_at`,
        )
        .run(
          MOOD_STATE_KEY,
          next.valence,
          next.energy,
          JSON.stringify(input.evidence),
          at,
          JSON.stringify({ sequence: cursor }),
          input.source,
          input.summary,
          at,
        );

      if (!changed) return;
      const from = before ?? next;
      this.#db
        .prepare(
          `INSERT INTO mood_history (
             change_id, schema_version, before_valence, before_energy, after_valence, after_energy,
             delta_valence, delta_energy, reset, signals_json, signal_count, dropped_count, note, created_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `moodchg_${randomUUID()}`,
          from.valence,
          from.energy,
          next.valence,
          next.energy,
          next.valence - from.valence,
          next.energy - from.energy,
          input.reset === true ? 1 : 0,
          JSON.stringify(input.signals),
          input.signalCount,
          input.droppedCount ?? 0,
          input.summary,
          at,
        );
    });

    const stored = this.mood();
    if (stored === null) throw new DomainError('MIGRATION_FAILED', 'mood_state row missing after write');
    return stored;
  }

  /**
   * 心情历史（最近 N 条，老的在后）：可查看、可回滚的凭据。
   *
   * It is a **change log**, not a time series: a quiet hour produces no row at all. Pair it with the
   * event log when the question is "what happened", and with this table when the question is
   * "how did she take it".
   */
  moodHistory(limit = 20): MoodChange[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare('SELECT * FROM mood_history ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(Math.max(1, Math.floor(limit))) as unknown as MoodHistoryRow[];
    return rows.map(toMoodChange).reverse();
  }

  /**
   * 复位（可回滚的一侧）：回到中性，并**留一行历史**说明是谁按的。
   *
   * Deliberately not "delete the row": a reset is an event in her short-term state's life, and the
   * question "why did she suddenly sound neutral again" must have an answer in the data.
   */
  resetMood(reason = 'admin:reset', at?: string): StoredMood {
    this.#assertOpen();
    const current = this.mood();
    const before: MoodState = current === null ? NEUTRAL_MOOD : { valence: current.valence, energy: current.energy };
    return this.recordMood({
      state: NEUTRAL_MOOD,
      previous: before,
      source: 'mood:reset',
      summary: `心情复位：${reason}`,
      signals: {},
      signalCount: 0,
      reset: true,
      // A reset is not evidence: the counts that explained the old mood are dropped on purpose.
      evidence: {},
      ...(at === undefined ? {} : { at }),
    });
  }

  /** `mood_state` 的 schema 版本（铁律 10：持久记录都带版本，读取方可以核对）。 */
  moodSchemaVersion(): number {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT schema_version FROM mood_state WHERE key = ?').get(MOOD_STATE_KEY) as unknown as
      | { schema_version: number }
      | undefined;
    return row?.schema_version ?? 0;
  }

  /**
   * Record a presence transition: **one transaction**, event log + projection.
   *
   * The log is the source of truth and the projection is rebuildable, so they must not be
   * allowed to disagree — which is why this is a single method rather than two calls the
   * caller has to remember to pair up (same reasoning as `recordTurn`).
   */
  recordPresenceChanged(input: RecordPresenceInput): { event: StoredEvent; state: WorldState } {
    this.#assertOpen();
    const at = input.timestamp ?? this.#now();
    const previous = this.worldState(PRESENCE_KEY, { now: at });
    const previousState = previous === null ? null : previous.present ? 'present' : 'absent';
    const nextState = input.present ? 'present' : 'absent';
    const source = input.source ?? 'perception';
    const confidence = input.confidence ?? 1;
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_PRESENCE_TTL_SECONDS;

    const event = buildEvent({
      event_type: 'presence.changed',
      source,
      actor: input.actor ?? 'father',
      room: input.room ?? null,
      confidence,
      timestamp: at,
      payload: {
        present: input.present,
        source_detail: input.sourceDetail ?? null,
      },
    });

    const stored = this.#transaction(() => {
      const appended = this.appendEvent(event);
      this.setWorldState({
        key: PRESENCE_KEY,
        value: nextState,
        source,
        confidence,
        ttlSeconds,
        timestamp: at,
      });
      return appended;
    });

    const state = this.worldState(PRESENCE_KEY, { now: at });
    if (state === null) {
      throw new DomainError('INVALID_WORLD_STATE', 'presence projection vanished right after being written');
    }
    return { event: stored, state: { ...state, previousState } };
  }

  /**
   * Append a `presence.changed` envelope that came from **outside** this process (V0.3 P0-B).
   *
   * Why this exists next to {@link recordPresenceChanged}: the perception edge detects the
   * transition but must not be the writer — `services/perception-edge` used to open the same SQLite
   * file and `INSERT` into `events` + `world_state` itself, which made two processes the writers of
   * one store and put the transaction boundary in Python. Now the edge prints the event it built and
   * validated (its own `build_presence_event`), and this method is the only writer:
   *
   *   * the envelope is **validated here too** (`appendEvent` → `validateEvent`), so a hand-typed or
   *     drifted line from a child process cannot enter the log;
   *   * the event log and the projection are written in **one transaction**, exactly like
   *     `recordPresenceChanged` — a failure rolls both back rather than leaving "an arrival exists
   *     but the state still says absent";
   *   * the event's own `event_id` survives (it is already on the wire, and re-keying it would break
   *     correlation with the child's stdout record).
   */
  appendPresenceEvent(envelope: EventEnvelope): { event: StoredEvent; state: WorldState } {
    this.#assertOpen();
    const validated = validateEvent(envelope);
    if (validated.event_type !== 'presence.changed') {
      throw new DomainError('INVALID_WORLD_STATE', `appendPresenceEvent only accepts presence.changed, got ${validated.event_type}`);
    }
    const payload = validated.payload as { present?: unknown };
    const present = payload.present === true;
    const previous = this.worldState(PRESENCE_KEY, { now: validated.timestamp });
    const previousState = previous === null ? null : previous.present ? 'present' : 'absent';

    const stored = this.#transaction(() => {
      const appended = this.appendEvent(validated);
      this.setWorldState({
        key: PRESENCE_KEY,
        value: present ? 'present' : 'absent',
        source: validated.source,
        confidence: validated.confidence,
        ttlSeconds: DEFAULT_PRESENCE_TTL_SECONDS,
        timestamp: validated.timestamp,
      });
      return appended;
    });

    const state = this.worldState(PRESENCE_KEY, { now: validated.timestamp });
    if (state === null) {
      throw new DomainError('INVALID_WORLD_STATE', 'presence projection vanished right after being written');
    }
    return { event: stored, state: { ...state, previousState } };
  }

  /**
   * Rebuild the projection from the event log.
   *
   * Not called anywhere at startup: rebuilding is how the projection is *proved* to be
   * derived data (a test can rebuild and compare), and it is the recovery path if the
   * table is ever lost. History is never in question — `events` holds every transition.
   */
  rebuildWorldStateFromEvents(key: string = PRESENCE_KEY): { scanned: number; entry: WorldStateEntry | null } {
    this.#assertOpen();
    const events = this.readEvents({ type: 'presence.changed', limit: Number.MAX_SAFE_INTEGER });
    let latest: StoredEvent | null = null;
    for (const event of events) latest = event;
    if (latest === null) return { scanned: 0, entry: null };
    const payload = latest.payload as { present?: unknown; source_detail?: unknown };
    const entry = this.setWorldState({
      key,
      value: payload.present === true ? 'present' : 'absent',
      source: latest.source,
      confidence: latest.confidence,
      ttlSeconds: DEFAULT_PRESENCE_TTL_SECONDS,
      timestamp: latest.timestamp,
    });
    return { scanned: events.length, entry };
  }

  /** Close the loop: the projection carries a version like every other durable record. */
  worldStateSchemaVersion(): number {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT MAX(schema_version) AS version FROM world_state').get() as unknown as
      | { version: number | null }
      | undefined;
    return row?.version ?? 1;
  }

  // ------------------------------------------------------- open threads (pack Phase 3)
  //
  // 未完话题（《方案》§10）：每条状态变化都在**同一个事务**里写表 + 写一条
  // `open_thread.changed` 事件（同 `recordTurn`/`recordPresenceChanged` 的理由：投影是派生的，
  // 不能与日志不一致）。表可以被日志重建，所以重启后「惦记着什么」不丢、也不会重复问。

  /**
   * 插入一条话题。
   *
   * 幂等：同 `thread_id` 已存在时**不覆盖**（返回 `created: false`，不写事件）。话题去重由
   * 调用方（`OpenThreadStore.create` 的归一化 `summary` 比较）负责，这里只管 id。
   */
  insertOpenThread(input: NewOpenThread): OpenThreadChange {
    this.#assertOpen();
    const at = input.createdAt ?? this.#now();
    const thread: OpenThread = {
      threadId: input.threadId,
      summary: input.summary,
      subject: input.subject ?? null,
      status: 'candidate',
      createdAt: at,
      updatedAt: at,
      followAfter: input.followAfter ?? null,
      expireAt: input.expireAt ?? null,
      followUpHint: input.followUpHint ?? null,
      importance: clamp01(input.importance ?? 0.5),
      attempts: 0,
      lastOfferedAt: null,
      sourceEventId: input.sourceEventId ?? null,
      note: input.note ?? null,
    };
    return this.#transaction(() => {
      const inserted = this.#db
        .prepare(
          `INSERT INTO open_threads (
             thread_id, schema_version, summary, subject, status, created_at, updated_at,
             follow_after, expire_at, follow_up_hint, importance, attempts, last_offered_at,
             source_event_id, note
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
           ON CONFLICT(thread_id) DO NOTHING`,
        )
        .run(
          thread.threadId,
          thread.summary,
          thread.subject,
          thread.status,
          thread.createdAt,
          thread.updatedAt,
          thread.followAfter,
          thread.expireAt,
          thread.followUpHint,
          thread.importance,
          thread.sourceEventId,
          thread.note,
        );
      if (Number(inserted.changes) === 0) {
        const existing = this.openThread(thread.threadId);
        if (existing === null) {
          throw new DomainError('INVALID_OPEN_THREAD', `thread ${thread.threadId} vanished right after a no-op insert`);
        }
        return { thread: existing, event: null, created: false };
      }
      const event = this.appendEvent(
        buildEvent({
          event_type: 'open_thread.changed',
          source: input.source ?? 'conversation',
          actor: 'system',
          confidence: 1,
          timestamp: at,
          payload: openThreadPayload(thread, null),
        }),
      );
      return { thread, event, created: true };
    });
  }

  /**
   * 迁移一条话题的状态。已经是目标状态时返回 `null`（幂等，不写事件）。
   *
   * 不允许把已收口（`resolved`/`snoozed`/`exhausted`）的话题重新打开：收口之后不再重复问，
   * 这正是 Phase 3 验收要求的行为，所以这里靠错误而不是靠调用方自觉。
   */
  transitionOpenThread(
    threadId: string,
    status: OpenThreadStatus,
    options: TransitionOpenThreadOptions = {},
  ): OpenThreadChange | null {
    this.#assertOpen();
    const current = this.openThread(threadId);
    if (current === null) {
      throw new DomainError('UNKNOWN_OPEN_THREAD', `no open thread ${threadId}`);
    }
    if (current.status === status) return null;
    if (OPEN_THREAD_SETTLED_STATUSES.includes(current.status) && !OPEN_THREAD_SETTLED_STATUSES.includes(status)) {
      throw new DomainError(
        'INVALID_OPEN_THREAD',
        `thread ${threadId} is already ${current.status}; a settled thread must not be reopened`,
      );
    }
    // `#now()` already returns an offset-ISO string; `toOffsetIso` is only needed for a
    // caller-supplied `Date`. The old `options.at ?? this.#now()` fed that string to `toOffsetIso`,
    // which calls `date.getTime()` — a `TypeError` on the first `transition()` that omitted `at`.
    const updatedAt = options.at === undefined ? this.#now() : toOffsetIso(options.at);
    const next: OpenThread = {
      ...current,
      status,
      updatedAt,
      note: options.note ?? null,
      attempts: options.offered === true ? current.attempts + 1 : current.attempts,
      lastOfferedAt: options.offered === true ? updatedAt : current.lastOfferedAt,
    };
    return this.#transaction(() => {
      this.#db
        .prepare(
          `UPDATE open_threads
             SET status = ?, updated_at = ?, note = ?, attempts = ?, last_offered_at = ?
           WHERE thread_id = ?`,
        )
        .run(next.status, next.updatedAt, next.note, next.attempts, next.lastOfferedAt, next.threadId);
      const event = this.appendEvent(
        buildEvent({
          event_type: 'open_thread.changed',
          source: 'conversation',
          actor: 'system',
          confidence: 1,
          timestamp: updatedAt,
          payload: openThreadPayload(next, current.status),
        }),
      );
      return { thread: next, event, created: false };
    });
  }

  openThread(threadId: string): OpenThread | null {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM open_threads WHERE thread_id = ?').get(threadId) as unknown;
    return row === undefined ? null : toOpenThread(row as OpenThreadRow);
  }

  /** 一条或多条状态过滤；默认按「该追问的时间」排序（最该问的在前）。 */
  openThreads(query: OpenThreadQuery = {}): OpenThread[] {
    this.#assertOpen();
    const wanted: OpenThreadStatus[] =
      query.status === undefined ? [] : typeof query.status === 'string' ? [query.status] : [...query.status];
    const params: Array<string | number> = [];
    const where =
      wanted.length === 0
        ? ''
        : `WHERE status IN (${wanted.map(() => '?').join(', ')})`;
    params.push(...wanted);
    params.push(query.limit ?? Number.MAX_SAFE_INTEGER);
    const rows = this.#db
      .prepare(
        `SELECT * FROM open_threads ${where}
         ORDER BY (follow_after IS NULL), follow_after ASC, created_at ASC, thread_id ASC
         LIMIT ?`,
      )
      .all(...params) as unknown as OpenThreadRow[];
    return rows.map(toOpenThread);
  }

  /** 这条话题写过的所有状态变化，按日志顺序（审计与「重放能不能重建」的对照）。 */
  openThreadHistory(threadId: string): StoredEvent[] {
    this.#assertOpen();
    return this.readEvents({ type: 'open_thread.changed', limit: Number.MAX_SAFE_INTEGER }).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload['thread_id'] === threadId;
    });
  }

  // ----------------------------------------------- long-term memory (pack Phase 4)
  //
  // 记忆是**推导**（铁律 4）：这些表只存程序提炼出来的东西，每行带 source_event_id 指回原始轮次。
  // 因此这里不写新事件类型 —— 日志是事实与判定，记忆可以按来源重建（见 004_memory.sql 的说明）。

  insertEpisodicMemory(input: NewEpisodicMemory): EpisodicMemory {
    this.#assertOpen();
    const at = input.occurredAt ?? this.#now();
    const memoryId = input.memoryId ?? `mem_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO episodic_memory (
           memory_id, schema_version, occurred_at, summary, kind, source_type,
           source_event_id, session_id, importance, confidence, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memoryId,
        at,
        input.summary,
        input.kind,
        input.sourceType,
        input.sourceEventId ?? null,
        input.sessionId ?? null,
        clamp01(input.importance ?? 0.5),
        clamp01(input.confidence ?? 0.5),
        at,
        at,
      );
    return this.episodicMemory(memoryId);
  }

  episodicMemory(memoryId: string): EpisodicMemory {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM episodic_memory WHERE memory_id = ?').get(memoryId) as unknown;
    if (row === undefined) throw new DomainError('UNKNOWN_MEMORY', `no episodic memory ${memoryId}`);
    return toEpisodicMemory(row as EpisodicMemoryRow);
  }

  episodicMemories(query: MemoryQuery = {}): EpisodicMemory[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.kind !== undefined) {
      clauses.push('kind = ?');
      params.push(query.kind);
    }
    const since = toEpochMs(query.since);
    if (since !== null) {
      clauses.push('occurred_at >= ?');
      params.push(toOffsetIso(new Date(since)));
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    params.push(query.limit ?? 50);
    const rows = this.#db
      .prepare(`SELECT * FROM episodic_memory ${where} ORDER BY occurred_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as unknown as EpisodicMemoryRow[];
    return rows.map(toEpisodicMemory);
  }

  updateEpisodicMemory(
    memoryId: string,
    patch: { readonly summary?: string; readonly importance?: number },
  ): EpisodicMemory {
    this.#assertOpen();
    const current = this.episodicMemory(memoryId);
    const summary = patch.summary ?? current.summary;
    const importance = patch.importance === undefined ? current.importance : clamp01(patch.importance);
    this.#db
      .prepare('UPDATE episodic_memory SET summary = ?, importance = ?, updated_at = ? WHERE memory_id = ?')
      .run(summary, importance, this.#now(), memoryId);
    return this.episodicMemory(memoryId);
  }

  deleteEpisodicMemory(memoryId: string): boolean {
    this.#assertOpen();
    const result = this.#db.prepare('DELETE FROM episodic_memory WHERE memory_id = ?').run(memoryId);
    return Number(result.changes) > 0;
  }

  insertSemanticMemory(input: NewSemanticMemory): SemanticMemory {
    this.#assertOpen();
    const at = this.#now();
    const memoryId = input.memoryId ?? `sem_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO semantic_memory (
           memory_id, schema_version, property, statement, source_type, source_event_id,
           confidence, status, superseded_by, status_changed_at, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?)`,
      )
      .run(
        memoryId,
        input.property,
        input.statement,
        input.sourceType,
        input.sourceEventId ?? null,
        clamp01(input.confidence ?? 0.5),
        at,
        at,
      );
    return this.semanticMemory(memoryId);
  }

  semanticMemory(memoryId: string): SemanticMemory {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM semantic_memory WHERE memory_id = ?').get(memoryId) as unknown;
    if (row === undefined) throw new DomainError('UNKNOWN_MEMORY', `no semantic memory ${memoryId}`);
    return toSemanticMemory(row as SemanticMemoryRow);
  }

  semanticMemories(query: MemoryQuery = {}): SemanticMemory[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.property !== undefined) {
      clauses.push('property = ?');
      params.push(query.property);
    }
    // 状态过滤（迁移 006）。省略 = 不过滤（审计/面板的全量视图）。
    const statuses = query.status === undefined ? [] : Array.isArray(query.status) ? query.status : [query.status];
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    const since = toEpochMs(query.since);
    if (since !== null) {
      clauses.push('created_at >= ?');
      params.push(toOffsetIso(new Date(since)));
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    params.push(query.limit ?? 50);
    const rows = this.#db
      .prepare(`SELECT * FROM semantic_memory ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as unknown as SemanticMemoryRow[];
    return rows.map(toSemanticMemory);
  }

  /**
   * 改一条语义记忆的状态（迁移 006 的写入路径）。
   *
   * 只动状态三列：`statement` / `property` / `source_event_id` / `confidence` 一字不改 ——
   * 「历史不许被改写」这条在记忆上同样成立（被取代的那条仍原样留着，只是不再算数）。
   */
  setSemanticMemoryStatus(input: {
    readonly memoryId: string;
    readonly status: MemoryStatus;
    readonly at: Date;
    readonly reason: string;
    readonly supersededBy?: string | null | undefined;
  }): SemanticMemory {
    this.#assertOpen();
    const current = this.semanticMemory(input.memoryId);
    const supersededBy = input.status === 'superseded' ? (input.supersededBy ?? null) : null;
    if (input.status === 'superseded' && supersededBy === null) {
      throw new DomainError('INVALID_MEMORY_STATUS', 'superseded 必须给出取代它的那条记忆 id', input.memoryId);
    }
    if (supersededBy !== null) this.semanticMemory(supersededBy);
    const changedAt = this.#writeOffsetMinutes === null ? toOffsetIso(input.at) : toOffsetIso(input.at, this.#writeOffsetMinutes);
    this.#db
      .prepare('UPDATE semantic_memory SET status = ?, superseded_by = ?, status_changed_at = ?, updated_at = ? WHERE memory_id = ?')
      .run(input.status, supersededBy, changedAt, this.#now(), current.memoryId);
    // 状态变化也是一条**事实**：写进事件日志。复用既有的 `system.health` 审计事件类型 ——
    // 契约的 event_type 枚举是已发布的，不为「记忆改状态」新增一种（004 的设计取舍同款）。
    // detail 截到 400 字：这个字段有长度上限，越界会被 schema 拒绝，而「状态改了却没留痕」
    // 比少写几个字糟糕得多。日志里**没有**用户原话，只有原因短句（铁律 5）。
    const detail = `${current.memoryId} → ${input.status}：${input.reason}`;
    this.recordHealth('memory.status', 'ok', detail.length > 400 ? `${detail.slice(0, 397)}...` : detail);
    return this.semanticMemory(input.memoryId);
  }

  updateSemanticMemory(
    memoryId: string,
    patch: { readonly statement?: string; readonly property?: string },
  ): SemanticMemory {
    this.#assertOpen();
    const current = this.semanticMemory(memoryId);
    this.#db
      .prepare('UPDATE semantic_memory SET statement = ?, property = ?, updated_at = ? WHERE memory_id = ?')
      .run(patch.statement ?? current.statement, patch.property ?? current.property, this.#now(), memoryId);
    return this.semanticMemory(memoryId);
  }

  deleteSemanticMemory(memoryId: string): boolean {
    this.#assertOpen();
    const result = this.#db.prepare('DELETE FROM semantic_memory WHERE memory_id = ?').run(memoryId);
    return Number(result.changes) > 0;
  }

  insertRelationshipNote(input: NewRelationshipNote): RelationshipNote {
    this.#assertOpen();
    const at = this.#now();
    const noteId = input.noteId ?? `rel_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO relationship_notes (
           note_id, schema_version, aspect, note, source_type, source_event_id, confidence, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        noteId,
        input.aspect,
        input.note,
        input.sourceType,
        input.sourceEventId ?? null,
        clamp01(input.confidence ?? 0.5),
        at,
        at,
      );
    return this.relationshipNote(noteId);
  }

  relationshipNote(noteId: string): RelationshipNote {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM relationship_notes WHERE note_id = ?').get(noteId) as unknown;
    if (row === undefined) throw new DomainError('UNKNOWN_MEMORY', `no relationship note ${noteId}`);
    return toRelationshipNote(row as RelationshipNoteRow);
  }

  relationshipNotes(query: MemoryQuery = {}): RelationshipNote[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.aspect !== undefined) {
      clauses.push('aspect = ?');
      params.push(query.aspect);
    }
    const since = toEpochMs(query.since);
    if (since !== null) {
      clauses.push('created_at >= ?');
      params.push(toOffsetIso(new Date(since)));
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    params.push(query.limit ?? 50);
    const rows = this.#db
      .prepare(`SELECT * FROM relationship_notes ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as unknown as RelationshipNoteRow[];
    return rows.map(toRelationshipNote);
  }

  // ------------------------------------------- three-layer self model (pack Phase 4)
  //
  // 有效人格 = 基础（`self_profile`，配置/管理员）+ 学习（`self_profile_learned`）+ 会话覆盖
  // （`session_overrides`，只认今天）。`selfProfile()` 读的就是这个和 —— 所有消费方
  // （提示词、FSM 窗口、主动引擎的 base_proactivity）因此自动拿到三层结果，不需要各自拼。

  /** 学习到的偏移（LearnedProfile 那一层）。 */
  learnedDeltas(): LearnedDelta[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare('SELECT * FROM self_profile_learned ORDER BY property')
      .all() as unknown as LearnedDeltaRow[];
    return rows.map((row) => ({
      property: row.property,
      delta: row.delta,
      sourceType: row.source_type,
      evidence: row.evidence,
      confidence: row.confidence,
      updatedAt: row.updated_at,
    }));
  }

  learnedDelta(property: string): LearnedDelta | null {
    return this.learnedDeltas().find((entry) => entry.property === property) ?? null;
  }

  /** 写一层的累计值（策略与上限在 `SelfModel`，这里只落库）。 */
  writeLearnedDelta(
    property: string,
    delta: number,
    options: { readonly sourceType: string; readonly evidence: string | null; readonly confidence: number },
  ): LearnedDelta {
    this.#assertOpen();
    const at = this.#now();
    this.#db
      .prepare(
        `INSERT INTO self_profile_learned (property, schema_version, delta, source_type, evidence, confidence, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(property) DO UPDATE SET
           delta = excluded.delta,
           source_type = excluded.source_type,
           evidence = excluded.evidence,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      )
      .run(property, delta, options.sourceType, options.evidence, clamp01(options.confidence), at);
    const written = this.learnedDelta(property);
    if (written === null) {
      throw new DomainError('INVALID_SELF_MODEL', `learned delta for ${property} vanished right after writing`);
    }
    return written;
  }

  /** 某一天生效的会话覆盖（默认：今天）。`valid_day` 是本地自然日，所以次日自动失效。 */
  sessionOverrides(query: { readonly day?: string; readonly sessionId?: string | null } = {}): SessionOverride[] {
    this.#assertOpen();
    const day = query.day ?? localDayOf(this.clock());
    const rows = (
      query.sessionId === undefined
        ? this.#db.prepare('SELECT * FROM session_overrides WHERE valid_day = ? ORDER BY property').all(day)
        : this.#db
            .prepare('SELECT * FROM session_overrides WHERE valid_day = ? AND (session_id IS ? OR session_id = ?) ORDER BY property')
            .all(day, query.sessionId, query.sessionId)
    ) as unknown as SessionOverrideRow[];
    return rows.map((row) => ({
      overrideId: row.override_id,
      sessionId: row.session_id,
      property: row.property,
      delta: row.delta,
      reason: row.reason,
      sourceType: row.source_type,
      validDay: row.valid_day,
      createdAt: row.created_at,
    }));
  }

  insertSessionOverride(input: {
    readonly property: string;
    readonly delta: number;
    readonly reason: string;
    readonly sourceType: string;
    readonly sessionId?: string | null;
    readonly validDay?: string;
  }): SessionOverride {
    this.#assertOpen();
    const at = this.#now();
    const overrideId = `ovr_${randomUUID()}`;
    const validDay = input.validDay ?? localDayOf(this.clock());
    this.#db
      .prepare(
        `INSERT INTO session_overrides (
           override_id, schema_version, session_id, property, delta, reason, source_type, valid_day, created_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(overrideId, input.sessionId ?? null, input.property, input.delta, input.reason, input.sourceType, validDay, at);
    const written = this.sessionOverrides({ day: validDay }).find((entry) => entry.overrideId === overrideId);
    if (written === undefined) {
      throw new DomainError('INVALID_SELF_MODEL', 'session override vanished right after writing');
    }
    return written;
  }

  /** 抹掉某一天某属性的会话覆盖（重复说「今天安静点」只保留一条）。 */
  clearSessionOverride(query: { readonly property: string; readonly day: string; readonly sessionId?: string | null }): number {
    this.#assertOpen();
    const result =
      query.sessionId === undefined || query.sessionId === null
        ? this.#db
            .prepare('DELETE FROM session_overrides WHERE property = ? AND valid_day = ?')
            .run(query.property, query.day)
        : this.#db
            .prepare('DELETE FROM session_overrides WHERE property = ? AND valid_day = ? AND session_id IS ?')
            .run(query.property, query.day, query.sessionId);
    return Number(result.changes);
  }

  /** 自我画像变更历史（§7.5）：学习、会话覆盖、admin 覆盖都往这里写。 */
  recordSelfProfileChange(input: {
    readonly property: string;
    readonly before: number | null;
    readonly after: number;
    readonly sourceType: string;
    readonly summary: string;
    readonly confidence?: number;
    readonly sourceEventId?: string | null;
  }): void {
    this.#assertOpen();
    this.#db
      .prepare(
        `INSERT INTO self_profile_history (
           change_id, schema_version, property, before_value, after_value, source_type,
           source_event_id, summary, confidence, created_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `selfchg_${randomUUID()}`,
        input.property,
        input.before,
        input.after,
        input.sourceType,
        input.sourceEventId ?? null,
        input.summary,
        clamp01(input.confidence ?? 1),
        this.#now(),
      );
  }
}

/**
 * `updated_at + ttl` in the same local-offset form the store writes.
 *
 * Deliberately built on `Date.parse` + `toOffsetIso` rather than a duration library: the
 * timestamp format is fixed by the event contract (docs/design/domain-model.md §2) and the
 * offset must survive the arithmetic, or `stale` would be wrong by the timezone offset.
 */
function addSecondsToIso(timestamp: string, seconds: number, offsetMinutes: number | null = null): string {
  const base = Date.parse(timestamp);
  if (Number.isNaN(base)) {
    throw new DomainError('INVALID_WORLD_STATE', `cannot parse timestamp "${timestamp}"`);
  }
  const at = new Date(base + seconds * 1000);
  // V0.3 P0-D: render `staleAfter` in the **same** offset as the row it describes, so a replayed
  // store (whose writes carry the fixture's offset) does not grow a second zone in its own output.
  return offsetMinutes === null ? toOffsetIso(at) : toOffsetIso(at, offsetMinutes);
}

function toWorldStateEntry(row: WorldStateRow): WorldStateEntry {
  return {
    key: row.key,
    value: row.value,
    source: row.source,
    updatedAt: row.updated_at,
    confidence: row.confidence,
    ttlSeconds: row.ttl_seconds,
  };
}

/**
 * A stored mood row, clamped on the way out.
 *
 * The clamp is the same one the writer used (`mood.ts`), applied again here because a value can
 * also reach the table through an older build or a hand edit — "out of bounds" must be
 * impossible for consumers, not merely unlikely.
 */
function toStoredMood(row: MoodStateRow): StoredMood {
  return {
    valence: clampMoodValue(row.valence),
    energy: clampMoodValue(row.energy),
    evidence: parseMoodCounts(row.evidence_json),
    lastBeatAt: row.last_beat_at,
    lastEventSequence: parseCursor(row.cursor_json),
    source: row.source,
    summary: row.summary,
    updatedAt: row.updated_at,
  };
}

/** The event-sequence cursor, or 0 when the column is missing/corrupt (start from the beginning). */
function parseCursor(json: string): number {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return 0;
    const sequence = (parsed as { sequence?: unknown }).sequence;
    if (typeof sequence !== 'number' || !Number.isFinite(sequence) || sequence < 0) return 0;
    return Math.floor(sequence);
  } catch {
    return 0;
  }
}

/**
 * One spelling for a mood timestamp, whichever shape the caller used (preflight ④).
 *
 * `mood_history.created_at` is a **string** column and `moodHistory()` orders by it, so two
 * spellings of the same instant sort against each other instead of against the clock. A string that
 * already carries a numeric offset is the repo's own convention (`toOffsetIso`) and is left **byte for
 * byte** alone — normalising must not gratuitously add `.000` to every row; a `Z`-shaped (or
 * offset-less) string is rewritten with the local offset. A string this machine cannot parse is
 * stored exactly as given: that is the pre-existing behaviour, and a mood write is not the place to
 * start throwing at callers.
 */
function moodInstant(value: string): string {
  if (NUMERIC_OFFSET_ISO.test(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? toOffsetIso(new Date(parsed)) : value;
}

/** `2026-10-01T22:00:00+08:00` / `…T22:00:00.000+08:00` — ISO-8601 with a numeric offset. */
const NUMERIC_OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?[+-]\d{2}:\d{2}$/;

function toMoodChange(row: MoodHistoryRow): MoodChange {
  const before: MoodState = { valence: clampMoodValue(row.before_valence), energy: clampMoodValue(row.before_energy) };
  const after: MoodState = { valence: clampMoodValue(row.after_valence), energy: clampMoodValue(row.after_energy) };
  return {
    changeId: row.change_id,
    before,
    after,
    // Derived from the two states, not read from the stored columns: `delta` must agree with
    // `after - before` even if a hand edit moved only one of the four numbers.
    delta: { valence: after.valence - before.valence, energy: after.energy - before.energy },
    reset: row.reset === 1,
    signals: parseMoodCounts(row.signals_json),
    signalCount: row.signal_count,
    droppedCount: row.dropped_count,
    note: row.note,
    createdAt: row.created_at,
  };
}

/** Parse a stored JSON count map, dropping anything that is not a finite positive number. */
function parseMoodCounts(json: string): Readonly<Partial<Record<MoodSignalCode, number>>> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const counts: Partial<Record<MoodSignalCode, number>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!MOOD_SIGNAL_CODES.includes(key as MoodSignalCode)) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      counts[key as MoodSignalCode] = value;
    }
    return counts;
  } catch {
    // A corrupt count map must not take the mood down with it: the numbers are the durable part.
    return {};
  }
}

function toOpenThread(row: OpenThreadRow): OpenThread {
  return {
    threadId: row.thread_id,
    summary: row.summary,
    subject: row.subject,
    status: row.status as OpenThreadStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    followAfter: row.follow_after,
    expireAt: row.expire_at,
    followUpHint: row.follow_up_hint,
    importance: row.importance,
    attempts: row.attempts,
    lastOfferedAt: row.last_offered_at,
    sourceEventId: row.source_event_id,
    note: row.note,
  };
}

/**
 * `open_thread.changed` 的 payload：**每个字段都写**（可选的写 null），这样一条事件自带全部事实，
 * 不需要再去查表才能读懂它；旧事件（字段更少）仍然合法 —— 新字段在 schema 里是可选的。
 */
function openThreadPayload(thread: OpenThread, previousStatus: OpenThreadStatus | null): Record<string, JsonValue> {
  return {
    thread_id: thread.threadId,
    status: thread.status,
    previous_status: previousStatus,
    summary: thread.summary,
    subject: thread.subject,
    follow_after: thread.followAfter,
    expire_at: thread.expireAt,
    follow_up_hint: thread.followUpHint,
    importance: thread.importance,
    attempts: thread.attempts,
    source_event_id: thread.sourceEventId,
    note: thread.note,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toEpisodicMemory(row: EpisodicMemoryRow): EpisodicMemory {
  return {
    memoryId: row.memory_id,
    occurredAt: row.occurred_at,
    summary: row.summary,
    kind: row.kind as EpisodicMemory['kind'],
    sourceType: row.source_type as EpisodicMemory['sourceType'],
    sourceEventId: row.source_event_id,
    sessionId: row.session_id,
    importance: row.importance,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSemanticMemory(row: SemanticMemoryRow): SemanticMemory {
  return {
    memoryId: row.memory_id,
    property: row.property,
    statement: row.statement,
    sourceType: row.source_type as SemanticMemory['sourceType'],
    sourceEventId: row.source_event_id,
    confidence: row.confidence,
    // 老库（006 之前的行）由迁移的 DEFAULT 补成 'active'；万一读到不认识的字符串，
    // 按 **inactive** 处理（`expired`）而不是当成 active —— 「认不出来的状态」不该被当成算数。
    status: (MEMORY_STATUSES as readonly string[]).includes(row.status) ? (row.status as MemoryStatus) : 'expired',
    supersededBy: row.superseded_by,
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRelationshipNote(row: RelationshipNoteRow): RelationshipNote {
  return {
    noteId: row.note_id,
    aspect: row.aspect,
    note: row.note,
    sourceType: row.source_type as RelationshipNote['sourceType'],
    sourceEventId: row.source_event_id,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `since` 允许 ISO 字符串或 epoch 毫秒；读不出来就是「不过滤」。 */
function toEpochMs(since: string | number | undefined): number | null {
  if (since === undefined) return null;
  if (typeof since === 'number') return Number.isFinite(since) ? since : null;
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? null : parsed;
}

function sessionIdOf(event: EventEnvelope): string | null {  const payload = event.payload as JsonValue;
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
