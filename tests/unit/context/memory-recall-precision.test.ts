/**
 * V0.3 t22 的**召回精度**表：旗舰句召回得起来，而「不该召回的句子仍然不被召回」。
 *
 * 背景（t15 独立复验）：`给我推荐个茶。` 与 `我平时喜欢茉莉花茶` 在词面上几乎不重合
 * （共同的字只有 `我` 与 `茶`，而且不构成共同双字词），于是那条最该被想起来的茶偏好进不了提示词，
 * 用户看到的是引擎的兜底句。修法是给检索器加一条**话题点名**路径：查询的每个**内容字**
 * 都要在记忆里**成词出现**（`茶` 在 `茉莉花茶` 里是词的一部分；在 `茶几上` 里是孤字，不算）。
 *
 * 这一层要证明的就是两件事，缺一不可：
 *   1. 该召回的（茶 → 茉莉花茶）真的召回了；
 *   2. 不该召回的一条都没多出来 —— 这是本项目对「能不能多召回」的既有判据：
 *      **先看误召回有没有上升**（表里 false 的那些行就是它的口径与结果）。
 *
 * **单内容字查询的召回预算（V0.3 P2-G 记为已知边界，本轮不收紧）**：上面那条路径对**短查询**
 * 就是一次话题点名，于是**同一话题下的多条记忆会一起被带进来**。P2-G 实测（6 条种子记忆
 * `我平时喜欢茉莉花茶` / `茶叶罐放在橱柜里` / `茶壶该洗了` / `茶话会改到周六了` / `茶几上有个遥控器` /
 * `龙井是去年的茶`，`retrieve` 不带 `maxItems`）：
 *
 *   * 问 `给我推荐个茶。`（查询唯一的内容字是 `茶`）→ `injected=4`：`我平时喜欢茉莉花茶`、
 *     `茶叶罐放在橱柜里`、`茶壶该洗了`、`茶话会改到周六了`；另外 2 条被 `not_relevant` 拦下
 *     （都在第三条起要求的 `MEMORY_STRONG_SCORE_FLOOR` 0.9 之下，**不是**被 `over_budget` 挤掉的）；
 *   * 问 `茶呢？`（更短）→ `injected=6`，**正好是预算上限**（出厂 `maxItems` 6，硬夹进 [3, 8]）：
 *     同一个库、同一条召回路径，只因为查询短到只剩一个内容字，同话题候选就一起进来了；
 *   * `茶几上有个遥控器`（`茶` 的右边是功能字 `几`、`上`，**孤字**）在最长的那条查询下进不来、
 *     在最短的那条查询下进来了；两条查询的召回集都不含跨话题的记忆。
 *
 * 为什么本轮**不收紧**（captain 裁定）：收紧（给单内容字查询更严的成词门槛、或按话题聚类后分配预算）
 * 会**先削掉旗舰场景本身** —— `茶` 这个内容字正是 `给我推荐个茶。` 唯一能召回 `我平时喜欢茉莉花茶` 的证据。
 * 跨话题方向**没有**上升（探针里 `茶几上有个遥控器` 只在最短查询时进来一次，`咖啡`/象棋/普洱 类记忆
 * 一条都没进来），所以现在的口径是「**同话题内**多带几条」而不是「闸门变漏斗」。下一轮若要收紧，
 * 可能的做法是按话题聚类后按预算分配，或给单内容字查询一个更高的成词门槛
 * （这两条也写在 ADR-0014 与 docs/progress-v03.md 的已知边界里，供下一轮判断）。
 *
 * **还有一个容易被误读的细节**（P2-G 实测）：`MemoryStore.recordSemantic` 的输入**没有** `updatedAt`
 * 这一项，落库时间由 store 的时钟给（`insertSemanticMemory` 一律用 `#now()`），所以想靠「造几条
 * 不同新旧的行」来固定顺序是无效的；行与行的分数相等时，顺序由 `candidate.id` 兜底，而出厂 id 是
 * `sem_${randomUUID()}` —— 等分时顺序**会抖**。要钉条数与内容就得显式给 `memoryId`（用例里就是这么做的）。
 *
 * Run: `npm test`（tests/unit 在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryRetriever, type AudienceContext } from '@xixi/context';
import { fixedClock, MemoryStore, openXixiStore, type XixiStore } from '@xixi/domain';

const NOW = new Date('2026-10-06T20:00:00+08:00');
/** private：让 audience filter 永不下场，这一层只测相关性。 */
const ALONE: AudienceContext = { mode: 'private', actor: 'father', note: '用例：只有父亲' };

interface Case {
  readonly query: string;
  readonly memory: string;
  readonly recall: boolean;
  readonly why: string;
}

/**
 * 逐条列出「该召回 / 不该召回」，每一条都写明它压的是什么。
 *
 * 不写「大概相关」这种话：`recall: false` 的行就是**误召回反例**，它们全绿才说明
 * 这条新路径没有把闸门变成漏斗。
 */
const CASES: readonly Case[] = [
  // ---------------------------------------------------------------- 该召回（t22 的目标）
  { query: '给我推荐个茶。', memory: '我平时喜欢茉莉花茶', recall: true, why: '旗舰场景：话题点名（茶 → 茉莉花茶）' },
  { query: '茶呢？', memory: '我平时喜欢茉莉花茶', recall: true, why: '短话题点名（唯一的内容字是茶）' },
  { query: '有什么茶推荐的吗', memory: '我平时喜欢茉莉花茶', recall: true, why: '同一个话题的另一种问法' },
  { query: '茉莉花茶还有吗？', memory: '我平时喜欢茉莉花茶', recall: true, why: '词面相关那条老路径（没被改动）' },
  { query: '他提过那个说法吗', memory: '他提过这个说法', recall: true, why: '共同双字词（老路径）' },

  // -------------------------------------------- 不该召回（误召回反例；这些行是这条用例的重点）
  { query: '给我推荐个茶。', memory: '遥控器在茶几上', recall: false, why: '`茶几` 里的茶是孤字：不是「茶」这件事' },
  { query: '给我推荐个茶。', memory: '他每天早上六点起床', recall: false, why: '同一句话对上一条毫不相干的记忆' },
  { query: '今天天气怎么样？', memory: '他每天早上六点起床', recall: false, why: '内容字只重合一个「天」，没有全部对上' },
  { query: '今天天气怎么样？', memory: '我平时喜欢茉莉花茶', recall: false, why: '天气与茶无关' },
  { query: '明天要不要带伞？', memory: '我平时喜欢茉莉花茶', recall: false, why: '带伞与茶无关' },
  { query: '明天要不要带伞？', memory: '弟弟周六可能回来', recall: false, why: '两个话题毫无交集' },
  { query: '外面下雨了吗', memory: '弟弟周六可能回来', recall: false, why: '既有反例（t12 起就在）' },
  { query: '药吃了吗？', memory: '我平时喜欢茉莉花茶', recall: false, why: '药与茶是两种东西' },
  { query: '他喜欢喝什么茶', memory: '遥控器在茶几上', recall: false, why: '茶几不是茶' },
  {
    query: '给我推荐个茶，顺便说说天气。',
    memory: '我平时喜欢茉莉花茶',
    recall: false,
    why: '**边界如实记录**：内容字要**全部**对上，这句里「天气」对不上，所以不召回（保守方向）',
  },
];

function freshStore(): XixiStore {
  return openXixiStore({ dbPath: ':memory:', clock: fixedClock(NOW, 1_000) });
}

function seedOne(store: XixiStore, statement: string): MemoryStore {
  const memory = new MemoryStore(store);
  memory.recordSemantic({
    property: 'preference',
    statement,
    sourceType: 'explicit_correction',
    sourceEventId: 'evt_00000000-0000-4000-8000-0000000000e2',
  });
  return memory;
}

test('召回精度表：旗舰句召回得起来，不该召回的 10 条一条都没多出来', () => {
  const recalled: string[] = [];
  const missed: string[] = [];
  const overRecalled: string[] = [];
  for (const entry of CASES) {
    const store = freshStore();
    try {
      seedOne(store, entry.memory);
      const result = new MemoryRetriever(store).retrieve({
        query: entry.query,
        now: NOW,
        audience: ALONE,
        recentTurns: [],
      });
      const hit = result.memories.length > 0;
      const label = `[${entry.recall ? '应召回' : '不应召回'}] ${entry.query} ↔ ${entry.memory}`;
      if (entry.recall && hit) recalled.push(label);
      if (entry.recall && !hit) missed.push(`${label}（实测没召回；reason=${entry.why}）`);
      if (!entry.recall && hit) overRecalled.push(`${label}（实测召回了：${result.memories.map((row) => row.text).join('、')}）`);
      if (!entry.recall && hit === false) {
        // 被丢的理由要说得清：是**相关性**这条闸门拦的，不是别的（例如可见范围或置信）。
        assert.equal(
          result.diagnostics.dropped.some((row) => row.reason === 'not_relevant'),
          true,
          `不该召回的必须是被相关性拦下的：${label} → ${JSON.stringify(result.diagnostics.dropped)}`,
        );
      }
    } finally {
      store.close();
    }
  }
  assert.deepEqual(missed, [], `该召回却没召回：\n${missed.join('\n')}`);
  assert.deepEqual(overRecalled, [], `**误召回**（这条最重要，说明新路径没有把闸门变漏斗）：\n${overRecalled.join('\n')}`);
  assert.equal(recalled.length, CASES.filter((entry) => entry.recall).length);
  assert.equal(CASES.filter((entry) => !entry.recall).length, 10, '误召回反例的条数（口径写死在这里，少一条也是改了口径）');
});

test('同一批候选里只带出该带的那条：茶偏好进来，茶几与起床不进来', () => {
  const store = freshStore();
  try {
    const memory = seedOne(store, '我平时喜欢茉莉花茶');
    memory.recordSemantic({ property: 'place', statement: '遥控器在茶几上', sourceType: 'explicit_correction' });
    memory.recordSemantic({ property: 'routine', statement: '他每天早上六点起床', sourceType: 'explicit_correction' });

    const result = new MemoryRetriever(store).retrieve({ query: '给我推荐个茶。', now: NOW, audience: ALONE, recentTurns: [] });
    assert.deepEqual(
      result.memories.map((row) => row.text),
      ['我平时喜欢茉莉花茶'],
      `只该带出茶那一条：${JSON.stringify(result.memories.map((row) => row.text))}`,
    );
    assert.equal(result.diagnostics.eligible, 3, '前提：三条都过了置信与可见范围');
    assert.equal(
      result.diagnostics.dropped.filter((row) => row.reason === 'not_relevant').length,
      2,
      '另外两条是被相关性拦下的（不是别的理由）',
    );
  } finally {
    store.close();
  }
});

test('话题点名会写进 retrievalReason：面板说得清它是怎么进来的', () => {
  const store = freshStore();
  try {
    seedOne(store, '我平时喜欢茉莉花茶');
    const result = new MemoryRetriever(store).retrieve({ query: '给我推荐个茶。', now: NOW, audience: ALONE, recentTurns: [] });
    const row = result.memories[0];
    assert.ok(row !== undefined);
    assert.match(row.retrievalReason, /说的是同一个话题/, `这一条靠话题点名进来，理由里要说出来：${row.retrievalReason}`);
  } finally {
    store.close();
  }
});

test('置信与可见范围仍然是先决条件：话题点名越不过它们', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    // 同一个话题、但置信只有 0.4（低于 0.55 的门槛）。
    memory.recordSemantic({
      property: 'preference',
      statement: '我平时喜欢茉莉花茶',
      sourceType: 'model_inference',
      confidence: 0.4,
      sourceEventId: 'evt_00000000-0000-4000-8000-0000000000e3',
    });
    const result = new MemoryRetriever(store).retrieve({ query: '给我推荐个茶。', now: NOW, audience: ALONE, recentTurns: [] });
    assert.deepEqual(result.memories, [], '话题点名不是后门：置信不够仍然不召回');
    assert.equal(result.diagnostics.dropped.some((row) => row.reason === 'low_confidence'), true);
  } finally {
    store.close();
  }
});

/**
 * **单内容字查询的召回预算**（V0.3 P2-G 记为已知边界，本轮不收紧；口径与理由见文件头注释）。
 *
 * 这条用例是**现状钉**，不是「应该这样」的断言：它把「同一话题的多条记忆会一起被带进来、
 * 预算会被占掉多少」写成可复跑的实测，供下一轮收紧时对照。改行为就要改这条用例
 * ——那正是它的用途（用例坏了说明口径变了，而不是它拦住了修复）。
 */
test('单内容字查询的同话题预算（已知边界）：茶字点名会带出同话题多条，条数与上限都由实测钉住', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    // 六条同一个话题（都含成词的「茶」）的种子记忆。
    const teaMemories = ['我平时喜欢茉莉花茶', '茶叶罐放在橱柜里', '茶壶该洗了', '茶话会改到周六了', '茶几上有个遥控器', '龙井是去年的茶'];
    const recorded = teaMemories.map((statement, index) =>
      memory.recordSemantic({
        property: 'preference',
        statement,
        sourceType: 'explicit_correction',
        sourceEventId: `evt_00000000-0000-4000-8000-0000000000${String(index + 4).padStart(2, '0')}`,
        // **显式给 id**，不是为了好看：六条的记忆是同一次插入、同一次 `#now()`、同一条置信，
        // 于是分数**相等**，而检索器的排序在等分时按 `candidate.id` 升序兜底 —— 出厂 id 是
        // `sem_${randomUUID()}`，等分时的**顺序会随机抖动**（P2-G 实测：连着两次运行条数一样、
        // 顺序不同）。这一层要钉的是**条数与内容**，所以把 id 写死来消掉那个抖动源。
        memoryId: `mem_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      }),
    );

    const result = new MemoryRetriever(store).retrieve({ query: '给我推荐个茶。', now: NOW, audience: ALONE, recentTurns: [] });
    assert.equal(result.diagnostics.candidates, teaMemories.length, '前提：六条都是候选');
    assert.equal(result.diagnostics.eligible, teaMemories.length, '前提：六条都过了置信与可见范围');

    // 预算：出厂上限 6（硬夹进 3~8）；这一库里实测只注入 4 条，另外 2 条被 `not_relevant` 拦下。
    assert.equal(result.diagnostics.maxItems, 6, '出厂预算上限');
    assert.equal(result.diagnostics.injected, 4, `同话题条数（这条是已知边界的实测值）：${JSON.stringify(result.memories.map((row) => row.text))}`);
    assert.deepEqual(
      result.memories.map((row) => row.text),
      ['我平时喜欢茉莉花茶', '茶叶罐放在橱柜里', '茶壶该洗了', '茶话会改到周六了'],
      `带进来的就是这四条（顺序靠写死的 id 稳定下来）：${JSON.stringify(result.memories.map((row) => row.text))}`,
    );

    // 被丢的**不是**被预算挤掉的（`over_budget`），而是没拿到第三条起要求的强信号
    // （`MEMORY_STRONG_SCORE_FLOOR` 0.9）—— 所以今天这个上限是「信号」挡的，不是「名额」挡的。
    const droppedReasons = result.diagnostics.dropped.map((row) => row.reason);
    assert.deepEqual(
      droppedReasons.filter((reason) => reason === 'over_budget'),
      [],
      `这一库里还没有哪一条是被预算挤掉的：${JSON.stringify(droppedReasons)}`,
    );
    assert.equal(droppedReasons.length, teaMemories.length - result.memories.length, '其余候选都记了被丢的理由');

    // 同一个库、同一份预算，把查询换成一个**更短**的单内容字查询：实测被占满 6 条（上限）。
    // （同样是已知边界：查询越短，话题点名越容易成立，同话题的候选越容易被一起带进来。）
    const shorter = new MemoryRetriever(store).retrieve({ query: '茶呢？', now: NOW, audience: ALONE, recentTurns: [] });
    assert.equal(shorter.diagnostics.injected, 6, `更短的查询实测注入 ${shorter.diagnostics.injected} 条（= 预算上限）`);
    assert.equal(recorded.length, teaMemories.length, '六条种子都写进了库（前提，不是结论）');
  } finally {
    store.close();
  }
});
