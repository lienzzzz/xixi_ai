# 再评审（round 2）：testing.md 两处数字 + 四入口数据库限定（t59，对 t57 的 F1/F2）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t53/t59 的实现者）
> 日期：2026-09-30
> 评审对象：t59「repair-round-2」——修我在 t57 提的两条 low finding（unit 文件数命令与数字不符、`tests/audio-fixtures/` 的「36 个 wav」），并按 t53/我的前瞻观测给四入口数据库的说法加限定。产物在工作区（`README.md`、`docs/design/domain-model.md`、`docs/testing.md` 三个文件为 `M`，尚未由 captain 提交；我写作时的 HEAD = `3e3570d`）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`docs/testing.md`、`docs/design/domain-model.md` §6、`README.md`；代码侧 `scripts/{chat,serve-chat,voice-turn,field-test}.ts`（**HEAD 与工作区各看一遍**）、`scripts/field-test.ts` 的 `FIELD_TEST_USAGE`；以及**我自己跑的 6 组命令**（见 §5）
> 说明：引用代码位置用「文件 + 符号 + 一条可复现命令」

---

## 1. 结论

**verdict：needs_revision**（1 条 finding：low）

一句话：**我 t57 报的两处可证伪数字都真修好了**——文档现在给的两条计数命令我自己跑出来正好是 **16**（unit 文件数）与 **23**（四层合计），并且它把「只给 `**` 会得到 9」这个坑也写进了正文；§6 的 wav 数由 36 改成 **35**，配的两条计数命令实跑 **5 + 30 = 35**，与数字一致。四入口「不跨入口」的限定也加上了、理由写对了；**但同一段里多了一句与实现不符的话**：它说现场测试控制台「用 `--data-dir` / `--presence-data-dir` **参数**」覆盖库路径，而这两个名字在 `scripts/field-test.ts` 里**根本不存在 CLI 解析**（`--help` 的用法里也没有），它们只是 `createFieldServer` 的构造选项——更糟的是 CLI 对未知参数**静默忽略**，用户照着敲会以为覆盖生效了。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 明确 verdict + 可执行 findings | **满足** | needs_revision；F1 带文件、位置与 requiredFix |
| 2 独立核对：按文档命令数单元文件数（应 16）与 wav 数（应 35）并确认命令与数字一致；若入口环境变量覆盖已落地，确认四入口说法已加限定 | **数字两项完全成立；四入口限定已加，但同一句里有一处与实现不符（F1）** | 见 §2（16 / 23 / 5+30=35 全部复现）与 §3（限定成立 + F1） |
| 3 自己跑 npm test 与 check:docs（判读前先看 `git status` 排除他人在途改动）；结论落本文件 | **满足** | `git status` 显示三个被评审文档为 `M`、另有他人 `scripts/*` 与 `tests/console/*` 的在途改动；在此状态下 `npm test` → **189 / 189 / 0 fail / 0 skipped，exit 0**（壁钟 24.4s），`check:docs` → **54 份 markdown、0 问题、exit 0**（加入本文件后复跑 **55 份**、仍 0 问题） |

**范围纪律**：t59 只改了它声明的三个文档，未越界；我本轮**只新增本文件**，全程只读（未 stash、未改动他人文件）。

---

## 2. 我 t57 的两条 finding：都已真正修好（附我的复现）

| t57 的 finding | 文档现在的写法 | 我实跑的结果 | 判定 |
|---|---|---|---|
| unit 文件数命令输出 9 而旁边写 16 | §1 单元行：「**16 个测试文件、124 项**……文件数用 `git ls-files "tests/unit/*.test.ts" "tests/unit/**/*.test.ts"` 可数出 16（只给 `**` 只有 9——`**` 至少要求一层子目录）」 | `git ls-files "tests/unit/*.test.ts" "tests/unit/**/*.test.ts"` → **16**；只给 `**` → **9**（与文档的解释一致） | **修好**（还顺手把坑写清楚了——比只改命令更有价值） |
| 四层合计的文件数（同一处写法） | 「四层合计 **23 个 `*.test.ts`、180 项**（文件数：`git ls-files "tests/*/*.test.ts" "tests/**/*.test.ts"`）」 | 该命令 → **23** | **修好** |
| §6 缺口 3 的「36 个 wav」 | 「**35 个 wav**：顶层 5 个中文夹具 + `noisy/` 30 个噪声夹具，含 6 档 SNR；复现：`(Get-ChildItem tests/audio-fixtures -Filter *.wav -File).Count` → 5，`…\noisy…` → 30，两者相加 35」 | 两条命令实跑 **5** 与 **30**，合计 **35**；`git ls-tree`（HEAD）同样是 35 | **修好** |

## 3. 四入口数据库的说法（验收条款 2 的后半）

**限定本身成立**：`domain-model.md` §6 现在写「**库路径可被覆盖**（测试与并行实例用）：`chat` 认 `XIXI_CHAT_DATA_DIR`、试用页认 `XIXI_WEB_DATA_DIR`……覆盖只改『哪个文件』，**不改变『不跨入口』这条结论**」；README 的 `--personality` 说明也补了「各用各自的 SQLite 文件（库路径可用环境变量覆盖……）；覆盖不改变『不跨入口』」。这段推理是**对的**：换一个库文件只是换「写进哪个文件」，默认四条路径依旧互不相通。

**一处与实现不符（F1）**：同一句里写「现场测试用 `--data-dir` / `--presence-data-dir` **参数**」。

## 4. finding

### F1（low）`domain-model.md` §6 把 `createFieldServer` 的构造选项写成了 CLI 参数

- **位置**：`docs/design/domain-model.md` §6「人格属性与两种写入方式」的「库路径可被覆盖」那段（同一段里 `chat`/`web` 的环境变量是对的）。
- **证据（两条命令即可复核）**：
  - `git grep -n -e "data-dir" -e "presence-data-dir" -- scripts/field-test.ts` → **无命中**（我连 HEAD 也查了，同样无命中）；
  - `scripts/field-test.ts` 的 `FIELD_TEST_USAGE`（`node scripts/field-test.ts --help` 打印的那份用法）里列的是 `--port` / `--offline` / `--no-tts` / `--dsh` / `--no-open` / `--self-test` / `--acceptance` / `--help`，**没有** `--data-dir` / `--presence-data-dir`。
  - 实际存在的是 `createFieldServer({ dataDir, presenceDataDir })` 这两个**构造选项**（用于自检/测试指向临时库），CLI 侧不解析它们。
- **为什么值得修**（不只是措辞）：`field-test.ts` 的 `main()` 对**未知参数静默忽略**（它只 `argv.includes('--port')` 这类逐项取用）。也就是说用户按文档敲 `npm run field-test -- --data-dir D:\tmp` 不会有任何报错、也不会生效——**比报错更糟**：他会以为自己已经切到另一个库、并据此判断「人格覆盖跨入口了没有」。
- **requiredFix**：把这半句改成与实现一致的写法，例如「现场测试控制台的库路径由 `createFieldServer` 的 `dataDir` / `presenceDataDir` 选项决定（自检与测试用它指向临时库；**目前没有 CLI 开关**，`--help` 里也没有）；`voice-turn` 固定 `data/voice`。」若确实想给现场测试加开关，那是代码改动（另开任务），不是文档先写。

## 5. 观测（不改变 verdict）

- **O1（这批限定描述的是工作区代码，尚未进 HEAD）**：`XIXI_CHAT_DATA_DIR` / `XIXI_WEB_DATA_DIR` 目前**只存在于在工作区**（`git grep … HEAD -- scripts` 无命中；`git grep … -- scripts` 命中 `chat.ts` 与 `serve-chat.ts`）。t59 在回报里**主动披露**了这一点（「若该在途改动被回滚，我这两处文档会漂移——请集成时确认它们已落地」），做法正确。**给队长的动作**：提交时把 `scripts/chat.ts` / `scripts/serve-chat.ts` 与这两处文档放进**同一次**提交；否则干净检出上的读者按 `git grep` 核不出这两个变量。
- **O2（这次的门禁判读没有歧义）**：我按 §9.10 先看 `git status`：三个被评审文档 `M`，另有他人 `scripts/*` 与 `tests/console/*` 的在途改动。在**这个含在途改动的状态**下 `npm test` 就是 **189/189/0 fail（exit 0）**，所以本任务不存在「红绿归因」问题（t59 报告里那次 189/186/3 的红我无从复现，但也不需要——当时的那种瞬态按 §9.10 属半成品窗口）。
- **O3（值得保留的写法）**：文档没有只把命令改对，而是**写明「只给 `**` 只有 9」**——这正好防住下一个想「顺手简化命令」的人。同类写法建议推广到其它带通配/过滤的命令（本机 `grep` 不可用这件事也是这么记进 `AGENTS.md` §4 的）。

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `git ls-files "tests/unit/*.test.ts" "tests/unit/**/*.test.ts"` | **16**（文档说 16 ✓）；附：只给 `"tests/unit/**/*.test.ts"` → **9**（文档也这么写 ✓） |
| `git ls-files "tests/*/*.test.ts" "tests/**/*.test.ts"` | **23**（文档说 23 ✓） |
| `(Get-ChildItem tests/audio-fixtures -Filter *.wav -File).Count` / `…\noisy…` | **5** / **30** → 合计 **35**（文档说 35 ✓） |
| `git — ls-tree -r HEAD --name-only tests/audio-fixtures`（数 `.wav`） | **35**（提交态一致） |
| `git grep -n -e "data-dir" -e "presence-data-dir" -- scripts/field-test.ts`（含 `HEAD`） | **无命中** → F1 |
| `git grep -n "XIXI_CHAT_DATA_DIR\|XIXI_WEB_DATA_DIR" -- scripts`（工作区 / HEAD） | 工作区命中 `chat.ts` / `serve-chat.ts`；**HEAD 无命中** → O1 |
| `git status --porcelain` | `M README.md`、`M docs/design/domain-model.md`、`M docs/testing.md`（本任务文档）+ 他人 `M scripts/{chat,field-test,serve-chat}.ts`、`M tests/console/field-test-console.test.ts`、`?? tests/console/proactive-console.test.ts` |
| `npm test` | **tests 189 / pass 189 / fail 0 / skipped 0**，exit 0（壁钟 24.4s，含上述在途改动） |
| `npm run check:docs` | 检查了 **54 份 markdown**（加入本文件后 **55 份**）；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |

**我做过的真实外部动作**：**0 次 API 调用**（未花任何费用）、未开摄像头/麦克风、未写任何数据库；全程只读。
