/**
 * 提取队列不让数据静默消失（t9 评审 T9-F3；AGENTS §3「长任务要能从中断处恢复」）。
 *
 * 分三件事证明，各用各的手段：
 *
 *   1. **默认调度器真的会跑**：它是宏任务 + `unref`（没人等也能退出，所以进程退出那一刻要靠
 *      `drainOnExit` 兜底，见第 2、3 条）—— 等一个 tick 之后队列清空、学习落库；
 *   2. **正常退出**：排完队就什么都不做，让进程退出 —— 退出之后重新打开库，那一轮必须已经落库。
 *      这一条只能用**真实子进程**（`extraction-exit-fixture.ts`）来测：测试进程自己不会退出，
 *      在进程内观察不到「退出把队列吃掉」这件事；
 *   3. **跑不掉的时候**（库已经关了）：`drainOnExit` 在 stderr 留一行可见日志，说清丢了几轮、
 *      是哪几轮（每轮都带着 `userEventId`，可以回到事件日志重放）。
 *
 * Run: `npm test`（unit 也在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TurnMemoryExtractor } from '@xixi/conversation';
import { openXixiStore, SelfModel, type XixiStore } from '@xixi/domain';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const FIXTURE = join(import.meta.dirname, 'extraction-exit-fixture.ts');

/** 临时库 + 一条「你话太多了。」的用户轮次（显式反馈，落库看得见）。 */
function turnStore(): { readonly store: XixiStore; readonly sessionId: string; readonly text: string; readonly userEventId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-extract-queue-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite') });
  store.seedSelfProfile({ talkativeness: 0.75 });
  const session = store.createSession();
  const text = '你话太多了。';
  const { event } = store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text });
  return { store, sessionId: session.sessionId, text, userEventId: event.event_id };
}

/** 接住 stderr（`drainOnExit` 的可见日志就是往那儿写的）；`finally` 里必须 `restore()`。 */
function captureStderr(): { readonly text: () => string; readonly restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  return { text: () => chunks.join(''), restore: () => void (process.stderr.write = original) };
}

interface FixtureRun {
  readonly status: number | null;
  readonly out: string;
  readonly err: string;
}

/** 真跑一个子进程；stdout/stderr 分开收（丢失日志走 stderr）。 */
function runFixture(mode: string, dbPath: string): Promise<FixtureRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FIXTURE, `--mode=${mode}`, `--db=${dbPath}`], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
    });
    child.on('error', (error) => resolve({ status: null, out, err: `${err}${String(error)}` }));
    child.on('close', (status) => resolve({ status, out, err }));
  });
}

test('默认调度器真的会跑：一个宏任务之后队列清空、学习落库', async () => {
  const { store, sessionId, text, userEventId } = turnStore();
  try {
    // 不传 scheduler = 生产那一套（`DEFAULT_EXTRACTION_SCHEDULER`）。
    const extractor = new TurnMemoryExtractor({ store });
    extractor.enqueue({ sessionId, userText: text, replyText: null, at: new Date(), userEventId });
    assert.equal(extractor.pending, 1, '入队是同步的：回复那一刻还没提取');

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(extractor.pending, 0, '过了一个宏任务，队列必须已经跑完');
    assert.equal(extractor.processed, 1);
    assert.equal(new SelfModel(store).learned().find((entry) => entry.property === 'talkativeness')?.delta, -0.12);
  } finally {
    store.close();
  }
});

test('drainOnExit：库还开着就把排队的活同步跑完，不写任何「丢了」的日志', () => {
  const { store, sessionId, text, userEventId } = turnStore();
  try {
    // 手动调度器：活一直留在队列里，模拟「进程马上就要退出了」。
    const extractor = new TurnMemoryExtractor({ store, scheduler: () => {} });
    extractor.enqueue({ sessionId, userText: text, replyText: null, at: new Date(), userEventId });
    extractor.enqueue({ sessionId, userText: '你可以主动一点。', replyText: null, at: new Date(), userEventId });
    assert.equal(extractor.pending, 2);

    const captured = captureStderr();
    let lost = -1;
    try {
      lost = extractor.drainOnExit();
    } finally {
      captured.restore();
    }
    assert.equal(lost, 0, '跑得掉就没有「丢」这一说');
    assert.equal(extractor.pending, 0);
    assert.equal(extractor.processed, 2);
    assert.equal(extractor.errors, 0);
    assert.equal(captured.text(), '', '没丢东西就不该有噪声');
  } finally {
    store.close();
  }
});

test('drainOnExit：库已经关了 → 丢掉的轮次在 stderr 留一行可见日志（含会话与轮次事件 id）', () => {
  const { store, sessionId, text, userEventId } = turnStore();
  try {
    const extractor = new TurnMemoryExtractor({ store, scheduler: () => {} });
    extractor.enqueue({ sessionId, userText: text, replyText: null, at: new Date(), userEventId });
    store.close(); // 这一轮再也写不进去了：兜底只剩「说清楚」

    const captured = captureStderr();
    let lost = -1;
    try {
      lost = extractor.drainOnExit();
    } finally {
      captured.restore();
    }
    assert.equal(lost, 1);
    assert.equal(extractor.errors, 1, '跑失败也要计数');
    assert.equal(extractor.pending, 0);
    assert.match(captured.text(), /退出时丢了 1 轮后台提取/, '丢数据不能是无声的');
    assert.ok(captured.text().includes(sessionId), `日志要能定位到会话：${captured.text()}`);
    assert.ok(captured.text().includes(userEventId), `日志要能定位到那条轮次（可以重放）：${captured.text()}`);
  } finally {
    store.close();
  }
});

test('正常退出：排完队就不管了，进程退出之后那一轮仍然落库（真实子进程）', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-extract-exit-'));
  const dbPath = join(dir, 'x.sqlite');
  const result = await runFixture('natural', dbPath);
  assert.equal(result.status, 0, `子进程必须正常退出：${result.err}`);
  assert.match(result.out, /^enqueued evt_/m, '夹具确实排了一轮活');

  // 退出之后重新打开库：学习已经在里面 —— 退出没有把那一轮吃掉。
  const reopened = openXixiStore({ dbPath });
  try {
    assert.equal(
      new SelfModel(reopened).learned().find((entry) => entry.property === 'talkativeness')?.delta,
      -0.12,
      '队列里的那一轮必须在进程结束前跑完（unref 过的定时器会把它留在队列里）',
    );
  } finally {
    reopened.close();
  }
});

test('来不及跑（库已经关了才退出）：日志里有那一轮，库确认是空的', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-extract-lost-'));
  const dbPath = join(dir, 'x.sqlite');
  const result = await runFixture('closed-store', dbPath);
  assert.equal(result.status, 0, `子进程必须正常退出：${result.err}`);
  assert.match(result.err, /退出时丢了 1 轮后台提取/, `退出时必须留下可见日志：${result.err}`);
  assert.match(result.err, /evt_[0-9a-f-]+/, '日志里要有那条轮次的事件 id');

  const reopened = openXixiStore({ dbPath });
  try {
    assert.equal(new SelfModel(reopened).learned().length, 0, '这一轮确实没落库 —— 所以那行日志是唯一线索');
  } finally {
    reopened.close();
  }
});
