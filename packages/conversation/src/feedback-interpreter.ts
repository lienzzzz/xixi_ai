/**
 * 反馈解释器（pack Phase 4 / 《方案》§7.4 §13.1）：「父亲这句话是什么意思」。
 *
 * 两条输入、两种权重，这是铁律 4（显式用户纠正的权重高于模型推断）的可执行版本：
 *
 *   1. **显式纠正**（`explicit_correction`，权重 1.0）：父亲直接说的话 ——
 *      「你可以主动一点」「你话太多了」「今天想安静点」。规则是**确定的模式**，不经过模型。
 *   2. **模型推断**（`model_inference`，权重 0.4）：模型在读空气时给出的**结构化白名单码**
 *      （`user_quiet` / `user_busy` / `already_said`，见 `PROACTIVE_MODEL_REASON_CODES`）。
 *      永远不读模型自由文本（铁律 5）。生产里的来源是 `proactive.decision` 事件上的
 *      `model_reason_code`：`ConversationEngine` 每一轮去日志里取「他上一条轮次之后、
 *      这一条轮次之前」的那一条判断，随 `PostTurnJob.inferredCode` 交给提取器
 *      （归属边界与理由见 `ConversationEngine` 的 `#inferredCodeForTurn`）。
 *
 * 同一轮里两者都命中时**只取显式**：父亲说了就是说了，模型不必再猜。
 *
 * 偏移数值取自《方案》§13.1 的例子（「你话太多了」→ talkativeness −0.12 / verbosity −0.10 /
 * question_rate −0.06 / proactivity −0.02；「你可以主动多跟我聊聊」→ proactivity +0.12）。
 * 「话太多」的降幅**集中在话痨相关的两个参数上**，proactivity 只降 0.02 —— 这正是 pack 的要求：
 * 不要把所有负面反馈都简化成 `proactivity--`。
 *
 * 上限不在这里，而在 `SelfModel.learn`（单日累计 ±0.15 / 推断 ±0.03、漂移 ±0.30）：解释器只回答
 * 「他想让哪几个参数动、动多少」，能不能落库由自我模型那一层按 §7.4 决定。
 *
 * 权重也**只在自我模型那一层乘一次**（`SELF_MODEL_SOURCE_WEIGHTS`：显式 1.0 / 推断 0.4）。
 * 这里的 `deltas` / `weight` 是「已乘权重」的**视图**（报告、断言、审计看它），
 * 落库要用 `nominalDeltas`（名义值）——乘两遍会让推断变成名义值的 0.16 倍，与本文档的 0.4 不符。
 */

import { PROACTIVE_MODEL_REASON_CODES, type ProactiveModelReasonCode } from './proactive.ts';

export type FeedbackKind = 'more_proactive' | 'less_proactive' | 'too_talkative' | 'quiet_today';

export interface FeedbackRule {
  readonly id: string;
  readonly kind: FeedbackKind;
  /** 命中的说法（口语里真的会这么说）。顺序即优先级，先命中的赢。 */
  readonly patterns: readonly RegExp[];
  /** 学习到的偏移（名义值，落库前会乘权重）。 */
  readonly deltas: Readonly<Record<string, number>>;
  /** 会话覆盖（只对今天生效）：`quiet_today` 用它。 */
  readonly sessionDeltas?: Readonly<Record<string, number>>;
  /** 同时记一条关系笔记（「我们怎么相处」）。 */
  readonly relationship?: { readonly aspect: string; readonly note: string };
}

/**
 * 规则表本体。
 *
 * 单独一个带类型的常量，而不是直接写在 `Object.freeze([...])` 里：字面量数组在冻结表达式里
 * 会被推断成「四个字面量形状的联合」，其中 `quiet_today` 的空 `deltas: {}` 在联合归一化后变成
 * `{ verbosity?: undefined; … }`，与 `Record<string, number>` 的索引签名冲突（P0-C 的
 * `check:types` 撞到的就是这个）。先声明成 `readonly FeedbackRule[]`，每条各自过一遍契约。
 * 运行期一字未改：`Object.freeze` 收到的还是同一个数组。
 */
const FEEDBACK_RULE_LIST: readonly FeedbackRule[] = [
  {
    id: 'quiet_today',
    kind: 'quiet_today',
    // 「今天」是关键：这是**当天**的要求，不是长期人设（《方案》§13：次日 session override 清除）。
    patterns: [/今天(想|要|得)?(安静|静一静|清静)/, /今天(别|不要|不用)(说|讲|聊)/, /今天(不|没)(太)?想(聊|说话)/, /今天少说(点|几句)/],
    deltas: {},
    sessionDeltas: { proactivity: -0.3, talkativeness: -0.25, verbosity: -0.2 },
    relationship: { aspect: 'quiet_days', note: '今天想要安静：只对当天降低主动与话量' },
  },
  {
    id: 'too_talkative',
    kind: 'too_talkative',
    patterns: [/话(太|有点|有些)多/, /少说(两|几)句/, /(太|有点)啰嗦/, /说(得|的)(太|有点)多/, /别(那么|太)能说/],
    // 《方案》§13.1：话痨相关参数降幅大，proactivity 只降一点点。
    deltas: { talkativeness: -0.12, verbosity: -0.1, follow_up_probability: -0.06, proactivity: -0.02 },
    relationship: { aspect: 'chat_style', note: '嫌话多：少说、少主动、少追问' },
  },
  {
    id: 'more_proactive',
    kind: 'more_proactive',
    patterns: [/主动(一点|多点|一些|点)/, /多(跟|和|陪)我(聊聊|说话|说说话|聊天)/, /(可以|要)主动(找|跟)我(聊|说)/, /别(老|总是)等我说/],
    // 《方案》§13.1：proactivity +0.12（topic_initiative 这个属性在本仓库里不存在，不假装有）。
    deltas: { proactivity: 0.12, talkativeness: 0.05 },
    relationship: { aspect: 'chat_style', note: '希望更主动：可以自己起话题' },
  },
  {
    id: 'less_proactive',
    kind: 'less_proactive',
    patterns: [/别(老|总是|一直)(主动|找我|问)/, /不要(总|老|一直)(主动|找我|问)/, /少(主动|找我)/],
    deltas: { proactivity: -0.1, talkativeness: -0.05 },
    relationship: { aspect: 'chat_style', note: '嫌太主动：少自己起话题' },
  },
];

export const FEEDBACK_RULES: readonly FeedbackRule[] = Object.freeze(FEEDBACK_RULE_LIST);

/** 模型推断用的白名单码 → 偏移。只认 `PROACTIVE_MODEL_REASON_CODES` 里已有的码。 */
const INFERRED_DELTAS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  user_quiet: { proactivity: -0.05, talkativeness: -0.03 },
  user_busy: { proactivity: -0.05 },
  already_said: { old_topic_resurface: -0.05 },
});

export interface FeedbackInterpretation {
  readonly kind: FeedbackKind | 'inferred_signal';
  readonly source: 'explicit_correction' | 'model_inference';
  /** 命中的规则 id（显式）或白名单码（推断）——审计里存它，不存用户原话。 */
  readonly ruleId: string;
  readonly weight: number;
  /** 学习到的偏移（已乘权重；报告、断言与审计看的视图）。 */
  readonly deltas: Readonly<Record<string, number>>;
  /**
   * 同一组偏移的**名义值**（《方案》§13.1 里写的那些数字，没有乘权重）。
   *
   * **落库时用它**：权重由 `SelfModel.learn` 按 `sourceType` 施加一次
   * （`SELF_MODEL_SOURCE_WEIGHTS`：显式 1.0 / 推断 0.4）。拿 `deltas` 去落库会把推断乘两遍
   * （0.4 × 0.4 = 0.16），那就与「推断权重 0.4」的说法对不上了 —— 显式那侧因为权重是 1.0
   * 看不出来，接线推断分支时才暴露。
   */
  readonly nominalDeltas: Readonly<Record<string, number>>;
  /** 会话覆盖（已乘权重），只对今天生效。 */
  readonly sessionDeltas: Readonly<Record<string, number>>;
  readonly confidence: number;
  /** 程序渲染的证据（≤40 字）：规则 id + 命中的说法。 */
  readonly evidence: string;
  readonly relationship?: { readonly aspect: string; readonly note: string } | undefined;
}

/** 显式纠正的权重（`SelfModel.learn` 也用它，这里是解释器侧的常量视图）。 */
export const EXPLICIT_FEEDBACK_WEIGHT = 1;
/** 模型推断的权重（铁律 4：低于显式纠正）。 */
export const INFERRED_FEEDBACK_WEIGHT = 0.4;

function scale(deltas: Readonly<Record<string, number>>, weight: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(deltas).map(([property, delta]) => [property, Math.round(delta * weight * 10_000) / 10_000]),
  );
}

/**
 * 解释一句用户的话。认不出来就返回 `null` —— **不要为了「有学习」而把普通聊天当反馈**：
 * 「今天过得怎么样」不是反馈，「你话太多了」才是。
 */
export function interpretFeedback(text: string): FeedbackInterpretation | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  for (const rule of FEEDBACK_RULES) {
    const hit = rule.patterns.map((pattern) => pattern.exec(trimmed)).find((match) => match !== null);
    if (hit === undefined || hit === null) continue;
    const weight = EXPLICIT_FEEDBACK_WEIGHT;
    return {
      kind: rule.kind,
      source: 'explicit_correction',
      ruleId: rule.id,
      weight,
      deltas: scale(rule.deltas, weight),
      nominalDeltas: { ...rule.deltas },
      sessionDeltas: scale(rule.sessionDeltas ?? {}, weight),
      confidence: 1,
      evidence: `${rule.id}｜命中「${(hit[0] ?? '').slice(0, 20)}」`,
      relationship: rule.relationship,
    };
  }
  return null;
}

/**
 * 解释一个**模型推断码**（读空气时的结构化白名单码）。
 *
 * 只有白名单里的码才有含义；自由文本一律不认（铁律 5）。
 */
export function interpretInference(code: string | null | undefined): FeedbackInterpretation | null {
  if (code === null || code === undefined) return null;
  const normalized = code.trim().toLowerCase();
  if (!(PROACTIVE_MODEL_REASON_CODES as readonly string[]).includes(normalized)) return null;
  const deltas = INFERRED_DELTAS[normalized];
  if (deltas === undefined) return null;
  return {
    kind: 'inferred_signal',
    source: 'model_inference',
    ruleId: normalized as ProactiveModelReasonCode,
    weight: INFERRED_FEEDBACK_WEIGHT,
    deltas: scale(deltas, INFERRED_FEEDBACK_WEIGHT),
    nominalDeltas: { ...deltas },
    sessionDeltas: {},
    confidence: INFERRED_FEEDBACK_WEIGHT,
    evidence: `inferred:${normalized}`,
  };
}

/**
 * 一轮的两种输入合起来解释：**显式优先**。
 *
 * 父亲自己说了就按他说的算（权重 1.0）；只有在他没说什么、而模型读空气给出了白名单码时，
 * 才用推断（权重 0.4）。两者同时存在时推断被丢弃 —— 不是叠加，也不是平均。
 */
export function interpretFeedbackInput(input: {
  readonly text?: string | undefined;
  readonly inferredCode?: string | null | undefined;
}): FeedbackInterpretation | null {
  const explicit = input.text === undefined ? null : interpretFeedback(input.text);
  if (explicit !== null) return explicit;
  return interpretInference(input.inferredCode);
}
