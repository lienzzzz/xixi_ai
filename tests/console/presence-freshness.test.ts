/**
 * t98: 「有人到家」 must not fire on a stale presence projection.
 *
 * The bug: stopping the camera (or simply letting the row's TTL run out) left `present: true` in
 * `world_state`, and the loop greeted an empty room — 西西 talked to nobody because a *statement
 * with an expiry date* was read as a fact about now. These tests pin the four things that make the
 * reading trustworthy: the `stale` flag, the TTL window (including its boundary), a parsable
 * timestamp, and the fallback TTL for readers that do not pass one.
 *
 * Run: `npm run test:console` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildEvent, toOffsetIso } from '@xixi/contracts';
import { openXixiStore } from '@xixi/domain';

import {
  buildProactiveCandidates,
  createFakeProbeRunner,
  createFieldServer,
  presenceFreshness,
} from '../../scripts/field-test.ts';

const T0 = new Date('2026-09-30T15:00:00+08:00');
const DEFAULT_TTL = 60;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Candidates for one instant, with the presence reading the caller describes. */
function candidatesAt(presence: Parameters<typeof presenceFreshness>[0], now: Date = T0) {
  return buildProactiveCandidates({
    now,
    presence,
    // Two minutes ago: the silence candidate must not fire, so the presence reading is the only
    // thing under test. No clock hook either (15:00 is not a hook minute).
    lastUserTurnAt: new Date(now.getTime() - 2 * 60_000),
    inConversation: false,
    random: () => 1,
  });
}

const presenceArrived = (presence: Parameters<typeof presenceFreshness>[0], now: Date = T0): boolean =>
  candidatesAt(presence, now).some((plan) => plan.candidate.trigger === 'presence_arrived');

test('a fresh projection produces the arrival candidate (t98)', () => {
  const updatedAt = new Date(T0.getTime() - 5_000).toISOString();
  assert.equal(presenceArrived({ present: true, updatedAt, ttlSeconds: DEFAULT_TTL }), true);

  const plan = candidatesAt({ present: true, updatedAt, ttlSeconds: DEFAULT_TTL })[0];
  assert.equal(plan?.candidate.trigger, 'presence_arrived');
  assert.match(plan?.fact ?? '', /在 60s 的 TTL 内/, 'the fact states why the reading is trusted');
  assert.match(plan?.fact ?? '', /5s 前更新/);
});

test('the 52-minute-old projection from the bug report produces nothing (t98)', () => {
  const updatedAt = new Date(T0.getTime() - 52 * 60_000);
  const reading = { present: true, updatedAt: updatedAt.toISOString(), ttlSeconds: DEFAULT_TTL };
  const freshness = presenceFreshness(reading, T0);
  assert.equal(freshness.fresh, false);
  assert.equal(freshness.ageSeconds, 3120, '52 minutes, measured');
  assert.match(freshness.reason, /在场投影已过期：3120s 前更新，TTL 只有 60s/);
  assert.equal(presenceArrived(reading), false, 'an empty room must not be greeted');
  assert.deepEqual(candidatesAt(reading), [], 'and with nothing else to go on, there is no candidate at all');
});

test('the projection’s own stale flag wins even when the timestamp looks recent (t98)', () => {
  const reading = { present: true, updatedAt: new Date(T0.getTime() - 1_000).toISOString(), ttlSeconds: DEFAULT_TTL, stale: true };
  assert.equal(presenceFreshness(reading, T0).fresh, false);
  assert.match(presenceFreshness(reading, T0).reason, /已被标为过期/);
  assert.equal(presenceArrived(reading), false);
});

test('the TTL boundary is inclusive, one millisecond past it is not (t98)', () => {
  const atBoundary = new Date(T0.getTime() - DEFAULT_TTL * 1_000);
  const justInside = { present: true, updatedAt: atBoundary.toISOString(), ttlSeconds: DEFAULT_TTL };
  assert.equal(presenceFreshness(justInside, T0).fresh, true, 'age === TTL is still inside');
  assert.equal(presenceArrived(justInside), true);

  const oneMsPast = { present: true, updatedAt: new Date(atBoundary.getTime() - 1).toISOString(), ttlSeconds: DEFAULT_TTL };
  assert.equal(presenceFreshness(oneMsPast, T0).fresh, false, 'one millisecond later it is not');
  assert.equal(presenceArrived(oneMsPast), false);

  // A TTL of 0 (or a nonsense one) means "this statement expires immediately".
  assert.equal(presenceArrived({ present: true, updatedAt: new Date(T0.getTime() - 1_000).toISOString(), ttlSeconds: 0 }), false);
});

test('without a timestamp (or with an unreadable one) nothing is proven (t98)', () => {
  assert.equal(presenceArrived({ present: true, updatedAt: null, ttlSeconds: DEFAULT_TTL }), false);
  assert.match(presenceFreshness({ present: true, updatedAt: null, ttlSeconds: DEFAULT_TTL }, T0).reason, /没有更新时间/);
  assert.equal(presenceArrived({ present: true, updatedAt: 'not-a-date', ttlSeconds: DEFAULT_TTL }), false);
  assert.match(presenceFreshness({ present: true, updatedAt: 'not-a-date', ttlSeconds: DEFAULT_TTL }, T0).reason, /更新时间读不出来/);
});

test('a reader that passes no TTL gets the domain default, not “trust forever” (t98)', () => {
  // `scripts/serve-chat.ts` reads presence without a TTL; it must keep working for a fresh row…
  const fresh = { present: true, updatedAt: new Date(T0.getTime() - 3_000).toISOString() };
  assert.equal(presenceFreshness(fresh, T0).ttlSeconds, DEFAULT_TTL);
  assert.equal(presenceArrived(fresh), true);
  // …and must not trust a row that is older than the default either.
  const old = { present: true, updatedAt: new Date(T0.getTime() - 5 * 60_000).toISOString() };
  assert.equal(presenceFreshness(old, T0).ttlSeconds, DEFAULT_TTL);
  assert.equal(presenceArrived(old), false);
});

test('present=false never produces the arrival candidate, fresh or not (t98)', () => {
  const reading = { present: false, updatedAt: new Date(T0.getTime() - 1_000).toISOString(), ttlSeconds: DEFAULT_TTL };
  assert.equal(presenceArrived(reading), false);
  assert.match(presenceFreshness(reading, T0).reason, /present=false/);
  assert.equal(presenceArrived(null), false);
  assert.match(presenceFreshness(null, T0).reason, /还没有在场投影/);
});

test('the loop refuses to greet an empty room, and says why (t98)', { timeout: 60_000 }, async () => {
  const root = tempDir('xixi-t98-stale-');
  const dataDir = join(root, 'data');
  const presenceDir = join(root, 'presence');
  // Exactly the bug report's data: a `present: true` projection 52 minutes old, TTL 60 s.
  const presenceStore = openXixiStore({ dataDir: presenceDir });
  presenceStore.recordPresenceChanged({
    present: true,
    confidence: 0.9,
    sourceDetail: 't98 fixture',
    ttlSeconds: DEFAULT_TTL,
    // The store takes the envelope's ISO-with-offset form, not a Date.
    timestamp: toOffsetIso(new Date(Date.now() - 52 * 60_000)),
  });
  presenceStore.close();

  const handle = await createFieldServer({
    port: 0,
    offline: true,
    ttsEnabled: false,
    voiceDir: join(root, 'voice'),
    dataDir,
    presenceDataDir: presenceDir,
    reportDir: join(root, 'recon'),
    autoPrune: false,
    probeRunner: createFakeProbeRunner(),
    log: () => {},
  });
  const post = async (path: string, body: unknown): Promise<Record<string, any>> =>
    (await (await fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json()) as Record<string, any>;
  try {
    const state = (await (await fetch(`${handle.url}/api/field/presence`)).json()) as Record<string, any>;
    assert.equal(state.present, true, 'the store really does hold present=true');
    assert.equal(state.stale, true, 'and the reader agrees it is stale');

    const ticked = await post('/api/field/proactive/loop', { action: 'tick' });
    assert.equal(ticked.ok, true);
    const triggers = (ticked.entries as { trigger: string }[]).map((entry) => entry.trigger);
    assert.ok(!triggers.includes('presence_arrived'), `不得因过期投影产生「有人到达」：${JSON.stringify(triggers)}`);
    assert.equal(ticked.presence.fresh, false, 'the payload says the reading is not usable');
    assert.match(String(ticked.presence.reason), /过期/, 'and why (the reader flags it, or the age is past the TTL)');
    // The two ways of being stale report the age differently, and both are fine: the reader's own
    // `stale` flag is enough to refuse the reading, so it does not have to measure the age too.
    assert.ok(ticked.presence.ageSeconds === null || ticked.presence.ageSeconds > 3000, `age: ${ticked.presence.ageSeconds}`);
    assert.equal(ticked.presence.ttlSeconds, DEFAULT_TTL, 'and it reports the TTL it judged against');
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('the same loop does greet a fresh arrival (t98)', { timeout: 60_000 }, async () => {
  const root = tempDir('xixi-t98-fresh-');
  const presenceDir = join(root, 'presence');
  const presenceStore = openXixiStore({ dataDir: presenceDir });
  presenceStore.recordPresenceChanged({ present: true, confidence: 0.9, sourceDetail: 't98 fixture', ttlSeconds: DEFAULT_TTL });
  presenceStore.close();

  // A recent user turn, so the silence candidate cannot fire and the arrival is the only one.
  const dataDir = join(root, 'data');
  const dataStore = openXixiStore({ dataDir });
  const session = dataStore.createSession();
  dataStore.appendEvent(
    buildEvent({
      event_type: 'conversation.turn',
      source: 't98',
      actor: 'father',
      confidence: 1,
      timestamp: toOffsetIso(new Date(Date.now() - 2 * 60_000)),
      payload: { session_id: session.sessionId, turn_index: 0, role: 'user', text: '我在呢', action: 'SPEAK' },
    }),
  );
  dataStore.close();

  const handle = await createFieldServer({
    port: 0,
    offline: true,
    ttsEnabled: false,
    voiceDir: join(root, 'voice'),
    dataDir,
    presenceDataDir: presenceDir,
    reportDir: join(root, 'recon'),
    autoPrune: false,
    probeRunner: createFakeProbeRunner(),
    log: () => {},
  });
  const post = async (path: string, body: unknown): Promise<Record<string, any>> =>
    (await (await fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json()) as Record<string, any>;
  try {
    const ticked = await post('/api/field/proactive/loop', { action: 'tick' });
    assert.equal(ticked.ok, true);
    assert.deepEqual((ticked.entries as { trigger: string }[]).map((entry) => entry.trigger), ['presence_arrived'], 'a fresh arrival is the candidate');
    assert.equal(ticked.presence.fresh, true);
    assert.match(String(ticked.presence.reason), /TTL 内/);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
