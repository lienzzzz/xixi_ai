# 评审：ADR-0009 / ADR-0010 与实现对齐（t52）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t41/t50/t52 的实现者）
> 日期：2026-09-30
> 评审对象：t52「ADR-0009/0010 与实现对齐」（含一处用词自我纠正：写「**播放侧**尚未接线」而不是「语音侧」）
> 交付位置：两份 ADR 的最后几次改动落在 `ae6e3e8`、`1f6036f`、`107575f`（被队长的周期提交收走）；**以 t52 命名的那次提交 `6dfdf90` 实际只收录了 `scripts/field-test.ts`**——t52 在回报里没有冒称修订号（见 §4 观测 O3）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`docs/adr/0009-proactive-triggers-and-hard-gates.md`、`docs/adr/0010-multi-segment-replies.md`、`packages/contracts/src/{envelope,events}.ts`、`packages/contracts/schemas/envelope.v1.json`、`packages/conversation/src/{proactive,segments,engine}.ts`、`packages/brain-adapter/src/{mimo,fake,dsh}.ts`、`scripts/{field-test,serve-chat,voice-turn,voice-device-check}.ts`、`tests/unit/core/proactive-gates.test.ts`、`tests/integration/proactive-engine.test.ts`、`tests/unit/core/reply-segments.test.ts`，以及**两份 ADR 自己给出的核对命令**（我逐条实跑，见 §5）
> 说明：本文件是**评审报告**，引用代码位置用「文件 + 函数/测试名 + 一条可复现命令」；行号只作本次核对的快照（AGENTS.md §9.18）

---

## 1. 结论

**verdict：pass（无 blocking finding；3 条观测记在 §4，不改变判定）**

一句话：**要求我独立核对的三处全部成立，而且我把两份 ADR 改动过的每一句都对着代码/测试核了一遍**——ADR-0009 的升版措辞已改成「`schema_version` 与 `payloadVersion` 都保持 **1**，只有**改已发布 payload 的形状**才升版」，我用 `git grep` 核了常量（`envelope.ts` 的 `SCHEMA_VERSION = 1`，且四个事件类型的 `payloadVersion` 都是 1，含 `proactive.decision`）；ADR-0010 的「`reply` 段已被读取」在代码里坐实（`ConversationEngine` 构造时 `resolveReplyLimits(this.#config.reply, …)`）；「**播放侧**尚未接线」这条用词纠正**准确且更有用**——`git grep -n "onSegment" -- scripts services apps plugins` 无命中，而四处 TTS 都是 `synthesize(turn.text)` 整段合成，ADR 还专门写了一句「界面层可以调分段器做展示，但那不等于播放已经分段」，正好堵住我在 t51 里遇到过的那类混淆。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 独立核对三处：ADR-0009 升版措辞（并 `git grep` 核对 `envelope.ts` 常量）、ADR-0010 的 `reply` 段已被读取、「播放侧尚未接线」与 `onSegment` 无生产调用方一致 | **三处全部成立** | 见 §2；另外把 ADR 里其余断言（九门禁、候选生成器缺口、模型侧 M5、M1–M9 有断言、180 字例外、gap 夹紧）也一并核了，全部对得上（§3） |
| 2 自己跑一次 npm test 与 check:docs 并贴结果；结论落 `docs/review/adr-repair-review-2026-09-30.md` | **满足** | `npm test` → **180 / 180 / 0 fail / 0 skipped，exit 0**（修订号 `f4b9e44`；**第一次跑出现一次瞬时红 173/172/1**，见 §4 O1）；`npm run check:docs` → **52 份 markdown、0 问题、exit 0**（加入本文件后复跑 **53 份**、仍 0 问题）；本文件即结论落点 |

**范围纪律**：t52 只改了 `docs/adr/0009…md` 与 `docs/adr/0010…md`；我本轮**只新增本文件**，全程只读、无脚本改动、无突变实验。

---

## 2. 三处必核项的独立核对

### 2.1 ADR-0009 的升版措辞

- **文档现在写的**（Decision 第 6 条附近）：「`proactive.decision`（已实现，v1）：按版本规则**新增一个 v1 schema 文件**，并在 `EVENT_TYPES`…登记」+「**新增类型不需要升 `SCHEMA_VERSION`**：`schema_version` 与 `payloadVersion` 都保持 **1**——只有**改已发布 payload 的形状**才升版（铁律 10：「新增」与「就地改」是两件事）」+ 一条订正说明（原文写「并升 `SCHEMA_VERSION`」，实现按新规则做）。
- **我用 git grep 核的常量**：`packages/contracts/src/envelope.ts` 的 `export const SCHEMA_VERSION = 1;`；注册表 `EVENT_TYPES` 的 `define(type, payloadVersion, …)` 里**四个类型全为 1**（`presence.changed` / `conversation.turn` / `conversation.decision` / **`proactive.decision`** / `system.health`）；信封 schema 的 `event_type` 枚举里 `proactive.decision` 已在册。
- **判定**：**成立**。措辞与常量一致；「只有改已发布形状才升版」也与 `envelope.ts` 的两处校验一致（`schema_version !== SCHEMA_VERSION` 与 `schema_version !== definition.payloadVersion` 都会抛 `UNSUPPORTED_SCHEMA_VERSION`）。

### 2.2 ADR-0010 的 `reply` 段已被读取

- **文档现在写的**（Consequences）：「`config/xixi.example.yaml` 的 `reply` 段**已被读取**：`packages/conversation/src/segments.ts` 的 `resolveReplyLimits()` 只在上限内夹紧，`ConversationEngine` 构造时读入；改本 ADR 的上限或默认值时必须同步改它」。
- **我在代码里核到的**：`git grep -n "resolveReplyLimits(" -- packages` → `engine.ts`（构造时 `this.#replyLimits = resolveReplyLimits(this.#config.reply, options.reply)`）与 `segments.ts`（定义，把配置夹进 `REPLY_LIMITS`）；单测名就是 `resolveReplyLimits reads the config section, clamps it and lets an override win`。
- **判定**：**成立**（且「改 ADR 上限要同步改代码」这条提醒是对的——`REPLY_LIMITS` 是程序常量）。

### 2.3 「播放侧尚未接线」与 `onSegment` 无生产调用方

- **文档现在写的**（归属 / Context / Consequences 三处一致）：「**播放侧尚未接线**：没有任何生产入口传 `onSegment`（核对：`git grep -n "onSegment" -- scripts services apps plugins`，**订正时无命中**），TTS 仍按整段文本合成（`synthesize(turn.text)`），所以真机上听到的还是一整段。分段器是导出的纯函数，界面层可以直接调用它做「分几段、段间多少 ms」的展示，但那不等于播放已经分段」。
- **我实跑**：命令**无命中**；TTS 调用点确实全是整段——`field-test.ts`（两处）、`serve-chat.ts`、`voice-turn.ts`、`voice-device-check.ts` 都是 `synthesize(turn.text)`。
- **判定**：**成立**；「展示 ≠ 播放」那句尤其准确（我在 t51 已独立确认：控制台演练只把分段结果**逐行显示成文本**，那条路径没有 TTS）。

## 3. 顺带核过的其它断言（都成立）

| ADR 里的说法 | 我的核对 |
|---|---|
| 九门禁已落地、顺序固定 | `evaluateProactiveGates` 逐条 `block(...)`：九个门禁码 + 总开关/触发源开关/`ALREADY_DELIVERED` 三道非门禁短路；单测**每个门禁一条**（`proactive-gates.test.ts` 的用例名逐条点名），另有 `the reason-code list names every outcome the gates can return` |
| 「门禁命中时不调用模型」的断言 | `tests/integration/proactive-engine.test.ts` 的 `a blocked candidate is audited with its reason and never reaches the model seam`：`spy.log.length === 0`（deliver 即模型接缝）；接受路径那条断言「接缝恰好被调一次」 |
| 重启不重发 | 同文件 `restart: a delivered candidate is never delivered twice…` + `ALREADY_DELIVERED` 门禁 |
| 残缺的两半：候选生成器 / 内容生成 | 全仓无候选生成器（只有 `scoreProactiveCandidate` 与 `ProactiveCandidate` 接口）；`mimo.ts`/`fake.ts`/`dsh.ts` 的 `evaluateProactiveCandidate` 三处 `NOT_IMPLEMENTED(M5)` |
| 「M1–M9 都有断言」 | M1/M2/M4/M5 在 `tests/unit/core/reply-segments.test.ts`；M6/M7/M8/M9 在 `tests/integration/conversation-engine.test.ts`（用例名直接带 M6/M7/M8/M9） |
| §3 的 180 字例外（尾部合并 + `mergedOverflow`） | `segments.ts` 文件头同句；单测断言段长为 `[40, 40, 120]` 且 `mergedOverflow === true`，另有 130 字无标点硬切 |
| §3 的 gap 夹在 [250, 1200]、默认 450 | 单测 `M3: the gap is clamped into [250, 1200] and defaults to 450` |

## 4. 观测（不改变 verdict）

- **O1（瞬时红，已排除）**：我这一轮**第一次**跑 `npm test` 得到 `tests 173 / pass 172 / fail 1`（随后立刻复跑即 `180 / 180 / fail 0`，exit 0）。当时工作区正被队友改着：`scripts/chat.ts`、`scripts/serve-chat.ts` 有未提交改动（+160 行，看起来正是在把音频出口接到分段播放）。按 AGENTS.md §9.10，这是**成员半成品窗口**里的瞬态，**与本任务的两份 ADR 无关**（`git status` 里 `docs/adr/` 干净）。留给你的信息是：**「播放侧接线」的实现已经在途**，见 O2。
- **O2（前瞻：这批接线落地时，三处文档要同步改）**：ADR-0010 的归属/Context/Consequences 都写着「没有任何生产入口传 `onSegment`（订正时无命中）」，而 `docs/design/conversation.md` §6 的多段回复行也写着「语音侧尚未接线」。**接线一旦合并，这两处立即变假**。建议把「接线任务」的验收里加一条：落地后同步改 ADR-0010 那三处 + `conversation.md` §6 的缺口行（后者已由 t55 在处理，注意别互相覆盖）。ADR 里保留了核对命令，所以复核成本很低——这正是 §9.18 想要的效果。
- **O3（提交归属，仍待回填）**：两份 ADR 的最后改动分散在 `ae6e3e8`、`1f6036f`、`107575f`，而**以 t52 命名**的 `6dfdf90` 只含 `scripts/field-test.ts`。t52 未冒称修订号（符合 §9.20）；建议队长按 §9.20 在 t52 上补一条**追加式** `evidence_note`，写明交付落在哪几个提交，供后来审计引用。

## 5. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `git grep -n "onSegment" -- scripts services apps plugins` | **无命中（exit 1）** → 「播放侧尚未接线」成立 |
| `git grep -n "synthesize(" -- scripts services apps plugins` | 5 处调用点全部是 `synthesize(turn.text)`（整段） |
| `git grep -n "SCHEMA_VERSION\|payloadVersion" -- packages/contracts/src` | `envelope.ts` 的 `SCHEMA_VERSION = 1`；per-type `definition.payloadVersion` 参与两处校验 |
| `git grep -n -A 6 "'proactive.decision'," -- packages/contracts/src/events.ts` | 注册项 `payloadVersion = 1` + schema 文件名 + 描述（「只存 reason_code 与分值（ADR-0009）」） |
| `git grep -n "proactive.decision" -- packages/contracts/schemas/envelope.v1.json` | 信封 `event_type` 枚举在册 |
| `git grep -n "resolveReplyLimits(" -- packages` | `engine.ts` 构造时读 `config.reply`；`segments.ts` 定义（夹紧到 `REPLY_LIMITS`） |
| `git grep -n "evaluateProactiveCandidate" -- packages` | `mimo.ts`/`fake.ts`/`dsh.ts` 三处 `NOT_IMPLEMENTED(M5)` |
| 读 `tests/unit/core/proactive-gates.test.ts` 与 `tests/integration/proactive-engine.test.ts` | 每个门禁一条单测；「被挡下的候选不触达模型接缝」；「重启不重发」；`DISABLED` 不写事件 |
| `npm test`（第一次 / 复跑） | 第一次 `173 / 172 / 1`（半成品窗口）→ 复跑 **180 / 180 / 0 fail / 0 skipped，exit 0**（修订号 `f4b9e44`） |
| `npm run check:docs` | 检查了 **52 份 markdown**（加入本文件后 **53 份**）；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |

**我做过的真实外部动作**：**0 次 API 调用**（未花任何费用）、未开摄像头/麦克风、未写任何数据库；全程只读。
