# ADR-0027：宿主输入队列反压

日期：2026-10-05。状态：已采用；长期账本增长尚未解决。

## 决定

AmbientRuntime和TerminalCompanion共用有界FIFO实现，容量包括执行中任务，默认64、构造参数maxPendingEvents范围1至1024。超过容量时返回INPUT_BACKPRESSURE，未接纳的工作不冻结/复制、落claim或执行。队列空间检查后同步准备输入，保持调用方之后修改对象不能改变已排队事件的保证。事件schema在复制前校验；终端超过4096字符输入接纳前拒绝，不刷新在场或修改checkpoint。

成功/失败均释放槽位，错误不毒化后续任务；close拒绝新接纳并等待已有任务。生产者负责保存未接纳输入与处理反压，不静默丢弃、不自动重试。与模型循环、字节预算和持久去重各自独立。

## 代价与边界

FIFO可能延迟静默/中断控制，本步不增加抢占优先队列。该限制不等于整体RSS、API请求并发、金额预算或弱设备实测保证；pending队列仅内存，重启只恢复既有持久claim机制。未压缩checkpoint输入/输出账本，也未实现异步外部动作fencing。无新依赖/迁移，演示 `npm run demo:input-backpressure`；两处实际宿主行为由离线回归验证，数字见 [progress](../progress.md)，设计见 [反压](../design/input-backpressure.md)。
