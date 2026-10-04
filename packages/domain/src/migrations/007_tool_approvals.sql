-- 007_tool_approvals.sql — 待批的工具调用（pack `docs/03_AGENT_PLUGIN.md` §5 工具审批）。
--
-- 为什么需要一张表：
--   * pack §5 的流程是「model tool_call → permission ASK → **持久化** PendingToolApproval →
--     西西问一句 → 用户确认 → 执行 EXACT frozen call」。同意可能发生在**下一轮对话**、
--     甚至重启之后，所以「这一条待批请求」必须落在库里，不能只活在内存。
--   * 冻结参数（frozen_args）与它的摘要（frozen_args_digest）是这条设计的核心：确认之后执行的
--     是**当时那一组参数**，重新生成或篡改都必须被拒。行里存参数正文，日志里只存摘要。
--   * 状态机与事件一一对应（`TOOL_APPROVAL_STATUSES`，`packages/domain/src/approvals.ts`）：
--     pending → approved/denied/expired →（approved 才可能）executed。
--
-- 与 003/004/005/006 同一套做法，纯新增：只 CREATE TABLE / CREATE INDEX，
-- **不改写任何已发布的迁移文件**（铁律 10）。schema_version 也带上（铁律 10：持久记录都带版本，
-- pack §2 的 manifest 同样带 schemaVersion）。
--
-- 列的取舍（对照 pack §5 的七个字段）：
--   approval_id         ↔ approvalId（主键）
--   session_id          ↔ sessionId
--   actor_id            ↔ actorId（谁在问；`unknown` 是合法值，不编人）
--   tool_name           ↔ toolName
--   frozen_args         ↔ frozenArgs（规范化 JSON 文本）
--   requested_at        ↔ requestedAt
--   expires_at          ↔ expiresAt（到期不执行，落审计）
-- 额外四列是执行与恢复需要的事实，不属于 pack 的字段表：
--   frozen_args_digest  执行时的比对值（篡改检测）
--   scope / timezone    恢复时重建执行上下文的程序事实（模型不能提供）
--   source_event_id     指回触发它的那一轮
CREATE TABLE IF NOT EXISTS tool_approvals (
  approval_id        TEXT PRIMARY KEY,
  schema_version     INTEGER NOT NULL,
  session_id         TEXT NOT NULL,
  actor_id           TEXT NOT NULL,
  tool_name          TEXT NOT NULL,
  frozen_args        TEXT NOT NULL,
  frozen_args_digest TEXT NOT NULL,
  scope              TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  status             TEXT NOT NULL,
  reason_code        TEXT,
  source_event_id    TEXT,
  requested_at       TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  decided_at         TEXT,
  decided_by         TEXT,
  executed_at        TEXT,
  outcome_ok         INTEGER,
  outcome_error      TEXT
);

-- 调度侧只关心「还活着、什么时候到期」的那些行。
CREATE INDEX IF NOT EXISTS idx_tool_approvals_pending
  ON tool_approvals (status, expires_at);

-- 「这条会话有哪些待批」是恢复与审计的常用查询。
CREATE INDEX IF NOT EXISTS idx_tool_approvals_session
  ON tool_approvals (session_id, requested_at);
