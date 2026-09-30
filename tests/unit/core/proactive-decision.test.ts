import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEvent, getEventType, validateEvent, validateSchema } from '@xixi/contracts';
import {
  PROACTIVE_MODEL_REASON_CODES,
  ProactiveEngine,
  readProactiveConsultations,
  readProactiveHistory,
  type ProactiveCandidate,
  type ProactiveDelivery,
  type ProactiveModelDecision,
  type ProactiveSettings,
} from '@xixi/conversation';
import { openXixiStore, type XixiStore } from '@xixi/domain';

/**
 * P5 / ADR-0011: **the model decides whether to speak** above the hard floor, and that decision is
 * auditable exactly like a program decision.
 *
 * What is pinned here:
 *   * a model "不说" is honoured *and* recorded (`MODEL_DECLINED` + `decided_by: model` + an
 *     allowlisted `model_reason_code` + the scores it saw) — 铁律 5 keeps it to codes and numbers;
 *   * the model is **only asked when the social budget already recommends speaking**, so an
 *     obviously-bad moment costs nothing and the daily budget counts every consultation;
 *   * a failing model degrades to "不说", never to a yes;
 *   * `basis` is program-rendered Chinese, identical whatever the model answers;
 *   * the schema stays additive: an old-shaped event still validates.
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

const WEAK: Readonly<Record<string, number>> = { topic_quality: 0.1, receptivity: 0.1 };

function candidate(id = 'cand_1', components: Readonly<Record<string, number>> = STRONG): ProactiveCandidate {
  return { candidateId: id, trigger: 'topic_pool', components, topicRef: 'hook_books', intent: 'small_talk' };
}

function open(dir: string): XixiStore {
  const store = openXixiStore({ dbPath: join(dir, 'xixi.sqlite'), clock: () => new Date(T0) });
  store.seedSelfProfile({ proactivity: 0.55 });
  return store;
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'xixi-proactive-decision-'));
}

function engineFor(store: XixiStore, options: { readonly decide?: (input: unknown) => Promise<ProactiveModelDecision> | ProactiveModelDecision; readonly settings?: ProactiveSettings } = {}): ProactiveEngine {
  return new ProactiveEngine({
    store,
    clock: () => new Date(T0),
    offsetMinutes: OFFSET,
    ...(options.decide === undefined ? {} : { decide: options.decide as never }),
  });
}

function decisions(store: XixiStore): Record<string, unknown>[] {
  return store
    .readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })
    .map((event) => event.payload as unknown as Record<string, unknown>);
}

test('the model can say 「不说」, and the record shows why (读空气, ADR-0011)', async () => {
  const root = dir();
  const store = open(root);
  try {
    const engine = engineFor(store, { decide: () => ({ speak: false, reasonCode: 'user_quiet' }) });
    const outcome = await engine.consider({
      candidate: candidate(),
      at: T0,
      conversationState: 'IDLE',
      deliver: () => assert.fail('a declined candidate must not be delivered'),
    });

    assert.equal(outcome.speak, false);
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.reasonCode, 'MODEL_DECLINED');
    assert.equal(outcome.decidedBy, 'model');
    assert.equal(outcome.modelConsulted, true);
    assert.equal(outcome.modelReasonCode, 'user_quiet');
    assert.ok(outcome.score > outcome.threshold, 'the budget recommended speaking — the model overruled it');

    const [payload] = decisions(store);
    assert.equal(payload?.['speak'], false);
    assert.equal(payload?.['reason_code'], 'MODEL_DECLINED');
    assert.equal(payload?.['decided_by'], 'model');
    assert.equal(payload?.['model_reason_code'], 'user_quiet');
    assert.equal(payload?.['model_consulted'], true);
    assert.equal(payload?.['recommendation'], 'speak');
    assert.equal(payload?.['initiative_kind'], 'external_sharing');
    assert.equal(typeof payload?.['score'], 'number');
    assert.ok(Array.isArray(payload?.['basis']) && (payload?.['basis'] as string[]).length > 0);
    assert.equal(readProactiveHistory(store).length, 0, 'a "不说" is not a budget item');
    assert.equal(readProactiveConsultations(store).length, 1, 'but the call is visible to the count-based cost proxy');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('the model is only asked when the social budget already recommends speaking', async () => {
  const root = dir();
  const store = open(root);
  try {
    let asked = 0;
    const engine = engineFor(store, {
      decide: () => {
        asked += 1;
        return { speak: true, reasonCode: 'good_moment' };
      },
    });
    const outcome = await engine.consider({ candidate: candidate('cand_weak', WEAK), at: T0, conversationState: 'IDLE' });

    assert.equal(asked, 0, 'an obviously-bad moment must not cost a model call');
    assert.equal(outcome.speak, false);
    assert.equal(outcome.reasonCode, 'BELOW_RECOMMENDATION');
    assert.equal(outcome.decidedBy, 'program');
    assert.equal(outcome.modelConsulted, false);
    assert.equal(readProactiveConsultations(store).length, 0);
    // The recommendation is auditable in words as well as in numbers.
    assert.equal(decisions(store)[0]?.['recommendation'], 'hold');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a model that agrees delivers once; a failing model never becomes a yes', async () => {
  const root = dir();
  const store = open(root);
  try {
    const delivered: ProactiveDelivery[] = [];
    const agreeing = engineFor(store, { decide: () => ({ speak: true, reasonCode: 'good_moment' }) });
    const first = await agreeing.consider({
      candidate: candidate('cand_ok'),
      at: T0,
      conversationState: 'IDLE',
      deliver: (delivery) => void delivered.push(delivery),
    });
    assert.equal(first.speak, true);
    assert.equal(first.reasonCode, 'PASSED');
    assert.equal(first.decidedBy, 'model');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.initiativeKind, 'external_sharing');
    assert.equal(readProactiveHistory(store).length, 1);

    const failing = engineFor(store, {
      decide: () => {
        throw new Error('provider down');
      },
    });
    const second = await failing.consider({ candidate: candidate('cand_fail'), at: new Date(T0.getTime() + 60 * 60_000), conversationState: 'IDLE' });
    assert.equal(second.speak, false, 'a broken model must not be read as permission');
    assert.equal(second.reasonCode, 'MODEL_DECLINED');
    assert.equal(second.modelReasonCode, 'wrong_moment');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('basis is program text and does not move with the model’s answer (铁律 5)', async () => {
  const root = dir();
  const store = open(root);
  try {
    const run = async (id: string, decision: ProactiveModelDecision): Promise<Record<string, unknown>> => {
      const engine = engineFor(store, { decide: () => decision });
      await engine.consider({ candidate: candidate(id), at: new Date(T0.getTime() + 2 * 60 * 60_000), conversationState: 'IDLE' });
      const rows = decisions(store);
      return rows[rows.length - 1] as Record<string, unknown>;
    };

    const declined = await run('cand_a', { speak: false, reasonCode: 'not_worth_it' });
    const accepted = await run('cand_b', { speak: true, reasonCode: 'good_moment' });

    assert.deepEqual(declined['basis'], accepted['basis'], 'the 依据 is computed from the program’s own numbers');
    assert.equal(declined['decided_by'], 'model');
    assert.notEqual(declined['reason_code'], accepted['reason_code']);
    assert.equal(declined['model_reason_code'], 'not_worth_it');
    assert.equal(accepted['model_reason_code'], 'good_moment');
    // 铁律 5: codes and numbers only — the model's prose never reaches the payload.
    assert.equal(JSON.stringify(declined).includes('good_moment'), false);
    assert.ok((declined['basis'] as string[]).every((line) => /[\u4e00-\u9fff]/.test(line)));
    for (const code of [declined['model_reason_code'], accepted['model_reason_code']]) {
      assert.ok(PROACTIVE_MODEL_REASON_CODES.includes(code as never), `${String(code)} must be an allowlisted code`);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a free-text model reason is normalised onto the allowlist', async () => {
  const root = dir();
  const store = open(root);
  try {
    const engine = engineFor(store, { decide: () => ({ speak: false, reasonCode: 'because I felt like it, honestly' }) });
    const outcome = await engine.consider({ candidate: candidate(), at: T0, conversationState: 'IDLE' });
    assert.equal(outcome.modelReasonCode, 'unspecified');
    assert.equal(decisions(store)[0]?.['model_reason_code'], 'unspecified');
    assert.equal(JSON.stringify(decisions(store)).includes('felt like it'), false, 'no free text may be stored');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a consultation is charged to the daily budget, so "不说" cannot be free forever', async () => {
  const root = dir();
  const store = open(root);
  try {
    let asked = 0;
    const engine = new ProactiveEngine({
      store,
      clock: () => new Date(T0),
      offsetMinutes: OFFSET,
      settings: { ...(await import('@xixi/conversation')).DEFAULT_PROACTIVE_SETTINGS, maxPerDay: 1 },
      decide: () => {
        asked += 1;
        return { speak: false, reasonCode: 'user_busy' };
      },
    });
    const first = await engine.consider({ candidate: candidate('cand_1'), at: T0, conversationState: 'IDLE' });
    assert.equal(first.modelConsulted, true);
    assert.equal(asked, 1);

    // The day is spent (one consultation), so the second consideration never reaches the model.
    const second = await engine.consider({ candidate: candidate('cand_2'), at: new Date(T0.getTime() + 60_000), conversationState: 'IDLE' });
    assert.equal(second.reasonCode, 'QUOTA_DAY_EXCEEDED');
    assert.equal(second.modelConsulted, false);
    assert.equal(asked, 1, 'the budget must cap paid calls');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('the hard floor is still decided before the model is ever consulted', async () => {
  const root = dir();
  const store = open(root);
  try {
    let asked = 0;
    const engine = engineFor(store, {
      decide: () => {
        asked += 1;
        return { speak: true, reasonCode: 'good_moment' };
      },
    });
    const night = new Date('2026-09-30T23:45:00+08:00');
    const outcome = await engine.consider({ candidate: candidate(), at: night, conversationState: 'IDLE' });
    assert.equal(outcome.reasonCode, 'QUIET_HOURS');
    assert.equal(asked, 0, 'the model cannot be asked to override the quiet hours');
    const privacy = await engine.consider({ candidate: candidate('cand_2'), at: T0, conversationState: 'IDLE', privacyAllowed: false });
    assert.equal(privacy.reasonCode, 'PRIVACY_BLOCKED');
    assert.equal(asked, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// ------------------------------------------------------------------ schema

test('the payload schema stays additive: an old-shaped event still validates', () => {
  const legacy = buildEvent({
    event_type: 'proactive.decision',
    source: 'conversation',
    actor: 'system',
    confidence: 1,
    timestamp: '2026-09-30T14:00:00.000+08:00',
    payload: {
      session_id: null,
      candidate_id: 'cand_legacy',
      trigger: 'topic_pool',
      speak: false,
      reason_code: 'COOLDOWN_ACTIVE',
      score: 0.4,
      threshold: 0.495,
      topic_ref: null,
      intent: null,
      delivered: false,
    },
  });
  assert.equal(validateEvent(legacy).event_id, legacy.event_id, 'the ADR-0009 shape must keep validating');

  const modern = buildEvent({
    event_type: 'proactive.decision',
    source: 'conversation',
    actor: 'system',
    confidence: 1,
    timestamp: '2026-09-30T14:00:00.000+08:00',
    payload: {
      session_id: null,
      candidate_id: 'cand_modern',
      trigger: 'topic_pool',
      speak: true,
      reason_code: 'PASSED',
      score: 0.8,
      threshold: 0.495,
      topic_ref: 'hook_books',
      intent: 'small_talk',
      delivered: true,
      initiative_kind: 'external_sharing',
      recommendation: 'speak',
      primary_signal: 'topic_quality',
      signals: {
        topic_quality: 1,
        personal_relevance: 1,
        freshness: 1,
        receptivity: 1,
        engagement: 1,
        base_proactivity: 0.85,
        interruption_cost: 0,
        repeated_topic_penalty: 0,
        recent_unanswered_penalty: 0,
      },
      basis: ['话题质量分 1（权重 0.3 → +0.3）'],
      decided_by: 'model',
      model_reason_code: 'good_moment',
      model_consulted: true,
    },
  });
  assert.equal(validateEvent(modern).event_id, modern.event_id, 'the P5 shape validates too');

  // …and the schema is still fail-closed: an undeclared key is refused.
  const schema = getEventType('proactive.decision').payloadSchema;
  const withUnknown = validateSchema(schema, { ...(modern.payload as Record<string, unknown>), not_a_field: 1 });
  assert.equal(withUnknown.ok, false);
  assert.ok(withUnknown.problems.some((problem) => problem.includes('not_a_field')));
});
