# V0.3 Phase 0：真实运行时地图（ACTUAL_RUNTIME_MAP）

> 最后更新：2026-10-03（V0.3 Phase 0 第一件事：按 pack 十个概念逐个 `git grep` 核对，并逐项复核 pack 的 `00_CODE_AUDIT.md`）
> 权威来源：**当前代码与测试**（`git grep` 实测）。pack 文档（`E:\xixi_v03_actual_code_pack\docs\*.md`）是设计意图，与本文冲突时以本文为准。
> 基线修订号：`d3a89166cbbcc90077a799781175528415b8c906`（本文所有实测都在这个基线上做；产物在工作区，由 captain 提交）。**基线之上另有一次提交 `4f3301f`（t2 修 `SpeechPipeline` B2），它只碰 `services/voice-edge/voice_edge/voice_stream.ts` 与 `tests/unit/voice/voice-stream.test.ts`，不改本文任何一行的定义处/调用点**——即表中关于「voice helpers 与 `SpeechPipeline` 在哪、被谁调」的结论在 `4f3301f` 上同样成立，但 **B2 缺陷本身已被修掉**（`00_CODE_AUDIT.md` §3.15 描述的旧行为不再是现状）。本文避免引用行号，就是为了让这类提交不影响可核对性。
> 复核方式：每一行的 `current caller(s)` 都能用该行给出的**一条** `git grep` 复现。仓库 grep 在 `D:\Git\usr\bin\grep.exe`（本机 PATH 上没有 `grep`，见 `AGENTS.md` §4）。

本文要回答的问题只有一个：

> **pack 说的那些「在 field-test.ts 里 / 各入口各一份」的东西，在今天的代码里到底在哪、被谁调、下一步搬到哪。**

它不描述期望架构。**没写进本文的迁移都还没做。**

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
| `buildToolChain` + `CONVERSATION_SCOPE` | 定义：`scripts/field-test.ts`（`export function buildToolChain`、`export const CONVERSATION_SCOPE`）。真正建号的是 `packages/brain-adapter/src/tool-registry.ts` 的 `createToolRegistry`（`buildToolChain` 只是把配置摊平成它的入参） | 调用点：`scripts/field-test.ts`（控制台的文字轮与语音轮共用一条链）、`scripts/serve-chat.ts`、`scripts/chat.ts`、`scripts/voice-turn.ts`、`scripts/voice-device-check.ts`、`scripts/eval-conversation.ts`、`scripts/eval-realism.ts`；测试 `tests/console/live-entry-tool-chain.test.ts`。四个内置工具在 `packages/brain-adapter/src/tools.ts`（`xixi_get_current_time` / `xixi_get_weather` / `xixi_news_stub` / `xixi_set_reminder_stub`）。<br>复核：`git grep -n -- 'buildToolChain'`、`git grep -n -- 'CONVERSATION_SCOPE'` | packages/runtime/src/tool-runtime.ts（Step A） | ① 把 `buildToolChain` 与 `CONVERSATION_SCOPE` 搬进新文件，`field-test.ts` 原地 `export { … } from '../packages/runtime/src/tool-runtime.ts'`；② 跑 `npm test`（`tests/console/live-entry-tool-chain.test.ts` 钉着「四个 live 入口拿到同一条链」）；③ 再把 7 个调用方的 import 逐个改到新包 |
| `ProactiveLoop` + 候选构造器 | 定义：`scripts/field-test.ts`（`export class ProactiveLoop`、`ProactiveLoopOptions`、`ProactiveLoopEntry`，tick 在 `tickOnce`）。候选构造器同一文件（`buildProactiveCandidates`、`lastUserTurnAt`）。评分与硬底线在 `packages/conversation/src/proactive.ts` | 调用点：`scripts/field-test.ts`（控制台的常驻考虑循环）、`scripts/serve-chat.ts`；评测 `scripts/eval-proactive-timeline.ts`（跨天回放直接 `new ProactiveLoop`）；测试 `tests/console/proactive-loop.test.ts`、`tests/console/proactive-open-thread-loop.test.ts`、`tests/integration/open-thread-followup.test.ts`。<br>复核：`git grep -n -- 'ProactiveLoop'`、`git grep -n -- 'buildProactiveCandidates'`、`git grep -n -- 'lastUserTurnAt'` | packages/runtime/src/proactive-runtime.ts（Step B） | ① 循环 + 候选构造器一起搬（它们互相引用，分开搬会造出双向依赖）；② `field-test.ts` re-export；③ 先改 `scripts/eval-proactive-timeline.ts`（它只 import `ProactiveLoop`，是风险最小的第一个调用方），再改两个 live 入口 |
| `createModelComposer` | 定义：`scripts/field-test.ts`（`export function createModelComposer`，内部用 `engine.buildPrompt({ …, addressed: true })` 伪装成用户轮——pack 的 `00_CODE_AUDIT.md` §3.13 说的就是这里） | 调用点：`scripts/field-test.ts`（控制台 `compose` 接缝）、`scripts/serve-chat.ts`（试用页 `compose` 接缝）；测试 `tests/console/unbacked-facts-console.test.ts`。<br>复核：`git grep -n -- 'createModelComposer'` | packages/runtime/src/proactive-runtime.ts（Step B） | ① 与 `createModelComposer` 同批搬；② 搬完**不要**顺手改 prompt 语义——`PromptMode`（不再伪装 user turn）是 pack Phase 3 的事，现在改会把 Phase 0 的「只搬家不改行为」搅在一起 |
| `createModelDecider` | 定义：`scripts/field-test.ts`（`export function createModelDecider`，P5「读空气」：底线之上由模型决定开不开口） | 调用点：**只有 `scripts/field-test.ts` 自己**（`decide:` 接缝，`ProactiveLoop` 的选项）。`scripts/serve-chat.ts` 只 import 了 `createModelComposer`，**没有** import 它。<br>复核：`git grep -n -- 'createModelDecider'` | packages/runtime/src/proactive-runtime.ts（Step B） | ① 与 composer 同批搬；② 「试用页是否也该有模型决策接缝」是 pack Phase 3 的问题（现在试用页的主动路径与控制台并不等价），Phase 0 只搬家、不改接线；③ 搬完检查 `serve-chat.ts` 的 import 列表没有被误加 |
| voice helpers | 定义（TS，三处）：`scripts/field-test.ts` 的 `planSpeechSegments` / `buildSpeechAudio`（VAD 段规划与拼接）；`services/voice-edge/voice_edge/voice_stream.ts` 的 `SpeechPipeline` / `ClauseChunker` / `AssentBank` / `XIXI_PLAYBACK_JS`（流式切块→TTS 队列→播放时钟）；`packages/conversation/src/segments.ts` 的 `ClauseChunker`（切块规则本体）。Python 侧前端在 `services/voice-edge/voice_edge/frontend.py` | 调用点：`scripts/voice-turn.ts`（`planSpeechSegments` + `buildSpeechAudio` + `SpeechPipeline`）、`scripts/field-test.ts`（`SpeechPipeline`、`handleVoiceTurn`）、`scripts/serve-chat.ts`（`AssentBank` / `XIXI_PLAYBACK_JS` / `XIXI_PLAYBACK_THRESHOLDS` + 从 field-test 转出的 `handleVoiceTurn` / `segmentPlan`）；测试 `tests/console/field-test-console.test.ts`、`tests/unit/voice/voice-stream.test.ts`。<br>复核：`git grep -n -- 'buildSpeechAudio'`、`git grep -n -- 'planSpeechSegments'`、`git grep -n -- 'SpeechPipeline'`、`git grep -n -- 'handleVoiceTurn'` | packages/runtime/src/voice-runtime.ts（Step C） | ① Step C 只覆盖 `planSpeechSegments` / `buildSpeechAudio` / `handleVoiceTurn` 这类**共享缝**；② `voice_stream.ts` 不是「field-test 的代码」，它是 **Python 服务目录里的 TS**，被 `field-test.ts` / `voice-turn.ts` / `serve-chat.ts` 反向 import——它的归属要与 P4（常驻 AudioEdge）一起定，Phase 0 不动它；③ `packages/conversation/src/segments.ts` 的 `ClauseChunker` 留在原地（它已经是包内代码） |
| Memory extractor | 定义：`packages/conversation/src/extractor.ts`（`export class TurnMemoryExtractor`，`runJob` 里做反馈解释 → relationship note / episodic / semantic 写入 + 未完话题）。它**已经在包里**，不在 `scripts/` | 调用点：`scripts/field-test.ts`、`scripts/serve-chat.ts`（各自 `new TurnMemoryExtractor({ store, selfModel, memory, onError })`，并通过 `ConversationEngine` 的 `afterTurn: (job) => extractor.enqueue(job)` 接线）。**`scripts/chat.ts` 与 `scripts/voice-turn.ts` 没有 `afterTurn`**（`new ConversationEngine({ adapter, store, config, … })`），所以这两个入口不写记忆。<br>复核：`git grep -n -- 'TurnMemoryExtractor'`、`git grep -n -- 'afterTurn'`、`git grep -n -- 'new ConversationEngine'` | 留在 `packages/conversation`（P1 只加 `MemoryRetriever`，不重写写侧） | ① P0 不搬它；② P1 的「三入口 afterTurn」是把 `chat.ts` / `voice-turn.ts` 补上接线（`docs/handoff.md` 已记为已知缺口），不是搬家；③ 补接线时注意 `data/voice` 与 `data/chat` 是两个库——「统一 store」是 P0-0B 的前置 |
| Memory store / relationship snapshot | 定义：`packages/domain/src/memory.ts`（`export class MemoryStore`；`snapshot()` 产 `RelationshipSnapshot`，含 `proactiveAcceptRate` 等）。表在 `packages/domain/src/migrations/004_memory.sql`；`open_threads` 在 `003_open_threads.sql` | 实例化：`scripts/field-test.ts`、`scripts/serve-chat.ts`（都只把它**交给 extractor 写**）；测试 `tests/integration/memory-feedback.test.ts`、`tests/unit/domain.test.ts`。**`MemoryStore.snapshot()` 在生产入口没有任何调用方**——`git grep -n -- '\.snapshot('` 的命中只有 `ConversationEngine.snapshot()`（FSM）与 `scripts/chat.ts` 的调试打印。<br>复核：`git grep -n -- 'class MemoryStore'`、`git grep -n -- '\.snapshot('`、`git grep -n -- 'new MemoryStore'` | 留在 `packages/domain`（P1 由 `MemoryRetriever` / `ContextBuilder` 消费） | ① 保留 `XixiStore` 与 `MemoryStore`，不重造；② P1 把 `snapshot()` 接进关系上下文（消费点目前为零）；③ 记忆召回必须先过 audience/visibility 过滤，再进 prompt（pack 硬规则） |
| current DB dirs（各入口各自的库） | 定义：`packages/domain/src/store.ts`（`DEFAULT_DATA_DIR = 'data'`、`DEFAULT_DB_FILE = 'xixi.sqlite'`、`openXixiStore`）；各入口自己拼路径：`scripts/chat.ts`（`XIXI_CHAT_DATA_DIR ?? data/chat`）、`scripts/serve-chat.ts`（`XIXI_WEB_DATA_DIR ?? data/web-chat`）、`scripts/voice-turn.ts`（`data/voice`）、`scripts/field-test.ts`（`data/field-test`）、`scripts/voice-device-check.ts`（`data/voice-device`）。入口清单本体在 `XIXI_DB_ENTRIES`（`scripts/field-test.ts`，5 行，含 `npm run demo:m0:text` → `data/demo`） | 读的人：控制台与试用页都把 `XIXI_DB_ENTRIES` 渲染成「本页用哪个库」区块（`databaseNoteHtml`），并用 `readPresence` 读**另一个库**。评测脚本按设计用临时库（`mkdtempSync`）：`scripts/eval-conversation.ts`、`scripts/eval-realism.ts`、`scripts/eval-proactive-timeline.ts`。<br>复核：`git grep -n -- 'openXixiStore'`、`git grep -n -- 'XIXI_DB_ENTRIES'`、`git grep -n -- 'XIXI_CHAT_DATA_DIR'`、`git grep -n -- 'XIXI_WEB_DATA_DIR'` | 新默认 `XIXI_DATA_DIR` → `data/xixi`（P0-0B） | ① 先加环境变量与默认值，让**所有 household 入口**默认指向同一库；② 现有 `XIXI_CHAT_DATA_DIR` / `XIXI_WEB_DATA_DIR` 保留为「测试/并行实例」缝（它们已在用，别直接删）；③ `data/` 下已存在早期库（如 `data/xixi.sqlite`，见下一行），迁移时必须**不覆盖**；④ 改完要同步 `XIXI_DB_ENTRIES` 与两个页面的文案——`docs/README.md` §0 已把「四个入口各用不同数据库」写成用户须知，改默认值就必须改它 |
| perception DB（在场投影） | 定义：Python 侧 `services/perception-edge/perception_edge/emitter.py`（`EventEmitter`，`--db <path> --append` 时把 `presence.changed` 与 `world_state(presence.home)` 投影**同一个事务**写进已初始化的西西库）；Node 侧 `scripts/field-test.ts` 的 `presenceDataDir` / `getPresenceStore` 只**读**它 | 写入者：子进程 `python -m perception_edge.run --live --db … --append`，由 `scripts/field-test.ts` 的 `createPerceptionLiveRunner` 拉起（`--db` 取 `presenceDbPath`）。读取者：`readPresence`（`scripts/field-test.ts`），被控制台与 `scripts/serve-chat.ts`（`presenceStorePath = join(REPO_ROOT, 'data')`）调用；验收脚本 `scripts/verify-camera-presence.ts`。<br>复核：`git grep -n -- 'presenceDataDir'`、`git grep -n -- 'presenceDbPath'`、`git grep -n -- 'readPresence'`、`git grep -n -- '--append'` | 合并进 canonical `XixiStore`（P0-0B），单写者 | ① 现状是**两个库**：控制台自己的数据在 `data/field-test/`，在场投影在 `data/`（`--presence-data-dir` / 默认 `join(REPO_ROOT,'data')`）；② 统一后由 Node 侧做唯一写者或走本地 ingest，Python 不再长期直写自己的库（pack `04` §3）；③ 迁移要保住 `EventEmitter` 的「没建表就不写」行为，别让它去建表 |
| prompt builder | 定义：`packages/conversation/src/prompt.ts`（`PromptAssembler.assemble`、`HARD_POLICY`、段名 `core-identity` / `safety-policy` / `effective-style` / `world-state` / `current-turn`）；喂它的是 `packages/conversation/src/engine.ts` 的 `buildPrompt`（只传 `personality` / `worldStateLite` / `conversationState` / `history` / `mood`） | 调用点：`ConversationEngine.respond()`（生产轮次）、`scripts/chat.ts`（`--print-wiring` 外的预览路径）、`scripts/field-test.ts` 的 `createModelComposer` / `createModelDecider`（主动路径，伪装成 user turn）、测试 `tests/integration/mood-state.test.ts`、`tests/unit/core/chat-personality-args.test.ts`。<br>复核：`git grep -n -- 'buildPrompt'`、`git grep -n -- 'HARD_POLICY'`、`git grep -n -- 'workingMemory'` | P1 新增 `ContextBuilder`（pack `02`），`prompt.ts` 仍是渲染层 | ① P0 **不动**它；② P1 把 context 的来源从引擎内联改成 `ContextBuilder` 输出（recentTurns / memories / relationship / openThreads / world / self / mood）；③ `HARD_POLICY` 里「可核查的具体事实只能来自工具结果或对方刚刚明确说的信息」这句是 P1 可信记忆的冲突点（见 §3 第 9 条）——改它属于 P1，不属于 P0 |
| DSH 与 direct providers | 定义：`packages/brain-adapter/src/mimo.ts`（`MimoBrainAdapter`，直连 MiMo，流式 + 图片 + `AgentLoop`）、`packages/brain-adapter/src/dsh.ts`（`DshBrainAdapter`，DSH CLI/profile，不接受图片，四个能力方法抛 `NOT_IMPLEMENTED`）、`packages/brain-adapter/src/agent-loop.ts`（工具循环）、`packages/brain-adapter/src/tool-registry.ts`（`createToolRegistry`）；DSH 侧工具插件 `plugins/xixi-tools/index.js`（只注册时间 + 天气）；DSH profile 在 `apps/brain-dsh/profile/cordis.patch.yml` | 选择点：`scripts/chat.ts`（`--dsh`）、`scripts/serve-chat.ts`（`--dsh`）、`scripts/field-test.ts`（`useDsh`）、`scripts/eval-conversation.ts`（`--dsh`）、`scripts/verify-m0.ts`。**默认都是 direct**：`--dsh` 是显式开关（`scripts/serve-chat.ts` 的 `USE_DSH = args.includes('--dsh')`）。图片路径：`DshBrainAdapter` 在收到 `input.images` 时直接 `BAD_REQUEST`，`MimoBrainAdapter` 会带上图片。<br>复核：`git grep -n -- 'DshBrainAdapter'`、`git grep -n -- 'MimoBrainAdapter'`、`git grep -n -- 'useDsh'`、`git grep -n -- 'NOT_IMPLEMENTED'` | 留在 `packages/brain-adapter`；P2 做 provider 接口瘦身（`TurnModelProvider` 必须 / `MultimodalProvider`、`ReflectionProvider` 可选） | ① P0 只**记录**漂移，不改接口；② 硬规则：DSH 不得成为 realtime 默认（现在是显式 `--dsh`，保持）；③ `evaluateProactiveCandidate` / `interpretFeedback` / `extractMemories` / `reflect` 这四个方法在三个 adapter 里都抛 `NOT_IMPLEMENTED`，且**没有生产调用方**——P2 拆接口时先确认这一点再决定保留还是移除 |

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

14. **完成度矩阵「PluginManager / MCP host ⛔ 未实现」——一致。**
    生产代码里没有 MCP client/host：`git grep -n -i -- 'mcp' -- '*.ts'` **零命中**（`*.ts` 退出码 1 是预期结果）；全仓命中只有三处，都是配置或文档——`apps/brain-dsh/profile/cordis.patch.yml` 里 DSH 自带的插件 `mcp-resources`、`docs/design/security-and-privacy.md` 对它的引用、方案原文的扩展点清单。
    命令：`git grep -n -i -- 'mcp'`、`git grep -n -i -- 'mcp' -- '*.ts' || true`、`git grep -n -- 'ToolRegistry'`

15. **§4「审计容器 Node v22.16.0，跑不了 `.ts`」——环境说明，与代码无关，但结论要记住：**
    本机是 Node 24（`node --version`），`npm test` 的项数以**实跑输出**为准，不要引用审计里的 `473 tests`。
    命令：`node --version`、`npm test`

**一句话总结**：审计的**方向全部成立**（field-test 是隐藏 runtime、记忆只写不读、多库孤岛、DSH 旁路、Replay/Typecheck 缺失、presence 默认 actor=father），**有 4 处细节与今天的代码不符**：3 处是「清单不完整 / 计数过期」（第 3、4、7 条），1 处是引文缩减（第 9 条）。这 4 处在派工时要么按本文修正，要么明确标注「以代码为准」。

**一条给自己人的提醒**（本次差点写错）：判断「某符号全仓有没有命中」时，**不要把它塞进带 `if`/管道/多条命令拼起来的 PowerShell 一行里**——本次第 12 条就是这样被误判成「符号不存在」的（单跑 `git grep -n -- 'recordPresenceChanged'` 有 33 处命中，拼在一行里却得到 exit=0 且零输出）。结论要基于**单独跑**的那一条命令。

---

## 3. Phase 0 的下游接口（本文不实现，只标注）

| # | 下一步 | 依赖本文的哪一行 | 前置检查 |
|---|---|---|---|
| 0A | 抽 runtime 到 `packages/runtime`（Step A/B/C） | §1 前五行 | re-export 先行；每步 `npm test` 全绿 |
| 0B | canonical store `XIXI_DATA_DIR` | §1「current DB dirs」「perception DB」 | 先确认 `data/` 下已有的 `xixi.sqlite` / `data/*/` 不被覆盖；改默认值要同步页面文案与 `XIXI_DB_ENTRIES` |
| 0C | typecheck（tsconfig + `check:types`） | §2 第 13 条 | 无 tsconfig 也没有 `check:types`；Node 24 的类型擦除不受影响 |
| 0D | `tests/replay` 基础（注入 Clock） | §2 第 13 条 | 目录不存在；`npm test` 的 glob 已包含它 |
| 0E | 8 个已知缺陷批次（含 SpeechPipeline B2） | §1「voice helpers」行（`SpeechPipeline` 在 `services/voice-edge/voice_edge/voice_stream.ts`） | **先写回归测试再改代码**；B2 的 tombstone 方案见 pack 的 `00_CODE_AUDIT.md` §3.15 |

---

## 4. 维护规则

1. **改代码后必须同步本表**：任何一行的 `current file(s)` / `current caller(s)` 变了，就要在同一次提交里更新（`npm run check:docs` 只查链接与文件是否存在，**查不出「调用点写错」**——这一条靠 `git grep` 复核）。
2. **引用位置只写函数/类名 + 一条 `git grep`，不写行号**（行号随任何一次编辑失效，见 `AGENTS.md` §9.18）。本文所有命令都在本文基线上实跑过 `exit=0`（写成 `|| true` 的那两条是**故意的零命中**核对：`git grep` 无命中时退出码 1，`|| true` 只是让脚本不把它当失败）。
3. **本表里 packages/runtime/* 是规划路径，不存在**；在它真的建出来之前，任何人不得在文档里把它写成现存文件（包括不要加反引号——`check:docs` 会把它当路径检查）。
4. **复核审计结论时以本仓代码为准**：pack 的 `00_CODE_AUDIT.md` 是外部审计报告，不是权威来源（`docs/README.md` §2 的权威性排序里，代码与测试排第一）。
