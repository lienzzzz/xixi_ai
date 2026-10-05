# S3第三步实施计划

最后更新：2026-10-05。采用brainstorming/writing-plans/executing-plans/TDD；延续用户自主软件完善授权。设计见 [历史失效](../design/history-invalidation.md)。

- [x] 先写文件库/真实引擎回归，证明旧复述在撤销、编辑、删除后仍入上下文的红灯。
- [x] 串行新增010_context_history_cutoffs.sql，同步两处已发布迁移清单测试；domain新增只读上下文历史入口。
- [x] 记忆变更与会话截止在同一事务，缺失来源不影响其他会话；引擎切到过滤入口，审计接口保持原样。
- [x] 增加可运行离线demo、类型/全量/文档和只读评审，阶段结果即刻写progress，继续S3剩余软件工作。

允许改动：packages/domain/src/store.ts、packages/domain/src/migrations/010_context_history_cutoffs.sql、packages/conversation/src/engine.ts、tests/unit/domain.test.ts、tests/perception/world-state-projection.test.ts、tests/integration/history-invalidation.test.ts、scripts/demo-history-invalidation.ts、package.json，以及文档地图/交接/设计/ADR/测试/progress/命令段。无新依赖，不改旧迁移，不碰密钥、家庭库、真实API或硬件，不自动提交。
