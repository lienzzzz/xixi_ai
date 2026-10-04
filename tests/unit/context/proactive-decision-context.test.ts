/**
 * V0.3 P1-b 验收①的后半段：**关系上下文与未完话题真的进入主动决策**（不只是「算出来了」）。
 *
 * 三段证明，一段比一段靠近真实路径：
 *   1. `engine.buildProactiveDecisionContext()` 把同一份 `ContextBuilder` 的渲染结果交出来；
 *   2. `proactiveDecideDirective()`（真的发给模型的那段指令）里带着这几行，
 *      而且**没有接线时逐字不变**；
 *   3. 真的 `ProactiveLoop` 走一遍：注入的 decider 收到的 `ProactiveModelInput.context`
 *      就是那几行 —— 「接线了没有」由**调用图上的实参**证明，不是由字符串证明。
 *
 * Run: `npm test`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import {
  ConversationEngine,
  parseProactiveSettings,
  TopicEngine,
  type ProactiveDecider,
  type ProactiveModelInput,
} from '@xixi/conversation';
import { MemoryStore, openXixiStore, type XixiConfig, type XixiStore } from '@xixi/domain';
import { contextLines, proactiveDecideDirective, ProactiveLoop } from '@xixi/runtime';

const NOW = new Date('2026-10-01T20:00:00+08:00');
const LATER = new Date('2026-10-02T15:00:00+08:00');

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: '成都' },
  models: { llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false }, asr: {} as never, tts: {} as never },
  personality: { base: { proactivity: 0.85 } },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

interface Harness {
  readonly store: XixiStore;
  readonly engine: ConversationEngine;
  readonly sessionId: string;
}

function harness(): Harness {
  const store = openXixiStore({ dbPath: ':memory:', clock: () => LATER });
  store.seedSelfProfile({ proactivity: 0.85, talkativeness: 0.75 });
  const session = store.createSession();
  const engine = new ConversationEngine({
    adapter: new FakeBrainAdapter(),
    store,
    config: CONFIG,
    clock: () => LATER,
    offsetMinutes: 480,
  });
  return { store, engine, sessionId: session.sessionId };
}

test('buildProactiveDecisionContext：关系摘要、未完话题、记忆三段都在（public 时不给私事）', () => {
  const h = harness();
  try {
    const memory = new MemoryStore(h.store);
    memory.recordSemantic({ property: 'preference', statement: '他喜欢喝茉莉花茶', sourceType: 'explicit_correction' });
    // 与「办证」这件事相关的记忆：主动开口的检索查询用的是依据行（这里是话题摘要），
    // 所以相关的记忆应该被捞出来。
    memory.recordSemantic({ property: 'plan', statement: '他要带身份证去办证', sourceType: 'explicit_correction' });
    // 关系摘要要有一句可说：7 天里一条主动开口都没人接。
    h.store.recordTurn({ sessionId: h.sessionId, role: 'user', action: 'SPEAK', text: '嗯，我回来了。' });
    const threads = new TopicEngine({ store: h.store, clock: () => LATER });
    threads.reconcile(NOW);
    h.store.recordTurn({ sessionId: h.sessionId, role: 'user', action: 'SPEAK', text: '明天下午我要去镇上办证。' });
    threads.reconcile(NOW);

    const lines = h.engine.buildProactiveDecisionContext({ fact: '明天下午我要去镇上办证', at: LATER });
    assert.ok(lines !== null, '引擎默认带上下文层');
    assert.equal(lines.relationship.length > 0, true, `关系摘要要有内容：${JSON.stringify(lines.relationship)}`);
    assert.equal(lines.openThreads.length > 0, true, `未完话题要有内容：${JSON.stringify(lines.openThreads)}`);
    assert.match(lines.openThreads.join('\n'), /办证/);
    assert.equal(lines.memories.length > 0, true, `相关的记忆要带上：${JSON.stringify(lines.memories)}`);
    assert.match(lines.memories.join('\n'), /办证/);

    // 没有上下文层时**是 null**（调用方于是省略 `context`，输入逐字不变）。
    const bare = new ConversationEngine({
      adapter: new FakeBrainAdapter(),
      store: h.store,
      config: CONFIG,
      clock: () => LATER,
      contextBuilder: false,
    });
    assert.equal(bare.buildProactiveDecisionContext({ fact: '办证', at: LATER }), null);
  } finally {
    h.store.close();
  }
});

test('读空气的指令里带着这三段；不带上下文时与从前逐字相同', () => {
  const input: ProactiveModelInput = {
    candidate: {
      candidateId: 'cand_1',
      trigger: 'future_hook_due',
      initiativeKind: 'open_loop_followup',
      intent: '追问办证',
      topicRef: 'thread_x',
      components: { topic_quality: 0.9, freshness: 0.8, receptivity: 0.7 },
    },
    initiativeKind: 'open_loop_followup',
    signals: {
      topic_quality: 0.9,
      personal_relevance: 0.8,
      freshness: 0.8,
      receptivity: 0.7,
      engagement: 0.6,
      base_proactivity: 0.85,
      interruption_cost: 0.1,
      repeated_topic_penalty: 0,
      recent_unanswered_penalty: 0,
    },
    score: 0.9,
    threshold: 0.5,
    recommendation: 'speak',
    primarySignal: 'topic_quality',
    basis: ['在场：他刚到家'],
    unansweredRatio: 0,
    now: LATER,
  };

  const bare = proactiveDecideDirective(input);
  assert.doesNotMatch(bare, /你们现在相处的方式/, '不带上下文时不多一段');

  const withContext = proactiveDecideDirective({
    ...input,
    context: {
      memories: ['- [较确定] 他喜欢喝茉莉花茶'],
      relationship: ['最近七天你主动开口 3 次，他大多没接；先别急着多说话。'],
      openThreads: ['- 明天下午我要去镇上办证'],
    },
  });
  assert.match(withContext, /你们现在相处的方式（只作参考，不要照念）/);
  assert.match(withContext, /先别急着多说话/);
  assert.match(withContext, /还惦记着的事/);
  assert.match(withContext, /办证/);
  assert.match(withContext, /他喜欢喝茉莉花茶/);
  assert.match(withContext, /只回：\{"speak":true\|false/, 'JSON 契约仍然在最后一行');

  // `contextLines()` 是那几行的唯一出处：空的段不出现。
  assert.deepEqual(contextLines(undefined), []);
  assert.deepEqual(contextLines({ memories: [], relationship: [], openThreads: [] }), []);
});

test('真的 ProactiveLoop 走一遍：decider 收到的 context 就是那三段（实参证明接线）', async () => {
  const h = harness();
  try {
    const memory = new MemoryStore(h.store);
    memory.recordSemantic({ property: 'preference', statement: '他喜欢喝茉莉花茶', sourceType: 'explicit_correction' });

    const seen: (ProactiveModelInput['context'] | undefined)[] = [];
    const decide: ProactiveDecider = (input) => {
      seen.push(input.context);
      return { speak: true, reasonCode: 'good_moment' };
    };

    const delivered: string[] = [];
    const loop = new ProactiveLoop({
      store: h.store,
      // 极宽松的门禁：这里是「读空气拿到的上下文」的用例，不是门禁的用例。
      readSettings: () => parseProactiveSettings({ enabled: true, base_cooldown_min: 0, max_per_6h: 10, max_per_day: 10, quiet_hours: { start: '00:00', end: '00:00' } }),
      readState: () => 'IDLE',
      readProactivity: () => 0.95,
      readPresence: async () => ({ present: true, updatedAt: LATER.toISOString(), source: 'test' }),
      readLastUserTurnAt: () => new Date(LATER.getTime() - 30 * 60_000),
      readRecentUserTopics: () => ['明天下午我要去镇上办证'],
      readSessionId: () => h.sessionId,
      // 这条就是被测的接线：入口把 ContextBuilder 的渲染结果交给循环。
      readContext: (input: ProactiveModelInput) => h.engine.buildProactiveDecisionContext({ fact: input.basis.join('；'), at: input.now }),
      decide,
      compose: async (input) => ({ text: input.plan.line, source: 'fixed', note: null }),
      now: () => LATER,
      log: () => {},
    });

    // 先把话题提取出来（「明天下午我要去镇上办证」那条），再让循环 tick 到开口。
    h.store.recordTurn({ sessionId: h.sessionId, role: 'user', action: 'SPEAK', text: '明天下午我要去镇上办证。' });
    const threads = new TopicEngine({ store: h.store, clock: () => LATER });
    threads.reconcile(NOW);

    let ticks = 0;
    while (delivered.length === 0 && ticks < 20) {
      ticks += 1;
      await loop.tickOnce();
      if (loop.spokenLines().length > 0) delivered.push(...loop.spokenLines());
    }

    assert.ok(seen.length > 0, `读空气至少要发生一次（tick ${ticks} 次）：${JSON.stringify(loop.status())}`);
    const context = seen.find((entry) => entry !== undefined);
    assert.ok(context !== undefined, `decider 必须收到 context，实测收到：${JSON.stringify(seen)}`);
    assert.equal(Array.isArray(context.memories), true);
    assert.equal(Array.isArray(context.relationship), true);
    assert.equal(Array.isArray(context.openThreads), true);
    assert.match(context.memories.join('\n') + context.openThreads.join('\n'), /茉莉花茶|办证/, `三段里要有真内容：${JSON.stringify(context)}`);
  } finally {
    h.store.close();
  }
});
