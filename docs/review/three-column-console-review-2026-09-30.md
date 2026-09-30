# 评审：三栏界面与一键启用（t78，含隐私与子进程）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t70 常驻循环、t74 内容生成与 t78 的改动）
> 评审对象：`639f11e`「t78 完成：三栏测试界面 + 一键启用 + 摄像头实时画面（真机验证）」（`scripts/field-test.ts`、`scripts/serve-chat.ts`、`scripts/verify-camera-presence.ts`、`services/perception-edge/perception_edge/run.py`、`tests/console/` 三个文件）
> 复核方式：**真机实跑**——起真控制台、POST 启用、抓真子进程命令行、真摄像头出帧、停用后查 PID 是否消失；另用自写的两版源码比对脚本核对门禁代码；全程**0 次 API 调用**
> 时序：开工时 `git status` **干净**、HEAD = `639f11e`；全程没有他人在途改动干扰判读（本轮判读前 `git status` 仍为空）

---

## 1. 结论

**verdict：pass（无 blocking finding；5 条观测在 §6，其中两条是措辞/覆盖面问题，另三条是信息）**

一句话：**「一键启用」不是 UI 幻觉**——POST `start` 之后真的出现了 `python.exe -m perception_edge.run --live …` 的子进程（我用 `Get-CimInstance Win32_Process` 抓到它的完整命令行与 PID 13688），常驻循环**当场 `ticks=1`**（先 tick 一次），真摄像头开始出帧（480×360 / 9 KB / 带画面 data URL），停用后 3 秒内 `exited=true`、`Get-Process` 找不到该 PID、系统里没有残留的 perception python 进程；两个曾经 500 的端点现在都是 **200**。隐私我按验收重跑了一次 `--live --seconds 8`：60 帧全带画面、presence 事件照常落库，而 `data/` 下图像文件 **4 → 4 不变**（我另外扫了整仓与 `%TEMP%` 近 15 分钟的新图像，同样 0）。门禁**没有被放宽**：t78 一行都没碰 `packages/`，`scripts/field-test.ts` 里与门禁有关的四块代码三块逐字节相同、`#consider` 只差一行 **TTS 接缝**（`synthesizeProvider?.() ?? synthesize`），主动路径仍然只有「引擎 `consider` → 放行后才 `deliver`」这一条。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 独立核对三件事：① 三栏与一键启用行为（start 起子进程并先 tick、stop 后子进程真退出、两个端点不再 500）；② 隐私（重跑 `--live --seconds 8`、`data/` 图像数不变、子进程不落盘）；③ 门禁未放宽（仍是同一条 `ProactiveEngine.consider`） | **真正满足** | §2 ①、§3 ②、§4 ③（含真机原始输出） |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果（判读前先看 git status）；结论落 `docs/review/` | **满足** | §5：判读前 `git status` 为空、HEAD `639f11e`；`npm test` **209 / 209 pass / 0 fail / exit 0**；`check:docs` 61 份 / 0 问题 / exit 0 |

---

## 2. ① 三栏与「一键启用」的行为（真机）

### 2.1 三栏页面（HTTP 200 时抓下来的就是浏览器会执行的那份）

起控制台 `node scripts/field-test.ts --offline --no-open --data-dir %TEMP%\t80-page --port 8896` → `GET /` **HTTP 200 / 56022 字节**，下列标记全部命中：
`id="col-sensors"`、`id="col-config"`、`id="col-conversation"`、`id="px-enable"`、`id="px-disable"`、`id="px-cam"`（实时画面 `<img>`）、`id="px-camera-switch"`、`id="px-loop-interval"`、`px-talkativeness`、`px-verbosity`、`主动开口`、`已启用`/`未启用`、`不写文件、不上传、不落盘`，以及 <1200px 时堆叠的媒体查询。

### 2.2 启用：真的起了子进程，而且先 tick 一次

| 步骤 | 原始结果 |
|---|---|
| 启用前 `GET /api/field/live` | `status.running=false`、`child.running=false`、`child.pid=null`、`loop.running=false`、`loop.ticks=0`、`frames=0` |
| `POST /api/field/live {"action":"start","cameraIndex":0,"intervalMs":30000}` | `status.running=true`、**`child.running=true`、`child.pid=13688`**、`source=camera`、**`loop.running=true`、`loop.ticks=1`**、`loop.intervalMs=30000`；响应里带 `privacy` 声明 |
| 子进程是不是真的（不是显示字段） | `Get-CimInstance Win32_Process -Filter "ProcessId = 13688"` → `Name=python.exe`，`CommandLine=E:\worker2\.venvs\cv4\Scripts\python.exe -m perception_edge.run --live --source camera --camera-index 0 --db C:\Users\zz\AppData\Local\Temp\t80-presence\xixi.sqlite --append --quiet-frames`，父进程就是控制台 |
| 5 秒后再看 | `frames=104`、`presenceEvents=2`、`lastFrame: index=103 present=true confidence=0.75 480x360 jpegBytes=9075 hasPicture=true`，`frame.dataUrl` 以 `data:image/jpeg;base64,/9j/4AAQ…` 开头（画面确实到了页面数据里） |
| 帧率对不对 | 验收脚本那次 `--live --seconds 8` 收到 **60 帧 / 8 秒 = 7.5 fps**，与 `--live-fps` 默认 8 的节流一致（`run.py` 里 `pace_fps` 真的 sleep） |

### 2.3 停用：子进程真的退出

`POST {"action":"stop"}` → `status.running=false`、`child.running=false`、`loop.running=false`；3 秒后 `child.exited=true`、`child.exitCode=null`（被 kill）、`frames` 停在 179、`child.pid=null`；`Get-Process -Id 13688` **找不到该进程**；收尾再查一次系统里带 `perception_edge` 的 `python.exe` → **0 个残留**。控制台自己也把两个临时库目录关上（只剩 `.sqlite` / `-wal` / `-shm`）。

### 2.4 两个曾经 500 的端点

| 端点 | 我拿到 |
|---|---|
| `GET /api/field/proactive/loop?cursor=0` | **HTTP 200**（2189 字节，是 JSON 而不是错误页） |
| `POST /api/field/proactive/drill {"trigger":"presence_arrived"}` | **HTTP 200**（753156 字节），`ok=true`、`reasonCode=PASSED`、`score=0.62 ≥ threshold=0.495`（0.495 = 0.45 + 0.30 × (1 − 0.85)，与现行出厂 `proactivity=0.85` 自洽）→ t77/t79 报告里那两条 `ReferenceError: loopSynthesize is not defined` 已经被 t78 修掉 |

---

## 3. ② 隐私：重跑 `--live`，`data/` 下图像文件数不变

我先把基线扫出来（自己写的小脚本 `data/rev-tmp/t80-images.mjs`，按扩展名递归清点）：

```
图像类文件数量 = 4（根目录 data）
  data\models\largest_selfie.jpg (1147146 字节)          ← 模型自查图
  data\models\lena.jpg (91814 字节)                      ← 模型自查图
  data\recon\camera-frame-ANY-0.png (243672 字节)        ← T0 勘测抓帧（10:50，历史）
  data\recon\camera-frame-DSHOW-0.png (244330 字节)      ← T0 勘测抓帧（10:50，历史）
```

然后按验收要求**原样重跑**（真摄像头，8 秒）：

```
node scripts/verify-camera-presence.ts --live --seconds 8
  → 实时模式（--live）结果：收到 60 帧，其中 60 帧带画面，平均 9 KB/帧，
    presence 事件落库 2 条，磁盘上的图像文件 0 个（必须是 0）。
  → 实时模式 OK：画面能到页面、事件照常落库、磁盘上没有图像文件。
  → exit 0
```

跑完再扫一遍：`data/` 图像文件 **仍然是 4 个**（逐条同名同字节，没有一个是新的）。为了让「不落盘」不只是一句自述，我又做了两次**独立**扫描：

- 整仓（排除 `node_modules`）**近 15 分钟内被写过的** `.png/.jpg/.jpeg/.bmp/.webp` → **0 个**；
- `%TEMP%` 下近 15 分钟的图像 → **0 个**；
- 控制台那条路径的临时目录（`%TEMP%\t80-presence`、`%TEMP%\t80-console`）里只有 `xixi.sqlite` 与它的 `-wal/-shm`，**没有任何图像文件**。

也就是说：**画面只经内存 → stdout base64 → 页面 data URL** 这条口径，在我自己独立的三处扫描下都成立（详见 §6 的 O1：其中一处「自报」的措辞并不准确，但事实成立）。

---

## 4. ③ 门禁没有被放宽（仍是同一条 `ProactiveEngine.consider`）

我用了两条互相独立的证据链：

**（a）改动范围**：`git diff --stat d4d71aa..639f11e` 正好是 t78 声明的 7 个文件；其中 `git diff --stat d4d71aa..639f11e -- packages` **为空**——门禁实现所在的 `packages/conversation` 一行未动（这与 §6 的 O5 一致：主动开口仍然只由 `ProactiveEngine.consider` 判定）。

**（b）把「门禁相关的代码块」逐字节比对**（我自写 `data/rev-tmp/t80-gates.mjs` + `t80-consider-diff.mjs`，把 t78 之前的 `scripts/field-test.ts` 导出后按标记切块比较）：

| 区域 | 结果 |
|---|---|
| `buildProactiveCandidates`（触发源与 §15.4 分量） | **两版逐字节相同** |
| `triggerScoreCeiling`（proactivity=1.0 下每个源能否过线） | **两版逐字节相同** |
| `proactiveDrill`（演练走的九道门禁） | **两版逐字节相同** |
| `#consider`（循环唯一的门禁调用点） | 只差 **一行**：新增 `const synthesize = this.#options.synthesizeProvider?.() ?? this.#options.synthesize;` 并在后面用它 —— 那是**朗读开关的运行时解析**（t78 自己的披露 (a)），与门禁判定无关；`engine.consider({…})` 的入参与 `deliver` 的调用时机一行没动 |

**（c）没有第二条发声路径**：全仓只有两处 `new ProactiveEngine(...).consider(...)`（演练、循环），而写「主动开口」的 assistant 轮次只有一处 `recordTurn({… source: 'proactive'})`，它在 `#consider` 里、**在 `engine.consider` 返回之后**。

**（d）行为回归**：把我在 t79 写的门禁行为探针**原样**在 t78 的 HEAD 上重跑 → `t79-probe.mjs` **33/33 通过**、`t79-probe2.mjs` **6/6 通过**（被拦时生成 0 次、阈值地板 0.45、五个源全部过线、演练音频与不重复都在）。t78 的改动没有让任何一条门禁行为变样。

---

## 5. 门禁（我这一轮是全绿的）

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | `git status` **为空**、HEAD `639f11e`（无他人在途改动） | **209 tests / 209 pass / 0 fail / 0 skipped，exit 0** |
| `npm run check:docs` | 同上 | 检查了 **61 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 62 份 / 0 问题 / exit 0） |

这与 t78 自述的「209/209 全绿」一致——本轮没有出现前面几轮那种「别人的在途半成品把全队门禁染红」的情况。

---

## 6. 观测（都不改变 verdict）

- **O1（低，措辞与证据强度）**：t78 的回报里写「子进程 `frames_written_to_disk: 0`」。我读了 `run.py`：`live_summary` 只报 `frames_emitted` / `frames_skipped`，**并没有**这个字段；「0 个图像文件」是 `scripts/verify-camera-presence.ts` **自己扫描**目录得出的。也就是说，**事实成立（我独立扫了三处都是 0），但这句「子进程自报」不成立**——引用它当证据的人会高估证据强度。建议二选一：要么在 `live_summary` 里真的加上 `images_written: 0`（那才是自报），要么把措辞改成「子进程只把 JPEG 写进 stdout；验证脚本扫描目录得到 0 个图像文件」。
- **O2（低，措辞覆盖范围）**：`--live` 的结论行写「磁盘上的图像文件 0 个」，但扫描范围只是 `dirname(dbPath)`（默认 `data/perception/`）。今天成立（我扫了整仓和 `%TEMP%` 都是 0 新增），但读者容易读成「全盘」。建议把那句话的**范围**写进去。
- **O3（信息，停止语义）**：停用是「先关 stdin 再 SIGTERM」，Windows 上被杀的子进程报 exit 1，脚本按 AGENTS §3 把它当**正常停止**（代码里有注释）。我实测 stop 后 `exited=true`、PID 消失、无残留进程——这条口径是对的，只是「exit 1 = 正常」这个约定值得让更多人知道（否则会误报成失败）。
- **O4（信息，隐私口径的准确含义）**：这次隐私验收的准确含义是「**不留图像**」，不是「不写库」——`--live` 会往 `data/perception/field-test.sqlite` 写 presence 事件（我这次落了 2 条，含 `present=false → true` 的真实转换），控制台的「启用」也会往 `--presence-data-dir` 指向的库写。这正是 M6 的设计（事件才是产品），但页面/文档最好把「不落盘 = 不存图像」说清楚，免得被理解成「什么都不写」。
- **O5（信息，边界）**：控制台的「启用」在摄像头开关关掉时**只启动主动循环、不起子进程**（端点里就是这么分支的），此时「有人到家」这个事实源不存在；页面写了这一点。这属于合理设计，记录以便后续核对「为什么启用后没有画面」。

---

## 7. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node data/rev-tmp/t80-images.mjs data`（**我自写**：递归清点图像类文件） | 跑 `--live` 之前 **4**、之后 **4**，逐条同名同字节（§3） |
| `node scripts/field-test.ts --offline --no-open --data-dir %TEMP%\t80-console --presence-data-dir %TEMP%\t80-presence --port 8895` + `POST /api/field/live start/stop`（含 `Get-CimInstance` 抓命令行） | 子进程 PID 13688 命令行含 `perception_edge.run --live … --append`；`loop.ticks=1`；104 帧后停用，`exited=true`、PID 消失、0 残留（§2.2/§2.3） |
| `GET /api/field/proactive/loop` / `POST /api/field/proactive/drill` | 均 **HTTP 200**；drill `PASSED 0.62 ≥ 0.495`（§2.4） |
| `node scripts/verify-camera-presence.ts --live --seconds 8`（验收指定命令，原样跑） | **exit 0**：60 帧全带画面、9 KB/帧、事件 2 条、图像文件 0 个（§3） |
| 整仓 + `%TEMP%` 近 15 分钟图像扫描 | 0 个新图像文件（§3） |
| `node data/rev-tmp/t80-gates.mjs`（**我自写**：四块门禁代码块逐字节比较） | `buildProactiveCandidates` / `triggerScoreCeiling` / `proactiveDrill` **相同**；`#consider` 差 1 行（TTS 接缝） |
| `node data/rev-tmp/t80-consider-diff.mjs`（**我自写**：把那一行差出来） | 仅 `synthesizeProvider?.() ?? synthesize` 的间接化（§4b） |
| `git diff --stat d4d71aa..639f11e` / `-- packages` | t78 只改 7 个 inScope 文件；`packages/` **空**（§4a） |
| `node data/rev-tmp/t79-probe.mjs` / `t79-probe2.mjs`（t79 的门禁行为探针，原样重跑） | **33/33** 与 **6/6** 通过（§4d） |
| `npm test`（判读前 `git status` 为空） | **209 / 209 pass / 0 fail，exit 0** |
| `npm run check:docs` | 61 份 markdown / 0 问题 / exit 0（含本报告 62 份 / 0 问题 / exit 0） |

---

## 8. 我做过的真实外部动作

**0 次 API 调用**（全程 `--offline` 与替身模型，未花任何费用）。**打开了真实摄像头**（这是本次验收明文要求的）：一次控制台启用 ≈ 179 帧 + 一次 `--live --seconds 8` ≈ 60 帧，画面**只经内存**并经 localhost 给页面；跑完两个控制台都已关闭（8895/8896 无人监听）、**系统里没有残留的 perception python 进程**、我造的临时库目录（`%TEMP%\t80-console`、`t80-presence`、`t80-page`）已全部删除。**未上传任何画面**。`data/` 下图像文件数前后一致（4 → 4）。写入 `data/perception/field-test.sqlite` 的 2 条 presence 事件是 `--live` 验收命令的设计行为（M6 的事件正是产品），已如实记录在 §3/§6-O4。**未改动任何他人的文件**：唯一写入产物是本文件；探针脚本留在 `data/rev-tmp/`（`data/` 已 gitignore，非交付物）。基线修订 `639f11e`。
