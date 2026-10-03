/**
 * Streaming speech output (pack Phase 8).
 *
 * The V0.1 voice turn was: whole ASR → whole LLM reply → whole TTS → play. That is why
 * 「首音」 sat at 6.8 s P50 (`docs/benchmarks/v01-baseline.md` §3.2): the third stage could
 * not even *start* until the last character of the reply existed.
 *
 * This module is the deterministic half of the streaming replacement:
 *
 *     ASR final → model token stream → ClauseChunker → TTS queue → playback timeline
 *
 * Everything here is pure or clock-injected — no HTTP, no audio device, no files — so the
 * three things that are easy to get wrong are all testable offline:
 *
 *   * **ordering / latency** — clause 1 is dispatched to TTS the moment it exists, clause 2
 *     while clause 1 is still being synthesized, and one clause never overtakes another
 *     (`SpeechPipeline` keeps the synthesis order and the playback order identical);
 *   * **barge-in** — `PlaybackTimeline.abort()` answers 「how much had been played and how
 *     much was dropped」 for any abort moment, and the reply is dropped, not paused;
 *   * **backchannel** — the assistant's short 「嗯」 is a *separate* clip used at a pause in
 *     the user's own speech (`decideAssent`), and the user's own 「嗯」 must not close
 *     their turn (`isShortAcknowledgementOnly`), which is the one thing the VAD cannot do
 *     (`docs/design/voice.md` §2).
 *
 * Timing vocabulary follows `docs/benchmarks/v01-baseline.md` §3.1 exactly, so a before/after
 * number is comparable: ① VAD end → ASR final, ② ASR final → first token,
 * ③ first token → first audible **clause** (V0.1: whole reply), ④ total to first audio.
 *
 * The design half of this module — the chain, the chunker's four triggers, which of ③/④ owns the
 * pack's 1.5 s target, and the two commands that produce and recompute a batch — is
 * `docs/design/voice.md` §6; the measured numbers are `docs/recon/voice-streaming-2026-10-01.md`.
 * Read §6.3 before quoting any latency number: 「③ 超出 15%」 and 「④ 是目标的 3.5 倍」 are statements
 * about *different* stages.
 */

// Relative on purpose: `@xixi/conversation` exposes only its package entry (`.`), and adding
// an export subpath for one import would change that package's published surface. The chunker
// lives beside the offline splitter it complements, which is the point — see `segments.ts`.
import {
  CLAUSE_CHUNKER_LIMITS,
  ClauseChunker,
  isDecisivePauseEnd,
  isDecisiveSentenceEnd,
  isSafeCutIndex,
  unbreakableSpans,
  type ClauseChunk,
  type ClauseChunkerOptions,
} from '../../../packages/conversation/src/segments.ts';

/** One synthesized clause on its way to the speaker. */
export interface SpeechClause {
  /** 0-based, and the playback order — the same order the chunker emitted. */
  readonly index: number;
  readonly text: string;
  /** Why the chunker cut here (`sentence` / `pause` / `max` / `flush`). */
  readonly reason: ClauseChunk['reason'];
  /** When the clause text existed (ms, same clock as the caller's). */
  readonly textAtMs: number;
  /** How long from the clause existing to its TTS request being in flight (ms). */
  readonly dispatchMs?: number;
  /** When its audio existed. `null` while synthesis is still running. */
  readonly audioAtMs: number | null;
  /** Synthesis cost of this clause (ms), measured from the request being sent. */
  readonly synthMs: number | null;
  readonly bytes: number;
}

/** One clause of audio, ready to play. `pcm` is a WAV buffer as the provider returned it. */
export interface SynthesizedClause {
  readonly index: number;
  readonly text: string;
  readonly wav: Buffer | Uint8Array;
  readonly durationMs: number;
  readonly atMs: number;
  readonly synthMs: number;
}
/** Where a piece of audio sits on the playback clock. */
export interface PlaybackSlot {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}

export interface PlaybackMetrics {
  /** Wall clock (caller's clock) at which the *first* audio could be heard. */
  readonly firstAudibleAtMs: number | null;
  /**
   * How many clauses had to exist before the first one was audible: **1** in streaming, and
   * `totalClauses` in the V0.1 whole-reply path (that number is the whole point of Phase 8).
   */
  readonly firstAudibleClauses: number;
  readonly totalClauses: number;
  /** How long the whole reply takes on the playback clock. */
  readonly totalDurationMs: number;
  readonly slots: readonly PlaybackSlot[];
  /** Set when `abort()` was called: what the listener actually kept. */
  readonly aborted: boolean;
  readonly abortedAtMs: number | null;
  readonly playedMs: number;
  readonly droppedMs: number;
  /** Clauses whose audio had not started when playback stopped. */
  readonly droppedClauses: readonly number[];
}

/** Small gap between two pieces of the *same* clause that had to be split for length. */
export const MAX_AUDIO_GAP_MS = 180;

function clampLimit(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.trunc(value));
}

/**
 * Playback order and barge-in accounting, in the listener's own clock.
 *
 * The caller says "this much audio of clause N exists at wall-clock T"; the timeline says
 * when it will be heard and what is still un-played if the user interrupts. Pure.
 */
export class PlaybackTimeline {
  #cursorMs = 0;
  #slots: PlaybackSlot[] = [];
  #firstAudibleAtMs: number | null = null;
  #aborted = false;
  #abortedAtMs: number | null = null;
  #playedMs = 0;

  /** 0-based index of the next clause that has not been scheduled yet. */
  get scheduled(): number {
    return this.#slots.length;
  }

  get firstAudibleAtMs(): number | null {
    return this.#firstAudibleAtMs;
  }

  /**
   * Put a synthesized clause at the end of the queue. Ordering is the caller's contract:
   * clause N is never placed before clause N-1 (`SpeechPipeline` enforces it), which is what
   * keeps 「第一段立刻进 TTS 队列，后续块边生成边合成」 from turning into out-of-order speech.
   */
  schedule(chunk: SynthesizedClause): PlaybackSlot {
    const start = this.#cursorMs;
    const slot: PlaybackSlot = { index: chunk.index, startMs: start, endMs: start + chunk.durationMs, durationMs: chunk.durationMs };
    this.#slots.push(slot);
    this.#cursorMs = slot.endMs;
    if (this.#firstAudibleAtMs === null) this.#firstAudibleAtMs = chunk.atMs;
    return slot;
  }

  /**
   * The user started talking (or asked her to stop): playback stops **at the current
   * position** and everything not yet heard is dropped — a reply is not resumed in the
   * middle after the father has spoken over it (§14.2).
   *
   * `playedMs` is how much audio had actually been listened to when the abort landed; the
   * default reads it off the wall clock, but a caller that knows the real playback start
   * (a browser reporting `performance.now()`) passes it in.
   */
  abort(atMs: number, options: { readonly playedMs?: number } = {}): PlaybackMetrics {
    this.#aborted = true;
    this.#abortedAtMs = atMs;
    this.#playedMs = Math.max(0, options.playedMs ?? this.#playedBy(atMs));
    if (this.#firstAudibleAtMs !== null && this.#playedMs <= 0) this.#playedMs = 0;
    return this.metrics();
  }

  metrics(): PlaybackMetrics {
    const total = this.#slots.length === 0 ? 0 : (this.#slots[this.#slots.length - 1] as PlaybackSlot).endMs;
    if (!this.#aborted) {
      return {
        firstAudibleAtMs: this.#firstAudibleAtMs,
        firstAudibleClauses: this.#slots.length,
        totalClauses: this.#slots.length,
        totalDurationMs: total,
        slots: this.#slots,
        aborted: false,
        abortedAtMs: null,
        playedMs: total,
        droppedMs: 0,
        droppedClauses: [],
      };
    }
    const started = this.#slots.filter((slot) => slot.startMs < this.#playedMs);
    const dropped = this.#slots.filter((slot) => slot.endMs > this.#playedMs).map((slot) => slot.index);
    return {
      firstAudibleAtMs: this.#firstAudibleAtMs,
      // Streaming means clause 1 alone is enough to be audible: count the clauses that had
      // to exist, and if the abort landed before clause 1 the answer is 0 (nothing was heard).
      firstAudibleClauses: started.length === 0 ? 0 : new Set(started.map((slot) => slot.index)).size,
      totalClauses: this.#slots.length,
      totalDurationMs: total,
      slots: this.#slots,
      aborted: true,
      abortedAtMs: this.#abortedAtMs,
      playedMs: this.#playedMs,
      droppedMs: Math.max(0, total - this.#playedMs),
      droppedClauses: [...new Set(dropped)],
    };
  }

  /** How far into the queue the wall clock `atMs` lands — used when the caller knows only
   *  when playback started, not how much of it was heard. */
  #playedBy(atMs: number): number {
    if (this.#slots.length === 0) return 0;
    const start = (this.#slots[0] as PlaybackSlot).startMs;
    const end = (this.#slots[this.#slots.length - 1] as PlaybackSlot).endMs;
    return Math.max(0, Math.min(end, atMs - start));
  }
}

export interface SpeechPipelineOptions extends ClauseChunkerOptions {
  /** Injected clock, so tests can drive time instead of sleeping. */
  readonly now?: () => number;
  /**
   * Release the first clause **and start synthesizing it** without waiting for the rest of the
   * reply — 「第一块立刻进 TTS 队列」 in the pack's words.
   *
   * Without it the chunker still cuts at the first sentence end, but the cut only reaches TTS
   * after the model has finished, because the text arrives through `push()` and nothing flushes
   * until the turn ends. Measured (2026-10-01, real MiMo): the difference is the whole remaining
   * generation time, and TTS cannot overlap it. With it on, a single-sentence reply is sent to
   * TTS at the instant its sentence end arrives, which is the earliest possible moment.
   */
  readonly earlyFirstClause?: boolean;
  /**
   * How long the first clause must already be before a comma can release it early.
   *
   * Measured reason for this knob (2026-10-01, real MiMo, `--trace`): the model sends a whole
   * sentence as a run of 1–9-character deltas and the sentence end (`。`) arrives **last**, so
   * waiting for it costs 200–800 ms of extra latency before TTS can even start. A comma that
   * has already arrived is a complete, speakable prefix, so releasing there moves the first
   * audio earlier by exactly that gap. This only ever applies to clause 1; every later clause
   * waits for a sentence end as usual.
   */
  readonly earlyFirstClauseMinChars?: number;
}

/** Fired once, when the first clause is complete and its synthesis has been dispatched. */
export type FirstClauseHook = (clause: SpeechClause) => void;

/**
 * ClauseChunker → TTS queue.
 *
 * `push()` is called from the model's streaming callback and must not block it: it hands the
 * new text to the chunker and starts synthesis for whatever became complete, without waiting.
 * `flush()` waits for every dispatch and returns the clauses in order — the caller then knows
 * the whole reply is synthesized.
 */
export class SpeechPipeline {
  readonly #chunker: ClauseChunker;
  readonly #synthesize: (text: string) => Promise<Buffer | Uint8Array>;
  readonly #probe: (wav: Buffer | Uint8Array) => number;
  readonly #now: () => number;
  readonly #startedAtMs: number;
  readonly #pending: Promise<void>[] = [];
  readonly #clauses: SpeechClause[] = [];
  readonly #audio = new Map<number, SynthesizedClause>();
  readonly #errors: string[] = [];
  readonly #early: boolean;
  readonly #earlyMinChars: number;
  #firstClauseHook: FirstClauseHook | null = null;
  #clauseHook: ((clause: SynthesizedClause) => void | Promise<void>) | null = null;
  /** Next clause index whose delivery has **completed** — everything below it is done. */
  #deliveredCursor = 0;
  /** Clauses whose audio exists but which are waiting for their turn in the order. */
  #queue = new Map<number, SynthesizedClause>();
  #delivered = 0;
  #firstDispatched = false;
  #nextIndex = 0;
  #firstTextAtMs: number | null = null;
  #flushed = false;

  constructor(
    synthesize: (text: string) => Promise<Buffer | Uint8Array>,
    audioDurationMs: (wav: Buffer | Uint8Array) => number,
    options: SpeechPipelineOptions = {},
  ) {
    this.#synthesize = synthesize;
    this.#probe = audioDurationMs;
    this.#chunker = new ClauseChunker(options);
    this.#early = options.earlyFirstClause === true;
    this.#earlyMinChars = clampLimit(options.earlyFirstClauseMinChars, CLAUSE_CHUNKER_LIMITS.earlyFirstClauseMinChars, 2);
    this.#now = options.now ?? (() => Date.now());
    this.#startedAtMs = this.#now();
  }

  /**
   * The first clause is ready and in flight. Called at most once, and before `flush()` for a
   * single-sentence reply — the caller uses it to start measuring 「首段可听」 from the true
   * dispatch rather than from the end of the turn.
   */
  onFirstClause(hook: FirstClauseHook): void {
    this.#firstClauseHook = hook;
    if (this.#firstDispatched && this.#clauses[0] !== undefined) hook(this.#clauses[0]);
  }

  /**
   * Every clause, **in playback order**, as soon as its audio exists (t13).
   *
   * This is the seam a streaming server needs: it turns 「合成在背后跑」 into 「这一块的音频已经可以
   * 发给浏览器了」 without polling. The hook is called sequentially and in index order — clause *n*
   * is never handed out before clause *n−1*, even though the synthesis calls run concurrently — so
   * the receiver can push each clause straight onto the wire. Awaited: a slow consumer back-pressures
   * the synthesis hand-off instead of buffering the whole reply in memory.
   *
   * A clause whose synthesis failed is **not** delivered (there is no audio), and it is reported in
   * `errors` exactly as before; ordering of the delivered clauses is preserved.
   */
  onClause(hook: (clause: SynthesizedClause) => void | Promise<void>): void {
    this.#clauseHook = hook;
    // Anything already synthesized is queued, so registering after `push()` is not a race.
    for (const chunk of [...this.#audio.values()].sort((left, right) => left.index - right.index)) {
      if (chunk.index >= this.#deliveredCursor) this.#queue.set(chunk.index, chunk);
    }
    void this.#pump();
  }

  /** How many clauses have been handed to `onClause` (the streaming seam's own counter). */
  get delivered(): number {
    return this.#delivered;
  }

  /**
   * Hand over every queued clause that is next in line, and keep going until the next wanted index
   * is missing. Delivery is strictly index-ordered: clause *n* waits for clause *n−1*, whatever
   * order synthesis finished in, and each clause is handed over exactly once (the index moves
   * forward, so a re-queue cannot duplicate it).
   */
  async #pump(): Promise<void> {
    const hook = this.#clauseHook;
    if (hook === null) return;
    while (this.#queue.has(this.#deliveredCursor)) {
      const chunk = this.#queue.get(this.#deliveredCursor) as SynthesizedClause;
      this.#queue.delete(this.#deliveredCursor);
      try {
        // Awaited on purpose: a slow consumer back-pressures the hand-off instead of letting the
        // whole reply pile up in memory.
        await hook(chunk);
      } finally {
        this.#deliveredCursor += 1;
        this.#delivered += 1;
      }
    }
  }

  /** Put a synthesized clause in the delivery queue (index order decides when it goes out). */
  #deliver(chunk: SynthesizedClause): void {
    if (this.#clauseHook === null) return;
    if (chunk.index < this.#deliveredCursor) return;
    this.#queue.set(chunk.index, chunk);
    void this.#pump();
  }

  /** The in-order delivery: resolves when nothing more can be handed over right now. */
  awaitDeliveries(): Promise<void> {
    return this.#pump();
  }

  /** When the model's first text delta arrived (after ASR), or `null` if it never did. */
  get firstTextAtMs(): number | null {
    return this.#firstTextAtMs;
  }

  get clauses(): readonly SpeechClause[] {
    return this.#clauses;
  }

  get errors(): readonly string[] {
    return this.#errors;
  }

  get pendingChars(): number {
    return this.#chunker.pending.length;
  }

  /** Feed a model text delta. Returns immediately; synthesis runs behind it. */
  push(delta: string): void {
    if (delta.length === 0) return;
    if (this.#firstTextAtMs === null) this.#firstTextAtMs = this.#now();
    for (const clause of this.#chunker.push(delta)) this.#dispatch(clause);
    if (this.#early && !this.#firstDispatched) this.#releaseFirstClause();
  }

  /**
   * 「第一块立刻进 TTS 队列」: release the first clause the moment it is speakable, instead of
   * waiting for the whole reply.
   *
   * The mark is **searched for**, not read off the end of the buffer, because that is what the
   * model actually does: it streams straight through the comma
   * (`"明天" → "是" → "小毛毛雨，18到" → "22度，下雨概率" …`), so by the time the mark arrives the
   * buffer already ends in the *next* word. Waiting for the buffer to end at the mark was the
   * first implementation of this method, and `--trace` measured it as no improvement at all
   * (2026-10-01).
   *
   * Two kinds of mark qualify:
   *   * a sentence end (`。！？…`) — unambiguous, always safe;
   *   * the **last** comma-like mark once the prefix is at least `earlyFirstClauseMinChars` — a
   *     complete prefix that merely *could* have continued. The comma stays with the first
   *     clause, so the rest of the sentence reads normally.
   *
   * A number or a URL never qualifies mid-stream (`ClauseChunker` holds those), and a prefix
   * ending in `3.` does not either, because the `.` is not decisive.
   */
  #releaseFirstClause(): void {
    const pending = this.#chunker.pending;
    if (pending.length === 0) return;
    const spans = unbreakableSpans(pending);
    let at = -1;
    for (let index = 0; index < pending.length; index += 1) {
      const mark = pending[index] as string;
      const isSentence = isDecisiveSentenceEnd(mark);
      const isPause = isDecisivePauseEnd(mark) && index + 1 >= this.#earlyMinChars;
      if (!isSentence && !isPause) continue;
      // The same guard the chunker uses: the mark must not sit inside a decimal or a URL. This is
      // why the search is worth doing here rather than trusting the caller's guess — the sentence
      // `地址是 https://example.com/a，打开就能看到。` has a comma right after the URL, and cutting
      // there would split the address from the sentence it belongs to.
      if (!isSafeCutIndex(pending, index, spans)) continue;
      at = index + 1;
      if (isSentence) break;
    }
    if (at <= 0) return;
    const released = this.#chunker.flush(at);
    if (released.length === 0) {
      // `flush(at)` refuses a cut it cannot make safely (an indivisible run). Rather than let the
      // text sit here and be re-tried on every delta, hand it to the normal drain: it will either
      // emit a clause or keep buffering, which is exactly the behaviour without the early path.
      for (const clause of this.#chunker.flush()) this.#dispatch(clause);
      return;
    }
    for (const clause of released) this.#dispatch(clause);
  }

  /**
   * No more text will arrive. Resolves with every clause in order; a clause whose synthesis
   * failed is skipped **and recorded** in `errors`, never silently replaced by silence.
   */
  async flush(): Promise<readonly SynthesizedClause[]>;
  /**
   * Wait for the clauses **this call released**, in order. Used by the streaming voice path, where
   * text is pushed while the reply is still being generated: the caller accumulates the returned
   * pieces, so a clause must never be handed out twice. (An earlier version returned the whole map
   * every time, which duplicated the reply for any caller that joined the results.)
   */
  async flush(released: 'released'): Promise<readonly SynthesizedClause[]>;
  async flush(mode?: 'released'): Promise<readonly SynthesizedClause[]> {
    const before = this.#nextIndex;
    if (!this.#flushed) {
      this.#flushed = true;
      for (const clause of this.#chunker.flush()) this.#dispatch(clause);
    }
    await Promise.allSettled(this.#pending);
    // Everything synthesized must be handed over before `flush()` resolves, in index order. Pumping
    // alone is not enough: the queue only advances past the next wanted index, so a clause whose
    // synthesis finished *after* a later one is parked until the earlier one arrives (t13). Yielding
    // between pumps lets the pending deliveries that were awaited inside a pump register theirs.
    for (const chunk of [...this.#audio.values()].sort((left, right) => left.index - right.index)) {
      this.#deliver(chunk);
    }
    for (let round = 0; round < 100; round += 1) {
      await this.#pump();
      if (this.#queue.size === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const from = mode === 'released' ? before : 0;
    return [...this.#audio.entries()]
      .filter(([index]) => index >= from)
      .sort((left, right) => left[0] - right[0])
      .map(([, chunk]) => chunk);
  }

  #dispatch(clause: ClauseChunk): void {
    const index = this.#nextIndex;
    this.#nextIndex += 1;
    const textAtMs = this.#now();
    const record: SpeechClause = { index, text: clause.text, reason: clause.reason, textAtMs, audioAtMs: null, synthMs: null, bytes: 0 };
    this.#clauses.push(record);
    const started = this.#now();
    // The synthesis promise is created here, synchronously, so the TTS request is already in
    // flight when the model's next delta arrives — the engine never waits for it.
    const task = this.#synthesize(clause.text);
    const dispatchedAtMs = this.#now();
    record.dispatchMs = dispatchedAtMs - textAtMs;
    if (!this.#firstDispatched) {
      this.#firstDispatched = true;
      this.#firstClauseHook?.(record);
    }
    this.#pending.push(
      task
        .then((wav) => {
          const atMs = this.#now();
          const durationMs = this.#probe(wav);
          const bytes = wav.byteLength ?? (wav as Buffer).length;
          record.synthMs = atMs - dispatchedAtMs;
          record.audioAtMs = atMs;
          record.bytes = bytes;
          const chunk: SynthesizedClause = { index, text: clause.text, wav, durationMs, atMs, synthMs: record.synthMs };
          this.#audio.set(index, chunk);
          // t13: hand this clause to the streaming consumer the moment its audio exists, in
          // playback order. `void` on purpose — the caller's own back-pressure is expressed by
          // awaiting the function it was given, not by blocking this synthesis promise.
          void this.#deliver(chunk);
        })
        .catch((error: unknown) => {
          this.#errors.push(`clause ${index}（${clause.text.slice(0, 20)}）合成失败：${error instanceof Error ? error.message : String(error)}`);
        }),
    );
  }
}

/** The four baseline delays, computed from raw stage durations (ms). All `null` until known. */
export function fourStageLatency(stages: {
  readonly endpointDelayMs: number | null;
  readonly asrMs: number | null;
  readonly firstTokenMs: number | null;
  readonly firstAudioMs: number | null;
}): {
  readonly vadEndToAsrFinalMs: number | null;
  readonly asrFinalToFirstTokenMs: number | null;
  readonly firstTokenToFirstAudioMs: number | null;
  readonly totalToFirstAudioMs: number | null;
} {
  const { endpointDelayMs, asrMs, firstTokenMs, firstAudioMs } = stages;
  return {
    vadEndToAsrFinalMs: asrMs,
    asrFinalToFirstTokenMs: firstTokenMs,
    firstTokenToFirstAudioMs: firstAudioMs,
    totalToFirstAudioMs:
      endpointDelayMs === null || asrMs === null || firstTokenMs === null || firstAudioMs === null
        ? null
        : Math.round(endpointDelayMs + asrMs + firstTokenMs + firstAudioMs),
  };
}

/** P50/P90 (linear interpolation, the same rule as `docs/benchmarks/v01-baseline.md`) of a
 *  list of measurements; `null`s are dropped, not counted as 0. */
export function percentiles(values: readonly (number | null)[]): { readonly n: number; readonly p50: number; readonly p90: number; readonly min: number; readonly max: number } | null {
  const numbers = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const at = (p: number): number => {
    const rank = (p / 100) * (numbers.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return numbers[lower] as number;
    const weight = rank - lower;
    return (numbers[lower] as number) * (1 - weight) + (numbers[upper] as number) * weight;
  };
  return { n: numbers.length, p50: at(50), p90: at(90), min: numbers[0] as number, max: numbers[numbers.length - 1] as number };
}

/* ======================================================================================
 * Barge-in (§14.2)
 * ====================================================================================== */

export interface BargeInDecision {
  /** True when playback must stop now. */
  readonly stop: boolean;
  readonly reason: 'assistant-not-speaking' | 'playback-already-done' | 'no-speech' | 'below-gate' | 'stop';
  /** Real user speech that arrived inside the assistant's playback window (ms). */
  readonly overlapMs: number;
  /** The user's total voiced time in this recording (ms). */
  readonly energyMs: number;
}

/**
 * Should the assistant stop talking?
 *
 * The criterion is deliberately not "any noise": the audio the microphone hears *while the
 * assistant speaks* must itself look like speech (voiced time ≥ `minEnergyMs`) **and** overlap
 * the playback window. A cough or the TV is filtered upstream by the voice front end; this
 * function only owns the 「父亲一说话就停」 rule and the boundary cases that can be tested
 * offline. A backchannel-length 「嗯」 is explicitly *not* enough (§14.3) — it is answered by
 * `decideAssent` instead.
 */
export function decideBargeIn(input: {
  /** The user's voiced spans inside the recording, in recording time (ms). */
  readonly userSpans: readonly { readonly startMs: number; readonly endMs: number }[];
  /** Where the assistant's playback started, in the same clock. */
  readonly playbackStartMs: number;
  /** How long the assistant's audio is (ms). */
  readonly playbackDurationMs: number;
  /** Playback position already consumed before the assistant started listening. */
  readonly playbackOffsetMs?: number;
  readonly minEnergyMs?: number;
}): BargeInDecision {
  const minEnergyMs = input.minEnergyMs ?? 150;
  const offset = input.playbackOffsetMs ?? 0;
  const energyMs = input.userSpans.reduce((sum, span) => sum + Math.max(0, span.endMs - span.startMs), 0);
  if (input.playbackDurationMs <= 0) return { stop: false, reason: 'assistant-not-speaking', overlapMs: 0, energyMs };
  if (offset >= input.playbackDurationMs) return { stop: false, reason: 'playback-already-done', overlapMs: 0, energyMs };
  if (input.userSpans.length === 0) return { stop: false, reason: 'no-speech', overlapMs: 0, energyMs };
  const windowStart = input.playbackStartMs - offset;
  const windowEnd = windowStart + input.playbackDurationMs;
  let overlapMs = 0;
  for (const span of input.userSpans) {
    overlapMs += Math.max(0, Math.min(span.endMs, windowEnd) - Math.max(span.startMs, windowStart));
  }
  if (overlapMs < minEnergyMs) return { stop: false, reason: 'below-gate', overlapMs, energyMs };
  return { stop: true, reason: 'stop', overlapMs, energyMs };
}

/**
 * When the user's speech starts mid-playback, where does the assistant's audio actually stop?
 * Returns the position (ms into the reply) and the remaining un-played audio.
 */
export function truncateOnBargeIn(input: {
  readonly decisionMs: number;
  readonly playbackOffsetMs: number;
  readonly playbackDurationMs: number;
}): { readonly stopsAtMs: number; readonly droppedMs: number } {
  const stopsAtMs = Math.max(0, Math.min(input.playbackDurationMs, input.playbackOffsetMs + input.decisionMs));
  return { stopsAtMs, droppedMs: Math.max(0, Math.round(input.playbackDurationMs - stopsAtMs)) };
}

/* ======================================================================================
 * Backchannel (§14.3 / pack Phase 8)
 * ====================================================================================== */

/** The assistant's own short acknowledgements. Pre-generated once, reused forever. */
export const ASSENT_CLIPS: readonly string[] = Object.freeze(['嗯', '哦', '是啊', '嗯嗯']);

/** Voiced time below this is not a turn — it is a 「嗯」 (§2: 「嗯。」 is 0.5 s of speech). */
export const ASSENT_MAX_ENERGY_MS = 700;

export interface AssentDecision {
  readonly play: boolean;
  readonly clip: string | null;
  readonly reason: 'assistant-idle' | 'no-pause' | 'pause-too-short' | 'turn-too-short' | 'frequency' | 'already-used' | 'play';
}

/**
 * May the assistant say 「嗯」 **right now**?
 *
 * Called on every VAD-detected pause inside the user's own speech, while the assistant is
 * listening:
 *   * the pause must be a real one (`pauseMs` ≥ `minPauseMs`) — an interjection in the middle
 *     of the user's word is the one thing that sounds like a machine;
 *   * the user's utterance must already be long enough to be a sentence in progress
 *     (`utteranceMs` ≥ `minUtteranceMs`), otherwise the two of them talk over each other;
 *   * `frequency` comes from the personality store (`backchannel_frequency`), so a personality
 *     that says 「少应和」 really gets fewer of them;
 *   * `used` is how many were already used in this user turn: at most one every
 *     `minGapMs` (and at most `maxPerTurn`), because a wall of 「嗯嗯嗯」 is worse than silence;
 *   * a backchannel **never ends the user's turn** — that is `isShortAcknowledgementOnly`'s job, and it
 *     is what stops 「嗯」 from being read as a whole turn by the engine.
 */
export function decideAssent(input: {
  readonly assistantSpeaking: boolean;
  readonly pauseMs: number;
  readonly utteranceMs: number;
  readonly frequency: number;
  readonly used: number;
  readonly sinceLastMs?: number;
  readonly minPauseMs?: number;
  readonly minUtteranceMs?: number;
  readonly minGapMs?: number;
  readonly maxPerTurn?: number;
}): AssentDecision {
  if (input.assistantSpeaking) return { play: false, clip: null, reason: 'assistant-idle' };
  const minPauseMs = input.minPauseMs ?? 250;
  if (input.pauseMs < minPauseMs) return { play: false, clip: null, reason: 'pause-too-short' };
  if (input.utteranceMs < (input.minUtteranceMs ?? 1200)) return { play: false, clip: null, reason: 'turn-too-short' };
  const maxPerTurn = input.maxPerTurn ?? 2;
  if (input.used >= maxPerTurn) return { play: false, clip: null, reason: 'already-used' };
  if (input.used > 0 && (input.sinceLastMs ?? 0) < (input.minGapMs ?? 4000)) {
    return { play: false, clip: null, reason: 'pause-too-short' };
  }
  const frequency = Math.max(0, Math.min(1, input.frequency));
  if (frequency <= 0) return { play: false, clip: null, reason: 'frequency' };
  // Deterministic by construction: the nth pause of a turn gets the nth clip, and whether it
  // is used at all is a pure function of the personality value (no RNG in the live path).
  if (frequency < 1 && input.used >= Math.round(frequency * maxPerTurn)) {
    return { play: false, clip: null, reason: 'frequency' };
  }
  return { play: true, clip: ASSENT_CLIPS[input.used % ASSENT_CLIPS.length] as string, reason: 'play' };
}

/**
 * Characters that carry no lexical content when judging 「这是不是一个整轮」.
 *
 * The lexicon is the measured one from `docs/design/voice.md` §2 and the fixture table
 * (`scripts/lib/similarity.ts`): 「嗯」/「哦」/「啊」/「呃」/「唉」/「诶」/「噢」/「唔」/「呣」/「嘛」
 * plus the particles and punctuation that can accompany them. Real content words — 「好」,
 * 「是」, 「对」 — are deliberately **not** here: 「好，那就这样吧。」 is an answer, and a rule
 * that swallows it would silently drop the father's turns.
 */
/** Characters that carry no lexical content when judging 「这是不是一个整轮」. */
const FILLER_CHARS = /[嗯哦啊呃唉诶噢唔呣嘛呀吧哈恩，,。.…！!？?、\s]/g;
/**
 * Characters that are an acknowledgement on their own but belong to a sentence inside one:
 * 「是啊」 is a nod, while 「是的，我明天去」 is an answer. They are removed one at a time and
 * only while the result stays non-empty, so 「好，那就这样吧」 keeps its meaning.
 */
const LONE_FILLERS = '对是好';
const LONE_FILLER_SET = new Set([...LONE_FILLERS]);

/**
 * Is this transcript nothing but an acknowledgement?
 *
 * Measured reason to own this in code rather than in the VAD: Pipecat's Silero does not even
 * see 「嗯。」 (peak confidence 0.53 < 0.7), and both LiveKit EOU variants call it a *finished*
 * turn (`docs/design/voice.md` §2). When the father says 「嗯」 in reply to her, the transcript
 * alone is not evidence of a turn and the engine's turn counter must not move — so the caller
 * checks this *before* `engine.respond` and keeps listening.
 *
 * The rule is deliberately narrow. Strip the acknowledgement characters (repeats included) and
 * keep the ones that are only fillers when they stand alone (「好」「是」「对」); if nothing is
 * left, it was a nod. 「好，那就这样吧。」 keeps 「就那样吧吧」-worth of content and stays a turn,
 * while 「是啊」 (the third documented clip) counts as one. The optional voiced duration is a
 * second, independent signal: 「好」 said for 2.5 s is a sentence, 「好」 said for 300 ms is a nod.
 */
export function isShortAcknowledgementOnly(transcript: string, options: { readonly energyMs?: number } = {}): boolean {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length > 8) return false; // 「嗯，我明天下午去镇上」 is a sentence, not a nod
  const energyMs = options.energyMs;
  const rest = trimLoneFillers(trimmed.replace(FILLER_CHARS, ''));
  if (rest.length === 0) return true; // 「嗯」「哦」「嗯嗯」「是啊」「对，嗯」 — nothing but agreement
  // A short word that is *only* agreement needs a second signal. The voiced duration is that
  // signal when it is available (「好」 for 2.5 s is a sentence); without one, only the
  // half-second clips the package names count. Everything else stays a turn: 「是」/「好」/「对」
  // alone cannot be told from a nod in a transcript, and silently dropping the father's answer
  // is far worse than answering a nod with a sentence.
  if (rest.length <= 2 && LONE_FILLER_ONLY.test(rest)) {
    if (energyMs !== undefined) return energyMs > 0 && energyMs <= ASSENT_MAX_ENERGY_MS;
    return trimmed.length <= 2;
  }
  return false;
}

/** A short word that is nothing but agreement once the sentence around it is gone. */
const LONE_FILLER_ONLY = /^[对是好嗯哦哦啊啊呀吧]+$/;

/** Drop characters that only read as agreement on their own, never the last one. */
function trimLoneFillers(text: string): string {
  const characters = [...text];
  for (let index = characters.length - 1; index >= 0 && characters.length > 1; index -= 1) {
    if (LONE_FILLER_SET.has(characters[index] as string)) characters.splice(index, 1);
  }
  return characters.join('');
}

/**
 * The clips themselves: pre-generated once (the first time one is wanted) and then reused, so
 * using a backchannel costs one TTS call per clip *ever* — not one per interjection, and not
 * one inside the user's pause.
 */
export class AssentBank {
  readonly #synthesize: (text: string) => Promise<Buffer | Uint8Array>;
  readonly #clips: readonly string[];
  readonly #cache = new Map<string, Buffer | Uint8Array>();
  readonly #pending = new Map<string, Promise<Buffer | Uint8Array>>();
  readonly #errors: string[] = [];

  constructor(synthesize: (text: string) => Promise<Buffer | Uint8Array>, clips: readonly string[] = ASSENT_CLIPS) {
    this.#synthesize = synthesize;
    this.#clips = clips;
  }

  get clips(): readonly string[] {
    return this.#clips;
  }

  get errors(): readonly string[] {
    return this.#errors;
  }

  /** Ready-made clips, keyed by text (only the ones already synthesized). */
  get cached(): ReadonlyMap<string, Buffer | Uint8Array> {
    return this.#cache;
  }

  get size(): number {
    return this.#cache.size;
  }

  /** Warm the whole bank (used at voice-service start-up, never inside a pause). */
  async prepare(): Promise<ReadonlyMap<string, Buffer | Uint8Array>> {
    await Promise.all(this.#clips.map((clip) => this.get(clip)));
    return this.#cache;
  }

  /** One clip; synthesizes on first use and remembers it. */
  async get(text: string): Promise<Buffer | Uint8Array | null> {
    const cached = this.#cache.get(text);
    if (cached !== undefined) return cached;
    const inFlight = this.#pending.get(text);
    if (inFlight !== undefined) return inFlight;
    const task = this.#synthesize(text)
      .then((wav) => {
        this.#cache.set(text, wav);
        this.#pending.delete(text);
        return wav;
      })
      .catch((error: unknown) => {
        this.#pending.delete(text);
        this.#errors.push(`backchannel「${text}」合成失败：${error instanceof Error ? error.message : String(error)}`);
        return null as unknown as Buffer;
      });
    this.#pending.set(text, task);
    const result = await task;
    return result ?? null;
  }
}

/** What is audible at a given moment: the answer to 「他说话的时候她停了吗」. */
export interface AudibleState {
  /** True when some clause is sounding at `atMs`. */
  readonly audible: boolean;
  /** Which clause is audible, or `null`. */
  readonly clause: number | null;
  /** How far into the reply the listener is. */
  readonly positionMs: number;
}

/**
 * The barge-in acceptance question, answered on the playback timeline.
 *
 * 「打断能真的让正在播的语音停下」 is a statement about the **listener's** clock, not about the VAD:
 * at the moment the father starts talking (`afterMs` into the reply), is anything still
 * audible? With an aborted timeline the answer must be no, and the un-played remainder must be
 * exactly what was dropped. Pure, so the same rule can be checked offline on every run.
 */
export function playbackStateAt(metrics: PlaybackMetrics, atMs: number): AudibleState {
  if (metrics.aborted) {
    const position = Math.max(0, Math.min(metrics.playedMs, atMs));
    return { audible: false, clause: null, positionMs: position };
  }
  const slot = metrics.slots.find((candidate) => atMs >= candidate.startMs && atMs < candidate.endMs);
  if (slot === undefined) {
    const next = metrics.slots.find((candidate) => candidate.startMs >= atMs);
    return { audible: false, clause: next === undefined ? null : next.index, positionMs: atMs };
  }
  return { audible: true, clause: slot.index, positionMs: atMs };
}

/** One pause in the user's own speech — the only place a backchannel may go. */
export interface PauseWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly pauseMs: number;
  /** Voiced time of the user's speech **before** this pause (what `decideAssent` asks for). */
  readonly utteranceMs: number;
}

/**
 * The pauses between the VAD's speech spans. `planSpeechSegments` already knows the spans (that
 * is what it feeds to ASR); this turns them into the moments a human would say 「嗯」.
 */
export function pauseWindows(spans: readonly { readonly startMs: number; readonly endMs: number }[]): readonly PauseWindow[] {
  const windows: PauseWindow[] = [];
  let voiced = 0;
  for (let index = 0; index < spans.length; index += 1) {
    voiced += Math.max(0, (spans[index] as { endMs: number }).endMs - (spans[index] as { startMs: number }).startMs);
    const next = spans[index + 1];
    if (next === undefined) continue;
    const pauseMs = Math.max(0, next.startMs - (spans[index] as { endMs: number }).endMs);
    windows.push({ startMs: (spans[index] as { endMs: number }).endMs, endMs: next.startMs, pauseMs, utteranceMs: voiced });
  }
  return windows;
}

/* ======================================================================================
 * Browser side: the same playback rules, running in the page
 * ====================================================================================== */

/**
 * The JavaScript the page uses to speak streamed clauses, to stop the instant the father
 * starts talking, and to place a backchannel clip in a pause of his own speech. Kept as a
 * string so `scripts/serve-chat.ts` serves it verbatim and the offline test can assert on the
 * rules that matter (abort drops the queue, a backchannel clip does not stop the recording)
 * without a browser.
 *
 * `XIXI_PLAYBACK_JS` is plain browser JavaScript: no imports, no template placeholders. The
 * three thresholds mirror the values the offline tests pin (`XIXI_PLAYBACK_THRESHOLDS`).
 */
export const XIXI_PLAYBACK_THRESHOLDS = Object.freeze({
  /** Voiced time that counts as 「他在说话」 rather than a cough (§14.2 gate, offline-tested). */
  bargeInMs: 150,
  /** RMS (of the float samples, 0..1) above which a 20 ms frame counts as voiced. */
  voiceRms: 0.02,
  /** A pause shorter than this is not a place to say 「嗯」 (决定函数里的 minPauseMs). */
  assentPauseMs: 250,
});

export const XIXI_PLAYBACK_JS = String.raw`
// Streaming playback with barge-in and backchannel (pack Phase 8).
// One AudioContext for the whole page; the reply is a queue of clauses, not one blob.
var xixiAudio = { ctx: null, queue: [], playing: null, bargeAt: null, speaking: false, clips: {} };
function xixiCtx() {
  if (!xixiAudio.ctx) xixiAudio.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (xixiAudio.ctx.state === 'suspended') xixiAudio.ctx.resume();
  return xixiAudio.ctx;
}
// Stop now and drop everything not yet heard: a reply is never resumed mid-sentence after
// the user has spoken over it (§14.2).
function xixiStopSpeaking(reason) {
  xixiAudio.bargeAt = { at: Date.now(), reason: reason || 'barge-in' };
  for (var i = 0; i < xixiAudio.queue.length; i += 1) {
    try { xixiAudio.queue[i].stop(0); } catch (error) { /* already finished */ }
  }
  xixiAudio.queue = [];
  xixiAudio.playing = null;
  xixiAudio.speaking = false;
}
// Queue one clause of base64 WAV. The promise resolves when the clause is audibly starting —
// that moment is what 「首段可听」 is measured at, clause by clause.
async function xixiSpeakClause(base64) {
  var ctx = xixiCtx();
  var bytes = Uint8Array.from(atob(base64), function (c) { return c.charCodeAt(0); });
  var buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
  if (xixiAudio.bargeAt) return { at: Date.now(), startedAtMs: null, durationMs: 0, skipped: true };
  var source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  var startedAt = performance.now();
  xixiAudio.speaking = true;
  var body = new Promise(function (resolve) {
    source.onended = function () {
      if (xixiAudio.playing === source) xixiAudio.playing = null;
      if (xixiAudio.queue.length === 0) xixiAudio.speaking = false;
      resolve({ at: Date.now(), startedAtMs: startedAt, durationMs: buffer.duration * 1000 });
    };
    xixiAudio.queue.push(source);
    source.start();
    xixiAudio.playing = source;
  });
  return { at: Date.now(), startedAtMs: startedAt, durationMs: buffer.duration * 1000, done: body };
}
// A backchannel clip is played *outside* the reply queue: it must not stop the reply and it
// must not be treated as speech of her own (the listener stays in his turn).
function xixiPlayClip(base64) {
  try { new Audio('data:audio/wav;base64,' + base64).play().catch(function () {}); } catch (error) { /* no device */ }
}
/*
 * Barge-in while she is talking.
 *
 * The microphone is already being sampled by the recorder, so this runs on the same frames:
 * a frame is voiced when its RMS is above the gate, and XIXI_PLAYBACK_THRESHOLDS.bargeInMs of
 * voiced frames while xixiAudio.speaking is true means the father has started a sentence:
 * playback stops and the un-played clauses are dropped. His 「嗯」 cannot reach that many voiced
 * milliseconds at this gate, which is the §14.3 rule ("a backchannel does not stop her")
 * enforced by the same code path rather than by a second rule. Returns true once per interruption.
 */
function xixiWatchBargeIn(rms) {
  if (!xixiAudio.speaking) { xixiAudio.voicedMs = 0; return false; }
  xixiAudio.voicedMs = rms > ` + String(XIXI_PLAYBACK_THRESHOLDS.voiceRms) + ` ? (xixiAudio.voicedMs || 0) + 20 : 0;
  if ((xixiAudio.voicedMs || 0) < ` + String(XIXI_PLAYBACK_THRESHOLDS.bargeInMs) + `) return false;
  xixiStopSpeaking('barge-in');
  return true;
}
// Backchannel: while the user is speaking (xixiAudio.speaking === false) a quiet stretch of
// assentPauseMs is a natural pause — say 「嗯」 once, and stay in his turn.
function xixiOnUserPause(pausedMs) {
  if (xixiAudio.speaking || pausedMs < ` + String(XIXI_PLAYBACK_THRESHOLDS.assentPauseMs) + `) return false;
  if ((xixiAudio.assents || 0) >= 2) return false;
  if (Date.now() - (xixiAudio.lastClipAt || 0) < 4000) return false;
  xixiAudio.assents = (xixiAudio.assents || 0) + 1;
  xixiAudio.lastClipAt = Date.now();
  return true;
}
`;
