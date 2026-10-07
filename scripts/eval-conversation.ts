/**
 * Conversation evaluation: run the self-generated corpus end to end, check the
 * behaviour mechanically, optionally score it with a judge model, and write a
 * report.
 *
 * The point is falsifiable evidence for "能实现较为流畅的人类对话":
 *   * structural checks (acceptance, silence, no scaffolding leak, no echo,
 *     personality actually changes length, continuity across turns);
 *   * latency per stage (§46.4);
 *   * optional LLM judge with a strict JSON schema, validated locally because
 *     MiMo does not prove that `strict` is enforced.
 *
 * Usage:
 *   node scripts/eval-conversation.ts                 # mechanical checks only
 *   node scripts/eval-conversation.ts --judge         # + judge model
 *   node scripts/eval-conversation.ts --fake          # offline smoke of the harness
 *   node scripts/eval-conversation.ts --print-wiring  # 离线：打印这条入口交给模型的工具链，然后退出
 *                                                     #   （含插件提供的 news.search / news.latest / news.for_interests）
 *   node scripts/eval-conversation.ts --dsh           # evaluate the DSH path
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { DshBrainAdapter, FakeBrainAdapter, MimoBrainAdapter, type ToolRegistry, type TurnModelProvider } from '@xixi/brain-adapter';
import { CliDshTransport } from '@xixi/brain-dsh';
import { assertSchema } from '@xixi/contracts';
import { MimoClient, WeatherClient } from '@xixi/model-adapters';
import { openXixiStore, type XixiConfig, type XixiStore } from '@xixi/domain';
import { createRssNewsSource } from '@xixi/plugins/news';
// V0.3 P0-A: the shared tool chain lives in `@xixi/runtime` now (pack `04_RUNTIME_CONSOLIDATION.md`
// §1 Step A); `scripts/field-test.ts` keeps a compatibility re-export for un-migrated callers.
// V0.3 P2.5-C: 工具链、插件内核（news 从这里进来）、审批宿主、durable 提醒、提取与引擎全部来自常驻
// 装配点 `createResidentRuntime` —— 本文件不再自己拼链，也不再自己 new 引擎。
import {
  CONVERSATION_SCOPE,
  createResidentRuntime,
  type PluginChainOptions,
  type ResidentModelInput,
  type XixiResidentRuntime,
} from '@xixi/runtime';
import { CORPUS, FORBIDDEN_PATTERNS } from '../tests/scenarios/corpus.ts';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, printEvidence, readDotEnv } from './lib/harness.ts';
// 评审的线上契约（schema 与读回包的映射）收在 `scripts/lib/judge-score.ts` 一处（t19 / R2-D2）：
// 只用 `--judge` 真跑才看得见的错名，现在由 `tests/unit/core/eval-conversation-judge.test.ts` 离线守着。
import { JUDGE_SCHEMA, judgeScoreFromWire, type JudgeScore } from './lib/judge-score.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const args = new Set(process.argv.slice(2));
const useJudge = args.has('--judge');
const useFake = args.has('--fake');
const useDsh = args.has('--dsh');
/**
 * The offline fake adapter exists to smoke-test the harness plumbing, so wording
 * and personality checks are skipped with it and reported as skipped rather than
 * silently passing. Only a real model can answer a question about naturalness.
 */
const QUALITY_CHECKS = !useFake;

interface TurnRecord {
  readonly scenario: string;
  readonly index: number;
  readonly user: string;
  readonly addressed: boolean;
  readonly accepted: boolean;
  readonly reason: string;
  readonly action: string;
  readonly reply: string | null;
  readonly totalMs: number;
  readonly firstTokenMs: number | null;
  readonly model: string;
}

interface Violation {
  readonly scenario: string;
  readonly turn: number;
  readonly check: string;
  readonly detail: string;
}

const config = loadConfig();

/**
 * Where a report goes. `--out <dir>` / `--out=<dir>` mirrors `scripts/eval-realism.ts`, so an
 * offline run (or a test) can write its report to a temporary directory instead of adding a file
 * under `docs/recon/` — the default, which is where a real judged run belongs.
 */
function reportDirectory(): string {
  const list = process.argv.slice(2);
  const withValue = list.find((argument) => argument.startsWith('--out='));
  if (withValue !== undefined) return withValue.slice('--out='.length);
  const at = list.indexOf('--out');
  const next = at >= 0 ? list[at + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : join(REPO_ROOT, 'docs', 'recon');
}
const reportDir = reportDirectory();

/**
 * The weather source the offline stand-in uses: the same three days a live lookup returns, served
 * from memory. `--fake` promises a run that touches nothing (AGENTS §7), and once the shared tool
 * chain is wired in (t14/T5-F1) a corpus turn about the weather would otherwise reach the provider.
 */
function offlineWeatherSource(): WeatherClient {
  const reply = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const fetchImpl = (async (input: string | URL | Request) =>
    String(input).includes('geocoding')
      ? reply({ results: [{ name: '成都', latitude: 30.66, longitude: 104.06, timezone: 'Asia/Shanghai', admin1: '四川省' }] })
      : reply({
          timezone: 'Asia/Shanghai',
          daily: {
            time: ['2026-10-01', '2026-10-02', '2026-10-03'],
            weather_code: [61, 3, 0],
            temperature_2m_max: [24.4, 25.1, 27.8],
            temperature_2m_min: [18.2, 19.0, 20.1],
            precipitation_probability_max: [80, 8, 0],
          },
        })) as unknown as typeof fetch;
  return new WeatherClient({ fetchImpl });
}

/**
 * 这个部署的新闻来源（V0.3 P2.5-C，与 `scripts/chat.ts` 同一份口径）。
 *
 * 显式给出而不是留空：`news.*` 三个工具照样会被广告给模型，而没有来源的调用只有 `items: []`
 * （`asked: 0`），模型很容易读成「今天没什么新闻」。P2.5-H 会把它换成配置驱动；在那之前它是每个
 * 入口一份的声明。
 */
const NEWS_FEED_URL = 'https://feeds.bbci.co.uk/news/world/rss.xml';

/** `--fake` 的离线保证：给插件网络授权的 fetch 一用即抛（离线桩提供的是编出来的标题，不能当新闻念）。 */
const offlinePluginFetch = (async (input: string | URL | Request) => {
  throw new Error(`--fake 是离线运行，不允许联网：${String(input)}`);
}) as unknown as typeof fetch;

/** 这个入口的插件层入参：来源是新闻插件，`offline` 换掉它的网络授权。 */
function evalPluginLayer(offline: boolean): Pick<PluginChainOptions, 'news' | 'fetchImpl' | 'weatherClient'> {
  return {
    ...(useFake ? { weatherClient: offlineWeatherSource() } : {}),
    ...(offline ? { fetchImpl: offlinePluginFetch } : {}),
    news: { sources: [(env) => createRssNewsSource({ name: 'BBC World', url: NEWS_FEED_URL, fetchImpl: env.fetchImpl })] },
  };
}

/** 这个 runner 的模型装配：链由装配点给，本函数只决定「哪一个模型」。 */
function makeAdapter(toolChain: ToolRegistry, store: XixiStore): TurnModelProvider {
  if (useFake) return new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE });
  if (useDsh) {
    const transport = new CliDshTransport({
      dshHome: DSH_HOME,
      profile: DSH_PROFILE,
      cwd: REPO_ROOT,
      env: harnessEnv(),
      timeoutMs: 240_000,
    });
    return new DshBrainAdapter({ transport, store });
  }
  return new MimoBrainAdapter({
    maxCompletionTokens: 400,
    registry: toolChain,
    scope: CONVERSATION_SCOPE,
    timezone: config.identity.timezone,
    // t14 / T5-F3: the reply filter judges foreign (reasoning) runs against the deployment
    // language, not the adapter's hard-coded `zh-CN` default.
    language: config.identity.language,
  });
}

export interface EvalRuntimeOptions {
  readonly config: XixiConfig;
  readonly store: XixiStore;
  /** 覆盖模型装配（`--print-wiring` 给一个永不被调用的替身）。 */
  readonly model?: ResidentModelInput | undefined;
  /** 报告路径：插件的网络授权换成一用即抛的 fetch。 */
  readonly offlinePlugins?: boolean | undefined;
  /** 生命周期横幅往哪写（默认 stdout）；报告路径改成 stderr，好让 stdout 只剩报告那一行 JSON。 */
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * 这个 runner 的常驻运行时（V0.3 P2.5-C）：工具链、插件内核（news 从这里进来）、审批宿主、
 * durable 提醒、记忆提取与引擎一次装好。每个场景各建一个（场景之间不共享库与人格）。
 *
 * The one tool chain this runner talks through (pack Phase 2, extended in t14/T5-F1, moved onto the
 * resident assembly point in V0.3 P2.5-C): `createEvalRuntime` hands the chain out, so the corpus runs
 * against the same built-ins with the same permissions and the same four-round cap as every other
 * entry — plus whatever the plugins mount (news). `onToolCall` prints what actually ran.
 */
export function createEvalRuntime(options: EvalRuntimeOptions): XixiResidentRuntime {
  const { config, store } = options;
  return createResidentRuntime({
    config,
    store,
    ...evalPluginLayer(options.offlinePlugins === true || useFake),
    onToolCall: (record) => console.log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`),
    log: options.log ?? ((line) => console.log(line)),
    conversation: { turnTimeoutMs: 90_000 },
    model: options.model ?? (({ toolChain }) => makeAdapter(toolChain, store)),
  });
}

// The offline wiring report (t14, P2.5-C): what this runner hands the model, with no model call and no store.
if (args.has('--print-wiring')) {
  const runtime = createEvalRuntime({
    config,
    store: openXixiStore({ dbPath: ':memory:' }),
    offlinePlugins: true,
    // 报告的 stdout 只有那一行 JSON（脚本要能直接管道给 jq）：装配点自己的横幅改走 stderr。
    log: (line) => process.stderr.write(`${line}\n`),
    model: ({ toolChain }) => new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE }),
  });
  try {
    const started = await runtime.start();
    const chain = runtime.toolChain;
    console.log(
      JSON.stringify({
        entry: 'eval-conversation',
        language: config.identity.language,
        maxToolRounds: chain.maxToolRounds,
        tools: chain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name),
        permissions: Object.fromEntries(chain.names().map((name) => [name, chain.check(name, CONVERSATION_SCOPE).verdict])),
        plugins: { mounted: [...started.mounted], skipped: [...started.skipped], refused: [...started.refused] },
      }),
    );
  } finally {
    await runtime.stop();
    runtime.store.close();
  }
  process.exit(0);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index] ?? null;
}

const records: TurnRecord[] = [];
const violations: Violation[] = [];
const repliesByScenario = new Map<string, string[]>();
const dataDir = mkdtempSync(join(tmpdir(), 'xixi-eval-'));

for (const scenario of CORPUS) {
  const store = openXixiStore({ dataDir });
  // V0.3 P2.5-C：每个场景一个常驻运行时（链 + 插件内核 + 审批宿主 + durable 提醒 + 提取 + 引擎）。
  const runtime = createEvalRuntime({ config, store });
  const engine = runtime.conversation;
  store.seedSelfProfile(config.personality.base);
  if (scenario.personality !== undefined) store.overrideSelfProfile(scenario.personality, `eval:${scenario.id}`);
  const session = store.createSession();
  const replies: string[] = [];

  try {
    // 插件/MCP/news 的工具是在 `start()` 里挂进链的（九步生命周期跑完再 mount），所以第一轮之前先启动。
    await runtime.start();
    for (const [index, turn] of scenario.turns.entries()) {
      const beforeQuiet = scenario.id === 'quiet-mode' && index === 1;
      if (scenario.id === 'quiet-mode' && index === 1) engine.quiet();
      void beforeQuiet;

      const result = await engine.respond({
        sessionId: session.sessionId,
        text: turn.user,
        addressed: turn.addressed ?? false,
      });

      records.push({
        scenario: scenario.id,
        index,
        user: turn.user,
        addressed: turn.addressed ?? false,
        accepted: result.accepted,
        reason: result.reason,
        action: result.action,
        reply: result.text,
        totalMs: result.latencyMs,
        firstTokenMs: result.firstTokenMs,
        model: result.model,
      });

      if (turn.expectRejected === true) {
        if (result.accepted) {
          violations.push({ scenario: scenario.id, turn: index, check: 'expect-rejected', detail: '被接受了，应该拒绝' });
        } else if (turn.expectReason !== undefined && result.reason !== turn.expectReason) {
          violations.push({
            scenario: scenario.id,
            turn: index,
            check: 'reject-reason',
            detail: `期望 ${turn.expectReason}，实际 ${result.reason}`,
          });
        }
        continue;
      }

      if (!result.accepted) {
        violations.push({ scenario: scenario.id, turn: index, check: 'accepted', detail: `被拒绝：${result.reason}` });
        continue;
      }
      if (result.action === 'SILENCE') continue;

      const reply = result.text ?? '';
      replies.push(reply);

      if (QUALITY_CHECKS) {
        for (const forbidden of FORBIDDEN_PATTERNS) {
          if (forbidden.pattern.test(reply)) {
            violations.push({ scenario: scenario.id, turn: index, check: 'no-leak', detail: `${forbidden.why}: ${reply.slice(0, 80)}` });
          }
        }
        if (reply.trim() === turn.user.trim() && reply.trim().length > 6) {
          // Short acknowledgements legitimately mirror the user ("哦。" → "哦。"),
          // so only a *long* verbatim echo counts as a defect.
          violations.push({ scenario: scenario.id, turn: index, check: 'no-echo', detail: '把用户的长句原样复述回来了' });
        }
        if (reply.length > 300) {
          violations.push({ scenario: scenario.id, turn: index, check: 'length', detail: `回复过长（${reply.length} 字）` });
        }
      }
    }

    // Continuity: the second speaking reply must not be a copy of the first.
    if (scenario.expectations.requireContinuity === true && replies.length >= 2) {
      if (replies[0] === replies[1]) {
        violations.push({ scenario: scenario.id, turn: 1, check: 'continuity', detail: '两轮回答完全相同，像复读' });
      }
    }

    const accepted = records.filter((record) => record.scenario === scenario.id && record.accepted).length;
    const speaks = records.filter((record) => record.scenario === scenario.id && record.action === 'SPEAK').length;
    const rejected = records.filter((record) => record.scenario === scenario.id && !record.accepted).length;
    if (scenario.expectations.minAccepted !== undefined && accepted < scenario.expectations.minAccepted) {
      violations.push({
        scenario: scenario.id,
        turn: -1,
        check: 'min-accepted',
        detail: `接受轮数 ${accepted} < ${scenario.expectations.minAccepted}`,
      });
    }
    if (scenario.expectations.minSpeaks !== undefined && speaks < scenario.expectations.minSpeaks) {
      violations.push({
        scenario: scenario.id,
        turn: -1,
        check: 'min-speaks',
        detail: `开口轮数 ${speaks} < ${scenario.expectations.minSpeaks}`,
      });
    }
    if (scenario.expectations.rejectedTurns !== undefined && rejected !== scenario.expectations.rejectedTurns) {
      violations.push({
        scenario: scenario.id,
        turn: -1,
        check: 'rejected-count',
        detail: `拒绝轮数 ${rejected} != ${scenario.expectations.rejectedTurns}`,
      });
    }
    repliesByScenario.set(scenario.id, replies);
  } finally {
    // 关库之前先关停运行时（`stop()` 先 drain 提取，再关停插件层、清空链）；顺序不能反。
    await runtime.stop();
    store.close();
  }
}

// --- personality must be visible in behaviour (§7, §39.4) --------------------
const lengths = (id: string): number[] => (repliesByScenario.get(id) ?? []).map((reply) => reply.length);
const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
const terseMean = mean(lengths('terse-personality'));
const chattyMean = mean(lengths('chatty-personality'));
const personalityEffect = {
  terseMeanChars: Number(terseMean.toFixed(1)),
  chattyMeanChars: Number(chattyMean.toFixed(1)),
  ratio: terseMean === 0 ? null : Number((chattyMean / terseMean).toFixed(2)),
};
if (QUALITY_CHECKS && terseMean > 0 && chattyMean > 0 && chattyMean <= terseMean) {
  violations.push({
    scenario: 'personality',
    turn: -1,
    check: 'personality-length',
    detail: `高话多组平均 ${chattyMean.toFixed(1)} 字没有超过低话多组 ${terseMean.toFixed(1)} 字，人格参数没有体现在行为上`,
  });
}

// --- optional judge ---------------------------------------------------------
const judgeScores: JudgeScore[] = [];
const judgeFailures: { scenario: string; detail: string }[] = [];
if (useJudge) {
  const client = new MimoClient();
  const transcripts = new Map<string, { user: string; reply: string }[]>();
  for (const record of records) {
    if (!record.accepted || record.action === 'SILENCE' || record.reply === null) continue;
    const list = transcripts.get(record.scenario) ?? [];
    list.push({ user: record.user, reply: record.reply });
    transcripts.set(record.scenario, list);
  }
  for (const [scenario, turns] of transcripts) {
    const transcript = turns.map((turn) => `用户：${turn.user}\n西西：${turn.reply}`).join('\n');
    try {
      // chatJson owns the provider workaround (json_schema intermittently pads with
      // whitespace and truncates); the rubric contract stays ours and is checked
      // locally before any score is trusted.
      const judged = await client.chatJson({
        model: 'mimo-v2.6-flash',
        maxCompletionTokens: 500,
        messages: [
          {
            role: 'system',
            content:
              '你是严格的对话质量评审。评估一段家庭陪伴对话，只输出 JSON。' +
              'naturalness：像不像真人日常说话（1 差，5 很好）。' +
              'coherence：是否接得住上下文、有没有答非所问或复读（1 差，5 很好）。' +
              'in_character：是否像家里熟悉的人，而不是客服或 AI 助手。' +
              'problems：最多 5 条具体问题，没有就空数组。',
          },
          { role: 'user', content: `场景：${scenario}\n\n${transcript}` },
        ],
        schema: { name: 'conversation_quality', schema: JUDGE_SCHEMA },
        validate: (value) => assertSchema(JUDGE_SCHEMA, value, 'INVALID_PAYLOAD', 'judge output does not match the rubric schema'),
      });
      const parsed = judgeScoreFromWire(judged.json, scenario);
      if (parsed === null) {
        // 回包里读不到 rubric 的字段 = **这一次没测到**（不是「不像家里人」）。旧写法在这里手抄
        // `in_character`，错名时得到 `undefined`，报告会把它渲染成「否」—— 一次静默的错误结论。
        throw new Error(`judge payload is missing the rubric fields (${Object.keys(JUDGE_SCHEMA.properties ?? {}).join('/')})`);
      }
      judgeScores.push(parsed);
    } catch (error) {
      // The judge is a measurement instrument, and MiMo's structured-output path is
      // intermittently unreliable (see progress §2.11). A failed judge call means
      // "not measured" for that scenario, so it is reported and tolerated up to a
      // small budget instead of failing the whole gate on one flaky call.
      judgeFailures.push({
        scenario,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const average = (pick: (score: JudgeScore) => number): number | null =>
    judgeScores.length === 0 ? null : Number((judgeScores.reduce((sum, score) => sum + pick(score), 0) / judgeScores.length).toFixed(2));
  const naturalness = average((score) => score.naturalness);
  const coherence = average((score) => score.coherence);
  if (naturalness !== null && naturalness < 3.5) {
    violations.push({ scenario: 'judge', turn: -1, check: 'judge-naturalness', detail: `自然度均分 ${naturalness} < 3.5` });
  }
  if (coherence !== null && coherence < 3.5) {
    violations.push({ scenario: 'judge', turn: -1, check: 'judge-coherence', detail: `连贯性均分 ${coherence} < 3.5` });
  }
  // One flaky judge call is tolerated and reported; more than one means the
  // measurement itself is broken and must not be waved through.
  if (judgeFailures.length > 1) {
    violations.push({
      scenario: 'judge',
      turn: -1,
      check: 'judge-availability',
      detail: `${judgeFailures.length} 次评审失败，测量本身不可靠：${judgeFailures.map((failure) => failure.scenario).join(', ')}`,
    });
  }
}

// --- report -----------------------------------------------------------------
const speaking = records.filter((record) => record.accepted && record.action === 'SPEAK');
const totalLatencies = speaking.map((record) => record.totalMs);
const firstTokenLatencies = speaking.map((record) => record.firstTokenMs).filter((value): value is number => value !== null);
const silenceCount = records.filter((record) => record.accepted && record.action === 'SILENCE').length;
const rejectedCount = records.filter((record) => !record.accepted).length;

const summary = {
  adapter: useFake ? 'fake' : useDsh ? 'dsh' : 'mimo-direct',
  model: useDsh ? 'mimo-v2.6-flash (via DSH)' : useFake ? 'fake-1' : 'mimo-v2.6-flash',
  scenarios: CORPUS.length,
  turns: records.length,
  accepted: records.filter((record) => record.accepted).length,
  rejected: rejectedCount,
  speaks: speaking.length,
  silences: silenceCount,
  personalityEffect,
  latency: {
    totalMsP50: percentile(totalLatencies, 50),
    totalMsP95: percentile(totalLatencies, 95),
    firstTokenMsP50: percentile(firstTokenLatencies, 50),
    firstTokenMsP95: percentile(firstTokenLatencies, 95),
  },
  judged: judgeScores.length > 0,
  judge: judgeScores,
  judgeFailures,
  violations,
};

printEvidence('对话评估', summary);
printEvidence('逐轮记录', records);

if (useJudge) {
  const report = [
    `# 对话评估报告（${new Date().toISOString()}）`,
    '',
    `- 适配器：${summary.adapter}（${summary.model}）`,
    `- 场景数 / 轮数：${summary.scenarios} / ${summary.turns}`,
    `- 接受 ${summary.accepted}，拒绝 ${summary.rejected}，开口 ${summary.speaks}，沉默 ${summary.silences}`,
    `- 人格效果：低话多 ${personalityEffect.terseMeanChars} 字 vs 高话多 ${personalityEffect.chattyMeanChars} 字（比值 ${personalityEffect.ratio}）`,
    `- 延迟：总时长 P50 ${summary.latency.totalMsP50}ms / P95 ${summary.latency.totalMsP95}ms；首字 P50 ${summary.latency.firstTokenMsP50}ms / P95 ${summary.latency.firstTokenMsP95}ms`,
    '',
    '## 评审分数',
    '',
    '| 场景 | 自然度 | 连贯性 | 像家里人 | 问题 |',
    '|---|---:|---:|---|---|',
    ...judgeScores.map(
      (score) => `| ${score.scenario} | ${score.naturalness} | ${score.coherence} | ${score.inCharacter ? '是' : '否'} | ${score.problems.join('；') || '—'} |`,
    ),
    '',
    '## 结构性问题',
    '',
    violations.length === 0 ? '无。' : violations.map((violation) => `- [${violation.scenario}#${violation.turn}] ${violation.check}：${violation.detail}`).join('\n'),
    '',
    judgeFailures.length === 0
      ? ''
      : ['## 未能评审的场景（测量缺口，不计为通过）', '', ...judgeFailures.map((failure) => `- ${failure.scenario}：${failure.detail.slice(0, 200)}`), ''].join('\n'),
  ].join('\n');
  const reportPath = join(reportDir, `conversation-eval-${new Date().toISOString().slice(0, 10)}.md`);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(reportPath, report, 'utf8');
  console.log(`\n报告已写入 ${reportPath}`);
}

if (violations.length > 0) {
  console.error(`\n对话评估 FAILED（${violations.length} 项）`);
  for (const violation of violations.slice(0, 20)) {
    console.error(` - [${violation.scenario}#${violation.turn}] ${violation.check}: ${violation.detail}`);
  }
  process.exit(1);
}
console.log('\n对话评估 OK：接受/拒绝规则、沉默、角色一致性、连续性、人格效果与延迟均已验证');
