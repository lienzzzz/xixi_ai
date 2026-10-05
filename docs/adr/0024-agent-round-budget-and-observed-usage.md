# ADR-0024：工具循环数据预算与实际用量

日期：2026-10-05。状态：已采用；真实供应商缓存收益尚未验证。

## 决定

文本预算之外，AgentLoop对 `JSON.stringify({messages, tools})` 的UTF-8数据设每轮硬上限，默认65536字节。配置为 `context.budget.max_round_bytes`，范围8192至1048576。检查点为模型调用前、工具调用批次执行前和每个工具结果加入后；超限抛出具名错误，不截断参数或结果，不重试已执行动作。大读取结果因此可以阻止同批次剩余写操作。

ToolRegistry按工具名排序并递归规范化参数对象键，数组顺序、权限和scope保持原语义。这为相同工具集提供稳定序列化，不能据此宣称供应商缓存命中。

客户端用显式存在标记区分供应商实际usage和兼容数字默认值。成功轮次聚合到schemaVersion=1的BrainTurnResult/ConversationTurn；基础用量标complete、partial或unavailable，缓存与推理缺失为null。partial数字只是已报告轮次之和，不能当成全部调用成本。当前失败轮次没有向宿主交付累计usage，DSH没有这条观测接线。

## 边界与验证

预算是适配器数据字节，不包含完整HTTP封装，不是token或金额上限。无新依赖或迁移；公开/私人权限仍由程序控制。自动回归覆盖零模型调用、零越界写操作、真实引擎错误审计、多轮SSE及缺失用量；实际终端离线demo为 `npm run demo:round-budget`。实跑数字与独立评审见 [progress](../progress.md)，设计见 [工具循环预算](../design/agent-round-budget.md)。
