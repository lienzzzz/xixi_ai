# 评审：CLI 库路径开关与三处文档同步（t68 + t66）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t68 实现与 t66 文档）
> 评审对象：`ee00fb2`「t68 + t66 一起入库：CLI 库路径开关与未知参数报错，以及三处文档同步」（被评代码 `scripts/field-test.ts`，被评文档 `README.md`、`docs/testing.md`、`docs/design/domain-model.md`）
> 复核方式：**按文档现在写的说法逐条实跑**（起真服务、换真库、敲错参数看退出码），不采信提交信息里的自述；本报告是唯一写入产物
> 权威来源（读过/跑过的）：`scripts/field-test.ts` 的 `FIELD_TEST_USAGE` / `parseFieldCliArgs` / `main` / `createFieldServer`（`ee00fb2` 版本逐字读过，导出副本与工作区 CLI 区域做过逐字节比对）、`packages/domain/src/store.ts` 的 `worldState` / `recordPresenceChanged`、上述三份文档，以及我自己跑的 12 组命令（见 §6）

---

## 1. 结论

**verdict：pass（无 blocking finding；4 条观测记在 §7，都不改变判定，其中两条是「将来的漂移源」而不是当下的错话）**

一句话：**t68 的三条可观察行为我都亲手复现了**——`--help` 列出两个开关与默认值且退出 0；`--data-dir` / `--presence-data-dir` **真的换库**（新库按当前默认 seed：`proactivity=0.7`、阈值 `0.54`；默认库 `data/field-test` 的既有值 `0.65` 分毫未动）；未知参数、缺值、非法端口、裸位置参数**一律中文报错 + exit 2**。t66 的三处文档与实现**逐条对得上**，连它给的那条逐字示例命令我都原样跑了（无 `--port`，走默认 8792，起得来）。唯一需要解释的现象是**在途 t70 的半成品**在我核对途中造成的瞬时红灯（§5），它与 t68 无关，我也给出了归因证据。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 按文档现在写的说法实测：`--help` 是否列出两个开关、`--data-dir` 是否真的换库（新库按默认 seed、阈值 0.54）、未知参数是否 exit 2；并核对三处文档的开关名、默认值与命令可跑 | **真正满足** | §3（CLI 实跑 6 项 + 换库的库内证据）、§4（三处文档逐条对齐 + 逐字示例命令实跑） |
| 2 自己跑一次 `npm test` 与 `npm run check:docs` 并贴结果 | **满足（附 §5 的在途归因）** | §6：`npm test` 首次 **192/192 exit 0**（`duration_ms 19234.9`）；`check:docs` **59 份 / 0 问题 / exit 0**。核对后期工作区多出 t70 的未跟踪测试，全套变成 **200/199/1**，那 1 条失败在 t70 自己的新用例里 |
| 3 结论落 `docs/review/field-cli-and-docs-review-2026-09-30.md` | **满足** | 本文件 |

---

## 2. 被评代码到底长什么样（先把「我评的是哪一版」钉住）

- 交付点：`ee00fb2`（t68 只改 `scripts/field-test.ts`；t66 只改三份文档，两者同一提交，理由是「分开提交会让文档立刻漂移」——这个判断是对的）。
- 我开工时 HEAD 已到 `65fc8a2`，但 `git diff --stat ee00fb2..65fc8a2` 只有 `AGENTS.md`（4 行，环境事实更正），**`scripts/field-test.ts` 与三份文档在该区间零改动**，所以 `ee00fb2` 就是当前实现。
- 工作区有 **t70（常驻主动考虑循环）的在途改动**（`scripts/field-test.ts` +567/−1 等）。我没有拿工作区当被评对象：我把 `ee00fb2` 的 `scripts/field-test.ts` 导出成副本，与工作区做**CRLF 归一后的逐字节比对**，从 `const FIELD_TEST_USAGE` 到文件末 **9908 字符两边完全相同**，即 CLI 解析、用法文本、`main` 的退出码逻辑在 HEAD 与工作区里是同一份字节。§6 里那条比对命令可重跑。

---

## 3. 按文档的说法逐条实跑

| # | 文档说 | 我实跑 | 结果 |
|---|---|---|---|
| 3.1 | `--help` 列出 `--data-dir`（默认 `data/field-test`）与 `--presence-data-dir`（默认 `data`） | `node scripts/field-test.ts --help` | **exit 0**，两行都在，默认值就写在行内（`（self_profile / 事件日志；默认 data/field-test）`、`（默认 data，与感知边共用）`）；用法还自己声明「**不认识的参数会报错并以 exit 2 结束**」 |
| 3.2 | 不认识的参数会中文报错 + exit 2（列出可用参数） | `node scripts/field-test.ts --bogus` | **exit 2**：`不认识的参数「--bogus」——现场测试控制台不会忽略它，以免你以为某个开关生效了。` + `下一步：可用参数：--port <值>、--data-dir <值>、--presence-data-dir <值>、--self-test、--acceptance、--offline、--no-tts、--dsh、--no-open、--help、-h。` |
| 3.3 | 缺值要报错（文档只写了「不认识」与 exit 2） | `node scripts/field-test.ts --data-dir` | **exit 2**：`--data-dir 后面需要一个值。`（并给了一行例子）；`--port abc` → exit 2；裸位置参数 `extra` → 与 3.2 同样式 exit 2 |
| 3.4 | `--data-dir` 真的换库，新库按当前默认 seed | `npm run field-test -- --offline --no-open --data-dir data/field-test-70 --presence-data-dir data/presence-70 --port 8871` → `GET /api/field/state`、`/api/field/proactive` | `database.path=data/field-test-70`、`database.presencePath=data/presence-70`、`personality.proactivity=0.7`；**门槛端点报 `proactivity 0.7 / threshold 0.54`**（14 个门禁）；页面 `HTTP 200 / 44696 字节`。库文件真的落在指定目录：`data/field-test-70/xixi.sqlite` 已生成（同目录另有 `-wal`/`-shm`） |
| 3.5 | 「换库」不只是显示变了（我的加严检查） | 用 `node:sqlite` 直查两个库的 `self_profile` | 新库 `data/field-test-70`：`proactivity = 0.7`、`source = config:base`、`updated_at 15:11:08+08:00`（我的运行时刻，即**从当前配置默认值 seed**）；默认库 `data/field-test`：`proactivity = 0.65`、`source = console:proactivity`、`updated_at 14:59:47+08:00`（**早于我的运行**）→ 开关把写入真正改道了，默认库没被碰 |
| 3.6 | `--presence-data-dir` 换「在场状态投影读的库」 | 我先用真实 `recordPresenceChanged({present:true, confidence:0.91})` 在临时目录造了一个带 `presence.home` 的库，再 `--presence-data-dir data/rev-tmp/t69-presence` 起服务 | `presence.mode=projection`、`text=有人在场`、`present=true`、`confidence=0.91`、`source=perception`、`ttlSeconds=60`、`stale=true` 并带「投影已过期（超过 TTL）：这是「上次看到人」而不是「现在有人」」；**不带该开关时同一状态块是 `mode=not-integrated`/「未接入」** → 这个开关驱动的是**读取**，不是页面文案 |
| 3.7 | 默认值（文档三处都写「默认 `data/field-test` 与 `data`」） | 不带任何库开关起一次：`node scripts/field-test.ts --offline --no-open --port 8872` | `database.path = E:\worker2\data\field-test`、`database.presencePath = E:\worker2\data` → 与文档、与 `--help`、与代码默认（`options.dataDir ?? join(REPO_ROOT,'data','field-test')`、`options.presenceDataDir ?? join(REPO_ROOT,'data')`）四处一致 |
| 3.8 | `--help` 说：`--self-test` 用独立临时目录，两个目录开关「在这个模式下不生效（会明确提示，不静默忽略）」 | `node scripts/field-test.ts --self-test --data-dir data/whatever` | 先打印提示「…所以 --data-dir / --presence-data-dir 在这个模式下不生效；要指定库就直接起控制台（不加 --self-test）。」，再跑自检：**自检结果：31 项通过 / 0 项失败，exit 0** |

**代码侧与行为一致**（我读过 `ee00fb2` 的解析器，非仅凭实跑）：`FIELD_CLI_VALUE_FLAGS = ['--port','--data-dir','--presence-data-dir']` 与 `FIELD_CLI_BOOLEAN_FLAGS = [7 个布尔 + '--help','-h']` 两张白名单；值型开关缺值（`undefined` 或以 `-` 开头）与非法端口各自返回具名错误；解析失败 `main()` **返回 2**，只有启动期异常才把 exit code 设为 1；`--help` 在绑定端口之前 `return 0`（不会占端口，也不会顺带把服务起起来）。

---

## 4. 三处文档逐条核对（开关名 / 默认值 / 命令可跑）

核对命令（可重跑，避免用行号）：`git grep -n -e data-dir -e presence-data-dir -- README.md docs/testing.md docs/design/domain-model.md`

| 文档 | 它写的 | 我的核对 |
|---|---|---|
| `README.md`（常用命令块） | `npm run field-test -- --data-dir data/field-test-70`，注释「换控制台自己的库（self_profile / 事件日志；默认 data/field-test）；在场状态用 --presence-data-dir（默认 data）；不认识的参数会中文报错并 exit 2」 | 开关名、默认值、退出码三条**都成立**；`npm run … --` 的转发形式我实跑过（§3.4 就是 npm 形式），不是照着 `node` 直接跑猜的 |
| `docs/testing.md`（现场测试命令块） | 同上两行 | 与 README 一字不差地一致；`data/field-test` / `data` 与 §3.7 实跑一致 |
| `docs/design/domain-model.md` §6 | 「库路径由两个 CLI 开关决定：`--data-dir <目录>`（…默认 `data/field-test`）与 `--presence-data-dir <目录>`（在场状态，默认 `data`）」+ 逐字示例命令 + 「实测：库文件 `xixi.sqlite` 会落在指定目录里」+「不认识的参数会中文报错并以 exit 2 结束（消息里列出全部可用参数），不再静默忽略」+「核对方式：`node scripts/field-test.ts --help`——本节以它的实际输出为准」+ 老版本回退（挪目录 / 传 `createFieldServer` 选项） | 四条事实全对（分别由 §3.1–3.6 覆盖）；**它把示例命令逐字给我了，我原样跑了一遍**（`node scripts/field-test.ts --offline --no-open --data-dir data/field-test-70 --presence-data-dir data/presence-70`，不加 `--port`）→ 起在默认 `http://127.0.0.1:8792`，启动打印「库（self_profile / 事件日志）：data/field-test-70（--data-dir）」与「在场投影读的库：data/presence-70（--presence-data-dir）」，`/api/field/state` 与它一致；回退说法也与代码一致（`runSelfTest`/设备验收确实传 `dataDir`/`presenceDataDir` 选项指向临时目录） |

**没有发现旧说法残留**：`docs/design/domain-model.md` 那句「目前没有 CLI 开关，`--help` 里也没有」以及随附的「`argv.includes` 只认 8 个开关 / `main()` 静默忽略未知参数」在本次改动里被**整段替换**（`git show ee00fb2 -- docs/design/domain-model.md` 可见 −10/+10），而不是新旧并存。

---

## 5. 时序与在途（为什么 §6 里有一次红灯，以及它归谁）

1. **核对前半段（15:11–15:13）**：工作区只有 t70 的**源码**在途改动（无新测试文件），全套 `npm test` = **192 tests / 192 pass / 0 fail / exit 0**（`duration_ms 19234.9`），`check:docs` = 59 份 / 0 问题 / exit 0。
2. **核对中途出现一次瞬时不可解析**：`node scripts/field-test.ts --help` 一度 **exit 1**，报 `ERR_INVALID_TYPESCRIPT_SYNTAX`，位置在 `function pxPlayClips(clips, gapMs)` 附近的页面脚本段；约 30 秒后（第 4 次重试）自行恢复。**归因证据**：`pxPlayClips` 在 `ee00fb2` 里**不存在**（`git grep -c pxPlayClips -- scripts/field-test.ts` 在 HEAD 为 0、工作区为 2），它属于 t70 在途新增的页面函数——这是**他人半成品写入窗口**，不是 t68 的缺陷（AGENTS.md §9.10 的第 ① 类）。因为 CLI 区域与 HEAD 逐字节相同（§2），我此前跑到的 `--help`/exit 2/换库三条结论仍然绑定 HEAD 的代码。
3. **核对后半段**：工作区又多出 t70 的未跟踪测试 `tests/console/proactive-loop.test.ts`，全套变成 **200 tests / 199 pass / 1 fail**，唯一失败是 t70 自己的用例 `lastUserTurnAt reads the fact from the log, and only user turns count`（对应在途新增的 `lastUserTurnAt`）。**归因证据三连**：该文件 `git cat-file -e HEAD:tests/console/proactive-loop.test.ts` → exit 128（HEAD 里没有）；只跑**已跟踪**的 console 测试 `node --test (git ls-files "tests/console/*.test.ts")` → **27/27 pass, exit 0**；失败用例名里就是 t70 的符号。**所以：t68 交付的那棵树在公开门禁上是绿的，当下这一条红属于 t70 的在途工作。**
4. **顺带一条措辞观察**：`docs/review/domain-model-rereview-2026-09-30.md`（我的 t64 复核报告）仍写着「目前没有 CLI 开关 / 未知参数静默忽略」。那是**当时的快照**，按本队惯例不必改写；但它记录的正是**现在被 t68 关掉的那条 finding**（本次实测 exit 2 + 开关真换库），所以引用那份报告的人要配套读本文件。

---

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node scripts/field-test.ts --help` | exit 0；两个开关与默认值都在（§3.1） |
| `node scripts/field-test.ts --bogus` / `--data-dir`（缺值）/ `--port abc` / `extra` | 全部 **exit 2**，中文报错 + 可用参数列表（§3.2–3.3） |
| `npm run field-test -- --offline --no-open --data-dir data/field-test-70 --presence-data-dir data/presence-70 --port 8871` | `database.path`/`presencePath` 随开关变；`proactivity 0.7`、`threshold 0.54`、14 门禁；页面 200/44696 字节（§3.4） |
| `node data/rev-tmp/t69-profile.mjs`（**我自写**：`node:sqlite` 只读直查两个库的 `self_profile`） | 新库 `0.7 / config:base`；默认库 `0.65 / console:proactivity`（§3.5） |
| `node data/rev-tmp/t69-make-presence.mjs <目录>`（**我自写**：用真实 `recordPresenceChanged` 造在场投影） | `presence.home = present / confidence 0.91 / ttl 60s` |
| `node scripts/field-test.ts --offline --no-open --presence-data-dir data/rev-tmp/t69-presence --data-dir data/rev-tmp/t69-console --port 8873` | `presence.mode=projection`、`有人在场`、`confidence 0.91`、`stale=true`（§3.6） |
| `node scripts/field-test.ts --offline --no-open --port 8872`（不带库开关） | 默认库实跑：`E:\worker2\data\field-test` 与 `E:\worker2\data`（§3.7） |
| `node scripts/field-test.ts --self-test --data-dir data/whatever` | 先「不生效」提示，再 **31 项通过 / 0 项失败，exit 0**（§3.8） |
| `node scripts/field-test.ts --offline --no-open --data-dir data/field-test-70 --presence-data-dir data/presence-70`（**domain-model §6 的逐字示例**） | 起在默认 8792；启动打印两个库路径；状态与它一致（§4） |
| `node data/rev-tmp/t69-cli-diff.mjs`（**我自写**：把 `ee00fb2` 导出的副本与工作区做 CRLF 归一逐字节比对） | 从 `const FIELD_TEST_USAGE` 到文件末 **9908 = 9908 字符，完全相同**（§2） |
| `npm test` | **192 / 192 pass / 0 fail，exit 0**（`duration_ms 19234.9`）。核对后期（t70 未跟踪测试入库前）**200 / 199 / 1 fail**，那 1 条在 t70 自己的用例里（§5） |
| `node --test (git ls-files "tests/console/*.test.ts")` | 已跟踪的 console 测试 **27 / 27 pass，exit 0**（在途红的归因证据，§5） |
| `npm run check:docs` | 检查了 **59 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |

---

## 7. 观测（都不改变 verdict）

- **O1（低，将来的漂移源）**：三处示例目录名把「当前默认值」写进了名字——`data/field-test-70` 里的 `70` 正对应默认 `proactivity=0.70`（README、`docs/testing.md`、`docs/design/domain-model.md` 各一处，domain-model 还多一个 `data/presence-70`）。这个默认值本轮已经被改过一次（t58：0.55→0.70），下次再调（例如改回 0.55 或升到 0.8），四个示例名会一起变成误导，而它们看起来「像是规定」。建议改成中性名（`data/field-test-alt`），或在行尾注明「70 只是随手起的目录名」。
- **O2（低，用户可见文案的数字）**：`README.md` 与 `docs/testing.md` 仍写死「`--self-test` … **31 项**」，而同一次改动的 `--help` 里已经刻意不写死（「项数会随回归断言增加…看最后一行的『自检结果：N 项通过』」）。我这次实跑正好是 **31 项通过 / 0 项失败**，所以**当下不失实**，两处也都带了「以末行为准」的 hedge；但按 AGENTS.md §9.18，写死计数是已知漂移源——下次自检项数变化时要同时改三处（含 `--help` 里那句历史注解）。**留作提醒，不要求现在改。**
- **O3（低，终端观感）**：用法文本里的 Markdown 强调符会**原样打到终端**——`node scripts/field-test.ts --help` 输出里有 `**不写死数字**——看它最后一行的…` 和 `**不认识的参数会报错并以 exit 2 结束**（中文说明 + 可用参数列表）`。在 `--help` 文字里去掉星号（或改用「」）即可，纯观感问题。
- **O4（信息，边界与快照）**：① 值型开关「缺值」的判定是 `value.startsWith('-')`，因此理论上无法用 `--data-dir -x` 这类以 `-` 开头的目录名（Windows 下无实际影响，记录边界即可）；② `docs/review/` 里的历史评审快照（含我自己的 t64 复核）仍按当时状态写着「没有 CLI 开关」，见 §5.4。

---

## 8. 我做过的真实外部动作

**0 次 API 调用**（全部离线：`--offline` 与替身模型，未花任何费用）、**未开摄像头/麦克风**、未改任何业务库的**人格与事件内容**。具体：我起过 4 个**本机**控制台（8792 / 8871 / 8872 / 8873）用于实测，全部已关闭（四个端口现在都无人监听）；为核对「换库」造的目录 `data/field-test-70`、`data/presence-70` 与临时库 `data/rev-tmp/t69-console`、`data/rev-tmp/t69-presence` **核对完已删除**（`data/` 已 gitignore）。唯一对既有库的接触：§3.7 那次「不带库开关」的实测按设计在 `data/field-test` 写了一条**会话记录**（该库是本地控制台库，我没有动其中的 `self_profile`）。探针脚本留在 `data/rev-tmp/`（`t69-cli-diff.mjs`、`t69-profile.mjs`、`t69-make-presence.mjs`、`t69-presence.mjs`、`t68` 的 HEAD 导出副本），它们不是本任务的交付物——本任务的交付物只有本文件。
