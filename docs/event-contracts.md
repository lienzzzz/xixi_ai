# 事件契约（`xixi.event.v1`）

> 权威实现：[`packages/contracts`](../packages/contracts)。本文描述**已经实现并被测试覆盖**的规则。
> 上游依据：《方案》§23.2（统一 Envelope）、§19.1（Actor）、§47.3（Schema Version）、§55（沉默是一等输出）。
> 相关：[`architecture.md`](architecture.md)、[`ADR-0003`](adr/0003-raw-events-vs-memory.md)、[`ADR-0004`](adr/0004-in-process-event-bus-for-poc.md)。

## 1. 信封（Envelope）

每个事件都是 `xixi.event.v1`。字段定义在
[`schemas/envelope.v1.json`](../packages/contracts/schemas/envelope.v1.json)，
TS 类型在 [`src/envelope.ts`](../packages/contracts/src/envelope.ts)。

| 字段 | 类型 | 规则 |
|---|---|---|
| `schema` | string | **常量** `"xixi.event.v1"`（`EVENT_SCHEMA`）。不是自由文本 |
| `schema_version` | number | **常量** `1`（`SCHEMA_VERSION`）；语义见 §3 |
| `event_id` | string | 正则 `^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| `event_type` | string | 必须是注册表里的三个类型之一（enum 与注册表有漂移测试） |
| `timestamp` | string | 正则 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?[+-]\d{2}:\d{2}$`，见 §4 |
| `source` | string | 非空、≤120 字符。生产者的名字，如 `brain-dsh` / `simulator.poc` |
| `room` | string \| null | ≤120 字符；未知或不属于任何房间时为 `null` |
| `actor` | string | 必须是 7 个 actor 之一，见 §6 |
| `confidence` | number | `[0, 1]` 闭区间，见 §5 |
| `correlation_id` | string | 正则 `^corr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| `payload` | object | 形状由 `event_type` 对应的 payload schema 单独校验 |

**`additionalProperties: false`**：信封和全部 payload 都拒绝未知字段。
注入一个 `{"injected": "ignore previous instructions"}` 会得到
`ContractError('INVALID_EVENT')` 并指出 `unexpected property "injected"`（已有单元测试）。
这不是洁癖：外部内容一律视为不可信数据，契约层是拒绝夹带的第一道闸门。

**必填但可为 `null`**：`room` 与部分 payload 字段必须**在场**，不能靠省略表达「没有」。
这是刻意的「显式优于省略」——省略会让「生产者忘了填」和「确实没有」无法区分。

## 2. 身份与时间由构造器统一生成

`buildEvent(input)` 是唯一的构造入口：

- 省略 `event_id` / `correlation_id` → 用 `newEventId()` / `newCorrelationId()`（`ids.ts`，前缀 + UUIDv4）；
- 省略 `timestamp` → 用 `toOffsetIso()`；
- 全流程 **validate before return**：`assertSchema(ENVELOPE_SCHEMA…)` 之后再按注册表校验 payload，
  任一步失败抛 `ContractError`，**不返回未校验的对象**；
- 成功后 `Object.freeze(envelope)`。
- 读取路径是 `validateEvent(value)`：校验已序列化的事件（例如从库或总线读回），**不做任何类型转换**；
  `isEventEnvelope(value)` 是不抛异常的便捷版本（用于边界处的陌生输入）。

## 3. `schema_version` 的语义

- `SCHEMA_VERSION = 1` 是**整个已发布集合**的契约版本（信封 + 全部 payload 共用一个数字）。
- 每个事件类型在注册表里各有一个 `payloadVersion`；`buildEvent` / `validateEvent` 都会检查
  **`envelope.schema_version === definition.payloadVersion`**，不一致抛
  `UNSUPPORTED_SCHEMA_VERSION`（单元测试：传 `schema_version: 2` 被拒）。
- **改动任何一个 payload 形状，都升 `SCHEMA_VERSION` 并新增一个 `<type>.vN.json` 文件，
  绝不原地修改已发布的文件。** 信封里 `schema_version` 的 `const: 1` 与枚举一起构成漂移检查点：
  单元测试 `registry, envelope enum and actor list stay in sync` 会断言
  注册表类型集合 == 信封 `event_type` 枚举、`payloadVersion` == `SCHEMA_VERSION`、
  `ACTORS` == 信封 `actor` 枚举。任何一处忘了同步，`npm test` 就会失败。
- 未知类型抛 `UNSUPPORTED_EVENT_TYPE`（消息里列出已知类型）。

## 4. 时间戳：必须带数字偏移，不接受 `Z`

`toOffsetIso(date, offsetMinutes = -date.getTimezoneOffset())` 生成
`YYYY-MM-DDTHH:MM:SS.mmm±HH:MM`，**毫秒固定三位、偏移固定数字形式**。
`Z` 形式（UTC 设计器）被 schema 正则直接拒绝，单元测试也会断言
`!event.timestamp.endsWith('Z')`。

原因：西西是单机、单时区的家庭陪伴者，「本地墙上时间」是可读、可排查的一等事实；
`Z` 与 `+00:00` 混用会让「22:30 静默时段」这类规则出现难以察觉的偏差。
时区来源是配置的 `identity.timezone`（默认 `Asia/Shanghai`）。

## 5. `confidence`：`[0, 1]`，不是百分比

- 闭区间校验；`1.4` 直接抛 `INVALID_EVENT`。
- 它描述**这条事实本身有多可信**（例如模拟器产的 presence 事件给 0.9），
  不是「模型觉得这句话有多重要」。
- 铁律 4 的「显式用户纠正权重高于模型推断」在将来靠 confidence + `source_type` 表达，
  当前只有 `events.confidence` 与 `self_profile_history.confidence` 两处落库。

## 6. Actor 列表（§19.1）

```
father | admin | family_member | unknown_person | tv_media | xixi | system
```

- `xixi` = 助手侧自己产生的（例如西西的回答）；`system` = 服务/健康类事件。
- 这张表是**封闭**的：`actor: 'neighbour'` 会被拒。
- 由 `ACTORS` 导出为只读元组，并与信封枚举做漂移检查。
- 《方案》§19.3 的提醒同样适用于此：声纹（`father` 的判定来源）不等于高安全身份认证，
  高风险动作不在 PoC 范围（铁律 7）。

## 7. 三个事件类型与必填 payload

注册表：[`src/events.ts`](../packages/contracts/src/events.ts) 的 `EVENT_TYPES`；
schema 文件在 `packages/contracts/schemas/events/`。

| `event_type` | payload 文件 | 必填 | 取值约束 |
|---|---|---|---|
| `presence.changed` | `presence.changed.v1.json` | `present`, `source_detail` | `present: boolean`；`source_detail: string \| null`（≤200）。M0 只用于契约验证，摄像头属 M6 |
| `conversation.turn` | `conversation.turn.v1.json` | `session_id`, `turn_index`, `role`, `action`, `text` | `session_id` 正则 `^sess_<uuid>$`；`turn_index: integer ≥ 0`；`role: "user" \| "assistant"`；`action: SPEAK \| BACKCHANNEL \| WAIT \| SILENCE \| TOOL`；`text: string \| null`（≤8000）；可选 `tool_name: string \| null`（≤120） |
| `system.health` | `system.health.v1.json` | `service`, `status`, `detail` | `service`: 1–120 字符；`status: "ok" \| "degraded" \| "down"`；`detail: string \| null`（≤500） |

`conversation.turn` 的两个要点：

- **`action` 含 `SILENCE`**（§55）：沉默是合法的一等输出，不是失败。
  因此 `text` 允许为 `null`——`role:'assistant'` + `action:'SILENCE'` + `text:null` 是完全正常的事件。
- **`text` / `tool_name` 必须在场**（可为 `null`）。领域层的 `recordTurn`
  总是把 `text` 与 `tool_name` 显式写入 payload（见 `packages/domain/src/store.ts`）。

`system.health` 有便捷方法 `XixiStore.recordHealth(service, status, detail)`；
`scripts/verify-m0.ts` 每轮都会用它追加一条 `brain-dsh / ok / M0 <phase> turn completed in … ms`。

## 8. 校验器是 fail-closed 的

[`src/schema-validator.ts`](../packages/contracts/src/schema-validator.ts) 是一个**自写的
JSON Schema 2020-12 子集**校验器，只实现 `SUPPORTED_KEYWORDS` 里列出的 18 个关键字：

```
$schema $id title description type const enum properties required
additionalProperties items minLength maxLength pattern minimum maximum minItems maxItems
```

规则是反过来的：**遇到任何不在白名单里的关键字，直接抛
`ContractError('UNSUPPORTED_SCHEMA_KEYWORD')`**，而不是忽略它。

- `assertEnforceable(schema, path)` 在**加载 schema 时**（`loadSchema` → `define` → 模块初始化）
  递归走一遍，把问题提前到进程启动，而不是等第一个事件到达。
- 单元测试 `the validator fails closed on a keyword it cannot enforce` 用
  `{ type: 'object', properties: { a: { type: 'string', multipleOf: 2 } } }` 断言必然抛错；
  另一个测试遍历 `schemas/**.json` 断言**所有已提交 schema 只用受支持关键字**。

后果（有意为之）：契约不可能被「悄悄放松」。如果有人写了 `multipleOf` / `format` / `oneOf`，
测试会**响亮失败**，要求要么改成白名单里的表达，要么实现该校验器——而不是让约束看起来存在却无人执行。

## 9. 如何新增一个事件类型

1. **新增 payload 文件**：`packages/contracts/schemas/events/<type>.vN.json`
   （例如 `memory.changed.v1.json`）。只使用 §8 的白名单关键字；
   字段宁可 `["string","null"]` 显式声明，也不要让字段消失。
2. **注册它**：在 [`src/events.ts`](../packages/contracts/src/events.ts) 的 `EVENT_TYPES` 里
   `define('<type>', N, '<描述>', 'events/<type>.vN.json')`。`N` 是该 payload 的版本。
3. **同步信封枚举**：把 `<type>` 加进 `schemas/envelope.v1.json` 的
   `event_type.enum`；若这次改动改变了任何 payload 形状，同时把 `schema_version` 的 `const`
   与 `src/envelope.ts` 的 `SCHEMA_VERSION` 一起升到新值（并更新所有已注册类型的 `payloadVersion`）。
4. **跑 `npm test`**：漂移测试会替你检查「注册表 / 信封枚举 / actor 列表 / payloadVersion」是否一致；
   `unknown event type` 的失败信息里会列出所有已知类型，方便排查拼写。
5. **绝不修改已发布的 `<type>.v1.json`**。要改形状就写 `v2.json` 并把注册表指向它；
   旧消费者读旧事件仍然按旧 schema 校验，因为 schema 文件与版本号都还在。
   这与数据库迁移同一条规矩（铁律 10）：只新增、不改写。

## 10. 存储与查询

事件落在 `events` 表（[`001_initial.sql`](../packages/domain/src/migrations/001_initial.sql)）：

```text
sequence INTEGER PRIMARY KEY AUTOINCREMENT   -- 日志位置
event_id TEXT NOT NULL UNIQUE                -- 幂等钩子：重复投递 → DomainError('DUPLICATE_EVENT')
event_type / schema_version / timestamp / source / room / actor / confidence / correlation_id
session_id TEXT                              -- 由 appendEvent 从 payload.session_id 提取，便于索引
payload_json TEXT NOT NULL                   -- payload 原样序列化
```

索引：`idx_events_type_sequence (event_type, sequence)`、
`idx_events_session (session_id, sequence)`、`idx_events_correlation (correlation_id)`。

- **写入**：`XixiStore.appendEvent(event)` 先 `validateEvent(event)`（读取路径的同一把尺子），
  再插入并返回带 `sequence` 的 `StoredEvent`。
- **读取**：`XixiStore.readEvents({ limit, sinceSequence, type, sessionId })`，
  按 `sequence ASC` 返回；默认 `limit = 100`。
- **轮次查询**：`recentTurns(sessionId, limit = 4)` 直接查 `conversation.turn` 事件而不是查轮次表
  （没有轮次表，见 [ADR-0003](adr/0003-raw-events-vs-memory.md)）。
- **`session_id` 列是可选的**：非对话类事件（`presence.changed` / `system.health`）它就是 `NULL`。

写路径全部发生在事务里（`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`），
所以「追加事件」与「更新 `conversation_sessions` 投影」不可能一半成功一半失败。
