# 大脑与模型：`BrainAdapter`、MiMo 直连、DSH Harness

> 最后更新：2026-09-30
> 权威来源：`packages/brain-adapter/src/{types,mimo,dsh,tools,errors,scripted,fake}.ts`、`packages/model-adapters/src/{mimo,weather,errors}.ts`、`apps/brain-dsh/src/transport.ts`、`apps/brain-dsh/profile/cordis.patch.yml`、`plugins/xixi-tools/index.js`、`scripts/verify-structured-output.ts`、[recon/mimo-api-probe-2026-09-29.md](../recon/mimo-api-probe-2026-09-29.md)、ADR-0002/0005/0008、[progress.md](../progress.md) §2.3/§2.6/§2.10/§2.11
> 若与代码不一致，以代码为准，并请立即修正本文件

本文只写代码里真实存在的东西。方案（`xixi_ai_companion_project_plan.md`）里有、代码里没有的，一律写成「未实现（属 Mx）」。

## 1. 结构：一个接口，三套实现

| 层 | 位置 | 知道什么 |
|---|---|---|
| 对话 / 领域层 | `packages/conversation`、`packages/domain` | 只说 `BrainAdapter`、`UserTurnInput`、`BrainTurnResult`、`TurnAction` |
| 大脑适配层 | `packages/brain-adapter` | 直连 MiMo、DSH Harness、离线 Fake，都实现同一接口 |
| 协议 / 进程层 | `packages/model-adapters`（HTTPS）、`apps/brain-dsh`（子进程 + NDJSON）、`plugins/xixi-tools`（DSH 工具插件） | MiMo API、DSH CLI、JSON Schema |

铁律 9（Harness API 不得外泄）的实际落点：DSH 相关代码只在 `packages/brain-adapter/src/dsh.ts`、`apps/brain-dsh/src/transport.ts`、`apps/brain-dsh/profile/cordis.patch.yml`、`plugins/xixi-tools/`。

`ScriptedDshTransport`（`src/scripted.ts`）与 `FakeBrainAdapter`（`src/fake.ts`）是离线替身，让 `npm test` 完全不碰模型。

## 2. `BrainAdapter`（§25）全部方法：哪个真做了，哪个抛 `NOT_IMPLEMENTED`

接口定义：`packages/brain-adapter/src/types.ts`。三套实现（`MimoBrainAdapter`、`DshBrainAdapter`、`FakeBrainAdapter`）状态完全一致。

| 成员 | 状态 | 说明 |
|---|---|---|
| `readonly provider: string` | ✅ 实现 | `'mimo-direct'`（`src/mimo.ts`）；`DshBrainAdapter` 默认 `'dsh'`，可由构造参数覆盖（`src/dsh.ts`）；`FakeBrainAdapter` 默认 `'fake'`。它是 `conversation_sessions.brain_provider` 的键（ADR-0005）。 |
| `describe(): BrainDescription` | ✅ 实现 | 返回 `{provider, model, transport, mode}`。Mimo 的 `mode` 是 `hasKey ? 'live' : 'offline'`；DSH 的 `model` 取上一轮响应（`#lastModel`，初始 `'unknown'`）。 |
| `handleUserTurn(input)` | ✅ 真实现 | 见 §3、§4。 |
| `evaluateProactiveCandidate(input)` | ⛔ `NOT_IMPLEMENTED` — **milestone `M5`** | `notImplemented('evaluateProactiveCandidate', 'M5')`，三套实现各一份。 |
| `interpretFeedback(input)` | ⛔ `NOT_IMPLEMENTED` — **`M3`** | 同上。 |
| `extractMemories(input)` | ⛔ `NOT_IMPLEMENTED` — **`M4`** | 同上。 |
| `reflect(input)` | ⛔ `NOT_IMPLEMENTED` — **`M4/M5`** | 同上。 |

四个缺口的错误是 `BrainError('NOT_IMPLEMENTED')`，`milestone` 字段带里程碑名，`detail` 固定为
`declared in M0 to fix the seam; implemented in the named milestone`（`src/types.ts` 顶部注释称之为「诚实的缺口，不是静默 stub」）。

`TurnAction` 由 `packages/domain/src/store.ts` 定义为 `'SPEAK' | 'BACKCHANNEL' | 'WAIT' | 'SILENCE' | 'TOOL'`，
但**没有任何适配器/传输层会产出 `BACKCHANNEL` 或 `WAIT`**：直连路径只产出 `SPEAK`/`SILENCE`/`TOOL`（`src/mimo.ts` 的 `#interpret`），
DSH 路径同样（`apps/brain-dsh/src/transport.ts` 的 `action` 计算）。→ 未实现（方案 §55 的 BACKCHANNEL/WAIT 语义）。

## 3. 两种真实实现对比

| | `MimoBrainAdapter`（实时路径，ADR-0008） | `DshBrainAdapter`（Harness 路径，M0 验收） |
|---|---|---|
| 文件 | `packages/brain-adapter/src/mimo.ts` | `packages/brain-adapter/src/dsh.ts` + `apps/brain-dsh/src/transport.ts` |
| `provider` / `transport` | `'mimo-direct'` / `'https-api'` | `'dsh'` / `'dsh-cli'` |
| 出网方式 | `MimoClient` 直连 `https://api.xiaomimimo.com/v1/chat/completions`（`packages/model-adapters/src/mimo.ts`） | 每轮 `spawn(process.execPath, [bin.js, '--profile', 'xixi', '--json', ...])` |
| 会话续接 | `brainSessionId` 恒为 `null`（`#interpret`），**历史由领域层保存**并每轮以 `prompt.system` + `prompt.history` 重新喂入 | `--session-id <resumeBrainSessionId>`；`#store.brainSessionId(sessionId, provider)` 读、`attachBrainSession` 写 |
| 提示词形态 | 角色分离：`system` + `history`（user/assistant 原样）+ `user` | 压平成**单个 task 字符串**：`flattenPrompt(input.prompt)`（`src/types.ts`）；没有 `prompt` 时用 `CliDshTransport.composeTask` |
| 流式 | 真流式：`MimoClient.chatStream` 逐 delta `yield`，TTS 可先开口（§46.1） | 请求/响应：拿完整 `final.text` 后 `splitIntoChunks(text, 24)` 回放，**不是 token 级流式** |
| 工具循环 | 适配器内部实现（`maxToolRounds`，默认 2） | 由 DSH profile 的 `xixi-tools` 插件提供；transport 只从 `tool_call` 事件读出第一个 `toolName` |
| 思考（thinking） | 默认关：`thinking:false` → body `thinking:{type:'disabled'}` | profile patch：`reasoningEfforts: {off: 'none', high: 'high'}` + `compat.thinkingFormat: deepseek` |
| 默认参数 | `maxCompletionTokens=400`、`temperature=0.8`、`stream=true`、`timezone='Asia/Shanghai'` | `--json` NDJSON；`timeoutMs` 默认 180s（`serve-chat.ts` 传 240s） |
| 实测整轮耗时 | 首字 0.3~1.2s（正常），总时长 P50 1.6~3.2s（ADR-0008） | 4~7s，主因是每轮启动 profile（ADR-0008、progress §2.2） |

`DshBrainAdapter` 的会话映射读写方是**适配器**而不是 transport（ADR-0005）：transport 既不知道数据库，也不知道 `sess_…`。
resume 的两个硬约束（相同 cwd、相同 profile）在 `CliDshTransport` 里被固定为 `cwd`、`profile: 'xixi'`、`DSH_HOME` 三个构造参数，
`serve-chat.ts` 传入 `REPO_ROOT` / `DSH_PROFILE` / `DSH_HOME`。

## 4. 流式与工具循环（为什么「有文本」≠「已回答」）

实现在 `MimoBrainAdapter.#handleStreaming`（`src/mimo.ts`）：

1. 每轮先问「这一轮给不给工具」：`#toolDefinitions(round)` 在 `tools` 为空或 `round > maxToolRounds` 时返回 `undefined`，
   于是**最后一轮没有工具可选**，模型必须给答案。
2. 循环 `for (let round = 1; ; round += 1)`；收到完整一轮后，若 `tools === undefined || completed.toolCalls.length === 0` 就 break。
3. 关键事实（实测，progress §2.10）：**MiMo 会同时返回一句开场白和 `tool_calls`**
   （「明天成都的天气我帮你查一下。」+ `xixi_get_weather`）。所以代码里把「这一轮有文本」只当作候选开场白
   （`if (roundText.trim().length > 0) latestText = roundText`），**只有「没有 `tool_calls`」才算已回答**。
   若不这样判定，工具永远不会被执行——这是本轮修掉的一个真 bug。
4. 工具执行由**程序**负责：`#executeTool` 在本地注册表里查找并 `await tool.execute(args, {timezone, now})`，
   把结果作为 `role:'tool'` 消息回灌，再进入下一轮。
5. **未知工具名是拒绝而不是崩溃**：返回 `{error: '没有这个工具，请直接用已有信息回答'}`，
   记录 `ToolCallRecord{ok:false, error:'UNKNOWN_TOOL'}`，并回调 `onToolCall`。
6. 工具自身抛错同样被吞成工具结果 `{error: message}`（`ok:false`），模型必须继续回答。
   `arguments` 解析失败或空串时退化为 `{}`。

最终 `action` 的判定语义（`#interpret`，§55）：

| 条件 | `action` | `text` |
|---|---|---|
| 回复非静默 | `SPEAK` | 去除首尾空白后的文本 |
| 静默且**没有**用过工具 | `SILENCE` | `null` |
| 静默但用过工具 | `TOOL` | `null` |

即「用过工具之后又说话了」是 `SPEAK`（`toolName` 仍保留作为审计线索）；`TOOL` 只留给「一个字的回答都没给出来」的轮次。
静默判定是 `isSilenceReply()`：去掉 `。．.!！?？`、空白与引号后，等于 `[静默]` 或为空即静默（`src/mimo.ts` 的 `SILENCE_TOKEN`）。
`ConversationEngine` 还会在引擎层再兜底一次（切分后的 `[`+`静默`+`]` 也不会漏出去），见 [conversation.md](conversation.md)。

## 5. 工具层（§27）

接口在 `packages/brain-adapter/src/tools.ts`：

- `XixiTool`：`name` / `description` / `parameters`（JSON Schema，原样交给 provider）/ `execute(args, {timezone, now})`。
- `ToolCallRecord`：`{name, args, ok, result, error}`，通过 `onToolCall` 回调给上层写审计。
- 注册表只有一处出口：`defaultTools({defaultPlace, now})` = 时间 + 天气两个工具（注释：`New tools join here and nowhere else`）。

| 工具 | 权限 | 参数 | 行为 |
|---|---|---|---|
| `xixi_get_current_time` | L0（内部只读） | `{type:'object', properties:{}, additionalProperties:false}` | 返回 `iso` / `localDate` / `weekday`（`Asia/Shanghai`，代码内固定时区） |
| `xixi_get_weather` | L1（外部只读） | `place`(string)、`day`(enum `today`/`tomorrow`/`day_after_tomorrow`)、**`additionalProperties:false`** | `place` 省略时用 `defaultPlace`；`day` 默认 `tomorrow`；返回 `place`/`day`/`date`/`summary`/`temperatureMaxC`/`temperatureMinC`/`precipitationChance`/`advice`/`daysUntil`/`requestedAt`/`timezone` |

- 天气来源是 **Open-Meteo，无需密钥**（`packages/model-adapters/src/weather.ts`）：geocoding + forecast 两个端点，
  超时 15s，WMO 天气码译成中文口语（`describeWeatherCode`），**30 分钟缓存**（`report(place, cacheMs = 30 * 60_000)`，按 trim 后的地名键控）。
  未知地名是 `ModelError('BAD_REQUEST')`，不是崩溃。
- `place` 配置来自 `config.identity.place`（可选字段，`packages/domain/src/config.ts`）；
  `scripts/serve-chat.ts` 用它构造 `defaultTools({defaultPlace: config.identity.place ?? ''})`。
- **没有** shell / 文件系统 / 消息 / 高风险工具（§27 与铁律 7）；工具集合刻意最小且只读。
- DSH 一侧另有一份工具实现：`plugins/xixi-tools/index.js` 用 `defineTool` 只注册了 `xixi_get_current_time`
  （`parameters: {}`）。**DSH 路径目前没有天气工具**。
- `tool_choice` 在 `MimoClient.#body` 里被硬编码为 `'auto'`：实测其它取值（`required`/具名/`none`）全被静默忽略
  （recon §3），所以**不能把「必须调用工具」当硬门禁**，只能提示词驱动 + 自行校验 `tool_calls`。

## 6. 结构化输出：`chatJson` 策略与「为什么必须本地校验」

`MimoClient.chatJson`（`packages/model-adapters/src/mimo.ts`）：

1. 先走 `json_schema`（`chatJson` 内部**固定 `strict:false`**，与调用方无关），用 `tryParse` 解析；
2. `tryParse` 把「连续 200 个以上空白」直接判为缺陷（`出现大段空白填充，说明模型耗尽 token 后仍在补白`）；
3. 解析通过后调用**调用方提供的 `validate`**（例如 `scripts/verify-structured-output.ts` 与
   `scripts/eval-conversation.ts` 传的 `assertSchema`）；校验不过也算失败；
4. 失败则回退 `json_object`，温度压到 `min(temperature, 0.2)`，并**把必填键名与整份 schema 写进一条 system 消息**
   （实测只写 schema、不点名必填键时模型会自造键名）；
5. 两次都失败才抛 `ModelError('INVALID_RESPONSE', 'structured output was unusable after a retry')`，
   `detail` 里带上两次的失败原因。

**为什么必须本地校验**（两条实测依据，不是保守起见）：

- 供应商根本不保证：recon §4 记录 `json_schema`/`json_object` 都可用，但 `strict:true` **只是被接受，未证实被强制执行**。
- 这条通道本身会坏：progress §2.11 记录 `json_schema` **间歇性**返回「先输出键名、再补大量空白直到耗尽 token」的截断 JSON，
  `strict:true` 出现 2/3 失败、`strict:false` 也出现 1/3 失败 —— 所以这不是 `strict` 的问题，是通道的问题，
  两处注释（`#body` 的 `strict` 与 `chatJson` 的文档注释）都以「间歇性失败比稳定失败更糟」为由默认关掉 `strict`。
- 金丝雀：`scripts/verify-structured-output.ts` 跑 3 次 `chatJson` + 3 次原始 `json_schema`，把原始通道的缺陷作为长期监测项；
  progress §2.11 记录连续 3 次全部可用（其中 2 次走了回退）。
- 解析细节：`message.reasoning_content` 与 `message.content` 是两个字段，只读 `content`（recon §4）；
  思考开启时 reasoning token 计入 `completion_tokens`，小 `max_completion_tokens` 会得到 `content:""`（recon §7）。

## 7. 错误码与降级

`BrainError`（`packages/brain-adapter/src/errors.ts`）：

| code | 含义 / 触发点 |
|---|---|
| `NOT_IMPLEMENTED` | 四个未实现能力；带 `milestone` |
| `TRANSPORT_FAILED` | transport 未回答（`src/dsh.ts`）；找不到 `dsh`、`bin.js` 不存在、cwd 不存在（`apps/brain-dsh/src/transport.ts`）；`MimoBrainAdapter` 的兜底（`src/mimo.ts`） |
| `PROVIDER_FAILED` | harness 返回 `ok:false`（`src/dsh.ts`）；**除 `TIMEOUT` 外所有 `ModelError` 的映射结果**（`src/mimo.ts`） |
| `TIMEOUT` | `CliDshTransport` 超时并 kill 子进程；`ModelError('TIMEOUT')` 映射 |
| `INVALID_RESPONSE` | harness 回的 `requestId` 与请求不一致（`src/dsh.ts`） |
| `SESSION_MISMATCH` | **只在类型里声明，代码中没有任何一处抛出**（当前未使用） |

`ModelError`（`packages/model-adapters/src/errors.ts`，`classifyStatus`）：`MISSING_KEY`（无 key，`MimoClient.#headers`）、
`AUTH`(401/403)、`QUOTA`(402)、`RATE_LIMIT`(429)、`BAD_REQUEST`(400/404/422，含未知地名)、
`PROVIDER`(≥500，含天气服务拒绝)、`NETWORK`(fetch 失败)、`TIMEOUT`(abort)、
`INVALID_RESPONSE`(非 JSON / 无 choices / 流无 body / ASR 无转写 / TTS 无音频 / `chatJson` 两次皆败)。

**注意**：只有 `TIMEOUT` 在适配器边界被保留；`AUTH`/`RATE_LIMIT`/`QUOTA` 等在这里统一变成 `PROVIDER_FAILED`，
上层拿不到更细的分类。

§21 降级现状（progress §2.6）：用无效密钥跑 `verify:provider`，**3.9 秒**内失败、退出码 1、不挂起、无重试风暴，
并保留 provider 原始错误（`dsh: AUTH: 401: Invalid API Key`）→ `BrainError(PROVIDER_FAILED)`。
未实现：§21.1 的本地兜底话术、§21.2 本地 TTS 备选、§21.3 本地 ASR 兜底、§21.6 的
FatherModel/RelationshipModel/FutureHooks 恢复（这些领域对象尚不存在）。当前重启只恢复会话、轮次与人格基线。

## 8. 未实现清单（与本文相关）

- `BACKCHANNEL` / `WAIT` 两种 action 没有任何生产者。
- 四个 meta-agent 能力（§2 表）。
- DSH 路径缺天气工具；DSH 路径的提示词拼装是 `composeTask` 占位（§26 的正式拼装由 `packages/conversation` 的 `PromptAssembler` 负责，直连路径已用上）。
- 本地 ASR / TTS 兜底、模型私有推理之外的失败话术。
- `brain-adapter` 无 type check（无 `tsc --noEmit`），类型错误只在运行时暴露（progress §6）。

## 维护规则

| 改了哪个源文件 | 必须同步更新本文件的小节 |
|---|---|
| `packages/brain-adapter/src/types.ts` | §1、§2（方法清单与状态）、§3（对比表的结构字段） |
| `packages/brain-adapter/src/mimo.ts` | §3、§4（流式/工具循环/action 语义）、§7 |
| `packages/brain-adapter/src/dsh.ts`、`apps/brain-dsh/src/transport.ts` | §2、§3、§7（`TRANSPORT_FAILED`/`TIMEOUT`/`INVALID_RESPONSE` 触发点） |
| `packages/brain-adapter/src/tools.ts` 或新增工具 | §5（工具表、参数封闭、注册表） |
| `packages/model-adapters/src/mimo.ts`（含 `chatJson`/`strict`） | §6、§7、§3（默认参数） |
| `packages/model-adapters/src/weather.ts` | §5（数据源、缓存、返回字段） |
| `packages/model-adapters/src/errors.ts` | §7 |
| `packages/brain-adapter/src/errors.ts` | §7（码表，含未被使用的码） |
| `apps/brain-dsh/profile/cordis.patch.yml` | §3（thinking/工具路由）、§5（DSH 侧工具） |
| `plugins/xixi-tools/index.js` | §5（DSH 侧工具清单） |
| 里程碑推进（M3/M4/M5 落地） | §2（状态）、§8（未实现清单），并同步 [handoff.md](../handoff.md) 现状矩阵 |
