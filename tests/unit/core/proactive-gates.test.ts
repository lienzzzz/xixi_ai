import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROACTIVE_SETTINGS,
  DEFAULT_PROACTIVITY,
  evaluateProactiveGates,
  isWithinQuietHours,
  localDayOf,
  localMinutesOf,
  parseClockMinutes,
  parseProactiveSettings,
  PROACTIVE_REASON_CODES,
  proactiveThreshold,
  PROACTIVE_TRIGGERS,
  scoreProactiveCandidate,
  type ProactiveCandidate,
  type ProactiveDeliveryRecord,
  type ProactiveGateContext,
  type ProactiveSettings,
} from '@xixi/conversation';

/**
 * ADR-0009's hard gates, one boundary pair per gate.
 *
 * Every assertion here is about the *program*: the score is arithmetic on
 * §15.4 components, the threshold is a closed-form function of `proactivity`, and
 * each gate is a comparison that a model cannot argue with (铁律 1/3). The engine
 * that writes the audit record is covered separately.
 */

const OFFSET = 480; // Asia/Shanghai
// 14:00 local — outside the 23:30–07:30 quiet window, and comfortably inside the day.
const AFTERNOON = new Date('2026-09-30T14:00:00+08:00');

/** Seven §15.4 components at 1 → score 0.7, above the 0.495 baseline threshold (ADR-0009: default proactivity 0.85). */
const STRONG: Readonly<Record<string, number>> = {
  event_salience: 1,
  social_value: 1,
  memory_relevance: 1,
  novelty: 1,
  time_since_last_interaction: 1,
  user_receptiveness: 1,
  future_hook_bonus: 1,
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
    history: [],
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

// --------------------------------------------------------------- constants

test('the score is the clamped, equal-weighted sum of the §15.4 components', () => {
  assert.equal(scoreProactiveCandidate(undefined), 0);
  assert.equal(scoreProactiveCandidate({}), 0);
  assert.equal(scoreProactiveCandidate(STRONG), 0.7, 'seven positive terms × 0.1');
  // The negative terms subtract; all eleven at 1 is 0.7 − 0.4 = 0.3.
  const all = Object.fromEntries(Object.keys(STRONG).concat([
    'interruption_risk',
    'recent_proactive_penalty',
    'repetition_penalty',
    'uncertainty_penalty',
  ]).map((name) => [name, 1]));
  assert.equal(scoreProactiveCandidate(all), 0.3);
  // Out-of-range and unusable components are clamped, never trusted.
  assert.equal(scoreProactiveCandidate({ event_salience: 5 }), 0.1);
  assert.equal(scoreProactiveCandidate({ event_salience: -3, novelty: Number.NaN }), 0);
  assert.equal(scoreProactiveCandidate({ event_salience: 1, interruption_risk: 1 }), 0, 'never below 0');
});

test('the threshold follows proactivity and can never fall below the 0.45 floor', () => {
  // The shipped default is 0.85 (ADR-0009), so the baseline threshold is 0.45 + 0.30 × 0.15 = 0.495.
  assert.equal(proactiveThreshold(0.85), 0.495, 'the default baseline from config/xixi.example.yaml');
  assert.equal(proactiveThreshold(1), 0.45);
  assert.equal(proactiveThreshold(0), 0.75, 'proactivity 0 → 0.45 + 0.30');
  assert.equal(proactiveThreshold(2), 0.45, 'clamped: proactivity cannot buy a lower gate');
  assert.equal(proactiveThreshold(-1), 0.75);
  assert.equal(proactiveThreshold(0.5), 0.6);
});

// ---------------------------------------------------------------- settings

test('the config defaults match ADR-0009 §5 exactly', () => {
  const parsed = parseProactiveSettings(undefined);
  assert.deepEqual(parsed, DEFAULT_PROACTIVE_SETTINGS);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.baseCooldownMinutes, 5);
  assert.equal(parsed.maxPer6h, 15);
  assert.equal(parsed.maxPerDay, 40);
  assert.equal(parsed.topicRepeatWindowHours, 2);
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
  // Hand-written copy of the shipped example values (config/xixi.example.yaml), not a file read:
  // it exists to show the parsed shape equals DEFAULT_PROACTIVE_SETTINGS.
  const fromExample = parseProactiveSettings({
    enabled: true,
    base_cooldown_min: 5,
    max_per_6h: 15,
    max_per_day: 40,
    topic_repeat_window_h: 2,
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
    max_per_6h: 1e9,
    max_per_day: 'many',
    topic_repeat_window_h: null,
    negative_feedback_cooldown_multiplier: 0.1,
    quiet_hours: { start: '25:00', end: '7:00' },
    triggers: { random_smalltalk: true, not_a_trigger: true },
  });
  assert.equal(hostile.enabled, true, 'a non-boolean keeps the default');
  assert.equal(hostile.baseCooldownMinutes, 0, 'clamped to the allowed range');
  assert.equal(hostile.maxPer6h, 100);
  assert.equal(hostile.maxPerDay, 40, 'a string falls back');
  assert.equal(hostile.topicRepeatWindowHours, 2);
  assert.equal(hostile.negativeFeedbackCooldownMultiplier, 1, 'the multiplier cannot go below 1');
  assert.equal(hostile.quietHours.startMinutes, 23 * 60 + 30, 'an impossible time falls back, it does not fail');
  // The end is *supplied and valid* ("7:00"), so it is parsed rather than falling back.
  assert.equal(hostile.quietHours.endMinutes, 7 * 60);
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

  // Cross-midnight window [22:30, 07:00): the end is exclusive.
  assert.equal(isWithinQuietHours(1350, 1350, 420), true, '22:30 is already quiet');
  assert.equal(isWithinQuietHours(1349, 1350, 420), false, '22:29 is not');
  assert.equal(isWithinQuietHours(0, 1350, 420), true);
  assert.equal(isWithinQuietHours(419, 1350, 420), true);
  assert.equal(isWithinQuietHours(420, 1350, 420), false, '07:00 sharp is not quiet any more');
  assert.equal(isWithinQuietHours(720, 1350, 420), false);
  // A same-day window behaves normally.
  assert.equal(isWithinQuietHours(600, 600, 900), true);
  assert.equal(isWithinQuietHours(899, 600, 900), true);
  assert.equal(isWithinQuietHours(900, 600, 900), false);
  assert.equal(isWithinQuietHours(599, 600, 900), false);
  // start === end is an empty window, not a 24-hour one.
  assert.equal(isWithinQuietHours(600, 600, 600), false);
});

test('local time helpers honour the injected offset', () => {
  const utcNoon = new Date('2026-09-30T04:00:00.000Z');
  assert.equal(localMinutesOf(utcNoon, 480), 12 * 60);
  assert.equal(localDayOf(utcNoon, 480), '2026-09-30');
  // 00:30 local on the 1st is still 16:30 UTC on the 30th → different local day.
  const localLateNight = new Date('2026-10-01T00:30:00+08:00');
  assert.equal(localDayOf(localLateNight, 480), '2026-10-01');
  assert.equal(localDayOf(localLateNight, 0), '2026-09-30');
});

// ------------------------------------------------------------------- gates

test('every gate lets a clean candidate through', () => {
  const result = evaluateProactiveGates(candidate(), context());
  assert.equal(result.pass, true);
  assert.equal(result.reasonCode, 'PASSED');
  assert.equal(result.score, 0.7);
  // `context()` leaves proactivity at DEFAULT_PROACTIVITY (0.85) → 0.45 + 0.30 × 0.15 = 0.495.
  assert.equal(result.threshold, 0.495);
});

test('DISABLED and TRIGGER_DISABLED', () => {
  assert.equal(evaluateProactiveGates(candidate(), context({ settings: settings({ enabled: false }) })).reasonCode, 'DISABLED');
  // random_smalltalk is the one trigger that is off by default (§16).
  assert.equal(evaluateProactiveGates(candidate({ trigger: 'random_smalltalk' }), context()).reasonCode, 'TRIGGER_DISABLED');
  const enabled = settings({ triggers: { ...DEFAULT_PROACTIVE_SETTINGS.triggers, random_smalltalk: true } });
  assert.equal(evaluateProactiveGates(candidate({ trigger: 'random_smalltalk' }), context({ settings: enabled })).reasonCode, 'PASSED');
});

test('ALREADY_DELIVERED is the restart-safety gate', () => {
  const history = [delivered('cand_1', minutesBefore(AFTERNOON, 60))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history })).reasonCode, 'ALREADY_DELIVERED');
  // A different candidate is not blocked by it.
  assert.equal(evaluateProactiveGates(candidate({ candidateId: 'cand_2' }), context({ history })).reasonCode, 'PASSED');
  // A record timestamped in the future belongs to a replay, not to this decision.
  const future = [delivered('cand_1', new Date(AFTERNOON.getTime() + 60 * 60_000))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history: future })).reasonCode, 'PASSED');
  // Precedence: an absolute refusal that precedes it (DND) is overridden by the
  // duplicate check? No — the order is documented, and the duplicate comes first.
  assert.equal(
    evaluateProactiveGates(candidate(), context({ history, conversationState: 'SUSPENDED' })).reasonCode,
    'ALREADY_DELIVERED',
    'the documented order decides which single reason is logged',
  );
});

test('DND_ACTIVE beats QUIET_HOURS, and both use the local clock', () => {
  const night = at('2026-09-30T23:30:00+08:00');
  assert.equal(evaluateProactiveGates(candidate(), context({ now: night })).reasonCode, 'QUIET_HOURS');
  assert.equal(
    evaluateProactiveGates(candidate(), context({ now: night, conversationState: 'SUSPENDED' })).reasonCode,
    'DND_ACTIVE',
  );
  // 07:30 sharp: the window's end is exclusive.
  assert.equal(evaluateProactiveGates(candidate(), context({ now: at('2026-09-30T07:30:00+08:00') })).reasonCode, 'PASSED');
  assert.equal(evaluateProactiveGates(candidate(), context({ now: at('2026-09-30T07:29:00+08:00') })).reasonCode, 'QUIET_HOURS');
  // The offset is what makes this the local evening rather than the local morning.
  assert.equal(
    evaluateProactiveGates(candidate(), context({ now: night, offsetMinutes: 0 })).reasonCode,
    'PASSED',
    '23:30 +08:00 is 15:30 UTC, outside the window at offset 0',
  );
});

test('COOLDOWN_ACTIVE: 5 minutes by default, exactly', () => {
  const history = [delivered('older', minutesBefore(AFTERNOON, 5))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history })).reasonCode, 'PASSED', 'exactly 5 min is allowed');
  const justInside = [delivered('older', minutesBefore(AFTERNOON, 4))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history: justInside })).reasonCode, 'COOLDOWN_ACTIVE');
  // A record from yesterday cannot block today, but a fresh one always does.
  const yesterday = [delivered('older', minutesBefore(AFTERNOON, 24 * 60))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history: yesterday })).reasonCode, 'PASSED');
});

test('QUOTA_6H_EXCEEDED: fifteen in six hours by default', () => {
  const fifteen = [10, 25, 40, 55, 70, 85, 100, 115, 130, 145, 160, 175, 190, 205, 220].map((minutes) =>
    delivered(`old_${minutes}`, minutesBefore(AFTERNOON, minutes)),
  );
  assert.equal(evaluateProactiveGates(candidate(), context({ history: fifteen })).reasonCode, 'QUOTA_6H_EXCEEDED');
  const fourteen = fifteen.slice(0, 14);
  assert.equal(evaluateProactiveGates(candidate(), context({ history: fourteen })).reasonCode, 'PASSED');
  // A record older than the window does not count.
  const old = [delivered('old_1', minutesBefore(AFTERNOON, 7 * 60))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history: old })).reasonCode, 'PASSED');
  const fourteenWithAnOldOne = [...fourteen, delivered('old_2', minutesBefore(AFTERNOON, 6 * 60 + 1))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history: fourteenWithAnOldOne })).reasonCode, 'PASSED');
});

test('QUOTA_DAY_EXCEEDED: the local natural day, with a 2-per-day cap', () => {
  // The 6-hour budget would fire first, so this gate is tested with it raised —
  // which is also the documented evaluation order.
  const dayScoped = settings({ maxPer6h: 100, maxPerDay: 2 });
  const two = [delivered('a', minutesBefore(AFTERNOON, 30)), delivered('b', minutesBefore(AFTERNOON, 50))];
  assert.equal(evaluateProactiveGates(candidate(), context({ settings: dayScoped, history: two })).reasonCode, 'QUOTA_DAY_EXCEEDED');
  const one = two.slice(0, 1);
  assert.equal(evaluateProactiveGates(candidate(), context({ settings: dayScoped, history: one })).reasonCode, 'PASSED');
  // Yesterday's messages do not spend today's budget.
  const yesterday = [delivered('a', new Date('2026-09-29T20:00:00+08:00')), delivered('b', minutesBefore(AFTERNOON, 50))];
  assert.equal(evaluateProactiveGates(candidate(), context({ settings: dayScoped, history: yesterday })).reasonCode, 'PASSED');
});

test('TOPIC_REPEATED: 2 hours by default, only for a topic that has been used', () => {
  const history = [delivered('older', minutesBefore(AFTERNOON, 60), 'hook_weather')];
  assert.equal(
    evaluateProactiveGates(candidate({ topicRef: 'hook_weather' }), context({ history })).reasonCode,
    'TOPIC_REPEATED',
  );
  assert.equal(evaluateProactiveGates(candidate({ topicRef: 'hook_other' }), context({ history })).reasonCode, 'PASSED');
  assert.equal(evaluateProactiveGates(candidate({ topicRef: null }), context({ history })).reasonCode, 'PASSED');
  assert.equal(evaluateProactiveGates(candidate(), context({ history })).reasonCode, 'PASSED', 'no topicRef at all is never repeated');
  // Window boundary: strictly inside 2 hours counts, exactly 2 hours does not.
  const old = [delivered('older', new Date(AFTERNOON.getTime() - 2 * 60 * 60_000), 'hook_weather')];
  assert.equal(evaluateProactiveGates(candidate({ topicRef: 'hook_weather' }), context({ history: old })).reasonCode, 'PASSED');
  const justInside = [delivered('older', new Date(AFTERNOON.getTime() - 2 * 60 * 60_000 + 1), 'hook_weather')];
  assert.equal(
    evaluateProactiveGates(candidate({ topicRef: 'hook_weather' }), context({ history: justInside })).reasonCode,
    'TOPIC_REPEATED',
  );
});

test('CONVERSATION_ACTIVE: any open conversation or in-flight turn blocks the whole class', () => {
  for (const state of ['ENGAGING', 'ACTIVE', 'LINGERING'] as const) {
    assert.equal(evaluateProactiveGates(candidate(), context({ conversationState: state })).reasonCode, 'CONVERSATION_ACTIVE');
  }
  assert.equal(evaluateProactiveGates(candidate(), context({ inFlightTurn: true })).reasonCode, 'CONVERSATION_ACTIVE');
  // Precedence over the score: a busy room is reported as busy, not as a weak candidate.
  assert.equal(
    evaluateProactiveGates(candidate({ components: {} }), context({ conversationState: 'LINGERING' })).reasonCode,
    'CONVERSATION_ACTIVE',
  );
});

test('SCORE_BELOW_THRESHOLD: the threshold is a ceiling on willingness, not a suggestion', () => {
  const five = Object.fromEntries(Object.keys(STRONG).slice(0, 5).map((name) => [name, 1])); // 0.5
  // Under the shipped default (0.85 → 0.495) a 0.5 candidate now clears the bar, so the
  // "refused by the default" case is one component weaker.
  const four = Object.fromEntries(Object.keys(STRONG).slice(0, 4).map((name) => [name, 1])); // 0.4
  assert.equal(evaluateProactiveGates(candidate({ components: four }), context()).reasonCode, 'SCORE_BELOW_THRESHOLD');
  assert.equal(evaluateProactiveGates(candidate({ components: {} }), context()).reasonCode, 'SCORE_BELOW_THRESHOLD');
  // Boundary pair at a reachable threshold: proactivity 0.5 → 0.6.
  const six = Object.fromEntries(Object.keys(STRONG).slice(0, 6).map((name) => [name, 1])); // 0.6
  assert.equal(evaluateProactiveGates(candidate({ components: six }), context({ proactivity: 0.5 })).reasonCode, 'PASSED');
  assert.equal(evaluateProactiveGates(candidate({ components: five }), context({ proactivity: 0.5 })).reasonCode, 'SCORE_BELOW_THRESHOLD');
  // A more proactive personality only lowers the bar — it never removes a gate.
  const result = evaluateProactiveGates(candidate({ components: five }), context({ proactivity: 1 }));
  assert.equal(result.reasonCode, 'PASSED', '0.5 clears the 0.45 floor');
  assert.equal(result.threshold, 0.45, 'proactivity 1 buys the lowest threshold there is');
  assert.equal(result.score, 0.5);
  // …and the same candidate is refused by the same gate once the floor no longer
  // covers it, which is the whole point of a threshold instead of a boolean.
  assert.equal(evaluateProactiveGates(candidate({ components: {} }), context({ proactivity: 1 })).reasonCode, 'SCORE_BELOW_THRESHOLD');
});

test('SCENE_UNAVAILABLE and SPEECH_UNAVAILABLE', () => {
  assert.equal(evaluateProactiveGates(candidate(), context({ sceneAvailable: false })).reasonCode, 'SCENE_UNAVAILABLE');
  assert.equal(evaluateProactiveGates(candidate(), context({ speechAvailable: false })).reasonCode, 'SPEECH_UNAVAILABLE');
  assert.equal(
    evaluateProactiveGates(candidate(), context({ sceneAvailable: false, speechAvailable: false })).reasonCode,
    'SCENE_UNAVAILABLE',
  );
  // Precedence: an unusable room does not hide a candidate that was too weak anyway.
  assert.equal(
    evaluateProactiveGates(candidate({ components: {} }), context({ sceneAvailable: false })).reasonCode,
    'SCORE_BELOW_THRESHOLD',
  );
});

test('negative feedback tightens the cooldown and the budget', () => {
  // Cooldown: 5 min normally, 10 min after negative feedback.
  const sevenMinutesAgo = [delivered('older', minutesBefore(AFTERNOON, 7))];
  assert.equal(evaluateProactiveGates(candidate(), context({ history: sevenMinutesAgo })).reasonCode, 'PASSED');
  assert.equal(
    evaluateProactiveGates(candidate(), context({ history: sevenMinutesAgo, negativeFeedback: true })).reasonCode,
    'COOLDOWN_ACTIVE',
  );

  // Budget: floor(15 / 2) = 7 in the 6-hour window (all of them older than the tightened 10-min cooldown).
  const sevenOldOnes = [15, 25, 35, 45, 55, 65, 75].map((minutes) => delivered(`old_${minutes}`, minutesBefore(AFTERNOON, minutes)));
  assert.equal(evaluateProactiveGates(candidate(), context({ history: sevenOldOnes })).reasonCode, 'PASSED');
  assert.equal(
    evaluateProactiveGates(candidate(), context({ history: sevenOldOnes, negativeFeedback: true })).reasonCode,
    'QUOTA_6H_EXCEEDED',
  );

  // A configured multiplier is used, and it can never stop Xixi speaking forever.
  const harsh = settings({ negativeFeedbackCooldownMultiplier: 10, maxPerDay: 1 });
  const one = [delivered('a', minutesBefore(AFTERNOON, 10 * 60))];
  assert.equal(evaluateProactiveGates(candidate(), context({ settings: harsh, history: one, negativeFeedback: true })).reasonCode, 'QUOTA_DAY_EXCEEDED');
});

test('the reason-code list names every outcome the gates can return', () => {
  const seen = new Set<string>();
  const cases: readonly ProactiveGateContext[] = [
    context({ settings: settings({ enabled: false }) }),
    context(),
    context({ history: [delivered('cand_1', minutesBefore(AFTERNOON, 60))] }),
    context({ conversationState: 'SUSPENDED' }),
    context({ now: at('2026-09-30T23:00:00+08:00') }),
    context({ history: [delivered('older', minutesBefore(AFTERNOON, 1))] }),
    context({ history: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => delivered(`old_${n}`, minutesBefore(AFTERNOON, 20 * n))) }),
    context({ settings: settings({ maxPer6h: 100, maxPerDay: 1 }), history: [delivered('old', minutesBefore(AFTERNOON, 30))] }),
    context({ history: [delivered('old', minutesBefore(AFTERNOON, 30), 'hook_weather')] }),
    context({ conversationState: 'LINGERING' }),
    context({ proactivity: 0 }),
    context({ sceneAvailable: false, proactivity: 0 }),
    context({ proactivity: 0, sceneAvailable: false }),
  ];
  const scores = [{}, STRONG];
  for (const ctx of cases) {
    for (const components of scores) {
      seen.add(evaluateProactiveGates(candidate({ topicRef: 'hook_weather', components }), ctx).reasonCode);
    }
  }
  assert.ok(seen.has('PASSED'));
  for (const code of seen) assert.ok(PROACTIVE_REASON_CODES.includes(code as never), `${code} must be a registered code`);
  assert.ok(seen.size >= 8, `expected several distinct outcomes, saw ${[...seen].join(', ')}`);
});
