# ADR-0002：MiMo 经 DSH 的 pi-ai 路由配置接入

- 状态：已接受（2026-09-29）
- 相关：ADR-0001、[`apps/brain-dsh/profile/cordis.patch.yml`](../../apps/brain-dsh/profile/cordis.patch.yml)、
  [`docs/recon/dsh-integration-2026-09-29.md`](../recon/dsh-integration-2026-09-29.md)、
  [`docs/recon/mimo-api-probe-2026-09-29.md`](../recon/mimo-api-probe-2026-09-29.md)、`docs/progress.md` §2.3/§2.4
- 上游依据：《方案》§46.1（调用分层）、§3.4（模型路线）

## Context

M0 需要一个真实的对话模型，并且必须证明「文字 → DSH → 模型 → 结构化工具调用 → 回答」这条链路。
选定小米 MiMo（`mimo-v2.6-flash`，2026-09-29 用真实密钥实测可用）。需要决定的是：**怎么把它接进 Harness**。

已核对的既成事实：

- 全局安装的 DSH 0.1.7-rc.2，profile `web` 已挂载 `@deepseek-ai/dsh-llm-pi-ai`；
  该插件允许用 `api` / `baseURL` / `apiKeyEnv` / `models` **完全声明式**地定义 OpenAI 兼容路由
  （`docs/recon/dsh-integration-2026-09-29.md` §1）。`api` 只能是 `openai-completions` /
  `openai-responses` / `anthropic-messages` 三者之一。
- pi-ai 自带 `xiaomi` 提供方（baseURL `https://api.xiaomimimo.com/v1`），但其目录里只有
  `mimo-v2.5` 系列，**没有** `mimo-v2.6-flash`；不过 `models` 列表可以覆盖目录，所以两条路都能走通。
- MiMo 端点同时接受 `api-key:` 与 `Authorization: Bearer`（`docs/recon/mimo-api-probe-2026-09-29.md` §1），
  所以 pi-ai 的 `openai-completions`（Bearer）不需要 `headers:` 变通。
- `GET /v1/models` → 404；`GET /models` → 200（同一份探测报告 §2）。

## Decision

**MiMo route 是一份配置，不是一份代码。** 仓库持有的 patch 层是
[`apps/brain-dsh/profile/cordis.patch.yml`](../../apps/brain-dsh/profile/cordis.patch.yml)，
由 `scripts/install-dsh-profile.ts` 复制进 `.dsh/profiles/xixi/`：

| 项 | 值 |
|---|---|
| route id | `mimo` |
| 承载插件 | `@deepseek-ai/dsh-llm-pi-ai`（路由 id `llm-pi-ai`，patch 按 id 替换整行 config） |
| `api` | `openai-completions` |
| `baseURL` | `https://api.xiaomimimo.com/v1`（**API 根，不含 `/chat/completions`**；路径由 pi-ai 自己拼） |
| `apiKeyEnv` | `MIMO_API_KEY`（按请求经 harness 凭据 seam 解析，不是进程里直接读 `process.env`） |
| `models` | 显式声明 `mimo-v2.6-flash`（`contextWindow: 262144`、`maxTokens: 32768`、`input: [text]`） |
| 默认模型 | 另一行 `agent-default-model`：`provider: mimo` + `model: mimo-v2.6-flash` |

**`reasoningEfforts` 与路由级 `reasoning: off` 是必需的，不是优化项。**
手写声明的模型条目默认被视为「不具备推理能力」，pi-ai 于是不会走 `thinkingFormat: deepseek` 分支，
也就**不会**下发服务端能识别的 `thinking:{type:"disabled"}`；而 MiMo 服务端**默认开启思考**
（同一提示词实测 `reasoning_tokens` 14 / `completion_tokens` 23，`reasoning_content` 在场）。
M0 实测的修复前后：路由写了 `reasoning: off` 但模型条目没有 `reasoningEfforts` 时，
`dsh --json` 仍输出 `thinking` 事件（outputTokens 16）；补上

```yaml
reasoningEfforts: { off: 'none', high: 'high' }
compat: { thinkingFormat: deepseek, requiresReasoningContentOnAssistantMessages: true }
```

之后：**`thinking` 事件消失、outputTokens 16 → 2、整轮耗时 7.5s → 4.4s**（`docs/progress.md` §2.4）。
`off` 映射为服务端认识的 `reasoning_effort:"none"`（实测可把 `reasoning_tokens` 归零）；
`high` 保留给后台反思使用。只声明 `off` 会被 pi-ai 拒绝——它要求至少还有一个「off 之外」的档位。
`compat` 的两个标志照抄 pi-ai 目录里 xiaomi 条目的取值，保证多轮 assistant 消息回放时的形状正确。

**ASR / TTS 无论 M0 选择什么路由，都必须直连小米。** DSH 侧只有文本类模型路由：
`mimo-v2.5-asr` 要求 user 消息带 `input_audio` 内容、`mimo-v2.5-tts` 要求消息里出现 assistant 角色，
两者都**不能**作为 `openai-completions` 的 `input: [text]` 路由使用（探测报告 §2 的 400 响应；
`defaultInput` 只支持 `[text]` / `[text, image]`）。语音属 M1，届时 ASR/TTS 走独立的模型适配层。
按铁律 9，这类端点 URL 只能出现在 `packages/brain-adapter`（及其未来的同级适配包）里，
不得散落到其他包 —— 探测报告也明确记了「`/v1/models` 不存在，健康检查要打 `/models`」这一点值得在那里编码。

## Alternatives

| 方案 | 为什么没选 |
|---|---|
| 自写一个 DSH provider 插件封装 MiMo | pi-ai 已挂载且能声明式覆盖路由；自写插件会与 DSH 内部 API 绑定，RC 升级即碎（ADR-0001） |
| 走 pi-ai 自带 `xiaomi` 目录路由 | 目录里没有 `mimo-v2.6-flash`，仍要显式声明 `models`；且目录条目的 `defaultContextWindow` 等默认值与本项目实测值不一致，显式声明更可控 |
| 直接 `fetch` 调 MiMo，绕过 DSH | 会同时失去工具循环、会话持久化与重试，等于自研 Harness；违反 §3.2 与铁律 9 |
| 保留思考开启（默认） | 实时对话要低延迟（§46.1）；且小 `max_completion_tokens` 下思考会吃掉全部预算，实测 `finish_reason=length` 且 `content` 为空 |
| 只声明 `reasoningEfforts: { off: 'none' }` | pi-ai 拒绝；必须至少再声明一个档位 |
| 用 `enable_thinking:false` / `thinking_budget:0` 关思考 | MiMo 接受但**静默忽略**（探测报告 §6）——这正是本地校验优先于「相信参数被接受」的例证 |

## Consequences

- 换模型/换路由只改 YAML：不需要动 `packages/brain-adapter` 的任何一行代码。
- `MIMO_API_KEY` 只从环境变量或本机私有配置来（`scripts/lib/harness.ts` 的 `harnessEnv()` 合并
  `.env` 与进程环境）；密钥不写进仓库、文档或日志（`AGENTS.md` §5）。
- 凭据必须在**启动 DSH 宿主之前**就存在于环境快照里；启动之后再导出不会被看到
  （`docs/recon/dsh-integration-2026-09-29.md` §2）。M0 的 `CliDshTransport` 每轮显式传入 `env`，天然满足。
- **诚实记录**：关闭思考的收益是可测的（`reasoning_tokens` 0 vs >0、outputTokens 16→2），
  但端到端延迟并不稳定——同一配置实测区间重叠严重（1.0–10.0s，探测报告 §6 的 latency caveat）。
  因此「关闭思考」按确定性信号（token 归零、无 `reasoning_content`、预算不被吃光）验收，不按延迟验收。
- `tool_choice` 不可强制（`required` / 指定 function / `none` 都被静默忽略），
  所以「必须调用工具」不能当硬门禁，只能靠提示词驱动 + 自行校验 `tool_calls`（探测报告 §3 的影响 (c)）。
  M0 的验收脚本正是这样做的：断言 `toolName === 'xixi_get_current_time'`，不假设模型一定听话。
