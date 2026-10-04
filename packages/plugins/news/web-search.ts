/**
 * The web-search adapter — pack §6's third family.
 *
 * A search engine is **injected**, not imported: this repo has no search client of its own (the
 * agent harnesses ship their own), and a plugin that reached for one directly would be choosing a
 * deployment's vendor from inside the kernel. What this file owns is the part that must be the
 * same whoever answers: one query per call, bounded snippets, provenance, and — most importantly —
 * the assumption that **a search snippet is the most instruction-shaped text on the internet**.
 * Results go through the same `sanitizeExternalText` + `detectInstructionLike` treatment as any
 * other external text.
 */
import { sanitizeExternalText } from './untrusted.ts';
import type { Clock, NewsItem, NewsLookup, NewsQuery, NewsSource } from './types.ts';

/** One hit as an engine returns it. `publishedAt` is optional: most engines do not date snippets. */
export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
  readonly publisher?: string;
}

/** What a deployment wires in: any engine, as long as it answers with hits and does not throw. */
export type WebSearchEngine = (query: string, options: { readonly limit: number }) => Promise<readonly WebSearchHit[]>;

export interface WebSearchSourceOptions {
  readonly name: string;
  readonly engine: WebSearchEngine;
  /**
   * What `news.latest` asks for when the caller named no topic. Without it, a topic-less `latest`
   * on a search source is reported as a problem instead of being turned into a guessed query.
   */
  readonly defaultQuery?: string;
  readonly now?: Clock;
  readonly maxItems?: number;
}

const SNIPPET_CHARS = 320;

/** A search engine as a `NewsSource`. The topic *is* the query, so it does support searching. */
export function createWebSearchNewsSource(options: WebSearchSourceOptions): NewsSource {
  const now = options.now ?? (() => new Date());
  const maxItems = options.maxItems ?? 15;

  const run = async (query: NewsQuery, text: string): Promise<NewsLookup> => {
    const fetchedAt = now().toISOString();
    if (text.trim().length === 0) {
      return {
        provider: options.name,
        kind: 'web-search',
        fetchedAt,
        items: [],
        problems: [`${options.name}：没有查询词（search 需要 topic，latest 需要 defaultQuery）`],
      };
    }
    try {
      const hits = await options.engine(text.trim(), { limit: Math.min(query.limit, maxItems) });
      const items: NewsItem[] = [];
      const problems: string[] = [];
      for (const [index, hit] of hits.entries()) {
        const title = sanitizeExternalText(hit.title, 200).text;
        if (title.length === 0) {
          problems.push(`${options.name}：第 ${index + 1} 条结果没有标题，跳过`);
          continue;
        }
        const snippet = hit.snippet === undefined ? '' : sanitizeExternalText(hit.snippet, SNIPPET_CHARS).text;
        items.push({
          id: hit.url.length > 0 ? hit.url : `${options.name}#${index}`,
          title,
          source: hit.publisher ?? options.name,
          ...(hit.publishedAt === undefined ? {} : { publishedAt: hit.publishedAt }),
          ...(hit.url.length === 0 ? {} : { url: hit.url }),
          ...(snippet.length === 0 ? {} : { summary: snippet }),
        });
      }
      return { provider: options.name, kind: 'web-search', fetchedAt, items, problems };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return { provider: options.name, kind: 'web-search', fetchedAt, items: [], problems: [`${options.name} 搜不了：${reason}`] };
    }
  };

  return {
    name: options.name,
    kind: 'web-search',
    supportsSearch: true,
    latest: (query) => run(query, query.topic ?? options.defaultQuery ?? ''),
    search: (query) => run(query, query.topic ?? ''),
  };
}
