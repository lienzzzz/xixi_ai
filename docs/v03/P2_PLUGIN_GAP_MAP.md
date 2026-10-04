# V0.3 Phase 2：P2 插件与工具面现状地图（P2_PLUGIN_GAP_MAP）

> 最后更新：2026-10-05（V0.3 P2-0 / t1）：对照 pack（E:\xixi_v03_actual_code_pack）的 docs/03_AGENT_PLUGIN.md 八节与 skeleton/plugins/types.ts，逐节给出「pack 要什么 / 今天代码在哪 / 缺什么 / P2 准备加到哪个包哪个文件」。
> 权威来源：**当前代码与测试**（`git grep` 实测）。pack 文档与 skeleton 是**设计意图**，与本文冲突时以本文（代码事实）为准。
> 基线修订号：`767f505`（`git rev-parse HEAD` 实测）。**本文所有「今天」都以这个修订号为准。**
> 复核方式：每条结论下面给一条**可整行复制**的 `git grep` 与它的实测输出。要在**基线上**原样复跑，把命令写成 `git grep -n <模式> 767f505 -- <路径>`（`git grep` 的 tree-ish 形式），或 `git show 767f505:<路径>`。

**这份地图是 P2 后面六条实现任务（P2-A 插件内核 / P2-C MCP / P2-B 工具审批 / P2-D News / P2-E Reminder / P2-F Provider 收缩）的共同起点**，也是 P2 的「接线」类声明将来被评审核对时的底稿。它**不描述期望架构**：没写进本文的能力，今天在代码里就不存在。

> **P2 收口后的状态注（2026-10-04，t15 落笔）**：**六条实现任务都已完成并入库**，所以本文里每一句
> 「今天没有 / 今天仍是」都请读作「**P2 开工前（`767f505`）没有 / 仍是**」——那是本文件的价值所在（基线证据），
> **不是现状**。现状与交付号见 [`../progress-v03.md`](../progress-v03.md) 的 P2 段；
> 逐条设计决定见 [ADR-0017](../adr/0017-plugin-boundary-and-four-prohibitions.md)（插件边界与四禁止项）、
> [ADR-0018](../adr/0018-tool-approval-frozen-args.md)（工具审批）、[ADR-0019](../adr/0019-news-and-reminder-data-model.md)（新闻与提醒）、
> [ADR-0020](../adr/0020-provider-three-interfaces-and-mcp-deps.md)（Provider 三接口与 MCP 依赖理由）。
> **唯一一句不能按「已解决」读的**：四条 live 入口的接线仍未做（入口仍走 `buildToolChain`、没接审批宿主与 durable 提醒、
> 没配 MCP 服务器）——口径见 P2 段 §4/§5。本文的 §4（MCP）与 §8（Provider 收缩）当年是「完全没有 / 七成员胖接口」，
> 今天分别是「已交付的 `packages/plugins/mcp`」与「三接口 + 四能力退役」。

---

## 0. 怎么读这份地图

1. 命令一律用**函数名 / 常量名**定位，不写行号（`AGENTS.md` §9.18：行号随任何一次编辑失效；本仓曾有文档钉了 15 处行号、13 处漂移）。
2. **零命中 = 今天不存在**：这条命令的退出码是 1，那是 `git grep` 的「没有命中」语义，不是命令失败。本文照抄这个退出码。
3. 反引号里的仓库路径**都真实存在**（`scripts/check-docs.ts` 的 `REPO_PATH` 会把不存在的仓库路径当文档错误）；**尚未创建的落点一律不写进反引号**，用「建议落点（尚未创建）」标出。
4. 「今天」= `767f505`。写作期间 P2-A（plugin-eng）与 P2-F（types-eng）已在工作区开工：`git status --short` 显示 `packages/plugins/` 未跟踪、`packages/brain-adapter/src` 下五个文件已改。**本文不引用这些在途改动**——它们还没提交，也不是现状。
5. pack 的两处输入（本文逐节对照）：
   - 需求：E:\xixi_v03_actual_code_pack\docs\03_AGENT_PLUGIN.md（八节）；
   - 形状：E:\xixi_v03_actual_code_pack\skeleton\plugins\types.ts（`PluginCapability` 五个枚举、`XixiPluginManifest` 七个字段、`PendingToolApproval` 七个字段 + `status`）。

---

## 1. pack 03 §1：从 ToolRegistry 升级，不推翻

pack 要的是「已有 `register/unregister`、`permission`、`round cap`、`timeout` 之上再加 PluginManager / CapabilityRegistry / ApprovalManager / McpClientAdapter」。**四件已有能力逐条核对如下（全部有实测命中，四件都真实存在且被生产路径使用）**：

| pack 要的 | 今天在哪（定义处） | 生产调用点 | 缺什么 | P2 落点 |
|---|---|---|---|---|
| `register` / `unregister` | `packages/brain-adapter/src/tool-registry.ts` 的 `ToolRegistry.register`（**返回值就是一个 dispose 函数** `() => this.unregister(name)`）、`ToolRegistry.unregister` | `createToolRegistry` 的构造与 7 个 live 入口 | 没有「插件清单驱动的注册」、没有加载前后钩子、没有 health | P2-A：在 `ToolRegistry` **之上**加 `CapabilityRegistry`，`tool` 能力最终仍调 `registry.register` |
| `permission` | 同文件的 `ToolPermission`（实现 `ToolPermissionPolicy`）与 `check`；判定顺序：`deniedTools` → `askTools` → `risk==='dangerous'` → `scopes` → `write` 的角色/场景收窄 | `ToolRegistry.listForAgent`、`ToolRegistry.check`、`ToolRegistry.execute` | 权限只按 `risk`+`scopes`+`role` 判，**不认识 manifest 声明的 `permissions`**；没有「声明的权限先于加载生效」 | P2-A：manifest `permissions` → 加载门；P2-B：`ask` 那条分支接审批 |
| `round cap` | `MAX_TOOL_ROUNDS = 4`、`ToolRegistry.definitionsForRound`（超过上限返回 `undefined`，循环因此结束）；消费方是 `runAgentLoop` | `packages/brain-adapter/src/agent-loop.ts` 的 `runAgentLoop`（唯一调用点） | 无（cap 是程序常量，模型改不了）——**P2 不得放宽** | 保持；P2 所有新工具都走同一 cap |
| `timeout` | 同文件 `executeTool` + `withTimeout`、`MAX_TOOL_TIMEOUT_MS = 60_000`、`DEFAULT_TOOL_TIMEOUT_MS = 10_000`、按工具声明的 `timeoutMs` 夹取 | `ToolRegistry.execute` | 无；插件工具应当同样受这条硬顶 | 保持；P2-A 的插件工具必须复用 `executeTool`，不得自建执行路径 |

另有两条**不属于 pack 清单、但同样是「不能推翻」的既有语义**：参数封闭校验（`declaredArgumentNames`，未声明参数被拒而不是静默忽略）与「未知工具名是拒绝而不是崩溃」（`UNKNOWN_TOOL`）。

### 复核命令与实测（§1）

```powershell
git grep -n -E -- 'export class ToolRegistry|register\(tool|unregister\(name' 767f505 -- packages/brain-adapter/src
git grep -n -- 'definitionsForRound' 767f505 -- packages/brain-adapter/src
git grep -n -- 'MAX_TOOL_ROUNDS' 767f505 -- packages/brain-adapter/src
git grep -n -E -- 'MAX_TOOL_TIMEOUT_MS|DEFAULT_TOOL_TIMEOUT_MS|function withTimeout' 767f505 -- packages/brain-adapter/src
git grep -n -E -- 'class ToolPermission|verdict' 767f505 -- packages/brain-adapter/src/tool-registry.ts
git grep -n -- 'registry.execute' 767f505 -- packages
```

实测（基线 `767f505`）：

- `export class ToolRegistry {` 在 `tool-registry.ts`；`register(tool: XixiTool | AgentTool): () => void`、`unregister(name: string): boolean`、构造里 `this.register(tool)` 各一行。
- `definitionsForRound` 命中 5 处：定义 1 处 + 调用 1 处（`agent-loop.ts` 的 `runAgentLoop`）+ 注释 3 处。
- `MAX_TOOL_ROUNDS` 命中 8 处：定义 `= 4`（`tool-registry.ts`）、`index.ts` 转出、`mimo.ts` 作为构造默认值、其余是注释。
- 超时三件各 1 处定义 + `executeTool` 里的夹取表达式 1 处。
- `ToolPermission` 与 `verdict` 命中 16 行：`ToolPermission` 类 1 处定义、`verdict` 的九条分支（`deny` / `ask` / `allow`）与 `listForAgent` / `check` / `execute` 三处消费。
- `registry.execute` 全仓只有 1 个调用点：`agent-loop.ts` 的 `runAgentLoop`（另一处是注释）。

---

## 2. pack 03 §2：Plugin Manifest 与 capabilities 五个枚举在今天的落点

**结论：五个能力枚举与 `XixiPluginManifest` 今天在仓库里零落点。** 今天存在两种「manifest」，但都不是 pack 说的插件清单：

| 今天的「manifest」 | 位置 | 它声明什么 | 与 pack 03 §2 的差距 |
|---|---|---|---|
| workspace 包清单（npm 语义） | 各包的 `package.json`（`git ls-files 'packages/*/package.json'` 列出 7 份） | `name` / `exports` / `dependencies` | 没有 `schemaVersion` / `capabilities` / `permissions`；`entry` 由 `exports` 承担 |
| DSH 插件清单 | `plugins/xixi-tools/package.json`（`dsh.bundle.patch` + `peerDependencies`） | 挂载方式与 peer 依赖 | 同样没有 `capabilities` / `permissions`；它的工具是 **DSH 进程内**用 `ctx.tools.register` 注册的（见 §3） |

**已存在但今天不成立的一条事实（上一轮遗留，P2-F 要补）**：`packages/brain-adapter/package.json` 的 `dependencies` 只声明了 `@xixi/contracts` 与 `@xixi/domain`，而源码里有 **6 处** `@xixi/model-adapters` 的 import（其中 `tools.ts` 的 `WeatherClient`、`mimo.ts` 的 `MimoClient`、`index.ts` 的转出是**值层面**依赖）。这是「声明与事实不符」，不是「跑不起来」：本仓用 npm workspaces，`node_modules/@xixi/*` 是 junction 软链，Node 解析不读 `dependencies` 字段，所以 `npm run check:types` 与运行都不报错。

### 复核命令与实测（§2）

```powershell
git grep -n -E -- 'PluginCapability|topic_source|context_provider|sensor_source' 767f505 -- '*.ts'
git ls-tree -r --name-only 767f505 -- packages/plugins
git show 767f505:packages/brain-adapter/package.json
git grep -n -- '@xixi/model-adapters' 767f505 -- packages/brain-adapter/src
git ls-files 'packages/*/package.json' 'apps/*/package.json' 'plugins/*/package.json'
Get-ChildItem node_modules\@xixi | Select-Object Name,LinkType,Target
```

实测（基线 `767f505`）：

- 第一条**零命中**（退出码 1）——`PluginCapability` / `topic_source` / `context_provider` / `sensor_source` 在全部 `*.ts` 里一处都没有。
- `git ls-tree ... -- packages/plugins` **空输出**——`packages/plugins` 这个包在基线上不存在（`packages/` 下只有 brain-adapter / context / contracts / conversation / domain / model-adapters / runtime 七个）。
- `packages/brain-adapter/package.json` 的 `dependencies` 实测为 `{"@xixi/contracts": "*", "@xixi/domain": "*"}`；`@xixi/model-adapters` 的 import 命中 6 行（`agent-loop.ts`、`fake.ts`、`index.ts`、`mimo.ts`、`tool-registry.ts`、`tools.ts`）。
- 9 份清单：`apps/brain-dsh`、`packages/` 下 7 个、`plugins/xixi-tools`。
- `node_modules/@xixi` 下是 8 个 junction（含 `model-adapters` → `E:\worker2\packages\model-adapters`）。

### 准备怎么加（§2）

- P2-A（t2，plugin-eng）——建议落点（**尚未创建**，故不加反引号）：新包 packages/plugins，内含 manifest 模块（`XixiPluginManifest` + `PluginCapability` 五枚举 + 校验）、capabilities 模块（`CapabilityRegistry`）、manager 模块（九步生命周期 + `Disposable`）；`tool` 能力经它注册进**现有** `ToolRegistry`。该包的 `package.json` 必须声明它真正 import 的 workspace 包（照 brain-adapter 的反例）。
- 五个枚举的**唯一事实来源**应当是 `packages/plugins`（`skeleton/plugins/types.ts` 只作为形状参考，不要复制成第二份定义）；`scripts/check-docs.ts` 已覆盖 `packages/**/*.ts`，新包不需要改 `tsconfig.json` 的 include。
- P2-F（t5，types-eng）顺手补 `packages/brain-adapter/package.json` 的 `@xixi/model-adapters` 声明，并确认 `npm install` 后 lock 无额外变化。

---

## 3. pack 03 §3：Plugin 生命周期九步，与「四个插件不能做」今天的强制点

### 3.1 九步各自的今天

| pack 的九步 | 今天有没有对应物 | 证据 |
|---|---|---|
| discover | **无** | 全仓 `*.ts` 零命中 |
| validate | **无**（工具参数在**执行时**校验，不是插件加载时） | `declaredArgumentNames` 在 `executeTool` 里 |
| permission | 有一半：`ToolPermission.check` 在**注册后、执行前**判；没有「加载前按 manifest 声明判」 | §1 |
| load | **无**（今天的工具是「已经构造好的对象」，直接 `new` / `defaultTools()`） | `defaultTools` 组装 4 个内置 |
| activate(ctx) | **无** | — |
| register capabilities | 只有最底层的 `register(tool)` | `ToolRegistry.register` 返回 `() => unregister` |
| health | **无** | — |
| deactivate | 半：`unregister(name)` 能把工具摘掉 | `ToolRegistry.unregister` |
| dispose | 半：`register` 返回的 dispose 函数就是 `unregister` 的闭包 | `register(tool): () => void` |

即：今天唯一存在的生命周期语义是「注册 / 注销（=dispose）」，其余七步要在 P2-A 从零建。

### 3.2 四个「插件不能做」逐条：今天到底有没有强制点

**总判断：四条里有 1 条是真实强制点（④），3 条只是「结构上今天没这么用」或「约定」，没有强制点。** 逐条如下。

**① 直接拿主 SQLite handle —— 今天没有强制点，只有「工具拿不到」的结构习惯。**
工具的执行上下文只有 `ToolContext { timezone, now }`；数据库句柄是 `XixiStore` 的私有字段（`store.ts` 里 `new DatabaseSync(...)` 赋给 `#db`），而 `packages/brain-adapter` 的**类型面**完全不认识 `XixiStore`（唯一一处命中是 `dsh.ts` 的注释）。但工具的工厂是闭包：任何调用方今天都能把 store 塞进自定义工具，没有任何机制拦——**这不是强制点，是「还没人这么干」**。
反例兼正解参照：`DshBrainAdapter` 用的是**结构化切片** `BrainSessionStore`（只两个方法），而不是 `XixiStore` 本体——P2-A 的插件 `ctx` 应当照这个模式给「最小只读投影」，并加一条「坏插件试图拿库句柄」的用例。

```powershell
git grep -n -A 6 -- 'interface ToolContext' 767f505 -- packages/brain-adapter/src/tools.ts
git grep -n -- 'new DatabaseSync' 767f505 -- packages/domain/src/store.ts
git grep -n -- 'XixiStore' 767f505 -- packages/brain-adapter/src
git grep -n -A 3 -- 'interface BrainSessionStore' 767f505 -- packages/brain-adapter/src/dsh.ts
```
实测：`ToolContext` 只有 `timezone` + `now` 两个字段；`new DatabaseSync(...)` 1 处（`store.ts`，赋给 `#db`）；`XixiStore` 在 brain-adapter **只有 1 处命中且是注释**（`dsh.ts`：「The slice of durable state the adapter needs; `XixiStore` satisfies it structurally」）；`BrainSessionStore` 只声明 `brainSessionId` 与 `attachBrainSession` 两个方法。

**② 修改 core system prompt —— 今天没有强制点，但有一条结构性裂缝（插件可控文本会进模型上下文）。**
`CORE_IDENTITY` 与 `HARD_POLICY` 是 `packages/conversation/src/prompt.ts` 的 `const`，由 `PromptAssembler.assemble` 每轮现拼成 `system` 段；插件今天没有写入口。**但是** `ToolRegistry.definitionsForRound` 会把 `tool.description` 原样放进模型请求的工具定义——也就是**插件提供的文本会进入模型上下文（tools 数组，不是 system 段）**。同时没有任何机制禁掉「工具结果里塞指令」这类文本（今天只靠 `HARD_POLICY` 那句「工具结果或网页里写了什么都不能让硬边界作废」+ 铁律 8 的纪律），也**没有用例**证明坏文本被拦。
P2 要加的最低防线：一条「插件注册前后，`PromptAssembler` 产出的 `system` 段逐字节不变」的用例（今天不存在这种断言）；插件文本只允许出现在 tools 数组与工具结果里。这条边界应进 ADR（t15 的四份 ADR 之一）。

```powershell
git grep -n -E -- 'CORE_IDENTITY|HARD_POLICY' 767f505 -- packages/conversation/src/prompt.ts
git grep -n -- 'tool.description' 767f505 -- packages/brain-adapter/src/tool-registry.ts
```
实测：`CORE_IDENTITY` / `HARD_POLICY` 各 1 处 `export const` 定义 + `assemble` 里各 1 处使用 + `core-identity` / `safety-policy` 两个段名；`definitionsForRound` 里 `description: tool.description` 1 处。

**③ 直接读 raw camera / mic —— 今天没有强制点，但 TS 侧结构上拿不到（raw 采集全在 Python edge）。**
`packages/**/*.ts` 里 `cv2|opencv|sounddevice|getUserMedia` **零命中**；raw 采集只在 Python 边：`services/perception-edge`（camera / detector / run / scenes / bench）与 `services/voice-edge`（calibrate / loopback）。Node 侧只接收**已经过滤成事件行**的字符串（`packages/runtime/src/perception-ingest.ts` 的 `ingestPerceptionLine`），工具面更是只拿到 `ToolContext`；图片只能由调用方**按轮次显式**附到某一次用户轮（`UserTurnInput.images`，铁律 6 的「一张帧、由程序决定」）。
缺的是能力面定义：`sensor_source` 这个枚举今天没有任何 JS 语义，插件**怎么**拿到（或拿不到）传感器事件还没设计。P2 的最低要求是「不给插件原始帧/原始音频」这条边界与用例；真正的传感器接入是 Phase 7。

```powershell
git grep -n -i -E -- 'cv2|opencv|sounddevice|getUserMedia' 767f505 -- 'packages/**/*.ts'
git grep -l -i -E -- 'cv2|sounddevice' 767f505 -- services
git grep -n -- 'ingestPerceptionLine' 767f505 -- packages/runtime/src
git grep -n -- 'readonly images' 767f505 -- packages/brain-adapter/src/types.ts
```
实测：第一条**零命中**（退出码 1）；第二条列出 `services/perception-edge/perception_edge/` 下 5 个 `.py` 与 `services/voice-edge/voice_edge/` 下 2 个 `.py`；`ingestPerceptionLine` 定义 1 处 + 被 `replay-runtime.ts` 调用 1 处 + `index.ts` 转出；`UserTurnInput.images` 1 处声明。

**④ 绕过 ToolPermission —— 今天有真实强制点（模型侧绕不过），但「插件自报风险」这半边没有。**
真实强制点有两条可核证据：**`executeTool` 全仓只有 1 个调用方**（`ToolRegistry.execute`），**`registry.execute` 全仓只有 1 个调用方**（`runAgentLoop`），而模型那一侧只拿到 `messages` / `tools` / `round`（`AgentStep.call` 的签名），拿不到 registry——「模型直接执行工具」在代码结构上不可能。
没有的那半边：`ToolRegistry.register` 接受任何 `AgentTool`，**没有「permission 判定先于注册」这一层**；插件可以自己声明 `risk: 'read'` 却做写操作，今天没有任何运行时机制核对「声明的风险」与「真实行为」是否一致。P2-A 的「manifest `permissions` 先于加载生效」+「插件要的权限比 manifest 声明的多 → 拒」两条用例补的是这个缺口；「声明与行为一致」仍无法运行时证明，属于要写进 ADR 的已知边界。

```powershell
git grep -n -- 'executeTool' 767f505 -- packages scripts
git grep -n -- 'registry.execute' 767f505 -- packages
git grep -n -A 2 -- 'interface AgentStep' 767f505 -- packages/brain-adapter/src/agent-loop.ts
```
实测：`executeTool` 3 行（`index.ts` 转出、`tool-registry.ts` 定义、`ToolRegistry.execute` 内调用）；`registry.execute` 2 行（注释 + `runAgentLoop` 调用）；`AgentStep` 只有 `call(messages, tools, round)`。

### 3.3 复核命令（§3 九步）

```powershell
git grep -n -- 'ctx.tools.register' 767f505 -- plugins
git grep -n -E -- 'discover|deactivate|dispose' 767f505 -- 'packages/**/*.ts'
```
实测：`ctx.tools.register` 在 `plugins/xixi-tools/index.js` 命中 2 处（时间 + 天气两个工具）——这是今天**唯一**一种「插件」：DSH 进程内插件，通过 `plugins/xixi-tools/package.json` 的 `dsh.bundle.patch` 挂载，**它不在 P2-A 的插件模型里，也不受四个禁止项约束**（它跑在 DSH 进程里，能 `readFileSync`）。第二条命令在基线上只命中 1 行、且是注释（`tool-registry.ts` 里 `register` 的文档注释提到 `dispose` 这个词），`discover` 与 `deactivate` **零命中**——写 P2-A 时要重跑这条：一旦出现真实现，说明九步生命周期已经落地。

---

## 4. pack 03 §4：MCP

**结论：今天完全没有 MCP。** 生产 `*.ts` 里 `mcp` 零命中；SDK 没装。

```powershell
git grep -n -i -- 'mcp' 767f505 -- '*.ts'
git grep -n -i -- 'mcp' 767f505
Test-Path node_modules\@modelcontextprotocol
node -e "console.log(JSON.stringify(require('./package.json').dependencies))"
```
实测：第一条**零命中**（退出码 1）；第二条的命中全是文档与配置，没有生产代码——`apps/brain-dsh/profile/cordis.patch.yml` 里 DSH 自带的 `mcp-resources`、`docs/design/security-and-privacy.md` 对它的引用、`xixi_ai_companion_project_plan.md` 的扩展点清单，以及本仓两份运行时地图对「零命中」这件事的记录本身；`node_modules/@modelcontextprotocol` 不存在（`False`）；根 `package.json` 的 `dependencies` 实测就是 `{"js-yaml":"^5.4.2"}`（devDependencies 里有 `@deepseek-ai/dsh-tools`、`@types/node`、`typescript`）。

缺：`McpClientAdapter`（discover → normalize to Xixi AgentTool → namespace → ToolRegistry）、命名空间 `mcp.<server>.<tool>` 与内置工具的撞名检查、发现失败/断连的降级路径、以及「MCP 不作为高频 sensor bus」这条边界（今天不存在，所以天然成立，接上以后要用调用图证明）。落点是 P2-C（t3，plugin-eng）：在 P2-A 的注册面上接，不另起一套注册；离线证据用**本地桩 MCP 服务器**；引入 SDK 要按铁律 12 写理由，装不上或必须联网时**先报 captain**（t3 契约的要求）。注意它会动 `package.json` 与 `package-lock.json`。

---

## 5. pack 03 §5：Tool Approval

**结论：今天有一个「ask」的判定值，但没有审批。** 具体是：

- 判定面存在：`ToolPermission.check` 会返回 `verdict: 'ask'`（`askTools` 选项）；
- **但 `askTools` 在生产里没有任何调用点**：全仓只有定义处两行 + `tests/unit/core/tool-registry.test.ts` 里造的工具 `xixi_write_probe`（测试专用）；
- `ToolRegistry.execute` 遇到 `ask` 直接返回**一句拒绝文案**的工具结果（`{ error: '这个能力要先得到同意：先问一句，别自己动手。' }`），**不落库、不冻结参数、没有恢复路径**；
- 没有 `PendingToolApproval` 类型（`*.ts` 零命中）；没有审批相关的事件类型（`packages/contracts/schemas/envelope.v1.json` 的 `event_type` 枚举只有六个值：`presence.changed`、`conversation.turn`、`conversation.decision`、`proactive.decision`、`open_thread.changed`、`system.health`）。

**一个必须在 P2-B/P2-E 之前说清的上下文缺口**：工具执行上下文只有 `scope / timezone / now / role`，**没有 `sessionId`、没有 `actorId`、没有「这一轮的事件 id」**；而 `PendingToolApproval` 需要 `sessionId` + `actorId`，durable reminder 的 `source_event_id` 也需要「这一轮的事件 id」。所以 P2-B 与 P2-E 都要扩展 `ToolExecutionContext`（以及 `runAgentLoop` 的 `context`、7 个入口的传参）——**由入口提供，模型不能提供**（铁律 1/8）。建议 P2-B 先定义、P2-E 复用，不要各扩一套。

**pack 正文与 skeleton 的一处差异（诚实记录）**：pack 03 §5 的 `PendingToolApproval` 列了七个字段（approvalId / sessionId / toolName / frozenArgs / requestedAt / expiresAt / actorId）；skeleton/plugins/types.ts 多一个 `status: "pending" | "approved" | "denied" | "expired" | "executed"`。建议采用「七字段 + status」，并把这条差异写进 ADR（避免评审按字面计数时把 `status` 当成越界字段）。

```powershell
git grep -n -- 'askTools' 767f505 -- packages scripts
git grep -n -- 'xixi_write_probe' 767f505 -- tests
git grep -n -A 6 -- 'interface ToolExecutionContext' 767f505 -- packages/brain-adapter/src/tool-registry.ts
git grep -n -A 2 -- 'readonly context:' 767f505 -- packages/brain-adapter/src/agent-loop.ts
node -e "const j=require('./packages/contracts/schemas/envelope.v1.json');console.log(JSON.stringify(j.properties.event_type.enum))"
```
实测：`askTools` 只有 `tool-registry.ts` 两行（字段声明 + `#ask` 初始化）；`xixi_write_probe` 全在 `tests/unit/core/tool-registry.test.ts`；`ToolExecutionContext` = `scope` / `timezone` / `now` / `role?`；`runAgentLoop` 的 context = `{ timezone, clock }`；`event_type` 枚举实测就是上面六个值。

**落点（P2-B = t4，本任务的后续）**：审批状态机与冻结参数执行放在 `packages/brain-adapter`（与注册表/权限同层，才能拿到 `check()` 的 `ask` 判定）；pending 记录要持久化 → `packages/domain` 的**新增**迁移（纯新增，铁律 10）+ store 读写方法；「西西自然问一句 → 用户确认 → 执行 EXACT frozen call → append tool result → 恢复轮次」的接线在会话层（`packages/conversation` 的引擎与入口）。**迁移号要与 P2-E 串行分配，不要两个任务同时声称同一个号。**

---

## 6. pack 03 §6：News

**结论：命名仍是 `xixi_news_stub`，provider 接口只有一个方法，且从未在生产入口注入。**

- 工具名：`packages/brain-adapter/src/tools.ts` 的 `createNewsTool` 里 `name: 'xixi_news_stub'`；
- provider 接口：`NewsProvider` 只有 `name` + `latest(input: { limit, topic? })`——**没有 `search`、没有 `forInterests`**；
- 生产注入：`newsProvider` 全仓只出现在 `packages/runtime/src/tool-runtime.ts` 的 `ToolChainOptions` 与 `buildToolChain` 摊平里，**7 个 live 入口一个都没传** → live 路径下 news 工具永远返回 `{ available: false, items: [], note: '新闻源还没接上…' }`；
- 名字 `news.search` / `news.latest` / `news.for_interests` 全仓零命中；
- `TopicSource` 九个来源里有 `'news'`，但**没有生产者**：`scripts/field-test.ts` 把 live 表写死为 `live: source === 'open_thread'`；
- 「personally relevant」缺事实来源：`packages/*/src` 里 `interest` 零命中（没有兴趣模型；偏好类记忆在 `packages/domain/src/memory.ts` 的偏好条目里）。

**「今天有什么新闻？」今天会发生什么（Phase 2 验收场景 1 的现状）**：`xixi_news_stub` 是 `risk: 'read'` 且 `scopes` 含 `conversation`，所以 `listForAgent` 会把它广告给模型，模型**会形成 tool call**，但拿到的是 `available: false` + 一句「新闻源还没接上」；fake 路径的台词在 `fake.ts` 的 `case 'xixi_news_stub'`。也就是说：**工具链是通的、内容是空的**——P2-D 要把它换成一个真实 provider，同时保留「拿不到就直说、不许编」这条诚实性。

```powershell
git grep -n -- 'xixi_news_stub' 767f505 -- packages scripts
git grep -n -A 5 -- 'interface NewsProvider' 767f505 -- packages/brain-adapter/src/tools.ts
git grep -n -- 'newsProvider' 767f505 -- scripts packages/runtime
git grep -n -- 'TOPIC_SOURCES' 767f505 -- packages scripts
git grep -n -i -- 'interest' 767f505 -- 'packages/*/src'
```
实测：`xixi_news_stub` 5 行（`tools.ts` 注释 2 + 工具名 1 + `fake.ts` 2：`NEWS_WORDS` 触发与 `case` 台词）；`NewsProvider` 只有 `latest` 一个方法；`newsProvider` 只在 `tool-runtime.ts` 2 行、**脚本零命中**；`TOPIC_SOURCES` 定义在 `packages/conversation/src/topic-engine.ts`（九个值 `Object.freeze`），消费在 `packages/conversation/src/index.ts` 与 `scripts/field-test.ts`（后者把 live 写成 `source === 'open_thread'`）；`interest` 在 `packages/*/src` **零命中**。

**改名会打到的既有测试（给 P2-D 的硬清单，派单时必须进 inScope——`AGENTS.md` §9.1 子规则）**：

```powershell
git grep -n -E -- 'xixi_news_stub|xixi_set_reminder_stub' 767f505 -- tests scripts
```
实测命中：`scripts/probe-tools.ts`（挑 `xixi_set_reminder_stub` 当探针）、`tests/console/field-test-console.test.ts`（把四个内置工具名钉成字面量）、`tests/console/live-entry-tool-chain.test.ts`（工具名数组 + 每个工具的权限表）、`tests/unit/core/tool-loop.test.ts`（用 `xixi_set_reminder_stub` 造 tool plan）、`tests/unit/core/tool-registry.test.ts`（`BUILT_INS` 常量 + guest 看不到写工具的断言）、`tests/unit/tools.test.ts`（工具清单 + `risk` 断言）。**改名/加工具不把这些文件一起改，`npm test` 必红。**

**落点（P2-D = t6，news-eng）**：工具与 provider 在 `packages/brain-adapter`（`tools.ts` 或新拆一个 news 模块）；TopicSource 的 `news` 生产者在 `packages/conversation/src/topic-engine.ts`，并把 live 表从写死的 `open_thread` 改成由能力注册决定；四条主动新闻要求（fresh / personally relevant / not already mentioned / not quiet context）分别可复用：话题去重看 `packages/conversation/src/topic-history.ts` 的 `topicOfferedWithin`、静默时段看 `packages/conversation/src/proactive.ts` 的 `quietHours` 与硬底线门；「不可信数据」（铁律 8）要有对抗用例。真实来源可以放 `packages/model-adapters`（网络客户端）或 news 自己在 brain-adapter 里实现，由 t6 决定并写理由。

---

## 7. pack 03 §7：Reminder

**结论：现有 sink 明确不会响，而且是内存的；八个字段的表、调度器、状态机、时刻解析全部为零。**

- 工具名仍是 `xixi_set_reminder_stub`，参数是 `what` + `when`（**自然语言 when 原样进 sink**）；
- sink 接口只有 `schedule({ what, when, recordedAt })`，默认实现 `createMemoryReminderSink` 是**进程内数组**（`const reminders = []`）；
- 工具返回里有一句自认：「已经记下；**到点不会自动响**，需要人看一眼」——这是今天「不会响」的字面证据；
- `packages/domain/src` 里 `reminder` 零命中、全仓 `due_at` 零命中、迁移只到 `006_memory_status.sql`；
- 没有调度状态机（`pending → due → delivered → acknowledged` 一个都没有）、没有提醒事件类型（`event_type` 枚举见 §5）。

**「明天八点提醒我打电话。」今天会发生什么（Phase 2 验收场景 2 的现状）**：fake 路径的 `REMINDER_WORDS` 会触发 `xixi_set_reminder_stub`，工具把 `when` 字符串原样存进数组并回一句「记着了」；**进程一结束就没了**——重启后没有这条记录，也不会到点形成事件。

```powershell
git grep -n -- '到点不会自动响' 767f505 -- packages
git grep -n -A 4 -- 'interface ReminderSink' 767f505 -- packages/brain-adapter/src/tools.ts
git grep -n -- 'createMemoryReminderSink' 767f505 -- packages scripts
git ls-tree -r --name-only 767f505 -- packages/domain/src/migrations
git grep -n -- 'due_at' 767f505
git grep -n -- 'reminder' 767f505 -- packages/domain/src
```
实测：note 原文 1 处（`tools.ts` 的 `createReminderTool.execute`）；`ReminderSink.schedule` 只有 `what`/`when`/`recordedAt`；`createMemoryReminderSink` 3 行（定义、`index.ts` 转出、`createReminderTool` 的默认值）；迁移清单六份（001 到 006）；`due_at` **零命中**；`reminder` 在 domain 的 `src` 下**零命中**。

**可复用的落点（到点成事件）**：`packages/runtime/src/proactive-runtime.ts` 的 `ProactiveLoop` 已经有按分钟 tick 的时钟钩子 `PROACTIVE_CLOCK_HOOKS`（`future_hook_due` 就是「之前提过的事到点」的既有钩子）；事件写入走 `packages/domain/src/store.ts` 的 `appendEvent`（内部还会 `validateEvent`）。

**落点（P2-E = t8，bugfix-eng）**：表 → `packages/domain/src/migrations/` 的**新增**迁移（纯新增，旧文件一字不改）+ domain 的 store 读写方法；调度状态机与 tick 接线 → `packages/runtime`（消费点是 `ProactiveLoop` / 一个新 tick）；工具面 → `packages/brain-adapter` 的 reminder 工具与 sink 替换（写 durable 表而不是数组）；新事件类型要同时改三处：`packages/contracts/schemas/envelope.v1.json` 的 `event_type` 枚举、`packages/contracts/schemas/events/` 下的新 payload schema、`packages/contracts/src/events.ts` 里的一行 `define(...)`。**两条纪律**：① 迁移号与 P2-B 的审批表**串行分配**；② `tests/perception/world-state-projection.test.ts` 把已发布迁移文件列表钉成字面量（`git grep -n -- '001_initial.sql' 767f505 -- tests` 可复核），加迁移会让它变红——派单时该路径必须在 inScope（`AGENTS.md` §9.1 子规则点名过这条）。

---

## 8. pack 03 §8：Provider / Harness 接口收缩（BrainAdapter → 三接口）

**结论：三个新接口名今天零命中；`BrainAdapter` 仍是一个七个成员的胖接口（3 个通用成员 + 4 个能力方法），三个实现类都被迫实现那四个「没人调、只会抛」的能力方法。**

> **P2-F 之后（2026-10-04，t15 落笔）**：上面这句是 **`767f505` 的事实**。现在 `BrainAdapter` **不再导出**，
> 接口拆成三份（`TurnModelProvider` 必须；`MultimodalTurnProvider` 带字面量 `supportsImages: true`；
> `StructuredInferenceProvider` 带 `inferJson`），下面列的四能力方法**已从接口与三个实现类里一并删除**
> （不是留着抛 `NOT_IMPLEMENTED`），`NOT_IMPLEMENTED` 这个错误码今天**没有生产者**；
> 四组类型保留为 retired capability 数据契约并注明真实归属（`ProactiveEngine` / `TurnMemoryExtractor` / `TopicEngine` / 确定性反馈解释，都在 `@xixi/conversation`）。
> 复核：`git grep -n "TurnModelProvider" -- packages`、`git grep -n "NOT_IMPLEMENTED" -- packages`；
> 决定与后果见 [ADR-0020](../adr/0020-provider-three-interfaces-and-mcp-deps.md)。**下面几条基线实测保留不动。**

- `packages/brain-adapter/src/types.ts` 的 `BrainAdapter`：`provider` / `describe` / `handleUserTurn` + `evaluateProactiveCandidate` / `interpretFeedback` / `extractMemories` / `reflect`（共七个成员）；
- 三个实现：`MimoBrainAdapter` / `DshBrainAdapter` / `FakeBrainAdapter`（`implements BrainAdapter` 三处）；
- 四个能力方法在三个实现里**都抛 `NOT_IMPLEMENTED`**（各自一个 `notImplemented(capability, milestone)` 助手）；
- **生产调用方为零**：`evaluateProactiveCandidate` 的命中只有「三处 `notImplemented` + 接口声明」；`interpretFeedback` 的**生产调用点是规则实现**（`packages/conversation/src/feedback-interpreter.ts` 的 `interpretFeedback` / `interpretFeedbackInput`），与 adapter 无关——**引用同名函数时要分清**，别把规则层算成 adapter 的调用方；
- 图片能力今天靠实现隐式决定：`DshBrainAdapter` 收到 `images` 直接抛 `BAD_REQUEST`，`MimoBrainAdapter` 会带图；
- `inferJson` 今天不存在：结构化输出走 `packages/model-adapters/src/mimo.ts` 的解析 + 重试（`ModelError('INVALID_RESPONSE', 'structured output was unusable after a retry', ...)`），没有以一个「结构化推理 provider」的接口暴露出——P2-F 要把这块显式化。

**已知会被波及的断言**：`tests/integration/brain-adapter.test.ts` 有一条「后来里程碑的能力要响亮失败」的用例（对 `interpretFeedback` / `evaluateProactiveCandidate` 断言 `NOT_IMPLEMENTED`）；拆接口时这条要么改写、要么按新接口重新表达——**必须由 P2-F 显式说明，不能悄悄删**。改动面还很大：`BrainAdapter` 这个名字在 `scripts` + `tests` 下共 **139 行、35 个文件**（`git grep -n` / `git grep -l`），拆分要保留兼容别名或一次性改完并同步这些测试。

```powershell
git grep -n -E -- 'TurnModelProvider|MultimodalTurnProvider|StructuredInferenceProvider' 767f505 -- '*.ts'
git grep -n -- 'implements BrainAdapter' 767f505 -- packages
git grep -n -- 'evaluateProactiveCandidate' 767f505 -- packages scripts
git grep -n -- 'NOT_IMPLEMENTED' 767f505 -- packages/brain-adapter/src
git grep -n -- 'BAD_REQUEST' 767f505 -- packages/brain-adapter/src/dsh.ts
git grep -n -i -E -- 'inferJson|inferStructured|structured output' 767f505 -- packages/model-adapters/src
git grep -n -- 'BrainAdapter' 767f505 -- scripts tests
```
实测：第一条**零命中**（退出码 1）；`implements BrainAdapter` 三处；四个能力方法在 `dsh.ts` / `fake.ts` / `mimo.ts` 各一处 `notImplemented('…')`（`types.ts` 一处声明）；`NOT_IMPLEMENTED` 在 brain-adapter 内 5 行（含 `errors.ts` 的错误码联合）；`BAD_REQUEST` 1 处（「the DSH harness path cannot send images yet」）；`inferJson` 零命中、只有一句 `structured output was unusable after a retry`；`BrainAdapter` 在 `scripts` + `tests` 下 139 行、35 个文件。

**落点（P2-F = t5，types-eng，已开工）**：三个接口落 `packages/brain-adapter/src/types.ts`（或同包新拆一个 provider 类型文件）；四个能力按「谁能提供谁实现」重新分配（规则层今天的 `packages/conversation/src/feedback-interpreter.ts` 已经是事实上的 `interpretFeedback` 提供者）；`supportsImages: true` 变成显式能力标志；同时补 §2 那条 manifest 声明。**硬约束**：铁律 9（DSH/Harness API 只在 `packages/brain-adapter` 内，给 `git grep` 判据）、不靠 `any`/`ts-ignore` 过类型门禁。

---

## 9. 落点汇总与跨任务约定

### 9.1 六个实现任务的落点

| 任务 | 主落点（基线 → P2） | 会碰到的既有测试（钉死点） | 与其他任务的接口 |
|---|---|---|---|
| P2-A（t2）插件内核 | 无 → 新包 packages/plugins（manifest / capabilities / manager）；不改 `ToolRegistry` 语义 | `tests/unit/core/tool-registry.test.ts`、`tests/unit/tools.test.ts`、`tests/console/live-entry-tool-chain.test.ts` | 向下游提供：manifest 校验、`permissions` 门、`CapabilityRegistry`、`Disposable` |
| P2-C（t3）MCP | 无 → 在 P2-A 注册面上加 MCP 适配器 + 本地桩服务器 | 新增；不得让入口在发现失败时崩 | 依赖 P2-A；命名空间 `mcp.<server>.<tool>` 不得与内置撞名 |
| P2-B（t4）工具审批 | `askTools` 判定 + 一句拒绝文案 → `PendingToolApproval` + 冻结参数 + 审计 | `tests/unit/core/tool-registry.test.ts`（`ask` 分支现有断言） | **扩展 `ToolExecutionContext`（sessionId/actorId）**；复用 P2-A 的 `permissions`；与 P2-E 串行分配迁移号 |
| P2-D（t6）News | `xixi_news_stub` + 单方法 provider → `news.search/latest/for_interests` + 真实来源 + `news` TopicSource | §6 的六文件硬清单 | 依赖 P2-A（`topic_source` 能力）与 P2-B（写类工具若要审批） |
| P2-E（t8）Reminder | 内存 sink → 表 + 五态 + 绝对时刻/时区 + 到点事件 | `tests/unit/tools.test.ts`、`tests/console/*`、`tests/perception/world-state-projection.test.ts`（迁移清单） | 依赖 P2-B 的 `ask` 路径与 `source_event_id` 上下文；与 P2-B 串行分配迁移号 |
| P2-F（t5）Provider 收缩 | 胖 `BrainAdapter` → 三接口 + 移走四能力 + 补 manifest | `tests/integration/brain-adapter.test.ts`、35 个引用文件 | 为 P2-B/P2-D/P2-E 提供更小的 provider 面（拆完它们不再被迫实现无关方法） |

### 9.2 跨任务约定（每条都由上面的实测支撑）

1. **不推翻 `ToolRegistry`**：`register/unregister/permission/round cap/timeout` 四件都有既有测试钉住（§1 的命中清单），P2 只加层；新工具一律走 `createToolRegistry` / `executeTool`，不得自建执行路径。
2. **新包的 manifest 要写全依赖**：`packages/plugins` 照 `packages/brain-adapter/package.json` 的反例（§2）。
3. **新增事件类型 = 三处同改**（§7）：`event_type` 枚举、payload schema、`packages/contracts/src/events.ts` 的 `define`。
4. **新增迁移 = 纯新增 + 串行编号**：旧迁移文件一字不改（铁律 10）；`tests/perception/world-state-projection.test.ts` 与 `tests/unit/domain.test.ts` 会因清单变化而敏感，派单时进 inScope。
5. **`ToolExecutionContext` 的扩展是 P2-B 与 P2-E 的共同前置**（§5）：谁先做谁定义，另一个复用，不要各扩一套。
6. **接线声明要用调用图核对**（`AGENTS.md` §9.24）：任何「某能力已接入」的说法，都要给一条从入口出发的断言——本轮两次同类教训（`speakStream` 没有 live 接线、`playReplyAudio` 定义了从未被调用）都是字符串断言看不见的。
7. **`--print-wiring` 是四个 live 入口的接线证据**（离线、不调模型、不建库）：任何工具名/权限变化都要顺手跑 `node scripts/chat.ts --print-wiring`，并让 `tests/console/live-entry-tool-chain.test.ts` 的逐字段对照继续成立。
8. **迁移号 / 文件名不要重复**：t4 与 t8 都在同一个 `packages/domain/src/migrations/` 下加号，派单时要显式点名谁用 007、谁用 008。

---

## 10. 与 pack 08 Phase 2 两个验收场景的关系

| 场景 | 今天会发生什么（基线证据） | P2 完成后必须成立 |
|---|---|---|
| 「今天有什么新闻？」 | **会形成 tool call**（`xixi_news_stub` 是 read、在 conversation scope 内，会被广告给模型），但内容永远是 `available: false` + 「新闻源还没接上」（§6） | 真的形成 tool call 并拿到真实条目（离线桩进默认门禁；真实来源走手动命令留证据） |
| 「明天八点提醒我打电话。」 | fake 路径会调 `xixi_set_reminder_stub`，`when` 原样进内存数组，**进程结束即丢**（§7） | 写进 durable 表、**重启后仍在**、到点真的形成提醒事件（可被对话或主动行为消费） |

---

## 11. 未复核项与已知边界

1. 本文**不复核** pack `00_CODE_AUDIT.md` 里插件相关的条目（§3.6「ToolRegistry 不是 Plugin Runtime」、§3.7「`ask` 没有 resume」等）——它们归 t2–t8 各自的实现验收与 t9–t13 的评审，别把本文当它们的结论。
2. **MCP 的真实服务器与联网限制**：本机没有 MCP SDK（§4），真实 server 还要网络；t3 若装不上或必须联网，按契约先报 captain，不要偷偷降级成自造协议。
3. **「插件声明的权限/风险」与「它的真实行为」一致，无法运行时证明**（§3.2 ④）：运行时能证明的是「没在 manifest 里声明的权限不给」与「注册/执行必须过 ToolPermission」，剩下的靠代码审核与 ADR 记录，属于已知边界。
4. 本文实测于基线 `767f505`，写作期间 P2-A / P2-F 已开工（`git status --short` 可复核）。**P2 各任务落地后本文的「今天」列会过期——过期时不要改本文**（它是 P2 开工时的底稿），由集成收口任务把落地后的实况写进 `docs/v03/ACTUAL_RUNTIME_MAP.md` 与 `docs/progress-v03.md` 的 P2 段。
5. **本文尚未登记进 `docs/README.md` 的文档地图**（应在 ACTUAL_RUNTIME_MAP 那一行旁边加一行：`v03/P2_PLUGIN_GAP_MAP.md`）；这属于 P2 集成收口（t15 的契约里点名了 docs-README 同步），本文不越界改它。
