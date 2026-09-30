# 复审：「拿到空帧」与「读不到帧」是否都按文档抛 CameraUnavailable（t106 / round-2）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t99 的排查与本轮 t106 的修补）
> 评审对象：`cae1e08`「t106 完成：拿到空帧也抛 CameraUnavailable（并更正 t99 的一处说法）」（`perception_edge/camera.py`、`perception_edge/run.py`、`docs/design/perception.md`，共 +88 / −39）
> 复核方式：**自写假 `cv2.VideoCapture` 探针 13 项全过**（构造「持续回传可读空帧」「读不到帧」「暗但有噪声」三类流）+ **真机两次只读实跑**（当前状态、以及无可用摄像头的失败路径）+ 文档三处触发条件逐条对代码
> 时序：判读时 HEAD `5bbf5a3`；工作区在途是 t109/t110 对 `perception.md`、`verify-camera-presence.ts`、`run.py` 的改动（与本次复核对象无关，`camera.py` 自 `cae1e08` 起未再变）

---

## 1. 结论

**verdict：pass（无 finding；4 条观测在 §5）**

一句话：**t104 的 F1 被真正修掉了**——t106 之后，「驱动持续回传**可读**空帧」与「读不到帧」**都**会抛 `CameraUnavailable`，消息是中文并指向自查命令；而「暗但有噪声的真实画面」照旧被接受（不会把暗房间误报成故障），窗口内先空后真的情形也没有被改坏（仍然接受真帧、`blank_frames_skipped=2`）。文档 §8.5 的触发条件表（读不到帧 / 持续回传可读空帧 / 暗但有噪声，外加诊断模式例外）与 §9 风险第 4 条**逐条与代码一致**，`--probe-frames` 的退出码契约（有画面 0、一帧都没有 2）也在代码与真机两端都对上了。

**一条必须说清楚的前提更正**：验收里写「本机驱动当前正是这个状态（空帧）」，但**我判读时它已经恢复**——`--probe-frames 3` 实测 3 帧全部 `blank=false`、`mean 141.8`、`max 253`、`std 30.7`、`usable_ratio 1.0`、`blank_frames_skipped 0`、40.1 fps、**exit 0**。所以「持续回传可读空帧」这一半我是在**假 capture** 上复现的（正是验收要求的那条做法），真机上我验证的是**两端**：有画面 → exit 0；无可用摄像头 → **exit 2 + 中文**。这不是 t106 的问题——它自己就如实披露了「驱动在任务期间自己恢复」，并把这件事写进了文档（§8.5 那行「这个状态会自己结束」、§9 风险 4）。

| 任务验收条款 | 我的判定 | 依据 |
|---|---|---|
| 1 给出明确 verdict；needs_revision 必须给出可执行 findings | **pass（无 finding）** | §2–§4 |
| 2 用假 `cv2.VideoCapture` 构造「持续回传可读空帧」，确认现在确实抛 `CameraUnavailable` 且消息为中文；并在真机复现一次；确认文档三处触发条件与代码一致 | **满足（真机前提已更正，见上）** | §2（13/13）、§3（真机两端）、§4（文档三处） |
| 3 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/` | **满足** | §6：`npm test` **235/235 pass / 0 fail / exit 0**；`check:docs` **73 份 / 0 问题 / exit 0** |

---

## 2. 假 capture：三类流的行为（我自写探针，13/13）

| 我构造的流 | 期望（文档） | 实测 |
|---|---|---|
| **恒定 0**（YUY2/I420 的实测空帧） | 抛 `CameraUnavailable` | ✓ 抛；消息：「摄像头已打开，但拿不到可用的画面：驱动连续回传空帧（全 0 或单色）。先用 python -m perception_edge.run --probe-frames 10 看逐帧亮度…」 |
| **恒定 1**（MJPG 的实测空帧） | 抛 | ✓ 抛（同上消息） |
| **恒定 4**（判据上边界） | 抛 | ✓ 抛 |
| **`read()` 一直失败** | 抛 | ✓ 抛（同一句中文消息；两半都走 `frame is None` 那条） |
| **暗但有噪声**（`mean 3`、`max 8`、`std 1.22`） | 接受 | ✓ 接受（`is_blank_frame=false`） |
| **正常画面**（`mean ~60`、`std 16.7`） | 接受 | ✓ 接受 |
| **恒定 5**（刚过 `max ≤ 4`） | 文档标注为**假阴性**：被当画面 | ✓ 接受（`blank=false`）——与文档一致，不是通过项 |
| **诊断模式**（`require_usable_first_frame=False`）+ 全空 | 故意接受空帧，好让 `--probe-frames` 能观测 | ✓ 接受（首帧 `max=0`） |
| **[空, 空, 真]** | 接受真帧 | ✓ 接受真帧，`blank_frames_skipped=2` |

另外两条断言：**消息是中文且提到 `--probe-frames`** ✓；**旧文案「读不到可用的第一帧」已不再出现**（t106 把它改成「拿不到可用的画面」，两半共用一句）✓。`CameraConfig().require_usable_first_frame` 默认 `True` ✓（检测路径不会放行空帧）。

---

## 3. 真机两次只读实跑（说明为什么这一半是假 capture 复现的）

| 我跑的 | 结果 |
|---|---|
| `python -m perception_edge.run --probe-frames 3`（真摄像头） | **exit 0**；3 帧全 `blank=false`、`mean 141.76–141.86`、`max 253`、`std 30.65–30.70`、`usable_ratio 1.0`、`blank_frames_skipped 0`、40.1 fps；verdict「画面正常有内容（最亮像素 253），摄像头可用」→ **驱动已恢复**（`t106` 披露的状态） |
| `python -m perception_edge.run --probe-frames 3 --camera-index -1`（无可用摄像头） | **exit 2** + 中文「摄像头不可用：打不开摄像头 index=-1 backend=CAP_DSHOW：设备不存在、被别的程序占用，或 Windows 隐私设置里禁止了摄像头…」 |

也就是说：退出码契约的两端（**有画面 → 0**、**没有可用摄像头 → 2**）我在真机上各验了一次；而「读得出来但全是空帧」这一档，真机此刻已经**不是**那个状态，无法当场复现——我用假 capture 把它构造出来了（§2 前三行），这正是验收要求的做法。**如实记下这个前提更正，避免后人以为「真机复现过」**。

---

## 4. 文档三处触发条件与代码逐条对读

| 文档（`cae1e08` §8.5 的表 + §9 风险 4） | 代码 | 判定 |
|---|---|---|
| 「**读不到帧**：`capture.read()` 一直返回 `False`（或拿到 `None`）达到 `warmup_frames`／`blank_frame_timeout_s`」→ 抛 `CameraUnavailable`（中文），exit 2 | `camera.py` 循环里 `candidate is None` → 满足 `attempts >= warmup_frames` 或过了窗口就 `break`（`frame` 仍为 `None`）→ 末尾那条 `if frame is None or (require_usable_first_frame and is_blank_frame(frame)): raise …` | ✓ 一致；`run.py` 捕获后 `return 2` |
| 「**持续回传可读空帧**：帧读得出来但都是恒定值（`max ≤ 4` 且 `std < 0.05`），且**跳帧窗口用完了**仍是空帧」→ 同样抛，且丢弃帧数记进 `blank_frames_skipped` | `if self.config.require_usable_first_frame and is_blank_frame(candidate): blank_frames += 1; if now >= warmup_deadline: break; continue` → 末尾同一条 raise；成功路径写 `stats.blank_frames_skipped = blank_frames` | ✓ 一致（窗口语义正是「找一帧可用的时间预算」，不是「过点就算数」） |
| 「**暗但有噪声的真实画面**（例如 `mean 3`、`max 12`、`std 1.2`）」→ **接受**，检测照常跑 | `is_blank_frame` 要求 `max ≤ 4` **且** `std < 0.05`，噪声帧两条都不满足 | ✓ 一致（我实测 `max 8 / std 1.22` 被接受） |
| 「**诊断模式例外**：`--probe-frames` 故意接受空帧（`require_usable_first_frame=False`）；**退出码承担判定：有至少一帧可用 → 0，一帧都没有 → 2**」 | `run.py` probe 路径构造 `CameraConfig(..., require_usable_first_frame=False)`；末尾 `return 0 if usable else 2` | ✓ 一致，代码就在 `run.py:554` |
| §9 风险第 4 条：空帧会让 `open()` 抛 `CameraUnavailable` + 中文（exit 2），不再当「画面里没有人」；`blank_frames_skipped` 记录丢弃数 | 同 §8.5 的两条 raise 分支 + `FrameStats.blank_frames_skipped` | ✓ 一致 |
| 顺带核到：假阴性（恒定 > 4 的缓冲会被当画面）**文档已标注**，并指向 `camera.py` 里 `BLANK_MAX_LUMA` 的注释 | 注释重写过：写明数值来历（真画面 `max 84`/`mean 14–31`/`std 13.4`；空帧 `max 0–1`/`std 0.00`）、上界是**选定值**、假阴性风险与三条缓解（只对完全恒定的帧生效；`--probe-frames`/`movement_evidence` 能发现；可调） | ✓ 一致 |

---

## 5. 观测（都不改变 verdict）

- **O1（信息，验收前提需更正）**：验收写「本机驱动当前正是这个状态」，但我判读时**驱动已恢复**（§3 第一行的时间戳证据）。t106 已披露并把它写进文档（「这个状态会自己结束」），所以这不是缺陷；但它提醒后来者：**这条路径的「真机复现」只能在驱动恰好坏着的时候做**，平时要靠假 capture 或合成流。
- **O2（低，已知假阴性）**：恒定 > 4 的缓冲仍会被当成画面（我实测恒定 5 → 接受）。文档已把它写成「选定的上界 + 假阴性 + 三条缓解」，与代码一致；不构成失实，保留即可。
- **O3（信息，与本次结论无关但在途）**：工作区的 `perception.md` 正在加 `source_detail` 的 `mode=camera|synthetic` 标记（t109）——正好收我 t101 的 O1（台账来源不再靠猜）。读文档的人会遇到「旧行没有这个标记」的情况，t109 的正文里已写「在这条落地之前…」，方向是对的。
- **O4（信息，正面）**：t106 那两条「顺带观测」我都独立核过——`run.py` 的 probe 退出码是 `return 0 if usable else 2` ✓；`BLANK_MAX_LUMA` 的注释重写后数值来历与假阴性说明齐全 ✓。

---

## 6. 门禁

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | HEAD `5bbf5a3`；在途是 t109/t110 的 `docs/design/perception.md`、`scripts/verify-camera-presence.ts`、`services/perception-edge/perception_edge/run.py` | **235 tests / 235 pass / 0 fail / 0 skipped，exit 0** |
| `npm run check:docs` | 同上 | 检查了 **73 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 74 份 / 0 问题 / exit 0） |

**复核时点**：上表在 `5bbf5a3` 跑过一次；t109 落地（`bbf2476`，工作区已干净）后我又各跑一次，数字**完全相同**：`npm test` 235/235 exit 0、`check:docs` 74 份 0 问题 exit 0。

---

## 7. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `python data/rev-tmp/t107-probe.py`（**我自写**：假 `cv2.VideoCapture` × 9 种流，13 项断言） | **13/13 通过**（§2 的全部原始值；三类空帧都抛、两类真实画面都接受、假阴性与诊断模式例外与文档一致） |
| `python -m perception_edge.run --probe-frames 3`（真机，只诊断） | exit 0；3 帧 `blank=false`、`mean 141.8`、`max 253`、`std 30.7`、`usable_ratio 1.0`、`blank_frames_skipped 0`、40.1 fps（§3） |
| `python -m perception_edge.run --probe-frames 3 --camera-index -1`（真机失败路径） | **exit 2** + 中文「摄像头不可用：打不开摄像头 index=-1…」（§3） |
| `git show cae1e08:docs/design/perception.md`（三处触发条件、§9 风险 4、假阴性标注） | 与 `camera.py` / `run.py` 逐条一致（§4） |
| `git grep -n -e CameraUnavailable -e "return 2" -e "require_usable_first_frame" -- services/perception-edge/perception_edge/{camera,run}.py` | `camera.py` 两条 raise 分支 + `require_usable_first_frame`；`run.py:554 return 0 if usable else 2`、捕获后 `return 2`（§4） |
| `npm test` / `npm run check:docs` | 235/235 exit 0；73 份 0 问题 exit 0 |

---

## 8. 我做过的真实外部动作

**0 次 API 调用**。打开真实摄像头**两次**（都是 `--probe-frames` 只诊断模式：一次正常索引拿到画面、一次 `-1` 必然失败），**未写库、未写图、未上传**（probe 自报 `frames_written_to_disk 0`、`network_clients 0`），**共用台账一条未加**。假 capture 部分完全不碰硬件。**未改动任何他人的文件**；唯一写入产物是本文件；探针脚本与输出留在 `data/rev-tmp/`（`t107-probe.py`、`t107-probe.out.txt`、`t107-live.txt`，`data/` 已 gitignore，非交付物）。基线修订 `5bbf5a3`（工作时 HEAD；被评交付点 `cae1e08`）。
