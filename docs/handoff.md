# 接手交接书（Handoff）

> 最后更新：2026-10-01（第二次暂停见下面 §0）
> 权威来源：`docs/progress.md`（结论与数字）、`docs/recon/*`（外部系统实测）、代码与测试
> 若与代码不一致，以代码为准，并请立即修正本文件

**这份文件的目标**：让一个新接手的 Agent（或上下文被压缩后的你自己）在 **10 分钟内**知道——
现在能跑什么、怎么自证、哪些是坏的、有哪些坑、下一步该做什么。

---

## 0. 本次暂停状态（2026-10-01 第二次：用户指示「暂停所有任务，一会换个模型重新开始」）

**怎么停的**：captain 中断了在途成员的会话（proactive-eng 停在 t3 中途），**t3 保持 in_progress 作为冻结点**——
t4 到 t12 全被依赖挡住，全队没有任何可派任务。团队 `xixi-v02-round2`（6 成员、12 任务）**未归档、未删除**，
状态与契约文件在 `.agent-teams/xixi-v02-round2`（gitignored、在本机盘上）；第一轮的 `xixi-v02-p0p1` 仍是归档态。
上一次用户叫停（第一轮）时 t21 的工作区成了在途快照 `d6d8db7`（310/310 绿、未经验收），
本轮 t1 已把它核对收口（见下表）。

**已经做完并验证过的（可以放心用）**：
- **P0 基线**（`docs/benchmarks/v01-baseline.md`）：改造前的提问率、长度分布、语音四段延迟（首个可听 **P50 6.8s**）
- **P1 提示词与上下文重写 + 回复长度分布**：跨轮复述归零、长度有分布、容量 180→480 字（`docs/progress.md` §2.18）
- **真人感指标与黄金对话评测**：`node scripts/eval-realism.ts`（口径与局限见 `docs/benchmarks/realism-metrics.md`）
- **回复卫生**：工具调用标记与英文思维链不再进正文（真实 MiMo 复现缺陷现场并验证清除）
- **主动性 V2**：社会预算 + 读空气 + 模型决定是否开口；机制成立，**但 Phase 5 两项验收未达标**
- **文档收口**：README / progress / handoff / ADR / 两份评测报告

**第二轮进展（团队 `xixi-v02-round2`，契约与状态在 `.agent-teams/xixi-v02-round2`）**：

| 任务 | 状态 |
|---|---|
| t1 核对并补完 t21 在途快照 | ✅ 完成、t2 评审 **pass**；交付 **`df294b7`**（补完时间闸门时段词误拦与适配器无测试两条缺口；`npm test` 314/314、check:docs 92 份；**已推送**） |
| t3 修 Phase 5 六条缺陷 + 交付时间线命令 | ⏸ **在途暂停**（成员会话已中断，attempt 仍归 proactive-eng）；工作区已作在途快照 **`23248f3`**（`npm test` 319/319、check:docs 92 份——**绿但未经验收**） |
| t4 独立复验 Phase 5 时间线（五项目标判定报告） | ⏸ pending，依赖 t3 |
| t5 评审 t3 | ⏸ pending，依赖 t4 |
| t6 / t7 pack **Phase 2** 工具注册表与语音接工具 + 评审 | ⏸ pending |
| t8 / t9 pack **Phase 3** 未完话题与话题引擎 + 评审 | ⏸ pending |
| t10 / t11 pack **Phase 4** 记忆关系自我反馈 + 评审 | ⏸ pending |
| t12 集成收口（文档同步 + 全量门禁） | ⏸ pending，依赖 t11、t4 |

**恢复方式（换模型后二选一）**：
1. **续用本团队**：用户明确要求恢复时用 `agent_teams_resume`（理由必填，见 AGENTS 队长协议第 9 条）；
   t3 的 attempt 还在，给 proactive-eng 发消息即可续跑同一尝试；接手的 captain 先读本节与 `.agent-teams` 里的 t3 契约。
2. **换模型重建**：现有 6 名成员的模型路线固定为 `opencode-go/mimo-v2.6-flash` 且运行中不可改——
   若要换成员模型，就归档本团队，照上表与状态文件里的契约新建团队（改依赖在前、取消在后，AGENTS §9.22）。
改造包在 `E:\worker2\xixi_v02_refactor_pack`（**未跟踪**，是否入库由用户决定）。

**两件排队的事（恢复后处理）**：
1. **3 处文档漂移** → 归 t12：README、`docs/design/conversation.md`、`docs/README.md` 仍写「产线未订阅
   onNotice / 页面不可区分 / SILENCE_ARTIFACT_ONLY 不存在」，实际产线已订阅并区分沉默原因、代码名 `ARTIFACT_ONLY_REPLY`；
2. **engine.ts 中文分钟令牌恒按 30 分**（快照既有、45 分钟容差下的窄假阴性，t2 评审观察）→
   在 **t11 之后、t12 之前**插一个收尾微任务：先 `edit_plan` 给 pending 的 t12 补依赖、再建任务（AGENTS §9.22）。

**不得声称已通过的**：pack Phase 5 的 12 小时时间线验收（generic 占比 33.3% 高于 20%、两次未回应不降频）。
证据与六条缺陷见 `docs/verification/t9-proactive-v2-verification-2026-10-01.md` 与
[`docs/adr/0011-proactive-decision-ownership.md`](adr/0011-proactive-decision-ownership.md)。

**坑（本轮新记的，都在 `AGENTS.md` §9）**：取消被依赖的任务会让下游永久卡死（§9.22）；
提交要按文件不要按目录（§9.7）；文档里的命令必须原样可跑（§9.8）。

---

## 1. 三十秒版

西西是一个**长期陪伴型语音智能体**的原型（不是聊天机器人）。当前完成到「**初步验证阶段**」：

- **文本对话流畅**：多轮连贯、有人格、会主动沉默、能查真实天气；**2026-10-01 起提示词前缀＝「身份与说话方式」（散文 + 紧凑安全段），回复容量 180 → 480 字**，同一批语料的提问率主口径 45.8% → 46.0%、单段最长 341 → 170 字（对比命令见 [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md)）；
- **语音链路可用**：浏览器麦克风 → VAD → ASR → 对话 → TTS，打断判定实测 192ms；
- **重启不忘事**：会话、轮次、人格都在 SQLite，两个独立进程验证过；
- **摄像头在场检测可用（M6 最小版）**：帧差动 + YuNet 人脸确认，全在本机跑，状态写成 `presence.changed` 并投影到 `world_state`（带 TTL），离线回归在默认门禁里（`npm run test:perception`，项数看末行）；
- **Harness 可替换**：DSH 与直连 MiMo 两套实现共用 `BrainAdapter` 接口（实时走直连，见 ADR-0008）。

未实现：唤醒词、长期记忆、模型驱动的人格学习（分别属 M2/M4/M3）；主动开口的**机制**（主动性 V2）已落地，但 **pack Phase 5 的两项时间线验收未达标**（generic 话题 33.3% > 20%、两次未回应后不降频，六条缺陷待修，见 [`verification/t9`](verification/t9-proactive-v2-verification-2026-10-01.md)）；摄像头在场检测的**「真人站在镜头前被检出」这一步尚未实测**（摄像头朝天，见 [`design/perception.md` §8.3](design/perception.md)）。
⚠️ 现场设备验收结论已修正：扬声器按「能量比」口径只有 ~2.4 dB（<10 dB）→ **判 FAIL**（旧的 12.97 dB PASS 是帧级分位口径的乐观上界），见 [`recon/field-test-report-2026-09-30.md`](recon/field-test-report-2026-09-30.md) 顶部「口径变更说明」。

## 2. 五分钟自证（照抄即可）

```powershell
cd E:\worker2
npm install                    # workspace 链接 + js-yaml + dsh-tools（失败可挂代理 127.0.0.1:7890）
npm test                       # 期望：全绿，不联网（**项数以末行为准**——2026-09-30 实测点 223 项；耗时以实跑为准，本机空载约 15s）
npm run field-test             # 👉 现场测试控制台 http://127.0.0.1:8792：麦克风电平/噪声底 + 摄像头在场 + 每轮延迟与动作 + 设备自检
npm run web                    # 试用对话页 http://127.0.0.1:8791，打字或按住🎤说话
```

需要真实调用（花钱、看外部系统是否健康）时：

```powershell
npm run verify:provider              # 1 次调用：DSH → MiMo → 工具调用 → 回答
npm run verify:structured-output     # 3~4 次调用：结构化输出契约 + 供应商缺陷金丝雀
npm run eval:conversation:judge      # ~26 次调用：8 场景对话评测 + 评审模型，报告写进 docs/recon/
npm run verify:m0                    # 2 次调用：两个独立进程的重启恢复
npm run voice:bargein                # 0 次调用：打断判定延迟（纯本地）
```

`.env` 里必须有 `MIMO_API_KEY`（复制 `.env.example`）。**没有密钥时**：`npm test`、`npm run voice:bargein`、`npm run chat -- --fake` 仍可跑。

## 3. 现状矩阵

| 能力 | 状态 | 自证方式 |
|---|---|---|
| 事件契约（`xixi.event.v1`，3 类事件） | ✅ 完成 | `npm test`（contracts 用例含 fail-closed 与漂移检查） |
| 领域持久化（事件日志/会话/人格基线/迁移） | ✅ 完成 | `npm test`（迁移幂等、篡改检测、人格只补缺） |
| 对话层（FSM §12/§13 + Prompt §26 + 沉默 §55） | ✅ 完成（P1 改版：前缀＝身份与说话方式 + 安全段；历史只走 messages） | `npm test` + `npm run chat` |
| 「真人感」指标与前后对比 | ✅ 有可重跑口径（三分指标 + 黄金对话语料） | `node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-10-01-v01-vanilla.json`（改造前，不花钱）与同目录的 `-v02-wip.json`；完整对比见 [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md) |
| 制品清洗（工具标记 / 英文推理） | ✅ 程序层已落地（`REPLY_HYGIENE`）；⚠️ 产线未订阅 `onNotice` | `npm test`（`tests/unit/core/engine-reply-hygiene.test.ts`）；缺口见 `progress.md` §4 |
| 人格可调并体现在行为 | ✅ 完成 | `eval:conversation:judge`（低/高话多组长度差 **2.57×**：22.3 字 vs 57.3 字，见 `docs/progress.md` §0） |
| 只读工具（时间/天气） | ✅ 完成 | `node scripts/probe-tools.ts` |
| 直连 MiMo 实时路径（流式 + 工具循环） | ✅ 完成 | `npm run chat` |
| DSH Harness 路径（含 profile 与工具插件） | ✅ 完成（M0 验收） | `npm run verify:m0` / `npm run verify:provider` |
| 语音输入（浏览器采集 → VAD → ASR → 对话 → TTS） | ✅ 完成 | 页面按住🎤；或 POST `/api/voice`。**多段语音全部使用**（不再只取第一段），整段录音不落盘（`docs/field-test-report` 见下） |
| 现场测试控制台（一条命令 + 设备验收引导） | ✅ 完成 | `npm run field-test` → http://127.0.0.1:8792；离线自检 `node scripts/field-test.ts --self-test`（项数随回归断言增加，以其末行为准） |
| 语音闭环（文件驱动） | ✅ 完成 | `npm run voice:turn -- --wav tests/audio-fixtures/direct-question.wav`（输出里含 `segmentsUsed/droppedSegments`） |
| 打断判定（离线） | ✅ 完成（判定层面） | `npm run voice:bargein`（192ms） |
| 真实麦克风/扬声器/摄像头验收 | ⚠️ 口径修正后扬声器判 FAIL（2026-09-30） | `node scripts/field-test.ts --acceptance`：麦克风/摄像头通过，**扬声器按「能量比」口径只比噪声底高 ~2.4 dB（<10 dB）→ FAIL**（旧报告按帧级分位写 12.97 dB PASS，是乐观上界）。见 [`recon/field-test-report-2026-09-30.md`](recon/field-test-report-2026-09-30.md) 顶部的「口径变更说明」；改善路径：音量 ≥50%、麦克风离扬声器 0.3–1 m、采集增益设 0 dB 后重跑 |
| 扬声器真正静音的延迟（§33 P50<500ms） | ⛔ 未验收 | 需要设备 |
| 唤醒词 / 搭话判定（§13 完整版） | ⛔ 未实现（M2） | — |
| 长期记忆 / 纠正（§10） | ⛔ 未实现（M4） | — |
| 主动开口（§15，主动性 V2） | ⚠️ 机制已落地，**pack Phase 5 两项验收未达标；六条缺陷未修** | 机制：硬底线（程序）+ 模型读空气（ADR-0011）——`npm test` 的门禁用例、`node scripts/eval-realism.ts` 的 G07/G12 用例可复跑。**未达标**：内容口径 generic 话题 **33.3%**（目标 ≤20%）、**「连续两次没回应后显著降频」不成立**（被忽视的一天与有人回应的一天都是 9 次）；六条 findings（F1–F6，含「沉默候选吃光 tick」与「读空气问询吃光当日额度」）**尚未修复**，修复任务 t18、复验 t19。**判定与数字**：[`verification/t9-proactive-v2-verification-2026-10-01.md`](verification/t9-proactive-v2-verification-2026-10-01.md)（**不得写成已通过**） |
| 摄像头在场检测（§M6） | ✅ 最小可用（真人实测未做） | `npm run test:perception`（离线，含转发 Python 回归；项数看末行）；真机自检 `node scripts/verify-camera-presence.ts --seconds 15`；接口见 [`design/perception.md`](design/perception.md) §8.3（真人站镜头前那一步未完成） |
| 模型驱动的人格学习（§7.4） | ⛔ 未实现（M3） | 目前只有管理员 `overrideSelfProfile` |
| 类型检查（`tsc --noEmit`） | ⛔ 未接入 | Node 直接跑 `.ts`，类型错误只在运行时暴露 |
| 事件回放（§22.3） | ⛔ 未实现（M5） | `tests/replay/` 为空 |

## 4. 必须先知道的坑（都是踩过的）

1. **PowerShell 会把 stderr 当作失败**：脚本往 stderr 打日志时，`$LASTEXITCODE` 可能显示 1，但进程其实返回 0。
   判断真实退出码要重定向：`node x.ts > out.txt 2> err.txt; $LASTEXITCODE`。
2. **MiMo 的 `json_schema` 会间歇性补白截断**（`strict` 与否都出现过）：必须先解析+**本地 schema 校验**，失败回退 `json_object`。
   已封装在 `MimoClient.chatJson`，金丝雀是 `npm run verify:structured-output`。**永远不要相信 provider 的 strict**。
3. **`tool_choice` 除 `auto` 外全部被忽略**：不能靠它强制调用工具；只能提示词驱动 + 自行校验 `tool_calls`。
4. **MiMo 会同时返回「开场白 + tool_calls」**：所以「有文本」≠「已回答」。曾因此让工具永不执行（见 `scripts/probe-tools.ts`）。
5. **接口延迟波动极大**：同一份代码实测首字 0.3–1.2s（正常）到 7–18s（限流/排队）。质量不受影响，但会误导「很慢」的结论——测延迟要同批次比较并记录时间。
6. **DSH 每轮启动一个 profile：4–7 秒**。所以实时路径不用它（ADR-0008）；别为了「统一」把实时改成 DSH。
7. **本机麦克风链路取不到语音**（Python `sounddevice` 路径）：录音 99.5% 能量 <100Hz。浏览器路径（`getUserMedia`）是另一套前端，优先用它。
8. **`MIMO_API_KEY` 曾明文出现在对话里，应视为已泄露**，需到小米控制台轮换；密钥只在 `.env`（已 gitignore，提交里没有）。
9. **DSH 是 0.1.7-rc.2（RC）**：升级前先跑 `npm test` + 两个 verify 脚本；配置写在 `apps/brain-dsh/profile/cordis.patch.yml`（仓库持有），用 `npm run install:profile` 装进 `.dsh/`。
10. **不要用系统 Python 3.14** 跑语音代码（Pipecat/LiveKit 需要 3.10–3.12）；用 `.venvs/voice-pipecat` 或 `.venvs/voice-livekit`。

## 5. 环境与路径速查

| 东西 | 位置 |
|---|---|
| 仓库 | `E:\worker2`（已 `git init`，最近提交见 `git log --oneline`） |
| 密钥 | `E:\worker2\.env`（`MIMO_API_KEY`），模板 `.env.example` |
| DSH home（项目内） | `E:\worker2\.dsh`（`npm run install:profile` 幂等重建） |
| 数据库 | `data/chat`、`data/web-chat`、`data/voice*`（都已 gitignore） |
| 音频夹具 | `tests/audio-fixtures/*.wav`（MiMo TTS 生成，可重跑 `node scripts/make-audio-fixtures.ts`） |
| Python 3.12 | `%LOCALAPPDATA%\Programs\Python\Python312\python.exe` |
| Pipecat venv | `E:\worker2\.venvs\voice-pipecat`（pipecat-ai 1.12.0） |
| LiveKit venv | `E:\worker2\.venvs\voice-livekit`（livekit-agents 1.8.3 + sounddevice/soundfile） |
| 试用页 | `npm run web` → http://127.0.0.1:8791（`--dsh` 可切到 Harness 路径） |
| 现场测试控制台 | `npm run field-test` → http://127.0.0.1:8792（设备验收报告：`docs/recon/field-test-report-<日期>.md`） |
| 端点在不在静音 | `node scripts/field-test.ts --acceptance` 会打印默认输出/输入设备的 muted 与音量（出厂静音是上一轮验收失败的根因） |

## 6. 下一件事（如果只做一件事）

**把 `onNotice` 接进产线**（小而具体，立刻提升可解释性），然后**做 M2 的唤醒与搭话判定**（当前最大缺口）：

`REPLY_HYGIENE` / `UNBACKED_FACT_CLAIM` 两条审计通知已经发得出来，但 `scripts/chat.ts` / `serve-chat.ts` /
`field-test.ts` / `voice-turn.ts` 都没订阅它们——于是「程序改写了她说的话」与「模型本来就这么说」在页面与日志里
**同形**，用户只看到「西西选择沉默」。最小修法（评审给了两个选项）见
[`review/reply-hygiene-review-2026-10-01.md`](review/reply-hygiene-review-2026-10-01.md)，未完成项记在 `progress.md` §4。

**M2 为什么不能外包**：Pipecat 与 LiveKit 的 VAD/EOU 都无法区分电视与真人（电视 p=0.91~0.92 被判「说完」），
而「嗯。」这类 backchannel 两家都判错（Pipecat 甚至根本检不到）。

建议第一步（可在没有任何模型调用的情况下做完）：
1. 在 `packages/conversation` 里加一个**纯函数** `addressedProbability(signals)`：输入唤醒词分数、说话人相似度、会话状态、语义承接、音频方向/信噪比，输出 `P(addressed_to_xixi) ∈ [0,1]`；
2. 用 `tests/scenarios/corpus.ts` 的思路补一组**对抗语料**（电视/外人/自语 vs 直呼），先只做阈值判定与单元测试；
3. 唤醒词模型本身可用 openWakeWord 或 `E:\worker\models` 里已验证过的 sherpa-onnx KWS 路线（那套在本机跑通过），但**先定接口与判定逻辑**，再换具体模型。

同时记得：接入后要更新 `progress.md` §0/§1、`architecture.md` 的「未实现」列表、`design/conversation.md` 的判定小节。

## 7. 动代码前的检查清单

- [ ] 读过 `AGENTS.md` 的铁律（尤其：模型不能改规则/权限、主动行为在**硬底线**上必须过程序判定、事件是唯一事实来源）
- [ ] `npm test` 是绿的（**项数以末行为准**——2026-09-30 实测点 223 项；耗时以实跑为准，本机空载约 15s），知道哪些用例覆盖你要改的地方
- [ ] 新行为**先写测试**（离线可跑），真实 API 验证放 `scripts/verify-*` / `eval-*`，不进 `npm test`
- [ ] 不新增依赖，或新增时写清新 ADR 与理由
- [ ] 改完按 [`README.md` §3 更新触发条件](README.md) 同步文档
- [ ] 把「做了什么、怎么验证、下一步、已知问题」写进 [`progress.md`](progress.md)
