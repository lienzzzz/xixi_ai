/**
 * `@xixi/context` 的检索器（V0.3 P1 / pack `docs/02_MEMORY_CONTEXT.md` §2 §3）。
 *
 * 这一层要证明的是**算术与边界**，不是「大概能想起来」：
 *   * 混合排序的每一项都是可复算的（词面/近因/重要度/置信/主语/未完话题 − 陈旧 − 已提及）；
 *   * 每轮注入 3~8 条：上限硬夹在 [3,8]、下限凑不满就少给（绝不拿不相关的凑数）；
 *   * `confidence` 与 audience 是**先决条件**，不是扣分：被挡掉的候选连分数都不算；
 *   * 每条都带 provenance 与 retrievalReason，且 `id` 与文本里的 UUID / 长数字不会流向提示词。
 *
 * Run: `npm test`（tests/unit 在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  lexicalRelevance,
  MemoryRetriever,
  MEMORY_SCORE_WEIGHTS,
  openThreadScore,
  POLARITY_CONFLICT_PENALTY,
  polarityConflict,
  recencyScore,
  renderGate,
  renderMemoryLines,
  stalePenalty,
  usefulText,
  visibleTo,
  type AudienceContext,
  type RetrievedMemory,
} from '@xixi/context';
import { fixedClock, MemoryStore, OpenThreadStore, openXixiStore, type XixiStore } from '@xixi/domain';

const NOW = new Date('2026-10-01T20:00:00+08:00');
const PRIVATE: AudienceContext = { mode: 'private', actor: 'father', note: '只有父亲' };
const FAMILY: AudienceContext = { mode: 'family', actor: null, note: '家里人在场' };
const PUBLIC: AudienceContext = { mode: 'public', actor: 'unknown_person', note: '有外人' };

function freshStore(): XixiStore {
  // 内存库：这一层测的是排序算术，不需要落盘（也避免同一临时目录上的并发写互相等锁）。
  return openXixiStore({ dbPath: ':memory:', clock: fixedClock(NOW, 1_000) });
}

/** 一条「他明确说过的偏好」（显式纠正 = 置信 1、可见范围 family）。 */
function seedSemantic(memory: MemoryStore, statement: string, property = 'preference'): void {
  memory.recordSemantic({
    property,
    statement,
    sourceType: 'explicit_correction',
    // `events` 的注释说记忆可以按来源重建：来源 id 用事件 id 的形状（`evt_` + UUID），
    // 否则库里会混进一条永远指不回去的「来源」（schema 的 pattern 就是为此存在的）。
    sourceEventId: `evt_00000000-0000-4000-8000-${String(statement.length).padStart(12, '0')}`,
  });
}

test('词面相关是确定性的，而且看得懂否定带来的方向相反', () => {
  assert.equal(lexicalRelevance('我喜欢绿茶', '我喜欢绿茶'), 1);
  const relevant = lexicalRelevance('那绿茶呢', '父亲不喜欢绿茶');
  const unrelated = lexicalRelevance('那绿茶呢', '弟弟周六可能回来');
  assert.ok(relevant > unrelated, `相关的必须比不相关的高：${relevant} vs ${unrelated}`);
  assert.equal(unrelated < 0.2, true, '不相关的候选不该拿到高分');

  // 极性冲突：字面很像、结论相反（`不喜欢绿茶` vs `喜欢绿茶`）。
  assert.equal(polarityConflict('不喜欢绿茶', '喜欢绿茶'), true);
  assert.equal(polarityConflict('我喜欢绿茶', '父亲喜欢绿茶'), false, '同一方向不算冲突');
  assert.equal(polarityConflict('今天天气不错', '父亲不喜欢绿茶'), false, '两件不相干的事不算冲突');
  // 检索器把这笔扣分算进总分，于是「被否定过的那条」真的会往后排 —— 这条在检索层面由
  // 「已提及惩罚」那条用例压着（见下），这里只钉住算术本身。
  const negated = lexicalRelevance('我不喝那个', '父亲不喜欢绿茶') - POLARITY_CONFLICT_PENALTY;
  const plain = lexicalRelevance('我不喝那个', '他爱喝绿茶');
  assert.ok(negated < plain, `被否定过的候选总分必须更低：${negated} vs ${plain}`);

  // 近因与陈旧：半衰期 30 天；过了 30 天才开始扣，且最多扣到上限。
  assert.equal(recencyScore(0), 1);
  assert.equal(recencyScore(30), 0.5);
  assert.equal(stalePenalty(10), 0);
  assert.ok(stalePenalty(40) > 0 && stalePenalty(1000) <= 0.6);

  // 与未完话题的关系：双向的词面重合取最大值。
  assert.ok(openThreadScore(['明天下午我要去镇上办证'], ['去镇上办证']) > 0.2);
  assert.equal(openThreadScore([], ['去镇上办证']), 0);
});

test('不相关的记忆不会被注入：下限凑不满就少给，绝不拿不相关的凑数', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    // 三条与「天气」毫无关系的记忆，置信都够。
    seedSemantic(memory, '弟弟周六可能回来', 'person');
    seedSemantic(memory, '他每天早上六点起床', 'routine');
    seedSemantic(memory, '家里的电视遥控器在茶几上', 'place');

    const result = new MemoryRetriever(store).retrieve({
      query: '今天天气怎么样？',
      now: NOW,
      audience: PRIVATE,
      recentTurns: [],
    });
    assert.equal(result.memories.length, 0, '没有一条与这一轮有理由相关，就该一条都不给');
    assert.equal(result.diagnostics.eligible, 3, '候选是够的 —— 挡住它们的是相关性，不是数量');
    assert.equal(result.diagnostics.dropped.filter((entry) => entry.reason === 'not_relevant').length, 3);
  } finally {
    store.close();
  }
});

test('注入条数被硬夹在 3~8：上限越界会被夹回来，下限凑不满就少给', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    for (let index = 0; index < 12; index += 1) {
      seedSemantic(memory, `他喜欢喝第${index}种茶`);
    }
    const query = '我喜欢哪种茶';

    const many = new MemoryRetriever(store).retrieve({ query, now: NOW, audience: PRIVATE, maxItems: 99, recentTurns: [] });
    assert.equal(many.memories.length, 8, 'pack §2 的上限就是 8 条，配置再大也不许突破');

    const few = new MemoryRetriever(store).retrieve({ query, now: NOW, audience: PRIVATE, maxItems: 4, recentTurns: [] });
    assert.equal(few.memories.length, 4);

    const floor = new MemoryRetriever(store).retrieve({ query, now: NOW, audience: PRIVATE, minItems: 6, maxItems: 3, recentTurns: [] });
    assert.equal(floor.memories.length, 3, 'minItems 不许超过 maxItems（否则「下限」会把上限顶穿）');
    assert.equal(floor.diagnostics.maxItems, 3);

    // 一条都不相关时，`minItems: 3` 也不许把不相关的塞进来。
    const unrelated = new MemoryRetriever(store).retrieve({ query: '外面下雨了吗', now: NOW, audience: PRIVATE, minItems: 3, recentTurns: [] });
    assert.equal(unrelated.memories.length, 0);
    assert.equal(unrelated.diagnostics.minItems, 3, '下限是「尽量」，不是「必须凑够」');
  } finally {
    store.close();
  }
});

test('置信度与 audience 是先决条件：被挡掉的候选不进排序，也不会在候选不够时被放回来', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    seedSemantic(memory, '茶叶罐在厨房上面那个柜子里', 'place');
    // 来源是**显式纠正**（所以 family 可见、能走到置信门槛这一关），但置信度只有 0.4 ——
    // 「他明确说过但不确定」是一种真实存在的情况（例如他记不清了）。
    memory.recordSemantic({
      property: 'place',
      statement: '茶叶罐好像放在茶几上了',
      sourceType: 'explicit_correction',
      confidence: 0.4,
      sourceEventId: null,
    });

    const retriever = new MemoryRetriever(store);
    const query = '茶叶罐放哪儿了';
    const family = retriever.retrieve({ query, now: NOW, audience: FAMILY, minItems: 3, recentTurns: [] });
    assert.deepEqual(
      family.memories.map((entry) => entry.provenance.confidence),
      [1],
      '置信度 0.4 的记忆不许进提示词，哪怕它词面更相关',
    );
    assert.equal(family.diagnostics.dropped.filter((entry) => entry.reason === 'low_confidence').length, 1);
    assert.match(family.memories[0]?.text ?? '', /厨房/, '被放进来的是那条他明确说过的');

    const loose = retriever.retrieve({ query, now: NOW, audience: FAMILY, minConfidence: 0.3, minItems: 3, recentTurns: [] });
    assert.deepEqual(
      loose.memories.map((entry) => entry.provenance.confidence),
      [1, 0.4],
      '把门槛调到 0.3 之后它就进来了 —— 挡住它的是那条门槛，不是别的',
    );

    // audience filter 先于检索：`private` 的记忆在有别人在场时连分数都不算。
    const privateStore = freshStore();
    try {
      const privateMemory = new MemoryStore(privateStore);
      privateMemory.recordSemantic({ property: 'place', statement: '茶叶罐就在厨房柜子里', sourceType: 'model_inference', confidence: 0.9 });
      const result = new MemoryRetriever(privateStore).retrieve({ query: '茶叶罐放哪儿了', now: NOW, audience: FAMILY, recentTurns: [] });
      assert.equal(result.memories.length, 0, 'private 的记忆不外泄到「可能有别人在」的场合');
      assert.equal(result.diagnostics.dropped.some((entry) => entry.reason === 'not_visible'), true);
      const alone = new MemoryRetriever(privateStore).retrieve({ query: '茶叶罐放哪儿了', now: NOW, audience: PRIVATE, recentTurns: [] });
      assert.equal(alone.memories.length, 1, '只有父亲一个人时它就可以用了');
    } finally {
      privateStore.close();
    }
  } finally {
    store.close();
  }
});

test('已提及惩罚真的会改变名次：上一轮刚说过的那条会往后排', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    // 两条等长、同来源、同置信的记忆，只有内容不同 —— 这样名次变化只能来自「已提及惩罚」。
    // 其中「我买的」会在这一轮被**原样说出来**（逐字重合 = 已提及惩罚的判据）。
    seedSemantic(memory, '那罐茶叶是他喜欢的');
    seedSemantic(memory, '那罐茶叶是我买的');
    const retriever = new MemoryRetriever(store);
    const query = '家里那罐茶叶放哪儿了';

    const cold = retriever.retrieve({ query, now: NOW, audience: FAMILY, recentTurns: [] });
    const warm = retriever.retrieve({
      query,
      now: NOW,
      audience: FAMILY,
      recentTurns: [{ role: 'user', text: '那罐茶叶是我买的' }],
    });

    const tej = (result: { readonly memories: readonly RetrievedMemory[] }, needle: string): number =>
      result.memories.findIndex((entry) => entry.text.includes(needle));
    assert.equal(cold.memories.length, 2, '没说过的时候两条都在');
    assert.equal(warm.memories.length, 2, '惩罚不是删除：它还在，只是往后排');
    assert.equal(tej(cold, '我买的') >= 0 && tej(cold, '他喜欢的') >= 0, true);
    // 两条记忆的**内容型得分完全一样**（等长、同来源、同置信、同样的词面相关），所以这里
    // 断言的不是「谁排第一」（那由并列时的 id 升序决定，随机 id ⇒ 不该写死方向），
    // 而是**那条惩罚确实落到了被提到的那一条身上**，且只有它拿到了那句理由。
    assert.match(
      warm.memories.find((entry) => entry.text.includes('我买的'))?.retrievalReason ?? '',
      /刚才已经提到过/,
      '被判「刚说过」的那条必须自己说出来',
    );
    assert.doesNotMatch(
      warm.memories.find((entry) => entry.text.includes('他喜欢的'))?.retrievalReason ?? '',
      /刚才已经提到过/,
      '没被原样说过的另一条不该背这个锅（判据是逐字重合，不是模糊相似）',
    );
    // 冷启动那一次两条都没有这一句 —— 惩罚不是「永远都在」的噪声。
    assert.equal(cold.memories.some((entry) => /刚才已经提到过/.test(entry.retrievalReason)), false);
  } finally {
    store.close();
  }
});

/**
 * 已提及惩罚的**可复算**版本（t12）：一份内容型得分明确分先后的两两对照。
 *
 * 为什么要单独一条：上面那条用例里两条记忆与查询的相关性几乎一样，名次只能靠并列规则
 * （随机 id）分先后，于是「翻转」这句话本身带噪声。这里把得分拉开：
 *   * 「放在茶几上了」与这一轮的问法更近（0.538 > 0.433）→ 冷启动时它排第一；
 *   * 但这一轮刚刚**原样说过**它 → 逐字重合 = 1 → 惩罚拉满 → 它掉到第二；
 *   * 差值是 0.5 × 0.345 ≈ 0.17 分这一量级，远大于任何并列噪声。
 */
test('已提及惩罚可复算：得分更高的那条会因为「刚被原样说过」而掉到后面', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    seedSemantic(memory, '那罐茶叶在厨房上面那个柜子里');
    seedSemantic(memory, '那罐茶叶放在茶几上了');
    const retriever = new MemoryRetriever(store);

    const cold = retriever.retrieve({ query: '家里那罐茶叶放哪儿了', now: NOW, audience: FAMILY, recentTurns: [] });
    const warm = retriever.retrieve({
      query: '家里那罐茶叶放哪儿了',
      now: NOW,
      audience: FAMILY,
      recentTurns: [{ role: 'user', text: '那罐茶叶放在茶几上了' }],
    });
    const tej = (result: { readonly memories: readonly RetrievedMemory[] }, needle: string): number =>
      result.memories.findIndex((entry) => entry.text.includes(needle));

    assert.equal(cold.memories.length, 2);
    assert.equal(tej(cold, '茶几'), 0, '没说过的时候，与问法更近的那条排第一');
    assert.equal(tej(warm, '茶几'), 1, '刚被原样说过之后，它退到后面（惩罚的可观察结果）');
    assert.equal(tej(warm, '厨房'), 0);
    // 依据要写在理由里 —— 面板与测试不必去反推它是被哪一项推下去的。
    assert.match(warm.memories[1]?.retrievalReason ?? '', /刚才已经提到过/);
    assert.doesNotMatch(warm.memories[0]?.retrievalReason ?? '', /刚才已经提到过/);
  } finally {
    store.close();
  }
});

test('每条都带 provenance 与 retrievalReason，而提示词里不出现 id 与长数字', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    seedSemantic(memory, '父亲不喜欢绿茶');
    const result = new MemoryRetriever(store).retrieve({ query: '那绿茶呢', now: NOW, audience: FAMILY, recentTurns: [] });
    const entry = result.memories[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.kind, 'semantic');
    assert.equal(entry.provenance.sourceType, 'explicit_correction');
    assert.equal(entry.provenance.confidence, 1);
    assert.equal(typeof entry.provenance.updatedAt, 'string');
    assert.equal(entry.visibility, 'family');
    assert.ok(entry.retrievalReason.length > 0, '每条都要能说清「为什么这轮想起它」');
    assert.match(entry.retrievalReason, /说过的|重要|同一件事|主语|没办完|最近|遗忘/, entry.retrievalReason);

    // 渲染出来的行里没有 id、没有 UUID、没有长数字。
    const rendered = renderMemoryLines(result.memories, NOW);
    assert.equal(rendered.dropped.length, 0);
    for (const line of rendered.lines) {
      assert.equal(line.includes(entry.id), false, 'id 不许出现在提示词行里');
      assert.doesNotMatch(line, /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-/u, 'UUID 不许出现');
      assert.doesNotMatch(line, /\d{8,}/u, '长数字不许出现');
    }
  } finally {
    store.close();
  }
});

test('文本本身就带 id 或长数字的记忆会被整条丢掉，而不是被洗一遍', () => {
  assert.equal(usefulText('父亲不喜欢绿茶'), true);
  assert.equal(usefulText(''), false);
  assert.equal(usefulText('轮次 3f2b7c9a-1111-4222-8333-444455556666 里说的话'), false);
  assert.equal(usefulText('他的工号是 12345678'), false);

  const tainted: RetrievedMemory = {
    id: 'mem_x',
    kind: 'semantic',
    text: '轮次 3f2b7c9a-1111-4222-8333-444455556666 里说的话',
    provenance: { sourceEventId: null, sourceType: 'explicit_correction', confidence: 1, occurredAt: null, updatedAt: NOW.toISOString() },
    visibility: 'family',
    retrievalReason: '和这一轮说的是同一件事',
  };
  const rendered = renderMemoryLines([tainted], NOW);
  assert.equal(rendered.lines.length, 0, '出口闸门是独立的第二道：上游不干净也进不了提示词');
  assert.equal(rendered.dropped[0]?.reason, 'unusable_text');
  assert.equal(renderGate('父亲不喜欢绿茶'), true);
  assert.equal(renderGate('valence=0.310'), false, '程序里的参数名不许进提示词');
});

test('排序权重是公开的常量，面板与测试可以逐项核对', () => {
  assert.deepEqual(Object.keys(MEMORY_SCORE_WEIGHTS).sort(), [
    'alreadyMentioned',
    'confidence',
    'importance',
    'lexical',
    'openThread',
    'recency',
    'stale',
    'subject',
  ]);
  assert.ok(MEMORY_SCORE_WEIGHTS.lexical > MEMORY_SCORE_WEIGHTS.alreadyMentioned, '词面相关的权重必须大于已提及惩罚，否则记忆永远排不到前面');
  assert.deepEqual([visibleTo('private', FAMILY), visibleTo('family', FAMILY), visibleTo('public', PUBLIC)], [false, true, true]);
});

test('未完话题相关的记忆会被提上来（`+ open-thread relationship`）', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    seedSemantic(memory, '他要去镇上办证', 'plan');
    seedSemantic(memory, '他每天六点起床', 'routine');
    const threads = new OpenThreadStore(store);
    threads.create({ threadId: 'thread_test0001', summary: '明天下午我要去镇上办证', subject: '去镇上办证' });

    const result = new MemoryRetriever(store).retrieve({
      query: '嗯',
      now: NOW,
      audience: FAMILY,
      recentTurns: [],
      openThreads: threads.list({ status: ['candidate', 'offered'] }),
    });
    assert.equal(result.memories[0]?.text, '他要去镇上办证', '与没办完的事相关的那条应该排在前面');
    assert.match(result.memories[0]?.retrievalReason ?? '', /没办完/);
  } finally {
    store.close();
  }
});
