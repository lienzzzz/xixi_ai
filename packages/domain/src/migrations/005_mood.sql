-- 005_mood.sql — 有界的心情（pack §23：不要虚构人生，只做一个**可证明有界**的短期情绪状态）。
--
-- 设计取舍：
--   * 心情是**投影 + 派生状态**，不是新的事实类型：原始事实仍然只有 `events`
--     （`conversation.turn` / `proactive.decision` / `presence.changed`）。心情不新增事件类型 ——
--     契约 schema 的 `event_type` 枚举是已发布的（铁律 10：只能新增、不能改写；本轮不改契约），
--     而心情可以从上面三类事件按 `mood.ts` 的确定性规则重放重建。
--   * `mood_state` 是**当前一行**（key='mood.now'）：两个维度 + 累计证据 + 最近一次评估时间。
--     一行而不是多行，因为「现在的心情」是一个点，不是一段时间线。
--   * `mood_history` 是**变更记录**（可查看、可回滚的凭据）：每次真的变了才写一行，
--     存本拍用的信号计数与净偏移。它回答「她今天为什么低」，而不是「她的心情值是多少」。
--   * 两个维度都受 `[0,1]` 硬边界（`mood.ts` 的 clamp 是唯一写入路径），表里不存小数位以外的
--     任何元数据：语义（区间→散文、影响）留在代码里，那样改措辞不用迁移数据库。
--   * `schema_version` 照旧带上（铁律 10）。
--   * 不给 `events` 加外键：与 world_state 同样的理由 —— 投影可以被删除与重建，
--     日志是只追加的唯一事实来源。

CREATE TABLE mood_state (
  key               TEXT    PRIMARY KEY,
  schema_version    INTEGER NOT NULL,
  valence           REAL    NOT NULL,
  energy            REAL    NOT NULL,
  -- 累计证据（JSON）：每个信号出现过几次。它让面板能回答「她为什么是这个心情」。
  evidence_json     TEXT    NOT NULL,
  -- 最近一次评估时刻（ISO 带偏移）：下一次评估据此算衰减，跨重启也连续。
  last_beat_at      TEXT,
  -- 已经吸收到哪一条事件（events.sequence，JSON 列是为了以后可能换成多个游标）。
  -- 为什么需要它（实测换来的）：只按 `last_beat_at` 过滤会漏掉**与评估同一时刻**发生的那一轮
  -- （`respond()` 里 turn 先落库、心情后评估，`at > since` 会把这一轮排除掉，夸奖要等到下一拍才算），
  -- 而把比较放宽成 `>=` 又会让同一拍被重复吸收。序号游标把两件事分开了：时间只用于衰减，去重看序号。
  cursor_json       TEXT    NOT NULL DEFAULT '{"sequence":0}',
  -- 更新时刻与为什么（source 是程序标识符，如 mood:praised；summary 是渲染好的中文）。
  source            TEXT    NOT NULL,
  summary           TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

-- 一次评估里心情真的变了，就写一行（没变不写：避免用同一秒的重复扫描淹掉历史）。
CREATE TABLE mood_history (
  change_id         TEXT    PRIMARY KEY,
  schema_version    INTEGER NOT NULL,
  before_valence    REAL    NOT NULL,
  before_energy     REAL    NOT NULL,
  after_valence     REAL    NOT NULL,
  after_energy      REAL    NOT NULL,
  -- 本拍的净偏移（由 after - before 得到，存下来是为了面板不必重算）。
  delta_valence     REAL    NOT NULL,
  delta_energy      REAL    NOT NULL,
  -- 是不是「复位」（管理员/接口主动清零）：复位也要留痕，否则「为什么她突然平静了」没有答案。
  reset             INTEGER NOT NULL DEFAULT 0,
  -- 本拍用到哪些信号（JSON：code → 次数），以及本拍用了多少条、丢了多少条（超出每拍上限的）。
  signals_json      TEXT    NOT NULL,
  signal_count      INTEGER NOT NULL,
  dropped_count     INTEGER NOT NULL DEFAULT 0,
  note              TEXT    NOT NULL,
  created_at        TEXT    NOT NULL
);

CREATE INDEX idx_mood_history_created ON mood_history (created_at);
