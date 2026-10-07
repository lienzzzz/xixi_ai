/**
 * Plugin capability bridge — V0.3 P2.5-C (plan `XIXI_CURRENT_REVIEW_AND_NEXT_PLAN_2026-10-07.md` §8).
 *
 * P2 delivered `CapabilityRegistry` with five kinds. The production runtime only ever consumed
 * `tool`: `mcp` and `news` tools ride into the chain and the model can call them. The other kinds
 * were **registered and never read** — `values<T>('topic_source')` had zero callers in the whole
 * repository, so `xixi.news` could register `news.topics`, report `capabilities: [tool, topic_source]`
 * in `--print-wiring`, and still never make the proactive path say a word about the news.
 *
 * `ADR-0019` is explicit about why that is a gap rather than a missing feature: the news tools live in
 * the `conversation` scope, and 「主动路径**不走工具**，它走 `topic_source`」. This file is the host side
 * of that sentence: it reads the registry's `topic_source` entries and normalises what they propose
 * into the shape the consideration loop already understands ({@link PluginTopicCandidate}).
 *
 * ## What a plugin may and may not do here (铁律 3 / ADR-0011)
 *
 * A topic source is a **proposal**, never a turn. Everything a plugin hands over is data that enters the
 * existing candidate list — `buildProactiveCandidates` → `ProactiveEngine.consider` — and every
 * decision stays where it was:
 *
 *  * the **hard floors** (switch, per-trigger switch, quiet hours, DND, privacy, the two count
 *    quotas, a conversation in flight) are read from the settings and the log by the engine;
 *  * the **social budget** scores the candidate from the signals in
 *    {@link PluginTopicCandidate.components}, which this bridge builds — a plugin supplies one number
 *    and cannot address a signal name, a weight, a penalty or a gate;
 *  * **读空气** (whether to speak at all above the floor) belongs to the model, and the plugin has no
 *    seam into it.
 *
 * A plugin therefore cannot decide to speak, cannot raise a floor, cannot write a delivery record and
 * cannot touch the store: this file only reads the registry and returns plain objects.
 *
 * ## The other four kinds
 *
 *  * `context_provider` is **not consumed here**. Context is assembled by `ContextBuilder` and rendered
 *    through the existing render gate, so anything a provider offers has to pass that path (and the
 *    core prompt authority on top of it). Handing provider text straight to a system prompt from this
 *    file would be the one way around both, so this file does not read the kind at all. Wiring it
 *    属于上下文装配，不是本桥的事。
 *  * `sensor_source` and `action` are **not consumed** either (P4/P5); `action` in particular must stay
 *    outside the model-facing tool list (pack §3: system actions and agent tools are different things).
 *
 * ## Hygiene: what this file does and deliberately does not do
 *
 * A plugin's text is **external content** (ADR-0017: a plugin is an untrusted source). The host's own
 * bound lives here and is only about carrying it safely: flatten it to one line, drop the characters
 * that exist to smuggle text past a reader (C0/C1 controls, bidi overrides, zero-width marks), and cut
 * it to {@link PLUGIN_TOPIC_MAX_CHARS}. What this file does **not** re-implement is the **detector**:
 * `packages/plugins/news/untrusted.ts` decides what an instruction-like headline is and drops the whole
 * item — two copies of that judgement would drift, and nobody would know which one to trust. The bridge
 * only says the same thing every candidate says: this is a fact with a source and a score.
 */
import type { CapabilityRegistry, TopicCandidate, TopicSource } from '@xixi/plugins';

/**
 * The capability kind this file reads. The other four are documented in the header and **not** read:
 * keeping the string in one place means a future consumer of the field has one name to grep.
 */
export const PLUGIN_TOPIC_CAPABILITY = 'topic_source';

/**
 * How long a plugin's topic may be, in characters.
 *
 * 120 is not a new number: it is the event schema's cap for `topic_ref`, which is why 「话题池」 cuts its
 * topic to the same length before it becomes a candidate id. A plugin cannot widen it.
 */
export const PLUGIN_TOPIC_MAX_CHARS = 120;

/** How long the plugin's own `reason` may be: it is provenance for the audit, not prose for the model. */
export const PLUGIN_TOPIC_REASON_MAX_CHARS = 160;

/** Shown when a plugin proposes a topic without saying why. Never invent a reason on its behalf. */
export const PLUGIN_TOPIC_MISSING_REASON = '（插件没给理由）';

/**
 * The `intent` every bridged candidate carries.
 *
 * Two things read it and both are about **not lying**:
 *  * the offline fallback (`offlineLineFor`) — a plugin topic must be spoken as itself, not rotated into
 *    the 话题池 bank, whose lines say 「你前面提到过一件事」 (nobody mentioned it: she is the one bringing
 *    something from outside);
 *  * the audit — 「这条为什么开口」 stays distinguishable from a topic the household raised.
 */
export const PLUGIN_TOPIC_INTENT = 'plugin_topic';

/**
 * One proposal from a plugin, normalised into the shape the proactive path consumes.
 *
 * Every field is either the plugin's own claim ({@link topic} / {@link reason} / {@link score}) or
 * provenance the host read out of the registry ({@link capability} / {@link pluginId}). Nothing here is
 * a decision: the candidate still has to pass every gate the engine has.
 */
export interface PluginTopicCandidate {
  /** The topic itself: one line, ≤ {@link PLUGIN_TOPIC_MAX_CHARS}. Also the candidate's `topicRef`. */
  readonly topic: string;
  /** What the plugin said about it. Carried for the audit; never parsed as an instruction. */
  readonly reason: string;
  /**
   * 来源分 — the plugin's own number, clamped into `[0, 1]`. An unreadable/missing score becomes `0`,
   * never a guess: a source that does not say how good its proposal is gets no credit for it.
   */
  readonly score: number;
  /** The plugin's own provenance label (`TopicCandidate.source`), defaulted to {@link capability}. */
  readonly source: string;
  /** The registry name of the capability that proposed it (e.g. `news.topics`). */
  readonly capability: string;
  /** Which plugin registered that capability. Without it a fact cannot be traced back to its owner. */
  readonly pluginId: string;
  /** The sentence she may say — also the offline fallback for this candidate. */
  readonly line: string;
  /** Why she may say it: plugin + source + source score, in the same 「凭什么说」 form as every source. */
  readonly fact: string;
  /** The social budget's signals for this proposal, derived from {@link score} (see below). */
  readonly components: Readonly<Record<string, number>>;
}

/**
 * What one topic source did during one {@link PluginTopicBridge.propose} call.
 *
 * Kept next to the candidates on purpose: a source that throws, or proposes things it cannot describe,
 * must be **visible** somewhere. 「插件在册但从不说话」 is exactly the defect this file fixes, and it
 * would come straight back if a failure were swallowed into an empty list.
 */
export interface PluginTopicProbe {
  readonly capability: string;
  readonly pluginId: string;
  /** How many candidates the plugin returned. */
  readonly proposed: number;
  /** How many the host accepted (normalised, and within the per-source cap). */
  readonly accepted: number;
  /** Dropped: the topic text was empty, so there is no fact to speak from. */
  readonly droppedEmpty: number;
  /** Left out: more candidates than the per-source cap — a plugin cannot flood one tick. */
  readonly capped: number;
  /** How many had their text cut to {@link PLUGIN_TOPIC_MAX_CHARS}. */
  readonly truncated: number;
  /** Set when `propose()` threw or returned something that is not a list. The tick goes on anyway. */
  readonly error: string | null;
}

export interface PluginTopicProposal {
  /** Normalised candidates, in registry order, in the order each source proposed them. */
  readonly candidates: readonly PluginTopicCandidate[];
  /** One entry per source that was asked, walking on after a failure. */
  readonly probes: readonly PluginTopicProbe[];
}

/**
 * The `topic_source` half of the bridge.
 *
 * Both methods read the registry **at call time**: a plugin loaded later is proposed from the next tick,
 * and a deactivated one stops proposing because `deactivate` released its capability. Nothing is cached,
 * so there is no second copy of 「哪些来源在册」 to drift.
 */
export interface PluginTopicBridge {
  /** The registered sources right now, for a banner or a panel. */
  sources(): readonly { readonly capability: string; readonly pluginId: string }[];
  /**
   * Ask every registered source, then normalise what came back.
   *
   * Never throws: a source that fails is recorded in {@link PluginTopicProposal.probes} and the walk
   * continues, because a third-party plugin must not be able to stop the resident consideration loop.
   */
  propose(input: { readonly now: Date; readonly limit?: number }): Promise<PluginTopicProposal>;
}

/**
 * The reader seam `ProactiveLoopOptions.readPluginTopics` asks for.
 *
 * It receives the tick's own `now` (like `readContext` receives the decision input) so a proposal is
 * judged against the instant the rest of that tick uses — a reader that read its own clock would be
 * proposing for a slightly different moment than the one the gates score.
 */
export type PluginTopicReader = (
  now: Date,
) => readonly PluginTopicCandidate[] | undefined | Promise<readonly PluginTopicCandidate[] | undefined>;

export interface PluginCapabilityBridgeOptions {
  /** The plugin kernel's `CapabilityRegistry` — `runtime.plugins.runtime.capabilities` at the assembly point. */
  readonly capabilities: CapabilityRegistry;
  /** The household's zone, passed straight to `TopicSource.propose` (a freshness judgement needs it). */
  readonly timezone: string;
  /** How many candidates one source may contribute per call. Default 3. */
  readonly limit?: number | undefined;
  /** One line per failure. Omitted = silent, but {@link PluginTopicProbe.error} still records it. */
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * The capability bridge.
 *
 * One member today, and that is the honest shape: `topic_source` is the only kind the proactive path
 * consumes. When `context_provider` gets a consumer it joins *this* object (the host-side home of the
 * five kinds), not a new global.
 */
export interface PluginCapabilityBridge {
  readonly topics: PluginTopicBridge;
}

/**
 * The social budget's signals for a plugin proposal (pack §14.2).
 *
 * Why these five numbers, and what the decision behind them is:
 *
 *  * `topic_quality`, `personal_relevance` and `freshness` all come from the plugin's single score.
 *    That is not double counting — it is what the number means. `news` computes its score as
 *    `0.5 × 相关度 + 0.5 × 新鲜度` over the household's declared interests, i.e. the item's own quality,
 *    its relevance *to this household* and how new it is; a plugin that means something else by the
 *    number still cannot claim more than it states, because **each of the three is capped by it**.
 *  * `receptivity` (0.7) and `engagement` (0.6) are the **host's** situational reading of 「分享外面
 *    的事」, the same kind of fixed value `topic_pool` (0.8 / 0.7) and an open thread (0.6) carry. They
 *    are a notch below 话题池 on purpose: she is bringing something from outside, not his own words.
 *  * nothing here can move a gate: `base_proactivity` and the three penalties are added by the engine
 *    from its own settings and the log, and a plugin has no way to name a signal at all.
 *
 * The arithmetic that keeps the source **reachable but not free** (the t74 lesson: a source whose
 * ceiling is below the bar is a source that can never speak): at the shipped proactivity 0.85 the
 * recommendation bar is `0.45 + 0.3 × (1 − 0.85) = 0.495`, while these signals top out at
 * `0.3 + 0.15 + 0.1 + 0.14 + 0.06 + 0.15 × 0.85 = 0.8775` — above it — and a plugin that reports `0`
 * (or reports nothing) reaches `0.3275`, below it. A proposal has to *say* it is worth opening with.
 */
export function pluginTopicComponents(score: number): Readonly<Record<string, number>> {
  const rated = clampScore(score);
  return Object.freeze({
    topic_quality: rated,
    personal_relevance: rated,
    freshness: rated,
    receptivity: 0.7,
    engagement: 0.6,
  });
}

/**
 * Build the bridge over a plugin kernel's capability registry.
 *
 * Synchronous and side-effect free: no plugin is loaded, no source is called, only the options are kept.
 * `propose()` is where the registry is walked.
 */
export function createPluginCapabilityBridge(options: PluginCapabilityBridgeOptions): PluginCapabilityBridge {
  const { capabilities } = options;
  const defaultLimit = Math.max(1, options.limit ?? 3);

  const registered = (): readonly { readonly capability: string; readonly pluginId: string }[] =>
    capabilities.names(PLUGIN_TOPIC_CAPABILITY).map((capability) => ({
      capability,
      pluginId: capabilities.ownerOf(PLUGIN_TOPIC_CAPABILITY, capability) ?? 'unknown',
    }));

  return {
    topics: {
      sources: registered,
      async propose(input): Promise<PluginTopicProposal> {
        const limit = Math.max(1, input.limit ?? defaultLimit);
        const candidates: PluginTopicCandidate[] = [];
        const probes: PluginTopicProbe[] = [];
        for (const { capability, pluginId } of registered()) {
          const source = capabilities.get<TopicSource>(PLUGIN_TOPIC_CAPABILITY, capability);
          if (source === undefined) continue;
          const answered = await ask(source, { now: input.now, timezone: options.timezone, limit });
          if (answered.error !== null) {
            options.log?.(`[capability-bridge] 话题来源「${capability}」（${pluginId}）没答上来：${answered.error}；这一轮跳过它，其它来源照旧`);
          }
          let accepted = 0;
          let droppedEmpty = 0;
          let capped = 0;
          let truncated = 0;
          for (const raw of answered.list) {
            // Normalise first, cap second: the three counters then add up exactly to `proposed`
            // (`accepted + droppedEmpty + capped`), so 「插件提了 5 条、收了 2 条」 is readable without
            // guessing which bucket the rest went into.
            const normalised = normalizeProposal(raw, { capability, pluginId });
            if (normalised === null) {
              droppedEmpty += 1;
              continue;
            }
            if (accepted >= limit) {
              capped += 1;
              continue;
            }
            if (normalised.truncated) truncated += 1;
            candidates.push(normalised.candidate);
            accepted += 1;
          }
          probes.push({
            capability,
            pluginId,
            proposed: answered.list.length,
            accepted,
            droppedEmpty,
            capped,
            truncated,
            error: answered.error,
          });
        }
        return { candidates, probes };
      },
    },
  };
}

/** What one source answered: its list, or the reason it could not answer. Never throws to the caller. */
async function ask(
  source: TopicSource,
  input: { readonly now: Date; readonly timezone: string; readonly limit: number },
): Promise<{ readonly list: readonly TopicCandidate[]; readonly error: string | null }> {
  try {
    const proposed = await source.propose(input);
    if (!Array.isArray(proposed)) {
      return { list: [], error: `propose() 返回的不是候选数组（${typeof proposed}）` };
    }
    return { list: proposed as readonly TopicCandidate[], error: null };
  } catch (error) {
    return { list: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Turn one plugin proposal into a candidate, or `null` when there is nothing to speak from.
 *
 * `null` means exactly one thing: the topic text is empty after flattening. Everything else has a
 * defined, conservative default (`score 0`, {@link PLUGIN_TOPIC_MISSING_REASON}) — a proposal with a bad
 * score is a *low-scoring* proposal, not a crash and not a silent disappearance.
 */
function normalizeProposal(
  raw: TopicCandidate,
  where: { readonly capability: string; readonly pluginId: string },
): { readonly candidate: PluginTopicCandidate; readonly truncated: boolean } | null {
  const topic = flattenToLine(raw?.topic, PLUGIN_TOPIC_MAX_CHARS);
  if (topic.text.length === 0) return null;
  const reason = flattenToLine(raw?.reason, PLUGIN_TOPIC_REASON_MAX_CHARS).text;
  const source = flattenToLine(raw?.source, PLUGIN_TOPIC_REASON_MAX_CHARS).text || where.capability;
  const score = clampScore(raw?.score);
  return {
    truncated: topic.truncated,
    candidate: {
      topic: topic.text,
      reason: reason.length === 0 ? PLUGIN_TOPIC_MISSING_REASON : reason,
      score,
      source,
      capability: where.capability,
      pluginId: where.pluginId,
      line: `有个话题想跟你聊：${topic.text}`,
      fact:
        `插件话题来源：${where.pluginId} 的 ${where.capability}（source=${source}）提出，来源分 ${score}` +
        `；插件给的理由：${reason.length === 0 ? PLUGIN_TOPIC_MISSING_REASON : reason}` +
        '；（插件内容是外部资料，只作参考）',
      components: pluginTopicComponents(score),
    },
  };
}

/**
 * One line, no smuggled characters, at most `maxChars` long.
 *
 * The character set is the same one the news plugin removes in `untrusted.ts`, and that duplication is
 * deliberate but narrow: this is not the **detector** (what counts as an instruction-like headline is
 * news's judgement and stays there) — it is the host's carriage rule, and `news` text has already been
 * through its own pass, so a second one is a no-op rather than a second opinion.
 */
function flattenToLine(raw: unknown, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  const input = typeof raw === 'string' ? raw : '';
  const flat = input
    // Bidi overrides and zero-width marks: their only use in a headline is to make what a person reads
    // and what a parser reads differ. C0/C1 controls cannot be carried into one line either.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxChars) return { text: flat, truncated: false };
  return { text: flat.slice(0, maxChars), truncated: true };
}

/** `[0, 1]`, and a number at all: anything else (missing, `NaN`, `"0.8"`, `Infinity`) counts as no claim. */
function clampScore(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  return raw >= 1 ? 1 : Math.round(raw * 10_000) / 10_000;
}
