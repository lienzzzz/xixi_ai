# 西西（Xixi）

长期常驻家庭环境的陪伴智能体。当前进度：**M0（DSH + MiMo 文本 Harness）验收已通过**。

> 完整设计与实施方案见 [`xixi_ai_companion_project_plan.md`](xixi_ai_companion_project_plan.md)；
> 编码约定见 [`AGENTS.md`](AGENTS.md)；当前进度与恢复指引见 [`docs/progress.md`](docs/progress.md)。
> 西西不是「带摄像头的聊天机器人」：**可替换**的是模型 / ASR / TTS / 摄像头 / Harness，
> **不可替换**的是长期状态与行为策略（WorldState、Memory、FutureHook、SelfModel、RelationshipModel、
> RoutineModel、Proactive policy、Conversation state）。

## M0 已验证的范围

| 能力 | 证据 |
|---|---|
| 文字 → DSH → MiMo → 结构化工具调用 → 回答 | `npm run verify:provider`：一次真实调用，`xixi_get_current_time` 被真实调用 |
| 重启 → 会话恢复 | `npm run verify:m0`：**两个独立进程**，第二个进程逐字复现了第一个进程的回答 |
| 事件契约与 fail-closed 校验 | `npm test`：未知字段、越界置信度、版本不符一律拒绝 |
| 持久化与迁移 | `npm test`：迁移幂等；已应用迁移被改写则拒绝启动；重复事件被拒 |
| 人格基线持久化 | 重启只补缺不覆盖（§33「重启后持久人格恢复 100%」） |

实测记录（2026-09-29）：

```text
进程 1：文字 → DSH → mimo-v2.6-flash → tool xixi_get_current_time → "2026-09-29T15:13:51.620Z"（6.3s）
进程 2（全新进程）：同一 sess_… 与同一 DSH session-a75b1195-…，被问「上一条回复是什么」时逐字复现
```

## 快速开始

需要 Node.js 24（本仓库用 Node 原生类型擦除直接运行 `.ts`，**没有构建步骤**）。

```powershell
npm install                                   # workspace 链接 + js-yaml + dsh-tools
node scripts/install-dsh-profile.ts           # 装项目内 DSH profile（.dsh/），幂等
Copy-Item .env.example .env                   # 填入 MIMO_API_KEY（.env 已被 gitignore）

npm run field-test                            # 👉 一条命令的现场测试控制台：http://127.0.0.1:8792
                                              #    麦克风电平/噪声底 + 摄像头在场 + 每轮延迟与动作 + 设备验收引导
npm run web                                   # 试用对话页：http://127.0.0.1:8791（含按住🎤语音输入）
npm test                                      # 全部离线测试，不花 API 费用（2026-09-30 实测 95 项）
npm run chat                                  # 终端对话（直连 MiMo 实时路径）
npm run demo:m0:text                          # 离线单轮演示（FakeBrainAdapter）
npm run voice:turn -- --wav tests/audio-fixtures/direct-question.wav   # 语音闭环
npm run voice:bargein                         # 打断判定延迟（纯本地）
npm run voice:noise                           # 噪声鲁棒性回归（干净+噪声夹具 → 前端 → VAD → ASR；--fake 离线）
npm run verify:provider                       # 一次真实调用：验证 MiMo 路由与工具调用
npm run verify:m0                             # M0 验收：真实两进程重启恢复
npm run eval:conversation:judge                # 对话质量评测（含评审模型）
```

现场测试（第一天就该跑的那条命令）：

```powershell
npm run field-test                        # 打开控制台：页面按「麦克风 → 扬声器 → 摄像头」引导自检
npm run field-test -- --offline           # 没有密钥也能看页面与跑设备自检（ASR/模型用替身）
node scripts/field-test.ts --self-test    # 离线自检：隐私 / 多段语音 / 页面 / 报告，不碰硬件
node scripts/field-test.ts --acceptance   # 只跑一次真机验收，重写 docs/recon/field-test-report-<日期>.md
```

**第一次接手请读** [`docs/README.md`](docs/README.md)（文档地图）与 [`docs/handoff.md`](docs/handoff.md)（现状、自证、坑、下一步）。

需要外网时可能要走代理：`$env:HTTPS_PROXY='http://127.0.0.1:7890'`、`$env:NODE_USE_ENV_PROXY='1'`。

## 仓库结构（当前实际存在）

```text
packages/contracts/       事件信封与 payload schema（xixi.event.v1），所有服务共用
packages/domain/          唯一写 SQLite 的包：事件日志、会话、人格基线、迁移执行器
packages/brain-adapter/   BrainAdapter 接口 + FakeBrainAdapter + DSH 适配器 + 离线脚本化 transport
apps/brain-dsh/           DSH 侧接线：profile patch（MiMo 路由）与 CLI transport
plugins/xixi-tools/       西西最小工具集（M0 只有 xixi_get_current_time）
config/                   xixi.example.yaml（方案 §42）
scripts/                  安装、验收与演示脚本（field-test.ts = 现场测试控制台入口）
tests/                    unit / integration / console / scenarios（corpus.ts 语料）/ replay（replay 尚未填充）
docs/                     architecture.md、event-contracts.md、testing.md、progress.md、handoff.md、adr/、recon/
```

## 设计要点（M0 已落地）

- **Harness 隔离**：只有 `packages/brain-adapter` 与 `apps/brain-dsh` 知道 DSH 存在；其余代码只看到领域词汇。
- **事件日志是唯一事实来源**：对话轮次就是 `conversation.turn` 事件，不另建表，避免同一事实两份真相。
- **持久人格是「恢复」不是「重置」**：每次启动只补缺失的属性，已有值永不覆盖。
- **Harness 会话映射在领域层**：`conversation_sessions.brain_provider` + `brain_session_id`，换掉 DSH 也不丢同一段西西。
- **默认关闭深度思考**：MiMo 服务端默认开启思考，路由用 `reasoning: off` + `reasoningEfforts` 明确关闭（方案 §46.1）。

## 明确的未完成项

- M1 之前必须先有 Python 3.10–3.12：本机系统 Python 是 3.14（不满足 Pipecat / LiveKit），
  已另装用户级 **Python 3.12.10** 并建好 `.venvs/voice-pipecat`、`.venvs/voice-livekit`、`.venvs/field-probe`；语音/视觉代码一律走这些 venv。
- 没有 `tsc --noEmit` 类型检查门；类型错误只会在运行时暴露。
- `tests/scenarios/` 有语料（`corpus.ts`，8 个场景，由 `eval-conversation.ts` 执行）但没有 `*.test.ts`；
  `tests/replay/` 仍为空（章节 §32/§22.3 的回放能力属 M5）。
- 现场测试控制台（`npm run field-test`）的 15 项控制台测试在 `tests/console/`，故意不在 `npm test` 的 glob 里
  （它们要起 HTTP 服务与 Python VAD）；用 `node --test "tests/console/**/*.test.ts"` 跑。
- 摄像头在场检测（M6）未接入时页面显示「未接入」（不是错误）；麦克风噪声底偏高（实测 −33 ~ −35 dBFS）仍是首要风险。
- WorldState、Memory、FutureHook、ProactiveEngine，以及唤醒词与模型驱动的人格学习均未开始，按 §45 顺序推进。
