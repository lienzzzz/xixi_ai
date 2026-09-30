# 复审：§8.2 的两条复核命令是否在 PowerShell 里原样可跑（t112 / round-2）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t110 的 F1 发现与本轮 t112 的修补）
> 评审对象：`d0e2b68`「t112 完成：§8.2 两条复核命令改成 PowerShell 原样可跑 + 两句支撑句不再当证据」（只改 `docs/design/perception.md`，**+15 / −4**）
> 复核方式：**把两条命令从 markdown 里逐字抽出来**（不改写一个字）写进 `.ps1`，再用 `powershell -NoProfile -File` **原样跑**——这正是 F1 的判据；另核 O1 那处改写的可核程度
> 时序：判读时 HEAD `d0e2b68`；`git diff HEAD -- docs/design/perception.md` 为空（我脚本核对：HEAD 与工作区各抽出 2 条命令，**逐字相同**）→ 我跑的就是被评版本

---

## 1. 结论

**verdict：pass（无 finding；3 条观测在 §4）**

一句话：**F1 修好了，而且是按「原样可跑」的方式证明的**——我把 §8.2 的两条命令**逐字**抽出来（第一条 336 字符、第二条 399 字符，各含 **0 处** `\"`），写进 `.ps1` 后用 PowerShell 跑：**两条都是 `exit=0`、stderr 为空**。第一条输出逐行 `presence.changed  mode=camera state=absent startup frames=0 motion_ratio=0.0000 faces=0 gate=motion+face reason=camera_started`（正是文档说的「列出台账行 + `mode=` 标记」）；第二条输出 **`{'camera': 3}`**，与文档标注的「当时台账」值**一模一样**。O1 那一处也按可核程度改到位了：核心结论（「**可能是**合成场景留下的，但**台账里没有标记能证明**，不要按数值猜」）保留，两句当年用来「支撑」的说法（时间戳吻合、数值落在合成场景范围）**明确降级为不可复现、不再当证据**，并且第二句的更正（**每跑必先写一条启动记录**，所以它区分不了来源）我对着代码核过——`run.py` 在循环之前**无条件**先写那条 `reason=camera_started` 的启动记录，真实与合成两条路径都一样。

| 任务验收条款 | 我的判定 | 依据 |
|---|---|---|
| 1 给出明确 verdict；needs_revision 必须给出可执行 findings（含文件与行号） | **pass（无 finding）** | §2、§3 |
| 2 把 §8.2 的两条复核命令**原样**在 PowerShell 里跑一遍（不要改写后再跑）；并确认 O1 那处已按可核程度改写 | **真正满足** | §2（逐字抽取 + 原样运行）、§3（O1 逐句核） |
| 3 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/` | **满足** | §5：`npm test` **243/243 pass / 0 fail / exit 0**；`check:docs` **75 份 / 0 问题 / exit 0** |

---

## 2. F1 的判据：两条命令**原样**跑

抽取方式：用脚本读 `docs/design/perception.md`，把以 `E:\worker2\.venvs\cv4\Scripts\python.exe -c ` 开头的行**原封不动**写到 `%TEMP%\t113-cmd{1,2}.ps1`（每个文件只有那一行 + 换行），再用 `powershell -NoProfile -File <文件>` 跑。**没有任何改写**。

| | 第 1 条（列出台账行 + `mode=` 标记） | 第 2 条（按来源统计） |
|---|---|---|
| 命令长度 / 含 `\"` 处数 | 336 字符 / **0** | 399 字符 / **0** |
| exit | **0** | **0** |
| stderr | **空** | **空** |
| stdout | 3 行，每行形如 `presence.changed  mode=camera state=absent startup frames=0 motion_ratio=0.0000 faces=0 gate=motion+face reason=camera_started` | **`{'camera': 3}`** |
| 与文档声明是否一致 | 一致（文档说它打印带 `mode=` 的行） | **完全一致**（文档写的正是 `{'camera': 3}`（当时台账）） |

对比 t110 那次：同样「逐字抽取 + 原样跑」，当时两条都得到 Python 的 `SyntaxError: unterminated string literal`（因为 `\"` 被 PowerShell 抢先解析）。现在 `\"` 已经 0 处、命令改成了「外层双引号 + 源码只用单引号 + 取全表后在循环里筛 `t=='presence.changed'`」，**同一个判据从红变绿** ✓。

---

## 3. O1 那处改写的核对（按可核程度）

改后的 §8.2 第 1 段现在是：

- **保留的结论**：「那 3 行**没有** `mode=` 标记，**无法证实**。可证的说法只有一句：**可能是**合成场景留下的，但**台账里没有标记能证明**，不要按数值猜它是哪一路。」✓ 与我在 t101/t110 两次独立查证的结论一致（那 3 行确实没有标记，`source` 又是真实/合成共用的默认值）。
- **降级的支撑 ①**：「那 3 行本身现在已经不在台账里（…已被清走或覆盖），**没有留存的时间戳**可以拿来说『与 `--self-test` 那批吻合』——写『吻合』的时候手里就没有存证，属于记忆，不是证据。」✓ 我核过：当前台账 `presence.changed` 只剩 **3 条**、时间戳 19:28–19:30、**全 `mode=camera`**（没有那 3 行、也没有任何 `present_confirmed`）；所以这句「吻合」现在既无从复现、当时也只是「接近」（我 t101 记录的是 18:22–18:23 对 18:23:45）。
- **降级的支撑 ②**：「『数值落在合成场景的范围内』这句用错了一个常量：**每次开跑都会先写一条启动记录**（见 §5），也就是**每一条 `present_confirmed` 前面都有一条对应的 `camera_started`**，所以『前面有启动记录』对真实与合成两条路径**都成立**。」✓ 对着代码核过：`run.py` 在进入抓帧循环**之前**无条件发那条 `reason=camera_started`（`git grep -n "reason=camera_started" -- services/perception-edge/perception_edge/run.py`），两条路径都会写；我用两个库也看得见「`camera_started` → `present_confirmed`」成对出现（真机库与自检库都是）。**这个更正本身是对的**，而且它引的是 §5（我确认 §5 里就是 `mode=` 标记表 + 「启动记录只有一条」的那段），前向引用有效。
- 「确实」那一半（t92 删除组的 `0.148` / `0.0318`）**未动**——我在 t110 已经逐字复现过（`--self-test` 写出 `frames=286 motion_ratio=0.0318 … present_confirmed`），这轮不需要重复。

---

## 4. 观测（都不改变 verdict）

- **O1（正面）**：这次的验证方式值得固定下来——**从 markdown 里抽命令行、原样丢给目标 shell 跑**，而不是手读或改写后跑。t112 自己也是这么做的（`data/recon/t112-verify.py` 8 项全 OK），我这次用同法独立复现，结论一致。
- **O2（正面）**：文档把第二条命令的输出写成「`{'camera': 3}`（当时台账）」，并另加一段说明「台账每跑一次真机就追加，换台机或换时间会变」——**标签正确**：我这次跑出来仍是 `{'camera': 3}`（台账没变），但即使变了，读者也不会被这个数字误导。这与「不写死会漂的数字」的要求一致。
- **O3（信息）**：两条命令后面新增的引用块解释了「为什么这样写」（`\"` 会被 PowerShell 抢先解析、SQL 里的字符串引号在双引号里难写），把这次修补的**理由**留在了文档里——避免了以后有人「顺手改回」`\"`。顺带一提：`AGENTS.md` §9.8 现在也加了同样的一条纪律（文档命令必须原样可跑），与这里的写法互为印证。

---

## 5. 门禁

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | HEAD `d0e2b68`；在途是 `packages/conversation/src/{engine,index,prompt}.ts`、`scripts/field-test.ts` 与 `tests/{console,unit/core}` 下两个新文件（都不是 t112 的文件） | **243 tests / 243 pass / 0 fail / 0 skipped，exit 0** |
| `npm run check:docs` | 同上 | 检查了 **75 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 76 份 / 0 问题 / exit 0） |

---

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node data/rev-tmp/t113-run-cmds.mjs`（**我自写**：从文档逐字抽两条命令 → 写 `.ps1` → `powershell -NoProfile -File` 跑） | 第 1 条 exit 0 / stderr 空 / 3 行 `presence.changed  mode=camera …`；第 2 条 exit 0 / stderr 空 / **`{'camera': 3}`**；两条各含 **0 处** `\"`（§2） |
| `node data/rev-tmp/t113-identity.mjs`（**我自写**：HEAD 与工作区命令逐字比对） | HEAD `d0e2b68`；`git diff --stat HEAD -- docs/design/perception.md` 为空；两侧各 2 条命令、**逐字相同**（§1 时序） |
| `git grep -n "reason=camera_started" -- services/perception-edge/perception_edge/run.py` | 启动记录在抓帧循环**之前**无条件写（`run.py:261-264`），与 §3 的更正一致 |
| `Select-String -Path docs/design/perception.md -Pattern "mode=camera|启动记录"` | §5 里确有 `mode=` 标记表与「启动记录只有一条」，文档里「见 §5」的前向引用有效 |
| `npm test` / `npm run check:docs` | 243/243 exit 0；75 份 0 问题 exit 0 |

---

## 7. 我做过的真实外部动作

**0 次 API 调用**、未开摄像头/麦克风、未起任何服务。两条被评审的命令都是**只读 SQLite 查询**（打印台账行与来源统计），我原样跑了它们——**没有写入任何库、没有写任何文件（除 `%TEMP%` 里那两个 `.ps1`）**。**未改动任何他人的文件**；唯一写入产物是本文件；脚本留在 `data/rev-tmp/`（`t113-run-cmds.mjs`、`t113-identity.mjs`，`data/` 已 gitignore，非交付物）。基线修订 `d0e2b68`（工作时 HEAD，即被评交付点）。
