# ADR-0007：语音侧选 Pipecat，且唤醒/搭话/电视判别必须由我们自己判断

- 状态：已接受（2026-09-29）
- 相关：[Pipecat 选型实测](../recon/pipecat-spike-2026-09-29.md)、[LiveKit 对照实测](../recon/livekit-spike-2026-09-29.md)、[MiMo API 探测](../recon/mimo-api-probe-2026-09-29.md)、[ADR-0002](0002-mimo-through-dsh-pi-ai.md)、[进程与依赖选择](0006-runtime-and-dependency-choices.md)

## Decision

1. **Voice Edge 采用 Pipecat 1.12.0**（隔离 venv `.venvs/voice-pipecat`），Silero VAD 使用**调参后的基线**：
   `stop_secs=0.6`、`min_volume=0.0`（其余默认：`confidence=0.7`、`start_secs=0.2`）。
2. **ASR / TTS 直连小米 MiMo**（`mimo-v2.5-asr` / `mimo-v2.5-tts`），不经过任何语音框架的云插件。
3. **唤醒词、backchannel 判定、电视/真人区分都由西西自己的程序逻辑负责**，不委托给 VAD 或 end-of-turn 模型。
4. LiveKit Agents 1.8.3 **不作为 M1 的实现**，但保留为对照路线（它的比对结论已落盘）。

## Context（实测数据，两台框架同一套中文夹具）

| | Pipecat 1.12.0 | LiveKit Agents 1.8.3 |
|---|---|---|
| 能否离线驱动（无房间/声卡/网络） | 能。VAD 与 smart-turn 直接在 asyncio 里跑 | VAD 能；**sanctioned 的 turn detector 需要 JobContext**（离线直接抛错） |
| 模型获取 | ONNX **随 wheel 自带**，零下载 | turn detector 需从 HF 下载 **412 MB**，加载 6.9 s |
| 端点延迟（末次判定） | 160–224 ms（`stop_secs`+32 ms 栅格） | 690–724 ms（`min_silence_duration=0.55` 量化到 32 ms） |
| 说话开始延迟 | **544–864 ms**，主因是 `min_volume=0.6` 的 400 ms BF.1770 窗口；设为 0 后 192–384 ms | 56–270 ms |
| 「嗯。」（backchannel） | **完全检不到**（峰值置信度 0.5274 < 0.7） | 检得到；EOU 有上下文时判 p=0.0037 < 0.0066 为「没说完」（正确） |
| 中文句内停顿 | 默认 `stop_secs=0.2` 会在句内 352 ms 停顿处**提前 1440 ms** 判定说完；`stop_secs=0.6` 修正 | 未测到同类失败（但它更慢） |
| smart-turn / EOU 能否补救 | **不能**：只在 VAD 停止时被调用，看到的音频已经被截断（p=0.6788 认同了错误终点） | 文本 EOU 需要 JobContext；另有音频 EOU（v1-mini，53–75 ms，zh 阈值 0.355）但**同样把 backchannel 判成说完**（p=0.43） |
| 打断能否离线演示 | **能**：`VADUserStartedSpeakingFrame → UserStartedSpeakingFrame → InterruptionFrame`，836 ms；注意 1.12.0 **没有** `BotInterruptionFrame` / `StartInterruptionFrame` | **不能**：adaptive 需要 LiveKit Cloud 凭据 + WebSocket 网关；非 adaptive 路径也要先 `AgentSession.start(room=…)` |
| 内存 / 导入 | 峰值 117.6 MB，`import pipecat` 88.9 ms | 峰值 398.4 MB，导入 3.8 s |
| 能否区分电视与真人 | 不能（COMPLETE p=0.9228 vs 0.9557） | 不能（EOU p=0.91 判电视「说完」） |

## Alternatives

- **LiveKit Agents**：它的自适应打断与音频 EOU 在真实房间里可能更自然（方案 §3.3 把它列为效果标杆），但在本机**无法验证**（缺 Cloud 凭据、无房间），而 M1 要求「先有可重复测试再往上走」。此外 412 MB 模型与 398 MB 常驻内存对这台 4 GB 显存的旧笔记本不友好。
- **只用 Silero VAD + 自写编排**：可行，但会丢掉 Pipecat 已经验证过的打断帧机制（836 ms 可离线复现）与 smart-turn 分析器接口，收益不足。
- **把 backchannel / 电视判别交给语音框架**：已被实测否定——两个框架都做不到，见下。

## Consequences

- **backchannel 与电视判别成为我们自己的责任**（方案 §13、§14.3、§39.5 本来就要求如此，现在有了实测依据）：
  M2 必须同时用唤醒词 + 说话人相似度 + 会话状态 + 语义承接来判断「是不是在跟西西说话」；
  Pipecat 的 VAD 对「嗯。」完全免疫这一点**不能当作特性**——那意味着同一句话也进不了 ASR，
  所以 backchannel 需要单独的短音频通路或降低该通路阈值，而不是依赖 VAD 的沉默。
- **`stop_secs` 是中文场景的关键参数**：0.2 会把「……办点事，可能要到晚上才回来」从逗号处切断。
  集成测试必须覆盖这一条（`longer-turn.wav` 就是为此准备的夹具）。
- **真实播放取消仍未验证**：离线只能证明 `InterruptionFrame` 被广播（836 ms），
  真正「停掉扬声器」需要设备测试（方案 §33 的 P50 < 500 ms 目标因此**尚未验收**）。
- **夹具必须带尾部静音**：LiveKit 子代理发现 `followup-turn.wav` 原本在语音中途截断（末 5 ms RMS 236 vs 噪声底 44），
  已修：`scripts/make-audio-fixtures.ts` 现在统一追加 600 ms 尾部静音，并用 chunk 遍历而非固定 44 字节偏移读取 WAV。
- 语音侧与大脑侧的进程边界仍按方案 §3.3 分离；M1 用本地 HTTP 调用大脑（无 MQTT，见 ADR-0004）。
