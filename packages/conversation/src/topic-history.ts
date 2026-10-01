/**
 * 话题历史（TopicHistory，pack Phase 3 / 《方案》§9、§11 的 `topic_history` 命名空间）：
 * 「哪些话题说过、反应如何」。
 *
 * 这里**没有新表**：事实本来就在日志里 ——
 *
 *   * `proactive.decision`（`speak: true` + `topic_ref`）说「这个话题被主动说过」；
 *   * `open_thread.changed` 的收口状态说「他后来怎么回应的」（resolved / snoozed / engaged）。
 *
 * 于是话题历史是**日志的一个视图**：可以被重放重建，也不会与日志不一致（AGENTS.md §3）。
 * 消费方是控制台的状态面板与话题引擎的去重判断。
 */

import type { XixiStore } from '@xixi/domain';

/** 一次话题出现的记录：说过，或者被回应过。 */
export interface TopicHistoryEntry {
  readonly topicRef: string;
  readonly at: Date;
  /** `offered` = 主动说了这个；`resolved`/`snoozed`/`engaged` = 用户后来的回应把它收口成什么。 */
  readonly outcome: 'offered' | 'resolved' | 'snoozed' | 'engaged';
  /** 这条记录来自哪条事件（可回到日志逐条核对）。 */
  readonly source: 'proactive.decision' | 'open_thread.changed';
  readonly candidateId: string | null;
}

/**
 * 把日志读成话题历史，按时间升序。
 *
 * 只认「真的说出口」的主动记录（`speak === true`）与「已收口」的话题事件；一次被硬门禁拦下的
 * 判定不是「说过这个话题」，不该进历史。
 */
export function readTopicHistory(store: XixiStore): TopicHistoryEntry[] {
  const entries: TopicHistoryEntry[] = [];

  for (const event of store.readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })) {
    const payload = event.payload as Record<string, unknown>;
    if (payload['speak'] !== true) continue;
    const topicRef = payload['topic_ref'];
    if (typeof topicRef !== 'string' || topicRef.trim().length === 0) continue;
    const at = new Date(event.timestamp);
    if (!Number.isFinite(at.getTime())) continue;
    entries.push({
      topicRef,
      at,
      outcome: 'offered',
      source: 'proactive.decision',
      candidateId: typeof payload['candidate_id'] === 'string' ? payload['candidate_id'] : null,
    });
  }

  for (const event of store.readEvents({ type: 'open_thread.changed', limit: Number.MAX_SAFE_INTEGER })) {
    const payload = event.payload as Record<string, unknown>;
    const status = payload['status'];
    if (status !== 'resolved' && status !== 'snoozed' && status !== 'engaged') continue;
    const threadId = payload['thread_id'];
    if (typeof threadId !== 'string' || threadId.length === 0) continue;
    const at = new Date(event.timestamp);
    if (!Number.isFinite(at.getTime())) continue;
    entries.push({ topicRef: threadId, at, outcome: status, source: 'open_thread.changed', candidateId: null });
  }

  return entries.sort((left, right) => left.at.getTime() - right.at.getTime());
}

/** 这个话题**最近一次**出现的结果，`null` 表示历史里没有它。 */
export function topicOutcome(
  history: readonly TopicHistoryEntry[],
  topicRef: string,
): TopicHistoryEntry['outcome'] | null {
  let latest: TopicHistoryEntry | null = null;
  for (const entry of history) {
    if (entry.topicRef !== topicRef) continue;
    if (latest === null || entry.at.getTime() >= latest.at.getTime()) latest = entry;
  }
  return latest?.outcome ?? null;
}

/** 同一个话题在 `windowMinutes` 内被动说过吗（去重判断：别连着两天问同一件事）。 */
export function topicOfferedWithin(
  history: readonly TopicHistoryEntry[],
  topicRef: string,
  now: Date,
  windowMinutes: number,
): TopicHistoryEntry | null {
  const windowMs = windowMinutes * 60_000;
  let hit: TopicHistoryEntry | null = null;
  for (const entry of history) {
    if (entry.topicRef !== topicRef || entry.outcome !== 'offered') continue;
    const age = now.getTime() - entry.at.getTime();
    if (age < 0 || age > windowMs) continue;
    if (hit === null || entry.at.getTime() > hit.at.getTime()) hit = entry;
  }
  return hit;
}

/**
 * 话题历史（pack Phase 3 的 `TopicHistory`）。
 *
 * 每次调用都重新从日志读一遍：话题历史没有自己的表，也就没有「缓存与日志不一致」这种可能。
 * 表很小（一条主动记录 / 一次收口各一行），这点读取代价远小于维护第二份真相的代价。
 */
export class TopicHistory {
  readonly #store: XixiStore;

  constructor(store: XixiStore) {
    this.#store = store;
  }

  /** 全部记录，按时间升序。 */
  entries(): TopicHistoryEntry[] {
    return readTopicHistory(this.#store);
  }

  /** 这个话题最近一次出现的结果。 */
  outcome(topicRef: string): TopicHistoryEntry['outcome'] | null {
    return topicOutcome(this.entries(), topicRef);
  }

  /** 这个话题在窗口内被动说过吗。 */
  offeredWithin(topicRef: string, now: Date, windowMinutes: number): TopicHistoryEntry | null {
    return topicOfferedWithin(this.entries(), topicRef, now, windowMinutes);
  }
}
