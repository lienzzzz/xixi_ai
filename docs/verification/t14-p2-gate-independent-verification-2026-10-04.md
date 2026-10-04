# Phase 2 独立复验（t14）：pack 两个验收场景 + 全量门禁 + P2 段落笔

最后更新：2026-10-04

- **复验人**：verifier（独立于实现者与评审；本报告只写我自己跑出来的东西）
- **认领时基线**：`4eb42ec`（当时工作区里有 t6 尚未入库的 `packages/plugins/news/` 与 t24 在途的测试改动）
- **最终字节上的复验修订号**：**`024cd43`（工作区干净）**——复验期间 captain 把 t6（`3ada7cd`）、t24（`5336b13`）与两份文档提交入库；
  下面**门禁与两个场景的每一条**都是在这个干净修订号上重跑取得的，探针与日志在 `.scratch/t14/`（`.gitignore` 已忽略，按任务要求不进仓库）。
- **复验范围**：pack `E:\xixi_v03_actual_code_pack` 的 `08_PHASES_AND_ACCEPTANCE.md` §Phase 2 两个场景 + 四条 gate 口径（Node 24 / `check:types` / `npm test` / `check:docs`）
- **一句话结论**：**两个场景在「交付件 + 装配点」这一层都成立并留档**（真模型、真工具执行、真文件库、事件日志可查）；
  **但在四个 live 入口上都不成立**——新闻工具根本不在入口的工具链里，提醒走的是内存 sink（工具调了、库里没有行）。
  另外提醒这条还有一个**可靠性未达标**：22 次真模型尝试里只有 6 次真的调用了工具（27%），其余 16 次里 4 次回复明说「记下了」而库里没有行。
  三条结论都在下面给命令与输出；未达标的地方按未达标写。

## 0. 怎么复跑

探针是 `.scratch/t14/probe.mjs`（`*.mjs`，直接 `node` 跑；`.scratch/` 在 `.gitignore` 里，**按任务要求没有进仓库**）。
它做三件事，没有任何替身：装配 `buildPluginRuntime`（P2-A/P2-C/P2-D 的唯一装配点）、用**真 MiMo 模型**走 `ConversationEngine`、
把工具调用记进**真文件库**的事件日志。`remind` 与 `after` 是**两个进程**，所以「重启」是真的新进程。

```powershell
# ① 门禁（在 024cd43、工作区干净时跑的）
node --version
npm run check:types
npm test
npm run check:docs
# P2 变动面的细分口径（plugins 内核 + MCP + 提醒 + 审批 + news 工具循环）
node --test "tests/unit/plugins/**/*.test.ts" "tests/unit/reminder/*.test.ts" "tests/unit/core/tool-loop.test.ts" "tests/unit/core/tool-approval.test.ts" "tests/unit/core/tool-registry.test.ts" "tests/integration/reminder/*.test.ts"

# ② 场景一：真模型 + 真 RSS/HN 来源 + 真文件库（会联网、会花钱）
$env:NODE_USE_ENV_PROXY='1'; $env:HTTPS_PROXY='http://127.0.0.1:7890'; $env:HTTP_PROXY='http://127.0.0.1:7890'
node .scratch/t14/probe.mjs news "$env:TEMP\t14-final-news" --live

# ③ 场景二：进程 A 写 → 进程 B 重启后读 + 到点 tick（注入时钟，不等到明天）
$env:T14_NOW='2026-10-05T21:30:00+08:00'
node .scratch/t14/probe.mjs remind <dir>      # 真模型说「明天八点提醒我打电话。」
$env:T14_NOW='2026-10-06T08:00:30+08:00'
node .scratch/t14/probe.mjs after  <dir>      # 新进程读同一个文件库 → tick → 事件
node .scratch/t14/probe.mjs dump   <dir>      # 直读 SQLite（events / reminders / tool_approvals）

# ④ 入口层对照（shipped entry，不是替身）
node scripts/chat.ts --print-wiring
$env:XIXI_DATA_DIR="$env:TEMP\t14-entry"
'今天有什么新闻？'      | node scripts/chat.ts
'明天八点提醒我打电话。' | node scripts/chat.ts
```

探针里 `remind` 用的注入时钟是 `T14_NOW`（工具链的 `now` 与引擎的 `clock` 是同一个函数，工具返回的 `recordedAt` 就是它）；
`news` 用真时钟（真实头条的新鲜度要跟真实现在比）。**探针的逻辑**（照这份清单可以十分钟内重建）：
读 `.env` 取密钥 → `loadConfig()` → `openXixiStore({dbPath, clock})` → `new DurableReminderSink({store, timezone})`
→ `buildPluginRuntime(config, {now, reminderSink, fetchImpl, news?})` → `await start()` → `new MimoBrainAdapter({registry, scope:'conversation'})`
→ `new ConversationEngine({adapter, store, config, clock})` → `engine.respond({sessionId, text, addressed:true})`，最后直读 SQLite。

## 1. 四条 gate（`024cd43`，工作区 `git status --porcelain` 为空）

| 命令 | 实测 | 判定 |
|---|---|---|
| `node --version` | `v24.21.0`；`package.json` 的 `engines.node = ">=24.0.0"` | ✅ |
| `npm run check:types` | **exit 0**（无输出即无错） | ✅ |
| `npm test` | **717 项 / pass 717 / fail 0 / cancelled 0 / skipped 0 / todo 0**，`duration_ms 45144.0323`，**exit 0**（三条命令同一批跑，外墙钟 47.1 s） | ✅ |
| `npm run check:docs` | **104 份 markdown｜失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0**，exit 0。**本报告写入后再跑一次：105 份 markdown，三个 0 不变，exit 0**（多的那一份就是本报告） | ✅ |

**与上一轮可比的口径**（同一台机器、同一个 `npm test` script）：

| 阶段（取数时） | 项数 | `duration_ms` |
|---|---:|---:|
| P0 复验（`273e3b6`） | 520 | 32929.9 |
| P1 复验（t15 报告） | 575 | 41444 |
| P1 收口（`6170e4c`/`0c7d804`，t16/t26） | 588 | — |
| **P2 复验（`024cd43`）** | **717** | **45144.0** |

项数比上一轮多 129 条（P2 的插件内核 / MCP / 审批 / news / 提醒五条线的用例），**门禁口径没变**（`package.json` 的 `test` script 仍是同一组六个 glob）。
P2 变动面的细分实跑：`node --test "tests/unit/plugins/**/*.test.ts" "tests/unit/reminder/*.test.ts" "tests/unit/core/tool-loop.test.ts" "tests/unit/core/tool-approval.test.ts" "tests/unit/core/tool-registry.test.ts" "tests/integration/reminder/*.test.ts"`
→ **131 项 pass 131 fail 0、`duration_ms` 4320.7、exit 0**。

## 2. 场景一「今天有什么新闻？」——**交付件上成立**

实测（`final-news.json`，真模型 + 真 BBC World RSS + 真 Hacker News JSON API）：

```text
offeredToModel: xixi_get_current_time, xixi_get_weather, xixi_set_reminder_stub,
                news.search, news.latest, news.for_interests
lifecycle     : [{ id: "xixi.news", state: "active",
                   capabilities: ["tool:news.for_interests","tool:news.latest","tool:news.search","topic_source:news.topics"],
                   health: "ok" }]
executedToolCalls: [{ name: "news.latest", ok: true, error: null }]
networkCalls  : https://feeds.bbci.co.uk/news/world/rss.xml
                https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=10
事件日志       : assistant 轮次 tool_name = "news.latest"（sequence 2）
```

- **真的形成了 tool call**：`news.latest` 由模型在读到这句话之后发起，且**真的执行了**——
  这条记录来自 `ToolRegistry.execute` 内部的 `onToolCall`（不是模型自述），结果是 `ok: true`，返回里 `providers: ["BBC World","Hacker News"]`。
- **内容是真来源**：那一刻的两条真实头条（`Flydubai co-pilot attacked captain with axe, UAE official says` 等）进了回复；
  `networkCalls` 是探针自己记的两次真实 HTTP 请求，不是转述。
- **在工具调用记录里可查**：事件日志的 `conversation.turn` 那一行带 `tool_name: "news.latest"`——这正是 `npm run turns` 读的那个字段。
- 离线桩来源也跑过一次（`--stub`，零网络）：同样形成 `news.latest` 调用，回复用的是桩头条，用来证明这条链路不依赖联网。

判定：**✅ 成立**（在交付件的装配点上；入口层不成立，见 §4）。

## 3. 场景二「明天八点提醒我打电话。」——**交付件上成立，但可靠性未达标**

### 3.1 成立的那部分（进程 A 写 → 进程 B 重启后仍在 + 到点成事件）

进程 A（真模型 + `DurableReminderSink` + 注入时钟 `2026-10-05T21:30+08:00`）：模型调用 `xixi_set_reminder_stub`，
落库一行（`dump` 直读 SQLite 的 `reminders` 表）：

```text
id rem_9132548c-…  owner father  what 打电话
due_at 2026-10-06T08:00:00.000+08:00   timezone Asia/Shanghai   resolve_kind day_relative
created_at 2026-10-05T21:30:00.000+08:00   status pending（写入时）
```

**「明天八点」被解析成绝对时刻 + 时区**（不是把自然语言原样存下来）——这是 pack §7 点名要的那条。

进程 B（**新的 `node` 进程**，同一个文件库；注入时钟 `2026-10-06T08:00:30+08:00`）：

```text
remindersReadFromDisk: [{ what: "打电话", dueAt: "2026-10-06T08:00:00.000+08:00",
                          tz: "Asia/Shanghai", status: "pending", resolveKind: "day_relative", owner: "father" }]
tick.becameDue:        [{ what: "打电话", dueAt: "2026-10-06T08:00:00.000+08:00", status: "due" }]
tick.becameCandidate:  [{ what: "打电话", status: "candidate" }]
reminderEventsInLog:   seq 2 reminder_created(pending) → seq 5 reminder_due → seq 6 reminder_candidate
```

- **重启后仍在**：这一行是**另一个进程**在读磁盘（`status: pending` 是 tick 之前读到的），不是同一个进程的内存。
- **到点真的形成提醒事件**：`reminder.changed` 三条事件在同一事务里写进事件日志（`reminder_due` / `reminder_candidate`），
  状态机 `pending → due → candidate` 每步一个可观察转移——这正是主动路径 `candidateInputs()` 会消费的队列。
- 事件日志里同时有 `conversation.turn` 的 `tool_name: "xixi_set_reminder_stub"`，所以「谁在什么时候要求记的」也能对上。

判定：**✅ 成立**（在交付件的装配点上；入口层不成立，见 §4.2）。

### 3.2 未达标的那部分：真模型只有约四分之一的时候真的调工具

同一句话、同一条交付链、同一个模型，**22 次保存了逐条记录的尝试里只有 6 次形成 tool call（27%）**：

| 批次（保存的文件在 `.scratch/t14/`） | 尝试 | 有 tool call | 没有 | 其中回复明说「记下了」 |
|---|---:|---:|---:|---:|
| `remind-sample-8.json`（8 次） | 8 | 3 | 5 | 1 |
| `remind-sample-4.json`（4 次） | 4 | 1 | 3 | 1 |
| `remind-sample-final4.json`（4 次） | 4 | 0 | 4 | 2 |
| `remind-sample-final6.json`（6 次） | 6 | 2 | 4 | 0 |
| **合计** | **22** | **6（27%）** | **16** | **4** |

没有 tool call 的那 16 次里，回复是这样的（逐字取自上面的文件）：`好记下了明早八点提醒你打电话。`、
`行明早八点提醒你打电话。这么晚了，早点睡吧。`、`成明天早上八点提醒你打电话。`——**她说了「记下了」，而库里没有行、也没有任何事件**。
也就是说：不是「她不知道」，而是**在 27% 之外的 73% 里，用户会以为记下了，实际什么都不会发生**。

根因（读代码得到，不是猜）：
- 提示词层的 `HARD_POLICY`（`packages/conversation/src/prompt.ts`，`git grep -n '工具' -- packages/conversation/src/prompt.ts`）
  要求「**可核查的具体事实**只能说工具查到的」——它约束的是「事实」（天气/新闻），**没有一句要求「提醒我……」这类写操作必须走工具**；
  另一句是「工具只是能力，不报幕」。
- 工具描述自己写着「用户说『提醒我……』时使用」，但**模型看得到描述不等于被要求用**：新闻那类问句（明确的取信息请求）3 次跑（1 次离线桩 + 2 次真来源）**3 次都调了工具**，
  提醒这类（看起来像「你说一声我就记住了」）就掉到 27%。
- 结论：**这是提示词/行为层的缺口，不是持久化实现的缺陷**（同一套工具调用一旦真的发生，§3.1 的链路每次都成立）。
  建议下一轮单开一条：在提示词的写操作段写清「答应记一件事之前必须调用记录工具，做不到就说做不到」，
  并在默认门禁里加一条**离线**的「模型输出 tool_calls 时链路成立」的用例（现在默认门禁覆盖的是工具本身，不覆盖模型是否选它）。

判定：**❌ 未达标（可靠性口径）**；成立的部分按 §3.1 写，不合并成一句「已达标」。

## 4. 入口层实测：两个场景在四个 live 入口上都还不成立（Tier 2 未接线）

### 4.1 新闻：入口根本没把 news 工具给模型

```powershell
node scripts/chat.ts --print-wiring
```

实测：`{"entry":"chat","language":"zh-CN","maxToolRounds":4,"tools":["xixi_get_current_time","xixi_get_weather","xixi_set_reminder_stub"], …}`
——**没有 `news.*`**。代码侧同一条事实：`git grep -n buildPluginRuntime -- scripts` 只命中 `scripts/probe-tools.ts`（诊断脚本），
四个 live 入口（`chat` / `serve-chat` / `field-test` / `voice-turn`）都只调 `buildToolChain`。

真跑入口（真模型，隔离库 `XIXI_DATA_DIR=$env:TEMP\t14-entry`）：

```text
西西：现在是2026年10月4日星期日下午1点53分新闻这个我手头没有能查的东西怕说错了误导你——你要是想看，我建议直接打开新…
[stderr] [tool] xixi_get_current_time ok
事件日志: assistant 轮次 tool_name = "xixi_get_current_time"
```

——**没有 news tool call**（她只会调时间），回复是「我查不了」。这不是模型的问题，是**工具链里没有那个工具**。

### 4.2 提醒：入口的 sink 还是内存版，工具调了、库里没有行

同一入口、同一句「明天八点提醒我打电话。」：

```text
[stderr] [tool] xixi_set_reminder_stub ok        ← 工具真的被调用了
西西：记下了明天早上八点提醒你打电话。
```

直读那个库（`dump`）：

```text
reminders: []                 ← 一行都没有
reminderEvents: 0             ← 一条 reminder.changed 都没有
eventTypes: conversation.turn, conversation.decision, system.health
```

代码侧同一条事实：`git grep -n 'DurableReminderSink\|ReminderScheduler' -- scripts` **零命中**（只有测试与 `packages/runtime/src/index.ts` 的再导出）。

判定：**❌ 入口层未达标**，根因一句话——**内核、MCP、news、审批、提醒的装配点都已交付，但四个 live 入口仍只调 `buildToolChain`**，
`buildPluginRuntime` 与 `DurableReminderSink`/`ReminderScheduler` 没有接进入口。这属团队已登记的 Tier 2 接线项，本次复验只负责如实写出来。

## 5. 边界与遗留（连同我实测到的那几条）

1. **Tier 2 入口接线（本次两条未达标的共同根因）**：入口改成 `buildPluginRuntime(config, {news, mcpServers, reminderSink})` 的 `start()`，
   提示词侧的 `verifyOnAssemble` 也还没有调用点；审批宿主（`ToolApprovalManager`）与提醒 scheduler 同样没有入口调用点。
   今天能跑的证据链是「装配点 → `registry.execute` → 真表 → 重启 → tick → 事件」，**不是**「某个入口已经这样跑」。
2. **MCP 真实服务器的联网限制**：`git grep -n 'mcpServers\|createMcpPlugin' -- scripts` 我实测**零命中**——没有任何入口配置过 MCP 服务器；
   已有的证据是 SDK v2 的**真 client + 真 server**走 `InMemoryTransport`（`tests/unit/plugins/mcp/stub-server.ts`），
   没有对着**外部进程/远程服务器**跑过。pack 的 DoD 第 6 条（MCP tool 可作为 Xixi Tool 运行）按「SDK 客户端路径成立、外部服务器未验证」写。
3. **新闻真实来源是手动证据**：默认门禁用的是离线桩来源（`--news` 探针 `networkCalls=0`），
   真实 RSS/HN 只在我这份手动复验里跑过（2 次真实 HTTP、真实头条）。这是 AGENTS §2 的口径，不是缺陷。
4. **提醒工具的命名与文案已过时**：工具仍叫 `xixi_set_reminder_stub`，`packages/brain-adapter/src/tools.ts` 的返回文案仍写
   「已经记下；到点不会自动响，需要人看一眼」——接上 durable sink 之后这句话与事实相反（t8 与 t24 都点过，P2 未改）。
   `git grep -n '到点不会自动响' -- packages` 可复核。
5. **提醒的可靠性缺口**（§3.2）：真模型 22 次尝试 6 次调工具；失败模式是**静默**的（她说记下了）。需要提示词层与默认门禁各补一条。
6. **团队已登记、我未重复测量的遗留**（只登记，不冒充我的测量）：`PluginRuntimeMount.start()` 不幂等（t19 的 O1）、
   `manager.instance().health` 是过期快照（handoff 下一轮清单第 10 条登记）、manifest 的 tool 级 approval 声明未实现（t22 的 F3）、
   P2-F 的两条接缝（`supportsImages` / `inferJson`）在生产侧没有消费者（t16 的 F4）、
   `plugins/xixi-tools/index.js` 仍 import `@deepseek-ai/dsh-tools` 这条铁律 9 的口径需要用户裁定（t17 交回 captain）。
7. **未做独立复验的部分**：MCP 的命名空间/降级/重连细节与插件内核的四条「不能做」我这次只跑了两条细分门禁（131 项全绿），
   细节结论以 t19/t21 的评审为准，我**没有**重复它们的突变实验。

## 6. 复验本身的限制

- 真模型的行为是随机的：§3.2 的 27% 是 22 次尝试的计数（每一条都在 `.scratch/t14/remind-sample-*.json` 里逐字保存），
  不是「一次跑通就当结论」；但它也**不足以**给一个置信区间，只能说明「远不是每次都成立」。
- 22 次尝试横跨 `4eb42ec`（工作区未提交）与 `024cd43`（已入库）两个时刻：这两者之间只有提交动作、**没有代码内容变化**
  （`git status` 在提交前为 0、提交后也为 0，我对比的 `packages/plugins/news/plugin.ts`、`packages/runtime/src/reminder-runtime.ts` 等文件哈希见 §7）。
- 探针在 `.scratch/t14/`（gitignored），**没有进仓库**；本报告的命令可以直接重跑，探针按 §0 的清单可重建。
- 本任务**不改任何代码、不提交**；改动只有两份文档。

## 7. 取数时的文件哈希（`sha256` 前 16 位，`024cd43`、工作区干净）

```text
2DB908D374ABEFA0  packages/plugins/news/plugin.ts
BA013C5CAFADA199  packages/plugins/news/tools.ts
AEFAA706626A28F7  packages/plugins/src/manager.ts
AE49A4AB0EA129B6  packages/runtime/src/tool-runtime.ts
1192DDAD301405C2  packages/runtime/src/reminder-runtime.ts
59E730D120DDFFBA  packages/domain/src/reminders.ts
A3E0600A6D59F3E1  packages/brain-adapter/src/tool-registry.ts
B0DD5C60529B5710  packages/runtime/src/tool-approval.ts
EF89954A00DB535A  packages/brain-adapter/src/types.ts
```

（`packages/runtime/src/tool-approval.ts` 与 `reminders.ts` 的两个前缀分别与 t22、t24 回报里的哈希一致，可作为「我复验的就是交付字节」的交叉核对。）
