/**
 * Baseline ③ of `tests/replay`: **an unfinished thread across days** (V0.3 P0-D, and the
 * 「至少一组跨天行为回放」 of pack `08_PHASES_AND_ACCEPTANCE.md` §9.19).
 *
 * The script:
 *
 *   day 1 08:00   「明天下午我要去镇上办证。」 — one turn, and the topic engine has to notice that
 *                 this is a thing that is not done yet, due *tomorrow afternoon*;
 *   day 2 10:00   tick — too early: nothing to follow up;
 *   day 2 13:59   tick — one minute before the due time: still nothing;
 *   day 2 14:01   tick — now it asks, and the log says which thread it asked about;
 *   day 2 14:02   tick — asked once, waiting for an answer: no second ask;
 *   day 2 14:10   「办好了，昨天就办完了。」 — the answer closes the thread;
 *   day 3 14:00   tick — nothing left to ask.
 *
 * What makes this a regression floor rather than a transcript is that every judgement is
 * behavioural: the acceptance of each turn, the *decision rows* (initiative kind, trigger, reason
 * code, `topic_ref`), the thread's state machine, and the fact that all of it shifts with the
 * anchor. The last test runs the same script a year later and demands the same behaviour — that is
 * what "injected clock" buys, and the only way this baseline can be trusted in 2027.
 *
 * Run: `npm run test:replay` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runReplay, type ReplayReport } from '@xixi/runtime';

import { anchorAt, echoAdapter, fixturePath, onlyTrigger, scriptWindow } from './replay-fixtures.ts';

const DAY1 = new Date(2026, 9, 2, 8, 0, 0);
const HOUR = 3_600_000;

async function run(anchor: Date): Promise<ReplayReport> {
  return runReplay({
    replay: fixturePath('open-thread-cross-day.json'),
    start: anchorAt(anchor),
    adapter: echoAdapter(),
    settings: onlyTrigger('future_hook_due'),
  });
}

/** Behaviour-only view of a run: no ids (they are UUID-derived) and no absolute instants. */
function digest(report: ReplayReport): unknown {
  return {
    steps: report.steps.map((step) => [step.kind, step.offset]),
    turns: report.turns.map((turn) => [turn.accepted, turn.reason, turn.action, turn.state, turn.text]),
    ticks: report.ticks.map((tick) => [
      tick.offset,
      tick.entry?.initiativeKind ?? null,
      tick.entry?.trigger ?? null,
      tick.entry?.reasonCode ?? null,
      tick.entry?.speak ?? null,
      tick.entry?.text ?? null,
      tick.decisions.map((decision) => [
        decision.initiativeKind,
        decision.trigger,
        decision.topicRef !== null,
        decision.speak,
        decision.reasonCode,
      ]),
    ]),
    threads: report.store.openThreads({ limit: 10 }).map((thread) => [
      thread.summary,
      thread.subject,
      thread.status,
      thread.attempts,
      thread.followUpHint,
      thread.note,
      // The due time and the window are derived from the script clock: keep them *relative*.
      Date.parse(thread.followAfter ?? '') - Date.parse(thread.createdAt),
      Date.parse(thread.expireAt ?? '') - Date.parse(thread.followAfter ?? ''),
    ]),
  };
}

test('baseline 3: an unfinished thread said on day 1 is asked about on day 2, then closed for good', async () => {
  const report = await run(DAY1);
  try {
    // ---------------------------------------------------------------- the thread itself
    const threads = report.store.openThreads({ limit: 10 });
    assert.equal(threads.length, 1, 'one thing was said that is not done yet');
    const thread = threads[0];
    assert.ok(thread !== undefined);
    assert.equal(thread.summary, '明天下午我要去镇上办证');
    assert.equal(thread.subject, '去镇上办证');
    // 「明天下午」 = 14:00 the next day, computed from the *script's* day-1 turn.
    assert.equal(Date.parse(thread.followAfter ?? '') - Date.parse(thread.createdAt), 30 * HOUR);
    assert.equal(
      Date.parse(thread.expireAt ?? '') - Date.parse(thread.followAfter ?? ''),
      48 * HOUR,
      'the follow-up window is the configured 48 hours',
    );

    // ---------------------------------------------------------------- the day-2 timeline
    assert.deepEqual(
      report.ticks.map((tick) => tick.offset),
      ['+26h', '+29h59m', '+30h1m', '+30h2m', '+54h'],
    );
    const [early, justBefore, due, afterOffer, nextDay] = report.ticks;
    for (const [index, tick] of [early, justBefore].entries()) {
      assert.equal(
        (tick?.decisions ?? []).some((decision) => decision.initiativeKind === 'open_loop_followup'),
        false,
        `tick ${index + 1} (${tick?.offset}) is before the due time: asking then would be 「提前一天问明天的事」`,
      );
    }

    // The due tick: it asks, and it says *which* thread it is asking about.
    assert.equal(due?.entry?.initiativeKind, 'open_loop_followup');
    assert.equal(due?.entry?.trigger, 'future_hook_due');
    assert.equal(due?.entry?.reasonCode, 'PASSED');
    assert.equal(due?.entry?.speak, true);
    assert.match(due?.entry?.text ?? '', /办证/, 'the follow-up names the thing, it is not a generic 「最近怎么样」');
    const asks = report.ticks.flatMap((tick) =>
      tick.decisions.filter((decision) => decision.initiativeKind === 'open_loop_followup'),
    );
    assert.equal(asks.length, 1, 'across the whole run, this thing was asked about exactly once');
    assert.equal(asks[0]?.topicRef, thread.threadId, 'the decision carries the thread id: it can be traced back to the log');
    assert.equal(asks[0]?.delivered, true);
    assert.equal(asks[0]?.speak, true);

    // Right after asking: the thread is `offered` and the next tick has nothing to add.
    assert.equal(afterOffer?.entry?.initiativeKind === 'open_loop_followup', false, 'asked once, now it waits for an answer');
    assert.equal(
      (afterOffer?.decisions ?? []).some((decision) => decision.initiativeKind === 'open_loop_followup'),
      false,
    );

    // ---------------------------------------------------------------- the answer closes it
    const answer = report.turns[1];
    assert.equal(answer?.accepted, true, 'his answer is an ordinary accepted turn');
    assert.equal(thread.status, 'resolved', 'and the thread is closed, not merely 「waiting」');
    assert.equal(report.store.openThread(thread.threadId)?.status, 'resolved');
    assert.equal(report.store.openThread(thread.threadId)?.attempts, 1);
    assert.equal(report.store.openThread(thread.threadId)?.note, '用户回答：办好了，昨天就办完了。');

    // The day after: nothing to ask, and no decision even mentions the thread again.
    assert.equal(nextDay?.offset, '+54h');
    assert.equal(nextDay?.entry?.initiativeKind === 'open_loop_followup', false);
    assert.equal(
      (nextDay?.decisions ?? []).some((decision) => decision.topicRef === thread.threadId),
      false,
      'a closed thread must never come back as a proactive candidate',
    );

    // The state machine is in the log, in order — 铁律 10: durable, replayable changes.
    const changes = report.store.readEvents({ type: 'open_thread.changed', limit: 100 });
    assert.deepEqual(
      changes.map((event) => (event.payload as { status: string }).status),
      ['candidate', 'offered', 'resolved'],
    );

    // The follow-up was spoken *and* written into the conversation history, so the next turn
    // sees it (a proactive message that vanishes from the dialogue would be a silent regression).
    const assistantTurns = report.store
      .readEvents({ type: 'conversation.turn', limit: 100 })
      .filter((event) => (event.payload as Record<string, unknown>)['role'] === 'assistant');
    assert.equal(assistantTurns.length, 3, 'the day-1 reply, the day-2 follow-up, and the reply to his answer');
    const proactiveTurns = assistantTurns.filter((event) => event.source === 'proactive');
    assert.equal(proactiveTurns.length, 1, 'exactly one message was 西西 speaking on her own initiative');
    assert.match(
      (proactiveTurns[0]?.payload as { text?: string }).text ?? '',
      /办证/,
      'the follow-up is in the history with its subject',
    );
  } finally {
    report.close();
  }
});

test('baseline 3: the same script one year later behaves the same way (injected clock)', async () => {
  const base = await run(DAY1);
  const later = await run(new Date(2027, 9, 1, 8, 0, 0));
  try {
    assert.deepEqual(digest(later), digest(base), 'behaviour must not depend on the epoch the script is anchored in');

    // The whole timeline shifted by one offset, and by the same amount everywhere.
    const shift = Date.parse(later.start) - Date.parse(base.start);
    assert.equal(Date.parse(later.end) - Date.parse(base.end), shift, 'every step moved with the anchor');
    assert.ok(shift > 363 * 86_400_000, `the two anchors are about a year apart: ${shift} ms`);

    // …and nothing in either run carries wall-clock time: every event sits inside its own script,
    // whose window is read from the fixture's offsets rather than from the report.
    for (const [report, anchor] of [
      [base, anchorAt(DAY1)],
      [later, anchorAt(new Date(2027, 9, 1, 8, 0, 0))],
    ] as const) {
      const window = scriptWindow('open-thread-cross-day.json', anchor);
      assert.equal(Date.parse(report.start), window.from);
      assert.equal(Date.parse(report.end), window.to);
      for (const event of report.store.readEvents({ limit: Number.MAX_SAFE_INTEGER })) {
        const at = Date.parse(event.timestamp);
        assert.ok(
          at >= window.from && at <= window.to,
          `${event.event_type} at ${event.timestamp} escaped the script window`,
        );
      }
    }
  } finally {
    base.close();
    later.close();
  }
});
