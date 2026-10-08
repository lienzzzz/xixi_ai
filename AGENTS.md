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

> **2026-10-07 起有两台机器**：下面这张表是**原 Windows 开发机**（`E:\worker2`，历史事实，仍然有效）；
> 仓库现在也在 **Linux / WSL2** 上跑（`/home/u24/projects/xixi_ai`）。Linux 侧的版本矩阵、
> 建 venv 的命令、移植挖出的平台假设缺陷与「这台机器上验不了的四类事」见
> [`docs/recon/linux-port-environment-2026-10-07.md`](docs/recon/linux-port-environment-2026-10-07.md)（**动手前先读**）。
> **真机设备（麦克风 / 扬声器 / 摄像头）在 WSL 里的拿法见该文 §7**：音频走 WSLg 的 Pulse 桥（缺
> `libportaudio2`），摄像头走 `usbipd` 直通（**前置条件是 WSL 侧先 `sudo modprobe vhci-hcd`**，
> 漏了它 attach 就没有落点）——两份各一条 sudo 命令，都不需要自编译内核。
> 跨平台纪律见 §10。
>
> **DSH 版本（2026-10-07 更正，Linux 侧生效）**：仓库原本钉 `@deepseek-ai/dsh-tools@0.1.7-rc.2`，
> 而全局 DSH 是 **`0.2.0-rc.2`**；两者不匹配时 DSH 会**跳过**工具插件 bundle，模型看不到任何 xixi 工具，
> `npm run verify:provider` 必失败（报「expected a tool call, saw null」）。现已把插件 `peerDependencies`
> 与根 devDependency 一并升到 **`0.2.0-rc.2`**，`install:profile` 与 `verify:provider` 实测通过。
> **纪律**：插件 `peerDependencies` 比的是 **dsh 运行时版本**（`@deepseek-ai/dsh-app-boot` 的
> `evaluatePluginCompatibility` 用 `semver.satisfies` 逐条判定），升级 DSH 时要**同时**改这一处与根 devDependency；
> 另注意 0.2.0 把 11 个 `@deepseek-ai/dsh-*` 升格为 peer，旧 lock 会 ERESOLVE——**不要用 `--legacy-peer-deps`**
> （会跳过全部 peer，`check:types` 崩），要**删 lock 全新解析**。详见 `docs/progress.md` §11。

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
npm run check:types      # 类型检查门禁（tsc --noEmit，无构建步骤；Node 24 仍直接跑 .ts）
                         #   V0.3 P0-C 起生效；CI 顺序＝**先 check:types 再 npm test**
                         #   tsconfig 覆盖 packages/apps/scripts/services/tests（155 个 .ts，--listFiles 可复核）
                         #   纪律：**不许用铺 any、ts-ignore、关 strict 或 exclude 难点文件换绿**；
                         #   抑制要写理由并列清单，启用 noUnusedLocals 暴露的死导入要顺手清掉
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
npm run verify:p2.5            # P2.5 真入口验收（V0.3 P2.5-K）：新闻 / 提醒跨重启 / 审批 / 关停四个场景
                               #   node scripts/verify-p2.5.ts；--offline 零费用不联网（README 与文档里引它时
                               #   写 npm run verify:p2.5 -- --offline）；--scenario=<news|reminder|approval|shutdown> 单跑
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
   **子规则（V0.3 P2 的 t4 与 t8 两次同类换来）：加迁移的任务，两处钉死「已发布迁移清单」的测试文件必须都进 inScope。**
   仓库里有**两处**把已发布迁移列表钉成字面量的断言：`tests/perception/world-state-projection.test.ts` **与**
   `tests/unit/domain.test.ts`。captain 在 P2 里**两次**写 inScope 时都只点名了前者（t4 加 `007_tool_approvals.sql`、
   t8 加 `008_reminders.sql`）：t4 那次只能靠 §9.2 披露收场，t8 这次则**直接把别人（t20）的收口挡住**——
   全队 `npm test` 唯一一条红就是它，而 t20 无法在自己的窗口里变绿。
   **纪律**：① **先 `git grep 'migrations'` / `git grep '004_memory'` 之类找出所有钉死点**，不要凭记忆写；
   ② 派单时把这两条路径**都**写进 inScope 与验收（`tests/perception/world-state-projection.test.ts` 与
   `tests/unit/domain.test.ts`）；③ 迁移号要**串行点名**（t4 的 007、t8 的 008），别让两条并行任务同时声称一个号。
   **同一纪律的推广（V0.3 P2 的 t6 换来）：凡是会改变「被钉死成字面量的集合」的任务，都要先找出所有钉死点。**
   已知的集合至少有三类：**内置工具集**（改它会让 MCP/插件/runtime-wiring 里断言「内置四个」的用例变红——t6 删
   `xixi_news_stub` 时工作区一度 3 条 MCP + 4 条 runtime-wiring 变红，t21 评审在自己的副本里把这些陈旧字面量中性化才继续）、
   **已发布迁移清单**（上面那两处）、**事件类型枚举**（`envelope.v1.json` + `schemas/events/*.json` + `contracts/src/events.ts` 三处同改）。
   **做法**：派单前 `git grep` 那个名字或那个计数（例如 `git grep -n 'xixi_news_stub'`、`git grep -n '=== 4'`），
   把命中**每一个**测试文件写进 inScope；评审要按同一份清单核对「陈旧字面量是否都跟着改了」。
   **amend 只替换你显式给出的字段**：把某个路径加进 inScope 之后，**必须同时检查 outOfScope 是否还禁止着它**
   （captain 本轮就把 `packages/conversation/src/engine.ts` 加进 inScope，却留着 outOfScope 里的 `packages/`，
   自相矛盾——成员会不知道该不该改）。**加完 inScope 要重读一遍整份契约。**
   **子规则（V0.3 P2 的 t6 第二次换来，captain 又犯一次）：给 inScope 打补丁要「追加」，不要「整份重写」。**
   t6 原本的 inScope 里有 `tests/unit/core/tool-loop.test.ts`、`tests/unit/core/tool-registry.test.ts`、
   `tests/console/field-test-console.test.ts` 三条，captain 为了修正另两条错误路径而**整份替换**了清单，
   把这三条挤掉；成员确实改了它们（删 `xixi_news_stub` 之后的新期望），于是完成校验报
   `tests/unit/core/tool-loop.test.ts is undeclared`、**任务卡住无法收口**（只能按 §9.2 在正文披露，由 captain 提交时补上）。
   **纪律**：amend 之前先把**当前** inScope 读出来（`agent_teams_status` 或上一次 amend 的回显），
   新清单 = **旧清单 ∪ 新路径 − 明确要删的**；改完**逐条回读**，并数一次条数（本次 20 条 → 期望 23 条）。
   **「加路径」永远不需要删路径**——若你发现自己在删路径，停下来问一句：那是我要收回许可，还是我把它读漏了？
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
   **子规则（V0.3 P2 的 t2 换来）：写 inScope 之前先确认「今天这个东西到底在哪个文件里」。**
   P2-A 的契约声明的是 `packages/runtime/src/tool-runtime.ts`，而 **ToolRegistry 实际在 `packages/brain-adapter/src/tool-registry.ts`**
   （现状地图 `docs/v03/P2_PLUGIN_GAP_MAP.md` 里有证据）——成员改了真位置，完成校验就把 3 条路径拒为 `is undeclared`，
   其中 2 条还先被 captain 的周期提交按**另一条任务**（t5）的名义收进了库，归属写错。
   **纪律**：① 先读现状地图（P0 的 `ACTUAL_RUNTIME_MAP`、P2 的 `P2_PLUGIN_GAP_MAP`）确认位置再写 inScope——
   **地图还没出的时候，不要把「需要靠它定位」的实现任务并行派出去**（这轮 t1 与 t2 并行就是这个代价）；
   ② 错位已经发生时，按 §9.2 披露 + 把这几条路径与「只应含预期改动」写成**下一次评审的显式核对项**，
   并把正确路径补进同一批后续任务的契约（t3/t6 就是这么补的）；
   ③ 两条任务若真的会写同一批文件，就用依赖串行——**别指望重叠校验替你发现**：
   它只比较**声明的路径**，不比较代码里真实的依赖（t2 与 t5 都写 brain-adapter 而校验器没拦，因为 t2 的 inScope 里没写 brain-adapter 的路径）。
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
   **子规则（V0.3 t22 那笔换来）：要用「白名单」，不要用「排除式过滤」。** captain 当时写的是
   「加上所有改动/未跟踪路径，**排除** `docs/` 与某个测试文件」，结果**漏掉了根目录的 `README.md`**——
   那是并发任务（t16）的在途文档产物，被夹进了 t22 的提交里。**并发工作区里排除法必漏**（根目录文件、
   别人新增的未跟踪文件、`.md` 之外的同名文件……）。正解：`git add` **显式列出本任务声明的每一个精确路径**
   （与 §9.25 ② 的「逐文件 inScope」同源），提交后再用 `git status` 确认没有多余条目进了暂存区。
   **一旦夹带，如实记账**：在自己的证据备注与给下游评审的消息里写明「该文件属于谁」，不要让它变成无主产物。
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
   **⑥ 红证必须对应「最终字节」**（V0.3 t19 主动做对的一件事）：如果成员在取证之后**又改过测试文件**
   （哪怕只是修类型、改断言写法），那么之前那份「修之前是红的」证据对应的就是**旧字节**——它证明的不是交付物。
   **正解**：对**最终字节**重跑那几处突变（t19 就是这样：修完两行类型后把判官那两处突变再跑一次），
   或者在回报里**逐项写明**每份红证对应的文件哈希；**测试文件未变的那几处不必重跑**（t19 明确写了
   「store.ts 那一处测试文件窗口后未改，红证继续有效」——这种逐项声明比笼统说「都验过」有用得多）。
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
   **子规则（V0.3 P2 的 t6/t11 换来）：不要写「全库 0 命中」这类验收条件——它要么必红、要么逼人删历史。**
   captain 给 t6 写的是「`xixi_news_stub` 命名删除（全库 0 命中）」，而 t11 实测该名字在仓库里有 **19 行/12 文件**：
   `AGENTS.md` 的历史教训 3 处、基线地图 9 处、回归断言 3 处、生产代码注释 3 处、当前态文档 4 处——**前几类都应当保留**
   （历史不许改写、地图是某一时点的证据、断言是防回潮），真正要改的只有那 4 处**当前态**文档。
   评审按 §9.13 判「功能要求成立（代码面零注册）、措辞未达」是对的。
   **正解**：把条件写成**可判定的形态**，例如「**没有任何代码路径注册/广告这个名字**」
   （`git grep -n "name: 'xixi_news_stub'"` 只应命中基线与注释），或在有条件的地方写成「**当前态文档与代码一致**」——
   永远不要用「全库 0 命中」把历史与证据一起判死。
22. **取消一个被依赖的任务会让整条下游链永久卡死——取消前先改接下游**（captain 本轮把全队冻住了）：
   依赖只在「已完成」时满足，**「已取消」不满足**。captain 按证据取消了 t11（提问率任务，前提被推翻），
   而 t13 依赖 t11 → t13 永远不可认领 → t15/t18/t19/t20 全部阻塞 → **五个成员全部空转、流水线冻结**，
   而 status 里看不出「为什么没人动」（只显示 pending）。
   **纪律**：取消任何任务前，先 `agent_teams_edit_plan` 把**所有**以它为依赖的待办任务改接到替代任务
   （或一并取消并重建）；改接完再取消。**判据**：取消后立刻看一次 status——若有 pending 任务而其依赖含
   取消态任务，就是冻结。
   本轮修法：把 t13 与 t15 合并成一条「回复管道」任务（同一位成员、同一批文件），
   再按正确依赖重建下游（t21→t22→t23/t24/t25），内容一字未丢。
   **补充（2026-10-01 第五轮换来）：依赖「失败」同样冻结下游，而运行期有三处硬限制，解药是 `amend_task`。**
   ① **失败的任务不满足依赖**：第五轮 t3（流式语音）判 failed 后，依赖它的 t4 永远不被派发——
   状态页只显示 `pending` 且成员空转（与取消同款）。② **运行期不能取消任务**：`edit_plan` 的 `remove_task`
   会被拒（提示 roster 与 removal 只能在 staged 计划里改），所以「先取消再重建」这条路走不通。
   ③ **依赖只能正向补**：校验器要求**被更新**的那个任务对自己重叠的每个任务声明依赖；若两者互相重叠、
   而对方已经依赖了你，补一条反向依赖就报 `cycle`——于是「删掉那条失败依赖」这个动作会被重叠校验挡住。
   **解药（本轮实测可行）**：用 **`agent_teams_amend_task`** 收窄其中一个任务的 `inScope`（**inScope 只有 amend 能改**），
   把重叠路径按**文件级**让给另一条线，**然后**再 `edit_plan` 改依赖就通过了。本轮实例：t4 与 t9 在
   `scripts/field-test.ts`、`scripts/serve-chat.ts`、`packages/conversation/src/`、`tests/unit/`、`tests/console/`
   上重叠 → 把 t4 的 `inScope` 收窄到领域层与提示词层的具体文件（控制台面板与 scripts 下的接线列为下一轮），
   t4 的依赖随即可以改成 `[t2, t1]`。
   **纪律**：任务判 failed 后**立刻**检查所有下游（`deps` 含它的待办任务）并改接；改接被重叠挡住就用 amend 收窄 inScope，
   并且**把切掉的部分写成下一轮候选**（本轮把「心情的控制台面板」记进 handoff），不要把范围收缩混同为降标准。
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
24. **「接线」类声明必须用调用图核对——字符串断言看不见它**（2026-10-01 第五轮换来，两次同类）：
   t5 复审发现 `speakStream` 只在类型与使用处出现、**没有任何 live 接线**，而状态接口已写 `ttsSegmented:true` 与「边生成边按句读切块」，
   被翻转的断言只钉文案 → **翻转后的断言钉住了一句与事实相反的话**；t12 复审在同一条线上发现 `playReplyAudio` **定义了却从未被调用**
   （回放仍走 standalone `new Audio`，于是 `xixiAudio.speaking` 恒 false、打断分支与提示语是死代码）。两次都不是成员撒谎，
   而是**断言没有覆盖「谁调用谁」**。**纪律**：① 声明「某能力已接入」时必须给一条**从入口出发**的断言——服务出去的页面里含该调用，
   且**禁止旧路径同时存在**（本轮最终断言「语音处理函数体内不得再有 standalone 拼接音频 + 全页只允许两处」）；不要只断言文案或类型存在。
   ② 评审核对「已接入」先读调用图（`git grep -n 被调函数名` 看它到底被谁调），再看断言——两次都是这么抓到的。
   **附带**：`--fake` 只替换大脑、ASR/TTS 仍连真实 socket，所以「真进程走 `/api/voice`」这类验收离线做不到；
   正解是给测试进程一个**本地桩端点**（t20 用内联 MiMo 桩 + `ttsBaseUrl` 做到了，代价是默认门禁多约 4.4 秒真实 VAD），
   这也让「线上把同一块发两遍」这种缺陷能被自动抓住，而不是靠人读代码。
25. **自动质量回路「升级」后的纪律、自动派生任务的契约杂质、以及计时断言先证明不抖**（同轮换来）：
   ① 评审连续判 needs_revision 到上限后，运行时会话置为 `escalated` 并提示「不要自行发明又一轮 needs_revision」——
   正确做法是 captain 把**选项与代价**摆给用户（本轮用户选「最小修 blocker 然后收口」，B2 与两处注释级问题转为已知问题），
   而不是继续派生修复轮。升级**不是停机**：成员仍可开工，只是不再自动加轮。
   ② 系统自动派生的 repair / review 任务（本轮 t11/t13/t16/t18）**契约里会混进非路径杂质**（`audio/wav`、`playedMs/droppedMs`、
   `recon/...`、缺前缀的 `voice_stream.ts`……）。成员的正确做法：**如实说明契约文本有杂质 + 在回报正文里列出逐文件清单**
   （t11/t13/t16/t18 都这么做了）；captain 收到后要**转成下一次评审的显式核对项**（已认领任务的 inScope 改不了）。
   **补充（V0.3 第五轮 t17 换来，更硬的一种杂质）：自动派生任务的 inScope 常常是一串「目录式」名字，而完成校验对
   `changedPaths` 用的是精确路径匹配——目录条目**不覆盖其下的文件**。** t17 的 inScope 里写着 `packages/runtime/`、`tests/console`
   之类的条目，于是验收条款点名要改的 `packages/conversation/src/engine.ts`、`packages/runtime/src/replay-runtime.ts`、
   `tests/console/canonical-store.test.ts` 等**全部落在允许范围外**：改了就在完成校验里报 `is undeclared`、不改又满足不了验收——
   **契约自相矛盾，成员六条验收全做完、`npm test` 520/520 全绿仍被判 failed**。
   **处置顺序（captain 本轮照此走通）**：① 先把「已完成且全绿」的产物**按文件提交入库**，别让成员重做；
   ② 用 `agent_teams_amend_task`（**它是唯一能改 inScope 的入口**，且对已重派的任务仍有效）把**逐文件真实路径**写进 inScope；
   ③ `agent_teams_reassign_task` 重派同一任务，让成员按修好的契约重新提交完成回报（实现无需改动）。
   **判据**：成员回报里出现「验收点名要改的文件不在 inScope」时，先按上述三步走，不要让它「改注释绕过」或「另开收尾任务」。
   **补充（V0.3 第五轮 t8 换来）：amend 到「已认领、正在跑」的任务上的验收，成员不一定会重读——必须同时发消息告知。**
   t8 认领之后 captain 用 `amend_task` 把「为 t7 类型检查抓出的三个真缺陷各补一条回归测试」写进它的验收，
   但成员没有再读契约、按旧验收回报，那三条测试**从未落地**（t10 复审独立发现「`transitionOpenThread` 省略 `at`」至今无用例守着，
   旧写法回潮门禁不会红）。**纪律**：① amend 之后**立刻给该成员发一条消息**，写明「契约已改、请重读验收再回报」；
   ② 若它已经按旧验收回报完成，**不要假设 amend 生效**——按 §9.5 另开收尾任务（或至少写进 handoff 的下一轮清单，标明是谁发现的），
   ③ 派单方在 amend 后回读一次 `acceptance` 与 `inScope`，确认落到了存储里（本条与 §9.16 的「回读条数」是同一条纪律的两个方向）。
   ③ **计时断言先证明不抖再提交**：本轮一条「两个 `started` 时间戳谁先」的断言在 12 次里红 6 次（同毫秒即红，成员那次全绿是运气）。
   凡拿 `Date.now()` 比较当断言，必须先连跑 ≥10 次；正解是改用**次序证据**（自增序号）+
   把重叠证据建立在**有真实间隔的实验输入**上（本轮改成「第 1 块持 320 ms、第 2 块 1 ms」，串行管道必红）。
   **只看一次运行会误判**——同一轮里 captain 看到 1 红 1 绿、评审看到 1 绿 3 红。
   **④ 顺序断言不许依赖「未指定的并列裁决」**（V0.3 P2 的 t7 换来，与 ③ 是同一条纪律的另一面）：
   t7 写「同分行顺序」的用例时**两跑两序**——因为 `MemoryStore.recordSemantic` 的输入**没有 `updatedAt`**
   （落库时间一律由 store 的 `now` 给），并列时按 `candidate.id` 兜底，而出厂 id 是 `sem_${randomUUID()}`
   → **同分行的顺序天然会抖**。**纪律**：凡断言「A 在 B 前面」，先问清**排序键是否唯一**；
   并列存在时要么**显式指定 id**（t7 的正解：给 `memoryId`）、要么把断言改成**集合相等**或**次序证据**
   （自增序号），不要拿一次运行的偶然顺序当期望值——它与 ③ 的区别只是：③ 是时间戳同毫秒，这条是排序键同分。
   **⑤ 恒假或恒真的守卫等同死代码——每个守卫都要有一条证明它在坏输入下会拦的用例**（V0.3 两轮里同一模式出现两次）：
   ① t14 评审发现出口闸门 `renderGate`（负责拦参数名那一类）**没有任何用例够得到它**——把它改成恒真后 568 项仍全绿，
   而它的存在理由（程序生成的文本可能带参数名）是真的；② t15 复验发现提取器里 `statement.includes('？')` 这个守卫
   **条件恒为假**（字符类已把问号排除、`match[0]` 永远不含它），而文件自己写着「规则是给非疑问用的」，
   后果是疑问句被写成 0.9 置信度的偏好事实（`你还记得我喜欢喝什么茶吗？` → `我喜欢喝什么茶吗`），
   且 `git log -S` 显示它随第三轮 `1efc8b3` 就在、P1 只是放大了后果。
   **纪律**：写守卫/闸门时，**同时**写一条「坏输入必须被拦」的用例（反事实会红），并在注释里写明它拦什么、不拦什么；
   若某条守卫的条件在当前实现下**不可能为真**（或不可能为假），那就是缺陷而不是防御——按缺陷修。
   **恒假守卫与「有测试但没测试到它」是同一类问题的两面**：都让防线在纸面上存在、在事实上失效。
   **⑥ 断言「不依赖机器环境」之前，先确认本机环境是否恰好等于被断言的那个值**（V0.3 P2 的 t24 换来，
   与 ③ 计时、④ 顺序并列的第三种「环境依赖型假守卫」）：t24 要证明「时刻解析不会偷偷改用机器时区」，
   但**本机时区恰好就是被测的 `Asia/Shanghai`**——只钉上海落点的话，一个忽略请求时区、改用机器时区的实现
   会**侥幸全绿**（本机跑不出任何区别）。它的解法：在**同一个用例里**把**同一个瞬间**按**第二个时区**再解析一次
   （上海 `2026-10-06T08:00+08:00` 对纽约 `2026-10-05T08:00-04:00`，两者日历日不同），于是「改用机器时区」
   这个突变在**不设 TZ 的正常机器上**就会红，不再依赖跑测试的人恰好不在该时区。
   **纪律**：写这类断言时先问「**这台机器上，错误实现会不会也通过？**」——若会，就在用例内部**换一个环境值再算一次**
   （时区、locale、货币、路径分隔符、行尾、随机种子都算），而不是靠 `TZ=...` 这类外部开关（它只在记得设的时候才生效）。
26. **Command Code API 的连接类错误不要当任务失败——等约 1 分钟再重试**（2026-10-04 用户指示）：
   用户明确：遇到 Command Code API 错误（`ENOTFOUND api.commandcode.ai`、`fetch failed`、插件自动重试 5 次后放弃、偶发 502 或超时）
   **很可能只是服务端压力大或网络抖动**，正确处置是**等约 1 分钟，再用 `agent_teams_reassign_task` 重派同一个任务给同一位成员**。
   **判据**：失败回报里出现的是**环境/传输字样**（`ENOTFOUND`、`fetch failed`、`ECONNRESET`、`socket hang up`、`已停止重试`）
   而不是契约或实现证据时，**不要**走 §9.5 的「另开收尾任务」流程，也**不要**换 provider——那两条是给真的实现失败或配额用尽（§9.23 ①）留的。
   处置顺序：① 先核现场（`git status` 看它的半成品还在不在、`git log` 看基线）；② 自己核一次网络（直连与代理各一次，例如
   `Test-NetConnection api.commandcode.ai -Port 443` 与 `Invoke-WebRequest -Proxy http://127.0.0.1:7890`）；
   ③ 重派并在理由里写明「按工作区现状继续、不要回退已完成的搬运」以及上一位踩过的坑。
   **本轮实例（t5）**：成员会话在一次传输失败后掉线、任务被自动判 failed，但工作区里它的 5 个新文件与 6 个改动都还在——
   重派后接着干，而不是重来。**只有同一 provider 跨多个成员连续失败**才考虑换 provider；
   **若反复出现，用户侧动作**是在**启动 DSH 的那个终端**里导出 `HTTPS_PROXY`/`HTTP_PROXY` 再重启 DSH
   （DSH 只读环境变量，不读 Windows 系统代理/PAC）。

## 10. 跨平台纪律（2026-10-07 起：仓库同时在 Windows 与 Linux 上跑）

移植到 Linux 时，**没有一条测试为「Windows 专属假设」变红**——挖出来的五个缺陷全是
「在原机器上永远看不见」的形态（详见 [`docs/recon/linux-port-environment-2026-10-07.md`](docs/recon/linux-port-environment-2026-10-07.md)）。
下次再换机器/换平台时，按这四条自查：

1. **判断「绝对路径」用 `node:path` 的 `isAbsolute` / `resolve`，不要手写启发式。**
   反例：`file.includes(':') || file.startsWith('.')` —— 这是「Windows 盘符」的判据，
   `/tmp/x.wav` 在它眼里是相对路径，于是被拼到仓库根后面，报一个**看起来像临时目录坏了**的 `ENOENT`。
2. **解释器与工具路径要按布局探测，不要写死一个平台的形态。**
   Windows 是 `.venvs/<name>/Scripts/python.exe`，POSIX 是 `.venvs/<name>/bin/python3`；
   npm 的全局包 Windows 在 `<prefix>/node_modules/`，POSIX 在 `<prefix>/lib/node_modules/`。
   **仓库里只能有一份解析实现**（今天是 `scripts/lib/harness.ts` 的 `resolvePython` /
   `pythonCandidates` / `pythonCandidateHint`，以及 `apps/brain-dsh/src/transport.ts` 的
   `resolveDshBinJs`，`scripts/install-dsh-profile.ts` 复用它）——写第二份拷贝就是下次漂移的起点。
3. **测试不许依赖 gitignored 的运行产物，更不许因为缺它就静默 skip。**
   `data/` 里的勘测图片与录音、`data/recon/ambient-5s.wav` 这类文件**只存在于跑过勘测的那台机器**上；
   断言要么自己造夹具（用 Python 标准库写 WAV 是个好例子），要么把下界写成「有条件才要求」。
   **静默 skip 比红更危险**：`npm test` 末行是绿的，而那几块根本没被测。
4. **种子数据里写死绝对日期 + 判定读 `Date.now()` = 定时炸弹**（与 §9.25 ③④ 同源，形态是新的第三种）：
   绿是因为「今天还没过期」，两天后自己变红。凡时间驱动的状态机（未完话题的
   `followupWindowHours` 就是 48 小时），测试要么**注入时钟**（入口已有 `now` / `clock` 接缝），
   要么把种子时间**相对当前时间**生成。**判据**：这条用例放到 30 天后跑还绿吗？
