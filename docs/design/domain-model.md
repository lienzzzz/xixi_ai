# 领域模型：事件、持久化与人格

> 最后更新：2026-10-03（第五轮收口：§5.5 补迁移 005 的 `mood_state` / `mood_history` 与「心情不在人格三层里」）
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

## 4. 事件类型（当前 **6** 类）

注册表：`packages/contracts/src/events.ts`；schema：`packages/contracts/schemas/events/`。

| `event_type` | 必填 payload | 取值约束 |
|---|---|---|
| `presence.changed` | `present`, `source_detail` | `present: boolean`；`source_detail: string \| null`（≤200）。**生产者是 M6 感知边**（`recordPresenceChanged`，摄像头在 `services/perception-edge` 起子进程跑） |
| `conversation.turn` | `session_id`, `turn_index`, `role`, `action`, `text` | `session_id` 必须 `sess_<uuid>`；`turn_index: integer ≥ 0`；`role: user \| assistant`；`action: SPEAK \| BACKCHANNEL \| WAIT \| SILENCE \| TOOL`；`text: string \| null`（≤8000）；可选 `tool_name: string \| null`（≤120） |
| `conversation.decision` | `session_id`, `turn_index`, `accepted`, `reason`, `action`, `fsm_state` | `session_id` 同上；`turn_index: integer ≥ 0`；`accepted: boolean`；`reason: ACCEPTED_WAKE_OR_DIRECT \| ACCEPTED_CONTINUATION \| REJECTED_NOT_ADDRESSED \| REJECTED_SUSPENDED`；`action` 同 `conversation.turn`；`fsm_state` 五个状态；可选 `fsm_state_before`（string\|null）、`addressed`（boolean\|null）、`acceptance_score`（number\|null，**但不是分数**，见 §4.1）、`linger_ms`（integer\|null）、`silence_tolerance`（number\|null） |
| `proactive.decision` | `candidate_id`, `trigger`, `speak`, `reason_code` | 其余字段**全部可选**（同一事件类型内新增字段一律可选，旧事件照旧校验）：`session_id`、`score` / `threshold`（number\|null，0–1）、`recommendation`、`primary_signal`、`signals`（9 个 0–1 信号）、`basis`（≤12 条中文依据）、`decided_by`（`program` / `model`）、`model_reason_code`（白名单码，≤40）、`model_consulted`、`topic_ref`、`intent`、`delivered`。**只存理由码与分数，不存用户原话与模型私有推理**（铁律 5） |
| `open_thread.changed` | `thread_id`, `status`, `summary` | `thread_id` 形如 `thread_…`；`status: candidate \| offered \| engaged \| resolved \| snoozed \| exhausted`；可选 `previous_status`、`subject`、`follow_after`、`expire_at`、`follow_up_hint`、`importance`、`attempts`、`source_event_id`、`note`。写这条事件与写 `open_threads` 表在**同一事务**里，所以表可被日志重建（pack Phase 3） |
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

## 5. `001_initial.sql` 的四张表（其余表见 §5.5）

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

### 5.5 `002` / `003` / `004` / `005` 新增的表

字段级细节以迁移文件为准（[`002_world_state.sql`](../../packages/domain/src/migrations/002_world_state.sql)、
[`003_open_threads.sql`](../../packages/domain/src/migrations/003_open_threads.sql)、
[`004_memory.sql`](../../packages/domain/src/migrations/004_memory.sql)、
[`005_mood.sql`](../../packages/domain/src/migrations/005_mood.sql)）：

| 表 | 迁移 | 角色 | 关键列 |
|---|---|---|---|
| `world_state` | 002 | 当前状态投影（M6 起有写入方） | `key` PK、`schema_version`、`value`、`source`、`updated_at`、`confidence`、`ttl_seconds` |
| `open_threads` | 003 | 未完话题的状态机 + **可重建投影**（pack Phase 3） | `thread_id` PK、`summary`、`subject`、`status`（六个状态）、`created_at`、`updated_at`、`follow_after`、`expire_at`、`follow_up_hint`、`importance`、`attempts`、`last_offered_at`、`source_event_id`、`note`；索引 `(status, follow_after)`、`updated_at` |
| `episodic_memory` | 004 | 发生过的事（明确的纠正、记下来的一件事） | `memory_id` PK、`occurred_at`、`summary`、`kind`、`source_type`、`source_event_id`、`session_id`、`importance`、`confidence`；索引 `occurred_at`、`(kind, occurred_at)` |
| `semantic_memory` | 004 | 稳定的事实与偏好 | `memory_id` PK、`property`、`statement`、`source_type`、`source_event_id`、`confidence`；索引 `property` |
| `relationship_notes` | 004 | 我们怎么相处 | `note_id` PK、`aspect`、`note`、`source_type`、`source_event_id`、`confidence`；索引 `aspect` |
| `self_profile_learned` | 004 | 学习到的**累计偏移**（与 `self_profile` 基线分开） | `property` PK、`delta`、`source_type`（`learned:…`）、`evidence`、`confidence`、`updated_at` |
| `session_overrides` | 004 | **只对 `valid_day` 这一本地自然日生效**的覆盖（次日自动失效） | `override_id` PK、`session_id`、`property`、`delta`、`reason`、`source_type`、`valid_day`；索引 `(valid_day, property)` |
| `mood_state` | 005 | **当前心情（一行）**——有界、会回落、由事件演化（第五轮） | `key` PK（`'mood.now'`）、`schema_version`、`valence` / `energy`（都落 `[0,1]`）、`evidence_json`（每个信号出现过几次）、`last_beat_at`、`cursor_json`（已吸收到哪条 `events.sequence`）、`source` / `summary` / `updated_at` |
| `mood_history` | 005 | 心情的**变更记录**（每次真的变了才写一行；复位也留一行 `reset=true`） | `change_id` PK、`before_*` / `after_*`、`delta_*`、`reset`、`signals_json`、`signal_count`、`dropped_count`、`note`、`created_at` |

共同点：**都是推导，不是事实**——每行带 `source_event_id` 指回 `conversation.turn`（铁律 4）；
记忆写入**不新增事件类型**（可以按 `source_event_id` 重放重建），唯一的例外是 `open_threads`：
它的每一次状态变化同时写一条 `open_thread.changed` 事件（表与日志同事务，表可被日志重建）。
**心情也不新增事件类型**：它从 `conversation.turn` / `proactive.decision` / `presence.changed` 按确定性规则重放重建
（边界来自代码里的 `clampMood`，不是库约束；口径见 [`../adr/0013`](../adr/0013-bounded-mood-state.md)）。
有效人格 = `self_profile`（基线）+ `self_profile_learned`（学习偏移）+ `session_overrides`（当天覆盖）三层相加；
**心情不在这三层里**——它是短期的、自己回落的，权重远小于人格（语气 ±6%、主动性软偏移 ±0.03）。
可查看/编辑/删除目前**只有领域 API**（`MemoryStore` / `SelfModel` / `OpenThreadStore` / `XixiStore.mood()` 系列），没有 UI。

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

两条经常被问到的推论（README 的快速开始就靠它们）：

- **同一入口下跨重启有效**：两种写入都落该入口自己的 SQLite 文件里的 `self_profile` 表，所以
  `npm run chat -- --personality …` 的效果**不是命令行里的临时开关**——它写进库，同一个入口重启后还在。
  **它不跨入口**：四个入口各自打开自己的库，`--personality` 只改它当时写的那一个
  （`scripts/chat.ts` → `data/chat/`、`scripts/serve-chat.ts` → `data/web-chat/`、`scripts/voice-turn.ts` → `data/voice/`、
  `scripts/field-test.ts` → `data/field-test/`；核对：`git grep -n "openXixiStore" -- scripts`）。
  **库路径可被覆盖**（测试与并行实例用）：`chat` 认 `XIXI_CHAT_DATA_DIR`、试用页认 `XIXI_WEB_DATA_DIR`
  （`git grep -n "XIXI_CHAT_DATA_DIR\|XIXI_WEB_DATA_DIR" -- scripts`）；
  现场测试控制台的库路径由两个 CLI 开关决定：`--data-dir <目录>`（控制台自己的库：`self_profile` / 事件日志，
  默认 `data/field-test`）与 `--presence-data-dir <目录>`（在场状态，默认 `data`）。
  例：`node scripts/field-test.ts --offline --no-open --data-dir data/field-test-alt --presence-data-dir data/presence-alt`
  （实测：库文件 `xixi.sqlite` 会落在指定目录里）。
  **不认识的参数会中文报错并以 exit 2 结束**（消息里列出全部可用参数），不再静默忽略。
  核对方式：`node scripts/field-test.ts --help`——**本节以它的实际输出为准**；若某个开关在 `--help` 里没有列出
  （老版本），回退办法是直接挪目录（`Move-Item data\field-test data\field-test-old`，可逆），
  或在代码里传 `createFieldServer` 的 `dataDir` / `presenceDataDir` 选项（自检与测试就是这么指向临时库的）。
  另注意 t63 修的是 **HTTP 请求体里的未知字段**（`applyProactiveSettingsPatch` 白名单给具名中文拒绝），
  与命令行未知参数是两件事，别混为一谈。
  `voice-turn` 固定 `data/voice`。覆盖只改「哪个文件」，**不改变「不跨入口」这条结论**。
  也就是说「在 chat 里改过人格，打开试用页也是新人格」**不成立**——要么在另一个入口再覆盖一次，
  要么把 `config/xixi.example.yaml` 的基线改掉再让各入口 `seedSelfProfile` 补上（见 §5.3 `self_profile` 与本节上面的两张写入方式表）。
  > 修正记录：这条推论原写作「换入口（chat / web / voice-turn）都还在」，是错的——四个入口用四个不同的数据库文件，
  > 覆盖的可见范围止于写入它的那个入口。
- **回基线要再覆盖一次**：没有「撤销」命令。`seedSelfProfile` 是 `DO NOTHING`（只补缺、绝不覆盖已有的行），
  所以想让某个属性回到 `config:base` 的基线值，必须**再用 `--personality` 显式写回那个值**；
  想查/回滚逐条变更则读 `self_profile_history`（每条覆盖都带 `before_value` 与 `source_type`）。

> **学习已经有两条在跑的路，都不是「读模型自由文本」**（pack Phase 4，别再写成「M3 尚未实现」）：
> 确定性侧 `interpretFeedback`（显式规则，权重 1.0）与 `interpretInference`（**只认** `PROACTIVE_MODEL_REASON_CODES`
> 白名单码，权重 0.4）由 `TurnMemoryExtractor.runJob` 调用，**权重在 `SelfModel.learn` 里按 `sourceType` 只乘一次**；
> `self_profile_history.source_type` 记 `learned:explicit_correction` / `learned:model_inference`，`confidence` 记同一个权重。
> 方案 §7.4 的**按来源单日上限与漂移上限都已实现**（`dailyLimitExplicit` / `dailyLimitInferred` / `driftLimit`）；
> **回滚是显式动作**（`SelfModel.rollback(property)` 清零学习偏移并写一条 `learned:rollback`），**没有自动回滚**。
> `BrainAdapter.interpretFeedback()`（模型侧那个结构化反馈接口）**仍抛 `NOT_IMPLEMENTED(M3)`**——
> 它与上面这条确定性管线**不是同一个东西**，别混为一谈。

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

## 7. V0.3 P0-B：canonical store 与感知单写者

- **一个 household 一个库**：`packages/domain/src/store.ts` 的 `CANONICAL_DATA_DIR = 'data/xixi'`、
  `CANONICAL_DATA_DIR_ENV = 'XIXI_DATA_DIR'`、`resolveCanonicalDataDir()`、`CANONICAL_STORE_ENTRIES`；
  优先级＝**显式参数 > `XIXI_DATA_DIR` > 单入口旧变量（`XIXI_CHAT_DATA_DIR` / `XIXI_WEB_DATA_DIR` / `XIXI_VOICE_DATA_DIR` / `XIXI_DEMO_*`）> 默认**。
- **测试与评测不碰它**：`NODE_TEST_CONTEXT` / `NODE_ENV=test` 下默认库落进程临时目录；评测脚本本来就 `mkdtempSync`。
- **感知单写者**：`services/perception-edge` 只检测并把事件**打印到 stdout**（不再拿 `--db` / `--append`）；
  `packages/runtime/src/perception-ingest.ts` 的 `ingestPerceptionLine` 校验后交给 `XixiStore.appendPresenceEvent`，
  **事件与 `world_state` 投影同一事务**，且都在主库。旧库 `data/xixi.sqlite` 未被覆盖（时间戳仍是 2026-10-03）。
- **默认行为**：`voice-turn` 是测量工具，**默认连 household 库**，`--isolated-store` 才用 `data/voice`；
  数据目录与 `--out` 无关，音频仍只写 `--out` / `data/voice/bench`，事件日志里没有原始音视频。
- 逐条实测（四个入口同库的硬证据、Gate 数字）见 [docs/progress-v03.md](../progress-v03.md) 的 P0 段。
