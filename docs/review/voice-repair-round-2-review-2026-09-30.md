# 评审（round 2）：语音修复 round 2（t23，对 t7 findings F1–F5）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t7 评审者与 t23 实现者）
> 日期：2026-09-30
> 评审对象：t23「repair-round-2」（修 t7 评审的 F1 文档出处/列名、F2 端点延迟截断与判据不可达、F3 注释矛盾、F4 表头方向、F5 校准产物无调用方）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`docs/design/voice.md`、`scripts/verify-voice-noise.ts`、`services/voice-edge/voice_edge/frontend.py`、`data/voice/frontend-vad-grid.json`、`data/voice/verify-voice-noise.json`、`data/voice/highpass-response.json`，以及**我自己跑的 `--fake` 两次（默认门限 + 构造超限）**
> 上一轮血缘：本任务复核的 t7 findings 由我在 t7 评审里提出（见 `docs/review/voice-implementation-review-2026-09-30.md`）

---

## 1. 结论

**verdict：needs_revision（F2/F3/F4/F5 四项修复我逐条验证成立；F1 的「出处 + 列名 + 6 dB 逐条值」也已修对，但文档里留下了 2 处与它自己的表、以及与当前实测直接矛盾的 3 dB 陈述 —— 都是「一句话」级别的订正）**

一句话：**核心问题真的修好了**——`ENDPOINT_DELAY` 判据不再是结构上不可达的死判据（我用 `--max-endpoint-delay 50` 让它当场报警、`PIPELINE-BROKEN`、exit 1；默认 1500 时 6 dB 档报 1056/1376/1472/1088，与网格逐格一致）；F5 的「校准产物没有运行路径」也如实写进文档（我 grep 确认 `load_calibrated_params` 仍只有定义没有调用方，唯一调用点在测试里）；F3/F4 与实测/来源一致。剩下的问题只在一个地方：`docs/design/voice.md` **表里的 3 dB 行已经改成 4 条逐条值（104/128/−64/96）**，但下面两处仍然写着「3 dB 档只有 1 条能算出端点延迟，值 1088 ms」——**同一份文档里自相矛盾**，而且我两处实测（默认门限与超限构造）都复现出 4 条值。

| 维度 | 判定 |
|---|---|
| F1（出处 + 列名 + 措辞） | **主体修好**（出处分了两张表、列名改「逐条值（最大）」、6 dB 均值 1248/最大 1472 与网格逐格一致）；**留下 3 dB 的 2 处自相矛盾** → F1a/F1b |
| F2（端点延迟截断 / 判据不可达） | **真正修好**（§3：实测 4 条值 + 判据可触发） |
| F3（`frontend.py` 注释与实测矛盾） | **真正修好**（注释按 `highpass-response.json` 改写，并写明旧说法错在哪） |
| F4（表头方向） | **处理正确**（t23 逐格复核后确认未反，改为无歧义表头 + 附原始格值；我逐格复算一致） |
| F5（校准产物无调用方） | **如实写明且与事实一致**（§4） |
| 门禁（我自己跑） | `npm test` **139/139**、`npm run check:docs` **exit 0** |
| 范围纪律 | 只改声明过的 3 个路径（`voice.md`、`verify-voice-noise.ts`、`frontend.py`），无越界 |

---

## 2. 逐条核对 t23 的 7 条验收标准

| # | 条款 | 判定 | 我的核对方式与结果 |
|---|---|---|---|
| 1 | **F1**：`voice.md` 的边界表出处与列名改为真实来源；列名「逐条值（最大）」；18 dB 逐条皆 640；6 dB 1056/1376/1088/1472（均值 1173，不是 1472）；3 dB 仅 1 条有效 1088；同步 :213 与 §6 | **主体修好，附 2 处矛盾** | 出处：`:233-245` 明确区分「相似度/检出/判定来自 `verify-voice-noise.json`」与「端点延迟/起点来自 `clips[].vadEndpointDelayMs`」，并写明旧的 `tiers[].meanEndPointDelayMs` 是 0/0/0/−16/−96/null（我 t7 的实测值）——**这正是我要求改的点，改对了**。列名：`:250` 表头已是「端点延迟逐条值（最大）」。数值：`:253` 18 dB = 640×4 ✓；`:254` 6 dB = 1056/1376/1472/1088 → 最大 1472、均值 **1248** ✓（与我从 `frontend-vad-grid.json` 120 Hz 行逐格读出的一致；条款写 1173 是它自己的算术偏差，t23 用 1248 才对）；`:255` 3 dB 表里是 104/128/−64/96 → 最大 128。**但** `:279` 与 `:290` 仍写「3 dB 档只有 1 条能算出端点延迟，值 1088 ms」→ F1a/F1b。§6 `:427` 已改成逐条值（1056/1376/1472/1088，最大 1472）✓ |
| 2 | **F2**：新增 `vadEndpointDelayMs = speech.endMs − cleanEndMs`（不截断）并用它做判据；ASR 切片仍用 `detectedEnd` | **真正修好（实现口径与条款描述略有差异，见备注）** | 代码 `scripts/verify-voice-noise.ts:288-293`：`const energyEndMs = segmentation.energyEndMs ?? args.cleanEndMs; const vadEndpointDelayMs = Math.round(speech.endMs - energyEndMs)`，判据改成 `vadEndpointDelayMs > maxEndpointDelayMs`；`:264` 的 ASR 切片**仍然**用 `detectedEnd = min(speech.endMs, cleanEndMs)`；`:444-445` 新增 `meanVadEndpointDelayMs` / `maxVadEndpointDelayMs`，旧的 `meanEndPointDelayMs` 保留并注明是截断口径。实测见 §3 |
| 3 | **F2 验证不花钱**：`--fake --tiers 6` 应报 1088–1472 量级（修复前恒 0） | **成立** | 我实跑：`direct-question 1056 / followup-turn 1376 / longer-turn 1472 / tv-dialogue 1088`，`endpointDelayMs`（截断口径）仍全为 0 → 两个口径**并存且可区分**，见 §3.1 |
| 4 | **F3**：`frontend.py:188-190` 的注释按实测改写（只改注释） | **真正修好** | docstring 现在写「the −6 dB point sits **at** the requested cutoff (120 Hz nominal → −6.02 dB @120 Hz)，−9.75 dB @100 Hz、−2.99 dB @150 Hz、500 Hz 以上 <0.03 dB」，并明确「An earlier version of this comment claimed ≈0.65 × cutoff … **that was wrong** — it contradicted the sweep, `voice.md` §1.1（1）and the unit test」。与 `data/voice/highpass-response.json`（120 Hz 档：120 Hz → −6.02 dB、100 Hz → −9.75、150 Hz → −2.99）逐格一致；Python 39 项单测仍全过 |
| 5 | **F4**：`voice.md:127-134` 表头方向按实测/来源修正（数字不动） | **处理正确（且 t23 的「不盲从」是对的）** | t23 逐格复核后认为表头**未反**，于是把表头改成无歧义写法并附原始格值——我复核**同意**：`:172` 表头「夹具（行） | 前端：高通档（列）」，每行显式写夹具名（不再「同上」）；`:181-183` 新增「复核用原始格值」行（`direct-question` 三档都 320/600/128；`direct-question-snr6db` 三档都 448/1056/0；`longer-turn-snr0db` 关 672 / 60 Hz 672 / 120 Hz 384）。我用 `frontend-vad-grid.json` 逐格复算：**数字一个都没改、且都能对上** |
| 6 | **F5**：明确写出「运行路径的高通仍是 120 Hz 常量、`applied` 尚无任何运行路径读取」 | **成立且与事实一致** | 文档 §1.1（2）`:160` 明写「在那之前，本节与 §1.1（2）都只声明『产物可用 + 常量与推导一致』，**不声明『校准已生效』**」。我 grep 复核：`load_calibrated_params` 只有 `frontend.py:820` 的**定义**，仓库里**没有**生产调用方（唯一引用在文档/注释与单测里）；`segment.py` 仍以 `DEFAULT_HIGHPASS_HZ = 120` 为默认（`frontend.py:70` 单一定义）。→ 与 t20 保留的已知边界一致 |
| 7 | `npm test` 全绿（≥120）且 `check:docs` 通过 | **我自己复跑，成立** | `npm test` → **tests 139 / pass 139 / fail 0 / exit 0**；`npm run check:docs` → **40 份 markdown、0 问题、exit 0** |

---

## 3. F2 实跑验证（本任务重点，不花钱）

### 3.1 默认门限：端点延迟不再恒为 0

```powershell
node scripts/verify-voice-noise.ts --fake --tiers 6 --out data/voice/<临时文件>.json
```

实测（`clips[]` 与 `tiers[]` 摘录）：

| 夹具 | `vadEndpointDelayMs`（判据口径，新） | `endpointDelayMs`（ASR 切片口径，旧/截断） |
|---|---|---|
| direct-question-snr6db | **1056** | 0 |
| followup-turn-snr6db | **1376** | 0 |
| longer-turn-snr6db | **1472** | 0 |
| tv-dialogue-snr6db | **1088** | 0 |
| clean 档（4 条） | 728 / 704 / 864 / 704（均值 **750**） | 0 |

`tiers[6dB]`：`meanVadEndpointDelayMs = 1248`、`maxVadEndpointDelayMs = 1472`、`meanEndPointDelayMs = 0`（截断口径保留）。
→ **6 dB 档逐条值与 `data/voice/frontend-vad-grid.json`（120 Hz 行：1056/1376/1472/1088）逐格一致**；修复前这一列恒为 0，现在真的在测东西。

### 3.2 判据结构上可达：构造一次超限

```powershell
node scripts/verify-voice-noise.ts --fake --max-endpoint-delay 50 --out data/voice/<临时文件>.json
```

实测：**exit 1**、`verdict = "PIPELINE-BROKEN"`、`offlineSummary.structuralFailureClips = 17`，逐条失败码形如
`ENDPOINT_DELAY>50ms(1056)`、`ENDPOINT_DELAY>50ms(1472)`、`ENDPOINT_DELAY>50ms(728)`。

**依据（两条都给）**：
- 代码路径：`scripts/verify-voice-noise.ts:292-293` `if (vadEndpointDelayMs !== null && vadEndpointDelayMs > maxEndpointDelayMs) failures.push('ENDPOINT_DELAY>…')`，而它比较的是**不截断**的 `vadEndpointDelayMs`；
- 构造实验：上面这次超限运行真的触发了该失败码并把整体判成 `PIPELINE-BROKEN`。

（默认 1500 ms 下 6 dB 最大 1472 ms，距门限仅 28 ms → 该判据现在是**紧的、可达的**，而不是永远不可能触发的死代码。）

**口径备注（不构成 finding）**：t23 的验收条款写的是 `vadEndpointDelayMs = speech.endMs − cleanEndMs`，而实现用的是 `speech.endMs − energyEndMs`（同一文件的校准门限能量终点，`cleanEndMs` 只作为 `??` 回退）。两者在**本机当前数据上给出同一组值**（因为网格与当前运行的 6 dB 逐条值一致），但口径名与注释应统一，否则下一个人按条款去找 `− cleanEndMs` 会找不到。文档 `:293` 已写明用的是 `energyEndMs`，这点是自洽的。

---

## 4. 我独立复核的三处「与事实一致」

| 项 | 我读了什么 | 结论 |
|---|---|---|
| F4 表头 vs 网格 | `frontend-vad-grid.json` 的 `highpassHz ∈ {0,60,120}` 三档，`direct-question`（320/600/128）、`direct-question-snr6db`（448/1056/0）、`longer-turn-snr0db`（672/672/384） | **三档数字与文档列出的原始格值完全一致**；表头「夹具（行）/ 高通档（列）」与数据布局一致。t23 判定「未反」是对的 |
| F3 注释 vs 扫频 | `highpass-response.json` 的 `response6dbHz`：120 Hz 档在 120 Hz 处 −6.02 dB、100 Hz 处 −9.75 dB、150 Hz 处 −2.99 dB、≥500 Hz <0.03 dB | **逐格一致**；旧注释的「≈0.65×cutoff」确实与实测矛盾，t23 的改写方向正确且保留了「旧说法错在哪」 |
| F5 校准调用方 | `grep load_calibrated_params`：`frontend.py:820` 定义、`calibrate.py:167` 文档字符串引用、文档/单测引用；**没有生产调用方**；`segment.py` 默认仍是 `DEFAULT_HIGHPASS_HZ = 120` | **文档写的「尚无任何运行路径读取」与代码一致**，没有把「已可用」说成「已生效」 |

---

## 5. findings（needs_revision 的依据）

### F1a（low）`docs/design/voice.md:279` 的边界引用块仍写「3 dB 档只有 1 条能算出端点延迟，值 1088 ms」——与同一份文档的表和当前实测都矛盾

- **位置**：`docs/design/voice.md:276-280`（「可复现的成功边界（写死）」引用块内的第 2 句）
- **问题**：`:255` 的表已经把 3 dB 行写成 **104 / 128 / −64 / 96 → 最大 128（均值 66）**，我两次实测（默认门限、以及超限构造那一次）也复现出**4 条都有值**；而 `:279` 仍说「只有 1 条能算出端点延迟，值 1088 ms」。
  `1088` 是**修复前**网格里的历史值（`frontend-vad-grid.json` 的 `direct-question-snr3db`，其余三条为 `null`），文档 `:264-267` 自己也解释过这个差异并写了「以当前实测为准」。所以 `:279` 是漏改的一处遗留，读者拿它去核对会在同一页看到两个互相否定的结论。
- **影响面**：low（不影响任何行为），但它出现在**「可复现的成功边界（写死）」**这个最容易被引用/搬进回报的块里；写死的数字互相矛盾，会直接损害「文档可被逐句核对」的可信度。
- **requiredFix（1 句）**：把 `:279` 改成与表和实测一致，例如：
  「端点延迟不是这个边界的判据**（3 dB 档 4 条逐条值为 104 / 128 / −64 / 96 ms，最大 128；`frontend-vad-grid.json` 里那条 `1088` 是修复前的历史记录，见上表逐条值列）」。
- **复现**：`node scripts/verify-voice-noise.ts --fake --tiers 3 --out <临时文件>` → 4 条 `vadEndpointDelayMs` 均非 null；或读 `data/voice/frontend-vad-grid.json` 的 120 Hz 行（`direct-question-snr3db` = 1088，其余三条 = null）。

### F1b（low）同一处约定在 `:290` 又被重述一遍（同样的 1088 单值说法）

- **位置**：`docs/design/voice.md:289-291`（「端点延迟在噪声下会变晚，而且逐条差异大」那条测量约定）
- **问题**：`:290` 写「3 dB 档只有 1 条可算（1088 ms）」，与 `:255` 的表（104/128/−64/96）和 `:265`（「当前 4 条都有值」）矛盾；同一段的「干净档逐条 600/512/512/480 ms（均值 750）」也与 `:252` 的表（728/704/864/704，均值 750）不一致——**均值对得上、逐条值对不上**，看起来是旧版逐条值残留。
- **影响面**：low（同 F1a，属重复表述处）。两处一起改才不会下一轮又冒出来。
- **requiredFix（2 句）**：把 `:290` 的「3 dB 档只有 1 条可算（1088 ms）」改成「3 dB 档 4 条逐条为 104 / 128 / −64 / 96 ms（最大 128）」；把同段的「干净档逐条 600/512/512/480 ms」改成与 `:252` 一致的「728 / 704 / 864 / 704 ms（均值 750）」。
- **复现**：同 F1a。

### F2（low，性质上是「可验证性」）`:261-263` 声称「离线与真实 ASR 两次运行给出完全相同的值」，但该「真实 ASR 那次运行」的数字在证据文件里还没有落盘

- **位置**：`docs/design/voice.md:259-263`
- **问题**：`:261` 写「**离线与真实 ASR 两次运行给出完全相同的值**……离线 `--fake --tiers 6` 与真实 ASR 都得到 6 dB 档 1056/1376/1472/1088、干净档 728/704/864/704」。这个结论在道理上**是成立的**（`vadEndpointDelayMs` 只由 VAD 段边界与校准门限下的能量终点决定，与 ASR 无关——我读代码确认 `speech.endMs` 与 `energyEndMs` 都不依赖 ASR），但仓库里现存的那次真实运行证据 `data/voice/verify-voice-noise.json` 是 **F2 修复之前**生成的：它里面**没有** `vadEndpointDelayMs` 字段，`tiers[].meanEndPointDelayMs` 还是 0/0/0/−16/−96/null。因此读者**无法**用仓库里的文件核对「两次一致」这句话（要么信文档，要么自己花钱跑一次真实 ASR）。
- **影响面**：low（结论正确、证据缺失）。这条正好是「文档里的实测结论必须能被复核」的边界情况：它把一个**未落盘**的第二次运行写成了断言。
- **requiredFix（二选一，都不需要花钱）**：
  - (a) 把 `:261-263` 改成「端点延迟只由 VAD + 能量门限决定、与 ASR 无关（代码依据：`scripts/verify-voice-noise.ts:288-291` 只用到 `speech.endMs` 与 `segmentation.energyEndMs`），因此 `--fake` 报出的这一列就是真实 ASR 运行会得到的值；**离线一次即可复核**」，并删掉「两次运行都给…」的措辞；
  - (b) 若确实已经跑过真实 ASR，把那份报告（含 `vadEndpointDelayMs`）落到 `data/voice/` 并在文档里点名文件名。
- **复现**：`node -e "const r=require('./data/voice/verify-voice-noise.json');console.log(Object.keys(r.clips[0]), r.tiers.map(t=>t.meanEndPointDelayMs))"` → 现有文件无 `vadEndpointDelayMs` 字段，`meanEndPointDelayMs` 仍为 0/0/0/−16/−96/null。

---

## 6. 我实际跑过的命令与结果（可核账）

| 命令 | 结果 |
|---|---|
| `node scripts/verify-voice-noise.ts --fake --tiers 6 --out <临时>` | exit 0、`PIPELINE-OK`；6 dB 档 `vadEndpointDelayMs` = 1056/1376/1472/1088（`tiers[6dB].meanVadEndpointDelayMs 1248 / maxVadEndpointDelayMs 1472`），`endpointDelayMs`（截断口径）全 0；clean 档 728/704/864/704 → §3.1 |
| `node scripts/verify-voice-noise.ts --fake --max-endpoint-delay 50 --out <临时>` | **exit 1**、`verdict PIPELINE-BROKEN`、`structuralFailureClips 17`，失败码 `ENDPOINT_DELAY>50ms(1056/1472/728…)` → 判据结构上可达，§3.2 |
| 读 `scripts/verify-voice-noise.ts:264/288-293/404-406/444-445` | 截断口径只用于 ASR 切片；判据用不截断的 `vadEndpointDelayMs`；汇总同时给 mean/max → §2 条款 2 |
| 读 `data/voice/frontend-vad-grid.json`（120 Hz 行）+ 逐格比对 `voice.md:172-183`（F4） | 三档数字与文档原始格值一致；6 dB 逐条与文档表一致 → §4 |
| 读 `data/voice/highpass-response.json` + `frontend.py` 的 `highpass()` docstring（F3） | −6.02 dB @120 Hz、−9.75 @100、−2.99 @150、<0.03 @≥500 → 逐格一致 → §4 |
| `grep load_calibrated_params` / `DEFAULT_HIGHPASS_HZ`（F5） | 仅定义（`frontend.py:820`）与文档/单测引用，**无生产调用方**；`segment.py` 默认仍 120 → §4 |
| `npm test` | **tests 139 / pass 139 / fail 0 / exit 0** |
| `npm run check:docs` | **40 份 markdown；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；exit 0** |
| `git status` + t23 的 `changedPaths` | t23 只改了声明过的 3 个路径（`docs/design/voice.md`、`scripts/verify-voice-noise.ts`、`services/voice-edge/voice_edge/frontend.py`），无越界 |

**真实 API 调用：0 次**（本任务的正题就是「不花钱也能验证端点延迟」）。**合规说明**：两次运行都用 `--out` 把证据写进 `data/voice/` 下的**临时文件名**并已删除（未覆盖 `data/voice/verify-voice-noise.json`）；未改任何实现代码与他人文档；`data/t24-*` 亦已删除。

---

## 7. 结论表

| # | 维度 | 判定 |
|---|---|---|
| 1 | F1 出处 + 列名 + 6 dB 逐条值 | **主体修好**（出处分表、列名「逐条值（最大）」、6 dB 1056/1376/1472/1088 与网格一致）；剩 F1a/F1b 两处 3 dB 矛盾 |
| 2 | F2 端点延迟不再截断、判据可达 | **真正修好**（默认门限 4 条非零；`--max-endpoint-delay 50` 当场触发 `ENDPOINT_DELAY>` 并判 PIPELINE-BROKEN） |
| 3 | F3 注释与实测一致 | **真正修好**（与扫频 JSON 逐格一致，并写明旧说法错在哪） |
| 4 | F4 表头方向 | **处理正确**（确认未反 → 改无歧义表头 + 附原始格值；我复算数字全对） |
| 5 | F5 校准产物无运行路径 | **如实写明且与代码一致**（`load_calibrated_params` 无生产调用方） |
| 6 | 门禁 | `npm test` 139/139、`check:docs` exit 0（我自己跑的） |
| 7 | 范围纪律 | 只改声明过的 3 个路径 |

**总判定：needs_revision**。t23 对 F2/F3/F4/F5 的修复与我提的 F1 主体都能被我独立复核、**可以放行**；需要落地的是 `docs/design/voice.md` 里的三处「一句话」订正：**F1a**（:279 的 3 dB 单值 1088）、**F1b**（:290 重述的 3 dB 1088 与干净档逐条值）、**F2**（:261-263「两次运行完全相同的值」需要改成代码依据或补上真实 ASR 的证据文件）。三处改完，这一轮我判 pass。
