# S3第一步实施计划

最后更新：2026-10-05。采用writing-plans与executing-plans，当前分支顺序实施，用户授权继续。设计见 [上下文预算](../design/context-budget.md)，不自动提交，不引入依赖/迁移。

## 文件职责

- conversation的context-budget.ts负责配置、UTF-8计量、前缀摘要、淘汰和错误；prompt.ts调用统一预算并把mood/audience移至动态块；index导出。
- engine.ts解析config.context.budget，按事件ID排除当前历史；domain/config.ts保留可选context配置。
- tests/unit/context-budget.test.ts与tests/integration/context-long-session.test.ts覆盖完整输入、硬政策、最近历史、重复原话、真实终端与重新检索；更新prompt心情断言但保留数值保护。
- scripts/demo-context.ts实际离线终端宿主/临时库长会话，package.json登记demo:context；同步ADR、设计、交接、命令和progress。

## 顺序

- [x] 行为测试先红：当前输入重复、场景前缀漂移、字节超量和固定块超量。
- [x] 配置接线与预算实现，保留当前话语、硬政策和角色，超量明确失败，不切半句。
- [x] 长会话/重开/纠正撤销/访客回归与可运行demo，记录实际数字。
- [x] 类型、全量测试、demo、文档门禁与独立只读评审；更新阶段边界，S3整体仍未完成。

最终门禁：类型exit 0，全量768项通过/0失败（56685.5352ms），demo exit 0，文档122份三类0，独立预算审计复审通过。来源与历史红灯见 [progress](../progress.md) 的S3第一步段；未提交，S3整体未完成。

评审发现预算超限不经审计finally，已增加ContextBudgetExceeded及拒绝原因健康记录，并在既有decision审计内组装prompt；7项专项与独立复审通过。长会话demo记忆替代/撤销通过MemoryStore程序接口；未验证原文历史删除传播，不能写成新的自然语言纠正能力。前缀按私人分区稳定，公开层关闭context仍有另一个前缀。
