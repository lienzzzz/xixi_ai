# S1 可配置设备档案实施计划

最后更新：2026-10-05。使用 writing-plans 与 TDD，在当前已验证分支顺序执行；用户已授权自主设计/执行，不重复请求许可，不自动提交。

目标：将房间和设备标识从演示代码移至严格的 v1 JSON 档案，确认相同宿主能接不同配置；只支持已实现的 filtered-events 输入与 simulated-playback 输出，不将声明某驱动写成驱动已实现。

设计依据：[整体设计](../design/companion-target-architecture.md) S1。使用现有 contracts 校验，无新依赖。其余 S2–S7 本次不实施。

文件与职责：`packages/runtime/src/endpoint-profile.ts` 解析和能力校验；runtime index 导出；`config/ambient.example.json` 默认模拟档案；`scripts/demo-ambient.ts` 加 --profile 并将相同档案传恢复子进程；`tests/unit/endpoint-profile.test.ts` 验证配置；`tests/integration/ambient-demo.test.ts` 验证自定义端点的真实CLI。设计/测试/交接/进度/文档地图同步。

- [x] 先写有效/变异档案测试，观察缺失解析器失败；缺版本/错类型/重复id/未知adapter/能力不匹配/跨房间/缺必需端点/过大配置均拒绝。
- [x] 实现 parseEndpointProfile 与 loadEndpointProfile；严格闭合字段，限文件大小与端点数量，返回深拷贝；不读取设备/网络/秘密。
- [x] 写自定义房间与端点CLI回归先红；演示用配置映射设备标识，恢复子进程沿用同一配置；至少camera/mic/speaker各一个，第二mic可选。
- [x] 顺序跑类型、全量离线、demo、文档检查，复核diff并记录证据。将配置范围与物理适配器未实现写清楚。
