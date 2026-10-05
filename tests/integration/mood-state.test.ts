/**
 * 有界心情的**端到端接缝**（第五轮 t4，离线、无模型、无网络）。
 *
 * 单元层（`tests/unit/domain.test.ts`）证明了两件事：数学有界、散文没有数字。
 * 这条用例证明的是**接线**，也就是「心情真的到得了该到的地方、到不了不该到的地方」：
 *
 *   1. **事件 → 心情**：走真实的 `ConversationEngine.respond`，用户一句夸奖之后
 *      `store.mood()` 真的动了，`mood_history` 里真的留了一行；
 *   2. **心情 → 提示词**：下一轮的 `prompt.system` 里出现散文，且**不出现数值**；
 *      数值只在 `sections[].debug`；
 *   3. **心情 → 语气**：`lingerMs` 被轻微缩放（±6% 以内），而人格那侧的 0.5..1.5 倍率不变；
 *   4. **心情 → 不碰硬底线**：静默时段 / 额度 / 隐私这些判定**拿不到**心情 —— 同一份门禁输入
 *      在心情高低两种情况下得到完全相同的 `reasonCode`（硬底线不被心情覆盖，铁律 3）；
 *   5. **可查看与复位**：领域接口能读、能复位、复位留痕，重启后还在。
 *
 * Run: `npm test`（integration 也在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { buildEvent, toOffsetIso } from '@xixi/contracts';
import {
  ConversationEngine,
  evaluateProactiveGates,
  moodToleranceScale,
  parseProactiveSettings,
  type ProactiveCandidate,
  type ProactiveGateContext,
} from '@xixi/conversation';
import { NEUTRAL_MOOD, moodProactivityNudge, openXixiStore, type XixiConfig, type XixiStore } from '@xixi/domain';

/** 20:00：时段目标接近中性，所以这个时刻里「心情的变化」只可能来自事件（可归因）。 */
const DAY1 = new Date(2026, 9, 1, 20, 0, 0);
/** 夸奖发生在第一次评估之后一点点：这样它落在「上一次评估之后」的窗口里。 */
const PRAISE_AT = new Date(2026, 9, 1, 20, 0, 30);
/** 夸奖之后两分钟：看提示词与窗口。 */
const LATER_AT = new Date(2026, 9, 1, 20, 2, 0);

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: { llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false }, asr: {} as never, tts: {} as never },
  personality: { base: {} },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

interface Harness {
  readonly store: XixiStore;
  readonly engine: ConversationEngine;
  readonly sessionId: string;
  readonly at: (moment: Date) => void;
}

function harness(options: { readonly mood?: false } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-mood-e2e-'));
  let now = DAY1;
  const store = openXixiStore({ dbPath: join(dir, 'xixi.sqlite'), clock: () => now });
  store.seedSelfProfile({ silence_tolerance: 0.7 });
  const session = store.createSession();
  const engine = new ConversationEngine({
    adapter: new FakeBrainAdapter(),
    store,
    config: CONFIG,
    clock: () => now,
    // 固定东八区，用例在任何时区下跑出来的时段牵引都一样。
    offsetMinutes: 480,
    ...(options.mood === undefined ? {} : { mood: options.mood }),
  });
  return {
    store,
    engine,
    sessionId: session.sessionId,
    at: (moment) => {
      now = moment;
    },
  };
}

test('心情端到端：夸奖改变心情 → 进散文提示词（无数字）→ 轻微缩放窗口 → 领域接口可查看与复位', async () => {
  const h = harness();
  try {
    // 基线：还没发生任何事 → 真正的中性，窗口一点也不偏。
    assert.equal(h.store.mood(), null, '全新库还没有心情行');
    const neutralLinger = h.engine.lingerMs;
    // FSM 的口径（`fsm.ts` 的 `lingerMs`）：`lingerMs × (0.5 + silence_tolerance)`，
    // 30s × 1.2 = 36s。这条公式变了的话，下面「位移必须很小」就失去意义。
    assert.equal(neutralLinger, 36_000, '30s × (0.5 + 0.7) = 36s（人格那侧的口径不变）');

    // 一句夸奖真的过引擎（落 turn → 心情演化），随后另起一轮看提示词。
    h.at(PRAISE_AT);
    await h.engine.respond({ sessionId: h.sessionId, text: '谢谢你啊，还是你细心。', addressed: true });
    h.at(LATER_AT);

    const stored = h.store.mood();
    assert.ok(stored !== null, '夸奖之后应当有一行心情状态');
    assert.ok(stored.valence > NEUTRAL_MOOD.valence, `被夸之后 valence 应当上升：${stored.valence}`);
    assert.ok(stored.energy >= NEUTRAL_MOOD.energy, '精神也不该下降');
    assert.ok(stored.valence <= 1 && stored.energy <= 1, '上下界在真实路径上同样成立');
    const history = h.store.moodHistory();
    assert.ok(
      history.some((change) => change.note.includes('被夸了一句')),
      `历史里应当留下凭据：${JSON.stringify(history.map((change) => change.note))}`,
    );

    // 提示词：散文进 system，数值只进 sections[].debug。
    const prompt = h.engine.buildPrompt({ sessionId: h.sessionId, text: '嗯，我回来了。' });
    assert.ok(prompt.user.includes('你现在的心情'), '心情必须进动态提示词（散文）');
    assert.doesNotMatch(prompt.system, /valence|energy|0\.\d\d\d/, '模型看不到数值或参数名');
    const moodSection = prompt.sections.find((section) => section.name === 'mood');
    assert.ok(moodSection !== undefined);
    assert.ok((moodSection.debug ?? '').includes('valence='), 'Debug 段里有数值供面板核对');

    // 语气：窗口被轻微缩放，但仍然在 36s 附近（人格的 0.5..1.5 倍率才是主导）。
    const bias = h.engine.moodStatus()?.bias ?? 0;
    assert.ok(bias > 0, `被夸之后偏置应当为正：${bias}`);
    assert.ok(Math.abs(moodToleranceScale(bias) - 1) <= 0.06 + 1e-9, '缩放最多 ±6%');
    assert.notEqual(h.engine.lingerMs, neutralLinger, '窗口必须真的跟着心情动了一下');
    assert.ok(
      Math.abs(h.engine.lingerMs - neutralLinger) <= Math.ceil(neutralLinger * 0.06),
      `窗口位移必须很小（实测 ${neutralLinger} → ${h.engine.lingerMs}）`,
    );

    // 审计：心情的凭据在 `mood_history` 里（before/after/信号/摘要），可以和判定事件按时间对起来。
    // 为什么不塞进 `conversation.decision`：那个 payload 是 additionalProperties:false 的已发布契约，
    // 加字段要改 `packages/contracts/schemas/events/conversation.decision.v1.json`（本任务契约外，
    // 见回报的 §9.2 披露）—— 这条留给「心情接主动引擎软评分」的那一轮一起做。
    const praiseChange = h.store.moodHistory(20).find((change) => change.note.includes('被夸了一句'));
    assert.ok(praiseChange !== undefined, `心情历史里应当留下这一条的凭据：${JSON.stringify(h.store.moodHistory(20).map((c) => c.note))}`);
    assert.ok(praiseChange.after.valence > praiseChange.before.valence, '被夸之后应当是上升的一步');
    assert.ok(
      Math.abs(moodProactivityNudge(bias)) <= 0.03 + 1e-9,
      '给主动性的软偏移必须落在 ±0.03 内（硬底线的判定拿不到它）',
    );

    // 可查看、可复位（控制台面板不在本任务范围，接口在本层）。
    assert.notEqual(h.store.mood()?.valence, NEUTRAL_MOOD.valence);
    const reset = h.store.resetMood('test:reset', toOffsetIso(LATER_AT));
    assert.equal(reset.valence, NEUTRAL_MOOD.valence);
    assert.equal(reset.energy, NEUTRAL_MOOD.energy);
    assert.deepEqual(reset.evidence, {}, '复位同时清掉解释旧心情的计数');
    const last = h.store.moodHistory().at(-1);
    assert.equal(last?.reset, true, '复位也要留痕（否则「她为什么突然平静了」没有答案）');
  } finally {
    h.store.close();
  }
});

test('心情不碰硬底线：同一份门禁输入在心情高/低两种情况下得到同一个 reasonCode（铁律 3）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-mood-gate-'));
  const at = new Date('2026-10-01T23:45:00+08:00'); // 23:45 在静默时段里（23:30–07:30）
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => at });
  try {
    const candidate: ProactiveCandidate = {
      candidateId: 'mood-gate-1',
      trigger: 'future_hook_due',
      initiativeKind: 'open_loop_followup',
      components: { topic_quality: 0.95, personal_relevance: 0.95, freshness: 0.7, receptivity: 0.85, engagement: 0.6 },
    };
    const base: Omit<ProactiveGateContext, 'proactivity'> = {
      settings: parseProactiveSettings(undefined),
      now: at,
      offsetMinutes: 480,
      conversationState: 'IDLE',
      inFlightTurn: false,
      negativeFeedback: false,
      sceneAvailable: true,
      speechAvailable: true,
      privacyAllowed: true,
      history: [],
      userTurns: [],
    };

    // 门禁只吃 `proactivity`（人格层），**没有任何入口**能传心情 —— 所以下面两次的差别只可能来自
    // 这里显式给出的 proactivity，心情的高低不改变静默时段的判定。
    const low = evaluateProactiveGates(candidate, { ...base, proactivity: 0.1 });
    const high = evaluateProactiveGates(candidate, { ...base, proactivity: 1 });
    assert.equal(low.reasonCode, 'QUIET_HOURS', '静默时段由程序判定，心情再低也不能改变它');
    assert.equal(high.reasonCode, 'QUIET_HOURS', '心情再高也不能越过它');
    assert.equal(low.pass, false);
    assert.equal(high.pass, false);

    // 同一个时刻、把隐私关掉：仍然是硬底线码（顺序上静默时段先判，所以这里换到白天再看隐私）。
    const daytime = { ...base, now: new Date('2026-10-01T10:00:00+08:00') };
    assert.equal(evaluateProactiveGates(candidate, { ...daytime, proactivity: 1, privacyAllowed: false }).reasonCode, 'PRIVACY_BLOCKED');
    // 对照：白天、隐私允许时硬底线不误拦（心情不参与，但也不该把正常时刻搞坏）。
    assert.equal(evaluateProactiveGates(candidate, { ...daytime, proactivity: 1 }).reasonCode, 'PASSED');
  } finally {
    store.close();
  }
});

test('心情可关：入口传 false 时提示词与窗口都回到「没有这一层」', async () => {
  const h = harness({ mood: false });
  try {
    assert.equal(h.engine.mood, null);
    assert.equal(h.engine.moodStatus(), null);
    assert.equal(h.engine.beatMood(), null);
    assert.equal(h.engine.moodProactivityNudge(), 0);
    const prompt = h.engine.buildPrompt({ sessionId: h.sessionId, text: '在吗？' });
    assert.ok(!prompt.system.includes('你现在的心情'), '关掉之后提示词里不该有心情那一段');
    assert.equal(prompt.sections.some((section) => section.name === 'mood'), false);
    // 而且**一个心情行都不会写**（关掉 = 不动库，不是「算了但记着」）。
    await h.engine.respond({ sessionId: h.sessionId, text: '谢谢你啊。', addressed: true });
    assert.equal(h.store.mood(), null, '关掉心情时不该写库');
    assert.equal(h.engine.lingerMs, 36_000, '窗口仍然只由人格决定');
  } finally {
    h.store.close();
  }
});

test('心情跨重启仍在，且 reset 之后落回中性（持久化不是内存里的假象）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-mood-restart-'));
  let now = DAY1;
  const store = openXixiStore({ dbPath: join(dir, 'xixi.sqlite'), clock: () => now });
  store.seedSelfProfile({ silence_tolerance: 0.7 });
  const session = store.createSession();
  const engine = new ConversationEngine({
    adapter: new FakeBrainAdapter(),
    store,
    config: CONFIG,
    clock: () => now,
    offsetMinutes: 480,
  });
  now = PRAISE_AT;
  await engine.respond({ sessionId: session.sessionId, text: '还是你细心。', addressed: true });
  const before = store.mood();
  assert.ok(before !== null && before.valence > NEUTRAL_MOOD.valence);
  store.close();

  // 新进程、同一份库：心情照旧（它是持久状态，不是进程内存）。
  const reopened = openXixiStore({ dbPath: join(dir, 'xixi.sqlite'), clock: () => now });
  try {
    const reopenedMood = reopened.mood();
    assert.equal(reopenedMood?.valence, before.valence, '重启后心情值不变');
    assert.ok((reopenedMood?.evidence['praised'] ?? 0) >= 1, '证据（为什么是这个心情）也在');
    assert.equal(reopened.appliedMigrations.length, 0, '重启不该重跑迁移');
    assert.ok(reopened.moodHistory().length >= 1, '历史跨重启可查');
  } finally {
    reopened.close();
  }
});

test('主动开口没人应 → 心情下降；有人接 → 上升（信号来自主动记录，不是猜的）', async () => {
  const h = harness();
  try {
    // 一条「主动开口了」的记录（生产里由 ProactiveEngine 在说出口时写下），之后没有人回应。
    h.store.appendEvent(
      buildEvent({
        event_type: 'proactive.decision',
        source: 'conversation',
        actor: 'system',
        confidence: 1,
        timestamp: toOffsetIso(DAY1),
        payload: {
          candidate_id: 'mood-proactive-a1',
          trigger: 'future_hook_due',
          speak: true,
          reason_code: 'PASSED',
        },
      }),
    );
    h.at(new Date(2026, 9, 1, 20, 45, 0));
    const missed = h.engine.beatMood();
    assert.ok(missed !== null);
    assert.ok(
      missed.signals.some((signal) => signal.code === 'missed'),
      `应当记下「没人应」：${JSON.stringify(missed.signals)}`,
    );
    assert.ok(missed.state.valence < NEUTRAL_MOOD.valence, '没人应之后心情应当下降');
    assert.ok(
      !missed.signals.some((signal) => signal.code === 'quiet'),
      `有人说过话的窗口里不该记「家里一直没人」：${JSON.stringify(missed.signals)}`,
    );

    // 同一个时刻再评估一次：**幂等**，不吃第二遍（同一批事件不该被重复吸收）。
    const again = h.engine.beatMood();
    assert.equal(again?.signals.length, 0, '同一时刻重复评估不该重复吸收同一批信号');
    assert.equal(again?.state.valence, missed.state.valence);

    // 另一次主动开口，这次两分钟内就有人接 → answered，心情回升。
    const deliveredAt = new Date(2026, 9, 1, 21, 30, 0);
    h.store.appendEvent(
      buildEvent({
        event_type: 'proactive.decision',
        source: 'conversation',
        actor: 'system',
        confidence: 1,
        timestamp: toOffsetIso(deliveredAt),
        payload: {
          candidate_id: 'mood-proactive-a2',
          trigger: 'future_hook_due',
          speak: true,
          reason_code: 'PASSED',
        },
      }),
    );
    h.at(new Date(2026, 9, 1, 21, 32, 0));
    await h.engine.respond({ sessionId: h.sessionId, text: '嗯，回来了。', addressed: true });
    // 等到答案窗口（30 分钟）关掉之后再评估：那时才**确定**是「有人接」。
    h.at(new Date(2026, 9, 1, 22, 5, 0));
    const answered = h.engine.beatMood();
    assert.ok(answered !== null);
    assert.ok(
      answered.signals.some((signal) => signal.code === 'answered'),
      `应当记下「有人接」：${JSON.stringify(answered.signals)}`,
    );
    assert.ok(answered.state.valence > missed.state.valence, '有人接之后心情应当回升');
  } finally {
    h.store.close();
  }
});
