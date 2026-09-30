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

npm test                                      # 全部离线测试，不花 API 费用
npm run demo:m0:text                          # 离线单轮演示（FakeBrainAdapter）
npm run demo:m0:restart                       # 离线两进程重启演示
npm run verify:provider                       # 一次真实调用：验证 MiMo 路由与工具调用
npm run verify:m0                             # M0 验收：真实两进程重启恢复
```

需要外网时可能要走代理：`$env:HTTPS_PROXY='http://127.0.0.1:7890'`、`$env:NODE_USE_ENV_PROXY='1'`。

## 仓库结构（当前实际存在）

```text
packages/contracts/       事件信封与 payload schema（xixi.event.v1），所有服务共用
packages/domain/          唯一写 SQLite 的包：事件日志、会话、人格基线、迁移执行器
packages/brain-adapter/   BrainAdapter 接口 + FakeBrainAdapter + DSH 适配器 + 离线脚本化 transport
apps/brain-dsh/           DSH 侧接线：profile patch（MiMo 路由）与 CLI transport
plugins/xixi-tools/       西西最小工具集（M0 只有 xixi_get_current_time）
config/                   xixi.example.yaml（方案 §42）
scripts/                  安装、验收与演示脚本
tests/                    unit / integration / scenarios / replay（后两者尚未填充）
docs/                     architecture.md、event-contracts.md、testing.md、progress.md、adr/、recon/
```

## 设计要点（M0 已落地）

- **Harness 隔离**：只有 `packages/brain-adapter` 与 `apps/brain-dsh` 知道 DSH 存在；其余代码只看到领域词汇。
- **事件日志是唯一事实来源**：对话轮次就是 `conversation.turn` 事件，不另建表，避免同一事实两份真相。
- **持久人格是「恢复」不是「重置」**：每次启动只补缺失的属性，已有值永不覆盖。
- **Harness 会话映射在领域层**：`conversation_sessions.brain_provider` + `brain_session_id`，换掉 DSH 也不丢同一段西西。
- **默认关闭深度思考**：MiMo 服务端默认开启思考，路由用 `reasoning: off` + `reasoningEfforts` 明确关闭（方案 §46.1）。

## 明确的未完成项

- M1 之前必须先装 Python 3.10–3.12（本机只有 3.14），Pipecat / LiveKit 路线才可用。
- 没有 `tsc --noEmit` 类型检查门；类型错误只会在运行时暴露。
- `tests/scenarios/`、`tests/replay/` 尚为空（章节 §32/§22.3 的回放能力属 M5）。
- WorldState、Memory、FutureHook、ProactiveEngine、Conversation FSM、语音与摄像头均未开始，按 §45 顺序推进。
