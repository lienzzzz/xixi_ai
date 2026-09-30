# 现场测试报告（设备验收）— 2026-09-30

- 生成时间：2026-09-30T07:03:49.164Z
- 命令：`node scripts/field-test.ts --acceptance`
- 机器：DESKTOP-JMLLAC2｜Node v24.21.0｜win32
- 探测用 Python：`E:\worker2\.venvs\field-probe\Scripts\python.exe`（设备端点/麦克风/摄像头）、`E:\worker2\.venvs\voice-livekit\Scripts\python.exe`（声学回环）
- **总体结论：未通过（FAIL，逐项见下）**

## 口径变更说明（先看这一节，再看下面的逐项数字）

**扬声器结论在 t4 交付时为 PASS、t21 修正口径后为 FAIL——变的是测量口径，不是机器；旧口径高估了声学余量。**

| | t4 交付时（旧口径） | t21 修正后（现行口径） | 为什么变 |
|---|---|---|---|
| 扬声器判据 | **帧级 dB 分位**：最响的 50 ms 帧 − 静音窗平均 ≈ 12.97 dB → PASS | **能量比**（主判据）：播放窗平均带内功率 − 静音窗平均带内功率 → **见下面的逐项表**（本机实测 ~2–3 dB，< 10 dB 即 FAIL） | 分位只看「最响的那一瞬间」，是**乐观上界**；能量比是整段平均，才对应 ASR 真正拿到的信噪比 |

旧口径虚增约 9 dB，两个原因叠加：

1. **分位本身是乐观上界**：帧级 p95 取的是播放窗里最响的 50 ms 帧，比平均功率之比天然高 8–10 dB（t6 复核实测 11.83 vs 2.69 dB）。
2. **旧的静音参考窗偏「太低」**：旧实现只取播放前 0.6 s 的帧电平均值，而采集刚启动那一段有爬升（电平偏低），把噪声参考压低 → 相对差被进一步放大。现在改成「前置 1.0 s + 尾部 1.0 s 的平均带内功率」，三个窗的电平都写在证据里，可以自己复算。

**这不是「功能坏了」**：程序确实把音频送到了输出流（WASAPI 回采相关见逐项表），麦克风也确实能听到最响的那些帧；不达标的是**平均声学余量**——本机麦克风自噪偏高（勘测实测麦克风只比噪声底高 0.8–2.6 dB），扬声器一侧没有问题。

**改善路径（做完任一条再重跑本报告就会更新数字）**：

1. 确认输出音量 ≥ 50% 且扬声器没有被物理静音；
2. 麦克风离扬声器 0.3–1 m，避开正对风扇/机箱；
3. 把**输入采集增益**设为 0 dB（「声音设置 → 输入」；当前读数见下面麦克风一项——控制台只显示并提示，不会替你改系统设置）；
4. 仍不达标时用外接麦克风（本机内置阵列的自噪是瓶颈）。

本节由报告生成器固定输出（`renderAcceptanceReport` 的 `ACCEPTANCE_CRITERIA_NOTE`），**重跑 `--acceptance` 不会丢失**。

| 顺序 | 项目 | 结论 | 摘要 |
|---|---|---|---|
| 1 | 麦克风（说话能不能进来） | 通过 | 通过：麦克风能录到声音（RMS -37.85 dBFS，噪声底 -42.26 dBFS，采集增益 -2.09 dB） |
| 2 | 扬声器（西西说话你能不能听到） | 失败 | 失败（口径修正后）：程序确实渲染了音频（相关 0.89），但按**能量比**口径麦克风只比噪声底高 5.16 dB（< 10 dB）；分位口径 10.49 dB 是乐观上界，不代表平均声学余量。这与勘测实测的 0.8–2.6 dB 一致：瓶颈是本机麦克风自噪，不是扬声器 |
| 3 | 摄像头（西西在不在场） | 通过 | 通过：摄像头能出清晰的画面；在场检测（M6）尚未接入，页面会显示「未接入」 |

## 1. 麦克风（说话能不能进来）

**结论**：通过｜通过：麦克风能录到声音（RMS -37.85 dBFS，噪声底 -42.26 dBFS，采集增益 -2.09 dB）

| 检查项 | 结果 | 实测 |
|---|---|---|
| Windows 采集端点（默认麦克风） | 通过 | 设备「麦克风 (Realtek High Definition Audio)」：静音=false，音量=45%，采集增益=-2.09 dB（= Windows 输入端点音量；pycaw 只读读数，仓库里没有任何代码设置它） |
| 录了 3 秒环境声 | 通过 | 设备「麦克风 (Realtek High Definition Au」：整段 RMS -37.85 dBFS，峰值 -24.25 dBFS（0 dBFS = 数字满量程，越接近 0 越响；−60 dBFS 以下说明几乎收不到声音） |
| 噪声底（说话时要明显高于它） | 通过 | 噪声底 -42.26 dBFS（50ms 帧 RMS 的 p10）。高于 −40 dBFS 说明这台机器的底噪偏大（勘测实测 −30.86 dBFS），这是当前最大风险 |
| 输入采集增益（系统设置，仅提示） | 信息 | 采集增益当前 -2.09 dB（Windows 输入端点读数，仓库里没有任何代码修改它）：噪声底不高，保持现状即可 |

**下一步动作**：扬声器自检（不需要你说话，程序会自己放一段音频）

<details><summary>原始证据（JSON）</summary>

```json
{
  "endpoints": {
    "render": {
      "label": "render",
      "name": "扬声器 (Realtek High Definition Audio)",
      "muted": false,
      "volumeScalar": 0.661,
      "volumeDb": -6.19,
      "gainDb": null
    },
    "capture": {
      "label": "capture",
      "name": "麦克风 (Realtek High Definition Audio)",
      "muted": false,
      "volumeScalar": 0.4471,
      "volumeDb": -2.09,
      "gainDb": -2.09
    }
  },
  "captureGainDb": -2.09,
  "readOnly": true,
  "recording": {
    "ok": true,
    "device": "麦克风 (Realtek High Definition Au",
    "rate": 44100,
    "seconds": 3,
    "unit": "dBFS",
    "rmsDbfs": -37.85,
    "noiseFloorDbfs": -42.26,
    "p90FrameDbfs": -34.86,
    "peakDbfs": -24.25,
    "frames": 60
  }
}
```

</details>

## 2. 扬声器（西西说话你能不能听到）

**结论**：失败｜失败（口径修正后）：程序确实渲染了音频（相关 0.89），但按**能量比**口径麦克风只比噪声底高 5.16 dB（< 10 dB）；分位口径 10.49 dB 是乐观上界，不代表平均声学余量。这与勘测实测的 0.8–2.6 dB 一致：瓶颈是本机麦克风自噪，不是扬声器

| 检查项 | 结果 | 实测 |
|---|---|---|
| Windows 输出端点（默认扬声器） | 通过 | 设备「扬声器 (Realtek High Definition Audio)」：静音=false，音量=66%（勘测发现出厂就是静音，这正是上一轮验收失败的根因） |
| ① 程序真的把音频送到了输出流（WASAPI loopback） | 信息 | 回采信号与播放信号的相关性 0.89（最佳对齐 259.2 ms；≥0.9 视为独立确认，勘测用单流采集时实测 0.9996）。注意：静音时这个数也是高的，它只能证明「程序渲染了」，不能证明「听到了」 |
| 测试音频本身（播放增益 1.0） | 通过 | 播放信号峰值 -5.49 dBFS（距数字满量程 5.5 dB 余量，无削顶采样；夹具语音带电平 −24.6 dBFS，增益 1.0 比 0.6 更接近真实 TTS 播放电平） |
| ② 麦克风真的听到了（主判据：能量比 ≥10 dB，语音带 300–3400 Hz） | 失败 | 能量比 5.16 dB = 播放窗平均带内功率（-44.15 dBFS）− 静音窗平均带内功率（-48.57 dBFS，前置 1.0s + 尾部 1.0s 的所有 50ms 帧）；3 次测量的均值（最差 4.42 / 均值 5.16 / 最好 6.19 dB）。口径说明：能量比是**相对**口径里最保守的那个（平均功率之比，与勘测实测的 0.8–2.6 dB 同一量级，也与 ASR 实际可用性最相关）；绝对 RMS 不能用——勘测实测扬声器静音时绝对 RMS 反而更高（0.0505 vs 0.0486） |
| ③ 参考口径：帧级 dB 分位（乐观上界，不作为判据） | 信息 | 分位差（最响 50ms 帧 − 静音窗平均）10.49 dB（最差 9.6 / 均值 10.49 / 最好 11.69 dB，估计器 voice_edge.frontend）。本次它比能量比高 5.33 dB。口径说明：分位只看最响的瞬间，这个差值是定义差异而非额外余量——T6 在 0.6s 单窗参考下实测 11.83 vs 2.69 dB（差约 9 dB），本报告改了参考窗定义，差值与数值都会随噪声条件变化，**不能**用来判断平均声学余量 |

**下一步动作**：先确认：音量 ≥50%、扬声器未被物理静音、麦克风离扬声器 0.3–1 m，然后重跑。若能量比仍 <10 dB，说明本机麦克风自噪过高——按控制台/报告里的「Windows 采集增益」读数把它设为 0 dB（控制台只提示，不改系统设置），或换外接麦克风

<details><summary>原始证据（JSON）</summary>

```json
{
  "endpoints": {
    "render": {
      "label": "render",
      "name": "扬声器 (Realtek High Definition Audio)",
      "muted": false,
      "volumeScalar": 0.661,
      "volumeDb": -6.19,
      "gainDb": null
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
    "prerollMs": 1000,
    "tailMs": 1000,
    "playedMs": 2520,
    "bandEstimator": "voice_edge.frontend",
    "frontendError": null,
    "energyRatioDb": 4.42,
    "playWindowBandPowerDbfs": -44.15,
    "silenceWindowBandPowerDbfs": -48.57,
    "preRollBandPowerDbfs": -48.82,
    "postRollBandPowerDbfs": -48.33,
    "differentialP95Db": 9.6,
    "differentialMeanDb": 2.24,
    "playWindowP95SpeechBandDbfs": -38.97,
    "playWindowMeanSpeechBandDbfs": -46.33,
    "preRollSpeechBandDbfs": -51.5,
    "bandFrames": {
      "pre": 20,
      "play": 50,
      "post": 20
    },
    "micRmsDbfs": -38.31,
    "loopbackCorrelation": 0.89,
    "loopbackBestLagMs": 259.2,
    "loopbackFrames": 236160,
    "loopbackError": null
  },
  "loopbackTrials": [
    {
      "energyRatioDb": 4.42,
      "differentialP95Db": 9.6,
      "differentialMeanDb": 2.24,
      "silenceWindowBandPowerDbfs": -48.57,
      "playWindowBandPowerDbfs": -44.15,
      "loopbackCorrelation": 0.89
    },
    {
      "energyRatioDb": 4.86,
      "differentialP95Db": 10.17,
      "differentialMeanDb": 2.57,
      "silenceWindowBandPowerDbfs": -49.2,
      "playWindowBandPowerDbfs": -44.34,
      "loopbackCorrelation": 0.89
    },
    {
      "energyRatioDb": 6.19,
      "differentialP95Db": 11.69,
      "differentialMeanDb": 2.99,
      "silenceWindowBandPowerDbfs": -50.02,
      "playWindowBandPowerDbfs": -43.83,
      "loopbackCorrelation": 0.2976
    }
  ],
  "trialStats": {
    "energyRatioDb": {
      "count": 3,
      "best": 6.19,
      "worst": 4.42,
      "mean": 5.16
    },
    "differentialP95Db": {
      "count": 3,
      "best": 11.69,
      "worst": 9.6,
      "mean": 10.49
    },
    "trials": 3
  }
}
```

</details>

## 3. 摄像头（西西在不在场）

**结论**：通过｜通过：摄像头能出清晰的画面；在场检测（M6）尚未接入，页面会显示「未接入」

| 检查项 | 结果 | 实测 |
|---|---|---|
| 能以 CAP_DSHOW 打开（本机唯一可用后端） | 通过 | 已打开：640×480 @ 25 fps（本轮采到 15 帧） |
| 画面不是全黑/全灰（能看到东西） | 通过 | 亮度均值 127.3，标准差 57.6（标准差接近 0 = 画面一片死黑或死白；镜头盖、遮挡、强逆光都会这样） |
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
    "fps": 25,
    "lumaMean": 127.3,
    "lumaStd": 57.6,
    "uniqueLuma": 224,
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
    "checkedAt": "2026-09-30T07:03:22.716Z"
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
- 扬声器「麦克风真的听到了」有**两个口径**，报告里两个都给出：② **能量比**（主判据：播放窗平均带内功率 − 静音窗平均带内功率，保守、与 ASR 可用性最相关，勘测实测 0.8–2.6 dB）与 ③ **帧级 dB 分位**（乐观上界：最响的 50 ms 帧 − 静音窗平均；T6 实测 11.83 vs 2.69 dB，差约 9 dB，本报告的参考窗定义不同故差值不同）。单一分位数字会让读者高估声学余量，所以它不再作为判据
- 扬声器复测：固定测 3 次，判据取 3 次的**均值**，同时给出最差/最好（每次的原始数字都在证据里）。不取「最好的一次」，避免把偶然的噪声低谷当成余量
- 静音参考窗的定义：前置 1.0 s + 尾部 1.0 s 的所有 50 ms 帧的**平均带内功率**（两个窗都列在证据里）。取两段而不是只看前置，是为了不让采集刚启动时的爬升段把噪声底压低而虚增余量；尾部若混入播放混响，只会让判据更保守
- 输入采集增益（Windows 采集端点音量，pycaw 只读读数）会显示在麦克风一项与报告里；噪声底偏高时只提示「可考虑设为 0 dB」，控制台不会修改任何系统设置
- 「程序渲染了音频」（WASAPI 回采相关性）是证据不是门禁：本机带音频增强/重采样时实测会低于勘测单流采集的 0.9996，所以它不单独判失败；判失败的是「端点被静音」与「麦克风没听到（相对差 <10 dB）」
- 扬声器相对差是噪声测量：本机多次运行实测 9.1–14.7 dB（单次结果会压在 10 dB 阈值上）；因此用更好的播放电平（增益 1.0，无削顶）+ 最多 3 次复测取较好值，每一次的原始数字都写进证据——真坏了的话三次都不会过
- 同时有别的程序（浏览器标签、会议软件，或另一个正在跑的检测脚本）占用摄像头时，DSHOW 一定打不开——这是占用而不是设备故障，关掉占用方后重跑本项即可
- 本机实测噪声底 −30.86 dBFS、环境 RMS −27.25 dBFS（勘测 §1.2），麦克风噪声是当前最大风险；麦克风一项的「通过」不等于「识别一定准」。
- 噪声底每次重新实测，不沿用旧数字：本轮与勘测的差异来自采集音量/设备状态（Windows 采集端点音量、麦克风位置），所以报告里的数字以本文件为准，勘测数字只作对照。
- 绝对 RMS 不能当扬声器判据：勘测实测扬声器静音时 RMS 反而更高（0.0505 vs 0.0486），因此本报告用「播放窗 − 静音窗」的**相对**判据；其中主判据是**能量比**（保守、≥10 dB），帧级 dB 分位只作乐观上界参考。
- 扬声器判据的门限（10 dB）没有因为口径变化而改变，但换到能量比口径后本机读数会明显更低——这正是勘测 0.8–2.6 dB 与旧报告「11 dB 通过」之间矛盾的解释。

## 复现方式

```powershell
npm run field-test                 # 打开现场测试控制台，页面里点「开始设备自检」
node scripts/field-test.ts --acceptance   # 只跑一次真机验收并重写本报告
node scripts/field-test.ts --self-test    # 离线自检（隐私/多段语音/页面），不碰硬件
```
