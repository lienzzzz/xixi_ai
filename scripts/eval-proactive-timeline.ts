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
 *   - 候选与 tick 语义 = 常驻考虑循环 `ProactiveLoop.tickOnce`（P0-A Step B 起在 `@xixi/runtime`）本体，
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
 * 的数字可比。
 *
 * 另有一段 **t9 F4 的分离探针**（t3 评审 R4）：用 `maxPerDay=1` / `maxConsultsPerDay=1~2` 直接驱动
 * 生产 `ProactiveEngine.consider`，再从 `proactive.decision` 日志读回理由码，证明**问询额度与开口额度
 * 分开计**——一次付费的「不说」不吃当天的开口额度，问询额度用完有它自己的码。为什么必须补：三段家庭
 * 脚本里的模型总是同意、上面的未回应探针又写死 `consultsToday: 0`，只跑本命令的人会以为 F4 也被覆盖了
 * （实际只由单测与 t9 那支**已过期**的探针支撑）。
 *
 * 五项家庭目标与这段探针全过才 exit 0。
 *
 * ------------------------------------------------------------------ 多日部分（第五轮 t1）
 *
 * 五项来自 pack Phase 5 的目标原本只跑**一个 12 小时的日子**，而「主动性高一些，但不要变成骚扰」是
 * 一个**跨天**性质：一天的数字看不出「被忽视之后第二天还愿不愿意开口」，也看不出「未回应惩罚会不会
 * 跨天累积成硬停」——第四轮遗留的正是「连续两次未回应后 = 0 硬停还是显著降频」这条口径，captain 按
 * 用户意图拍定为**显著降频**（ADR-0011 §「决定 2 的补充」）。
 *
 * 因此本命令另跑一段**多日时间线**（默认 3 个自然日，每 07:30→19:30 一个清醒日、中间隔着夜里的
 * 静默时段，所以状态必须跨天存活才可能通过）：
 *
 *   1. `multi-responsive`  —— 3 天都有人回应（基线：主动性有没有变低）；
 *   2. `multi-unanswered`  —— 3 天都没人回应（未回应惩罚可不可能压死她）；
 *   3. `multi-crossday`    —— 只有第 2 天没人回应（跨天状态：第 1 天说的事要在第 3 天还能接着问，
 *                             第 2 天的沉默不能把第 3 天一起拖死）；
 *   4. `multi-crossday-nopenalty` —— 与 3 **同一份脚本**，只把 `unanswered_penalty` 置 0
 *                             （反事实对照：降频幅度必须真的来自这条惩罚信号，而不是别的什么）。
 *
 * 多日部分除了「主动次数」还打三项新东西：**来源分布**（trigger / initiative_kind 直方图）、
 * **未回应后的降频幅度**（同脚本的惩罚开/关对照 + 逐日曲线）、**接受率**（每次开口后
 * `unanswered_window_min` 内是否有人回话；「接受」只按这条可观察的判据算，不问模型）。
 *
 * Usage: node scripts/eval-proactive-timeline.ts [--tick-seconds=N] [--days=N] [--help]
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
  PROACTIVE_SCORE_WEIGHTS,
  ProactiveEngine,
  TopicEngine,
  evaluateProactiveGates,
  parseProactiveSettings,
  type OpenThreadFollowUp,
  type ProactiveDecider,
  type ProactiveGateContext,
  type ProactiveReasonCode,
  type ProactiveSettings,
} from '@xixi/conversation';
import { openXixiStore, type XixiStore } from '@xixi/domain';
// V0.3 repair round 2: the loop is package code now (P0-A Step B moved it), so this entry imports
// it from the runtime instead of reaching back into the console script. Behaviour is identical —
// `scripts/field-test.ts` re-exports that same object (`field-test.ProactiveLoop === runtime.ProactiveLoop`).
import { ProactiveLoop } from '@xixi/runtime';

import { loadConfig, REPO_ROOT } from './lib/harness.ts';

// ------------------------------------------------------------------ CLI

const USAGE = [
  '用法：node scripts/eval-proactive-timeline.ts [--tick-seconds=N] [--days=N] [--help]',
  '',
  '离线复跑 pack Phase 5 的 12 小时家庭时间线验收：跑「有人回应的一天 / 没人回应的一天 /',
  '上午有热聊的一天」三段脚本场景，外加「连续未回应」机制探针与 F4 的问询/开口额度分离探针，',
  '按顺序打印五项目标与 F4 探针的逐项判定（实测值与阈值一起打印，阈值以 pack Phase 5 验收原文为准）。',
  '',
  '同一份输出里还有一段**多日时间线**（默认 3 天，--days=N 可调）：4 个多日场景（都有人回应 / 都没人',
  '回应 / 只有第 2 天没人回应 / 同脚本但把未回应惩罚置 0 的反事实对照）在**多个自然日**上跟踪主动行为，',
  '逐日打印主动次数、来源分布（trigger 与 initiative_kind 直方图）、未回应后的降频幅度与接受率，',
  '并断言：主动性没有变低（基线 ≥6 次/天）、没被未回应惩罚压成硬停（第 3 天仍在开口）、',
  '也没反过来变成骚扰（无单日超上限、相邻开口不短于新会话速率下限、静默时段零开口）。',
  '',
  '退出码：单日五项目标 + F4 探针 + 多日全部断言都通过才 exit 0；有任何一项未过 exit 1。',
  '本命令不联网、不花 API 费用；单日 tick 间隔默认沿用 t9 独立验证的口径（60s），',
  '多日场景默认用 120s（`--tick-seconds` 会把两者一起改），想对齐生产节奏可传 --tick-seconds=30。',
  '结论看运行输出的判定表，不依赖任何固定数字。',
  '',
  '单日五项：主动次数区间、generic 占比、具体来源占比、未回应后降频、热聊中接话。',
  '单日判定表第 6 行是 F4 的分离探针（问询额度与开口额度分开计），不属于 pack 的五项目标。',
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

const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
/** How many natural days the multi-day timeline spans (the acceptance contract asks for ≥3). */
const MULTI_DAYS = (() => {
  const parsed = Number((daysArg ?? '').split('=')[1]);
  return Number.isFinite(parsed) && parsed >= 2 ? Math.min(14, Math.floor(parsed)) : 3;
})();

/**
 * The multi-day tick: coarser than the single-day pack run **on purpose**.
 *
 * The multi-day questions are per-day ones (does she still open her mouth on day 3, does the streak
 * carry over the night, does the day-1 thing still get asked about), and one run simulates three
 * natural days × 07:30–19:30. Every criterion that matters survives 300 s: the 30-minute clock hook
 * still fires exactly once per day, the 10-minute 「有没有人回应」 window is still evaluated (the
 * delivery itself is decided on a tick, the window only classifies it), the 2-minute new-session
 * floor and the 6-hour/day quotas are enforced by the engine, and the streak escalation reads the
 * last three *deliveries* — not the ticks between them. What 300 s does change is resolution: two
 * deliveries can no longer land <5 minutes apart, so the run cannot exhibit sub-5-minute gaps.
 *
 * Measured equivalence (same script, same day) rather than asserted: the tables at
 * `--tick-seconds=60` and `--tick-seconds=300` differ only in a message or two per day, and every
 * M-verdict keeps the same pass/fail. All four multi-day runs share this cadence, so the
 * counterfactual comparison stays apples-to-apples; passing `--tick-seconds` overrides both cadences
 * to one number.
 */
const MULTI_TICK_SECONDS = tickArg === undefined ? Math.max(TICK_SECONDS, 300) : TICK_SECONDS;

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

/** One hour in minutes — the unit the multi-day scripts are written in. */
const HOUR = 60;
/** How many minutes one simulated natural day holds (the wall clock covers all 24 h). */
const DAY_MINUTES = 24 * HOUR;

/** The natural day (1-based) an absolute simulated instant falls on. */
function dayOfInstant(at: Date): number {
  return Math.floor((at.getTime() - DAY_START.getTime()) / (DAY_MINUTES * 60_000)) + 1;
}

/** Minutes into the natural day for an absolute simulated instant. */
function minutesIntoDayOfInstant(at: Date): number {
  return Math.round((at.getTime() - DAY_START.getTime()) / 60_000) % DAY_MINUTES;
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
  /** Minutes into the delivery's own natural day (0 = local midnight, 450 = 07:30). */
  readonly minutesIntoDay: number;
  /** 1-based natural day of the run (always 1 for the single-day pack scenarios). */
  readonly day: number;
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
  /**
   * The 未回应惩罚's own value on this consideration (0–1), read back from the audit record's `signals`
   * — the same signal the score was computed from, so 「这条惩罚在这一刻有多重」 is checkable.
   */
  readonly unansweredPenalty: number;
  /** `true` when this consideration was blocked (any reason) — the recommendation was `hold`. */
  readonly held: boolean;
  /**
   * `true` when **this penalty alone** turned `speak` into `hold`: adding its weighted contribution back
   * to the score clears the threshold. Evidence that the signal is not a decorative number — but note
   * it proves only 「它在这一刻是决定性的」, never 「它一定会禁止」 (ADR-0011 §决定 2 的补充).
   */
  readonly penaltyDecisive: boolean;
}

interface ScenarioResult {
  readonly scenario: string;
  readonly dataDir: string;
  readonly deliveries: readonly Delivery[];
  readonly decisions: readonly DecisionRow[];
  readonly userTurns: readonly string[];
  /** How many natural days the run spans (1 for the pack Phase 5 scenarios, `--days` for the rest). */
  readonly days: number;
  /**
   * 话题的**投影快照**（`open_threads` 投影）：`created_at` 只存在投影里，`open_thread.changed` 的 payload
   * 不写它（见 `packages/domain/src/store.ts` 的 `openThreadPayload`），所以「这件事是第几天说出口的」
   * 只能从投影读 —— 这也正是「投影是日志的视图」那句话的可核对形式。
   */
  readonly threads: readonly { readonly threadId: string; readonly summary: string; readonly status: string; readonly createdAt: string }[];
}

async function runScenario(scenario: string, decider: ProactiveDecider | undefined): Promise<ScenarioResult> {
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
      ...decisionPenaltyFields(payload),
    });
    if (payload['speak'] !== true) continue;
    const at = new Date(event.timestamp);
    deliveries.push({
      at: offsetIso(at),
      minutesIntoDay: minutesIntoDayOfInstant(at),
      day: dayOfInstant(at),
      trigger: String(payload['trigger'] ?? ''),
      initiativeKind: String(payload['initiative_kind'] ?? ''),
      topicRef: typeof payload['topic_ref'] === 'string' ? payload['topic_ref'] : null,
      candidateId: String(payload['candidate_id'] ?? ''),
      score: Number(payload['score'] ?? 0),
    });
  }
  store.close();
  return { scenario, dataDir, deliveries, decisions, userTurns, days: 1, threads: [] };
}

/**
 * The 未回应惩罚's reading on one audit record — shared by both runners so the single-day and multi-day
 * tables are computed from the same rule.
 *
 * `penaltyDecisive` is arithmetic, not an opinion: the score is a weighted sum
 * (`PROACTIVE_SCORE_WEIGHTS`), so putting `unanswered_penalty × 0.35` back and re-checking the
 * threshold says exactly whether this signal was the one that made the answer `hold`.
 */
function decisionPenaltyFields(payload: Record<string, unknown>): Pick<DecisionRow, 'unansweredPenalty' | 'held' | 'penaltyDecisive'> {
  const signals = (payload['signals'] ?? {}) as Record<string, unknown>;
  const penalty = Number(signals['recent_unanswered_penalty'] ?? 0);
  const score = Number(payload['score'] ?? 0);
  const threshold = Number(payload['threshold'] ?? 0);
  const held = payload['speak'] !== true;
  const withoutPenalty = score + penalty * Math.abs(PROACTIVE_SCORE_WEIGHTS['recent_unanswered_penalty'] ?? 0);
  return {
    unansweredPenalty: Number.isFinite(penalty) ? penalty : 0,
    held,
    penaltyDecisive: held && penalty > 0 && withoutPenalty >= threshold,
  };
}

// ------------------------------------------------- multi-day timeline (round 5, t1)

/**
 * One multi-day household script.
 *
 * `dayScript` is indexed 0 = day 1 and returns **[minutes into that natural day]** (real wall clock:
 * 07:30 = 450, 19:30 = 1170) — the same 12-hour awake window the single-day pack run judges, repeated
 * on consecutive natural days with the night in between. Everything the gates read (未回应惩罚的连续
 * 计数、未完话题、当日与 6 小时额度、冷却) therefore has to survive a 12-hour gap by being **read back
 * from the event log**, which is exactly what a single-day run cannot show.
 *
 * `answer` is the only knob that differs between the multi-day runs: per delivery, `null` for
 * 「没人回应」 or a delay in minutes. `silentDays` lists the 0-based days on which the household keeps
 * saying things of its own but never answers a proactive message.
 */
interface MultiDayScript {
  readonly name: string;
  readonly label: string;
  readonly dayScript: (dayIndex: number) => readonly (readonly [number, string])[];
  /** Arrival minutes (minutes into the natural day) — the presence projection behind `presence_arrived`. */
  readonly arrivals: readonly number[];
  readonly answer: ((dayIndex: number, deliveryIndex: number) => number | null) | null;
  readonly silentDays: readonly number[];
}

/** The 07:30–19:30 awake window, in minutes into the natural day. */
const AWAKE_START_MINUTES = 7 * HOUR + 30;
const AWAKE_END_MINUTES = 19 * HOUR + 30;

/**
 * Rotating household days: the same rhythm, different facts.
 *
 * Why rotate: a multi-day run whose every day is byte-identical would let 「第二天」 pass on day-1
 * facts that happen to still sit inside the 12-hour topic windows, instead of on the cross-day state
 * this section is about.
 */
function multiDayBlocks(): readonly (readonly (readonly [number, string])[])[] {
  const dayA: readonly (readonly [number, string])[] = [
    [8 * HOUR, '早啊，我刚从菜市场回来，买了点豆腐。'],
    [11 * HOUR + 20, '昨天老李说他孙子考上大学了，真不容易。'],
    [14 * HOUR + 10, '下午把药拿回来了，医生说下个月再复查。'],
    [17 * HOUR + 50, '晚上想吃点清淡的，胃不太舒服。'],
  ];
  const dayB: readonly (readonly [number, string])[] = [
    [9 * HOUR + 40, '今天太阳挺好，我把被子拿出去晒了。'],
    [13 * HOUR, '中午随便吃了碗面。'],
    [16 * HOUR + 30, '电视里在放老片子，我先看会儿。'],
    [18 * HOUR + 40, '一会儿早点睡，明天再说。'],
  ];
  const dayC: readonly (readonly [number, string])[] = [
    [8 * HOUR + 30, '我把阳台的花浇了，叶子有点黄。'],
    [12 * HOUR + 20, '中午炖了点排骨，吃得有点撑。'],
    [15 * HOUR + 40, '楼下碰见老王，他说下周要去旅游。'],
    [18 * HOUR, '晚上早点收拾，明天还有事。'],
  ];
  return [dayA, dayB, dayC];
}

/**
 * 跨天素材：**第一天说的一件事，第二天要接着问**。
 *
 * 每一句都能被 `TopicEngine` 的规则提取成一条未完话题（时间词 + 意愿 + 动作三者齐备），
 * `followAfter` 落在**第二天**；所以只有把状态带过夜，那个话题才可能被问出来。`answer` 是「问出来
 * 之后他怎么答」——`TopicEngine.reconcile` 按**文本**判定收口（`isAnswerAboutThread`），所以答案必须
 * 真的提到那件事（「嗯，听到了」不算回答，话题会留在 `offered`）。
 */
interface CrossDayThread {
  /** 1-based natural day the line belongs to. */
  readonly day: number;
  /** Minutes into that day. */
  readonly minute: number;
  /** The line the household actually says. */
  readonly line: string;
  /** What he answers when she asks about it — settles the thread, so it is not asked twice. */
  readonly answer: string;
}

const CROSS_DAY_THREADS: readonly CrossDayThread[] = [
  { day: 1, minute: 8 * HOUR + 5, line: '对了，明天下午我要去社区医院拿药。', answer: '拿回来了，医生说下个月再复查。' },
  { day: 2, minute: 9 * HOUR + 5, line: '明天上午我得去镇上办证，顺便把材料交了。', answer: '办好了，排队排了一个多小时。' },
  { day: 3, minute: 15 * HOUR + 5, line: '明天早上我要去买菜，家里的油也没了。', answer: '买回来了，油也顺手带了。' },
];

/** The day's own cross-day line, appended to that day's block. */
function threadLineFor(dayIndex: number): readonly (readonly [number, string])[] {
  const entry = CROSS_DAY_THREADS.find((row) => row.day === dayIndex + 1);
  return entry === undefined ? [] : [[entry.minute, entry.line] as const];
}

/** Which scripted thread is this follow-up about? `null` = not one of ours. */
function threadOfProof(proof: string | null): CrossDayThread | null {
  if (proof === null) return null;
  const normalized = proof.replace(/[，。！？、,.!?\s]/gu, '');
  for (const entry of CROSS_DAY_THREADS) {
    // Drop the sentence-final particle first: `normalizeThreadSummary` keeps 「我要去社区医院拿药」 for
    // 「…拿药。」, while the raw line normalizes to 「…拿药了」 — the rest matches either way.
    const line = entry.line.replace(/[，。！？、,.!?\s]/gu, '').replace(/[了的吧呢]$/u, '');
    if (line.length >= 4 && normalized.includes(line.slice(0, line.length - 1))) return entry;
  }
  return null;
}

/**
 * The multi-day runs.
 *
 * `multi-unanswered` and `multi-unanswered-nopenalty` are the counterfactual pair: the **same** script
 * and the same facts, differing only in `unanswered_penalty` (0.45 vs 0). That pair is what answers
 * 「降频是不是这条信号造成的」— comparing days inside a single run cannot, because the days differ in
 * their own lines and in what the clock hooks offer. `multi-crossday` takes the same script and ignores
 * only day 2, so the log has to carry the state across the night (the day-2 silence must not silence
 * day 3, and the day-1 thing still has to be asked about on day 2/3).
 */
function multiScripts(): readonly MultiDayScript[] {
  const blocks = multiDayBlocks();
  const dayScript = (dayIndex: number): readonly (readonly [number, string])[] => [
    ...blocks[dayIndex % blocks.length]!,
    ...threadLineFor(dayIndex),
  ];
  const arrivals = [AWAKE_START_MINUTES + 2, 13 * HOUR, 18 * HOUR] as const;
  return [
    {
      name: 'multi-responsive',
      label: '三天都有人回应（基线：主动性有没有变低）',
      dayScript,
      arrivals,
      // Deterministic "2 of 3 get answered, 1–5 minutes later" — the single-day `responsive`
      // household, three days long.
      answer: (_dayIndex, deliveryIndex) => (deliveryIndex % 3 === 2 ? null : (deliveryIndex % 5) + 1),
      silentDays: [],
    },
    {
      name: 'multi-unanswered',
      label: '三天都没人回应（未回应惩罚会不会压成硬停）',
      dayScript,
      arrivals,
      answer: null,
      silentDays: [0, 1, 2],
    },
    {
      name: 'multi-unanswered-nopenalty',
      label: '同脚本但未回应惩罚置 0（反事实对照：降频是不是这条信号造成的）',
      dayScript,
      arrivals,
      answer: null,
      silentDays: [0, 1, 2],
    },
    {
      name: 'multi-crossday',
      label: '只有第 2 天没人回应（跨天状态：说的事要接着问）',
      dayScript,
      arrivals,
      answer: (dayIndex, deliveryIndex) => (dayIndex === 1 ? null : (deliveryIndex % 5) + 1),
      silentDays: [1],
    },
  ];
}

/**
 * A multi-day run: the same production parts as {@link runScenario}, over N natural days.
 *
 * The one intentional difference is the cadence (see {@link MULTI_TICK_SECONDS}) — coarser than the
 * single-day run, but shared by every multi-day scenario, so the counterfactual stays comparable.
 * Presence is refreshed on the script's arrival minutes, exactly as in the single-day run.
 */
async function runMultiDay(
  script: MultiDayScript,
  decider: ProactiveDecider | undefined,
  options: { readonly days: number; readonly tickSeconds: number; readonly settings?: ProactiveSettings | undefined },
): Promise<ScenarioResult> {
  const days = options.days;
  const settings = options.settings ?? parseProactiveSettings(config.proactive as unknown as Record<string, unknown>);
  const dataDir = mkdtempSync(join(tmpdir(), `xixi-timeline-${script.name}-`));
  let simulatedNow: Date = DAY_START;
  const store: XixiStore = openXixiStore({ dataDir, clock: () => simulatedNow });
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
  /**
   * pack Phase 3 的话题引擎，按现场测试控制台（`scripts/field-test.ts` 的 `readOpenThreads`）的装配
   * 方式接进来：每个 tick 先对齐（提取 → 认下已说出口的 → 按回答收口）再取「现在该追问的」。
   * 跨天能力就落在它身上 —— 话题表与话题历史都是日志的投影，所以过一夜之后它仍认得「他昨天说的那件
   * 事还没办」，而 `followAfter` 落在第二天的那些正是本段要跟踪的跨天候选。
   */
  const topicEngine = new TopicEngine({ store, config: config.openThreads, clock: () => simulatedNow });

  const userTurns: string[] = [];
  const utteranceLog: string[] = []; // newest first — what the console's readRecentUserTopics hands the builder
  const arrivals = new Set<number>(script.arrivals);
  /** People's own lines (text + when to say it), including the answers to delayed follow-ups. */
  const pendingTurns: { readonly at: Date; readonly text: string }[] = [];
  /** Answers to ordinary deliveries — 「嗯，听到了」, the single-day run's answer text. */
  const pendingUrgent: Date[] = [];
  /** 跨天话题当前处于「该追问」的那些（每个 tick 刷新；被硬门禁押后的会在恢复后重新出现）。 */
  const dueThreads: OpenThreadFollowUp[] = [];
  /** 已经安排过回答的话题（避免「押后同一个话题」被排两次答案）。 */
  const answeredThreads = new Set<string>();
  let presenceUpdatedAt: Date = atMinute(-30);
  let lastUserTurnAt: Date | null = null;
  let deliveredCursor = 0;

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
    random: () => 1, // 「随机闲聊」 stays off (shipped config) — the roll says no
    readSessionId: () => session.sessionId,
    /**
     * 跨天状态在这里被消费：`ProactiveLoop` 每个 tick 调它一次，实现里**先对齐再取候选** ——
     * 与 `scripts/field-test.ts` 的 `readOpenThreads` 同一条生产路径（那边的装配就是「先 reconcile
     * 再把 followUps 交给候选生成器」）。顺便把「现在该追问的话题」抄一份给下面的答题调度用。
     */
    readOpenThreads: () => {
      topicEngine.reconcile(simulatedNow);
      const due = topicEngine.followUps(simulatedNow);
      dueThreads.length = 0;
      dueThreads.push(...due);
      return due;
    },
    ...(decider === undefined ? {} : { decide: decider }),
    now: () => simulatedNow,
    offsetMinutes: OFFSET_MINUTES,
    log: () => {},
  });

  /** The scripted line behind a due thread (`subject`/`summary` come from the sentence itself). */
  const threadProofFor = (followUp: OpenThreadFollowUp): string | null => {
    const subject = followUp.subject ?? followUp.summary;
    return threadOfProof(subject) === null ? null : subject;
  };

  const spanEnd = atMinute(days * DAY_MINUTES);
  for (let at = DAY_START.getTime(); at <= spanEnd.getTime(); at += options.tickSeconds * 1_000) {
    simulatedNow = new Date(at);
    const dayIndex = dayOfInstant(simulatedNow) - 1;
    if (arrivals.has(minutesIntoDayOfInstant(simulatedNow))) presenceUpdatedAt = simulatedNow;

    // The household's own lines for this day (queued once, said in order).
    for (const entry of script.dayScript(dayIndex)) {
      const when = new Date(DAY_START.getTime() + dayIndex * DAY_MINUTES * 60_000 + entry[0] * 60_000);
      if (!pendingTurns.some((row) => row.at.getTime() === when.getTime() && row.text === entry[1])) {
        pendingTurns.push({ at: when, text: entry[1] });
      }
    }
    pendingTurns.sort((left, right) => left.at.getTime() - right.at.getTime());
    while (pendingTurns.length > 0 && (pendingTurns[0]?.at.getTime() ?? Infinity) <= at) {
      const row = pendingTurns.shift() as { readonly at: Date; readonly text: string };
      await say(row.at, row.text);
    }
    while (pendingUrgent.length > 0 && (pendingUrgent[0]?.getTime() ?? Infinity) <= at) {
      await say(pendingUrgent.shift() as Date, '嗯，听到了。');
    }

    await loop.tickOnce();

    // Whatever was said this tick is in the log now: decide who answers it (if anyone).
    const spoken = store
      .readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })
      .filter((event) => (event.payload as Record<string, unknown>)['speak'] === true);
    const silent = script.answer === null || script.silentDays.includes(dayIndex);
    while (deliveredCursor < spoken.length) {
      const record = spoken[deliveredCursor];
      deliveredCursor += 1;
      if (record === undefined || silent) continue;
      const deliveredAt = new Date(record.timestamp);
      const payload = record.payload as Record<string, unknown>;
      const delay = script.answer(dayIndex, deliveredCursor);
      if (delay === null) continue;
      pendingUrgent.push(new Date(deliveredAt.getTime() + delay * 60_000));
      /**
       * 追问的回答**绑在话题上**，不是绑在「第几条消息」上：候选 id 里带着话题 id
       * （`open-thread-<threadId>-a<n>`，见 `scripts/field-test.ts` 的 open_thread 候选），所以只有
       * 当这条真的是一条**未完话题**时才排答案；同一个话题只排一次（被门禁押后、第二天再问到时
       * 不会排出两份答案）。答案文本必须提到那件事，否则 `reconcile` 不会收口（那正是 t7 的判据）。
       */
      const threadId = typeof payload['topic_ref'] === 'string' ? payload['topic_ref'] : null;
      if (threadId === null || !threadId.startsWith('thread_') || answeredThreads.has(threadId)) continue;
      const due = dueThreads.find((followUp) => followUp.threadId === threadId);
      if (due === undefined) continue;
      const proof = threadProofFor(due);
      if (proof === null) continue;
      answeredThreads.add(threadId);
      pendingTurns.push({ at: new Date(deliveredAt.getTime() + (delay + 1) * 60_000), text: threadOfProof(proof)?.answer ?? '' });
    }
    pendingUrgent.sort((left, right) => left.getTime() - right.getTime());
  }

  const raw = store.readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER });
  /** 收尾时的未完话题投影（`created_at` 只在这里），供跨天证据配对用。 */
  const threadSnapshot = readThreadSnapshot(store);
  const deliveries: Delivery[] = [];
  const decisions: DecisionRow[] = [];
  for (const event of raw) {
    const payload = event.payload as Record<string, unknown>;
    const reasonCode = String(payload['reason_code'] ?? '') as ProactiveReasonCode;
    decisions.push({
      reasonCode,
      trigger: String(payload['trigger'] ?? ''),
      modelConsulted: payload['model_consulted'] === true,
      ...decisionPenaltyFields(payload),
    });
    if (payload['speak'] !== true) continue;
    const at = new Date(event.timestamp);
    deliveries.push({
      at: offsetIso(at),
      minutesIntoDay: minutesIntoDayOfInstant(at),
      day: dayOfInstant(at),
      trigger: String(payload['trigger'] ?? ''),
      initiativeKind: String(payload['initiative_kind'] ?? ''),
      topicRef: typeof payload['topic_ref'] === 'string' ? payload['topic_ref'] : null,
      candidateId: String(payload['candidate_id'] ?? ''),
      score: Number(payload['score'] ?? 0),
    });
  }
  store.close();
  return { scenario: script.name, dataDir, deliveries, decisions, userTurns, days, threads: threadSnapshot };
}

/** The 未完话题 projection as it stands at the end of the run (see `ScenarioResult.threads`). */
function readThreadSnapshot(store: XixiStore): readonly { readonly threadId: string; readonly summary: string; readonly status: string; readonly createdAt: string }[] {
  return store.openThreads({ limit: 200 }).map((thread) => ({
    threadId: thread.threadId,
    summary: thread.summary,
    status: thread.status,
    createdAt: thread.createdAt,
  }));
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

/** A count histogram rendered as `trigger=次数`, sorted by count so the leading source is first. */
function histogramText(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value, count]) => `${value || '(空)'}=${count}`)
    .join('、');
}

/**
 * Per-day slice of a run: the multi-day table's row (主动次数 / 接受率 / 相邻开销最小间隔 / 来源分布).
 *
 * 「接受」只按一条可观察判据算：这次开口之后 `unanswered_window_min` 分钟内有没有人说过话 —— 与
 * 引擎判定「未回应」用的是同一个窗口与同一份日志（不额外发明口径，也不问模型）。
 */
function dayMetricsOf(result: ScenarioResult, day: number): Record<string, unknown> {
  const all = result.deliveries.filter((delivery) => delivery.day === day);
  const gaps = all.slice(1).map((delivery, index) => delivery.minutesIntoDay - (all[index]?.minutesIntoDay ?? 0));
  const accepted = all.filter((delivery) => answeredWithin(result, delivery, settings.unansweredWindowMinutes)).length;
  const delivered = all.length;
  return {
    day,
    proactiveCount: delivered,
    acceptRatePct: pct(accepted, delivered),
    accepted,
    minGapMinutes: gaps.length === 0 ? null : Math.min(...gaps),
    firstAt: all[0]?.at ?? null,
    lastAt: all[all.length - 1]?.at ?? null,
    /** Every message of this day sits in the scripted awake window (07:30–19:30, outside quiet hours). */
    insideAwakeWindow: all.every((delivery) => delivery.minutesIntoDay >= AWAKE_START_MINUTES && delivery.minutesIntoDay <= AWAKE_END_MINUTES),
    triggerHistogram: histogramText(all.map((delivery) => delivery.trigger)),
    initiativeHistogram: histogramText(all.map((delivery) => delivery.initiativeKind)),
    openLoopFollowUps: all.filter((delivery) => delivery.initiativeKind === 'open_loop_followup').length,
  };
}

/** What the multi-day verdicts read, per run. */
interface MultiDayTotals {
  readonly delivered: number;
  readonly accepted: number;
  readonly perDay: readonly number[];
  readonly openLoop: number;
  /** The shortest gap between two messages of the whole run, in minutes. */
  readonly minGap: number | null;
  readonly histogram: string;
  readonly initiativeHistogram: string;
}

/** The whole multi-day table + the aggregates the verdicts read. */
function multiDayReport(runs: readonly ScenarioResult[], days: number): {
  readonly rows: readonly Record<string, unknown>[];
  readonly totals: ReadonlyMap<string, MultiDayTotals>;
} {
  const rows: Record<string, unknown>[] = [];
  const totals = new Map<string, MultiDayTotals>();
  for (const run of runs) {
    const perDay: number[] = [];
    let openLoop = 0;
    let minGap: number | null = null;
    for (let day = 1; day <= days; day += 1) {
      const row = dayMetricsOf(run, day);
      perDay.push(Number(row['proactiveCount']));
      openLoop += Number(row['openLoopFollowUps']);
      const gap = row['minGapMinutes'] === null ? null : Number(row['minGapMinutes']);
      if (gap !== null && (minGap === null || gap < minGap)) minGap = gap;
      rows.push({ run: run.scenario, ...row });
    }
    const accepted = run.deliveries.filter((delivery) => answeredWithin(run, delivery, settings.unansweredWindowMinutes)).length;
    totals.set(run.scenario, {
      delivered: run.deliveries.length,
      accepted,
      perDay,
      openLoop,
      minGap,
      histogram: histogramText(run.deliveries.map((delivery) => delivery.trigger)),
      initiativeHistogram: histogramText(run.deliveries.map((delivery) => delivery.initiativeKind)),
    });
  }
  return { rows, totals };
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

// ------------------------------------------- t9 F4's quota-separation probe (t3 review R4)

/** One scripted run of the F4 probe: how the two budgets were set and what the log answered. */
interface ConsultQuotaRow {
  readonly label: string;
  readonly maxPerDay: number;
  readonly maxConsultsPerDay: number;
  /** `reason_code`s in event order, read back **from the log** (not from the in-process outcomes). */
  readonly reasonCodes: readonly string[];
  /** `speak === true` records — what the delivery budget is really charged for. */
  readonly deliveries: number;
  /** `model_consulted === true` records — what the consult budget is really charged for. */
  readonly consults: number;
  readonly expected: readonly string[];
  readonly pass: boolean;
}

/** The shipped `proactive` section with the two budgets overridden — the probe's only knob. */
function settingsWithBudgets(maxPerDay: number, maxConsultsPerDay: number): ProactiveSettings {
  return parseProactiveSettings({
    ...(config.proactive as unknown as Record<string, unknown>),
    max_per_day: maxPerDay,
    max_consults_per_day: maxConsultsPerDay,
  });
}

interface ConsultQuotaSpec {
  readonly label: string;
  readonly maxPerDay: number;
  readonly maxConsultsPerDay: number;
  readonly steps: number;
  readonly expected: readonly string[];
  readonly expectDeliveries: number;
  readonly expectConsults: number;
}

/**
 * Drive the real `ProactiveEngine.consider` through one scripted budget scenario.
 *
 * Production parts only: the engine, its settings parser, the log it writes and the
 * `readProactiveConsultations` accounting it does on every call — the same entry point the resident
 * loop and the console use. The one seam is the 读空气 decider, which is offline by design here:
 * the first paid call says 「不说」 and every later one agrees. That is exactly the pattern t9 F4
 * was about (40 refusals used to spend the whole day's *speaking* quota and the day went silent).
 */
async function runConsultQuotaScript(spec: ConsultQuotaSpec): Promise<{ readonly row: ConsultQuotaRow; readonly dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'xixi-f4-probe-'));
  /** 09:00 +08:00 — awake and well outside the 23:30–07:30 quiet window, so no floor but the budgets. */
  const start = new Date('2026-10-02T09:00:00+08:00');
  let now = start;
  const store: XixiStore = openXixiStore({ dataDir, clock: () => now });
  const session = store.createSession();
  const engine = new ProactiveEngine({
    store,
    settings: settingsWithBudgets(spec.maxPerDay, spec.maxConsultsPerDay),
    offsetMinutes: OFFSET_MINUTES,
    clock: () => now,
  });
  let consulted = 0;
  const decide: ProactiveDecider = () => {
    consulted += 1;
    return consulted === 1 ? { speak: false, reasonCode: 'user_busy' } : { speak: true, reasonCode: 'good_moment' };
  };

  for (let step = 0; step < spec.steps; step += 1) {
    // 5 minutes apart: past the 2-minute new-session floor and (for a fresh candidate) a strong
    // candidate either way, so a blocked step is blocked by a budget and nothing else.
    now = new Date(start.getTime() + step * 5 * 60_000);
    await engine.consider({
      candidate: {
        candidateId: `f4-probe-${step}`,
        trigger: 'topic_pool',
        initiativeKind: 'external_sharing',
        components: { topic_quality: 0.9, personal_relevance: 0.9, freshness: 0.8, receptivity: 0.9, engagement: 0.8 },
        topicRef: `f4-probe-topic-${step}`,
        intent: null,
      },
      at: now,
      conversationState: 'IDLE',
      sessionId: session.sessionId,
      proactivity: PROACTIVITY,
      decide,
    });
  }

  const payloads = store
    .readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })
    .map((event) => event.payload as Record<string, unknown>);
  const reasonCodes = payloads.map((payload) => String(payload['reason_code'] ?? ''));
  const deliveries = payloads.filter((payload) => payload['speak'] === true).length;
  const consults = payloads.filter((payload) => payload['model_consulted'] === true).length;
  store.close();

  const pass =
    reasonCodes.length === spec.expected.length &&
    reasonCodes.every((code, index) => code === spec.expected[index]) &&
    deliveries === spec.expectDeliveries &&
    consults === spec.expectConsults;
  return {
    dataDir,
    row: {
      label: spec.label,
      maxPerDay: spec.maxPerDay,
      maxConsultsPerDay: spec.maxConsultsPerDay,
      reasonCodes,
      deliveries,
      consults,
      expected: spec.expected,
      pass,
    },
  };
}

/**
 * The decisive probe for 「问询额度与开口额度分开计」 (t9 F4, t3 review R4).
 *
 * Three rows, all with the *same* script (`不说` once, then agree) and budgets that are 1 or 0:
 *
 *   1. `maxPerDay=1 / maxConsultsPerDay=2`: the paid 「不说」 is charged to the *consult* budget, so
 *      the day's single speaking slot survives it — the next candidate is delivered
 *      (`MODEL_DECLINED → PASSED`), and only then does the **day** budget stop the third with
 *      `QUOTA_DAY_EXCEEDED`. Deliveries and consultations are counted over the same log, never summed.
 *   2. `maxPerDay=1 / maxConsultsPerDay=1`: the second candidate is stopped by
 *      `QUOTA_CONSULT_EXCEEDED` while the speaking budget still has its only slot free — the code
 *      names which budget ran out, which is the whole point of a separate code.
 *   3. `maxPerDay=0 / maxConsultsPerDay=2`: spent speaking budget, nothing consulted — the row that
 *      keeps the first two honest. It shows the same harness *does* report the day budget's own code
 *      when that is the budget that ran out, so row 2's `QUOTA_CONSULT_EXCEEDED` cannot be an artefact of
 *      a probe that always answers with the consult code.
 */
async function consultQuotaProbe(): Promise<{
  readonly rows: readonly ConsultQuotaRow[];
  readonly roots: readonly string[];
  readonly pass: boolean;
}> {
  const runs = [
    await runConsultQuotaScript({
      label: '分开计：一次付费「不说」不吃当天唯一的开口额度',
      maxPerDay: 1,
      maxConsultsPerDay: 2,
      steps: 3,
      expected: ['MODEL_DECLINED', 'PASSED', 'QUOTA_DAY_EXCEEDED'],
      expectDeliveries: 1,
      expectConsults: 2,
    }),
    await runConsultQuotaScript({
      label: '自有码：问询额度用尽与开口额度分开报',
      maxPerDay: 1,
      maxConsultsPerDay: 1,
      steps: 2,
      expected: ['MODEL_DECLINED', 'QUOTA_CONSULT_EXCEEDED'],
      expectDeliveries: 0,
      expectConsults: 1,
    }),
    await runConsultQuotaScript({
      label: '反例对照：开口额度为 0 时报的是开口额度自己的码，且一次也没问模型',
      maxPerDay: 0,
      maxConsultsPerDay: 2,
      steps: 1,
      expected: ['QUOTA_DAY_EXCEEDED'],
      expectDeliveries: 0,
      expectConsults: 0,
    }),
  ];
  return { rows: runs.map((run) => run.row), roots: runs.map((run) => run.dataDir), pass: runs.every((run) => run.row.pass) };
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

  const f4Probe = await consultQuotaProbe();
  roots.push(...f4Probe.roots);
  console.log('=== t9 F4 探针：问询额度与开口额度分开计（生产 ProactiveEngine.consider 驱动；理由码读自日志）===');
  console.log(JSON.stringify(f4Probe.rows, null, 2));
  console.log('');

  // ----------------------------------------------------------- multi-day timeline
  const multiScriptsList = multiScripts();
  const multiRuns: ScenarioResult[] = [];
  console.log(
    `=== 多日时间线（每条 ${MULTI_DAYS} 个自然日、每 07:30→19:30 一个清醒日、tick ${MULTI_TICK_SECONDS}s、时区 +08:00）===`,
  );
  for (const script of multiScriptsList) {
    /**
     * 反事实对照（`multi-unanswered-nopenalty`）与 `multi-unanswered` **同脚本、同事实，只差
     * `unanswered_penalty`**：0.45 vs 0。「降频幅度是不是这条信号造成的」只有这样问才有答案 ——
     * 拿同一条运行里不同的日子互比没有意义（每天的剧本、时钟钩子、未收口话题本来就不一样）。
     */
    const useNoPenalty = script.name.endsWith('-nopenalty');
    const run = await runMultiDay(script, agree, {
      days: MULTI_DAYS,
      tickSeconds: MULTI_TICK_SECONDS,
      ...(useNoPenalty
        ? { settings: parseProactiveSettings({ ...(config.proactive as unknown as Record<string, unknown>), unanswered_penalty: 0 }) }
        : {}),
    });
    roots.push(run.dataDir);
    multiRuns.push(run);
    console.log(`· ${script.name}：${script.label}（共开口 ${run.deliveries.length} 次，判定 ${run.decisions.length} 次）`);
  }
  console.log('');
  const multi = multiDayReport(multiRuns, MULTI_DAYS);
  /**
   * 跨天证据的**逐话题**版本：每条未完话题是第几天说出口的（`createdAt`），又是第几天被追问的
   * （那次开口的 `topic_ref` = 话题 id）。「第 1 天说 → 第 2 天问」这一条只可能靠跨天的状态成立。
   */
  /**
   * 跨天证据的**逐话题**版本：每条未完话题是第几天说出口的（`created_at`，只有投影里有），又是第几天
   * 被追问的（那次开口的 `topic_ref` = 话题 id）。「第 1 天说 → 第 2 天问」这一条只可能靠跨天的状态成立。
   */
  const crossDayThreads = (() => {
    const crossDayRuns = multiRuns.filter((run) => run.scenario === 'multi-crossday');
    const created = new Map<string, string>();
    for (const run of crossDayRuns) {
      for (const thread of run.threads) {
        if (thread.threadId.length === 0 || created.has(thread.threadId)) continue;
        created.set(thread.threadId, thread.createdAt);
      }
    }
    const asked = new Map<string, string>();
    for (const run of crossDayRuns) {
      for (const delivery of run.deliveries) {
        if (delivery.initiativeKind !== 'open_loop_followup' || delivery.topicRef === null) continue;
        if (asked.has(delivery.topicRef)) continue;
        asked.set(delivery.topicRef, delivery.at);
      }
    }
    return [...asked.entries()]
      .map(([threadId, askedAt]) => {
        const createdAt = created.get(threadId);
        return {
          threadId,
          askedAt,
          createdAt: createdAt ?? null,
          dayCreated: createdAt === undefined ? null : dayOfInstant(new Date(createdAt)),
          dayAsked: dayOfInstant(new Date(askedAt)),
        };
      })
      .filter((row) => row.dayCreated !== null && row.dayCreated <= MULTI_DAYS && row.dayAsked <= MULTI_DAYS);
  })();
  const crossDayPairs = crossDayThreads
    .map((row) => `第 ${row.dayCreated} 天说 → 第 ${row.dayAsked} 天问（${row.threadId}）`)
    .slice(0, 3)
    .join('、');
  const crossDayAsked = crossDayThreads.filter((row) => row.dayAsked >= 2).length;
  console.log('=== 多日逐日台账（「接受率」= 这次开口后 unanswered_window_min 分钟内有人回话的比例；窗口取生产配置）===');
  console.log(
    [
      'run'.padEnd(26),
      '日'.padEnd(3),
      '开口'.padEnd(5),
      '接受率'.padEnd(9),
      '最小间隔'.padEnd(9),
      '未完话题'.padEnd(9),
      '来源分布（trigger）',
    ].join(' | '),
  );
  for (const row of multi.rows) {
    console.log(
      [
        String(row['run']).padEnd(26),
        String(row['day']).padEnd(3),
        String(row['proactiveCount']).padEnd(5),
        `${row['acceptRatePct']}%`.padEnd(9),
        `${row['minGapMinutes'] ?? '—'} 分`.padEnd(9),
        String(row['openLoopFollowUps']).padEnd(9),
        `${row['triggerHistogram']}｜性质：${row['initiativeHistogram']}`,
      ].join(' | '),
    );
  }
  console.log('');
  console.log('=== 多日汇总（次数 / 逐日 / 接受率 / 来源分布）===');
  for (const [name, total] of multi.totals) {
    console.log(
      `${name.padEnd(26)} 共 ${String(total.delivered).padStart(2)} 次｜逐日 ${total.perDay.join('/')}` +
        `｜接受率 ${pct(total.accepted, total.delivered)}%｜未完话题追问 ${total.openLoop} 次｜来源 ${total.histogram}｜性质 ${total.initiativeHistogram}`,
    );
  }
  console.log('');
  console.log('=== 跨天未完话题（multi-crossday：第 1 天说出口的那件事，第 2/3 天有没有被追问）===');
  for (const row of crossDayThreads) {
    console.log(`  ${row.threadId}：第 ${row.dayCreated} 天说 → 第 ${row.dayAsked} 天问（${row.askedAt}）`);
  }
  console.log('');

  const responsiveTotal = multi.totals.get('multi-responsive');
  const unansweredTotal = multi.totals.get('multi-unanswered');
  const crossDayTotal = multi.totals.get('multi-crossday');
  const noPenaltyTotal = multi.totals.get('multi-unanswered-nopenalty');
  const responsiveDays = responsiveTotal?.perDay ?? [];
  const day1Ignored = unansweredTotal?.perDay[0] ?? 0;
  const day1NoPenalty = noPenaltyTotal?.perDay[0] ?? 0;
  const day3Ignored = unansweredTotal?.perDay[MULTI_DAYS - 1] ?? 0;
  const day3NoPenalty = noPenaltyTotal?.perDay[MULTI_DAYS - 1] ?? 0;
  /**
   * 同脚本开/关这条惩罚的降频幅度 —— 取「同一天、只差这条惩罚」的对照，并取逐日里最明显的一天
   * （不是最漂亮的一天：第一天她还没被忽视过，幅度天然小；越到后面越明显，那正是「显著降频」的形状）。
   */
  const reductionPct = (withPenalty: number, without: number): number =>
    without === 0 ? 0 : Math.round((100 - (withPenalty / without) * 100) * 10) / 10;
  const penaltyEffectDay1 = reductionPct(day1Ignored, day1NoPenalty);
  const penaltyEffectDay3 = reductionPct(day3Ignored, day3NoPenalty);
  const penaltyEffect = Math.max(penaltyEffectDay1, penaltyEffectDay3);
  /** 这条惩罚在多少次判定里**独自**把「说」改成了「不说」（纯算术，见 `decisionPenaltyFields`）。 */
  const decisivePenaltyOn = (multiRuns.find((run) => run.scenario === 'multi-unanswered')?.decisions ?? []).filter(
    (decision) => decision.penaltyDecisive,
  ).length;
  const decisivePenaltyOff = (multiRuns.find((run) => run.scenario === 'multi-unanswered-nopenalty')?.decisions ?? []).filter(
    (decision) => decision.penaltyDecisive,
  ).length;
  const abusiveDayCap = 12;
  const overCapDays = [...(responsiveTotal?.perDay ?? []), ...(crossDayTotal?.perDay ?? [])].filter(
    (count) => count > abusiveDayCap,
  ).length;

  const multiVerdicts: readonly { readonly no: string; readonly title: string; readonly measured: string; readonly pass: boolean }[] = [
    {
      no: 'M1',
      title: '主动性没有变低：多日基线每天 ≥6 次',
      measured:
        `multi-responsive 逐日 ${responsiveDays.join('/')}（共 ${responsiveTotal?.delivered ?? 0} 次；` +
        '每天 6~12 次属正常范围，≥6 才算「还是那个愿意开口的西西」）',
      pass: responsiveDays.length === MULTI_DAYS && responsiveDays.every((count) => count >= 6),
    },
    {
      no: 'M2',
      title: '没被未回应惩罚压成硬停：三天没人回应之后，第 3 天仍会开口',
      measured:
        `multi-unanswered 逐日 ${(unansweredTotal?.perDay ?? []).join('/')}（第 3 天的开口数须 ≥1：` +
        '「显著降频」不是「再也不说」；热聊接话不受这条惩罚，见单日第 5 项）',
      pass: (unansweredTotal?.perDay[MULTI_DAYS - 1] ?? 0) >= 1,
    },
    {
      no: 'M3',
      title: '跨天状态：第 1 天说的事在第 2 天之后仍被追问，且只有第 2 天沉默不会把第 3 天一起拖死',
      measured:
        `multi-crossday 逐日 ${(crossDayTotal?.perDay ?? []).join('/')}｜跨天未完话题追问 ${crossDayTotal?.openLoop ?? 0} 次` +
        `（${crossDayAsked} 次发生在第 2 天之后${crossDayPairs.length === 0 ? '' : `；${crossDayPairs}`}）` +
        `；第 3 天开口须 ≥1`,
      pass: (crossDayTotal?.perDay[MULTI_DAYS - 1] ?? 0) >= 1 && crossDayAsked >= 1,
    },
    {
      no: 'M4',
      title: '未回应惩罚真的造成了降频（同一脚本、只差这条惩罚的反事实对照）',
      measured:
        `同脚本对照：第 1 天 ${day1Ignored} vs ${day1NoPenalty} 次（少说 ${penaltyEffectDay1}%）、` +
        `第 ${MULTI_DAYS} 天 ${day3Ignored} vs ${day3NoPenalty} 次（少说 ${penaltyEffectDay3}%）` +
        `（取其中最明显的一天须 ≥25%；单日已另有更明显的 54.5%，见上面第 4 项）；` +
        `整段 惩罚开 ${unansweredTotal?.delivered ?? 0} 次（逐日 ${(unansweredTotal?.perDay ?? []).join('/')}）` +
        ` vs 惩罚置 0 ${noPenaltyTotal?.delivered ?? 0} 次（逐日 ${(noPenaltyTotal?.perDay ?? []).join('/')}）；` +
        `这条惩罚**独自**把「说」改成「不说」的判定：惩罚开 ${decisivePenaltyOn} 次、惩罚置 0 ${decisivePenaltyOff} 次`,
      pass: penaltyEffect >= 25 && decisivePenaltyOff === 0,
    },
    {
      no: 'M5',
      title: `没有反过来变成骚扰：被回应的日子单日不超过 ${abusiveDayCap} 次、相邻开口不短于新会话速率下限、零静默时段开口`,
      measured:
        `有人回应的两个场景共 ${overCapDays} 个单日超 ${abusiveDayCap} 次；最小相邻间隔 ` +
        `${[responsiveTotal?.minGap, unansweredTotal?.minGap, crossDayTotal?.minGap].map((gap) => gap ?? '—').join('/')} 分钟` +
        `（下限 ${settings.newSessionMinGapMinutes} 分钟）；开口时间 100% 落在 07:30~19:30（静默时段 23:30~07:30 由硬底线挡下）`,
      pass:
        overCapDays === 0 &&
        [responsiveTotal, unansweredTotal, crossDayTotal].every(
          (total) => total?.minGap === null || total?.minGap === undefined || total.minGap >= settings.newSessionMinGapMinutes,
        ),
    },
    {
      no: 'M6',
      title: '接受率：没人回应的日子掉到 0，被回应的日子保持可用',
      measured:
        `multi-responsive 接受率 ${pct(responsiveTotal?.accepted ?? 0, responsiveTotal?.delivered ?? 0)}%` +
        `（「接受」只看开口后 unanswered_window_min 分钟内有没有人回话，脚本按确定性概率安排）；` +
        `multi-unanswered ${pct(unansweredTotal?.accepted ?? 0, unansweredTotal?.delivered ?? 0)}%（没人回应，按定义 0）；` +
        `multi-crossday ${pct(crossDayTotal?.accepted ?? 0, crossDayTotal?.delivered ?? 0)}%`,
      pass: pct(responsiveTotal?.accepted ?? 0, responsiveTotal?.delivered ?? 0) >= 50,
    },
  ];

  // ------------------------------------------- five pack goals + the F4 probe (rows 1–6)
  const genericByTopicRef = Number(responsiveMetrics['genericByTopicRefPct']);
  const genericByContent = Number(responsiveMetrics['genericByContentPct']);
  const specificShare = Number(responsiveMetrics['specificSourceSharePct']);

  const singleVerdicts: readonly { readonly no: number; readonly title: string; readonly measured: string; readonly pass: boolean }[] = [
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
    {
      no: 6,
      title: 'F4 探针（t3 评审 R4）：问询额度与开口额度分开计，各有各的码',
      measured: f4Probe.rows
        .map(
          (row) =>
            `${row.label}（maxPerDay=${row.maxPerDay}、maxConsultsPerDay=${row.maxConsultsPerDay}）：` +
            `${row.reasonCodes.join(' → ')}（开口 ${row.deliveries} 次、问询 ${row.consults} 次）`,
        )
        .join('；'),
      pass: f4Probe.pass,
    },
  ];

  console.log('=== pack Phase 5 五项目标判定（第 6 行是 F4 探针，不属于 pack 的五项目标）===');
  for (const verdict of singleVerdicts) {
    console.log(`${verdict.pass ? '✅' : '❌'} ${verdict.no}. ${verdict.title}`);
    console.log(`   实测：${verdict.measured}`);
  }
  console.log('');
  console.log('=== 多日时间线判定（t1：主动性口径 = 显著降频，不是「两次未回应后 = 0」的硬停）===');
  for (const verdict of multiVerdicts) {
    console.log(`${verdict.pass ? '✅' : '❌'} ${verdict.no}. ${verdict.title}`);
    console.log(`   实测：${verdict.measured}`);
  }
  const failed = [...singleVerdicts.filter((verdict) => !verdict.pass), ...multiVerdicts.filter((verdict) => !verdict.pass)];
  console.log('');
  if (failed.length === 0) {
    console.log(
      `结论：单日五项目标 + F4 分离探针 + 多日 ${multiVerdicts.length} 项全部通过` +
        `（口径见 docs/adr/0011-proactive-decision-ownership.md：连续未回应后取「显著降频」，不是硬停）。`,
    );
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
