# 评审：主动引擎与多段回复（t41）——铁律 3、费用与隐私、独立复现

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t40 契约、t41 实现、t43 验证）
> 日期：2026-09-30
> 评审对象：t41「实现：多段回复 + 主动引擎（硬门禁与一次性投递）」，并复核 t40 的契约（ADR-0009/0010）在实现里是否被守住
> 复核方式：**我自写探针**（`node:sqlite` 临时库 + 真实 `ProactiveEngine`/`evaluateProactiveGates`），不跑仓库测试、不采信自述；本报告是唯一写入产物
> 时序说明：这次评审距 t41 交付较久，工作区已含 t42（控制台接线）/t58（默认 proactivity 0.55→0.70）/t61（测试同步）等后续改动。因此我核的是**当前实现**，凡与 t41 当年数字有关处我都注明现值（例：默认 proactivity 现在是 **0.70**，阈值 **0.54**）。
> 权威来源（实际跑过/读过的）：`packages/conversation/src/{proactive,segments,engine}.ts`、`packages/contracts/schemas/events/proactive.decision.v1.json`、`packages/contracts/src/events.ts`、`packages/brain-adapter/src/{mimo,fake,dsh,types}.ts`、`docs/adr/0009-…md` §3/§6、`docs/design/security-and-privacy.md` §6、`docs/verification/proactive-and-segments-verification-2026-09-30.md`，以及**我自己跑的探针与命令**（见 §6）

---

## 1. 结论

**verdict：pass（无 blocking finding；3 条观测记在 §5，不改变判定）**

一句话：**铁律 3 在这个实现里守得非常硬**——`ProactiveEngine` 所在的文件里**没有任何模型/适配器引用**（我 `git grep` 过 `adapter`/`BrainAdapter`/`evaluateProactiveCandidate`/`MimoClient`，命中全在**对话引擎** `engine.ts` 与注释里，`proactive.ts` **零命中**），门禁是**纯函数** `evaluateProactiveGates(candidate, context)`（输入只有配置、时钟、FSM 状态、可用性标志、事件日志与人格值，**没有一条来自模型**），而模型接缝只有调用方传进来的 `deliver` 回调、**只在门禁全过之后才被调用**；今天 `evaluateProactiveCandidate`（模型侧 API）在 mimo/fake/dsh 三处都是 `NOT_IMPLEMENTED(M5)` 且**全仓无调用方**，所以主动路径此刻**一分钱都花不出去**。费用与隐私也都没有被削弱：我用临时库自己复现了**四次拦截**（静默时段、冷却、重启重复、6 小时额度）与**一次重启不重发**，额度在负面反馈下只会**收紧**（`floor(cap/multiplier)`）。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 核对铁律 3（门禁由程序判定、模型无法绕过），并核对费用上限与隐私约束未被削弱 | **真正满足** | §2（结构证据 + 我的探针）、§3（费用上限）、§4（隐私 + 独立复现）；没有发现任何「模型可影响判定」或「上限被放宽」的路径 |
| 2 独立复现至少一条门禁的拦截与一次「重启不重复投递」，结论落 `docs/review/` | **满足（我复现了四条拦截 + 一次重启不重发）** | §4.3：`QUIET_HOURS` / `COOLDOWN_ACTIVE` / `ALREADY_DELIVERED`（**新引擎 + 同一 candidateId**）/ `QUOTA_6H_EXCEEDED`；`deliver` 调用次数始终与「真正投递」一致（1→1→1→1→2→3→4→4） |

---

## 2. 铁律 3：门禁由程序判定、模型无法绕过（结构 + 行为两层证据）

**（a）结构层：主动引擎手里没有模型**

| 检查 | 命令 | 结果 |
|---|---|---|
| 主动引擎是否引用模型/适配器 | `git grep -n -e adapter -e BrainAdapter -e evaluateProactiveCandidate -e MimoClient -- packages/conversation/src` | 命中全部在 `engine.ts`（**对话**引擎，逐字轮次本来就要调模型）与 `index.ts`/`prompt.ts` 的注释；**`proactive.ts` 零命中** → 门禁对象根本拿不到模型 |
| 模型侧 API 有没有被调用 | `git grep -n "evaluateProactiveCandidate" -- packages scripts services apps` | 只有 `types.ts` 的接口声明与 mimo/fake/dsh 三处 `NOT_IMPLEMENTED(M5)` 实现，**没有任何调用方** |
| 门禁是不是纯函数 | 读 `proactive.ts` 的 `evaluateProactiveGates(candidate, context)` | 是：输入只有 `candidate`、`settings`、`now`、`offsetMinutes`、`proactivity`、`conversationState`、`inFlightTurn`、`negativeFeedback`、`sceneAvailable`、`speechAvailable`、`history`；全是对事件日志与注入时钟的比较，注释也写明「every gate is a pure comparison over the event log plus an injected clock」 |
| 唯一通往模型的路径 | 读 `consider()` | 只有调用方传进来的 `deliver` 回调；它在**门禁全过**的分支里、且是**写完 `delivered:true` 审计之后**才被 await；被拦的分支直接 return，**不会触达任何接缝** |

**（b）行为层：我用探针把「必须先过门禁」跑出来**（见 §4 的逐次表格）——被拦的四次里 `deliver` 的累计调用次数**一次都没涨**（0→0、1→1、1→1、4→4），即**门禁没通过就没有任何内容生成/模型接缝活动**。

**（c）门禁顺序与文档一致**：`evaluateProactiveGates` 按固定顺序短路，实测命中的 `reason_code` 顺序与 ADR-0009 §3 完全对得上（我复现的 `QUIET_HOURS` 在任何额度检查之前、`COOLDOWN_ACTIVE` 在额度之前、`ALREADY_DELIVERED` 在 `DND`/静默之前）。

## 3. 费用上限：没有被放宽，而且只会收紧

| 我实测的 | 结果 |
|---|---|
| 静默时段（本地 23:00，窗口 22:30–07:00） | `QUIET_HOURS`，`speak=false`，`deliver` 未调用 |
| 冷却（投递后 10 分钟，冷却 25 分钟） | `COOLDOWN_ACTIVE`，`deliver` 未调用 |
| 6 小时额度（配置上限 4） | 第 4 次投递后，第 5 次 → `QUOTA_6H_EXCEEDED`；`readProactiveHistory(store)` 最后 6h 内正好 **4 = 上限** |
| 负面反馈倍率 2.0（冷却设为 0 以隔离额度） | 已投 2 条后带负面反馈 → **`QUOTA_6H_EXCEEDED`**（额度被收紧为 `floor(4/2)=2`）；不带负面反馈则继续放行 → **只会收紧，不会放宽** |
| 负面反馈对冷却的作用（`base_cooldown_min` 25、倍率 2.0） | 带负面反馈：投递后 20 分钟 `COOLDOWN_ACTIVE`、**30 分钟仍 `COOLDOWN_ACTIVE`**、55 分钟才放行（等效 50 分钟）；**对照组**（同配置、不带负面反馈）在 30 分钟即放行 → 倍率确实作用于冷却本身，不只是额度 |

代码侧一致：`tightenBudget(cap, multiplier) = Math.max(1, Math.floor(cap / multiplier))`；额度、冷却、同主题窗口**全部由事件日志里的 `speak:true` 记录复算**，所以重启后自然延续（这也是「重启不重发」的机制来源）。另外，**主动路径目前完全不产生模型调用**（§2a），所以「费用上限」今天连被触及的机会都没有——上限在内容生成之前就被检查。

## 4. 隐私与「重启不重复投递」的独立复现

### 4.1 审计只落符号与分值（守铁律 5 的实质）

我的探针在临时库里落了 8 条 `proactive.decision`，其 **payload 键并集 = `candidate_id / delivered / intent / reason_code / score / session_id / speak / threshold / topic_ref / trigger`**；我用 `text|transcript|prompt|reply|message|utterance|reasoning|content|words` 逐个筛，**命中 0**——没有用户原话、没有提示词、没有模型推理。被拦下的 4 次也都落了审计（`speak=false`），reason_code 分别是 `QUIET_HOURS` / `COOLDOWN_ACTIVE` / `ALREADY_DELIVERED` / `QUOTA_6H_EXCEEDED`，所以「为什么今天西西没来找我说话」确实可答。schema 侧 `additionalProperties:false` 且 required 只 4 项，形状是封闭的。

### 4.2 「重启不重复投递」——我亲手复现

序列（同一临时库，`offsetMinutes=480`，两个**不同**引擎实例）：14:00 投递 `cand-1`（`deliver` 第 1 次）→ 14:10 换一个**全新引擎实例**再考虑**同一个** `cand-1` → **`ALREADY_DELIVERED`、`speak=false`、`deliver` 调用次数仍为 1**。也就是说：**重建引擎不会重发已说过的候选**，判定依据是日志里的 `delivered:true` 记录（不是内存状态），因此进程重启同样成立。

### 4.3 逐次判定原始表（我的探针输出）

```
quiet-hours    @23:00 cand-quiet  speak=false reason=QUIET_HOURS          score=0.7 thr=0.54 deliverCalls=0
first pass     @14:00 cand-1      speak=true  reason=PASSED               score=0.7 thr=0.54 deliverCalls=1
cooldown       @14:10 cand-2      speak=false reason=COOLDOWN_ACTIVE      score=0.7 thr=0.54 deliverCalls=1
after restart  @14:10 cand-1      speak=false reason=ALREADY_DELIVERED    score=0.7 thr=0.54 deliverCalls=1
quota fill     @14:40 cand-3      speak=true  reason=PASSED               score=0.7 thr=0.54 deliverCalls=2
quota fill     @15:10 cand-4      speak=true  reason=PASSED               score=0.7 thr=0.54 deliverCalls=3
quota fill     @15:40 cand-5      speak=true  reason=PASSED               score=0.7 thr=0.54 deliverCalls=4
quota exceeded @16:10 cand-6      speak=false reason=QUOTA_6H_EXCEEDED    score=0.7 thr=0.54 deliverCalls=4
```

（`proactivity=0.7` → `threshold=0.54`，与 ADR-0009 §4 的公式一致；候选分量全 1/负项 0 → 分数 0.7，恰好过线。）

## 5. 观测（不改变 verdict）

- **O1（铁律 5 的实质没破，但「只存 reason_code 与分值」这句是简写，且有赖调用方守规矩）**：`ADR-0009` §6（「只存 `reason_code` 与分值，不存模型私有推理」）、`docs/design/security-and-privacy.md` §6 的 `proactive.decision` 行、以及 `proactive.decision.v1.json` 的 `description` 都用这句概括；而实际 payload 有 **10 个键**，其中 `topic_ref` / `intent` 是**调用方给的自由字符串（≤120 字）**，schema 不限制它们的内容。今天**没有任何调用方往里塞内容**（唯一调用方是控制台演练与测试，传的是 `drill`/候选 id 这类符号；我的探针也是），所以隐私实质没被削弱；但这个不变量**由调用方保证，不由类型/schema 保证**。建议（不阻塞）：等候选生成器落地时，把 `topic_ref` / `intent` 约束成程序侧标识（例如 `pattern: "^[a-z0-9_.:-]{1,64}$"`），或在 `#record` 加一条断言 + 一条测试（「payload 里不出现包含空格/CJK 的字段」），并把文档那句改成「只存 `reason_code`、分值与**程序侧标识**（`candidate_id`/`trigger`/`topic_ref`/`intent`）」。
- **O2（静默时段的「底线」是默认值 + 注释，不是代码强制的）**：`isWithinQuietHours` 把 `start === end` 当**空窗**（注释称「no quiet window configured」），`parseProactiveSettings` 允许把 `quiet_hours` 的起止改掉，代码里**没有**「夜间隔不可被配置掉」的强制（只有一条注释说「the quiet-hours *floor* is a separate, non-configurable concern」——我读遍 `proactive.ts`，那件事**没有实现**）。这与「人格与模型都不能放宽它」**不矛盾**（能改的只有管理员写的配置），但若项目希望它是**不可放宽的不变量**，需要在代码里加约束；否则建议把 ADR/文档改成「底线＝**默认值**（管理员可改；人格与模型都不能改）」，别让读者以为它不可配置。
- **O3（本次评审的时序）**：t41 交付已久，工作区已含 t42/t58/t61 的改动。我核的是**当前实现**（结构与行为都保留 t41 的设计：纯函数门禁、先记后播、日志复算额度）；与 t41 当年数字不同的是默认 proactivity（t58 已 0.55→**0.70**、阈值 0.54），我在 §4.3 用的是现值。多段回复侧（`segments.ts`、`onSegment`、M1–M9）我在 t51/t54 两轮已逐条核过，本轮不重复；**播放侧接线**（`chat.ts` 改用 `onSegment`）由 t42 落地，与 ADR-0010 的订正一致。

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node data/rev-tmp/t44-probe.mjs`（**我自写**：临时库 + 真实 `ProactiveEngine`；8 次 consider） | §4.3 的表格：4 次拦截（QUIET_HOURS / COOLDOWN_ACTIVE / ALREADY_DELIVERED / QUOTA_6H_EXCEEDED）、1 次重启不重发、`deliver` 调用次数与实际投递严格一致；payload 键并集 10 个、疑似内容键 0 |
| `node data/rev-tmp/t44-feedback.mjs`（**我自写**：负面反馈倍率；两段，原始输出见下） | ① 额度段（`base_cooldown_min:0` 以隔离冷却，上限 4）：10:00/10:30 两次 `PASSED` → 11:00 带负面反馈 `QUOTA_6H_EXCEEDED`（`deliverCalls` 停在 2 = `floor(4/2)`）→ 11:30 不带负面反馈仍 `PASSED`（累计 3）。② 冷却段（`base_cooldown_min:25`）：`10:00 PASSED / 10:20 COOLDOWN_ACTIVE / 10:30 COOLDOWN_ACTIVE / 10:55 PASSED`；对照组 `10:00 PASSED / 10:30 PASSED` → **只会收紧** |
| `git grep -n -e adapter -e BrainAdapter -e evaluateProactiveCandidate -e MimoClient -- packages/conversation/src` | `proactive.ts` **零命中**（命中都在对话引擎与注释）→ 主动引擎拿不到模型 |
| `git grep -n "evaluateProactiveCandidate" -- packages scripts services apps` | 仅接口 + 三处 `NOT_IMPLEMENTED(M5)`，**无调用方** |
| `git grep -n -e "floor" -e "QUIET_HOURS" -e quietHours -- packages/conversation/src/proactive.ts` | `tightenBudget = max(1, floor(cap/multiplier))`；`QUIET_HOURS` 在门禁链第 5 位短路；静默窗口来自配置解析（见 O2） |
| 读 `packages/contracts/schemas/events/proactive.decision.v1.json` | `additionalProperties:false`；required 4 项；`topic_ref`/`intent` 为 `["string","null"]`、`maxLength 120`（见 O1） |
| `npm test`（判读前先看 `git status`：只有 2 个他人在途 `.md`，无代码在途） | **tests 192 / pass 192 / fail 0 / skipped 0**，exit 0（`duration_ms 20251`；同一套件在 `3f7a3f1` 首次复核时也是 192/192，壁钟 15.6s） |
| `npm run check:docs` | 检查了 **59 份 markdown**（含本文件）；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |

**复核时点（重跑记录）**：上表在 `ee00fb2`（t68/t66 入库后）**整组重跑过一次**，结论与数字未变。本报告依赖的实现与契约自首次复核（`3f7a3f1`）以来**逐字节未变**——`git diff --stat 3f7a3f1..HEAD -- packages/conversation/src packages/contracts docs/adr docs/design/security-and-privacy.md` **输出为空**，`git log --oneline 3f7a3f1..HEAD` 只有 `ee00fb2`（CLI 库路径开关与文档同步）。两次运行中 §4.3 的逐次判定表**完全一致**，两条结构 `git grep` 的命中集合也一致。

> 两个探针脚本**留在盘上**（`data/rev-tmp/t44-probe.mjs`、`data/rev-tmp/t44-feedback.mjs`）供你照 §4.3 复跑——`data/` 已 gitignore，它们不是本任务的交付物（交付物只有本文件）；若日后清理 `data/`，§4.3 的表格 + 上面两条命令足以重建。

**我做过的真实外部动作**：**0 次 API 调用**（未花任何费用）、未开摄像头/麦克风、未写任何业务数据库（探针只用系统临时库，跑完即弃）；全程只读仓库，未改动他人文件。
