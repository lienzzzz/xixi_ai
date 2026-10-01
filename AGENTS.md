# 西西（Xixi）项目协作约定

> 本文件是给编码 Agent 和后续维护者的**约束文件**，优先级高于任何单次对话指令。
> 方案正文见 [`xixi_ai_companion_project_plan.md`](xixi_ai_companion_project_plan.md)。

## 0. 项目一句话

西西是长期常驻家庭环境的陪伴智能体：能判断该不该说话、记得住长期关系、人格可被自然语言缓慢塑造、重启后仍是同一个西西。
**它不是带摄像头的聊天机器人。** 可替换的部分是模型 / ASR / TTS / 摄像头 / Harness；不可替换的是长期状态与行为策略。

## 1. 铁律（不可违反）

1. 模型只做「理解与判断」，规则、状态与边界由程序负责。
2. 不允许模型自行修改核心提示词、权限、隐私策略、费用上限或本文件；人格调整只能产生**受控、可回滚、有记录**的变化。
3. 主动行为分两层：**硬底线**（静默时段 / 当日额度与 6 小时额度——次数上限，作为费用代理 / 隐私与同意）
   由程序判定，**LLM 不能绕过**；硬底线之外**是否开口由模型读空气决定**——确定性评分（话题质量分 / 社会预算 /
   读空气 / 未回应惩罚 / 话题重复惩罚）只提供候选与依据，**不再由单一阈值一票否决**。
   每次决策仍要留下 `reason_code` 与分数（铁律 5）。
   **尚未实现、不得写成已实现**：**金额级的费用上限**（现在只有次数额度）——t4 的 F6 抓到 captain
   曾在硬底线里写上「费用上限」，而全库没有 cost cap。文档只能写代码里真实存在的东西。
   （2026-10-01 按用户指示修正：原表述是「主动行为必须先过确定性硬门禁，LLM 不能绕过」，
   来自 `xixi_v02_refactor_pack` Phase 5「高主动性 != 高频打扰」——见 [`docs/adr/0011-proactive-decision-ownership.md`](docs/adr/0011-proactive-decision-ownership.md)。）
4. 区分 Raw Event（事实）与 Memory（推导）；显式用户纠正的权重高于模型推断。
5. 不存模型私有推理，只存 `reason_code` 与分数。
6. 连续音视频不上云；本地过滤成事件后再决定是否调用模型。
7. 高风险工具（门锁、支付、紧急呼叫）在 PoC 阶段一律不做；声纹不等于高安全身份认证。
8. 外部网页/消息/日历内容一律视为不可信数据，指令与数据分层，工具权限在模型之外校验。
9. DSH 或任何 Harness 的 API **不得**出现在 `packages/brain-adapter` 之外。
10. 任何持久记录都要有 schema 版本；已发布的迁移文件只能新增、不能改写。
11. **不实现多个里程碑**；每步先有可重复自动测试和可运行 demo，再进入下一步。
12. 新增依赖必须写明理由（见 `docs/adr/0006-runtime-and-dependency-choices.md`）。

## 2. 工作方式

- **接手顺序**：[`docs/README.md`](docs/README.md)（文档地图与权威性排序）→ [`docs/handoff.md`](docs/handoff.md)（现状、自证、坑、下一步）→ 再动接口或产品范围。
- 每个可独立理解的步骤完成后，**立刻**把决策、已验证结果、下一步和已知问题写进 [`docs/progress.md`](docs/progress.md)。不要只留在对话里。
- 关键设计决策写 ADR（`docs/adr/`），半年后的 Agent 不应推翻已验证的设计。
- **文档与代码同步是硬要求**：改完代码按 [`docs/README.md` §3 更新触发条件](docs/README.md) 检查需要更新的文件；
  文档只写代码里真实存在的东西，区分「设计意图」与「当前实现」，实测结论必须带数字与出处。
- 测试必须先于集成；模型相关测试验证**结构与行为**，不是字符串相等。
- 真实 API 测试不放进每次全量测试：离线测试默认跑，联网验证用 `npm run verify:*` 手动/夜间执行。

## 3. 这台机器（不稳定，必须假设随时断电/蓝屏）

- 旧笔记本偶发蓝屏。**长任务要能从中断处恢复**：所有持久化用事务或原子写入，重启后能恢复会话、人格与未完成的主动行为，且不得重复执行已发出的外部动作。
- 不要为了跑一个实验引入必须常驻的后台服务；优先用一次性命令 + 临时目录。
- 数据库放 `data/`（已在 `.gitignore`），测试用系统临时目录。

## 4. 环境事实（2026-09-29 核对）

| 项 | 事实 |
|---|---|
| Node | v24.21.0，原生运行 `.ts`（类型擦除，无需编译）；`node:sqlite` 可用（SQLite 3.53.4，含 JSON1） |
| Python | 系统 3.14.7 **不满足** Pipecat / LiveKit 要求。已额外安装用户级 **Python 3.12.10**：`%LOCALAPPDATA%\Programs\Python\Python312\python.exe`。语音相关代码一律用隔离 venv（见第 7 节），不要用系统 3.14 |
| Docker | **未安装**。`infra/docker-compose.yml` 与 MQTT broker 在 PoC 阶段不可用；M0 不引入总线，写入方在进程内直接调用领域层落库，envelope 契约（§23.2）保持不变以便后续换 MQTT |
| DSH | 全局安装 `@deepseek-ai/dsh` **0.1.7-rc.2**（RC，属 Developer Preview），profile `web` 已挂载 `@deepseek-ai/dsh-llm-pi-ai`，因此 MiMo 只需配置路由，不必自写 provider 插件 |
| 模型 | 小米 MiMo：`mimo-v2.6-flash` 已用真实密钥验证可用（`https://api.xiaomimimo.com/v1/chat/completions`，请求头 `api-key`，非 Bearer） |
| 显卡 | GTX 1050 Ti 4GB + Intel HD 630 |
| 外网 | 可能需要代理 `http://127.0.0.1:7890` |
| 命令行工具 | PATH 上没有 `grep`/`rg`，但 **Git for Windows 自带的在 `D:\Git`**：`D:\Git\usr\bin\grep.exe`、`D:\Git\bin\bash.exe`（2026-09-30 实测可用）。PowerShell 里可直接 `& 'D:\Git\usr\bin\grep.exe' -n 模式 路径`，或用 `git grep`；把 `D:\Git\usr\bin` 加进 PATH 就与平常一致。**注意：曾误写成「本机没有 grep」——那只是 PATH 上没有。** |

### 代理

需要访问外网时（npm、GitHub、部分模型端点）：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:HTTP_PROXY  = 'http://127.0.0.1:7890'
$env:NODE_USE_ENV_PROXY = '1'   # Node 需要显式开启才读环境变量代理
```

小米 API 与 npm 在本机实测可直连；失败时再挂代理。

## 5. 数据与密钥

- 密钥只能来自环境变量或本机私有配置（`.env.local`，已 gitignore），**绝不**写进源码、文档、测试样例、提交记录或日志。
- 本会话中曾在聊天里明文出现过 `MIMO_API_KEY`：该密钥应视为已泄露，验证完成后到小米控制台**轮换**。
- 日志不得包含完整音频、图像、密钥或不必要的原始对话。
- 记忆需可查看、编辑、删除；不要把每句对话自动当作永久事实。

## 6. 语言与命名

- 文档、`progress.md`、提交说明、用户可见文案：**中文**。
- 代码注释：英文（与 DSH 生态一致）；标识符英文；错误码与事件类型英文小写点分。
- 领域对象命名与《方案》保持一致：`WorldState`、`SelfModel`、`FatherModel`、`RelationshipModel`、`RoutineModel`、`FutureHook`、`ProactiveEngine`。

## 7. 常用命令

```powershell
npm test                 # 全部离线测试（unit/integration/perception/console），不花 API 费用
                         #   项数与耗时**以实跑输出为准**（不写死；2026-09-30 实测点 223 项、空载约 20s）
                         #   关键路径曾是单文件 frontend.test.ts（多次 Python 冷启动）；
                         #   t47 **改的是 runner（scripts/verify-voice-noise.ts）的常驻 Python worker**，
                         #   该文件因此变快（它一行未改，实测约 10s）；如需回退可设 XIXI_VAD_ONESHOT=1
npm run test:perception  # 只跑摄像头在场与 WorldState 投影
npm run test:console     # 只跑现场测试控制台
npm run install:profile  # 幂等：把仓库内的西西 DSH profile 装进 .dsh/
npm run chat             # 交互式对话（直连 MiMo，实时路径）
npm run chat -- --fake   # 完全离线的对话演示
npm run chat -- --dsh    # 走 DSH Harness（慢，但会话在 DSH 里）

# 验收与评测（会真实调用，按需运行）
npm run verify:m0              # M0 验收：两进程重启恢复
npm run verify:provider        # 一次调用核对 MiMo 路由与工具调用
npm run verify:structured-output  # 结构化输出契约 + 供应商缺陷金丝雀
npm run eval:conversation:judge   # 语料驱动的对话评测（含评审模型），报告写入 docs/recon/
node scripts/eval-realism.ts --corpus=all --repeat=3 --label v02   # 真人感指标（提问率主/辅口径、长度分布、
                               #   禁用模板率、沉默率、重复短语）；--replay <旧 JSON> 不花钱复算、
                               #   --fake 离线自检、--re-run 真跑。口径与局限见 docs/benchmarks/realism-metrics.md
node scripts/make-audio-fixtures.ts   # 用 MiMo TTS 生成中文音频夹具（已存在则跳过）

# 语音（需要 .venvs 里的 Python，勿用系统 Python 3.14）
npm run voice:turn -- --wav tests/audio-fixtures/direct-question.wav
npm run voice:turn -- --wav tests/audio-fixtures/direct-question.wav --wav tests/audio-fixtures/followup-turn.wav
npm run voice:bargein          # §14.2 打断的离线测量（纯本地，不花 API 费用）
npm run voice:noise            # 噪声鲁棒性回归：干净+噪声夹具 → 前端 → VAD → 真实 ASR（会花钱）
                               #   --fake 只验证管线：相似度判据在离线模式不适用，会明确说明并以 exit 0 结束
# 前端与校准（在 services/voice-edge 目录下跑，用 voice-pipecat venv）
#   python -m voice_edge.calibrate --seconds 5      # 噪声底校准（需要带 sounddevice 的 venv，如 .venvs/field-probe）
#   python -m voice_edge.make_noise_fixtures --force # 重建 tests/audio-fixtures/noisy/

# 调试与文档
npm run turns -- data/chat/xixi.sqlite 6   # 看事件日志里的最近轮次（含 tool_name）
node scripts/probe-tools.ts                # 诊断实时工具路径
node scripts/chat.ts --print-wiring        # 四个 live 入口都支持（离线、不调模型、不建库）：
                                           #   打印该入口交给模型的工具链（language / maxToolRounds / 工具与权限），
                                           #   用来证明「同一套工具与权限」在入口之间逐字段相同。
                                           #   另有 scripts/voice-device-check.ts、scripts/eval-realism.ts、
                                           #   scripts/eval-conversation.ts 同样支持；设备自检入口没有离线端到端
                                           #   证据（端到端需真实 WAV + 硬件 + 真实 ASR），见 docs/progress.md §4
npm run check:docs                         # 文档一致性检查（链接/文件引用/新鲜度），提交前应跑
```

语音侧（隔离 venv，勿用系统 Python 3.14）：

```powershell
E:\worker2\.venvs\voice-pipecat\Scripts\python.exe     # pipecat-ai 1.12.0
E:\worker2\.venvs\voice-livekit\Scripts\python.exe     # livekit-agents 1.8.3（含 turn-detector）
```

## 8. 子代理使用

- 适合委派：外部文档/API 核对、独立调研、既有代码审计、可并行且互不依赖的实现块。
- 不适合委派：需要全局架构判断的改动、铁律相关决策。
- 委派时必须给出：目标、可验证的交付形式、允许改动的路径、禁止事项（尤其是密钥）。
- 子代理的结论要落到 `docs/progress.md` 或 ADR，否则等于没做。

## 9. AgentTeams 派单纪律（2026-09-30 本轮血的教训）

本轮有**三次任务失败**（t12 / t2 / t4），原因全部是**派单方 inScope 声明与验收条款不对齐**，而不是成员越权：

1. **inScope 必须穷举「验收条款要求产出的每一个文件」**。写条款时先反推路径：条款说「改 X 的行为」，X 就必须在 inScope 里。
   反例：t12 的条款要求改写一条测试，但那条测试在 `tests/unit/core/`，未列入 → 契约拒绝，任务判 failed。
   反例：t2 的条款要求「复用共享评分定义 / 登记新入口」，对应 `scripts/lib/similarity.ts`、`docs/testing.md` 未列入 → 判 failed。
   **子规则（本轮第 4 次同类失败 t58 换来）**：**验收里含「npm test 全绿」时，inScope 必须包含所有把被改动的值
   钉死的测试文件。** t58 把默认 `proactivity` 从 0.55 改到 0.70，三处改动都完成且读取路径实测生效，
   但三条断言旧值的测试不在 inScope（`tests/unit/domain.test.ts`、`tests/unit/core/proactive-gates.test.ts`、
   `tests/console/proactive-console.test.ts`），于是**任务必然 failed**。
   **派单前先 `git grep` 那个值**，把命中的测试文件一并列入 inScope。
   **amend 只替换你显式给出的字段**：把某个路径加进 inScope 之后，**必须同时检查 outOfScope 是否还禁止着它**
   （captain 本轮就把 `packages/conversation/src/engine.ts` 加进 inScope，却留着 outOfScope 里的 `packages/`，
   自相矛盾——成员会不知道该不该改）。**加完 inScope 要重读一遍整份契约。**
   **子规则（2026-10-01 第三轮 t6 换来）**：**事件类型枚举与「钉死已发布迁移列表」的测试也在 inScope 之外**——
   新事件类型的 `event_type` 枚举在 `packages/contracts/schemas/envelope.v1.json`（**不在** `schemas/events/` 下），
   而 `tests/perception/world-state-projection.test.ts` 把已发布迁移列表钉成字面量（加迁移 003 就必红）。
   派单时要把这两类路径**直接写进 inScope**，否则成员只能靠 §9.2 正文披露。
   **并且：完成校验会拒绝把 inScope 外的路径写进 `changedPaths`（报 `is undeclared`）**——
   所以契约外的必要改动**只能在回报正文里披露**；captain 收到后必须把它转成评审的**显式核对项**
   （第三轮 t7 的 description 就是这么写的），否则这条披露没有任何人负责核。
2. **契约校验只核对成员「声明」的 changedPaths**：未声明的越界编辑**不会**被自动拦截（t4 的 `package.json`、`scripts/voice-turn.ts` 就是这样绕过的）。
   因此唯一防线是：成员**如实披露** inScope 外的改动 + 评审**逐条复核**这些披露。
   **披露的固定格式（t45 的写法已被验证有效，请照抄）**：① 改了哪个文件（完整路径）；
   ② 为什么必须改（对应哪条验收或哪个事实）；③ 为什么没有回滚（例如改动已被 captain 的周期提交收进去）；
   ④ 请谁单独核对这一处。**正例**：t45 用这套格式披露了 `docs/design/domain-model.md` 的两条推论，
   评审据此复核出其中一句与事实相反（四个入口各用不同数据库，覆盖不跨入口）——**格式对了，错误才抓得住**。
3. **多任务不要声明同一路径**：并发写同一文件会互相覆盖（`docs/progress.md`、`tests/`、`package.json` 都踩过）。
   约定：进度文档由集成任务**单写**，其他成员把可直接粘贴的段落写进**完成回报**；测试按子目录分（`tests/unit/voice/`、`tests/unit/core/`、`tests/perception/`、`tests/console/`）。
4. **队长所有的文件成员不得直接改**：`AGENTS.md`、`xixi_ai_companion_project_plan.md`、`.agent-teams/`（后者已 gitignore）。成员提出建议，由 captain 落笔。
5. **任务 failed 后契约是终态、不可 amend**：正确做法是**另开收尾任务**并把下游依赖改接到它（本轮 `t12 → t14`、`t2 → t17`），
   而不是让成员回滚质量或绕过门禁。收尾任务的回报必须写明「原任务失败的归因」与「本次只做补正/核实」。
6. **验收命令必须是改完之后真实存在的命令**；需要新脚本时，把它写进 deliverables，否则 `verify` 无法执行。
7. **每次提交前先跑 `npm test` 与 `npm run check:docs`，并把实测结果写进提交信息**——本轮出现过提交信息声称「全绿」而实际 1 项失败的情况（因为把成员在途的半成品一起提交了）。
   **硬要求：提交信息里的「实测」值必须来自同一次运行的变量插值，不许手写字面量。**
   captain 本轮**三次**手写导致失实（`4bd5b01`、`9c1234d`、`5c75ebd`：信息里写 180/180，而当时实测 exit=1）。
   做法：先跑命令并把 `$LASTEXITCODE` 与 `ℹ tests / pass / fail` 捕获进变量，再插进 `-m` 的字符串
   （注意 §9.8 的引号与尖括号陷阱）。**红的时候也要如实写红**，并注明是哪个在途任务造成的。
   **提交时按「文件」添加，不要按「目录」添加**：captain 本轮用了 `git add tests/`，于是 t2 的提交
   夹带了 t3 的两个测试文件（评审 t6 的 O1 抓到）——目录会把并发任务的在途产物一起收进来。
   派单纪律里的 deliverables 只有意义的前提是：提交的人只加「这个任务真正改动的文件」。
8. **不要用 PowerShell 做批量文本替换/往返读写**：本轮实测它会把 UTF-8 中文写坏（出现 `U+FFFD` 替换字符，直接毁掉源文件）。
   要批量改文本请用编辑工具，或 Python 显式 `encoding='utf-8'` 读写；改完 `git diff --stat` 自检异常体积。
   **另外两个 PowerShell 陷阱（本轮各踩一次）**：① **提交信息里不要出现尖括号**——`<` `>` 会被当成重定向，
   整条命令失败（captain 写过 `-- <paths>` 占位符，提交直接没执行）；② **双引号字符串里不要用反斜杠转义引号**，
   PowerShell 用反引号转义，`\"` 会让字符串提前结束、后半段被当命令解析。长信息优先用**单引号**包裹。
   **③ 提交信息里也不要出现双引号**（本轮第二次踩）：内层双引号会**提前结束外层字符串**，
   后面的 `&&`、`|` 就被当成命令语法（captain 因此让一次提交直接失败）。需要引用时用单引号或「」。
   **④ 文档里给出的命令必须「在目标 shell 里原样可跑」**：t110 抓到 `perception.md` §8.2 的两条
   Python 单行命令写在 ```powershell 块里却用了 `\"` 转义内层引号——PowerShell 不认，逐字照抄得到
   `SyntaxError: unterminated string literal`。**写命令后先在目标 shell 里跑一遍**；
   Python 单行命令的写法：**源码只用单引号、外层用双引号、彻底不出现 `\"`**。
   **验证方式（t112 提出、t113 复核时复现，建议固定成惯例）**：从 markdown 里把命令行**抽出来**、
   **原样**丢给目标 shell 执行（写成 `%TEMP%` 里的脚本再 `powershell -NoProfile -File` 跑），
   **不要靠手读判断能不能跑**——手读看不出 `\"` 这类由外层 shell 抢先解析的问题。
   **⑤ `Out-File -Encoding utf8` 会写 BOM**（captain 本轮踩到）：写出的 JSON 交给 `JSON.parse` 会报
   `Unexpected token '﻿'`。要写无 BOM 文件用 `Set-Content -Encoding utf8NoBOM`，或在读取侧先
   `.replace(/^\uFEFF/,'')`。
9. **默认门禁要保持「可用于迭代」的速度**：重的端到端断言要**缩小输入**（单档 tier、最小夹具子集）来提速，
   **不许靠删断言或把测试挪出默认门禁**来换速度——「测试写了就必须跑」是本项目已经踩过坑的原则。
   **不写死秒数**（曾写 `<25s`，一度不可达）：耗时以实跑为准。
   关键路径曾是 `tests/unit/voice/frontend.test.ts` 的多次 Python 冷启动（每次 2.5–3.4s）；
   **t47 改的是 runner（`scripts/verify-voice-noise.ts`）——它改用常驻 Python worker，该文件因此变快**
   （不是文件本身被优化：`frontend.test.ts` 一行未改，它只是调用变快了的 runner；t43 实测该文件约 10s，
   全量约 20–26s，回退开关是 `XIXI_VAD_ONESHOT=1` 或 `--no-vad-worker`）。
   **可复用的经验**：进程启动成本高时，把「每个用例起一个进程」改成「一个常驻 worker + 真实 CLI 入口 + 内存捕获 stdout」，
   并用一次性路径做对照实验证明结果等价——这比砍断言或改测试强度划算得多。
   **注意别把间接提速写成文件被优化**（t43 的 F1 就是抓这个）。
10. **全量测试结果要在成员在途编辑窗口之外判读**：本轮多次出现「红 1 项」实为他人半成品（失败用例名每次不同、stash 后仍失败即可判定）。
   声明「全绿」时必须带**修订号**与实测输出，否则视为未验证。
   **瞬态红灯有三个来源，判读前先查 `git diff HEAD` 是否为空**：
   ① 成员的半成品（最常见）；② 队长误报——本轮 captain 依据一次红灯（某用例收到 `0.25`）就发出「已发布契约被破坏」的拦截，
   而成员复核后证明该文件与 HEAD 无差异、相关断言全绿；③ **评审的突变实验**——本轮 t32 为证明某条测试不是空断言，
   故意把 `? 1 : 0` 改成 `? 1 : 0.25` 跑一次再按字节还原，**正是那个 0.25 触发了 captain 的误报**。
   **对做突变实验的人**：必须**提前宣告实验时间窗**（回报或消息里说明「我将在 X 分钟内临时改 Y 再还原」），
   或干脆**在仓库外的副本上做**——否则全队正在看的门禁输出会被污染，误伤难免。
   **对报警的人**：先重跑确认可复现，再查 diff；**别让一次红灯变成一次误伤。**
   **④ 并发任务互相牵连（本轮 t76 因此被判 failed）**：`scripts/field-test.ts` 被 `tests/console/` 与
   `tests/integration/` **导入**，所以只要有一个任务在改它，**全队的 `npm test` 都可能红**；
   t76 的验收含「npm test 全绿」，于是在 t74 改该文件的窗口里**必然失败**——这不是 t76 的问题。
   **纪律**：**同一时间只允许一个任务改「会被测试导入的生产文件」**；派单时若某任务的验收含
   `npm test` 全绿，而另一个在跑的任务正在改这类文件，就要**把前者排在后者之后**（显式依赖），
   或者明确告诉它「本次红是 X 在途，按 §9.10 判读」。**按文件路径不重叠来串行化是不够的**——
   导入关系会让不重叠的路径也互相影响。
   **⑤ 本机 `core.autocrlf=true` 且没有 `.gitattributes`——「按字节还原」不能用 `git checkout`**（第四轮 t7 评审实测）：
   `git checkout -- <path>` 会把 LF 写成 CRLF（实测 sha256 从交付 blob 变成 `F622E449…`、CR 计数 668），
   于是「还原后哈希一致」这句话就会变成假的。**正确做法：实验前把文件复制一份到 `%TEMP%`，还原时用副本拷回**，
   再与交付 blob 的 sha256 比对；另外 `git checkout` 之后即使 `git diff` 为空，文件仍可能显示 stat-dirty「 M」，
   用 `git update-index --really-refresh -- <path>` 刷新即可。**突变实验的宣告里要写清用哪种还原方式**，
   并报**最终文件哈希**（不要报窗口中途的哈希——第四轮 t2 就因为报早了而出现过对不上的记录）。
11. **`deliverables` 必须与「本次真正会改动的文件」一致**（不只是 `inScope` 允许改的集合）。
   反例：t26 为满足某条验收顺手改了 `docs/recon/camera-detector-choice-2026-09-30.md`，它写在 inScope 里但不在 deliverables，
   于是**没有进 changedPaths**，只能靠成员主动披露 + 评审逐处核对才被发现。派单时请把「验收会碰到的文件」全部列进 deliverables。
12. **`acceptanceResults` 必须与任务的 `acceptance` 数组逐项对应**（条目数与 criterion 文本都要对上），否则完成校验会整份拒绝。
   反例：t26 按自己理解的 1/2/3/6 条提交，全被拒，而报错只说「requires passed acceptanceResults for every acceptance item」，不提示期望条数。
   **因此 captain 派单时把验收清单编号写进任务 description**，成员按同一编号回报，不要靠猜或去读团队状态文件。
13. **优先「核实后不认同」而不是盲从**：t23 面对评审「表头写反了」的判断，逐格复核后确认没反，于是不改数字、只把表头改成无歧义写法并附原始格值——
   这比盲改更有价值。评审也会错，关键是**谁给出可核对的证据**。
14. **任务 description 里提到的产物文件名必须与 `inScope`/`deliverables` 逐字一致**。
   反例：t13 的 description 与它的 inScope 用了**两个不同的评审报告文件名**（一个带 `t12` 一个不带），
   成员只能按契约落地并回头问 captain，白费一轮沟通。**一个任务只用一个文件名**，不要出现近似名。
15. **`acceptance` / `description` 文本里不要出现像路径的片段或转义**：本轮实测派单文本会被拼接/误解析——
   t31 收到的 inScope 混进了 `1/0`、`87/87`、`137/137` 这类**非路径**片段，还漏掉了真实的
   `docs/design/domain-model.md` 与 `tests/unit/core/`；验收条目也从 5 条变成 3 条。
   **写法要求**：每条验收写成一整句、单行、不含 `\n` 转义；**路径只出现在 `inScope`/`deliverables` 里**，
   不要在验收正文里用反引号罗列文件名；数字不要写成 `a/b` 形式（会被当成路径）。
   成员若发现收到的契约与事实不符，按 §9.12 的提示核对后**在回报里说明**，不要将错就错。
   **补充（2026-10-01 第四轮 t8 换来）**：**自动派生的修复/复审任务（repair / review-round-N）也会被折进非路径片段**——
   第四轮 t8 的 inScope 里混着 `4/13`、`0/13`、`17/17` 这类从 finding 正文抄来的数字，正是本节点名的形态。
   成员的正确做法（t8 已示范）：**如实说明收到的契约文本有杂质、并声明实际只改了真实路径**；
   captain 的正确做法：自动派生任务生成后**立刻读一遍它的 inScope**，发现杂质就用 `edit_plan` 的 `update_task`
   把 inScope 换成真实路径（该任务若已被认领就只能靠披露 + 评审核对）。
16. **长文本会被截断——派单与回报都要短句**：本轮实测两处——
   ① t31 收到的任务文本被拼接/误解析（验收 5 条变 3 条、inScope 混入非路径片段）；
   ② t33 的完成回报因 payload 被截断（缺 task_id）**整份被拒**，只能重发。
   **做法**：验收条目写短句；`evidence`/`commandsRun` 的 evidence 字段保持一句话；
   路径与编号集中放在 `inScope`/`deliverables`；不要把长表格塞进契约字段。
   **第四轮 t10 又见一例（2026-10-01）**：派单时 `description` 里写了三条验收，而 `acceptance` 数组只到了两条
   （成员按数组两条回报并在回报里说明——这是**正确做法**）。**纪律**：captain 建完任务后**回读一次 acceptance 条数**；
   成员遇到这种不一致时**以 acceptance 数组为准**，并在回报里写明差异。
17. **同一个事实可能有三份不同的说法——以代码为准**：t33 面对「`appendEvent` 有几个调用点」，
   发现**文档写 2 个、评审说 3 个、代码实际 4 个**，且其中一处写入在引擎层、另有一条**绕过 `appendEvent`
   直接写库**的 Python 路径（感知边）。**遇到分歧就去读代码并给出文件与行号**，然后同时更正文档与评审结论。
18. **修漂移时不要制造新的漂移源**：写死计数（自检项数、测试项数、文档条数）、**耗时**、**代码行号**都会再次过期；
   新增一个自检项还会连带要求三份文档同步。
   t37 的正解：把新断言**并进既有自检项**（项数不变），并在 `--help` 里**不写死数字**（改为「看末行结果」）。
   t34 抓到的反例：文档钉了 15 处代码行号，**13 处已漂移**，多数指向错误的代码。
   **原则**：能推导的就别写死；能用一次运行输出的，就别复制到三处文档；
   **引用代码位置时用「函数名 + 一条可复现的 `git grep` 命令」，不要用行号**（行号随任何一次编辑失效；
   本机 `grep` 在 PATH 上没有但 Git 自带了，见 §4）。
   **结论的第一引用必须是「能重跑的命令」，不是「某次运行的产物文件」**：产物若落在 gitignored 的 `data/` 下，
   换机器即失、别人无法核对（t39 的 O1）。正确写法是「一条命令 + 预期输出」，产物只能作附件。
19. **`acceptance` 数组最多 3 条、每条一句话（硬约束）**：本轮 **t31 与 t38 两次**被成员报告「收到的派单把
   acceptance 截断/改写成 3 条」，两次都是因为 captain 往数组里塞了 5~7 条长句，且句中带数字列表
   （如 `104/128/−64/96`）与文件名——正是 §9.15 禁止的形态。
   **正确写法**：`acceptance` 只放 3 条以内的短句（它是完成校验的对照表）；把逐项对齐细节写成
   `description` 里的一段散文；**所有路径只出现在 `inScope`/`deliverables`**。
   成员若发现收到的文本与真实契约不符，仍按 §9.12 核对后在回报里说明——但 captain 应先不制造这种局面。
20. **修订号必须标明语义：基线 ≠ 交付**。成员**不负责提交代码**，因此回报里**不要声称「交付修订号」**——
   只报**基线修订号**（你开始工作时看到的 HEAD），并说明产物已在工作区、由 captain 提交。
   captain 提交后用**追加式 `evidence_note`** 回填真正的交付号（终态结果不可改，只能追加证据）。
   本轮**三次**实例：t31 报 `f2f35c9`、t33 报 `d08d5cc`、t35 报 `b8f0e9b`，三个都是**基线**，
   交付分别是 `30c8160`、`b8f0e9b`、`540d1d7`——引用别人回报里的哈希前，先确认它是基线还是交付。
21. **验收条款只写「可观察结果」，不写「实现做法」**。反例：t35 的验收里我写了「确认用例内部真的做了保存与恢复环境变量」，
   而成员压根没碰环境变量——它显式传空串并断言 `hasKey === false`，**比我的要求更干净**，却与条款字面不符。
   **写法**：条款描述「必须成立的可观察事实」（如「该用例在带密钥与不带密钥的环境下都必须通过」），
   不要规定用哪种手段达成；手段留给实现者，否则会把更优解判成不合格。
22. **取消一个被依赖的任务会让整条下游链永久卡死——取消前先改接下游**（captain 本轮把全队冻住了）：
   依赖只在「已完成」时满足，**「已取消」不满足**。captain 按证据取消了 t11（提问率任务，前提被推翻），
   而 t13 依赖 t11 → t13 永远不可认领 → t15/t18/t19/t20 全部阻塞 → **五个成员全部空转、流水线冻结**，
   而 status 里看不出「为什么没人动」（只显示 pending）。
   **纪律**：取消任何任务前，先 `agent_teams_edit_plan` 把**所有**以它为依赖的待办任务改接到替代任务
   （或一并取消并重建）；改接完再取消。**判据**：取消后立刻看一次 status——若有 pending 任务而其依赖含
   取消态任务，就是冻结。
   本轮修法：把 t13 与 t15 合并成一条「回复管道」任务（同一位成员、同一批文件），
   再按正确依赖重建下游（t21→t22→t23/t24/t25），内容一字未丢。
23. **运行中的团队改不了成员模型——要换模型只能归档重建**（2026-10-01 第三轮换队的真实原因）：
   运行中的团队 `agent_teams_edit_plan` **只允许改 pending 且无 attempt 的任务**（依赖/描述/assignee），
   `update_member` 会被拒；成员模型只在 `add_member`（或 `create({plan})`）那一刻生效，**建完就固定**。
   因此用户要求换成员模型时：① 先确认在途工作已提交（本轮是快照 `23248f3`）——
   归档不会丢 git 里的东西，但**工作区里没提交的改动要自己先处理**；② `agent_teams_delete` 归档当前团队
   （任务与邮箱留档可查，不是删除）；③ 用同一套契约新建团队，**在 `add_member` 时显式给 `provider` 与 `model`**
   （本轮是 `opencode-go` + `deepseek-v4.1-flash`，取自 `.dsh/settings.yaml.imported` 的 `agent-default-model`），
   省略时会继承 captain 当时的模型。④ 新团队的任务编号会从 t1 重新开始，**别把两轮的 t1/t3 混为一谈**——
   引用时写清「第几轮」。
   **补充（2026-10-01 第四轮换来）**：① **provider 配额用尽也算「必须换模型」**——第三轮的 t13 死在
   `429 GoUsageLimitError`（opencode-go：Go usage limit exceeded），而**成员不会因为换个任务就恢复**：
   同一 provider 的所有成员都会连续 429。判据：失败回报里出现 `QUOTA` / `GoUsageLimitError` / 429，
   就**不要重试**，直接走上面的流程（先给在途工作做快照提交 → 归档 → 换 provider 重建），
   否则每重试一次只会在下游再堵一个任务。② **路由要以 web profile 的 `cordis.patch.yml` 为准**：
   里面 `agent-default-model` 才是真正生效的 provider 与 model（第四轮是 `commandcode` +
   `deepseek/deepseek-v4.1-flash`，`reasoningEffort: max`）；`.dsh/settings.yaml.imported` 可能仍是旧值，
   照它填会让成员跑在已经配额用尽的 provider 上。③ 重建前把**在途工作快照入库**：
   第三轮 t13 的改动（`tests/console/` 与 `scripts/eval-proactive-timeline.ts`）是绿的但未验收，
   快照提交为 `b7fb811`，新团队的承接任务从它继续。
