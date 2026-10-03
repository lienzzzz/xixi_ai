/**
 * `@xixi/context` 的公开形状（pack `docs/02_MEMORY_CONTEXT.md` §1 §3 §6）。
 *
 * 这个包是 V0.3 P1 的「上下文装配」层：它**只读**领域层（`@xixi/domain`），不知道
 * `ConversationEngine` 的状态机、也不知道提示词长什么样。这样分层是为了让
 * 「模型看到了什么上下文」只有一个回答者（`ContextBuilder`），而
 * 「这一轮该不该回、回什么安全」仍留在 `ConversationEngine`（pack §1 的边界：
 * `ConversationEngine` 仍负责 FSM / event / response safety）。
 *
 * 三条纪律写进类型里而不是注释里：
 *   1. 每条 `RetrievedMemory` 都带 `provenance`（铁律 4：记忆是推导，必须能指回原始轮次）；
 *   2. `visibility` 在候选进入排序**之前**就已经定好，供 audience filter 使用
 *      （pack `01_ARCHITECTURE.md` §5.7：audience filter 先于 memory retrieval）；
 *   3. 渲染给模型的那一份（`RenderedContext`）与程序自己看的那一份（`ConversationContext`）
 *      是两个字段：UUID、浮点数字、UUID 形态的 id 只允许出现在前者**之外**。
 */

import type { PromptTurnLike, TurnRoleLike } from './prompt-turn.ts';

/** 记忆的三个来源（pack §3 的 `kind` 枚举）。 */
export const MEMORY_KINDS = Object.freeze(['episodic', 'semantic', 'relationship'] as const);
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 可见范围。与提示词/日志无关，只描述「这条记忆能说给谁听」。 */
export const MEMORY_VISIBILITIES = Object.freeze(['private', 'family', 'public'] as const);
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

/**
 * 一条记忆「凭什么这么说」。
 *
 * `sourceEventId` 指回 `events` 里的原始轮次（可能为 null：关系笔记可以由程序直接写下）。
 * `confidence` 与 `sourceType` 一起决定它在提示词里被写成「较确定」还是「不太确定」。
 */
export interface MemoryProvenance {
  readonly sourceEventId: string | null;
  /** `explicit_correction` / `program_extraction` / `model_inference`（`MEMORY_SOURCE_TYPES`）。 */
  readonly sourceType: string;
  readonly confidence: number;
  /** 事情发生的时间；语义记忆没有这个（它没有「发生」这一说），null 表示只按 `updatedAt` 算近因。 */
  readonly occurredAt: string | null;
  readonly updatedAt: string;
}

/** 一条真的会被写进提示词的记忆（pack §3）。 */
export interface RetrievedMemory {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly provenance: MemoryProvenance;
  readonly visibility: MemoryVisibility;
  /** 为什么它这一轮被选进来（给面板与测试看的短句，不进提示词）。 */
  readonly retrievalReason: string;
}

/** 检索时被丢掉的候选：丢了什么、为什么，必须能回答（否则「她怎么不记得」没有答案）。 */
export interface DroppedMemory {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly reason: 'low_confidence' | 'not_relevant' | 'not_visible' | 'over_budget' | 'unusable_text';
}

export interface MemoryRetrievalDiagnostics {
  /** 这一轮扫过的候选条数（不是全部记忆表，见检索器的 `candidateLimit`）。 */
  readonly candidates: number;
  /** 通过 confidence 与 audience 两道先决条件的条数。 */
  readonly eligible: number;
  /** 检索阶段真的选出来的条数（= `memories.length`）。 */
  readonly injected: number;
  /**
   * 到了渲染那一步才被出口闸门丢掉的条数（UUID / 长数字 / 参数名）。
   *
   * 它与 `injected` 分开记，而不是把 `injected` 减掉：两个数是两个阶段的事实，
   * 合在一起就再也说不清「是没检索到，还是渲染时被挡了」。
   *
   * **非 readonly**：渲染发生在检索之后，这个计数是渲染阶段往同一份诊断里追加的事实。
   */
  droppedAtRender: number;
  /** 配置的下限；真的凑不满时会少（下限不许用「硬凑不相关的记忆」来满足）。 */
  readonly minItems: number;
  readonly maxItems: number;
  /** 本轮实际用到的总分权重，逐项可核对（§9.10 式的可复核）。 */
  readonly weights: MemoryScoreWeights;
  readonly dropped: readonly DroppedMemory[];
}

export interface MemoryRetrievalResult {
  readonly memories: readonly RetrievedMemory[];
  readonly diagnostics: MemoryRetrievalDiagnostics;
}

/** 混合排序的权重（`scoreProactiveCandidate` 同款：数字是公开的，能被测试与面板逐项核对）。 */
export interface MemoryScoreWeights {
  readonly lexical: number;
  readonly recency: number;
  readonly importance: number;
  readonly confidence: number;
  readonly subject: number;
  readonly openThread: number;
  readonly stale: number;
  readonly alreadyMentioned: number;
}

/**
 * 「现在谁在听」。第一批只是一个**先决条件**（audience filter 先于 retrieval），
 * 完整的 audience 模型（多人、说话人识别、隐私同意）属于 P6，见 pack `01_ARCHITECTURE.md` §5.7。
 */
export interface AudienceContext {
  /** `family` = 家里人在场（默认）；`private` = 只有父亲；`public` = 有外人/电视/媒体。 */
  readonly mode: 'private' | 'family' | 'public';
  /** 程序知道的具体是谁（可能是 `father`、`family_member`、`unknown_person`…），不知道就是 null。 */
  readonly actor: string | null;
  /** 一句话说明为什么这么判断（给面板与审计，不进提示词）。 */
  readonly note: string;
}

/** 相处方式里那些**会影响说话方式**的摘要（pack §6：只给摘要，不给全统计）。 */
export interface RelationshipStyleHints {
  readonly proactivePreference: 'low' | 'medium' | 'high';
  readonly questionTolerance: 'low' | 'medium' | 'high';
  readonly explanationPreference: 'short' | 'medium' | 'long';
  readonly humorPreference: 'low' | 'medium' | 'high';
}

export interface RelationshipRecentStats {
  /** 7 天窗口内说出口的主动开口次数。0 条时两个比率都是 null（没有的数据不编，见 `RelationshipSnapshot`）。 */
  readonly proactiveDelivered: number;
  readonly proactiveAccepted: number;
  readonly userTurns: number;
  readonly proactiveAcceptRate: number | null;
  readonly proactiveIgnoreRate: number | null;
  /** 目前没有落库的打断事件，所以这里恒为 null —— 不编一个数出来。 */
  readonly interruptionRate: number | null;
  readonly windowDays: number;
}

export interface RelationshipContext {
  readonly styleHints: RelationshipStyleHints;
  readonly recentStats: RelationshipRecentStats;
  readonly notes: readonly string[];
  /** 程序按 `styleHints` 与 `recentStats` 渲染的中文短句，模型只看到这些。 */
  readonly prose: readonly string[];
}

/** 一条还没收口、这轮可能相关的话题（pack §7：OpenThread 是「将来还要接的话」，不是记忆）。 */
export interface OpenThreadContext {
  readonly threadId: string;
  readonly summary: string;
  readonly subject: string | null;
  readonly status: string;
  readonly followAfter: string | null;
  readonly updatedAt: string;
  readonly importance: number;
  readonly attempts: number;
  /** 程序渲染的追问短句（可能为 null）。 */
  readonly followUpHint: string | null;
}

/** 世界状态里**这一轮**用得上的那几行（不是整张投影表）。 */
export interface WorldContext {
  /** ISO 带偏移。 */
  readonly now: string;
  readonly timezone: string;
  readonly timeOfDay: string;
  readonly weekday: string;
  /** 在场投影：null = 库里没有这一行；`fresh:false` 时消费方只能说「不知道」。 */
  readonly presence: {
    readonly value: string | null;
    readonly source: string;
    readonly updatedAt: string;
    readonly stale: boolean;
    readonly present: boolean | null;
  } | null;
  /** 可以直接进提示词的短句（程序渲染，不含原始 payload）。 */
  readonly extra: readonly string[];
}

/**
 * 有效自我画像（三层相加的结果）。
 *
 * 这里**保留数值**：面板与测试要能核对「学习到的偏移真的进了有效人格」。数值不会进提示词 ——
 * 提示词里的说话方式由 `@xixi/conversation` 的 `personalityDirectives`（散文）负责，
 * 这条边界与心情那段（`MoodContext` 只把 `prose` 拼进 `system`）是同一条。
 */
export interface EffectiveSelfContext {
  readonly profile: Readonly<Record<string, number>>;
}

/** 记忆/关系/未完话题/世界/自我/心情，一个都在这一份里（pack §1 的 `ConversationContext`）。 */
export interface ConversationContext {
  readonly recentTurns: readonly PromptTurnLike[];
  readonly memories: readonly RetrievedMemory[];
  readonly relationship: RelationshipContext;
  readonly openThreads: readonly OpenThreadContext[];
  readonly world: WorldContext;
  readonly self: EffectiveSelfContext;
  readonly memoriesDiagnostics: MemoryRetrievalDiagnostics;
  /** 可选（pack §1）：没有心情这一层的入口不传。 */
  readonly mood?: unknown;
  /** 可选（pack §1）：程序拿不准「谁在听」时按最保守的 `family` 处理，不编一份。 */
  readonly audience?: AudienceContext;
}

/**
 * 主动开口那一条路用的上下文（pack §1 的 `buildProactive`）。
 *
 * 它比 `ConversationContext` 少一样东西 —— **没有 `recentTurns`**：主动开口不是「接住对方的话」，
 * 把上一轮当「用户刚说」塞进去正是「刚说完就重复」的来源。它多的是候选本身的事实
 * （`trigger` / `intent` / `fact`），那些由候选计划提供，不由这个包决定。
 */
export interface ProactiveContext {
  readonly memories: readonly RetrievedMemory[];
  readonly memoriesDiagnostics: MemoryRetrievalDiagnostics;
  readonly relationship: RelationshipContext;
  readonly openThreads: readonly OpenThreadContext[];
  readonly world: WorldContext;
  readonly self: EffectiveSelfContext;
  readonly mood?: unknown;
  readonly audience?: AudienceContext;
}

/** 装配一轮用户对话要的外部事实（`recentTurns` 由调用方给：那是雇主的会话工作记忆，不是库的投影）。 */
export interface UserTurnContextInput {
  readonly userText: string;
  readonly at: Date;
  readonly recentTurns: readonly PromptTurnLike[];
  readonly audience?: AudienceContext | null | undefined;
  /** 显式传入的那一拍心情（`ConversationEngine` 已经评估过，见 `buildPrompt` 的注释）。 */
  readonly mood?: unknown;
}

export interface ProactiveTurnContextInput {
  /** 主动开口要说的事（候选计划的依据行），用来做记忆的词面相关。 */
  readonly fact: string;
  readonly at: Date;
  readonly audience?: AudienceContext | null | undefined;
  readonly mood?: unknown;
}

/** 调用方（引擎）能提供、而这个包不该自己去推的东西。 */
export interface ContextSources {
  readonly recentTurns: readonly PromptTurnLike[];
}

/** 渲染结果里那几条「给模型看的」段落：**没有** UUID、没有浮点数字。 */
export interface RenderedContext {
  readonly memoryLines: readonly string[];
  readonly relationshipLines: readonly string[];
  readonly openThreadLines: readonly string[];
  readonly worldLines: readonly string[];
  readonly selfLines: readonly string[];
}

export type { PromptTurnLike, TurnRoleLike };
