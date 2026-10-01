-- 003_open_threads.sql — 未完话题（OpenThread）的 SQLite 落地（pack Phase 3 / 方案 §10）。
--
-- 设计取舍：
--   * `open_threads` 是**可重建的投影**，不是第二份事实：每一次状态变化都写一条
--     `open_thread.changed` 事件（唯一事实来源仍是 `events`），本表只回答「现在这条事处于什么状态」。
--     读取方（XixiStore.openThreads）用它可以不扫全日志；探针可以用日志重建后逐格比对。
--   * `summary` / `subject` 是**用户自己说过的话**（程序裁剪，不加工），`follow_up_hint` 是程序按模板
--     渲染的中文短句。这里不存模型私有推理（铁律 5），也没有模型生成的文本。
--   * 状态取值固定六个（candidate/offered/engaged/resolved/snoozed/exhausted），与事件 schema 的枚举
--     一一对应；`attempts` / `last_offered_at` 让「说过一次没人答」与「问第二次」可区分、可审计。
--   * 时间戳字段与仓库一致：带偏移的 ISO-8601 字符串（domain-model §2），不用 SQLite 的 datetime()。
--   * 不给 `events` 加外键：日志是只追加的，投影删除重建不应被它约束（同 002_world_state.sql）。
--   * 保留 `schema_version`：铁律 10，任何持久记录都带版本。

CREATE TABLE open_threads (
  thread_id       TEXT    PRIMARY KEY,
  schema_version  INTEGER NOT NULL,
  summary         TEXT    NOT NULL,
  subject         TEXT,
  status          TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  follow_after    TEXT,
  expire_at       TEXT,
  follow_up_hint  TEXT,
  importance      REAL    NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_offered_at TEXT,
  source_event_id TEXT,
  note            TEXT
);

-- 「到点了、还是候选」是考虑循环唯一的热查询：状态 + follow_after 一起建索引。
CREATE INDEX idx_open_threads_status_follow_after ON open_threads (status, follow_after);
CREATE INDEX idx_open_threads_updated_at ON open_threads (updated_at);
