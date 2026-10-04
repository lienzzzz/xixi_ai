/**
 * pack §8 的 Tier 2（结构化模型抽取）政策层。
 *
 * 这一层要证明的是**闸门**，而不是「模型能抽记忆」：
 *   1. 不值得记的回合**连模型都不叫**（`worthRemembering`）；
 *   2. 模型输出**不被信任**：形状/类别/长度/置信任何一条不过就整条丢，并记下原因；
 *   3. **人格属性在类别白名单之外** —— 这是「模型抽取永远不能直接改 SelfModel 高权重属性」的第一道闸门
 *      （第二道：`runTier2` 的写入路径只有 `recordSemantic`，没有任何写 SelfModel 的调用）；
 *   4. 一条 Tier 2 记忆的置信**不超过来源本身的上限**（`model_inference` = 0.4，铁律 4）。
 *
 * Run: `npm test`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  tier2StoredConfidence,
  TIER2_MAX_CANDIDATES,
  TIER2_MIN_CONFIDENCE,
  validateTier2Candidates,
  worthRemembering,
} from '@xixi/context';
import { TurnMemoryExtractor } from '@xixi/conversation';
import { fixedClock, MemoryStore, openXixiStore, SelfModel, type XixiStore } from '@xixi/domain';

const NOW = new Date('2026-10-01T20:00:00+08:00');

function freshStore(): XixiStore {
  return openXixiStore({ dbPath: ':memory:', clock: fixedClock(NOW, 1_000) });
}

test('值得记的门槛：太短、问句、与人和家无关的话都不叫模型', () => {
  assert.equal(worthRemembering('我很喜欢喝茉莉花茶'), true);
  assert.equal(worthRemembering('他每天六点起床'), true);
  assert.equal(worthRemembering('我对花生过敏'), true);
  assert.equal(worthRemembering('今天天气怎么样？'), false, '问句不是陈述');
  assert.equal(worthRemembering('嗯。'), false, '太短');
  assert.equal(worthRemembering('这个 bug 我等下再看'), false, '与人和家无关');
});

test('校验模型输出：形状、类别、长度、置信，任何一条不过就整条丢并说清原因', () => {
  const good = validateTier2Candidates([
    { property: 'preference', statement: '他喜欢听戏', confidence: 0.9 },
    { property: 'routine', statement: '他每天六点起床', confidence: TIER2_MIN_CONFIDENCE },
  ]);
  assert.equal(good.accepted.length, 2);
  assert.equal(good.rejected.length, 0);

  const mixed = validateTier2Candidates({
    memories: [
      // 人格属性：不在类别白名单里 —— 这道门就是「模型不能直接改高权重属性」。
      { property: 'verbosity', statement: '少说两句', confidence: 0.99 },
      { property: 'preference', statement: '他喜欢听戏', confidence: 0.95 },
      { property: 'preference', statement: '他喜欢听戏', confidence: 0.5 },
      { property: 'place', statement: '？', confidence: 0.9 },
      '不是对象',
    ],
  });
  assert.deepEqual(mixed.accepted.map((entry) => entry.statement), ['他喜欢听戏']);
  assert.deepEqual(
    mixed.rejected.map((entry) => entry.reason).sort(),
    ['bad_statement', 'low_confidence', 'not_an_object', 'unknown_property'],
  );
  assert.match(mixed.rejected.find((entry) => entry.reason === 'unknown_property')?.detail ?? '', /verbosity/);

  // 完全不是数组/对象 → 一条都不接受，而且说得出来。
  const garbage = validateTier2Candidates('模型今天心情不错');
  assert.equal(garbage.accepted.length, 0);
  assert.equal(garbage.rejected[0]?.reason, 'not_an_object');

  // 数量上限：多出来的记 `too_many`（不是静默丢掉）。
  const many = validateTier2Candidates(
    Array.from({ length: TIER2_MAX_CANDIDATES + 2 }, (_, index) => ({
      property: 'preference',
      statement: `他喜欢第${index}样东西`,
      confidence: 0.9,
    })),
  );
  assert.equal(many.accepted.length, TIER2_MAX_CANDIDATES);
  assert.equal(many.rejected.filter((entry) => entry.reason === 'too_many').length, 2);
});

test('Tier 2 落库的置信不超过来源上限（模型推断 = 0.4，铁律 4）', () => {
  assert.equal(tier2StoredConfidence(1), 0.4);
  assert.equal(tier2StoredConfidence(0.8), 0.32);
  assert.equal(tier2StoredConfidence(0), 0);
});

test('runTier2：写下校验通过的语义记忆，人格属性被拒，而且 SelfModel 一位没动', async () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    const selfModel = new SelfModel(store);
    const before = store.selfProfile();
    const extractor = new TurnMemoryExtractor({
      store,
      selfModel,
      memory,
      scheduler: () => {},
      structuredExtractor: async () => [
        { property: 'preference', statement: '他喜欢听戏', confidence: 0.9 },
        // 模型试图改人格：类别外，必须被拒（第二道闸门是「这个文件没有写 SelfModel 的路径」）。
        { property: 'verbosity', statement: '以后少说两句', confidence: 1 },
      ],
    });

    const result = await extractor.runTier2({
      sessionId: 'sess_tier2',
      userText: '我很喜欢听戏，你以后少说两句。',
      replyText: '好，我记着了。',
      at: NOW,
      userEventId: 'evt_00000000-0000-4000-8000-0000000000cc',
      inferredCode: null,
    });

    assert.equal(result.attempted, true);
    assert.equal(result.written.length, 1);
    assert.equal(result.written[0]?.statement, '他喜欢听戏');
    assert.equal(result.written[0]?.sourceType, 'model_inference');
    assert.equal(result.written[0]?.confidence, 0.36, '0.9 × 0.4：来源权重只施加一次');
    assert.equal(result.validation?.rejected.length ?? 0, 1);
    assert.equal(result.validation?.rejected[0]?.reason, 'unknown_property');

    assert.deepEqual(store.selfProfile(), before, '模型抽取不许改有效人格');
    assert.equal(store.learnedDeltas().length, 0, '也不许写学习层');
    assert.equal(selfModel.overrides(NOW).length, 0, '更不许写当天覆盖');
  } finally {
    store.close();
  }
});

test('没有接线 / 不值得记时：Tier 2 一步都不走（也说得出来是为什么）', async () => {
  const store = freshStore();
  try {
    const notWired = new TurnMemoryExtractor({ store, scheduler: () => {} });
    const skipped = await notWired.runTier2({
      sessionId: 's',
      userText: '我很喜欢听戏。',
      replyText: null,
      at: NOW,
      userEventId: null,
      inferredCode: null,
    });
    assert.equal(skipped.attempted, false);
    assert.match(skipped.failure ?? '', /没有接线/);

    let called = 0;
    const wired = new TurnMemoryExtractor({
      store,
      scheduler: () => {},
      structuredExtractor: async () => {
        called += 1;
        return [];
      },
    });
    const short = await wired.runTier2({ sessionId: 's', userText: '嗯。', replyText: null, at: NOW, userEventId: null, inferredCode: null });
    assert.equal(short.attempted, false);
    assert.equal(called, 0, '不值得记的回合连模型都不叫');
    assert.match(short.failure ?? '', /不值得记/);
  } finally {
    store.close();
  }
});
