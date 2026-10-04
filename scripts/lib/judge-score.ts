/**
 * 对话评审（judge）的线上契约，收在一处：**发给模型的 JSON Schema** 与 **读回包的映射**。
 *
 * 为什么值得单独一个模块（V0.3 P0 收尾 t19 / t10 复审 R2-D2）：评审只在 `--judge` 真跑时才出现，
 * 而它是真调用、要花钱、不在默认门禁里 —— 于是「模型按 schema 回 `in_character`，报告却读
 * `inCharacter`」这种错名可以一直躺在代码里：读出来是 `undefined`，`undefined ? '是' : '否'`
 * 渲染成「否」，**与一次真实的「不像家里人」判定逐字相同**（静默的错误结论，比崩掉更糟）。
 * t7 是靠新加的类型检查才看见它的，不是靠测试。
 *
 * 所以这里做两件事，让离线门禁能守住它：
 *   1. `JUDGE_FIELDS` 是**唯一一张字段表**，schema 的 `properties`/`required` 与读取方都由它推导
 *      —— 改了名字不可能只改一半（`tests/unit/core/eval-conversation-judge.test.ts` 会逐项核对）；
 *   2. `judgeScoreFromWire` 把「读不到必需字段」显式判成**没测到**（返回 `null`），而不是给出一个
 *      带 `undefined` 的分数。调用方据此记一条测量失败，不会被误读成一次判定。
 */
import type { JsonSchema } from '@xixi/contracts';

/**
 * 线上字段名 ↔ 报告字段名。
 *
 * 左边是报告（camelCase）看到的名字，右边是**发给模型并要求它回的那个名字**（snake_case）。
 * `problems` 两边同名，仍然列进来 —— 表要能一眼看出「回包里一共有哪几个字段」。
 */
export const JUDGE_FIELDS = Object.freeze({
  naturalness: 'naturalness',
  coherence: 'coherence',
  inCharacter: 'in_character',
  problems: 'problems',
} as const);

/**
 * 发给评审模型的 JSON Schema（`strict` 不被供应商保证，所以回包还要用 `assertSchema` 本地校验一次）。
 *
 * 键名来自 {@link JUDGE_FIELDS}，不另抄一遍字符串：这是「schema 与读取方不许分家」的一半。
 */
export const JUDGE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: Object.values(JUDGE_FIELDS),
  properties: {
    [JUDGE_FIELDS.naturalness]: { type: 'integer', minimum: 1, maximum: 5 },
    [JUDGE_FIELDS.coherence]: { type: 'integer', minimum: 1, maximum: 5 },
    [JUDGE_FIELDS.inCharacter]: { type: 'boolean' },
    [JUDGE_FIELDS.problems]: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
  },
};

/** 报告里的一行评审分数（camelCase，与 schema 的线上形状是两回事 —— 这两者的差异正是那条缺陷）。 */
export interface JudgeScore {
  readonly scenario: string;
  readonly naturalness: number;
  readonly coherence: number;
  readonly inCharacter: boolean;
  readonly problems: readonly string[];
}

/**
 * 回包（线上形状）→ 报告行。
 *
 * 形状不合就返回 `null`：**一个缺 `in_character` 的回包不是「否」**，它是「这次没测到」。
 * 调用方（`scripts/eval-conversation.ts`）把 `null` 记进 `judgeFailures`，与一次失败的评审调用同等对待。
 */
export function judgeScoreFromWire(raw: unknown, scenario: string): JudgeScore | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const wire = raw as Record<string, unknown>;
  const naturalness = wire[JUDGE_FIELDS.naturalness];
  const coherence = wire[JUDGE_FIELDS.coherence];
  const inCharacter = wire[JUDGE_FIELDS.inCharacter];
  const problems = wire[JUDGE_FIELDS.problems];
  if (typeof naturalness !== 'number' || !Number.isFinite(naturalness)) return null;
  if (typeof coherence !== 'number' || !Number.isFinite(coherence)) return null;
  if (typeof inCharacter !== 'boolean') return null;
  if (!Array.isArray(problems)) return null;
  return {
    scenario,
    naturalness,
    coherence,
    inCharacter,
    problems: problems.filter((problem): problem is string => typeof problem === 'string'),
  };
}
