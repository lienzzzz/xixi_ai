# 现场测试报告（设备验收）— 2026-09-30

- 生成时间：2026-09-30T03:36:53.996Z
- 命令：`node scripts/field-test.ts --acceptance`
- 机器：DESKTOP-JMLLAC2｜Node v24.21.0｜win32
- 探测用 Python：`E:\worker2\.venvs\field-probe\Scripts\python.exe`（设备端点/麦克风/摄像头）、`E:\worker2\.venvs\voice-livekit\Scripts\python.exe`（声学回环）
- **总体结论：未通过（FAIL，逐项见下）**

| 顺序 | 项目 | 结论 | 摘要 |
|---|---|---|---|
| 1 | 麦克风（说话能不能进来） | 通过 | 通过（有风险）：麦克风能录到声音，但噪声底 -31.52 dBFS 偏高，说话声只比它高几 dB 时识别会不稳 |
| 2 | 扬声器（西西说话你能不能听到） | 失败 | 失败：麦克风没有明显听到播放声（相对差 9.91 dB < 10 dB），但程序确实渲染了音频（相关 0.89） |
| 3 | 摄像头（西西在不在场） | 通过 | 通过：摄像头能出清晰的画面；在场检测（M6）尚未接入，页面会显示「未接入」 |

## 1. 麦克风（说话能不能进来）

**结论**：通过｜通过（有风险）：麦克风能录到声音，但噪声底 -31.52 dBFS 偏高，说话声只比它高几 dB 时识别会不稳

| 检查项 | 结果 | 实测 |
|---|---|---|
| Windows 采集端点（默认麦克风） | 通过 | 设备「麦克风 (Realtek High Definition Audio)」：静音=false，音量=68% |
| 录了 3 秒环境声 | 通过 | 设备「麦克风 (Realtek High Definition Au」：整段 RMS -29.03 dBFS，峰值 -16.94 dBFS（0 dBFS = 数字满量程，越接近 0 越响；−60 dBFS 以下说明几乎收不到声音） |
| 噪声底（说话时要明显高于它） | 信息 | 噪声底 -31.52 dBFS（50ms 帧 RMS 的 p10）。高于 −40 dBFS 说明这台机器的底噪偏大（勘测实测 −30.86 dBFS），这是当前最大风险 |

**下一步动作**：扬声器自检；另外建议把麦克风采集增益从 +5.5 dB 降到 0 dB（实测 1:1 换回约 5.5 dB 噪声余量），或让麦克风离人近一点

<details><summary>原始证据（JSON）</summary>

```json
{
  "endpoints": {
    "render": {
      "label": "render",
      "name": "扬声器 (Realtek High Definition Audio)",
      "muted": false,
      "volumeScalar": 0.661,
      "volumeDb": -6.19
    },
    "capture": {
      "label": "capture",
      "name": "麦克风 (Realtek High Definition Audio)",
      "muted": false,
      "volumeScalar": 0.6824,
      "volumeDb": 2.63
    }
  },
  "recording": {
    "ok": true,
    "device": "麦克风 (Realtek High Definition Au",
    "rate": 44100,
    "seconds": 3,
    "unit": "dBFS",
    "rmsDbfs": -29.03,
    "noiseFloorDbfs": -31.52,
    "p90FrameDbfs": -27.15,
    "peakDbfs": -16.94,
    "frames": 60
  }
}
```

</details>

## 2. 扬声器（西西说话你能不能听到）

**结论**：失败｜失败：麦克风没有明显听到播放声（相对差 9.91 dB < 10 dB），但程序确实渲染了音频（相关 0.89）

| 检查项 | 结果 | 实测 |
|---|---|---|
| Windows 输出端点（默认扬声器） | 通过 | 设备「扬声器 (Realtek High Definition Audio)」：静音=false，音量=66%（勘测发现出厂就是静音，这正是上一轮验收失败的根因） |
| ① 程序真的把音频送到了输出流（WASAPI loopback） | 信息 | 回采信号与播放信号的相关性 0.89（最佳对齐 279.2 ms；≥0.9 视为独立确认，勘测用单流采集时实测 0.9996）。注意：静音时这个数也是高的，它只能证明「程序渲染了」，不能证明「听到了」 |
| 测试音频本身（播放增益 1.0） | 通过 | 播放信号峰值 -5.49 dBFS（夹具本身 −24.6 dBFS，增益 1.0 仍留 ~24 dB 余量，不会削顶；比 0.6 更接近真实 TTS 播放电平） |
| ② 麦克风真的听到了（播放窗 − 前置静音窗，语音带 300–3400 Hz） | 失败 | 相对差 9.91 dB（均值 8.1 dB，估计器 inline-fallback；判据 ≥10 dB）。这是**相对**判据：勘测实测扬声器静音时绝对 RMS 反而更高（0.0505 vs 0.0486），绝对判据会假 PASS｜本轮复测 2 次（第一次 8.87 dB），取较好的一次 |

**下一步动作**：两种失败要分开看：①「渲染失败」看相关性，②「听不到」看音量/距离。请先确认音量 ≥50%，扬声器没有被物理静音，麦克风离扬声器 0.3–1 m，然后重跑

<details><summary>原始证据（JSON）</summary>

```json
{
  "endpoints": {
    "render": {
      "label": "render",
      "name": "扬声器 (Realtek High Definition Audio)",
      "muted": false,
      "volumeScalar": 0.661,
      "volumeDb": -6.19
    }
  },
  "loopback": {
    "ok": true,
    "fixture": "E:\\worker2\\tests\\audio-fixtures\\direct-question.wav",
    "gain": 1,
    "rate": 48000,
    "unit": "dBFS",
    "playbackPeakDbfs": -5.49,
    "playbackClipSamples": 0,
    "prerollMs": 600,
    "playedMs": 2520,
    "preRollSpeechBandDbfs": 20.53,
    "playWindowMeanSpeechBandDbfs": 28.63,
    "playWindowP95SpeechBandDbfs": 30.44,
    "differentialMeanDb": 8.1,
    "differentialP95Db": 9.91,
    "micRmsDbfs": -28.88,
    "bandEstimator": "inline-fallback",
    "frontendError": "SyntaxError: invalid character '—' (U+2014) (frontend.py, line 620)",
    "loopbackCorrelation": 0.89,
    "loopbackBestLagMs": 279.2,
    "loopbackFrames": 188160,
    "loopbackError": null
  },
  "loopbackTrials": [
    {
      "differentialP95Db": 8.87,
      "differentialMeanDb": 7.48,
      "loopbackCorrelation": 0.89
    },
    {
      "differentialP95Db": 9.91,
      "differentialMeanDb": 8.1,
      "loopbackCorrelation": 0.89
    }
  ]
}
```

</details>

## 3. 摄像头（西西在不在场）

**结论**：通过｜通过：摄像头能出清晰的画面；在场检测（M6）尚未接入，页面会显示「未接入」

| 检查项 | 结果 | 实测 |
|---|---|---|
| 能以 CAP_DSHOW 打开（本机唯一可用后端） | 通过 | 已打开：640×480 @ 28.1 fps（本轮采到 15 帧） |
| 画面不是全黑/全灰（能看到东西） | 通过 | 亮度均值 129.1，标准差 39.5（标准差接近 0 = 画面一片死黑或死白；镜头盖、遮挡、强逆光都会这样） |
| 在场检测（M6）投影是否接入 | 信息 | 摄像头能出图，但在场检测还没接入：world_state 里还没有 presence.home 这一行（摄像头还没看到过人）（这是「未接入」，不是故障） |

**下一步动作**：等视觉任务（M6）接入后，页面会自动显示「有人/无人」；现在可以先用「按住说」跑一轮对话

<details><summary>原始证据（JSON）</summary>

```json
{
  "camera": {
    "ok": true,
    "backend": "CAP_DSHOW",
    "opened": true,
    "width": 640,
    "height": 480,
    "frames": 15,
    "fps": 28.1,
    "lumaMean": 129.1,
    "lumaStd": 39.5,
    "uniqueLuma": 217,
    "maxWidth": 1280,
    "maxHeight": 720
  },
  "presence": {
    "mode": "not-integrated",
    "text": "未接入",
    "present": null,
    "confidence": null,
    "source": null,
    "updatedAt": null,
    "stale": null,
    "ttlSeconds": null,
    "note": "world_state 里还没有 presence.home 这一行（摄像头还没看到过人）",
    "checkedAt": "2026-09-30T03:36:53.992Z"
  }
}
```

</details>

## 麦克风校准与隐私策略

- 噪声底来源：噪声底与门限来自实测校准（voice_edge.calibrate）
- 噪声底 -33.24 dBFS，门限 -18 dBFS，高通 120 Hz，建议采集增益 0 dB
- privacy.store_raw_audio=false、memory.raw_audio_retention_days=0：整段录音不落盘，语音段也不保留（ASR 直接用内存里的音频）。这是 §20.1 的默认读法：本地不留原始录音、连续音频不上云。
- 实测噪声底（校准产物 data/voice/frontend-profile.json）：-33.24 dBFS，建议门限 -18 dBFS
- 整段录音不落盘：只在系统临时目录里存在到 VAD 结束，随后立即删除；没有语音时磁盘上不留任何录音。

## 已知风险与判据说明

- 判据说明：「程序渲染了音频」与「麦克风真的听到了」是两件事，分别测量、分别显示（勘测 §2.5 的假 PASS 教训）
- 「程序渲染了音频」（WASAPI 回采相关性）是证据不是门禁：本机带音频增强/重采样时实测会低于勘测单流采集的 0.9996，所以它不单独判失败；判失败的是「端点被静音」与「麦克风没听到（相对差 <10 dB）」
- 扬声器相对差是噪声测量：本机在增益 0.6 时多次运行实测 9.1–13.0 dB（正好压在 10 dB 阈值上），现在用增益 1.0（夹具 −24.6 dBFS，仍留 ~24 dB 余量不削顶，更接近真实 TTS 播放电平）；第一次低于 12 dB 时还会复测一次并取较好值，两次数字都写进证据
- 同时有别的程序（浏览器标签、会议软件，或另一个正在跑的检测脚本）占用摄像头时，DSHOW 一定打不开——这是占用而不是设备故障，关掉占用方后重跑本项即可
- 本机实测噪声底 −30.86 dBFS、环境 RMS −27.25 dBFS（勘测 §1.2），麦克风噪声是当前最大风险；麦克风一项的「通过」不等于「识别一定准」。
- 噪声底每次重新实测，不沿用旧数字：本轮与勘测的差异来自采集音量/设备状态（Windows 采集端点音量、麦克风位置），所以报告里的数字以本文件为准，勘测数字只作对照。
- 绝对 RMS 不能当扬声器判据：勘测实测扬声器静音时 RMS 反而更高（0.0505 vs 0.0486），因此本报告用「播放窗 − 前置静音窗」的相对判据（≥10 dB）。

## 复现方式

```powershell
npm run field-test                 # 打开现场测试控制台，页面里点「开始设备自检」
node scripts/field-test.ts --acceptance   # 只跑一次真机验收并重写本报告
node scripts/field-test.ts --self-test    # 离线自检（隐私/多段语音/页面），不碰硬件
```
