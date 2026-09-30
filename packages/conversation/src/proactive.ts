/**
 * The Proactive Engine (《方案》§15/§16, ADR-0009) — the program half.
 *
 * Two steps, and the first one is never the model (ADR-0009 §1):
 *
 *   facts → candidate (program computes the score) → **hard gates** → only then
 *   ask the model what to say.
 *
 * Everything in this file is deterministic: the score is a weighted sum of
 * clamped components, the threshold is a closed-form function of `proactivity`,
 * and every gate is a pure comparison over the event log plus an injected clock.
 * The model cannot skip a gate (铁律 3) and cannot be persuaded to skip one — it
 * is not consulted until the gates have already said yes.
 *
 * Audit (铁律 5): each decision writes one `proactive.decision` event carrying the
 * candidate id, trigger, `speak`, `reason_code`, the score and the threshold —
 * never the user's words and never model reasoning.
 *
 * Delivery is **at most once**: the event is appended, with `delivered: true`,
 * *before* anything is spoken. A crash between the two can lose one message but
 * can never repeat one, which is the failure mode §3 of AGENTS.md cares about —
 * a restart must not re-deliver a proactive message already spoken.
 */

import { buildEvent, toOffsetIso } from '@xixi/contracts';
import type { Clock, StoredEvent, XixiStore } from '@xixi/domain';
import { systemClock } from '@xixi/domain';

import type { ConversationState } from './fsm.ts';

// ----------------------------------------------------------------- triggers

/** §16 priority order; `random_smalltalk` is off by default ("没有合适的话题就不要开口"). */
export const PROACTIVE_TRIGGERS = Object.freeze([
  'future_hook_due',
  'presence_arrived',
  'conversation_dangling',
  'routine_expected',
  'topic_pool',
  'random_smalltalk',
] as const);

export type ProactiveTrigger = (typeof PROACTIVE_TRIGGERS)[number];

// -------------------------------------------------------------- reason codes

/**
 * One code per outcome, in the order the gates are evaluated. The first gate
 * that fires wins, so the log always names exactly one cause.
 */
export const PROACTIVE_REASON_CODES = Object.freeze([
  /** The engine is switched off; nothing is considered and nothing is logged. */
  'DISABLED',
  /** This trigger source is switched off (`triggers.*`). */
  'TRIGGER_DISABLED',
  /** The same candidate id was already delivered (restart / retry safety). */
  'ALREADY_DELIVERED',
  /** `/quiet`, or "今天我想安静点" — the FSM is SUSPENDED. */
  'DND_ACTIVE',
  /** Inside the configured quiet hours (the safety floor: nothing may widen it). */
  'QUIET_HOURS',
  /** Too soon after the last delivered proactive message. */
  'COOLDOWN_ACTIVE',
  /** The rolling 6-hour budget is spent. */
  'QUOTA_6H_EXCEEDED',
  /** Today's budget is spent (local natural day). */
  'QUOTA_DAY_EXCEEDED',
  /** The same `topic_ref` was already used inside the suppression window. */
  'TOPIC_REPEATED',
  /** A conversation is open, or a turn is still in flight. */
  'CONVERSATION_ACTIVE',
  /** The candidate's score did not reach the threshold. */
  'SCORE_BELOW_THRESHOLD',
  /** Media is playing, a call is up, or the room is otherwise unsuitable. */
  'SCENE_UNAVAILABLE',
  /** The voice output path is not usable. */
  'SPEECH_UNAVAILABLE',
  /** Every gate passed: the candidate may be spoken. */
  'PASSED',
] as const);

export type ProactiveReasonCode = (typeof PROACTIVE_REASON_CODES)[number];

// -------------------------------------------------------------------- score

/**
 * §15.4's components, equal weight `0.1` (ADR-0009 §4); the negative terms enter
 * with a negative weight, so a high `interruption_risk` lowers the score.
 */
export const PROACTIVE_SCORE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  event_salience: 0.1,
  social_value: 0.1,
  memory_relevance: 0.1,
  novelty: 0.1,
  time_since_last_interaction: 0.1,
  user_receptiveness: 0.1,
  future_hook_bonus: 0.1,
  interruption_risk: -0.1,
  recent_proactive_penalty: -0.1,
  repetition_penalty: -0.1,
  uncertainty_penalty: -0.1,
});

/**
 * The baseline from `config/xixi.example.yaml`; used when nothing is persisted.
 *
 * 0.70 (not the older 0.55): the household chose a more willing default in ADR-0009,
 * which moves the threshold from 0.585 down to `0.45 + 0.30 × (1 − 0.70) = 0.54`.
 * It only moves the bar — every hard gate still applies（铁律 3）。
 */
export const DEFAULT_PROACTIVITY = 0.7;

/**
 * Score a candidate from its §15.4 components.
 *
 * Each component is clamped into `[0, 1]`, multiplied by its weight, and the sum
 * is clamped into `[0, 1]` (ADR-0009 §4). A missing component counts as `0`
 * rather than throwing: a candidate generator that can only supply three facts
 * should produce a low score, not crash the consideration loop.
 */
export function scoreProactiveCandidate(components: Readonly<Record<string, number>> | undefined): number {
  let total = 0;
  for (const [name, weight] of Object.entries(PROACTIVE_SCORE_WEIGHTS)) {
    total += weight * clamp01(components?.[name] ?? 0);
  }
  return round4(clamp01(total));
}

/**
 * `threshold = 0.45 + 0.30 × (1 − proactivity)` (ADR-0009 §4).
 *
 * `proactivity` only moves the threshold; it can never disable a gate, and the
 * threshold can never fall below the `0.45` floor — "更激进" is expressed in the
 * budget parameters, not in skipping checks.
 */
export function proactiveThreshold(proactivity: number): number {
  return round4(0.45 + 0.3 * (1 - clamp01(proactivity)));
}

// ----------------------------------------------------------------- settings

export interface ProactiveSettings {
  readonly enabled: boolean;
  readonly baseCooldownMinutes: number;
  readonly maxPer6h: number;
  readonly maxPerDay: number;
  readonly topicRepeatWindowHours: number;
  /** Tightens cooldown and budget after the last proactive message drew negative feedback. */
  readonly negativeFeedbackCooldownMultiplier: number;
  readonly quietHours: { readonly startMinutes: number; readonly endMinutes: number };
  readonly triggers: Readonly<Record<ProactiveTrigger, boolean>>;
}

/** Exactly the defaults declared in `config/xixi.example.yaml` and ADR-0009 §5. */
export const DEFAULT_PROACTIVE_SETTINGS: ProactiveSettings = Object.freeze({
  enabled: true,
  baseCooldownMinutes: 25,
  maxPer6h: 4,
  maxPerDay: 8,
  topicRepeatWindowHours: 12,
  negativeFeedbackCooldownMultiplier: 2.0,
  quietHours: Object.freeze({ startMinutes: 22 * 60 + 30, endMinutes: 7 * 60 }),
  triggers: Object.freeze({
    future_hook_due: true,
    presence_arrived: true,
    conversation_dangling: true,
    routine_expected: true,
    topic_pool: true,
    random_smalltalk: false,
  }),
});

/**
 * Read `config.proactive` (§42) into typed settings.
 *
 * Unusable values fall back to the documented default instead of failing the
 * process: this section is a tuning knob, and a typo in it must not take the
 * conversation down. The *safety* boundaries — the quiet-hours floor, the budget
 * caps — are enforced in the gate code itself, not by the parser.
 */
export function parseProactiveSettings(source?: Readonly<Record<string, unknown>> | undefined): ProactiveSettings {
  const fallback = DEFAULT_PROACTIVE_SETTINGS;
  const quiet = isMapping(source?.['quiet_hours']) ? (source?.['quiet_hours'] as Record<string, unknown>) : undefined;
  const triggersSource = isMapping(source?.['triggers']) ? (source?.['triggers'] as Record<string, unknown>) : undefined;
  const triggers = {} as Record<ProactiveTrigger, boolean>;
  for (const trigger of PROACTIVE_TRIGGERS) {
    triggers[trigger] = booleanField(triggersSource, trigger, fallback.triggers[trigger]);
  }
  return {
    enabled: booleanField(source, 'enabled', fallback.enabled),
    baseCooldownMinutes: numberField(source, 'base_cooldown_min', fallback.baseCooldownMinutes, 0, 24 * 60),
    maxPer6h: numberField(source, 'max_per_6h', fallback.maxPer6h, 0, 100),
    maxPerDay: numberField(source, 'max_per_day', fallback.maxPerDay, 0, 100),
    topicRepeatWindowHours: numberField(source, 'topic_repeat_window_h', fallback.topicRepeatWindowHours, 0, 24 * 30),
    negativeFeedbackCooldownMultiplier: numberField(
      source,
      'negative_feedback_cooldown_multiplier',
      fallback.negativeFeedbackCooldownMultiplier,
      1,
      10,
    ),
    quietHours: {
      startMinutes: parseClockMinutes(quiet?.['start'], fallback.quietHours.startMinutes),
      endMinutes: parseClockMinutes(quiet?.['end'], fallback.quietHours.endMinutes),
    },
    triggers,
  };
}

/** `"22:30"` → 1350. Anything else keeps `fallback` (documented default). */
export function parseClockMinutes(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

/**
 * `[start, end)` in local minutes, the window allowed to cross midnight
 * (22:30 → 07:00). `start === end` is an empty window, not a 24-hour one: the
 * safe reading of an ambiguous setting is "no quiet window configured", and the
 * quiet-hours *floor* is a separate, non-configurable concern.
 */
export function isWithinQuietHours(localMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return localMinutes >= startMinutes && localMinutes < endMinutes;
  return localMinutes >= startMinutes || localMinutes < endMinutes;
}

/**
 * Minutes since the local midnight of `at`.
 *
 * `offsetMinutes` is the test/replay seam; live code leaves it undefined and the
 * runtime's own local time is used, which is what "静默时段按本地时区" means.
 */
export function localMinutesOf(at: Date, offsetMinutes?: number | undefined): number {
  if (offsetMinutes === undefined) return at.getHours() * 60 + at.getMinutes();
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** `YYYY-MM-DD` of the local natural day (§15.6 "当日额度"). */
export function localDayOf(at: Date, offsetMinutes?: number | undefined): string {
  if (offsetMinutes === undefined) {
    const month = `${at.getMonth() + 1}`.padStart(2, '0');
    const day = `${at.getDate()}`.padStart(2, '0');
    return `${at.getFullYear()}-${month}-${day}`;
  }
  return new Date(at.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ history

/** One already-delivered proactive message, rebuilt from the event log. */
export interface ProactiveDeliveryRecord {
  readonly candidateId: string;
  readonly at: Date;
  readonly topicRef: string | null;
  readonly sequence: number;
}

/**
 * Recompute the delivery history from the log (§22.3).
 *
 * Only records with `speak: true` count: a blocked consideration is an
 * explanation, not a budget item. Because the whole state a gate needs lives in
 * this list, quotas, cooldown and the topic window survive a restart with no
 * extra bookkeeping — and stay reproducible from the log alone.
 */
export function readProactiveHistory(store: XixiStore): ProactiveDeliveryRecord[] {
  const records: ProactiveDeliveryRecord[] = [];
  for (const event of store.readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })) {
    const payload = event.payload as Record<string, unknown>;
    if (payload['speak'] !== true) continue;
    const candidateId = payload['candidate_id'];
    if (typeof candidateId !== 'string' || candidateId.length === 0) continue;
    records.push({
      candidateId,
      at: new Date(event.timestamp),
      topicRef: typeof payload['topic_ref'] === 'string' ? payload['topic_ref'] : null,
      sequence: event.sequence,
    });
  }
  return records;
}

// -------------------------------------------------------------------- gates

export interface ProactiveCandidate {
  /** Stable id of one intended message; the dedupe key (restart safety). */
  readonly candidateId: string;
  readonly trigger: ProactiveTrigger;
  /** §15.4 components, e.g. `{ event_salience: 0.8, novelty: 0.5 }`. */
  readonly components: Readonly<Record<string, number>>;
  readonly topicRef?: string | null | undefined;
  readonly intent?: string | null | undefined;
}

export interface ProactiveGateContext {
  readonly settings: ProactiveSettings;
  readonly now: Date;
  readonly offsetMinutes?: number | undefined;
  /** Effective `SelfModel.proactivity`; only moves the threshold. */
  readonly proactivity: number;
  readonly conversationState: ConversationState;
  readonly inFlightTurn: boolean;
  /** The last proactive message drew negative feedback → tighten cooldown and budget. */
  readonly negativeFeedback: boolean;
  readonly sceneAvailable: boolean;
  readonly speechAvailable: boolean;
  /** Delivered messages, oldest first (see `readProactiveHistory`). */
  readonly history: readonly ProactiveDeliveryRecord[];
}

export interface ProactiveGateResult {
  readonly pass: boolean;
  readonly reasonCode: ProactiveReasonCode;
  readonly score: number;
  readonly threshold: number;
}

/**
 * Evaluate the nine hard gates (ADR-0009 §3) in a fixed, documented order and
 * return the first one that fires.
 *
 * The order is part of the contract, because it decides which single reason code
 * is logged when several gates would fire: switch → trigger switch → duplicate →
 * DND → quiet hours → cooldown → budgets → topic → conversation → score →
 * scene → speech. Cheap, absolute refusals come first, so the logged reason is
 * the most fundamental one; the score comparison comes late because it is the
 * only judgement that can be argued about.
 */
export function evaluateProactiveGates(
  candidate: ProactiveCandidate,
  context: ProactiveGateContext,
): ProactiveGateResult {
  const score = scoreProactiveCandidate(candidate.components);
  const threshold = proactiveThreshold(context.proactivity);
  const block = (reasonCode: ProactiveReasonCode): ProactiveGateResult => ({ pass: false, reasonCode, score, threshold });

  const { settings, history } = context;
  const nowMs = context.now.getTime();
  // A record timestamped in the future belongs to a replay, not to this decision.
  const past = history.filter((record) => record.at.getTime() <= nowMs);

  if (!settings.enabled) return block('DISABLED');
  if (settings.triggers[candidate.trigger] === false) return block('TRIGGER_DISABLED');
  if (past.some((record) => record.candidateId === candidate.candidateId)) return block('ALREADY_DELIVERED');
  if (context.conversationState === 'SUSPENDED') return block('DND_ACTIVE');

  const localMinutes = localMinutesOf(context.now, context.offsetMinutes);
  if (isWithinQuietHours(localMinutes, settings.quietHours.startMinutes, settings.quietHours.endMinutes)) {
    return block('QUIET_HOURS');
  }

  const multiplier = context.negativeFeedback ? settings.negativeFeedbackCooldownMultiplier : 1;
  const last = past.at(-1) ?? null;
  if (last !== null && nowMs - last.at.getTime() < settings.baseCooldownMinutes * multiplier * 60_000) {
    return block('COOLDOWN_ACTIVE');
  }

  const within6h = past.filter((record) => nowMs - record.at.getTime() < 6 * 60 * 60 * 1000).length;
  if (within6h >= tightenBudget(settings.maxPer6h, multiplier)) return block('QUOTA_6H_EXCEEDED');

  const day = localDayOf(context.now, context.offsetMinutes);
  const today = past.filter((record) => localDayOf(record.at, context.offsetMinutes) === day).length;
  if (today >= tightenBudget(settings.maxPerDay, multiplier)) return block('QUOTA_DAY_EXCEEDED');

  const topic = candidate.topicRef ?? null;
  if (topic !== null && topic.length > 0) {
    const windowMs = settings.topicRepeatWindowHours * 60 * 60 * 1000;
    const repeated = past.some((record) => record.topicRef === topic && nowMs - record.at.getTime() < windowMs);
    if (repeated) return block('TOPIC_REPEATED');
  }

  if (context.conversationState !== 'IDLE' || context.inFlightTurn) return block('CONVERSATION_ACTIVE');
  if (score < threshold) return block('SCORE_BELOW_THRESHOLD');
  if (!context.sceneAvailable) return block('SCENE_UNAVAILABLE');
  if (!context.speechAvailable) return block('SPEECH_UNAVAILABLE');

  return { pass: true, reasonCode: 'PASSED', score, threshold };
}

/**
 * Negative feedback tightens the budget: `floor(cap / multiplier)`, never below
 * 1 (the multiplier must not turn "less often" into "never again"). Documented
 * here because ADR-0009 §5 says the multiplier applies to cooldown *and* budget
 * without spelling out the arithmetic.
 */
function tightenBudget(cap: number, multiplier: number): number {
  if (multiplier <= 1) return cap;
  return Math.max(1, Math.floor(cap / multiplier));
}

// ------------------------------------------------------------------- engine

export interface ProactiveEngineOptions {
  readonly store: XixiStore;
  /** `config.proactive`, straight from `XixiConfig`. */
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  /** Already-parsed settings; wins over `config` (tests, replay, admin override). */
  readonly settings?: ProactiveSettings | undefined;
  readonly clock?: Clock | undefined;
  /** Local UTC offset override, for tests and replay. */
  readonly offsetMinutes?: number | undefined;
}

/** What the caller needs in order to actually speak an accepted candidate. */
export interface ProactiveDelivery {
  readonly candidateId: string;
  readonly trigger: ProactiveTrigger;
  readonly intent: string | null;
  readonly topicRef: string | null;
  readonly score: number;
  readonly threshold: number;
  readonly sessionId: string | null;
}

export interface ProactiveConsiderInput {
  readonly candidate: ProactiveCandidate;
  readonly at?: Date | undefined;
  /** The FSM state at this instant (`ConversationEngine.state`). */
  readonly conversationState: ConversationState;
  readonly inFlightTurn?: boolean | undefined;
  /** Effective proactivity; defaults to the persisted self profile. */
  readonly proactivity?: number | undefined;
  readonly negativeFeedback?: boolean | undefined;
  readonly sceneAvailable?: boolean | undefined;
  readonly speechAvailable?: boolean | undefined;
  readonly sessionId?: string | null | undefined;
  /**
   * The M5 seam: turn an accepted candidate into speech. Awaited, so the caller
   * can serialize playback. Never called when a gate blocked the candidate.
   */
  readonly deliver?: ((delivery: ProactiveDelivery) => void | Promise<void>) | undefined;
}

export interface ProactiveOutcome {
  /** The gates said yes (and delivery was attempted). */
  readonly speak: boolean;
  /** The audit record already counts this message as delivered (at-most-once). */
  readonly delivered: boolean;
  readonly reasonCode: ProactiveReasonCode;
  readonly candidateId: string;
  readonly trigger: ProactiveTrigger;
  readonly score: number;
  readonly threshold: number;
  readonly sessionId: string | null;
  /** The appended `proactive.decision` event; `null` only when the engine is off. */
  readonly event: StoredEvent | null;
}

/**
 * The consideration loop's only entry point: judge one candidate and, when it
 * passes every gate, deliver it at most once.
 */
export class ProactiveEngine {
  readonly #store: XixiStore;
  readonly #settings: ProactiveSettings;
  readonly #clock: Clock;
  readonly #offsetMinutes: number | undefined;

  constructor(options: ProactiveEngineOptions) {
    this.#store = options.store;
    this.#settings = options.settings ?? parseProactiveSettings(options.config);
    this.#clock = options.clock ?? systemClock;
    this.#offsetMinutes = options.offsetMinutes;
  }

  get settings(): ProactiveSettings {
    return this.#settings;
  }

  /**
   * Judge `input.candidate` now.
   *
   * One event is appended per decision, including blocked ones, because "为什么
   * 今天西西没来找我说话" is exactly what the log has to answer. The one exception
   * is `DISABLED`: a switched-off engine is not a decision, and logging every
   * poll of a disabled loop would bury the real history.
   */
  async consider(input: ProactiveConsiderInput): Promise<ProactiveOutcome> {
    const at = input.at ?? this.#clock();
    const sessionId = input.sessionId ?? null;
    const proactivity = input.proactivity ?? this.#store.selfProfile()['proactivity'] ?? DEFAULT_PROACTIVITY;
    const result = evaluateProactiveGates(input.candidate, {
      settings: this.#settings,
      now: at,
      offsetMinutes: this.#offsetMinutes,
      proactivity,
      conversationState: input.conversationState,
      inFlightTurn: input.inFlightTurn ?? false,
      negativeFeedback: input.negativeFeedback ?? false,
      sceneAvailable: input.sceneAvailable ?? true,
      speechAvailable: input.speechAvailable ?? true,
      history: readProactiveHistory(this.#store),
    });

    const base = {
      reasonCode: result.reasonCode,
      candidateId: input.candidate.candidateId,
      trigger: input.candidate.trigger,
      score: result.score,
      threshold: result.threshold,
      sessionId,
    } as const;

    if (!result.pass) {
      if (result.reasonCode === 'DISABLED') return { ...base, speak: false, delivered: false, event: null };
      return {
        ...base,
        speak: false,
        delivered: false,
        event: this.#record({ candidate: input.candidate, at, sessionId, speak: false, delivered: false, result }),
      };
    }

    // At-most-once, in this order on purpose: the log is written first, so a
    // crash before or during playback leaves a record that blocks a re-delivery
    // on the next start. The trade is stated: we may lose one message, never
    // repeat one.
    const event = this.#record({ candidate: input.candidate, at, sessionId, speak: true, delivered: true, result });
    await input.deliver?.({
      candidateId: input.candidate.candidateId,
      trigger: input.candidate.trigger,
      intent: input.candidate.intent ?? null,
      topicRef: input.candidate.topicRef ?? null,
      score: result.score,
      threshold: result.threshold,
      sessionId,
    });
    return { ...base, speak: true, delivered: true, event };
  }

  #record(input: {
    readonly candidate: ProactiveCandidate;
    readonly at: Date;
    readonly sessionId: string | null;
    readonly speak: boolean;
    readonly delivered: boolean;
    readonly result: ProactiveGateResult;
  }): StoredEvent {
    return this.#store.appendEvent(
      buildEvent({
        event_type: 'proactive.decision',
        source: 'conversation',
        actor: 'system',
        confidence: 1,
        timestamp: toOffsetIso(input.at),
        payload: {
          session_id: input.sessionId,
          candidate_id: input.candidate.candidateId,
          trigger: input.candidate.trigger,
          speak: input.speak,
          reason_code: input.result.reasonCode,
          score: input.result.score,
          threshold: input.result.threshold,
          topic_ref: input.candidate.topicRef ?? null,
          intent: input.candidate.intent ?? null,
          delivered: input.delivered,
        },
      }),
    );
  }
}

// ------------------------------------------------------------------ helpers

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Log- and test-stable precision: an audited number must not move in the 15th digit. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function isMapping(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function booleanField(source: Readonly<Record<string, unknown>> | undefined, key: string, fallback: boolean): boolean {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

function numberField(
  source: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = source?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
