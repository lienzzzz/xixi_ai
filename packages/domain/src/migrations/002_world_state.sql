-- 002_world_state.sql — WorldState-lite：可查询的「当前状态投影」。
--
-- 设计取舍（《方案》§5.3 / §5.4，docs/design/domain-model.md）：
--   * `world_state` 是**当前投影**，不是历史。历史仍然只有一份：`events`（唯一事实来源）。
--     presence 的每一次翻转都在 `events` 里（`event_type='presence.changed'`），本表只回答
--     「现在这一刻家里有人吗」，可以被事件重放重建（见 XixiStore.rebuildWorldState 的说明）。
--   * §5.3 要求每个状态都带 value / source / updated_at / confidence / TTL：
--     列名一一对应，`ttl_seconds` 就是 stale_after —— 超过它这个值不再是「现在」，
--     读取方（XixiStore.worldState()）据此算出 `stale`，不允许把 30 分钟前的视觉结果当现在。
--   * `key` 用点分命名空间（`presence.home`），第一段是领域（presence），
--     第二段是范围（home）；M6 只写 `presence.home` 一个键，但表结构不为此特化。
--   * `value` 存字符串而不是布尔：将来会有 `home`、`living_room`、`dark` 这类非布尔值，
--     语义比较交给读取方，避免同义文本被当成不同状态。
--   * 不给 `events` 加外键：投影是派生数据，删除/重建它不应该受日志约束（日志是只追加的）。
--   * 保留 `schema_version`：铁律 10，任何持久记录都带版本。

CREATE TABLE world_state (
  key            TEXT    PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  value          TEXT,
  source         TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  confidence     REAL    NOT NULL,
  ttl_seconds    REAL    NOT NULL
);

CREATE INDEX idx_world_state_updated_at ON world_state (updated_at);
