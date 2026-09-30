-- 001_initial.sql — M0 最小持久化集合。
--
-- 设计取舍（见 docs/adr/0003-raw-events-vs-memory.md）：
--   * events 是唯一事实来源；对话轮次也是事件，因此不另建 conversation_turns
--     （避免同一事实两份真相）。"最近 N 轮"由 events 上的类型 + session 查询得到。
--   * conversation_sessions 只是投影/索引，可由事件重建。
--   * 说话人身份、Memory、FutureHook、Routine 等表在各自里程碑的迁移里新增，
--     不在这里预埋未使用的表。
--   * schema_migrations 由迁移执行器自己创建与维护，不属于任何迁移文件。

CREATE TABLE events (
  sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT    NOT NULL UNIQUE,
  event_type     TEXT    NOT NULL,
  schema_version INTEGER NOT NULL,
  timestamp      TEXT    NOT NULL,
  source         TEXT    NOT NULL,
  room           TEXT,
  actor          TEXT    NOT NULL,
  confidence     REAL    NOT NULL,
  correlation_id TEXT    NOT NULL,
  session_id     TEXT,
  payload_json   TEXT    NOT NULL
);

CREATE INDEX idx_events_type_sequence ON events (event_type, sequence);
CREATE INDEX idx_events_session       ON events (session_id, sequence);
CREATE INDEX idx_events_correlation   ON events (correlation_id);

CREATE TABLE conversation_sessions (
  session_id       TEXT    PRIMARY KEY,
  schema_version   INTEGER NOT NULL,
  started_at       TEXT    NOT NULL,
  last_activity_at TEXT    NOT NULL,
  ended_at         TEXT,
  turn_count       INTEGER NOT NULL DEFAULT 0,
  -- 与「大脑」会话的映射由领域层持有，且带 provider 名：
  -- BrainAdapter 可替换（DSH/Letta/自研），换掉之后同一段西西会话依然能续上。
  brain_provider   TEXT,
  brain_session_id TEXT
);

CREATE INDEX idx_sessions_brain ON conversation_sessions (brain_provider, brain_session_id);

CREATE TABLE self_profile (
  property       TEXT    PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  value          REAL    NOT NULL,
  source         TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE self_profile_history (
  change_id       TEXT    PRIMARY KEY,
  schema_version  INTEGER NOT NULL,
  property        TEXT    NOT NULL,
  before_value    REAL,
  after_value     REAL    NOT NULL,
  source_type     TEXT    NOT NULL,
  source_event_id TEXT,
  summary         TEXT,
  confidence      REAL    NOT NULL,
  created_at      TEXT    NOT NULL
);

CREATE INDEX idx_self_history_property ON self_profile_history (property, created_at);
