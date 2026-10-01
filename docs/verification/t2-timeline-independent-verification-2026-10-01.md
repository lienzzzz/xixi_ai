# t2 独立复验：pack Phase 5 时间线验收（五项目标 + 六条缺陷）

最后更新：2026-10-01（第三轮 t2 的独立复算；不引用实现者或评审的转述当证据，判定数字都是我自己跑出来的）

- 任务：t2（verification）｜inScope：`docs/verification/`
- 我接手时的基线修订号：`git rev-parse --short HEAD` = **18ba5b7**（当时工作区有 4 个未提交文件，见下）
- 复验过程中队长提交了 **626c201**（把这 4 个文件入库）与 **ce80a63**（handoff/AGENTS 收口，不碰代码）；两笔提交都不改我的结论，全部命令在 ce80a63 上也原样重跑过
- 结论有效对象：`packages/conversation/src/proactive.ts`、`scripts/field-test.ts`、`scripts/eval-proactive-timeline.ts`、`config/xixi.example.yaml`、`tests/unit/core/proactive-gates.test.ts`（另外 F1/F3/F5 的断言在 `tests/console/proactive-loop.test.ts`，F2/F6 的在 `tests/integration/proactive-engine.test.ts`，F4 的在 `tests/unit/core/proactive-decision.test.ts`）

## 0. 结论一句话

**pack Phase 5 的五项目标我独立复算全部成立**（11 次／18.2%／81.8%／被忽视的一天 11 比 5、降 54.5%／热聊窗口内 8 次接话、最小间隔 4 分钟），
**六条缺陷我都能用反事实或探针证明修复真的在起作用**（其中 F1/F2/F3/F4/F6 在我接手时已在库，本轮新增的只有 F5 的窄豁免）。
**但有两条必须记下来，不能当成「完美达标」**：

1. **第四项目标的判据比 pack 原话弱**：pack §3 的原文是「两次未回应后继续主动 = 0」。脚本的判据是「被忽视的一天开口数 ≤ 被回应的一天的一半」，而**实现脚本里已打印的那句「连续 2 条未回应后标准沉默跟进 = 建议不说」只对「长时间沉默跟进」这一种候选形状成立**。我按事件日志自己算的台账显示：被忽视的一天里，在**已连续 ≥2 条没人回应**之后仍然开口 **2 次**（topic_pool 一次、19:00 的时钟钩子一次）；被回应的一天里同样有 3 次（全是时钟钩子）。也就是说「= 0」这条更严的口径**今天不成立**，成立的是「显著降频（≈54.5%）」，而且靠的是「强候选（时钟钩子底分 0.99）扛得住 0.9 的惩罚」这条设计选择。
2. **第四项目标的断言余量只有 1 条消息**：`5 × 2 ≤ 11` 刚好成立；实现脚本的 `unanswered × 2 ≤ responsive` 在多一条消息时就会翻成不达标。数值本身是真实的，但这条断言很脆。

另有一处**探针过期**要在引用前知道：t9 的 `t9-floors.ts` 第 B6 项现在 **FAIL**（它断言「40 次『不说』之后第 41 次被额度拦下」，而 F4 修复后第 41 次应当 `PASSED`）。这条 FAIL 是 F4 修复的**预期结果**，不是回归；引用该探针时不能再写「14/14 通过」。

## 1. 我做了什么（每条都能重跑）

| 复算手段 | 用什么 | 干什么 |
|---|---|---|
| 独立驱动的时间线探针 | **不 import** 实现脚本，自己驱动同一批生产部件：`ProactiveLoop.tickOnce`（`scripts/field-test.ts` 本体）、真实 `ProactiveEngine` + `loadConfig()` 出厂 config、真实 `ConversationEngine` + FSM（`FakeBrainAdapter`，模拟时钟注入） | 三段脚本（有人回应／没人回应／上午热聊）各跑 12 小时，**外加四个配置反事实**（见 §3） |
| 惩罚阶梯 + 尾部对照 | `evaluateProactiveGates` + `deriveProactiveSignals` | 把 t9 §2.3 那张 0/1/2/3 条未回应的表重算，并做两处局部对照（区分「按连续条数」还是「按最近 3 条里的比例」） |
| 时间线台账 | 真实 `proactive.decision` 事件日志 | 自己按 `unanswered_window_min` 重算「每条开口出口那一刻已连续几条没人回应」，不看脚本的计数 |
| 时区反事实 | 同一份实现脚本在 `TZ=UTC` 下重跑 | 验证「时区钉死」这条说法（两个进程都是 `TZ=Asia/Shanghai`） |
| 交叉核对 | t9 的三个既有探针（gitignored，产物只作附件） | `t9-floors.ts`／`t9-golden-reaudit.ts`／`t9-timeline.ts` 在与本轮代码同一工作区上重跑 |

**方法上的限制（不假装）**：契约把 `packages/`、`scripts/`、`tests/`、`config/` 全列为 outOfScope，所以我**不能**改动生产代码做突变实验；F1/F6 的「旧行为反事实」只能从代码结构 + 本地单测复算，不能靠改代码现场验证。能做到的反事实是**配置级**的（只改 config 键、不动代码），这已经足以让 F2/F5 的豁免/惩罚各自单独关掉。

## 2. 五项目标：独立复算的判定

命令（前两条都在仓库根跑，离线、不花钱）：

```powershell
node scripts/eval-proactive-timeline.ts        # 实现方交付的判定命令，五项全过才 exit 0
node data/verification/t2/t2-probe.ts          # 我自己的探针（gitignored，需要时按 §6 重建）
```

| pack Phase 5 目标 | 我的独立复算 | 实现脚本同次输出 | 两者是否一致 | 判定 |
|---|---|---|---|---|
| 主动次数 6~12 次可以接受 | `responsive` 12 小时 **11 次** | 11 次 | 一致 | ✅ |
| generic topic ≤ 20% | 引擎口径 **18.2%**／内容口径 **18.2%** | 18.2%／18.2% | 一致 | ✅（余量 1.8 个百分点，很薄） |
| open thread / recent event / interest topic ≥ 60% | 时间钩子 + 话题池 **81.8%** | 81.8% | 一致 | ✅ |
| 连续两次主动没人回应后显著降频 | 被回应 **11** vs 被忽视 **5**（降 54.5%）；惩罚阶梯 **0 → 0.45 → 0.675 → 0.9** 严格递增；2 条未回应后标准沉默跟进 `hold` | 11 vs 5、同样阶梯 | 一致 | ✅ 按「显著降频」；⚠️ 按 pack §3 更严的「= 0」**不成立**（见 §0.1） |
| 热聊可以连续接话、不受 18 分钟 cooldown | 热聊窗口内生产通路接话 **8 次**、最小间隔 **4 分钟** | 8 次、4 分钟 | 一致 | ✅ |

同次输出的三个场景全表（我的探针与实现脚本逐格相同）：`responsive` 11 次、generic 18.2%、specific 81.8%、接受率 54.5%、最小间隔 5 分钟；`unanswered` 5 次、20%、80%、接受率 20%、最小间隔 5 分钟；`hot-chat` 19 次、10.5%、89.5%、接受率 68.4%、最小间隔 4 分钟。

### 2.1 判据本身的两处要注意

- **第二项的阈值本身来自 pack，不是本项目自定的余量**：pack 的 `05_TEST_AND_ACCEPTANCE.md` §3 写「generic topic < 20%」、`02_IMPLEMENTATION_STEPS.md` 的 Phase 5 验收写「generic topic <= 20%」，实现脚本按后者判。18.2% 是真实测量，离阈值只有 1.8 个百分点——换家庭脚本就可能翻面。（出厂 config 里另有 `generic_max_ratio: 0.20`，那是推荐的比值目标，与 `generic_topic_cooldown_h: 24` 的 24 小时窗口是两件事，不能混为一谈。）这是**如实记录的风险**，不是不达标。
- **第四项的断言余量**：实现脚本用 `unanswered × 2 ≤ responsive`（即降频 ≥50%）。5×2=10 ≤ 11，只隔一条消息。我建议把这条判据写成「≥50% 且连续未回应台账为空」两条一起看，别让单条不等式承担整个第四项目标。
- **pack §3 还有 `accept rate > 60%` 与 `same topic repeat < 5%` 两个指标**，Phase 5 的验收清单里没有这两条，实现脚本也没有断言它们。我的实测：`responsive` 接受率 **54.5%**（低于 60%），`hot-chat` 68.4%。**这是描述真实数字、提醒后续任务，不是本任务的验收失败项**；同时说明「五项目标全过」这句话只在 pack Phase 5 那五条的范围内成立。
- **`hot-chat` 场景 12 小时开口 19 次，超出第一项的 6~12 区间**（第一项只对 `responsive` 场景判定）。热聊一天说 19 次是「热聊时可以连续接话」的自然结果，且受 6 小时额度 15 次的硬约束（脚本里 60 次 `QUOTA_6H_EXCEEDED`）；我如实记下，免得把「第一项达标」误读成「任何一天都 ≤12 次」。

## 3. 六条缺陷：每条都给反事实或探针证据

### F1（high）高优先级的被扣分候选吃光 tick → 已修

- **代码证据**：`ProactiveLoop.tickOnce` 的走法由「第一个非 `ALREADY_DELIVERED` 就返回」改成只看 `TICK_WALK_CODES`（`TRIGGER_DISABLED`／`BELOW_RECOMMENDATION`／`CONVERSATION_ACTIVE`／`NEW_SESSION_FLOOR`）；沉默跟进的 candidate id 也从 `${day}-dangling-${floor(minutes/30)}` 改成 `${day}-dangling`（一天一次，能真正变成 `ALREADY_DELIVERED`）。定位命令：

```powershell
git grep -n "TICK_WALK_CODES" -- scripts/field-test.ts
git grep -n "day}-dangling" -- scripts/field-test.ts
```

- **反事实数字（独立复算）**：t9 测到修复前时钟钩子 12 小时 **0/3** 次。现在 `responsive` 场景触发源直方图是 `conversation_dangling 1、topic_pool 6、future_hook_due 3、presence_arrived 1`——**3 个时钟钩子全部落地**。同一条事实的 `git grep` 复现：`git grep -n "future_hook_due" -- tests/console/proactive-loop.test.ts`（那条用例构造「沉默跟进被扣到建议线下 → 钩子照样说」，是本修复的最小复现）。
- 我的独立探针与实现脚本在这一项上逐格一致（触发源直方图相同）。

### F2（high）未回应惩罚饱和、做不到显著降频 → 已修，但「= 0」仍不成立

- **反事实（配置级，最有力）**：把 `unanswered_penalty` 置 0（只改 config 键）后，同一个被忽视的一天从 **5 次** 变成 **12 次**，与被回应的一天（12 次）**完全一样**——即「显著降频」确实是这条惩罚带来的，不是别的什么。命令：`node data/verification/t2/t2-probe.ts`（输出里 `unanswered_penalty=0` 变体）。
- **阶梯（独立复算，与实现脚本一致）**：`0 → 0.45 → 0.675 → 0.9`，方向严格递增，不再是 t9 测到的「1/2/3 条都是 0.45」。`dangling` 形状在 2 条未回应时 0.4763 < 0.495 → `hold`；`topic_pool` 到第 3 条才 `hold`；`presence` 到第 3 条仍 `PASSED`（0.5475）。
- **尾部对照（证明它按「连续条数」而不是「最近 3 条比例」）**：历史 3 条、最新一条（t−40）被回应、回应落在 t−35 → 惩罚 **0.3**（尾部连续 0 条，只剩比例项 2/3×0.45）；同样 3 条但回应落在 t−9 → **0.9**。命令：`node data/verification/t2/t2-contrast.ts`。
- **⚠️ 不达标项（如实写）**：pack §3 的「两次未回应后继续主动 = 0」**今天不成立**。我自己按事件日志算的台账（`t2-probe.ts` 的「时间线台账」段）：

  ```text
  unanswered（被忽视的一天）：6 次开口里，开口时已连续 ≥2 条没人回应的有 2 次
      → topic_pool（12:00 前后一次）、future_hook_due（19:00 那一次）
  responsive（被回应的一天）：11 次里同样有 3 次（全是 future_hook_due）
  ```

  机理：惩罚上限 0.9（权重 0.35 → 最多扣 0.315），而时钟钩子的底分是 0.99，扣完 0.675 仍 ≥ 0.495，所以「强候选」照样开口；只有底分 ≤0.86 的普通候选会被压住。这与实现脚本自己打印的那句「连续 2 条未回应后标准沉默跟进 = 建议不说」并不矛盾（它说的是沉默跟进这一种形状），但**不能把第四项目标读成达到了 pack §3 的「= 0」**。

### F3（high/medium）`topicRef = trigger` 让 generic 指标结构性失效 → 已修

- **独立复算**：两个口径现在**相等**（`responsive` 18.2%／18.2%，`unanswered` 20%／20%，`hot-chat` 10.5%／10.5%）——F3 兑现了「两口径应当相等」这句自证。
- **反事实抓得住**：断言确实按旧值失败。定位命令与最小复现：

```powershell
git grep -n "topicRef carries the real topic" -- tests/console/proactive-loop.test.ts
```

  最小复现是 `tests/console/proactive-loop.test.ts` 里那条用例：它断言 `presence_arrived`／`conversation_dangling` 的 `topicRef === null`、`future_hook_due` 是 `lunch_hook`、`topic_pool` 是用户原话，并额外断言「任何计划的 `topicRef` 都不等于触发器名」——最后这条正是 F3 的旧行为（`topicRef = trigger`）会踩的。我用探针独立复算的 `topicRef` 取值：只有 `topic_pool` 带用户原话（样本 `["今天下午三点我得去社区医院拿药", …]`），其余为 `null`。

### F4（medium）问询吃光当日额度 → 已修（t9 的 B6 探针因此过期）

- **独立复算（我自己的探针，不引用实现方单测）**：`maxPerDay=1` / `maxConsultsPerDay=120`、决策器「第一次说不、之后都说」：

  ```json
  {"asked":2,"rows":[
    {"index":0,"speak":false,"reasonCode":"MODEL_DECLINED","modelConsulted":true},
    {"index":1,"speak":true,"reasonCode":"PASSED","modelConsulted":true},
    {"index":2,"speak":false,"reasonCode":"QUOTA_DAY_EXCEEDED","modelConsulted":false}],
   "decisions":3,"deliveries":1}
  ```

  读法：第一次「不说」消耗的是**问询**额度（`asked` 变成 1），**开口额度没被吃**——第二次照样 `PASSED` 并真的开口；第三次才是开口额度用尽（`QUOTA_DAY_EXCEEDED`，且**没有再问模型一次**）。
- **反事实（过期探针）**：`node data/verification/t9/t9-floors.ts` 现在 **B6 FAIL**、整体 13/14、exit 1。它旧的期望是「40 次『不说』之后第 41 次被拦」，而修复后第 41 次是 `PASSED`。**这个 FAIL 正是 F4 断言抓得住旧行为的证明**，不是回归；引用该探针时必须写明「B6 已过期」。
- **第三方交叉核对（t9 的 `t9-timeline.ts` 重跑）**：它的 `responsive-declined` 场景现在是 **120 次 `MODEL_DECLINED` + 601 次 `QUOTA_CONSULT_EXCEEDED`**（修复前是 40 次 `MODEL_DECLINED` + 679 次 `QUOTA_DAY_EXCEEDED`）。两处变化都指向同一个修复：问询有**自己**的 120 次当日额度、且越界时报的是**自己的**新理由码。

### F5（medium）热聊中接话在生产候选里到不了 → 本轮补完，能单独关掉验证

- **独立复算（我自己的探针 + 配置反事实）**：把 `hot_chat_min_turns` 抬到 50（等于关掉热聊豁免）后，热聊场景从 **19 次**掉到 **11 次**，热聊窗口内 `conversation_continuation` 从 **8 次**掉到 **0 次**，最小间隔从 4 分钟回到 5 分钟。也就是说第五项目标确实**依赖**这条窄豁免，不是别的路径凑出来的。
- **豁免是窄的（同一探针）**：另外两个场景在关掉豁免后逐格不变（`responsive` 11／`unanswered` 5）；而把 `unanswered_penalty` 置 0 时，被忽视的一天会涨到 12（见 F2）——两个目标没有互相拆台。
- **产生的候选形状（生产生成器）**：热聊场景 19 次开口的 `initiative_kind` 分布是 `conversation_continuation 15、open_loop_followup 2、environment_reaction 1、external_sharing 1`，即「对话开着时话题池事实变成续聊候选」这条生产通路真的在走。

### F6（low）没有任何形状的速率下限 → 已修（时间线上只有 1 条日志，单元测试才是主证据）

- **独立复算**：把 `new_session_min_gap_min` 置 0 后，三个场景的次数与直方图**逐格不变**，只有 `responsive` 场景的 `BELOW_RECOMMENDATION` 从 108 变成 109——也就是说**这条下限在 12 小时脚本里几乎不出现**（本轮只有 1 条 `NEW_SESSION_FLOOR`）。
- **所以 F6 的反事实证据来自「底分 0.99 的强候选也会被它拦」这条机制**，而不是时间线：

```powershell
git grep -n "NEW_SESSION_FLOOR" -- tests packages scripts
```

  引用时需要读一下命中的那条单测（它构造「刚开口 2 分钟内、非续聊」的强候选，断言被 `NEW_SESSION_FLOOR` 拦下）。**我如实记下**：F6 是本轮六条里时间线证据最弱的一条，仅凭 `eval-proactive-timeline.ts` 的输出无法判断它是否生效；生效性由单测支撑。这属于「验收口径的边界」，不是失败。

## 4. 我发现的问题（不自己去改，按 inScope 只写进本报告）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| O1 | `scripts/eval-proactive-timeline.ts` 第四项 | 断言 `unanswered × 2 ≤ responsive` 只有 1 条消息余量（5×2=10 ≤ 11），且与 pack §3 的原文「两次未回应后继续主动 = 0」不是同一条判据 | 判据改成「降频 ≥50% 且台账里连续 ≥2 条之后的开口 = 0」两条同时要求，或明确写清只采用较弱的「显著降频」口径 |
| O2 | 同上 | 脚本自己打印的「连续 2 条未回应后标准沉默跟进 = 建议不说」容易被读成第四项目标全称成立，而时钟钩子（底分 0.99）在连续 3 条未回应后仍会开口 | 在输出里区分「普通候选被压住」与「强候选仍可开口」，或把第四项的实测值直接写成台账（连续 ≥2 后的开口次数） |
| O3 | t9 的 `t9-floors.ts`（gitignored 探针） | B6 断言的是 F4 之前的旧行为，现在 FAIL（13/14，exit 1） | 任何后续报告引用它时注明「B6 已过期，FAIL 是 F4 的预期结果」；不要再用「14/14 通过」这句话 |
| O4 | `docs/verification/t9-*.md`（别人的历史报告） | 它的数字（generic 33.3%、9 vs 9、惩罚恒 0.45）描述的是 F1–F6 修复前的代码 | 本报告已给出修复后的复算；t9 报告作为历史记录保留即可，但引用时要带「修复前」的限定 |
| O5 | 实现脚本的时间线口径 | 只跑一个家庭脚本、一个人格档（`proactivity 0.85`）、tick 60 秒（生产 30 秒）；接受率 54.5% 低于 pack §3 的 60% | 这些数字不能外推到别的脚本/人格档；tick 粒度对次数不敏感，但会低估「对话进行中」命中数（t9 §6 的原话，我复核后同意） |
| O6 | t9 的 `t9-timeline.ts`（gitignored 探针） | 它与本轮代码同工作区重跑后数字**大幅变化**：`responsive` 由 t9 报告的 9 次降到 **4 次**，`responsive-skip-dangling` 从 12 降到 4，三个场景的 `PASSED` 都是 4。原因不是回归，而是这个探针自己实现了一份**旧的** tick 走法（源码注释：`stops at the first non-ALREADY_DELIVERED outcome`，正是 F1 之前的语义），而 F1 修复后生产走法是「只对 `TICK_WALK_CODES` 继续走」；两套语义下同一个候选计划会走出不同的次数 | **不要**用它的绝对次数做验收证据（它的历史数字属修复前口径）；它能用的方向性信号是：关掉未回应惩罚后 4 → **12**（与我自己的探针 12 一致） |

## 5. 我没测的 / 局限（不假装通过）

1. **金额级费用上限**：项目没有（只有次数额度，`max_consults_per_day` 是问询次数）。pack 里也没有这条，所以本报告不涉及；沿用 `AGENTS.md` 铁律 3 的写法——「尚未实现，不得写成已实现」。
2. **内容生成**：时间线只验证「要不要说」，没有走 `compose`／真实模型调用，「她说什么」不在本报告范围（那是 P1/真人感范围）。
3. **跨天**：只跑单日 12 小时（07:30–19:30）。连续两天被忽视后的行为、以及跨天恢复，本报告没有测。
4. **不能做代码突变实验**：因为 `packages/`、`scripts/`、`tests/`、`config/` 都在 outOfScope，我的反事实全部是**配置级**的。F1/F6 的「回到旧行为」结论依赖读代码与既有单测，不依赖我现场改代码。
5. **`data/` 下的探针与产物是 gitignored**：换机器即失。所以本报告的**第一引用是可重跑的命令**（§6），探针只作附件；重建方式写在 §6 末尾。

## 6. 复现命令（原样可跑，全部在仓库根）

```powershell
# 1) 实现方交付的判定命令：五项全过才 exit 0
node scripts/eval-proactive-timeline.ts

# 2) 我自己的独立复算探针（三段脚本 + 四个配置反事实 + 惩罚阶梯 + 台账）
node data/verification/t2/t2-probe.ts

# 3) 惩罚的尾部对照（区分「连续条数」与「最近 3 条比例」）
node data/verification/t2/t2-contrast.ts

# 4) 时区反事实：同一份脚本在两个进程时区下必须给出同样的判定表
$env:TZ='UTC'; node scripts/eval-proactive-timeline.ts

# 5) 交叉核对的三个 t9 既有探针（gitignored；注意 B6 已过期）
node data/verification/t9/t9-floors.ts          # 现在 13/14、exit 1，B6 FAIL 是 F4 的预期结果
node data/verification/t9/t9-golden-reaudit.ts  # 5/5 一致、exit 0
node data/verification/t9/t9-timeline.ts --tick-seconds=60

# 6) 门禁
npm test
npm run check:docs
```

**探针重建说明**：上面的第 2、3 条命令对应 `data/verification/t2/t2-probe.ts` 与 `t2-contrast.ts`，它们与产物一起在 `.gitignore` 覆盖的 `data/` 下，**不随仓库分发**；换机器要复现时，按本报告 §1 的「用什么」列重建（都只 import 生产部件，没有另写引擎）。

## 7. 门禁实测（与 §2 的判定一起读）

| 命令 | 实测 | 备注 |
|---|---|---|
| `node scripts/eval-proactive-timeline.ts` | exit **0**，五项目标全部通过（11 次／18.2%／81.8%／11 比 5 降 54.5%／热聊接话 8 次） | 实现脚本自己的输出 |
| `TZ=UTC node scripts/eval-proactive-timeline.ts` | exit **0**，判定表与上面**逐字相同**（只有标题里的基线修订号因队长提交而变化） | 时区反事实 |
| `npm test` | **320 项 pass / 320，fail 0，exit 0**（duration_ms 15846.9496） | 在 ce80a63 上实跑 |
| `npm run check:docs` | **exit 0**，检查 **93** 份 markdown（含本报告），失效链接 0、不存在的文件引用 0、缺少新鲜度标记 0 | 加入本报告后复跑；未加之前是 92 份 |

## 8. 判定（对 t2 三条验收逐条）

1. **五项目标各给独立复算的判定，每个数字附一条可复跑命令**：见 §2（表）与 §6 第 1、2、4 条。判定：五条全部成立（其中第四项按「显著降频」口径成立，按 pack §3「= 0」口径不成立，已写进 §3-F2 与 §0）。
2. **六条缺陷各给至少一次反事实或探针证据，证明断言抓得住**：见 §3（F1 走法+钩子 3/3；F2 关掉惩罚→12 次 + 阶梯 + 尾部对照；F3 两口径相等 + 单测最小复现；F4 独立复算三行 + t9 B6 由过变 FAIL；F5 关掉豁免→窗口内接话 8→0；F6 强候选被 `NEW_SESSION_FLOOR` 拦的单测）。判定：六条都有，但 **F6 的时间线证据最弱**（只有 1 条日志），已如实写明。
3. **结论如实，未达标写未达标，不得把预期或快照写成已验证**：本报告区分了「实现脚本的输出」「我的独立复算」「代码结构证据」「单测证据」四类；把第四项的「= 0」写成不成立，把 B6 的 FAIL 写成 F4 的预期结果，把 F6 的证据强度写低，把接受率 54.5% 低于 pack §3 的 60% 写出来，把「不能做代码突变实验」写成方法局限。**没有把任何预期写成已验证。**
