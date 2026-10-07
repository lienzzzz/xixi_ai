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
import {
  ContextBuilder,
  DEFAULT_SELF_LINES,
  MEMORY_HEADING,
  MemoryRetriever,
  parseContextMemorySettings,
  renderGate,
  renderMemoryLines,
  renderOpenThreadLines,
  renderSelfLines,
  type RetrievedMemory,
} from '@xixi/context';
import { ConversationEngine, MEMORY_SECTION_HEADING, worldStateLite } from '@xixi/conversation';
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

/**
 * 这一条压的是**第一层**（检索前的 `usefulText`）：文本本身就是机器 id 拼出来的，所以它连
 * 候选都进不去，`droppedAtRender` 保持 0。它的断言是对的、一个字都没动 —— P1-D1 复审指出的
 * 是**覆盖面**只到第一层，所以下面另加了一条只走第二层（渲染前的 `renderGate`）的用例。
 */
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

/**
 * 只走**第二层**（渲染前的 `renderGate`）的用例 —— P1-D1 复审要求补的那一条。
 *
 * 两层各自的职责（上面那条压第一层，这条压第二层）：
 *   * **第一层：检索前**（`memory-retriever.ts` 的 `usefulText`）只拦**机器 id 形态**的文本：
 *     UUID 形状、8 位以上连续数字。命中就整条不进候选（连分数都不算）。
 *   * **第二层：渲染前**（`render.ts` 的 `renderGate`）在这一层之上**多**拦程序里的参数名
 *     （`valence` / `confidence` / `verbosity`…）与空白文本，而且**所有出口都过它**：
 *     记忆行、未完话题行、世界状态附加行、自我状态行。
 *
 * 这条用例刻意选一段**过得去第一层**的文本（只有参数名，没有 id、没有 8 位数字），
 * 并且让它与查询**共享双字词**（否则它会在检索阶段以 `not_relevant` 被丢掉，
 * 「记忆没进提示词」为真却与 `renderGate` 无关 —— 那是 T14 评审实测到过的陷阱）。
 *
 * ## 为什么不用 `engine.buildUserTurnContext(...)` 上的 `droppedAtRender` 做断言（T14 评审实测）
 *
 * `buildPrompt()` 内部**另建一次** context（`engine.ts` 里 `#context.buildUserTurn(...)`），
 * 所以调用方另外拿到的那个对象**不是被渲染的同一个实例**，它的计数**恒为 0**：闸门开着与关掉
 * 打印出来都是 0，读它等于没断言。正确的层次归因读装配好的 prompt 里 `memories` 段的
 * debug（`prompt.ts` 写的 `injected=… dropped_at_render=…`，值来自引擎渲染时用的那个实例）：
 *   * `injected=0` → 检索阶段就没进来（第一层拦的）；
 *   * `injected>0 且 dropped_at_render>0` → **真的是渲染层拦的**；
 *   * `injected>0 且 dropped_at_render=0` → 渲染层没拦（缺陷）。
 * 「记忆段里没有那个词」这三种长得一模一样，所以光看词不够。
 * 而「计数确实加一」这件事在 `ContextBuilder` 那一层可以直接断言（同一个实例先 build 再 render）。
 */
test('渲染层（第二道闸门）：参数名过得去检索，但一定进不了提示词，并且逐条计数', () => {
  const h = harness();
  try {
    // 参数名后面跟空格（满足 `\b`）：`usefulText` 只看 UUID 与 8 位以上数字，
    // 所以这段文本在第一层是**合格**的 —— 这正是本条要用的事实。
    const tainted = '他提过 valence 这个说法';
    h.memory.recordSemantic({
      property: 'person',
      statement: tainted,
      sourceType: 'explicit_correction',
      sourceEventId: 'evt_00000000-0000-4000-8000-00000000000a',
    });
    // 一条干净的、同样相关的记忆：被挡掉的只是那一条，而不是整段消失。
    h.memory.recordSemantic({
      property: 'person',
      statement: '他提过那个说法',
      sourceType: 'explicit_correction',
      sourceEventId: 'evt_00000000-0000-4000-8000-00000000000b',
    });

    // 用户这句话里**没有**那个参数名（否则提示词里的【用户这句话】会自己带上它，
    // 「prompt 里不出现那个词」就变成一句与闸门无关的话）；它与两条记忆共享「他提过」「个说」「说法」。
    const query = '他提过那个说法吗';

    // ① 第一层放行：直接问检索器，带参数名的那条**真的进了候选**（这条断言与实例无关）。
    const retrieved = new MemoryRetriever(h.store).retrieve({
      query,
      now: NOW,
      audience: { mode: 'family', actor: null, note: '这一条用例只看检索层放不放行' },
      recentTurns: [],
    });
    assert.equal(
      retrieved.memories.some((entry) => entry.text.includes('valence')),
      true,
      `它必须在候选里（否则这条用例测的是第一层）：${JSON.stringify(retrieved.memories.map((entry) => entry.text))}`,
    );

    // ② **主判据**：直接调产品自己的渲染函数 —— 它没有副作用，也不依赖「那一段在不在」。
    const droppedOne = renderMemoryLines([taintedMemory()], NOW);
    assert.deepEqual(droppedOne.lines, [], '带参数名的那条渲染出来是空的');
    assert.equal(droppedOne.dropped.length, 1);
    assert.equal(droppedOne.dropped[0]?.id, 'mem_tainted', '丢的确实是它');
    assert.equal(droppedOne.dropped[0]?.reason, 'unusable_text');

    // ③ 端到端交叉验证：读**装配好的 prompt** 里 `memories` 段的 debug 做层次归因。
    //
    // 为什么要一对记忆（T14 评审给的形态）：渲染层把**每一条**都拦掉时，`prompt.ts` 会让整个
    // `memories` 段不存在，那个 debug 根本读不到 —— 而「段不存在」与「检索层就没进来」长得
    // 一模一样。留一条干净的对照，段就一定在，于是 `injected=2 dropped_at_render=1` 可读。
    const prompt = h.engine.buildPrompt({ sessionId: h.sessionId, text: query, at: NOW });
    const memorySection = prompt.sections.find((section) => section.name === 'memories');
    const debug = memorySection?.debug ?? '';
    assert.equal(/injected=2/u.test(debug), true, `检索层两条都选上了（所以差别只可能在渲染层）：${debug}`);
    assert.equal(/dropped_at_render=1/u.test(debug), true, `渲染层丢了一条，计数必须说得出这一点：${debug}`);
    assert.doesNotMatch(prompt.user, /valence/u, `参数名不许出现在提示词里：\n${prompt.user}`);
    assert.doesNotMatch(prompt.system, /valence/u, '稳定前缀里同样不许');
    assert.ok(prompt.user.includes('他提过那个说法'), '同一批里干净的那条照旧进提示词');
    assert.ok(prompt.user.includes(MEMORY_SECTION_HEADING), '记忆段本身没有被整段连坐');

    // ④ 「计数加一」在 ContextBuilder 那一层直接可见（同一个实例：先 build 再 render）。
    const builder = new ContextBuilder({
      store: h.store,
      clock: fixedClock(NOW, 1_000),
      offsetMinutes: 480,
      identity: { timezone: 'Asia/Shanghai', place: '成都' },
    });
    const context = builder.buildUserTurn({ userText: query, at: NOW, recentTurns: [] });
    assert.equal(context.memoriesDiagnostics.droppedAtRender, 0, '渲染之前计数是 0');
    assert.equal(context.memoriesDiagnostics.injected, 2);
    const rendered = builder.render(context, NOW);
    assert.equal(context.memoriesDiagnostics.droppedAtRender, 1, '这一步就是「加一」');
    assert.deepEqual(rendered.memoryLines, ['- [较确定] 他提过那个说法'], '留下的只有干净那条');

    // ⑤ 同类的出口也走同一道闸门（不是只有记忆行过它）。
    assert.deepEqual(renderOpenThreadLines([{ summary: 'valence 这件事得问一下' }]), [], '未完话题行过闸门');
    assert.deepEqual(renderSelfLines(['valence 已经按设定调过了']), [], '自我状态行过闸门');
    assert.deepEqual(renderSelfLines(), [...DEFAULT_SELF_LINES], '不传参数时那一句照旧（live 路径逐字不变）');

    // ⑥ 直接对闸门做单元断言（不经过引擎）——三种现实写法都要被拦住。
    assert.equal(renderGate('- valence=0.310'), false, '面板那种 k=v 写法');
    assert.equal(renderGate('- confidence 0.9'), false, '参数名 + 空格');
    assert.equal(renderGate('- 他提过valence这个说法'), false, '汉字紧贴也是词边界（\\b 在 CJK 与 ASCII 之间成立）');
    assert.equal(renderGate('- 他喜欢喝茉莉花茶'), true, '普通句子照旧放行');
    assert.equal(renderGate('   '), false, '空白文本不成行');
  } finally {
    h.store.close();
  }
});

/** 一条带参数名的 `RetrievedMemory`（渲染函数的入参形状）。 */
function taintedMemory(): RetrievedMemory {
  return {
    id: 'mem_tainted',
    kind: 'semantic',
    text: '他提过 valence 这个说法',
    provenance: {
      sourceEventId: null,
      sourceType: 'explicit_correction',
      confidence: 1,
      occurredAt: null,
      updatedAt: NOW.toISOString(),
    },
    visibility: 'family',
    retrievalReason: '和这一轮说的是同一件事',
  };
}

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

/**
 * V0.3 P2.5-J 修的第一个缺口（**真实装配点**）：`ContextBuilder` 早就算出了世界状态（含在场判断），
 * 但引擎组提示词时没有把它送进去 —— 用的是 `worldStateLite` 的轻量版本（时间 / 时区 / 时段 / 星期），
 * 于是库里写着「他这会儿在家」，正常聊天时模型根本看不到。
 *
 * 这一条走的是真东西：真 `openXixiStore` + 真 `recordPresenceChanged`（事件与投影一个事务）+
 * 真 `ConversationEngine` + 它自己建的 `ContextBuilder`，所以「提示词里有在场」是端到端的事实。
 *
 * 反事实（本任务实测过）：把 `#contextSections` 里的 `worldState` 那一行删掉 → 「在场判断必须到模型那里」
 * 那条断言红（这正是本任务修之前的样子）。
 */
test('世界状态（含在场判断）进真实装配点的提示词，而且时间与星期只出现一遍', () => {
  const h = harness();
  try {
    h.store.recordPresenceChanged({ present: true, confidence: 0.9, ttlSeconds: 3_600, sourceDetail: 't6 fixture' });

    const context = h.engine.buildUserTurnContext({ sessionId: h.sessionId, text: '我在家吗', at: NOW });
    assert.ok(context !== null);
    assert.equal(context.world.presence?.present, true, '库里那一行说的是「在家」');
    assert.equal(context.world.presence?.stale, false, 'TTL 之内，不算过期');

    const prompt = h.engine.buildPrompt({ sessionId: h.sessionId, text: '我在家吗', at: NOW });
    assert.ok(prompt.user.includes('在场：他这会儿在家。'), `在场判断必须到模型那里：\n${prompt.user}`);
    const worldSection = prompt.sections.find((section) => section.name === 'world-state');
    assert.ok(worldSection !== undefined, '世界状态是一段可寻址的段（Debug UI 按名字读它）');
    assert.ok(worldSection.text.includes('在场：他这会儿在家。'), '段正文里也有它');
    // 不重复：上下文层那一份**替代**了轻量写法，而不是两份一起拼进来。
    for (const marker of ['现在：', '时段：', '星期：', '周四']) {
      assert.equal(prompt.user.split(marker).length - 1, 1, `「${marker}」只许出现一次：\n${prompt.user}`);
    }
    // 主动开口那条路走同一份装配（同一个 `#contextSections`），所以世界状态一样在里面。
    const proactive = h.engine.buildProactivePrompt({
      directive: '（这是「主动开口」时机。）',
      fact: '我在家吗',
      at: NOW,
      sessionId: h.sessionId,
    });
    assert.ok(proactive.user.includes('在场：他这会儿在家。'), '主动开口也看得到在场判断');
  } finally {
    h.store.close();
  }
});

/**
 * 验收第三条：**上下文层关掉时退回原来的轻量写法**，而且这条回退有用例守着。
 *
 * `contextBuilder: false` 是「记忆层有没有改变回复行为」的对照开关（见上一条用例），
 * 它必须与 P0 一样只有那两行世界状态：不出现「在场」，也不出现第二份时间。
 */
test('上下文层关掉时，世界状态退回轻量写法（不是整段消失、也不是两份叠在一起）', () => {
  const h = harness();
  try {
    h.store.recordPresenceChanged({ present: true, confidence: 0.9, ttlSeconds: 3_600 });
    const bare = new ConversationEngine({
      adapter: new FakeBrainAdapter(),
      store: h.store,
      config: CONFIG,
      clock: fixedClock(NOW, 1_000),
      offsetMinutes: 480,
      contextBuilder: false,
    });
    const prompt = bare.buildPrompt({ sessionId: h.sessionId, text: '在吗', at: NOW });
    assert.equal(prompt.user.includes('在场'), false, '关掉上下文层就没有在场判断（它属于上下文层那一份）');

    const lite = worldStateLite(NOW, 'Asia/Shanghai', 480);
    const worldSection = prompt.sections.find((section) => section.name === 'world-state');
    assert.ok(worldSection !== undefined, '这一段在两条路径下都存在，只是内容来源不同');
    assert.equal(
      worldSection.text.split('\n').slice(0, 2).join('\n'),
      `现在：${lite.now}（${lite.timezone}）\n时段：${lite.timeOfDay}　星期：${lite.weekday}`,
      `退回的必须是轻量写法那两行、逐字不变：\n${worldSection.text}`,
    );
    assert.equal(prompt.user.split('现在：').length - 1, 1, '只有一处「现在」');
    assert.equal(prompt.user.split('时段：').length - 1, 1, '只有一处「时段」');
  } finally {
    h.store.close();
  }
});

/**
 * V0.3 P2.5-J 修的第二个缺口（**真实装配点**）：关系笔记没有听众过滤。
 *
 * `#relationship(at, audience)` 收了 `audience` 却完全没用它（逐行核对过），笔记被压成纯字符串
 * 直接进了模型可见的散文；有外人可能时也一样。现在过滤发生在**选择阶段**：`buildRelationshipContext`
 * 在有外人可能时拿到的是空笔记数组，所以它不是「注入了再让模型自己别说」。
 *
 * 这条用例按「模型可见文本」的每一段逐个断言（system / user / history / 每个 section），
 * 而不是只看 `user`：只要有一处漏出去，隐私边界就没有成立。
 */
test('有外人在场时关系笔记不进模型可见文本的任何一段；默认口径照旧看得见', () => {
  const h = harness();
  try {
    const note = '他嫌话多：少说、少主动、少追问';
    h.memory.recordNote({ aspect: 'chat_style', note, sourceType: 'explicit_correction' });

    // ① 默认口径（没人说「谁在听」= family）照旧看得见 —— 否则这条用例可能只是因为「笔记从不出现」而绿。
    const family = h.engine.buildPrompt({ sessionId: h.sessionId, text: '那绿茶呢', at: NOW });
    assert.ok(family.user.includes(note), `默认口径下关系笔记在提示词里：\n${family.user}`);

    const publicEngine = new ConversationEngine({
      adapter: new FakeBrainAdapter(),
      store: h.store,
      config: CONFIG,
      clock: fixedClock(NOW, 1_000),
      offsetMinutes: 480,
      audience: { mode: 'public', actor: 'unknown_person', note: '有外人在' },
    });

    // ② 有外人可能：模型可见的每一段都不许有那条笔记。
    const withPublic = publicEngine.buildPrompt({ sessionId: h.sessionId, text: '那绿茶呢', at: NOW });
    const modelVisible = [
      withPublic.system,
      withPublic.user,
      ...withPublic.history.map((turn) => turn.content),
      ...withPublic.sections.map((section) => section.text),
    ];
    for (const text of modelVisible) {
      assert.equal(text.includes(note), false, `public 下关系笔记不许出现在模型可见的文本里：\n${text}`);
    }
    // 关系摘要那一段还在（是过滤掉一条，不是整段消失）：否则上面那句可能只是「段不存在」的假绿。
    const relationship = withPublic.sections.find((section) => section.name === 'relationship');
    assert.ok(relationship !== undefined, '关系摘要这一段仍然在');
    assert.ok(relationship.text.includes('最近7天'), `与听众无关的那几句照旧：\n${relationship.text}`);

    // ③ 结构化视图（面板读它）也一起是空的：面板看到的 = 模型看到的。
    const context = publicEngine.buildUserTurnContext({ sessionId: h.sessionId, text: '那绿茶呢', at: NOW });
    assert.ok(context !== null);
    assert.deepEqual(context.relationship.notes, []);
    assert.equal(context.relationship.prose.some((line) => line.includes(note)), false);

    // ④ 读空气（主动决策）那条路用的是同一个渲染出口，所以一样过滤 —— 两处不许漂。
    const decision = publicEngine.buildProactiveDecisionContext({ fact: '他嫌话多', at: NOW });
    assert.ok(decision !== null, '有上下文层时决策摘要照旧给');
    assert.equal(decision.relationship.some((line) => line.includes(note)), false, `决策摘要里也不许有：${JSON.stringify(decision.relationship)}`);
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
