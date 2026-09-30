# 再评审（round 3）：控制台相关文档五处订正 + 一处披露的越界编辑（t45，对 t30 findings F1–F5）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t30 与 t45 的实现者）
> 日期：2026-09-30
> 评审对象：t45「repair-round-3」——修我在 t30 提的 F1（写死耗时与归因）、F2（README perception 项数）、F3（unit 测试文件数）、F4（跟进窗口公式）、F5（`--personality` 指引落点），以及它**主动披露**的一处越界编辑（`docs/design/domain-model.md` §6 新增两条推论）
> 交付位置：`README.md` 与 `docs/testing.md` 的改动落在 `6a6c2a4`（被队长的周期提交收走），`docs/handoff.md` 的改动落在 `9c1234d`（提交信息写「t45 完成（文档五处订正）」，但该提交实际主要收录的是 t41 的实现文件）；`docs/design/domain-model.md` §6 的两条推论同样落在 `6a6c2a4`
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`README.md`、`docs/testing.md`、`docs/handoff.md`、`docs/design/domain-model.md` §6、`docs/architecture.md` 的 SQLite 行、`packages/domain/src/store.ts`（两种人格写入的 SQL）、`packages/conversation/src/fsm.ts` 的 `lingerMs` getter、`scripts/{chat,serve-chat,voice-turn,field-test}.ts` 的 `openXixiStore({dataDir})`，以及**五个入口数据库的只读 dump**与**我自己跑的 4 组命令**（见 §6）
> 上一轮血缘：本任务复核的 findings 由我在 t30 评审里提出（`docs/review/console-repair-review-2026-09-30.md`）

---

## 1. 结论

**verdict：needs_revision**（3 条 finding：1 medium + 2 low）

一句话：**五处订正本身我逐条验证成立**（写死的「干净机器约 21s」已改成带条件的历史数据点 + 归因修正；perception 11 项与我实跑一致；unit 文件数在它那个修订号上确实是 14；窗口公式已改成 `×(0.5 + t)` 并与 `fsm.ts` 的 getter 一致；`--personality` 的指引也确实落到了一节真实存在的内容上）——**但它主动披露的那处越界编辑里有一句是错的，而且是用户会照着做的**：`domain-model.md` §6 新写的「进程重启、**换入口（`chat` / `web` / `voice-turn`）都还在**」不成立——三个入口用的是**三个不同的数据库**，我用只读 dump 证明 `cli:override` 只落在 `data/chat/xixi.sqlite` 一个库里；更麻烦的是 README 的快速开始现在**正好指向这一节**，等于把错的模型递给用户。另外两处 low 是「订正过的数字又被后续任务（t41/t47）推翻」。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 明确 verdict + 可执行 findings（含文件与行号） | **满足** | needs_revision；F1–F3 都带文件与具体位置/符号 |
| 2 独立核对五处订正 **+** 复核披露的越界编辑 | **五处订正全部成立；披露的编辑里有 1 句不实** | 见 §2 逐条表与 §3 的数据库证据 |
| 3 自己跑一次 npm test 与 check:docs；结论落 `docs/review/console-repair-rereview-2026-09-30.md` | **满足** | `npm test` → **180 / 180 / 0 fail / 0 skipped，exit 0**（壁钟 13.7s，修订号 `7cf5291`）；`npm run check:docs` → **49 份 markdown、0 问题、exit 0**（加入本文件后复跑 **50 份**、仍 0 问题）；本文件即结论落点 |

**范围纪律**：t45 声明改的三个文件在盘上都符合它所述（`README.md`/`docs/testing.md`/`docs/handoff.md`），**并在回报里主动披露**了第四处（`docs/design/domain-model.md` §6）越界、说明原因与为何未回滚、请评审单独核对——这正是 AGENTS.md §9.2 要求的形态（队长也已把它纳入本任务范围）。我本轮只新增本文件。

---

## 2. 五处订正的逐条核对

| t30 的 finding | 当前盘上的状态（我核对的点） | 判定 |
|---|---|---|
| **F1**：三份文档写死「干净机器约 21s / 负载重 25–43s」，归因也反了 | ① `README.md` 的快速开始已改成「耗时以实跑为准、门禁目标 <25s，近期实测 21–39s 视负载而定」（`约 21s` 已删）；② `docs/testing.md` 头部改成「**以实跑为准**」+ **带条件的三段历史数据点**（t28 空载 21.3/21.4/21.5s、t9 全 idle 26.5–29.4s、t45 有并发 38.2/39.3s），并**明写归因修正**：「不是只有同机有别的重活时才慢——空载也已 26–30s，关键路径是单文件 `tests/unit/voice/frontend.test.ts`」；③ `docs/handoff.md` 的两处（五分钟自证 + 动代码前检查清单）都改成「耗时以实跑为准、空载约 27–30s」 | **真正修好**（就它这个修订号而言；数字后来被 t47 推翻 → 见 F2） |
| **F2**：`README.md` 把 perception 写成 10 项 | 现在是「**11 项**（2026-09-30 实测 `npm run test:perception` → 11/11）」；我实跑 `npm run test:perception` → **tests 11 / pass 11 / fail 0，exit 0** | **真正修好** |
| **F3**：`docs/testing.md` 写 13 个测试文件 | 现在写 **14 个**，并附了可复现的数法（`Get-ChildItem tests/unit -Recurse -Filter *.test.ts`）；`git ls-tree -r 6a6c2a4 --name-only tests/unit` 我数出 **14** → 在它那个修订号上**准确** | **真正修好**（后来被 t41 加测试变成 16 → 见 F2） |
| **F4**：§3.1 的窗口公式写成「30s × 人格 `silence_tolerance`」（照算 21s，与它自己写的 36s 冲突） | 现在写「`lingerMs`（默认 30s）×（**0.5 + 人格 `silence_tolerance`**）——是「0.5 + t」不是「× t」」，并点名代码依据是 `fsm.ts` 的 `lingerMs` getter。我读代码：`return Math.round(this.#config.lingerMs * (0.5 + tolerance));`（`tolerance === undefined` 时直接返回配置值）——公式与文档一致；文档另写「tolerance 0 → 半个窗口，1 → 1.5 倍」也与之相符；「本机 0.7 → 36 s」的例保留且正确 | **真正修好** |
| **F5**：README 的「详见 `docs/README.md` 与 `docs/handoff.md` §2/§3」两处都没有 `--personality` 内容 | 现在指向 `docs/design/domain-model.md` §6「人格属性与两种写入方式」——该节**真实存在**（我按标题定位到），且确实写了两条写入路径（`seedSelfProfile` 只补缺 / `overrideSelfProfile` 覆盖 + history）与 `cli:override` 的出处 | **落点正确**（但该节被 t45 加进去的那句是错的 → 见 F1） |

## 3. 披露的越界编辑：`domain-model.md` §6 的两条推论

t45 在 §6 末尾新增（原文照抄两句的要点）：

1. **「跨重启有效」**：两种写入都落同一张 SQLite 表 `self_profile`，所以 `npm run chat -- --personality …` **不是命令行里的临时开关**——它写进库，**进程重启、换入口（`chat` / `web` / `voice-turn`）都还在**。
2. **「回基线要再覆盖一次」**：没有「撤销」命令；`seedSelfProfile` 是 `DO NOTHING`，所以要让属性回到 `config:base` 基线必须再用 `--personality` 显式写回；逐条变更读 `self_profile_history`（带 `before_value` 与 `source_type`）。

我的核对（逐句）：

| 断言 | 我的验证 | 判定 |
|---|---|---|
| 两种写入都落 `self_profile` | 读 `packages/domain/src/store.ts`：`seedSelfProfile` 是 `INSERT … ON CONFLICT(property) DO NOTHING`；`overrideSelfProfile` 是 `INSERT … ON CONFLICT(property) DO UPDATE` + 写 `self_profile_history` | **准确** |
| **「跨重启有效」** | 表是持久化的 SQLite 表，同一入口重启后仍在 | **准确** |
| **「换入口（`chat` / `web` / `voice-turn`）都还在」** | **不成立**：四个入口各自 `openXixiStore({ dataDir })` 到**不同的库**——`scripts/chat.ts` → `data/chat`、`scripts/serve-chat.ts` → `data/web-chat`、`scripts/voice-turn.ts` → `data/voice`、`scripts/field-test.ts` → `data/field-test`（在场边另开 `data`）。我用 `node:sqlite` **只读** dump 五个库的 `self_profile` + `self_profile_history`：**只有 `data/chat/xixi.sqlite` 有 8 条 `source_type='cli:override'` 的历史、且 `verbosity`/`talkativeness` 的 `source` 是 `cli:override`**；`data/web-chat`、`data/voice`、`data/field-test`、`data/xixi.sqlite` 四个库的 `cli:override` 历史**各 0 条**、所有值都是 `config:base` | **不实（F1）** |
| 「回基线要再覆盖一次」 | `seedSelfProfile` 的 `DO NOTHING` 已在上面证实；`self_profile_history` 每条覆盖都写 `before_value` 与 `source_type`（t32 轮我也读过同一段） | **准确** |

**为什么这条要判 medium 而不是 low**：① 它是**新增**的断言，而且是**用户照着做会踩坑**的那种——用户按 README 快速开始设了人格，转头打开现场测试控制台（`data/field-test`）或试用页（`data/web-chat`）会发现人格没生效；② README 的 F5 修正**正好把用户引到这一节**，错误的模型从「设计文档角落」升格为「快速开始的下一步」；③ 正确的信息仓库里**本来就有**（`docs/handoff.md` §6 的「数据库」行、`docs/architecture.md` 的 SQLite 行都写明了三个入口三个库），所以这不是「未知事实」，而是**新写的推论与既有文档冲突却没对齐**。

## 4. findings

### F1（medium）`domain-model.md` §6 新推论「换入口都还在」与实现/既有文档冲突

- **位置**：`docs/design/domain-model.md` §6「人格属性与两种写入方式」末尾新增的第一条推论（原文含「进程重启、换入口（`chat` / `web` / `voice-turn`）都还在」）。
- **证据**：见 §3 表格最后两行——四个入口四个库；只读 dump 显示 `cli:override` 只存在于 `data/chat/xixi.sqlite`（8 条历史 + 两个属性 `source=cli:override`），其余四个库 0 条、全 `config:base`。既有文档 `docs/handoff.md` §6「数据库」行与 `docs/architecture.md` 的「SQLite」行都已写明入口↔库的对应关系。
- **requiredFix**：把该句收窄为「**同一入口下**跨重启有效」；补一句「**不同入口目前用不同的库**（`chat` → `data/chat`、`web` → `data/web-chat`、`voice-turn` → `data/voice`、现场测试控制台 → `data/field-test`），所以换入口**不会**沿用这份覆盖；要让各入口一致，要么在各自入口再覆盖一次，要么等「共享人格库」这件事被实现」。引用时用 `docs/handoff.md` §6 的数据库行 / `docs/architecture.md` 的 SQLite 行，不要写行号（§9.18）。

### F2（low）被订正过的数字又被 t41/t47 推翻：`docs/testing.md` 的两处现在是错的

- **位置**：`docs/testing.md` 头部的结论句「**当前门禁在 25–30s 一带、并不满足 <25s**」（同段还有区间「21–39s」）与 §1 表格的 unit 行「**14 个测试文件、94 项**」。
- **事实**：t47 用常驻 Python worker 把门禁显著提速——**我实跑 `npm test` 180 项只用 13.7s**（壁钟），AGENTS.md §7 现在也写「空载约 15s、有并发约 18s」，所以「并不满足 <25s」**已经过时且方向说反了**；同时 t41 新增了 `tests/unit/core/proactive-gates.test.ts` 与 `reply-segments.test.ts`，`tests/unit/` 现在 **16 个 `*.test.ts`**（`git ls-tree -r HEAD` 可数），unit 项数也早不是 94：我实跑 `npm run test:unit` → **tests 124**（全量 180）。
- **归因（不怪 t45）**：这两处的漂移由 t41（加测试）与 t47（提速）造成，而它们都没回头改这三份文档——这正是 §9.18 说的「写死计数/耗时必然再次过期」。
- **requiredFix**：把耗时结论改成 t47 之后的事实（或用一句「以实跑为准」+ 一条可复现命令替掉具体区间与结论句），并把 unit 的「14 个文件 / 94 项」更新为实测值（16 / 124），或按 §9.18 **去掉写死的文件数与项数**、只留数法命令。

### F3（low）`README.md` 的耗时措辞与 t45 自己回报的不一致，且没有带上已修正的归因

- **位置**：`README.md` 快速开始里 `npm test` 那一行（现文：「耗时以实跑为准、门禁目标 <25s，**近期实测 21–39s 视负载而定**」）。
- **事实**：t45 的完成回报称它把 README 改成「耗时以实跑为准、门禁目标 <25s，**空载约 27–30s**」，但盘上写的是「21–39s 视负载而定」——**报告与产物不一致**；且「视负载而定」恰好保留了它在 `docs/testing.md` 与 `docs/handoff.md` 里已经修正掉的那句归因（「空载也已 26–30s」）。README 只两行，不必展开归因，但至少不该给出相反的暗示。
- **requiredFix**：与 `docs/testing.md` 对齐（要么同样写「以实跑为准」并去掉秒数，要么写「空载 15–18s、有并发可到 40s 量级」这类**更新后**的区间）；顺带说明回报与产物不一致的原因，避免审计时对不上。

## 5. 观测（不改变 verdict）

- **O1（披露流程做对了，值得固化成范例）**：t45 主动披露了越界编辑、写明「已被队长周期提交收走、故未回滚」、并请评审单独核对——本任务因此能把那处编辑逐句复核（结果就是 F1）。这比让评审去 `git diff` 里撞见要好得多；建议在 §9 里把「披露越界编辑时，同时给出**它的位置与可疑点**」写成惯例。
- **O2（派单文本 ≠ 团队状态）**：t45 报告说它收到的 inScope 是 `docs/testing.md` / `README.md` / `docs/design/domain-model.md`、而 team.json 里存的是 `README.md` / `docs/testing.md` / `docs/handoff.md`（验收条数也不同）。这与 §9.19 是同一类问题，队长已收口；记录在案以免把「按存的契约做事」误判成越权。
- **O3（提交归属含糊）**：`9c1234d` 的提交信息写「t45 完成（文档五处订正）」，但它实际收录的是 t41 的实现文件（`engine.ts`/`index.ts`/`config.ts`/两个新测试）与 `docs/handoff.md`；`README.md`/`docs/testing.md`/`domain-model.md` 的改动在更早的 `6a6c2a4`。同一条提交信息还自述「npm test exit=1 [169/168/1]」。按 §9.20，建议 captain 用**追加式 `evidence_note`** 把 t45 的真实交付号写清（并说明那次红门禁是哪条用例、后来是否已绿）。

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| 只读 dump 五个入口库的 `self_profile` / `self_profile_history`（`node:sqlite`，`readOnly: true`） | `data/chat/xixi.sqlite`：**8 条 `cli:override`** 历史，`verbosity`/`talkativeness` 的 `source=cli:override`；`data/web-chat`、`data/voice`、`data/field-test`、`data/xixi.sqlite`：**各 0 条**，全部 `config:base` |
| `Select-String` 五个入口脚本的 `openXixiStore\\(|dataDir` | `chat.ts` → `data/chat`；`serve-chat.ts` → `data/web-chat`；`voice-turn.ts` → `data/voice`；`field-test.ts` → `data/field-test`（+ 在场边 `data`）；评测器 → 系统临时目录 |
| `git ls-tree -r 6a6c2a4 --name-only tests/unit` / `… HEAD …` | t45 写 14 个文件时**确实是 14**；**HEAD 已是 16**（t41 新增两个） |
| `npm run test:perception` | **tests 11 / pass 11 / fail 0，exit 0**（F2 的订正仍然正确） |
| `npm run test:unit` | **tests 124 / pass 124 / fail 0，exit 0**（文档写的 94 已过期） |
| `npm test` | **tests 180 / pass 180 / fail 0 / skipped 0**，exit 0，壁钟 **13.7s**（修订号 `7cf5291`） |
| `npm run check:docs` | 检查了 **49 份 markdown**（加入本文件后 **50 份**）；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |
| 读码（符号定位，不引用行号） | `store.ts` 的 `seedSelfProfile`（`ON CONFLICT … DO NOTHING`）与 `overrideSelfProfile`（`DO UPDATE` + history）；`fsm.ts` 的 `lingerMs` getter（`Math.round(lingerMs * (0.5 + tolerance))`）；`domain-model.md` §6 标题「人格属性与两种写入方式」存在 |

**我做过的真实外部动作**：**0 次 API 调用**（未花任何费用）、未开摄像头/麦克风、未写任何业务数据库（五个库都是 `readOnly: true` 打开）；**本轮没有任何突变或改动实验（全程只读）**，临时脚本写在 `data/` 下并已清理。
