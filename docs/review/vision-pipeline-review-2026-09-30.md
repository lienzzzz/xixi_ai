# 评审：图像管道与「不带图逐字节不变」（t87）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t85 的 API 探测与 t87 的实现）
> 评审对象：`666a88c`「t87 完成：大脑接缝与 MiMo 适配器支持可选图像（真密钥答对颜色）」（`packages/brain-adapter/src/{types,mimo,dsh,fake,index}.ts`、`packages/model-adapters/src/{mimo,index}.ts`、新增 `tests/unit/core/mimo-image-payload.test.ts`、两份 `docs/recon/`）
> 复核方式：**我自写两组探针**（26 项断言全过）——注入假 `fetch`/假 transport，把**真正会发出去的请求体**截下来逐字节比较，而不是读注释；另读错误码表与调用方代码
> 时序：HEAD = `666a88c`；工作区有**他人在途**改动（未提交）：`scripts/field-test.ts` +445/−10、`scripts/verify-camera-presence.ts` +91/−5、`perception_edge/run.py` +102/−16（t88 的「看一眼」等）。我的探针只依赖 `packages/`（**不在在途改动里**），所以结论绑定 `666a88c`

---

## 1. 结论

**verdict：pass（无 blocking finding；4 条观测在 §6）**

一句话：**「不带图就原样传 messages」不是一句注释，而是可以逐字节验的**——我截下来的纯文本请求体与「把 messages 原样放进去」的字面量**哈希完全相同**（`f5e9ee24b17fdc12`），`body.messages` 与我传入的数组序列化后一字不差（连我自己塞的未知字段 `extra_field` 都活着，说明根本没有「重建 messages」这一步）；带图时**只有最后一条 user 消息**变成 OpenAI 风格 `content` 数组（`text` + `image_url` 的 base64 data URL），前缀消息一字未动，本地字段 `images` 被摘掉不上线。最容易丢图的两处我都单独验了：**工具轮次的第 2 个请求里图还在**；**DSH 路径在调 transport 之前就拒绝**（`BAD_REQUEST`，transport 0 次调用）。`BAD_REQUEST` 的选择我判为**成立**（理由与两个可改进点见 §4）。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 独立核对两处：①「不带图就原样传 messages」的逐字节依据（自己构造两种请求体对比）；② DSH 用 `BAD_REQUEST` 是否合适 + 检查带图路径有没有静默丢图的可能 | **真正满足** | §2（四种请求体 + 两条接缝路径）、§3（丢图审计 6 处）、§4（错误码表 + 调用方 + 实测拒绝） |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/` | **满足（红项已归因**，见 §5） | `npm test` **213 / 212 pass / 1 fail**（唯一红项是**在途**代码加了个 `BACKCHANNEL` producer，触发契约漂移用例）；`check:docs` **65 份 / 0 问题 / exit 0** |

---

## 2. ① 「不带图就原样传 messages」的逐字节依据

### 2.1 我截获的请求体（注入假 `fetchImpl`，真跑 `MimoClient` / `MimoBrainAdapter`）

| 我的输入 | 截获到的 `messages` | 判定 |
|---|---|---|
| 无图（3 条消息，其中一条带**未知字段** `extra_field: '保留我'`，一条 content 是多行中文 + emoji） | 整个 body 与字面量 `{"model","messages":<我传的数组>,"max_completion_tokens":8,"stream":false,"temperature":0,"thinking":{"type":"disabled"}}` **逐字节相等**（两侧 sha 都是 `f5e9ee24b17fdc12`）；`body.messages` 序列化 sha `c6edffb997bc6a76` 与传入数组一致 | **PASS**：`extra_field` 在、`"images"`/`image_url` 不在 |
| 带 1 张 jpeg 图（末条 user） | 末条变成 `[{"type":"text","text":"这是什么颜色？"},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,QUJDRA=="}}]`；前缀 system 消息序列化后与输入**逐字节相同**；整个 body 里没有 `"images"` | **PASS**：只有该改的地方改了 |
| content 为空 + 带图 | 该消息 `content` 只有 `image_url` 一个 part（**没有空的 text part**） | **PASS** |
| 带 2 张图（jpeg + png） | `["text","image_url","image_url"]`，两个 data URL 的 `mediaType`/`base64` 原样 | **PASS** |

### 2.2 代码侧为什么这就能成立（不是我替它圆场）

- `git show 666a88c -- packages/model-adapters/src/mimo.ts` 显示 `#body()` 里**只改了一行**：
  `messages: carriesImages ? options.messages.map(toWireMessage) : options.messages`。
  不带图时传出去的就是**同一个数组引用**（我的探针证明序列化结果等于原数组——这正是「没有重建」的证据）；带图时走 `map(toWireMessage)`，而它对**没有图的消息原样 `return message`**，所以前缀消息不受影响。
- 接缝侧 `MimoBrainAdapter.#messages()` 用 `...(images === undefined ? {} : { images })` —— 不带图时**连键都不加**。我用 `Object.prototype.hasOwnProperty.call(lastUser, 'images') === false` 断言过（`JSON.stringify` 会掩盖「值为 undefined 的键」，所以这条断言比字符串比较更严）。
- 两条接缝路径都覆盖：`prompt`（system + history + user）与 `context`；`prompt.history` 里 content 为空的那条仍被跳过、**图只挂在最后一条 user 上**，不会挂错。

---

## 3. 静默丢图的审计（我把能丢图的地方逐个找了一遍）

| 位置 | 会不会静默丢图 | 我的证据 |
|---|---|---|
| `MimoClient.#body()` | 否 | §2.1：两种情形都截获过原始 body |
| 接缝 `#messages()`（prompt / context 两条路径） | 否 | §2.1/§2.2（含 `hasOwnProperty` 断言） |
| **工具轮次**（最容易丢的地方：第二轮会重建消息数组） | 否 | 我让假模型第一轮返回一个 **未知工具** 的 `tool_calls`（适配器回填「没有这个工具」后进入第 2 轮）：`raw.length === 2`，第 2 轮请求里那条带图的 user 消息**仍在**，`image_url` part 也在（`messages=4`） |
| DSH 路径 | **不丢，明确拒绝** | §4：`BrainError('BAD_REQUEST')`，transport **0** 次调用 |
| 离线替身 `FakeBrainAdapter` | **会忽略**（不报错、返回值里也看不出） | 带图调用照常返回 `action=SPEAK`、文本与不带图一样；`fake.ts` 的注释写明「故意忽略、不对看见做承诺」→ 观测 O1 |
| 全仓有没有别处把 messages 重构成 `{role, content}`（那会静默丢 `images`） | 没有 | `git grep -n -e "role: .*\.role, content: .*\.content" -e "messages.map(" -- packages scripts` 唯一命中就是新增的 `toWireMessage` 自己 |
| 事件日志/数据库会不会顺手把图存下来 | **不会**（这是好事） | `packages/conversation/src` 里 `images` **零命中**（引擎 `respond()` 还不接受图），`recordTurn` 的 payload 也没有图像字段 |

**由此带出的事实（观测 O2）**：图和「看见」目前只接在**适配器层**；`ConversationEngine.respond()` 还没有 `images` 参数，所以任何想给用户用「带图对话」的入口都得自己调 `adapter.handleUserTurn`（在途的 t88 控制台就是这么做的：`lookOnce()` 传 `images: [{mediaType, base64}]`）。这不是 t87 的错（它的验收就是「接缝与适配器支持可选图像」），但**别把「接缝支持」误读成「生产对话路径已经能用图」**。

---

## 4. DSH 路径用 `BAD_REQUEST` 合适吗

### 4.1 错误码表怎么写的

- `packages/brain-adapter/src/errors.ts`：`BrainErrorCode` 是**闭集**（`NOT_IMPLEMENTED`/`TRANSPORT_FAILED`/`PROVIDER_FAILED`/`TIMEOUT`/`INVALID_RESPONSE`/`AUTH`/`RATE_LIMIT`/`QUOTA`/`BAD_REQUEST`），并且 `NOT_IMPLEMENTED` 旁边专门有一个 `milestone` 字段，注释写的是「**a gap rather than a fault**」（实现缺口，不是故障）。
- `BAD_REQUEST` 在这张表里的来源是**供应商侧**：`brainErrorCodeFor()` 把 `BAD_REQUEST` 原样升级为 `BAD_REQUEST`，`packages/model-adapters/src/errors.ts` 把 HTTP 400/404/422 映射成它；`docs/design/brain-and-models.md`（错误码表 + §21 降级）与 `docs/design/security-and-privacy.md` §7 的口径与代码一致，`originalCode` 闭集也含 `BAD_REQUEST`。
- 调用方处理：**没有任何调用方按 `BAD_REQUEST` 分支**（`git grep` 全仓只有 errors/weather/dsh 自己）。`scripts/chat.ts` 对任何错误打印 `[错误] ${error.message}`；控制台对非 `ConsoleError` 一律回 500 `服务端出错了：<message>` + 「请把它发给维护者」。

### 4.2 我的判定：**成立**，但有两个可改进点

- **为什么成立**：这个拒绝的本质是「**这个请求在这条路径上无法被服务**」——不是凭证、不是额度、不是限流、也不是供应商故障。用 `BAD_REQUEST` 落进现有的「输入侧问题、别盲目重试」那一类，比新造一个码或复用 `PROVIDER_FAILED` 都好；而且我实测它的 `milestone` 与 `originalCode` **都是 `null`**，调用方**能**把「本层主动拒绝」与「供应商转译来的 400」区分开（后者 `originalCode === 'BAD_REQUEST'`）。
- **改进点 O3-a（语义更贴的候选）**：表里真正的「能力缺口」通道是 `NOT_IMPLEMENTED` + `milestone`（例如 `evaluateProactiveCandidate` 就是 `NOT_IMPLEMENTED(M5)`）。「DSH 路径暂时发不了图」在语义上更接近它。**但**选 `BAD_REQUEST` 也有理由：适配器本身是实现了的，出问题的是这次请求带的东西；作者在注释里也写明了「宁可拒绝也不假装看见」。两种都能自洽，我按现状判**可接受**。
- **改进点 O3-b（用户看到什么）**：英文消息 + 中文壳。DSH 拒绝的消息是 `the DSH harness path cannot send images yet (1 image(s) were supplied; use the direct MiMo path for image turns)`；控制台的兜底分支会把它包成 `服务端出错了：<这句英文>` 并给出「请把它发给维护者」的 hint——对一次**有意的拒绝**来说这个 hint 是误导。它**沿用**了本接缝既有的英文消息风格（`model call failed`、`the harness transport did not answer` 等都是英文），所以**不是 t87 引入的退步**；而且在途的 t88 控制台已经在更外层用中文拦住了两种情形（`--offline` → `OFFLINE`「替身适配器不看图…不会真的看到东西」；`--dsh` → `DSH_NO_IMAGES`「--dsh 路径发不了图…用直连 MiMo 按『看一眼』」）。剩下的是一个**通用**问题：谁绕过那两道守卫直接把带图请求交给 DSH，谁就会看到英文 + 「发给维护者」。建议控制台按 `BrainError.code === 'BAD_REQUEST'` 给一条中文提示（或在 seam 里换中文），这样任何调用方都不会把它当成内部故障。

### 4.3 实测（我的探针）

| 我做的 | 结果 |
|---|---|
| `DshBrainAdapter.handleUserTurn({…, images: [1 张]})` | 抛 `BrainError`，`code = 'BAD_REQUEST'`，`message/detail` 与上面一致，`milestone = null`、`originalCode = null`；**transport 一次都没被调用** |
| `images: []`（空数组） | **不算带图**：不抛 `BAD_REQUEST`，transport 被调用（我让 transport 抛标记错误以证明它被走到） |
| 离线替身 | 带图照常返回、不报错（文档写明故意忽略） |

---

## 5. 门禁

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm run check:docs` | HEAD `666a88c`，工作区只有他人在途的 `scripts/`、`run.py` | 检查了 **65 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 66 份 / 0 问题 / exit 0） |
| `npm test` | 同上（在途：`scripts/field-test.ts` +445/−10、`scripts/verify-camera-presence.ts` +91/−5、`run.py` +102/−16） | **213 tests / 212 pass / 1 fail**，exit 1；唯一红项 `BACKCHANNEL and WAIT have no producer outside the declared contract`（`tests/unit/core/dead-code-truthfulness.test.ts`） |

**红项归因（§9.10）**：该用例的断言消息是「adding a producer is fine — but it must update this test and docs/design/brain-and-models.md §8」——它是**故意**用来抓「新出现 BACKCHANNEL/WAIT producer」的漂移闸。工作区 `git diff`（**未提交**）在 `scripts/field-test.ts` 里新增了一行 `store.recordTurn({… action: action === 'SPEAK' ? 'SPEAK' : 'BACKCHANNEL', source: 'look-once:…' })`，正是这次在途的「看一眼」改动；**t87 的提交没有碰 `scripts/`**（`git show --stat 666a88c` 的 10 个文件里只有 `packages/` 与 `docs/recon/`）。为把归属钉死，我还单跑了两个文件：t87 自己的 `tests/unit/core/mimo-image-payload.test.ts` → **4/4 pass**；那个漂移用例单跑 → 仍是同一条失败、断言消息同上。

**顺带一句给出警的人**（越界，仅供队长调度）：在途那行把「不是 SPEAK」一律记成 `BACKCHANNEL`；`dead-code-truthfulness.test.ts` 与 `docs/design/brain-and-models.md §8` 需要同步，否则全队门禁会一直红。这属于 t88 的收尾，不是 t87 的问题。

---

## 6. 观测（都不改变 verdict）

- **O1（低，替身层的可见性）**：`FakeBrainAdapter` 忽略 `images` 是**写明**的设计，但它**不留下任何可观察痕迹**——调用方拿到的是与无图时一模一样的成功回复，无法从返回值/日志判断「这次根本没看图」。在途的 t88 控制台已经在更外层用 `OFFLINE` 中文提示挡住这个坑，所以今天不伤人；建议替身至少记一个 `lastImages`（或在带图时把 note 塞进结果），让「看图没看图」在外层可查。
- **O2（信息，能力边界）**：生产对话路径（`ConversationEngine.respond`）**还没有** `images` 参数，图和「看见」目前只在适配器层接通；谁能用带图对话，取决于调用方是否自己调 `adapter.handleUserTurn`（t88 就是这么接的）。文档/汇报里不要把「接缝支持图像」写成「对话已经能看图」。
- **O3（低，错误码与措辞）**：见 §4.2——`BAD_REQUEST` 可接受；更贴的语义候选是 `NOT_IMPLEMENTED + milestone`；用户侧建议把这类**主动拒绝**翻成中文并可执行的一句话（今天会显示成「服务端出错了：<英文>」+「请把它发给维护者」）。
- **O4（正面，隐私）**：图像**不会**进事件日志（`packages/conversation` 里 `images` 零命中，`recordTurn` payload 无图像字段），`docs/recon/mimo-vision-pipeline-2026-09-30.md` 里也只写「密钥由环境变量读入、不打印」，我用严格形态（`sk-` 后跟 16+ 字符）扫全仓 **0 命中**；t87 改动的 6 个文件里没有疑似密钥。这条与铁律 6 一致，值得保持。

---

## 7. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node data/rev-tmp/t91-probe.mjs`（**我自写**：注入假 fetch 截请求体；无图/带图/空文本+图/多图/两条接缝/工具轮次/DSH/替身） | **22 项断言全过**（§2、§3、§4.3 的原始值都在这里；无图 body 与字面量同名 sha `f5e9ee24b17fdc12`） |
| `node data/rev-tmp/t91-probe2.mjs`（**我自写**：prompt 路径、history 空条目、多图 mediaType、prompt 无图纯字符串） | **4 项全过** |
| `node --test tests/unit/core/mimo-image-payload.test.ts` | t87 自己的用例 **4/4 pass** |
| `node --test tests/unit/core/dead-code-truthfulness.test.ts` | 3/4：唯一失败是那条 BACKCHANNEL/WAIT 漂移闸（归因见 §5） |
| `git show 666a88c -- packages/model-adapters/src/mimo.ts`（及 `--stat`） | `#body()` 只改一行；t87 的 10 个文件不含 `scripts/` |
| `git grep -n -e "role: .*\.role, content: .*\.content" -e "messages.map(" -- packages scripts` | 无「重建 messages」的写法（唯一命中是 `toWireMessage`） |
| `git grep -n -E "sk-[A-Za-z0-9_-]{16,}" -- .` | **0 命中**（严格形态的密钥扫描） |
| `npm test` | **213 / 212 pass / 1 fail**，exit 1（红项 = 在途的 BACKCHANNEL producer） |
| `npm run check:docs` | 65 份 markdown / 0 问题 / exit 0（含本报告 66 份 / 0 问题 / exit 0） |

---

## 8. 我做过的真实外部动作

**0 次 API 调用**（全部离线：注入假 `fetch`/假 transport，**没有向小米发过任何请求**）、**未开摄像头/麦克风**、**未改任何他人的文件**；探针全部使用系统临时库/纯内存桩。唯一的写入产物是本文件；探针脚本留在 `data/rev-tmp/`（`t91-probe.mjs`、`t91-probe2.mjs`，`data/` 已 gitignore，非交付物）。基线修订 `666a88c`（= 被评交付点）。
