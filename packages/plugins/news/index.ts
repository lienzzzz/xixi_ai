/**
 * `@xixi/plugins/news` — pack `03_AGENT_PLUGIN.md` §6: the real news capability, as a plugin.
 *
 * ```text
 * news.search   news.latest   news.for_interests      (+ a TopicSource)
 * ```
 *
 * The built-in `xixi_news_stub` is **gone** (P2-D): there is no news seam left in
 * `@xixi/brain-adapter`, and the three names above are the whole surface. They are ordinary
 * `AgentTool`s contributed through the P2-A lifecycle, so `ToolPermission`, the round cap and
 * `executeTool`'s timeout apply to them exactly as they do to the four built-ins — a plugin does
 * not get a second tool path.
 *
 * What each file owns:
 *
 *  * `types.ts` — the provider contract (RSS / public API / web-search all fit it).
 *  * `rss.ts` — a dependency-free RSS/Atom reader (the real source; a dead feed is a `problems` entry).
 *  * `json-api.ts` — a public JSON API adapter with a mapper seam, plus a working HN mapper.
 *  * `web-search.ts` — an adapter over an **injected** search engine (this repo has none of its own).
 *  * `stub.ts` — the offline source that lets pack §6's four requirements be pinned in the default gate.
 *  * `desk.ts` — merges sources, dedupes, keeps the host's mention ledger.
 *  * `untrusted.ts` — 铁律 8: external text is data, bounded, flagged, and never an instruction channel.
 *  * `proactive.ts` — fresh / personally relevant / not already mentioned / not quiet context.
 *  * `tools.ts`, `topic-source.ts`, `plugin.ts` — the three tools, the `topic_source` capability, and
 *    the manifest that declares `tool` + `topic_source` + `network` with reasons.
 *
 * **接线状态（诚实口径，AGENTS §9.24）**：本模块是一个完整的插件（manifest 与九步生命周期都走 P2-A 的
 * `PluginManager`），离线端到端证据在 `tests/unit/core/tool-loop.test.ts` 与
 * `node scripts/probe-tools.ts --news` 里。它在装配点上的开关是 `@xixi/runtime` 的
 * `buildPluginRuntime(config, { news: … })`。
 *
 * **入口侧已接（V0.3 P2.5-C 起）**：七个入口脚本都经 `createResidentRuntime()` 取链，而
 * `scripts/chat.ts` 等四个入口显式给了 `news.sources`，所以 `news.*` 真的出现在模型可见的工具清单里。
 * 复核：`node scripts/chat.ts --print-wiring`（应列出 `news.search` / `news.latest` / `news.for_interests`）、
 * `git grep -n 'createRssNewsSource' -- scripts`。第二句是「插件话题进主动路径」，那一条**尚未**由入口接
 * （`git grep -n 'readPluginTopics' -- scripts` 零命中）——不要把它与「新闻工具可用」混为一谈。
 */
export {
  createNewsDesk,
  createMentionLedger,
  interestMatches,
  type MentionLedger,
  type NewsDesk,
  type NewsDeskOptions,
  type NewsDeskResult,
} from './desk.ts';
export { createJsonApiNewsSource, hackerNewsItems, hackerNewsQuery, type JsonApiSourceOptions, type MappedItems } from './json-api.ts';
export { createNewsPlugin, NEWS_PLUGIN_ID, type NewsPluginHandle, type NewsPluginOptions, type NewsPluginState, type NewsSourceEntry, type NewsSourceEnv } from './plugin.ts';
export {
  DEFAULT_FUTURE_SKEW_MINUTES,
  DEFAULT_MAX_AGE_MINUTES,
  insideQuietHours,
  judgeAlreadyMentioned,
  judgeFreshness,
  judgeInstructionLike,
  judgeNewsItem,
  judgeQuietContext,
  judgeRelevance,
  minutesOfDay,
  parseClock,
  proposeNewsTopics,
  type ProactiveContext,
  type ProposeTopicsInput,
  type QuietHours,
} from './proactive.ts';
export { createRssNewsSource, decodeEntities, feedBlocks, feedTitle, itemId, parseFeedDate, parseFeedDocument, type FeedDocumentResult, type RssSourceOptions } from './rss.ts';
export { createStubNewsSource, stubItem, type StubSourceOptions } from './stub.ts';
export {
  createNewsTools,
  NEWS_FOR_INTERESTS_TOOL,
  NEWS_LATEST_TOOL,
  NEWS_SEARCH_TOOL,
  NEWS_TOOL_TIMEOUT_MS,
  type NewsToolOptions,
} from './tools.ts';
export { createNewsTopicSource, NEWS_TOPIC_SOURCE_NAME, type NewsTopicSourceOptions } from './topic-source.ts';
export type {
  Clock,
  NewsItem,
  NewsLookup,
  NewsQuery,
  NewsSource,
  NewsSourceKind,
  NewsToolBundle,
  ProactiveJudgement,
  ProactiveRejection,
} from './types.ts';
export {
  assertNoInstructionChannel,
  asExternalItem,
  detectInstructionLike,
  explainFlags,
  EXTERNAL_DATA_NOTE,
  FORBIDDEN_PAYLOAD_KEYS,
  INSTRUCTION_PATTERNS,
  MAX_DIGEST_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
  sanitizeExternalText,
  toMemoryDigest,
  type ExternalItemOptions,
  type ExternalItemPayload,
  type InstructionPattern,
  type NewsDigest,
  type SanitizedText,
} from './untrusted.ts';
