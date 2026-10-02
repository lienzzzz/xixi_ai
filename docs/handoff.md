# 接手交接书（Handoff）

> 最后更新：2026-10-01（第四轮 `xixi-v02-round4` 已收口，见下面 §0）
> 权威来源：`docs/progress.md`（结论与数字）、`docs/recon/*`（外部系统实测）、代码与测试
> 若与代码不一致，以代码为准，并请立即修正本文件

**这份文件的目标**：让一个新接手的 Agent（或上下文被压缩后的你自己）在 **10 分钟内**知道——
现在能跑什么、怎么自证、哪些是坏的、有哪些坑、下一步该做什么。

---

## 0. 当前状态（2026-10-01：**第五轮 `xixi-v02-round5` 运行中**；第四轮已收口）

**第五轮在做什么（2026-10-01 用户批准）**：按用户「主动性高一些、像人、可以有自己的性格感情但不极端」的诉求，做四条：
① **主动性口径拍定**：采纳「**显著降频**」，**不做**「连续两次未回应后 = 0」的硬停（理由：硬停与 ADR-0011 的两层设计冲突、
与用户诉求相反），并把验收从单日扩到**多日时间线**；
② **话题收口判据升级**（字 → 词/对象：共享内容字不再误收口，**且真答案召回不许下降**）；
③ **pack Phase 8 流式语音**（token 流 → 按句读切块 → 首块即播，首音 **P50 目标 ≤1.5 秒**）+ 打断 + backchannel；
④ **有界的心情状态**（事件演化、散文注入、上下界可证明、**轻微**影响语气与主动性、不覆盖硬底线、不编造实体经历、可查看与复位）。

任务链：`t1`（口径 + 多日时间线）→ `t2`（判据升级）→ `t3`（流式语音）→ `t4`（心情）→ `t5` 评审 t3 → `t6` 评审 t4
→ `t7` 独立复验四条 → `t8` 集成收口；成员 5 名（新增语音工程师），契约在 `.agent-teams/xixi-v02-round5`。
**地基**：`npm test` 398/398、`check:docs` 94 份、最近交付 `f91f404`。

**怎么走到这里的**：① 第一轮 `xixi-v02-p0p1`（P0/P1/P5 收口，已归档）；② 第二轮 `xixi-v02-round2`
（t21 快照收口 + t3 在途，用户暂停后归档）；③ 第三轮 `xixi-v02-round3`（成员 opencode-go/deepseek-v4.1-flash）
把**交接书六步全部落地**（台账见下），但收尾的 t13 撞上 **opencode-go 配额 429（GoUsageLimitError）** 而失败；
运行中的团队**改不了成员模型**（AGENTS §9.23），于是归档第三轮、新建 **`xixi-v02-round4`**
（成员 `commandcode/deepseek/deepseek-v4.1-flash`、reasoning max、5 任务，契约在 `.agent-teams/xixi-v02-round4`），
承接四条收尾与集成收口；t13 的在途工作已作快照 **`b7fb811`**（376/376 绿、未经验收）。
四个团队里前三个都是归档态（任务与邮箱留档可查）。

**已经做完并验证过的（可以放心用）**：
- **P0 基线**（`docs/benchmarks/v01-baseline.md`）：改造前的提问率、长度分布、语音四段延迟（首个可听 **P50 6.8s**）
- **P1 提示词与上下文重写 + 回复长度分布**：跨轮复述归零、长度有分布、容量 180→480 字（`docs/progress.md` §2.18）
- **真人感指标与黄金对话评测**：`node scripts/eval-realism.ts`（口径与局限见 `docs/benchmarks/realism-metrics.md`）
- **回复卫生**：工具调用标记与英文思维链不再进正文（真实 MiMo 复现缺陷现场并验证清除）
- **主动性 V2**：六条缺陷修完，**独立复验五项目标全过**，评审 pass
- **pack Phase 2**：工具注册表与四轮循环、语音入口接工具（评审 pass）
- **pack Phase 3**：未完话题与话题引擎（评审 pass）
- **pack Phase 4**：长期记忆 + 三层自我画像 + 异步反馈解释器（评审 pass）
- **收尾微任务**：中文分钟令牌按真实分钟数（评审 pass）

**第三轮交付台账（全部入库并推送）**：

| 第三轮任务 | 结果 |
|---|---|
| t1 修 Phase 5 六条缺陷 + 时间线命令 | ✅ **`626c201`**（五项目标全过：11 次／18.2%／81.8%／11 比 5 降 54.5%／热聊接话 8 次） |
| t2 独立复验 Phase 5 | ✅ **`38a0528`**（报告 `docs/verification/t2-timeline-independent-verification-2026-10-01.md`；独立复算五项成立，三处偏差见下） |
| t3 / t5 / t7 / t9 / t11 五次评审 | ✅ 全部 **pass**（t11 的差分探针证明分钟令牌修复只收紧不放宽） |
| t4 pack Phase 2 | ✅ **`87b147c`**（336/336；语音入口与 console 共用同一注册表） |
| t6 pack Phase 3 | ✅ **`8ee01ba`**（353/353；Day1 说办证 → Day2 追问 → 回应后 resolve 不再重复） |
| t8 pack Phase 4 | ✅ **`1efc8b3`**（374/374；「主动一点」0.85→0.97、「话太多」只砍话痨参数、「安静点」次日恢复） |
| t10 分钟令牌 | ✅ **`dccf04b`**（376/376；真句放行、假句拦截、容差 45 进 46 出） |
| t13 质量微任务 | ⚠️ **失败于配额 429**，在途快照 **`b7fb811`** → 由第四轮 t1 承接 |
| t14 / t15 / t16 / t12 | ⏸ 未开工 → 由第四轮 t2 / t3 / t4 / t5 承接 |

**第四轮任务（团队 `xixi-v02-round4`，契约与状态在 `.agent-teams/xixi-v02-round4`）**：

| 任务 | 状态 |
|---|---|
| t1 理由码断言强度 + 时间线覆盖问询额度（承接第三轮 t13） | ✅ 完成 → **`b36ef15`**（376/376；两次已宣告的突变实验证明断言抓得住，还原经 sha256 核验；时间线命令六行全过 exit 0） |
| t2 工具链与语言接线推及全部 live 入口（承接 t14） | ✅ 完成 → **`dba60bc`**（382/382；四个入口共用 console 的 buildToolChain，新增离线开关 --print-wiring；三次已宣告的突变实验验证断言） |
| t3 未完话题收口不挂钩（承接 t15） | ✅ 完成 → **`37b8453`**（386/386；新增相关性门槛，无关轮次不写事件不改状态、窗口内仍可再问一次） |
| t7 评审 t3 | ❌ **needs_revision**（两次突变它自己重跑并复现，判定证据可信；两条 finding：**R1 高**——通用字表少「去」且与第 267-268 行注释自相矛盾，实测 13 句无关闲聊 4 句中招、话题被永久关掉；**R2 中**——弱证据路径用未过滤字表比字，「没去散步」类会被 snoozed） |
| t8 修复 t3 的两条 finding（R1 加「去」并补 10 句回归／R2 收紧成单一规则、删掉等价弱分支） | ✅ 完成 → **`ab61a98`**（398/398；13 句无关句误判 6/13→**0/13**、真答案 5/5 照旧；两次突变实验各红 2 例） |
| t9 复审 t8 | ✅ **pass**（三次突变自己跑并还原；独立复测 13 句误判 4/13→0/13，代价量到真答案 9 句里 7→6、唯一新增漏判正是被钉住的那句「没去成，改天再说吧。」；认可「已知残余」的钉法） |
| t4 推断学习分支接线 + 提取队列不丢数据（承接 t16） | ✅ 完成 → **`227fbd7`**（395/395；推断分支真的接线，并当场修掉「权重被乘两次」→ 只有名义值 0.16 倍的真缺陷） |
| t6 更正两处与事实不符的注释（承接 t2 的 §9.13 更正） | ✅ 完成 → **`f11d90c`**（397/397；纯注释 16 增 8 删） |
| t11 清掉「省略 language 即直通」最后一处注释残留（reply-hygiene.ts） | ✅ 完成 → **`2fd3643`**（纯注释 6 增 2 删；全仓 `is a pass-through` 命中 0、中文「直通」0） |
| t10 评审 t4 | ✅ **pass**（自算数值 + 反事实：把落库换回已乘权重的值 → 集成用例红 2 例（−0.008 vs −0.02），显式侧 −0.12 一字未变；边界与退出诚实性都核过；三条非阻塞观察 N1/N2/N3） |
| t12 更正 mimo-markup-hygiene 测试里的反向注释（N3） | ✅ 完成 → **`2655fa3`**（398/398；注释 14 增 8 删、无 assert. 代码行；突变实测 4 绿 1 红、唯一红的是 en-US 那条，证明「省略时回落 zh-CN、真正承重的是 en-US 侧」） |
| t13 修正 extraction-queue 的反向注释 + 让 feedback 单测走生产实现（N1/N2） | ✅ 完成 → **`022cb7b`**（反事实让单测层红 1 例：actual −0.008 vs expected −0.02，其余 10 例绿；集成文件同突变红 2 例） |
| t5 集成收口：文档同步 + 全量门禁（承接第三轮 t12） | ✅ 完成（产物在**工作区**、由队长提交）：本轮漂移全部核改（README、`architecture.md`、`design/conversation.md`、`design/brain-and-models.md`、`design/security-and-privacy.md`、`design/domain-model.md`、`docs/README.md`、`event-contracts.md`、`testing.md`），`progress.md` 新增 §2.19（Phase 2/3/4 的逐入口覆盖与取舍）与 §4 第 10–25 条（已知问题清单） |

**第四轮收口门禁（同一次运行，2026-10-01）**：`npm test` → `ℹ tests 398 / pass 398 / fail 0`，exit 0；
`npm run check:docs` → 检查了 93 份 markdown、失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0，exit 0。
（数字是**当时快照**：要现状自己跑 `npm test` 看末行，别抄这里的数。）

**未完话题收口判据（第四轮 t8 发现残余 → 第五轮 t2 已修）**：第四轮时判据是**字**级，共享内容字（通用动词 买/看/吃/拿、
常见名词）会让无关句被收口——实测「明天我要去买药。」+「我去楼下买了点水果。」与「明天我要去看孙子。」+「老李家的孙子回来了。」
各 1/13。**第五轮 t2 已把它升级到词/对象级**（对象词受控词表 + 动作词须说得一样完整 +「别人的」框；通用动词永不单独作依据，
三表关系由模块加载期 `assertVocabularyShape` 把关）：**13 句无关探针 × 7 个话题 = 0/91**，召回不降（9 句真答案仍 7/9、
另补 15 句 15/15）。判据、代价与四条已知边界见 [`adr/0012`](adr/0012-open-thread-closure-criterion.md) §判据升级。
**仍待同步的旧措辞（归第五轮 t8 集成收口）**：本文件中「未完话题判据的已知残余」那一行、`progress.md` 的 §0 结论表与 §2.19
里「收口判据＝内容字」的说法、`design/conversation.md` 的同类描述。

**t9 复审交 t5 的两条**：① `packages/conversation/src/index.ts` 仍未登记 `isAnswerAboutThread` 与 `IgnoredThreadTurn`
（`ReconcileResult` 已登记）；② `classifyThreadAnswer('没去成，改天再说吧。')` 仍返回 snoozed，但门槛会**先**判它不相关——
**「分类」与「是否算回答」是两层**，文档必须写清，否则会被读成自相矛盾。
| 更早的交付 | 第二轮 t21 快照收口 → **`df294b7`**（评审 pass）；在途快照 **`23248f3`** |

**t5 评审的四条观察处置**：T5-F1（medium：文字 CLI、设备自检、真人感评测、对话评测四个 live 入口还没接入同一工具链）
与 T5-F3（low：文字 CLI 未传 language，英文推理可能进 TUI）→ 已成 **t14**；
T5-F2（low：agent-loop 的 now 是回合开始快照）与 T5-F4（low：两处内部字样正则不一致）→ 归 t12 记录为已知缺口。
**文档里不得笼统写「语音与文字共用同一条工具链」**，必须逐入口写明（t12 负责）。

**t8 的非阻塞观察（归 t12 记录，不在本轮修）**：只读入口 `scripts/chat.ts` 与 `scripts/voice-turn.ts` **未接 `afterTurn`**
（那两个入口本轮不写记忆与学习，与 T5-F1 同类：覆盖必须逐入口写明）；学习层漂移上限 ±0.30 使「话太多」到不了提示词低档
（§7.4 的设计取舍）；记忆的查看/编辑/删除目前只有领域 API、没有 UI；记忆写入**不新增事件类型**（记忆是推导，铁律 4，
每行带 `source_event_id` 指回 `conversation.turn`）；`overrideSelfProfile` 仍是基础层语义（CLI 与评测用它是对的）。

**恢复方式**：若再次暂停，用户明确要求后用 `agent_teams_resume`（理由必填）；第四轮已收口，续跑就是让调度器继续派单。
**第四轮成员模型是 `commandcode/deepseek/deepseek-v4.1-flash`（reasoning max）**；运行中的团队改不了成员模型，要换只能归档重建（AGENTS §9.23）。
改造包在 `E:\worker2\xixi_v02_refactor_pack`（**未跟踪**，是否入库由用户决定）。

**第三轮排队的文档漂移已由第四轮 t5 核改（2026-10-01）**：README、`docs/design/conversation.md`、`docs/README.md`、
`docs/design/brain-and-models.md` 里「产线未订阅 onNotice / 页面不可区分 / `SILENCE_ARTIFACT_ONLY` 不存在」全部换成现状——
**试用页（`scripts/serve-chat.ts`）与控制台（`scripts/field-test.ts`）已订阅 `onNotice` 并显示「沉默原因」
（`ARTIFACT_ONLY_REPLY` vs `MODEL_SILENCE`）；文字 CLI（`chat.ts`）与语音轮次（`voice-turn.ts`）仍未订阅**；
候选名 `SILENCE_ARTIFACT_ONLY` 从来没有进过代码。`docs/event-contracts.md` 的「将来靠 confidence + `source_type`」改成现在时
（`self_profile_history.source_type` = `learned:model_inference`、confidence 0.4，且权重只在 `SelfModel.learn` 乘一次）。

**已收口的第三轮遗留**：engine.ts 的中文分钟令牌已由第三轮 t10 改成按真实分钟数（`dccf04b`，评审 pass）。

**已知问题（只记录、本轮不修）**：完整清单在 [`progress.md` §4 第 10–25 条](progress.md)——
`onNotice` 订阅覆盖不齐（chat.ts / voice-turn.ts）、控制台 `proactiveSettingsToConfig` 不回写部分设置（t63 既有）、
黄金语料缺 quiet-hours 硬底线用例、DSH 插件面 `plugins/xixi-tools` 仍只注册两个工具（直连路径有四个）、
`agent-loop` 的 `now` 是回合开始快照、两处「内部字样」正则不一致、只读 GET `/api/field/proactive` 会 `reconcile` 且与常驻循环并发、
`runJob` 共享一次 `try`（一个非法属性丢整轮）、时钟类假句在流式出口先吐后撤（显示与延迟层面、不可听）、
「晚上八点一刻」类口语读法不在范围（不比修复前差）、记忆只有领域 API 没有 UI、`conversation` 的 `index.ts` 未登记 t3 的新导出、
`scripts/serve-chat.ts` 没有信号收尾、推断读法每轮全量读该会话的 `proactive.decision`、
未完话题判据的已知残余（共享内容字的无关句仍可能被收口，实测 1/13，已钉成用例）。

**Phase 5 现状（t2 复验 + t3 评审都已完成，评审 verdict=pass）**：五项目标**独立复算全部成立**（11 次／18.2% 两口径相同／81.8%／
11 比 5 降 54.5%／热聊接话 8 次、最小间隔 4 分钟），六条缺陷都有反事实或探针证据；评审另确认没有删弱断言、没有把测试挪出默认门禁、
`reason_code` 是自由 string 所以新码无需迁移。**但三处如实偏差要一起读**：
① pack 更严的「两次未回应后继续主动 = 0」**不成立**（台账：被忽视的一天在连续 ≥2 条未回应后仍开口 2 次，时钟钩子底分 0.99 扛得住 0.9 惩罚）——
成立的是「显著降频」；② 第四项断言只有 1 条消息余量（5×2≤11），很脆；③ `hot-chat` 19 次超出第一项区间、接受率 54.5% 低于 pack §3 的 60%。
**因此文档只能写「按显著降频口径达标、按 pack 测试文档的更严口径不成立」；「= 0 还是显著降频」是待用户定的产品口径，
未定之前不得单方面宣布 Phase 5 全通过。**
复验报告：`docs/verification/t2-timeline-independent-verification-2026-10-01.md`；历史未达标证据见
`docs/verification/t9-proactive-v2-verification-2026-10-01.md` 与
[`docs/adr/0011-proactive-decision-ownership.md`](adr/0011-proactive-decision-ownership.md)。

**t3 评审的四条 low 观察处置**：R1（判据余量与「= 0」口径）见上，待用户决定；**R2**（理由码断言被改成自适应长度、
抓不住「新增码没进 gate 表格」）与 **R4**（交付的时间线命令不覆盖 F4 新路径）→ 已成第三轮 **t13**（排在 t10 之后，集成 t12 依赖它）；
**R3**（新键在控制台不可见不可改 + usage 残留旧口径）→ 归 t12 记录。

**引用 t9 探针的限定（t2 的 O3/O6）**：`data/verification/t9/t9-floors.ts` 的 B6 现在 **FAIL**（13/14、exit 1）——
那是 F4 修复的**预期结果**，不能再写「14/14 通过」；`t9-timeline.ts` 自带**旧的 tick 走法**，绝对次数（responsive 9→4）
**不可比**，只能当方向性信号（关掉未回应惩罚 4→12 与 t2 自己的探针一致）。两者都在 gitignored 的 `data/` 下。
另：t2 的两条待决判据（O1 断言余量与「= 0」口径、O2 脚本输出可能被误读）记录在复验报告 §4，未改代码。

**坑（都在 `AGENTS.md` §9）**：取消被依赖的任务会让下游永久卡死（§9.22）；提交要按文件不要按目录（§9.7）；
文档里的命令必须原样可跑（§9.8）；运行中的团队改不了成员模型，要换模型只能归档重建（§9.23）。

---

## 1. 三十秒版

西西是一个**长期陪伴型语音智能体**的原型（不是聊天机器人）。当前完成到「**初步验证阶段**」：

- **文本对话流畅**：多轮连贯、有人格、会主动沉默、能查真实天气；**2026-10-01 起提示词前缀＝「身份与说话方式」（散文 + 紧凑安全段），回复容量 180 → 480 字**，同一批语料的提问率主口径 45.8% → 46.0%、单段最长 341 → 170 字（对比命令见 [`benchmarks/realism-metrics.md`](benchmarks/realism-metrics.md)）；
- **语音链路可用**：浏览器麦克风 → VAD → ASR → 对话 → TTS，打断判定实测 192ms；
- **重启不忘事**：会话、轮次、人格都在 SQLite，两个独立进程验证过；
- **摄像头在场检测可用（M6 最小版）**：帧差动 + YuNet 人脸确认，全在本机跑，状态写成 `presence.changed` 并投影到 `world_state`（带 TTL），离线回归在默认门禁里（`npm run test:perception`，项数看末行）；
- **Harness 可替换**：DSH 与直连 MiMo 两套实现共用 `BrainAdapter` 接口（实时走直连，见 ADR-0008）。

未实现：唤醒词（M2）、事件回放（M5）；**长期记忆与人格学习（M3/M4）已由 pack Phase 4 落地**（逐入口覆盖与权重口径见 `progress.md` §2.19）；主动开口的**机制**（主动性 V2）六条缺陷已修、经 t2 独立复验与 t3 评审 pass，但 **pack 更严的「连续两次没回应后继续主动 = 0」仍不成立**（实测是显著降频，「= 0 还是显著降频」待用户定口径，见 [`verification/t2`](verification/t2-timeline-independent-verification-2026-10-01.md)）；摄像头在场检测的**「真人站在镜头前被检出」这一步尚未实测**（摄像头朝天，见 [`design/perception.md` §8.3](design/perception.md)）。
⚠️ 现场设备验收结论已修正：扬声器按「能量比」口径只有 ~2.4 dB（<10 dB）→ **判 FAIL**（旧的 12.97 dB PASS 是帧级分位口径的乐观上界），见 [`recon/field-test-report-2026-09-30.md`](recon/field-test-report-2026-09-30.md) 顶部「口径变更说明」。

## 2. 五分钟自证（照抄即可）

```powershell
cd E:\worker2
npm install                    # workspace 链接 + js-yaml + dsh-tools（失败可挂代理 127.0.0.1:7890）
npm test                       # 期望：全绿，不联网（**项数以实跑末行为准**，别抄数字；最近实测点 2026-10-01 第四轮收口；耗时以实跑为准）
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
| 制品清洗（工具标记 / 英文推理） | ✅ 程序层已落地（`REPLY_HYGIENE`；沉默原因码 `ARTIFACT_ONLY_REPLY`）；⚠️ 订阅覆盖不齐：试用页与控制台已订阅 `onNotice`，`chat.ts` / `voice-turn.ts` 未订阅 | `npm test`（`tests/unit/core/engine-reply-hygiene.test.ts`）；缺口见 `progress.md` §4 第 10 条 |
| 人格可调并体现在行为 | ✅ 完成 | `eval:conversation:judge`（低/高话多组长度差 **2.57×**：22.3 字 vs 57.3 字，见 `docs/progress.md` §0） |
| 内置工具（四个：时间 / 天气 / 新闻桩 / 提醒桩） | ✅ 完成；四个 live 入口共用同一条工具链 | `node scripts/probe-tools.ts`；逐入口自证 `node <入口> --print-wiring`（离线，不调模型） |
| 直连 MiMo 实时路径（流式 + 工具循环） | ✅ 完成 | `npm run chat` |
| DSH Harness 路径（含 profile 与工具插件） | ✅ 完成（M0 验收） | `npm run verify:m0` / `npm run verify:provider` |
| 语音输入（浏览器采集 → VAD → ASR → 对话 → TTS） | ✅ 完成 | 页面按住🎤；或 POST `/api/voice`。**多段语音全部使用**（不再只取第一段），整段录音不落盘（`docs/field-test-report` 见下） |
| 现场测试控制台（一条命令 + 设备验收引导） | ✅ 完成 | `npm run field-test` → http://127.0.0.1:8792；离线自检 `node scripts/field-test.ts --self-test`（项数随回归断言增加，以其末行为准） |
| 语音闭环（文件驱动） | ✅ 完成 | `npm run voice:turn -- --wav tests/audio-fixtures/direct-question.wav`（输出里含 `segmentsUsed/droppedSegments`） |
| 打断判定（离线） | ✅ 完成（判定层面） | `npm run voice:bargein`（192ms） |
| 真实麦克风/扬声器/摄像头验收 | ⚠️ 口径修正后扬声器判 FAIL（2026-09-30） | `node scripts/field-test.ts --acceptance`：麦克风/摄像头通过，**扬声器按「能量比」口径只比噪声底高 ~2.4 dB（<10 dB）→ FAIL**（旧报告按帧级分位写 12.97 dB PASS，是乐观上界）。见 [`recon/field-test-report-2026-09-30.md`](recon/field-test-report-2026-09-30.md) 顶部的「口径变更说明」；改善路径：音量 ≥50%、麦克风离扬声器 0.3–1 m、采集增益设 0 dB 后重跑 |
| 扬声器真正静音的延迟（§33 P50<500ms） | ⛔ 未验收 | 需要设备 |
| 唤醒词 / 搭话判定（§13 完整版） | ⛔ 未实现（M2） | — |
| 长期记忆 / 纠正（§10，pack Phase 4） | ✅ 已落地；⚠️ 只有控制台与试用页写记忆/学习（`chat.ts` / `voice-turn.ts` 未接 `afterTurn`） | `npm test`（`tests/integration/memory-feedback.test.ts`）；逐入口与权重口径见 `progress.md` §2.19 |
| 主动开口（§15，主动性 V2） | ⚠️ 机制已落地；六条缺陷已修（第三轮 t1）、独立复验（t2）、评审 pass（t3）；**但 pack 更严的「连续两次没回应后继续主动 = 0」仍不成立**（实测是显著降频），「= 0 还是显著降频」待用户定口径 | 机制：硬底线（程序）+ 模型读空气（ADR-0011）——`npm test` 的门禁用例、`node scripts/eval-realism.ts` 的 G07/G12 用例可复跑。**达标口径**：generic 话题 **18.2%**（目标 ≤20%）、热聊接话 8 次。**判定与数字**：[`verification/t2-timeline-independent-verification-2026-10-01.md`](verification/t2-timeline-independent-verification-2026-10-01.md)（**不得写成「Phase 5 全通过」**） |
| 摄像头在场检测（§M6） | ✅ 最小可用（真人实测未做） | `npm run test:perception`（离线，含转发 Python 回归；项数看末行）；真机自检 `node scripts/verify-camera-presence.ts --seconds 15`；接口见 [`design/perception.md`](design/perception.md) §8.3（真人站镜头前那一步未完成） |
| 人格学习（§7.4，pack Phase 4） | ✅ 两条路都在跑：显式纠正（权重 1.0）+ 白名单推断码（权重 0.4，只乘一次）；⛔ 读模型自由文本做人格学习仍不做（铁律 5） | `npm test`（`tests/integration/memory-feedback.test.ts`、`tests/unit/feedback-interpreter.test.ts`）；管理员的 `overrideSelfProfile` 仍在 |
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

**做 M2 的唤醒与搭话判定**（当前最大功能缺口）。`onNotice` 那件事已经部分闭环——试用页（`serve-chat.ts`）与控制台
（`field-test.ts`）**已订阅**并显示「沉默原因」（`ARTIFACT_ONLY_REPLY` vs `MODEL_SILENCE`）；只剩 `scripts/chat.ts` 与
`scripts/voice-turn.ts` 没订阅（要不要补是小事，见 [`progress.md` §4 第 10 条](progress.md)）。
原始要求（评审给了两个选项）见 [`review/reply-hygiene-review-2026-10-01.md`](review/reply-hygiene-review-2026-10-01.md)。

**M2 为什么不能外包**：Pipecat 与 LiveKit 的 VAD/EOU 都无法区分电视与真人（电视 p=0.91~0.92 被判「说完」），
而「嗯。」这类 backchannel 两家都判错（Pipecat 甚至根本检不到）。

建议第一步（可在没有任何模型调用的情况下做完）：
1. 在 `packages/conversation` 里加一个**纯函数** `addressedProbability(signals)`：输入唤醒词分数、说话人相似度、会话状态、语义承接、音频方向/信噪比，输出 `P(addressed_to_xixi) ∈ [0,1]`；
2. 用 `tests/scenarios/corpus.ts` 的思路补一组**对抗语料**（电视/外人/自语 vs 直呼），先只做阈值判定与单元测试；
3. 唤醒词模型本身可用 openWakeWord 或 `E:\worker\models` 里已验证过的 sherpa-onnx KWS 路线（那套在本机跑通过），但**先定接口与判定逻辑**，再换具体模型。

同时记得：接入后要更新 `progress.md` §0/§1、`architecture.md` 的「未实现」列表、`design/conversation.md` 的判定小节。

## 7. 动代码前的检查清单

- [ ] 读过 `AGENTS.md` 的铁律（尤其：模型不能改规则/权限、主动行为在**硬底线**上必须过程序判定、事件是唯一事实来源）
- [ ] `npm test` 是绿的（**项数以实跑末行为准**，别抄数字；知道哪些用例覆盖你要改的地方）
- [ ] 新行为**先写测试**（离线可跑），真实 API 验证放 `scripts/verify-*` / `eval-*`，不进 `npm test`
- [ ] 不新增依赖，或新增时写清新 ADR 与理由
- [ ] 改完按 [`README.md` §3 更新触发条件](README.md) 同步文档
- [ ] 把「做了什么、怎么验证、下一步、已知问题」写进 [`progress.md`](progress.md)
