# 语音链路：VAD 基线、抗噪前端、两条输入路径、打断与延迟

> 最后更新：2026-09-30
> 权威来源：`services/voice-edge/voice_edge/{config,segment,frontend,calibrate,make_noise_fixtures,loopback}.py`、`scripts/voice-turn.ts`、`scripts/voice-bargein.ts`、`scripts/verify-voice-noise.ts`、`scripts/serve-chat.ts`、`scripts/voice-device-check.ts`、ADR-0007/0008、[recon/pipecat-spike-2026-09-29.md](../recon/pipecat-spike-2026-09-29.md)、[recon/livekit-spike-2026-09-29.md](../recon/livekit-spike-2026-09-29.md)、[recon/device-acceptance-2026-09-30.md](../recon/device-acceptance-2026-09-30.md)、[recon/field-test-environment-2026-09-30.md](../recon/field-test-environment-2026-09-30.md)、[progress.md](../progress.md) §2.9/§0
> 若与代码不一致，以代码为准，并请立即修正本文件

方案 §14.1 画的链路是 `Mic → AEC → NS → AGC → VAD → Wake Word → Speaker Verification → Turn Detection → ASR → 对话 → TTS`。
**当前实现覆盖 `去直流 → 高通 → （可选）谱减法去噪 → VAD → ASR → 对话 → TTS` 与打断判定**；
唤醒词、说话人验证、Turn Detection 都不存在（见 §6）。

## 1. 选型与基线（ADR-0007）

- 采用 **Pipecat 1.12.0**（隔离 venv `.venvs/voice-pipecat`，Silero VAD 的 ONNX **随 wheel 自带**，零下载）。
- LiveKit Agents 1.8.3 仅作对照，不作为实现（离线无法演示打断：adaptive 需要 LiveKit Cloud 凭据 + 房间）。
- ASR / TTS **直连小米 MiMo**（`mimo-v2.5-asr` / `mimo-v2.5-tts`），不走任何语音框架的云插件。

基线参数定义在 `services/voice-edge/voice_edge/config.py` 的 `VadBaseline`：

| 参数 | 值 | 理由（实测） |
|---|---|---|
| `stop_secs` | **0.6**（默认 0.2） | `longer-turn.wav` 句内 352 ms 停顿处，默认值在 2080 ms 处**提前 1440 ms** 判定「说完」；`stop_secs ≥ 0.6` 才能消除。端点延迟与它线性相关（≈ `stop_secs×1000 + 32 ms`，32 ms 是帧栅格） |
| `min_volume` | **0.0**（默认 0.6） | 默认值的 400 ms BS.1770 音量窗 + 0.2 指数平滑让 VAD 要 ~512 ms 才开闸；改 0 后说话起始延迟从 544–864 ms 降到 192–384 ms。`config.py` 注释写的是「代价 320–480 ms」 |
| `confidence` | 0.7（默认） | 保持默认 |
| `start_secs` | 0.2（默认） | 保持默认；它本身只值约 192 ms |
| `sample_rate` / `frame_size` | 16000 / 512（32 ms） | Silero 在 16 kHz 下要 512 **样点**（= 1024 字节 PCM16）一帧；按字节切帧会让 VAD 永不停止（progress §2.9 记录的自测缺陷） |

**本文件重新实测（2026-09-30，`python -m voice_edge.segment <fixture>`，基线参数）**：

| 夹具 | VAD 起点 | 端点延迟 | `loadMs` | `processMs` |
|---|---|---|---|---|
| `direct-question.wav` | 320 ms | 600 ms | 205.0 | 68.2 |
| `longer-turn.wav` | 320 ms | 608 ms | 304.6 | 145.7 |
| `tv-dialogue.wav` | 288 ms | 608 ms | 234.6 | 56.6 |
| `followup-turn.wav` | 960 ms | 608 ms | 212.2 | 84.1 |
| `backchannel.wav` | **无 segments**（exit code 2） | — | 204.2 | 50.7 |

与 progress §2.9 的结论一致：**起始 288–320 ms、端点 600–608 ms**。所有数值量化到 32 ms 栅格，
真值本身是能量阈值估计（`energy_bounds_ms`，-40 dBFS），不确定度约 ±1–2 帧。

### 1.1 抗噪前端：参数、实测依据与成功边界（2026-09-30 新增）

背景：用户现场测试前明确说过「麦克风噪音很大」，而 ADR-0007 的基线只在**干净合成夹具**上验证过。
本节的全部数字来自真实设备噪声（[recon/field-test-environment-2026-09-30.md](../recon/field-test-environment-2026-09-30.md) §1.2–§1.5）
与在它之上构造的噪声夹具；原始产物在 `data/voice/`（`frontend-vad-grid.json`、`nr-estimators.json`、
`cutoff-sweep.json`、`verify-voice-noise.json`，都是脚本直接写出的，不是手抄）。

前端实现：`services/voice-edge/voice_edge/frontend.py`（纯函数、无 I/O），
CLI 入口 `python -m voice_edge.segment`（默认走前端）与 `python -m voice_edge.calibrate`（噪声底校准）。

#### （1）去直流 + 高通：截止频率是测出来的，不是拍的

对实测 5 s 环境噪声（`data/recon/ambient-5s.wav`，44.1 kHz 立体声降为 16 kHz 单声道）扫截止频率，
前端同一个零相位滤波器（`frontend.highpass`，RBJ 双二阶、前向+反向、反射填充）：

| 高通 | 宽带 RMS | 噪声底(p10) | <100 Hz 带 | 300–3400 Hz 带 | 宽带降噪量 |
|---|---|---|---|---|---|
| 关（仅去直流） | −27.27 dBFS | −30.00 | −29.72 | **−34.41** | 0.00 dB |
| 80 Hz | −31.91 | −32.55 | −45.17 | −34.41 | 4.64 dB |
| 100 Hz | −32.27 | −32.95 | −49.57 | −34.42 | 5.00 dB |
| **120 Hz** | −32.60 | −33.23 | −54.14 | **−34.44** | **5.33 dB** |
| 150 Hz | −33.05 | −33.57 | −60.67 | −34.48 | 5.78 dB |
| 300 Hz | — | — | — | −25.64 | — |

结论与选择理由：

- 截止频率**只影响 <100 Hz 的隆隆声**，对 300–3400 Hz 语音带的影响 ≤0.07 dB（上表 120 Hz 与关闭相比）。
  这正好对上 recon 的结论（<100 Hz 占噪声功率 56–62 %，且没有 50/60 Hz 工频串）：
  高通是拿掉「噪声功率的大头」，不是在动语音带。
- 选 **120 Hz**（`derive_frontend_params`：<100 Hz 占比 ≥50 % → 120 Hz；≥20 % → 100 Hz；否则 80 Hz）。
  代价写在明面上：**男性最低基频 F0 ≈ 85–100 Hz 会被部分衰减**；如果将来真实录音证明这伤了识别，
  `voice_edge.segment --highpass-hz` 可以立刻改并复测。
- 滤波器必须**零相位**：滤波后的信号同时喂 VAD 和打断延迟测量（§4），单次前向滤波的
  group delay 会凭空给「语音起点」加上几十 ms。实测该双二阶的 −6 dB 点就在请求的截止频率上
  （请求 120 Hz → 实测 −6.02 dB @120 Hz，500 Hz 以上衰减 <0.03 dB）。
- 验收方式是 `tests/unit/voice/frontend.test.ts` 调用的 `services/voice-edge/tests/test_frontend.py`：
  直流增益为 0、截止点 −6 dB、带内不平坦度 <1 dB、长度不变、零相位（互相关峰在 lag 0）。

#### （2）噪声底校准（可运行命令 + JSON）

```powershell
# 真实麦克风（需要带 sounddevice 的 venv；pipecat venv 里没有）
E:\worker2\.venvs\field-probe\Scripts\python.exe -m voice_edge.calibrate --seconds 5 `
    --json-out ..\..\data\voice\noise-floor.json --profile-out ..\..\data\voice\frontend-profile.json
# 离线复算（任一 venv 都可，也是本文件数值的来源）
E:\worker2\.venvs\voice-pipecat\Scripts\python.exe -m voice_edge.calibrate --wav ..\..\data\recon\ambient-5s.wav
# 列设备（WASAPI 优先，理由见 §1.1（4））
E:\worker2\.venvs\voice-pipecat\Scripts\python.exe -m voice_edge.calibrate --list-devices
```

输出（`--wav` 复算实测，`applied`/`consistency` 两块是 F8 修复后新增）：

```json
{"unit":"dBFS","noiseFloorDbfs":-33.24,"rawNoiseFloorDbfs":-30.00,"noiseRmsDbfs":-27.27,
 "bandDbfs":{"under100":-29.72,"100-300":-35.79,"300-3400":-34.41,"3400-8000":-46.02},
 "bandPowerShare":{"under100":0.6208,"100-300":0.1535,"300-3400":0.2111,"3400-8000":0.0146},
 "lowFrequencyShare":0.6208,"spectralFlatness":0.0513,"spectralTiltDbPerOctave":-5.0,
 "params":{"highpass_hz":120.0,"gate_threshold_dbfs":-18.0,"gate_margin_db":12.0,
           "suggested_capture_gain_db":0.0,"confidence":0.7,"stop_secs":0.6,"noise_reduction":false},
 "applied":{"profileSchemaVersion":1,"highpassHz":120.0,"gateThresholdDbfs":-18.0,"gateMarginDb":12.0,
            "noiseReduction":false,"oversubtraction":2.0,"gainFloor":0.06,"sampleRate":16000},
 "consistency":{"identicalToDefaults":false,
   "profileOverridesDefault":[{"field":"gateThresholdDbfs","default":-61.0,"applied":-18.0},
     {"field":"gateMarginDb","default":9.0,"applied":12.0},
     {"field":"suggestedCaptureGainDb","default":6.0,"applied":0.0},
     {"field":"confidence","default":0.6,"applied":0.7}]},
 "measuredEffect":{"highpassWidebandRmsReductionDb":5.33,"noiseReductionFloorReductionDb":0.58}}
```

字段含义与给控制台（t4）的契约写在代码里：`noiseFloorDbfs` 是**去直流+高通之后**测的噪声底
（门限与去噪都用它），`rawNoiseFloorDbfs` 是**采集原始**噪声底（决定采集增益建议）。
两个底不能混用：把原始底喂给看「已高通信号」的噪声估计器，估计器会找不到安静帧、去噪静默失效
（这是实测踩过的坑，注释与单测都记着）。

**校准建议 = 前端实际生效值（F8 修复，2026-09-30）**。此前「工具建议的参数」与「前端真正跑的参数」
是两处独立写的数字：`calibrate` 的建议来自实测推导，而 `segment` 的 `--highpass-hz` 默认值是硬编码的
120，一旦推导规则改动（比如低频占比落在 20–50% 区间 → 建议 100 Hz），用户照做也会发现「没用」。
现在二者由**同一份数据**产生，取舍如下：

- **选择「让校准产物成为前端读取的来源」，而不是「把建议写死成 120」**。理由：前者在换麦克风/换房间后
  仍然成立（重新校准即改行为），后者只能保证「今天恰好一致」。
- `calibrate --profile-out <file>` 写出的 JSON 里新增 `applied` 块（camelCase，与控制台读的字段同名），
  它**就是**建议本身（`params` 与 `applied` 由同一个 `FrontendParams` 生成，见 `frontend.apply_calibration`）；
  `frontend.load_calibrated_params(profile)` 逐字段采纳 `applied`，不重新推导，所以产物不会被「二次解释」成别的值。
- 没有校准产物时，前端回退到 `DEFAULT_HIGHPASS_HZ = 120`——这个常量**等于**本机实测噪声下
  `derive_frontend_params` 给出的截止频率（<100 Hz 占 62% → 120 Hz，见 §1.1（1）），不再是「另一个数」。
  两条路径的取舍写进代码注释（`frontend.py` 顶部的 `DEFAULT_HIGHPASS_HZ`）与本表。
- 产物损坏/旧 schema（没有 `applied` 块）不会让语音路径崩：`load_calibrated_params` 在 `origin.warning` 里
  说明原因并回退到默认，`calibrate` 的 `consistency` 块同时报告「哪些字段覆盖了默认、哪些没变」。
- **本机实测的一致性结果**（`--wav data/recon/ambient-5s.wav`）：`applied.highpassHz = params.highpassHz = 120`、
  `applied.gateThresholdDbfs = params.gateThresholdDbfs = −18.0`；`consistency.profileOverridesDefault`
  只有门限/余量/增益/confidence 四项（都是实测决定的），**不含高通**——即「校准不会把截止频率挪离实测默认值」。
- **已知边界**：`voice_edge.segment` 的 CLI 默认仍是 `--highpass-hz 120`（与默认值一致，所以不矛盾）；
  要让它按另一份校准产物跑，显式传 `--highpass-hz <profile 的 applied.highpassHz>`。把 CLI 也接到
  `load_calibrated_params` 上属于后续改动（会动 `segment.py` 的默认行为），本轮不在范围内，
  这里如实写清而不是假装已经接好。
- 证据与回归：`tests/unit/voice/frontend.test.ts` 的「the calibrate CLI recommends exactly the parameters the
  front end applies (F8)」会真的跑 calibrate、比对 `params`/`applied`/`consistency`，再用
  `load_calibrated_params` 把产物读回来逐字段比对——这是行为断言，不是文本扫描。

#### （3）「噪声底自适应」到底改了哪两个数

1. **门限**：`gate_threshold_dbfs = max(噪声底, −70 dBFS) + 余量`，
   余量 = `9 dB + 0.3 × (噪声底超过 −40 dBFS 的 dB 数)`，上限 21 dB。
   噪声底 −30 dBFS → 门限 **−18 dBFS**；干净合成夹具（数字静默，噪声底 −120 dBFS）→ 门限 −61 dBFS。
   `segment.py` 用这个门限取代了写死的 −40 dBFS 来估计「用户语音实际起止」（`energyStartMs`/`energyEndMs`，
   旧值仍以 `rawEnergyStartMs`/`rawEnergyEndMs` 输出，向后兼容）。
   实测意义：环境噪声底自己就有 −30 dBFS，**任何低于它的固定门限都会把噪声当语音**（1146 那类假 PASS 的同一根因）。
2. **采集增益建议**：噪声底 >−35 dBFS → 0 dB；−45…−35 → 0…+3 dB；更安静 → 可保留出厂 +5.5 dB。
   依据是 recon §1.4 的 1:1 缩放实测（4 档每 6 dB 步进实测 5.68/6.05/6.11 dB）。

**F5（info）：`applied` 目前还没有运行路径读取它。** 这一条要写清楚，避免读者以为「跑一次校准就改了行为」：

- `calibrate --profile-out` 产出的 `applied` 块（以及 `frontend.load_calibrated_params()`）**已经可用、有单测**，
  但**当前没有任何运行路径调用它**：`voice_edge.segment` 的 `--highpass-hz` 默认仍是常量
  `DEFAULT_HIGHPASS_HZ = 120`（`services/voice-edge/voice_edge/segment.py`），`scripts/serve-chat.ts`
  的 `/api/voice` 也走同一个默认。也就是说：**改 profile 目前不会改变实际生效的高通/门限**。
- 现在的一致性靠的是「常量等于本机实测推导值」（都是 120 Hz，见 §1.1（2）），不是靠「运行路径读了产物」。
  用户若要按另一份产物跑，必须显式传 `--highpass-hz <applied.highpassHz>`（门限同理用 `--gate-dbfs`）。
- 把它接进运行路径需要动 `segment.py` 的默认行为（读 profile → 改 VAD 输入与门限），属后续任务；
  在那之前，本节与 §1.1（2）都只声明「产物可用 + 常量与推导一致」，不声明「校准已生效」。

VAD 参数本身：`stop_secs` 保持 ADR-0007 的 0.6（句内 352 ms 停顿的实测不因噪声失效），
`confidence` 在噪声底 >−35 dBFS 时保持 0.7、−45…−35 时 0.65、更安静时 0.6。
**没有**因为噪声改掉 ADR-0007 的 0.6/0.0 基线，见下面第（5）条的实测：改了也没用。

#### （4）高通对 VAD 判定几乎没影响 —— 这是必须写下来的实测结果

用「同一文件、只改 `--highpass-hz`」跑 `voice_edge.segment`。下表**每一行是一支夹具**，
`前端` 列是高通档（`关` = `--raw`，或 60 / 120 Hz）；60 Hz 与 120 Hz 的差 ≤1 帧（32 ms）。
数字逐格来自 `data/voice/frontend-vad-grid.json`（每行有 `highpassHz` 字段，可逐格复核）：

| 夹具（行） | 前端：高通档（列） | 段数 | VAD 起点 | 端点延迟 | 打断判定 |
|---|---|---|---|---|---|
| `direct-question.wav`（干净） | 关 | 1 | 320 ms | 600 ms | 128 ms |
| `direct-question.wav`（干净） | 120 Hz | 1 | 320 ms | 600 ms | 128 ms |
| `direct-question-snr6db.wav` | 关 | 1 | 448 ms | 1056 ms | 0 ms |
| `direct-question-snr6db.wav` | 120 Hz | 1 | 448 ms | 1056 ms | 0 ms |
| `longer-turn-snr0db.wav` | 关 | 1 | 672 ms | — | — |
| `longer-turn-snr0db.wav` | 120 Hz | 1 | **384 ms** | — | — |

（复核用原始格值：`direct-question.wav` 在 关/60/120 三档都是 `start 320 / endDelay 600 / barge 128`；
`direct-question-snr6db.wav` 三档都是 `448 / 1056 / 0`；`longer-turn-snr0db.wav` 是 关 672、60 Hz 672、
120 Hz 384。60 Hz 一列未列进上表，因为它与「关」逐格相同。）

即：**宽带噪声降了 5.3 dB，VAD 的段数/起点/端点基本不变**（个别 0–288 ms 的方向性改善）。
原因合理：Silero 自己就忽略 <100 Hz 的能量；高通真正的价值在能量门限（第（3）条）与
任何看宽带电平的地方，而不是在 Silero 的分段上。把这一点写清楚，是为了避免下一个人
把「降噪 5.3 dB」当成「VAD 会变好 5.3 dB」。

#### （5）谱减法去噪：写了、测了、**默认关闭**（诚实结论）

实现：`frontend.spectral_subtraction`（Boll 1979 式功率谱减法，逐 bin 取帧间低尾估计噪声、
过减因子、谱底限制、50 % 重叠周期 Hann 的 WOLA 重建）。有开关（`segment --nr`）与单元测试。
默认**关**，因为实测不支持它：

| 指标 | 实测（真实夹具的噪声-only 参考段 vs 语音段） |
|---|---|
| 噪声带（300–3400 Hz）下降 | 过减 2.0：0.47 dB；4.0：1.19 dB；6.0：1.91 dB |
| 同时语音带变化 | ≤0.5 dB（过减 2–4）、0–1.4 dB（过减 6） |
| 端到端 ASR 相似度（4 条夹具） | 18 dB：开 0.828 / 关 0.841；6 dB：开/关都 **0.841**；3 dB：**开 0.622 / 关 0.805**（开反而更差）；0 dB：开 0.559 / 关 0.491 |
| 成功边界（同一套夹具、同一评分） | 关：**SNR ≥ 3 dB**；开：只到 **6 dB** |

（两列端到端数字来自同一天同一批夹具的两次 `scripts/verify-voice-noise.ts` 运行：
`data/voice/verify-voice-noise.json`（关）与 `data/voice/verify-voice-noise-with-nr.json`（开）。
脚本默认不跑第二次，用 `--nr` 开关；这份 A/B 就是决定默认值的依据。）

净结论：在这台机器的噪声下，谱减法**噪声带只降 0.5–2 dB，且没有带来 ASR 收益，在 3 dB SNR 上还变差**，
还要为每段 5 s 音频多花 100–300 ms 计算。所以默认关闭，参数与负结论都留在代码与本节里，
将来换麦克风/房间或换成更好的噪声估计（如 MCRA、最小统计量）再用 `--nr` 复测。
过程中修掉的两个真实缺陷（有单测守着）：正交叠加重建少了**窗平方**修正导致整段被压低 2.3 dB；
用「帧级电平选安静帧」的估计器会把语音帧当噪声、把 1 kHz 测试音一起减掉。

#### （6）噪声夹具与成功边界（可复现）

夹具生成（`python -m voice_edge.make_noise_fixtures`，实现 `frontend` 之外唯一的生成器脚本）：
把**实测环境噪声**（`data/recon/ambient-5s.wav`）按目标 SNR 缩放到语音上、再附一段等比例的
噪声-only 参考段，落到 `tests/audio-fixtures/noisy/`（5 夹具 × 6 档 = 30 个 WAV + `manifest.json`）。

SNR 定义（`manifest.json` 里逐条记录，并记录生成方式）：

```text
SNR_inband = 10·log10( P_speech(300–3400 Hz) / P_noise(300–3400 Hz) )
两段都在前端调理（去直流 + 高通）之后测量，缩放系数迭代 3 次收敛（实测目标与实测偏差 <0.01 dB）
```

档位：**18 / 9 / 6 / 3 / 0 / −6 dB**。注意 0 dB 档在这台机器上是**真实可达的状态**：
recon 实测「夹具电平（−24.6 dBFS）下麦克风只比噪声底高 0.8–2.6 dB」，对应我们的语音带
−22 至 −23 dBFS 对噪声带 −28 至 −29 dBFS ≈ 6 dB；用户音量更大或更小就会落到 3 dB 或 0 dB。

`node scripts/verify-voice-noise.ts`（干净 + 噪声夹具 → 前端 → VAD → **真实 MiMo ASR**）
输出每条夹具的转写、字符级相似度、端点延迟、VAD 起点延迟与失败清单，退出码反映成败。

**两张表的出处不同，别混引**（这是 t7 评审 F1 的修正）：
- **相似度 / 检出 / 判定**来自真实 ASR 运行 `data/voice/verify-voice-noise.json`；
- **端点延迟 / VAD 起点延迟**来自同一次运行的 `clips[].vadEndpointDelayMs`（F2 之后该字段不再被截断）。
  修复前用的是被截断的 `clips[].endpointDelayMs`（`min(speech.endMs, cleanEndMs)`，恒 ≤0），
  `tiers[].meanEndPointDelayMs` 实测是 **0 / 0 / 0 / −16 / −96 / null** —— 那是 ASR 切片口径，
  **不能**用来引用端点延迟（这正是 F2 修掉的结构问题）。现在文件同时给出
  `vadEndpointDelayMs` / `tiers[].meanVadEndpointDelayMs` / `maxVadEndpointDelayMs`。
  下表的端点延迟列写成**逐条值（最大）**，而不是均值。
- **两条命令能各自复现**（都不花钱的那条也能复现端点延迟）：
  `node scripts/verify-voice-noise.ts --fake --tiers 6` 报出
  `direct-question 1056 / followup-turn 1376 / longer-turn 1472 / tv-dialogue 1088`（与下表 6 dB 档逐格一致）；
  `python -m voice_edge.segment tests/audio-fixtures/noisy/direct-question-snr6db.wav` 报
  `segments[0].endpointDelayMs = 1056`。修复前 `--fake` 这一列恒为 0。

2026-09-30 实测（相似度列：`data/voice/verify-voice-noise.json`；端点/起点列：`frontend-vad-grid.json` 120 Hz 行。
`backchannel` 不计入：Silero 本来就看不见「嗯。」，§2）：

| SNR 档 | 检出 | 平均字符相似度 | 端点延迟逐条值（最大） | VAD 起点延迟逐条值 | 判定 |
|---|---|---|---|---|---|
| 干净 | 4/4 | 0.800 | 728 / 704 / 864 / 704 → 最大 864（均值 750） | 0 ms | PASS |
| 18 dB | 4/4 | 0.841 | 640 / 640 / 640 / 640 → 最大 640 | −72 ms | PASS |
| 6 dB | 4/4 | 0.841 | 1056 / 1376 / 1472 / 1088 → **最大 1472**（均值 1248） | −56 ms | PASS |
| **3 dB** | **4/4** | **0.805** | 104 / 128 / −64 / 96 → 最大 128（均值 66） | −40 ms | **PASS** |
| 0 dB | 4/4 | 0.491 | 72 / −32 / −352 / 64 → 最大 72（均值 −62） | 344 ms | FAIL（2 条相似度 <0.6） |
| −6 dB | 0/4 | — | 0 条有效（全部漏检） | — | FAIL（全部漏检） |

**端点延迟这一列的当前实测（`node scripts/verify-voice-noise.ts`，逐条值来自 `clips[].vadEndpointDelayMs`；
F2 修复后该列**不再恒为 0**）：**
- **端点延迟只由 VAD + 能量门限决定，与 ASR 无关**：代码依据是 `scripts/verify-voice-noise.ts`
  只用到 `speech.endMs` 与 `segmentation.energyEndMs` 两个量（VAD 分段与校准门限），
  转写结果不参与这个数的计算。因此 **`--fake` 报出的这一列就是真实 ASR 会得到的值**，离线一次即可复核：
  `node scripts/verify-voice-noise.ts --fake --tiers 6`（6 dB 档 1056/1376/1472/1088）。
  真实 ASR 的那份报告也留在盘上、可以直接查：`data/voice/verify-voice-noise.json`
  （`mode: "real-asr"`，`clips[].vadEndpointDelayMs`；同一批夹具逐条值与离线一致）。
- **与历史网格（`frontend-vad-grid.json`）的差异要说明**：网格记录的 6 dB 档 1056/1376/1088/1472 与当前一致，
  但 3 dB 档网格只有 `direct-question` 一条有效（1088），当前 4 条都有值（104/128/−64/96）；
  0 dB 档网格全为 null，当前 4 条都有值。差异来自 `voice_edge.segment` 在 F2 前后对
  `energyEndMs`（校准门限口径）的取值变化——**以当前实测为准**，网格那份是修复前的历史记录。
- **判据仍然全部通过**：`ENDPOINT_DELAY > 1500 ms` 现在可达（最大值 1472 ms 距门限仅 28 ms），
  但没有一条超限——所以 6 dB 档仍是 PASS，而这条判据从此是**真的在测东西**。

逐条失败样本（保留原样，不删）：0 dB 档 `followup-turn` →「嗯。」（相似度 0）、`tv-dialogue` →「怎么了？」（0.286）；
−6 dB 档 4 条全部 `NO_SPEECH_DETECTED`。
（`endpointDelayMs = null` 表示该条没走到「端点延迟可算」的条件，不是 0 ms；0 dB 与 −6 dB 档在
`verify-voice-noise.json` 里的 `−96 / null` 是**另一个口径**（检测窗截断），不要与本列混用。）

**可复现的成功边界（写死）**：

> **SNR_inband ≥ 3 dB 时，4 条中文夹具全部检出，平均字符相似度 0.805（≥0.6）。
> 端点延迟不是这个边界的判据**（3 dB 档 4 条逐条值为 104 / 128 / −64 / 96 ms，最大 128；
> `frontend-vad-grid.json` 里的 1088 是修复前的历史记录，见上表逐条值列）。
> 0 dB 时仍能全部检出但转写质量掉到 0.491（个别夹具只吐出一个语气词）；−6 dB 完全不可用。

（`report.boundary.claim` 由脚本自动写入，它只声明「相似度 + 无漏检 + 无超长端点」三件事，
不声明端点延迟的具体数值；本节不把 `lowestPassingTierDb` 与端点延迟数字绑在一起。）

边界值取自 `report.boundary.lowestPassingTierDb`（脚本自动算），不是手写的。
三个已知的测量约定：
- **困难样本不删**：`tests/audio-fixtures/noisy/` 里的 0 dB 与 −6 dB 档全部保留
  （`tests/unit/voice/frontend.test.ts` 有一条测试专门守住「最低 SNR 档必须仍在盘上」）。
- **端点延迟在噪声下会变晚，而且逐条差异大**：干净档逐条 728 / 704 / 864 / 704 ms（均值 750），
  6 dB 档逐条 1056 / 1376 / 1472 / 1088 ms（均值 1248、最大 1472），3 dB 档 4 条逐条为 104 / 128 / −64 / 96 ms（最大 128）；
  0 dB 档 4 条逐条 72 / −32 / −352 / 64 ms（最大 72），−6 dB 档 0 条（全部漏检）。所以任何「本档端点延迟 = 某个均值」的写法都不成立，
  本文件一律给逐条值（最大）。
- **端点延迟的口径（F2 修正后，全文件只用这一个公式名）**：判据用的
  `vadEndpointDelayMs = speech.endMs − energyEndMs`（**不截断**；
  `energyEndMs = segmentation.energyEndMs ?? cleanEndMs`——**只有**在 segment 没给出能量端点时
  才回退到干净版语音结束点，代码见 `scripts/verify-voice-noise.ts`），
  与 ASR 切片用的 `detectedEnd = min(speech.endMs, cleanEndMs)`（截断，保证只上传语音段）分开。
  修好之前 `endpointDelayMs` 恒 ≤0，`ENDPOINT_DELAY > 1500 ms` 这条判据结构上不可达（t7 评审 F2）。
  **不要把 `cleanEndMs` 当成端点延迟的第二个公式**：它只是能量端点缺失时的回退。
- `0 dB` 档的 `tv-dialogue` 转写为「嗯。」而相似度 0：这是 ASR 在极低 SNR 下的事实输出，保留原样。

#### （7）实时链路优先 WASAPI（沿用 recon 结论）

recon §2.3 实测往返延迟：**WASAPI 42.9 ms vs MME 229.6 ms**（同一扫频、同一夹具电平，3 次重复）。
因此 `voice_edge.calibrate` 的默认设备选择按 `Windows WASAPI > MME > DirectSound > WDM-KS` 排名
（`HOST_API_PREFERENCE`），现场测试的实时链路也应显式选 WASAPI 设备；MME 的 230 ms 会直接
吃进 §33 的 P50 < 500 ms 打断目标。注意这仍**没有**端到端对话延迟的实测（§6）。


## 2. 为什么 backchannel（「嗯。」）不能交给 VAD —— 这是 M2 必须自己做的部分

三条独立实测，结论一致：

1. **Pipecat 的 Silero VAD 完全检不到「嗯。」**：峰值置信度 **0.5274 < 0.7**；
   改 `confidence=0.5`、`min_volume=0`、`stop_secs` 0.2–1.0 **全部无效**（pipecat-spike §3）。
   本节复测同样得到 `backchannel.wav` 无任何 segment。
   注意：需求「backchannel 不算打断」只是**碰巧成立**——它连语音都没被识别，也就进不了 ASR；
   同一机制意味着真需要识别时也拿不到。
2. **两个框架的 EOU / turn detector 都判错**：
   - LiveKit 文本 EOU（`livekit/turn-detector` v0.4.1-intl，中文阈值 **0.0066**）：
     无上文时「嗯。」p=0.00878 ≥ 0.0066 → `finished=True`（**判错**）；带上一轮 assistant 文本时 p=0.003671 < 0.0066 → `finished=False`（对）。
   - LiveKit 音频 EOU（`inference.TurnDetector(version="v1-mini")`，zh 阈值 0.355，延迟 53–75 ms）：
     p=0.43–0.44 ≥ 0.355 → `finished=True`（**也判错**）。
   - Pipecat 的 smart-turn 只在 VAD 停止时被调用，看到的音频已经截断，救不了（见 §5 的 0.6788）。
3. **电视与真人无法靠 VAD/EOU 区分**：同词、只差有没有唤醒词的 `tv-dialogue.wav`
   被 Pipecat smart-turn 判 COMPLETE **p=0.9228**，与直呼提问的 **p=0.9557** 无法区分；
   LiveKit EOU 同样把电视判成「说完」（p=0.91）。

**结论（必须写死）：唤醒词、backchannel 判定、电视/真人区分都是 M2 必须由西西自己的程序逻辑完成的部分**
（ADR-0007 Decision 第 3 条）。可用信号是唤醒词分数 + 说话人相似度 + 会话状态 + 语义承接的融合判定（§13），
不能委托给 VAD 或 end-of-turn 模型。当前 `packages/conversation` 只有「IDLE 需唤醒或强直呼」的状态机
（`ACCEPTED_WAKE_OR_DIRECT`），**唤醒检测本身由调用方负责**：`scripts/serve-chat.ts` 把 UI 按钮当作直呼，
`config/xixi.example.yaml` 里 `features.wake_word: false`。

## 3. 语音输入的两条路径

| | Python `sounddevice`（`voice_edge/loopback.py`） | **浏览器 `getUserMedia`**（`scripts/serve-chat.ts` 的 `/api/voice`） |
|---|---|---|
| 用途 | 设备回环验收工具：播夹具 → 麦克风录回 → 重采样 16 kHz PCM16 | 真实输入路径（试用页「按住🎤」） |
| 上一轮实测结果 | **不可用**：能打开设备、能播放录音，但录音 **0–100 Hz 占 99.49% 能量**，200 Hz 高通后 RMS 只剩 0.0322；Silero 103 帧全 `QUIET`、`segments: []`，MiMo ASR 整段返回空字符串（device-acceptance） | 走浏览器自己的音频前端：`audio: {channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true}` |
| 判据修正（2026-09-30） | 旧判据 `rms > 0.005` 是**假 PASS**（recon §2.5：端点静音时 rms 0.05053 反而更高，因为环境噪声底就有 0.043）。现改为**相对判据**：播放窗 vs 前置静音窗的语音带电平差 ≥10 dB，或与已知播放信号归一化相关 ≥0.3；并读 Core Audio 的 `muted`/音量（`pycaw`，可选依赖）。输出把 `rendered`（程序渲染了音频）与 `audible`（能听见）分成两个结论 | 不受影响 |
| 新判据实测（夹具 `direct-question.wav`，音量 0.6，WASAPI 采集） | `speechBandLiftDb` **+1.09 dB**（需 ≥10）、`correlation` **0.0206**（需 ≥0.3）、端点 `muted:false`、音量标量 0.661 → `verdict: "no-audible-signal"`，退出码 3。与 recon §2.4 的 0.8–2.6 dB 一致：**这个音量下声学通路本身没有可用余量，FAIL 不等于扬声器没响** | — |
| 结论 | 原因在机器声学配置（音量/静音/设备），不是代码（device-acceptance 定位）；工具现在会明确区分「静音端点」「音量不足」「程序没渲染」三种情况 | **优先路径**；浏览器负责 AEC/NS/AGC，正好补上 §14.1 的前三级 |

浏览器路径的流程（`scripts/serve-chat.ts` → `handleVoice`）：

1. `getUserMedia` → `AudioContext` 的 `createScriptProcessor(4096, 1, 1)` 采集 Float32 → `encodeWav` 成 16-bit PCM 单声道 WAV → base64 上传（未使用 `MediaRecorder`）；
2. 服务端先把整段录音写到 `data/voice-web/capture-<ts>.wav`，再调 Python VAD（`voice_edge.segment`）；
3. `segments[0]` 为空时直接返回 `accepted:false, reason:'NO_SPEECH_DETECTED'`，不进 ASR（前端提示「麦克风里没检测到语音」）；
4. 有语音时**只把该语音段**切出来写 `speech-<ts>.wav` 并用它做 ASR（`sliceWav`，§20.1）；
5. 回合交给 `ConversationEngine`，`action === 'SPEAK'` 才调 TTS，音频以 base64 返回给浏览器播放。

**隐私约束**：只有 VAD 检测到的语音段进入 ASR 与模型（`scripts/voice-turn.ts` 同样在注释里写明
`Only the speech span is uploaded (§20.1)`）。
**但要注意**：`data/voice-web/capture-*.wav`（整段原始录音）与 `data/voice/speech-*.wav` **确实落在本地磁盘上**，
`data/` 已 gitignore；当前**没有**保留期/清理代码（详见 [security-and-privacy.md](security-and-privacy.md)）。

## 4. 打断（§14.2）

实现：`scripts/voice-bargein.ts`。步骤对应方案 §14.2：西西「正在说话」用它的 TTS 回复音频代表 →
用户音频从 `--at 800` ms 处开始 → VAD 判定 → 截断回放 → 丢弃未播缓冲。

| 项 | 实测 | 说明 |
|---|---|---|
| 判定延迟 | **192 ms** | `segmentation.bargeInDecisionMs` = VAD 首次提交 `STARTING/SPEAKING` 的时刻 − 真实语音起点（`energy_bounds_ms`）。§33 目标 < 500 ms |
| 播放截断点 | 992 ms | `startsAtMs(800) + 192` |
| 丢弃的未播音频 | 4128 ms | 助手音频总长 − 截断点 |
| 可审计证据 | `data/voice/bargein-truncated.wav` | 截断后的 WAV 被写出来，而不是只断言数字 |

（`followup-turn.wav` 单跑 VAD 时 `bargeInDecisionMs=192.0`，与本表一致。
**噪声下的变化**：`bargeInDecisionMs` 的真值离家是前端调理后的能量门限（§1.1（3）），
所以噪声底抬高时判据本身也会变严；同一支夹具在 6 dB SNR 下 `bargeInDecisionMs` 变为 **0 ms**、
`followup-turn` 在 0 dB 档则不再提交 `STARTING`（见 `data/voice/frontend-vad-grid.json`）。
即：**打断判定在噪声下不是变慢而是变得不可靠**，这是 §6 的未验收项。）

**尚未验收的部分**：以上全部是「判定层」的证据。`scripts/voice-bargein.ts` 的 `caveat` 字段与 ADR-0007 都明确写着：
**扬声器真正静音的延迟无法离线测量**，需要设备测试（§33 的 P50 < 500 ms 目标因此**尚未验收**）。
Pipecat 1.12.0 能离线复现 `UserTurnProcessor` 广播 `InterruptionFrame`（836 ms），但那也只是帧被广播，
不是扬声器停了（注意 1.12.0 **没有** `BotInterruptionFrame`/`StartInterruptionFrame`）；
`enable_interruptions` 默认 True 且**不看机器人是否在说话**（pipecat-spike §6）。

## 5. 性能与冷启动

`voice_edge/segment.py` 的输出把两个成本**故意分开**（`timings.loadMs` / `timings.processMs`）：

- `loadMs`：构造 `SileroVADAnalyzer`（含 ONNX 会话初始化）——**冷启动**，常驻语音服务只付一次；
- `processMs`：逐帧 `analyze_audio` 的累计耗时——这才是流式管道每帧的真实成本。

本次实测（见 §1 表）：`loadMs` 204–305 ms、`processMs` 51–146 ms（2.5–4.1 s 音频）。
另外每次 VAD 还要加一次 **Python 解释器启动**：`scripts/voice-turn.ts` 用 `spawn(PYTHON, ['-m', 'voice_edge.segment', ...])`，
**当前是每段音频一个一次性进程**（AGENTS.md §3 的取舍：崩溃不留挂死监听器；代价是每轮付冷启动）。
把 Node 驱动 Python 的一次性进程换成常驻服务是 progress §4 第 2 项的待办。

各段实测耗时（progress §0/§2.9）：ASR 0.34–0.73 s、LLM 首字 1.7–2.3 s、TTS 1.0–2.0 s、
端到端首条回复音频 **3.6–5.5 s**（含 Python 冷启动与整段 TTS 合成）。
`scripts/voice-turn.ts` 按 §46.4 逐段记录：`vadMs`、`vadProcessMs`、`vadModelLoadMs`、`asrMs`、
`llmFirstChunkMs`、`llmTotalMs`、`ttsMs`、`e2eSpeechEndToFirstChunkMs`、`e2eToFirstReplyAudioMs`；
其中两个 e2e 的算法是 `端点延迟 + asrMs + 首字延迟(+ ttsMs)`，**含 VAD 端点延迟**，脚本里以 `note` 字段声明。

对照选型的成本（ADR-0007）：Pipecat `import pipecat` ~89 ms、冷启动到 VAD 可用 ~0.8 s、峰值 RSS ~118 MB；
LiveKit 全套导入 3799.6 ms、峰值 RSS 398.4 MB、turn detector 权重 **412 MB**（首次使用必须联网，加载 6.9 s）。

**前端自身的成本**（2026-09-30 实测，`data/voice/frontend-vad-grid.json` 的 `frontendMs`/`noiseReductionMs`）：
`voice_edge.segment` 现在多了 DC 去除 + 高通（双二阶、纯 numpy 逐样本递归）与（可选的）谱减法。

| 环节 | 5 s 音频实测 | 说明 |
|---|---|---|
| 去直流 + 高通 | **~60–90 ms** | 纯 Python 逐样本双二阶，一次性成本；替换成已有依赖的 IIR/SOS 实现可降一个数量级，当前不引入新依赖（AGENTS.md §12） |
| 谱减法（`--nr`） | **~100–300 ms** | 默认关闭，见 §1.1（5） |
| VAD `processMs` | 51–146 ms | 不变 |

即每轮多付约 60–90 ms（离线）——相对 §5 的 LLM 首字 1.7–2.3 s 可忽略，但它落在**语音开始延迟**的路径上，
常驻服务化时应把这个滤波放进流式管道（零相位滤波会带来约一个 hop 的延迟，需要重新测）。

## 6. 未实现 / 未验收（写清楚，别当成已完成）

- 唤醒词与搭话判定（M2）；`features.wake_word: false`。
- 说话人验证 / 声纹（M2；`features.speaker_verification: false`）。
- backchannel 的独立短音频通路（§14.3）：现在的「不打断」只是因为 VAD 检不到，不是设计。
- 常驻语音服务（当前一轮一进程，每次付 Python 冷启动）。
- 真实麦克风与扬声器验收：**已测但链路无信号**（99.49% 能量 <100 Hz），属机器配置；
  2026-09-30 修掉假 PASS 后复测（§3）得到语音带只抬高 1.09 dB、相关 0.0206，判 `no-audible-signal`；
  两条复现命令在 device-acceptance 报告里（`voice_edge.loopback` 与 `scripts/voice-device-check.ts`，相似度 ≥ 0.5 判 PASS）。
- 扬声器真正静音的延迟（§14.2/§33 的 P50 < 500 ms）。
- 电视误触率（M2 的对照夹具 `tv-dialogue.wav` 已就绪）。
- ASR/TTS 的本地兜底（§21.2/§21.3）。
- **真实麦克风的噪声底尚未在本轮重新标定**：§1.1 的数字来自 t1 勘测的 `data/recon/ambient-5s.wav`（+5.5 dB 采集增益）。
  现场测试前应跑一次 `python -m voice_edge.calibrate --seconds 5`（并把采集增益调到 0 dB），
  否则门限与采集增益建议可能对不上当前设备状态。
- **噪声条件下的端点延迟变差**：6 dB SNR 档逐条 1056/1376/1472/1088 ms（均值 1248、最大 1472；
  干净档逐条 728/704/864/704 ms），3 dB 档逐条 104/128/−64/96 ms（最大 128），
  0 dB 档逐条 72/−32/−352/64 ms；只有 −6 dB 档 4 条全部漏检、一条都算不出。端到端响应会明显拖长。
  `endpointDelayMs`（截断口径，供 ASR 切片）与 `vadEndpointDelayMs`（不截断口径，供判据）在
  `scripts/verify-voice-noise.ts` 里逐条记录；端点延迟不是成功边界的判据（§1.1（6））。
- **噪声下的打断判定不可靠**（§4）：0 dB 档 `followup-turn` 根本没有 VAD 事件。

## 维护规则

| 改了哪个源文件 | 必须同步更新本文件的小节 |
|---|---|
| `services/voice-edge/voice_edge/config.py`（基线参数） | §1（参数表与理由）、§2（端点/起始数字） |
| `services/voice-edge/voice_edge/frontend.py`（前端纯函数） | §1.1（全部子节：截止频率、门限、去噪结论、边界数字），并重跑 `scripts/verify-voice-noise.ts` 更新边界 |
| `services/voice-edge/voice_edge/calibrate.py`（校准入口/字段） | §1.1（2）（JSON 字段与命令，含 `applied`/`consistency` 与「建议=生效值」的取舍） |
| `services/voice-edge/voice_edge/frontend.py` 的 `DEFAULT_HIGHPASS_HZ` / `apply_calibration` / `load_calibrated_params` | §1.1（2）（一致性契约与回退行为） |
| `tests/unit/voice/frontend.test.ts` | §1.1（2）（证据与回归那条）；改了断言口径时同步说明 |
| `services/voice-edge/voice_edge/make_noise_fixtures.py`（夹具生成） | §1.1（6）（SNR 定义与档位） |
| `services/voice-edge/voice_edge/segment.py` | §1（实测表）、§1.1（3）（门限）、§5（`loadMs`/`processMs`、前端成本、帧长） |
| `services/voice-edge/voice_edge/loopback.py` | §3（Python 路径、判据与实测结论） |
| `scripts/verify-voice-noise.ts` | §1.1（6）（边界表、失败规则）；`docs/testing.md` 的脚本表 |
| `scripts/voice-turn.ts` | §3（只上传语音段）、§5（分段耗时字段与 e2e 公式） |
| `scripts/voice-bargein.ts` | §4（判定延迟、截断证据、未验收项） |
| `scripts/serve-chat.ts` 的 `/api/voice` 或前端采集参数 | §3（浏览器路径、AEC/NS/AGC、落盘文件） |
| 新增唤醒词 / 说话人验证 / 常驻语音服务 | §2（M2 的结论是否仍成立）、§6（未实现清单） |
| 换 VAD 框架或调 `stop_secs`/`min_volume` | §1、§2，并更新 [recon/pipecat-spike-2026-09-29.md](../recon/pipecat-spike-2026-09-29.md) 的复测记录 |
