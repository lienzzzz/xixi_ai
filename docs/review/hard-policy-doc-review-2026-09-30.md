# 评审：闸门表与条数核对命令（t115）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t111 的实现与 t115 的落笔）
> 评审对象：`8000e8d`「t115 完成：conversation.md 补 HARD_POLICY 第 7 条与程序层闸门表」（只改 `docs/design/conversation.md`，+30 / −2）
> 复核方式：**自写探针三种情形**（无工具 / 工具在文本前 / 工具在文本后）+ 逐行对读 engine.ts 分支 + 把文档那条条数命令按同口径作用在**内存副本**上试它的失灵方式（不动仓库里的文件）
> 时序：判读时 HEAD `e86a17e`（那次提交只加了 t114 的评审报告）；`8000e8d..HEAD` 里 `packages/conversation/src/engine.ts` 与 `docs/design/conversation.md` **都未变**，所以我核的就是被评版本

---

## 1. 结论

**verdict：pass（两个验收点都成立；4 条观测在 §4，都不改变判定）**

一句话：**① 闸门表里那句「有工具就放行 / 没有就扣住」与 `engine.ts` 的实际分支逐字一致**——我按三种情形端到端跑了：无工具 → 扣住并改说修复句（进 TTS、进日志、进 `onNotice` 的都是修复句）、工具在文本**之前** → 原文照说、工具在文本**之后** → 被扣住的那句随后**放行**（正是表里那句「同一轮里真有 `tool` chunk → 句子照说」）；`screenUnbackedFacts` 的两个分支也与表里第 2 行逐字对上。**② 那条条数核对命令今天是对的（输出 7），但确实不够硬**——我用同一条正则作用在内存副本上：别处新增一个编号列表就报成 **9**、把规则换成 `- ` 项目符号就报成 **0**（7 条一条不少），而它指向的 `tests/unit/prompt.test.ts` 只断言了 `prompt.system.includes(HARD_POLICY)`，**对条数与文案没有任何断言**，`check:docs` 也只查链接/引用/新鲜度。判断与建议见 §3。

| 任务验收条款 | 我的判定 | 依据 |
|---|---|---|
| 1 闸门表措辞与 engine.ts 实际分支逐字一致（自己读分支 + 构造有/无工具两种情形验证） | **成立** | §2：三种情形 5 项断言全过；两处分支逐字对上 |
| 2 条数核对命令是否够硬（只数 `^N.` 行，写法一变就失灵）——给出判断与建议 | **成立（判断：不够硬；建议见 §3）** | §3：两种失灵方式实测；给出可直接落地的硬断言 |
| 3 自己跑 npm test 与 check:docs 并贴结果；结论落 `docs/review/` | **满足** | §5：`npm test` **243/243 pass / 0 fail / exit 0**；`check:docs` **77 份 / 0 问题 / exit 0** |

---

## 2. ① 闸门表 vs `engine.ts`：逐条对上

文档表里 4 行的关键措辞，我逐条对读并实测：

| 文档写的 | 代码/实测 |
|---|---|
| `screenUnbackedFacts(text, toolName)`：「本轮 `toolName !== null`（真的调用过工具）→ 原样放行；否则命中就返回 `{ok:false, text: UNBACKED_FACT_REPLY}`」 | `git grep -n -A 6 "screenUnbackedFacts(" -- packages/conversation/src/engine.ts` 的第一个分支就是 `if (toolName !== null) return { ok: true, text, claims: [] }`，其后才判 `findUnbackedFactClaims` ✓。实测：`('明天成都阴天 19 到 25 度…', 'xixi_get_weather')` → `{ok:true, text:原文, claims:[]}`；`(同句, null)` → `{ok:false, text:'这个我记不准…', claims:[temperature:19 到 25 度]}` ✓ |
| `respond()`：「把含该值的文本**扣住**（流式路径也不再交给 `onTextChunk`，所以不会进 TTS）、**不写**进 `conversation.turn`、不改工作记忆，改说 `UNBACKED_FACT_REPLY`；同时给调用方一条 `onNotice({code:'UNBACKED_FACT_CLAIM'…})`」 | 实测三件都成立：`turn.text` = 修复句、`onTextChunk` 收到的**只有**修复句（`19` 从未出现）、`store.recentTurns()` 里的 assistant 轮也是修复句、`onNotice` 就那一条 ✓（措辞上的一点不精确见 O2） |
| `respond()`：「**同一轮里真有 `tool` chunk → 句子照说**」 | 我特意构造了 **tool chunk 在文本之后**：文本先被扣住，`tool` chunk 到达时 `heldFacts` 被放行 → 最终 `turn.text`/`onTextChunk`/日志**都是原文**、无通知 ✓。工具在**文本之前**同样原文照说 ✓ |
| 「普通回复走 `ConversationEngine.buildPrompt`；主动开口的 `createModelComposer` 也调同一个 `engine.buildPrompt`」 | `git grep -n "engine.buildPrompt" -- scripts/field-test.ts` 命中模型生成器那处调用 ✓（我 t114 端到端也跑过它） |
| 第 7 条文案（天气/气温/降水概率/风力/空气质量/新闻/日程/别人说的话 + 「可以调工具」+「没查就直说不知道」+「对主动开口同样有效」） | 与 `prompt.ts:69` 的原文逐句对得上 ✓（`git grep -n "可核查的具体事实" -- packages/conversation/src/prompt.ts`） |
| 「代价：流式路径下含未核实具体值的句子会被扣到本轮结束再决定…分段路径本来就在结束时才播，不受影响」 | 与代码一致：循环里 `if (!playSegments) await hooks.onTextChunk?.(held)` —— 分段路径循环内本来就不吐流 ✓ |

**探针结果（我自写，5 项）**：无工具 → 替换 ✓；工具先 → 原文 ✓；工具后 → 扣住后放行 ✓；`toolName!==null → ok`✓；`toolName===null` 命中 → 修复句 ✓。

---

## 3. ② 条数核对命令够不够硬：判断 + 建议

**命令**（文档 §3 + 维护规则表各出现一次）：`git grep -c -E "^[0-9]+\. " -- packages/conversation/src/prompt.ts`，今天实跑输出 **`packages/conversation/src/prompt.ts:7`**，数出来的正是 `prompt.ts` 第 63–69 行的 7 条规则 ✓（所以「7 条」这个事实是对的）。

**但它的口径是「全文件里以 `N. ` 开头的行」，不是「`HARD_POLICY` 里的规则」**。我把同一条正则作用在内存副本上（仓库文件未改动）：

| 情形（我都构造过） | 文档那条命令 | 「只看 `HARD_POLICY` 常量内部」的口径 |
|---|---|---|
| 现在（被评版本） | **7** ✓ | **7** ✓ |
| 别处新增一个编号列表（规则数没变，例如提示词里再加一段「1. …/2. …」例子） | **9**（虚高） | 7（不受影响） |
| 7 条规则改成 `- ` 项目符号（一条不少） | **0**（假零） | 7（不受影响） |
| 真删掉第 7 条 | 6（能发现） | 6（能发现） |

也就是说：**它只在「规则写法不变、且文件里没有其它编号列表」时才可信**；一旦别的提示词段落用了编号（这是很自然的写法），命令会**虚高**并给出「条数不对」的假警报——比漏报更烦人。另外它不是自动门禁：`check:docs` 输出自己写明只查「链接、文件引用与新鲜度标记」，而文档维护规则表里把它写成「并同步 `tests/unit/prompt.test.ts`」——但那个测试**只有** `assert.ok(prompt.system.includes(HARD_POLICY))`，对条数与文案**一句断言都没有**，所以现在**没有任何自动检查**能发现「删掉一条规则」或「条数改了文档没改」。

**建议（我实测过，可直接落地）**：
1. 把检查搬进 `tests/unit/prompt.test.ts`（它本来就在维护规则表里，且 `HARD_POLICY` 已经是它 import 的常量），用**常量内部**口径而不是全文件口径：
   `assert.equal((HARD_POLICY.match(/^\d+\. /gm) ?? []).length, 7)`；再加一条锚点断言钉住最后一条的标题，例如 `assert.match(HARD_POLICY, /^7\. 可核查的具体事实/m)`（我实测：计数 7 ✓、锚点命中 ✓）。这样「删一条」「改写法」「别的段落加编号」三种情况都不会误报，且**跑 `npm test` 就能挡住**。
2. 文档里那条 grep 要么删掉，要么在原地加一句限定：「这个命令是粗查，**别处新增编号列表会虚高**；条数由 `tests/unit/prompt.test.ts` 的断言保证」。
3. 顺手把「应输出 `7`」写成「应输出 `packages/conversation/src/prompt.ts:7`（数字部分是 7）」，因为 `git grep -c` 的输出带路径前缀（见 O3）。

---

## 4. 观测（都不改变 verdict）

- **O1（低，与 §3 同一件事的结论面）**：「条数与文案」目前**没有自动断言**：`tests/unit/prompt.test.ts` 只断言 `HARD_POLICY` 出现在 system 段里，`check:docs` 不查条数，唯一的口径是被评文档里那条**易失灵**的 grep。这条建议已写进 §3 的建议 1/2。
- **O2（低，措辞可以更精确）**：表格第 3 行写 `respond()` 「**不写**进 `conversation.turn`、不改工作记忆」。严格说：**那句原文**确实不写进去，但这一轮**会**写一条 assistant 轮——内容是**修复句**（我实测 `store.recentTurns()` 里就是修复句；而提示词的 working-memory 段正是由这些轮次拼出来的 `history`）。建议改成「那句**原文**不写进 `conversation.turn`（写进去的是修复句），也不把编造的数值带进工作记忆」——否则读者可能以为这一轮什么记录都没有。
- **O3（信息，输出格式）**：文档说命令「应输出 `7`」，实际输出是 `packages/conversation/src/prompt.ts:7`（带文件名前缀）。数字对得上，读的人也不会误解，但写成完整样例会更好（`-c` 不带 `--no-filename`）。
- **O4（信息，跨任务引用）**：文档 §3 末段「真机实测（t111）… `tool=null` 的轮次不含任何具体值（**违规 0**）」这句，正是我在 t114 报的 **F3**（结论措辞过宽）。补充两个数字供修 t117 时一起收尾：台账里「含具体值且 `tool_name=null`」的 assistant 轮共 **8 条**（`data/chat` 6 + `data/field-test` 1 + `data/web-chat` 1，全部早于修复提交 19:55），而**没有任何一个会话**能对上「7 条 assistant 轮 / 含具体值 4 条」这个描述（chat 35 条中 7 条、field-test 20 条中 3 条、web-chat **恰好 7 条**中只有 **2** 条）。「4 条含具体值的轮次全部伴随 `xixi_get_weather`」这句我**能**复现（跨三个库共 4 条）✓，建议把这句限定为「在**那几次运行的会话里**」，并另起一句写清台账历史里还有 8 条修复前的编造轮次。

---

## 5. 门禁

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | HEAD `e86a17e`（该提交只加了 t114 的评审报告）；工作区干净；`8000e8d..HEAD` 里 `engine.ts`/`conversation.md` 未变 | **243 tests / 243 pass / 0 fail / 0 skipped，exit 0** |
| `npm run check:docs` | 同上 | 检查了 **77 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 78 份 / 0 问题 / exit 0） |

---

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node data/rev-tmp/t116-branches.mjs`（**我自写**：无工具 / 工具先 / 工具后 / `screenUnbackedFacts` 两分支） | **5/5 通过**：无工具→修复句（TTS/日志/通知一致）；工具先→原文；工具后→扣住再放行；`toolName!==null`→ok；`toolName===null`→修复句 + `19 到 25 度`（§2） |
| `node data/rev-tmp/t116-count-hardness.mjs`（**我自写**：同一条正则作用在内存副本上） | 现在 7/7；别处加编号列表 → 文档口径 **9**、常量口径 7；改 `- ` 项目符号 → 文档口径 **0**、常量口径 7；删第 7 条 → 两者都 6（§3） |
| `git grep -c -E "^[0-9]+\. " -- packages/conversation/src/prompt.ts` | `packages/conversation/src/prompt.ts:7`，命中的正是第 63–69 行那 7 条规则 |
| `git grep -n -A 6 "screenUnbackedFacts(" -- packages/conversation/src/engine.ts` / `git grep -n "engine.buildPrompt" -- scripts/field-test.ts` | 分支与文档逐字对上；主动开口确实调同一个 `buildPrompt`（§2） |
| `git grep -n "HARD_POLICY" -e "绝不许" -- tests/unit/prompt.test.ts` | 只有 `assert.ok(prompt.system.includes(HARD_POLICY))` —— 对条数/文案无断言（O1） |
| `node data/rev-tmp/t116-sessions.mjs`（**我自写**：按会话统计） | chat 35 条/7 含值、field-test 20 条/3 含值、web-chat 7 条/2 含值（O4） |
| `npm test` / `npm run check:docs` | 243/243 exit 0；77 份 0 问题 exit 0 |

---

## 7. 我做过的真实外部动作

**0 次 API 调用**、未开摄像头/麦克风、未起任何服务；探针只写系统临时目录（`%TEMP%`）或只读打开台账；**没有改动仓库里的任何文件**——条数命令的失灵演示是在**内存里的字符串副本**上做的（`git status --porcelain -- packages/conversation/src/prompt.ts` 为空，我核过）。唯一写入产物是本文件；探针脚本留在 `data/rev-tmp/`（`t116-*.mjs`，`data/` 已 gitignore，非交付物）。基线修订 `e86a17e`（工作时 HEAD；被评交付点 `8000e8d`）。
