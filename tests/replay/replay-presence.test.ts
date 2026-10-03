/**
 * Baseline ② of `tests/replay`: **presence changes** (V0.3 P0-D).
 *
 * The fixture is one morning in the living room: someone arrives, is seen again, leaves; a
 * consideration tick runs twenty seconds after the arrival and another one a minute after the
 * person left. The test judges the chain that matters — the perception line enters the store
 * through the single writer (P0-B), the `world_state` projection follows it, the projection's TTL
 * is measured against the script clock, and the resident loop reacts to a *fresh* arrival and stops
 * reacting once nobody is there.
 *
 * Run: `npm run test:replay` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toOffsetIso } from '@xixi/contracts';
import { PRESENCE_KEY } from '@xixi/domain';

import { runReplay } from '@xixi/runtime';

import { anchorAt, echoAdapter, fixturePath, onlyTrigger } from './replay-fixtures.ts';

const ANCHOR = new Date(2026, 9, 5, 8, 0, 0);

test('baseline 2: a presence event becomes a projection, and staleness follows the script clock', async () => {
  const report = await runReplay({
    replay: fixturePath('presence-baseline.json'),
    start: anchorAt(ANCHOR),
    adapter: echoAdapter(),
  });
  try {
    assert.deepEqual(report.presence.map((step) => step.offset), ['+0m', '+2m', '+20m']);
    assert.ok(
      report.presence.every((step) => step.ingested),
      `every line must pass the real ingest: ${report.presence.map((step) => step.note).join('; ')}`,
    );

    // The single writer wrote an event *and* the projection for each transition (P0-B).
    const events = report.store.readEvents({ type: 'presence.changed', limit: 100 });
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((event) => event.actor),
      ['father', 'unknown_person', 'unknown_person'],
      'the script names an actor when it knows one; generic presence must not default to father',
    );
    assert.deepEqual(
      report.presence.map((step) => step.projection?.present),
      [true, true, false],
      'the projection right after each step matches that step',
    );
    assert.ok(
      report.presence.every((step) => step.projection?.stale === false),
      'at the instant it was written, the row is fresh',
    );
    assert.equal(report.presence[0]?.projection?.ttlSeconds, 60, 'the domain default TTL');

    // Behaviour of the projection + clock: the boundary is the row's own `staleAfter`, and the
    // judgement flips exactly there (the store uses `>=`).
    const staleAfter = report.presence[2]?.projection?.staleAfter ?? '';
    const justBefore = toOffsetIso(new Date(Date.parse(staleAfter) - 1), report.offsetMinutes);
    assert.equal(
      report.store.worldState(PRESENCE_KEY, { now: justBefore })?.stale,
      false,
      'one millisecond before the TTL the projection is still good',
    );
    assert.equal(
      report.store.worldState(PRESENCE_KEY, { now: staleAfter })?.stale,
      true,
      'on the boundary it is expired: 「上次看到人」 is not 「现在有人」',
    );

    // The log is the source of truth: rebuilding the projection from events lands on the same answer.
    const rebuilt = report.store.rebuildWorldStateFromEvents();
    assert.equal(rebuilt.scanned, 3);
    assert.equal(rebuilt.entry?.value, 'absent');
    assert.equal(report.store.worldState(PRESENCE_KEY, { now: report.end })?.value, 'absent');

    // The `system.health` step is the other kind this fixture exercises.
    const health = report.store.readEvents({ type: 'system.health', limit: 10 });
    assert.equal(health.length, 1);
    assert.equal((health[0]?.payload as Record<string, unknown>)['service'], 'perception.laptop_camera');
  } finally {
    report.close();
  }
});

test('baseline 2: the loop greets a fresh arrival and goes quiet once the room is empty', async () => {
  const report = await runReplay({
    replay: fixturePath('presence-baseline.json'),
    start: anchorAt(ANCHOR),
    adapter: echoAdapter(),
    settings: onlyTrigger('presence_arrived'),
  });
  try {
    assert.deepEqual(report.ticks.map((tick) => tick.offset), ['+20s', '+21m']);

    const arrivalTick = report.ticks[0];
    assert.equal(arrivalTick?.entry?.trigger, 'presence_arrived', 'twenty seconds after the arrival, this is the candidate');
    assert.equal(arrivalTick?.entry?.initiativeKind, 'environment_reaction');
    assert.equal(arrivalTick?.entry?.speak, true, `西西 should say hello: ${arrivalTick?.entry?.reasonCode}`);
    assert.equal(arrivalTick?.entry?.reasonCode, 'PASSED');
    assert.ok(
      (arrivalTick?.decisions ?? []).some((decision) => decision.trigger === 'presence_arrived' && decision.speak),
      'and the delivery is in the log with its own reason code',
    );

    // One minute after the person left there is nothing to greet: not "blocked", *absent*.
    const emptyTick = report.ticks[1];
    assert.equal(
      (emptyTick?.decisions ?? []).some((decision) => decision.trigger === 'presence_arrived'),
      false,
      'nobody is in the room, so no arrival candidate exists at all',
    );
    assert.notEqual(emptyTick?.entry?.speak, true);

    // The line really went into the conversation history (the next user turn must see that 西西 spoke).
    const replies = report.store
      .readEvents({ type: 'conversation.turn', limit: 100 })
      .filter((event) => (event.payload as Record<string, unknown>)['role'] === 'assistant');
    assert.equal(replies.length, 1, 'exactly one proactive message was spoken');
  } finally {
    report.close();
  }
});
