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
 * (ADR-0010 §3). `resolveReplyLimits` clamps a request for 40 segments to 8 and remembers
 * that the caller asked for more; the concatenation invariant
 * (`segments.join('') === normalizeReplyText(text)`) holds for every input, including the
 * clamped ones.
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
 * When the ceilings hold and when they do not — the condition the boundary tests pin:
 *   * the greedy packer fills segments up to `segmentMaxChars`, cutting at sentence enders
 *     (and hard-chopping a single sentence that is longer than the ceiling). If that yields
 *     **at most `maxSegments` groups, every segment is ≤ `segmentMaxChars`** and
 *     `mergedOverflow` is false;
 *   * if it yields **more than `maxSegments` groups**, the packs from `maxSegments - 1` on are
 *     joined into the last segment, `mergedOverflow` becomes true, and that last segment is
 *     **longer than `segmentMaxChars`** (the 279-character counterexample in
 *     `tests/unit/core/reply-segments.test.ts` is the smallest shape of this);
 *   * `mergedOverflow` is also true when the caller simply *asked* for more segments than the
 *     ceiling, even if the text would have fit.
 *
 * In the merge case the invariant "never add or delete a character" (M4) is the one kept:
 * text is never dropped to satisfy the per-segment ceiling.
 */

import { SILENCE_TOKEN } from './prompt.ts';

export const REPLY_LIMITS = Object.freeze({
  /** Hard ceiling on segments per turn (ADR-0010 M1, raised 3 → 8 in P1). */
  maxSegments: 8,  /**
   * **Target** block length per segment (t4 F4 / t6 F4): the greedy packer keeps segments at or below
   * this, and a single longer sentence is chopped at it — but when the packer yields more than
   * `maxSegments` groups, the tail is merged into the last segment and that one **does** go over this
   * value (`mergedOverflow` says so). A deliberate trade: keeping every character outranks keeping the
   * per-segment ceiling.
   */
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

/* ======================================================================================
 * ClauseChunker — the *streaming* splitter (pack Phase 8)
 * ======================================================================================
 *
 * Design and measurement live in `docs/design/voice.md` §6.2 (the four triggers, and the two things
 * that must never be cut) and `docs/recon/voice-streaming-2026-10-01.md`; the tests that pin this
 * class are `tests/unit/voice/clause-chunker.test.ts`.
 *
 * `splitReplyIntoSegments` above splits a reply **after it is complete**; it is the
 * playback planner (ADR-0010) and stays exactly that. A voice turn needs something
 * different: text arrives as model deltas, and the first clause must reach TTS while
 * the rest of the reply is still being generated, otherwise 「首音」 waits for the whole
 * reply to be synthesized. This class is that online splitter.
 *
 * Four triggers, matching the pack's ClauseChunker contract:
 *   1. a sentence ender (`。！？!?…` — a run of them counts once) cuts immediately;
 *   2. a comma-like mark (`，,、；;：:——、…`) cuts once the clause holds at least
 *      `minCommaChars` characters — the "合理逗号 + 最低字数" rule;
 *   3. `maxChars` cuts even with no punctuation at all (最大等待字符数);
 *   4. `push()` input is appended and any complete clause is returned right away.
 *
 * Triggers 1–3 must not cut inside a decimal number or a URL (`3.14`, `v2.6`,
 * `https://example.com/a，b`). A cut is never taken at a mark that has no lookahead
 * yet, so a half-arrived 「3.」 waits for the next delta instead of being split.
 *
 * Invariants (pinned by `tests/unit/voice/clause-chunker.test.ts`):
 *   * no character is invented, dropped or reordered. Every clause is trimmed (a leading
 *     space would otherwise be sent to TTS as text), so the exact statement is:
 *     `join(clauses) === text.trim()` **and** nothing non-whitespace is lost —
 *     `text.replace(/\s/g, '')` equals the same of the joined clauses, with the empty
 *     string staying empty. Unlike `normalizeReplyText`, line breaks are not removed: the input is
 *     already-normalized delta text and an audible clause is exactly what was handed over;
 *   * a clause is never empty and never longer than `maxChars` unless a single
 *     indivisible run (a long URL) cannot be cut at all — that case is counted in
 *     `overlong` rather than hidden.
 */

/** Characters that end a clause outright. Run-of-marks is handled by the scanner. */
const SENTENCE_MARKS = new Set(['。', '！', '？', '!', '?', '…', '．', '.']);
/** Marks that may cut **only** once the clause is already long enough. */
const PAUSE_MARKS = new Set(['，', ',', '、', '；', ';', '：', ':', '—', '～', '~', '|']);
/** Marks after which a decimal/URL guard applies (the `.` of `3.14` / `example.com`). */
const DOTTED_PAUSE_MARKS = new Set(['.', '．']);
const CJK_END_MARKS = new Set(['。', '！', '？', '…', '．']);
const CJK_PAUSE_MARKS = new Set(['，', '、', '；', '：']);

export const CLAUSE_CHUNKER_LIMITS = Object.freeze({
  /**
   * How long a clause must already be before a comma-like mark may cut it.
   *
   * This is the 「合理逗号 + 最低字数」 rule, and it is deliberately not a low number: a comma is
   * a *release valve at the ceiling*, not a place to stop early. Cutting 「好的，」 at three
   * characters produces a fragment that sounds like a hiccup, and it buys no latency — the
   * first clause is released by the first sentence end anyway (that is what the target needs),
   * while every comma cut adds one TTS round trip to the reply. Below this many characters a
   * comma is simply ignored; above it, a comma is used as soon as the ceiling forces a cut.
   */
  minCommaChars: 12,
  /**
   * Hard ceiling on how long a clause may wait for a mark, i.e. 最大等待字符数. A reply with no
   * punctuation at all (measured: models do produce these) must still start speaking, and a long
   * clause costs more TTS time than the latency budget allows.
   */
  maxChars: 40,
  /**
   * How long the **first** clause must already be before a comma may release it mid-stream
   * (`SpeechPipeline` with `earlyFirstClause`). Not a chunker rule — the chunker never cuts at a
   * comma below `maxChars`; this is the one place where a slightly early start is worth a
   * slightly short first clause, because the model sends the full stop last (measured 2026-10-01:
   * waiting for it cost 200–800 ms before TTS could start).
   */
  earlyFirstClauseMinChars: 10,
});

export interface ClauseChunkerOptions {
  readonly minCommaChars?: number;
  readonly maxChars?: number;
}

function clampLimit(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.trunc(value));
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

/** CJK characters carry the same width as the Latin ones the limits are written in. */
function isCjk(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x3040 && code <= 0x30ff) || // kana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK
    (code >= 0xf900 && code <= 0xfaff) || // compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) // full-width forms
  );
}

/**
 * `v2.6`, `3.14`, `第 3.5 条`, `版本是v2.6` — a dotted number, never a sentence end.
 *
 * The prefix is `(?:^|[^\d.])` on purpose: it must not require whitespace or a bracket, because
 * models write 「版本是v2.6」 and 「温度是3.14度」 with no space at all — requiring one left the dot
 * of such a number unprotected, which is how `flush(at)` could still cut inside it (t5 review).
 */
const DOTTED_NUMBER = /(?:^|[^\d.])(?:v|V|第)?\d+(?:\.\d+)+/g;

/**
 * The half-open ranges `[start, end)` that must never be cut inside, because they hold a
 * decimal number, a version or a URL. Recomputed per scan from the text that has arrived; the
 * cost is irrelevant next to a model round trip, and a stateless scan cannot drift out of sync.
 * (Fresh regex objects: a module-level `/g` regex carries `lastIndex` between callers.)
 *
 * The URL pattern stops at a sentence mark and at CJK text on purpose. `\S*` looked right until a
 * real reply was measured: models write 「地址是 https://example.com/a，打开就能看到。」 with no
 * space before the full stop, so `\S*` swallowed the rest of the sentence, which made *every*
 * character of it "inside a URL" and silently disabled the early release (found 2026-10-01 by
 * `tests/unit/voice/voice-stream.test.ts`).
 */
export function unbreakableSpans(text: string): readonly { readonly start: number; readonly end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s。！？，、；：…，（）()「」『』"'<>【】]+/gi)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }
  for (const match of text.matchAll(DOTTED_NUMBER)) {
    // The number always starts at the first `v`/`V`/`第`/digit inside the match; anything before
    // it is the lookbehind character the pattern needed (there is none only at the very start).
    const lead = match[0].search(/[vV第\d]/);
    const start = (match.index ?? 0) + (lead < 0 ? 0 : lead);
    spans.push({ start, end: start + (match[0].length - (lead < 0 ? 0 : lead)) });
  }
  return spans.sort((left, right) => left.start - right.start);
}

function insideSpan(spans: readonly { readonly start: number; readonly end: number }[], at: number): boolean {
  return spans.some((span) => at > span.start && at < span.end);
}

/**
 * Is `index` a place the chunker is allowed to cut **after**? Pure and exported so the
 * guard itself can be tested (the tests that matter are the decimal and URL ones).
 *
 * "Allowed" is not the same as "now": a mark that is both safe *and* unambiguous also has to
 * clear `isStickyMark()`'s lookahead before it can release a clause mid-stream.
 */
export function isSafeCutIndex(text: string, index: number, spans = unbreakableSpans(text)): boolean {
  if (insideSpan(spans, index)) return false;
  const mark = text[index];
  if (mark === undefined || !DOTTED_PAUSE_MARKS.has(mark)) return true;
  if (isDigit(text[index - 1]) && (isDigit(text[index + 1]) || isCjk(text[index + 1]))) return false;
  const around = (offset: number): string => text[index + offset] ?? '';
  return !(isSpace(around(-1)) && isSpace(around(1)));
}

/**
 * Marks that cannot be part of a number or a URL, in any language: a cut right after one is
 * always safe, so they release a clause even when they are the last character that arrived.
 */
const NON_STICKY_MARKS = new Set(['。', '！', '？', '…', '，', '、', '；', '：', '—', '～']);

/** A mark that still needs the next delta before its verdict is known. */
function isStickyMark(text: string, index: number): boolean {
  const mark = text[index] as string;
  if (NON_STICKY_MARKS.has(mark)) return false;
  if (index === text.length - 1) return true; // "3." / "a," — what follows decides
  if (!DOTTED_PAUSE_MARKS.has(mark)) return false;
  // A dot right after a whitespace-free run of non-space characters may be a host name
  // ("example.com") or the start of a decimal ("3.14"): wait for the character after it.
  if (isDigit(text[index - 1] ?? '')) return false; // covered by `unbreakableSpans`
  if (isSpace(text[index - 1])) return false; // ". " is never part of a host name
  return /[^\s。！？，、；：]/.test(text[index + 1] ?? '');
}

/**
 * Does `char` end a clause on its own — i.e. is a cut right after it safe *and* unambiguous?
 *
 * Exported for the streaming pipeline, which uses it for one decision: 「the first clause is
 * complete, send it to TTS now」 (`SpeechPipeline.push` with `earlyFirstClause`). A comma is
 * deliberately **not** such a mark, even though it ends a clause: releasing a comma prefix would
 * make the rest of the sentence start with a comma, and 「明天 3」 could still become 「明天 3.14」.
 */
export function isDecisiveSentenceEnd(char: string | undefined): boolean {
  return char !== undefined && SENTENCE_MARKS.has(char) && !DOTTED_PAUSE_MARKS.has(char);
}

/** A comma-like mark that cannot be part of a number or a URL — the other decisive release. */
export function isDecisivePauseEnd(char: string | undefined): boolean {
  return char !== undefined && NON_STICKY_MARKS.has(char) && PAUSE_MARKS.has(char);
}

/**
 * Pull a requested cut position back to a place that is safe to cut **after**.
 *
 * `asked` is clamped into the text. If the cut would land inside an unbreakable span (a decimal,
 * a version, a URL) it retreats to that span's `start`, which is by construction a legal cut
 * point: no span covers it (spans are non-empty ranges, so `start` is not `> start` of itself),
 * and everything the caller wanted to say is still in the clause. A position that is not inside a
 * span is returned unchanged — the caller is the one who picked a mark.
 *
 * This exists because stepping back one character at a time is not enough: the position *after*
 * the dot of `v2.6` passes `isSafeCutIndex` (cutting after `.` is fine as long as it is not a
 * decimal separator), so a one-character walk-back stops right there and releases 「版本是v2.」.
 * The retreat has to know about whole spans, which is what this function adds — see
 * `tests/unit/voice/clause-chunker.test.ts` for the three cases the t5 review reproduced in
 * `%TEMP%\t5-review\flushat-repro.mjs`.
 */
export function retreatInto(asked: number, spans: readonly { readonly start: number; readonly end: number }[]): number {
  const askedAt = Math.max(0, Math.trunc(Number.isFinite(asked) ? asked : 0));
  const span = spans.find((candidate) => askedAt > candidate.start && askedAt < candidate.end);
  return span === undefined ? askedAt : span.start;
}

export interface ClauseChunk {
  readonly text: string;
  /** Why this clause was returned — the audit trail for a latency number (pack Phase 8). */
  readonly reason: 'sentence' | 'pause' | 'max' | 'flush';
}

export class ClauseChunker {
  readonly #minCommaChars: number;
  readonly #maxChars: number;
  #buffer = '';
  #overlong = 0;

  constructor(options: ClauseChunkerOptions = {}) {
    this.#minCommaChars = clampLimit(options.minCommaChars, CLAUSE_CHUNKER_LIMITS.minCommaChars, 1);
    this.#maxChars = clampLimit(options.maxChars, CLAUSE_CHUNKER_LIMITS.maxChars, 2);
  }

  /** What is still unsent (empty after `flush()`). */
  get pending(): string {
    return this.#buffer;
  }

  /** How many clauses went out over `maxChars` — an indivisible run (URL) was the cause. */
  get overlong(): number {
    return this.#overlong;
  }

  /**
   * Feed the next delta. Returns every clause that became complete, in order — usually
   * one, often none, and more than one when a delta carried several sentences at once.
   */
  push(chunk: string): readonly ClauseChunk[] {
    if (chunk.length === 0) return [];
    this.#buffer += chunk;
    return this.#drain(false);
  }

  /** End of stream: whatever is left is the last clause (or nothing). */
  flush(): readonly ClauseChunk[];
  /**
   * Release everything **up to** `at`, leaving the rest buffered — the seam the streaming voice
   * path uses to send its first clause to TTS the moment its mark arrives, while the model is
   * still generating the sentence that follows (pack Phase 8, `earlyFirstClause`).
   *
   * `at` is a hint, not an override, and a bad hint produces a **shorter** clause: the cut is
   * clamped into the buffer, then pulled back out of any number or URL it landed inside — to the
   * start of that span when there is one, otherwise to the nearest safe character (see
   * `retreatInto`). The first version of this method only stepped back one character at a time
   * while `isSafeCutIndex(head, cut - 1)` was false, which stopped *right after* the dot of
   * `v2.6`/`3.14`/`example.com` and released 「版本是v2.」 — the t5 review reproduced it in
   * `%TEMP%\t5-review\flushat-repro.mjs`, and `tests/unit/voice/clause-chunker.test.ts` now pins
   * the corrected behaviour. An empty result means "nothing to release yet", which is what lets a
   * caller ask on every delta. Never used by `splitReplyIntoSegments` — the offline splitter
   * stays untouched.
   */
  flush(at: number): readonly ClauseChunk[];
  flush(at?: number): readonly ClauseChunk[] {
    if (at !== undefined) return this.#releaseUpTo(at);
    const out = this.#drain(true);
    const tail = this.#buffer.trim();
    if (tail.length > 0) {
      if (tail.length > this.#maxChars) this.#overlong += 1;
      out.push({ text: tail, reason: 'flush' });
    }
    this.#buffer = '';
    return out;
  }

  #releaseUpTo(at: number): ClauseChunk[] {
    const raw = Number.isFinite(at) ? Math.trunc(at) : 0;
    const bounded = Math.max(0, Math.min(raw, this.#buffer.length));
    if (bounded === 0) return [];
    const clause = this.#buffer.slice(0, bounded).trim();
    if (clause.length === 0) return [];
    // The spans are scanned over one character of lookahead, not just the clause: `v2.6` only
    // looks like a dotted number once the `6` is visible, and a one-character-shorter slice made
    // 「版本是v2.」 look perfectly safe. The extra character is never released (the cut is ≤ bounded).
    const lookahead = this.#buffer.slice(0, Math.min(bounded + 1, this.#buffer.length));
    const cut = retreatInto(bounded, unbreakableSpans(lookahead));
    if (cut <= 0) return [];
    const released = this.#buffer.slice(0, cut).trim();
    if (released.length === 0) return [];
    if (released.length > this.#maxChars) this.#overlong += 1;
    this.#buffer = this.#buffer.slice(cut);
    return [{ text: released, reason: 'sentence' }];
  }

  #drain(atEnd: boolean): ClauseChunk[] {
    const out: ClauseChunk[] = [];
    for (;;) {
      const text = this.#buffer;
      if (text.length === 0) return out;
      const spans = unbreakableSpans(text);
      const cut = this.#findCut(text, spans, atEnd);
      if (cut === null) return out;
      const clause = text.slice(0, cut.at).trim();
      if (clause.length === 0) {
        // Only whitespace before the cut (a run of spaces after a mark): drop it and look on.
        this.#buffer = text.slice(cut.at);
        continue;
      }
      if (clause.length > this.#maxChars) this.#overlong += 1;
      out.push({ text: clause, reason: cut.reason });
      this.#buffer = text.slice(cut.at);
      if (!atEnd && out.length >= 32) return out; // a burst: let the caller catch up
    }
  }

  /**
   * Mark-based cut, then the `maxChars` ceiling, then nothing (wait for more text).
   *
   * The scan is O(buffer) per call and the buffer is emptied at every clause, so it stays
   * small — no index bookkeeping, and therefore no way for a stale index to drift.
   */
  #findCut(
    text: string,
    spans: readonly { readonly start: number; readonly end: number }[],
    atEnd: boolean,
  ): { readonly at: number; readonly reason: 'sentence' | 'pause' | 'max' } | null {
    /** The last comma-like mark that is a legitimate cut point — used only at the ceiling. */
    let bestPause = -1;
    for (let index = 0; index < text.length; index += 1) {
      const mark = text[index] as string;
      const isSentence = SENTENCE_MARKS.has(mark);
      const isPause = PAUSE_MARKS.has(mark);
      if (!isSentence && !isPause) continue;
      if (!isSafeCutIndex(text, index, spans)) continue;
      // A mark whose verdict still depends on text that has not arrived cannot cut yet:
      // 「看到 3.」 may still become 「看到 3.14」. The next delta (or `flush()`) releases it,
      // so a clause is never cut inside a number, a version or a URL.
      if (!atEnd && isStickyMark(text, index)) continue;
      if (isSentence) return { at: this.#endOfMarkRun(text, index), reason: 'sentence' };
      // A comma-like mark is remembered, not used: it only breaks the clause once the ceiling
      // has been reached (see `CLAUSE_CHUNKER_LIMITS.minCommaChars`).
      if (index + 1 >= this.#minCommaChars) bestPause = index + 1;
    }
    // The ceiling is the last resort: it applies only when nothing above released the clause.
    if (text.length <= this.#maxChars) return null;
    const ceiling = Math.min(text.length, this.#maxChars);
    if (bestPause > 0 && bestPause <= ceiling) return { at: bestPause, reason: 'pause' };
    return { at: this.#ceilingCut(text, spans), reason: 'max' };
  }

  /** Cut after a whole run of trailing marks (`！！`, `？！`, `……`) — one clause, one breath. */
  #endOfMarkRun(text: string, index: number): number {
    let end = index + 1;
    while (end < text.length && (SENTENCE_MARKS.has(text[end] as string) || PAUSE_MARKS.has(text[end] as string))) {
      end += 1;
    }
    return end;
  }

  /**
   * The clause is at least `maxChars` long and holds no usable mark: cut at the last safe
   * position (so a URL or a decimal stays whole), or — if even that is impossible — at the
   * ceiling itself, which is the only case that can produce an over-long clause.
   */
  #ceilingCut(text: string, spans: readonly { readonly start: number; readonly end: number }[]): number {
    const ceiling = Math.min(text.length, this.#maxChars);
    for (let index = ceiling - 1; index > 0; index -= 1) {
      if (isSafeCutIndex(text, index - 1, spans)) return index;
    }
    // No safe position at all (one indivisible run): cut at the ceiling. Never 0 — a cut that
    // consumes nothing would make the drain loop spin forever.
    return Math.max(1, ceiling);
  }
}

/**
 * One-shot convenience: chunk an already-complete reply. Used by the offline tests and by
 * callers that want the streaming split of a finished text (never by the live path, which
 * pushes deltas).
 */
export function chunkClauses(text: string, options: ClauseChunkerOptions = {}): readonly string[] {
  const chunker = new ClauseChunker(options);
  const out: string[] = [];
  for (const clause of chunker.push(text)) out.push(clause.text);
  for (const clause of chunker.flush()) out.push(clause.text);
  return out;
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
