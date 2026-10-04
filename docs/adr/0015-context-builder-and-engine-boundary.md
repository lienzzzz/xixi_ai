# ADR-0015：ContextBuilder 与 ConversationEngine 的边界（谁装配上下文、谁做决定）

- 状态：已采纳（2026-10-04，V0.3 P1-a t12；边界细节补于 P0+P1 收口 t16）
- 相关：铁律 1（模型只做判断，规则与状态由程序负责）、铁律 4（Raw Event 与 Memory 分开）、
  铁律 5（只存 reason_code 与分数）、[ADR-0003](0003-raw-events-vs-memory.md)、
  [ADR-0016](0016-memory-status-state-machine.md)、pack `E:\xixi_v03_actual_code_pack` 的 `02_MEMORY_CONTEXT.md` §1、
  `packages/context/src/context-builder.ts`、`packages/conversation/src/engine.ts`、`packages/conversation/src/prompt.ts`

## 背景

P1 之前，「模型看到什么」是 `ConversationEngine` 自己拼的：工作记忆、世界状态投影、人格与心情都在
`buildPrompt` 里内联读取（`packages/conversation/src/prompt.ts` 只负责把它渲染成 `system` / `user` 两段）。
这个形状在只有「最近几轮 + 一点世界状态」时够用，但 pack Phase 1 要求上下文里出现**检索到的记忆、
关系上下文、未完话题**，Phase 3 还会再加（主动开口的专门提示词）。如果继续内联，引擎会同时承担
「对话状态机」「事件写入」「回复安全」和「上下文装配」四件事——半年后没人能回答「这段提示词是谁决定放进去的」。

同时有一条不能破的约束：**上下文变了，行为不许悄悄变**。P1 的提示词必须能证明「老调用方不传新字段时，
与 P0 逐字相同」。

## 决定

### 1. 新增 `packages/context`，上下文装配收敛成两个入口

```text
ContextBuilder.buildUserTurn({ sessionId, text, at, … })   → ConversationContext
ContextBuilder.buildProactive({ … })                        → ProactiveContext
ConversationContext = { recentTurns, memories, relationship, openThreads, world, self, mood?, audience? }
```

两个入口对应「他跟我说话」与「我主动开口」这两种真实场景，不是按数据类型切分。装配出的每一项都带
**可核对的来源**：记忆带 `provenance`（`sourceEventId` / `sourceType` / `confidence` / `occurredAt` /
`updatedAt`）与 `visibility`，世界状态带 `stale`，关系与话题都是从事件日志投影出来的视图。

### 2. 引擎只搬运，不生产上下文

`ConversationEngine` 新增 `contextBuilder?: ContextBuilder | false`（`packages/conversation/src/engine.ts`）：

* **省略**＝引擎自建一个（生产入口的默认行为，调用方不必知道有这个包）；
* **`false`**＝关掉这一层（老路径 / 只想跑 FSM 与回复安全时用，提示词里就不会出现记忆与关系段）。

引擎把**只有它知道**的三样传进去：这一轮的时间与会话、心情的节拍（`MoodBeatResult`）、FSM 状态；
拿回来的上下文交给 `prompt.ts` 渲染。`prompt.ts` 仍是**唯一的渲染层**（`sections` 数组是它的产物），
所以「模型看到什么文字」永远能在一处读完。

### 3. 分工表（这条是 ADR 的主句）

| 事 | 归谁 | 为什么 |
|---|---|---|
| 要不要接受这一轮（FSM、唤醒词、静默） | 引擎 | 这是**行为边界**，不是上下文；拒绝的轮次连提示词都不该组装（用例压住） |
| 事件写入（`conversation.turn` / `conversation.decision`） | 引擎 | 一次对话轮次的原子记录点只有一个 |
| 回复安全（工具标记与英文推理剔除、未调用工具却给可核查事实的拦截、禁套话） | 引擎 | 铁律 1/3：这些边界不能交给上下文层或模型 |
| 上下文装配（记忆检索、关系、未完话题、世界状态、自我画像） | `packages/context` | 这些是**读投影**，与「说不说、说什么动作」无关 |
| 提示词渲染（`system` / `user` / `sections`） | `packages/conversation/src/prompt.ts` | 只有一处拼字符串，Debug UI 与模型看到的是同一份 |
| 检索与渲染的两道闸门 | `packages/context`（`render.ts`） | 见 §4：出口比入口更需要防线 |

### 4. 两道闸门都在**出口**，因为它们拦的是「不该说出去的话」

`render.ts` 有两个函数，职责不同（文件头有说明）：

1. `usefulText`：拦机器 id 形态的文本（`sem_…` / `evt_…` 之类），在**检索阶段**就把没用的候选丢掉；
2. `renderGate`：在 `usefulText` 之上多拦**参数名**（`valence=0.310`、`confidence 0.9`）与空白文本，
   记忆行 / 未完话题行 / 世界状态附加行 / 自我状态行**共用**它。

被闸门拦掉的整条**丢弃**（不改写成「看起来干净」的样子），并在 `memories` 段的 debug 里记
`injected=` 与 `dropped_at_render=`——「她怎么没提这件事」必须能在日志里查到答案。

### 5. 向后兼容是硬要求：不传新字段＝与 P0 逐字相同

`AssembleInput` 新增的 5 个可选段与 gate 查询文本都标着「省略 = 不出现」；
`buildProactivePrompt` 从 `buildPrompt` 里抽出来（主动开口走它，`packages/runtime/src/proactive-runtime.ts`
的 composer 调它），老调用方不传时提示词与 P0 逐字相同，有交付用例守着。

### 6. 一处必须记住的实现细节：**引擎自己会再建一次 context**

`engine.buildPrompt()` 在内部调 `#context.buildUserTurn(...)`（`packages/conversation/src/engine.ts`）。
因此：

* 公开给调用方的 `engine.buildUserTurnContext()` 返回的**不是被渲染的那个实例**；
* 渲染期的计数（`memoriesDiagnostics.droppedAtRender`，由 `ContextBuilder.render()` 自增）只打在
  **被渲染的那个实例**上——从调用方自己建的对象上读它**恒为 0**（t14 评审与 t20 修复都实测到这一点）。

这条不是设计缺陷，是「谁拥有这次渲染」的必然结果；把它写进 ADR 是因为它已经让两个人踩过：
**要断言渲染层拦了几条，请用 `renderMemoryLines(...).dropped`，或读装配后 prompt 的 `sections`
里 `memories` 段的 debug**，不要读另一个实例上的计数。

## 后果

* **好处**：提示词的每一段都有明确的产出方；记忆/关系/话题的演进只改 `packages/context`，不必动引擎；
  关掉这一层（`contextBuilder: false`）仍然是可运行的旧行为。
* **代价**：多了一个包与一层 seam；`ConversationEngine` 的选项多了一个，且「省略即自建」意味着
  **忘记传 context 不是错**——所以「上下文没接上」这类缺陷只能靠入口级的实跑证据（`prompt.user` 里
  有没有那一段）来抓，不能靠类型系统。
* **明确没做的**：Tier 2 结构化抽取（`packages/context/src/tier2-extraction.ts`）只有接缝与政策，
  **没有任何入口接线**（config 里如实写着）；主动开口的专门提示词模式（pack Phase 3）也还没做。
