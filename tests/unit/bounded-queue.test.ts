import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoundedQueue } from '../../packages/runtime/src/bounded-queue.ts';

test('bounded queue preserves FIFO, rejects before preparation and releases success/failure slots', async () => {
  const queue = new BoundedQueue(2); const order: number[] = [];
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.enqueue(async () => { order.push(1); await gate; });
  const second = queue.enqueue(async () => { order.push(2); throw new Error('fixture_failure'); });
  const secondFailure = assert.rejects(second, /fixture_failure/);
  let prepared = false;
  await assert.rejects(queue.enqueuePrepared(() => { prepared = true; return async () => { order.push(3); }; }), /INPUT_BACKPRESSURE/);
  assert.equal(prepared, false);
  release(); await first; await secondFailure;
  await queue.enqueue(async () => { order.push(4); });
  assert.deepEqual(order, [1, 2, 4]); await queue.close();
});
test('close rejects admission and waits for accepted work', async () => {
  const queue = new BoundedQueue(1);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let done = false;
  const task = queue.enqueue(async () => { await gate; done = true; });
  const closing = queue.close();
  await assert.rejects(queue.enqueue(async () => {}), /QUEUE_CLOSED/);
  assert.equal(done, false); release(); await closing; await task; assert.equal(done, true);
});
test('queue capacity validates bounds and preparation failure consumes no slot', async () => {
  for (const value of [0, -1, 1.5, 1025, NaN]) assert.throws(() => new BoundedQueue(value), /INVALID_QUEUE_CAPACITY/);
  const queue = new BoundedQueue(1);
  await assert.rejects(queue.enqueuePrepared(() => { throw new Error('capture_failure'); }), /capture_failure/);
  assert.equal(await queue.enqueue(async () => 42), 42); await queue.close();
});
test('synchronous preparation cannot reenter past capacity or jump ahead in FIFO', async () => {
  const queue = new BoundedQueue(1); const order: string[] = [];
  let nested!: Promise<void>;
  const outer = queue.enqueuePrepared(() => {
    nested = queue.enqueue(async () => { order.push('nested'); });
    return async () => { order.push('outer'); };
  });
  try { await assert.rejects(nested, /INPUT_BACKPRESSURE/); await outer; assert.deepEqual(order, ['outer']); }
  finally { await outer; await queue.close(); }
  const wider = new BoundedQueue(2); const fifo: string[] = []; let inner!: Promise<void>;
  const leading = wider.enqueuePrepared(() => {
    inner = wider.enqueue(async () => { fifo.push('inner'); });
    return async () => { fifo.push('outer'); };
  });
  await leading; await inner; await wider.close(); assert.deepEqual(fifo, ['outer', 'inner']);
});
test('close called during preparation waits for its already reserved outer task', async () => {
  const queue = new BoundedQueue(1);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let closed = false; let closing!: Promise<void>;
  const task = queue.enqueuePrepared(() => { closing = queue.close().then(() => { closed = true; }); return async () => { await gate; }; });
  try {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(closed, false);
  } finally { release(); await task; await closing; }
});
