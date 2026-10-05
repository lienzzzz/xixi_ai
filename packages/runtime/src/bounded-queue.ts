/** One bounded FIFO, including its executing task; rejection never starts work. */
export class BoundedQueue {
  readonly #capacity: number;
  #pending = 0;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(capacity = 64) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) throw new Error('INVALID_QUEUE_CAPACITY');
    this.#capacity = capacity;
  }

  enqueue<T>(action: () => Promise<T>): Promise<T> { return this.enqueuePrepared(() => action); }

  /** Capture immutable input synchronously, only after verifying there is space. */
  enqueuePrepared<T>(prepare: () => () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('QUEUE_CLOSED'));
    if (this.#pending >= this.#capacity) return Promise.reject(new Error('INPUT_BACKPRESSURE'));
    let action: () => Promise<T> = async () => { throw new Error('QUEUE_PREPARATION_PENDING'); };
    this.#pending++;
    // Reserve both capacity and FIFO position before synchronous callbacks can reenter.
    const work = this.#tail.then(() => action()).finally(() => { this.#pending--; });
    this.#tail = work.then(() => {}, () => {});
    try { action = prepare(); } catch (error) { action = () => Promise.reject(error); }
    return work;
  }

  async close(): Promise<void> { this.#closed = true; await this.#tail; }
}
