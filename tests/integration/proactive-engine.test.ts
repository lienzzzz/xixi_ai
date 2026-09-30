import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_PROACTIVE_SETTINGS,
  ProactiveEngine,
  readProactiveHistory,
  type ProactiveCandidate,
  type ProactiveDelivery,
} from '@xixi/conversation';
import { openXixiStore, type XixiStore } from '@xixi/domain';

/**
 * The Proactive Engine's auditable half: one event per consideration, delivery at
 * most once, and every gate input rebuildable from the event log after a restart
 * (AGENTS.md §3, ADR-0009 §6).
 */

const T0 = new Date('2026-09-30T14:00:00+08:00'); // 14:00 local, outside quiet hours
const OFFSET = 480;

const STRONG: Readonly<Record<string, number>> = {
  event_salience: 1,
  social_value: 1,
  memory_relevance: 1,
  novelty: 1,
  time_since_last_interaction: 1,
  user_receptiveness: 1,
  future_hook_bonus: 1,
};

/** Every key `proactive.decision` v1 declares — and nothing else (铁律 5). */
const ALLOWED_PAYLOAD_KEYS = [
  'candidate_id',
  'delivered',
  'intent',
  'reason_code',
  'score',
  'session_id',
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

function open(dir: string): XixiStore {
  const store = openXixiStore({ dbPath: join(dir, 'xixi.sqlite'), clock: () => new Date(T0) });
  // 0.55 is an **explicit input, not the shipped default** (that is 0.85 since ADR-0009's last update).
  // Pinning 0.55 here deliberately keeps this suite's threshold at 0.585, so the 0.585
  // assertions below are correct as written — do not "fix" them with a search-and-replace
  // when the default moves again (the default's own value is covered by the unit tests).
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
    assert.equal(outcome.score, 0.7);
    assert.equal(outcome.threshold, 0.585, 'explicit proactivity 0.55 → 0.585: an input, not the default 0.85');
    assert.equal(spy.log.length, 1, 'the model seam is called exactly once');
    assert.deepEqual(spy.log[0], {
      candidateId: 'cand_1',
      trigger: 'topic_pool',
      intent: 'small_talk',
      topicRef: 'hook_weather',
      score: 0.7,
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
    assert.equal(payload.topic_ref, 'hook_weather');
    assert.equal(payload.intent, 'small_talk');
    assert.equal(payload.session_id, session.sessionId);
    assert.equal(payload.score, 0.7);
    assert.equal(payload.threshold, 0.585);
    // 铁律 5: an audit record is a reason code plus scores — no prose, no reasoning.
    assert.deepEqual(Object.keys(payload).sort(), ALLOWED_PAYLOAD_KEYS);
    // The event is versioned like every other persisted record (铁律 10).
    const event = store.readEvents({ type: 'proactive.decision' })[0];
    assert.equal(event?.schema_version, 1);
    assert.equal(event?.event_type, 'proactive.decision');
    // The session id travels in the payload and in the projection column, so the
    // log can be queried per conversation.
    assert.equal(store.readEvents({ type: 'proactive.decision', sessionId: session.sessionId }).length, 1);
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
    // Three minutes later: inside the 5-minute cooldown, so this is also the check
    // that the cooldown came back from the log rather than resetting.
    const threeMinutesLater = new Date(T0.getTime() + 3 * 60_000);
    const again = await engine.consider({ candidate: candidate('cand_1'), at: threeMinutesLater, conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(again.reasonCode, 'ALREADY_DELIVERED');
    assert.equal(again.speak, false);
    assert.equal(spy.log.length, 0, 'a restart must not re-deliver a message that was already spoken');

    // A *different* candidate in the same window is refused by the cooldown, which
    // proves the delivery history survived the restart.
    const other = await engine.consider({ candidate: candidate('cand_2'), at: threeMinutesLater, conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(other.reasonCode, 'COOLDOWN_ACTIVE');
    assert.equal(spy.log.length, 0);

    assert.equal(readProactiveHistory(second).length, 1);
    assert.equal(decisions(second).length, 3, 'two blocked considerations and the one delivery are all audited');
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
    // Fifteen deliveries inside the 6-hour window, 20 min apart: none is inside the
    // 5-minute cooldown, and the 6-hour quota is exactly saturated.
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
      assert.equal(outcome.speak, true, `delivery ${index + 1} should pass`);
    }
    assert.equal(spy.log.length, 15);

    // The 6-hour budget is now spent: 15 deliveries inside the window, all older
    // than the cooldown, so the quota is the first gate that can fire.
    const sixteenth = await engine.consider({ candidate: candidate('cand_15'), at: T0, conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(sixteenth.reasonCode, 'QUOTA_6H_EXCEEDED');
    assert.equal(readProactiveHistory(store).length, 15);

    // Three hours later the six oldest have left the window (6h exactly does not
    // count), so delivery is possible again — and today's budget still remembers
    // all fifteen.
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
      base_cooldown_min: 5,
      max_per_6h: 15,
      max_per_day: 40,
      topic_repeat_window_h: 2,
      negative_feedback_cooldown_multiplier: 2.0,
      quiet_hours: { start: '23:30', end: '07:30' },
      triggers: { random_smalltalk: false },
    });
    assert.deepEqual(fromExample.settings, DEFAULT_PROACTIVE_SETTINGS);

    // A tighter budget is honoured: the first delivery happens, the second is
    // refused by the 6-hour quota — with the default cap of 15 it would pass.
    const engine = engineFor(store, { max_per_6h: 1 });
    const spy = deliveries();
    const first = await engine.consider({ candidate: candidate('cand_1'), at: minutesBefore(T0, 60), conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(first.speak, true);
    const second = await engine.consider({ candidate: candidate('cand_2'), at: T0, conversationState: 'IDLE', deliver: spy.deliver });
    assert.equal(second.reasonCode, 'QUOTA_6H_EXCEEDED');
    assert.equal(engine.settings.maxPer6h, 1);

    // Negative feedback tightens the cooldown by the configured multiplier.
    const feedback = engineFor(store, { negative_feedback_cooldown_multiplier: 3 });
    const after = new Date(T0.getTime() + 40 * 60_000); // well past the plain 5-min cooldown
    const relaxed = await feedback.consider({
      candidate: candidate('cand_3'),
      at: after,
      conversationState: 'IDLE',
      negativeFeedback: false,
      deliver: spy.deliver,
    });
    assert.equal(relaxed.reasonCode, 'PASSED');
    const tightened = await feedback.consider({
      candidate: candidate('cand_4'),
      at: new Date(after.getTime() + 60_000),
      conversationState: 'IDLE',
      negativeFeedback: true,
      deliver: spy.deliver,
    });
    assert.equal(tightened.reasonCode, 'COOLDOWN_ACTIVE');
  } finally {
    store.close();
  }
});
