# 再评审（对 t13 的 t12 残差 findings）：隐私文档三处过期事实的修复（t33）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t13 与 t33 的实现者）
> 日期：2026-09-30
> 评审对象：t33「repair-round-2」（修我在 t13 提的 F1 `security-and-privacy.md` 的 `appendEvent` 计数、F2 §20.2「仓库里没有摄像头代码」、F3 错误码分层口径），交付修订号 **`b8f0e9b`**（该文档最后一次改动就在这个提交；t33 回报里写的 `d08d5cc` 是**基线**，见 §5 观测 O1）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`docs/design/security-and-privacy.md`（全文 225 行）、`docs/design/perception.md`、`packages/domain/src/store.ts`、`packages/conversation/src/engine.ts`、`packages/conversation/src/proactive.ts`、`services/perception-edge/perception_edge/{emitter,contracts}.py`、`services/perception-edge/perception_edge/run.py`、`scripts/verify-camera-presence.ts`、`scripts/field-test.ts`、`scripts/serve-chat.ts`、`plugins/xixi-tools/index.js`、`tests/unit/core/brain-error-classification.test.ts`、`tests/integration/brain-adapter.test.ts`，以及 `git grep -n` 在 **`b8f0e9b`（t33 交付）** 与 **`HEAD 6a6c2a4`** 两个修订号上的对照，加上**我自己跑的 4 条命令**（见 §6）
> 上一轮血缘：本任务复核的 findings 由我在 t13 评审里提出（`docs/review/residual-fix-t12-review-2026-09-30.md`）

---

## 1. 结论

**verdict：needs_revision**（4 条 finding：1 medium + 3 low）

一句话：**t33 三项修复的「实质」我逐条验证成立**——在它自己的交付修订号 `b8f0e9b` 上，`appendEvent` 的调用点**恰好是文档写的 4 处**（`engine.ts:206`、`store.ts:333/443/778`，外加定义行 `store.ts:267`），§20.2 改为事实表后与 `perception.md` §2/§3/§8.3 **逐条对得上**且**保留了「真人镜头前未实测」这条不夸大声明**，§7 的错误码分层口径与离线测试的断言**逐句对得上**（我把那两条测试文件实跑 11/11 通过）；**但这份文档现在（HEAD）在 4 个地方与代码/自身不一致**，其中最要命的是它钉住的 **15 处行号引用里已有 13 处漂移**（只有 `store.ts:333/443/778` 三处还准）——而这正是「修漂移时不要制造新的漂移源」（AGENTS.md §9.18）要杜绝的形态，所以不能判 pass。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 明确 verdict + findings（含文件与行号） | **满足** | 本节 + §4（F1–F4 都带 `文件:行号`） |
| 2 F1 独立核对：自己 grep `appendEvent` 调用点数与位置，与文档一致（且文档列了文件与函数名） | **在 t33 交付修订号上完全一致；在当前 HEAD 上不一致（4 → 5）** | `git grep -n "appendEvent(" b8f0e9b -- packages` → `engine.ts:206` + `store.ts:333/443/778`（定义行 `store.ts:267`），与文档 §6 表格**逐行一致**；`HEAD 6a6c2a4` 上多出 `proactive.ts:540`、且 `engine.ts` 变成 `:243` → F3。文档确实列了**文件 + 函数名 + 行号**三件套 |
| 3 F2 独立核对：§20.2 陈述的是事实且不夸大，与 `perception.md` 一致 | **真正满足** | §20.2 四条我逐条对照：帧差动 320×240 灰度 + **每 10 帧** YuNet（`perception.md:31/33/59/64`）、Haar 为显式降级（`:61/89`）、不上云「由构造保证 + 测试断言」（`:21`，`run.py:1` 确有 `no service, no cloud`）、`SemanticAnalysisHook` 调用即抛（`:22/173`，与 `capture_snapshot()` 一致）；**「真人站在镜头前的检出自测尚未完成」保留在 §20.2 与本文件 §5 第 10 条**，与 `perception.md:23/250-253` 一致——没有夸大 |
| 4 F3 独立核对：写清「适配器层 `code=TRANSPORT_FAILED`、原始码在 `originalCode/detail`」且有离线测试覆盖 | **真正满足** | 文档 §7 两条路径都写了（直连缺密钥 / HTTP 映射 / DSH 保持 `PROVIDER_FAILED` + 原始码进 `originalCode`）；覆盖我**实跑**：`node --test tests/unit/core/brain-error-classification.test.ts tests/integration/brain-adapter.test.ts` → **11/11 pass**，其中缺密钥用例断言 `code === 'TRANSPORT_FAILED'` + `originalCode === 'MISSING_KEY'` + `detail` 含 `MISSING_KEY` + 两处 `attempted === 0`，DSH 用例断言原始码进 `originalCode` |
| 5 通读排查：抽查 3 处以上其他过期陈述是否处理/列明 | **部分满足（抽查 5 处对上 4 处）** | 对上：L0 行的 WorldState（§2:29，投影存在但**无工具读它**——我 grep `tools.ts` 与插件源码确认 0 命中）、DSH 插件两个工具（§2:48-49，`index.js:238/262` 正好两个）、`defineTool` 参数根封闭性（§2:50）、§20.1 的落盘/保留期改写（§20.1:60-63）、感知边 actor 默认值（§1:19-21，`store.ts:767` + `contracts.py:203` 都是 `'father'`）。**漏掉 §5 第 5 条**（与它刚改好的 §20.1:62 自相矛盾）→ F2；另 §6 把校验函数写成 `buildEvent()` → F4 |
| 6 自己跑 npm test 与 check:docs 并贴结果；结论落本文件 | **满足** | `npm test` → **169 / 169 / 0 fail / 0 skipped，exit 0**（修订号 `6a6c2a4` + 在途改动，见 §6 说明）；`npm run check:docs` → **46 份 markdown、0 问题、exit 0**；结论表与 findings 清单都在本文件 |

**范围纪律**：t33 只改了它声明的 1 个文件（`b8f0e9b --stat`：`docs/design/security-and-privacy.md` +79/-18，另 `AGENTS.md` 是队长文件由队长落笔），未动代码与测试；我本轮只新增本文件。

---

## 2. F1：`appendEvent` 的调用点（在修订号上核，不靠印象）

| 修订号 | `grep -n "appendEvent("` 的全部命中 | 文档写的 | 判定 |
|---|---|---|---|
| **`b8f0e9b`（t33 交付）** | `conversation/src/engine.ts:206`、`domain/src/store.ts:267`（**定义行**）、`store.ts:333`、`store.ts:443`、`store.ts:778` | 「调用点一共 **4 处**」+ 表格四行（含文件与函数名）+ 明说 `store.ts:267` 是定义行不算 | **逐行一致** |
| **`HEAD 6a6c2a4`** | 同上，外加 **`conversation/src/proactive.ts:540`**（主动性任务新落地），且 `engine.ts` 已变成 `:243` | 仍写 4 处 / `engine.ts:206` | **不一致** → F3 |

文档另外写的那条「**不经过 `appendEvent`** 的写入路径」我也核了：`services/perception-edge/perception_edge/emitter.py` 用同一个连接先 `INSERT INTO events`（`:43/:150`）再 `_project_presence` 写 `world_state`（`:185`），一次 `commit()`（`:167`）——「同一事务」的写法**成立**。

## 3. F2 / F3 的核对细节

- **§20.2 与 `perception.md` 逐条对照**（验收条款 3）见上表第 3 行；我额外核了 `scripts/verify-camera-presence.ts` 确实把这些事件重建信封并 `validateEvent()`（`:311-325`）。
- **§7 的错误码口径**（验收条款 4）：直连缺密钥 → `ModelError('MISSING_KEY')` → 适配器 `BrainError.code = TRANSPORT_FAILED` + `originalCode = MISSING_KEY` + `detail` 含 `MISSING_KEY:` + fetch 未被调用；HTTP 401/403→`AUTH`、402→`QUOTA`、429→`RATE_LIMIT`、400/404/422→`BAD_REQUEST`、≥500→`PROVIDER_FAILED`、连不上→`TRANSPORT_FAILED(NETWORK)`；DSH 保持 `PROVIDER_FAILED` + 原始码进 `originalCode`（`MISSING_CREDENTIAL` → `TRANSPORT_FAILED` 也在共享分类器用例里断言）。这些我都在测试里逐句找到了对应断言，并实跑通过。

---

## 4. findings（按严重度）

### F1（medium）文档钉住的 15 处行号里 **13 处已漂移**，多数现在指向错误的代码

- **位置**：同一份文档的三节：§20.1 的 7 处（`scripts/field-test.ts:673/2892/775/1805`、`scripts/serve-chat.ts:49/52/102-109`）、§6 的 4 处（`store.ts:333/443/778`、`engine.ts:206`）、§7 的 4 处（`tests/unit/core/brain-error-classification.test.ts` 第 38/78/110 行、`tests/integration/brain-adapter.test.ts` 第 20 行）。
- **逐处核对（我做的对照表，`b8f0e9b` 是 t33 交付修订号，`HEAD = 6a6c2a4`）**：

| 引用 | 在 `b8f0e9b` 上 | 在 `HEAD` 上 | 判定 |
|---|---|---|---|
| `field-test.ts:673` | `mkdtempSync(tmpdir()/xixi-vad-)` | `const vadStarted = Date.now();` | **漂移** |
| `field-test.ts:775` | `pruneVoiceDir(deps.voiceDir, deps.policy)` | `accepted: turn.accepted,` | **漂移** |
| `field-test.ts:1805` | `pruneVoiceDir(...)` 调用 | `readonly presenceDataDir?: string;` | **漂移** |
| `field-test.ts:2892` | `check('隐私策略：整段录音不落盘', …)` | `writeFileSync(join(voiceDir,'capture-…'))` | **漂移** |
| `serve-chat.ts:49` | `const policy = retentionPolicy(config);` | `console.log('[privacy] 按保留策略清理 …')` | **漂移** |
| `serve-chat.ts:52` | `const pruned = pruneVoiceDir(VOICE_DIR, policy);` | `function buildAdapter(): BrainAdapter {` | **漂移** |
| `serve-chat.ts:102-109` | 正是那段「为什么不再内联」的注释块 | 注释块现在到 108 行结束，109 已是 `function json(...)` | **部分漂移** |
| `store.ts:333` / `:443` / `:778` | `recordHealth` / `recordTurn` / `recordPresenceChanged` 的调用 | 同左 | **仍准确** |
| `engine.ts:206` | `#recordDecision` 的 `appendEvent` | 已移到 `:243` | **漂移** |
| 单测第 38 / 78 / 110 行 | HTTP 分类 / 缺密钥 / DSH 原始码三条用例 | 已是 46 / 86 / **122** | **漂移** |
| 集成测试第 20 行 | 缺密钥用例 | 已是 **28** | **漂移** |

- **成因（不是 t33 写错）**：后续任务改了同一批文件——t35 改 `tests/unit/core/brain-error-classification.test.ts`、t37 改 `scripts/field-test.ts`、主动性任务改 `engine.ts` 并新增 `proactive.ts`。**但正是这个原因，把行号钉进文档的做法不可接受**：几小时内 13/15 失效，而文档在读者眼里仍然「精确」。
- **requiredFix**：把行号换成**不漂移的符号锚点**——函数名 / 测试名 / 表名（文件路径保留），例如「§7 的覆盖见 `tests/unit/core/brain-error-classification.test.ts` 的 `a missing key arrives as MISSING_KEY before any request is attempted`」；若确实要留行号，必须写明「行号基于修订号 X，以符号为准」。文档头部那句「若与代码不一致，以代码为准，并请立即修正本文件」目前处于**被违反状态**。

### F2（low）§5 第 5 条与 §20.1 自相矛盾（t33 本次通读留下的漏网）

- **位置**：`docs/design/security-and-privacy.md:127`（§5 第 5 条）对 `:62`（§20.1 的「调试模式可配置保留 N 天」行）
- **事实**：§5:127 写「**音频/对话保留期与删除接口**：未实现（配置项存在但无人读取）」，而同一份文档 §20.1:62 在**本次提交里**刚被改成「✅ **已实现**（不再是「配置项无人读取」）」。`memory.raw_audio_retention_days` 确实被读：`scripts/field-test.ts:300` 的 `numberOr(memory.raw_audio_retention_days, 0)`；我同时确认 `memory.raw_transcript_retention_days` 全仓**无任何读取方**（所以 §20.3 的「未实现」是对的）。
- **证据**：`git show b8f0e9b` 的 diff 里**没有** §5 第 5 条的改动（该条在 `b8f0e9b^` 的第 109 行就已存在，t33 把同一句话在 §20.1 改掉了，却把 §5 的留着）。
- **requiredFix**：把 §5 第 5 条拆开写——「**音频**保留期 ✅ 已实现（见 §20.1）；**对话（transcript）**保留期与**细粒度删除**仍未实现（见 §20.3 / §20.1 末行）」，删掉已经不成立的「配置项存在但无人读取」。

### F3（low）§6 的「4 处」现在已是 **5 处**

- **位置**：`docs/design/security-and-privacy.md:139`（计数）与 `:146`（`engine.ts:206`）
- **事实**：`HEAD 6a6c2a4` 上 `packages/conversation/src/proactive.ts:540` 新增了一个 `appendEvent` 调用点（主动性任务），`engine.ts` 的调用点也从 `:206` 移到 `:243`。
- **requiredFix**：要么补上第 5 行（`proactive.ts` + 函数名 + 事件类型），要么按 §9.18 去掉写死的「一共 N 处」，改为「以 `grep -n "appendEvent("` 结果为准（当前见下）」并只列**文件 + 函数**、不列行号（与 F1 同一次修）。

### F4（low）§6 把校验函数写成 `buildEvent()`，脚本里用的是 `validateEvent()`

- **位置**：`docs/design/security-and-privacy.md:150`
- **事实**：`scripts/verify-camera-presence.ts` **没有**导入或调用 `buildEvent`（该文件 `:311-323` 手工重建信封对象，`:325` 调 `validateEvent()`）；全仓 `buildEvent` 的调用点是 `store.ts:334/444/764`、`engine.ts:244`、`proactive.ts:541` 与若干测试（其中 `tests/perception/camera-presence.test.ts:205` 才是「重建 + 校验」的场景）。
- **requiredFix**：把该句改成「`scripts/verify-camera-presence.ts` 把这些事件**手工重建信封后**用 `validateEvent()`（`:311-325`）校验一遍」；若要指测试里的 `buildEvent`，就明确写测试文件名。

---

## 5. 观测（不改变 verdict，但请一并处理）

- **O1（交付记录里的修订号，同 t31 的同一个毛病）**：t33 回报写「rev d08d5cc」，而 `d08d5cc` 是**基线**（它是我 t15 评审报告的归档提交，不含这次文档改动）；这次交付实际落在 **`b8f0e9b`**。建议在 t33 上补一条**追加式** `evidence_note`（「基线 d08d5cc → 交付 b8f0e9b」），后续引用用 `b8f0e9b`。**这是本轮第二次出现**（t31 也把基线 `f2f35c9` 当成交付号），根因是派单文本只给了一个 hash——建议派单时明确写「基线修订号」与「交付后请报你的提交」。
- **O2（值得肯定的口径）**：§20.2 的改写**没有为了让页面好看而抬高实现度**——它把「真人镜头前未实测」「`features.camera_presence: false` 只是没人读的声明」「语义分析刻意不实现」三条都写进了正文与 §5。这正是我在 t13 要求的「不夸大」，请保持。

---

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `git grep -n "appendEvent(" b8f0e9b -- packages` | `engine.ts:206`、`store.ts:267`（定义）、`333`、`443`、`778` → **恰好 4 处调用点**，与文档 §6 逐行一致 |
| `git grep -n "appendEvent(" HEAD -- packages` | 上述 + **`proactive.ts:540`**，`engine.ts` 变 `:243` → 5 处（F3） |
| `git log --oneline -- docs/design/security-and-privacy.md` | 最后一次改动是 **`b8f0e9b`（t33 完成）**，故交付修订号为它 |
| `git show b8f0e9b^:<doc>` 与 `b8f0e9b:<doc>` 对照 | §5 第 5 条在 `b8f0e9b^` 的第 109 行已存在且未被本次改动（F2） |
| `node --test tests/unit/core/brain-error-classification.test.ts tests/integration/brain-adapter.test.ts` | **11 / 11 pass，exit 0**（含缺密钥两层口径与 DSH 原始码） |
| `npm test` | **tests 169 / pass 169 / fail 0 / skipped 0**，exit 0（修订号 `6a6c2a4` + 在途改动 `engine.ts`/`config.ts`/`index.ts` 与两个未跟踪测试文件；项数从 139 涨到 169 是队友在加主动性/多段回复用例） |
| `npm run check:docs` | 检查了 **46 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |
| 交叉核对（读码/grep） | `store.ts:767` `actor ?? 'father'`、`contracts.py:203` `actor: str = "father"`、`tools.ts`/插件 `worldState` 0 命中、`index.js:238/262` 恰两个工具、`run.py:1` `no service, no cloud`、`raw_transcript_retention_days` 0 个读取方、`raw_audio_retention_days` 在 `field-test.ts:300`、`emitter.py` 单连接 commit、`perception.md:17-23/31-33/59-64/250-253` |

**我做过的真实外部动作**：0 次 API 调用（未花任何费用）、未开摄像头/麦克风、未写任何业务数据库；**本轮没有任何突变/改动实验**（上次 t32 的 `0.25` 突变已按 §9.10 记入教训，这次全程只读）。
