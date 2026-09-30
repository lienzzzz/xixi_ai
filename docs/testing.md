# 测试

> 最后更新：2026-09-30
> 权威来源：`tests/**`、`scripts/**`、`package.json` 的脚本；与代码不一致时以代码为准并立即修正本文
> 当前状态：`npm test` → **63 项全绿**，耗时 <1s，**不发起任何网络请求**。
> 实测结论集中在 [`progress.md` §0](progress.md)：对话质量、语音闭环、打断与结构化输出都有单独脚本与证据。
> 上游依据：《方案》§51（CI / Regression）、§52（Model Contract Testing）、§22.3（Event Replay）、§33（PoC 指标）。
> 相关：[`architecture.md`](architecture.md)、[`event-contracts.md`](event-contracts.md)、[`ADR-0006`](adr/0006-runtime-and-dependency-choices.md)、[`ADR-0008`](adr/0008-realtime-path-direct-mimo.md)。

## 1. 分层地图

| 层 | 目录 | 跑什么 | 是否联网 | 现在有什么 |
|---|---|---|---|---|
| 单元 | `tests/unit/` | 契约校验、领域持久化、transport 解析、会话 FSM、Prompt 组装、工具 | 否 | 6 个文件、42 项 |
| 集成 | `tests/integration/` | BrainAdapter ↔ transport ↔ store、会话引擎、离线重启恢复 | 否 | 3 个文件、21 项 |
| 场景 | `tests/scenarios/` | 对话语料（8 场景，数据驱动），由 `scripts/eval-conversation.ts` 执行 | 执行时联网 | `corpus.ts`（不再是空目录） |
| 回放 | `tests/replay/` | 导出事件区间 → 重放 → 复现决策（§22.3） | 否 | **空**（属 M5） |
| 真实 API 验收 | `scripts/verify-*.ts`、`eval-conversation.ts`、`voice-*.ts` | 真实 MiMo 调用、语音闭环、打断 | **是** | 见下方「新增验证脚本」，**都不在 `npm test` 里** |

全部测试用 Node 内置 `node:test` + `node:assert/strict`，直接执行 `.ts`（无构建步骤，[ADR-0006](adr/0006-runtime-and-dependency-choices.md)）。
模型相关测试遵守 §51：验证**结构与行为**（`action` 取值、`toolName` 是否被调用、字段是否落在范围内），
不做字符串相等断言。

## 2. 每个测试文件覆盖什么

### `tests/unit/smoke.test.ts`（1 项）

workspace 解析与 Node 原生类型擦除可用：能 `import { EVENT_SCHEMA, SCHEMA_VERSION } from '@xixi/contracts'`
并断言 `'xixi.event.v1'` / `1`。它失败通常意味着 `npm install` 的 workspace 链接没建好。

### `tests/unit/contracts.test.ts`（12 项）

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

### `tests/unit/domain.test.ts`（10 项）

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

### `tests/unit/transport.test.ts`（5 项）

`parseDshJsonLines` 对 `dsh --json` 的 NDJSON 解析：非 JSON 的诊断行**不会**变成事件
（`raw.length === 5`）、`session` 事件给出 `sessionId`、`tool_call` 收集工具名与 `callId`、
`final` 给出最终文本、`error` 事件被当作失败原因。
`CliDshTransport.composeTask` 必须带上身份 / 人格键值 / 时区 / 最近对话 / 用户输入。
另两项：显式给错的 DSH 入口路径 → `BrainError('TRANSPORT_FAILED')`；
`cwd` 不存在 → 构造时就拒绝（不会 spawn 一个必然失败的子进程）。

这是**纯离线**的：它不 spawn 真的 `dsh`，只解析样例字符串。真实 spawn 走 `verify:*`。

### `tests/integration/brain-adapter.test.ts`（5 项）

适配器与 store 的接线：第一轮 `resumeBrainSessionId === null`（不许假装恢复）、
第一轮结束后映射落库（`store.brainSessionId(sess, 'dsh')`）、
第二轮带着同一 id resume；工具调用同时以 `{ type:'tool' }` chunk 和结构化 `toolName` 暴露；
transport 抛错 → `TRANSPORT_FAILED`、provider 返回失败 → `PROVIDER_FAILED`（保留原始 code）；
**requestId 不匹配 → `INVALID_RESPONSE`**；
`interpretFeedback` / `evaluateProactiveCandidate` → `NOT_IMPLEMENTED` 且 `milestone` 分别是 `M3` / `M5`。

用 `ScriptedDshTransport`（[`packages/brain-adapter/src/scripted.ts`](../packages/brain-adapter/src/scripted.ts)）
当离线替身，它模仿 harness 的会话语义：第一轮铸造 id，之后沿用被 resume 的 id，并记录每个请求。

### `tests/integration/restart-recovery.test.ts`（3 项）

进程内模拟的两段式恢复：进程 1 建会话、种子人格、写用户轮次、跑一轮适配器并写助手轮次，然后 `close()`；
进程 2 打开**同一个 SQLite 文件**，断言迁移未重跑、`resume()` 拿回同一会话/2 条轮次/人格、
harness 映射仍在，并把持久化的 harness 会话原样交给 transport。
第二项：每次启动都 `seedSelfProfile` 是**恢复而不是重置**（旧值保留、不伪造变更记录）。
第三项：`FakeBrainAdapter` 的确定性行为（`你好` → `SPEAK` + `模拟回复：你好`；空白 → `SILENCE`；`/tool …` → `TOOL`）。

真正的跨进程版本是 `demo:m0:restart`（离线）与 `verify:m0`（真实模型），见 §5。

## 3. 怎么跑

```powershell
npm test                 # 全部离线测试（unit + integration + scenarios + replay），当前 36 项
npm run test:unit        # 只跑 tests/unit/**
npm run test:integration # 只跑 tests/integration/**
npm run test:scenarios   # tests/scenarios/**（当前为空）
npm run test:replay      # tests/replay/**（当前为空）

node --test tests/unit/contracts.test.ts   # 单文件

npm run demo:m0:text     # 离线单轮演示（FakeBrainAdapter，无需密钥）
npm run demo:m0:restart  # 离线两进程重启演示
```

`npm test` 的 glob 已包含 `tests/scenarios/**` 与 `tests/replay/**`——目录当前为空，
所以现在多加一个用例就会自动被纳入全量测试，不需要改脚本。

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
2. **`tests/scenarios/` 与 `tests/replay/` 为空**：§22.3 的「事件区间重放 → 复现决策」属 M5，
   §32/§15 的场景测试同样等 M5 的模拟器。当前 `npm test` 的 glob 已经预留，不需要改脚本。
3. **没有音频 / 语音测试**：没有 `tests/audio-fixtures/`，也没有 VAD / ASR / TTS / barge-in 用例——
   语音链路本身在 M0 不存在（M1，且本机需先装 Python 3.10–3.12）。
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

| 文件 | 项数 | 覆盖 |
|---|---:|---|
| `tests/unit/conversation-fsm.test.ts` | 7 | IDLE 需唤醒/直呼、已开会话可继续、静默容忍缩放跟进窗口、安静模式到期与解除 |
| `tests/unit/prompt.test.ts` | 5 | 硬策略在场、人格→具体指令、同一人格前缀逐字节稳定、情境含时段/星期、sections 可寻址 |
| `tests/unit/tools.test.ts` | 7 | 天气码中文、默认地点与显式地点、未知地点是类型化拒绝、预报缓存、参数封闭、只读约束 |
| `tests/integration/conversation-engine.test.ts` | 8 | 未直呼不写入日志、多轮连续性与工作记忆、跨分片的 `[静默]` 兜底、安静模式、长停顿后需重新直呼 |

### 新增验证脚本（都会花钱或有副作用，不进 `npm test`）

| 脚本 | 花费 | 说明 |
|---|---|---|
| `npm run eval:conversation` | ~20 次调用 | 结构检查：接受/拒绝规则、泄露/客服腔/复读、长度、连续性、人格效果、延迟 |
| `npm run eval:conversation:judge` | +6 次评审 | 追加评审模型打分（自然度/连贯性/像不像家里人），报告写入 `docs/recon/` |
| `npm run voice:turn -- --wav a.wav --wav b.wav` | ASR+N 轮对话+TTS | 语音闭环，只上传 VAD 检测到的语音段 |
| `npm run voice:bargein` | 0 | 打断判定延迟；写出被截断的播放音频作为证据 |
| `npm run verify:structured-output` | 3~4 次 | 结构化输出契约 + MiMo 缺陷金丝雀 |
| `npm run chat` / `--fake` / `--dsh` | 每次一轮 | 交互式验证；`--fake` 完全离线 |
| `npm run web` / `npm run web -- --dsh` | 每次一轮 | 浏览器试用页（http://127.0.0.1:8791）；`--dsh` 切到 Harness 路径 |
| `POST /api/voice`（试用页的🎤） | ASR + 一轮 | 浏览器采集 → VAD 只取语音段 → ASR → 对话 → TTS；无语音时返回 `NO_SPEECH_DETECTED` 而不是假装听懂 |
| `scripts/voice-device-check.ts` | ASR + 一轮 | 设备验收：对回环录音跑全链路并与原文比对字符级相似度（≥0.5 判 PASS） |
| `python -m voice_edge.loopback` | 0 | 扬声器播放 + 麦克风录回；`verdict` 为 `silent-capture` 即麦克风没有信号 |
| `npm run turns -- data/chat/xixi.sqlite 6` | 0 | 直接查事件日志里的最近轮次（含 `tool_name` 审计） |
| `node scripts/probe-tools.ts` | 2 次 | 诊断「模型有没有请求工具、适配器有没有真的执行」 |

### 测量方法上的坑（踩过，写下来）

- **能量阈值不是人工标注**：起点/端点用 −40 dBFS 帧能量估计，误差约一帧（32ms），是测量里最弱的一环。
- **VAD 冷启动与流式成本必须分开**：`segment.py` 输出 `loadMs`（模型加载）与 `processMs`（逐帧），只有后者算实时延迟；否则会把一次性的 Python 启动算进 SLA。
- **MiMo 会「一句话 + 工具调用」同时返回**，所以「有文本」不等于「已回答」——这曾导致工具永远不执行（`probe-tools.ts` 就是为了复现它）。
- **MiMo 结构化输出会间歇性补白截断**（`json_schema`，`strict` 与否都出现过）：所有结构化结果必须本地校验，`chatJson` 负责回退，评审失败按「未测量」计并限制在 1 次以内。
- **语料不能假设时钟**：早期场景名写「疲惫的晚上」，实际评测在早上跑，模型正确地指出真实时间，评审却判为矛盾——语料只固定行为期望，不固定世界状态。
