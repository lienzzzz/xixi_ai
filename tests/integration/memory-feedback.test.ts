/**
 * pack Phase 4 的端到端离线用例（无模型、无网络）：长期记忆 + 三层自我画像 + **异步**反馈解释。
 *
 * 这一层要证明的是**接缝**，而不只是规则：
 *
 *   * 走真实的 `ConversationEngine.respond`（回复、落库、FSM 都真的跑）；
 *   * 后台提取由 `TurnMemoryExtractor` 排队，**回复返回时还没提取**（不阻塞语音）；
 *   * 提取之后：记忆/学习/会话覆盖/关系笔记都真的落库，并且重启后还在；
 *   * 「今天想安静点」只对当天有效，次日恢复。
 *
 * Run: `npm test`（integration 也在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { ConversationEngine, proactiveThreshold, TurnMemoryExtractor, type PostTurnJob } from '@xixi/conversation';
import { MemoryStore, openXixiStore, SelfModel, type XixiConfig, type XixiStore } from '@xixi/domain';

const DAY1 = new Date(2026, 9, 1, 20, 0, 0);
const DAY2 = new Date(2026, 9, 2, 9, 0, 0);

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
  readonly dir: string;
  readonly store: XixiStore;
  readonly sessionId: string;
  readonly engine: ConversationEngine;
  readonly extractor: TurnMemoryExtractor;
  readonly memory: MemoryStore;
  readonly selfModel: SelfModel;
  /** 排到队列里的活（手动调度：测试自己决定什么时候跑）。 */
  readonly scheduled: (() => void)[];
  readonly at: (moment: Date) => void;
  readonly say: (text: string, hooks?: Parameters<ConversationEngine['respond']>[1]) => Promise<Awaited<ReturnType<ConversationEngine['respond']>>>;
}

function harness(options: { readonly dir?: string } = {}): Harness {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'xixi-memory-'));
  let now = DAY1;
  const store = openXixiStore({ dbPath: join(dir, 'xixi.sqlite'), clock: () => now });
  store.seedSelfProfile({ proactivity: 0.85, talkativeness: 0.75, verbosity: 0.7, follow_up_probability: 0.5 });
  const session = store.createSession();
  const memory = new MemoryStore(store);
  const selfModel = new SelfModel(store);
  const scheduled: (() => void)[] = [];
  const extractor = new TurnMemoryExtractor({
    store,
    selfModel,
    memory,
    scheduler: (run) => scheduled.push(run),
  });
  const engine = new ConversationEngine({
    adapter: new FakeBrainAdapter(),
    store,
    config: CONFIG,
    clock: () => now,
    afterTurn: (job: PostTurnJob) => extractor.enqueue(job),
  });
  return {
    dir,
    store,
    sessionId: session.sessionId,
    engine,
    extractor,
    memory,
    selfModel,
    scheduled,
    at: (moment) => {
      now = moment;
    },
    say: (text, hooks) => engine.respond({ sessionId: session.sessionId, text, at: now }, hooks),
  };
}

test('异步提取不阻塞回复：回复返回时还没提取，flush 之后才落库', async () => {
  const h = harness();
  try {
    const turn = await h.say('明天下午我要去镇上办证。');
    assert.equal(turn.accepted, true);
    assert.equal(turn.text, '模拟回复：明天下午我要去镇上办证。', '回复就是回复，与提取无关');

    // 关键断言：**回复已经返回**，而提取还在队列里 —— 没写记忆、没学反馈。
    assert.equal(h.extractor.pending, 1);
    assert.equal(h.extractor.processed, 0);
    assert.equal(h.memory.episodic().length, 0);
    assert.equal(h.store.learnedDeltas().length, 0);
    assert.equal(h.scheduled.length, 1, '活被排给了调度器（生产里是一个宏任务）');

    await h.extractor.flush();
    assert.equal(h.extractor.pending, 0);
    assert.equal(h.extractor.processed, 1);
    const episodic = h.memory.episodic();
    assert.equal(episodic.length, 1);
    assert.equal(episodic[0]?.kind, 'plan');
    assert.match(episodic[0]?.summary ?? '', /办证/);
    // 每条记忆都能回到原始事实：source_event_id 就是那条用户轮次的事件 id。
    const userTurn = h.store
      .readEvents({ type: 'conversation.turn', limit: Number.MAX_SAFE_INTEGER })
      .find((event) => (event.payload as { role: string }).role === 'user');
    assert.equal(episodic[0]?.sourceEventId, userTurn?.event_id);

    // 再跑一次 flush 不会写第二遍（同一条轮次只记一次）。
    await h.extractor.flush();
    assert.equal(h.memory.episodic().length, 1);
  } finally {
    h.store.close();
  }
});

test('三条离线用例走真实引擎：「主动一点」「话太多」「今天安静点」', async () => {
  const h = harness();
  try {
    // ① 主动一点：学习到的主动性上升 → 主动阈值下降。
    const before = proactiveThreshold(h.store.selfProfile().proactivity);
    await h.say('你可以主动一点。');
    await h.extractor.flush();
    const after = proactiveThreshold(h.store.selfProfile().proactivity);
    assert.equal(h.store.selfProfile().proactivity, 0.97);
    assert.ok(after < before, `阈值必须下降：${before} → ${after}`);

    // ② 话太多：优先降话痨参数（proactivity 只降 0.02）。
    await h.say('你话太多了。');
    await h.extractor.flush();
    const effective = h.store.selfProfile();
    // talkativeness 先被 ① 加了 0.05，再被 ② 减 0.12 → 0.75 + 0.05 − 0.12 = 0.68。
    assert.equal(effective.talkativeness, 0.68);
    assert.equal(effective.verbosity, 0.6);
    assert.equal(effective.proactivity, 0.95, '0.85 + 0.12 − 0.02');
    assert.ok(
      (0.75 - (effective.talkativeness ?? 0)) + (0.7 - (effective.verbosity ?? 0)) > 0.1,
      '话痨参数的降幅远大于 proactivity 的 0.02',
    );
    const chatStyle = h.memory.notes({ aspect: 'chat_style' });
    assert.equal(chatStyle.length, 2, '①「主动一点」与②「话太多」各记一条关系笔记');
    assert.ok(
      chatStyle.some((note) => note.note.includes('少说')),
      `「话太多」那条要写清楚少说什么：${JSON.stringify(chatStyle.map((note) => note.note))}`,
    );

    // ③ 今天安静点：写会话覆盖，只对当天生效。
    await h.say('今天想安静点。');
    await h.extractor.flush();
    assert.equal(h.store.selfProfile({ now: DAY1 }).proactivity, 0.65, '0.95 − 0.30');
    assert.equal(h.selfModel.overrides(DAY1).length, 3);
    h.at(DAY2);
    assert.equal(h.store.selfProfile({ now: DAY2 }).proactivity, 0.95, '次日恢复（覆盖只写在昨天那一行）');
    assert.equal(h.selfModel.overrides(DAY2).length, 0);
  } finally {
    h.store.close();
  }
});

test('学习后的有效人格真的进了提示词（反馈在行为上可验证）', async () => {
  const h = harness();
  try {
    const before = await h.say('你好。');
    assert.ok(
      before.prompt?.system.includes('可以主动接话') ?? false,
      '初始人格（talkativeness 0.75）会给出「可以主动接话」这句',
    );

    await h.say('你话太多了。');
    await h.extractor.flush();

    const after = await h.say('嗯。');
    const style = after.prompt?.sections.find((section) => section.name === 'effective-style')?.text ?? '';
    assert.ok(!style.includes('可以主动接话'), `学习之后不该再鼓励主动接话（talkativeness 0.63 < 0.65）：${style}`);
    assert.notEqual(before.prompt?.system, after.prompt?.system, '有效人格变了，稳定前缀就该变');
  } finally {
    h.store.close();
  }
});

test('记忆可查看、可编辑、可删除（AGENTS §5）', async () => {
  const h = harness();
  try {
    await h.say('明天下午我要去镇上办证。');
    await h.say('我平时喜欢早上听会儿新闻。');
    await h.extractor.flush();

    const semantic = h.memory.semantic();
    assert.equal(semantic.length, 1, '「我平时…」被记成一条稳定事实');
    assert.equal(semantic[0]?.property, 'routine');
    assert.match(semantic[0]?.statement ?? '', /早上听会儿新闻/);

    // 编辑：父亲说「记错了」时改它。
    const edited = h.memory.updateSemantic(semantic[0]?.memoryId ?? '', { statement: '我平时早上爱听评书' });
    assert.equal(edited.statement, '我平时早上爱听评书');

    // 删除：说「忘掉这个」时真的删掉。
    assert.equal(h.memory.forgetSemantic(edited.memoryId), true);
    assert.equal(h.memory.semantic().length, 0);
    const episodic = h.memory.episodic();
    assert.equal(h.memory.forget(episodic[0]?.memoryId ?? ''), true);
    assert.equal(h.memory.episodic().length, 0);
  } finally {
    h.store.close();
  }
});

test('重启后三层与记忆都还在（同一份数据库）', async () => {
  const h = harness();
  try {
    await h.say('你可以主动一点。');
    await h.say('今天想安静点。');
    await h.say('我平时喜欢早上听会儿新闻。');
    await h.extractor.flush();
    h.store.close();

    const reopened = openXixiStore({ dbPath: join(h.dir, 'xixi.sqlite'), clock: () => DAY1 });
    try {
      const self = new SelfModel(reopened);
      const memory = new MemoryStore(reopened);
      assert.equal(reopened.selfProfile({ now: DAY1 }).proactivity, 0.67, '0.85 + 0.12 − 0.30：学习层与当天覆盖都还在');
      assert.equal(self.learned().find((entry) => entry.property === 'proactivity')?.delta, 0.12);
      assert.equal(self.overrides(DAY1).length, 3);
      assert.equal(reopened.selfProfile({ now: DAY2 }).proactivity, 0.97, '第二天覆盖失效，学习层留下');
      assert.equal(memory.semantic().length, 1);
      // 历史也在：§7.5 的可解释性（「她怎么变成现在这样的」）不随重启丢失。
      assert.ok(self.history('proactivity').length >= 3);
    } finally {
      reopened.close();
    }
  } finally {
    h.store.close();
  }
});

test('提取接缝自己出错也不能毁掉这一轮', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-memory-boom-'));
  const store = openXixiStore({ dbPath: join(dir, 'xixi.sqlite'), clock: () => DAY1 });
  try {
    store.seedSelfProfile({ proactivity: 0.85 });
    const session = store.createSession();
    const notices: string[] = [];
    const engine = new ConversationEngine({
      adapter: new FakeBrainAdapter(),
      store,
      config: CONFIG,
      clock: () => DAY1,
      afterTurn: () => {
        throw new Error('boom');
      },
    });
    const turn = await engine.respond(
      { sessionId: session.sessionId, text: '你好。', at: DAY1 },
      { onNotice: (notice) => void notices.push(notice.code) },
    );
    assert.equal(turn.accepted, true, '提取入队失败不影响这一轮');
    assert.equal(turn.text, '模拟回复：你好。');
    assert.deepEqual(notices, ['EXTRACTION_ENQUEUE_FAILED'], '但必须留痕，不能悄悄吞掉');
  } finally {
    store.close();
  }
});
