/**
 * 长期记忆（pack Phase 4 / 《方案》§8 §11）：episodic / semantic / relationship。
 *
 * 三条设计线，别处只消费：
 *
 *   1. **记忆是推导，不是事实**（铁律 4）：每一行都带 `sourceEventId` 指回 `events` 里的原始轮次，
 *      所以「她凭什么记得这件事」永远可以回到日志核对，记忆也可以按来源重建。
 *   2. **不是每句对话都进记忆**：写入由调用方按确定的规则触发（有将来要做的事、父亲说了一条稳定事实、
 *      一次明确纠正）。把整段对话都当永久事实，正是 AGENTS §5 禁止的那件事。
 *   3. **可查看、可编辑、可删除**（AGENTS §5）：`MemoryStore` 提供 list/update/delete，
 *      用户说「忘掉这个」时程序能真的删掉，而不是只在提示词里假装忘记。
 */

import { randomUUID } from 'node:crypto';

import { type XixiStore } from './store.ts';

/** 一条记忆从哪来 —— 权重与可信度都挂在它上面（铁律 4：显式纠正 > 模型推断）。 */
export const MEMORY_SOURCE_TYPES = Object.freeze([
  /** 父亲明确说的（纠正、偏好、事实）：权重最高。 */
  'explicit_correction',
  /** 程序从规则里提炼的（如「明天要去办证」）。 */
  'program_extraction',
  /** 模型给出的结构化判断（永远是最低权重，且只允许来自白名单码）。 */
  'model_inference',
] as const);

export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

/** 显式与推断的可信度：显式纠正权重高于模型推断（《方案》§7.4、铁律 4）。 */
export const MEMORY_SOURCE_CONFIDENCE: Readonly<Record<MemorySourceType, number>> = Object.freeze({
  explicit_correction: 1,
  program_extraction: 0.8,
  model_inference: 0.4,
});

export type EpisodicKind = 'plan' | 'correction' | 'episode';

export interface EpisodicMemory {
  readonly memoryId: string;
  readonly occurredAt: string;
  /** 程序渲染的一句话（不是模型写的，也不是整段对话）。 */
  readonly summary: string;
  readonly kind: EpisodicKind;
  readonly sourceType: MemorySourceType;
  readonly sourceEventId: string | null;
  readonly sessionId: string | null;
  readonly importance: number;
  readonly confidence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewEpisodicMemory {
  readonly summary: string;
  readonly kind: EpisodicKind;
  readonly sourceType: MemorySourceType;
  readonly occurredAt?: string | undefined;
  readonly sourceEventId?: string | null | undefined;
  readonly sessionId?: string | null | undefined;
  readonly importance?: number | undefined;
  readonly confidence?: number | undefined;
  readonly memoryId?: string | undefined;
}

export interface SemanticMemory {
  readonly memoryId: string;
  /** 话题/键：`preference`、`place`、`routine`、`person`… */
  readonly property: string;
  readonly statement: string;
  readonly sourceType: MemorySourceType;
  readonly sourceEventId: string | null;
  readonly confidence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewSemanticMemory {
  readonly property: string;
  readonly statement: string;
  readonly sourceType: MemorySourceType;
  readonly sourceEventId?: string | null | undefined;
  readonly confidence?: number | undefined;
  readonly memoryId?: string | undefined;
}

export interface RelationshipNote {
  readonly noteId: string;
  /** 相处方式的哪一面：`chat_style`、`question_density`、`humor`… */
  readonly aspect: string;
  readonly note: string;
  readonly sourceType: MemorySourceType;
  readonly sourceEventId: string | null;
  readonly confidence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewRelationshipNote {
  readonly aspect: string;
  readonly note: string;
  readonly sourceType: MemorySourceType;
  readonly sourceEventId?: string | null | undefined;
  readonly confidence?: number | undefined;
  readonly noteId?: string | undefined;
}

export interface MemoryQuery {
  readonly limit?: number | undefined;
  readonly kind?: EpisodicKind | undefined;
  readonly property?: string | undefined;
  readonly aspect?: string | undefined;
  /** 只要这段时间之后的（ISO 字符串或 epoch ms）。 */
  readonly since?: string | number | undefined;
}

/**
 * 「我们怎么相处」的 7 天统计（《方案》§8）。
 *
 * 全部从日志算出来，不另存一份：主动开口的接受率与未回应率是既有事件
 * （`proactive.decision` + `conversation.turn`）的投影。**没有的数据不编**：打断率需要打断事件，
 * 目前只有语音侧的测量、没有落库，所以这里不提供它（`interruptionRate7d: null` 更诚实）。
 */
export interface RelationshipSnapshot {
  readonly windowDays: number;
  readonly proactiveDelivered: number;
  readonly proactiveAccepted: number;
  /** 说出口的主动里，用户在回应窗口内回过话的比例。 */
  readonly proactiveAcceptRate: number | null;
  readonly unansweredProactiveRate: number | null;
  readonly userTurns: number;
  /** 明确纠正过几次（来自记忆表）。 */
  readonly explicitCorrections: number;
  readonly notes: readonly RelationshipNote[];
}

/** 一条主动开口之后，等多久没回话就算「未回应」（与 proactive.unanswered_window_min 同口径）。 */
export const RELATIONSHIP_ANSWER_WINDOW_MINUTES = 10;

/**
 * 记忆的读写门面。
 *
 * 和 `OpenThreadStore` 一样：它**不打开 SQLite**（只有 `XixiStore` 开库），只把领域动作翻译成 SQL 调用。
 */
export class MemoryStore {
  readonly #store: XixiStore;

  constructor(store: XixiStore) {
    this.#store = store;
  }

  // ------------------------------------------------------------- episodic

  recordEpisodic(input: NewEpisodicMemory): EpisodicMemory {
    return this.#store.insertEpisodicMemory({
      ...input,
      memoryId: input.memoryId ?? `mem_${randomUUID()}`,
      confidence: input.confidence ?? MEMORY_SOURCE_CONFIDENCE[input.sourceType],
    });
  }

  episodic(query: MemoryQuery = {}): EpisodicMemory[] {
    return this.#store.episodicMemories(query);
  }

  /** 改一条记忆（用户说「记错了」时改它）。 */
  updateEpisodic(memoryId: string, patch: { readonly summary?: string; readonly importance?: number }): EpisodicMemory {
    return this.#store.updateEpisodicMemory(memoryId, patch);
  }

  /** 删一条记忆（AGENTS §5：记忆必须能真的被删掉）。 */
  forget(memoryId: string): boolean {
    return this.#store.deleteEpisodicMemory(memoryId);
  }

  // ------------------------------------------------------------- semantic

  recordSemantic(input: NewSemanticMemory): SemanticMemory {
    return this.#store.insertSemanticMemory({
      ...input,
      memoryId: input.memoryId ?? `sem_${randomUUID()}`,
      confidence: input.confidence ?? MEMORY_SOURCE_CONFIDENCE[input.sourceType],
    });
  }

  semantic(query: MemoryQuery = {}): SemanticMemory[] {
    return this.#store.semanticMemories(query);
  }

  updateSemantic(memoryId: string, patch: { readonly statement?: string; readonly property?: string }): SemanticMemory {
    return this.#store.updateSemanticMemory(memoryId, patch);
  }

  forgetSemantic(memoryId: string): boolean {
    return this.#store.deleteSemanticMemory(memoryId);
  }

  // --------------------------------------------------------- relationship

  recordNote(input: NewRelationshipNote): RelationshipNote {
    return this.#store.insertRelationshipNote({
      ...input,
      noteId: input.noteId ?? `rel_${randomUUID()}`,
      confidence: input.confidence ?? MEMORY_SOURCE_CONFIDENCE[input.sourceType],
    });
  }

  notes(query: MemoryQuery = {}): RelationshipNote[] {
    return this.#store.relationshipNotes(query);
  }

  /** 7 天相处统计：全部从事件日志与记忆表现算，不另存。 */
  snapshot(now: Date = new Date(), windowDays = 7): RelationshipSnapshot {
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const since = now.getTime() - windowMs;
    const deliveries = this.#store
      .readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })
      .filter((event) => (event.payload as { speak?: unknown }).speak === true)
      .map((event) => new Date(event.timestamp))
      .filter((at) => Number.isFinite(at.getTime()) && at.getTime() >= since);
    const userTurns = this.#store
      .readEvents({ type: 'conversation.turn', limit: Number.MAX_SAFE_INTEGER })
      .filter((event) => (event.payload as { role?: unknown }).role === 'user')
      .map((event) => new Date(event.timestamp))
      .filter((at) => Number.isFinite(at.getTime()) && at.getTime() >= since);
    const answerWindowMs = RELATIONSHIP_ANSWER_WINDOW_MINUTES * 60_000;
    const accepted = deliveries.filter((at) =>
      userTurns.some((turn) => turn.getTime() > at.getTime() && turn.getTime() <= at.getTime() + answerWindowMs),
    ).length;
    const corrections = this.episodic({ kind: 'correction', since, limit: Number.MAX_SAFE_INTEGER }).length;
    return {
      windowDays,
      proactiveDelivered: deliveries.length,
      proactiveAccepted: accepted,
      proactiveAcceptRate: deliveries.length === 0 ? null : round4(accepted / deliveries.length),
      unansweredProactiveRate: deliveries.length === 0 ? null : round4((deliveries.length - accepted) / deliveries.length),
      userTurns: userTurns.length,
      explicitCorrections: corrections,
      notes: this.notes({ limit: 20 }),
    };
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
