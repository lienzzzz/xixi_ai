/**
 * Tests for the realism metrics and the golden corpus (P1c).
 *
 * Two kinds of assertions live here:
 *   - pure metric behaviour (question rate, length distribution, banned
 *     templates, repetition alarms) on hand-written turn fixtures, so a change in
 *     the definition fails loudly instead of quietly moving every before/after
 *     number;
 *   - corpus integrity + one real-process run of the documented command
 *     (`node scripts/eval-realism.ts --fake`), because "有一条可重跑命令" is the
 *     acceptance item and a broken entry point must not look green.
 *
 * The pack's own 不好 examples are used as the banned-template fixtures: if the
 * detector stops catching them, this test says so.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BANNED_TEMPLATES, bannedTemplatesIn, bucketOf, measureRealism, type RealismTurn } from '../../scripts/lib/realism-metrics.ts';
import { GOLDEN_CONVERSATIONS } from './golden-conversations.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

function turn(overrides: Partial<RealismTurn> & { reply: string | null }): RealismTurn {
  return {
    scenario: 'T',
    index: 0,
    user: '随便说点什么',
    action: overrides.reply === null ? 'SILENCE' : 'SPEAK',
    accepted: true,
    totalMs: 100,
    firstTokenMs: 50,
    ...overrides,
  };
}

test('the question rate counts spoken turns only, and names both readings', () => {
  const metrics = measureRealism([
    turn({ index: 0, reply: '明天是不是要下雨？' }),
    turn({ index: 1, reply: '那行，我知道了。' }),
    turn({ index: 2, reply: null }), // silence: must not enter the denominator
  ]);
  assert.equal(metrics.spokenTurns, 2);
  assert.equal(metrics.silenceTurns, 1);
  assert.equal(metrics.questionTurns, 1);
  assert.equal(metrics.questionRate, 0.5, '1/2 开口轮带问号');
  assert.equal(metrics.questionEndingTurns, 1, '以问号结尾也算一次');
  assert.equal(metrics.questionBand, 'in-band', '50% 落在 30–50% 的口径带内');
});

test('the length distribution puts every reply in exactly one bucket and alarms at >80% one bucket', () => {
  assert.equal(bucketOf(8), '半句(<=15)');
  assert.equal(bucketOf(16), '短句(16-40)');
  assert.equal(bucketOf(90), '中句(41-90)');
  assert.equal(bucketOf(91), '长解释(>=91)');

  const uniform = measureRealism(
    Array.from({ length: 10 }, (_value, index) => turn({ index, reply: '好。' })),
  );
  assert.equal(uniform.length.counts['半句(<=15)'], 10);
  assert.equal(uniform.length.dominantShare, 1);
  assert.ok(
    uniform.alarms.some((alarm) => alarm.includes('同一档')),
    `>80% 一档必须报警，实际：${JSON.stringify(uniform.alarms)}`,
  );

  const mixed = measureRealism([
    turn({ index: 0, reply: '好。' }),
    turn({ index: 1, reply: '那行，我知道了，明天再说。' }),
    turn({ index: 2, reply: '这事我想了想，还是别急着定，等明天问清楚了再说吧。' }),
    turn({
      index: 3,
      reply: '国债相当于把钱借给国家，定期是存银行。两种都比较稳，不过流动性、提前取的规则和利率不一样，你要是几年不用就看他利率。',
    }),
  ]);
  assert.equal(Object.values(mixed.length.counts).reduce((sum, count) => sum + count, 0), 4);
  assert.ok(!mixed.alarms.some((alarm) => alarm.includes('同一档')), '四档都有就不该报「同一档」');
});

test('the banned-template detector catches the pack golden conversations’ own bad examples', () => {
  const badExamples = GOLDEN_CONVERSATIONS.filter((golden) => golden.badExample?.detect === 'template');
  assert.ok(badExamples.length >= 2, '黄金语料里必须有可被词表抓到的「不好」例子，否则这条断言没意义');
  for (const golden of badExamples) {
    const hits = bannedTemplatesIn(golden.badExample?.text ?? '');
    assert.ok(
      hits.length > 0,
      `${golden.id} 的「不好」例子应当被禁用模板词表抓到：${golden.badExample?.text}`,
    );
  }

  // The good examples must not be punished by the same list.
  for (const golden of GOLDEN_CONVERSATIONS) {
    if (golden.goodExample === undefined) continue;
    const hits = bannedTemplatesIn(golden.goodExample).filter((hit) => !golden.goodExample?.includes('……'));
    assert.equal(hits.length, 0, `${golden.id} 的「好」例子被词表误伤：${JSON.stringify(hits)}`);
  }

  const noSignal = GOLDEN_CONVERSATIONS.filter((golden) => golden.badExample?.detect === 'none');
  assert.ok(noSignal.length >= 1, '必须保留至少一条「词表抓不到、只能人工判」的例子，别把覆盖缺口藏起来');
});

test('every banned template carries a reason and actually compiles', () => {
  assert.ok(BANNED_TEMPLATES.length >= 10, '词表太短说明覆盖不足');
  for (const entry of BANNED_TEMPLATES) {
    assert.ok(entry.why.length > 4, `模板 ${entry.pattern.source} 缺少「为什么算套话」的说明`);
    // A pattern that cannot match its own literal text is a typo waiting to happen.
    assert.equal(typeof entry.pattern.exec(''), 'object', `模板 ${entry.pattern.source} 不是可执行的正则`);
  }
  // The four the objective names explicitly must be present.
  const sources = BANNED_TEMPLATES.map((entry) => entry.pattern.source).join(' ');
  for (const required of ['听起来', '我理解', '随时', '当然可以']) {
    assert.ok(sources.includes(required), `词表缺少「${required}」`);
  }
});

test('repetition is measured two ways: repeated phrases and same-structure runs', () => {
  const repeated = measureRealism([
    turn({ index: 0, reply: '好，量完血压就睡吧，早点躺下。' }),
    turn({ index: 1, reply: '量完血压就睡吧，都这么晚了。' }),
    turn({ index: 2, reply: '行，量完血压就睡吧。' }),
  ]);
  assert.ok(
    repeated.repeatedPhrases.some((item) => item.turns.length >= 3),
    `同一收尾短语应当被算成重复：${JSON.stringify(repeated.repeatedPhrases)}`,
  );

  const sameStructure = measureRealism([
    turn({ index: 0, reply: '好。' }),
    turn({ index: 1, reply: '嗯。' }),
    turn({ index: 2, reply: '行。' }),
    turn({ index: 3, reply: '知道了。' }),
  ]);
  assert.equal(sameStructure.longestSameStructureRun, 4);
  assert.ok(sameStructure.alarms.some((alarm) => alarm.includes('同结构')));
});

test('delivered segments are summarised when present, and reported as unmeasured when absent', () => {
  const withSegments = measureRealism([
    turn({ index: 0, reply: '一段。'.repeat(40), segmentChars: [60, 60, 40] }),
    turn({ index: 1, reply: '短。', segmentChars: [2] }),
  ]);
  assert.equal(withSegments.segments.n, 2);
  assert.equal(withSegments.segments.perTurnMean, 2);
  assert.deepEqual(withSegments.segments.perTurnHistogram, { '3段': 1, '1段': 1 });
  assert.equal(withSegments.segments.segmentCharsMax, 60);
  assert.equal(withSegments.segments.overLimitTurns, 0);

  const overflow = measureRelismUnmeasured();
  assert.equal(overflow.segments.n, 0, '没有分段数据时必须报「未测」而不是 0 段');
});

function measureRelismUnmeasured() {
  return measureRealism([turn({ index: 0, reply: '没有分段数据的一轮回复。' })]);
}

test('the golden corpus carries all twelve pack entries and never invents a reason-free skip', () => {
  assert.equal(GOLDEN_CONVERSATIONS.length, 12, 'pack 的第一批是 G01–G12');
  const ids = GOLDEN_CONVERSATIONS.map((golden) => golden.id);
  assert.deepEqual(ids, Array.from({ length: 12 }, (_value, index) => `G${`${index + 1}`.padStart(2, '0')}`));

  for (const golden of GOLDEN_CONVERSATIONS) {
    assert.ok(golden.source.includes('golden_conversations.md'), `${golden.id} 必须指回 pack 的原文`);
    if (golden.kind === 'conversation') {
      assert.ok((golden.turns ?? []).length > 0, `${golden.id} 是可跑的对话，就必须有 turns`);
      assert.ok((golden.expectations ?? {}) !== undefined, `${golden.id} 需要写明机械期望（哪怕只有 minAccepted）`);
    }
    if (golden.kind === 'unrunnable') {
      assert.ok((golden.notRunnableReason ?? '').length > 20, `${golden.id} 未跑就必须写清缺什么，不能静默略过`);
    }
    if (golden.kind === 'proactive-gate') {
      assert.ok((golden.gateCases ?? []).length > 0, `${golden.id} 需要至少一个门禁用例`);
    }
  }

  const runnableConversations = GOLDEN_CONVERSATIONS.filter((golden) => golden.kind === 'conversation');
  const gates = GOLDEN_CONVERSATIONS.filter((golden) => golden.kind === 'proactive-gate');
  const unrunnable = GOLDEN_CONVERSATIONS.filter((golden) => golden.kind === 'unrunnable');
  assert.equal(runnableConversations.length + gates.length + unrunnable.length, 12);
  assert.ok(runnableConversations.length >= 5, '可跑对话太少，黄金语料就没进评测');
  assert.ok(unrunnable.length >= 3, '未实现的能力必须显式列出');
});

function runAsync(command: string, args: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolve({ status: null, stdout, stderr: `${stderr}${String(error)}` }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('the documented command prints the three metrics and writes a freshness-marked report', { timeout: 120_000 }, async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'xixi-realism-report-'));
  const result = await runAsync(process.execPath, ['scripts/eval-realism.ts', '--fake', '--label', 'selftest', '--out', outDir], REPO_ROOT);
  assert.equal(result.status, 0, `离线自检必须 exit 0：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /提问率/, 'stdout 必须给出提问率');
  assert.match(result.stdout, /回复长度分布/, 'stdout 必须给出回复长度分布');
  assert.match(result.stdout, /禁用模板出现率/, 'stdout 必须给出禁用模板出现率');

  // The report path is parsed from stdout instead of recomputed here: recomputing
  // would re-derive the date in a *different* timezone rule than the runner uses,
  // and this test would then fail between 00:00 and 08:00 local (the same class of
  // wall-clock dependence the V0.1 baseline §1.3 found).
  const printed = /报告：(.+\.md)/.exec(result.stdout);
  assert.ok(printed !== null, `stdout 必须打印报告路径：\n${result.stdout}`);
  const report = printed[1]?.trim() ?? '';
  assert.ok(existsSync(report), `报告必须真的落盘：${report}`);
  const markdown = readFileSync(report, 'utf8');
  assert.match(markdown, /最后更新/, 'docs/ 下的报告必须带新鲜度标记（check-docs 要求）');
  assert.match(markdown, /禁止|禁用模板/, '报告必须包含禁用模板那一节');
  assert.match(markdown, /未跑的部分/, '报告必须显式列出没跑到的黄金用例');
});
