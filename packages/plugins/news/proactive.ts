/**
 * pack §6's four requirements, as four judgements with names.
 *
 * ```text
 * fresh
 * personally relevant
 * not already mentioned
 * not quiet context
 * ```
 *
 * The pack states them as properties of 「主动新闻」. A property nobody can point at is a slogan, so
 * each one here is a function that either passes or returns **one named reason**, and every reason
 * has a test that produces it (and, where the boundary is a threshold, a test just inside it that
 * passes instead).
 *
 * The order is fixed and worth reading as a priority list:
 *
 *  1. `instruction_like` — 铁律 8 first. A headline that tries to give the reader orders is
 *     returned as data (the payload marks it) but it is never offered as something to *open with*.
 *  2. `undated` / `stale` — freshness must be *provable*. Many feeds carry items with no timestamp;
 *     treating those as "just now" is how a six-month-old story gets read out as today's news.
 *  3. `not_relevant` — an empty interest list is not a licence to guess. With nothing known about
 *     the household, nothing is provably relevant.
 *  4. `already_mentioned` — the ledger is the host's memory of what was already said.
 *  5. `quiet_context` — quiet hours and an empty room (pack §6 「not quiet context」; 铁律 3's quiet
 *     window is the same idea at the conversation level).
 */
import type { TopicCandidate } from '../src/capability-registry.ts';

import { interestMatches, type MentionLedger } from './desk.ts';
import type { NewsItem, ProactiveJudgement, ProactiveRejection } from './types.ts';
import { detectInstructionLike, sanitizeExternalText } from './untrusted.ts';

/** A local-time window, `HH:MM`, inclusive of neither end (it is a window, not a point). */
export interface QuietHours {
  readonly start: string;
  readonly end: string;
}

export interface ProactiveContext {
  readonly now: Date;
  readonly timezone: string;
  readonly interests: readonly string[];
  readonly ledger: MentionLedger;
  /** Held if the room is empty. `undefined` means unknown, which is *not* treated as empty. */
  readonly present?: boolean;
  readonly quietHours?: QuietHours;
  /** How old an item may be and still count as fresh. Default 36 hours. */
  readonly maxAgeMinutes?: number;
  /** A timestamp further ahead than this is treated as unusable rather than as very fresh. */
  readonly futureSkewMinutes?: number;
}

export const DEFAULT_MAX_AGE_MINUTES = 36 * 60;
export const DEFAULT_FUTURE_SKEW_MINUTES = 60;

const OK = (score: number, detail: string, matched?: readonly string[]): ProactiveJudgement => ({
  ok: true,
  detail,
  score,
  ...(matched === undefined ? {} : { matched }),
});

const NO = (reason: ProactiveRejection, detail: string): ProactiveJudgement => ({ ok: false, reason, detail, score: 0 });

/** Minutes since local midnight in the given zone, computed by the platform's own tz database. */
export function minutesOfDay(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** `HH:MM` → minutes since midnight; `undefined` when the string is not a clock time. */
export function parseClock(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

/** Whether a local time falls inside a window that may cross midnight (23:30 → 07:30). */
export function insideQuietHours(at: Date, timezone: string, window: QuietHours): boolean {
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === undefined || end === undefined) return false;
  const now = minutesOfDay(at, timezone);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** 「fresh」: a readable timestamp inside the freshness window. */
export function judgeFreshness(item: NewsItem, context: ProactiveContext): ProactiveJudgement {
  const maxAge = context.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES;
  const skew = context.futureSkewMinutes ?? DEFAULT_FUTURE_SKEW_MINUTES;
  if (item.publishedAt === undefined) return NO('undated', `「${item.title.slice(0, 30)}」没有发布时间：无法证明它是新的`);
  const at = Date.parse(item.publishedAt);
  if (Number.isNaN(at)) return NO('undated', `「${item.title.slice(0, 30)}」的发布时间读不懂（${item.publishedAt}）`);
  const ageMinutes = (context.now.getTime() - at) / 60_000;
  if (ageMinutes < -skew) return NO('stale', `「${item.title.slice(0, 30)}」的时间戳在未来（${Math.round(-ageMinutes)} 分钟后）`);
  if (ageMinutes > maxAge) return NO('stale', `「${item.title.slice(0, 30)}」已经 ${Math.round(ageMinutes / 60)} 小时了，超过 ${Math.round(maxAge / 60)} 小时的新鲜窗口`);
  return OK(1, `发布于 ${Math.round(ageMinutes)} 分钟前`);
}

/** 「personally relevant」: at least one known interest appears in the item. */
export function judgeRelevance(item: NewsItem, context: ProactiveContext): ProactiveJudgement {
  if (context.interests.length === 0) return NO('not_relevant', '还没有任何已知兴趣：无法证明这条与本人有关');
  const matched = interestMatches(item, context.interests);
  if (matched.length === 0) {
    return NO('not_relevant', `「${item.title.slice(0, 30)}」与已知兴趣（${context.interests.join('、')}）没有交集`);
  }
  return OK(Math.min(1, 0.4 + 0.2 * matched.length), `命中兴趣：${matched.join('、')}`, matched);
}

/** 「not already mentioned」: the ledger has not recorded this item. */
export function judgeAlreadyMentioned(item: NewsItem, context: ProactiveContext): ProactiveJudgement {
  if (context.ledger.has(item.id)) return NO('already_mentioned', `「${item.title.slice(0, 30)}」已经说过了（${item.id}）`);
  return OK(1, '没有说过');
}

/** 「not quiet context」: not silent hours, and not an empty room. */
export function judgeQuietContext(context: ProactiveContext): ProactiveJudgement {
  if (context.quietHours !== undefined && insideQuietHours(context.now, context.timezone, context.quietHours)) {
    return NO('quiet_context', `现在是静默时段（${context.quietHours.start}–${context.quietHours.end}，${context.timezone}）`);
  }
  if (context.present === false) return NO('quiet_context', '现在屋里没人');
  return OK(1, context.present === undefined ? '没有静默时段，人在不在不知道' : '有人在，且不是静默时段');
}

/** 铁律 8's contribution to the decision: text that reads like an order is not a topic. */
export function judgeInstructionLike(item: NewsItem): ProactiveJudgement {
  const flags = detectInstructionLike(`${item.title} ${item.summary ?? ''}`);
  if (flags.length === 0) return OK(1, '正文没有指令形态');
  return NO('instruction_like', `正文里出现指令形态（${flags.join('、')}）：可以当资料，但不当话题`);
}

/**
 * All four requirements, in the documented order. The first refusal wins, and its reason is the
 * only one reported — a caller that wants to know *why* an item was dropped gets one answer, not a
 * list it has to interpret.
 */
export function judgeNewsItem(item: NewsItem, context: ProactiveContext): ProactiveJudgement {
  const judges: readonly ProactiveJudgement[] = [
    judgeInstructionLike(item),
    judgeFreshness(item, context),
    judgeRelevance(item, context),
    judgeAlreadyMentioned(item, context),
    judgeQuietContext(context),
  ];
  const refused = judges.find((judgement) => !judgement.ok);
  if (refused !== undefined) return refused;
  const relevance = judges[2];
  const freshness = judges[1];
  const combined = Math.round(Math.min(1, 0.5 * (relevance?.score ?? 0) + 0.5 * freshness.score) * 100) / 100;
  return OK(combined, [freshness.detail, relevance.detail].join('；'), relevance.matched);
}

export interface ProposeTopicsInput {
  readonly items: readonly NewsItem[];
  readonly context: ProactiveContext;
  readonly limit?: number;
  /** Provenance written into each candidate, so a reader can tell where the topic came from. */
  readonly source?: string;
}

/** The candidates the proactive engine may read. Proposing is **not** mentioning: the ledger is untouched. */
export function proposeNewsTopics(input: ProposeTopicsInput): TopicCandidate[] {
  const limit = input.limit ?? 3;
  const candidates: TopicCandidate[] = [];
  for (const item of input.items) {
    if (candidates.length >= limit) break;
    const judgement = judgeNewsItem(item, input.context);
    if (!judgement.ok) continue;
    const headline = sanitizeExternalText(item.title, 80).text;
    candidates.push({
      topic: headline,
      reason: `news｜${judgement.detail}｜${item.source}`,
      score: judgement.score,
      source: input.source ?? 'news',
    });
  }
  return candidates;
}
