# V0.3 Phase 0：真实运行时地图（ACTUAL_RUNTIME_MAP）

> 最后更新：2026-10-10（V0.3 **D1**：§3c 的 Reminder 行从「到点由主动循环说出来仍未接」改成**已接线**——
> 两个 live 入口各有一行 `...runtime.reminderSeams` 与一行 `readPluginTopics`，复核命令**必须带排除项**
> `':!scripts/verify-p2-5.ts'`；§1/§2/§3b 的历史快照**原样保留**）
> 上一版：2026-10-08（V0.3 **P2.5 收口**：新增 §3c——只覆盖 §3b 里那三行「入口未接线」的现状与复核命令；
> §1/§2 的 P0 基线与 §3b 的 P2 快照**原样保留**）
> 上一版：2026-10-04（V0.3 **P2 收口 t15**：新增 §3b「P2 收口后的状态更新」——Provider 三接口、插件内核、MCP、审批、News、Reminder 逐条给现状与复核命令；
> §1 的「四个内置」改成三个、§2 第 14 条的 MCP 口径改成「已交付但未接入任何 live 入口」。§1/§2 的历史基线保留不动）
> 权威来源：**当前代码与测试**（`git grep` 实测）。pack 文档（`E:\xixi_v03_actual_code_pack\docs\*.md`）是设计意图，与本文冲突时以本文为准。
> 基线修订号：`d3a89166cbbcc90077a799781175528415b8c906`（§2 的实测都在这个基线上做；**§1 / §3 已在 `59cd65a` 上按 P0 落地后的实况复核过**）。**基线之上另有一次提交 `4f3301f`（t2 修 `SpeechPipeline` B2），它只碰 `services/voice-edge/voice_edge/voice_stream.ts` 与 `tests/unit/voice/voice-stream.test.ts`，不改本文任何一行的定义处/调用点**——即表中关于「voice helpers 与 `SpeechPipeline` 在哪、被谁调」的结论在 `4f3301f` 上同样成立，但 **B2 缺陷本身已被修掉**（`00_CODE_AUDIT.md` §3.15 描述的旧行为不再是现状）。本文避免引用行号，就是为了让这类提交不影响可核对性。
> 复核方式：每一行的 `current caller(s)` 都能用该行给出的**一条** `git grep` 复现。仓库 grep 在 `D:\Git\usr\bin\grep.exe`（本机 PATH 上没有 `grep`，见 `AGENTS.md` §4）。

本文要回答的问题只有一个：

> **pack 说的那些「在 field-test.ts 里 / 各入口各一份」的东西，在今天的代码里到底在哪、被谁调、下一步搬到哪。**

它不描述期望架构。**没写进本文的迁移都还没做。**（P0-A/B/C/D 落地之后，§1 的 `target package` 与 `migration step` 两列已按实况更新：Step A/B/C 全部已落地，兼容 re-export **仍在**，见 §1 与 §3。）

---

## 0. 怎么用这份表

1. `current file(s)` 是**定义处**，`current caller(s)` 是**调用点**。两者分开写，因为「定义了没人调」与「多处各自实现一份」是两类不同的问题（前者在下面「审计核对」里出现过）。
2. 每行的**复核命令**是一条可以整行复制的 `git grep`。它默认会连 `docs/` 一起搜——那是故意的：调用点变了但文档没跟上，也能从同一条命令里看出来。
3. `target package` 里的 `packages/runtime/*` 目前**不存在**（`Test-Path packages/runtime` 为 False），所以它在本文里一律不加反引号——本仓 `check:docs` 会把反引号里的仓库路径当「应该存在的文件」检查（见 `scripts/check-docs.ts` 的 `REPO_PATH`）。
4. 迁移按 pack `04_RUNTIME_CONSOLIDATION.md` 的 Step A/B/C 走：**先在新包落地实现，`scripts/field-test.ts` 原处改成 re-export**，调用方一行不改；然后逐个把 import 改成新包；最后删掉 re-export。每一步都要 `npm test` 全绿再走下一步。

---

## 1. 十个概念的运行时地图

| concept | current file(s) | current caller(s)（复核命令） | target package | migration step |
|---|---|---|---|---|
| `buildToolChain` + `CONVERSATION_SCOPE` | 定义：**`packages/runtime/src/tool-runtime.ts`**（`export function buildToolChain`、`export const CONVERSATION_SCOPE`、`ToolChainOptions`；V0.3 P0-A Step A 已落地）。`scripts/field-test.ts` **只保留兼容 re-export**（同一个声明，不是副本；由 `tests/console/live-entry-tool-chain.test.ts` 的 identity 断言钉住）。真正建号的是 `packages/brain-adapter/src/tool-registry.ts` 的 `createToolRegistry`（`buildToolChain` 只是把配置摊平成它的入参） | 调用点：`scripts/field-test.ts`（控制台的文字轮与语音轮共用一条链）、`scripts/serve-chat.ts`、`scripts/chat.ts`、`scripts/voice-turn.ts`、`scripts/voice-device-check.ts`、`scripts/eval-conversation.ts`、`scripts/eval-realism.ts`——**7 个入口现在都 import `@xixi/runtime`**；`tests/console/live-entry-tool-chain.test.ts` 仍从 `scripts/field-test.ts` 取，正是为了守住兼容 re-export。四个内置工具在 `packages/brain-adapter/src/tools.ts`（**V0.3 P2-D 起是三个**：`xixi_get_current_time` / `xixi_get_weather` / `xixi_set_reminder_stub`；`xixi_news_stub` 已从注册路径删除，新闻改由 `packages/plugins/news/` 的三个插件工具提供——**插件工具不在入口里**，因为入口还没走 `buildPluginRuntime`，见 §4）。<br>复核：`git grep -n -- 'buildToolChain'`、`git grep -n -- 'CONVERSATION_SCOPE'`、`git grep -n -- "@xixi/runtime"`、`node scripts/chat.ts --print-wiring` | ✅ 已落到 packages/runtime/src/tool-runtime.ts（Step A） | ① 已把 `buildToolChain` 与 `CONVERSATION_SCOPE` 搬进新文件，`field-test.ts` 兼容 re-export 未删；② `npm test` 与四个入口 `--print-wiring` 逐字段对照已跑（见 `docs/testing.md` 的 `--print-wiring` 行）；③ 7 个调用方的 import 已全部指向新包；**re-export 要等 Step B/C 与下游全部迁完再删**（pack `01_ARCHITECTURE.md` §3 的纪律） |
| `ProactiveLoop` + 候选构造器 | 定义：**`packages/runtime/src/proactive-runtime.ts`**（V0.3 P0-A Step B 已落地：`export class ProactiveLoop`、`ProactiveLoopOptions`、`ProactiveLoopEntry`、`buildProactiveCandidates`、`lastUserTurnAt` 都在那里；`scripts/field-test.ts` 只剩别名导出）。`tickOnce` 是循环的 tick；评分与硬底线仍在 `packages/conversation/src/proactive.ts` | 调用点：`scripts/field-test.ts`（控制台的常驻考虑循环）、`scripts/serve-chat.ts`；评测 `scripts/eval-proactive-timeline.ts`（跨天回放直接 `new ProactiveLoop`）；测试 `tests/console/proactive-loop.test.ts`、`tests/console/proactive-open-thread-loop.test.ts`、`tests/integration/open-thread-followup.test.ts`。<br>复核：`git grep -n -- 'ProactiveLoop'`、`git grep -n -- 'buildProactiveCandidates'`、`git grep -n -- 'lastUserTurnAt'` | packages/runtime/src/proactive-runtime.ts（Step B） | ① 循环 + 候选构造器一起搬（它们互相引用，分开搬会造出双向依赖）；② `field-test.ts` re-export；③ 先改 `scripts/eval-proactive-timeline.ts`（它只 import `ProactiveLoop`，是风险最小的第一个调用方），再改两个 live 入口 |
| `createModelComposer` | 定义：**`packages/runtime/src/proactive-runtime.ts`**（V0.3 P0-A Step B 已落地；`scripts/field-test.ts` 只剩别名）。内部用 `engine.buildPrompt({ …, addressed: true })` 伪装成用户轮——pack 的 `00_CODE_AUDIT.md` §3.13 说的就是这里 | 调用点：`scripts/field-test.ts`（控制台 `compose` 接缝）、`scripts/serve-chat.ts`（试用页 `compose` 接缝）；测试 `tests/console/unbacked-facts-console.test.ts`。<br>复核：`git grep -n -- 'createModelComposer'` | packages/runtime/src/proactive-runtime.ts（Step B） | ① 与 `createModelComposer` 同批搬；② 搬完**不要**顺手改 prompt 语义——`PromptMode`（不再伪装 user turn）是 pack Phase 3 的事，现在改会把 Phase 0 的「只搬家不改行为」搅在一起 |
| `createModelDecider` | 定义：**`packages/runtime/src/proactive-runtime.ts`**（V0.3 P0-A Step B 已落地；`scripts/field-test.ts` 只剩别名）。P5「读空气」：底线之上由模型决定开不开口 | 调用点：**只有 `scripts/field-test.ts` 自己**（`decide:` 接缝，`ProactiveLoop` 的选项）。`scripts/serve-chat.ts` 只 import 了 `createModelComposer`，**没有** import 它。<br>复核：`git grep -n -- 'createModelDecider'` | packages/runtime/src/proactive-runtime.ts（Step B） | ① 与 composer 同批搬；② 「试用页是否也该有模型决策接缝」是 pack Phase 3 的问题（现在试用页的主动路径与控制台并不等价），Phase 0 只搬家、不改接线；③ 搬完检查 `serve-chat.ts` 的 import 列表没有被误加 |
| voice helpers | 定义（TS，三处）：**`packages/runtime/src/voice-runtime.ts`** 的 `planSpeechSegments` / `buildSpeechAudio`（V0.3 P0-A Step C 已落地；`scripts/field-test.ts` 只剩别名）；`services/voice-edge/voice_edge/voice_stream.ts` 的 `SpeechPipeline` / `ClauseChunker` / `AssentBank` / `XIXI_PLAYBACK_JS`（流式切块→TTS 队列→播放时钟，**仍留在原地**，归属与 P4 常驻 AudioEdge 一起定）；`packages/conversation/src/segments.ts` 的 `ClauseChunker`（切块规则本体）。Python 侧前端在 `services/voice-edge/voice_edge/frontend.py` | 调用点：`scripts/voice-turn.ts`（`planSpeechSegments` + `buildSpeechAudio` + `SpeechPipeline`）、`scripts/field-test.ts`（`SpeechPipeline`、`handleVoiceTurn`）、`scripts/serve-chat.ts`（`AssentBank` / `XIXI_PLAYBACK_JS` / `XIXI_PLAYBACK_THRESHOLDS` + 从 field-test 转出的 `handleVoiceTurn` / `segmentPlan`）；测试 `tests/console/field-test-console.test.ts`、`tests/unit/voice/voice-stream.test.ts`。<br>复核：`git grep -n -- 'buildSpeechAudio'`、`git grep -n -- 'planSpeechSegments'`、`git grep -n -- 'SpeechPipeline'`、`git grep -n -- 'handleVoiceTurn'` | packages/runtime/src/voice-runtime.ts（Step C） | ① Step C 只覆盖 `planSpeechSegments` / `buildSpeechAudio` / `handleVoiceTurn` 这类**共享缝**；② `voice_stream.ts` 不是「field-test 的代码」，它是 **Python 服务目录里的 TS**，被 `field-test.ts` / `voice-turn.ts` / `serve-chat.ts` 反向 import——它的归属要与 P4（常驻 AudioEdge）一起定，Phase 0 不动它；③ `packages/conversation/src/segments.ts` 的 `ClauseChunker` 留在原地（它已经是包内代码） |
| Memory extractor | 定义：`packages/conversation/src/extractor.ts`（`export class TurnMemoryExtractor`，`runJob` 里做反馈解释 → relationship note / episodic / semantic 写入 + 未完话题）。它**已经在包里**，不在 `scripts/` | 调用点：`scripts/field-test.ts`、`scripts/serve-chat.ts`（各自 `new TurnMemoryExtractor({ store, selfModel, memory, onError })`，并通过 `ConversationEngine` 的 `afterTurn: (job) => extractor.enqueue(job)` 接线）。**`scripts/chat.ts` 与 `scripts/voice-turn.ts` 没有 `afterTurn`**（`new ConversationEngine({ adapter, store, config, … })`），所以这两个入口不写记忆。<br>复核：`git grep -n -- 'TurnMemoryExtractor'`、`git grep -n -- 'afterTurn'`、`git grep -n -- 'new ConversationEngine'` | 留在 `packages/conversation`（P1 只加 `MemoryRetriever`，不重写写侧） | ① P0 不搬它；② P1 的「三入口 afterTurn」是把 `chat.ts` / `voice-turn.ts` 补上接线（`docs/handoff.md` 已记为已知缺口），不是搬家；③ 补接线时注意 `data/voice` 与 `data/chat` 是两个库——「统一 store」是 P0-0B 的前置 |
| Memory store / relationship snapshot | 定义：`packages/domain/src/memory.ts`（`export class MemoryStore`；`snapshot()` 产 `RelationshipSnapshot`，含 `proactiveAcceptRate` 等）。表在 `packages/domain/src/migrations/004_memory.sql`；`open_threads` 在 `003_open_threads.sql` | 实例化：`scripts/field-test.ts`、`scripts/serve-chat.ts`（都只把它**交给 extractor 写**）；测试 `tests/integration/memory-feedback.test.ts`、`tests/unit/domain.test.ts`。**`MemoryStore.snapshot()` 在生产入口没有任何调用方**——`git grep -n -- '\.snapshot('` 的命中只有 `ConversationEngine.snapshot()`（FSM）与 `scripts/chat.ts` 的调试打印。<br>复核：`git grep -n -- 'class MemoryStore'`、`git grep -n -- '\.snapshot('`、`git grep -n -- 'new MemoryStore'` | 留在 `packages/domain`（P1 由 `MemoryRetriever` / `ContextBuilder` 消费） | ① 保留 `XixiStore` 与 `MemoryStore`，不重造；② P1 把 `snapshot()` 接进关系上下文（消费点目前为零）；③ 记忆召回必须先过 audience/visibility 过滤，再进 prompt（pack 硬规则） |
| canonical store（P0-B 之前叫「current DB dirs（各入口各自的库）」） | 定义：`packages/domain/src/store.ts` 的 `CANONICAL_DATA_DIR = 'data/xixi'`、`CANONICAL_DATA_DIR_ENV = 'XIXI_DATA_DIR'`、`resolveCanonicalDataDir()`、`CANONICAL_STORE_ENTRIES`；**household 入口不再各拼路径**——它们都走 `resolveCanonicalDataDir()`，默认就是同一个库（`data/xixi`）。入口清单本体仍是 `XIXI_DB_ENTRIES`（`scripts/field-test.ts`），但它现在从 `CANONICAL_STORE_ENTRIES` 生成，不再手写第二份 | 读的人：控制台与试用页都把 `XIXI_DB_ENTRIES` 渲染成「本页用哪个库」区块（`databaseNoteHtml`），并用 `readPresence` 读**主库**（P0-B：`presenceDataDir` 默认＝主库）。评测脚本按设计用临时库（`mkdtempSync`）：`scripts/eval-conversation.ts`、`scripts/eval-realism.ts`、`scripts/eval-proactive-timeline.ts`。<br>复核：`git grep -n -- 'resolveCanonicalDataDir'`、`git grep -n -- 'CANONICAL_STORE_ENTRIES'`、`git grep -n -- 'XIXI_DATA_DIR'`、`git grep -n -- 'XIXI_CHAT_DATA_DIR'` | **已落地**：新默认 `XIXI_DATA_DIR` → `data/xixi`（P0-0B，t6；t17 修掉「页面 note 与事实相反」） | ① 环境变量与默认值已加，四个 household 入口默认指向同一库（硬证据：同一个库文件里同时有 `source=chat` 与 `source=field-test` 的 `system.health`）；② `XIXI_CHAT_DATA_DIR` / `XIXI_WEB_DATA_DIR` 等旧变量保留为「测试/并行实例」缝，优先级低于 `XIXI_DATA_DIR`；③ `data/` 下早期库 `data/xixi.sqlite` **未被覆盖**（时间戳仍是 2026-10-03）；④ `XIXI_DB_ENTRIES` 与两个页面的文案已从 `CANONICAL_STORE_ENTRIES` 生成，「四个入口各用不同数据库」这句话已从 `docs/README.md` 与 `docs/architecture.md` 删掉 |
| perception DB（在场投影） | 定义：**V0.3 P0-B 已收成单写者**——Python 侧 `services/perception-edge/perception_edge/` 只做检测并把事件**打印到 stdout**（不再接受 `--db` / `--append`）；Node 侧 `packages/runtime/src/perception-ingest.ts` 的 `ingestPerceptionLine` 校验后交给 `XixiStore.appendPresenceEvent`（事件 + `world_state` 投影**同一事务**，写进**主库**）。控制台读的就是主库（`presenceDataDir` 默认＝主库） | 写入者：**只有 Node 侧一处**（`appendPresenceEvent`）；子进程由 `scripts/field-test.ts` 的 `createPerceptionLiveRunner` 拉起，但**不再拿库路径**（接口删掉 `presenceDbPath`，两个测试钉住 `gotDbPath=false`）。读取者：`readPresence`（`packages/runtime/src/proactive-runtime.ts`），被控制台与 `scripts/serve-chat.ts` 调用（各自读自己的那个库）；验收脚本 `scripts/verify-camera-presence.ts`。<br>复核：`git grep -n -- 'presenceDataDir'`、`git grep -n -- 'presenceDbPath'`、`git grep -n -- 'readPresence'`、`git grep -n -- '--append'` | **已落地**：合并进 canonical `XixiStore`（P0-0B），单写者 | ① **两库分裂已收掉**：控制台主库与在场投影现在是同一个库（`data/xixi`）；② Node 侧是唯一写者（本地 ingest），Python 不再直写任何库；③ 子进程「没建表就不写」这条约束不再需要——它已经不写库了（真探针：`python -m perception_edge.run --source synthetic --seconds 1` 不带 `--db` 得到 3 条 `presence.changed` 且 `appended_to_db` 为 0） |
| prompt builder | 定义：`packages/conversation/src/prompt.ts`（`PromptAssembler.assemble`、`HARD_POLICY`、段名 `core-identity` / `safety-policy` / `effective-style` / `world-state` / `current-turn`）；喂它的是 `packages/conversation/src/engine.ts` 的 `buildPrompt`（只传 `personality` / `worldStateLite` / `conversationState` / `history` / `mood`） | 调用点：`ConversationEngine.respond()`（生产轮次）、`scripts/chat.ts`（`--print-wiring` 外的预览路径）、`scripts/field-test.ts` 的 `createModelComposer` / `createModelDecider`（主动路径，伪装成 user turn）、测试 `tests/integration/mood-state.test.ts`、`tests/unit/core/chat-personality-args.test.ts`。<br>复核：`git grep -n -- 'buildPrompt'`、`git grep -n -- 'HARD_POLICY'`、`git grep -n -- 'workingMemory'` | P1 新增 `ContextBuilder`（pack `02`），`prompt.ts` 仍是渲染层 | ① P0 **不动**它；② P1 把 context 的来源从引擎内联改成 `ContextBuilder` 输出（recentTurns / memories / relationship / openThreads / world / self / mood）；③ `HARD_POLICY` 里「可核查的具体事实只能来自工具结果或对方刚刚明确说的信息」这句是 P1 可信记忆的冲突点（见 §3 第 9 条）——改它属于 P1，不属于 P0 |
| DSH 与 direct providers | 定义：`packages/brain-adapter/src/mimo.ts`（`MimoBrainAdapter`，直连 MiMo，流式 + 图片 + `AgentLoop`）、`packages/brain-adapter/src/dsh.ts`（`DshBrainAdapter`，DSH CLI/profile，不接受图片）、`packages/brain-adapter/src/agent-loop.ts`（工具循环）、`packages/brain-adapter/src/tool-registry.ts`（`createToolRegistry`）；DSH 侧工具插件 `plugins/xixi-tools/index.js`（只注册时间 + 天气）；DSH profile 在 `apps/brain-dsh/profile/cordis.patch.yml` | 选择点：`scripts/chat.ts`（`--dsh`）、`scripts/serve-chat.ts`（`--dsh`）、`scripts/field-test.ts`（`useDsh`）、`scripts/eval-conversation.ts`（`--dsh`）、`scripts/verify-m0.ts`。**默认都是 direct**：`--dsh` 是显式开关（`scripts/serve-chat.ts` 的 `USE_DSH = args.includes('--dsh')`）。图片路径：`DshBrainAdapter` 在收到 `input.images` 时直接 `BAD_REQUEST`，`MimoBrainAdapter` 会带上图片。<br>复核：`git grep -n -- 'DshBrainAdapter'`、`git grep -n -- 'MimoBrainAdapter'`、`git grep -n -- 'useDsh'` | 留在 `packages/brain-adapter`；**P2-F 已落地**（三接口：`TurnModelProvider` 必须 / `MultimodalTurnProvider` 与 `StructuredInferenceProvider` 可选，见 §4） | ① P0 只**记录**漂移，不改接口；② 硬规则：DSH 不得成为 realtime 默认（现在是显式 `--dsh`，保持）；③ 那四个方法**已在 P2-F 从接口与三个实现里移除**（不是留着抛异常），`NOT_IMPLEMENTED` 今天没有生产者——口径见 §4 与 [ADR-0020](../adr/0020-provider-three-interfaces-and-mcp-deps.md) |

---

## 2. 与 pack `00_CODE_AUDIT.md` 的逐项核对

pack 的审计基于 2026-10-03 上传的 zip 快照；下面是**同一个基线**上的复核结果。格式：

> **审计结论 vs 实测** —— 证据（一条可复跑的命令）

结论分三类：**一致**（审计对）、**偏差**（结论方向对但细节与代码不符）、**未复核完**（需要单独追的条目；本次 15 条里没有，第 12 条一度被我误判为这一类，复核后归入「一致」）。

审计里与本文十概念直接相关的条目，逐条如下（编号照抄 pack 审计的章节号，方便两边对照）。**范围声明**：本文不代替 P0-0E 的缺陷核实——审计 §3.6（ToolRegistry 不是 Plugin Runtime）、§3.7（`ask` 没有 resume）、§3.10（视觉链路分裂）、§3.12/§3.14（synthetic score、语音未统一）、§3.16（首音目标）几条**没有**逐字复核，它们属于各自的 Phase 与缺陷批次，别把本文当作它们的结论。

先给一张「本文哪个概念 ↔ 审计哪几节」的对照表，省得两头翻：

| 概念（§1 的行） | 对应本文 §2 的条目 |
|---|---|
| `buildToolChain` + `CONVERSATION_SCOPE` | 1、2、11 |
| `ProactiveLoop` + 候选构造器 | 3 |
| `createModelComposer` | 3、10 |
| `createModelDecider` | 3、10 |
| voice helpers | 13、0E（§3） |
| Memory extractor | 6、7 |
| Memory store / relationship snapshot | 7、8、9 |
| current DB dirs | 4、13 |
| perception DB | 5、12 |
| prompt builder | 7、9 |
| DSH 与 direct providers | 11、14 |

**逐条：**

1. **§3.4「`scripts/field-test.ts` 约 420KB」——一致。**
   实测 `scripts/field-test.ts` 为 **420,451 字节 / 7,581 行**。`scripts/` 下有 **7 个**文件反向 import 它（`chat.ts`、`serve-chat.ts`、`voice-turn.ts`、`voice-device-check.ts`、`eval-conversation.ts`、`eval-realism.ts`、`eval-proactive-timeline.ts`），`tests/` 下有 **14 个**（含 `tests/console/live-camera-fixture.ts` 这个夹具）。
   命令：`git grep -l -- "from './field-test.ts'" -- 'scripts/*.ts'`、`git grep -l -- "from '../../scripts/field-test.ts'" -- 'tests/**/*.ts'`

2. **§3.4「`scripts/chat.ts` import `buildToolChain`」——一致**（`scripts/chat.ts` 从 `./field-test.ts` 只取 `CONVERSATION_SCOPE` 与 `buildToolChain` 两个符号）。
   命令：`git grep -n -- 'buildToolChain'`、`git grep -n -- "from './field-test.ts'"`

3. **§3.4 / 完成度矩阵「`scripts/serve-chat.ts` import `ProactiveLoop` / `createModelComposer`」——一致，但审计写漏了一个。**
   `serve-chat.ts` 确实 import 这两个，**但它没有 import `createModelDecider`**；`createModelDecider` 的定义与唯一调用点都在 `field-test.ts`。
   **审计结论 vs 实测**：审计把 `createModelComposer` / `createModelDecider` 并列成同一类「被 serve-chat 反向 import」，实测只有前者成立。
   命令：`git grep -n -- 'createModelDecider'`、`git grep -n -- 'createModelComposer'`

4. **§3.5「一个西西被拆成多个 SQLite 孤岛：chat / web / voice / field-test / presence」——方向一致，细节过期。**
   实测 live 入口的库目录是 **5 个**（`data/chat`、`data/web-chat`、`data/voice`、`data/field-test`、`data/voice-device`），入口清单本体 `XIXI_DB_ENTRIES` 里写的是 **5 行**（第 5 行是 `npm run demo:m0:text` → `data/demo`），而它的文档注释与页面文案仍写「四个入口」；`data/` 在磁盘上确实存在一个历史库 `data/xixi.sqlite`（在场投影路径）。
   **审计结论 vs 实测**：审计的「四个 DB」在计数上已经过期（最少 5 个，另加 `data/` 与 `data/demo`）。
   命令：`git grep -n -- 'XIXI_DB_ENTRIES'`、`git grep -n -- 'openXixiStore'`、`git grep -n -- 'XIXI_CHAT_DATA_DIR'`

5. **相机架构图「`services/perception-edge` → … → 独立 SQLite `world_state(presence.home)`」——一致。**
   但要说清是哪两个库：控制台自己开 `data/field-test/`（主库），同时**再开一个** `data/`（`presenceDataDir`，见 `getPresenceStore`）去读在场投影；试用页同样固定读 `data/`（`presenceStorePath`，每次读时新开一次）。子进程拿到的 `--db` 就是**那个在场库的文件**（`presenceDbPath` → `getPresenceStore().dbPath`），于是 Python 与 Node 都在写它；而控制台的事件日志、人格、记忆在主库——一次「启用摄像头」把两套库同时牵扯进来。这正是 P0-0B 要收掉的分裂。
   命令：`git grep -n -- 'presenceDataDir'`、`git grep -n -- 'presenceDbPath'`、`git grep -n -- 'readPresence'`、`git grep -n -- 'presenceStorePath'`

6. **§3.1「`TurnMemoryExtractor` 真正会写」——一致。**
   实现在 `packages/conversation/src/extractor.ts` 的 `runJob`：反馈解释、relationship note、episodic、semantic，以及未完话题的更新；写侧 API 在 `packages/domain/src/memory.ts`。
   命令：`git grep -n -- 'TurnMemoryExtractor'`、`git grep -n -- 'runJob'`

7. **§3.1「`ConversationEngine.buildPrompt()` 只传 personality / worldStateLite(time…) / workingMemory(last 8) / mood」——基本一致，漏了一项。**
   实测传的是 5 组：`personality`、`worldStateLite(at, timezone, offsetMinutes)`、**`conversationState`（`#advance(at)` 的结果，含 FSM 状态与追问窗口）**、`history: workingMemory(sessionId)`、`mood`；外加 `identityName` / `turnIndex` / `userText` / `language`。
   **审计结论 vs 实测**：审计的清单漏了 `conversationState`（它不是「记忆类」输入，所以结论方向没错，但清单不完整）。`last 8` 也确实是默认值：`ConversationEngineOptions.historyLimit ?? 8`（`workingMemory` 用它调 `store.recentTurns`）。
   命令：`git grep -n -- 'buildPrompt'`、`git grep -n -- 'historyLimit'`、`git grep -n -- 'workingMemory'`

8. **§3.3「`MemoryStore.snapshot()` 基本无生产消费点」——一致，且可加强为「零」。**
   `git grep -n -- '\.snapshot('` 在生产代码（`packages/*/src` 与 `scripts/`）里只命中 `ConversationEngine.snapshot()`（FSM 状态，`FSM.snapshot`）与 `scripts/chat.ts` 的调试打印；`MemoryStore` 在 `field-test.ts` / `serve-chat.ts` 里只被构造后**交给 extractor 写**，`snapshot()` 没有任何调用方——**`git grep -n -- 'memory.snapshot'` 全仓零命中**，而它的定义（`packages/domain/src/memory.ts` 的 `snapshot(now, windowDays)`）在测试 `tests/integration/memory-feedback.test.ts` 与 `tests/unit/domain.test.ts` 里也没被调用。
   命令：`git grep -n -- '\.snapshot('`、`git grep -n -- 'class MemoryStore'`、`git grep -n -- 'memory.snapshot' || true`（最后一跳就是「零命中」本身，注意 `git grep` 无命中时退出码是 1）

9. **§3.2「HARD_POLICY 现在会阻止未来自然使用长期记忆」——一致；引文措辞有小偏差。**
   审计引用的是「日程、别人说过的话等，只能来自工具结果或『对方刚刚明确说的信息』」；代码里的原句是：
   > 可核查的具体事实——天气、气温、降水概率、风力、空气质量、新闻、日程、别人说过的话——只能来自工具结果或对方刚刚明确说的信息。
   **审计结论 vs 实测**：两边是同一句、同一含义，但审计把列举项缩减成了三个；引用时请以 `HARD_POLICY` 原文为准（行号会漂移，用 `git grep -n -- 'HARD_POLICY'` 定位）。
   命令：`git grep -n -- 'HARD_POLICY'`

10. **§3.13「`createModelComposer` / `createModelDecider` 都调用 `engine.buildPrompt({ text: directive, addressed: true })`」——一致。**
    实测两处调用都在 `scripts/field-test.ts`，两处都传 `addressed: true`（`createModelDecider` 那处还传 `at`）。同时要修正上面的第 3 条：这两个函数都定义在 `field-test.ts`，但**被 serve-chat import 的只有 composer**。
    命令：`git grep -n -- 'addressed: true'`、`git grep -n -- 'createModelDecider'`

11. **§3.8「DSH：只有 time/weather；四个方法 NOT_IMPLEMENTED」——一致。**
    `DshBrainAdapter` 的 `evaluateProactiveCandidate` / `interpretFeedback` / `extractMemories` / `reflect` 全部走 `notImplemented(...)`；DSH 侧工具插件 `plugins/xixi-tools/index.js` 只注册时间与天气（直连路径的 `packages/brain-adapter/src/tools.ts` 有 4 个，其中 news / reminder 是 stub）。**这两条不能混为一谈**：审计的「4 tools」说的是直连路径，「只有 time/weather」说的是 DSH 插件。
    命令：`git grep -n -- 'NOT_IMPLEMENTED'`、`git grep -n -- "name: 'xixi_"`

12. **§3.9「`recordPresenceChanged()` 默认 `actor: input.actor ?? 'father'`」——一致，实测两边都成立。**
    定义在 `packages/domain/src/store.ts` 的 `recordPresenceChanged`，里面就是 `actor: input.actor ?? 'father'`；Python 感知边另有一份：`services/perception-edge/perception_edge/contracts.py` 的 `PresenceEventInput.actor` 默认值同样是 `"father"`——也就是说**两条写入路径都在没有身份证据时把在场者写成父亲**。审计的方法名与方法体都对得上。
    命令：`git grep -n -- 'recordPresenceChanged'`、`git grep -n -- "input.actor ?? 'father'"`、`git grep -n -- 'actor' -- services/perception-edge/perception_edge/contracts.py`（实测命中 `actor: str = "father"`）

13. **完成度矩阵「Replay ⛔ `tests/replay/` 为空 / Typecheck ⛔ 无 tsconfig」——一致。**
    `Test-Path tests/replay` 为 **False**（目录不存在，不是「空目录」），`git ls-files` 里没有任何 `tsconfig*`，`package.json` 也没有 `check:types`；但 `npm test` 的 glob **已经包含** `"tests/replay/**/*.test.ts"`——P0-0D 建目录后无需再改 `package.json`。
    命令：`Test-Path tests/replay`、`git ls-files | Select-String tsconfig`、`git grep -n -- 'tests/replay'`、`git grep -n -i -- 'mcp' -- '*.ts' || true`（零命中，见第 14 条）

14. **完成度矩阵「PluginManager / MCP host ⛔ 未实现」——基线时一致（**`d3a8916` 上成立**），P2 之后已不成立，见下面的更新。**
    **基线实测**：生产代码里没有 MCP client/host：`git grep -n -i -- 'mcp' -- '*.ts'` **零命中**（`*.ts` 退出码 1 是预期结果）；全仓命中只有三处，都是配置或文档——`apps/brain-dsh/profile/cordis.patch.yml` 里 DSH 自带的插件 `mcp-resources`、`docs/design/security-and-privacy.md` 对它的引用、方案原文的扩展点清单。
    **P2 更新（2026-10-04，t15 落笔）**：**MCP 客户端适配器已交付**（`packages/plugins/mcp/`，SDK v2，`discover → normalize → 命名空间 → ToolRegistry`），
    插件内核（manifest / 五能力 / 九步生命周期）也已交付。**但没有任何 live 入口配置过 MCP 服务器**：
    `git grep -n 'mcpServers\|createMcpPlugin' -- scripts` **零命中**，`buildPluginRuntime` 只在 `scripts/probe-tools.ts` 里被调用。
    所以正确口径是**「MCP 已交付但未接入任何 live 入口」**，能跑的证据是 `buildPluginRuntime → start → mount → definitionsForRound / execute`
    那一段装配点（测试里用 SDK v2 的真 client + 真 server 走 `InMemoryTransport`），**没有对真实外部/远程 MCP 服务器的验证**。
    命令：`git grep -n -i -- 'mcp' -- 'packages/plugins'`、`git grep -n -- 'mcpServers' -- scripts`、`git grep -n -- 'buildPluginRuntime' -- scripts`

15. **§4「审计容器 Node v22.16.0，跑不了 `.ts`」——环境说明，与代码无关，但结论要记住：**
    本机是 Node 24（`node --version`），`npm test` 的项数以**实跑输出**为准，不要引用审计里的 `473 tests`。
    命令：`node --version`、`npm test`

**一句话总结**：审计的**方向全部成立**（field-test 是隐藏 runtime、记忆只写不读、多库孤岛、DSH 旁路、Replay/Typecheck 缺失、presence 默认 actor=father），**有 4 处细节与今天的代码不符**：3 处是「清单不完整 / 计数过期」（第 3、4、7 条），1 处是引文缩减（第 9 条）。这 4 处在派工时要么按本文修正，要么明确标注「以代码为准」。

**一条给自己人的提醒**（本次差点写错）：判断「某符号全仓有没有命中」时，**不要把它塞进带 `if`/管道/多条命令拼起来的 PowerShell 一行里**——本次第 12 条就是这样被误判成「符号不存在」的（单跑 `git grep -n -- 'recordPresenceChanged'` 有 33 处命中，拼在一行里却得到 exit=0 且零输出）。结论要基于**单独跑**的那一条命令。

---

## 3. Phase 0 的下游接口（本文不实现，只标注）

| # | 下一步 | 依赖本文的哪一行 | 前置检查 |
|---|---|---|---|
| 0A | 抽 runtime 到 `packages/runtime`（Step A/B/C） | §1 前五行 | **Step A/B/C 全部已落地**（`packages/runtime/src/{tool-runtime,proactive-runtime,voice-runtime,errors,repo,wav,perception-ingest,replay-runtime}.ts`；7 个入口 import `@xixi/runtime`，包不再反向 import `scripts/`）。**兼容 re-export 仍在 `scripts/field-test.ts`**（等下游全部迁完再删，pack `01_ARCHITECTURE.md` §3）；行为不变的证据：四个入口 `--print-wiring` 除 `entry` 名外只有 1 种 payload，多日时间线逐项与抽取前产物一致 |
| 0B | canonical store `XIXI_DATA_DIR` | §1「canonical store」「perception DB」 | **已落地**（t6，t17 修 F1/F2/F3）：四个 household 入口默认同库、感知单写者、`data/xixi.sqlite` 未被覆盖、页面文案与 `XIXI_DB_ENTRIES` 从 `CANONICAL_STORE_ENTRIES` 生成；硬证据见 [`docs/progress-v03.md`](../progress-v03.md) 的 P0 段与 Gate 实测 |
| 0C | typecheck（tsconfig + `check:types`） | §2 第 13 条 | **已落地**（t7）：`tsconfig.base.json` + `tsconfig.json`（覆盖 packages / apps / scripts / services / tests）+ `npm run check:types`；Node 24 的类型擦除不受影响，CI 顺序是先 `check:types` 再 `npm test` |
| 0D | `tests/replay` 基础（注入 Clock） | §2 第 13 条 | **已落地**（t8）：`tests/replay/` 有 JSON 脚本 + 注入 Clock 的行为回放（对话 / 在场 / 跨天未完话题三条基线），驱动在 `packages/runtime/src/replay-runtime.ts`；`npm test` 的 glob 早已包含它 |
| 0E | 8 个已知缺陷批次（含 SpeechPipeline B2） | §1「voice helpers」行（`SpeechPipeline` 在 `services/voice-edge/voice_edge/voice_stream.ts`） | **已落地**（t2 修 B2 + t3 清掉其余九项）：B2 按「先写回归测试再改代码」交付（`tests/unit/voice/voice-stream.test.ts` 的新用例在旧实现下先红），tombstone 方案见 pack 的 `00_CODE_AUDIT.md` §3.15；九项各自的证据在 `docs/progress-v03.md` 的 P0 段 |

---

## 3b. P2（Agent/Plugin Completion）收口后的状态更新（2026-10-04，t15 落笔）

本文的 §1/§2 是 **P0 基线**（`d3a8916`，§1/§3 在 `59cd65a` 复核过）。P2 之后下面这几处的**现状**变了，
逐条给口径与可复核命令；**详细交付与遗留见 [`docs/progress-v03.md`](../progress-v03.md) 的 P2 段**。

| 面 | 基线（本文的 §1/§2） | P2 之后的现状 | 复核 |
|---|---|---|---|
| Provider 接口 | `BrainAdapter` 七个成员，四个能力抛 `NOT_IMPLEMENTED` | **三接口**（`TurnModelProvider` + 可选 `MultimodalTurnProvider` / `StructuredInferenceProvider`）；四个能力**已移除**，`NOT_IMPLEMENTED` 今天没有生产者 | `git grep -n "TurnModelProvider" -- packages`、`git grep -n "NOT_IMPLEMENTED" -- packages` |
| 插件内核 | 不存在（§2 第 14 条的「PluginManager ⛔ 未实现」） | **已交付**（`packages/plugins/src/*`，九步生命周期 + 五能力 + 四条「插件不能做」的强制点）；装配点 `buildPluginRuntime()` | `git grep -n "PLUGIN_LIFECYCLE_STEPS" -- packages` |
| MCP | 生产 `*.ts` 里 `mcp` 零命中 | **已交付**（`packages/plugins/mcp/`，SDK v2）；**没有任何 live 入口配置过服务器** | `git grep -n "mcpServers" -- scripts`（零命中） |
| 工具审批 | 只有「让模型先问一句」，不落库 | **已交付**（迁移 007 + `packages/runtime/src/tool-approval.ts`，冻结参数摘要 + 审计）；**入口没接 `approvalGate`** | `git grep -n "approvalGate" -- scripts`（零命中） |
| News | `xixi_news_stub`（工具链通、内容空） | **已交付真插件**（`packages/plugins/news/`，三工具 + `news.topics`）；**入口的工具链里没有 `news.*`** | `node scripts/chat.ts --print-wiring` |
| Reminder | 内存 sink，工具自认「到点不会自动响」 | **已交付 durable 调度**（迁移 008 + `packages/runtime/src/reminder-runtime.ts`）；**入口没接 sink 与 scheduler** | `git grep -n "DurableReminderSink" -- scripts`（零命中） |

**统一口径（不许混成一句）**：上面六条都是「**内核/装配点已交付**」+「**四个 live 入口未接线**」。
可跑的证据链是 `buildPluginRuntime(config, …) → start() → definitionsForRound / execute → 真表 → 重启 → tick → 事件`，
**不是**「某个入口已经这样跑」。入口接线四条清单见 progress-v03 的 P2 段 §5。

---

## 3c. P2.5（Production Wiring）之后的现状（2026-10-08）——只覆盖 §3b 里那几行「未接线」

§3b 是 **P2 收口时**的快照（原文保留）。P2.5 之后下面这三处变了，逐条给复核命令：

| 面 | §3b 写的 | 今天的现状 | 复核 |
|---|---|---|---|
| 插件内核 / News | 「入口的工具链里没有 `news.*`」 | **已接线**：入口经 `packages/runtime/src/resident-runtime.ts` 的 `createResidentRuntime()` 取链，插件工具在 `start()` 里挂进同一个注册表 | `git grep -l 'createResidentRuntime(' -- scripts`；`node scripts/chat.ts --print-wiring` |
| 工具审批 | 「入口没接 `approvalGate`（`git grep approvalGate -- scripts` 零命中）」 | **已接线**：审批宿主由装配点构造并注入链，`useRegistry()` 闭合执行路径；**那条 `git grep` 仍然零命中，而这是对的**（接线在装配点内部） | `npm run verify:p2.5 -- --scenario=approval --offline` |
| Reminder | 「入口没接 sink 与 scheduler（`git grep DurableReminderSink -- scripts` 零命中）」 | **全部已接线**：sink 与 scheduler 由装配点给；**到点由主动循环自己读出来**（V0.3 D1.1，2026-10-10）——两个 live 入口的 `new ProactiveLoop({…})` 里各有一行 `...runtime.reminderSeams`，插件话题同理（`readPluginTopics`） | `git grep -n 'reminderSeams' -- scripts ':!scripts/verify-p2-5.ts'`（**排除项必须有**：验收脚本自己也引用它）；`npm run verify:p2.5 -- --scenario=reminder --offline`；`tests/console/live-entry-proactive-seams.test.ts` |

§3b 里 MCP 那一行仍成立（**没有任何入口配置过外部服务器**；今天的唯一入口是配置 `xixi.plugins.mcp.servers`，出厂空表）。
P2.5 的完整交付、仍未接的条目与已知问题见 [`../progress.md`](../progress.md) §12；D0（交互原型 + 两档浏览器防线）
与 D1（两个接缝接进 live 入口）见 [`../progress.md`](../progress.md) §14 与 [`../handoff.md`](../handoff.md) §0.4。

## 4. 维护规则

1. **改代码后必须同步本表**：任何一行的 `current file(s)` / `current caller(s)` 变了，就要在同一次提交里更新（`npm run check:docs` 只查链接与文件是否存在，**查不出「调用点写错」**——这一条靠 `git grep` 复核）。
2. **引用位置只写函数/类名 + 一条 `git grep`，不写行号**（行号随任何一次编辑失效，见 `AGENTS.md` §9.18）。本文所有命令都在本文基线上实跑过 `exit=0`（写成 `|| true` 的那两条是**故意的零命中**核对：`git grep` 无命中时退出码 1，`|| true` 只是让脚本不把它当失败）。
3. **`packages/runtime` 与 `packages/context` 现在是真实存在的包**（P0-A / P1 落地），引用它们时**要加反引号**——`check:docs` 会把反引号里的仓库路径当「应该存在的文件」检查，写错文件名会当场变红。反过来，**还没建的路径不要加反引号**（例如 pack 里的规划名词）。
4. **复核审计结论时以本仓代码为准**：pack 的 `00_CODE_AUDIT.md` 是外部审计报告，不是权威来源（`docs/README.md` §2 的权威性排序里，代码与测试排第一）。
