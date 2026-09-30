# 评审：回复卫生（标记与英文思维链）与「只剩制品→沉默」的用户可见性（t12 / round 1）

> 最后更新：2026-10-01
> 评审人：reviewer（第二双眼睛；评审对象是别的成员做的 t7，我自己构造夹具独立复跑）
> 评审对象：`t7` 的已提交产物 **`8ef37f5`**（"t7 完成：工具调用标记与英文思维链不再进正文"），
> 判读时 HEAD 就是 `8ef37f5`，`git status --porcelain` 只有一条 `?? xixi_v02_refactor_pack/`（与本任务无关）——
> **我核的是已提交版本，不是工作区半成品**。
> 评审方式：**不用 t7 自己的测试夹具、也不调它的测试辅助函数**——我自己造夹具、自己列「内部字样」清单，
> 只经公开面（`createSpokenTextFilter` / `sanitizeSpokenReply` / `MimoBrainAdapter.handleUserTurn` /
> `ConversationEngine.respond`）跑，并在四个出口上查泄漏：delta（`onTextChunk`）、分段（`onSegment`）、
> 交付文本（`turn.text`）、落库（`store.recentTurns()`）。
> 复现方式：本报告 §5 给出可复制粘贴的探针全文（我放在仓库外的临时脚本里跑，跑完即删；不往仓库新增脚本）。

---

## 1. 结论

**verdict：needs_revision（2 条 finding，其中 F1 直接命中验收第 1 条）**

一句话：**V0.1 那两个实测缺陷（标记当正文、英文思维链当正文）确实被挡住了——交付文本在 27 组组合里 0 泄漏、2 个「只剩制品」的轮次都成了 §55 沉默且 TTS 一个字节都没拿到**；
但**流式出口在「中英混合」这一形状上仍然是「先吐给 TTS、再去掉」**：只要回复以中文开头，流式闸门就不再判后面出现的英文推理，把英文整段交给了 delta 出口与适配器的结果文本；
而**「整轮只剩制品 → 沉默」的理由在产线上没有任何人看得见**——`REPLY_HYGIENE` 通知只发给了 `onNotice`，而**仓库里没有任何一处 `onNotice` 消费者**（`git grep` 只命中测试），文档里也一次没提这个 code，用户只看到「西西选择沉默」，与「模型自己决定不说」无法区分。

| 任务验收条款 | 我的判定 | 依据 |
|---|---|---|
| 1 自己构造标记 / 整段英文推理 / 中英混合三种输入，确认交付文本与**流式输出**里都没有内部字样，且**不是先吐给 TTS 再撤回** | **部分满足（交付文本 ✓；流式 ✗）** | §2：交付文本 0/27 泄漏；流式 3/27 命中（同一形状 × 三种切块）=「先吐后撤」，另在适配器出口独立复现 |
| 2 「整轮只剩制品时按沉默处理」与用户可见提示一致：控制台或日志能看到原因（不是无声无息） | **不满足** | §3：`REPLY_HYGIENE` 无任何产线消费者；控制台只显示「西西选择沉默」；`docs/design/conversation.md` 未记录该 code |
| 3 自己跑 `npm test` 与 `check-docs` 并贴结果 | **满足** | §4：`npm test` **281/281 pass / 0 fail / exit 0（duration 16.5s）**；`check:docs` **86 份 / 0 问题 / exit 0** |

---

## 2. 验收 1：交付文本干净，但流式出口在「中英混合」上先吐后撤

### 2.1 夹具（我自己写的，三条对应验收要求的三种输入）

| 编号 | 输入 | 形状 |
|---|---|---|
| A1 | `<tool_call><function=get_weather><parameter=date>today</parameter><parameter=city>上海</parameter></function></tool_call>` | 纯标记（V0.1 原文） |
| A2 | `A1 + 我查一下明天的天气哈。` | 标记 + 中文句 |
| A3 | `我先看看。 + A1 + 明天多云。` | 标记夹在中间 |
| B1 | 基线 §4.2 的英文推理原文（含中文尾句「都这么晚了，还没到家？到家了就早点歇着。」） | 整段英文推理 |
| B2 | `The user said they are tired. I should respond gently and maybe let them rest instead of asking questions.` | 纯英文推理（无中文尾句） |
| C1 | `嗯，我在的。 + A1 + 我先看看外面什么天气。 + The user asked twice in a row about the weather and I need to answer with the tool result once it arrives. + 明天多云，12 到 20 度，风不大。` | **中英混合**（中文开路 → 英文推理 → 中文正文） |
| C2 | `OK，我看看啊。今天有点冷，多穿点。` | 短英文开头词 + 中文（回归） |
| C3 | `明天多云，12 到 20 度，出门记得带件外套。` | 正常中文（回归） |
| C4 | `我把这个 app 更新了，晚上给你装好。` | 中英混排的正常句（回归：英文词不该被剥） |

「内部字样」清单是**我自己写的**，与 `reply-hygiene.ts` 里的正则无关：
`<tool_call`、`<tool_calls`、`<|tool_call`、`</tool`、`<function`、`<parameter`、`parameter=`、`The user`、`I should`、`I need to`、`they're saying`、`respond naturally`、`let me `、`the conversation`。

### 2.2 结果（9 夹具 × 3 种切块粒度：1 字 / 7 字 / 整段 = 27 组）

| 出口 | 命中内部字样的组数 | 说明 |
|---|---|---|
| 交付文本（`sanitizeSpokenReply` 的结果，也就是 `turn.text`/TTS 收到的那份） | **0 / 27** | 三种输入都干净，含 C1 |
| 流式输出（`createSpokenTextFilter` 放出的块拼起来） | **3 / 27** | 全部是 **C1**，三种切块粒度都命中 |

C1 的实测（`chunk=7` 时的原样输出）：

```
streamed  : 嗯，我在的。我先看看外面什么天气。The user asked twice in a row about the weather and I need to answer with the tool result once it arrives.
delivered : 度，风不大。
命中：["The user","I need to"]   deliveredIsPrefixOfStream=false
```

**这就是验收条款明令禁止的「先吐给 TTS 再撤回」**：流出的 63 个字里有 62 个字在交付文本里不存在。机制是流式闸门的**设计边界**（`packages/model-adapters/src/reply-hygiene.ts` 顶部注释自己写了）：

> `createSpokenTextFilter` — …holds tool-call markup always, and (when the deployment speaks Chinese) holds a foreign *opening* …
> **Reasoning deeper in the reply is not judged per chunk**

代码上：`consume()` 只在 `leading === true`（开头）时扣留英文，一旦遇到第一个汉字就 `leading = false`，之后 `return text` 原样放行。所以**第一句是中文**的回复，后面的英文推理一路放行到 delta 出口。

### 2.3 在适配器出口独立复现（更靠上游的同一个病灶）

`MimoBrainAdapter.handleUserTurn()` 在 provider 边界只挂了 `createSpokenTextFilter()`（**不带 language**，注释说明语言是引擎的配置）——也就是**只扣标记、不扣推理**。用真实 SSE 夹具（delta 边界正常切开）跑：

```
adapterStreamedToTts        : 嗯，我在的。The user asked twice in a row about the weather and I need to answer with the tool result once it arrives.明天多云，12 到 20 度，风不大。
adapterStreamedContainsEnglish : true
adapterResultText           : （同上，含英文）
adapterResultContainsEnglish: true
adapterAction               : SPEAK
```

即：**适配器交给调用方的 delta 与最终文本都含英文推理**，只有引擎的末尾闸门（`sanitizeSpokenReply`）才把它删掉——而被删掉的那段**已经通过 `onTextChunk` 交给过调用方**（`engine.ts:81` 明确写着「so TTS can start early」）。今天产线上没人拿这个 delta 去合成（`git grep onTextChunk` 只有 `scripts/voice-turn.ts:166`、`scripts/field-test.ts:770`，都只是计数/收集），所以**现在还听不到**，但契约面已经破了。

### 2.4 引擎四个出口的端到端复核（9 个夹具，逐条）

`ConversationEngine.respond()` + `FakeBrainAdapter`，同时挂 `onTextChunk`/`onSegment`/`onNotice`，再读 `store.recentTurns()`：

| 夹具 | action | turn.text | delta 出口 | 分段出口 | 落库 | 泄漏 |
|---|---|---|---|---|---|---|
| A1 纯标记 | SILENCE | `null` | 空 | 空 | `null` | 无 |
| A2 标记+中文 | SPEAK | `我查一下明天的天气哈。` | 空 | 同交付 | 同交付 | 无 |
| A3 中文+标记+中文 | SPEAK | `我先看看。明天多云。` | 空 | 同交付 | 同交付 | 无 |
| B1 英文推理+中文尾句 | SPEAK | `都这么晚了，还没到家？到家了就早点歇着。` | 空 | 同交付 | 同交付 | 无 |
| B2 纯英文推理 | SILENCE | `null` | 空 | 空 | `null` | 无 |
| C1 中英混合 | SPEAK | `度，风不大。` | **含英文**（见 §2.2） | 同交付 | 同交付 | **流式出口有** |
| C2 短英文开头 | SPEAK | `OK，我看看啊。今天有点冷，多穿点。` | 空 | 同交付 | 同交付 | 无 |
| C3 正常中文 | SPEAK | `这个我记不准，不敢乱说——要不我查一下再告诉你？`（被 t111 判为未核实事实 12 到 20 度，替换成修复句） | 空 | 同交付 | 同交付 | 无 |
| C4 中英混排正常句 | SPEAK | 原样 | 空 | 同交付 | 同交付 | 无 |

两条**已明确不存在**的担忧，我也一并核了：**沉默轮的分段/落库都是空的**（`anySegmentsOnSilence = 0`），
**TTS 出口没有一个字节含内部字样**（`anyLeakToTts = 0`，含 delta 与分段两路）。

### 2.5 我没有在这条 finding 里算进去的东西（避免夸大）

`C1` 在整段送达时（假适配器把一整轮文本当**一个** chunk 交给引擎），引擎侧 delta 出口拿到的也是**一整段含英文**的文本。但：

* 真实 `MimoBrainAdapter` 的 `handleUserTurn` 也是**先累加再一次性 yield**（`collectTurn` 的语义），所以「一整段」不是假适配器的假象；
* 它**在当前产线上不会出声**（没人把 delta 接去合成，喷口最终走 `onSegment`/`turn.text`，两者都干净）。

所以我把 F1 定成 **high（契约与出口破了、真实缺陷形状可复现，但今天不出声）**，而不是 blocker。

---

## 3. 验收 2：沉默的理由对用户/日志不可见（F2）

### 3.1 「只剩制品 → 沉默」这条取舍本身

它**按设计成立**，且我确认了三个事实（§2.4）：
① `turn.action = SILENCE`、`turn.text = null`、`turn.segments = []`；
② `onSegment` 与 `onTextChunk` 都没拿到任何字符（TTS 不会拿到标记去念）；
③ 落库的 assistant 轮是 `null`（会话记录里不会留下标记或英文）。

引擎也确实发了原因：`REPLY_HYGIENE:回复里剔除了119 字的工具调用标记（剩余为空，按沉默处理）` / `…106 字的英文推理（剩余为空，按沉默处理）`。

### 3.2 问题是**这份原因没有任何消费者**

```
git grep -n "onNotice" -- .        # 命中：engine.ts 定义与两处发出、以及 4 个测试文件
git grep -n "REPLY_HYGIENE"        # 命中：engine.ts:507（发出） + tests/unit/core/engine-reply-hygiene.test.ts 3 处
```

* **产线入口一个都没订阅**：`scripts/voice-turn.ts:163`、`scripts/serve-chat.ts:241`、`scripts/field-test.ts:767/2251/2555`、`scripts/chat.ts:237`、`scripts/voice-device-check.ts:105` 调 `engine.respond()` 时**都没传 `onNotice`**；`scripts/field-test.ts:770` 与 `scripts/voice-turn.ts:166` 只传了 `onTextChunk`（收集 chunk、记首字时间）。
* **控制台看不到原因**：`scripts/serve-chat.ts:655` 对 `action === 'SILENCE'` 只打印 `西西选择沉默`；`scripts/serve-chat.ts:573/680` 另两处同样只写 `（西西选择沉默）`。也就是说，**模型自己读空气决定不说**、**标记被剔干净**、**英文推理被剔干净**这三种情形在页面上长得一模一样，用户问「明天天气怎么样」得到的是没有任何解释的沉默。
* **文档里也没有这个 code**：`git grep -n "REPLY_HYGIENE" -- docs/` → **0 命中**。而 t111 同类的 `UNBACKED_FACT_CLAIM` 至少被写进了 `docs/design/conversation.md:256` 与 `docs/progress.md:298`。t7 的提交信息自己写了「故要求 REPLY_HYGIENE notice 必须可见（已派 t12 评审核对这一点）」——**这一条今天不成立**。

因此验收第 2 条（「控制台或日志能看到原因（不是无声无息）」）**不满足**：唯一能看见原因的地方是**测试**。

### 3.3 取舍本身要不要改，我不替队长定，但给出可选路径

产品取舍（不替模型造话、按 §55 沉默）我认同，**证据也支持它**（V0.1 那 8 个标记轮若按「说一句补救话」处理，用户会听到一句她其实没说过的话）。但「沉默」与「看得见为什么沉默」是两件事，F2 只要求后者之一落地，任选其一即可：

1. **把通知接进产线**（最小改动）：`voice-turn.ts` / `serve-chat.ts` / `field-test.ts` 传 `onNotice`，把 detail 写进 console 日志/页面 meta（与 `UNBACKED_FACT_CLAIM` 同等对待）；顺带把 `REPLY_HYGIENE` 补进 `docs/design/conversation.md` 的通知表。
2. **让轮次自己能说清**：给 `ConversationTurn` 加一个可选的 `hygiene` 摘要（或 `reason` 里区分 `SILENCE_ARTIFACT_ONLY`），页面就能显示「这句她其实想调工具，但没结果，所以没说」。
3. 若队长决定改成「说一句确定性的补救话」（复用 `UNBACKED_FACT_REPLY`），请**另开任务**——那是产品行为改变，不是本次评审能替代的决定；且要处理「补救句本身会不会被当成她真答了天气」的问题。

---

## 4. 验收 3：两条门禁命令的实测结果

在同一次运行里、对同一个修订 `8ef37f5`（工作区无未提交改动）跑：

| 命令 | 结果 |
|---|---|
| `npm test` | `ℹ tests 281 / ℹ pass 281 / ℹ fail 0 / ℹ cancelled 0 / ℹ duration_ms 16539`，**exit 0** |
| `npm run check:docs` | 先跑（写本报告之前）：`检查了 86 份 markdown｜失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0`，**exit 0**；写完本报告再跑一次：`检查了 87 份`、同样 3 个 0，**exit 0** |

我这次没有做任何突变实验（不改被测文件、不改测试），所以不存在污染全队门禁输出的窗口。

---

## 5. 复现：探针全文（不新增仓库脚本）

把下面文件放到仓库根目录下任意位置（我用的是 gitignored 的 `.tmp-t12/`，跑完删掉），用 `node <文件>` 跑即可
——工作区链接已存在，`@xixi/*` 直接可解析，不需要编译（Node v24.21.0 原生擦除类型）。

```ts
// probe-hygiene.ts — t12 独立复核：流式/交付两条出口 + 真引擎四个出口
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSpokenTextFilter, sanitizeSpokenReply } from '@xixi/model-adapters';
import { FakeBrainAdapter, type ScriptedOutcome, type UserTurnInput } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { fixedClock, openXixiStore, type Clock, type XixiConfig } from '@xixi/domain';

const FORBIDDEN = ['<tool_call', '<tool_calls', '<|tool_call', '</tool', '<function', '<parameter', 'parameter='];
const REASONING = ['The user', 'I should', 'I need to', "they're saying", 'respond naturally', 'let me ', 'the conversation'];
const hits = (text: string): string[] => [...FORBIDDEN, ...REASONING].filter((token) => text.includes(token));

const MARKUP = '<tool_call><function=get_weather><parameter=date>today</parameter><parameter=city>上海</parameter></function></tool_call>';
const ENGLISH = `The user is repeating their earlier message about going to town this afternoon and not being back until evening. But it's currently 23:30 at night - late night. So they're probably already back, or... wait, they said "今天下午去镇上办点事，可能要到晚上才回来" - this was the first message of the conversation. Now they're saying it again at 23:30.

Hmm, this could be a repeated message. I should respond naturally as a family member would - maybe noting it's already late and asking if they got back okay.都这么晚了，还没到家？到家了就早点歇着。`;
const MIXED = `嗯，我在的。${MARKUP}我先看看外面什么天气。The user asked twice in a row about the weather and I need to answer with the tool result once it arrives.明天多云，12 到 20 度，风不大。`;

const CASES: readonly (readonly [string, string])[] = [
  ['A1 纯标记', MARKUP],
  ['A2 标记+中文', `${MARKUP}我查一下明天的天气哈。`],
  ['A3 中文+标记+中文', `我先看看。${MARKUP}明天多云。`],
  ['B1 整段英文推理', ENGLISH],
  ['B2 纯英文推理', 'The user said they are tired. I should respond gently and maybe let them rest instead of asking questions.'],
  ['C1 中英混合', MIXED],
  ['C2 短英文开头', 'OK，我看看啊。今天有点冷，多穿点。'],
  ['C3 正常中文', '明天多云，12 到 20 度，出门记得带件外套。'],
  ['C4 中英混排正常句', '我把这个 app 更新了，晚上给你装好。'],
];

for (const [name, text] of CASES) {
  for (const size of [1, 7, 4096]) {
    const filter = createSpokenTextFilter({ language: 'zh-CN' });
    const emitted: string[] = [];
    for (let index = 0; index < text.length; index += size) {
      const safe = filter.push(text.slice(index, index + size));
      if (safe.length > 0) emitted.push(safe);
    }
    const tail = filter.flush();
    if (tail.length > 0) emitted.push(tail);
    const streamed = emitted.join('');
    const delivered = sanitizeSpokenReply(text, { language: 'zh-CN' }).text;
    console.log(JSON.stringify({
      case: `${name} [chunk=${size}]`,
      streamedHits: hits(streamed),
      deliveredHits: hits(delivered),
      deliveredIsPrefixOfStream: streamed.startsWith(delivered),
      streamed: streamed.slice(0, 80),
      delivered: delivered.slice(0, 80),
    }));
  }
}

const T0 = new Date('2026-09-30T23:30:00+08:00');
const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: {
    llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false },
    asr: { provider: 'fake', model: 'fake-asr' },
    tts: { provider: 'fake', model: 'fake-tts' },
  },
  personality: { base: { silence_tolerance: 0.7 } },
  proactive: {}, memory: {}, privacy: {}, features: {},
};

for (const [name, text] of CASES) {
  const root = mkdtempSync(join(tmpdir(), 'xixi-t12-'));
  const store = openXixiStore({ dbPath: join(root, 'x.sqlite'), clock: fixedClock(T0, 1_000) });
  const adapter = new FakeBrainAdapter({ reply: (_input: UserTurnInput): ScriptedOutcome => ({ action: 'SPEAK', text, toolName: null }) });
  const engine = new ConversationEngine({ adapter, store, config: CONFIG, clock: fixedClock(T0, 1_000) as Clock, offsetMinutes: 480 });
  const session = store.createSession();
  const chunks: string[] = [];
  const segments: string[] = [];
  const notices: string[] = [];
  const turn = await engine.respond(
    { sessionId: session.sessionId, text: '明天天气怎么样？', addressed: true },
    {
      onTextChunk: (chunk) => void chunks.push(chunk),
      onSegment: (segment) => void segments.push(segment.text),
      onNotice: (notice) => void notices.push(`${notice.code}:${notice.detail}`),
    },
  );
  console.log(JSON.stringify({
    case: name,
    action: turn.action,
    text: turn.text,
    deltaHits: hits(chunks.join('')),
    segmentHits: hits(segments.join('')),
    transcript: store.recentTurns(session.sessionId).at(-1)?.text ?? null,
    notices,
  }));
  store.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
```

适配器出口的复现（`probe-adapter.ts`）：把 `tests/unit/core/mimo-markup-hygiene.test.ts` 里的
`clientWith()` 假 SSE 助手照抄，把 delta 换成
`['嗯，我在的。', 'The user asked twice in a row about the weather', ' and I need to answer with the tool result once it arrives.', '明天多云，12 到 20 度，风不大。']`，
`maxCompletionTokens: 256`，然后打印 `chunks`（`type === 'text'`）拼起来的串与 `result.text` —— 两者都会含英文（§2.3）。

---

## 6. findings

### F1（high）流式闸门在「中文开头的回复」上不再拦英文推理 → delta 出口先吐后撤

* **文件**：`packages/model-adapters/src/reply-hygiene.ts:249-275`（`consume()` 的 `leading` 分支）、
  `packages/brain-adapter/src/mimo.ts:240-262`（只挂 `createSpokenTextFilter()`）、
  `packages/conversation/src/engine.ts:454-462`（`speak()` 把放行块原样交给 `onTextChunk`）。
* **问题**：`consume()` 只在「回复开头」判英文（`if (!leading) return text;`）。回复第一句是中文 → `leading = false` → 后面的英文推理原样放行。实测 C1（`嗯，我在的。…The user asked twice…明天多云…`）：delta 出口放出 `The user`、`I need to`，而交付文本只剩 `度，风不大。`——**流出的 63 字里 62 字被撤回**，正是验收第 1 条禁止的「先吐给 TTS 再撤回」。同一形状在适配器出口独立复现：`adapterStreamedToTts` 与 `adapterResultText` 都含英文、`action=SPEAK`。
* **为什么现在没出声**：`onTextChunk` 今天只被计数，喷口走 `turn.text`/`onSegment`，而这两者都是过滤后的。**所以是契约与出口的问题，不是当前的音频事故。**
* **requiredFix**：让流式闸门对**整轮**有效，二选一（或并用），并补上对应断言——
  (a) 在 `engine.speak()` 侧加「已见英文推理即停止放行到回合结束」的粘滞态（引擎知道语言，也能在末尾统一判一次）；
  (b) 在 `createSpokenTextFilter` 里对**块内**英文段做扣留兜底：遇到「英文主导且带推理线索」的连续片段时先扣住，等到下一个汉字或流结束再决定；
  (c) 若判定无法在流式阶段可靠判断，就**明确收窄契约**：`onTextChunk` 文档改为「不保证不含推理文本」，同时把今天的生产出口改成只用 `turn.text`/`onSegment`，并把这个限制写进 `docs/design/conversation.md`——**不能既宣称「不再交给 onTextChunk」又实际放行**。
* **新增测试（验收要求「自己构造中英混合」）**：`tests/unit/core/` 里补一条「回复以中文开头、中段是英文推理」的流式断言：拼接后的 delta **不含** `The user`/`I need to`，且交付文本不是 delta 的截断。今天的三份新测试文件里没有这个形状（`reply-hygiene.test.ts` 的流式用例与 `mimo-markup-hygiene.test.ts` 都只覆盖标记）。

### F2（high）「整轮只剩制品 → 沉默」的理由没有任何用户可见出口

* **文件**：`packages/conversation/src/engine.ts:504-508`（发出 `REPLY_HYGIENE`）、
  `scripts/serve-chat.ts:655`（只显示「西西选择沉默」）、`scripts/voice-turn.ts:163-171`、`scripts/field-test.ts:767-775`（都不传 `onNotice`）、`docs/design/conversation.md:256`（通知表只写 `UNBACKED_FACT_CLAIM`）。
* **问题**：`git grep -n "onNotice" -- .` 的消费者只有 4 个测试文件；`git grep -n "REPLY_HYGIENE" -- docs/` 为 0。于是「标记被剔干净导致沉默」与「模型自己决定不说」在控制台/日志上完全同形，验收第 2 条要求的「能看到原因」不成立。t7 的提交信息把这当成必须成立的条件（「故要求 REPLY_HYGIENE notice 必须可见」）。
* **requiredFix**：任选其一并落文档——① 产线入口传 `onNotice` 并把 detail 写进 console 日志/页面 meta（与 `UNBACKED_FACT_CLAIM` 同等待遇），同时把 `REPLY_HYGIENE` 补进 `docs/design/conversation.md` 的通知表；② 把原因放进轮次结构（`turn.reason` 区分 `SILENCE_ARTIFACT_ONLY`，或加 `hygiene` 摘要），让 `serve-chat` 能显示「这句她本来想调工具、没有结果所以没说」。两条都不需要改产品取舍本身。

### O1（low，未计入 verdict）英文推理里「夹带中文正文」时，交付文本会被整段削掉

C1 的真实消歧结果有时是**只剩尾巴**：`嗯，我在的。我先看看外面什么天气。The user asked…明天多云，12 到 20 度，风不大。`
被清成 `度，风不大。`，前面两句正常中文一起没了（`stripForeignReasoning` 对「英文主导 + 推理线索」的整段判删，
只有满足 `han>=4 && letters<han` 的**尾段**中文会被保住）。同一段文字拆成两个块送达时结果还不一样
（我实测：一块 → `度，风不大。`；两块 → `明天多云，12 到 20 度，风不大。`），说明结果依赖切块方式。
**这是过度删除而不是泄漏**，方向保守、不影响铁律，但会伤「知识问题可以答多句」。建议：在真实 MiMo 语料上量一下
「模型先中文一句话、再英文推理、再中文正文」的出现率；若不为零，把「保住中段中文」做成可测条款（夹具可以就用 C1）。
我没有把它算成 finding，因为它不在本次两条验收条款的字面要求内（条款只问「有没有内部字样」「是不是先吐后撤」）。

### O2（low）`turn.text` 可能是空串而不是 `null`

`packages/conversation/src/engine.ts:515` 的 `let replyText = result.text === null ? null : hygiene.text;`：
当制品被全部剔除、`result.text` 非空时，`replyText === ''`，随后 `silent` 由 `isSilenceReply('')` 兜住
（`turn.action` 仍是 `SILENCE`、`turn.text` 仍是 `null`——我实测 9 条都对）。
只是这句在「空串 vs null」上依赖下游兜底，读起来不如 `hygiene.text.length === 0 ? null : …` 直白；不影响行为。

---

## 7. 我没做的事（避免把未验证的写成已验证）

* **没有重跑真实 MiMo 探针**（`voice:turn` / 真实 SSE 泄漏现场）：那需要真密钥与联网，t7 的回报里已给出口径；
  本次评审要的是「自己构造输入」的独立核对，我用的是构造夹具 + 真实 SSE 假流，**没有**用花的钱去复现它那条「2/3 天气轮原文就是标记」。
* **没有做突变实验**（不改被测文件、不改测试），全队门禁不被我污染。
* **没有评估流式闸门 `MAX_HOLD_CHARS=2000` / `LEADING_MAX_CHARS=2000` 在长回复上的行为**（只跑了 ≤ 500 字夹具）。
* **没有检查 `dsh.ts` 路径**（t7 报「DSH 不流式 delta，整段文本由引擎的同一闸门覆盖」，我没有独立复跑 DSH）。
* **没有改动任何已跟踪文件**：本任务只新增本报告（`docs/review/` 内），临时探针放在仓库外的临时目录、跑完删除。
