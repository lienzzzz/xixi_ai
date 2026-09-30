# 再评审（round 3）：隐私文档「行号归零 + 三处订正」（t48，对 t34 复审 F1–F4）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t34 与 t48 的实现者）
> 日期：2026-09-30
> 评审对象：t48「repair-round-3」——修我在 t34 提的 F1（15 处代码行号里 13 处已漂移）、F2（§5 第 5 条与 §20.1 自相矛盾）、F3（`appendEvent` 调用点计数过期）、F4（校验函数名写成 `buildEvent()`）
> 交付位置：`docs/design/security-and-privacy.md` 的最后一次改动落在 **`d38b4ba`**（被队长的周期提交收走；t48 自己那次 `f148e58` 实际收录的是 `docs/design/conversation.md` 与我的 t39 评审归档——t48 在回报里如实说明了这一点，见 §5 观测 O1）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`docs/design/security-and-privacy.md`（全文 232 行）、`packages/domain/src/store.ts`、`packages/conversation/src/{engine,proactive}.ts`、`packages/contracts/src/events.ts`、`packages/contracts/schemas/{envelope.v1.json,events/proactive.decision.v1.json}`、`scripts/{field-test,serve-chat,verify-camera-presence}.ts`、`tests/unit/core/brain-error-classification.test.ts`、`tests/integration/brain-adapter.test.ts`，以及**文档自己开出的 7 条核对命令**（我逐条实跑，见 §6）
> 上一轮血缘：本任务复核的 findings 由我在 t34 评审里提出（`docs/review/residual-fix-t12-rereview-2026-09-30.md`）

---

## 1. 结论

**verdict：pass（无 blocking finding；2 条观测记在 §5，不改变判定）**

一句话：**t48 的四条修复我逐条独立验证成立，而且文档真的改成了「函数名 + 可复现命令」**——`docs/design/` 下已经**一处代码行号都没有**（`(\.ts|\.py|\.js|\.json|\.yml|\.sql):\d+` 与「第 N 行」两类模式**各 0 命中**）；文档自己开出的 **7 条 `git grep` 命令我全部实跑，命中都与文档陈述一致**（`appendEvent` 5 处调用点 + 1 行定义、`validateEvent`、四条测试名、`xixi-vad-`/`整段录音不落盘`/`pruneVoiceDir`/`handleVoice`），并且我进一步核对了它新引用的**函数名真的包着那些代码**（`handleVoiceTurn` ×2、`createFieldServer`、`runSelfTest`）；§5 与 §20.1 的矛盾按「部分实现」拆开、口径一致；调用点现在写「以实测为准、不写死（当前 5 处）」，第 5 处 `ProactiveEngine.#record` 写的是 `proactive.decision`，我确认该事件类型**在注册表、信封枚举与 schema 三处都已登记**；校验函数名也从 `buildEvent()` 改成了 `validateEvent()`，与脚本实际行为一致。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 明确 verdict + 可执行 findings（含文件与行号） | **满足** | pass；无 finding，2 条观测（带文件位置）见 §5 |
| 2 独立复核：不再钉死代码行号（抽查若干处，按文档给的 grep 命令能否定位到正确代码）、§5 与 §20.1 矛盾已消除、调用点计数与校验函数名与代码一致 | **真正满足** | 行号审计 0 命中（§2）；7 条命令逐条实跑命中正确代码（§2 表）；函数名包裹关系逐一验证（§2）；§5/§20.1 一致（§3）；调用点 5 处且第 5 处事件类型已登记（§4）；`validateEvent()` 与脚本一致（§4） |
| 3 自己跑一次 npm test 与 check:docs；结论落 `docs/review/privacy-doc-rereview-2026-09-30.md` | **满足** | `npm test` → **180 / 180 / 0 fail / 0 skipped，exit 0**（壁钟 20.8s，修订号 `1f6036f`）；`npm run check:docs` → **50 份 markdown、0 问题、exit 0**（加入本文件后复跑 **51 份**、仍 0 问题）；本文件即结论落点 |

**范围纪律**：t48 只改了它声明的 1 个文件（`docs/design/security-and-privacy.md`），未动代码、测试与契约——我核对 `f148e58` 与 `d38b4ba` 的 `--stat` 确认这一点（该文件的改动确实只在后者里），并且它的回报**主动说明了「产物随队长提交进 HEAD、最后改动落在 `d38b4ba`」**，没有冒称自己的修订号（符合 §9.20 的新规矩）。

---

## 2. F1：行号真的归零了，而且文档给的是**能跑的**命令

**（a）行号审计（我对全文与整个 `docs/design/` 目录都扫了）**

| 模式 | 命中 |
|---|---|
| `(\.ts\|\.py\|\.js\|\.json\|\.yml\|\.sql):\d+` | **0**（`security-and-privacy.md` 与 `docs/design/*.md` 全部为 0） |
| `第 ?\d+ ?行` | **0** |
| `:\d+-\d+`（区间写法） | **0** |

文档头部还新增了一条规则（第 3 行注释块：「引用代码位置的方式：**文件名 + 函数名/测试名 + 一条可复现的 grep 命令**，不写行号」，并注明「15 处行号引用曾在数小时内漂移 13 处」，指向 `AGENTS.md` §9.18）——**把教训写进了被修文档本身**，这是我在 t34 的 requiredFix 里没明确要求、但更耐久的做法。

**（b）我逐条实跑文档开出的命令（命中即下表右列）**

| 文档里的核对命令 | 我实跑的命中 | 与文档陈述一致？ |
|---|---|---|
| `git grep -n "appendEvent(" -- packages` | `engine.ts`（`#recordDecision`）、`proactive.ts`（`#record`）、`store.ts` ×3 调用 + 定义行 | **是**（文档写「当前 5 处；定义行不算调用点」） |
| `git grep -n "xixi-vad-" -- scripts/field-test.ts` | `handleVoiceTurn` 里的 `mkdtempSync(tmpdir(),'xixi-vad-')`、`countScratchDirs()`、自检断言 | **是**（文档说在 `handleVoiceTurn` 里建临时目录） |
| `git grep -n "整段录音不落盘" -- scripts/field-test.ts` | 策略说明、`handleVoiceTurn` 的返回文案、页面文案、**`runSelfTest` 的 `check('隐私策略：整段录音不落盘', …)`** | **是**（文档说自测 `runSelfTest` 里有这条断言） |
| `git grep -n "pruneVoiceDir" -- scripts/field-test.ts scripts/serve-chat.ts` | 定义 + `handleVoiceTurn` 每轮清理 + `createFieldServer` 启动清理 + `serve-chat.ts` 顶层启动清理 | **是**（文档说「两个入口都在用」） |
| `git grep -n "handleVoice" -- scripts/serve-chat.ts` | `handleVoice` 函数、路由挂载、以及「why not inline any more」注释所在的文件 | **是** |
| `git grep -n "validateEvent(" -- scripts/verify-camera-presence.ts` | 文件头说明 + 手工重建信封后的那一行校验 | **是** |
| `git grep -n "^test(" -- tests/unit/core/brain-error-classification.test.ts tests/integration/brain-adapter.test.ts` | 两个文件全部用例名，**含文档引用的那 4 条**（`a missing key arrives as MISSING_KEY before any request is attempted`、`HTTP status classes survive the adapter seam instead of collapsing into PROVIDER_FAILED`、`the DSH path keeps the harness error code in originalCode`、集成层 `a missing API key fails as MISSING_KEY before any request is attempted`） | **是** |

**（c）我额外验证的「符号真的指对了吗」**（这是只看「有没有行号」看不出来的）：文档把 §20.1 的四处引用改成了函数名，我按最近的函数声明回溯确认——

| 文档说的函数 | 被引用的那行实际所属函数 | 判定 |
|---|---|---|
| `handleVoiceTurn`（临时目录） | `export async function handleVoiceTurn(...)` 之内 | **对** |
| `handleVoiceTurn`（每轮清理） | 同上 | **对** |
| `createFieldServer`（启动清理） | `export async function createFieldServer(...)` 之内 | **对** |
| `runSelfTest`（隐私断言） | `export async function runSelfTest(...)` 之内 | **对** |

## 3. F2：§5 与 §20.1 的矛盾已按「部分实现」拆开

- §5 第 5 条现在是「**保留期与删除接口**（该项只**部分**实现）」：**音频**保留期 ✅ 已实现（`privacy.store_raw_audio` + `memory.raw_audio_retention_days` 由 `retentionPolicy()` 读取，指回 §20.1）；**对话（transcript）**保留期与**针对单条记录/单条对话的删除接口**仍未实现（指回 §20.3）。
- 已删掉那句已经站不住的「（配置项存在但无人读取）」——它与 §20.1 的「✅ 已实现（不再是「配置项无人读取」）」直接冲突，正是我 t34 的 F2。
- 我独立核了它给的旁证：`git grep -n "raw_transcript_retention_days" -- packages scripts services apps plugins tests` → **无命中**（exit 1），所以「transcript 保留期还没有读取方」这句是**真的**，§20.3 的写法与 §5 新写法一致。

## 4. F3 / F4：调用点计数与校验函数名与代码一致

- **计数**：文档不再写死「一共 4 处」，而是「以实测为准、不写死：`git grep -n "appendEvent(" -- packages`（**当前 5 处**；定义行不算）」，然后给出五行的「文件 | 函数 | 事件」表。我实跑命中**恰好 5 个调用点 + 1 行定义**，与表逐行对得上。
- **第 5 处是真事件**：`ProactiveEngine.#record` 写的是 `event_type: 'proactive.decision'`；我确认该类型**三处都已登记**——`packages/contracts/src/events.ts`（注册表）、`packages/contracts/schemas/envelope.v1.json` 的 `event_type` 枚举、`packages/contracts/schemas/events/proactive.decision.v1.json`（schema）。所以 §6 那句「每条状态变更都进事件表……对**主动开口判定**成立」是有依据的，不是把未来的东西写成现状。
- **函数名**：§6 现在写「`scripts/verify-camera-presence.ts` 把这些事件**手工重建信封对象之后**用 `validateEvent()` 校验一遍」——我读脚本确认它确实没有调用 `buildEvent`：它在文件里手工组装信封对象，然后调 `validateEvent`（`git grep` 只剩 `validateEvent(` 命中，无 `buildEvent`）。

## 5. 观测（不改变 verdict）

- **O1（提交归属，仍待回填）**：t48 的产物（这份文档）最后改动落在 `d38b4ba`，而**以它命名的那次提交** `f148e58` 收录的是 `docs/design/conversation.md` 与我的 t39 评审归档。t48 已在回报里如实说明「产物随队长提交进 HEAD、最后改动落在 `d38b4ba`」——**没有冒称修订号**（符合 §9.20）；建议队长仍按 §9.20 在 t48 上补一条**追加式** `evidence_note`，写明「交付落在 `d38b4ba`」，供后来审计引用。
- **O2（这条经验值得推广到别的文档）**：`security-and-privacy.md` 头部那行新规则（文件名 + 函数名 + grep 命令、不写行号）是**可复制的模板**。目前 `docs/design/` 下已 0 行号（我扫过），但 `docs/recon/`、`docs/verification/` 与提交说明里仍有大量行号引用（例如我自己的评审报告就引用了行号——那是「快照式证据」的正当用法，但**长期文档**应采用这份模板）。建议由队长在 `docs/design/README.md` 的写作约定里加一句，避免下一轮再出现「15 处行号 13 处漂移」。

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| 行号审计（`Select-String` 扫 `security-and-privacy.md` 与 `docs/design/*.md`） | `\.(ts\|py\|js\|json\|yml\|sql):\d+` = **0**；`第 ?\d+ ?行` = **0**；`:\d+-\d+` = **0** |
| 文档开出的 7 条 `git grep`（见 §2 表，含 `appendEvent(`、`validateEvent(`、`^test(`、`xixi-vad-`、`整段录音不落盘`、`pruneVoiceDir`、`handleVoice`） | 全部命中且与文档陈述一致 |
| `git grep -n "raw_transcript_retention_days" -- packages scripts services apps plugins tests` | **无命中**（exit 1）→ §5/§20.3 的写法成立 |
| `git grep -n "proactive.decision" -- packages/contracts/src packages/contracts/schemas` | 注册表 + 信封枚举 + schema 三处命中 |
| `git grep -n "event_type" -- packages/conversation/src/proactive.ts` | `event_type: 'proactive.decision'` |
| 函数包裹关系核对（按最近的函数声明回溯被引用行所属函数） | `handleVoiceTurn` ×2 / `createFieldServer` / `runSelfTest` —— 四处**全部正确** |
| `npm test` | **tests 180 / pass 180 / fail 0 / skipped 0**，exit 0（壁钟 20.8s；修订号 `1f6036f`，当时有成员在跑） |
| `npm run check:docs` | 检查了 **50 份 markdown**（加入本文件后 **51 份**）；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |

**我做过的真实外部动作**：**0 次 API 调用**（未花任何费用）、未开摄像头/麦克风、未写任何数据库；**本轮全程只读，没有任何突变或改动实验**，也没有产生临时脚本（全部用 `git grep` / `Select-String` 完成）。
