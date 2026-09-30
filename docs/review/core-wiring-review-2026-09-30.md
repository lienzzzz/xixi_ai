# 评审：核心接线缺陷修复（t5 产物）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t5 实现者 core-engineer 与 verifier）
> 日期：2026-09-30
> 评审对象：t5「核心接线缺陷修复（人格接线 / 可审计拒绝 / DSH 工具齐平 / 错误分类保真）」的**产物本身 + 当前工作区终态**
> 复核对象：t6 / `docs/verification/field-test-verification-2026-09-30.md` §2.4、§8.1（独立验证报告）
> 唯一写入路径：本文件。未修改任何实现代码、测试或其他人的文档。
> 权威来源（本评审实际跑过/读过的）：`packages/conversation/src/{engine,fsm,personality}.ts`、`packages/brain-adapter/src/{errors,mimo,dsh}.ts`、`packages/contracts/schemas/events/conversation.decision.v1.json`、`packages/contracts/src/{events,envelope}.ts`、`plugins/xixi-tools/index.js`、`scripts/chat.ts`、`tests/unit/{contracts.core,tools}.test.ts`、`tests/unit/core/{engine-personality,brain-error-classification,dead-code-truthfulness,plugin-tools}.test.ts`、`tests/integration/conversation-engine.test.ts`、`docs/design/conversation.md`，以及**我自写的引擎探针**（本树 vs `2b2321d` 的 engine.ts 对照）

---

## 1. 结论

**verdict：needs_revision（六项修复是真的、可复现、且守铁律；findings 只有 1 条 low + 2 条 info，都不是功能缺陷，但其中 F1 是「报告里没被证明的一个数」，F2 是「t5 自述的一条验证在 t5 当时并不成立」）**

一句话：**这一次的接线是真的接上了**——我用**自己的引擎探针**（不是跑仓库测试）确认 `silence_tolerance` 经由 `ConversationEngine` 生效（人格 0.7/1/0.2 → 跟进窗口 36000/45000/21000 ms，且引擎读到的值就是人格值）；被拒绝的轮次**真的在事件日志里**（我在真库 `data/chat/xixi.sqlite` 里查到一条 `REJECTED_SUSPENDED`，payload 只有 11 个允许的键、**没有一个**可能装用户原话或模型推理的键）；新事件类型**是版本化的**（新增 v1 schema、注册表 + envelope enum 同步、有专门的漂移测试）；天气工具是只读且参数封闭的（两处 `additionalProperties:false` + 运行前再校验一次，没有任何写路径）；错误分类**不再一律 PROVIDER_FAILED**（401/403→AUTH、402→QUOTA、429→RATE_LIMIT、400→BAD_REQUEST、503→PROVIDER_FAILED，逐状态断言）。

**必须说清的一条**：t5 自己交付的 `scripts/chat.ts` 修复**不足以**满足「长停顿后下一句仍被接受」——我用 `2b2321d` 的 `engine.ts` 跑同一条 CLI 序列，**line 2 仍然 `REJECTED_NOT_ADDRESSED`**；今天它能过，是因为随后落地的 **t19「读取即推进」**（`engine.state` getter 里 `#advance()`）叠了上去。我独立复现出了这个 before/after 差异（见 §3.2），并且 t5 回应里「集成测试同名断言」这句话在 t5 当时**不成立**（那条测试 t19 才加入，见 F2）。这不是要追责，而是**记录清楚哪一步真正修好了用户能看见的行为**。

| 维度 | 判定 |
|---|---|
| t5 的 7 条验收标准 | **7 条在当前工作区都成立**；其中条款 2 依赖 t19 的后续修复（F2 记录），条款 3 的一个字段存在度问题（F1） |
| silence_tolerance 是否「经由引擎真实生效」 | **是**（我的引擎探针：人格 → 窗口，且无手工传参，见 §3.1） |
| CLI 缺陷修复（前后对比） | **已修**：`2b2321d` 的引擎 → 第一句被拒；当前树 → 第一句被接受（§3.2） |
| 可审计性 | **成立**：真库可查到拒绝轮次的 reason/fsm_state/linger_ms/silence_tolerance（§3.3） |
| 契约纪律（版本化 / 注册表 / 漂移测试 / 不原地改） | **成立**（§3.4） |
| DSH 天气工具（只读 / 参数封闭 / 同数据源 / 未放宽权限） | **成立**（§3.5） |
| 错误分类保真 | **成立**（§3.6） |
| 死码与语义诚实 | **成立**（`SESSION_MISMATCH` 0 命中；BACKCHANNEL/WAIT「无生产者」有测试固化） |
| 环境门禁 | 我自己复跑：`npm test` **137/137**、`check:docs` **exit 0**、错误分类 5/5、人格 5/5 |

---

## 2. 逐条核对 t5 的 7 条验收标准

| # | 条款 | 判定 | 我的核对方式与结果 |
|---|---|---|---|
| 1 | `silence_tolerance` 真正接进 FSM（从持久化人格读入），且「不同人格值 → 不同跟进窗口」**经由引擎**生效，不是测试手工构造 FSM 参数 | **真正满足** | 见 §3.1。引擎侧：`engine.ts:110` 构造时 `#syncSilenceTolerance()`，`:169-179` 从 `store.selfProfile()['silence_tolerance']` 读并 `fsm.setSilenceTolerance()`，优先级在引擎里唯一决定（人格 → 显式 `fsm.silenceTolerance` 覆盖 → 具名 `DEFAULT_SILENCE_TOLERANCE`，后者只在 `personality.ts` 里声明、FSM 内不再藏默认值）。**我的探针**（只经引擎、不传 `fsm.silenceTolerance`）：`overrideSelfProfile({silence_tolerance})` 三次 → `engine.silenceTolerance` 与 `engine.lingerMs` 分别 (0.7, 36000)、(1, 45000)、(0.2, 21000) |
| 2 | `scripts/chat.ts` 的 addressed 语义修复：跟进窗口超时回 IDLE 后**下一句**仍能被正确判定与接受；给出复现命令与前后对比 | **当前工作区满足（修复由 t19 完成，非 t5 单独完成）** | 见 §3.2 的对照实验：同一序列在 `2b2321d` 的引擎上 line 2 → `accepted:false, REJECTED_NOT_ADDRESSED`（读到的状态是过期的 `LINGERING`）；在当前树上 line 2 → `accepted:true, ACCEPTED_WAKE_OR_DIRECT`（读到 `IDLE`）。t5 交付的是 `chat.ts:228` 的 `const addressed = engine.state === 'IDLE'`（+ 注释），**读的是过期缓存**，所以只靠 t5 这一处不够；t19 的「读取即推进」才是让条款字面成立的那一步（F2） |
| 3 | 被拒绝的轮次可审计（版本化事件记录 accepted=false + reason），遵守铁律 5（只存 reason_code 与分值） | **真正满足（附 F1 的字段度问题）** | 见 §3.3/§3.4。真库 `data/chat/xixi.sqlite` 有 19 条 `conversation.decision`，其中 **1 条 `accepted=false, reason=REJECTED_SUSPENDED, action=SILENCE, fsm_state=SUSPENDED, confidence=0.5, schema_version=1`**，payload 11 个键全在允许清单内（`session_id/turn_index/accepted/reason/action/fsm_state/fsm_state_before/addressed/acceptance_score/linger_ms/silence_tolerance`），**没有任何 transcript/text/reply/prompt 类键**。我的探针另造了一条 `REJECTED_NOT_ADDRESSED` 并确认它落库、且**不写进 recentTurns**（§3.3） |
| 4 | DSH 路径工具齐平：`plugins/xixi-tools` 增加只读 `xixi_get_weather`（只读、参数封闭、与直连同一数据源），且**不为齐平放宽权限** | **真正满足** | 见 §3.5：两处端口一致（`geocoding-api.open-meteo.com/v1/search` + `api.open-meteo.com/v1/forecast`，与 `packages/model-adapters/src/weather.ts` 同源）、30 分钟缓存、`WEATHER_PARAMETERS.additionalProperties:false` 且 `WEATHER_OK_OUTPUT/ERROR_OUTPUT` 也是封闭的、运行前还有一次显式校验（不认识的参数直接报错而不是静默忽略）；全文件**没有**任何 `fs`/`sqlite`/`spawn`/写方法；`tests/unit/tools.test.ts:94-105` 断言「默认注册表只读且最小」 |
| 5 | 适配器错误分类保真：AUTH/RATE_LIMIT/QUOTA 不再一律 `PROVIDER_FAILED`，有单测 | **真正满足** | 见 §3.6：`brainErrorCodeFor()` 是两条路径共用的唯一映射表；`BrainError.originalCode` 保留原始码；单测逐状态断言 401→AUTH、403→AUTH、402→QUOTA、429→RATE_LIMIT、400→BAD_REQUEST、503→PROVIDER_FAILED，并断言 `detail` 里保留原始原因。我实跑该文件 → **5/5 pass** |
| 6 | 死码与语义诚实：`SESSION_MISMATCH` 要么用要么删；BACKCHANNEL/WAIT 要么有确定性生产者，要么明确标注并用测试固化 | **真正满足** | 全仓 grep `SESSION_MISMATCH` → **0 命中**（代码与测试都没了，只剩 `docs/design/brain-and-models.md` 的历史叙述）；`tests/unit/core/dead-code-truthfulness.test.ts` 用真实引擎断言「被拒轮次落 `SILENCE`」「BACKCHANNEL/WAIT 无生产者但契约仍接受它们」；`docs/design/conversation.md` 的「状态读取即推进」与「已修（t5）」两段把历史缺陷与现状分开写清 |
| 7 | `npm test` 全绿、`check:docs` 通过、两份设计文档已更新 | **真正满足** | 我复跑：`npm test` → **tests 137 / pass 137 / fail 0（exit 0）**；`npm run check:docs` → **exit 0**；`docs/design/conversation.md`（367 行）与 `docs/design/brain-and-models.md` 均已更新，且 conversation.md 把「不可达」的旧说法**明确标注并解释为什么当时的理由是错的** |

---

## 3. 我亲自做的验证（不是复读别人的测试）

方法：写了一个**只用引擎公开接口**的探针（`data/t10/wiring-probe.mjs`，一次性，已删除），在同一进程里跑两遍——一遍用工作区的 `@xixi/conversation`，一遍用 `git show 2b2321d:packages/conversation/src/engine.ts`（t5 交付时的引擎，**无 `#advance`**）动态 import 进来的副本。两边都只在**仓库外**的临时目录里建库（`mkdtempSync`），没有碰 `data/` 里的任何真实库。

### 3.1 人格 → 跟进窗口，只经引擎

| `overrideSelfProfile({silence_tolerance})` | `engine.silenceTolerance` | `engine.lingerMs` | 说明 |
|---|---|---|---|
| 0.7（种子基线） | 0.7 | **36000** | = 30000 × 1.2 |
| 1.0 | 1.0 | **45000** | = 30000 × 1.5 |
| 0.2 | 0.2 | **21000** | = 30000 × 0.7 |

探针构造引擎时**故意不传** `fsm.silenceTolerance`，所以这三个窗口只可能来自持久化人格；`engine.ts:172-178` 的三级优先级与探针结果一致。**这是「经由引擎真实生效」的直接证据，不是测试里手工构造 FSM 参数。**

### 3.2 CLI 序列：前后对比（同一探针、同一序列）

序列完全照 `scripts/chat.ts:228`：`addressed = engine.state === 'IDLE'`，中间把注入时钟推 10 分钟，**全程不调用 `engine.tick()`**。

| 步骤 | `2b2321d` 的引擎（t5 交付时） | 当前工作区 |
|---|---|---|
| line 1 | addressed=true → accepted, `ACCEPTED_WAKE_OR_DIRECT`；随后 state=LINGERING | 同左 |
| 10 分钟停顿后**读到的状态** | **`LINGERING`（过期缓存）** | **`IDLE`（读取即推进）** |
| line 2（用户停顿后的第一句） | **accepted=false, `REJECTED_NOT_ADDRESSED`** | **accepted=true, `ACCEPTED_WAKE_OR_DIRECT`** |
| line 3 | accepted, `ACCEPTED_WAKE_OR_DIRECT` | accepted, `ACCEPTED_CONTINUATION` |
| 明确未直呼的一句（电视声） | accepted=false, `REJECTED_NOT_ADDRESSED`, action=SILENCE | accepted=false, `REJECTED_NOT_ADDRESSED`, action=SILENCE |

**结论**：t6 的 F1「长停顿后第一句被拒」是**真的**，能用 t5 的引擎原样复现；**在当前工作区已被修好**（根因修法在 `engine.ts:119-147` 的 `#advance()`：`state` 与 `snapshot()` 读取时先按注入时钟 `tick` 再返回）。另外我还在真机跑了一次 `npm run chat -- --fake`（管道喂两行）→ 两轮都是 `SPEAK`、`state=LINGERING`、`linger=36000ms 人格=0.7`，**没有出现拒绝**，与探针一致。

### 3.3 可审计性：在事件日志里查被拒绝的轮次

命令（我用 `node:sqlite` 只读查真库，等价于 `sqlite3` 的两条 SQL）：

```powershell
# 1) 有哪些决策事件、被拒的有几条
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/chat/xixi.sqlite',{readOnly:true});console.log(db.prepare(\"SELECT event_type,count(*) c FROM events GROUP BY event_type\").all());console.log(db.prepare(\"SELECT count(*) c FROM events WHERE event_type='conversation.decision' AND json_extract(payload_json,'$.accepted')=0\").get())"
# 2) 把被拒那一条完整打出来
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/chat/xixi.sqlite',{readOnly:true});for(const r of db.prepare(\"SELECT timestamp,source,schema_version,confidence,payload_json FROM events WHERE event_type='conversation.decision'\")){const p=JSON.parse(r.payload_json);if(!p.accepted)console.log(r.timestamp,r.source,r.schema_version,r.confidence,r.payload_json)}"
```

实测输出（原文）：

```text
by type: [{"event_type":"conversation.decision","c":19},{"event_type":"conversation.turn","c":54},{"event_type":"system.health","c":24}]
rejected count: 1 / total decisions: 19
REJECTED ROW FOUND
 timestamp: 2026-09-30T12:19:52.853+08:00 | source: brain | schema_version: 1 | confidence: 0.5
 payload: {"session_id":"sess_8a45586a-…","turn_index":0,"accepted":false,"reason":"REJECTED_SUSPENDED",
           "action":"SILENCE","fsm_state":"SUSPENDED","fsm_state_before":"SUSPENDED","addressed":false,
           "acceptance_score":0,"linger_ms":36000,"silence_tolerance":0.7}
```

按 `event_type` 汇总的 payload 键集合（19 条并集）与我另外造的拒绝样本一致，都是 11 个键：

```text
["acceptance_score","accepted","action","addressed","fsm_state","fsm_state_before","linger_ms","reason","session_id","silence_tolerance","turn_index"]
suspicious keys (text|transcript|reply|prompt|utterance|content): []
```

**拒绝轮次不进历史**：我的探针里，未直呼那一句被拒后 `store.recentTurns(sessionId)` 仍是 4（前 4 轮留下的），与 `tests/integration/conversation-engine.test.ts:61` 的断言一致。**「接受了但供应商失败」也可审计**：`engine.ts` 的 `finally` 里 `recordAcceptedDecision(...)` 带 `decisionRecorded` 幂等守卫，注释写明理由（§21 降级需要这条事实）。

### 3.4 契约纪律：版本化、注册表、漂移测试、不原地修改

| 检查 | 结果 |
|---|---|
| 新事件类型是否版本化 | `packages/contracts/schemas/events/conversation.decision.v1.json`（新增文件，**没有**改动 `conversation.turn.v1.json`）；`additionalProperties:false` + `required` 6 项；`$id: xixi.event.v1/conversation.decision` |
| 注册表是否同步 | `packages/contracts/src/events.ts:52-57` 新增 `define('conversation.decision', 1, …, 'events/conversation.decision.v1.json')`；`envelope.v1.json` 的 `event_type` enum 同步（漂移测试会比较两者） |
| 是否有漂移测试 | `tests/unit/contracts.test.ts:183`「registry, envelope enum and actor list stay in sync」+ `:156`「every committed schema only uses keywords this validator enforces」+ `:176`「the validator fails closed on a keyword it cannot enforce」；另有 `tests/unit/core/dead-code-truthfulness.test.ts` 从真实引擎产生事件再用 `validateEvent` 复核 |
| 有没有原地修改已发布契约 | **没有**。`envelope.v1.json` 只做了 enum 增项（新增类型必须进 enum，语义上属于「新增」而不是改形状）；`schema_version` 仍为 1、`payloadVersion` 为 1；`conversation.turn.v1.json` 未动 |

### 3.5 DSH 天气工具：只读 + 参数封闭 + 同数据源

- **数据源一致**：`plugins/xixi-tools/index.js:23-24` 与直连路径同一个 Open-Meteo 两段式（geocoding + forecast）、同一组 `daily` 字段、默认时区 `Asia/Shanghai`。
- **参数封闭**：`:77-81` `additionalProperties: false`；`:93` 的 `timezone` 也是封闭集合；`:326-331` 还有一次**运行前的显式校验**，不认识的参数直接返回中文错误而不是静默忽略（`defineTool` 的隐式参数根不带 `additionalProperties:false`，这一点 t5 在报告里如实记了）。
- **只读**：全文件没有 `fs`/`sqlite`/`spawn`/写方法；对上游只有 `fetch` GET（`:136` 带 `AbortSignal.timeout`），错误路径只抛中文 `Error`。
- **权限没有放宽**：`tests/unit/tools.test.ts:94-105` 断言默认注册表里没有任何 `set_|write|send|delete|control|unlock` 类工具；新增的是**只读查询**，没有引入需要审批的能力。

### 3.6 错误分类保真

- `errors.ts:70-79` 的 `brainErrorCodeFor()` 是**两条路径共用**的映射表；`errors.ts:44/57` 的 `originalCode` 保留原始 provider 码（闭集之外的值仍可落在 `detail`）。
- `dsh.ts:154-162`：harness 边界仍记 `PROVIDER_FAILED`（契约不变），但把真实码放进 `originalCode`，**没有**为了「保真」去改动别人的集成测试。
- 单测逐状态断言（`tests/unit/core/brain-error-classification.test.ts:38-51`）：401/403→AUTH、402→QUOTA、429→RATE_LIMIT、400→BAD_REQUEST、503→PROVIDER_FAILED，并断言 `detail` 保留 `${originalCode}:`。我实跑 → **5/5 pass**；`brainErrorCodeFor('SOMETHING_NEW')` → `{code:'PROVIDER_FAILED', isKnown:false}`（未知码仍然安全降级）。

---

## 4. 复核 verifier（t6）的结论

| verifier 的说法（§2.4 / §8.1） | 我的复核 | 判断 |
|---|---|---|
| 条款 2 **失败**：`engine.state` 是缓存、全仓生产代码从不调用 `engine.tick()`，长停顿后第一句仍被拒；集成测试能过是因为它显式调了 `engine.tick()`（`tests/integration/conversation-engine.test.ts:243`） | **我独立复现成立**：用 `2b2321d` 的引擎跑同一序列，line 2 = `REJECTED_NOT_ADDRESSED`；当前树上同一序列 line 2 被接受 | **准确**，且它的定位（缓存状态 + 零 tick 调用）是根因 |
| 条款 1「经引擎验证 tolerance 1→45000ms、0→15000ms、0.7→36000」 | 我的探针得到同量级结果（0.7→36000、1→45000、0.2→21000）；它那句「0→15000ms」是另一个取值点，与 `30000×0.6` 一致 | **一致** |
| 条款 3「真实 DB 6 行 + 我自造 1 行；payload 只含…无用户原话」 | 我查到**19 条**（之后又跑了几轮），其中 1 条真实拒绝样本 `REJECTED_SUSPENDED`；键集合 11 个、无敏感键 | **一致，且比它当时看到的更多** |
| 条款 6「全仓 grep `SESSION_MISMATCH` → 0 命中；dead-code 测试 4 项断言 BACKCHANNEL/WAIT 无生产者」 | 我复核：代码 0 命中（只剩文档历史叙述）；测试 4 项通过 | **一致** |
| 「KNOWN GAP 用例被移除或改为已修复」 | 我复核：`KNOWN GAP` 在 **测试** 里 0 命中，`docs/design/brain-and-models.md:202/228` 仍以「KNOWN GAP」描述**已修的一行改动**——属文档留痕，不是未修 | **一致（措辞可再明确，见下）** |
| 它把 `--dsh` 自然语言回合列为**未测**（U4） | 我本轮也没有跑（需要交互式 CLI + 真实密钥）；t5 另有一次 `verify:provider` 真机记录 | **没有把未测写成通过** |

**一处可以更精确的地方**：verifier 的条款 2 失败结论写在 **t5 的交付态**上是准确的，但当前工作区已经修好；`docs/verification/field-test-verification-2026-09-30.md` 是**带修订号的快照**，读者若不看修订号会以为今天仍然是坏的。建议在它的 §8.1 F1 条目末尾加一句「**状态**：已由 t19 修复，复现步骤见 `docs/design/conversation.md` §「状态读取即推进」；本条保留为 t5 交付态的判定」。

---

## 5. findings（needs_revision 的依据）

### F1（low）`acceptance_score` 不是分数，是 `accept` 的二值镜像；而契约声明了一个 0–1 的分数字段

- **位置**：`packages/conversation/src/engine.ts:222`
  ```ts
  acceptance_score: acceptance.accept ? 1 : 0,
  ```
  契约：`packages/contracts/schemas/events/conversation.decision.v1.json:26`（`"acceptance_score": { "type": ["number","null"], "minimum": 0, "maximum": 1 }`）；文档：`docs/design/conversation.md` 的 §13/§5 把该字段列为「必要分值」。
- **问题**：FSM 的 `TurnAcceptance`（`packages/conversation/src/fsm.ts:151-163`）**只有** `{accept, reason, state}`，没有任何分值；引擎于是把它映射成 1/0。这是**诚实**的（没有编造一个假分数），但它同时意味着：**(a)** 契约里 `minimum: 0, maximum: 1` 的「分数」语义目前没有任何生产者会产出 0 与 1 之外的值；**(b)** §13 的「接纳度分数」如果在 M2 要做（唤醒词分数 × 说话人相似度 × 语义承接的融合判定），这个字段的**含义会变**，而它是 `conversation.decision.v1` 的字段——按铁律 10 与「已发布契约不可原地改形状」，届时要么新增 v2、要么把这个字段当作「二值化的接受结果」永久定格。
- **影响面**：low（当前没有消费方依赖它做阈值判断；探针与测试只断言它落在 [0,1]）。但它是**契约级**的语义缺口，越早说清越便宜。
- **requiredFix（二选一，都不需要改代码逻辑）**：
  - (a) 在 `conversation.decision.v1.json` 的 `acceptance_score` 上加一句 `"description": "当前为 accept 的二值镜像（1/0）；M2 引入真实接纳度分数前不得当作连续分值消费"`，并在 `docs/design/conversation.md` 的该字段处同样注明；
  - (b) 若认为它就该是二值，把 schema 改成 `"enum": [0, 1]`（或 `type: integer, enum [0,1]`）+ 改名注释，明确「这不是分数」。**注意**：改 schema 属于「改已发布契约的形状」，需要 captain 决定是否走 v2；我倾向 (a)。
- **复现**：`Select-String -Path packages/conversation/src/engine.ts -Pattern "acceptance_score"`；`Select-String -Path packages/conversation/src/fsm.ts -Pattern "TurnAcceptance" -Context 0,6`。

### F2（low，性质上是「留痕/信息」）t5 回应里「集成测试同名断言」在 t5 当时不成立；条款 2 的字面满足实际由 t19 完成

- **位置**：t5 的完成回报第 2 条（`.agent-teams/…/team.json` 的 t5.output）写：「同一引擎+固定时钟…修复后 → 接受(ACCEPTED_WAKE_OR_DIRECT)。复现命令 `npm run chat -- --fake`；**集成测试同名断言**」。
- **问题**：那条集成测试（`tests/integration/conversation-engine.test.ts` 的 `a long pause is noticed without calling tick(): the first line after it is a wake-up, not a rejection`）**是 t19（随 `04c2ddb` 的 `#advance` 一起）才加入的**——它的注释里直接写着「that is the production path (**t19 / t6 F1**)」。在 t5 的交付态上，用 t5 自己的引擎跑同一序列会得到 `REJECTED_NOT_ADDRESSED`（我在 §3.2 用 `2b2321d` 的 `engine.ts` 复现了）。所以那句话把「修复」与「验证」的时间点混在了一起：**修复 `chat.ts` 的那一步是真的（`first` 局部变量 → 按状态传），但它不足以保证条款字面成立**。
- **影响面**：info。这不是功能缺陷（今天已经好了），而是**验证溯源**问题：如果后来有人只读 t5 的回报、不去看 t19，会以为「t5 已经修好并验证了长停顿后的第一句」。项目里已经因为「自述与实测不一致」踩过坑（AGENTS.md §9.10），这里值得留痕。
- **requiredFix（只改文档/回报留痕，1 行）**：在 `docs/design/conversation.md` 已有的「已修（t5）」段落末尾补一句：「**注意**：t5 只把 `addressed` 改成按状态取；当时 `engine.state` 仍是过期缓存，因此 t5 交付态上长停顿后的第一句**依然被拒**——条款字面由 t19 的「读取即推进」完成，回归测试也是 t19 加的」（该段现在已经有 `:104-110` 的历史说明，把「t5 当时**没发现**状态本身是过期的」这句扩到「因此当时该行为仍不成立」即可）。

### F3（low，性质上是「留痕/信息」）t5 回报里的 `npm test 87/87` 是交付态的中间数字，现行是 137/137

- **位置**：t5 的完成回报开头：「…npm test **87/87** 全绿，check:docs OK，verify:provider 真机 OK」。
- **问题**：我的探针复核显示，t5 提交时工作区其实还带着一条由 t12/t14 收尾的用例（t14 的回报写明「修复前 88/87/1」）。**这不是 t5 的错**（87 是它在自己那一步的实测；随后 t14 把 1 条失败用例改写为通过，数量回到 88，再往后 t16/t19/t20/t21… 把总量推到 133/137），但它再次说明「测试数字必须带修订号」——AGENTS.md §9.10 已把这条写成纪律。
- **影响面**：info（无功能影响；只影响读者对「t5 当时绿不绿」的判断）。
- **requiredFix**：无需改代码。**建议** captain 在收尾时把 `docs/progress.md` 里 t5 的条目写成「t5 交付时 87/87（随后 t14 收尾为 88/88；当前 137/137）」，让数字带上时间点。

---

## 6. 我实际跑过的命令与结果（可核账）

| 命令 | 结果 |
|---|---|
| 自写探针（仅经 `ConversationEngine` 公开接口，临时库在 `mkdtempSync` 目录） | 人格 → 窗口：0.7→36000ms、1→45000ms、0.2→21000ms；`engine.silenceTolerance` 分别 0.7/1/0.2（构造时**未**传 `fsm.silenceTolerance`） → §3.1 |
| 同一探针 + `--engine <git show 2b2321d:…/engine.ts>` | **before**：line 2 读到 `LINGERING` → `accepted:false, REJECTED_NOT_ADDRESSED`；**after（当前树）**：line 2 读到 `IDLE` → `accepted:true, ACCEPTED_WAKE_OR_DIRECT` → §3.2 |
| 探针内的拒绝用例 + 事件日志查询 | `REJECTED_NOT_ADDRESSED`/`SILENCE` 落 `conversation.decision`；`recentTurns` 不增加；payload 键 11 个、无敏感键 |
| `node data/t10/db-check.mjs`（只读真库，等价 SQL 见 §3.3） | `data/chat/xixi.sqlite`：`conversation.decision` 19 条、**被拒 1 条 `REJECTED_SUSPENDED`**（confidence 0.5、schema_version 1）；`data/voice/xixi.sqlite`：3 条全 accepted |
| `npm run chat -- --fake`（管道喂两行） | 两轮均 `SPEAK`、`state=LINGERING`、`linger=36000ms 人格=0.7`，无拒绝；启动横幅写明「跟进窗口 36000ms（由人格 silence_tolerance=0.7 缩放）」 |
| `npm test` | **tests 137 / pass 137 / fail 0 / exit 0**（首次跑到 137/134/3，我据 AGENTS.md §9.10 复跑判定为他人半成品窗口，第二次全绿） |
| `npm run check:docs` | 失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0 → **exit 0** |
| `node --test tests/unit/core/brain-error-classification.test.ts` | **5/5 pass**（HTTP 状态分类、共享分类器、网络=TRANSPORT_FAILED、缺密钥本地拒、DSH 保留 originalCode） |
| `node --test tests/unit/core/engine-personality.test.ts` | **5/5 pass**（人格→窗口、无值回落具名默认、同问题两套人格经引擎结果不同、运行时改人格下一轮生效、decision 事件记录产生窗口的人格） |
| 全仓 grep `SESSION_MISMATCH` / `KNOWN GAP` / `STALE` | 代码 0 命中；`KNOWN GAP` 仅存在于 `docs/design/brain-and-models.md:202/228` 的历史叙述 |

**真实 API 调用：0 次**（t5 的 `verify:provider` 真机记录由 t5/verifier 完成；我本轮不需要联网）。**合规说明**：探针只在系统临时目录建库，没有读写 `data/chat/xixi.sqlite`（只读查询）或任何别的真实库；`data/t10/` 与仓库外的 `E:\worker2-data\` 临时对照目录**已全部删除**（`git status` 里属于我的只有本文件）。

---

## 7. 结论表

| # | 维度 | 判定 |
|---|---|---|
| 1 | t5 七条验收标准 | **7 条在当前工作区成立**；条款 2 的实际修复含 t19 的「读取即推进」（F2 留痕）；条款 3 的 `acceptance_score` 有语义缺口（F1） |
| 2 | silence_tolerance「经由引擎真实生效」 | **证实**：人格 0.7/1/0.2 → 36000/45000/21000 ms，探针未传任何 FSM 参数 |
| 3 | CLI 缺陷（前后对比） | **已修**：`2b2321d` 引擎 line 2 被拒 → 当前树 line 2 被接受；真机 `chat --fake` 无拒绝 |
| 4 | 可审计性 | **成立**：真库有 `REJECTED_SUSPENDED` 样本；payload 11 键、无用户原话/模型推理；拒绝轮次不进历史；接受路径在 finally 也落一条 |
| 5 | 契约纪律 | **成立**：新增 v1 schema、注册表 + envelope enum 同步、有漂移测试、未改已发布 schema 形状、`schema_version` 仍 1 |
| 6 | DSH 天气工具 | **成立**：只读、参数封闭（含运行前校验）、与直连同数据源与缓存，未放宽权限 |
| 7 | 错误分类保真 | **成立**：共用 `brainErrorCodeFor()` + `originalCode`；逐 HTTP 状态断言；5/5 pass |
| 8 | 死码与语义诚实 | **成立**：`SESSION_MISMATCH` 0 命中；BACKCHANNEL/WAIT「无生产者」由测试固化 |
| 9 | inScope 纪律（本任务重点之一） | **干净**：t5 的 `changedPaths` 21 条**全部**落在声明范围内；报告里主动披露了「越界的 `packages/model-adapters/src/mimo.ts` 与 `tests/integration/brain-adapter.test.ts` 已还原」（我核对它们确实不在 changedPaths 里） |
| 10 | 环境门禁 | 我自己复跑：`npm test` 137/137、`check:docs` exit 0、错误分类 5/5、人格 5/5 |

**总判定：needs_revision**。六项修复我判为**真实可信、可以放行**；需要处理的是 **F1**（`acceptance_score` 在契约里声明为 0–1 分数、实现却是 1/0 镜像——加一句 description 或明确二值，避免 M2 引入真分数时被迫改已发布契约）与 **F2**（t5 回报「集成测试同名断言」在 t5 交付态不成立，条款字面由 t19 完成——建议在 `docs/design/conversation.md` 已有的历史段里补一句，别让后人以为 t5 单独修好了长停顿后的第一句）。F3 只是提示数字要带修订号，无需改代码。
