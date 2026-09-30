# ADR-0004：PoC 阶段用进程内直接写入替代事件总线（MQTT 推迟）

- 状态：已接受（2026-09-29）
- 相关：[`docs/event-contracts.md`](../event-contracts.md)、ADR-0003、
  [`packages/contracts`](../../packages/contracts)、`AGENTS.md` 第 4 节（环境事实）
- 上游依据：《方案》§23（Event Bus 与事件契约）、§21.5（MQTT 不可用）、§24（`infra/mosquitto/`）

## Context

《方案》§23 推荐 MQTT 作为跨服务实时总线，并给了 topic 示例
（`xixi/v1/presence/changed` 等）与统一 envelope（§23.2）。
但本机环境事实是：**Docker 未安装**，没有 mosquitto 或任何 broker 可用
（`AGENTS.md` 第 4 节、`docs/progress.md` §2.1）。`infra/docker-compose.yml` 里的 compose 方案在 PoC 阶段跑不起来。
另外 `AGENTS.md` 第 3 节要求「不要为了跑一个实验引入必须常驻的后台服务」。

同时，M0 只有**一个进程、一个 SQLite、一条链路**（文字 → DSH → MiMo → 回答），
根本没有第二个生产者或消费者需要被解耦。此时引入 broker 只会增加一个必须常驻、且这台易崩机器上难以恢复的组件。

## Decision

1. **M0 不引入 MQTT broker。** 事件由调用方在**同一进程内**直接落库：
   `XixiStore.appendEvent(event)` / `recordTurn(...)`（见
   [`packages/domain/src/store.ts`](../../packages/domain/src/store.ts)）。
   全仓库没有任何 `EventBus` / `publish` / `subscribe` 实现——这一点必须如实承认，不能写成「已经有了进程内总线」。
2. **稳定的部分是 envelope 契约，不是传输。** `packages/contracts` 定义
   `xixi.event.v1`（`EVENT_SCHEMA`）、`SCHEMA_VERSION`、事件类型注册表与
   fail-closed 校验器（`buildEvent` / `validateEvent`）。
   生产者的职责是**构造出满足契约的事件**，消费者的职责是**校验后再使用**；
   两者都不应知道自己拿到的字节来自函数调用还是 MQTT topic。
3. **换 MQTT 的改法**：新增一个 event bus 实现（发布/订阅 + 至少一次投递），
   topic 命名按 §23.1；生产者改为 `publish(topic, event)`、消费者改为 `subscribe` 后
   `validateEvent(raw)`（校验函数已存在且不依赖传输）。
   `events.event_id UNIQUE` 已经能挡住重复投递造成的重复事实
   （重复时 `appendEvent` 抛 `DomainError('DUPLICATE_EVENT')`），这正是「至少一次」投递所需要的幂等钩子。
4. **不做的事**：不写 `infra/` 下的空 compose 文件来假装有 broker；不在 M0 实现离线缓冲与
   WorldState stale 语义（§21.5）——那是出现第二个服务之后的问题。

## Alternatives

| 方案 | 为什么没选 |
|---|---|
| 按 §23 起一个本地 mosquitto（Docker 或原生） | 本机没有 Docker；原生 broker 会引入一个必须常驻、崩溃后需手动恢复的组件，与 `AGENTS.md` 第 3 节冲突 |
| 用 SQLite 表当日志队列跨进程传递 | 等价于在一个进程里模拟 broker 且没有真实消费者；会把 `events` 的语义污染成「消息队列」 |
| 先写一套自研 EventBus 抽象，将来适配 MQTT | 在只有一个进程时是纯粹的想象性抽象；契约（envelope）已经是真正的 seam，抽象留给出现第二个服务时再抽 |
| 直接让各模块 `import` 彼此的 `record*` 方法 | 已被现方案覆盖：`XixiStore` 就是当前的统一写入口，且 `packages/domain` 是唯一写 SQLite 的包 |

## Consequences

- **正向**：零额外依赖、零常驻服务；`npm test` 可以在断网与断电恢复后立刻跑（36 项离线用例）。
  事件契约在 M0 就被真实使用并被测试覆盖（漂移检查、fail-closed、版本一致性），
  而不是等到接入 broker 时才第一次被使用。
- **代价（必须记录）**：当前是**单机单进程假设**。`recordTurn` 在事务外先读会话，
  多进程并发写需要重新审视（`docs/progress.md` 第 6 节已列为已知限制）。
- **代价**：没有跨服务实时分发能力，因此 §21.5 的「Edge 缓冲 / Brain 标记 WorldState stale」在 M0 无意义，
  也不能声称已实现。M1 的 voice-edge（Python）会第一次制造出真正的跨进程边界 ——
  届时要么走本地子进程 + NDJSON（沿用 `CliDshTransport` 的思路），要么补一个 broker；
  这个决定显式推迟，不在这里预先绑定。
- **受保护的部分**：无论将来选哪种传输，`xixi.event.v1` 的 envelope 字段、id 正则、时间戳规则与
  schema 版本语义都不变（详见 `docs/event-contracts.md`）；换传输**不允许**顺带改契约。
