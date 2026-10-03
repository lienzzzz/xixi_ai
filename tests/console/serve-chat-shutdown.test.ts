/**
 * pack v03-preflight ⑦：`serve-chat` 没有 SIGINT/SIGTERM 收尾。
 *
 * `afterTurn` 只把后台提取**入队**（`setTimeout(run, 0)`，`unref` 过），所以「说完最后一句 → Ctrl+C」
 * 这一瞬间队列里通常还有一轮；进程默认的信号行为是直接终止，那一轮就没了（库也不是正常关闭的）。
 *
 * 三条断言，各钉一段：
 *   1. **收尾语义**：用真的 `TurnMemoryExtractor`（调度器故意不跑 → 队列里必然有活）驱动
 *      `shutdownAll`，断言「排队的活真的落了库」「库真的关了」「顺序 = 先停服务 → 跑完队列 → 关库」；
 *   2. **接线**：`installShutdownHandlers` 之后向本进程真的 `process.emit('SIGTERM')` —— 走的是
 *      Node 派发信号事件的同一条路，断言收尾真的跑了、退出码是 0、第二条信号不会把库关两遍；
 *   3. **入口真的挂了它**：读 `scripts/serve-chat.ts`，`import.meta.main` 块里必须调用
 *      `installShutdownHandlers({ server, extractor, store })`（前两条证明的是这个函数，这条证明
 *      真入口用了它）。
 *
 * 平台限制（如实记录）：Windows 上 `child.kill('SIGTERM')` 是 `TerminateProcess`，**不会**在子进程里
 * 变成 JS 的信号事件，所以「起一个真进程再 kill 它」在这个平台上无法证明收尾 —— 上面第 2 条用
 * Node 自己的信号派发路径代替，第 3 条补上入口接线。Ctrl+C（SIGINT）在真控制台里是能进 JS 的。
 *
 * Run: `npm run test:console`（也在 `npm test` 里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TurnMemoryExtractor } from '@xixi/conversation';
import { MemoryStore, openXixiStore, SelfModel } from '@xixi/domain';

import { REPO_ROOT } from '../../scripts/lib/harness.ts';
import { installShutdownHandlers, shutdownAll } from '../../scripts/serve-chat.ts';

const REPO = join(REPO_ROOT);

test('shutdownAll 先停服务、再把排队的后台提取跑完、最后关库（preflight ⑦）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-shutdown-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => new Date(2026, 9, 2, 20, 0, 0) });
  const memory = new MemoryStore(store);
  const steps: string[] = [];
  /** 库关之前的读数：close 之后就不能再查了，而「排队那轮落了库」正是要看的东西。 */
  let preferencesAtClose = -1;
  try {
    /**
     * 调度器**故意不跑**：这一轮提取就会一直躺在队列里 —— 正是「说完最后一句就 Ctrl+C」的那一瞬，
     * 而且是确定的，不看掐表。
     */
    const extractor = new TurnMemoryExtractor({
      store,
      selfModel: new SelfModel(store),
      memory,
      scheduler: () => {},
    });
    extractor.enqueue({
      sessionId: store.createSession().sessionId,
      userText: '我很喜欢喝茉莉花茶。',
      replyText: null,
      at: new Date(2026, 9, 2, 20, 0, 0),
      userEventId: 'evt_00000000-0000-4000-8000-0000000000aa',
      inferredCode: null,
    });
    assert.equal(extractor.pending, 1, '前提：队列里确实有一轮没跑');
    assert.equal(memory.semantic({ property: 'preference', limit: 10 }).length, 0, '前提：它确实还没落库');

    const report = await shutdownAll({
      server: {
        close: () => steps.push('server.close'),
        closeAllConnections: () => steps.push('server.closeAllConnections'),
      },
      extractor: {
        flush: async () => {
          steps.push(`extractor.flush(${extractor.pending})`);
          await extractor.flush();
        },
        get pending() {
          return extractor.pending;
        },
      },
      store: {
        close: () => {
          steps.push('store.close');
          preferencesAtClose = memory.semantic({ property: 'preference', limit: 10 }).length;
          store.close();
        },
      },
      log: () => {},
    });

    assert.equal(report.flushed, 1, '收尾报告要说清跑掉了多少轮');
    assert.equal(preferencesAtClose, 1, '排队的提取真的落了库（读数取在关库之前的那一刻）');
    assert.deepEqual(
      steps,
      ['server.close', 'server.closeAllConnections', 'extractor.flush(1)', 'store.close'],
      '顺序：先停止接受新请求 → 跑完队列 → 关库',
    );
    assert.throws(() => store.mood(), undefined, '库必须已经正常关闭（再用就报错）');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('SIGTERM 真的接到收尾上：emit 之后跑完队列、退出码 0，第二条信号不会关两遍库（preflight ⑦）', async () => {
  const steps: string[] = [];
  const exits: number[] = [];
  const lines: string[] = [];
  let flushed = 0;
  const installed = installShutdownHandlers({
    server: { close: () => steps.push('server.close'), closeAllConnections: () => steps.push('server.closeAllConnections') },
    extractor: {
      flush: async () => {
        flushed += 1;
        steps.push('extractor.flush');
      },
      pending: 2,
    },
    store: { close: () => steps.push('store.close') },
    exit: (code) => steps.push(`exit(${code})`),
    log: (line) => lines.push(line),
  });
  try {
    assert.ok(process.listenerCount('SIGTERM') >= 1, 'SIGTERM 上必须有一个监听器');
    assert.ok(process.listenerCount('SIGINT') >= 1, 'SIGINT（Ctrl+C）上也要有');

    process.emit('SIGTERM');
    // 收尾是异步的（flush/close 之后才 exit）：等这条链跑完。
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      steps,
      ['server.close', 'server.closeAllConnections', 'extractor.flush', 'store.close', 'exit(0)'],
      '信号 → 停服务 → 跑完队列 → 关库 → 退出码 0',
    );
    assert.equal(flushed, 1, '队列只跑一次');
    assert.ok(lines.some((line) => /收到 SIGTERM/.test(line)), `要说清是被哪条信号叫停的：${JSON.stringify(lines)}`);
    assert.ok(lines.some((line) => /\[shutdown\] 已停止接受新请求，跑掉 2 轮/.test(line)), '收尾行要报告跑掉了几轮');

    // 收尾途中再来一条信号：不许把库关第二遍。
    process.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(flushed, 1, '第二次信号被开关挡住');
    assert.deepEqual(steps.slice(-4), ['server.closeAllConnections', 'extractor.flush', 'store.close', 'exit(0)']);
  } finally {
    installed.dispose();
  }
});

test('真入口把收尾挂上了：import.meta.main 块里调用 installShutdownHandlers（preflight ⑦）', () => {
  const source = readFileSync(join(REPO, 'scripts', 'serve-chat.ts'), 'utf8');
  const main = source.indexOf('if (import.meta.main) {');
  assert.ok(main > 0, 'serve-chat.ts 必须有 import.meta.main 块');
  const block = source.slice(main);
  assert.match(
    block,
    /installShutdownHandlers\(\{\s*server,\s*extractor,\s*store\s*\}\)/,
    '真入口必须把真实的 server / extractor / store 接到信号收尾上（只定义函数不算接线）',
  );
});
