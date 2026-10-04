# ADR-0020：Provider 三接口拆分（与 MCP 的依赖理由）

- 状态：已采纳（2026-10-04，V0.3 P2-F t5/t17；P2 收口 t15 落笔）
- 相关：铁律 9（DSH/Harness API 不得出现在 `packages/brain-adapter` 之外）、铁律 12（新增依赖要写理由）、
  [ADR-0017](0017-plugin-boundary-and-four-prohibitions.md)、
  pack `E:\xixi_v03_actual_code_pack` 的 `03_AGENT_PLUGIN.md` §4 与 §8、
  `packages/brain-adapter/src/types.ts`、`packages/plugins/mcp/index.ts`、`packages/brain-adapter/package.json`

## 背景

pack §8 点名了一件结构问题：`BrainAdapter` 曾经是**七个成员**的接口，其中四个能力
（`evaluateProactiveCandidate` / `interpretFeedback` / `extractMemories` / `reflect`）**
不是每个 Harness 都必须拥有的能力**——三套实现各自 `NOT_IMPLEMENTED` 地挂着，生产调用方为零。
「接口里声明了但谁都不实现」有个坏处：下一个接手的人会以为这是要补的洞，而实际上真实归属在别处。

同一阶段还引入了 MCP 适配器（pack §4），它是这个仓库第一个**新增外部 SDK 依赖**的动作，
按铁律 12 必须写清理由，而且理由要能被核对（不是「看起来更好用」）。

## 决定

### 1. 三个接口，各有明确的「谁必须实现」

```ts
interface TurnModelProvider { provider; describe(); handleUserTurn(...) }        // 必须
interface MultimodalTurnProvider extends TurnModelProvider { supportsImages: true }  // 真能收图才声明
interface StructuredInferenceProvider { inferJson(...) }                          // 结构化推理
```

- `MimoBrainAdapter` 实现后两个（`inferJson` 是**真实现**：经 `MimoClient.chatJson` 的解析与重试，
  `validate` 仍由调用方传、失败分类仍由 `toBrainError` 归一）；
- `DshBrainAdapter` 与 `FakeBrainAdapter` **只实现 `TurnModelProvider`**——它们不声称自己能收图、也不声称能做结构化推理；
- `supportsImages` 是字面量 `true` 而不是 `boolean`：它存在的意义是让运行期检查
  （`provider.supportsImages === true`）**可以信**；不能发图的适配器干脆没有这个属性。

### 2. 四个能力从接口与实现里**删除**，类型留下并注明真实归属

四个方法从 `types.ts` 的三个实现类里一并删掉（连三处 `notImplemented` 助手一起删），`BrainAdapter` 不再导出。
四组**类型**保留为 retired capability 的数据契约，并注明它们今天归谁：

```text
evaluateProactiveCandidate → ProactiveEngine / evaluateProactiveGates（@xixi/conversation，确定性那一半）
interpretFeedback          → 确定性反馈解释（@xixi/conversation）
extractMemories            → TurnMemoryExtractor（@xixi/conversation）
reflect                    → TopicEngine（@xixi/conversation）
```

`tests/integration/brain-adapter.test.ts` 里那条「后来里程碑的能力要响亮失败」的用例按此**显式改写**为
「旧能力已退役且旧接口不复活」，而不是静默删掉。

### 3. 两条新接缝**在生产侧没有消费者**（如实登记，不许写成「已接线」）

- `supportsImages`：全仓只有接口声明、`mimo.ts` 的声明与用例断言，**没有读取方**
  （核对：`git grep -n "supportsImages" -- packages scripts apps`）；
- `inferJson`：只有接口与 `mimo.ts` 的实现，**没有生产调用方**——`scripts/eval-conversation.ts` 的判官仍直连
  `chatJson`（核对：`git grep -n "inferJson" -- packages scripts apps`）。

所以文档里的口径是**「接缝已定义，尚未有消费者」**，它们是下一阶段候选，不是已完成能力。

### 4. manifest 补上真实依赖（上一轮遗留）

`packages/brain-adapter/package.json` 的 `dependencies` 现为 `@xixi/contracts` / `@xixi/domain` /
`@xixi/model-adapters`——最后一条是本轮补的（源码里 6 处 import 却一直没声明）。
核对：`node -e "console.log(JSON.parse(require('fs').readFileSync('packages/brain-adapter/package.json','utf8')).dependencies)"`。

### 5. MCP 的依赖理由（铁律 12）

`packages/plugins/mcp/index.ts` 顶部的注释就是这条决定，**逐字引用如下**（它同时也解释了为什么 MCP 是
插件包的**子路径**而不是主入口的一部分：只有这一段需要 SDK，跑不到 MCP 的部署不为它买单）：

```text
@modelcontextprotocol/client@2.3.0 是直接依赖；@modelcontextprotocol/server@2.3.0 是 dev 依赖（只给测试桩）。
npm install 往 lockfile 里加了 13 条：@modelcontextprotocol/{client,core,server}、cross-spawn、eventsource、
eventsource-parser、isexe、jose、path-key、pkce-challenge、shebang-command、shebang-regex、which。
zod 没有新条目：树里本来就有 4.6.5（经 @deepseek-ai/dsh-tools），MCP 客户端的要求由同一份满足。
所以准确的说法是「zod 不是我们直接声明的依赖（我们用 SDK 的 fromJsonSchema，因此不必自己写 schema 校验），
但它会作为传递依赖被装上，连同 jose 与 cross-spawn 与 eventsource 等」——**不是**「没有 zod」。
```

**版本选择与「不手写协议」的理由，其唯一出处是 t3 的交付说明与提交 `c8396e0` 的提交信息**：
SDK **v2 取代 v1 单体包 `1.32.0`**；否掉手写协议的理由是「与真实 MCP 服务器互操作会变成与自造方言互操作」。
**一处如实更正**：t3 的回报与那条提交信息都写「依赖理由已写进 `packages/plugins/mcp/index.ts` 注释」，
但实测该注释只覆盖**依赖面**（client/server/dev、lock 的 13 条、zod 的口径），
**没有** v1 `1.32.0` 对比与手写协议那两句（核对：`git grep -n "1.32.0\|自造方言" -- packages docs` 零命中）。
本条 ADR 就是那两句的落脚点；以后引用它们请引本 ADR 或提交 `c8396e0`，不要再写「注释里有一段」。

## 后果

- **铁律 9 的判据可复跑**：`packages/brain-adapter` 里 `@deepseek-ai/dsh` 零命中，
  直接依赖只剩基线就有的三处接缝（`apps/brain-dsh` 的 profile 与 transport、`scripts/install-dsh-profile`）；
  `tests/unit/core/plugin-tools.test.ts` 的一处越界由 t17 改成本地谓词（不再 import DSH 的 JSON Schema 校验器）。
  **仍需用户裁定的一处**：`plugins/xixi-tools/index.js` 仍 import `@deepseek-ai/dsh-tools`——
  按铁律 9 的字面它在 brain-adapter 之外，但它的性质是 DSH 侧插件包本体（manifest 的 peerDependency 即 dsh-tools、
  靠 cordis patch 挂载、上游审计第 6 节已登记）。收编进 `packages/brain-adapter` 还是在铁律 9 里登记为例外，
  是需要用户裁定的口径问题，本轮不动。
- **退役不是删除契约信息**：四组类型留着并注明归属，所以「模型侧候选评估」这件事以后要找的是
  `ProactiveEngine`，不是适配器。
- 旧接口不复活有回归底线：`tests/unit/brain/provider-seams.test.ts`（7 项）钉住三接口的形状与
  「旧能力在运行期缺席」；`BrainAdapter` 这个名字不再从包里导出。
