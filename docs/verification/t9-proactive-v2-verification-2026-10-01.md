# t9 独立验证：主动性 V2（读空气 + 硬底线 + 12 小时时间线）

最后更新：2026-10-01（验证员一人的独立复核；不引用实现者或评审的中间结论当证据）

- 任务：t9（verification）｜inScope：`docs/verification/`
- 我接手时的基线修订号：`git rev-parse --short HEAD` = **57504a7**（P5 的产物当时还在工作区未提交）
- P5 的实现内容落成提交：**3d42777**（`packages/conversation/src/proactive.ts`、`tests/scenarios/golden-conversations.ts`、`config/xixi.example.yaml` 的 mtime 均为 2026-10-01 00:57:13，此后未再变动）
- 我的三个探针跑在其后的工作区（8e0db13 → 3fa6a8b），期间有另一任务（t16：提问率口径与安全段）提交，但**没有碰 P5 的任何文件**（`git status` 里它们始终与 HEAD 一致）
- 收工时 HEAD 已到 **15c36c8**（t17 复审与悬空引用清理），P5 的三个文件 mtime 仍是 00:57:13 —— 本报告的全部数字对 P5 的那份代码有效

## 0. 结论一句话

**P5 的引擎机制是成立的**（硬底线 14/14 项不可绕过、读空气真的在两层之间生效、G07/G12 的重审算术与负载性都过关）；
**但 pack Phase 5 的 12 小时时间线验收里有 2 项目标没有达到**：内容口径的 generic 话题占比 33.3%（目标 ≤20%），以及「连续两次没人回应后显著降频」——被忽视的一天和她被回应的一天说了**同样多的 9 次**，机制探针显示「1 条未回应」与「3 条未回应」拿到同一个 0.45 惩罚，标准候选照样过线（PASSED）。
另发现 4 处机制问题（hook 被饥饿、topicRef=trigger 让 generic 指标结构性失效、问询吃光当日额度、热聊接话只能靠调用方声明），全部给了可复跑证据与最小修复方向。

## 1. 我做了什么（每条都能重跑）

三个自写探针（一次性、gitignored，放在 `data/verification/t9/`）。它们**复用真实部件**，不是另写一套引擎：

| 探针 | 用什么 | 干什么 |
|---|---|---|
| `t9-timeline.ts` | `buildProactiveCandidates`（生产候选）、`ProactiveEngine` + 出厂 config、真实 `ConversationEngine`/FSM（真用户轮次驱动状态机） | 07:30 起 12 小时的家庭时间线，9 个场景 + 一个「未回应」机制探针；一次 tick 一次考虑，走生产 `ProactiveLoop.tickOnce` 的语义（按优先级取第一条非 `ALREADY_DELIVERED` 的结果就返回） |
| `t9-floors.ts` | 真实 `ProactiveEngine.consider`（不是只调纯函数） | 14 项越界情形：静默时段、隐私、两种额度、DND、去重、对话在飞、负面反馈、读空气的边界 |
| `t9-golden-reaudit.ts` | `GOLDEN_CONVERSATIONS` + 我自己的算术 + 真实 `evaluateProactiveGates` | G07/G12 逐例重审：期望 vs 我的独立计算结果 vs 实际；再做「这条断言负载吗」的反事实 |

两点**我自己的**坑，写出来免得后来者把它们当成系统行为：
1. 第一版时间线把**真实墙钟**喂给了 FSM（`ConversationEngine` 没注入时钟），而候选时间是模拟时间——FSM 于是永远停在 LINGERING，得到「12 小时只开口 3 次、内容 100% generic」的**假结论**。改成注入模拟时钟后重跑，才有本报告 §2 的数字。**这条本身是个教训**：混用两个时间源时，状态机不会报错，只会安静地给你一个错的答案。
2. 两处 `node -e` 被 PowerShell 的引号规则毁掉（`\n` / `\"` 被外层抢先解析），改成 `.cjs` 文件后正常——与 AGENTS §9.8 记录的坑一致。

契约外产物（全部 gitignored，未改任何已跟踪文件）：`data/verification/t9/` 下的 3 个探针、8 个场景 JSON、`timeline-summary.json`、`floors.json`、`golden-reaudit.json` 与各次运行的 stdout 记录。

## 2. 12 小时家庭时间线（验收 1）

时间线：2026-10-02 07:30 → 19:30（静默时段 23:30–07:30 之外），tick 60 秒（生产是 30 秒，见 §6 局限）。
家庭脚本：3 次有人到家、7–19 句自发发言（含真实话题：「下午三点去社区医院拿药」「老李孙子考上大学」…），一部分发言是对她的回应。

### 2.1 九个场景的实测数字

| 场景 | 12h 开口 | 内容 generic | specific 来源 | 接受率 | 触发源分布 |
|---|---:|---:|---:|---:|---|
| `responsive`（有人回应） | **9** | **33.3%** | 66.7% | 88.9% | dangling 2、presence 1、topic_pool 6 |
| `unanswered`（没人回应） | **9** | 33.3% | 66.7% | 22.2% | dangling 2、presence 1、topic_pool 6 |
| `hot-chat`（上午有热聊） | 8 | 37.5% | 62.5% | 87.5% | dangling 2、presence 1、topic_pool 5 |
| `hot-chat-continuation`（热聊中调用方声明接话候选） | 17 | 17.6% | 82.4% | 88.2% | topic_pool 14、dangling 2、presence 1 |
| `responsive-skip-dangling`（反事实：不让沉默候选占 tick） | 12 | 8.3% | 91.7% | 83.3% | presence 1、topic_pool 8、**hook 3** |
| `unanswered-skip-dangling`（同上 + 没人回应） | 11 | 9.1% | 90.9% | 9.1% | presence 1、topic_pool 7、**hook 3** |
| `unanswered-no-unanswered-penalty`（反事实：把未回应惩罚关掉） | **20** | 65.0% | 35.0% | 25.0% | dangling 12、topic_pool 6、presence 1、hook 1 |
| `responsive-no-decider`（不接读空气 seam） | 9 | 33.3% | 66.7% | 88.9% | 与 `responsive` 完全相同 |
| `responsive-declined`（模型永远说「不说」） | **0** | — | — | — | 40 次 MODEL_DECLINED 之后 679 次 QUOTA_DAY_EXCEEDED |

`genericByTopicRef`（引擎自己的口径）在所有场景都是 **0%**；`genericByContent` 是我按触发源内容分类的口径（`presence_arrived`／`conversation_dangling`／`routine_expected`／`random_smalltalk` 的固定句不含具体话题，算 generic）——两个口径的差别本身就是发现 F3。

### 2.2 与 pack Phase 5 验收目标的对照

镜像包的两个验收文件：`02_IMPLEMENTATION_STEPS.md` 的 Phase 5 §验收（12 小时时间线）与 `05_TEST_AND_ACCEPTANCE.md` 的 §3（Proactive 指标）：

| pack 目标 | 我的实测（`responsive`） | 判定 |
|---|---|---|
| 主动次数 6~12 次可以接受 | **9** | ✅ 在区间内 |
| generic topic ≤ 20% | 引擎口径 0%（结构性，见 F3）／内容口径 **33.3%** | ❌ 按内容口径不达标；引擎口径无法失败 |
| open thread / recent event / interest topic ≥ 60% | 66.7% | ✅ |
| 连续两次主动没人回应后显著降频（§3 更严：继续主动 = 0） | 被忽视的一天 **9 次** vs 被回应的一天 **9 次**；机制探针：1/2/3 条未回应都给同一个 0.45，标准候选仍 PASSED | ❌ 没有降频 |
| 正在热聊时可以连续接话，不受 18 分钟 new-session cooldown 限制 | 最小间隔 **1 分钟**，13 个间隔 <18 分钟；continuation 候选的打扰代价恒 0 | ✅（但见 F5：要靠调用方声明） |
| accept rate > 60%（§3） | 88.9% | ✅ |

### 2.3 「未回应」机制探针（12 行，历史记录都在 18 分钟打扰窗之外）

| 候选（生产形状） | 0 条未回应 | 1 条 | 2 条 | 3 条 |
|---|---|---|---|---|
| 长时间沉默跟进（dangling，continuation） | PASSED 0.7125 | PASSED **0.555** | PASSED **0.555** | PASSED **0.555** |
| 用户自己提过的话题（topic_pool） | PASSED 0.7825 | PASSED 0.625 | PASSED 0.625 | PASSED 0.625 |
| 有人到家的招呼（presence） | PASSED 0.8625 | PASSED 0.705 | PASSED 0.705 | PASSED 0.705 |
| 平凡候选（话题质量 0.5/读空气 0.5） | PASSED 0.5325 | BELOW 0.375 | BELOW 0.375 | BELOW 0.375 |
| 惩罚值 `recent_unanswered_penalty` | 0 | **0.45** | **0.45** | **0.45** |

两件事同时成立，都要说清楚：
- 惩罚**不是没用的**：把它关掉，同一被忽视的一天从 9 次变成 20 次（§2.1 第 7 行）——它确实压住了一半的量。
- 但它**做不到 acceptance 要的「显著降频」**：① 只要最近 N 条里每条都没被回应，比值就是 1，1 条与 3 条同为 0.45（没有梯度，「两次」不是任何阈值）；② 0.45 × 权重 0.35 = 0.1575，而生产候选的底分是 0.71–0.86，扣完仍然过线（0.555 ≥ 0.495）；③ 时间线上「被忽视的一天」与「被回应的一天」开口次数一模一样（9 vs 9），只有接受率从 88.9% 掉到 22.2%。

### 2.4 热聊中接话（pack §14.3）与它的前提

`hot-chat-continuation` 场景里，调用方在热聊窗口内声明 continuation 候选（`initiativeKind: 'conversation_continuation'`）：17 次开口，最小间隔 1 分钟，13 个间隔 <18 分钟，`CONVERSATION_ACTIVE` 一次也没拦住它——**引擎层成立**。
但**生产的候选生成器在对话仍开着的时候不会产出这种候选**：它唯一的 continuation 来源是「长时间没人说话」触发源（`conversation_dangling`，需要 ≥10 分钟沉默），而 FSM 的跟进窗口只有约 36 秒（人格 `silence_tolerance = 0.7`）——两个窗口不相交。所以端到端要落地这条，只能由调用方显式声明（见 F5）。

## 3. 硬底线不可绕过（验收 2）

14 项探针全部通过（`node data/verification/t9/t9-floors.ts`，exit 0）。每一格都接了「一个**愿意说话**的模型」（`decide: () => ({ speak: true })`）：如果硬底线能被模型说过去，这里就会露馅。

| 探针 | 构造 | 实际结果 |
|---|---|---|
| B1 静默时段 | 02:00 + 满分候选 + 模型想说话 | `QUIET_HOURS`，未开口，**模型一次都没被问**（不花冤枉钱） |
| B2 隐私 | `privacyAllowed: false` | `PRIVACY_BLOCKED`，未开口，模型没被问 |
| B3 顺序 | 02:00 且隐私不允许 | 先报 `QUIET_HOURS`（文档顺序可核对） |
| B4 当日额度 | 当天 40 条（全在 6 小时窗之外） | `QUOTA_DAY_EXCEEDED` |
| B5 6 小时额度 | 6 小时内 15 条 | `QUOTA_6H_EXCEEDED` |
| B6 问询也占额度 | 连问 40 次、模型全说「不说」 | 40 次 `MODEL_DECLINED` 后第 41 次 `QUOTA_DAY_EXCEEDED`（见 F4） |
| B7 DND | `SUSPENDED` | `DND_ACTIVE` |
| B8/B9 去重 | 同一候选 id 考虑两次 | 第一次开口；第二次 `ALREADY_DELIVERED`，且没有第二次白问模型 |
| B10 对话在飞 | `inFlightTurn: true` | `CONVERSATION_ACTIVE` |
| B11 读空气的边界 | 确定性建议 = hold + 模型想说话 | 不开口、**模型没被问**（`BELOW_RECOMMENDATION`） |
| B12 模型失败 | 决策器抛异常 | `MODEL_DECLINED` + `model_reason_code=wrong_moment`，**不是默认放行** |
| B13 负面反馈 | 8 条 + `negativeFeedback` | `QUOTA_6H_EXCEEDED`（额度按 ×2 收紧成 floor(15/2)=7） |
| B14 正常放行 | 全部通过 | 模型被问一次、真的开口，审计记录带 `basis`（7 行）/`signals`/`decided_by=model` |

代码层面的旁证：`evaluateProactiveGates` 的顺序是 开关 → 触发源 → 去重 → DND → 静默时段 → 隐私 → 额度 → 对话 → 场景 → 语音，分数只在最后作为**建议**出现；`ProactiveEngine.consider` 先判硬底线、只有 `recommendation === 'speak'` 才接 `decide` 接缝。
文档顺带核对：`AGENTS.md` 铁律 3 现在写的是「静默时段 / 当日额度与 6 小时额度——次数上限，作为费用代理 / 隐私与同意」，并明确「金额级费用上限**尚未实现、不得写成已实现**」——这正是 t4 的 F6 要求的修正，`git grep -n "cost_cap\|费用上限"` 在代码里仍然没有命中（如实一致）。

## 4. G07/G12 门禁用例重审（验收 3）

语料自己在 t8 之前就写着「ADR-0011 落地后这两条期望必须重审」。我按三条独立标准重审：

### 4.1 期望值是否算得出来（我自己的算术 vs 代码 vs 期望）

| 用例 | 期望 | 我的独立算术 | 实际代码 | score vs 建议线 |
|---|---|---|---|---|
| G07-specific-topic | PASSED | PASSED | PASSED | 0.9775 / 0.495 |
| G12-cooldown-graded | BELOW_RECOMMENDATION | BELOW_RECOMMENDATION | BELOW_RECOMMENDATION | 0.2067 / 0.495 |
| G12-cooldown-does-not-veto | PASSED | PASSED | PASSED | 0.6367 / 0.495 |
| G12-topic-repeated-graded | BELOW_RECOMMENDATION | BELOW_RECOMMENDATION | BELOW_RECOMMENDATION | 0.1727 / 0.495 |
| G12-no-topic-source | TRIGGER_DISABLED | TRIGGER_DISABLED | TRIGGER_DISABLED | 0.5375 / 0.495 |

5/5 一致；旧码 `COOLDOWN_ACTIVE` / `TOPIC_REPEATED` / `SCORE_BELOW_THRESHOLD` 在语料里 **0 次**出现。官方 runner 也通过：`node scripts/eval-realism.ts --fake` 的 5 个门禁用例全过。

### 4.2 这些断言还抓得住东西吗（反事实）

| 用例 | 能抓到 | 抓不到 |
|---|---|---|
| G12-cooldown-graded | 「回到旧门禁：冷却一票否决」；三个惩罚全部坏掉 | 单项（只坏打扰代价 / 只坏话题 / 只坏未回应）——扣完仍在建议线之下 |
| G12-cooldown-does-not-veto | 「回到旧门禁：冷却一票否决」（同一个 2 分钟窗口里强候选必须照样能开口） | 任何单项惩罚 |
| G12-topic-repeated-graded | 「回到旧门禁：话题重复一票否决」；三个惩罚全坏 | 单项 |
| G07-specific-topic / G12-no-topic-source | 分别是「门禁层是否仍放行强候选」与「触发源开关仍是硬底线」 | 惩罚数值（它们本来就不测这个） |

也就是说：**重审后的语料抓的是「两层化」这件大事（不再一票否决、硬底线仍在），不是惩罚的具体数值**；惩罚的数值由 `tests/unit/core/proactive-gates.test.ts` 的断言钉住（例如「2 分钟前开口 → `interruption_cost > 0.8`」「18 分钟后 → 0」「同话题 1 小时前 → `repeated_topic_penalty > 0.4`」「窗口外 → 0」「10 分钟内被回应 → 未回应惩罚 0」「`explicitReject` → 0.8」「负面反馈 ×2 且 clamp」）。两层各管一段，没有把断言改弱到抓不住东西。

### 4.3 schema 与旧记录

- `packages/contracts/schemas/events/proactive.decision.v1.json`：`required` 仍是 4 个旧字段，8 个 P5 新字段都是**可选且已声明**，`additionalProperties: false`；我用它校验了 t9 三个探针新写入的每条记录——**0 条违规**（键集合 ⊆ properties、必填齐全、新字段成组出现）。
- 真实历史：`data/` 下 3 个库共 **180 条** `proactive.decision`，其中 **90 条**带退役码（`COOLDOWN_ACTIVE` 5、`TOPIC_REPEATED` 5、`SCORE_BELOW_THRESHOLD` 80）——**保留 `PROACTIVE_RETIRED_REASON_CODES` 是有据的**：这些记录还在盘上，读日志的人必须还能给它们贴标签。
- 不足（不假装通过）：**黄金语料里只有 `TRIGGER_DISABLED` 一条硬底线用例**，静默时段 / 隐私 / 两种额度都没有语料用例（它们只有单测与我的探针覆盖）。建议补一条 quiet-hours 用例（固定时钟，成本近乎零）。

## 5. Findings

严重度按“对验收结论的影响”定。

### F1（high）高优先级的**被扣分**候选会把 tick 吃光，下面的来源永远轮不到（hook 0/3）
- 证据：`responsive` / `unanswered` / `hot-chat` 三个场景里，`future_hook_due` 的开口数都是 **0**，尽管 12 小时里有 3 个时钟钩子（09:00 / 12:30 / 18:30）在窗口内；同样 7 个用户话题只落地了 6 次。把沉默候选从计划里去掉（反事实 `*-skip-dangling`）后，钩子立刻 **3/3** 全响，开口数 9 → **12**，内容 generic 33.3% → **8.3%**。
- 机理：`ProactiveLoop.tickOnce` 遍历候选，**只要某条不是 `ALREADY_DELIVERED` 就返回**（哪怕它的结论是「建议不说」）。「长时间沉默」候选的 id 每 30 分钟变一次（`${day}-dangling-${floor(minutes/30)}`），于是它**从不变成 `ALREADY_DELIVERED`**：每一个 tick 都被它占住，排在它后面的钩子与话题池根本没被考虑。
- 影响：pack 要的「open thread / recent event / interest topic ≥60%」在 `responsive` 里只有 66.7%（勉强过线），而 generic 偏高、钩子（“之前你让我记着的那件事”）——**本来最像“有理由开口”的一类——一次都没说**。
- 建议（最小改动）：被扣到建议线以下的候选不应终止本 tick 的遍历；要么继续试下一条，要么先对所有计划算分再按分数取最高。这条改动同时能改善 generic 占比。

### F2（high）「连续两次没人回应后显著降频」不成立：惩罚饱和且量级不够
- 证据：`unanswered` 与 `responsive` 的开口次数 **9 vs 9**（接受率 88.9% → 22.2%）；机制探针里 1 条 / 2 条 / 3 条未回应都给出同一个 `recent_unanswered_penalty = 0.45`，生产形状的候选扣完仍 `PASSED`（0.555 / 0.625 / 0.705 ≥ 0.495）；把惩罚关掉则同日 20 次——说明它只在“少说一点”的层面起作用，做不到 pack §3 写的「两次未回应后继续主动 = 0」。
- 机理：`unansweredGrade` 是「最近 3 条里未回应条数 / 条数 × 0.45」——当最近每条都没被回应时比值恒为 1，「两条」不是任何阈值；0.45 × 权重 0.35 = 0.1575 的绝对量级又小于生产候选与建议线之间 0.2 以上的余量。
- 建议：让惩罚随“连续”次数递增（例如 1 → 0.45、2 → 0.70、3 → 0.90），或在「最近 2 条连续未回应」时把建议线抬高/直接给一段 hold 期（可审计、可解释），并对“她自己是否被回应”而不是“最近 3 条的比例”计数。

### F3（medium）`topicRef = trigger` 让 generic 指标结构性失效
- 证据：`planFor` 把每个候选的 `topicRef` 直接写成**触发源名**（`topic_pool` / `presence_arrived` / …），而通用性判定看的是 `topicRef === null`。结果：引擎口径的 generic 占比在所有 12 小时场景里都是 **0%**，永远不可能失败——哪怕实际说出的是「你刚才是有一会儿没说话了，我在这儿」这种没有具体话题的句子（内容口径 33.3%）。同一个成因还让「同话题重复」在两条**不同**的沉默跟进之间反复触发（它们的 `topicRef` 都是 `conversation_dangling`）。
- 建议：只在真的有话题时写 `topicRef`（话题池/未聊完的事），通用触发源留 `null`；这样 generic 占比与同话题重复两个指标才各自测到东西。

### F4（medium）「读空气」的问询会吃光当日额度：40 次「不说」之后当天不再开口
- 证据：`responsive-declined`（模型永远说「不说」）→ 0 次开口，40 次 `MODEL_DECLINED` 之后 **679 次 `QUOTA_DAY_EXCEEDED`**；B6 探针单独复现（第 41 次考虑的理由就是 `QUOTA_DAY_EXCEEDED`）。
- 影响：一个保守/客气的模型会把整天的额度花在“这次不说”上，之后**即使时机很好也不再有任何主动开口**——而按设计意图，额度应当保护“打扰次数/费用”，不是把沉默也算成一次打扰。同时它制造了大量重复的额度日志。
- 建议：把“问询次数”与“开口次数”分成两个额度（问询额度通常可以更大或按小时限流），或只把**开口**计入 `max_per_day`、另设 `max_consults_per_day`。

### F5（medium）pack §14.3 的「热聊中接话」在生产候选里到不了：调用方必须自己声明
- 证据：`INITIATIVE_OF_TRIGGER` 把 `conversation_dangling` 映射为 `conversation_continuation`，而该触发源要求「≥10 分钟没人说话」（`PROACTIVE_DANGLING_AFTER_MINUTES = 10`）；FSM 的跟进窗口约 36 秒（人格 `silence_tolerance=0.7`）。两个窗口不相交 → 对话还开着时，生成器产出的都是 `presence/hook/topic_pool`（非 continuation），会被 `CONVERSATION_ACTIVE` 拦下；我的 `hot-chat` 场景里 7 次 `CONVERSATION_ACTIVE` 就是这些。
- 影响：验收要求的「热聊中连续接话」在**引擎层**成立（我用调用方声明的 continuation 候选测到 17 次开口、最小间隔 1 分钟、13 个 <18 分钟），但**端到端没有生产通路**。
- 建议：给“对话进行中且这次对话被欢迎”补一个候选来源（例如把最近几轮对话里没说完的点做成 continuation 候选），或明确写进文档：该能力目前由调用方声明。

### F6（low）打扰代价只是分数：两条消息可以隔 1–2 分钟
- 证据：`responsive` 最小间隔 **2 分钟**、`hot-chat-continuation` 最小间隔 **1 分钟**（13 个间隔 <18 分钟）；B 组探针里“2 分钟前刚开口”的强候选仍是 `PASSED`（0.555，扣的是未回应 0.1575 + 打扰代价 0.1333）。
- 判读：这是 ADR-0011 想要的效果（冷却不再一票否决），对 continuation 完全合理；但对“新会话”是否也合理，需要产品决定——现在程序里**没有任何形状的速率下限**（只有 6 小时 15 次 / 当日 40 次这种稀疏的硬额度）。建议至少给“新会话”保留一条宽得多但仍存在的软下限（例如 3 分钟内不重复新会话，且可审计）。

### 观察（不算 finding）
- **「读空气」目前只有否决权**：`responsive-no-decider`（不接 seam）与 `responsive`（接一个永远同意的模型）结果完全相同（9 次、同样的分布）——确定性一半已经先决定了；模型的价值体现在「说不」（`responsive-declined` → 0 次）与「确定性建议 hold 时不花钱问」（B11）。这与 t8 的实现说明一致（模型不能推翻“建议不说”）。
- **精确到分钟的等待**：`requested`/`unanswered` 窗、18 分钟衰减、12/24 小时话题窗都由 `settings` 驱动，配置里改数字会真的改变判定（`parseProactiveSettings` 有上下限夹紧），这点我核对过。

## 6. 我没测的 / 局限（不假装通过）

1. **tick 粒度**：我用 60 秒一次（生产 `DEFAULT_LOOP_INTERVAL_MS = 30_000`）。这会低估“对话进行中”命中的次数（36 秒的跟进窗口可能被跳过），也略微低估钩子的落地机会。给数字时请记住：次数对粒度不敏感（候选 id 以 30 分钟/天为粒度），但 `CONVERSATION_ACTIVE` 的次数会随粒度变化。
2. **内容生成没接模型**：时间线只验证“要不要说”，没有走 `compose`/`createModelDecider` 的真实模型调用，所以“她说什么”不在本报告范围内（那是 t4/P1 的范围）。
3. **单日单脚本**：一个家庭的一天、一个人格档（`proactivity 0.85`）。换脚本（更多独立话题、更多到场）会显著改变次数——F1/F3 修好之后应当重跑并重新取数。
4. **未测**：跨天连续（连续两天被忽视后的行为）、语音链路（真实 TTS 播出多段）、真实模型作为决策器时的“读空气”质量（`createModelDecider` 的 prompt 质量与延迟）。
5. **未测金额**：项目没有金额级费用上限（只有次数额度），我没有也不能验证“费用上限”这一条——只能确认文档现在如实写着“尚未实现”。

## 7. 与 pack Phase 5 验收目标的判定表

| 目标 | 实测 | 判定 |
|---|---|---|
| 12 小时主动次数 6~12 | 9（生产候选流）／12（去掉饥饿后）／17（调用方声明接话） | ✅ |
| generic ≤20% | 内容口径 33.3%（引擎口径 0% 但结构性失效） | ❌ |
| specific（未聊完/近期事件/兴趣）≥60% | 66.7%（去掉饥饿后 91.7%） | ✅ |
| 两次未回应后继续主动 = 0 / 显著降频 | 9 vs 9，无降频；惩罚饱和 | ❌ |
| 热聊中接话不受 18 分钟限制 | 引擎层成立（min gap 1 分钟） | ✅（端到端缺通路，F5） |
| accept rate >60% | 88.9% | ✅ |
| 硬底线不可绕过 | 14/14 探针 | ✅ |

**结论**：P5 的机制（两层、硬底线、分级、审计）可以接受；pack Phase 5 的时间线验收**有 2 项目标未达标**（generic 占比、未回应后降频），因此**不建议宣布 Phase 5 验收通过**。最小修复方向：F1（别让“建议不说”的候选吃光 tick）+ F2（未回应惩罚按连续次数递增/加 hold 期）+ F3（`topicRef` 只在真有话题时写）；这三条修完重跑本报告的两个命令即可复验。

## 8. 门禁实测（与 §7 的判定一起读）

- `npm test`：**298/298 通过、exit 0**（当前工作区，HEAD 3fa6a8b；输出 `data/verification/t9/t9-npm-test.txt`）。
- `npm run check:docs`：**exit 0**（92 份 markdown，失效链接 0、不存在的文件引用 0、缺少新鲜度标记 0；输出 `data/verification/t9/t9-check-docs.txt`）。
- 过程中我自己踩过一次同类问题，被门禁抓个正着，记在这里当例子：报告里引用**仓库外**的镜像包验收文档时带了 `docs/` 前缀（check-docs 只认仓库内路径），以及引用过 `--fake` 的一次性产物（那两个文件已被 captain 按 t17 的 O4 清理）。两处都已改成「不带目录前缀的名字」与「可重跑命令」：`node scripts/eval-realism.ts --fake`（离线自检，结论看 stdout；要落盘用 `--out %TEMP%`，不要把产物当第一引用）。
- 自查器（把 check-docs 的三条规则单独跑在我的文件上）：`node data/verification/t9/docs-selfcheck.cjs docs/verification/t9-proactive-v2-verification-2026-10-01.md` → OK。
- 本报告不引用「提问率」指标（那是 P1/真人感范围）；若以后要谈，按 t17 更正后的口径写：同语料三次重复均值 46.0%（极差 4.7pt，带内），全部 10 个捕获主口径 15.8%–63.2%（跨带）。

## 9. 复现命令（原样可跑）

```powershell
# 12 小时时间线（离线，不花钱；8 个场景 + 未回应机制探针）
node data/verification/t9/t9-timeline.ts --tick-seconds=60

# 硬底线 14 项（离线；失败时 exit 1）
node data/verification/t9/t9-floors.ts

# G07/G12 重审（离线；期望 vs 我的算术 vs 实际 + 反事实）
node data/verification/t9/t9-golden-reaudit.ts

# 官方 runner 的黄金门禁用例
node scripts/eval-realism.ts --fake --no-gate

# 门禁
npm test
npm run check:docs
```

产物（gitignored，作附件而非第一引用）：`data/verification/t9/timeline-summary.json`、`timeline-<场景>.json` ×8、`floors.json`、`golden-reaudit.json`、`timeline-run.txt`、`floors-run.txt`、`golden-reaudit-run.txt`、`eval-realism-fake.txt`、`t9-npm-test.txt`、`history-codes.cjs`（历史 reason_code 盘点）、`schema-check.cjs`。
