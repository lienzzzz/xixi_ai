# 评审：过期状态修复（t19 / t6-F1）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t19 实现者 core-engineer、t6 验证者与 captain 的复核）
> 日期：2026-09-30
> 评审对象：t19「修复：长停顿后第一句仍被拒（`engine.state` 为过期缓存，生产代码无人调用 `tick`）」
> 复核对象：t6 / `docs/verification/field-test-verification-2026-09-30.md` §8.1 F1（判定 t5 该条款失败的那条）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`packages/conversation/src/engine.ts`、`tests/integration/conversation-engine.test.ts`、`scripts/chat.ts`、`scripts/serve-chat.ts`、`docs/design/conversation.md`、`data/chat/xixi.sqlite`（只读），以及**我自写的引擎探针**与**把 pre-fix 引擎换回去跑同一个测试**的对照实验

---

## 1. 结论

**verdict：pass（无 blocking finding）**

一句话：**这一次的修复是真的，而且我把它钉到了「修复前必红」的程度**——我把 `packages/conversation/src/engine.ts` 换成修复前（`2a3dd52`）的版本，`tests/integration/conversation-engine.test.ts` 里那条新测试**立刻失败**，失败信息正是 t19 声称的那句 `the state a caller reads must describe now, not the last transition`；换回修复版后同一命令通过。这是比「读代码 + 看现有绿测」强得多的证据：**它证明这条回归测试真的能挡住回归**（原测试之所以放过 bug，正是因为它在断言前手工 `engine.tick()`）。我自己另写的引擎探针也独立复现了 F1 的 before/after：不调用任何 `tick()` 的情况下推 10 分钟，修复版读到 `IDLE`、第一句 `ACCEPTED_WAKE_OR_DIRECT`。文档里被证伪的说法（「该拒绝分支不可达」）已按真实行为改写，并且**明确保留了「这句话错在哪」**。真实事件日志里有 `accepted=false` 样本，t19 给的复现命令我照抄执行、成功复现。

| 维度 | 判定 |
|---|---|
| t19 条款 1（生产路径不再依赖手工 tick，读取即推进，并说明理由） | **真正满足**（`engine.state` / `snapshot()` 走 `#advance()`；理由写在代码注释与文档 §1） |
| t19 条款 2（新增回归测试：不显式 tick；修复前必失败） | **真正满足，且由我实证**（见 §3.2：换回 pre-fix 引擎即 FAIL） |
| t19 条款 3（可复现命令 + 前后对比） | **满足**：`node --test --test-name-pattern "a long pause is noticed without calling tick" …` 通过；t19 还**主动更正**了派单建议里 `npm run chat -- --fake` 管道喂 stdin **无法**演示超时的问题（readline 缓冲），我核对这条更正成立（§4） |
| t19 条款 4（更正 conversation.md 被证伪的说法） | **满足**（§4：旧结论被逐条指出错在哪，新结论与实现一致） |
| t19 条款 5（真实日志留下 accepted=false 样本 + 复现步骤） | **满足**（§5：真库有 2 条，t19 给的命令可执行） |
| t19 条款 6（`npm test` 全绿 + `check:docs`） | **我自己复跑**：`npm test` **139/139**、`check:docs` **exit 0**（数字已从当时的 120/125 增长，属正常演进） |
| 改动范围（inScope 纪律） | **干净**：t19 只声明并只改了 3 个路径；`chat.ts` / `serve-chat.ts` **一行未动**（这正是「在引擎层一次覆盖三个调用方」的好处） |

---

## 2. 逐条核对 t19 的 6 条验收标准

| # | 条款 | 判定 | 我的核对方式与结果 |
|---|---|---|---|
| 1 | 生产路径不再依赖手工 tick（读取即推进或各入口先 tick，二选一并说明理由） | **真正满足** | `engine.ts` 新增 `#advance(now = this.#clock())`：同步人格窗口 → `fsm.tick(now)` → 返回状态；`get state()`、`snapshot()`、`buildPrompt()` 与 `respond()` 都经由它（`respond` 用**本轮自己的 `at`**，所以回放仍可复现）。理由写在 `:119-147` 的注释里（「把推进当调用方义务正是这次的失败模式」）并同步进文档 §1。**重要**：`scripts/chat.ts`、`scripts/serve-chat.ts` 确实**没有**被改（见 `git log`），说明 fix 是在引擎层一次覆盖三个调用方——比在三个入口各补一行 `tick()` 更不易漏 |
| 2 | 新增回归测试：不显式 tick 的情况下复现「长停后第一句被拒、第二句才接受」，修复后第一句即被接受；**修复前必须失败** | **真正满足（我实证）** | 测试体（`tests/integration/conversation-engine.test.ts` 同名用例）用测试自有的 `clock`，推 10 分钟后直接读 `engine.state` 与 `snapshot().state`，再照 `chat.ts` 的写法传 `addressed = engine.state === 'IDLE'`；**该用例体内没有任何 `engine.tick()`**（文件里唯一一处 `:288` 的 `engine.tick(...)` 在**另一条**用例里，且那条用例自己明确写着「tick() 作为显式接口保留」）。**换回 pre-fix 引擎后该测试 FAIL** → §3.2 |
| 3 | 给出可复现命令与前后对比 | **满足** | 命令 `node --test --test-name-pattern "a long pause is noticed without calling tick" tests/integration/conversation-engine.test.ts` 我实跑：**1/1 pass**。t19 同时**更正**了派单方建议的 `npm run chat -- --fake` 管道演示法与事实不符（先到的行被 readline 缓冲，两条 `conversation.turn` 时间戳只差 6 ms）——我核对这条更正**成立**（§4） |
| 4 | 更正 conversation.md 里已被证伪的说法（「该拒绝分支不可达」+ chat.ts 语义） | **满足** | §4：`:92-102` 现在的表述是「**仍然不可达，但现在的理由不同了**」，并**逐条说明旧结论错在哪**（修复前调用方读到过期 `LINGERING` → 转发 `addressed:false` → 决策时 FSM 已 `IDLE` → **分支真的被走到了**）。调用方表补齐了 `field-test.ts`（`:76`），并保留 t5 的历史段落（`:104`） |
| 5 | 真实事件日志里留下至少一条 `conversation.decision` 且 `accepted=false`，并说明如何复现 | **满足** | §5：真库现有 **25 条** decision，其中 **2 条** `accepted=false`（seq 45 与 seq 120，均为 `REJECTED_SUSPENDED`）。t19 给的复现命令我**照抄执行成功**并新增了第 2 条 |
| 6 | `npm test` 全绿（当时写 120 项）+ `check:docs` 通过 | **我自己复跑，成立** | `npm test` → **tests 139 / pass 139 / fail 0 / exit 0**；`npm run check:docs` → **39 份 markdown、0 问题、exit 0**。（139 是后续任务新增用例后的数字；我在报告里标了「我自己跑」以免混同自述） |

---

## 3. 我亲自做的验证

### 3.1 引擎级 F1 复现（不调用任何 `tick()`）

自写探针（只用 `ConversationEngine` 公开接口，库建在系统临时目录，全程**不调用** `engine.tick()`）：

```text
line1                        {"accepted":true,"reason":"ACCEPTED_WAKE_OR_DIRECT","stateNow":"LINGERING","lingerMs":36000}
after 10min pause, no tick() {"state":"IDLE","snapshotState":"IDLE"}
line2                        {"accepted":true,"reason":"ACCEPTED_WAKE_OR_DIRECT"}
```

- `lingerMs = 36000` ⇒ 人格 `silence_tolerance=0.7` 确实被读进来（30000 × 1.2）。
- 推 10 分钟后 **`engine.state` 与 `snapshot().state` 都报 `IDLE`**（过期缓存问题消失，且两者对同一时刻一致）。
- 第一句（停顿后的那句）**被接受**。

**与修复前对比**：把同一序列喂给修复前的引擎（`2a3dd52` 的 `engine.ts`），line 2 会读到过期的 `LINGERING` → `addressed=false` → **`REJECTED_NOT_ADDRESSED`**（我在 t10/t15 两轮里用同一方法复现过两次，见 `docs/review/core-wiring-review-2026-09-30.md` §3.2；本轮的 pre-fix 对照见 §3.2 的测试失败信息）。

### 3.2 决定性证据：把 pre-fix 引擎换回去，新测试立刻红

方法（可复制）：

```powershell
# 1) 取出修复前的引擎源码
git show 2a3dd52:packages/conversation/src/engine.ts > <pre-fix 副本>
# 2) 用 pre-fix 版本替换 packages/conversation/src/engine.ts，跑那条测试，随即按字节恢复
node data/t22/prefix-engine-test.mjs
```

实测输出（脚本先在内存里保存原文、`finally` 里按字节写回并用 sha256 校验恢复）：

```text
before: engine.ts sha256 = 7a1c40e2…5408 bytes = 16316
pre-fix (2a3dd52) engine.ts contains #advance: false

=== 1) control: working-tree engine ===
✔ a long pause is noticed without calling tick(): the first line after it is a wake-up, not a rejection (54.6ms)
ℹ tests 1 | pass 1 | fail 0

=== 2) pre-fix engine (2a3dd52) ===
exit code: 1
✖ a long pause is noticed without calling tick(): the first line after it is a wake-up, not a rejection
ℹ tests 1 | pass 0 | fail 1
  AssertionError [ERR_ASSERTION]: the state a caller reads must describe now, not the last transition

restored: sha256 = 7a1c40e2…5408 | identical: true | bytes: 16316
```

`git status --porcelain -- packages/conversation/src/engine.ts` → **空**（干净）。

**这条证据回答了本任务最关键的疑问**：「新测试到底能不能挡住回归，还是像原测试那样在断言前自己 tick 一下就过关？」——它是真的会红，而且红的正是那条被修复的行为。

---

## 4. 文档更正核对（`docs/design/conversation.md`）

| 要核的点 | 现状 | 判定 |
|---|---|---|
| 「该拒绝分支不可达」 | `:92` 改为「因此在这两个真实入口上，『`IDLE` 且未直呼』这条拒绝分支**仍然不可达，但现在的理由不同了**——不是『它们按状态传对了』，而是『读到的状态和决策用的状态出自同一时刻』」；`:95-98` 逐条写清修复前的链路（读过期 `LINGERING` → 转发 `addressed:false` → 决策时已 `IDLE` → **分支真的被走到了** = F1 现象）与修复后的窗口（读与决策之间只隔一次函数调用，**同一个 `at`**） | **已按真实行为更正**，且把「旧说法错在哪」留在了原地（比单纯删掉更有价值） |
| chat.ts 语义 | `:104-110` 保留 t5 的历史与归因：旧代码用局部变量 `first`（**只在第一句**传 `addressed:true`），跟进窗口超时回 `IDLE` 后**后面每一句**都被拒；并说明 t5 改成「按状态传」后**当时没发现状态本身是过期的**，两处缺陷叠加才表现为「长停后第一句被拒」 | **与事实一致**（我核过 `chat.ts:228` 现在就是 `const addressed = engine.state === 'IDLE'`；`serve-chat.ts:135` 同语义） |
| 调用方表 | `:74-77` 三行分别给出 `serve-chat.ts` / `chat.ts` / `field-test.ts` 的同一规则（`engine.state === 'IDLE'`） | **补上了 `field-test.ts`**（t19 声明里承诺的动作） |
| t19 新增的文档面 | §1「状态读取即推进」（`:34-46` 含 `respond()`/`buildPrompt()`/`snapshot()` 各自用哪个时刻）、§5 时序第 ⓪ 步 `before = advance(at)`（`:259`）、真实拒绝样本复现小节（`:278-285`）、维护规则（`:364` 把 `#advance` 写进触发条件） | **都在**（我逐处读到） |
| 一条值得保留的张力 | `:99`「真实入口上**唯一稳定的拒绝是 `SUSPENDED`**（点过「今天安静点」/ 输入过 `/quiet` 之后）」 | **成立**，且我在 §5 用真库样本佐证（唯一的拒绝样本就是 `REJECTED_SUSPENDED`）。它同时说明：修复后「`IDLE` 未直呼」这条分支在日常使用中确实很难走到——文档没有把「窄竞态」说成常态 |

**关于 t19 对派单建议的那处更正**：派单文本建议用 `npm run chat -- --fake` 管道喂 stdin 演示超时；t19 报告说这样**演示不了**（readline 把先到的行缓冲住，生产者延迟 45 s、壁钟 46.2 s，但两条 `conversation.turn` 的 `timestamp` 只差 6 ms）。我在 t10 轮里恰好独立跑过同样的命令（两行输入 → 两轮 `SPEAK`、无拒绝），**与它的更正一致**；因此「可复现命令」这一条我判给的是 `--test-name-pattern` 那条测试级命令，而不是管道演示。

---

## 5. F9：真实事件日志里的拒绝样本与复现步骤

**样本**（只读查询 `data/chat/xixi.sqlite`）：

```text
conversation.decision total: 25   （评审当时；执行复现后为 26）
accepted=false: 1 → 2
  seq 45  | 2026-09-30T12:19:52.853+08:00 | schema_version 1 | confidence 0.5
  payload: {"session_id":"sess_8a45586a-…","turn_index":0,"accepted":false,"reason":"REJECTED_SUSPENDED",
            "action":"SILENCE","fsm_state":"SUSPENDED","fsm_state_before":"SUSPENDED","addressed":false,
            "acceptance_score":0,"linger_ms":36000,"silence_tolerance":0.7}
by reason: {"ACCEPTED_WAKE_OR_DIRECT":14,"ACCEPTED_CONTINUATION":10,"REJECTED_SUSPENDED":1}
```

**复现步骤我照抄执行**（t19 给的命令）：

```powershell
"`n/quiet`n西西，你在吗？`n/exit" | npm run chat -- --fake
```

实测输出（节选）：

```text
已进入安静模式（/resume 恢复）。
西西: 未接受（REJECTED_SUSPENDED）：西西正处在安静模式，用 /resume 恢复。
```

随后日志新增 **seq 120**（`accepted=false, REJECTED_SUSPENDED, fsm_state=SUSPENDED, action=SILENCE, confidence=0.5`）→ **复现步骤可执行、可重复**。`conversation.decision` 的 11 个 payload 键并集与文档 §6 一致，**没有**任何可能装用户原话或模型推理的键（铁律 5）。

**仍存在的空白（如实记录，不构成本次 finding）**：唯一稳定的真实拒绝样本是 `SUSPENDED`；`REJECTED_NOT_ADDRESSED` 的真实样本仍然为 0。t19 修好的是「长停后第一句被正确地**接受**」，而不是「让 NOT_ADDRESSED 更常见」——后者需要电视/无人直呼那类输入，实测不可靠（试听/扬声器路径也做不到）。这条我留给 captain 决定是否值得再派单。

---

## 6. 复核 t6 的 F1 与 captain 的复核

| 来源 | 说法 | 我的复核 |
|---|---|---|
| t6 §8.1 F1（medium） | 长停顿后第一句仍 `REJECTED_NOT_ADDRESSED`；根因 `engine.state` 是缓存 + 全仓无生产调用 `engine.tick()`；集成测试能过是因为它显式 `tick()`（`conversation-engine.test.ts:243`） | **全部成立**，我用「pre-fix 引擎 + 新测试」实证了「修复前必红」（§3.2），并用引擎探针复现了行为差异（§3.1） |
| captain 复核 | 全仓生产代码零 `engine.tick(` 调用；`chat.ts:127` / `serve-chat.ts:135` 依赖 `engine.state` | **一致**。补充一个当下的事实：`tests/integration/conversation-engine.test.ts:288` 现在**唯一**一处 `engine.tick()` 出现在「长停顿关闭会话，下一句被接受」那条老用例里（它自己也注明 tick 是显式接口），而**新的那条不 tick 的用例**才是生产路径的回归保护 |

---

## 7. 我实际跑过的命令与结果（可核账）

| 命令 | 结果 |
|---|---|
| `node data/t22/engine-check.mjs`（自写探针，不调用 tick） | line1 接受 / `lingerMs 36000`；推 10 分钟后 `state` 与 `snapshot().state` 均为 `IDLE`；line2 `ACCEPTED_WAKE_OR_DIRECT` → §3.1 |
| `node --test --test-name-pattern "a long pause is noticed without calling tick" tests/integration/conversation-engine.test.ts` | **1 / 1 pass**，exit 0 |
| `node data/t22/prefix-engine-test.mjs`（换入 `2a3dd52` 的 engine.ts 再换回，字节级校验） | 控制组 PASS；pre-fix 组 **FAIL（exit 1）**，`AssertionError: the state a caller reads must describe now, not the last transition`；恢复后 sha256 与原文一致、`git status` 干净 → §3.2 |
| `node data/t22/rejection-check.mjs`（只读真库） | 25 条 decision、1 条 `accepted=false`（seq 45）；键并集 11 个、无原话/推理类键 |
| `"`n/quiet`n西西，你在吗？`n/exit" \| node scripts/chat.ts --fake` | 输出「未接受（REJECTED_SUSPENDED）…」；日志新增 seq 120 → §5 |
| `npm test` | **tests 139 / pass 139 / fail 0 / exit 0** |
| `npm run check:docs` | **39 份 markdown；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；exit 0** |
| `git log` / `git show 2a3dd52:…` / `git status` | t19 只改声明过的 3 个路径；`chat.ts`、`serve-chat.ts` 未被 t19 触碰；换入换出后工作区干净 |

**真实 API 调用：0 次**（本任务全部可用离线替身与只读查询完成）。**合规说明**：§3.2 的换入-换出窗口只有一次子进程（<5 s），原文先读进内存、`finally` 里按字节写回并做了 sha256 校验（实测一致），`git status` 亦为空；未修改任何实现代码的**最终状态**、未触碰 `.env`、未改他人文档；`data/t22/`（探针与 pre-fix 副本）**已删除**。

---

## 8. 结论表

| # | 维度 | 判定 |
|---|---|---|
| 1 | 修复是否真的让生产路径不再依赖手工 tick | **是**：`state`/`snapshot()`/`buildPrompt()`/`respond()` 都经 `#advance()`；CLI 一行未改 |
| 2 | 回归测试能否挡住回归 | **能，已实证**：换回 pre-fix 引擎立刻 FAIL 于 `must describe now, not the last transition`；该用例体内无 `engine.tick()` |
| 3 | 行为前后对比（我独立复现） | 修复前 line 2 被拒；修复后 line 2 `ACCEPTED_WAKE_OR_DIRECT`（且 `state`/`snapshot()` 一致） |
| 4 | 文档是否正确更正被证伪的说法 | **是**：保留「不可达」这句话但**改写了理由**，并把旧说法错在哪写清；调用方表补 `field-test.ts`；§1/§5/拒绝样本小节/维护规则同步 |
| 5 | 真实拒绝样本与复现步骤 | **有**（2 条 `REJECTED_SUSPENDED`），复现命令我照抄可跑、可重复；`REJECTED_NOT_ADDRESSED` 的真实样本仍为 0（未修，非本任务范围） |
| 6 | 门禁 | `npm test` **139/139**、`check:docs` **exit 0**（我自己跑的） |
| 7 | inScope 纪律 | 干净：只改声明过的 3 个路径 |

**总判定：pass**。t19 的核心主张（「读取即推进」修好了 F1、回归测试在修复前必失败、文档按事实更正、真实日志有拒绝样本）**每一条都能被我独立复核**，其中「修复前必失败」是我用换入 pre-fix 引擎跑同一条测试拿到的**决定性证据**。没有 blocking finding。

**两条不阻塞的观察（已记，不必在本轮处理）**：
1. 「真实入口上唯一稳定的拒绝是 `SUSPENDED`」与「`IDLE` 未直呼分支仍不可达（窄竞态）」并存是**诚实**的，但这也意味着 `REJECTED_NOT_ADDRESSED` 这条路径在真机上至今没有真实样本；若将来要做电视/无人直呼的误触率评估，需要一个**确定性的**注入方式（例如语料评测器显式传 `addressed:false`，文档 `:101` 已提到这条路）。
2. `engine.state` 从纯 getter 变成「带副作用的 getter」（会改时钟与人格窗口）是本次修复的核心取舍，t19 已把代价写进代码注释与文档（「store 关闭后勿再读 state」等）。这类契约变化影响所有调用方，建议在收尾的架构/进度文档里再点一次名，便于下一个人评估「读状态」是否还有别的隐藏代价。
