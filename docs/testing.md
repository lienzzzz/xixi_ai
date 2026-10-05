# 测试

2026-10-05 S4测量命令 `npm run probe:runtime-ledger` 默认1024 tick，`-- --events=4` 最小自检；脚本断言结构及零模型/读空气调用，临时库在finally删除。耗时/RSS是测量而非门槛，不进默认全量；生产门禁未减少。范围见 [基线报告](recon/runtime-ledger-growth-2026-10-05.md)。

2026-10-05 S4第一步默认门禁新增bounded-queue单元5项和input-backpressure宿主集成2项：FIFO/同步重入、失败释放、拒绝零prepare、prepare中close等待/重复关闭，两处慢fake模型饱和时零额外执行/落库，终端大输入零checkpoint变更。`npm run demo:input-backpressure` 为共享队列离线演示，不接硬件/API，数字见 [progress](progress.md)。

2026-10-05 S3第四步默认门禁新增history-recall单元4项及实际引擎集成1项：完整引用字节/条数、排除/错配置、同句引用去重、跨会话/公开/关闭、重启/删除截止。`npm run demo:history-recall` 演示30轮后恢复相关原话，均为fake和临时库，数字见 [progress](progress.md)。

2026-10-05 S3第三步默认门禁新增 `tests/integration/history-invalidation.test.ts`：5种变更跨重启/原文审计/会话隔离/真实prompt，以及失败删除事务回滚/缺失来源。可运行 `npm run demo:history-invalidation`，fake与临时库，数字见 [progress](progress.md)。

2026-10-05 S3第二步：默认门禁新增 `tests/unit/core/round-budget.test.ts`（8项）和 `tests/integration/round-budget-engine.test.ts`（2项）。验证调用前预算、同批结果超限零后续写、权限不变、SSE完整/部分/未知用量与实际引擎审计。`npm run demo:round-budget` 为实际宿主离线演示，供应商请求均为替身，数字见 [progress](progress.md)。

2026-10-05 S3第一步：新增 `tests/unit/context-budget.test.ts`（6项）及 `tests/integration/context-long-session.test.ts`（1项），默认门禁运行；`npm run demo:context` 另做120长轮次实际终端宿主演示，关闭重开数据库、程序接口替代/撤销记忆与访客切换。模型全部fake，结构/权限/字节预算证据不等于真实对话质量；最新数字见 [progress](progress.md)。

2026-10-05 S2验收：`node --test tests/integration/terminal-companion.test.ts tests/integration/resident-chat-cli.test.ts` 覆盖真实库、审批/提醒、公开权限、重启、TTL、输出失败及HTTP/SSE模型客户端替身；`npm run demo:resident` 启动实际fake CLI的两个独立进程，检查会话/静默/审批/长期偏好恢复。默认全量也运行这些测试；无真实供应商费用、无硬件。最新数字与评审限制见 [progress](progress.md)。

## 单主人软件闭环（2026-10-05）

S1配置回归：`tests/unit/endpoint-profile.test.ts` 检查版本、闭合字段、重复标识、跨房间、未知adapter/能力错配、必需端点、64端点与64KiB、BOM及无敏感内容错误。CLI子进程测试另用bedroom和自定义设备标识/单麦克风跑同一演示，验证配置传入恢复进程。`npm run demo:ambient -- --profile config/ambient.example.json` 可运行自定义档案；它不扫描设备或加载真实驱动。

运行 `npm run demo:ambient`，全程临时库、离线模型和脚本化读空气，包含新进程恢复，结束清理临时数据；失败以非零退出。无物理设备与真实 API 验收。默认 `npm test` 已包含 checkpoint、工具边界、ambient-runtime 场景和实际 CLI 子进程用例。定向命令：`node --test tests/unit/ambient-checkpoint.test.ts tests/unit/core/tool-boundaries.test.ts tests/integration/ambient-runtime.test.ts tests/integration/ambient-demo.test.ts`。身份、媒体、自身声音等分类由夹具提供；用例验证接收分类后的行为，不能证明识别算法准确。实际杀进程/断电窗口尚未验收。最终数字见 [进度](progress.md)。

> 最后更新：2026-10-04（V0.3 P2 收口：§1 集成层与 §2 新增 P2 的测试面，把「`tests/replay/` 仍为空」这条过期陈述改掉）
> 权威来源：`tests/**`、`scripts/**`、`package.json` 的脚本；与代码不一致时以代码为准并立即修正本文
> 当前状态：`npm test` → **全绿**（**项数与文件数以实跑为准**；最近一次实测点是 V0.3 P2 收口的 **717 项、pass 717 / fail 0**，
> 取数修订号与命令见 [`progress-v03.md`](progress-v03.md) 的 P2 段；更早的 2026-09-30 实测点是 223 项、29 个 `*.test.ts`），**不发起任何网络请求**。
> `tests/scenarios/` 是语料模块（不产生用例）；`tests/replay/` 自 V0.3 P0-D 起有 16 项行为回放（`npm run test:replay`），**不再是空的**。
> 壁钟：**以实跑为准**（默认门禁的目标是「可用于迭代」，**不写死秒数**，见 [`AGENTS.md` §7](../AGENTS.md)）——数字只当区间看：
> 同日实测（`npm test` 五次）：空载 **13.6 / 13.9 / 15.9s**，同机有别的成员在跑 **18.2 / 18.6s**；另一次空载 wall **15.4s**、`ℹ duration_ms 14686`。
> 关键路径**历史上（t47 之前）**是 `tests/unit/voice/frontend.test.ts` 的多次 Python + VAD 冷启动（单文件就要 ~21s，全量门禁因此在 27–39s 一带）；
> **t47 的提速来自改 runner**（`scripts/verify-voice-noise.ts` 改用常驻 Python worker；`frontend.test.ts` 一行未改，只是调用变快了）——单文件 ~10s、全量 ~15s，回退开关是 `XIXI_VAD_ONESHOT=1` / `--no-vad-worker`（归属订正见 [`AGENTS.md` §9.9](../AGENTS.md)）。
> 因此本文早先那句「空载也要 26–30s」「<25s 目标达不到」**已作废**，不要引用（数字与做法见 [`AGENTS.md` §9.9](../AGENTS.md)）。
> 项数与耗时都会随开发变化，**所以本文不拿它们当契约**：仅 2026-09-30 一天，同一份门禁就先后出现过 139 → 180 → 209 → 213 → 223 项（控制台一层也从 1 个文件长到 5 个）——**一切以 `npm test` 末行为准**。同一时刻别人在加用例，总数就会更高；本文引用的每个数字都标了实测日期与来源，`git grep` 一下就知道它是哪一次的快照。**改本文时不要再写死总数或文件数**，只留带日期的「实测点」。
> 实测结论集中在 [`progress.md` §0](progress.md)：对话质量、语音闭环、打断与结构化输出都有单独脚本与证据。
> 上游依据：《方案》§51（CI / Regression）、§52（Model Contract Testing）、§22.3（Event Replay）、§33（PoC 指标）。
> 相关：[`architecture.md`](architecture.md)、[`event-contracts.md`](event-contracts.md)、[`ADR-0006`](adr/0006-runtime-and-dependency-choices.md)、[`ADR-0008`](adr/0008-realtime-path-direct-mimo.md)。

## 1. 分层地图

| 层 | 目录 | 跑什么 | 是否联网 | 现在有什么 |
|---|---|---|---|---|
| 单元 | `tests/unit/` | 契约校验、领域持久化、transport 解析、会话 FSM、Prompt 组装、工具、语音前端、核心接线 | 否 | **文件数与项数都以实跑为准**：文件数用 `git ls-files "tests/unit/*.test.ts" "tests/unit/**/*.test.ts"`（**两条通配都要给**：只写 `tests/unit/**/*.test.ts` 会漏掉直接放在 `tests/unit/` 下的那些文件），项数用 `npm run test:unit` 的末行 |
| 集成 | `tests/integration/` | `TurnModelProvider` ↔ transport ↔ store、会话引擎、离线重启恢复、主动引擎门禁与重启不重发、**durable 提醒的两进程重启**（`tests/integration/reminder/`） | 否 | **以实跑为准**：文件数 `git ls-files "tests/integration/*.test.ts"`，项数 `npm run test:integration` 末行 |
| 场景 | `tests/scenarios/` | 对话语料（8 场景，数据驱动），由 `scripts/eval-conversation.ts` 执行 | 执行时联网 | `corpus.ts`（**不是**空目录，也不产生 `npm test` 用例：它是数据模块） |
| 回放 | `tests/replay/` | 导出事件区间 → 重放 → 复现决策（§22.3） | 否 | **空**（属 M5） |
| 控制台 | `tests/console/` | 现场测试控制台的隐私保留策略、多段语音规划、在场回退、报告与错误文案、主动开口面板、三栏页面、「看一眼」（项数以 `npm run test:console` 末行为准） | 否 | `field-test-console.test.ts`、`proactive-console.test.ts`、`proactive-loop.test.ts`、`three-column-console.test.ts`、`look-once-console.test.ts`；**已在 `npm test` 的 glob 里（t16 起）**，也可用 `npm run test:console` 单跑 |
| 感知 | `tests/perception/` | 摄像头在场检测的 TS 契约 + 转发 Python 回归套件（合成场景，不需要真相机；项数以 `npm run test:perception` 末行为准） | 否 | 需要带 cv2 的 venv（`.venvs/field-probe` 或 `.venvs/cv4`，缺了**直接失败**而不是跳过）；也可用 `npm run test:perception` 单跑 |
| 真实 API 验收 | `scripts/verify-*.ts`、`eval-conversation.ts`、`voice-*.ts` | 真实 MiMo 调用、语音闭环、打断 | **是** | 见下方「新增验证脚本」，**都不在 `npm test` 里** |
| 真机设备验收 | `scripts/field-test.ts --acceptance` | 麦克风/扬声器/摄像头自检（pycaw + WASAPI 回环 + DSHOW） | 否 | 需要真机；结果写 `docs/recon/field-test-report-<日期>.md` |

全部测试用 Node 内置 `node:test` + `node:assert/strict`，直接执行 `.ts`（无构建步骤，[ADR-0006](adr/0006-runtime-and-dependency-choices.md)）。
进默认门禁的四层，**文件数与项数也都以实跑为准**（2026-09-30 实测点：29 个 `*.test.ts`、223 项＝unit 131 + integration 30 + perception 11 + console 51；文件数：`git ls-files "tests/*/*.test.ts" "tests/**/*.test.ts"`，总数：`npm test` 末行）。
（两条通配同样都要给，理由见上表单元行：`**` 至少要求一层子目录，只给 `**` 会漏掉直接放在层目录下的文件。）
模型相关测试遵守 §51：验证**结构与行为**（`action` 取值、`toolName` 是否被调用、字段是否落在范围内），
不做字符串相等断言。

## 2. 每个测试文件覆盖什么

> 小标题后面**故意不写项数**（一个文件的用例数随时会变，选题时的数字很快就会过期）：要看某个文件现在有几项，
> 跑 `node --test <该文件>` 看末行。下面各节写的是**覆盖了什么行为**，那才是这一节的内容。

### `tests/unit/smoke.test.ts`

workspace 解析与 Node 原生类型擦除可用：能 `import { EVENT_SCHEMA, SCHEMA_VERSION } from '@xixi/contracts'`
并断言 `'xixi.event.v1'` / `1`。它失败通常意味着 `npm install` 的 workspace 链接没建好。

### `tests/unit/contracts.test.ts`

| 用例 | 断言的核心行为 |
|---|---|
| `buildEvent fills identity and time, and validates` | id/时间戳自动生成、`room` 默认 `null`、对象被冻结、序列化后仍能 `validateEvent` |
| `timestamp always carries an explicit numeric offset, never Z` | 断言不以 `Z` 结尾（§4 的时区规则） |
| `unknown event type is rejected before anything else` | `UNSUPPORTED_EVENT_TYPE`，消息里列出已知类型 |
| `envelope rejects unknown extra properties` | 注入 `injected` 字段 → `INVALID_EVENT` + `unexpected property "injected"` |
| `payload is validated against the registered schema` | 类型错（`present: 'yes'`）→ `INVALID_PAYLOAD`，问题路径指向 `/present` |
| `confidence outside [0,1] and unknown actors are rejected` | `1.4` 与 `actor: 'neighbour'` 都被拒 |
| `an envelope whose version does not match the payload version is refused` | `schema_version: 2` → `UNSUPPORTED_SCHEMA_VERSION` |
| `silence is a first-class conversation output (§55)` | `action:'SILENCE'` + `text:null` 合法；`session_id` 形状错则非法 |
| `isEventEnvelope never throws on foreign input` | `null` / 任意对象 → `false`，不抛 |
| `every committed schema only uses keywords this validator enforces` | 遍历 `schemas/**.json`，关键字必须在 `SUPPORTED_KEYWORDS` 内 |
| `the validator fails closed on a keyword it cannot enforce` | `multipleOf` → `UNSUPPORTED_SCHEMA_KEYWORD` |
| `registry, envelope enum and actor list stay in sync` | 注册表 / 信封 `event_type` 枚举 / `payloadVersion` / `ACTORS` 四者一致 |

### `tests/unit/domain.test.ts`

迁移幂等（第二次打开不重复应用）、**改写已应用迁移即 `MIGRATION_CHECKSUM_MISMATCH`**、
事件重复插入 `DUPLICATE_EVENT` 与按 `sequence` 顺序读回、
`recordTurn` 的 `turnIndex`/投影/日志三者一致、未知与已结束会话报错
（`UNKNOWN_SESSION` / `SESSION_ALREADY_ENDED`）、
`seedSelfProfile` 只补缺不覆盖且写入 `self_profile_history`、
人格属性 schema 校验（`UNKNOWN_PERSONALITY_PROPERTY` / `PROPERTY_OUT_OF_RANGE`）、
`resume()` 返回会话+轮次+人格、
以及 `config/xixi.example.yaml` 能加载（`identity.name = 西西`、`models.llm.model = mimo-v2.6-flash`、`thinking_realtime = false`）
与缺段配置报 `INVALID_CONFIG`（消息指出 `missing section "models"`）。

临时库一律用 `mkdtempSync(join(tmpdir(), 'xixi-…'))`，不碰 `data/`。

### `tests/unit/transport.test.ts`

`parseDshJsonLines` 对 `dsh --json` 的 NDJSON 解析：非 JSON 的诊断行**不会**变成事件
（`raw.length === 5`）、`session` 事件给出 `sessionId`、`tool_call` 收集工具名与 `callId`、
`final` 给出最终文本、`error` 事件被当作失败原因。
`CliDshTransport.composeTask` 必须带上身份 / 人格键值 / 时区 / 最近对话 / 用户输入。
另两项：显式给错的 DSH 入口路径 → `BrainError('TRANSPORT_FAILED')`；
`cwd` 不存在 → 构造时就拒绝（不会 spawn 一个必然失败的子进程）。

这是**纯离线**的：它不 spawn 真的 `dsh`，只解析样例字符串。真实 spawn 走 `verify:*`。

### `tests/integration/brain-adapter.test.ts`

适配器与 store 的接线：第一轮 `resumeBrainSessionId === null`（不许假装恢复）、
第一轮结束后映射落库（`store.brainSessionId(sess, 'dsh')`）、
第二轮带着同一 id resume；工具调用同时以 `{ type:'tool' }` chunk 和结构化 `toolName` 暴露；
transport 抛错 → `TRANSPORT_FAILED`、provider 返回失败 → `PROVIDER_FAILED`（保留原始 code）；
**requestId 不匹配 → `INVALID_RESPONSE`**；
`interpretFeedback` / `evaluateProactiveCandidate` → `NOT_IMPLEMENTED` 且 `milestone` 分别是 `M3` / `M5`。

用 `ScriptedDshTransport`（[`packages/brain-adapter/src/scripted.ts`](../packages/brain-adapter/src/scripted.ts)）
当离线替身，它模仿 harness 的会话语义：第一轮铸造 id，之后沿用被 resume 的 id，并记录每个请求。

### `tests/integration/restart-recovery.test.ts`

进程内模拟的两段式恢复：进程 1 建会话、种子人格、写用户轮次、跑一轮适配器并写助手轮次，然后 `close()`；
进程 2 打开**同一个 SQLite 文件**，断言迁移未重跑、`resume()` 拿回同一会话/2 条轮次/人格、
harness 映射仍在，并把持久化的 harness 会话原样交给 transport。
第二项：每次启动都 `seedSelfProfile` 是**恢复而不是重置**（旧值保留、不伪造变更记录）。
第三项：`FakeBrainAdapter` 的确定性行为（`你好` → `SPEAK` + `模拟回复：你好`；空白 → `SILENCE`；`/tool …` → `TOOL`）。

真正的跨进程版本是 `demo:m0:restart`（离线）与 `verify:m0`（真实模型），见 §5。

### `tests/console/field-test-console.test.ts`

现场测试控制台里「不需要硬件就应该正确」的部分，全部纯离线：

| 用例 | 断言的核心行为 |
|---|---|
| 出厂配置 = 不留原始录音（§20.1） | `privacy.store_raw_audio: false` + `memory.raw_audio_retention_days: 0` → 整段录音与语音段都不落盘，`reason` 里说明理由 |
| 显式开启时的保留期 | `store_raw_audio: true` + 7 天 → 只保留语音段、保留 7 天 |
| 清理逻辑 | 只删本脚本自己的 `capture-*.wav`/`speech-*.wav`；保留期内的文件不删；`ambient-5s.wav`/`notes.txt` 不碰 |
| 多段语音规划 | 10 段 → 用 8 段、**逐条报告**丢弃的 2 段与原因；超时长上限同理；`used + dropped == total` |
| 三段音频拼接 | 单段 = 纯切片；多段 = 全部语音段按顺序拼接（段间 300ms），格式不变，被丢弃的段**不在**音频里 |
| 校准产物读取 | 文件缺失 → `available: false` + 「简易 RMS，未校准」；Python 的 snake_case 字段（`gate_threshold_dbfs`）也能解析 |
| 在场状态回退 | 投影 / 事件日志 / 未接入 / 读取失败四种状态都返回视图**从不抛异常**；`stale` 会说明过期 |
| 动作与原因中文 | `SILENCE` → 「沉默」，`REJECTED_SUSPENDED` → 「今天安静点」等 |
| 报告自足 | 含逐项结论、证据 JSON、下一步动作（不重复前缀）、假 PASS 判据说明、校准与隐私段、复现命令 |
| 页面自足 | 中文标记齐全（电平/噪声底/在场/验收引导/延迟分段）、含启动状态、没有未替换的模板占位符 |
| 可读错误 | 没有音频 / 太短 / 不是 WAV / 缺 Python / 缺探测二进制 → `ConsoleError` 带中文 `hint`，不是堆栈 |
| 假 PASS 回归 | 离线替身返回「扬声器静音 + 相对差 2.6 dB + 绝对 RMS −30 dB」→ 判据必须是相对的那一条 |
| 只监听本机 | 端口 0 绑定后 `server.address().address === '127.0.0.1'`，`/api/field/state` 回报 `127.0.0.1:<真实端口>` |

需要真机的部分（麦克风电平、扬声器回环、摄像头取帧）由 `node scripts/field-test.ts --acceptance` 覆盖，
离线自检 `node scripts/field-test.ts --self-test` 则真的起 HTTP 服务并跑 VAD，验证「无语音不留盘」「多段语音全部送识别」等承诺。

### V0.3 P2 新增的测试面（插件内核 / MCP / 审批 / News / Reminder）

这些都在默认门禁（`npm test` 的六个 glob）里，不需要联网，也不用密钥：

| 面 | 文件（举例） | 覆盖什么行为 |
|---|---|---|
| 插件内核 | `tests/unit/plugins/{lifecycle,boundaries,context,capabilities,discovery,manifest}.test.ts` | 九步生命周期与每步的失败拒绝；四条「插件不能做」各有**坏输入必须被拦**的用例；五能力与七权限的配对；保留命名空间拒绝 |
| 插件工具接线 | `tests/unit/plugins/runtime-wiring.test.ts` | `buildPluginRuntime().start()` 之后插件工具真的在 `definitionsForRound` 里、且能被核心执行（这条是「内核已交付」与「入口已接线」的分界，别混） |
| MCP | `tests/unit/plugins/mcp/*.test.ts`（真 SDK v2 `McpServer` + `InMemoryTransport` 桩） | discover → 规范化 → 命名空间 `mcp.<server>.<tool>` → 注册表；连不上/空列表不崩；重连与 `status()`/`health()` 说真话；**不做高频总线**（空转零调用 + 源码探针） |
| 工具审批 | `tests/unit/core/tool-approval.test.ts`、`tests/unit/core/tool-registry.test.ts` | 七字段落库与重启取回；**冻结参数摘要对不上就零调用**；拒绝/到期不执行且都落审计；没声明就不 ASK；ask 不能放宽被 deny 的调用 |
| News | `tests/unit/core/tool-loop.test.ts`、`tests/unit/plugins/news/*.test.ts` | 三个工具离线端到端（桩来源）、RSS/Atom 夹具与坏文档降级、铁律 8 的不可信数据形态、四条主动判据与反例、账本记账、TopicSource |
| Reminder | `tests/unit/reminder/{store,time-resolution,scheduler,sink}.test.ts`、`tests/integration/reminder/durable-reminder.test.ts` | 八字段与五态迁移；自然语言 → 绝对时刻 + 时区（含「本机时区恰好等于请求时区」也要能证伪的边界）；**两进程真文件库**的重启与到点事件 |

判据口径与每一条的边界见 [`progress-v03.md`](progress-v03.md) 的 P2 段；**P2 的两个 pack 场景不在这张表里**
（它们要真模型 + 真库，属手动复验，见 [`verification/t14-p2-gate-independent-verification-2026-10-04.md`](verification/t14-p2-gate-independent-verification-2026-10-04.md)）。

## 3. 怎么跑

```powershell
npm test                 # 全部离线测试（unit + integration + perception + console）；项数以末行为准（2026-09-30 实测点 223 项全绿）
npm run test:unit        # 只跑 tests/unit/**（项数看末行）
npm run test:integration # 只跑 tests/integration/**
npm run test:scenarios   # tests/scenarios/**（语料模块，当前没有 *.test.ts，输出 0 项）
npm run test:replay      # tests/replay/**（目录仍为空）
npm run test:perception  # 只跑 tests/perception/**（会转发 Python 感知回归套件，需带 cv2 的 venv；项数看末行）
npm run test:console     # 只跑 tests/console/**（已在默认门禁里；项数以末行为准）

node --test "tests/console/**/*.test.ts"   # 等价的单目录跑法（也可用上面的 npm run test:console）
node --test tests/unit/contracts.test.ts   # 单文件

npm run demo:m0:text     # 离线单轮演示（FakeBrainAdapter，无需密钥）
npm run demo:m0:restart  # 离线两进程重启演示

# 现场测试（一条命令启动控制台；页面里点「开始设备自检」）
npm run field-test                          # http://127.0.0.1:8792，只监听本机
npm run field-test -- --offline             # 没有密钥也能跑通 UI（ASR/模型用替身）
npm run field-test -- --data-dir data/field-test-alt
                                            # 换控制台自己的库（默认 data/field-test）；在场状态用 --presence-data-dir（默认 data）
                                            # 不认识的参数会中文报错并 exit 2（列出可用参数），不再静默忽略
node scripts/field-test.ts --self-test      # 离线自检：隐私/多段语音/页面/报告（不碰硬件、不联网）
node scripts/field-test.ts --acceptance     # 只跑一次真机设备验收，重写 docs/recon/field-test-report-<日期>.md
# 注意：--self-test 的项数会随回归断言增加而变——以它最后一行的「自检结果：N 项通过」为准，**别把数字抄进任何文档**。
# 历史（只作参考，不是当前值）：t4 交付时 24 项，t6 的 F2/F6/F7 回归断言加进来后变成 31 项。
```

`npm test` 的 glob 包含 `tests/scenarios/**` 与 `tests/replay/**`——这两个目录目前都不产生用例
（前者是数据模块 `corpus.ts`，后者为空），所以以后往这两个目录加 `*.test.ts` 会被自动纳入全量测试，不需要改脚本。
`tests/console/**` 与 `tests/perception/**` **已在** glob 里（t16 起）——「测试写了就必须跑」是本项目的硬规矩，
它们要起 HTTP 服务 / Python 进程，所以是门禁里较慢的一批：t28 用「缩小输入（单档 tier + 最小夹具子集）+ 并发执行」
把它们从 53.3s 压到 21.5s（**历史数字**；t47 之后全量约 15s，见文档头部），没有把任何断言移出门禁。

### 3.1 怎么给 CLI / 试用页制造「超过跟进窗口的停顿」
会话的跟进窗口 = **`lingerMs`（默认 30s）×（0.5 + 人格 `silence_tolerance`）**——是「0.5 + t」不是「× t」，
实现在 [`packages/conversation/src/fsm.ts`](../packages/conversation/src/fsm.ts) 的 `lingerMs` getter（`Math.round(lingerMs * (0.5 + tolerance))`：
tolerance 0 → 半个窗口，1 → 1.5 倍）。本机人格 `silence_tolerance = 0.7` → 30s × 1.2 = **36 s**（`npm run chat` 启动横幅会打印）。
要触发「窗口过期 → 下一句被拒 / 被当作新会话直呼」这条路径，必须让**两轮之间的真实时间**超过它：

- **管道一次性喂 stdin 不行**（最常见写法见下）：readline 会把一次性写入的多行立刻按行交给会话，两行背靠背执行。
  本任务实测：`--fake` 离线路径两轮 `user` 事件时间戳只差 **4 ms**（整轮 0.3s 结束）；
  真实路径实测 wall **16.9s**，两轮之间只有模型自己那一轮的时间（约 6s）——**都远小于 36s 窗口**，所以永远触发不到过期路径。
  （t9 复核在真实路径上也观察到同向证据：壁钟 46s，而两条事件时间戳只差 6ms。）

  ```powershell
  "第一句`n第二句" | node scripts/chat.ts     # 两行一次性写进 stdin —— 造不出停顿
  ```
- **能真正造出停顿的两种做法**：
  1. **交互式终端**：`npm run chat`，输入第一句后**什么都不输**，等 **> 36 s**，再输入第二句；
  2. **试用页**：`npm run web`，两次请求（点击发送）之间等 **> 36 s**（页面每次点击就是一轮，等价路径）。
- 用「会 sleep 的脚本往管道里写」也能造出停顿——那是**写入方**在等，不是 readline 的功劳；
  判断依据始终是**两轮之间的真实间隔是否超过窗口**，而不是用了管道还是终端。

### 3.1 测试永远不写 household 库（V0.3 P0-B 起的硬约定）

- **默认库在测试里不是仓库里的那个**：`resolveCanonicalDataDir()` 在 `NODE_TEST_CONTEXT`（Node 测试 runner 会设）或
  `NODE_ENV=test` 时，把默认库落回**进程自己的临时目录**（`<tmp>/xixi-test-store-<pid>/data/xixi`）。这是防回归的关键：
  `scripts/serve-chat.ts` 在 **import 期**就建 store，没有这条守卫时 `npm test` 会往用户的 `data/xixi` 里写东西（P0-B 实测踩到过）。
- **要真库的用例自己显式给路径**：一律 `mkdtempSync(join(tmpdir(), …))`（或 `dbPath` 指到临时文件），不要依赖默认值；
  用 `XIXI_*_DATA_DIR` 显式隔离的例子见 `tests/unit/voice/voice-latency.test.ts`（spawn 的 `voice-turn` 用 `XIXI_VOICE_DATA_DIR`）。
- **判断有没有写脏**：跑完 `npm test` 后 `Test-Path data/xixi` 应当是 `False`。
- **记忆类用例必须是文件库**：`tests/integration/memory-correction-closure.test.ts` 用临时目录文件库，并有一条用例
  **关库再开**来守「重启后记忆仍在」；`:memory:` 的库一关就没，守不住这条验收。

## 4. 会花真实 API 调用的检查（刻意排除在 `npm test` 之外）

| 命令 | 真实调用次数 | 做什么 | 断言 |
|---|---|---|---|
| `npm run verify:provider` | **1 次** | 一次真实 turn：DSH → MiMo → 工具 `xixi_get_current_time` → 回答 | `ok`、`brainSessionId !== null`、`toolName === 'xixi_get_current_time'`、有最终文本 |
| `npm run verify:m0` | **2 次** | 两个独立进程的完整验收（§5） | 见 §5 的断言表 |

两者都需要 `MIMO_API_KEY`（`.env` 或环境变量；`scripts/lib/harness.ts` 的 `requireMimoApiKey()` 缺密钥时立刻报错），
超时上限 240s，诊断走 stderr。

**为什么排除**：§51 明确要求真实 API 测试不每个 PR 全跑，分成 offline CI / nightly online integration /
manual audio hardware tests 三档；`AGENTS.md` 第 2 节也要求「联网验证用 `npm run verify:*` 手动或夜间执行」。
另外三条现实理由：

1. **要钱、要网络、要密钥**——离线开发者（或密钥已轮换时）必须仍能跑完整测试。
2. **结果受服务端波动影响**——同一请求实测端到端 1.0–10.0s，且网关可能先发 `: PROCESSING` 保活
   （[`docs/recon/mimo-api-probe-2026-09-29.md`](recon/mimo-api-probe-2026-09-29.md) §6）。
3. **慢**——每轮一个 `dsh` 进程，整轮 4–6s；放进 `npm test` 会让反馈环从 1s 变成 20s+。

失败路径也已被真实跑过：用无效密钥跑 `verify:provider` 在 **3.9s** 内以退出码 1 失败，
`dsh` 保留原始错误（`AUTH: 401: Invalid API Key`），`DshBrainAdapter` 把它映射为
`BrainError('PROVIDER_FAILED')`（`docs/progress.md` §2.6）。

## 5. 两进程重启方法论

离线与联网两条路都用**同样的结构**：父进程 `spawn(process.execPath, [脚本, '--phase=…'])`
先后启动两个子进程，只通过 stdout 上的 `EVIDENCE ` 行交换 JSON 结果。

| | `npm run demo:m0:restart`（离线） | `npm run verify:m0`（真实） |
|---|---|---|
| 数据目录 | `data/demo-restart` | `data/`（`XIXI_DATA_DIR` 可覆盖） |
| 模型 | 无 | MiMo `mimo-v2.6-flash` |
| 进程 1 | 建会话、写两条轮次、写 health 事件 | 用户轮次 → DSH → MiMo → 工具 → 助手轮次 → health |
| 进程 2 | 重新打开同一 SQLite，报回会话/轮次/人格 | 问「只回复你上一条消息的完整内容本身」，必须逐字复现 |
| 断言 | 同一会话、轮次条数一致且非空、人格一致且非空 | 同一 `sess_…`、同一 harness 会话、`fresh.toolName === 'xixi_get_current_time'`、人格逐项一致、`normalize(resume.text) ⊇ normalize(fresh.text)`、`turnCount ≥ 4` |

为什么必须**两个操作系统进程**：断言写在父进程里，子进程看不到。
进程 2 无法从内存继承任何东西，也没有提示词告诉它答案；
它只能靠 `conversation_sessions.brain_session_id` 让 DSH 用 `--session-id` 载入同一段会话。
任何「同进程内假装恢复」的实现都会在这一步露馅。
比对时用 `normalize()` 去掉空白与标点，避免把模型输出格式的细微差别当成失败
（同时只要求**包含**关系，因为模型可能重排或补充少量字词）。

## 6. 已知缺口（诚实清单）

1. **没有类型检查门**：仓库没有 `tsconfig.json`，`npm test` 只做运行时校验，类型错误只在运行时暴露。
   M1 之前应补 `tsc --noEmit`，需要先评估 TypeScript 7 与「相对导入必须带 `.ts` 扩展名」的兼容
   （[ADR-0006](adr/0006-runtime-and-dependency-choices.md)、`docs/progress.md` 第 6 节）。
2. **`tests/replay/` 为空**（`tests/scenarios/` 有语料 `corpus.ts`，但两者都不产生用例）：§22.3 的「事件区间重放 → 复现决策」属 M5，
   §32/§15 的场景测试同样等 M5 的模拟器。当前 `npm test` 的 glob 已经预留，不需要改脚本。
3. **没有「真设备」自动化测试**：`tests/audio-fixtures/` 与噪声夹具**已经存在**（**35 个 wav**：顶层 5 个中文夹具 + `noisy/` 30 个噪声夹具，含 6 档 SNR；
   复现：`(Get-ChildItem tests/audio-fixtures -Filter *.wav -File).Count` → 5，`(Get-ChildItem tests/audio-fixtures/noisy -Filter *.wav -File).Count` → 30，两者相加 35），
   前端 DSP、VAD 参数与噪声 pipeline 也都有离线断言（`tests/unit/voice/frontend.test.ts`、`npm run voice:bargein`）；
   **缺的是不需要人参与的真机回归**——麦克风电平、扬声器回环、摄像头取帧目前只由 `scripts/field-test.ts --acceptance` 手工跑一次，
   没有进 `npm test`（需要真机与 Python 3.12 venv，见 [`voice.md`](design/voice.md) 与 [`perception.md`](design/perception.md)）。
4. **没有 model contract corpus**：§52 的 `tests/model_contract/*.jsonl` 尚未建立；
   目前对模型行为的约束只体现在两个 `verify:*` 脚本的断言与 `test:unit` 的结构校验上。
5. **没有真实 Harness 的自动化测试**：`tests/unit/transport.test.ts` 只解析样例 NDJSON；
   真正 spawn `dsh` 的行为只在 `verify:*` 里被验证（那需要密钥与网络）。
6. **没有覆盖率统计**：不引入 `c8` / `nyc` 这类依赖（铁律 12），当前靠测试清单本身判断覆盖面。
7. **`npm test` 不检查 DSH profile 是否装好**：`node scripts/install-dsh-profile.ts --check`
   会 `--dump-config` 并断言 `dsh-llm-pi-ai` / `xixi-tools` / `openai-completions` / `mimo-v2.6-flash`
   四个标志存在；它需要 DSH 已安装，因此没有放进离线测试。

## 7. 2026-09-30 新增：对话层、语音闭环与评测

> 结果数字见 [`progress.md` §0](progress.md)，这里只说明「怎么测、成本多少、有什么坑」。

### 新增测试文件

> 下表是「这一批新增了哪些文件、各自覆盖什么」的快照，**项数一列故意不写当前值**（它随时会变）：要数字就跑
> `node --test <该文件>` 看末行。

| 文件 | 覆盖 |
|---|---|
| `tests/unit/conversation-fsm.test.ts` | IDLE 需唤醒/直呼、已开会话可继续、静默容忍缩放跟进窗口、安静模式到期与解除 |
| `tests/unit/prompt.test.ts` | 硬策略在场、人格→具体指令、同一人格前缀逐字节稳定、情境含时段/星期、sections 可寻址 |
| `tests/unit/tools.test.ts` | 天气码中文、默认地点与显式地点、未知地点是类型化拒绝、预报缓存、参数封闭、只读约束 |
| `tests/integration/conversation-engine.test.ts` | 未直呼不写入日志、多轮连续性与工作记忆、跨分片的 `[静默]` 兜底、安静模式、长停顿后需重新直呼；t41 追加多段回复的 5 项（段数与单段上限、`onSegment` 逐段播放、SILENCE 无段、部分失败仍结束该轮） |
| `tests/unit/voice/frontend.test.ts` | 抗噪前端：转发 `services/voice-edge/tests/test_frontend.py` 的 39 项 DSP 单测（去直流/高通/噪声底/谱减法/参数推导/夹具生成），断言噪声夹具与 manifest 自洽、困难档不被删除、相似度评分定义，并**真的执行** `verify-voice-noise.ts` 的四条行为断言（离线管线结论与 exit code 一致、结构性失败 exit 1、空选择档不谎报边界、噪声档 `vadEndpointDelayMs` 非零且量级正确）。为控制门禁耗时，这些 shell-out 检查在同一个并发父测试里跑、并按参数复用进程（t28：该文件 15.9s、全量门禁 21.5s；**t47 之后**该文件约 9s、全量约 15s） |
| `services/voice-edge/tests/test_frontend.py` | 纯函数离线单测（**39 项是 2026-09-30 的一次实测点**；由上面那条转发执行，不单独出现在 `npm test` 的 glob 里） |

### 测量方法上的坑（踩过，写下来）

- **能量阈值不是人工标注**：起点/端点用帧能量估计，误差约一帧（32ms），是测量里最弱的一环。
  早期实现把这个阈值**写死 −40 dBFS**；2026-09-30 之后改为由噪声底推导（`max(噪声底,−70) + 余量`，见 [design/voice.md](design/voice.md) §1.1（3）），
  旧值仍以 `rawEnergyStartMs`/`rawEnergyEndMs` 输出，方便与历史数字对比——**引用旧报告里的 −40 dBFS 时要说明它是历史口径**。
- **同一段代码的两种「降噪」结论必须分开写**：高通把宽带噪声降 5.3 dB，但 VAD 判定几乎不变；
  谱减法噪声带只降 0.5–2 dB 且在 3 dB SNR 上让 ASR 变差（默认关闭）。把「电平下降」当成「识别变好」是错的。
- **VAD 冷启动与流式成本必须分开**：`segment.py` 输出 `loadMs`（模型加载）与 `processMs`（逐帧），只有后者算实时延迟；否则会把一次性的 Python 启动算进 SLA。
- **MiMo 会「一句话 + 工具调用」同时返回**，所以「有文本」不等于「已回答」——这曾导致工具永远不执行（`probe-tools.ts` 就是为了复现它）。
- **MiMo 结构化输出会间歇性补白截断**（`json_schema`，`strict` 与否都出现过）：所有结构化结果必须本地校验，`chatJson` 负责回退，评审失败按「未测量」计并限制在 1 次以内。
- **语料不能假设时钟**：早期场景名写「疲惫的晚上」，实际评测在早上跑，模型正确地指出真实时间，评审却判为矛盾——语料只固定行为期望，不固定世界状态。

### 新增验证脚本（都会花钱或有副作用，不进 `npm test`）

| 脚本 | 花费 | 说明 |
|---|---|---|
| `npm run eval:conversation` | ~20 次调用 | 结构检查：接受/拒绝规则、泄露/客服腔/复读、长度、连续性、人格效果、延迟 |
| `npm run eval:conversation:judge` | +6 次评审 | 追加评审模型打分（自然度/连贯性/像不像家里人），报告写入 `docs/recon/` |
| `npm run voice:turn -- --wav a.wav --wav b.wav` | ASR+N 轮对话+TTS | 语音闭环，只上传 VAD 检测到的语音段 |
| `npm run voice:bargein` | 0 | 打断判定延迟；写出被截断的播放音频作为证据 |
| `npm run verify:structured-output` | 3~4 次 | 结构化输出契约 + MiMo 缺陷金丝雀 |
| `npm run chat` / `--fake` / `--dsh` / `--print-wiring` | 每次一轮 | 交互式验证；`--fake` 完全离线（注入内存天气源）；`--print-wiring` **0 成本**：打印 `{entry,language,maxToolRounds,tools,permissions}` 后退出 |
| 四个 live 入口的 `--print-wiring` | **0**（离线：不调模型、不建库） | **工具链覆盖的离线自证**（第四轮 t2）：`scripts/chat.ts` / `voice-device-check.ts` / `eval-realism.ts` / `eval-conversation.ts` 各打印一行，实测四行逐字相同（`language` 取自部署配置、`maxToolRounds: 4`、**三个内置工具**、三个 `allow`——P2-D 删掉新闻桩之前是四个；**不含插件/MCP 工具**，因为入口还没走 `buildPluginRuntime`），并与 `scripts/field-test.ts` 的 `buildToolChain(loadConfig())` 逐字段相等（离线用例 `tests/console/live-entry-tool-chain.test.ts`）。**设备自检没有离线端到端证据**（要真实 WAV + 硬件 + 真实 ASR），它的证据就是这一行 + 与适配器共用一个 `deviceToolChain` 调用点 |
| `npm run web` / `npm run web -- --dsh` | 每次一轮 | 浏览器试用页（http://127.0.0.1:8791）；`--dsh` 切到 Harness 路径 |
| `POST /api/voice`（试用页的🎤） | ASR + 一轮 | 浏览器采集 → VAD 只取语音段 → ASR → 对话 → TTS；无语音时返回 `NO_SPEECH_DETECTED` 而不是假装听懂 |
| `scripts/voice-device-check.ts` | ASR + 一轮 | 设备验收：对回环录音跑全链路并与原文比对字符级相似度（≥0.5 判 PASS） |
| `node scripts/verify-voice-noise.ts` | 4 条干净 + 20 条噪声夹具 × 1 次 ASR（默认 5 档） | **噪声鲁棒性回归**：干净与噪声夹具分别跑前端→VAD→ASR，输出转写、字符级相似度、端点延迟、失败清单与成功边界；`--nr` 切去噪做 A/B，`--fake`/`--dry-run` 完全离线 |
| `npm run voice:noise -- --fake` | **0**（离线桩，不联网、不花钱） | **离线管线校验，不是噪声鲁棒性判定**：ASR 被替换成确定性桩，所以**相似度判据与检出率在离线模式不适用，只作为观察记录**（报告里 `mode=offline-plumbing`、`quality.applies=false`、`criteria.transcriptSimilarity.applies=false`），只要管线跑通（≥1 条夹具 + 没有端点延迟类结构性问题）就**以 exit 0 结束**；要拿到**真实的噪声边界与判定**必须去掉 `--fake` 跑真实 ASR。失败判定本身没变：真实模式下任何一条夹具失败仍然 exit 1（结构性问题在离线模式下也仍然 exit 1） |
| `python -m voice_edge.calibrate --seconds 5` | 0（只碰麦克风） | 噪声底校准：输出分带能量、噪声底与建议参数 JSON；`--list-devices` 列设备（WASAPI 优先） |
| `python -m voice_edge.make_noise_fixtures --force` | 0 | 用实测环境噪声重建 `tests/audio-fixtures/noisy/` 与 `manifest.json`（5 夹具 × 6 档 SNR） |
| `python -m voice_edge.loopback <wav> <out.wav>` | 0 | 扬声器播放 + 麦克风录回；相对判据（语音带抬升 ≥10 dB 或相关 ≥0.3）+ Core Audio 静音状态；`verdict` 不是 `ok` 时说明是「静音端点」「音量不足」还是「没渲染」 |
| `npm run turns -- data/chat/xixi.sqlite 6` | 0 | 直接查事件日志里的最近轮次（含 `tool_name` 审计） |
| `node scripts/probe-tools.ts` | 2 次 | 诊断「模型有没有请求工具、适配器有没有真的执行」 |
| `node scripts/eval-realism.ts --corpus=all --repeat=3 --label v02` | 84 轮 × 3 次 | **真人感指标**：跑 pack 的 12 条黄金对话 + 仓库语料，输出提问率（主口径＝末句以问号收尾；辅口径＝含问号）、回复长度四档分布、禁用模板出现率、沉默率、重复短语与交付分段；写 `docs/benchmarks/realism-<日期>-<label>.{md,json}`。`--replay <旧 JSON>` **不花钱复算**（`--re-render` 顺带用当前渲染器重写报告）、`--fake` 离线自检（**要加 `--out %TEMP%\<dir>`**，别往 `docs/benchmarks/` 写一次性产物）、`--no-gate` 只测量。口径、局限与前后对比见 [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md) |
