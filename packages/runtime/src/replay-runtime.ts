/**
 * Replay foundation (V0.3 P0-D, pack `docs/04_RUNTIME_CONSOLIDATION.md` §4).
 *
 * A replay is a JSON script of **inputs plus the instant they happen at**, written as offsets from
 * the script's `start` (`+0m`, `+3h01m`, `+26h2m`). The driver owns one **injected clock**
 * (`Clock` from `@xixi/domain`), hands it to everything it builds (store, conversation engine,
 * topic engine, resident consideration loop) and jumps it to a step's instant before running that
 * step. Nothing in this file reads wall-clock time, which is what makes a 26-hour cross-day
 * scenario finish in milliseconds and give the same answer on any machine, on any date.
 *
 * Two document shapes are accepted, both taken from the pack:
 *
 *   { "name": …, "start": "…", "steps": [ { "at": "+0m", "kind": "user_turn", … } ] }  (pack §4 file)
 *   [ { "at": "+0m", "event": "conversation.turn", … } ]                              (pack §4 snippet)
 *
 * Step kinds (via `kind` **or** `event`): `conversation.turn` (`user_turn`), `presence.changed`
 * (`perception` with `observation_type: "person.presence"`), `world`, `system.health`,
 * `proactive_tick`. Anything else **throws**: a typo in a fixture has to fail loudly, not silently
 * replay a shorter scenario (a replay that quietly skips steps would make every baseline weaker
 * than it looks).
 *
 * What each kind drives — always a production seam, never a special replay-only path:
 *
 *   * `conversation.turn` → `ConversationEngine.respond()`, i.e. the entry `chat` / `web` /
 *     resident voice use. The reply comes from the injected `adapter`; the turn's acceptance, the
 *     events it writes and the working memory the next turn sees are the real ones.
 *   * `presence.changed` → the same line the Python edge prints on stdout
 *     (`{"record":"event", …envelope}`) through `ingestPerceptionLine`, so validation, the
 *     single-writer append and the `world_state` projection are the production ones (P0-B).
 *   * `world` → `XixiStore.setWorldState()` — **the projection only**. There is no
 *     `world_state.changed` event type in the contract, so this step is a synthetic input for
 *     scenarios that need "the TV is on"; unlike `presence.home` it is not rebuildable from the
 *     log. Fixtures that need durable facts should write events instead.
 *   * `system.health` → `XixiStore.recordHealth()` (service / status / detail).
 *   * `proactive_tick` → one `ProactiveLoop.tickOnce()`. One step is one tick, exactly like the
 *     resident loop; the report carries both the loop's own entry and the `proactive.decision`
 *     rows that tick wrote to the log.
 *
 * The anchor: relative offsets need one, and the document's own `start` is the default. Since the
 * offsets are relative anyway, the caller may override it (`start`) — that is how the test suite
 * keeps fixtures independent of the machine's timezone: it anchors them with `toOffsetIso()` of a
 * **local** `Date`, which is the convention `atLocalDayHour` in the topic engine already uses.
 *
 * Not here yet (pack §4 keeps them for after V0.3): `sensor.observation`, audio fixtures and image
 * evidence fixtures. The step table is the extension point: add a kind, drive a production seam,
 * record what it did.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrainAdapter } from '@xixi/brain-adapter';
import { ACTORS, buildEvent, toOffsetIso, type Actor } from '@xixi/contracts';
import { ConversationEngine, parseProactiveSettings, TopicEngine } from '@xixi/conversation';
import {
  DEFAULT_PRESENCE_TTL_SECONDS,
  openXixiStore,
  PRESENCE_KEY,
  type Clock,
  type StoredEvent,
  type XixiConfig,
  type XixiStore,
} from '@xixi/domain';

import { RuntimeError } from './errors.ts';
import { ingestPerceptionLine } from './perception-ingest.ts';
import { ProactiveLoop, lastUserTurnAt, recentUserTopics } from './proactive-runtime.ts';

// ---------------------------------------------------------------- time

/** Relative-offset units. `ms` is listed first because the regex alternation is ordered. */
const OFFSET_UNITS: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

const OFFSET_PART = /(\d+)(ms|[dhms])/y;

/**
 * `"+3h01m"` → 10 860 000. Offsets are **relative to the replay's start** and never negative: a
 * replay is a script, so "2 minutes before the start" is a fixture bug, not a supported feature.
 */
export function parseReplayOffset(text: string): number {
  const trimmed = text.trim();
  const body = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  if (body.length === 0) {
    throw new RuntimeError(
      'INVALID_REPLAY_OFFSET',
      `"${text}" is not a relative offset`,
      'write "+0m" / "+3h" / "+3h01m": replay times are offsets from the script start',
    );
  }
  let total = 0;
  let consumed = 0;
  OFFSET_PART.lastIndex = 0;
  let match = OFFSET_PART.exec(body);
  while (match !== null) {
    const unit = match[2] ?? '';
    total += Number(match[1]) * (OFFSET_UNITS[unit] ?? 0);
    consumed += match[0].length;
    OFFSET_PART.lastIndex = consumed;
    match = OFFSET_PART.exec(body);
  }
  if (consumed !== body.length) {
    throw new RuntimeError(
      'INVALID_REPLAY_OFFSET',
      `"${text}" has a part that is not a duration`,
      'units are d/h/m/s, e.g. "+26h35m"',
    );
  }
  return total;
}

/** The UTC offset a start instant was written with (`+08:00` → 480). `Z` counts as 0. */
export function offsetMinutesOf(instant: string): number {
  const trimmed = instant.trim();
  if (/Z$/i.test(trimmed)) return 0;
  const match = /([+-])(\d{2}):(\d{2})$/.exec(trimmed);
  if (match === null) {
    throw new RuntimeError(
      'INVALID_REPLAY_START',
      `"${instant}" has no explicit UTC offset`,
      'write an ISO-8601 instant with an offset, e.g. "2026-10-05T08:00:00+08:00"',
    );
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * The clock every component of a replay reads.
 *
 * It is a plain `Clock` (`() => Date`) plus the two operations the *driver* needs (`at`, `now`).
 * `fixedClock` from the domain does not fit: it advances one step per read, while a replay needs
 * "the current instant" to stay put until the next step says otherwise.
 */
export interface ReplayClock {
  readonly start: Date;
  /** The start instant's own UTC offset, in minutes. Also what the engines are given. */
  readonly offsetMinutes: number;
  /** The injected seam, handed to the store / engine / topic engine / loop. */
  readonly clock: Clock;
  /** Jump to `start + offsetMs` and return that instant. */
  at(offsetMs: number): Date;
  /** The instant the clock currently reads. */
  now(): Date;
}

export function createReplayClock(start: Date, offsetMinutes: number = -start.getTimezoneOffset()): ReplayClock {
  const origin = start.getTime();
  let current = origin;
  return {
    start: new Date(origin),
    offsetMinutes,
    clock: () => new Date(current),
    at: (offsetMs: number) => {
      current = origin + offsetMs;
      return new Date(current);
    },
    now: () => new Date(current),
  };
}

// ---------------------------------------------------------------- document

export type ReplayStepKind =
  | 'conversation.turn'
  | 'presence.changed'
  | 'world'
  | 'system.health'
  | 'proactive_tick';

/** Accepted spellings: the pack uses `kind` in its file and `event` in the §4 snippet. */
const STEP_ALIASES: Readonly<Record<string, ReplayStepKind>> = Object.freeze({
  'conversation.turn': 'conversation.turn',
  user_turn: 'conversation.turn',
  'presence.changed': 'presence.changed',
  perception: 'presence.changed',
  world: 'world',
  'world.state': 'world',
  'system.health': 'system.health',
  health: 'system.health',
  proactive_tick: 'proactive_tick',
});

export interface ReplayStep {
  /** 0-based position in the file — the report keys results by it. */
  readonly index: number;
  /** The offset exactly as written (`"+3h01m"`), kept for error messages and reports. */
  readonly at: string;
  readonly offsetMs: number;
  readonly kind: ReplayStepKind;
  /** The step's raw JSON, for the kind's own field readers. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ReplayDocument {
  readonly name: string;
  /** The document's own anchor, as written. May be overridden by the run options. */
  readonly start: string;
  readonly steps: readonly ReplayStep[];
}

export interface ParseReplayOptions {
  readonly name?: string | undefined;
  /** Anchor to use when the document does not carry a `start` (the pack's array snippet). */
  readonly start?: string | undefined;
}

function replayError(problem: string, hint = ''): RuntimeError {
  return new RuntimeError('INVALID_REPLAY', problem, hint);
}

function requireInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw replayError(`${field} must be an ISO-8601 instant string`, 'e.g. "2026-10-05T08:00:00+08:00"');
  }
  const instant = value.trim();
  // Offset first: `Date.parse` accepts a missing one and would silently anchor the whole script to
  // the machine's timezone, which is exactly the class of bug replay exists to prevent.
  offsetMinutesOf(instant);
  if (!Number.isFinite(new Date(instant).getTime())) {
    throw replayError(`${field} "${instant}" is not a valid instant`);
  }
  return instant;
}

function normalizeStep(raw: unknown, index: number): ReplayStep {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw replayError(`step ${index} must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record['at'] !== 'string') {
    throw replayError(`step ${index} has no "at"`, 'every step needs a relative offset such as "+26h1m"');
  }
  const declared = typeof record['kind'] === 'string'
    ? record['kind']
    : typeof record['event'] === 'string'
      ? record['event']
      : null;
  if (declared === null) {
    throw replayError(
      `step ${index} has neither "kind" nor "event"`,
      `known kinds: ${[...new Set(Object.values(STEP_ALIASES))].join(', ')}`,
    );
  }
  const kind = STEP_ALIASES[declared];
  if (kind === undefined) {
    throw replayError(
      `step ${index}: unknown kind "${declared}"`,
      `known kinds: ${[...new Set(Object.values(STEP_ALIASES))].join(', ')}`,
    );
  }
  if (kind === 'presence.changed' && record['observation_type'] !== undefined && record['observation_type'] !== 'person.presence') {
    throw replayError(
      `step ${index}: observation_type "${String(record['observation_type'])}" is not supported`,
      'only person.presence exists today (pack §4: sensor.observation comes after V0.3)',
    );
  }
  return { index, at: record['at'], offsetMs: parseReplayOffset(record['at']), kind, raw: record };
}

/**
 * Parse and validate a replay document (an already-parsed object, or JSON text).
 *
 * Steps run **in file order** and time must not go backwards: a fixture that rewinds is a fixture
 * bug (it would silently invert cause and effect), so it is rejected instead of replayed.
 */
export function parseReplayDocument(source: unknown, options: ParseReplayOptions = {}): ReplayDocument {
  const root: unknown = Array.isArray(source) ? { steps: source } : source;
  if (typeof root !== 'object' || root === null) {
    throw replayError('a replay is a JSON object with "start" + "steps", or an array of steps');
  }
  const record = root as Record<string, unknown>;
  const rawSteps = record['steps'];
  if (!Array.isArray(rawSteps)) {
    throw replayError('"steps" must be an array');
  }
  const startRaw = record['start'] === undefined ? options.start : record['start'];
  if (startRaw === undefined) {
    throw replayError(
      'a replay needs a "start" instant',
      'the pack\'s array form has no anchor: pass one as `start` (the offsets are relative to it)',
    );
  }
  const start = requireInstant(startRaw, '`start`');
  const name = typeof record['name'] === 'string' && record['name'].trim().length > 0
    ? record['name'].trim()
    : options.name ?? 'replay';

  const steps = rawSteps.map((raw, index) => normalizeStep(raw, index));
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1];
    const current = steps[index];
    if (previous === undefined || current === undefined) continue;
    if (current.offsetMs < previous.offsetMs) {
      throw replayError(
        `step ${current.index} ("${current.at}") is before step ${previous.index} ("${previous.at}")`,
        'a replay runs in file order: keep the offsets non-decreasing',
      );
    }
  }
  return { name, start, steps };
}

/** Load a replay: JSON text (starts with `{` / `[`), a `.json` path, or a parsed document. */
export function loadReplay(source: string | ReplayDocument, options: ParseReplayOptions = {}): ReplayDocument {
  // An already-parsed document goes through the same validation: a hand-built object must not be
  // able to skip the rules the JSON path enforces (that is how a fixture gets a step with no
  // `offsetMs` and silently replays at `NaN`).
  if (typeof source !== 'string') return parseReplayDocument(source, options);
  const trimmed = source.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseReplayDocument(JSON.parse(trimmed) as unknown, options);
  }
  return parseReplayDocument(JSON.parse(readFileSync(source, 'utf8')) as unknown, options);
}

// ---------------------------------------------------------------- report

export interface ReplayTurnResult {
  readonly kind: 'conversation.turn';
  readonly step: number;
  readonly offset: string;
  /** The step's instant, from the injected clock (offset-ISO, the shape the store writes). */
  readonly at: string;
  readonly text: string;
  readonly addressed: boolean;
  readonly accepted: boolean;
  readonly reason: string;
  readonly action: string;
  readonly state: string;
  readonly reply: string | null;
  readonly segments: readonly string[];
  /** Prior turns the model saw, oldest first, as `role:text` — the working-memory evidence. */
  readonly history: readonly string[];
}

export interface ReplayPresenceResult {
  readonly kind: 'presence.changed';
  readonly step: number;
  readonly offset: string;
  readonly at: string;
  /** `false` means the ingest rejected or ignored the line — a fixture bug, not a state change. */
  readonly ingested: boolean;
  readonly note: string;
  readonly present: boolean;
  readonly eventId: string | null;
  /** The projection right after the step, read with the injected clock. */
  readonly projection: {
    readonly present: boolean | null;
    readonly value: string | null;
    readonly stale: boolean;
    readonly staleAfter: string;
    readonly ttlSeconds: number;
  } | null;
}

export interface ReplayWorldResult {
  readonly kind: 'world';
  readonly step: number;
  readonly offset: string;
  readonly at: string;
  readonly key: string;
  readonly value: string | null;
  readonly confidence: number;
  readonly ttlSeconds: number;
}

export interface ReplayHealthResult {
  readonly kind: 'system.health';
  readonly step: number;
  readonly offset: string;
  readonly at: string;
  readonly service: string;
  readonly status: 'ok' | 'degraded' | 'down';
  readonly sequence: number;
}

/** One `proactive.decision` row, as the log carries it (铁律 5: codes and numbers, no prose). */
export interface ReplayDecision {
  readonly sequence: number;
  readonly candidateId: string;
  readonly trigger: string;
  readonly initiativeKind: string;
  readonly topicRef: string | null;
  readonly speak: boolean;
  readonly delivered: boolean;
  readonly reasonCode: string;
  readonly score: number;
  readonly threshold: number;
}

export interface ReplayTickResult {
  readonly kind: 'proactive_tick';
  readonly step: number;
  readonly offset: string;
  readonly at: string;
  /** 1-based, within this run only (the loop counts its own ticks separately). */
  readonly tick: number;
  /** What the loop reported for this tick, or `null` when no candidate could be built. */
  readonly entry: {
    readonly candidateId: string;
    readonly trigger: string;
    readonly initiativeKind: string;
    readonly speak: boolean;
    readonly reasonCode: string;
    readonly score: number;
    readonly threshold: number;
    readonly text: string | null;
  } | null;
  /** Every decision this tick wrote, including the ones the walk passed over. */
  readonly decisions: readonly ReplayDecision[];
}

export type ReplayStepResult =
  | ReplayTurnResult
  | ReplayPresenceResult
  | ReplayWorldResult
  | ReplayHealthResult
  | ReplayTickResult;

export interface ReplayReport {
  readonly name: string;
  /** The anchor actually used (offset-ISO, from the injected clock's start). */
  readonly start: string;
  readonly offsetMinutes: number;
  /** The last step's instant; equal to `start` for an empty script. */
  readonly end: string;
  readonly sessionId: string;
  readonly dataDir: string;
  readonly steps: readonly ReplayStepResult[];
  readonly turns: readonly ReplayTurnResult[];
  readonly presence: readonly ReplayPresenceResult[];
  readonly ticks: readonly ReplayTickResult[];
  /** The live store: assertions read projections and open threads through it. */
  readonly store: XixiStore;
  readonly topicEngine: TopicEngine;
  readonly engine: ConversationEngine;
  readonly loop: ProactiveLoop;
  /**
   * Close the store, and remove the scratch directory **this run created**.
   *
   * A caller-supplied `dataDir` is left alone (it is the caller's evidence, see AGENTS §3: tests
   * use the system temp directory, and the run's own scratch space has to go away with it).
   */
  close(): void;
}

export interface ReplayRunOptions {
  /** The script: JSON text, a `.json` path, or a parsed `ReplayDocument`. */
  readonly replay: string | ReplayDocument;
  /**
   * The brain that answers user turns. **Required** on purpose: a replay must never pick a model
   * (or a transport) on its own — `tests/replay` passes `FakeBrainAdapter`, later phases can pass
   * a recorded or a real adapter.
   */
  readonly adapter: BrainAdapter;
  /** Anchor override for the relative offsets (see the module doc). */
  readonly start?: string | undefined;
  readonly name?: string | undefined;
  /** Where the store lives. Default: a fresh directory under the system temp dir. */
  readonly dataDir?: string | undefined;
  readonly config?: XixiConfig | undefined;
  /** Seeded self profile: personality knobs plus `proactivity`. */
  readonly profile?: Readonly<Record<string, number>> | undefined;
  /** Outer proactive settings object (what `parseProactiveSettings` reads). */
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
  /** `open_threads` section, as `config.xixi.open_threads` carries it. */
  readonly topicSettings?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Where the resident loop's presence view comes from. `store` (default) reads the projection
   * with the injected clock — the same question production asks, asked at script time.
   */
  readonly presence?: 'store' | 'none' | undefined;
  /**
   * The loop's randomness source (「随机闲聊」 only fires below its chance).
   *
   * Defaults to `() => 1` instead of the loop's own `Math.random` **because a replay must be
   * reproducible**: two runs of the same script have to make the same decisions, and a fixture
   * that wants 「随机闲聊」 can pass `() => 0` (with `triggers.random_smalltalk` on).
   */
  readonly random?: (() => number) | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/** The configuration a replay runs with: offline models, no keys, nothing to dial. */
export const REPLAY_CONFIG: XixiConfig = Object.freeze({
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: {
    llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false },
    asr: { provider: 'fake', model: 'fake-asr' },
    tts: { provider: 'fake', model: 'fake-tts' },
  },
  personality: { base: { verbosity: 0.4, warmth: 0.8, silence_tolerance: 0.7 } },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
});

const DEFAULT_REPLAY_PROFILE: Readonly<Record<string, number>> = Object.freeze({
  verbosity: 0.4,
  warmth: 0.8,
  silence_tolerance: 0.7,
  proactivity: 0.85,
});

// ---------------------------------------------------------------- step field readers

function stepString(step: ReplayStep, key: string): string {
  const value = step.raw[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw replayError(`step ${step.index} (${step.kind}): "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(step: ReplayStep, key: string): string | null {
  const value = step.raw[key];
  return typeof value === 'string' ? value : null;
}

/** `"on"` / `1` / `true` all have to survive `world_state.value`, which is text or null. */
function worldValue(step: ReplayStep): string | null {
  const value = step.raw['value'];
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw replayError(`step ${step.index} (world): "value" must be a string, number, boolean or null`);
}

function optionalBoolean(step: ReplayStep, key: string, fallback: boolean): boolean {
  const value = step.raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw replayError(`step ${step.index} (${step.kind}): "${key}" must be a boolean`);
  return value;
}

function optionalNumber(step: ReplayStep, key: string, fallback: number): number {
  const value = step.raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw replayError(`step ${step.index} (${step.kind}): "${key}" must be a number`);
  }
  return value;
}

/** `ttl_sec` (the pack's file) and `ttlSeconds` (this repo's spelling) are both accepted. */
function optionalTtlSeconds(step: ReplayStep, fallback: number): number {
  const raw = step.raw['ttl_sec'] ?? step.raw['ttlSeconds'];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw replayError(`step ${step.index} (${step.kind}): "ttl_sec" must be a positive number`);
  }
  return raw;
}

function stepActor(step: ReplayStep, fallback: Actor): Actor {
  const value = step.raw['subject'] ?? step.raw['actor'];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !(ACTORS as readonly string[]).includes(value)) {
    throw replayError(
      `step ${step.index} (${step.kind}): "${String(value)}" is not an actor`,
      `known actors: ${ACTORS.join(', ')}`,
    );
  }
  return value as Actor;
}

/** `present: true` / `value: "present"` — the pack's own example uses the latter. */
function stepPresent(step: ReplayStep): boolean {
  const explicit = step.raw['present'];
  if (typeof explicit === 'boolean') return explicit;
  const value = optionalString(step, 'value');
  if (value === 'present') return true;
  if (value === 'absent') return false;
  throw replayError(
    `step ${step.index} (presence.changed) needs "present": true/false (or "value": "present"/"absent")`,
  );
}

// ---------------------------------------------------------------- the run

function projectionOf(store: XixiStore, at: Date, offsetMinutes: number): ReplayPresenceResult['projection'] {
  const row = store.worldState(PRESENCE_KEY, { now: toOffsetIso(at, offsetMinutes) });
  if (row === null) return null;
  return {
    present: row.present,
    value: row.value,
    stale: row.stale,
    staleAfter: row.staleAfter,
    ttlSeconds: row.ttlSeconds,
  };
}

function decisionOf(event: StoredEvent): ReplayDecision {
  const payload = event.payload as Record<string, unknown>;
  const number = (key: string): number => (typeof payload[key] === 'number' ? payload[key] : 0);
  return {
    sequence: event.sequence,
    candidateId: typeof payload['candidate_id'] === 'string' ? payload['candidate_id'] : '',
    trigger: typeof payload['trigger'] === 'string' ? payload['trigger'] : '',
    initiativeKind: typeof payload['initiative_kind'] === 'string' ? payload['initiative_kind'] : '',
    topicRef: typeof payload['topic_ref'] === 'string' ? payload['topic_ref'] : null,
    speak: payload['speak'] === true,
    delivered: payload['delivered'] === true,
    reasonCode: typeof payload['reason_code'] === 'string' ? payload['reason_code'] : '',
    score: number('score'),
    threshold: number('threshold'),
  };
}

/**
 * Run one replay end to end and return everything it did.
 *
 * The caller closes the run (`report.close()`), which also removes the temp directory this function
 * created when `dataDir` was omitted (AGENTS §3: scratch space lives in the system temp directory,
 * never in `data/`; a caller-supplied `dataDir` is left in place).
 */
export async function runReplay(options: ReplayRunOptions): Promise<ReplayReport> {
  const document = loadReplay(options.replay, { name: options.name, start: options.start });
  // The anchor: an explicit `start` overrides the document's (the offsets are relative), which is
  // what lets one fixture run in any timezone or epoch.
  const anchor = requireInstant(options.start ?? document.start, '`start`');
  const clock = createReplayClock(new Date(anchor), offsetMinutesOf(anchor));

  const ownDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'xixi-replay-'));
  const store = openXixiStore({ dataDir, clock: clock.clock });
  store.seedSelfProfile({ ...(options.profile ?? DEFAULT_REPLAY_PROFILE) });
  const session = store.createSession();

  const engine = new ConversationEngine({
    adapter: options.adapter,
    store,
    config: options.config ?? REPLAY_CONFIG,
    clock: clock.clock,
    offsetMinutes: clock.offsetMinutes,
  });

  const topicEngine = new TopicEngine({
    store,
    clock: clock.clock,
    ...(options.topicSettings === undefined ? {} : { config: options.topicSettings }),
  });

  const settings = parseProactiveSettings(options.settings);
  const presenceMode = options.presence ?? 'store';
  const loop = new ProactiveLoop({
    store,
    readSettings: () => settings,
    readState: () => engine.state,
    readInFlightTurn: () => false,
    readProactivity: () => store.selfProfile()['proactivity'] ?? 0.55,
    readPresence: async () => {
      if (presenceMode === 'none') return null;
      const row = store.worldState(PRESENCE_KEY, { now: toOffsetIso(clock.now(), clock.offsetMinutes) });
      return row === null ? null : { present: row.present, updatedAt: row.updatedAt, source: row.source };
    },
    readLastUserTurnAt: () => lastUserTurnAt(store, session.sessionId),
    readRecentUserTopics: () => recentUserTopics(store, session.sessionId),
    readSessionId: () => session.sessionId,
    topicEngine,
    random: options.random ?? (() => 1),
    now: clock.clock,
    offsetMinutes: clock.offsetMinutes,
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  const steps: ReplayStepResult[] = [];
  let ticks = 0;
  /** Highest `proactive.decision` sequence already reported, so a tick owns only its own rows. */
  let decisionWatermark = 0;

  for (const step of document.steps) {
    const at = clock.at(step.offsetMs);
    const writtenAt = toOffsetIso(at, clock.offsetMinutes);
    // The state machine expires its timed states at the script's instant, exactly as it would at
    // the real one: a turn 26 hours later must not look like a continuation of a 30-second window.
    engine.tick();

    switch (step.kind) {
      case 'conversation.turn': {
        const text = stepString(step, 'text');
        const addressed = optionalBoolean(step, 'addressed', true);
        const turn = await engine.respond({ sessionId: session.sessionId, text, addressed });
        steps.push({
          kind: 'conversation.turn',
          step: step.index,
          offset: step.at,
          at: writtenAt,
          text,
          addressed,
          accepted: turn.accepted,
          reason: turn.reason,
          action: turn.action,
          state: turn.state,
          reply: turn.text,
          segments: [...turn.segments],
          history: (turn.prompt?.history ?? []).map((entry) => `${entry.role}:${entry.content}`),
        });
        break;
      }
      case 'presence.changed': {
        const present = stepPresent(step);
        const envelope = buildEvent({
          event_type: 'presence.changed',
          source: optionalString(step, 'source') ?? 'perception.laptop_camera',
          actor: stepActor(step, 'unknown_person'),
          confidence: optionalNumber(step, 'confidence', 0.9),
          timestamp: writtenAt,
          payload: { present, source_detail: `replay ${document.name} step ${step.index}` },
        });
        const outcome = ingestPerceptionLine(`${JSON.stringify({ record: 'event', ...envelope })}\n`, { store });
        steps.push({
          kind: 'presence.changed',
          step: step.index,
          offset: step.at,
          at: writtenAt,
          ingested: outcome.kind === 'ingested',
          note: outcome.kind === 'ingested' ? 'ingested' : `${outcome.kind}: ${outcome.reason}`,
          present,
          eventId: outcome.kind === 'ingested' ? outcome.eventId : null,
          projection: projectionOf(store, at, clock.offsetMinutes),
        });
        break;
      }
      case 'world': {
        const entry = store.setWorldState({
          key: stepString(step, 'key'),
          value: worldValue(step),
          source: `replay:${document.name}`,
          confidence: optionalNumber(step, 'confidence', 1),
          ttlSeconds: optionalTtlSeconds(step, DEFAULT_PRESENCE_TTL_SECONDS),
          timestamp: writtenAt,
        });
        steps.push({
          kind: 'world',
          step: step.index,
          offset: step.at,
          at: writtenAt,
          key: entry.key,
          value: entry.value,
          confidence: entry.confidence,
          ttlSeconds: entry.ttlSeconds,
        });
        break;
      }
      case 'system.health': {
        const status = optionalString(step, 'status') ?? 'ok';
        if (status !== 'ok' && status !== 'degraded' && status !== 'down') {
          throw replayError(`step ${step.index} (system.health): status "${status}" is not ok/degraded/down`);
        }
        const event = store.recordHealth(stepString(step, 'service'), status, optionalString(step, 'detail'));
        steps.push({
          kind: 'system.health',
          step: step.index,
          offset: step.at,
          at: writtenAt,
          service: stepString(step, 'service'),
          status,
          sequence: event.sequence,
        });
        break;
      }
      case 'proactive_tick': {
        const entry = await loop.tickOnce();
        ticks += 1;
        const decisions = store
          .readEvents({ type: 'proactive.decision', sinceSequence: decisionWatermark, limit: Number.MAX_SAFE_INTEGER })
          .map((event) => decisionOf(event));
        for (const decision of decisions) {
          if (decision.sequence > decisionWatermark) decisionWatermark = decision.sequence;
        }
        steps.push({
          kind: 'proactive_tick',
          step: step.index,
          offset: step.at,
          at: writtenAt,
          tick: ticks,
          entry: entry === null
            ? null
            : {
                candidateId: entry.candidateId,
                trigger: entry.trigger,
                initiativeKind: entry.initiativeKind,
                speak: entry.speak,
                reasonCode: entry.reasonCode,
                score: entry.score,
                threshold: entry.threshold,
                text: entry.text,
              },
          decisions,
        });
        break;
      }
    }
  }

  const last = steps[steps.length - 1];
  return {
    name: document.name,
    start: toOffsetIso(clock.start, clock.offsetMinutes),
    offsetMinutes: clock.offsetMinutes,
    end: last?.at ?? toOffsetIso(clock.start, clock.offsetMinutes),
    sessionId: session.sessionId,
    dataDir,
    steps,
    turns: steps.filter((step): step is ReplayTurnResult => step.kind === 'conversation.turn'),
    presence: steps.filter((step): step is ReplayPresenceResult => step.kind === 'presence.changed'),
    ticks: steps.filter((step): step is ReplayTickResult => step.kind === 'proactive_tick'),
    store,
    topicEngine,
    engine,
    loop,
    close: () => {
      store.close();
      // Windows keeps a directory handle alive while SQLite has the file open, so this runs after
      // `store.close()` and never before it.
      if (ownDataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
