# 独立验证：多段回复与主动性硬门禁（2026-09-30）

> 最后更新：2026-09-30
> 验证人：verifier（与 t40/t41/t42 的实现者无关）
> 权威来源：本文件是本轮**独立复现**的原始记录。每条判定都来自我自己写的脚本/命令，不采信实现任务的回报文字。
> 中间的 JSON/日志在 `data/v43-*`（未提交，仅本机）。
> 三态：**通过** = 我亲自复现且结果与条款一致；**失败** = 复现出不一致；**未测** = 本轮条件下无法验证（写清原因与补测办法）。

## 0. 基线与方法

| 项 | 事实 |
|---|---|
| 起始修订 | `626d626`（+8 个在途改动文件），`npm test` = **189/189 exit 0**（25.3s） |
| 结束修订 | **`89e81e3`**（工作区除我的报告外**干净**，`git status` 只有 `?? docs/verification/...`），`npm test` = **192/192 exit 0**（25.4s） |
| 中途复核 | 验证期间有新提交陆续落地（`d85f1c6` → `89e81e3`）。我复核了 `89e81e3` 对 `config/xixi.example.yaml` 的改动是**纯注释**（新注释把「本段尚未被代码读取」改成「已被代码读取」，值一个没动），并在最终修订上重跑了两条 verify 命令 |
| 我的写入 | 只有 `docs/verification/`。**未改任何实现/测试/配置**（过程中 `git status` 里的 `M` 全是别人的在途编辑，收尾时已被提交） |
| 独立复现方式 | 自写 Node 脚本直调 `@xixi/conversation` 的公开 API（纯函数矩阵 + 真 SQLite 库上的引擎），自写 Python 脚本直调 `voice_edge.segment`；不跑实现者写的断言作为「证据」，只用 `npm test` 作门禁状态记录 |
| 真实调用 | **零**（本轮不需要：ASR/TTS/模型都没有参与验证；全是离线） |

## 1. 结论速览

| 验收条款 | 判定 | 通过/失败/未测的计数 |
|---|---|---|
| 1. 硬门禁逐条真的拦住 + 默认 proactivity 0.70（三处一致）与阈值 0.54 | **通过** | 门禁 27/27 通过；默认值四处一致；阈值公式 7 点验证 |
| 2. 重启不重复投递 + 事件日志独立复算额度 + 常驻 worker 不串味 | **通过** | 投递语义 4/4；日志复算 2/2；worker 隔离 2 组对照全等 |
| 3. 如实列出未测项与不确定结论 | **通过** | §7 列 6 条未测 + 2 条不确定 |

另有 **4 条非阻塞发现**（§8）：1 条文档不实（F1，low）、3 条信息级（F2/F3/F4，其中 F4 是我自己断言写错的自披露）。

---

## 2. 默认主动性与阈值（条款 1 的一半）

三处来源我都独立读取并比对：

| 来源 | 实测值 | 读取方式 |
|---|---|---|
| 代码常量 | `DEFAULT_PROACTIVITY = 0.7` | `import('@xixi/conversation').DEFAULT_PROACTIVITY` |
| 示例配置 | `personality.base.proactivity = 0.7` | 走**真实加载器** `loadConfig()`（`scripts/lib/harness.ts` 的 `configPath()`：私有配置 xixi.yaml 在本机不存在 → 回落到示例配置，我确认了这条回落分支） |
| ADR-0009 | 文本同时含 `0.70` 与 `0.54`，并写明公式与「先前写 0.55」的订正 | 直接读 `docs/adr/0009-proactive-triggers-and-hard-gates.md` |

阈值公式逐点验证（`proactiveThreshold`）：

| proactivity | 0 | 0.25 | 0.5 | 0.55 | **0.70** | 1.0 |
|---|---|---|---|---|---|---|
| 实测阈值 | 0.75 | 0.675 | 0.60 | 0.585 | **0.54** | 0.45 |
| `max(0.45, 0.45+0.30×(1−p))` | 0.75 | 0.675 | 0.60 | 0.585 | 0.54 | 0.45 |

→ **阈值确为 0.54，下限 0.45 成立，且 0.55 这个旧值对应的 0.585 仍可复现**（配置从 0.55 改到 0.70 的净效果可量化：门槛降 0.045）。

示例配置的其余门禁参数（我经加载器读到的原始值）：`base_cooldown_min 25`、`max_per_6h 4`、`max_per_day 8`、`topic_repeat_window_h 12`、`negative_feedback_cooldown_multiplier 2`、`quiet_hours 22:30–07:00`、`random_smalltalk false`、`reply {max_segments 3, segment_max_chars 60, gap_ms 450}`。

---

## 3. 硬门禁逐条实测（条款 1）

方法：先读 `evaluateProactiveGates` 的实现确认判定顺序与输入，然后用**我自己构造的 context** 逐条触发。
纯函数矩阵 27 条（每条只改一个字段），全部命中预期 reason_code：

| 门禁 | 触发条件（我构造的） | 实测 reason_code |
|---|---|---|
| 总开关 | `settings.enabled=false` | `DISABLED` |
| 触发源开关 | `triggers.topic_pool=false` | `TRIGGER_DISABLED` |
| 重复投递 | 历史里已有同 `candidateId` | `ALREADY_DELIVERED` |
| 免打扰 | `conversationState='SUSPENDED'` | `DND_ACTIVE` |
| 静默时段 | 本地 23:00 / 06:00 | `QUIET_HOURS`（两条都命中） |
| 静默边界 | 22:29 / 07:00（窗口外） | `PASSED`（两条都不误伤） |
| 冷却 | 上次投递 24 min 前（冷却 25） | `COOLDOWN_ACTIVE` |
| 冷却放行 | 上次投递 26 min 前 | `PASSED` |
| 6h 额度 | 6h 内已有 4 条（上限 4） | `QUOTA_6H_EXCEEDED` |
| 当日额度 | 当日 8 条、且任意 6h 窗口内仅 3 条 | `QUOTA_DAY_EXCEEDED` |
| 同主题抑制 | 同 `topicRef` 60 min 前投过（窗口 12h） | `TOPIC_REPEATED` |
| 同主题过期 | 同主题 13h 前投过 | `PASSED` |
| 最近有对话 | `LINGERING` / `inFlightTurn=true` | `CONVERSATION_ACTIVE`（两种触发都命中） |
| 置信度不足 | 分量全缺（score=0 < 0.54） | `SCORE_BELOW_THRESHOLD` |
| 场景不可用 | `sceneAvailable=false` | `SCENE_UNAVAILABLE` |
| 语音不可用 | `speechAvailable=false` | `SPEECH_UNAVAILABLE` |
| 全清 | 都满足 | `PASSED` |
| 负反馈·额度 | 倍率 2.0、6h 内已有 2 条（4/2=2） | `QUOTA_6H_EXCEEDED`（`floor(cap/2)` 算术成立） |
| 负反馈·冷却 | 倍率 2.0、上次 40 min 前（25×2=50） | `COOLDOWN_ACTIVE` |

**优先级（首个命中即返回）** 也实测过，与文档顺序一致：`QUIET_HOURS` 压过 `COOLDOWN_ACTIVE`；`DND_ACTIVE` 压过 `QUIET_HOURS`；`ALREADY_DELIVERED` 压过 `DND_ACTIVE`；`TRIGGER_DISABLED` 压过 `ALREADY_DELIVERED`；`QUOTA_6H_EXCEEDED` 压过 `TOPIC_REPEATED`。

**引擎级（不是纯函数）证据**：门禁拦下时**仍会落一条审计事件**（`speak:false` 且带 `reason_code`），而 `DISABLED` **不落**任何事件：

| 观察 | 实测 |
|---|---|
| 被拦时的事件 | `{"session_id":null,"candidate_id":"x2","trigger":"topic_pool","speak":false,"reason_code":"QUIET_HOURS","score":0.6,"threshold":0.54,...}` |
| `DISABLED` 时 | `event === null`，事件行数 0 → 0（关掉的轮询不会刷屏） |
| 事件类型 | 只有 `proactive.decision`（新类型的版本化 schema 生效） |

---

## 4. 一次性投递、重启、崩溃与额度复算（条款 2 前半）

全部在**真实 SQLite 库**上做（每次 `mkdtempSync` 一个新库，避免污染仓库 `data/`）。

| 场景 | 实测结果 |
|---|---|
| 首次通过并投递 | `delivered=true, speak=true, reason=PASSED`，`deliver` 回调**恰好 1 次** |
| **模拟重启**（同一库、新建 `ProactiveEngine`、同一 `candidateId` 再考虑） | `ALREADY_DELIVERED`，`delivered=false`，`deliver` 回调**仍是 1 次**；库里只多了一条「被拦」的 decision 行 |
| 冷却边界（引擎级） | 24 min → `COOLDOWN_ACTIVE`；26 min → `PASSED` |
| 6h 额度（引擎级，连续投递） | 第 1/2/3/4 次 `PASSED`（间隔 26 min），**第 5 次 `QUOTA_6H_EXCEEDED`** |
| **从事件日志独立复算额度** | 我用 `node:sqlite` 直接查 `events` 表：`event_type='proactive.decision'` 且 payload `speak=true`、且 `events.timestamp` 在 6h 窗口内 → **4 条 = 配置上限 4**，且与引擎拒绝的位置一致 |
| 同主题（引擎级、日志驱动） | 第 1 条 topic=weather 投递成功；+40 min 后同 topic 的新候选 → `TOPIC_REPEATED`；换成别的 topic → `PASSED` |
| **崩溃不重发**（关键安全属性） | 让 `deliver` 抛 `boom`：记录**已经在投递前写入**（先记后播）→ 异常抛出后，新建引擎再考虑同一候选得到 `ALREADY_DELIVERED`，`deliver` 从未被调用第二次。即「最多丢一条，绝不重发一条」成立 |

事件 payload 的完整键（证明只存 code 与分值，遵守铁律 5）：
`session_id, candidate_id, trigger, speak, reason_code, score, threshold, topic_ref, intent, delivered` —— 无用户原话、无模型推理。

---

## 5. 多段回复（M1–M9 与「只推进一次状态机」）

方法：用 `FakeBrainAdapter` 喂固定文本，经 `ConversationEngine.respond()` 走真实路径，同时挂 `onSegment` 与 `onTextChunk`，事件行数直接从库里数。

| 检查 | 实测 |
|---|---|
| 两个音频接缝互斥（ADR-0010） | 给了 `onSegment` 时 `onTextChunk` **一次都没被调用**（chunks=0，segments=2） |
| 段数与单段上限 | 85 字 → 2 段（44+41）；127 字 → 3 段（44/59/24），每段 ≤60 |
| **拼接不变式（不增删字符）** | `normalizeReplyText(join(segments)) === normalizeReplyText(全文)` → 85 字与 127 字两种长度都**成立** |
| 段间间隔 | `turn.segmentGapMs = 450`（= 示例配置 gap_ms），`turn.segments.length` 与实际回调次数一致 |
| **状态机只推进一次** | 该轮事件日志恰好 `conversation.turn`(user) + `conversation.turn`(assistant) + `conversation.decision`，**共 3 行、1 条 decision**（不是每段一条） |
| 全文一条记录 | assistant 记录里存的是**整条回复**（85 字），不是拼接后的分段 |
| **LINGERING 从最后一段起算** | 在每段回调**内部**读 `engine.state` 都是 `ACTIVE`；全部播完后 `engine.state === 'LINGERING'` |
| 短回复 | 「嗯，我在。」→ 1 段 |
| **超限时的确定取舍** | 230 字 → 3 段（46/46/**138**），`splitReplyIntoSegments` 返回 `mergedOverflow=true`，且**字符一个不丢**（与 ADR-0010「不丢字优先」一致；代价是第 3 段超过 60 字上限） |
| **M9 部分失败** | 第 2 段抛 `tts-failed`：异常**传播给调用方**、第 3 段**未执行**（called=2）、该轮**仍然收尾**（`engine.state === 'LINGERING'`）、assistant 记录**仍只有 1 条** |

---

## 6. 常驻 Python worker 的状态隔离（条款 2 后半）

先澄清事实（这也是一条发现，见 F1）：常驻 worker 实现在 `scripts/verify-voice-noise.ts` 里（内联 Python 程序 `VAD_WORKER_PY`，运行时写到 OS 临时目录，按 stdin JSON 行调用**真实 CLI 入口** `voice_edge.segment.main(argv)`）；`tests/unit/voice/frontend.test.ts` 里**没有任何 worker**（该文件用的是「并发 + 记忆化」的多次 `spawn`）。

**(a) 我自己的进程内顺序实验**（直调 `voice_edge.segment.segment()`，与 worker 同一代码路径）：

| 对照 | 差异 |
|---|---|
| 同一夹具**单独**跑 vs 在「响噪声夹具 + 干净夹具」**之后**跑（同一进程） | 除 `frontend.conditioningMs`（234.7 vs 96.8 ms，纯墙钟预热差异）外**全部语义字段相同** |
| 同一夹具在同一进程里**第一个**跑 vs **最后一个**跑（中间夹两个别的夹具） | 除 `conditioningMs`（132.6 vs 85.9 ms）外**全部相同** |

→ **夹具之间没有状态串味**：分段结果（`segments/events/energyStartMs/energyEndMs`）与前端参数（门限、噪声底）逐字节一致，差异只出现在计时字段。

**(b) 生产路径对照**（同一条命令，只切 worker 开关）：

| 路径 | 命令 | 8 条夹具的语义差异 | 墙钟 |
|---|---|---|---|
| 常驻 worker | `--fake --tiers 3` | — | 20.5s |
| 一次性子进程 | `--fake --tiers 3 --no-vad-worker` | **0 处差异** | 21.8s |

两条路径的每条夹具结果（`detected/speechStartMs/speechEndMs/gateThresholdDbfs/noiseFloorDbfs/frontend`）完全一致 → worker 与一次性路径**等价**（这就是 t47 声称的保真性）。

---

## 7. 未测项与不确定结论

**未测（本轮条件不满足，给出补测办法）**

| ID | 未测事项 | 原因 | 补测办法 |
|---|---|---|---|
| U1 | 真实环境下的**打扰度**与长时间静置的**真实触发频率** | 需要真人、真实时长（小时级）与真实候选生成器；本轮全是合成候选与固定时钟 | 跑一次真人会话后 `npm run turns -- data/chat/xixi.sqlite 20` 数 `proactive.decision` 的 `speak:true` 与时间间隔 |
| U2 | §15.4 十一项分量的**真实取值**是否合理 | 我只验证了评分算术与阈值比较，没有用真实传感器/记忆数据生成候选 | 真实跑一天后统计候选分数的分布（现在只能证明它落在 [0,1] 且等权 0.1） |
| U3 | 450 ms 段间停顿的**听感**是否自然 | 需要人耳 | `npm run field-test` 点一次主动演练听一遍 |
| U4 | 真实 ASR/TTS 链路上的多段端到端 | 我用的是 `FakeBrainAdapter`（离线确定） | `npm run chat -- --fake` 已能打印分段；真人跑到 TTS 才算端到端 |
| U5 | 控制台页面里主动卡/旋钮的**显示正确性**（t42 的实现） | 不在本任务验收范围 | 见 t42 的真机复验；我可另行复核 |
| U6 | worker **长时间运行**、大文件、并发下的内存与状态 | 我只测了 2–4 条夹具的顺序调用 | 用 `--tiers` 全档跑一轮并观察 RSS |

**不确定结论**

- C1：我的进程内隔离实验调用的是 `segment()` 函数而不是 worker 用的 `main(argv)` 入口（两者共用同一前端与 VAD 代码）。生产路径对照（0 差异）与它互为佐证，但严格说「worker 进程内的长期状态」只覆盖了顺序调用的情形。
- C2：`npm test` 的项数与耗时随在途编辑变化（本轮 189/189 → 192/192，25.3s → 37.5s）。本报告的判定绑定 §0 记录的两个修订，不把「全绿」推广到之后的状态。

---

## 8. 发现（不含阻塞项）

### F1（low，文档不实）：「常驻 worker 让 frontend.test.ts 从 ~21s 降到 ~7s」不成立

- **实测**：`node --test tests/unit/voice/frontend.test.ts` → 14/14 通过、exit 0、**墙钟 10.1s**（duration_ms 9954）；该文件里 `worker|persistent|resident|XIXI_VAD_ONESHOT` **命中 0 次**。
- **归因**：标注为 t47 的提交 `d38b4ba` 只改了 `AGENTS.md` 与 `docs/design/security-and-privacy.md`（`git show --stat`），**没有代码改动**；该文件真正的优化是「并发 + 记忆化 spawn」（文件内注释自述「让三次检查付最大值而不是总和」）。真正的常驻 worker 在 `scripts/verify-voice-noise.ts`。
- **影响**：接手者按 `AGENTS.md` §7/§9.9 与 `docs/testing.md` 的说明去找「frontend.test.ts 的 worker」会找不到，且「约 7s」这个数字无法复现（差 3s）。**建议**：把措辞改成「并发 spawn（frontend.test.ts）」与「常驻 worker（verify-voice-noise.ts）」两件事分开写，数字改成实跑值或删掉。

### F2（info）：`mergedOverflow` 在引擎边界丢失

- `splitReplyIntoSegments()` 会返回 `mergedOverflow=true`（230 字用例实测），但 `ConversationTurn` 的键里**没有**该字段（实测 keys：`accepted, reason, state, action, text, segments, segmentGapMs, provider, model, latencyMs, firstTokenMs, prompt`）。
- **影响**：调用方（控制台/日志）无法直接知道「第 3 段是合并溢出、已超过单段上限」，只能自己重算长度。行为本身符合 ADR 的取舍，属可观测性缺口。**建议**：把该标志一并放进 turn（或写进 decision 事件），一条字段的事。

### F3（info）：worker 的提速在夹具数少时看不出来

- 同一档位 8 条夹具：worker 20.5s vs 一次性 21.8s（差 1.3s）。省下的是「每条夹具一次解释器启动」，夹具少时被固定开销淹没。不是缺陷，但别用它来宣称「快一倍」。

### F4（info，自我披露）：我第一版 harness 有三处断言常数写错

- ① 6h/当日额度：我把 8 条历史都放在 6h 内，于是 `QUOTA_6H_EXCEEDED` 合法地先命中，我却期望 `QUOTA_DAY_EXCEEDED`；② 崩溃用例的 `deliverCalls` 我按 3 写，实际抛错的回调不会自增，正确值是 2；③ 复算额度时我读了 payload 里的 `created_at`（不存在），应读 `events.timestamp`。
- 三处都是**我的**问题，产品行为全部正确；已修正并复测（§3/§4 的表格是修正后的结果）。写在这里是为了让下游知道哪几行曾经红过、为什么。

---

## 9. 复现命令

```powershell
cd E:\worker2
# 门禁与默认值（我自写的 harness，输出 JSON 到 data/v43-proactive.out）
#   node --input-type=module  <<< v43-proactive.mjs 的内容（TEMP 文件，见本报告 §3/§4 的断言清单）
# 多段回复
#   node --input-type=module  <<< v43-segments.mjs 的内容
npm test                       # 结束修订 d85f1c6：192/192 exit 0
npm run check:docs             # 57 份 markdown，0 问题，exit 0
# worker 与一次性路径对照（离线，不花钱）
node scripts/verify-voice-noise.ts --fake --tiers 3 --out data\v43-vad-worker.json
node scripts/verify-voice-noise.ts --fake --tiers 3 --no-vad-worker --out data\v43-vad-oneshot.json
# 该文件是否真的用了 worker（预期为空）
git grep -n "worker" -- tests/unit/voice/frontend.test.ts
```

## 维护规则

- 本文件是**带日期的历史记录**（docs/verification 层）：新的验证写新的 `*-verification-YYYY-MM-DD.md`，不要改写本文判定。
- 判定绑定 §0 的两个修订；`packages/`、`config/xixi.example.yaml`、`scripts/verify-voice-noise.ts` 之后再变，本文的门禁/分段/worker 结论需要重新验证。
- 发现项由 captain 决定归属与修复；修完应在**下一个**验证任务里复核，而不是把本文的「未测/发现」直接改成「通过」。

---

> **V0.3 旁注（2026-10-04，t16）**：本报告里与 v03-preflight 九项相关的问题**已在 V0.3 P0-E2 批次清掉**（`resetMood` 时间戳归一、
> `moodBias` 注释与公式一致、`onNotice` 覆盖三入口、`proactiveSettingsToConfig` 回写、只读 GET 不写库、`runJob` 逐步隔离、
> agent-loop 的 `now` 每次调用各读一次、`serve-chat` 信号收尾、`conversation` 索引导出登记）。**上文按当时的事实保留，不改写结论。**
