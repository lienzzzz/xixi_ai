# 评审：perception.md 失败路径的数字与编号取舍（t92）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t89 的实现与 t92 的落笔）
> 评审对象：`de5234a`「t92 完成：perception.md 同步失败路径（时长、复现命令、三层预算），数字由自审脚本对读源码」（只改 `docs/design/perception.md`，**+54 行、0 删除**，新增 §8.4）
> 复核方式：**从源码取三层预算与文档逐条对读** + **实跑文档给出的复现命令三次** + 核对事件台账是否被写 + 核对编号取舍与 `handoff.md` 的两处引用
> 时序：HEAD = `a9b2d09`；`de5234a..HEAD` 只有我上一份评审的提交，**`docs/design/perception.md` 自 t92 交付后一字未变**（`git diff --stat de5234a..HEAD -- docs/design/perception.md` 为空）；判读时工作区有他人在途的 `tests/console/*` 与 `docs/design/brain-and-models.md`

---

## 1. 结论

**verdict：needs_revision（1 条 low finding：F1；其余数字与命令全部对得上）**

一句话：**三层预算、看门狗公式、复现命令、退出码、「失败不留下读数」我都独立验过，成立**——子进程默认 `CAMERA_OPEN_TIMEOUT_SECONDS = 3.0`、验收脚本 `CHILD_CAMERA_OPEN_TIMEOUT_S = 2.5`（并通过 `--camera-open-timeout` 传给子进程）、看门狗 `max(1,--seconds)×1000 + 15000`（`--live` 时 `+20000`）与文档一字不差；实跑 `node scripts/verify-camera-presence.ts --camera-index -1 --seconds 3` **三次**：`exit=2`、**3540 / 3545 / 3495 ms**、stderr 全中文、原生英文警告 **0** 行，跑完事件台账**一条没多**（6 条 → 6 条）。**但 §8.4 里有一句解释性的话与代码不符**：文档说第二行那个秒数「是**子进程自己的等待预算**」，而代码打印的是**实际等待的耗时**（`elapsed = time.perf_counter() - started_at` → `f"已等待 {elapsed:.1f} 秒"`）；同一个 2.5 s 预算，我三次跑分别打印 **2.5 / 2.6 / 2.5** 秒，文档自己给的例子（3.0 s 预算 → 3.1 秒）也正好说明它是浮动的耗时而不是常量预算。按本仓硬规则「文档只写代码里真实存在的东西」，这一句要改（改法见 §4），**其余不需要动**。

| 任务验收条款 | 我的判定 | 实测/依据 |
|---|---|---|
| 1 独立核对 §8.4 每个数字与命令（三层预算对读源码 + 实跑 `--camera-index -1`）+ 核对编号取舍 | **基本满足，但有一句失实（F1）** | §2（三层预算逐条）、§3（实跑三次）、§4（F1）、§5（编号与 handoff 引用） |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/` | **满足** | §6：`npm test` **223/223 pass / 0 fail / exit 0**；`check:docs` **68 份 / 0 问题 / exit 0** |

---

## 2. 三层预算逐条对读（文档 vs 源码）

| 层 | 文档写的 | 源码里实际是 | 判定 |
|---|---|---|---|
| 子进程等设备的默认预算 | 默认 **3.0 秒**（`CAMERA_OPEN_TIMEOUT_SECONDS`），任何调用方可用 `--camera-open-timeout <秒>` 调小 | `run.py`：`CAMERA_OPEN_TIMEOUT_SECONDS = 3.0`；`--camera-open-timeout` 的 `default=CAMERA_OPEN_TIMEOUT_SECONDS`；`CameraConfig.camera_open_timeout` 传进 `grabber.open_timeout_s` | ✓ 一字不差 |
| 验收脚本给子进程的设备预算 | **2.5 秒**（`CHILD_CAMERA_OPEN_TIMEOUT_S`，通过 `--camera-open-timeout` 传给子进程） | `verify-camera-presence.ts`：`const CHILD_CAMERA_OPEN_TIMEOUT_S = 2.5;`，argv 里拼 `'--camera-open-timeout', String(CHILD_CAMERA_OPEN_TIMEOUT_S)` | ✓ 一字不差 |
| 验收脚本的看门狗（子进程整体超时） | `max(1, --seconds) × 1000 + 15000` 毫秒（`--live` 时 `+ 20000`）；只在子进程真卡住时触发，按中文超时说明以 **exit 2** 退出 | `const watchdogMs = liveMode ? Math.max(1, seconds) * 1000 + 20_000 : Math.max(1, seconds) * 1000 + 15_000;`；`if (watchdogFired) { …中文…; process.exit(2); }` | ✓ 一字不差 |
| 脚本自己的开销 | 「脚本自己还要 1–1.5 秒探测解释器与开库，所以子进程预算必须小于端到端目标」 | 我三次实跑端到端 3495–3545 ms、子进程预算 2500 ms → 开销 ≈ **1.0 s**，与文档区间相符 | ✓ 与实测一致 |

---

## 3. 实跑文档给的复现命令（三次）

```
node scripts/verify-camera-presence.ts --camera-index -1 --seconds 3
```

| 次数 | 退出码 | 端到端耗时 | 原生英文警告 | 第二行打印的秒数（预算 2.5 s） |
|---|---|---|---|---|
| 1 | **2** | 3540 ms | **0** | 已等待 2.6 秒 |
| 2 | **2** | 3545 ms | **0** | 已等待 2.5 秒 |
| 3 | **2** | 3495 ms | **0** | 已等待 2.6 秒 |

- 与文档判据一致：**约 3.5 秒、5 秒内一定返回**（文档列的 3.51–3.92 秒也在同一区间）；`-1` 每次都真的打不开（`exit=2`）。
- **stderr 是中文**（5 行结构与 §8.4 给的原文一致）；**原生 OpenCV 英文警告 0 行**。
- **失败不留下读数**：跑前 `data/perception/field-test.sqlite` 里 `presence.changed = 6`（3 条 `camera_started` + 3 条 `present_confirmed`），三次跑完**仍是 6 条**——打不开摄像头时一条事件都不写 ✓。
- 另外我**裸跑模块**（不经验收脚本包装）：`python -m perception_edge.run --camera-index -1 --seconds 3` → `exit=2`、**3452 ms**、**raw stderr 里也没有英文警告**（说明 `run.py` 自己在 `main()` 里静默 OpenCV 日志这一层是真的，不是只靠脚本过滤）✓。

---

## 4. F1（low，但属「文档写了代码里没有的行为」）

**位置**：`docs/design/perception.md` §8.4（本次核对时是第 315–316 行；引用位置请用下面的命令，行号会漂）：
`git grep -n "已等待" -- docs/design/perception.md services/perception-edge/perception_edge/run.py`

**文档原文**：「第二行里的秒数是**子进程自己的等待预算**（实测：2.5 s 预算打印「已等待 2.5 秒」、3.0 s 预算打印「已等待 3.1 秒」），不是手写的固定值。」

**代码实际**（`run.py`）：`elapsed = time.perf_counter() - started_at` → `f"摄像头不可用（已等待 {elapsed:.1f} 秒后放弃，不会一直重试）：{cause}"`。打印的是**从开始尝试打开设备起算的实际耗时**，保留一位小数；`--camera-open-timeout` 只是**上限**，它通常决定耗时量级，但打印值不是那个常量。

**我的实测（同一个 2.5 s 预算）**：**2.5 / 2.6 / 2.5** 秒——三次就已经不是同一个数；裸跑模块（默认 3.0 s 预算）这次打印的是 **3.0** 秒。文档自己举的「3.0 s 预算 → 3.1 秒」也正是「耗时 ≈ 预算 + 零点几」的样子，与「就是预算」这句自相矛盾。

**为什么值得改（而不是当措辞）**：这属于本仓「文档只写代码里真实存在的东西」的硬规则（`AGENTS.md` §2）；而且它会被当成维护依据用——读者会以为改 `--camera-open-timeout` 就能精确控制**打印出来的那个数**，实际上打印值取决于当场等了多久（负载下会更大）。改一句话即可，三个预算数字都不动。

**requiredFix（一句话）**：把那一句改成「第二行里的秒数是子进程**实际等待的耗时**（保留一位小数，通常约等于当时的预算、但会浮动：同一个 2.5 s 预算实测出现过 2.5 / 2.6 秒），预算是 `--camera-open-timeout` / `CAMERA_OPEN_TIMEOUT_SECONDS`」，并把后面的例子改成「3.0 s 预算实测约 3.0–3.1 秒」这种区间写法（或直接引用 `run.py` 的 `elapsed` 表达式）。

---

## 5. 编号取舍：真的不误导读者吗

| 检查 | 结果 |
|---|---|
| `handoff.md` 两处指向 §8.3 的含义是否仍正确 | **仍正确**。`docs/handoff.md:22`「摄像头在场检测的『真人站在镜头前被检出』这一步尚未实测（摄像头朝天，见 `design/perception.md` §8.3）」与 `:67`「接口见 `design/perception.md` §8.3（真人站镜头前那一步未完成）」——而 §8.3 的标题与正文正是「**还没做的那一步（未完成项，明确标注）**：『真人站在镜头前能否被检出』尚未验证」✓ 两处引用一字不用改（t92 不动 out-of-scope 文件的取舍是对的） |
| `§8.4` 排在 `§8.3` 之前，读者能否跟上 | **能，但编号是反的**：文档顺序是 §8.4（第 277 行，失败路径）→ §8.3（第 330 行，未完成项）。§8.4 的标题自带上下文（「打不开摄像头时：数秒内退出 + 一句中文原因」），§8.3 又是明确的「未完成项」小节，所以读到 8.3 时不会以为漏了一节；但 8.4 先于 8.3 出现、且**文档里没有任何一句话解释这个顺序**（理由只写在 t92 的回报里）。见观测 O1 |
| 维护规则表有没有跟着加 | ✓ 表格里新增了一行：`摄像头打不开时的等待预算 / 中文文案 / 看门狗（run.py 的 CAMERA_OPEN_TIMEOUT_SECONDS、--camera-open-timeout；脚本的 CHILD_CAMERA_OPEN_TIMEOUT_S 与看门狗）→ §8.4（…改预算就要改这一节的数字）` |

---

## 6. 门禁

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | HEAD `a9b2d09`；工作区有他人在途的 `tests/console/proactive-console.test.ts`（−36/+13）、`tests/console/proactive-loop.test.ts`（−22/+6）、`docs/design/brain-and-models.md`（+15） | **223 tests / 223 pass / 0 fail / 0 skipped，exit 0**（在途改动没有把门禁染红） |
| `npm run check:docs` | 同上 | 检查了 **68 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 69 份 / 0 问题 / exit 0） |

---

## 7. 观测（与 F1 一起附上，不单独改变判定）

- **O1（低，可读性）**：§8.4 排在 §8.3 之前是**有理由的**（保住 `handoff.md` 对 §8.3 的两处引用），但这个理由没写进文档。建议在 §8.4 标题下或维护规则那一行补一句「（8.4 编号在 8.3 之前：为保持既有引用指向『未完成项』不变）」，免得后来者「顺手把编号理顺」而踩掉 handoff 的链接。
- **O2（低，相邻漂移，**不在 t92 的 diff 里**）**：同一份文档前文有一句「台账现状（实测，可复核）：`data/perception/field-test.sqlite` 里现在只有 **5 条** `reason=camera_started` 记录」。我实查该库：现在共 6 条 `presence.changed` = **3 条 `camera_started` + 3 条 `present_confirmed`**，时间戳都在今天 18:22–18:23（说明那次「5 条」的测量之后，库被按 §8.2 给的「删库重跑」办法重置过、又被一次真实运行重新写入）。这句是**一次会过期的测量**（它下面紧跟的复核命令就是拿来核的），但数字已经不对了；建议把它写成「写这一段时的测量：5 条；以紧随其后的复核命令输出为准」。**这不属于 t92 的 +54 行**，我不把它算进本次判定，只报给队长决定要不要顺手收尾。
- **O3（正面，值得保留的写法）**：§8.4 把「复现命令 + 期望退出码 + 实测区间（而不是死数）+ 为什么不能用 99/9（会假成功）+ 三层预算表 + 中文原文 + 为什么只有中文 + 失败不留读数」串成一节，并且每个数字都能在源码里找到对应常量；我按这套结构逐条核，只有 F1 那一句解释性描述没对上。这种「数字必须能对回源码常量名」的写法建议沿用到其它文档。

---

## 8. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `git grep -n -e CAMERA_OPEN_TIMEOUT_SECONDS -e camera-open-timeout -- services/perception-edge/perception_edge/run.py scripts/verify-camera-presence.ts` | `run.py:63 CAMERA_OPEN_TIMEOUT_SECONDS = 3.0`；`--camera-open-timeout` 默认取它；脚本里 `CHILD_CAMERA_OPEN_TIMEOUT_S = 2.5` 并传参（§2） |
| `git grep -n -e watchdogMs -e 15000 -e 20000 -- scripts/verify-camera-presence.ts` | `Math.max(1, seconds) * 1000 + 20_000 / + 15_000`；看门狗分支 `process.exit(2)` + 中文说明（§2） |
| `node scripts/verify-camera-presence.ts --camera-index -1 --seconds 3`（×3） | 每次都 `exit=2`；3540 / 3545 / 3495 ms；英文警告 0；第二行打印 2.6 / 2.5 / 2.6 秒（§3） |
| `python -m perception_edge.run --camera-index -1 --seconds 3`（裸跑模块，cwd=`services/perception-edge`） | `exit=2`、3452 ms、**raw stderr 也无英文警告**、第二行打印 3.0 秒（§3） |
| `node data/rev-tmp/t97-events.mjs` / `t97-ledger.mjs`（**我自写**：`node:sqlite` 只读清点事件） | 跑前 6 条 → 跑后 6 条；逐条原因 = 3×`camera_started` + 3×`present_confirmed`（§3、O2） |
| `git grep -n "§8.3" -- docs/handoff.md` 与 `git grep -n "8\.4\|8\.3" -- docs/design/perception.md` | handoff 两处引用仍指向「未完成项」✓；文档顺序 8.4 → 8.3，维护规则表已加 §8.4 一行（§5） |
| `npm test`（判读前 `git status`） | 223 / 223 pass / 0 fail，exit 0 |
| `npm run check:docs` | 68 份 markdown / 0 问题 / exit 0（含本报告 69 份 / 0 问题 / exit 0） |

---

## 9. 我做过的真实外部动作

**0 次 API 调用**；按验收明文要求**四次尝试打开摄像头**（三次经验收脚本、一次裸跑模块，索引都是 `-1`，即「必然打不开」的那条路径），**没有读出任何画面、没有写任何事件**（台账前后都是 6 条）。**未改动任何他人的文件**（只读源码/文档 + 只读查库）；唯一写入产物是本文件；核对脚本留在 `data/rev-tmp/t97-events.mjs`、`t97-ledger.mjs`（`data/` 已 gitignore，非交付物）。基线修订 `a9b2d09`（工作时 HEAD；被评交付点 `de5234a`）。
