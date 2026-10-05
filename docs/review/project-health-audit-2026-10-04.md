# 西西项目健康审查

最后更新：2026-10-04

审查基线：`1668969`，开始时 `git status --short` 为空。范围：文档地图、交接、V0.3 阶段进度、运行时装配、工具执行与审批、HTTP 请求读取。只做审查与记录，不修改生产行为；没有调用付费 API，没有打开设备，没有读取密钥或家庭数据库。

## 1. 当前判断与门禁

领域持久化、规则与模型的分工、上下文包、回放和离线测试已有较好的基础。当前主要风险是：内核交付尚未形成日常入口闭环，工具边界的异常路径有测试盲区，交接摘要与新实现存在语义漂移。

本次实测：

| 命令 | 输出 |
|---|---|
| `npm run check:types` | exit 0 |
| `npm test` | tests 719，pass 719，fail 0，skipped 0，duration_ms 57457.8693，exit 0 |
| `npm run check:docs`（记录前） | 109 份 Markdown，失效链接 0，不存在文件引用 0，缺少新鲜度标记 0，exit 0 |

首次沙箱内测试因 `spawn EPERM` 未能执行，以上全量数字来自允许子进程启动后的复验。测试全绿没有覆盖下面三个离线探针复现的异常行为。

## 2. 已确认问题

### F1 / 高：日常提醒仍是内存桩，入口未接插件与审批

四个 live 入口调用 `buildToolChain`：`scripts/chat.ts:170`、`scripts/serve-chat.ts:105`、`scripts/field-test.ts:2027`、`scripts/voice-turn.ts:266`。没有注入 durable sink/scheduler 或审批宿主。`scripts/probe-tools.ts` 使用插件装配点，但这不是日常对话入口。

`packages/brain-adapter/src/tools.ts:186` 缺省使用内存提醒；工具描述第 190 行说「到点提醒」，实际结果第 209 行明确「到点不会自动响」。因此即使工具真实调用，重启也会丢失这份内存记录，且入口没有调度投递闭环。持久提醒内核存在不等于用户可用。

建议下一步只选一个入口，先验收「创建→落库→进程重启→到期→候选→实际投递→确认」与「审批→冻结调用→拒绝/过期」；通过后再推广到其余入口。接线完成前，桩工具的模型可见描述应准确表达限制。

### F2 / 高：工具参数没有完整的程序级 schema 校验

`packages/brain-adapter/src/tool-registry.ts` 的 `executeTool` 只检查参数名是否在 properties 中，未校验 required、type、enum、嵌套结构或数值范围。模型可见 schema 不能替代执行边界校验。

探针声明 `amount: { type: 'number' }` 且 required，传入 `{ amount: 'invalid' }`，实际结果：

```text
INVALID_SCHEMA {"name":"audit_probe","args":{"amount":"invalid"},"ok":true,"result":{"received":{"amount":"invalid"}},"error":null}
```

影响：插件/MCP 工具若依赖声明的 schema，错误模型参数会进入执行函数。建议在统一执行边界加入完整校验，先补缺字段、错类型、越界与嵌套结构的零调用回归。新增依赖时按 ADR-0006 说明理由。

### F3 / 高：超时仅结束等待，不能阻止延迟副作用

同文件 `withTimeout` 使用 `Promise.race`，超时后只清理计时器；没有取消底层工作或隔离执行。探针工具设 5ms 超时、40ms 后递增计数，返回失败后再等待 65ms，实测：

```text
TIMEOUT {"ok":false,"error":"audit_slow 超时（5ms）","effectsAfterTimeout":1}
```

影响：调用方收到失败后重试，第一次工具仍可能完成，形成重复动作。只读请求也会继续消耗资源。建议区分「停止等待」与「取消成功」，为支持取消的工具传递取消信号；写操作使用幂等键和执行账本，取消不确定时记录未知结果，不能直接判定未执行。

### F4 / 中：审批异常会卡在 approved，无法继续执行

`packages/runtime/src/tool-approval.ts:188` 先落 `approved`，第 195 行才检查 registry 是否存在。缺失时抛 `NO_REGISTRY`；补上 registry 后再 approve，第 179 行把非 pending 当作已决定，返回 refused。pending 查询也不再显示它。

离线临时库探针输出：

```text
APPROVAL_ERROR NO_REGISTRY
APPROVAL_RETRY {"stored":"approved","status":"refused","pending":0,"execution":null}
```

这是已复现的装配失败路径。同一代码在「approved 已提交、外部执行前」断电也存在恢复窗口风险（本次未做断电实验）。建议先检查执行链，再改变审批状态；为 approved 的恢复明确区分未开始、结果未知与已完成，配合幂等执行，不能盲目重试。

### F5 / 中：文档链接门禁通过，但状态摘要互相矛盾

`docs/handoff.md:329` 仍列四个内置工具含新闻桩，第 345–346 行仍写类型检查未接、回放目录为空；实际 package script、回放实现与工具集已更新。文档后面的新说明又写已实现。

`docs/progress-v03.md:38` 与第 403 行仍把模型提醒工具调用率 27% 当成缺口；当前 HEAD 的 handoff 第 14 条已经注明它是历史观测、同日复测不能复现。27% 不能用作当前可靠性结论，本次未重跑真实模型。

建议统一当前状态摘要，历史实测保留修订号与日期；为类型检查、回放、内置工具集合等可机器判断的状态增加语义一致性检查。现有 `check:docs` 只能证明链接、文件引用和新鲜度标记。

## 3. 优化建议与验证边界

1. 优先补工具校验、超时与审批异常路径，再做单入口持久提醒闭环。用产物的真实执行结果决定能否向用户承诺，提示词提醒只能辅助。
2. 生产语音仍每轮启动 Python；可借鉴验收 runner 的常驻 worker，但需先量化生产 VAD 冷启动占比，再做同批结果等价性和首音对照。不能把历史首音约 5.6 秒全归因于冷启动，也不能承诺优化后达到 1.5 秒。
3. `scripts/field-test.ts` 已超过六千行，HTTP、设备管理和内嵌页面共处。后续按边界渐进抽取，请求解析可先统一并增加体积上限；两个服务的 `readBody` 当前都无上限地收集 Buffer（serve-chat 第 599 行、field-test 第 3035 行）。本次未做大请求压力或跨源攻击验证。
4. 长期记忆管理 UI 与真人持续使用验收比新增抽象更有价值；相应功能缺口来自当前架构文档，不是本次真人实测结论。

本审查不是全库安全审计。未运行约 24 分钟的多日主动性评测，未复测在线供应商、语音听感、电视误触或摄像头真人检测；不改变已有 ADR 的设计判断。

## 4. 离线探针复跑

在仓库根目录 PowerShell 运行下列命令，只使用临时库与内存工具，结束后关闭并删除临时目录：

```powershell
@'
import { ToolRegistry, toolArgumentsDigest } from '@xixi/brain-adapter';
import { openXixiStore } from '@xixi/domain';
import { ToolApprovalManager } from '@xixi/runtime';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tool = {name:'audit_probe',description:'offline probe',parameters:{type:'object',properties:{amount:{type:'number'}},required:['amount'],additionalProperties:false},risk:'write',scopes:['conversation'],timeoutMs:5,async execute(args){return {received:args}}};
const registry = new ToolRegistry({tools:[tool]});
const context={scope:'conversation',timezone:'Asia/Shanghai',now:new Date()};
console.log('INVALID_SCHEMA',JSON.stringify((await registry.execute({name:tool.name,arguments:{amount:'invalid'}},context)).record));
let effects=0;
registry.register({...tool,name:'audit_slow',async execute(){await new Promise(r=>setTimeout(r,40));effects++;return {done:true}}});
const timeout = await registry.execute({name:'audit_slow',arguments:{amount:1}},context);
await new Promise(r=>setTimeout(r,65));
console.log('TIMEOUT',JSON.stringify({ok:timeout.record.ok,error:timeout.record.error,effectsAfterTimeout:effects}));
const dir=mkdtempSync(join(tmpdir(),'xixi-audit-'));
const store=openXixiStore({dataDir:dir});
try {
 const manager=new ToolApprovalManager({store});
 const pending=manager.request({toolName:'audit_probe',args:{amount:1},argsDigest:toolArgumentsDigest({amount:1}),context:{...context,sessionId:'audit_session',actorId:'father'},reason:'audit'});
 try {await manager.approve({approvalId:pending.approvalId,actorId:'father'})} catch(e){console.log('APPROVAL_ERROR',e.code)}
 manager.useRegistry(registry);
 const retry=await manager.approve({approvalId:pending.approvalId,actorId:'father'});
 console.log('APPROVAL_RETRY',JSON.stringify({stored:manager.get(pending.approvalId).status,status:retry.status,pending:manager.pending().length,execution:retry.execution}));
} finally {store.close();rmSync(dir,{recursive:true,force:true})}
'@ | node --input-type=module
```
