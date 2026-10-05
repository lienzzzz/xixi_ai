# S3第二步实施计划

最后更新：2026-10-05。采用writing-plans/executing-plans/TDD，继续当前工作树，不自动提交。设计见 [工具循环预算](../design/agent-round-budget.md)。

- [x] 新增tests/unit/core/round-budget.test.ts，先红验证预算在调用/外部动作前生效、巨大结果不重试、稳定工具schema。
- [x] brain-adapter新增round-budget.ts；agent-loop每轮/工具批次检查；ToolRegistry确定性模型工具定义。mimo/fake和UserTurnInput接maxRoundBytes。
- [x] model-adapters/mimo.ts报告usage实际返回标志；BrainTurnResult/ConversationTurn传递聚合计数；新增HTTP/SSE离线回归先红。
- [x] conversation预算配置接max_round_bytes，真实宿主错误审计；scripts/demo-round-budget.ts、package命令、类型/全量/demo/文档与只读评审。
- [x] 本步通过后继续S3下一块，阶段收口记progress，持续目标不以局部完成而结束。

文件同步：docs/progress.md、文档地图/交接/架构/brain-and-models/conversation/testing/整体路线/README、config/xixi.example.yaml、AGENTS命令段与ADR。无依赖/迁移/密钥读取/API调用。
