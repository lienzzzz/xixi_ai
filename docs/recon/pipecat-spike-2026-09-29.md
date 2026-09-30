# Pipecat 1.12.0 离线测量笔记（CPU-only Windows）

工作目录 `E:\worker2\.spike\pipecat\`。原始数据：`vad_raw.json` / `turn_raw.json` /
`sweep_raw.json` / `bargein_raw.json` / `probe_run1..3.json`；`RESULT.json` 由
`build_result.py` 从这些原始文件生成，不手写数字。

## 方法（可复现）

1. 夹具 24 kHz → 16 kHz 用 pipecat 自带的 `SOXRAudioResampler(quality="VHQ")`。
2. VAD 每次只喂 512 样本（32 ms）一帧，逐帧读 `VADState`，因此分辨率就是原生帧长。
3. 真值用**独立**的短时能量检测器，且落在**同一条 512 样本网格**上：帧 DC 去均值 RMS
   > -40 dBFS 判为有声，取第一段 ≥2 帧连续有声的起点为 onset、最后一段的终点为 end。
   全部误差因此正好是 32 ms 的整数倍。另在 -30/-40/-50 dBFS 三个阈值上做敏感性检查，
   并用 pipecat 自己的 `detect_speech_onset` 交叉核对。
4. 每个夹具跑 3 次全新实例，3 次结果完全一致（`identicalAcrossRuns=true`），端点延迟为确定性值。
5. 中断演示用 pipecat **自带测试写法**：`Pipeline` + `PipelineWorker` + `WorkerRunner`，
   无 transport、无音频设备、无网络；"机器人在说话"用 `BotStartedSpeakingFrame` 模拟。

## 最弱的假设（必须先看这里）

- **"语音真正的结束"是能量阈值定义的**，不是人工标注。阈值从 -30 到 -50 dBFS 时
  onset 漂移最多 64 ms、end 漂移最多 64 ms。因为所有数值都量化到 32 ms 网格，
  端点延迟的真实不确定度约 **±1~2 帧（±32~64 ms）**。
- 端点延迟用**最后一次** SPEAKING→QUIET 判定，并把判定帧的**帧尾**作为可观测时刻
  （该帧音频必须先被消费完）。这是定义选择，不是自然常数。
- 文件末尾若仍在讲话，会补喂静音直到判定结束；`vad_raw.json` 里记了补喂帧数。
- smart-turn 必须**按实时速度**喂（32 ms/帧），因为 `BaseSmartTurn` 用
  `time.monotonic()` 到达时间戳选取模型片段；全速喂会让片段退化成整个缓冲。
- smart-turn 的判定点被钉在 VAD 停止处，它看到的音频**只到那次停止为止**。

## 实测结论（M1 必须知道的）

1. `min_volume=0.6` 是**启动延迟的主要来源**：400 ms BS.1770 音量窗 + 0.2 指数平滑，
   使 VAD 要 ~512 ms 才开闸。改成 `min_volume=0.0` 后启动延迟从 544–864 ms 降到
   192–384 ms（`start_secs=0.2` 本身只值 ~192 ms）。
2. `stop_secs=0.2` 在中文长句里会**误断句**：`longer-turn.wav` 句内 352 ms 停顿，
   在 2080 ms 处提前 1440 ms 判定"停止说话"。**`stop_secs ≥ 0.6` 才能消除**。
   端点延迟与 `stop_secs` 线性相关（≈ stop_secs×1000 + 32 ms）。
   → 推荐起点：`stop_secs=0.6, min_volume=0.0`（启动 224–384 ms，无误断句）。
3. **"嗯。"（backchannel）默认参数完全检测不到**：Silero 原始置信度峰值只有 0.5274，
   远低于 0.7；改 `confidence=0.5`、`min_volume=0`、`stop_secs` 0.2–1.0 全部无效。
   需求"backchannel 不算打断"只是**碰巧成立**——它连语音都没被识别，也就进不了 ASR。
   要覆盖 backchannel 必须自己做旁路（例如短能量事件单独打标），不能指望这个 VAD。
4. **smart-turn 救不了误断句**：在 2080 ms 那个假端点上它给出 COMPLETE（p=0.6788）。
   因为它只看到截断到该点的音频。要防误断句，只能调 VAD 的 `stop_secs`。
5. smart-turn 也**分不出电视和父亲**：`tv-dialogue.wav` 判 COMPLETE（p=0.9228），
   与直接提问（p=0.9557）无法区分。唤醒词/说话人门禁必须在 pipecat 之外自己实现
   （`WakePhraseUserTurnStartStrategy` 只是策略钩子，1.12.0 不含任何唤醒词模型）。
6. 中断机制**完全可离线演示**：`UserTurnProcessor` 在用户轮次开始时调用
   `broadcast_interruption()` → `InterruptionFrame`。注意 1.12.0 里
   **没有 `BotInterruptionFrame`/`StartInterruptionFrame`**；VAD 层帧名是
   `VADUserStartedSpeakingFrame`/`VADUserStoppedSpeakingFrame`。
   `enable_interruptions` 默认 True 且**不看机器人是否在说话**：机器人静默时同样广播中断。
7. 成本：import pipecat ~89 ms，冷启动到 VAD 可用 ~0.8 s（首次冷文件缓存 ~1.0 s），
   smart-turn 加载 ~119 ms、单次推理 **217–378 ms**，峰值 RSS ~118 MB。
   全部走 `CPUExecutionProvider`，无原生构建失败、无下载、无联网。
8. 离线可用的端到端轮次分析器**只有** `LocalSmartTurnAnalyzerV3`（模型随 wheel 分发）。
   V2 需 torch、CoreML 版需 coremltools、Krisp 版需 SDK+密钥、HTTP 版需联网，本机均不可用。
