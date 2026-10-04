# 西西（Xixi）

> 仓库：[github.com/lienzzzz/xixi_ai](https://github.com/lienzzzz/xixi_ai)

长期常驻家庭环境的陪伴智能体。**它不是带摄像头的聊天机器人**：**可替换**的是模型 / ASR / TTS / 摄像头 / Harness，
**不可替换**的是长期状态与行为策略（WorldState、Memory、FutureHook、SelfModel、RelationshipModel、
RoutineModel、Proactive policy、Conversation state）。

当前进度（2026-10-03，第五轮收口）：**M0 文本 Harness 已验收；噪声鲁棒语音前端、摄像头在场检测（M6）、
现场测试控制台、主动开口（主动性 V2：硬底线 + 模型读空气）、多段回复与 pack Phase 8 的流式语音输出均已落地**；
「真人感」改造（提示词改成「身份与说话方式」、回复容量 180 → 480 字、制品清洗）已落地并有**同口径的前后对比**
（见 [`docs/benchmarks/realism-metrics.md`](docs/benchmarks/realism-metrics.md)）；
第五轮新增**有界的心情状态**（短期的情绪，权重远小于人格：语气 ±6%、主动性软偏移 ±0.03、硬底线拿不到它，
见 [`docs/adr/0013`](docs/adr/0013-bounded-mood-state.md)）；
**流式语音的首音目标（pack 的 ≤1.5 秒）没有达标，而且本机栈下不可达**（8 批 n=32 实测 ④ / 1500 ms = **[3.14, 7.33] 倍**、池化 3.73 倍、**没有一批接近**；
这是**目标不可达**，不是实现缺陷，见 [`docs/progress.md`](docs/progress.md) §2.20 ③）；
**长期记忆与人格学习（M3/M4）已由 pack Phase 4 落地**（逐入口覆盖与权重口径见 [`docs/progress.md`](docs/progress.md) §2.19），
唤醒词（M2）与完整 M5（事件回放）尚未开始。

> 完整设计与实施方案见 [`xixi_ai_companion_project_plan.md`](xixi_ai_companion_project_plan.md)；
> 编码约定见 [`AGENTS.md`](AGENTS.md)；**接手顺序**见 [`docs/README.md`](docs/README.md)（文档地图）
> 与 [`docs/handoff.md`](docs/handoff.md)（现状、自证、坑、下一步）；进度与已知限制见 [`docs/progress.md`](docs/progress.md)。

## 快速开始

需要 **Node.js 24**（本仓库用 Node 原生类型擦除直接运行 `.ts`，**没有构建步骤**）。

```powershell
npm install                                   # workspace 链接 + js-yaml + dsh-tools
node scripts/install-dsh-profile.ts           # 装项目内 DSH profile（.dsh/），幂等
Copy-Item .env.example .env                   # 填入 MIMO_API_KEY（.env 已被 gitignore，绝不提交）

npm test                                      # 全部离线测试（不花 API 费用）
                                              #   项数以末行为准（不写死数字）
npm run field-test                            # 👉 现场测试控制台：http://127.0.0.1:8792
```

现场测试控制台是**三栏**布局：**左＝传感器**（摄像头实时画面、在场判定、麦克风电平与噪声底、设备读数、当前库路径）
**中＝配置**（主动性强度、话痨程度、冷却与额度与静默时段与触发源、TTS 开关、摄像头开关、循环间隔）
**右＝对话记录**（含标注「主动开口」的条目）。点「**启用**」= 起摄像头在场检测 + 常驻考虑循环并**立刻先考虑一次**；
点「停用」子进程会退出。

```powershell
npm run field-test -- --offline            # 没有密钥也能看页面与跑设备自检（ASR/模型用替身）
npm run field-test -- --data-dir data/field-test-alt
                                           # 换控制台自己的库；在场状态用 --presence-data-dir（默认 data）；
                                           # 不认识的参数会中文报错并 exit 2（不会静默忽略）
node scripts/field-test.ts --self-test     # 离线自检（不碰硬件；项数以末行「自检结果：N 项通过」为准）
node scripts/field-test.ts --acceptance    # 只跑一次真机验收，重写 docs/recon/field-test-report-<日期>.md

npm run web                                # 试用对话页：http://127.0.0.1:8791（含按住🎤语音输入）
npm run chat                               # 终端对话（直连 MiMo 实时路径）
npm run chat -- --personality verbosity=0.1,talkativeness=0.2
                                           # 人格的持久化行政覆盖（写 self_profile + history，重启仍生效，
                                           # 但**不跨入口**；详见 docs/design/domain-model.md §6）
npm run voice:turn -- --wav tests/audio-fixtures/direct-question.wav   # 语音闭环
npm run voice:bargein                      # 打断判定延迟（纯本地）
npm run voice:noise                        # 噪声鲁棒性回归（会花钱）；--fake 只验管线
npm run verify:provider                    # 一次真实调用：验证 MiMo 路由与工具调用
npm run verify:m0                          # M0 验收：真实两进程重启恢复
npm run eval:conversation:judge            # 对话质量评测（含评审模型）
```

需要外网时可能要走代理：`$env:HTTPS_PROXY='http://127.0.0.1:7890'`、`$env:NODE_USE_ENV_PROXY='1'`。

## 已验证的范围（每条都有可重跑的证据）

| 能力 | 证据 |
|---|---|
| 文字 → DSH → MiMo → 结构化工具调用 → 回答 | `npm run verify:provider`：一次真实调用，`xixi_get_current_time` 被真实调用 |
| 重启 → 会话恢复 | `npm run verify:m0`：**两个独立进程**，第二个逐字复现了第一个的回答 |
| 事件契约与 fail-closed 校验 | `npm test`：未知字段、越界置信度、版本不符一律拒绝 |
| 持久化与迁移 | `npm test`：迁移幂等；已应用迁移被改写则拒绝启动；重复事件被拒 |
| 人格基线持久化 | 重启只补缺不覆盖（§33「重启后持久人格恢复 100%」） |
| **噪声鲁棒语音前端** | 去直流 + 120 Hz 零相位高通 + 噪声底自适应门限；`npm run voice:noise`：**SNR ≥ 3 dB 时 4 条夹具全部检出、平均字符相似度 0.805** |
| **摄像头在场检测（M6）** | `node scripts/verify-camera-presence.ts --seconds 20`：本地抓帧 → 帧差动 + YuNet → `presence.changed` + world_state 投影；真机 640×480 约 39 fps |
| **多段回复（ADR-0010）** | `segments.ts` 纯函数分段器（**最多 8 段、块长 ≤60 字 → 容量 480 字**，段间 250–1200ms 默认 450；容量内每段 ≤60，`>8` 组时尾段合并并置 `mergedOverflow`，**该段可超 60**——反例 279 字 → 8 段、最长 62）；文字与播放计划真按段；**语音出口另有一条流式切块的路**（见下面一行） |
| **流式语音输出（pack Phase 8）** | **接线成立 + B1 已修 + B2 是已知未覆盖缺陷**（**不得写成「流式逐块播放已验收」**）：模型 token 流 → `ClauseChunker` 按句读切块 → TTS 队列逐块合成 → 浏览器逐块播（`onClause` 接缝，两条页面共用 `scripts/field-test.ts` 的路径）。实测（8 批 n=32）：**首音目标 ≤1.5 s 未达标且本机不可达**——④ / 1500 ms 逐批 **[3.14, 7.33] 倍**、池化 3.73 倍、没有一批接近；④ 的下界由 ② 模型首 token（逐批 P50 903.5–8162.5 ms）与 ③ 首段合成（逐批 P50 1393–2582.5 ms）挡住。复算：`node scripts/voice-turn.ts --compare <产物…>`（不调 API）。口径与切块规则见 [`docs/design/voice.md`](docs/design/voice.md) §6 |
| **有界的心情状态（第五轮 t4）** | 两个**有界**标量（valence / energy）+ 8 条封闭信号，由原始事件演化、按小时回落；注入提示词的是**散文**（数值只进 `sections[].debug`）；影响轻微（语气 ±6%、主动性软偏移 ±0.03）且**硬底线拿不到它**；可查看 / 可复位（复位留一行 `reset=true`）。独立复算：0 越界、语气 ∈[0.94,1.06]、软偏移 ∈[±0.03]、门禁同码、散文无数字与经历句式。见 [`docs/adr/0013`](docs/adr/0013-bounded-mood-state.md) |
| **主动开口（ADR-0009 + ADR-0011）** | **两层**：硬底线（静默时段 / 6h 与当日**次数**额度 / DND / 隐私与同意 / 场景与音频路径）由程序判定，模型不能绕过；底线之上**由模型读空气决定说不说**，确定性社会预算只给候选与建议（`BELOW_RECOMMENDATION` 是建议不是否决）+ `proactive.decision` 审计 + 先记后播。**金额级费用上限尚未实现**（次数额度是当前的费用代理）。**口径已定＝显著降频**（不做「连续两次没回应后 = 0」的硬停，[`docs/adr/0011`](docs/adr/0011-proactive-decision-ownership.md) 决定 2 的补充）；多日验收 `node scripts/eval-proactive-timeline.ts`（三天、M1–M6 进退出码） |
| **不编造可核查的事实** | 提示词 `HARD_POLICY` 的「可核查的具体事实」那条（关键词锚点，不再按编号引用）+ 引擎层闸门（无工具却出现具体数值就扣住并改说修复句）；台账核对「含具体值的轮次都伴随工具调用」 |
| **制品清洗（`REPLY_HYGIENE`）** | 工具调用标记与外文推理在进 TTS / 日志 / 工作记忆前被程序剔除（`sanitizeSpokenReply`）；整轮只剩制品 → 沉默，并写原因码 **`ARTIFACT_ONLY_REPLY`**（与「模型自己选择沉默」`MODEL_SILENCE` 可区分）。`REPLY_HYGIENE` / `UNBACKED_FACT_CLAIM` 两类 `onNotice` 审计通知已被**试用页（`serve-chat.ts`）与现场测试控制台（`field-test.ts`）**订阅并在页面显示；文字 CLI（`chat.ts`）与语音轮次（`voice-turn.ts`）未订阅（逐入口清单见 `docs/progress.md` §4） |
| **工具链覆盖（逐入口）** | `scripts/field-test.ts` 的 `buildToolChain()` 是唯一出口（注册表**现在是三个内置工具**：时间 / 天气 / 提醒——V0.3 P2-D 起新闻桩已删除，新闻改由 `packages/plugins/news/` 的三个插件工具提供；插件与 MCP 的工具在装配点上经 `mountPluginTools()` 复制进同一个注册表，权限、轮次上限与超时都不变；**四个 live 入口还没走 `buildPluginRuntime`**）。四个 live 入口——文字 CLI `scripts/chat.ts`、设备自检 `scripts/voice-device-check.ts`、真人感评测 `scripts/eval-realism.ts`、对话评测 `scripts/eval-conversation.ts`——已改用它（此前只有控制台走这条链）；离线自证是每个入口的 `--print-wiring`（打印 `{entry,language,maxToolRounds,tools,permissions}` 后退出，不调模型、不建库）。设备自检没有离线端到端证据（需真实 WAV + 硬件 + 真实 ASR），见 `docs/progress.md` §2.10 |
| **「看一眼」（视觉）** | `UserTurnInput.images` → OpenAI 风格 `image_url`（data URL）；真机实测能描述画面内容；DSH 路径发不了图时**明确报错**而不是静默丢图 |
| 质量过程 | `npm test` 全绿（**项数以末行为准**）；[`docs/review/`](docs/review/) 有评审报告（含复审与再复审），[`docs/verification/`](docs/verification/) 有独立验证报告，[`docs/benchmarks/`](docs/benchmarks/realism-metrics.md) 有可重跑的基准与前后对比 |

## 「真人感」改造成什么样了（含前后对比）

改造前（V0.1）的病征是「每轮都像客服」：稳定前缀是一张编号规则清单（还带着 `verbosity=0.4` 这样的裸参数），
一轮最多 3 段 × 60 字，长解释被挤成 2–3 大块（实测单段最长 **341 字**），同一句话反复收尾。
改造后（P1，2026-10-01）：前缀换成**「身份与说话方式」的散文**（0 条编号）+ 一段紧凑的安全边界，
回复容量 **180 → 480 字**（8 段 × 块长 60），工具标记与英文推理在**程序层**被剔除。

**同一批语料、同一工具、同一口径**的前后对比（口径定义与完整数字见 [`docs/benchmarks/realism-metrics.md`](docs/benchmarks/realism-metrics.md)）：

| 指标（84 轮语料） | 改造前 V0.1 | 改造后 |
|---|---:|---:|
| 提问率（**主口径**＝末句以问号收尾；分母只算她真正说出来的轮，程序写的修复句与沉默都不进分母） | **45.8%**（33/72） | **46.0%**（29/63） |
| 交付分段的最长单段 | **341 字** | **170 字** |
| 「AI 套话」词表出现率 | 0% | 0% |
| 三次重复的提问率均值 | 46.2%（**n=3**，极差 30.3pt） | 46.0%（**n=3**，极差 4.7pt） |
| 20 轮同一输入里的复述（逐字重复句 / 重复短语） | 有（「了，量完血压」出现在 3 轮） | **0** |

**怎么自己复跑**（前两条不花钱，读的是已捕获的转录；第三条是真实现场重跑）：

```powershell
node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-10-01-v02-wip.json   # 改造后
node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-10-01-v01-vanilla.json # 改造前（同语料）
node scripts/eval-realism.ts --corpus=all --repeat=3 --label v02                          # 现场重跑（真实调用）
```

**亲耳亲眼看**：终端里 `npm run chat` 连聊 20 轮；改造前的同一批输入原文留在
[`docs/benchmarks/v01/raw-chat-real-20turns.txt`](docs/benchmarks/v01/raw-chat-real-20turns.txt)，
现在用同一批输入重跑的命令是
`node scripts/chat.ts < docs/benchmarks/v01/input-chat-20turns.txt`（真实调用），
输出再用 `node scripts/benchmarks/v01-text-metrics.ts <输出文件>` 量长度与复述。

**还没到位的（别当成已完成）**：提问率主口径两次都在 46% 左右，**贴着 30–50% 的上沿**；
把全部 10 次捕获算进来，主口径极差是 **15.8%–63.2%（跨带）**，跨带来自输入差异——
**「落在 30–50%」只在「同语料重复」的前提下成立**；「程序剔掉制品导致沉默」在试用页与控制台上已可区分
（`ARTIFACT_ONLY_REPLY` vs `MODEL_SILENCE`），文字 CLI 与语音轮次仍未订阅 `onNotice`（见 [`docs/progress.md`](docs/progress.md) §4）。

## 现场测试前须知（已知限制，先说清楚）

1. **一次只能有一个入口点「启用」**：摄像头同一时刻只能被一个进程占用，后到的会失败并给出中文原因。
2. **摄像头可能交不出画面**：本机实测过一次「驱动暂时不返回图像」（不是光照也不是遮挡，后来自行恢复）。
   页面会明确显示「摄像头交不出画面（不是房间没人）」并给出三步排查；
   自查命令：`python -m perception_edge.run --probe-frames 10`（在 `services/perception-edge` 下跑）。
3. **麦克风噪声是首要风险**：本机实测噪声 **94.6% 的功率在 100 Hz 以下**（低频轰鸣），
   120 Hz 高通已削掉约 **21.4 dB**；说话频段本身不差。**减少低频轰鸣（关风扇/空调、垫高机身、用外接麦克风）比调软件更有效。**
   控制台里每次录音都能**回放并显示峰值 dBFS**，用来判断「未识别到」是没录上、太轻还是识别错。
4. **「看一眼」会上传一张静帧**：按需单张（不是连续视频），**默认只允许手动触发**，每次上传留一条审计
   （时间/尺寸/字节/结果，**不含图像**），图像不落盘。要它自主看需另开一个默认关的开关。
5. **household 入口默认连同一个库**（V0.3 P0-B 改了默认值）：`XIXI_DATA_DIR`，未设就是 `data/xixi`——
   `chat`、试用页、`voice-turn`、现场测试控制台与感知入库都走它（优先级：显式参数 > `XIXI_DATA_DIR` > 单入口旧变量 > 默认）。
   `voice-turn` 是测量工具，**默认连 household 库**，只有 `--isolated-store` 才用自己的库；控制台仍可用 `--data-dir` 单独隔离。
   **在 chat 里设的人格与历史，现在会带到其它入口。**
6. **试用页没有实时画面与「看一眼」**（只有控制台有）。
7. **已知取舍**：四位数温度只匹配后三位（拦截方向安全）；无数值的天气结论（「天气预报说今天适合出门」）不拦
   ——收紧误伤边界时必须放弃这类，否则会连带拦掉「朋友说要来吃饭」这种家常话。

## 隐私与密钥

- **密钥只放 `.env`（已被 gitignore），绝不提交**。`.env.example` 只是模板。
  推送前可自查：仓库里**没有任何被跟踪的文件或历史提交**包含密钥（本仓库已用「读 `.env` 再全历史比对」的方式核对过）。
- **`data/` 不提交**（数据库、录音、模型文件、现场证据都在这里）。
- **`tests/audio-fixtures/noisy/*.wav` 含真实房间的实测环境噪声**（与 TTS 生成的中文语音混合，**不含真人说话**）。
  介意的话可用 `python -m voice_edge.make_noise_fixtures --force` 换成本机自己的噪声重新生成
  （重新生成会改变夹具内容，`docs/design/voice.md` 里的实测数字需要同步重测）。
- 连续音视频不上云：摄像头帧只在本机内存里用于本地检测与页面显示；只有「看一眼」会按需发一张静帧。
- 不存模型私有推理，只存 `reason_code` 与分数（铁律 5）。

## 仓库结构（当前实际存在）

```text
packages/contracts/       事件信封与 payload schema（xixi.event.v1），所有服务共用
packages/domain/          唯一写 SQLite 的包：事件日志、会话、人格基线、world_state、工具审批（迁移 007）、durable 提醒（迁移 008）、迁移执行器
packages/context/         上下文装配（V0.3 P1）：ContextBuilder、MemoryRetriever、记忆纠正闭环
packages/conversation/    对话引擎：FSM、提示词组装、分段器（ADR-0010）、主动引擎（ADR-0009）
packages/brain-adapter/   TurnModelProvider 三接口（+ Multimodal / StructuredInference 两个可选面）+ Mimo/Dsh/Fake 三套实现 + 工具注册表
packages/model-adapters/  MiMo 直连适配器（含图像 image_url 构造）
packages/plugins/         插件内核（manifest / 五能力 / 九步生命周期 / 四条「插件不能做」）；子路径 ./mcp（SDK v2 客户端适配器）与 ./news（真实 News 插件）
packages/runtime/         生产装配（V0.3 P0-A）：工具链与 buildPluginRuntime、工具审批宿主、durable 提醒调度、常驻考虑循环、语音缝、感知入库
apps/brain-dsh/           DSH 侧接线：profile patch（MiMo 路由）与 CLI transport
plugins/xixi-tools/       西西最小工具集（含 xixi_get_current_time / 天气等）
services/voice-edge/      语音前端（Python）：去直流 + 高通 + 门限 + 校准 + 噪声夹具生成
services/perception-edge/ 在场检测（Python）：DSHOW 抓帧 → 帧差动 + YuNet → presence 事件
config/                   xixi.example.yaml（方案 §42）
scripts/                  安装、验收、演示与现场测试控制台（field-test.ts 是控制台入口）
tests/                    unit / integration / perception / console / scenarios / replay
docs/                     README（地图）、architecture、event-contracts、testing、progress、
                          progress-v03（按 Phase 的交付与遗留）、handoff、design/、adr/、recon/、review/、verification/、benchmarks/
```

## 设计要点

- **Harness 隔离**：只有 `packages/brain-adapter` 与 `apps/brain-dsh` 知道 DSH 存在；其余代码只看到领域词汇（铁律 9）。
- **事件日志是唯一事实来源**：对话轮次就是 `conversation.turn` 事件，不另建表，避免同一事实两份真相。
- **持久人格是「恢复」不是「重置」**：每次启动只补缺失的属性，已有值永不覆盖。
- **模型只做判断，规则由程序负责**：主动开口的**硬底线**（静默时段 / 额度 / 隐私 / 场景）是纯函数，模型拿不到、也无法绕过（铁律 1/3）；底线之上「说不说」由模型读空气决定，确定性评分只给建议（ADR-0011）。
- **失败要说人话**：未知参数、未知字段、发不了图、摄像头不可用、空帧——一律中文报错或具名拒绝，
  **不允许静默忽略或静默降级**。
- **默认关闭深度思考**：MiMo 服务端默认开启思考，路由用 `reasoning: off` + `reasoningEfforts` 明确关闭（§46.1）。

## 明确的未完成项

- **M2 唤醒词 / 完整 M5**（事件回放、候选生成器与常驻守护进程）均未开始，按 §45 顺序推进
  （**M4 记忆与 M3 的推断式人格学习已由 pack Phase 4 落地**，见 `docs/progress.md` §2.19）。
- 没有 `tsc --noEmit` 类型检查门；类型错误只会在运行时暴露。
- `tests/scenarios/` 有语料（`corpus.ts`）但没有 `*.test.ts`；`tests/replay/` 仍为空（§32/§22.3 属 M5）。
- **真人实测项（只有本机能做）**：真人站在镜头前能否被检出（`--require-transition`）、真人对着麦克风说话的实际识别率。
- 现场验收的**扬声器**项在修正口径后判 FAIL：能量比 2.41 dB < 10 dB，测的是「笔记本扬声器→笔记本麦克风」的**回采余量**，
  **不代表用户对麦克风说话能否被听到**（口径说明见 [`docs/recon/field-test-report-2026-09-30.md`](docs/recon/field-test-report-2026-09-30.md) 顶部）。
- **主动性 V2 的六条缺陷已修、并已独立复验**（第三轮 t1 修复 → t2 单独复验 → t3 评审 pass）：内容口径 generic 话题 **18.2%**（目标 ≤20%）、
  热聊接话 8 次；**口径已定＝显著降频**（不做「= 0」硬停，[`docs/adr/0011`](docs/adr/0011-proactive-decision-ownership.md) 决定 2 的补充 + 第五轮 t1 拍定），
  **而 pack 更严的「连续两次没回应后继续主动 = 0」仍不成立**（这是事实，不是待决问题）；多日验收见 `node scripts/eval-proactive-timeline.ts`。判定表与可重跑命令见
  [`docs/verification/t2-timeline-independent-verification-2026-10-01.md`](docs/verification/t2-timeline-independent-verification-2026-10-01.md)（第三轮）与
  [`docs/verification/t7-round5-independent-verification-2026-10-03.md`](docs/verification/t7-round5-independent-verification-2026-10-03.md) §2.1（第五轮自驱三天 12/12/12 与 5/5/5、惩罚置 0 则 11/11/11 = 降 54.5%）。
- **流式语音的首音目标（pack ≤1.5 秒）未达标**：8 批 n=32 的 ④ / 1500 ms = **[3.14, 7.33] 倍**（池化 3.73 倍），**没有一批接近**；
  下界由 ② 模型首 token 与 ③ 合成往返挡住 —— **目标不可达，不是实现缺陷**。同批对照（流式 vs 整段）方向**不一致**（3 快 5 慢、−16.1% 到 +27.3%），
  **不许写「方向多数为正」也不许拿单批百分比当结论**；`data/voice/bench/` 下较早产物的 `note` 是生成时的旧文本，**结论以 `--compare` 现算为准**。
- **流式逐块播放**：接线成立、B1 已修（每块只发一次）、**B2 已在 V0.3 P0-E1 修掉**（失败块改成 tombstone，后继块不再被憋到 `flush()`）——
  修法是**先写回归测试再改实现**（`tests/unit/voice/voice-stream.test.ts` 的「a failed clause never blocks the clauses behind it」，旧实现下先红）。
  逐条证据见 [docs/progress-v03.md](docs/progress-v03.md) 的 P0 段。
- **有界心情**：两条已知问题**已在 V0.3 P0-E2 清掉**——`resetMood` 的时间戳归一（`Z` 写法转本地偏移，已是数字偏移的按字节保留）
  与 `moodBias` 的注释/公式一致（相加后夹，`±6%` 的两处表述也钉住相加语义）。
  另有两条「尚未实现」：**控制台没有心情面板**、**心情没有接进主动引擎的软评分**（`moodProactivityNudge()` 在产线里没有消费点）。
- **`onNotice` 已被产线入口全部消费**（V0.3 P0-E2 补齐）：`chat.ts`（终端打印提示码）、`serve-chat.ts`（试用页）、
  `field-test.ts`（控制台）、`voice-turn.ts`（提示码写进产物）都订阅并显示
  `REPLY_HYGIENE` / `UNBACKED_FACT_CLAIM` 与「沉默原因」（`ARTIFACT_ONLY_REPLY` vs `MODEL_SILENCE`）。
  （代码里从来没有 `SILENCE_ARTIFACT_ONLY` 这个名字——那是评审提出的候选名，见 `packages/conversation/src/engine.ts` 的 `SilenceReason`。）
- **长期记忆与未完话题**：写侧已落地（pack Phase 4），**V0.3 P1-b 补齐了入口覆盖**——`chat.ts` / `serve-chat.ts` / `voice-turn.ts`
  都走 `@xixi/runtime` 的 `createTurnExtraction`（共用装配 + 关库前 `await drain()`），三入口各有真子进程或真 HTTP 证据。
  读侧（检索进提示词、纠正让旧事实失效）见 [docs/progress-v03.md](docs/progress-v03.md) 的 P1 段。
- **金额级费用上限未实现**：主动开口的额度是**次数**（6 小时 / 当日），它是当前的费用代理。

## 许可

见 [`LICENSE`](LICENSE)（MIT）。
