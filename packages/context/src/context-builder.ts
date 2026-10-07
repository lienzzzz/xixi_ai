/**
 * `ContextBuilder` —— 上下文装配的**唯一入口**（pack `docs/02_MEMORY_CONTEXT.md` §1）。
 *
 * 它负责回答「这一轮模型该看到哪些事实」，而且只回答这一个问题：
 *
 *   * 工作记忆（最近几轮）与心情由调用方**传进来** —— 前者是雇主的会话状态，后者是雇主已经评估过的那一拍
 *     （`ConversationEngine.buildPrompt` 的注释解释了为什么必须同拍）；
 *   * 记忆、关系、未完话题、世界状态、有效自我画像由这里从库里读出来；
 *   * audience filter 在检索**之前**决定哪些候选有资格（pack `01_ARCHITECTURE.md` §5.7）；
 *   * 它**不**决定这一轮该不该回、也不决定回复是否安全 —— 那是 `ConversationEngine` 的 FSM 与
 *     回复安全层（pack §1：`ConversationEngine` 仍负责 FSM / event / response safety）。
 *
 * 与 `@xixi/conversation` 的依赖方向只有一个：`context` → `domain`，`conversation` → `context`。
 * 反过来（context 导入 conversation）会让两个包互相导入，Node 的 ESM 在真实运行时会炸。
 */

import { MemoryStore, type OpenThread, type XixiStore } from '@xixi/domain';
import type { Clock } from '@xixi/domain';

import { MemoryRetriever } from './memory-retriever.ts';
import type { MemoryRetrievalResult } from './types.ts';
import { DEFAULT_AUDIENCE, RELATIONSHIP_WINDOW_DAYS, buildRelationshipContext, relationshipRecentStats, relationshipStyleHints } from './relationship-context.ts';
import { renderMemoryLines, renderOpenThreadLines, renderSelfLines, renderWorldLines } from './render.ts';
import type {
  AudienceContext,
  ConversationContext,
  EffectiveSelfContext,
  OpenThreadContext,
  ProactiveContext,
  ProactiveTurnContextInput,
  RenderedContext,
  RelationshipContext,
  UserTurnContextInput,
  WorldContext,
} from './types.ts';

export interface ContextBuilderOptions {
  readonly store: XixiStore;
  readonly clock?: Clock;
  /** 本地 UTC 偏移；给定后所有渲染出来的时刻都用它（与 `toOffsetIso` 同一个约定）。 */
  readonly offsetMinutes?: number | undefined;
  readonly identity: {
    readonly timezone: string;
    /** 家里常说的地点；没有就 null（`GPT` 那类天气问题因此要先问是哪里）。 */
    readonly place: string | null;
  };
  readonly memory?: {
    readonly enabled?: boolean | undefined;
    readonly minConfidence?: number | undefined;
    readonly minItems?: number | undefined;
    readonly maxItems?: number | undefined;
    readonly includeRelationship?: boolean | undefined;
    readonly includeOpenThreads?: boolean | undefined;
  } | undefined;
  /** 显式的「谁在听」；省略 = 保守的 `family`（见 `DEFAULT_AUDIENCE`）。 */
  readonly audience?: AudienceContext | undefined;
  readonly retriever?: MemoryRetriever | undefined;
  readonly memoryStore?: MemoryStore | undefined;
}

/** 未知时刻的兜底：库里那一行自己写着什么时候写的，用它比用系统时钟诚实。 */
function fallbackNow(iso: string): Date {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function describeTimeOfDay(localHour: number): string {
  if (localHour < 5) return '凌晨';
  if (localHour < 8) return '清早';
  if (localHour < 11) return '上午';
  if (localHour < 13) return '中午';
  if (localHour < 17) return '下午';
  if (localHour < 19) return '傍晚';
  if (localHour < 22) return '晚上';
  return '深夜';
}

/** ISO-8601 带显式偏移（与 `@xixi/contracts` 的 `toOffsetIso` 逐字同形）。 */
export function offsetIso(date: Date, offsetMinutes: number): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${shifted.toISOString().slice(0, 23)}${sign}${hours}:${minutes}`;
}

export class ContextBuilder {
  readonly #store: XixiStore;
  readonly #clock: Clock;
  readonly #offsetMinutes: number;
  readonly #identity: { readonly timezone: string; readonly place: string | null };
  readonly #memoryStore: MemoryStore;
  readonly #retriever: MemoryRetriever;
  readonly #enabled: boolean;
  readonly #minConfidence: number;
  readonly #minItems: number;
  readonly #maxItems: number;
  readonly #includeRelationship: boolean;
  readonly #includeOpenThreads: boolean;
  readonly #audience: AudienceContext | undefined;

  constructor(options: ContextBuilderOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
    this.#offsetMinutes = options.offsetMinutes ?? -new Date().getTimezoneOffset();
    this.#identity = options.identity;
    this.#memoryStore = options.memoryStore ?? new MemoryStore(options.store);
    this.#retriever = options.retriever ?? new MemoryRetriever(options.store);
    this.#enabled = options.memory?.enabled ?? true;
    this.#minConfidence = options.memory?.minConfidence ?? 0.55;
    this.#minItems = options.memory?.minItems ?? 3;
    this.#maxItems = options.memory?.maxItems ?? 6;
    this.#includeRelationship = options.memory?.includeRelationship ?? true;
    this.#includeOpenThreads = options.memory?.includeOpenThreads ?? true;
    this.#audience = options.audience;
  }

  /** 用户这一轮的上下文（pack §1 的 `buildUserTurn`）。 */
  buildUserTurn(input: UserTurnContextInput): ConversationContext {
    const audience = input.audience ?? this.#audience ?? DEFAULT_AUDIENCE;
    const threads = this.#includeOpenThreads ? this.#threads() : [];
    const retrieval = this.#retrieve(input.userText, input.at, audience, input.recentTurns, threads);
    const relationship = this.#relationship(input.at, audience);
    return {
      recentTurns: input.recentTurns,
      memories: retrieval.memories,
      relationship,
      openThreads: this.#threadContexts(threads, audience),
      world: this.#world(input.at, audience),
      self: this.#self(),
      memoriesDiagnostics: retrieval.diagnostics,
      ...(input.mood === undefined ? {} : { mood: input.mood }),
      // `audience` 是可选字段（pack §1），但它是 audience filter 的**依据**，所以只要决定过就带上，
      // 面板与测试才能核对「这一轮按谁在听来筛的」。
      audience,
    };
  }

  /** 主动开口那一条路的上下文（pack §1 的 `buildProactive`）：没有 `recentTurns`，理由见类型注释。 */
  buildProactive(input: ProactiveTurnContextInput): ProactiveContext {
    const audience = input.audience ?? this.#audience ?? DEFAULT_AUDIENCE;
    const threads = this.#includeOpenThreads ? this.#threads() : [];
    const retrieval = this.#retrieve(input.fact, input.at, audience, [], threads);
    return {
      memories: retrieval.memories,
      memoriesDiagnostics: retrieval.diagnostics,
      relationship: this.#relationship(input.at, audience),
      openThreads: this.#threadContexts(threads, audience),
      world: this.#world(input.at, audience),
      self: this.#self(),
      ...(input.mood === undefined ? {} : { mood: input.mood }),
      audience,
    };
  }

  /** 给提示词的那几段（渲染 + 出口闸门），调用方不必自己拼。`now` 省略时用这个 builder 的时钟。 */
  render(context: ConversationContext | ProactiveContext, now: Date = this.#clock()): RenderedContext {
    const { lines, dropped } = renderMemoryLines(context.memories, now);
    if (dropped.length > 0) {
      // 出口闸门挡掉的条数单独记：否则「她怎么没提这件事」会变成一个查不出答案的问题，
      // 而把 `injected` 减掉会让「检索到几条」与「渲染出几条」两件事混成一个数。
      context.memoriesDiagnostics.droppedAtRender += dropped.length;
    }
    return {
      memoryLines: lines,
      relationshipLines: context.relationship.prose,
      openThreadLines: renderOpenThreadLines(context.openThreads),
      worldLines: renderWorldLines(context.world),
      selfLines: renderSelfLines(),
    };
  }

  #threads(): OpenThread[] {
    // 只取活着的话题（`candidate` / `offered`）：收口的那些是记忆，不是未完话题（pack §7）。
    return this.#store.openThreads({ status: ['candidate', 'offered'], limit: 20 });
  }

  #retrieve(
    query: string,
    at: Date,
    audience: AudienceContext,
    recentTurns: readonly { readonly role: string; readonly text: string }[],
    openThreads: readonly OpenThread[],
  ): MemoryRetrievalResult {
    if (!this.#enabled) {
      return {
        memories: [],
        diagnostics: {
          candidates: 0,
          eligible: 0,
          injected: 0,
          droppedAtRender: 0,
          minItems: 0,
          maxItems: this.#maxItems,
          weights: { lexical: 0, recency: 0, importance: 0, confidence: 0, subject: 0, openThread: 0, stale: 0, alreadyMentioned: 0 },
          dropped: [],
        },
      };
    }
    return this.#retriever.retrieve({
      query,
      now: at,
      minConfidence: this.#minConfidence,
      minItems: this.#minItems,
      maxItems: this.#maxItems,
      audience,
      recentTurns,
      openThreads,
    });
  }

  #relationship(at: Date, audience: AudienceContext): RelationshipContext {
    const snapshot = this.#memoryStore.snapshot(at, RELATIONSHIP_WINDOW_DAYS);
    const hints = relationshipStyleHints(this.#store.selfProfile());
    const stats = relationshipRecentStats(snapshot);
    if (!this.#includeRelationship) {
      // 关掉关系摘要时仍然给出结构化的事实（面板要能核对），但**不给模型那句话**。
      return { styleHints: hints, recentStats: stats, notes: [], prose: [] };
    }
    return buildRelationshipContext({
      styleHints: hints,
      recentStats: stats,
      notes: snapshot.notes.map((note) => note.note),
      // P2.5-J 修的缺陷：`audience` 以前只是被收下、从没被用过，于是关系笔记**不经过**听众过滤
      // 就压成散文进了提示词（`public` 下也一样）。过滤在 `buildRelationshipContext` 的选择阶段做。
      audience,
    });
  }

  /**
   * 未完话题：只保留**能说给当前听众听**的那些。
   *
   * 与记忆同一道先决条件：话题摘要来自父亲自己说的话，所以 `public`（有外人/媒体在场）时
   * 一条都不给 —— 家里没办完的事不该当着外人的面问（`visibleTo` 的保守口径）。
   */
  #threadContexts(threads: readonly OpenThread[], audience: AudienceContext): OpenThreadContext[] {
    if (audience.mode === 'public') return [];
    return threads.slice(0, 3).map((thread) => ({
      threadId: thread.threadId,
      summary: thread.summary,
      subject: thread.subject,
      status: thread.status,
      followAfter: thread.followAfter,
      updatedAt: thread.updatedAt,
      importance: thread.importance,
      attempts: thread.attempts,
      followUpHint: thread.followUpHint,
    }));
  }

  #world(at: Date, audience: AudienceContext): WorldContext {
    const nowIso = offsetIso(at, this.#offsetMinutes);
    const shifted = new Date(at.getTime() + this.#offsetMinutes * 60_000);
    const row = this.#store.worldState('presence.home', { now: nowIso });
    const extra: string[] = [];
    if (audience.mode !== 'private' && this.#identity.place !== null) {
      extra.push(`家里常说的地点：${this.#identity.place}`);
    }
    return {
      now: nowIso,
      timezone: this.#identity.timezone,
      timeOfDay: describeTimeOfDay(shifted.getUTCHours()),
      weekday: WEEKDAYS[shifted.getUTCDay()] ?? '',
      presence:
        row === null
          ? null
          : {
              value: row.value,
              source: row.source,
              updatedAt: row.updatedAt,
              stale: row.stale,
              present: row.present,
            },
      extra,
    };
  }

  #self(): EffectiveSelfContext {
    // 三层相加的结果：基础 + 学习到的偏移 + 当天覆盖（`selfProfile` 的注释）。
    return { profile: this.#store.selfProfile() };
  }
}

/** 兜底：调用方没给时刻时用库里的行（见 `fallbackNow` 的说明）。 */
export function nowOrFallback(at: Date | undefined, iso: string): Date {
  return at ?? fallbackNow(iso);
}
