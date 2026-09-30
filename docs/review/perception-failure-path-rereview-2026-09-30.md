# 复审：perception.md §8.4 的「预算」与「实测耗时」（t100 / round-2）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t89 的实现、t92 的落笔与 t100 的修补）
> 评审对象：`db4de4c`「t100 完成：perception.md 把「实测耗时」与「预算」分清 + 两处收尾」（只改 `docs/design/perception.md`，+24 / −8）
> 复核方式：**按文档现在写的说法实测 6 次**（包装命令 ×3 + 裸跑模块 ×2 + 一次对照），逐行核对 §8.4 的每个数字，并独立查台账验证 t100 纠正过的条数
> 时序：判读时 HEAD `930c130`；`db4de4c` 就是被评版本（`git diff db4de4c..HEAD -- docs/design/perception.md` 为空），工作区在途的是 t106 对 §8.5 的修补（§8.4 与它**逐行相同 62/62**，见 §6）

---

## 1. 结论

**verdict：pass（t97 的 F1 已真正修好；3 条观测在 §5，都不改变判定）**

一句话：**§8.4 现在把「预算」与「实测耗时」分清了**——文档说那句「已等待 N 秒」是 `run.py` 打印的 `elapsed = time.perf_counter() - started_at` **实测值、会浮动**，并明确「预算是另外两个东西」（`--camera-open-timeout` 与 `CAMERA_OPEN_TIMEOUT_SECONDS`）。我按它写的说法实测：同一个 **2.5 秒预算**跑三次打印 **2.5 / 2.6 / 2.5 秒**（与文档列的三个值**完全一致**），裸跑模块用 **3.0 秒预算**打印 **3.0 / 3.0 秒**（文档写「3.0–3.1」，在范围内）——**浮动被实测到了，而且代码引文逐字对得上**（`run.py` 的 `elapsed = time.perf_counter() - started_at` 与 `已等待 {elapsed:.1f} 秒`）。我把 §8.4 从 287 行到 347 行的每一处数字都过了一遍，**没有发现第二处把预算写成实测（或反过来）**。t100 另外两处收尾（编号注记、台账条数）我也独立核过，**编号注记准确**，台账条数**它纠正得对**（我查出来跟它一样是 9 条，不是 captain 验收里写的 6 条）。

| 任务验收条款 | 我的判定 | 依据 |
|---|---|---|
| 1 给出明确 verdict；needs_revision 时必须给出可执行 findings | **pass（无 finding）** | §2–§5 |
| 2 独立核对：实测若干次确认秒数确实浮动、文档已把「预算」与「实测耗时」正确区分；确认 §8.4 没有其它同类混写 | **满足** | §2（6 次实测）、§3（代码引文）、§4（逐行扫） |
| 3 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/perception-failure-path-rereview-2026-09-30.md` | **满足** | §6 |

---

## 2. 实测：秒数确实浮动，且与文档写的一致

| 我跑的 | 打印的秒数 | 端到端 | exit |
|---|---|---|---|
| `node scripts/verify-camera-presence.ts --camera-index -1 --seconds 3`（子进程预算 **2.5 s**） | 已等待 **2.5** 秒 | 3490 ms | 2 |
| 同上（第 2 次） | 已等待 **2.6** 秒 | 3469 ms | 2 |
| 同上（第 3 次） | 已等待 **2.5** 秒 | 3467 ms | 2 |
| `python -m perception_edge.run --camera-index -1 --seconds 3`（模块默认预算 **3.0 s**） | 已等待 **3.0** 秒 | 3414 ms | 2 |
| 同上（第 2 次） | 已等待 **3.0** 秒 | 3427 ms | 2 |

- **同一个 2.5 秒预算出现 2.5 / 2.6 / 2.5 三种打印值** → 证明打印的是**实测耗时**（预算不可能自己变），文档现在正是这么写的 ✓（而且 2.5/2.6/2.5 三个值与文档列的一模一样）。
- 3.0 秒预算我测到 **3.0 / 3.0**，文档写「3.0–3.1」——**在范围内**（浮动本身就意味着别人的三次可能落在 3.0–3.1）。
- 端到端 3.41–3.49 s 与文档「约 3.5 秒、5 秒内一定返回」的判据一致 ✓。

---

## 3. 文档里的代码引文逐字对得上

| 文档写的 | 代码里 | 判定 |
|---|---|---|
| 打印的是 `elapsed = time.perf_counter() - started_at` 的实测值、保留一位小数 | `run.py:719` `elapsed = time.perf_counter() - started_at`；`run.py:721` `f"摄像头不可用（已等待 {elapsed:.1f} 秒后放弃，不会一直重试）：{cause}"` | ✓ 逐字 |
| 预算是 `--camera-open-timeout` 与 `CAMERA_OPEN_TIMEOUT_SECONDS` | `run.py:69` `CAMERA_OPEN_TIMEOUT_SECONDS = 3.0`；`--camera-open-timeout` 的 `default` 取它 | ✓ |
| 验收脚本给子进程的预算是 `CHILD_CAMERA_OPEN_TIMEOUT_S`（2.5 秒）并通过 `--camera-open-timeout` 传参 | `scripts/verify-camera-presence.ts:274` `const CHILD_CAMERA_OPEN_TIMEOUT_S = 2.5;`，argv 里拼 `--camera-open-timeout` | ✓ |

---

## 4. §8.4 逐行扫描：没有其它同类混写

我把 §8.4（287–347 行）里每一处带数字的句子都过了一遍，按「这是预算/判据，还是实测值」分类：

| 行 | 内容 | 归类 | 判定 |
|---|---|---|---|
| 301 | 「期望结果：**约 3.5 秒内退出**，退出码 2」 | 判据（且写成范围） | ✓ |
| 302–305 | 「七次实测 3.51…3.92；另一次 4.53（有原因）；**所以判据写成「约 3.5 秒、5 秒内一定返回」而不是死数**；裸跑模块实测 3.55 / 3.59」 | 实测 + 明确说明为何不写死 | ✓ |
| 307–311 | 「`99`/`9` 有时静默开成设备 0；`-1` **十次**复现全部 exit 2」 | 实测 | ✓ |
| 313–319 | 「**两个超时预算**」表格：3.0（常量）／2.5（脚本常量）／看门狗 `max(1,--seconds)×1000+15000`（`--live` +20000） | 预算与公式，标题即写明 | ✓ |
| 321–329 | stderr 原文样例（含「已等待 2.5 秒」） | 原文样例 | ✓ |
| 331–335 | 「第二行里的秒数是**实际等待的耗时**…通常约等于当时的预算、但会浮动…**预算是另外两个东西**…不要当成『预算被写死了』」 | **本次修的 F1** | ✓ |
| 337–343 | 「实测三次运行的 stderr 里原生英文警告数为 **0**」；UTF-8 环境变量 | 实测 / 配置 | ✓ |
| 345–347 | 「打不开时事件日志一条都不写（实测 `presence.changed` 数量为 **0**）」 | 实测 | ✓ |

**没有发现第二处混写** ✓。（唯一可挑的一处是 318 行「脚本自己还要 1–1.5 秒探测解释器与开库」：我这次量到的开销约 0.95–1.0 s，略低于它写的下限——但这属于「解释为什么会这样」的量级说明，且早先几次实测（3.55/3.59 秒端到端）对应的开销确实是 1.05–1.09 s，不构成失实，记在 O4。）

---

## 5. 观测（都不改变 verdict）

- **O1（低，§8.2 台账那段的一处「provenance」断言，不是 §8.4 的内容）**：t100 把台账条数改成「写这一段时的测量」很好，但同一段里说那 3 条 `present_confirmed`「是**合成场景**（`--self-test`）在驱动还交得出画面的那段时间留下的」——**这句话在台账里无法被证实**：① 事件的 `source` 是 `perception.laptop_camera`，而它正是合成与真实两条路径共用的默认值（`perception_edge/contracts.py:201`），`source_detail` 里也没有任何「合成」标记；② **现在**的 `--self-test` 默认写**另一个库**（`data/perception/self-test.sqlite`，除非显式传 `--db`，此时脚本还会打印警告），我实查那个自检库里就是它自己的 4 条（时间戳 `18:23:45–18:23:46`），而共享台账里的 3 条在 `18:22:19/18:22:37/18:23:02`——**时间上早于那次自检**。所以那 3 条究竟是「合成场景」还是「真实运行里有人/有物体动了」（`present_confirm_frames=15` 意味着当时确实有一串带运动的帧），从仓库里的信息**判不出来**；而文档把结论写成了事实（连带的「它们不是关于房间的证据」也就可能误导）。建议：把它软化成「**可能是**合成/自检画面留下的（当时驱动还能交画面）；台账里没有标记能证明——按 `reason` 与 `motion_ratio`/`faces` 判读」，或者（更好）让发射端把模式写进 `source_detail`（例如 `mode=synthetic|camera`），让台账自带来源。**这条不在 §8.4，也不影响本次验收的判定**。
- **O2（信息，正面：成员纠正了派单方的数字）**：captain 的验收文字里写「实查是 6 条 = 3+3」，t100 实查是 **9 条 = 6×`camera_started` + 3×`present_confirmed`**。我独立查证：**9 条，6+3** ✓，三条 `present_confirmed` 的 `motion_ratio` 是 0.0432 / 0.0469 / 0.1262（文档四舍五入成 0.043 / 0.047 / 0.126 ✓）、`faces=0` ✓。**按实际查询写、并把复核命令放在同一段**这个做法本身值得保留。
- **O3（信息，编号注记成立）**：我再次确认 `docs/handoff.md` 有**两处**把「真人站在镜头前未实测」指向 §8.3（`:22` 与 `:67`），§8.3 现在也确实就是那一节；注记里「要改成 8.3 就必须同时开一个能改 handoff.md 的任务」是对的。补充一个事实：因为 t99 又插了一节 §8.5，现在的顺序是 **8.4 → 8.5 → 8.3**，注记只说「8.4 排在 8.3 前面」，依然准确，不需要改。
- **O4（信息）**：本次 6 次实测与文档数字的对照见 §2；在途的 `camera.py`（t106）**没有碰** `open_timeout`/`elapsed`/「已等待」这几行（我 diff 过），所以 §8.4 的这些说法在 t106 落地后依然成立。

---

## 6. 门禁

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | HEAD `930c130`；在途是 t106 的 `services/perception-edge/perception_edge/{camera,run}.py` 与 `docs/design/perception.md`（都不是 t100 的文件） | **235 tests / 235 pass / 0 fail / 0 skipped，exit 0** |
| `npm run check:docs` | 同上 | 检查了 **71 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 72 份 / 0 问题 / exit 0） |
| `node data/rev-tmp/t101-section2.mjs`（**我自写**：把被评版本与工作区的 §8.4 逐行比对） | — | 两侧 §8.4 都是 287–347 行、**62/62 行完全相同** → 我引用的每一行都是 `db4de4c` 的原文，不受 t106 在途编辑影响 |

---

## 7. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node scripts/verify-camera-presence.ts --camera-index -1 --seconds 3`（×3） | 打印「已等待 2.5 / 2.6 / 2.5 秒」，端到端 3490 / 3469 / 3467 ms，exit=2（§2） |
| `python -m perception_edge.run --camera-index -1 --seconds 3`（裸跑×2，cwd=`services/perception-edge`） | 打印「已等待 3.0 / 3.0 秒」，端到端 3414 / 3427 ms，exit=2 |
| `git grep -n -e "elapsed = time.perf_counter() - started_at" -e "已等待 {elapsed" -- services/perception-edge/perception_edge/run.py` | `run.py:719` / `run.py:721` ✓（§3） |
| `git grep -n -e "CAMERA_OPEN_TIMEOUT_SECONDS = " -e "CHILD_CAMERA_OPEN_TIMEOUT_S = "` | `run.py:69` 3.0；`verify-camera-presence.ts:274` 2.5 ✓ |
| `node data/rev-tmp/t101-ledger.mjs` / `t101-source.mjs`（**我自写**：台账逐条 reason/motion/faces/source） | 9 条 = 6×camera_started + 3×present_confirmed；后者的 `motion_ratio` 0.0432/0.0469/0.1262、`faces=0`、`source=perception.laptop_camera`；自检库另有 4 条（18:23:45–46）（O1/O2） |
| `git grep -n "§8.3" -- docs/handoff.md` | 恰好两处（`:22`/`:67`），含义与 §8.3 一致 ✓ |
| `node data/rev-tmp/t101-section2.mjs` | 被评版本与工作区 §8.4 **62/62 行相同** ✓ |
| `npm test` / `npm run check:docs` | 235/235 exit 0；71 份 0 问题 exit 0 |

---

## 8. 我做过的真实外部动作

**0 次 API 调用**；按文档写的复现命令**五次尝试打开摄像头**（索引 `-1`，即「必然打不开」的失败路径，五次全部 `exit=2`）——**没有读出任何画面、没有写任何事件、没有写任何图片**；只读地查了 `data/perception/*.sqlite`。**未改动任何他人的文件**（这次评审只读 git 修订与文档/台账）。唯一写入产物是本文件；核对脚本留在 `data/rev-tmp/`（`t101-section2.mjs`、`t101-ledger.mjs`、`t101-source.mjs`，`data/` 已 gitignore，非交付物）。基线修订 `930c130`（工作时 HEAD；被评交付点 `db4de4c`）。
