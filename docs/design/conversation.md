# 对话层：FSM、提示词组装与沉默

> 最后更新：2026-09-30
> 权威来源：`packages/conversation/src/{fsm,prompt,engine,personality}.ts`、`packages/brain-adapter/src/{types,tools,mimo}.ts`、`packages/contracts/schemas/events/conversation.decision.v1.json`、`packages/domain/src/store.ts`
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
  §22.3 的回放里逐字复现。**注意 `tick` 不是调用方的义务**：`ConversationEngine` 的状态读取会自己按
  注入时钟推进，见本节末「状态读取即推进」。
- 默认配置 `DEFAULT_FSM_CONFIG`：`lingerMs = 30_000`、`engageTimeoutMs = 15_000`。
  **`silenceTolerance` 没有默认值**（见下）：它只能来自人格。
- `SUSPENDED` 的到期时间可以是 `null`（「今天想安静点」到显式 `resume()` 为止）。
- `snapshot()` 返回 `{state, since, lastTurnAt, suspendedUntil, turnCount}`——`turnCount` 是**本进程内**的计数，
  与持久化的 `conversation_sessions.turn_count`（跨进程累积）不是同一个东西。

### 状态读取即推进（`engine.state` / `snapshot()`）

FSM 只在有人调用 `tick` 时才让 `LINGERING` / `ENGAGING` / 过期的 `SUSPENDED` 落到 `IDLE`。
「有人调用」不能是调用方的义务：生产入口只用 `engine.state` 判断该不该把这句话当成叫醒，
没有一处调用 `engine.tick()`（t6 F1 实测），于是超时后的状态永远是**过期缓存**。

因此 `ConversationEngine` 的状态读取是侧效应的读取：

```text
engine.state     → #advance(clock())   → 同步人格窗口 → fsm.tick(now) → 返回 fsm.state
engine.snapshot()→ #advance(clock())   → 同上，再返回快照（与 state 同一时刻，不会互相矛盾）
engine.respond() → #advance(at)        → 用**本轮自己的时间戳**推进，回放因此可复现
engine.buildPrompt() → #advance(at)    → prompt 里的会话状态同样是「现在」
```

取舍（有意选择，不只是实现细节）：

- **getter 带副作用**：读状态会推进注入的时间。这是这个值的本性——「现在是什么状态」随时间变化，
  而把推进责任交给每个调用方正是失败的方案（t19）。
- **读取顺带重读人格窗口**：过期时刻由窗口长度决定，所以人格被 `overrideSelfProfile` 改动后，
  读取也必须用新窗口，否则会出现「窗口变长但会话已经按旧窗口过期」的另一种过期。代价是一次小 SELECT；
  试用页的 `/api/state` 本来就要读 `selfProfile()`。**推论：store 关闭后不要再读 `engine.state`。**
- **`respond()` 不用墙钟**：它按 `at`（调用方给的或注入的时钟）推进，`at` 决定这次决策的时间基准；
  用墙钟会让 §22.3 的回放依赖真实时间。
- **`tick()` 保留**：它是显式推进的接口（循环、回放与测试仍可用），但**生产路径已不依赖它**。
- 事件 `timestamp` 与决策时间仍分开：读取推进不写任何事件，只有真正的拒绝/接受才写 `conversation.decision`。

### §13 的 POC 判定规则（`shouldAcceptTurn`）

| 状态 | `addressed` | 结果 |
|---|---|---|
| `IDLE` | `true` | 接受，`ACCEPTED_WAKE_OR_DIRECT` |
| `IDLE` | `false` | **拒绝**，`REJECTED_NOT_ADDRESSED`（不写轮次，但写一条 `conversation.decision`） |
| `ENGAGING` / `ACTIVE` / `LINGERING` | 任意 | 接受，`ACCEPTED_CONTINUATION`（已开着的会话不必再喊名字） |
| `SUSPENDED` | 任意 | 拒绝，`REJECTED_SUSPENDED` |

`addressed` 由**调用方**判定，因为 M2 之前没有唤醒词。三条调用方现在用的是**同一条规则**：

| 调用方 | 规则 |
|---|---|
| 试用页 `scripts/serve-chat.ts` | `addressed: engine.state === 'IDLE'`（`handleTurn` 与 `/api/voice` 都是这一句） |
| 终端 `scripts/chat.ts` | 同上：`engine.state === 'IDLE'`，即「IDLE 时这句话就是叫醒，会话开着就是继续」 |
| 现场测试 `scripts/field-test.ts` | 同上：`engine.state === 'IDLE'`（两处入口都这样传） |
| 评测器 `scripts/eval-conversation.ts` | 由语料逐轮声明（`tests/scenarios/corpus.ts` 的 `addressed?`） |

**这条规则只有在 `engine.state` 是「现在」的状态时才成立**——见下面这段，它是本轮修掉的第二个缺陷：

> 已修（t19 / t6 F1）：`engine.state` 曾经返回 **FSM 最后一次跃迁时记下的状态**。
> 时间只由 `tick()` 或 `respond()` 内部推进，而**生产代码从来没有调用过 `engine.tick()`**
> （`scripts/chat.ts`、`scripts/serve-chat.ts`、`scripts/field-test.ts` 都只读 `engine.state`）。
> 于是长停顿（超过跟进窗口）之后：`engine.state` 仍然报 `LINGERING` → 调用方算出 `addressed = false`
> → 但 `shouldAcceptTurn` 在决策时会按真实时间 `tick` 到 `IDLE` → **用户的下一句话被判成
> `REJECTED_NOT_ADDRESSED`，再下一句才被接受**。
>
> 根治办法（已实现）：**读取即推进**。`engine.state` 与 `snapshot()` 现在先按注入的时钟 `tick`
> 再返回（`packages/conversation/src/engine.ts` 的 `#advance()`），所以调用方读到的一定是「现在」。
> 取舍见 §1「状态读取即推进」。

因此在这两个真实入口上，「`IDLE` 且未直呼」这条拒绝分支**仍然不可达，但现在的理由不同了**——
不是「它们按状态传对了」，而是「读到的状态和决策用的状态出自同一时刻」：

- 修复前：调用方读到过期的 `LINGERING`，转发 `addressed: false`，而决策时 FSM 已经是 `IDLE`
  → 分支真的被走到了（这就是 F1 的现象）。
- 修复后：读与决策之间只隔一次函数调用（同一个 `at`），要走到这个分支需要会话**恰好在这两步之间过期**
  （例如 ASR/TTS 往返期间窗口关闭），属于窄竞态而不是常态。
- 真实入口上唯一稳定的拒绝是 `SUSPENDED`（点过「今天安静点」/ 输入过 `/quiet` 之后），
  语义上「叫醒」也无法解除它，见 §5 的真实样本复现步骤。
- 语料评测器仍会显式传 `addressed: false`（例如电视声），那时若会话正好是 `IDLE`，这个分支就会被走到，
  这也是保留它的原因。

> 已修（t5）：`scripts/chat.ts` 曾经用局部变量 `first`，**只在第一句**传 `addressed: true`。
> 跟进窗口超时回到 `IDLE` 之后，后面每一句都会被判成 `REJECTED_NOT_ADDRESSED`。
> t5 把它改成「按状态传」（与试用页一致），但当时没发现状态本身是过期的——两处缺陷叠加才表现为
> 「长停顿后第一句被拒」。**因此在 t5 交付态上，长停顿后的第一句依然被拒**（t5 只把「按状态传」这件事做对了，
> 而读到的状态是过期缓存）；该条款的字面要求与回归测试都由 t19 的「读取即推进」完成。
> 留痕（F2，2026-09-30 审计）：t5 的完成回报里写的「复用**集成测试同名断言**」在 t5 当时**并不成立**——
> 那条用例（下面这一个）是 t19 才加进 `tests/integration/conversation-engine.test.ts` 的，
> t5 那时只有引擎层的手工 `tick` 用例。回归测试：
> `tests/integration/conversation-engine.test.ts` 的
> `a long pause is noticed without calling tick(): the first line after it is a wake-up, not a rejection`（t19 新增，
> 修复前该用例失败于 `the state a caller reads must describe now, not the last transition`）。

### 静默容忍度如何缩放跟进窗口

`ConversationStateMachine.lingerMs` 是一个 getter，按有效人格的 `silence_tolerance` 缩放基础窗口：

```text
lingerMs(实际) = tolerance 未接线 ? lingerMs(配置)
                                 : round(lingerMs(配置) × (0.5 + silenceTolerance))
```

- 默认配置 30s 为例：`0 → 15_000ms`、`0.7 → 36_000ms`、`1 → 45_000ms`。
- 注释里给的理由是「容忍度高的用户不怕停顿，所以西西多听一会儿，而不是退出会话」，
  并且刻意**不引入第二个魔法常数**（`tests/unit/conversation-fsm.test.ts` 直接断言这三个数）。
- **接线（本轮修掉的缺陷）**：`ConversationEngine` 自己读 `store.selfProfile()` 的
  `silence_tolerance` 并调用 `fsm.setSilenceTolerance()`；构造时读一次，**每轮 `respond()` 前重读一次**，
  因此运行中的人格变更（`overrideSelfProfile`，M3 之后的学习引擎）下一轮就生效。
  取值优先级只有一处决定（`packages/conversation/src/engine.ts` 的 `#syncSilenceTolerance`）：

  ```text
  store.selfProfile()['silence_tolerance']
    ?? 调用方显式传入的 fsm.silenceTolerance（测试/回放）
    ?? DEFAULT_SILENCE_TOLERANCE   // 0.7，见 packages/conversation/src/personality.ts
  ```

- **FSM 自己不再有默认值**：以前 `lingerMs` 的 getter 会退回 `0.7`，而配置里的基线值恰好也是 0.7，
  于是「忘记接线」在默认人格下完全看不出来，却会在人格被调高/调低后静默失效。
  现在 `ConversationStateMachine` 未接线时就是**不加缩放**（`silenceTolerance === null` → 30s），
  兜底上移到引擎并变成一个**有名字的常量**，不再冒充「人格已接线」。
  `tests/unit/core/engine-personality.test.ts` 用「同一次停顿在两种人格下得到不同接受结果」
  证明它是经由引擎生效的，而不是测试里手工构造 FSM 参数；`tests/unit/conversation-fsm.test.ts`
  则断言 FSM 层未接线时不缩放。
- 引擎把实际用的两个数（`linger_ms`、`silence_tolerance`）写进 `conversation.decision`，
  所以「为什么这句话被接了/被拒了」可以从日志里对回来。

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
⓪  before = advance(at)                                      同步人格窗口 → fsm.tick(at) → 得到「现在」的状态
①  acceptance = fsm.shouldAcceptTurn({addressed, at})
       未接受 → appendEvent(conversation.decision, accepted=false) 后立即返回（不写轮次、不调模型）
②  fsm.onUserTurn(at)                                        ACTIVE
③  prompt = buildPrompt(…)                                   取 recentTurns(limit 8) 与 selfProfile()
④  store.recordTurn(user, SPEAK, text)                       事务：事件 + turn_count 投影
⑤  adapter.handleUserTurn({sessionId, text, prompt, timeoutMs})
⑥  逐 chunk：压住可能的 [静默] 前缀，其余交给 hooks.onTextChunk（TTS 可提前开始）
⑦  result = await stream.result                             适配器抛错 → finally 里先落 decision，再上抛
⑧  沉默兜底：isSilenceReply → action=SILENCE / text=null
⑨  store.recordTurn(assistant, action, text, toolName)       事务：事件 + 投影
⑩  fsm.onReplyCompleted()                                    LINGERING
⑪  finally: appendEvent(conversation.decision, accepted=true, action, fsm_state)
⑫  返回 {accepted, reason, state, action, text, provider, model, latencyMs, firstTokenMs, prompt}
```

第 ⓪ 步的 `before` 同时是「决策前的状态」，因此 `conversation.decision.fsm_state_before` 记录的是
**决策那一刻**的真实状态（长停顿后应为 `IDLE`），而不是上一次跃迁留下的状态。

### 真实拒绝样本（怎么复现）

`conversation.decision` 的 `accepted=false` 分支在真实事件日志里可以这样留下一条
（2026-09-30 在本机实测，样本为 `data/chat/xixi.sqlite` 的 sequence 45）:

```powershell
"/quiet`n西西，你在吗？`n/exit" | npm run chat -- --fake
# 输出：已进入安静模式（/resume 恢复）。 / 未接受（REJECTED_SUSPENDED）：西西正处在安静模式，用 /resume 恢复。
```

落库样本（只存 `reason_code` 与分值，无用户原话、无模型推理）：

```json
{"accepted":false,"reason":"REJECTED_SUSPENDED","action":"SILENCE","fsm_state":"SUSPENDED",
 "fsm_state_before":"SUSPENDED","addressed":false,"acceptance_score":0,
 "linger_ms":36000,"silence_tolerance":0.7}
```

这是真实入口上**唯一稳定可复现**的拒绝：长停顿之后的 `REJECTED_NOT_ADDRESSED` 已被 t19 修掉
（调用方读到的状态不再过期），而电视声那种「未直呼」要由调用方显式传 `addressed: false` 才会走到，
属于语料评测器的用法（`tests/scenarios/corpus.ts`）。

细节与陷阱：

- **`recordTurn` 在事务里同时写事件与投影**：`BEGIN IMMEDIATE` → `INSERT INTO events` →
  `UPDATE conversation_sessions SET last_activity_at, turn_count` → `COMMIT`（`packages/domain/src/store.ts`）。
  一次 `recordTurn` 是**一轮**的事件，不是一轮对话的两条：接受的一轮会写两次事件（用户一次、助手一次），
  各自独立事务。
- **`turn_index` 来自投影**：`recordTurn` 用 `session.turnCount` 作为本轮的 `turn_index`，
  因此用户轮与助手轮的 index 不同（0 与 1），与事件条数一致。
  **`conversation.decision` 的 `turn_index` 不用投影**，而是用引擎进程内的 `#decisionCount`
  （从 0 开始、每条 decision 加一）：被拒绝的轮次不写 `conversation.turn`，用投影就会反复出现同一个 index。
- **prompt 里的轮次是「调用模型之前」的值**：`buildPrompt` 用 `session.turnCount`，
  所以第一句显示「本会话第 1 轮」，并且工作记忆里**不包含**本句（第 ④ 步还没执行）。
- **模型抛错时不写助手轮次，但 decision 一定落库**：第 ⑦ 步的异常直接上抛，用户轮次已经在库里，
  助手侧既不写事件也不写 health；`ConversationEngine` 没有重试。调用方（试用页/脚本）自行处理错误。
  第 ⑪ 步在 `finally` 里执行，所以「这一轮被接受了、随后供应商失败」也是可审计的事实
  （§21 降级要用到这个区分）。
- **两种时钟并存**：`latencyMs` / `firstTokenMs` 用 `Date.now()`（真实墙钟），
  而事件 `timestamp`、`turn_count` 更新与 FSM 决策用注入的 `Clock`（`store.clock` / `engine.clock`，默认 `systemClock`）。
  测试用 `fixedClock` 才能得到确定的时间戳。
- **`quiet()` 会写事件**：`engine.quiet()` 走 `fsm.suspend()` 并追加一条
  `system.health`（`service='conversation'`, `status='ok'`, `detail='quiet mode until …'`）；
  普通轮次不写 health。

### `conversation.decision`：为什么这句话被接了/被拒了

这是本轮新增的第三个事件类型（schema：`packages/contracts/schemas/events/conversation.decision.v1.json`，
在 `EVENT_TYPES` 里注册，envelope 的 `event_type` 枚举同步扩过，契约测试会拦住漂移）。

| 字段 | 含义 |
|---|---|
| `session_id` / `turn_index` | 哪个会话的第几个决策（决策序号，见上） |
| `accepted` / `reason` | `ACCEPTED_WAKE_OR_DIRECT` / `ACCEPTED_CONTINUATION` / `REJECTED_NOT_ADDRESSED` / `REJECTED_SUSPENDED` |
| `action` | 这一轮实际做了什么：接受时是 `SPEAK/SILENCE/TOOL`，拒绝时固定 `SILENCE` |
| `fsm_state_before` / `fsm_state` | 决策前后的状态槽位（拒绝路径下两者相同） |
| `addressed` | 调用方给出的判定输入（不是唤醒词检测本身） |
| `acceptance_score` | 1 = 接受、0 = 拒绝（`confidence` 字段同样用于此）。**它不是接纳度分数**：当前实现只是 `accepted` 的二值镜像（`engine.ts` 的 `acceptance_score: acceptance.accept ? 1 : 0`，`TurnAcceptance` 也只有 `accept: boolean`，**只可能取 0 或 1**），因此**不得用于阈值判断**（用阈值等于把布尔判断绕一圈重写，且会在 M2 引入真分数时悄悄改变行为）。M2 的 addressed 概率模型落地后才引入真正的 0–1 分数，届时按版本规则升版（新增 `conversation.decision.v2.json` + 升 `SCHEMA_VERSION`，不就地改 v1）。同一句话写在 `acceptance_score.description` 上，完整语义见 [`domain-model.md`](domain-model.md) §4.1 |
| `linger_ms` / `silence_tolerance` | 当时真正生效的跟进窗口与人格值，用来把「为什么这会儿还在听」对回来 |

envelope 层：`source = 'brain'`、`actor = 'system'`、`confidence = accepted ? 1 : 0.5`。

**为什么不存用户原话**：他说了什么已经在 `conversation.turn` 里（那是事实），
decision 只回答「为什么」。铁律 5 只允许 `reason_code` 与分值，所以
`tests/integration/conversation-engine.test.ts` 断言这条 payload 里**不含本轮文本**，
也没有任何 `reasoning` 类字段。事件因此可以在不扩大隐私暴露面的前提下支撑 §22.2 的调试视图。

## 6. 未实现（对话层相关）

| 能力 | 现状 |
|---|---|
| 唤醒词与搭话判定（§13 完整版） | 无代码；`addressed` 由 UI 按钮/语料给出（M2） |
| 主动开口（§15） | 无代码；`evaluateProactiveCandidate` 抛 `NOT_IMPLEMENTED(M5)` |
| 长期记忆与关系（§10/§18） | 工作记忆只有 `recentTurns(limit 8)`；长期记忆属 M4 |
| 回溯打断时的语义截断 | 只有 VAD 判定层面的离线测量（`scripts/voice-bargein.ts`） |
| 提示词与延迟进事件日志 | 刻意不存（铁律 5 的方向：只存事实与 `reason_code`）；接受判定已按同一原则落 `conversation.decision` |
| 多轮工具调用与强制工具 | `tool_choice` 只能 `auto`，模型可拒绝调用；适配器上限 2 轮 |

## 维护规则

统一规则见 [`README.md`](README.md#维护规则)。改本文件时对照：

| 改动 | 必须同步的本文件小节 |
|---|---|
| `packages/conversation/src/fsm.ts`（状态、`DEFAULT_FSM_CONFIG`、判定或 `lingerMs` 算法） | §1（并同步 `tests/unit/conversation-fsm.test.ts`） |
| `packages/conversation/src/prompt.ts`（§26 顺序、`HARD_POLICY`、阈值或指令文案、`sections`） | §2、§3、§4（并同步 `tests/unit/prompt.test.ts`） |
| `packages/conversation/src/engine.ts`（编排步骤、沉默兜底、落库时机、时钟用法、`#advance` 读取即推进、decision 事件） | §1（状态读取即推进）、§4、§5 |
| `packages/conversation/src/personality.ts`（`DEFAULT_SILENCE_TOLERANCE` 与取值优先级） | §1 |
| `packages/brain-adapter/src/mimo.ts` 的 `SILENCE_TOKEN` / `isSilenceReply` / 工具循环 | §4、§6（两处 token 必须保持一致） |
| `packages/domain/src/store.ts` 的 `recordTurn` / `recentTurns` 语义 | §5（并同步 [`domain-model.md`](domain-model.md) §5） |
| `packages/domain/src/personality.ts` 属性或 `config` 基线值 | §3（指令映射依赖具体属性名与阈值） |
| 新增事件类型（如 `conversation.decision`） | §5（并同步 [`event-contracts.md`](../event-contracts.md)、[`domain-model.md`](domain-model.md) 的事件表） |
| 新增会话状态 | §1 |
| 唤醒词 / 主动开口落地 | §6 与 [`../architecture.md`](../architecture.md) §7 |
