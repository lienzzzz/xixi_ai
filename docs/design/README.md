# 设计文档索引与维护规则

> 最后更新：2026-09-30
> 权威来源：本文的规则本身由 `docs/README.md`（文档地图与权威性排序）与 `AGENTS.md`（铁律、语言与命名）约束；每份设计文档的权威源见表 2
> 若与代码不一致，以代码为准，并请立即修正本文件

设计文档回答「**为什么这样设计、边界在哪**」，不替代代码。所有事实性结论都必须能指到源文件。

## 1. 文档地图

| 文档 | 回答什么问题 | 什么时候读 |
|---|---|---|
| [`../architecture.md`](../architecture.md) | 整体结构、两种大脑、文本/语音数据流、进程与端口、未实现清单 | 第一次接手；改任何跨包行为之前 |
| [`domain-model.md`](domain-model.md) | 事件信封与三类事件、schema 版本策略、SQLite 表结构、迁移机制、人格属性集合 | 改契约、迁移、人格属性或会话映射之前 |
| [`conversation.md`](conversation.md) | FSM 状态与判定、§26 提示词组装、人格→指令映射、§55 沉默、一轮时序 | 改对话层、提示词或沉默语义之前 |
| [`brain-and-models.md`](brain-and-models.md) | `BrainAdapter` 全部方法的状态、两种实现的对比、流式与工具循环、`chatJson` 策略、错误码 | 改适配器、工具、模型调用或降级策略之前 |
| [`voice.md`](voice.md) | VAD 基线、抗噪前端与成功边界、两条输入路径、打断与延迟实测 | 改语音链路或 VAD 参数之前 |
| [`perception.md`](perception.md) | 摄像头在场检测（M6）：抓帧、帧差动 + YuNet、`presence.changed`、WorldState 投影、隐私边界 | 改在场检测、摄像头或 WorldState 投影之前 |

**尚不存在的设计文档**（`docs/README.md` §3 提到但仓库里没有）：`design/security-and-privacy.md`
（`design/voice.md` 里有一处链到它，目前是断链）。工具权限、隐私分层、密钥纪律这些内容当前分散在
[`../architecture.md`](../architecture.md) §4/§6、[`../../AGENTS.md`](../../AGENTS.md) §5 与
[`../adr/`](../adr/) 里。接手者若要补写，请从代码出发，不要照抄方案原文。

## 2. 每份文档的权威源

改动下列源文件时，对应文档**必须**同步；反过来，文档里的每一句结论都应能在这些源文件里找到。

| 文档 | 权威源（代码优先） | 数字/结论的外部出处 |
|---|---|---|
| `architecture.md` | `packages/*/src/**`、`apps/brain-dsh/src/**`、`services/voice-edge/voice_edge/**`、`scripts/serve-chat.ts`、`scripts/chat.ts`、`scripts/voice-*.ts` | `docs/progress.md` §0、`docs/adr/0008`（延迟与 token）、`docs/adr/0007`（VAD 与打断） |
| `domain-model.md` | `packages/contracts/src/{envelope,events,ids,schema-validator}.ts`、`packages/contracts/schemas/**`、`packages/domain/src/{store,migrations,personality,config,clock}.ts`、`packages/domain/src/migrations/001_initial.sql` | [`../event-contracts.md`](../event-contracts.md)、`tests/unit/{contracts,domain}.test.ts` |
| `conversation.md` | `packages/conversation/src/{fsm,prompt,engine}.ts`、`packages/brain-adapter/src/{types,mimo,dsh,tools}.ts` | `tests/unit/{conversation-fsm,prompt}.test.ts`、`tests/integration/conversation-engine.test.ts`、`docs/recon/conversation-eval-2026-09-30.md` |
| `brain-and-models.md` | `packages/brain-adapter/src/**`、`packages/model-adapters/src/**`、`apps/brain-dsh/src/transport.ts`、`apps/brain-dsh/profile/cordis.patch.yml`、`plugins/xixi-tools/index.js` | `docs/recon/mimo-api-probe-2026-09-29.md`、`docs/recon/dsh-integration-2026-09-29.md`、`docs/progress.md` §2.10/§2.11 |
| `voice.md` | `services/voice-edge/voice_edge/*.py`、`scripts/voice-*.ts`、`scripts/serve-chat.ts` | `docs/recon/{pipecat,livekit}-spike-2026-09-29.md`、`docs/recon/device-acceptance-2026-09-30.md`、`docs/adr/0007` |

外部依赖（模型端点、VAD 框架、设备）的**原始实测**永远记录在 [`../recon/`](../recon/)，设计文档只引用结论并给出链接。

## 3. 文档维护规则

以下规则对 `docs/design/**` 下所有文件（含本文件）生效。

1. **开头三行固定格式**：`> 最后更新：YYYY-MM-DD`、`> 权威来源：<源文件与文档>`、
   `> 若与代码不一致，以代码为准，并请立即修正本文件`。
2. **结尾必须有 `## 维护规则` 小节**：写明「改动哪些源文件 → 必须更新本文件的哪些小节」的映射表。
3. **行内代码标注来源**：每条关键结论后面用 `` `path/to/file.ts` `` 标注出处；标不出来的就不要写。
4. **区分「设计意图」与「当前实现」**：方案 `xixi_ai_companion_project_plan.md` 里有、代码里没有的，
   一律写成「未实现（属 Mx）」，并在表里给出**现状证据**（哪个函数抛 `NOT_IMPLEMENTED`、哪个 feature 开关是 `false`）。
5. **不写未验证的东西**；必须提及时显式标注「未验证」，并说明缺什么才能验证。
6. **数字必须带出处与条件**：例如「192ms」要写成「离线夹具、`npm run voice:bargein`、判定层面」，
   而不是「很快」。
7. **行数上限 250 行**：超了说明该拆文件，而不是继续追加。
8. **不粘贴大段代码**：只引用几行以内的关键片段；其余指路径。
9. **中文书写**，代码标识符、路径、字段名保持原样（`identity.timezone`、`turn_index`、`brain_provider`）。
10. **交叉链接用相对路径**：从 `docs/design/` 出发写 `../architecture.md`、`domain-model.md`。
11. **密钥、令牌、个人数据永不写进文档**（`AGENTS.md` §5）。
12. **改完代码先改文档，再写 `progress.md`**：文档的时效标记（`最后更新`）必须与本次改动同一天。
13. **引用代码位置用「文件名 + 函数名/测试名 + 一条可复现的 `git grep`」，不要写行号**。
    行号随任何一次编辑失效——t34 实测某文档钉了 15 处行号，**数小时内 13 处已漂移**，多数指向错误的代码。
    正确写法例：`` `packages/conversation/src/proactive.ts` 的 `evaluateProactiveGates`（核对：`git grep -n "export function evaluateProactiveGates" -- packages`） ``。
    **例外**：`docs/recon/**` 与 `docs/verification/**` 是**某一时点的快照式证据**，可以保留行号（它们记录的是「当时看到的那一行」），不受本条约束。
    （本机 `grep` 不在 PATH 上，但 Git 自带：`git grep` 直接用；需要普通 grep 时用 `D:\Git\usr\bin\grep.exe`，见 `AGENTS.md` §4。）

## 维护规则

| 改动 | 必须同步 |
|---|---|
| `packages/contracts/**`、`packages/domain/src/migrations/*.sql`、`personality.ts`、`store.ts` | [`domain-model.md`](domain-model.md) 对应小节 + [`../event-contracts.md`](../event-contracts.md) |
| `packages/conversation/**`、`packages/brain-adapter/src/{types,tools}.ts` | [`conversation.md`](conversation.md) 对应小节 + [`../architecture.md`](../architecture.md) §2/§3 |
| `packages/brain-adapter/**`、`packages/model-adapters/**`、`apps/brain-dsh/**`、`plugins/xixi-tools/**` | [`brain-and-models.md`](brain-and-models.md) 对应小节 |
| 新增/替换 `BrainAdapter` 实现、改进程或端口、里程碑推进 | [`../architecture.md`](../architecture.md) §2/§6/§7 |
| `services/voice-edge/**`、`scripts/voice-*.ts`、VAD 参数 | [`voice.md`](voice.md) + [`../architecture.md`](../architecture.md) §4 + [ADR-0007](../adr/0007-voice-stack-pipecat.md) |
| `docs/README.md` 的权威性排序或更新触发条件变化 | 本文件的表 2 与 §3 |
| 新增设计文档 | 本文件 §1 的表 + 该文档自己的 `## 维护规则` |
