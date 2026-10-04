/**
 * The news plugin — pack `03_AGENT_PLUGIN.md` §6 on top of §2/§3.
 *
 * The manifest is where the acceptance criterion 「news 若要额外能力必须显式声明并说明理由，不要默默改默认值」
 * is answered, so read it line by line:
 *
 * ```json
 * { "schemaVersion": 1, "id": "xixi.news", "name": "News", "version": "0.1.0",
 *   "permissions": ["network", "tool.register", "topic.read"],
 *   "requiredPermissions": ["network", "tool.register", "topic.read"],
 *   "capabilities": ["tool", "topic_source"],
 *   "health": { "requires": ["news.search", "news.latest", "news.for_interests", "news.topics"] } }
 * ```
 *
 *  * `tool` needs `tool.register` and `topic_source` needs `topic.read` — that pairing is
 *    `CAPABILITY_PERMISSIONS`'s, not this file's, so asking for the capabilities without the
 *    permissions is refused before anything loads.
 *  * `network` is the extra one, and it has a reason: two of pack §6's three source families (RSS
 *    and public API) are HTTP. A deployment that only uses the offline stub still declares it —
 *    a manifest describes what the plugin *may* do, and one that grows a network call at run time
 *    without having said so is exactly what the permission step exists to prevent. `requiredPermissions`
 *    repeats the list so the *static* half of that check also fires (a requirement not covered by
 *    `permissions` refuses the manifest at validate time).
 *  * nothing else is declared. No `storage`, so `ctx.storage` throws if this plugin ever reaches for
 *    it — which is how 「不得把整段新闻正文无节制地记进长期记忆」 (铁律 4/5) is more than a promise:
 *    the plugin has no place to put an article, and the only memory-shaped thing it produces is a
 *    bounded digest (`toMemoryDigest`).
 *
 * Tool scopes stay at the plugin default (`['conversation']`, see `CapabilityRegistry`): the news
 * tools are for turns with a person. The proactive path is the topic source, which the engine reads
 * directly and which does not run anything on the model's behalf.
 */
import type { PluginContribution, TopicSource } from '../src/capability-registry.ts';
import type { PluginContext } from '../src/context.ts';
import type { InlinePlugin, PluginModuleShape } from '../src/discovery.ts';

import { createNewsDesk, type MentionLedger, type NewsDesk } from './desk.ts';
import { createNewsTools, NEWS_FOR_INTERESTS_TOOL, NEWS_LATEST_TOOL, NEWS_SEARCH_TOOL, type NewsToolOptions } from './tools.ts';
import { createNewsTopicSource, NEWS_TOPIC_SOURCE_NAME } from './topic-source.ts';
import type { QuietHours } from './proactive.ts';
import type { Clock, NewsSource, NewsToolBundle } from './types.ts';

export const NEWS_PLUGIN_ID = 'xixi.news';

/** What a source factory is handed once the plugin is activated (and its grants exist). */
export interface NewsSourceEnv {
  /** The `network` grant's fetch. Never the global: the host owns the grant, and it is auditable. */
  readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly log: (message: string) => void;
  readonly now: Clock;
}

/**
 * A source, or a function that builds one from the activation environment.
 *
 * The factory form is what lets a real RSS source use the granted `fetch` **without** this file
 * importing anything about HTTP: `createRssNewsSource` is called with `env.fetchImpl` at activate
 * time, and the plugin never holds a fetch before then.
 */
export type NewsSourceEntry = NewsSource | ((env: NewsSourceEnv) => NewsSource | readonly NewsSource[]);

export interface NewsPluginOptions {
  readonly sources: readonly NewsSourceEntry[];
  /** What the household cares about. Empty is honest: nothing is provably relevant yet. */
  readonly interests?: readonly string[];
  readonly ledger?: MentionLedger;
  readonly quietHours?: QuietHours;
  readonly presence?: () => boolean | undefined;
  readonly defaultTopic?: string;
  readonly maxAgeMinutes?: number;
  readonly maxLimit?: number;
  readonly now?: Clock;
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
}

/** The live view, for health checks, probes and tests. */
export interface NewsPluginState {
  readonly active: boolean;
  readonly sources: readonly { readonly name: string; readonly kind: string; readonly supportsSearch: boolean }[];
  readonly tools: NewsToolBundle;
  readonly topicSource: TopicSource;
  readonly desk: NewsDesk;
}

export interface NewsPluginHandle {
  /** Hand this to `PluginManager.loadInline()`. */
  readonly plugin: InlinePlugin;
  /** What the plugin holds right now (empty source list until activated). */
  state(): NewsPluginState;
}

/**
 * Build the news plugin. Nothing is fetched here: sources are resolved in `activate()`, so a bad
 * feed URL is a *health* fact (a `problems` entry and zero items) instead of a startup crash —
 * the same contract the MCP adapter follows.
 */
export function createNewsPlugin(options: NewsPluginOptions): NewsPluginHandle {
  const now = options.now ?? (() => new Date());
  // One mutable list, shared with the desk: activation fills it, deactivation empties it. The desk
  // reads it per call, so there is no second copy of "which sources are live" to drift.
  const live: NewsSource[] = [];
  const desk = createNewsDesk({
    sources: live,
    now,
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    ...(options.maxLimit === undefined ? {} : { maxLimit: options.maxLimit }),
  });
  const toolOptions: NewsToolOptions = {
    desk,
    now,
    ...(options.interests === undefined ? {} : { interests: options.interests }),
    ...(options.defaultTopic === undefined ? {} : { defaultTopic: options.defaultTopic }),
    ...(options.maxLimit === undefined ? {} : { maxLimit: options.maxLimit }),
  };
  const tools = createNewsTools(toolOptions);
  const topicSource = createNewsTopicSource({
    desk,
    ledger: desk.ledger,
    interests: options.interests ?? [],
    ...(options.quietHours === undefined ? {} : { quietHours: options.quietHours }),
    ...(options.presence === undefined ? {} : { presence: options.presence }),
    ...(options.maxAgeMinutes === undefined ? {} : { maxAgeMinutes: options.maxAgeMinutes }),
  });
  const kinds: string[] = [];

  const module: PluginModuleShape = {
    activate: (context) => {
      const ctx = context as PluginContext;
      live.length = 0;
      kinds.length = 0;
      const env: NewsSourceEnv = {
        fetchImpl: (input, init) => ctx.network.fetch(input, init),
        log: (message) => ctx.log(message),
        now,
      };
      for (const entry of options.sources) {
        const resolved = typeof entry === 'function' ? entry(env) : entry;
        for (const source of Array.isArray(resolved) ? resolved : [resolved]) live.push(source);
      }
      for (const source of live) kinds.push(`${source.name}(${source.kind})`);
      ctx.log(`news.activate 来源 ${live.length} 个：${kinds.length === 0 ? '（没有配置）' : kinds.join('、')}`);
      const contribution: PluginContribution = {
        tools: tools.tools.map((tool) => ({ tool })),
        topicSources: [topicSource],
      };
      return contribution;
    },
    health: () => {
      if (live.length === 0) return { status: 'degraded' as const, detail: '没有配置任何新闻来源（news.active=false）' };
      const offline = live.filter((source) => source.kind === 'stub').length;
      return {
        status: 'ok' as const,
        detail: `${live.length} 个来源在册：${kinds.join('、')}${offline === live.length ? '（全部是离线桩）' : ''}`,
      };
    },
    deactivate: () => {
      live.length = 0;
      kinds.length = 0;
    },
  };

  const manifest = {
    schemaVersion: 1,
    id: options.id ?? NEWS_PLUGIN_ID,
    name: options.name ?? 'News',
    version: options.version ?? '0.1.0',
    permissions: ['network', 'tool.register', 'topic.read'],
    requiredPermissions: ['network', 'tool.register', 'topic.read'],
    capabilities: ['tool', 'topic_source'],
    health: { requires: [NEWS_SEARCH_TOOL, NEWS_LATEST_TOOL, NEWS_FOR_INTERESTS_TOOL, NEWS_TOPIC_SOURCE_NAME], intervalMs: 300_000 },
  };

  return {
    plugin: { manifest, module },
    state: () => ({
      active: live.length > 0,
      sources: desk.sources(),
      tools,
      topicSource,
      desk,
    }),
  };
}
