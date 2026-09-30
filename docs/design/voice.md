# 语音链路：VAD 基线、两条输入路径、打断与延迟

> 最后更新：2026-09-30
> 权威来源：`services/voice-edge/voice_edge/{config,segment,loopback}.py`、`scripts/voice-turn.ts`、`scripts/voice-bargein.ts`、`scripts/serve-chat.ts`、`scripts/voice-device-check.ts`、ADR-0007/0008、[recon/pipecat-spike-2026-09-29.md](../recon/pipecat-spike-2026-09-29.md)、[recon/livekit-spike-2026-09-29.md](../recon/livekit-spike-2026-09-29.md)、[recon/device-acceptance-2026-09-30.md](../recon/device-acceptance-2026-09-30.md)、[progress.md](../progress.md) §2.9/§0
> 若与代码不一致，以代码为准，并请立即修正本文件

方案 §14.1 画的链路是 `Mic → AEC → NS → AGC → VAD → Wake Word → Speaker Verification → Turn Detection → ASR → 对话 → TTS`。
**当前实现只覆盖 `VAD → ASR → 对话 → TTS` 与打断判定**；唤醒词、说话人验证、Turn Detection 都不存在（见 §6）。

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
| 实测结果 | **不可用**：能打开设备、能播放录音，但录音 **0–100 Hz 占 99.49% 能量**，200 Hz 高通后 RMS 只剩 0.0322；Silero 103 帧全 `QUIET`、`segments: []`，MiMo ASR 整段返回空字符串（device-acceptance） | 走浏览器自己的音频前端：`audio: {channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true}` |
| 结论 | 原因在机器声学配置（音量/静音/设备），不是代码（device-acceptance 定位） | **优先路径**；浏览器负责 AEC/NS/AGC，正好补上 §14.1 的前三级 |

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

（`followup-turn.wav` 单跑 VAD 时 `bargeInDecisionMs=192.0`，与本表一致。）

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

## 6. 未实现 / 未验收（写清楚，别当成已完成）

- 唤醒词与搭话判定（M2）；`features.wake_word: false`。
- 说话人验证 / 声纹（M2；`features.speaker_verification: false`）。
- backchannel 的独立短音频通路（§14.3）：现在的「不打断」只是因为 VAD 检不到，不是设计。
- 常驻语音服务（当前一轮一进程，每次付 Python 冷启动）。
- 真实麦克风与扬声器验收：**已测但链路无信号**（99.49% 能量 <100 Hz），属机器配置；
  两条复现命令在 device-acceptance 报告里（`voice_edge.loopback` 与 `scripts/voice-device-check.ts`，相似度 ≥ 0.5 判 PASS）。
- 扬声器真正静音的延迟（§14.2/§33 的 P50 < 500 ms）。
- 电视误触率（M2 的对照夹具 `tv-dialogue.wav` 已就绪）。
- ASR/TTS 的本地兜底（§21.2/§21.3）。

## 维护规则

| 改了哪个源文件 | 必须同步更新本文件的小节 |
|---|---|
| `services/voice-edge/voice_edge/config.py`（基线参数） | §1（参数表与理由）、§2（端点/起始数字） |
| `services/voice-edge/voice_edge/segment.py` | §1（实测表）、§5（`loadMs`/`processMs`、帧长） |
| `services/voice-edge/voice_edge/loopback.py` | §3（Python 路径与其结论） |
| `scripts/voice-turn.ts` | §3（只上传语音段）、§5（分段耗时字段与 e2e 公式） |
| `scripts/voice-bargein.ts` | §4（判定延迟、截断证据、未验收项） |
| `scripts/serve-chat.ts` 的 `/api/voice` 或前端采集参数 | §3（浏览器路径、AEC/NS/AGC、落盘文件） |
| 新增唤醒词 / 说话人验证 / 常驻语音服务 | §2（M2 的结论是否仍成立）、§6（未实现清单） |
| 换 VAD 框架或调 `stop_secs`/`min_volume` | §1、§2，并更新 [recon/pipecat-spike-2026-09-29.md](../recon/pipecat-spike-2026-09-29.md) 的复测记录 |
