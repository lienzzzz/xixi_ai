/**
 * The Proactive Engine (《方案》§15/§16, ADR-0009 → **ADR-0011**) — the program half.
 *
 * P5 (2026-10-01) split the decision in two, because the V0.1 shape ("one weighted
 * average vs one threshold, plus a fixed cooldown") turned 主动开口 into a timer:
 *
 *   facts → candidate → **hard floor (program, non-negotiable)** → signals + score
 *         → **the model reads the room** → at-most-once delivery + one audit record
 *
 * 1. **Hard floor** (静默时段 / 当日与 6 小时额度 / DND / 隐私与同意 / 场景与音频路径 /
 *    同一候选重复) is decided here, in code. A model can never widen it (铁律 1/3).
 * 2. **Above the floor the model decides whether to speak.** The deterministic half
 *    only *proposes*: a social-budget score built from 话题质量分 / 相关性 / 新鲜度 /
 *    读空气 / 互动度 / 基础主动性 minus 打扰代价（冷却）/ 话题重复惩罚 / 未回应惩罚,
 *    plus a `recommendation` derived from the score. Cooldown, topic repetition and
 *    unanswered messages are **grades, not gates** — a strong candidate can pass right
 *    after a weak one, and a continuation during a live conversation carries no cooldown
 *    at all (pack §14.3: `conversation continuation cooldown = 0`).
 *
 * Audit (铁律 5): every decision writes one `proactive.decision` event carrying the
 * candidate id, trigger, initiative kind, `speak`, `reason_code`, the score and the
 * threshold, **every signal**, the `primary_signal`, a `basis` of program-rendered
 * Chinese lines (numbers → words, never model prose), who decided (`decided_by`) and —
 * when the model declined — one code from the fixed `PROACTIVE_MODEL_REASON_CODES`
 * allowlist. Never the user's words, never model reasoning.
 *
 * Delivery is **at most once**: the event is appended, with `delivered: true`,
 * *before* anything is spoken. A crash between the two can lose one message but
 * can never repeat one (AGENTS.md §3).
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

// -------------------------------------------------------- initiative kinds

/**
 * Pack §14.1's `initiativeKind`. The kind decides how much a recent message costs:
 * 新会话 pays the interruption grade, 热聊中接话 (continuation) pays none, and the
 * other kinds pay their own trigger's grade.
 */
export const PROACTIVE_INITIATIVE_KINDS = Object.freeze([
  'new_session',
  'conversation_continuation',
  'open_loop_followup',
  'environment_reaction',
  'external_sharing',
] as const);

export type ProactiveInitiativeKind = (typeof PROACTIVE_INITIATIVE_KINDS)[number];

/** The trigger's default kind; a candidate may state its own (`ProactiveCandidate.initiativeKind`). */
const INITIATIVE_OF_TRIGGER: Readonly<Record<ProactiveTrigger, ProactiveInitiativeKind>> = Object.freeze({
  future_hook_due: 'open_loop_followup',
  presence_arrived: 'environment_reaction',
  routine_expected: 'environment_reaction',
  conversation_dangling: 'conversation_continuation',
  topic_pool: 'external_sharing',
  random_smalltalk: 'new_session',
});

export function initiativeKindForTrigger(trigger: ProactiveTrigger): ProactiveInitiativeKind {
  return INITIATIVE_OF_TRIGGER[trigger];
}

export const PROACTIVE_INITIATIVE_LABELS: Readonly<Record<ProactiveInitiativeKind, string>> = Object.freeze({
  new_session: '开一段新会话',
  conversation_continuation: '热聊中接话',
  open_loop_followup: '接着没聊完的事',
  environment_reaction: '对家里的动静有反应',
  external_sharing: '分享外面的事',
});

// -------------------------------------------------------------- reason codes

/**
 * One code per outcome, in the order the gates are evaluated. The first hard-floor gate
 * that fires wins, so the log always names exactly one cause.
 *
 * The last three are *judgements*, not vetoes: `BELOW_RECOMMENDATION` is the
 * deterministic half saying "I would not speak now" (the `basis` names why), and
 * `MODEL_DECLINED` is the model reading the room and choosing silence. `PASSED` means
 * the floor was cleared **and** whoever owns the decision said speak.
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
  /** Privacy or consent says no — no microphone, no camera, no proactive speech (§20.1). */
  'PRIVACY_BLOCKED',
  /** The rolling 6-hour budget is spent. */
  'QUOTA_6H_EXCEEDED',
  /** Today's **delivery** budget is spent (local natural day; consultations are charged separately). */
  'QUOTA_DAY_EXCEEDED',
  /** Today's **consultation** budget is spent — the model can no longer be asked today (t9 F4). */
  'QUOTA_CONSULT_EXCEEDED',
  /** A conversation is open (a continuation may still speak) or a turn is in flight. */
  'CONVERSATION_ACTIVE',
  /**
   * The new-session **rate floor** (t9 F6): a non-continuation proactive message spoke less than
   * `new_session_min_gap_min` ago. This is the one temporal rule that still *blocks* — deliberately
   * much narrower than ADR-0011 retired: it covers only 「不是热聊接话」的主动, its window is a
   * couple of minutes (the pack's 18-minute cooldown stays a grade), and 热聊中接话 is exempt
   * (pack §14.3, the Phase-5 goal 「不受 18 分钟 new-session cooldown 限制」).
   */
  'NEW_SESSION_FLOOR',
  /** Media is playing, a call is up, or the room is otherwise unsuitable. */
  'SCENE_UNAVAILABLE',
  /** The voice output path is not usable. */
  'SPEECH_UNAVAILABLE',
  /** The floor was cleared, but the deterministic social budget recommends holding. */
  'BELOW_RECOMMENDATION',
  /** The floor was cleared, the budget allowed it, and the model chose not to speak (读空气). */
  'MODEL_DECLINED',
  /** The floor was cleared and the decision was to speak. */
  'PASSED',
] as const);

export type ProactiveReasonCode = (typeof PROACTIVE_REASON_CODES)[number];

/**
 * Codes ADR-0009 used and P5 retired — **never re-emitted**, but they stay declared because
 * events already in the log carry them: the console must still label an old decision, and a
 * replay must not meet a code the code base no longer knows (ADR-0011: the log is the
 * history; retiring a reason is not rewriting it).
 */
export const PROACTIVE_RETIRED_REASON_CODES = Object.freeze([
  /** V0.1: too soon after the last message — a veto. Now `interruption_cost` inside the score. */
  'COOLDOWN_ACTIVE',
  /** V0.1: the same topic inside the window — a veto. Now `repeated_topic_penalty`. */
  'TOPIC_REPEATED',
  /** V0.1: the single weighted average missed the threshold. Now `BELOW_RECOMMENDATION`. */
  'SCORE_BELOW_THRESHOLD',
] as const);

export type ProactiveRetiredReasonCode = (typeof PROACTIVE_RETIRED_REASON_CODES)[number];

/** Everything a `proactive.decision` record may contain, retired codes included. */
export const PROACTIVE_KNOWN_REASON_CODES: readonly (ProactiveReasonCode | ProactiveRetiredReasonCode)[] = Object.freeze([
  ...PROACTIVE_REASON_CODES,
  ...PROACTIVE_RETIRED_REASON_CODES,
]);

/**
 * What the model may say about *why* it held back — a fixed allowlist, never free text
 * (铁律 5: reason codes and scores, no private reasoning). `unspecified` is the safe
 * value for anything else a provider returns.
 */
export const PROACTIVE_MODEL_REASON_CODES = Object.freeze([
  'good_moment',
  'user_busy',
  'user_quiet',
  'already_said',
  'not_worth_it',
  'wrong_moment',
  'unspecified',
] as const);

export type ProactiveModelReasonCode = (typeof PROACTIVE_MODEL_REASON_CODES)[number];

export const PROACTIVE_MODEL_REASON_LABELS: Readonly<Record<ProactiveModelReasonCode, string>> = Object.freeze({
  good_moment: '时机合适',
  user_busy: '他正在忙',
  user_quiet: '他刚说想安静',
  already_said: '这事刚说过',
  not_worth_it: '这事不值得打断',
  wrong_moment: '这会儿不合适',
  unspecified: '没给具体理由',
});

/** Anything the provider returns that is not on the allowlist becomes `unspecified`. */
export function normalizeModelReasonCode(value: string | null | undefined): ProactiveModelReasonCode {
  const code = (value ?? '').trim().toLowerCase();
  return (PROACTIVE_MODEL_REASON_CODES as readonly string[]).includes(code)
    ? (code as ProactiveModelReasonCode)
    : 'unspecified';
}

// -------------------------------------------------------------------- score

/**
 * Pack §14.2's social budget, as weights over clamped signals:
 *
 *   topic_quality + personal_relevance + freshness + receptivity + engagement + base_proactivity
 *   − interruption_cost − repeated_topic_penalty − recent_unanswered_penalty
 *
 * The positive weights add up to 1 so a perfect candidate scores 1; the penalties max out
 * at −0.75. These replace ADR-0009's equal-weight §15.4 components: that average could not
 * tell "a specific, relevant, well-timed topic" apart from "seven mediocre facts".
 */
export const PROACTIVE_SCORE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  topic_quality: 0.3,
  personal_relevance: 0.15,
  freshness: 0.1,
  receptivity: 0.2,
  engagement: 0.1,
  base_proactivity: 0.15,
  interruption_cost: -0.15,
  repeated_topic_penalty: -0.25,
  recent_unanswered_penalty: -0.35,
});

/** The signals the social budget is made of, in the order the basis lists them. */
export const PROACTIVE_SIGNALS = Object.freeze([
  'topic_quality',
  'personal_relevance',
  'freshness',
  'receptivity',
  'engagement',
  'base_proactivity',
  'interruption_cost',
  'repeated_topic_penalty',
  'recent_unanswered_penalty',
] as const);

export type ProactiveSignal = (typeof PROACTIVE_SIGNALS)[number];

/** Chinese labels for the console and for the audit `basis` (program-rendered, no model prose). */
export const PROACTIVE_SIGNAL_LABELS: Readonly<Record<ProactiveSignal, string>> = Object.freeze({
  topic_quality: '话题质量分',
  personal_relevance: '跟他个人的相关度',
  freshness: '这件事的新鲜度',
  receptivity: '读空气（他这会儿愿不愿意聊）',
  engagement: '当前互动热度',
  base_proactivity: '主动性基线',
  interruption_cost: '打扰代价（上次开口多久了）',
  repeated_topic_penalty: '话题重复惩罚',
  recent_unanswered_penalty: '未回应惩罚',
});

/** Which signal the decision hangs on: the heaviest penalty, else `score`. */
export const PROACTIVE_PRIMARY_SIGNALS = Object.freeze([
  'topic_quality',
  'receptivity',
  'interruption_cost',
  'repeated_topic_penalty',
  'recent_unanswered_penalty',
  'score',
] as const);

export type ProactivePrimarySignal = (typeof PROACTIVE_PRIMARY_SIGNALS)[number];

/**
 * The baseline from `config/xixi.example.yaml`; used when nothing is persisted.
 *
 * 0.85 (the household has raised this twice: 0.55 → 0.70 → 0.85), which moves the
 * *recommendation* bar from 0.585 down to `0.45 + 0.30 × (1 − 0.85) = 0.495`. It only moves
 * the bar — every hard-floor gate still applies（铁律 3）and the model can still decline.
 * A test asserts this constant and the shipped config agree.
 */
export const DEFAULT_PROACTIVITY = 0.85;

/**
 * Score a candidate from its signals.
 *
 * Each signal is clamped into `[0, 1]`, multiplied by its weight, and the sum is
 * clamped into `[0, 1]`. A missing signal counts as `0` rather than throwing: a
 * candidate generator that can only supply three facts should produce a low score, not
 * crash the consideration loop.
 */
export function scoreProactiveCandidate(components: Readonly<Record<string, number>> | undefined): number {
  let total = 0;
  for (const [name, weight] of Object.entries(PROACTIVE_SCORE_WEIGHTS)) {
    total += weight * clamp01(components?.[name] ?? 0);
  }
  return round4(clamp01(total));
}

/**
 * `threshold = 0.45 + 0.30 × (1 − proactivity)` (ADR-0009 §4) — now the bar for the
 * deterministic **recommendation**, not a veto (ADR-0011 §决定 2).
 */
export function proactiveThreshold(proactivity: number): number {
  return round4(0.45 + 0.3 * (1 - clamp01(proactivity)));
}

// ----------------------------------------------------------------- settings

export interface ProactiveSettings {
  readonly enabled: boolean;
  /**
   * 新会话的打扰代价衰减窗口（原「冷却」）。Within it, speaking again costs
   * `interruption_cost` — it no longer blocks anything (ADR-0011).
   */
  readonly baseCooldownMinutes: number;
  /** 热聊中接话 (continuation) has no interruption cost at all (pack §14.3). */
  readonly continuationCooldownMinutes: number;
  readonly maxPer6h: number;
  readonly maxPerDay: number;
  /**
   * How many paid 读空气 consultations one local day may spend (t9 F4).
   *
   * Consultations used to be charged to `maxPerDay` together with delivered messages, so a model
   * that kept answering 「不说」 ate the whole speaking budget and the day went silent even when the
   * moment was good. The two budgets are separate now: deliveries spend `maxPerDay`, consultations
   * spend this one — it is the count-based cost proxy for the paid calls (铁律 3, no monetary cap
   * exists in this repo).
   */
  readonly maxConsultsPerDay: number;
  /**
   * The new-session **rate floor** in minutes (t9 F6): a non-continuation proactive message may
   * not be delivered sooner than this after the previous delivery. `0` disables the floor.
   * 热聊中接话 (`conversation_continuation`) is exempt — pack §14.3 keeps that path free.
   */
  readonly newSessionMinGapMinutes: number;
  /**
   * What counts as 「正在热聊」 (pack §14.3): a live conversation **and** at least this many user turns
   * inside {@link hotChatWindowMinutes}. One stray remark does not make a hot chat — see
   * {@link ProactiveSettings.hotChatWindowMinutes}. `0`/`1` both mean 「只要对话还开着就算」.
   */
  readonly hotChatMinTurns: number;
  /** The window {@link ProactiveSettings.hotChatMinTurns} counts user turns over, in minutes. */
  readonly hotChatWindowMinutes: number;
  /** How long "the same topic" keeps its repetition penalty. */
  readonly topicRepeatWindowHours: number;
  /** A generic line (no `topicRef`) pays its own, longer window (pack: 24 h). */
  readonly genericTopicCooldownHours: number;
  /** The penalty for having just spoken again (multiplied after negative feedback). */
  readonly unansweredPenalty: number;
  /** "别说了 / 今天不想聊" — the strongest penalty (pack: 0.80). */
  readonly explicitRejectPenalty: number;
  /** The penalty for repeating a topic (pack: 0.55). */
  readonly sameTopicPenalty: number;
  /** How long a proactive message waits for an answer before it counts as unanswered. */
  readonly unansweredWindowMinutes: number;
  /** Tightens the penalties after the last proactive message drew negative feedback. */
  readonly negativeFeedbackCooldownMultiplier: number;
  readonly quietHours: { readonly startMinutes: number; readonly endMinutes: number };
  readonly triggers: Readonly<Record<ProactiveTrigger, boolean>>;
}

/**
 * Exactly the factory defaults declared in `config/xixi.example.yaml`:
 * 18 min interruption window / 0 min for continuations / 15 per 6 h / 40 deliveries per day /
 * 120 consultations per day (t9 F4: a separate budget) / a 2-minute new-session rate floor
 * (t9 F6, 热聊接话 exempt) / 12 h same-topic window / 24 h generic window, quiet hours
 * 23:30–07:30. The penalty values are the pack's `config/xixi.v02.example.yaml`
 * (`unanswered: 0.45`, `explicit_reject: 0.80`, `same_topic: 0.55`). It is only the fallback for a
 * config that has no `proactive` section at all, so it must stay numerically identical to the
 * shipped config — a test compares both against the same hand-written example object.
 */
export const DEFAULT_PROACTIVE_SETTINGS: ProactiveSettings = Object.freeze({
  enabled: true,
  baseCooldownMinutes: 18,
  continuationCooldownMinutes: 0,
  maxPer6h: 15,
  maxPerDay: 40,
  // t9 F4: consultations get their own daily count — three times the delivery budget leaves room
  // for every delivery to be preceded by a 读空气 call plus a margin of 「不说」 decisions.
  maxConsultsPerDay: 120,
  // t9 F6: a narrow, auditable floor for starting a new thread (热聊接话 is exempt).
  newSessionMinGapMinutes: 2,
  // t9 F5: 「正在热聊」 is a back-and-forth, not a single remark — see `deriveProactiveSignals`.
  hotChatMinTurns: 2,
  hotChatWindowMinutes: 15,
  topicRepeatWindowHours: 12,
  genericTopicCooldownHours: 24,
  unansweredPenalty: 0.45,
  explicitRejectPenalty: 0.8,
  sameTopicPenalty: 0.55,
  unansweredWindowMinutes: 10,
  negativeFeedbackCooldownMultiplier: 2.0,
  quietHours: Object.freeze({ startMinutes: 23 * 60 + 30, endMinutes: 7 * 60 + 30 }),
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
 * conversation down. The *safety* boundaries — the quiet-hours window, the budget
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
    continuationCooldownMinutes: numberField(source, 'continuation_cooldown_min', fallback.continuationCooldownMinutes, 0, 24 * 60),
    maxPer6h: numberField(source, 'max_per_6h', fallback.maxPer6h, 0, 100),
    maxPerDay: numberField(source, 'max_per_day', fallback.maxPerDay, 0, 100),
    maxConsultsPerDay: numberField(source, 'max_consults_per_day', fallback.maxConsultsPerDay, 0, 1000),
    newSessionMinGapMinutes: numberField(source, 'new_session_min_gap_min', fallback.newSessionMinGapMinutes, 0, 240),
    hotChatMinTurns: numberField(source, 'hot_chat_min_turns', fallback.hotChatMinTurns, 0, 50),
    hotChatWindowMinutes: numberField(source, 'hot_chat_window_min', fallback.hotChatWindowMinutes, 0, 24 * 60),
    topicRepeatWindowHours: numberField(source, 'topic_repeat_window_h', fallback.topicRepeatWindowHours, 0, 24 * 30),
    genericTopicCooldownHours: numberField(
      source,
      'generic_topic_cooldown_h',
      fallback.genericTopicCooldownHours,
      0,
      24 * 30,
    ),
    unansweredPenalty: numberField(source, 'unanswered_penalty', fallback.unansweredPenalty, 0, 1),
    explicitRejectPenalty: numberField(source, 'explicit_reject_penalty', fallback.explicitRejectPenalty, 0, 1),
    sameTopicPenalty: numberField(source, 'same_topic_penalty', fallback.sameTopicPenalty, 0, 1),
    unansweredWindowMinutes: numberField(source, 'unanswered_window_min', fallback.unansweredWindowMinutes, 1, 120),
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

/** `"23:30"` → 1410. Anything else keeps `fallback` (documented default). */
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
 * (23:30 → 07:30). `start === end` is an empty window, not a 24-hour one: the
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
 * Only records with `speak: true` count: a blocked consideration — and a model's
 * "不说" — are explanations, not budget items. Because the whole state a gate needs
 * lives in this list, quotas and the penalty grades survive a restart with no extra
 * bookkeeping, and stay reproducible from the log alone.
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

/**
 * When the household last said something, from the log.
 *
 * The 未回应惩罚 needs to know whether a proactive message was ever answered, and the only
 * source of truth for that is `conversation.turn` (role `user`) — not a second table.
 */
export function readUserTurnTimes(store: XixiStore): number[] {
  const times: number[] = [];
  for (const event of store.readEvents({ type: 'conversation.turn', limit: Number.MAX_SAFE_INTEGER })) {
    const payload = event.payload as Record<string, unknown>;
    if (payload['role'] !== 'user') continue;
    const at = new Date(event.timestamp).getTime();
    if (Number.isFinite(at)) times.push(at);
  }
  return times;
}

/**
 * When the model was consulted about a candidate, from the log.
 *
 * "读空气" costs a real call, so it is accounted for with its own daily **count** budget
 * (`max_consults_per_day`) — separate from the delivery budget `max_per_day` (t9 F4: charging both
 * to one number let a model that kept answering 「不说」 eat the day's speaking quota, and the day
 * went silent even when the moment was good). The count is the cost proxy: this repo has no
 * monetary cap (铁律 3, ADR-0011 代价一节). `model_consulted: true` on the audit record is what makes
 * the cost visible.
 */
export function readProactiveConsultations(store: XixiStore): Date[] {
  const times: Date[] = [];
  for (const event of store.readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })) {
    const payload = event.payload as Record<string, unknown>;
    if (payload['model_consulted'] !== true) continue;
    const at = new Date(event.timestamp);
    if (Number.isFinite(at.getTime())) times.push(at);
  }
  return times;
}

// -------------------------------------------------------------------- gates

export interface ProactiveCandidate {
  /** Stable id of one intended message; the dedupe key (restart safety). */
  readonly candidateId: string;
  readonly trigger: ProactiveTrigger;
  /** The initiative kind; defaults to the trigger's kind (pack §14.1). */
  readonly initiativeKind?: ProactiveInitiativeKind | undefined;
  /** Signals, e.g. `{ topic_quality: 0.8, freshness: 0.5, receptivity: 0.6 }`. */
  readonly components: Readonly<Record<string, number>>;
  readonly topicRef?: string | null | undefined;
  readonly intent?: string | null | undefined;
}

export interface ProactiveGateContext {
  readonly settings: ProactiveSettings;
  readonly now: Date;
  readonly offsetMinutes?: number | undefined;
  /** Effective `SelfModel.proactivity`; enters the score as `base_proactivity`. */
  readonly proactivity: number;
  readonly conversationState: ConversationState;
  readonly inFlightTurn: boolean;
  /** The last proactive message drew negative feedback → the penalties are multiplied. */
  readonly negativeFeedback: boolean;
  /** "别说了" / "今天不想聊": the strongest penalty, and it counts as unanswered. */
  readonly explicitReject?: boolean | undefined;
  readonly sceneAvailable: boolean;
  readonly speechAvailable: boolean;
  /**
   * Privacy / consent (§20.1, 铁律 6/8): no proactive speech when the household has not
   * allowed it. A hard floor — the model is never consulted.
   */
  readonly privacyAllowed?: boolean | undefined;
  /** Delivered messages, oldest first (see `readProactiveHistory`). */
  readonly history: readonly ProactiveDeliveryRecord[];
  /** User turns (epoch ms), for the 未回应惩罚 (see `readUserTurnTimes`). */
  readonly userTurns?: readonly number[] | undefined;
  /**
   * How many times today the model was already consulted (see
   * `readProactiveConsultations`). Asking the model is a real call, so it is spent from its own
   * daily **count** budget (`max_consults_per_day`), never from the delivery budget — t9 F4:
   * refusals must not eat the day's speaking quota. Note what this budget is: the project has no
   * monetary cost cap, so the message-count quota is the cost proxy (铁律 3).
   */
  readonly consultsToday?: number | undefined;
}

export interface ProactiveSignalsView {
  /**
   * The table is also read **by signal name** (`scoreProactiveCandidate` and the basis lines walk
   * `PROACTIVE_SCORE_WEIGHTS` / `PROACTIVE_SIGNALS`), so it says so: every value in this view is a
   * number, and an unknown name is a programming error rather than a shape change.
   */
  readonly [signal: string]: number;
  readonly topic_quality: number;
  readonly personal_relevance: number;
  readonly freshness: number;
  readonly receptivity: number;
  readonly engagement: number;
  readonly base_proactivity: number;
  readonly interruption_cost: number;
  readonly repeated_topic_penalty: number;
  readonly recent_unanswered_penalty: number;
}

export interface ProactiveGateResult {
  /** The **hard floor** was cleared. Whether to speak is `recommendation` + the model. */
  readonly pass: boolean;
  readonly reasonCode: ProactiveReasonCode;
  readonly score: number;
  readonly threshold: number;
  /** What the deterministic half suggests; the model may still decline or go ahead. */
  readonly recommendation: 'speak' | 'hold';
  readonly signals: ProactiveSignalsView;
  readonly primarySignal: ProactivePrimarySignal;
  /** Program-rendered Chinese lines explaining the numbers above (never model prose). */
  readonly basis: readonly string[];
}

/** How many recent deliveries the 未回应惩罚 looks at. */
const UNANSWERED_LOOKBACK = 3;

/**
 * Turn the candidate's facts plus the log into the social budget's signals.
 *
 * The candidate supplies what the caller knows (how good the topic is, how willing the
 * household seems); the program adds what only it can see — how recently it spoke, whether
 * this topic was used, and whether recent proactive messages were answered at all. Every
 * penalty is a **grade**: the closer the event, the heavier, and the candidate's own value
 * still wins when it is larger.
 */
export function deriveProactiveSignals(
  candidate: ProactiveCandidate,
  context: ProactiveGateContext,
): ProactiveSignalsView {
  const supplied = (name: ProactiveSignal): number => clamp01(candidate.components[name] ?? 0);
  const nowMs = context.now.getTime();
  const past = context.history.filter((record) => record.at.getTime() <= nowMs);
  const kind = candidate.initiativeKind ?? initiativeKindForTrigger(candidate.trigger);
  const multiplier = context.negativeFeedback ? context.settings.negativeFeedbackCooldownMultiplier : 1;

  const interruption = Math.max(supplied('interruption_cost'), clamp01(cooldownGrade(kind, context, past) * multiplier));
  const repeatedTopic = Math.max(supplied('repeated_topic_penalty'), topicGrade(candidate, context, past));
  // t9 F5 (and the reading F2 needs): 未回应惩罚 means **「她说了，没人回来」**. While a hot chat is
  // going on (see `isHotChat`) the person *is* talking to her right now, so the condition that
  // signal names is false by construction and 热聊接话 (a `conversation_continuation`) is not charged
  // it. Without this the two Phase-5 goals contradicted each other in practice: after a morning
  // nobody answered, the streak grade sits at its ceiling, and since even the best continuation's
  // raw score (0.7825) cannot clear `0.495 + 0.35`, the live-chat path stayed shut for the whole
  // day — and could not recover either, because a graded-out candidate is never delivered and so
  // never gets answered. The exemption is deliberately narrow (`isHotChat`: a live conversation
  // *plus* a real back-and-forth, never a stray remark), because an ignored day must still go
  // quiet (F2). The caller-supplied component and `explicitReject` are untouched.
  const unanswered = Math.max(
    supplied('recent_unanswered_penalty'),
    context.explicitReject === true
      ? context.settings.explicitRejectPenalty
      : isHotChat(kind, context)
        ? 0
        : clamp01(unansweredGrade(context, past) * multiplier),
  );

  return {
    topic_quality: supplied('topic_quality'),
    personal_relevance: supplied('personal_relevance'),
    freshness: supplied('freshness'),
    receptivity: supplied('receptivity'),
    engagement: supplied('engagement'),
    base_proactivity: clamp01(context.proactivity),
    interruption_cost: round4(interruption),
    repeated_topic_penalty: round4(repeatedTopic),
    recent_unanswered_penalty: round4(unanswered),
  };
}

/**
 * Is the household **in the middle of a hot chat** with her (pack §14.3 / t9 F5)?
 *
 * Three conditions, all of them observable from the log and the FSM — no model call, no invented
 * fact:
 *
 *   1. the candidate is 热聊接话 (`conversation_continuation`) — this exemption exists for that path
 *      only (a new thread never gets it);
 *   2. the conversation is still open (`conversationState !== 'IDLE'`): the FSM says someone just
 *      spoke to her and the thread has not closed;
 *   3. at least `hotChatMinTurns` user turns fall inside the last `hotChatWindowMinutes`.
 *
 * Condition 3 is what makes it 「热聊」 rather than 「刚才有人说过一句话」: t9 F5 needed the live-chat
 * path to work after a morning nobody answered, but a *stray remark* must not cancel the
 * 未回应惩罚 — an ignored day (where the household's own chatter is spread hours apart) still has
 * to go quiet, which is exactly what Phase 5's 「两次未回应后显著降频」 demands.
 */
function isHotChat(kind: ProactiveInitiativeKind, context: ProactiveGateContext): boolean {
  if (kind !== 'conversation_continuation') return false;
  if (context.conversationState === 'IDLE') return false;
  const windowMs = context.settings.hotChatWindowMinutes * 60_000;
  const minimum = Math.max(1, context.settings.hotChatMinTurns);
  const nowMs = context.now.getTime();
  const recent = (context.userTurns ?? []).filter((at) => at <= nowMs && nowMs - at <= windowMs).length;
  return recent >= minimum;
}

/** A countdown over the kind's window: 1 right after speaking, 0 once the window has passed. */
function cooldownGrade(
  kind: ProactiveInitiativeKind,
  context: ProactiveGateContext,
  past: readonly ProactiveDeliveryRecord[],
): number {
  const minutes =
    kind === 'conversation_continuation'
      ? context.settings.continuationCooldownMinutes
      : context.settings.baseCooldownMinutes;
  if (minutes <= 0) return 0;
  const last = past.at(-1);
  if (last === undefined) return 0;
  const elapsed = context.now.getTime() - last.at.getTime();
  return clamp01(1 - elapsed / (minutes * 60_000));
}

/** The same topic (or the same *kind* of generic line) inside its window. */
function topicGrade(
  candidate: ProactiveCandidate,
  context: ProactiveGateContext,
  past: readonly ProactiveDeliveryRecord[],
): number {
  const topic = candidate.topicRef ?? null;
  const windowHours = topic === null || topic.length === 0
    ? context.settings.genericTopicCooldownHours
    : context.settings.topicRepeatWindowHours;
  if (windowHours <= 0) return 0;
  const windowMs = windowHours * 60 * 60 * 1000;
  let grade = 0;
  for (const record of past) {
    const same = topic === null || topic.length === 0 ? record.topicRef === null : record.topicRef === topic;
    if (!same) continue;
    const elapsed = context.now.getTime() - record.at.getTime();
    if (elapsed >= windowMs) continue;
    grade = Math.max(grade, clamp01(1 - elapsed / windowMs));
  }
  return grade * context.settings.sameTopicPenalty;
}

/**
 * How hard the 未回应惩罚 presses right now (t9 F2 fixed the saturation here).
 *
 * Two parts, added together and clamped into `[0, 1]`:
 *
 *   1. **ratio** — the unanswered share of the last {@link UNANSWERED_LOOKBACK} deliveries
 *      (unchanged from P5: one stale non-answer among recent messages still costs something);
 *   2. **streak escalation** — `unansweredPenalty × 0.5 × (consecutive − 1)` for the trailing run
 *      of deliveries nobody ever answered. 1 → base, 2 → 1.5×, 3 → 2× (0.45 / 0.675 / 0.90 with
 *      the pack default): 「连续两次没人回应」 is now a strictly heavier grade than 「一条」, which
 *      is what makes 显著降频 reachable on the timeline — the old ratio alone was saturated
 *      (1/3/5 non-answers all yielded the same number when the ratio already sat at 1).
 */
function unansweredGrade(context: ProactiveGateContext, past: readonly ProactiveDeliveryRecord[]): number {
  if (past.length === 0) return 0;
  const windowMs = context.settings.unansweredWindowMinutes * 60_000;
  const userTurns = context.userTurns ?? [];
  const answered = (record: ProactiveDeliveryRecord): boolean =>
    userTurns.some((at) => at > record.at.getTime() && at <= record.at.getTime() + windowMs);
  const recent = past.slice(-UNANSWERED_LOOKBACK);
  let unanswered = 0;
  for (const record of recent) {
    if (!answered(record)) unanswered += 1;
  }
  if (unanswered === 0) return 0;
  let streak = 0;
  for (let index = past.length - 1; index >= 0; index -= 1) {
    const record = past[index];
    if (record === undefined || answered(record)) break;
    streak += 1;
  }
  const base = context.settings.unansweredPenalty;
  const ratioPart = (unanswered / recent.length) * base;
  const streakPart = streak >= 1 ? base * 0.5 * (streak - 1) : 0;
  return clamp01(ratioPart + streakPart);
}

/**
 * The heaviest drag on the decision, else the biggest positive signal.
 *
 * It exists so the audit can answer "为什么这次没说" with one word as well as with the
 * whole `basis`.
 */
function primarySignalOf(signals: ProactiveSignalsView, recommendation: 'speak' | 'hold'): ProactivePrimarySignal {
  if (recommendation === 'hold') {
    const penalties: readonly { readonly signal: ProactivePrimarySignal; readonly value: number }[] = [
      { signal: 'interruption_cost', value: signals.interruption_cost * Math.abs(PROACTIVE_SCORE_WEIGHTS['interruption_cost'] ?? 0) },
      {
        signal: 'repeated_topic_penalty',
        value: signals.repeated_topic_penalty * Math.abs(PROACTIVE_SCORE_WEIGHTS['repeated_topic_penalty'] ?? 0),
      },
      {
        signal: 'recent_unanswered_penalty',
        value: signals.recent_unanswered_penalty * Math.abs(PROACTIVE_SCORE_WEIGHTS['recent_unanswered_penalty'] ?? 0),
      },
    ];
    const heaviest = penalties.reduce((best, current) => (current.value > best.value ? current : best));
    if (heaviest.value > 0) return heaviest.signal;
    // No penalty to blame: the candidate simply is not interesting enough.
    return signals.topic_quality <= signals.receptivity ? 'topic_quality' : 'receptivity';
  }
  return signals.topic_quality >= signals.receptivity ? 'topic_quality' : 'receptivity';
}

/**
 * Render the numbers into short Chinese lines — the auditable 依据 the acceptance asks for.
 *
 * Program text only: every line is a value plus its weight, so the record can never carry
 * model prose (铁律 5).
 */
export function proactiveBasis(
  signals: ProactiveSignalsView,
  score: number,
  threshold: number,
  recommendation: 'speak' | 'hold',
): string[] {
  const lines: string[] = [];
  for (const signal of PROACTIVE_SIGNALS) {
    const weight = PROACTIVE_SCORE_WEIGHTS[signal] ?? 0;
    const value = signals[signal];
    if (value === 0) continue;
    const contribution = round4(value * weight);
    lines.push(`${PROACTIVE_SIGNAL_LABELS[signal]} ${value}（权重 ${weight} → ${contribution >= 0 ? '+' : ''}${contribution}）`);
  }
  lines.push(
    `社会预算总分 ${score}，${recommendation === 'speak' ? '达到' : '低于'}建议线 ${threshold} → ${
      recommendation === 'speak' ? '建议开口，等他读空气' : '建议这次不说'
    }`,
  );
  return lines;
}

/**
 * Evaluate the **hard floor** (ADR-0011 §决定 1) in a fixed, documented order, and compute
 * the social budget + recommendation for everything above it.
 *
 * The order is part of the contract, because it decides which single reason code is logged
 * when several gates would fire: switch → trigger switch → duplicate → DND → quiet hours →
 * privacy → budgets → conversation → scene → speech. Cheap, absolute refusals come first, so
 * the logged reason is the most fundamental one. The score never blocks anything by itself —
 * a below-recommendation candidate is reported as `recommendation: 'hold'`, and the model (or
 * the caller) decides.
 */
export function evaluateProactiveGates(
  candidate: ProactiveCandidate,
  context: ProactiveGateContext,
): ProactiveGateResult {
  const signals = deriveProactiveSignals(candidate, context);
  const score = scoreProactiveCandidate(signals);
  const threshold = proactiveThreshold(context.proactivity);
  const recommendation: 'speak' | 'hold' = score >= threshold ? 'speak' : 'hold';
  const primarySignal = primarySignalOf(signals, recommendation);
  const basis = proactiveBasis(signals, score, threshold, recommendation);
  const block = (reasonCode: ProactiveReasonCode): ProactiveGateResult => ({
    pass: false,
    reasonCode,
    score,
    threshold,
    recommendation,
    signals,
    primarySignal,
    basis,
  });

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

  // 隐私与同意（铁律 6/8）: a hard floor, checked before any budget is spent on the turn.
  if (context.privacyAllowed === false) return block('PRIVACY_BLOCKED');

  const within6h = past.filter((record) => nowMs - record.at.getTime() < 6 * 60 * 60 * 1000).length;
  if (within6h >= tightenBudget(settings.maxPer6h, multiplierOf(context))) return block('QUOTA_6H_EXCEEDED');

  const day = localDayOf(context.now, context.offsetMinutes);
  const today = past.filter((record) => localDayOf(record.at, context.offsetMinutes) === day).length;
  if (today >= tightenBudget(settings.maxPerDay, multiplierOf(context))) return block('QUOTA_DAY_EXCEEDED');

  // t9 F4: the two budgets are separate. Deliveries spend `maxPerDay`; the paid 读空气 calls spend
  // `maxConsultsPerDay`, so a conservative model answering 「说」/「不说」 can no longer eat the day's
  // speaking quota with its refusals. Both are count quotas — the project has no monetary cap, so
  // counts stand in for cost (铁律 3).
  if ((context.consultsToday ?? 0) >= tightenBudget(settings.maxConsultsPerDay, multiplierOf(context))) {
    return block('QUOTA_CONSULT_EXCEEDED');
  }

  // A turn in flight always waits. An open conversation only stops *new sessions*: the pack's
  // whole point is that a welcomed chat may continue without re-passing a cooldown (§14.3).
  const kind = candidate.initiativeKind ?? initiativeKindForTrigger(candidate.trigger);
  if (context.inFlightTurn) return block('CONVERSATION_ACTIVE');
  if (context.conversationState !== 'IDLE' && kind !== 'conversation_continuation') {
    return block('CONVERSATION_ACTIVE');
  }

  // t9 F6: the new-session **rate floor** — before this, no temporal lower bound existed at all
  // (the 18-minute cooldown is only a score grade, ADR-0011). Deliberately narrow: only
  // non-continuation messages, only inside `new_session_min_gap_min`, auditable as its own code.
  if (kind !== 'conversation_continuation' && settings.newSessionMinGapMinutes > 0) {
    const last = past.at(-1);
    if (last !== undefined && nowMs - last.at.getTime() < settings.newSessionMinGapMinutes * 60_000) {
      return block('NEW_SESSION_FLOOR');
    }
  }

  if (!context.sceneAvailable) return block('SCENE_UNAVAILABLE');
  if (!context.speechAvailable) return block('SPEECH_UNAVAILABLE');

  return {
    pass: true,
    reasonCode: recommendation === 'speak' ? 'PASSED' : 'BELOW_RECOMMENDATION',
    score,
    threshold,
    recommendation,
    signals,
    primarySignal,
    basis,
  };
}

function multiplierOf(context: ProactiveGateContext): number {
  return context.negativeFeedback ? context.settings.negativeFeedbackCooldownMultiplier : 1;
}

/**
 * Negative feedback tightens the budget: `floor(cap / multiplier)`, never below
 * 1 (the multiplier must not turn "less often" into "never again").
 */
function tightenBudget(cap: number, multiplier: number): number {
  if (multiplier <= 1) return cap;
  return Math.max(1, Math.floor(cap / multiplier));
}

// ------------------------------------------------------------- model decision

/** What the model sees when it is asked "说还是不说". Numbers and labels only — no prompt prose. */
export interface ProactiveModelInput {
  readonly candidate: ProactiveCandidate;
  readonly initiativeKind: ProactiveInitiativeKind;
  readonly signals: ProactiveSignalsView;
  readonly score: number;
  readonly threshold: number;
  readonly recommendation: 'speak' | 'hold';
  readonly primarySignal: ProactivePrimarySignal;
  readonly basis: readonly string[];
  /** How heavily the recent proactive messages went unanswered (0..1; the escalated grade divided back by the base penalty, clamped). */
  readonly unansweredRatio: number;
  readonly now: Date;
}

/** The model's answer: whether to speak, and — auditable — one reason code from the allowlist. */
export interface ProactiveModelDecision {
  readonly speak: boolean;
  readonly reasonCode: string;
  readonly intent?: string | null | undefined;
  readonly topicRef?: string | null | undefined;
}

/** The 读空气 seam. A throwing or unavailable model counts as "不说", never as a yes. */
export type ProactiveDecider = (input: ProactiveModelInput) => ProactiveModelDecision | Promise<ProactiveModelDecision>;

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
  /** The default 读空气 seam; `consider({ decide })` wins over it. */
  readonly decide?: ProactiveDecider | undefined;
}

/** What the caller needs in order to actually speak an accepted candidate. */
export interface ProactiveDelivery {
  readonly candidateId: string;
  readonly trigger: ProactiveTrigger;
  readonly initiativeKind: ProactiveInitiativeKind;
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
  /** "别说了" / "今天不想聊". */
  readonly explicitReject?: boolean | undefined;
  readonly sceneAvailable?: boolean | undefined;
  readonly speechAvailable?: boolean | undefined;
  readonly privacyAllowed?: boolean | undefined;
  readonly sessionId?: string | null | undefined;
  /** The 读空气 seam for this consideration; wins over the engine's default. */
  readonly decide?: ProactiveDecider | undefined;
  /**
   * The M5 seam: turn an accepted candidate into speech. Awaited, so the caller
   * can serialize playback. Never called when the floor blocked the candidate or when
   * the decision was "不说".
   */
  readonly deliver?: ((delivery: ProactiveDelivery) => void | Promise<void>) | undefined;
}

export interface ProactiveOutcome {
  /** The decision was to speak (and delivery was attempted). */
  readonly speak: boolean;
  /** The audit record already counts this message as delivered (at-most-once). */
  readonly delivered: boolean;
  readonly reasonCode: ProactiveReasonCode;
  readonly candidateId: string;
  readonly trigger: ProactiveTrigger;
  readonly initiativeKind: ProactiveInitiativeKind;
  readonly score: number;
  readonly threshold: number;
  readonly recommendation: 'speak' | 'hold';
  readonly primarySignal: ProactivePrimarySignal;
  readonly signals: ProactiveSignalsView;
  readonly basis: readonly string[];
  /** Who made the call: the deterministic half or the model. */
  readonly decidedBy: 'program' | 'model';
  /** The model's own code when it was asked, else null. */
  readonly modelReasonCode: ProactiveModelReasonCode | null;
  /** Whether this consideration paid for a model call (counted against the daily budget). */
  readonly modelConsulted: boolean;
  readonly sessionId: string | null;
  /** The appended `proactive.decision` event; `null` only when the engine is off. */
  readonly event: StoredEvent | null;
}

/**
 * The consideration loop's only entry point: judge one candidate, let the model read the
 * room above the hard floor, and deliver at most once.
 */
export class ProactiveEngine {
  readonly #store: XixiStore;
  readonly #settings: ProactiveSettings;
  readonly #clock: Clock;
  readonly #offsetMinutes: number | undefined;
  readonly #decide: ProactiveDecider | undefined;

  constructor(options: ProactiveEngineOptions) {
    this.#store = options.store;
    this.#settings = options.settings ?? parseProactiveSettings(options.config);
    this.#clock = options.clock ?? systemClock;
    this.#offsetMinutes = options.offsetMinutes;
    this.#decide = options.decide;
  }

  get settings(): ProactiveSettings {
    return this.#settings;
  }

  /** Whether a 读空气 seam is wired (the console and the resident loop do). */
  get hasDecider(): boolean {
    return this.#decide !== undefined;
  }

  /**
   * Judge `input.candidate` now.
   *
   * One event is appended per decision, including blocked ones and the model's "不说",
   * because "为什么今天西西没来找我说话" is exactly what the log has to answer. The one
   * exception is `DISABLED`: a switched-off engine is not a decision, and logging every
   * poll of a disabled loop would bury the real history.
   */
  async consider(input: ProactiveConsiderInput): Promise<ProactiveOutcome> {
    const at = input.at ?? this.#clock();
    const sessionId = input.sessionId ?? null;
    const proactivity = input.proactivity ?? this.#store.selfProfile()['proactivity'] ?? DEFAULT_PROACTIVITY;
    const consultations = readProactiveConsultations(this.#store);
    const consultsToday = consultations.filter(
      (consultedAt) => localDayOf(consultedAt, this.#offsetMinutes) === localDayOf(at, this.#offsetMinutes),
    ).length;
    const result = evaluateProactiveGates(input.candidate, {
      settings: this.#settings,
      now: at,
      offsetMinutes: this.#offsetMinutes,
      proactivity,
      conversationState: input.conversationState,
      inFlightTurn: input.inFlightTurn ?? false,
      negativeFeedback: input.negativeFeedback ?? false,
      explicitReject: input.explicitReject ?? false,
      sceneAvailable: input.sceneAvailable ?? true,
      speechAvailable: input.speechAvailable ?? true,
      privacyAllowed: input.privacyAllowed ?? true,
      history: readProactiveHistory(this.#store),
      userTurns: readUserTurnTimes(this.#store),
      consultsToday,
    });
    const initiativeKind = input.candidate.initiativeKind ?? initiativeKindForTrigger(input.candidate.trigger);

    const base = {
      candidateId: input.candidate.candidateId,
      trigger: input.candidate.trigger,
      initiativeKind,
      score: result.score,
      threshold: result.threshold,
      recommendation: result.recommendation,
      primarySignal: result.primarySignal,
      signals: result.signals,
      basis: result.basis,
      sessionId,
    } as const;

    if (!result.pass) {
      if (result.reasonCode === 'DISABLED') {
        return {
          ...base,
          speak: false,
          delivered: false,
          reasonCode: 'DISABLED',
          decidedBy: 'program',
          modelReasonCode: null,
          modelConsulted: false,
          event: null,
        };
      }
      return {
        ...base,
        speak: false,
        delivered: false,
        reasonCode: result.reasonCode,
        decidedBy: 'program',
        modelReasonCode: null,
        modelConsulted: false,
        event: this.#record({
          input,
          at,
          sessionId,
          reasonCode: result.reasonCode,
          speak: false,
          delivered: false,
          result,
          decidedBy: 'program',
          modelReasonCode: null,
          modelConsulted: false,
        }),
      };
    }

    // Above the floor, only a candidate the social budget already considers worth it is put to the
    // model: "obviously not now" never costs a paid call, and the paid calls are counted against
    // their own daily budget (see `readProactiveConsultations`). A missing or failing model
    // never *becomes* a yes — it degrades to the deterministic recommendation.
    const decider = input.decide ?? this.#decide;
    let decidedBy: 'program' | 'model' = 'program';
    let modelReasonCode: ProactiveModelReasonCode | null = null;
    let modelConsulted = false;
    let speak = result.recommendation === 'speak';
    let deliveryCandidate = input.candidate;
    if (decider !== undefined && result.recommendation === 'speak') {
      decidedBy = 'model';
      modelConsulted = true;
      const modelInput: ProactiveModelInput = {
        candidate: input.candidate,
        initiativeKind,
        signals: result.signals,
        score: result.score,
        threshold: result.threshold,
        recommendation: result.recommendation,
        primarySignal: result.primarySignal,
        basis: result.basis,
        unansweredRatio: clamp01(round4(result.signals.recent_unanswered_penalty / (this.#settings.unansweredPenalty || 1))),
        now: at,
      };
      try {
        const decision = await decider(modelInput);
        modelReasonCode = normalizeModelReasonCode(decision.reasonCode);
        speak = decision.speak === true;
        deliveryCandidate = {
          ...input.candidate,
          ...(decision.topicRef === undefined ? {} : { topicRef: decision.topicRef }),
          ...(decision.intent === undefined ? {} : { intent: decision.intent }),
        };
      } catch {
        // A provider failure is a "不说" with an honest reason code, never a silent go-ahead.
        speak = false;
        modelReasonCode = 'wrong_moment';
      }
    }
    const reasonCode: ProactiveReasonCode = speak
      ? 'PASSED'
      : decidedBy === 'model'
        ? 'MODEL_DECLINED'
        : 'BELOW_RECOMMENDATION';

    if (!speak) {
      return {
        ...base,
        speak: false,
        delivered: false,
        reasonCode,
        decidedBy,
        modelReasonCode,
        modelConsulted,
        event: this.#record({
          input,
          at,
          sessionId,
          reasonCode,
          speak: false,
          delivered: false,
          result,
          decidedBy,
          modelReasonCode,
          modelConsulted,
        }),
      };
    }

    // At-most-once, in this order on purpose: the log is written first, so a
    // crash before or during playback leaves a record that blocks a re-delivery
    // on the next start. The trade is stated: we may lose one message, never
    // repeat one.
    const event = this.#record({
      input: { ...input, candidate: deliveryCandidate },
      at,
      sessionId,
      reasonCode: 'PASSED',
      speak: true,
      delivered: true,
      result,
      decidedBy,
      modelReasonCode,
      modelConsulted,
    });
    await input.deliver?.({
      candidateId: deliveryCandidate.candidateId,
      trigger: deliveryCandidate.trigger,
      initiativeKind,
      intent: deliveryCandidate.intent ?? null,
      topicRef: deliveryCandidate.topicRef ?? null,
      score: result.score,
      threshold: result.threshold,
      sessionId,
    });
    return { ...base, speak: true, delivered: true, reasonCode: 'PASSED', decidedBy, modelReasonCode, modelConsulted, event };
  }

  #record(input: {
    readonly input: ProactiveConsiderInput;
    readonly at: Date;
    readonly sessionId: string | null;
    /** The decision's own code — the floor's code when the floor blocked, else the judgement. */
    readonly reasonCode: ProactiveReasonCode;
    readonly speak: boolean;
    readonly delivered: boolean;
    readonly result: ProactiveGateResult;
    readonly decidedBy: 'program' | 'model';
    readonly modelReasonCode: ProactiveModelReasonCode | null;
    readonly modelConsulted: boolean;
  }): StoredEvent {
    const { candidate } = input.input;
    const initiativeKind = candidate.initiativeKind ?? initiativeKindForTrigger(candidate.trigger);
    return this.#store.appendEvent(
      buildEvent({
        event_type: 'proactive.decision',
        source: 'conversation',
        actor: 'system',
        confidence: 1,
        timestamp: toOffsetIso(input.at),
        payload: {
          session_id: input.sessionId,
          candidate_id: candidate.candidateId,
          trigger: candidate.trigger,
          initiative_kind: initiativeKind,
          speak: input.speak,
          reason_code: input.reasonCode,
          score: input.result.score,
          threshold: input.result.threshold,
          recommendation: input.result.recommendation,
          primary_signal: input.result.primarySignal,
          signals: { ...input.result.signals },
          basis: [...input.result.basis],
          decided_by: input.decidedBy,
          model_reason_code: input.modelReasonCode,
          model_consulted: input.modelConsulted,
          topic_ref: candidate.topicRef ?? null,
          intent: candidate.intent ?? null,
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
