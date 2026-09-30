import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBrainAdapter, type ScriptedOutcome, type UserTurnInput } from '@xixi/brain-adapter';
import { ConversationEngine, type ReplySegmentPlayback } from '@xixi/conversation';
import { fixedClock, openXixiStore, type Clock, type XixiConfig, type XixiStore } from '@xixi/domain';

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

test('a long pause is noticed without calling tick(): the first line after it is a wake-up, not a rejection', async () => {
  const store = freshStore();
  try {
    // A clock this test owns: `now` moves only when the test moves it. Nothing
    // below calls `engine.tick()` — that is the production path (t19 / t6 F1):
    // `scripts/chat.ts`, `scripts/serve-chat.ts` and `scripts/field-test.ts` read
    // `engine.state` to decide whether the next utterance is a wake-up, and none
    // of them ever ticked, so the getter used to answer with the last transition.
    let now = new Date(T0);
    const clock: Clock = () => new Date(now);
    const engine = new ConversationEngine({
      adapter: new FakeBrainAdapter({ reply: (input) => ({ action: 'SPEAK', text: `收到：${input.text}` }) }),
      store,
      config: CONFIG,
      clock,
      offsetMinutes: 480,
      fsm: { lingerMs: 30_000 },
    });
    const session = store.createSession();

    await engine.respond({ sessionId: session.sessionId, text: '第一句', addressed: engine.state === 'IDLE' });
    assert.equal(engine.state, 'LINGERING');
    assert.equal(engine.lingerMs, 36_000, '0.7 → 30s × 1.2');

    // Ten minutes of silence, far past the 36 s follow-up window.
    now = new Date(now.getTime() + 10 * 60_000);

    assert.equal(engine.state, 'IDLE', 'the state a caller reads must describe now, not the last transition');
    assert.equal(engine.snapshot().state, 'IDLE', 'snapshot() must agree with state about the same instant');

    // Exactly what the CLIs do: IDLE means this line is the wake-up.
    const firstLineAfterThePause = await engine.respond({
      sessionId: session.sessionId,
      text: '长停顿之后的第一句',
      addressed: engine.state === 'IDLE',
    });
    assert.equal(firstLineAfterThePause.accepted, true, 'the FIRST line after the pause must be accepted');
    assert.equal(firstLineAfterThePause.reason, 'ACCEPTED_WAKE_OR_DIRECT');
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
    // `tick()` stays available as an explicit seam (the loop and replay use it);
    // reads no longer depend on it, see the test above.
    engine.tick(new Date(Date.now() + 10 * 60 * 1000));
    assert.equal(engine.state, 'IDLE');

    // In IDLE an unaddressed line is still refused — the §13 rule the TV-audio
    // case depends on, and the only way to reach this branch from a caller that
    // does not compute `addressed` from the state.
    const ignored = await engine.respond({ sessionId: session.sessionId, text: '还在吗', addressed: false });
    assert.equal(ignored.accepted, false);
    assert.equal(ignored.reason, 'REJECTED_NOT_ADDRESSED');

    // …and the rejection is auditable, unlike before t5.
    const rejected = store.readEvents({ type: 'conversation.decision' }).at(-1);
    assert.equal((rejected?.payload as { accepted: boolean }).accepted, false);
    assert.equal((rejected?.payload as { reason: string }).reason, 'REJECTED_NOT_ADDRESSED');

    // A caller that computes `addressed` from the state (the CLIs' rule) accepts it.
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


// ------------------------------------------- ADR-0010 multi-segment replies

/** A sentence of exactly 50 characters ending in a full stop. */
function sentence50(filler: string): string {
  return filler.repeat(49) + '。';
}

const THREE_SEGMENTS = sentence50('甲') + sentence50('乙') + sentence50('丙'); // 150 chars
const TWO_SEGMENTS = sentence50('甲') + sentence50('乙'); // 80 chars

test('ADR-0010: one turn is spoken as up to three segments and still advances the state machine once', async () => {
  const store = freshStore();
  try {
    const chunks: string[] = [];
    const engine = engineWith(() => ({ action: 'SPEAK', text: THREE_SEGMENTS }), store);
    const session = store.createSession();
    const turn = await engine.respond(
      { sessionId: session.sessionId, text: '在吗', addressed: true },
      { onTextChunk: (text) => void chunks.push(text) },
    );

    assert.equal(turn.segments.length, 3);
    for (const segment of turn.segments) assert.ok(segment.length <= 60, 'every segment must be within the ceiling');
    assert.equal(turn.segments.join(''), turn.text, 'M4: the segments are exactly the reply text');
    assert.equal(turn.segmentGapMs, 450, 'M3: the default gap');
    // The streaming seam is unchanged when no segment player is supplied.
    assert.equal(chunks.join(''), THREE_SEGMENTS);

    // M6: one user turn + one assistant record, and exactly one decision.
    assert.equal(store.readEvents({ type: 'conversation.turn' }).length, 2);
    assert.equal(store.recentTurns(session.sessionId).at(-1)?.text, THREE_SEGMENTS, 'the full text is recorded once');
    assert.equal(store.readEvents({ type: 'conversation.decision' }).length, 1);
    assert.equal(engine.state, 'LINGERING');
  } finally {
    store.close();
  }
});

test('the reply limits come from config.reply, and only tightening is honoured', async () => {
  const store = freshStore();
  try {
    const adapter = new FakeBrainAdapter({ reply: () => ({ action: 'SPEAK', text: THREE_SEGMENTS }) });
    const build = (reply: Record<string, unknown>): ConversationEngine =>
      new ConversationEngine({
        adapter,
        store,
        config: { ...CONFIG, reply },
        clock: fixedClock(new Date(T0), 1_000),
        offsetMinutes: 480,
      });

    // Tightening: one segment holding the whole reply.
    const single = await build({ max_segments: 1, segment_max_chars: 60, gap_ms: 450 }).respond({
      sessionId: store.createSession().sessionId,
      text: '在吗',
      addressed: true,
    });
    assert.equal(single.segments.length, 1);
    assert.equal(single.segments[0], THREE_SEGMENTS);

    // Raising a ceiling is refused; the engine clamps instead of honouring it.
    const clamped = await build({ max_segments: 9, segment_max_chars: 999, gap_ms: 60_000 }).respond({
      sessionId: store.createSession().sessionId,
      text: '在吗',
      addressed: true,
    });
    assert.equal(clamped.segments.length, 3, 'the hard ceiling is 3 (ADR-0010 §3)');
    assert.equal(clamped.segmentGapMs, 1_200, 'the hard ceiling for the gap is 1200 ms');
    assert.equal(clamped.segments.join(''), THREE_SEGMENTS);
  } finally {
    store.close();
  }
});

test('the segment player is awaited in order, sees ACTIVE, and the follow-up window starts after the last one', async () => {
  const store = freshStore();
  try {
    let now = new Date(T0);
    const engine = new ConversationEngine({
      adapter: new FakeBrainAdapter({ reply: () => ({ action: 'SPEAK', text: TWO_SEGMENTS }) }),
      store,
      config: CONFIG,
      clock: () => new Date(now),
      offsetMinutes: 480,
      fsm: { lingerMs: 30_000 },
    });
    const session = store.createSession();
    const played: ReplySegmentPlayback[] = [];
    const states: string[] = [];
    const chunks: string[] = [];

    const turn = await engine.respond(
      { sessionId: session.sessionId, text: '在吗', addressed: true, at: new Date(T0) },
      {
        onSegment: (segment) => {
          played.push(segment);
          // M8: during playback the state is still ACTIVE, so the user can cut in.
          states.push(engine.state);
          now = new Date(now.getTime() + 1_000); // one second of playback per segment
        },
        // M6/M8 rely on the two seams being mutually exclusive.
        onTextChunk: (text) => void chunks.push(text),
      },
    );

    assert.deepEqual(played.map((segment) => segment.text), turn.segments);
    assert.deepEqual(played.map((segment) => segment.index), [0, 1]);
    assert.deepEqual(played.map((segment) => segment.total), [2, 2]);
    assert.deepEqual(played.map((segment) => segment.gapMsAfter), [450, null]);
    assert.deepEqual(states, ['ACTIVE', 'ACTIVE']);
    assert.deepEqual(chunks, [], 'segmented playback must not also stream raw deltas');
    // M7: the follow-up window starts when the last segment finished playing —
    // two readbacks of a clock the test moved by one second per segment.
    assert.equal(engine.snapshot().since, T0.getTime() + 2_000);
    assert.equal(engine.state, 'LINGERING');
  } finally {
    store.close();
  }
});

test('a SILENCE turn has no segments and never reaches the player', async () => {
  const store = freshStore();
  try {
    const engine = engineWith(() => ({ action: 'SPEAK', text: '[静默]' }), store);
    const session = store.createSession();
    const played: ReplySegmentPlayback[] = [];
    const turn = await engine.respond(
      { sessionId: session.sessionId, text: '嗯。', addressed: true },
      { onSegment: (segment) => void played.push(segment) },
    );
    assert.equal(turn.action, 'SILENCE');
    assert.equal(turn.text, null);
    assert.deepEqual(turn.segments, []);
    assert.equal(turn.segmentGapMs, 450);
    assert.deepEqual(played, [], 'the control token must never be played as a segment');
  } finally {
    store.close();
  }
});

test('a failed segment ends the turn, keeps one log record, and does not hide the failure (M9)', async () => {
  const store = freshStore();
  try {
    const engine = engineWith(() => ({ action: 'SPEAK', text: THREE_SEGMENTS }), store);
    const session = store.createSession();
    const played: number[] = [];
    await assert.rejects(
      engine.respond(
        { sessionId: session.sessionId, text: '在吗', addressed: true },
        {
          onSegment: (segment) => {
            played.push(segment.index);
            if (segment.index === 1) throw new Error('tts down');
          },
        },
      ),
      /tts down/,
      'the caller must learn that playback failed',
    );

    assert.deepEqual(played, [0, 1], 'the remaining segments are not played');
    const turns = store.recentTurns(session.sessionId);
    assert.equal(turns.filter((turn) => turn.role === 'assistant').length, 1, 'the log stays conversation-level');
    assert.equal(turns.at(-1)?.text, THREE_SEGMENTS, 'the full text is what was recorded');
    assert.equal(store.readEvents({ type: 'conversation.decision' }).length, 1);
    assert.equal(engine.state, 'LINGERING', 'a broken TTS call must not leave the conversation stuck in ACTIVE');
  } finally {
    store.close();
  }
});
