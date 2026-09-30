# 再评审（对 t15 的两条 findings）：缺密钥用例的环境依赖 + 历史注释锚点（t35）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t15 与 t35 的实现者）
> 日期：2026-09-30
> 评审对象：t35「repair-round-2」（修我在 t15 提的 F1「缺密钥用例依赖 shell 环境里恰好没有 `MIMO_API_KEY`」与 F2「历史注释缺『已修复』锚点」），交付修订号 **`540d1d7`**（两个测试文件的最后一次改动就在这个提交；t35 回报里写的 `b8f0e9b` 是**基线**，见 §5 观测 O1）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`tests/unit/core/brain-error-classification.test.ts`、`tests/integration/brain-adapter.test.ts`、`tests/unit/core/{plugin-tools,dead-code-truthfulness}.test.ts`、`tests/perception/camera-presence.test.ts`、`tests/unit/voice/frontend.test.ts`、`packages/model-adapters/src/mimo.ts`（`MimoClient` 构造函数与 `hasKey`），以及 `git show 540d1d7` 的完整 diff 与**我自己跑的 4 组命令**（见 §6）
> 上一轮血缘：本任务复核的 findings 由我在 t15 评审里提出（`docs/review/residual-fix-review-2026-09-30.md`）

---

## 1. 结论

**verdict：pass（无 blocking finding；3 条观测记在 §5，不改变判定）**

一句话：**t35 的修复是真的，而且比派单要求的更强**——它没有去「保存/恢复 `process.env`」，而是让用例**根本不再依赖环境**：三处 `new MimoClient(...)` 显式传 `apiKey: ''`（空串不是 nullish，`options.apiKey ?? process.env.MIMO_API_KEY` 的回落**不可能**发生），并在构造后断言 `client.hasKey === false` 把「无密钥」前提钉住。我**把 `MIMO_API_KEY` 设成占位值导出到 shell 之后**实跑：t35 改过的两个文件 **11/11 pass**、全量 **180/180 pass（0 skipped，exit 0）**；把变量删掉再跑一遍那两个文件同样 **11/11**（对称性成立）。F2 的三处「已修复」锚点都在，且历史叙述**一句未删**（整份提交只有 +25/−4，4 个删除全是机械替换：3 处 `new MimoClient({ fetchImpl })` 与 1 处类型断言写法）。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 明确 verdict + findings（含文件与行号） | **满足** | pass；无 finding，3 条观测（带文件与符号位置）见 §5 |
| 2 F1 独立复核：带占位密钥跑改过的文件与全量，全部通过；**并读代码确认用例自己控制前提** | **真正满足** | 带占位密钥：两个文件 **11/11**、全量 **180/180 / 0 skipped / exit 0**；不带密钥：两个文件 **11/11**。代码侧：三处构造都 `apiKey: ''` + `assert.equal(client.hasKey, false, …)`；`MimoClient` 的解析是 `options.apiKey ?? process.env.MIMO_API_KEY`（`packages/model-adapters/src/mimo.ts` 的构造函数）与 `get hasKey()`（`this.#apiKey !== undefined && this.#apiKey.length > 0`）。**注意**：验收文本里的「保存与恢复」在本实现中不存在——因为用例**完全没有改 `process.env`**，没有需要恢复的东西；这比「改了再恢复」更干净，我按「自控前提」这一**意图**判定通过（§2 详述） |
| 3 F2 独立复核：两处历史注释的「已修复」锚点已加上，且历史信息未被删除 | **真正满足** | 锚点实际有 **3 处**（多于要求的 2 处）：单测文件头（注明 t5 修复 + 「上面这段是历史，不是现状」）、单测缺密钥用例注释（注明 t12 修复）、集成测试用例 doc（注明 t12 修复 + t14 改断言）。`git show 540d1d7` 的 diff 里**没有任何历史叙述被删**（4 个删除行全是机械替换） |
| 4 同类隐患复核：抽查至少两处其他环境依赖断言 | **满足（我独立抽查 4 处）** | ① `tests/unit/core/plugin-tools.test.ts` 里那段是**显式赋值 + `finally` 恢复**（`previous`/`previousRoot` 先存后还原，`undefined` 时 `delete`），属自控前提，无需改；② `tests/unit/core/dead-code-truthfulness.test.ts` 的 `MimoClient` 构造显式传 `apiKey: 'test-key'`；③ `tests/perception/camera-presence.test.ts` 读 `XIXI_PERCEPTION_PYTHON` 只是**候选路径的优先项**，后面还有 `.venvs` 目录发现兜底，不构成环境相关的通过/失败；④ `tests/unit/voice/frontend.test.ts` 依赖 `.venvs` 的 Python 与 `process.env`——t35 已如实标为**范围外并上报**。全仓 `tests/` 里 `new MimoClient(` 共 6 处，**全部**显式给 key（`'test-key'` 或 `''`） |
| 5 自己跑一次 npm test 与 check:docs 并贴结果；结论落本文件 | **真正满足** | `npm test`（带占位密钥）→ **180 / 180 / 0 fail / 0 skipped，exit 0**；`npm run check:docs` → **47 份 markdown、0 问题、exit 0**；命令与原始输出见 §6 |

**范围纪律**：t35 只改了它声明的 2 个文件（`git show 540d1d7 --stat`：`tests/integration/brain-adapter.test.ts` 与 `tests/unit/core/brain-error-classification.test.ts`，+25/−4），未动实现代码、未动其他目录；我本轮只新增本文件。

---

## 2. F1：为什么这次不是「假绿」，也不是「靠环境碰巧」

1. **代码层（符号与语义，不依赖行号）**：`MimoClient` 构造函数里 `this.#apiKey = options.apiKey ?? process.env.MIMO_API_KEY`；`get hasKey()` 返回 `this.#apiKey !== undefined && this.#apiKey.length > 0`。传 `''` 时 `??` **不会**回落（空串非 nullish），于是 `hasKey === false`。三处用例都在构造后立刻断言这一点——**前提由用例自己钉住**。
2. **行为层（我实跑的两个方向）**：
   - `$env:MIMO_API_KEY='placeholder-key-for-review-probe'` → 两个文件 `tests 11 / pass 11 / fail 0`；全量 `tests 180 / pass 180 / fail 0`（`0 skipped`）；
   - 删掉该变量 → 两个文件同样 `tests 11 / pass 11 / fail 0`。
   即：**同一个用例在有密钥与无密钥的机器上给出同一结果**——这正是 t15 那条 finding 要消灭的性质（当时带占位密钥会红 2 项）。
3. **关于验收文本里的「保存与恢复」**：本实现没有改 `process.env`，因此**没有可恢复的东西**；`tests/unit/core/plugin-tools.test.ts` 那种「先存后还原」的写法在这里是不必要的。我把这一条的**意图**（用例必须自己控制无密钥前提，不能靠环境碰巧）判为满足，并在报告里显式记录这处措辞差异（§5 观测 O2）。
4. **回归保护的机制**：若将来有人把 `??` 改成 `||`，`''` 也会回落到 `process.env.MIMO_API_KEY`，`hasKey` 变成 `true`，那三处 `assert.equal(client.hasKey, false, …)` 会**立刻失败**而不是静默变回环境相关——这是 t35 有意设计的守卫，测试文件头也写明了原因。

## 3. F2：锚点与历史叙述的核对

`git show 540d1d7` 的 diff（2 个文件，+25/−4）逐段核对：

| 位置（符号定位） | 加了什么 | 历史是否保留 |
|---|---|---|
| 单测文件的模块级 doc（`§21.1 降级 needs to tell failure classes apart…` 之后） | 「（已修复：t5 给 `BrainError` 加了 `AUTH`/`RATE_LIMIT`/`QUOTA`/`BAD_REQUEST` 与 `originalCode`；本文件就是那次修复的回归测试。**上面这段是历史，不是现状。**）」+ 一段「本用例必须自己控制无密钥前提」的说明 | **保留**（原叙述一字未动） |
| 单测的缺密钥用例内注释（`a missing key arrives as MISSING_KEY…`） | 「（已修复：t12 把 `#headers()` 提到 fetch 的 try 之前。上面的叙述是历史；本用例现在防的是回归。）」 | **保留** |
| 集成测试的用例 doc（`a missing API key fails as MISSING_KEY…`） | 「（已修复：t12 把 `#headers()` 提到 fetch 的 try 之前；t14 把断言改成钉住已修复行为。下面的用例仍然有效，它防的是回归。）」+ 同一段自控前提说明 | **保留** |

历史事实本身也与我先前的核查一致（t5 加 `AUTH`/`originalCode` 等码、t12 把 `#headers()` 提到 `try` 之前）：不是新编的说法。

## 4. 同类隐患（我在 t35 的清单之外又自己扫了一遍）

| 位置 | 结论 |
|---|---|
| `tests/unit/core/plugin-tools.test.ts`（`XIXI_PLACE`/`XIXI_REPO_ROOT`） | **不改是对的**：先存 `previous`/`previousRoot`，`finally` 里按 `undefined` 决定 `delete` 还是还原；这是「自控前提 + 恢复」，与本次的两处不同（它们连改都不用改） |
| `tests/unit/core/dead-code-truthfulness.test.ts` 的 `new MimoClient({` | 显式 `apiKey: 'test-key'`，与 `process.env` 无关 |
| `tests/perception/camera-presence.test.ts` 的 `pythonCandidates()` | `XIXI_PERCEPTION_PYTHON` 只是**优先候选**，后面按 `.venvs` 目录名排序兜底；无「环境决定成败」的风险（t35 也这么标注） |
| `tests/unit/voice/frontend.test.ts` | 依赖 `.venvs` 的 Python 与 `process.env`（属**其他成员目录**）——t35 如实标为范围外并上报，符合派单纪律 |
| 全仓 `tests/` 的 `new MimoClient(`（我 grep 到 **6 处**：单测 4、集成 1、`dead-code-truthfulness` 1） | 全部显式传 key：`'test-key'` 或 `''`——没有「省略 apiKey 靠环境」的用例 |

## 5. 观测（不改变 verdict）

- **O1（交付记录）**：t35 回报写「rev b8f0e9b」，而 `b8f0e9b` 是**基线**（t33 的提交）；这次交付实际落在 **`540d1d7`**。这是本轮第三次（t31 报 `f2f35c9`、t33 报 `d08d5cc`），**队长已在 AGENTS.md §9.20 定规矩**（成员只报基线、由 captain 用追加式 `evidence_note` 回填交付号），后续按新规矩执行即可；引用哈希前请先确认它是基线还是交付。
- **O2（措辞）**：本任务验收文本要求「读代码确认用例内部真的做了保存与恢复」。本实现属于**更强**的形态（完全不碰 `process.env`），因此没有「保存/恢复」代码可看。建议后续同类派单把措辞改成「用例必须自控前提（不许依赖宿主环境）」，避免成员为了对齐字面而引入不必要的 env 读写。
- **O3（计数别再写死）**：t35 回报里的 139/139 在几小时内已经变成 **180/180**（队友在加主动性与多段回复用例）。这与 AGENTS.md §9.18 同源：**回报与文档都别写死测试项数**，或写成「以实跑输出为准」。

## 6. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `$env:MIMO_API_KEY='placeholder-key-for-review-probe'; node --test tests/unit/core/brain-error-classification.test.ts tests/integration/brain-adapter.test.ts` | **tests 11 / pass 11 / fail 0**，exit 0（含两条缺密钥用例：`a missing key arrives as MISSING_KEY before any request is attempted`、`a missing API key fails as MISSING_KEY before any request is attempted`） |
| `$env:MIMO_API_KEY='placeholder-key-for-review-probe'; npm test` | **tests 180 / pass 180 / fail 0 / skipped 0**，exit 0（壁钟 14.1s；修订号 `803a2cd` + 在途改动 `scripts/verify-voice-noise.ts`） |
| `Remove-Item Env:MIMO_API_KEY; node --test <同两个文件>` | **tests 11 / pass 11 / fail 0**，exit 0（对称性：有/无密钥结果一致） |
| `npm run check:docs` | 检查了 **47 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |
| `git show 540d1d7 --stat` / `git log --oneline -3 -- <两个测试文件>` | 只改 2 个测试文件（+25/−4），最后一次改动即 `540d1d7` → 交付修订号 |
| 读码（符号定位） | `MimoClient` 构造函数 `options.apiKey ?? process.env.MIMO_API_KEY`；`get hasKey()`；三处 `apiKey: ''` + `hasKey === false` 断言；插件用例的 `finally` 还原；`dead-code-truthfulness` 的 `apiKey: 'test-key'`；`cameraCandidates` 的环境变量兜底 |

**我做过的真实外部动作**：0 次 API 调用（未花任何费用——占位密钥不会被用于任何真实请求：用例注入的 `fetchImpl` 从不真正联网，且缺密钥用例的 `attempted === 0` 断言保证「本地即拒」）、未开摄像头/麦克风、未写业务数据库；**本轮没有任何突变或改动实验（全程只读）**。
