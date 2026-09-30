# 评审：两条时间判据注释是否与实现一致（t105）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t102 的层面复核与 t105 的落笔）
> 评审对象：`930c130`「t105 完成：把两条时间判据陷阱记进注释（纯注释、零行为变化）」（只改 `packages/domain/src/store.ts`，**+16 / −1**），以及随 t103（`d67b89c`）落地的 `presenceFreshness` 头注释（t105 回报里说明了它在那次提交里）
> 复核方式：**注释里给的核对手段我全都实跑**（两条 grep + 那条一行实验），另用真库做边界注入实验与「传 Date」翻转实验；全部只读
> 时序：判读时 HEAD `cd21edd`；`930c130..HEAD` 里 `packages/domain/src/store.ts` **没有再变**（`git diff --stat 930c130..HEAD -- packages/domain/src/store.ts` 为空）→ 我引用的注释就是被评版本

---

## 1. 结论

**verdict：pass（无 finding；3 条观测在 §6）**

一句话：**这两条注释与实现逐字一致，而且把「那个一瞬间的差别」的**方向**写对了**。我把注释给的核对手段都跑了一遍：`git grep -n "stale: Date.parse" -- packages/domain/src/store.ts` 正好命中 `worldState()` 与 `worldStateEntries()` **两处**（`:738`、`:755`），与注释里写的那行代码逐字相同；注释里那条一行实验 `Date.parse(d.toString()) - d.getTime()` 跑出来是**负数**（我这次 `-11`，连跑 5 次落在 `-128 … -975`），说明丢掉的正是毫秒（0–999 ms）。边界语义我也注入真库核过：注入 `staleAfter` 原串 → `stale=true`，早 1 ms → `false`，晚 1 ms → `true`（greater-or-equal 无疑）；而**同一个瞬间换成 `Date` 对象注入** → `stale` 从 `true` 翻成 `false`（那 509 ms 被 `toString` 丢掉了）——注释警告的正是这件事。最后，「控制台路径 vs 纯函数」的边界差别**没有写反**：同一条命令里实测「不给 `stale` 旗标 → `fresh: true`（规则 4 的 `ageMs > ttl*1000` 为假，说『还在 TTL 内』）」「给 `stale=true` → `fresh: false`（规则 2 短路）」，差别方向确实是**偏安全**（控制台那条更严，宁可不说「刚到家」）。

| 任务验收条款 | 我的判定 | 依据 |
|---|---|---|
| 1 注释里的边界描述与 store 实现逐字一致（跑那条 grep 与一行实验，确认 greater-or-equal 与毫秒丢失范围）；注释没有把「控制台路径」与「纯函数」的边界差别写反 | **真正满足** | §2（grep + 一行实验）、§3（>= 语义）、§4（毫秒丢失与翻转）、§5（两半都实测） |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/` | **满足** | §7：`npm test` **235/235 pass / 0 fail / exit 0**；`check:docs` **72 份 / 0 问题 / exit 0** |

---

## 2. 注释给的核对手段，我逐条实跑

| 注释里写的 | 我跑的结果 |
|---|---|
| `git grep -n "stale: Date.parse" -- packages/domain/src/store.ts`（用来证明两处都是 greater-or-equal） | **命中两处**：`store.ts:738` 与 `store.ts:755`，两行都是 `stale: Date.parse(now) >= Date.parse(staleAfter),`——与注释引的那行**逐字相同** ✓ |
| `node -e "const d=new Date(); console.log(Date.parse(d.toString())-d.getTime())"`（毫秒丢失的方向与量级） | 单跑一次打印 **−11**；连跑 5 次：**−530 / −678 / −825 / −975 / −128**，每次都等于 `-d.getMilliseconds()`，落在注释写的 **0–999 ms** 区间内、符号为负 ✓ |
| 注释声称 t102 实测 **410 ms** | 与我在 t102 的量测一致（当时 `Date.parse(new Date())=1790766200000` 而 `Date.parse(d.toISOString())=1790766200410`，差 410 ms）✓ |

---

## 3. `>=` 语义：注入字符串的边界实测

用真库造一行 `presence.home`（`updatedAt 19:24:11.509+08:00`、TTL 60 s → `staleAfter 19:25:11.509+08:00`），注入三种 `now`：

| 注入的 `now` | `stale` |
|---|---|
| `staleAfter − 1 ms` | `false` |
| **`staleAfter`（恰好相等）** | **`true`** ← greater-or-equal |
| `staleAfter + 1 ms` | `true` |

与注释「域 store 是 greater-or-equal（`stale: Date.parse(now) >= Date.parse(staleAfter)`）」**一致** ✓，也与注释对「同一瞬间控制台判不新鲜」的推断一致（§5）。

---

## 4. 传 `Date` 会丢毫秒，而且能把边界结论**静默翻转**

同一个边界瞬间，两种注入方式：

| 注入 | 结果 |
|---|---|
| **String**：`'2026-09-30T19:25:11.509+08:00'`（= `staleAfter` 原串） | `stale = true`（边界该有的答案） |
| **Date**：`new Date('2026-09-30T19:25:11.509+08:00')`（同一瞬间） | **`stale = false`** ← 毫秒 509 被 `toString` 丢掉，落到了 `staleAfter` **之前** |

注释里「a `Date` reaches `Date.parse` through `Date#toString`, which **drops the milliseconds** … the loss is anywhere in 0–999 ms depending on the moment … a store-level boundary test must inject a **string**」——**逐条成立** ✓。我还顺手确认了注释给的回注办法：**用行自己的 `staleAfter` 原串**注入 → `stale === true`（即边界用例），`1 ms` 之前 → `false`，两条命令都对。

---

## 5. 「控制台路径」与「纯函数」的边界差别：没有写反

注释（`presenceFreshness` 头部，`scripts/field-test.ts:4239-4248`，随 t103 落地）写的是：

> **The `stale` flag wins over this function's own arithmetic** … the store uses a **greater-or-equal** rule … so exactly on the boundary (`updatedAt + ttlSeconds === now`) the console path says **not fresh** while rule 4 below (`ageMs > ttlSeconds * 1000`) would have said "still inside the TTL" … the difference points the safe way …

我在**一条命令**里把两半都实测了（同一 `updatedAt`，`now = updatedAt + 60 s`）：

| 输入 | `presenceFreshness` 的答案 |
|---|---|
| `stale: false`（模拟不带旗标的调用方，如 `serve-chat` 那条路径） | `{"fresh":true, "reason":"60s 前更新，在 60s 的 TTL 内"}` ← 规则 4 的算术「还在 TTL 内」 |
| `stale: true`（域 store 在边界上给出的旗标） | `{"fresh":false, "reason":"在场投影已被标为过期（T 60s）"}` ← 规则 2 短路 |

**两者在边界上确实不同，且控制台那条更严（偏安全）** ✓ —— 注释没有写反。代码侧也对得上：规则 2 在 `store.ts` 那侧的旗标为真时**先返回**（`if (presence.stale === true) return …`），根本走不到 `ageMs > ttlSeconds * 1000` 那一步；而 t105 在 `worldState()` / `worldStateEntries()` 两处补的注释（「`query.now` must be a string…」）正好把这条链路的入口也钉住了。

---

## 6. 观测（都不改变 verdict）

- **O1（低，措辞可以更精确）**：`WorldStateQuery.now` 的注释说「**Give it an ISO-8601 string with milliseconds and an explicit offset**」。要求「带毫秒」是对的（毫秒一带上就不会丢），但「**显式偏移**」比解析器的硬要求更严：带 `Z` 的 ISO 串同样能保住毫秒——我这次实验里注入过 `'2026-09-30T11:25:11.508Z'` 这种 `Z` 形式，判出来的 `stale` 与同瞬间的 `+08:00` 串**一致**。注释的用意是「和行里 `updatedAt`/`staleAfter` 同一形状、最省心」，这没错；只是后来者可能读成「`Z` 形式不行」。建议补半句：「（`Z` 形式也能用，但直接回注行里的 `staleAfter` 原串最不容易出错）」。
- **O2（正面，值得保留的写法）**：两条注释都用「符号 + 一条可复现的 `git grep`」定位实现，不写行号——而**行号已经漂了**：t105 的 diff 上下文里那两行在 ~717/733，现在在 **738/755**（t105 自己加了注释、把行号往下推），grep 仍然准确命中两处。这正是 `AGENTS.md` §9.18 要的形态。
- **O3（信息，「纯注释、零行为变化」成立）**：`git show 930c130 --numstat` = `16 / 1`，改动里唯一的非注释行是被删掉的旧 doc 注释（`-  /** Override "now" (tests, replays). Defaults to the store clock. */`）→ 没有任何可执行语句被改动；`store.ts` 自 `930c130` 起也没有再被改过（§顶部时序）。

---

## 7. 门禁

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | HEAD `cd21edd`；在途是 t106 的 `services/perception-edge/perception_edge/{camera,run}.py` 与 `docs/design/perception.md`（与 `store.ts` 无关） | **235 tests / 235 pass / 0 fail / 0 skipped，exit 0** |
| `npm run check:docs` | 同上 | 检查了 **72 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 73 份 / 0 问题 / exit 0） |

**复核时点**：上表在 `cd21edd` 跑过一次；t106 落地（`cae1e08`）后我又把两条各跑一次（此刻在途只剩 `services/perception-edge/perception_edge/run.py`），数字**完全相同**：`npm test` 235/235 exit 0、`check:docs` 73 份 0 问题 exit 0。

---

## 8. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `git grep -n "stale: Date.parse" -- packages/domain/src/store.ts` | 命中 `:738`、`:755`，与注释引文逐字相同（§2） |
| `node -e "const d=new Date(); console.log(Date.parse(d.toString())-d.getTime())"` | 单跑 −11；连跑 5 次 −530 / −678 / −825 / −975 / −128（= −毫秒位，0–999）（§2） |
| `node data/rev-tmp/t108-probe.mjs`（**我自写**：真库注入三种 `now` + String/Date 对照 + 一行实验 ×5） | §3 与 §4 的原始值（边界 `stale=true`；同一瞬间 Date → `false`，丢 509 ms） |
| `node -e "import('file:///E:/worker2/scripts/field-test.ts')…"`（边界的两半） | `stale:false → fresh:true`；`stale:true → fresh:false`；两者不同（§5） |
| `git show 930c130 --numstat` 与 `git diff --stat 930c130..HEAD -- packages/domain/src/store.ts` | 16/1 且只有注释行；自该提交起 `store.ts` 未再变（O3、时序） |
| `git log --oneline -1 -S "flag wins over this function" -- scripts/field-test.ts` | `d67b89c`（t103）——与 t105 回报里「field-test.ts 那段随 t103 提交」一致 |
| `npm test` / `npm run check:docs` | 235/235 exit 0；72 份 0 问题 exit 0 |

---

## 9. 我做过的真实外部动作

**0 次 API 调用**、未开摄像头/麦克风、未起任何服务；所有实验都用系统临时库（跑完即删）或纯内存对象，**未写入任何共用库**。**未改动任何他人的文件**（本次评审只读 git 修订、文档、注释与一行 `node -e`）。唯一写入产物是本文件；探针脚本留在 `data/rev-tmp/`（`t108-probe.mjs`，`data/` 已 gitignore，非交付物）。基线修订 `cd21edd`（工作时 HEAD；被评交付点 `930c130`）。
