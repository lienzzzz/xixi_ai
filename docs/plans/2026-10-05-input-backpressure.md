# S4第一步实施计划

最后更新：2026-10-05。采用brainstorming/writing-plans/executing-plans/TDD，继续自主授权，顺序推进。设计见 [输入反压](../design/input-backpressure.md)。

- [x] 队列和两处真实宿主行为探针先红，满队列零执行/零claim，失败释放，FIFO和关闭等待。
- [x] runtime新增bounded-queue.ts并接AmbientRuntime、TerminalCompanion构造参数；入队前数据上限校验，维持现有claim/身份/权限。
- [x] 离线demo、类型/全量/文档和只读评审；立即记录实际结果，再推进账本增长等后续缺口。

路径：packages/runtime/src/bounded-queue.ts、ambient-runtime.ts、terminal-companion.ts、tests/unit/bounded-queue.test.ts、tests/integration/input-backpressure.test.ts、scripts/demo-input-backpressure.ts、package.json及设计/ADR/地图/交接/README/testing/progress/AGENTS命令。无新依赖/迁移、密钥、API或硬件访问，不自动提交。
