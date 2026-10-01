-- 004_memory.sql — 长期记忆、关系记录与三层自我画像（pack Phase 4 / 《方案》§7 §8 §11）。
--
-- 设计取舍：
--   * **记忆是推导（derived），不是事实**（铁律 4）：`events` 里的 `conversation.turn` 才是原始事实，
--     这些表只存「程序从原始事实里提炼出来的东西」，每行都带 `source_event_id` 指回去。
--     所以这里**不新增事件类型**：不是每一次记忆写入都值得进事件日志（日志是事实与判定），
--     而记忆可以按 `source_event_id` 重放重建。每张表仍然带 `schema_version`（铁律 10）。
--   * 四张表按《方案》§11 的命名空间分开，而不是一张大表：episodic（发生过的事）、
--     semantic（稳定事实/偏好）、relationship（我们怎么相处）、topic_history（在 003 的 open_threads 里）。
--   * 自我画像是**三层相加**（《方案》§13）：`self_profile`（基础，已有）+ `self_profile_learned`
--     （学习到的偏移）+ `session_overrides`（当天有效，次日自动失效）= 有效人格。
--     偏移值一律记录来源与证据（`source_type`/`evidence`/`confidence`），并受 §7.4 的
--     「明确长期指令一次最大 ±0.15、隐式反馈单次最多 ±0.01~0.03、不允许单次抱怨拉到极端」约束。
--   * `session_overrides.valid_day` 是**本地自然日**：读取时只认「今天」的那些行，
--     所以「今天想安静点」次日自动恢复，不需要一个定时任务去清理（这台机器随时可能断电）。
--   * 记忆可查看、可编辑、可删除（AGENTS §5）：表结构允许 UPDATE/DELETE，domain 层提供对应方法。

-- 发生过的事情（episodic）：一次明确的纠正、一件记下来的事。
CREATE TABLE episodic_memory (
  memory_id       TEXT    PRIMARY KEY,
  schema_version  INTEGER NOT NULL,
  occurred_at     TEXT    NOT NULL,
  summary         TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  source_type     TEXT    NOT NULL,
  source_event_id TEXT,
  session_id      TEXT,
  importance      REAL    NOT NULL,
  confidence      REAL    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE INDEX idx_episodic_occurred ON episodic_memory (occurred_at);
CREATE INDEX idx_episodic_kind ON episodic_memory (kind, occurred_at);

-- 稳定的事实与偏好（semantic）：父亲自己说过的、可长期复用的一句事实。
CREATE TABLE semantic_memory (
  memory_id       TEXT    PRIMARY KEY,
  schema_version  INTEGER NOT NULL,
  property        TEXT    NOT NULL,
  statement       TEXT    NOT NULL,
  source_type     TEXT    NOT NULL,
  source_event_id TEXT,
  confidence      REAL    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE INDEX idx_semantic_property ON semantic_memory (property);

-- 我们怎么相处（relationship）：不是「父亲是谁」，而是「西西和父亲怎么相处」。
CREATE TABLE relationship_notes (
  note_id         TEXT    PRIMARY KEY,
  schema_version  INTEGER NOT NULL,
  aspect          TEXT    NOT NULL,
  note            TEXT    NOT NULL,
  source_type     TEXT    NOT NULL,
  source_event_id TEXT,
  confidence      REAL    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE INDEX idx_relationship_aspect ON relationship_notes (aspect);

-- 学习到的人格偏移（LearnedProfile）：每属性一行，累计值。
CREATE TABLE self_profile_learned (
  property        TEXT    PRIMARY KEY,
  schema_version  INTEGER NOT NULL,
  delta           REAL    NOT NULL,
  source_type     TEXT    NOT NULL,
  evidence        TEXT,
  confidence      REAL    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- 会话覆盖（SessionOverride）：只对 `valid_day` 这一本地自然日生效，次日自动失效。
CREATE TABLE session_overrides (
  override_id     TEXT    PRIMARY KEY,
  schema_version  INTEGER NOT NULL,
  session_id      TEXT,
  property        TEXT    NOT NULL,
  delta           REAL    NOT NULL,
  reason          TEXT    NOT NULL,
  source_type     TEXT    NOT NULL,
  valid_day       TEXT    NOT NULL,
  created_at      TEXT    NOT NULL
);

CREATE INDEX idx_session_overrides_day ON session_overrides (valid_day, property);
