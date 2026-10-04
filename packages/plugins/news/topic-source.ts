/**
 * The `topic_source` capability — pack §6's 「News 同时可以提供 TopicSource」.
 *
 * A topic source is not a tool and not a turn: it is a **proposal**. The engine ranks proposals
 * against every other source (open threads, routine, presence) and decides whether to open its
 * mouth at all (铁律 3: hard limits are the program's, "should I speak" is the model's). So this file
 * does three things and stops:
 *
 *  * reads the current items from the desk — the same items `news.latest` would return, so the two
 *    paths cannot disagree about what today's news is;
 *  * applies pack §6's four requirements (`proactive.ts`), each with a named reason;
 *  * returns candidates with the reason and score attached (铁律 5: a decision leaves `reason_code`
 *    and a score, not a sentence of private reasoning).
 *
 * What it deliberately does **not** do: write to the mention ledger. Proposing a topic is not
 * mentioning it — if proposals counted as mentions, the second proposal would always be empty.
 */
import type { TopicCandidate, TopicSource } from '../src/capability-registry.ts';

import type { NewsDesk, MentionLedger } from './desk.ts';
import { proposeNewsTopics, type ProactiveContext, type QuietHours } from './proactive.ts';
import type { NewsItem } from './types.ts';

/** The name this capability registers under (`health.requires` names it too). */
export const NEWS_TOPIC_SOURCE_NAME = 'news.topics';

export interface NewsTopicSourceOptions {
  readonly desk: NewsDesk;
  readonly interests: readonly string[];
  /** Injected rather than read here: the ledger belongs to the desk (and to the host behind it). */
  readonly ledger: MentionLedger;
  readonly quietHours?: QuietHours;
  /** Whether anyone is home. A function because the answer changes between proposals. */
  readonly presence?: () => boolean | undefined;
  readonly maxAgeMinutes?: number;
  readonly limit?: number;
  /** Provenance string stamped on every candidate. */
  readonly source?: string;
}

export function createNewsTopicSource(options: NewsTopicSourceOptions): TopicSource {
  return {
    name: NEWS_TOPIC_SOURCE_NAME,
    async propose(input): Promise<readonly TopicCandidate[]> {
      const limit = Math.max(1, input.limit > 0 ? input.limit : (options.limit ?? 3));
      const snapshot = await options.desk.latest({ limit: limit * 3 });
      const items: readonly NewsItem[] = snapshot.items;
      const context: ProactiveContext = {
        now: input.now,
        timezone: input.timezone,
        interests: options.interests,
        ledger: options.ledger,
        ...(options.presence === undefined ? {} : { present: options.presence() }),
        ...(options.quietHours === undefined ? {} : { quietHours: options.quietHours }),
        ...(options.maxAgeMinutes === undefined ? {} : { maxAgeMinutes: options.maxAgeMinutes }),
      };
      return proposeNewsTopics({ items, context, limit, source: options.source ?? 'news' });
    },
  };
}
