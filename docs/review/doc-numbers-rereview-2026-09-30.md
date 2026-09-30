# 再评审：文档数字与归因订正（t53，对 t46/t51 带出的漂移）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t53 的实现者）
> 日期：2026-09-30
> 评审对象：t53「人格覆盖不跨入口 + 文档数字与归因按实测改正」，交付修订号 **`f485d01`**（只改 `docs/design/domain-model.md`、`docs/testing.md`、`README.md`，+34/−22）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`README.md`、`docs/testing.md`、`docs/design/domain-model.md`（§6 人格覆盖）、`docs/handoff.md`；代码侧 `scripts/{chat,serve-chat,voice-turn,field-test}.ts` 的 `openXixiStore` 调用点（**HEAD 与工作区各看一遍**）；以及**我自己跑的 8 组命令**（见 §5，含 `git ls-files` 计数与四条分层测试）
> 上一轮血缘：本任务复核的订正来自我在 t30/t34/t46/t51 的 findings 与 t53 自报的「180 vs 工作区 189」问题
> 说明：引用代码位置用「文件 + 函数/命令」；数字都带复核命令或实测日期

---

## 1. 结论

**verdict：needs_revision**（2 条 finding：都是 low，且都在同一份文件里）

一句话：**t53 的三项订正主体成立且做得好**——四入口与数据库的对照与 `git grep openXixiStore` 的结果**逐条一致**，三条失实归因**不再作为事实存在**（两条被明确标注「已作废，不要引用」，一条整句删掉），数字也都改成了「带日期的实测点 + 以实跑为准」（并且它主动写明了「文档 180／工作区 189」的原因，我实测正是 189）；**但同一份 `docs/testing.md` 里有两处新写的、可一条命令就证伪的东西**：① 它给的「unit 文件数」命令实际输出 **9**，而旁边写着 **16**；② §6 缺口说 `tests/audio-fixtures/` 有「**36 个 wav**」，而 t53 自己的提交点与 HEAD 上都是 **35**（我按盘上和 git 各数一遍）。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 独立核对：四入口↔数据库 与 `git grep openXixiStore` 一致；三条失实归因已不在文档里；数字是否写成「带日期实测点 + 以实跑为准」而非裸数字 | **前两项成立；「数字」这一项露出两处可证伪的裸数字（F1/F2）** | 见 §2 / §3 / §4 |
| 2 自己跑一次 npm test 与 check:docs 并贴结果；结论落 `docs/review/doc-numbers-rereview-2026-09-30.md` | **满足（但当前树是红的，已定性归因）** | `check:docs` → **53 份 markdown、0 问题、exit 0**；`npm test` → **189 / 186 / 3 fail，exit 1**，三条失败**全部**来自他人未提交的在途文件 `tests/console/proactive-console.test.ts` 与同一批页面改动（详见 §5 与观测 O1）；文档所述「180 = 124+30+11+15」我用**已跟踪**的四层逐一核过，**完全成立** |

**范围纪律**：t53 只改了它声明的三个文件；我本轮**只新增本文件**，全程只读（没有 stash、没有改动他人文件）。

---

## 2. 四入口 ↔ 数据库的对照（验收条款 1 第 1 项）

文档现在写的（`domain-model.md` §6 + `README.md` 快速开始）：`chat.ts` → `data/chat`、`serve-chat.ts` → `data/web-chat`、`voice-turn.ts` → `data/voice`、`field-test.ts` → `data/field-test`，核对命令 `git grep -n "openXixiStore" -- scripts`，并明确「在 chat 里改过人格，打开试用页也是新人格**不成立**」，还带一条「修正记录」说明原句错在哪。

**我实跑的结果**（HEAD）：`chat.ts` 的 `openXixiStore({ dataDir: join(REPO_ROOT, 'data', 'chat') })`、`serve-chat.ts` → `'data', 'web-chat'`、`voice-turn.ts` → `'data', 'voice'`、`field-test.ts` → `options.dataDir ?? join(REPO_ROOT, 'data', 'field-test')`（另有一条**只读**的在场路径 `data`）。**四处逐条一致** ✓；命令也真能定位到这四处（它还顺带命中 demo/verify 等脚本，读者能一眼分辨）。

**判定：成立。**（一处前瞻见观测 O2：工作区里 `chat.ts`/`serve-chat.ts` 正在被改成可被 `XIXI_CHAT_DATA_DIR`/`XIXI_WEB_DATA_DIR` 覆盖，落地后这句要加「可用环境变量覆盖」的限定。）

## 3. 三条失实归因（验收条款 1 第 2 项）

t53 的提交说明称删掉三条：**「空载也要 26–30s」**、**「<25s 目标达不到」**、**「只有并发才慢」**。我按关键词在 `README.md` / `docs/testing.md` / `docs/handoff.md` / `docs/design/domain-model.md` 里搜：

| 原来的说法 | 现在的状态 |
|---|---|
| 「只有并发才慢」/「视负载而定」 | **整句已删**（README 那行现在写「耗时以实跑为准——空载约 14–16s、同机有并发约 18s，不设秒数目标」） |
| 「空载也要 26–30s」「<25s 目标达不到」 | **不再作为事实出现**：它们在 `docs/testing.md` 头部被**明确标注**为「本文早先那句……**已作废**，不要引用」，并指向 `AGENTS.md` §9.9 |

**判定：成立。** 我理解「已不在文档里」是指「不再被当作事实陈述」；留下带「已作废」标记的历史引文是**更好的做法**（读者会看到旧数字为什么变、去哪里看新口径），我不把它算成 finding，只在此记录清楚免得验收时误判。

## 4. 数字的写法（验收条款 1 第 3 项）——两处例外

**做对的部分**：`testing.md` 头部把总数写成「2026-09-30 实测 **180 项**：unit 124 + integration 30 + perception 11 + console 15」，并接一句「**一切以 `npm test` 末行为准**：同一时刻别人在加用例，总数就会更高（测量当时工作区里没有他人未提交的测试）」——**它自己就点名了「文档 180 / 工作区 189」的原因**；README 同样写「2026-09-30 实测 180 项……耗时以实跑为准」；分层表把「16 个测试文件、124 项」「4 个文件、30 项」都配了数法命令；`brain-adapter` 6 项、`conversation-engine` 15 项、`frontend.test.ts` 单文件 ~9s 这些也都与我的实测吻合（**6 / 15 / 8.1s**）。

**两处例外（findings）**：

### F1（low）「unit 文件数」的数法命令与它旁边的数字不符

- **位置**：`docs/testing.md` §1 分层表的「单元」行——「**16 个测试文件、124 项**（……文件数用 `git ls-files "tests/unit/**/*.test.ts"` 可数，项数用 `npm run test:unit`）」。
- **事实**：该命令我实跑 **输出 9 行**（`tests/unit/**/*.test.ts` 只匹配**至少一层子目录**里的文件，漏掉直接放在 `tests/unit/` 下的 7 个），而正确数是 **16**。要数出 16 需要把顶层也算上：`git ls-files "tests/unit/*.test.ts" "tests/unit/**/*.test.ts"` → **16**（我也实跑了）。同一份文档里**总数**那条命令 `git ls-files "tests/**/*.test.ts"` 是**对的（23）**，因为它所有测试文件都在至少一层子目录里。
- **危害**：这是**验证命令**，读者一敲就得到 9，与文档自称的 16 冲突——正好违反它自己刚立的「能推导/能实跑就别写死」的规矩。
- **requiredFix**：把该行命令改成 `git ls-files "tests/unit/*.test.ts" "tests/unit/**/*.test.ts"`（或 `git ls-files "tests/unit/**" | Select-String "\.test\.ts$"`），或直接去掉文件数只留项数（`npm run test:unit` 输出 124 ✓）。

### F2（low）§6 缺口的「36 个 wav」是错的裸数字

- **位置**：`docs/testing.md` §6 已知缺口第 3 条——「`tests/audio-fixtures/` 与噪声夹具**已经存在**（**36 个 wav**，含 6 档 SNR）」。
- **事实**：`git ls-tree -r f485d01 --name-only tests/audio-fixtures` 里 `*.wav` = **35**；`HEAD` 同样是 **35**；盘上也是 **35**（顶层 5 + `noisy/` 30，且没有任何未跟踪/被忽略的 wav）。也就是说**在 t53 自己的提交点上就是 35**，不是后来被删的。
- **危害**：它恰好是这次验收要防的那类数字——**裸数字、没有复核命令、且与实测不符**；而它的邻居（项数、耗时）都已经改成了「实测点 + 命令」。
- **requiredFix**：改成「**35 个 wav（顶层 5 + `noisy/` 30，6 档 SNR）**，核对：`git ls-tree -r HEAD --name-only tests/audio-fixtures | Select-String "\.wav$"`」，或干脆删掉数字只留目录（夹具会继续增加）。

## 5. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `git grep -n "openXixiStore" -- scripts` | `chat.ts` → `data/chat`、`serve-chat.ts` → `data/web-chat`、`voice-turn.ts` → `data/voice`、`field-test.ts` → `data/field-test`（+ 只读在场 `data`）→ 与文档逐条一致 |
| `git log --oneline -4 -- tests/audio-fixtures` / `git ls-tree -r {f485d01,HEAD} --name-only tests/audio-fixtures`（数 `.wav`） | 两处都是 **35**（顶层 5 + noisy 30）→ F2 |
| `git ls-files "tests/unit/**/*.test.ts"` vs `… "tests/unit/*.test.ts" "tests/unit/**/*.test.ts"` | **9 vs 16** → F1 |
| `git ls-files "tests/**/*.test.ts"` | **23** → 与文档「23 个 `*.test.ts`」一致 |
| `npm run test:unit` / `test:integration` / `test:perception` | **124 / 30 / 11**，全部 pass → 与文档的 124/30/11 一致 |
| `node --test tests/console/field-test-console.test.ts`（已跟踪的那份） | **15 项 / 14 通过 / 1 失败**：失败项是 `the page is Chinese, self-describing and carries the boot state`（页面文案断言，被在途的页面改动弄红） |
| `node --test tests/integration/brain-adapter.test.ts` / `…/conversation-engine.test.ts` | **6/6**、**15/15** → 与文档的 6 项、15 项一致 |
| `node --test tests/unit/voice/frontend.test.ts` | **14/14 pass**，壁钟 **8.1s**（`duration_ms 8012`）→ 与文档「t47 之后单文件约 9s」吻合 |
| `npm test`（当前工作区） | **189 / 186 / 3 fail，exit 1**；三条失败全部在**未跟踪的在途文件** `tests/console/proactive-console.test.ts` 内 → 见 O1 |
| `npm run check:docs` | 检查了 **53 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |

## 6. 观测（不改变 verdict）

- **O1（当前树是红的，已定性，不归 t53）**：`npm test` 现在 `189 / 186 / 3 fail`。三条失败分别来自未跟踪文件 `tests/console/proactive-console.test.ts`（`proactive-console.test.ts:188/258` 两处）与**已被同一批页面改动弄红的**已跟踪断言 `the page is Chinese, self-describing and carries the boot state`。工作区里 `scripts/{chat,serve-chat,field-test}.ts` 都有未提交改动（+160 行量级，正是「把音频出口接上分段播放 + 控制台主动性卡片」）。按 AGENTS.md §9.10：这是**成员在途半成品窗口**，与 t53 的文档无关；**核实文档数字应当用已跟踪的那四层**，我用它们核出的 180 = 124+30+11+15 **完全成立**。
- **O2（前瞻：入口↔数据库那句要加限定）**：工作区里 `chat.ts` 变成 `process.env.XIXI_CHAT_DATA_DIR ?? data/chat`、`serve-chat.ts` 变成 `XIXI_WEB_DATA_DIR ?? data/web-chat`。**这批改动一旦落地**，`domain-model.md` §6 与 `README.md` 的「四个入口各自打开自己的库」就需要补「（可用 `XIXI_*_DATA_DIR` 覆盖，覆盖后多个入口可以指向同一个库）」——否则读者按核对命令会看到新变量，与「不跨入口」的结论对不上。建议把这一句写进那批接线的验收里。
- **O3（鼓励）**：t53 主动把「文档 180 与工作区 189 不一致」交出来请人复核，并且写成「一切以 `npm test` 末行为准」——**这正是验收条款 3 想要的效果**：我实测 189（含在途 9 项）恰好复现了它描述的情形。这种「把不确定写进文档、并给出判定依据」的做法值得继续。

**我做过的真实外部动作**：**0 次 API 调用**（未花任何费用）、未开摄像头/麦克风、未写任何数据库；全程只读，未 stash 或改动他人文件。
