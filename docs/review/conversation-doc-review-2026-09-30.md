# 评审：conversation.md 的 t41 后订正（t50）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t41/t50 的实现者）
> 日期：2026-09-30
> 评审对象：t50「conversation.md 按实现重写（哪一半落地、缺在哪一半）」——改写 §6 缺口表的两行（主动开口、多段回复）、补 §5 的 ⑨′ 步与 M7–M9、把 §7 从「契约」改成「契约与实现」、同步维护规则。产物落在 `7cf5291` 与 `1f6036f`（被队长的周期提交收走；`1f6036f` 同时收录了 `scripts/field-test.ts` 的 +600 行与我的 t46 报告）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`docs/design/conversation.md` §5/§6/§7、`packages/conversation/src/{proactive,segments,engine,index}.ts`、`packages/brain-adapter/src/{mimo,fake,dsh,types}.ts`、`scripts/field-test.ts`（主动性面板与演练）、`tests/unit/core/reply-segments.test.ts`、`tests/integration/proactive-engine.test.ts`、`docs/adr/0009-proactive-triggers-and-hard-gates.md` §3，以及**文档自己给出的 grep 命令**（我逐条实跑，见 §4）
> 说明：本文件是**评审报告**，其中引用代码位置用「文件 + 函数/测试名 + 一条可复现命令」；行号只作本次核对的快照，不作为长期锚点（AGENTS.md §9.18）

---

## 1. 结论

**verdict：needs_revision**（1 条 finding：low；另有 2 条观测）

一句话：**t50 把两行「无代码」改成分工描述，绝大部分说法我逐条对着代码验过、都成立**——九门禁（ADR-0009 §3 的九条）在 `evaluateProactiveGates` 里按固定顺序实现、每次判定落一条 `proactive.decision`、投递确实「先记后播」（落库在前、`deliver` 在后，且重启靠 `ALREADY_DELIVERED` 门禁不重发）、`config.proactive` 与 `config.reply` 都真的被读取、`RespondHooks.onSegment` 与 §5 的 ⑨′ 步（M8/M9）都在代码里、§7 的 180 字溢出与两组边界断言也与 `segments.ts`/`reply-segments.test.ts` 逐条对得上；**但 §6 主动开口那行的括号里有一句与实现不符**：它说 `ProactiveEngine`「目前只有测试在调用」，而现场测试控制台（`scripts/field-test.ts` 的 `proactiveDrill`，页面按钮「试一次主动开口（演练）」+ `/proactive/drill` 路由）**在真实调用它**，同时还提供了开关/静默时段/额度/审计恢复与逐门禁状态的面板——这句把缺口说大了。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 独立核对 §6 两行的改写与实现逐条对上（主动开口：九门禁 / `proactive.decision` 审计 / 先记后播；多段回复：`segments.ts` / `onSegment` / `config.reply` 被读取），缺口描述不得夸大 | **绝大部分成立；有一句夸大（F1）** | 见 §2 的逐条表：21 条断言里 20 条成立、1 条不成立（`ProactiveEngine` 的调用方） |
| 2 自己跑一次 npm test 与 check:docs 并贴结果；结论落 `docs/review/conversation-doc-review-2026-09-30.md` | **满足** | `npm test` → **180 / 180 / 0 fail / 0 skipped，exit 0**（壁钟 20.3s，修订号 `6dfdf90`）；`npm run check:docs` → **51 份 markdown、0 问题、exit 0**；本文件即结论落点 |

**范围纪律**：t50 只改了 `docs/design/conversation.md`（以及在同一提交里被队长一并收走的 `scripts/field-test.ts`、ADR 与我的报告）；我本轮**只新增本文件**，全程只读、无脚本改动、无突变实验。

---

## 2. 逐条核对（我对着代码/测试核，不采信文字）

### 2.1 主动开口（§6 第二行前半 + ADR-0009 §3）

| 文档说法 | 我的核对 | 判定 |
|---|---|---|
| 「逐条过硬门禁（**ADR-0009 的九条**）」 | ADR-0009 §3 的九行是：DND / 静默时段 / 冷却 / 6 小时额度 / 当日额度 / 同主题重复 / 对话冲突 / 置信度不足 / 场景·设备不可用（第九行覆盖 `SCENE_UNAVAILABLE` 与 `SPEECH_UNAVAILABLE` 两个码）。`packages/conversation/src/proactive.ts` 的 `evaluateProactiveGates` 按**固定顺序**逐条判定，九个码全部在册；它前面还多三道**非「门禁」语义**的短路：`DISABLED`（总开关）、`TRIGGER_DISABLED`（触发源开关）、`ALREADY_DELIVERED`（最多说一次的账本）。代码注释明写「顺序是契约的一部分」 | **成立** |
| 「每次判定落一条 `proactive.decision` 审计」 | `ProactiveEngine.#record` 用 `store.appendEvent` 写 `event_type: 'proactive.decision'`，**被挡下的判定也写**（这正是「为什么今天西西没来找我说话」的答案）；`tests/unit/core/proactive-gates.test.ts` 与 `tests/integration/proactive-engine.test.ts` 覆盖 | **成立**（有一处代码自己声明的例外，见 O1） |
| 「投递『先记后播』（重启不重发同一条）」 | `consider()` 里**先**写 `delivered: true` 的事件、**再** `await input.deliver?.(…)`；代码注释写明「崩溃在播放前/中会留下一条记录，从而阻止重发——宁可丢一条，不重复一条」；重启侧由 `ALREADY_DELIVERED` 门禁读历史实现 | **成立** |
| 「`config` 的 `proactive` 段也已被读取」 | `parseProactiveSettings(options.config)` 是默认路径（`this.#settings = options.settings ?? parseProactiveSettings(options.config)`）；现场控制台还会把自己的设置快照写回并被读取 | **成立** |
| 缺口「没有候选生成器」 | `packages/**` 与 `scripts/**` 里只有 `scoreProactiveCandidate()`（分数计算）与 `ProactiveCandidate` 接口，**没有**从事件事实生成候选的代码 | **成立** |
| 缺口「没有常驻的考虑循环调用方」 | `ProactiveEngine` 的调用方只有：现场控制台的按需演练、测试；没有任何循环/定时器在跑 | **成立** |
| 缺口「（`ProactiveEngine` 目前只有测试在调用）」 | **不成立**：`scripts/field-test.ts` 导入 `ProactiveEngine`，`proactiveDrill()` 构造真实引擎并 `await engine.consider({...})`，结果经 `/proactive/drill` 路由喂给页面按钮「试一次主动开口（演练）」；控制台另有主动性面板（总开关、静默时段、额度、审计恢复）与逐门禁状态展示 | **不成立 → F1** |
| 缺口「模型侧 `evaluateProactiveCandidate` 仍抛 `NOT_IMPLEMENTED(M5)`」 | `packages/brain-adapter/src/{mimo,fake,dsh}.ts` 三处实现都是 `notImplemented('evaluateProactiveCandidate', 'M5')` | **成立** |

### 2.2 多段回复（§6 第三行 + §5 ⑨′ + §7）

| 文档说法 | 我的核对 | 判定 |
|---|---|---|
| 「`segments.ts` 的确定性分段器」 | `splitReplyIntoSegments()` 是纯函数（测试断言「同一文本永远同一分段」），`REPLY_LIMITS` 是程序常量硬上限 | **成立** |
| 「`RespondHooks.onSegment` 逐段播放」 | `engine.ts` 的 `RespondHooks.onSegment` 存在，且与 `onTextChunk` **互斥**（代码注释：「两个音频出口，二者择一」） | **成立** |
| 「`config` 的 `reply` 段已被读取」 | `this.#replyLimits = resolveReplyLimits(this.#config.reply, options.reply)`（`engine.ts`）；`resolveReplyLimits()` 把配置夹进 `REPLY_LIMITS`，测试名就是 `resolveReplyLimits reads the config section, clamps it and lets an override win` | **成立** |
| §5 ⑨′：「只对 SPEAK 分段；期间状态保持 ACTIVE（M8）；某段抛错 → 停后续段、结束本轮、错误仍上抛（M9）；⑩ 的 LINGERING 起点 = 最后一段播完」 | 代码里就是这三段注释与实现（M6/M7 说明「一轮仍是一轮」、M8 说明分段播放期间状态仍是 ACTIVE 所以用户能打断、M9 说明失败会停掉剩余段并结束该轮、错误照旧抛出）；结果对象带 `segments` 与 `segmentGapMs` | **成立** |
| §7：「3 × 60 = 180 字容量；超过时把尾部并进第 3 段、允许超长、`mergedOverflow = true`；两组边界断言 `[40,40,120]` 与 130 字无标点硬切」 | `segments.ts` 文件头写着 180 字容量与 `mergedOverflow` 语义；`tests/unit/core/reply-segments.test.ts` 里确有 `assert.deepEqual(result.segments.map(s => s.length), [40, 40, 120])` + `mergedOverflow === true`，以及 `sentence(130)` 的硬切断言 | **成立** |
| §7：「gap 夹在 [250, 1200]、默认 450」 | 测试名 `M3: the gap is clamped into [250, 1200] and defaults to 450` | **成立** |
| 缺口：「语音侧尚未接线——`scripts/` 的入口仍只传 `onTextChunk`（核对命令，预期无命中），所以真机上目前仍是单段合成」 | `git grep -n "onSegment" -- scripts` → **无命中**；对话入口（`chat.ts`/`serve-chat.ts`/`voice-turn.ts`）确实只传 `onTextChunk`。**注意语义边界（我额外查了）**：现场测试控制台的演练会把 `splitReplyIntoSegments()` 的结果**按段显示成多行文本**（`pxPlaySegments` 用 `setTimeout(step, gapMs)` 逐行 append DOM），那条路径里没有 TTS——所以文档说的「**分段说话**（语音）要等语音侧接线」是**准确的**，我不会把「分段显示」当成「已接线」 | **成立** |
| §6 第三行的其它字面 | 「引擎侧已落地（t41）」「契约与可测条款见 §7 与 ADR-0010」——对应测试文件 `tests/unit/core/reply-segments.test.ts`、`tests/integration/conversation-engine.test.ts` 均在默认门禁内 | **成立** |

## 3. finding

### F1（low）§6 主动开口行把 `ProactiveEngine` 的调用方说少了一半，缺口被夸大

- **位置**：`docs/design/conversation.md` §6 缺口表的「主动开口（§15）」行——原文「**缺口**：没有候选生成器、没有常驻的考虑循环调用方（`ProactiveEngine` 目前只有测试在调用），模型侧 ……」。
- **证据（两条命令即可复核）**：
  - `git grep -n "ProactiveEngine" -- packages scripts tests` → 除 `packages/conversation/src/{index,proactive}.ts` 与测试外，**命中 `scripts/field-test.ts`**；
  - `git grep -n "proactiveDrill" -- scripts tests` → `scripts/field-test.ts` 的导出函数 `proactiveDrill()`（在 `runSelfTest` 之外的**控制台路径**上被 `:2075` 附近的路由调用）里 `new ProactiveEngine({...})` + `await engine.consider({...})`；页面侧 `git grep -n "试一次主动开口" -- scripts/field-test.ts` → 按钮 `id.drill`，连到 `/proactive/drill`。
- **为什么算「夸大缺口」而不是「笔误」**：读者（包括下一轮要接线的人）会据此认定「主动开口只有单测在跑、真机上没东西可试」，而事实上用户拿到控制台**今天就能**：按一下演练按钮走完九门禁 → 看到逐门禁状态与 `reason_code` 中文解释 → 看到「已写审计事件 #N」→ 看到这条候选的分段文本计划；还能在面板里改强度/静默时段/额度并从审计恢复。这直接影响「用户能不能在真机上看到主动性」的判断，属于必须改的表述。
- **requiredFix**：把括号里的「（`ProactiveEngine` 目前只有测试在调用）」改成分工准确的写法，例如「**调用方目前只有一个按需演练**：现场测试控制台的『试一次主动开口』（`scripts/field-test.ts` 的 `proactiveDrill`，核对：`git grep -n "proactiveDrill" -- scripts`）与测试；**没有常驻的考虑循环**，也没有候选生成器」。顺手把控制台已有的东西（演练按钮 + 主动性面板 + 审计恢复）写进同一行或 §7 的现状句，别让读者以为真机上无从验证。

## 4. 观测（不改变 verdict）

- **O1（`proactive.decision` 的唯一例外）**：文档写「**每次判定**落一条 `proactive.decision` 审计」——代码里有一处**自己声明**的例外：整机开关关着时（`DISABLED`）不写事件，`consider()` 的注释给的理由是「关掉的引擎不算一次判定，给每次轮询都记一条会把真历史埋掉」。这不算错（关掉时确实没有「判定」），但若想更精确，可在该行加半句「（整机开关关闭时不写，见 `ProactiveEngine.consider` 的注释）」。**不需要为它单开任务**。
- **O2（这次失真的成因，供修复时避坑）**：控制台的演练/面板与 t50 的文档改写**落在同一批提交里**（`1f6036f` 一口气收了 `scripts/field-test.ts` +600 行与 `conversation.md` 的改写），也就是说文档是在没有那份控制台代码的快照上写的。所以修 F1 时请**以当前 `scripts/field-test.ts` 的主动性面板为准**再核一遍，别只把那半句删掉了事。

## 5. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `git grep -n "ProactiveEngine" -- packages scripts tests` | 命中 `scripts/field-test.ts`（生产入口）与测试 → F1 |
| `git grep -n "proactiveDrill" -- scripts tests` / `git grep -n "试一次主动开口" -- scripts/field-test.ts` | 演练函数 + 页面按钮（`/proactive/drill`）→ F1 |
| `git grep -n "onSegment" -- scripts` | **无命中（exit 1）** → §6/§7 的「语音侧未接线」成立 |
| `git grep -n "resolveReplyLimits(" -- packages` | `engine.ts`（构造时读 `config.reply`）+ `segments.ts`（定义）→「`config.reply` 已被读取」成立 |
| `git grep -n "block(" -- packages/conversation/src/proactive.ts` | 13 条短路（九个门禁 + 总开关/触发源开关/最多一次账本），顺序在代码注释里被声明为契约 |
| `git grep -n "appendEvent\|deliver" -- packages/conversation/src/proactive.ts`（读 `consider()`） | 先 `#record({delivered: true})` 再 `await deliver?.()` → 「先记后播」成立 |
| `git grep -n "evaluateProactiveCandidate" -- packages` | `mimo.ts`/`fake.ts`/`dsh.ts` 三处 `notImplemented(..., 'M5')` → 成立 |
| 读 `tests/unit/core/reply-segments.test.ts` | `[40, 40, 120]` + `mergedOverflow === true`、`sentence(130)` 硬切、gap 夹紧 → §7 成立 |
| 读 `scripts/field-test.ts` 的 `proactiveDrill` / `pxPlaySegments` | 演练走真实 `consider()`；分段只作**文本**逐行显示（无 TTS）→ 上述判定 |
| `npm test` | **tests 180 / pass 180 / fail 0 / skipped 0**，exit 0（壁钟 20.3s，修订号 `6dfdf90`） |
| `npm run check:docs` | 检查了 **51 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |

**我做过的真实外部动作**：**0 次 API 调用**（未花任何费用）、未开摄像头/麦克风、未写任何数据库；全程只读。
