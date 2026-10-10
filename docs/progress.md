# 进度与交接记录

> 更新规则：每完成一个可独立理解的步骤就立刻追加/更新本文，写清「做了什么、验证结果、下一步、已知问题」。
> 这台机器偶发蓝屏，**本文是崩溃后恢复工作的唯一依据**。
> 最后更新：2026-10-10（**§14 D0 + D1**：交互原型页 `apps/demo-ui/` 与试用页上的 `/demo/` 三条静态路由、
> 页面 JS 的**两档浏览器防线**（快档在 `npm test` 里、深档单跑 `npm run test:ui`）、主动循环的**两个接缝**
> （到点的 durable 提醒 + 插件的 `topic_source` 提案）接进两个 live 入口。同日把 §13.5 第 3 条（「页面的 JS
> 零防线」）与 §4 第 31 条按事实收口，§12.3 / §12.4 里已被后续任务关掉的条目**就地加注、原文保留**）
> 上一版：2026-10-09（**§13 试用页接摄像头 + 一个总开关**：用户在 WSL 真机上试用后提的四条要求都已落地，
> 过程中抓到**三个真缺陷**——`--live` 跑到 20 秒就自杀、试用页内联脚本一个语法错误让**整页按钮全不响应**、
> 在场投影写进了**另一个库**；另写真机验收报告的**正确读法**（FAIL 不等于设备坏）与三条已知问题，见 §13。
> 同日更正 §10 里「`--self-test` 30 通过 / 2 失败」这句：本机今天实测 **31 通过 / 1 失败**，
> 且那 1 项**不是** Windows 专属读数——是「噪声底读不到」这条机器状态依赖）
> 上一版：2026-10-08（§12 **V0.3 P2.5 Production Wiring 收口**：常驻装配点 `createResidentRuntime()` 与
> 七个入口接线、`news.*` 第一次进模型可见工具链、审批与 durable 提醒由装配点接管、配置真的管插件、两个内核修复；
> **仍然没接的三条与五条已知问题同样写在 §12**；另还清两笔文档旧账——硬边界补第二条、历史那条 27% 加注，见 §12.5。
> 同日 §9 的「未达标项」与「下一阶段四条接线项」按事实加注，原文保留）
> 上一版：2026-10-07（§11 **DSH 版本适配 0.1.7-rc.2 → 0.2.0-rc.2**：`verify:provider` 已修复并实测通过；
> 同日另有 §10 **双机环境：Linux（WSL2）移植**——五个平台假设缺陷、静默 skip 变真跑、门禁 720/720/110，
> 以及这台机器上验不了的四类事，其中 ① DSH 路径已由 §11 关闭）。
> 上一版：2026-10-04（V0.3 **P2 集成收口 t15**：交付、Gate 实测、两个场景、未达标项与四条下一阶段接线项进
> [docs/progress-v03.md](progress-v03.md) 的 P2 段；本文新增 §9，并更正 §2.5 里 `BrainAdapter` 七个成员的旧口径）。
> 上一版：2026-10-04（V0.3 P0 + P1 集成收口 t16：交付、Gate 实测与遗留进 §8 与 [docs/progress-v03.md](progress-v03.md)；
> 另更正本文件里几条「只记录」的旧结论——它们已在 V0.3 P0-E2 清掉）。
> 上一版：2026-10-03（第五轮集成收口 t8）— **第五轮四条工作收口**：主动性口径已定＝**显著降频**（不做「= 0」硬停；多日验收 M1–M6 全过）、
> 未完话题收口判据升级到**词 / 对象**（0/91、真答案 15/15、反事实 9/91）、pack Phase 8 流式语音**接线成立 + B1 已修 + B2 是已知未覆盖缺陷**
> （首音 ≤1.5 秒**未达标且本机不可达**：8 批 n=32，④/1500 = [3.14, 7.33] 倍、池化 3.73 倍）、**有界的心情状态**（0 越界、语气 ±6%、软偏移 ±0.03）。
> 四条的逐条数字、口径与复跑命令见 **§2.20**；全部已知问题（只记录、本轮不修）见 **§4 第 10 条起**（新增第 26/27 条）
> 权威来源：本文件的数字来自当次命令输出；与代码冲突时以代码为准，并立即修正本文。

## 0. 结论表（objective）

| 能力 | 证据 | 状态 |
|---|---|---|
| 文本多轮对话（无需每句唤醒） | `npm run eval:conversation:judge`：8 场景 / 20 轮，接受 18、拒绝 2（电视音频与安静模式） | ✅ |
| 「像人说话」 | 评审模型：自然度 4~5、连贯性 4~5、**7 个场景全部判定为「像家里人」** | ✅ |
| 沉默是一等输出（§55） | 「嗯，知道了」→ 沉默；连续应和场景出现 SILENCE | ✅ |
| 人格真的改变行为（§39.4） | 同题对比：低话多组平均 22.3 字 vs 高话多组 57.3 字（**2.57×**） | ✅ |
| 真实能力而非空谈 | 天气工具（Open-Meteo，只读）被真实调用：回答用的是 19~25℃、降雨概率 8% 的真实预报 | ✅ |
| 语音闭环（夹具） | 夹具 → 抗噪前端 → VAD → ASR → 对话 → TTS；端到端 3.6~5.5s（含冷启动） | ✅ |
| **噪声鲁棒前端 + 成功边界** | `node scripts/verify-voice-noise.ts`（真实 ASR）：**SNR_inband ≥ 3 dB 时 4 条夹具全部检出、平均相似度 0.805**；详见 §2.13 | ✅ |
| 打断（§14.2） | 离线模拟：判定延迟 **192ms**（§33 目标 <500ms），播放截断于 992ms，丢弃 4128ms 未播音频 | ✅（判定层面） |
| 重启恢复 | 两个独立进程，第二个逐字复现第一个的回答（M0 验收，`npm run verify:m0`） | ✅ |
| **摄像头在场检测（M6）** | 合成场景 + 真机子进程实测：帧差动 + YuNet → `presence.changed` → `world_state` 投影；一键启用/停用可复现 | ✅（**真人**在场自测未跑，见 §4） |
| **主动开口（ADR-0009 + ADR-0011）** | **两层**：硬底线（静默时段 / 6h 与当日**次数**额度 / DND / 隐私与同意 / 场景与音频路径）由程序判定、模型不能绕；底线之上**由模型读空气决定说不说**，确定性社会预算只给建议（`BELOW_RECOMMENDATION`）；5 次 tick 只放行 1 条 | ✅ |
| **多段回复** | `reply.max_segments=8 / segment_max_chars=60 / gap_ms=450`（**块长 60、容量 8×60=480 字**）；容量内每段 ≤60，`>8` 组时尾段合并 + `mergedOverflow`（该段可超 60）；字符零丢失；状态机一轮只推进一次 | ✅（终端已接分段播放） |
| **「真人感」（P1，2026-10-01）** | 稳定前缀 = **身份与说话方式**（散文、0 编号）+ 紧凑安全段；容量 180→480 字；工具标记/英文推理在程序层剔除。同语料同口径：提问率主口径 45.8%→46.0%（各 n=1 次运行；三次重复均值 46.2% vs 46.0%）、单段最长 341→170 字、20 轮复述 0（详见 §2.18） | ✅（**提问率仍贴 30–50% 上沿**，见 §4） |
| **pack Phase 2/3/4 接线 + 第四轮收尾** | **Phase 2**：工具链逐入口覆盖（四个 live 入口共用 `buildToolChain`，`--print-wiring` 离线自证）、语言取自部署配置；**Phase 3**：未完话题收口判据（第四轮是**内容字**级；**第五轮已升级到词 / 对象级**，见下面一行与 §2.20）；**Phase 4**：长期记忆 + 三层自我画像 + 推断学习真的接线（权重只乘一次：名义 −0.05 → 落库 −0.02）、提取队列退出兜底（只覆盖正常退出）。数字、边界与已知残余见 **§2.19** | ✅（已知缺口见 §4） |
| **V0.3 P2：插件 / MCP / 审批 / News / Reminder / Provider 收缩** | 七块交付见 **§9** 与 [progress-v03](progress-v03.md) 的 P2 段；两个 pack 场景在**装配点**上成立（真模型 + 真库，事件日志可查） | **P2 当时部分未达标**（这是历史读数，别当现状）：四个 live 入口未接线、提醒的模型可靠性 22 次里 6 次真调工具（27%）、MCP 未对外部服务器验证。**前两条已分别由 P2.5 与 t27 更正**——见 §12 与 §9 的加注 |
| **V0.3 P2.5：Production Wiring（2026-10-08）** | 常驻装配点 `createResidentRuntime()` + 七个入口接线 + `news.*` 进模型可见工具链 + 审批/durable 提醒由装配点接管 + 配置管插件 + 两个内核修复；明细见 **§12** | ✅ **入口层已达标**（`npm run verify:p2.5 -- --offline` 四场景 exit 0）。**仍未接线**：外部 MCP 服务器与「新闻来源全部由配置说了算」（入口那一行 `reminderSeams` 与活入口读插件话题**已由 D1.1/D1.2 接上**，见 §14）。历史那条 27% 已加注为「一次不可复现的观测」 |
| **V0.3 D0 + D1：交互原型与浏览器防线、主动循环接缝（2026-10-10）** | ① `apps/demo-ui/` 静态三件套 + 试用页的 `/demo/` 三条静态路由（`tests/console/serve-chat-demo-route.test.ts`）；② 两档页面 JS 防线（`npm run test:ui:smoke` 进默认门禁、`npm run test:ui` 真 Chromium 深档）；③ `scripts/serve-chat.ts` 与 `scripts/field-test.ts` 的主动循环各接 `...runtime.reminderSeams` 与 `readPluginTopics`。明细见 **§14** | ✅ 离线部分（路由、快档、`tests/console/live-entry-proactive-seams.test.ts`、`npm run verify:p2.5 -- --offline` 场景 2）全绿；原型页的逐控件点击是**一次性浏览器取证**（今天不在门禁里，边界见 §14.4） |
| **第五轮（主动性口径 / 话题判据 / 流式语音 / 有界心情）** | ① 主动性**口径已定＝显著降频**（不做「= 0」硬停；`node scripts/eval-proactive-timeline.ts` 多日 M1–M6 全过）；② 收口判据升级到**词 / 对象**（13 句无关 × 7 话题 = **0/91**、真答案 **15/15**、反事实换回旧引擎 = **9/91**）；③ 流式语音**接线成立 + B1 已修 + B2 是已知未覆盖缺陷**，**首音 ≤1.5 秒未达标且本机不可达**（8 批 n=32，④/1500 = [3.14, 7.33] 倍、池化 3.73 倍）；④ 有界心情（0 越界、语气 ±6%、软偏移 ±0.03、硬门禁同码）。**每条的数字、口径与复跑命令见 §2.20** | ✅（③ 未达标，见 §2.20） |
| **现场测试控制台（一条命令）** | `npm run field-test` → http://127.0.0.1:8792；三栏界面 + 一键启用 + 设备自检引导 | ✅ |
| **试用页（`npm run web`）：摄像头预览 + 录音回放（2026-10-08/09）** | 与控制台**共用**同一份 `LiveSensors` 与同一份主动面板（所以「一个总开关」两页一致）；「你说的那句」与「她的整段回复」**各带一个可重复播放的播放器**；**页面加载即**打开摄像头并起常驻考虑循环（控制台不自动起，见 §13.3）。三条真缺陷（`--live` 20 秒自杀 / 整页按钮不响应 / 在场投影写错库）与三条已知问题见 **§13** | ✅（本机实测：预览子进程连续 **4204 帧 / 8 分 27 秒**，而不是缺陷时的 161 帧 / 20.1 秒） |
| 真实麦克风 / 扬声器（人耳） | 回环「回采余量」实测能量比 **2.41 dB < 10 dB** → 判 FAIL；**这不代表用户对麦克风说话能否被听到**（见 §0 用户须知与 §2.14）。**Linux 侧 2026-10-08 的验收报告同样 FAIL，但读法不同**——见 §13.4 | ⚠️ 需人耳确认 |
| 唤醒词 / 事件回放 / 模型侧主动候选 | 未实现（M2 / M5 的模型侧）；**长期记忆与三层自我画像已落地（pack Phase 4）**，见 §2.19 | ⛔ / ✅ 见 §2.19 |
| 主动问候的「真实用户价值」 | 主动开口已能发声，但**没有真人长期使用数据**；强度默认 0.85（阈值 0.495）只是当前取值 | ⚠️ 未验证 |

综合延迟（干净环境）：对话总时长 P50 2.5s / P95 5.1s，首字 P50 1.2s / P95 2.9s；语音链路里 VAD 判定 ~192ms、ASR 0.34~0.73s、LLM 首字 1.7~2.3s、TTS 1.0~2.0s。
**尚未验收**：扬声器真正静音的延迟、唤醒词、电视误触率、M6 的真人自测（命令见 §4）、噪声下的真实对话响应（端点延迟会从 600ms 涨到约 1500ms，见 §2.13）。
**现场测试前请读** [`docs/README.md`](README.md) §0「现场测试前用户须知」（一条命令、怎么判读、设备前置条件、household 入口默认连同一个库：`XIXI_DATA_DIR`，未设则 `data/xixi`）。


## 0b. M0 验收结论

`node scripts/verify-m0.ts` 用**两个独立的操作系统进程**跑通（方案 §34 的 M0 验收）：

| 阶段 | 结果 |
|---|---|
| 进程 1（fresh） | 文字 → DSH → MiMo `mimo-v2.6-flash` → 工具调用 `xixi_get_current_time` → 回答 `2026-09-29T15:13:51.620Z`，latency 6.3s，事件 3 条 |
| 进程 2（resume，全新进程） | 同一 `sess_6a233a16-…`、同一 DSH 会话 `session-a75b1195-…`；被问「你上一条回复的是什么」时**逐字复现**进程 1 的回答；人格 9 项与进程 1 一致；turnCount 4、事件 6 条 |

即「输入文字 → DSH → MiMo → structured tool → answer；restart → session recover」成立，且不是同进程内的假恢复。
另有 `npm run verify:provider`（一次真实调用）单独证明路由 + 工具调用可用。
离线测试 `npm test`：**以末行为准**（最近一次实测点：2026-10-01 第四轮收口、**398 项**、exit 0；
更早的集成收口实测点是 223 项、209 项 / 19.1s）。
**项数与文件数都不要抄**：本轮先后出现过 36 / 63 / 87 / 95 / 120 / 137 / 139 / 180 / 189 / 192 / 201 / 206 / 209 / 213 / 223，
那些全是**当时快照**，留着只为了证明「这个数一直在动」——要现状就跑 `npm test` 看末行。
**给后人的提醒：改这份文档时不要再写死测试总数或文件数**，只写「以 `npm test` 末行为准」加一个带日期的实测点
（与 [`testing.md`](testing.md) 头部同一口径；依据见 [`AGENTS.md` §9.18](../AGENTS.md)）。

## 1. 里程碑状态

| 里程碑 | 状态 |
|---|---|
| M0 DSH + MiMo 文本 Harness | **已完成（验收通过）** |
| M1 前置 spike（Python + 语音框架选型） | **已完成**：ADR-0007 选 Pipecat，参数与结论均有实测支撑 |
| M1 语音闭环（前端→VAD→ASR→对话→TTS + 打断） | **可用**：夹具链路通过 + 抗噪前端与成功边界已实测（§2.13）；真实麦克风的人耳确认仍未做 |
| 对话层（会话 FSM + Prompt 组装 + 工具 + 多段回复） | **已完成（P1 改版）**：多轮连续性、沉默、人格可调、只读工具、多段回复（ADR-0010，**容量 480 字**）；提示词前缀＝身份与说话方式 + 紧凑安全段 |
| **主动性 V2**（硬底线 + 模型读空气 + 真发声） | **已完成（第三轮修复 → t2 独立复验 → t3 评审 pass）**：硬底线原样生效、底线之上由模型决定；六条缺陷修完，generic 占比 **18.2%**（≤20%）、热聊接话 8 次；**口径已定＝显著降频**（不做「= 0」硬停，[`adr/0011`](adr/0011-proactive-decision-ownership.md) 决定 2 的补充 + 第五轮 `t1`），**而 pack 更严的「连续两次没回应后继续主动 = 0」仍不成立**（被忽视的那一天在连续 ≥2 条未回应后仍开口；第五轮复验自驱三天 12/12/12 与 5/5/5、惩罚置 0 则 11/11/11——这是**事实**，不是待用户定的问题）。模型侧候选评估、无人值守守护进程仍未做 |
| **M6 摄像头在场检测** | **已完成（部分）**：帧差动 + YuNet → `presence.changed` → `world_state` 投影 + 一键启用；**真人自测未跑**（§4） |
| M2 唤醒词 / M5 回放 | 未开始（M3 人格反馈与 M4 记忆已由 pack Phase 4 落地，见 §2.19；计划类钩子以 `open_threads` 实现） |
| 现场测试控制台（三栏 + 一键启用 + 设备自检） | **已完成**：`npm run field-test`（§2.15） |

仓库：`E:\worker2`。独立项目，**不依赖** `E:\worker` 的「m」原型（其方向已偏离需求）。

## 2. 已完成并已验证

### 2.1 环境事实（详见 [AGENTS.md](../AGENTS.md) 第 4 节）

- DSH `@deepseek-ai/dsh` **0.2.0-rc.2**（Developer Preview / RC），项目内 DSH_HOME = `<repo>/.dsh`（已 gitignore）。
  **2026-10-07 更正**：仓库原先钉 `0.1.7-rc.2`，而本机全局装的是 `0.2.0-rc.2`，两者不匹配导致工具插件 bundle 被跳过
  （`verify:provider` 必失败）；已按「适配当前版本」把 peer 与 devDependency 一并升到 `0.2.0-rc.2`，
  实测 `install:profile` 与 `verify:provider` 双双通过，见 §11。
- Node v24.21.0 原生运行 `.ts`（无需编译）；`node:sqlite`（SQLite 3.53.4，JSON1）可用 → M0 运行时只依赖 `js-yaml`。
- 本机**没有 Docker / mosquitto / ffmpeg**。系统 Python 是 **3.14.7**（不满足 Pipecat/LiveKit），
  语音侧一律用隔离 venv 里的 **Python 3.12.10**（`.venvs/{voice-pipecat,voice-livekit,field-probe,cv4}`，见 §2.7 与 §2.7b）。
- 显卡 GTX 1050 Ti 4GB + Intel HD 630；外网可能需要代理 `127.0.0.1:7890`。

### 2.2 DSH 集成配方（已落地，可复现）

1. `scripts/install-dsh-profile.ts`（幂等）：
   - 用 `dsh --profile xixi --from-default-profile headless`（非交互）建 profile；
   - `dsh.profile.bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless, dsh-xixi-tool]`（最小插件集）；
   - 复制仓库持有的 patch `apps/brain-dsh/profile/cordis.patch.yml`；
   - junction `profiles/xixi/node_modules/dsh-xixi-tool → plugins/xixi-tools`；
   - 最后 `--dump-config` 自检：必须同时出现 `dsh-llm-pi-ai`、`xixi-tools`、`openai-completions`、`mimo-v2.6-flash`。
2. MiMo 路由**只是配置**（`@deepseek-ai/dsh-llm-pi-ai` 已随 dsh-base 挂载），不需要自写 provider 插件：
   `api: openai-completions`、`baseURL: https://api.xiaomimimo.com/v1`（不带 `/chat/completions`）、`apiKeyEnv: MIMO_API_KEY`。
3. 凭据解析顺序（DSH 凭据 seam）：**进程环境快照** → `$DSH_HOME/.credentials.yaml` → **`<cwd>/.env`** → `$DSH_HOME/.env`。
   因此把 `.env` 放在仓库根、并以仓库根为 cwd 启动 `dsh` 即可；注意环境变量是**启动时快照**，启动后再 export 无效。
4. 工具插件：`plugins/xixi-tools`（`defineTool` + `dsh.bundle.patch`），`@deepseek-ai/dsh-tools@0.2.0-rc.2` 作为 devDependency 固定在仓库根，插件 import 自然解析。
5. 一轮对话：`node <dsh>/lib/bin.js --profile xixi --json [--session-id <id>] "<task>"`；stdout 是 NDJSON
   （`session` / `status` / `thinking` / `tool_call` / `tool_result` / `text` / `final`），`final.text` 是回答。
6. **恢复会话的约束**：必须同一 cwd、同一 profile 组合，且 `--session-id` 要带。会话落盘在
   `$DSH_HOME/sessions/<escaped-cwd>/<id>/session.v4.jsonl.zstd`（磁盘代次是 v4，比打包文档写的 v3 新）。
7. `--profile web` **不能**跑 headless 单轮（它只有 server 参数），所以西西用自建 profile `xixi`。
8. 权威原始报告：[docs/recon/dsh-integration-2026-09-29.md](recon/dsh-integration-2026-09-29.md)。

### 2.3 MiMo API 事实（已实测，权威报告 [docs/recon/mimo-api-probe-2026-09-29.md](recon/mimo-api-probe-2026-09-29.md)）

- 鉴权：`api-key:` 与 `Authorization: Bearer` **都可用**；错误密钥 → 401 `Invalid API Key`。
- 模型清单：`GET /v1/models` → **404**，`GET /models` → 200（含 `mimo-v2.6-flash`、`mimo-v2.5-asr`、`mimo-v2.5-tts` 等 9 个）。
- 工具调用：标准 OpenAI `tool_calls` 形状可用，`role:"tool"` 回传可用；
  **但 `tool_choice` 除 `auto` 外全部被静默忽略**（无法用强制调用当硬门禁），必须靠提示词驱动 + 自行校验 `tool_calls`。
- 结构化输出：`response_format` 的 `json_schema` 与 `json_object` 都可用；`strict` 是否真正强制未证实 → **必须在本地校验**（我们的 `@xixi/contracts` 正是干这个）。
- 流式：SSE 可用，最后一个 chunk 带 usage（无需 `include_usage`）；偶发先来一行 `: PROCESSING` 保活。
- **思考默认开启**：`thinking:{"type":"disabled"}` 或 `reasoning_effort:"none"` 才能真正关闭（`reasoning_tokens: 0`）；`enable_thinking` / `thinking_budget` 被接受但**被忽略**。
- 输出上限 131072；思考开启时 `max_completion_tokens` 过小会导致 `finish_reason=length` 且 **content 为空**。
- 该密钥**没有**服务端联网搜索权限（`webSearchEnabled is false`，body/header 都打不开）。

### 2.4 关键修复：真正关闭深度思考（方案 §46.1）

现象：即使路由写了 `reasoning: off`，`dsh --json` 仍输出 `thinking` 事件，模型确实在思考（outputTokens 16）。
根因：**手写声明的模型条目默认被视为「不具备推理能力」**（`PiAiModelProfile.reasoningEfforts` 缺省即无推理），
于是 pi-ai 不会走 `thinkingFormat: deepseek` 分支，也就不会下发 `thinking:{type:"disabled"}`。
修法：模型条目声明
```yaml
reasoningEfforts: { off: 'none', high: 'high' }
compat: { thinkingFormat: deepseek, requiresReasoningContentOnAssistantMessages: true }
```
效果（实测）：`thinking` 事件消失、outputTokens 16 → **2**、整轮耗时 7.5s → 4.4s。
注：只写 `off` 会被 pi-ai 拒绝（要求至少声明一个「off 之外」的档位），故同时声明 `high` 供后台反思使用。

### 2.5 代码资产

- `packages/contracts`：`xixi.event.v1` 信封（§23.2）+ 3 个事件类型（`presence.changed` / `conversation.turn`（含 `SILENCE`，§55）/ `system.health`）；
  自写 JSON Schema 子集校验器，**fail-closed**：未实现的关键字直接抛 `UNSUPPORTED_SCHEMA_KEYWORD`，加载 schema 时即检查；
  时间戳必须带数字偏移（不接受 `Z`）；有注册表/枚举/actor 列表的漂移检查。
- `packages/domain`：迁移执行器（逐条事务 + sha256；已应用迁移被改写就拒绝启动）、`events` / `conversation_sessions` / `self_profile` / `self_profile_history`。
  **不建 `conversation_turns`**：对话轮次就是事件，避免两份真相。`recordTurn` 在同一事务内追加事件并更新投影。
  `seedSelfProfile` 只补缺不覆盖。会话表带 `brain_provider` + `brain_session_id`（换 Harness 不丢会话）。
  21 个人格属性与范围来自方案 §7.2；**学习/调整引擎未实现**（属 M3）。
- `packages/brain-adapter`：**M0 时** §25 的 `BrainAdapter` 接口（`handleUserTurn` 已实现；`evaluateProactiveCandidate` / `interpretFeedback` / `extractMemories` / `reflect` 已声明，
  调用时抛 `NOT_IMPLEMENTED` 并注明里程碑）、`FakeBrainAdapter`（离线确定性）、`ScriptedDshTransport`（离线测试替身）、`DshBrainAdapter`（会话映射的读写方）。
  → **V0.3 P2-F 起口径已变**：接口拆成三个（`TurnModelProvider` + 可选 `MultimodalTurnProvider` / `StructuredInferenceProvider`），
  那四个能力从接口与三个实现里**移除**（不是留着抛异常），`BrainAdapter` 不再导出；类型留作 retired capability 并注明归属。
  见 [ADR-0020](adr/0020-provider-three-interfaces-and-mcp-deps.md) 与 [architecture.md](architecture.md) §2。
- `apps/brain-dsh`：`CliDshTransport`（每轮一个进程，天然满足「重启即续会话」；M1 因延迟需求会改为常驻宿主）、`parseDshJsonLines`、`composeTask`（M0 的上下文拼装占位，§26 的正式拼装属 M1）、`profile/cordis.patch.yml`。
- `scripts/`：`install-dsh-profile.ts`、`verify-provider-route.ts`、`verify-m0.ts`、`demo-m0-text.ts`、`demo-m0-restart.ts`、`lib/harness.ts`（.env 读取、路径、证据打印）。
- 文档：`docs/adr/0001–0006`、`docs/architecture.md`、`docs/event-contracts.md`、`docs/testing.md`、`docs/recon/*`。

### 2.6 故障路径（已实测）

用无效密钥跑 `verify:provider`：**3.9 秒**内失败、退出码 1、不挂起、不重试风暴，且保留了 provider 的原始错误
（`dsh: AUTH: 401: Invalid API Key`）。`DshBrainAdapter` 把它映射为 `BrainError(PROVIDER_FAILED)`；
传输层失败（无法启动 / 超时）映射为 `TRANSPORT_FAILED` / `TIMEOUT`（方案 §21 的降级设计有了可用的失败语义）。

### 2.7 M1 前置：Python 与语音框架（进行中）

- **Python 3.12.10 已安装（用户级，无需管理员）**：
  `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`（winget `Python.Python.3.12 --scope user`）。
  注意：DSH 宿主进程的环境变量是启动快照，新开的 pwsh **不一定**能看到 PATH 里的 `python3.12`，脚本里请用绝对路径。
- **两个隔离 venv（互相不污染依赖）**：
  - `E:\worker2\.venvs\voice-pipecat`：pipecat-ai **1.12.0**、onnxruntime 1.24.4、numpy 2.5.3、soundfile/soxr（无 torch）
  - `E:\worker2\.venvs\voice-livekit`：livekit-agents **1.8.3**、livekit-plugins-turn-detector 1.8.3、livekit-plugins-silero 1.8.3、livekit-local-inference 0.2.7、onnxruntime 1.30.0、transformers 5.17.0、sounddevice 0.5.6、av 19.0.0（无 torch）
  - `.venvs/` 与 `.spike/` 已 gitignore。
- **中文音频夹具已生成**（`node scripts/make-audio-fixtures.ts`，用 `mimo-v2.5-tts` 合成，24 kHz 单声道 16-bit，共 5 条）：
  `tests/audio-fixtures/{direct-question,followup-turn,backchannel,longer-turn,tv-dialogue}.wav`。
  用途：M1 的 VAD/断句/打断测量，以及 M2 的「电视误唤醒」对照（`tv-dialogue` 与 `direct-question` 内容相同、只差唤醒词）。
- **选型测量进行中**（两个子代理，同一协议、各自独立执行）：
  VAD 端点延迟、turn detector（含「嗯。」是否被误判为说完）、打断机制能否离线演示、Windows/CPU 可行性。
  原始结果将落到 `.spike\pipecat\RESULT.json` 与 `.spike\livekit\RESULT.json`（临时目录），
  结论必须落到本文与 `docs/recon/`，并形成 ADR-0007（语音框架选型）。

### 2.8 对话层（本轮新增，`packages/conversation`）

- `ConversationStateMachine`（§12/§13）：IDLE 需唤醒或强直呼；ENGAGING/ACTIVE/LINGERING 期间无需再喊名字；
  静默容忍度按人格缩放跟进窗口（tolerance 0 → 15s，1 → 1.5×30s）；`SUSPENDED` 支持「今天安静点」。全部时钟注入，可重放。
- `PromptAssembler`（§26，**P1 改版 2026-10-01**）：稳定前缀 = `CORE_IDENTITY`（身份与说话方式，散文）→ 名字 →
  `HARD_POLICY`（压缩安全段，关键词锚点）→ 说话方式（人格→**词描述**）；变化后缀 = 当前情境 / 用户这句话。
  **裸人格参数（`verbosity=0.4` 这类）与【最近对话】二次展开都已删除**：历史只以 `history` 的真实角色数组
  交给适配器，模型每轮只看到一次；`sections` 五个名字 = `core-identity` / `safety-policy` / `effective-style` /
  `world-state` / `current-turn`。同一人格下前缀逐字节稳定（§46.3 的 provider 缓存）。
- `ConversationEngine`：接受判定 → 组装 prompt → 调适配器 → 记录事件 → 更新状态；
  **§55 的沉默在引擎层兜底**：无论适配器报什么，只要整句是 `[静默]` 就转成 SILENCE，
  且流式分片（实测 MiMo 会把 `[静默]` 拆成 `[`+`静默`+`]`）也不会漏出去或被 TTS 念出来。
- 人格参数会渲染成**词描述**的说话要求（低 verbosity → 「说话偏简短：一句能说完就别硬凑第二句。」，
  高 → 「愿意多说几句…」；**不再出现句数或裸参数**，单测断言每条指令不含数字与参数名），
  这正是 §39.4 要求的「行为验证」而非「数据库验证」。
- 测试：`tests/unit/conversation-fsm.test.ts`、`tests/unit/prompt.test.ts`、`tests/integration/conversation-engine.test.ts`。

### 2.9 语音闭环（本轮新增，`services/voice-edge` + `scripts/voice-*.ts`）

- `services/voice-edge/voice_edge/segment.py`：Silero VAD 分段 CLI（Pipecat 1.12.0），基线 `stop_secs=0.6, min_volume=0.0`（ADR-0007）。
  实测：语音起点 288~320ms、端点延迟 600~608ms、`longer-turn` 不再在句内停顿处误判（那是默认 `stop_secs=0.2` 的坑）。
  输出分离 `loadMs`（冷启动）与 `processMs`（流式成本），避免把冷启动算进实时延迟。
- `scripts/voice-turn.ts`：夹具 → VAD → **只上传语音段**（§20.1）→ MiMo ASR → 对话引擎 → MiMo TTS → 回复 WAV；
  多 `--wav` 即一次多轮语音会话，输出 §46.4 的分段耗时。
  实测：ASR 中文转写正确（「明天天气怎么样？」「今天下午去镇上办点事，可能要到晚上才回来。」），
  回复自然（「行，路上慢点，镇上人多车多的。」）；端到端首条回复音频 3.6~5.5s（含 Python 冷启动与 TTS 整段合成）。
- `scripts/voice-bargein.ts`：按 §14.2 模拟「西西正在说话时用户开口」→ 判定延迟 **192ms**、播放截断、丢弃 4128ms 未播音频，并写出截断 WAV 作为可审计证据。
- 已修的两个自测缺陷：按字节而非样点切帧（导致 VAD 永不停止）、把字节偏移当毫秒（所有时间 2 倍）。
- 夹具修复：`make-audio-fixtures.ts` 统一追加 600ms 尾部静音（LiveKit 子代理发现 `followup-turn` 原本在语音中途截断）。

### 2.10 工具（§27，只读、程序执行）

`packages/brain-adapter/src/tools.ts` + `packages/model-adapters/src/weather.ts`：
- `xixi_get_current_time`（L0）、`xixi_get_weather`（L1，Open-Meteo，**无需密钥**，30 分钟缓存，中文天气描述）。
- 适配器内的工具循环：模型请求工具 → **程序**执行 → 结果回灌 → 模型再回答；未知工具名是「拒绝」而不是崩溃；最多 2 轮。
- 实测关键点：MiMo 会**同时**返回一句开场白和 `tool_calls`（「明天本市的天气我帮你查一下。」+ 工具调用），
  因此「有文本」不能当作「已经回答」——这正是本轮修掉的一个真 bug（否则工具永远不执行）。
- 实测结果：回答使用真实预报（19~25℃、降雨概率 8%），不再是凭记忆编造。
- 未做：`tool_choice` 无法强制调用（MiMo 只支持 auto），所以工具只能靠提示词驱动 + 自行校验。

### 2.11 MiMo 结构化输出的间歇性缺陷（重要）

`response_format: json_schema` **间歇性**返回「先输出键名、再补大量空白直到耗尽 token」的截断 JSON：
`strict:true` 出现过 2/3 失败，`strict:false` 也出现过 1/3 失败——**不是 strict 的问题，是这条通道的问题**。
对策（已实现）：`MimoClient.chatJson()` 先走 `json_schema`，解析或**本地 schema 校验**失败则回退到 `json_object`
（并把 schema 写进提示词，否则模型会自造键名——实测发生过），两次都失败才抛错。
`npm run verify:structured-output` 连续 3 次调用全部可用（其中 2 次走了回退），并把原始通道的缺陷当作金丝雀长期监测。
**结论：所有结构化输出必须本地校验**（§52/§53），这条已经在评审与金丝雀里落地。

### 2.12 评测与测试数据（自己生成）

- 音频夹具：`tests/audio-fixtures/*.wav`（MiMo TTS 合成，24kHz 单声道，含尾部静音），
  其中 `tv-dialogue` 与 `direct-question` **内容相同、只差唤醒词**，专供 M2 电视误触对照；`backchannel` 是 0.96s 的「嗯。」。
- 对话语料：`tests/scenarios/corpus.ts`（8 个场景：连续对话、疲惫晚上、跨轮话题、电视未直呼、安静模式、低/高话多对比、连续应和），
  每条都是**可证伪的行为断言**，不是字符串比对。
- 评测器：`scripts/eval-conversation.ts`（结构检查 + 可选评审模型 `--judge`），报告写入 `docs/recon/conversation-eval-<date>.md`。
- 现有测试：`npm test` 实测数字见 §0b（**以实跑末行为准**；测试数会随断言增加而变化）。

### 2.13 噪声鲁棒语音前端与成功边界（t2 实现 / t23 订正 / t7→t24→t38 评审链）

用户明确说过「麦克风噪音很大」，而 ADR-0007 的基线只在干净合成夹具上验证过。本轮把它做成可测量的：

- 实现：`services/voice-edge/voice_edge/frontend.py`（纯函数：去直流 + 零相位 120 Hz 双二阶高通 +
  噪声底自适应门限；谱减法可选、**默认关**）、`voice_edge/calibrate.py`（噪声底校准入口）、
  `voice_edge/make_noise_fixtures.py`（实测环境噪声 × 6 档 SNR = 30 个 WAV + `manifest.json`）、
  `scripts/verify-voice-noise.ts`（干净 + 噪声夹具 → 前端 → VAD → **真实 MiMo ASR**）。

**可复现成功边界（写死）**：`SNR_inband ≥ 3 dB` 时 4 条中文夹具**全部检出**、平均字符相似度 **0.805**。

| SNR 档 | 检出 | 平均字符相似度 | 判定 |
|---|---|---|---|
| 18 dB | 4/4 | 0.841 | PASS |
| 6 dB | 4/4 | 0.841 | PASS |
| **3 dB** | **4/4** | **0.805** | **PASS（边界）** |
| 0 dB | 4/4 | 0.491（2 条 <0.6） | FAIL |
| −6 dB | 0/4 | —（全部漏检） | FAIL |

**端点延迟必须按 t23 修正后的口径引用**（逐条值、最大值；**不要用均值，也不要用被截断的 `endpointDelayMs`**）：
6 dB 档 **1056 / 1376 / 1472 / 1088（max 1472）**；干净档 728 / 704 / 864 / 704；3 dB 档 104 / 128 / −64 / 96（max 128）。
复现（不花钱）：`node scripts/verify-voice-noise.ts --fake --tiers 6`；真实 ASR：`npm run voice:noise`。
数字来源：`docs/design/voice.md` §1.1（6）。

**三条负结论（不要美化）**：
1. **高通把宽带噪声降了 5.33 dB，但对 Silero 的分段判定几乎没影响**（同一批夹具 A/B：段数/起点/端点不变，
   个别 0–288 ms 的方向性改善）。别把「降噪 5.33 dB」读成「VAD 会变好 5.33 dB」。
2. **谱减法默认关闭**：噪声带只降 0.47–1.91 dB，端到端相似度 6 dB 档无变化、**3 dB 档反而变差（0.622 vs 0.805）**，
   还要每段多花 100–300 ms。开关保留（`segment --nr`），负结论留在代码与 `voice.md` §1.1（5）。
3. **噪声下端点延迟显著变长**：干净 600 ms → 6 dB 档约 1056–1472 ms（≈1500 ms 量级），
   真实对话的响应会明显拖慢；0 dB 档打断判定也不可靠。

边界值的自动化与证据：`report.boundary.lowestPassingTierDb`（脚本自动算）、
`docs/verification/*` 与 `docs/review/voice-*-review-*.md`；困难样本（0 / −6 dB 共 10 个 WAV）**全部保留**，
有单测守住「最低 SNR 档必须仍在盘上」。

### 2.14 摄像头在场检测（M6）与设备验收的正确解读

- 实现：`services/perception-edge/perception_edge/{run,bench}.py`（DSHOW 抓帧 → 帧差动 1.17ms/对 → YuNet 人脸 38.3ms/帧）
  → `presence.changed` 事件 → `world_state` 投影（`presence.home`，`002_world_state.sql`）；设计见 [`design/perception.md`](design/perception.md)。
- 一键启用：控制台 `POST /api/field/live {action:'start'}` = 迁移在场库 → 起 `perception_edge.run --live` 子进程 → 循环先 tick 一次；
  真机实测 `child.pid` 可见、5 秒后 frames 104、presence 事件 2 条、`present=true`、`confidence=0.75`，停用后子进程真退出。
- 隐私：帧只在内存（子进程 `cv2.imencode` → stdout base64，控制台只留最新一帧），**不留图像**；
  `--live` 仍会写 `data/perception/` 的事件库（「不留图像」≠「不写库」）。
  可重跑核对：`node scripts/verify-camera-presence.ts --live --seconds 8`（磁盘图像文件 0 个）。
- **设备验收的两条正确解读**（`docs/recon/field-test-report-2026-09-30.md`）：
  1. **「扬声器 FAIL」测的是回采余量**（笔记本扬声器 → 笔记本麦克风），能量比 2.41 dB < 10 dB 所以 FAIL；
     **不代表用户对麦克风说话能否被听到**——那要用 `node scripts/voice-device-check.ts --wav <录音> --expect "<原文>"` 检验（相似度 ≥ 0.5 判 PASS）。
  2. 默认播放端点**出厂就是静音的**（勘测实测），本轮已解除；采集增益默认 +5.5 dB，噪声底几乎 1:1 跟着它走，
     建议设 0 dB（控制台只提示、不修改系统设置）。

### 2.15 多段回复（ADR-0010）与主动开口（ADR-0009 + ADR-0011）+ 三栏控制台

- **多段回复**：`config/xixi.example.yaml` 的 `reply: {max_segments: 8, segment_max_chars: 60, gap_ms: 450}`
  （代码里被 `resolveReplyLimits(config.reply)` 夹进 ADR-0010 的硬上限；**上限由 3 提高到 8**，见该 ADR 的修订记录）。
  两个词要分清：**块长** = 一次播报粒度（60 字），**容量** = 8 × 60 = **480 字**；`>8` 组时尾段合并、`mergedOverflow=true`
  且该段**可超 60 字**（最小反例 279 字 = 9 句 × 31 → 8 段、最长 62，断言在 `tests/unit/core/reply-segments.test.ts`）。
  独立验证（t43）：`onSegment` 与 `onTextChunk` 互斥（chunks=0）、字符零丢失、
  该轮事件恰好 1 user + 1 assistant + 1 decision（**状态机只推进一次**）。
  **接线现状**：终端 `scripts/chat.ts` **已接**分段播放（`onSegment`）；试用页与 `voice-turn.ts` 仍整段 `synthesize(turn.text)`。
- **主动开口（V2，2026-10-01）**：`ProactiveLoop`（默认关）+ 候选只来自事实（在场 / 会话悬置 / 时间钩子 / 话题池 / 随机闲聊）；
  **判定走同一条 `ProactiveEngine.consider`，但语义已改成两层**（[ADR-0011](adr/0011-proactive-decision-ownership.md)）：
  ① 硬底线（静默时段 / 6h 与当日**次数**额度 / DND / 隐私与同意 / 场景与音频路径 / 同一候选重复）由程序判定，
  模型不能加宽；② 底线之上**由模型读空气决定说不说**，确定性社会预算（话题质量分 / 相关性 / 新鲜度 / 读空气 /
  互动度 / 主动性 − 打扰代价 / 话题重复 / 未回应惩罚）只产出 `recommendation: speak | hold`。
  冷却、话题重复、未回应**从门禁降级为扣分项**（`BELOW_RECOMMENDATION` 是建议不是否决）；审计事件多记
  `primary_signal`、每项信号、`decided_by` 与程序渲染的中文 `basis`，**仍不存模型推理**。内容由模型在 `deliver`
  接缝里生成、失败回退固定句，投递「先记后播」（崩溃不重发）。
  ⚠️ **没有金额级费用上限**：额度是**次数**，它只是费用代理（见 §6）。
- **主动性 V2 的两项未达标 + 六条缺陷（t9 独立验证，2026-10-01；**这两项与六条缺陷**已在第三轮修完**——
  修完后的口径、数字与多日验收见 §2.20 与 [`verification/t2`](verification/t2-timeline-independent-verification-2026-10-01.md)、
  [`verification/t7`](verification/t7-round5-independent-verification-2026-10-03.md) §2.1；下面这段是**当时**的状态，保留作历史）**：
  pack Phase 5 的 12 小时时间线验收里有 **2 项目标没达到**——① 内容口径的 **generic 话题占比 33.3%**（目标 ≤20%；
  引擎口径 0% 是结构性的，见下面的 F3，**不能用来宣称达标**）；② **「连续两次没人回应后显著降频」当时不成立**：
  被忽视的一天与有人回应的一天说了**同样多的 9 次**，机制探针显示「1 条未回应」与「3 条未回应」拿到同一个 **0.45** 惩罚，
  标准候选照样 `PASSED`。t9 因此判 **failed**，并明确「不建议宣布 Phase 5 验收通过」。
  **六条缺陷（t9 §5，第三轮全部修复）**：F1 high（被扣分的候选吃光 tick，`future_hook_due` 0/3）、F2 high（未回应惩罚饱和、量级不够）、
  F3 medium（`topicRef = trigger` 让 generic 指标结构性失效，永远不可能失败）、F4 medium（「读空气」的问询吃光当日额度：
  40 次「不说」之后当天不再开口）、F5 medium（pack §14.3 的「热聊中接话」在生产候选里到不了）、F6 low（打扰代价只是分数：
  两条消息可以隔 1–2 分钟）。**修复进展：第三轮 t1 修完、t2 独立复验、t3 评审 pass**（`626c201`；generic 18.2%、热聊接话 8 次、
  F1–F6 各有反事实或探针证据）。**注意仍有一项按更严口径不成立**：pack §3 的「两次未回应后继续主动 = 0」——口径已拍定为
  **显著降频**（[`adr/0011`](adr/0011-proactive-decision-ownership.md) 决定 2 的补充），但「= 0」这句话在真产物上**仍是假的**。
  **报告与全部数字**：
  [`verification/t9-proactive-v2-verification-2026-10-01.md`](verification/t9-proactive-v2-verification-2026-10-01.md)
  （§7 是判定表、§5 是六条 findings、§9 是可重跑命令）。
- **人格强度与「怎么调、怎么关」**：`personality.base.proactivity` 默认 **0.85**（代码 `DEFAULT_PROACTIVITY = 0.85`），
  阈值 `0.45 + 0.30 × (1 − proactivity)` = **0.495**（核对：`git grep -n "DEFAULT_PROACTIVITY" -- packages`）。
  控制台可调 proactivity / talkativeness / verbosity（写入 `self_profile` + `self_profile_history`，
  来源 `console:personality`，并落一条 `system.health` 审计）；**怎么关**（2026-10-09 更正：这段话原先写
  「不开『自动考虑』开关或点停用」，而那个勾自本轮起**默认收起在「高级设置」里**，见 §13.3）——
  今天只有**一个**总开关：面板上的 **「主动开口」**（`px-enabled`）。取消勾选＝不主动开口；
  它同时起停常驻考虑循环，所以不必再去高级设置里找第二个勾。
  每次开口或被拦都落 `conversation.decision` 事件（被拦也落 `speak:false`，可回答「为什么今天没说话」）。
  ⚠️ **时点提醒**：t43/t80 报告里写的 0.70 / 0.54 是**当时快照**，t77 已改为 0.85 / 0.495。
- **三栏控制台**：`npm run field-test` → http://127.0.0.1:8792，三栏（传感器 / 配置 / 对话）+ 一键启用 + 实时画面
  + 设备自检引导 + 隐私与保留策略；<1200px 自动堆叠。库默认 `data/field-test`（`--data-dir` / `--presence-data-dir` 可改；
  未知参数**中文报错 + exit 2**）。

### 2.16 三条已知取舍与限制（写清楚，别当成没做）

1. **`engine.state` 是带副作用的 getter（读取即推进，t19 的核心取舍）**：读状态会推进 FSM 的时间判定，
   所以「看一眼现在是什么状态」不是纯查询。任何新的读取方（面板、脚本、将来的常驻服务）都必须知道这一点。
2. **`REJECTED_NOT_ADDRESSED` 目前没有真实样本**：稳定的拒绝只有 `SUSPENDED`（安静模式）一种，
   另一条路径的样本只在测试与历史报告里出现（t10 的 F2 记录过「当时不成立」的验证）。
3. **`data/` 目录的隐私比较是「文件名集合」**：同名覆盖不会被发现。今天无法触发（服务里没有任何写图路径），
   **将来若加调试落图，必须改成 mtime + 大小或内容哈希**（评审 t80 的 O4 也是同一口径：隐私的含义是「不留图像」，不是「不写库」）。

### 2.17 不许编造可核查的具体事实（t111 落地 + t117 按评审收紧）

**机制（两层）**：提示词层 `HARD_POLICY` 的「可核查的具体事实」那条（P1 起不再按编号引用）要求
「天气/气温/降水概率/风力/空气质量/新闻/日程/别人说的话」
只能来自工具结果，要说必须先调用工具查，查不到就说不知道；程序层 `ConversationEngine` 的
`findUnbackedFactClaims()` / `screenUnbackedFacts()` 是确定性闸门——本轮没有工具调用却出现「只有查得到才知道的具体值」时，
文本被扣住（不进 TTS、不写 `conversation.turn`、不改工作记忆），改说修复句并给调用方
`onNotice({code:'UNBACKED_FACT_CLAIM'})`；主动开口的投递接缝用同一个判据，未核实就换成该触发源的固定短句，
并把 `toolName` 写进 assistant 轮的 `tool_name`。

**t117 按评审（t114）收紧的两处**：① 归属规则从「出现过来源词」改成「来源在说话 + 同句有可核查内容」——
`医生/专家/朋友说/别人说/他们告诉` 这类裸来源词不再触发（此前会把「朋友说要来吃饭」「专家都觉得这样安排挺好」
「今天新闻挺热闹的，说小区门口要办集市」整句替换成「我不敢乱说」）；② 温度量词从 `\d{1,2}` 放宽到 `\d{1,3}`，
`180 度`/`100 度` 的审计 `match` 不再被截断成后两位。

**台账口径（把结论限定成事实，t114 的 F3）**：扫三个库的 `conversation.turn`（`data/chat`、`data/field-test`、`data/web-chat`），
含具体值的 assistant 轮共 **4 条，全部伴随 `xixi_get_weather`**（10:04 / 11:12 / 13:02 / 15:05）；
另有 **8 条**含具体值却 `tool_name=null` 的轮次（判据：含具体值**且** `tool_name=null` 的 assistant 轮，**三个库都要扫**——
`data/chat` 6 条：07:57×2、08:16×4、08:17；`data/field-test` 1 条：11:12:54；**`data/web-chat` 1 条：10:09:40**）。
**这 8 条全部发生在修复（约 19:55）之前，不会被追溯修改**——台账是当时发生的事实记录，修的是「从现在起不再发生」。
**这些库里没有任何修复之后的轮次**，所以「修复之后零违规」只在 t111 自己的运行窗口（它用的是 `%TEMP%` 下的临时库）
与离线探针上成立，**不能在仓库台账上证实**；「4 条全部伴随工具」说的也是那 4 条**修复前**的轮次（它们恰好都调用了工具）。
**可重跑的主引用**（一条命令一次扫三个库；在仓库根目录执行，输出与上面两句逐字对应）：

```powershell
node -e "Promise.all([import('node:fs'),import('node:sqlite'),import('./packages/conversation/src/engine.ts')]).then(([fs,sq,eng])=>{const dbPaths=['data/chat/xixi.sqlite','data/field-test/xixi.sqlite','data/web-chat/xixi.sqlite'];let backed=0;let nulls=0;for(const p of dbPaths){if(!fs.existsSync(p))continue;const db=new sq.DatabaseSync(p,{readOnly:true});const rows=db.prepare('select event_type, payload_json from events').all();let b=0;let n=0;for(const row of rows){if(row.event_type!=='conversation.turn')continue;const q=JSON.parse(String(row.payload_json));if(q.role!=='assistant')continue;if(eng.findUnbackedFactClaims(String(q.text||'')).length===0)continue;if(q.tool_name===null||q.tool_name===undefined)n+=1;else b+=1;}console.log(p+': 伴随工具 '+b+' / 无工具 '+n);backed+=b;nulls+=n;db.close();}console.log('三库合计：伴随工具 '+backed+' / 无工具 '+nulls);});"
```

实跑输出（2026-09-30，本机）：

```text
data/chat/xixi.sqlite: 伴随工具 1 / 无工具 6
data/field-test/xixi.sqlite: 伴随工具 2 / 无工具 1
data/web-chat/xixi.sqlite: 伴随工具 1 / 无工具 1
三库合计：伴随工具 4 / 无工具 8
```

判据就是上面那两句：`findUnbackedFactClaims()` 判「含具体值」，`payload_json.tool_name` 判这一轮有没有工具调用。
（命令里带中文标签：直接粘进终端跑就是上面这段输出；若**存成 `.ps1` 再用 Windows PowerShell 5.1 执行**，
请存成**带 BOM 的 UTF-8**，否则中文标签会读成乱码——同一个坑见 [`AGENTS.md` §9.8](../AGENTS.md) ⑤。）

**附（背景，不是主引用）**：评审 t114 当时的脚本 `data/rev-tmp/t114-invariant.mjs` 落在 `data/`（已 gitignore），
随机器清理会消失，而且**只扫 `data/chat` 与 `data/field-test` 两个库**——直接跑它只会得到「伴随工具 1 / 无工具 6」
与「伴随工具 2 / 无工具 1」；**复算时三个库都要扫，否则会少一条无工具的（`data/web-chat` 10:09:40）
和一条伴随工具的（`data/web-chat` 10:04）**。以主引用那条命令为准。

### 2.18 「真人感」改造与前后对比（P1 + P1c，2026-10-01）

**改了什么**（三处，都在 P1）：① 稳定前缀从**编号规则清单**改成 `CORE_IDENTITY`（身份与说话方式，散文）
+ `HARD_POLICY`（压缩安全段，关键词锚点），裸人格参数与【最近对话】二次展开删除；
② 回复容量 3×60=180 → **8×60=480 字**（块长仍 60；`>8` 组时尾段合并，见 §2.15 与 ADR-0010 修订记录）；
③ 工具标记与英文推理在**程序层**剔除（`sanitizeSpokenReply` → `REPLY_HYGIENE` 通知；整轮只剩制品则沉默）。

**指标怎么量（唯一口径，别再各说各话）**——实现只有一份：`scripts/lib/realism-metrics.ts` + `scripts/eval-realism.ts`：

- **分母**：`action === 'SPEAK'` 且文本非空且**不是引擎修复句**（`UNBACKED_FACT_REPLY`）的**开口轮**；
  沉默轮与修复句都不进分母（否则会拿程序写的那句话当模型的行为）。
- **提问率主口径**＝**末句以问号收尾**（带内判定用它）；**辅口径**＝回复里含问号，只作参考。
- **长度**＝去空白字符数；另有**交付分段**（每轮段数 + 单段字数，ADR-0010 的真实结果）。
- **禁用模板率**＝命中 13 条「AI 套话」词表的开口轮占比（每条都写明为什么算套话）。

**前后对比（同一批 84 轮语料、同一工具、同一模型；两次运行各 84 轮）**：

| 指标 | 改造前 V0.1（`882f745`） | 改造后 P1（`995ed42` 快照） |
|---|---:|---:|
| 提问率（**主口径**） | **45.8%**（33/72） | **46.0%**（29/63） |
| 提问率（辅口径，仅参考） | 69.4% | 57.1% |
| 逐次重复的主口径 | 28.0 / 58.3 / 52.2（均值 46.2%，**n=3**，极差 30.3pt） | 47.6 / 42.9 / 47.6（均值 46.0%，**n=3**，极差 4.7pt） |
| 回复字数 P50 / 最大 | 47.5 / 422 | 33 / 424 |
| **交付分段的最长单段** | **341 字** | **170 字** |
| 禁用模板出现率 | 0% | 0% |
| 沉默率 | 3.8% | 9.0% |

**20 轮同一输入的口语对比**（t2 采集，输入同为 `docs/benchmarks/v01/input-chat-20turns.txt`）：
复述 **0**（重复句子 0、重复短语 0、与上一轮最大公共子串 4/7 字）vs V0.1 的 10 字复述 +
「了，量完血压」出现在第 12/16/19 轮；段数分布 `{1段:12, 2段:4, 3段:3, 4段:1}` 与 `{1段:6, 2段:8, 3段:1, 4段:3, 5段:2}`
vs V0.1 的 `{1段:3, 2段:7, 3段:9}`；P50 101 → 46/80.5 字，最大 177 → 166/216；知识题 5 段 216 字**不丢字**。

**可重跑（不花钱，读已捕获的转录）**：

```powershell
node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-10-01-v01-vanilla.json   # 改造前
node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-10-01-v02-wip.json        # 改造后
```

**如实说明（别把它读成「提问率已达标」）**：主口径下改造前后都在 **46%** 附近，**贴着 30–50% 带宽的上沿**；
把全部 10 次捕获（3×V0.1 重复 + 3×P1 重复 + t4 两次 20 轮 + t6 在 v02 两份转录上的两次）算进来，
主口径极差是 **15.8%–63.2%（跨带）**——**「落在 30–50%」只在「同语料重复」的前提下成立**，
跨带来自输入差异（t17 的 O1 更正了 captain 早先的「8 次独立捕获」措辞）。
逐条口径与全部数字见 [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md)；独立验证见
[`verification/t4-realism-verification-2026-10-01.md`](verification/t4-realism-verification-2026-10-01.md)。

### 2.19 pack Phase 2/3/4 的接线、逐入口覆盖与设计取舍（第四轮收口，2026-10-01）

**第四轮交付台账**（团队 `xixi-v02-round4`；契约与状态在 `.agent-teams/xixi-v02-round4`，任务编号只在本轮内唯一）：

| 任务 | 结果 |
|---|---|
| t1 理由码断言强度 + 时间线覆盖问询额度（承接第三轮 t13） | ✅ `b36ef15`：两次已宣告突变实验证明断言抓得住；时间线命令六行全过 exit 0 |
| t2 工具链与语言接线推及全部 live 入口（承接第三轮 t14） | ✅ `dba60bc`：四个 live 入口共用 `buildToolChain`；新增离线开关 `--print-wiring`；三次已宣告突变实验各红 |
| t3 未完话题收口不挂钩（承接第三轮 t15） | ✅ `37b8453` → 评审 **t7 = needs_revision**（R1「去」漏在通用字表、R2 弱证据路径太松）→ t8 修复 `ab61a98` → 复审 **t9 = pass** |
| t4 推断学习接线 + 提取队列不丢数据（承接第三轮 t16） | ✅ `227fbd7` → 评审 **t10 = pass**（反事实：落库换回已乘权重的值 → 集成用例红 2、显式侧一字未变） |
| t6 更正两处与事实不符的注释（§9.13 更正） | ✅ `f11d90c`（纯注释） |
| t11 清掉「省略 language 即直通」最后一处注释残留 | ✅ `2fd3643`（纯注释；全仓 `is a pass-through` 命中 0） |
| t12 更正 mimo-markup-hygiene 测试里的反向注释（t10 的 N3） | ✅ `2655fa3`（注释 + 用例名；突变实测 4 绿 1 红、唯一红的是 en-US 那条） |
| t13 修正 extraction-queue 反向注释 + feedback 单测改走生产实现（t10 的 N1/N2） | ✅ 完成（产物在队长提交中；反事实让单测层红 1 例：actual −0.008 vs expected −0.02） |
| t5 集成收口：文档同步 + 全量门禁 | ✅ 本文 §2.19/§4 就是它的产物；门禁数字见 §0b 与本次回报 |

**Phase 2 —— 工具链逐入口覆盖（不要写「语音与文字共用同一条工具链」这种笼统话）**：
`scripts/field-test.ts` 的 `buildToolChain(config)` 是唯一构造点，注册表现在是**三个内置**工具
（`xixi_get_current_time`、`xixi_get_weather` 是 `risk: read`；`xixi_set_reminder_stub` 是 `risk: write`）
——**V0.3 P2-D 起 `xixi_news_stub` 已从注册路径删除**，新闻改由 `packages/plugins/news/` 的三个插件工具提供
（插件与 MCP 的工具在装配点 `mountPluginTools()` 复制进同一个注册表；四个 live 入口**还没走这条路**，见 §9），
可见性再由 `listForAgent(scope)` 过滤（V0.3 P2-B 起是「除 deny 之外都广告」，见 [ADR-0018](adr/0018-tool-approval-frozen-args.md)）。**四个 live 入口**——文字 CLI `scripts/chat.ts`、设备自检 `scripts/voice-device-check.ts`、
真人感评测 `scripts/eval-realism.ts`、对话评测 `scripts/eval-conversation.ts`——都改用它；控制台与试用页/语音本来就走这条链。
离线自证（本轮实跑，四行逐字相同）：`node <入口> --print-wiring` → `language` 取自部署配置、`maxToolRounds: 4`、**三个工具**、三个 `allow`，不调模型、不建库
（P2-D 删掉新闻占位之前是四个；数字会随工具集变，**以实跑为准**）。
**设备自检没有离线端到端证据**（要真实 WAV + 硬件 + 真实 ASR）：它的证据是上面这行 + 与适配器共用一个 `deviceToolChain` 调用点。
`--fake` 现在注入内存天气源，所以「完全离线」的承诺在接入工具后仍成立。

> **V0.3 P2.5 注（2026-10-08）**：上面这一段是**第四轮当时的读数，保留不改**。入口与工具集今天都变了：
> 唯一装配点是 `packages/runtime/src/resident-runtime.ts` 的 `createResidentRuntime()`，入口取 `runtime.toolChain`，
> 插件工具（含 `news.*`）真的在入口的模型可见清单里（`git grep -n 'buildToolChain(' -- scripts ':!scripts/verify-p2-5.ts'` 应 0 命中）。
> 逐条明细见本文 **§12**。

**语言接线的口径（§9.13 更正，别再写成「堵住了一条会泄漏的通道」）**：`MimoBrainAdapter` 的 `language` 取自 `config.identity.language`，
**省略时构造回落 `zh-CN`**（`options.language ?? 'zh-CN'`）——中文清洗规则对每个部署照常生效，省略不是直通。
这条接线的价值是**让过滤器跟随部署语言**：非中文部署不再被中文规则改写（zh-CN 那侧不传选项也过，真正承重的是 en-US 那侧）。

**Phase 3 —— 未完话题的设计取舍（第三轮 t7 评审 F3 要求的落档；④ 是第五轮 t2 的升级）**：
① **收口判据**：被问过之后，只有**提到那件事的对象词**（话题里没有对象词时用有辨识度的动作词）的那一轮才算回答
（`isAnswerAboutThread`）；对不上的轮次进
`ReconcileResult.ignored`，**不写事件、不改状态**，话题留在 `offered`，由既有的 `reofferAfterMinutes` / `maxAttempts` /
`expireAt` 在窗口内放回候选——所以「他随口聊句别的」不会静默丢一件事。
**判据的单位是词 / 对象，不是字**（第五轮 `t2` 升级，见 ④）。
② **来源只实现了一个**：`TOPIC_SOURCES` 列了 9 个来源，只有 `open_thread` 有真实生产者，其余是契约占位（`live=false`）。
③ **面板的只读 GET 会推进状态**：`/api/field/proactive` 的 `proactivePayload()` 会先 `topicEngine.reconcile(at)` 再报告——
刷新页面会写事件、推进话题状态（reconcile 幂等，重复刷新不会多记事情），但它与常驻考虑循环并发，见 §4 第 17 条。
④ **判据从「字」升级到「词 / 对象」（第五轮 t2，2026-10-01）**：第四轮时判据是**字**级，共享一个内容字（通用动词 买/看/吃/拿、
常见名词）就会误收口——实测两个靶子各 **1/13**（「明天我要去买药。」+「我去楼下买了点水果。」、
「明天我要去看孙子。」+「老李家的孙子回来了。」，后者的变体「隔壁老王家孙子回来了。」同样中招）。
升级后：对象词受控词表（`OBJECT_WORDS`）+ 动作词须说得一样完整 +「别人的」框（姓 + 家 / 隔壁 / 邻居 / 人家；
第一人称与否定式不算），通用动词编进 `FRAME_WORDS` **永不单独作依据**，三张表的关系由模块加载期的
`assertVocabularyShape()` 把关（放错表就启动即崩）。**代价是有意选的**：不提那件事的真回答（「没去成，改天再说吧。」
「不去了。」）会被当成不相关、过一阵子再问一次——多问一次有界可见，静默丢一件事无界。
**ADR 状态：已采纳（[`adr/0012`](adr/0012-open-thread-closure-criterion.md)）**——判据升级与实测结果都写在那份 ADR 里
（不再是「待定」；升级本身也已经落地，不需要再补一份）。数字见 §2.20 ② 与 ADR-0012 §判据升级。

**Phase 4 —— 逐入口覆盖与局限（第三轮 t9 评审 F4 要求的落档）**：
① **哪些入口写记忆/学习**：现场测试控制台（`scripts/field-test.ts`）与试用页（`scripts/serve-chat.ts`）；
`scripts/chat.ts` 与 `scripts/voice-turn.ts` **未接 `afterTurn`**（那两个入口不写记忆、不学习，本轮只给它们接了工具链与语言）。

> **2026-10-08 加注（V0.3 P2.5-C）**：上面这条是**第三轮当时的覆盖情况**，原文保留；**今天不成立**——
> `chat.ts` 与 `voice-turn.ts` 都走常驻装配点 `createResidentRuntime()`，`afterTurn` 由装配点接到共享提取器，
> 四个入口都写记忆/学习。行为证据（各入口读自己写下的库）：`tests/console/entry-after-turn.test.ts`。
② **推断分支已接线**（第四轮 t4，此前是死代码）：`ConversationEngine` 每轮从同会话的 `proactive.decision.model_reason_code` 取
「他上一条轮次之后、这一条轮次之前」**最新一条带码**的读法，取不到就 `null`（宁可不学，也不瞎归因）；
只在白名单且偏移表里有定义的码才学（`good_moment` 取到也不学）。**权重只乘一次**：解释器给名义值、`SelfModel.learn` 按
`sourceType` 乘一次（显式 1.0 / 推断 0.4）——实测名义 −0.05 落库 **−0.02**；乘两次会变成 −0.008（名义 ×0.16，接线前就是这样）。
同轮里显式纠正压过推断码（不是叠加、不是平均）。
③ **漂移上限让出厂 `talkativeness` 进不了提示词低档**（§7.4 的设计取舍）：低档阈值 0.4，而漂移到底只到 0.45。
④ **提取队列的退出兜底**：`enqueue` 时装唯一一个 `process.once('exit')` 钩子，退出那一刻 `drainOnExit()` 同步跑完队列；
跑不掉（库已关、规则抛错）才往 stderr 写一行，含丢几轮与会话/轮次事件 id（可回日志重放）。**它只覆盖正常退出**
（`process.exit()` 与事件循环空了）；**强杀与断电仍会丢**——那种情况要持久化待办，而持久化需要新事件类型与表，本轮没做（如实标注）。
⑤ **记忆只有领域 API**（可查看/编辑/删除），没有 UI。

### 2.20 第五轮：主动性口径、话题判据升级、流式语音、有界心情（2026-10-01/03 收口）

> 本节的数字都来自当次运行，**每条都带可复跑命令**；延迟类数字**必须连同批次一起引用**（本机接口延迟波动极大，
> 见 `handoff.md` §4 第 5 条）。第五轮四条工作各自的评审/复验报告在 §2b 与 `docs/verification/`。

**① 主动性：口径已定＝显著降频（不做「= 0」硬停）**

- **口径**：采纳「**显著降频**」，**不做**「连续两次未回应后 = 0」的硬停（理由：硬停与 [ADR-0011](adr/0011-proactive-decision-ownership.md)
  的两层设计冲突、与用户诉求相反）。**「= 0」这条更严口径在真产物上仍不成立**——这是事实，要照写，但**不再是待用户定的问题**。
- **多日验收（实现方交付的判定命令）**：`node scripts/eval-proactive-timeline.ts`（默认三天，判定 M1–M6 进退出码）。
  最近一次实跑（**2026-10-03，exit 0**）：单日五项目标 + F4 分离探针 + 多日 6 项全过；多日逐日
  `multi-responsive 8/8/11`、`multi-unanswered 6/8/8`（第 3 天仍开口）、`multi-unanswered-nopenalty 7/8/11`、`multi-crossday 8/8/11`。
- **独立复算（第五轮 t7，自驱 `ProactiveLoop` 三天、tick 120 s、出厂 config）**：有人回应 **12/12/12**、
  没人回应 **5/5/5**（第 3 天仍开口 → 没有硬停）、**同脚本只把 `unanswered_penalty` 置 0 → 11/11/11**（整段 15 vs 33 = **降 54.5%**）；
  惩罚阶梯 0 → 0.675 → 0.9 单调，3 条未回应时建议 `hold`。**两套数字不是同一批**（场景脚本与「回应怎么安排」不同），引用时写明来源。
- **复跑**：`node scripts/eval-proactive-timeline.ts`；独立复算的探针是 gitignored 的 `data/verification/t7/t7-timeline-probe.ts`（只作附件）。
- **已知边界**：跨天追问条数与话题 id 依赖事件时间戳，**不逐次复现**（判定看 M1–M6，不看某次的条数）。

**② 话题收口判据：从「字」升级到「词 / 对象」**

- **收益**：13 句无关探针 × 7 个话题 = **0/91** 误收口（升级前两个靶子各 **1/13**：买药 / 看孙子；第五轮复验另测到
  「买菜，家里的油也没了」话题下也有中招形态）。
- **召回不降**：升级后补的 15 句真答案 **15/15** 收口；t8 那张 9 句表仍是 7/9（**同样的两句不收口**，与升级前一致）。
- **反事实（证明升级真的承重）**：把**升级前整份 `topic-engine.ts`** 换回来跑同一条 `reconcile` 路径 → **9/91 误收口**（两个靶子都在），
  召回同为 15/15。复跑：`node data/verification/t7/t7-topic-probe.ts`（gitignored；用 `git show 1e08e5f^:…` 取旧源码，不改仓库文件）。
- **实现方测试**：`node --test tests/unit/core/topic-engine.test.ts tests/integration/open-thread-followup.test.ts`（25 项 pass、0 fail）。
- **取舍与边界**（详见 [ADR-0012](adr/0012-open-thread-closure-criterion.md) §判据升级）：词表是**受控清单**不是分词器（没登记的名词等于没有对象词，
  退回动作词那条）；「别人的」是小词表；动作词要说得一样完整；只有通用动词的话题（「买东西」）退回「等过期」。
  代价：不提那件事的真回答（「没去成，改天再说吧。」「不去了。」）仍不算回答 → 窗口内**可以再问一次**（有界、仍要过硬门禁与社会预算）。

**③ 流式语音（pack Phase 8）：接线成立 + B1 已修 + B2 是已知未覆盖缺陷；首音目标未达标且本机不可达**

- **口径（先钉死再看数）**：四段——① 端点→ASR 出字、② ASR 出字→模型首 token、③ 首 token→首段可听、
  ④ = 端点保持 + ① + ② + ③。**pack 的 1.5 秒指 ④（不是 ③）**，③ 只是归因量。
- **实测（8 批 n=32：t9 两批 + t11 三批 + 第五轮复验新跑三批）**：逐批 ④/1500 = **[3.14, 7.33] 倍**；
  **池化** ④ P50 = **5597.5 ms = 3.73 倍**；**31 个有效值无一 ≤1.5 秒**。复验自己三批的 ④ P50 =
  10994 / 10291.5 / 5442.5 ms（2026-10-03 跑，产物 `data/voice/bench/t7-legacy-batch1|2|3.txt`）。
- **同批对照（流式 vs 整段）方向不一致**：**3 快 5 慢**，幅度 **−16.1% 到 +27.3%**——
  **不许写「方向多数为正」，也不许拿任何单批百分比当结论**（结论以工具算的为准）。
- **为什么不可达**：② 的**逐批 P50 实测 903.5–8162.5 ms**（8 批 n=32；5 批的现算口径是中位 1636 ms、区间 904–2363 ms），
  **中位数本身已超过 1.5 秒**，最慢的一批 8162.5 ms——单这一项就吃掉整个目标；③ 的**逐批 P50 实测 1393–2582.5 ms**，
  地板是 MiMo TTS 单次往返（约 1.0–2.0 s 量级）。**这是目标不可达，不是实现缺陷**——不要因为达不到 1.5 秒判代码不合格，
  也不要用 ③ 的「超 15%」口径冒充它。
- **打断与 backchannel**：`npm run voice:bargein`（离线、0 次调用）与 `--strict` 的可听停止台账是这两项的证据；
  「嗯」这类应和音**不结束用户轮次**（`ASSENT_ONLY`，不调模型不调 TTS；两条页面的判定在 `field-test.ts` 与 `serve-chat.ts`）。
- **产物的静默说明**：`data/voice/bench/` 下较早的几份产物（`t9-legacy-batch1|2`、`t11-batch1|2|3`、`voice-turn-batch`、
  `t7-legacy-batch1|2|3`）是**真实付费跑出的原始测量**，其中一部分内部的 `latency.note` 还是**生成时的旧文本**
  （写着「方向多数为正」之类）。**它们保留、不重跑**（重跑花钱且不产生新信息），但
  **结论一律以 `node scripts/voice-turn.ts --compare <产物…>` 现算为准**，不要引用产物里的 `note` 当结论；
  新批次不再预置结论句（t21 已把 `voice-turn.ts` 的 `note` 与 `voice-latency.ts` 的 ②/③ 地板都改成由产物计算）。
- **措辞纪律（第五轮复验明确要求）**：只能写「**接线成立 + B1 已修 + B2 是已知未覆盖缺陷**」，
  **不得写「流式逐块播放已验收」**（没有端到端听感实测）。B2 = 投递泵在某个块 TTS 失败后不再交付后续已合成块
  （失败块不推进 cursor，后继块被憋到 `flush()`），现有用例只钉「失败块被如实报告」，没钉「后继块何时发出」。
  **「接线成立」这一半的证据在默认门禁里**：`tests/console/voice-streaming-console.test.ts`（真进程 + 内联 TTS 桩：序号不重复、
  升序连续、`playCalls === end.clauses`）与 `tests/unit/voice/voice-stream.test.ts` 里把 `XIXI_PLAYBACK_JS` 真的丢进 `node:vm`
  执行的用例（浏览器播放规则不是靠读字符串）。
  **没有做的**：真人听感、真实浏览器的端到端回放、B2 的「后继块何时发出」。
- **复跑**：产出一批 `node scripts/voice-turn.ts --wav <夹具> … --trace --out <产物>`；复算
  `node scripts/voice-turn.ts --compare <产物…>`（不调 API、不需要 key）。

**④ 有界的心情状态（第五轮 t4）**

- **是什么**：两个有界标量（`valence` / `energy`）+ 8 条封闭信号（被夸 / 被嫌 / 被叫停、主动被回应与否、到家、6 小时无人、按小时回落与时段牵引），
  由**原始事件**演化（不存模型推理，铁律 5），散文注入提示词的 `system`（数值只进 `sections[].debug`）。
- **上下界是结构性的**：所有写入路径都返回同一个 `clampMood`，读路径再夹一次。**独立复算**（第五轮 t7）：
  8 种坏 delta × 1000 步、8 信号 × 6 角点 × 500 步、10 万步轮换（信号 + 回落 + 时段）、坏时长/坏时段参数 = **0 越界**；
  把库手改成 `(valence=5.5, energy=-3)` 后 `store.mood()` / `engine.current()` / `stateAt()` 全部落回 **(1, 0)**。
- **影响轻微**：语气缩放 ∈ **[0.9400, 1.0600]**（= 1 ± `MOOD_TONE_SPAN` 0.06，乘在人格算出来的窗口上，人格那侧是 0.5–1.5）；
  主动性软偏移 ∈ **[±0.03]**（`MOOD_PROACTIVITY_NUDGE`，刻意取 §7.4 隐式反馈的最小步长）。
- **不越硬底线**：`ProactiveGateContext` 里**没有**心情字段；同一组门禁输入在心情高低两侧得到**同一个 `reasonCode`**
  （静默时段 `QUIET_HOURS`、白天 `PASSED`、隐私不允许 `PRIVACY_BLOCKED`、场景不可用 `SCENE_UNAVAILABLE`、对话中 `CONVERSATION_ACTIVE`、DND `DND_ACTIVE`）。
- **不编造实体经历**：散文里没有数字与参数名；28 段散文里**没有**「我出去买菜了」式经历句式，且每组都带收尾句
  「这只是你此刻的情绪，只影响你说话的样子：不要因此说出你没做过的事，也不要描述身体上的感觉。」
- **可查看 / 可复位**：`XixiStore.mood()` / `moodHistory()` / `moodSnapshot()` / `resetMood(reason)` / `moodSchemaVersion()`；
  复位留一行 `reset=true` 的历史（不是删行）。
- **仍然是「尚未实现」（不得写成已实现）**：① **控制台面板**没有（只有领域接口与 `ConversationEngine.moodStatus()`）；
  ② **心情没有接进主动引擎的软评分**——`moodProactivityNudge()` 在产线里**没有消费点**（唯一真实去处是对话窗口的 ±6%）；
  ③ **心情没有写进 `conversation.decision`**（那要改已发布契约的 `additionalProperties: false` payload）。
- **两条已知问题（第五轮 t7 交回）——已在 V0.3 P0-E2 清掉**：① `store.resetMood(reason, at)` 的时间戳归一进 `recordMood`
  这个唯一写入漏斗（`Z` 写法转本地偏移，已是数字偏移的字符串按字节保留）；② `moodBias` 保留**相加后夹**语义、注释改回与公式一致
  （`±6%` 的两处表述也钉住相加语义）。回归用例：`tests/unit/core/mood-reset-timestamp.test.ts` 与 `tests/unit/core/mood-bias-semantics.test.ts`。
- **口径与证法**：[ADR-0013](adr/0013-bounded-mood-state.md)；独立复算的命令与逐项数字见
  [`verification/t7-round5-independent-verification-2026-10-03.md`](verification/t7-round5-independent-verification-2026-10-03.md) §2.4。

**门禁（本轮收口实跑，**同一次运行**）**：`npm test` → `ℹ tests 470 / pass 470 / fail 0`、exit 0（含 t20 新增的语音路由用例，
它会跑一次真实 Python VAD，全量因此从约 26 秒变成 **37–40 秒**；**不许靠删断言或把用例移出默认门禁来提速**）；
`npm run check:docs` → 检查了 **97** 份 markdown、失效链接 0、不存在的文件引用 0、缺少新鲜度标记 0、exit 0。
（数字是**当次快照**：要现状自己跑，别抄这里的数。）

## 2b. 评审与验证汇总（本轮）

**四份实现评审的 verdict 与 findings 去向**（findings 编号与严重度取自各自报告；「闭环」= 复审已 pass）：

| 评审 | 对象 | verdict | findings | 修复任务 | 复审任务与结论 | 是否闭环 |
|---|---|---|---|---|---|---|
| **t7** `voice-implementation-review` | t2 语音前端 | needs_revision | F1 medium / F2 medium / F3 low / F4 low / F5 info | **t23**（round-2/3） | **t24** needs_revision（F1 残留）→ **t38** 修复 → `voice-repair-round-3-review` **pass** | ✅ |
| **t8** `perception-implementation-review` | t3 摄像头在场 | needs_revision | F1 medium / F2 medium / F3 medium / F4 low / F5 low / F6 info | **t26** | **t27** `perception-repair-review` **pass** | ✅ |
| **t9** `console-implementation-review` | t4 现场测试控制台 | needs_revision | F1 low（自检项数已漂移） | **t29** | **t30** needs_revision（F1 medium + F2–F5 low）→ t45 → round-3 仍 needs_revision → 后续 t53/t59/t64 逐处订正 | ⚠️ 文档数字链仍在收尾（每次复审都能抓到新的漂移） |
| **t10** `core-wiring-review` | t5 核心接线 | needs_revision | F1 low / F2 low / F3 low | **t31** | **t32** `core-wiring-repair-review` **pass** | ✅ |

**t10 评审 F3 的教训（必须记住）**：任务回报里的测试计数是**当时快照**——t5 报「87/87」，而写这一段时的实测是 209 项
（2026-09-30 的最近实测点已到 223 项，见 §0b）。引用任何他人回报里的数字时**必须注明时点**，不要当作现状；
本文件里的计数一律写成「以实跑末行为准 + 带日期的实测点」，不写当前值。

**独立验证（不是实现者自述）**：`docs/verification/` 下 2 份——多段回复与主动性门禁（t43：27/27 门禁用例、
投递恰好 1 次、崩溃后绝不重发、6h 额度实测 4 = 配置上限）、现场测试控制台（t4 的独立验证）。
**评审报告**共 20+ 份在 `docs/review/`（含 6 份复审），verdict 分布与观测都留在各自文件里。

**2026-10-01 一轮（P1 提示词/长度 + P1c 指标 + 主动性 V2 + 制品清洗）**：

| 任务 | 报告 | verdict | 去向 |
|---|---|---|---|
| t6 评审 P1 提示词与长度策略 | [`review/p1-prompt-length-review-2026-10-01.md`](review/p1-prompt-length-review-2026-10-01.md) | needs_revision | F2 口径 / F3 安全措辞 / F4 claim → **t16** 修复；**F1 文档漂移 → 本收口任务 t5** |
| t17 复审 | [`review/p1-prompt-length-rereview-2026-10-01.md`](review/p1-prompt-length-rereview-2026-10-01.md) | **pass** | 三条 finding 独立复核成立且可复现；O1 更正了「8 次独立捕获」的措辞（已落 §2.18 与 benchmarks 文档） |
| t7 评审制品清洗 | [`review/reply-hygiene-review-2026-10-01.md`](review/reply-hygiene-review-2026-10-01.md) | needs_revision | `REPLY_HYGIENE` 当时**没有产线消费者** → 2026-10-01 第四轮重核：试用页（`serve-chat.ts`）与控制台（`field-test.ts`）已订阅 `onNotice`、沉默原因码 `ARTIFACT_ONLY_REPLY` 上线；`chat.ts`/`voice-turn.ts` 仍未订阅（§4 第 10 条） |
| t4 独立验证「真人感」 | [`verification/t4-realism-verification-2026-10-01.md`](verification/t4-realism-verification-2026-10-01.md) | **通过** | 三次输入独立复算、铁律未削弱；它自己的提问率主口径结论与 §2.18 同源 |
| t9 独立验证主动性 V2 | [`verification/t9-proactive-v2-verification-2026-10-01.md`](verification/t9-proactive-v2-verification-2026-10-01.md) | **failed**（引擎机制成立，但 pack Phase 5 两项时间线验收未达标）——**其六条缺陷已由第三轮 t1 修复、t2 独立复验、t3 评审 pass**（`626c201`；generic 18.2%、热聊接话 8 次） | 口径已拍定 **显著降频**（不做「= 0」硬停，[`adr/0011`](adr/0011-proactive-decision-ownership.md) 决定 2 的补充 + 第五轮 t1）；**pack 更严的「连续两次没回应后继续主动 = 0」仍不成立**（这是事实，不是待决问题）——**不得写成已全通过**。ADR-0011 已记录（`efa6dbe`） |
| t7 独立复验第五轮四条工作 | [`verification/t7-round5-independent-verification-2026-10-03.md`](verification/t7-round5-independent-verification-2026-10-03.md) | **四条都有独立复算**：① 多日主动性达标（显著降频口径；自驱三天 12/12/12 与 5/5/5、惩罚置 0 则 11/11/11 = 降 54.5%）、② 话题收口达标（0/91、真答案 15/15、反事实 9/91）、③ **首音延迟未达标（目标不可达）**、④ 心情达标（0 越界、语气 ±6%、软偏移 ±0.03、门禁同码） | ③ 的措辞纪律：只能写「接线成立 + B1 已修 + B2 是已知未覆盖缺陷」，不得写「流式逐块播放已验收」；它交回的两条心情已知问题记进 §4 第 26 条 |

**2026-10-01 第四轮（`xixi-v02-round4`：pack Phase 2/3/4 收尾 + 文档收口；台账见 §2.19）**：

| 评审 | 结论 | 说明 |
|---|---|---|
| t7 评审 t3（未完话题收口挂钩） | **needs_revision** → t8 修复 → t9 复审 **pass** | R1（通用字表少「去」）与 R2（弱证据路径用未过滤字表比字）都由评审实测复现；修复后 13 句无关句误判 **6/13 → 0/13**（t9 用自己的探针独立复测成 **4/13 → 0/13**），代价是真答案探针 9 句里 **7 → 6**——唯一新增漏判正是被钉住的「没去成，改天再说吧。」（有意取舍：多问一次有界、静默丢一件事无界） |
| t10 评审 t4（推断接线 + 权重只乘一次） | **pass** | 反事实：把落库换回「已乘权重」的值 → 集成用例红 2（actual **−0.008** vs expected **−0.02**），显式侧 −0.12 一字未变；「强杀与断电仍会丢」的诚实边界经核对属实（字段与命令见 §2.19 Phase 4 ④） |
| t10 的三条非阻塞观察 N1/N2/N3 | 已由 t12、t13 收尾 | N3 → t12（`mimo-markup-hygiene` 的反向注释与用例名，突变实测唯一红的是 en-US 那条）；N1/N2 → t13（extraction-queue 反向注释；feedback 单测改走 `TurnMemoryExtractor.runJob`，反事实下它自己红 1 例） |

**t29 负责的三份文件（`docs/testing.md` / `README.md` / `docs/handoff.md`）**：本轮只做**最终一致性核对**，
未重复修改（遵守派单约束）。**核对结论（当时）：仍有漂移，需另派单订正**——（现已在 t90/t94 收尾，见下）
`docs/testing.md:5` 写「实测 **180 项**：unit 124 + integration 30 + perception 11 + console 15」，
同文件 `:132` 又写「实测 **139 项**全绿」（同一份文件两个数），`docs/handoff.md` 两处写「实测 139 项」
（还带「空载约 27–30s」的耗时旧结论）。**核对当时**实测是 `npm test` 209 项、`--self-test` 31 项（本文件 §0b；
这两个数今天也已过期——t90/t94 已把三份文档改成「以末行为准 + 带日期实测点」）。
三处数字都应按「以实跑末行为准」改写（`docs/design/README.md` §3 规则 13 与 `AGENTS.md` §9.18 都是同一原则）。

## 3. 关键决策

| 决策 | 理由 | 记录 |
|---|---|---|
| MiMo 走 DSH 官方 pi-ai 配置路由，不自写 provider 插件 | 声明式、零耦合；自写插件会与 DSH 内部绑定 | ADR-0002 |
| DSH_HOME 放项目内 `.dsh/` | 可复现、可整体删除、不污染用户全局 `~/.dsh` | ADR-0001 |
| 只有 `brain-adapter` / `apps/brain-dsh` 接触 Harness | 方案 §25 / 铁律 9 | ADR-0001 |
| 事件日志是唯一事实来源，轮次不另建表 | 方案 §2.2 | ADR-0003 |
| PoC 不引入 MQTT broker；写入方在进程内**直接调用领域层**落库（`appendEvent` / `recordTurn`），尚未抽 EventBus 抽象 | 本机无 Docker；`xixi.event.v1` 契约不变，换 broker 不影响上下游 | ADR-0004 |
| 会话与 Harness 会话的映射放在领域层、按 provider 键控 | 换 Harness 不丢「同一个西西」 | ADR-0005 |
| Node 原生 TS + `node:sqlite`，唯一运行依赖 `js-yaml` | 减少工具链与依赖面（这台机器易崩） | ADR-0006 |
| 每轮一个 `dsh` 进程 | 让「重启恢复」成为默认行为而非特例；延迟代价在 M1 用常驻宿主解决 | ADR-0001 / 本文 2.2 |
| 提示词前缀说「**她是谁、怎么说话**」，不是编号规则清单 | V0.1 的 `回答通常 1~3 句` 这类规则把每轮都压成同一种形状（客服感的来源）；安全边界改成紧凑散文 + 关键词锚点，靠测试钉住而不是靠编号 | 本文 2.18 / [design/conversation.md](design/conversation.md) §2 |
| 回复上限 3 段 → **8 段**（块长仍 60，容量 180 → 480 字） | 长解释不该被挤成 2–3 大块（V0.1 实测单段最长 341 字）；上限本身继续保留（防刷屏、保打断窗口） | [ADR-0010](adr/0010-multi-segment-replies.md) 修订记录 |
| 主动行为的**决策归属**：硬底线归程序，底线之上归模型读空气 | 「高主动性 ≠ 高频打扰」不能靠单一阈值一票否决；冷却/话题重复/未回应改成扣分项，审计仍只存 `reason_code` 与分数 | [ADR-0011](adr/0011-proactive-decision-ownership.md) |
| 真人感指标**口径唯一**：分母＝真正说出来的开口轮，主口径＝末句以问号收尾 | 旧口径（含问号、把引擎修复句算成模型行为）会把 46% 读成 62–70%，同一份数据得出相反结论 | 本文 2.18 / [benchmarks/realism-metrics.md](benchmarks/realism-metrics.md) |

## 4. 下一步 / 未完成项

1. **M6 的真人自测（唯一还没由人跑过的关键项）**——**原样**照跑，不得用合成图或外部图片冒充：
   ```powershell
   cd E:\worker2
   node scripts/verify-camera-presence.ts --seconds 40 --require-transition
   ```
   做法：跑之前确保画面里**没有人**，运行中**走进画面再走出**（`--require-transition` 要求真的看到一次翻转，
   敲错参数会中文报错而不是静默通过）。**跑完把输出回填本文件**（贴命令、时间、帧数、`present` 翻转次数、
   `confidence` 与磁盘图像文件数），并更新 §0 结论表里「摄像头在场检测」的状态。
2. **M2 唤醒与搭话判定**（当前最大功能缺口）：`wake_word: false`，首句靠 UI 按钮视为已直呼。
   需要：自定义唤醒词（openWakeWord 路线，另有 `E:\worker\models` 里已验证过的 sherpa-onnx KWS 用法可参考）+
   说话人相似度 + 会话状态 + 语义承接的融合判定（§13）。**两家语音框架都无法区分电视与真人**（ADR-0007），必须自己做。
3. **真实麦克风的人耳确认**：回采余量 FAIL（2.41 dB）已解释（§2.14），但「用户对麦克风说话能否被听到」
   仍需真人跑 `node scripts/voice-device-check.ts --wav <录音> --expect "<原文>"`；噪声下的真实对话响应也会变慢（§2.13 第三条）。
4. **生产入口的常驻语音服务**：runner 已有常驻 Python worker，生产入口（`serve-chat.ts` / `voice-turn.ts`）仍是每次一进程。
5. **三条文档-实现一致性待办：都已收尾（留档，别再当待办）**：
   - 计数类：`docs/testing.md`、`docs/handoff.md`、`README.md` 与本文件里写死的测试项数（曾出现 180 / 139 / 209 三个数并存）
     已由 **t90 / t94** 全部改成「以 `npm test` 末行为准 + 带日期的实测点」。
   - `docs/adr/0010-multi-segment-replies.md` 三处「**没有任何生产入口传 `onSegment`**」已由 **t82** 订正：
     `scripts/chat.ts` **已经传了**（核对：`git grep -n "onSegment" -- scripts`）；**第五轮又更正了一次**：
     音频出口现在走**按句读流式切块**（`onClause`，见 §2.20 ③），`voice-turn.ts` 仍整段合成（它是测量入口的对照列）。
   - `docs/design/conversation.md` §6/§7 的「播放侧尚未接线」已由 **t82** 改写；同表「主动开口」行的「没有候选生成器 / 没有常驻循环」已由 **t84** 改写。
   **仍然有效的规则**：改文档时不要写死测试总数、文件数或耗时——只写「以实跑末行为准」加一个带日期的实测点。
   （t54 的前瞻观测成真：接线落地的那一刻，那几处就变成了假话。）
6. **已知小项（下次动那两处时顺手改）**：`conversation.md` 里 `confidence` 字段的括号说明容易被读成「也是 1/0」
   （实际是 1 或 0.5）；`packages/domain/src/store.ts` 的 `toStoredEvent` 不回填 `sessionId`（低危：列已写入、按 sessionId 过滤仍正常）。
7. **M3 人格反馈**：「你话太多了」→ Feedback Interpreter（结构化输出 + 受控增量 + history + 回滚），
   当前只有管理员的 `overrideSelfProfile`（控制台面板走的就是它），**模型驱动的学习尚未实现**。
8. **M4 Memory**：当前只有会话内工作记忆（最近 8 轮）；长期记忆、纠正优先级、FutureHook 都还没有。
9. 已知待补：`tsc --noEmit` 类型检查、`tests/replay/`（§22.3 回放属 M5）。
10. **`onNotice` 的订阅覆盖不齐（2026-10-01 第四轮重核，只记录）**：`REPLY_HYGIENE`（工具标记/英文推理被剔除）与
    `UNBACKED_FACT_CLAIM`（未核实的具体值被扣住）两条审计通知**试用页（`scripts/serve-chat.ts`）与控制台（`scripts/field-test.ts`）
    已订阅**并显示「沉默原因」；`scripts/chat.ts` 与 `scripts/voice-turn.ts` **仍未订阅**——那两处仍与「模型本来就这么说」同形。
    评审的建议见 [`review/reply-hygiene-review-2026-10-01.md`](review/reply-hygiene-review-2026-10-01.md)。
11. **`SILENCE_ARTIFACT_ONLY` 只是评审提出的候选名字**：实际落地的原因码是 **`ARTIFACT_ONLY_REPLY`**
    （`ConversationTurn.silenceReason`，与 `MODEL_SILENCE` 并列，见 `packages/conversation/src/engine.ts`）；
    候选名**从来没有进过代码**，落文档时不要把候选名当现状、也不要再写「轮次只报 SILENCE」。
12. **控制台 `proactiveSettingsToConfig` 不回写部分设置**（t63 既有；本轮新增的 `max_consults_per_day`、
    `new_session_min_gap_min`、`hot_chat_*` 同此）：私有配置覆盖文件里调过这些键后，再用页面保存任一参数会回落默认
    （模板见 `config/xixi.example.yaml`；本机没有私有覆盖文件）。
13. **黄金语料仍缺 quiet-hours 硬底线用例**（t9 §4.3 的建议）：动语料会连带改真人感报告的数字，所以留到有明确需要时再补。
14. **DSH 插件面 `plugins/xixi-tools` 仍只注册两个工具**（时间、天气），而直连路径的 `defaultTools()` 有四个——
    两条路径的工具集合目前不一致（[`design/security-and-privacy.md`](design/security-and-privacy.md) §2 已如实标注）。
15. **`agent-loop` 的工具时钟是「回合开始快照」**（T5-F2）：`context.now` 在进入循环前求值一次并原样转给每个工具，
    一次多轮工具调用里工具看到的是回合开始的时间（亚分钟级；修法见 finding 的 requiredFix）。
16. **「内部字样」的断言词表有两份**（T5-F4）：`tests/console/field-test-console.test.ts` 与 `tests/unit/core/tool-loop.test.ts`
    各持一份**重叠但不等**的正则；两处都不是 `createSpokenTextFilter` 的真实回归（那份在 `tests/unit/core/engine-reply-hygiene.test.ts`）。
17. **只读 GET `/api/field/proactive` 会 `reconcile`**（t7-F2）：面板刷新会写事件、推进话题状态，且与常驻考虑循环并发。
    reconcile 是幂等的（重复刷新不会多记），但「只读接口有写副作用」这件事必须知道。
18. **`runJob` 共享一次 `try`**（T9-F2）：同一个 job 里只要有一个属性非法，整轮的学习与记忆都不落库
    （`onError` 会收到，但那一轮的其它写入一起丢）。
19. **时钟类假句在流式出口「先吐后撤」**（t10 + t21 定级）：流式路径下含未核实具体值的句子会先交给 `onTextChunk` 再被扣回——
    **显示与延迟层面，不可听**（语音与文字都用最终 `turn.text` 调 TTS）。
20. **「晚上八点一刻」「差十分八点」不在读数范围**（t11 评审）：属口语读法缺口，**不比修复前差**，评审不建议为此改容差。
21. **记忆只有领域 API，没有 UI**（查看/编辑/删除）；写入不新增事件类型（记忆是推导，铁律 4，每行带 `source_event_id`）。
22. **`packages/conversation/src/index.ts` 未登记 t3 的新导出**（`isAnswerAboutThread`、`IgnoredThreadTurn`；
    `ReconcileResult` 已登记）：消费者能读到 `.ignored`，但叫不出它的元素类型；面板或脚本要用时需另派任务补一行。
23. **`scripts/serve-chat.ts` 没有信号收尾**：Ctrl+C 不保证走到提取器的收尾；建议在收尾里显式调一次 `drainOnExit()`/`flush()`
    （提取器自身的 `exit` 钩子已覆盖正常退出，见 §2.19 Phase 4 ④）。
24. **推断读法每轮会全量读该会话的 `proactive.decision`**：`readEvents` 没有「读最近 N 条」的接口，要消掉得先在领域层加接口
    （当前实测开销可忽略，只作为已知成本记录）。
25. **未完话题判据的字级残余（第三轮 t7-F1 / 第四轮 t8-t9；**第五轮 t2 已修**）**：共享**内容字**（通用动词与常见名词都算）的无关句
    会被收口，实测 1/13（两个靶子：买药 / 看孙子）。**第五轮 t2 把判据升级到词 / 对象级后实测 0/91**
    （见 §2.20 ② 与 [ADR-0012](adr/0012-open-thread-closure-criterion.md)）。本条保留作历史；升级后的边界（受控词表不是分词器、
    「别人的」是小词表、动作词要说得一样完整、只有通用动词的话题退回等过期）写在 ADR-0012 的「代价与已知边界」。
26. **`store.resetMood(reason, at)` 的时间戳写法会让 `moodHistory()` 排序错位**（第五轮 t7 交回；**V0.3 P0-E2 已修**）：
    `moodHistory` 按 `created_at` 的**字符串序**排；生产路径走 `toOffsetIso`（`+08:00`）所以今天是对的，但若把 `at` 传成
    `Date.prototype.toISOString()`（`Z` 写法），同一张表里两种写法并存，**真实时间最新的那一行会排到最前**（t7 用探针复现）。
    修法二选一：`at` 参数改成收 `Date`（内部 `toOffsetIso`），或在 `recordMood` 里统一规范成同一种写法。
    **V0.3 P0-E2 选了后者**（归一放进 `recordMood` 这个唯一写入漏斗），回归用例在
    `tests/unit/core/mood-reset-timestamp.test.ts`。
27. **`moodBias` 是「相加后夹」而不是平均，注释写着「平均」**（第五轮 t7 交回；**V0.3 P0-E2 已修**）：
    `bias = clamp((valence − 0.5) + (energy − 0.5), −1, 1)`，所以 `(1, 0)` 与 `(0, 1)` 都读成 **0 = 完全中性**（幅度不满幅）。
    **有界性不受影响**（仍被夹在 ±1，语气 ±6%、软偏移 ±0.03 的上限也照旧成立）；要改的是**注释或公式二者取一**。
    **V0.3 P0-E2 的处置＝保留相加语义、改注释**，回归用例在 `tests/unit/core/mood-bias-semantics.test.ts`。
28. **提问率口径缺单测（t17 的 O2）**：「修复句不进分母」「主口径 ≠ 辅口径时按主口径判带」这两条夹具建议补进
    `tests/scenarios/realism-metrics.test.ts`；现在删掉修复句排除也不会红。该文件不在本轮 inScope。
29. **指标模块的跨包相对导入（t17 的 O3）**：`scripts/lib/realism-metrics.ts` 直接
    `../../packages/conversation/src/engine.ts` 取「修复句的唯一定义」（全仓唯一一处相对跨包导入，理由与披露见 t16 回报）。
    建议后续在 `packages/conversation/src/index.ts` 补一行 re-export 再改回 `@xixi/conversation`。
30. **登记缺口（已收尾）**：`scripts/eval-realism.ts` 已登记进 `docs/testing.md` 的脚本表与「真实 API 验收」行
    （t5 收口时补），`AGENTS.md` §7 由队长补。**重放路径的 `NaN%` 缺陷已修**（运行时记 `run` 序号、
    重放按序号重算 `perRepeat`，老 JSON 回退到「按 scenario 序列重启切分」），两份 benchmarks 报告的逐次表可复核，
    修法与该缺陷的留档见 [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md) §6。
31. ~~**给「页面的 JS 到底能不能跑」加一条自动防线**（本轮新增，**未做**；起因见 §13.1 缺陷 2）：
    仓库里**没有任何测试执行过页面的内联脚本**（没有 jsdom，`tests/console/*` 全是对生成文本做正则断言），
    所以一个「模板字符串里少写一层反斜杠」的转义错误能让**整页按钮全不响应**、而 `npm test` 全绿。
    最小做法：把服务真正发出的内联脚本抽出来逐个解析（`new Function(...)` 或对抽出的文件跑 `node --check`），
    它覆盖的是**一整类**缺陷而不是那一个字符。**不要**用「断言脚本里没有裸换行」这种字符串判据替代——
    那正是漏掉它的那种断言。~~
    → **已由 D0.3 落地（2026-10-10）**：`tests/ui/smoke/page-script.test.ts`（在 `npm test` 里）把服务真正发出的
    每个内联脚本抽出来用 `node:vm` **只编译不执行**，并核对脚本按字面量找的每个 id 在 markup 里存在；
    运行时行为那一层是 `tests/ui/e2e/page-behavior.test.ts`（真 Chromium，`npm run test:ui`，**不在默认门禁**）。
    **边界照实说**：它今天覆盖的是**现场测试控制台的 `GET /`**——试用页与 `apps/demo-ui/` 还没有。
    上面那段原文按 §9.21 保留（它记的是当时的口径与最小做法）。逐条见 §14 与 [`testing.md`](testing.md) §3.2。

## 5. 已完成的委派

- 子代理 A（DSH 集成配方）→ 结论已落入本文 2.2 与 `docs/recon/dsh-integration-2026-09-29.md`。
- 子代理 B（MiMo API 能力探测）→ 结论已落入本文 2.3 与 `docs/recon/mimo-api-probe-2026-09-29.md`。
- 子代理 C（参考文献撰写）→ `docs/adr/0001–0006`、`docs/architecture.md`、`docs/event-contracts.md`、`docs/testing.md`。
- 两个探测子代理均只写入了 `E:\worker2\.scratch\` 与 `E:\worker2\_mimo_probe\`；报告已复制到 `docs/recon/`，这两个临时目录可随时删除。

## 6. 已知限制与风险

- **类型不检查**：Node 直接跑 `.ts`，没有 `tsc --noEmit`；类型错误只在运行时暴露（M1 前补）。
- **密钥泄露**：`MIMO_API_KEY` 曾在聊天中明文出现，**验证完成后必须到小米控制台轮换**；密钥只存在于 `.env`（已 gitignore）。
- **`tool_choice` 不可强制**：不能把「必须调用工具」当硬门禁，只能提示词驱动 + 校验后再决定重试（M3 的 Feedback Interpreter 会受影响）。
- **每轮一个 DSH 进程**：整轮 4–6s，其中相当一部分是 profile 启动；不适合实时语音，M1 必须改常驻宿主。
- **DSH 是 RC**：升级可能破坏配置；必须固定版本，升级前先跑 `npm test` 与两个 verify 脚本。
- **联网搜索对该密钥不可用**：方案里的新闻/天气类话题需要自建搜索通道。
- **单机单进程假设**：`recordTurn` 在事务外先读会话，多进程并发写需要重新审视。
- **已知耦合（后续改进项）**：`scripts/voice-turn.ts` **反向 import** `scripts/field-test.ts`（CLI 依赖 CLI）。
  评审建议把共享核心移到 `scripts/lib/`；**本轮不做，留给后续**。
- **文档与实现的两处已过期表述**（不在本轮 inScope，见 §4 第 5 条）：ADR-0010 的三处「没有任何生产入口传 `onSegment`」
  与 `conversation.md` §6 的「播放侧尚未接线」——`scripts/chat.ts` 已接。
- **`docs/recon/` 层在 t26 时被增补过**（勘测报告的三处内容，captain 决定保留）：recon 是「某一时点的实测快照」，
  但 t26 之后它不是纯快照了——后来者不要以为 recon 层从未被无痕改动；引用时看报告内的订正标记。
- **本轮流程限制（方法论，不是产品缺陷）**：
  1. **契约校验只核对成员声明的 `changedPaths`**——未声明的越界编辑不会被自动拦截，唯一防线是成员如实披露 + 评审逐处核对；
  2. **验收条款涉及的路径若没写进 `inScope`，会把达标实现判成 failed**（t2 / t4 都这样失败过）；
  3. **`deliverables` 与 `inScope` 不一致时，编辑不会进 `changedPaths`**（t26 的实例）；
  4. **任何「全绿 / 已接入」声明必须带修订号与实测输出**；
  5. **全量测试结果要在成员在途编辑窗口之外判读**（`scripts/field-test.ts` 被测试 import，改它会让全队 `npm test` 变红）。
- **第四轮记录的逐条已知缺口**（`onNotice` 覆盖不齐、控制台设置回写、DSH 工具面、agent-loop 时钟快照、内部字样词表两份、
  只读 GET 的写副作用、`runJob` 共享一次 try、流式先吐后撤、口语读法范围、记忆无 UI、`index.ts` 导出、`serve-chat` 无信号收尾、
  推断读法全量扫描、未完话题判据残余）见 **§4 第 10–25 条**——不在这里重复抄写。

## 7. 崩溃后如何恢复

```powershell
cd E:\worker2
npm install                             # workspace 链接 + js-yaml + dsh-tools（网络失败可挂代理 127.0.0.1:7890）
node scripts/install-dsh-profile.ts      # 幂等；重建 .dsh/profile
npm test                                # 离线测试全绿（**项数以实跑末行为准**，别把数字抄进文档）
node scripts/field-test.ts --self-test   # 现场测试控制台离线自检（项数以末行为准）
npm run verify:provider                 # 一次真实调用（需要 .env 里的 MIMO_API_KEY）
npm run verify:m0                       # 两进程重启验收
```

语音侧（M1 前置，已建好，无需重建）：

```powershell
E:\worker2\.venvs\voice-pipecat\Scripts\python.exe -c "import pipecat; print(pipecat.__version__)"
E:\worker2\.venvs\voice-livekit\Scripts\python.exe -c "import livekit.agents; print(livekit.agents.__version__)"
node scripts/make-audio-fixtures.ts            # 需要 MIMO_API_KEY；已有夹具时会跳过
```

Python 3.12 解释器绝对路径：`%LOCALAPPDATA%\Programs\Python\Python312\python.exe`。

然后从第 4 节继续（当前下一项是 M1 选型收尾）。

## 8. V0.3（P0 + P1）收口（2026-10-04）

- **权威入口**：[docs/progress-v03.md](progress-v03.md)（按 Phase 索引：交付、Gate 实测、口径、遗留）。本文是「时间倒序的流水」，两者分工写在 progress-v03 开头。
- **P0 五块 + P1 两块都已落地**：运行时抽取（`packages/runtime`，Step A/B/C）、canonical store（`XIXI_DATA_DIR` → `data/xixi`，
  四个 household 入口默认同库、感知单写者）、typecheck（`npm run check:types`）、replay 基础（`tests/replay/`，注入 Clock）、
  v03-preflight 九项 + SpeechPipeline B2；P1 的 `packages/context`（ContextBuilder + MemoryRetriever + 可信记忆硬策略）与
  关系上下文 / 未完话题进上下文 / 记忆纠正闭环 / 三入口 `afterTurn`。
- **Gate**：`npm run check:types` exit 0；`npm test` 与 `npm run check:docs` 的实测行见 progress-v03；
  `node scripts/eval-proactive-timeline.ts` 约 24 分钟、单核打满，**给它 ≥30 分钟窗口、不要中断**。
- **四条「只记录」的旧结论已失效**（本文件 §2.20 末尾与 §4 第 26/27 条、`docs/design/brain-and-models.md` 的同款表述）：
  `resetMood` 的时间戳归一、`moodBias` 注释与公式一致、`onNotice` 覆盖三入口、只读 GET 不写库、`runJob` 逐步隔离、
  `proactiveSettingsToConfig` 回写、agent-loop 的 `now` 每次调用各读一次、`serve-chat` 信号收尾、`conversation` 索引导出登记
  ——**都在 V0.3 P0-E2 清掉了**。
- **P1 旗舰场景**：V0.3 复验（t15）当时**按原句不成立**（Day1 原句不写记忆 / Day2 原问句召回不过去 / 疑问句被写成偏好事实），
  证据见 [docs/verification/t15-p1-independent-verification-2026-10-04.md](verification/t15-p1-independent-verification-2026-10-04.md)；
  **t22 已修复并入库、t23 复审 pass**（同一份探针前后对照：`injected` 0 → 1、疑问句新增 0 条、召回 5/5、误召回反例 10/10 不召回）。
  仍有边界：Tier 2 未接线、记忆 UI 未做、两条口径边界（复合问句 / 无标记残句）与一条既有截断行为，见 [docs/progress-v03.md](progress-v03.md) P1 遗留。

## 9. V0.3 P2（Agent/Plugin Completion）收口（2026-10-04）

- **权威入口**：[docs/progress-v03.md](progress-v03.md) 的 **P2 段**（交付表、Gate 实测、两个场景、未达标项、四条下一阶段接线项）；
  逐条命令与输出见 [docs/verification/t14-p2-gate-independent-verification-2026-10-04.md](verification/t14-p2-gate-independent-verification-2026-10-04.md)。
- **交付七块**（交付号见 P2 段的表）：插件内核（`packages/plugins/src/*`，九步生命周期 + 五能力 + 四条「插件不能做」的强制点，
  `ToolRegistry` 是升级不是推翻）、MCP 适配器（`packages/plugins/mcp/*`，SDK v2，命名空间 `mcp.<server>.<tool>`，不做高频总线）、
  工具审批（迁移 007 + `packages/domain/src/approvals.ts` + `packages/runtime/src/tool-approval.ts`，**冻结参数摘要** + 拒绝/到期落审计）、
  Provider 三接口拆分（`packages/brain-adapter/src/types.ts`，四个能力退役并注明归属）、
  真实 News（`packages/plugins/news/*`，三个工具 + `news.topics`，四种来源）、
  durable Reminder（迁移 008 + `packages/domain/src/reminders.ts` + `packages/runtime/src/reminder-runtime.ts`，五态 + 时区语义）、
  P2-G 的宾语前置句修复（`lacksObject`）。四份 ADR：0017/0018/0019/0020。
- **Gate（`024cd43`，工作区干净）**：`check:types` exit 0；`npm test` **717 项 pass 717 fail 0**（`duration_ms` 45144.0，exit 0）；
  `check:docs` 三个 0（写入 P2 两份文档后为 105 份）；**时间线不回退**：`node scripts/eval-proactive-timeline.ts` **exit 0、1702.1 秒（≈28.4 分钟）**，
  单日五项目标 + F4 分离探针 + 多日 M1–M6 全过；窗口口径两档照旧（安静约 24 分钟、同期有人跑测试约 34 分钟，本次 28.4 分钟介于之间——同期只做了文档编辑与 `check:docs`），**预算给 ≥40 分钟、不要中途掐掉**。
- **两个场景（pack Phase 2）**：①「今天有什么新闻？」在**交付件的装配点**上真的形成 `news.latest` 工具调用
  （事件日志里 `conversation.turn` 带 `tool_name`；真实 RSS/HN 两次 HTTP）；②「明天八点提醒我打电话。」落 durable 行
  （`due_at 2026-10-06T08:00:00.000+08:00` / `Asia/Shanghai` / `day_relative`），**新进程**读得到 `pending`，到点 tick 后
  `pending → due → candidate` 三条 `reminder.changed` 事件。
- **未达标项（如实写，别读成「都好了」）**：① 四个 live 入口**都还没接线**——新闻工具不在入口的工具链里
  （问新闻她只能回「我查不了」），提醒走的是内存 sink（工具真的被调了但库里 `reminders` 为空）；
  ② 提醒的模型可靠性 **22 次尝试只有 6 次真调工具（27%）**，其余里 4 次回复明说「记下了」而库里没有行；
  ③ MCP 没有对外部/远程服务器验证过；④ 新闻真实来源属手动证据。

  > **2026-10-08 加注（V0.3 P2.5）**：上面四条是 **P2 收口当时的读数，原文保留**。第 ① 条**已由 P2.5 还清**
  > （入口改走 `createResidentRuntime()`、`news.*` 在入口的工具链里、提醒落 durable 表）；第 ② 条**已被 t27 更正**——
  > 「27% 与 4 次假承诺」是一次历史观测（2026-10-04 上午）、**同日同口径不可复现**（t27 同口径重跑得改前 21/22、
  > 改后 22/22，另一次改前单独复跑 14/17），「提示词层是根因」这个判断**不成立**，**不要拿 27% 当现状**；
  > ③④ 仍然成立。现状见本文 §12。
- **下一阶段四条接线项**（P2 段 §5 点名）：入口改走 `buildPluginRuntime(...).start()`、提示词装配点接 `verifyOnAssemble`、
  入口把 `ToolApprovalManager` 接成 `approvalGate`、manifest 的 tool 级 approval 声明（下一轮小任务）。

  > **2026-10-08 加注（V0.3 P2.5）**：前三条**已落地**（入口走的是 `createResidentRuntime()`，它内部用
  > `buildPluginRuntime(...).start()`；提示词装配点上真的有 `verifyOnAssemble` 的调用点；`ToolApprovalManager`
  > 由装配点接成 `approvalGate`）。**第 4 条（manifest 的 tool 级 approval 声明）仍未做**。

## 10. 双机环境：Linux（WSL2）移植与它挖出的平台假设缺陷（2026-10-07）

**背景**：仓库此前只在 Windows 开发机（`E:\worker2`）上跑过；现在检出在
`/home/u24/projects/xixi_ai`（Ubuntu 24.04.3 on WSL2）。装好环境后跑三门禁，
**没有任何一条测试为「Windows 专属假设」变红**——挖出来的五个缺陷全是「在原机器上永远看不见」的形态。
完整的环境矩阵、建 venv 的命令与三个装包坑见 [`recon/linux-port-environment-2026-10-07.md`](recon/linux-port-environment-2026-10-07.md)。

**改了什么（五个缺陷 + 一条新断言）**：

1. `scripts/voice-turn.ts` 用 `file.includes(':') || file.startsWith('.')` 判绝对路径 → POSIX 绝对路径
   （`/tmp/…`）被拼到仓库根后面，报一个看起来像「临时目录没建好」的 `ENOENT`；改成 `isAbsolute` / `resolve`（两处）。
2. 六个入口 + `tests/unit/voice/frontend.test.ts` 把解释器写死成 `.venvs/<name>/Scripts/python.exe`；
   在 `scripts/lib/harness.ts` 加**唯一一份**解析器（`resolvePython` / `pythonCandidates` / `pythonCandidateHint`），
   全部改调它（`XIXI_PYTHON` 等环境变量的优先级原样保留）。
3. `apps/brain-dsh/src/transport.ts` 的 `resolveDshBinJs` 只认 Windows 的 npm 全局布局
   （POSIX 多一层 `lib/`）；补第二个候选并把试过的路径写进错误信息，`scripts/install-dsh-profile.ts`
   改为复用它（原先那份拷贝只认 Windows）。
4. `tests/perception/camera-presence.test.ts` 两条用例要求 `data/` 里至少有 4 张 T0 勘测图片——
   `data/` 是 gitignored，**任何干净检出都必红**；改成「本职断言无条件、对基线的下界改成有条件」。
5. `tests/console/proactive-read-must-not-write.test.ts` 是**定时炸弹**：种子句写死 `2026-10-02`，
   而话题的 `expireAt` = 「明天下午」+ `followupWindowHours`（出厂 48 小时）→ 第 3 天起必然红
   （实测 `actual: 'exhausted'` / `expected: 'candidate'`）。给 `FieldServerOptions` 加 `now?: () => Date`
   接缝（生产不传时行为一字不变），用例传 `SPOKEN_AT + 1 小时`。
6. 新增断言：harness 入口点必须落在**两种 npm 全局布局之一**里（`tests/unit/transport.test.ts`）。

**静默 skip 变真跑**：`frontend.test.ts` 的 Windows 路径让 **4 条 Python 用例被 skip**（末行仍是绿的）——
这正是「测试写了就必须跑」最危险的失效方式。改完后其中一条**真的红了**：F8 那条读
`data/recon/ambient-5s.wav`（又一个 gitignored 产物）；改成**用例自己用 Python 标准库生成** 3 秒环境噪声 WAV
再喂给 `calibrate --wav`（被测契约是「校准 CLI 推荐的就是前端实际应用的」，需要的是**一段**录音）。
skip 条件同时从「文件存在」收紧成「解释器能 `import numpy, voice_edge.frontend`」。

**门禁实测（本机同一次运行）**：

| | 移植前 | 移植后 |
|---|---|---|
| `check:types` | exit 0 | exit 0 |
| `npm test` | **715 项：pass 710 / fail 1 / skipped 4** | **720 项：pass 720 / fail 0 / skipped 0**（`duration_ms` 16116.7） |
| `check:docs` | 109 份，三个 0 | **110 份**，三个 0 |

项数 715 → 720 = 4 条从 skip 变真跑 + 1 条新增（两种 npm 全局布局）。
§3 那条新断言的红证：临时删掉 POSIX 候选后重跑 → `pass 4 / fail 2`（两条都是 `TRANSPORT_FAILED`），
按副本还原后 sha256 与实验前一致（`f456f04236f1d77a…`）——**还原用 `%TEMP%` 副本，不用 `git checkout`**（§9.10 ⑤）。

**这台机器上验不了的四类事**（细节与原因见 recon 报告 §4，**任何文档不许写成已验**）：
① DSH 路径——全局 DSH 是 **0.2.0-rc.2**，而 `plugins/xixi-tools/package.json` 的 peerDependency 钉 **0.1.7-rc.2**，
组合 profile 时该 bundle 被跳过，`npm run install:profile` 报 `composed profile does not contain "xixi-tools"`；
全局安装目录归 root、本机无 sudo，换版本要用户自己来（**2026-10-07 已修**：按用户指示改为「适配当前版本」——
把仓库升到 `0.2.0-rc.2` 而不是降全局 DSH，`install:profile` 与 `verify:provider` 已双双通过，见 §11；本条保留为历史记录）；② 一切真实模型调用（**没有 `.env` / `MIMO_API_KEY`**）；
③ 麦克风 / 扬声器 / 摄像头真机采集（WSL2 默认不暴露音频与 `/dev/video*`；**2026-10-07 已由用户接上**，
拿法见 recon §7，实测结果与残留问题见 §13）；④ `field-test --self-test` 的 **31 通过 / 1 失败**
（**2026-10-09 更正**：本节原写「30 通过 / 2 失败、两条都是 Windows 专属读数（pycaw）」，今天在同一台机器上
实测是 **31 通过 / 1 失败**，且那一条**不是** pycaw 读数，而是 F7 的第二条断言——它要求提示语里出现
「可考虑设为 0 dB / 只提示」，而 `noiseFloorHigh` 的判据是 `noiseFloor !== null && noiseFloor > -40`
（`scripts/field-test.ts`），本机没有噪声校准产物（没有 `data/voice/frontend-profile.json`）→ `noiseFloor` 为 `null`
→ 走「不算高」分支 → 断言必红。**这条在 HEAD `887a84c` 的干净 worktree 里跑出来一模一样**，
所以是既有的**机器状态依赖型断言**，不是本轮回归；它的修法属于测试设计问题，登记在 §13.5）。


**给下一轮的纪律**（已写进 [`AGENTS.md`](../AGENTS.md) §10）：绝对路径用 `node:path`；
解释器/工具路径按布局探测且**全仓只留一份实现**；测试不许依赖 gitignored 产物、更不许因此静默 skip；
种子数据写死绝对日期 + 判定读 `Date.now()` = 定时炸弹（判据：「这条用例放到 30 天后跑还绿吗？」）。

## 11. DSH 版本适配：0.1.7-rc.2 → 0.2.0-rc.2（2026-10-07，用户指示「修复 verify:provider，适配当前版本」）

### 11.1 故障与根因（改前实测）

`npm run verify:provider` 改前**失败**，报 `expected a xixi_get_current_time tool call, saw null`。
根因不是密钥、也不是模型，而是**版本不匹配导致工具插件整个没被加载**：

```
dsh: skipping profile bundle "dsh-xixi-tool": Error: Plugin dsh-xixi-tool@0.1.0 is incompatible with
dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-tools":"0.1.7-rc.2"}. Exact-version exemption: not active.
```

DSH 的判定实现在 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`：把插件 `peerDependencies`
的每一条与 **dsh 运行时版本**做 `semver.satisfies(runtimeVersion, range, {includePrerelease: true})`。
本机全局 DSH 是 **0.2.0-rc.2**（`~/.npm-global`，归 root、无 sudo），仓库钉 **0.1.7-rc.2** → 不满足 → bundle 跳过
→ 模型看不到任何 xixi 工具，于是回答「我没看到这个工具」。**注意**：该判定比的是 dsh 运行时版本，
所以 `@deepseek-ai/dsh-tools` 这个包名在这里只是键名，改 peer 的**值**即可。

### 11.2 处置：升仓库，不降全局、也不开豁免

用户指示「适配当前版本」，因此**不**用 `dsh plugin allow-version`（那是显式接受崩溃风险），而是把仓库升到与运行时一致：

- `plugins/xixi-tools/package.json`：peerDependency `0.1.7-rc.2` → **`0.2.0-rc.2`**（精确写法，零歧义）
- 根 `package.json`：devDependency `@deepseek-ai/dsh-tools` 同步到 **`0.2.0-rc.2`**
- `package-lock.json`：**必须整份重新解析**（见 11.3）

0.2.0 的 `@deepseek-ai/dsh-tools` 把 11 个 `@deepseek-ai/dsh-*`（`dsh-agent` / `dsh-llm` / `dsh-session` /
`dsh-system-prompt` / `dsh-scope` / `dsh-sandbox(-policy)` / `dsh-invariants` / `dsh-ptc-runtime` /
`dsh-user-approval` / `cordis`）声明为 **peerDependencies**（0.1.7 没有这一层），而旧 lock 里它们锁在 0.1.7-rc.2
→ `npm install` 报 ERESOLVE。三条路里只有一条对：

| 做法 | 结果 |
|---|---|
| `--legacy-peer-deps` | **错**：只装 12 个包、11 个 peer 全跳过，`check:types` 会因缺 `@deepseek-ai/dsh-llm` 等崩 |
| `--package-lock-only` | **错**：在旧 lock 上做增量，仍解析出 17 处 0.1.7-rc.2，ERESOLVE 照旧 |
| **删 lock 全新解析 + `npm ci`** | **对**：50 个包、DSH 族全 0.2.0-rc.2、零 0.1.7 残留 |

### 11.3 实测（本机同一次运行，改后）

- `npm run install:profile` → exit 0，`verified: profile composes llm-pi-ai with the MiMo route and the xixi tool plugin`
  （**改前这一步必抛** `composed profile does not contain "xixi-tools"`）
- `npm run verify:provider` → exit 0，**`toolName: "xixi_get_current_time"`**，`diagnostics.toolCalls` 有真实调用，
  `eventTypes` 含 `tool_call` 与 `tool_result`，latency 9889 ms，回答是工具返回的时间戳
- `npm run check:types` → exit 0
- `npm test` → **720 项 / pass 720 / fail 0 / skipped 0**（与升级前基线逐项一致，零回归）
- `npm run check:docs` → 110 份，三个 0

**依赖树对照**：`node_modules/@xixi/*` 的 9 个 workspace 链接由 npm workspaces 自动重建
（`plugins/*` 不在 workspaces 内，由 `install:profile` 的 link 负责），无需手工补链。

### 11.4 已知残留（本次**未**修，如实登记）

两条来自 DSH 宿主的警告在**改前改后都存在**，且不影响上述验收（`verify:provider` 仍 exit 0）：

```
dsh: warning: 2 entries did not activate
permission (@deepseek-ai/dsh-permission-presets): pending (waiting for service: shell)
command-compact (@deepseek-ai/dsh-command-compact): pending (waiting for service: commands)
```

两条都卡在 `waiting for service: shell`——0.2.0 的 `shell` 服务由 `dsh-terminal-bash` / `dsh-bash-local`
一类内置插件提供，而 `xixi` profile 的 bundle 列表只有 `dsh-base` + `dsh-headless` + 工具插件，
没有 shell 那一条。**影响面**：permission-presets 与 command-compact 未激活；本次验收路径用不到这两条，
但它们不是「已解决」。另有 `all_proxy names a SOCKS proxy` 一条，是本机代理环境变量带来的噪音，与仓库无关。

## 12. V0.3 P2.5：Production Wiring 收口（2026-10-08）——把 Agent 能力接进活的西西

**这一轮要解决的问题**：P2 把插件内核、MCP 适配器、news 插件、工具审批、durable 提醒、提示词权威都做出来了，
但它们的**装配点分别在不同的地方**（多数在测试里），所以真实入口还是旧运行时——当时的证据是「入口里问新闻，
她只能回『我查不了』」。P2.5 把装配收成**一个常驻装配点**，再把七个入口接上去。

**判据用命令，不用名单**（名单会随代码过期；这一段就是唯一出处的复核方式）：

```powershell
git grep -l 'createResidentRuntime(' -- scripts   # 走常驻装配点的：七个入口脚本 + 验收脚本
git grep -n 'buildToolChain(' -- scripts ':!scripts/verify-p2-5.ts'          # 应为 0 命中：入口不再自己拼链
node scripts/chat.ts --print-wiring               # 模型可见的工具与权限（离线、不调模型、不建库）
npm run verify:p2.5 -- --offline                  # 四个真入口场景（零费用、不联网）
```

### 12.1 交付（字母是 P2.5 的分块号；括号里是本轮的任务号）

| 块 | 交付物 | 一句话说明 |
|---|---|---|
| P2.5-A（t1） | `packages/runtime/src/resident-runtime.ts` 的 `createResidentRuntime(options)` / `XixiResidentRuntime` | 工具链、插件内核、审批宿主、durable 提醒 sink 与调度、回合后提取、过了提示词权威校验的引擎、插件能力桥，一次装好。**模型客户端不在这里造**（适配器由调用方直给或给一个拿到链后再造的 builder） |
| P2.5-B（t2） | `scripts/field-test.ts`、`scripts/serve-chat.ts` | 现场测试控制台与试用页改走装配点；`close()` 先停运行时再关库；新增 `FieldServerHandle.runtime`、`createTrialRuntime(options)` |
| P2.5-C（t3） | `scripts/chat.ts`、`scripts/voice-turn.ts`、`scripts/voice-device-check.ts`、`scripts/eval-realism.ts`、`scripts/eval-conversation.ts` | 四个 live 入口 + 三个附带入口改走装配点；`news.*` 第一次进模型可见工具链；`--print-wiring` 保持离线（`:memory:` 库、fetch 一用即抛、替身模型） |
| P2.5-C（t5） | `packages/runtime/src/capability-bridge.ts`、`proactive-runtime.ts` | 插件 `topic_source` 桥进主动候选（`runtime.capabilities`）；**入口那一行 `readPluginTopics` 当时仍未写**（见 12.3；**已由 D1.2 补上**，见 §14） |
| P2.5-D（t10） | `tests/unit/runtime/resident-runtime.test.ts` | 提示词权威的**生产点行为证据**：毒化装配器 → 被拒（`boundary=core-system-prompt`）且模型零调用。**接线本身自 P2.5-A 就在**（`git grep -n 'verifyOnAssemble(' -- packages/runtime/src`） |
| P2.5-E（t7） | `packages/brain-adapter/src/tools.ts` 等 | 提醒工具改名 `xixi_set_reminder_stub` → `xixi_set_reminder`，返回文案改「已经记下」，**没有兼容别名** |
| P2.5-F（t8） | `resident-runtime.ts` 的 `reminderSeams` | durable 提醒接进装配点；读接缝先 `markDue()` 再 `candidateInputs()`（只做后半句会让没 tick 过的提醒永远停在 `pending`）；两条接缝**必须成对**（入口侧那两行**已由 D1.1 补上**，见 §14） |
| P2.5-G（t11/t12） | `packages/runtime/src/tool-runtime.ts`、`resident-runtime.ts` | 声明 → 权限策略那一条链补齐不变量（名字归一化、TTL 夹紧），审批在真实运行时闭环且**执行的是冻结参数** |
| P2.5-H（t9） | `packages/domain/src/plugin-settings.ts`、`resident-runtime.ts`、`config/xixi.example.yaml` | `xixi.plugins` 严格解析并真的驱动装配（directories / news / mcp）；写错的键名、拼错的 transport 在**加载配置时**带路径报错。出厂 `news.enabled: false` 是有意的 |
| P2.5-I（t4） | `packages/plugins/src/{manager,errors,index}.ts` | 插件启动幂等改成**响亮拒绝**（`PluginAlreadyStartedError`）；`deactivate` / `dispose` / rollback 一起丢掉 health，新增派生字段 `PluginInstance.online` |
| P2.5-J（t6） | `packages/conversation/src/{engine,prompt}.ts`、`packages/context/src/{context-builder,relationship-context}.ts` | `ContextBuilder.render().worldLines`（含在场）进提示词，`worldStateLite` 降级为「关掉上下文层时的回退」（两路互斥）；关系笔记按听众模式过滤，`public` 一条不给 |
| P2.5-K（t13） | `scripts/verify-p2-5.ts` + `npm run verify:p2.5` | 四条**真入口**端到端证据，一条命令可重跑 |

**装配点的四条不变式**（用例：`node --test tests/unit/runtime/resident-runtime.test.ts`）：
① `start()` 只认一次，第二次抛 `RESIDENT_RUNTIME_ALREADY_STARTED`；② **关停是终态**——`stop()` 之后再 `start()`
抛 `RESIDENT_RUNTIME_ALREADY_STOPPED`，`runtime.plugins.mount()` 抛 `RESIDENT_RUNTIME_CLOSED`；③ `stop()` 幂等；
④ `toolChain === plugins.registry`（模型看到的与内核装的是同一个注册表）。

**顺带修掉的一条**（P2.5-K 的真入口验收探针抓到）：关停路径原本**跳过第 8 步 `deactivate`**（只跑 `dispose`），
与 `manager.ts` 顶部那条九步契约不符——只在 `deactivate` 里做清理的插件（例如 `xixi.news` 的 `live.length = 0`）
那个钩子永远不会跑。现在 `dispose()` 先 `deactivate` 再 `dispose`，验收探针记录的钩子序列如实是
`activate → deactivate → dispose`。

### 12.2 验收（可重跑）

- `npm run verify:p2.5`（有密钥时场景 1 真调一次模型）或 `npm run verify:p2.5 -- --offline`（零费用、不联网）：
  四个场景 exit 0 —— ① 入口问新闻（真模型时由它自己调 `news.latest`，结果回到回答里）；② 提醒跨重启
  （子进程写 → 父进程用**另一个进程**读回 → 到点由读接缝变成候选 → 主动路径说出口 → 落 `delivered`）；
  ③ 审批（待批时业务数据零行、第二组参数只多一条待批、点头后执行的是**当时冻结**的参数）；④ 关停
  （链清空、探针连接标记关闭、`dispose` 钩子跑过、读接缝抛「store is closed」、待办仍在库里）。
- **如实标注的模拟部分**：场景 1 的 feed 是**本机 RSS 夹具**（实测 BBC 那条 feed 直连 20 秒、代理 25 秒都超时；
  换真 URL 只改一处），场景 2 的「到点」用**注入时钟**造（入口工厂不接受 `now`，而验收要的是「到点」而不是「等一天」）。
  脚本自己会把这两点打印出来，别读成「公网可达」或「等了一整天」。
- 离线的逐入口自证：`node <入口> --print-wiring`（chat / voice-device-check / eval-realism / eval-conversation），
  实测四行**除 `entry` 外逐字段相同**，并且与装配点给出的**同一条链**（用例 `tests/console/live-entry-tool-chain.test.ts`）。
- **本文写完后复跑过**（同样是可重跑的，不是转述）：`npm run verify:p2.5` 与 `npm run verify:p2.5 -- --offline`
  都是 exit 0；live 那一次输出的关停场景记 `deactivateRan: true`——正是下面那条「跳过第 8 步」修复的观察点。

### 12.3 仍未接线（**不许写成活的**）

> **2026-10-10 更正（§9.21：加注、原文保留）**：第 1、2 条**已由 D1.1 / D1.2 接上**——`scripts/serve-chat.ts`
> 与 `scripts/field-test.ts` 的 `new ProactiveLoop({…})` 里现在各有 `...runtime.reminderSeams`（到点提醒，读接缝
> 是整个时钟 pass）与 `readPluginTopics`（插件 `topic_source` 提案）。复核命令**必须带排除项**（验收脚本自己也
> 引用 `reminderSeams`，不排除就会得到一个假的「零命中」结论）：
> `git grep -n 'reminderSeams' -- scripts ':!scripts/verify-p2-5.ts'` 与 `git grep -n 'readPluginTopics' -- scripts`
> ——两条都应命中那两个 live 入口；行为证据是 `tests/console/live-entry-proactive-seams.test.ts`（用例里不手调
> `tick()`、也不手调接缝）。逐条见 §14。

1. ~~**到点提醒由入口说出来**：`git grep -n 'reminderSeams' -- scripts` **零命中**，而 `new ProactiveLoop(` 有三处
   （`scripts/field-test.ts`、`scripts/serve-chat.ts`、`scripts/eval-proactive-timeline.ts`）。所以「活的西西已经
   在说到点提醒」**不成立**；成立的是「接缝可用 + 到点会被主动路径说出来」（验收脚本按那一行接法驱动）。~~
2. ~~**活入口真在用插件话题**：`git grep -n 'readPluginTopics' -- scripts` **零命中**。~~
3. **外部 MCP 服务器**：没有任何入口配置过服务器（唯一入口是配置 `xixi.plugins.mcp.servers`，出厂为空表），
   证据仍是 SDK v2 真 client + 真 server 走 `InMemoryTransport`。
4. **新闻来源全部由配置说了算**：入口脚本今天各自带一条 RSS 来源（`git grep -n 'createRssNewsSource' -- scripts`），
   要让「来源全部来自配置」成立得先把入口那份显式来源删掉、再把 `plugins.news.enabled` 翻成 `true`——那是
   **另一条任务**（翻开关会让所有入口改用配置来源，也会打红控制台用例）。
5. **`beginTurn` 在 live 入口零命中**（`git grep -n 'beginTurn' -- scripts` 只命中验收脚本）：活入口写下的提醒
   `owner` 会落到 sink 的兜底 `unknown`。

### 12.4 已知问题（已知、未修；写明谁发现的）

- ~~**内核的 `#disposed` 只有一处守卫**（`loadPlugin` 查它，`loadInline` / `activate` 不查）→ `disposeAll()` 之后
  仍能把插件**复活**（t16 的 F1 发现、t21 复核）。常驻运行时这一层已堵（关停后 `mount()` 抛
  `RESIDENT_RUNTIME_CLOSED`），**内核层未修**。~~
  → **已由提交 `bb494ba`（T21 收尾）修掉（2026-10-10 加注）**：`loadPlugin` / `loadInline` / `activate` 现在都查
  `#disposed`（复核 `git grep -n '#disposed' -- packages/plugins/src/manager.ts`），`disposeAll()` 之后把插件
  复活会被拒绝。**相邻的一条仍未修**——per-plugin `dispose()` 的口径，挂在 [`handoff.md`](handoff.md) §0.2 的「已知问题」里。
- **`online` 的文档口径比代码强**：`checkHealth()` 复查失败会把 state 翻成 `failed`，而能力登记与模块还在——
  按「先读 `online`」的面板会对仍在跑的插件显示「已停用」（t16 的 F2，`#push` 的既有行为）。
- **提示词权威的机制缺口**：`authority.verify` 对 system 串只查 `startsWith(CORE_IDENTITY)` 与 `includes(HARD_POLICY)`
  再逐段比对核心段正文，所以「保持两个核心段对象原样、只往 system 串尾部追加文本」它**不拒**（t10 的探针实测
  NO-THROW）。插件今天拿不到装配器，故属**机制完备性**问题，不是活的风险。
- **per-plugin `dispose()` 不是插件级终态**（t4 披露、t16/t21 复核）。
- `countIfReadable` 的「库已关」与「`stop()` 失败重试」两条防线**今天构造不出坏输入**（t18 登记）。
- **manifest 的 tool 级 approval 声明未实现**（P2 就登记、P2.5 未动）：今天起作用的是 `config.tools.approval.ask`。

### 12.5 本轮还清的两笔文档旧账

1. **硬边界现在写全两条**：`docs/design/conversation.md` §3 与 `docs/design/security-and-privacy.md` §2
   都补上了 `HARD_POLICY` 的**第二条**边界 `WRITE_OPERATION_RULE`（写下来的事必须真的用工具写）——
   在此之前设计文档只写了「事实来源」那一条。
2. **那条「27%」按更正后的口径加注**（原文一字未改）：`docs/progress-v03.md` 的 P2 段与
   `docs/verification/t14-p2-gate-independent-verification-2026-10-04.md` 都已加注——它是 2026-10-04 的
   一次历史观测、同日同口径不可复现，「提示词层是根因」这个判断不成立，**不要拿它当现状**。

## 13. 试用页接摄像头 + 一个总开关（2026-10-08/09）——以及三个真缺陷

**起因是用户真机试用**。用户按 [`recon/linux-port-environment-2026-10-07.md`](recon/linux-port-environment-2026-10-07.md) §7
把麦克风 / 扬声器 / 摄像头接进 WSL 之后，提了四条要求：① 配置项太多，主动性只要**一个总开关**；
② 页面要**显示摄像头**；③ 「我录的音」与「AI 的回复语音」都要**能重复播放**（方便检查）；
④ 测试数据存本地。四条都已落地，并在过程中抓到**三个真缺陷**——它们都不是新代码引入的，
而是「原来就写着、但没有任何测试或运行跑到过」。

### 13.1 三个真缺陷

| # | 现象 | 根因 | 证据 | 处置 |
|---|---|---|---|---|
| 1 | `--live` 的摄像头预览**跑到 20 秒自己停**：画面冻住，页面还写「运行中」 | `run.py` 的 `if live:` 块写在 `cfg = RunConfig(**parsed)` **之后**，那两行 `parsed["seconds"] = 0.0` 改的是一个**再没人读**的字典；`cfg.seconds` 一直是 `--seconds` 的默认值 20，`run()` 到期 `break` | 试用页实测：预览子进程在 **161 帧 / 8 fps（≈20.1 秒）** 后 exit 0。而**模块自己的 docstring 一直写着**「live 没有 `--seconds`，它跑到 stdin 关闭或被中断」——**意图与代码相反，且没有任何断言看得见** | 把 live 块提到建配置**之前**；新增两条回归用例（`tests/perception/test_presence.py` 的 `LiveModeConfigTests`）：一条钉住 live 交给 `run()` 的配置是 `seconds == 0.0`、无帧数上限、`pace_fps == 8.0`，一条**反事实**钉住普通运行仍保留 `--seconds` 上限 |
| 2 | 试用页**点了没反应**（麦克风、打字、所有按钮全不动） | 页面内联脚本里那处转义**少写了一层反斜杠**：源码要发出「反斜杠 + n」这两个字符，在模板字符串里必须写两层，写成一层时**模板求值阶段就把它变成了真换行**：这段 JS 嵌在 TS 模板字符串里，**模板字符串求值时就把它变成了换行**，于是发到浏览器的代码在**解析阶段**抛 `SyntaxError`，`<script>` 整块不执行——**一个监听器都没挂上** | 把页面内联脚本抽出来 `node --check`：`SyntaxError: Invalid or unexpected token`。同一时刻 `/api/turn` 与 `/api/voice` **后端都是好的**（直接 POST 都正常回），所以这不是「麦克风坏了」 | 改成 `'\\n'`（两处）；并留下纪律：**字符串断言看不见「这段代码能不能运行」**（与 AGENTS §9.24 同族）。⚠ 当时仓库**没有 jsdom，`tests/console/*` 全是对生成文本做正则断言——没有任何一条测试执行过页面的 JS**，所以这类缺陷当时**没有自动防线**（见 §13.5 第 3 条）；**2026-10-10（D0.3）起补上了两档**（快档把页面里每个内联脚本抽出来编译，在 `npm test` 里），但**只覆盖现场测试控制台的 `GET /`**——试用页与 `apps/demo-ui/` 的内联脚本仍没有门禁，见 §14 与 [`testing.md`](testing.md) §3.2 |
| 3 | 试用页的在场投影**写进了另一个库** | `presenceStorePath` 原为 `join(REPO_ROOT, 'data')`。只**读**时没有后果，摄像头接进来之后它开始**写**：「画面看到的」与「对话/人格」分家，还凭空多出一个 `data/xixi.sqlite` | 控制台早就统一成 `presenceDataDir = options.presenceDataDir ?? dataDir`，注释写着「what the camera writes is what the page reads」 | 改成 `DATA_DIR`，与「一个西西」同库（household 库：`XIXI_DATA_DIR`，未设则 `data/xixi`） |

缺陷 1 的**生产侧证据**（比我自己再跑一次更有说服力，因为那是真的在给页面供图的那个子进程）：
`curl -s http://127.0.0.1:8791/api/camera` 读出该子进程 `startedAt 2026-10-08T13:46:18.204Z`、
末帧 `13:54:45.251+08:00`、**`frames: 4204`**、`presenceEvents: 18`、`exitCode: 0`——**连续 8 分 27 秒 / 4204 帧**
（≈8.3 fps，与 `--live-fps` 的 8 一致），而不是缺陷时的 161 帧 / 20.1 秒。
配置侧的判据是可重跑的：`npm run test:perception`（转发 Python 套件，本机实测 **48 个用例 OK、3 skipped**）。
⚠ **写这段时想再独立跑一次真机 `--live`，没跑成**：`/dev/video0` 存在但打不开（等待 3.0 秒后按设计快速失败、exit 2），
即「同一时刻只能被一个进程占用」这条既有约束——所以端到端的数字取自上面那个真实子进程的读数，
**没有**用「我自己复跑过」的语气写。

### 13.2 试用页（`scripts/serve-chat.ts`）

- **摄像头预览**：新增三条路由——`GET /api/camera`（状态）、`GET /api/camera/frame.jpg`（**原始 JPEG 字节**）、
  `POST /api/camera`（`{action: 'start' | 'stop'}`）。不用控制台那种 JSON+base64，因为浏览器原生解码 `image/jpeg`，
  base64 会把每帧撑大三分之一，而且 JSON 通道留给状态更清楚；响应带 `no-store`（缓存的帧会被误读成「画面卡住」）。
  实现**复用控制台那一份** `LiveSensors` + `createPerceptionLiveRunner`（AGENTS §10.2：每个平台只能有一份实现），
  所以**同一个子进程既给画面、也给 `presence.changed`**，并经 `ingestPerceptionLine` 进同一个库——
  「画面里有人」与 WorldState 不可能各说各话；子进程**没有自己的 `--db`**（V0.3 P0-B）。页面**默认打开**摄像头，
  每 250 ms 取一帧，用 `<img>` 的 `onload` 闸门防请求堆积；拿不到画面时给 `problem`（红框 + 三步排查），
  **绝不把「交不出画面」显示成「房间没人」**。
- **录音回放**：`attachAudio()` 把**已经在页面里的字节**做成 blob URL，挂一个原生 `<audio controls>`——
  「你说的那句」（浏览器录的那份）与「她的整段拼接 WAV」（`end` 事件带的）**各一个播放器**，
  播放 / 暂停 / 拖回去重听都是浏览器原生能力（「重复播放」要的正是 seek，自己写按钮就得重造它），
  旁边一个「⬇ 存到本地」；没有语音时也会把你**刚录的那段**放出来，方便判断「是没说话还是没录上」。
- **主动开口默认打开**：页面一加载就把常驻考虑循环启动（不必点保存、不必找第二个勾）；用户显式关掉会记进
  `localStorage`，**刷新不会偷偷开回来**（一个反复自我主张的默认值是缺陷，不是默认值）；服务端总开关是关的时候它不会去开。

### 13.3 一个总开关（控制台与试用页**共用**同一份面板）

面板在 `scripts/field-test.ts` 的 `proactivePanelHtml()`，两个页面都用它，所以「一个总开关」两页一致。
**「主动开口」这一个勾就是全部**：拨动**即生效**（不用点保存），并且**常驻考虑循环跟着它起停**——
从用户视角它们本来就是同一个决定（「她会不会自己开口」），此前却分散在两个地方、还要先点保存。
十个旋钮、门禁判定表、设置变更审计与考虑日志全部折进**默认收起**的「高级设置」（`px-advanced` / `px-advanced-body`）。
**钉的是接线，不是文案**（`tests/console/proactive-loop.test.ts`）：`pxMaster(master.checked)` 挂在 change 上、
`await pxSave({ enabled: on }` 真落库、`if (on) await pxLoopStart()` 与 `else await pxLoopStop()` 都在、
高级块默认 `hidden` 且**包住了每一个旋钮**（用「开标签在 `px-cooldown` 之前、闭标签在 `px-audit` 之后」判定）。
两页的差别只有**「页面加载时要不要自动起循环」**（面板本身、总开关语义、高级设置都一模一样）：
试用页会（`scripts/serve-chat.ts` 的 `autoProactive()`；除非用户显式关掉过、或服务端总开关是关的），
控制台不会——`scripts/field-test.ts` 那一行写得很清楚：`loopBox.checked = false; // 默认关：页面刷新/重开不会自己开始说话`，
它由「一键启用」统一管。

### 13.4 真机验收报告（[`recon/field-test-report-2026-10-08.md`](recon/field-test-report-2026-10-08.md)）怎么读

`node scripts/field-test.ts --acceptance` 在 **Linux** 侧生成的报告，**总体结论 FAIL**：
麦克风 3 秒 RMS **−67.5 dBFS**、扬声器能量比 **0 dB**（< 10 dB）、摄像头**通过**
（`CAP_V4L2`、MJPG、640×480、18.1 fps、亮度均值 146.4 / 标准差 45.8）。**这三条都不是「设备坏了」**：

1. **扬声器那一项这次的 `micRmsDbfs` 是 −120**（数字静音）、`loopbackCorrelation` 0、三个窗的带内功率全是 −120：
   说明这一跑里**采集侧根本没有数据**，而不是「扬声器没响」——报告自己的「口径变更说明」也写着
   「程序确实渲染了音频」与「麦克风真的听到了」是**两件事**，要分别测量。
2. **麦克风那一项量的是环境声**（3 秒里没人在说话）。同一台机器上「对着麦克风说一句话」的采集是正常的
   （会话内实测峰值 **−19.18 dBFS**、RMS −39.12 dBFS），所以这一项是「这次没人说话」，不是「麦克风不通」。
3. **报告的判据文案仍是 Windows 口径**：写着「能以 `CAP_DSHOW` 打开（本机唯一可用后端）」，而同一份报告的
   JSON 里 `backend` 其实是 **`CAP_V4L2`**；`pycaw` / `comtypes` 的端点读数在 Linux 上必然读不到，
   报告如实记成 `null` 与 `ModuleNotFoundError: No module named 'comtypes'`。
   **这是报告生成器的文案缺陷（未修）**：标签该按平台给，否则读者会把 V4L2 的通过项读成 DSHOW 的。

**结论**：这份报告在 Linux 上的可信部分是**摄像头通过**与**端点读数不可用**；麦克风与扬声器两项
**不构成对设备的否定**，但也不能拿它当「设备通过」的证明——真正证明设备可用的是 ① 真机采集到的语音
（峰值 −19 dBFS）与 ② 用户听到的播放。**要重跑：先释放摄像头**（同一时刻只能一个进程占用）。

### 13.5 已知问题（本轮登记，未修）

1. **扬声器项在 WSL 上量不出声学余量**：`--acceptance` 那一次采集侧全程 −120 dBFS（见 §13.4 第 1 条），
   而同一台机器上用 `sounddevice` 单独采集是正常的。怀疑与「播放与采集并发」这条路径有关，
   **没有定位到根因**，登记为待查；在查清之前**不要**用这台机器的扬声器项结论去判代码好坏。
2. **`--self-test` 的 F7 第二条是本机必红的机器状态依赖断言**（2026-10-09 实测 31 通过 / 1 失败）：
   它要求提示语里出现「可考虑设为 0 dB / 只提示」，而 `noiseFloorHigh` 的判据是
   `noiseFloor !== null && noiseFloor > -40`，本机没有噪声校准产物（没有 `data/voice/frontend-profile.json`）
   → `noiseFloor` 为 `null` → 走「不算高」分支 → 必红。**HEAD `887a84c` 的干净 worktree 里跑出来一模一样**，
   所以不是回归，是**断言依赖机器状态**这一类缺陷（与 AGENTS §9.25 ⑥「先问这台机器上错误实现会不会也通过」同族）。
   §10 原先记的「30 通过 / 2 失败、两条都是 pycaw」已按本机实测更正。
3. ~~**没有任何测试执行过页面的 JS**（§13.1 缺陷 2 的温床）：仓库里没有 jsdom，`tests/console/*` 全是对
   **生成的文本**做正则断言——所以「脚本能不能解析」「监听器有没有挂上」这类缺陷今天**零防线**。
   最小可行的堵法是：把服务发出的内联脚本抽出来逐个 `new Function(...)`／`node --check` 解析，
   成本极低、正好覆盖这一整类。**本轮没做**（本轮只做文档），列为下一步 **§4 第 31 条**。~~
   → **已由 D0.3 收口（2026-10-10）**：「整块脚本解析失败」这一类今天有门禁了——`npm run test:ui:smoke`
   （也在 `npm test` 里）编译服务真正发出的每个内联脚本、并核对脚本按字面量找的 id 在 markup 里存在；
   「监听器有没有挂上」那一层在深档 `npm run test:ui`（真 Chromium，**不在默认门禁**，首次先 `npm run test:ui:install`）。
   **覆盖边界照实说**：两档今天都只看**现场测试控制台的 `GET /`**，试用页（`scripts/serve-chat.ts`）与
   `apps/demo-ui/` 的内联脚本仍没有门禁。上面原文按 §9.21 保留。逐条见 §14。
4. **验收报告生成器的判据标签写死了 Windows 口径**（§13.4 第 3 条）。

## 14. V0.3 D0 + D1：交互原型、两档浏览器防线、主动循环两个接缝接进 live 入口（2026-10-10）

**起因**：§13 那次真机试用挖出的第 2 个缺陷（试用页**整页按钮没响应**）暴露了同一件事——
**页面的 JS 当时没有任何门禁**；同一次试用还留下一个诉求：把界面与文案先定下来的**交互原型**。
D0 做这两件（原型页 + 两道防线），D1 把 P2.5 已经准备好、但**入口没写**的那两行接缝补上。

### 14.1 交付

| 块 | 交付物 | 一句话说明 |
|---|---|---|
| D0.1 / D0.2（t22） | `apps/demo-ui/index.html`、`apps/demo-ui/styles.css`、`apps/demo-ui/app.js`；`scripts/serve-chat.ts` 的 `/demo/` 三条静态路由；`tests/console/serve-chat-demo-route.test.ts` | 交互原型挂在试用页服务上：默认（`/demo/`）是**页面内模拟数据**，`?mode=live` 才去调真实 `/api/*`；`/demo` 少一个斜杠是 302（**查询串保留**）、`/demo/nope.js` 是 404、旧调试页 `/` 不受影响 |
| D0.3（t23） | `tests/ui/smoke/page-script.test.ts`、`tests/ui/e2e/page-behavior.test.ts`、`tests/ui/lib/harness.ts`；`docs/adr/0021-browser-ui-testing.md`；`package.json` 的三条脚本 | **两档**：快档（零依赖、离线、在 `npm test` 里）编译页面里每个内联脚本并核对脚本按字面量找的 id；深档用真 Chromium + 真服务，断言零 `pageerror` / 零失败请求并点关键控件 |
| D0.4 | `tests/ui/e2e/demo-page.test.ts`；`tests/ui/lib/harness.ts`（拆出通用装载 `openPage`）；`docs/testing.md` §3.2 与 §6、`docs/adr/0021` | 把设计包随附的 `browser_smoke.py` 移植成 demo 原型页的**深档**：走**真路由** `GET /demo/`（原版是把三个文件注入页面，那是在给副本判分），启动信号改用**只有脚本会写**的 `#mode-pill`（原版等的 `#companion-state` 本来就在 markup 里，脚本整块解析失败也照样绿——正是 2026-10-08 那次事故的形态） |
| D1.1 / D1.2（t25） | `scripts/serve-chat.ts` 与 `scripts/field-test.ts` 的 `new ProactiveLoop({…})`；`tests/console/live-entry-proactive-seams.test.ts`；`scripts/verify-p2-5.ts` 场景 2 | 两个 live 入口各接**两行**：`...runtime.reminderSeams`（读接缝是整个时钟 pass + 送达记账）与 `readPluginTopics`（插件 `topic_source` 的提案） |

**设计包的去向（2026-10-10，用户裁定「搞定的设计方案可以删除或归档」）**：`xixi_demo_design_pack/` 的 demo
三件套已吸收进 `apps/demo-ui/`（`styles.css` 由压缩版展开成可读版），它的 `browser_smoke.py` 已移植成
上表的 D0.4。**其余 8 个文件不入库**：`01`/`03`/`05` 是诊断与路线图（用户明确不要入库），`02`/`04` 是原型的
设计意图与**时点** API 快照——实现与测试已经取代它们，收进 `docs/` 等于再养一份必须跟着 `apps/demo-ui/`
同步的文档（本仓库被过期文档咬过多次，本轮又抓到 5 处）。**整包从未被 git 跟踪，所以它不在 git 历史里**；
工作区里的目录与 `XIXI_LATEST_REVIEW_DEMO_AND_ROADMAP.md` 已按同一裁定移除，归档是**仓库外的本机产物**
（`~/xixi_demo_design_pack_2026-10-10.tar.gz`），**不是项目资产、换机器即失**，不要把它当引用来源。

### 14.2 判据（命令优先）

```bash
npm run test:ui:smoke                       # 快档：内联脚本能否编译 + 脚本按字面量找的 id 在不在页面里（也在 npm test 里）
npm run test:ui                             # 深档：真 Chromium（**不在默认门禁**；首次先 npm run test:ui:install 取浏览器）
node --test tests/console/serve-chat-demo-route.test.ts       # /demo/ 三条路由 + 302 保留查询串 + 旧页仍在
node --test tests/console/live-entry-proactive-seams.test.ts  # 提醒与插件提案由入口**自己的**循环读出来
npm run verify:p2.5 -- --offline            # 场景 2 现在是「第一次 tick 由循环自己读库」，脚本不再手调接缝
git grep -n 'reminderSeams' -- scripts ':!scripts/verify-p2-5.ts'   # 应命中两个 live 入口
git grep -n 'readPluginTopics' -- scripts                           # 同上
```

**口径**：`reminderSeams` 那条命令**必须带排除项**——`scripts/verify-p2-5.ts`（验收脚本）自己也引用它，
不排除就会得到一个**假的「零命中」**结论；这正是 §12.3 那段文字过期时留下的同形错误。
`scripts/eval-proactive-timeline.ts` 是**确定性仿真**（假大脑 + 模拟时钟），不是 live 入口，按既有口径不接。

### 14.3 已验证

- **原型页的路由与静态资源**：`node --test tests/console/serve-chat-demo-route.test.ts`（在 `npm test` 里）——
  三条资源 200 且 content-type 带 charset、`/demo?mode=live` 302 且保留查询串、`/demo/nope.js` 404、`/` 仍是旧调试页。
- **两档防线**：`npm run test:ui:smoke` 在默认门禁里；`npm run test:ui` 用真 Chromium 跑（本机沙箱写不了 `~/.cache`，
  浏览器落在仓库的 `data/ms-playwright`，harness 会自己找到它）。
- **入口接缝的行为证据**：`node --test tests/console/live-entry-proactive-seams.test.ts`——往入口自己的库里写一条
  **已经到点**的提醒，只用入口自己的定时器（`/api/.../proactive/loop` 的 `start`，第一拍立即），断言它在入口的日志里
  走完 `pending → due → candidate` 且候选 id 就是那条提醒；插件那条断言「静默时段覆盖此刻时**照进候选**但被硬底线拦成
  `QUIET_HOURS`；关掉静默时段后，说的就是它自己那一句」。用例里**没有** `tick()`、也**没有**手调接缝——这就是它
  与「字符串断言看见两行字」的区别（AGENTS §9.24）。
- **验收脚本改口径**：`npm run verify:p2.5 -- --offline` 的场景 2 由「脚本手调 `runtime.reminderSeams.readDueReminders()`
  再喂给循环」改成「第一次 tick 由循环自己读库」，并断言状态推进到 `candidate`、候选 id 钉在这条提醒上。
- **浏览器取证从「一次性」变成可重跑（D0.4）**：原型页那条手工取证现在有了脚本化对应物
  `tests/ui/e2e/demo-page.test.ts`（`npm run test:ui`，真 Chromium + 真服务）：断言 `GET /demo/` 真的 200、
  页面**自己**取到 `/demo/app.js` 与 `/demo/styles.css`、零 `pageerror` / 零失败请求 / 零 console error、
  点建议会把它自己的文本填进输入框且发送渲染出「一句 + 一回」、陪伴与摄像头两个开关各自只移动自己的状态、
  两个工作区互换与隐私对话框开合、390/768/1440 三个宽度都不横向溢出。
  **口径差异要如实说**：它在**默认（模拟）模式**下跑，**不覆盖 `?mode=live`**——手工那遍核过的
  `/api/proactive/settings`、`/api/proactive/loop`、`/api/tts`、`/api/camera`、`/api/quiet`、`/api/state`、
  `/api/voice` 返回**仍只在手工那一次做过**；要复现那一层只能照 [`README.md`](README.md) §0 手工点一遍。
- **门禁**：`npm run check:docs` 三个 0 且 exit 0；`npm test` **全绿（项数以实跑末行为准）**。

### 14.4 边界与已知缺口（**不许写成「页面的 JS 已经全都有防线」**）

1. **覆盖范围（2026-10-10 D0.4 更新）**：快档覆盖**三个页面**——现场测试控制台 `GET /`、试用页 `GET /`、
   `apps/demo-ui/index.html` 与它的外链 `app.js`；深档覆盖控制台 `GET /` 与 demo 原型页 `GET /demo/` 的
   **运行时行为**。**今天仍缺的是试用页的运行时行为**——它只有「解析 + id」两层，要接是它自己任务里的一件事。
   见 [`testing.md`](testing.md) §6 第 8 条。
2. **快档看不见运行时行为**：handler 里访问不存在的属性、`null.addEventListener`、异步分支根本没跑、点了没渲染——
   它一个字都看不见（那是深档的职责），而深档**不在默认门禁**、还要先花一次 `npm run test:ui:install` 取浏览器。
3. **试用页那一行 `readPluginTopics` 没有独立行为证据**：控制台有（用例里挂了 inline 插件），试用页没有插件注入缝——
   把试用页那一行删掉，现有用例**仍全绿**，如实登记为缺口；要补它得先给试用页加一个插件注入缝（属 `scripts/` 的任务）。
4. **`/demo/` 是原型，不是第二个试用页**：默认模式不碰任何真实设备与库；只有 `?mode=live` 才去调真实 `/api/*`。
5. **`data/ms-playwright` 是本机自取的（已 gitignore，约 278 MB）**：换机器要重新跑一次 `npm run test:ui:install`；
   沙箱里 `~/.cache` 不可写时用 `PLAYWRIGHT_BROWSERS_PATH` 指到仓库内。

