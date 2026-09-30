# ADR-0005：Brain 会话映射放在领域层，并按 provider 键控

- 状态：已接受（2026-09-29）
- 相关：ADR-0001、ADR-0003、[`001_initial.sql`](../../packages/domain/src/migrations/001_initial.sql)、
  [`packages/brain-adapter/src/dsh.ts`](../../packages/brain-adapter/src/dsh.ts)、`docs/progress.md` §2.4
- 上游依据：《方案》§3.2、§21.6、§25、§44；`AGENTS.md` 铁律 9

## Context

「重启后还是同一个西西」需要两段记忆同时活着：

1. **西西自己的会话**：`sess_…`、轮次、人格基线 —— 这是关系本身，换任何组件都不能丢。
2. **Harness 自己的会话**：DSH 的 `session-a75b1195-…` —— 这是上下文缓存，
   只有带着它 resume，模型才记得上一轮说过什么。

DSH 的会话 id 是 Harness 私有概念（`--session-id <id>` 才能续上），按铁律 9 不得出现在
`packages/brain-adapter` 之外。但**持久化**这件事又必须发生在领域层（唯一写 SQLite 的包）。
于是问题变成：这两个 id 的映射放在哪一层、怎么键控。

已实测的 Harness 约束（`docs/recon/dsh-integration-2026-09-29.md` §3）：

- resume 必须使用**相同 cwd**：从别的目录 resume 会被拒绝
  （`session "…" was recorded in "E:\worker2", not "…\.scratch"`）。
- resume 必须使用**相同 profile 组合**（agent preset），并要求 `sessionPersistence` + `sessionQuery` 服务在场。
- patch / 路由必须在 resume 命令上再次出现，否则 `mimo` 没有路由。
- 会话文件落在 `$DSH_HOME/sessions/<escaped-cwd>/<id>/session.v4.jsonl.zstd`。

## Decision

1. **映射存在领域层，列在 `conversation_sessions` 上**：
   `brain_provider TEXT` + `brain_session_id TEXT`，加索引
   `idx_sessions_brain (brain_provider, brain_session_id)`。
   理由：它是持久状态，必须与事件、会话、人格在同一事务边界内；
   `packages/domain` 是唯一写 SQLite 的包，别的层没有数据库句柄。
2. **按 provider 键控**，而不是「一个会话一个 harness id」。读写接口是
   [`XixiStore.attachBrainSession(sessionId, provider, brainSessionId)`](../../packages/domain/src/store.ts) 与
   `brainSessionId(sessionId, provider)`。
   `brainSessionId` 只在 `session.brainProvider === provider` 时返回值，否则返回 `null`——
   这正是「换 Harness 后同一段西西会话仍能续上」的机制：新 provider 拿到 `null`，于是合理地开一段新会话，
   而 `sess_…`、轮次与人格完全没变（《方案》§3.2/§25/§44）。
3. **映射的写入方是 `DshBrainAdapter`，不是 transport。**
   [`DshBrainAdapter.handleUserTurn`](../../packages/brain-adapter/src/dsh.ts) 在每轮开始时
   `this.#store.brainSessionId(input.sessionId, this.provider)` 读出要 resume 的 id，
   在回答后若 harness 给出了新的 id 才 `attachBrainSession(...)`（`provider` 默认 `'dsh'`）。
   `DshTransport` 只负责搬运 `resumeBrainSessionId` 与返回 `brainSessionId`，对数据库一无所知。
4. **Harness 的 cwd 与 profile 是稳定常量，不是每轮参数。**
   [`CliDshTransport`](../../apps/brain-dsh/src/transport.ts) 的构造参数固定为
   `cwd = REPO_ROOT`、`profile = 'xixi'`、`dshHome = <repo>/.dsh`，
   并把 `dshHome` 注入子进程环境（`DSH_HOME`）。resume 的两个硬约束因此变成结构性保证，
   而不是调用者要记得传的两个参数。

## Alternatives

| 方案 | 为什么没选 |
|---|---|
| 把 harness 会话 id 存在 `packages/brain-adapter` 自己的文件/库里 | brain-adapter 只是个适配层，不该有持久化；也会让「唯一写 SQLite 的包」这条约束失效 |
| 只存一个 `brain_session_id`，不带 provider 名 | 换 Harness 后旧 id 会被当成有效 id 交给新 Harness，必然失败或静默串味；也无法同表并存两个 provider 的会话 |
| 让 `CliDshTransport` 自己记会话 id（内存或临时文件） | 进程每轮重启即丢；而且把持久化决策塞进了本该无状态的传输层 |
| 不保存 harness 会话 id，每轮都新开 DSH 会话 | 模型不再记得上下文；`verify:m0` 的「逐字复现上一条回复」永远不可能通过 |
| 用 cwd 或 profile 名当映射的一部分（复合键） | cwd 与 profile 是**同一个** Harness 的部署参数，不是会话身份；把它们放进键会让「换目录重建环境」变成丢会话 |

## Consequences

- **换 Harness 的成本被压到最小**：新增 `LettaBrainAdapter`（`provider = 'letta'`）后，
  旧的 `dsh` 映射仍在表里、依旧可查；同一 `sess_…` 继续服务，`brainSessionId(sess, 'letta')` 先返回 `null`，
  然后写入新的 harness 会话 id。
- **resume 的失败模式是显式的**：cwd 或 profile 组合变了，DSH 会在任务开始前拒绝，
  `CliDshTransport` 把它变成 `BrainError('TRANSPORT_FAILED' / 'PROVIDER_FAILED')`，
  而不是悄悄开一段新会话让「重启恢复」变成假象。
- **可被验收**：`scripts/verify-m0.ts` 断言两个进程拿到**同一个 `sess_…`** 与**同一个 harness 会话**，
  且人格逐项一致；`tests/integration/brain-adapter.test.ts` 断言第一轮 `resumeBrainSessionId === null`、
  第二轮等于第一轮落库的 id；`tests/integration/restart-recovery.test.ts` 断言新进程把持久化的
  harness 会话原样交回给 harness。
- **代价**：DSH 会话文件本身不是事实来源。它丢失时西西不会「失忆」到丢事实——
  `events` 与 `self_profile` 仍在；代价只是模型失去了那段上下文缓存，
  需要靠 `recentTurns` 重新喂回去（M1 的正式 prompt 拼装，§26）。
- **代价**：会话映射与 harness 的 cwd/profile 绑在一起，因此**环境目录不能随便搬**
  （搬 `E:\worker2` 会让旧 DSH 会话无法 resume）。这是 Harness 的约束，不是可以靠本层绕过的。
