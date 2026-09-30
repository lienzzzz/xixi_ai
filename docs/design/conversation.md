# 对话层：FSM、提示词组装与沉默

> 最后更新：2026-09-30
> 权威来源：`packages/conversation/src/{fsm,prompt,engine}.ts`、`packages/brain-adapter/src/{types,tools,mimo}.ts`、`packages/domain/src/store.ts`
> 若与代码不一致，以代码为准，并请立即修正本文件

对话层负责**确定性的一半**（铁律 1）：该不该接这句话、模型能看到什么、说了要不要落库。
模型只负责「说什么」。三个文件对应三件事：

| 文件 | 职责 | 章节依据 |
|---|---|---|
| `packages/conversation/src/fsm.ts` | 状态机与接受判定 | §12、§13 |
| `packages/conversation/src/prompt.ts` | 提示词组装与人格→指令映射 | §26、§46.3 |
| `packages/conversation/src/engine.ts` | 一轮的编排、沉默兜底、落库 | §55 |

## 1. FSM：状态、事件与超时

```text
IDLE --addressed()--> ENGAGING --onUserTurn()--> ACTIVE --onReplyCompleted()--> LINGERING
LINGERING --tick ≥ lingerMs--> IDLE        ENGAGING --tick ≥ engageTimeoutMs--> IDLE
ACTIVE/LINGERING --suspend()--> SUSPENDED --到期(tick) 或 resume()--> IDLE
```

- 状态只有五个：`IDLE | ENGAGING | ACTIVE | LINGERING | SUSPENDED`。
- 所有决策都基于**注入的毫秒时间戳**（构造函数收 `at`，`tick(at)` 显式推进），因此可在测试与
  §22.3 的回放里逐字复现。
- 默认配置 `DEFAULT_FSM_CONFIG`：`lingerMs = 30_000`、`engageTimeoutMs = 15_000`、`silenceTolerance = 0.7`。
- `SUSPENDED` 的到期时间可以是 `null`（「今天想安静点」到显式 `resume()` 为止）。
- `snapshot()` 返回 `{state, since, lastTurnAt, suspendedUntil, turnCount}`——`turnCount` 是**本进程内**的计数，
  与持久化的 `conversation_sessions.turn_count`（跨进程累积）不是同一个东西。

### §13 的 POC 判定规则（`shouldAcceptTurn`）

| 状态 | `addressed` | 结果 |
|---|---|---|
| `IDLE` | `true` | 接受，`ACCEPTED_WAKE_OR_DIRECT` |
| `IDLE` | `false` | **拒绝**，`REJECTED_NOT_ADDRESSED`（不写任何事件） |
| `ENGAGING` / `ACTIVE` / `LINGERING` | 任意 | 接受，`ACCEPTED_CONTINUATION`（已开着的会话不必再喊名字） |
| `SUSPENDED` | 任意 | 拒绝，`REJECTED_SUSPENDED` |

`addressed` 由**调用方**判定，因为 M2 之前没有唤醒词：

- 试用页 `scripts/serve-chat.ts`：状态为 `IDLE` 时把这一次点击/这句话当作直呼
  （`addressed: engine.state === 'IDLE'`），会话已开启时按继续处理；
- 终端 `scripts/chat.ts`：只有第一句 `addressed: true`；
- 评测器 `scripts/eval-conversation.ts`：由语料逐轮声明（`tests/scenarios/corpus.ts` 的 `addressed?`）。

**接线现状带来的两个真实行为**（代码如此，未必符合直觉）：

- 试用页的 `addressed` 由**发送那一刻的 FSM 状态**决定：`IDLE → true`，其余状态 → `false`。
  因此「`IDLE` 且未直呼」这一条拒绝分支在页面上**不可达**（两个按钮都传对它）；
  页面上唯一会被拒的情况是 §55 之外的 `SUSPENDED`（点过「今天安静点」按钮之后）。
- 终端 `npm run chat` 只在**第一句**传 `addressed: true`（局部变量 `first`），
  所以如果中途停顿超过跟进窗口、FSM 回到 `IDLE`，后面这句会被判定为
  `REJECTED_NOT_ADDRESSED` 而不被接受。这正是 M2 的唤醒词/搭话判定要接管的位置。

### 静默容忍度如何缩放跟进窗口

`ConversationStateMachine.lingerMs` 是一个 getter，按有效人格的 `silence_tolerance` 缩放基础窗口：

```text
lingerMs(实际) = round(lingerMs(配置) × (0.5 + silenceTolerance))
```

- `silenceTolerance = 0` → `× 0.5`；`0.7`（默认）→ `× 1.2`；`1` → `× 1.5`。
- 以默认配置 30s 为例：`0.7 → 36_000ms`、`0 → 15_000ms`、`1 → 45_000ms`。
- 注释里给的理由是「容忍度高的用户不怕停顿，所以西西多听一会儿，而不是退出会话」，
  并且刻意**不引入第二个魔法常数**（见 `tests/unit/conversation-fsm.test.ts` 的断言）。
- **接线现状（易踩）**：`silence_tolerance` 必须由调用方通过 `ConversationEngine` 的
  `fsm` 选项显式传入（如 `scripts/eval-conversation.ts` 直接构造引擎、`tests/integration/conversation-engine.test.ts`
  传 `fsm: { lingerMs: 30_000, silenceTolerance: 0.7 }`）。`ConversationEngine` 目前**不会**自动把
  `store.selfProfile()` 里的 `silence_tolerance` 读进 FSM——人格影响的是提示词，不影响超时。
  默认值恰好也是 0.7，所以「忘记接线」在默认人格下看不出来。

## 2. Prompt 组装（§26）

`PromptAssembler.assemble(input)` 返回 `{system, history, user, sections}`。

### 稳定前缀 vs 变化后缀

`system`（**稳定前缀**，逐字节稳定）按固定顺序拼接：

```text
HARD_POLICY（不可变硬策略，常量）
你的名字是「<identity.name>」。
当前说话方式要求（有效人格，由运行时给出，不要复述给用户）：<人格指令列表>
有效人格原始参数：verbosity=0.4, warmth=0.8, …
```

`user`（**变化后缀**）按固定顺序拼接：

```text
【当前情境】 now（时区）/ 时段 / 星期 / 会话状态（本会话第 N 轮）/ world.extra
【最近对话】 用户：… / 西西：…（工作记忆，最多 8 轮）
【用户这句话】 <本句>
（用中文回应用户。只在没有合适的话可说时，才整句回复 [静默]。）
```

`history` 另外以真实角色数组返回（`{role, content}`），供支持消息数组的适配器保留角色边界：
`MimoBrainAdapter` 直接把它铺成 `messages`；`DshBrainAdapter` 用 `flattenPrompt`
把三者压成一个任务字符串（`packages/brain-adapter/src/types.ts`）。

**为什么这样切（§46.3 缓存）**：`system` 里没有时间、没有会话状态、没有历史，
所以同一人格下它跨轮**逐字节相同**，provider 侧的前缀缓存可以一直命中；
变化的只有 `user`。这一条被 `tests/unit/prompt.test.ts` 的
`the model-visible prompt separates stable prefix from changing suffix` 直接断言
（两轮的 `system` 必须相等，`user` 必须不等）。

**`sections` 的用途**：把模型实际看到的内容切成可寻址的块，供 Debug UI / 证据展示
（§22.2「模型到底看到了什么」）。当前固定四段：

| `name` | `part` |
|---|---|
| `core-identity-and-hard-policy` | `system` |
| `effective-self-model` | `system` |
| `world-state` | `user` |
| `working-memory` | `user` |
| `current-turn` | `user` |

`tests/unit/prompt.test.ts` 断言这五个名字与顺序。`ConversationEngine.respond()` 把整份 `AssembledPrompt`
放进返回值（`ConversationTurn.prompt`），`npm run chat` 的 `/prompt` 与评测器都用它，
**但它不写进事件日志**（`conversation.turn` payload 没有这个字段）。

### 情境来源

`worldStateLite(now, timezone, offsetMinutes)` 生成 `{now, timezone, timeOfDay, weekday}`：
时段由本地小时映射（`describeTimeOfDay`：凌晨/清早/上午/中午/下午/傍晚/晚上/深夜），`now` 用带数字偏移的 ISO。

## 3. 人格 → 具体说话指令（§39.4）

`personalityDirectives(personality)` 只对**偏离中立档**的属性发指令，因此前缀短、每行都有意义。
阈值来自 `band(value, low, high)`：`< low` 为 `low`，`> high` 为 `high`，其余为 `mid` 且**不产生任何指令**。

| 属性 | 阈值 | 命中时产生的句子 |
|---|---|---|
| `verbosity` | 0.33 / 0.66 | low：「回答尽量短：通常 1 句，最多 2 句。」；high：「可以多说一点（3~5 句）…」；**mid 才有一句默认值**「回答通常 1~3 句。」 |
| `talkativeness` | 0.40 / 0.65 | low：「少主动展开新话题。」；high：「可以自然地多聊一点，主动带出一两个相关话题。」 |
| `curiosity` | 0.35 / 0.65 | low：「少反问…」；high：「可以偶尔顺着话头追问一句，但一轮最多一个问句。」 |
| `formality` | 0.30 / 0.70 | low：「用很随意的口语，像家里聊天。」；high：「语气客气、用词正式一些。」 |
| `humor` | 0.35 / 0.65 | high：「可以偶尔开个轻松的玩笑。」 |
| `warmth` | 0.40 / 0.75 | low：「语气平淡，不要刻意热情。」；high：「语气温和、关心对方。」 |
| `directness` | 0.35 / 0.70 | high：「有话直说，不要绕。」 |
| `silence_tolerance` | 0.40 / 0.75 | high：「允许沉默…必要时用 `[静默]`。」；low：「尽量接住每一句，不要让对话断掉。」 |
| `proactivity` | 0.35 / 0.70 | low：「不要主动找话题，等对方说。」 |

**为什么这满足 §39.4「行为验证而非数据库验证」**：人格参数不是被存下来就算数，
它们必须变成模型看得见的说话要求，于是可以从**输出长度**上被证伪。
`scripts/eval-conversation.ts` 的 `personality-length` 检查就是这条：
`terse-personality`（`verbosity: 0.1`）与 `chatty-personality`（`verbosity: 0.95`）跑同一批问句，
高话多组的平均长度必须**严格大于**低话多组；实测 22.3 字 vs 57.3 字（**2.57×**，`docs/progress.md` §0）。
单元测试则直接断言 `personalityDirectives({verbosity:0.1})` 里含「1 句」、
`{verbosity:0.95}` 里含「3~5 句」。

注意 `HARD_POLICY` 与人格指令的关系：硬策略（像家里人、不提实现细节、不编造、没有合适的话可以不说、
只能调自己的说话方式）**不可被任何人格值与任何用户反馈覆盖**（§2.4、§26.1），人格只能调「怎么说」。

## 4. §55 沉默：`[静默]` 与三层防线

`SILENCE_TOKEN = '[静默]'`（在 `prompt.ts` 与 `brain-adapter/src/mimo.ts` 各定义一次，值相同）。

1. **提示词层**：`HARD_POLICY` 第 5 条与 `user` 结尾的括注都要求「没有合适的话要说时，只回复 `[静默]`」。
2. **引擎层兜底（关键）**：`ConversationEngine.respond()` 在拿到结果后，无论适配器报了什么，
   只要 `isSilenceReply(text)` 为真（去掉空白与标点后为空、或恰好等于 `[静默]`），就把
   `action` 强制改成 `SILENCE`、`text` 落为 `null`、`toolName` 也落为 `null`。
   **这条规则属于引擎，不属于适配器**——适配器可以忘记它，控制符也不会漏进 TTS 或转写文本。
3. **TTS 层**：`RespondHooks.onTextChunk` 只在确认不是沉默控制符时才被调用。

**为什么必须在引擎层**：`MimoBrainAdapter.#interpret()` 会因为「有工具调用」而把 action 判成 `TOOL`，
`DshBrainAdapter` 则依赖 transport 判定的 `action`。两套适配器都可能把 `[静默]` 当成正常文本，
把它们各自的正确性当成前提是不可靠的。

**跨流式分片的处理**（实测 MiMo 会把 `[静默]` 拆成 `[` + `静默` + `]`）：
引擎不等整句，而是边收边判——把 chunk 累积进 `held`，只要 `SILENCE_TOKEN.startsWith(held.trim())`
就**继续压住不发**；一旦内容偏离这个前缀，立刻把 `held` 交给 `onTextChunk` 并清空
（因此普通回复仍然是逐块流式，不被拖慢）；如果恰好凑齐 `[静默]`，就置 `suppressed = true`，
后续 chunk 全部丢弃。`tests/integration/conversation-engine.test.ts` 里有一个手写的分片适配器
（`['[', '静', '默', ']']`）专门断言这一条，并断言 `onTextChunk` 一次都没被调过。

落库效果：`action: 'SILENCE'`、`text: null`，即「西西选择不说话」是**一等事实**，
不是日志里的空洞。

## 5. 一轮的完整时序（`ConversationEngine.respond`）

```text
①  acceptance = fsm.shouldAcceptTurn({addressed, at})        未接受 → 立即返回，零写入
②  fsm.onUserTurn(at)                                        ACTIVE
③  prompt = buildPrompt(…)                                   取 recentTurns(limit 8) 与 selfProfile()
④  store.recordTurn(user, SPEAK, text)                       事务：事件 + turn_count 投影
⑤  adapter.handleUserTurn({sessionId, text, prompt, timeoutMs})
⑥  逐 chunk：压住可能的 [静默] 前缀，其余交给 hooks.onTextChunk（TTS 可提前开始）
⑦  result = await stream.result                             适配器抛错 → 异常上抛（见下）
⑧  沉默兜底：isSilenceReply → action=SILENCE / text=null
⑨  store.recordTurn(assistant, action, text, toolName)       事务：事件 + 投影
⑩  fsm.onReplyCompleted()                                    LINGERING
⑪  返回 {accepted, reason, state, action, text, provider, model, latencyMs, firstTokenMs, prompt}
```

细节与陷阱：

- **`recordTurn` 在事务里同时写事件与投影**：`BEGIN IMMEDIATE` → `INSERT INTO events` →
  `UPDATE conversation_sessions SET last_activity_at, turn_count` → `COMMIT`（`packages/domain/src/store.ts`）。
  一次 `recordTurn` 是**一轮**的事件，不是一轮对话的两条：接受的一轮会写两次事件（用户一次、助手一次），
  各自独立事务。
- **`turn_index` 来自投影**：`recordTurn` 用 `session.turnCount` 作为本轮的 `turn_index`，
  因此用户轮与助手轮的 index 不同（0 与 1），与事件条数一致。
- **prompt 里的轮次是「调用模型之前」的值**：`buildPrompt` 用 `session.turnCount`，
  所以第一句显示「本会话第 1 轮」，并且工作记忆里**不包含**本句（第 ④ 步还没执行）。
- **模型抛错时不写助手轮次**：第 ⑦ 步的异常直接上抛，用户轮次已经在库里，
  助手侧既不写事件也不写 health；`ConversationEngine` 没有重试。调用方（试用页/脚本）自行处理错误。
- **两种时钟并存**：`latencyMs` / `firstTokenMs` 用 `Date.now()`（真实墙钟），
  而事件 `timestamp`、`turn_count` 更新与 FSM 决策用注入的 `Clock`（`store.clock` / `engine.clock`，默认 `systemClock`）。
  测试用 `fixedClock` 才能得到确定的时间戳。
- **`quiet()` 会写事件**：`engine.quiet()` 走 `fsm.suspend()` 并追加一条
  `system.health`（`service='conversation'`, `status='ok'`, `detail='quiet mode until …'`）；
  普通轮次不写 health。

## 6. 未实现（对话层相关）

| 能力 | 现状 |
|---|---|
| 唤醒词与搭话判定（§13 完整版） | 无代码；`addressed` 由 UI 按钮/语料给出（M2） |
| 主动开口（§15） | 无代码；`evaluateProactiveCandidate` 抛 `NOT_IMPLEMENTED(M5)` |
| 长期记忆与关系（§10/§18） | 工作记忆只有 `recentTurns(limit 8)`；长期记忆属 M4 |
| 回溯打断时的语义截断 | 只有 VAD 判定层面的离线测量（`scripts/voice-bargein.ts`） |
| 提示词与延迟进事件日志 | 刻意不存（铁律 5 的方向：只存事实与 `reason_code`） |
| 多轮工具调用与强制工具 | `tool_choice` 只能 `auto`，模型可拒绝调用；适配器上限 2 轮 |

## 维护规则

统一规则见 [`README.md`](README.md#维护规则)。改本文件时对照：

| 改动 | 必须同步的本文件小节 |
|---|---|
| `packages/conversation/src/fsm.ts`（状态、`DEFAULT_FSM_CONFIG`、判定或 `lingerMs` 算法） | §1（并同步 `tests/unit/conversation-fsm.test.ts`） |
| `packages/conversation/src/prompt.ts`（§26 顺序、`HARD_POLICY`、阈值或指令文案、`sections`） | §2、§3、§4（并同步 `tests/unit/prompt.test.ts`） |
| `packages/conversation/src/engine.ts`（编排步骤、沉默兜底、落库时机、时钟用法） | §4、§5 |
| `packages/brain-adapter/src/mimo.ts` 的 `SILENCE_TOKEN` / `isSilenceReply` / 工具循环 | §4、§6（两处 token 必须保持一致） |
| `packages/domain/src/store.ts` 的 `recordTurn` / `recentTurns` 语义 | §5（并同步 [`domain-model.md`](domain-model.md) §5） |
| `packages/domain/src/personality.ts` 属性或 `config` 基线值 | §3（指令映射依赖具体属性名与阈值） |
| 新增会话状态、或 `silence_tolerance` 真正接进 FSM | §1（并把「接线现状」改写为事实） |
| 唤醒词 / 主动开口落地 | §6 与 [`../architecture.md`](../architecture.md) §7 |
