# 评审：残差修复收尾（t14 + t12 实际改动）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t14/t12 实现者 core-engineer 与 verifier）
> 日期：2026-09-30
> 评审对象：t14「收尾：把 KNOWN GAP 用例改为『已修复』断言，恢复 npm test 全绿」；并一并复核 t12 已落地的三项改动（t12 因 inScope 声明错误被判 failed，无法作为 reviewedTaskId）
> 复核对象：t6 / `docs/verification/field-test-verification-2026-09-30.md` §2.5（它对 t12 第 2 条的判定）
> 唯一写入路径：本文件（契约 `In scope`）
> 权威来源（本评审实际跑过/读过的）：`tests/unit/core/brain-error-classification.test.ts`、`tests/integration/brain-adapter.test.ts`、`packages/model-adapters/src/mimo.ts`、`packages/brain-adapter/src/mimo.ts`、`packages/domain/src/store.ts`、`packages/conversation/src/engine.ts`、`docs/design/security-and-privacy.md`、`plugins/xixi-tools/{index.js,package.json}`、`config/xixi.example.yaml`，以及**我自写的无密钥探针**与 **git 历史对照**

---

## 1. 结论

**verdict：needs_revision（t14 的改写本身干净、等价断言两层都在，`npm test` 在干净环境 139/139——但它新写的两条「缺密钥」断言**只在本进程环境变量恰好为空时成立**；shell 里一旦有 `MIMO_API_KEY`（本机 `.env.local` 里就有真钥），同一条命令立刻变成 137/139、2 失败。这是唯一的 blocking 项，修法是每处一行）**

一句话：t14 把那条固化旧缺陷的 `KNOWN GAP` 用例**真正**改写成了「已修复」断言（`ModelError.code === 'MISSING_KEY'` + `BrainError.originalCode === 'MISSING_KEY'` + 两层都断言 `attempted === 0`），`tests/` 下 `KNOWN GAP`/`STALE` **0 命中**，文件里对旧行为的描述只剩「`used to`/`Before this test`」这种**历史叙述**（不是断言）；我在无密钥的临时环境里亲手复现了 `MISSING_KEY`（详情见 §3），`npm test` 139/139、`check:docs` exit 0 也都是我自己跑的。

但它**引入了一个环境依赖**：两个文件的用例都写 `new MimoClient({ fetchImpl })`，而 `MimoClient` 的构造是 `options.apiKey ?? process.env.MIMO_API_KEY`——于是「缺密钥」这个前提**不由测试自己控制**，而由运行者的 shell 决定：

| 运行环境 | `node --test tests/unit/core/brain-error-classification.test.ts` | `node --test tests/integration/brain-adapter.test.ts` | `npm test` |
|---|---|---|---|
| `MIMO_API_KEY` 未设置（我复核时的状态） | 5/5 pass | 6/6 pass | **139/139 pass** |
| `MIMO_API_KEY=dummy-key-for-probe` | **4/5，1 失败** | **5/6，1 失败** | **137/139，2 失败** |

对照本机事实：仓库里**存在 `.env`**（65 字节，其中**确实有 `MIMO_API_KEY`**；`.env` 与 `.env.local` 都在 `.gitignore` 里），而 `scripts/lib/harness.ts` 的 `readDotEnv()` 正是把 `.env`/`.env.local` 灌进 `process.env` 的机制。也就是说：**开发者在自己的环境里 sourced 过密钥之后，这条「缺密钥」用例会红，而且红得像是回归**。

| 维度 | 判定 |
|---|---|
| t14 条款 1（不再断言旧行为） | **真正满足**（`KNOWN GAP` 0 命中；§4 的 git 对照可证改动落进了 `f5a54be`） |
| t14 条款 2（改为断言已修复行为：code/originalCode 为 MISSING_KEY 且 fetch 未被调用） | **真正满足，但存在环境依赖**（F1） |
| t14 条款 3（STALE 注释与旧缺陷文字移除） | **满足**（`STALE` 0 命中；剩余 `used to`/`Before this test` 是历史叙述，不是断言） |
| t14 条款 4（不允许只删不测，单元与集成两层都有等价断言） | **真正满足**（两层都断言 code/originalCode/attempted===0；两处都带 F1 的同一个环境依赖） |
| t14 条款 5（`npm test` 全绿 ≥88、`check:docs` 通过） | **在干净环境成立**（139/139、check:docs exit 0）；**在带密钥环境不成立**（137/139）→ F1 |
| t14 条款 6（回报写明用例数与改动摘要） | 成立（t14 回报：88/88、1 个文件） |
| t12 三项改动 | **mimo.ts headers 提前 ✓、§6 事实改写 ✓（三句核心事实成立）、插件描述 ✓**（§5） |

---

## 2. 逐条核对 t14 的 6 条验收标准

| # | 条款 | 判定 | 我的核对方式与结果 |
|---|---|---|---|
| 1 | `tests/unit/core/brain-error-classification.test.ts` 里不再存在断言旧行为的用例（不再断言「缺密钥 → NETWORK」） | **真正满足** | 读文件：旧用例 `KNOWN GAP: a missing key is still reported as NETWORK by the model client` 已不存在；现有 `:78` 是新用例。全仓 grep（含 `tests/` 全部 `.ts`）`KNOWN GAP` → **0 命中**。唯一剩下的 `originalCode === 'NETWORK'` 断言在 `:74`，它属于「真实网络故障」（`fetchImpl` 直接 `throw new Error('getaddrinfo ENOTFOUND …')`）——那是**当前正确行为**，不是旧缺陷。git 对照见 §4 |
| 2 | 该位置改为断言已修复行为：缺密钥时 code（或 originalCode）为 `MISSING_KEY`，且 fetch 未被调用 | **真正满足（附 F1 环境依赖）** | `:89` `new MimoClient({ fetchImpl })` → `:91-94` 断言 `error instanceof ModelError && error.code === 'MISSING_KEY'`；`:95` `assert.equal(attempted, 0)`；`:98-107` 再过一层适配器，断言 `BrainError.code === 'TRANSPORT_FAILED' && originalCode === 'MISSING_KEY' && detail.includes('MISSING_KEY')` 以及第二次 `attempted === 0`。**但**该用例的「无密钥」前提来自 `process.env.MIMO_API_KEY` 为空，不是显式构造 → F1 |
| 3 | t12 留下的 STALE 注释被移除，文件里不再有描述旧缺陷的文字 | **满足** | grep `STALE` → 0 命中（全仓 `tests/`）。文件里还剩两处「历史叙述」：`:14` 「Before this test, every `ModelError` except TIMEOUT became `PROVIDER_FAILED`」与 `:79-81` 「`#post` used to build its headers inside the fetch try-block …」。这两句都是**过去时**、且**没有对应断言**，属于「解释这次回归为什么存在」的合法注释；我按「不再有**断言/描述**旧缺陷的文字」判它成立，但在报告里点名（避免下一个人误当成未修） |
| 4 | 不允许「只删不测」：等价断言必须**同时**存在于单元测试与集成测试 | **真正满足** | 单元侧见上；集成侧 `tests/integration/brain-adapter.test.ts:20-40`：`MimoClient({ fetchImpl })` → 断言 `ModelError.code === 'MISSING_KEY'`（`:31-33`）+ `chatJson` 路径同样断言（`:35-38`）+ `assert.equal(attempted, 0)`（`:39`）。两层都有，且**两层都有 F1 的同一个环境依赖** |
| 5 | `npm test` 全绿（≥88 项、0 失败），`npm run check:docs` 通过 | **干净环境成立 / 带密钥环境不成立（F1）** | 干净环境（我复核时 `MIMO_API_KEY` 未设置）：`npm test` → **tests 139 / pass 139 / fail 0 / exit 0**；`npm run check:docs` → **38 份 markdown、0 问题、exit 0**。带密钥（`MIMO_API_KEY=dummy-key-for-probe`）：`npm test` → **139 / 137 / 2 失败**，失败项恰好是这两条用例 → F1 |
| 6 | 回报里写明最终用例数与改动摘要 | 成立 | t14 回报写「88 项 / 88 通过 / 0 失败（修复前 88 / 87 / 1）」，改动仅 1 个文件、未改 `packages/`。与它交付时的工作区一致（数量随后被其他任务推高到 139，属正常演进） |

---

## 3. 我亲自验证的缺密钥分类（命令 + 原始输出）

**不改 `.env`**：探针只在**本进程内** `delete process.env.MIMO_API_KEY`，并在 `globalThis.fetch` 外面包一层计数器，用来证明「本地就拒、没发上游」。

```powershell
node data/t15/final-probe.mjs
```

原始输出（单行 JSON）：

```json
{"client":{"threw":true,"code":"MISSING_KEY","message":"MIMO_API_KEY is not set","fetchCalls":0},
 "adapter":{"threw":true,"code":"TRANSPORT_FAILED","originalCode":"MISSING_KEY",
            "detail":"MISSING_KEY: MIMO_API_KEY is not set"},
 "fetchCallsTotal":0,
 "network":{"threw":true,"code":"NETWORK","message":"could not reach the model endpoint (fetch failed)"},
 "fetchCallsFinal":1}
```

- **缺密钥**：`ModelError.code === 'MISSING_KEY'`，**`fetchCallsTotal` 仍是 0**（本地即拒、零上游请求）。
- **经适配器**：`BrainError.code === 'TRANSPORT_FAILED'` 但 `originalCode === 'MISSING_KEY'`、`detail` 里保留原文——归因不丢，只是分层（`MISSING_KEY` 不在 `BrainErrorCode` 闭集里，按 `brainErrorCodeFor()` 的设计归入 transport）。
- **对照**：把 `baseUrl` 指到 `http://127.0.0.1:9/v1`（有 key、不可达）→ `code === 'NETWORK'`、`fetchCallsFinal === 1`。两种诊断**互不污染**。

代码侧复核：`packages/model-adapters/src/mimo.ts:145` 的 `const headers = this.#headers();` 位于 `:147 try {` **之前**，`:139-144` 的注释写明理由；`#headers()` 在 `:129-132` 对缺 key 抛 `ModelError('MISSING_KEY')`。

---

## 4. 关于「旧用例确实被改写」的 git 对照

直接读 `git show`（不依赖工作区）：

```powershell
git log --diff-filter=A --format="%h %s" -- tests/unit/core/brain-error-classification.test.ts
git show f5a54be:tests/unit/core/brain-error-classification.test.ts | Select-String -Pattern "KNOWN GAP|arrives as MISSING_KEY|attempted, 0"
```

实测：

| 版本 | 该文件状态 |
|---|---|
| `f5a54be^`（`c4875cd`） | **文件不存在**（它是在这一次提交里首次出现的） |
| `f5a54be`（提交信息写「t5 + t12 残差（三项落地，1 项测试待收尾）」） | 已含 `arrives as MISSING_KEY` 与 `attempted, 0`，且 **`KNOWN GAP` 0 命中** |
| 当前工作区 | 与 `f5a54be` 的该文件**逐字节相同**（`git diff` 干净） |

也就是说：**t14 的改写确实落在历史里**，工作区没有再被改动过；提交信息把它记成「t12 残差」，只是措辞问题（内容对得上）。

---

## 5. 复核 t12 已落地的三项改动

| 改动 | 我的核对 | 判定 |
|---|---|---|
| `packages/model-adapters/src/mimo.ts` 的 headers 提前 | 见 §3：`:145` 在 `:147 try` 之前；缺密钥 → `MISSING_KEY` 且 fetch 0 次；端点不可达 → `NETWORK` | **真正满足** |
| `docs/design/security-and-privacy.md` §6 按事实改写 | 逐句核过（与 t13 评审同一份证据）：`:122-124` 被拒轮次有记录且不进历史（`engine.ts:282-283` 只 `#recordDecision` 后返回、`recordTurn` 在 `:309` 只在接受路径；真库 `data/chat/xixi.sqlite` 有 19 条 `conversation.decision`、含 1 条 `REJECTED_SUSPENDED`；被拒不进 `recentTurns`）；`:125` 接受路径在 `finally` 幂等补记；`:126-135` payload 11 字段 + `additionalProperties:false`，**只存 reason_code 与分值、不含原话/提示词/推理**（真库 19 条键并集无 `text/transcript/prompt/reply`；`conversation-engine.test.ts:73-74` 断言不含会话句与 `text`）；`:136-139` `turn` 与 `decision` 是两个 schema、`schema_version` 仍 1 | **核心三句真正满足** |
| `plugins/xixi-tools/package.json` 的描述 | description =「西西最小工具集（只读：`xixi_get_current_time` + `xixi_get_weather`）。DSH 插件包，通过 bundle patch 挂载。」；注册表恰好 `index.js:238`/`:262` 两个工具；「只读」属实（无 `fs`/`sqlite`/`spawn`/写方法；`tests/unit/tools.test.ts:94-105` 断言注册表只读最小） | **真正满足** |

**同一份文档里仍有两处与工作区不符的陈述，但它们属于我上一轮 t13 评审的 findings、且已由系统排出 t33/t34 收尾**（我本轮不重复判定，只做交叉引用，避免两条流水线打架）：

- `docs/design/security-and-privacy.md:116` 仍写「store.ts 只提供**两个** `appendEvent` 调用点」，实际是**三个**（`:333 recordHealth`、`:443 recordTurn`、`:778 recordPresenceChanged`，M6 presence 与 `world_state` 同事务）。
- 同文档 `:64` §20.2 仍写「**完全未实现**：仓库里没有摄像头代码…」，而 M6 已落地。
- 详见 [docs/review/residual-fix-t12-review-2026-09-30.md](residual-fix-t12-review-2026-09-30.md) 的 F1/F2。

---

## 6. findings（needs_revision 的依据）

### F1（low，blocking）t14 新写的两条「缺密钥」用例依赖 `process.env.MIMO_API_KEY` 为空，在带密钥的环境里会红

- **位置**：
  - `tests/unit/core/brain-error-classification.test.ts:89`：`const client = new MimoClient({ fetchImpl });`
  - 同文件 `:98`：`const adapter = new MimoBrainAdapter({ client: new MimoClient({ fetchImpl }), stream: false });`
  - `tests/integration/brain-adapter.test.ts:26`：`const client = new MimoClient({ fetchImpl });`（该文件 §5 的其余用例都显式传 `apiKey: 'test-key'`，只有这一条没传）
- **问题**：`MimoClient` 的构造是 `this.#apiKey = options.apiKey ?? process.env.MIMO_API_KEY`（`packages/model-adapters/src/mimo.ts:120`），而 `#headers()` 在 `hasKey` 为真时**不会抛** `MISSING_KEY`（`:129-134`）。所以「缺密钥」这个前提由**运行者的 shell** 决定，不由测试决定。实测：

  ```powershell
  node --test tests/unit/core/brain-error-classification.test.ts          # 5/5 pass
  $env:MIMO_API_KEY='dummy-key-for-probe'
  node --test tests/unit/core/brain-error-classification.test.ts          # 4/5，1 失败
  node --test tests/integration/brain-adapter.test.ts                     # 5/6，1 失败
  npm test                                                               # 139 / 137 / 2 失败
  Remove-Item Env:MIMO_API_KEY
  npm test                                                               # 139 / 139 / 0 失败
  ```

  这不是理论风险：本机**存在 `.env`**（65 字节，其中**确实有 `MIMO_API_KEY`**；`git check-ignore` 确认 `.env` 与 `.env.local` 都在 `.gitignore` 里），而 `scripts/lib/harness.ts` 的 `readDotEnv()` 就是把它灌进 `process.env` 的机制。任何在自己的 shell 里 sourced 过密钥的人（例如要跑 `npm run chat` 或 `verify:*` 的人），下一次跑 `npm test` 就会看到两条**假红**——恰好是「缺密钥」这类最容易被误读成回归的信号。它会直接损害本项目「测试结果可信」的前提，也让「t14 让 npm test 全绿」这句话只在一半环境里成立。
- **requiredFix（每处一行，共三处）**：把前提**显式**交给测试，而不是交给环境。三种等价写法任选其一：
  1. `new MimoClient({ apiKey: undefined, fetchImpl })` —— 最小改动（`??` 只对 `null`/`undefined` 回落，显式传 `undefined` 仍会回落？**注意**：`undefined ?? x` **会**回落到 `x`，所以这个写法**不够**，见下）；
  2. **推荐**：`const client = new MimoClient({ apiKey: '', fetchImpl });` —— 空字符串在 `hasKey` 判断里等价于「没配」（`#apiKey.length > 0`），不依赖 `??` 的回落语义；
  3. 或者显式清空：`const prior = process.env.MIMO_API_KEY; delete process.env.MIMO_API_KEY; try { … } finally { if (prior !== undefined) process.env.MIMO_API_KEY = prior; }`（并加注释说明为什么必须清）。
  另建议**顺手在文件头写一句**「这两条用例必须自己控制『无密钥』前提，不允许依赖运行者的环境」——否则下一个人很容易再犯。
- **复现**：见上命令块（`MIMO_API_KEY=dummy-key-for-probe` 时 `npm test` 2 失败，去掉后 139/139）。

### F2（low，性质上是「留痕」）文件里仍有两处描述旧缺陷的历史注释——建议保留但加一句「已修复」锚点

- **位置**：`tests/unit/core/brain-error-classification.test.ts:14`（`Before this test, every ModelError except TIMEOUT became PROVIDER_FAILED`）与 `:79-81`（`MimoClient.#post used to build its headers inside the fetch try-block …`）
- **问题**：**这不是缺陷**——两处都是过去时，且**没有断言**，属于「解释这条回归用例为什么存在」的合法注释，t14 要求移除的是 `STALE` 与断言旧行为的用例（两者都已 0 命中）。我把它写下来，只是为了不让下一个人把「`used to`」误读成「未修」。
- **requiredFix（可选，0 行~1 行）**：在这两句末尾各加半句「（已由 `#headers()` 提到 try 之前修复；本条用例即其回归断言）」，或保持原样。若选保持，建议在报告/回报里明确「历史注释是刻意保留的」。

---

## 7. 我实际跑过的命令与结果（可核账）

| 命令 | 结果 |
|---|---|
| `node data/t15/final-probe.mjs`（进程内清空 `MIMO_API_KEY`，包一层 fetch 计数） | `client{MISSING_KEY, fetchCalls:0}`；`adapter{TRANSPORT_FAILED, originalCode:'MISSING_KEY'}`；`fetchCallsTotal:0`；死端点 `{NETWORK}`、`fetchCallsFinal:1` → §3 |
| `node --test tests/unit/core/brain-error-classification.test.ts`（干净） | **5 / 5 pass**，含 `a missing key arrives as MISSING_KEY before any request is attempted` |
| `node --test tests/unit/core/brain-error-classification.test.ts`（`MIMO_API_KEY=dummy-key-for-probe`） | **4 / 5，1 失败**（同一用例）→ F1 |
| `node --test tests/integration/brain-adapter.test.ts`（干净 / 带密钥） | **6 / 6 pass** / **5 / 6，1 失败**（`a missing API key fails as MISSING_KEY before any request is attempted`）→ F1 |
| `node --test "tests/unit/core/*.test.ts"` | **32 / 32 pass**（6 个文件，含 t14 之后新增的用例） |
| `npm test`（干净） | **tests 139 / pass 139 / fail 0 / exit 0** |
| `npm test`（`MIMO_API_KEY=dummy-key-for-probe`） | **tests 139 / pass 137 / fail 2 / exit 1**，失败项就是那两条 → F1 |
| `npm run check:docs` | **检查了 38 份 markdown；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；exit 0** |
| 全仓 grep `tests/**/*.ts` 的 `KNOWN GAP` / `STALE` | **0 命中 / 0 命中** |
| `git log --diff-filter=A` + `git show f5a54be:…` + 工作区对比 | 该文件首次出现于 `f5a54be`，其版本已含新用例且无 `KNOWN GAP`；工作区版本与它**逐字节相同** → §4 |
| 读 `packages/model-adapters/src/mimo.ts:120/129-134/136-158` | `apiKey ?? process.env.MIMO_API_KEY`；`#headers()` 在 try 之前；缺密钥抛 `MISSING_KEY` |
| 读 `docs/design/security-and-privacy.md` §6 与真库 `data/chat/xixi.sqlite`（只读） | §6 核心三句与实现/真库一致（见 §5）；`appendEvent` 调用点计数与 §20.2 的旧陈述仍未订正（属 t13 的 F1/F2，交 t33/t34） |
| 读 `plugins/xixi-tools/package.json` + `Select-String index.js -Pattern "name: 'xixi"` | description 同时提到两个工具；注册表恰好 `:238`/`:262` |

**真实 API 调用：0 次**（缺密钥与死端点两个场景本就必须在无鉴权/无外联下测）。**合规说明**：只在本进程/本 shell 会话内设置过 `MIMO_API_KEY=dummy-key-for-probe`（占位值、非真实密钥），随后 `Remove-Item Env:` 清除；未读写 `.env`/`.env.local`；未修改任何实现代码或他人文档；`data/t15/`（探针）**已删除**。

---

## 8. 结论表

| # | 维度 | 判定 |
|---|---|---|
| 1 | t14 条款 1：不再断言旧行为 | **真正满足**（`KNOWN GAP` 0 命中；git 对照证明改写已落地） |
| 2 | t14 条款 2：改为断言已修复行为（MISSING_KEY + fetch 未调用） | **满足**，但**前提由环境决定** → F1 |
| 3 | t14 条款 3：STALE 与旧缺陷文字 | **满足**（`STALE` 0 命中；剩余 `used to`/`Before this test` 是历史叙述，F2 只是留痕建议） |
| 4 | t14 条款 4：单元 + 集成两层等价断言 | **真正满足**（两层都有 code/originalCode/attempted===0） |
| 5 | t14 条款 5：`npm test` 全绿 + `check:docs` | **干净环境成立**（139/139、exit 0）；**带密钥环境 137/139** → F1 |
| 6 | t12 三项改动 | **真正满足**（headers 提前、§6 核心三句、插件描述） |
| 7 | 缺密钥分类（我亲手复现） | **成立**：`MISSING_KEY` + fetch 0 次；端点不可达仍 `NETWORK` |
| 8 | 文档诚实性（§6） | 核心事实成立；同文档 `:116` 计数与 `:64` 摄像头陈述仍未订正（t13 的 F1/F2，交 t33/t34） |

**总判定：needs_revision**。t14 的改写与 t12 的三项改动我都判为**内容正确、可以放行**；唯一的 blocking 项是 **F1**——它让「`npm test` 全绿」这个结论**随环境漂移**，而在本机（存在 `.env.local` 且开发者常会 sourced 密钥）这不是边缘情况。三处各改一行（推荐 `apiKey: ''` 或显式清空/恢复环境）之后，t14 我判 **pass**；F2 只是可选留痕。
