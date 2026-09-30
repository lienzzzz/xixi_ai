# 西西（Xixi）项目协作约定

> 本文件是给编码 Agent 和后续维护者的**约束文件**，优先级高于任何单次对话指令。
> 方案正文见 [`xixi_ai_companion_project_plan.md`](xixi_ai_companion_project_plan.md)。

## 0. 项目一句话

西西是长期常驻家庭环境的陪伴智能体：能判断该不该说话、记得住长期关系、人格可被自然语言缓慢塑造、重启后仍是同一个西西。
**它不是带摄像头的聊天机器人。** 可替换的部分是模型 / ASR / TTS / 摄像头 / Harness；不可替换的是长期状态与行为策略。

## 1. 铁律（不可违反）

1. 模型只做「理解与判断」，规则、状态与边界由程序负责。
2. 不允许模型自行修改核心提示词、权限、隐私策略、费用上限或本文件；人格调整只能产生**受控、可回滚、有记录**的变化。
3. 主动行为必须先过确定性硬门禁（静默时段 / 冷却 / 当日额度 / 重复话题 / 对话冲突 / 置信度），LLM 不能绕过。
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
                         #   项数与耗时**以实跑输出为准**：空载约 27–30s，成员并发时可达 45s+
                         #   关键路径是单文件 frontend.test.ts（约 21s，内含多次 Python VAD 子进程启动）
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
2. **契约校验只核对成员「声明」的 changedPaths**：未声明的越界编辑**不会**被自动拦截（t4 的 `package.json`、`scripts/voice-turn.ts` 就是这样绕过的）。
   因此唯一防线是：成员**如实披露** inScope 外的改动 + 评审**逐条复核**这些披露。
3. **多任务不要声明同一路径**：并发写同一文件会互相覆盖（`docs/progress.md`、`tests/`、`package.json` 都踩过）。
   约定：进度文档由集成任务**单写**，其他成员把可直接粘贴的段落写进**完成回报**；测试按子目录分（`tests/unit/voice/`、`tests/unit/core/`、`tests/perception/`、`tests/console/`）。
4. **队长所有的文件成员不得直接改**：`AGENTS.md`、`xixi_ai_companion_project_plan.md`、`.agent-teams/`（后者已 gitignore）。成员提出建议，由 captain 落笔。
5. **任务 failed 后契约是终态、不可 amend**：正确做法是**另开收尾任务**并把下游依赖改接到它（本轮 `t12 → t14`、`t2 → t17`），
   而不是让成员回滚质量或绕过门禁。收尾任务的回报必须写明「原任务失败的归因」与「本次只做补正/核实」。
6. **验收命令必须是改完之后真实存在的命令**；需要新脚本时，把它写进 deliverables，否则 `verify` 无法执行。
7. **每次提交前先跑 `npm test` 与 `npm run check:docs`，并把实测结果写进提交信息**——本轮出现过提交信息声称「全绿」而实际 1 项失败的情况（因为把成员在途的半成品一起提交了）。
8. **不要用 PowerShell 做批量文本替换/往返读写**：本轮实测它会把 UTF-8 中文写坏（出现 `U+FFFD` 替换字符，直接毁掉源文件）。
   要批量改文本请用编辑工具，或 Python 显式 `encoding='utf-8'` 读写；改完 `git diff --stat` 自检异常体积。
9. **默认门禁必须保持快（目标 <25s）**：重的端到端断言要**缩小输入**（单档 tier、最小夹具子集）来提速，
   **不许靠删断言或把测试挪出默认门禁**来换速度——「测试写了就必须跑」是本项目已经踩过坑的原则。
10. **全量测试结果要在成员在途编辑窗口之外判读**：本轮多次出现「红 1 项」实为他人半成品（失败用例名每次不同、stash 后仍失败即可判定）。
   声明「全绿」时必须带**修订号**与实测输出，否则视为未验证。
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
16. **长文本会被截断——派单与回报都要短句**：本轮实测两处——
   ① t31 收到的任务文本被拼接/误解析（验收 5 条变 3 条、inScope 混入非路径片段）；
   ② t33 的完成回报因 payload 被截断（缺 task_id）**整份被拒**，只能重发。
   **做法**：验收条目写短句；`evidence`/`commandsRun` 的 evidence 字段保持一句话；
   路径与编号集中放在 `inScope`/`deliverables`；不要把长表格塞进契约字段。
17. **同一个事实可能有三份不同的说法——以代码为准**：t33 面对「`appendEvent` 有几个调用点」，
   发现**文档写 2 个、评审说 3 个、代码实际 4 个**，且其中一处写入在引擎层、另有一条**绕过 `appendEvent`
   直接写库**的 Python 路径（感知边）。**遇到分歧就去读代码并给出文件与行号**，然后同时更正文档与评审结论。
18. **修漂移时不要制造新的漂移源**：写死计数（自检项数、测试项数、文档条数）必然再次过期；
   新增一个自检项还会连带要求三份文档同步。
   t37 的正解：把新断言**并进既有自检项**（项数不变），并在 `--help` 里**不写死数字**（改为「看末行结果」）。
   **原则**：能推导的就别写死；能用一次运行输出的，就别复制到三处文档。
19. **`acceptance` 数组最多 3 条、每条一句话（硬约束）**：本轮 **t31 与 t38 两次**被成员报告「收到的派单把
   acceptance 截断/改写成 3 条」，两次都是因为 captain 往数组里塞了 5~7 条长句，且句中带数字列表
   （如 `104/128/−64/96`）与文件名——正是 §9.15 禁止的形态。
   **正确写法**：`acceptance` 只放 3 条以内的短句（它是完成校验的对照表）；把逐项对齐细节写成
   `description` 里的一段散文；**所有路径只出现在 `inScope`/`deliverables`**。
   成员若发现收到的文本与真实契约不符，仍按 §9.12 核对后在回报里说明——但 captain 应先不制造这种局面。
