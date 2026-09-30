# ADR-0003：原始事件是唯一事实来源，Memory 是推导

- 状态：已接受（2026-09-29）
- 相关：[`docs/event-contracts.md`](../event-contracts.md)、[`001_initial.sql`](../../packages/domain/src/migrations/001_initial.sql)、
  [`packages/domain/src/store.ts`](../../packages/domain/src/store.ts)、ADR-0004、ADR-0005
- 上游依据：《方案》§2.2、§10、§23.2、§47.2/§47.3；`AGENTS.md` 铁律 4、10

## Context

方案里既有「事件日志」，又有「对话轮次」「记忆」这类看起来平行的概念。如果三者各存一份，
同一个事实就会有两份真相：重启后恢复哪一个？纠正一条记忆时，原始轮次要不要改？
M0 只有一张 `001_initial.sql`，正是决定这件事的最便宜的时刻。

同时铁律 4 要求区分 **Raw Event（事实）** 与 **Memory（推导）**，并且「显式用户纠正的权重高于模型推断」；
铁律 10 要求任何持久记录都有 schema 版本；《方案》§47.2 还列了 14 张「建议表」。
M0 的取舍是：**不预埋未使用的表**。

## Decision

1. **`events` 表是唯一事实来源（single source of truth）。** 所有事实以经过
   `validateEvent`（`xixi.event.v1`）校验的信封追加进 `events`，一条不可变、可排序。
2. **对话轮次就是事件，因此不建 `conversation_turns` 表。**
   一次用户发言/一次西西回复 = 一条 `conversation.turn` 事件，
   由 [`XixiStore.recordTurn`](../../packages/domain/src/store.ts) 追加。
   「最近 N 轮」直接查事件日志：`recentTurns(sessionId, limit)` 在 `events` 上按
   `event_type = 'conversation.turn' AND session_id = ?` 倒序取 N 条再 `reverse()`；
   `session_id` 这一列由 `appendEvent` 从 payload 里提取（`sessionIdOf`）以便建索引，不重复存事实。
3. **`conversation_sessions` 只是投影（projection），可由事件重建。**
   它保存 `started_at` / `last_activity_at` / `ended_at` / `turn_count` 与 harness 映射，
   用于「最快找到最近会话」与 resume；它不是事实来源。
   `recordTurn` 把「追加事件」与「更新投影」放在**同一个事务**里，因此两者不可能不一致
   （事务实现见 `#transaction`：`BEGIN IMMEDIATE` / `COMMIT` / 出错 `ROLLBACK`）。
4. **Memory 是推导物，属于 M4，M0 不建任何记忆表。** M0 只有事件、会话投影、人格基线与人格变更历史。
   Memory 将来从事件区间提取（`BrainAdapter.extractMemories`，当前抛
   `BrainError('NOT_IMPLEMENTED', milestone: 'M4')`），并保留 `sourceEventIds` 指回原始事实。
5. **不存模型私有推理。** 事件里没有 chain-of-thought 字段；主动行为将来只存 `reason_code` 与分数
   （`ProactiveDecision.reasonCode`，铁律 5）。M0 的 `conversation.turn` payload 只有
   `session_id` / `turn_index` / `role` / `action` / `text` / `tool_name`。
6. **每个持久记录都带 `schema_version`。** `events`、`conversation_sessions`、`self_profile`、
   `self_profile_history` 四张表都有该列（迁移文件里显式 `NOT NULL`），并配合同一个迁移执行器。

## Alternatives

| 方案 | 为什么没选 |
|---|---|
| 单独建 `conversation_turns` 表（轮次 + 事件双写） | 同一事实两份真相；纠正、重放、迁移都要双份维护；`recordTurn` 的事务复杂度上升而收益为零 |
| 只存「最近 N 轮」的滚动快照 | 不可回放、不可审计，且与 §22.3 的事件回放目标冲突 |
| M0 就把 §47.2 的 14 张表全部建出来 | 违反「不预埋未使用表」；空表会给出「功能已存在」的错误印象，也让迁移历史失去信息量 |
| 把模型 `reasoning_content` 存进事件以便调试 | 违反铁律 5；且思考内容属于可替换模型的私有推理，换模型后语义不可比 |
| 把 harness 会话内容复制进西西的库 | 会导致两套上下文互相竞争；harness 会话是可重建的缓存，映射留在领域层即可（ADR-0005） |

## Consequences

- **恢复语义干净**：重启后 `resume()`（`latestSession` + `recentTurns` + `selfProfile`）完全由
  `events` 与 `self_profile` 决定；离线测试 `tests/integration/restart-recovery.test.ts` 与
  真实两进程验收 `scripts/verify-m0.ts` 都在验证这一点。
- **可回放性有落点**：因为轮次是事件，§22.3 的「导出事件区间 → 重放 → 复现决策」不需要先做数据搬迁，
  只缺 `tests/replay/` 本身（M5，见 `docs/testing.md`）。
- **代价：查询而非表**。「第 N 轮」「最近 N 轮」是查询成本；M0 的量级（单机、个位数轮次/会话）
  完全可接受，`idx_events_session (session_id, sequence)` 与 `idx_events_type_sequence` 覆盖了这些访问路径。
- **代价：投影一致性靠事务而非外键**。`conversation_sessions.turn_count` 是派生值，
  当前由 `recordTurn` 在事务内维护；如果将来有第二条写路径，必须同样进入该事务，
  否则投影会漂移（届时应写一条「从事件重建投影」的维护命令）。
- **事件不可改**：纠错不是改历史，而是**追加**一条新事件（未来的记忆纠正同理）。
  这与 `events.event_id UNIQUE` 一起保证了重复投递不会变成重复事实（重复时抛 `DomainError('DUPLICATE_EVENT')`）。
- 已发布迁移只能新增、不能改写：`migrate()` 记录每个迁移文件的 sha256，内容变动即
  `MIGRATION_CHECKSUM_MISMATCH` 并拒绝启动（`AGENTS.md` 铁律 10、《方案》§47.3）。
