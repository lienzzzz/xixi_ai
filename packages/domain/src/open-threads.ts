/**
 * 未完话题（OpenThread，pack Phase 3 / 《方案》§10）——「惦记感」的领域部分。
 *
 * 三件事在这里定死，别处只消费：
 *
 *   1. **状态机**：一条话题只有六个状态（{@link OPEN_THREAD_STATUSES}），与
 *      `open_thread.changed` 事件的枚举一一对应。`candidate` 才是「可以考虑主动说」，
 *      说出口变 `offered`，被回应后收口（`engaged`/`resolved`/`snoozed`），
 *      试过太多次或过期是 `exhausted` —— 收口之后**不再重复问**。
 *   2. **投影 + 事件**：每一次状态变化同时写表与写日志，且在同一事务里（{@link OpenThreadStore}
 *      只是 `XixiStore` 的薄门面，SQLite 仍只由 domain 包打开）。日志是唯一事实来源，
 *      表可以被日志重建，所以重启后「惦记着什么」不会丢，也不会重复说同一句（AGENTS.md §3）。
 *   3. **可判定的事实**：id 由「来源轮次的事件 id」哈希而来（同一条轮次永远得到同一个 id），
 *      去重靠 `summary` 的归一化比较 —— 这些都不需要模型参与（铁律 1）。
 */

import { type StoredEvent, type XixiStore } from './store.ts';

/** 一条话题可能处于的状态。顺序即「活着 → 收口」的语义顺序，枚举字符串与事件 schema 一致。 */
export const OPEN_THREAD_STATUSES = Object.freeze([
  'candidate',
  'offered',
  'engaged',
  'resolved',
  'snoozed',
  'exhausted',
] as const);

export type OpenThreadStatus = (typeof OPEN_THREAD_STATUSES)[number];

/** 还会被考虑主动开口的状态：只有 `candidate`。`offered` 正在等回答，其余都已收口。 */
export const OPEN_THREAD_ACTIVE_STATUSES: readonly OpenThreadStatus[] = Object.freeze(['candidate', 'offered']);

/** 已收口的状态：被回应过（或作废）之后**不再重复问**，也不能被重新打开。 */
export const OPEN_THREAD_SETTLED_STATUSES: readonly OpenThreadStatus[] = Object.freeze([
  'engaged',
  'resolved',
  'snoozed',
  'exhausted',
]);

export interface OpenThread {
  readonly threadId: string;
  /** 用户自己说过的那句话（程序裁剪到 120 字以内）。 */
  readonly summary: string;
  /** 从句子里抽出的动作部分（如「去镇上办证」），抽不到时为 null。 */
  readonly subject: string | null;
  readonly status: OpenThreadStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 什么时候之后才适合追问（`followAfter`）。到点前它只是 candidate，不会进入候选池。 */
  readonly followAfter: string | null;
  /** 过了这个时间还没收口就作废（`exhausted`）。 */
  readonly expireAt: string | null;
  /** 程序按模板渲染的追问短句（如「你之前说过要去镇上办证，后来怎么样了？」）。 */
  readonly followUpHint: string | null;
  readonly importance: number;
  /** 主动说过几次。 */
  readonly attempts: number;
  readonly lastOfferedAt: string | null;
  /** 提取它的那条 `conversation.turn` 事件 id —— 可回到日志核对。 */
  readonly sourceEventId: string | null;
  /** 上一条状态变化的原因（程序渲染），例如「用户回答：办好了」。 */
  readonly note: string | null;
}

export interface NewOpenThread {
  readonly threadId: string;
  readonly summary: string;
  readonly subject?: string | null;
  readonly followAfter?: string | null;
  readonly expireAt?: string | null;
  readonly followUpHint?: string | null;
  readonly importance?: number;
  readonly sourceEventId?: string | null;
  readonly createdAt?: string;
  readonly note?: string | null;
  /** 信封的 `source` 字段（默认 `conversation`）：谁提取的这条话题。 */
  readonly source?: string;
}

export interface OpenThreadQuery {
  readonly status?: OpenThreadStatus | readonly OpenThreadStatus[] | undefined;
  readonly limit?: number | undefined;
}

export interface OpenThreadChange {
  readonly thread: OpenThread;
  /** 这次变化写下的 `open_thread.changed` 事件；`created: false` 的幂等插入与无状态变化时为 null。 */
  readonly event: StoredEvent | null;
  /** `true` 表示这是本次真的新插入的行（不是已存在的同 id 行）。 */
  readonly created: boolean;
}

export interface TransitionOpenThreadOptions {
  readonly at?: Date | undefined;
  readonly note?: string | null | undefined;
  /** 主动说了一次：`attempts` 加一，并记下这一次的时间（`last_offered_at`）。 */
  readonly offered?: boolean | undefined;
}

/** 把一句话归一化成比较用的键：去掉首尾空白与句末标点，空格统一。 */
export function normalizeThreadSummary(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。！？!?，,、；;：:\s]+$/u, '')
    .trim();
}

/**
 * 由「来源轮次的事件 id」推出稳定的 thread id。
 *
 * 同一轮次无论被重放多少次都得到同一个 id，所以「扫描全部轮次 → 建话题」是幂等的：
 * 可选重放、可重跑，不会因为重启多出一条话题。
 */
export function threadIdFromSourceEvent(eventId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < eventId.length; index += 1) {
    hash ^= eventId.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `thread_${hash.toString(36).padStart(7, '0')}`;
}

/** 「到点了、还没收口」：可以考虑主动追问的那一条。 */
export function isFollowUpDue(thread: OpenThread, now: Date): boolean {
  if (thread.status !== 'candidate') return false;
  if (thread.expireAt !== null && Date.parse(thread.expireAt) <= now.getTime()) return false;
  if (thread.followAfter === null) return true;
  return Date.parse(thread.followAfter) <= now.getTime();
}

/**
 * 未完话题的读写门面。
 *
 * 它**不打开 SQLite**（domain 包只有一个地方开库：`XixiStore`），只把领域动作翻译成
 * 「插入 / 状态迁移」，并保证每次迁移都写一条 `open_thread.changed` 事件（铁律 10 与可审计性）。
 */
export class OpenThreadStore {
  readonly #store: XixiStore;

  constructor(store: XixiStore) {
    this.#store = store;
  }

  /**
   * 建一条话题；**幂等**：同 id 已存在就返回它，`created: false`，不写第二条事件。
   * 归一化后 `summary` 相同的活着的话题也会被复用（话题去重），避免同一件事被记两遍。
   */
  create(input: NewOpenThread): OpenThreadChange {
    const existing = this.#store.openThread(input.threadId);
    if (existing !== null) return { thread: existing, event: null, created: false };
    const normalized = normalizeThreadSummary(input.summary);
    const duplicate = this.list({ status: OPEN_THREAD_ACTIVE_STATUSES }).find(
      (thread) => normalizeThreadSummary(thread.summary) === normalized,
    );
    if (duplicate !== undefined) return { thread: duplicate, event: null, created: false };
    return this.#store.insertOpenThread(input);
  }

  get(threadId: string): OpenThread | null {
    return this.#store.openThread(threadId);
  }

  list(query: OpenThreadQuery = {}): OpenThread[] {
    return this.#store.openThreads(query);
  }

  /** 到点了、还没收口的候选（考虑循环的唯一入口）。 */
  due(now: Date): OpenThread[] {
    return this.#store.openThreads({ status: 'candidate' }).filter((thread) => isFollowUpDue(thread, now));
  }

  /** 迁移状态；`null` 表示已经是这个状态（幂等，不写事件）。 */
  transition(threadId: string, status: OpenThreadStatus, options: TransitionOpenThreadOptions = {}): OpenThreadChange | null {
    return this.#store.transitionOpenThread(threadId, status, options);
  }
}
