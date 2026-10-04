/**
 * The desk: one place that asks every configured source and merges what comes back.
 *
 * The three tools (`tools.ts`) and the topic source (`topic-source.ts`) are all thin wrappers over
 * this object, so "what the model sees" and "what the proactive engine sees" cannot drift apart.
 *
 * Properties that are deliberate:
 *
 *  * **a source that breaks is contained.** Each source already promises not to throw; the extra
 *    `try`/`catch` here exists because a *deployment's* engine (a mapper, a search engine) is
 *    somebody else's code. It is not a guard nobody can reach: a test drives a source that throws
 *    and proves the other sources still answer.
 *  * **duplicates are counted, not hidden.** Two feeds carrying the same story is normal; the
 *    merged list keeps the first and reports how many were dropped.
 *  * **the ledger is the host's.** 「not already mentioned」 is a fact about the household, not about
 *    this month's feed, so the ledger is injected. The plugin holds no database handle (pack §3),
 *    so the durable version — if the host wants one — is written by the host, not here.
 */
import type { Clock, NewsItem, NewsQuery, NewsSource } from './types.ts';

/** What the household has already been told about. In memory by default; the host may keep it. */
export interface MentionLedger {
  has(key: string): boolean;
  remember(keys: readonly string[]): void;
  /** How many keys are remembered — observable so a test can assert the ledger really grew. */
  size(): number;
  keys(): readonly string[];
}

/** An in-memory ledger. The host can pass its own; this one is what the default gate uses. */
export function createMentionLedger(seed: readonly string[] = []): MentionLedger {
  const keys = new Set(seed);
  return {
    has: (key) => keys.has(key),
    remember: (added) => {
      for (const key of added) keys.add(key);
    },
    size: () => keys.size,
    keys: () => [...keys],
  };
}

/** The merged answer: what the sources returned, plus what merging did to it. */
export interface NewsDeskResult {
  readonly provider: string;
  readonly kind: 'merged';
  readonly fetchedAt: string;
  readonly items: readonly NewsItem[];
  readonly problems: readonly string[];
  /** How many sources were asked. Zero configured is a fact worth reporting, not a crash. */
  readonly asked: number;
  /** Items dropped because an earlier source already carried the same id. */
  readonly duplicates: number;
}

export interface NewsDeskOptions {
  readonly sources: readonly NewsSource[];
  readonly now?: Clock;
  readonly ledger?: MentionLedger;
  /** Items requested per source before merging. */
  readonly perSourceLimit?: number;
  readonly maxLimit?: number;
  readonly defaultLimit?: number;
}

export interface NewsDesk {
  readonly ledger: MentionLedger;
  /** What is configured — the health step and the probe print this. */
  sources(): readonly { readonly name: string; readonly kind: string; readonly supportsSearch: boolean }[];
  latest(query: Partial<NewsQuery> & { readonly limit?: number }): Promise<NewsDeskResult>;
  search(query: Partial<NewsQuery> & { readonly limit?: number }): Promise<NewsDeskResult>;
  /** Ranked by interest match; the tool `news.for_interests` and the topic source share this path. */
  forInterests(input: { readonly interests: readonly string[]; readonly limit?: number; readonly topic?: string }): Promise<NewsDeskResult>;
  markMentioned(items: readonly NewsItem[]): void;
}

/** Newest first; an undated item sorts last because it cannot claim recency. */
function byRecency(left: NewsItem, right: NewsItem): number {
  const a = left.publishedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(left.publishedAt);
  const b = right.publishedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(right.publishedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return a === b ? 0 : Number.isNaN(a) ? 1 : -1;
  return b - a;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether one interest appears in an item.
 *
 * Two rules, because the two scripts fail differently:
 *
 *  * **ASCII words get word boundaries.** Plain `includes` made the interest `US` match
 *    「must do better」 — a headline about a university would then be "personally relevant" to
 *    somebody whose interests are countries. That is the kind of false positive that makes the whole
 *    criterion untrustworthy, so an ASCII needle must stand alone.
 *  * **CJK gets a substring.** Chinese has no spaces, so `茶` matching 「茶博会」 is exactly right,
 *    and a boundary rule would reject every legitimate hit.
 */
export function interestMatches(item: NewsItem, interests: readonly string[]): string[] {
  const haystack = `${item.title} ${item.summary ?? ''}`.toLowerCase();
  const matched: string[] = [];
  for (const interest of interests) {
    const needle = interest.trim().toLowerCase();
    if (needle.length === 0) continue;
    const asciiWord = /^[a-z0-9][a-z0-9 .'+-]*$/.test(needle);
    const hit = asciiWord
      ? new RegExp(`(^|[^a-z0-9])${escapeForRegExp(needle)}([^a-z0-9]|$)`, 'i').test(haystack)
      : haystack.includes(needle);
    if (hit) matched.push(interest);
  }
  return matched;
}

export function createNewsDesk(options: NewsDeskOptions): NewsDesk {
  const now = options.now ?? (() => new Date());
  const ledger = options.ledger ?? createMentionLedger();
  const maxLimit = options.maxLimit ?? 10;
  const defaultLimit = options.defaultLimit ?? 3;
  const perSourceLimit = options.perSourceLimit ?? 10;

  const limitOf = (query: Partial<NewsQuery>): number => {
    const raw = typeof query.limit === 'number' && Number.isFinite(query.limit) ? Math.floor(query.limit) : defaultLimit;
    return Math.max(1, Math.min(maxLimit, raw));
  };

  type Answer = Awaited<ReturnType<NewsSource['latest']>>;

  const collect = async (query: NewsQuery, run: (source: NewsSource) => Promise<Answer>): Promise<NewsDeskResult> => {
    const answers = await Promise.all(
      options.sources.map(async (source) => {
        try {
          return await run(source);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          return { provider: source.name, kind: source.kind, fetchedAt: now().toISOString(), items: [], problems: [`${source.name} 抛出了异常：${reason}`] };
        }
      }),
    );

    const items: NewsItem[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    let duplicates = 0;
    for (const answer of answers) {
      for (const problem of answer.problems) problems.push(problem);
      for (const item of answer.items) {
        if (seen.has(item.id)) {
          duplicates += 1;
          continue;
        }
        seen.add(item.id);
        items.push(item);
      }
    }
    const wanted = query.interests ?? [];
    const ranked =
      wanted.length === 0
        ? [...items].sort(byRecency)
        : [...items].sort((left, right) => {
            const delta = interestMatches(right, wanted).length - interestMatches(left, wanted).length;
            return delta === 0 ? byRecency(left, right) : delta;
          });
    return {
      provider: options.sources.map((source) => source.name).join('+'),
      kind: 'merged',
      fetchedAt: now().toISOString(),
      items: ranked.slice(0, limitOf(query)),
      problems,
      asked: options.sources.length,
      duplicates,
    };
  };

  return {
    ledger,
    sources: () => options.sources.map((source) => ({ name: source.name, kind: source.kind, supportsSearch: source.supportsSearch })),
    latest: (query) =>
      collect(
        { limit: limitOf(query), ...(query.topic === undefined ? {} : { topic: query.topic }), ...(query.interests === undefined ? {} : { interests: query.interests }) },
        (source) => source.latest({ limit: perSourceLimit, ...(query.topic === undefined ? {} : { topic: query.topic }) }),
      ),
    search: (query) =>
      collect(
        { limit: limitOf(query), ...(query.topic === undefined ? {} : { topic: query.topic }) },
        (source) =>
          source.supportsSearch && source.search !== undefined
            ? source.search({ limit: perSourceLimit, ...(query.topic === undefined ? {} : { topic: query.topic }) })
            : Promise.resolve({
                provider: source.name,
                kind: source.kind,
                fetchedAt: now().toISOString(),
                items: [],
                problems: [`${source.name} 不能按词搜索（${source.kind}），已跳过`],
              }),
      ),
    forInterests: (input) =>
      collect(
        { limit: limitOf({ limit: input.limit }), interests: input.interests, ...(input.topic === undefined ? {} : { topic: input.topic }) },
        (source) => source.latest({ limit: perSourceLimit, ...(input.topic === undefined ? {} : { topic: input.topic }) }),
      ),
    markMentioned: (items) => ledger.remember(items.map((item) => item.id)),
  };
}
