# 评审（round 2）：核心接线修复的语义诚实化（t31，对 t10 findings F1–F3）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t10 与 t31 的实现者）
> 日期：2026-09-30
> 评审对象：t31「repair-round-2」（修我在 t10 提的 F1 `acceptance_score` 名不符实、F2 t5 自述与当时不符、F3 计数过期），产物落在提交 `30c8160`（5 个文件：`docs/design/domain-model.md`、`docs/design/conversation.md`、`packages/contracts/schemas/events/conversation.decision.v1.json`、`tests/unit/core/acceptance-score-semantics.test.ts`、`AGENTS.md`）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`docs/design/domain-model.md` §4/§4.1、`docs/design/conversation.md` §5 与「已修（t5）」段、`packages/contracts/schemas/events/conversation.decision.v1.json`、`packages/contracts/src/events.ts`、`tests/unit/core/acceptance-score-semantics.test.ts`、`git show 30c8160`、`git show 30c8160^:<schema>`（改动前的契约）、`git log -S "a long pause is noticed without calling tick"`，以及**我自己跑的 7 条命令**（含一次可回滚的突变实验，见 §3）
> 上一轮血缘：本任务复核的 findings 由我在 t10 评审里提出（`docs/review/core-wiring-review-2026-09-30.md`）

---

## 1. 结论

**verdict：pass（无 blocking finding；2 条「观测」记在 §6，不改变判定）**

一句话：**t31 的三项修复我逐条独立验证成立**——`acceptance_score` 的真实语义（`accepted` 的 0/1 镜像、schema 的 `number` 是给 M2 留位、**不得用于阈值判断**）写进了 `domain-model.md` §4.1 与 `conversation.md` §5，并在 schema 的 `description` 上留了同一句话；**契约形状零改动**（我用 `git show 30c8160^:` 把改动前后两份 schema 做程序化比对：去掉 `description` 后**逐字节等价**，键集合、`required`、`additionalProperties:false`、`reason`/`action`/`fsm_state` 枚举、`acceptance_score` 的 `type/minimum/maximum` 全部未动）；那条新测试**不是空断言**——我做了两次定向突变，两条断言分别以它自己写明的消息失败（`acceptance_score must be exactly 0 or 1, received 0.25` 与 `the description must say the value is a 0/1 mirror`），突变后按 sha256 逐字节还原（`identical: true`、`git status` 干净）；F2 的留痕**事实正确**（那条「同名断言」确实由 t19 的提交 `7242973` 才加进 `tests/integration/conversation-engine.test.ts`）。`npm test` **139/139（0 skipped）**、`check:docs` **exit 0** 都是我自己跑的。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 明确 verdict + findings（含文件与行号） | **满足** | 本节 + §6（F1/F2 两条观测都带 `文件:行号`） |
| 2 F1 独立核对：两份文档写明真实语义，且那条测试**非空** | **真正满足** | 读 `domain-model.md:62`（标题改「四类事件」）、`:70`（事件表新增行）、`:81-98`（§4.1 五个要点）与 `conversation.md:335`；**突变实验**（§3）证明两条断言各自会因为对应的语义漂移而失败 |
| 3 契约纪律：payload 形状未被原地修改 + 升版路径已记录 | **真正满足** | 程序化比对：`validation semantics identical after removing descriptions: true`；`required` 与属性集合前后一致；`30c8160 --stat` 里 `packages/conversation/**` 为空（代码逻辑零改动）。升版路径写在 `domain-model.md:96-98` 与 `conversation.md:335`（M2 → 新增 `conversation.decision.v2.json` + 升 `SCHEMA_VERSION`，不就地改 v1） |
| 4 F2 核对：如实记录「t5 的『集成测试同名断言』当时不成立、条款 2 由 t19 完成」 | **真正满足** | 读 `conversation.md:104-114`；并自己回溯 `git log -S` → 该用例由 **t19 的 `7242973`** 引入（t5 的 `f5a54be` 里没有），与文档所述逐字相符 |
| 5 自己跑 npm test 与 check:docs 并贴结果；结论落本文件 | **真正满足** | `npm test` → **139 / 139 / 0 fail / 0 skipped，exit 0**；`npm run check:docs` → **45 份 markdown、0 问题、exit 0**；结论表与观测清单都在本文件 |

**范围纪律**：t31 的改动只落在它声明的 5 个文件上，未改任何代码逻辑、未改契约语义、未动 `docs/progress.md`（它自述的误改已回退，我也确认了当前 `docs/progress.md` 不在 `30c8160` 的改动里）；我本轮只新增本文件，另有一次**可回滚的突变实验**（改了 2 个文件、跑完即按 sha256 还原，见 §3）。

---

## 2. 逐条核对（对我 t10 的 findings）

| 我 t10 的 finding | t31 的修法 | 我的独立核对 | 判定 |
|---|---|---|---|
| **F1**：schema 声明 `acceptance_score` 是 0–1 的 `number`，但实现只写 `accept ? 1 : 0`，字段名与实际语义不符（会被误当分数用阈值消费） | ① schema 只加 `description`；② `domain-model.md` 新增 §4.1 写死「0/1 镜像 / 不是校准分数 / 不得用于阈值判断」；③ `conversation.md` §5 字段表同注明；④ 新增离线测试固化 | 读 `domain-model.md:81-98` 与 `conversation.md:335`：三点语义都在，且都给出了**代码指引**（`engine.ts` 的 `acceptance_score: acceptance.accept ? 1 : 0`、`fsm.ts` 的 `TurnAcceptance` 只有 `accept/reason/state`），不是口号。schema 的 `description` 是原句（`当前为 accept 的二值镜像（1/0）；M2 引入真实接纳度分数前不得当作连续分值消费。`）；测试断言既覆盖「入库值只能 0/1 且恒等于 `accepted ? 1 : 0`」（经引擎产出**真实**的接受+拒绝两条 decision），也覆盖「那句 description 还在」 | **真正修好** |
| **F2**：t5 的完成回报声称「复用集成测试同名断言」，但当时并不存在那条用例，条款字面直到 t19 才实现 | 在 `conversation.md` 的「已修（t5）」段追加留痕 | 读 `:104-114`；自己用 `git log -S "a long pause is noticed without calling tick" -- tests/integration/conversation-engine.test.ts` 回溯 → 唯一命中 **`7242973`（t19 修复过期状态）**；t5 的 `f5a54be` 不含该用例。文档还写明「在 t5 交付态上长停顿后的第一句依然被拒」以及修复前该用例的失败信息 | **真正修好** |
| **F3**：文档里的测试计数过期（87/87、137/137 之类） | 未改 `docs/progress.md`（误改已回退），改由 t11 统一刷新；本任务只在回报里说明 | 确认 `30c8160` 的 `--stat` 不含 `docs/progress.md`；`docs/progress.md` 里的旧计数属集成任务的收口范围 | **符合约定（不算缺陷）** |

**另外核对的两处「顺手补的」**：
- `domain-model.md` 的标题由「三类事件」改为「四类事件」并补上 `conversation.decision` 行——我对照 `packages/contracts/src/events.ts:49-64` 的注册表：确实是 **4 类**（`presence.changed` / `conversation.turn` / `conversation.decision` / `system.health`），文档行与 schema 的 `required`／可选字段**逐项对得上**（`session_id`、`turn_index`、`accepted`、`reason`、`action`、`fsm_state` 必填；`fsm_state_before`／`addressed`／`acceptance_score`／`linger_ms`／`silence_tolerance` 可选）。
- `acceptance_score` 在 `domain-model.md:70` 的表格里带「（number\|null，**但不是分数**，见 §4.1）」的指引，读者从事件表就能被引到 §4.1——这正是「一个事实只有一个权威说法 + 就地指路」的写法。

---

## 3. 那条测试不是空断言：我做的两次定向突变（证据）

我只改了**两处**，都是「语义漂移」的最小形态，跑完立刻按字节还原：

| 突变 | 期望 | 实际输出 |
|---|---|---|
| `packages/conversation/src/engine.ts` 的镜像行 `? 1 : 0` → `? 1 : 0.25` | 断言 1 失败 | `✖ acceptance_score must be exactly 0 or 1, received 0.25`（2 tests / 0 pass / 2 fail 里的第 1 条；第 2 条于是也红：`the description must say the value is a 0/1 mirror`，因为同一轮我把 schema 的措辞也删了） |
| schema 的 `description` 换成不含关键措辞的版本（去掉「二值镜像」「1/0」「不得当作连续分值消费」「M2」） | 断言 2 失败 | `✖ the description must say the value is a 0/1 mirror` |

突变与还原都是我自己的脚本按字节做的（不用 PowerShell 往返读写，遵守 §9.8）；还原后：

- `engine.ts` sha256 = `7a1c40e25ba04ca49f27f885adf07df858a5c314448f400d0706b1fcd6f95408`（与我 t22 轮记录过的 t19 修复版**同一个哈希**，说明这份代码此后没被人改过），`identical: true`；
- `conversation.decision.v1.json` sha256 = `1bb38a70534b66e310a15db64d4887df1354b4416e846e14729aca1b37b3ce8c`，`identical: true`；
- `git status --porcelain -- <这两个文件>` → **空**；重跑该测试 → **2/2 pass**。

---

## 4. 契约纪律：`conversation.decision.v1` 的形状确实没被原地改

我用 `git show 30c8160^:<schema>` 取出改动前的文件，与当前文件做结构化比对（脚本自动跑）：

| 检查 | 结果 |
|---|---|
| 去掉所有 `description` 后两份是否等价 | **true**（即没有 `type`/`enum`/`minimum`/`maximum`/`maxLength`/`pattern`/键名被触碰） |
| 顶层键 | 前后都是 `$id,$schema,additionalProperties,description,properties,required,title,type` |
| `properties` 键集合 | **完全一致**（11 个字段） |
| `required` | 前后都是 `session_id,turn_index,accepted,reason,action,fsm_state` |
| `additionalProperties` | 前后都是 `false` |
| `reason` / `action` / `fsm_state` 枚举 | 未动（`reason` 仍是 4 值、`action` 仍是 5 值、`fsm_state` 仍是 5 值） |
| `acceptance_score` 本次唯一变化 | 新增 `description`（`type:["number","null"]`、`minimum:0`、`maximum:1` 原样保留） |
| 代码逻辑 | `git show 30c8160 --stat` 中 `packages/conversation/**` **0 个文件** |

**升版路径**（验收条款 3 的后半）在文档里写清了两处：`domain-model.md:96-98`（M2 → 新增 `conversation.decision.v2.json` + 升 `SCHEMA_VERSION`，**不得就地放宽/改写 v1**，引铁律 10）与 `conversation.md:335`（同义）。这满足铁律 10「已发布的记录只能新增不能改写」的可审计要求。

---

## 5. F2 留痕的事实核对（我自己回溯，不采信文档）

`docs/design/conversation.md:109-114` 说那条用例是 t19 才加的、t5 当时只有引擎层手工 `tick` 用例。我的核对：

- `git log -S "a long pause is noticed without calling tick" -- tests/integration/conversation-engine.test.ts` → **唯一命中 `7242973`**（提交信息：「t19 修复过期状态（读取即推进）+ 在途修复快照」）；
- 该文件的全部改动历史只有 3 次：`b769f11`（初版）、`f5a54be`（t5）、`7242973`（t19）——即 t5 那次**没有**加入这条用例；
- 这条用例正是我在 t22 轮用来「换回旧代码必红」的那条（当时失败信息为 `the state a caller reads must describe now, not the last transition`），与文档写的一致。

结论：F2 这段留痕**属实**，而且它把「谁在什么时候真正修好」写清楚了，正是本条验收要的形态。

---

## 6. 两条观测（不改变 verdict）

### O1（low，属交付记录，不属仓库文件）t31 回报里的「修订号 f2f35c9」其实是它的**基线**

- **事实**：`f2f35c9` 是 t28 的提交（`t28 门禁提速（53s → 21.5s，137 项全绿）+ t26/t10 产物归档`，时间 12:58:18），里面**没有** `acceptance-score-semantics.test.ts`；t31 的产物实际落在 **`30c8160`**（13:04:47，提交信息「t31 完成（acceptance_score 语义诚实化）+ 更正 4bd5b01 的失实声明 + AGENTS.md §9.15」）。提交信息里写的是「rev f2f35c9 **起**」（作为起点），而 t31 的完成回报写成「修订号 f2f35c9」，两者混在一起会让后来审计的人去 `f2f35c9` 找产物而找不到。
- **建议**（不改仓库文件、也不需要新任务）：由 t31 的所有者或队长在 t31 上补一条**追加式** `evidence_note`，写明「基线 f2f35c9 → 交付 30c8160」；本轮 §1 与我 t32 的回报里都已记录正确哈希，审计链不断。若后续任务仍要引用 t31，请用 `30c8160`。

### O2（low，先前遗留的措辞）`conversation.md:335` 括号里的「`confidence` 字段同样用于此」

- **事实**：`acceptance_score` 是 1/0，而 envelope 的 `confidence` 是 `accepted ? 1 : 0.5`（同一份文档 `:338` 自己写着）。「同样用于此」若被读成「confidence 也取 1/0」就是错的。这句是 t5 留下的前缀，t31 只是往同一行追加了解释，**不是本次引入**。
- **建议**：下次动这一行时改成「`confidence` 由同一判断派生（接受 1 / 拒绝 0.5，见下）」，避免「1/0」被顺延到 `confidence` 上。不需要为它单开任务。

---

## 7. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node --test tests/unit/core/acceptance-score-semantics.test.ts` | **2/2 pass**，exit 0（还原突变后复跑同样 2/2） |
| `npm test` | **tests 139 / pass 139 / fail 0 / skipped 0**，exit 0（壁钟 37.1s，当时有成员任务在跑，见 AGENTS.md §7 的区间说明） |
| `npm run check:docs` | 检查了 **45 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |
| 突变实验（引擎镜像行 → `0.25`） | 断言 1 失败：`acceptance_score must be exactly 0 or 1, received 0.25` |
| 突变实验（schema 描述去掉关键措辞） | 断言 2 失败：`the description must say the value is a 0/1 mirror` |
| 还原脚本 | `engine.ts` 与 schema 均 `identical: true`，`git status` 对这两个文件为空 |
| schema 前后比对脚本（`30c8160^` vs 当前） | `validation semantics identical after removing descriptions: true`；键集合/`required`/枚举/范围均未变 |
| `git log -S "a long pause is noticed without calling tick"` / `git show 30c8160 --stat` | 该用例由 `7242973`（t19）引入；`30c8160` 不含 `packages/conversation/**`、不含 `docs/progress.md` |

**我做过的真实外部动作**：0 次 API 调用（未花任何费用）、未开摄像头/麦克风、未写任何业务数据库；除本文件外只做了上面那次**已按字节还原**的突变实验。突变用的备份与脚本都在 `data/` 下（已 gitignore），跑完已清理。
