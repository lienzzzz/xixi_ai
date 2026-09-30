# 领域模型：事件、持久化与人格

> 最后更新：2026-09-30
> 权威来源：`packages/contracts/src/*.ts`、`packages/contracts/schemas/**`、`packages/domain/src/{store,migrations,personality,config,clock}.ts`、`packages/domain/src/migrations/001_initial.sql`
> 若与代码不一致，以代码为准，并请立即修正本文件

范围：**唯一事实来源**（事件日志）与**它旁边的持久状态**（会话投影、人格基线、迁移记录）。
事件字段的逐条规则另有一份更详细的 [`../event-contracts.md`](../event-contracts.md)；本文只写与领域模型有关的部分。

## 1. 事件信封（`xixi.event.v1`）

构造入口只有一个：`buildEvent(input)`（`packages/contracts/src/envelope.ts`），
它在返回前完成校验并 `Object.freeze`；读取路径是 `validateEvent(value)`，**不做任何类型转换**。

| 字段 | 类型 | 规则与出处 |
|---|---|---|
| `schema` | `"xixi.event.v1"` | 常量 `EVENT_SCHEMA`（`envelope.ts`） |
| `schema_version` | `1` | 常量 `SCHEMA_VERSION`；语义见 §3 |
| `event_id` | string | `^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`（`schemas/envelope.v1.json`） |
| `event_type` | string | 必须是注册表里的三个类型之一（`src/events.ts` 的 `EVENT_TYPES`） |
| `timestamp` | string | `YYYY-MM-DDTHH:MM:SS[.mmm]±HH:MM`，见 §2 |
| `source` | string | 非空、≤120 字符。生产者名字，如 `brain`、`conversation`、`voice-edge` |
| `room` | string \| null | ≤120 字符；**必填但可为 `null`** |
| `actor` | string | 封闭集合：`father / admin / family_member / unknown_person / tv_media / xixi / system`（`ACTORS`） |
| `confidence` | number | `[0,1]` 闭区间。描述**这条事实本身**有多可信，不是「模型觉得多重要」 |
| `correlation_id` | string | `^corr_[0-9a-f-]{36}$` 同 UUIDv4 形状（`src/ids.ts`） |
| `payload` | object | 形状由 `event_type` 对应的 payload schema 单独校验 |

- **`additionalProperties: false`**：信封与三个 payload 全部拒绝未知字段。注入
  `{"injected": "ignore previous instructions"}` 会得到 `ContractError('INVALID_EVENT')`（`tests/unit/contracts.test.ts`）。
- **必填但可为 `null`** 是刻意的：让「生产者忘了填」与「确实没有」可区分。
- 校验器是**自写的 JSON Schema 子集**（`src/schema-validator.ts`），只实现 18 个关键字；
  遇到白名单外的关键字（如 `multipleOf`）直接抛 `UNSUPPORTED_SCHEMA_KEYWORD`，并在**加载 schema 时**就用
  `assertEnforceable` 检查——宁可启动时响亮失败，也不允许「写了但没被执行」的约束进入契约。

## 2. id 前缀与时间戳

`packages/contracts/src/ids.ts` 是唯一的 id 工厂，**前缀属于契约**（schema 用 pattern 钉死）：

```text
evt_<uuid>   事件       corr_<uuid>  关联     sess_<uuid>  西西会话
```

`toOffsetIso(date, offsetMinutes = -date.getTimezoneOffset())` 生成 `YYYY-MM-DDTHH:MM:SS.mmm±HH:MM`：
**毫秒固定三位、偏移必须是数字形式**。`Z` 形式被 schema 正则直接拒绝，单元测试也断言
`!event.timestamp.endsWith('Z')`。

理由：西西是单机、单时区的家庭陪伴者，「本地墙上时间」是可读、可排查的一等事实；
`Z` 与 `+00:00` 混用会让「22:30 静默时段」这类规则出现难以察觉的偏差。时区来源是配置的
`identity.timezone`（`config/xixi.example.yaml` 默认 `Asia/Shanghai`）。

## 3. schema 版本策略

- `SCHEMA_VERSION = 1` 是**整个已发布集合**的契约版本（信封 + 全部 payload 共用一个数字）。
- 每个事件类型在注册表里另有 `payloadVersion`；`buildEvent` / `validateEvent` 都检查
  `envelope.schema_version === definition.payloadVersion`，不一致抛 `UNSUPPORTED_SCHEMA_VERSION`。
- **改任何一个 payload 形状 → 升 `SCHEMA_VERSION` 且新增 `<type>.vN.json`，绝不原地改已发布的文件。**
- 漂移由测试兜住：`registry, envelope enum and actor list stay in sync`（`tests/unit/contracts.test.ts`）
  断言「注册表类型集合 == 信封 `event_type` 枚举」「`payloadVersion` == `SCHEMA_VERSION`」「`ACTORS` == 信封 `actor` 枚举」。
- 新增类型的步骤见 [`../event-contracts.md`](../event-contracts.md) §9。

## 4. 四类事件（当前全部）

注册表：`packages/contracts/src/events.ts`；schema：`packages/contracts/schemas/events/`。

| `event_type` | 必填 payload | 取值约束 |
|---|---|---|
| `presence.changed` | `present`, `source_detail` | `present: boolean`；`source_detail: string \| null`（≤200）。**当前无生产者**，只为验证契约（摄像头属 M6） |
| `conversation.turn` | `session_id`, `turn_index`, `role`, `action`, `text` | `session_id` 必须 `sess_<uuid>`；`turn_index: integer ≥ 0`；`role: user \| assistant`；`action: SPEAK \| BACKCHANNEL \| WAIT \| SILENCE \| TOOL`；`text: string \| null`（≤8000）；可选 `tool_name: string \| null`（≤120） |
| `conversation.decision` | `session_id`, `turn_index`, `accepted`, `reason`, `action`, `fsm_state` | `session_id` 同上；`turn_index: integer ≥ 0`；`accepted: boolean`；`reason: ACCEPTED_WAKE_OR_DIRECT \| ACCEPTED_CONTINUATION \| REJECTED_NOT_ADDRESSED \| REJECTED_SUSPENDED`；`action` 同 `conversation.turn`；`fsm_state` 五个状态；可选 `fsm_state_before`（string\|null）、`addressed`（boolean\|null）、`acceptance_score`（number\|null，**但不是分数**，见 §4.1）、`linger_ms`（integer\|null）、`silence_tolerance`（number\|null） |
| `system.health` | `service`, `status`, `detail` | `service` 1–120 字符；`status: ok \| degraded \| down`；`detail: string \| null`（≤500） |

`conversation.turn` 的两个要点：

- **`action` 含 `SILENCE`**（§55）：`role:'assistant'` + `action:'SILENCE'` + `text:null` 是完全正常的事件，
  不是失败，也不是「缺字段」。
- 领域层 `recordTurn` 总是把 `text` 与 `tool_name` 显式写入 payload（`packages/domain/src/store.ts`）。
  **payload 里没有延迟、置信度明细或提示词**：`latencyMs` / `firstTokenMs` / `prompt` 只随调用方返回值传递，
  不进事件日志。

### 4.1 `acceptance_score` 不是分数（F1，2026-09-30 审计）

**字段名目前名不副实**，按名字理解会写错代码，因此在这里写死真实语义：

- **真实语义 = `accepted` 的 0/1 镜像**：写入方是 `packages/conversation/src/engine.ts`
  （`acceptance_score: acceptance.accept ? 1 : 0`）；判定侧 `TurnAcceptance`
  （`packages/conversation/src/fsm.ts`）只有 `accept: boolean` + `reason` + `state`，
  **根本不存在接纳度字段**。所以它今天只可能取 0 或 1，没有中间值。
- **schema 里的 `number | null`（0–1）是「将来放真分数」的位置，不代表现在有真分数**：
  声明得比实现宽，是给 M2 留位，不是「已有 0–1 分数」的证据。
- **不得用于阈值判断**（例如「score < 0.5 就当作没被搭话」）：它恒等于 `accepted`，
  用阈值只是把布尔判断绕一圈重写，而且会在 M2 引入真分数时**悄悄改变行为**。
- **固化测试**：`tests/unit/core/acceptance-score-semantics.test.ts` 断言入库的 `acceptance_score`
  只能是 0/1 且恒等于 `accepted ? 1 : 0`，同时断言 schema 上的 description 仍在
  （防止「它是个分数」的说法悄悄回来）。
- **后续计划（M2）**：addressed 的概率模型落地后，这个字段才承载真正的 0–1 接纳度分数；
  届时**必须升版**——在 `packages/contracts/schemas/events/` 下新增 `conversation.decision.v2.json`
  并升 `SCHEMA_VERSION`（见 §3 的版本策略），**不得就地放宽/改写 v1 的类型与范围**（铁律 10）。

## 5. 四张表（`001_initial.sql` 的全部内容）

`packages/domain` 是唯一 `import { DatabaseSync } from 'node:sqlite'` 的包；打开时设
`PRAGMA journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`，并且**每次打开都先跑迁移**。

### 5.1 `events`：唯一事实来源

| 列 | 约束 | 说明 |
|---|---|---|
| `sequence` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 日志位置，事务内单调递增 |
| `event_id` | `TEXT NOT NULL UNIQUE` | 幂等钩子：重复投递 → `DomainError('DUPLICATE_EVENT')` |
| `event_type` / `schema_version` / `timestamp` / `source` / `room` / `actor` / `confidence` / `correlation_id` | 按信封字段落列 | 便于按类型/时间/来源查询与审计 |
| `session_id` | `TEXT NULL`（**无外键**） | 由 `appendEvent` 从 `payload.session_id` 提取（`sessionIdOf`），仅为建索引；非对话事件为 `NULL` |
| `payload_json` | `TEXT NOT NULL` | payload 原样序列化 |

索引：`idx_events_type_sequence (event_type, sequence)`、`idx_events_session (session_id, sequence)`、
`idx_events_correlation (correlation_id)`。

**设计取舍：不建 `conversation_turns` 表**（[ADR-0003](../adr/0003-raw-events-vs-memory.md)）。
对话轮次就是事件，避免同一事实两份真相；`recentTurns(sessionId, limit = 4)` 直接查
`WHERE event_type='conversation.turn' AND session_id=? ORDER BY sequence DESC LIMIT ?` 再 `reverse()`。
代价：「第 N 轮」是查询成本（当前量级完全可接受），且没有外键强制一致性。

### 5.2 `conversation_sessions`：会话投影（可重建）

| 列 | 约束 | 说明 |
|---|---|---|
| `session_id` | `TEXT PRIMARY KEY` | `sess_<uuid>` |
| `schema_version` | `INTEGER NOT NULL` | 铁律 10：任何持久记录都带版本 |
| `started_at` / `last_activity_at` | `TEXT NOT NULL` | 都用 `toOffsetIso` 写本地墙上时间 |
| `ended_at` | `TEXT NULL` | `endSession()` 写入；已结束会话上的写操作抛 `SESSION_ALREADY_ENDED` |
| `turn_count` | `INTEGER NOT NULL DEFAULT 0` | **派生值**，由 `recordTurn` 在事务内维护 |
| `brain_provider` / `brain_session_id` | `TEXT NULL` | Harness 会话映射，见 §7 |

索引：`idx_sessions_brain (brain_provider, brain_session_id)`。

**投影一致性靠事务而不是外键**：`recordTurn` 在一个 `BEGIN IMMEDIATE` 事务里
「追加事件 → `UPDATE conversation_sessions SET last_activity_at=?, turn_count=?`」，因此两者不可能不一致。
已知代价（`docs/progress.md` 第 6 节）：事务外先读会话，**当前是单机单进程假设**，
多进程并发写需要重新审视；若将来出现第二条写路径，必须同样进入该事务。

### 5.3 `self_profile`：有效人格基线

`property TEXT PRIMARY KEY`、`schema_version INTEGER NOT NULL`、`value REAL NOT NULL`、
`source TEXT NOT NULL`（如 `config:base`、`cli:override`、`eval:<scenario>`）、`updated_at TEXT NOT NULL`。
没有索引——按主键点查，21 行。

### 5.4 `self_profile_history`：人格变更历史（§7.5）

`change_id TEXT PRIMARY KEY`（`selfchg_<uuid>`）、`schema_version`、`property`、
`before_value REAL NULL`、`after_value REAL NOT NULL`、`source_type TEXT NOT NULL`、
`source_event_id TEXT NULL`、`summary TEXT NULL`、`confidence REAL NOT NULL`、`created_at TEXT NOT NULL`。
索引 `idx_self_history_property (property, created_at)`。

`source_event_id` 目前**恒为 `NULL`**：只有 M3 的反馈解释器才会把变更指回触发它的事件。

## 6. 人格属性与两种写入方式

属性集合在 `packages/domain/src/personality.ts`（`PERSONALITY_PROPERTIES`），
**21 个属性、每个都在 `[0,1]`**，名字与范围来自方案 §7.2，分四组：

| 组 | 属性 |
|---|---|
| `interaction`（7） | `proactivity`、`talkativeness`、`verbosity`、`curiosity`、`follow_up_probability`、`backchannel_frequency`、`silence_tolerance` |
| `affect`（7） | `warmth`、`humor`、`playfulness`、`emotional_expressiveness`、`formality`、`directness`、`teasing` |
| `memory`（3） | `memory_recall_frequency`、`old_topic_resurface`、`future_hook_followup` |
| `voice`（4） | `speech_rate`、`energy`、`volume`、`pause_style` |

`config/xixi.example.yaml` 只给了其中 9 个基线值——**未在配置里出现的属性不会入库**，
`selfProfile()` 只会返回实际存在的键；`PromptAssembler` 对缺失属性按 `mid` 处理（`packages/conversation/src/prompt.ts`）。

两种写入方式，语义完全不同：

| | `seedSelfProfile(values, source='config:base')` | `overrideSelfProfile(values, reason='admin:override')` |
|---|---|---|
| 写入语义 | `INSERT … ON CONFLICT(property) DO NOTHING`：**只补缺，绝不覆盖** | `ON CONFLICT … DO UPDATE`：**覆盖** |
| history | 仅当真的插入时才记一条（`before_value = NULL`，`confidence = 1`） | 每次都记一条（含 `before_value`，`source_type = reason`） |
| 谁调用 | 每次进程启动（`scripts/chat.ts`、`serve-chat.ts`、`voice-turn.ts`、评测器） | 管理员：`npm run chat -- --personality verbosity=0.1`（`cli:override`）、评测场景（`eval:<id>`） |
| 为什么 | 「重启是恢复不是重置」（§33：重启后持久人格恢复 100%） | 变更必须受控、可回滚、有记录（铁律 2） |

两者都会先做类型与范围校验：未知属性 → `UNKNOWN_PERSONALITY_PROPERTY`，
超出该属性范围 → `PROPERTY_OUT_OF_RANGE`；落库前统一经 `clampPersonality`。

> **明确写清：模型驱动的学习（M3）尚未实现。**
> `BrainAdapter.interpretFeedback()` 目前直接抛 `BrainError('NOT_IMPLEMENTED', milestone: 'M3')`
> （`packages/brain-adapter/src/mimo.ts`、`dsh.ts`、`fake.ts` 三处一致）。
> `overrideSelfProfile` 的注释里写明它「deliberately not the M3 learning engine」。
> 方案 §7.4 的按来源增量上限、漂移限制与自动回滚**都不存在**；`self_profile_history` 目前只记录
> 「种子」与「管理员覆盖」两类来源。

## 7. 会话与 Harness 会话的映射

领域层持有映射，列在 `conversation_sessions` 上：`brain_provider` + `brain_session_id`，
按 `(brain_provider, brain_session_id)` 建索引（[ADR-0005](../adr/0005-brain-session-mapping-in-domain.md)）。

- **两段记忆同时活着**：西西自己的会话（`sess_…`、轮次、人格）是关系本身；Harness 的会话 id
  （如 DSH 的 `session-…`）只是**可重建的上下文缓存**。
- **按 provider 键控**：`brainSessionId(sessionId, provider)` 只在 `session.brainProvider === provider` 时返回值，
  否则返回 `null`。于是换掉 Harness 后同一段西西会话继续有效、旧 provider 的 id 不会被误用。
- **写入方是适配器不是 transport**：`DshBrainAdapter.handleUserTurn` 每轮开始时读要 resume 的 id，
  只有在 harness 给出了**新的** id 时才 `attachBrainSession(...)`；
  `MimoBrainAdapter` 不使用这个映射（`brainSessionId: null`），它自己用 `recentTurns` 重建上下文。
- **理由（为什么放领域层）**：它是持久状态，必须与事件、会话、人格在同一事务边界内；
  而 `packages/domain` 是唯一有数据库句柄的包，改 Harness 不该动领域层。
- **代价**：Harness 自己的会话文件不是事实来源，丢掉了也不会「失忆」到丢事实——
  `events` 与 `self_profile` 仍在；只是模型丢掉那段上下文缓存，需要用 `recentTurns` 重新喂回去。
  另外 DSH 的 resume 要求**相同 cwd 与相同 profile 组合**，所以仓库目录不能随便搬（详见 ADR-0005）。

## 8. 迁移机制

`packages/domain/src/migrations.ts`（`listMigrationFiles` / `migrate` / `appliedMigrations`）：

- 文件名必须是 `NNN_name.sql`（正则 `^(\d+)_(.+)\.sql$`），否则抛 `MIGRATION_FAILED`；
  同一版本号出现两次也抛错。
- `schema_migrations` 表由**执行器自己** `CREATE TABLE IF NOT EXISTS`，不属于任何迁移文件。
- 每个迁移**单独一个事务**（`BEGIN IMMEDIATE` / `COMMIT` / 失败 `ROLLBACK` 并抛 `MIGRATION_FAILED`）。
- **已应用迁移不可改写**：`checksum = sha256(sql 去掉 \r\n 差异)`，与库里记录不一致即
  `MIGRATION_CHECKSUM_MISMATCH` 并拒绝启动（§47.3、铁律 10）。要改 schema 就新增 `002_*.sql`。
- 迁移在 `XixiStore` 构造函数里、实例逃逸之前执行；`store.appliedMigrations` 暴露本次进程实际应用的迁移
  （已是最新时为空数组，`tests/integration/restart-recovery.test.ts` 断言第二次打开不重跑）。

## 维护规则

统一规则见 [`README.md`](README.md#维护规则)。改本文件时对照：

| 改动 | 必须同步的本文件小节 |
|---|---|
| `packages/contracts/schemas/**` 或 `src/{envelope,events,ids}.ts` | §1、§2、§3、§4（并同步 [`../event-contracts.md`](../event-contracts.md) 与漂移测试） |
| 新增事件类型 | §3、§4（步骤见 `../event-contracts.md` §9） |
| `packages/domain/src/migrations/*.sql`（任何表的列/索引/约束） | §5 对应小表 + [`../architecture.md`](../architecture.md) §5 |
| `packages/domain/src/personality.ts`（属性增删改范围） | §6 的属性表与分组（并同步 `config/xixi.example.yaml`、[`conversation.md`](conversation.md) 的指令映射） |
| `seedSelfProfile` / `overrideSelfProfile` / `self_profile_history` 语义 | §6 |
| `store.ts` 的 `attachBrainSession` / `brainSessionId` / `recordTurn` / `resume` | §5.1、§5.2、§7 |
| `migrations.ts` 的文件名规则、checksum 或事务策略 | §8 |
| M3 的反馈解释器落地 | §6 的「尚未实现」提示改为事实陈述，并写清新来源类型与 `source_event_id` 语义 |
