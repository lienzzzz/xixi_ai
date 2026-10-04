/**
 * 话题引擎（pack Phase 3）的规则测试。
 *
 * 这一层只问**规则对不对**：什么样的句子算「一件没办完的事」、什么时候才该问、被回应之后落成哪种状态。
 * 端到端的故事（Day1 说 → Day2 问 → 回答后收口）在 `tests/integration/open-thread-followup.test.ts`。
 *
 * 时间一律用本地时间构造（`new Date(2026, 9, 2, 15, 0, 0)`），所以数字在任何时区下都一样。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildEvent, toOffsetIso } from '@xixi/contracts';
import {
  classifyThreadAnswer,
  DEFAULT_TOPIC_ENGINE_SETTINGS,
  extractOpenThreads,
  followUpHintFor,
  parseTopicEngineSettings,
  TopicEngine,
  type TopicEngineSettings,
} from '@xixi/conversation';
// `isAnswerAboutThread` / `objectWordsIn` / `actionWordsIn` / `isFrameWord` 还没登记进
// `packages/conversation/src/index.ts`（那是另一个包的路径），所以这里直接按源文件导入 ——
// 它们本来就是这一层要测的东西。
import {
  actionWordsIn,
  isAnswerAboutThread,
  isFrameWord,
  objectWordsIn,
} from '../../../packages/conversation/src/topic-engine.ts';
import { loadXixiConfig, OpenThreadStore, openXixiStore } from '@xixi/domain';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const DAY1 = new Date(2026, 9, 1, 20, 0, 0);

function extract(text: string, at: Date = DAY1, settings?: TopicEngineSettings) {
  return extractOpenThreads({ text, at, sourceEventId: 'evt_00000000-0000-4000-8000-000000000001', settings });
}

test('「明天下午我要去镇上办证」被认成一件没办完的事', () => {
  const [thread] = extract('明天下午我要去镇上办证。');
  assert.ok(thread !== undefined, '时间词 + 意愿 + 动作三者齐备，就该记下来');
  assert.equal(thread.summary, '明天下午我要去镇上办证');
  assert.equal(thread.subject, '去镇上办证');
  assert.equal(thread.followAfter, toOffsetIso(new Date(2026, 9, 2, 14, 0, 0)), '「明天下午」= 第二天 14:00');
  assert.equal(thread.expireAt, toOffsetIso(new Date(2026, 9, 4, 14, 0, 0)), '追问窗口 = 48 小时');
  assert.equal(thread.importance, 0.85, '办证这类事更值得惦记');
  assert.match(thread.followUpHint ?? '', /去镇上办证/);
  assert.equal(thread.sourceEventId, 'evt_00000000-0000-4000-8000-000000000001');
});

test('同一句话永远得到同一个话题 id（重放不会多记一件事）', () => {
  const first = extract('明天下午我要去镇上办证。')[0];
  const second = extract('明天下午我要去镇上办证。')[0];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.threadId, second.threadId);
  assert.match(first.threadId, /^thread_[a-z0-9]{4,32}$/, '事件 schema 的 pattern');
});

test('不该记的句子：没有意愿、没有动作、没有将来的时间', () => {
  assert.deepEqual(extract('明天天气怎么样？'), [], '有时间词但没有意愿/动作');
  assert.deepEqual(extract('明天会下雨吗'), []);
  assert.deepEqual(extract('昨天我去镇上办了证。'), [], '已经发生的事不是未完话题');
  assert.deepEqual(extract('嗯。'), []);
  assert.deepEqual(extract('明天'), [], '太短，不构成一件事');
});

test('时间词：下周按 7 天后、今晚按当天 19 点算', () => {
  const nextWeek = extract('下周一我要去医院复诊。')[0];
  assert.ok(nextWeek !== undefined);
  assert.equal(nextWeek.followAfter, toOffsetIso(new Date(2026, 9, 8, 9, 0, 0)));

  const tonight = extract('今晚我要开会。')[0];
  assert.ok(tonight !== undefined);
  assert.equal(tonight.followAfter, toOffsetIso(new Date(2026, 9, 1, 19, 0, 0)));

  const tomorrowMorning = extract('明天上午我得去交材料。')[0];
  assert.ok(tomorrowMorning !== undefined);
  assert.equal(tomorrowMorning.followAfter, toOffsetIso(new Date(2026, 9, 2, 9, 0, 0)), '「上午」= 9 点');
});

test('关掉开关就不提取', () => {
  assert.deepEqual(extract('明天下午我要去镇上办证。', DAY1, { ...DEFAULT_TOPIC_ENGINE_SETTINGS, enabled: false }), []);
});

test('追问短句由模板渲染，能看出问的是哪件事', () => {
  assert.equal(followUpHintFor('明天下午我要去镇上办证', '去镇上办证'), '你之前说过要去镇上办证，后来怎么样了？');
  assert.match(followUpHintFor('明天要交材料', null), /交材料/);
});

test('用户的回答落成三种收口，且都不再追问', () => {
  assert.equal(classifyThreadAnswer('办好了，昨天就办完了。'), 'resolved');
  assert.equal(classifyThreadAnswer('办妥了'), 'resolved');
  assert.equal(classifyThreadAnswer('还没办，过两天再去。'), 'snoozed');
  assert.equal(classifyThreadAnswer('没去成，改天再说吧。'), 'snoozed');
  assert.equal(classifyThreadAnswer('嗯，你问这个干嘛。'), 'engaged');
  // 否定优先于肯定：「还没办好」不是「办好了」。
  assert.equal(classifyThreadAnswer('还没办好呢'), 'snoozed');
});

/**
 * 走一遍生产里的对齐路径「昨天说 → 今天问 → 他回答」，回来看这一轮话有没有被当成回答。
 *
 * 只驱动 `TopicEngine.reconcile`（不是另写一份判定），时间由 store 与引擎的可变时钟控制；
 * 唯一手工造的事件是那条 `proactive.decision`（生产里它由 `ProactiveEngine` 说出那句话时写下，
 * 这里要测的不是它）。
 */
function reconcileAfterAnswer(
  answer: string,
  topic = '明天下午我要去镇上办证。',
): { status: string | null; settled: number; ignored: readonly string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-topic-answer-'));
  let now = DAY1;
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => now });
  try {
    const session = store.createSession();
    store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: topic });

    const engine = new TopicEngine({ store, clock: () => now });
    const [thread] = engine.reconcile(DAY1).created;
    assert.ok(thread !== undefined, '先得有一条话题，否则下面测的不是收口');

    // 第二天 15:00 主动问过一句。
    const askedAt = new Date(2026, 9, 2, 15, 0, 0);
    store.appendEvent(
      buildEvent({
        event_type: 'proactive.decision',
        source: 'conversation',
        actor: 'system',
        confidence: 1,
        timestamp: toOffsetIso(askedAt),
        payload: {
          candidate_id: 'open-thread-a1',
          trigger: 'future_hook_due',
          speak: true,
          reason_code: 'PASSED',
          topic_ref: thread.threadId,
        },
      }),
    );
    now = askedAt;
    engine.reconcile(askedAt);

    // 十分钟后他说话了。
    now = new Date(2026, 9, 2, 15, 10, 0);
    store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: answer });
    const result = engine.reconcile(now);
    return {
      status: store.openThread(thread.threadId)?.status ?? null,
      settled: result.settled.length,
      ignored: result.ignored.map((entry) => entry.text),
    };
  } finally {
    store.close();
  }
}

test('收口与被问的那件事挂钩：相关的一轮照旧收口，无关的一轮不算回答（T7-F1）', () => {
  // 相关：出现话题的内容字（镇/办/证）→ 三种收口都算回应过（零回归：真答案照旧收口）。
  assert.deepEqual(reconcileAfterAnswer('办好了，昨天就办完了。'), { status: 'resolved', settled: 1, ignored: [] });
  assert.deepEqual(reconcileAfterAnswer('还没办，过两天再去。'), { status: 'snoozed', settled: 1, ignored: [] });
  assert.deepEqual(reconcileAfterAnswer('正在办，下午去镇上。'), { status: 'engaged', settled: 1, ignored: [] });
  assert.deepEqual(reconcileAfterAnswer('证已经拿到了。'), { status: 'resolved', settled: 1, ignored: [] });
  assert.deepEqual(reconcileAfterAnswer('还没办好呢'), { status: 'snoozed', settled: 1, ignored: [] });

  // 无关：只是接着聊别的 → 不收口、不写事件，话题还开着（第二天照样惦记着）。
  for (const chatter of ['今天天气不错啊。', '明天天气怎么样？', '嗯，你问这个干嘛。', '我今天修好了电视。']) {
    assert.deepEqual(reconcileAfterAnswer(chatter), { status: 'offered', settled: 0, ignored: [chatter] }, chatter);
  }
});

/**
 * t7 评审 T7-R1 的回归：**位移字不是内容字**。
 *
 * 下面这一列是**无关句探针表**（t7 的 3 句 + 原有 4 句闲聊 + 我补的 3 句）：它们都不能被当成回答。
 * 表里前 3 句正是 t7 实测过的漏洞 —— 都只带一个「去」，却曾被判成在回答「去镇上办证」那件事，
 * 于是话题被写进 `open_thread.changed` 落到 `engaged`（终态、永不再问）。
 * 表格放在测试里（而不是只留在某次脚本输出里）：换机器、换人也能一条命令重跑。
 */
test('T7-R1：只共享位移字（「去」）的无关句不算回答，话题保持 offered', () => {
  const neverAnAnswer = [
    // t7-R1 的三句实测探针：都只带一个「去」。
    '我今天去散步了。',
    '我去公园转了一圈。',
    '我去楼下买了点水果。',
    // 原有四句闲聊（T7-F1 的探针）。
    '今天天气不错啊。',
    '明天天气怎么样？',
    '嗯，你问这个干嘛。',
    '我今天修好了电视。',
    // 再补三句不同形状的（时间词 / 动作 / 第三人的事）。
    '电视里在放戏。',
    '中午吃的面条。',
    '隔壁老王家孙子回来了。',
  ];
  for (const chatter of neverAnAnswer) {
    assert.deepEqual(reconcileAfterAnswer(chatter), { status: 'offered', settled: 0, ignored: [chatter] }, chatter);
  }
});

/**
 * t7 评审 T7-R2 的修复（选 a：弱证据收紧到「必须命中内容字」）。
 *
 * 旧的弱证据允许「答复形状 + 只共享一个『去』」过线，于是这三句会把话题**永久收口**成 snoozed
 * —— 与 T7-F1 同一种害处，只是换了触发模板。收紧之后它们与「闲聊」同等处理。
 *
 * **取舍的另一面也钉在这里**（写下来，不留给读者猜）：不含内容字的真回答（「没去成，改天再说吧。」
 * 「不去了」）也不再收口 —— 这是有意的：话题留在窗口里，`reofferAfterMinutes` 之后可以再问一次，
 * 而且还要过主动引擎的硬门禁与社会预算；多问一次是有界、看得见的，静默丢掉一件事是无界的。
 */
test('T7-R2：答复形状 + 只共享「去」也不算回答；不含内容字的真回答改为「窗口内可再问」', () => {
  for (const chatter of ['我今天没去散步。', '我没去散步。', '今天没去成。']) {
    assert.deepEqual(reconcileAfterAnswer(chatter), { status: 'offered', settled: 0, ignored: [chatter] }, chatter);
  }
  // 已知代价（不是漏洞，是选择）：这两句是「真回答」，但它们一个字都没提到那件事。
  for (const answerWithoutTopic of ['没去成，改天再说吧。', '不去了。']) {
    assert.deepEqual(
      reconcileAfterAnswer(answerWithoutTopic),
      { status: 'offered', settled: 0, ignored: [answerWithoutTopic] },
      answerWithoutTopic,
    );
  }
});

/**
 * t8 的残余已被本轮（第五轮 t2）升级掉：**共享一个内容字的无关句不再收口**。
 *
 * 升级前是**字**级判据：话题「明天我要去买药。」下，「我去楼下买了点水果。」因为都带「买」被判相关、
 * 话题收口成 `engaged`（t8 实测 13 句无关探针里 1 句；同一类还有「看 / 吃 / 拿」）。现在判据比的是
 * **词与对象**（见 `isAnswerAboutThread` 的注释与 ADR-0012）：「水果」不是「药」，这个话题收不了口。
 *
 * 这条用例就是 t8 残余的**度量**：同一个探针表、同一个生产路径，期望从「1/13 误收口」变成 0。
 * 探针表放在测试里（而不是只留在某次脚本输出里）：换机器、换人也能一条命令重跑。
 */
test('t2 升级：共享一个通用动词（「买」）的无关句不再收口', () => {
  assert.deepEqual(reconcileAfterAnswer('我去楼下买了点水果。', '明天我要去买药。'), {
    status: 'offered',
    settled: 0,
    ignored: ['我去楼下买了点水果。'],
  });
});

/**
 * t2 的第二个残余：「老李家的孙子回来了。」（t8 实测同样是 1/13）。
 *
 * 共享的字是「孙子」，但它说的是**别人**的孙子 —— 对象被换进了「老李家的」框里，而话题里没有这个框。
 * 判据据此判「不算回答」：对象对上了也要看**是谁的**。
 */
test('t2 升级：把对象换进「别人家」框里的无关句不再收口', () => {
  assert.deepEqual(reconcileAfterAnswer('老李家的孙子回来了。', '明天我要去看孙子。'), {
    status: 'offered',
    settled: 0,
    ignored: ['老李家的孙子回来了。'],
  });
});

/**
 * 升级后的**探针表**（同一个生产路径 `reconcileAfterAnswer`，不是另写一份判定）。
 *
 * 三条口径，都在这里钉死：
 *
 *   1. `unrelated`：13 句无关句 —— 期望**全部**不收口（`offered`，进 `ignored`）。这是 t8 那张表的
 *      原样复制（含「我去楼下买了点水果。」），换到 7 个话题上跑，所以「共享内容字不再误收口」
 *      是被度量出来的，不是被声明的。
 *   2. `answers`：真答案 —— 期望全部收口。话题里的东西被说到了就算回答（「复诊改到下周了。」对
 *      「复诊」；「药拿回来了」对「拿药」），**升级不拿召回换分数**。
 *   3. `boundary`：**被显式钉住的边界句**（「没去成，改天再说吧。」「不去了。」）—— 期望仍然**不收口**。
 *      钉法与期望沿用 t8（ADR-0012 §决策 4），理由见文件末尾那一段注释；判据换了，这两句的行为刻意
 *      保持不变，所以升级没有偷偷改掉一条已经写进文档的取舍。
 */
interface TopicProbe {
  readonly topic: string;
  readonly subject: string | null;
  /** 这个话题的**真答案**：期望收口。 */
  readonly answers: readonly string[];
  /** **被钉住的边界句**：期望不收口（话题留在窗口里，`reofferAfterMinutes` 之后还能再问一次）。 */
  readonly boundary?: readonly string[];
}

/** t8 那张 13 句表，原样沿用（t7-R1 的 3 句 + T7-F1 的 4 句 + t8 补的 3 句 + 答复形状 3 句）。 */
const UNRELATED_PROBES: readonly string[] = Object.freeze([
  '今天天气不错啊。',
  '明天天气怎么样？',
  '嗯，你问这个干嘛。',
  '我今天修好了电视。',
  '我今天去散步了。',
  '我去公园转了一圈。',
  '我去楼下买了点水果。',
  '我今天没去散步。',
  '我没去散步。',
  '今天没去成。',
  '电视里在放戏。',
  '中午吃的面条。',
  '隔壁老王家孙子回来了。',
]);

const TOPIC_PROBES: readonly TopicProbe[] = Object.freeze([
  {
    // t8 残余的这两个话题放在最前面：它们是这次升级的靶子。
    topic: '明天我要去买药。',
    subject: '去买药',
    answers: ['买了点药，医生说饭后再吃。', '药已经买回来了。'],
  },
  {
    topic: '明天我要去看孙子。',
    subject: '去看孙子',
    answers: ['见到了，孙子挺好的。', '孙子不在家，没见着。'],
  },
  {
    topic: '明天下午我要去镇上办证。',
    subject: '去镇上办证',
    answers: ['办好了，昨天就办完了。', '还没办，过两天再去。', '正在办，下午去镇上。', '证已经拿到了。', '还没办好呢'],
    // 钉住的边界句（见上面第 3 条）。
    boundary: ['没去成，改天再说吧。', '不去了。'],
  },
  {
    topic: '明天上午我要去医院复诊。',
    subject: '去医院复诊',
    answers: ['复诊改到下周了。', '还没去复诊，下周再说。'],
  },
  {
    topic: '明天我要去理发。',
    subject: '去理发',
    answers: ['理发的人太多，没理成。'],
  },
  {
    topic: '明天早上我要去买菜，家里的油也没了。',
    subject: '去买菜，家里的油也没了',
    answers: ['买回来了，油也顺手带了。', '菜买回来了。'],
  },
  {
    topic: '明天上午我要去社区医院拿药。',
    subject: '去社区医院拿药',
    answers: ['药拿回来了，医生说下个月再复查。'],
  },
]);

test('t2 探针表：13 句无关句在 7 个话题上都不收口（0/13 × 7），真答案照旧收口', () => {
  let falseSettles = 0;
  let checkedAnswers = 0;
  for (const probe of TOPIC_PROBES) {
    const thread = { summary: probe.topic, subject: probe.subject };
    for (const chatter of UNRELATED_PROBES) {
      const outcome = reconcileAfterAnswer(chatter, probe.topic);
      if (outcome.settled !== 0) falseSettles += 1;
      assert.deepEqual(
        outcome,
        { status: 'offered', settled: 0, ignored: [chatter] },
        `「${probe.topic}」+「${chatter}」不该收口`,
      );
    }
    for (const answer of probe.answers) {
      assert.equal(
        isAnswerAboutThread(thread, answer),
        true,
        `升级不拿召回换分数：「${probe.topic}」+「${answer}」应当是回答`,
      );
      checkedAnswers += 1;
    }
    for (const pinned of probe.boundary ?? []) {
      assert.deepEqual(
        reconcileAfterAnswer(pinned, probe.topic),
        { status: 'offered', settled: 0, ignored: [pinned] },
        `钉住的边界句行为不变：「${probe.topic}」+「${pinned}」`,
      );
    }
  }
  assert.equal(falseSettles, 0, `13 句无关探针 × ${TOPIC_PROBES.length} 个话题：误收口 ${falseSettles} 句`);
  assert.equal(checkedAnswers, 15, '真答案探针数（改动探针表要一起改这个数）');
});

test('t2 词表：通用动词（买 / 拿）不是收口依据，四张表的分工是显式的', () => {
  // 靶子那两个词：`买` 是通用动词（t8 的另一条残余就是它），`拿` 也是（拿药 / 拿东西 / 拿快递）。
  for (const word of ['买', '拿', '去', '吃', '说', '做', '弄']) {
    assert.equal(isFrameWord(word), true, `「${word}」是通用动词，不能当收口依据`);
  }
  assert.deepEqual(actionWordsIn('我去楼下买了点水果。'), [], '这句话里没有有辨识度的动作词');
  assert.deepEqual(objectWordsIn('我去楼下买了点水果。'), ['水果'], '各自记录，比对时按对象比');
  // 对象词与动作词**允许重合**（「复诊」「理发」本身就是动宾复合词），这一点也钉住。
  assert.deepEqual(objectWordsIn('复诊'), ['复诊']);
  assert.deepEqual(actionWordsIn('复诊'), ['复诊']);
  assert.deepEqual(objectWordsIn('办证'), ['办证'], '长词优先：`办证` 命中就不再单独记 `证`');
  assert.deepEqual(actionWordsIn('办证'), ['办'], '话题的动作词是 `办` —— 「办好了」就是靠它过线的');
});

/**
 * 「没去成，改天再说吧。」这类边界句**为什么不收口**（沿用 t8 的取舍，判据升级后重新核对过）。
 *
 * 它一个字都没提到那件事（没有「办」也没有「证」），**在字面上与「今天没去成。」无法区分** ——
 * 一句「没去成」可能是没去成那件事，也可能是没去成散步。判据说「不算回答」时，话题留在 `offered`：
 * `reofferAfterMinutes`（3 小时）之后可以再问一次，而且是**有界**的（`maxAttempts` 2 次之后 `exhausted`，
 * 每一次还要过主动引擎的硬门禁与社会预算）。反过来「猜它是回答」会把话题写进 `snoozed`/`resolved`
 * ——**终态、不可重开**（`OpenThreadStore` 不允许重开），静默丢一件事是**无界**的。
 *
 * 所以这条取舍的代价是「多问一次」，不是「丢掉一件事」；本轮升级**没有**改动它。
 */
test('t2 边界：不含那件事任何词形的真回答仍不算回答 —— 有意保留的取舍（t8 已写入 ADR-0012）', () => {
  for (const pinned of ['没去成，改天再说吧。', '不去了。']) {
    assert.deepEqual(reconcileAfterAnswer(pinned, '明天下午我要去镇上办证。'), {
      status: 'offered',
      settled: 0,
      ignored: [pinned],
    });
  }
  // 对照：提到了那件事的两句就是回答（差别只在有没有说到「办」「证」）。
  assert.equal(isAnswerAboutThread({ summary: '明天下午我要去镇上办证', subject: '去镇上办证' }, '还没办'), true);
  assert.equal(isAnswerAboutThread({ summary: '明天下午我要去镇上办证', subject: '去镇上办证' }, '证已经拿到了。'), true);
});

test('设置：非数字/非布尔退回默认，越界被夹进合法区间，出厂 config 与代码默认逐字一致', () => {
  assert.deepEqual(parseTopicEngineSettings(undefined), DEFAULT_TOPIC_ENGINE_SETTINGS);
  assert.deepEqual(
    parseTopicEngineSettings({ enabled: 'yes', reoffer_after_min: null, max_attempts: undefined, followup_window_h: {}, topic_dedupe_h: [] }),
    DEFAULT_TOPIC_ENGINE_SETTINGS,
    '调参段里的坏值不能让对话崩掉',
  );
  // 越界值走的是 `parseProactiveSettings` 同一套口径（夹进区间），不是抛错。
  assert.deepEqual(parseTopicEngineSettings({ reoffer_after_min: -5, max_attempts: 999, followup_window_h: 0 }), {
    ...DEFAULT_TOPIC_ENGINE_SETTINGS,
    reofferAfterMinutes: 1,
    maxAttempts: 10,
    followupWindowHours: 1,
  });
  assert.equal(parseTopicEngineSettings({ reoffer_after_min: 30 }).reofferAfterMinutes, 30);

  // 出厂配置里的 open_threads 段必须与代码默认一致（否则文档与行为会各说各话）。
  const config = loadXixiConfig(join(REPO_ROOT, 'config', 'xixi.example.yaml'));
  assert.deepEqual(parseTopicEngineSettings(config.openThreads), DEFAULT_TOPIC_ENGINE_SETTINGS);
});

test('话题去重：同一件事刚被问过，另一条话题记录不再摆出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-topic-dedupe-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => DAY1 });
  try {
    const threads = new OpenThreadStore(store);
    const followAfter = toOffsetIso(new Date(2026, 9, 1, 10, 0, 0));
    const offeredAt = new Date(2026, 9, 1, 12, 0, 0);

    // 第一件事：12:00 被主动问过，13:00 用户回答「办好了」→ 收口。
    threads.create({ threadId: 'thread_aaaaaaa', summary: '明天下午我要去镇上办证', followAfter });
    store.appendEvent(
      buildEvent({
        event_type: 'proactive.decision',
        source: 'conversation',
        actor: 'system',
        confidence: 1,
        timestamp: toOffsetIso(offeredAt),
        payload: { candidate_id: 'loop-1', trigger: 'future_hook_due', speak: true, reason_code: 'PASSED', topic_ref: 'thread_aaaaaaa' },
      }),
    );
    threads.transition('thread_aaaaaaa', 'offered', { offered: true, at: offeredAt });
    threads.transition('thread_aaaaaaa', 'resolved', { at: new Date(2026, 9, 1, 13, 0, 0) });

    // 第二件事：同一句话又被提了一次（新的轮次 → 新的话题 id），16:00 就轮到它了。
    threads.create({ threadId: 'thread_bbbbbbb', summary: '明天下午我要去镇上办证', followAfter });

    const engine = new TopicEngine({ store, clock: () => new Date(2026, 9, 1, 16, 0, 0) });
    const now = new Date(2026, 9, 1, 16, 0, 0);
    assert.equal(engine.followUps(now).length, 0, '12 小时窗口内同一个话题不再重复问');

    // 窗口过去之后（第二天同一时刻）它可以再被考虑。
    const later = new Date(2026, 9, 2, 16, 0, 0);
    const followUps = engine.followUps(later);
    assert.equal(followUps.length, 1);
    assert.equal(followUps[0]?.threadId, 'thread_bbbbbbb');
    assert.equal(engine.topicCandidates(later)[0]?.source, 'open_thread');
    assert.equal(engine.topicCandidates(later)[0]?.score, 1, 'pack §9：OpenThread 的优先级分是 1.00');
  } finally {
    store.close();
  }
});

/**
 * 省略 `at` 的 `transitionOpenThread` 必须有回归底线（t10 复审 R2-D1）。
 *
 * 事实：这条调用形状**曾经会抛 `TypeError`** —— 旧写法是
 *
 *     const at = options.at ?? this.#now();
 *     const updatedAt = toOffsetIso(at);
 *
 * 而 `#now()` 返回的已经是 offset-ISO **字符串**，`toOffsetIso` 会去调 `date.getTime()`。
 * 生产里 5 个调用点（topic-engine 的收口/作废/再候选、主动追问）**全都传了 `at`**，
 * 所以这个默认分支在门禁里一直没有覆盖：t7 顺手修好之后也没有 —— 修好与没修好看起来一样，
 * 靠的只是「今天没人这么调」。这条用例把它变成事实，旧写法一回来就红。
 *
 * 顺带钉住「默认值来自**库时钟**」（而不是墙钟、也不是话题创建时刻）：同一个函数里
 * `this.#now()` 的语义就是「此刻」，缓存住它会让所有省略 `at` 的迁移都盖同一个时间戳。
 */
test('transitionOpenThread 省略 at 时回落到库时钟（旧写法会 TypeError，t10 R2-D1 的底线）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-thread-no-at-'));
  let now = new Date(2026, 9, 1, 20, 0, 0);
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => now });
  try {
    const session = store.createSession();
    store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: '明天下午我要去镇上办证。' });
    const [thread] = new TopicEngine({ store, clock: () => now }).reconcile(now).created;
    assert.ok(thread !== undefined, '先得有一条话题，否则测的不是迁移');

    // 时钟前进一天：省略 at 的那次迁移必须用**调用时刻**的读数。
    now = new Date(2026, 9, 2, 15, 0, 0);
    const offered = store.transitionOpenThread(thread.threadId, 'offered', { offered: true });
    assert.ok(offered !== null, '省略 at 不许抛，也不许当成「没有变化」什么都不做');
    assert.equal(offered.thread.status, 'offered');
    assert.ok(Number.isFinite(Date.parse(offered.thread.updatedAt)), `时间戳要能被 Date.parse：${offered.thread.updatedAt}`);
    assert.equal(offered.thread.updatedAt, toOffsetIso(now), '省略 at 时的时间戳来自库时钟的当前读数');
    assert.equal(offered.thread.lastOfferedAt, offered.thread.updatedAt, 'offered=true 记下这一次的时间');
    assert.equal(offered.thread.attempts, thread.attempts + 1, 'offered=true 让 attempts 加一');
    assert.equal(store.openThread(thread.threadId)?.updatedAt, toOffsetIso(now), '落库的行与返回值一致');
    assert.equal(
      store.readEvents({ type: 'open_thread.changed', limit: 10 }).at(-1)?.timestamp,
      toOffsetIso(now),
      '事件日志的时间戳与投影一致（不是 undefined / Invalid Date）',
    );

    // 显式传 Date 的另一条分支照旧 —— 别在守住省略分支时打断它。
    const later = new Date(2026, 9, 2, 16, 30, 0);
    const settled = store.transitionOpenThread(thread.threadId, 'resolved', { at: later, note: '他答了' });
    assert.equal(settled?.thread.updatedAt, toOffsetIso(later), '显式 at 用给的那个时刻');

    // 经 `OpenThreadStore` 包装（options 原样透传）省略 at 时同样不许炸。
    const threads = new OpenThreadStore(store);
    const second = threads.create({
      threadId: 'thread_regress1',
      summary: '明天下午我要去买药',
      followAfter: toOffsetIso(new Date(2026, 9, 3, 14, 0, 0)),
    });
    const viaWrapper = threads.transition(second.thread.threadId, 'offered', { offered: true });
    assert.equal(viaWrapper?.thread.updatedAt, toOffsetIso(now), '包装层不传 at 时也回落到库时钟');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});
