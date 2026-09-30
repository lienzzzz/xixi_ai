import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBrainAdapter, type ScriptedOutcome, type UserTurnInput } from '@xixi/brain-adapter';
import { ConversationEngine, DEFAULT_SILENCE_TOLERANCE } from '@xixi/conversation';
import { fixedClock, openXixiStore, type Clock, type XixiConfig, type XixiStore } from '@xixi/domain';

/**
 * 人格可调（《方案》§7.2）在会话层必须真的生效。
 *
 * `silence_tolerance` scales the follow-up window (§12.2), but the engine used to
 * build the FSM without reading `store.selfProfile()`. The default was also 0.7 —
 * the same value the seeded personality carries — so "forgot to wire it" was
 * invisible. These tests drive the engine (no hand-built FSM) and assert that two
 * different persisted personalities produce two different windows.
 */

const T0 = new Date('2026-09-30T10:00:00+08:00');

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: {
    llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false },
    asr: { provider: 'fake', model: 'fake-asr' },
    tts: { provider: 'fake', model: 'fake-tts' },
  },
  personality: { base: {} },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

function storeWith(tolerance: number): XixiStore {
  const store = openXixiStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-personality-')), 'x.sqlite'),
    clock: fixedClock(new Date(T0), 1_000),
  });
  store.seedSelfProfile({ silence_tolerance: tolerance });
  return store;
}

function engineFor(store: XixiStore, opts: { fsm?: { lingerMs: number }; clock?: Clock } = {}): ConversationEngine {
  const reply = (input: UserTurnInput): ScriptedOutcome => ({ action: 'SPEAK', text: `收到：${input.text}` });
  return new ConversationEngine({
    adapter: new FakeBrainAdapter({ reply }),
    store,
    config: CONFIG,
    clock: opts.clock ?? fixedClock(new Date(T0), 1_000),
    offsetMinutes: 480,
    // Deliberately no `silenceTolerance` here: the personality must supply it.
    fsm: { lingerMs: 30_000, ...(opts.fsm ?? {}) },
  });
}

test('the engine takes silence_tolerance from the persisted personality', () => {
  const patient = storeWith(1);
  const impatient = storeWith(0);
  try {
    // tolerance 1 → 30s × 1.5 = 45s; tolerance 0 → 30s × 0.5 = 15s.
    assert.equal(engineFor(patient).lingerMs, 45_000);
    assert.equal(engineFor(impatient).lingerMs, 15_000);
    assert.equal(engineFor(patient).silenceTolerance, 1);
    assert.equal(engineFor(impatient).silenceTolerance, 0);
  } finally {
    patient.close();
    impatient.close();
  }
});

test('a store without the property falls back to the named default, not a hidden one', () => {
  const store = openXixiStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-personality-empty-')), 'x.sqlite'),
    clock: fixedClock(new Date(T0), 1_000),
  });
  try {
    // Nothing seeded (a profile created before the property existed). The engine
    // resolves the value in one place — personality → explicit override →
    // DEFAULT_SILENCE_TOLERANCE — so the window is still readable, and the FSM
    // itself never invents a value (see tests/unit/conversation-fsm.test.ts).
    const engine = engineFor(store);
    assert.equal(engine.silenceTolerance, DEFAULT_SILENCE_TOLERANCE);
    assert.equal(engine.lingerMs, Math.round(30_000 * (0.5 + DEFAULT_SILENCE_TOLERANCE)));

    // An explicit constructor override is the second step of that precedence.
    const overridden = new ConversationEngine({
      adapter: new FakeBrainAdapter({ reply: () => ({ action: 'SPEAK', text: '好' }) }),
      store,
      config: CONFIG,
      clock: fixedClock(new Date(T0), 1_000),
      fsm: { lingerMs: 30_000, silenceTolerance: 0 },
    });
    assert.equal(overridden.lingerMs, 15_000);
  } finally {
    store.close();
  }
});

test('the same follow-up question is answered differently for two personalities, through the engine', async () => {
  const patient = storeWith(1);
  const impatient = storeWith(0);
  try {
    const toleranceFor = async (store: XixiStore): Promise<string | null> => {
      const engine = engineFor(store);
      const session = store.createSession();
      const first = await engine.respond({ sessionId: session.sessionId, text: '第一句', addressed: true });
      assert.equal(first.accepted, true);
      assert.equal(first.state, 'LINGERING');
      // 30 s of silence: inside the tolerant 45 s window, past the impatient 15 s one.
      engine.tick(new Date(T0.getTime() + 30_000));
      const after = await engine.respond({ sessionId: session.sessionId, text: '还在吗', addressed: false });
      return after.accepted ? after.reason : 'REJECTED';
    };

    const patientAnswer = await toleranceFor(patient);
    const impatientAnswer = await toleranceFor(impatient);
    assert.equal(patientAnswer, 'ACCEPTED_CONTINUATION', 'silence_tolerance 1 must keep the session open longer');
    assert.equal(impatientAnswer, 'REJECTED', 'silence_tolerance 0 must close it sooner');
    assert.notEqual(patientAnswer, impatientAnswer, 'the personality must change observable behaviour');
  } finally {
    patient.close();
    impatient.close();
  }
});

test('a personality changed at runtime is re-read on the next turn', async () => {
  const store = storeWith(0);
  try {
    const engine = engineFor(store);
    assert.equal(engine.lingerMs, 15_000);
    // Administrative override (the M3 seam): the very next turn must already use it.
    store.overrideSelfProfile({ silence_tolerance: 1 }, 'test:override');
    const session = store.createSession();
    await engine.respond({ sessionId: session.sessionId, text: '第一句', addressed: true });
    assert.equal(engine.lingerMs, 45_000, 'the follow-up window must follow the new personality');
  } finally {
    store.close();
  }
});

test('the decision event records the personality that produced the window', async () => {
  const store = storeWith(0.2);
  try {
    const engine = engineFor(store);
    const session = store.createSession();
    await engine.respond({ sessionId: session.sessionId, text: '第一句' });
    const [decision] = store.readEvents({ type: 'conversation.decision' });
    const payload = decision?.payload as { silence_tolerance: number; linger_ms: number; accepted: boolean };
    assert.equal(payload.silence_tolerance, 0.2);
    // 30s × (0.5 + 0.2) = 21s
    assert.equal(payload.linger_ms, 21_000, 'the logged window must be the one the FSM actually used');
    assert.equal(payload.accepted, true);
  } finally {
    store.close();
  }
});
