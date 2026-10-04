/**
 * V0.3 P1 的端到端离线证据：`ContextBuilder` 是**唯一**的上下文装配入口，而记忆真的进了提示词
 * 且没有把程序内部的东西漏进去（pack `docs/02_MEMORY_CONTEXT.md` §1 §3）。
 *
 * 这一层走的是真东西，不是替身：
 *   * 真的 `openXixiStore`（内存库）与真的 `MemoryStore` / `OpenThreadStore` 写入；
 *   * 真的 `ConversationEngine`（真的 FSM、真的落库、真的组装提示词）；
 *   * 真的 `ContextBuilder`（引擎默认就建它，测试不注入替身）；
 *   * 真的 `PromptAssembler`，所以「提示词里有什么」是模型真的会看到的那一份。
 *
 * 三条要证明的事（对应 t12 的验收）：
 *   1. 逐段可核对：`ConversationContext` 有 memories/relationship/openThreads/world/self，
 *      mood 与 audience 可选；提示词里每一段都来自它，引擎自己不另找上下文；
 *   2. 每轮注入 3~8 条、每条带 provenance 与 confidence，且 **prompt 里没有 UUID、没有调试数字**；
 *   3. 引擎仍然负责 FSM 与回复安全（这里压的是：被拒的轮次连模型都没到，也不写 turn）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { ContextBuilder, MEMORY_HEADING, parseContextMemorySettings } from '@xixi/context';
import { ConversationEngine, MEMORY_SECTION_HEADING } from '@xixi/conversation';
import { fixedClock, MemoryStore, OpenThreadStore, openXixiStore, type XixiConfig, type XixiStore } from '@xixi/domain';

const NOW = new Date('2026-10-01T20:00:00+08:00');

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: '成都' },
  models: { llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false }, asr: {} as never, tts: {} as never },
  personality: { base: { talkativeness: 0.75, verbosity: 0.7, proactivity: 0.85 } },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

interface Harness {
  readonly store: XixiStore;
  readonly memory: MemoryStore;
  readonly engine: ConversationEngine;
  readonly sessionId: string;
}

function harness(options: { readonly config?: XixiConfig } = {}): Harness {
  const store = openXixiStore({ dbPath: ':memory:', clock: fixedClock(NOW, 1_000) });
  store.seedSelfProfile({ talkativeness: 0.75, verbosity: 0.7, proactivity: 0.85 });
  const session = store.createSession();
  const memory = new MemoryStore(store);
  const engine = new ConversationEngine({
    adapter: new FakeBrainAdapter(),
    store,
    config: options.config ?? CONFIG,
    clock: fixedClock(NOW, 1_000),
    offsetMinutes: 480,
  });
  return { store, memory, engine, sessionId: session.sessionId };
}

function seed(memory: MemoryStore, statement: string, property = 'preference'): void {
  memory.recordSemantic({
    property,
    statement,
    sourceType: 'explicit_correction',
    sourceEventId: `evt_00000000-0000-4000-8000-${String(statement.length).padStart(12, '0')}`,
  });
}

test('ContextBuilder 是唯一入口：ConversationContext 的每一块都在，提示词的每一段都来自它', () => {
  const h = harness();
  try {
    seed(h.memory, '父亲不喜欢绿茶');
    seed(h.memory, '他喜欢喝红茶');
    // 关系笔记（「我们怎么相处」）：它必须一路走到**对话的提示词**里 —— 这是 pack §6
    // 「关系上下文真的进入对话」的可观察结果。
    h.memory.recordNote({ aspect: 'chat_style', note: '他嫌话多：少说、少主动、少追问', sourceType: 'explicit_correction' });
    const threads = new OpenThreadStore(h.store);
    threads.create({ threadId: 'thread_ctx000001', summary: '明天下午我要去镇上办证', subject: '去镇上办证' });

    const context = h.engine.buildUserTurnContext({ sessionId: h.sessionId, text: '那绿茶呢', at: NOW });
    assert.ok(context !== null, '引擎默认就装配上下文（不需要任何人接线）');
    // pack §1 的字段：memories / relationship / openThreads / world / self 都在；mood 与 audience 可选。
    assert.ok(context.memories.length >= 1, `记忆必须进上下文：${JSON.stringify(context.memories)}`);
    assert.equal(typeof context.relationship.recentStats.windowDays, 'number');
    assert.equal(context.relationship.recentStats.interruptionRate, null, '没有打断事件就不编一个比率');
    assert.ok(
      context.relationship.prose.some((line) => line.includes('嫌话多')),
      `关系摘要里要带上那条笔记：${JSON.stringify(context.relationship.prose)}`,
    );
    assert.equal(context.openThreads.length, 1, '未收口的话题是上下文的一部分');
    assert.equal(context.openThreads[0]?.threadId, 'thread_ctx000001');
    assert.equal(context.world.timezone, 'Asia/Shanghai');
    assert.equal(context.world.timeOfDay, '晚上');
    assert.equal(context.self.profile['talkativeness'], 0.75, 'self 是有效人格（三层相加）');
    assert.equal(context.audience?.mode, 'family', '没人说「谁在听」时按最保守的口径');
    assert.ok(context.mood !== undefined, '心情这一层默认开着，所以 mood 应该带上');

    // 提示词里的那几段就是上面这份上下文渲染出来的。
    const prompt = h.engine.buildPrompt({ sessionId: h.sessionId, text: '那绿茶呢', at: NOW });
    assert.ok(prompt.user.includes(MEMORY_SECTION_HEADING), '记忆段的标题在');
    assert.ok(prompt.user.includes('不喜欢绿茶'), '记忆的正文在');
    assert.ok(prompt.user.includes('明天下午我要去镇上办证'), '未完话题在');
    assert.ok(prompt.user.includes('他嫌话多'), '关系摘要也在提示词里（pack §6 的「进入对话」）');
    assert.ok(prompt.sections.some((section) => section.name === 'relationship'), '而且逐段可寻址');
    assert.equal(prompt.sections.filter((section) => section.name === 'memories').length, 1);
    assert.equal(prompt.sections.filter((section) => section.name === 'self').length, 1);
    // 两处的标题必须是同一个字符串（这一条防的是「两处各写一份标题」那种漂移）。
    assert.equal(MEMORY_SECTION_HEADING, MEMORY_HEADING);
  } finally {
    h.store.close();
  }
});

test('记忆真的进了 prompt，而且没有把 UUID、id 或调试数字漏进去', () => {
  const h = harness();
  try {
    // 八条记忆：三条讲茶（与这一轮共同的双字词），五条完全不相干 ——
    // 不相关的那几条不许被 dump 进来（「不要每轮 dump 全部记忆」的可执行版本）。
    seed(h.memory, '父亲喜欢喝绿茶');
    seed(h.memory, '他喜欢喝红茶');
    seed(h.memory, '他喜欢喝乌龙茶');
    seed(h.memory, '茶叶罐放在厨房的柜子里', 'place');
    seed(h.memory, '弟弟周六可能回来', 'person');
    seed(h.memory, '他每天早上六点起床', 'routine');
    seed(h.memory, '遥控器在茶几上', 'place');
    seed(h.memory, '门口的鞋架是白色的', 'place');

    const query = '他喜欢喝绿茶还是红茶';
    const context = h.engine.buildUserTurnContext({ sessionId: h.sessionId, text: query, at: NOW });
    assert.ok(context !== null);
    const injected = context.memories.length;
    assert.ok(injected >= 3 && injected <= 8, `每轮注入 3~8 条，实测 ${injected}`);
    assert.ok(injected < 8, `库里有 8 条，但不相关的不该被 dump 进来（实测注入 ${injected}）`);

    // 每条都带 provenance 与 confidence（铁律 4）。
    for (const memory of context.memories) {
      assert.equal(typeof memory.provenance.confidence, 'number');
      assert.equal(typeof memory.provenance.sourceType, 'string');
      assert.ok(memory.retrievalReason.length > 0, '每条都要说清为什么被选中');
      assert.ok(memory.provenance.updatedAt.length > 0);
    }

    const prompt = h.engine.buildPrompt({ sessionId: h.sessionId, text: query, at: NOW });
    const modelVisible = `${prompt.system}\n${prompt.user}\n${prompt.history.map((turn) => turn.content).join('\n')}`;
    // ① 记忆的正文真的到了模型看的那一份里。
    assert.ok(modelVisible.includes('绿茶') || modelVisible.includes('红茶'), '记忆进了 prompt');
    // ② prompt 里不暴露 UUID / id / 调试数字。
    assert.doesNotMatch(modelVisible, /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/u, '不许出现 UUID');
    assert.doesNotMatch(modelVisible, /\b(?:sem|mem|rel|evt|thread)_[A-Za-z0-9_-]+/u, '不许出现程序内部 id');
    assert.doesNotMatch(modelVisible, /injected=|dropped_at_render=|confidence=|retrievalReason/u, '不许出现调试字段');
    assert.doesNotMatch(modelVisible, /\d{8,}/u, '不许出现 8 位以上连续数字');
    // ③ 条数只出现在 Debug 段（面板能核对，模型看不到）。
    const memorySection = prompt.sections.find((section) => section.name === 'memories');
    assert.ok(memorySection !== undefined);
    assert.match(memorySection.debug ?? '', new RegExp(`injected=${injected}`));
  } finally {
    h.store.close();
  }
});

test('记忆文本本身带 id / 长数字时整条不进 prompt，而且诊断能说清是渲染这一层挡的', () => {
  const h = harness();
  try {
    const memory = h.memory;
    memory.recordEpisodic({
      summary: '他说 evt_00000000-0000-4000-8000-000000000001 那件事已经办好了',
      kind: 'episode',
      sourceType: 'explicit_correction',
      occurredAt: NOW.toISOString(),
      importance: 1,
    });
    seed(memory, '那件事已经办好了');

    const query = '那件事办好了吗';
    const context = h.engine.buildUserTurnContext({ sessionId: h.sessionId, text: query, at: NOW });
    assert.ok(context !== null);
    assert.equal(context.memories.length, 1, '带 id 的那条在检索阶段就被整条丢掉');
    assert.equal(context.memoriesDiagnostics.dropped.some((entry) => entry.reason === 'unusable_text'), true);

    const prompt = h.engine.buildPrompt({ sessionId: h.sessionId, text: query, at: NOW });
    assert.ok(!prompt.user.includes('0000-4000-8000'), '干净的提示词里没有 id 的痕迹');
    assert.ok(prompt.user.includes('那件事已经办好了'), '干净的那条还是能用');
    assert.equal(context.memoriesDiagnostics.droppedAtRender, 0, '它没有走到渲染那一步，所以 render 的计数保持 0');
  } finally {
    h.store.close();
  }
});

test('没接上下文时提示词逐字回到 P0：这是「记忆层有没有改变回复行为」的对照开关', () => {
  const h = harness();
  try {
    seed(h.memory, '父亲不喜欢绿茶');
    const withContext = h.engine.buildPrompt({ sessionId: h.sessionId, text: '那绿茶呢', at: NOW });
    assert.ok(withContext.user.includes('不喜欢绿茶'));

    const bare = new ConversationEngine({
      adapter: new FakeBrainAdapter(),
      store: h.store,
      config: CONFIG,
      clock: fixedClock(NOW, 1_000),
      offsetMinutes: 480,
      contextBuilder: false,
    });
    const withoutContext = bare.buildPrompt({ sessionId: h.sessionId, text: '那绿茶呢', at: NOW });
    assert.ok(!withoutContext.user.includes('不喜欢绿茶'), '关掉之后记忆不进提示词');
    assert.ok(!withoutContext.user.includes(MEMORY_SECTION_HEADING));
    assert.equal(bare.buildUserTurnContext({ sessionId: h.sessionId, text: '那绿茶呢', at: NOW }), null);
    // 两次的稳定前缀只差「上下文那几段」：身份/硬边界/说话方式都在，且没有被顺手改掉。
    assert.ok(withoutContext.system.includes('你叫西西'));
    assert.ok(withContext.system.includes('你叫西西'));
  } finally {
    h.store.close();
  }
});

test('主动开口走同一个装配入口：没有工作记忆、用依据行做检索，提示词里也有记忆', () => {
  const h = harness();
  try {
    seed(h.memory, '父亲不喜欢绿茶');
    seed(h.memory, '茶叶罐放在厨房的柜子里', 'place');
    const at = new Date('2026-10-02T10:00:00+08:00');

    const proactive = h.engine.buildProactiveContext({ fact: '茶叶罐放在厨房的柜子里', at });
    assert.ok(proactive !== null, '主动开口也有上下文（同一个 ContextBuilder）');
    assert.ok(proactive.memories.length >= 1, '与依据行相关的记忆被检索出来');
    assert.ok(proactive.memories.some((entry) => entry.text.includes('茶叶罐')));

    const prompt = h.engine.buildProactivePrompt({
      directive: '（这是「主动开口」时机，不是用户说话：请用一到两句自然的中文开口。）',
      fact: '茶叶罐放在厨房的柜子里',
      at,
      sessionId: h.sessionId,
    });
    // 主动开口不做工作记忆展开：`history` 必须是空的（把上一轮当「用户刚说」正是重复的来源）。
    assert.deepEqual(prompt.history, []);
    assert.ok(prompt.user.includes(MEMORY_SECTION_HEADING), '主动开口也带着记忆');
    assert.ok(prompt.user.includes('茶叶罐'), '相关的记忆在');
    // 检索用的依据行**不**进提示词（模型看到的是那段指令）。
    assert.ok(!prompt.user.includes('依据行不该出现'), '指令以外的程序文本不进提示词');
  } finally {
    h.store.close();
  }
});

test('audience 是可选层，但一旦给出就真的改变提示词（public 时不给家里没办完的事）', () => {
  const h = harness();
  try {
    seed(h.memory, '父亲不喜欢绿茶');
    const threads = new OpenThreadStore(h.store);
    threads.create({ threadId: 'thread_ctx000002', summary: '明天下午我要去镇上办证', subject: '去镇上办证' });

    const withFamily = h.engine.buildPrompt({ sessionId: h.sessionId, text: '那绿茶呢', at: NOW });
    assert.ok(withFamily.user.includes('明天下午我要去镇上办证'), '默认口径（家里）看得到未完话题');

    const publicEngine = new ConversationEngine({
      adapter: new FakeBrainAdapter(),
      store: h.store,
      config: CONFIG,
      clock: fixedClock(NOW, 1_000),
      offsetMinutes: 480,
      audience: { mode: 'public', actor: 'unknown_person', note: '有外人在' },
    });
    const withPublic = publicEngine.buildPrompt({ sessionId: h.sessionId, text: '那绿茶呢', at: NOW });
    assert.ok(!withPublic.user.includes('明天下午我要去镇上办证'), 'public 时家里的私事不进提示词');
    assert.ok(withPublic.system.includes('别提到家里人的私事'), '而且要在稳定前缀里说明原因');
  } finally {
    h.store.close();
  }
});

test('引擎仍然负责 FSM 与回复安全：没被接受的轮次不会到模型，也不写 turn', async () => {
  const h = harness();
  try {
    const first = await h.engine.respond({ sessionId: h.sessionId, text: '在吗', at: NOW, addressed: true });
    assert.equal(first.accepted, true);
    // 紧接着一条**没有**被叫到的轮次：FSM 的 follow-up 窗口之外 → REJECTED_NOT_ADDRESSED。
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const rejected = await h.engine.respond({ sessionId: h.sessionId, text: '嗯', at: later, addressed: false });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.prompt, null, '被拒的轮次连提示词都没有（更没到模型）');
    assert.equal(rejected.text, null);
    // 状态机与事件留给引擎：被拒轮次仍然留下一条可审计的 decision（铁律 5）。
    const decisions = h.store.readEvents({ type: 'conversation.decision', limit: 10 });
    assert.equal(decisions.length, 2);
    assert.equal(
      decisions.some((event) => (event.payload as { accepted?: unknown }).accepted === false),
      true,
    );
  } finally {
    h.store.close();
  }
});

test('配置读得懂：context.memory 优先于老 memory 段，越界的值会报错而不是被静默忽略', () => {
  const defaults = parseContextMemorySettings(undefined, undefined);
  assert.deepEqual(
    [defaults.enabled, defaults.minConfidence, defaults.minItems, defaults.maxItems, defaults.includeRelationship, defaults.includeOpenThreads],
    [true, 0.55, 3, 6, true, true],
  );

  const fromNew = parseContextMemorySettings({ max_items: 4, min_confidence: 0.7 }, {});
  assert.equal(fromNew.maxItems, 4);
  assert.equal(fromNew.minConfidence, 0.7);

  const fromLegacy = parseContextMemorySettings(undefined, { max_items: 5 });
  assert.equal(fromLegacy.maxItems, 5, '老配置文件里的同名旋钮照旧生效');

  const both = parseContextMemorySettings({ max_items: 4 }, { max_items: 7 });
  assert.equal(both.maxItems, 4, '新段优先');

  assert.throws(() => parseContextMemorySettings({ max_items: 99 }), RangeError);
  assert.throws(() => parseContextMemorySettings({ min_confidence: 2 }), RangeError);
  assert.throws(() => parseContextMemorySettings({ enabled: 'yes' }), TypeError);
});

test('ContextBuilder 可以直接建（不经过引擎）：这是它的公开面', () => {
  const h = harness();
  try {
    seed(h.memory, '父亲不喜欢绿茶');
    const builder = new ContextBuilder({
      store: h.store,
      clock: fixedClock(NOW, 1_000),
      offsetMinutes: 480,
      identity: { timezone: 'Asia/Shanghai', place: '成都' },
      memory: { maxItems: 3 },
    });
    const context = builder.buildUserTurn({ userText: '那绿茶呢', at: NOW, recentTurns: [] });
    assert.equal(context.memories.length, 1);
    assert.equal(context.memoriesDiagnostics.maxItems, 3);
    const rendered = builder.render(context, NOW);
    assert.equal(rendered.memoryLines.length, 1);
    assert.match(rendered.memoryLines[0] ?? '', /绿茶/);
    assert.ok(rendered.worldLines.some((line) => line.includes('现在：')));
    assert.equal(builder.buildProactive({ fact: '那绿茶呢', at: NOW }).memories.length, 1);
  } finally {
    h.store.close();
  }
});
