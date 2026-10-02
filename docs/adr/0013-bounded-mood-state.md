# ADR-0013：有界的心情状态（程序层的短期情绪，散文注入，权重远小于人格）

- 状态：已采纳（2026-10-01，第五轮 t4）
- 相关：铁律 1（规则与状态由程序负责）、铁律 3（硬底线由程序判定）、铁律 5（只存 reason_code 与分数）、
  [ADR-0011](0011-proactive-decision-ownership.md)、`xixi_v02_refactor_pack` §23（不做的事）、
  `packages/domain/src/mood.ts`、`packages/domain/src/mood-engine.ts`、`packages/domain/src/migrations/005_mood.sql`

## 背景

用户 2026-10-01 的诉求是「像人一样，**可以有自己的性格感情但不极端**」。人格三层（基础 / 学习 /
会话覆盖）已经在库（[`docs/adr/0003`](0003-raw-events-vs-memory.md) 与 pack Phase 4），缺的是**短期情绪**：

* 人格是「她是谁」，按天、按周缓慢变化，被父亲用自然语言塑造（§7.4 的上限与回滚都在 `self-model.ts`）；
* 一次夸奖、一次被嫌、一整天没人应，都会**立刻**改变一个人说话的口气 —— 这既不是人格，也不该写进人格。

pack §23 同时划了两条线，这条 ADR 必须同时满足：

> * 不要把所有情绪数值暴露给 prompt；
> * 为「真人」故意制造欺骗性的虚构人生 —— 西西可以对现实事件有情绪，但**不能编造「我今天出去买菜了」**。

## 决定

### 1. 心情是一个**两维、有界、会回落**的状态，且写入路径只有一条

```text
state = { valence: 0..1, energy: 0..1 }          // 好不好 / 有没有劲
每一次变化： next = clamp(prev + delta)          // clamp 只有一个（mood.ts 的 clampMoodValue）
```

**上下界的证明不是「试了很多次都没越界」，而是结构性的**：`clampMoodValue` 的值域是 `[0,1]`，
与输入无关；心情的**每一条**写入路径（信号、回落、时段牵引）都返回它的结果，所以
「`prev ∈ [0,1]` ⇒ `next ∈ [0,1]`」对任意步数归纳成立。`tests/unit/domain.test.ts` 把这个归纳逐格跑出来：
单步（每个信号 × 每个角点）、连续极端（同一个极端信号 1000 次、反方向 1000 次、所有信号轮换 1000 次）、
坏输入（`NaN` / `±Infinity` / 负的经过时间 / 超大的牵引率）、以及「信号 + 回落 + 时段」交替 500 步。
`NaN` 是**坏输入**而不是「大数」：它会让之后每一次比较都为假（状态永久坏死），所以退回中性。

### 2. 由**可核对的事件**演化，信号是封闭的一小撮

| 信号 | 触发 | 偏移（valence / energy） |
|---|---|---|
| `praised` / `blamed` / `rejected` | 用户这一轮的话（拒绝 > 嫌弃 > 夸奖；普通聊天与长期指令都不是信号） | +0.06/+0.02、−0.08/−0.02、−0.1/−0.03 |
| `missed` / `answered` | 一次主动开口之后 30 分钟内有没有人回话 | −0.05/−0.01、+0.04/+0.02 |
| `arrived` | `presence.changed` 里 `present=true` | +0.02/+0.05 |
| `quiet` | 连续 6 小时既没有用户轮次也没有人在场 | 0/−0.03 |
| `time_passed` | 心情自然回落（偏移为 0，只留证据） | 0/0 |

信号全部从**原始事件**算出来（`conversation.turn` / `proactive.decision` / `presence.changed`），
不存模型私有推理（铁律 5），也不需要新的 `event_type`：契约的枚举是已发布的（铁律 10），
而心情可以从上面三类事件按确定性规则重放。表见迁移 `005_mood.sql`（`mood_state` 当前行 +
`mood_history` 变更记录）。

### 3. 数值与语义分层：模型只看散文，程序才看数字

* 模型看的是 `moodProse()` 渲染的两段：**状态描述**（「有点提不起劲，精神还可以。」）与
  **语气指引**（「话少一点、慢一点……），末尾恒定带一句边界：
  「这只是你此刻的情绪，只影响你说话的样子：不要因此说出你没做过的事，也不要描述身体上的感觉。」
  —— 这一句就是 pack §23 那句「不能编造「我今天出去买菜了」」的可执行版本。
* 提示词里**不出现任何数字或参数名**（`tests/unit/prompt.test.ts` 逐条钉住：无 `\d`、无 `valence|energy`、
  无编造经历的句式）。数值挂在 `AssembledPrompt.sections[].debug` 上给面板与评审核对
  （§22.2：面板要能说出「模型看到了什么」），它不拼进 `system`。
* 区间边界只有一份（`MOOD_BAND_THRESHOLDS`），散文只认区间，所以「什么时候算心情好」不会长出第二套数。

### 4. 影响**轻微**、且**永远不碰硬底线**（这条是铁律 3 的可核对版本）

| 去处 | 幅度 | 与人格的关系 |
|---|---|---|
| 语气（提示词里的散文） | 措辞切换 | 人格的 `personalityDirectives` 是主体，心情只加一段 |
| 对话窗口（`silence_tolerance` 的缩放） | **±6%** | 人格那侧的倍率是 `0.5..1.5`（±50%）：心情**乘**在人格算出来的窗口上 |
| 主动性的软偏移（`moodProactivityNudge`） | **±0.03** | 刻意取 §7.4「隐式反馈单次最多 ±0.03」：心情的整幅影响力不超过人格能学习到的**最小一步** |

硬底线（静默时段 / 当日与 6 小时额度 / DND / 隐私与同意 / 场景与音频路径）在 `proactive.ts` 的
`evaluateProactiveGates` 里判定，**在评分之前就返回**，那条代码路径**拿不到**心情 —— 所以「心情不好就不
回话」在这套设计里不是「被禁止」，而是**没有入口**。`tests/integration/mood-state.test.ts` 用同一份门禁输入在
心情高低两种情况下断言 `reasonCode` 完全相同来钉住这一点。

「她今天为什么这么说话」由 `mood_history` 回答（每条变更带时间、before/after、信号计数与中文摘要），
可以与 `conversation.decision` 按时间对齐。**没有**把心情写进 `conversation.decision`：那个 payload 是
`additionalProperties: false` 的已发布契约，加字段要动
`packages/contracts/schemas/events/conversation.decision.v1.json` —— 本任务的 inScope 不含契约目录，
所以这条留给「心情接主动引擎软评分」的那一轮一起做（见「尚未实现」）。

### 5. 可查看、可复位、可回滚

* 查看：`XixiStore.mood()`（当前行）、`moodHistory(limit)`（变更记录，含 before/after/delta/信号计数/摘要）、
  `moodSnapshot()`（游标 + 当前行 + 历史的**只读一致视图**）、`moodSchemaVersion()`（铁律 10）；
  会话层另有 `ConversationEngine.moodStatus()`（含 `prose`，即进提示词的那几句话）。
* 复位：`XixiStore.resetMood(reason)` 回到中性，**并留一行 `reset=true` 的历史** ——
  「她为什么突然平静了」必须能从数据回答，所以复位不是「删掉那行」。
* 回滚的粒度是**单条变更**：`mood_history` 存了每一步的 before/after，可以逐条核对与重放。

### 6. 幂等与「什么时候结算」的规则（实测换来的三条）

心情每一拍读事件日志。这里踩过三个坑，写下来免得后来者重踩：

1. **去重看事件序号，不看时间**：`respond()` 先落这一轮、再评估心情，两者常常是**同一个时刻**，
   所以「严格晚于上次评估」会把这一轮漏掉（现象：用户夸了西西，提示词里还是旧心情），
   而放宽成「不早于」又会重复吸收。游标是 `events.sequence`（`mood_state.cursor_json`）。
2. **一次主动开口要等答案窗口关掉才结算**：否则它先被记成 `missed`（窗口内暂时没人回），
   等真有人回时游标已经过去，`answered` 永远补不上（本机实测）。
3. **游标只推进到「连续结算前缀」的末尾**：事件类型不同、结算条件不同，直接取「这一拍碰到的最大序号」
   会让那条还挂着的主动记录被永久跳过（本机实测：21:30 的主动开口在 21:32 被跳过、22:05 再也补不出来）。
   `#settleCursor` 因此把「这一拍结算了哪些」与「游标能到哪儿」分开算。

「同一时刻重复评估」是幂等的（集成用例断言第二次 `signals.length === 0` 且状态不变）。
「家里一直没人」是**当前观察**而不是历史事件，所以它不进序号游标，只以「距上次评估真的过了时间」为条件。

## 后果

* **可以放心用的**：心情有界（结构性证明 + 探针）、短暂（按小时回落，半衰期约 9 小时）、可审计、可复位；
  它进提示词的是散文；它对语气与窗口的影响有上限（±6%）与人格的关系（乘在人格之上）；
  它对主动性的影响力（±0.03）小于人格的单步学习量；硬底线拿不到它。
* **不保证**：心情**不会**让她的回答更「像人」到某个程度 —— 那要靠 `eval-realism` 这类测量，
  心情只是给模型一个可解释的语气上下文。也不保证心情一定与「事件的情绪色彩」一致：
  `classifyMoodSignal` 是模式匹配（拒绝 > 嫌弃 > 夸奖），认不出来就**不是信号**（普通聊天不该推动情绪）。
* **尚未实现、不得写成已实现**：
  1. **控制台面板**（只读展示心情、一键复位）不在本轮范围，是下一轮候选；本轮只有领域接口
     （`mood()` / `moodHistory()` / `moodSnapshot()` / `resetMood()`）与引擎的 `moodStatus()`。
  2. **心情没有接进主动引擎的评分**：`proactive.ts` 的软评分不读心情；`moodProactivityNudge()` 是
     给下游调的**有界偏移**，本轮唯一真实的去处是对话窗口（`lingerMs` 的 ±6%）与它自己的历史记录。
     接软评分属于另一个任务（它要动 `proactive.ts`，且必须证明硬底线仍然在前）。
  3. **心情没有写进 `conversation.decision`**：要动契约 schema（该 payload 是
     `additionalProperties: false`），而本任务的 inScope 不含 `packages/contracts/`。审计走
     `mood_history`（可与判定事件按时间对齐）。
  4. **没有真实模型上的 A/B**：本轮的全部证据是离线探针与集成用例，不含真人观感。

## 复现命令（原样可跑，离线）

```powershell
node --test tests/unit/domain.test.ts
node --test tests/integration/mood-state.test.ts
node --test tests/unit/prompt.test.ts
git grep -n "moodBand\|MOOD_SIGNALS\|MOOD_TONE_SPAN" -- packages/domain/src/mood.ts packages/domain/src/mood-engine.ts
```

第五轮 t4 实测（基线 `279dff6`，未提交、产物在工作区）：`npm test` 449 项 pass 449 fail 0（exit 0）；
`npm run check:docs` 95 份 exit 0。

（引用代码位置一律用函数名 + `git grep`，不写行号；口径与数字以实跑输出为准。）
