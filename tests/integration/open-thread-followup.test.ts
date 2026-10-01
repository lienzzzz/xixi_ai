/**
 * pack Phase 3 的验收测试：**第二天能主动追问前一天说过的事；被回应后收口，不再重复问**。
 *
 * 场景（《方案》§10 的例子）：
 *
 *   Day 1 父亲说「明天下午我要去镇上办证。」
 *   Day 1 晚上  → 话题引擎把它记成一件「没办完的事」（`open_thread.changed`: candidate，明天 14:00 之后才合适问）
 *   Day 2 15:00 → 候选进入常驻考虑循环，主动开口问了一句（`proactive.decision`: speak=true，
 *                  `topic_ref` = 话题 id，`initiative_kind` = open_loop_followup）
 *   父亲回答「办好了」→ 话题收口（`resolved`），**之后再也不问这件事**
 *
 * 这条测试刻意走**生产路径**：候选由 `scripts/field-test.ts` 的 `buildProactiveCandidates` 产出，
 * 判定由真实的 `ProactiveEngine` 做，状态由真实的 `XixiStore` + `open_thread.changed` 事件落库。
 * 时间用本地时间构造（`new Date(2026, 9, 2, 15, 0, 0)`），所以任何时区下跑出来的数字都一样。
 *
 * Run: `npm test`（integration 也在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { toOffsetIso } from '@xixi/contracts';
import { ProactiveEngine, TopicEngine, readTopicHistory, type ProactiveDelivery } from '@xixi/conversation';
import { openXixiStore, type XixiStore } from '@xixi/domain';

import { buildProactiveCandidates, lastUserTurnAt } from '../../scripts/field-test.ts';

const DAY1 = new Date(2026, 9, 1, 20, 0, 0);
const DAY2 = new Date(2026, 9, 2, 15, 0, 0);
const DAY2_ANSWER = new Date(2026, 9, 2, 15, 10, 0);
/** 追问之后他先聊了句别的（与那件事无关）。 */
const DAY2_CHITCHAT = new Date(2026, 9, 2, 15, 20, 0);
/** 他过了半小时才答到那件事上（仍在第一次追问的等待里）。 */
const DAY2_LATE_ANSWER = new Date(2026, 9, 2, 16, 30, 0);
/** 距第一次追问 4 小时：过了 `reoffer_after_min`（180 分钟），同一件事可以再问一次。 */
const DAY2_REOFFER = new Date(2026, 9, 2, 19, 0, 0);
/** 第二次追问之后，他才答到那件事上。 */
const DAY2_REOFFER_ANSWER = new Date(2026, 9, 2, 19, 30, 0);
const DAY3 = new Date(2026, 9, 3, 15, 0, 0);
const DAY4 = new Date(2026, 9, 4, 15, 0, 0);

const ERLAND = '明天下午我要去镇上办证。';

interface Harness {
  readonly dir: string;
  readonly store: XixiStore;
  readonly sessionId: string;
  readonly engine: TopicEngine;
  readonly proactive: ProactiveEngine;
  /** 把「现在」拨到某个时刻：store 的事务时间戳与两个引擎的时钟都跟着走。 */
  readonly at: (moment: Date) => void;
  readonly say: (text: string) => void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-open-thread-'));
  let now = DAY1;
  // 可变的 store 时钟：`recordTurn` 写下的时间戳就是被模拟的那一天（生产里是真实时钟）。
  const store = openXixiStore({ dbPath: join(dir, 'xixi.sqlite'), clock: () => now });
  store.seedSelfProfile({ proactivity: 0.85 });
  const session = store.createSession();
  return {
    dir,
    store,
    sessionId: session.sessionId,
    engine: new TopicEngine({ store, clock: () => now }),
    proactive: new ProactiveEngine({ store, clock: () => now }),
    at: (moment) => {
      now = moment;
    },
    say: (text) => {
      store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text });
    },
  };
}

/** 生产路径的候选：`buildProactiveCandidates` 只把「该追问的未完话题」交给考虑循环。 */
function plansAt(h: Harness, now: Date): ReturnType<typeof buildProactiveCandidates> {
  return buildProactiveCandidates({
    now,
    // 没有在场投影、没有时钟钩子、没有话题池输入：这条用例里唯一的来源就是未完话题本身。
    presence: null,
    lastUserTurnAt: lastUserTurnAt(h.store, h.sessionId),
    inConversation: false,
    openThreads: h.engine.followUps(now),
  });
}

/**
 * 只看「未完话题」这一个来源的候选。
 *
 * 考虑循环还会产出别的候选（长时间没人说话就是 `conversation_dangling`），它们与这条用例无关；
 * 这里要问的是「这件事还会不会再被问一次」，所以按 `initiative_kind` 过滤。
 */
function openLoopPlans(h: Harness, now: Date): ReturnType<typeof buildProactiveCandidates> {
  return plansAt(h, now).filter((plan) => plan.candidate.initiativeKind === 'open_loop_followup');
}

test('Day2 主动追问 Day1 说过的事；回答「办好了」后收口，之后不再重复', async () => {
  const h = harness();
  try {
    // ---------------------------------------------------------------- Day 1
    h.say(ERLAND);
    h.store.recordTurn({ sessionId: h.sessionId, role: 'assistant', action: 'SPEAK', text: '好，那你路上慢点。' });

    const day1 = h.engine.reconcile(DAY1);
    assert.equal(day1.created.length, 1, '一句话里认出一件没办完的事');
    const thread = day1.created[0];
    assert.ok(thread !== undefined);
    assert.equal(thread.status, 'candidate');
    assert.equal(thread.summary, '明天下午我要去镇上办证');
    assert.equal(thread.subject, '去镇上办证');
    assert.equal(thread.followAfter, toOffsetIso(new Date(2026, 9, 2, 14, 0, 0)), '「明天下午」= 第二天 14:00 之后才问');
    assert.equal(thread.expireAt, toOffsetIso(new Date(2026, 9, 4, 14, 0, 0)), '追问窗口 48 小时');
    assert.match(thread.followUpHint ?? '', /办证/);
    assert.equal(h.engine.followUps(DAY1).length, 0, '还没到点：前一天不问第二天的事');
    assert.equal(openLoopPlans(h, DAY1).length, 0);

    // 幂等：同一批日志再对齐一次不会多出一条话题。
    assert.equal(h.engine.reconcile(DAY1).created.length, 0);

    // ---------------------------------------------------------------- Day 2
    h.at(DAY2);
    h.engine.reconcile(DAY2);
    const plans = plansAt(h, DAY2);
    assert.equal(plans[0]?.candidate.initiativeKind, 'open_loop_followup', '未完话题是最高优先级的来源（pack §9：OpenThread 1.00）');
    const ownPlans = openLoopPlans(h, DAY2);
    assert.equal(ownPlans.length, 1, '到点了：这件事进入候选');
    const plan = ownPlans[0];
    assert.ok(plan !== undefined);
    assert.equal(plan.candidate.trigger, 'future_hook_due');
    assert.equal(plan.candidate.initiativeKind, 'open_loop_followup');
    assert.equal(plan.candidate.topicRef, thread.threadId, '话题 id 就是主动记录的 topic_ref（可回到日志核对）');
    assert.match(plan.line, /办证/, '说的是那件事，不是泛泛的「今天过得怎么样」');
    assert.match(plan.fact, /未完话题/);

    const delivered: ProactiveDelivery[] = [];
    const outcome = await h.proactive.consider({
      candidate: plan.candidate,
      at: DAY2,
      conversationState: 'IDLE',
      sessionId: h.sessionId,
      deliver: (delivery) => void delivered.push(delivery),
    });
    assert.equal(outcome.speak, true, `应当开口：${outcome.reasonCode} ${outcome.score}`);
    assert.equal(outcome.delivered, true);
    assert.equal(outcome.reasonCode, 'PASSED');
    assert.equal(outcome.initiativeKind, 'open_loop_followup');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.topicRef, thread.threadId);

    // 主动记录已经在日志里，且带着这个话题 —— 引擎据此把话题标成「已经问过」。
    const afterOffer = h.engine.reconcile(DAY2);
    assert.equal(afterOffer.offered.length, 1);
    assert.equal(afterOffer.offered[0]?.status, 'offered');
    assert.equal(afterOffer.offered[0]?.attempts, 1);
    assert.equal(h.engine.followUps(DAY2).length, 0, '问过了就等回答，不重复摆出同一个候选');
    assert.equal(openLoopPlans(h, DAY2).length, 0);

    // ---------------------------------------------------------- 回答：办好了
    h.at(DAY2_ANSWER);
    h.say('办好了，昨天就办完了。');
    const settled = h.engine.reconcile(DAY2_ANSWER);
    assert.equal(settled.settled.length, 1);
    assert.equal(settled.settled[0]?.status, 'resolved');
    assert.equal(settled.settled[0]?.note, '用户回答：办好了，昨天就办完了。');
    assert.equal(h.store.openThread(thread.threadId)?.status, 'resolved');

    // ------------------------------------------------- 之后：不再重复问同一件事
    for (const day of [DAY3, DAY4]) {
      h.at(day);
      assert.equal(h.engine.reconcile(day).settled.length, 0, '收口之后没有第二次收口');
      assert.equal(h.engine.followUps(day).length, 0, `${day.toLocaleDateString()} 不该再追问同一件事`);
      assert.equal(openLoopPlans(h, day).length, 0);
    }

    // 日志里的事实：candidate → offered → resolved，版本仍是 1。
    const threadEvents = h.store.readEvents({ type: 'open_thread.changed', limit: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(
      threadEvents.map((event) => (event.payload as { status: string }).status),
      ['candidate', 'offered', 'resolved'],
    );
    assert.ok(threadEvents.every((event) => event.schema_version === 1 && event.event_type === 'open_thread.changed'));
    assert.equal(
      h.store.readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER }).filter((event) => (event.payload as { speak: boolean }).speak).length,
      1,
      '这件事只被主动问过了一次',
    );
    // 话题历史（哪些话题说过、反应如何）也是从同一份日志读出来的。
    assert.deepEqual(
      readTopicHistory(h.store).map((entry) => [entry.topicRef, entry.outcome]),
      [
        [thread.threadId, 'offered'],
        [thread.threadId, 'resolved'],
      ],
    );
  } finally {
    h.store.close();
  }
});

test('被回应但事情还没办完：收口成 snoozed，也不再追问（不催）', async () => {
  const h = harness();
  try {
    h.say(ERLAND);
    h.engine.reconcile(DAY1);

    h.at(DAY2);
    h.engine.reconcile(DAY2);
    const plan = openLoopPlans(h, DAY2)[0];
    assert.ok(plan !== undefined);
    await h.proactive.consider({ candidate: plan.candidate, at: DAY2, conversationState: 'IDLE', sessionId: h.sessionId });
    h.engine.reconcile(DAY2);

    h.at(DAY2_ANSWER);
    h.say('还没办，过两天再去。');
    const settled = h.engine.reconcile(DAY2_ANSWER);
    assert.equal(settled.settled.length, 1);
    assert.equal(settled.settled[0]?.status, 'snoozed', '没办完不是「办好了」，但同样不该追着问');
    assert.equal(settled.settled[0]?.note, '用户回答：还没办，过两天再去。');

    for (const day of [DAY3, DAY4]) {
      h.at(day);
      h.engine.reconcile(day);
      assert.equal(openLoopPlans(h, day).length, 0, '问过一次又得到回答，就不再重复问');
    }
  } finally {
    h.store.close();
  }
});

test('没人回应：过一阵子允许再问一次，问满 2 次后作废（不再打扰）', async () => {
  const h = harness();
  try {
    h.say(ERLAND);
    h.engine.reconcile(DAY1);
    h.at(DAY2);
    h.engine.reconcile(DAY2);

    // 第一次追问（a1）。
    const first = openLoopPlans(h, DAY2)[0];
    assert.ok(first !== undefined);
    assert.match(first.candidate.candidateId, /-a1$/);
    const firstOutcome = await h.proactive.consider({ candidate: first.candidate, at: DAY2, conversationState: 'IDLE', sessionId: h.sessionId });
    assert.equal(firstOutcome.speak, true);
    h.engine.reconcile(DAY2);

    // 4 小时后（没人回答）：回到候选，允许再问一次 —— 候选 id 带上次数，所以不会被 ALREADY_DELIVERED 挡住。
    const LATER = new Date(2026, 9, 2, 19, 0, 0);
    h.at(LATER);
    const backToCandidate = h.engine.reconcile(LATER);
    assert.equal(backToCandidate.expired.length, 0);
    assert.equal(h.store.openThread(first.candidate.topicRef ?? '')?.status, 'candidate');
    const second = openLoopPlans(h, LATER)[0];
    assert.ok(second !== undefined, '没人回应，过一阵子可以再问一次');
    assert.match(second.candidate.candidateId, /-a2$/);
    const secondOutcome = await h.proactive.consider({ candidate: second.candidate, at: LATER, conversationState: 'IDLE', sessionId: h.sessionId });
    assert.equal(secondOutcome.speak, true, `第二次追问也应当能过线：${secondOutcome.reasonCode} ${secondOutcome.score}`);
    h.engine.reconcile(LATER);
    assert.equal(h.store.openThread(first.candidate.topicRef ?? '')?.attempts, 2);

    // 再等过重问窗口：问满 2 次还没人回应 → exhausted，彻底不再提。
    const MUCH_LATER = new Date(2026, 9, 3, 20, 0, 0);
    h.at(MUCH_LATER);
    const expiry = h.engine.reconcile(MUCH_LATER);
    assert.equal(expiry.expired.length, 1);
    assert.equal(expiry.expired[0]?.status, 'exhausted');
    assert.equal(h.store.openThread(first.candidate.topicRef ?? '')?.status, 'exhausted');
    assert.equal(plansAt(h, MUCH_LATER).filter((plan) => plan.candidate.initiativeKind === 'open_loop_followup').length, 0);
    assert.equal(openLoopPlans(h, DAY4).length, 0);
  } finally {
    h.store.close();
  }
});

test('回到候选、还没被再问之前他就答了那件事：照旧收口，不再问第二遍', async () => {
  const h = harness();
  try {
    h.say(ERLAND);
    h.engine.reconcile(DAY1);

    h.at(DAY2);
    h.engine.reconcile(DAY2);
    const plan = openLoopPlans(h, DAY2)[0];
    assert.ok(plan !== undefined);
    const threadId = plan.candidate.topicRef ?? '';
    await h.proactive.consider({ candidate: plan.candidate, at: DAY2, conversationState: 'IDLE', sessionId: h.sessionId });
    h.engine.reconcile(DAY2);

    // 4 小时没人回答：话题回到候选，等着被再问一次（这一次只对齐，没有真的开口）。
    h.at(DAY2_REOFFER);
    const backToCandidate = h.engine.reconcile(DAY2_REOFFER);
    assert.equal(backToCandidate.settled.length, 0);
    assert.equal(h.store.openThread(threadId)?.status, 'candidate');
    assert.equal(openLoopPlans(h, DAY2_REOFFER).length, 1, '候选摆在那里等着，但这次没有开口');

    // 就在这时候他答了那件事 —— 它仍是「那句话」的回答，不该再问第二遍。
    h.at(DAY2_REOFFER_ANSWER);
    h.say('办好了。');
    const settled = h.engine.reconcile(DAY2_REOFFER_ANSWER);
    assert.equal(settled.settled.length, 1, '回到候选之后答的话照样算回答');
    assert.equal(settled.settled[0]?.status, 'resolved');
    assert.equal(h.engine.followUps(DAY2_REOFFER_ANSWER).length, 0);
    assert.equal(
      h.store
        .readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })
        .filter((event) => (event.payload as { speak: boolean }).speak).length,
      1,
      '第二遍没来得及问出口，就不会再问',
    );
  } finally {
    h.store.close();
  }
});

/**
 * 追问之后他说的话**必须与那件事有关**才算回答（t7 评审 T7-F1）。
 *
 * 与第 1 条用例同样的生产路径（`buildProactiveCandidates` + 真实 `ProactiveEngine`），只是中间插了一句
 * 与话题无关的话：它不能被当成回答，这件事得照旧惦记着、在窗口内还能再问一次。
 */
test('他说的是别的事：不算回答、不收口，同一件事在窗口内还能再问一次', async () => {
  const h = harness();
  try {
    h.say(ERLAND);
    h.engine.reconcile(DAY1);

    h.at(DAY2);
    h.engine.reconcile(DAY2);
    const first = openLoopPlans(h, DAY2)[0];
    assert.ok(first !== undefined);
    const threadId = first.candidate.topicRef ?? '';
    const firstOutcome = await h.proactive.consider({
      candidate: first.candidate,
      at: DAY2,
      conversationState: 'IDLE',
      sessionId: h.sessionId,
    });
    assert.equal(firstOutcome.speak, true, `应当开口：${firstOutcome.reasonCode} ${firstOutcome.score}`);
    h.engine.reconcile(DAY2);
    assert.equal(h.store.openThread(threadId)?.status, 'offered');

    // 他说的是天气，不是那件事。
    h.at(DAY2_CHITCHAT);
    h.say('今天天气不错啊。');
    const unrelated = h.engine.reconcile(DAY2_CHITCHAT);
    assert.equal(unrelated.settled.length, 0, '无关的一轮不能被当成回答');
    assert.deepEqual(
      unrelated.ignored.map((entry) => [entry.threadId, entry.text]),
      [[threadId, '今天天气不错啊。']],
      '不写事件，但要留下「这一轮不算回答」的凭据',
    );
    assert.equal(h.store.openThread(threadId)?.status, 'offered', '话题还开着，等的是那件事的回答');
    assert.equal(h.engine.followUps(DAY2_CHITCHAT).length, 0, '刚问过，不该立刻再问');

    // 过了 `reoffer_after_min`（180 分钟）：回到候选 —— 同一件事在窗口内还能再问一次。
    h.at(DAY2_REOFFER);
    const backToCandidate = h.engine.reconcile(DAY2_REOFFER);
    assert.equal(backToCandidate.expired.length, 0);
    assert.equal(backToCandidate.ignored.length, 1, '同一轮次再对齐一次仍然只是「不算回答」，不会变成回答');
    assert.equal(h.store.openThread(threadId)?.status, 'candidate');
    const second = openLoopPlans(h, DAY2_REOFFER)[0];
    assert.ok(second !== undefined, '他说了句别的不该让这件事消失');
    assert.match(second.candidate.candidateId, /-a2$/);
    const secondOutcome = await h.proactive.consider({
      candidate: second.candidate,
      at: DAY2_REOFFER,
      conversationState: 'IDLE',
      sessionId: h.sessionId,
    });
    assert.equal(secondOutcome.speak, true, `第二次追问也应当能过线：${secondOutcome.reasonCode} ${secondOutcome.score}`);
    h.engine.reconcile(DAY2_REOFFER);
    assert.equal(h.store.openThread(threadId)?.attempts, 2);

    // 这次他真的答了那件事 → 照旧收口，之后不再问。
    h.at(DAY2_REOFFER_ANSWER);
    h.say('办好了。');
    const settled = h.engine.reconcile(DAY2_REOFFER_ANSWER);
    assert.equal(settled.settled.length, 1);
    assert.equal(settled.settled[0]?.status, 'resolved');
    for (const day of [DAY3, DAY4]) {
      h.at(day);
      h.engine.reconcile(day);
      assert.equal(openLoopPlans(h, day).length, 0, `${day.toLocaleDateString()} 不该再追问同一件事`);
    }

    // 日志里的事实：无关的那一轮**一个事件都没写**；两次追问各留一条痕。
    assert.deepEqual(
      h.store
        .readEvents({ type: 'open_thread.changed', limit: Number.MAX_SAFE_INTEGER })
        .map((event) => (event.payload as { status: string }).status),
      ['candidate', 'offered', 'candidate', 'offered', 'resolved'],
    );
  } finally {
    h.store.close();
  }
});

test('他先聊了句别的、随后才答那件事：仍然收口，真正的追问没被静默丢掉', async () => {
  const h = harness();
  try {
    h.say(ERLAND);
    h.engine.reconcile(DAY1);

    h.at(DAY2);
    h.engine.reconcile(DAY2);
    const plan = openLoopPlans(h, DAY2)[0];
    assert.ok(plan !== undefined);
    const threadId = plan.candidate.topicRef ?? '';
    await h.proactive.consider({ candidate: plan.candidate, at: DAY2, conversationState: 'IDLE', sessionId: h.sessionId });
    h.engine.reconcile(DAY2);

    // 先说了句与话题无关的，再答那件事：中间那句不该把话题关掉，否则真正的回答无处可落。
    h.at(DAY2_CHITCHAT);
    h.say('今天天气不错啊。');
    assert.equal(h.engine.reconcile(DAY2_CHITCHAT).settled.length, 0);

    h.at(DAY2_LATE_ANSWER);
    h.say('办好了，昨天就办完了。');
    const settled = h.engine.reconcile(DAY2_LATE_ANSWER);
    assert.equal(settled.settled.length, 1, '那件事的回答没被前面那句闲聊挤掉');
    assert.equal(settled.settled[0]?.status, 'resolved');
    assert.equal(h.store.openThread(threadId)?.note, '用户回答：办好了，昨天就办完了。');

    for (const day of [DAY3, DAY4]) {
      h.at(day);
      h.engine.reconcile(day);
      assert.equal(h.engine.followUps(day).length, 0, `${day.toLocaleDateString()} 不该再追问同一件事`);
      assert.equal(openLoopPlans(h, day).length, 0);
    }
    assert.equal(
      h.store
        .readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })
        .filter((event) => (event.payload as { speak: boolean }).speak).length,
      1,
      '这件事只被主动问过了一次',
    );
  } finally {
    h.store.close();
  }
});

test('重启之后仍然记得那件事：话题表是投影，日志是唯一事实来源', async () => {
  const h = harness();
  try {
    h.say(ERLAND);
    h.engine.reconcile(DAY1);
    h.store.close();

    // 新进程、同一份数据库：重新对齐（幂等）后仍然只有一个候选，不会因为重启多记一件事。
    const reopened = openXixiStore({ dbPath: join(h.dir, 'xixi.sqlite'), clock: () => DAY2 });
    try {
      const engine = new TopicEngine({ store: reopened, clock: () => DAY2 });
      const reconciled = engine.reconcile(DAY2);
      assert.equal(reconciled.created.length, 0, '同一批日志不会再生出第二条话题');
      assert.equal(engine.followUps(DAY2).length, 1, '重启后照样记得那件事');
      assert.equal(reopened.openThreads({ status: 'candidate' }).length, 1);
      assert.equal(reopened.readEvents({ type: 'open_thread.changed', limit: Number.MAX_SAFE_INTEGER }).length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    h.store.close();
  }
});
