# S3第四步实施计划

最后更新：2026-10-05。延续自主软件完善授权，采用brainstorming/writing-plans/executing-plans/TDD。设计见 [有界旧原话](../design/history-recall.md)。

- [x] 实际引擎长会话回归先红，旧话题滑出8条短历史后相关查询无法看到原话。
- [x] domain限定同会话/主人/截止之后的旧用户查询；conversation纯函数词面筛选，排除当前/短历史并预算完整引用。
- [x] prompt动态数据块与整行预算淘汰；引擎仅私人context召回；配置关闭行为，保持稳定前缀和权限。
- [x] 长会话/重启/删除传播/公开隔离测试、离线demo、类型/全量/文档/只读评审，立即更新progress。

路径：packages/domain/src/store.ts、packages/conversation/src/history-recall.ts、engine.ts、prompt.ts、context-budget.ts、index.ts、tests/integration/history-recall.test.ts、tests/unit/history-recall.test.ts、scripts/demo-history-recall.ts、package.json、config/xixi.example.yaml、相关设计/ADR/交接/地图/测试/README/progress/AGENTS命令。无迁移或新依赖；不访问家庭库、密钥、API和硬件，不自动提交。
