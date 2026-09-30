# 安全与隐私：§19 权限身份、§20 数据、§53 不可信内容、§41.7 审计

> 最后更新：2026-09-30
> 权威来源：`packages/contracts/src/envelope.ts` + `schemas/events/conversation.turn.v1.json`、`packages/domain/src/{store,migrations/001_initial.sql,config}.ts`、`packages/brain-adapter/src/{tools,mimo}.ts`、`packages/model-adapters/src/{mimo,weather}.ts`、`apps/brain-dsh/profile/cordis.patch.yml`、`plugins/xixi-tools/index.js`、`scripts/lib/harness.ts`、`scripts/serve-chat.ts`、`.gitignore`、`AGENTS.md` §1/§5、[progress.md](../progress.md) §2.2/§2.6/§2.10、方案 §19/§20/§41.7/§53
> 若与代码不一致，以代码为准，并请立即修正本文件

本文是「方案条款 → 代码位置 → 已实现 / 仅设计」的逐条映射。**没有实现的安全项在 §5 集中列出**，不要把它们当已完成。

## 1. §19.1 Actor：枚举有，认证没有

- 枚举在 `packages/contracts/src/envelope.ts`：`ACTORS = ['father','admin','family_member','unknown_person','tv_media','xixi','system']`，
  方案列的是 `father / admin / family_member / unknown_person / tv/media`；代码把最后一个写成 **`tv_media`**，
  并额外加了 `xixi`（助手侧事件）与 `system`（服务侧事件）。事件信封 `actor` 字段是必填。
- **没有任何认证或来源判别代码**：`packages/domain/src/store.ts` 的 `recordTurn` 把 actor **硬编码**为
  `input.role === 'user' ? 'father' : 'xixi'`。也就是说，无论是谁说话（父亲、家人、电视、陌生人），
  写进事件日志的 actor **永远是 `father`** —— `unknown_person` / `tv_media` / `family_member` / `admin`
  这些枚举值在运行时代码里**从未被写入过**。
- 声纹 / 说话人验证：代码里不存在（全仓库 grep 无实现），`config/xixi.example.yaml` 里 `features.speaker_verification: false`。
- 结论：**身份分级只是数据契约上的枚举，不是运行时能力**。真正的身份判定属 M2（见 [voice.md](voice.md) §2）。

## 2. §19.2 权限等级 → 当前工具面

| 等级 | 方案举例 | 当前实现 |
|---|---|---|
| L0 内部只读 | 当前时间、WorldState、Memory search | 只有 `xixi_get_current_time`（`packages/brain-adapter/src/tools.ts` 注释标 L0；参数 `properties:{}` + `additionalProperties:false`）。WorldState / Memory search 未实现 |
| L1 普通外部只读 | 天气、新闻、日历读取 | 只有 `xixi_get_weather`（注释标 L1）。新闻不可用（该密钥 `webSearchEnabled is false`，recon §3），日历未实现 |
| L2 低风险可逆 | 提醒、播放音乐、开灯 | 未实现 |
| L3 外部通信 / 隐私 | 发消息、上传图片、改日历 | 未实现 |
| L4 高风险 | 门锁、支付、紧急呼叫 | **一律不做**（`AGENTS.md` 铁律 7；`tools.ts` 顶部注释：`No shell, no filesystem, no messaging, no high-risk actions exist yet`） |

权限在**模型之外**校验，机制是三件事：

1. 工具注册表唯一出口 `defaultTools()`（`packages/brain-adapter/src/tools.ts`，注释 `New tools join here and nowhere else`）；
2. `MimoBrainAdapter.#executeTool` 只在本注册表里查找，**未知工具名 = 拒绝**（回 `{error:'没有这个工具，请直接用已有信息回答'}` 并记 `ok:false, error:'UNKNOWN_TOOL'`），不会执行任何东西；
3. 参数封闭：两个工具的 `parameters` 都写了 `additionalProperties: false`（时间工具是空 `properties`）。

**但 `tool_choice` 无法强制**：`MimoClient.#body` 硬编码 `tool_choice: 'auto'`，实测 `required`/具名/`none` 全被静默忽略（recon §3），
所以「必须调用工具」不能当硬门禁，只能提示词驱动 + 程序侧解析并校验 `tool_calls`（progress §2.10）。

Harness 一侧的最小权限由 profile patch 执行（`apps/brain-dsh/profile/cordis.patch.yml`，由 `npm run install:profile` 复制进 `.dsh/`）：
显式 `disabled: true` 关掉 `tool-bash`、`tool-pwsh`、`tool-fs`、`tool-fs-search`、各种 sandbox、`skill*`、`subagent*`、
`tool-workflow`、`plan-mode`、`goal*`、`tool-todo`、`web`、`web-search-deepseek`、`web-fetch-http`、`tool-web`、`mcp-resources`、`user-questions`、`commands`、`tool-jobs`；
同时 `includeHarnessIdentity: false` 并写入西西的 `personaPrefix`/`personaSuffix`。
它只注册一个只读工具：`plugins/xixi-tools/index.js` 的 `xixi_get_current_time`（`parameters: {}`）。

## 3. §20 数据与隐私 → 逐条映射

### 20.1 原始音频

| 方案要求 | 现状 |
|---|---|
| 内存 ring buffer | **未实现**：没有常驻音频缓冲；浏览器「按住🎤」一次采集一段，Python 侧 `segment.py` 整文件读入 |
| 非触发片段不落盘 | **部分实现但反着来**：`/api/voice` **先把整段录音写盘**（`data/voice-web/capture-<ts>.wav`）再做 VAD；无语音时这段录音**已经落盘**了 |
| 被识别为对话的短音频可暂存用于 ASR | ✅ 实现：`sliceWav` 切出语音段写 `speech-<ts>.wav` 并送去 ASR |
| 调试模式可配置保留 N 天 | **未实现**：`config/xixi.example.yaml` 里有 `memory.raw_audio_retention_days: 0`，但 `config.ts` 把 `proactive`/`memory`/`privacy`/`features` 四段都只解析成 `Record<string, unknown>`，全仓库**没有任何读取/清理代码** |
| 正式运行不长期保存原始环境音 | **未实现**：没有保留期、没有删除接口 |

**唯一硬约束是「不进版本库」**：`data/` 与 `.env` 都在 `.gitignore`（`.gitignore` 含 `data/`、`.dsh/`、`.venvs/`、`.env`、`.env.local`）。
上传侧的最小化是真的（只有 VAD 语音段进 ASR，`scripts/voice-turn.ts` 与 `scripts/serve-chat.ts` 都有注释与实现），
**本地落盘侧的保留策略还没有**。

### 20.2 原始视频

**完全未实现**：仓库里没有摄像头代码，`config` 里 `features.camera_presence: false`。方案 §20.2 的「本地检测、只留事件截图、不上云」属 M6。

### 20.3 Transcript

| 方案要求 | 现状 |
|---|---|
| 本地数据库 | ✅ `data/**/*.sqlite`（`node:sqlite`），对话文本作为 `conversation.turn` 事件落库 |
| 可配置保留周期 | **未实现**（`memory.raw_transcript_retention_days: 30` 无人读取） |
| Memory 与 raw transcript 分离 | Memory 系统**尚不存在**（M4），因此目前只有 raw transcript 一种数据 |
| 支持用户删除 | **未实现**：没有删除对话/事件的接口 |
| 管理工具能查「为什么记住这条」 | **未实现**（依赖 M4） |

### 20.4 Secrets

| 方案要求 | 现状 |
|---|---|
| API key 不写 repo | ✅ 只从 `process.env.MIMO_API_KEY` 或 `.env` 读取（`packages/model-adapters/src/mimo.ts` 的 `MimoClient` 构造函数；`scripts/lib/harness.ts` 的 `readDotEnv`/`harnessEnv`）。`.env` 已 gitignore，模板是 `.env.example` |
| 使用环境变量 / secret store | ✅ 环境变量 + `.env`；Harness 子进程用 `harnessEnv()` 显式透传（`env` 里只挑 `MIMO_API_KEY`、代理变量与 `.env` 内容）。DSH 凭据解析顺序见 progress §2.2（进程环境快照 → `$DSH_HOME/.credentials.yaml` → `<cwd>/.env` → `$DSH_HOME/.env`） |
| 日志自动 redact | **未实现独立 redact 层**；保证来自「不打印」：`MimoClient.#post` 的错误只取 `payload.error.message` 或截断 300 字的响应体，`#headers` 缺 key 时抛的是 `MIMO_API_KEY is not set`（**不含密钥值**），`readDotEnv` 只返回值、绝不打印。`CliDshTransport.onDiagnostic` 会转发 dsh 的 stderr（若 harness 自己回显密钥则会漏出，**未验证**） |
| 不允许模型读取全部环境变量 | ✅ 模型只能看到工具定义与工具结果；没有环境变量工具，DSH profile 也关掉了 shell/文件系统 |

**历史事实（必须遵守）**：`MIMO_API_KEY` 曾在对话里明文出现，`AGENTS.md` §5 要求视为已泄露并在验证完成后到小米控制台**轮换**。
本仓库文档、测试与源码中**没有**这个密钥的值。

## 4. §53 不可信内容与网络边界

- **当前真正的外部内容只有两处**：Open-Meteo 的 geocode/forecast 响应（`packages/model-adapters/src/weather.ts`）
  与 MiMo 的模型响应（`packages/model-adapters/src/mimo.ts`）。
- 已实现的分层是**结构性的**：工具结果由程序裁剪成小对象（`createWeatherTool.execute` 只返回地点/日期/温度/降水概率等字段，
  `weather.ts` 注释写明「the model never sees the raw payload」），并以 **`role: 'tool'`** 消息回灌
  （`MimoBrainAdapter.#executeTool`），与 `system` 提示词是不同消息角色，工具名与参数都由程序校验。
- **未实现**：方案 §53 要求的显式标签体系（`USER_INSTRUCTION` / `SYSTEM_POLICY` / `TOOL_DATA` / `EXTERNAL_UNTRUSTED_CONTENT`）。
  全仓库代码里没有 `untrusted` 相关的标记或隔离逻辑（`tools.ts` 只有一句注释把天气标为 *L1, read-only external*）。
  目前没有任何网页/新闻/家庭消息/日历数据源（该密钥的联网搜索不可用，profile 也关掉了 web 插件），
  所以这条缺口的**当前**注入面很窄，但接 M4/M5 的任何外部内容前必须先补。
- **DNS / 网络边界**：代码里出现的外网主机只有三个 ——
  `api.xiaomimimo.com`（chat / ASR / TTS）、`geocoding-api.open-meteo.com`、`api.open-meteo.com`。
  没有出网白名单、没有 DNS 过滤，代理只在需要时由环境变量提供（`AGENTS.md` §4）。

## 5. 明确未实现的安全项（不要当成已完成）

1. **身份认证**：`Actor` 是枚举，不是能力；用户轮次硬编码为 `father`（§1）。
2. **声纹**：不用于高风险认证——目前根本没有声纹；方案 §19.3 的另一半（「用于降低电视误触 / 个性化」）也还是 M2 的活。
3. **L4 工具**：门锁 / 支付 / 紧急呼叫一律不做（铁律 7）。
4. **L2/L3 工具与其确认策略**：未实现（没有提醒、消息、日历）。
5. **音频/对话保留期与删除接口**：未实现（配置项存在但无人读取）。
6. **独立日志 redact 层**：未实现（靠不打印）。
7. **§53 的显式不可信内容标签**：未实现。
8. **出网白名单**：未实现。

## 6. §41.7 / §55 审计：`reason_code` 与分数

- **事件是唯一事实来源**（ADR-0003）。`packages/domain/src/store.ts` 只提供两个 `appendEvent` 调用点——
  `recordTurn`（`conversation.turn`）与 `recordHealth`（`system.health`）；
  第三个事件类型 `conversation.decision` 由**引擎**调用 `store.appendEvent` 直接追加
  （`packages/conversation/src/engine.ts` 的 `#recordDecision`）。
  **`createSession` 不写事件；`seedSelfProfile` / `overrideSelfProfile` 只写 `self_profile` 与 `self_profile_history`，同样不写事件。**
  所以「每条状态变更都进事件表」目前只对**对话轮次、接受判定与健康状态**成立。
- **被拒绝的轮次有记录**：`ConversationEngine.respond` 在 `accepted === false` 时**不**调用 `recordTurn`
  （所以它不会变成对话历史，也不会进入工作记忆），但会先追加一条 `conversation.decision`，
  因此在事件日志里可以查到「这句话为什么没被接受」。
  接受的一轮也会写一条（在 `finally` 里，所以「接受了、随后供应商报错」同样留痕）。
- **`reason_code` 与分值已落库**（`conversation.decision`）：payload 是
  `session_id / turn_index / accepted / reason / action / fsm_state / fsm_state_before / addressed /
  acceptance_score / linger_ms / silence_tolerance`
  （`packages/contracts/schemas/events/conversation.decision.v1.json`，`additionalProperties: false`）。
  `reason` 取值就是 `TurnAcceptanceReason`（`packages/conversation/src/fsm.ts`）的四个值：
  `ACCEPTED_WAKE_OR_DIRECT` / `ACCEPTED_CONTINUATION` / `REJECTED_NOT_ADDRESSED` / `REJECTED_SUSPENDED`；
  分值由 `acceptance_score`（1/0）与 envelope 的 `confidence`（1 / 0.5）承担。
  **仍然只存 `reason_code` 与分值**：payload 里没有用户原话（他说了什么只在 `conversation.turn` 里，
  那是事实本身）、没有提示词、没有任何模型私有推理——`tests/integration/conversation-engine.test.ts`
  断言该 payload 不含本轮文本且没有 `text` 字段。
  `conversation.turn` 的 payload 保持
  `session_id / turn_index / role / action / text / tool_name`
  （`packages/contracts/schemas/events/conversation.turn.v1.json`）不变，因此 `reason_code` 是**新事件类型**
  而不是给已发布的 v1 加字段（`additionalProperties: false` 冻结了 v1 的形状）。
- **self profile 变更**：`overrideSelfProfile(values, reason = 'admin:override')` 每条属性写一行
  `self_profile_history`（`before_value`/`after_value`/`source_type`/`summary`/`created_at`），
  但 `source_event_id` **恒为 NULL**、`confidence` **硬编码为 1**；
  `selfProfileHistory()` 可查历史，**没有 rollback 方法**（"可回滚"要靠再调一次 `overrideSelfProfile` 手工写回）。
  `packages/domain/src/personality.ts` 注释明确：§7.4 的漂移限制与回滚属 **M3**。
- 工具调用审计：`ToolCallRecord`（`{name,args,ok,result,error}`）通过 `onToolCall` 回调给调用方，
  落库的是事件 payload 里的 `tool_name`（只留第一个工具名，不留参数）。

## 维护规则

| 改了哪个源文件 | 必须同步更新本文件的小节 |
|---|---|
| `packages/contracts/src/envelope.ts`（ACTORS） | §1 |
| `packages/domain/src/store.ts`（`recordTurn` 的 actor、`appendEvent` 调用点、`overrideSelfProfile`） | §1、§6（`appendEvent` 的调用点清单） |
| `packages/contracts/schemas/events/conversation.turn.v1.json` 或 `conversation.decision.v1.json`（新增字段 / 新事件类型） | §6（`reason_code` 与分值是否落库、是否只存 code 与分数） |
| `packages/conversation/src/engine.ts` 的 `#recordDecision`（decision 事件字段） | §6（拒绝轮次的记录方式与字段清单） |
| `packages/brain-adapter/src/tools.ts` 或新增任何工具 | §2（等级表、参数封闭、未知工具处理） |
| `apps/brain-dsh/profile/cordis.patch.yml`、`plugins/xixi-tools/index.js` | §2（Harness 侧最小权限面） |
| `packages/model-adapters/src/mimo.ts`（错误构造、密钥读取） | §3.20.4（密钥纪律、是否有回显路径） |
| `packages/model-adapters/src/weather.ts` 或新增外部数据源 | §4（外部主机清单、不可信内容分层） |
| `scripts/lib/harness.ts`（`readDotEnv`/`harnessEnv`） | §3.20.4 |
| `scripts/serve-chat.ts`（语音落盘与上传范围） | §3.20.1 |
| `.gitignore` | §3（哪些目录不进版本库） |
| `config/xixi.example.yaml`（privacy/features/memory 段） | §3、§5（哪些只是声明） |
| 里程碑推进（M2 身份/声纹、M4 记忆与删除、M3 回滚） | 全文，尤其 §1、§5、§6 |
