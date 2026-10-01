import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROACTIVE_SETTINGS,
  DEFAULT_PROACTIVITY,
  deriveProactiveSignals,
  evaluateProactiveGates,
  initiativeKindForTrigger,
  isWithinQuietHours,
  localDayOf,
  localMinutesOf,
  parseClockMinutes,
  parseProactiveSettings,
  proactiveBasis,
  proactiveThreshold,
  PROACTIVE_KNOWN_REASON_CODES,
  PROACTIVE_REASON_CODES,
  PROACTIVE_RETIRED_REASON_CODES,
  PROACTIVE_SCORE_WEIGHTS,
  PROACTIVE_SIGNALS,
  PROACTIVE_SIGNAL_LABELS,
  PROACTIVE_TRIGGERS,
  scoreProactiveCandidate,
  type ProactiveCandidate,
  type ProactiveDeliveryRecord,
  type ProactiveGateContext,
  type ProactiveSettings,
} from '@xixi/conversation';

/**
 * P5 / ADR-0011, one boundary pair per rule.
 *
 * The two things these tests exist to protect:
 *   1. **The hard floor is program-only** — quiet hours, budgets, privacy/consent, DND, scene and
 *      "don't talk over a live chat" can never be talked out of (铁律 1/3).
 *   2. **Everything above the floor is a grade, not a veto** — a recent message, a repeated topic
 *      and unanswered messages all *lower* the social budget instead of blocking, and the model's
 *      own decision is covered in `proactive-decision.test.ts`.
 */

const OFFSET = 480; // Asia/Shanghai
// 14:00 local — outside the 23:30–07:30 quiet window, and comfortably inside the day.
const AFTERNOON = new Date('2026-09-30T14:00:00+08:00');

/** The five positive signals at 1: 0.85 of the budget, before `base_proactivity` is added. */
const STRONG: Readonly<Record<string, number>> = {
  topic_quality: 1,
  personal_relevance: 1,
  freshness: 1,
  receptivity: 1,
  engagement: 1,
};

function candidate(overrides: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  return { candidateId: 'cand_1', trigger: 'topic_pool', components: STRONG, ...overrides };
}

function context(overrides: Partial<ProactiveGateContext> = {}): ProactiveGateContext {
  return {
    settings: DEFAULT_PROACTIVE_SETTINGS,
    now: AFTERNOON,
    offsetMinutes: OFFSET,
    proactivity: DEFAULT_PROACTIVITY,
    conversationState: 'IDLE',
    inFlightTurn: false,
    negativeFeedback: false,
    sceneAvailable: true,
    speechAvailable: true,
    privacyAllowed: true,
    history: [],
    userTurns: [],
    ...overrides,
  };
}

function delivered(candidateId: string, at: Date, topicRef: string | null = null): ProactiveDeliveryRecord {
  return { candidateId, at, topicRef, sequence: 0 };
}

function settings(overrides: Partial<ProactiveSettings> = {}): ProactiveSettings {
  return { ...DEFAULT_PROACTIVE_SETTINGS, ...overrides };
}

function at(iso: string): Date {
  return new Date(iso);
}

function minutesBefore(base: Date, minutes: number): Date {
  return new Date(base.getTime() - minutes * 60_000);
}

// --------------------------------------------------------------- the budget

test('the score is the clamped, weighted sum of the P5 social budget', () => {
  assert.equal(scoreProactiveCandidate(undefined), 0);
  assert.equal(scoreProactiveCandidate({}), 0);
  assert.equal(scoreProactiveCandidate({ topic_quality: 1 }), 0.3, 'topic quality weighs 0.30');
  assert.equal(scoreProactiveCandidate(STRONG), 0.85, 'the five positive signals weigh 1.00 in total');
  // Penalties subtract, and the score never goes below 0.
  const all = { ...STRONG, interruption_cost: 1, repeated_topic_penalty: 1, recent_unanswered_penalty: 1 };
  assert.equal(scoreProactiveCandidate(all), 0.1, '0.85 − 0.75');
  // Out-of-range and unusable signals are clamped, never trusted.
  assert.equal(scoreProactiveCandidate({ topic_quality: 5 }), 0.3);
  assert.equal(scoreProactiveCandidate({ topic_quality: -3, freshness: Number.NaN }), 0);
});

test('the weights still add up to one positive budget and 0.75 of penalties', () => {
  const positives = PROACTIVE_SIGNALS.filter((signal) => (PROACTIVE_SCORE_WEIGHTS[signal] ?? 0) > 0);
  const negatives = PROACTIVE_SIGNALS.filter((signal) => (PROACTIVE_SCORE_WEIGHTS[signal] ?? 0) < 0);
  assert.equal(positives.length, 6, 'five supplied signals + the proactivity baseline');
  assert.equal(negatives.length, 3, 'interruption / repeated topic / unanswered');
  const positiveSum = positives.reduce((sum, signal) => sum + (PROACTIVE_SCORE_WEIGHTS[signal] ?? 0), 0);
  const negativeSum = negatives.reduce((sum, signal) => sum + (PROACTIVE_SCORE_WEIGHTS[signal] ?? 0), 0);
  assert.equal(Math.round(positiveSum * 100) / 100, 1);
  assert.equal(Math.round(negativeSum * 100) / 100, -0.75);
});

test('the recommendation bar follows proactivity and can never fall below the 0.45 floor', () => {
  assert.equal(proactiveThreshold(0.85), 0.495, 'the default baseline from config/xixi.example.yaml');
  assert.equal(proactiveThreshold(1), 0.45);
  assert.equal(proactiveThreshold(0), 0.75);
  assert.equal(proactiveThreshold(2), 0.45, 'clamped: proactivity cannot buy a lower bar');
  assert.equal(proactiveThreshold(-1), 0.75);
  assert.equal(proactiveThreshold(0.5), 0.6);
});

// ---------------------------------------------------------------- settings

test('the config defaults match the shipped config and the pack’s recommended penalties', () => {
  const parsed = parseProactiveSettings(undefined);
  assert.deepEqual(parsed, DEFAULT_PROACTIVE_SETTINGS);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.baseCooldownMinutes, 18, 'pack v02: new_session.cooldown_min 18');
  assert.equal(parsed.continuationCooldownMinutes, 0, 'pack §14.3: continuation cooldown = 0');
  assert.equal(parsed.maxPer6h, 15);
  assert.equal(parsed.maxPerDay, 40);
  assert.equal(parsed.maxConsultsPerDay, 120, 't9 F4: paid 读空气 calls spend their own daily count');
  assert.equal(parsed.newSessionMinGapMinutes, 2, 't9 F6: the new-session rate floor');
  assert.equal(parsed.hotChatMinTurns, 2, 't9 F5: 热聊 is a back-and-forth, not a stray remark');
  assert.equal(parsed.hotChatWindowMinutes, 15, 't9 F5: the window those turns are counted over');
  assert.equal(parsed.topicRepeatWindowHours, 12, 'pack v02: same_topic_cooldown_hours 12');
  assert.equal(parsed.genericTopicCooldownHours, 24, 'pack v02: generic_topic_cooldown_hours 24');
  assert.equal(parsed.unansweredPenalty, 0.45, 'pack v02: unanswered 0.45');
  assert.equal(parsed.explicitRejectPenalty, 0.8, 'pack v02: explicit_reject 0.80');
  assert.equal(parsed.sameTopicPenalty, 0.55, 'pack v02: same_topic 0.55');
  assert.equal(parsed.unansweredWindowMinutes, 10);
  assert.equal(parsed.negativeFeedbackCooldownMultiplier, 2.0);
  assert.equal(parsed.quietHours.startMinutes, 23 * 60 + 30);
  assert.equal(parsed.quietHours.endMinutes, 7 * 60 + 30);
  assert.deepEqual(parsed.triggers, {
    future_hook_due: true,
    presence_arrived: true,
    conversation_dangling: true,
    routine_expected: true,
    topic_pool: true,
    random_smalltalk: false,
  });
  assert.equal(PROACTIVE_TRIGGERS.length, 6, '§16 lists six trigger sources');
});

test('parseProactiveSettings parses a shipped-style config and tolerates unusable values', () => {
  const fromExample = parseProactiveSettings({
    enabled: true,
    base_cooldown_min: 18,
    continuation_cooldown_min: 0,
    max_per_6h: 15,
    max_per_day: 40,
    topic_repeat_window_h: 12,
    generic_topic_cooldown_h: 24,
    unanswered_penalty: 0.45,
    explicit_reject_penalty: 0.8,
    same_topic_penalty: 0.55,
    unanswered_window_min: 10,
    negative_feedback_cooldown_multiplier: 2.0,
    quiet_hours: { start: '23:30', end: '07:30' },
    triggers: {
      future_hook_due: true,
      presence_arrived: true,
      conversation_dangling: true,
      routine_expected: true,
      topic_pool: true,
      random_smalltalk: false,
    },
  });
  assert.deepEqual(fromExample, DEFAULT_PROACTIVE_SETTINGS);

  const hostile = parseProactiveSettings({
    enabled: 'yes',
    base_cooldown_min: -5,
    continuation_cooldown_min: 'soon',
    max_per_6h: 1e9,
    max_per_day: 'many',
    topic_repeat_window_h: null,
    generic_topic_cooldown_h: -1,
    unanswered_penalty: 5,
    explicit_reject_penalty: -2,
    same_topic_penalty: 'lots',
    unanswered_window_min: 0,
    negative_feedback_cooldown_multiplier: 0.1,
    quiet_hours: { start: '25:00', end: '7:00' },
    triggers: { random_smalltalk: true, not_a_trigger: true },
  });
  assert.equal(hostile.enabled, true, 'a non-boolean keeps the default');
  assert.equal(hostile.baseCooldownMinutes, 0, 'clamped to the allowed range');
  assert.equal(hostile.continuationCooldownMinutes, 0, 'a string falls back');
  assert.equal(hostile.maxPer6h, 100);
  assert.equal(hostile.maxPerDay, 40, 'a string falls back');
  assert.equal(hostile.topicRepeatWindowHours, 12);
  assert.equal(hostile.genericTopicCooldownHours, 0, 'clamped, not dropped');
  assert.equal(hostile.unansweredPenalty, 1, 'clamped into [0, 1]');
  assert.equal(hostile.explicitRejectPenalty, 0, 'clamped into [0, 1]');
  assert.equal(hostile.sameTopicPenalty, 0.55, 'a string falls back');
  assert.equal(hostile.unansweredWindowMinutes, 1, 'clamped to at least a minute');
  assert.equal(hostile.negativeFeedbackCooldownMultiplier, 1, 'the multiplier cannot go below 1');
  assert.equal(hostile.quietHours.startMinutes, 23 * 60 + 30, 'an impossible time falls back, it does not fail');
  assert.equal(hostile.quietHours.endMinutes, 7 * 60, 'a valid end is parsed');
  assert.equal(hostile.triggers.random_smalltalk, true, 'an explicit trigger switch is honoured');
  assert.equal('not_a_trigger' in hostile.triggers, false, 'unknown trigger keys are ignored');
});

test('parseClockMinutes and the quiet-hour window boundaries', () => {
  assert.equal(parseClockMinutes('22:30', 0), 1350);
  assert.equal(parseClockMinutes('7:00', 0), 420);
  assert.equal(parseClockMinutes(' 07:00 ', 0), 420);
  assert.equal(parseClockMinutes('24:00', 111), 111);
  assert.equal(parseClockMinutes('22:60', 111), 111);
  assert.equal(parseClockMinutes('晚上十点', 111), 111);
  assert.equal(parseClockMinutes(22.5, 111), 111);
  assert.equal(parseClockMinutes(undefined, 111), 111);

  assert.equal(isWithinQuietHours(1350, 1350, 420), true, '22:30 is already quiet');
  assert.equal(isWithinQuietHours(1349, 1350, 420), false, '22:29 is not');
  assert.equal(isWithinQuietHours(0, 1350, 420), true);
  assert.equal(isWithinQuietHours(419, 1350, 420), true);
  assert.equal(isWithinQuietHours(420, 1350, 420), false, '07:00 sharp is not quiet any more');
  assert.equal(isWithinQuietHours(600, 600, 900), true);
  assert.equal(isWithinQuietHours(900, 600, 900), false);
  assert.equal(isWithinQuietHours(600, 600, 600), false, 'start === end is an empty window');
});

test('local time helpers honour the injected offset', () => {
  const utcNoon = new Date('2026-09-30T04:00:00.000Z');
  assert.equal(localMinutesOf(utcNoon, 480), 12 * 60);
  assert.equal(localDayOf(utcNoon, 480), '2026-09-30');
  const localLateNight = new Date('2026-10-01T00:30:00+08:00');
  assert.equal(localDayOf(localLateNight, 480), '2026-10-01');
  assert.equal(localDayOf(localLateNight, 0), '2026-09-30');
});

// ---------------------------------------------------- the initiative kinds

test('every trigger has an initiative kind, and a candidate may state its own', () => {
  assert.equal(initiativeKindForTrigger('conversation_dangling'), 'conversation_continuation');
  assert.equal(initiativeKindForTrigger('presence_arrived'), 'environment_reaction');
  assert.equal(initiativeKindForTrigger('future_hook_due'), 'open_loop_followup');
  assert.equal(initiativeKindForTrigger('topic_pool'), 'external_sharing');
  assert.equal(initiativeKindForTrigger('random_smalltalk'), 'new_session');
  const explicit = deriveProactiveSignals(candidate({ initiativeKind: 'conversation_continuation' }), context());
  assert.equal(explicit.interruption_cost, 0, 'a candidate may declare itself a continuation');
});

// ------------------------------------------------------------- hard floor

test('the hard floor lets a clean candidate through and computes the budget', () => {
  const result = evaluateProactiveGates(candidate(), context());
  assert.equal(result.pass, true);
  assert.equal(result.reasonCode, 'PASSED');
  assert.equal(result.recommendation, 'speak');
  assert.equal(result.score, 0.9775, '0.85 + 0.15 × 0.85');
  assert.equal(result.threshold, 0.495);
  assert.equal(result.signals.base_proactivity, 0.85, 'the baseline comes from the profile, not the candidate');
  assert.ok(result.basis.length >= 6, `expected a 依据 per used signal, got ${result.basis.length}`);
});

test('DISABLED and TRIGGER_DISABLED', () => {
  assert.equal(evaluateProactiveGates(candidate(), context({ settings: settings({ enabled: false }) })).reasonCode, 'DISABLED');
  assert.equal(evaluateProactiveGates(candidate({ trigger: 'random_smalltalk' }), context()).reasonCode, 'TRIGGER_DISABLED');
  const enabled = settings({ triggers: { ...DEFAULT_PROACTIVE_SETTINGS.triggers, random_smalltalk: true } });
  assert.equal(evaluateProactiveGates(candidate({ trigger: 'random_smalltalk' }), context({ settings: enabled })).reasonCode, 'PASSED');
});

test('ALREADY_DELIVERED is the restart-safety gate and comes before DND', () => {
  const history = [delivered('cand_1', minutesBefore(AFTERNOON, 60))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history })).reasonCode, 'ALREADY_DELIVERED');
  assert.equal(evaluateProactiveGates(candidate({ candidateId: 'cand_2' }), context({ history })).reasonCode, 'PASSED');
  const future = [delivered('cand_1', new Date(AFTERNOON.getTime() + 60 * 60_000))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history: future })).reasonCode, 'PASSED');
  assert.equal(
    evaluateProactiveGates(candidate(), context({ history, conversationState: 'SUSPENDED' })).reasonCode,
    'ALREADY_DELIVERED',
  );
});

test('DND_ACTIVE beats QUIET_HOURS, and both use the local clock', () => {
  const night = at('2026-09-30T23:30:00+08:00');
  assert.equal(evaluateProactiveGates(candidate(), context({ now: night })).reasonCode, 'QUIET_HOURS');
  assert.equal(
    evaluateProactiveGates(candidate(), context({ now: night, conversationState: 'SUSPENDED' })).reasonCode,
    'DND_ACTIVE',
  );
  assert.equal(evaluateProactiveGates(candidate(), context({ now: at('2026-09-30T07:30:00+08:00') })).reasonCode, 'PASSED');
  assert.equal(evaluateProactiveGates(candidate(), context({ now: at('2026-09-30T07:29:00+08:00') })).reasonCode, 'QUIET_HOURS');
  assert.equal(
    evaluateProactiveGates(candidate(), context({ now: night, offsetMinutes: 0 })).reasonCode,
    'PASSED',
    '23:30 +08:00 is 15:30 UTC, outside the window at offset 0',
  );
});

test('PRIVACY_BLOCKED is a hard floor of its own (铁律 6/8)', () => {
  const blocked = evaluateProactiveGates(candidate(), context({ privacyAllowed: false }));
  assert.equal(blocked.reasonCode, 'PRIVACY_BLOCKED');
  assert.equal(blocked.pass, false);
  // …and it is checked before any budget is spent on the turn.
  assert.equal(
    evaluateProactiveGates(candidate(), context({ privacyAllowed: false, settings: settings({ enabled: false }) })).reasonCode,
    'DISABLED',
    'the switch is still the first thing that answers',
  );
});

test('QUOTA_6H_EXCEEDED: fifteen in six hours by default', () => {
  const fifteen = [10, 25, 40, 55, 70, 85, 100, 115, 130, 145, 160, 175, 190, 205, 220].map((minutes) =>
    delivered(`old_${minutes}`, minutesBefore(AFTERNOON, minutes)),
  );
  // Answer each delivery, so this test measures the *quota* and is not confounded by the
  // unanswered-streak grade (t9 F2) stacking up over a fixture that never answers.
  const answered = fifteen.map((record) => record.at.getTime() + 60_000);
  assert.equal(evaluateProactiveGates(candidate(), context({ history: fifteen })).reasonCode, 'QUOTA_6H_EXCEEDED');
  const fourteen = fifteen.slice(0, 14);
  assert.equal(evaluateProactiveGates(candidate(), context({ history: fourteen, userTurns: answered.slice(0, 14) })).reasonCode, 'PASSED');
  const old = [delivered('old_1', minutesBefore(AFTERNOON, 7 * 60))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history: old, userTurns: [old[0]!.at.getTime() + 60_000] })).reasonCode, 'PASSED');
});

test('delivery and consultation budgets are separate, and both can end a day (t9 F4)', () => {
  const dayScoped = settings({ maxPer6h: 100, maxPerDay: 2 });
  const two = [delivered('a', minutesBefore(AFTERNOON, 30)), delivered('b', minutesBefore(AFTERNOON, 50))];
  assert.equal(evaluateProactiveGates(candidate(), context({ settings: dayScoped, history: two })).reasonCode, 'QUOTA_DAY_EXCEEDED');
  assert.equal(evaluateProactiveGates(candidate(), context({ settings: dayScoped, history: two.slice(0, 1) })).reasonCode, 'PASSED');
  // One delivery + one consultation: the consultation no longer spends the *delivery* budget…
  assert.equal(
    evaluateProactiveGates(candidate(), context({ settings: dayScoped, history: two.slice(0, 1), consultsToday: 1 })).reasonCode,
    'PASSED',
    't9 F4: 「不说」的问询不能吃掉开口额度',
  );
  // …but the paid calls have their own daily count, so a hot loop still cannot ask forever.
  const consultScoped = settings({ maxPer6h: 100, maxConsultsPerDay: 1 });
  assert.equal(
    evaluateProactiveGates(candidate(), context({ settings: consultScoped, consultsToday: 1 })).reasonCode,
    'QUOTA_CONSULT_EXCEEDED',
  );
  assert.equal(evaluateProactiveGates(candidate(), context({ settings: consultScoped, consultsToday: 0 })).reasonCode, 'PASSED');
  const yesterday = [delivered('a', new Date('2026-09-29T20:00:00+08:00')), delivered('b', minutesBefore(AFTERNOON, 50))];
  assert.equal(evaluateProactiveGates(candidate(), context({ settings: dayScoped, history: yesterday })).reasonCode, 'PASSED');
});

test('the new-session rate floor blocks a too-soon new thread and spares 热聊接话 (t9 F6)', () => {
  const recent = [delivered('just_spoke', minutesBefore(AFTERNOON, 1))];
  // A non-continuation candidate inside the floor's window is blocked, with its own auditable code.
  const blocked = evaluateProactiveGates(candidate(), context({ history: recent }));
  assert.equal(blocked.reasonCode, 'NEW_SESSION_FLOOR');
  assert.equal(blocked.pass, false);
  // Exactly on the boundary the floor does not fire (strictly-less-than): the pack's golden
  // G12 「同一个 2 分钟窗口里强候选照样开口」 case is the contract that pins this edge.
  const atBoundary = evaluateProactiveGates(candidate(), context({ history: [delivered('just_spoke', minutesBefore(AFTERNOON, 2))] }));
  assert.equal(atBoundary.reasonCode, 'PASSED', 'the 2-minute boundary itself is outside the floor');
  // 热聊中接话 is exempt (pack §14.3 / Phase 5 goal: not受限 by the new-session cooldown).
  const continuation = evaluateProactiveGates(
    candidate({ trigger: 'conversation_dangling' }),
    context({ history: recent }),
  );
  assert.equal(continuation.pass, true, 'a continuation may speak immediately after another message');
  // …and the floor disappears entirely when it is switched off.
  assert.equal(
    evaluateProactiveGates(candidate(), context({ history: recent, settings: settings({ newSessionMinGapMinutes: 0 }) })).reasonCode,
    'PASSED',
    '0 disables the floor',
  );
});

test('CONVERSATION_ACTIVE stops new sessions but lets a continuation join a live chat', () => {
  for (const state of ['ENGAGING', 'ACTIVE', 'LINGERING'] as const) {
    assert.equal(evaluateProactiveGates(candidate(), context({ conversationState: state })).reasonCode, 'CONVERSATION_ACTIVE');
    const continuation = evaluateProactiveGates(
      candidate({ trigger: 'conversation_dangling' }),
      context({ conversationState: state }),
    );
    assert.equal(continuation.pass, true, `a continuation may speak while ${state}`);
    assert.equal(continuation.signals.interruption_cost, 0, 'pack §14.3: continuation has no cooldown');
  }
  assert.equal(evaluateProactiveGates(candidate(), context({ inFlightTurn: true })).reasonCode, 'CONVERSATION_ACTIVE');
  assert.equal(
    evaluateProactiveGates(candidate({ trigger: 'conversation_dangling' }), context({ inFlightTurn: true })).reasonCode,
    'CONVERSATION_ACTIVE',
    'a turn in flight always waits — never talk over yourself',
  );
});

test('SCENE_UNAVAILABLE and SPEECH_UNAVAILABLE', () => {
  assert.equal(evaluateProactiveGates(candidate(), context({ sceneAvailable: false })).reasonCode, 'SCENE_UNAVAILABLE');
  assert.equal(evaluateProactiveGates(candidate(), context({ speechAvailable: false })).reasonCode, 'SPEECH_UNAVAILABLE');
  assert.equal(
    evaluateProactiveGates(candidate(), context({ sceneAvailable: false, speechAvailable: false })).reasonCode,
    'SCENE_UNAVAILABLE',
  );
});

// --------------------------------------- above the floor: grades, not vetoes

test('a recent message no longer vetoes — it costs, and a strong candidate still passes', () => {
  const twoMinutesAgo = [delivered('older', minutesBefore(AFTERNOON, 2))];
  const strong = evaluateProactiveGates(candidate(), context({ history: twoMinutesAgo }));
  assert.equal(strong.pass, true, 'cooldown must not block (ADR-0011)');
  assert.equal(strong.recommendation, 'speak');
  assert.ok(strong.signals.interruption_cost > 0.8, `expected a heavy grade, got ${strong.signals.interruption_cost}`);
  assert.ok(
    strong.basis.some((line) => line.includes(PROACTIVE_SIGNAL_LABELS.interruption_cost)),
    'the 依据 must name the interruption cost',
  );

  // The same history with a weak topic: the *score* says hold, and it says so in words.
  const weak = evaluateProactiveGates(
    candidate({ components: { topic_quality: 0.2, receptivity: 0.3 } }),
    context({ history: twoMinutesAgo }),
  );
  assert.equal(weak.pass, true, 'the floor is still cleared — this is a recommendation, not a gate');
  assert.equal(weak.recommendation, 'hold');
  assert.equal(weak.reasonCode, 'BELOW_RECOMMENDATION');
  assert.ok(
    ['interruption_cost', 'recent_unanswered_penalty'].includes(weak.primarySignal),
    `the primary signal must be the heaviest penalty, got ${weak.primarySignal}`,
  );
  assert.ok(weak.basis.some((line) => line.includes('建议这次不说')));
});

test('18 minutes later the interruption cost has decayed to nothing', () => {
  const eighteen = [delivered('older', minutesBefore(AFTERNOON, 18))];
  const result = evaluateProactiveGates(candidate(), context({ history: eighteen }));
  assert.equal(result.signals.interruption_cost, 0);
  const half = evaluateProactiveGates(candidate(), context({ history: [delivered('older', minutesBefore(AFTERNOON, 9))] }));
  assert.ok(half.signals.interruption_cost > 0.4 && half.signals.interruption_cost < 0.6, `graded, got ${half.signals.interruption_cost}`);
});

test('a repeated topic is graded by recency instead of blocking', () => {
  const oneHourAgo = [delivered('older', minutesBefore(AFTERNOON, 60), 'hook_weather')];
  const repeated = evaluateProactiveGates(candidate({ topicRef: 'hook_weather' }), context({ history: oneHourAgo }));
  assert.equal(repeated.pass, true, 'TOPIC_REPEATED is retired as a gate');
  assert.ok(repeated.signals.repeated_topic_penalty > 0.4, `expected a heavy grade, got ${repeated.signals.repeated_topic_penalty}`);
  assert.ok(repeated.basis.some((line) => line.includes(PROACTIVE_SIGNAL_LABELS.repeated_topic_penalty)));

  // A different topic pays nothing…
  assert.equal(
    evaluateProactiveGates(candidate({ topicRef: 'hook_other' }), context({ history: oneHourAgo })).signals.repeated_topic_penalty,
    0,
  );
  // …and outside the 12-hour window the old topic no longer costs anything.
  const yesterday = [delivered('older', minutesBefore(AFTERNOON, 13 * 60), 'hook_weather')];
  assert.equal(evaluateProactiveGates(candidate({ topicRef: 'hook_weather' }), context({ history: yesterday })).signals.repeated_topic_penalty, 0);
});

test('a generic line pays the longer generic window (no topic at all is not "free")', () => {
  const threeHoursAgo = [delivered('older', minutesBefore(AFTERNOON, 3 * 60), null)];
  const generic = evaluateProactiveGates(candidate({ topicRef: null }), context({ history: threeHoursAgo }));
  assert.ok(generic.signals.repeated_topic_penalty > 0.4, 'inside the 24 h generic window');
  const specific = evaluateProactiveGates(candidate({ topicRef: 'hook_books' }), context({ history: threeHoursAgo }));
  assert.equal(specific.signals.repeated_topic_penalty, 0, 'a specific topic is not the generic line that was said');
});

test('unanswered proactive messages become a grade, never a silent ban', () => {
  const history = [60, 50, 40].map((minutes) => delivered(`old_${minutes}`, minutesBefore(AFTERNOON, minutes)));
  const ignored = evaluateProactiveGates(candidate(), context({ history, userTurns: [] }));
  // t9 F2: the streak escalates — 3 consecutive non-answers cost 0.45 × (1 + 0.5 × 2) = 0.90,
  // where the old ratio alone saturated at 0.45 for 1/2/3 non-answers alike.
  assert.equal(ignored.signals.recent_unanswered_penalty, 0.9, 'streak 3: base + 2 × half-base');
  assert.ok(ignored.basis.some((line) => line.includes(PROACTIVE_SIGNAL_LABELS.recent_unanswered_penalty)));

  // Escalation is strict and auditable: 1 → 0.45, 2 → 0.675, 3 → 0.90 (the pack's base 0.45).
  const penalties = [1, 2, 3].map(
    (count) =>
      evaluateProactiveGates(
        candidate(),
        context({ history: history.slice(-count), userTurns: [] }),
      ).signals.recent_unanswered_penalty,
  );
  assert.deepEqual(penalties, [0.45, 0.675, 0.9], 'consecutive unanswered must keep climbing');

  // Answered inside the 10-minute window counts as a response.
  const answered = history.map((record) => record.at.getTime() + 60_000);
  assert.equal(evaluateProactiveGates(candidate(), context({ history, userTurns: answered })).signals.recent_unanswered_penalty, 0);

  // Only the newest matters for the grade when the older ones were answered.
  const mixed = evaluateProactiveGates(
    candidate(),
    context({ history, userTurns: [history[0]!.at.getTime() + 60_000, history[1]!.at.getTime() + 60_000] }),
  );
  assert.ok(mixed.signals.recent_unanswered_penalty > 0 && mixed.signals.recent_unanswered_penalty < 0.45);
});

test('a hot chat suspends the 未回应惩罚 for 热聊接话; a stray remark does not (t9 F5)', () => {
  // Three deliveries nobody answered: the ceiling of the F2 escalation (see the test above).
  const ignored = [60, 50, 40].map((minutes) => delivered(`old_${minutes}`, minutesBefore(AFTERNOON, minutes)));
  const continuation = candidate({ trigger: 'conversation_dangling', topicRef: '明天要去医院复查' });
  /** A real back-and-forth: three user turns inside the 15-minute window. */
  const burst = [1, 4, 7].map((minutes) => minutesBefore(AFTERNOON, minutes).getTime());

  // Baseline: nobody has spoken to her, so the penalty presses at full strength.
  const ignoredDay = evaluateProactiveGates(continuation, context({ history: ignored, userTurns: [] }));
  assert.equal(ignoredDay.signals.recent_unanswered_penalty, 0.9);

  // 1. A live conversation **with a back-and-forth** is the pack's 「正在热聊」: the person is talking
  //    to her right now, so 「她说了没人回来」 is false by construction and the continuation is not
  //    charged the grade. Before this, the ceiling held the live-chat path shut for the whole day
  //    (t9's hot-chat timeline produced 0 continuations inside the window because of it).
  const hot = evaluateProactiveGates(continuation, context({ history: ignored, userTurns: burst, conversationState: 'LINGERING' }));
  assert.equal(hot.signals.recent_unanswered_penalty, 0, '热聊中接话不再吃未回应惩罚');
  assert.equal(hot.reasonCode, 'PASSED');
  assert.equal(hot.signals.interruption_cost, 0, '§14.3: continuation cooldown is still 0');

  // 2. One stray remark is not a hot chat — otherwise an ignored day would simply be cancelled by
  //    the household's own chatter (the timeline's 被忽视的一天 speaks every 30+ minutes).
  const stray = evaluateProactiveGates(continuation, context({ history: ignored, userTurns: [burst[2]!], conversationState: 'LINGERING' }));
  assert.equal(stray.signals.recent_unanswered_penalty, 0.9, '一句孤零零的搭话不算热聊');

  // 3. …and a burst is not a hot chat once the thread has closed (the FSM is back to IDLE).
  const closed = evaluateProactiveGates(continuation, context({ history: ignored, userTurns: burst, conversationState: 'IDLE' }));
  assert.equal(closed.signals.recent_unanswered_penalty, 0.9, '对话已经收尾就不算「正在热聊」');

  // 4. Only 热聊接话 gets the exemption: a *new* thread during the same hot chat still pays it.
  const newThread = evaluateProactiveGates(candidate(), context({ history: ignored, userTurns: burst, conversationState: 'LINGERING' }));
  assert.equal(newThread.signals.recent_unanswered_penalty, 0.9, '新会话不享受热聊豁免');

  // 5. 「别说了」 still outranks everything, hot chat or not.
  const rejected = evaluateProactiveGates(continuation, context({ history: ignored, userTurns: burst, conversationState: 'LINGERING', explicitReject: true }));
  assert.equal(rejected.signals.recent_unanswered_penalty, 0.8);

  // The window and the turn count are settings, so the definition is auditable rather than magic.
  const wideOpen = evaluateProactiveGates(
    continuation,
    context({ history: ignored, userTurns: [burst[2]!], conversationState: 'LINGERING', settings: settings({ hotChatMinTurns: 1 }) }),
  );
  assert.equal(wideOpen.signals.recent_unanswered_penalty, 0, '1 = 只要对话还开着就算热聊');
  const staleBurst = evaluateProactiveGates(
    continuation,
    context({ history: ignored, userTurns: burst, conversationState: 'LINGERING', settings: settings({ hotChatWindowMinutes: 2 }) }),
  );
  assert.equal(staleBurst.signals.recent_unanswered_penalty, 0.9, '窗口外的轮次不算数');
});

test('an explicit "别说了" is the strongest penalty, and negative feedback multiplies the grades', () => {
  const rejected = evaluateProactiveGates(candidate(), context({ explicitReject: true }));
  assert.equal(rejected.signals.recent_unanswered_penalty, 0.8);

  const twoMinutesAgo = [delivered('older', minutesBefore(AFTERNOON, 2))];
  const plain = evaluateProactiveGates(candidate(), context({ history: twoMinutesAgo }));
  const tightened = evaluateProactiveGates(candidate(), context({ history: twoMinutesAgo, negativeFeedback: true }));
  assert.ok(tightened.score < plain.score, 'negative feedback must lower the budget');
  assert.equal(tightened.signals.interruption_cost, 1, '0.89 × 2 clamps at 1');
});

// ------------------------------------------------------------------ audit

test('every decision carries a Chinese 依据, and the basis is deterministic', () => {
  const first = evaluateProactiveGates(candidate(), context());
  const second = evaluateProactiveGates(candidate(), context());
  assert.deepEqual(first.basis, second.basis);
  for (const line of first.basis) {
    assert.match(line, /[\u4e00-\u9fff]/, `every basis line is Chinese: ${line}`);
    assert.doesNotMatch(line, /undefined|NaN/, `no leaked placeholders: ${line}`);
  }
  // A blocked candidate also explains itself: "why didn't she say anything" is the question.
  const blocked = evaluateProactiveGates(candidate(), context({ now: at('2026-09-30T23:40:00+08:00') }));
  assert.ok(blocked.basis.length > 0);
  assert.equal(blocked.reasonCode, 'QUIET_HOURS');
});

test('proactiveBasis renders the numbers, and never invents a signal', () => {
  const signals = deriveProactiveSignals(candidate(), context());
  const lines = proactiveBasis(signals, 0.5, 0.495, 'speak');
  assert.equal(lines.length, 6 + 1, 'the five supplied signals + the baseline + the summary line');
  assert.ok(lines.every((line) => !line.includes('undefined')));
  assert.match(lines.at(-1) ?? '', /0\.5/);
  assert.match(lines.at(-1) ?? '', /0\.495/);
});

test('the retired ADR-0009 codes stay declared for old records but are never returned', () => {
  assert.deepEqual([...PROACTIVE_RETIRED_REASON_CODES], ['COOLDOWN_ACTIVE', 'TOPIC_REPEATED', 'SCORE_BELOW_THRESHOLD']);
  for (const code of PROACTIVE_RETIRED_REASON_CODES) {
    assert.ok(PROACTIVE_KNOWN_REASON_CODES.includes(code), `${code} must stay known so old events still read`);
    assert.equal(PROACTIVE_REASON_CODES.includes(code as never), false, `${code} must not be emitted any more`);
  }
});

test('the reason-code list names every outcome the floor and the judgement can return', () => {
  const seen = new Set<string>();
  const cases: readonly ProactiveGateContext[] = [
    context({ settings: settings({ enabled: false }) }),
    context({ settings: settings({ triggers: { ...DEFAULT_PROACTIVE_SETTINGS.triggers, topic_pool: false } }) }),
    context({ history: [delivered('cand_1', minutesBefore(AFTERNOON, 60))] }),
    context({ conversationState: 'SUSPENDED' }),
    context({ now: at('2026-09-30T23:00:00+08:00') }),
    context({ privacyAllowed: false }),
    context({ history: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => delivered(`old_${n}`, minutesBefore(AFTERNOON, 20 * n))) }),
    context({ settings: settings({ maxPer6h: 100, maxPerDay: 1 }), history: [delivered('old', minutesBefore(AFTERNOON, 30))] }),
    context({ conversationState: 'LINGERING' }),
    context({ sceneAvailable: false }),
    context({ speechAvailable: false }),
    context({ proactivity: 0 }),
    context(),
  ];
  for (const ctx of cases) {
    for (const components of [{}, STRONG]) {
      seen.add(evaluateProactiveGates(candidate({ topicRef: 'hook_weather', components }), ctx).reasonCode);
    }
  }
  assert.ok(seen.has('PASSED'));
  assert.ok(seen.has('BELOW_RECOMMENDATION'));
  assert.ok(seen.has('PRIVACY_BLOCKED'));
  for (const code of seen) assert.ok(PROACTIVE_REASON_CODES.includes(code as never), `${code} must be a registered code`);
  assert.ok(seen.size >= 10, `expected several distinct outcomes, saw ${[...seen].join(', ')}`);
});
