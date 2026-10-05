# S2终端宿主实施计划

最后更新：2026-10-05。使用writing-plans、executing-plans顺序执行、TDD；沿用当前codex/ambient-software，用户授权，不自动提交。

设计：[终端宿主](../design/terminal-resident-chat.md)。无新依赖、测试临时库、模型API不进入默认测试、DSH API不越现有边界。

## 文件职责

- runtime新增 `terminal-companion.ts`：人工身份声明、统一事件/命令、输出交付与审批列表；index导出。AmbientRuntime增加输出通知与工具数据源注入，不改变默认离线演示行为。
- scripts新增 `resident-chat.ts`：readline/定时tick/分段文字播放、CLI参数、结构化读空气与错误；chat直连/fake分支调用，DSH保留旧路径。
- tests新增 `tests/integration/terminal-companion.test.ts` 和 `resident-chat-cli.test.ts`，使用真实宿主/库与模型客户端替身，不镜像生产逻辑；保留旧测试。
- 设计/整体证据地图/交接/架构/测试/进度同步。
- ConversationEngine新增程序replyGuard，在记录及输出前替换失败写工具回复；保留终端notice和分段格式。新增demo-resident及package命令，更新live-entry-tool-chain的公开/人工私人权限验收。

## 顺序

- [x] 先写宿主与命令行为测试并观察缺失失败，包含未知/访客权限、审批重启、quiet、交付失败和未回应。
- [x] 实现可注入模型/时钟/端点输出的TerminalCompanion，输出回调不得调用dispatch造成串行死锁；命令幂等与人工声明不自动持久化。
- [x] 写真实CLI和HTTP替身验收先红；接直连/fake、注入离线天气、断网/坏schema不假成功；DSH原实现保留。
- [x] 定向验证后顺序check:types、npm test、可运行fake终端demo、check:docs；只读评审，记录数字与未验证范围。

最终证据：类型exit 0，全量761项通过、0失败，demo exit 0；文档119份，三类问题均0。独立宿主10项通过；独立CLI受子进程沙箱限制。详细来源与首次回归修复见 [progress](../progress.md)。S2软件验收完成，下一阶段为S3；没有真实设备和供应商验证。
