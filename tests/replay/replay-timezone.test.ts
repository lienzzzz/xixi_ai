/**
 * Repair round 2, item 6: **the replay's window comes from the fixture, not from this machine.**
 *
 * `replay-runtime` derives its clock's offset from the anchor string itself
 * (`offsetMinutesOf(anchor)`), and the fixtures declare `+08:00`. The old header comment on that
 * module claimed the window was 「按 +08:00 判定」, which reads as a hard-coded assumption — a reader
 * cannot tell whether the run would follow the fixture or the host's `TZ`. This file makes the
 * *observable* consequence explicit, so the claim stops being a comment:
 *
 *   * the anchor's declared offset is read out of the string (`+08:00` → 480, `Z` → 0) and becomes
 *     the run's own offset — on any host, including one whose local zone is UTC or America/New_York;
 *   * every timestamp the run writes carries that offset, while the **instant** is the anchor's
 *     (so the absolute moment is not shifted by the host zone either);
 *   * local day/hour judgements inside the run use that same offset (the loop's clock hooks).
 *
 * Run: `npm run test:replay` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toOffsetIso } from '@xixi/contracts';

import { offsetMinutesOf, runReplay } from '@xixi/runtime';

import { echoAdapter, fixturePath } from './replay-fixtures.ts';

const ANCHOR_PLUS_8 = '2026-10-05T08:00:00+08:00';
const ANCHOR_UTC = '2026-10-05T00:00:00Z';

/** `+08:00` / `Z` → minutes east of UTC, read off a timestamp the store actually wrote. */
function writtenOffsetMinutes(timestamp: string): number {
  return offsetMinutesOf(timestamp);
}

test('replay 的窗口跟着 fixture 的偏移走，不跟本机时区走', async () => {
  // What the host says the anchor's zone is has no vote: the offset is read out of the string.
  assert.equal(offsetMinutesOf(ANCHOR_PLUS_8), 480, '+08:00 → 480 分钟');
  assert.equal(offsetMinutesOf(ANCHOR_UTC), 0, 'Z → 0 分钟（不是 480）');
  const hostOffset = -new Date().getTimezoneOffset();
  assert.notEqual(
    offsetMinutesOf(ANCHOR_PLUS_8),
    offsetMinutesOf(ANCHOR_UTC),
    '两种写法必须被区别对待，否则「跟着 fixture 走」这句话不成立',
  );

  const report = await runReplay({
    replay: fixturePath('conversation-baseline.json'),
    start: ANCHOR_PLUS_8,
    adapter: echoAdapter(),
  });
  try {
    assert.equal(report.offsetMinutes, 480, `报告里的偏移来自 fixture（本机是 ${hostOffset}）`);
    // The report keeps the instant; the string is the store's own normalisation of it (with millis).
    assert.equal(new Date(report.start).getTime(), Date.parse(ANCHOR_PLUS_8), '锚点的时刻没变');
    assert.equal(report.start, toOffsetIso(new Date(ANCHOR_PLUS_8), 480));
    assert.equal(writtenOffsetMinutes(report.start), 480);

    // Every timestamp the run writes carries that offset — the engine's turns, the decisions, the
    // closing entries. A host-zone run would show this machine's offset here.
    const written = report.store.readEvents({ limit: 500 });
    assert.ok(written.length >= 3, `这条脚本至少写了几个事件：${written.length}`);
    const offsets = [...new Set(written.map((event) => writtenOffsetMinutes(event.timestamp)))];
    assert.deepEqual(offsets, [480], `写下的每个时刻都必须是 fixture 的 +08:00（实测 ${offsets.join(', ')}）`);

    // 本地日/小时判定（循环的时钟钩子用它们）也走同一个偏移：这个锚点的本地小时与 UTC 小时不同，
    // 所以「按 fixture 判定」与「按 UTC 判定」在这里必然分叉。
    assert.equal(Number(report.start.slice(11, 13)), 8, '本地小时 = 8（+08:00 口径）');
    assert.equal(new Date(report.start).getUTCHours(), 0, '同一个时刻的 UTC 小时 = 0');
  } finally {
    report.close();
  }
});

test('换个偏移的锚点，重放的窗口跟着换（Z 会真的变成 0）', async () => {
  const report = await runReplay({
    replay: fixturePath('conversation-baseline.json'),
    start: ANCHOR_UTC,
    adapter: echoAdapter(),
  });
  try {
    assert.equal(report.offsetMinutes, 0, 'Z 锚点 → 0：偏移是被读出来的，不是常量');
    assert.equal(writtenOffsetMinutes(report.start), 0);
    // Same instant as the `+08:00` anchor above (both are 2026-10-05T00:00:00Z): only the offset the
    // run writes changes, the moment itself never does.
    assert.equal(Date.parse(report.start), Date.parse(ANCHOR_PLUS_8), 'Z 锚点与 +08:00 锚点是同一个瞬间');
    assert.equal(report.start, toOffsetIso(new Date(ANCHOR_UTC), 0));

    const written = report.store.readEvents({ limit: 500 });
    assert.ok(written.length >= 3);
    const offsets = [...new Set(written.map((event) => writtenOffsetMinutes(event.timestamp)))];
    assert.deepEqual(offsets, [0], `Z 锚点下写下的时刻应当是 UTC（实测 ${offsets.join(', ')}）`);
  } finally {
    report.close();
  }
});
