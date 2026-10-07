/**
 * V0.3 P1-b 验收③：**三个入口都调用 afterTurn**（`chat` / 试用页 / `voice-turn`）。
 *
 * 为什么要有这一条：审计与 handoff 都记过「`afterTurn` 只有试用页与现场控制台接了线」——
 * 命令行 `chat` 与 `voice-turn` 从来没接过。症状很具体：**用文字聊过的事她记得，用语音说的不记得**
 * （同一个西西，两个入口两套行为）。AGENTS §9.24 里那条纪律就是为这种改动写的：
 * 「接线」类声明必须用**真进程**核对，字符串断言看不见它。
 *
 * 所以三段证据都是**行为**的（读那个入口自己写下的库，不是读源码）：
 *   1. `chat.ts --fake` 喂一句话 → 库里出现它写下的记忆与话题；
 *   2. `voice-turn.ts --fake --wav …` → 同样；
 *   3. 真起一个试用页（`--fake --port 0`）POST 一轮 → 同样。
 *
 * 三个入口用的是同一份装配（`@xixi/runtime` 的 `createTurnExtraction`），所以「记住了什么」
 * 也应该一样：这条由第一段顺带断言（同样是「明天下午要去办证」那件事）。
 *
 * V0.3 P2.5-B：源码级核对（最后一条用例）的**对象变了**，判据也跟着变——
 * `afterTurn` 的职责上收进了常驻装配点 `createResidentRuntime`（`scripts/serve-chat.ts` 走它），
 * 所以每个入口要么自己调共享工厂 `createTurnExtraction`，要么走装配点；而装配点自身必须真的把
 * `extraction.afterTurn` 交给引擎（下面单独断言 `packages/runtime/src/resident-runtime.ts`）。
 * 注意这条源码级核对**永远只是补充**：真正的防线是上面那三段行为证据，一条都不许删。
 *
 * V0.3 P2.5-C：`chat.ts` 与 `voice-turn.ts` 也迁到装配点了，所以今天三个入口全走第二条路。
 * 判据仍写成二选一：它拦的是「入口自己 new 一个提取器」（第三条路），而不是钉住某个函数名。
 *
 * Run: `npm run test:console`（也在 `npm test` 里）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { REPO_ROOT } from '../../scripts/lib/harness.ts';
import { startTrialPage } from './serve-chat-fixture.ts';

const CHILD_TIMEOUT_MS = 180_000;
const PLAN = '明天下午我要去镇上办证';

interface MemoryRows {
  readonly episodic: readonly { readonly kind: string; readonly summary: string }[];
  readonly threads: readonly { readonly summary: string; readonly status: string }[];
}

/** 直接读那个入口写下的库（不看响应自述、不看 stdout）。 */
function readMemoryRows(dbPath: string): MemoryRows {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const episodic = db.prepare('SELECT kind, summary FROM episodic_memory ORDER BY rowid').all() as unknown as { kind: string; summary: string }[];
    const threads = db.prepare('SELECT summary, status FROM open_threads ORDER BY rowid').all() as unknown as { summary: string; status: string }[];
    return { episodic, threads };
  } finally {
    db.close();
  }
}

/** 起一个真进程、喂 stdin、等它退出。 */
async function runEntry(args: readonly string[], env: Record<string, string>, stdin: string | null): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => (output += chunk));
  child.stderr?.on('data', (chunk: string) => (output += chunk));
  if (stdin !== null) {
    child.stdin?.write(stdin);
    child.stdin?.end();
  }
  const code = await new Promise<number | null>((resolve) => {
    child.once('exit', (exitCode) => resolve(exitCode));
    setTimeout(() => {
      child.kill();
      resolve(null);
    }, CHILD_TIMEOUT_MS).unref();
  });
  return { code, output };
}

test('chat.ts：命令行里说过的一件没办完的事，真的落进记忆与话题表', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-afterturn-chat-'));
  try {
    const { code, output } = await runEntry(['scripts/chat.ts', '--fake'], { XIXI_CHAT_DATA_DIR: dir }, `${PLAN}。\n/exit\n`);
    assert.equal(code, 0, `chat.ts 要正常退出：\n${output}`);

    const dbPath = join(dir, 'xixi.sqlite');
    assert.equal(existsSync(dbPath), true, `入口要写下自己的库：${dbPath}`);
    const rows = readMemoryRows(dbPath);
    assert.equal(
      rows.episodic.some((row) => row.kind === 'plan' && row.summary.includes('办证')),
      true,
      `命令行入口必须把这件事记下来（afterTurn 真的接了线）：${JSON.stringify(rows.episodic)}`,
    );
    // 话题表（`open_threads`）这里**不**断言：它由 `TopicEngine.reconcile` 写，而命令行入口
    // 没有话题引擎（那是控制台/试用页的装配）。这一条用例证明的是 `afterTurn`，不是话题提取。
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('voice-turn.ts：语音里说的同一件事也落进记忆（离线 ASR 的转写里带那句话）', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-afterturn-voice-'));
  try {
    // 离线转写 = `（离线模拟）` + wav 路径，所以文件名里带那句话就能让这一轮的内容变成它。
    const wav = join(dir, `${PLAN}.wav`);
    copyFileSync(join(REPO_ROOT, 'tests', 'audio-fixtures', 'direct-question.wav'), wav);
    const { code, output } = await runEntry(
      ['scripts/voice-turn.ts', '--fake', '--wav', wav, '--out', join(dir, 'batch.txt')],
      { XIXI_VOICE_DATA_DIR: dir },
      null,
    );
    assert.equal(code, 0, `voice-turn.ts 要正常退出：\n${output}`);

    const rows = readMemoryRows(join(dir, 'xixi.sqlite'));
    assert.equal(
      rows.episodic.some((row) => row.summary.includes('办证')),
      true,
      `语音入口必须把这件事记下来（afterTurn 真的接了线）：${JSON.stringify(rows.episodic)}\n${output}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('试用页：POST 一轮之后，同一件事也进了它自己的库', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-afterturn-web-'));
  const page = await startTrialPage({ dataDir: dir });
  try {
    const response = await fetch(`${page.base}/api/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${PLAN}。`, speak: false }),
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(response.ok, true, `试用页要接受这一轮（HTTP ${response.status}）：\n${page.output()}`);
    await response.arrayBuffer();

    // 提取是**异步**的（`afterTurn` 只入队）：等它真的落库，最多 10 秒。
    const dbPath = join(dir, 'xixi.sqlite');
    let rows: MemoryRows = { episodic: [], threads: [] };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      rows = readMemoryRows(dbPath);
      if (rows.episodic.some((row) => row.summary.includes('办证'))) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(
      rows.episodic.some((row) => row.summary.includes('办证')),
      true,
      `试用页必须把这件事记下来：${JSON.stringify(rows.episodic)}\n${page.output()}`,
    );
  } finally {
    await page.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('三个入口用的是同一份装配：自己调共享工厂，或走常驻装配点（afterTurn 由装配点承担）', () => {
  // 这一条是**补充**（上面三段才是行为证据）：防止有人回头把某个入口改回自己那份实现。
  //
  // V0.3 P2.5-B：`afterTurn` 上收进装配点之后，入口有两种合法形态，源码级核对的对象因此是
  // 「有没有走共享装配」而不是某个具体函数名：
  //   ① 入口自己调 `createTurnExtraction(...)`（保留的合法形态：共享工厂仍然可以被直接调用）；
  //   ② 入口走 `createResidentRuntime(...)`（P2.5-C 之后三个入口都是这样），afterTurn 由装配点接管。
  // 第三条路——入口自己 new 一个提取器——会让这条用例红，那正是它要拦的。
  const sources = ['scripts/chat.ts', 'scripts/serve-chat.ts', 'scripts/voice-turn.ts'];
  const failures: string[] = [];
  for (const relative of sources) {
    const source = readFileSync(join(REPO_ROOT, relative), 'utf8');
    const viaSharedFactory = source.includes('createTurnExtraction(');
    const viaResidentRuntime = source.includes('createResidentRuntime(');
    if (!viaSharedFactory && !viaResidentRuntime) {
      failures.push(`${relative}: 既没有用共享装配（createTurnExtraction），也没有走常驻装配点（createResidentRuntime）`);
    }
    if (viaSharedFactory && !/afterTurn:\s*(extraction\.afterTurn|\(job\)\s*=>\s*extractor\.enqueue\(job\))/.test(source)) {
      failures.push(`${relative}: 没有把 afterTurn 交给引擎`);
    }
  }
  // 走装配点的那条路靠**装配点自己**成立，所以这里单独核对它：装配点必须真的调共享工厂，
  // 而且必须把它的 `afterTurn` 交给引擎。没有这一条，「走装配点」就只是转发一个名字。
  const resident = readFileSync(join(REPO_ROOT, 'packages', 'runtime', 'src', 'resident-runtime.ts'), 'utf8');
  if (!resident.includes('createTurnExtraction(')) {
    failures.push('packages/runtime/src/resident-runtime.ts: 装配点没有用共享提取器（走它的入口就没有共享装配）');
  }
  if (!/afterTurn:\s*extraction\.afterTurn/.test(resident)) {
    failures.push('packages/runtime/src/resident-runtime.ts: 装配点没有把 afterTurn 交给引擎');
  }
  // 试用页的常驻循环还要把上下文交给「读空气」（pack §6 §7）。这条是源码级核对：
  // 它真正跑起来需要一次真实模型调用（drill 走的是另一条路径），所以行为证据在
  // `tests/unit/context/proactive-decision-context.test.ts` 的循环用例里。
  const serveChat = readFileSync(join(REPO_ROOT, 'scripts/serve-chat.ts'), 'utf8');
  if (!/readContext:\s*\(input\)\s*=>/.test(serveChat)) failures.push('scripts/serve-chat.ts: 常驻循环没有把上下文交给读空气');
  assert.deepEqual(failures, []);
});
