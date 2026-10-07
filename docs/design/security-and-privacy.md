# 安全与隐私：§19 权限身份、§20 数据、§53 不可信内容、§41.7 审计

> 最后更新：2026-10-08（V0.3 **P2.5** 收口：§2 的工具面与审批闸门改成事实——四个 live 入口与控制台、试用页
> 都经 `createResidentRuntime()` 取链（`buildToolChain` 不再是入口出口），插件工具（含 `news.*`）在入口里可见，
> `ToolApprovalManager` 已接成 `approvalGate`；提醒工具改名 `xixi_set_reminder` 且入口已接 durable sink；
> 另补 `HARD_POLICY` 的**第二条边界**「写操作必须走工具」）
> 上一版：2026-10-04（V0.3 P2 收口：§2 的工具面改成「三个内置 + 插件工具经同一注册表」、补插件权限表与审批闸门；
> 删掉已被 P2-D 移除的 `xixi_news_stub` 与「只写内存 sink」的旧口径）
> 权威来源：`packages/contracts/src/envelope.ts` + `schemas/events/{conversation.turn,conversation.decision,presence.changed}.v1.json`、`packages/domain/src/{store,migrations/001_initial.sql,config}.ts`、`packages/brain-adapter/src/{tools,mimo,dsh,errors}.ts`、`packages/plugins/src/{manifest,context,capability-registry}.ts`、`packages/runtime/src/{tool-runtime,tool-approval}.ts`、`packages/model-adapters/src/{mimo,weather,errors}.ts`、`packages/conversation/src/engine.ts`、`apps/brain-dsh/profile/cordis.patch.yml`、`plugins/xixi-tools/index.js`、`services/perception-edge/**`、`scripts/verify-camera-presence.ts`、`scripts/lib/harness.ts`、`scripts/serve-chat.ts`、`tests/unit/core/brain-error-classification.test.ts`、`.gitignore`、`AGENTS.md` §1/§5、[progress.md](../progress.md) §2.2/§2.6/§2.10、[perception.md](perception.md)、方案 §19/§20/§41.7/§53
> 若与代码不一致，以代码为准，并请立即修正本文件
> 引用代码位置的方式：**文件名 + 函数名/测试名 + 一条可复现的 grep 命令**，不写行号——行号随任何一次编辑失效（15 处行号引用曾在数小时内漂移 13 处），见 `AGENTS.md` §9.18

本文是「方案条款 → 代码位置 → 已实现 / 仅设计」的逐条映射。**没有实现的安全项在 §5 集中列出**，不要把它们当已完成。

## 1. §19.1 Actor：枚举有，认证没有

- 枚举在 `packages/contracts/src/envelope.ts`：`ACTORS = ['father','admin','family_member','unknown_person','tv_media','xixi','system']`，
  方案列的是 `father / admin / family_member / unknown_person / tv/media`；代码把最后一个写成 **`tv_media`**，
  并额外加了 `xixi`（助手侧事件）与 `system`（服务侧事件）。事件信封 `actor` 字段是必填。
- **没有任何认证或来源判别代码**：`packages/domain/src/store.ts` 的 `recordTurn` 把 actor **硬编码**为
  `input.role === 'user' ? 'father' : 'xixi'`。也就是说，无论是谁说话（父亲、家人、电视、陌生人），
  写进事件日志的 actor **永远是 `father`** —— `unknown_person` / `tv_media` / `family_member` / `admin`
  这些枚举值在运行时代码里**从未被写入过**（核对方式：在 `packages/**/src`、`services/`、`scripts/` 里搜这几个字面量，
  只有 `packages/contracts/src/envelope.ts` 的枚举定义命中）。
- **M6 的在场检测同样不判断「是谁」**：`store.recordPresenceChanged` 的 actor 默认也是 `'father'`（允许调用方覆盖），
  感知边的 `contracts.py` 默认值同样是 `"father"`；它只回答「有没有人」（`presence.changed`），
  不做人脸识别/身份判定——所以身份分级依然只是数据契约上的枚举，不是运行时能力。
- 声纹 / 说话人验证：代码里不存在（全仓库 grep 无实现），`config/xixi.example.yaml` 里 `features.speaker_verification: false`。
- 结论：**身份分级只是数据契约上的枚举，不是运行时能力**。真正的身份判定属 M2（见 [voice.md](voice.md) §2）。

## 2. §19.2 权限等级 → 当前工具面

| 等级 | 方案举例 | 当前实现 |
|---|---|---|
| L0 内部只读 | 当前时间、WorldState、Memory search | 只有 `xixi_get_current_time`（`packages/brain-adapter/src/tools.ts` 注释标 L0；参数 `properties:{}` + `additionalProperties:false`）。**WorldState 投影已存在**（`world_state` 表，`002_world_state.sql`；由 `recordPresenceChanged` 与感知边维护）**但没有给模型读它的工具**；Memory search 未实现 |
| L1 普通外部只读 | 天气、新闻、日历读取 | `xixi_get_weather`（内置，注释标 L1）与 **News 插件的三个工具**（`news.search` / `news.latest` / `news.for_interests`，`packages/plugins/news/`，manifest 显式声明 `network` 权限，返回的外部文本一律带 `untrusted` 标记与 `flags`；[ADR-0019](../adr/0019-news-and-reminder-data-model.md)）。**旧的 `xixi_news_stub` 已随 V0.3 P2-D 从注册路径里删除**；日历未实现 |
| L2 低风险可逆 | 提醒、播放音乐、开灯 | `xixi_set_reminder`（**内置写工具**；V0.3 P2.5-E 从 `xixi_set_reminder_stub` 改名，**没有兼容别名**，返回文案是「已经记下」）——四个 live 入口经常驻装配点拿到的 sink 是 `DurableReminderSink`：落 `reminders` 表（迁移 008，五态 + 到点事件），重启后仍在（[ADR-0019](../adr/0019-news-and-reminder-data-model.md)）。**仍未接线的一环**：到点提醒要入口那一行 `...runtime.reminderSeams` 才会被主动循环说出来，见下面 §2 末与 [architecture.md](../architecture.md) §6.2。播放音乐 / 开灯未实现 |
| L3 外部通信 / 隐私 | 发消息、上传图片、改日历 | 未实现 |
| L4 高风险 | 门锁、支付、紧急呼叫 | **一律不做**（`AGENTS.md` 铁律 7；`tools.ts` 顶部注释：`No shell, no filesystem, no messaging, no high-risk actions exist yet`） |

权限在**模型之外**校验，机制是三件事：

1. 工具注册表唯一出口 `defaultTools()`（`packages/brain-adapter/src/tools.ts`，注释已改成 `The three Phase 2 built-ins`）；
   **三个内置**：`xixi_get_current_time`（read）、`xixi_get_weather`（read）、`xixi_set_reminder`（**write**）。
   插件与 MCP 的工具**不在内置里**：它们在装配点上经 `mountPluginTools()` **复制进同一个注册表**
   （核心已拥有的名字跳过、被策略拒绝的撤回），所以权限判定、轮次上限与超时对它们一字不变；
   插件自己的声明面是 manifest 的七权限（`network` / `storage` / `notify` / `context.read` / `topic.read` /
   `tool.register` / `sensor.events`）与五能力，配对关系见 [ADR-0017](../adr/0017-plugin-boundary-and-four-prohibitions.md)。
   **V0.3 P2.5 之后入口里看得到插件工具**：四个 live 入口与控制台、试用页经
   `packages/runtime/src/resident-runtime.ts` 的 `createResidentRuntime()` 取 `runtime.toolChain`
   （`git grep -l 'createResidentRuntime(' -- scripts`；反证 `git grep -n 'buildToolChain(' -- scripts ':!scripts/verify-p2-5.ts'` 应为 **0 命中**），
   而插件工具在 `start()` 里挂进同一个注册表 —— 实测：`node scripts/chat.ts --print-wiring` 在三个内置之外
   列出 `news.search` / `news.latest` / `news.for_interests`。
   可见性由 `listForAgent(scope)` 过滤（V0.3 P2-B 起改成「**除 deny 之外都广告**」，否则 `ask` 的工具模型看不见、
   审批流程没有起点；判定顺序也改成「所有 deny 规则先于 ask」，见 [ADR-0018](../adr/0018-tool-approval-frozen-args.md)）；
   离线自证见各入口的 `--print-wiring`（四个支持的入口除 `entry` 外逐字段相同）；
2. `MimoBrainAdapter.#executeTool` 只在本注册表里查找，**未知工具名 = 拒绝**（回 `{error:'没有这个工具，请直接用已有信息回答'}` 并记 `ok:false, error:'UNKNOWN_TOOL'`），不会执行任何东西；
3. 参数封闭：工具的 `parameters` 都写了 `additionalProperties: false`（时间工具是空 `properties`）。

**但 `tool_choice` 无法强制**：`MimoClient.#body` 硬编码 `tool_choice: 'auto'`，实测 `required`/具名/`none` 全被静默忽略（recon §3），
所以「必须调用工具」不能当硬门禁，只能提示词驱动 + 程序侧解析并校验 `tool_calls`（progress §2.10）。

**审批闸门（V0.3 P2-B，与上面三件事并列的第四件）**：被判 `ask` 的调用**不会执行**——先落一条
`tool_approvals`（pack §5 的七字段 + 冻结参数摘要 + 恢复用的 scope/timezone/source_event_id），
人的点头由入口交给 `ToolApprovalManager`；执行前比对摘要，对不上就 `APPROVAL_MISMATCH` 且**工具零调用**；
拒绝与到期都**不执行**、都落审计（`tool.approval.changed` 事件，`score`：人的决定 1、程序判定 0）。
**入口已接线（V0.3 P2.5）**：审批宿主由常驻装配点构造并注入链——`createResidentRuntime()` 里
`new ToolApprovalManager(...)` → 经 `approvalGate` 进 `buildPluginRuntime` → `approvals.useRegistry(toolChain)`
闭合执行路径，所以四个 live 入口与控制台、试用页都过闸门（`git grep -n 'approvalGate' -- scripts` 仍是 0 命中，
**这是对的**：接线发生在装配点内部，不在入口脚本里）。真实路径上的行为证据是
`npm run verify:p2.5 -- --scenario=approval --offline`（待批时业务数据零行、第二组参数只多一条待批、点头后执行的是
**当时冻结**的那组参数），用例在 `tests/unit/runtime/resident-runtime.test.ts`
（[ADR-0018](../adr/0018-tool-approval-frozen-args.md)）。**注意「接线」与「部署里真的会弹待批」是两件事**：
出厂配置里没有任何工具被声明成 `ask`（`config.tools.approval.ask` 是空表），接线保证的是「**声明了就拦得住**」。

**写操作必须走工具（`HARD_POLICY` 的第二条边界，V0.3 P2-H 落进生产代码）**：安全边界这一层今天有**两条**——
① 可核查的具体事实只能来自「当前对话里对方说的 / 工具真的查到的 / 系统给的可信记忆或世界状态」；
② **写下来的事必须真的用工具写**（`WRITE_OPERATION_RULE`，`packages/conversation/src/prompt.ts`）：
提醒 / 记一下 / 记住 / 记笔记这类写操作在数据上就是一次工具调用，**光回一句「记下了」而没调工具就是一句
可判定为假的话**。措辞**不点工具名**（工具名随插件与 MCP 变），只点名意图；它同时是 `HARD_POLICY` 的一行，
对普通回复与主动开口都生效。是否真的调用工具由程序侧解析并校验 `tool_calls`，不靠 `tool_choice`（见上一段）。

Harness 一侧的最小权限由 profile patch 执行（`apps/brain-dsh/profile/cordis.patch.yml`，由 `npm run install:profile` 复制进 `.dsh/`）：
显式 `disabled: true` 关掉 `tool-bash`、`tool-pwsh`、`tool-fs`、`tool-fs-search`、各种 sandbox、`skill*`、`subagent*`、
`tool-workflow`、`plan-mode`、`goal*`、`tool-todo`、`web`、`web-search-deepseek`、`web-fetch-http`、`tool-web`、`mcp-resources`、`user-questions`、`commands`、`tool-jobs`；
同时 `includeHarnessIdentity: false` 并写入西西的 `personaPrefix`/`personaSuffix`。
它只注册**两个**只读工具：`plugins/xixi-tools/index.js` 的 `xixi_get_current_time`（`parameters: {}`）与
`xixi_get_weather`（`place` + `day`，`additionalProperties: false`；天气工具由 t5 补齐，此前 `--dsh` 路径问天气只能编造或回避）。
**已知缺口（仍未修）**：DSH 插件面只注册这两个只读工具，而直连路径的 `defaultTools()` 是**三个内置**
（多出写工具 `xixi_set_reminder`）——两条路径的工具集合仍不一致，`plugins/xixi-tools/` 未同步。
注意 DSH 的 `defineTool` 隐式参数根**不带** `additionalProperties: false`（实测 `@deepseek-ai/dsh-tools` 0.1.7-rc.2），
所以天气工具的封闭性由工具体内的参数校验兜底，而不是靠注册表。

## 3. §20 数据与隐私 → 逐条映射

### 20.1 原始音频

| 方案要求 | 现状 |
|---|---|
| 内存 ring buffer | **未实现**：没有常驻音频缓冲（`services/voice-edge` 里没有环形缓冲/常开采集代码；浏览器「按住🎤」一次采集一段，`segment.py` 按文件读入） |
| 非触发片段不落盘 | ✅ **已实现**（默认策略下连整段录音都不落 `data/`）：VAD 是独立 Python 进程、需要文件输入，所以整段录音只写进**系统临时目录**（`scripts/field-test.ts` 的 `handleVoiceTurn` 里用 `mkdtempSync(tmpdir()/xixi-vad-)` 建临时目录，核对：`git grep -n "xixi-vad-" -- scripts/field-test.ts`）供读一次，**不进 `data/`**；现场测试控制台自测 `runSelfTest` 里有一条断言「隐私策略：整段录音不落盘」（核对：`git grep -n "整段录音不落盘" -- scripts/field-test.ts`）。**历史**：这条以前是反着的（旧 `/api/voice` 先把整段写进 `data/voice-web/capture-*.wav` 再做 VAD，无语音时也已经落盘），两个入口改用共享核心后修掉（见 `scripts/serve-chat.ts` 的 `handleVoice` 上方那段「why not inline any more」的注释，核对：`git grep -n "handleVoice" -- scripts/serve-chat.ts`） |
| 被识别为对话的短音频可暂存用于 ASR | ✅ 但**默认不保留**：`keepSpeechSegments = privacy.store_raw_audio && memory.raw_audio_retention_days > 0`——默认（`store_raw_audio: false`、保留 0 天）语音段也不写盘，ASR 直接用内存里的音频 |
| 调试模式可配置保留 N 天 | ✅ **已实现**（不再是「配置项无人读取」）：`scripts/field-test.ts` 的 `retentionPolicy(config)` 读 `privacy.store_raw_audio` + `memory.raw_audio_retention_days`，`pruneVoiceDir()` 在**启动时清理过期文件**；两个入口都在用（`scripts/serve-chat.ts` 顶层的启动期清理：`retentionPolicy(config)` + `pruneVoiceDir(VOICE_DIR, policy)`，随后打印 `[privacy] 按保留策略清理 …`；现场测试控制台在 `createFieldServer` 启动时与 `handleVoiceTurn` 每轮结束前各清理一次，核对：`git grep -n "pruneVoiceDir" -- scripts/field-test.ts scripts/serve-chat.ts`）。开启后只写 VAD 检出的语音段到 `data/voice-web/`，保留 N 天 |
| 正式运行不长期保存原始环境音 | ✅ **默认成立**（不落盘、不保留）；开启保留时是**按天数粗粒度**清理 + 手工删目录，**没有针对单条记录的删除接口**（细粒度删除仍属 M4 的记忆管理） |

**唯一硬约束是「不进版本库」**：`data/` 与 `.env` 都在 `.gitignore`（`.gitignore` 含 `data/`、`.dsh/`、`.venvs/`、`.env`、`.env.local`）。
上传侧的最小化是真的（只有 VAD 语音段进 ASR，`scripts/voice-turn.ts` 与 `scripts/serve-chat.ts` 都有注释与实现），
落盘侧现在也有默认「什么都不留」的策略；**剩下的缺口是细粒度删除与保留期的可视化**。

### 20.2 原始视频

**M6 已落地本地在场检测**（`services/perception-edge/`，一次性进程：capture → detect → debounce → emit）：

| 方案要求 | 现状 |
|---|---|
| 本地检测、只留事件 | ✅ **帧差动 + 人脸确认**（320×240 灰度帧差动作廉价门，每 10 帧一次 YuNet 人脸确认；Haar 为显式降级后端），产出 `presence.changed` 事件与 `world_state.presence` 投影 |
| 连续视频不上云 | ✅ **由构造保证**：感知边没有任何网络客户端（`run.py` 注释写明 `One process, no service, no cloud`），并有测试断言；本机实测也未出网 |
| 不上传截图 / 按需语义分析 | **刻意未实现**：只留接口 `SemanticAnalysisHook`，`capture_snapshot()` 调用即抛 `SemanticAnalysisNotImplemented`——所以**没有任何代码路径能上传图像** |
| 画面不入仓库 | ✅ 帧只在内存里活过一次 `detect()` 调用（不落盘、不写图片/视频），仓库不跟踪画面；YuNet 模型文件在 `data/models/`（`data/` 已 gitignore，模型不入库） |

必须写清的边界（不得夸大）：**真人站在镜头前的检出自测尚未完成**（摄像头朝天，需要人参与），M6 目前是场景夹具 +
本机自测的验证强度（细节与数字见 [perception.md](perception.md) §3/§8）。另外 `config/xixi.example.yaml` 的
`features.camera_presence: false` 仍是**未被任何代码读取的声明**（与 §3 里 memory/privacy 各段的处境相同）。

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

### 20.5 关系笔记的听众过滤（V0.3 P2.5-J）

关系笔记是**推导出来的私密内容**（「我们怎么相处」），所以它进不进提示词要看**此刻谁在听**：

| 听众模式 | 关系笔记 |
|---|---|
| `public`（有外人在场 / 电视 / 媒体） | **一条都不给**——不是「注入了再让模型别说」，而是在**选择阶段**就过滤掉，模型可见文本里不会出现 |
| `private` / `family` | 照旧给 |
| 没给听众 | 按保守默认档 `family`（与「拿不准谁在听」的既有做法一致） |

判定集中在**一处**：`packages/context/src/relationship-context.ts` 的 `notesVisibleTo`
（核对：`git grep -n 'notesVisibleTo' -- packages`）；`relationship_notes` 表**没有逐条可见性列**，所以能做的只有
「按听众整批给或整批不给」，改这条口径只需要改那一个函数。与「未完话题在 public 下不给」是同一条保守做法。

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
5. **保留期与删除接口**（该项只**部分**实现）：**音频**保留期 ✅ 已实现（`privacy.store_raw_audio` + `memory.raw_audio_retention_days` 被 `retentionPolicy()` 读取，见 §20.1）；**对话（transcript）**保留期与**针对单条记录/单条对话的删除接口**仍未实现（`memory.raw_transcript_retention_days` 至今没有任何读取方，见 §20.3）。
6. **独立日志 redact 层**：未实现（靠不打印）。
7. **§53 的显式不可信内容标签**：未实现。
8. **出网白名单**：未实现。
9. **按需语义分析（截图交多模态模型）**：**刻意未实现**——只留 `SemanticAnalysisHook` 接口，
   `capture_snapshot()` 调用即抛 `SemanticAnalysisNotImplemented`。M6 的「图像不出设备」边界正是靠这个「不实现」保证的，
   接它之前必须先补 §53 的标签与出网约束。
10. **真人站在镜头前的在场检出自测**：**未完成**（摄像头朝天，需要人参与）。M6 目前的证据是场景夹具与本机自测，
    不要把「有人/无人判定已实现」读成「已在真人条件下验收」（数字与复现见 [perception.md](perception.md) §3/§8）。

## 6. §41.7 / §55 审计：`reason_code` 与分数

- **事件是唯一事实来源**（ADR-0003）。调用点数量**以实测为准、不写死**：核对命令 `git grep -n "appendEvent(" -- packages`（当前 5 处；`packages/domain/src/store.ts` 里 `appendEvent(event: EventEnvelope)` 那一行是**定义**，不算调用点）：

  | 文件 | 函数 | 事件 |
  |---|---|---|
  | `packages/domain/src/store.ts` | `recordHealth` | `system.health` |
  | `packages/domain/src/store.ts` | `recordTurn` | `conversation.turn` |
  | `packages/domain/src/store.ts` | `recordPresenceChanged` | `presence.changed`（**与 `world_state` 投影同一事务**，M6 感知边） |
  | `packages/conversation/src/engine.ts` | `ConversationEngine.#recordDecision` | `conversation.decision`（t5 新增） |
  | `packages/conversation/src/proactive.ts` | `ProactiveEngine.#record` | `proactive.decision`（主动开口的判定记录；只存 `reason_code` 与分值） |

  还有一条**不经过 `appendEvent`** 的写入路径：感知边进程用 Python 直接 SQL 写同一个库
  （`services/perception-edge/perception_edge/emitter.py`，`INSERT INTO events` 与 `world_state` 同一事务；
  `scripts/verify-camera-presence.ts` 把这些事件**手工重建信封对象之后**用 `validateEvent()` 校验一遍，
  核对：`git grep -n "validateEvent(" -- scripts/verify-camera-presence.ts`）。
  **`createSession` 不写事件；`seedSelfProfile` / `overrideSelfProfile` 只写 `self_profile` 与 `self_profile_history`，同样不写事件。**
  所以「每条状态变更都进事件表」目前对**对话轮次、接受判定、健康状态、在场状态与主动开口判定**成立。
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

## 7. 失败分类口径（`BrainError`）：诊断不要看错层

现场测试时最先撞到的安全/配置问题就是「没配密钥」，而它的**分类**决定用户被告知什么，因此这里写死口径。

- **两层错误对象**：`ModelError`（`packages/model-adapters/src/errors.ts`，provider 侧）与
  `BrainError`（`packages/brain-adapter/src/errors.ts`，适配器接缝，见《方案》§25）。上层只 `switch (BrainError.code)`。
- **原始 provider 码不丢**：`BrainError` 带 `originalCode` 字段（并同时留在 `detail` 文本里），
  所以「哪一类失败」不会因为映射而消失。
- **两条路径共用同一张映射表** `brainErrorCodeFor()`（`packages/brain-adapter/src/errors.ts`），避免直连与 DSH 对同一个码有两种理解：
  - **直连（`MimoBrainAdapter`）**：`ModelError.code` 直接决定 `BrainError.code`，并记进 `originalCode`。
    口径示例（缺密钥）：`MIMO_API_KEY` 未设置 → `MimoClient` 在**任何请求发出之前**抛
    `ModelError('MISSING_KEY')` → 适配器报 `BrainError.code = TRANSPORT_FAILED`、
    `originalCode = MISSING_KEY`、`detail` 含 `MISSING_KEY:`，**fetch 一次都没被调用**。
    HTTP 状态映射：401/403 → `AUTH`、402 → `QUOTA`、429 → `RATE_LIMIT`、400/404/422 → `BAD_REQUEST`、
    ≥500 → `PROVIDER_FAILED`、连不上 → `TRANSPORT_FAILED`（`originalCode = NETWORK`）。
  - **DSH（`DshBrainAdapter`）**：harness 报 `ok:false` 时 `BrainError.code` **保持 `PROVIDER_FAILED`**
    （既有契约，`tests/integration/brain-adapter.test.ts` 断言的就是这一条），但 harness 自己的码
    （`AUTH`/`RATE_LIMIT`/`QUOTA`/`BAD_REQUEST`/`MISSING_CREDENTIAL` 等）会进 `originalCode`
    （不在闭集里的码则留在 `detail`）。
- **为什么重要**：`curl` 不通与「忘配 `.env`」在过去都显示成网络类失败，会把人引向错误的排查方向；
  分类保真后这几类是分开的，§21.1 的降级也才有依据去区分「换密钥 / 退避重试 / 供应商故障」。
- **离线覆盖**（无需新增测试，口径已被钉住；按**测试名**引用，不写行号）：
  `tests/unit/core/brain-error-classification.test.ts` 的三条用例——
  `a missing key arrives as MISSING_KEY before any request is attempted`（缺密钥 → `ModelError('MISSING_KEY')`，
  且经适配器后 `code = TRANSPORT_FAILED`、`originalCode = MISSING_KEY`、`detail` 含 `MISSING_KEY`、fetch 未被调用）、
  `HTTP status classes survive the adapter seam instead of collapsing into PROVIDER_FAILED`（按 HTTP 状态逐类断言
  `code` + `originalCode`）、`the DSH path keeps the harness error code in originalCode`（DSH 侧原始码进 `originalCode`）；
  `tests/integration/brain-adapter.test.ts` 的 `a missing API key fails as MISSING_KEY before any request is attempted`
  在集成层复核同一件事（含 `attempted === 0`）。核对命令：
  `git grep -n "^test(" -- tests/unit/core/brain-error-classification.test.ts tests/integration/brain-adapter.test.ts`。

## 维护规则

| 改了哪个源文件 | 必须同步更新本文件的小节 |
|---|---|
| `packages/contracts/src/envelope.ts`（ACTORS） | §1 |
| `packages/domain/src/store.ts`（`recordTurn` 的 actor、`appendEvent` 调用点、`recordPresenceChanged`、`overrideSelfProfile`） | §1、§6（`appendEvent` 的调用点清单） |
| `packages/contracts/schemas/events/conversation.turn.v1.json` 或 `conversation.decision.v1.json`（新增字段 / 新事件类型） | §6（`reason_code` 与分值是否落库、是否只存 code 与分数） |
| `packages/conversation/src/engine.ts` 的 `#recordDecision`（decision 事件字段） | §6（拒绝轮次的记录方式与字段清单） |
| `packages/brain-adapter/src/tools.ts` 或新增任何工具 | §2（等级表、参数封闭、未知工具处理） |
| `apps/brain-dsh/profile/cordis.patch.yml`、`plugins/xixi-tools/index.js` | §2（Harness 侧最小权限面） |
| `packages/model-adapters/src/mimo.ts`（错误构造、密钥读取） | §3.20.4（密钥纪律、是否有回显路径）、§7（失败分类口径） |
| `packages/brain-adapter/src/errors.ts`（码表、`brainErrorCodeFor`、`originalCode`） | §7 |
| `services/perception-edge/**`（感知边；`emitter.py` 直接 SQL 写 `events` + `world_state`） | §3.20.2（原始视频：本地检测、不上云、画面不落盘）、§6（事件写入方） |
| `scripts/verify-camera-presence.ts`（在场验收脚本） | §3.20.2 |
| `packages/model-adapters/src/weather.ts` 或新增外部数据源 | §4（外部主机清单、不可信内容分层） |
| `scripts/lib/harness.ts`（`readDotEnv`/`harnessEnv`） | §3.20.4 |
| `scripts/serve-chat.ts`（语音落盘与上传范围） | §3.20.1 |
| `.gitignore` | §3（哪些目录不进版本库） |
| `config/xixi.example.yaml`（privacy/features/memory 段） | §3、§5（哪些只是声明） |
| 里程碑推进（M2 身份/声纹、M4 记忆与删除、M3 回滚） | 全文，尤其 §1、§5、§6 |
