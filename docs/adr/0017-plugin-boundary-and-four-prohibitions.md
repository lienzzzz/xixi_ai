# ADR-0017：插件边界与四条「插件不能做」

- 状态：已采纳（2026-10-04，V0.3 P2-A t2/t18；P2 收口 t15 落笔）
- 相关：铁律 1（模型只做理解与判断）、铁律 2（不许模型改核心提示词/权限/策略）、铁律 3（主动行为的硬底线由程序判定）、
  铁律 8（外部内容是不可信数据、工具权限在模型之外校验）、[ADR-0018](0018-tool-approval-frozen-args.md)、
  pack `E:\xixi_v03_actual_code_pack` 的 `03_AGENT_PLUGIN.md` §1/§2/§3、
  `packages/plugins/src/{manifest,capability-registry,manager,context,prompt-authority,disposal}.ts`、
  `packages/runtime/src/tool-runtime.ts`

## 背景

pack §1 的要求是「从现有 `ToolRegistry` **升级，不推翻**」，§3 给出九步生命周期，并点名四条
「插件不能」：**不能直接拿主 SQLite handle、不能改 core system prompt、不能直接读 raw camera/mic、不能绕过 ToolPermission**。

P2-0 的地图（[`../v03/P2_PLUGIN_GAP_MAP.md`](../v03/P2_PLUGIN_GAP_MAP.md)，钉 `767f505`）实测：那四条里
**只有 1 条是真强制点**（工具权限在 `ToolRegistry.execute` 里判），另三条当时是「结构习惯」或「根本没有入口」——
「没有入口」不等于「被禁止」：把插件上下文补上 `storage` 之类的东西，第二天就会长出绕过。

## 决定

### 1. `ToolRegistry` 升级而不是替换

`register()` 的返回值同时是**可调用的 disposer**与**带 `.dispose()` 的对象**，且幂等；新增 `ToolRegistry.dispose()`
一次清空。这条是「不推翻」的字面执行：既有调用方与既有用例**一行未改**仍然绿
（核对：`git grep -n "register(" -- packages/brain-adapter/src/tool-registry.ts`、`git grep -n "\.dispose()" -- packages`）。

### 2. manifest 是声明面，五能力与七权限各有配对

```text
schemaVersion / id / name / version / entry? / permissions / requiredPermissions / capabilities / health

capabilities（五）  tool  topic_source  context_provider  sensor_source  action
permissions（七）   network  storage  notify  context.read  topic.read  tool.register  sensor.events

CAPABILITY_PERMISSIONS（packages/plugins/src/manifest.ts）
  tool             → tool.register
  topic_source     → topic.read
  context_provider → context.read
  sensor_source    → sensor.events
  action           → notify
```

只要能力不要配对权限，**在加载之前**就被拒；`requiredPermissions` 里写了 `permissions` 没覆盖的项，
在 `validate` 步就拒。`network` 不是任何能力的配对项，必须**显式声明并说明理由**（news 插件就是这么做的）。

### 3. 九步生命周期，每步都有落点

```text
discover → validate → permission → load → activate(ctx) → register capabilities → health → deactivate → dispose
```

`PLUGIN_LIFECYCLE_STEPS`（`packages/plugins/src/manager.ts`）；`manager.steps(pluginId)` 给出逐步记录，
`health` 可重复跑。每一步的失败都是**响亮拒绝**（`PluginLifecycleError`），不是静默降级。

### 4. 四条「不能」各自的强制点

| 禁止 | 强制点（今天在代码里的哪一处） |
|---|---|
| 直接拿主 SQLite handle | 插件上下文**没有** `store`；`storage` 授权只接受字符串，拿到句柄就拒（`RestrictedStore`，错误里点名「主库句柄只属于核心」；边界标签 `sqlite-handle`） |
| 修改 core system prompt | `prompt-authority.ts`：核心段**逐字节**核对 + 加载期文本过滤（边界标签 `core-system-prompt`） |
| 直接读 raw camera/mic | 既不是上下文的属性，**也不是权限表里的 token**（`PLUGIN_PERMISSIONS` 里没有 camera/mic；边界标签 `raw-camera-mic`）；插件只能拿过滤后的 `sensor.events` 事件 |
| 绕过 ToolPermission | 插件工具被**复制进同一个 `ToolRegistry`**，经同一条 `ToolRegistry.execute` 执行——权限、轮次上限、超时都不变；插件拿不到 `ToolExecutionContext`（它只属于宿主，见 ADR-0018） |

前三条在 P2-A 之前是「习惯」，本 ADR 之后是**有强制点的边界**；t9 评审与 t19 复审各自用突变实验证明它们承重
（关掉守卫 → 对应用例变红）。

### 5. 命名与作用域：插件工具不许进核心命名空间

`RESERVED_TOOL_PREFIXES = ['xixi_', 'core.']`——插件工具落在这些前缀上是**拒绝注册**，不是警告。
插件工具默认作用域只有 `conversation`（放宽要显式传并说明理由）。于是 news 是 `news.*`、MCP 是 `mcp.<server>.<tool>`。

### 6. 能力注册到模型可见，只有一处

`packages/runtime/src/tool-runtime.ts` 的 `mountPluginTools()`：核心已拥有的名字**跳过**（永不覆盖），
被策略拒绝的工具**注册后撤回**（模型看不到），插件 `deactivate → activate` 后同名不同对象的副本**刷新**。
`buildPluginRuntime()` 是装配点：`start()` 跑完九步生命周期**并**挂载。

## 后果

- **状态口径（必须分开写）**：**内核已交付并已接线到装配点**（`buildPluginRuntime().start()` 之后模型能在
  `definitionsForRound` 里看到插件工具，能被核心执行）；**四个 live 入口尚未接线**——`scripts/chat.ts`、
  `serve-chat.ts`、`field-test.ts`、`voice-turn.ts` 今天仍只调 `buildToolChain`
  （核对：`git grep -n "buildPluginRuntime" -- scripts` 只命中 `probe-tools.ts`）。文档不许把这两件事写成一句
  「插件已接入入口」。
- 仍未做、**不得写成已实现**：manifest 的 **tool 级 approval 声明**（见 ADR-0018 的后果）、
  `PluginRuntimeMount.start()` 不幂等（第二次调用会留下「插件 inactive 但工具还在核心表里」的半坏状态，t19 的 O1）、
  热插拔后 `shutdown()` 的 `unmounted` 少报（t19 的 O2，只是报告口径）。
- 「不在入口里」也有好处：插件面是**可选装配**，不配置新闻/MCP 的部署里，工具链与 P0 逐字相同。
- **下一阶段接线项（四条，缺一条都会让下一个任务以为它已经在守）**：
  1. 四个 live 入口（`scripts/chat.ts` / `serve-chat.ts` / `field-test.ts` / `voice-turn.ts`）仍走 `buildToolChain`，
     下一步应改成 `buildPluginRuntime(config, { news, mcpServers, reminderSink }).start()`；
  2. 提示词装配点（`packages/conversation` 的 `PromptAssembler`）没有调 `verifyOnAssemble`；
  3. 四个 live 入口没有把 `ToolApprovalManager` 接成 `approvalGate`（见 [ADR-0018](0018-tool-approval-frozen-args.md)）；
  4. manifest 的 **tool 级 approval 声明**未实现（只有 `config.tools.approval.ask` 在起作用；`ActionHandler.approval`
     只作用于 `action` 能力，而 `action` 还没暴露成工具）——**下一轮的小任务**，本轮因它与 `packages/plugins`
     和 `packages/domain/src/config.ts` 都有交集、要再串一层依赖而没有排。
  完整清单与实测反证见 [`../progress-v03.md`](../progress-v03.md) 的 P2 段 §4/§5。

> **加注（2026-10-08，V0.3 P2.5 落笔；本 ADR 原文一字未改）**：上面两处「未接线」的**现状变了**——
> ① **入口已接线**：七个入口脚本都走 `packages/runtime/src/resident-runtime.ts` 的 `createResidentRuntime()`
> （它内部调 `buildPluginRuntime(...).start()`），所以「插件工具对模型可见」在真实入口里成立。
> 复核：`git grep -l 'createResidentRuntime(' -- scripts`；反证 `git grep -n 'buildToolChain(' -- scripts ':!scripts/verify-p2-5.ts'` 为 **0 命中**
> （`probe-tools.ts` 仍是诊断探针，故意不经装配点）。
> ② 上面四条接线项里 **1–3 已落地**（入口走装配点；提示词装配点上有 `verifyOnAssemble` 的调用点；
> `ToolApprovalManager` 由装配点接成 `approvalGate` 并经 `useRegistry()` 闭合）；**第 4 条（manifest 的 tool 级 approval
> 声明）仍未做**。
> ③ 同批登记的 `start()` 不幂等与「停用后 health 快照过期」已由 P2.5-I 修掉（响亮拒绝 `PluginAlreadyStartedError`；
> 停用后读 `PluginInstance.online` 才知道是真在线）。
> 本 ADR 的**边界设计与四条禁令一字未变**，变的只是「谁在调装配点」；现况见 [`../progress.md`](../progress.md) §12。
