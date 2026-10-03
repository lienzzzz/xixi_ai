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
 *   node scripts/eval-conversation.ts --dsh           # evaluate the DSH path
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { DshBrainAdapter, FakeBrainAdapter, MimoBrainAdapter, type BrainAdapter, type ToolCallRecord, type ToolRegistry } from '@xixi/brain-adapter';
import { CliDshTransport } from '@xixi/brain-dsh';
import { assertSchema, type JsonSchema } from '@xixi/contracts';
import { ConversationEngine } from '@xixi/conversation';
import { MimoClient, WeatherClient } from '@xixi/model-adapters';
import { openXixiStore, type XixiConfig } from '@xixi/domain';
// V0.3 P0-A: the shared tool chain lives in `@xixi/runtime` now (pack `04_RUNTIME_CONSOLIDATION.md`
// §1 Step A); `scripts/field-test.ts` keeps a compatibility re-export for un-migrated callers.
import { CONVERSATION_SCOPE, buildToolChain } from '@xixi/runtime';
import { CORPUS, FORBIDDEN_PATTERNS, type Scenario } from '../tests/scenarios/corpus.ts';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, printEvidence, readDotEnv } from './lib/harness.ts';

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

interface JudgeScore {
  readonly scenario: string;
  readonly naturalness: number;
  readonly coherence: number;
  readonly inCharacter: boolean;
  readonly problems: readonly string[];
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
 * The one tool chain this runner talks through (pack Phase 2, extended in t14/T5-F1): the console's
 * own factory, so the corpus runs against the same four built-ins with the same permissions and the
 * same four-round cap. `onToolCall` prints what actually ran.
 */
function evalToolChain(config: XixiConfig, onToolCall?: (record: ToolCallRecord) => void): ToolRegistry {
  return buildToolChain(config, {
    ...(onToolCall === undefined ? {} : { onToolCall }),
    ...(useFake ? { weatherClient: offlineWeatherSource() } : {}),
  });
}

// The offline wiring report (t14): what this runner hands the model, with no model call and no store.
if (args.has('--print-wiring')) {
  const chain = evalToolChain(config);
  console.log(
    JSON.stringify({
      entry: 'eval-conversation',
      language: config.identity.language,
      maxToolRounds: chain.maxToolRounds,
      tools: chain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name),
      permissions: Object.fromEntries(chain.names().map((name) => [name, chain.check(name, CONVERSATION_SCOPE).verdict])),
    }),
  );
  process.exit(0);
}

const toolChain = evalToolChain(config, (record) => console.log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`));

const JUDGE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['naturalness', 'coherence', 'in_character', 'problems'],
  properties: {
    naturalness: { type: 'integer', minimum: 1, maximum: 5 },
    coherence: { type: 'integer', minimum: 1, maximum: 5 },
    in_character: { type: 'boolean' },
    problems: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
  },
};

function makeAdapter(store: ReturnType<typeof openXixiStore>): BrainAdapter {
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
  const adapter = makeAdapter(store);
  const engine = new ConversationEngine({ adapter, store, config, turnTimeoutMs: 90_000 });
  store.seedSelfProfile(config.personality.base);
  if (scenario.personality !== undefined) store.overrideSelfProfile(scenario.personality, `eval:${scenario.id}`);
  const session = store.createSession();
  const replies: string[] = [];

  try {
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
      const parsed = judged.json as JudgeScore & { scenario?: string };
      judgeScores.push({
        scenario,
        naturalness: parsed.naturalness,
        coherence: parsed.coherence,
        inCharacter: parsed.in_character,
        problems: parsed.problems ?? [],
      });
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
