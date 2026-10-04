# ADR-0014：可信记忆策略与 provenance（读侧：谁能进提示词、以什么名义进）

- 状态：已采纳（2026-10-04，V0.3 P1-a t12；`topicCoverage` 这条相关性路径由 t22 补上，本 ADR 在 P0+P1 收口 t16 落笔）
- 相关：铁律 1（规则与状态由程序负责）、铁律 4（Raw Event 与 Memory 分开；显式纠正权重高于推断）、
  铁律 5（只存 reason_code 与分数）、铁律 6（连续音视频不上云）、[ADR-0003](0003-raw-events-vs-memory.md)、
  [ADR-0015](0015-context-builder-and-engine-boundary.md)、[ADR-0016](0016-memory-status-state-machine.md)、
  pack `E:\xixi_v03_actual_code_pack` 的 `02_MEMORY_CONTEXT.md` §4、`packages/context/src/memory-retriever.ts`、
  `packages/context/src/memory-score.ts`、`packages/context/src/render.ts`、`packages/conversation/src/prompt.ts`（`HARD_POLICY`）

## 背景

P1 之前记忆是**只写不读**的：`TurnMemoryExtractor` 会把偏好、事件、关系、未完话题写进库，
但 `MemoryStore.snapshot()` 在生产入口**零调用方**（V0.3 运行时地图 §2 第 8 条的复核结论）。
「记下来但用不上」不是能力，审计 §3.2 抱怨的正是这件事的另一面：一旦真的开始读，就必须回答三个问题——

1. **谁能进提示词**：库里躺着几十条记忆，模型这一轮该看到哪几条？
2. **以什么名义进**：它是「对方刚说的」「工具查到的」还是「系统记着的」？可信程度不同，说法必须不同。
3. **进去的是什么文字**：程序内部用的 id、参数名、调试字段**不能**变成模型看到的话。

## 决定

### 1. 三处来源，且不确定要说出来（提示词层的硬边界）

`HARD_POLICY`（`packages/conversation/src/prompt.ts`）在 P1 改成三条来源：
**当前对话里对方明确说的 / 工具真的查到的 / 系统给的可信记忆或世界状态**；
三处都没有就直说「我不知道」或「我记不准」。记忆按它标的确定程度说：
标了 `[较确定]` 才当事实，标了 `[有点旧]` 就当作可能已经变了；**模型自己「好像记得」的内容不算事实**。
这条同时挡住「凭印象编造」与「拿旧记忆当现状」。

### 2. 每条记忆带 provenance，来源类型决定可信基线

```text
RetrievedMemory = { id, kind, text, provenance, visibility, retrievalReason }
provenance      = { sourceEventId, sourceType, confidence, occurredAt, updatedAt }

sourceType → 可信基线（packages/domain/src/memory.ts 的 MEMORY_SOURCE_CONFIDENCE）
  explicit_correction  1.0   父亲明确说的（纠正 / 偏好 / 事实）
  program_extraction   0.8   程序按规则提炼的
  model_inference      0.4   模型给的结构化判断（只允许白名单码）
```

`sourceEventId` 指回那条原始事件——「她为什么记得这件事」永远能回到日志（铁律 4/5：Raw Event 与 Memory 分开）。

### 3. 先决条件在排序之前，四道门

```text
① visibleTo(visibility, audience)        在哪说（private / family / public）——**先于检索**
② usefulText(text)                       文本可用（不是机器 id 形态）
③ confidence >= DEFAULT_MIN_CONFIDENCE   默认 0.55
④ 相关性（见 §4）                         四条路径之一
```

只有 `active` 的语义记忆会进候选（见 [ADR-0016](0016-memory-status-state-machine.md)），
所以「被否定的旧事实」是在**候选集**这一层就消失的，不是排序把它压下去。

### 4. 相关性是四条路径，不是一条分数

```text
bigram 相关    >= MIN_BIGRAM_RELEVANCE    0.34
加权词面相关   >= MIN_LEXICAL_RELEVANCE   0.25
主语命中       记忆的 subject 出现在这一轮里
与未完话题相关  该记忆是某个活着的话题的来源
（t22 补）话题覆盖  topicCoverage === TOPIC_COVERAGE_FLOOR(1)：**查询的每个内容字都成词出现在记忆里**
```

前三条是**词面**信号，第四条是**话题**信号，差别用一句真话说明：`给我推荐个茶。` 与
`我平时喜欢茉莉花茶` 的 `topicCoverage` 是 1（查询唯一的内容字「茶」在记忆里成词出现），
而词面相关几乎是 0。**为什么必须有它**：V0.3 的独立复验（t15）实测到，只有词面路径时
pack 的旗舰场景「Day1 说偏好 → Day2 问推荐」在**原问句**下召回不过去（`not_relevant`、`injected=0`），
用户看到的是引擎的兜底句。`topicCoverage = 1` 对长查询很严（要**全部**内容字都对上），
对短查询就是一次话题点名——这是有意的：宁可严格，也不要靠「共享一个常见字」把不相干的记忆拉进来。
功能字表（`CONTENT_STOP_CHARS`）只影响这一条信号，**不参与词面相关与排序权重**，且表里不放名词。

### 5. 排序是确定性的，权重与常量公开

```text
MEMORY_SCORE_WEIGHTS   lexical 1.2 | recency 0.7 | importance 0.5 | confidence 0.6
                       subject 0.55 | openThread 0.4 | stale 0.6（扣分） | alreadyMentioned 0.5（扣分）
RECENCY_HALF_LIFE_DAYS 30（连续回落，不是硬边界）
MAX_STALE_PENALTY 0.6 | MAX_ALREADY_MENTIONED_PENALTY 0.5
```

权重是导出常量，任何一条候选的分数都能逐项复算（复验时不用读实现）。
**没有向量库、没有随机性**：同一份库 + 同一句话，今天与明天给出同一批记忆（replay 才能当基线用）。

### 6. 注入 3~8 条，凑不满就少给

```text
MIN_INJECTED 3 | MAX_INJECTED 8（硬夹）
MEMORY_SCORE_FLOOR 0.35        前两条按它收
MEMORY_STRONG_SCORE_FLOOR 0.9  第三条起要求确实有信号（词面 / 主语 / 话题）
```

「凑不满」是**诚实的结果**而不是要掩盖的失败：诊断里带着 `candidates` / `eligible` 与每条被丢的原因
（`not_visible` / `unusable_text` / `low_confidence` / `not_relevant` / `over_budget`），
面板能区分「库里就没有」与「都不相关」。

### 7. 出口还有第二道闸门，而且被拦掉的整条丢弃

`render.ts` 的两道闸门（[ADR-0015](0015-context-builder-and-engine-boundary.md) §4 有分工说明）：
`usefulText` 在检索阶段拦机器 id；`renderGate` 在渲染时再拦**参数名**（`valence=0.310`）与空白文本。
被拦掉的整条**丢弃**，不改写成「看起来干净」的样子；条数只进 `sections[].debug`
（`injected=` / `dropped_at_render=`），**不进**模型看到的文字。用例断言 `prompt` 里没有 UUID、
没有 `sem_` / `mem_` / `evt_` / `thread_` 形态 id、没有 `injected=` 这类调试字段。

## 后果

* **好处**：三件事同时成立——只有算数的记忆能被召回（ADR-0016）、每条都能回到来源、
  模型看到的是一句话（不是 id 或参数名）；而且整条链路确定性、可复算。
* **代价**：相关性先决会「安静地少给」（这也是设计意图），但**少给的原因只能从诊断里看**——
  任何下游想回答「她为什么没提那件事」，必须读 `memoriesDiagnostics`，不能凭 prompt 反推。
* **已知边界（V0.3 复验实测；t22 已修、t23 复审 pass；下面两条口径属 captain 裁定，不是缺陷）**：
  1. 提取侧（Tier 1 规则）对 pack 旗舰场景的**原句**「我不喝绿茶，平时喜欢茉莉花茶。」不命中（整句匹配、不按逗号切分）；
  2. 原问句的召回依赖 §4 的话题覆盖（t22 落地后成立）；
  3. 疑问句曾被写成偏好事实（守卫 `statement.includes('？')` 恒为假），同一批次修。
  三条的证据与复现命令见
  [`docs/verification/t15-p1-independent-verification-2026-10-04.md`](../verification/t15-p1-independent-verification-2026-10-04.md)。**t22 修复后的口径**：话题点名要求「查询的每个内容字都成词出现在记忆里」
  —— 对短问句（「给我推荐个茶。」）成立，对**复合问句**（「给我推荐个茶，顺便说说天气。」）不成立，这是**有意收紧**而不是漏召回；
  疑问识别只认**字面三种形态**，无标记的疑问残句仍按陈述读（例如「我喜欢的茶」会落库成 `preference:我喜欢的茶`）。两条都按口径记在文档里，本轮不放宽（captain 裁定）。
  另有一条**既有**（非本轮引入）的提取侧行为：宾语前置句会写出没有宾语的截断记忆（「铁观音我平时喜欢」→ `routine:我平时喜欢`），
  t23 在 t22 前后跑同一批句子输出逐字相同；P1 之后这种行会被召回、会进提示词，修它属提取侧，下一轮。
* **明确没做的**：Tier 2 结构化抽取**没有接进任何入口**（只有接缝与政策，config 里如实写着）；
  记忆的查看/编辑/删除 UI 仍未做；**没有**向量检索（这一轮的目标是确定性，不是召回率）。
