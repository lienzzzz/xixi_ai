# 西西项目文档地图

> 最后更新：2026-09-30
> 面向：接手本项目的编码 Agent / 维护者
> 本文件告诉你「先读什么、什么最权威、改代码后必须更新哪些文档」。

## 1. 阅读顺序（第一次接手，约 40 分钟）

| 顺序 | 文件 | 读它的目的 | 预计 |
|---|---|---|---|
| 1 | [`../AGENTS.md`](../AGENTS.md) | 铁律、环境事实、密钥纪律、常用命令 | 5 min |
| 2 | [`handoff.md`](handoff.md) | **现在能跑什么、5 分钟怎么自证、哪些是坏的、有哪些坑** | 10 min |
| 3 | [`progress.md`](progress.md) | 当前状态 + 全部实测结论（§0 是结论表） | 10 min |
| 4 | [`architecture.md`](architecture.md) | 整体结构与数据流（两种大脑、语音链路、持久化） | 10 min |
| 5 | 按需读 [`design/`](design/README.md) | 领域模型 / 对话层 / 大脑与模型 / 语音 / 安全隐私 | 按需 |
| 6 | [`adr/`](adr/) | 为什么这样选（半年后不要推翻已验证的决策） | 按需 |
| 7 | [`recon/`](recon/) | 外部依赖的**原始实测报告**（DSH、MiMo、Pipecat、LiveKit、设备） | 按需 |
| 8 | [`../xixi_ai_companion_project_plan.md`](../xixi_ai_companion_project_plan.md) | 方案原文（57 节）。**注意：它是设计意图，不是现状** | 按需 |

## 2. 权威性排序（冲突时按这个判）

```text
1. 代码与测试          ← 唯一事实来源
2. docs/recon/*        ← 对外部系统（模型/框架/设备）的原始实测，带命令与数字
3. docs/progress.md    ← 项目状态与结论，人写，可能与代码滞后
4. docs/design/*       ← 设计说明，滞后风险更高
5. docs/adr/*          ← 决策记录，除非决策被明确推翻，否则仍然有效
6. xixi_ai_companion_project_plan.md  ← 方案意图，与现状不符的地方**以现状为准**
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
| `packages/brain-adapter/src/types.ts`（§25 接口） | `design/brain-and-models.md`、`architecture.md` |
| `packages/brain-adapter/src/tools.ts` 或新增工具 | `design/security-and-privacy.md`（工具权限）、`design/brain-and-models.md`、`config/xixi.example.yaml`（若需配置） |
| `packages/model-adapters/src/mimo.ts`（含 `chatJson` 策略） | `design/brain-and-models.md`、`recon/mimo-api-probe-2026-09-29.md`（若发现新缺陷） |
| `apps/brain-dsh/profile/cordis.patch.yml`（插件集/人格/system prompt） | `design/brain-and-models.md`、`architecture.md`、`design/security-and-privacy.md`（权限面） |
| `services/voice-edge/**` 或 VAD 参数 | `design/voice.md`、`recon/pipecat-spike-2026-09-29.md`、`recon/device-acceptance-2026-09-30.md` |
| 任何 `scripts/verify-*.ts` / `eval-*.ts` / `voice-*.ts` | [`testing.md`](testing.md) 的脚本表、`README.md` 的命令段、`AGENTS.md` §7 |
| 里程碑推进（做完 M2/M3/…） | `progress.md` §0/§1、`architecture.md` 的「未实现」列表、相关 `design/*` |
| 新增外部依赖 | 新 ADR + `AGENTS.md` 铁律 12 的引用 |
| 修改方案里的既定原则 | **不要做**；如有异议写新 ADR 说明 |

## 4. 文档新鲜度自检（可执行）

接手时/提交前跑这几条，能快速发现文档漂移：

```powershell
cd E:\worker2
npm test                                      # 测试数与 docs/testing.md、progress.md 是否一致
npm run check:docs                            # 链接、文件引用、新鲜度标记是否仍然成立
npm run install:profile                       # profile 自检（会打印 bundles 与校验结果）
node scripts/show-turns.ts data/chat/xixi.sqlite 3   # 事件日志仍可读、字段仍在
# 交叉检查：文档里提到的脚本是否真的存在
foreach ($f in @('scripts/verify-m0.ts','scripts/verify-provider-route.ts','scripts/verify-structured-output.ts',
                 'scripts/eval-conversation.ts','scripts/voice-turn.ts','scripts/voice-bargein.ts',
                 'scripts/voice-device-check.ts','scripts/serve-chat.ts','scripts/chat.ts','scripts/show-turns.ts',
                 'scripts/make-audio-fixtures.ts','scripts/check-docs.ts')) { if (Test-Path $f) { "OK  $f" } else { "缺失 $f" } }
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
