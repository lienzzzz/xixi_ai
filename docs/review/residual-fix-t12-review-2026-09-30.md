# 评审：残差修复（t12 产物）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t12 实现者 core-engineer 与 verifier）
> 日期：2026-09-30
> 评审对象：t12「残差修复：缺密钥分类保真 + KNOWN GAP 用例改写 + 两处过时文档」中**已落地的三项**（缺密钥分类保真 / `security-and-privacy.md` §6 / `xixi-tools` 描述）
> 复核对象：t6 / `docs/verification/field-test-verification-2026-09-30.md` §2.4 条款 7 与 §2.5（含它对 t12 第 2 条的判定）
> 唯一写入路径：本文件（契约 `In scope` 给出的路径）。任务描述里另写了一个不带 `t12` 的文件名（`residual-fix-review-2026-09-30.md`，位于同一 review 目录），与之冲突；我按契约的 `In scope` 落地，并在回报里说明。
> **本任务不覆盖**：t12 的第 2 条（`tests/integration/brain-adapter.test.ts` 的 KNOWN GAP 用例改写）由 **t14 收尾、t15 评审**。我在 §6 只记录「当前工作区它已不再以 KNOWN GAP 形式存在」作为背景，不给它评判。
> 权威来源（本评审实际跑过/读过的）：`packages/model-adapters/src/mimo.ts`、`packages/brain-adapter/src/{mimo,errors}.ts`、`packages/domain/src/store.ts`、`packages/conversation/src/engine.ts`、`tests/integration/brain-adapter.test.ts`、`tests/unit/core/brain-error-classification.test.ts`、`docs/design/security-and-privacy.md`、`plugins/xixi-tools/{index.js,package.json}`、`config/xixi.example.yaml`，以及**我自写的两个探针**（在无密钥环境下直接打生产客户端）

---

## 1. 结论

**verdict：needs_revision（三项改动本身我都亲自验证成立、可以放行；但 t12 改写的 §6 里有一句新的、与当前工作区不符的事实陈述，另有同一份文档里两处更旧的过期事实——按「评审必须给出可执行结论」的规则，我给 needs_revision + 3 条 finding，其中 2 条极低成本的文案订正）**

一句话：**缺密钥分类真的修好了**——我在**无密钥的临时环境**里（只在本进程 `delete process.env.MIMO_API_KEY`，**没有碰 `.env`**）直接打生产客户端：`MimoClient.transcribe()` 抛 `ModelError{code:'MISSING_KEY'}` 且 **fetch 调用计数 = 0**（本地就拒、不发上游）；把它换成**不可达端点**时仍然报 `ModelError{code:'NETWORK'}`，两种诊断**没有互相污染**。跑过适配器一层后，用户看到的是 `BrainError{code:'TRANSPORT_FAILED', originalCode:'MISSING_KEY', detail:'MISSING_KEY: MIMO_API_KEY is not set'}`——**原始码保真地传了下来**，t14 那条「已修复」断言正是钉这个。§6 关于「被拒轮次有记录 / 只存 reason_code 与分值 / 不存原话」的三句话我逐句对着代码与真库核过，**都成立**；`xixi-tools` 的描述与两个只读工具一致。

唯一需要修的不是行为，而是**文档里的一句计数**：§6 说「store.ts 只有两个 `appendEvent` 调用点」——在 t12 当时是对的，但 `recordPresenceChanged()`（M6 presence 投影，与事件同事务）让实际调用点变成**三个**。同一份文档的 §20.2 还写着「仓库里没有摄像头代码…摄像头属 M6」，而 M6 已经落地。

| 维度 | 判定 |
|---|---|
| t12 第 1 条（MISSING_KEY 保真，含单测） | **真正满足**（我独立复现：code=MISSING_KEY、fetchCalls=0；网络失败仍 NETWORK） |
| t12 第 3 条（`security-and-privacy.md` §6 更新） | **内容方向正确、三句核心事实成立**；但 §6 内新增的「两个 appendEvent 调用点」已过期（F1），另有更旧的 §20.2 摄像头陈述（F2） |
| t12 第 4 条（`xixi-tools` 描述） | **真正满足** |
| t12 第 2 条（KNOWN GAP 用例改写） | **由 t14 收尾、t15 评审，本任务不评判**（当前工作区已无 KNOWN GAP 形式，见 §6） |
| t12 第 5 条（`npm test` 全绿 + `check:docs`） | **成立**：`npm test` 137/137、`check:docs` exit 0（我自己跑的） |
| 铁律 5 / 10 | **成立**：decision payload 只含 reason_code 与分值、无原话与推理；新事件走新增 v1 schema |

---

## 2. 逐条核对 t12 的验收标准（范围内三条）

| # | 条款 | 判定 | 我的核对方式与结果 |
|---|---|---|---|
| 1 | `packages/model-adapters/src/mimo.ts` 的 MISSING_KEY 保真：缺密钥时 `ModelError.code` 必须是 `MISSING_KEY`（不是 `NETWORK`），有单元测试断言 | **真正满足** | 见 §3.1。代码：`#post()` 的 `#headers()` 在 `try` **之前**（`mimo.ts:145`，紧邻 `:139-144` 的注释解释为什么）；`#headers()` 在无 key 时抛 `ModelError('MISSING_KEY', …)`（`:129-132`）。我的探针：无密钥 → `code:'MISSING_KEY'`、`fetchCalls:0`；死端点 → `code:'NETWORK'`。单测覆盖在 `tests/unit/core/brain-error-classification.test.ts`（5/5 pass）与 `tests/integration/brain-adapter.test.ts`（6/6 pass） |
| 3 | `docs/design/security-and-privacy.md` §6 更新：被拒轮次已写入 `conversation.decision`，不再写「没有记录」；并说明仍只存 reason_code 与分值、不存原话与推理 | **满足（附 F1/F2）** | 见 §4。`:122-125`「被拒绝的轮次有记录…不会变成对话历史…接受的一轮也会写一条（在 finally 里）」；`:126-135`「`reason_code` 与分值已落库…**仍然只存 reason_code 与分值**：payload 里没有用户原话、没有提示词、没有任何模型私有推理」。我逐句核过（§4），**三句核心事实都成立**；只有 `:116` 的「两个 appendEvent 调用点」与事实不符（F1） |
| 4 | `plugins/xixi-tools/package.json` 的 description 反映两个工具 | **真正满足** | 见 §5。description = 「西西最小工具集（只读：`xixi_get_current_time` + `xixi_get_weather`）。DSH 插件包，通过 bundle patch 挂载。」；注册表里恰好这两个（`index.js:238` / `:262`）；「只读」也与实现一致（无写路径、参数封闭，见 §5） |
| 5 | `npm test` 全绿（≥87 项）且 `npm run check:docs` 通过 | **真正满足** | `npm test` → **tests 137 / pass 137 / fail 0（exit 0）**；`npm run check:docs` → **exit 0**；另单跑 `tests/integration/brain-adapter.test.ts` → **6/6 pass**，含 `a missing API key fails as MISSING_KEY before any request is attempted` |

---

## 3. 我亲自做的验证（本任务重点）

### 3.1 无密钥场景：命令与原始输出

**不改 `.env`、不设全局变量**：探针只在本进程内 `delete process.env.MIMO_API_KEY`（`MimoClient` 的键解析是构造函数里的 `options.apiKey ?? process.env.MIMO_API_KEY`，`mimo.ts:120`），并在探针里**包了一层 `globalThis.fetch` 计数**，用来证明「本地就拒、不发上游」。

```powershell
# 先确认这台机器上其实有密钥（探针内部才清空，不影响其它进程）
node -e "console.log('MIMO_API_KEY in env:', process.env.MIMO_API_KEY === undefined ? 'unset' : 'set')"
node data/t13/final-probe.mjs
```

原始输出（单行 JSON）：

```json
{"client":{"threw":true,"code":"MISSING_KEY","message":"MIMO_API_KEY is not set","fetchCalls":0},
 "adapter":{"threw":true,"code":"TRANSPORT_FAILED","originalCode":"MISSING_KEY",
            "detail":"MISSING_KEY: MIMO_API_KEY is not set",
            "message":"model call failed (MISSING_KEY: MIMO_API_KEY is not set)"},
 "fetchCallsTotal":0,
 "network":{"threw":true,"code":"NETWORK","message":"could not reach the model endpoint (fetch failed)"},
 "fetchCallsFinal":1}
```

三点结论：

1. **缺密钥 = 本地故障，不发上游**：`code:'MISSING_KEY'`，且 `fetchCallsTotal:0`（连一次 `fetch` 都没有）。
2. **网络故障仍然是网络故障**：换成 `http://127.0.0.1:9/v1` → `code:'NETWORK'`，`fetchCallsFinal:1`（真的有 I/O 尝试）。两种诊断**互不污染**，这正是 t12 要修的点。
3. **适配器层保留原始码**（F3）：适配器把 `ModelError` 包成 `BrainError{code:'TRANSPORT_FAILED', originalCode:'MISSING_KEY'}`，`detail` 与 `message` 里都带着 `MISSING_KEY` 字样——所以用户在控制台/CLI 看到的是「**MISSING_KEY: MIMO_API_KEY is not set**」而不是干巴巴的「网络故障」。这与 `tests/unit/core/brain-error-classification.test.ts:71-95` 的断言完全一致（`code==='TRANSPORT_FAILED' && originalCode==='MISSING_KEY'` 且 `attempted===0`）。

### 3.2 代码复核：`#headers()` 真的在 try 之前

`packages/model-adapters/src/mimo.ts` 的 `#post()`（`:136-158`）：

```ts
async #post(path, body, timeoutMs, signal?) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  // Built before the try-block on purpose. `#headers()` throws ModelError('MISSING_KEY')
  // when the key is not configured, and building it inside the fetch try let that failure
  // be caught and re-labelled as NETWORK — which told a user who forgot to fill `.env`
  // that the network was broken. …
  const headers = this.#headers();          // ← :145，try 之外
  let response: Response;
  try {
    response = await this.#fetch(...);      // ← :147，只有真正的 I/O 在 try 里
  } catch (cause) {
    if (/abort/i.test(message)) throw new ModelError('TIMEOUT', …);
    throw new ModelError('NETWORK', 'could not reach the model endpoint', { detail: message });
  }
```

`#headers()` 在 `:129-132` 里对缺 key 抛 `ModelError('MISSING_KEY')`。**修法与验收要求完全一致**（把 `#headers()` 移到 try 之前），且注释把「为什么」写清了（不是留一句「修复 bug」）。`TIMEOUT` 分支也仍然只对 abort 生效——`catch` 的范围收窄后没有影响它。

### 3.3 两种场景的覆盖矩阵

| 场景 | 我构造的方式 | 观察到的 `client` 层 | 观察到的 `adapter` 层 | fetch 次数 |
|---|---|---|---|---|
| 有端点、无密钥 | 进程内清空 `MIMO_API_KEY` | `MISSING_KEY` | `TRANSPORT_FAILED` + `originalCode:'MISSING_KEY'` | **0** |
| 有密钥、端点不可达 | `baseUrl: http://127.0.0.1:9/v1`、`timeoutMs:1200` | `NETWORK` | （未再经适配器） | 1 |

---

## 4. 文档诚实性：`docs/design/security-and-privacy.md` §6 逐句核对

| §6 的陈述 | 我的核对方式 | 判定 |
|---|---|---|
| `:122-124`「**被拒绝的轮次有记录**：`respond` 在 `accepted === false` 时**不**调用 `recordTurn`（所以不进对话历史、不进工作记忆），但会**先**追加一条 `conversation.decision`」 | 读 `packages/conversation/src/engine.ts`：`:282` `if (!acceptance.accept) {` → `:283` `#recordDecision(...)` → 返回；`recordTurn` 在 `:309`（只在接受路径）。另用真库确认：`data/chat/xixi.sqlite` 有 19 条 `conversation.decision`，其中 1 条 `accepted:false / reason:REJECTED_SUSPENDED`；我的引擎探针里，被拒那句之后 `recentTurns` 不增长 | **成立** |
| `:125`「接受的一轮也会写一条（在 `finally` 里，所以『接受了、随后供应商报错』同样留痕）」 | 读 `engine.ts` 的 `finally` 块：`recordAcceptedDecision(turnAction, …)`，且有 `decisionRecorded` 幂等守卫（避免双写） | **成立** |
| `:126-129` payload 字段清单与 `additionalProperties:false` | 读 `packages/contracts/schemas/events/conversation.decision.v1.json`（11 个属性、`additionalProperties:false`）与真库 19 条的键并集——两者一致 | **成立** |
| `:130-131` `reason` 的四个取值就是 `TurnAcceptanceReason` | 读 `fsm.ts:151-163`：`REJECTED_SUSPENDED` / `ACCEPTED_WAKE_OR_DIRECT` / `REJECTED_NOT_ADDRESSED` / `ACCEPTED_CONTINUATION`——与 schema enum 与文档逐字一致 | **成立** |
| `:132`「分值由 `acceptance_score`（1/0）与 envelope 的 `confidence`（1 / 0.5）承担」 | 读 `engine.ts:211`（`confidence: acceptance.accept ? 1 : 0.5`）与 `:222`（`acceptance_score: acceptance.accept ? 1 : 0`）；真库那条被拒行正是 `confidence:0.5 / acceptance_score:0` | **成立**（注意 `acceptance_score` 的语义局限见 §7 F3 的备注） |
| `:133-135`「**仍然只存 `reason_code` 与分值**：payload 里没有用户原话、没有提示词、没有任何模型私有推理；`tests/integration/conversation-engine.test.ts` 断言该 payload 不含本轮文本且没有 `text` 字段」 | 读 `tests/integration/conversation-engine.test.ts:73-74`：`assert.equal(JSON.stringify(payload).includes('明天'), false, …)` 与 `assert.equal('text' in payload, false, …)`；真库 19 条的键并集里没有任何 `text/transcript/prompt/reply`；`conversation.turn`（那一份确实存原话）是**另一个**事件类型 | **成立** |
| `:136-139` `conversation.turn` 的 payload 保持不变，因此 `reason_code` 是**新事件类型**而不是给已发布 v1 加字段 | 读 `conversation.turn.v1.json` 与 `conversation.decision.v1.json` 是两个文件；`envelope.v1.json` 的 enum 是增项；`schema_version` 仍 1 | **成立** |
| `:116-121`「`store.ts` **只提供两个 `appendEvent` 调用点**——`recordTurn` 与 `recordHealth`；`conversation.decision` 由引擎直接 append；`createSession` 不写事件；`seedSelfProfile`/`overrideSelfProfile` 不写事件」 | `createSession`（`store.ts:347`）只 INSERT `conversation_sessions`——**不写事件 ✓**；`seedSelfProfile`（`:532`）/`overrideSelfProfile`（`:584`）只写 profile 表 ✓；但 `appendEvent` 的调用点是 **3 处**：`:333` `recordHealth`、`:443` `recordTurn`、**`:778` `recordPresenceChanged`（M6 presence 投影，与事件同事务）** | **计数不成立 → F1** |

**结论**：t12 要修的三句（不再写「没有记录」、只存 reason_code 与分值、不存原话/推理）**都是真的**，改写方向正确；过期的是它同一段里那句顺带补充的调用点计数。

---

## 5. 插件描述与工具面一致性

| 检查 | 结果 |
|---|---|
| description 文本 | 「西西最小工具集（**只读**：`xixi_get_current_time` + `xixi_get_weather`）。DSH 插件包，通过 bundle patch 挂载。」 |
| 实际注册的工具 | `index.js:238` `xixi_get_current_time`、`:262` `xixi_get_weather` —— **恰好两个，名字与描述逐字对上** |
| 「只读」是否属实 | 两个工具都只做查询：时间工具用注入的 `now`，天气工具只有 `fetch` GET（`geocoding` + `forecast`，带 `AbortSignal.timeout`）；全文件**没有** `fs` / `sqlite` / `spawn` / 任何写方法；`tests/unit/tools.test.ts:94-105` 断言默认注册表里没有任何 `set_/write/send/delete/control/unlock` 类工具 |
| 参数封闭 | `WEATHER_PARAMETERS.additionalProperties:false`（`index.js:80`）+ 输出 schema 也封闭（`:101`/`:111`）+ 运行前**再校验一次**（`:326-331`），不认识的参数报中文错误而不是静默忽略 |

---

## 6. 关于 t12 第 2 条（KNOWN GAP 用例）—— 只记录状态，不评判

按契约，这条由 **t14 收尾、t15 评审**，我不给判定。为了读者不误解，只记录当前工作区的状态：

- `tests/integration/brain-adapter.test.ts` 里**已无** `KNOWN GAP` 形式的用例；现在的用例名是 `a missing API key fails as MISSING_KEY before any request is attempted`（`:20`），断言 `ModelError.code === 'MISSING_KEY'` 与 `attempted === 0`（`:23/:32/:37/:39`）。
- 我实跑该文件 → **6/6 pass**。
- 全仓 grep `KNOWN GAP` 只剩 `docs/design/brain-and-models.md:202/:228` 的历史叙述（描述那处已修的一行改动），**不在本任务评判范围**。

---

## 7. findings（needs_revision 的依据）

### F1（low）`docs/design/security-and-privacy.md:116` 的「两个 `appendEvent` 调用点」已过期：现在是三个

- **位置**：`docs/design/security-and-privacy.md:116-121`
  > 「`packages/domain/src/store.ts` **只提供两个 `appendEvent` 调用点**——`recordTurn`（`conversation.turn`）与 `recordHealth`（`system.health`）…所以「每条状态变更都进事件表」目前只对**对话轮次、接受判定与健康状态**成立。」
- **问题**：`store.ts` 现在有 **3 个** `appendEvent` 调用点——`:333` `recordHealth`、`:443` `recordTurn`、**`:778` `recordPresenceChanged`**（M6 摄像头在场检测的写入方：事件 + `world_state` 投影同一事务，并由此产出 `presence.changed`）。最后一行的「只对三类成立」也就漏了**感知边（presence）**这一类。这句话在 t12 当时是对的（那时 M6 未落地），但它出现在**§6 的「事件是唯一事实来源」这个小节里**，而这一节正是 t12 刚刚改写的——一个读者会把它当成「刚核对过的最新事实」。
- **影响面**：low（不影响任何行为），但它恰好落在「审计/唯一事实来源」这个对可信度最敏感的小节里；接着 M7（主动问候）会消费 `presence.changed`，这类计数错的文档会误导下一个判断「谁能写事件」的人。
- **requiredFix（1 行级）**：把 `:116-121` 改成「`store.ts` 提供**三**个 `appendEvent` 调用点——`recordTurn`（`conversation.turn`）、`recordHealth`（`system.health`）、`recordPresenceChanged`（`presence.changed`，与 `world_state` 投影同一事务，M6 感知边）；`conversation.decision` 由引擎直接 `store.appendEvent` 追加（`packages/conversation/src/engine.ts` 的 `#recordDecision`）。所以『每条状态变更都进事件表』目前对**对话轮次、接受判定、健康状态与在场状态**成立。」（顺带把 `createSession` / `seedSelfProfile` / `overrideSelfProfile` 不写事件那句保留——我核过，那句是对的。）
- **复现**：`Select-String -Path packages/domain/src/store.ts -Pattern "appendEvent"` → 4 行（1 处定义 `:267` + 3 处调用 `:333/:443/:778`）。

### F2（low）同一份文档 `:62-64` 的 §20.2 还写着「仓库里没有摄像头代码」——M6 已落地

- **位置**：`docs/design/security-and-privacy.md:62-64`
  > 「### 20.2 原始视频 — **完全未实现**：仓库里没有摄像头代码，`config` 里 `features.camera_presence: false`。方案 §20.2 的「本地检测、只留事件截图、不上云」属 M6。」
- **问题**：M6 已经落地（`services/perception-edge`：本地抓帧 + 帧差动/YuNet 判定 + `presence.changed` + `world_state` 投影；连续视频与截图都不出本机，有 AST 扫描测试断言）。「仓库里没有摄像头代码」现在是**直接的假陈述**，而「本地检测、不上云」这条承诺**已经实现**，文档却把它写成未来时。
- **影响面**：low（不影响行为），但 §20.2 是隐私文档里最常被引用的一节；一个来审计「你们到底有没有摄像头」的人会得到相反答案。**归因说明**：这是 t3 落地时没有同步这份文档（t12 的四条 inScope 里不含 §20.2，本 finding 不归责 t12），我按「文档诚实性检查」把它记下来，供 captain 决定补哪个小任务。
- **requiredFix（小改动，建议同一个收尾任务一起做）**：把 §20.2 改成与事实一致的现在时——
  「**已实现（M6）**：`services/perception-edge` 在本机抓帧并做「帧差动 + YuNet 人脸」两层判定，**页面与视频都不出本机**（服务内无任何网络客户端，有 AST 扫描测试断言）；状态变化只写成 `presence.changed` 事件（payload 仅 `{present, source_detail}`，无图像）；连续视频不落盘、不存储；『按需把**单帧截图**交多模态模型分析』的通道**刻意未实现**（`semantic.py` 调用即抛错）。`config` 的 `features.camera_presence` 见 `config/xixi.example.yaml`。」
  （`features.camera_presence` 现值请按 config 实测填写，不要照抄旧句。）

### F3（low，性质上是「留痕/信息」）适配器层的 `code` 是 `TRANSPORT_FAILED`——原文码在 `originalCode`/`detail`，文档与测试应把这条口径写清

- **位置**：`packages/brain-adapter/src/mimo.ts`（适配器把 `ModelError` 折成 `BrainError`）；`packages/brain-adapter/src/errors.ts:65-79`（`brainErrorCodeFor()` 的映射表）；相关断言在 `tests/unit/core/brain-error-classification.test.ts:71-95` 与 `tests/integration/brain-adapter.test.ts:20-39`
- **问题**：本条**不是缺陷**，是一个容易被误读的口径。t12 的验收要求是「**缺密钥时抛出的 `ModelError.code` 必须是 `MISSING_KEY`**」——`ModelError` 层**确实**是 `MISSING_KEY`（我实测）。但经过适配器一层后，用户看到的是 `BrainError{code:'TRANSPORT_FAILED', originalCode:'MISSING_KEY'}`（因为 `MISSING_KEY` 不在 `BrainErrorCode` 的闭集里，按设计归到 transport 并保留原始码）。如果后来有人只看适配器层的 `code`，会以为「MISSING_KEY 又被吞成 TRANSPORT_FAILED 了」，从而重开一个已修的问题。
- **影响面**：low（纯口径）。建议在文档里把两层写清，避免重复劳动。
- **requiredFix（1 句）**：在 `docs/design/security-and-privacy.md` §20.4（Secrets）或 §6 末尾加一句：「缺密钥的**归因分层**：`ModelError.code === 'MISSING_KEY'`（本地即拒、不发上游，有单测断言 fetch 未被调用）；经 `BrainError` 后 `code` 为 `TRANSPORT_FAILED` 但 `originalCode === 'MISSING_KEY'` 且 `detail` 保留原文——诊断信息不丢，只是分层。」（`acceptance_score` 二值语义的备注已在 `docs/review/core-wiring-review-2026-09-30.md` F1 提出，不在此重复。）

---

## 8. 我实际跑过的命令与结果（可核账）

| 命令 | 结果 |
|---|---|
| `node data/t13/final-probe.mjs`（进程内清空 `MIMO_API_KEY`；只为这个进程） | `client` 层：`code:'MISSING_KEY'`、`fetchCalls:0`；`adapter` 层：`code:'TRANSPORT_FAILED'`、`originalCode:'MISSING_KEY'`、`detail:'MISSING_KEY: MIMO_API_KEY is not set'`；死端点：`code:'NETWORK'`、`fetchCallsFinal:1` → §3.1 |
| `node data/t13/key-probe.mjs`（同一场景的第一次取样） | `clientTranscribe`：`isModelError:true, code:'MISSING_KEY', message:'MIMO_API_KEY is not set', fetchCalls:0`；`networkCase`：`code:'NETWORK', detail:'fetch failed'` |
| `node --test tests/integration/brain-adapter.test.ts` | **6 / 6 pass，exit 0**，含 `a missing API key fails as MISSING_KEY before any request is attempted` |
| `node --test tests/unit/core/brain-error-classification.test.ts` | **5 / 5 pass**（HTTP 状态分类、共享分类器、网络=TRANSPORT_FAILED、缺密钥本地拒、DSH 保留 originalCode） |
| `npm test` | **tests 137 / pass 137 / fail 0 / exit 0** |
| `npm run check:docs` | 失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0 → **exit 0** |
| `Select-String -Path packages/domain/src/store.ts -Pattern "appendEvent"` | **4 行**：`:267` 定义 + 调用点 `:333` `recordHealth`、`:443` `recordTurn`、`:778` `recordPresenceChanged` → F1 |
| 读 `createSession`（`store.ts:347-372`） | 只 INSERT `conversation_sessions`，**不写事件** → 文档 `:120` 该句成立 |
| 读 `packages/conversation/src/engine.ts:282-283 / :309 / :373 / finally` | 拒绝路径只 `#recordDecision` 后返回，`recordTurn` 只在接受路径；接受路径在 `finally` 幂等补记 → 文档 `:122-125` 成立 |
| 读真库 `data/chat/xixi.sqlite`（只读） | 19 条 `conversation.decision`（1 条 `accepted:false / REJECTED_SUSPENDED`）；键并集 11 个、无 `text/transcript/prompt/reply` → 文档 `:126-135` 成立 |
| `node -e` 读 `plugins/xixi-tools/package.json` + `Select-String index.js -Pattern "name: 'xixi"` | description 提到 `xixi_get_current_time` + `xixi_get_weather`；注册表恰好这两个 → t12 第 4 条成立 |

**真实 API 调用：0 次**（缺密钥与死端点两个场景都必须在无外联/无鉴权下测，符合本任务目的）。**合规说明**：探针只在本进程内清空环境变量、只在只读模式下打开真库；未修改 `.env`、未改动任何实现代码或他人文档；`data/t13/`（探针脚本）**已删除**。

---

## 9. 结论表

| # | 维度 | 判定 |
|---|---|---|
| 1 | t12 第 1 条 MISSING_KEY 保真 | **真正满足**：`ModelError.code='MISSING_KEY'`、fetch 0 次；端不可达仍 `NETWORK`（互不污染） |
| 2 | t12 第 3 条 §6 更新（被拒轮次有记录 / 只存 reason_code 与分值 / 不存原话） | **三句核心事实成立**；同段 `:116` 的「两个 appendEvent 调用点」已过期（F1） |
| 3 | t12 第 4 条 插件描述 | **真正满足**（与两个只读工具逐一对应） |
| 4 | t12 第 2 条 KNOWN GAP 用例 | 由 t14/t15 负责，本任务只记录现状（已无 KNOWN GAP 形式） |
| 5 | 铁律 5 / 10 | **成立**（payload 无原话与推理；新事件走新增 v1 schema，未原地改已发布契约） |
| 6 | 文档诚实性（整体） | §6 目标三句已修好；F1（同段计数）与 F2（§20.2 摄像头陈述）仍与工作区不符 |
| 7 | 环境门禁 | 我自己复跑：`npm test` 137/137、`check:docs` exit 0、brain-adapter 6/6、错误分类 5/5 |

**总判定：needs_revision**。三项改动的**行为与核心事实我判为真实可信、可以放行**；需要落地的只有文案：**F1**（§6 里的 `appendEvent` 调用点从 2 改成 3，并补上 presence 这一类）、**F2**（§20.2 的「仓库里没有摄像头代码」改成 M6 已实现的事实，含「单帧语义分析刻意未实现」）、以及 **F3** 的一句分层说明（`ModelError` 层 `MISSING_KEY` vs `BrainError` 层 `TRANSPORT_FAILED + originalCode`）以避免重复排查。三处都在 `docs/design/security-and-privacy.md` 一份文件里，建议由同一个收尾任务一次改完。
