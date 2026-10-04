/**
 * 两层记忆提取的**第二层**（pack `docs/02_MEMORY_CONTEXT.md` §8）。
 *
 * ```text
 * Tier 1 deterministic   ，规则匹配，高精度（packages/conversation 的 SEMANTIC_RULES + 纠错闭环）
 * Tier 2 structured model，只针对「可能值得记」的回合，schema 校验 + 置信阈值 + 有限类别
 * ```
 *
 * 这个文件只放 Tier 2 的**政策**（哪一轮值得抽、什么东西允许被写下来），模型调用本身是注入的：
 * 生产由入口传一个真的结构化调用，测试传一个假函数 —— 于是「模型抽出来的东西能不能进记忆」
 * 这件事可以离线断言，不需要联网。
 *
 * 四条硬约束（每一条都有反事实用例守着）：
 *   1. **只针对可能值得记的回合**：`worthRemembering()` 是一道确定性的门槛。绝大多数轮次
 *      （寒暄、问句、太短的话）根本不叫模型，省下的不只是钱 —— 也叫「不要每句对话都进记忆」。
 *   2. **schema 校验**：`validateTier2Candidates()` 不是「信任但验证」，而是**不通过就整条丢掉**，
 *      并且把丢的原因带回给调用方（`rejected`），否则「模型给了一条非法输出」在日志里没有痕迹。
 *   3. **有限类别**：只允许 `TIER2_PROPERTIES` 里的话题键。模型给 `verbosity` 这类**人格属性**
 *      属于类别外，直接拒 —— 这是 pack §8 那句「模型抽取永远不能直接修改 SelfModel 高权重属性」
 *      的第一道闸门（第二道是：这个文件根本没有任何写 SelfModel 的路径）。
 *   4. **置信阈值**：低于 `TIER2_MIN_CONFIDENCE` 的候选丢掉。模型自己说「我不确定」的时候，
 *      就不该把它变成一条记忆。
 */

import { MEMORY_SOURCE_CONFIDENCE } from '@xixi/domain';

/** 允许模型提出的话题键（有限类别）。**人格属性不在这里**，也永远不会被加进来。 */
export const TIER2_PROPERTIES = Object.freeze(['preference', 'place', 'routine', 'person'] as const);

export type Tier2Property = (typeof TIER2_PROPERTIES)[number];

/** 模型候选的置信门槛：低于它不进记忆。 */
export const TIER2_MIN_CONFIDENCE = 0.7;

/** 一轮最多写几条（模型一次给很多条时，只取最确定的那几条）。 */
export const TIER2_MAX_CANDIDATES = 3;

/** 一条通过校验的候选。 */
export interface Tier2Candidate {
  readonly property: Tier2Property;
  readonly statement: string;
  /** 模型自己给的置信（通过门槛之后才会出现在这里）。 */
  readonly confidence: number;
}

export interface RejectedTier2Candidate {
  readonly reason: 'not_an_object' | 'unknown_property' | 'bad_statement' | 'low_confidence' | 'too_many';
  readonly detail: string;
}

export interface Tier2Validation {
  readonly accepted: readonly Tier2Candidate[];
  readonly rejected: readonly RejectedTier2Candidate[];
}

/**
 * 结构化模型抽取的**接缝**：给它这一轮的对话，它返回候选（形状不限，由 `validateTier2Candidates`
 * 决定能不能用）。允许返回 `unknown` —— 供应商返回什么形状都不该让这一轮提取崩掉。
 */
export type StructuredMemoryExtractor = (input: {
  readonly userText: string;
  readonly replyText: string | null;
}) => Promise<unknown>;

/**
 * 「这一轮值得叫模型来抽记忆吗」——确定性门槛（pack §8 的「只针对可能值得记的 turn」）。
 *
 * 判据刻意保守（宁可漏、不可滥）：
 *   * 太短的句子不算（「嗯」「好的」）；
 *   * 问句不算（他在问，不是在陈述自己）；
 *   * 必须出现**关于人 / 家 / 习惯的稳定信号词**（喜欢、住、老家、每天、习惯、过敏、忌口…），
 *     且是第一人称或家里的说法。
 */
const WORTH_REMEMBERING = /(我|咱|他|她|家里|老人)/;
const STABLE_SIGNAL = /(喜欢|爱好|讨厌|不吃|爱喝|忌口|过敏|住|老家|每天|平常|平时|习惯|生日|工作|退休|名字|孙子|孙女|女儿|儿子|老伴)/;

export function worthRemembering(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6) return false;
  if (/[？?]/u.test(trimmed)) return false;
  if (!WORTH_REMEMBERING.test(trimmed)) return false;
  return STABLE_SIGNAL.test(trimmed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 校验模型输出。**结构化输出永远不被信任**：形状不对就整条丢，并如实报出原因。
 *
 * 接受两种常见形状：`[{property, statement, confidence}]` 或 `{memories: [...]}`。
 */
export function validateTier2Candidates(value: unknown): Tier2Validation {
  const rejected: RejectedTier2Candidate[] = [];
  const accepted: Tier2Candidate[] = [];
  const container = asRecord(value);
  const raw = Array.isArray(value) ? value : container === null ? null : container['memories'];
  if (!Array.isArray(raw)) {
    rejected.push({ reason: 'not_an_object', detail: '模型输出既不是数组，也没有 memories 数组' });
    return { accepted, rejected };
  }
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) {
      rejected.push({ reason: 'not_an_object', detail: '候选不是对象' });
      continue;
    }
    const property = record['property'];
    if (typeof property !== 'string' || !(TIER2_PROPERTIES as readonly string[]).includes(property)) {
      // 人格属性（verbosity…）与任何未知键都走这里：**类别外一律拒**，绝不「顺手套用到人格上」。
      rejected.push({ reason: 'unknown_property', detail: `property=${String(property).slice(0, 40)}` });
      continue;
    }
    const statement = typeof record['statement'] === 'string' ? record['statement'].trim() : '';
    if (statement.length < 2 || statement.length > 60 || /[？?]/u.test(statement)) {
      rejected.push({ reason: 'bad_statement', detail: statement.slice(0, 40) });
      continue;
    }
    const confidence = typeof record['confidence'] === 'number' ? record['confidence'] : Number.NaN;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      rejected.push({ reason: 'low_confidence', detail: `confidence=${String(record['confidence']).slice(0, 20)}` });
      continue;
    }
    if (confidence < TIER2_MIN_CONFIDENCE) {
      rejected.push({ reason: 'low_confidence', detail: `${confidence} < ${TIER2_MIN_CONFIDENCE}` });
      continue;
    }
    if (accepted.length >= TIER2_MAX_CANDIDATES) {
      rejected.push({ reason: 'too_many', detail: statement.slice(0, 40) });
      continue;
    }
    accepted.push({ property: property as Tier2Property, statement, confidence });
  }
  return { accepted, rejected };
}

/**
 * 一条 Tier 2 候选落库时用的置信度。
 *
 * **不许超过来源本身的上限**（`model_inference` = 0.4，铁律 4）：模型说的永远比父亲自己说的轻。
 * 直接后果是：这类记忆默认**低于召回门槛**（0.55），也就是「记下来了，但他没有确认之前，
 * 不会当成事实说出来」—— 这正是 pack §8 想要的保守方向；要让它被召回，操作者显式把
 * `context.memory.min_confidence` 调低即可（配置里有这一项，见 config/xixi.example.yaml）。
 */
export function tier2StoredConfidence(modelConfidence: number): number {
  const weighted = Math.min(MEMORY_SOURCE_CONFIDENCE.model_inference, Math.max(0, modelConfidence) * MEMORY_SOURCE_CONFIDENCE.model_inference);
  // 四位小数：0.8 × 0.4 在二进制浮点里是 0.32000000000000006，落库前对齐到人类可读的值
  // （与 `MemoryStore` 里 `round4` 的口径一致，避免面板显示一串尾数）。
  return Math.round(weighted * 10_000) / 10_000;
}
