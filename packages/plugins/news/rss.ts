/**
 * The RSS/Atom source — the **real** one of pack §6's three families.
 *
 * Deliberately dependency-free (铁律 12: a new dependency needs a reason, and a feed reader for two
 * element shapes is not one). What it must get right instead:
 *
 *  * **never throw.** A dead host, a 500, a truncated document, a proxy that returns HTML — each is
 *    a `problems` entry with the source's own words, and the other sources still answer.
 *  * **a timestamp is read, not assumed.** `pubDate` / `updated` / `published` / `dc:date` are the
 *    four shapes in the wild; when none parses, the item is kept **without** `publishedAt`, which
 *    is exactly what makes it un-provable as 「fresh」 downstream (`proactive.ts`).
 *  * **the body is not carried.** `description`/`summary` is truncated to a bounded snippet; the
 *    article itself is never fetched. A news reader that follows every link would turn one tool
 *    call into twenty requests and put whole pages into the context.
 */
import type { Clock, NewsItem, NewsLookup, NewsQuery, NewsSource } from './types.ts';
import { sanitizeExternalText } from './untrusted.ts';

/** How long one feed request may take before it is reported as a problem. */
export const DEFAULT_FEED_TIMEOUT_MS = 8_000;

/** How many items one feed may contribute before the caller's own limit applies. */
export const DEFAULT_FEED_MAX_ITEMS = 25;

/** A summary is a snippet, never an article. */
const FEED_SUMMARY_CHARS = 400;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

/** Decode the handful of entities a feed actually uses, including numeric ones. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** `<![CDATA[…]]>` or plain text, entities decoded, tags dropped. */
function textOf(raw: string | undefined): string {
  if (raw === undefined) return '';
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw);
  const body = cdata === null ? raw : cdata[1] ?? '';
  const withoutTags = body.replace(/<[^>]*>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

/** The first `<tag>…</tag>` in a block, whichever namespace prefix the feed used. */
function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return match?.[1];
}

/** Atom writes the URL as an attribute you cannot get from `tag()`. */
function linkOf(block: string): string | undefined {
  const attribute = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/i.exec(block);
  if (attribute?.[1] !== undefined) return decodeEntities(attribute[1]).trim();
  const text = textOf(tag(block, 'link'));
  return text.length === 0 ? undefined : text;
}

/** ISO-8601, or undefined when the feed's date is missing or unparseable. */
export function parseFeedDate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = textOf(raw);
  if (text.length === 0) return undefined;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

/** The channel's own title, so provenance is a name rather than a URL. */
export function feedTitle(document: string): string | undefined {
  const head = document.split(/<item\b|<entry\b/i)[0] ?? '';
  const title = textOf(tag(head, 'title'));
  return title.length === 0 ? undefined : title;
}

/** The item blocks of a document, RSS `<item>` or Atom `<entry>`. */
export function feedBlocks(document: string): string[] {
  const blocks: string[] = [];
  for (const name of ['item', 'entry']) {
    const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi');
    for (const match of document.matchAll(pattern)) {
      if (match[1] !== undefined) blocks.push(match[1]);
    }
  }
  return blocks;
}

/** Stable id: the publisher's own link when there is one, otherwise source + title. */
export function itemId(source: string, title: string, url: string | undefined, fallbackIndex: number): string {
  if (url !== undefined && url.length > 0) return url;
  const slug = title.toLowerCase().replace(/\s+/g, '-').slice(0, 96);
  return `${source}#${slug.length === 0 ? `item-${fallbackIndex}` : slug}`;
}

export interface FeedDocumentResult {
  readonly source: string;
  readonly items: readonly NewsItem[];
  readonly problems: readonly string[];
}

/**
 * Read one feed document. Exported because the interesting half of this file is the parser, and a
 * fixture string is a better test than a network call (AGENTS §2: real API tests are manual).
 */
export function parseFeedDocument(document: string, fallbackSource: string, limit = DEFAULT_FEED_MAX_ITEMS): FeedDocumentResult {
  const problems: string[] = [];
  const channel = feedTitle(document);
  const source = channel ?? fallbackSource;
  const blocks = feedBlocks(document);
  if (blocks.length === 0) {
    problems.push(`${fallbackSource}：文档里没有 item/entry（可能不是 feed，或被网关拦成了 HTML）`);
    return { source, items: [], problems };
  }
  const items: NewsItem[] = [];
  const seen = new Set<string>();
  for (const [index, block] of blocks.entries()) {
    if (items.length >= limit) break;
    const title = textOf(tag(block, 'title'));
    if (title.length === 0) {
      problems.push(`${source}：第 ${index + 1} 条没有标题，跳过`);
      continue;
    }
    const url = linkOf(block);
    const id = itemId(source, title, url, index);
    if (seen.has(id)) {
      problems.push(`${source}：「${title.slice(0, 40)}」重复出现，只保留第一条`);
      continue;
    }
    seen.add(id);
    const publishedAt = parseFeedDate(tag(block, 'pubDate') ?? tag(block, 'updated') ?? tag(block, 'published') ?? tag(block, 'dc:date') ?? tag(block, 'date'));
    const summary = sanitizeExternalText(
      textOf(tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content') ?? tag(block, 'content:encoded')),
      FEED_SUMMARY_CHARS,
    ).text;
    items.push({
      id,
      title,
      source,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(url === undefined ? {} : { url }),
      ...(summary.length === 0 ? {} : { summary }),
    });
  }
  return { source, items, problems };
}

export interface RssSourceOptions {
  /** Provenance name used when the document does not carry a channel title. */
  readonly name: string;
  readonly url: string;
  /**
   * The host's `network.fetch` (the plugin context's grant). Injected rather than global so the
   * offline gate can pass a fixture and count that **nothing was fetched**.
   */
  readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly now?: Clock;
  readonly maxItems?: number;
  readonly timeoutMs?: number;
}

/** One RSS/Atom feed as a `NewsSource`. */
export function createRssNewsSource(options: RssSourceOptions): NewsSource {
  const now = options.now ?? (() => new Date());
  const maxItems = options.maxItems ?? DEFAULT_FEED_MAX_ITEMS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FEED_TIMEOUT_MS;

  return {
    name: options.name,
    kind: 'rss',
    // A feed has no query interface; `news.search` says so instead of pretending to search.
    supportsSearch: false,
    async latest(query: NewsQuery): Promise<NewsLookup> {
      const fetchedAt = now().toISOString();
      let document: string;
      try {
        const response = await options.fetchImpl(options.url, {
          headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return { provider: options.name, kind: 'rss', fetchedAt, items: [], problems: [`${options.name}：HTTP ${response.status}`] };
        }
        document = await response.text();
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        return { provider: options.name, kind: 'rss', fetchedAt, items: [], problems: [`${options.name} 取不到：${reason}`] };
      }
      const parsed = parseFeedDocument(document, options.name, Math.max(query.limit, Math.min(maxItems, maxItems)));
      // A caller asking for a topic an RSS feed cannot serve still gets the feed — with a note
      // saying the narrowing did not happen, because silently ignoring it would look like a filter.
      const problems = [...parsed.problems];
      if (query.topic !== undefined && query.topic.length > 0) {
        problems.push(`${options.name}：RSS 没有查询接口，topic「${query.topic}」未生效（返回的是整条 feed）`);
      }
      return { provider: options.name, kind: 'rss', fetchedAt, items: parsed.items.slice(0, query.limit), problems };
    },
  };
}
