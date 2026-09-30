# 接手交接书（Handoff）

> 最后更新：2026-09-30
> 权威来源：`docs/progress.md`（结论与数字）、`docs/recon/*`（外部系统实测）、代码与测试
> 若与代码不一致，以代码为准，并请立即修正本文件

**这份文件的目标**：让一个新接手的 Agent（或上下文被压缩后的你自己）在 **10 分钟内**知道——
现在能跑什么、怎么自证、哪些是坏的、有哪些坑、下一步该做什么。

---

## 1. 三十秒版

西西是一个**长期陪伴型语音智能体**的原型（不是聊天机器人）。当前完成到「**初步验证阶段**」：

- **文本对话流畅**：多轮连贯、有人格、会主动沉默、能查真实天气；
- **语音链路可用**：浏览器麦克风 → VAD → ASR → 对话 → TTS，打断判定实测 192ms；
- **重启不忘事**：会话、轮次、人格都在 SQLite，两个独立进程验证过；
- **摄像头在场检测可用（M6 最小版）**：帧差动 + YuNet 人脸确认，全在本机跑，状态写成 `presence.changed` 并投影到 `world_state`（带 TTL），离线回归在默认门禁里（`npm run test:perception`，项数看末行）；
- **Harness 可替换**：DSH 与直连 MiMo 两套实现共用 `BrainAdapter` 接口（实时走直连，见 ADR-0008）。

未实现：唤醒词、长期记忆、主动问候、模型驱动的人格学习（分别属 M2/M4/M5/M3）；摄像头在场检测的**「真人站在镜头前被检出」这一步尚未实测**（摄像头朝天，见 [`design/perception.md` §8.3](design/perception.md)）。
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
| 对话层（FSM §12/§13 + Prompt §26 + 沉默 §55） | ✅ 完成 | `npm test` + `npm run chat` |
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
| 主动问候（§15） | ⛔ 未实现（M5） | — |
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

**做 M2 的唤醒与搭话判定**，因为它是当前最大缺口，且已被证明**不能外包**：
Pipecat 与 LiveKit 的 VAD/EOU 都无法区分电视与真人（电视 p=0.91~0.92 被判「说完」），
而「嗯。」这类 backchannel 两家都判错（Pipecat 甚至根本检不到）。

建议第一步（可在没有任何模型调用的情况下做完）：
1. 在 `packages/conversation` 里加一个**纯函数** `addressedProbability(signals)`：输入唤醒词分数、说话人相似度、会话状态、语义承接、音频方向/信噪比，输出 `P(addressed_to_xixi) ∈ [0,1]`；
2. 用 `tests/scenarios/corpus.ts` 的思路补一组**对抗语料**（电视/外人/自语 vs 直呼），先只做阈值判定与单元测试；
3. 唤醒词模型本身可用 openWakeWord 或 `E:\worker\models` 里已验证过的 sherpa-onnx KWS 路线（那套在本机跑通过），但**先定接口与判定逻辑**，再换具体模型。

同时记得：接入后要更新 `progress.md` §0/§1、`architecture.md` 的「未实现」列表、`design/conversation.md` 的判定小节。

## 7. 动代码前的检查清单

- [ ] 读过 `AGENTS.md` 的铁律（尤其：模型不能改规则/权限、主动行为必须过硬门禁、事件是唯一事实来源）
- [ ] `npm test` 是绿的（**项数以末行为准**——2026-09-30 实测点 223 项；耗时以实跑为准，本机空载约 15s），知道哪些用例覆盖你要改的地方
- [ ] 新行为**先写测试**（离线可跑），真实 API 验证放 `scripts/verify-*` / `eval-*`，不进 `npm test`
- [ ] 不新增依赖，或新增时写清新 ADR 与理由
- [ ] 改完按 [`README.md` §3 更新触发条件](README.md) 同步文档
- [ ] 把「做了什么、怎么验证、下一步、已知问题」写进 [`progress.md`](progress.md)
