# 评审：主动性默认值与阈值测试更新（t61）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t58 与 t61 的实现者）
> 日期：2026-09-30
> 评审对象：t61「把钉住旧默认值 0.55 的两条测试更新为 0.70 与 0.54，门禁恢复全绿」，交付修订号 **`626d626`**（只改 `tests/unit/domain.test.ts` 与 `tests/unit/core/proactive-gates.test.ts`，4 处 1:1 替换、+8/−4）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`config/xixi.example.yaml`、`packages/conversation/src/proactive.ts`、`docs/adr/0009-proactive-triggers-and-hard-gates.md` §4/§5、`scripts/field-test.ts` 的 `parseProactiveSettings(config)` 调用点、两个被改测试文件的 `3e3570d`（改前）与 `626d626`（改后）两个版本，以及**我自己跑的 4 组命令**（含直接调用 `proactiveThreshold()`，见 §5）
> 说明：引用代码位置用「文件 + 符号 + 一条可复现命令」

---

## 1. 结论

**verdict：pass（无 blocking finding；3 条观测记在 §4，不改变判定）**

一句话：**四处替换我逐条独立核对成立**——① `config/xixi.example.yaml` 的 `proactivity` 确为 **0.70**、`packages/conversation/src/proactive.ts` 的 `DEFAULT_PROACTIVITY` 确为 **`0.7`**（注释还写明「0.70（不是旧的 0.55）」）；② 我**直接调用真实模块**跑出 `proactiveThreshold(0.7) = 0.54`（且 `proactiveThreshold(0.55) = 0.585`、`(0) = 0.75`、`(1) = 0.45`、`(2) = 0.45` 全部与 ADR-0009 的公式一致）；③ **断言条数与强度都没变**：两个文件在改前/改后都是 `test=10 / assert=30` 与 `test=19 / assert=113`，diff 里只有「值 + 注释」四行，没有任何 `epsilon`/`assert.ok`/`skip` 之类放宽；④ 新注释与 ADR-0009 §5 的订正（默认 0.70、阈值 0.54、`config` 与 `DEFAULT_PROACTIVITY` 必须一致）逐句对得上。而且这次改动**不是空转**：旧值 0.585 与新实现的 0.54 不等，所以改前那两条断言必然失败（t61 报告里的 29/27/2 与此一致）。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 独立核对四处替换：默认 0.70、阈值 0.54（自己跑 `proactiveThreshold` 或等价路径）、断言条数未变、注释与 ADR-0009 一致；并确认没有为变绿放宽断言强度 | **全部成立** | 见 §2（默认值）与 §3（阈值 + 计数 + 强度 + 注释） |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/proactivity-default-review-2026-09-30.md` | **满足** | 判读前先看 `git status`（只有他人 `docs/design/domain-model.md`、`scripts/field-test.ts` 在途，与本任务无关）；`npm test` → **189 / 189 / 0 fail / 0 skipped，exit 0**（壁钟 21.1s）；`npm run check:docs` → **55 份 markdown、0 问题、exit 0**（加入本文件后复跑 **56 份**、仍 0 问题）；本文件即结论落点 |

**范围纪律**：t61 只改了它声明的两个测试文件；我本轮**只新增本文件**，全程只读。

---

## 2. 默认值 = 0.70（两处必须一致的地方我都看了）

| 位置 | 现在写的是 | 判定 |
|---|---|---|
| `config/xixi.example.yaml`（`personality.base.proactivity`） | `proactivity: 0.70` | **0.70 ✓** |
| `packages/conversation/src/proactive.ts` 的 `DEFAULT_PROACTIVITY` | `export const DEFAULT_PROACTIVITY = 0.7;`（注释：「0.70（不是旧的 0.55）……阈值从 0.585 降到 `0.45 + 0.30 × (1 − 0.70) = 0.54`」） | **0.7 ✓** |
| `docs/adr/0009-…md` §5 | 「默认基线取 **0.70**（订正 2026-09-30：先前写 0.55 → 阈值 0.585）……`0.7` 与 `0.70` 是同一个值」+ 要求 `config` 与 `DEFAULT_PROACTIVITY` 一致 | **一致 ✓** |
| `tests/unit/domain.test.ts`（`the shipped example configuration loads and validates`） | `assert.equal(config.personality.base.proactivity, 0.7)`（注释引用 ADR-0009 与阈值推导） | **一致 ✓** |

（YAML 里的 `0.70` 与 TS 里的 `0.7` 是同一个数——ADR-0009 也专门写了这一点，所以不构成「两处不一致」。）

## 3. 阈值 = 0.54：我用真实模块跑出来的，不是照抄测试

- 我直接 `import('@xixi/conversation')` 调 `proactiveThreshold()`：
  `proactiveThreshold(0.7) = 0.54`、`(0.55) = 0.585`、`(1) = 0.45`、`(0) = 0.75`、`(2) = 0.45`；手算 `0.45 + 0.30 × (1 − 0.7) = 0.54` ✓。与 ADR-0009 §4 的公式（`0.45 + 0.30 × (1 − proactivity)`，地板 0.45）逐条相符。
- **断言条数未变、强度未放宽**（我按 `3e3570d`（改前）与 `626d626`（改后）两个版本各数一遍）：

| 文件 | 改前 | 改后 |
|---|---|---|
| `tests/unit/domain.test.ts` | `test=10`，`assert.=30` | `test=10`，`assert.=30` |
| `tests/unit/core/proactive-gates.test.ts` | `test=19`，`assert.=113` | `test=19`，`assert.=113` |

  四行 diff 全是「值 + 注释」：`proactiveThreshold(0.55), 0.585` → `proactiveThreshold(0.7), 0.54`；`result.threshold 0.585` → `0.54`；`config…proactivity 0.55` → `0.7`；以及 `STRONG` 的注释与两处行内注释。**没有**出现 `assert.ok` 替换 `assert.equal`、没有引入误差容限、没有 `skip`。
- 我实跑这两个文件：**29 项全过（29 pass / 0 fail）** ✓。
- 非空转的证明（不需改代码）：新实现的返回值是 `0.54`，而旧断言钉的是 `0.585` —— 两者不等，所以那两条在改前**必然**失败（t61 报告的「29/27/2」与此吻合）。

## 4. 观测（不改变 verdict）

- **O1（另一处过期注释，不是 t61 的锅，但建议顺手改）**：`config/xixi.example.yaml` 的 `proactive:` 段里写着「**注意：本段目前仍是「声明」——还没有代码读取**（实现时先接线并补门禁单测）」。这句现在是**假的**：`scripts/field-test.ts` 的 `parseProactiveSettings(config)`（`git grep -n "parseProactiveSettings(config)" -- scripts`）会以 `source: 'config'` 读它，`ProactiveEngine` 的构造默认路径也是 `parseProactiveSettings(options.config)`；ADR-0009 与 `domain-model.md` 都已写「`config.proactive` 段已被读取」。该注释由 `0ff9ae1`（t40）引入、t58/t61 都没碰它——建议由队长指派一行修复（或并进下一次动 `config/` 的任务）。
- **O2（提醒后来人别「顺手改」）**：仓库里仍有 `0.55` / `0.585` 出现在测试中，但**它们是对的、不要改成 0.54**——例如 `tests/integration/proactive-engine.test.ts` 里 `seedSelfProfile({ proactivity: 0.55 })` 之后断言 `outcome.threshold === 0.585`，那是**显式输入**下的正确推导值（我实跑 `proactiveThreshold(0.55) = 0.585` 验证）；`tests/console/proactive-console.test.ts` 里 `proactivity: 0.55` 同理。建议在这两处（至少集成那一处）加半句注释说明「这里是显式传入，不是默认值」，避免下一轮 grep 替换把正确断言改坏。
- **O3（写法值得肯定）**：t61 的替换带了**算术与出处**（注释里写 `0.45 + 0.30 × 0.30 = 0.54` 并点名 ADR-0009），比只改数字更容易被复核——我这次的核对几乎全部可以照注释复算。

## 5. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node -e "import('@xixi/conversation').then(m=>{…m.proactiveThreshold(p)…})"` | `(0.7)=0.54`、`(0.55)=0.585`、`(1)=0.45`、`(0)=0.75`、`(2)=0.45` → 与 ADR-0009 §4 公式一致 |
| `git show 3e3570d:<file>` / `git show 626d626:<file>`（对两个测试文件数 `^test(` 与 `assert.`） | 改前/改后：`10/30` 与 `19/113`，**完全相同** |
| `git show 626d626`（逐行读 diff） | 4 处 1:1 值替换 + 注释；无放宽、无删除断言 |
| `node --test tests/unit/domain.test.ts tests/unit/core/proactive-gates.test.ts` | **29 / 29 pass / 0 fail** |
| `git grep -n -e "0\.585" -e "proactivity.*0\.55" -- tests config packages/conversation/src` | 剩余命中都是显式输入（`proactive-engine.test.ts`、`proactive-console.test.ts`、`brain-adapter.test.ts`）与 `proactive.ts` 的历史注释 → O2 |
| `git grep -n "parseProactiveSettings(config)" -- scripts` / `git log -S "还没有代码读取" -- config/xixi.example.yaml` | `field-test.ts` 真的读它；那句注释由 `0ff9ae1`（t40）引入 → O1 |
| `git status --porcelain` | 只有他人 `M docs/design/domain-model.md`、`M scripts/field-test.ts` 在途（与本任务无关） |
| `npm test` | **tests 189 / pass 189 / fail 0 / skipped 0**，exit 0（壁钟 21.1s） |
| `npm run check:docs` | 检查了 **55 份 markdown**（加入本文件后 **56 份**）；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |

**我做过的真实外部动作**：**0 次 API 调用**（未花任何费用）、未开摄像头/麦克风、未写任何数据库；全程只读，未 stash 或改动他人文件。
