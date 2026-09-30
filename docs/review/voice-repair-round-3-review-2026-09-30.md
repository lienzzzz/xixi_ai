# 评审（round 3）：噪声语音前端文档的三处订正与口径统一（t38，对 t24 复审 F1a/F1b/F2）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t24 与 t38 的实现者）
> 日期：2026-09-30
> 评审对象：t38「repair-round-3」（修我在 t24 复审里提的 F1a/F1b「`docs/design/voice.md` 的 3 dB 档陈述与同文档表格、实测三者不一致」与 F2「『离线与真实 ASR 值相同』是无法核对的全称断言」），交付修订号 **`90452e9`**（该文件最后一次改动就在这个提交；`git diff 90452e9..HEAD -- docs/design/voice.md` 为空）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`docs/design/voice.md`（§1.1(6) 成功边界块与表格、§6 观测）、`scripts/verify-voice-noise.ts`（`vadEndpointDelayMs` 的算式与 `--out` 分支）、`data/voice/verify-voice-noise.json`（真实 ASR 产物，只读）、`frontend-vad-grid.json`（历史网格，只读）、`services/voice-edge` 的 `voice_edge.segment` CLI，以及**我自己跑的 5 组命令**（含一次不花钱的 6 档离线复现，见 §6）
> 上一轮血缘：本任务复核的 findings 由我在 t24 复审里提出（`docs/review/voice-repair-round-2-review-2026-09-30.md`）

---

## 1. 结论

**verdict：pass（无 blocking finding；3 条观测记在 §5，不改变判定）**

一句话：**t38 的三处订正我逐条独立验证成立，而且这次是「不花钱就能核对」的**——我自己跑了一次**全 6 档离线复现**（`--fake --tiers 999,18,6,3,0,-6`）：3 dB 档 4 条逐条 **104 / 128 / −64 / 96**（最大 128、均值 66），与文档的**成功边界块、表格行、测量约定重述**三处逐字一致；`1088` 在全文出现 8 次，**没有一次**被当作「3 dB 档的值」（5 次是 6 dB 档 `tv-dialogue` 的合法值、3 次都明确标注为「修复前的历史记录」）；F2 那条全称断言已收窄（`完全相同` / `两次运行` / `只有 1 条` 全文各 **0** 次），改成**代码依据 + 一条不花钱的复核命令**，我按代码路径核对了算式，并把它与盘上那份**真实 ASR 产物**逐条对比：**24/24 条 `vadEndpointDelayMs` 与我的离线结果完全相同**——所以「离线这一列就是真实 ASR 会得到的值」这句话现在是**可核对且为真**的。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 明确 verdict + findings（含文件与行号） | **满足** | pass；无 finding，3 条观测见 §5 |
| 2 F1a/F1b 独立核对：读文档 3 dB 档陈述与表格，并**实跑一次离线端点延迟**，确认与「104/128/−64/96 这一组」一致 | **真正满足** | 我跑 `node scripts/verify-voice-noise.ts --fake --tiers 999,18,6,3,0,-6 --out …`（exit 0）：3 dB 档 `direct-question 104 / followup-turn 128 / longer-turn −64 / tv-dialogue 96`；档内汇总 `meanVadEndpointDelayMs=66`、`maxVadEndpointDelayMs=128`。文档三处（§1.1(6) 成功边界块、表格 3 dB 行、§6 测量约定重述）写的都是同一组，**逐字一致**；表格的「均值 66 / 最大 128」「0 dB 均值 −62」等派生值我也复算过 |
| 3 F2 独立核对：确认「离线与真实 ASR 值相同」现在**可核对**（有可提交的数字/修订号，或措辞已收窄到只声称已记录的部分） | **真正满足（两条路都给足了）** | ① **代码依据**：`scripts/verify-voice-noise.ts` 里 `energyEndMs = segmentation.energyEndMs ?? cleanEndMs`、`vadEndpointDelayMs = Math.round(speech.endMs − energyEndMs)`——只用到 VAD/能量门限两个量，转写不参与（我读了算式，与文档所述一致）；② **盘上证据**：`data/voice/verify-voice-noise.json`（`mode: "real-asr"`、26317 B、sha256 `B2E5367D…A3C4`）的 `clips[].vadEndpointDelayMs` 与我这次离线复现**24/24 条逐条相同**（含 6 dB 的 1056/1376/1472/1088 与 3 dB 的 104/128/−64/96）。措辞侧：`完全相同` / `两次运行` / `只有 1 条` 全文各 **0** 次 |
| 4 同类断言抽查（抽查至少三处，例如「完全相同」「唯一」「只有」） | **满足（我查了 6 类、含逐条枚举 1088）** | `完全相同`=0、`两次运行`=0、`只有 1 条`=0；`唯一` 仅 1 次且讲的是夹具生成器脚本（与测量无关）；`恒为` 2 次都是历史/否定句（「修复前这一列恒为 0」「不再恒为 0」）；`1088` 8 次**全部**合法或已标注历史；另用 `python -m voice_edge.segment` 交叉复核 6 dB `direct-question` → `endpointDelayMs 1056.0`，与文档「两条命令能各自复现」一致 |
| 5 自己跑一次 npm test 与 check:docs 并贴结果；结论落 `docs/review/voice-repair-round-3-review-2026-09-30.md`，含结论表与 findings 清单 | **真正满足** | `npm test` → **180 / 180 / 0 fail / 0 skipped，exit 0**（壁钟 13.8s，工作区干净，修订号 `d38b4ba`）；`npm run check:docs` → **48 份 markdown、0 问题、exit 0**；本文件即结论落点 |

**范围纪律**：t38 只改了 `docs/design/voice.md`（`git show 90452e9 --stat` 里这份文档 12 行；同提交另含 `AGENTS.md` 与我的 t27 报告归档，都是队长落笔）；本轮我**只新增本文件**，另有一次**只读**的离线复现（用 `--out` 写到 `data/` 临时路径，没有触碰 `data/voice/verify-voice-noise.json`——脚本本身也把 `--fake` 的产物与真实产物分开命名）。

---

## 2. F1a / F1b：3 dB 档的「文档 ↔ 表格 ↔ 实测」三方对齐

我这边的实测（`node scripts/verify-voice-noise.ts --fake --tiers 999,18,6,3,0,-6`，`mode=offline-plumbing`、`verdict=PIPELINE-OK`、exit 0，逐条值取自 `clips[].vadEndpointDelayMs`）：

| SNR 档 | 我的逐条值（4 条夹具顺序：direct-question / followup-turn / longer-turn / tv-dialogue） | 文档写的 | 一致？ |
|---|---|---|---|
| 干净 | 728 / 704 / 864 / 704（均值 750、最大 864） | 728 / 704 / 864 / 704（均值 750、最大 864） | 是 |
| 18 dB | 640 / 640 / 640 / 640 | 640×4 | 是 |
| 6 dB | 1056 / 1376 / 1472 / 1088（均值 1248、最大 1472） | 同 | 是 |
| **3 dB** | **104 / 128 / −64 / 96**（均值 66、最大 128） | 同（成功边界块、表格行、§6 重述三处） | **是** |
| 0 dB | 72 / −32 / −352 / 64（均值 −62、最大 72） | 同 | 是 |
| −6 dB | 4 条全部未检出（无值） | 「0 条（全部漏检）」 | 是 |

**关于 `1088` 的逐处审计（这是 t24 F1a/F1b 的核心病灶）**：全文 8 次出现，我逐条看了上下文——

- 合法值（6 dB 档的 `tv-dialogue`）：§1.1(6) 的复现命令说明、表格 6 dB 行、§1.1(6) 的「当前实测」段、§6 的测量约定重述、§6 的观测条目，共 5 处；
- 标注为历史（`frontend-vad-grid.json` 里 3 dB 档修复前只有 `direct-question` 一条有效）：表格下方的「与历史网格的差异要说明」段与成功边界块括号，共 3 处，且都写了「以当前实测为准」。

即：**没有任何一处把 1088 写成 3 dB 档的当前值**，这正是我在 t24 要求订正的两条（F1a 的「单值 1088」与 F1b 的「干净档 600/512/512/480」）已经消失的证据。

---

## 3. F2：从「无法核对的全称断言」变成「代码依据 + 可复现命令 + 盘上对照」

t24 的 F2 说的是：原文声称「离线与真实 ASR 两次运行给出完全相同的值」，而当时**没有留下可提交的两次运行记录**，谁也无法核对。t38 选的是「收窄 + 给证据」，我按下面三条独立核对：

1. **代码路径**（读 `scripts/verify-voice-noise.ts`）：`const energyEndMs = segmentation.energyEndMs ?? args.cleanEndMs;` 与 `const vadEndpointDelayMs = speech === null || energyEndMs === null ? null : Math.round(speech.endMs - energyEndMs);`——输入只有 VAD 分段与校准能量门限；`transcript` / `similarity` / `asrMs` 都不参与这个数。**文档那句「端点延迟只由 VAD + 能量门限决定，与 ASR 无关」属实。**
2. **盘上真实产物**（只读）：`data/voice/verify-voice-noise.json` 是 `mode: "real-asr"` 的完整报告（24 条夹具），`boundary.lowestPassingTierDb = 3`（与文档成功边界块一致）。它的 `clips[].vadEndpointDelayMs` 与我这次离线复现**逐条相同**（24/24），所以我可以说：「同一批夹具逐条值与离线一致」这句**是真的、而且当场可核对**。
3. **措辞收窄**：`完全相同`=0、`两次运行`=0、`只有 1 条`=0；取而代之的是「代码依据 + `node scripts/verify-voice-noise.ts --fake --tiers 6` 这条不花钱的复核命令 + 指向盘上产物」。**离线与真实边界也分得清**：脚本文本自己写着「（离线模式：以下边界只用桩 ASR 计算，不代表真实噪声鲁棒性）」，文档 §1.1(6) 的成功边界块用的是真实产物里的 3 dB，两处不会互相冒充。

---

## 4. 我自己跑的非花钱复现（原始结果）

`node scripts/verify-voice-noise.ts --fake --tiers 999,18,6,3,0,-6 --out <临时文件>` →

- `EXIT=0`；`mode=offline-plumbing`；`verdict=PIPELINE-OK`；
- `seed.tiers = [999,18,6,3,0,-6]`、`seed.fixtures` 4 条、`seed.similarityThreshold=0.6`、`seed.maxEndpointDelayMs=1500`；
- `boundary.lowestPassingTierDb = 0`（**离线桩 ASR** 的边界，脚本文本已声明不代表真实鲁棒性）、`passingTiers = 18dB/6dB/3dB/0dB`、`failingTiers = -6dB`；
- 档内汇总：干净 `meanVadEndpointDelayMs=750 / max=864`；6 dB `1248 / 1472`；3 dB `66 / 128`。

## 5. 观测（不改变 verdict）

- **O1（产物 vs 命令的耐久性）**：F2 的第二条证据（`data/voice/verify-voice-noise.json`）在 `data/` 下，而 `data/` 是 gitignored——**换台机器/重新 clone 后它不存在**。文档的写法已经足够诚实（先说代码依据、再给不花钱的复核命令、最后才提「盘上也留了一份」），所以我不判 finding；但建议今后这类「两份运行一致」的结论，**第一个引用的一定是那条能重跑的命令**，本地产物只当附件。这一点与 §9.18「能推导的就别写死」同源。
- **O2（派单文本）**：t38 如实报告「收到的 acceptance 被截断成 3 条、inScope 混进非路径片段」（团队状态里实际 7 条）。这正是 §9.19 已经定下的硬约束；本轮 t38 的处理（去读真实契约、按 7 条逐项回报）是对的，**记在案避免误判成成员越权**。
- **O3（离线边界与真实边界的区分，已核对无问题）**：离线模式的 `boundary.claim` 会写「≥0 dB」（桩 ASR 抬高相似度），文档的**可复现成功边界**却写 3 dB（真实产物）。两者并存不矛盾：脚本自己给离线文本加了「不代表真实噪声鲁棒性」的前缀，文档 §1.1(6) 也只用真实产物的 3 dB，并说明该 `claim` 由脚本自动写入、只声明三件事。**无需改动**，记录在此以防后来读者误以为冲突。

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node scripts/verify-voice-noise.ts --fake --tiers 999,18,6,3,0,-6 --out <data/ 临时路径>` | exit **0**；`PIPELINE-OK`；6 档 24 条 `vadEndpointDelayMs` 全部取出并与文档逐条比对一致（见 §2） |
| `python -m voice_edge.segment tests/audio-fixtures/noisy/direct-question-snr6db.wav`（`voice-pipecat` venv，cwd=`services/voice-edge`） | exit 0；`segments[0].endpointDelayMs = 1056.0` → 与文档「两条命令能各自复现」一致 |
| 只读 `data/voice/verify-voice-noise.json` | `mode: "real-asr"`、`boundary.lowestPassingTierDb = 3`、24 条 `vadEndpointDelayMs` 与离线逐条相同；sha256 `B2E5367DA503D3EDC4AA8EABBF4C8085301EA01DA5F21E3809352CEEC8DFA3C4` |
| `npm test` | **tests 180 / pass 180 / fail 0 / skipped 0**，exit 0（壁钟 13.8s；修订号 `d38b4ba`，工作区干净） |
| `npm run check:docs` | 检查了 **48 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |
| 文本审计（grep `docs/design/voice.md`） | `完全相同`=0 / `两次运行`=0 / `只有 1 条`=0；`唯一`=1（夹具生成器，无关）；`恒为`=2（历史/否定）；`1088`=8（5 处 6 dB 合法值 + 3 处明确标注历史）；`1173`=0 |

**我做过的真实外部动作**：**0 次 API 调用**（全部走 `--fake` 离线桩与本地 Python，不花钱）、未开摄像头/麦克风录制、未写业务数据库；`data/voice/` 下既有产物未被改写（`--fake` 的产物另名，且我显式用了 `--out`）；**本轮没有任何突变或改动实验（全程只读）**。
