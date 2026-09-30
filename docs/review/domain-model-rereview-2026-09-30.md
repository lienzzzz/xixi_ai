# 再评审（round 3）：库路径覆盖说明的订正（t64，对 t60 的 F1）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t60/t64 的实现者）
> 日期：2026-09-30
> 评审对象：t64「把构造选项写成 CLI 参数的表述改对（并按当时状态注明没有 CLI 开关）」，交付修订号 **`3f35422`**（只改 `docs/design/domain-model.md`）
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`docs/design/domain-model.md` §6、`scripts/field-test.ts`（**`3f35422` 与当前工作区各看一遍**）、`README.md`、`docs/testing.md`，以及**我自己跑的 5 组命令**（含 `node scripts/field-test.ts --help`，见 §5）
> 说明：引用代码位置用「文件 + 符号 + 一条可复现命令」

---

## 1. 结论

**verdict：pass（无 blocking finding；3 条观测记在 §4，不改变判定）**

一句话：**t64 的订正与「它落笔时」的实现完全一致，而且它没有停在改对措辞**——它把这半句改成了「库路径由 `createFieldServer` 的 `dataDir` / `presenceDataDir` **选项**决定（默认 `data/field-test` 与 `data/`；**目前没有 CLI 开关，`--help` 里也没有**）」，还补了两条我没想到但很实用的东西：① 明确警告 `main()` 对**未知参数静默忽略**（并列出真正认的 8 个开关、附核对命令），正好堵住「照着文档敲一个不存在的开关还以为生效了」这个坑；② 加了一句前瞻 hedge「**以上以当前实现为准**——若日后把这两个选项做成 CLI 开关，本节须同步改写」。我三处都独立核过：**`3f35422` 上无开关命中**、当前工作区同样无命中、`--help` 输出里 `data-dir` 命中数为 **0**。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 明确 verdict + 可执行 findings | **满足** | pass；无 finding，3 条观测见 §4 |
| 2 按 t64 落笔时的实现状态核对它的写法（当时确实没有 CLI 开关：`git grep` 无命中、`--help` 无该开关即成立）；并抽查 README 与 `docs/testing.md` 的同类表述 | **真正满足** | §2 三条证据（提交点、当前工作区、`--help` 实跑）+ 默认值两处与代码一致；§3 抽查结果：README 只提环境变量、`testing.md` 无同类表述 → 两处都无需改（与 t64 的判断一致） |
| 3 **时序说明**：若复核时发现 t63 已加上 `--data-dir` / `--presence-data-dir` 导致 §6 过期，不要因此判 t64 不合格，只需在结论里指出 | **已按要求处理** | 我**没有**发现 t63 已落地（提交点与工作区两次核查均无这两个开关，也没有「未知参数报错」的代码），所以此刻**不存在过期**；若它随后落地，文档里已有 t64 写下的 hedge，且 t66 已派去同步（见 §3） |
| 4 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/domain-model-rereview-2026-09-30.md` | **满足** | 判读前先看 `git status`（在途：`config/xixi.example.yaml`、`scripts/{field-test,serve-chat}.ts`、`tests/console/proactive-console.test.ts`）；`npm test` → **192 / 192 / 0 fail / 0 skipped，exit 0**（壁钟 26.1s）；`npm run check:docs` → **56 份 markdown、0 问题、exit 0**（加入本文件后复跑 **57 份**、仍 0 问题）；本文件即结论落点 |

**范围纪律**：t64 只改了它声明的 1 个文件；我本轮**只新增本文件**，全程只读。

---

## 2. 「当时没有 CLI 开关」与我实测的三条证据

| 证据 | 命令 | 结果 |
|---|---|---|
| t64 落笔时的提交点 | `git grep -n -e "data-dir" -e "presence-data-dir" 3f35422 -- scripts` | **无命中**（exit 1）→ 它写「当时无开关」成立 |
| 当前工作区（含他人在途改动） | `git grep -n -e "data-dir" -e "presence-data-dir" -- scripts` | **无命中**（exit 1）→ 该句**此刻仍然为真**（t63 尚未落地，见 §3） |
| `--help` 的真实输出 | `node scripts/field-test.ts --help`（exit 0） | 打印的开关是 `--port` / `--offline` / `--no-tts` / `--dsh` / `--no-open` / `--self-test` / `--acceptance` / `--help`；`data-dir` **命中数 0** → 与 t64 列出的 8 个开关逐一吻合 |

**它写的两处默认值我也核了**（`docs/design/domain-model.md` §6 说「默认分别是 `data/field-test` 与 `data/`」）：

- `scripts/field-test.ts` 的 `createFieldServer`：`const dataDir = options.dataDir ?? join(REPO_ROOT, 'data', 'field-test');` → **`data/field-test` ✓**
- 同一处的在场读取：`openXixiStore({ dataDir: options.presenceDataDir ?? join(REPO_ROOT, 'data') })` → **`data/` ✓**

**它那句「`main()` 对未知参数静默忽略」也成立**：`main()` 只用 `argv.includes(...)` 认那 8 个开关、用 `valueOf('--port', …)` 取端口，别的参数既不报错也不使用；它给的核对命令 `git grep -n "argv.includes\|valueOf(" -- scripts/field-test.ts` 我实跑，正好列出这些判定点——**文档给了一条能用的命令**。

## 3. README / `docs/testing.md` 的同类表述（t64 说无需改，我复核同意）

| 文件 | 我的抽查 | 判定 |
|---|---|---|
| `README.md` | 只有快速开始第 46-48 行的「各用各自的 SQLite 文件（库路径可用环境变量覆盖：chat 认 `XIXI_CHAT_DATA_DIR`、试用页认 `XIXI_WEB_DATA_DIR`；覆盖不改变「不跨入口」）」——**只提环境变量**，没有把构造选项写成 CLI 参数 | **无需改 ✓** |
| `docs/testing.md` | 按 `data-dir` / `库路径` / `XIXI_CHAT` / `XIXI_WEB` / `构造选项` 全文件搜：**零命中**（它只提 `--acceptance` / `--self-test` 这些真实存在的开关） | **无需改 ✓** |

t64 主动核对这两个文件并**只改确有错误处**（inScope 内但不为凑数而动），这个处置是对的。

## 4. 时序与观测（不改变 verdict）

- **O1（时序，按验收条款 3 记录）**：**我复核时 t63 尚未落地**——`--data-dir` / `--presence-data-dir` 在两个时间点（`3f35422` 与当前工作区）都无命中，也没有「未知参数报错」的代码（工作区里 `scripts/field-test.ts` 有 +130 行他人在途改动，但都不涉及这两个开关）。因此 `domain-model.md` §6 的「目前没有 CLI 开关」与「静默忽略未知参数」两句**此刻都不是过期表述**。**当 t63 落地后**，这两句会成为过期——处置已经就位：① 文档里 t64 亲手写了 hedge「**以上以当前实现为准**——若日后把这两个选项做成 CLI 开关，本节须同步改写」；② 队长已派 **t66**（依赖 t63）专门同步。**按验收要求，我不因未来的时序问题判 t64 不合格。**
- **O2（正面：这条 finding 的修法值得当模板）**：把「文档写了一个不存在的开关」这类问题**修到根因**——不只是改成正确措辞，还把「未知参数会被静默忽略」这个**危险机制**写进文档、并给出真实开关清单与核对命令，再补一句前瞻 hedge。以后遇到同类「文档描述了尚未落地的接口」，可以照这个三段式写（正确措辞 + 危险机制 + 实现变更时如何同步）。
- **O3（本轮门禁含他人在途改动）**：`npm test` 现在 **192 项**（比我上一轮看到的 189 多 3 项），工作区有 4 个文件在途（`config/xixi.example.yaml`、`scripts/field-test.ts`、`scripts/serve-chat.ts`、`tests/console/proactive-console.test.ts`），在这个状态下门禁是 **192/192 绿**；本任务的两处文档没有进任何在途改动，判读不受影响。

## 5. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `git grep -n -e "data-dir" -e "presence-data-dir" 3f35422 -- scripts` | **无命中（exit 1）** → t64 落笔时确实没有该开关 |
| `git grep -n -e "data-dir" -e "presence-data-dir" -- scripts` | **无命中（exit 1）**（当前工作区）→ 该句此刻仍为真 |
| `node scripts/field-test.ts --help` | exit 0；打印 8 个真实开关；`data-dir` 命中 **0** |
| `git grep -n "argv.includes\|valueOf(" -- scripts/field-test.ts` | 列出 `main()` 的全部参数判定点（`--help`/`--self-test`/`--acceptance`/`--port`/`--offline`/`--no-tts`/`--dsh`/`--no-open`）→ 文档的核对命令可用 |
| `git grep -n -e "options.dataDir ??" -e "options.presenceDataDir ??" -- scripts/field-test.ts` | `data/field-test` 与 `data/` 两个默认值 → 与文档一致 |
| `Select-String`（README / docs/testing.md 搜 `data-dir`、`库路径`、`XIXI_*`、`构造选项`） | README 只提两个环境变量；testing.md 零命中 → 无需改 |
| `git status --porcelain` | 4 个他人在途文件（与本任务无关） |
| `npm test` | **tests 192 / pass 192 / fail 0 / skipped 0**，exit 0（壁钟 26.1s） |
| `npm run check:docs` | 检查了 **56 份 markdown**（加入本文件后 **57 份**）；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0** |

**我做过的真实外部动作**：**0 次 API 调用**（未花任何费用）、未开摄像头/麦克风、未写任何数据库；全程只读，未 stash 或改动他人文件。
