# 西西 Xixi 当前实现复审 + 下一步计划
日期：2026-10-07  
审计对象：用户上传的 `xixi_ai_current(1).zip`

---

# 1. 总结

当前代码已经从“原型”进入了比较扎实的工程阶段。

最准确的状态不是“V0.3 做完了”，而是：

```text
P0 Runtime Consolidation     ✅ 基本完成
P1 Memory / Context          ✅ 核心完成，仍有两个需要修的接线/隐私问题
P2 Agent / Plugin 内核       ✅ 内核完成
P2 Production Wiring         ❌ 未完成
P3 Resident Voice            ❌ 未开始
P4 Perception / Attention    ⚠️ 只有 presence + look-once 基础
P5 Audience / Receptivity    ❌ 未真正完成
```

下一步的最高优先级：

> 不要继续新增大量框架。
>
> 先把 P2 已经实现的能力真正接进“活的西西”。

---

# 2. 当前实现质量评价

## 2.1 P0 — Runtime / Store / Replay / Typecheck

评价：**很好，8.5/10**

已经真实完成：

- `packages/runtime` 已抽出来；
- 多个入口不再反向依赖 `scripts/field-test.ts`；
- canonical household store 已建立；
- `XIXI_DATA_DIR` 存在；
- Replay 有真实 fixtures；
- `tsc --noEmit` 已成为门禁；
- SpeechPipeline B2 已修；
- 已知 runtime 小问题有回归测试。

这个阶段可以认为过关。

继续重构 P0 的收益已经很低。

---

# 3. P1 — Memory / Relationship / Context

评价：**整体很好，约 8/10**

已完成：

```text
ContextBuilder
MemoryRetriever
Memory scoring
Memory correction
Semantic memory status:
active / superseded / revoked / expired
RelationshipContext
OpenThread context
afterTurn 三入口共用
cross-restart tests
```

这是真正的功能，不是只有文件。

## 3.1 当前仍有两个重要问题

### Issue A — ContextBuilder 已经算出 worldLines，但 ConversationEngine 没把它传给 Prompt

`ContextBuilder.render()` 返回：

```ts
worldLines
memoryLines
relationshipLines
openThreadLines
selfLines
```

但是：

```ts
ConversationEngine.#contextSections()
```

当前只返回：

```text
memories
relationship
openThreads
self
audience
```

**world 没有返回。**

而 `PromptAssembler` 仍使用旧的：

```ts
worldStateLite()
```

它只有：

```text
时间
时区
时段
星期
```

因此：

```text
world_state(presence.home)
```

虽然 ContextBuilder 已经读了，
但正常聊天 Prompt 实际看不到：

```text
“他这会儿在家”
```

## 修复

不要增加第二套 WorldModel。

把 ContextBuilder 的 `worldLines` 接进 PromptAssembler。

建议：

```ts
interface WorldContextSection {
  lines: readonly string[];
}
```

`#contextSections` 增加：

```ts
worldContext: { lines: rendered.worldLines }
```

Prompt：

```text
【当前情境】
- 原有时间
- conversation state
- ContextBuilder world lines 去重后加入
```

注意不要把“现在/星期”重复两次。

最好将：

```text
worldStateLite
```

逐步降级成 fallback：

```text
ContextBuilder disabled -> worldStateLite
ContextBuilder enabled  -> ContextBuilder world
```

增加测试：

```text
store.world_state(presence.home)=present
engine.buildPrompt()
expect prompt.user contains “在场”
```

这是下一批必须修。

---

### Issue B — Relationship notes 没有 Audience filter

`ContextBuilder.#relationship(at, audience)` 目前传了 `audience`，
但实际实现没有用 audience：

```ts
snapshot.notes.map(note => note.note)
```

全部注入 RelationshipContext。

MemoryRetriever 本身有 audience filter；
OpenThread 对 public audience 也有过滤。

但 Relationship 没有。

未来：

```text
father + guest
```

时，private relationship note 仍可能进入 Prompt。

这是一个明确的隐私边界缺口。

## 修复

RelationshipNote 增加/使用 visibility：

```text
private
family
public
```

或者当前没有 schema 时先保守：

```text
private audience:
  all relationship notes

family:
  only explicitly family-safe notes

public:
  zero relationship notes
```

关键：

```text
Audience filter
→ Relationship selection
→ Prompt
```

不能先注入再让 LLM 自己避免说。

---

# 4. P2 — Plugin / MCP / News / Reminder

评价拆成两部分：

```text
P2 内核质量：8/10
P2 实际产品可用度：4/10
```

原因不是代码差，而是**入口还没有接。**

已经完成的内核：

```text
PluginManager
CapabilityRegistry
Plugin manifest
9-step lifecycle
MCP adapter
ToolApprovalManager
frozen args approval
News plugin
RSS / JSON / web-search adapter
DurableReminderSink
ReminderScheduler
Provider seam cleanup
```

而且测试很多。

但：

```text
chat
serve-chat
field-test
voice-turn
```

仍然主要使用：

```ts
buildToolChain()
```

而不是：

```ts
buildPluginRuntime().start()
```

所以真实用户目前仍看不到 P2 的大部分收益。

---

# 5. 下一步正式定义为 P2.5 — Production Wiring

P2.5 是当前最重要的一轮。

## 目标

> 让“代码里已经存在”的 Agent 能力第一次成为真正的西西运行时。

---

# 6. P2.5-A — 新建 XixiResidentRuntime

不要在四个 scripts 里重复接线。

增加：

```text
packages/runtime/src/resident-runtime.ts
```

建议：

```ts
interface XixiResidentRuntime {
  store: XixiStore;
  conversation: ConversationEngine;

  plugins: PluginRuntimeMount;
  approvals: ToolApprovalManager;
  reminders: ReminderScheduler;

  proactive?: ProactiveLoop;

  start(): Promise<void>;
  stop(): Promise<void>;
}
```

工厂：

```ts
createResidentRuntime({
  config,
  store,
  model,
  mode,
})
```

它统一建立：

```text
canonical store
TurnExtraction
ToolApprovalManager
DurableReminderSink
ReminderScheduler
PluginRuntime
News
MCP
ToolRegistry
Prompt verification
ConversationEngine
Proactive runtime
```

入口：

```text
chat.ts
serve-chat.ts
field-test.ts
resident voice
```

只做：

```text
runtime = await createResidentRuntime(...)
```

而不是每个入口拼一套。

---

# 7. P2.5-B — Live Plugin Runtime Wiring

四个入口全部改：

旧：

```ts
const registry = buildToolChain(...)
```

新：

```ts
const runtime = buildPluginRuntime(...)
await runtime.start()
```

但建议通过上面的 `createResidentRuntime` 间接做，不让 scripts 直接知道所有细节。

验收：

```text
npm run chat -- --print-wiring
```

至少看到：

```text
xixi_get_current_time
xixi_get_weather
xixi_set_reminder
news.search
news.latest
news.for_interests
```

如果配置了 MCP：

```text
mcp.<server>.<tool>
```

---

# 8. P2.5-C — Plugin Capability Bridge

当前 CapabilityRegistry 定义了：

```text
tool
topic_source
context_provider
sensor_source
action
```

但生产 Runtime 实际主要只消费了 `tool`。

这意味着：

```text
news TopicSource
```

即使注册成功，也没有真正进入 Proactive。

新增：

```text
PluginCapabilityBridge
```

职责：

## tool

已有：

```text
CapabilityRegistry -> ToolRegistry
```

## topic_source

新增：

```text
CapabilityRegistry.values("topic_source")
        ↓
PluginTopicBridge
        ↓
Proactive candidate source
```

把插件的：

```ts
{
  topic,
  reason,
  score,
  source
}
```

正规化成 Xixi：

```ts
TopicCandidate
```

然后经过：

```text
TopicHistory
ProactiveEngine
social budget
```

而不是插件自己决定说话。

## context_provider

接：

```text
ContextBuilder
```

只作为“素材”。

必须经过：

```text
PromptAuthority / render gate
```

## sensor_source

P4/P5 再消费。

## action

先不暴露成 LLM Tool。

保持系统动作和 Agent Tool 分开。

---

# 9. P2.5-D — PromptAuthority 真正接线

当前：

```text
verifyOnAssemble()
```

有实现和测试，
但 PromptAssembler 的真实路径没有调用。

不要让 `@xixi/conversation` import `@xixi/plugins`
（会造成不合理依赖/循环）。

推荐在 `packages/runtime`：

```ts
const baseAssembler = new PromptAssembler();
const verifiedAssembler = verifyOnAssemble(baseAssembler);
```

然后：

```ts
new ConversationEngine({
  assembler: verifiedAssembler,
})
```

如果类型不匹配，就抽：

```ts
PromptAssemblerPort
```

而不是让 conversation 依赖 plugins。

---

# 10. P2.5-E — Durable Reminder 真正上线

当前 reminder 内核已经不错。

但 live tool 仍然叫：

```text
xixi_set_reminder_stub
```

而默认 sink 仍可能是 memory sink。

现在就是最适合清理的时候。

## 改名

建议 canonical：

```text
xixi_set_reminder
```

为了 replay / 旧 fixture 兼容：

可以在测试 migration 层允许旧名，
但模型公开工具列表只出现新名。

## 修改返回文案

删除：

```text
“到点不会自动响，需要人看一眼”
```

真实 durable sink：

```text
“已经记下”
```

即可。

模型不需要看到内部 scheduler 细节。

---

# 11. P2.5-F — Reminder Scheduler 接 Proactive

ResidentRuntime：

```ts
const scheduler = new ReminderScheduler(...)
```

ProactiveLoop：

```ts
readDueReminders:
  () => scheduler.tick(now).becameCandidate

onReminderDelivered:
  (id, at) => scheduler.deliver(id, at)
```

注意：

```text
due
→ candidate
→ 西西真的说出口
→ delivered
```

不要在“计划要说”阶段就标 delivered。

用户：

> 好，知道了。

后续可：

```text
acknowledged
```

第一版 acknowledgment 可以只靠明确“知道了/行”等，
也可以先保留 delivered，不阻塞 P2.5。

---

# 12. P2.5-G — Tool Approval 真正上线

所有 live Runtime 使用同一个：

```text
ToolApprovalManager
```

并给 ToolRegistry：

```text
approvalGate
```

然后实现：

```text
PENDING
→ UI/voice asks
→ approve exact frozen args
→ execute
```

必须验证：

```text
模型第一次：
tool args = {what:"...", when:"..."}

审批后：
不能让模型重新生成第二组 args
```

已经有 frozen digest 内核，只需要入口闭环。

---

# 13. P2.5-H — Config 真正管理 Plugins / News / MCP

当前 `config/xixi.example.yaml` 的 news 部分明确写着：

> “今天是注释，不是可调键”。

P2.5 后不能继续这样。

扩展 `XixiConfig`：

```yaml
plugins:
  directories:
    - "./plugins"

  news:
    enabled: true
    sources:
      - type: rss
        url: ...
      - type: json_api
        url: ...

  mcp:
    servers:
      weather:
        transport: stdio
        command: ...
```

不要一次设计远程 plugin marketplace。

V0.3 先支持：

```text
pre-installed native plugins
configured MCP servers
enable / disable
```

---

# 14. P2.5-I — 修 PluginManager 两个已知问题

## start() 不幂等

当前 runtime.start() 重复调用有已登记问题。

修成二选一：

A. 幂等：

```text
if started -> return existing state
```

或者更推荐：

B. Loud failure：

```text
PLUGIN_ALREADY_STARTED
```

对 resident runtime 来说 B 更容易发现宿主 bug。

---

## health stale

`manager.instance().health`
不能在 deactivate 后还显示在线。

deactivate 后：

```text
health = {
  status: "down/degraded",
  detail: "inactive"
}
```

或：

```text
health = undefined
```

Debug UI 必须明确区分：

```text
active + health
inactive
```

---

# 15. P2.5-J — Context P1 两个修复

在 P2.5 一并做：

1. ContextBuilder worldLines 真正进 Prompt；
2. Relationship notes 按 Audience filter。

这两个不要拖到 P5。

---

# 16. P2.5-K — 真入口验收

不能只测 package。

至少四条：

## Chat

```text
“今天有什么新闻？”
```

真形成：

```text
news.*
```

tool call。

## Reminder

```text
“明天八点提醒我打电话。”
```

然后：

```text
process restart
→ reminder row still exists
→ simulated due time
→ ProactiveLoop creates candidate
→ assistant speaks
→ delivered
```

## Approval

将 reminder 配成 ask：

```text
user asks reminder
→ pending approval
→ no reminder row yet
→ user confirms
→ exact frozen tool call executes
→ reminder row exists
```

## Plugin shutdown

```text
runtime.stop()
→ plugin tool no longer appears
→ MCP connection closed
→ reminder scheduler stopped
```

---

# 17. P2.5 DoD

完成条件：

- [ ] 四个 live 入口走 ResidentRuntime；
- [ ] live tool list 里有 news；
- [ ] durable reminder 在真实入口运行；
- [ ] reminder scheduler 与 ProactiveLoop 接通；
- [ ] ToolApprovalManager 真实拦截 live write tool；
- [ ] `verifyOnAssemble` 真正守住生产 Prompt；
- [ ] plugin `topic_source` 真正进入 proactive；
- [ ] config 能配置 plugin/news/MCP；
- [ ] plugin start 重复调用处理明确；
- [ ] health 不再过期误导；
- [ ] ContextBuilder world 进入 Prompt；
- [ ] Relationship notes audience-safe；
- [ ] 全测试 / typecheck / replay 绿。

---

# 18. P3 — Resident Voice（P2.5 之后）

P3 目标：

> 西西从“一轮录音工具”变成常驻语音对象。

新增：

```text
ResidentAudioEdge
AddressDetector
ConversationFloorManager
WakeWordDetector
TurnDetectorAdapter
```

---

# 19. P3-A Resident AudioEdge

不要每 turn 启 Python。

一个常驻进程：

```text
Mic PCM
↓
AEC / Noise Reduction
↓
VAD
↓
speech events
```

维护：

```text
20~30 秒 Audio Ring Buffer
```

原始音频默认 RAM only。

---

# 20. P3-B AddressDetector

输入：

```text
wake word
conversation active
speaker candidate
semantic continuity
TV probability
audio direction
visual attention
```

输出：

```text
DIRECT
CONTINUATION
UNCERTAIN
BACKGROUND
```

第一版先用：

```text
wakeword
+
conversation active
+
semantic continuity
```

Speaker/visual 后加。

---

# 21. P3-C ConversationFloorManager

统一当前分散的：

```text
decideAssent
decideBargeIn
VAD endpoint
browser abort
```

状态：

```text
IDLE
USER_TURN
TRANSITION
XIXI_TURN
USER_BACKCHANNEL
INTERRUPTED
FALSE_INTERRUPTION
```

关键行为：

```text
“嗯嗯”
→ backchannel

“不是，我说的是明天”
→ real interruption
```

---

# 22. P3-D Turn Detector A/B

保留 adapter：

```text
LegacyTurnDetector
LiveKitMiniTurnDetector
```

不把项目绑死在 LiveKit。

用同一批音频 fixture A/B：

```text
mid-sentence pause
long pause but unfinished
backchannel
interrupt
TV
cough
```

---

# 23. P3 DoD

- [ ] AudioEdge resident；
- [ ] 不再每 turn spawn Python；
- [ ] wakeword 可启用；
- [ ] active conversation 不必重复 wakeword；
- [ ] TV fixture false-positive 显著低；
- [ ] backchannel 不误判成 interruption；
- [ ] real interruption 快速 stop；
- [ ] 语音状态进入 event/debug；
- [ ] LLM response latency 与 local ack 分开计。

---

# 24. P4 — Perception / Attention / Receptivity

这时再做摄像头。

先修一个现有语义问题：

当前 Python：

```ts
PresenceEventInput.actor = "father"
```

但 detector 只有：

```text
motion + face confirmation
```

它不能证明“这个人是 father”。

改：

```text
presence.home
actor = unknown
```

只有 Identity evidence 足够：

```text
person.father.present
```

才写 father。

---

# 25. P4 感知架构

```text
Camera / Mic / HA
     ↓
Sensor Adapter
     ↓
Semantic Event
     ↓
existing world_state
     ↓
Attention
     ↓
need_more_info?
   /       \
 no         yes
 |           ↓
 |      inspect_scene/audio
 |           ↓
 └────── SocialContext
             ↓
        ProactiveEngine
```

---

# 26. EvidenceStore

不要连续上传。

```text
video ring = 10~15 秒
audio ring = 20~30 秒
```

Agent 请求：

```text
inspect_scene()
inspect_audio_context()
```

才读取 evidence。

TTL 后删。

---

# 27. Receptivity

当前 proactive 里的 receptivity 很多仍是 synthetic score。

P4/P5 把它改成真实信号：

```text
TV on/off
current activity
last proactive ignored
guest present
conversation engagement
routine
current floor
```

保留现有 ProactiveEngine 的 scoring，
只替换输入来源。

---

# 28. P5 — Audience / Identity / Privacy

最后做：

```text
IdentityRegistry
AudienceContext
Face/Speaker candidate
Memory visibility
multi-room
```

注意：

```text
face/speaker verification
```

只能是身份概率，
不能作为高风险权限认证。

---

# 29. 当前优先级

按价值排序：

```text
1. P2.5 Production Wiring
2. Context world + Relationship privacy 修复
3. Durable reminder end-to-end
4. Plugin TopicSource -> Proactive
5. Resident Voice + Address/Floor
6. Sensor / Attention
7. Audience / Identity
8. Frigate / HA / multi-room
```

现在不要先做第 8 项。

---

# 30. 推荐下一轮名称

建议下一轮不要直接叫 P3。

叫：

```text
xixi-v03-p2.5-live-agent-wiring
```

范围只包含：

```text
ResidentRuntime
Live Plugin Wiring
News live
Reminder live
Approval live
Plugin capability bridge
Prompt authority
Context world/audience fixes
```

控制规模。

这一轮做完后，再开：

```text
xixi-v03-p3-resident-voice
```

最后：

```text
xixi-v03-p4-embodied-perception
```

这样风险最低。
