-- 006_memory_status.sql — 记忆的状态机（pack `docs/02_MEMORY_CONTEXT.md` §5 记忆纠正/冲突）。
--
-- 为什么需要一次迁移（而不是「反正能算出来」）：
--   * 004_memory.sql 建表时，一条语义记忆只有「有/没有」两种状态。V0.3 P1 的自然语言纠正闭环
--     要求旧事实被**标记**为 superseded / revoked —— 这是一个持久的**状态**，不是一次读时的推断：
--     它必须能回答「这条记忆什么时候、被哪一条取代的」，而且面板与评审要能直接查。
--   * 用 `property` 后缀或 id 编码去承载状态（不改 schema 的两条替代方案）会把状态藏进
--     分类字段与主键里，读的人每处都要再解析一次；本仓库的既有口径是「新的持久状态 = 新的迁移
--     （003 未完话题 / 004 长期记忆 / 005 心情都是这么加的）」。
--   * 迁移**只新增列、不改既有列**（铁律 10：已发布的迁移只能新增、不能改写；004 的文件一字未动）。
--
-- 状态取值与语义（`MEMORY_STATUSES`，`packages/domain/src/memory.ts`）：
--   active      当前有效：可以被提示词召回、可以当事实用
--   superseded  被一条**更新的**记忆取代（`superseded_by` 指向新那条）：历史留着，但不再召回
--   revoked     父亲明确否定了这条事实（「我什么时候喜欢绿茶了」）：不再召回，也不存在替代者
--   expired     过了有效期（本轮只提供状态与显式接口，**不自动过期** —— 见 memory.ts 的说明）
--
-- 三列的分工：
--   status             状态本身
--   superseded_by      取代它的 memory_id（只有 superseded 才有；revoked 为 NULL）
--   status_changed_at  状态最后一次变化的时刻（ISO 带偏移）：审计「什么时候开始不认这条」用
--
-- episodic_memory 不加这一列：episodic 是「发生过的事」，它不会因为后来的说法而被取代 ——
-- 一次纠正本身就是一件发生过的事，`kind='correction'` 已经把它记下来了。只有语义记忆
-- （稳定事实与偏好）才存在「这条还算不算数」。

ALTER TABLE semantic_memory ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE semantic_memory ADD COLUMN superseded_by TEXT;
ALTER TABLE semantic_memory ADD COLUMN status_changed_at TEXT;

-- 检索只取 active（`MemoryStore.activeSemantic`），这是它最常见的过滤条件。
CREATE INDEX idx_semantic_status ON semantic_memory (status, property);
