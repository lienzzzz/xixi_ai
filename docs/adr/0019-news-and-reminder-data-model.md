# ADR-0019：新闻与提醒的数据模型（含时区语义与「到点成事件」的口径）

- 状态：已采纳（2026-10-04，V0.3 P2-D t6 与 P2-E t8/t24；P2 收口 t15 落笔）
- 相关：铁律 3（主动行为的硬底线由程序判定）、铁律 4/5（Raw Event 与 Memory 分开、只存原因码与分数）、
  铁律 6（连续音视频不上云）、铁律 8（外部内容是不可信数据）、铁律 10（持久记录要有 schema 版本、迁移只新增）、
  [ADR-0017](0017-plugin-boundary-and-four-prohibitions.md)、
  pack `E:\xixi_v03_actual_code_pack` 的 `03_AGENT_PLUGIN.md` §6/§7、
  `packages/plugins/news/**`、`packages/domain/src/reminders.ts`、`packages/runtime/src/reminder-runtime.ts`、
  `packages/domain/src/migrations/008_reminders.sql`

## 背景

pack §6 要求「删除 `xixi_news_stub` 命名，改真实」，并给出三条工具与**四条主动新闻的判据**；
pack §7 要求把「现有 reminder sink 明确不会响」换成 durable scheduler，给出一张八字段表与五态状态机，
并明确两句：**不要把自然语言 `when` 原样存储**、**「明天早上八点」要 resolve 成绝对时刻 + 时区**。

这两件事合起来是一次数据模型决定：什么进库、什么不进库、时间用什么语义解释、以及「到点」凭什么算发生过。

## 决定

### 1. 新闻：来源是插件，工具是三个，判据是四条

```text
news.search   news.latest   news.for_interests     + topic_source: news.topics
来源四种：RSS（自写无依赖解析器）/ 公开 JSON API（带 mapper 缝，随附 HN）/ web search（适配注入的搜索引擎）/ 离线桩
```

- **news 是一个普通插件**：走 ADR-0017 的九步生命周期，manifest 显式声明 `capabilities: [tool, topic_source]` 与
  `permissions: [network, tool.register, topic.read]`（`network` 是额外声明的那个，理由写在 `plugin.ts` 的注释里）。
  三个工具的作用域是插件默认的 `conversation`——主动路径**不走工具**，它走 `topic_source`。
- **四条主动判据各有可观察结果**（`packages/plugins/news/proactive.ts`）：`fresh`（`publishedAt` 与时钟比，
  未来偏差 `DEFAULT_FUTURE_SKEW_MINUTES = 60`、最大年龄 `DEFAULT_MAX_AGE_MINUTES = 36h`）、
  `personally relevant`（兴趣词匹配）、`not already mentioned`（**账本**：模型看过哪几条就算「提过」，
  所以下一轮不会把同三条头条再念一遍；提出候选**不算**提过）、`not quiet context`（静默时段 / 无人在场）。
- **铁律 8 落在数据形态上**：外部文本一律带 `untrusted: true` 与 `flags`，标题截到 `MAX_TITLE_CHARS = 160`、
  摘要截到 `MAX_SUMMARY_CHARS = 240`、进长期记忆的 digest 截到 `MAX_DIGEST_CHARS = 160`；
  payload 过 `assertNoInstructionChannel()`（没有 `description`/`tool_calls`/`system` 这类可以藏指令的键）。
  **news 插件没有申请 `storage`**，所以它连「把整篇正文写进长期记忆」的地方都没有。

### 2. 提醒：八字段表 + 五态状态机，**没有 `when` 列**

```text
id  owner  what  due_at  timezone  status  created_at  source_event_id        // pack §7 的八个字段
due_at_ms（比较/排序用）  session_id  resolve_kind  status_changed_at  delivered_at  acknowledged_at

REMINDER_STATUSES = ['pending', 'due', 'candidate', 'delivered', 'acknowledged']
REMINDER_REASON_CODES：reminder_created / reminder_due / reminder_candidate / reminder_delivered / reminder_acknowledged
```

- 迁移 008 是**纯新增**（`git diff --name-only -- packages/domain/src/migrations/` 为空自证）；
- **用户的原话不落库**：表里没有 `when` 之类的文本列，`记录的是 due_at + timezone + resolve_kind`
  （工具把解析后的绝对时刻回给模型，所以模型知道记的是几点）；
- 每次状态变化在**同一事务**里改行并追加一条 `reminder.changed`——「到点」是事件日志里的事实。

### 3. 时区语义：按**请求时区**的当地日历解释，不是 UTC、也不是机器时区

`resolveReminderWhen(expression, { now, timezone, defaultTime, asapMinutes })`：

```text
REMINDER_RESOLVE_KINDS = ['absolute', 'day_relative', 'weekday', 'clock_only', 'duration', 'asap', 'unparsed']

absolute     给了明确日期（可带时刻）
day_relative 今天 / 明天 / 后天（可带时刻）
weekday      周三 / 下周三（可带时刻）
clock_only   只说了一个时刻：今天还没到就是今天，已经过了就是明天
duration     半小时后 / 三小时后 / 两天后
asap         尽快 / 马上：就是「现在」，不编一个像样的时间
unparsed     认不出：也是「现在」，但**带标记**——错猜在日志里看得见，而不是藏在看起来很像故意的默认值后面
```

三条承重的不变量：

1. **按请求时区的当地日历算**。「明天早上八点」在当地 `2026-10-05T06:00+08:00`（这一刻 UTC 还是 10 月 4 日 22:00，
   两个日历日不同）解析成 `2026-10-06T08:00:00.000+08:00`；
2. **同一个瞬间换一个请求时区就必须换一个绝对时刻**：同一句话按 `America/New_York` 解析是 `2026-10-05T08:00:00.000-04:00`。
   这条是**为了在开发机上也能证伪**：本机时区恰好就是 `Asia/Shanghai`，只钉上海落点的话，
   一个「忽略请求时区、改用机器时区」的实现会侥幸全绿（t24 用两个突变在**不设 `TZ`** 的机器上把两条用例打红）；
3. **默认值来自配置而不是硬编码**：`config.reminders.default_time`（出厂 09:00）与 `asap_minutes`（出厂 0），
   `reminders.timezone` 有值时**覆盖** `identity.timezone`（`parseReminderSettings`，坏值退回出厂默认）。

### 4. 「到点真的形成提醒事件」的口径

`ReminderScheduler`（`packages/runtime/src/reminder-runtime.ts`）只做四件事，且**只有一处比较时钟**：

```text
markDue(at)          pending → due        （时钟没到就不动、不写事件）
takeCandidates(at)   due     → candidate  （比 markDue 幂等：已经是 candidate 的不再迁移）
deliver(id, at)      candidate → delivered   （谁真的说了这句，谁调）
acknowledge(id, at)  delivered → acknowledged（谁听到了回答，谁调）
```

- **到点 = 一条 `reminder.changed` 事件**（`reason_code = reminder_due`），不是一行日志、也不是一个内存标志；
- `candidateInputs(at)` 把它交给主动路径（`buildProactiveCandidates`，`intent = 'reminder_due'`，
  line 形如「该提醒你了：给儿子打电话」），**说不说仍由读空气决定**（铁律 3）；
- **重启后仍在**：行在文件库里、事件在日志里；`pending` 的行在新进程里读到的还是 `pending`，
  到点后 `pending → due → candidate` 两条事件落进日志（t25 复审与 t14 复验各用两进程真文件库复现过）。

## 后果

- 提醒的语义是**程序事实**：解析方式（`resolve_kind`）、时区、绝对时刻都落库，
  所以事后能回答「她当时为什么定在 8 点」而不是只看到一句中文。
- **未接线（不许写成已接线）**：四个 live 入口今天**没有**把 `DurableReminderSink` 接成 `reminderSink`、
  也没有跑 `ReminderScheduler`（核对：`git grep -n 'DurableReminderSink\|ReminderScheduler' -- scripts` 零命中）。
  实测反证：在 `scripts/chat.ts` 里说「明天八点提醒我打电话。」工具**真的被调用了**，但那个库 `reminders` 表是空的、
  零 `reminder.changed` 事件——入口用的还是内存 sink。
- **提醒的模型可靠性未达标**（t14 复验实测）：同一句话、同一条交付链，22 次真模型尝试里只有 6 次真的调用了工具（27%），
  其余 16 次里 4 次回复明说「记下了」而库里没有行。根因在提示词层（`HARD_POLICY` 只要求「可核查的**事实**」走工具，
  没有要求「提醒我……」这类**写操作**走工具），不是持久化实现的缺陷；下一轮要补提示词段的写操作要求 + 一条离线默认门禁用例。
- **文案已过时**：工具仍叫 `xixi_set_reminder_stub`，返回文案仍写「到点不会自动响，需要人看一眼」
  （核对：`git grep -n '到点不会自动响' -- packages`）——在默认内存 sink 下这句是对的，接上 durable sink 之后必须**一起**改。
- 新闻的真实来源属**手动证据**：默认门禁用离线桩（`networkCalls = 0`），真实 RSS / 公开 JSON API 只由手动复验跑过
  （t14 复验：2 次真实 HTTP、真实头条，事件日志里 `tool_name = "news.latest"`）。MCP 与新闻都还没有对**外部服务器**的验证。

> **加注（2026-10-08，V0.3 P2.5 落笔；本 ADR 原文一字未改，上面每条都是当天的实测）**：上面四条里**三条已经变了**——
> 1. **「入口没接 durable sink / scheduler」已不成立**：`createResidentRuntime()` 自己造 `DurableReminderSink` 与
>    `ReminderScheduler`，四个 live 入口与控制台、试用页都拿它给的；提醒真的落 `reminders` 表、重启后仍在
>    （复核：`git grep -l 'createResidentRuntime(' -- scripts`；以及 `npm run verify:p2.5 -- --scenario=reminder --offline`）。
>    **仍未接的一环是另一件事**：到点由**主动循环**说出来要入口那一行 `...runtime.reminderSeams`
>    （`git grep -n 'reminderSeams' -- scripts ':!scripts/verify-p2-5.ts'` 零命中；**排除验收脚本自己**——
>    P2.5-K 那条 buildToolChain 判据就是被它自己打破的）——所以「活的西西已经在说到点提醒」今天**不成立**。
> 2. **「27% 未达标」已更正**：那是 2026-10-04 上午的一次观测、**同日同口径不可复现**（t27 用同一份探针重跑得
>    改前 21/22、改后 22/22，另一次改前单独复跑 14/17），「提示词层是根因」这个判断**不成立**；
>    P2-H 的 `WRITE_OPERATION_RULE` 确实落了生产代码，但**它的效果本次测不出来**。**不要拿 27% 当现状。**
> 3. **「文案已过时」已修**：工具改名 `xixi_set_reminder`、返回文案「已经记下」，**没有兼容别名**（P2.5-E）。
> 4. 第 4 条（真实来源属手动证据、MCP 未对外部服务器验证）**仍然成立**；另加一条：入口今天各自带一条 RSS 来源，
>    「来源全部由配置说了算」还没做到（`git grep -n 'createRssNewsSource' -- scripts`）。
> 本 ADR 的**数据模型本身（三工具、八字段、五态、时区语义）一字未变**；现况见 [`../progress.md`](../progress.md) §12。
