/**
 * Baseline ① of `tests/replay`: **a plain conversation turn** (V0.3 P0-D).
 *
 * The fixture is four user turns on one morning; what the test judges is behaviour the whole
 * product depends on and that nothing else in the suite pins down end to end:
 *
 *   * an addressed turn is accepted, answered by the *injected* brain and recorded;
 *   * a turn ten seconds later needs no wake word (the follow-up window is open) — and the window
 *     is the script's own 30 seconds, not the machine's;
 *   * a turn ten minutes later, with the TV talking, is **refused**, writes no history, and still
 *     leaves an auditable decision (铁律 5) without carrying what was said;
 *   * the fourth turn sees the earlier exchange as working memory and **not** the refused audio.
 *
 * Everything runs through the production entry (`ConversationEngine.respond`), so this is a
 * regression floor for the conversation pipeline, not for the replay driver.
 *
 * Run: `npm run test:replay` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runReplay } from '@xixi/runtime';

import { anchorAt, echoAdapter, fixturePath } from './replay-fixtures.ts';

const TV_LINE = '电视里那个人在说什么？';

test('baseline 1: turn accepted → continuation → refusal → wake word again', async () => {
  const report = await runReplay({
    replay: fixturePath('conversation-baseline.json'),
    start: anchorAt(new Date(2026, 9, 5, 8, 0, 0)),
    adapter: echoAdapter(),
  });
  try {
    assert.equal(report.turns.length, 4);
    assert.deepEqual(
      report.turns.map((turn) => [turn.accepted, turn.reason]),
      [
        [true, 'ACCEPTED_WAKE_OR_DIRECT'],
        [true, 'ACCEPTED_CONTINUATION'],
        [false, 'REJECTED_NOT_ADDRESSED'],
        [true, 'ACCEPTED_WAKE_OR_DIRECT'],
      ],
      'the acceptance table is the conversation pipeline\'s, measured against the script clock',
    );
    assert.deepEqual(
      report.turns.map((turn) => turn.state),
      ['LINGERING', 'LINGERING', 'IDLE', 'LINGERING'],
      'the refusals happen because the 30-second follow-up window really closed',
    );

    // The reply is the injected adapter's, verbatim: no model, no network, no key.
    assert.equal(report.turns[0]?.reply, '收到：西西，明天天气怎么样？');
    assert.deepEqual(report.turns[0]?.segments, ['收到：西西，明天天气怎么样？']);

    // Working memory (behaviour, not a string equality): turn 2 sees the first exchange…
    const second = report.turns[1]?.history.join('\n') ?? '';
    assert.ok(second.includes('西西，明天天气怎么样？'), 'turn 1 must be in the model\'s working memory');
    assert.ok(second.includes('收到：西西，明天天气怎么样？'), 'and so must the reply to it');
    // …turn 4 still remembers the earlier turns, and never saw the refused audio.
    const fourth = report.turns[3]?.history.join('\n') ?? '';
    assert.ok(fourth.includes('那后天呢？'), 'the accepted continuation stays in history');
    assert.equal(fourth.includes(TV_LINE), false, 'unaddressed audio from the TV must not become history');

    // The durable record agrees with the in-memory view.
    const turns = report.store.readEvents({ type: 'conversation.turn', limit: 1_000 });
    assert.equal(turns.length, 6, 'three accepted turns × (user + reply)');
    assert.equal(
      turns.filter((event) => (event.payload as Record<string, unknown>)['role'] === 'user').length,
      3,
      'the refused utterance is not a turn',
    );
    assert.equal(report.store.recentTurns(report.sessionId, 10).length, 6);
  } finally {
    report.close();
  }
});

test('baseline 1: the refusal is auditable without storing what was said', async () => {
  const report = await runReplay({
    replay: fixturePath('conversation-baseline.json'),
    start: anchorAt(new Date(2026, 9, 5, 8, 0, 0)),
    adapter: echoAdapter(),
  });
  try {
    const decisions = report.store.readEvents({ type: 'conversation.decision', limit: 1_000 });
    assert.equal(decisions.length, 4, 'every turn leaves exactly one decision, accepted or not');
    const refusal = decisions[2]?.payload as Record<string, unknown>;
    assert.equal(refusal['accepted'], false);
    assert.equal(refusal['reason'], 'REJECTED_NOT_ADDRESSED');
    assert.equal(refusal['action'], 'SILENCE');
    // 铁律 5: reason codes and scores, never the words the model or the user said.
    assert.equal(JSON.stringify(refusal).includes(TV_LINE), false, 'the refused utterance must not be in the decision');
    assert.equal('text' in refusal, false);
  } finally {
    report.close();
  }
});
