import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBrainAdapter, type ScriptedOutcome } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { fixedClock, openXixiStore, type XixiConfig, type XixiStore } from '@xixi/domain';

/**
 * `acceptance_score` is **not** a score (F1, 2026-09-30 audit).
 *
 * The field name, the schema's `number | null` (0–1) declaration and the docs all
 * suggested a calibrated acceptance score, but the value written today is just
 * `accepted` mirrored to 1/0 — `TurnAcceptance` has no score at all. Anyone who
 * believed the name would write a threshold such as `score < 0.5` and get a
 * boolean check spelled the long way; worse, that code would silently change
 * behaviour the day M2 puts a real 0–1 score in the same field.
 *
 * These assertions make "calling it a score" impossible to slip back in: the
 * payload can only ever be 0 or 1, it is exactly `accepted ? 1 : 0`, and the
 * schema keeps the sentence that says so.
 */

const T0 = new Date('2026-09-30T10:00:00+08:00');
const SCHEMA_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'contracts',
  'schemas',
  'events',
  'conversation.decision.v1.json',
);

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: {
    llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false },
    asr: { provider: 'fake', model: 'fake-asr' },
    tts: { provider: 'fake', model: 'fake-tts' },
  },
  personality: { base: { silence_tolerance: 0.7 } },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

function storeWithTurns(): XixiStore {
  return openXixiStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-acceptance-score-')), 'x.sqlite'),
    clock: fixedClock(new Date(T0), 1_000),
  });
}

interface DecisionPayload {
  readonly accepted: boolean;
  readonly reason: string;
  readonly acceptance_score: unknown;
}

function decisions(store: XixiStore): DecisionPayload[] {
  return store.readEvents({ type: 'conversation.decision' }).map((event) => event.payload as unknown as DecisionPayload);
}

test('acceptance_score is only ever the 0/1 mirror of accepted — never a graded value', async () => {
  const store = storeWithTurns();
  try {
    store.seedSelfProfile(CONFIG.personality.base);
    const reply = (): ScriptedOutcome => ({ action: 'SPEAK', text: '收到。' });
    let now = new Date(T0);
    const engine = new ConversationEngine({
      adapter: new FakeBrainAdapter({ reply }),
      store,
      config: CONFIG,
      clock: () => new Date(now),
      offsetMinutes: 480,
      fsm: { lingerMs: 30_000 },
    });
    const session = store.createSession();

    // Accepted: a wake-up while IDLE.
    await engine.respond({ sessionId: session.sessionId, text: '西西，在吗', addressed: true });

    // Rejected: after the follow-up window closed the FSM is back to IDLE, so an
    // unaddressed line (the TV) is refused. Without the pause the FSM would still
    // be LINGERING, where a continuation is accepted regardless of `addressed`.
    now = new Date(now.getTime() + 10 * 60_000);
    await engine.respond({ sessionId: session.sessionId, text: '电视里在说话', addressed: false });

    const recorded = decisions(store);
    assert.equal(recorded.length, 2, 'both decisions must be recorded');

    const accepted = recorded.filter((decision) => decision.accepted);
    const rejected = recorded.filter((decision) => !decision.accepted);
    assert.equal(accepted.length, 1, `expected one accepted decision, saw ${JSON.stringify(recorded)}`);
    assert.equal(rejected.length, 1);

    for (const decision of recorded) {
      // The whole point: the value is a two-valued mirror, not a graded score.
      assert.ok(
        decision.acceptance_score === 0 || decision.acceptance_score === 1,
        `acceptance_score must be exactly 0 or 1, received ${JSON.stringify(decision.acceptance_score)}`,
      );
      assert.equal(
        decision.acceptance_score,
        decision.accepted ? 1 : 0,
        'acceptance_score must equal accepted ? 1 : 0 (it is a mirror, not an independent measurement)',
      );
    }
    assert.equal(accepted[0]?.acceptance_score, 1);
    assert.equal(rejected[0]?.acceptance_score, 0);
    assert.equal(rejected[0]?.reason, 'REJECTED_NOT_ADDRESSED');
  } finally {
    store.close();
  }
});

test('the schema keeps the sentence that stops acceptance_score being read as a score', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
    properties: Record<string, { type?: unknown; minimum?: number; maximum?: number; description?: string }>;
  };
  const field = schema.properties.acceptance_score;
  assert.ok(field !== undefined, 'the decision schema must declare acceptance_score');

  // The declared shape is deliberately wide (it is where M2's real score will go),
  // so the only thing keeping the name honest is this description. Pin it.
  assert.deepEqual(field.type, ['number', 'null']);
  assert.equal(field.minimum, 0);
  assert.equal(field.maximum, 1);

  const description = field.description ?? '';
  assert.match(description, /二值镜像/, 'the description must say the value is a 0/1 mirror');
  assert.match(description, /1\/0/, 'the description must spell out the 1/0 mirroring');
  assert.match(description, /不得当作连续分值消费/, 'the description must forbid consuming it as a graded score');
  assert.match(description, /M2/, 'the description must name the milestone that will introduce a real score');
});
