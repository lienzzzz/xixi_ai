/**
 * Multi-segment replies（ADR-0010）— the deterministic splitter.
 *
 * One user turn may be spoken as 1..N short segments with a natural pause between
 * them, but it stays **one turn**: nothing here touches the state machine or the
 * event log. Splitting is a pure function of the text plus limits, so the same
 * reply always splits the same way (replay-friendly) and the model never decides
 * segment counts — it cannot perceive playback time.
 *
 * The limits are hard ceilings: callers may tighten them, never exceed them
 * (ADR-0010 §3). A caller asking for 40 segments gets 8 and a merged tail; the
 * concatenation invariant (`segments.join('') === normalizeReplyText(text)`) holds
 * for every input, including the clamped ones.
 *
 * P1 (2026-10-01) raised the segment ceiling from 3 to 8 and left `segmentMaxChars`
 * at 60, because the two numbers mean different things:
 *   * `segmentMaxChars` is how much is spoken in one breath between two audible
 *     pauses — a playback chunk size, not a limit on what she may say;
 *   * `maxSegments × segmentMaxChars` was, in V0.1, an accidental **reply-length
 *     ceiling** of 180 characters (baseline §2.5: 9/19 turns sat right against it).
 *     A long explanation (4–6 sentences, or one story) needs room, so the capacity is
 *     now 8 × 60 = 480 characters while the spoken rhythm stays the same.
 *
 * Where the two ceilings still cannot both hold — a reply longer than the capacity —
 * the invariant "never add or delete a character" (M4) wins: the tail merges into
 * the last allowed segment, that segment goes over `segmentMaxChars`, and
 * `mergedOverflow` reports it. Every reply that fits the capacity has all segments
 * within the ceiling — see the boundary tests.
 */

import { SILENCE_TOKEN } from './prompt.ts';

export const REPLY_LIMITS = Object.freeze({
  /** Hard ceiling on segments per turn (ADR-0010 M1, raised 3 → 8 in P1). */
  maxSegments: 8,
  /** Hard ceiling on characters per segment; CJK text, so "characters" = code points (M2). */
  segmentMaxChars: 60,
  /** Pause between segments, from the end of the previous one (M3). */
  minGapMs: 250,
  maxGapMs: 1200,
  defaultGapMs: 450,
});

export interface ReplySegmentOptions {
  readonly maxSegments?: number;
  readonly segmentMaxChars?: number;
  readonly gapMs?: number;
}

/**
 * Turn the `reply` block of `config/xixi.example.yaml` into limits.
 *
 * ADR-0010 §3: the config section may only **tighten** the hard ceilings, so
 * every value is clamped into the range `REPLY_LIMITS` allows. Anything
 * unusable (a string, a negative number, a missing key) falls back to the
 * documented default rather than crashing a conversation — the limits are a
 * tuning knob, not a safety boundary, and the safety boundary (the clamp) is
 * applied regardless. `override` is the explicit test/replay seam and wins over
 * the config, but it is clamped the same way: a caller cannot raise a ceiling
 * either.
 */
export function resolveReplyLimits(
  config?: Readonly<Record<string, unknown>> | undefined,
  override?: ReplySegmentOptions | undefined,
): ReplySegmentOptions {
  const merged: ReplySegmentOptions = {
    maxSegments: override?.maxSegments ?? numericField(config, 'max_segments'),
    segmentMaxChars: override?.segmentMaxChars ?? numericField(config, 'segment_max_chars'),
    gapMs: override?.gapMs ?? numericField(config, 'gap_ms'),
  };
  return {
    maxSegments: clampInt(merged.maxSegments, REPLY_LIMITS.maxSegments, 1, REPLY_LIMITS.maxSegments),
    segmentMaxChars: clampInt(merged.segmentMaxChars, REPLY_LIMITS.segmentMaxChars, 1, REPLY_LIMITS.segmentMaxChars),
    gapMs: clampInt(merged.gapMs, REPLY_LIMITS.defaultGapMs, REPLY_LIMITS.minGapMs, REPLY_LIMITS.maxGapMs),
  };
}

function numericField(source: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface SegmentedReply {
  /** In order; `join('')` equals `normalizeReplyText(text)`. Empty only for empty input. */
  readonly segments: readonly string[];
  /** Pause to leave between consecutive segments. */
  readonly gapMs: number;
  /** True when a caller asked for more segments than the hard ceiling allows. */
  readonly mergedOverflow: boolean;
}

/**
 * The text a reply is split from. Line breaks are dropped and the ends trimmed,
 * so a paragraph pasted by the model does not become one giant segment; nothing
 * else changes, which is what makes `segments.join('') === normalizeReplyText(text)`
 * a meaningful assertion (M4).
 */
export function normalizeReplyText(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, '').trim();
}

const SENTENCE = /[^。！？!?…]+[。！？!?…]*/g;

/** Cut after sentence enders, keeping the punctuation attached to its sentence. */
function sentencesOf(text: string): string[] {
  const matches = text.match(SENTENCE);
  return matches === null || matches.length === 0 ? [text] : matches;
}

/** Hard-split one over-long sentence at the ceiling (no punctuation available). */
function chop(sentence: string, limit: number): string[] {
  const pieces: string[] = [];
  for (let index = 0; index < sentence.length; index += limit) pieces.push(sentence.slice(index, index + limit));
  return pieces;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Split a reply into at most `maxSegments` segments of at most `segmentMaxChars`
 * characters each, with `gapMs` between them.
 *
 * Deterministic and total: any input (empty string, one huge sentence, a reply
 * that already contains the silence token) produces a valid `SegmentedReply`.
 */
export function splitReplyIntoSegments(text: string, options: ReplySegmentOptions = {}): SegmentedReply {
  const maxSegments = clampInt(options.maxSegments, REPLY_LIMITS.maxSegments, 1, REPLY_LIMITS.maxSegments);
  const segmentMaxChars = clampInt(options.segmentMaxChars, REPLY_LIMITS.segmentMaxChars, 1, REPLY_LIMITS.segmentMaxChars);
  const gapMs = clampInt(options.gapMs, REPLY_LIMITS.defaultGapMs, REPLY_LIMITS.minGapMs, REPLY_LIMITS.maxGapMs);
  const mergedOverflowRequested = options.maxSegments !== undefined && options.maxSegments > maxSegments;

  const normalized = normalizeReplyText(text);
  if (normalized.length === 0) return { segments: [], gapMs, mergedOverflow: mergedOverflowRequested };

  // M5: the silence control token is judged as a whole (§55), so it must never
  // be split — whatever the limits are. `ConversationEngine` already turns it
  // into SILENCE before this point; the guard is here so the splitter cannot be
  // the thing that breaks the rule if it is called directly.
  if (normalized === SILENCE_TOKEN) return { segments: [normalized], gapMs, mergedOverflow: mergedOverflowRequested };

  // Greedy fill: append whole sentences while they fit, otherwise start a new one.
  const segments: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) {
      segments.push(current);
      current = '';
    }
  };
  for (const sentence of sentencesOf(normalized)) {
    for (const piece of sentence.length > segmentMaxChars ? chop(sentence, segmentMaxChars) : [sentence]) {
      if (piece.length > segmentMaxChars) continue; // unreachable: chop() is bounded by the ceiling
      if (current.length + piece.length > segmentMaxChars) flush();
      current += piece;
    }
    // A sentence boundary is the preferred place to break, so flush when the next
    // sentence would not fit — handled by the length check above on the next piece.
  }
  flush();

  let mergedOverflow = mergedOverflowRequested;
  if (segments.length > maxSegments) {
    mergedOverflow = true;
    segments.splice(maxSegments - 1, segments.length - maxSegments + 1, segments.slice(maxSegments - 1).join(''));
  }
  return { segments, gapMs, mergedOverflow };
}
