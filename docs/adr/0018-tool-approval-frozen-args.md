# ADR-0018：工具审批模型（冻结参数、拒绝落审计、恢复语义）

- 状态：已采纳（2026-10-04，V0.3 P2-B t4/t22；P2 收口 t15 落笔）
- 相关：铁律 1（模型只做理解与判断）、铁律 5（只存 reason_code 与分数）、铁律 8（工具权限在模型之外校验）、
  [ADR-0017](0017-plugin-boundary-and-four-prohibitions.md)、
  pack `E:\xixi_v03_actual_code_pack` 的 `03_AGENT_PLUGIN.md` §5、
  `packages/domain/src/approvals.ts`、`packages/domain/src/migrations/007_tool_approvals.sql`、
  `packages/runtime/src/tool-approval.ts`、`packages/brain-adapter/src/tool-registry.ts`

## 背景

pack §5 要的是一条**可恢复的**审批路径，而不是「模型先问一句」：

```text
model tool_call → permission ASK → persist PendingToolApproval → 西西自然问一句
                → 用户确认 → execute EXACT frozen call → append tool result → resume agent turn / new turn
拒绝则落审计，不执行。
```

在 P2 之前，「ask」只是**给模型的一句提示**（`ToolRegistry.execute` 返回 `ASK` 让模型先问一句），
没有任何持久化：进程一退，等谁点头这件事就没了；而且**用户点头之后要执行哪一组参数**没有定义——
模型完全可以重新生成一组。这两点都必须由程序定死。

## 决定

### 1. 七个字段就是 pack 的七个字段，另加四个「恢复用」的程序事实

```text
approvalId   sessionId   actorId   toolName   frozenArgs   requestedAt   expiresAt      // pack §5 七个
frozen_args_digest  scope  timezone  source_event_id                                    // 表里多出的程序事实
```

`ToolApproval` 的形状定义在 `packages/domain/src/approvals.ts`（**不是** `LongTermMemory` 那种自由文本：
`scope` / `timezone` 是恢复执行时重建 `ToolExecutionContext` 用的，模型不能提供；`source_event_id` 指回触发它的那一轮）。
`actorId` 认不出来时是 `unknown`——**不编造一个人**。

### 2. 状态机五态，每次变化在**同一事务**里写一条事件

```text
TOOL_APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'executed']
TOOL_APPROVAL_REASON_CODES = ['approval_requested', 'user_approved', 'user_denied',
                              'approval_expired', 'approval_executed', 'approval_execution_failed']
```

表与事件同一事务（与 `open_threads` 同一套做法）：日志是事实来源、表可被日志重建，所以**重启后「谁在等谁点头」不会丢**，
也不会把已经做过的外部动作再做一遍（AGENTS §3）。迁移 007 是**纯新增**（`git diff --name-only -- packages/domain/src/migrations/` 为空自证）。

### 3. 冻结参数是**摘要**化的，执行路径自己比对

- `canonicalToolArguments()` 把参数规范化，`toolArgumentsDigest()` 出 sha256（`packages/brain-adapter/src/tool-registry.ts`）。
- 执行走 `ToolRegistry.execute(call, context, { approval: { approvalId, argsDigest, approvedBy } })`：
  **摘要对不上就 `APPROVAL_MISMATCH`，工具零调用**——这条不变量属于执行路径，不靠调用方自觉。
- 反事实（t10 评审独立做过）：拿掉摘要比对 → 2 条用例红；「旧摘要配新参数」与「第二个连接 UPDATE 了 `frozen_args`」
  都被拦住且工具没有被调用过。

### 4. 点头、拒绝、到期的三种结局都是**可观察**的

| 结局 | 状态 | 原因码 | 有没有执行 | 审计 |
|---|---|---|---|---|
| 人点头 | `approved` → `executed` | `user_approved` → `approval_executed`（失败也记 `approval_execution_failed`） | 执行的是**冻结的那一组**参数，只跑一次 | 事件里 `score = 1`（人的决定）、`decided_by` = 入口给的身份 |
| 人拒绝 | `denied` | `user_denied` | **不执行** | `score = 1`，拒绝后同一会话下一轮照常走完、不卡死 |
| 到期 | `expired` | `approval_expired` | **不执行** | `score = 0`（程序判定） |

`approvalDecisionScore(status)`（`packages/domain/src/approvals.ts`）就是这张表的代码化：`approved`/`denied`/`executed` → 1，
其余 → 0；事件信封的 `confidence` 恒为 1（这是程序写下的事实，不是推断）。铁律 5：事件里只有原因码、状态与分数。

**恢复语义（本轮点名要落的一条）**：`approve()` **自己就是到期闸门**——它先看 `expiresAt` 再执行，
不需要任何 sweep；越期之后再点头，得到 `expired` 与零调用（t22 为这条补了回归用例：先断言此刻仍是 `pending`，
再越过 TTL 直接 approve，断言 `expired`、`approval_expired`、`execution === null`、工具体 0 次调用）。
执行结果会写成一条 `conversation.turn`（`action = TOOL`），于是**下一轮读得到**——这就是 pack 里
「resume agent turn / new turn」的落点，而不是把结果丢给调用方。

### 5. 声明面：先声明，才会 ASK

```text
config/xixi.yaml → tools.approval.ask[]   （parseToolApprovalSettings，出厂默认空）
tools.approval.ttl_seconds                （默认见 DEFAULT_TOOL_APPROVAL_SETTINGS）
```

**没声明就没有任何工具需要 ASK**——审批是一件要显式打开的事。两个配套语义（都改过默认行为，故在此留档）：

- `ToolRegistry.listForAgent()` 从「只广告 `allow`」改成「**除 `deny` 之外都广告**」：ask 的工具必须被模型看见，
  否则 pack §5 的流程没有起点；
- `ToolPermission.check()` 的判定顺序改成「**所有 deny 规则先于 ask**」，否则 ask 会变成绕过 deny 的旁路
  （有用例钉住：`ask` 不能放宽一个被判 deny 的调用）。

## 后果

- 审批路径**完整可用**：真循环（FakeBrainAdapter）→ 落库 → 点头 → 冻结参数执行 → 事件与审计，都有实测证据；
  状态机、摘要、到期闸门各有突变实验证明承重（见 t10/t23 评审报告）。
- **未接线（不许写成已接线）**：四个 live 入口今天**没有**把 `ToolApprovalManager` 接成 `approvalGate`
  （t4 估约三行）；因此「部署里真的会拦下来」这句话在入口层还不成立，能跑的证据链是
  「装配点 → `registry.execute` → 真表」。
- **manifest 的 tool 级 approval 声明未实现**：今天只有 `config.tools.approval.ask` 在起作用；
  `ActionHandler.approval` 只作用于 `action` 能力，而 `action` 还没有暴露成工具。这是**下一轮的小任务**
  （它与 `packages/plugins` 和 `packages/domain/src/config.ts` 都有交集，故本轮不排）。
- 拒绝是**成本为零**的一条路（不执行 + 落审计），到期同理；两者的分数都是 0，所以事后统计「她问了几次、
  人答应了几次」不会把程序判定混进人的决定里。
