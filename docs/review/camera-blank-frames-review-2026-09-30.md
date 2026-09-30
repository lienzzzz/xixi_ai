# 评审：空帧判据与「不把空帧当画面」（t99）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t99 的实机排查）
> 评审对象：`e0c3c17`「t99 完成：查清纯黑帧——驱动没把画面交出来（不是光照也不是遮挡）」（`perception_edge/{camera,run,__init__}.py`、`scripts/verify-camera-presence.ts`、`docs/design/perception.md` +73 行）
> 复核方式：**自写 Python 夹具探针 22 项**（直接调 `is_blank_frame` 与 `FrameGrabber`，用假 `cv2.VideoCapture` 驱动跳帧逻辑）+ **按文档实跑 `--probe-frames 3` 与检测路径**（真摄像头，只读）
> 时序：HEAD = `9debdca`；工作区在途是别人的 `scripts/field-test.ts`、`tests/console/*`（t103 的控制台提示，与本次评审对象无关）

---

## 1. 结论

**verdict：needs_revision（1 条 medium finding：F1 —— 文档说的 `CameraUnavailable` 触发条件与代码不符，而我在这台机器上**当场**撞到了它）**

一句话：**判据本身是安全的**——我用夹具量化过边界：8 位帧里 `std < 0.05` 意味着「最多约 0.25% 的像素比其余像素差 1 个灰阶」，也就是**几乎逐像素恒定**；真实昏暗的场景（泊松噪声 `std 1.23`、有结构的暗帧 `std 1.17`）**都不会**被当成空帧，所以「极暗被误报为摄像头不可用」这个担心在实测数据上不成立。**但「整段窗口全是空帧 → 抛 `CameraUnavailable` + exit 2、不会把黑帧当『画面里没有人』」这句话不成立**：`CameraUnavailable` 只在 **`read()` 读不到帧**时抛；如果驱动持续回传**可读**的空帧（正是这台机器 MJPG 的症状），窗口一过，`open()` 就把那帧空帧当首帧**接受**，检测照常跑、照样写 `present=false reason=camera_started`、`exit 0`。我在本机实跑复现了这一点（§3.3）。

| 任务验收条款 | 我的判定 | 依据 |
|---|---|---|
| 1 独立核对：空帧判据会不会在真实昏暗场景误报（用极暗但有噪声的夹具验边界）；`FrameGrabber` 跳空帧与 `CameraUnavailable` 触发条件与文档一致；`movement_evidence` 能否区分「空帧」与「房间没人」 | **判据与 movement_evidence 成立，但 `CameraUnavailable` 那条与文档不符（F1）** | §2、§3、§4 |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/` | **满足** | §6：`npm test` **235/235 pass / 0 fail / exit 0**；`check:docs` **70 份 / 0 问题 / exit 0** |

---

## 2. 空帧判据的边界：不会把「真实昏暗」误报成空帧

判据（`camera.py`）：`grey.max() <= BLANK_MAX_LUMA (4)` **且** `grey.std() < BLANK_MAX_STD (0.05)`（8 位灰阶单位）。我的夹具矩阵（360×480）：

| 夹具 | mean / max / std | 判为空帧？ |
|---|---|---|
| 全 0（驱动恒定缓冲） | 0 / 0 / 0.00 | **是** |
| 恒定 1（t99 实测的 MJPG 空帧） | 1 / 1 / 0.00 | **是** |
| 恒定 4（判据上边界，含在内） | 4 / 4 / 0.00 | **是** |
| 恒定 5（刚过 `max` 上界） | 5 / 5 / 0.00 | 否（见 O2） |
| **极暗但有传感器噪声 Poisson(1.5)** | 1.5 / 10 / **1.23** | **否** |
| 极暗 + 半灰阶噪声（σ=0.6 灰阶） | 2.0 / 5 / 0.66 | **否** |
| **暗但有结构（0→4 渐变 + σ=0.3）** | 1.53 / 4 / **1.17** | **否** |
| 恒定 2，0.10% 像素差 1 灰阶 | 2.0 / 3 / 0.03 | 是 |
| 恒定 2，**0.25%** 像素差 1 灰阶 | 2.0 / 3 / 0.05（原始值 ≈0.0499） | 是 |
| 恒定 2，0.50% 像素差 1 灰阶 | 2.0 / 3 / 0.07 | **否** |
| 三通道全 0 | 0 / 0 / 0.00 | 是 |
| 三通道「只有蓝通道=2」（灰度后≈0） | 0 / 0 / 0.00 | 是 |
| 三通道均值 2、σ=1.0 的暗噪声 | 1.52 / 5 / 0.71 | 否 |

**量化结论（这就是验收要的那条边界）**：要让一个**暗**帧被判成空帧，它必须**同时**满足「最亮像素 ≤ 4」和「标准差 < 0.05 灰阶」——在 8 位图像里后者意味着**超过 99.75% 的像素与其余像素完全相同**（只有一个灰阶的差就够把它顶出去）。任何真实传感器都有读出噪声（这台机器的真实首帧实测 `std 13.4`），所以「房间很暗 / 镜头被挡」**不会**被误报为「摄像头不可用」。✓

---

## 3. `FrameGrabber` 跳空帧与 `CameraUnavailable` 的触发条件

### 3.1 我读到的代码（`camera.py` 的 `open()`）

```
while True:
    ok, candidate = capture.read()
    if not ok: candidate = None
    if candidate is None:                      # 读不到帧
        if attempts >= warmup_frames or now >= warmup_deadline: break
        continue
    if is_blank_frame(candidate) and now < warmup_deadline:   # 窗口内的空帧 → 跳过
        blank_frames += 1
        continue
    frame = candidate                          # ← 窗口一过，空帧也在这里被接受
    break
if frame is None:                              # ← 只有「一帧都没拿到」才抛
    raise CameraUnavailable("摄像头已打开，但读不到可用的第一帧：驱动连续回传空帧（全 0 或单色）…")
```

### 3.2 用假 `cv2.VideoCapture` 逐条验

| 场景 | 文档/预期 | 实测 |
|---|---|---|
| 2a `[空, 空, 真]`，窗口 1.5s | 跳过空帧、接受真帧 | ✓ `blank_frames_skipped=2`，首帧 `std=16.7` |
| **2b 全是可读的空帧**（500 帧全 0），窗口 0.3s | 文档：抛 `CameraUnavailable` + exit 2 | ✗ **没有抛**：接受的就是空帧（`max=0, std=0.00`），`blank_frames_skipped=270` |
| 2c `read()` 一直失败 | 抛 `CameraUnavailable` + 中文 + 提示 `--probe-frames` | ✓ 正是这句话在这里抛出 |
| 2d 窗口=0（`--camera-blank-timeout 0`）+ 空帧 | 不跳帧 | ✓ 首帧就是空帧、`blank_frames_skipped=0`（说明「跳过」就是那个窗口） |
| 2e 首帧即真画面 | 不跳帧 | ✓ `blank_frames_skipped=0` |

### 3.3 真机复现（这台机器现在的状态）

```
python -m perception_edge.run --probe-frames 3        → exit 0，3 帧全 blank
   probe_frame: mean 0.0 / max 0 / std 0.0 / blank true   （三帧都是）
   probe_summary: camera.first_frame_ms 1612.3、blank_frames_skipped 11、usable_ratio 0.0
   verdict: 「每一帧都是空帧（全 0 或单色）：驱动没有把画面交出来」
python -m perception_edge.run --seconds 3（检测路径，未加 --append，事件只打 stdout）→ exit 0
   event: presence.changed present=false confidence 0.85
          source_detail "... reason=camera_started"   ← 记录了「看过，没人」
   frame 0..2: motion false / motion_ratio 0.0 / faces 0 / signal false / state absent
   summary: frames 3, final_state absent, counters.blanks_since_change 3,
            camera.blank_frames_skipped 11, frames_with_evidence 0
```

也就是说：**当前这台机器「一帧真画面都拿不到」，而检测路径既没有抛 `CameraUnavailable`、也没有非零退出，而是照常输出 `present=false`（「房间里没人」）**——正是 t99 文档说已经不会发生的那件事。可用的区分手段只剩 `camera.blank_frames_skipped`、`movement_evidence` 与 `--probe-frames`（都是「要人会看」的信息，不是失败）。

**F1（medium，文档与代码不符，且我这台机器当场命中）**
- **位置**：`docs/design/perception.md` §8.5「全是空帧时的行为」那一行（本次核对时在第 391 行附近，引用请用命令 `git grep -n "全是空帧" -- docs/design/perception.md`）、§9 已知风险第 4 条（`git grep -n "如果整段窗口都是空帧" -- docs/design/perception.md`），以及 t99 的完成回报（「整段窗口全空则明确报 CameraUnavailable + 中文说明（exit 2），不再把黑帧当『画面里没人』」）。
- **问题**：`CameraUnavailable` 的实际触发条件是「**一帧都读不到**」（`capture.read()` 失败）；对于「读得到但恒定的空帧」，窗口一过就会**接受**该帧，检测继续。文档三处写的是「整段窗口全是空帧 → 抛 + exit 2」，在这台机器的真实症状（可读的空帧）下不成立。
- **requiredFix（二者取一，建议都做）**：① **代码**：窗口结束后若拿到的那帧仍是空帧，就按现有中文消息抛 `CameraUnavailable`（这样才与文档一致）；或 ② **文档**：把三处改成真实触发条件——「只有**读不到帧**时才抛；驱动持续回传**可读**空帧时，窗口结束后会接受第一帧并把 `blank_frames_skipped` 记下来，检测会照常跑出 `present=false`，需靠 `movement_evidence` / `--probe-frames` 区分」，并同步 §9 风险第 4 条。若选 ②，请同时在 `open()` 的注释里写明这不是「失败」而是「有记录的可疑成功」。

---

## 4. `movement_evidence` 能不能区分「空帧」与「房间没人」

- **它自己分不出来，文档也没说它能**：空帧与空房间在运动判据下都是 `motion_ratio = 0`（我看到检测输出里 `motion false / motion_ratio 0.0 / signal false`，`frames_with_evidence 0`）；代码里 `movementEvidence` 的两条分支正是这么写的——有信号 → 「这次的『无人』是看过画面的结论」，无信号 → 「可能是房间真的没人，**也可能是驱动回传空帧/纯色帧**，要区分请先跑 `--probe-frames`」。`verify-camera-presence.ts` 在 `frames_with_signal=0` 时还会额外打印那条命令。
- **所以验收问的「真能区分」应理解为「把用户指向能区分的那条命令」**：这一点成立 ✓（文案、字段、提示都在）。但要注意 **F1 削弱了这条防线的作用**：在「全空帧」这一档，`open()` 不抛错，用户看到的是「一次正常的、没人的运行」+ 一条提示，而不是一次明确失败；也就是说 `movement_evidence` 在这里是**唯一**的线索（见 O1 的建议）。

---

## 5. 文档与代码逐条对读（数得上的都对）

| 文档写的 | 代码里 | 判定 |
|---|---|---|
| 判据：`max ≤ 4 且 std < 0.05` | `BLANK_MAX_LUMA = 4`、`BLANK_MAX_STD = 0.05`、`is_blank_frame` 同时要求两者 | ✓ |
| 跳过窗口默认 1.5 秒，`--camera-blank-timeout` 可调 | `CameraConfig.blank_frame_timeout_s = 1.5`；`RunConfig.camera_blank_timeout` 默认 1.5；`--camera-blank-timeout` 在 `--help` 里（实测帮助文本一致） | ✓ |
| `--probe-frames N` 只诊断：逐帧 `mean/min/max/std` + 中文结论、不检测/不写库/不写图 | `probe_camera_frames()` 逐帧打印 `probe_frame`，最后 `probe_summary` + 中文 `结论/建议`；`privacy.frames_written_to_disk = 0`；实跑 `--probe-frames 3` → exit 0、**privacy 自报 0 个图像文件** | ✓（退出码见 O1） |
| 丢掉的帧数进 `camera.blank_frames_skipped` | `FrameStats.blank_frames_skipped`，`summary()` 里带上；实跑 `--probe-frames 3` 看到 `11` | ✓ |
| 「全是空帧时的行为：抛 CameraUnavailable（exit 2）」 | 只有 read 失败才抛 | ✗ **F1** |
| 用户该检查什么（遮挡 / 隐私快门 / 快捷键 / 拔插 / 开灯对比 max） | 与实现一致（`advice` 文案、`--probe-frames` 的 `usable_ratio`/`brightest` 分支） | ✓ |

---

## 6. 门禁

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | HEAD `9debdca`；在途是 t103 的 `scripts/field-test.ts` + `tests/console/{look-once-console.test.ts（改）,camera-problem-console.test.ts（新）,live-camera-fixture.ts（新）}` | **235 tests / 235 pass / 0 fail / 0 skipped，exit 0** |
| `npm run check:docs` | 同上 | 检查了 **70 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 71 份 / 0 问题 / exit 0） |

---

## 7. 观测（与 F1 一起附上）

- **O1（低，自查命令的退出码）**：`probe_camera_frames()` **总是 `return 0`**，即使 `usable_ratio = 0.0`、结论是「驱动没有把画面交出来」。用户手动看没问题，但脚本化（例如 CI 或一键验收）无法用它判断摄像头是否可用。建议：`usable_ratio == 0`（或 `not readings`）时返回非零（比如 1），并在文档里写上退出码语义。
- **O2（低，判据的假阴性边界）**：`max <= 4` 的上界是按这台驱动的实测（0–1）定的；一个「恒定 5」的缓冲不会被判成空帧，会被当成一帧（很暗的）画面。今天不影响（真实帧有噪声、`movement_evidence` 会提示），但若以后换驱动，建议把这条记在 `BLANK_MAX_LUMA` 的注释里（现在注释只给了实测分离依据）。
- **O3（信息，我这次没写共用台账）**：为了不污染 `data/perception/field-test.sqlite`，我本来想用临时库跑检测路径，但 `run.py` 的 `--db` **需要配合 `--append`**（否则 `emit.appended_to_db = 0`，只打 stdout）；所以我用的是「不加 `--append`、只读 stdout」的方式。收尾时共用台账是 9 条 `presence.changed`（第 7–9 条是 19:01–19:02 别人跑出来的），**我 19:12:55 那条不在里面** ✓。

---

## 8. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `python data/rev-tmp/t104-probe.py`（**我自写**：13 个夹具 + 5 个假 capture 场景，22 项断言） | 21 项通过；唯一「失败」就是 F1 的证据（2b：全空帧不抛异常） |
| `python -m perception_edge.run --probe-frames 3`（文档 §8.5 的自查命令，真摄像头只读） | exit 0 / 3729 ms；3 帧全 `mean 0, max 0, std 0.0, blank true`；`blank_frames_skipped 11`、`usable_ratio 0.0`、verdict「每一帧都是空帧…驱动没有把画面交出来」；`privacy.frames_written_to_disk 0` |
| `python -m perception_edge.run --seconds 3`（检测路径，不加 `--append`，事件只打 stdout） | **exit 0**；`presence.changed present=false reason=camera_started`；3 帧 `motion_ratio 0.0 / signal false`；`frames_with_evidence 0`、`blanks_since_change 3`、`blank_frames_skipped 11` → **F1 的真机证据** |
| `python -m perception_edge.run --help` | 列出 `--probe-frames N` 与 `--camera-blank-timeout`（默认 1.5 秒），与文档一致 |
| `git grep -n -e BLANK_MAX_LUMA -e BLANK_MAX_STD -e blank_frame_timeout_s -- services/perception-edge/perception_edge/{camera,run}.py` | 常量与默认值（§5 的表格） |
| `node data/rev-tmp/t104-dbcheck.mjs` / `t97-ledger.mjs` | 临时库未生成（`--db` 需 `--append`）；共用台账 9 条，**不含**我 19:12:55 那条（O3） |
| `npm test` / `npm run check:docs` | 235/235 exit 0；70 份 0 问题 exit 0 |

---

## 9. 我做过的真实外部动作

**0 次 API 调用**。按验收与文档明文要求**打开了真实摄像头**：一次 `--probe-frames 3`（只诊断，不写库、不写图、不上传，privacy 自报 `frames_written_to_disk 0`）与一次检测路径 `--seconds 3`（**未加 `--append`，事件只打 stdout**，共用台账一条未加）。**未写任何图像文件、未上传任何画面**；假 capture 那部分完全不碰硬件。**未改动任何他人的文件**：唯一写入产物是本文件；探针脚本留在 `data/rev-tmp/`（`t104-probe.py`、`t104-probe.out.txt`、`t104-dbcheck.mjs`，`data/` 已 gitignore，非交付物）。基线修订 `9debdca`（被评交付点 `e0c3c17`）。
