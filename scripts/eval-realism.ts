/**
 * Realism evaluation (P1c): run the golden corpus from
 * `xixi_v02_refactor_pack/tests/golden_conversations.md` plus the repo corpus
 * through the real conversation engine, and print the three numbers that decide
 * whether "真人感" actually improved:
 *
 *   1. 提问率（含问号 / 以问号结尾两个口径，参考带宽 30–50%）
 *   2. 回复长度分布（半句 / 短句 / 中句 / 长解释 + 「>80% 同一档」警报）
 *   3. 禁用模板出现率（「听起来 / 我理解 / 随时告诉 / 当然可以 / 如果还有什么…」）
 *
 * Usage:
 *   node scripts/eval-realism.ts                       # 黄金语料，真实 MiMo，写报告
 *   node scripts/eval-realism.ts --label v01           # 给这次运行起个名字（前后对比用）
 *   node scripts/eval-realism.ts --corpus=all          # 黄金 + 仓库既有语料
 *   node scripts/eval-realism.ts --corpus=all --repeat=3   # 同语料跑 3 次（样本小，必须看抖动）
 *   node scripts/eval-realism.ts --fake                # 离线替身（只验证管线，结论不采信）
 *   node scripts/eval-realism.ts --no-gate             # 只测量：有违规也 exit 0
 *   node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-09-30-v01.json
 *                                                      # 不调用模型，从保存的原文复算指标
 *
 * Design notes:
 *   * 指标定义在 scripts/lib/realism-metrics.ts，**只此一份**，前后对比不会各说各话。
 *   * 「未实现的能力」不假装通过：G03/G08/G10（OpenThread / news 插件 / 打断）留在语料里，
 *     报告里写明缺什么，算作未测而不是静默略过。
 *   * 主动门禁的黄金用例（G07/G12）用固定时钟跑，与机器当前时间无关——V0.1 的
 *     quiet_hours 教训（见 docs/benchmarks/v01-baseline.md §1.3）不该在这里重演。
 *   * A/B（pack §11 要的「同 corpus 同 model」）：改造前的数字要么引用
 *     docs/benchmarks/v01-baseline.md（20 轮会话语料），要么**在一个只读的 V0.1 工作树里**
 *     跑本脚本；绝不要把别人在途改动的**脏工作区**当成「改造前」。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBrainAdapter, MimoBrainAdapter, defaultTools, type BrainAdapter } from '@xixi/brain-adapter';
import { ConversationEngine, evaluateProactiveGates, parseProactiveSettings, resolveReplyLimits, splitReplyIntoSegments, type ProactiveGateContext } from '@xixi/conversation';
import { openXixiStore } from '@xixi/domain';

import { CORPUS, FORBIDDEN_PATTERNS, type Scenario } from '../tests/scenarios/corpus.ts';
import { GOLDEN_CONVERSATIONS, type GoldenConversation } from '../tests/scenarios/golden-conversations.ts';
import { REPO_ROOT, loadConfig, printEvidence, readDotEnv } from './lib/harness.ts';
import {
  bannedTemplatesIn,
  formatPercent,
  measureRealism,
  replyChars,
  type RealismMetrics,
  type RealismTurn,
} from './lib/realism-metrics.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const args = process.argv.slice(2);
/** Accepts both `--name=value` and `--name value`, because both get typed in practice. */
const flag = (name: string): string | null => {
  const withValue = args.find((argument) => argument.startsWith(`--${name}=`));
  if (withValue !== undefined) return withValue.slice(name.length + 3);
  const spaced = args.indexOf(`--${name}`);
  if (spaced >= 0) {
    const next = args[spaced + 1];
    if (next !== undefined && !next.startsWith('--')) return next;
  }
  return null;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const useFake = has('fake');
const noGate = has('no-gate');
const corpusChoice = flag('corpus') ?? 'golden';
const repeat = Math.max(1, Math.min(10, Number(flag('repeat') ?? '1') || 1));
const label = flag('label') ?? (useFake ? 'fake' : 'run');
const replayPath = flag('replay');
const outDir = flag('out') ?? join(REPO_ROOT, 'docs', 'benchmarks');
/** Offline plumbing cannot speak to wording, so quality checks are skipped (not passed). */
const QUALITY_CHECKS = !useFake;

function localDate(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function revision(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Uncommitted files at run time, split into "production behaviour can differ"
 * (`packages/`, `apps/`, `config/`, `services/`) and "tooling/corpus only". A
 * metric run against a dirty tree is a snapshot of *that* tree, not of the
 * revision — without this line a before/after comparison can silently compare
 * the wrong two things.
 */
function dirtyState(): { all: string[]; production: string[] } {
  const all = (() => {
    try {
      return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  })();
  const production = all.filter((line) => /(^|\s)(packages|apps|config|services)\//.test(line));
  return { all, production };
}

interface Violation {
  readonly scenario: string;
  readonly turn: number;
  readonly check: string;
  readonly detail: string;
}

interface RoundRecord extends RealismTurn {
  readonly reply: string | null;
  readonly model: string;
  /** Delivered segments (ADR-0010), recorded so "长解释是 3 大块还是 8 小块" survives replay. */
  readonly segmentChars?: readonly number[] | undefined;
}

interface GateOutcome {
  readonly golden: string;
  readonly caseId: string;
  readonly description: string;
  readonly expected: string;
  readonly actual: string;
  readonly passed: boolean;
}

interface SkippedEntry {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
}

interface RepeatSummary {
  readonly run: number;
  readonly turns: number;
  readonly spokenTurns: number;
  readonly questionRate: number;
  readonly bannedTemplateRate: number;
  readonly silenceRate: number;
  readonly charsP50: number;
  readonly charsMax: number;
  /** Within this run only — pooling repeats would manufacture fake repetition. */
  readonly repeatedPhrases: number;
}

interface RunResult {
  readonly label: string;
  readonly date: string;
  readonly revision: string;
  readonly repeat: number;
  /** `git status --porcelain` at run time: a dirty tree means "snapshot of the tree". */
  readonly treeDirty: readonly string[];
  /** Subset of `treeDirty` that can change conversation behaviour. */
  readonly productionDirty: readonly string[];
  readonly adapter: string;
  readonly model: string;
  readonly corpus: string;
  readonly qualityChecks: boolean;
  readonly rounds: readonly RoundRecord[];
  readonly gates: readonly GateOutcome[];
  readonly skipped: readonly SkippedEntry[];
  readonly violations: readonly Violation[];
  readonly metrics: RealismMetrics;
  /** Per-repetition rates, so the run-to-run spread is visible instead of hidden in one number. */
  readonly perRepeat: readonly RepeatSummary[];
}

const config = loadConfig();
const settings = parseProactiveSettings(config.proactive as unknown as Record<string, unknown>);
const dataDir = mkdtempSync(join(tmpdir(), 'xixi-realism-'));

function makeAdapter(): BrainAdapter {
  if (useFake) return new FakeBrainAdapter();
  return new MimoBrainAdapter({
    maxCompletionTokens: 400,
    tools: defaultTools({ defaultPlace: config.identity.place ?? '' }),
    timezone: config.identity.timezone,
  });
}

/** One scenario = one fresh store + session, so runs do not leak into each other. */
async function runScenario(
  id: string,
  turns: readonly { user: string; addressed?: boolean }[],
  personality?: Readonly<Record<string, number>>,
  /**
   * Scenario-specific setup that must happen *before* a turn (the repo corpus's
   * `quiet-mode` needs `engine.quiet()`), mirroring `scripts/eval-conversation.ts`
   * so the same corpus means the same thing in both runners.
   */
  before?: (index: number, engine: ConversationEngine) => void,
): Promise<{ rounds: RoundRecord[]; violations: Violation[]; replyChars: number[] }> {
  const store = openXixiStore({ dataDir });
  const adapter = makeAdapter();
  const engine = new ConversationEngine({ adapter, store, config, turnTimeoutMs: 90_000 });
  store.seedSelfProfile(config.personality.base);
  if (personality !== undefined) store.overrideSelfProfile(personality, `eval-realism:${id}`);
  const session = store.createSession();

  const rounds: RoundRecord[] = [];
  const violations: Violation[] = [];
  const chars: number[] = [];
  try {
    for (const [index, turn] of turns.entries()) {
      if (before !== undefined) before(index, engine);
      let result: Awaited<ReturnType<typeof engine.respond>> | null = null;
      try {
        result = await engine.respond({ sessionId: session.sessionId, text: turn.user, addressed: turn.addressed ?? index === 0 });
      } catch (error) {
        violations.push({
          scenario: id,
          turn: index,
          check: 'engine-error',
          detail: error instanceof Error ? error.message : String(error),
        });
        rounds.push({
          scenario: id,
          index,
          user: turn.user,
          action: 'ERROR',
          accepted: false,
          reply: null,
          model: 'n/a',
          totalMs: null,
          firstTokenMs: null,
        });
        continue;
      }
      rounds.push({
        scenario: id,
        index,
        user: turn.user,
        action: result.action,
        accepted: result.accepted,
        reply: result.text,
        segmentChars: result.segments.map((segment) => replyChars(segment)),
        model: result.model,
        totalMs: result.latencyMs,
        firstTokenMs: result.firstTokenMs,
      });
      if (!result.accepted || result.action !== 'SPEAK' || result.text === null) continue;
      chars.push(replyChars(result.text));
      if (QUALITY_CHECKS) {
        for (const forbidden of FORBIDDEN_PATTERNS) {
          if (forbidden.pattern.test(result.text)) {
            violations.push({
              scenario: id,
              turn: index,
              check: 'no-scaffolding-leak',
              detail: `${forbidden.why}: ${result.text.slice(0, 80)}`,
            });
          }
        }
      }
    }
  } finally {
    store.close();
  }
  return { rounds, violations, replyChars: chars };
}

function checkGoldenExpectations(
  golden: GoldenConversation,
  rounds: readonly RoundRecord[],
  chars: readonly number[],
): Violation[] {
  const violations: Violation[] = [];
  const expectations = golden.expectations ?? {};
  const accepted = rounds.filter((round) => round.accepted).length;
  const speaks = rounds.filter((round) => round.action === 'SPEAK').length;
  if (expectations.minAccepted !== undefined && accepted < expectations.minAccepted) {
    violations.push({ scenario: golden.id, turn: -1, check: 'min-accepted', detail: `接受 ${accepted} < ${expectations.minAccepted}` });
  }
  if (expectations.minSpeaks !== undefined && speaks < expectations.minSpeaks) {
    violations.push({ scenario: golden.id, turn: -1, check: 'min-speaks', detail: `开口 ${speaks} < ${expectations.minSpeaks}` });
  }
  for (const round of rounds) {
    if (round.action !== 'SPEAK' || round.reply === null) continue;
    if (expectations.forbidQuestion === true && /[？?]/.test(round.reply)) {
      violations.push({ scenario: golden.id, turn: round.index, check: 'no-question-expected', detail: `不该再追问：${round.reply.slice(0, 60)}` });
    }
    if (expectations.forbidBannedTemplate === true) {
      for (const hit of bannedTemplatesIn(round.reply)) {
        violations.push({ scenario: golden.id, turn: round.index, check: 'banned-template', detail: `命中「${hit.matched}」：${hit.why}` });
      }
    }
  }
  if (expectations.minChars !== undefined && chars.length > 0 && Math.max(...chars) < expectations.minChars) {
    violations.push({
      scenario: golden.id,
      turn: -1,
      check: 'knowledge-answer-length',
      detail: `最长回复 ${Math.max(...chars)} 字 < ${expectations.minChars}（知识问题被压成一句）`,
    });
  }
  return violations;
}

/**
 * Gate-level golden cases run on a fixed clock (2026-09-30 10:00 +08:00) so the
 * result never depends on when the machine happens to run the suite.
 */
function runGateCase(golden: GoldenConversation, caseIndex: number): { outcome: GateOutcome; violation: Violation | null } {
  const gateCase = (golden.gateCases ?? [])[caseIndex];
  if (gateCase === undefined) throw new Error(`${golden.id}: gate case ${caseIndex} missing`);
  const now = new Date('2026-09-30T10:00:00+08:00');
  const history =
    gateCase.deliveredMinutesAgo === null
      ? []
      : [
          {
            candidateId: 'previous-message',
            at: new Date(now.getTime() - gateCase.deliveredMinutesAgo * 60_000),
            topicRef: gateCase.deliveredTopicRef ?? null,
            sequence: 1,
          },
        ];
  const context: ProactiveGateContext = {
    settings,
    now,
    offsetMinutes: 480,
    proactivity: config.personality.base.proactivity,
    conversationState: 'IDLE',
    inFlightTurn: false,
    negativeFeedback: false,
    sceneAvailable: true,
    speechAvailable: true,
    history,
  };
  const result = evaluateProactiveGates(
    {
      candidateId: `${gateCase.id}-candidate`,
      trigger: gateCase.candidate.trigger as never,
      components: gateCase.candidate.components,
      topicRef: gateCase.candidate.topicRef ?? null,
    },
    context,
  );
  const passed = result.reasonCode === gateCase.expectedReasonCode;
  return {
    outcome: {
      golden: golden.id,
      caseId: gateCase.id,
      description: gateCase.description,
      expected: gateCase.expectedReasonCode,
      actual: result.reasonCode,
      passed,
    },
    violation: passed
      ? null
      : {
          scenario: golden.id,
          turn: -1,
          check: `gate:${gateCase.id}`,
          detail: `期望 ${gateCase.expectedReasonCode}，实际 ${result.reasonCode}（score ${result.score} vs 阈值 ${result.threshold}）`,
        },
  };
}

function v01Scenarios(): readonly Scenario[] {
  return CORPUS;
}

async function runAll(): Promise<RunResult> {
  const rounds: RoundRecord[] = [];
  const violations: Violation[] = [];
  const gates: GateOutcome[] = [];
  const skipped: SkippedEntry[] = [];
  const perRepeat: RepeatSummary[] = [];

  for (let run = 1; run <= repeat; run += 1) {
    const runStart = rounds.length;

    if (corpusChoice === 'golden' || corpusChoice === 'all') {
      for (const golden of GOLDEN_CONVERSATIONS) {
        if (golden.kind === 'unrunnable') {
          if (run === 1) skipped.push({ id: golden.id, title: golden.title, reason: golden.notRunnableReason ?? '（未写明原因）' });
          continue;
        }
        if (golden.kind === 'proactive-gate') {
          // Deterministic and free: the gate cases run once, not once per repetition.
          if (run > 1) continue;
          for (let index = 0; index < (golden.gateCases ?? []).length; index += 1) {
            const { outcome, violation } = runGateCase(golden, index);
            gates.push(outcome);
            if (violation !== null) violations.push(violation);
          }
          continue;
        }
        const turns = golden.turns ?? [];
        const result = await runScenario(golden.id, turns, golden.personality);
        rounds.push(...result.rounds);
        if (QUALITY_CHECKS) violations.push(...result.violations, ...checkGoldenExpectations(golden, result.rounds, result.replyChars));
        if (run === 1 && golden.notRunnableReason !== undefined) {
          skipped.push({ id: `${golden.id}(部分)`, title: golden.title, reason: golden.notRunnableReason });
        }
      }
    }

    if (corpusChoice === 'v01' || corpusChoice === 'all') {
      for (const scenario of v01Scenarios()) {
        const result = await runScenario(scenario.id, scenario.turns, scenario.personality, (index, engine) => {
          // Same seam as scripts/eval-conversation.ts: the quiet-mode scenario is
          // only quiet-mode if the engine is actually suspended.
          if (scenario.id === 'quiet-mode' && index === 1) engine.quiet();
        });
        rounds.push(...result.rounds);
        if (QUALITY_CHECKS) violations.push(...result.violations);
      }
    }

    const runMetrics = measureRealism(rounds.slice(runStart));
    perRepeat.push({
      run,
      turns: runMetrics.turns,
      spokenTurns: runMetrics.spokenTurns,
      questionRate: runMetrics.questionRate,
      bannedTemplateRate: runMetrics.bannedTemplateRate,
      silenceRate: runMetrics.silenceRate,
      charsP50: runMetrics.charsP50,
      charsMax: runMetrics.charsMax,
      repeatedPhrases: runMetrics.repeatedPhrases.length,
    });
  }

  const metrics = measureRealism(rounds);
  const adapter = useFake ? 'fake' : 'mimo-direct';
  const dirty = dirtyState();
  return {
    label,
    date: localDate(),
    revision: revision(),
    repeat,
    treeDirty: dirty.all,
    productionDirty: dirty.production,
    adapter,
    model: useFake ? 'fake-1' : 'mimo-v2.6-flash',
    corpus: corpusChoice,
    qualityChecks: QUALITY_CHECKS,
    rounds,
    gates,
    skipped,
    violations,
    metrics,
    perRepeat,
  };
}

function metricsBlock(metrics: RealismMetrics): string {
  const lines: string[] = [];  lines.push(`- 轮数：${metrics.turns}（接受 ${metrics.accepted}，拒绝 ${metrics.rejected}，开口 ${metrics.spokenTurns}，沉默 ${metrics.silenceTurns}）`);
  lines.push(
    `- **提问率**（含问号）：${metrics.questionTurns}/${metrics.spokenTurns} = **${formatPercent(metrics.questionRate)}**` +
      `（口径带 30–50%：${metrics.questionBand === 'below' ? '偏低' : metrics.questionBand === 'above' ? '偏高' : '在带内'}）；` +
      `以问号结尾：${metrics.questionEndingTurns}/${metrics.spokenTurns} = ${formatPercent(metrics.questionEndingRate)}`,
  );
  lines.push(
    `- **回复长度分布**（字）：P50 ${metrics.charsP50}，最大 ${metrics.charsMax}；` +
      Object.entries(metrics.length.counts)
        .map(([name, count]) => `${name} ${count}（${formatPercent(metrics.length.shares[name] ?? 0)}）`)
        .join('，'),
  );
  lines.push(
    `- **交付分段**（ADR-0010，n=${metrics.segments.n}）：每轮段数均值 ${metrics.segments.perTurnMean}，分布 ` +
      `${Object.entries(metrics.segments.perTurnHistogram).map(([name, count]) => `${name}×${count}`).join('、') || '未测'}；` +
      `单段字数 P50 ${metrics.segments.segmentCharsP50}、最长 ${metrics.segments.segmentCharsMax}；` +
      `${metrics.segments.overLimitTurns} 轮出现 >60 字的单段（V0.1 的溢出并入最后一段，P1 把它拆成更多小段）`,
  );
  lines.push(
    `- **禁用模板出现率**：${metrics.bannedTemplateTurns}/${metrics.spokenTurns} = **${formatPercent(metrics.bannedTemplateRate)}**` +
      (metrics.bannedTemplateHits.length === 0
        ? ''
        : `；命中：${metrics.bannedTemplateHits.map((hit) => `${hit.scenario}#${hit.index}「${hit.matched}」`).join('、')}`),
  );
  const phrases = metrics.repeatedPhrases;
  lines.push(
    `- 重复 6 字短语（跨 >=3 轮）：${
      phrases.length === 0
        ? '无'
        : `${phrases
            .slice(0, 8)
            .map((item) => `「${item.phrase}」`)
            .join('、')}（共 ${phrases.length} 条，全量在原始记录 JSON 里）`
    }` + `；最长同结构连续轮数：${metrics.longestSameStructureRun}`,
  );
  lines.push(`- pack §2.1 警报：${metrics.alarms.length === 0 ? '无' : metrics.alarms.join('；')}`);
  return lines.join('\n');
}

function repeatTable(result: RunResult): string {
  if (result.perRepeat.length <= 1) return '';
  const lines: string[] = [];
  lines.push('');
  lines.push(`### 1.1 逐次重复（同一语料跑 ${result.perRepeat.length} 次，看抖动）`);
  lines.push('');
  lines.push('| 第几次 | 轮数 | 开口 | 提问率 | 禁用模板率 | 沉默率 | 字数 P50 | 最大 | 重复短语（本次内） |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const run of result.perRepeat) {
    lines.push(
      `| ${run.run} | ${run.turns} | ${run.spokenTurns} | ${formatPercent(run.questionRate)} | ${formatPercent(run.bannedTemplateRate)} | ` +
        `${formatPercent(run.silenceRate)} | ${run.charsP50} | ${run.charsMax} | ${run.repeatedPhrases} |`,
    );
  }
  const rates = result.perRepeat.map((run) => Math.round(run.questionRate * 1000) / 10);
  lines.push('');
  lines.push(
    `提问率逐次：${rates.map((value) => `${value}%`).join(' / ')}（极差 ${Math.round((Math.max(...rates) - Math.min(...rates)) * 10) / 10} 个百分点）` +
      '——样本小的时候**单次数字不可信**，结论看汇总与极差。',
  );
  lines.push('');
  lines.push(
    '**注意**：汇总行的「重复 6 字短语」把 N 次运行当成一条流水，因此跨次重复也会被算进去（同一句天气问题被问 3 次必然重复）。' +
      '要判「同一段对话里反复用同一句话收尾」，看本表的「重复短语（本次内）」或直接用 `--repeat=1` 跑一次。',
  );
  return lines.join('\n');
}

/**
 * Markdown table cell for user/model text. Backticks are replaced because
 * `check-docs` treats `` `config/whatever.yaml` `` inside any docs/** file as a
 * repo reference — a model reply that happens to contain one must not turn a
 * generated report into a broken-docs failure.
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/`/g, '′');
}

function reportMarkdown(result: RunResult): string {  const lines: string[] = [];
  lines.push(`# 真人感指标评测（${result.label}，${result.date}）`);
  lines.push('');
  lines.push(`最后更新：${result.date}`);
  lines.push('');
  lines.push(
    `- 适配器：${result.adapter}（${result.model}）｜语料：${result.corpus}｜质量判定：${result.qualityChecks ? '开（真实调用）' : '关（--fake 只验证管线）'}`,
  );
  lines.push(`- 基线修订号：\`git rev-parse --short HEAD\` = ${result.revision}`);
  lines.push(
    result.productionDirty.length === 0
      ? result.treeDirty.length === 0
        ? '- 工作区：**干净**（这次数字属于上面那个修订号）'
        : `- 工作区：只有本任务新增的文件未提交（${result.treeDirty.length} 项，${result.treeDirty
            .map((line) => line.replace(/^\S+\s+/, ''))
            .filter((path) => /(^|\/)(scripts|tests|docs)\//.test(path))
            .slice(0, 8)
            .join('、')}）——**生产代码与修订号一致**`
      : `- 工作区：**生产代码有未提交改动**（${result.productionDirty.length} 项）——这次数字是**当时工作区**的快照，` +
        `不是修订号的数字；对比时先对齐工作区。改动：${result.productionDirty.map((line) => line.replace(/^\S+\s+/, '')).join('、')}`,
  );
  lines.push(`- 重跑命令：\`node scripts/eval-realism.ts --label ${result.label}\`${result.qualityChecks ? '' : ' --fake'}`);
  lines.push(
    `- 原始记录（复算用）：\`docs/benchmarks/realism-${result.date}-${result.label}.json\`；复算：` +
      `\`node scripts/eval-realism.ts --replay docs/benchmarks/realism-${result.date}-${result.label}.json\``,
  );
  lines.push('');
  lines.push('## 1. 指标（同一批语料，一次运行得出）');
  lines.push('');
  lines.push(metricsBlock(result.metrics));
  lines.push(repeatTable(result));
  lines.push('');
  lines.push('## 2. 黄金对话判定');
  lines.push('');
  lines.push('| 黄金 | 类型 | 判定 | 说明 |');
  lines.push('|---|---|---|---|');
  for (const golden of GOLDEN_CONVERSATIONS) {
    const rounds = result.rounds.filter((round) => round.scenario === golden.id);
    if (golden.kind === 'unrunnable') {
      lines.push(`| ${golden.id} ${golden.title} | 未跑 | 未测 | ${golden.notRunnableReason ?? ''} |`);
      continue;
    }
    if (golden.kind === 'proactive-gate') {
      for (const gate of result.gates.filter((outcome) => outcome.golden === golden.id)) {
        lines.push(
          `| ${golden.id} ${golden.title} | 主动门禁 | ${gate.passed ? '通过' : '**失败**'} | ${gate.caseId}：期望 ${gate.expected}，实际 ${gate.actual} |`,
        );
      }
      continue;
    }
    const violations = result.violations.filter((violation) => violation.scenario === golden.id);
    const speaks = rounds.filter((round) => round.action === 'SPEAK').length;
    lines.push(
      `| ${golden.id} ${golden.title} | 对话 | ${violations.length === 0 ? '通过' : `**失败 ${violations.length} 项**`} | 开口 ${speaks}/${rounds.length} 轮；${violations.map((violation) => violation.check).join('、') || '满足期望'} |`,
    );
  }
  lines.push('');
  lines.push('## 3. 逐轮原文（人工复审用）');
  lines.push('');
  lines.push('| 场景 | # | 用户 | 动作 | 字数 | 西西 |');
  lines.push('|---|---:|---|---|---:|---|');
  for (const round of result.rounds) {
    lines.push(
      `| ${round.scenario} | ${round.index} | ${cell(round.user)} | ${round.action} | ${round.reply === null ? '—' : replyChars(round.reply)} | ${round.reply === null ? '（无）' : cell(round.reply)} |`,
    );
  }
  lines.push('');
  lines.push('## 4. pack 的「好 / 不好」例子与检测器的覆盖情况');
  lines.push('');
  lines.push('| 黄金 | 不好例子 | 该由谁抓 | 实测 |');
  lines.push('|---|---|---|---|');
  for (const golden of GOLDEN_CONVERSATIONS) {
    const bad = golden.badExample;
    if (bad === undefined) continue;
    const templateHits = bannedTemplatesIn(bad.text).length;
    const scaffoldingHits = FORBIDDEN_PATTERNS.filter((entry) => entry.pattern.test(bad.text)).length;
    const detected =
      bad.detect === 'template'
        ? templateHits > 0
        : bad.detect === 'scaffolding'
          ? scaffoldingHits > 0
          : null;
    lines.push(
      `| ${golden.id} | ${bad.text.slice(0, 60)}… | ${bad.detect === 'template' ? '禁用模板词表' : bad.detect === 'scaffolding' ? '脚手架 FORBIDDEN_PATTERNS' : '**只能人工判**（词表抓不到）'} | ${
        detected === null ? '—' : detected ? '检出' : (bad.detect === 'template' ? `**漏检**（模板命中 ${templateHits}）` : `**漏检**（脚手架命中 ${scaffoldingHits}）`)
      }${bad.note === undefined ? '' : `（${bad.note}）`} |`,
    );
  }
  lines.push('');
  lines.push('## 5. 未跑的部分（不假装通过）');
  lines.push('');
  if (result.skipped.length === 0) {
    lines.push('无。');
  } else {
    lines.push('| 黄金 | 缺什么 |');
    lines.push('|---|---|');
    for (const entry of result.skipped) lines.push(`| ${entry.id} ${entry.title} | ${entry.reason} |`);
  }
  lines.push('');
  lines.push('## 6. 与 V0.1 基线的对比位');
  lines.push('');
  lines.push(
    '- V0.1（改造前）的口径数字见 `docs/benchmarks/v01-baseline.md`：提问率 50%（10 轮）/ 52.6%（20 轮）；' +
      '20 轮里 1段×3、2段×7、3段×9，最大 177 字；模板词表命中 0，但有「了，量完血压」式同句收尾。',
  );
  lines.push(
    '- 本节这次运行的数字就是**同口径的对照点**：改造后再跑一次 `node scripts/eval-realism.ts --label v02`，' +
      '把两份 `realism-*.json` 用 `--replay` 复算即可逐项对比（同一工具 = 同一定义）。',
  );
  lines.push('');
  lines.push('## 7. 判定与结论');
  lines.push('');
  if (!result.qualityChecks) {
    lines.push('- `--fake` 运行：离线替身对措辞没有发言权，**本次指标不作为行为结论**（只证明管线可用）。');
  } else if (result.violations.length === 0) {
    lines.push('- 黄金对话的机械期望全部满足，指标警报：' + (result.metrics.alarms.length === 0 ? '无。' : result.metrics.alarms.join('；')));
  } else {
    lines.push(`- **黄金对话机械期望未全部满足（${result.violations.length} 项）**：这是 P1 要修的东西，不是评测工具坏了。`);
    for (const violation of result.violations.slice(0, 20)) {
      lines.push(`  - [${violation.scenario}#${violation.turn}] ${violation.check}：${violation.detail}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  if (replayPath !== null) {
    const saved = JSON.parse(readFileSync(replayPath, 'utf8')) as RunResult;
    // Old recordings have no segment data: reconstruct it with *this revision's*
    // splitter, which is exactly what makes the replay an A/B instrument (run it
    // in the V0.1 worktree for V0.1 chunking, in the current tree for the new one).
    const limits = resolveReplyLimits(config.reply as unknown as Record<string, unknown>);
    const rounds = saved.rounds.map((round) =>
      (round.segmentChars ?? []).length > 0 || round.reply === null
        ? round
        : { ...round, segmentChars: splitReplyIntoSegments(round.reply, limits).segments.map((segment) => replyChars(segment)) },
    );
    const metrics = measureRealism(rounds);
    console.log(`复算 ${replayPath}（label=${saved.label}，adapter=${saved.adapter}，${rounds.length} 轮）`);
    console.log(metricsBlock(metrics));
    if (has('re-render')) {
      mkdirSync(outDir, { recursive: true });
      const base = join(outDir, `realism-${saved.date}-${saved.label}`);
      writeFileSync(`${base}.json`, JSON.stringify({ ...saved, rounds }, null, 2), 'utf8');
      writeFileSync(`${base}.md`, reportMarkdown({ ...saved, rounds, metrics }), 'utf8');
      console.log(`\n已用当前渲染器重写报告：${base}.md（原始记录同步为含分段数据的版本）`);
    } else {
      console.log('\n（只复算，不写文件；要重写报告加 --re-render）');
    }
    return;
  }

  void runAll().then((result) => {
    console.log(`\n=== 真人感指标（${result.label} / ${result.adapter} / corpus=${result.corpus}） ===`);
    console.log(
      `修订号 ${result.revision}｜生产代码${result.productionDirty.length === 0 ? '与修订号一致' : `有 ${result.productionDirty.length} 项未提交改动（属快照）`}`,
    );
    console.log(metricsBlock(result.metrics));
    if (result.perRepeat.length > 1) {
      console.log(repeatTable(result).replace(/^###[^\n]*\n\n/, '').trim());
    }
    if (result.gates.length > 0) {
      console.log('\n主动门禁黄金用例：');
      for (const gate of result.gates) {
        console.log(` - ${gate.golden} ${gate.caseId}：期望 ${gate.expected}，实际 ${gate.actual} → ${gate.passed ? '通过' : '失败'}`);
      }
    }
    if (result.violations.length > 0) {
      console.log(`\n黄金对话机械期望未满足 ${result.violations.length} 项：`);
      for (const violation of result.violations.slice(0, 20)) {
        console.log(` - [${violation.scenario}#${violation.turn}] ${violation.check}：${violation.detail}`);
      }
    }

    mkdirSync(outDir, { recursive: true });
    const base = join(outDir, `realism-${result.date}-${result.label}`);
    writeFileSync(`${base}.json`, JSON.stringify(result, null, 2), 'utf8');
    writeFileSync(`${base}.md`, reportMarkdown(result), 'utf8');
    console.log(`\n报告：${base}.md\n原始记录：${base}.json`);

    const failed = result.violations.length > 0;
    if (failed && !noGate) {
      console.error(`\n真人感评测 FAILED（${result.violations.length} 项机械期望，见报告 §7）`);
      process.exit(1);
    }
    console.log(failed ? '\n（--no-gate：只测量，不因违规失败）' : '\n真人感评测 OK');
  });
}

main();
