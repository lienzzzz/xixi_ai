/**
 * The public-API source — pack §6's second family.
 *
 * A JSON endpoint is only as good as its shape, and shapes differ per service, so the seam is a
 * **mapper**: the deployment names the endpoint and says how to read it, and this file owns the
 * parts that must not vary (timeout, non-throwing failure, bounded text, provenance, dedupe).
 *
 * One concrete example ships with it — `hackerNewsItems` for the Algolia HN search API — because a
 * mapper nobody can point at is a shape, not a source. The offline gate feeds it a captured
 * payload, and `scripts/probe-tools.ts --news-live` is the manual command that hits the real
 * endpoint (AGENTS §2: live checks are manual, the default gate is offline).
 */
import { sanitizeExternalText } from './untrusted.ts';
import type { Clock, NewsItem, NewsLookup, NewsQuery, NewsSource } from './types.ts';

export const DEFAULT_API_TIMEOUT_MS = 8_000;
const API_SUMMARY_CHARS = 400;

/** What one mapping produced: items, plus anything the mapper had to say about the payload. */
export interface MappedItems {
  readonly items: readonly NewsItem[];
  readonly problems?: readonly string[];
}

export interface JsonApiSourceOptions {
  readonly name: string;
  /** Endpoint **without** the query string; `queryString()` appends what the caller asked for. */
  readonly url: string;
  readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Reads the payload. Owns the service's shape; may throw, and a throw is a reported problem. */
  readonly map: (payload: unknown, query: NewsQuery, source: string) => MappedItems;
  /** Query-string builder; `undefined` means the endpoint takes no parameters. */
  readonly queryString?: (query: NewsQuery) => string;
  readonly now?: Clock;
  readonly maxItems?: number;
  readonly timeoutMs?: number;
  /** Extra headers (a public API that wants a key reads it from the environment, never from code). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A public JSON API as a `NewsSource`. Never throws: a bad payload is a `problems` entry. */
export function createJsonApiNewsSource(options: JsonApiSourceOptions): NewsSource {
  const now = options.now ?? (() => new Date());
  const maxItems = options.maxItems ?? 25;
  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const request = async (query: NewsQuery, suffix: string): Promise<NewsLookup> => {
    const fetchedAt = now().toISOString();
    const empty = (problems: readonly string[]): NewsLookup => ({ provider: options.name, kind: 'json-api', fetchedAt, items: [], problems });
    const url = options.queryString === undefined ? `${options.url}${suffix}` : `${options.url}${options.queryString(query)}${suffix}`;
    let payload: unknown;
    try {
      const response = await options.fetchImpl(url, {
        headers: { accept: 'application/json', ...(options.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return empty([`${options.name}：HTTP ${response.status}`]);
      payload = await response.json();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return empty([`${options.name} 取不到：${reason}`]);
    }
    let mapped: MappedItems;
    try {
      mapped = options.map(payload, query, options.name);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return empty([`${options.name} 的返回读不懂：${reason}`]);
    }
    const limit = Math.min(query.limit, maxItems);
    return {
      provider: options.name,
      kind: 'json-api',
      fetchedAt,
      items: mapped.items.slice(0, limit),
      problems: [...(mapped.problems ?? [])],
    };
  };
  return {
    name: options.name,
    kind: 'json-api',
    supportsSearch: true,
    latest: (query) => request(query, ''),
    search: (query) => request(query, ''),
  };
}

/** Read a string field from a record, bounded. `undefined` when it is absent or empty. */
function field(record: Record<string, unknown>, key: string, maxChars = API_SUMMARY_CHARS): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const { text } = sanitizeExternalText(value, maxChars);
  return text.length === 0 ? undefined : text;
}

/** An ISO instant from a string or a number, or undefined when it is neither. */
function instant(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value * 1000);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

/**
 * The Algolia Hacker News search API (`https://hn.algolia.com/api/v1/search_by_date`).
 *
 * `hits[].title` / `url` / `created_at_i` are the three fields this needs; a hit without a title is
 * skipped rather than invented, and one without a URL keeps its objectID so dedupe still works.
 */
export function hackerNewsItems(payload: unknown, query: NewsQuery, source: string): MappedItems {
  const hits = (payload as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) throw new Error('没有 hits 数组');
  const problems: string[] = [];
  const items: NewsItem[] = [];
  for (const [index, raw] of hits.entries()) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const title = field(record, 'title') ?? field(record, 'story_title');
    if (title === undefined) {
      problems.push(`${source}：第 ${index + 1} 条没有标题，跳过`);
      continue;
    }
    const url = field(record, 'url') ?? (typeof record['objectID'] === 'string' ? `https://news.ycombinator.com/item?id=${record['objectID']}` : undefined);
    const publishedAt = instant(record['created_at_i']) ?? instant(record['created_at']);
    items.push({
      id: typeof record['objectID'] === 'string' ? `hn:${record['objectID']}` : `${source}#${index}`,
      title,
      source,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(url === undefined ? {} : { url }),
    });
  }
  if (query.topic !== undefined && query.topic.length > 0) {
    problems.push(`${source}：按${query.topic}查询由 API 完成（本机不再过滤）`);
  }
  return { items, problems };
}

/** The query string for the HN endpoint: newest first, at most `limit` hits. */
export function hackerNewsQuery(query: NewsQuery): string {
  const params = new URLSearchParams({ tags: 'story', hitsPerPage: String(Math.max(1, Math.min(query.limit, 50))) });
  if (query.topic !== undefined && query.topic.length > 0) params.set('query', query.topic);
  return `?${params.toString()}`;
}
