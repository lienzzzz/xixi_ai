/**
 * The replay **format contract** (V0.3 P0-D, pack `04_RUNTIME_CONSOLIDATION.md` §4).
 *
 * These are the rules every baseline in this directory relies on, pinned where they can be read:
 * the pack's relative-offset spelling, both document shapes, and the two failure modes that must
 * never be silent (an unknown step kind, a fixture that rewinds time). The last two tests are about
 * the injected clock: the same script has to mean the same thing in 2020 and today, and *nothing*
 * it writes may carry wall-clock time.
 *
 * Run: `npm run test:replay` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { toOffsetIso } from '@xixi/contracts';

import { loadReplay, parseReplayDocument, parseReplayOffset, runReplay } from '@xixi/runtime';

import { anchorAt, echoAdapter, fixturePath, scriptWindow } from './replay-fixtures.ts';

const HOUR = 3_600_000;

/** A local-time anchor, the convention `replay-fixtures.ts` explains. */
const LOCAL_ANCHOR = anchorAt(new Date(2026, 9, 5, 8, 0, 0));

test('the pack\'s "+0m / +3h / +3h01m" spellings are durations, and junk is refused', () => {
  assert.equal(parseReplayOffset('+0m'), 0);
  assert.equal(parseReplayOffset('+3h'), 3 * HOUR);
  assert.equal(parseReplayOffset('+3h01m'), 3 * HOUR + 60_000);
  assert.equal(parseReplayOffset('+26h35m'), 26 * HOUR + 35 * 60_000);
  assert.equal(parseReplayOffset('+90s'), 90_000);
  assert.equal(parseReplayOffset('+2d'), 48 * HOUR);
  // Compound and single-unit spellings of the same instant have to agree; the second one is what a
  // fixture author will write by accident, and it must not silently mean something else.
  assert.equal(parseReplayOffset('+3h01m'), parseReplayOffset('+181m'));
  assert.equal(parseReplayOffset('3h'), 3 * HOUR, 'a missing "+" is fine; the sign adds nothing');

  for (const bad of ['', '+', '-30m', '+3h 5m', '+3x', '+h', 'tomorrow']) {
    assert.throws(() => parseReplayOffset(bad), /relative offset|not a duration/, `"${bad}" must be refused`);
  }
});

test('the pack\'s own example document runs step for step (kind aliases, perception, world, ticks)', async () => {
  const report = await runReplay({
    replay: fixturePath('pack-example.json'),
    start: LOCAL_ANCHOR,
    adapter: echoAdapter(),
  });
  try {
    assert.equal(report.name, 'memory-return-home-tv');
    assert.deepEqual(
      report.steps.map((step) => step.kind),
      ['conversation.turn', 'presence.changed', 'world', 'proactive_tick', 'world', 'proactive_tick'],
      '`user_turn` / `perception` / `world` / `proactive_tick` are the pack\'s spellings of these five seams',
    );
    assert.deepEqual(
      report.steps.map((step) => Date.parse(step.at) - Date.parse(report.start)),
      [0, 26 * HOUR, 26 * HOUR + 60_000, 26 * HOUR + 2 * 60_000, 26 * HOUR + 35 * 60_000, 26 * HOUR + 36 * 60_000],
      'every step lands exactly at its offset from the anchor',
    );
    // The perception step went through the single writer, so the projection exists…
    const presence = report.store.worldState('presence.home', { now: report.end });
    assert.equal(presence?.present, true, '`value: "present"` became a present projection');
    // …and 26 hours later its 60-second TTL has passed: 「上次看到人」 is not 「现在有人」.
    assert.equal(presence?.stale, true, 'staleness is measured against the script clock, not the row\'s own age at write time');
    assert.equal(report.store.worldState('device.tv', { now: report.end })?.value, 'off', 'the last `world` step wins');
    assert.equal(report.ticks.length, 2, 'both `proactive_tick` steps really ticked');
  } finally {
    report.close();
  }
});

test('an unknown kind, a missing offset or a missing anchor fails the replay instead of skipping it', () => {
  assert.throws(
    () => parseReplayDocument([{ at: '+0m', event: 'sensor.observation', payload: {} }], { start: LOCAL_ANCHOR }),
    /unknown kind "sensor.observation"/,
    'pack §4 keeps sensor.observation for after V0.3: it must be a loud "not yet", not a no-op',
  );
  assert.throws(
    () => parseReplayDocument([{ at: '+0m' }], { start: LOCAL_ANCHOR }),
    /neither "kind" nor "event"/,
  );
  assert.throws(
    () => parseReplayDocument([{ kind: 'user_turn', text: '西西' }], { start: LOCAL_ANCHOR }),
    /no "at"/,
  );
  assert.throws(
    () => parseReplayDocument([{ at: '+0m', kind: 'user_turn', text: '西西' }]),
    /needs a "start" instant/,
    'the pack\'s array-shaped snippet has no anchor of its own',
  );
  assert.throws(
    () => parseReplayDocument({ start: '2026-10-05T08:00:00', steps: [] }),
    /explicit UTC offset/,
    'an anchor without an offset would silently mean "the machine\'s timezone"',
  );
  assert.throws(
    () =>
      parseReplayDocument({
        start: LOCAL_ANCHOR,
        steps: [
          { at: '+3h', kind: 'proactive_tick' },
          { at: '+1h', kind: 'proactive_tick' },
        ],
      }),
    /is before step 0/,
    'a script that rewinds would invert cause and effect',
  );
  assert.throws(
    () => parseReplayDocument([{ at: '+0m', event: 'perception', observation_type: 'audio.speech' }], { start: LOCAL_ANCHOR }),
    /observation_type "audio.speech" is not supported/,
  );
});

test('the document\'s own start is the default anchor, and an explicit start overrides it', async () => {
  const document = loadReplay(fixturePath('conversation-baseline.json'));
  assert.equal(document.start, '2026-10-05T08:00:00+08:00');
  assert.equal(document.steps.length, 4);

  // No override: the fixture's own anchor is used, offset included.
  const asWritten = await runReplay({ replay: fixturePath('conversation-baseline.json'), adapter: echoAdapter() });
  try {
    assert.equal(Date.parse(asWritten.start), Date.parse('2026-10-05T08:00:00+08:00'));
    assert.equal(asWritten.offsetMinutes, 480);
  } finally {
    asWritten.close();
  }

  // Override: the offsets are relative, so the same steps land on the local anchor instead.
  const local = anchorAt(new Date(2026, 9, 5, 8, 0, 0));
  const overridden = await runReplay({ replay: fixturePath('conversation-baseline.json'), start: local, adapter: echoAdapter() });
  try {
    assert.equal(Date.parse(overridden.start), new Date(2026, 9, 5, 8, 0, 0).getTime());
    assert.equal(overridden.steps[0]?.at, toOffsetIso(new Date(2026, 9, 5, 8, 0, 0)), 'step 0 sits on the anchor');
    assert.equal(
      Date.parse(overridden.steps[1]?.at ?? '') - Date.parse(overridden.steps[0]?.at ?? ''),
      10_000,
      'the relative offsets keep their meaning under any anchor',
    );
  } finally {
    overridden.close();
  }
});

test('the injected clock is the only clock: a replay anchored in 2020 writes 2020 timestamps', async () => {
  const anchor = new Date(2020, 4, 1, 8, 0, 0);
  const local = anchorAt(anchor);
  const window = scriptWindow('conversation-baseline.json', local);
  const report = await runReplay({ replay: fixturePath('conversation-baseline.json'), start: local, adapter: echoAdapter() });
  try {
    // The window comes from the *document's* offsets, so a run that read wall time cannot widen it.
    assert.equal(Date.parse(report.start), window.from, 'the run starts where the script starts');
    assert.equal(Date.parse(report.end), window.to, 'and ends where the script ends');
    const events = report.store.readEvents({ limit: Number.MAX_SAFE_INTEGER });
    assert.ok(events.length > 0, 'the replay wrote something to judge');
    for (const event of events) {
      const at = Date.parse(event.timestamp);
      assert.ok(
        at >= window.from && at <= window.to,
        `${event.event_type} at ${event.timestamp} is outside the script window — a wall-clock read leaked in`,
      );
    }
    // …and the consequence is visible in behaviour, not only in timestamps: the third turn is
    // refused because ten *script* minutes passed, while ten real minutes never did. With a wall
    // clock the same run would accept it as a continuation of the 30-second window.
    assert.deepEqual(
      report.turns.map((turn) => turn.reason),
      ['ACCEPTED_WAKE_OR_DIRECT', 'ACCEPTED_CONTINUATION', 'REJECTED_NOT_ADDRESSED', 'ACCEPTED_WAKE_OR_DIRECT'],
    );
  } finally {
    report.close();
  }
});

test('an empty script is a valid replay: it anchors, and it does nothing', async () => {
  const report = await runReplay({
    replay: { name: 'empty', start: LOCAL_ANCHOR, steps: [] },
    adapter: echoAdapter(),
  });
  try {
    assert.equal(report.steps.length, 0);
    assert.equal(report.end, report.start);
    assert.equal(report.store.eventCount(), 0, 'nothing ran, nothing was written');
    assert.notEqual(report.sessionId.length, 0, 'the run still has a session (its clock is the replay clock)');
  } finally {
    report.close();
  }
});

test('a run removes the scratch store it created, and leaves a caller-supplied one alone', async () => {
  const owned = await runReplay({
    replay: { name: 'scratch', start: LOCAL_ANCHOR, steps: [] },
    adapter: echoAdapter(),
  });
  const ownedDir = owned.dataDir;
  assert.equal(existsSync(join(ownedDir, 'xixi.sqlite')), true, 'the run had a store of its own, in the temp directory');
  owned.close();
  assert.equal(existsSync(ownedDir), false, 'closing the run takes its scratch directory with it');

  // A directory the caller handed in is the caller's: replay may not delete evidence.
  const mine = mkdtempSync(join(tmpdir(), 'xixi-replay-caller-'));
  const report = await runReplay({
    replay: { name: 'caller-owned', start: LOCAL_ANCHOR, steps: [] },
    adapter: echoAdapter(),
    dataDir: mine,
  });
  try {
    assert.equal(existsSync(join(mine, 'xixi.sqlite')), true);
  } finally {
    report.close();
    assert.equal(existsSync(join(mine, 'xixi.sqlite')), true, '`close()` left the caller\'s directory alone');
    rmSync(mine, { recursive: true, force: true });
  }
});
