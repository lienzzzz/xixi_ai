/**
 * t14 / T5-F1: every *live* entry must reach the same tool chain as the field-test console.
 *
 * Pack Phase 2 made the console, the trial page and `voice-turn.ts` share one registry. Four entries
 * were left out — the text CLI (`scripts/chat.ts`), the device self-check, the realism runner and the
 * conversation runner — and each of them built its own `defaultTools` list instead. A `defaultTools`
 * list has no round cap and no permission policy, and it is where a fifth built-in silently fails to
 * appear, so "同一套工具与权限" was true per entry rather than as a property of the code.
 *
 * Everything here is offline, no key and no cost:
 *
 *   * `--print-wiring` prints exactly what an entry hands the model, and it is computed by the same
 *     builder the entry's adapter uses (so the report cannot drift from the wiring);
 *   * the expected side is the console's own `buildToolChain(loadConfig())`, imported rather than
 *     restated, so this file cannot pass against a second hand-written list of tool names;
 *   * the offline branches are then *run*, because "the chain is wired in" is only true if the tools
 *     actually execute — a printed report alone would not prove it.
 *
 * Run: `npm run test:console` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CONVERSATION_SCOPE, buildToolChain } from '../../scripts/field-test.ts';
import { REPO_ROOT, loadConfig } from '../../scripts/lib/harness.ts';

/** The four entries T5-F1 named, each with the name it prints in its own wiring report. */
const ENTRIES = [
  { name: 'chat', script: 'scripts/chat.ts' },
  { name: 'voice-device-check', script: 'scripts/voice-device-check.ts' },
  { name: 'eval-realism', script: 'scripts/eval-realism.ts' },
  { name: 'eval-conversation', script: 'scripts/eval-conversation.ts' },
] as const;

const SPAWN_TIMEOUT_MS = 90_000;

interface RunResult {
  readonly status: number | null;
  readonly out: string;
}

/** stdout and stderr together: the `[tool] …` log goes to stderr and the replies to stdout. */
function run(script: string, args: readonly string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', (error) => resolve({ status: null, out: `${out}${String(error)}` }));
    child.on('close', (status) => resolve({ status, out }));
  });
}

/** The wiring report is the last non-empty line; entries are allowed to print a banner first. */
function wiringOf(out: string): Record<string, unknown> {
  const line = out
    .split(/\r?\n/)
    .filter((candidate) => candidate.trim().startsWith('{'))
    .at(-1);
  assert.ok(line !== undefined, `没有找到接线报告：\n${out}`);
  return JSON.parse(line) as Record<string, unknown>;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('四个 live 入口报告的工具链与 console 是同一条', { timeout: SPAWN_TIMEOUT_MS }, async () => {
  const config = loadConfig();
  const consoleChain = buildToolChain(config);
  const expected = {
    maxToolRounds: consoleChain.maxToolRounds,
    tools: consoleChain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name),
    permissions: Object.fromEntries(consoleChain.names().map((name) => [name, consoleChain.check(name, CONVERSATION_SCOPE).verdict])),
  };
  // A sanity check on the expectation itself: if the console ever stops exposing the built-ins, the
  // four comparisons below would all trivially agree on an empty set.
  assert.equal(expected.tools.length, 4, 'console 的内置工具集应当是四个（pack Phase 2）');
  assert.equal(expected.maxToolRounds, 4, '轮数上限由注册表钳制（pack Phase 2）');

  for (const entry of ENTRIES) {
    const result = await run(entry.script, ['--print-wiring']);
    assert.equal(result.status, 0, `${entry.script} --print-wiring 必须 exit 0：\n${result.out}`);
    const wiring = wiringOf(result.out);
    assert.equal(wiring.entry, entry.name, `${entry.script} 报告的入口名`);
    assert.deepEqual(wiring.tools, expected.tools, `${entry.script} 向模型暴露的工具集必须与 console 相同`);
    assert.equal(wiring.maxToolRounds, expected.maxToolRounds, `${entry.script} 的轮数上限必须与 console 相同`);
    assert.deepEqual(wiring.permissions, expected.permissions, `${entry.script} 的工具权限必须与 console 相同`);
    // T5-F3 is part of the same wiring: the reply filter needs the deployment language, not a
    // hard-coded one, and every entry has to say which language it configured.
    assert.equal(wiring.language, config.identity.language, `${entry.script} 的回复过滤语言必须来自部署配置`);
  }
});

test('文字 CLI 的离线分支真的执行工具，而不是只把链打印出来', { timeout: SPAWN_TIMEOUT_MS }, async () => {
  const root = tempDir('xixi-t2-chat-');
  try {
    const child = spawn(process.execPath, ['scripts/chat.ts', '--fake'], {
      cwd: REPO_ROOT,
      env: { ...process.env, XIXI_CHAT_DATA_DIR: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stdin.write('现在几点了\n明天天气怎么样\n');
    child.stdin.end();
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));

    assert.equal(status, 0, `chat.ts --fake 应当 exit 0：\n${out}`);
    assert.match(out, /\[tool\] xixi_get_current_time ok/, '时钟工具真的跑了');
    assert.match(out, /\[tool\] xixi_get_weather ok/, '天气工具真的跑了（离线数据源，不联网）');
    // The answers are the *tool results* in words, which only the tool loop can produce. The
    // pre-t14 fake answered every turn with 「模拟回复：<用户的话>」.
    assert.match(out, /西西：今天是 /, '时钟那一轮的回答来自工具结果');
    assert.match(out, /西西：明天成都/, '天气那一轮的回答来自工具结果');
    assert.doesNotMatch(out, /模拟回复：(现在几点了|明天天气怎么样)/, '接了注册表的 fake 分支不该退回无工具的脚本回复');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('真人感评测的离线跑真的执行工具，工具结果进了报告', { timeout: SPAWN_TIMEOUT_MS }, async () => {
  const outDir = tempDir('xixi-t2-realism-');
  try {
    const result = await run('scripts/eval-realism.ts', ['--fake', '--label', 't2-wiring', '--out', outDir]);
    assert.equal(result.status, 0, `eval-realism --fake 应当 exit 0：\n${result.out}`);
    assert.match(result.out, /\[tool\] xixi_get_weather ok/, '黄金用例 G09「明天下雨不？」必须真的走天气工具');

    const printed = /报告：(.+\.md)/.exec(result.out);
    assert.ok(printed !== null, `stdout 必须打印报告路径：\n${result.out}`);
    const jsonPath = (printed[1] as string).trim().replace(/\.md$/, '.json');
    const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as { rounds: { scenario: string; reply: string | null }[] };
    const g09 = report.rounds.filter((round) => round.scenario === 'G09' && round.reply !== null).map((round) => round.reply);
    assert.ok(g09.length > 0, 'G09 必须留下至少一条回复');
    assert.ok(
      g09.some((reply) => (reply as string).includes('成都')),
      `G09 的回答应当来自天气工具（离线数据源）：${JSON.stringify(g09)}`,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('对话评测的离线跑真的执行工具', { timeout: SPAWN_TIMEOUT_MS }, async () => {
  const outDir = tempDir('xixi-t2-conv-');
  try {
    // `--out` keeps a judged run from adding a file under `docs/recon/` by accident; this run only
    // prints evidence, but the flag is the reason the test can drive the entry at all.
    const result = await run('scripts/eval-conversation.ts', ['--fake', `--out=${outDir}`]);
    assert.equal(result.status, 0, `eval-conversation --fake 应当 exit 0：\n${result.out}`);
    assert.match(result.out, /\[tool\] xixi_get_weather ok/, '语料里的天气轮必须真的走天气工具');
    assert.match(result.out, /"reply": "明天成都/, '逐轮记录里的回答来自工具结果，不是无工具脚本回复');
  } finally {
    rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});
