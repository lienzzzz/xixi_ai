-- 008_reminders.sql — durable 提醒（pack `docs/03_AGENT_PLUGIN.md` §7 Reminder）。
--
-- 为什么需要这张表（这是 P2-E 要修的那个核心缺陷）：
--   * P2 之前 `xixi_set_reminder_stub` 把自然语言的 `when` 原样丢进**进程内数组**：
--     进程一结束就没了，到点也不会响 —— 工具自己的回话都写着「到点不会自动响，需要人看一眼」。
--     「记着」必须是长期的（铁律 3：重启后要能恢复，用事务或原子写），所以提醒要落库。
--   * pack §7 明确「**不要只把自然语言 when 原样存储**，需要 resolve 成 absolute timestamp + timezone」。
--     因此这张表**没有 when 文本列**：只有 `due_at`（绝对时刻，带显式偏移）+ `timezone`（解析所用
--     的 IANA 时区）+ `resolve_kind`（程序枚举：这一次是怎么解析出来的）。自然语言只在解析那一刻
--     存在，不入库、也读不回来 —— 这条不变量由**表结构**保证，不靠调用方自觉。
--
-- 列的取舍（对照 pack §7 的八个字段，逐个对应，不增不减）：
--   id               ↔ id（主键，`rem_` + uuid，schema 用 pattern 钉住形状）
--   owner            ↔ owner（这条提醒是谁的；认不出时 `unknown`，**不编造一个人**）
--   what             ↔ what（要提醒什么）
--   due_at           ↔ due_at（绝对时刻：offset ISO-8601，如 2026-10-01T08:00:00.000+08:00）
--   timezone         ↔ timezone（IANA 名字，如 Asia/Shanghai）
--   status           ↔ status（五态状态机：pending/due/candidate/delivered/acknowledged）
--   created_at       ↔ created_at
--   source_event_id  ↔ source_event_id（指回触发它的那一轮；由入口给，模型给不了）
-- 另外七列是调度与恢复需要的**程序事实**，不属于 pack 的字段表：
--   schema_version（铁律 10：任何持久记录都要带 schema 版本）
--   due_at_ms（`due_at` 的绝对毫秒；调度必须按**时刻**比较，见下）
--   status_changed_at（上一次状态变化；看「到点多久了、说了没有」）
--   resolve_kind（这次 due_at 是怎么来的：absolute/day_relative/weekday/clock_only/duration/asap/unparsed）
--   session_id（在哪一段会话里记下的，恢复时要用）
--   delivered_at / acknowledged_at（说出口、被认下的时刻；状态机两步的时间戳）
--
-- 为什么需要一个 `due_at_ms` 列（不是冗余）：`due_at` 是 offset ISO 文本，而**跨偏移的字符串比较
-- 是错的**——'2026-10-01T08:00:00+08:00' 与 '2026-10-01T01:00:00+00:00' 是同一个瞬间，但字典序
-- 前后相反。调度查询 `WHERE status = 'pending' AND due_at <= ?` 若按文本比较，会把「已经到点」
-- 判成「还没到」。所以比较与排序都用绝对毫秒，`due_at` 只作为人可读、可带进事件的绝对时刻。
--
-- 与 001–007 同一套做法，**纯新增**：只 CREATE TABLE / CREATE INDEX，
-- 不改写任何已发布的迁移文件（铁律 10）。
CREATE TABLE IF NOT EXISTS reminders (
  id                TEXT PRIMARY KEY,
  schema_version    INTEGER NOT NULL,
  owner             TEXT NOT NULL,
  what              TEXT NOT NULL,
  due_at            TEXT NOT NULL,
  due_at_ms         INTEGER NOT NULL,
  timezone          TEXT NOT NULL,
  status            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  source_event_id   TEXT,
  status_changed_at TEXT,
  resolve_kind      TEXT NOT NULL,
  session_id        TEXT,
  delivered_at      TEXT,
  acknowledged_at   TEXT
);

-- 调度侧唯一的常用查询：到点了、还没动的那些（`WHERE status = 'pending' AND due_at_ms <= ?`）。
CREATE INDEX IF NOT EXISTS idx_reminders_due
  ON reminders (status, due_at_ms);

-- 「这个人还有哪些提醒」是启动恢复与对话里查看的常用查询。
CREATE INDEX IF NOT EXISTS idx_reminders_owner
  ON reminders (owner, due_at_ms);
