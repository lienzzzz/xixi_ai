# 单主人自主陪伴软件闭环实施计划

最后更新：2026-10-05

执行方式：使用 writing-plans 制定计划、executing-plans 在本会话顺序实施、TDD 验证。用户已经明确授权规划后行动，不再次请求相同许可。设计见 [软件闭环](../design/ambient-software.md)。

目标：新增可恢复、可回放的模拟端点入口，完成同一个西西的单主人自主陪伴闭环。

架构：领域层维护 v1 checkpoint 与事务/CAS，运行时串行协调既有引擎，CLI 只驱动模拟事件；不重写大脑、记忆或主动性策略。

技术：Node 24 原生 TypeScript、node:sqlite、现有 schema 校验与离线模型；无新增依赖。

全局约束：中文文档/用户文案、英文代码注释；迁移只新增；不读取密钥或真实家庭数据；离线默认测试，先类型检查；不声明物理设备已验收。

重点检查：访客与未知身份的历史/记忆隔离；身份变化后不能沿用回应窗口；重启的输入/播放结果未知不能重发；两个宿主覆盖与非法设备输入；真实工具失败不能被回复伪装成已完成。

## 任务 1：工具与审批边界

文件：brain-adapter 的 tools/tool-registry、runtime 的 tool-approval；tests/unit/core 的 tool-boundaries 与 tool-approval。

- [x] 写 required/type/enum/嵌套/范围零调用、取消信号、写超时 unknown、缺 registry 审批保持 pending 的回归；运行观察旧实现失败。
- [x] 复用 assertEnforceable/validateSchema；增加可选 signal；超时取消并表达结果未知；先检查 registry 再落批准状态。
- [x] 定向测试与类型检查；把实测写进 progress。

## 任务 2：持久化 checkpoint

文件：domain 的迁移 009、store/index；tests/unit/ambient-checkpoint.test.ts；两处已发布迁移列表测试与提醒迁移最新断言。

- [x] 写文件库恢复、schema 版本、CAS 冲突不覆盖/审计不落、迁移不可篡改的测试并观察失败。
- [x] 提供 readRuntimeCheckpoint(key)、writeRuntimeCheckpoint(key,value,expectedRevision,reasonCode)；同事务写 checkpoint 与 system.health 审计。
- [x] 更新所有迁移钉死点，定向验收后写 progress。

## 任务 3：模拟房间运行时

文件：runtime 的 ambient-runtime/ambient-types、index；tests/integration/ambient-runtime.test.ts。

- [x] 写设计中的行为场景，使用真实库、真实工具链/引擎与注入模型；观察缺失行为失败。
- [x] 提供 AmbientRuntime.open、dispatch、snapshot、close；宿主注入 store/config/clock/modelFactory/decide，串行处理带版本事件。
- [x] 为模拟设备注册、实时证据 TTL、输入 claim、身份会话、工具审批、提醒调度与输出账本装配现有实现。
- [x] 用文件库与新进程复核恢复、默认测试核对访客隔离；记录结果与剩余边界。

## 任务 4：离线演示与收口

文件：scripts/demo-ambient.ts、package.json、tests/integration/ambient-demo.test.ts、设计/架构/测试/交接/文档地图/progress。

- [x] 写真实 CLI 子进程演示回归，先失败再实现；新增 npm run demo:ambient。
- [x] 演示主人进入、忙碌暂缓、访客隔离、多麦克风去重、打断、提醒重启恢复与确认；任何验收不成立非零退出。
- [x] 顺序运行 check:types、npm test、check:docs 与 demo；阅读输出，评审最终 diff；报告真实数字与未验证项。

本次不自动提交，不更改已有用户文档修改归属。任务进度以 progress 中实测与本计划勾选为准。
