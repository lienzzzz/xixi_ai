/**
 * P0-B: presence enters the store through **one** writer, from the perception child's stdout.
 *
 * The defect this guards (audit §3.5): `services/perception-edge` was spawned with
 * `--db <file> --append`, so the Python child opened the same SQLite file the console had open and
 * inserted `events` + `world_state` rows itself. Two processes, one store, and the event/projection
 * transaction living in the child.
 *
 * The contract now is:
 *   * the child prints `{"record":"event", …envelope}` — it never receives a database path;
 *   * `ingestPerceptionLine` validates the envelope and appends it through the domain's
 *     single-transaction `appendPresenceEvent`;
 *   * frame records (which carry a JPEG and per-frame numbers) are **never** persisted.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildEvent } from '@xixi/contracts';
import { fixedClock, openXixiStore } from '@xixi/domain';
import { ingestPerceptionLine, type PerceptionIngestDeps } from '@xixi/runtime';

/** A minimal store double: records what the ingest asked it to append. */
function fakeStore(): PerceptionIngestDeps['store'] & { readonly appended: string[] } {
  const appended: string[] = [];
  return {
    appended,
    appendPresenceEvent(envelope) {
      appended.push(envelope.event_id);
      const present = (envelope.payload as { present?: unknown }).present === true;
      return {
        event: {
          eventId: envelope.event_id,
          eventType: envelope.event_type,
          schemaVersion: envelope.schema_version,
          timestamp: envelope.timestamp,
          source: envelope.source,
          room: envelope.room,
          actor: envelope.actor,
          confidence: envelope.confidence,
          correlationId: envelope.correlation_id,
          sessionId: null,
          sequence: appended.length,
          payload: envelope.payload,
        },
        state: {
          key: 'presence.home',
          schemaVersion: 1,
          value: present ? 'present' : 'absent',
          source: envelope.source,
          updatedAt: envelope.timestamp,
          confidence: envelope.confidence,
          ttlSeconds: 60,
          stale: false,
          staleAfter: envelope.timestamp,
          present,
          previousState: null,
        },
      } as never;
    },
  };
}

/** The child's stdout record: the envelope plus its own routing key. */
function eventLine(present: boolean, overrides: Record<string, unknown> = {}): string {
  const event = buildEvent({
    event_type: 'presence.changed',
    source: 'perception.laptop_camera',
    actor: 'unknown_person',
    confidence: 0.91,
    payload: { present, source_detail: 'motion + face confirmation' },
    timestamp: '2026-10-04T09:00:00+08:00',
  });
  return `${JSON.stringify({ record: 'event', ...event, ...overrides })}\n`;
}

test('一条在场事件：校验后入库，event_id 保留', () => {
  const store = fakeStore();
  const outcome = ingestPerceptionLine(eventLine(true), { store });
  assert.equal(outcome.kind, 'ingested');
  assert.equal(store.appended.length, 1, '入库恰好一次');
  if (outcome.kind === 'ingested') {
    assert.equal(outcome.present, true);
    // The child's own event id survives — re-keying it would break correlation with its stdout.
    assert.equal(store.appended[0], outcome.eventId);
  }
});

test('子进程真实那一行的形状（带空格与 = 的 source_detail）照样入库', () => {
  // Copied from `python -m perception_edge.run --source synthetic --seconds 1` (no --db): the
  // detector writes a human-readable evidence string, spaces and `=` included.
  const line = JSON.stringify({
    record: 'event',
    schema: 'xixi.event.v1',
    schema_version: 1,
    event_id: 'evt_b29a8504-7936-4be1-938a-882fd79cd524',
    event_type: 'presence.changed',
    timestamp: '2026-10-04T01:02:51.748+08:00',
    source: 'perception.laptop_camera',
    room: null,
    actor: 'father',
    confidence: 0.75,
    correlation_id: 'corr_483be90a-ba90-41e4-bfcc-f4ddb08c3e5e',
    payload: {
      present: true,
      source_detail: 'mode=synthetic state=present frames=47 motion_ratio=0.1480 faces=0 gate=motion+face reason=present_confirmed',
    },
  });
  const store = fakeStore();
  const outcome = ingestPerceptionLine(line, { store });
  assert.equal(outcome.kind, 'ingested', `真实输出必须能入库：${JSON.stringify(outcome)}`);
  assert.equal(store.appended.length, 1);
});

test('帧记录与汇总行永远不入库（画面不是事实）', () => {
  const store = fakeStore();
  const frame = JSON.stringify({ record: 'frame', type: 'frame', frame_index: 7, jpeg: 'ZmFrZQ==', payload: { present: true } });
  assert.equal(ingestPerceptionLine(frame, { store }).kind, 'ignored');
  assert.equal(ingestPerceptionLine(JSON.stringify({ record: 'summary', frames: 10 }), { store }).kind, 'ignored');
  assert.equal(ingestPerceptionLine('摄像头不可用：camera busy', { store }).kind, 'ignored');
  assert.equal(store.appended.length, 0, '一帧都没有写进事件日志');
});

test('payload 漂移的 envelope 被拒在领域层，且不会写坏库', () => {
  const store = fakeStore();
  // Shape-valid envelope, drifted payload (`present` must be a boolean). Ids match the contract
  // patterns on purpose, so the rejection can only come from the payload schema — that is the check
  // `appendEvent` adds on top of the child's own validation.
  const drifted = eventLine(true).trim();
  const mutated = JSON.stringify({
    ...(JSON.parse(drifted) as Record<string, unknown>),
    payload: { present: 'yes', source_detail: null },
  });
  const outcome = ingestPerceptionLine(mutated, { store });
  assert.equal(outcome.kind, 'rejected');
  assert.equal(store.appended.length, 0, '被拒的事件绝不能落库');
  // The message has to be readable in a log: it is what the console prints.
  if (outcome.kind === 'rejected') assert.match(outcome.reason, /payload|present/);
});

test('非 present 的事件类型被忽略（只认契约里那一种）', () => {
  const store = fakeStore();
  const other = JSON.stringify({ record: 'event', event_type: 'system.health', payload: {} });
  assert.equal(ingestPerceptionLine(other, { store }).kind, 'ignored');
  assert.equal(store.appended.length, 0);
});

test('真相来源是同一个库：事件落库后 world_state(presence.home) 同步更新', () => {
  // End-to-end through the real store (no Python, no camera): the ingest plus the domain's
  // single-transaction append is what the console actually runs.
  const dir = mkdtempSync(join(tmpdir(), 'xixi-ingest-'));
  const at = new Date('2026-10-04T09:00:10+08:00');
  const store = openXixiStore({ dataDir: dir, clock: fixedClock(at) });
  const outcome = ingestPerceptionLine(eventLine(true), { store });
  assert.equal(outcome.kind, 'ingested');

  const view = store.worldState('presence.home', { now: at });
  assert.equal(view?.present, true, '投影跟着事件走');
  assert.equal(store.readEvents({ type: 'presence.changed' }).length, 1, '事件恰好一条');

  // The projection is derived data: rebuilding it from the log must land on the same answer.
  store.rebuildWorldStateFromEvents('presence.home');
  assert.equal(store.worldState('presence.home', { now: at })?.present, true, '投影可以从日志重建');
  store.close();
});
