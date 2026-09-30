# 进度与交接记录

> 更新规则：每完成一个可独立理解的步骤就立刻追加/更新本文，写清「做了什么、验证结果、下一步、已知问题」。
> 这台机器偶发蓝屏，**本文是崩溃后恢复工作的唯一依据**。
> 最近更新：2026-09-30 08:3x — **初步验证阶段达成：文本对话流畅 + 语音闭环 + 打断可测**

## 0. 初步验证阶段结论（objective）

| 能力 | 证据 | 状态 |
|---|---|---|
| 文本多轮对话（无需每句唤醒） | `npm run eval:conversation:judge`：8 场景 / 20 轮，接受 18、拒绝 2（电视音频与安静模式） | ✅ |
| 「像人说话」 | 评审模型：自然度 4~5、连贯性 4~5、**7 个场景全部判定为「像家里人」** | ✅ |
| 沉默是一等输出（§55） | 「嗯，知道了」→ 沉默；连续应和场景出现 SILENCE | ✅ |
| 人格真的改变行为（§39.4） | 同题对比：低话多组平均 22.3 字 vs 高话多组 57.3 字（**2.57×**） | ✅ |
| 真实能力而非空谈 | 天气工具（Open-Meteo，只读）被真实调用：回答用的是 19~25℃、降雨概率 8% 的真实预报 | ✅ |
| 语音闭环 | 夹具音频 → VAD → ASR → 对话 → TTS，端到端 3.6~5.5s（含冷启动），ASR 中文转写正确 | ✅ |
| 打断 | 离线模拟：判定延迟 **192ms**（§33 目标 <500ms），播放截断于 992ms，丢弃 4128ms 未播音频 | ✅（判定层面） |
| 重启恢复 | 两个独立进程，第二个逐字复现第一个的回答（M0 验收，`npm run verify:m0`） | ✅ |
| 主动问候 / 长期记忆 / 唤醒词 | 未实现（M2~M5），本轮刻意不做 | ⛔ |
| 真实麦克风 / 扬声器 | **测了但链路无信号**：录音 99.5% 能量在 100Hz 以下，VAD 与 ASR 都取不到语音。原因定位到机器音频配置（音量/静音/设备），复现命令见 [device-acceptance 报告](recon/device-acceptance-2026-09-30.md) | ⛔ 待用户开麦 |

综合延迟（干净环境）：对话总时长 P50 2.5s / P95 5.1s，首字 P50 1.2s / P95 2.9s；语音链路里 VAD 判定 ~192ms、ASR 0.34~0.73s、LLM 首字 1.7~2.3s、TTS 1.0~2.0s。
**尚未验收**：扬声器真正静音的延迟、唤醒词、电视误触率；真实麦克风链路已测但无信号（见上表与设备验收报告）。


## 0. M0 验收结论

`node scripts/verify-m0.ts` 用**两个独立的操作系统进程**跑通（方案 §34 的 M0 验收）：

| 阶段 | 结果 |
|---|---|
| 进程 1（fresh） | 文字 → DSH → MiMo `mimo-v2.6-flash` → 工具调用 `xixi_get_current_time` → 回答 `2026-09-29T15:13:51.620Z`，latency 6.3s，事件 3 条 |
| 进程 2（resume，全新进程） | 同一 `sess_6a233a16-…`、同一 DSH 会话 `session-a75b1195-…`；被问「你上一条回复的是什么」时**逐字复现**进程 1 的回答；人格 9 项与进程 1 一致；turnCount 4、事件 6 条 |

即「输入文字 → DSH → MiMo → structured tool → answer；restart → session recover」成立，且不是同进程内的假恢复。
另有 `npm run verify:provider`（一次真实调用）单独证明路由 + 工具调用可用。
离线测试 `npm test`：**36 项全部通过**（contracts 12 / domain 9 / transport 5 / adapter 5 / restart 3 / smoke 1 + 其他）。

## 1. 里程碑状态

| 里程碑 | 状态 |
|---|---|
| M0 DSH + MiMo 文本 Harness | **已完成（验收通过）** |
| M1 前置 spike（Python + 语音框架选型） | **已完成**：ADR-0007 选 Pipecat，参数与结论均有实测支撑 |
| M1 语音闭环（VAD→ASR→对话→TTS + 打断） | **基本可用**：离线夹具链路通过，判定延迟 192ms；真实麦克风/扬声器未验收 |
| 对话层（会话 FSM + Prompt 组装 + 工具） | **已完成**：多轮连续性、沉默、人格可调、只读工具 |
| M2 唤醒词 / M3 人格学习 / M4 记忆 / M5 主动 | 未开始 |

仓库：`E:\worker2`。独立项目，**不依赖** `E:\worker` 的「m」原型（其方向已偏离需求）。

## 2. 已完成并已验证

### 2.1 环境事实（详见 [AGENTS.md](../AGENTS.md) 第 4 节）

- DSH `@deepseek-ai/dsh` **0.1.7-rc.2**（Developer Preview / RC），项目内 DSH_HOME = `<repo>/.dsh`（已 gitignore）。
- Node v24.21.0 原生运行 `.ts`（无需编译）；`node:sqlite`（SQLite 3.53.4，JSON1）可用 → M0 运行时只依赖 `js-yaml`。
- 本机**没有 Docker / mosquitto / ffmpeg**；仅有 Python 3.14.7。
- 显卡 GTX 1050 Ti 4GB + Intel HD 630；外网可能需要代理 `127.0.0.1:7890`。

### 2.2 DSH 集成配方（已落地，可复现）

1. `scripts/install-dsh-profile.ts`（幂等）：
   - 用 `dsh --profile xixi --from-default-profile headless`（非交互）建 profile；
   - `dsh.profile.bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless, dsh-xixi-tool]`（最小插件集）；
   - 复制仓库持有的 patch `apps/brain-dsh/profile/cordis.patch.yml`；
   - junction `profiles/xixi/node_modules/dsh-xixi-tool → plugins/xixi-tools`；
   - 最后 `--dump-config` 自检：必须同时出现 `dsh-llm-pi-ai`、`xixi-tools`、`openai-completions`、`mimo-v2.6-flash`。
2. MiMo 路由**只是配置**（`@deepseek-ai/dsh-llm-pi-ai` 已随 dsh-base 挂载），不需要自写 provider 插件：
   `api: openai-completions`、`baseURL: https://api.xiaomimimo.com/v1`（不带 `/chat/completions`）、`apiKeyEnv: MIMO_API_KEY`。
3. 凭据解析顺序（DSH 凭据 seam）：**进程环境快照** → `$DSH_HOME/.credentials.yaml` → **`<cwd>/.env`** → `$DSH_HOME/.env`。
   因此把 `.env` 放在仓库根、并以仓库根为 cwd 启动 `dsh` 即可；注意环境变量是**启动时快照**，启动后再 export 无效。
4. 工具插件：`plugins/xixi-tools`（`defineTool` + `dsh.bundle.patch`），`@deepseek-ai/dsh-tools@0.1.7-rc.2` 作为 devDependency 固定在仓库根，插件 import 自然解析。
5. 一轮对话：`node <dsh>/lib/bin.js --profile xixi --json [--session-id <id>] "<task>"`；stdout 是 NDJSON
   （`session` / `status` / `thinking` / `tool_call` / `tool_result` / `text` / `final`），`final.text` 是回答。
6. **恢复会话的约束**：必须同一 cwd、同一 profile 组合，且 `--session-id` 要带。会话落盘在
   `$DSH_HOME/sessions/<escaped-cwd>/<id>/session.v4.jsonl.zstd`（磁盘代次是 v4，比打包文档写的 v3 新）。
7. `--profile web` **不能**跑 headless 单轮（它只有 server 参数），所以西西用自建 profile `xixi`。
8. 权威原始报告：[docs/recon/dsh-integration-2026-09-29.md](recon/dsh-integration-2026-09-29.md)。

### 2.3 MiMo API 事实（已实测，权威报告 [docs/recon/mimo-api-probe-2026-09-29.md](recon/mimo-api-probe-2026-09-29.md)）

- 鉴权：`api-key:` 与 `Authorization: Bearer` **都可用**；错误密钥 → 401 `Invalid API Key`。
- 模型清单：`GET /v1/models` → **404**，`GET /models` → 200（含 `mimo-v2.6-flash`、`mimo-v2.5-asr`、`mimo-v2.5-tts` 等 9 个）。
- 工具调用：标准 OpenAI `tool_calls` 形状可用，`role:"tool"` 回传可用；
  **但 `tool_choice` 除 `auto` 外全部被静默忽略**（无法用强制调用当硬门禁），必须靠提示词驱动 + 自行校验 `tool_calls`。
- 结构化输出：`response_format` 的 `json_schema` 与 `json_object` 都可用；`strict` 是否真正强制未证实 → **必须在本地校验**（我们的 `@xixi/contracts` 正是干这个）。
- 流式：SSE 可用，最后一个 chunk 带 usage（无需 `include_usage`）；偶发先来一行 `: PROCESSING` 保活。
- **思考默认开启**：`thinking:{"type":"disabled"}` 或 `reasoning_effort:"none"` 才能真正关闭（`reasoning_tokens: 0`）；`enable_thinking` / `thinking_budget` 被接受但**被忽略**。
- 输出上限 131072；思考开启时 `max_completion_tokens` 过小会导致 `finish_reason=length` 且 **content 为空**。
- 该密钥**没有**服务端联网搜索权限（`webSearchEnabled is false`，body/header 都打不开）。

### 2.4 关键修复：真正关闭深度思考（方案 §46.1）

现象：即使路由写了 `reasoning: off`，`dsh --json` 仍输出 `thinking` 事件，模型确实在思考（outputTokens 16）。
根因：**手写声明的模型条目默认被视为「不具备推理能力」**（`PiAiModelProfile.reasoningEfforts` 缺省即无推理），
于是 pi-ai 不会走 `thinkingFormat: deepseek` 分支，也就不会下发 `thinking:{type:"disabled"}`。
修法：模型条目声明
```yaml
reasoningEfforts: { off: 'none', high: 'high' }
compat: { thinkingFormat: deepseek, requiresReasoningContentOnAssistantMessages: true }
```
效果（实测）：`thinking` 事件消失、outputTokens 16 → **2**、整轮耗时 7.5s → 4.4s。
注：只写 `off` 会被 pi-ai 拒绝（要求至少声明一个「off 之外」的档位），故同时声明 `high` 供后台反思使用。

### 2.5 代码资产

- `packages/contracts`：`xixi.event.v1` 信封（§23.2）+ 3 个事件类型（`presence.changed` / `conversation.turn`（含 `SILENCE`，§55）/ `system.health`）；
  自写 JSON Schema 子集校验器，**fail-closed**：未实现的关键字直接抛 `UNSUPPORTED_SCHEMA_KEYWORD`，加载 schema 时即检查；
  时间戳必须带数字偏移（不接受 `Z`）；有注册表/枚举/actor 列表的漂移检查。
- `packages/domain`：迁移执行器（逐条事务 + sha256；已应用迁移被改写就拒绝启动）、`events` / `conversation_sessions` / `self_profile` / `self_profile_history`。
  **不建 `conversation_turns`**：对话轮次就是事件，避免两份真相。`recordTurn` 在同一事务内追加事件并更新投影。
  `seedSelfProfile` 只补缺不覆盖。会话表带 `brain_provider` + `brain_session_id`（换 Harness 不丢会话）。
  21 个人格属性与范围来自方案 §7.2；**学习/调整引擎未实现**（属 M3）。
- `packages/brain-adapter`：§25 的 `BrainAdapter` 接口（`handleUserTurn` 已实现；`evaluateProactiveCandidate` / `interpretFeedback` / `extractMemories` / `reflect` 已声明，
  调用时抛 `NOT_IMPLEMENTED` 并注明里程碑）、`FakeBrainAdapter`（离线确定性）、`ScriptedDshTransport`（离线测试替身）、`DshBrainAdapter`（会话映射的读写方）。
- `apps/brain-dsh`：`CliDshTransport`（每轮一个进程，天然满足「重启即续会话」；M1 因延迟需求会改为常驻宿主）、`parseDshJsonLines`、`composeTask`（M0 的上下文拼装占位，§26 的正式拼装属 M1）、`profile/cordis.patch.yml`。
- `scripts/`：`install-dsh-profile.ts`、`verify-provider-route.ts`、`verify-m0.ts`、`demo-m0-text.ts`、`demo-m0-restart.ts`、`lib/harness.ts`（.env 读取、路径、证据打印）。
- 文档：`docs/adr/0001–0006`、`docs/architecture.md`、`docs/event-contracts.md`、`docs/testing.md`、`docs/recon/*`。

### 2.6 故障路径（已实测）

用无效密钥跑 `verify:provider`：**3.9 秒**内失败、退出码 1、不挂起、不重试风暴，且保留了 provider 的原始错误
（`dsh: AUTH: 401: Invalid API Key`）。`DshBrainAdapter` 把它映射为 `BrainError(PROVIDER_FAILED)`；
传输层失败（无法启动 / 超时）映射为 `TRANSPORT_FAILED` / `TIMEOUT`（方案 §21 的降级设计有了可用的失败语义）。

### 2.7 M1 前置：Python 与语音框架（进行中）

- **Python 3.12.10 已安装（用户级，无需管理员）**：
  `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`（winget `Python.Python.3.12 --scope user`）。
  注意：DSH 宿主进程的环境变量是启动快照，新开的 pwsh **不一定**能看到 PATH 里的 `python3.12`，脚本里请用绝对路径。
- **两个隔离 venv（互相不污染依赖）**：
  - `E:\worker2\.venvs\voice-pipecat`：pipecat-ai **1.12.0**、onnxruntime 1.24.4、numpy 2.5.3、soundfile/soxr（无 torch）
  - `E:\worker2\.venvs\voice-livekit`：livekit-agents **1.8.3**、livekit-plugins-turn-detector 1.8.3、livekit-plugins-silero 1.8.3、livekit-local-inference 0.2.7、onnxruntime 1.30.0、transformers 5.17.0、sounddevice 0.5.6、av 19.0.0（无 torch）
  - `.venvs/` 与 `.spike/` 已 gitignore。
- **中文音频夹具已生成**（`node scripts/make-audio-fixtures.ts`，用 `mimo-v2.5-tts` 合成，24 kHz 单声道 16-bit，共 5 条）：
  `tests/audio-fixtures/{direct-question,followup-turn,backchannel,longer-turn,tv-dialogue}.wav`。
  用途：M1 的 VAD/断句/打断测量，以及 M2 的「电视误唤醒」对照（`tv-dialogue` 与 `direct-question` 内容相同、只差唤醒词）。
- **选型测量进行中**（两个子代理，同一协议、各自独立执行）：
  VAD 端点延迟、turn detector（含「嗯。」是否被误判为说完）、打断机制能否离线演示、Windows/CPU 可行性。
  原始结果将落到 `.spike\pipecat\RESULT.json` 与 `.spike\livekit\RESULT.json`（临时目录），
  结论必须落到本文与 `docs/recon/`，并形成 ADR-0007（语音框架选型）。

### 2.8 对话层（本轮新增，`packages/conversation`）

- `ConversationStateMachine`（§12/§13）：IDLE 需唤醒或强直呼；ENGAGING/ACTIVE/LINGERING 期间无需再喊名字；
  静默容忍度按人格缩放跟进窗口（tolerance 0 → 15s，1 → 1.5×30s）；`SUSPENDED` 支持「今天安静点」。全部时钟注入，可重放。
- `PromptAssembler`（§26）：稳定前缀（不可变硬策略 + 西西身份 + 人格 → 具体说话要求）与变化后缀（时间/会话状态/最近对话/当前这句）分离，
  同一人格下前缀逐字节稳定（利于 §46.3 的 provider 缓存）；同时输出结构化 `sections` 供 Debug UI 展示「模型到底看到了什么」。
- `ConversationEngine`：接受判定 → 组装 prompt → 调适配器 → 记录事件 → 更新状态；
  **§55 的沉默在引擎层兜底**：无论适配器报什么，只要整句是 `[静默]` 就转成 SILENCE，
  且流式分片（实测 MiMo 会把 `[静默]` 拆成 `[`+`静默`+`]`）也不会漏出去或被 TTS 念出来。
- 人格参数会渲染成具体指令（低 verbosity → 「通常 1 句」，高 → 「3~5 句」），这正是 §39.4 要求的「行为验证」而非「数据库验证」。
- 测试：`tests/unit/conversation-fsm.test.ts`、`tests/unit/prompt.test.ts`、`tests/integration/conversation-engine.test.ts`。

### 2.9 语音闭环（本轮新增，`services/voice-edge` + `scripts/voice-*.ts`）

- `services/voice-edge/voice_edge/segment.py`：Silero VAD 分段 CLI（Pipecat 1.12.0），基线 `stop_secs=0.6, min_volume=0.0`（ADR-0007）。
  实测：语音起点 288~320ms、端点延迟 600~608ms、`longer-turn` 不再在句内停顿处误判（那是默认 `stop_secs=0.2` 的坑）。
  输出分离 `loadMs`（冷启动）与 `processMs`（流式成本），避免把冷启动算进实时延迟。
- `scripts/voice-turn.ts`：夹具 → VAD → **只上传语音段**（§20.1）→ MiMo ASR → 对话引擎 → MiMo TTS → 回复 WAV；
  多 `--wav` 即一次多轮语音会话，输出 §46.4 的分段耗时。
  实测：ASR 中文转写正确（「明天天气怎么样？」「今天下午去镇上办点事，可能要到晚上才回来。」），
  回复自然（「行，路上慢点，镇上人多车多的。」）；端到端首条回复音频 3.6~5.5s（含 Python 冷启动与 TTS 整段合成）。
- `scripts/voice-bargein.ts`：按 §14.2 模拟「西西正在说话时用户开口」→ 判定延迟 **192ms**、播放截断、丢弃 4128ms 未播音频，并写出截断 WAV 作为可审计证据。
- 已修的两个自测缺陷：按字节而非样点切帧（导致 VAD 永不停止）、把字节偏移当毫秒（所有时间 2 倍）。
- 夹具修复：`make-audio-fixtures.ts` 统一追加 600ms 尾部静音（LiveKit 子代理发现 `followup-turn` 原本在语音中途截断）。

### 2.10 工具（§27，只读、程序执行）

`packages/brain-adapter/src/tools.ts` + `packages/model-adapters/src/weather.ts`：
- `xixi_get_current_time`（L0）、`xixi_get_weather`（L1，Open-Meteo，**无需密钥**，30 分钟缓存，中文天气描述）。
- 适配器内的工具循环：模型请求工具 → **程序**执行 → 结果回灌 → 模型再回答；未知工具名是「拒绝」而不是崩溃；最多 2 轮。
- 实测关键点：MiMo 会**同时**返回一句开场白和 `tool_calls`（「明天成都的天气我帮你查一下。」+ 工具调用），
  因此「有文本」不能当作「已经回答」——这正是本轮修掉的一个真 bug（否则工具永远不执行）。
- 实测结果：回答使用真实预报（19~25℃、降雨概率 8%），不再是凭记忆编造。
- 未做：`tool_choice` 无法强制调用（MiMo 只支持 auto），所以工具只能靠提示词驱动 + 自行校验。

### 2.11 MiMo 结构化输出的间歇性缺陷（重要）

`response_format: json_schema` **间歇性**返回「先输出键名、再补大量空白直到耗尽 token」的截断 JSON：
`strict:true` 出现过 2/3 失败，`strict:false` 也出现过 1/3 失败——**不是 strict 的问题，是这条通道的问题**。
对策（已实现）：`MimoClient.chatJson()` 先走 `json_schema`，解析或**本地 schema 校验**失败则回退到 `json_object`
（并把 schema 写进提示词，否则模型会自造键名——实测发生过），两次都失败才抛错。
`npm run verify:structured-output` 连续 3 次调用全部可用（其中 2 次走了回退），并把原始通道的缺陷当作金丝雀长期监测。
**结论：所有结构化输出必须本地校验**（§52/§53），这条已经在评审与金丝雀里落地。

### 2.12 评测与测试数据（自己生成）

- 音频夹具：`tests/audio-fixtures/*.wav`（MiMo TTS 合成，24kHz 单声道，含尾部静音），
  其中 `tv-dialogue` 与 `direct-question` **内容相同、只差唤醒词**，专供 M2 电视误触对照；`backchannel` 是 0.96s 的「嗯。」。
- 对话语料：`tests/scenarios/corpus.ts`（8 个场景：连续对话、疲惫晚上、跨轮话题、电视未直呼、安静模式、低/高话多对比、连续应和），
  每条都是**可证伪的行为断言**，不是字符串比对。
- 评测器：`scripts/eval-conversation.ts`（结构检查 + 可选评审模型 `--judge`），报告写入 `docs/recon/conversation-eval-<date>.md`。
- 现有测试：`npm test` **63 项全绿**（离线，不花钱）。

## 3. 关键决策

| 决策 | 理由 | 记录 |
|---|---|---|
| MiMo 走 DSH 官方 pi-ai 配置路由，不自写 provider 插件 | 声明式、零耦合；自写插件会与 DSH 内部绑定 | ADR-0002 |
| DSH_HOME 放项目内 `.dsh/` | 可复现、可整体删除、不污染用户全局 `~/.dsh` | ADR-0001 |
| 只有 `brain-adapter` / `apps/brain-dsh` 接触 Harness | 方案 §25 / 铁律 9 | ADR-0001 |
| 事件日志是唯一事实来源，轮次不另建表 | 方案 §2.2 | ADR-0003 |
| PoC 不引入 MQTT broker；写入方在进程内**直接调用领域层**落库（`appendEvent` / `recordTurn`），尚未抽 EventBus 抽象 | 本机无 Docker；`xixi.event.v1` 契约不变，换 broker 不影响上下游 | ADR-0004 |
| 会话与 Harness 会话的映射放在领域层、按 provider 键控 | 换 Harness 不丢「同一个西西」 | ADR-0005 |
| Node 原生 TS + `node:sqlite`，唯一运行依赖 `js-yaml` | 减少工具链与依赖面（这台机器易崩） | ADR-0006 |
| 每轮一个 `dsh` 进程 | 让「重启恢复」成为默认行为而非特例；延迟代价在 M1 用常驻宿主解决 | ADR-0001 / 本文 2.2 |

## 4. 下一步

1. **M2 唤醒与搭话判定**（当前最大缺口）：`wake_word: false`，首句靠 UI 按钮视为已直呼。
   需要：自定义唤醒词（openWakeWord 路线，另有 `E:\worker\models` 里已验证过的 sherpa-onnx KWS 用法可参考）+ 说话人相似度 +
   会话状态 + 语义承接的融合判定（§13）。**两家语音框架都无法区分电视与真人**（见 ADR-0007），这一步必须自己做。
2. **设备验收**：用户开麦/开音量后跑 [设备验收两条命令](recon/device-acceptance-2026-09-30.md)，完成 §33 的设备部分；
   再把 Node 驱动 Python 的一次性进程换成常驻语音服务（当前每次 VAD 都要付 Python 冷启动）。
3. **M3 人格反馈**：「你话太多了」→ Feedback Interpreter（结构化输出 + 受控增量 + history + 回滚），
   当前只有管理员的 `overrideSelfProfile`，**模型驱动的学习尚未实现**。
4. **M4 Memory**：当前只有会话内工作记忆（最近 8 轮）；长期记忆、纠正优先级、FutureHook 都还没有。
5. 已知待补：`tsc --noEmit` 类型检查、`tests/replay/`（§22.3 回放属 M5）。

## 5. 已完成的委派

- 子代理 A（DSH 集成配方）→ 结论已落入本文 2.2 与 `docs/recon/dsh-integration-2026-09-29.md`。
- 子代理 B（MiMo API 能力探测）→ 结论已落入本文 2.3 与 `docs/recon/mimo-api-probe-2026-09-29.md`。
- 子代理 C（参考文献撰写）→ `docs/adr/0001–0006`、`docs/architecture.md`、`docs/event-contracts.md`、`docs/testing.md`。
- 两个探测子代理均只写入了 `E:\worker2\.scratch\` 与 `E:\worker2\_mimo_probe\`；报告已复制到 `docs/recon/`，这两个临时目录可随时删除。

## 6. 已知限制与风险

- **类型不检查**：Node 直接跑 `.ts`，没有 `tsc --noEmit`；类型错误只在运行时暴露（M1 前补）。
- **密钥泄露**：`MIMO_API_KEY` 曾在聊天中明文出现，**验证完成后必须到小米控制台轮换**；密钥只存在于 `.env`（已 gitignore）。
- **`tool_choice` 不可强制**：不能把「必须调用工具」当硬门禁，只能提示词驱动 + 校验后再决定重试（M3 的 Feedback Interpreter 会受影响）。
- **每轮一个 DSH 进程**：整轮 4–6s，其中相当一部分是 profile 启动；不适合实时语音，M1 必须改常驻宿主。
- **DSH 是 RC**：升级可能破坏配置；必须固定版本，升级前先跑 `npm test` 与两个 verify 脚本。
- **联网搜索对该密钥不可用**：方案里的新闻/天气类话题需要自建搜索通道。
- **单机单进程假设**：`recordTurn` 在事务外先读会话，多进程并发写需要重新审视。

## 7. 崩溃后如何恢复

```powershell
cd E:\worker2
npm install                             # workspace 链接 + js-yaml + dsh-tools（网络失败可挂代理 127.0.0.1:7890）
node scripts/install-dsh-profile.ts      # 幂等；重建 .dsh/profile
npm test                                # 应为 36 项以上全绿
npm run verify:provider                 # 一次真实调用（需要 .env 里的 MIMO_API_KEY）
npm run verify:m0                       # 两进程重启验收
```

语音侧（M1 前置，已建好，无需重建）：

```powershell
E:\worker2\.venvs\voice-pipecat\Scripts\python.exe -c "import pipecat; print(pipecat.__version__)"
E:\worker2\.venvs\voice-livekit\Scripts\python.exe -c "import livekit.agents; print(livekit.agents.__version__)"
node scripts/make-audio-fixtures.ts            # 需要 MIMO_API_KEY；已有夹具时会跳过
```

Python 3.12 解释器绝对路径：`%LOCALAPPDATA%\Programs\Python\Python312\python.exe`。

然后从第 4 节继续（当前下一项是 M1 选型收尾）。
