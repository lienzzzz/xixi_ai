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
 * V0.3 P0-A note: the callers now import `buildToolChain` / `CONVERSATION_SCOPE` from
 * `@xixi/runtime`; `scripts/field-test.ts` re-exports them as aliases of the runtime's own
 * declarations (see its compatibility surface). The expected side of this test deliberately keeps
 * importing them from `scripts/field-test.ts`, which makes this file the regression test for that
 * compatibility surface — if it ever loses the symbols, this test fails to even load.
 *
 * V0.3 P2.5-C note: the four entries now take their chain from the resident assembly point
 * (`createResidentRuntime`), so the plugin's tools are in it as well. The **plugin half of the
 * expectation comes from the plugin's own exported names** (`NEWS_SEARCH_TOOL` …), never from a
 * copied list, and `plugins.mounted` (the start report's own record of what the kernel mounted) has to
 * agree with it — a report that listed tools nobody mounted would fail here.
 *
 * Run: `npm run test:console` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CONVERSATION_SCOPE, buildToolChain } from '../../scripts/field-test.ts';
import { FakeBrainAdapter } from '@xixi/brain-adapter';
import type { InlinePlugin } from '@xixi/plugins';
import { NEWS_FOR_INTERESTS_TOOL, NEWS_LATEST_TOOL, NEWS_SEARCH_TOOL } from '@xixi/plugins/news';
import { CONVERSATION_SCOPE as RUNTIME_SCOPE, buildToolChain as runtimeBuildToolChain } from '@xixi/runtime';
import { REPO_ROOT, loadConfig } from '../../scripts/lib/harness.ts';

/** The four entries T5-F1 named, each with the name it prints in its own wiring report. */
const ENTRIES = [
  { name: 'chat', script: 'scripts/chat.ts' },
  { name: 'voice-device-check', script: 'scripts/voice-device-check.ts' },
  { name: 'eval-realism', script: 'scripts/eval-realism.ts' },
  { name: 'eval-conversation', script: 'scripts/eval-conversation.ts' },
] as const;

/**
 * 插件 `xixi.news` 贡献的三个工具，按它自己的登记顺序（`createNewsTools` 依次登记 search → latest →
 * for_interests，`mountPluginTools` 按同一顺序复制进链）。
 *
 * 名字取自 `@xixi/plugins/news` 的导出常量而不是抄一份字面量：插件里改名时这条期望跟着动，
 * 而 `plugins.mounted` 会把「报告里的工具集」与「内核这次真的挂了什么」钉在一起。
 */
const NEWS_TOOLS = [NEWS_SEARCH_TOOL, NEWS_LATEST_TOOL, NEWS_FOR_INTERESTS_TOOL] as const;

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

test('四个 live 入口报告的工具链与 console 是同一条（含插件提供的新闻工具）', { timeout: SPAWN_TIMEOUT_MS }, async () => {
  const config = loadConfig();
  const consoleChain = buildToolChain(config);
  const builtIns = consoleChain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name);
  const expected = {
    maxToolRounds: consoleChain.maxToolRounds,
    // 内核的三个内置 + 插件挂上来的三个（P2.5-C：链由常驻装配点给，插件工具真的在链上）。
    tools: [...builtIns, ...NEWS_TOOLS],
    permissions: {
      ...Object.fromEntries(consoleChain.names().map((name) => [name, consoleChain.check(name, CONVERSATION_SCOPE).verdict])),
      // 新闻工具是 read、声明在 conversation 作用域，而这个部署没有声明任何审批（`tools.approval.ask` 为空）。
      ...Object.fromEntries(NEWS_TOOLS.map((name) => [name, 'allow'])),
    },
  };
  // A sanity check on the expectation itself: if the console ever stops exposing the built-ins, the
  // four comparisons below would all trivially agree on an empty set.
  assert.equal(builtIns.length, 3, 'console 的内置工具集应当是三个（pack Phase 2，P2-D 起新闻改由插件提供）');
  assert.equal(expected.maxToolRounds, 4, '轮数上限由注册表钳制（pack Phase 2）');
  // V0.3 P0-A: name them. Until this line the four comparisons could still all agree on the
  // *wrong* tools; the extraction moved the assembly point, so the built-in set itself is
  // part of what "the same chain" means.
  assert.deepEqual(
    builtIns,
    ['xixi_get_current_time', 'xixi_get_weather', 'xixi_set_reminder'],
    '内置工具集就是这三个（pack Phase 2；新闻不是内置工具了）',
  );
  assert.deepEqual(
    Object.fromEntries(consoleChain.names().map((name) => [name, consoleChain.check(name, CONVERSATION_SCOPE).verdict])),
    {
      xixi_get_current_time: 'allow',
      xixi_get_weather: 'allow',
      xixi_set_reminder: 'allow',
    },
    '三个内置工具的权限判定（会话作用域）',
  );

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
    // P2.5-C：这三个工具是**插件挂上来的**，不是写死在入口里的清单 —— `plugins.mounted` 是那次
    // `start()` 自己的记录，与上面的 `tools` 必须对得上（工具集与挂载记录各写一份就会在这里红）。
    const plugins = wiring.plugins as { mounted?: unknown; skipped?: unknown; refused?: unknown } | undefined;
    assert.ok(plugins !== undefined, `${entry.script} 的报告必须带插件层的实况（P2.5-C）`);
    assert.deepEqual(plugins.mounted, [...NEWS_TOOLS], `${entry.script} 的新闻工具必须来自插件的那次挂载`);
    assert.deepEqual(plugins.skipped, [], `${entry.script}：内置工具名没有被插件覆盖`);
    assert.deepEqual(plugins.refused, [], `${entry.script}：这条链上没有工具被权限政策拒绝`);
  }
});

/**
 * P2.5-C 的「离线」是**结构性**的，不是「这次恰好没发生」：四个入口的 `--print-wiring` 都不许
 * 建库（报告路径用的是一次性内存库 `:memory:`）。
 *
 * 判据是可观察的：把一个**不存在**的数据目录交给它们（`XIXI_DATA_DIR` 是 household 的总开关，
 * 三个 legacy 变量是各自的开关），跑完之后那个目录仍然不存在。一个真的打开了库的实现会在
 * `openXixiStore` 里 `mkdirSync` 出它，于是这条立刻红。
 *
 * 同一条用例顺手钉住「无密钥也能 exit 0」：`MIMO_API_KEY` 显式给空串（`.env` 因此不会把它补回来），
 * 所以任何真的构造/调用直连模型的实现都会在这一步露馅。
 */
test('四个入口的 --print-wiring 不建库、不要密钥（P2.5-C）', { timeout: SPAWN_TIMEOUT_MS }, async () => {
  const dir = tempDir('xixi-wiring-nostore-');
  rmSync(dir, { recursive: true, force: true });
  try {
    assert.equal(existsSync(dir), false, '判据本身要先成立：这个目录起点是不存在的');
    for (const entry of ENTRIES) {
      const result = await run(entry.script, ['--print-wiring'], {
        XIXI_DATA_DIR: dir,
        XIXI_CHAT_DATA_DIR: dir,
        XIXI_VOICE_DATA_DIR: dir,
        MIMO_API_KEY: '',
      });
      assert.equal(result.status, 0, `${entry.script} --print-wiring 必须在无密钥下 exit 0：\n${result.out}`);
      assert.equal(existsSync(dir), false, `${entry.script} --print-wiring 不得建库（数据目录不该被创建）：${dir}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

// V0.3 P0-A: the compatibility surface in `scripts/field-test.ts` must keep handing out the *same*
// runtime declarations, not a second copy — an alias that silently pointed at a re-implementation
// would let the console drift from the package. `CONVERSATION_SCOPE` is a primitive, so the value
// comparison is the whole story there; the identity assertion is what makes the expectation above
// a guard on the old import path: if the alias ever went missing, this test cannot even load.
test('P0-A：field-test 的兼容表面与 @xixi/runtime 是同一份声明', () => {
  assert.equal(buildToolChain, runtimeBuildToolChain, 'buildToolChain 的兼容导出必须与包导出是同一个函数');
  assert.equal(CONVERSATION_SCOPE, RUNTIME_SCOPE, 'Conversation scope 的兼容导出必须与包导出是同一个值');
  assert.equal(CONVERSATION_SCOPE, 'conversation');
  // The two are the same object, so this pass is guaranteed *today* — it exists to fail the day
  // someone replaces the alias with a re-implementation that has drifted from the package.
  const viaPackage = runtimeBuildToolChain(loadConfig());
  assert.deepEqual(
    buildToolChain(loadConfig()).listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name),
    viaPackage.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name),
    '两条路径必须给出同一套工具',
  );
});

/**
 * V0.3 P2.5-B：试用页那条链也是装配点给的（`scripts/serve-chat.ts` 的 `createTrialRuntime`
 * → `createResidentRuntime`），所以「启用插件之后这个页面仍然跑得完一轮文字对话」要有一条证据。
 *
 * 用的是**入口自己的装配函数**（不是测试里另写一份装配），只多传两样：一个 inline 插件、一个离线
 * 替身模型。名字选 `news.latest` 是因为替身看到「新闻」就会请求它 —— 于是这一轮把整条路走通：
 * 插件在 `start()` 里挂进链 → 模型请求 → 核心执行 → 回复来自插件工具的载荷。
 */
test('试用页：启用插件后跑得完一轮文字对话，插件工具真的被执行（P2.5-B）', async () => {
  const page = await import('../../scripts/serve-chat.ts');
  const calls = { count: 0 };
  const newsPlugin: InlinePlugin = {
    manifest: { schemaVersion: 1, id: 'xixi.test-news', name: 'xixi.test-news', version: '0.1.0', permissions: ['tool.register'], capabilities: ['tool'] },
    module: {
      activate: () => ({
        tools: [
          {
            tool: {
              name: 'news.latest',
              description: '用例插件提供的头条（离线、无网络）',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
              risk: 'read',
              scopes: ['conversation'],
              async execute() {
                calls.count += 1;
                return { items: [{ title: '插件头条' }] };
              },
            },
          },
        ],
      }),
    },
  };
  const trial = page.createTrialRuntime({
    plugins: { inline: [newsPlugin] },
    model: ({ toolChain }) => new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE }),
  });
  try {
    assert.equal(trial.state, 'created');
    await trial.start();
    assert.equal(trial.state, 'started');
    assert.deepEqual(
      trial.toolChain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name).sort(),
      ['news.latest', 'xixi_get_current_time', 'xixi_get_weather', 'xixi_set_reminder'].sort(),
      '插件工具必须挂在这一页的那条链上（模型可见）',
    );
    // 入口自己那个运行时（模块级）也走同一个装配函数：链就是它的注册表。
    assert.equal(page.runtime.toolChain, page.runtime.plugins.registry);

    const session = trial.store.createSession();
    const turn = await trial.conversation.respond({ sessionId: session.sessionId, text: '有什么新闻？', addressed: true });
    assert.equal(turn.accepted, true);
    assert.equal(turn.toolName, 'news.latest', `这一轮必须走插件工具，实际 ${String(turn.toolName)}`);
    assert.match(String(turn.text), /插件头条/, `回复必须来自插件工具的载荷：${String(turn.text)}`);
    assert.equal(calls.count, 1, '插件工具必须真的被执行了一次');
  } finally {
    await trial.stop();
    assert.deepEqual(trial.toolChain.names(), [], '关停之后链应当被清空（插件工具真的撤下来了）');
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
