/**
 * 「进程退出时，队列里那一轮提取会不会丢」的探针夹具。
 *
 * 它**不是**测试（`node --test` 只收 `*.test.ts`）：由 `extraction-exit.test.ts` 用真实子进程跑它。
 * 「退出」这件事只有在真的退出一次的时候才可观察 —— 在测试进程里 `setTimeout(run, 0)` 是不是
 * `unref` 过根本看不出来。
 *
 * 用法：`node tests/unit/core/extraction-exit-fixture.ts --mode=natural|closed-store --db=<path>`
 *
 *   * `natural`      —— 排完队就什么都不做，让进程自己退出（事件循环空了）。队列跑完了没有，
 *                       由父进程重新打开数据库看学习层。
 *   * `closed-store` —— 排完队把库关掉再 `process.exit(0)`：这一轮已经跑不了了，
 *                       兜底只能留一行可见日志。
 *
 * `writeSync` 而不是 `process.stdout.write`：管道上的 stdout 在退出瞬间可能还没冲出去。
 */
import { writeSync } from 'node:fs';

import { TurnMemoryExtractor } from '@xixi/conversation';
import { openXixiStore } from '@xixi/domain';

const args = process.argv.slice(2);
const valueOf = (name: string): string | null => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const mode = valueOf('mode') ?? 'natural';
const dbPath = valueOf('db');
if (dbPath === null || dbPath.length === 0) throw new Error('--db=<path> is required');

const store = openXixiStore({ dbPath });
const session = store.createSession();
const { event } = store.recordTurn({
  sessionId: session.sessionId,
  role: 'user',
  action: 'SPEAK',
  text: '你话太多了。',
});

// 默认调度器（生产那一套）：不传 scheduler。
const extractor = new TurnMemoryExtractor({ store });
extractor.enqueue({
  sessionId: session.sessionId,
  userText: '你话太多了。',
  replyText: null,
  at: new Date(),
  userEventId: event.event_id,
});
writeSync(1, `enqueued ${event.event_id} pending=${extractor.pending}\n`);

if (mode === 'closed-store') {
  store.close();
  process.exit(0);
}
