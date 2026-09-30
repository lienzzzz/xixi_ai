# 现场测试设备与依赖勘测（2026-09-30）

> 最后更新：2026-09-30
> 权威来源：本文件是**本机实测原始记录**（docs/recon 层）。所有数字都来自本机命令输出，
> 采集脚本与产物在 `data/recon/`（该目录在 `.gitignore` 内，只保存在本机）。
> 环境：Windows 笔记本 + Realtek High Definition Audio（内置麦克风阵列 + 内置扬声器）+ Chicony USB2.0 Camera。
> 约束遵守情况：只用 CPU 依赖；音频/画面一律不出本机（无任何上传）；除本文档外只在 `.venvs/` 与 `data/` 下写文件。

## 0. 结论速览

| # | 问题 | 结论 | 性质 |
|---|---|---|---|
| 1 | 麦克风能不能用 | **能**。默认输入是 MME 设备 1「麦克风 (Realtek High Definition Audio)」2ch/44.1k | 实测 |
| 2 | 「噪音大」是什么噪音 | **以 100 Hz 以下低频隆隆声为主（约 56% 的能量）**，叠加 100 Hz 以上一条**稳态宽带嘶声**；**没有 50/60 Hz 工频谐波**（50/60/100/120/150/200/250/300 Hz 处 line/far 比值 0.80–1.42，全部 ≈ 1，无显著线谱） | 实测 |
| 3 | 静音环境噪声底 | 5 秒环境录音：RMS **−27.25 dBFS**、峰值 −14.66 dBFS、噪声底（50 ms 帧 p10）**−30.86 dBFS** | 实测 |
| 4 | 噪音来自房间还是电路 | 双通道相干性在四个频段都 ≈ 0（0.009–0.020），两通道电平差 0.09–5.28 dB → **更像每通道独立的电子/前置噪声，而不是同一个声场** | 推断（有实测支撑） |
| 5 | 麦克风增益 | 默认采集增益是 **+5.5 dB**（不是 0 dB）。降到 0/−6/−12 dB，噪声底几乎 1:1 跟着降（每 6 dB 步进 → 5.68/6.05/6.11 dB） | 实测 |
| 6 | 扬声器是否有声音 | **默认输出端点出厂状态是「已静音」（muted=true）**。音量标量 0.661（−6.19 dB）但被静音 → 这解释了 `device-acceptance-2026-09-30.md` 里「播放成功但录不到语音」 | 实测 |
| 7 | 解除静音后声学通路是否通 | **通**。0.5 幅度扫频（play −9 dBFS RMS）往返：归一化相关峰 **0.49–0.51**（次峰仅 0.012），语音带 300–3400 Hz 电平由 −37.07 dBFS 抬到 **−14.17 dBFS（+22.9 dB）** | 实测 |
| 8 | 往返延迟 | **MME ≈ 230 ms；WASAPI ≈ 43 ms**（各 3 次，±10 ms） | 实测 |
| 9 | 普通音量下的夹具回环 | **不可靠**：夹具（play −24.64 dBFS）在 4 种采集配置下，播放期语音带只抬高 **0.8–2.6 dB**，相关峰 0.035–0.098 | 实测 |
| 10 | 现有回环验收工具 | **假 PASS**：`services/voice-edge/voice_edge/loopback.py` 在扬声器静音与不静音两种状态下都输出 `verdict: "ok"`（rms 0.0505 vs 0.0486），因为它的判据 `rms > 0.005` 远低于环境噪声底（0.043） | 实测 |
| 11 | 干净的「到底有没有出声」测法 | **WASAPI loopback 抓渲染流**：播夹具时与夹具相关 **0.9996**，静默段是数字零（−187 dBFS）。但它**不受端点静音影响**（静音时同样 0.9996），所以只能证明「程序渲染了音频」，不能证明「耳朵能听见」 | 实测 |
| 12 | 摄像头 | 1 个：Chicony USB2.0 Camera，**只有 DSHOW 后端能开**（MSMF 打不开）。640×480 抓帧均值 **33.4 ms（≈30 fps）**，首帧 71 ms，开设备 379 ms | 实测 |
| 13 | 摄像头分辨率 | 320×240 / 640×480 / 1280×720 都真实可用；请求 1920×1080 会被**封顶到 1280×720** | 实测 |
| 14 | 麦克风 + 摄像头并发 | 6 秒录音同时抓帧：150 帧 / 5.54 s = **30.0 fps**，p95 48.1 ms → 并发不影响帧率 | 实测 |
| 15 | 隐私开关 | 注册表 ConsentStore：**webcam = Allow、microphone = Allow** | 实测 |
| 16 | `opencv-python-headless` 5.0.0 | **移除了 `cv2.CascadeClassifier` 与 `cv2.HOGDescriptor`**（`dir(cv2)` 里没有，`cv2.objdetect` 子模块也不存在）。要 Haar/HOG 必须钉 4.x（4.14.0 实测可用） | 实测 |
| 17 | 人脸检测可用性 | YuNet 227 KB 模型：640×480 中位 **38.3 ms**（cv4）/ 均值 29.0 ms（cv5）；320×240 中位 6.1 ms。正对照（46 张脸的自拍照）检出 46，Lena 检出 1 | 实测 |
| 18 | 「人物在场」可行路径 | 本机 CPU 上**可行**：帧差动（1.17 ms/对，噪声底 0.8 灰阶）做廉价门 + YuNet 人脸做确认。HOG 行人检测**不可靠**（空场景误报 0–2 个框，107.6 ms/帧） | 实测 + 推断 |
| 19 | 需要下载模型吗 | Haar/HOG 不需要（OpenCV 自带）；YuNet 需要（227 KB，本机直连 GitHub 可下）。ONNX 轻量**行人**检测模型**未评估**（需要多 MB 模型 + 自己写后处理） | 实测 / 未评估 |
| 20 | 有 GPU 依赖吗 | 没有。onnxruntime 1.30.0 只报 `CPUExecutionProvider`（+ Azure），全部测量在 CPU 上完成 | 实测 |

---

## 1. 麦克风

### 1.1 设备枚举

命令（以下 Python 一律用隔离 venv，不要用系统 3.14）：

```powershell
E:\worker2\.venvs\voice-livekit\Scripts\python.exe data\recon\probe_mic.py
```

产物：`data/recon/probe_mic.json`、`data/recon/probe_mic.txt`、`data/recon/ambient-5s.wav`。

sounddevice 0.5.6 / PortAudio V19.7.0-devel，4 个 host API：

| index | 设备 | host API | in | out | 默认采样率 |
|---|---|---|---|---|---|
| 0/1 | Microsoft Sound Mapper / **麦克风 (Realtek High Definition Audio)** | MME | 2 | 0 | 44100 |
| 2/3 | Sound Mapper / **扬声器 (Realtek High Definition Audio)** | MME | 0 | 2 | 44100 |
| 4/5 | 主声音捕获/麦克风 | DirectSound | 2 | 0 | 44100 |
| 6/7 | 主声音驱动程序/扬声器 | DirectSound | 0 | 2 | 44100 |
| 8 | 扬声器 (Realtek High Definition Audio) | **WASAPI** | 0 | 2 | **48000** |
| 9 | 麦克风 (Realtek High Definition Audio) | **WASAPI** | 2 | 0 | **48000** |
| 10 | Realtek HD Audio Mic input | WDM-KS | 2 | 0 | 44100 |
| 11 | Realtek HD Audio Stereo input | WDM-KS | 2 | 0 | 48000 |
| 12 | Speakers (Realtek HD Audio output) | WDM-KS | 0 | 2 | 44100 |

- 默认输入 = **1**（MME 麦克风，2ch/44.1k）；默认输出 = **3**（MME 扬声器，2ch/44.1k）。
- `sd.check_input_settings` / `check_output_settings` 对 8000/16000/22050/32000/44100/48000/96000 **全部接受**。
  注意：这是 PortAudio 层的接受，**不等于设备原生支持**（本机默认 44.1k/48k，其余很可能由驱动重采样），未做原生性验证。

### 1.2 五秒环境噪声（实测）

条件：默认输入设备，2 通道，44.1 kHz，5.0 秒，房间里没有人刻意说话。

| 指标 | 数值 |
|---|---|
| DC 偏置 | −0.000103（可忽略；上一轮在**带播放的回环录音**上测到 −0.328，那是另一类录音，本轮是纯环境录音） |
| RMS | 0.043391 → **−27.25 dBFS** |
| 峰值 | 0.18483 → −14.66 dBFS |
| 噪声底（50 ms 帧的 p10） | **−30.86 dBFS** |
| 波峰因数 crest | 12.59 dB |
| 频段占比（2048 点 FFT，逐段去均值） | 0–100：43.07%｜100–300：22.56%｜300–3400：31.65%｜3400+：2.71% |
| 频段占比（32768 点 FFT，1.346 Hz 分辨率，12 个窗） | 0–100：**63.58%**｜100–300：14.50%｜300–3400：20.18%｜3400–8000：1.44%｜8000+：0.31% |
| 时域分带（50 ms 帧，<100 Hz 移动平均） | <100 Hz：rms −29.94 dBFS｜>100 Hz：rms **−31.07 dBFS** |
| 谱平坦度（20 Hz–8 kHz，几何均值/算术均值） | 0.116（偏有色噪声，不是纯白） |

> 两种 FFT 窗长给出的 0–100 Hz 占比不同（43% vs 64%），差异来自低频泄漏与逐段去均值，**不要单独引用某一个**。
> 时域分带最干净：**<100 Hz 占噪声功率约 56%（0.03182² / (0.03182² + 0.02796²)），>100 Hz 约 44%**。

### 1.3 「噪音大」到底是什么噪音（实测）

命令：`... python.exe data\recon\probe_mic_spectrum.py`（产物 `data/recon/probe_mic_spectrum.json`）

**（a）不是工频谐波。** 在 50/100/150/200/250/300/60/120 Hz 上做「线谱功率 / 邻近等效带宽功率」比值：

| 频率 | 50 | 60 | 100 | 120 | 150 | 200 | 250 | 300 |
|---|---|---|---|---|---|---|---|---|
| line/far | 0.92 | 0.83 | 0.80 | 0.83 | 0.94 | 0.85 | 1.03 | 1.42 |

全部 ≈ 1，**没有任何一条明显高于邻域**，即没有 50 Hz 工频及其谐波串。

**（b）100 Hz 以下是宽带隆隆声 + 慢漂移，不是单音。** 窄带峰（相对最强峰 dB）：
1.35 Hz 0.0｜5.38 −4.1｜24.22 −9.5｜18.84 −9.9｜43.07 −11.7｜29.61 −11.9｜34.99 −12.0｜51.14 −13.4｜68.64 −13.7｜87.48 −14.4。
最强的 1.35 Hz 正好等于该分析的分辨率，说明存在极慢漂移；其余能量铺在 5–90 Hz，而不是集中在某一条线。

**（c）100 Hz 以上是一条稳态嘶声。** 50 ms 帧包络的 p95/p05：
- <100 Hz：**3.97**（起伏明显，像低频机械/结构噪声）
- \>100 Hz：**1.23**（几乎恒定，像电子自噪声或稳定风扇声）

**（d）来源判别：双通道相干性。** 命令 `... python.exe data\recon\probe_coherence.py`（产物 `data/recon/probe_coherence.json`）

| 频段 | 0–100 | 100–300 | 300–3400 | 3400–8000 |
|---|---|---|---|---|
| 平均相干性 | 0.0087 | 0.0097 | 0.0198 | 0.0184 |
| 两通道电平差 | 0.09 dB | 2.51 dB | 5.28 dB | 4.58 dB |

时域相关系数 0.0457。**如果这是同一个声场打在相邻两个振膜上，低频相干性应该很高（>0.5）；实测接近 0**，
因此更可能是**每通道独立的电子/前置噪声**（也可能被驱动的阵列处理拆成两路），而不是「房间很吵」。
两个通道本身电平差 5.28 dB（语音带），说明两路并不等价 —— 后续做阵列平均/选路时要重新测。

### 1.4 采集增益扫描（实测，直接回答「噪声为什么大」）

命令：`... python.exe data\recon\probe_record.py <label> 3`（增益用 pycaw 设定，见 §7）。
产物 `data/recon/mic-gains.json`、`data/recon/mic-gain*.wav`。

| 采集增益 | RMS（dBFS） | 噪声底 p10 | 语音带 300–3400（该方法内部标定） |
|---|---|---|---|
| **+5.5 dB（出厂/当前）** | **−27.73** | −30.81 | −23.38 |
| 0 dB | −33.41 | −36.72 | −28.87 |
| −6 dB | −39.46 | −42.51 | −34.81 |
| −12 dB | −45.57 | −48.57 | −41.06 |

每 6 dB 步进实际下降 5.68 / 6.05 / 6.11 dB → **噪声几乎完全跟着采集增益走**，所以「把麦克风增益调下来」
能直接降低噪声底约 5.5 dB（默认比 0 dB 高 5.5 dB）。代价是同样幅度的话音也降 5.5 dB ——
在 ADC 之后做软件增益不会更差，因此**建议把采集增益设为 0 dB**，需要时在前端用软件增益补。
本机采集端点范围 −17…+12 dB，增量 0.031 dB。

### 1.5 麦克风结论

1. 输入链路**可用**，2 通道 44.1k/48k 都行，默认设备就是内置阵列。
2. 「噪声大」的构成：**低频（<100 Hz）宽带隆隆声 ≈ 56% 功率** + **100 Hz 以上稳态嘶声（约 −31 dBFS）≈ 44%**，无工频谐波。
3. 噪声主要不是「房间吵」，而是与采集增益 1:1 的电子底噪（相干性 ≈ 0 支持这一点）。
   —— 这部分是**推断**：真正的判决性实验需要物理遮挡麦克风/拔掉外接麦克风，本机无法远程完成。
4. 对前端的要求（可直接落地）：**先 100–120 Hz 高通**（拿掉一半以上噪声功率），再做噪声抑制/VAD；
   采集增益设 0 dB；不要假设两个通道等价（电平差 5.28 dB、相干性 ≈ 0），要么选一路，要么按实测重测阵列。

---

## 2. 扬声器

### 2.1 默认输出与采样率

默认输出 = MME 设备 3「扬声器 (Realtek High Definition Audio)」，2ch/44.1k；WASAPI 对应设备 8（48k）。
检查 8k–96k 全部被 `check_output_settings` 接受（同为 PortAudio 层结论，非原生性证明）。

### 2.2 关键发现：默认输出端点出厂是静音的（实测）

用 Windows Core Audio（pycaw 20260927）直接读端点状态（命令见 §7）：

```json
{
  "label": "default render",
  "friendly_name": "扬声器 (Realtek High Definition Audio)",
  "master_volume_scalar": 0.661,
  "master_volume_db": -6.187,
  "muted": true,
  "volume_range_db": [-65.25, 0.0, 0.031]
}
```

采集端点：`master_volume_scalar 0.8012`（**+5.5 dB**，范围 −17…+12）、`muted: false`。

**这解释了上一轮 `docs/recon/device-acceptance-2026-09-30.md` 的失败现象**：`sd.playrec` 返回成功、
录音 RMS 0.396「看起来很响」（其实那 0.396 是低频偏置/噪声，不是语音），但语音带里什么都没有 —— 因为**输出端点被静音**。
结论更新：那轮总结的「三个可能原因」中，**第 1 条（系统输出静音）成立**，第 2、3 条在当前证据下不需要成立。

### 2.3 声学通路：扫频往返（实测）

命令：`... python.exe data\recon\probe_acoustic_path.py`（200 Hz→6 kHz 对数扫频，幅度 0.5，2 s，重复 3 次；
MME 默认对 与 WASAPI 对 各 3 次）。产物 `data/recon/probe_acoustic_path.json`、`chirp-roundtrip-*.wav`。

| 通路 | 归一化相关峰（3 次） | 次强峰 | 延迟（相对播放起点） | 语音带 pre → during |
|---|---|---|---|---|
| MME 默认（in 1 / out 3, 44.1k） | 0.4939 / 0.4946 / 0.4969 | 0.0116（40 倍小） | **229.6 / 239.6 / 229.6 ms** | −37.07 → **−14.17 dBFS（+22.9 dB）** |
| WASAPI（in 9 / out 8, 48k） | 0.4937 / 0.4889 / 0.4909 | 0.0128 | **42.9 / 42.9 / 42.9 ms** | −38.08 → −14.20 dBFS（+23.9 dB） |

- 相关峰唯一且稳定 → 这是**真实的声学耦合**，不是噪声巧合。
- PortAudio 自报的 low latency：MME 90 ms / WASAPI 3 ms；实测往返 **MME ≈ 230 ms、WASAPI ≈ 43 ms**。
  → **现场测试的实时链路应该用 WASAPI**，MME 的 230 ms 会明显伤害打断（barge-in）与回声时序（本文档只测往返延迟，
  未测端到端对话延迟）。
- 扬声器/麦克风的**频响曲线没有测出来**：用「对齐后取段做 FFT 比值」得到的各频段中位增益在 200–300 Hz 与 300–500 Hz 之间
  跳变不合理（−2.33 dB → −21.62 dB），说明该方法在本机不稳定（回响/驱动处理/AGC 都会破坏线性假设）。
  **不要引用那组 transfer 数字**，频响属于未实测。

### 2.4 夹具级回环：普通音量下几乎测不到（实测）

命令：`... python.exe data\recon\probe_loopback_matrix.py`（同一夹具、play −24.64 dBFS，4 种采集配置）
产物 `data/recon/probe_loopback_matrix.json`。

| 采样率 / 通道 | 相关峰 | 延迟 | 播放期语音带抬升 |
|---|---|---|---|
| 44100 / 1ch | 0.0446 | 830.2 ms※ | +1.85 dB |
| 44100 / 2ch | ch0 0.0373、ch1 0.0399 | 829.6 / 2335.6 ms | +1.61 dB |
| 48000 / 1ch | 0.0977 | 830.8 ms※ | +2.58 dB |
| 48000 / 2ch | ch0 0.0530、ch1 0.0520、均值 0.0599 | 831.4 / 830.8 ms | +0.81 / +0.85 dB |

※这里的 830 ms 是「录音缓冲内的到达位置」，其中 600 ms 是脚本自己插入的前置静音，**减去它 ≈ 230 ms，与 §2.3 一致**。

结论：**在 66% 音量、普通夹具电平下，麦克风只能比环境噪声底高出 0.8–2.6 dB**。这与 §2.3 自洽：
扫频的播放电平是 −9.03 dBFS RMS、录到 −14.17 dBFS，隐含的**数字端到端通路增益约 −5 dB（含 +5.5 dB 采集增益；
这不是标定过的声学灵敏度，只是「数字播放电平 → 数字采集电平」的比值）**；夹具比扫频低 15.6 dB，
按比例缩回去就只剩 ~1 dB 抬升，正好落在实测的 0.8–2.6 dB 区间。
**因此「用麦克风录回夹具来判断扬声器是否出声」在本机不可靠**（弱证据：解除静音后相关峰从 0.054/0.056 升到 0.100/0.107，
方向正确但幅度太小，不足以单独作为判据）。

### 2.5 现有回环验收工具是假 PASS（实测，必须修）

`services/voice-edge/voice_edge/loopback.py` 的判据是 `rms > 0.005 → verdict "ok"`。
实际跑（先 `--mute 1`，再 `--mute 0`）：

| 扬声器状态 | 工具输出 rms | verdict | 退出码 |
|---|---|---|---|
| **静音** | 0.05053 | **"ok"** | 0 |
| 不静音（对照） | 0.04860 | "ok" | 0 |

静音时反而更高。原因很直接：**环境噪声底自己就是 0.043–0.05**，永远大于 0.005。
所以这个 `verdict: "ok"` 不能证明任何事（它跟 2026-09-30 那轮「VAD 全 QUIET、ASR 空」的记录是同一套判据造成的误导）。
附带确认：把这两段录音（静音/不静音）都送进 Silero VAD（`... voice-pipecat\...\python.exe -m voice_edge.segment`），
都是 `segments: []`、全程 `QUIET` —— 因为录音里根本没有可用的语音内容。

**修复方向（建议给做设备验收的同学）**：
1. 判据改成**相对**的：播放窗 vs 前置静音窗的语音带电平差（要求 ≥ 10 dB），或与已知播放信号做相关（要求 ≥ 0.3）；
2. 同时读 Core Audio 的 `muted` / `master_volume_scalar`，静音直接判 FAIL 并打印「请取消静音」；
3. 用 §2.6 的 WASAPI loopback 做独立的「程序是否真的渲染了音频」检查。

### 2.6 WASAPI loopback：可靠，但不反映静音（实测）

`sounddevice 0.5.6` 的 `WasapiSettings` 确实不支持 loopback（与上一轮一致），但 **`soundcard` 0.4.6 可以**：
`sc.get_microphone(str(sc.default_speaker().name), include_loopback=True)`。命令
`... python.exe data\recon\probe_wasapi_loopback.py <label>`，产物 `data/recon/wasapi-loopback.json`。

| 状态 | 静默段 | 播放段 | 与夹具相关 |
|---|---|---|---|
| 不静音 | −187.58 dBFS（数字零） | −27.65 dBFS | **0.9996** |
| 端点静音 | −187.63 dBFS | −27.65 dBFS | **0.9996** |

- 它是**确定性**的：静默段是精确的数字零，播放段与夹具相关 0.9996 —— 比任何声学方法都干净。
- 但它在**音量/静音之前**取流，静音时照样 0.9996 → **只能证明「程序渲染了音频」，不能证明「听见了」**。

**「是否需要用户调音量」的诚实回答**：本轮已把默认输出端点从**静音**改为**不静音（保持 66.1%）**，
并证明声学通路可用（§2.3）。但**没有人耳确认**，所以「能不能听见」属于未验证；
可确定的是：**在 66.1% 音量下，本机扬声器经麦克风回授的语音带信噪比只有约 1–3 dB（夹具电平）**，
如果需要更大余量，应由用户手动调高音量（或改用耳机/外放音箱），这属于机器与人耳的判断，代码不能替代。

---

## 3. 摄像头

### 3.1 枚举

- 系统里只有 1 个摄像头：**Chicony USB2.0 Camera**（`USB\VID_04F2&PID_B59E&MI_00`，PnP 状态 OK）。
- OpenCV 后端：`cv2.VideoCapture(0, cv2.CAP_DSHOW)` **能开**；`cv2.CAP_MSMF` **打不开**（0.0 ms 直接失败）；
  `cv2.CAP_ANY` 实际回落到 DSHOW。→ **现场测试代码请显式用 `CAP_DSHOW`**。
- 设备自报参数：宽 640 / 高 480 生效，`CAP_PROP_FPS` 返回 **−1.0**（驱动不报帧率），FOURCC = `0x32595559` = **YUY2**。

### 3.2 抓帧耗时（实测）

命令 `... python.exe data\recon\probe_camera.py`，产物 `data/recon/probe_camera.json` 与帧图。

| 指标 | 数值 |
|---|---|
| 打开设备 | 379 ms（DSHOW / ANY 273.6 ms） |
| 首帧 | 71 ms |
| 后续 10 帧 `read()` | 均值 **33.4 ms**（min 29.5 / max 47.9）→ 约 **29.9 fps** |
| 分辨率 | 320×240 ✓、640×480 ✓、1280×720 ✓、请求 1920×1080 → **实际 1280×720** |

抓到的帧已存到 `data/recon/camera-frame-DSHOW-0.png`（640×480）与 `data/recon/camera-frame-ANY-0.png`。
**这一帧的内容是「天花板 + 衣柜 + 空调」**（摄像头上仰），画面里没有人 —— 正好当**负对照**用（见 §4.3）。

### 3.3 与麦克风并发（实测）

命令 `... python.exe data\recon\probe_camera_extra.py`（产物 `data/recon/probe_camera_concurrent.json`）：
6 秒录音 + 5.54 秒内抓 150 帧 → **30.0 fps 不降**，`read()` p95 48.1 ms、max 73.0 ms，同期麦克风 RMS −23.54 dBFS。
→ 麦克风与摄像头**可以同时跑**，现场测试控制台不需要为二者做资源仲裁。

### 3.4 隐私开关（实测）

```
HKCU\...\CapabilityAccessManager\ConsentStore\webcam      → Value = Allow
HKCU\...\CapabilityAccessManager\ConsentStore\microphone  → Value = Allow
```

即 Windows 层面没有阻止摄像头/麦克风。画面与音频全程留在本机，未做任何上传。

---

## 4. 「人物在场」检测可行性（M6 前置调研）

### 4.1 依赖现状（实测）

| venv | 内容 | 用途 |
|---|---|---|
| `.venvs/voice-livekit` | sounddevice 0.5.6、soundfile 0.14、soxr、numpy 2.5.3、onnxruntime 1.30.0、av 19.0.0、livekit-plugins-silero | 音频 + ORT |
| `.venvs/voice-pipecat` | pipecat（Silero VAD）、onnxruntime 1.24.4、pillow 12.3 | VAD/分段 |
| **`.venvs/field-probe`（本轮新建）** | **opencv-python-headless 5.0.0.93**、numpy、onnxruntime 1.30.0、pycaw、sounddevice | 摄像头/检测器/端点状态 |
| **`.venvs/cv4`（本轮新建）** | **opencv-python-headless 4.14.0.94**、numpy | Haar/HOG（5.0 已移除） |

**安装理由（AGENTS.md 铁律 12）**：摄像头抓帧与「人物在场」检测必须用 Python（任务要求 opencv-python-headless 或 av，
PyAV 无法按索引枚举摄像头）；`pycaw` 用来客观读端点音量/静音（这是判定「要不要用户调音量」的唯一硬证据）；
`soundcard` 用来做 WASAPI loopback（判断是否真的在渲染音频）。全部为 CPU 依赖，**没有引入任何需要 GPU 的包**；
两个新 venv 都在 `.venvs/` 下，不动系统 Python 3.14。

### 4.2 OpenCV 5.0 移除了 Haar 与 HOG（实测，重要）

```text
cv2 5.0.0：hasattr(cv2,'CascadeClassifier') = False；hasattr(cv2,'HOGDescriptor') = False；
           cv2.objdetect 子模块不存在；FaceDetectorYN 仍然存在
cv2 4.14.0：CascadeClassifier = True；HOGDescriptor = True；FaceDetectorYN = True
```

→ **依赖建议：钉 `opencv-python-headless<5`（实测 4.14.0.94）**，否则 Haar/HOG 直接不可用；
若只用 YuNet，5.0 也能跑。命名的错不要靠猜：5.0 下 `cv2.CascadeClassifier` 会直接 `AttributeError`。

### 4.3 单帧耗时（实测；warmup 3 次后取 15 次中位数，命令 `... detector_timing.py`）

| 检测器 | 模型大小 | 640×480 | 320×240 | 正对照（自拍/行人） | 空场景负对照 |
|---|---|---|---|---|---|
| Haar `frontalface_default` | 930,127 B（OpenCV 自带） | **15.9 ms** | 5.9 ms | 自拍照 3 张脸、Lena 1 张 | 0 |
| Haar `profileface` | 828,514 B | 23.6 ms | 8.0 ms | 自拍照 3、Lena 0 | 0 |
| Haar `fullbody` | 476,827 B | 6.2 ms | 1.2 ms | —（不适用） | 0 |
| HOG 行人（内置 SVM） | 30,248 B | **107.6 ms** | 19.6 ms | vtest.avi 2/4/5/2 人 ✓ | **0 或 2（误报）** |
| **YuNet 人脸（cv2.FaceDetectorYN）** | 232,589 B（需下载） | **38.3 ms**（cv4）/ 29.0 ms（cv5） | 6.1 ms | **自拍照 46 张脸 ✓**、Lena 1 | 0 |
| YuNet（**onnxruntime 1.30 原始前向**，640×640 固定输入） | 232,589 B | **27.0 ms 均值 / 20.4 ms 最小** | 不支持（形状固定） | — | — |

- ORT 会话加载 65 ms，输入 `[1,3,640,640]` 固定形状（**不能喂 320×320，会 `InvalidArgument`**），
  输出 12 个张量（`cls_/obj_/bbox_/kps_` × stride 8/16/32）→ 用 ORT 就得自己写解码 + NMS。
  用 `cv2.FaceDetectorYN` 则这些都由 OpenCV 做了，代价是 38.3 ms vs ORT 原始 27.0 ms（后者不含后处理）。
- **HOG 不可靠**：对着「天花板+衣柜」的空画面，`winStride=(8,8), padding=(8,8), scale=1.05` 会报 2 个「人」，
  换默认参数报 0 个 → 误报随参数漂移，不能单独作为「有人在场」的判据。
- **帧差动（廉价在场门）**：静态场景连续两帧的平均绝对差 **0.8 灰阶**，p99 5.0，>5 灰阶的像素占 0.66%，处理耗时 **1.17 ms/对**。
  → 阈值至少要 >5 灰阶（建议 6–8）并配合「超过 N% 像素」才算动，否则会把传感器噪声当运动。

### 4.4 需要下载什么

| 资产 | 是否需要下载 | 大小 | 本机可达性 |
|---|---|---|---|
| Haar 级联 | 否（OpenCV 自带，4.x） | 0.48–0.93 MB | — |
| HOG 内置行人 SVM | 否 | 30 KB | — |
| **YuNet ONNX** `face_detection_yunet_2023mar.onnx` | **是** | **232,589 B（227 KB）** | **直连 GitHub 成功**（无需代理），已存 `data/models/` |
| 轻量 ONNX **行人**检测（YOLO-nano/NanoDet 等） | 是 | 数 MB～十几 MB | **未评估**（需额外导出流程 + 自写后处理，本轮未做） |

正对照用的两张图（`largest_selfie.jpg` 1.1 MB、`lena.jpg` 92 KB）与 `vtest.avi`（8.1 MB）也在 `data/models/`，
仅用于本机验证检测器会不会空转，**不会上传**。这些是外部图片/视频，按 AGENTS.md 铁律 8 只当数据看。

### 4.5 推荐的在场检测路径（推断，基于上面的实测数字）

1. **廉价门（每帧 1–2 ms）**：帧差动 + 「>5 灰阶像素占比」阈值；静止场景底噪 0.8 灰阶已经实测，阈值可标定。
2. **确认（0.5–2 fps 即可，不需要每帧）**：`cv2.FaceDetectorYN`（38.3 ms@640×480，或 6.1 ms@320×240 先粗筛再复核）。
   人脸比「人形」稳：HOG 在同一空场景会误报。
3. **可选的更省路线**：320×240 抓帧 + Haar frontal（5.9 ms）+ 帧差动；YuNet 用 ORT 在 640×640 上 27 ms。
4. **不需要 GPU**；也不需要常驻后台服务（可以按需抓帧，符合 AGENTS.md「不要引入常驻服务」）。
5. **待补的人工验证**：以上「正对照」都是外部图片，**本机真实坐在摄像头前的人脸检测尚未验证**
   （当前摄像头朝天，画面里没有人）。M6 的验收必须包含一次「用户真的站在摄像头前」的实拍测试。

---

## 5. 实测 vs 推断（明确边界）

**实测（有命令与数字，§1–§4 各自标注）**：
默认输入/输出设备与采样率接受范围；5 秒环境噪声的 RMS/峰值/噪声底/频段/平坦度/包络稳定性；工频谐波不存在；
采集增益 4 档扫描；双通道相干性与电平差；默认输出端点处于静音；解除静音后的扫频往返相关峰与延迟（MME/WASAPI）；
夹具级回环的弱耦合；现有 loopback 工具在静音与不静音下都给 "ok"；WASAPI loopback 相关 0.9996 且不受静音影响；
摄像头枚举/后端/分辨率/抓帧耗时；麦克风+摄像头并发 30 fps；ConsentStore 开关；OpenCV 5.0 无 Haar/HOG；
各检测器耗时与模型大小；YuNet/HOG/Haar 的正负对照；ORT 输入形状与耗时；帧差动噪声底。

**推断（有实测支撑，但需要额外实验才能定论）**：
1. 「噪声主要来自电子/前置噪声而非房间声场」——依据是双通道相干性 ≈ 0 与增益 1:1 缩放；反例可能：驱动做了阵列处理、
   或者房间噪声恰好每通道独立（不太可能）。判决性实验需要物理遮挡麦克风。
2. 「100 Hz 以下的能量主要是低频结构/机械隆隆声 + 慢漂移」——依据是峰值分布与包络起伏（p95/p05 = 3.97）；
   具体是风扇、硬盘还是电路漂移，未定位。
3. 「普通夹具电平下麦克风采不到扬声器」的原因被归因于 −30 dB 声学衰减 + 电平不足；是否**同时**有驱动 AEC
   在压制回声，未单独验证。
4. 频段占比的具体百分比随分析窗长变化（43% vs 64%），本文只主张「一半到三分之二」这一区间。
5. §4.5 的在场检测方案是基于耗时与正负对照的**推荐**，不是已验证的 M6 实现。

**未实测 / 本轮明确没做**：
- 人耳能否听见（没有任何人参与）；
- 本机真实人脸检测（摄像头当前朝向无人）；
- ONNX 行人检测模型；
- 端到端对话延迟（只测了音频往返延迟）；
- 频响曲线（方法失效，见 §2.3）。

---

## 6. 对后续任务的硬要求（建议）

1. **实时音频链路用 WASAPI**（往返 43 ms vs MME 230 ms）；MME 只用于离线冒烟。
   实时采集建议显式用 WASAPI 设备 9（in）/ 8（out），48 kHz。
2. **先修设备验收判据**：把 `rms > 0.005` 换成「播放窗 vs 前置静音窗的语音带电平差 ≥ 10 dB」或
   「与已知播放信号相关 ≥ 0.3」，并加读端点 `muted`/音量。（当前工具在静音状态下判 PASS，是最危险的一条。）
3. **判据组合**：WASAPI loopback（渲染层，相关 0.9996）+ Core Audio 静音/音量（机器层）+ 声学扫频（物理层）。
   三者缺一不可；不要再用「麦克风录回夹具的 RMS」当唯一判据。
4. **前端第一步上 100–120 Hz 高通**（拿掉一半以上噪声功率），并把采集增益设到 0 dB；噪声底实测 −27 dBFS 是设计输入。
5. **摄像头用 `cv2.CAP_DSHOW`**，不要依赖 MSMF；默认 640×480@30fps，需要细节再用 1280×720。
6. **opencv 钉 `<5`**（要 Haar/HOG）；只要 YuNet 可以不钉，但要在代码里显式处理 5.0 的 API 缺失。
7. **M6 验收必须包含一次真人在镜头前的实测**（本轮的检测器正对照都来自外部图片）。
8. 采样率「全部被接受」只是 PortAudio 层结论，真要保证 16 kHz 输入质量，应在脚本里显式重采样并测一次端到端延迟。

---

## 7. 复现命令与产物清单

```powershell
# 1) 麦克风：枚举 + 5 秒环境录音 + 分带
E:\worker2\.venvs\voice-livekit\Scripts\python.exe data\recon\probe_mic.py
E:\worker2\.venvs\voice-livekit\Scripts\python.exe data\recon\probe_mic_spectrum.py
E:\worker2\.venvs\voice-livekit\Scripts\python.exe data\recon\probe_coherence.py

# 2) 扬声器：端点音量/静音（读）
E:\worker2\.venvs\field-probe\Scripts\python.exe data\recon\probe_volume.py
#    写（本轮用过，均可回滚；--mute 1 会发出约 2 秒声音）
E:\worker2\.venvs\field-probe\Scripts\python.exe data\recon\probe_volume.py --mute 0
E:\worker2\.venvs\field-probe\Scripts\python.exe data\recon\probe_volume.py --set-capture-db 0

# 3) 声学往返（会发出约 24 秒声音）：MME vs WASAPI
E:\worker2\.venvs\voice-livekit\Scripts\python.exe data\recon\probe_acoustic_path.py
E:\worker2\.venvs\voice-livekit\Scripts\python.exe data\recon\probe_loopback_matrix.py
E:\worker2\.venvs\voice-livekit\Scripts\python.exe data\recon\probe_wasapi_loopback.py unmuted

# 4) 摄像头：枚举/抓帧/分辨率/与麦克风并发
E:\worker2\.venvs\field-probe\Scripts\python.exe data\recon\probe_camera.py
E:\worker2\.venvs\field-probe\Scripts\python.exe data\recon\probe_camera_extra.py

# 5) 检测器：cv4 给 Haar/HOG，field-probe(5.0) 给 YuNet + onnxruntime
E:\worker2\.venvs\cv4\Scripts\python.exe data\recon\detector_timing.py
E:\worker2\.venvs\field-probe\Scripts\python.exe data\recon\detect_bench_ort.py

# 6) 现有设备验收工具（注意：当前判据会在静音时假 PASS）
Push-Location services\voice-edge
E:\worker2\.venvs\voice-livekit\Scripts\python.exe -m voice_edge.loopback ..\..\tests\audio-fixtures\direct-question.wav ..\..\data\voice\loopback.wav
E:\worker2\.venvs\voice-pipecat\Scripts\python.exe -m voice_edge.segment ..\..\data\voice\loopback.wav
Pop-Location
```

产物（都在 `data/` 内，未提交、不上传）：

| 文件 | 内容 |
|---|---|
| `data/recon/probe_mic.json` / `.txt` | 设备枚举、采样率、5 秒环境录音分析 |
| `data/recon/probe_mic_spectrum.json` | 高分辨率频谱、窄带峰、工频谐波检验、时域包络 |
| `data/recon/probe_coherence.json`、`mic-stereo-4s.wav` | 双通道相干性 |
| `data/recon/mic-gains.json`、`mic-gain*.wav` | 采集增益扫描（+5.5/0/−6/−12 dB） |
| `data/recon/probe_acoustic_path.json`、`chirp-roundtrip-*.wav` | MME/WASAPI 扫频往返 |
| `data/recon/probe_loopback_matrix.json` | 夹具级回环的 4 种采集配置 |
| `data/recon/probe_latency*.json` | 延迟/包络细节 |
| `data/recon/wasapi-loopback.json` | WASAPI loopback（静音/不静音） |
| `data/recon/volume-state*.json` | Core Audio 端点状态（初始、解除静音、最终） |
| `data/recon/probe_camera*.json`、`camera-frame-*.png` | 摄像头枚举、抓帧、分辨率、并发 |
| `data/recon/detector_timing_cv4.json`、`detectors_cv4.json`、`detectors_ort.json` | 检测器耗时与正负对照 |
| `data/models/` | YuNet 模型 + 正对照图/视频（仅本机验证用） |
| `data/voice/loopback-{muted,unmuted}.wav` | 静音/不静音两次回环录音（假 PASS 的证据） |

## 8. 本轮对机器状态的改动（可回滚）

| 项 | 改动前 | 改动后 | 回滚 |
|---|---|---|---|
| 默认输出端点静音 | **muted = true** | **muted = false**（音量仍是 66.1% / −6.19 dB） | `probe_volume.py --mute 1` |
| 默认输出音量 | 0.661 | 0.661（未改） | — |
| 默认采集增益 | +5.5 dB | +5.5 dB（实验中曾设 0/−6/−12 dB，已还原） | `--set-capture-db 5.5` |
| 播放过的声音 | — | 若干次夹具/扫频播放（累计约 60 秒） | 无需回滚 |

## 维护规则

- 本文件是**带日期的历史记录**（docs/recon 层），新的实测请写新的 `field-test-environment-YYYY-MM-DD.md`，不要改写本文的数字。
- 任何被本文引用为「实测」的结论，若在本机复测得到不同数字，**以新报告为准**，并在新报告里注明推翻了哪一条。
- 与 `docs/recon/device-acceptance-2026-09-30.md` 的冲突以本文为准（本文解释了那轮失败的根因：输出端点静音 + 判据是绝对阈值）。
