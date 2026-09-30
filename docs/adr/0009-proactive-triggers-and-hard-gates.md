# ADR-0009：主动行为的触发源与硬门禁（更激进，但安全底线不动）

- 状态：已接受（2026-09-30）
- 相关：方案 §2.3 / §15 / §16、[ADR-0003](0003-raw-events-vs-memory.md)、[ADR-0005](0005-brain-session-mapping-in-domain.md)、[docs/design/conversation.md](../design/conversation.md)、`config/xixi.example.yaml`
- 归属：**M5**。本 ADR 定义契约与默认值；**程序侧已按它落地**（订正 2026-09-30）：`packages/conversation/src/proactive.ts`
  的 `ProactiveEngine` 逐条过第 3 条的九门禁、算第 4 条的分数与阈值、落第 6 条的 `proactive.decision` 审计，
  `config.proactive` 段已被读取。**仍未落地的两半**：候选生成器（第 2 条的事实输入还没有生产者）与内容生成
  （`packages/brain-adapter` 的 `evaluateProactiveCandidate` 仍抛 `NOT_IMPLEMENTED(M5)`）。

## Decision

1. **两步走，第一步永远不是模型**（方案 §15.1）：事件 → 候选（程序算分）→ **硬门禁（程序判定）** → 只有通过门禁才调用模型回答「说什么」。
   模型的结构化输出仍沿用既有接缝 `ProactiveDecision`（`speak` / `intent` / `topicRef` / `length` / `tone` / `askQuestion` / `reasonCode`，见 `packages/brain-adapter/src/types.ts`）。
2. **触发源（候选来源）按 §16 的优先级排序，且全部由程序从事实产生**：

   | 优先级 | 触发源 `trigger` | 事实输入（不是模型输出） |
   |---|---|---|
   | 1 | `future_hook_due` | FutureHook 到期（M4 落地后；未到期不产生候选） |
   | 2 | `presence_arrived` | `presence.changed` 的「无人 → 有人」跃迁（M6 事件） |
   | 3 | `conversation_dangling` | 上一轮对话未完话题（工作记忆 + 未答问题） |
   | 4 | `routine_expected` | 作息预期命中（例如平常起床时间已过且仍无对话） |
   | 5 | `topic_pool` | 兴趣/生活上下文、天气工具结果（只读） |
   | 6 | `random_smalltalk` | 无事实依据的寒暄，**默认关闭**（§16「没有合适的话题，就不要为了主动而主动」） |

3. **九个硬门禁**：任一命中即 `speak=false`，**不调用模型**，并记下 `reason_code`。

   | 门禁 | 判定输入 | 触发条件（可测） | `reason_code` |
   |---|---|---|---|
   | 用户 DND | FSM 状态 | `state == SUSPENDED`（`/quiet` 或「今天安静点」） | `DND_ACTIVE` |
   | 静默时段 | 本地时区时钟 + 配置 | 本地时间落在 `[quiet_hours.start, quiet_hours.end)`（跨午夜区间） | `QUIET_HOURS` |
   | 冷却 | 上次**已发出**的主动行为时间 | `now - lastProactiveAt < base_cooldown_min × multiplier` | `COOLDOWN_ACTIVE` |
   | 6 小时额度 | 事件日志（已发出的主动行为） | 滑动 6 小时窗口内计数 `>= max_per_6h` | `QUOTA_6H_EXCEEDED` |
   | 当日额度 | 事件日志 + 本地自然日 | 本地当天计数 `>= max_per_day` | `QUOTA_DAY_EXCEEDED` |
   | 同主题重复 | 已发出主动行为的 `topic_ref` | 同一 `topic_ref` 在 `topic_repeat_window_h` 内已主动说过 | `TOPIC_REPEATED` |
   | 对话冲突 | FSM 状态 + 在途轮次 | `state != IDLE`，或该会话有一轮尚未结束 | `CONVERSATION_ACTIVE` |
   | 置信度不足 | 候选分数 | `score < threshold`（见第 4 条） | `SCORE_BELOW_THRESHOLD` |
   | 场景/设备不可用 | 媒体/通话状态、TTS/ASR 可用性 | 正在播放媒体或通话；或语音出口不可用 | `SCENE_UNAVAILABLE` / `SPEECH_UNAVAILABLE` |

4. **`proactivity` 只改阈值，不改分数**（§15.4）：候选分数由程序按 §15.4 的结构计算并把各分量夹在 `[0,1]`、
   加权求和后整体夹在 `[0,1]`（PoC 权重取等权 `0.1`，作为程序常量记在本 ADR，不进配置）。
   阈值：

   ```text
   threshold = 0.45 + 0.30 × (1 - proactivity)      // proactivity=0.85（默认基线）→ 0.495
   ```

   即 `proactivity` 越高阈值越低（更愿意开口），但**永远不可能低于 0.45**——分数与阈值都夹在 `[0,1]` 内，
   「更激进」只体现在门禁参数（第 5 条），不体现在「跳过门禁」。
   默认基线取 **0.85**（订正 2026-09-30，第三次调整：0.55 → 0.70 → 0.85），对应阈值
   `0.45 + 0.30 × (1 − 0.85) = 0.45 + 0.30 × 0.15 = 0.495`；`config/xixi.example.yaml` 与
   `packages/conversation/src/proactive.ts` 的 `DEFAULT_PROACTIVITY` 必须与这个数一致（两者相等由测试钉住）。
5. **默认强度：更激进，但底线不动**（与 `config/xixi.example.yaml` 逐项一致）：

   | 配置项 | M0 旧默认 | 出厂默认 | 说明 |
   |---|---|---|---|
   | `base_cooldown_min` | 60（`cooldown_min`） | **5** | 两次主动之间的最短间隔（再乘负面反馈倍率） |
   | `max_per_6h` | 2 | **15** | 6 小时滑动窗口上限 |
   | `max_per_day` | 5 | **40** | 本地自然日上限 |
   | `topic_repeat_window_h` | 无 | **2** | 同主题抑制窗口（§15.6 建议 24；出厂取「话痨」档，只压 2 小时内的重复） |
   | `negative_feedback_cooldown_multiplier` | 无 | **2.0** | 最近一次主动被负面反馈后，冷却与额度按此倍率收紧 |
   | `quiet_hours` | 22:30–07:00 | **23:30–07:30** | **安全底线**：人格、模型、学习都不能放宽它。本轮只把它**缩短**（仍是一个真实的静默窗口，不是空窗口）；《方案》§2.3 的这条底线语义不变 |
   | `triggers.*` | 无 | 见第 2 条（`random_smalltalk: false`） | 逐个触发源的开关，默认关掉纯寒暄 |

   **订正 2026-09-30（第三次调整，方向仍是「更愿意开口」）**：上表四行从 12 / 8 / 20 / 6 再放宽到
   **5 / 15 / 40 / 2**，`quiet_hours` 从 22:30–07:00 缩到 **23:30–07:30**，均与 `config/xixi.example.yaml`
   逐项一致（核对：`git grep -n "base_cooldown_min\|max_per_6h\|max_per_day\|topic_repeat_window_h\|23:30" -- config`）。
   负面反馈倍率**不动**——额度放宽不是放宽底线。
   代码里的兜底常量 `DEFAULT_PROACTIVE_SETTINGS`（`packages/conversation/src/proactive.ts`，只在配置缺
   `proactive` 段时生效）**已与上表同步为同一档**：两者相等由测试用手写示例对象钉住（t76 修掉了它一度
   落后于示例配置的问题）。

6. **审计**：候选与每次门禁判定都要能回答「为什么没说」。方向沿用铁律 5——只存 `reason_code` 与分值，
   不存模型私有推理（`ProactiveDecision.reasonCode` 已经是这个形状）。审计用**新的事件类型**
   `proactive.decision`（已实现，v1）：按版本规则**新增一个 v1 schema 文件**，并在 `EVENT_TYPES`
   注册表与信封 `event_type` 枚举里同步登记。
   **新增类型不需要升 `SCHEMA_VERSION`**：`schema_version` 与 `payloadVersion` 都保持 **1**——只有
   **改已发布 payload 的形状**才升版（铁律 10：「新增」与「就地改」是两件事）。同样不得给已发布的事件类型
   就地加字段。（订正 2026-09-30：原文写「并升 `SCHEMA_VERSION`」，实现按上面的规则做，只有 payload 形状变更才升。）

## Context

- 方案 §2.3 列出的硬门禁（静默时间 / DND / 冷却 / 当日额度 / 重复话题 / 对话冲突 / 置信度 / 高打扰场景）
  与 §15.3 的十条是同一件事的两种粒度；本 ADR 把它们合并成第 3 条的九行表，每行给出**判定输入**与**边界条件**，
  这样每个门禁都能写一条边界单测（临界值两侧各一例）。
- 现状（订正 2026-09-30）：**门禁与投递已落地**——`packages/conversation/src/proactive.ts` 按固定顺序判定九门禁
  （命中即返回首个 `reason_code`）、算分数与阈值、每次判定落一条 `proactive.decision`，并在**投递之前**先写
  `delivered: true`（崩溃丢一条、不重发一条；重启后靠同 `candidate_id` 的 `ALREADY_DELIVERED` 拦住重复投递）。
  `config.proactive` 段已被读取（`parseProactiveSettings`）。其中 `proactivity` 的出厂值与代码常量的一致性由测试钉住
  （`tests/console/proactive-console.test.ts` 的 `engine default and config/xixi.example.yaml must agree`，即
  `DEFAULT_PROACTIVITY`）；第 5 条那张表是**出厂配置**口径，代码兜底常量 `DEFAULT_PROACTIVE_SETTINGS` 的同步状态见该节订正说明。
  **仍未落地**：候选生成器（第 2 条的事实输入还没有生产者）与内容生成
  （`evaluateProactiveCandidate` 仍抛 `NOT_IMPLEMENTED(M5)`）。
- 为什么现在就要定默认值：`proactive` 段已经在示例配置里存在且写着 `enabled: true`，
  不把「多激进」写清，实现者只能自己发明参数——这正是「配置承诺了不存在的行为」的老问题。

## 为什么硬门禁必须由程序判定，而不是问模型「你觉得现在该说吗」

1. **铁律 1 与铁律 3**：规则、状态与边界是程序的责任；主动行为必须先过确定性硬门禁，LLM 不能绕过。
2. **模型会被说服**：电视里的广告、外部内容（§53 视为不可信数据）都能进入上下文。门禁若依赖模型自述，
   就等于把「今天安静点」的否决权交给一个可被诱导的组件。
3. **必须可复现**：同一份事件日志 + 同一个时钟应当给出同一个判定（§22.3 回放）。
   模型输出带采样温度，无法作为门禁依据。
4. **必须在模型之前**：门禁放在模型**之后**过滤，等于每次都先花一次调用与几百毫秒，再把它扔掉；
   而且模型在前一步已经「决定要说话」，后面的过滤会变成对模型输出的修补。
5. **可审计**：`reason_code` 是给用户看的解释（「为什么今天西西没来找我说话」），程序判定才写得准。

## Alternatives

- **让模型判断该不该主动（方案 §39.2 明确禁止）**：不可复现、可被注入、且无法解释。
- **只调 `SelfModel.proactivity`，不加额度与冷却**：人格一高就会唠叨；额度与冷却是「不打扰」的兜底，不是可选项。
- **把门禁做在模型输出之后（post-filter）**：浪费一次调用，且模型已经基于「我要说话」生成了内容。
- **本轮就把 ProactiveEngine 实现掉**：违反铁律 11（不实现多个里程碑）；本任务只产出契约与默认值。
  （订正 2026-09-30：后续单独一轮已把**程序侧**实现掉——门禁、分数与阈值、审计与投递，见归属段；
  本条只记录当时为什么没做。）

## Consequences

- **已落地**（2026-09-30 订正）：九门禁判定、分数与阈值计算、`proactive.decision` 事件类型，以及每个门禁的
  边界单测（临界值两侧各一例）与「门禁命中时**不调用模型**」的断言——见 `tests/unit/core/proactive-gates.test.ts`
  与 `tests/integration/proactive-engine.test.ts`（含重启不重发的断言）。
- **仍需新增**：候选生成器（按第 2 条的事实输入）、考虑循环的常驻调用方，以及模型侧的内容生成。
- 示例配置的 `proactive` 段已从「没人读的声明」变成**被读取的配置**（`parseProactiveSettings`）；
  改本 ADR 第 5 条的参数时必须同步改 `config/xixi.example.yaml`，否则两边会不一致。
- 「更激进」的代价是更频繁的打扰；兜底是 6 小时/当日额度与负面反馈倍率，以及不动 `quiet_hours` 这条底线。
- `docs/design/conversation.md` §6 的「主动开口（§15）无代码」一行已按落地情况改写（程序侧已落地、内容侧未落地）；
  本 ADR 是那次实现的依据。
