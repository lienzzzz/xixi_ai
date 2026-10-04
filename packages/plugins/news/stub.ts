/**
 * The offline stub source — what makes pack §6's four requirements testable **in the default gate**.
 *
 * AGENTS §2: real API calls do not belong in `npm test`. The requirements themselves (fresh /
 * personally relevant / not already mentioned / not quiet context) are pure judgements, so they can
 * be pinned against a fixture source that never touches the network. This file is that source, and
 * it intentionally reports itself as `kind: 'stub'` so no payload can pass itself off as real news.
 *
 * It is also the degradation lever: `failWith` makes the stub fail the way a dead host does, which
 * is how the tests prove 「一个来源倒了，别的来源照常」 without unplugging the network.
 */
import type { Clock, NewsItem, NewsLookup, NewsQuery, NewsSource } from './types.ts';

export interface StubSourceOptions {
  readonly name?: string;
  readonly items: readonly NewsItem[];
  readonly now?: Clock;
  /** Extra problems, so a test can pin how trouble is reported alongside usable items. */
  readonly problems?: readonly string[];
  /** When set, every call reports this failure and returns nothing — a source that is simply down. */
  readonly failWith?: string;
  /** Set false to model a stub that cannot answer a free-text query (like a feed). */
  readonly supportsSearch?: boolean;
}

/** One fixture item, with the boring fields filled in so a test reads short. */
export function stubItem(input: {
  readonly id: string;
  readonly title: string;
  readonly source?: string;
  readonly publishedAt?: string;
  readonly url?: string;
  readonly summary?: string;
}): NewsItem {
  return {
    id: input.id,
    title: input.title,
    source: input.source ?? '离线桩',
    ...(input.publishedAt === undefined ? {} : { publishedAt: input.publishedAt }),
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  };
}

/** A deterministic, network-free `NewsSource` over the items the caller handed in. */
export function createStubNewsSource(options: StubSourceOptions): NewsSource {
  const name = options.name ?? 'stub';
  const now = options.now ?? (() => new Date());
  const answer = (query: NewsQuery): NewsLookup => {
    const fetchedAt = now().toISOString();
    if (options.failWith !== undefined) {
      return { provider: name, kind: 'stub', fetchedAt, items: [], problems: [`${name}：${options.failWith}`] };
    }
    const topic = query.topic?.trim().toLowerCase();
    const narrowed =
      topic === undefined || topic.length === 0
        ? [...options.items]
        : options.items.filter((item) => `${item.title} ${item.summary ?? ''}`.toLowerCase().includes(topic));
    return { provider: name, kind: 'stub', fetchedAt, items: narrowed.slice(0, query.limit), problems: [...(options.problems ?? [])] };
  };
  return {
    name,
    kind: 'stub',
    supportsSearch: options.supportsSearch ?? true,
    latest: (query) => Promise.resolve(answer(query)),
    ...((options.supportsSearch ?? true) ? { search: (query: NewsQuery) => Promise.resolve(answer(query)) } : {}),
  };
}
