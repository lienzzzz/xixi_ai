import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FakeBrainAdapter,
  createBrainTurnStream,
  splitIntoChunks,
  type BrainAdapter,
  type BrainTurnResult,
  type UserTurnInput,
} from '@xixi/brain-adapter';
import { ConversationEngine, UNBACKED_FACT_REPLY } from '@xixi/conversation';
import { fixedClock, openXixiStore, type XixiConfig, type XixiStore } from '@xixi/domain';

/**
 * t21 — the reply pipeline's observable surface: what the caller can *see* about a turn.
 *
 * Six defects were fixed in one round (t12's two high, t4's two medium, t6's F4). This file pins the
 * four that are visible at the engine seam:
 *   * a reply made only of artifacts is a **distinguishable** silence (`ARTIFACT_ONLY_REPLY`), not the
 *     same thing as the model choosing silence (t12 F2);
 *   * the streaming seam never emits English reasoning and then retracts it (t12 F1);
 *   * markdown decorations never reach a mouth (t4 F3);
 *   * an invented clock time is gated like any other unverifiable claim (t4 F2), and the provider's
 *     stop reason is carried onto the turn so a mid-word cut can be attributed (t4 F5).
 *
 * The segment-cap semantics (t6 F4) live in `tests/unit/core/reply-segments.test.ts`.
 */

const T0 = new Date('2026-10-01T00:32:00+08:00'); // 00:32 local — inside quiet hours is irrelevant here
const OFFSET = 480;

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
  '<tool_call><function=weather><parameter=city>成都</parameter><parameter=date>明天</parameter></function></tool_call>';

/** An adapter that returns exactly the text/finish reason a test needs (and nothing else moves). */
function scriptedAdapter(text: string | null, finishReason: string | null, action: 'SPEAK' | 'SILENCE' = 'SPEAK'): BrainAdapter {
  const base = new FakeBrainAdapter();
  return {
    provider: 'scripted',
    describe: () => ({ provider: 'scripted', model: 'scripted-1', transport: 'in-memory', mode: 'scripted' }),
    handleUserTurn: (input: UserTurnInput) => {
      const result: BrainTurnResult = {
        action,
        text,
        toolName: null,
        provider: 'scripted',
        model: 'scripted-1',
        brainSessionId: `scripted-${input.sessionId}`,
        latencyMs: 0,
        finishReason,
      };
      async function* replay() {
        // `splitIntoChunks` already returns `BrainTurnChunk` objects — yielding them directly is what
        // FakeBrainAdapter does, and wrapping them again would hand the engine an object as text.
        for (const chunk of text === null ? [] : splitIntoChunks(text, 12)) yield chunk;
      }
      return Promise.resolve(createBrainTurnStream(replay(), Promise.resolve(result)));
    },
    evaluateProactiveCandidate: (input) => base.evaluateProactiveCandidate(input),
    interpretFeedback: (input) => base.interpretFeedback(input),
    extractMemories: (input) => base.extractMemories(input),
    reflect: (input) => base.reflect(input),
  };
}

interface Harness {
  readonly store: XixiStore;
  readonly engine: ConversationEngine;
  readonly spoken: string[];
  readonly notices: { readonly code: string; readonly detail: string }[];
  /** The turn's wall clock — the gate reads it, so a test can speak at 15:32 without waiting. */
  readonly now: Date;
}

function harness(adapter: BrainAdapter, now: Date = T0): Harness {
  const root = mkdtempSync(join(tmpdir(), 'xixi-reply-pipeline-'));
  const store = openXixiStore({ dbPath: join(root, 'x.sqlite'), clock: fixedClock(now, 1_000) });
  const spoken: string[] = [];
  const notices: { code: string; detail: string }[] = [];
  const engine = new ConversationEngine({
    adapter,
    store,
    config: CONFIG,
    clock: () => new Date(now),
    offsetMinutes: OFFSET,
  });
  return { store, engine, spoken, notices, now };
}

async function speakOnce(h: Harness): Promise<Awaited<ReturnType<ConversationEngine['respond']>>> {
  const session = h.store.createSession();
  return h.engine.respond(
    { sessionId: session.sessionId, text: '明天天气怎么样？', addressed: true, at: new Date(h.now) },
    {
      onTextChunk: (chunk) => void h.spoken.push(chunk),
      onNotice: (notice) => void h.notices.push({ code: notice.code, detail: notice.detail }),
    },
  );
}

function close(store: XixiStore): void {
  const dir = store.dbPath.slice(0, store.dbPath.lastIndexOf('\\'));
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

test('an artifact-only reply is a silence you can explain (t12 F2 / t21)', async () => {
  const h = harness(scriptedAdapter(WEATHER_MARKUP, 'stop'));
  try {
    const turn = await speakOnce(h);
    assert.equal(turn.action, 'SILENCE');
    assert.equal(turn.text, null);
    assert.equal(turn.silenceReason, 'ARTIFACT_ONLY_REPLY', 'not the same thing as the model choosing quiet');
    assert.equal(turn.hygiene?.emptied, true);
    assert.ok((turn.hygiene?.removedMarkupChars ?? 0) > 0, 'and the summary says what was removed');
    assert.deepEqual(h.spoken, [], 'nothing reached the delta seam');
    assert.equal(h.notices.some((notice) => notice.code === 'REPLY_HYGIENE'), true);
  } finally {
    close(h.store);
  }
});

test('the model choosing silence stays distinguishable from that (t21)', async () => {
  const h = harness(scriptedAdapter('', 'stop', 'SILENCE'));
  try {
    const turn = await speakOnce(h);
    assert.equal(turn.action, 'SILENCE');
    assert.equal(turn.silenceReason, 'MODEL_SILENCE');
    assert.equal(turn.hygiene, null, 'nothing was removed — there was nothing to remove');
    assert.equal(h.notices.some((notice) => notice.code === 'REPLY_HYGIENE'), false);
  } finally {
    close(h.store);
  }
});

test('a normal turn reports no silence reason, no hygiene and a stop reason (t21)', async () => {
  const h = harness(scriptedAdapter('明天多云，风不大，出门带把伞。', 'stop'));
  try {
    const turn = await speakOnce(h);
    assert.equal(turn.action, 'SPEAK');
    assert.equal(turn.text, '明天多云，风不大，出门带把伞。');
    assert.equal(turn.silenceReason, null);
    assert.equal(turn.hygiene, null);
    assert.equal(turn.finishReason, 'stop');
    assert.equal(h.spoken.join(''), turn.text, 'the delta seam carried the whole reply once');
  } finally {
    close(h.store);
  }
});

test('a reply cut by the token budget is attributed, not mistaken for a finished sentence (t4 F5 / t21)', async () => {
  const h = harness(scriptedAdapter('……剪的时候留神别划着手，夜', 'length'));
  try {
    const turn = await speakOnce(h);
    assert.equal(turn.finishReason, 'length');
    const notice = h.notices.find((item) => item.code === 'REPLY_TRUNCATED');
    assert.ok(notice !== undefined, `expected a REPLY_TRUNCATED notice, got ${JSON.stringify(h.notices)}`);
    assert.match(notice.detail, /finish_reason=length/);
    assert.match(notice.detail, /token 上限/);
  } finally {
    close(h.store);
  }
});

test('English reasoning never leaves the delta seam, even when the reply starts in Chinese (t12 F1 / t21)', async () => {
  // No checkable numbers on purpose: this test is about the streaming hygiene gate, and a weather
  // figure would (correctly) be held by the t111 unbacked-claim gate instead.
  const mixed = '嗯，我在的。The user asked twice in a row about the weather and I need to answer with the tool result once it arrives.明天多云，出门带把伞。';
  const h = harness(scriptedAdapter(mixed, 'stop'));
  try {
    const turn = await speakOnce(h);
    const streamed = h.spoken.join('');
    assert.equal(streamed.includes('The user'), false, `the delta seam leaked reasoning: ${streamed}`);
    assert.equal(streamed.includes('I need to'), false);
    assert.equal(streamed.includes('嗯，我在的'), true, `the Chinese opening was spoken: ${streamed}`);
    assert.equal(streamed.includes('明天多云'), true, `and so was the answer: ${streamed}`);
    assert.equal(turn.text?.includes('The user'), false, 'the delivered text is clean too');
  } finally {
    close(h.store);
  }
});

test('markdown decorations are gone from the delivered text and the segments (t4 F3 / t21)', async () => {
  const h = harness(scriptedAdapter('- **别硬躺**。\n- **手机放下**。', 'stop'));
  try {
    const turn = await speakOnce(h);
    // Line breaks are the segmenter's business (`normalizeReplyText`): what must be gone is the
    // decoration — no `**`, no `- ` — and the words must stay.
    const flat = (turn.text ?? '').replace(/\s+/g, '');
    assert.equal(flat, '别硬躺。手机放下。');
    assert.equal(turn.text?.includes('*'), false);
    // ADR-0010: the segments are the *normalized* text (line breaks dropped by `normalizeReplyText`).
    assert.equal(turn.segments.join(''), flat, 'the segments carry the same content, without decorations');
    assert.ok((turn.hygiene?.removedMarkdownChars ?? 0) > 0, 'the removal is reported');
    assert.equal(turn.silenceReason, null);
  } finally {
    close(h.store);
  }
});

test('an invented "current time" is gated like any other unverifiable claim (t4 F2 / t21)', async () => {
  const invented = harness(scriptedAdapter('凌晨两点多，人最容易想这些。', 'stop'));
  try {
    const turn = await speakOnce(invented);
    assert.equal(turn.text, UNBACKED_FACT_REPLY, '00:32 vs 两点多 (+88 min) must not be spoken as fact');
    const notice = invented.notices.find((item) => item.code === 'UNBACKED_FACT_CLAIM');
    assert.ok(notice !== undefined);
    assert.match(notice.detail, /凌晨两点多/);
  } finally {
    close(invented.store);
  }

  // A past-tense clock sentence is ordinary talk — the gate must leave it alone.
  const past = harness(scriptedAdapter('我昨天三点半就醒了，翻来覆去睡不着。', 'stop'));
  try {
    const turn = await speakOnce(past);
    assert.equal(turn.text, '我昨天三点半就醒了，翻来覆去睡不着。');
    assert.equal(past.notices.some((item) => item.code === 'UNBACKED_FACT_CLAIM'), false);
  } finally {
    close(past.store);
  }

  // A habit ("平时") is not a claim about now either.
  const habit = harness(scriptedAdapter('我平时三点半起床，习惯了。', 'stop'));
  try {
    const turn = await speakOnce(habit);
    assert.equal(turn.text, '我平时三点半起床，习惯了。');
  } finally {
    close(habit.store);
  }

  // …and a time that is *right* is not a claim to replace. The sentence has no period word and no
  // now-cue, so the gate never arms on it; the now-cue variant below exercises the tolerance itself.
  const correct = harness(scriptedAdapter('都快十二点半了，早点睡吧。', 'stop'));
  try {
    const turn = await speakOnce(correct);
    assert.equal(turn.text, '都快十二点半了，早点睡吧。', 'no period word, no now-cue: not a claim about now');
  } finally {
    close(correct.store);
  }
});

test('the period word and the 12-hour reading decide the claim, so a true clock sentence passes (t4 F2 / t21)', async () => {
  // Re-checking the t21 snapshot by probe found an over-gate: 「下午三点」 was measured as 03:00, so
  // every PM clock sentence spoken *during its own period* (the case `periodMatches` arms on) was
  // replaced by the repair line. 「现在下午三点了」 at 15:32 is true — the repair line must not fire
  // on a true statement (the over-gate class the t114 review warned about).
  const afternoon = harness(scriptedAdapter('现在下午三点了，准备开会。', 'stop'), new Date('2026-10-01T15:32:00+08:00'));
  try {
    const turn = await speakOnce(afternoon);
    assert.equal(turn.text, '现在下午三点了，准备开会。', '15:32 vs 下午三点 (15:00) is inside the tolerance');
    assert.equal(afternoon.notices.some((item) => item.code === 'UNBACKED_FACT_CLAIM'), false);
  } finally {
    close(afternoon.store);
  }

  // The evening shape of the same rule: 20:15 vs 晚上八点半 (20:30) is the truth — spoken.
  const evening = harness(scriptedAdapter('现在已经晚上八点半了，该睡了。', 'stop'), new Date('2026-10-01T20:15:00+08:00'));
  try {
    const turn = await speakOnce(evening);
    assert.equal(turn.text, '现在已经晚上八点半了，该睡了。', '20:15 vs 晚上八点半 (20:30) is inside the tolerance');
    assert.equal(evening.notices.some((item) => item.code === 'UNBACKED_FACT_CLAIM'), false);
  } finally {
    close(evening.store);
  }

  // …and the shape that *contradicts* the clock is still gated: 17:00 claimed at 15:32.
  const wrong = harness(scriptedAdapter('现在下午五点了，准备开会。', 'stop'), new Date('2026-10-01T15:32:00+08:00'));
  try {
    const turn = await speakOnce(wrong);
    assert.equal(turn.text, UNBACKED_FACT_REPLY, '下午五点 (17:00) is 88 minutes away from 15:32 — a fabrication');
    assert.match(wrong.notices.find((item) => item.code === 'UNBACKED_FACT_CLAIM')?.detail ?? '', /下午五点/);
  } finally {
    close(wrong.store);
  }

  // t4's own live example (Run B round 17): 「现在十二点半了」 said at 00:32 is the 12-hour form of
  // 00:30 — inside the tolerance under either reading, so it is spoken, not replaced.
  const midnight = harness(scriptedAdapter('现在十二点半了，快睡吧。', 'stop'));
  try {
    const turn = await speakOnce(midnight);
    assert.equal(turn.text, '现在十二点半了，快睡吧。', 'one reading of 十二点半 is 00:30, 2 minutes from the real clock');
    assert.equal(midnight.notices.some((item) => item.code === 'UNBACKED_FACT_CLAIM'), false);
  } finally {
    close(midnight.store);
  }
});

test('a spoken minute is measured as written at the reply seam too (t10)', async () => {
  // The t2 review of the t21 snapshot: the minute token was the constant 30, so a sentence whose real
  // reading sat further than the tolerance from the clock was measured at `:30` and got through.
  // 「下午三点五十分」 said at 15:00 is 50 minutes away; the old reading (15:30) was 30 — inside the
  // 45-minute tolerance. The delivered line is what must change, not only the helper.
  const at = new Date('2026-10-01T15:00:00+08:00');
  const invented = harness(scriptedAdapter('现在已经下午三点五十分了，准备收拾。', 'stop'), at);
  try {
    const session = invented.store.createSession();
    const turn = await invented.engine.respond(
      { sessionId: session.sessionId, text: '明天天气怎么样？', addressed: true, at },
      {
        onTextChunk: (chunk) => void invented.spoken.push(chunk),
        onNotice: (notice) => void invented.notices.push({ code: notice.code, detail: notice.detail }),
      },
    );
    assert.equal(turn.text, UNBACKED_FACT_REPLY, '下午三点五十分 (15:50) is 50 minutes from 15:00 — a fabrication');
    assert.match(invented.notices.find((item) => item.code === 'UNBACKED_FACT_CLAIM')?.detail ?? '', /下午三点五十分/);
    // The durable record is the repaired line, like every other unbacked claim (t111/t21).
    const assistant = invented.store.recentTurns(session.sessionId, 10).filter((entry) => entry.role === 'assistant');
    assert.equal(assistant[0]?.text, UNBACKED_FACT_REPLY, 'the log keeps the repair, not the invented minute');
    // NOTE: `spoken` is deliberately not asserted. The streaming seam holds a claim it can already see
    // (it checks `held` with no clock — `heldFacts` in engine.ts), so a *clock* claim is streamed and
    // retracted only once the full text is in. That is a pre-existing property of the stream, not of
    // this fix: at HEAD the same sentence was not gated in `turn.text` or the log at all, so this fix
    // strictly narrows what is delivered and logged. Reported to the captain as an observation.
  } finally {
    close(invented.store);
  }

  // …and a true minute reading is spoken, so the sharper reading is not an over-gate.
  const trueOne = harness(scriptedAdapter('现在已经下午三点四十分了，准备收拾。', 'stop'), at);
  try {
    const turn = await speakOnce(trueOne);
    assert.equal(turn.text, '现在已经下午三点四十分了，准备收拾。', '15:40 vs 15:00 is inside the tolerance');
    assert.equal(trueOne.notices.some((item) => item.code === 'UNBACKED_FACT_CLAIM'), false);
  } finally {
    close(trueOne.store);
  }

  // The tolerance is untouched: 45 minutes is not a contradiction, 46 is.
  const edgeIn = harness(scriptedAdapter('现在已经下午三点四十五分了。', 'stop'), at);
  try {
    assert.equal((await speakOnce(edgeIn)).text, '现在已经下午三点四十五分了。', '45 minutes is inside the tolerance');
  } finally {
    close(edgeIn.store);
  }
  const edgeOut = harness(scriptedAdapter('现在已经下午三点四十六分了。', 'stop'), at);
  try {
    assert.equal((await speakOnce(edgeOut)).text, UNBACKED_FACT_REPLY, '46 minutes is outside the tolerance');
  } finally {
    close(edgeOut.store);
  }
});

