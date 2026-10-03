/**
 * 关系上下文（pack `docs/02_MEMORY_CONTEXT.md` §6）。
 *
 * 两条纪律：
 *   1. **只给与当前行为有关的摘要**，不把全统计给 LLM。所以这里给模型的是几句中文，
 *      而不是 7 天窗口里的每一个计数 —— 计数留在 `recentStats` 里给面板与测试。
 *   2. **没有的数据不编**：`interruptionRate` 目前恒为 `null`（打断还没有落库的事件，
 *      见 `MemoryStore.snapshot` 的说明），渲染时那句「被打断」就不出现；
 *      「最近没有主动开口」与「主动开口从没人应」是两种不同的处境，措辞也不同（避免除以零的假象）。
 *
 * `styleHints` 用的是 `@xixi/conversation` 里 `personalityDirectives` 的**同一套档位区间**
 * （0.33/0.66 这类），抄的是数字而不是实现，所以「提示词里说她话多」与「关系摘要里说她话多」
 * 永远同时成立 —— 一致性的判据在 `tests/unit/context/*` 里钉着。
 */

import type {
  AudienceContext,
  RelationshipContext,
  RelationshipRecentStats,
  RelationshipStyleHints,
} from './types.ts';

/** 关系窗口：与 `MemoryStore.snapshot` 的默认窗口一致（7 天）。 */
export const RELATIONSHIP_WINDOW_DAYS = 7;

/** 给模型的关系笔记最多几条：它们是「我们怎么相处」，不是「我们说过什么」。 */
export const RELATIONSHIP_NOTE_LIMIT = 3;

function band(value: number | undefined, low: number, high: number): 'low' | 'medium' | 'high' {
  if (value === undefined) return 'medium';
  if (value < low) return 'low';
  if (value > high) return 'high';
  return 'medium';
}

/**
 * 从**有效人格**算出说话方式档位。
 *
 * 输入是 `XixiStore.selfProfile()`（基础 + 学习 + 当天覆盖三层之和），所以「他说你话太多」
 * 之后这里也会跟着变 —— 学习到的偏移如果不影响这一句，那它对行为就没有可观察结果。
 */
export function relationshipStyleHints(personality: Readonly<Record<string, number>>): RelationshipStyleHints {
  const proactive = band(personality['proactivity'], 0.35, 0.7);
  const verbosity = band(personality['verbosity'], 0.33, 0.66);
  const humor = band(personality['humor'], 0.35, 0.65);
  return {
    // 主动开口的**偏好**由人格的 proactivity 决定，不由「最近接受率」决定：
    // 接受率是事实（进 recentStats），偏好是设定，两者混在一起会让一次没人回应变成性格改变。
    proactivePreference: proactive,
    questionTolerance: band(personality['curiosity'], 0.35, 0.65),
    explanationPreference: verbosity === 'low' ? 'short' : verbosity === 'high' ? 'long' : 'medium',
    humorPreference: humor,
  };
}

/** 把 `MemoryStore.snapshot()` 的投影换成这个包用的形状（只搬运，不重算）。 */
export function relationshipRecentStats(snapshot: {
  readonly windowDays: number;
  readonly proactiveDelivered: number;
  readonly proactiveAccepted: number;
  readonly proactiveAcceptRate: number | null;
  readonly unansweredProactiveRate: number | null;
  readonly userTurns: number;
}): RelationshipRecentStats {
  return {
    windowDays: snapshot.windowDays,
    proactiveDelivered: snapshot.proactiveDelivered,
    proactiveAccepted: snapshot.proactiveAccepted,
    userTurns: snapshot.userTurns,
    proactiveAcceptRate: snapshot.proactiveAcceptRate,
    proactiveIgnoreRate: snapshot.unansweredProactiveRate,
    // 「有人打断她」这件事目前没有落库的事件（只有语音侧的测量），所以这里不编一个比率。
    interruptionRate: null,
  };
}

export interface RelationshipInputs {
  readonly styleHints: RelationshipStyleHints;
  readonly recentStats: RelationshipRecentStats;
  readonly notes: readonly string[];
}

/** 装配：算出模型看得到的那几句散文（`prose`）。 */
export function buildRelationshipContext(inputs: RelationshipInputs): RelationshipContext {
  return {
    styleHints: inputs.styleHints,
    recentStats: inputs.recentStats,
    notes: inputs.notes,
    prose: renderRelationshipProse(inputs.styleHints, inputs.recentStats, inputs.notes),
  };
}

/**
 * 渲染给模型的关系摘要。**没有数字、没有参数名、没有 id**。
 *
 * 只写「值得一提的偏离」：一切照常时宁可不说话 —— 关系摘要不该变成一段每轮都出现的设定说明
 * （与 `personalityDirectives` 只输出偏离同一个理由）。
 */
export function renderRelationshipProse(
  hints: RelationshipStyleHints,
  stats: RelationshipRecentStats,
  notes: readonly string[],
): string[] {
  const lines: string[] = [];
  switch (hints.proactivePreference) {
    case 'low':
      lines.push('他更喜欢自己开口，你少主动起话头。');
      break;
    case 'high':
      lines.push('你不必等他开口才说话。');
      break;
    default:
      break;
  }
  if (hints.questionTolerance === 'low') lines.push('别追着问：他没让你问的就别问。');
  if (hints.explanationPreference === 'long') lines.push('他愿意听你多讲两句。');

  if (stats.proactiveDelivered === 0) {
    lines.push(`最近${stats.windowDays}天你还没主动开过口。`);
  } else if (stats.proactiveAcceptRate !== null && stats.proactiveAcceptRate <= 0.25) {
    lines.push(`最近${stats.windowDays}天你主动开口${stats.proactiveDelivered}次，他大多没接；先别急着多说话。`);
  } else if (stats.proactiveAcceptRate !== null && stats.proactiveAcceptRate >= 0.6) {
    lines.push(`最近${stats.windowDays}天你主动开口${stats.proactiveDelivered}次，他接得挺顺。`);
  }

  if (hints.humorPreference === 'low') lines.push('他不太接玩笑，说正经的。');

  for (const note of notes.slice(0, RELATIONSHIP_NOTE_LIMIT)) {
    const trimmed = note.trim();
    if (trimmed.length > 0) lines.push(trimmed);
  }
  return lines;
}

/** 保守的默认：程序拿不准「谁在听」时按家里人在场处理（见 `visibleTo`）。 */
export const DEFAULT_AUDIENCE: AudienceContext = Object.freeze({
  mode: 'family',
  actor: null,
  note: '没有人在场信息：按「家里人在场」处理（`private` 的记忆不外泄）。',
});
