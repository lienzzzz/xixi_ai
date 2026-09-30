# 进度与交接记录

> 更新规则：每完成一个可独立理解的步骤就立刻追加/更新本文，写清「做了什么、验证结果、下一步、已知问题」。
> 这台机器偶发蓝屏，**本文是崩溃后恢复工作的唯一依据**。
> 最后更新：2026-10-01（集成收口 t5）— **「真人感」改造落地并有同口径前后对比**（提示词＝身份与说话方式 + 紧凑安全段、回复容量 180→480 字、制品清洗、主动性改两层）；指标口径唯一化（主口径＝末句以问号收尾）
> 权威来源：本文件的数字来自当次命令输出；与代码冲突时以代码为准，并立即修正本文。

## 0. 结论表（objective）

| 能力 | 证据 | 状态 |
|---|---|---|
| 文本多轮对话（无需每句唤醒） | `npm run eval:conversation:judge`：8 场景 / 20 轮，接受 18、拒绝 2（电视音频与安静模式） | ✅ |
| 「像人说话」 | 评审模型：自然度 4~5、连贯性 4~5、**7 个场景全部判定为「像家里人」** | ✅ |
| 沉默是一等输出（§55） | 「嗯，知道了」→ 沉默；连续应和场景出现 SILENCE | ✅ |
| 人格真的改变行为（§39.4） | 同题对比：低话多组平均 22.3 字 vs 高话多组 57.3 字（**2.57×**） | ✅ |
| 真实能力而非空谈 | 天气工具（Open-Meteo，只读）被真实调用：回答用的是 19~25℃、降雨概率 8% 的真实预报 | ✅ |
| 语音闭环（夹具） | 夹具 → 抗噪前端 → VAD → ASR → 对话 → TTS；端到端 3.6~5.5s（含冷启动） | ✅ |
| **噪声鲁棒前端 + 成功边界** | `node scripts/verify-voice-noise.ts`（真实 ASR）：**SNR_inband ≥ 3 dB 时 4 条夹具全部检出、平均相似度 0.805**；详见 §2.13 | ✅ |
| 打断（§14.2） | 离线模拟：判定延迟 **192ms**（§33 目标 <500ms），播放截断于 992ms，丢弃 4128ms 未播音频 | ✅（判定层面） |
| 重启恢复 | 两个独立进程，第二个逐字复现第一个的回答（M0 验收，`npm run verify:m0`） | ✅ |
| **摄像头在场检测（M6）** | 合成场景 + 真机子进程实测：帧差动 + YuNet → `presence.changed` → `world_state` 投影；一键启用/停用可复现 | ✅（**真人**在场自测未跑，见 §4） |
| **主动开口（ADR-0009 + ADR-0011）** | **两层**：硬底线（静默时段 / 6h 与当日**次数**额度 / DND / 隐私与同意 / 场景与音频路径）由程序判定、模型不能绕；底线之上**由模型读空气决定说不说**，确定性社会预算只给建议（`BELOW_RECOMMENDATION`）；5 次 tick 只放行 1 条 | ✅ |
| **多段回复** | `reply.max_segments=8 / segment_max_chars=60 / gap_ms=450`（**块长 60、容量 8×60=480 字**）；容量内每段 ≤60，`>8` 组时尾段合并 + `mergedOverflow`（该段可超 60）；字符零丢失；状态机一轮只推进一次 | ✅（终端已接分段播放） |
| **「真人感」（P1，2026-10-01）** | 稳定前缀 = **身份与说话方式**（散文、0 编号）+ 紧凑安全段；容量 180→480 字；工具标记/英文推理在程序层剔除。同语料同口径：提问率主口径 45.8%→46.0%（各 n=1 次运行；三次重复均值 46.2% vs 46.0%）、单段最长 341→170 字、20 轮复述 0（详见 §2.18） | ✅（**提问率仍贴 30–50% 上沿**，见 §4） |
| **现场测试控制台（一条命令）** | `npm run field-test` → http://127.0.0.1:8792；三栏界面 + 一键启用 + 设备自检引导 | ✅ |
| 真实麦克风 / 扬声器（人耳） | 回环「回采余量」实测能量比 **2.41 dB < 10 dB** → 判 FAIL；**这不代表用户对麦克风说话能否被听到**（见 §0 用户须知与 §2.14） | ⚠️ 需人耳确认 |
| 唤醒词 / 长期记忆 / 模型侧主动候选 | 未实现（M2 / M4 / M5 的模型侧），本轮刻意不做 | ⛔ |
| 主动问候的「真实用户价值」 | 主动开口已能发声，但**没有真人长期使用数据**；强度默认 0.85（阈值 0.495）只是当前取值 | ⚠️ 未验证 |

综合延迟（干净环境）：对话总时长 P50 2.5s / P95 5.1s，首字 P50 1.2s / P95 2.9s；语音链路里 VAD 判定 ~192ms、ASR 0.34~0.73s、LLM 首字 1.7~2.3s、TTS 1.0~2.0s。
**尚未验收**：扬声器真正静音的延迟、唤醒词、电视误触率、M6 的真人自测（命令见 §4）、噪声下的真实对话响应（端点延迟会从 600ms 涨到约 1500ms，见 §2.13）。
**现场测试前请读** [`docs/README.md`](README.md) §0「现场测试前用户须知」（一条命令、怎么判读、设备前置条件、四个入口各用不同数据库）。


## 0b. M0 验收结论

`node scripts/verify-m0.ts` 用**两个独立的操作系统进程**跑通（方案 §34 的 M0 验收）：

| 阶段 | 结果 |
|---|---|
| 进程 1（fresh） | 文字 → DSH → MiMo `mimo-v2.6-flash` → 工具调用 `xixi_get_current_time` → 回答 `2026-09-29T15:13:51.620Z`，latency 6.3s，事件 3 条 |
| 进程 2（resume，全新进程） | 同一 `sess_6a233a16-…`、同一 DSH 会话 `session-a75b1195-…`；被问「你上一条回复的是什么」时**逐字复现**进程 1 的回答；人格 9 项与进程 1 一致；turnCount 4、事件 6 条 |

即「输入文字 → DSH → MiMo → structured tool → answer；restart → session recover」成立，且不是同进程内的假恢复。
另有 `npm run verify:provider`（一次真实调用）单独证明路由 + 工具调用可用。
离线测试 `npm test`：**以末行为准**（最近一次实测点：2026-09-30、**223 项**、exit 0；更早的集成收口实测点是 209 项 / 19.1s）。
**项数与文件数都不要抄**：本轮先后出现过 36 / 63 / 87 / 95 / 120 / 137 / 139 / 180 / 189 / 192 / 201 / 206 / 209 / 213 / 223，
那些全是**当时快照**，留着只为了证明「这个数一直在动」——要现状就跑 `npm test` 看末行。
**给后人的提醒：改这份文档时不要再写死测试总数或文件数**，只写「以 `npm test` 末行为准」加一个带日期的实测点
（与 [`testing.md`](testing.md) 头部同一口径；依据见 [`AGENTS.md` §9.18](../AGENTS.md)）。

## 1. 里程碑状态

| 里程碑 | 状态 |
|---|---|
| M0 DSH + MiMo 文本 Harness | **已完成（验收通过）** |
| M1 前置 spike（Python + 语音框架选型） | **已完成**：ADR-0007 选 Pipecat，参数与结论均有实测支撑 |
| M1 语音闭环（前端→VAD→ASR→对话→TTS + 打断） | **可用**：夹具链路通过 + 抗噪前端与成功边界已实测（§2.13）；真实麦克风的人耳确认仍未做 |
| 对话层（会话 FSM + Prompt 组装 + 工具 + 多段回复） | **已完成（P1 改版）**：多轮连续性、沉默、人格可调、只读工具、多段回复（ADR-0010，**容量 480 字**）；提示词前缀＝身份与说话方式 + 紧凑安全段 |
| **主动性 V2**（硬底线 + 模型读空气 + 真发声） | **已完成（部分，两项验收未达标）**：硬底线原样生效、底线之上由模型决定、内容由模型生成；**但 pack Phase 5 的 generic 占比 33.3%（≤20% 未达标）与「两次未回应后降频」不成立**（t9 判 failed，修复任务 t18 未开始）；模型侧候选评估、长期记忆、FutureHook、无人值守守护进程仍未做 |
| **M6 摄像头在场检测** | **已完成（部分）**：帧差动 + YuNet → `presence.changed` → `world_state` 投影 + 一键启用；**真人自测未跑**（§4） |
| M2 唤醒词 / M3 人格学习 / M4 记忆 | 未开始 |
| 现场测试控制台（三栏 + 一键启用 + 设备自检） | **已完成**：`npm run field-test`（§2.15） |

仓库：`E:\worker2`。独立项目，**不依赖** `E:\worker` 的「m」原型（其方向已偏离需求）。

## 2. 已完成并已验证

### 2.1 环境事实（详见 [AGENTS.md](../AGENTS.md) 第 4 节）

- DSH `@deepseek-ai/dsh` **0.1.7-rc.2**（Developer Preview / RC），项目内 DSH_HOME = `<repo>/.dsh`（已 gitignore）。
- Node v24.21.0 原生运行 `.ts`（无需编译）；`node:sqlite`（SQLite 3.53.4，JSON1）可用 → M0 运行时只依赖 `js-yaml`。
- 本机**没有 Docker / mosquitto / ffmpeg**。系统 Python 是 **3.14.7**（不满足 Pipecat/LiveKit），
  语音侧一律用隔离 venv 里的 **Python 3.12.10**（`.venvs/{voice-pipecat,voice-livekit,field-probe,cv4}`，见 §2.7 与 §2.7b）。
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
- `PromptAssembler`（§26，**P1 改版 2026-10-01**）：稳定前缀 = `CORE_IDENTITY`（身份与说话方式，散文）→ 名字 →
  `HARD_POLICY`（压缩安全段，关键词锚点）→ 说话方式（人格→**词描述**）；变化后缀 = 当前情境 / 用户这句话。
  **裸人格参数（`verbosity=0.4` 这类）与【最近对话】二次展开都已删除**：历史只以 `history` 的真实角色数组
  交给适配器，模型每轮只看到一次；`sections` 五个名字 = `core-identity` / `safety-policy` / `effective-style` /
  `world-state` / `current-turn`。同一人格下前缀逐字节稳定（§46.3 的 provider 缓存）。
- `ConversationEngine`：接受判定 → 组装 prompt → 调适配器 → 记录事件 → 更新状态；
  **§55 的沉默在引擎层兜底**：无论适配器报什么，只要整句是 `[静默]` 就转成 SILENCE，
  且流式分片（实测 MiMo 会把 `[静默]` 拆成 `[`+`静默`+`]`）也不会漏出去或被 TTS 念出来。
- 人格参数会渲染成**词描述**的说话要求（低 verbosity → 「说话偏简短：一句能说完就别硬凑第二句。」，
  高 → 「愿意多说几句…」；**不再出现句数或裸参数**，单测断言每条指令不含数字与参数名），
  这正是 §39.4 要求的「行为验证」而非「数据库验证」。
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
- 实测关键点：MiMo 会**同时**返回一句开场白和 `tool_calls`（「明天本市的天气我帮你查一下。」+ 工具调用），
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
- 现有测试：`npm test` 实测数字见 §0b（**以实跑末行为准**；测试数会随断言增加而变化）。

### 2.13 噪声鲁棒语音前端与成功边界（t2 实现 / t23 订正 / t7→t24→t38 评审链）

用户明确说过「麦克风噪音很大」，而 ADR-0007 的基线只在干净合成夹具上验证过。本轮把它做成可测量的：

- 实现：`services/voice-edge/voice_edge/frontend.py`（纯函数：去直流 + 零相位 120 Hz 双二阶高通 +
  噪声底自适应门限；谱减法可选、**默认关**）、`voice_edge/calibrate.py`（噪声底校准入口）、
  `voice_edge/make_noise_fixtures.py`（实测环境噪声 × 6 档 SNR = 30 个 WAV + `manifest.json`）、
  `scripts/verify-voice-noise.ts`（干净 + 噪声夹具 → 前端 → VAD → **真实 MiMo ASR**）。

**可复现成功边界（写死）**：`SNR_inband ≥ 3 dB` 时 4 条中文夹具**全部检出**、平均字符相似度 **0.805**。

| SNR 档 | 检出 | 平均字符相似度 | 判定 |
|---|---|---|---|
| 18 dB | 4/4 | 0.841 | PASS |
| 6 dB | 4/4 | 0.841 | PASS |
| **3 dB** | **4/4** | **0.805** | **PASS（边界）** |
| 0 dB | 4/4 | 0.491（2 条 <0.6） | FAIL |
| −6 dB | 0/4 | —（全部漏检） | FAIL |

**端点延迟必须按 t23 修正后的口径引用**（逐条值、最大值；**不要用均值，也不要用被截断的 `endpointDelayMs`**）：
6 dB 档 **1056 / 1376 / 1472 / 1088（max 1472）**；干净档 728 / 704 / 864 / 704；3 dB 档 104 / 128 / −64 / 96（max 128）。
复现（不花钱）：`node scripts/verify-voice-noise.ts --fake --tiers 6`；真实 ASR：`npm run voice:noise`。
数字来源：`docs/design/voice.md` §1.1（6）。

**三条负结论（不要美化）**：
1. **高通把宽带噪声降了 5.33 dB，但对 Silero 的分段判定几乎没影响**（同一批夹具 A/B：段数/起点/端点不变，
   个别 0–288 ms 的方向性改善）。别把「降噪 5.33 dB」读成「VAD 会变好 5.33 dB」。
2. **谱减法默认关闭**：噪声带只降 0.47–1.91 dB，端到端相似度 6 dB 档无变化、**3 dB 档反而变差（0.622 vs 0.805）**，
   还要每段多花 100–300 ms。开关保留（`segment --nr`），负结论留在代码与 `voice.md` §1.1（5）。
3. **噪声下端点延迟显著变长**：干净 600 ms → 6 dB 档约 1056–1472 ms（≈1500 ms 量级），
   真实对话的响应会明显拖慢；0 dB 档打断判定也不可靠。

边界值的自动化与证据：`report.boundary.lowestPassingTierDb`（脚本自动算）、
`docs/verification/*` 与 `docs/review/voice-*-review-*.md`；困难样本（0 / −6 dB 共 10 个 WAV）**全部保留**，
有单测守住「最低 SNR 档必须仍在盘上」。

### 2.14 摄像头在场检测（M6）与设备验收的正确解读

- 实现：`services/perception-edge/perception_edge/{run,bench}.py`（DSHOW 抓帧 → 帧差动 1.17ms/对 → YuNet 人脸 38.3ms/帧）
  → `presence.changed` 事件 → `world_state` 投影（`presence.home`，`002_world_state.sql`）；设计见 [`design/perception.md`](design/perception.md)。
- 一键启用：控制台 `POST /api/field/live {action:'start'}` = 迁移在场库 → 起 `perception_edge.run --live` 子进程 → 循环先 tick 一次；
  真机实测 `child.pid` 可见、5 秒后 frames 104、presence 事件 2 条、`present=true`、`confidence=0.75`，停用后子进程真退出。
- 隐私：帧只在内存（子进程 `cv2.imencode` → stdout base64，控制台只留最新一帧），**不留图像**；
  `--live` 仍会写 `data/perception/` 的事件库（「不留图像」≠「不写库」）。
  可重跑核对：`node scripts/verify-camera-presence.ts --live --seconds 8`（磁盘图像文件 0 个）。
- **设备验收的两条正确解读**（`docs/recon/field-test-report-2026-09-30.md`）：
  1. **「扬声器 FAIL」测的是回采余量**（笔记本扬声器 → 笔记本麦克风），能量比 2.41 dB < 10 dB 所以 FAIL；
     **不代表用户对麦克风说话能否被听到**——那要用 `node scripts/voice-device-check.ts --wav <录音> --expect "<原文>"` 检验（相似度 ≥ 0.5 判 PASS）。
  2. 默认播放端点**出厂就是静音的**（勘测实测），本轮已解除；采集增益默认 +5.5 dB，噪声底几乎 1:1 跟着它走，
     建议设 0 dB（控制台只提示、不修改系统设置）。

### 2.15 多段回复（ADR-0010）与主动开口（ADR-0009 + ADR-0011）+ 三栏控制台

- **多段回复**：`config/xixi.example.yaml` 的 `reply: {max_segments: 8, segment_max_chars: 60, gap_ms: 450}`
  （代码里被 `resolveReplyLimits(config.reply)` 夹进 ADR-0010 的硬上限；**上限由 3 提高到 8**，见该 ADR 的修订记录）。
  两个词要分清：**块长** = 一次播报粒度（60 字），**容量** = 8 × 60 = **480 字**；`>8` 组时尾段合并、`mergedOverflow=true`
  且该段**可超 60 字**（最小反例 279 字 = 9 句 × 31 → 8 段、最长 62，断言在 `tests/unit/core/reply-segments.test.ts`）。
  独立验证（t43）：`onSegment` 与 `onTextChunk` 互斥（chunks=0）、字符零丢失、
  该轮事件恰好 1 user + 1 assistant + 1 decision（**状态机只推进一次**）。
  **接线现状**：终端 `scripts/chat.ts` **已接**分段播放（`onSegment`）；试用页与 `voice-turn.ts` 仍整段 `synthesize(turn.text)`。
- **主动开口（V2，2026-10-01）**：`ProactiveLoop`（默认关）+ 候选只来自事实（在场 / 会话悬置 / 时间钩子 / 话题池 / 随机闲聊）；
  **判定走同一条 `ProactiveEngine.consider`，但语义已改成两层**（[ADR-0011](adr/0011-proactive-decision-ownership.md)）：
  ① 硬底线（静默时段 / 6h 与当日**次数**额度 / DND / 隐私与同意 / 场景与音频路径 / 同一候选重复）由程序判定，
  模型不能加宽；② 底线之上**由模型读空气决定说不说**，确定性社会预算（话题质量分 / 相关性 / 新鲜度 / 读空气 /
  互动度 / 主动性 − 打扰代价 / 话题重复 / 未回应惩罚）只产出 `recommendation: speak | hold`。
  冷却、话题重复、未回应**从门禁降级为扣分项**（`BELOW_RECOMMENDATION` 是建议不是否决）；审计事件多记
  `primary_signal`、每项信号、`decided_by` 与程序渲染的中文 `basis`，**仍不存模型推理**。内容由模型在 `deliver`
  接缝里生成、失败回退固定句，投递「先记后播」（崩溃不重发）。
  ⚠️ **没有金额级费用上限**：额度是**次数**，它只是费用代理（见 §6）。
- **主动性 V2 的两项未达标 + 六条缺陷（t9 独立验证，2026-10-01；**未修完，不得写成已通过**）**：
  pack Phase 5 的 12 小时时间线验收里有 **2 项目标没达到**——① 内容口径的 **generic 话题占比 33.3%**（目标 ≤20%；
  引擎口径 0% 是结构性的，见下面的 F3，**不能用来宣称达标**）；② **「连续两次没人回应后显著降频」不成立**：
  被忽视的一天与有人回应的一天说了**同样多的 9 次**，机制探针显示「1 条未回应」与「3 条未回应」拿到同一个 **0.45** 惩罚，
  标准候选照样 `PASSED`。t9 因此判 **failed**，并明确「不建议宣布 Phase 5 验收通过」。
  **六条缺陷（t9 §5，全部尚未修复）**：F1 high（被扣分的候选吃光 tick，`future_hook_due` 0/3）、F2 high（未回应惩罚饱和、量级不够）、
  F3 medium（`topicRef = trigger` 让 generic 指标结构性失效，永远不可能失败）、F4 medium（「读空气」的问询吃光当日额度：
  40 次「不说」之后当天不再开口）、F5 medium（pack §14.3 的「热聊中接话」在生产候选里到不了）、F6 low（打扰代价只是分数：
  两条消息可以隔 1–2 分钟）。**修复进展：尚未开始**——修复任务 **t18**（依赖 t13/t15）仍 pending，复验是 **t19**；
  ADR-0011 已按 t9 的判定如实记录（提交 `efa6dbe`）。**报告与全部数字**：
  [`verification/t9-proactive-v2-verification-2026-10-01.md`](verification/t9-proactive-v2-verification-2026-10-01.md)
  （§7 是判定表、§5 是六条 findings、§9 是可重跑命令）。
- **人格强度与「怎么调、怎么关」**：`personality.base.proactivity` 默认 **0.85**（代码 `DEFAULT_PROACTIVITY = 0.85`），
  阈值 `0.45 + 0.30 × (1 − proactivity)` = **0.495**（核对：`git grep -n "DEFAULT_PROACTIVITY" -- packages`）。
  控制台「配置」栏可调 proactivity / talkativeness / verbosity（写入 `self_profile` + `self_profile_history`，
  来源 `console:personality`，并落一条 `system.health` 审计）；**一键关闭** = 不开「自动考虑」开关或点停用。
  每次开口或被拦都落 `conversation.decision` 事件（被拦也落 `speak:false`，可回答「为什么今天没说话」）。
  ⚠️ **时点提醒**：t43/t80 报告里写的 0.70 / 0.54 是**当时快照**，t77 已改为 0.85 / 0.495。
- **三栏控制台**：`npm run field-test` → http://127.0.0.1:8792，三栏（传感器 / 配置 / 对话）+ 一键启用 + 实时画面
  + 设备自检引导 + 隐私与保留策略；<1200px 自动堆叠。库默认 `data/field-test`（`--data-dir` / `--presence-data-dir` 可改；
  未知参数**中文报错 + exit 2**）。

### 2.16 三条已知取舍与限制（写清楚，别当成没做）

1. **`engine.state` 是带副作用的 getter（读取即推进，t19 的核心取舍）**：读状态会推进 FSM 的时间判定，
   所以「看一眼现在是什么状态」不是纯查询。任何新的读取方（面板、脚本、将来的常驻服务）都必须知道这一点。
2. **`REJECTED_NOT_ADDRESSED` 目前没有真实样本**：稳定的拒绝只有 `SUSPENDED`（安静模式）一种，
   另一条路径的样本只在测试与历史报告里出现（t10 的 F2 记录过「当时不成立」的验证）。
3. **`data/` 目录的隐私比较是「文件名集合」**：同名覆盖不会被发现。今天无法触发（服务里没有任何写图路径），
   **将来若加调试落图，必须改成 mtime + 大小或内容哈希**（评审 t80 的 O4 也是同一口径：隐私的含义是「不留图像」，不是「不写库」）。

### 2.17 不许编造可核查的具体事实（t111 落地 + t117 按评审收紧）

**机制（两层）**：提示词层 `HARD_POLICY` 的「可核查的具体事实」那条（P1 起不再按编号引用）要求
「天气/气温/降水概率/风力/空气质量/新闻/日程/别人说的话」
只能来自工具结果，要说必须先调用工具查，查不到就说不知道；程序层 `ConversationEngine` 的
`findUnbackedFactClaims()` / `screenUnbackedFacts()` 是确定性闸门——本轮没有工具调用却出现「只有查得到才知道的具体值」时，
文本被扣住（不进 TTS、不写 `conversation.turn`、不改工作记忆），改说修复句并给调用方
`onNotice({code:'UNBACKED_FACT_CLAIM'})`；主动开口的投递接缝用同一个判据，未核实就换成该触发源的固定短句，
并把 `toolName` 写进 assistant 轮的 `tool_name`。

**t117 按评审（t114）收紧的两处**：① 归属规则从「出现过来源词」改成「来源在说话 + 同句有可核查内容」——
`医生/专家/朋友说/别人说/他们告诉` 这类裸来源词不再触发（此前会把「朋友说要来吃饭」「专家都觉得这样安排挺好」
「今天新闻挺热闹的，说小区门口要办集市」整句替换成「我不敢乱说」）；② 温度量词从 `\d{1,2}` 放宽到 `\d{1,3}`，
`180 度`/`100 度` 的审计 `match` 不再被截断成后两位。

**台账口径（把结论限定成事实，t114 的 F3）**：扫三个库的 `conversation.turn`（`data/chat`、`data/field-test`、`data/web-chat`），
含具体值的 assistant 轮共 **4 条，全部伴随 `xixi_get_weather`**（10:04 / 11:12 / 13:02 / 15:05）；
另有 **8 条**含具体值却 `tool_name=null` 的轮次（判据：含具体值**且** `tool_name=null` 的 assistant 轮，**三个库都要扫**——
`data/chat` 6 条：07:57×2、08:16×4、08:17；`data/field-test` 1 条：11:12:54；**`data/web-chat` 1 条：10:09:40**）。
**这 8 条全部发生在修复（约 19:55）之前，不会被追溯修改**——台账是当时发生的事实记录，修的是「从现在起不再发生」。
**这些库里没有任何修复之后的轮次**，所以「修复之后零违规」只在 t111 自己的运行窗口（它用的是 `%TEMP%` 下的临时库）
与离线探针上成立，**不能在仓库台账上证实**；「4 条全部伴随工具」说的也是那 4 条**修复前**的轮次（它们恰好都调用了工具）。
**可重跑的主引用**（一条命令一次扫三个库；在仓库根目录执行，输出与上面两句逐字对应）：

```powershell
node -e "Promise.all([import('node:fs'),import('node:sqlite'),import('./packages/conversation/src/engine.ts')]).then(([fs,sq,eng])=>{const dbPaths=['data/chat/xixi.sqlite','data/field-test/xixi.sqlite','data/web-chat/xixi.sqlite'];let backed=0;let nulls=0;for(const p of dbPaths){if(!fs.existsSync(p))continue;const db=new sq.DatabaseSync(p,{readOnly:true});const rows=db.prepare('select event_type, payload_json from events').all();let b=0;let n=0;for(const row of rows){if(row.event_type!=='conversation.turn')continue;const q=JSON.parse(String(row.payload_json));if(q.role!=='assistant')continue;if(eng.findUnbackedFactClaims(String(q.text||'')).length===0)continue;if(q.tool_name===null||q.tool_name===undefined)n+=1;else b+=1;}console.log(p+': 伴随工具 '+b+' / 无工具 '+n);backed+=b;nulls+=n;db.close();}console.log('三库合计：伴随工具 '+backed+' / 无工具 '+nulls);});"
```

实跑输出（2026-09-30，本机）：

```text
data/chat/xixi.sqlite: 伴随工具 1 / 无工具 6
data/field-test/xixi.sqlite: 伴随工具 2 / 无工具 1
data/web-chat/xixi.sqlite: 伴随工具 1 / 无工具 1
三库合计：伴随工具 4 / 无工具 8
```

判据就是上面那两句：`findUnbackedFactClaims()` 判「含具体值」，`payload_json.tool_name` 判这一轮有没有工具调用。
（命令里带中文标签：直接粘进终端跑就是上面这段输出；若**存成 `.ps1` 再用 Windows PowerShell 5.1 执行**，
请存成**带 BOM 的 UTF-8**，否则中文标签会读成乱码——同一个坑见 [`AGENTS.md` §9.8](../AGENTS.md) ⑤。）

**附（背景，不是主引用）**：评审 t114 当时的脚本 `data/rev-tmp/t114-invariant.mjs` 落在 `data/`（已 gitignore），
随机器清理会消失，而且**只扫 `data/chat` 与 `data/field-test` 两个库**——直接跑它只会得到「伴随工具 1 / 无工具 6」
与「伴随工具 2 / 无工具 1」；**复算时三个库都要扫，否则会少一条无工具的（`data/web-chat` 10:09:40）
和一条伴随工具的（`data/web-chat` 10:04）**。以主引用那条命令为准。

### 2.18 「真人感」改造与前后对比（P1 + P1c，2026-10-01）

**改了什么**（三处，都在 P1）：① 稳定前缀从**编号规则清单**改成 `CORE_IDENTITY`（身份与说话方式，散文）
+ `HARD_POLICY`（压缩安全段，关键词锚点），裸人格参数与【最近对话】二次展开删除；
② 回复容量 3×60=180 → **8×60=480 字**（块长仍 60；`>8` 组时尾段合并，见 §2.15 与 ADR-0010 修订记录）；
③ 工具标记与英文推理在**程序层**剔除（`sanitizeSpokenReply` → `REPLY_HYGIENE` 通知；整轮只剩制品则沉默）。

**指标怎么量（唯一口径，别再各说各话）**——实现只有一份：`scripts/lib/realism-metrics.ts` + `scripts/eval-realism.ts`：

- **分母**：`action === 'SPEAK'` 且文本非空且**不是引擎修复句**（`UNBACKED_FACT_REPLY`）的**开口轮**；
  沉默轮与修复句都不进分母（否则会拿程序写的那句话当模型的行为）。
- **提问率主口径**＝**末句以问号收尾**（带内判定用它）；**辅口径**＝回复里含问号，只作参考。
- **长度**＝去空白字符数；另有**交付分段**（每轮段数 + 单段字数，ADR-0010 的真实结果）。
- **禁用模板率**＝命中 13 条「AI 套话」词表的开口轮占比（每条都写明为什么算套话）。

**前后对比（同一批 84 轮语料、同一工具、同一模型；两次运行各 84 轮）**：

| 指标 | 改造前 V0.1（`882f745`） | 改造后 P1（`995ed42` 快照） |
|---|---:|---:|
| 提问率（**主口径**） | **45.8%**（33/72） | **46.0%**（29/63） |
| 提问率（辅口径，仅参考） | 69.4% | 57.1% |
| 逐次重复的主口径 | 28.0 / 58.3 / 52.2（均值 46.2%，**n=3**，极差 30.3pt） | 47.6 / 42.9 / 47.6（均值 46.0%，**n=3**，极差 4.7pt） |
| 回复字数 P50 / 最大 | 47.5 / 422 | 33 / 424 |
| **交付分段的最长单段** | **341 字** | **170 字** |
| 禁用模板出现率 | 0% | 0% |
| 沉默率 | 3.8% | 9.0% |

**20 轮同一输入的口语对比**（t2 采集，输入同为 `docs/benchmarks/v01/input-chat-20turns.txt`）：
复述 **0**（重复句子 0、重复短语 0、与上一轮最大公共子串 4/7 字）vs V0.1 的 10 字复述 +
「了，量完血压」出现在第 12/16/19 轮；段数分布 `{1段:12, 2段:4, 3段:3, 4段:1}` 与 `{1段:6, 2段:8, 3段:1, 4段:3, 5段:2}`
vs V0.1 的 `{1段:3, 2段:7, 3段:9}`；P50 101 → 46/80.5 字，最大 177 → 166/216；知识题 5 段 216 字**不丢字**。

**可重跑（不花钱，读已捕获的转录）**：

```powershell
node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-10-01-v01-vanilla.json   # 改造前
node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-10-01-v02-wip.json        # 改造后
```

**如实说明（别把它读成「提问率已达标」）**：主口径下改造前后都在 **46%** 附近，**贴着 30–50% 带宽的上沿**；
把全部 10 次捕获（3×V0.1 重复 + 3×P1 重复 + t4 两次 20 轮 + t6 在 v02 两份转录上的两次）算进来，
主口径极差是 **15.8%–63.2%（跨带）**——**「落在 30–50%」只在「同语料重复」的前提下成立**，
跨带来自输入差异（t17 的 O1 更正了 captain 早先的「8 次独立捕获」措辞）。
逐条口径与全部数字见 [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md)；独立验证见
[`verification/t4-realism-verification-2026-10-01.md`](verification/t4-realism-verification-2026-10-01.md)。

## 2b. 评审与验证汇总（本轮）

**四份实现评审的 verdict 与 findings 去向**（findings 编号与严重度取自各自报告；「闭环」= 复审已 pass）：

| 评审 | 对象 | verdict | findings | 修复任务 | 复审任务与结论 | 是否闭环 |
|---|---|---|---|---|---|---|
| **t7** `voice-implementation-review` | t2 语音前端 | needs_revision | F1 medium / F2 medium / F3 low / F4 low / F5 info | **t23**（round-2/3） | **t24** needs_revision（F1 残留）→ **t38** 修复 → `voice-repair-round-3-review` **pass** | ✅ |
| **t8** `perception-implementation-review` | t3 摄像头在场 | needs_revision | F1 medium / F2 medium / F3 medium / F4 low / F5 low / F6 info | **t26** | **t27** `perception-repair-review` **pass** | ✅ |
| **t9** `console-implementation-review` | t4 现场测试控制台 | needs_revision | F1 low（自检项数已漂移） | **t29** | **t30** needs_revision（F1 medium + F2–F5 low）→ t45 → round-3 仍 needs_revision → 后续 t53/t59/t64 逐处订正 | ⚠️ 文档数字链仍在收尾（每次复审都能抓到新的漂移） |
| **t10** `core-wiring-review` | t5 核心接线 | needs_revision | F1 low / F2 low / F3 low | **t31** | **t32** `core-wiring-repair-review` **pass** | ✅ |

**t10 评审 F3 的教训（必须记住）**：任务回报里的测试计数是**当时快照**——t5 报「87/87」，而写这一段时的实测是 209 项
（2026-09-30 的最近实测点已到 223 项，见 §0b）。引用任何他人回报里的数字时**必须注明时点**，不要当作现状；
本文件里的计数一律写成「以实跑末行为准 + 带日期的实测点」，不写当前值。

**独立验证（不是实现者自述）**：`docs/verification/` 下 2 份——多段回复与主动性门禁（t43：27/27 门禁用例、
投递恰好 1 次、崩溃后绝不重发、6h 额度实测 4 = 配置上限）、现场测试控制台（t4 的独立验证）。
**评审报告**共 20+ 份在 `docs/review/`（含 6 份复审），verdict 分布与观测都留在各自文件里。

**2026-10-01 一轮（P1 提示词/长度 + P1c 指标 + 主动性 V2 + 制品清洗）**：

| 任务 | 报告 | verdict | 去向 |
|---|---|---|---|
| t6 评审 P1 提示词与长度策略 | [`review/p1-prompt-length-review-2026-10-01.md`](review/p1-prompt-length-review-2026-10-01.md) | needs_revision | F2 口径 / F3 安全措辞 / F4 claim → **t16** 修复；**F1 文档漂移 → 本收口任务 t5** |
| t17 复审 | [`review/p1-prompt-length-rereview-2026-10-01.md`](review/p1-prompt-length-rereview-2026-10-01.md) | **pass** | 三条 finding 独立复核成立且可复现；O1 更正了「8 次独立捕获」的措辞（已落 §2.18 与 benchmarks 文档） |
| t7 评审制品清洗 | [`review/reply-hygiene-review-2026-10-01.md`](review/reply-hygiene-review-2026-10-01.md) | needs_revision | `REPLY_HYGIENE` 无产线消费者 → 记入 §4 未完成项（**未修**，文档如实写缺口） |
| t4 独立验证「真人感」 | [`verification/t4-realism-verification-2026-10-01.md`](verification/t4-realism-verification-2026-10-01.md) | **通过** | 三次输入独立复算、铁律未削弱；它自己的提问率主口径结论与 §2.18 同源 |
| t9 独立验证主动性 V2 | [`verification/t9-proactive-v2-verification-2026-10-01.md`](verification/t9-proactive-v2-verification-2026-10-01.md) | **failed**（引擎机制成立，但 pack Phase 5 两项时间线验收未达标） | 两项未达标与六条缺陷已如实写入 §1/§2.15；修复任务 **t18**（pending）、复验 **t19**（pending）；ADR-0011 已记录（`efa6dbe`）——**不得写成已通过** |

**t29 负责的三份文件（`docs/testing.md` / `README.md` / `docs/handoff.md`）**：本轮只做**最终一致性核对**，
未重复修改（遵守派单约束）。**核对结论（当时）：仍有漂移，需另派单订正**——（现已在 t90/t94 收尾，见下）
`docs/testing.md:5` 写「实测 **180 项**：unit 124 + integration 30 + perception 11 + console 15」，
同文件 `:132` 又写「实测 **139 项**全绿」（同一份文件两个数），`docs/handoff.md` 两处写「实测 139 项」
（还带「空载约 27–30s」的耗时旧结论）。**核对当时**实测是 `npm test` 209 项、`--self-test` 31 项（本文件 §0b；
这两个数今天也已过期——t90/t94 已把三份文档改成「以末行为准 + 带日期实测点」）。
三处数字都应按「以实跑末行为准」改写（`docs/design/README.md` §3 规则 13 与 `AGENTS.md` §9.18 都是同一原则）。

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
| 提示词前缀说「**她是谁、怎么说话**」，不是编号规则清单 | V0.1 的 `回答通常 1~3 句` 这类规则把每轮都压成同一种形状（客服感的来源）；安全边界改成紧凑散文 + 关键词锚点，靠测试钉住而不是靠编号 | 本文 2.18 / [design/conversation.md](design/conversation.md) §2 |
| 回复上限 3 段 → **8 段**（块长仍 60，容量 180 → 480 字） | 长解释不该被挤成 2–3 大块（V0.1 实测单段最长 341 字）；上限本身继续保留（防刷屏、保打断窗口） | [ADR-0010](adr/0010-multi-segment-replies.md) 修订记录 |
| 主动行为的**决策归属**：硬底线归程序，底线之上归模型读空气 | 「高主动性 ≠ 高频打扰」不能靠单一阈值一票否决；冷却/话题重复/未回应改成扣分项，审计仍只存 `reason_code` 与分数 | [ADR-0011](adr/0011-proactive-decision-ownership.md) |
| 真人感指标**口径唯一**：分母＝真正说出来的开口轮，主口径＝末句以问号收尾 | 旧口径（含问号、把引擎修复句算成模型行为）会把 46% 读成 62–70%，同一份数据得出相反结论 | 本文 2.18 / [benchmarks/realism-metrics.md](benchmarks/realism-metrics.md) |

## 4. 下一步 / 未完成项

1. **M6 的真人自测（唯一还没由人跑过的关键项）**——**原样**照跑，不得用合成图或外部图片冒充：
   ```powershell
   cd E:\worker2
   node scripts/verify-camera-presence.ts --seconds 40 --require-transition
   ```
   做法：跑之前确保画面里**没有人**，运行中**走进画面再走出**（`--require-transition` 要求真的看到一次翻转，
   敲错参数会中文报错而不是静默通过）。**跑完把输出回填本文件**（贴命令、时间、帧数、`present` 翻转次数、
   `confidence` 与磁盘图像文件数），并更新 §0 结论表里「摄像头在场检测」的状态。
2. **M2 唤醒与搭话判定**（当前最大功能缺口）：`wake_word: false`，首句靠 UI 按钮视为已直呼。
   需要：自定义唤醒词（openWakeWord 路线，另有 `E:\worker\models` 里已验证过的 sherpa-onnx KWS 用法可参考）+
   说话人相似度 + 会话状态 + 语义承接的融合判定（§13）。**两家语音框架都无法区分电视与真人**（ADR-0007），必须自己做。
3. **真实麦克风的人耳确认**：回采余量 FAIL（2.41 dB）已解释（§2.14），但「用户对麦克风说话能否被听到」
   仍需真人跑 `node scripts/voice-device-check.ts --wav <录音> --expect "<原文>"`；噪声下的真实对话响应也会变慢（§2.13 第三条）。
4. **生产入口的常驻语音服务**：runner 已有常驻 Python worker，生产入口（`serve-chat.ts` / `voice-turn.ts`）仍是每次一进程。
5. **三条文档-实现一致性待办：都已收尾（留档，别再当待办）**：
   - 计数类：`docs/testing.md`、`docs/handoff.md`、`README.md` 与本文件里写死的测试项数（曾出现 180 / 139 / 209 三个数并存）
     已由 **t90 / t94** 全部改成「以 `npm test` 末行为准 + 带日期的实测点」。
   - `docs/adr/0010-multi-segment-replies.md` 三处「**没有任何生产入口传 `onSegment`**」已由 **t82** 订正：
     `scripts/chat.ts` **已经传了**（核对：`git grep -n "onSegment" -- scripts`），现状是「chat CLI 已接分段播放，试用页与 `voice-turn.ts` 仍整段合成」。
   - `docs/design/conversation.md` §6/§7 的「播放侧尚未接线」已由 **t82** 改写；同表「主动开口」行的「没有候选生成器 / 没有常驻循环」已由 **t84** 改写。
   **仍然有效的规则**：改文档时不要写死测试总数、文件数或耗时——只写「以实跑末行为准」加一个带日期的实测点。
   （t54 的前瞻观测成真：接线落地的那一刻，那几处就变成了假话。）
6. **已知小项（下次动那两处时顺手改）**：`conversation.md` 里 `confidence` 字段的括号说明容易被读成「也是 1/0」
   （实际是 1 或 0.5）；`packages/domain/src/store.ts` 的 `toStoredEvent` 不回填 `sessionId`（低危：列已写入、按 sessionId 过滤仍正常）。
7. **M3 人格反馈**：「你话太多了」→ Feedback Interpreter（结构化输出 + 受控增量 + history + 回滚），
   当前只有管理员的 `overrideSelfProfile`（控制台面板走的就是它），**模型驱动的学习尚未实现**。
8. **M4 Memory**：当前只有会话内工作记忆（最近 8 轮）；长期记忆、纠正优先级、FutureHook 都还没有。
9. 已知待补：`tsc --noEmit` 类型检查、`tests/replay/`（§22.3 回放属 M5）。
10. **`onNotice` 没有产线消费者（P1 遗留，2026-10-01）**：`REPLY_HYGIENE`（工具标记/英文推理被剔除）与
    `UNBACKED_FACT_CLAIM`（未核实的具体值被扣住）两条审计通知都发给调用方，但
    `scripts/chat.ts` / `serve-chat.ts` / `field-test.ts` / `voice-turn.ts` 都没传 `onNotice`——
    于是「程序改写了她说的话」在页面与日志里与「模型本来就这么说」同形。评审建议的最小修法见
    [`review/reply-hygiene-review-2026-10-01.md`](review/reply-hygiene-review-2026-10-01.md)（F，requiredFix 二选一）。
11. **`SILENCE_ARTIFACT_ONLY` 只是候选名字**：给「整轮只剩制品 → 沉默」一个可区分的原因码是评审提的方案之一，
    **代码里并不存在**；现在轮次仍只报 `SILENCE`。落文档时不要写成已实现。
12. **提问率口径缺单测（t17 的 O2）**：「修复句不进分母」「主口径 ≠ 辅口径时按主口径判带」这两条夹具建议补进
    `tests/scenarios/realism-metrics.test.ts`；现在删掉修复句排除也不会红。该文件不在本轮 inScope。
13. **指标模块的跨包相对导入（t17 的 O3）**：`scripts/lib/realism-metrics.ts` 直接
    `../../packages/conversation/src/engine.ts` 取「修复句的唯一定义」（全仓唯一一处相对跨包导入，理由与披露见 t16 回报）。
    建议后续在 `packages/conversation/src/index.ts` 补一行 re-export 再改回 `@xixi/conversation`。
14. **登记缺口（已收尾）**：`scripts/eval-realism.ts` 已登记进 `docs/testing.md` 的脚本表与「真实 API 验收」行
    （t5 收口时补），`AGENTS.md` §7 由队长补。**重放路径的 `NaN%` 缺陷已修**（运行时记 `run` 序号、
    重放按序号重算 `perRepeat`，老 JSON 回退到「按 scenario 序列重启切分」），两份 benchmarks 报告的逐次表可复核，
    修法与该缺陷的留档见 [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md) §6。

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
- **已知耦合（后续改进项）**：`scripts/voice-turn.ts` **反向 import** `scripts/field-test.ts`（CLI 依赖 CLI）。
  评审建议把共享核心移到 `scripts/lib/`；**本轮不做，留给后续**。
- **文档与实现的两处已过期表述**（不在本轮 inScope，见 §4 第 5 条）：ADR-0010 的三处「没有任何生产入口传 `onSegment`」
  与 `conversation.md` §6 的「播放侧尚未接线」——`scripts/chat.ts` 已接。
- **`docs/recon/` 层在 t26 时被增补过**（勘测报告的三处内容，captain 决定保留）：recon 是「某一时点的实测快照」，
  但 t26 之后它不是纯快照了——后来者不要以为 recon 层从未被无痕改动；引用时看报告内的订正标记。
- **本轮流程限制（方法论，不是产品缺陷）**：
  1. **契约校验只核对成员声明的 `changedPaths`**——未声明的越界编辑不会被自动拦截，唯一防线是成员如实披露 + 评审逐处核对；
  2. **验收条款涉及的路径若没写进 `inScope`，会把达标实现判成 failed**（t2 / t4 都这样失败过）；
  3. **`deliverables` 与 `inScope` 不一致时，编辑不会进 `changedPaths`**（t26 的实例）；
  4. **任何「全绿 / 已接入」声明必须带修订号与实测输出**；
  5. **全量测试结果要在成员在途编辑窗口之外判读**（`scripts/field-test.ts` 被测试 import，改它会让全队 `npm test` 变红）。

## 7. 崩溃后如何恢复

```powershell
cd E:\worker2
npm install                             # workspace 链接 + js-yaml + dsh-tools（网络失败可挂代理 127.0.0.1:7890）
node scripts/install-dsh-profile.ts      # 幂等；重建 .dsh/profile
npm test                                # 离线测试全绿（**项数以实跑末行为准**，别把数字抄进文档）
node scripts/field-test.ts --self-test   # 现场测试控制台离线自检（项数以末行为准）
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
