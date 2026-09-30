# 评审：主动内容由模型生成与发声（t74）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t70 常驻循环与 t74 的改动）
> 评审对象：`0441c64`「t74 完成：主动开口的内容由模型现编且不重复、演练也发声、每个触发源都能开口、面板可调话痨」（`scripts/field-test.ts`、`scripts/serve-chat.ts`、`tests/console/proactive-loop.test.ts`、`tests/console/proactive-console.test.ts`）
> 复核方式：**我自写 4 个探针**（真实 `ProactiveLoop` / `proactiveDrill` / `ProactiveEngine` / 真起控制台抓页面，全部用系统临时库），共 **39 项断言全过**；不采信 t74 报告里的自述数字，凡我无法复现的都在 §5 写明
> 时序：开工时 `git status` 干净、HEAD = `0441c64`；核对期间工作区陆续出现**他人的在途改动**（出厂默认改成话痨档、t78 改 `scripts/field-test.ts`），我都按 AGENTS.md §9.10 归因，见 §4

---

## 1. 结论

**verdict：pass（无 blocking finding；4 条观测在 §5，都不改变判定）**

一句话：**验收要求独立核对的四件事，我都用自己的探针跑出来了**——内容只在门禁全放行之后生成（四种被拦场景生成调用 **0** 次）；连续两条不会重复（模型故意回同一句时被换成同源另一句并写明原因，离线也有 ≥2 句轮换）；演练**逐段返回真音频**（base64 的 RIFF/WAV，段数=分段数）且服务端渲染出来的页面里就有播放调用；`proactivity=1.0`（阈值地板 0.45）下五个 live 触发源的最大分数 **0.58 / 0.49 / 0.51 / 0.50 / 0.47** 全部 ≥ 0.45，逐个用**真引擎**跑也都放行（`random_smalltalk` 在出厂配置下是「触发源关掉」而不是分数不够，单独打开后 `PASSED`）。t74 自己那 5 个带 `(t74)` 的测试**全绿**。

门禁方面我这一轮**没有拿到全绿**（`npm test` 三次快照：206/192/14 → 206/203/3），但三条剩余红项**逐条都定位到了他人的在途改动**，证据在 §4；t74 的 diff 不包含这些位置。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 独立核对四件事（生成在门禁之后 / 连续两条不重复 / 演练返回音频且页面真播 / 五个 live 源 ≥0.45）+ 抽查两道「不重复」保险 | **真正满足** | §2 四项逐条（探针原始值）、§3 两道保险 |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果（红项按 §9.10 归因）；结论落 `docs/review/` | **满足（红项已逐条归因**，见 §4） | §4：`npm test` 206/192/14 与 206/203/3 的失败清单 + 成因证据；`npm run check:docs` 60 份 / 0 问题 / exit 0 |

---

## 2. 四项独立核对

### 2.1 内容确实在门禁放行之后才生成（被拦时生成 0 次）

代码侧：生成只发生在 `ProactiveLoop` 传给 `ProactiveEngine.consider` 的 **`deliver` 回调**里——引擎只在全部门禁放行后才调用它；`ProactiveLoopOptions.compose` 的注释与 `#consider` 的 `deliver:` 体是同一处。

| 场景（探针里我注入的 compose 会自增计数） | 引擎判定 | 生成调用次数 |
|---|---|---|
| 总开关关 | `DISABLED` | **0** |
| 在场源关掉 | `TRIGGER_DISABLED` | **0** |
| 静默时段 00:00–23:59 | `QUIET_HOURS` | **0** |
| `proactivity=0`（阈值 0.75）而候选只有 0.58 —— **分数门禁第 11 道** | `SCORE_BELOW_THRESHOLD`（score 0.58 < 0.75） | **0** |
| 全放行（在场 + 无人说话 + 冷却 0） | `PASSED` | **1** |

### 2.2 连续两条不重复

- **模型故意回同一句**：第一次说「同一句被模型重复返回」（`contentSource=model`）→ 第二次模型又回同一句 → 循环把它判为不可用，**换成该触发源下的另一句**（「安静了一会儿了。要不要从刚才那件事接着聊？我记着呢。」），并在 `contentNote` 写明「内容与最近说过的一句重复：换成这个触发源下的另一句。」；`spokenLines()` = 两句且互不相同；compose 确实被调用了 2 次（说明不是靠「没调模型」蒙过去的）。
- **离线（没有 composer）**：两条也不一样（`presence_arrived` 一句、`conversation_dangling` 一句），`pickOfflineLine` 按 `spokenCount` 轮换、并先过滤掉「最近说过的」；`PROACTIVE_OFFLINE_LINES` 至少两个源有多句（presence 2 句、dangling 2 句）。

### 2.3 演练返回音频，页面真的播放

| 我注入的 TTS 接缝 | 结果 |
|---|---|
| 正常合成（返回带 RIFF 头的 WAV） | `speak=true`、`segments=2`、**`audio` 有 2 段**、每段 base64 解出来都是真 WAV（146 / 128 字节）、`gapMs=450`；合成函数**逐段**被调用，参数就是那两段文本 |
| 合成抛错 | 该段为 `null` 且 `audioNote` =「第 1 段合成失败：TTS 炸了」（不静默） |
| 没有 TTS 接缝（`--no-tts` / 无密钥） | `audio=null` 且 `audioNote` =「只显示文字：朗读关闭（--no-tts）或没有可用密钥，所以这次没有合成语音。」 |

页面侧（我起真控制台抓 `/` 的 HTML，47476 字节，就是浏览器会执行的那份）三处都在：`if (drill.audio) pxPlayClips(drill.audio, drill.gapMs)`（演练）、`new Audio('data:audio/wav;base64,' + clip)` 且随后 `void audio.play()`（真的出声）、`if (entry.audio) pxPlayClips(entry.audio, entry.gapMs)`（常驻循环条目走同一条路）。HTTP 侧 drill 端点把 `synthesize` 接到与常驻循环**同一个** `loopSynthesize` 接缝上。

### 2.4 `proactivity=1.0`（地板 0.45）下五个 live 触发源都 ≥0.45

- `proactiveThreshold(1.0) = 0.45`（与 `0.45 + 0.30 × (1 − 1.0)` 一致）。
- `triggerScoreCeiling()`（富情境：有人在场 + 45 分钟没人说话 + 命中 09:00 时钟钩子 + 有话题 + 强制随机项）：**presence_arrived 0.58｜conversation_dangling 0.49｜future_hook_due 0.51｜topic_pool 0.50｜random_smalltalk 0.47**，全部 ≥ 0.45；`routine_expected` 仍是 `null`，也不在 `PROACTIVE_TRIGGERS_WITH_SOURCES` 里（面板明确标注「这一轮还不会自己产生候选」）。
- **不只是算术**：我用真 `ProactiveEngine` 逐个跑了这五个候选（干净临时库、`proactivity=1.0`）：四个 `PASSED`（`deliver` 恰好 1 次），`random_smalltalk` 在**出厂默认**下是 `TRIGGER_DISABLED`（分数 0.47 已经过线，是触发源开关关着）——把该开关打开后实测 `PASSED`（score 0.47 ≥ 0.45，`deliver` 1 次）。也就是说「五个源都真的可能开口」成立，条件只是它自己的开关要打开，而面板可以单独开。
- t74 自己的断言 `every trigger the panel lists can really reach the threshold floor (t74)` 也是绿的。

---

## 3. 「不重复」的两道保险（验收点名要抽查）

| 保险 | 它做什么 | 我的实测 |
|---|---|---|
| ① 提示词里带上「最近说过」 | `proactiveComposeDirective(plan, recentLines)` 在指令里附「最近已经说过这几句，这次不要再重复（换一种说法）」+ 逐行原文 | 传两句进去 → 输出里两句原文与那句警告都在；传空数组 → 不出现该段（不会塞一个空标题） |
| ② 模型回句与已说过的一致就换一句 | `#consider` 的 `deliver` 里 `this.#spoken.includes(text)` → 换成同源另一句并写明原因 | 见 §2.2：第二条被换掉、`contentNote` 写明原因、`spokenLines()` 两句不同 |
| （补充）离线轮换 | `pickOfflineLine()` 先剔掉最近说过的，再按 `spokenCount` 轮换 | 见 §2.2：离线两条不同 |

---

## 4. 门禁与归因（§9.10）：为什么这一轮我没有全绿

**快照 1：`npm test` = 206 tests / 192 pass / 14 fail**（那时 `scripts/field-test.ts` 与 HEAD 一致）。14 条红全是**默认值钉子**，例如 `the config defaults match ADR-0009 §5 exactly`、`COOLDOWN_ACTIVE: 12 minutes by default, exactly`、`QUOTA_6H_EXCEEDED: eight in six hours by default`、`TOPIC_REPEATED: 6 hours by default, only for a topic that has been used`、`the engine reads config.proactive instead of inventing its own defaults`、`the shipped example configuration loads and validates`。成因是**他人在途的出厂默认改动**（`git diff` 原文）：`proactivity 0.70 → 0.85`、`base_cooldown_min 12 → 5`、`max_per_6h 8 → 15`、`max_per_day 20 → 40`、`topic_repeat_window_h 6 → 2`、静默时段 `22:30–07:00 → 23:30–07:30`，同时改 `config/xixi.example.yaml`、`packages/conversation/src/proactive.ts`、`docs/adr/0009-…md`；对应测试当时还没改完（`tests/unit/core/proactive-gates.test.ts` 等的更新在我核对过程中才陆续出现）。

**快照 2：`npm test` = 206 tests / 203 pass / 3 fail**（对方把 unit/integration 的钉子补完之后）。剩下 3 条**全在 `tests/console/`**：

1. `settings changed on the page are persisted, restored, and validated field by field` —— 断言「变动清单里要有『冷却』行」。它把冷却打到 5 分钟；而在途改动刚把**默认冷却**从 12 改成 5，于是这次补丁是 no-op、不产生任何变更行。**反事实实测**（`t79-probe4.mjs`）：默认 12 时 changes = `["冷却：12 → 5 分钟", …]`（断言通过）；默认 5 时 changes = `["当日额度：…", "静默时段：…", "随机闲聊…"]`（没有冷却行 → 断言失败）。与 t74 无关：t74 没有改冷却默认值。
2. `the console serves the proactive card, its state, and obeys the switch over HTTP` —— 挂在 `assert.equal(drill.ok, true)`。
3. `the console serves the loop over HTTP, off by default, with a readable action error` —— 挂在 `payload.status` 是 `undefined`。

2、3 两条有**服务器日志的直接证据**：我起真控制台后请求这两个端点，端点都返回 **500**，服务端 stderr 是

```
[error] ReferenceError: loopSynthesize is not defined
    at loopPayload (scripts/field-test.ts)
    at <drill 端点>
```

`git diff HEAD -- scripts/field-test.ts` 显示**在途的 t78 改动**把 `const loopSynthesize = …` 改名成了 `const loopSynthesizeProvider = …`（并把循环改接 `synthesizeProvider:`），但 `loopPayload` 与 drill 端点里那两处**仍写着旧名** `loopSynthesize` → 运行时 `ReferenceError`。HEAD（`0441c64`）上 `loopSynthesize` 定义 1 处、引用 4 处、自洽；这三条红是**半成品写入窗口**（§9.10 第①类，且正是 §9.10 第④类「两个任务同时改被测试导入的生产文件」）。

**t74 自身的证据**：带 `(t74)` 的 5 个测试全绿（`every trigger the panel lists can really reach the threshold floor`、`content is composed from inside the delivery seam, i.e. only after the gates pass`、`two consecutive messages never repeat the same sentence`、`the two chit-chat sources are fact-based and can be switched off`、`the drill button speaks too, through the same TTS seam`）；只用**已跟踪**的 console 测试跑，我拿到 **41 / 40 pass / 1 fail**，那唯一一条就是上面第 1 条（默认值改动所致）。

**我试过的「干净基线」为何没用**（如实记录）：我建了一个 `0441c64` 的 `git worktree` 想跑一份纯净树的 `npm test`，结果是 206/189/17——因为在 worktree 里 `@xixi/*` 通过 npm workspaces 的软链**指回主仓库的 `packages/`**，所以默认值相关的红照样出现（外加 3 条 worktree 环境特有的红：`data/` 目录监视、Python 语音）。这条实验因此只能当**诊断**：它反过来证明那批红是跟着 `packages/conversation` 的在途改动走的。worktree 已删除（`git worktree list` 现在只有 `E:/worker2`）。

**`npm run check:docs`**：60 份 markdown / 失效链接 0 / 不存在的文件引用 0 / 缺少新鲜度标记 0，**exit 0**（收入本报告后 61 份，仍 0 问题）。

---

## 5. 观测（都不改变 verdict）

- **O1（信息，「不重复」的边界）**：`#spoken` 是**进程内**记忆（上限 10 条），所以「连续两条不重复」是**单次会话内**的保证；重启后 `recentLines` 为空，模型那条保险就没了上下文——能挡住「同一 `candidateId` 当天重发」的是日志里的 `delivered:true`，但**不同触发源说出同义句**理论上仍可能。若要跨重启也不重复，材料是现成的：`conversation.turn` 里已有 `source='proactive'` 的 assistant 轮次，可从事件日志回填最近说过的句子。
- **O2（信息，源与开关的口径）**：`random_smalltalk` 在出厂配置里是**关**的，所以「五个 live 源都 ≥0.45」是**分数层面**成立、打开开关后实测 `PASSED`；`routine_expected` 没有事实源、面板明确标注，这与「不让面板承诺永远不会发生的源」一致——但读报告的人容易把「五个 live 源」误读成「五个默认就开」。建议在面板/文档里把「默认开 / 可开 / 暂无事实源」三态写清。
- **O3（信息，隐私口径）**：`topic_pool` 会把**用户自己的原话**截 24 字放进主动话术（`你前面提到「…」`）并作为 prompt 的「依据」。这来自事件日志、不新增持久化、也不是上云（§15.4 的 `memory_relevance` 正是这个用途），但它是「把用户原话读回给用户本人」的设计选择，记录在案以便日后审计。
- **O4（流程，§9.10 第④类的又一例）**：t74、t70、t78 都改 `scripts/field-test.ts`，而它被 `tests/console/` 与 `tests/integration/` **导入**，所以只要有人在这个文件上工作，**全队的 `npm test` 都可能红**。这一轮我又撞了两次：先是别人改默认值导致 14 条红，再是 t78 一次半成品写入（我请求 `--help` 时拿到 `ERR_INVALID_TYPESCRIPT_SYNTAX`，约 30 秒自愈；随后端点 500）。建议把这类文件的改动**串行化**（显式依赖），或把含「npm test 全绿」的验收统一写成「按 §9.10 判读并注明归属」。

**我无法复现的一项（如实说明）**：本机 `MIMO_API_KEY` **未设置**、也没有 `.env.local`，所以「模型现场编出两句不同的话」这一条，我只用**离线替身 adapter** 走通了接缝（`createModelComposer` 在 `available=true` 时 `source='model'`、文本来自 adapter），并按代码读到它走的是引擎自己的 `buildPrompt` + `adapter.handleUserTurn`（含只读工具）；t74 报告里那两句真话与 550KB/270KB 音频属于**真密钥下的证据**，我不可能在不花钱的前提下重跑，故不背书其字面数字（本轮我 0 次 API 调用）。

---

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node data/rev-tmp/t79-probe.mjs`（**我自写**：门禁前生成、两条不重复、两道保险、演练音频、五个源的天花板 + 真引擎逐个跑） | **33 项检查全过**（§2、§3 的全部原始值）；在 t74 交付的原样树上与 t78 在途小改之下各跑一次，结果一致 |
| `node data/rev-tmp/t79-probe2.mjs`（**我自写**：分数门禁挡在生成之前 + `createModelComposer` 三条分支 + 生成抛错兜底） | **6 项全过**：`SCORE_BELOW_THRESHOLD` 时 compose 0 次；`available=true` → `model`；`available=false` / 无会话 → 固定句 + 具名 note；生成抛错 → `speak=true` + 固定句 + 「内容生成失败（模型 503）」 |
| `node data/rev-tmp/t79-probe3.mjs`（**我自写**：当前解析出的默认值 + `random_smalltalk` 打开后放行） | 默认值 = 5min/15/40/2h/23:30–07:30（在途）；`conversation_dangling PASSED 0.49`、`random_smalltalk PASSED 0.47`（阈值 0.45） |
| `node data/rev-tmp/t79-probe4.mjs`（**我自写**：反事实） | 冷却默认 12 → changes 有「冷却：12 → 5 分钟」（断言过）；默认 5 → 没有该行（断言失败）→ 第 143 行那条红的成因 |
| `node scripts/field-test.ts --offline --no-open --data-dir %TEMP%\t79-drill --port 8891` + `GET /api/field/proactive/loop` / `POST /api/field/proactive/drill` | 两个端点都 **500**，服务端日志 `ReferenceError: loopSynthesize is not defined`（在途 t78 半成品，§4） |
| `npm test`（判读前先看 `git status`） | 两次快照：**206/192/14** 与 **206/203/3**，红项逐条归因见 §4 |
| `node --test (git ls-files "tests/console/*.test.ts")` | **41 / 40 pass / 1 fail**（唯一红 = 冷却默认值那条），即 t74 自己的测试全绿 |
| `node --test tests/console/proactive-loop.test.ts` | **14 / 13 pass / 1 fail**；5 个 `(t74)` 测试**全绿**；唯一红是上面的在途 `loopSynthesize` |
| `npm run check:docs` | 60 份 markdown / 0 问题 / **exit 0**（收入本报告后 61 份 / 0 问题 / exit 0） |
| `git worktree add … 0441c64` + `npm test`（诊断，已删除） | 206/189/17：worktree 里 `@xixi/*` 经 workspaces 软链指回主仓库，故不能当干净基线（§4） |

---

## 7. 我做过的真实外部动作

**0 次 API 调用**（全程离线：`--offline` + 替身 adapter，未花任何费用）、**未开摄像头/麦克风**；起过 1 个本机控制台（8891）用于复现端点 500，已关闭（端口现在无人监听），临时库 `%TEMP%\t79-drill` 已删除；探针全部用系统临时库，脚本留在 `data/rev-tmp/`（`t79-probe.mjs`、`t79-probe2.mjs`、`t79-probe3.mjs`、`t79-probe4.mjs`，`data/` 已 gitignore，非交付物）。**未改动任何他人的文件**；唯一的写入产物就是本文件。基线修订 `0441c64`（交付点，我开工时 HEAD）。
