import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEvent, toOffsetIso } from '@xixi/contracts';
import {
  DEFAULT_PROACTIVE_SETTINGS,
  PROACTIVE_SIGNALS,
  ProactiveEngine,
  readProactiveHistory,
  type ProactiveCandidate,
  type ProactiveDelivery,
} from '@xixi/conversation';
import { openXixiStore, type XixiStore } from '@xixi/domain';

/**
 * The Proactive Engine's auditable half: one event per consideration, delivery at most once, and
 * every gate input rebuildable from the event log after a restart (AGENTS.md §3, ADR-0009 → P5).
 *
 * P5 changed *what* the record contains (the social budget, the initiative kind, the Chinese
 * 依据 and who decided) but not the at-most-once contract, so those properties are kept here.
 */

const T0 = new Date('2026-09-30T14:00:00+08:00'); // 14:00 local, outside quiet hours
const OFFSET = 480;

const STRONG: Readonly<Record<string, number>> = {
  topic_quality: 1,
  personal_relevance: 1,
  freshness: 1,
  receptivity: 1,
  engagement: 1,
};

/** Every key `proactive.decision` v1 declares — and nothing else (铁律 5). */
const ALLOWED_PAYLOAD_KEYS = [
  'basis',
  'candidate_id',
  'decided_by',
  'delivered',
  'initiative_kind',
  'intent',
  'model_consulted',
  'model_reason_code',
  'primary_signal',
  'reason_code',
  'recommendation',
  'score',
  'session_id',
  'signals',
  'speak',
  'threshold',
  'topic_ref',
  'trigger',
];

function candidate(id: string, overrides: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  return { candidateId: id, trigger: 'topic_pool', components: STRONG, ...overrides };
}

function minutesBefore(base: Date, minutes: number): Date {
  return new Date(base.getTime() - minutes * 60_000);
}

/**
 * One answering user turn at `at`, straight into the log.
 *
 * These fixtures ask "does the *score* still hold", and an unanswered fixture would quietly turn
 * those assertions into unanswered-streak assertions (t9 F2 escalates consecutive non-answers), so
 * a test that is not about 未回应 answers its own deliveries here.
 */
function answeringTurn(store: XixiStore, sessionId: string, at: Date, turnIndex: number): void {
  store.appendEvent(
    buildEvent({
      event_type: 'conversation.turn',
      source: 'test',
      actor: 'father',
      confidence: 1,
      session_id: sessionId,
      timestamp: toOffsetIso(at),
      payload: { session_id: sessionId, turn_index: turnIndex, role: 'user', text: '嗯，听到了。', action: 'SPEAK' },
    }),
  );
}

function open(dir: string): XixiStore {
  const store = openXixiStore({ dbPath: join(dir, 'xixi.sqlite'), clock: () => new Date(T0) });
  // 0.55 is an **explicit input, not the shipped default** (0.85). It enters the budget as
  // `base_proactivity`, so the numbers below stay checkable while the default moves.
  store.seedSelfProfile({ proactivity: 0.55 });
  return store;
}

function engineFor(store: XixiStore, config?: Record<string, unknown>): ProactiveEngine {
  return new ProactiveEngine({
    store,
    config,
    clock: () => new Date(T0),
    offsetMinutes: OFFSET,
  });
}

function deliveries(): { readonly log: ProactiveDelivery[]; readonly deliver: (d: ProactiveDelivery) => void } {
  const log: ProactiveDelivery[] = [];
  return { log, deliver: (delivery) => void log.push(delivery) };
}

function decisions(store: XixiStore): Record<string, unknown>[] {
  return store
    .readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })
    .map((event) => event.payload as unknown as Record<string, unknown>);
}

test('an accepted candidate is delivered once, and the audit explains why it spoke', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-proactive-'));
  const store = open(dir);
  try {
    const engine = engineFor(store);
    const session = store.createSession();
    const spy = deliveries();
    const outcome = await engine.consider({
      candidate: candidate('cand_1', { topicRef: 'hook_weather', intent: 'small_talk' }),
      at: T0,
      conversationState: 'IDLE',
      sessionId: session.sessionId,
      deliver: spy.deliver,
    });

    assert.equal(outcome.speak, true);
    assert.equal(outcome.delivered, true);
    assert.equal(outcome.reasonCode, 'PASSED');
    assert.equal(outcome.decidedBy, 'program', 'no model seam ⇒ the deterministic recommendation decides');
    assert.equal(outcome.modelConsulted, false);
    assert.equal(outcome.initiativeKind, 'external_sharing');
    // 0.85 of signals + 0.15 × proactivity 0.55 − the first-message penalties (nothing to grade yet).
    assert.equal(outcome.score, 0.9325);
    assert.equal(outcome.threshold, 0.585, 'explicit proactivity 0.55 → 0.585: an input, not the default 0.85');
    assert.equal(spy.log.length, 1, 'the model seam is called exactly once');
    assert.deepEqual(spy.log[0], {
      candidateId: 'cand_1',
      trigger: 'topic_pool',
      initiativeKind: 'external_sharing',
      intent: 'small_talk',
      topicRef: 'hook_weather',
      score: 0.9325,
      threshold: 0.585,
      sessionId: session.sessionId,
    });

    const recorded = decisions(store);
    assert.equal(recorded.length, 1, 'exactly one audit record per consideration');
    const payload = recorded[0];
    assert.equal(payload.speak, true);
    assert.equal(payload.delivered, true);
    assert.equal(payload.reason_code, 'PASSED');
    assert.equal(payload.candidate_id, 'cand_1');
    assert.equal(payload.trigger, 'topic_pool');
    assert.equal(payload.initiative_kind, 'external_sharing');
    assert.equal(payload.topic_ref, 'hook_weather');
    assert.equal(payload.intent, 'small_talk');
    assert.equal(payload.session_id, session.sessionId);
    assert.equal(payload.score, 0.9325);
    assert.equal(payload.threshold, 0.585);
    assert.equal(payload.recommendation, 'speak');
    assert.equal(payload.primary_signal, 'topic_quality');
    assert.equal(payload.decided_by, 'program');
    assert.equal(payload.model_consulted, false);
    // The 依据 is program-rendered Chinese, one line per used signal plus the summary.
    const basis = payload.basis as string[];
    assert.ok(Array.isArray(basis) && basis.length >= 6, `expected a 依据 per used signal, got ${basis.length}`);
    assert.ok(basis.some((line) => line.includes('话题质量分')));
    assert.ok(basis.some((line) => line.includes('社会预算总分')));
    // The signals are stored as numbers, one key per declared signal.
    assert.deepEqual(Object.keys(payload.signals as Record<string, number>).sort(), [...PROACTIVE_SIGNALS].sort());
    // 铁律 5: an audit record is codes, numbers and program-rendered labels — no prose, no reasoning.
    assert.deepEqual(Object.keys(payload).sort(), ALLOWED_PAYLOAD_KEYS);
    // The event is versioned like every other persisted record (铁律 10).
    const event = store.readEvents({ type: 'proactive.decision' })[0];
    assert.equal(event?.schema_version, 1);
    assert.equal(event?.event_type, 'proactive.decision');
    assert.equal(store.readEvents({ type: 'proactive.decision', sessionId: session.sessionId }).length, 1);
    assert.equal(readProactiveHistory(store).length, 1);
  } finally {
    store.close();
  }
});

test('a blocked candidate is audited with its reason and never reaches the model seam', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-proactive-'));
  const store = open(dir);
  try {
    const engine = engineFor(store);
    const spy = deliveries();
    const outcome = await engine.consider({
      candidate: candidate('cand_1'),
      at: T0,
      conversationState: 'LINGERING',
      deliver: spy.deliver,
    });

    assert.equal(outcome.speak, false);
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.reasonCode, 'CONVERSATION_ACTIVE');
    assert.equal(outcome.event?.event_type, 'proactive.decision');
    assert.equal(spy.log.length, 0, 'a blocked candidate must not reach the model seam');
    const recorded = decisions(store);
    assert.equal(recorded.length, 1, 'the log must answer "why didn\'t Xixi say anything?"');
    assert.equal(recorded[0]?.speak, false);
    assert.equal(recorded[0]?.delivered, false);
    assert.equal(recorded[0]?.reason_code, 'CONVERSATION_ACTIVE');
    assert.ok((recorded[0]?.basis as string[]).length > 0, 'even a blocked decision explains itself');
    assert.equal(readProactiveHistory(store).length, 0, 'a block is not a budget item');
  } finally {
    store.close();
  }
});

test('a disabled engine decides nothing and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-proactive-'));
  const store = open(dir);
  try {
    const engine = engineFor(store, { enabled: false });
    const spy = deliveries();
    const outcome = await engine.consider({ candidate: candidate('cand_1'), at: T0, conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(outcome.reasonCode, 'DISABLED');
    assert.equal(outcome.event, null, 'a switched-off engine is not a gate decision');
    assert.equal(store.readEvents({ type: 'proactive.decision' }).length, 0);
    assert.equal(spy.log.length, 0);
  } finally {
    store.close();
  }
});

test('restart: a delivered candidate is never delivered twice, and the budget comes back with the log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-proactive-'));
  const first = open(dir);
  const firstSpy = deliveries();
  try {
    const engine = engineFor(first);
    const outcome = await engine.consider({
      candidate: candidate('cand_1'),
      at: T0,
      conversationState: 'IDLE',
      deliver: firstSpy.deliver,
    });
    assert.equal(outcome.speak, true);
  } finally {
    first.close();
  }
  assert.equal(firstSpy.log.length, 1);

  // A new process, the same database: the log is the only state the engine has.
  const second = open(dir);
  try {
    const engine = engineFor(second);
    const spy = deliveries();
    const threeMinutesLater = new Date(T0.getTime() + 3 * 60_000);
    const again = await engine.consider({ candidate: candidate('cand_1'), at: threeMinutesLater, conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(again.reasonCode, 'ALREADY_DELIVERED');
    assert.equal(again.speak, false);
    assert.equal(spy.log.length, 0, 'a restart must not re-deliver a message that was already spoken');

    // A *different* candidate three minutes later is **not** vetoed any more (ADR-0011): every
    // penalty is a grade, and the record says which one dominated. Three stacked grades (just
    // spoke, a generic line just went out, nobody answered) can still add up to a "hold" —
    // that is the *recommendation*, not `COOLDOWN_ACTIVE`.
    const other = await engine.consider({ candidate: candidate('cand_2'), at: threeMinutesLater, conversationState: 'IDLE', deliver: spy.deliver });
    assert.notEqual(other.reasonCode, 'COOLDOWN_ACTIVE', 'the retired veto code must never be emitted');
    assert.ok(other.signals.interruption_cost > 0.8, '3 minutes into an 18-minute window is expensive');
    assert.ok(other.signals.repeated_topic_penalty > 0, 'the generic line 3 minutes ago still costs');
    assert.equal(other.recommendation, 'hold', 'and the budget says so in words: 建议这次不说');
    assert.equal(other.modelConsulted, false, 'no model seam wired here');

    // A specific, *answered* candidate passes inside the same window — the proof that the cooldown is
    // a grade rather than a veto.
    const fresh = await engine.consider({
      candidate: candidate('cand_2b', { topicRef: 'hook_books' }),
      at: new Date(T0.getTime() + 3 * 60_000 + 30_000),
      conversationState: 'IDLE',
      deliver: spy.deliver,
    });
    assert.equal(fresh.reasonCode, 'PASSED', 'a different topic right after a delivery is allowed');
    assert.ok(fresh.signals.interruption_cost > 0.8, 'it still pays the interruption grade');

    // The household answers both messages (this is the "answered" part the comment above promises);
    // without it t9 F2's consecutive-unanswered escalation — a deliberate design change — would be
    // what holds the next candidate, not the interruption/repeat grades this test is about.
    const session = second.createSession();
    answeringTurn(second, session.sessionId, new Date(T0.getTime() + 4 * 60_000), 0);

    // Well past the window the same history costs nothing, so the grade — not a veto — was in play.
    const muchLater = new Date(T0.getTime() + 40 * 60_000);
    const relaxed = await engine.consider({ candidate: candidate('cand_3'), at: muchLater, conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(relaxed.signals.interruption_cost, 0);
    assert.equal(relaxed.reasonCode, 'PASSED');
    assert.equal(readProactiveHistory(second).length, 3, 'cand_1 + the two that passed — the hold is not a budget item');
    assert.equal(decisions(second).length, 5, 'every consideration, delivered or not, is audited');
  } finally {
    second.close();
  }
});

test('quotas are recomputed from the log, so a restart cannot reset the daily budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-proactive-'));
  const store = open(dir);
  try {
    const engine = engineFor(store);
    const spy = deliveries();
    const session = store.createSession();
    // Fifteen deliveries inside the 6-hour window, 20 min apart, all with a strong candidate: the
    // rolling 6-hour quota is exactly saturated.
    const times = [5, 25, 45, 65, 85, 105, 125, 145, 165, 185, 205, 225, 245, 265, 285].map(
      (minutes) => new Date(T0.getTime() - minutes * 60_000),
    );
    for (const [index, at] of times.entries()) {
      const outcome = await engine.consider({
        candidate: candidate(`cand_${index}`),
        at,
        conversationState: 'IDLE',
        deliver: spy.deliver,
      });
      assert.equal(outcome.speak, true, `delivery ${index + 1} should pass (reason ${outcome.reasonCode})`);
      // Answered one minute later: this test measures the rolling quota, not the unanswered streak.
      answeringTurn(store, session.sessionId, new Date(at.getTime() + 60_000), index);
    }
    assert.equal(spy.log.length, 15);

    const sixteenth = await engine.consider({ candidate: candidate('cand_15'), at: T0, conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(sixteenth.reasonCode, 'QUOTA_6H_EXCEEDED');
    assert.equal(readProactiveHistory(store).length, 15);

    // Three hours later the six oldest have left the window (6h exactly does not count), so delivery
    // is possible again — and today's budget still remembers all fifteen.
    const later = new Date(T0.getTime() + 3 * 60 * 60_000);
    const seventeenth = await engine.consider({ candidate: candidate('cand_16'), at: later, conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(seventeenth.reasonCode, 'PASSED', 'the rolling window must forget what left it');
    assert.equal(readProactiveHistory(store).length, 16);
    assert.equal(decisions(store).length, 17, 'every consideration is auditable, delivered or not');
  } finally {
    store.close();
  }
});

test('the engine reads config.proactive instead of inventing its own defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-proactive-'));
  const store = open(dir);
  try {
    // The example config, verbatim (config/xixi.example.yaml).
    const fromExample = engineFor(store, {
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
      triggers: { random_smalltalk: false },
    });
    assert.deepEqual(fromExample.settings, DEFAULT_PROACTIVE_SETTINGS);

    // A tighter budget is honoured: the first delivery happens, the second is refused by the
    // 6-hour quota — with the default cap of 15 it would pass.
    const engine = engineFor(store, { max_per_6h: 1 });
    const spy = deliveries();
    const first = await engine.consider({ candidate: candidate('cand_1'), at: minutesBefore(T0, 60), conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(first.speak, true);
    const second = await engine.consider({ candidate: candidate('cand_2'), at: T0, conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(second.reasonCode, 'QUOTA_6H_EXCEEDED');
    assert.equal(engine.settings.maxPer6h, 1);

    // Negative feedback multiplies the grades (cooldown is no longer a separate window).
    const feedback = engineFor(store, { negative_feedback_cooldown_multiplier: 3 });
    const after = new Date(T0.getTime() + 40 * 60_000); // well past the plain 18-min decay window
    const relaxed = await feedback.consider({
      candidate: candidate('cand_3'),
      at: after,
      conversationState: 'IDLE',
      negativeFeedback: false,
      deliver: spy.deliver,
    });
    assert.equal(relaxed.reasonCode, 'PASSED');
    assert.equal(relaxed.signals.interruption_cost, 0);
    const tightened = await feedback.consider({
      candidate: candidate('cand_4'),
      // 3 minutes, not 1: one minute after a delivery sits inside the new-session **rate floor**
      // (t9 F6, `new_session_min_gap_min: 2`), which would answer with `NEW_SESSION_FLOOR` instead
      // of exercising the stacked grades this assertion is about. Three minutes is past the floor
      // and still well inside the 18-minute interruption window.
      at: new Date(after.getTime() + 3 * 60_000),
      conversationState: 'IDLE',
      negativeFeedback: true,
      deliver: spy.deliver,
    });
    assert.ok(tightened.signals.interruption_cost > 0, '1 minute after a message, even ×3, still costs');
    assert.equal(tightened.speak, false, 'with several penalties stacked the budget recommends holding…');
    assert.equal(tightened.reasonCode, 'BELOW_RECOMMENDATION', '…as a recommendation, not as COOLDOWN_ACTIVE');
  } finally {
    store.close();
  }
});
