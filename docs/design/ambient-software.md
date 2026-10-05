# 单主人自主陪伴软件闭环

最后更新：2026-10-05

本阶段是一个里程碑：通过模拟端点驱动一个共享的西西，验收单主人、单房间的软件闭环。用户已授权「规划，然后行动」，本次在当前会话顺序执行；保留已有审查记录。不依赖物理设备、联网服务或新依赖。

## 设计与范围

- 中央运行时复用 ConversationEngine、ProactiveEngine、buildProactiveCandidates、ContextBuilder、TurnMemoryExtractor、DurableReminderSink、ReminderScheduler、ToolApprovalManager。直接在 ProactiveEngine 的 deliver 接缝记录 queued，避免 ProactiveLoop 将内容生成当成提醒已播放。模型由调用者注入；演示与默认测试只用 FakeBrainAdapter 和明确标注的脚本化读空气。
- 模拟事件 v1 带 eventId、deviceId、roomId、at，类型为 presence、speech、device、scene、tick、playback、approval、acknowledge。输入由宿主提供身份 father/guest/unknown，禁止把「有人」推断成「主人」。只允许已注册端点与单房间。
- 主人独处才可检索私人记忆和执行写工具。访客/未知身份的对话使用独立会话、public audience、guest 工具策略，且没有 afterTurn；多人在场时主人的上下文也使用 public audience。只有主人的话可进入主人的记忆学习。身份识别本身不是本阶段实现。
- 语音模拟输入是本地前端产生的转录与信号：direct、continuation、ambient、media、self。media/self 不进入模型；direct 可开启会话，continuation 只在同一身份的回应窗口内接受。不能把模拟信号当作真实唤醒词/AEC/声纹算法。
- 同一个 utteranceId 表示同一次话语，可来自多个麦克风；在程序侧去重，跨重启保持。不同 utteranceId 的相同文本不去重。设备断线、TTL 到期或重启后，实时在场证据为未知；访客存在时不主动表达主人的私事。
- 使用注入时钟推进 tick，不启动后台守护进程。静默、额度与隐私门禁复用现有程序规则；忙碌作为读空气上下文交给模型，模型可以选择暂缓，不增加确定性评分阈值。
- 模拟扬声器有可检查的输出记录与播放队列。输出先持久化为 queued，再明确开始 playing，完成变 completed；打断变 interrupted。重启时 queued/playing 变 interrupted，不自动重放，避免结果不明时重复动作。候选提醒只在模拟播放完成后标记 delivered；用户显式确认才 acknowledged。
- 待处理输入先持久化 claim；输入完成后标 done。若进程在两者之间终止，重启报告 interrupted_input，不盲目重跑模型/工具。软件阶段采取保守的至多一次尝试；不能宣称外部硬件端到端 exactly-once。已 approved 的工具结果不明时同样不得自动执行。
- checkpoint v1 存会话映射、输入去重、输出账本与模拟设备状态，事务写入并有修订号 CAS 防止两个宿主覆盖。原始会话仍在事件日志；checkpoint 不存模型私有推理、音视频或密钥。仅保存行为码、分数与必要的模拟输出文本。

运行时的 permission.check 在每次工具调用前复核 checkpoint 修订号，失去所有权立即拒绝；afterTurn 与模型返回后也检查。当前同步内置提醒的写入因此受保护；这不是通用分布式锁，未来引入跨进程异步外部动作需要独立 fencing/幂等协议。播放开始与完成均再次检查在场 TTL、同意、quiet 和主人独处，不能依赖 tick 恰好先执行。quiet 与撤销同意持久化；审批批准也受这些边界约束。

ProactiveEngine 的历史 delivered 字段表示主动候选已消费，不代表物理声音已播放；软件输出账本和 reminders 的 delivered 只在明确 playback complete 后更新。两者不是同一个指标。checkpoint 与提醒状态分别事务提交，意外终止窗口采用不重放策略，可能漏播，不能承诺 exactly-once。输入/输出账本当前不自动清理，长期运行的保留与压缩策略留给下一步。

## 工具前置修复

统一执行边界复用 contracts 的 fail-closed schema 子集校验，拒绝错类型、缺字段、越界、嵌套错误和无法强制执行的 schema；不宣称支持完整 JSON Schema。保持权限拒绝优先。

工具上下文增加 AbortSignal；超时发取消信号，写操作的超时结果必须明确 unknown，不宣称已取消或安全重试。无法配合取消的工具仍可能继续执行，因此调用方不得自动重试写操作。审批执行链缺失时保持 pending，不先落 approved。

## 验收

设备标识与房间可从 `config/ambient.example.json` 读取；演示可传 `npm run demo:ambient -- --profile config/ambient.example.json`。档案 v1 严格校验、最多64端点/64KiB；单房间至少camera/microphone/speaker各一个。camera/microphone adapter只能是filtered-events，speaker只能是simulated-playback；未知驱动与能力错配拒绝，不能声明USB驱动就算接入。多扬声器目前按档案顺序选首个在线端点，没有跨房间定位路由。

默认离线自动测试覆盖：主人进入后问候、忙碌时模型拒绝、静默/无人在场零开口、访客不污染记忆且读不到私人历史、媒体/自身声音零模型调用、跨麦克风去重与重启去重、打断清空队列、断线/TTL/重启在场未知、提醒跨进程恢复与完成/确认、审批拒绝/过期/确认、输出在途重启不重播、非法设备/事件/时钟倒退拒绝。

可运行 demo 使用系统临时库，从进入、聊天、访客、重复拾音、提醒、重启恢复到投递确认，输出中文逐步记录与实际统计；结束关闭库。无网络、硬件或家庭库副作用。

## 本次明确不做

不改四个既有 live 入口，不接新闻/外部 MCP，不做真实说话人识别、真实音频采集/AEC、视觉身份识别、跨房间跟随、多主人记忆归属或金额费用上限。不调整既有主动性 ADR，不把回放通过写成真人体验通过。
