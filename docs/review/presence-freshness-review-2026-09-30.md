# 评审：在场新鲜度判据是否真挡住误报（t98）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t78 的直播路径与 t98 的修复）
> 评审对象：`1d5c1ed`「t98 完成：过期在场投影不再触发『有人到达』（对着空房间开口的根因）」（`scripts/field-test.ts`、`tests/console/proactive-loop.test.ts`、新增 `tests/console/presence-freshness.test.ts`）
> 复核方式：**自写探针 27 项断言全过**——造真库里的新鲜行与 52 分钟前的旧行，走 `readPresence → buildProactiveCandidates / ProactiveLoop.tickOnce` 端到端跑；另用域 store 的注入时钟核对 TTL 边界。不碰摄像头、不发任何请求
> 时序：HEAD = `1d5c1ed`（t98 的提交）；工作区在途的是 **t99** 的 `services/perception-edge/*` 与 `scripts/verify-camera-presence.ts`、`docs/design/perception.md`（与本次评审对象无关，按 §9.10 判读）

---

## 1. 结论

**verdict：pass（无 blocking finding；3 条观测在 §6）**

一句话：**「过期的在场投影不再让人以为有人刚到」这件事，端到端成立**——我往真库里写一条 `present=true`、时间戳 52 分钟前、TTL 仍为 60 秒的行：`readPresence` 报 `stale=true`、`ttlSeconds=60`，候选里**没有** `presence_arrived`（只剩 `conversation_dangling`），`tickOnce()` 选中的也不是它；把同一行换成刚写入的（`stale=false`），候选里立刻出现 `presence_arrived`，tick 选中的就是它，而且候选的「依据」里写着中文原因「0s 前更新，在 60s 的 TTL 内」。`stale`/`ttlSeconds` 确实是从 `readPresence` 一路透传到**候选判定**的（不是只进展示层）：循环的 `readPresence` 把两个字段一起返回，`buildProactiveCandidates` 里用 `presenceFreshness(...)` 的结果决定要不要建这个候选，面板/loop 负载里另外再显示一份原因。TTL 缺失时的回落值与域默认**一致**：`DEFAULT_PRESENCE_TTL_SECONDS = 60`（我读的是 `packages/domain/src/store.ts` 的那个常量，函数直接 import 它）。

| 任务验收条款 | 我的判定 | 实测/依据 |
|---|---|---|
| 1 独立核对：新鲜/过期投影各跑一次 tick，确认 `presence_arrived` 只在新颖时出现；TTL 边界（相等算新鲜）与「TTL 缺失用默认 60 秒」是否与域默认一致；`stale`/`ttlSeconds` 真的从 `readPresence` 透传到候选 | **真正满足** | §2（端到端 4 组）、§3（判据矩阵）、§4（边界与域默认）、§5（透传链路） |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/` | **满足** | §6：`npm test` **232/232 pass / 0 fail / exit 0**；`check:docs` **69 份 / 0 问题 / exit 0** |

---

## 2. 端到端：新鲜就出现、过期就不出现（真库，不碰摄像头）

| 我造的场景 | `readPresence` 读到的 | `buildProactiveCandidates` 的触发源 | `tickOnce()` 选中 |
|---|---|---|---|
| 刚写入 `present=true`（TTL 60） | `mode=projection`、**`stale=false`、`ttlSeconds=60`** | **`presence_arrived`, conversation_dangling** | **`presence_arrived`**（`reason=PASSED`，依据里带「0s 前更新，在 60s 的 TTL 内」） |
| 52 分钟前写入 `present=true`（TTL 仍 60） | `mode=projection`、**`stale=true`、`ttlSeconds=60`** | 只剩 `conversation_dangling`（**没有** `presence_arrived`） | `conversation_dangling`（这条就是「对着空房间开口」的根因被切断的地方） |
| 库里根本没有投影 | `mode=not-integrated`、`stale=null` | 只剩 `conversation_dangling` | 不会选 `presence_arrived` |
| 过期行的判据原因 | — | `presenceFreshness` → `{fresh:false, reason:'在场投影已被标为过期（T 60s）'}` | 面板/loop 负载里显示的就是这句话 |

---

## 3. 判据矩阵（我直接调 `presenceFreshness`，逐条核对）

| 输入 | 结果 | 备注 |
|---|---|---|
| 0s、TTL 60、`stale=false` | **fresh** | 正常路径 |
| 不传 TTL / TTL 为 `null` | **fresh 且 `ttlSeconds=60`** | 回落到域默认，而不是「无限信任」 |
| 年龄恰好 = TTL（60.000s） | **fresh**（`ageSeconds=60`） | 「边界含相等」——纯函数层面 |
| 年龄 = TTL + 1ms | **不 fresh** | 边界的另一侧 |
| 52 分钟前 | **不 fresh**（`ageSeconds=3120`） | 切回目录要报的场景 |
| 投影自称 `stale=true`（年龄 0） | **不 fresh**，原因「已被标为过期」 | 旗标优先于年龄 |
| `TTL=0` 且年龄 1ms | **不 fresh**（给定值原样使用） | |
| `present=false` / `present=null` | 不 fresh，原因写明 | |
| 没有 `updatedAt` / 时间戳读不出来 | 不 fresh，原因写明 | 「无法证明刚到家」 |
| `presence === null` | 不 fresh，且仍给出 TTL 60 | |

---

## 4. TTL 边界与「缺失用 60 秒」和域默认的关系

- **域默认一致**：`packages/domain/src/store.ts` 的 `DEFAULT_PRESENCE_TTL_SECONDS = 60`；`presenceFreshness` **直接 import 这个常量**做回落（`git grep -n DEFAULT_PRESENCE_TTL_SECONDS -- packages/domain/src/store.ts scripts/field-test.ts`），不是自己另抄一个数 ✓。
- **边界（相等算新鲜）**：在**纯函数**层面成立（上表两行）✓——这正是 t98 那 9 项测试钉住的那条。
- **端到端比它更严，方向是安全的（观测 O1）**：域 store 的 `stale` 用的是 `>=`（`stale: Date.parse(now) >= Date.parse(staleAfter)`），所以「恰好等于 `staleAfter`」的行**已经被标成 `stale=true`**；而 `presenceFreshness` 先看 `stale===true`、再看年龄，于是**控制台这条路径在边界上判「不算新鲜」**。我用注入时钟核过：`now = staleAfter` → `stale=true`、`now = staleAfter − 1ms` → `stale=false`。也就是说两条规则叠起来的效果是「过一点点就不算刚到家」，不会误报；只是「相等算新鲜」这句只在**不给 `stale` 旗标的调用方**（例如 `serve-chat` 那条不传 TTL/stale 的读取路径）身上成立。

---

## 5. `stale` / `ttlSeconds` 的透传链路（不是只给展示层）

| 环节 | 证据 |
|---|---|
| 读取层 | `readPresence` 的 projection 分支返回 `stale: row.stale === true`、`ttlSeconds: typeof row.ttlSeconds === 'number' ? row.ttlSeconds : null`（`git grep -n "stale: row.stale" -- scripts/field-test.ts`）；`not-integrated` 分支返回 `stale: null, ttlSeconds: null` |
| 循环侧 | `ProactiveLoop` 的 `readPresence` 把 `stale`/`ttlSeconds` **连同** `present`/`updatedAt`/`source` 一起返回（t98 的 diff 就改在这一行），并顺手把 `presenceFreshness(reading, now)` 记进 `lastPresenceFreshness` |
| 判定层 | `buildProactiveCandidates` 里 `const freshness = presenceFreshness(presence, context.now); if (freshness.fresh) { push(presence_arrived) }` —— **候选的存在与否**由它决定；候选的 `fact` 里也写进原因 |
| 展示层（额外，不是唯一去处） | `/api/field/proactive/loop` 的 `presence` 字段 + 面板状态行的「在场投影这次不能当『有人到达』用：<原因>」 |
| 我实测的透传 | 直接调 `readPresence({store})` 得到 `stale=false / ttlSeconds=60`（新鲜行）与 `stale=true / ttlSeconds=60`（52 分钟旧行），再把**这份 reading 原样**喂给候选与 tick → §2 的结果。若透传断了（例如仍只传 present/updatedAt），过期那行就会因为 `presence.present === true` 而重新建出候选 |

---

## 6. 门禁与观测

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | HEAD `1d5c1ed`；在途是 t99 的 `services/perception-edge/{__init__,camera,run}.py`、`scripts/verify-camera-presence.ts`、`docs/design/perception.md`（**都不是 t98 的文件**） | **232 tests / 232 pass / 0 fail / 0 skipped，exit 0**（t99 在途的 Python 改动没有把门禁染红） |
| `npm run check:docs` | 同上 | 检查了 **69 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 70 份 / 0 问题 / exit 0） |

**观测（都不改变 verdict）**

- **O1（低，措辞要小心）**：「TTL 边界相等算新鲜」这句**只对纯函数**成立；端到端（域 store → `readPresence` → 候选）在边界上判**不算新鲜**，因为 store 的 `stale` 是 `>=` 语义、而函数先看 `stale` 旗标。方向是安全的（宁可少说一句「你回来啦」），但建议在 `presence-freshness.test.ts` 那条边界用例的注释或 `presenceFreshness` 的 doc 里加一句「这里说的是年龄检查；带 `stale` 旗标的调用方以旗标为准，恰好等于 `staleAfter` 时域 store 已经把它标为过期」，免得后人以为控制台在边界上会放行。
- **O2（信息，域 API 的旧陷阱，不是 t98 引入的）**：`WorldStateQuery.now` 的类型是 **`string`**。我第一次调试时传了 `Date` 对象：`Date.parse(Date)` 会走 `toString()`、**把毫秒截掉**（实测 `Date.parse(new Date())` 与 `Date.parse(d.toISOString())` 差 410ms），于是「恰好」「晚 1ms」两种注入都回落到秒级而判成 `stale=false`——边界结论会被静默翻转。改用 `row.staleAfter`（ISO 字符串）回注就都对了。t98 的测试是直接调 `presenceFreshness`（参数是 `Date`），不受影响；这个坑留给以后写 store 级回放/边界测试的人注意。
- **O3（正面）**：这次修的是**根因**而不是表现——把「投影是一次带有效期的主张」写进判据，并且在读取层就把 `stale`/`ttlSeconds` 带出来；同时给「没有 TTL 的读取路径」留了域默认兜底，给「为什么没跟你打招呼」留了中文原因（面板 + 候选依据两处）。我按「造数据 → 读 → 建候选 → tick」四层独立验过，每层都能单独复现。

---

## 7. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node data/rev-tmp/t102-probe.mjs`（**我自写**：判据矩阵 14 项 + 端到端 13 项） | **27 项全过**（§2–§5 的原始值都在输出里，含新鲜/过期/无投影三种 reading 与 tick 选中的触发源） |
| `node data/rev-tmp/t102-boundary2.mjs`（**我自写**：用 store 自算的 `staleAfter` 回注时钟） | 早 1ms → `stale=false`；**恰好等于 `staleAfter` → `stale=true`**；晚 1ms → `stale=true`；边界上的 reading 交给 `presenceFreshness` → `fresh=false`（§4、O1） |
| `node -e "Date.parse(new Date()) vs Date.parse(d.toISOString())"` | 前者把毫秒截掉（差 410ms）→ O2 的实测依据 |
| `git grep -n -e DEFAULT_PRESENCE_TTL_SECONDS -e "stale: row.stale" -e presenceFreshness -- packages/domain/src/store.ts scripts/field-test.ts` | 域默认 60、reader 透传、候选强制使用（§4/§5） |
| `git show 1d5c1ed -- scripts/field-test.ts` | t98 的改动就只有这几处：`presenceFreshness` + 候选强制使用 + `readPresence` 透传 + 面板原因（+91/−10，3 个文件） |
| `npm test` / `npm run check:docs` | 232/232 exit 0；69 份 0 问题 exit 0（含本报告 70 份 0 问题 exit 0） |

---

## 8. 我做过的真实外部动作

**0 次 API 调用**、**未打开摄像头/麦克风**、未起任何服务；所有数据都造在系统临时库（跑完即删）。**未改动任何他人的文件**：唯一写入产物是本文件；探针脚本留在 `data/rev-tmp/`（`t102-probe.mjs`、`t102-boundary2.mjs` 等，`data/` 已 gitignore，非交付物）。基线修订 `1d5c1ed`（= 被评交付点）。
