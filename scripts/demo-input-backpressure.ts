/** Offline FIFO/backpressure demonstration; rejected work is never run. */
import assert from 'node:assert/strict';
import { BoundedQueue } from '../packages/runtime/src/bounded-queue.ts';

const queue = new BoundedQueue(2); const order: string[] = [];
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
const first = queue.enqueue(async () => { order.push('first'); await gate; });
const second = queue.enqueue(async () => { order.push('second'); });
let rejectedPrepared = false;
await assert.rejects(queue.enqueuePrepared(() => { rejectedPrepared = true; return async () => { order.push('rejected'); }; }), /INPUT_BACKPRESSURE/);
release(); await first; await second;
await queue.enqueue(async () => { order.push('after-release'); });
await queue.close();
assert.deepEqual(order, ['first', 'second', 'after-release']);
assert.equal(rejectedPrepared, false);
console.log(JSON.stringify({ schemaVersion: 1, capacity: 2, acceptedTasks: order.length, rejectedInputs: 1,
  rejectedPrepared, order, realProviderCalled: false, hardwareVerified: false }));
