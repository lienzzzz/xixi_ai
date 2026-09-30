import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBrainAdapter, type ScriptedOutcome, type UserTurnInput } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { fixedClock, openXixiStore, type XixiConfig, type XixiStore } from '@xixi/domain';

const T0 = new Date('2026-09-29T20:00:00+08:00');

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai' },
  models: {
    llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false },
    asr: { provider: 'fake', asr: 'fake' } as never,
    tts: { provider: 'fake' } as never,
  } as never,
  personality: { base: { verbosity: 0.4, warmth: 0.8, silence_tolerance: 0.7 } },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

function engineWith(
  reply: (input: UserTurnInput) => ScriptedOutcome,
  store: XixiStore,
  offsetMinutes = 480,
): ConversationEngine {
  return new ConversationEngine({
    adapter: new FakeBrainAdapter({ reply }),
    store,
    config: CONFIG,
    clock: fixedClock(new Date(T0), 1_000),
    offsetMinutes,
    // No `silenceTolerance` here: the window must come from the persisted
    // personality, which is the wiring these tests exist to protect.
    fsm: { lingerMs: 30_000 },
  });
}

function freshStore(): XixiStore {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-engine-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: fixedClock(new Date(T0), 1_000) });
  store.seedSelfProfile(CONFIG.personality.base);
  return store;
}

test('a turn is refused when nobody addressed Xixi, and the refusal itself is auditable', async () => {
  const store = freshStore();
  try {
    const engine = engineWith((input) => ({ action: 'SPEAK', text: `收到：${input.text}` }), store);
    const session = store.createSession();
    const turn = await engine.respond({ sessionId: session.sessionId, text: '明天天气怎么样？', addressed: false });
    assert.equal(turn.accepted, false);
    assert.equal(turn.reason, 'REJECTED_NOT_ADDRESSED');
    assert.equal(turn.action, 'SILENCE');
    // The refusal must not become conversation history…
    assert.equal(store.recentTurns(session.sessionId).length, 0, 'unaddressed audio (e.g. the TV) must not become history');
    assert.equal(store.readEvents({ type: 'conversation.turn' }).length, 0);
    // …but the log must be able to answer "why wasn't this accepted?" (铁律 5).
    const decisions = store.readEvents({ type: 'conversation.decision' });
    assert.equal(decisions.length, 1);
    const payload = decisions[0]?.payload as Record<string, unknown>;
    assert.equal(payload.accepted, false);
    assert.equal(payload.reason, 'REJECTED_NOT_ADDRESSED');
    assert.equal(payload.action, 'SILENCE');
    assert.equal(payload.turn_index, 0);
    assert.equal(payload.accepted === false, true);
    // 铁律 5: no user words, no model reasoning — only the reason code and scores.
    assert.equal(JSON.stringify(payload).includes('明天'), false, 'the decision event must not carry the utterance');
    assert.equal('text' in payload, false);
  } finally {
    store.close();
  }
});

test('an accepted turn records both sides and opens the follow-up window', async () => {
  const store = freshStore();
  try {
    const engine = engineWith((input) => ({ action: 'SPEAK', text: `收到：${input.text}` }), store);
    const session = store.createSession();
    const turn = await engine.respond({ sessionId: session.sessionId, text: '西西，明天天气怎么样？', addressed: true });
    assert.equal(turn.accepted, true);
    assert.equal(turn.action, 'SPEAK');
    assert.equal(turn.text, '收到：西西，明天天气怎么样？');
    assert.equal(engine.state, 'LINGERING');
    assert.equal(store.recentTurns(session.sessionId).length, 2);
    assert.ok(turn.prompt !== null, 'the prompt is part of the turn evidence');
  } finally {
    store.close();
  }
});

test('the second turn continues without a wake word and sees the first turn as history', async () => {
  const store = freshStore();
  try {
    const seen: string[] = [];
    const engine = engineWith((input) => {
      seen.push(input.prompt?.user ?? '');
      return { action: 'SPEAK', text: `回复${seen.length}` };
    }, store);
    const session = store.createSession();
    await engine.respond({ sessionId: session.sessionId, text: '明天天气怎么样？', addressed: true });
    const second = await engine.respond({ sessionId: session.sessionId, text: '那后天呢？', addressed: false });
    assert.equal(second.accepted, true, 'once a session is open, continuation needs no wake word');
    assert.equal(second.reason, 'ACCEPTED_CONTINUATION');
    assert.ok(seen[1].includes('明天天气怎么样？'), 'the earlier user turn must be in working memory');
    assert.ok(seen[1].includes('回复1'), 'the earlier assistant reply must be in working memory');
  } finally {
    store.close();
  }
});

test('silence is recorded as a first-class outcome and never spoken (§55)', async () => {
  const store = freshStore();
  try {
    const chunks: string[] = [];
    const engine = engineWith(() => ({ action: 'SILENCE', text: null }), store);
    const session = store.createSession();
    const turn = await engine.respond(
      { sessionId: session.sessionId, text: '唉，今天真累。', addressed: true },
      { onTextChunk: (text) => void chunks.push(text) },
    );
    assert.equal(turn.action, 'SILENCE');
    assert.equal(turn.text, null);
    const turns = store.recentTurns(session.sessionId);
    assert.equal(turns.at(-1)?.action, 'SILENCE');
    assert.equal(turns.at(-1)?.text, null);
  } finally {
    store.close();
  }
});

test('a streamed reply reaches the TTS hook chunk by chunk, and the silence token does not', async () => {
  const store = freshStore();
  try {
    const chunks: string[] = [];
    const engine = engineWith((input) => ({ action: 'SPEAK', text: input.text.repeat(4) }), store);
    const session = store.createSession();
    await engine.respond(
      { sessionId: session.sessionId, text: '一二三四五六' },
      { onTextChunk: (text) => void chunks.push(text) },
    );
    assert.ok(chunks.length > 1, 'a longer reply must stream in several chunks');

    const silentChunks: string[] = [];
    const silentEngine = engineWith(() => ({ action: 'SPEAK', text: '[静默]' }), store);
    const secondSession = store.createSession();
    const silentTurn = await silentEngine.respond(
      { sessionId: secondSession.sessionId, text: '嗯。' },
      { onTextChunk: (text) => void silentChunks.push(text) },
    );
    assert.equal(silentTurn.action, 'SILENCE');
    assert.deepEqual(silentChunks, [], 'the control token must never be sent to TTS');
  } finally {
    store.close();
  }
});

test('a silence token split across streamed deltas is still suppressed', async () => {
  const store = freshStore();
  try {
    // Hand-rolled adapter: real adapters stream deltas, and "[" + "静默" + "]"
    // is exactly how the token arrived from MiMo in live use.
    const adapter = {
      provider: 'piecewise',
      describe: () => ({ provider: 'piecewise', model: 'piecewise-1', transport: 'test', mode: 'scripted' as const }),
      handleUserTurn: async () => {
        const pieces = ['[', '静', '默', ']'];
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const piece of pieces) yield { type: 'text' as const, text: piece };
          },
          result: Promise.resolve({
            action: 'SPEAK' as const,
            text: pieces.join(''),
            toolName: null,
            provider: 'piecewise',
            model: 'piecewise-1',
            brainSessionId: null,
            latencyMs: 1,
          }),
        };
      },
      evaluateProactiveCandidate: async () => {
        throw new Error('not used');
      },
      interpretFeedback: async () => {
        throw new Error('not used');
      },
      extractMemories: async () => {
        throw new Error('not used');
      },
      reflect: async () => {
        throw new Error('not used');
      },
    };

    const engine = new ConversationEngine({ adapter, store, config: CONFIG, clock: fixedClock(new Date(T0), 1_000), offsetMinutes: 480 });
    const session = store.createSession();
    const chunks: string[] = [];
    const turn = await engine.respond(
      { sessionId: session.sessionId, text: '嗯。' },
      { onTextChunk: (text) => void chunks.push(text) },
    );
    assert.equal(turn.action, 'SILENCE', 'a token split by the stream must still become SILENCE');
    assert.deepEqual(chunks, [], 'no fragment of the token may reach TTS');
    assert.equal(store.recentTurns(session.sessionId).at(-1)?.text, null);
  } finally {
    store.close();
  }
});

test('quiet mode stops accepting turns and can be lifted', async () => {
  const store = freshStore();
  try {
    const engine = engineWith((input) => ({ action: 'SPEAK', text: `收到：${input.text}` }), store);
    const session = store.createSession();
    engine.quiet(new Date(Date.now() + 60 * 60 * 1000));
    const blocked = await engine.respond({ sessionId: session.sessionId, text: '在吗', addressed: true });
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.reason, 'REJECTED_SUSPENDED');
    engine.resume();
    const allowed = await engine.respond({ sessionId: session.sessionId, text: '在吗', addressed: true });
    assert.equal(allowed.accepted, true);
  } finally {
    store.close();
  }
});

test('a long pause closes the session, and the next addressed line is accepted again', async () => {
  const store = freshStore();
  try {
    const engine = engineWith((input) => ({ action: 'SPEAK', text: `收到：${input.text}` }), store);
    const session = store.createSession();
    await engine.respond({ sessionId: session.sessionId, text: '第一句', addressed: true });
    assert.equal(engine.state, 'LINGERING');
    // 0.7 → window = 30s × 1.2 = 36s
    assert.equal(engine.lingerMs, 36_000);
    engine.tick(new Date(Date.now() + 10 * 60 * 1000));
    assert.equal(engine.state, 'IDLE');

    // In IDLE an unaddressed line is still refused…
    const ignored = await engine.respond({ sessionId: session.sessionId, text: '还在吗', addressed: false });
    assert.equal(ignored.accepted, false);
    assert.equal(ignored.reason, 'REJECTED_NOT_ADDRESSED');

    // …and this is exactly the fix for `scripts/chat.ts`: the callers rule is
    // "IDLE means the click/line is a wake-up", so the next line is accepted
    // instead of being rejected forever after the first follow-up timeout.
    const resumed = await engine.respond({ sessionId: session.sessionId, text: '还在吗', addressed: true });
    assert.equal(resumed.accepted, true);
    assert.equal(resumed.reason, 'ACCEPTED_WAKE_OR_DIRECT');
  } finally {
    store.close();
  }
});

test('every accepted turn leaves a decision event the log can explain', async () => {
  const store = freshStore();
  try {
    const engine = engineWith((input) => ({ action: 'SPEAK', text: `收到：${input.text}` }), store);
    const session = store.createSession();
    await engine.respond({ sessionId: session.sessionId, text: '第一句', addressed: true });
    await engine.respond({ sessionId: session.sessionId, text: '第二句', addressed: false });
    const decisions = store.readEvents({ type: 'conversation.decision' });
    assert.deepEqual(
      decisions.map((event) => (event.payload as { reason: string }).reason),
      ['ACCEPTED_WAKE_OR_DIRECT', 'ACCEPTED_CONTINUATION'],
    );
    assert.deepEqual(
      decisions.map((event) => (event.payload as { turn_index: number }).turn_index),
      [0, 1],
      'decision indexes must advance even though only turns change the projection',
    );
    assert.deepEqual(
      decisions.map((event) => (event.payload as { action: string }).action),
      ['SPEAK', 'SPEAK'],
    );
  } finally {
    store.close();
  }
});
