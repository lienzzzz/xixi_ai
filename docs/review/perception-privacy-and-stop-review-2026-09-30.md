# 评审：隐私口径证据链与优雅停机（t81）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t78 的直播路径与 t81 的订正）
> 评审对象：`e045be2`「t81 完成：隐私口径写准（不保存图像但写事件）+ 真的加字段 + 优雅停机」（`scripts/field-test.ts`、`scripts/verify-camera-presence.ts`、`services/perception-edge/perception_edge/run.py`、`docs/design/perception.md`）
> 复核方式：**真机实跑 + 我自己的突变实验**——按验收原样跑 `--live`，并在运行中途往扫描范围里放探针图像，看它是否真的抓到；再走停用/再启用一轮验证摄像头释放。全程**0 次 API 调用**
> 时序：开工时 `git status` 只有我上一份评审报告未跟踪、HEAD = `e045be2`；核对期间 t82 在改三个文档（**纯文档、不碰代码**），我的门禁判读不受影响（见 §5）

---

## 1. 结论

**verdict：pass（无 blocking finding；4 条观测在 §6，其中两条是文案/措辞）**

一句话：**t81 把「证据链」这件事补实了**——`images_written` 不再是回报里的一句话，而是 `live_summary` 里由 `run.py` 打出来的字段（我两次干净实跑都看到「子进程 live_summary 自报 images_written=0」），且包内确实没有任何写图调用（唯一的图像调用是内存里的 `cv2.imencode`）；「0 个图像文件」这句话现在会**连扫描范围一起印出来（四处）**，而我用**突变实验**证明它真的走了这四处：运行中途往 `data/`、`%TEMP%`、`data/perception/`、`services/perception-edge/` 放探针 PNG，它每次都把文件连**所属范围**一起点名并判 FAILED（清掉后恢复 exit 0）。优雅停机也是真的：控制台停用后 **exitCode=0**、3 秒内 `exited=true`、PID 消失，**再启用一次摄像头能重新打开并出帧**（23 帧带画面）→ 设备确实被释放，且全程无残留 python 进程。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 独立核对三件事：① 扫描范围说明与实际一致；② `images_written` 字段存在且无写图调用；③ 优雅停机后子进程真退出 + 摄像头可靠释放 | **真正满足** | §2（干净跑 + 两次突变实验）、§3（字段与 grep）、§4（停用/再启用） |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/` | **满足** | §5：`npm test` **209 / 209 pass / 0 fail / exit 0**；`check:docs` **62 份 / 0 问题 / exit 0** |

---

## 2. ① 扫描范围说明与实际一致（干净跑 + 我的突变实验）

### 2.1 干净跑（验收指定的命令，原样）

```
node scripts/verify-camera-presence.ts --live --seconds 6        → exit 0
  实时模式（--live）结果：收到 44 帧，其中 44 帧带画面，平均 8 KB/帧；
  presence 事件落库 1 条（事件照常入库，这是设计）；子进程 live_summary 自报 images_written=0。
  图像文件扫描范围（共 4 处，只看本次运行新建/改动的，命中 0 个，必须是 0）：
    E:\worker2\data\perception；E:\worker2\data；E:\worker2\services\perception-edge；
    C:\Users\zz\AppData\Local\Temp
```

四处位置都是**真实存在**的目录；它们与代码里的数组逐字对应（`git grep -n "scanScopes" -- scripts/verify-camera-presence.ts`）：`dirname(dbPath)`、`REPO_ROOT/data`、`PERCEPTION_DIR`（= `services/perception-edge`）、`tmpdir()`；前三个是递归遍历，临时目录只扫顶层（`walk(scope, scope, scope !== tmpdir())`）。另外它按 `mtime >= 本次运行开始时刻` 过滤，所以 `data/` 里那 4 张**历史**图像（2 张模型自查图 + 2 张 T0 勘测抓帧）不会被误判——干净跑「命中 0」正是这个基线的结果。

### 2.2 突变实验：证明它真的走了这四处（不是只印了名字）

我在**同一条命令里**先起运行、+3 秒时放探针 PNG、跑完看结论（放完立刻删）：

| 实验 | 我放的位置 | 它的结论 |
|---|---|---|
| B | `data\t83-probe.png` + `%TEMP%\t83-probe.png` | **命中 2 个**，stderr `实时模式 FAILED：… E:\worker2\data\t83-probe.png（E:\worker2\data）, C:\…\Temp\t83-probe.png（C:\…\Temp）` |
| C | `data\perception\t83-probe.png` + `services\perception-edge\t83-probe.png` | **命中 3 个**：`…\data\perception\t83-probe.png（E:\worker2\data\perception）`、同一文件又出现在 `（E:\worker2\data）`（说明 `data/` 是**递归**的，一层深也看得到）、`…\services\perception-edge\t83-probe.png（E:\worker2\services\perception-edge）` |

也就是说：**四处范围各自都被真的走过**，命中项还带「它属于哪个范围」，并且**命中就会判 FAILED**（代码里那条分支 `process.exit(1)`）；我删掉探针后再跑一次就恢复 exit 0（§2.1）。

我还顺手验证了**基线过滤**：第一轮我曾把探针放到运行结束之后（时序没掐准），结论是「命中 0」——与「只看本次运行开始之后新建/改动的文件」的写法一致，不是漏扫。

探针文件用完即删：收尾时 `git status` 没有多出任何未跟踪文件（只有我的报告与 t82 在改的文档），我自己按四个范围扫了近 30 分钟内的图像文件 → **四处都是 0 个**，`data/` 图像总数仍是 **4**。

---

## 3. ② `images_written` 字段确实存在，且包里没有写图调用

| 检查 | 结果 |
|---|---|
| 字段在不在 | `run.py` 的 `report()` 里 `live_summary = {type, frames_emitted, frames_skipped, **images_written: 0**, image_sinks: ["stdout:base64-jpeg"], note}`（`git grep -n "images_written" -- services/perception-edge`） |
| 有没有写图调用 | `git grep -n -e imwrite -e VideoWriter -e imsave -e savefig -e tofile -e write_bytes -- services/perception-edge/perception_edge` 只命中 `run.py` 里**注释**中提到的 `imwrite`/`VideoWriter`；真正的图像调用只有一处 `cv2.imencode(".jpg", …)`（内存→base64→stdout） |
| 调用方怎么用它 | `verify-camera-presence.ts` 把 `summary.images_written` 读出来：非 0 就 FAILED；拿不到 summary 就打印「（没等到 live_summary：子进程被强杀或还没打印）」——**不假装**。我两次干净跑都看到「自报 images_written=0」 |
| 文档口径 | `docs/design/perception.md` §7 把「画面不落盘」改成「不保存图像（可核查：无 imwrite/VideoWriter）」并**新增**「会写入事件（这是设计）」一行；§7.1 画了 `--live` 的数据流（画面→stdout→页面；状态转换→`presence.changed` + `world_state`）与停用约定 |

---

## 4. ③ 优雅停机：exitCode、无残留、摄像头可靠释放

真机一轮（控制台 `--offline`，临时库，端口 8897）：

| 步骤 | 原始结果 |
|---|---|
| 启动 → 第一次「启用」 | `pid=15376`、`child.running=true`、`loop.ticks=2`；4 秒后 `frames=30`、`hasPicture=true`、`presenceEvents=2`、`lastNote=''`（没有报错） |
| 「停用」 | `exited=true` 用时约 3.2 秒（轮询粒度 400 ms）、**`exitCode=0`**、`frames` 停在 32；`Get-Process -Id 15376` **找不到** |
| **再启用一次**（关键：摄像头是否被释放） | `pid=18124`、`child.running=true`、4 秒后 **`frames=23`、`hasPicture=true`**、`lastNote=''` ⇒ **同一台摄像机能被再次打开** |
| 再停用 | `exited=true`、**`exitCode=0`**、PID 消失；全局再查 `perception_edge.run` 进程 → **0 个残留** |

`exitCode=0` 说明走的是**优雅路径**（关 stdin → 子进程自己结束循环、打印 `live_summary`、正常退出），不是被 TerminateProcess 杀掉的 exit 1；`--live` 那条 CLI 路径同理：干净跑的输出里能看到「自报 images_written=0」，正说明子进程把汇总打完了才退出。

**一个真实世界的插曲（对我有用，记录在案）**：我这一轮开始时摄像头被**另一个会话**占用（`17:51:55` 起的两个 `perception_edge.run --live … --db E:\worker2\data\xixi.sqlite --append`，一个 cv4 python、一个系统 Python 3.12，父子关系），我的控制台子进程因此 **exit 2**，而页面/接口把子进程的中文提示原样带了出来（「摄像头打不开…设备可能正在被其它程序占用…」）——这正是 t78/t81 想要的行为（失败有原因、不静默）。我等到那个会话结束（约 3.5 分钟）才做上面的释放测试，避免误杀别人的进程。

---

## 5. 门禁

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | `git status` 只有 t82 在改的三个**文档**（`docs/adr/0010-…md`、`docs/design/conversation.md`、`docs/testing.md`），无代码在途；HEAD `e045be2` | **209 tests / 209 pass / 0 fail / 0 skipped，exit 0** |
| `npm run check:docs` | 同上 | 检查了 **62 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 63 份 / 0 问题 / exit 0） |

---

## 6. 观测（都不改变 verdict）

- **O1（低，用户可见文案）**：`LIVE_PRIVACY_NOTE` 现在带了 Markdown 强调符，而它被**直接插进 HTML**（`<div class="muted" id="px-live-privacy">${LIVE_PRIVACY_NOTE}</div>`）——我从控制台抓下来的页面里确实是字面量：`但**在场事件（presence.changed）与 world_state 投影照常写进本地库**——事件才是产品…`。同一张卡片里的另一段用 `<b>` 就正常。建议把这两个 `**` 去掉（常量同时给接口用，保持纯文本最稳）。
- **O2（低，措辞）**：`docs/design/perception.md` §7.1 写「临时目录只算本次运行**前后**新建/改动的文件」，而实现是 `mtime >= 本次运行开始时刻`（只看**之后**）。建议改成「本次运行开始之后新建/改动的」，免得读者以为会看运行前的文件。
- **O3（信息，范围粒度）**：三个仓库内范围是**递归**的，系统临时目录只扫**顶层**（代码如此、结论行只印目录名）。我的突变实验证明顶层文件能抓到；若有深层截图落在 `%TEMP%` 子目录里，不会被算进去。今天够用，但若日后要把这句话写强（「全盘无图像」），得先改实现。
- **O4（信息，流程/硬件独占）**：摄像头同一时刻只能被一个进程打开。这一轮我亲眼看到「别人正在用」时控制台子进程 exit 2 并在页面上给出中文原因（好行为），但**两个会话同时点「启用」时，先到的能看画面、后到的只会看到失败**——现场测试时请一次只开一个「启用」，这一点值得写进给用户的须知。

---

## 7. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node scripts/verify-camera-presence.ts --live --seconds 6`（干净） | exit 0：44 帧全带画面、8 KB/帧、事件 1 条、**自报 images_written=0**、四处范围命中 0（§2.1） |
| 同一条命令 + 运行中途放 `data\t83-probe.png` 与 `%TEMP%\t83-probe.png` | **命中 2 个**、FAILED、点名两个文件与各自范围（§2.2 B） |
| 同一条命令 + 运行中途放 `data\perception\t83-probe.png` 与 `services\perception-edge\t83-probe.png` | **命中 3 个**、FAILED（`data/perception` 被两个范围各点一次 → 递归已证）（§2.2 C） |
| 四个范围近 30 分钟图像扫描 + `node data/rev-tmp/t80-images.mjs data` | 四处均 **0** 个；`data/` 图像总数仍是 **4** |
| `git grep -n -e imwrite -e VideoWriter -e imsave -e savefig -e tofile -e write_bytes -- services/perception-edge/perception_edge` | 只有注释命中；唯一图像调用是 `cv2.imencode`（§3） |
| `git grep -n "images_written" -- services/perception-edge scripts` | `run.py` 的 `live_summary` 字段 + 验证脚本的读取/判负/打印（§3） |
| 控制台 `--offline` + `POST /api/field/live start/stop/start/stop`（含 `Get-Process`、全局进程查询） | 首次 frames=30 有画面 → 停用 **exitCode=0**、PID 消失 → **再启用 frames=23 有画面** → 再停用 exitCode=0、0 残留（§4） |
| `npm test`（判读前 `git status`：只有 t82 的文档在途） | **209 / 209 pass / 0 fail，exit 0** |
| `npm run check:docs` | 62 份 markdown / 0 问题 / exit 0（含本报告 63 份 / 0 问题 / exit 0） |

---

## 8. 我做过的真实外部动作

**0 次 API 调用**（全程离线）。按验收明文要求**多次打开真实摄像头**：三次 `--live --seconds 6`（含两次突变实验）+ 控制台两次启用（约 32 + 23 帧）。画面只经内存与 localhost，**未上传**。为验证扫描范围，我在四个范围里短暂放过 4 个 1×1 PNG 探针（`data\`、`%TEMP%\`、`data\perception\`、`services\perception-edge\`），**每次跑完立刻删除**；收尾时 `git status` 无多余未跟踪文件、四个范围近 30 分钟新图像 0 个、`data/` 图像总数仍是 4。我自己造的临时目录与输出文件（`%TEMP%\t83-console`、`t83-presence`、`t83-runB/C.out|err`）已全部删除；控制台已关闭（8897 无人监听），**全局无残留 `perception_edge` 进程**。**未杀任何他人的进程**——摄像头被别的会话占用时我选择等待（约 3.5 分钟）。**未改动任何他人的文件**：唯一写入产物是本文件；探针脚本留在 `data/rev-tmp/`（`data/` 已 gitignore，非交付物）。基线修订 `e045be2`。
