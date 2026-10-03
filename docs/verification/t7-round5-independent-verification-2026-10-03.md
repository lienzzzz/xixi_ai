# t7 独立复验：第五轮四条工作（多日主动性 / 话题收口判据 / 首音延迟 / 心情边界）

最后更新：2026-10-03（复验员一人的独立复核；不引用实现者或评审的转述当证据，判定数字都是我自己跑出来的）

- 任务：t7（verification）｜inScope：`docs/verification/`
- 我接手时的基线修订号：`git rev-parse --short HEAD` = **415f473**（复验期间队长又落了 4 笔：`2d92b80`（t9/t15/t16/t18 语音线）、`7061a0e`（handoff 更正常数）、`50a7c7f`（t20 修 B1）、`e782c2c`（handoff 记 B1/B2））
- **四块生产代码在这两笔之间一字未变**：`git diff --stat 415f473..e782c2c -- packages/conversation/src/topic-engine.ts packages/domain/src/mood.ts packages/domain/src/mood-engine.ts packages/domain/src/store.ts packages/conversation/src/prompt.ts packages/conversation/src/proactive.ts packages/conversation/src/engine.ts scripts/field-test.ts scripts/eval-proactive-timeline.ts config/xixi.example.yaml` → **空**。变的只有语音线的 `scripts/voice-turn.ts`、`scripts/lib/voice-latency.ts`、`scripts/serve-chat.ts` 与文档/测试，所以本报告对**验收对象**有效。
- 本报告的三类证据分开标注：**【实现者输出】**= 实现方交付命令自己的输出（我只作转录与核对）；**【我的复算】**= 我自写探针/我自己驱动的运行；**【代码或产物证据】**= 读代码/读落盘产物得到的事实（含 `git`/哈希/字符串命中）。

## 0. 结论一句话

**四条工作我都能独立复算，但判定必须分开写：两条「达标」，两条没达标**（「没达到目标」与「实现有缺陷」是两件事）：

| 工作 | 我的判定 | 一句话 |
|---|---|---|
| ① 多日主动性 | **达标（按「显著降频」口径）**；按 pack §3 的「= 0 硬停」口径仍**不成立** | 我自驱动的三天：有人回应 **12/12/12**（每天 ≥6），没人回应 **5/5/5**（第 3 天仍开口，没硬停）；同脚本只把未回应惩罚置 0 → **11/11/11**（惩罚确实是承重的那一环）；阶梯 0 → 0.675 → 0.9 单调，3 条未回应时建议 `hold` |
| ② 话题收口判据 | **达标** | 13 句无关 × 7 话题 = **0/91** 误收口；升级后的真答案 **15/15** 收口（召回不降）；两句被钉住的边界句行为**没变**；反事实（把升级前那份引擎整份拿回来跑同一条路径）→ **9/91 误收口**（含 ADR-0012 记的两个靶子），召回同为 15/15 |
| ③ 首音延迟 | **未达标（目标不可达，不是实现缺陷）** | 我自己另跑 3 批（n=4/批，共 12 轮配对），④ P50（流式）= **10994 / 10291.5 / 5442.5 ms**，是 1500 ms 目标的 **3.63–7.33 倍**；与 t9/t11 的 5 批合并（8 批 n=32）后逐批 ④ / 1500 区间 **[3.14, 7.33] 倍**（池化 ④ P50 = 5597.5 ms → 3.73 倍），**没有一批接近 1.5 s**；方向**不一致（3 快 5 慢，约 −16.1% 到 +27.3%）**。**打断与 backchannel 不在我这次的重测范围内**（本轮只复测了首音四段；`voice:bargein --strict` 是别人的交付） |
| ④ 心情上下界 | **达标（上下界/影响轻微/不越硬底线/不编造）** | 我自喂 8 种坏 delta × 1000 步、8 信号 × 6 角点 × 500 步、10 万步轮换、坏时长/坏时段参数、手改库成 (5.5, −3)：**0 越界**；101×101 角点上语气 ∈ [0.9400, 1.0600]、软偏移 ∈ [−0.030, 0.030]；7 组硬门禁输入里**没有**心情字段、心情高低两侧同码；散文无数字/参数名/经历句式、恒带边界句 |

**另有 5 处如实记录的问题（§5）**，其中 2 处是**工具自己打印的错误结论**（`scripts/voice-turn.ts:490` 仍写死「方向多数为正」；`scripts/lib/voice-latency.ts:296/:333` 把 ② 的地板写死成「约 1.7–2.0 s」，而八批的 ② P50 区间是 **[903.5, 8162.5] ms**、我三批里两批超出）——这两句会**跟我自己的复算结论打架**，请勿引用。
**（2026-10-03 追记：这两处已由并行任务 t21 修掉**——`voice-turn.ts` 的 `note` 不再预置结论句、改成指向产物里的 `latency.reproduce`；`voice-latency.ts` 的 ②/③ 地板改成由传入产物计算（五批现算 ② 中位 1636 ms、区间 904–2363 ms；③ 中位 1882 ms、区间 1393–2391 ms），单批不冒充地板、缺数时明说「这里不给数字」。**我复验时它们还在，所以 §5.1/§5.2 保留原样记录**——现行状态以 `docs/handoff.md` §0、`docs/progress.md` §2.20 ③ 与 `docs/design/voice.md` §6.4 为准。）
**stale 的那句（`docs/handoff.md:49-50`）在我复验期间已被队长修好**（现写「不许写方向多数为正」），所以它不再是问题；我核对了当前文件内容，不是照抄 t18 的转述。

## 1. 我做了什么（每条都能重跑）

四块各一个自写探针（一次性、gitignored，放在 `data/verification/t7/`；**只 import 生产件**，没有另写引擎）：

| 探针 | 用什么 | 干什么 | 用时 |
|---|---|---|---|
| `t7-timeline-probe.ts` | 真实 `ProactiveLoop.tickOnce`（`scripts/field-test.ts` 本体）+ 真实 `ConversationEngine`/FSM（`FakeBrainAdapter` + 注入时钟）+ 出厂 config | 3 个三天场景（全都有人回应 / 三天没人回应 / 同脚本但未回应惩罚置 0），每天 07:30→19:30、tick 120 s；再跑一个只读的惩罚阶梯 | 364 s |
| `t7-topic-probe.ts` | 真实 `TopicEngine.reconcile`（生产路径，不是另一个判定函数） | 我自己抄的 13 句无关句 × 7 话题 = 91 组 + 15 句真答案 + 2 句边界句；再把升级前那份 `topic-engine.ts`（`git show 1e08e5f^:…`，跑前放在仓库内临时目录、跑完删掉）整份拿回来跑同一条路径 | 13 s |
| `t7-mood-probe.ts` + `t7-mood-reset-probe.ts` | `@xixi/domain` 的纯函数与 `MoodEngine`/`XixiStore`、`@xixi/conversation` 的 `PromptAssembler`/`evaluateProactiveGates` | 极端序列、手改库、101×101 角点、7 组门禁输入、散文扫描、提示词 diff、幂等、查看/复位/快照 | 5 s + 2 s |
| 3 批真实调用 | `node scripts/voice-turn.ts --wav …×4 --trace --out …` | 每批 4 轮，同批给「流式 vs 整段」两列；产物落 `data/voice/bench/t7-legacy-batch1|2|3.txt` | 56/65/60 s |

**时间戳（本机，2026-10-03）**：时间线命令 08:12:17→08:39:50（1654 s）；话题探针 08:32:13（**与时间线命令的后半段重叠约 7 分钟**）；心情探针 08:47:34 / 08:52:22；语音三批 08:48:54 / 08:51:38 / 08:58:30（**不重叠**）；门禁 08:57:43。API 波动见 §4.1，重叠这件事见 §6 第 7 条。

## 2. 四条工作的独立复算

### 2.1 ① 多日时间线：主动次数、来源分布、降频幅度、接受率

命令（我自写，离线、不花钱、364 s）：

```powershell
node data/verification/t7/t7-timeline-probe.ts
```

**【我的复算】**（3 天 × 07:30→19:30 × tick 120 s，出厂 config，proactivity = 0.85）：

| 场景 | 逐日开口 | 接受率（逐日） | 最小间隔 | 来源分布（trigger，三天合计） | 性质（initiative_kind，三天合计） | 跨天未完话题追问 |
|---|---|---|---|---|---|---|
| A `all-answer`（每条开口都有人回） | **12 / 12 / 12**（36） | 100% / 100% / 100% | 2 / 1 / 1 分 | topic_pool 21、future_hook_due 9、conversation_dangling 3、presence_arrived 3 | conversation_continuation 24、open_loop_followup 9、environment_reaction 3 | **6 次**（第 2/3 天） |
| B `never-answer`（三天没人回） | **5 / 5 / 5**（15） | 20% / 20% / 20% | 5 / 3 / 3 分 | topic_pool 9、future_hook_due 3、presence_arrived 2、conversation_dangling 1 | conversation_continuation 10、open_loop_followup 3、environment_reaction 2 | **2 次** |
| C `never-answer-no-penalty`（同 B，只把 `unanswered_penalty` 置 0） | **11 / 11 / 11**（33） | 18.2% / 27.3% / 27.3% | 2 / 1 / 1 分 | topic_pool 18、future_hook_due 9、presence_arrived 3、conversation_dangling 3 | conversation_continuation 19、open_loop_followup 9、environment_reaction 3、external_sharing 2 | 6 次 |

判定（我自己的口径，逐条给数量）：

- **M1 主动性没有变低**：有人回应时**每天 12 ≥ 6** → 成立。注意 12 已经贴着「单日 6~12 次可接受」的上界（**余量 0 条**），不是余量很大。
- **M2 没被未回应惩罚压成硬停**：三天没人回应后**第 3 天仍开口 5 次** → 成立；「= 0 硬停」在真产物上确实没有出现。
- **M3 跨天状态**：第 2/3 天仍有 `open_loop_followup`（A 6 次、B 2 次）→ 成立；话题 id 依赖事件时间戳，**条数不逐次复现**（见 §6 局限）。
- **M4 未回应惩罚承重**：同脚本只差这一条 → **有惩罚 5/5/5 vs 置 0 11/11/11**（三天合计 15 vs 33，**降 54.5%**）。这是**配置级反事实**（只改 config 键，不动代码）。
- **M5 没变成骚扰**：开口全部落在清醒时段（越界 0 次），三天里没有 `QUOTA_*` 拦截（理由码只有 `PASSED 36`、`ALREADY_DELIVERED 2066`、`BELOW_RECOMMENDATION 1`、`CONVERSATION_ACTIVE 1`）→ 成立。
- **M6 接受率**：有人回应 100%、没人回应 20%。**口径**：我按生产定义统计（一次开口之后 `unanswered_window_minutes` 分钟内**出现过用户轮次**就算接受），所以「没人回应」场景里那 20% 来自脚本自己排定的家常发言，而不是「有人回她那句话」——口径与实现方脚本不同，见 §5.6。
- **阶梯（只读、同一时刻同一候选形状，只改「已连续几条没人应」）**：0 条 → score 0.7825 / `PASSED` / `speak`；2 条 → 0.5463 / `PASSED` / `speak`（惩罚 0.675）；3 条 → 0.4675 / `BELOW_RECOMMENDATION` / `hold`（惩罚 0.9）→ 单调且真的能翻面 → 成立。

**与实现方输出的对照（【实现者输出】+【我的复算】）**：`node scripts/eval-proactive-timeline.ts` 我实跑一次，**exit 0**、耗时 **1654 s**，多日段逐日 `multi-responsive 8/8/11`、`multi-unanswered 6/8/8`、`multi-unanswered-nopenalty 7/8/11`、`multi-crossday 8/8/11`，M1–M6 全 ✅（其 M4 用的是「第 3 天 8 vs 11，少说 27.3%」，整段 23 vs 27）。**我的 A 场景 12/12/12 比它的 8/8/11 高**，差别来自场景脚本与「回应怎么安排」（它按确定性概率掷骰、我按固定延迟；我的家庭脚本每天重复同一份 6 句），**不是**同一批数字，引用时必须写明批次。

```powershell
node scripts/eval-proactive-timeline.ts      # 实现方判定命令：exit 0；多日 4 个场景 + M1..M6 全过
```

### 2.2 ② 话题收口判据：0/91 与召回不降

命令（我自写，离线，13 s）：

```powershell
node data/verification/t7/t7-topic-probe.ts
```

**【我的复算】**：

| 量 | 我的数字 | 说明 |
|---|---|---|
| 13 句无关句 × 7 话题 | **0/91 误收口**（逐话题 0/13 × 7） | 判定同时要求 `settled === 0` **且**状态仍是 `offered`（只看一个太弱） |
| 升级后的真答案（15 句） | **15/15 收口** | 召回不降 |
| 被钉住的边界句（「没去成，改天再说吧。」「不去了。」） | **都不收口**（`offered`、`settled=0`） | 与 ADR-0012 记的取舍一致，升级没有偷偷改掉它 |
| 反事实 A（升级前那份 `isAnswerAboutThread` 原文，逐句复算） | 84/91 命中内容字 | 这是「字级判据」的上界形态，只能说明机制方向 |
| **反事实 B（升级前整份 `topic-engine.ts` 放进仓库内临时目录，跑同一条 `reconcile` 路径）** | **9/91 误收口**，召回 **15/15** | 真正的承重证据：两个靶子都在里面——「明天我要去买药。」+「我去楼下买了点水果。」→ `engaged`；「明天我要去看孙子。」+「隔壁老王家孙子回来了。」→ `engaged`；另有「买菜，家里的油也没了」话题下 6 句、以及 `snoozed` 形态的 3 句 |

**这条反事实是按 §9.10 的做法做的**：实验前把 `git show` 出来的**旧源码副本**放在 `%TEMP%` 之外、但仍在仓库内的临时目录（`packages/conversation/src/.t7-mutant/`，进程退出时 `rmSync`），**没有改仓库里任何一份生产文件**，所以不会污染别人的门禁输出。

**【代码证据】** 三张词表的关系是模块加载期 `assertVocabularyShape()` 把关的（`FRAME_WORDS` 与 `OBJECT_WORDS`/`ACTION_WORDS` 不相交），而「买 / 拿 / 去 / 吃 / 说 / 做 / 弄」都在 `FRAME_WORDS` 里 —— 这条被单测显式钉住，可用 `git grep -n "isFrameWord" -- tests/unit/core/topic-engine.test.ts` 找到。

**【实现者输出】**（我也实跑过，作为旁证）：

```powershell
node --test tests/unit/core/topic-engine.test.ts tests/integration/open-thread-followup.test.ts   # 25 项 pass / 0 fail，exit 0
```

### 2.3 ③ 首音延迟：同一口径重测（含批次与时间）

口径（**先钉死再看数**，与 `docs/benchmarks/v01-baseline.md` §3.1 逐字对应）：
① 端点 → ASR 出字；② ASR 出字 → 模型首 token；③ 首 token → 首段可听；④ = 端点保持 + ① + ② + ③。**pack Phase 8 的「首音 ≤1.5 s」指的是 ④**，③ 只是归因量。

命令（真实调用、花钱；一批 56–65 s；产物落盘，**不调 API 可复算**）：

```powershell
node scripts/voice-turn.ts --wav tests/audio-fixtures/direct-question.wav --wav tests/audio-fixtures/followup-turn.wav `
  --wav tests/audio-fixtures/longer-turn.wav --wav tests/audio-fixtures/tv-dialogue.wav --trace --out data/voice/bench/t7-legacy-batch1.txt
node scripts/voice-turn.ts --compare data/voice/bench/t9-legacy-batch1.txt data/voice/bench/t9-legacy-batch2.txt `
  data/voice/bench/t11-batch1.txt data/voice/bench/t11-batch2.txt data/voice/bench/t11-batch3.txt `
  data/voice/bench/t7-legacy-batch1.txt data/voice/bench/t7-legacy-batch2.txt data/voice/bench/t7-legacy-batch3.txt
```

**【我的复算】** 我新跑的三批（2026-10-03 08:48:54 / 08:51:38 / 08:58:30，各 n=4）：

| 批次 | ① P50 | ② P50 | ③ P50（流式第一块） | **④ P50（流式）** | ③ P50（同批整段） | ④ P50（同批整段） | ④ 流式/整段 | ④ / 1500 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| t7-batch1 | 557 | 8162.5 | 2150 | **10994** | 1666.5 | 9964 | 1.103 | 7.33 倍 |
| t7-batch2 | 567 | 7516.5 | 1816.5 | **10291.5** | 2187 | 11046.5 | 0.932 | 6.86 倍 |
| t7-batch3 | 459.5 | 1660 | 2582.5 | **5442.5** | 1820.5 | 4566 | 1.192 | 3.63 倍 |

判定：**④ P50 的最小值是 5442.5 ms（= 3.63 倍目标），最大值 10994 ms（= 7.33 倍目标）——在 n=12 的样本里没有一次接近 1.5 s。这条目标在我的复测里同样「未达标」，并且原因指向下游的两个地板，而不是切块参数**：

- **② 的波动极大**：三批 ② 的 P50 分别是 8162.5 / 7516.5 / **1660** ms，**极差 6.5 s**；单轮最慢 22063 ms（batch2）、最快 340 ms（batch1）。② 的 P50 单独就已 ≥ 1660 ms。
- **③ 的地板是 MiMo TTS 单次往返**：我的三批 ③ P50（流式第一块）= 1817–2583 ms；同批整段合成 ③ = 1667–2187 ms —— 两者差距很小，说明「切得早」省不下合成本身的往返。
- **同批对照方向**（把 t9/t11 五批与我的三批合并，8 批 n=32）：**流式更快 3 批、更慢 5 批、持平 0 批 → 方向不一致**；④ 相对整段的幅度区间 **−16.1% 到 +27.3%**。**这与队长与 t9/t16 的更正一致，我按同一口径复算得到同一结论**；我**没有**写「方向多数为正」，也没拿任何单批百分比当结论。

**【实现者输出】** 工具自己算的那段（`--compare` 8 批）：`方向：流式更快 3 批、更慢 5 批`、`→ 方向不一致`、`幅度 约 −16.1% 到 27.3%`、`pack 的 1500 ms 目标…这些批次里没有一批达到`。逐格与我的表一致。

**两种「是目标的几倍」算法（同一份产物、我自己复算，脚本 `data/verification/t7/t7-ratio-checks.ts`）**：

| 算法 | 8 批 n=32（含我的三批） | 前五批 n=20（不含我的） |
|---|---|---|
| **池化**：所有轮的 ④ 值放一起取 P50 ÷ 1500 | ④ 池化 P50 = **5597.5 ms → 3.73 倍** | ④ 池化 P50 ≈ **5265 ms → 3.51 倍**（与 handoff 那个数一致） |
| **逐批**：每批 ④ 的 P50 ÷ 1500 的区间 | **[3.14, 7.33] 倍** | **[3.14, 3.95] 倍**（与 handoff 那个区间一致） |

读法：handoff 的「**3.14–3.95 倍**」是前五批的**逐批**区间；「**合并 n=20 为 3.51 倍**」是前五批的**池化**比值。两者是**两种算法**，写在同一句里容易被读成一个区间的两端（3.51 并不落在 [3.14, 3.95] 里）。**我含自己三批的对应数是：逐批 [3.14, 7.33]、池化 3.73 倍** —— 无论哪种算法都不满足「≤1.5 s」。

### 2.4 ④ 心情：上下界 / 影响轻微 / 不越硬底线 / 不编造实体经历

命令（我自写，离线，5 s + 2 s）：

```powershell
node data/verification/t7/t7-mood-probe.ts
node data/verification/t7/t7-mood-reset-probe.ts
```

**【我的复算】**（`t7-mood-probe.ts` 22 项断言 + `t7-mood-reset-probe.ts` 5 项断言，全部通过）：

| 检查 | 我的数字 |
|---|---|
| 8 种坏 delta（1e9/−1e9/NaN/±Infinity/±1e308/NaN·energy/空）× 1000 步 | **0 越界**（8000 步） |
| 8 信号 × 6 角点 × 500 步（每次只喂同一信号，最坏情况） | **0 越界**（24000 步） |
| 10 万步轮换（信号 ×3 + 回落 + 时段牵引） | **0 越界**（100000 步） |
| 坏时长（NaN/±Infinity/−5/1e9/0）× 坏时段（0/3/23/24/−1/NaN/Infinity） | **0 越界**（84 次调用） |
| `clampMoodValue` 的值域 | NaN→0.5、1e9→1、−1e9→0、Infinity→1（与输入无关） |
| **手改库**成 `(valence=5.5, energy=-3)` 后每个读路径 | `store.mood()`→**(1, 0)**、`engine.current()`→(1, 0)、`stateAt()`→(1, 0)；`bias`=0.000（两个方向的偏离正好抵消，见 §4.4） |
| 影响轻微（101×101 个角点） | 语气缩放 ∈ **[0.9400, 1.0600]**（= 1 ± 0.06）、主动性软偏移 ∈ **[−0.030, 0.030]**（= ±0.03） |
| 不越硬底线（7 组门禁输入） | 上下文里 `mood/valence/energy/bias` 命中 **0 个键**；同一输入重复 + 心情高低两侧同码：深夜 `QUIET_HOURS`、白天 `PASSED`、隐私不允许 `PRIVACY_BLOCKED`、场景不可用 `SCENE_UNAVAILABLE`、对话中 `CONVERSATION_ACTIVE`、DND `DND_ACTIVE` |
| 不编造（5 种状态 × 每段散文） | 28 段里数字命中 **0**、参数名命中 **0**、经历句式（`我(今天|刚才|昨天)?(出去|下楼|去|买|吃|散步|晒太阳|睡|去医院)`）命中 **0**；**5/5 组都带**收尾句「不要因此说出你没做过的事」 |
| 提示词分层 | 不传 `mood` → **没有** `mood` 段、system/user 里没有「心情」二字；传 `mood` → 只多 **1 个 system 段**，`valence=`/`energy=` **只出现在 `sections[].debug`**；高/低两份去掉心情段后 `system` **逐字相同** |
| 幂等 | 同一时刻第二次评估：`signals.length` 1 → **0**，state 不变（(0.56, 0.52)） |
| 查看/复位 | `engine.reset()` 回中性；历史里**有**一行 `reset=true`（`note="心情复位：t7 探针"`、`before=(0.56,0.52)`）；`moodSnapshot()` 与 `moodHistory()` 同瞬间一致；`moodSchemaVersion()=1`；设置 `{enabled:true, decayPerHour:0.075, decayCap:0.6, maxSignalsPerBeat:8}` |

**反事实（证明「读路径也夹」不是空话）**：把同一张表里的行键改成别的值（`mood.elsewhere`）后读到的是 `undefined`，而库里的**裸行**确实是 `(5.5, −3)` —— 也就是说夹取真的发生在 `store.mood()` 那一层，不是「写进去时就夹好了所以读什么都一样」。

## 3. 三类证据的划分（本报告怎么用它们）

| 类 | 本报告里的例子 | 我用它做什么 |
|---|---|---|
| **实现者输出** | `node scripts/eval-proactive-timeline.ts`（exit 0、1654 s、多日 8/8/11 等）、`--compare` 的统计段、`node --test tests/unit/core/topic-engine.test.ts …`（25/25） | 只作**旁证与对照**；凡与我的复算不同，两边都写出来并说明差异来源（§2.1 末、§5.6） |
| **我的复算** | `t7-timeline-probe.ts`、`t7-topic-probe.ts`、`t7-mood-probe.ts`、`t7-mood-reset-probe.ts`、我新跑的 3 批真实语音（产物 `data/voice/bench/t7-legacy-batch1|2|3.txt`） | 判定数字全部来自这里 |
| **代码或产物证据** | `git diff --stat 415f473..e782c2c`（四块生产代码未变）、`git diff --name-only`、`git show 1e08e5f^:…`（升级前源码）、`Object.keys(ProactiveGateContext)`（无心情字段）、`scripts/voice-turn.ts:490` 的字面字符串、各产物文件哈希与时间戳 | 用来证明「哪一份代码在跑」「某个字段真的不存在」「哪句话是写死的」 |

**没有做的事（不假装）**：没有走真实模型看「她说什么」（时间线只验证「要不要说」）；没有真人观感（心情那一条不含 A/B）；没有测新麦克风/扬声器；没有把 `data/` 下的探针提交入库（它们在 `.gitignore` 覆盖的目录里，第一引用永远是 §7 的命令）。

## 4. 我自己踩到/核到的坑（都会影响判读，写下来）

### 4.1 API 抖动是真的能把同一件事测成两个结论

我的 3 批里，② 的 P50 从 **1660 ms** 跳到 **8162.5 ms**（同一天、同一批夹具、同一份代码）。**所以「④ 是目标的几倍」这句话只能与批次一起写**：我的三批给 3.63–7.33 倍，t9/t11 的五批给 3.14–3.95 倍，**混在一起说「4 倍左右」会把一个近 4 倍的跨度藏起来**。本机 `docs/handoff.md` §4「必须先知道的坑」第 5 条早已记过「同一份代码首字 0.3–1.2 s 到 7–18 s」。

### 4.2 「是目标的几倍」有两种算法，差 0.2–3.6 倍

handoff 的「**3.14–3.95 倍**」是前五批的**逐批**区间，「**合并 n=20 为 3.51 倍**」是前五批的**池化**比值 —— 前者是「每批各自算完取区间」，后者是「把所有轮放在一起取 P50 再除」。**8 批一起看**：池化 ④ P50 = 5597.5 ms → **3.73 倍**，逐批区间 **[3.14, 7.33]**。两种算法在同一批数据上可以差很多（我的三批逐批 3.63–7.33、池化 3.66），所以引用时必须写明用的是哪一种、以及**是哪几批**（细节与脚本见 §2.3 那张表）。

### 4.3 「27.3%」与「54.5%」是两种降频算法

`eval-proactive-timeline.ts` 的 M4 用「第 3 天 8 vs 11 = 少说 27.3%」，我自己的 3 天合计是 **15 vs 33 = 少说 54.5%**（逐日 5/5/5 vs 11/11/11）。**两者都对，但不可互换**（一个看单日、一个看整段）。引用时写清是哪一个。

### 4.4 `moodBias` 的读数直觉（如实记录，不是缺陷判定）

`moodBias = clamp((v−0.5) + (e−0.5), −1, 1)`（**不是平均**）。后果：`(1, 0)` 与 `(0, 1)` 都读成 **0 = 完全中性**，而 `(0, 0)` = −1、`(1, 1)` = +1。也就是说「心情很好但很累」在语气与主动性上**不带任何偏移**。上界仍然安全（±1 被夹住），影响只是**幅度不满幅**。这一条我只作观察，**没有判成缺陷**（`mood.ts:461` 的注释写「平均」，与代码不完全一致，见 §5.5）。

## 5. 我核实后必须记下来的问题（按严重度）

### 5.1 `scripts/voice-turn.ts:490` 仍写死「方向多数为正」（**这不是笔误，是每批产物都会带出去的一句话**）

> **2026-10-03 追记：本条已由 t21 修复**（`note` 不再预置结论句）。下面保留复验当时的记录，因为「产物里曾经带着一句与同次计算打架的结论」这件事本身值得留下；引用产物时仍按 §8 的命令现算，别引用产物里的 `note`。

**证据（代码）**：`scripts/voice-turn.ts:490` 的字面字符串 = 「同批对照的降幅跨批不可复现（三次独立批次符号都不一致），所以只能写「方向多数为正、幅度不可复现」，不给单批百分比当结论。」
**证据（产物）**：我新跑的三批产物里，`latency.note` 原样带着这句；而**同一次运行的** `--compare` 统计段算出来的是「**方向不一致**（3 快 5 慢）」。
**为什么这件事重要**：`docs/handoff.md:49-50` 现在明确写「**不许写「方向多数为正」**」，而任何一个打开**产物文件**的人会读到相反的一句。t9 修的是 `voice-turn.ts` 里 `--compare` 那条路径（`voice-latency.ts` 的部分），这句 `note` 漏了。
**建议（不在我的 inScope 内）**：把这句删掉或改成「见 `--compare` 的计算结果」，别在产物里预置结论。

### 5.2 `scripts/lib/voice-latency.ts:296/:333` 把 ② 的地板写死成「约 1.7–2.0 s」

> **2026-10-03 追记：本条已由 t21 修复**（② 与 ③ 的地板改成由传入产物计算）。下面的记录保留作历史；
> 现算口径是 5 批 ② 中位 1636 ms、区间 904–2363 ms（③ 中位 1882 ms、区间 1393–2391 ms），
> 与我这里的「8 批逐批 903.5–8162.5 ms」量级一致（差别在于我那八批里含一批 8162.5 ms 的极慢批次）。

**证据（代码）**：两处字面字符串（还有 `:34` 的英文注释）都是写死的「② 模型首 token，P50 约 1.7–2.0 s」。
**证据（我的实测）**：我三批的 ② P50 = **8163 / 7517 / 1660 ms**；八批合计的**逐批 ② P50 区间 = [903.5, 8162.5] ms**（池化 ② P50 = 1784 ms），其中**最近三批里有两批超出这个「地板」**（8163、7517），一批还低于它（1660）。逐批数字见 `data/verification/t7/t7-compare-8.txt`（`②` 行）与我自己的 `data/verification/t7/t7-ratio-checks.txt`。
**怎么读**：这句对**前五批**基本成立（1560/2108/2363 + 903/1543 附近的量级），但它是**写死的**，所以在新批次（尤其限流时）会与同一次运行的其他行打架。**这不影响「④ 的下界由 ② 与 TTS 往返一起卡住」这条结论**（我的三批同样支持：② 至少 1660 ms > 1500 ms）。
**后果**：写死的数字会再漂（AGENTS §9.18 已记过「能推导的别写死」）。
**建议**：把这两个数字改成计算值（`comparison.streaming.ttft` 的最小/最大值），或至少写成「本机历史观测区间（n=…）」。

### 5.3 心情的时间戳有两种写法，会让 `moodHistory()` 的排序错位（**已用探针复现**）

**证据（我的复算，`data/verification/t7/t7-mood-reset-probe.ts`）**：先走生产路径 `engine.reset('probe:offset', at)`（`+08:00` 写法），再走同一张表上的 `store.resetMood('probe:zulu', at.toISOString())`（`Z` 写法），随后 `moodHistory(10)` 的行序（老→新）是：

```text
2026-10-01T02:00:00.000Z (reset=probe:zulu)  →  2026-10-01T10:00:00.000+08:00 (被夸了一句×1)  →  2026-10-01T10:00:00.000+08:00 (reset=probe:offset)
```

Z 那行**按真实时间是三行里最新的一条**，却被排到了**第 1 位**（`moodHistory` 用 `ORDER BY created_at DESC` 的**字符串序**：`'2…Z' > '1…+08:00'`）。生产路径（`toOffsetIso`）在同一张表里排序正常 —— 探针里生产那行就落在末位。
**为什么生产路径没暴露**：`MoodEngine.reset()` 走的是 `toOffsetIso`（`+08:00`），三个调用点（`mood-engine.ts:217`、`tests/integration/mood-state.test.ts:143`、`tests/unit/domain.test.ts:671`）都传带偏移的字符串，**所以今天是对的**；只有「`store.resetMood(reason, at?: string)` 被传一个 `Z` 写法」这一种用法会翻。
**影响**：状态本身不坏（还是回中性），坏的是「**她为什么突然平静了**」的审计读法（第一条读到的不是最近那一条）。
**建议**：`resetMood` 的 `at` 参数改成收 `Date`（内部 `toOffsetIso`），或在 `recordMood` 里统一规范成同一种写法。**两条都动生产代码，不在我的 inScope 内**。

### 5.4 「热度贴到上界 + 精力贴到下界」读成完全中性（§4.4 的机制后果）

上面两条合起来：`bias(1,0) = 0`。如果期望是「心情很好但累 → 略有正向语气」，现在拿不到；如果期望就是「两维互相抵消」，那没问题 —— **这是一个产品口径问题，我只记录，不判缺陷**。

### 5.5 `packages/domain/src/mood.ts:461` 的注释写「平均」，代码是**相加后夹**

**证据（代码）**：`const bias = (safe.valence - 0.5) + (safe.energy - 0.5);`（没有 `/2`）。注释说「两个维度减去中性后的平均」。
**影响**：不影响有界性（`Math.max(-1, Math.min(1, …))`），只影响读代码的人对幅度与中性带的判断（§4.4）。**建议**：改注释或改公式，二者取一。

### 5.6 接受率有两种读法，引用时必须写明

我 B 场景（三天没人回应）的「接受率 20%」**不是**「有人回她那句话」：我按生产口径统计（一次开口之后 `unanswered_window_minutes` 分钟内**出现过用户轮次**就算接受），而那 20% 来自脚本自己排定的家常发言正好落在窗口内。实现方脚本的同名指标在 `multi-unanswered` 上是 **0%**，因为它的场景里三天没有任何用户发言。**两个数都对，口径不同**；引用任何接受率都必须写明「接受」的定义。

## 6. 我没测的 / 局限（不假装通过）

1. **话题 id 与跳天条数不逐次复现**：跨天追问的 id 依赖事件时间戳（`thread_<hash>`），我复跑到的是「6 次 / 2 次」，实现方跑的是「10 次 / 4 次」。**判定只看 M1–M6 与结论（跳天路径成立、未回应后不硬停）**，条数要带批次写。
2. **tick 粒度不是生产值**：我用 120 s（实现方多日段也是 120 s，单日段用 60 s），生产是 30 s。t9 已记过「tick 粒度对次数不敏感、但会低估『对话进行中』命中数」，我复核后同意，**没有重跑 30 s**。
3. **首音的三批是我今天跑的**：与 t9/t11 的五批**不是同一时段**（今天 08:48–08:58）。本报告的 ④ 区间与方向统计都按「8 批并列」给，**任何单批的绝对值都不要拿去当「现在有多快」**。
4. **没有真实模型 A/B**：心情只测了「进提示词的形态」与「有界性」，没测「这样说话更像人多少」。
5. **硬底线只测了 7 组输入**：静默时段/隐私/场景/对话中/DND/白天放行 + 心情高低两侧；**没有**把额度（当日/6 小时）也做成心情两侧的对照（额度那条在实现方脚本里已有 F4 探针，我这次没重复）。
6. **探针在 gitignored 目录**：`data/verification/t7/` 与 `data/voice/bench/t7-*` 都不随仓库分发（换机器即失）。所以本报告的**第一引用是 §7 的命令**，产物只作附件；探针要重建时按 §1 的表照做（都只 import 生产件）。
7. **有一次进程重叠**：话题探针（08:32:13，13 s）与 `eval-proactive-timeline.ts`（08:12:17–08:39:50）的后半段同时在本机跑。两者都用系统临时目录、互不读写对方的库，但**CPU 是共用的**；我的话题探针是一次纯判定的短跑（91 组 + 反事实），**判定不依赖时间**（时间由探针自己注入），所以结论不受影响。**语音的三批没有重叠**（都在时间线命令结束之后跑的）。

## 7. 队长简报里那几件事，我看到的现状（**不重复别人的转述：只写我自己核到的**）

| 简报里的说法 | 我自己核到的 | 怎么核的 |
|---|---|---|
| 「同批对照结论已作废：不写方向多数为正，写方向不一致 + 区间」 | **属实**。我自己 3 批并入 8 批后算出来就是「3 快 5 慢、−16.1% 到 +27.3%」；`docs/handoff.md:49-50` 也已改成「不许写方向多数为正」 | 见 §2.3；`node scripts/voice-turn.ts --compare <8 份产物>` 的输出逐格 |
| 「1.5 秒倍数更正为 3.14–3.95（合并 n=20 为 3.51）」 | **前五批范围内属实**（逐批 / 池化两种算法，见 §2.3 的表）；但**我的三批更高**（3.63、6.86、7.33） | `t7-ratio-checks.ts` 对 8 份产物 |
| 「B1 是 known blocker，正在修（t20）；不要把流式逐块播放写成已验收」 | **我接手时（415f473）B1 确实在**：`serve-chat.ts` 与 `voiceStreamEvents` 各发一次 clause 事件。**我复验期间 t20 已修并提交（`50a7c7f`，只动 `scripts/serve-chat.ts` + 两个测试文件 + handoff）**，修法是 `sentClauses` 跳过已发的前 N 条，并加了路由级断言与突变验证 | `git diff --name-only 2d92b80..50a7c7f`；提交信息里的真进程证据（序号 `[0,1]`、`sentClauses=0` 时红） |
| 「B2 按用户裁定只记录不修」 | **没修**（`docs/handoff.md:56-57` 记为「失败块不推进 cursor、后继已成功的块被憋到 `flush()`」）；**我没有独立复现 B2** | 读 handoff 与提交信息；**这一条我只能算「别人已记录」，不算我的证据** |
| 「`clause 2 is dispatched…` 那条 flaky 已由 t15 修（12 次全绿）」 | **我跑不到它红**：`npm test` 一次 **470/470、0 fail、exit 0**、34.3 s（`ℹ duration_ms 34343.2329`） | `data/verification/t7/t7-npm-test.txt` |

**关于流式逐块播放的措辞（我建议）**：写「**接线成立 + B1 已修（`50a7c7f`，真进程路由断言 + 突变验证）**，**B2 是已知未覆盖缺陷（失败块不推进 cursor）**」——**不要**写「流式逐块播放已验收」，因为我这一轮**没有**做端到端真人听感/浏览器实测，B2 也没有被任何用例钉住「后继块何时发出」。

## 8. 复现命令（原样可跑，全部在仓库根；离线的不花钱）

```powershell
# ---- ① 多日时间线（我自写，364 s，离线）----
node data/verification/t7/t7-timeline-probe.ts

# 实现方判定命令（1654 s，离线；多日 4 场景 + M1..M6）
node scripts/eval-proactive-timeline.ts

# ---- ② 话题收口判据（我自写，13 s，离线；含升级前整份源码的反事实）----
node data/verification/t7/t7-topic-probe.ts

# 实现方的两条测试命令（25 项，离线）
node --test tests/unit/core/topic-engine.test.ts tests/integration/open-thread-followup.test.ts

# ---- ③ 首音延迟（真实调用、花钱；一批 56-65 s）----
node scripts/voice-turn.ts --wav tests/audio-fixtures/direct-question.wav --wav tests/audio-fixtures/followup-turn.wav --wav tests/audio-fixtures/longer-turn.wav --wav tests/audio-fixtures/tv-dialogue.wav --trace --out data/voice/bench/t7-legacy-batch1.txt
# 复算（不调 API、不需要 key）
node scripts/voice-turn.ts --compare data/voice/bench/t9-legacy-batch1.txt data/voice/bench/t9-legacy-batch2.txt data/voice/bench/t11-batch1.txt data/voice/bench/t11-batch2.txt data/voice/bench/t11-batch3.txt data/voice/bench/t7-legacy-batch1.txt data/voice/bench/t7-legacy-batch2.txt data/voice/bench/t7-legacy-batch3.txt

# ---- ④ 心情（我自写，5 s + 2 s，离线）----
node data/verification/t7/t7-mood-probe.ts
node data/verification/t7/t7-mood-reset-probe.ts

# ---- 产物 → 统计（只读；把批次产物里的四段与逐轮配对打印出来）----
node data/verification/t7/t7-batch-stats.ts data/voice/bench/t7-legacy-batch1.txt data/voice/bench/t7-legacy-batch2.txt data/voice/bench/t7-legacy-batch3.txt
node data/verification/t7/t7-ratio-checks.ts data/voice/bench/t9-legacy-batch1.txt data/voice/bench/t9-legacy-batch2.txt data/voice/bench/t11-batch1.txt data/voice/bench/t11-batch2.txt data/voice/bench/t11-batch3.txt data/voice/bench/t7-legacy-batch1.txt data/voice/bench/t7-legacy-batch2.txt data/voice/bench/t7-legacy-batch3.txt

# ---- 门禁（我实跑：470/470、96 份、exit 0）----
npm test
npm run check:docs
```

**探针重建说明**：`data/verification/t7/` 下的 8 个只读脚本与 `data/voice/bench/t7-legacy-batch*.txt` 都在 `.gitignore` 覆盖的目录里；它们**只 import 生产件**（`@xixi/domain`、`@xixi/conversation`、`@xixi/brain-adapter`、`scripts/field-test.ts` 的 `ProactiveLoop`、`scripts/lib/harness.ts` 的 `loadConfig`），没有另写引擎，按 §1 的表照做即可。反事实用的「升级前源码」是 `git show 1e08e5f^:packages/conversation/src/topic-engine.ts` 的产物，不依赖任何一次运行的偶然状态。

## 9. 判定（对 t7 的三条验收逐条）

1. **四条各给独立复算的判定，每个数字附可复跑命令**：见 §2.1（多日 12/12/12 vs 5/5/5 vs 11/11/11、接受率、来源分布、降频 54.5%）／§2.2（0/91、15/15、边界两句、反事实 9/91）／§2.3（三批 ④ P50 5442.5–10994 ms、逐批 3.63–7.33 倍、8 批方向不一致）／§2.4（0 越界、±6%、±0.03、门禁同码、散文扫描）。**判定：四条都给了；其中 ③ 我判「未达标（目标不可达）」，① 在「= 0 硬停」这一更严口径下也**不成立**（按「显著降频」口径成立，与 round3 的结论一致）。**
2. **报告写进 `docs/verification` 并区分三类证据**：本文件在 `docs/verification/t7-round5-independent-verification-2026-10-03.md`；三类证据的划分与各自用途见 §3，正文里逐处标注了【实现者输出】【我的复算】【代码或产物证据】。
3. **结论如实：未达标写未达标，不得把预期或快照写成已验证**：§0 的表里 ③ 写成「未达标（目标不可达）」，① 的「= 0」写成「不成立」；§5 把 5 个问题写成「我核实后记下来的」（含两处**工具自己打印的错误结论**与一处已复现的排序错位），并明确「建议的修法都不在我的 inScope 内」；§6 把没测的六件事逐条写明。**没有把任何预期、单次运行或快照写成已验证。**
