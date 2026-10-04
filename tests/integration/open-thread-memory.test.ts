/**
 * pack §7 的边界：**OpenThread 是「将来还要接的话」，Memory 是「已经发生的事」**。
 *
 * 三句话各有断言：
 *   * 话题**收口成 resolved** 之后，可以生成一条 episodic（那件事办完了 = 经历）；
 *   * 收口之后**不能再成为主动候选**（`followUps` 只取 `candidate`）；
 *   * **不物理删除历史**（那一行还在，只是状态变了；再对齐一次也不会多写一条记忆）。
 *
 * Run: `npm test`（integration 在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toOffsetIso } from '@xixi/contracts';
import { TopicEngine } from '@xixi/conversation';
import { MemoryStore, openXixiStore, type XixiStore } from '@xixi/domain';

const DAY1 = new Date(2026, 9, 1, 20, 0, 0);
const DAY2 = new Date(2026, 9, 2, 15, 0, 0);
const ANSWER = new Date(2026, 9, 2, 15, 30, 0);

interface Harness {
  readonly store: XixiStore;
  readonly memory: MemoryStore;
  readonly engine: TopicEngine;
  readonly sessionId: string;
  readonly say: (text: string, at: Date) => string;
}

function harness(): Harness {
  // 可变时钟：`recordTurn` 写下的时间戳就是被模拟的那一天（生产里是真实时钟）。
  // 固定时钟会让「第 2 天回答」写成第 1 天的时间，于是收口那一步永远看不到那一轮（实测踩过）。
  let now = DAY1;
  const store = openXixiStore({ dbPath: ':memory:', clock: () => now });
  store.seedSelfProfile({});
  const session = store.createSession();
  const engine = new TopicEngine({ store, clock: () => now });
  return {
    store,
    memory: new MemoryStore(store),
    engine,
    sessionId: session.sessionId,
    say: (text, at) => {
      now = at;
      return store.recordTurn({
        sessionId: session.sessionId,
        role: 'user',
        action: 'SPEAK',
        text,
      }).event.event_id;
    },
  };
}

test('话题收口成 resolved 之后：写一条 episodic、不再候选、历史不删、重放不重复', () => {
  const h = harness();
  try {
    // Day 1：他说了一件没办完的事 → 提取成话题。
    const firstTurnId = h.say('明天下午我要去镇上办证。', DAY1);
    assert.match(firstTurnId, /^evt_/);
    const created = h.engine.reconcile(DAY1);
    assert.equal(created.created.length, 1);
    const thread = created.created[0];
    assert.ok(thread !== undefined);
    assert.equal(created.memories.length, 0, '还没收口，不写记忆');

    // Day 2：西西真的问了（这里直接标成 offered，等价于日志里那条主动记录的效果）。
    const offered = h.engine.threads.transition(thread.threadId, 'offered', { at: DAY2, offered: true, note: '主动追问了' });
    assert.equal(offered?.thread.status, 'offered');

    // 他答「办好了」→ 收口 resolved，并写一条记忆。
    const answerTurnId = h.say('办好了，昨天就办完了。', ANSWER);
    const settled = h.engine.reconcile(ANSWER);
    assert.equal(settled.settled.length, 1);
    assert.equal(settled.settled[0]?.status, 'resolved');
    assert.equal(settled.memories.length, 1, '收口的那一刻生成 episodic（pack §7）');

    const memory = settled.memories[0];
    assert.ok(memory !== undefined);
    assert.equal(memory.kind, 'episode');
    assert.equal(memory.sourceType, 'program_extraction');
    assert.equal(memory.sourceEventId, answerTurnId, '记忆指回「他说办好了」那一轮（铁律 4）');
    assert.match(memory.summary, /办完了/);
    assert.match(memory.summary, /去镇上办证/, '说清是哪件事');
    assert.equal(memory.occurredAt, toOffsetIso(ANSWER), '事情发生的时间 = 他回答的那一刻');

    // 边界二：收口之后不再成为主动候选。
    assert.equal(h.engine.followUps(DAY2).length, 0, '已收口的话题不许再进候选');
    assert.equal(h.engine.followUps(new Date(DAY2.getTime() + 6 * 60 * 60_000)).length, 0, '过了追问窗口也一样');

    // 边界三：历史不删 —— 那一行还在，只是状态变了。
    const row = h.store.openThread(thread.threadId);
    assert.notEqual(row, null, '不物理删除历史');
    assert.equal(row?.status, 'resolved');
    assert.equal(row?.summary, thread.summary, '摘要一字不改');
    assert.equal(h.store.openThreads({ limit: 10 }).length, 1, '全量视图里看得见它');

    // 幂等：再对齐一次不会写第二条记忆（常驻循环每个 tick 都调 reconcile）。
    const again = h.engine.reconcile(new Date(ANSWER.getTime() + 60_000));
    assert.equal(again.memories.length, 0);
    assert.equal(h.memory.episodic({ kind: 'episode', limit: 10 }).length, 1);

    // 而这条记忆**是**可以被想起来的（它进的是记忆，不是话题）。
    const retrieverHit = h.memory.episodic({ kind: 'episode', limit: 10 })[0];
    assert.match(retrieverHit?.summary ?? '', /去镇上办证/);
  } finally {
    h.store.close();
  }
});

test('没办完（snoozed）不写「办完了」那种记忆', () => {
  const h = harness();
  try {
    h.say('明天下午我要去镇上办证。', DAY1);
    const thread = h.engine.reconcile(DAY1).created[0];
    assert.ok(thread !== undefined);
    h.engine.threads.transition(thread.threadId, 'offered', { at: DAY2, offered: true });

    h.say('还没办，过两天再去。', ANSWER);
    const settled = h.engine.reconcile(ANSWER);
    assert.equal(settled.settled[0]?.status, 'snoozed');
    assert.equal(settled.memories.length, 0, '没办完不是「发生过的事」，不写 episodic');
    assert.equal(h.memory.episodic({ limit: 10 }).length, 0);
  } finally {
    h.store.close();
  }
});
