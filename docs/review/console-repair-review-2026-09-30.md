# 评审（round 2）：现场测试控制台文档漂移修复（t29，对 t9 findings F1 与三处入口说明）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t9 与 t29 的实现者）
> 日期：2026-09-30
> 评审对象：t29「repair-round-2」（修我在 t9 提的 F1 文档漂移：自检项数 / 门禁表述 / 测试计数与耗时；新增三处入口说明；给设备验收报告补「口径变更说明」），4 个改动文件：`README.md`、`docs/testing.md`、`docs/handoff.md`、`docs/recon/field-test-report-2026-09-30.md`
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`README.md`、`docs/testing.md`、`docs/handoff.md`、`docs/recon/field-test-report-2026-09-30.md`、`package.json`、`scripts/chat.ts`、`packages/domain/src/store.ts`、`packages/conversation/src/fsm.ts`、`tests/unit/core/chat-personality-args.test.ts`、`git show 71102ab`（t29 提交）、`git ls-tree 71102ab`（当时真实文件数），以及**我自己跑的 10 条命令**（见 §5）
> 上一轮血缘：本任务复核的 findings 由我在 t9 评审里提出（`docs/review/console-implementation-review-2026-09-30.md`）

---

## 1. 结论

**verdict：needs_revision**（5 条 finding：1 medium + 4 low；都不是功能缺陷，全部是「文档自述与实测/代码不一致」，其中两条是**本次修复自己新写错的数字**）

一句话：**t29 的修复主体是真的**——自检项数 31 与我实跑一致、README 与 `docs/testing.md` 的门禁表述已正确反转为「tests/console 与 tests/perception 已在 `npm test` 里」、`--fake` 离线语义与「怎么造停顿」两处新说明我逐条对照实现验过、全仓 `npm run X` 引用**零悬空**、验收报告的「口径变更说明」**保留 FAIL 且数字与报告证据表一致**；需要修的只有文案里的 4 组数字/指向，但其中 2 组正是这次修复**新写错的**（perception 项数、unit 测试文件数），另 1 组（干净机器 21s）我在安静的机器上连跑三次都**复现不出来**，所以不能判 pass。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 明确 verdict + findings（含文件与行号） | **满足** | 本节 + §3（F1–F5 都带 `文件:行号`） |
| 2 自检项数 31 与文档一致 | **真正满足** | 我实跑 `node scripts/field-test.ts --self-test` → 末行「自检结果：**31 项通过 / 0 项失败**」，exit 0；`README.md:61`、`docs/testing.md:144`、`docs/handoff.md:59` 三处都写 31 |
| 3 README 门禁表述 + 计数/耗时与我自己实跑的 `npm test` 一致 | **部分不成立（F1 / F2 / F3）** | 「已接入」写对了（`README.md:98-101`）；计数 **139 = unit 94 + integration 19 + perception 11 + console 15** 与我分目录实跑**逐项一致**；但同一段 `README.md:100` 把 perception 写成 **10 项**（实为 11），`docs/testing.md:17` 把 unit 写成 **13 个测试文件**（实为 14），耗时「干净机器约 21s」我连跑三次得 **26.5 / 29.2 / 29.4s**（node `duration_ms`），**复现不出来** |
| 4 `voice:noise --fake` 离线语义 + 如何造停顿 | **真正满足** | 读 `docs/testing.md:276`（离线语义）与 §3.1（`:156-172`）；并**实跑双向**：`--fake --tiers 3` → exit 0、`mode=offline-plumbing`、`quality.applies=false`；`--fake --tiers 3 --max-endpoint-delay 1` → **exit 1**、`PIPELINE-BROKEN`（`ENDPOINT_DELAY>1ms`），与文档「结构性问题离线也 exit 1」一致 |
| 5 `--personality` 持久化行政覆盖 + 回基线需再覆盖一次 | **真正满足（附 F5）** | `README.md:42-45` 写清了「持久化行政覆盖（写 self_profile，重启后仍生效；要回基线就再覆盖一次）」；代码侧成立：`store.ts:584-618` 是 `self_profile` 的 UPSERT + `self_profile_history` 记录，`seedSelfProfile` 只补缺不覆盖。**但指向的「详见」两处都没有这个内容** → F5 |
| 6 全仓 `npm run X` 引用与脚本一致 | **真正满足** | 我自己扫（排除 `node_modules/`、`.git/`、`.agent-teams/`、`data/`）：`package.json` 23 个脚本，文档/代码里 25 个不同 token，**悬空 0 个**；3 个未命中都是通配或占位符：`npm run verify:*`（AGENTS.md:34、docs/testing.md:185）、`npm run demo:m0:*`（ADR-0006:82）、字面占位符 `npm run X`（我 t9 的报告） |
| 7 自己跑 npm test 与 check:docs 并贴结果；结论落本文件 | **真正满足** | `npm test` **139 / 139 / 0 fail / 0 skipped，exit 0**（三次）；`npm run check:docs` → **42 份 markdown，0 问题，exit 0**；结论、结论表与 findings 清单都在本文件 |

**范围纪律**：t29 只改了它声明的 4 个文件（`git show 71102ab --stat` 另含 `AGENTS.md`，那是队长文件、由 t29 在同一提交里落笔，符合「队长所有的文件成员不得直接改」的约定），未动代码、契约、迁移与测试；我本轮只新增本文件。

---

## 2. 我为什么判 needs_revision 而不是 pass

t9 的 F1 就是「产物自述已过时」——**这次修复的目标就是「不再让文档写错数字」**。而本次修复的 diff 里：

- 新加的一行 `README.md:100`（perception 行）把实为 **11 项**写成 **10 项**；**同一个提交**的 `docs/testing.md:5`/`:22` 与 `docs/handoff.md:67` 都写 11，属于**自相矛盾**；
- 改动的一行 `docs/testing.md:17` 把「12 个测试文件」改成 **13 个**，而 t29 自己的提交点 `71102ab` 上 `tests/unit` 下**实际有 14 个 `*.test.ts`**（我用 `git ls-tree -r 71102ab --name-only tests/unit` 数出，且在**那个提交上就已经是 14**，不是后来涨的——`git diff 71102ab..HEAD -- tests` 为空）；
- 耗时那一档写「干净机器上实测 21.3 / 21.4 / 21.5s」，我在**安静机器**（见 §4）上连跑三次得 26.5–29.4s，且长尾单文件本身就要 ~21s。

三处都是**可核对的数字**，check:docs（只查链接/引用/新鲜度）不会拦。若判 pass，等于把「文档写了不存在的数字」又留进主分支——这正是 t9 判 needs_revision 的同一类问题。

---

## 3. findings（按严重度排序）

### F1（medium）耗时那一档与我实跑不一致，且归因反了

- **位置**：`docs/testing.md:6-7`、`README.md:40`、`docs/handoff.md:30`
- **文档写的**：「壁钟：干净机器上实测 **21.3 / 21.4 / 21.5s**（t28 连续三次）」、「同机同时有别的重活时会退化到 **25–43s**」、`README.md:40`「2026-09-30 实测 139 项，**干净机器约 21s**」
- **我实测的**（同一棵树、同一台机器、前台跑、无并发任务）：`npm test` 三次 → node 自报 `duration_ms` **26468 / 29173 / 29375**，壁钟 **27.4 / 30.1 / 30.0s**；同批 `agent_teams_status` 显示另外 5 名成员都是 **idle**，且常驻 harness 进程（PID 13452）3 秒采样只占 8 核的 **0.7%**
- **为什么这不只是「浮动」**：单独跑长尾文件 `node --test tests/unit/voice/frontend.test.ts` 就要 **21.0s 壁钟 / 20845ms**（其中并发组 20586ms），即**一个文件就已压在 21s 上**；全集还要同时跑 perception（转发 Python）与 console（起 HTTP + Python VAD）。所以「全集干净机器 21.3s」在**当前这棵树**上不仅我复现不出来，而且与 21s 这个下限相矛盾
- **影响**：`AGENTS.md` §7 的默认门禁目标是 **<25s**；文档声称 ~21s 会让读者以为门禁仍达标，而实测已到 27–30s（这正是「用一次运行输出的数字去写死进三份文档」的必然结果，见 §9.18）
- **requiredFix**：在安静机器上重测，把三处数字改成**带日期与条件的区间并包含当前值**（或按 §9.18 直接去掉秒数、改为「以实跑为准，目标 <25s」），并修正「只有同机有别的重活才退化」这一归因（我的三次都在成员全 idle 时测的）。

### F2（low）`README.md:100` 把 perception 写成 10 项，实为 11 项

- **位置**：`README.md:100`（同一段落 `:98-99` 的 console 15 项是对的）
- **证据**：我实跑 `npm run test:perception` → **tests 11 / pass 11 / fail 0**；同一个提交的 `docs/testing.md:5`「perception 11」、`:22`「11 项」、`docs/handoff.md:67`「11 项」都写 11；`git diff 71102ab..HEAD -- tests` 为空，说明 t29 提交时它就是 11
- **requiredFix**：`10 项` → `11 项`（或去掉写死项数）。

### F3（low）`docs/testing.md:17` 把 unit 写成 13 个测试文件，实为 14 个

- **位置**：`docs/testing.md:17`（该行后半「94 项」是对的）
- **证据**：`git ls-tree -r 71102ab --name-only tests/unit` 中 `*.test.ts` 共 **14** 个（含 `voice/frontend.test.ts` 与 6 个 `core/` 文件）；HEAD 同样是 14；`git diff 71102ab..HEAD -- tests` 为空，故**在 t29 提交那一刻就已经数错**，不是后来漂移
- **requiredFix**：`13 个测试文件` → `14 个测试文件`，或按 §9.18 只保留可推导的项数、不写死文件数。

### F4（low）跟进窗口的公式写成了乘法，照字面算不出 36 s

- **位置**：`docs/testing.md:157`（t29 新增的 §3.1 第一段）
- **原文**：「会话的跟进窗口 = `lingerMs` 30s × 人格 `silence_tolerance` 缩放（本机人格 0.7 → **36 s**）」
- **实际实现**：`packages/conversation/src/fsm.ts:77-83` → `Math.round(this.#config.lingerMs * (0.5 + tolerance))`；即 `30_000 × (0.5 + 0.7) = 36_000`。照文档字面 `30 × 0.7 = 21`，与它自己给的 36 s 对不上；`tests/unit/core/chat-personality-args.test.ts:144` 用 `silence_tolerance = 1 → engine.lingerMs === 45_000` 也印证是 `0.5 + t`
- **requiredFix**：写成「30s ×（0.5 + `silence_tolerance`）（本机 0.7 → 36 s）」。

### F5（low）README 指的两处「详见」里没有 `--personality` 的内容

- **位置**：`README.md:44-45`——「详见 `docs/README.md`（文档地图/接手须知）与 `docs/handoff.md` §2/§3」
- **证据**：我在 `docs/` 下全文搜 `personality` / 「行政覆盖」：`docs/handoff.md` **0 命中**（§2「五分钟自证」与 §3「现状矩阵」都没有 `--personality`）；`docs/README.md` 只有一条 `packages/domain/src/personality.ts` 的索引行，**没有「用户须知」小节**。真正写清 `cli:override` 的是 `docs/design/domain-model.md:177`。t29 自己的回报第 5 节第 2 条也承认了这一点，却仍把指向留在 README 里
- **requiredFix**：把「详见」改指向 `docs/design/domain-model.md` 的人格覆盖小节（或直接删掉该指向）；若队长愿意补「用户须知」，再由 t11/队长落笔。

---

## 4. 我独立验证「确实修好了」的部分（不是读自述）

| 被验证项 | 我的做法 | 结果 |
|---|---|---|
| 自检项数 = 31 | 直接跑 `node scripts/field-test.ts --self-test` | 末行「自检结果：**31 项通过 / 0 项失败**」，exit 0；`README.md:61`、`docs/testing.md:144-147`、`docs/handoff.md:59` 三处一致，且都注明「以末行为准」 |
| console 与 perception 已进 `npm test` | 读 `package.json:15` 的 glob（含 `tests/console/**` 与 `tests/perception/**`）并核对三个 `test:*` 单跑脚本 | glob 与 `README.md:98-101`、`docs/testing.md:21-22`、`:132-133`、`:152-154` 一致 |
| 计数 139 = 94 + 19 + 11 + 15 | 分四次跑 `test:unit` / `test:integration` / `test:perception` / `test:console` | 94 / 19 / 11 / 15，全部 exit 0；与 `docs/testing.md:5` 逐项一致 |
| 同表旧项数（t29 顺带修正） | 单跑两条文件 | `tests/unit/voice/frontend.test.ts` → **14**（文档 7→14 正确）；`tests/integration/conversation-engine.test.ts` → **10**（文档 8→10 正确） |
| `--fake` 离线语义（含「结构性问题仍 exit 1」） | 双向实跑 | `--fake --tiers 3` → exit 0、`mode=offline-plumbing`、`verdict=PIPELINE-OK`、`quality.applies=false`；`--fake --tiers 3 --max-endpoint-delay 1` → **exit 1**、`PIPELINE-BROKEN`（`ENDPOINT_DELAY>1ms(728)` 等），与 `docs/testing.md:276` 一字不差 |
| §3.1「管道造不出停顿」 | 读实现与已有证据 | 文档引用 t9 观察时**明确标注为「t9 复核观察」而不冒充自己的实测**（`docs/testing.md:163`），这是 t29 值得肯定的做法；「>36s 窗口」的窗口值来源见 F4 |
| 全仓 `npm run` 引用 | 自写脚本扫全部 `.md/.ts/.mjs/.js/.json/.yml`（排除 node_modules/.git/.agent-teams/data） | 悬空 **0**；未命中的 3 个都是通配（`verify:*`、`demo:m0:*`）与占位符 `npm run X` |
| 口径变更说明保留 FAIL | 读报告 `:3-26` 与证据表 `:105-106`、`:189/:195`（JSON） | 结论「扬声器 **FAIL**」保留；能量比 **2.41 dB** 与分位 **6.04 dB** 与 JSON 里的 `mean` 逐字一致；11.83 / 2.69 的出处（`docs/verification/field-test-verification-2026-09-30.md:217-219`）我核对**引用正确**，且写明不是功能坏了 |
| `--personality` 的持久性 | 读 `store.ts:584-618`（UPSERT + history）、`scripts/chat.ts:146-156` | 覆盖写的是 `self_profile` 表（进程重启后仍在，`seedSelfProfile` 只补缺），「回基线需再覆盖一次」成立 |
| 机器确实是安静的（F1 的前提） | `agent_teams_status` + 采样常驻 harness 进程 CPU | 5 名成员全 idle；PID 13452 三秒内只消耗 0.16s CPU（8 核的 0.7%）；无 python 进程 |

---

## 5. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `npm test`（第 1 次） | tests **139** / pass 139 / fail 0 / skipped 0，exit 0；`duration_ms` **26468**，壁钟 **27.4s** |
| `npm test`（第 2 次） | 139/139/0/0，exit 0；`duration_ms` **29173**，壁钟 **30.1s** |
| `npm test`（第 3 次） | 139/139/0/0，exit 0；`duration_ms` **29375**，壁钟 **30.0s** |
| `npm run test:unit` / `test:integration` / `test:perception` / `test:console` | **94 / 19 / 11 / 15**，全部 pass，exit 0 |
| `node --test tests/unit/voice/frontend.test.ts` | 14/14 pass，exit 0；壁钟 **21.0s**，`duration_ms` **20845**（并发组 20586ms） |
| `npm run check:docs` | 检查了 **42 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |
| `node scripts/field-test.ts --self-test` | **31 项通过 / 0 项失败**，exit 0 |
| `node scripts/verify-voice-noise.ts --fake --tiers 3` | exit **0**，`mode=offline-plumbing`、`verdict=PIPELINE-OK`、`quality.applies=false` |
| `node scripts/verify-voice-noise.ts --fake --tiers 3 --max-endpoint-delay 1` | exit **1**，`verdict=PIPELINE-BROKEN`，`ENDPOINT_DELAY>1ms(728/704/864/704)` |
| `node data/rev-tmp/npmrefs.mjs`（我自写的引用审计） | 23 个脚本 / 25 个 token；悬空 **0** |
| `git show 71102ab --stat`、`git ls-tree -r 71102ab --name-only tests/unit`、`git diff 71102ab..HEAD --stat -- tests` | t29 只改 5 个文件（4 个在册 + `AGENTS.md`）；提交点上 unit 有 **14** 个测试文件；此后 tests 无改动 |

**我做过的真实外部动作**：0 次 API 调用（未花任何费用）、未开摄像头/麦克风、未写任何数据库；只新增本文件，临时脚本与输出都在 `data/` 下（已 gitignore）。

---

## 6. 给下一个修复任务的建议（3 个文件、5 处文案）

1. `README.md:40`（耗时）＋ `:100`（10→11）＋ `:44-45`（指向）；
2. `docs/testing.md:6-7`（耗时与归因）＋ `:17`（13→14）＋ `:157`（窗口公式）；
3. `docs/handoff.md:30`（耗时）。

修完只需重跑 `npm run check:docs`（exit 0）与一次 `npm test`（139/139）；**不需要改任何代码、测试或契约**。另外建议：这三处「干净机器 21s」属于 §9.18 说的写死漂移源，最省事的修法是**只留目标（<25s）与「以实跑为准」**，不再复制具体秒数到三份文档。
