# LiveKit Agents 1.8.3 离线实测笔记（中文语音陪伴 PoC）

机器可读结果已归档为 [`RESULT.json`](livekit-spike-2026-09-29.json)。
原始逐次数据（`vad_raw.json`、`turn_detector_raw.json`、`interruption_raw.json`、`perf_raw.json`）与测量脚本
（`measure_vad.py`、`measure_turn_detector.py`、`measure_interruption.py`、`measure_perf.py`）当时写在临时目录
`.spike/livekit/`，**该目录已清理**（`.spike/` 在 `.gitignore` 中，属于一次性工作区）。
关键数字与结论都保留在本笔记与 `RESULT.json` 中；需要重跑时按下面「方法」小节复现。
本次测量未改仓库其它文件，未使用任何 API key，未安装/升级依赖。

## 方法
- VAD：`silero.VAD.load()` 默认参数 → **16000 Hz / 512 样本（32 ms）**。夹具 24 kHz，先用库自带
  `rtc.AudioResampler`(QUICK) 重采样到 16 kHz，按 512 样本喂入；尾部补 1.5 s 数字静音让端点判定能触发
  （`min_silence_duration=0.55`）。事件时间取 `VADEvent.timestamp`（样本域）。
- 交叉验证：把同一夹具直接以 24 kHz/512 样本喂入（让 VAD 内部重采样），5 个夹具端点延迟**完全相同**，
  说明预重采样未引入偏差。
- 转写 EOU：官方类 `MultilingualModel()` 离线直接 `RuntimeError: no job context found`（实证，见
  RESULT.json blockers）。改用其内核 `_EUORunnerMultilingual.initialize()/run()`（私有类，**不是**同一个 API），
  传 `{"chat_ctx":[...]}`，取 `eou_probability`。判定 finished := `p >= languages.json[zh].threshold`。
- 性能：每个 import 在**全新进程**里单独计时（脚本用 subprocess + psutil）。

## 最弱环节（必须先读）
1. **「真实语音结束」不是真值**，是我用能量阈值估的：τ = max(k·噪声底, f·峰值)，k∈{4,6,10}。取其 3 档
   中位数，离散度即误差带。4 个夹具 ±20–30 ms；**`followup-turn.wav` 被截断**（尾部无静音，最后 5 ms
   RMS 236 vs 噪声底 44），真实结束只有 ±107 ms 精度，它的 718.62 ms 端点延迟不可与其它夹具直接比较。
2. 文本 EOU 的输入是我手打的夹具文本，**本 venv 没有 ASR**，真实 ASR 输出（标点、嗯/恩）未验证。
3. 背音结论只测了 2 种上下文；真实多轮 + 电视环境下的误判率未测。
4. 端点/起点延迟都是**样本域**时间，不含调度抖动；VAD 计算开销实测 realtime factor 0.026–0.030
   （1 s 音频约 28 ms CPU），可忽略，故 3 次结果逐位相同。

## 关键实测数字
- **端点延迟 ≈ 0.69–0.72 s**，3 次完全一致。机制已被 5/5 夹具证实：
  `END_OF_SPEECH 时刻 = 最后一个平滑概率 > deactivation_threshold(0.35) 的窗口 + 576 ms`
  （576 = ceil(0.55/0.032)×32 ms，即 min_silence_duration 向上取整到 32 ms 窗口）。
- 起点延迟 56.2–270.1 ms（相对真实起点）；绝对时刻除 followup-turn 外**都是 224.0 ms**，
  说明起点判定被 32 ms 窗口量化 + `ExpFilter(alpha=0.35)` 预热主导，而非语音本身。
- Turn detector（文本）：HF `livekit/turn-detector` rev `v0.4.1-intl`
  （commit `87e35fcb1e60a569bea70346191c4886ea92e281`），磁盘共 **412,195,151 B**
  （主体 `onnx/model_q8.onnx` 396,316,457 B），直连下载约 25 s，**无需代理**；wheel 不含权重，
  首次使用必须联网。加载 6197–6894 ms，`CPUExecutionProvider`，`intra_op=4, inter_op=1`。
  单次推理 25–132 ms（中位 96 ms），概率 3 次逐位相同。
- 中文阈值 **0.0066**（`languages.json`，tpr 0.9933/tnr 0.8661）——**概率尺度极小，不是标定概率**。
  背音「嗯。」：无上文 p=0.00878 ≥ 0.0066 → **finished=True（判错）**；有助手上一轮 p=0.003671 < 0.0066
  → finished=False（**对**）。其余 4 个夹具两种上下文都 finished=True。
- **`tv-dialogue`（电视，同词、无唤醒词）p=0.91 → finished=True**：EOU 完全不能区分唤醒词与电视，
  唤醒/声源判定必须在 EOU 之外做（与铁律 3 一致）。
- 另一条路：`livekit.agents.inference.TurnDetector(version="v1-mini")` 是**音频**模型，走本地 native
  `livekit.local_inference.EOT`（无下载、无网络、无 JobContext），zh 阈值 0.355，内部 16 kHz/19200 样本
  （1.2 s）缓冲；对「嗯。」p=0.43–0.44 ≥ 0.355 → **也判 finished=True（也判错背音）**，延迟 53–75 ms。
- 打断：会话级 `InterruptionOptions` 默认 `enabled=True, mode=adaptive|vad, min_duration=0.5s,
  resume_false_interruption=True, false_interruption_timeout=2.0s, backchannel_boundary=(1.0,1.0)`；
  endpointing 默认 `min_delay=0.3s, max_delay=2.5s, alpha=0.9`。`mode='adaptive'` 用
  `AdaptiveInterruptionDetector`，**必须 LiveKit Cloud 凭证 + 网关 WebSocket，无法离线演示**
  （1.8.3 没有本地打断模型：`livekit.local_inference` 只导出 EOT/VAD）；`mode='vad'` 是纯本地
  silero-VAD barge-in，但只在 `AgentActivity` 里跑，而 `AgentSession.start(room=...)` 必须有 room。
  → **离线可演示 = 否**，这是被阻断的结论，不是绕过。
- 性能：全套库导入 **3799.6 ms**（其中 `livekit.agents` 单独 3103.5 ms，占 82%；numpy 235.8、
  onnxruntime 209.8、livekit.rtc 233.6）；峰值 RSS **398.4 MB**（`init_eot()` 一次就 +243 MB）；
  可用 provider 仅 `AzureExecutionProvider, CPUExecutionProvider`，两个模型都走 CPU。
  所有 native 依赖（rtc、local_inference._native、av、sounddevice、tokenizers）导入成功，无失败。

## M1 实现必须知道的
1. 默认参数下「说完 → 判定说完」硬下限 ≈ **0.69 s**；要压到 0.4 s 必须调 `min_silence_duration`，
   且实际值是 `ceil(x/0.032)*32 ms`，不是 x 本身。这是 VAD-only 方案的天花板。
2. 文本 EOU **必须喂上文**（上一轮 assistant 文本），否则「嗯。」被判成说完；且判定线在 0.0066，
   不要把它当置信度用，也不要为它单独调阈值（服务端标定）。
3. 电视与真人同词，两个 EOU 都会说「说完了」；唤醒词/声源/该不该说话必须是 EOU 之外的确定性门禁。
4. 文本 EOU 需要 HF 412 MB 权重 + JobContext/inference-executor 接线（或改用
   `livekit.agents.inference.TurnDetector`，v1-mini 本地音频模型无需权重下载）；`init_eot()` 会一次吃 ~243 MB。
5. Windows 特有：HF 软链不可用（未开开发者模式）→ 缓存 blob 会被复制一份，注意磁盘；
   `_native.cp312-win_amd64.pyd` 把 Python 锁死在 3.12/x64；无 torch 只让 transformers 打一行警告，
   EOU 插件实测照常工作。
