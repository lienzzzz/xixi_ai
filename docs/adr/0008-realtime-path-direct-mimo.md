# ADR-0008：实时对话直连 MiMo，DSH 留在 Harness 与元智能体角色

- 状态：已接受（2026-09-30）
- 相关：[ADR-0001](0001-dsh-as-replaceable-harness.md)、[ADR-0002](0002-mimo-through-dsh-pi-ai.md)、[ADR-0007](0007-voice-stack-pipecat.md)、[docs/progress.md](../progress.md)

## Decision

1. **实时对话（Level 2）走 `MimoBrainAdapter`**：直连 `https://api.xiaomimimo.com/v1/chat/completions`，
   自己组装 system/history/user 消息，默认关闭深度思考，流式返回。
2. **DSH 保留为**：M0 已验收的 Harness 路径（`DshBrainAdapter`，用 `--session-id` 续会话）、
   以及未来需要会话/工具/子代理机制的**元智能体**（Observer、MemoryExtractor、Reflection 等结构化调用）。
3. 两者都实现同一个 `BrainAdapter` 接口，**选谁由证据决定，不改上层任何代码**。

## Context

- 实测：一轮 `dsh` 调用 **4~7 秒**（每轮启动一个 profile：CLI 引导 + 插件树 + 模型往返），
  而直连一次流式对话的首字 **0.3~1.2 秒**、总时长 P50 1.6~3.2 秒。
  方案 §33 要求「用户语音结束到开始回应 P50 < 2.5s」，§46.4 要求逐段延迟预算——
  按轮启动 Harness 无法满足，这是决策的直接原因。
- 直连后提示词完全由我们掌握：DSH 的系统提示词里带着「You are a coding agent」与整套编码工具 SDK
  （实测输入 token 3515）。改成西西身份 + 只读工具后，同样一轮只有 **307** 个输入 token。
  这不是省钱的细节，而是**人设正确性**：陪伴角色不能被 Harness 的框架话术带跑。
- 代价：直连路径要自己负责会话历史、工具循环与结构化输出的健壮性。
  历史本来就在 `XixiStore`（事件日志是唯一事实来源），工具循环已在适配器内实现（≤2 轮，只读工具），
  结构化输出有 `chatJson` 的本地校验 + 回退（见 progress §2.11）。
- DSH 依旧是 M0 验收过的、可续会话的 Harness，且方案 §3.2 要求它可替换、不绑死；
  保留它同时使用它，比「二选一」更符合方案原意。

## Alternatives

- **只用 DSH**：实时延迟无法达标；且每轮都要与 Harness 的 agent 框架共存，人设与提示词成本高。
- **只用直连、删掉 DSH 路径**：会丢掉已验证的持久会话与工具机制，也丢掉未来元智能体的现成底座；
  违反 §3.2「Harness 必须可替换」的隔离目标。
- **自研完整 agent 运行时**：重复造轮子，且与方案的技术路线相悖。

## Consequences

- `BrainAdapter` 的隔离从「设计意图」变成「实际被两套实现检验过的接口」——这是对 ADR-0001 的正向验证。
- 实时路径必须自己维护：会话历史截断、工具轮数上限、结构化输出校验、失败降级（§21）。
  这些都有测试（63 项离线用例）与金丝雀（`verify:structured-output`）。
- 元智能体（M3/M4/M5）默认继续走结构化输出通道；若其延迟与 DSH 的会话能力更匹配，可直接用 DSH 实现，
  上层无感知。
- 语音侧（ADR-0007）与大脑侧通过本地 HTTP 或进程内调用衔接；M1 目前是 Node 驱动 Python VAD 的一次性进程，
  真实常驻服务留给 M2。
