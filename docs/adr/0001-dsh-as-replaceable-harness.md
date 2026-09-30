# ADR-0001：把 DSH 当作可替换的 Harness

- 状态：已接受（2026-09-29，M0 验收通过后）
- 相关：`docs/architecture.md`、ADR-0005、ADR-0006、`docs/recon/dsh-integration-2026-09-29.md`
- 上游依据：《方案》§3.2、§25、§44、§M0；`AGENTS.md` 铁律 9

## Context

M0 要回答的唯一问题是「文字 → Harness → 模型 → 结构化工具调用 → 回答，且重启后会话恢复」。
候选 Harness 里 DSH（`@deepseek-ai/dsh`）是唯一在本机已经装好、已挂载 `@deepseek-ai/dsh-llm-pi-ai`
（OpenAI 兼容路由 + 工具注册 + 会话持久化 + CLI 一次性运行）的实现。但项目的前提是：

- 可替换的是模型 / ASR / TTS / 摄像头 / **Harness**；不可替换的是长期状态与行为策略（[README.md](../../README.md)）。
- 这台机器偶发蓝屏，环境必须能在不污染全局的情况下整体删除并重建（`AGENTS.md` 第 3 节）。
- DSH 当时是 **0.1.7-rc.2（RC，属 Developer Preview）**，API 可能变动。

同时存在两个更硬的约束：模型只做理解与判断，规则与状态由程序负责（铁律 1）；
DSH 或任何 Harness 的 API **不得**出现在 `packages/brain-adapter` 之外（铁律 9）。

## Decision

1. **固定版本**：DSH 固定为 `@deepseek-ai/dsh` **0.1.7-rc.2**。升级前必须先跑 `npm test` 与
   `npm run verify:provider` / `npm run verify:m0`（`docs/progress.md` 第 6 节「DSH 是 RC」）。
2. **项目内 DSH_HOME**：Harness 的家目录固定在 `<repo>/.dsh`，由
   [`scripts/install-dsh-profile.ts`](../../scripts/install-dsh-profile.ts) 创建并维护 profile `xixi`
   （模板 `headless` + bundles `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-headless` / `dsh-xixi-tool`）。
   路径常量在 [`scripts/lib/harness.ts`](../../scripts/lib/harness.ts)：`DSH_HOME`、`DSH_PROFILE = 'xixi'`。
   因此 profile、会话日志（`.dsh/sessions/`）与凭据解析都在仓库内，可整体删除、可复现，不碰用户全局 `~/.dsh`。
3. **API 收敛在两个目录**：只有 `packages/brain-adapter` 与 `apps/brain-dsh`（及其 profile patch）
   知道 DSH 存在。其余代码只见领域词汇：`BrainAdapter`、`UserTurnInput`、`BrainTurnResult`、
   `TurnAction`（[`packages/brain-adapter/src/types.ts`](../../packages/brain-adapter/src/types.ts)）。
   scripts 只负责接线与验收，不承载产品逻辑。
4. **换 Harness 的具体路径（seam 必须保持可用）**：
   - 实现一个新的 `DshTransport` 等价物（如 `LettaTransport`）或直接实现 `BrainAdapter`，
     例如将来的 `LettaBrainAdapter` / `CustomBrainAdapter`（《方案》§25 的列表）。
   - 领域层不动：`conversation_sessions.brain_provider` 换一个值即可，同一段西西会话继续有效（ADR-0005）。
   - 契约层不动：事件仍是 `xixi.event.v1`（ADR-0003 / ADR-0004）。
   - 验收不动：`scripts/verify-m0.ts` 的断言是「同一西西会话 + 同一 harness 会话 + 人格一致」，
     换成别的 Harness 后这些断言应原样通过。

## Alternatives

| 方案 | 为什么没选 |
|---|---|
| 直接把 DSH 当库在进程内 `import`，用其内部 Agent/Session API | 与 RC 版内部 API 强耦合，升级即碎；也违反铁律 9（DSH API 会渗进 brain 之外的代码） |
| 自研 agent loop（自己管工具循环、会话、重试） | M0 的成本会从「接线」变成「造 Harness」，且方案 §3.2 已选 DSH；一旦自研就同时失去这条 seam 的对照物 |
| 一开始就写 Letta / OpenAfon 适配器 | 属于「一次实现多个里程碑」（铁律 11）；M0 只需证明 seam 存在且被真实穿过 |
| 把 DSH 装在全局 `~/.dsh`，用 `--patch` 临时挂 MiMo 路由 | 环境不可复现、不可整体清理，且会把西西的 profile 与用户自己的 profile 混在一起 |
| 用 `--profile web` 跑（它已挂 pi-ai） | 已实测：`web` profile 只有 server 参数，**不能**跑 headless 单轮（`docs/recon/dsh-integration-2026-09-29.md` §「Blockers」第 2 条） |

## Consequences

**正向**

- 换 Harness 的爆炸半径被限定为「新增一个 transport/adapter + 换 `brain_provider` 取值」；
  `packages/contracts`、`packages/domain`、事件日志、人格基线与所有离线测试都不受影响。
- 环境自包含：删掉 `.dsh/` 与 `data/` 就是干净状态，崩溃后照 `docs/progress.md` 第 7 节命令重建。
- 同一套 seam 允许离线替身存在：`FakeBrainAdapter`（无网络）与 `ScriptedDshTransport`（离线脚本化），
  使 `npm test` 完全不需要模型（见 `docs/testing.md`）。

**代价与约束（必须承认）**

- DSH 是 RC：固定版本意味着不能随手升级，升级前要跑两个真实 API 验收脚本。
- M0 的 transport 是**每轮一个 `dsh` 进程**（`CliDshTransport`，见 [`apps/brain-dsh/src/transport.ts`](../../apps/brain-dsh/src/transport.ts)）：
  整轮 4–6s，其中相当部分是 profile 启动。这一取舍让「重启恢复」成为默认行为而非特例，
  但**对 M1 实时语音不可接受**，M1 必须改常驻宿主进程。
- 会话恢复依赖 DSH 的两个约束：**相同 cwd** 与**相同 profile 组合**（已实测，见
  `docs/recon/dsh-integration-2026-09-29.md` §3）。`CliDshTransport` 把两者固定为 `cwd = REPO_ROOT` 与 `profile = xixi`。
- 会话数据落在 DSH 自己的格式里（当前磁盘代次 `session.v4.jsonl.zstd`），
  这不是西西的事实来源——事实来源是 `events` 表；DSH 会话只是可重新建立的「上下文缓存」。

## 复现证据

```powershell
node scripts/install-dsh-profile.ts   # 建 .dsh/，幂等
npm test                              # 36 项离线测试全绿（不需要模型）
npm run verify:provider               # 一次真实调用：路由 + 工具调用
npm run verify:m0                     # 两个独立进程：重启 → 会话恢复
```
