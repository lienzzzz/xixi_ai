# ADR-0010：多段回复——一轮可以说几段，以及上限怎么测

- 状态：已接受（2026-09-30）
- 相关：方案 §12 / §33 / §46.1 / §55、[ADR-0008](0008-realtime-path-direct-mimo.md)、[docs/design/conversation.md](../design/conversation.md)、`config/xixi.example.yaml`
- 归属：**M5**（本 ADR 定义语义与上限；**引擎侧已按它落地**——订正 2026-09-30：`packages/conversation/src/segments.ts`
  的确定性分段器、`RespondHooks.onSegment` 的逐段播放、以及 `ConversationEngine.respond` 在最后一段播完后才进
  `LINGERING` 的时序；M1–M9 都有断言。**播放侧已接了一半**（订正 2026-09-30）：`scripts/chat.ts` 传了
  `onSegment`，回复在终端里**逐段打印、段间真的等 `gapMs`**；**音频出口仍未接线**——试用页
  `scripts/serve-chat.ts` 与 `scripts/voice-turn.ts` 都还没传它，TTS 仍按整段文本合成（`synthesize(turn.text)`），
  所以真机扬声器里听到的还是一整段。核对命令：`git grep -n "onSegment" -- scripts packages`
  （生产入口只命中 `scripts/chat.ts`，另有引擎与测试）。分段器是导出的纯函数，界面层可以直接调用它做
  「分几段、段间多少 ms」的展示，但那不等于音频已经分段。）

## Decision

1. **语义：一次用户轮次最多 3 段，但仍然只是「一轮」**。
   用户说一句 → 西西可以分 1~3 段依次说出（段间留自然停顿），但：
   - `conversation.turn` 只写**一条** assistant 记录（`action: SPEAK`，`text` 是完整文本）；
   - `conversation.decision` 只写**一条**（`turn_index` 只前进 1）；
   - FSM 的 `onUserTurn` 与 `onReplyCompleted` **各只调用一次**（即「状态机只推进一次」）；
   - `LINGERING`（跟进窗口）在**最后一段播完后**才进入。
2. **可测条款**（数值即契约；实现与测试都按这张表写）：

   | # | 条款 | 判据（可测） |
   |---|---|---|
   | M1 | 段数 | `1 <= segments.length <= 3`；模型给出更多时必须合并到第 3 段 |
   | M2 | 单段长度 | 每段 `1..60` 个汉字（去掉首尾空白后非空；超长段在句末标点处继续切分） |
   | M3 | 段间间隔 | `gapMs ∈ [250, 1200]`，默认 **450**；间隔从上一段播放结束算起 |
   | M4 | 拼接不变式 | `segments.join('') === normalize(modelText)`，`normalize` 只去掉段间换行与多余空白，**不增删字** |
   | M5 | 切分位置 | 只能在句末标点之后切（`。！？…`）；**`[静默]` 永不切开**（沉默 token 必须整段判定，§55） |
   | M6 | 状态机只推进一次 | 一轮内 `fsm.onUserTurn` 调用 1 次、`fsm.onReplyCompleted` 调用 1 次；对应 1 条 user + 1 条 assistant `conversation.turn`、1 条 `conversation.decision` |
   | M7 | 窗口起点 | `LINGERING` 的起点 = **最后一段**播放结束时间；`lingerMs` 从该时刻起算 |
   | M8 | 播段期间可打断 | 播放第 1..n-1 段时状态保持 `ACTIVE`（用户可插话），不进入 `LINGERING` |
   | M9 | 部分失败 | 任一段 TTS 失败 → 停止后续段并结束该轮；**事件日志仍然只有一条** assistant 记录（日志是对话级、不是音频级）。实际播了几段属运行期信息，**不进事件**——不为调试信息改已发布 schema |
3. **上限不可被突破**：段数 ≤ 3、单段 ≤ 60 汉字、间隔 ≤ 1200ms 是**硬上限**，人格参数与模型输出都不能越过；
   `config/xixi.example.yaml` 的 `reply` 段只允许在上限内收紧（默认 `max_segments: 3` / `segment_max_chars: 60` / `gap_ms: 450`）。
   **唯一例外是数学上的**：段数 ≤ 3 与单段 ≤ 60 汉字在「回复超过 3 × 60 = 180 字」时不可兼得，此时实现取
   「不丢字」（M4 优先）——尾部合并进第 3 段、允许该段超长，并把 `SegmentedReply.mergedOverflow` 置为 `true`
   让调用方看得见（`packages/conversation/src/segments.ts` 的文件头有同一句说明；两组边界断言见
   `tests/unit/core/reply-segments.test.ts`）。能装进 180 字的回复，每一段都在 60 字以内。
4. **谁切分**：切分由**程序**做（确定性纯函数：按句末标点 + 上限切分），模型只负责内容；
   模型不能指定段数与间隔——它无法感知 TTS 播放时长，也无法保证可复现（与 ADR-0009 同一条理由）。

## Context

- 现状（订正 2026-09-30）：**引擎侧已有**分段上限与段间间隔——`ConversationEngine.respond` 在写完那条 assistant
  记录之后、`fsm.onReplyCompleted()` 之前逐段 await `RespondHooks.onSegment`（时序见
  [`conversation.md`](../design/conversation.md) §5 的 ⑨′ 步），间隔作为播放器参数随每段下发。
  **播放侧只接了文本出口**：`scripts/chat.ts` 传了 `onSegment`（终端逐段打印 + 真等 `gapMs`），
  但音频出口仍走 `synthesize(turn.text)` 一次合成整段——试用页 `scripts/serve-chat.ts` 与 `scripts/voice-turn.ts`
  都还没接（核对：`git grep -n "onSegment" -- scripts packages`，见归属段）。
  分段器可以被界面层直接调用来做分段展示，但真机扬声器里听到的还是一整段。
- 当初的触发点（本轮实测）：单段长回复在真机上的表现是「一口气说完」，用户插不上话，也更容易被 `[静默]`
  兜底逻辑当成一整段处理。
- 已发布契约必须保持不变：`conversation.turn.v1` / `conversation.decision.v1` 都是 `additionalProperties: false`，
  所以「多段」**不能**变成「多条轮次事件」，否则 `turn_index`、工作记忆与跟进窗口的语义都会被改掉（铁律 10 也要求新增而非就地改）。
- 当初的前提（订正 2026-09-30：**文本出口已按这条前提接线，音频出口还没兑现**）：语音侧（ADR-0007/ADR-0008）按段合成与播放只需要一个
  播放器参数（段间间隔），不需要新的模型能力——这是把它做成程序契约的前提。实际接线见上一条。
- 「更自然」的目标不能靠「多段」本身实现：段数没有上限时，一段回复可以被切成十几段，反而更像机器人在刷屏。
  因此上限定为 3 段，并要求 M8 的打断窗口始终存在。

## Alternatives

- **把每段实现成一轮对话（每段一条 `conversation.turn`）**：审计口径被破坏（`turn_index` 暴涨）、
  跟进窗口会被每段重置、工作记忆里全是碎片。否决。
- **让模型自己决定段数与间隔**：不可复现；模型无法感知播放时长，也无法保证不超上限。否决。
- **只在 TTS 层按句切分、不设上限**：可能出现十几段连播，`SUSPENDED`/打断语义在这期间无法生效。否决。
- **完全不支持多段（保持单段）**：长回复永远是「一口气说完」，用户无法在中间插话；`gap` 这条自然停顿也永远没有。

## Consequences

- **已落地**（订正 2026-09-30）：一个确定性分段器（纯函数，覆盖 M1/M2/M4/M5 的边界）、`RespondHooks.onSegment`
  的逐段播放（含段间 `gapMs`），以及「一轮只推进一次」的断言（M6/M7/M8）——见
  `tests/unit/core/reply-segments.test.ts` 与 `tests/integration/conversation-engine.test.ts`。
- **仍需**：把**音频出口**接到 `onSegment`——`scripts/chat.ts` 已经接了（终端逐段），但试用页
  `scripts/serve-chat.ts` 与 `scripts/voice-turn.ts` 仍整段合成（核对：`git grep -n "onSegment" -- scripts packages`，见归属段）。
- **事件契约无需改动**：`conversation.turn` 与 `conversation.decision` 的形状不变，既有审计测试继续成立。
- `config/xixi.example.yaml` 的 `reply` 段已被读取：`packages/conversation/src/segments.ts` 的 `resolveReplyLimits()`
  只在上限内夹紧，`ConversationEngine` 构造时读入；改本 ADR 的上限或默认值时必须同步改它，否则两边不一致。
- 打扰风险：3 段 × 60 字 = 180 字是**能同时满足两个上限**的容量；更长的回复按第 3 条的例外处理（不丢字、尾部合并），
  理想做法仍是改进内容组织，而不是继续加段。

## 修订记录 — 2026-10-01（P1，`995ed42`）

**本节是追加，不改写上面的历史结论**：上文「上限定为 3 段」「3 段 × 60 = 180 字」是当时的决策与事实，原样保留；
下面是 2026-10-01 的修订，两者的冲突处**以本节为准**。

- **M1 的段数上限 3 → 8**：`config/xixi.example.yaml` 的 `reply.max_segments` 与
  `packages/conversation/src/segments.ts` 的上限常量同步改成 8；`segment_max_chars` 仍是 60。
- **容量 180 → 480 字**（8 × 60）。两个词从此要分清：**块长** = 一次播报的粒度（60 字），
  **容量** = 上限 × 块长 = 一轮能说完的总量。
- **真实条件（别把「容量 480」读成「每段都 ≤60」）**：贪心按句边界打包，`≤8` 组时每段 `≤60`；
  `>8` 组时自第 `maxSegments-1` 组起合并进最后一段、`mergedOverflow = true`，**该段可以超过 60 字**。
  最小反例：279 字（9 句 × 31）→ `[31×7, 62]`，末段 62 字。断言在
  `tests/unit/core/reply-segments.test.ts`（含这条 279 字反例与用例名的真实条件）。
- **第 3 条（M4：不丢字优先）不变**：溢出是「合并」不是「截断」，字符零丢失的性质保持。
- **触发原因**：V0.1 的「3 段 × 60 字」把长解释挤成 2–3 个大块（实测单段最长 **341 字**），
  知识问题要么被压短、要么一口气念很久；基线见 `docs/benchmarks/v01-baseline.md` §2.5，
  改造前后的同口径数字见 `docs/benchmarks/realism-metrics.md`（单段最长 341 → 170 字）。
- **仍未变的取舍**：段数不是「越自然越好」——上限存在的理由（避免刷屏、保证打断窗口）仍然成立，
  所以这次是**把上限调到一个能装下解释性回答的值**，不是取消上限。
