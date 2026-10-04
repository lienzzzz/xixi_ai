/**
 * The news data contract — pack `03_AGENT_PLUGIN.md` §6.
 *
 * The pack lists three provider families:
 *
 * ```text
 * RSS
 * public API
 * web search adapter
 * ```
 *
 * and this file is the shape all three must fit. It lives **here**, with the implementation,
 * rather than in `@xixi/brain-adapter`: the built-in `xixi_news_stub` was removed in P2-D, so
 * nothing in the model layer has a news seam any more. What remains is a plugin that talks to
 * sources and contributes `news.search` / `news.latest` / `news.for_interests` as ordinary
 * `AgentTool`s (it imports `AgentTool` from `@xixi/brain-adapter` like every other tool).
 *
 * Three rules the types make explicit rather than advisory:
 *
 *  * **a fetch never throws.** A source that is down, slow or badly formatted reports
 *    `problems` and returns what it could read; the model gets a payload it can act on
 *    ("this source is unavailable") instead of a broken turn.
 *  * **an item without a timestamp is `undated`, not `fresh`.** Freshness has to be provable to
 *    count (pack §6 「fresh」), so `publishedAt` is optional and the judge treats its absence as a
 *    rejection reason rather than as "now".
 *  * **every item carries where it came from.** Provenance is what lets 铁律 8 keep instructions
 *    and data apart: the model is told this text is external, and the host can drop it by source.
 */
import type { AgentTool } from '@xixi/brain-adapter';

/** Which family a source belongs to. Reported in every payload, so a reader knows the provenance. */
export type NewsSourceKind = 'rss' | 'json-api' | 'web-search' | 'stub';

/**
 * One headline.
 *
 * `title` and `summary` are **external text** and are handled as such everywhere in this package
 * (`untrusted.ts`); `id` is the dedupe key ("not already mentioned" is a statement about ids).
 */
export interface NewsItem {
  /** Stable key for dedupe: source + the publisher's own id/link, never the position in the feed. */
  readonly id: string;
  readonly title: string;
  /** The publisher, for example the feed title or the host name. */
  readonly source: string;
  /** ISO-8601 instant the item was published. Absent = the source did not say (⇒ not provably fresh). */
  readonly publishedAt?: string;
  readonly url?: string;
  /** Short body, already bounded by the source reader. Never a whole article. */
  readonly summary?: string;
}

/** What one source returned, including what went wrong while reading it. */
export interface NewsLookup {
  /** Which source answered. */
  readonly provider: string;
  readonly kind: NewsSourceKind;
  /** When this package read it (not when the publisher wrote it). */
  readonly fetchedAt: string;
  readonly items: readonly NewsItem[];
  /** Per-source trouble, in the source's own words. Empty = a clean read. */
  readonly problems: readonly string[];
}

/** What a caller asks for. Every field has a documented default; none is required. */
export interface NewsQuery {
  /** Upper bound on items the caller wants back. Each source also applies its own cap. */
  readonly limit: number;
  /** Free-text narrowing ("本地", "天气"). Sources that cannot filter ignore it and say so. */
  readonly topic?: string;
  /** What the household cares about — `news.for_interests` ranks by this. */
  readonly interests?: readonly string[];
  /** Do not return anything published before this instant (the freshness floor for the fetch). */
  readonly since?: Date;
}

/**
 * One place headlines can come from.
 *
 * `search` is optional **by design**: an RSS feed cannot answer a free-text query, and pretending
 * otherwise would mean inventing results. `supportsSearch` is what `news.search` reports when a
 * configured source cannot search at all.
 */
export interface NewsSource {
  readonly name: string;
  readonly kind: NewsSourceKind;
  readonly supportsSearch: boolean;
  /** The headline path. Never throws: trouble is reported in `problems`. */
  latest(query: NewsQuery): Promise<NewsLookup>;
  /** The free-text path. Present only when `supportsSearch` is true. */
  search?(query: NewsQuery): Promise<NewsLookup>;
}

/** A clock, injectable so every judgement in this package is deterministic under test. */
export type Clock = () => Date;

/** The reason an item was not offered as something to talk about (pack §6's four requirements). */
export type ProactiveRejection =
  | 'stale'
  | 'undated'
  | 'not_relevant'
  | 'already_mentioned'
  | 'quiet_context'
  /** 铁律 8: text that tries to give the assistant orders is data, but it is never a topic. */
  | 'instruction_like';

/** The four requirements, judged. `ok: false` always names exactly one reason. */
export interface ProactiveJudgement {
  readonly ok: boolean;
  readonly reason?: ProactiveRejection;
  /** A sentence a human can read in a log: which rule said no, and about what. */
  readonly detail: string;
  /** How good the candidate is when it passes; 0 when it does not. */
  readonly score: number;
  /** Which interests matched — the evidence behind 「personally relevant」. */
  readonly matched?: readonly string[];
}

/** The plugin's own view of a tool it contributes, kept next to the tool for tests and health. */
export interface NewsToolBundle {
  readonly tools: readonly AgentTool[];
  /** The names in declaration order: `news.search`, `news.latest`, `news.for_interests`. */
  readonly names: readonly string[];
}
