/**
 * pack Phase 5 的 12 小时家庭时间线验收 —— 跟踪在库、离线可复跑的判定命令（t3 / t9 复验）。
 *
 * 五项目标来自 `xixi_v02_refactor_pack` 的 Phase 5 验收（`02_IMPLEMENTATION_STEPS.md`）：
 *
 *   1. 主动次数 6~12 次可以接受；
 *   2. generic topic ≤ 20%；
 *   3. open thread / recent event / interest topic ≥ 60%；
 *   4. 连续两次主动没人回应后显著降频；
 *   5. 正在热聊时可以连续主动接话，不受 18 分钟 new-session cooldown 限制。
 *
 * 为什么信它：**它跑的是生产部件，不是另写一套引擎**。
 *
 *   - 候选与 tick 语义 = 常驻考虑循环 `ProactiveLoop.tickOnce`（scripts/field-test.ts）本体，
 *     含 t9 F1 的修复（被扣分的候选不再吃光 tick）与 F5 的生产通路（对话开着时话题池候选
 *     变成 `conversation_continuation`）；
 *   - 「热聊」的判定 = 引擎自己的 `isHotChat`（对话还开着 + 窗口内至少 N 次用户轮次 → 热聊接话
 *     不吃未回应惩罚），参数是配置里的 `hot_chat_min_turns` / `hot_chat_window_min`；一句孤零零的
 *     搭话不算热聊，所以「被忽视的一天」仍会显著降频（第四项与第五项目标靠它同时成立）；
 *   - 门禁 / 分数 / 硬底线 = 真实 `ProactiveEngine` + 出厂 config（config/xixi.example.yaml 的
 *     `proactive` 段）；
 *   - 会话状态 = 真实 `ConversationEngine` + FSM（FakeBrainAdapter，注入模拟时钟——混用两个
 *     时间源会让状态机安静地给出错误答案，t9 §1 的教训）；
 *   - 「读空气」seam 由本命令扮演（同意/未接线），内容不经过模型：固定短句兜底，不花钱、不联网。
 *
 * 三段家庭脚本的文字与 t9 独立验证
 * （docs/verification/t9-proactive-v2-verification-2026-10-01.md）逐字同源（唯一修正：条目按
 * 分钟排序，否则脚本游标卡在第一条乱序条目上、热聊句要到窗口关闭后才触发），因此修复前后
 * 的数字可比。五项全过才 exit 0。
 *
 * Usage: node scripts/eval-proactive-timeline.ts [--tick-seconds=N] [--help]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 时间线按 +08:00（Asia/Shanghai，家里的墙钟）判定，不按跑脚本的机器所在时区。
 *
 * 为什么必须写：候选生成器（`buildProactiveCandidates`）读的是**本地墙钟**的小时数与本地自然日
 * （产线就该这样——家里那台机器在哪个时区，哪个时区就是事实）。但模拟时间线用的是固定的绝对时刻，
 * 于是同一份脚本在 UTC 机器上会判成**另外一天**（钩子窗口整体平移 8 小时、日界也变），结论不可比。
 * Node 支持运行时改 `TZ`，所以在这里钉住即可；必须在任何 `Date` 取本地字段之前执行。
 */
process.env['TZ'] = 'Asia/Shanghai';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import {
  ConversationEngine,
  ProactiveEngine,
  evaluateProactiveGates,
  parseProactiveSettings,
  type ProactiveDecider,
  type ProactiveGateContext,
  type ProactiveReasonCode,
} from '@xixi/conversation';
import { openXixiStore, type XixiStore } from '@xixi/domain';

import { ProactiveLoop } from './field-test.ts';
import { loadConfig, REPO_ROOT } from './lib/harness.ts';

// ------------------------------------------------------------------ CLI

const USAGE = [
  '用法：node scripts/eval-proactive-timeline.ts [--tick-seconds=N] [--help]',
  '',
  '离线复跑 pack Phase 5 的 12 小时家庭时间线验收：跑「有人回应的一天 / 没人回应的一天 /',
  '上午有热聊的一天」三段脚本场景，外加一个「连续未回应」机制探针，按顺序打印五项目标的',
  '逐项判定（实测值与阈值一起打印，阈值以 pack Phase 5 验收原文为准）。',
  '',
  '退出码：五项全部通过才 exit 0；有任何一项未过 exit 1。',
  '本命令不联网、不花 API 费用；tick 间隔默认沿用 t9 独立验证的口径，想对齐生产节奏可传',
  '--tick-seconds=30。结论看运行输出的末尾判定表，不依赖任何固定数字。',
  '',
  '五项：主动次数区间、generic 占比、具体来源占比、未回应后降频、热聊中接话。',
  '时区固定为 +08:00（Asia/Shanghai），否则同一份脚本在不同机器上会判成不同的一天。',
].join('\n');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const tickArg = process.argv.find((arg) => arg.startsWith('--tick-seconds='));
const TICK_SECONDS = (() => {
  const parsed = Number((tickArg ?? '').split('=')[1]);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 60;
})();

// ------------------------------------------------------------ simulation seams

/** Asia/Shanghai — the timeline is judged in one fixed offset, not in the machine's own zone. */
const OFFSET_MINUTES = 480;
/** One household day, 12 hours, 07:30 → 19:30 (outside the 23:30–07:30 quiet window). */
const DAY_START = new Date('2026-10-02T07:30:00+08:00');
const HOURS = 12;

/** The triggers whose line names no concrete thing (「我在呢」「安静了一会儿」). */
const GENERIC_TRIGGERS = new Set(['presence_arrived', 'conversation_dangling', 'routine_expected', 'random_smalltalk']);
/** The pack's "open thread / recent event / interest topic" family. */
const SPECIFIC_TRIGGERS = new Set(['future_hook_due', 'topic_pool']);

const config = loadConfig();
const settings = parseProactiveSettings(config.proactive as unknown as Record<string, unknown>);
const PROACTIVITY = (config.personality.base['proactivity'] as number | undefined) ?? 0.85;

function offsetIso(at: Date): string {
  const shifted = new Date(at.getTime() + OFFSET_MINUTES * 60_000);
  return `${shifted.toISOString().slice(0, 23)}+08:00`;
}

function atMinute(minutesFromStart: number): Date {
  return new Date(DAY_START.getTime() + minutesFromStart * 60_000);
}

// ------------------------------------------------------------- household scripts

interface Household {
  /** `[minute, text]` — what the family says, unprompted (t9's script, verbatim). */
  readonly utterances: readonly (readonly [number, string])[];
  /** `[minute]` — someone walks in, the presence projection is refreshed. */
  readonly arrivals: readonly number[];
  /** Answer delay in minutes for a delivered message, or `null` for "nobody answers". */
  readonly answer: (minutesIntoDay: number, index: number) => number | null;
  /** Minutes of a live conversation (utterances every few minutes), if any. */
  readonly hotWindow?: readonly [number, number];
}

function householdFor(scenario: string): Household {
  const base: readonly (readonly [number, string])[] = [
    [5, '早啊，我刚从菜市场回来，买了点豆腐。'],
    [35, '今天下午三点我得去社区医院拿药。'],
    [70, '昨天老李说他孙子考上大学了，真不容易。'],
    [200, '中午随便吃了碗面。'],
    [330, '下午把药拿回来了，医生说下个月再复查。'],
    [430, '晚上想吃点清淡的，胃不太舒服。'],
    [520, '电视里在放老片子，我先看会儿。'],
  ];
  const utterances: (readonly [number, string])[] = [...base];
  if (scenario === 'hot-chat') {
    // 09:30–10:15, a turn every ~4 minutes: a welcomed, live conversation.
    for (let index = 0; index < 12; index += 1) {
      utterances.push([120 + index * 4, `接着聊：我在想周末要不要请老李来家里坐坐（第 ${index + 1} 句）。`]);
    }
  }
  // Sorted by minute: the runner consumes the script in order, and appending the hot-chat lines
  // after the base day would park the cursor on the first out-of-order entry — every later line
  // (hot window included) would only fire once the cursor unblocks, i.e. after its window closed.
  // The texts are t9's verbatim; only the order is corrected.
  utterances.sort((left, right) => left[0] - right[0]);
  return {
    utterances,
    arrivals: [2, 180, 480],
    hotWindow: scenario === 'hot-chat' ? ([118, 168] as const) : undefined,
    answer: (minutesIntoDay, index) => {
      if (scenario.startsWith('unanswered')) return null;
      // Deterministic "answers ~2 of 3 messages, 3–8 minutes later" (the same seeded roll as t9).
      let a = (1000 + minutesIntoDay * 7919 + index) >>> 0;
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const roll = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return roll < 0.68 ? 3 + (Math.round(roll * 100) % 6) : null;
    },
  };
}

// ------------------------------------------------------------ scenario runner

interface Delivery {
  readonly at: string;
  readonly minutesIntoDay: number;
  readonly trigger: string;
  readonly initiativeKind: string;
  readonly topicRef: string | null;
  readonly candidateId: string;
  readonly score: number;
}

interface DecisionRow {
  readonly reasonCode: ProactiveReasonCode;
  readonly trigger: string;
  readonly modelConsulted: boolean;
  /** Minutes into the simulated day — the F4 probe judges 「拒绝发生在开口之前还是之后」 with it. */
  readonly minute: number;
}

interface ScenarioResult {
  readonly scenario: string;
  readonly dataDir: string;
  readonly deliveries: readonly Delivery[];
  readonly decisions: readonly DecisionRow[];
  readonly userTurns: readonly string[];
}

interface ScenarioOptions {
  /** How many simulated minutes the run covers; defaults to the full 12-hour household day. */
  readonly minutes?: number;
  /** Settings for this run; defaults to the shipped `config/xixi.example.yaml` proactive section. */
  readonly settings?: ProactiveSettings;
  /** The household script; defaults to `householdFor(scenario)`. */
  readonly household?: Household;
}

async function runScenario(scenario: string, decider: ProactiveDecider | undefined, options: ScenarioOptions = {}): Promise<ScenarioResult> {
  const scenarioSettings = options.settings ?? settings;
  const dataDir = mkdtempSync(join(tmpdir(), `xixi-timeline-${scenario}-`));
  /**
   * The simulated clock is the *only* time source: the FSM (`ConversationEngine`) and every event
   * the store stamps itself — `conversation.turn` above all — must carry simulated time, or the
   * engine's 「这条开口有没有人回应」 check compares a simulated delivery against a wall-clock turn
   * and reads every message as unanswered forever (t9 §1's two-clock trap, in a new disguise).
   */
  let simulatedNow: Date = DAY_START;
  const store: XixiStore = openXixiStore({ dataDir, clock: () => simulatedNow });
  const household = householdFor(scenario);
  const engine = new ConversationEngine({
    adapter: new FakeBrainAdapter(),
    store,
    config,
    turnTimeoutMs: 5_000,
    offsetMinutes: OFFSET_MINUTES,
    clock: () => simulatedNow,
  });
  store.seedSelfProfile(config.personality.base);
  const session = store.createSession();

  const userTurns: string[] = [];
  const utteranceLog: string[] = []; // newest first — exactly what the console's readRecentUserTopics hands the builder
  let pendingAnswers: Date[] = [];
  let presenceUpdatedAt: Date = atMinute(-30);
  let lastUserTurnAt: Date | null = null;
  let utteranceIndex = 0;
  let deliveryIndex = 0;

  const say = async (at: Date, text: string): Promise<void> => {
    await engine.respond({ sessionId: session.sessionId, text, addressed: true, at });
    lastUserTurnAt = at;
    userTurns.push(offsetIso(at));
    utteranceLog.unshift(text);
    if (utteranceLog.length > 12) utteranceLog.pop();
  };

  const loop = new ProactiveLoop({
    store,
    readSettings: () => settings,
    readState: () => engine.state,
    readInFlightTurn: () => false,
    readProactivity: () => PROACTIVITY,
    readPresence: async () => ({ present: true, updatedAt: presenceUpdatedAt.toISOString(), source: 'timeline' }),
    readLastUserTurnAt: () => lastUserTurnAt,
    readRecentUserTopics: () => utteranceLog,
    random: () => 1, // 「随机闲聊」 stays off: the shipped config switches it off, and the roll says no
    readSessionId: () => session.sessionId,
    ...(decider === undefined ? {} : { decide: decider }),
    now: () => simulatedNow,
    offsetMinutes: OFFSET_MINUTES,
    log: () => {},
  });

  const deadline = atMinute(HOURS * 60);
  for (let at = DAY_START.getTime(); at <= deadline.getTime(); at += TICK_SECONDS * 1_000) {
    simulatedNow = new Date(at);
    for (const arrival of household.arrivals) {
      if (arrival * 60_000 + DAY_START.getTime() === at) presenceUpdatedAt = simulatedNow;
    }
    while (utteranceIndex < household.utterances.length && atMinute(household.utterances[utteranceIndex]?.[0] ?? Infinity).getTime() <= at) {
      const entry = household.utterances[utteranceIndex] as readonly [number, string];
      utteranceIndex += 1;
      await say(atMinute(entry[0]), entry[1]);
    }
    while (pendingAnswers.length > 0 && (pendingAnswers[0]?.getTime() ?? Infinity) <= at) {
      await say(pendingAnswers.shift() as Date, '嗯，听到了。');
    }
    await loop.tickOnce();

    // Schedule this tick's answer the same way t9 did (from the deliveries written so far).
    const spokenSoFar = store
      .readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })
      .filter((event) => (event.payload as Record<string, unknown>)['speak'] === true).length;
    while (deliveryIndex < spokenSoFar) {
      const record = store
        .readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })
        .filter((event) => (event.payload as Record<string, unknown>)['speak'] === true)[deliveryIndex];
      const minutesIntoDay = Math.round((new Date(record?.timestamp ?? 0).getTime() - DAY_START.getTime()) / 60_000);
      const delay = household.answer(minutesIntoDay, deliveryIndex + 1);
      if (delay !== null) pendingAnswers.push(new Date(DAY_START.getTime() + minutesIntoDay * 60_000 + delay * 60_000));
      // Keep the queue in time order: a later-scheduled answer must not park an earlier one
      // behind it (delays differ per message), or an answer would land outside its 10-minute
      // window and be read as 「没人回应」.
      pendingAnswers.sort((left, right) => left.getTime() - right.getTime());
      deliveryIndex += 1;
    }
  }

  const raw = store.readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER });
  const deliveries: Delivery[] = [];
  const decisions: DecisionRow[] = [];
  for (const event of raw) {
    const payload = event.payload as Record<string, unknown>;
    const reasonCode = String(payload['reason_code'] ?? '') as ProactiveReasonCode;
    decisions.push({
      reasonCode,
      trigger: String(payload['trigger'] ?? ''),
      modelConsulted: payload['model_consulted'] === true,
    });
    if (payload['speak'] !== true) continue;
    const at = new Date(event.timestamp);
    deliveries.push({
      at: offsetIso(at),
      minutesIntoDay: Math.round((at.getTime() - DAY_START.getTime()) / 60_000),
      trigger: String(payload['trigger'] ?? ''),
      initiativeKind: String(payload['initiative_kind'] ?? ''),
      topicRef: typeof payload['topic_ref'] === 'string' ? payload['topic_ref'] : null,
      candidateId: String(payload['candidate_id'] ?? ''),
      score: Number(payload['score'] ?? 0),
    });
  }
  store.close();
  return { scenario, dataDir, deliveries, decisions, userTurns };
}

// ------------------------------------------------------------------ metrics

function answeredWithin(result: ScenarioResult, delivery: Delivery, minutes: number): boolean {
  const at = new Date(delivery.at).getTime();
  return result.userTurns.some((turn) => {
    const t = new Date(turn).getTime();
    return t > at && t <= at + minutes * 60_000;
  });
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 10;
}

function metricsOf(result: ScenarioResult): Record<string, unknown> {
  const deliveries = result.deliveries;
  const gaps = deliveries.slice(1).map((delivery, index) => delivery.minutesIntoDay - (deliveries[index]?.minutesIntoDay ?? 0));
  const accepted = deliveries.filter((delivery) => answeredWithin(result, delivery, settings.unansweredWindowMinutes)).length;
  const histogram = (values: readonly string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const value of values) out[value] = (out[value] ?? 0) + 1;
    return out;
  };
  return {
    scenario: result.scenario,
    proactiveCount12h: deliveries.length,
    genericByTopicRefPct: pct(deliveries.filter((delivery) => delivery.topicRef === null).length, deliveries.length),
    genericByContentPct: pct(deliveries.filter((delivery) => GENERIC_TRIGGERS.has(delivery.trigger)).length, deliveries.length),
    specificSourceSharePct: pct(deliveries.filter((delivery) => SPECIFIC_TRIGGERS.has(delivery.trigger)).length, deliveries.length),
    acceptRatePct: pct(accepted, deliveries.length),
    triggerHistogram: histogram(deliveries.map((delivery) => delivery.trigger)),
    minGapMinutes: gaps.length === 0 ? null : Math.min(...gaps),
    gapsUnderCooldown: gaps.filter((gap) => gap < settings.baseCooldownMinutes).length,
    modelConsulted: result.decisions.filter((decision) => decision.modelConsulted).length,
    reasonHistogram: histogram(result.decisions.map((decision) => decision.reasonCode)),
    decisionsLogged: result.decisions.length,
  };
}

// ------------------------------------------------- goal 4's mechanism probe

/**
 * The decisive probe for 「连续两次没人回应后显著降频」: the *same* production candidate shapes the
 * builder emits, judged with 0 / 1 / 2 / 3 recent messages nobody answered (all older than the
 * interruption window, on unrelated topics, so the only thing changing is the 未回应惩罚).
 */
function unansweredProbe(): { readonly rows: readonly Record<string, unknown>[]; readonly monotone: boolean; readonly holdsAfterTwo: boolean } {
  const now = new Date('2026-10-02T11:00:00+08:00');
  const shapes = [
    {
      label: '长时间沉默跟进（conversation_dangling，泛泛）',
      trigger: 'conversation_dangling' as const,
      initiativeKind: 'conversation_continuation' as const,
      components: { topic_quality: 0.85, personal_relevance: 0.8, freshness: 0.4, receptivity: 0.7, engagement: 0.3 },
      topicRef: null,
    },
    {
      label: '用户自己提过的话题（topic_pool）',
      trigger: 'topic_pool' as const,
      initiativeKind: 'external_sharing' as const,
      components: { topic_quality: 0.8, personal_relevance: 0.9, freshness: 0.5, receptivity: 0.8, engagement: 0.7 },
      topicRef: '明天要去医院复查一下',
    },
    {
      label: '有人到家的招呼（presence_arrived，泛泛）',
      trigger: 'presence_arrived' as const,
      initiativeKind: 'environment_reaction' as const,
      components: { topic_quality: 0.8, personal_relevance: 0.9, freshness: 1, receptivity: 0.9, engagement: 0.8 },
      topicRef: null,
    },
  ] as const;

  const historyFor = (count: number): readonly { candidateId: string; at: Date; topicRef: string | null; sequence: number }[] =>
    Array.from({ length: count }, (_, index) => ({
      candidateId: `old-${index}`,
      at: new Date(now.getTime() - (60 - index * 10) * 60_000),
      topicRef: `unrelated-topic-${index}`,
      sequence: index + 1,
    }));

  const rows: Record<string, unknown>[] = [];
  let monotone = true;
  let holdsAfterTwo = false;
  for (const shape of shapes) {
    const penalties: number[] = [];
    let recommendationAtTwo = '';
    for (const unanswered of [0, 1, 2, 3]) {
      const context: ProactiveGateContext = {
        settings,
        now,
        offsetMinutes: OFFSET_MINUTES,
        proactivity: PROACTIVITY,
        conversationState: 'IDLE',
        inFlightTurn: false,
        negativeFeedback: false,
        sceneAvailable: true,
        speechAvailable: true,
        privacyAllowed: true,
        history: historyFor(unanswered),
        userTurns: [],
        consultsToday: 0,
      };
      const result = evaluateProactiveGates(
        { candidateId: `probe-${shape.trigger}-${unanswered}`, trigger: shape.trigger, initiativeKind: shape.initiativeKind, components: shape.components, topicRef: shape.topicRef, intent: null },
        context,
      );
      penalties.push(result.signals.recent_unanswered_penalty);
      if (unanswered === 2) recommendationAtTwo = result.recommendation;
      rows.push({
        shape: shape.label,
        unansweredMessages: unanswered,
        recent_unanswered_penalty: result.signals.recent_unanswered_penalty,
        score: result.score,
        threshold: result.threshold,
        recommendation: result.recommendation,
        reasonCode: result.reasonCode,
      });
    }
    if (!(penalties[0]! < penalties[1]! && penalties[1]! < penalties[2]! && penalties[2]! < penalties[3]!)) monotone = false;
    if (shape.trigger === 'conversation_dangling') holdsAfterTwo = recommendationAtTwo === 'hold';
  }
  return { rows, monotone, holdsAfterTwo };
}

// ------------------------------------------------------------------- main

async function main(): Promise<void> {
  if (tickArg !== undefined && TICK_SECONDS === 60 && !/--tick-seconds=60$/.test(tickArg)) {
    console.log(`--tick-seconds 的值不可用，已回落到默认口径（${TICK_SECONDS}s）`);
  }
  const baseline = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })();

  const agree: ProactiveDecider = () => ({ speak: true, reasonCode: 'good_moment' });
  const scenarioNames = ['responsive', 'unanswered', 'hot-chat'] as const;
  const results = new Map<string, ScenarioResult>();
  const metrics: Record<string, unknown>[] = [];
  const roots: string[] = [];

  for (const name of scenarioNames) {
    const result = await runScenario(name, agree);
    roots.push(result.dataDir);
    results.set(name, result);
    metrics.push(metricsOf(result));
  }

  console.log(`# pack Phase 5 · 12 小时家庭时间线（tick ${TICK_SECONDS}s，时区 +08:00，基线修订号 ${baseline}）`);
  console.log('');
  for (const row of metrics) console.log(`${JSON.stringify(row, null, 2)}\n`);

  const responsive = results.get('responsive') as ScenarioResult;
  const unanswered = results.get('unanswered') as ScenarioResult;
  const hotChat = results.get('hot-chat') as ScenarioResult;
  const responsiveMetrics = metrics.find((row) => row['scenario'] === 'responsive') as Record<string, unknown>;
  const unansweredMetrics = metrics.find((row) => row['scenario'] === 'unanswered') as Record<string, unknown>;
  const hotMetrics = metrics.find((row) => row['scenario'] === 'hot-chat') as Record<string, unknown>;

  const responsiveCount = responsive.deliveries.length;
  const unansweredCount = unanswered.deliveries.length;

  // Goal 5: a production continuation inside the live window, and gaps below the 18-minute bar.
  const hotWindow = householdFor('hot-chat').hotWindow as readonly [number, number];
  const continuationsInWindow = hotChat.deliveries.filter(
    (delivery) =>
      delivery.initiativeKind === 'conversation_continuation' &&
      delivery.minutesIntoDay >= hotWindow[0] &&
      delivery.minutesIntoDay <= hotWindow[1],
  ).length;
  const minGap = Number(hotMetrics['minGapMinutes'] ?? Number.POSITIVE_INFINITY);

  const probe = unansweredProbe();
  console.log('=== 「连续未回应」机制探针（生产候选形状；历史都在打扰窗之外、话题无关）===');
  console.log(JSON.stringify(probe.rows, null, 2));
  console.log('');

  // ------------------------------------------------------------ five goals
  const genericByTopicRef = Number(responsiveMetrics['genericByTopicRefPct']);
  const genericByContent = Number(responsiveMetrics['genericByContentPct']);
  const specificShare = Number(responsiveMetrics['specificSourceSharePct']);

  const verdicts: readonly { readonly no: number; readonly title: string; readonly measured: string; readonly pass: boolean }[] = [
    {
      no: 1,
      title: '主动次数 6~12 次可以接受',
      measured: `responsive 场景实测 ${responsiveCount} 次（区间 6~12）`,
      pass: responsiveCount >= 6 && responsiveCount <= 12,
    },
    {
      no: 2,
      title: 'generic topic ≤ 20%',
      measured: `引擎口径 ${genericByTopicRef}%、内容口径 ${genericByContent}%（均须 ≤ 20；F3 修复后两口径应当相等）`,
      pass: genericByTopicRef <= 20 && genericByContent <= 20,
    },
    {
      no: 3,
      title: 'open thread / recent event / interest topic ≥ 60%',
      measured: `时间钩子 + 话题池占比实测 ${specificShare}%（须 ≥ 60）`,
      pass: specificShare >= 60,
    },
    {
      no: 4,
      title: '连续两次主动没人回应后显著降频',
      measured:
        `被回应的一天 ${responsiveCount} 次 vs 被忽视的一天 ${unansweredCount} 次` +
        `（降频 ${100 - pct(unansweredCount, responsiveCount)}%，须 ≥ 50%）；` +
        `探针惩罚梯度 0 → ${probe.rows[1]?.['recent_unanswered_penalty']} → ${probe.rows[2]?.['recent_unanswered_penalty']} → ${probe.rows[3]?.['recent_unanswered_penalty']}（须严格递增），` +
        `连续 2 条未回应后标准沉默跟进 = ${probe.holdsAfterTwo ? '建议不说' : '仍然建议开口'}`,
      pass: probe.monotone && probe.holdsAfterTwo && unansweredCount * 2 <= responsiveCount,
    },
    {
      no: 5,
      title: '正在热聊时可以连续主动接话，不受 18 分钟 new-session cooldown 限制',
      measured: `热聊窗口内生产通路接话 ${continuationsInWindow} 次（须 ≥ 1）；热聊场景相邻开口最小间隔 ${minGap} 分钟（须 < ${settings.baseCooldownMinutes}）`,
      pass: continuationsInWindow >= 1 && minGap < settings.baseCooldownMinutes,
    },
  ];

  console.log('=== pack Phase 5 五项目标判定 ===');
  for (const verdict of verdicts) {
    console.log(`${verdict.pass ? '✅' : '❌'} ${verdict.no}. ${verdict.title}`);
    console.log(`   实测：${verdict.measured}`);
  }
  const failed = verdicts.filter((verdict) => !verdict.pass);
  console.log('');
  if (failed.length === 0) {
    console.log('结论：五项目标全部通过。');
  } else {
    console.log(`结论：${failed.map((verdict) => `${verdict.no}. ${verdict.title}`).join('；')} 未通过。`);
  }

  if (process.env['XIXI_TIMELINE_KEEP'] !== '1') {
    for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } else {
    console.log(`（XIXI_TIMELINE_KEEP=1：临时库保留在 ${roots.join(' , ')}）`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
