# ADR-0021：单主人软件宿主的身份隔离与保守恢复

日期：2026-10-05。状态：已实施（软件模拟范围）。

## 背景

用户先验证单主人自主陪伴，家里偶尔有访客，目前没有多端点物理设备。既有能力需要在一个可重复入口中装配，并明确重启和结果未知的边界。

## 决定

1. 新增 AmbientRuntime，与既有 live 入口分开；身份、转录与设备信号由宿主注入，不冒充真实识别算法。主人私人、主人公开、访客、未知身份使用独立会话；主人独处才可读私人上下文或执行写工具。
2. 新增迁移 009 的 runtime_checkpoints，schema v1、修订号 CAS、同事务行为码审计。输入先 claim 再执行；恢复时 processing 和未完成输出标 interrupted，不自动重试。实时在场证据与回应窗口重启清空，quiet 与撤销同意保留。
3. 工具权限检查、afterTurn 与模型返回后复核当前修订号；当前同步内置提醒在调用前拦截被接管的宿主。未来异步外部动作须另设 fencing/幂等协议，不能将 CAS 当成通用分布式锁。
4. 使用既有候选构建器和 ProactiveEngine，模型读空气；忙碌只作为判断依据。输出先 queued，明确 playback complete 才把提醒标 delivered，显式确认才 acknowledged。播放边界再次检查隐私与 TTL。
5. 复用 contracts 的 fail-closed schema 子集；工具写超时为结果未知，并发取消信号不保证副作用已终止。缺执行 registry 的审批保持 pending。

## 代价与验证范围

保守恢复可能漏播；checkpoint 与提醒状态没有统一事务，不能承诺端到端 exactly-once。账本尚无压缩策略。正常跨进程恢复及人工构造 claim 中断已自动验证；实际进程突然被终止、真实身份算法、音频与人耳体验未验证。

测试与命令见 [测试说明](../testing.md)，实测见 [进度](../progress.md)，范围见 [设计](../design/ambient-software.md)。不增加依赖，不改变既有四个 live 入口接线状态。
