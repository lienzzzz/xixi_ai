# 评审：噪声鲁棒语音前端（t2 产物）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t2 实现者 voice-engineer 与 verifier）
> 日期：2026-09-30
> 评审对象：t2「噪声鲁棒语音前端 + 噪声测试数据 + 边界证据」的**产物本身**（任务 t2 已因 inScope 声明遗漏判 failed，本评审不因任务状态判实现不合格）
> 复核对象：t17（t2 声明补正与终态核实）、t6 / `docs/verification/field-test-verification-2026-09-30.md`（独立验证报告）
> 唯一写入路径：本文件。未修改任何实现代码、测试或其他人的文档。
> 权威来源（本评审实际读过的）：`services/voice-edge/voice_edge/{frontend,segment,calibrate,make_noise_fixtures}.py`、`tests/unit/voice/frontend.test.ts`、`scripts/verify-voice-noise.ts`、`scripts/lib/similarity.ts`、`data/voice/*.json`、`tests/audio-fixtures/noisy/manifest.json`、`docs/design/voice.md`

---

## 1. 结论

**verdict：needs_revision（实现实质合格，4 条 findings 全部是「证据/文档保真」与「门禁量纲」问题，其中 2 条必须先修）**

一句话：**产物是真的**——前端、校准入口、30 个噪声夹具、离线单测、真实 ASR 的边界数据我都独立复核过，核心数字（3 dB 档 4/4 检出、平均相似度 0.805、最低通过档 = 3 dB、困难样本保留）成立且不是手写的；三条负结论（高通对 Silero 几乎无影响、谱减法默认关闭且 3 dB 档更差、噪声下端点延迟变差）都有原始数据支撑，没有被美化。**但** `docs/design/voice.md` §1.1（6）那张「实测」表里最容易被人引用的「端点延迟」一列（640 ms / 1472 ms / 640 ms）**既不是它自称的来源文件里的数字，也不是平均值**，而 `scripts/verify-voice-noise.ts` 自己的端点延迟量纲又被截断在 0，导致文档边界声明里的「端点延迟 640 ms（≤1500 ms 上限）」在今天的脚本下**不可能复现、也不可能失败**。

| 项 | 判定 |
|---|---|
| t2 实现产物（前端 / 校准 / 夹具 / 脚本 / 单测） | **真实可用**（见 §2、§3） |
| t2 七条验收标准 | **6 条真正满足，1 条凡尔赛式满足**（条款 5「可复现成功边界」相似度部分真实、端点延迟部分不成立） |
| verifier（t6）对 t2 的结论 | **基本可信但不完整**：未测清单诚实，唯一一条独立真实复现（相似度 0.805）经得起复核；它**引用**了 640/1472 却未独立复核这两个数 |
| t17 声明补正结论 | **成立**（三路径确实在册、内容满足要求）；但它对条款 5 的「逐条成立」判定偏宽松，未覆盖端点延迟一列 |
| 铁律与隐私（§20.1、铁律 6/7/12） | **通过**（见 §5） |
| 文档诚实性 | **基本诚实，但有 3 处出处/数字不实**（F1/F3/F4） |
| `npm run check:docs` | **真的绿**（33 份 markdown，0 问题，exit 0；我自己跑的） |

---

## 2. 逐条核对 t2 的 7 条验收标准

| # | 条款 | 判定 | 我自己的核对方式与结果 |
|---|---|---|---|
| 1 | 去直流 + 高通 + 噪声底自适应，参数有实测依据并写进 `docs/design/voice.md` | **真正满足** | `frontend.py:108`（去直流）、`:183-192`（零相位双二阶高通）、`:627`（`derive_frontend_params`：截止频率与门限都由噪声底/低频占比推导）；`segment.py:129-140` 真的把调理结果喂 VAD、并把派生门限用于能量起止（不是我读注释，是读调用链）。参数出处可查：`data/voice/highpass-response.json` 的 `noiseCutoff{0,80,100,120,150}` 逐档 RMS/分带能量与 voice.md §1.1（1）的表逐格一致（−27.27/−31.91/−32.27/−32.60/−33.05） |
| 2 | `python -m voice_edge.calibrate` 可在真实麦克风上跑并输出分带能量 + 建议参数 JSON | **真正满足（我独立跑过离线路径）** | 我用 `.venvs/voice-pipecat` 跑 `calibrate --wav data/recon/ambient-5s.wav --json-out … --profile-out …` → **exit 0**，报告含 `bandDbfs` 四带、`bandPowerShare`、`lowFrequencyShare 0.6208`、`params{highpassHz 120, gateThresholdDbfs −18.0, suggestedCaptureGainDb 0}`、`measuredEffect`，并额外生成 `applied`/`consistency` 块。活体麦克风路径由 verifier 实测 exit 0（`lowFrequencyShare 0.288` → 高通 100 Hz），我采信其记录 |
| 3 | `tests/audio-fixtures/noisy/` ≥3 个 SNR 档，每条记录 SNR 与生成方式 | **真正满足，且我独立重算过** | 磁盘 30 个 WAV + `manifest.json`：5 夹具 × 6 档（18/9/6/3/0/−6，`snrStepsDb` 明写）；`noiseSource.path = data/recon/ambient-5s.wav`（真实环境录音）、`snrDefinition` 明写 300–3400 Hz + 前端调理后测量、`highpassHzForDefinitions 120`、`regenerate` 命令齐全。**我用 `frontend.condition`+`band_levels` 自己重算了全部 30 条**（按 `P_speech = P_mix − P_noise` 反推）：与 `measuredSnrDb` 的最大偏差 **0.76 dB**（backchannel-snr-6db，短句最差），其余 ≤0.15 dB；`targetSnrDb == measuredSnrDb` 逐条严格相等（30/30） |
| 4 | `verify-voice-noise.ts` 输出转写/相似度/端点延迟/失败清单，退出码反映成败 | **字段齐全，但「端点延迟」这一列不可用于「是否超长」** | 真实 ASR 报告里 `clips[].transcript/similarity/endpointDelayMs/failures`、`tiers[].meanSimilarity`、`failureList` 都在；真实失败路径 exit 1（`data/voice/verify-voice-noise.json` verdict=FAIL，0 dB 档 2 条 `SIMILARITY<0.6`、−6 dB 档 4 条 `NO_SPEECH_DETECTED`）。**但** `endpointDelayMs` 的定义被截断（见 F2），永远 ≤0，因此 `ENDPOINT_DELAY>1500ms` 这条判据事实上不可能触发——条款字面满足，量纲不满足 |
| 5 | 给出可复现的成功边界（例如 SNR≥X dB 时相似度≥0.6），困难样本不得删除 | **相似度半边真正满足；端点延迟半边不成立** | 我直接从 `data/voice/verify-voice-noise.json` 读原始数字：`boundary.lowestPassingTierDb = 3`、`passingTiers [18dB,6dB,3dB]`、逐档平均相似度 0.800/0.841/0.841/**0.805**/0.491/null，与 voice.md:190-196 的表逐格一致（**这一列是真的**）。困难样本：`noisy/` 里 0 dB 与 −6 dB 共 10 个 WAV 全在盘上，`frontend.test.ts:89` 有用例守（`hard clips are kept, not deleted`）。**不成立的部分**：文档写的「端点延迟 640 ms（≤1500 ms 上限）」——该列数字的来源与标签都有问题，且脚本量纲无法复现（F1+F2） |
| 6 | 纯函数有离线单测（`tests/unit/voice/`），`npm test` 全绿 | **真正满足** | 我跑 `python -m unittest discover -s tests`（cwd `services/voice-edge`）→ **Ran 39 tests, OK**；`npm test` → **tests 121 / pass 121 / fail 0（exit 0）**。注意：`npm test` 现在是 **121** 项（t16 接入 perception/console 后），`docs/testing.md:5/:124` 等仍写 95 → 已被 verifier 记为 F4，与本评审无关但与 t2 文档条目同源，一并提示 |
| 7 | `npm run check:docs` 通过；`docs/design/voice.md` 已更新；回报里有可粘贴进 `progress.md` 的段落 | **真正满足（文档内部有 3 处不实，见 F1/F3/F4）** | `npm run check:docs` → 「检查了 33 份 markdown / 失效链接 0 / 不存在的文件引用 0 / 缺少新鲜度标记 0」**exit 0**——check:docs 不校验数字，所以它绿不代表数字对。voice.md 已大幅更新（§1.1 共 7 个小节），并明确区分「已实现」与 §6「未实现/未验收」 |

---

## 3. 独立复核成功边界（不花 API 费用，但读了原始数据 + 自己算了夹具 SNR）

任务书允许「至少核对 `data/voice/*.json` 的原始数字」。我做了三件事，**没有跑真实 ASR**（边界数字已在报告中，且再跑一次会因 t18 的在途改动覆盖证据文件，见下）：

1. **来源真实性**：`data/voice/verify-voice-noise.json`（11:44 落盘）+ `with-nr.json`（11:30）+ `frontend-vad-grid.json`（11:39）+ `frontend-profile.json`（11:40）时间戳连续、字段结构完整，`seed.fakeAsr=false`、`python` 指向 `.venvs/voice-pipecat`，并且**逐条转写是真实中文**（`「明天天气怎么样？」「今天下午去镇上办点事，可能要到晚上才回来。」`），不是桩文本（桩会带「（离线模拟）」后缀）。→ 「不是手写的」成立。
2. **边界来自脚本而非手抄**：`scripts/verify-voice-noise.ts:400-403` 用 `passingTiers` 自动算 `lowestPassingTierDb=3` 并写进 `boundary.claim`；我逐档比对了 `tiers[].meanSimilarity` 与 voice.md 的表，**相似度列完全一致**。
3. **我自己的独立复算**：见 §2 条款 3（30 条夹具 SNR 重算，最大偏差 0.76 dB）。另外我离线跑了 `node scripts/verify-voice-noise.ts --fake --tiers 18 --out …` → `mode=offline-plumbing / verdict=PIPELINE-OK / exit 0`，与 t18 的声明一致；**该次运行 8 条夹具的 `endpointDelayMs` 全部为 0**，这正是 F2 的直接证据。

**我没有复跑真实 ASR 的理由（如实说明）**：`scripts/verify-voice-noise.ts` 当前工作区有 t18 的在途改动（`git status` 显示 `M scripts/verify-voice-noise.ts`，为 t18「离线模式只验证管线」任务），该改动重定义了顶层 `verdict`/`exitCode` 语义；在此状态下复跑会同时（a) 产生与文档语义不匹配的报告、(b) 可能覆盖 `data/voice/verify-voice-noise.json` 这份被文档引用的证据。边界结论我改用原始数据 + 独立复算支撑，并把它列为 findings 的验证缺口（F2 的修复建议里给出了不需要花钱就能复现的替代证据）。

---

## 4. 复核 verifier（t6）的结论

**它的 t2 结论是「实质通过 6/7 + 1 未测（真人语音下的 ASR 边界）」**（`docs/verification/…:23-24, 38-49`）。我的核对：

| verifier 的说法 | 我的复核 | 判断 |
|---|---|---|
| 条款 5「我的独立真实跑：`lowestPassingTierDb = 3`，3 dB 档 4/4 检出、均值 0.805、0 条失败」 | 与 `data/voice/verify-voice-noise.json` 逐格一致；它另有自己的 `data/v6-voice-noise-t3-t0.json`（12 次真实 ASR 调用，见其 §10） | **证据充分**，这是真正的独立复现 |
| 条款 3「我独立重算了全部 30 条，最大偏差 0.42 dB」 | 我用另一种实现（`P_speech = P_mix − P_noise`）重算，最大偏差 0.76 dB（同为 backchannel −6 dB 档），排序与量级一致 | **可信**，分歧来自反推口径，不影响「夹具真的带不同 SNR」 |
| 「未测 1 条：真人语音下的 ASR 边界」 | 我同意，并把「不确定结论 C1（SNR 口径）」也算进「不该当通过」 | **没有把未测写成通过**（这一点它做得对） |
| 它在 §2.1 条款 5 的证据里**引用**了「端点延迟 640 ms」 | **它没有独立复核这一列**：既没有指出 `verify-voice-noise.json` 里的 `meanEndPointDelayMs` 是 0/−16/−96（它只核了相似度），也没有指出 6 dB 档的 1472 ms 是最大值而非均值 | **一处证据缺口**（不是造假，是漏检）；因此「7 条里 6 条通过」的结论对条款 5 偏乐观 |
| 它把 F3（`minSimilarity` 实为均值）记为 low、说「门禁没被绕过」 | 我确认：`scripts/verify-voice-noise.ts:390` 是 `mean(...)`，与 `:383` 的 `meanSimilarity` 同值；tier 的 PASS/FAIL 走逐条 `failures`，门禁确实没被绕过 | **同意，但它漏了同一段代码里更严重的 `:262-266` 截断问题**（F2） |

**t17 的核对**：t17 声明「未改任何文件、工作区已是终态、三个路径内容满足要求、七项判据逐条成立」。我独立验证：`scripts/lib/similarity.ts` 存在且是唯一距离实现（`voice-device-check.ts:23` / `verify-voice-noise.ts:44` 都 import 它）、`docs/testing.md` 已登记（第 246/247/248 行的三个入口；数字 95 已随 t16 漂移，属 F4）、`npm test`/`check:docs` 我在当前工作区复跑通过。**结论成立**；唯一保留：它第 ③ 条「边界：`lowestPassingTierDb=3` …逐档 0.841/0.841/0.805 全 PASS」也只核了相似度，同样没有覆盖端点延迟列。

---

## 5. 铁律与隐私检查（§20.1 / 铁律 5·6·7·12）

| 检查项 | 结论 | 证据 |
|---|---|---|
| 只上传 VAD 检测到的语音段 | **通过** | `scripts/verify-voice-noise.ts:255` 只把 `sliceWav(buffer, speech.startMs, detectedEnd)` 的切片交给 `client.transcribe`（`:208-212` 的 `transcribe` 只收 span）；`scripts/voice-turn.ts:9,127,151` 明写并实现「只上传语音段」；报告 `note` 字段逐次声明 |
| 不外传连续音视频 | **通过** | `voice_edge/*.py` 全部 import 里**没有任何** `socket/requests/urllib/http/httpx`（我 grep 过）；前端只依赖 `numpy`；`segment.py` 每段是一个一次性子进程，不常驻、不联网 |
| 未新增高风险能力（铁律 7） | **通过** | 本次交付新增的都是本地 DSP 与只读产物：`frontend.py` 纯函数（无 I/O）、`calibrate.py` 读写 JSON/设备枚举、`make_noise_fixtures.py` 写 `tests/audio-fixtures/noisy/`、`verify-voice-noise.ts` 调 ASR。没有门锁/支付/紧急呼叫类能力，没有新增写数据库的路径 |
| 未引入 GPU 依赖（铁律 12） | **通过** | `.venvs/voice-pipecat` 里 `torch` **不存在**（`find_spec('torch') → None`），只有 `numpy` + `pipecat`；前端明确用纯 numpy 双二阶代替 `scipy.lfilter`（`frontend.py:167-168` 写明理由） |
| 不存模型私有推理（铁律 5） | **通过（本任务范围）** | 报告只存转写文本/相似度/延迟/失败码；未把模型推理写进任何持久层 |
| 不改 `packages/conversation`、`packages/brain-adapter` 接口语义 | **通过** | 本任务产物不 import 这两个包；`scripts/voice-turn.ts` 的改动只在 VAD/切片侧 |

---

## 6. 文档诚实性检查（`docs/design/voice.md` 的每个参数是否有实测出处）

我按「每个数字能否指到一个可复跑的产物」抽查：

| 位置 | 参数/结论 | 出处是否成立 |
|---|---|---|
| §1 表（stop_secs 0.6、min_volume 0.0、sample_rate/frame_size） | ADR-0007 的实测理由 | **成立**（progress §2.9 与本文件 §1 复测表：600–608 ms 端点、288–320 ms 起点） |
| §1.1（1）高通截止频率表 | `highpass-response.json` | **成立**：我逐格比对了 `noiseCutoff` 的数（−27.27/−31.91/−32.27/−32.60/−33.05、under100 −29.72→−54.14、300-3400 −34.41→−34.44） |
| §1.1（2）校准 JSON 与字段含义 | `noise-floor.json` / `frontend-profile.json` + 我重跑 | **成立**（我重跑得到同样字段；`noiseFloorDbfs −33.24`、`rawNoiseFloorDbfs −30.00` 与文档一致） |
| §1.1（3）门限公式与两处「自适应」 | `frontend.py:627-695`、`frontend-vad-grid.json` | **成立**（公式与代码逐字一致；门限随噪声底单调变化我按公式复算：−30→−18、−60→−51、−22→−7.6） |
| §1.1（4）「高通对 VAD 影响 ≤1 帧」表 | `frontend-vad-grid.json` 的 `highpassHz` 字段 | **数字成立，表头方向贴反**（F4：文档把「夹具」与「高通档」写反了，见 findings） |
| §1.1（5）谱减法 A/B 与 3 dB 档 0.622 vs 0.805 | `verify-voice-noise.json` / `with-nr.json` | **成立**：我读两份原始报告，18 dB 0.828/0.841、6 dB 0.841/0.841、3 dB **0.622/0.805**、边界 6 dB vs 3 dB，与文档逐格一致；`segment.py:275` 明写 `--nr` 默认关 |
| §1.1（6）边界表「平均端点延迟」列 | 文档自称 `verify-voice-noise.json` | **不成立** → **F1** |
| §1.1（6）边界声明「端点延迟 640 ms（≤1500 ms 上限）」 | 脚本「自动写死」 | **不成立/不可复现** → **F2** |
| §1（1）「−6 dB 点就在请求的截止频率上」 | `highpass-response.json` | **测量成立（120 Hz → −6.02 dB），但与代码注释互相矛盾** → **F3** |
| §6「未实现/未验收」清单 | — | **诚实**：唤醒词/声纹/常驻服务/真人麦克风验收/噪声下端点延迟/打断不可靠都明确列为未验收，没有把未实现写成已实现 |
| §5 前端成本 ~60–90 ms | `frontend-vad-grid.json` 的 `frontendMs` | **成立**（网格里 clean 行 27.91 ms、含噪声行更高，与 60–90 ms 量级一致；且文档自己声明是离线成本） |

`npm run check:docs`：**我自己跑过，exit 0**（33 份 markdown，0 问题）。注意它是链接/引用/新鲜度检查器，**不校验数字**，所以「绿」不能替代上面的逐格比对。

---

## 7. findings（needs_revision 的依据；每条含文件与行号）

### F1（medium，必须先修）`docs/design/voice.md:188-196` 的「平均端点延迟」列不属于它自称的来源，也不是平均值

- **位置**：`docs/design/voice.md:186`（自称来源「`data/voice/verify-voice-noise.json`」）、`:191`（18 dB → 640 ms）、`:192`（6 dB → 1472 ms）、`:193`（3 dB → 640 ms）；同表 `:189` 的阀门栏又写「≤1500 ms 上限」。
- **问题**：`data/voice/verify-voice-noise.json` 里 `tiers[].meanEndPointDelayMs` 实际是 **clean 0 / 18dB 0 / 6dB 0 / 3dB −16 / 0dB −96 / −6dB null**，没有一个等于文档写的 640/1472/640。真实数字在 `data/voice/frontend-vad-grid.json`（120 Hz 行）：18 dB **逐条都是 640**（4/4，所以「640」在 18 dB 是均值也是最大值，巧合成立）；6 dB 是 1056/1376/1088/**1472** → **均值 1173 ms，不是 1472**；3 dB 只有 1 条有效（direct-question 1088，其余三条 `null`），**不是 640**。所以这一列一半是最大值、一半是均值、还有一格与两个来源都不符，且**来源指错文件**。
- **影响面**：§1.1（6）是接手者与用户引用「噪声鲁棒性边界」的表；同一条「1472 ms」还被复用到 `:213` 与 `§6 :346`（那里写「平均端点延迟 1472 ms」），所以错误会传播。
- **requiredFix（二选一，最小改动）**：
  - (a) 把该列表头改成 **「端点延迟（逐条，最大/逐条值）」**，来源句改成 `data/voice/frontend-vad-grid.json`（`highpassHz=120` 行），并把 6 dB 一格写成 `1056 / 1376 / 1088 / 1472（均值 1173）`、3 dB 一格写成 `1088（仅 1 条有效，其余 null）`；同步 `:213`、`:346` 把「平均」改成「最大值/逐条值」。
  - (b) 若要保留「平均」口径，则在 `scripts/verify-voice-noise.ts` 的 `clips[]` 里补一个不问 ASR 的 `vadSegmentEndMs`（= `segmentation.segments[0].endMs`，已有值，见 `:246` 附近的 `speech.endMs`），再由该字段算均值——但这是实现改动，需另开任务。
- **复现命令**：`node -e "const r=require('./data/voice/verify-voice-noise.json');console.log(r.tiers.map(t=>[t.tier,t.meanEndPointDelayMs]))"` 与 `node -e "const g=require('./data/voice/frontend-vad-grid.json');console.log(g.filter(x=>x.highpassHz===120&&/snr(18|6|3)db/.test(x.file||'')).map(x=>[x.file,x.endpointDelayMs]))"`

### F2（medium，必须先修）`scripts/verify-voice-noise.ts:262-266` 的端点延迟被截断在 ≤0，`ENDPOINT_DELAY>1500ms` 门禁永远不会触发

- **位置**：`scripts/verify-voice-noise.ts:245-246`（`detectedEnd = Math.min(speech.endMs, cleanEndMs)`）、`:262-264`（`endpointDelayMs = detectedEnd − cleanEndMs`）、`:265-266`（超限即 `ENDPOINT_DELAY>` 失败）。
- **问题**：因为先取了 `min`，`endpointDelayMs ≤ 0` 恒成立，所以「端点延迟 >1500 ms」这条**结构上不可达**。直接证据：我用当前工作区跑 `node scripts/verify-voice-noise.ts --fake --tiers 18` → 8 条夹具（含 4 条 18 dB 噪声夹具）`endpointDelayMs` **全部为 0**；tier 汇总也是 `ep 0`。而文档 `:204` 的边界声明「端点延迟 640 ms（≤1500 ms 上限）」和 `:207`「本节数字与之逐字一致」因此**无法由脚本复现**（脚本写进 `boundary.claim` 的只有 `lowestPassingTierDb` 与相似度阈值，见 `:487-496`）。
- **影响面**：本项目第一风险是噪声，而「噪声下端点延迟变差」正是被写进 §6 的未验收项；现在的脚本既不能发现延迟回归、也不能支撑文档里的「≤1500 ms 上限」。这不是造假（真实延迟数字在 `frontend-vad-grid.json` 里确实存在：6 dB 档 1056–1472 ms），而是**门禁量纲选错**。
- **requiredFix**：在 `measure()` 里改为记录真实 VAD 端点（`vadEndMs = speech.endMs`，不取 min），另存字段如 `vadEndpointDelayMs = Math.round(vadEndMs − cleanEndMs)`，并且 **`ENDPOINT_DELAY>` 判据改用这个字段**（`similar` 用的 `detectedEnd` 保持现状，避免影响 ASR 切片长度）；报告与 `docs/design/voice.md:204` 的边界声明改为引用 `vadEndpointDelayMs`，并注明「截断窗口口径」与「真实 VAD 口径」的区别。修完后**无需花钱**即可验证门禁生效：`node scripts/verify-voice-noise.ts --fake --tiers 6` 应在 6 dB 档给出 `vadEndpointDelayMs` 1088–1472 量级（与 `frontend-vad-grid.json` 一致）。

### F3（low）`services/voice-edge/voice_edge/frontend.py:189` 的注释与实测/文档矛盾

- **位置**：`frontend.py:188-190` 注释：「the reverse pass makes the effective cutoff lower than the nominal one (measured −6 dB point ≈ 0.65 × `cutoff_hz`, so 120 Hz nominal behaves like ≈80 Hz — see voice.md §1.6)」。
- **问题**：三处独立反证——(1) 我读 `data/voice/highpass-response.json`：cutoff 120 Hz 档在 **120 Hz 处实测 −6.02 dB**、100 Hz −9.75、80 Hz −15.62，即 −6 dB 点**就在名义截止频率上**，不是 0.65×；同档 cutoff 100 Hz 也是 100 Hz 处 −6.02 dB；(2) `docs/design/voice.md:73-74` 写的是「实测该双二阶的 −6 dB 点就在请求的截止频率上（请求 120 Hz → 实测 −6.02 dB @120 Hz）」——与注释**直接矛盾**；(3) 单测 `services/voice-edge/tests/test_frontend.py:146` 的名字就是 `test_minus_6_db_point_is_close_to_the_requested_cutoff`。引用目标 `voice.md §1.6` 在本文件里也不存在（§1.1（5）/（6）才是对应小节）。
- **影响面**：只影响代码可读性（测量与单测都站在文档那边），但它是「同一份代码里两个相反结论」，容易让下一个人按 0.65× 去改截止频率。
- **requiredFix**：把 `frontend.py:188-190` 改成与实测一致的表述：「零相位前向+反向保持 −6 dB 点位于名义截止频率（实测 120→−6.02 dB @120 Hz，见 `data/voice/highpass-response.json`）；反向通带只把**相位**抵消，不移动截止点」，并把 `see voice.md §1.6` 改成 `§1.1（1）`。

### F4（low）`docs/design/voice.md:127-134` 的表头方向与实测/来源相反

- **位置**：`docs/design/voice.md:127-128` 表头「| 夹具 | 前端 |」+ `:129` `direct-question.wav（干净）| 关`、`:130` `同上 | 120 Hz`；`:136` 又写「原始 JSON：`data/voice/frontend-vad-grid.json`，每行有 `highpassHz` 字段」。
- **问题**：`frontend-vad-grid.json` 里**没有**名为 `direct-question.wav 前端关` 的行；该表的实际行是「同一夹具 × 三个高通档（0 = 关 / 60 / 120）」，而文档把**高通档写进了「夹具」栏**（`longer-turn-snr0db | 关` 与 `| 120 Hz` 其实是同一夹具的两行）。另外文档表里 18 dB/6 dB 行的行名（`direct-question-snr6db`）与网格文件名口径一致（`direct-question-snr6db.wav`），说明它确实取自该网格，只是列错位。
- **影响面**：读者按表头去该网格里找 `前端=关` 的行会找不到；「同一个文件、两种前端设置」这一关键对照被表头掩盖。
- **requiredFix**：把列名改成 `| 夹具 | 高通 | 段数 | VAD 起点 | 端点延迟 | 打断判定 |`，行值用 `highpassHz` 的 `0` / `120`（并在表注写明 `0 = 关闭前端`）；同时把 `:136` 的「每行有 `highpassHz` 字段」保留为核对指引。
- **旁证**：我按该网格核对过文档引用的数字确实存在（`direct-question.wav` 在 `highpassHz 0` 与 `120` 下都是 320 ms / 600 ms，`direct-question-snr6db` 都是 448 ms / 1056 ms，`longer-turn-snr0db` 是 672 ms vs 384 ms）——**结论「高通对 Silero 判定几乎无影响」是真的**，问题只在呈现。

### F5（info）校准产物没有采纳方（与 verifier F8 同源，但可再精确一档）

- **位置**：`frontend.py:816` `load_calibrated_params`；调用方只有 `tests/unit/voice/frontend.test.ts:258,286`，而 `segment.py:273` 的 `--highpass-hz` 默认仍是硬编码 `120.0`、`voice-turn.ts:91` 也不传任何校准参数。
- **问题**：`data/voice/frontend-profile.json` 只有 `params`（无 `applied`/`consistency`，因为它是 11:40 由旧版 calibrate 写的）；我重跑 `calibrate --profile-out` 证明**新版会写 `applied` 且 `consistency.profileApplied=true`**，但该块至今没有运行路径去读。文档 §1.1（3）与 `docs/design/voice.md:109-116` 把门限/增益描述为「自适应」，在**运行路径**上其实是「脚本内按噪声底推导 + 固定 120 Hz」。
- **影响面**：不是缺陷而是口径风险：现场测试页读的是 `frontend-profile.json` 的**旧字段**，与被 VAD 实际使用的参数不是同一个来源（verifier F8 已记 info）。
- **建议**：要么在 `segment.py`/`voice-turn.ts` 里真正 `load_calibrated_params`，要么在 `voice.md §1.1（3）` 加一句「运行路径的高通仍是 120 Hz 常量，profile 的 `applied` 尚未被任何运行路径读取（F8）」，避免读者把校准产物当成已生效配置。**不要**为了这条去改实现（超出本任务范围）。

---

## 8. 我实际跑过的命令与结果（可核账）

| 命令 | 结果 |
|---|---|
| `npm run check:docs` | 33 份 markdown，失效链接 0 / 不存在引用 0 / 缺新鲜度标记 0 → **exit 0** |
| `npm test` | **tests 121 / pass 121 / fail 0 → exit 0**（注意与文档写的 95 已有漂移，verifier F4） |
| `python -m unittest discover -s tests`（cwd `services/voice-edge`，`.venvs/voice-pipecat`） | **Ran 39 tests … OK → exit 0** |
| `python -m voice_edge.calibrate --wav data/recon/ambient-5s.wav --json-out <TEMP> --profile-out <TEMP>` | **exit 0**；报告含 `applied` + `consistency{profileApplied:true, profileOverridesDefault:[gateThresholdDbfs, gateMarginDb, suggestedCaptureGainDb, confidence]}`；profile 也含 `applied` |
| `node scripts/verify-voice-noise.ts --fake --tiers 18 --out data/review-t7-fake-18db.json` | **exit 0**（mode=offline-plumbing / verdict=PIPELINE-OK）；8 条夹具 `endpointDelayMs` **全为 0** → F2 的直接证据 |
| 自写 Python：按 `P_speech = P_mix − P_noise` 重算 30 条夹具 in-band SNR | 与 `measuredSnrDb` 最大偏差 **0.76 dB**（backchannel-snr-6db），其余 ≤0.15 dB；`target==measured` 30/30 |
| 读 `data/voice/{verify-voice-noise,verify-voice-noise-with-nr,frontend-vad-grid,highpass-response,noise-floor,frontend-profile}.json`、`tests/audio-fixtures/noisy/manifest.json` | 见 §2/§6 的逐格比对 |
| `python -c "find_spec('torch')"`（`.venvs/voice-pipecat`） | `torch None`、`numpy True`、`pipecat True` |

**真实 API 调用：0 次**（未跑真实 ASR：边界数字已由两份落盘报告与 30 条夹具复算支撑；不跑的理由见 §3，且当前 `scripts/verify-voice-noise.ts` 有 t18 在途改动，复跑会覆盖文档引用的证据文件）。

**工作区状态提示（不属于我的改动）**：`git status` 显示 `M scripts/field-test.ts`、`M scripts/verify-voice-noise.ts`（t18 在途）、`?? docs/verification/`（verifier 的报告）。我只新增了本文件与 `data/review-t7-fake-18db.json`（临时证据，可删）。

---

## 8.1 复核条件提示（并发编辑）

本评审读取代码行号时（12:10–12:25），`git status` 显示 `M services/voice-edge/voice_edge/frontend.py`、`M services/voice-edge/voice_edge/calibrate.py`、`M tests/unit/voice/frontend.test.ts` 等**在途改动（不是本评审所为，本评审只写本文件）**。因此：

- F3 的**引文**（`frontend.py:188-190` 的「−6 dB 点 ≈ 0.65 × cutoff」注释）与 `/data/voice/highpass-response.json`、`docs/design/voice.md:73-74`、`tests/…/test_frontend.py:146` 的**矛盾**是在我读取这一刻成立的；落地修复前请以当前工作区为准重新确认该注释是否仍在。
- F1/F2/F4 的证据全部来自**已落盘的 JSON 报告与文档原文**，不受在途改动影响（除 F2 的 `scripts/verify-voice-noise.ts:245-266` 行号可能随 t18 修复而移位）。
- 同样地，`npm test` 的 121 项是我在 12:1x 于该在途状态下跑出的（与 verifier 记录的 120 项差 1，属测试项在途增删，不影响本评审结论）。

## 9. 结论表

| # | 维度 | 判定 |
|---|---|---|
| 1 | t2 七条验收标准 | 6 条真正满足；条款 5 的「端点延迟 ≤1500 ms 上限」只有文字满足（F1+F2） |
| 2 | verifier（t6）证据强度 | 相似度边界证据充分（独立真实复现 + 12 次调用记录）；端点延迟列未复核（F1+F2 漏检）；未测项标注诚实 |
| 3 | t17 声明补正 | 成立（三路径在册、内容达标、npm test/check:docs 复跑通过）；其「逐条成立」未覆盖端点延迟列 |
| 4 | 铁律与隐私 | 通过：只上传语音段、无连续音视频外传、无高风险能力、无 GPU/torch 依赖 |
| 5 | 文档诚实性 | 基本诚实（有 §6 未验收清单、有困难样本保留）；3 处出处/数字不实（F1/F3/F4） |
| 6 | 环境门禁 | `npm test` 121/121、`check:docs` exit 0、Python 39/39 —— 均我自己复跑 |

**总判定：needs_revision**。修 F1（出处与均值/最大值口径）与 F2（端点延迟门禁量纲）后，t2 产物我判 **pass**；F3/F4/F5 只改文字与注释，可与 F1/F2 一并落地。
