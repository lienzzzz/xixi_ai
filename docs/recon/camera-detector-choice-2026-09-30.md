# 在场检测器选型：实测与本机结论（2026-09-30）

> 最后更新：2026-09-30
> 权威来源：本文件是**本机实测记录**（docs/recon 层）。所有数字来自本机命令输出，
> 原始 JSON 在 `data/recon/perception-detector-bench.json`，真实摄像头验收输出在
> `data/recon/perception-camera-verify.txt`（`data/` 在 `.gitignore` 内，只保存在本机）。
> 上游输入是 [`field-test-environment-2026-09-30.md`](field-test-environment-2026-09-30.md)（T0 设备勘测）。

## 0. 结论速览

| # | 问题 | 结论 | 性质 |
|---|---|---|---|
| 1 | 选哪个检测器 | **帧差动做廉价门 + YuNet 人脸做确认**（`cv2.FaceDetectorYN`）。Haar 只作为兜底；**HOG 行人不用**（空场景 0–2 个误报，107.6 ms/帧） | 实测 + 决策 |
| 2 | 用哪个 venv / 版本 | 主用 **`.venvs/cv4`（opencv-python-headless 4.14.0.94 + numpy 2.5.3，Python 3.12.10）**；`.venvs/field-probe`（opencv 5.0.0.93 + onnxruntime 1.30.0）也能跑，但 Haar 不可用（6 个用例显式 skip） | 实测 |
| 3 | 要不要下载模型 | YuNet **要**（232,589 B = 227 KB）：`face_detection_yunet_2023mar.onnx`，T0 已存入 `data/models/`（仓库不跟踪二进制）。Haar/HOG 是 OpenCV 自带的，不需要下载 | 实测 |
| 4 | 单帧耗时（640×480） | YuNet **29.28 ms 中位**（CPU，8 线程）；Haar frontal **18.64 ms**；组合路径（每帧帧差动 + 每 10 帧一次人脸）**0.44 ms 中位 / 60 帧摊薄 3.08 ms 每帧** | 实测 |
| 5 | CPU 占用 | YuNet 640×480：**604.8% 单核当量 = 75.6% 整机（8 核）**；320×240：613.5% / 76.7%；Haar 640×480：364.3% / 45.5%；组合路径 60 帧摊薄 **625.7% / 78.2%** | 实测 |
| 6 | 有没有引入 torch | **没有**。基准里 `torch_installed = false`，并且有测试用 AST 扫描禁止 `torch`/`requests`/`socket` 等 import 进入 `services/perception-edge` | 实测 + 断言 |
| 7 | 真实摄像头能不能跑 | **能**：640×480 DSHOW，15 s 抓 421 帧，处理 **27.5 fps**（抓帧 35.1 fps），检测 5.1 ms 均值 / 41.1 ms p95，画面里没人时 **0 次状态转换（没有误报）** | 实测 |
| 8 | 什么没验证 | **真人站在镜头前的检出自测**（当前摄像头朝天，画面里没有人）。它是 M6 的用户自测步骤，见 `docs/design/perception.md` | 未实测 |

## 1. 候选与排除理由

| 候选 | 模型 | 是否需要下载 | 结论 |
|---|---|---|---|
| 帧差动（`cv2.absdiff` + 阈值） | 无（算法） | 否 | **采用**：1 ms 级，任何运动都能触发（包括不朝镜头的人） |
| YuNet 人脸（`cv2.FaceDetectorYN`） | `face_detection_yunet_2023mar.onnx` 227 KB | **是** | **采用**：空场景 0 检出，正对照（自拍照 640×480）46 张脸全中 |
| Haar 正面脸（`CascadeClassifier`） | `haarcascade_frontalface_default.xml` 930,127 B | 否（OpenCV 自带） | **兜底**：OtR 便宜（18.6 ms）但正对照只中 5 张（YuNet 46 张），召回明显弱 |
| HOG 行人（内置 SVM） | 30,248 B | 否 | **不用**：同一空场景 `winStride=(8,8)` 报 2 个「人」、默认参数报 0 个——误报随参数漂移，且 107.6 ms/帧（T0 实测） |
| onnxruntime 上的轻量检测模型 | 未评估 | 是（数 MB 起） | **不用**：需要自己导出 + 写后处理，且 T0 已测出 ORT 原始前向 27.0 ms 并不比 `cv2.FaceDetectorYN` 的 29.3 ms 明显划算，却少了后处理与 NMS |

**为什么是「帧差动 + 人脸」而不是「只用人脸」**：只用人脸时，背对镜头、戴帽子、光线不好都会漏；
只用帧差动时，窗帘飘动和灯光跳变都会误报。两者是互补的：运动回答「有东西在动」，
人脸回答「这个动的东西是人脸」。两者都是「有人」证据，防抖层再决定要不要发事件
（见 `docs/design/perception.md`）。

## 2. 复现命令

```powershell
# 检测器耗时 / CPU / 正负对照（纯本地，不联网，不写任何图片）
E:\worker2\.venvs\cv4\Scripts\python.exe -m perception_edge.bench --out E:\worker2\data\recon\perception-detector-bench.json
Push-Location services\perception-edge    # 上面这条要在 services/perception-edge 下跑

# 同一份基准在 OpenCV 5 的解释器下（验证降级路径）
E:\worker2\.venvs\field-probe\Scripts\python.exe -m perception_edge.bench

# 真实摄像头验收（会占用摄像头 15 s，画面不出本机）
Pop-Location
node scripts/verify-camera-presence.ts --seconds 15
```

## 3. 环境（基准实际跑在什么上面）

`data/recon/perception-detector-bench.json` 的 `environment` 段：

| 项 | 值 |
|---|---|
| Python | 3.12.10（`.venvs/cv4`，隔离 venv，AGENTS.md §7） |
| OpenCV | **4.14.0**（`opencv-python-headless 4.14.0.94`） |
| numpy | 2.5.3 |
| 平台 | Windows-10-10.0.19045-SP0，8 逻辑核 |
| `cv2.getNumThreads()` | 8 |
| `has(CascadeClassifier / HOGDescriptor / FaceDetectorYN)` | true / true / true |
| `torch_installed` | **false** |

OpenCV 5.0 的差异（T0 已实测、本轮再次确认）：`CascadeClassifier` 与 `HOGDescriptor` 被移除，
所以 Haar 兜底在 5.x 上不存在。代码里是**显式降级**（`HaarFaceDetector` 构造时抛错 →
`create_face_detector` 回落到 `NullFaceDetector` 并在 `summary.face_backend` 里报 `none`），
6 个依赖 Haar 的用例在 5.x 下明确 `skip`，不是静默通过。

## 4. 单帧耗时与 CPU（实测）

方法：warmup 3 次后计时 15 次，取中位 / p95；输入是 **640×480 场景图**（不是 1280×720）。
CPU 用 `time.process_time()` 增量 ÷ 墙上时间：OpenCV 会内部并行，所以「单核当量」会 >100%，
「整机」列才是任务管理器里看到的比例。

| 检测器 | 输入 | 中位 | 最小 | p95 | 最大 | 单核当量 | 整机（8 核） | 模型大小 | 需下载 |
|---|---|---|---|---|---|---|---|---|---|
| YuNet（`cv2.FaceDetectorYN`） | 640×480 | **29.28 ms** | 25.14 | 29.80 | 31.16 | 604.8% | 75.6% | 232,589 B | 是 |
| YuNet | 320×240 | **6.73 ms** | 6.56 | 7.01 | 7.17 | 613.5% | 76.7% | 同上 | 是 |
| Haar frontal | 640×480 | **18.64 ms** | 18.12 | 20.11 | 20.17 | 364.3% | 45.5% | 930,127 B | 否 |
| Haar frontal | 320×240 | **5.83 ms** | 5.17 | 5.87 | 5.92 | 325.8% | 40.7% | 同上 | 否 |
| 关闭人脸检测（只有帧差动） | 640×480 | 0.0 ms | 0.0 | 0.0 | 0.0 | 0% | 0% | — | 否 |
| **组合路径**（每帧帧差动 + 每 10 帧一次 YuNet） | 640×480 | **0.44 ms**（未跑人脸的那帧） | 0.42 | 0.60 | **27.82**（跑到人脸的那帧） | 724.9% | 90.6% | — | — |
| **组合路径摊薄（60 帧连续）** | 640×480 | **3.08 ms/帧** | — | — | — | 625.7% | **78.2%** | — | — |

> **怎么读这两行组合路径**：只跑帧差动的帧是 0.4 ms 级，偶发那帧会到 27.8 ms（那次要跑人脸）。
> 60 帧摊薄 3.08 ms/帧 = 30 fps 预算（33.3 ms）的 **9.2%**，这是「能不能跑满 30 fps」的判据。
> 「整机 78%」看着高，是 OpenCV 的 8 线程在跑人脸时的瞬时占用；实时对话链路上建议
> `--threads 1` 或 `2` 给音频留余量（`python -m perception_edge.run --threads 1` 实测
> 组合路径均值从 5.34 ms 降到 4.26 ms 附近，见 `data/recon/perception-camera-verify.txt` 的 `detect_ms_*`）。

## 5. 正负对照（本轮复测）

| 输入 | YuNet 检出 | Haar 检出 | 说明 |
|---|---|---|---|
| 生成的空场景（代码画的房间，640×480） | **0** | **0** | 负对照：不能空场报「有人」 |
| 同上 + 25% 像素椒盐噪声 | **0** | **0** | 负对照：单帧噪声不能变成人脸（帧差动仍会判「有运动」，由防抖层挡） |
| `data/models/largest_selfie.jpg`（外部图，仅本机） | **46**（缩到 640×480）/ 135（原图） | 5 | 正对照 |
| `data/models/lena.jpg`（外部图，仅本机） | **1** | 1 | 正对照 |
| 代码生成的 `rig_face`（本仓库测试自带） | **1** | 0 | 正对照：不依赖任何外部图片 |

> **这两张外部图不随仓库分发**：它们只在 `data/` 下（已 gitignore），且**上游来源与许可没有记录**
> （T0 下载时没留 URL）。因此测试**不依赖**它们：默认的离线回归测试全部用代码生成的图，
> 这两张只在文件存在时作为可选正对照跑（不存在就显式 skip）。这也解释了为什么
> 「图片来源与许可」一节只能写：生成图 = 本仓库自产、无第三方权利；外部图 = 未记录许可、不进仓库。

## 6. 真实摄像头验收（实测）

命令：`node scripts/verify-camera-presence.ts --seconds 15`（默认库 `data/perception/field-test.sqlite`）
原始输出：`data/recon/perception-camera-verify.txt`

| 指标 | 实测 |
|---|---|
| 打开设备 | 784.6 ms（DSHOW；与 T0 的 379 ms 同量级，本次含首次冷启动） |
| 首帧 | 71.3 ms |
| 抓帧 | **421 帧 / 15 s**，`read()` 均值 28.5 ms、p50 31.4、p95 47.3、max 48.9 → 抓帧 35.1 fps |
| 处理 | **27.5 fps**（每帧帧差动 + 每 10 帧人脸；`--threads 1`） |
| 检测耗时 | 均值 **5.1 ms** / p95 **41.1 ms**（p95 是跑到人脸的那帧） |
| 判定 | 421 帧全部无证据，**0 次状态转换**（画面里没有人） |
| 事件 | 1 条 `presence.changed`（启动状态 `reason=camera_started`，present=false） |
| 投影 | `world_state[presence.home] = absent`，confidence 0.85，TTL 60 s，`stale=false` |

**这组数字证明了什么**：真实摄像头能开、能持续抓、检测跟得上、空场景不误报、
事件与投影确实落库。**没有证明什么**：画面里没有人时当然检不出人——「真人在镜头前能被检出」
需要人参与，见下一节。

## 7. 未实测 / 需要人参与的项（必须说清楚）

| 项 | 状态 | 怎么补 |
|---|---|---|
| **真人站在镜头前能否检出** | **未实测**。当前摄像头朝天（T0 §4.3），画面里没有人；本文件所有正对照都是外部图片或代码画的图，**不能当作真人实测** | 用户自测步骤见 `docs/design/perception.md` 的「验收」一节：`node scripts/verify-camera-presence.ts --seconds 40 --require-transition`，人站在镜头前走动 |
| 分辨率降到 320×240 抓帧时的真人检出率 | 未实测 | 同上，加 `--process-width 240` |
| 夜间/逆光下的人脸检出 | 未实测 | 同上，环境光变化时复跑 |
| 多机位 / 多房间 | 未做（M6 不做） | 方案 §4.1 的 Frigate/MQTT 路线属于后续里程碑 |
| 「是不是父亲本人」（人脸识别） | **刻意不做**：只回答「有没有人」，不识别身份（隐私与高风险边界，见铁律 7） | 不在 M6 范围 |

## 8. 依赖与许可（新增依赖的逐条理由，铁律 12）

| 依赖 | 版本 | 为什么需要 | 来源与许可 |
|---|---|---|---|
| `opencv-python-headless` | 4.14.0.94（`.venvs/cv4`） | 摄像头抓帧（DSHOW 后端）+ 帧差动 + `FaceDetectorYN`/Haar | Apache-2.0（OpenCV 本体 BSD-3；wheel 由 opencv-python 项目分发，MIT） |
| `numpy` | 2.5.3 | 帧数组运算（差异、阈值、计数） | BSD-3-Clause |
| `face_detection_yunet_2023mar.onnx` | 227 KB | 人脸确认 | 来自 OpenCV Zoo（`opencv/opencv_zoo`，Apache-2.0）；**不进仓库**，放 `data/models/` |
| `onnxruntime` | 1.30.0（`.venvs/field-probe`） | **本方案不使用**；只在 T0 的对比基准里用过 | MIT |
| `torch` | — | **禁止引入**（任务硬约束） | — |

`--headless` 是刻意的：这个服务不需要 GUI，headless wheel 不带 Qt/GTK。

与上游的冲突以本文件为准，但**没有推翻 T0 的任何结论**：

- T0 说「opencv 钉 <5（要 Haar）」——本轮沿用，并且额外把「5.x 下 Haar 不可用」做成显式降级；
- T0 说「帧差动噪声底 0.8 灰阶、阈值建议 6–8」——本轮用 6，并且加了「运动像素占比 ≥ 0.5%」
  这一层，空场景与高斯噪声场景都判 0；
- T0 说「HOG 会误报、不建议」——本轮直接不用它，理由与数字都抄在这里。

## 维护规则

- 本文件是**带日期的历史记录**（docs/recon 层），新的实测请写新的 `camera-detector-choice-YYYY-MM-DD.md`，
  不要改写本文的数字。
- 任何被本文引用为「实测」的结论，若在本机复测得到不同数字，**以新报告为准**，并注明推翻了哪一条。
