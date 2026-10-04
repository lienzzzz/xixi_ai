# 西西 V0.3 阶段进度（progress-v03）

最后更新：2026-10-04

这份文件是 V0.3 pack（`E:\xixi_v03_actual_code_pack\docs\08_PHASES_AND_ACCEPTANCE.md`）要求的
**每阶段进度**：每个 Phase 收尾时由**独立复验任务**在这里追加一节，只写「交付了什么、凭什么说它是真的、
没做什么、欠什么」。它与 [`progress.md`](progress.md) 分工不同：那份是按下标时间倒序的流水，
本文**按 Phase 索引**，只放可复验的结论与遗留。

**写法约定**（与 pack 的 gate 要求一一对应）：

1. 每条结论给「**能重跑的命令 + 本次实测输出**」——命令优先于产物；引用产物必须写明它落在哪个修订号上。
2. 只写代码里真实存在的东西；「设计意图」与「当前实现」分开写。
3. 不引用别人的转述：这一节的每个数字都由写它的人自己跑出来（实现者与评审的回报只当线索）。

---

### 0. 总表（P0 + P1 + P2）

> 本文件按 Phase 索引：P0 → P1 → P2，越靠后越新。**P2 段的逐项交付表、gate 实测、未达标项与遗留在本文件末**，
> 下面这七行只是索引（同一批交付号，细节见 P2 段与四份 ADR）。

| Phase / 项 | 交付（交付号） | 关键实测（口径与命令见本节对应的 P0 / P1 / P2 段） | 遗留 |
|---|---|---|---|
| P0-0 运行时地图 | `docs/v03/ACTUAL_RUNTIME_MAP.md`（`3da7893`） | 十个概念各一条 `git grep`；复核 pack 审计 15 条并给出 4 处与代码不符；`check:docs` 98 份 exit 0 | 地图的 §1/§3 行曾落后于抽取（t16 已按实况更新） |
| P0-A 运行时抽取 | `packages/runtime/*`（Step A `dbe7f7f`、Step B/C `f577d7b`） | 反向 import `packages`→`scripts` 0 命中；四个入口 `--print-wiring` 除 `entry` 名外只有 1 种 payload；`npm test` 全绿 | 兼容 re-export 仍在 `scripts/field-test.ts`，**不得提前删** |
| P0-B canonical store | `packages/domain/src/store.ts` + `packages/runtime/src/perception-ingest.ts`（`4827498`；t17 修 F1–F3 `13ded0e`） | 同一个库文件里同时有 `source=chat` 与 `source=field-test` 的 `system.health`；旧库 `data/xixi.sqlite` 时间戳未变 | 无（页面 `note` 的反例已由 t17 修掉） |
| P0-C typecheck | `tsconfig.base.json` + `tsconfig.json` + `npm run check:types`（`b6e8dae`） | `check:types` exit 0；`@ts-ignore`/`@ts-expect-error`/`as any` 全库 0 命中（不是靠抑制换绿） | 无 |
| P0-D replay | `packages/runtime/src/replay-runtime.ts` + `tests/replay/*`（`c9d1ad1`） | 三条行为基线（对话 / 在场 / 跨天未完话题）；跨年（相隔 364 天）同脚本行为摘要相同；`test:replay` 16/16 | pack 的 `sensor.observation` / 音频与图像夹具按 §4 留到 V0.3 之后 |
| P0-E 已知缺陷 | B2（`4f3301f`）+ preflight 九项（`e0ce503`） | B2 先写回归测试再修（旧实现下先红）；九项各有一条会红的证据 | 已由 t3/t2 逐项回归；剩两条 low 见 P0 遗留第 5 条（现已补） |
| P1-a 上下文与检索 | `packages/context/*` + engine/prompt 接线（`d168af7`） | 检索进 `prompt.user`（`- [较确定] 我很喜欢茉莉花茶`）；prompt 审计无 UUID / 内部 id / 长数字 / 调试字段 | 曾不过 → t22 修复 / t23 复审 pass（见 P1 §3） |
| P1-b 关系/话题/纠正/afterTurn | 迁移 006 + `MemoryStore` 状态 API + `MemoryCorrectionResolver` + `createTurnExtraction`（`7331ae`→`733b1ae`） | 纠正后旧行 `superseded`（带 `supersededBy`）、新行 `active`、旧事实不进 prompt；三入口各有真子进程/真 HTTP 证据 | 疑问句被写成偏好事实（P1 遗留 N3，t22 修复 / t23 复审） |
| P2-A 插件内核 | `packages/plugins/src/*` + `packages/runtime` 的 `buildPluginRuntime`（`060f1fb` + 修复轮 `9f226b6`） | 九步生命周期 + 五能力 + 四条「插件不能做」各有强制点；`ToolRegistry` 升级不推翻；`node --test` 的 plugins 套件全绿（见 P2 §2 的 131 项细分） | **入口未接线**（P2 §5 四条之一）；`start()` 不幂等、health 快照过期 |
| P2-C MCP adapter | `packages/plugins/mcp/*`（`c8396e0` + 修复轮 `d407eac`） | SDK v2 真 client+server 走 `InMemoryTransport`；命名空间 `mcp.weather.forecast`；空转零调用（不做高频总线） | 没有对外部/远程服务器的验证；入口没配任何服务器（P2 §4.3） |
| P2-B 工具审批 | 迁移 007 + `packages/domain/src/approvals.ts` + `packages/runtime/src/tool-approval.ts`（`d64066b` + 修复轮 `f57282d`、`8dfc0bd`） | 冻结参数摘要对不上就 `APPROVAL_MISMATCH` 且零调用；拒绝/到期都不执行且都落审计 | 入口没接 `approvalGate`；manifest 的 tool 级 approval 未实现（P2 §5） |
| P2-F 接口收缩 | `packages/brain-adapter/src/types.ts` 三接口 + manifest 补 `@xixi/model-adapters`（`19b54b9` + `f2f3af1`） | 四能力从接口与实现一并退役；`packages/brain-adapter` 里 `@deepseek-ai/dsh` 零命中 | 两条接缝（`supportsImages` / `inferJson`）在生产侧**没有消费者** |
| P2-D 真实 News | `packages/plugins/news/**`（`3ada7cd`） | 三个工具 + `news.topics`；真实 RSS 与公开 JSON API 手动复验（事件日志 `tool_name="news.latest"`）；默认门禁用离线桩 | 入口未接线（P2 §4.1）；真实来源属手动证据 |
| P2-E durable Reminder | 迁移 008 + `packages/domain/src/reminders.ts` + `packages/runtime/src/reminder-runtime.ts`（`3bd7d3e` + `5336b13`） | 自然语言解析成绝对时刻 + 时区（跨日/跨时区边界有用例）；新进程读得到 `pending`，到点 `pending→due→candidate` 三条事件 | 入口未接 durable sink/scheduler（P2 §4.2）；模型只有 27% 会真的调这个工具（P2 §4.2） |
| P2-G 上一轮遗留 | `packages/conversation/src/extractor.ts` 的 `lacksObject`（`d573437`） | 「铁观音我平时喜欢」三句从 3 条截断记忆变 0 条、正常句照旧 | 词表之外的宾语前置句仍照写 |


> 交付号取自 `git log`；**成员只报基线、不提交代码**，交付号由 captain 提交后回填（AGENTS §9.20）。
> **表里的「项数 / 耗时」是当次实测（口径＝`npm test` 的 `ℹ tests / pass / fail` 与 `duration_ms`），会随用例增加而变**——
> 判「现在是不是绿的」请自己跑一次，别引用这张表里的数字当现状。

## P0 — Consolidation（已完成，独立复验通过）

**复验基线**：`273e3b6`（复验任务认领时的 HEAD）。复验期间 captain 又提交了 `f13e772`（只改 `AGENTS.md`，6 行），
与下面的门禁结论无关。**复验不改任何代码**，本节的产品都在工作区/已入库的提交里。

### 1. 交付了什么

| 项 | 交付物（定义处） | 一句话说明 |
|---|---|---|
| P0-0 运行时地图 | `docs/v03/ACTUAL_RUNTIME_MAP.md` | 按 pack 十个概念逐个 `git grep` 核对的「今天在哪、被谁调、下一步搬到哪」 |
| P0-A 运行时抽取 | `packages/runtime/src/tool-runtime.ts`、`packages/runtime/src/proactive-runtime.ts`、`packages/runtime/src/voice-runtime.ts`、`packages/runtime/src/errors.ts`、`packages/runtime/src/repo.ts`、`packages/runtime/src/wav.ts`、`packages/runtime/src/index.ts`、`packages/runtime/package.json` | Step A/B/C 把 `scripts/field-test.ts` 的共享运行时搬进包；**兼容 re-export 仍在 `scripts/field-test.ts`，不得提前删** |
| P0-B 统一库 | `packages/domain/src/store.ts`（`CANONICAL_DATA_DIR`、`CANONICAL_DATA_DIR_ENV`、`resolveCanonicalDataDir`、`CANONICAL_STORE_ENTRIES`）、`packages/runtime/src/perception-ingest.ts` | household 入口默认同一个库（`data/xixi`）；感知事件由 Node 侧单写者与 `world_state` 投影同事务落库 |
| P0-C 类型门禁 | `tsconfig.base.json`、`tsconfig.json`、`package.json`（`check:types`） | `tsc --noEmit`，无构建步骤；typescript 与 @types/node 精确钉版 |
| P0-D Replay | `packages/runtime/src/replay-runtime.ts`、`tests/replay/replay-fixtures.ts`、`tests/replay/replay-format.test.ts`、`tests/replay/replay-conversation.test.ts`、`tests/replay/replay-presence.test.ts`、`tests/replay/replay-open-thread.test.ts`、`tests/replay/fixtures/` 下 4 份夹具 | 相对时间的 JSON 脚本 + 注入 Clock；对话 / 在场 / 跨天未完话题三条行为基线 |
| P0-E 已知缺陷 | B2：`services/voice-edge/voice_edge/voice_stream.ts` 与 `tests/unit/voice/voice-stream.test.ts`（先写测试、后修）；preflight 九项散落在 `packages/conversation/src/`、`packages/domain/src/`、`scripts/` | 九项各自带一条会红的证据（清单见各任务的完成回报与 [`progress.md`](progress.md)） |

### 2. Gate 实测

pack 的 P0 gate 是四条：Node 24、`check:types` 绿、`npm test` 绿、既有 realism 与 proactive eval 不回退。
下面是**本次复验自己跑出来**的输出（同一台机器：Intel i7-7700HQ / 8 逻辑核 / Windows 10.0.19045）。

#### ① Node 24

```powershell
node --version
```

实测：`v24.21.0`；`package.json` 的 `engines.node` = `>=24.0.0`。Node 原生跑 `.ts`（类型擦除），无构建步骤。

#### ② `check:types` 绿

```powershell
npm run check:types
```

实测：**exit 0**（无输出即无错）。两条「不是靠抑制换绿」的自查（本次复验重跑）：

```powershell
& 'D:\Git\usr\bin\grep.exe' -rn "@ts-ignore|@ts-expect-error|@ts-nocheck" packages scripts services tests apps --include=*.ts
& 'D:\Git\usr\bin\grep.exe' -rn "\bas any\b|: any\b" packages scripts services tests apps --include=*.ts
```

实测：第一条 **0 命中**；第二条只有两处**英文注释里的单词 any**（`packages/contracts/src/schema-validator.ts`、`packages/conversation/src/segments.ts`），没有一处类型抑制。

#### ③ `npm test` 绿

```powershell
npm test
```

实测（2026-10-04，基线 `273e3b6`；与时间线命令并发运行，见 ⑤ 的说明）：

```text
ℹ tests 520
ℹ pass 520
ℹ fail 0
ℹ duration_ms 32929.9213
exit 0（进程外墙钟 33.5 s）
```

「项数变多」来自新增用例，不是改了门禁口径——`test` script 与 P0 基线逐字相同，可复算：

```powershell
node -e "const fs=require('fs'),{execFileSync}=require('child_process');const now=JSON.parse(fs.readFileSync('package.json','utf8')).scripts.test;const old=JSON.parse(execFileSync('git',['show','d3a8916:package.json'],{encoding:'utf8'})).scripts.test;console.log('test script identical to baseline:',now===old)"
```

实测：`true`（`scripts` 段只多了 `check:types`；6 个 glob 一字未改）。
其中 `tests/replay` 单独跑也是绿的（`npm run test:replay` → 16 项 pass 16 fail 0 exit 0）。
另外，`node scripts/eval-realism.ts --fake` 的输出里印着「修订号 `f13e772`｜生产代码与修订号一致」——
即这次复验跑门禁时工作区**没有未提交的生产代码改动**（唯一的改动是新增本文档），所以上面的数字不属于「脏快照」。

#### ④ 既有 realism 不回退

口径与产物（**不新造真调用**）：复算 pack P1 快照那次运行的**同一份原始记录**，报告在
[`benchmarks/realism-2026-10-01-v02-wip.md`](benchmarks/realism-2026-10-01-v02-wip.md)，
机器可读记录是 `docs/benchmarks/realism-2026-10-01-v02-wip.json`（修订号 `995ed42`＋当时 5 项未提交改动的快照）。

```powershell
node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-10-01-v02-wip.json
node scripts/eval-realism.ts --replay docs/benchmarks/realism-2026-10-01-v01-vanilla.json
```

实测（两次都 **exit 0**，只复算、不写文件）：

| 指标（口径见 [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md) §2） | V0.1 记录（`882f745`）复算 | V0.2 记录（`995ed42`+5）复算 | 与记录的对照 |
|---|---:|---:|---|
| 提问率（主口径＝末句问号收尾） | 45.8%（33/72） | **46%（29/63）** | 与两份报告逐字一致 |
| 提问率（辅口径＝含问号，仅参考） | 69.4%（50/72） | 57.1%（36/63） | 一致 |
| 禁用模板出现率 | 0% | **0%** | 一致 |
| 回复字数 P50 / 最大 | 47.5 / 422 | 33 / 424 | 一致 |
| 交付分段（每轮均值 / 单段最长） | 1.4 / 341 | 1.5 / 170 | 一致 |
| 最长同结构连续轮 | 7 | 3 | 一致 |

**这条证据的边界（必须写清）**：`--replay` 只复算**已捕获的转录**，它证明「指标实现 + 分段器在今天的修订号上仍复现 V0.2 的记录」，
**不**证明「今天重跑一次真调用会得到同样的对话」，而且**复算路径根本不评估黄金门禁**（`scripts/eval-realism.ts` 的 replay 分支在打印指标后就返回）——
所以不能用它的 exit 0 去宣称「黄金期望全过」。两件能自己验的事分开说：

- **确定性那部分（不花钱，本次复验实跑）**：主动门禁的黄金用例由真实入口跑：

  ```powershell
  node scripts/eval-realism.ts --fake --out "$env:TEMP\t11-realism-fake"
  ```

  实测 **exit 0**，逐条打印 `G07 G07-specific-topic：期望 PASSED，实际 PASSED`、
  `G12 G12-cooldown-graded：期望 BELOW_RECOMMENDATION，实际 BELOW_RECOMMENDATION`、
  `G12 G12-cooldown-does-not-veto：期望 PASSED，实际 PASSED`、
  `G12 G12-topic-repeated-graded：期望 BELOW_RECOMMENDATION，实际 BELOW_RECOMMENDATION`、
  `G12 G12-no-topic-source：期望 TRIGGER_DISABLED，实际 TRIGGER_DISABLED` → **5/5 通过**。
  （`--fake` 按设计**跳过**对话轮的措辞判定，这部分不是「通过」而是「未测」。）
- **需要真调用的那部分（P1 的活）**：`node scripts/eval-realism.ts --corpus=all --repeat=3 --label v02`
  才会把 12 条黄金对话的措辞期望跑在真模型上，并产出权威 after 数字（[`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md) §7）。
  P0 给的是「记录可复算、口径未漂移、确定性门禁 5/5」，**不**声称「真人感不回退」——那要等 P1 的重跑。

#### ⑤ 既有 proactive eval 不回退（多日时间线）

```powershell
node scripts/eval-proactive-timeline.ts
```

**窗口要求**：这条命令实测 **约 24 分钟、单核打满**（不是挂死，也不是在等 I/O），
预算给 **≥40 分钟**；**不要中断它**（两档：安静机器约 24 分钟——三次实测 1429.5 / 1423.1 / 1425.6 秒；同期有人跑测试约 34 分钟——t16 收口时 2047.5 秒，单核打满、不是挂死）。
脚本默认多日 tick＝300 s × 3 个自然日 × 4 个场景，每场景判定约 1500 次；
P0-A 的抽取是同一文件搬家 + 别名，字段与代码逐字未改，不构成变慢机制。
建议放在其它门禁**之后**跑（它要占满一个核约 24 分钟）；本次复验把它放在**最前面**后台跑，
与 `npm test`（33.5 s）有一段重叠——实测耗时没有因此跑偏（见下）。

**本次复验实测**（2026-10-04，基线 `273e3b6`）：

```text
EXITCODE=0
ELAPSED_SEC=1425.6（≈23 分 46 秒；STARTED=2026-10-04T05:29:21）
```

「不是挂死」的现场证据：等待期间对进程采样，**10 秒里烧掉 9.5 CPU 秒**（≈0.95 核，单核打满），
日志按场景增量输出（`multi-responsive` 判定 1573 次、`multi-unanswered` 1588 次、`multi-unanswered-nopenalty` 1500 次）。
评审两轮的同一命令是 `1429.5 s` 与 `1423.1 s`（转引，仅作量级对照）——三次落在 1 分钟内，说明这是它的真实耗时。

**逐项与既有产物对照**（「既有 proactive eval 不回退」的对照数字）。
对照组是 P0-A Step B/C 那次完整运行留下的产物 `data/verification/t7/t7-timeline-impl.txt`
（该文件在 gitignore 的 `data/` 下，**换机器即失**；真正的第一引用是上面那条命令，产物只作附件）：

| 判定 | 对照产物（P0-A Step B/C） | 本次复验（`273e3b6`） | 是否一致 |
|---|---|---|---|
| 单日 1：主动次数 6~12 | 11 次 | 11 次 | ✅ |
| 单日 2：generic topic ≤ 20% | 引擎 18.2% / 内容 18.2% | 18.2% / 18.2% | ✅ |
| 单日 3：时间钩子 + 话题池 ≥ 60% | 81.8% | 81.8% | ✅ |
| 单日 4：连续未回应后降频 ≥ 50% | 11 vs 5（54.5%）；梯度 0→0.45→0.675→0.9 | 同 | ✅ |
| 单日 5：热聊不受 18 分钟冷却 | 接话 8 次；最小间隔 4 分钟 | 同 | ✅ |
| 单日 6：F4 问询额度与开口额度分开计 | 三个对照场景逐条相同 | 同 | ✅ |
| M1 多日基线每天 ≥6 | 8/8/11（共 28） | 8/8/11（共 28） | ✅ |
| M2 没人回应也不硬停 | 6/8/8 | 6/8/8 | ✅ |
| M3 跨天追问仍在 | 8/8/11；追问 10 次（2 次在第 2 天之后） | 8/8/11；追问 **10 次（2 次在第 2 天之后）** | ✅（thread id 是 UUID 派生的，两次不同：`thread_0hgm28d` / `thread_1o1kksq`） |
| M4 惩罚造成的降频（反事实对照） | 23 vs 27；**独自**改判 766 vs 0 | 23 vs 27；766 vs 0 | ✅ |
| M5 不变成骚扰 | 0 个单日超 12；间隔 5/5/5 分钟；100% 在清醒时段 | 同 | ✅ |
| M6 接受率 | 75% / 0% / 67.9% | 75% / 0% / 67.9% | ✅ |

结论行原文：**「单日五项目标 + F4 分离探针 + 多日 6 项全部通过」**（口径见
[`adr/0011-proactive-decision-ownership.md`](adr/0011-proactive-decision-ownership.md)：连续未回应后取「显著降频」，不是硬停）。
逐次运行的日志大小也与对照产物相同（都是 23082 字节的 UTF-16LE），差异只在 UUID 派生的 id。

### 3. 「四个入口同一个库」的硬证据

pack P0-B 的声明是「household 入口默认连同一个 canonical store」。判定**只认硬证据**：
**同一个库文件里同时出现 `source=chat` 与 `source=field-test` 的 `system.health`**。

做法（本次复验自己跑，脚本与日志在系统临时目录，不进仓库）：

```powershell
$env:XIXI_DATA_DIR = "$env:TEMP\t11-store"          # 让两个入口指向同一个新库
'你好' | node scripts/chat.ts --fake                  # 退出时写一条 source=chat 的 system.health
node scripts/field-test.ts --offline --no-open --no-tts   # 启动时写一条 source=field-test 的 system.health（随后停掉）
```

然后**直接读那个库文件**（`events` 表的 `source` 列，不走任何页面的自述）：

```text
C:\Users\zz\AppData\Local\Temp\t11-store\xixi.sqlite
  sequence 4  source=chat        service=chat
  sequence 5  source=field-test  service=field-test
```

实测：两条 `system.health` **在同一个文件里**（同一库、同一 `events` 表），条目数 5。
**辅助事实**（不是判定依据）：`resolveCanonicalDataDir({})` 返回 `E:\worker2\data\xixi`；
磁盘上旧的 `data/xixi.sqlite` 时间戳仍是 `2026-10-03T04:48:19`（未被触碰），
且本次复验跑完 `data/xixi` **目录仍不存在**——所有探针都写在 `%TEMP%` 下。
页面响应里的 `database.note` 之类字段**不作为证据**：它在 t9 评审时曾与事实相反（t17 才改成由
`CANONICAL_STORE_ENTRIES` 推导），一条会写错的字段不能用来证明库一致。

#### 抽取没有改行为（P0-A 的旁证）

`--print-wiring` 只有四个入口支持（`scripts/chat.ts`、`scripts/voice-device-check.ts`、`scripts/eval-realism.ts`、
`scripts/eval-conversation.ts`；`scripts/field-test.ts` 与 `scripts/serve-chat.ts` 没有这个开关）。
本次复验把这四个各跑一次并逐字段比对：**除 `entry` 名外只有 1 种 payload**（工具集四件、权限全 allow、`maxToolRounds` 4、`language` zh-CN）。
另有反向依赖自查：`git grep -rn "from '.*scripts/" packages services` **0 命中**（包不再反向 import 脚本目录）。

### 4. 明确没做的（P0 范围之外）

- **没钱重跑一次真实语料的 realism**（见 ④ 的边界）：P0 只保证「记录可复算、口径未漂移、确定性门禁 5/5 通过」，
  并且**明确不声称**「真人感不回退」——那要等 P1 落地后用真调用重跑一次。
- **没有删兼容 re-export**：`scripts/field-test.ts` 里的 re-export 要等下游全部迁完（pack `01_ARCHITECTURE.md` §3）。
- **没有做 P1**：`ContextBuilder` / `MemoryRetriever` / 关系上下文 / 记忆纠正 / 三入口 `afterTurn` 都还没开始（下一节）。
- **没有改 `services/`**：语音侧的 `SpeechPipeline` 只做了 B2 那一处交付。

### 5. 遗留（下一轮 / P1 之前）

1. **`docs/v03/ACTUAL_RUNTIME_MAP.md` 有多行仍是抽取前的状态**：`ProactiveLoop`、`createModelComposer`、
   `createModelDecider`、voice helpers、`current DB dirs`、`perception DB` 这几行的「定义处/调用点」还写着
   `scripts/field-test.ts` / 各入口各自拼路径（P0-A/B 已改）；表头也还写着「`packages/runtime/*` 目前不存在」。
   复核：`git grep -n 'ProactiveLoop' scripts/field-test.ts packages/runtime/src/proactive-runtime.ts`。
2. **`docs/architecture.md` 与 `docs/README.md` 的「四个入口各用不同的库」已过期**（P0-B 之后默认同库）：
   复核（t26 实跑，t16 报告里那句「0 命中」**不成立、已更正**）：`& 'D:\Git\usr\bin\grep.exe' -rn "各用不同" docs README.md` → **命中 5 处：3 处是历史引用（handoff 的 F1、README 的新鲜度行、运行时地图的旧名注释）、1 处是本条自身、1 处是原活声明 `docs/progress.md` 的那句（已在 t26 改成 canonical store 口径）**。
两份历史 benchmark 产物只加了一块 **2 行引用块的旁注（diff +3 行**：1 个空行 + 2 行引用块）、没改写历史。
3. ~~**G03 的未跑理由已过期**~~ → **已由 t19 更正**（`59cd65a`）：理由已改成点名 OpenThreadStore 与 TopicEngine 与 tests/replay 的跨天夹具；两份历史 benchmark 产物只加了一块 2 行引用块的旁注（diff +3 行：1 个空行 + 2 行引用块）、没改写历史。
4. **packages/brain-adapter/package.json 未声明 @xixi/model-adapters**（packages/brain-adapter/src/tools.ts 在值层面 import WeatherClient）：既有缺陷，靠 workspace 提升解析；下一轮补声明。
   在值层面 import `WeatherClient`）：既有缺陷，靠 workspace 提升解析；下一轮补声明。
5. ~~**两条没有回归底线的修复**~~ → **已由 t19 补上**（`59cd65a`）：`transitionOpenThread` 省略 `at` 的回归底线（新用例在旧写法下先红）；判官字段映射抽成唯一字段表（`scripts/lib/judge-score.ts`）并有 5 条离线单测。
6. **时间线命令的窗口需求**（常驻运维要求，不是缺陷）：**预算 ≥40 分钟、不中断**；安静机器 ≈24 分钟（1429.5 / 1423.1 / 1425.6 秒），同期有人跑测试 ≈34 分钟（2047.5 秒，单核打满、不是挂死）——见 ⑤ 与 §5。**注**：t19 没有处理过这一条（它不是代码问题）；派单若把它列进「已由 t19 补上」与事实不符，故保留为常驻运维要求。

---

## P1 — Memory becomes usable（已落地；pack 旗舰场景**曾未达标 → t22 修复、t23 复审 pass**；复审基线 `f2af0fb`、交付 `6170e4c`，历史说明见 §3）

**复验基线 `59cd65a`**，独立复验报告与可重跑探针：
[`verification/t15-p1-independent-verification-2026-10-04.md`](verification/t15-p1-independent-verification-2026-10-04.md) 与 `verification/t15-probe.mjs`。

### 1. 交付了什么

| 项 | 交付物（定义处） | 交付号 | 一句话说明 |
|---|---|---|---|
| P1-a 上下文与检索 | `packages/context/src/context-builder.ts`、`packages/context/src/memory-retriever.ts`、`packages/context/src/memory-score.ts`、`packages/context/src/render.ts`、`packages/context/src/prompt-turn.ts`、`packages/conversation/src/engine.ts`（`contextBuilder` 选项）、`packages/conversation/src/prompt.ts` | `d168af7` | ContextBuilder 成为唯一上下文装配入口（`contextBuilder: false` 可关掉）；MemoryRetriever 确定性混合排序、每轮注入 3~8 条、只取 `active`；两道出口闸门（机器 id / 参数名） |
| P1-b 关系·话题·纠正·afterTurn | `packages/domain/src/migrations/006_memory_status.sql`、`packages/domain/src/memory.ts`（状态 API）、`packages/context/src/memory-correction.ts`、`packages/runtime/src/turn-extraction.ts`、`scripts/{chat,serve-chat,voice-turn}.ts` | `733b1ae` | 关系笔记与未完话题进 `prompt.user` 与主动决策；旧事实可被取代/否定（四态状态机）；三个入口都走共用的 `createTurnExtraction`（关库前 `await drain()`） |
| 覆盖缺口修复 | `packages/context/src/render.ts`（最小改动）+ `tests/unit/context/context-builder.test.ts` | `bcb043a` | 给第二道防线 `renderGate` 补一条真能拓到它的用例（一对记忆：`injected=2`、`dropped_at_render=1`） |
| G03 理由与判官字段 | `tests/scenarios/golden-conversations.ts`、`scripts/lib/judge-score.ts` | `59cd65a` | 更正常年过期的 G03 理由；判官字段映射抽成唯一字段表 + 5 条离线单测 |
| 「重启后仍在」的默认门禁守护 | `tests/integration/memory-correction-closure.test.ts` | 本任务 t16（工作区） | 库从 `:memory:` 改成临时目录文件库，并新增一条**关库再开**的用例（跨进程版本由 t15 探针覆盖） |

### 2. 实测（我自己跑的；数字与命令见 t15 报告）

- **四条技术验收全部成立**（每条都用一个**文件库**、每一步一个**新进程**）：
  ① 对话写入记忆 → `semantic_memory` 一行 `preference: 我很喜欢喝茉莉花茶`（`active`）；
  ② 进程重启后仍在 → 新进程读同一个文件库仍是同一行（真模型侧每一步也是新的 `scripts/chat.ts` 进程）；
  ③ 后续正常聊天召回 → 问「茉莉花茶还有吗？」得到 `injected=1`，`prompt.user` 里出现 `- [较确定] 我很喜欢喝茉莉花茶`；
  ④ 纠正后旧事实不再召回 → 旧行 `superseded` + `supersededBy`、新行 `active`、只取 `active` 的候选集里没有旧句。
- **场景二（绿茶纠正）完全达标**：真模型三步（每步新进程）+ 直读库：旧行 `superseded`、新行 `我不喝绿茶` `active`、
  事后问茶不再声称「你喜欢绿茶」。
- **措辞检查**：「根据数据库」这类机械话在 8 轮真模型回答里 0 命中；离线整段 prompt `hasDatabaseWord=false`；
  `HARD_POLICY` 明写不提实现、不报工具幕。样本小，是观察值不是统计结论。
- **纠正闭环的硬证据**：`system.health(service=memory.status)` 一条，正文含 `superseded` 的原因（如 `disown_claim`）与新说法。

### 3. 验收状态与遗留（N1–N3 已由 t22 修复、**t23 复审 pass**）

- **N1（曾未达标；t22 已修，t23 复审 pass）**
  **一条记忆都不写**（整句匹配、不按逗号切分；「我」后面接的是「不喝绿茶」，「平时喜欢」前面没有「我」）。
- **N2（曾未达标；t22 已修，t23 复审 pass）**
  「给我推荐个茶。」与「我很喜欢喝茉莉花茶」没有共同双字词 → 检索层 `not_relevant`、`injected=0`；真模型那一轮用户看到的是引擎修复句 `UNBACKED_FACT_REPLY`，不是她的回答。
- **N3（曾未达标；t22 已修，t23 复审 pass）**
  疑问句被写成偏好事实（「你还记得我喜欢喝什么茶吗？」→ 落库成 `我喜欢喝什么茶吗`）；机制是守卫 `statement.includes('？')` 对当前正则恒为假（字符类已把问号排除在 `match[0]` 之外）。
- 以上三条：**t22 已修复并入库、t23 复审 pass**。
  改造前 write 无记忆、ask `injected=0`、疑问句落库成 `我喜欢喝什么茶吗`；改造后 write 一条 `active`、ask `injected=1` 且 `dropped_at_render=0`、
  疑问句新增 0 条；召回精度表 15 组里 5/5 召回、**10/10 误召回反例均未召回**（反证：去掉话题点名路径后 4 条红、10 条反例仍绿）。
  **t23 复审结论：pass**（复审基线 `f2af0fb`、用同一份探针 8FDBE4CC 独立复现了「前：0 条 / `injected=0` / 问句落库」与「后：1 条 active / `injected=1` / 问句 0 条新增」），
  且它自己补了一张**误召回矩阵**（6 条种子记忆 × 7 条查询）：除旗舰问句 0→3（多出来的是茶话会、茶叶罐，同话题内）外，其余六条查询的召回集改造前后完全相同。
  所以三条可以按「已修复并通过独立复审」写；**仍然不要**写「Phase 1 全部完成」——Tier 2 未接线、记忆 UI 未做，边界见下。
- **三条已知边界（第一条为 captain 裁定的口径、第二条是既有缺陷被 P1 放大、第三条为 t23 指出的既有行为；都不是本轮新引入）**：
  ① **复合问句不召回**：话题点名要求**查询的每个内容字都成词出现**，复合问句里多出来的内容字就把这条路径关掉了；② **疑问识别是字面三种形态**——
  没有疑问标记的残句仍按陈述读（「你还记得我喜欢喝什么茶吗？」这类会被正确识别；而「我喜欢的茶」这种残句会落库成 `preference:我喜欢的茶`）——
  **这条边界此前只在代码注释里**，t23 指出后补进文档。③ **宾语前置句会写出没有宾语的截断记忆**：「铁观音我平时喜欢」→ `routine:我平时喜欢`，
  「绿茶我平时爱喝」→ `routine:我平时爱喝`；t23 在 t22 前后跑同一批句子输出逐字相同，**确认是旧正则的捕获行为、不是 t22 引入**。
  **V0.3 P2-G 已修**：判据 `lacksObject`（偏好动词表 + 可选一个光杆身体动词，对**捕获组**判「只有动词、没有宾语」就不写），三句实测从 3 条变 **0 条**、
  正常句与旗舰句照旧；**词表之外的宾语前置句仍照写**（用例里的已知边界条），要认前置宾语需另开一条提取路径，属下一轮。
  另一条**观察**（t23 的 T23-D3，方向在内、本轮不收紧）：**单内容字查询会把库里所有「茶×」词一起带进来**——
  6 条种子记忆实测：问「给我推荐个茶」注入 3 条（茉莉花茶 / 茶话会 / 茶叶罐），跨话题没有上升（咖啡 1→1，象棋/普洱/茶几都没进来），
  但**茶类记忆一多时会挤满 3~8 条预算**。captain 裁定本轮不收紧（收紧会削掉旗舰场景本身），记在这里供下一轮判断
  （可能做法：按话题聚类后按预算分配，或给单字查询一个更严的成词门槛）。
- **Tier 2 结构化抽取尚未接线**
- **默认门禁的守护**：`npm test` 现在覆盖「写入 / 跨进程重启 / 召回 / 纠正」四条（closure 用例已是文件库），
  但**不覆盖 pack 场景的原句**——那正是 N1/N2 的入口。

### 4. ADR

- [`adr/0015`](adr/0015-context-builder-and-engine-boundary.md)：ContextBuilder 与 ConversationEngine 的边界（含「引擎自己会再建一次 context」这条会骗过探针的细节）。
- [`adr/0016`](adr/0016-memory-status-state-machine.md)：记忆状态机（active / superseded / revoked / expired）与纠正闭环。
- [`adr/0014`](adr/0014-trusted-memory-policy-and-provenance.md)：可信记忆策略与 provenance（ADR 由 t16 在 `0c7d804` 登记）。

### 5. P0+P1 收口后的全量门禁（t16 实跑，2026-10-04）

| 命令 | 实测 | 取数时的树 |
|---|---|---|
| `npm run check:types` | exit 0 | HEAD `6170e4c`（t22）+ **t16 的文档改动在途**（本文件的这些改动；`packages/` 无未提交改动） |
| `npm test` | **587 项 pass 587 fail 0 exit 0**（框架 `duration_ms` 39170.7，进程外墙钟 39.7 s）——⚠️ **这是 `6170e4c` 时的快照**：随后 t24 加了 1 条用例，**交付态（`0c7d804`、工作区干净）实测 588/588 exit 0**；t26 复跑同样 588/588 | 同上 |
| `npm run check:docs` | **103 份 markdown**，失效链接 0 / 不存在的文件引用 0 / 缺少新鲜度标记 0，exit 0 | 同上 |
| `node scripts/eval-proactive-timeline.ts` | **EXITCODE 0、ELAPSED_SEC 2047.5（≈34 分钟）**；单日五项目标 + F4 分离探针 + 多日 M1–M6 **全部通过** | 同上 |

- `npm test` 的 587 项**包含**本轮把 `tests/integration/memory-correction-closure.test.ts` 从 `:memory:` 改成临时目录文件库
  （并新增一条**关库再开**的「重启后仍在」用例）之后的版本——这次改动没有让门禁变红。
- **时间线这次 34 分钟**（此前三次实测 1429.5 / 1423.1 / 1425.6 秒）：本次跑在**并发窗口**里（另一个成员在同一时段反复跑测试），
  进程采样仍是单核打满（10 秒烧 9.5 CPU 秒）、未中断，日志内容与形状和此前逐项一致（同样 23082 字节的 UTF-16LE、12 项判定全过）。
  所以「给它 ≥30 分钟」这条要**按并发情况放宽**：安静机器 ≈24 分钟，有人同时在跑测试时 ≈34 分钟。

---

## P2 — Agent/Plugin Completion（两个场景在交付件上成立、四条 gate 全绿；**入口层未接线；提醒的模型可靠性未达标**）

**复验基线 `4eb42ec`（认领时 HEAD）；门禁与两个场景的最终取数修订号 `024cd43`（工作区干净）**。
独立复验报告：[`verification/t14-p2-gate-independent-verification-2026-10-04.md`](verification/t14-p2-gate-independent-verification-2026-10-04.md)（含逐条命令与输出）。
探针在 `.scratch/t14/`（`.gitignore` 已忽略，按任务要求**不进仓库**；报告 §0 给了可重建的清单）。本节只写我自己跑出来的东西。

### 1. 交付了什么

| 项 | 交付物（定义处） | 交付号 | 独立评审 | 一句话说明 |
|---|---|---|---|---|
| P2-0 现状地图 | `docs/v03/P2_PLUGIN_GAP_MAP.md` | `b6d718e` | — | 对照 pack 03 八节逐条 `git grep` 的「今天在哪、差什么」基线（钉在 `767f505`） |
| P2-A 插件内核 | `packages/plugins/src/{manifest,capability-registry,manager,discovery,context,prompt-authority,disposal,errors,index}.ts`、`packages/runtime/src/tool-runtime.ts` 的 `buildPluginRuntime`/`mountPluginTools` | `060f1fb` + 修复轮 `9f226b6` | t9 **needs_revision → t19 pass** | 九步生命周期 + 五能力枚举 + 四条「插件不能做」的强制点；`ToolRegistry` 是**升级**（`register` 返回值同时可调用且带 `.dispose()`，旧写法一字未改） |
| P2-C MCP adapter | `packages/plugins/mcp/{types,naming,connection,adapter,plugin,index}.ts` | `c8396e0` + 修复轮 `d407eac` | t13 **needs_revision → t21 pass** | SDK v2 的 discover → normalize → 命名空间（`mcp.weather.forecast`）→ ToolRegistry；不做高频 sensor bus；`close()` 与 `dispose()` 分开（deactivate 后能再 activate） |
| P2-B 工具审批 | `packages/domain/src/migrations/007_tool_approvals.sql`、`packages/domain/src/store.ts` 的审批块、`packages/runtime/src/tool-approval.ts`、`packages/brain-adapter/src/tool-registry.ts` 的 `ToolExecutionContext` 与摘要闸门 | `d64066b` + 修复轮 `f57282d`、`8dfc0bd` | t10 **needs_revision → t23 pass** | 待批落库七字段 + **冻结参数摘要**（对不上就 `APPROVAL_MISMATCH`、绝不执行）+ 拒绝/到期都落审计；`listForAgent` 改成「deny 之外都广告」 |
| P2-F 接口收缩 | `packages/brain-adapter/src/types.ts`（三接口）、manifest 补 `@xixi/model-adapters`、`tests/unit/core/plugin-tools.test.ts` 等文件的旧接口残留清理 | `19b54b9` + `f2f3af1` | t16 **pass**（t17 修铁律 9 越界） | `TurnModelProvider` / `MultimodalTurnProvider` / `StructuredInferenceProvider`；四个能力从接口与三个实现类一并**移除**（不是留着抛异常） |
| P2-D 真实 News | `packages/plugins/news/**`（12 文件：RSS 解析器 / 公开 JSON API / web search 适配器 / 离线桩 / desk / 未信数据包装 / 四条主动判据 / 三工具 / TopicSource / manifest） | `3ada7cd` | t11 **pass** | `news.search` / `news.latest` / `news.for_interests` + `news.topics`；`xixi_news_stub` 的**注册路径**全部消失（只剩解释它为何被删的注释与防回潮断言） |
| P2-E durable Reminder | `packages/domain/src/migrations/008_reminders.sql`、`packages/domain/src/reminders.ts`、`packages/runtime/src/reminder-runtime.ts` | `3bd7d3e` + `5336b13` | t12 **needs_revision → t25 pass**（t24 补时区边界） | 八字段表 + 五态状态机 + 自然语言时刻解析成**绝对时刻 + 时区**；`DurableReminderSink` 接工具链、`ReminderScheduler` 跑到点，两步都写 `reminder.changed`（与表同一事务） |
| P2-G 上一轮遗留 | `packages/conversation/src/extractor.ts` 的判据 `lacksObject` + 召回预算边界 | `d573437` | t26 **pass** | 「铁观音我平时喜欢」不再写出 `routine:我平时喜欢`（三句实测 3 条 → 0 条）；单字查询的召回预算记成带数字的已知边界 |

### 2. 四条 gate 实测（`024cd43`，`git status --porcelain` 为空）

| 命令 | 实测 |
|---|---|
| `node --version` | `v24.21.0`（`package.json` 的 `engines.node` = `>=24.0.0`） |
| `npm run check:types` | **exit 0** |
| `npm test` | **717 项 pass 717 / fail 0 / cancelled 0 / skipped 0 / todo 0**，`duration_ms 45144.0323`（t14 复验）→ **P2 收口末次复跑 44643.0 ms、同样 717/717**，**exit 0**（三条命令同一批跑，外墙钟 47.1 / 47.9 s） |
| `npm run check:docs` | **104 份 markdown｜失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0**，exit 0；写入 t14 报告后 105 份；**P2 收口（四份 ADR + 本节 + 全库同步）后 109 份，三个 0 不变，exit 0**——**末次复跑在全部编辑落定之后（HEAD `48e9801`、工作区含本节改动）** |
| `node scripts/eval-proactive-timeline.ts` | **exit 0、ELAPSED 1702.1 秒（≈28.4 分钟）**；单日五项目标 + F4 分离探针 + 多日 M1–M6 **全部通过**（逐条：主动 11 次在 6~12 内、generic 18.2% ≤ 20%、话题来源 81.8% ≥ 60%、被忽视日 11→5 次降频 54.5%、热聊接话 8 次且最小间隔 4 分钟 < 18；多日 multi-responsive 逐日 8/8/11、multi-unanswered 6/8/8、crossday 跨天追问 10 次） |

- **与上一轮可比**：P0 复验 520 项 / 32929.9 ms；P1 复验 575 项 / 41444 ms；P1 收口 588 项；**P2 = 717 项 / 45144.0 ms**。
  多的 129 项来自 P2 五条线的新用例；`npm test` 的 script 仍是同一组六个 glob（口径没变）。
- P2 变动面的细分：`node --test` 跑 plugins 内核 + MCP + 提醒 + 审批 + news 工具循环 + 插件工具接线 → **131 项 pass 131 fail 0（4.32 s）**。
- **多日时间线不回退**（P0+P1 的行为基线）：`node scripts/eval-proactive-timeline.ts` **exit 0、1702.1 秒（≈28.4 分钟）**，
  单日五项目标 + F4 分离探针 + 多日 M1–M6 全过（输出抬头写明基线修订号 `024cd43`）。
  **窗口口径两档照旧**：安静机器约 24 分钟（P0/P1 三次实测 1429.5 / 1423.1 / 1425.6 秒），
  同期有人跑测试约 34 分钟（t16 收口时 2047.5 秒）；本次 28.4 分钟**介于两档之间**——同一时段我在做文档编辑与 `check:docs`（轻负载，没有跑 `npm test`）。
  纪律不变：**预算给 ≥40 分钟、不要中途掐掉**（单核打满、不是挂死）。

### 3. 两个场景（真模型 + 真工具执行 + 真文件库；探针在 `.scratch/t14/`）

- **①「今天有什么新闻？」→ 真的形成 tool call ✅**：装配点给出的工具是三个内置 + `news.search/latest/for_interests`，
  插件 `xixi.news` 状态 `active`、能力 `tool:×3 + topic_source:news.topics`；模型发起 `news.latest` **并真的执行**
  （记录来自 `ToolRegistry.execute` 内部的回调，`ok: true`），来源是 BBC World RSS + Hacker News JSON API 两次真实 HTTP，
  真实头条进了回复；**事件日志里那一条 `conversation.turn` 带 `tool_name: "news.latest"`**（就是 `npm run turns` 读的字段）。
- **②「明天八点提醒我打电话。」→ 写入 durable reminder + 重启后仍在 + 到点成事件 ✅（三步都留下直读库的证据）**：
  进程 A 落库 `due_at 2026-10-06T08:00:00.000+08:00`、`timezone Asia/Shanghai`、`resolve_kind day_relative`（不是把「明天八点」原样存）。
  **进程 B 是新的 `node` 进程**：tick 之前读到的是 `status: pending` 的那一行（重启后仍在），
  到点 tick 后 `pending → due → candidate`，事件日志里 `seq 2 reminder_created → seq 5 reminder_due → seq 6 reminder_candidate`。

### 4. 未达标项（如实登记，不要合并成「已达标」）

1. **两个场景在四个 live 入口上都还不成立（Tier 2 未接线）**：
   - 新闻：`node scripts/chat.ts --print-wiring` 实测只交三个内置、**没有 `news.*`**；真跑入口问「今天有什么新闻？」，
     她只能调 `xixi_get_current_time` 然后回「我手头没有能查的东西」。代码侧同因：`git grep -n buildPluginRuntime -- scripts` 只命中 `probe-tools.ts`。
   - 提醒：入口里工具**真的被调用了**（`[tool] xixi_set_reminder_stub ok`），但直读那个库是 `reminders: []`、`reminderEvents: 0`
     ——入口的 sink 还是内存版；`git grep -n 'DurableReminderSink\|ReminderScheduler' -- scripts` 零命中。
   - 根因一句话：内核/MCP/news/审批/提醒的**装配点**都已交付，但**入口仍只调 `buildToolChain`**。
2. **提醒的可靠性未达标（连装配点也算上）**：同一句话、同一条交付链、真模型 **22 次保存了逐条记录的尝试里只有 6 次真的调用了工具（27%）**；
   其余 16 次里 **4 次回复明说「记下了」而库里没有行、没有任何事件**。根因在提示词/行为层（`HARD_POLICY` 只要求「可核查的**事实**」走工具，
   没有一句要求「提醒我……」这类**写操作**必须走工具），不是持久化实现的缺陷：工具一旦被调用，第 3 节的三步每次都成立。
3. **MCP 没有对着外部/远程服务器验证过**：`git grep -n 'mcpServers\|createMcpPlugin' -- scripts` 零命中（没有任何入口配置过 MCP 服务器）；
   已有证据是 SDK v2 的真 client + 真 server 走 `InMemoryTransport`。DoD 第 6 条按「SDK 客户端路径成立、外部服务器未验证」写。
4. **新闻真实来源属手动证据**：默认门禁用的是离线桩来源（`networkCalls=0`），真实 RSS/HN 只在本节的手动复验里跑过（AGENTS §2 的口径，不是缺陷）。

### 5. 边界与遗留（下一轮清单）

**P2 的「下一阶段接线项」四条**（缺一条都会让下一个任务以为它已经在守；四条今天**都不成立**）：

1. **四个 live 入口仍走 `buildToolChain`**：`scripts/chat.ts`、`scripts/serve-chat.ts`、`scripts/field-test.ts`、
   `scripts/voice-turn.ts` 下一步应改成 `buildPluginRuntime(config, { news, mcpServers, reminderSink }).start()`
   （那是 P2-A/P2-C/P2-D/P2-E 的唯一装配点）。核对：`git grep -n "buildPluginRuntime" -- scripts` 只命中 `probe-tools.ts`。
2. **提示词装配点没有调 `verifyOnAssemble`**：`packages/conversation` 的 `PromptAssembler` 是唯一调用点，今天没有调用。
3. **四个 live 入口没有把 `ToolApprovalManager` 接成 `approvalGate`**（t4 估约三行），
   所以「部署里真的会拦下来」这句话在入口层还不成立。
4. **manifest 的 tool 级 approval 声明未实现**：今天只有 `config.tools.approval.ask` 在起作用，
   manifest 自己没有 tool 级 token（`ActionHandler.approval` 只作用于 `action` 能力，而 `action` 还没暴露成工具）。
   这是**下一轮的一个小任务**：它与 `packages/plugins` 和 `packages/domain/src/config.ts` 都有交集，
   本轮排它会再串一层依赖，故明确不排。

其余边界与遗留：

- **今天可跑的证据链是「装配点 → `registry.execute` → 真表 → 重启 → tick → 事件」，不是「某个入口已经这样跑」。任何文档都不许写成后者。**
- **提醒工具的名字与文案已过时**：仍叫 `xixi_set_reminder_stub`，返回文案仍写「到点不会自动响，需要人看一眼」（`git grep -n '到点不会自动响' -- packages`），
  接上 durable sink 之后与事实相反；下一轮改 brain-adapter 时要连描述一起改。
- **提醒的提示词缺口**（第 4.2 条）：写操作要「先记再答应」，并补一条**离线**的默认门禁用例（今天门禁覆盖工具本身，不覆盖模型是否会选它）。
- **团队已登记、本次未重复测量的遗留**（只登记）：`PluginRuntimeMount.start()` 不幂等（t19 的 O1）；
  `manager.instance().health` 是过期快照（handoff 的下一轮清单第 10 条登记）；
  P2-F 的 `supportsImages` / `inferJson` 两条接缝在生产侧没有消费者（t16 的 F4，见 ADR-0020 §3）；
  `plugins/xixi-tools/index.js` 仍 import `@deepseek-ai/dsh-tools`，这条铁律 9 的口径需要用户裁定（t17 交回 captain）。
- **没有独立复验的部分**：MCP 的命名空间/降级/重连细节与插件内核四条「不能做」的强制点，我这次只跑了细分门禁（131 项全绿），
  细节结论仍以 t19/t21 的评审为准。

### 6. ADR（本阶段新落四份）

| ADR | 决定 | 与本文的关系 |
|---|---|---|
| [ADR-0017](adr/0017-plugin-boundary-and-four-prohibitions.md) | 插件边界与四条「插件不能做」：manifest 五能力七权限的配对、九步生命周期、每条禁令的强制点、保留命名空间 | P2-A/P2-C 的口径来源；§4.1/§4.2 与 §5 第 1 条 |
| [ADR-0018](adr/0018-tool-approval-frozen-args.md) | 工具审批模型：七字段 + 四程序事实、摘要化冻结参数、五态与原因码、**恢复语义**（`approve()` 自带到期闸门）、拒绝与到期都落审计 | P2-B；§5 第 3、4 条 |
| [ADR-0019](adr/0019-news-and-reminder-data-model.md) | 新闻与提醒的数据模型：三个工具 + 四条主动判据 + 账本；八字段表 + 五态 + **时区语义**（按请求时区的当地日历、换时区必须换绝对时刻）+「到点成事件」的口径 | P2-D/P2-E；§3 场景②与 §4.2/§4.4 |
| [ADR-0020](adr/0020-provider-three-interfaces-and-mcp-deps.md) | Provider 三接口拆分、四能力退役与真实归属、**两条接缝没有消费者**、MCP 的依赖理由与版本选择 | P2-F/P2-C；§5 的遗留与 `docs/design/brain-and-models.md` 的同步依据 |
