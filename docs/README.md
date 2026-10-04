# 西西项目文档地图

> 最后更新：2026-10-04（V0.3 P0+P1 集成收口 t16：登记 [progress-v03.md](progress-v03.md)（按 Phase 索引的阶段进度）与 P0/P1 的**三份** ADR（0014/0015/0016）与 t15 复验报告；把「四个入口各用不同的库」改成 canonical store 的实际默认值）
> 面向：接手本项目的编码 Agent / 维护者
> 本文件告诉你「先读什么、什么最权威、改代码后必须更新哪些文档」。

## 0. 现场测试前用户须知（先读这一节）

**一条命令启动**：

```powershell
cd E:\worker2
npm run field-test            # 打开 http://127.0.0.1:8792（只监听本机）
```

**操作步骤**：① 页面打开后先看「传感器」栏的麦克风电平与噪声底；② 点「一键启用」开摄像头在场 + 自动考虑循环
（会起一个 `perception_edge.run --live` 子进程，可在同一张卡上停用）；③ 在「对话」栏按住🎤或打字说话；
④ 看「配置」栏调主动性 / 话痨 / 话长，以及冷却、额度、静默时段；⑤ 点「开始设备自检」跑麦克风 / 扬声器 / 摄像头自检。

**怎么判读结果**：

- **麦克风噪声与成功边界**：本机环境噪声底实测 −30 ~ −35 dBFS（低频为主）。抗噪前端（去直流 + 120 Hz 高通 +
  噪声底自适应门限）之后，**`SNR_inband ≥ 3 dB` 时 4 条中文夹具全部检出、平均字符相似度 0.805**；
  6 dB 档 0.841、18 dB 档 0.841、0 dB 档掉到 0.491（2 条 <0.6）、−6 dB 档 0/4 检出。**低于 3 dB 不要期待能用**。
  细节与复现命令：`progress.md` §2.13、[`design/voice.md`](design/voice.md) §1.1。
- **「扬声器验收 FAIL」的正确含义**：它测的是**回采余量**（笔记本扬声器 → 笔记本麦克风），
  实测能量比 **2.41 dB < 10 dB** 所以判 FAIL——这**不代表「用户对麦克风说话能否被听到」**。
  要检验「你说话西西听不听得见」，跑 `node scripts/voice-device-check.ts --wav <录音> --expect "<原文>"`（相似度 ≥ 0.5 判 PASS）；
  口径变更说明见 [`testing.md`](testing.md) 与 [`recon/field-test-report-2026-09-30.md`](recon/field-test-report-2026-09-30.md)。
- **输出端点可能被静音**：本机出厂时默认播放端点**就是静音的**（勘测实测），现场测试前先确认系统音量/静音；
  控制台的「Windows 设备读数」卡片会显示默认输入/输出的静音与音量。
- **输入采集增益可能被系统改动**：默认采集增益实测 +5.5 dB（出厂），噪声底几乎 1:1 跟着它走；
  控制台会提示「可考虑设为 0 dB」——**它只提示，不会修改任何系统设置**（改动请自行在系统里做）。
- **摄像头同一时刻只能被一个进程占用（所以：一次只在一个入口点「启用」）**：本机只有 DSHOW 后端能开（MSMF 失败）。
  控制台的「启用」、设备自检里的摄像头一项、`node scripts/verify-camera-presence.ts` 都要打开同一个摄像头，
  **同一时刻请只在一个地方启用**。后到的那个会**失败并给出原因**：`verify-camera-presence.ts` 实测以
  **退出码 2** 结束并打印中文原因（「摄像头在场检测验收 FAILED：没有可用的摄像头」+「先关掉占用摄像头的程序」）；
  控制台这边是子进程未运行、页面不出画面，并把子进程打印的内容原样显示在「子进程说：…」那一行
  （可能是 run.py 的中文提示，也可能是 OpenCV 的英文警告，如 `can't be used to capture by index`），
  **不会假装在场**。
- **模型限流导致延迟波动**：LLM 首字实测 1.7–2.3 s、TTS 1.0–2.0 s，端到端首条回复音频 3.6–5.5 s；
  供应商限流或 `: PROCESSING` 保活会让首字更慢（见 [`recon/mimo-api-probe-2026-09-29.md`](recon/mimo-api-probe-2026-09-29.md)）。
- **household 入口默认连同一个库**（V0.3 P0-B 改了默认值）：`XIXI_DATA_DIR`，未设就是 `data/xixi`——
  终端 `chat`、试用页、常驻语音、现场测试控制台、感知入库都走它；优先级＝显式参数 > `XIXI_DATA_DIR` >
  单入口旧变量（`XIXI_CHAT_DATA_DIR` / `XIXI_WEB_DATA_DIR` / `XIXI_VOICE_DATA_DIR` / `XIXI_DEMO_*`）> 默认。
  **测试与评测一律临时目录**（`mkdtempSync`；`NODE_TEST_CONTEXT` 下默认库也落进程临时目录，见
  [`testing.md`](testing.md)）；`voice-turn` 是测量工具，**默认连 household 库**（测的是真的那个西西），
  只有 `--isolated-store` 才用自己那个库。控制台的 `--data-dir` 仍可单独隔离。
- **对话相关特性的怎么用**：① **多段回复**（`config/xixi.example.yaml` 的 `reply`：`max_segments: 8`、
  `segment_max_chars: 60`、`gap_ms: 450`；**「块长」与「容量」是两件事**：块长 60 字 = 一次播报的粒度，
  容量 = 8 × 60 = **480 字**。贪心按句边界打包，`≤8` 组时每段 `≤60`；`>8` 组时自第 7 组起合并进最后一段、
  `mergedOverflow = true`，该段**可以超过 60 字**（最小反例 279 字 = 9 句 × 31 → 8 段、最长 62；
  断言在 `tests/unit/core/reply-segments.test.ts`）。终端 `npm run chat` 已接逐段播放；**语音出口自第五轮起走另一条路**
  （按句读流式切块 + 逐块合成与播放，见 [`design/voice.md`](design/voice.md) §6）；
  ② **主动性**（人格 `proactivity` 默认 **0.85** → 确定性评分只给候选与依据；**硬底线仍由程序判定**：
  静默时段 / 6 小时与当日**次数**额度 / 隐私与同意——**金额级费用上限尚未实现**；
  底线之上是否开口由模型读空气决定，见 [`adr/0011`](adr/0011-proactive-decision-ownership.md)；
  控制台「配置」栏可调高/调低，**一键关闭**就是不开「自动考虑」开关或点停用；每次开口/被拦都落一条
  **`proactive.decision`** 事件（`conversation.decision` 是「这一轮对话被不被接受」，两者不同），可回答「为什么今天没说话」）。
- **第五轮新增的有界心情怎么用**：默认开着、不需要配置；它由事件自己演化并按小时回落，给模型的是一段**散文**
  （数值只在调试视图里）。想复现「心情在边界内」这件事：`node --test tests/unit/domain.test.ts`
  与 `node --test tests/integration/mood-state.test.ts`；口径与已知问题见 [`adr/0013`](adr/0013-bounded-mood-state.md)。
- **「真人感」改造成什么样了（含前后对比）**：稳定前缀改成「身份与说话方式」的散文（0 条编号）+ 压缩安全段，
  回复容量 180 → 480 字，工具标记与英文推理在**程序层**被剔除（`REPLY_HYGIENE` 通知）。
  可重跑的对比与数字见 [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md)：
  改造前的转录不用花钱就能复算——
  `node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-10-01-v01-vanilla.json`。
- **第五轮新增的两件事怎么判读**（2026-10-03）：
  ① **主动性口径已定＝显著降频**（不做「连续两次没回应后 = 0」的硬停，[`adr/0011`](adr/0011-proactive-decision-ownership.md) 决定 2 的补充）；
  多日验收 `node scripts/eval-proactive-timeline.ts`（默认三天、M1–M6 进退出码）。**「= 0」这句话在真产物上不成立**，这是事实、不是待决问题。
  ② **流式语音的首音目标（pack ≤1.5 秒）未达标且本机不可达**：8 批 n=32 的 ④ / 1500 ms = **[3.14, 7.33] 倍**（池化 3.73 倍），
  下界由模型首 token 与合成往返挡住。**不要因为达不到 1.5 秒判代码不合格**，也不要用 ③ 的「超 15%」口径冒充它；
  同批对照（流式 vs 整段）方向**不一致**（3 快 5 慢），**不许写「方向多数为正」**。口径与复算命令见 [`design/voice.md`](design/voice.md) §6。
- **有界的心情状态（第五轮）**：短期的情绪（不是人格），由原始事件演化、按小时回落；注入提示词的是散文（数值只在 `sections[].debug`）；
  影响轻微（语气 ±6%、主动性软偏移 ±0.03，**都乘在人格之上**），**硬底线拿不到它**；可查看 / 可复位。
  散文里**没有数字与参数名**，且每次恒带「不要因此说出你没做过的事」——见 [`adr/0013`](adr/0013-bounded-mood-state.md)。

**还没验的部分**：M6 的**真人**在场自测尚未由人跑过（合成场景已测），命令见 `progress.md` 的「未完成项」。

## 1. 阅读顺序（第一次接手，约 40 分钟）

| 顺序 | 文件 | 读它的目的 | 预计 |
|---|---|---|---|
| 1 | [`../AGENTS.md`](../AGENTS.md) | 铁律、环境事实、密钥纪律、常用命令 | 5 min |
| 2 | [`handoff.md`](handoff.md) | **现在能跑什么、5 分钟怎么自证、哪些是坏的、有哪些坑** | 10 min |
| 3 | [`progress.md`](progress.md) | 当前状态 + 全部实测结论（§0 是结论表） | 10 min |
| 4 | [`architecture.md`](architecture.md) | 整体结构与数据流（两种大脑、语音链路、持久化） | 10 min |
| 5 | 按需读 [`design/`](design/README.md) | 领域模型 / 对话层 / 大脑与模型 / 语音 / 安全隐私 | 按需 |
| 6 | [`adr/`](adr/) | 为什么这样选（半年后不要推翻已验证的决策） | 按需 |
| 7 | [`recon/`](recon/) | 外部依赖的**原始实测报告**（DSH、MiMo、Pipecat、LiveKit、设备、现场环境、摄像头选型、现场测试报告） | 按需 |
| 8 | [`benchmarks/`](benchmarks/realism-metrics.md) | **基准与前后对比**：真人感指标口径、黄金对话语料接入、改造前后同口径对比 | 按需 |
| 9 | [`verification/`](verification/) | **独立验证**报告（不是实现者自述）：三态判定（通过/失败/未测）、可重跑命令 | 按需 |
| 10 | [`review/`](review/) | **评审**报告：verdict + findings（F 编号 / 严重度）+ 复审结论 | 按需 |
| 11 | [`../xixi_ai_companion_project_plan.md`](../xixi_ai_companion_project_plan.md) | 方案原文（57 节）。**注意：它是设计意图，不是现状** | 按需 |
| 12 | [`v03/ACTUAL_RUNTIME_MAP.md`](v03/ACTUAL_RUNTIME_MAP.md) | **V0.3 开工第一份**：Phase 0 的运行时地图（十个概念的定义处/调用点/目标包/迁移步），以及对 pack 审计结论的逐项复核（哪些和今天的代码不符） | 10 min |
| 13 | [`progress-v03.md`](progress-v03.md) | **V0.3 的按 Phase 索引**的阶段进度：每个 Phase 的交付、Gate 实测（带命令与数字）、明确没做的与遗留；与按时间倒序的 [`progress.md`](progress.md) 分工不同 | 10 min |

本轮新增的报告（都已登记在上表目录里）：

| 报告 | 内容 |
|---|---|
| [`design/perception.md`](design/perception.md) | 摄像头在场检测（M6）的设计：抓帧、检测器、投影、隐私边界 |
| [`recon/field-test-environment-2026-09-30.md`](recon/field-test-environment-2026-09-30.md) | 本机现场环境勘测（噪声、增益、静音、延迟、摄像头） |
| [`recon/camera-detector-choice-2026-09-30.md`](recon/camera-detector-choice-2026-09-30.md) | 摄像头检测器选型实测（帧差动 / YuNet / HOG） |
| [`recon/field-test-report-2026-09-30.md`](recon/field-test-report-2026-09-30.md) | 现场测试报告（设备自检结论：麦克风/扬声器/摄像头，含口径说明） |
| [`verification/proactive-and-segments-verification-2026-09-30.md`](verification/proactive-and-segments-verification-2026-09-30.md) | 多段回复与主动性硬门禁的独立验证（27/27 门禁用例、投递与复算） |
| [`verification/field-test-verification-2026-09-30.md`](verification/field-test-verification-2026-09-30.md) | 现场测试控制台的独立验证 |
| [`review/proactive-and-segments-review-2026-09-30.md`](review/proactive-and-segments-review-2026-09-30.md) | 主动引擎与多段回复的评审（铁律 3 / 费用 / 隐私） |
| [`review/three-column-console-review-2026-09-30.md`](review/three-column-console-review-2026-09-30.md) | 三栏界面与一键启用的评审（子进程与隐私） |
| [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md) | 真人感指标（提问率 / 长度分布 / 禁用模板率）的唯一口径、黄金对话接入、改造前后对比与复现命令 |
| [`review/p1-prompt-length-review-2026-10-01.md`](review/p1-prompt-length-review-2026-10-01.md) 与 [`…-rereview`](review/p1-prompt-length-rereview-2026-10-01.md) | P1 提示词与长度策略的评审与复审（F1 文档漂移 → 由本收口任务执行；F2 口径 / F3 安全措辞 / F4 claim 已修） |
| [`review/reply-hygiene-review-2026-10-01.md`](review/reply-hygiene-review-2026-10-01.md) | 工具标记 / 英文推理清洗的评审（`REPLY_HYGIENE` 已实现；两条 requiredFix 已落地——试用页与控制台订阅 `onNotice`、沉默原因码 `ARTIFACT_ONLY_REPLY` 上线，逐入口清单见 `progress.md` §4） |
| [`verification/t4-realism-verification-2026-10-01.md`](verification/t4-realism-verification-2026-10-01.md) | 「真人感」改造的独立验证：三次输入、主口径提问率、铁律未削弱 |
| [`verification/t7-round5-independent-verification-2026-10-03.md`](verification/t7-round5-independent-verification-2026-10-03.md) | **第五轮四条工作的独立复验**：多日主动性（显著降频口径达标、未回应后不硬停）、话题收口升级（0/91 与反事实 9/91）、**首音延迟未达标（目标不可达）**、有界心情（0 越界 / ±6% / ±0.03 / 门禁同码）。三类证据分开、每个数字带可复跑命令 |
| [`progress-v03.md`](progress-v03.md) | **V0.3 阶段进度（按 Phase 索引）**：P0 与 P1 的交付清单、四条 Gate 实测、库一致硬证据、遗留清单；每条结论带可重跑命令 |
| [`adr/0014`](adr/0014-trusted-memory-policy-and-provenance.md) | 可信记忆策略与 provenance：三条来源与 `sourceType` 权重、四道先决、四条相关性路径（含话题点名）、注入 3~8 与两道分数线、两道出口闸门 |
| [`adr/0015`](adr/0015-context-builder-and-engine-boundary.md) | ContextBuilder 与 ConversationEngine 的边界（谁装配上下文、谁做决定；两道出口闸门；「引擎自己会再建一次 context」这条实现细节） |
| [`adr/0016`](adr/0016-memory-status-state-machine.md) | 记忆状态机（active / superseded / revoked / expired）与纠正闭环；为什么 `expired` 不自动过期 |
| [`verification/t15-p1-independent-verification-2026-10-04.md`](verification/t15-p1-independent-verification-2026-10-04.md)（附可重跑探针 `t15-probe.mjs`） | **Phase 1 的独立复验**：四条技术验收自己复算（文件库 + 每步新进程）、两个场景真模型实跑、**pack 旗舰场景按原句未达标的三条写在最前面**（不替实现者圆场） |
| [`v03/ACTUAL_RUNTIME_MAP.md`](v03/ACTUAL_RUNTIME_MAP.md) | **V0.3 Phase 0 的运行时地图**：pack 点名的十个概念（`buildToolChain` / `ProactiveLoop` / `createModelComposer` / `createModelDecider` / voice helpers / Memory extractor / 各入口 DB / perception DB / prompt builder / DSH 与直连）各自的定义处、调用点、目标包与迁移步；每行附一条可复跑的 `git grep`。另含对 pack 审计报告 `00_CODE_AUDIT.md` 的逐项复核（15 条：一致 / 偏差，附证据） |

## 2. 权威性排序（冲突时按这个判）

```text
1. 代码与测试          ← 唯一事实来源
2. docs/recon/*        ← 对外部系统（模型/框架/设备）的原始实测，带命令与数字
3. docs/benchmarks/*   ← 基准与前后对比：指标定义、同口径的改造前后数字（定义只有一份实现）
4. docs/verification/* ← 独立验证（不是实现者自述）：三态判定 + 可重跑命令
5. docs/review/*       ← 评审与复审：verdict + findings（F 编号/严重度）
6. docs/progress.md    ← 项目状态与结论，人写，可能与代码滞后
7. docs/design/*       ← 设计说明，滞后风险更高
8. docs/adr/*          ← 决策记录，除非决策被明确推翻，否则仍然有效
9. xixi_ai_companion_project_plan.md  ← 方案意图，与现状不符的地方**以现状为准**
```

**发现文档与代码不一致时：以代码为准，并立即修正文档**（不要反过来改代码去迎合文档）。

## 3. 更新触发条件（硬规则）

改完代码后，按这张表检查；不在表里的改动，至少更新 `progress.md` 的时效标记。

| 如果你改了… | 必须同步更新 |
|---|---|
| `packages/contracts/schemas/**`（事件类型/payload/版本） | [`event-contracts.md`](event-contracts.md)、`design/domain-model.md`、`tests/unit/contracts.test.ts` 的漂移断言 |
| `packages/domain/src/migrations/*.sql` | `design/domain-model.md` 的表结构小节、`progress.md` |
| `packages/domain/src/personality.ts`（属性集合） | `design/domain-model.md`、`config/xixi.example.yaml`、`design/conversation.md` 的指令映射 |
| `packages/conversation/src/fsm.ts`（状态/超时/判定） | `design/conversation.md`、`tests/unit/conversation-fsm.test.ts` |
| `packages/conversation/src/prompt.ts`（§26 顺序/指令） | `design/conversation.md`、`tests/unit/prompt.test.ts` |
| `packages/conversation/src/segments.ts`（段数上限/块长/容量，以及流式那边的 `ClauseChunker`） | `design/conversation.md` §7、[`adr/0010`](adr/0010-multi-segment-replies.md) 的修订记录、本文件 §0 与 `README.md` 的「多段回复」行；**切块（流式）那部分**同步 [`design/voice.md`](design/voice.md) §6.2 |
| `packages/conversation/src/topic-engine.ts`（收口判据与词表） | `design/conversation.md` 的收口段、[`adr/0012`](adr/0012-open-thread-closure-criterion.md) §判据升级、`progress.md` |
| `packages/domain/src/mood.ts` 或提示词的 mood 段 | `design/domain-model.md`（心情状态与迁移 005）、`design/conversation.md`（注入与影响幅度）、[`adr/0013`](adr/0013-bounded-mood-state.md)、`progress.md` |
| `packages/model-adapters/src/reply-hygiene.ts` 或引擎的清洗/通知 | `design/brain-and-models.md` §4、`design/conversation.md` 的通知表、`progress.md` |
| `scripts/lib/realism-metrics.ts` 或 `scripts/eval-realism.ts`（指标口径/语料） | [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md) 的口径段、`tests/scenarios/realism-metrics.test.ts` |
| `packages/brain-adapter/src/types.ts`（§25 接口） | `design/brain-and-models.md`、`architecture.md` |
| `packages/brain-adapter/src/tools.ts` 或新增工具 | `design/security-and-privacy.md`（工具权限）、`design/brain-and-models.md`、`config/xixi.example.yaml`（若需配置） |
| `packages/model-adapters/src/mimo.ts`（含 `chatJson` 策略） | `design/brain-and-models.md`、`recon/mimo-api-probe-2026-09-29.md`（若发现新缺陷） |
| `apps/brain-dsh/profile/cordis.patch.yml`（插件集/人格/system prompt） | `design/brain-and-models.md`、`architecture.md`、`design/security-and-privacy.md`（权限面） |
| `services/voice-edge/**` 或 VAD 参数 | `design/voice.md`、`recon/pipecat-spike-2026-09-29.md`、`recon/device-acceptance-2026-09-30.md` |
| `services/voice-edge/**/voice_stream.ts`（切块与流式合成） | [`design/voice.md`](design/voice.md) §6（流式语音：链路、ClauseChunker 触发条件、③/④ 口径、`--out`/`--compare` 复算）、[`recon/voice-streaming-2026-10-01.md`](recon/voice-streaming-2026-10-01.md)、`testing.md` 的语音命令 |
| `scripts/lib/voice-latency.ts`（首音配对的判定规则） | [`design/voice.md`](design/voice.md) §6.3/§6.4、[`recon/voice-streaming-2026-10-01.md`](recon/voice-streaming-2026-10-01.md) §二的「结论句」、`tests/unit/voice/voice-latency.test.ts` |
| `scripts/voice-turn.ts`（首音测量入口与 `--compare`） | [`design/voice.md`](design/voice.md) §6.4、[`recon/voice-streaming-2026-10-01.md`](recon/voice-streaming-2026-10-01.md) §一/§二、[`benchmarks/v01-baseline.md`](benchmarks/v01-baseline.md) §3.1 的四段口径 |
| `services/perception-edge/**` 或在场检测参数 | [`design/perception.md`](design/perception.md)、`recon/camera-detector-choice-2026-09-30.md` |
| `scripts/field-test.ts`（现场测试控制台） | `design/perception.md`、`design/voice.md`、[`testing.md`](testing.md) 的脚本表、本文件 §0 的用户须知 |
| `packages/conversation/src/proactive.ts` 或人格默认值 | `design/conversation.md`、[`adr/0009`](adr/0009-proactive-triggers-and-hard-gates.md)、本文件 §0（主动性怎么调/怎么关） |
| 任何 `scripts/verify-*.ts` / `eval-*.ts` / `voice-*.ts` | [`testing.md`](testing.md) 的脚本表、`README.md` 的命令段、`AGENTS.md` §7 |
| 里程碑推进（做完 M2/M3/…） | `progress.md` §0/§1、`architecture.md` 的「未实现」列表、相关 `design/*` |
| 新增/更新 `docs/verification/**` 或 `docs/review/**` | 本文件 §1 的报告表、`progress.md` 的「评审与验证汇总」 |
| 新增/更新 `docs/benchmarks/**`（基准、指标口径、前后对比） | 本文件 §1 的报告表与 §2 的权威性排序、`progress.md` §0 |
| 新增外部依赖 | 新 ADR + `AGENTS.md` 铁律 12 的引用 |
| 修改方案里的既定原则 | **不要做**；如有异议写新 ADR 说明 |

## 4. 文档新鲜度自检（可执行）

接手时/提交前跑这几条，能快速发现文档漂移：

```powershell
cd E:\worker2
npm test                                      # 测试数与 docs/testing.md、progress.md 是否一致
npm run check:docs                            # 链接、文件引用、新鲜度标记是否仍然成立
npm run install:profile                       # profile 自检（会打印 bundles 与校验结果）
node scripts/field-test.ts --self-test        # 现场测试控制台离线自检（项数以末行为准）
node scripts/show-turns.ts data/chat/xixi.sqlite 3   # 事件日志仍可读、字段仍在
# 交叉检查：文档里提到的脚本是否真的存在
foreach ($f in @('scripts/verify-m0.ts','scripts/verify-provider-route.ts','scripts/verify-structured-output.ts',
                 'scripts/eval-conversation.ts','scripts/voice-turn.ts','scripts/voice-bargein.ts',
                 'scripts/voice-device-check.ts','scripts/serve-chat.ts','scripts/chat.ts','scripts/show-turns.ts',
                 'scripts/make-audio-fixtures.ts','scripts/check-docs.ts','scripts/field-test.ts',
                 'scripts/verify-camera-presence.ts','scripts/verify-voice-noise.ts')) { if (Test-Path $f) { "OK  $f" } else { "缺失 $f" } }
```

`npm run check:docs` 会检查三件事，全部是「文档说了不存在的东西」这类错误：
markdown 相对链接、反引号里的仓库路径、`docs/` 活文档的「最后更新」标记。
它失败就说明文档已与代码脱节——**提交前应该跑一次**。

## 5. 写文档的规矩（避免文档变成幻觉源）

1. **每条关键结论要能指到源文件**（行内代码写路径）。指不到的，就不要写。
2. **区分「设计意图」与「当前实现」**：方案里有、代码里没有的，写成「未实现（属 Mx）」。
3. **实测结论必须带数字与出处**（哪个 recon 报告、什么命令、什么条件）。不要写「很快」「效果不错」。
4. **不写没验证过的东西**；必须写时显式标注「未验证」。
5. 每份文档开头带 `最后更新` 与 `权威来源`，结尾带 `维护规则`。
6. 密钥、令牌、个人数据**永远不写进文档**。
