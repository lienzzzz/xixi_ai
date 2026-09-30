# 西西（Xixi）

> 仓库：[github.com/lienzzzz/xixi_ai](https://github.com/lienzzzz/xixi_ai)

长期常驻家庭环境的陪伴智能体。**它不是带摄像头的聊天机器人**：**可替换**的是模型 / ASR / TTS / 摄像头 / Harness，
**不可替换**的是长期状态与行为策略（WorldState、Memory、FutureHook、SelfModel、RelationshipModel、
RoutineModel、Proactive policy、Conversation state）。

当前进度（2026-10-01）：**M0 文本 Harness 已验收；噪声鲁棒语音前端、摄像头在场检测（M6）、
现场测试控制台、主动开口（主动性 V2：硬底线 + 模型读空气）与多段回复均已落地并真机验证**；
「真人感」改造（提示词改成「身份与说话方式」、回复容量 180 → 480 字、制品清洗）已落地并有**同口径的前后对比**
（见 [`docs/benchmarks/realism-metrics.md`](docs/benchmarks/realism-metrics.md)）；
记忆（M4）、唤醒词（M2）、模型驱动的人格学习（M3）与完整 M5 尚未开始。

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
| **多段回复（ADR-0010）** | `segments.ts` 纯函数分段器（**最多 8 段、块长 ≤60 字 → 容量 480 字**，段间 250–1200ms 默认 450；容量内每段 ≤60，`>8` 组时尾段合并并置 `mergedOverflow`，**该段可超 60**——反例 279 字 → 8 段、最长 62）；文字与播放计划真按段，**TTS 仍整条合成** |
| **主动开口（ADR-0009 + ADR-0011）** | **两层**：硬底线（静默时段 / 6h 与当日**次数**额度 / DND / 隐私与同意 / 场景与音频路径）由程序判定，模型不能绕过；底线之上**由模型读空气决定说不说**，确定性社会预算只给候选与建议（`BELOW_RECOMMENDATION` 是建议不是否决）+ `proactive.decision` 审计 + 先记后播。**金额级费用上限尚未实现**（次数额度是当前的费用代理） |
| **不编造可核查的事实** | 提示词 `HARD_POLICY` 的「可核查的具体事实」那条（关键词锚点，不再按编号引用）+ 引擎层闸门（无工具却出现具体数值就扣住并改说修复句）；台账核对「含具体值的轮次都伴随工具调用」 |
| **制品清洗（`REPLY_HYGIENE`）** | 工具调用标记与外文推理在进 TTS / 日志 / 工作记忆前被程序剔除（`sanitizeSpokenReply`）；整轮只剩制品 → 沉默，并发出 `REPLY_HYGIENE` 审计通知。**产线入口尚未订阅 `onNotice`**（见 `docs/progress.md` §4） |
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
**「落在 30–50%」只在「同语料重复」的前提下成立**；产线入口还没订阅 `onNotice`，
所以「程序剔掉制品导致沉默」在页面上暂不可区分（见 [`docs/progress.md`](docs/progress.md) §4）。

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
5. **四个入口各用不同数据库**：`chat` → `data/chat`、试用页 → `data/web-chat`、`voice-turn` → `data/voice`、
   现场测试控制台 → `data/field-test`（在场状态另用 `data`）。**在 chat 里设的人格与历史不会带到控制台。**
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
packages/domain/          唯一写 SQLite 的包：事件日志、会话、人格基线、world_state、迁移执行器
packages/conversation/    对话引擎：FSM、提示词组装、分段器（ADR-0010）、主动引擎（ADR-0009）
packages/brain-adapter/   BrainAdapter 接口 + FakeBrainAdapter + DSH 适配器 + 离线脚本化 transport
packages/model-adapters/  MiMo 直连适配器（含图像 image_url 构造）
apps/brain-dsh/           DSH 侧接线：profile patch（MiMo 路由）与 CLI transport
plugins/xixi-tools/       西西最小工具集（含 xixi_get_current_time / 天气等）
services/voice-edge/      语音前端（Python）：去直流 + 高通 + 门限 + 校准 + 噪声夹具生成
services/perception-edge/ 在场检测（Python）：DSHOW 抓帧 → 帧差动 + YuNet → presence 事件
config/                   xixi.example.yaml（方案 §42）
scripts/                  安装、验收、演示与现场测试控制台（field-test.ts 是控制台入口）
tests/                    unit / integration / perception / console / scenarios / replay
docs/                     README（地图）、architecture、event-contracts、testing、progress、handoff、
                          design/、adr/、recon/、review/、verification/、benchmarks/
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

- **M2 唤醒词 / M3 模型驱动的人格学习 / M4 记忆 / 完整 M5**（候选生成器与常驻守护进程）均未开始，按 §45 顺序推进。
- 没有 `tsc --noEmit` 类型检查门；类型错误只会在运行时暴露。
- `tests/scenarios/` 有语料（`corpus.ts`）但没有 `*.test.ts`；`tests/replay/` 仍为空（§32/§22.3 属 M5）。
- **真人实测项（只有本机能做）**：真人站在镜头前能否被检出（`--require-transition`）、真人对着麦克风说话的实际识别率。
- 现场验收的**扬声器**项在修正口径后判 FAIL：能量比 2.41 dB < 10 dB，测的是「笔记本扬声器→笔记本麦克风」的**回采余量**，
  **不代表用户对麦克风说话能否被听到**（口径说明见 [`docs/recon/field-test-report-2026-09-30.md`](docs/recon/field-test-report-2026-09-30.md) 顶部）。
- 主动开口的内容目前只由「事实 + 模型现编」生成，**没有记忆驱动的长期话题**（M4 之后再补）。
- **主动性 V2 的两项验收未达标**：pack Phase 5 的 12 小时时间线里，内容口径 generic 话题占比 **33.3%**（目标 ≤20%），
  且**「连续两次没人回应后显著降频」不成立**（被忽视的一天与有人回应的一天都是 9 次）；t9 的独立验证判 failed，
  六条缺陷（F1–F6）的修复任务是 t18（未开始）。**不要读成「Phase 5 已通过」**——
  判定表与可重跑命令见 [`docs/verification/t9-proactive-v2-verification-2026-10-01.md`](docs/verification/t9-proactive-v2-verification-2026-10-01.md)。
- **`onNotice` 没有产线消费者**：程序改写/剔除她说的话时（`UNBACKED_FACT_CLAIM` / `REPLY_HYGIENE`）
  发出的审计通知，页面与日志都还没接；「为什么沉默」因此暂不可区分（`SILENCE_ARTIFACT_ONLY` 只是评审提出的候选名字，代码里不存在）。
- **金额级费用上限未实现**：主动开口的额度是**次数**（6 小时 / 当日），它是当前的费用代理。

## 许可

见 [`LICENSE`](LICENSE)（MIT）。
