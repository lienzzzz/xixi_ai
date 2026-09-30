import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBrainAdapter, type ScriptedOutcome, type UserTurnInput } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { fixedClock, openXixiStore, type Clock, type XixiConfig, type XixiStore } from '@xixi/domain';

/**
 * t7 at the seam that decides what is spoken: `ConversationEngine.respond()`.
 *
 * V0.1 heard two things it should never have heard (baseline §4): a weather turn whose reply body
 * was `<tool_call>…</tool_call>`, and a turn whose body was English self-reasoning. The engine is
 * where the program owns that boundary (铁律 1), so these tests use a *plain* adapter that the
 * engine knows nothing about — no adapter-side filtering is involved — and check the four surfaces
 * a leak could reach: the turn text, the streamed chunks, the transcript, and TTS (segments).
 */

const T0 = new Date('2026-09-30T23:30:00+08:00');

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

const WEATHER_MARKUP =
  '<tool_call><function=get_weather><parameter=date>today</parameter><parameter=city>上海</parameter></function></tool_call>';

const REASONING_LEAK = `The user is repeating their earlier message about going to town this afternoon and not being back until evening. But it's currently 23:30 at night - late night. So they're probably already back, or... wait, they said "今天下午去镇上办点事，可能要到晚上才回来" - this was the first message of the conversation. Now they're saying it again at 23:30.

Hmm, this could be a repeated message, or maybe they're just chatting. Since it's already 23:30 (late night), if they went in the afternoon and said they'd be back by evening, they should be home by now. I should respond naturally as a family member would - maybe noting it's already late and asking if they got back okay.都这么晚了，还没到家？到家了就早点歇着。`;

interface Harness {
  readonly store: XixiStore;
  readonly engine: ConversationEngine;
  readonly spoken: string[];
  readonly notices: { readonly code: string; readonly detail: string }[];
}

function harness(text: string | null, options: { readonly language?: string; readonly toolName?: string } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'xixi-engine-hygiene-'));
  const store = openXixiStore({ dbPath: join(root, 'x.sqlite'), clock: fixedClock(T0, 1_000) });
  const spoken: string[] = [];
  const notices: { code: string; detail: string }[] = [];
  const adapter = new FakeBrainAdapter({
    reply: (_input: UserTurnInput): ScriptedOutcome => ({
      action: text === null ? 'SILENCE' : 'SPEAK',
      text,
      toolName: options.toolName ?? null,
    }),
  });
  const config: XixiConfig = {
    ...CONFIG,
    ...(options.language === undefined ? {} : { identity: { ...CONFIG.identity, language: options.language } }),
  };
  const engine = new ConversationEngine({
    adapter,
    store,
    config,
    clock: fixedClock(T0, 1_000) as Clock,
    offsetMinutes: 480,
  });
  return { store, engine, spoken, notices };
}

function trim(store: XixiStore): void {
  const dir = store.dbPath.slice(0, store.dbPath.lastIndexOf('\\'));
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function speak(engine: ConversationEngine, store: XixiStore, h: Harness): Promise<unknown> {
  const session = store.createSession();
  return engine.respond(
    { sessionId: session.sessionId, text: '明天天气怎么样？', addressed: true },
    {
      onTextChunk: (chunk) => void h.spoken.push(chunk),
      onNotice: (notice) => void h.notices.push({ code: notice.code, detail: notice.detail }),
    },
  );
}

test('a weather turn whose body is tool-call markup is silent, not read out (baseline §4.1)', async () => {
  const h = harness(WEATHER_MARKUP);
  try {
    const session = h.store.createSession();
    const turn = await h.engine.respond(
      { sessionId: session.sessionId, text: '明天天气怎么样？', addressed: true },
      {
        onTextChunk: (chunk) => void h.spoken.push(chunk),
        onSegment: (segment) => void h.spoken.push(segment.text),
        onNotice: (notice) => void h.notices.push({ code: notice.code, detail: notice.detail }),
      },
    );

    assert.equal(turn.action, 'SILENCE', 'nothing left to say → the §55 silence outcome');
    assert.equal(turn.text, null);
    assert.deepEqual(turn.segments, [], 'TTS gets nothing to synthesize');
    assert.equal(h.spoken.join(''), '', 'and neither the delta seam nor the segment seam saw the markup');
    assert.equal(h.store.recentTurns(session.sessionId).at(-1)?.text, null, 'nor the transcript');
    // The removal is auditable instead of silent (铁律 5 spirit: the caller can see what happened).
    const notice = h.notices.find((item) => item.code === 'REPLY_HYGIENE');
    assert.ok(notice !== undefined, `expected a REPLY_HYGIENE notice, got ${JSON.stringify(h.notices)}`);
    assert.match(notice.detail, /工具调用标记/);
    assert.match(notice.detail, /按沉默处理/);
  } finally {
    trim(h.store);
  }
});

test('markup in front of a real sentence is removed, and the sentence is still spoken', async () => {
  // The tool really ran, so the sentence it backs is allowed to stand (t111) — the point here is that
  // the markup in front of it never becomes speech.
  const h = harness(`${WEATHER_MARKUP}我给你查了一下，明天是阴天，出门记得带把伞。`, { toolName: 'xixi_get_weather' });
  try {
    const turn = (await speak(h.engine, h.store, h)) as { readonly text: string | null; readonly segments: readonly string[] };
    assert.equal(turn.text, '我给你查了一下，明天是阴天，出门记得带把伞。');
    assert.equal(turn.segments.join(''), turn.text, 'the segments are exactly what is spoken');
    assert.equal(h.spoken.join('').includes('<tool_call'), false, 'no delta carried the marker');
    assert.equal(JSON.stringify(turn.segments).includes('tool_call'), false);
  } finally {
    trim(h.store);
  }
});

test('the English reasoning leak is stripped and the Chinese line behind it survives (baseline §4.2)', async () => {
  const h = harness(REASONING_LEAK);
  try {
    const turn = (await speak(h.engine, h.store, h)) as { readonly text: string | null };
    assert.equal(turn.text, '都这么晚了，还没到家？到家了就早点歇着。');
    assert.equal(h.spoken.join('').includes('The user'), false, 'and it never reached the delta seam');
    assert.equal(h.notices.some((item) => item.code === 'REPLY_HYGIENE' && /英文推理/.test(item.detail)), true);
  } finally {
    trim(h.store);
  }
});

test('a reply that is nothing but English reasoning becomes silence, not a spoken monologue', async () => {
  const h = harness('The user said they are tired. I should respond gently and maybe let them rest instead of asking questions.');
  try {
    const turn = (await speak(h.engine, h.store, h)) as { readonly action: string; readonly text: string | null };
    assert.equal(turn.action, 'SILENCE');
    assert.equal(turn.text, null);
    assert.equal(h.spoken.join(''), '');
  } finally {
    trim(h.store);
  }
});

test('an English deployment only loses markup — its reasoning-looking text is left alone', async () => {
  const h = harness(REASONING_LEAK, { language: 'en-US' });
  try {
    const turn = (await speak(h.engine, h.store, h)) as { readonly text: string | null };
    assert.equal(turn.text?.includes('The user is repeating'), true, 'the language gate is the configured language');
    assert.equal(h.notices.some((item) => item.code === 'REPLY_HYGIENE' && /英文推理/.test(item.detail)), false);
  } finally {
    trim(h.store);
  }
});

test('the proactive seam (screenUnbackedFacts) gets the same hygiene', async () => {
  const h = harness('好。');
  try {
    const screened = h.engine.screenUnbackedFacts(`${WEATHER_MARKUP}我给你查了一下。`, 'xixi_get_weather');
    assert.equal(screened.ok, true);
    assert.equal(screened.text, '我给你查了一下。');
    // …and the reasoning leak cannot become a proactive line either.
    const leaked = h.engine.screenUnbackedFacts(REASONING_LEAK, null);
    assert.equal(leaked.text, '都这么晚了，还没到家？到家了就早点歇着。');
    assert.equal(leaked.ok, true, 'what is left is ordinary talk, not an unbacked claim');
  } finally {
    trim(h.store);
  }
});
