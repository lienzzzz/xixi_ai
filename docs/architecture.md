# 架构（M0 切片）

> 本文只描述**仓库里真实存在**的东西。里程碑总览见 [`progress.md`](progress.md)，
> 事件契约细节见 [`event-contracts.md`](event-contracts.md)，测试分层见 [`testing.md`](testing.md)，
> 决策依据见 [`adr/`](adr/)。上游依据：《方案》[§24 仓库结构](../xixi_ai_companion_project_plan.md)、§25、§34。

## 1. M0 是什么

一句话：**「文字 → Harness → 模型 → 结构化工具调用 → 回答」跑通了，并且两个独立进程之间能恢复同一段会话与同一份人格。**

对应《方案》§34 的 M0 验收：

```text
输入文字 -> DSH -> MiMo -> structured tool -> answer
restart  -> session recover
```

M0 刻意只做这一条纵向切片。它**不是**聊天机器人、不是语音助手、没有记忆、没有主动行为。
它的价值在于把两条缝先钉死：领域层与 Harness 的缝（[ADR-0001](adr/0001-dsh-as-replaceable-harness.md)），
以及事件契约与传输的缝（[ADR-0004](adr/0004-in-process-event-bus-for-poc.md)）。

## 2. 一轮文本的完整路径

```text
调用方（scripts/verify-m0.ts、未来的 voice-edge / debug-console）
  │  ① store.recordTurn(user)                     → events + conversation_sessions（同一事务）
  │  ② adapter.handleUserTurn({sessionId, text, context})
  ▼
DshBrainAdapter                          packages/brain-adapter/src/dsh.ts
  │  ③ store.brainSessionId(sessionId, 'dsh')    → 要 resume 的 harness 会话 id 或 null
  │  ④ transport.turn(DshTurnRequest)            （provider 名默认 'dsh'）
  ▼
CliDshTransport                          apps/brain-dsh/src/transport.ts
  │  ⑤ composeTask(request)                      → 身份 / 有效人格 / 时区 / 最近对话 + 用户输入
  │  ⑥ spawn(node, [dshBin.js, --profile xixi, --json, (--session-id <id>), <task>])
  │       env: DSH_HOME = <repo>/.dsh  +  MIMO_API_KEY（来自 .env / 进程环境）
  ▼
DSH 0.1.7-rc.2（profile xixi：dsh-base + dsh-headless + dsh-xixi-tool）
  │  ⑦ llm-pi-ai 路由 mimo → https://api.xiaomimimo.com/v1（api: openai-completions）
  │  ⑧ 模型决定调用工具 xixi_get_current_time（plugins/xixi-tools/index.js）
  │  ⑨ 工具结果回灌模型，生成最终回答
  ▼
stdout 上的 NDJSON（--json）
  │  ⑩ parseDshJsonLines(stdout)                 → sessionId / toolCalls / finalText / eventTypes
  ▼
DshTurnResponse → DshBrainAdapter
  │  ⑪ 校验 requestId 必须是本轮的；否则 BrainError('INVALID_RESPONSE')
  │  ⑫ 若 harness 给出新会话 id → store.attachBrainSession(sessionId, 'dsh', id)
  │  ⑬ 组装 BrainTurnResult { action, text, toolName, provider, model, brainSessionId, latencyMs }
  ▼
调用方
  │  ⑭ store.recordTurn(assistant, result.action, result.text, result.toolName)
  │  ⑮ store.recordHealth('brain-dsh', 'ok', …)
  ▼
回答
```

要点：

- **每轮一个 `dsh` 子进程**（`CliDshTransport`，`kind = 'dsh-cli'`）。
  代价是整轮 4–6s，收益是「重启恢复」成为默认行为而不是特例；
  M1 因实时语音延迟会换成常驻宿主进程（`docs/progress.md` 第 6 节）。
- **`action` 由传输层判定**：`final` 文本非空 → `SPEAK`；无文本但有工具调用 → `TOOL`；
  两者都空 → `SILENCE`（§55 沉默是一等输出）。领域层的 `TurnAction` 也含 `BACKCHANNEL` / `WAIT`，
  M0 的判定逻辑尚未产生这两个取值。
- **`composeTask` 是 M0 的占位拼装**：身份 + 全部有效人格 + 时区 + `recentTurns(sessionId, 8)`。
  §26 的正式分层拼装（Core Identity → SelfModel → Relationship → WorldState → …）属 M1。
- **resume 的两个硬约束被固定为常量**：`cwd = REPO_ROOT`、`profile = 'xixi'`。
  实测从别的 cwd 或别的 profile 组合 resume 会被 DSH 拒绝
  （[`docs/recon/dsh-integration-2026-09-29.md`](recon/dsh-integration-2026-09-29.md) §3）。

## 3. 持久化的一侧

`packages/domain` 是唯一写 SQLite 的包（`node:sqlite`，WAL）。
`001_initial.sql` 只建 M0 真正需要的四张表，不预埋未使用的表：

| 表 | 角色 | 关键列 |
|---|---|---|
| `events` | **唯一事实来源**；对话轮次也是事件 | `sequence`（自增主键）、`event_id UNIQUE`、`event_type`、`schema_version`、`timestamp`、`source`、`room`、`actor`、`confidence`、`correlation_id`、`session_id`、`payload_json` |
| `conversation_sessions` | **可重建的投影**（不是事实来源） | `session_id` PK、`turn_count`、`ended_at`、`brain_provider`、`brain_session_id`、`idx_sessions_brain` |
| `self_profile` | 人格基线（21 个属性，来自§7.2） | `property` PK、`value`、`source`、`updated_at` |
| `self_profile_history` | 人格变更历史（§7.5） | `change_id`、`before_value` / `after_value`、`source_type`、`confidence` |

关键不变量：

- **`recordTurn` 在同一个事务里追加事件并更新投影**，两者不可能不一致。
- **`seedSelfProfile` 只补缺、不覆盖**（`ON CONFLICT(property) DO NOTHING`）：
  重启是恢复不是重置（§33「重启后持久人格恢复 100%」）。学习/调整引擎属 M3。
- **迁移执行器**：`NNN_name.sql`，逐条事务执行，记录 sha256；已应用迁移内容被改动就拒绝启动
  （`MIGRATION_CHECKSUM_MISMATCH`，§47.3）。`schema_migrations` 表由执行器自己维护，不属于任何迁移文件。
- **`schema_version` 列**存在于全部四张表（铁律 10）。

恢复入口是 `XixiStore.resume(sessionId?)`：返回 `{ session, turns, personality }`
（`latestSession` + `recentTurns(…, 8)` + `selfProfile()`）。

## 4. 两个独立进程的重启证明

`scripts/verify-m0.ts` 用 `spawn(process.execPath, [脚本, --phase=…])` **先后启动两个子进程**，
父进程只读它们打印的 `EVIDENCE ` 行：

| 阶段 | 做什么 | 期望 |
|---|---|---|
| 进程 1 `--phase=fresh` | 记录用户轮次 → DSH → MiMo → 工具调用 → 记录助手轮次与 health 事件 → 退出 | `toolName === 'xixi_get_current_time'`、有 `brainSessionId`、人格非空、事件 3 条 |
| 进程 2 `--phase=resume` | 全新进程打开同一个 SQLite，问「只回复你上一条消息的完整内容本身」 | 同一 `sess_…`、同一 harness 会话 id、人格逐项一致、`turnCount ≥ 4`、助手文本规范化后包含进程 1 的回答 |

为什么这个证明有效：**断言在父进程里，子进程看不到**。
进程 2 没有内存可以继承，也没有任何提示词告诉它答案应该是什么；
它必须通过 `conversation_sessions.brain_session_id` 让 DSH 用 `--session-id` 载入同一段会话，
模型才能逐字复现上一条回复。`docs/progress.md` §0 记录的真实输出：
进程 1 回答 `2026-09-29T15:13:51.620Z`（latency 6.3s，事件 3 条），
进程 2 沿用同一 `sess_6a233a16-…` 与 `session-a75b1195-…`，逐字复现，`turnCount 4`、事件 6 条。

离线版本（不花 API 费用）是 `npm run demo:m0:restart`：同样的两进程结构，
但用 `FakeBrainAdapter` / 直接写库，验证会话、轮次与人格的恢复。

## 5. 明确「没有建」的东西

M0 **不存在**以下能力，任何文档或对话都不应暗示它们已经可用：

| 未建 | 现状 | 会落在哪 |
|---|---|---|
| WorldState（当前世界投影） | 无表、无代码 | M6（摄像头 presence）第一次产生；`BrainContext.worldState` 字段已声明但 M0 传空 |
| Memory（提取 / 检索 / 纠正） | 无表、无代码；`extractMemories` 抛 `NOT_IMPLEMENTED(M4)` | M4（§10、§18） |
| ProactiveEngine（候选 / 硬门禁 / 社交预算） | 无代码；`evaluateProactiveCandidate` 抛 `NOT_IMPLEMENTED(M5)` | M5（§15） |
| Conversation FSM（IDLE/LISTENING/…） | 无代码；`action` 只由「有没有文本/工具调用」判定 | M1（§12） |
| 语音（VAD / ASR / TTS / 打断） | 无代码；本机 Python 3.14 与 Pipecat 不兼容，是 M1 前置 | M1（§46.1、§46.4） |
| 唤醒词 / 声纹 / 摄像头 | 无代码；`config/xixi.example.yaml` 里 `features.*` 全是 `false` | M2 / M6 / M7 |
| 事件回放测试 | `tests/replay/` 为空 | M5（§22.3） |
| 事件总线（MQTT） | 无代码；事件由调用方在同一进程内直接落库 | 出现第二个服务时（[ADR-0004](adr/0004-in-process-event-bus-for-poc.md)） |
| `tsc --noEmit` 类型检查 | 无 `tsconfig.json` | M1 之前（[ADR-0006](adr/0006-runtime-and-dependency-choices.md)） |

`BrainAdapter` 上四个未实现能力（`evaluateProactiveCandidate` / `interpretFeedback` /
`extractMemories` / `reflect`）**签名已固定，调用时抛 `BrainError('NOT_IMPLEMENTED')` 并注明里程碑**——
这是「诚实的缺口」而不是静默的桩函数。

## 6. 后续里程碑的插接点

| 里程碑 | 插在哪 | 已有的形状 |
|---|---|---|
| M1 实时语音 + 打断 | `CliDshTransport` 换成常驻宿主（同一 `DshTransport` 接口，新 `kind`）；新增 voice-edge，调用同一个 `BrainAdapter`；`composeTask` 换成 §26 的分层拼装 | `BrainTurnStream` 已是 `AsyncIterable`，`splitIntoChunks` 已实现（TTS 可在整句生成前开始） |
| M2 Wake / Addressing | voice-edge 内部；产出事件前用确定性门禁 | `config.features.wake_word` 已存在（false） |
| M3 SelfModel | 实现 `interpretFeedback`；写 `self_profile` + `self_profile_history`（表已在） | `FeedbackDecision.scope`（`session_override` / `persistent_soft` / `persistent_explicit`）与 `expires` 已声明 |
| M4 Memory + Relationship | 实现 `extractMemories` / `reflect`；新增 `002_*.sql` 建记忆表，保留 `sourceEventIds` 指回 `events` | `MemoryCandidate` 已含 `type` / `confidence` / `sensitivity` / `ttl` / `sourceEventIds` |
| M5 FutureHook + Proactive + 回放 | 实现 `evaluateProactiveCandidate`；新增 `proactive_decisions` 表（§22.1 的 Decision Trace）；填 `tests/replay/` | `ProactiveDecision.reasonCode`（只存 reason code 与分数，铁律 5） |
| M6 摄像头 presence | perception-edge 发 `presence.changed`（schema 已存在并在测试中使用）；投影出 WorldState | `presence.changed.v1.json` + `BrainContext.worldState` |
| M7 噪声与声纹 | voice-edge 侧 | `config.features.speaker_verification` |

新增事件类型或新增表都遵守同一条规则：**只新增、不改写**（事件新版本文件、迁移新编号文件）。
