# 评审：「看一眼」是否真到达模型与三条隐私保障（t88）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t87 的图像管道与 t91 的管道评审）
> 评审对象：`8d2ddec`「t88 完成：控制台「看一眼」——图真的到达模型，真机描述出画面内容」（`scripts/field-test.ts`、`packages/conversation/src/engine.ts`、`config/xixi.example.yaml`、`docs/design/brain-and-models.md`、新增 `tests/console/look-once-console.test.ts`、`tests/unit/core/engine-image-passthrough.test.ts`）
> 复核方式：**注入假适配器 + 假摄像头 runner，起真控制台走完整 HTTP 路径**（不碰真实摄像头、不发任何真实请求），把适配器收到的输入与事件日志逐条截下来核对；另有读码与门禁复核。共 **34 项断言全过**
> 时序：HEAD = `8d2ddec`；工作区**只有别人在改的文档**（`README.md`、`docs/design/perception.md`、`docs/handoff.md`、`docs/testing.md`、`docs/progress.md`，t90/t92 在改），**没有代码在途** → 我的结论绑定 `8d2ddec`

---

## 1. 结论

**verdict：pass（无 blocking finding；5 条观测在 §7）**

一句话：**图确实经引擎到达适配器——我是从适配器那一侧看到的**：给控制台注入一个假适配器和一个假摄像头，点一次「看一眼」，假适配器收到的 `input.images[0].base64` 与我喂进去的那一帧**逐字节相同**（mediaType `image/jpeg`、无 `data:` 前缀），`input.prompt.system` 是引擎组装的那份（583 字符），`input.text/sessionId` 就是这一轮；同时**日志里有两行 `conversation.turn`（user 提问 + assistant 回话）与一条引擎写的 `conversation.decision`**——如果控制台是「自己拼一个请求发出去」，这两行就不会由引擎写出来。无图的那一轮，适配器输入里**连 `images` 这个键都没有**（`keys=sessionId,text,prompt,timeoutMs`），t87 的逐字节不变仍然成立（我把 t91 的两组管道探针在本 HEAD 重跑，22/22 + 4/4 全过）。DSH 拒图**传回调用方**：`--dsh` 走中文 `DSH_NO_IMAGES`（发出任何东西之前就返回、不留审计）；适配器真抛 `BrainError(BAD_REQUEST)` 时页面拿到 `ok:false` + 原始原因、**没有写假的助手轮**、审计记 `failed:…`。三条保障也都成立：默认手动优先、每次上传一条不含图像的审计（明细 184/187 字符、无 base64）、帧不落盘（三处范围扫描新增 **0**）。

| 任务验收条款 | 我的判定 | 我的实测/依据 |
|---|---|---|
| 1 独立核对四件事：① 图确实经引擎到达适配器；② 无图轮次不多出 `images` 键；③ DSH 拒图错误传回调用方；④ 三条保障（默认手动优先 / 每次上传留审计且不含图像 / 帧不落盘） | **真正满足** | §2、§3、§4、§5（34 项断言全过，原始值都在表里） |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果（判读前先看 git status）；结论落 `docs/review/` | **满足（含一次偶发红的归因）** | §6：`check:docs` **66 份 / 0 问题 / exit 0**；`npm test` 首跑 **223 / 222 / 1**，单跑该文件 12/12 ×2、全量重跑 **223/223 ×2** 未复现 → 判为并行负载下的偶发，不归因 t88 |

---

## 2. ① 图确实经引擎到达适配器

我起的控制台：`createFieldServer({ adapterOverride: <假适配器, 记录每次 handleUserTurn 的入参>, liveRunner: <假摄像头, 只回一行带 base64 JPEG 的 frame JSON>, dataDir/presenceDataDir: 系统临时库, offline: false })`，然后用 HTTP 走真实端点（`POST /api/field/live` 启动 → `POST /api/field/look`）。

| 我核对的事实 | 截到的原始值 |
|---|---|
| 假摄像头的第一帧进了控制台内存 | `frames=1`、`hasPicture=true`、`480x360` |
| **适配器真的收到了这一帧**（不是读日志猜的） | `images=1`、`mediaType=image/jpeg`、`base64 === 我喂进去的那串`（`与我的帧一致=true`） |
| 送出去的 base64 不带 `data:` 前缀 | `前缀=cHJvYmUtZnJh`（就是帧内容本身） |
| 同一轮的文字与会话 | `text="画面里有什么？"`、`sessionId=sess_…` |
| **prompt 由引擎组装**（说明这条轮次是引擎的轮次） | `prompt.system` 长度 **583** |
| 引擎把这一轮记进了日志（两条 turn + 一条 decision） | `user=3 assistant=3 decision=3`（含两次「看一眼」+ 一次打字）；两次问题都作为 user 轮写入：`["画面里有什么？","再看一次：有窗户吗？","你好"]`；decision 的 `accepted=true` 且 `reason=ACCEPTED_WAKE_OR_DIRECT / ACCEPTED_CONTINUATION`（引擎给的） |
| 页面拿到的回话 | `action=SPEAK`、`reply="画面里是一排白色的衣柜，左边柜门开着。"`、`latencyMs=15` |
| 代码侧 | `lookOnce()` 调的是 `engine.respond({…, images:[{mediaType, base64}]})`；`RespondInput` 新增 `images`，`respond()` 用 `…(input.images === undefined ? {} : { images: input.images })` 原样转发给 `adapter.handleUserTurn`（`git show 8d2ddec -- packages/conversation/src/engine.ts`） |

> 两条路径的差别（观测 O2）：**手动**这条路走 `engine.respond`（所以 FSM、决策、两行 turn、分段计划都是正常轮的）；**自主看**（`autoLook=true`，默认关）走 composer 里既有的 `engine.adapter.handleUserTurn`（`engine.buildPrompt` + 同一个 adapter，但不经过 `respond`）。这不是 t88 新引入的绕行——composer 一直这么调——但两条路径的记账方式不同，值得写进文档。

---

## 3. ② 没有图像的轮次不多出 `images` 键

| 检查 | 结果 |
|---|---|
| 打字一轮（`POST /api/turn {text:'你好'}`）时适配器收到的入参 | `keys=sessionId,text,prompt,timeoutMs` → **没有 `images` 键**（`hasOwnProperty` 断言，比字符串比较更严） |
| 引擎侧的空值处理 | 只有 `input.images !== undefined` 才带键（引擎 diff 那一行） |
| 端到端「不带图就逐字节不变」是否被 t88 破坏 | 我把 t91 的两组探针在本 HEAD 重跑：**22/22**（无图 body 与字面量同名 sha、未知字段保留、带图只改末条 user…）与 **4/4**（prompt 路径等）全过 |

---

## 4. ③ DSH 拒图时，错误传回调用方而不是被吞

| 场景 | 我实测到的 |
|---|---|
| 真 `--dsh` 控制台（不注入）点「看一眼」 | `ok=false`、`error.code='DSH_NO_IMAGES'`、中文文案「--dsh 路径发不了图：DSH 适配器会明确拒绝带图的请求（宁可拒绝，也不假装看见了）。」+ 下一步提示；而且它**在发出任何东西之前**返回：`vision.history=0`（没有上传、也没有审计条目） |
| 适配器真抛 `BrainError('BAD_REQUEST', 'the DSH harness path cannot send images yet…')`（我注入一个会抛的假适配器，绕开控制台守卫，直接测引擎/页面这条链路） | 页面拿到 `ok=false`、`error.code='LOOK_FAILED'`、`message='这一次调用失败了：the DSH harness path cannot send images yet (1 image(s) were supplied; use the direct MiMo path for image turns)'`、hint 是中文「画面没有重试、也没有落盘；可以直接再按一次。」；适配器**确实被调用了一次**（`captured=1`，说明不是提前被吞）；**没有写出假的助手轮**（`assistant=0`）；审计记了一条 `outcome='failed:the DSH harness path cannot send images yet…'` |
| 结论 | 被吞的三种可能（静默降级为固定话术、写一条假的成功轮、什么都不说）**都没有发生**：页面拿到错误与原因，日志里留下失败审计 |

---

## 5. ④ 三条保障

**（1）默认手动优先**
- `GET /api/field/state` → `vision.autoLookEnabled=false`、`autoLookSource='default'`、`history=0`（全新库）。
- `POST /api/field/vision {autoLook:true}` → 立即 `autoLookEnabled=true`；再传 `false` → 关回去；两次改动各留一条 `system.health/service=vision-settings` 审计（我数到 **2** 条）。
- 自主看那条接缝在 `autoLook` 为假时直接返回 `null`（`vision: () => { if (!vision.autoLook) return null; … }`），所以主动开口的 composer 不会偷偷附图。

**（2）每次上传留一条可查记录，且**不含图像
- 两次点击 = **两条** `vision-look-once` 审计（sequence 6 与 10，各自独立）；失败的一次也记一条（`outcome='failed:…'`）；模型沉默的一次记 `outcome='no-text:SILENCE'`。
- 明细是**代码白名单字段拼出来的**（`v/at/trigger/width/height/bytes/question/outcome/note` + `slice(0,480)`），实测长度 **184 / 187** 字符；我按「是否含我那串帧 base64」与「是否含 60 字符以上 base64 片段」两种方式扫，**都没命中**；字段齐全（`"at"`/`"bytes"`/`"outcome"` 都在）。
- 明文本人也写清了口径：「只记录这一次上传的时间/大小/触发源/结果；图像本身没有写进任何记录，也没有落盘。」
- 「不连续上传」：一次点击 = 一次上传（`captured=2`、审计 2 条）；没有定时/循环附图的路径（默认自动看是关的）。

**（3）帧不落盘**
- 按 t81 建立的同一口径扫描三处范围（仓库 `data/`、`services/perception-edge/`、系统临时目录），前后对比：**新增 0 个图像文件**（基线 7 个）。
- 页面上的隐私提示：「这一张静帧只发送了一次（480x360，0KB）；没有落盘、没有连续上传，记录里也没有图像。」（我核对的是接口返回的那条 `privacyNote` 原文）

---

## 6. 门禁

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm run check:docs` | 工作区只有 t90/t92 在改的文档 | 检查了 **66 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 67 份 / 0 问题 / exit 0） |
| `npm test` | 同上（**代码在途：无**） | 首跑 **223 tests / 222 pass / 1 fail**（红项 `tests/console/proactive-console.test.ts` 的 trial page 用例，用时 4171ms） |

**红项归因（§9.10，先复现再判定）**：单跑该文件 **12/12 通过 ×2**；紧接着全量重跑 **223/223 通过 ×2**，那条红都没复现。该用例会 `spawn scripts/serve-chat.ts --fake --port 0` 并等它打印端口（等待上限 `HTTP_TIMEOUT_MS * 4`），在整包并行负载下偶发变慢 → 判为**偶发（flaky）红灯，不归因 t88**（t88 也没改 `scripts/serve-chat.ts`，它自己披露了这一点）。作为观测记在 O4。

---

## 7. 观测（都不改变 verdict）

- **O1（低，审计可比对性）**：日志里**没有**「这一轮带了图」的标记——`conversation.turn` 只有 `role/action/text/tool_name`，`conversation.decision` 的 `reason` 是引擎自己的 `ACCEPTED_WAKE_OR_DIRECT`/`ACCEPTED_CONTINUATION`；我探针里写的 `reason=VISION_LOOK_ONCE` 只存在于**页面内存**的那一行（`pushTurn`），不在库里。要回答「哪几句话是看着图说的」，只能拿 `vision-look-once` 审计行的时间/问句去 join。**建议**：给该轮 turn 一个可查标记（`source=look-once` 或 payload 里一个布尔）——注意 `conversation.turn` 是 `additionalProperties:false` 的已发布 v1 schema，加字段要走契约流程，所以这只是建议、不是缺陷。
- **O2（信息，两条路径不对称）**：见 §2 的引用块——手动走 `engine.respond`，自主走 composer 直连 adapter（默认关、审计 outcome 为 `auto-look`）。t88 没有新增绕行，但两种记账方式并存，文档里写清更好。
- **O3（低，错误码粒度）**：适配器抛错时页面只拿到 `LOOK_FAILED`，原始类别（`BAD_REQUEST`）在 message 里。用户读起来没问题，但调用方**无法按 code 区分**「模型拒图」与「网络失败」，只有文案；若日后要给不同下一步，需要把原始 code 透出来。
- **O4（低，偶发红）**：见 §6——`tests/console/proactive-console.test.ts` 的 trial page 用例在并行全量下偶发超时/慢（首跑 4171ms，随后四次运行全绿）。建议（可选）放宽它的启动等待或复用夹具，减少噪声。
- **O5（正面，结构性保障）**：审计 detail 是**白名单字段拼出来再截断**的，不是「把 image 对象 JSON 化再删字段」，所以我能在真事件里核到长度 184/187、无 base64——这条比「用例断言」更硬，值得保持。另外 `data/` 里那 4 张历史图像（2 张模型自查图 + 2 张 T0 勘测抓帧）在整个核对期间没有变化。

---

## 8. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node data/rev-tmp/t93-probe.mjs`（**我自写**：假适配器 + 假摄像头 runner + 真控制台 HTTP，四段场景 A/B/C/D + 扫描 E） | **34 项断言全过**（§2–§5 的原始值全部来自这里；A 段 `captured=2`、审计 seq 6/10、`keys=sessionId,text,prompt,timeoutMs`；B 段 `actions=SILENCE`；C 段 `LOOK_FAILED` 且 `assistant=0`；D 段 `DSH_NO_IMAGES` 且 `history=0`；E 段新增 0） |
| `node data/rev-tmp/t91-probe.mjs` / `t91-probe2.mjs`（t91 的管道探针，原样重跑） | **22/22** 与 **4/4** 全过 → t88 改引擎没有破坏「不带图逐字节不变」 |
| `node data/rev-tmp/t93-read.mjs <临时库>`（**我自写**：核对事件形状与审计原文） | `conversation.turn`（user/assistant）、`conversation.decision`、`system.health{service:vision-look-once}` 的实际 payload 与长度（§5） |
| `git show 8d2ddec -- packages/conversation/src/engine.ts` | `RespondInput.images` + 原样转发那一行（`git diff` 只有 3 处） |
| `npm test`（首跑 / 单文件 ×2 / 全量重跑 ×2） | 首跑 223/222/1；单文件 12/12 ×2；全量 223/223 ×2 → 偶发红，不归因 t88 |
| `npm run check:docs` | 66 份 markdown / 0 问题 / exit 0（含本报告 67 份 / 0 问题 / exit 0） |

---

## 9. 我做过的真实外部动作

**0 次 API 调用**（全程用注入的假适配器与假摄像头 runner，**没有向小米发过任何请求**，也没有打开真实摄像头/麦克风）；起过 4 个**本机**控制台（端口 0 自动分配、临时库在系统临时目录），全部已关闭，临时库已删除，**无残留 python 进程**。**未改动任何他人的文件**：唯一写入产物是本文件；探针脚本留在 `data/rev-tmp/`（`t93-probe.mjs`、`t93-read.mjs`，`data/` 已 gitignore，非交付物）。`data/` 下图像数在整个核对期间不变（基线 7 个目标范围内、仓库 `data/` 仍是 4 个）。基线修订 `8d2ddec`（= 被评交付点）。
