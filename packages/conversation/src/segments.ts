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
 * (ADR-0010 §3). A caller asking for 5 segments gets 3 and a merged tail; the
 * concatenation invariant (`segments.join('') === normalizeReplyText(text)`) holds
 * for every input, including the clamped ones.
 */

export const REPLY_LIMITS = Object.freeze({
  /** Hard ceiling on segments per turn (ADR-0010 M1). */
  maxSegments: 3,
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
