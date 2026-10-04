# ADR-0016：记忆状态机（active / superseded / revoked / expired）与纠正闭环

- 状态：已采纳（2026-10-04，V0.3 P1-b t13；状态语义与边界补于 P0+P1 收口 t16）
- 相关：铁律 4（Raw Event 与 Memory 分开；显式用户纠正的权重高于模型推断）、铁律 10（持久记录要有 schema 版本）、
  [ADR-0003](0003-raw-events-vs-memory.md)、[ADR-0015](0015-context-builder-and-engine-boundary.md)、
  pack `E:\xixi_v03_actual_code_pack` 的 `02_MEMORY_CONTEXT.md` §5、`packages/domain/src/memory.ts`、
  `packages/domain/src/migrations/006_memory_status.sql`、`packages/context/src/memory-correction.ts`

## 背景

审计 §3.2 抱怨的是一件**结构性**的事：西西先记下「他喜欢喝绿茶」，后来他说「我什么时候喜欢绿茶了，
我不喝那个」——如果只按「有没有这条记忆」存，两句话会**永久并存**，谁也不知道哪条算数，
而召回可能把已经被否定的那条当成事实说给模型（进而说给用户）。

铁律 4 给的方向是明确的：**Raw Event 是事实，Memory 是推导**；显式纠正的权重高于推断。
所以「哪条算数」必须是一个**持久、可审计、可回滚**的状态，而不是每次读的时候现推。

## 决定

### 1. 四态，只有 `active` 会被召回

```text
MEMORY_STATUSES = ['active', 'superseded', 'revoked', 'expired']   // packages/domain/src/memory.ts

active      当前有效：可以被提示词召回、可以当事实用
superseded  被一条**更新的**记忆取代（superseded_by 指向新那条）：历史留着，但不再召回
revoked     父亲明确否定了这件事：不再召回，也没有替代者
expired     过了有效期（本轮只提供状态与显式接口，**不自动过期**）
```

**只有 `active` 会被召回**这一条落在检索器里：`MemoryRetriever` 的候选集用
`MemoryStore.activeSemantic()`（`packages/context/src/memory-retriever.ts`），所以旧事实不是「被过滤掉了」，
而是**根本没进候选**。全量视图 `MemoryStore.semantic()` 仍然看得见历史——面板要能回答
「这条什么时候不信的、被哪一条取代的」。

### 2. 迁移 006：只新增列，已发布的迁移一字不改

```text
semantic_memory 加三列：
  status             状态本身（默认 active，老行自动落在这个值上）
  superseded_by      取代它的 memory_id（只有 superseded 才有；revoked 为 NULL）
  status_changed_at  状态最后一次变化的时刻（ISO 带偏移，审计用）
另加按状态的索引。
```

铁律 10 的落地方式与 003 / 004 / 005 相同：**新状态 = 新迁移**；`001`–`005` 一个字节没改，
`semantic_memory` 的行形状变化不改变 `xixi.event.v1` 的 `schema_version`（仍是 1）。
`episodic_memory` **不加**状态列：episodic 是「发生过的事」，它不会因为后来的说法被取代——
一次纠正本身就是一件发生过的事（`kind='correction'` 已经记下它了）。

### 3. 状态迁移只有四个入口，且每次变化都留痕

| 方法（`MemoryStore`） | 语义 | `superseded_by` |
|---|---|---|
| `setSemanticStatus({ memoryId, status, at, reason, supersededBy? })` | 通用入口 | 视调用方 |
| `supersedeSemantic({ memoryId, by, at, reason })` | 被新说法取代 | 指向 `by` |
| `revokeSemantic({ memoryId, at, reason })` | 明确否定 | `NULL` |
| `markSemanticExpired({ memoryId, at, reason })` | 过期 | `NULL` |

两条不许破的约束：

1. **`statement` 一字不改**：历史是事实，纠正只能改变「算不算数」，不能改写「当时说了什么」；
2. **两条行都在**：pack 的要求是「不许并存而**不带状态**」，不是「不许并存」。

### 4. 纠正闭环：检测 → 选目标 → 标旧 → 写新 → 留痕

`MemoryCorrectionResolver`（`packages/context/src/memory-correction.ts`）在每一轮的 Tier 1 提取里跑：

```text
① 检测：命中的是「否定/更正」类的说法（如 disown_claim：「我什么时候说过…」「我没说过…」「我说过吗」）
② 选目标：优先**极性冲突**的那条（共享被否定的那个词、结论相反），否则取词面最接近的 active 行
③ 标旧：superseded（有替代者）或 revoked
④ 写新：一条新的语义记忆，sourceType = explicit_correction，confidence 1
⑤ 留痕：一条 episodic(kind='correction') + 一条 system.health(service='memory.status')
```

第 ⑤ 步的审计正文是程序渲染的短句（如「… → superseded：disown_claim：与「我很喜欢喝绿茶」结论相反
（共享被否定的那个词）；新说法：我不喝绿茶」），面板与复验都能直接读。

**幂等**：同一句纠正跑两次不会写出第三条行（实测踩到过，已修并有用例）。

### 5. 端到端证据（不是直接调 resolver）

`tests/integration/memory-correction-closure.test.ts` 走真 `ConversationEngine.respond` + 真
`TurnMemoryExtractor`：旧行 `superseded` + `supersededBy`、`statement` 一字不改、两条都在、
`activeSemantic()` 只剩新说法、**prompt 里不再出现旧事实**、`system.health` 一条；
另有一条用例**关库再开同一个文件库**，把「重启后仍在」钉进默认门禁（`:memory:` 的写法在这里会红）。
跨进程的版本见 [`docs/verification/t15-p1-independent-verification-2026-10-04.md`](../verification/t15-p1-independent-verification-2026-10-04.md)。

### 6. 为什么 `expired` 不自动过期

没有任何后台清理器（AGENTS §3：不引人常驻服务）。到期判定需要「什么时候算到期」的业务口径，
本轮只把**状态与显式接口**备好（`markSemanticExpired` 有调用方与用例），自动过期留给有明确口径的那一轮——
在那之前，`expired` 是一个**可以被设置**的状态，而不是一个会被自动触发的行为。这一点必须写进文档，
免得后来者以为「过期会自动发生」。

## 后果

* **好处**：纠正之后旧事实在**三个面**上同时失效——检索（候选集）、提示词（`prompt.user`）、审计（状态行）；
  且历史与来源都可回查（`sourceEventId` 指回那一轮用户消息）。
* **代价**：每条语义记忆多三列与一个索引；「哪些事实算数」现在是**状态**而不是查询条件，
  任何读路径都必须显式选 `semantic()` 还是 `activeSemantic()`——选错了不会报错，只会安静地说错话。
* **已知边界（由 V0.3 复验发现；t22 已修、t23 复审 pass）**：
  ① **疑问句被写成偏好事实**（既有缺陷、P1 放大后果）：「你还记得我喜欢喝什么茶吗？」曾写成一条 `active` 的 `我喜欢喝什么茶吗`，
  原因是字符类已把 `？` 排除在 `match[0]` 之外、而守卫判的是 `match[0]`；证据与复现见
  [`docs/verification/t15-p1-independent-verification-2026-10-04.md`](../verification/t15-p1-independent-verification-2026-10-04.md) §5。
  修复与复审记在 t22 / t23；本 ADR 描述的是**已落地的状态机**。t22 修好之后，提取侧对「疑问句」与「pack 旗舰场景原句」的行为按 t22 的对照证据为准（`injected=1`、疑问句新增 0 条）。
