# 设备验收尝试（2026-09-30）：本机音频路径不可用，原因已定位到证据

## 结论

**真实麦克风与扬声器的验收仍然未通过**，但这次不是「没测」，而是**测了并定位**：

| 检查 | 结果 |
|---|---|
| `sounddevice` 能否打开输入/输出 | 能。Realtek 输入设备 1（麦克风，2ch/44.1k）与输出设备 3（扬声器，2ch/44.1k）都存在 |
| 播放夹具 + 同时录音是否抛错 | 否。`sd.playrec` 正常返回，2.52s 播放、3.32s 录音 |
| 录音电平 | RMS 0.396、峰值 0.877 —— **看上去很响** |
| Silero VAD 能否在其中找到语音 | **不能**。103 帧全部 `QUIET`，`segments: []` |
| MiMo ASR 能否转写 | **不能**。整段与「loud-part」都返回空字符串 |
| 频谱分布（0.4–2.4s 段） | **0–100Hz 占 99.49%**；100–300Hz 0.09%；300–3400Hz 0.35%；3400Hz+ 0.07% |
| 去直流后再测 | 仍然全 `QUIET`（DC 为 −0.328，但不是原因） |
| 200Hz 高通后再测 | 仍然全 `QUIET`；高通后 RMS 只剩 0.0322，语音带几乎没有内容 |
| 用 WASAPI loopback 判断「是否真的有声音在播」 | **无法执行**：本机 `sounddevice 0.5.6` 的 `WasapiSettings` 不接受 `loopback` 参数 |

## 这意味着什么

录音里**几乎没有语音频带内容**，能量集中在 100Hz 以下（缓慢漂移的低频偏置，与 DC −0.328 一致）。
因此这不是「VAD 太严格」或「模型不行」，而是**声学链路里没有可用的语音信号**。最可能的原因（按概率）：

1. 系统输出音量被静音/为 0（播放「成功」但没有可听输出）；
2. 麦克风被静音、被系统隐私开关关闭，或实际拾音设备不是当前默认设备；
3. 笔记本麦克风与扬声器之间的声学耦合极弱（合盖/耳机口/远程桌面会话等）。

这三项都属于**机器配置**，不是代码能修的：我在无人工干预的情况下无法判断音量滑块与隐私开关的状态。

## 已就绪的复现命令（用户可一键验收）

```powershell
# 1. 播放夹具并从麦克风录回（会发出约 2.5 秒声音）
E:\worker2\.venvs\voice-livekit\Scripts\python.exe -m voice_edge.loopback `
    tests/audio-fixtures/direct-question.wav data/voice/loopback.wav
#    输出 verdict 必须是 "ok"（rms > 0.005）；"silent-capture" 表示麦克风没收到东西

# 2. 对录音跑完整链路：VAD → ASR → 对话 → TTS，并与原文比对相似度
node scripts/voice-device-check.ts --wav data/voice/loopback.wav --expect "西西，明天天气怎么样？"
#    相似度 ≥ 0.5 即判定 PASS
```

只要把系统音量调开、确认麦克风未被静音（Windows 设置 → 隐私和安全性 → 麦克风），上面两条命令即可完成
《方案》§33 中「真实设备」部分的验收。在此之前，**所有语音结论都只覆盖夹具音频**（见 progress §0）。

## 顺带确认的事

- `services/voice-edge/voice_edge/loopback.py` 是真实可用的设备回环工具（本机跑通，只是拿不到语音内容）；
- `scripts/voice-device-check.ts` 会同时给出：转写文本、与原句的字符级相似度、VAD 端点延迟、对话回复与 TTS 音频，是一个自包含的验收脚本；
- LiveKit venv 补装了 `soundfile` 与 `soxr`（用于设备回环的读写与重采样）。
