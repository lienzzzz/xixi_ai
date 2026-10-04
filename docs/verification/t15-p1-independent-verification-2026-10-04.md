# Phase 1 独立复验（t15）：四条验收 + 茉莉花茶与绿茶纠正两个场景

最后更新：2026-10-04

- **复验基线修订号**：`59cd65a`（认领时的 `HEAD`；`git status --porcelain` 为空，没有在途产物）
- **复验人**：verifier（独立于实现者与评审；本报告只写我自己跑出来的东西）
- **复验范围**：pack `E:\xixi_v03_actual_code_pack` 的 `08_PHASES_AND_ACCEPTANCE.md` §Phase 1 四条验收 + `02_MEMORY_CONTEXT.md` 的场景
- **工具**：`docs/verification/t15-probe.mjs`（本次随报告一起提交，命令可直接重跑）、真模型走 `scripts/chat.ts`
- **一句话结论**：**四条验收在「程序能匹配的说法」下全部成立**（写入 / 跨进程重启 / 召回进 `prompt.user` / 纠正后不再召回），
  **但 pack 场景一原样的那两句都不成立**：Day1 那句不写入任何记忆，Day2 那个问句也不会召回；另外复验过程中发现
  一个**疑问句被当成偏好事实写入**的缺陷（早于 P1，但 P1 让它从「库里的脏行」变成「会进提示词的东西」）。
  下面逐条给命令、输出与判定，未达标的地方按未达标写。

## 0. 怎么复跑（全部命令都在仓库根执行）

```powershell
# 门禁
npm run check:types
npm test
npm run check:docs

# 四条验收的离线链路（文件库；每一步都是一个新进程 = 真的重启）
$env:T15_NOW = '2026-10-05T20:00:00+08:00'
node docs/verification/t15-probe.mjs write   "$env:TEMP\t15-a" "我很喜欢喝茉莉花茶。"
node docs/verification/t15-probe.mjs dump    "$env:TEMP\t15-a"
$env:T15_NOW = '2026-10-06T20:00:00+08:00'
node docs/verification/t15-probe.mjs ask     "$env:TEMP\t15-a" "茉莉花茶还有吗？"
node docs/verification/t15-probe.mjs ask     "$env:TEMP\t15-a" "给我推荐个茶。"

# 纠正闭环
$env:T15_NOW = '2026-10-05T20:00:00+08:00'
node docs/verification/t15-probe.mjs write   "$env:TEMP\t15-b" "我很喜欢喝绿茶。"
$env:T15_NOW = '2026-10-06T20:00:00+08:00'
node docs/verification/t15-probe.mjs correct "$env:TEMP\t15-b" "我什么时候喜欢绿茶了，我不喝那个。"
$env:T15_NOW = '2026-10-07T20:00:00+08:00'
node docs/verification/t15-probe.mjs ask     "$env:TEMP\t15-b" "绿茶还有吗？"

# pack 原句（两个反例）
node docs/verification/t15-probe.mjs write   "$env:TEMP\t15-c" "我不喝绿茶，平时喜欢茉莉花茶。"
node docs/verification/t15-probe.mjs write   "$env:TEMP\t15-d" "你还记得我喜欢喝什么茶吗？"
node docs/verification/t15-probe.mjs realdump "$env:TEMP\t15-d"

# 真模型（会花钱；每行一个进程 = 真的重启）
$env:XIXI_DATA_DIR = "$env:TEMP\t15-real"
'我很喜欢喝茉莉花茶。'          | node scripts/chat.ts
'你还记得我喜欢喝什么茶吗？'    | node scripts/chat.ts
node docs/verification/t15-probe.mjs realdump "$env:TEMP\t15-real"
```

`T15_NOW` 只是模拟时钟（跨天用）；不设就是真实时间。`realdump` 直读 SQLite 的
`semantic_memory` / `episodic_memory` 与 `events`，**不看任何页面的自述**。

## 1. 门禁（我自己跑的）

| 命令 | 实测 | 判定 |
|---|---|---|
| `npm run check:types` | exit 0 | ✅ |
| `npm test` | `ℹ tests 575 / pass 575 / fail 0`，`duration_ms 41444`，exit 0（进程外墙钟 42.0 s） | ✅ |
| `npm run check:docs` | 本报告写入前：99 份 markdown；**本报告与探针写入后（最终状态）：100 份 markdown，失效链接 0 / 不存在的文件引用 0 / 缺少新鲜度标记 0**，两次都 exit 0 | ✅ |

## 2. 四条验收逐条

### ① 对话写入记忆 —— **分两种说法：程序能匹配的成立，pack 原句不成立**

```powershell
node docs/verification/t15-probe.mjs write "$env:TEMP\t15-a" "我很喜欢喝茉莉花茶。"
```

实测（JSON 片段）：`semantic[0] = { property: "preference", statement: "我很喜欢喝茉莉花茶", status: "active", confidence: 0.9 }`。

**反例（pack 场景一 Day1 的原句）**：

```powershell
node docs/verification/t15-probe.mjs write "$env:TEMP\t15-c" "我不喝绿茶，平时喜欢茉莉花茶。"
```

实测：`semantic: []`、`active: []`、`audit: []` —— **一条记忆都没写**。真模型走
`scripts/chat.ts` 跑同一句，事后 `realdump` 同样得到 `semantic: []`。

代码证据（为什么）：`packages/conversation/src/extractor.ts` 的 `SEMANTIC_RULES` 只有四条正则
（`我(?:很|挺|特别)?(?:喜欢|爱)…`、`我(?:不喜欢|不爱|讨厌)…`、`我(?:住|住在|老家在)…`、`我(?:每天|平常|平时|一般)…`），
而且 `pattern.exec(job.userText)` 是**拿整句去匹配、不按逗号切分**：
原句里唯一的「我」后面接的是「不喝绿茶」，四条正则都接不上。

判定：**① 未达标（pack 原句）／在「我+喜欢/不喜欢/平时…」这类说法下成立**。

### ② 进程重启后记忆仍在 —— ✅

这条交付用例用的是 `:memory:`（t21 也把它记成唯一的 low），所以**我不用它**：上面每条命令都是
一个新 `node` 进程、同一个**文件库**。`write`（进程 1）→ `dump`（进程 2）→ `ask`（进程 3）
读到的都是同一行 `我很喜欢喝茉莉花茶`（`status: active`）；真模型侧每一步也都是新的
`scripts/chat.ts` 进程（输出里的「会话 sess_…，已有 N 轮」可核对）。

判定：✅（前提是按 ① 里「能匹配」的说法写入；pack 原句因为压根没写，这一条无从谈起）。

### ③ 后续正常聊天主动召回 —— **分问句：词面重合的成立，pack 原问句不成立**

```powershell
node docs/verification/t15-probe.mjs ask "$env:TEMP\t15-a" "茉莉花茶还有吗？"
```

实测：`retrieval.injected = 1`，`memories` 段存在，`prompt.user` 里出现
`你们以前真正聊过、这轮可能有用的事：\n- [较确定] 我很喜欢喝茉莉花茶`。
prompt 审计：`hasDatabaseWord=false`、`hasUuidShape=false`、`hasMachineId=false`、
`hasLongDigits=false`、`hasDebugField=false`（**内部 id 与调试字段没有进提示词**）。

**反例（pack 场景一 Day2 的原问句）**：

```powershell
node docs/verification/t15-probe.mjs ask "$env:TEMP\t15-a" "给我推荐个茶。"
```

实测：`retrieval.injected = 0`、`dropped = [{ kind: "semantic", reason: "not_relevant" }]`、
`sectionNames` 里**没有 `memories`**。原因（代码证据）：`packages/context/src/memory-retriever.ts`
的相关性先决要求词面重合，「给我推荐个茶」与「我很喜欢喝茉莉花茶」之间**没有共同的双字词**
（只有单字「茶」），于是检索层就丢了它——这与渲染闸门无关。

判定：**③ 未达标（pack 原问句）／在「茉莉花茶还有吗」这类共享词面的问法下成立**。

### ④ 纠正后旧事实不再召回 —— ✅

```powershell
node docs/verification/t15-probe.mjs correct "$env:TEMP\t15-b" "我什么时候喜欢绿茶了，我不喝那个。"
node docs/verification/t15-probe.mjs ask     "$env:TEMP\t15-b" "绿茶还有吗？"
```

实测（纠正那一轮）：旧行 `我很喜欢喝绿茶` → `status: "superseded"` 且 `supersededBy` 指向新行；
新行 `我不喝绿茶` → `status: "active"`、`confidence: 1`；两条都在（历史没被改写）；
`episodicCorrections = ["更正了一条以前记下的事：现在按「我不喝绿茶」记"]`；
事件日志里一条 `system.health(service=memory.status)`，detail 写明
`… → superseded：disown_claim：与「我很喜欢喝绿茶」结论相反（共享被否定的那个词）；新说法：我不喝绿茶`。

实测（随后那个新进程里问茶）：`candidates = 2`、`injected = 2`，两条分别是
`episodic:更正了一条以前记下的事…` 与 `semantic:我不喝绿茶`——**被取代的旧句不在候选里**，
`prompt.user` 里也没有它。

判定：✅。

## 3. 场景一（茉莉花茶偏好）：pack 原样**未达标**，等价改写**达标**

真模型（`mimo-v2.6-flash` / 直连），每一步一个新进程：

| 步骤 | 输入 | 实测回答 | 库里发生了什么 |
|---|---|---|---|
| Day1（pack 原句） | 我不喝绿茶，平时喜欢茉莉花茶。 | 「茉莉花茶好啊香片那个味儿早上泡一杯挺醒神的。你平时喝哪种是散装的还是袋泡的？」 | `semantic: []`（**没记下任何东西**） |
| Day2（pack 原问句，新进程） | 给我推荐个茶。 | 「这个我记不准，不敢乱说——要不我查一下再告诉你？」＋`[提示 UNBACKED_FACT_CLAIM]` | `dropped: not_relevant`（即便有记忆也召不回） |

说明两点，免得被误读：① Day2 那句话**不是模型的回答**，而是引擎的修复句
（`packages/conversation/src/engine.ts` 的 `UNBACKED_FACT_REPLY`：模型给出可核查事实又没调工具时整句替换）；
② Day1 的回答本身是自然的、没有机械话——问题在于**她什么都没记下**，于是 Day2 无偏好可用。

**等价改写（只把说法换成程序能匹配的）**：

| 步骤 | 输入 | 实测回答 |
|---|---|---|
| Day1 | 我很喜欢喝茉莉花茶。 | 「茉莉花茶好啊尤其是早上喝香得清醒你是喜欢那种浓一点的茉莉香还是茶叶味重些的？」 |
| Day2（新进程） | 你还记得我喜欢喝什么茶吗？ | 「记得啊，茉莉花茶嘛之前你说过挺喜欢的我记着呢。」 |

**措辞检查（「不说『根据数据库』这类机械话」）**：本次 8 轮真模型回答里，
`数据库` / `资料库` / `记录显示` / `系统显示` / `后台` / `档案` **0 命中**；
离线侧整段 prompt（system + user + 各 section）`hasDatabaseWord=false`，
也就是说**提示词里根本没有「数据库」这个词**，而 `HARD_POLICY`（`packages/conversation/src/prompt.ts`）
明确写着「不提代码、仓库、文件、模型、提示词或你的实现」「工具只是能力，不报幕」。
样本只有 8 轮，**这是观察值不是统计结论**。

判定：**场景一 pack 原样未达标；等价改写达标**。

## 4. 场景二（绿茶纠正）：✅

| 步骤 | 输入 | 实测回答 | 库里的状态（`realdump`） |
|---|---|---|---|
| Day1 | 我很喜欢喝绿茶。 | 「绿茶好啊早上一杯挺醒神的。你是喜欢泡龙井那种豆香的…」 | 新行 `我很喜欢喝绿茶` → `active` |
| Day2（新进程） | 我什么时候喜欢绿茶了，我不喝那个。 | 「我看你刚说喜欢喝绿茶，就顺嘴接上了是我搞混了。那你平时喝什么？」 | 旧行 → `superseded`；新行 `我不喝绿茶` → `active`；episodic `correction` 一条；`memory.status` 审计一条 |
| Day3（新进程） | 你还记得我喜欢喝什么茶吗？ | 「说实话我不敢乱说了刚已经闹过一回乌龙你直接告诉我吧我这次记牢。」 | 被取代那条不在候选里（只取 active） |

即：**她不再把「你喜欢绿茶」当成事实说出去**，而历史里能看到旧记忆的状态变化
（`superseded` + `supersededBy` + 审计行）。判定：✅。

## 5. 复验中发现的新缺陷（未达标项，**不是 P1 引入**）

**疑问句被当成偏好事实写入语义记忆。**

```powershell
node docs/verification/t15-probe.mjs write "$env:TEMP\t15-d" "你还记得我喜欢喝什么茶吗？"
```

实测：写进一条 `preference`，`statement = "我喜欢喝什么茶吗"`、`status = "active"`、`confidence = 0.9`。
真模型侧同样中招：本次两个真模型库里都有这行（`realdump "$env:TEMP\t15-real-variant"` 与
`…\t15-real-green` 都能看到 `我喜欢喝什么茶吗 / active`）。

机制（代码证据）：`packages/conversation/src/extractor.ts` 的守卫写的是
`if (statement.includes('？') || statement.includes('?')) return;`，而 `statement` 取自
`match[0]`，正则是 `我(?:很|挺|特别)?(?:喜欢|爱)([^。！？!?，,；;]{2,20})` ——
**字符类已经把 `？` 排除在匹配之外，所以这个 includes 恒为假**；而同一文件上方的注释写着
规则是给「短句、第一人称、**非疑问**」用的。正确的判定对象是 `job.userText`（整句是不是问句），
不是 `match[0]`。

来源与影响：`git log -S "statement.includes('？')" -- packages/conversation/src/extractor.ts` 显示它随第三轮的
`1efc8b3` 就有了，**属于既有缺陷**；但 P1 之后这条脏行会被检索、会进 `prompt.user`
（「日常对话里的一句问话变成她记得的偏好」），所以现在值得修：规则匹配前先判问句形态，
并补一条回归用例（问句不许产生 semantic 行）。修法属实现方 inScope，本报告只给证据。

## 6. 三类证据的区分（本报告的写法约定）

| 类别 | 本报告里指什么 | 我怎么处理 |
|---|---|---|
| **实现者/评审的输出** | t12 / t13 / t20 / t21 的完成回报与复审结论 | 只当线索：用来决定「应该验哪条链路」，**不作为证据引用** |
| **我的复算** | 本报告 §1–§4 里每条命令的输出、8 轮真模型回答、离线探针 JSON | 全部自己跑；数字与引文都来自本次运行 |
| **代码或产物证据** | `packages/conversation/src/extractor.ts` 的规则与守卫、`packages/context/src/memory-retriever.ts` 的相关性先决、`packages/conversation/src/engine.ts` 的修复句常量、真模型库的 `semantic_memory` / `events` 行 | 给可复跑的 `git grep` 或 `realdump`，不靠转述 |

## 7. 未达标与边界（如实清单）

1. **场景一 pack 原句**：Day1「我不喝绿茶，平时喜欢茉莉花茶。」→ 0 条记忆。**未达标**（§2①、§3）。
2. **场景一 pack 原问句**：「给我推荐个茶。」→ 检索层 `not_relevant`，召回不到（即便有记忆）。**未达标**（§2③、§3）。
3. **疑问句入库缺陷**（§5）：新发现、既有来源、P1 后后果放大。**未达标/待修**。
4. **默认门禁里仍然没有「重启后仍在」的守护**：交付用例是 `:memory:`（t21 记的 low），
   本次由我的跨进程探针覆盖，但 `npm test` 里没有等价的自动化断言。
5. **措辞检查样本小**：8 轮真模型回答 + 离线 prompt 审计；真模型每次调用花钱，报告里给的是本次观察值，不是统计结论。
6. **离线探针的回答文本不是产品回答**：那里用 `FakeBrainAdapter`，产品性体现在 prompt 与库状态上；
   用户可见路径只有 §3/§4 的真模型那几轮。
7. **观察（不算缺陷）**：普通首次陈述的 `source_type` 也是 `explicit_correction`
   （`packages/domain/src/memory.ts` 的注释把它解释为「父亲明确说的（纠正、偏好、事实）」）——
   命名窄、语义宽，建议下一轮要么改名要么在文档里写清，避免审计时把「纠正」当成计数口径。
