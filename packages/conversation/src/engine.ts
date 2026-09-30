import { buildEvent, toOffsetIso } from '@xixi/contracts';
import { isSilenceReply, type BrainAdapter, type BrainImageInput } from '@xixi/brain-adapter';
import type { Clock, TurnAction, XixiConfig, XixiStore } from '@xixi/domain';
import { systemClock } from '@xixi/domain';

import {
  ConversationStateMachine,
  type ConversationState,
  type FsmConfig,
  type TurnAcceptance,
  type TurnAcceptanceReason,
} from './fsm.ts';
import { PromptAssembler, SILENCE_TOKEN, worldStateLite, type AssembledPrompt, type PromptTurn } from './prompt.ts';
import { DEFAULT_SILENCE_TOLERANCE } from './personality.ts';
import { REPLY_LIMITS, resolveReplyLimits, splitReplyIntoSegments, type ReplySegmentOptions, type SegmentedReply } from './segments.ts';

export interface ConversationEngineOptions {
  readonly adapter: BrainAdapter;
  readonly store: XixiStore;
  readonly config: XixiConfig;
  readonly clock?: Clock;
  readonly assembler?: PromptAssembler;
  /**
   * FSM tuning. `lingerMs` / `engageTimeoutMs` are decisions this layer owns;
   * `silenceTolerance` is an explicit override for tests and replay, because the
   * normal source is the persisted personality (§7.2) — see
   * `ConversationEngine.#syncSilenceTolerance`.
   */
  readonly fsm?: Partial<FsmConfig>;
  /** Per-turn model timeout. Realtime replies should fail fast rather than hang. */
  readonly turnTimeoutMs?: number;
  /** How many prior turns enter working memory (§10.2 A). */
  readonly historyLimit?: number;
  /** Local UTC offset override, for tests and replay. */
  readonly offsetMinutes?: number;
  /**
   * Multi-segment reply limits (ADR-0010). `config.reply` is the normal source;
   * this is the explicit test/replay override. Neither can exceed the hard
   * ceilings in `REPLY_LIMITS` — see `resolveReplyLimits`.
   */
  readonly reply?: ReplySegmentOptions;
}

export interface RespondInput {
  readonly sessionId: string;
  readonly text: string;
  /**
   * Wake word or very strong direct address (§13). The caller owns detection:
   * M1 has no wake word yet, so a UI button sets it; M2 supplies the detector.
   */
  readonly addressed?: boolean;
  readonly at?: Date;
  /**
   * Optional still image(s) for **this** turn (t88: the console's 「看一眼」 button).
   *
   * The *caller* decides what, when and whether to attach — the engine never picks a picture
   * itself, and iron rule 6 still holds: no continuous video, one explicitly chosen frame per
   * call. It goes straight to the adapter's own `images` seam (t87); an adapter that cannot send
   * pictures (DSH) refuses such a turn instead of silently dropping the image.
   */
  readonly images?: readonly BrainImageInput[];
}

/** One segment as it is handed to the playback seam (ADR-0010). */
export interface ReplySegmentPlayback {
  readonly index: number;
  readonly text: string;
  readonly total: number;
  /** Pause to leave after this segment; `null` on the last one (the turn ends). */
  readonly gapMsAfter: number | null;
}

export interface RespondHooks {
  /** Called for each text delta as it arrives, so TTS can start early (§46.1). */
  readonly onTextChunk?: (text: string) => void | Promise<void>;
  /**
   * The playback seam for multi-segment replies (ADR-0010): awaited once per
   * segment, in order, so the caller speaks them with `gapMsAfter` between them.
   *
   * Mutually exclusive with `onTextChunk` **on purpose**: when this hook is
   * supplied the engine stops handing out raw deltas, because driving audio from
   * both seams would speak the same reply twice. A caller that wants segmented
   * playback passes `onSegment`; a caller that wants the legacy single-utterance
   * streaming passes `onTextChunk`.
   */
  readonly onSegment?: (segment: ReplySegmentPlayback) => void | Promise<void>;
  /**
   * t111: a structured, non-spoken note about what the engine had to change (today: an unverified
   * concrete claim was replaced). Never fed to TTS — it exists so the caller can audit the turn
   * instead of guessing why the reply differs from the model's raw text.
   */
  readonly onNotice?: (notice: { readonly code: string; readonly detail: string }) => void | Promise<void>;
}

export interface ConversationTurn {
  readonly accepted: boolean;
  readonly reason: TurnAcceptanceReason;
  readonly state: ConversationState;
  readonly action: TurnAction;
  readonly text: string | null;
  /** How the reply is spoken: 1..3 segments (ADR-0010); empty on SILENCE. */
  readonly segments: readonly string[];
  /** Pause between those segments, in milliseconds. */
  readonly segmentGapMs: number;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  /** Model first-token latency, when the adapter streams (§46.4). */
  readonly firstTokenMs: number | null;
  /** Exactly what the model saw; kept for the Debug UI and for replay evidence. */
  readonly prompt: AssembledPrompt | null;
}

/**
 * One conversation turn, end to end: state machine → prompt assembly → adapter →
 * durable event log → state machine.
 *
 * The engine owns everything deterministic (§2.1): whether a turn is accepted,
 * what context the model sees, what is recorded, and when the session closes.
 * The model only decides what to say.
 */
export class ConversationEngine {
  readonly #adapter: BrainAdapter;
  readonly #store: XixiStore;
  readonly #config: XixiConfig;
  readonly #clock: Clock;
  readonly #assembler: PromptAssembler;
  readonly #fsm: ConversationStateMachine;
  readonly #turnTimeoutMs: number;
  readonly #historyLimit: number;
  readonly #offsetMinutes: number | undefined;
  /** Effective reply limits, already clamped to the hard ceilings (ADR-0010 §3). */
  readonly #replyLimits: ReplySegmentOptions;
  /** Set only when the caller passed `fsm.silenceTolerance` explicitly. */
  readonly #silenceToleranceOverride: number | null;
  /**
   * How many decisions this process has recorded, so a decision event always
   * advances `turn_index`. Derived from the durable projection, a rejected turn
   * would repeat the previous index because it never writes a turn.
   */
  #decisionCount = 0;

  constructor(options: ConversationEngineOptions) {
    this.#adapter = options.adapter;
    this.#store = options.store;
    this.#config = options.config;
    this.#clock = options.clock ?? systemClock;
    this.#assembler = options.assembler ?? new PromptAssembler();
    this.#fsm = new ConversationStateMachine(options.fsm, this.#clock().getTime());
    this.#silenceToleranceOverride = options.fsm?.silenceTolerance ?? null;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 30_000;
    this.#historyLimit = options.historyLimit ?? 8;
    this.#offsetMinutes = options.offsetMinutes;
    // `reply` is a declaration in `config/xixi.example.yaml` until something reads
    // it; reading it here is what makes the section true. Every value is clamped,
    // so neither the config nor a caller can raise the ADR-0010 ceilings.
    this.#replyLimits = resolveReplyLimits(this.#config.reply, options.reply);
    // The personality is the source of truth, so it is read at construction and
    // re-read on every turn. Forgetting this wiring is no longer invisible: an
    // unset tolerance leaves the window unscaled instead of silently matching
    // the seeded 0.7.
    this.#syncSilenceTolerance();
  }

  get adapter(): BrainAdapter {
    return this.#adapter;
  }

  /**
   * The conversation state **as of now**, not as of the last transition.
   *
   * Why reads advance the clock: the FSM only expires timed states when someone
   * calls `tick`, and no production caller ever did — `chat.ts`, `serve-chat.ts`
   * and `scripts/field-test.ts` read `engine.state` to decide whether the next
   * utterance is a wake-up. After a pause longer than the follow-up window the
   * getter returned the remembered `LINGERING`, the callers computed
   * `addressed = false`, and the user's first sentence after the pause was
   * `REJECTED_NOT_ADDRESSED` while their second was accepted (t19 / t6 F1).
   *
   * Trade-offs, stated explicitly:
   *   * this is a getter with a side effect — it advances injected time. That is
   *     inherent: the value it reports is time-dependent, and the alternative
   *     (every caller remembering to `tick`) is exactly what failed.
   *   * it also re-reads the personality window, because the window decides when
   *     the state expires: an admin override that raises `silence_tolerance`
   *     must not be able to produce an early expiry on a read. Cost is one small
   *     indexed SELECT; `serve-chat`'s `/api/state` already reads the profile.
   *   * therefore a caller must not read state after closing the store.
   *   * `respond()` does not use this: it ticks at the turn's own `at` (replay
   *     must follow the supplied timestamp, not the wall clock).
   */
  #advance(now: Date = this.#clock()): ConversationState {
    this.#syncSilenceTolerance();
    this.#fsm.tick(now.getTime());
    return this.#fsm.state;
  }

  get state(): ConversationState {
    return this.#advance();
  }

  /** How long the follow-up window currently is, personality included (§12.2). */
  get lingerMs(): number {
    return this.#fsm.lingerMs;
  }

  snapshot(): ReturnType<ConversationStateMachine['snapshot']> {
    // Same reason as `state`: the snapshot a caller reads must describe now, so
    // `snapshot().state` and `state` can never disagree about the same instant.
    this.#advance();
    return this.#fsm.snapshot();
  }

  /**
   * Read the effective personality and push `silence_tolerance` into the FSM.
   *
   * The engine is the only place that knows both the store and the state
   * machine, which is why the wiring lives here: a caller that builds an FSM by
   * hand (tests, replay) must pass the value explicitly.
   */
  #syncSilenceTolerance(): void {
    const fromStore = this.#store.selfProfile()['silence_tolerance'];
    // Precedence, and the only place it is decided:
    //   1. the persisted personality (the real source, re-read every turn);
    //   2. an explicit `fsm.silenceTolerance` from the caller — tests and replay;
    //   3. `DEFAULT_SILENCE_TOLERANCE` for a store that never seeded the property
    //      (e.g. a profile created before it existed).
    // The FSM itself has no default, so none of these can silently stand in for
    // "personality not wired" the way the old hidden 0.7 did.
    const tolerance = fromStore ?? this.#silenceToleranceOverride ?? DEFAULT_SILENCE_TOLERANCE;
    this.#fsm.setSilenceTolerance(tolerance);
  }

  /** The tolerance currently scaling the follow-up window (never null). */
  get silenceTolerance(): number {
    return this.#fsm.silenceTolerance ?? DEFAULT_SILENCE_TOLERANCE;
  }

  /**
   * Append the auditable acceptance decision (铁律 5: a reason code and scores,
   * never the user's words and never model reasoning).
   *
   * Without this the log could not answer "why wasn't this sentence accepted?" —
   * a rejected turn used to leave no trace at all.
   */
  #recordDecision(input: {
    readonly sessionId: string;
    readonly at: Date;
    readonly addressed: boolean;
    readonly acceptance: TurnAcceptance;
    readonly before: ConversationState;
    readonly state: ConversationState;
    readonly action: TurnAction;
  }): void {
    const { acceptance } = input;
    const turnIndex = this.#decisionCount;
    this.#decisionCount += 1;
    this.#store.appendEvent(
      buildEvent({
        event_type: 'conversation.decision',
        source: 'brain',
        actor: 'system',
        confidence: acceptance.accept ? 1 : 0.5,
        timestamp: toOffsetIso(input.at),
        payload: {
          session_id: input.sessionId,
          turn_index: turnIndex,
          accepted: acceptance.accept,
          reason: acceptance.reason,
          action: input.action,
          fsm_state: input.state,
          fsm_state_before: input.before,
          addressed: input.addressed,
          acceptance_score: acceptance.accept ? 1 : 0,
          linger_ms: this.#fsm.lingerMs,
          silence_tolerance: this.silenceTolerance,
        },
      }),
    );
  }

  /** Expire timed states without producing a turn (used by the loop and by tests). */
  tick(at: Date = this.#clock()): void {
    this.#fsm.tick(at.getTime());
  }

  /** "今天我想安静点": no turn is accepted until `until` (null = until resume()). */
  quiet(until: Date | null = null, at: Date = this.#clock()): void {
    this.#fsm.suspend(until === null ? null : until.getTime(), at.getTime());
    this.#store.recordHealth('conversation', 'ok', `quiet mode until ${until === null ? 'resume' : until.toISOString()}`);
  }

  resume(at: Date = this.#clock()): void {
    this.#fsm.resume(at.getTime());
  }

  /** Working memory for the next turn: the last N turns of this session (§10.2 A). */
  workingMemory(sessionId: string): PromptTurn[] {
    return this.#store.recentTurns(sessionId, this.#historyLimit).map((turn) => ({
      role: turn.role,
      text: turn.text ?? '',
      action: turn.action,
    }));
  }

  /** Build the prompt for a turn without calling the model (Debug UI, tests, replay). */
  buildPrompt(input: RespondInput): AssembledPrompt {
    const at = input.at ?? this.#clock();
    const session = this.#store.getSession(input.sessionId);
    return this.#assembler.assemble({
      identityName: this.#config.identity.name,
      personality: this.#store.selfProfile(),
      world: worldStateLite(at, this.#config.identity.timezone, this.#offsetMinutes),
      // Advanced at the turn's own timestamp, not the wall clock: replay must
      // follow the supplied `at`, which is also what `respond()` decides with.
      conversationState: this.#advance(at),
      turnIndex: session.turnCount,
      history: this.workingMemory(input.sessionId),
      userText: input.text,
      language: languageName(this.#config.identity.language),
    });
  }

  /**
   * t111: the deterministic backstop for a caller that composes a line **outside** `respond()` —
   * today the console's proactive delivery seam, which builds its own prompt and calls the adapter
   * directly. The rule is the same as inside `respond()`: a concrete claim that only a lookup can
   * produce may not be spoken unless a tool actually ran in that turn.
   *
   * Returns the text to speak (`text`), whether it had to be replaced (`ok === false`) and the
   * offending substrings for the audit note. Callers must not throw the claims away silently:
   * 「说了具体数值却没有查」 should always be visible somewhere.
   */
  screenUnbackedFacts(
    text: string,
    toolName: string | null,
  ): { readonly ok: boolean; readonly text: string; readonly claims: readonly UnbackedFactClaim[] } {
    if (toolName !== null) return { ok: true, text, claims: [] };
    const claims = findUnbackedFactClaims(text);
    if (claims.length === 0) return { ok: true, text, claims: [] };
    return { ok: false, text: UNBACKED_FACT_REPLY, claims };
  }

  async respond(input: RespondInput, hooks: RespondHooks = {}): Promise<ConversationTurn> {
    const at = input.at ?? this.#clock();
    // `#advance(at)` re-reads the personality (which scales the follow-up window)
    // and expires timed states at the turn's own timestamp, so both the decision
    // below and the audited `before` describe this instant. Ordering matters: the
    // window must be current before it is used to decide anything.
    const before = this.#advance(at);
    const session = this.#store.getSession(input.sessionId);
    const addressed = input.addressed ?? true;
    const acceptance = this.#fsm.shouldAcceptTurn({ addressed, at: at.getTime() });
    if (!acceptance.accept) {
      this.#recordDecision({
        sessionId: input.sessionId,
        at,
        addressed,
        acceptance,
        before,
        state: acceptance.state,
        action: 'SILENCE',
      });
      return {
        accepted: false,
        reason: acceptance.reason,
        state: acceptance.state,
        action: 'SILENCE',
        text: null,
        segments: [],
        segmentGapMs: this.#replyLimits.gapMs ?? REPLY_LIMITS.defaultGapMs,
        provider: this.#adapter.provider,
        model: this.#adapter.describe().model,
        latencyMs: 0,
        firstTokenMs: null,
        prompt: null,
      };
    }

    this.#fsm.onUserTurn(at.getTime());
    const prompt = this.buildPrompt({ ...input, at });
    const startedAt = Date.now();
    this.#store.recordTurn({ sessionId: input.sessionId, role: 'user', action: 'SPEAK', text: input.text });

    let decisionRecorded = false;
    const recordAcceptedDecision = (action: TurnAction, state: ConversationState): void => {
      if (decisionRecorded) return;
      decisionRecorded = true;
      this.#recordDecision({
        sessionId: input.sessionId,
        at,
        addressed,
        acceptance,
        before,
        state,
        action,
      });
    };

    let turnAction: TurnAction = 'SILENCE';
    let turnText: string | null = null;
    let turnProvider = this.#adapter.provider;
    let turnModel = this.#adapter.describe().model;
    let firstChunkAt: number | null = null;
    // Supplying `onSegment` selects segmented playback, and the two audio seams
    // are mutually exclusive (see `RespondHooks`): otherwise this reply would be
    // spoken once by the delta consumer and once by the segment player.
    const playSegments = hooks.onSegment !== undefined;
    /** How the accepted reply is spoken; computed once, from the final text. */
    let replySplit: SegmentedReply | null = null;
    try {
      const stream = await this.#adapter.handleUserTurn({
        sessionId: input.sessionId,
        text: input.text,
        prompt,
        timeoutMs: this.#turnTimeoutMs,
        // t88: the caller's still frame(s) for this turn, passed straight through. Absent for every
        // ordinary turn, so the text path is byte-for-byte what it was (t87 pins that in tests).
        ...(input.images === undefined ? {} : { images: input.images }),
      });

      // The silence token can arrive split across deltas ("[" + "静默" + "]"), so a
      // per-chunk check is not enough. Text is held back only while it could still
      // become the token; anything that diverges is flushed immediately, which
      // keeps normal replies streaming at full speed. The holding still happens
      // when the caller plays segments — the token must be detected exactly the
      // same way — only the handoff is skipped.
      let held = '';
      let suppressed = false;
      /** t111: did any tool actually run in this turn? Only then may a lookup-only claim stand. */
      let toolRan = false;
      /**
       * t111: text holding a concrete claim that only a lookup can know is kept back until this turn
       * proves it (a `tool` chunk arrives) or ends (then it is replaced below). Once holding starts,
       * everything after it is held too — otherwise the next sentence would be spoken before it.
       * The segment path never streams, so it only needs the end-of-turn decision.
       */
      let heldFacts = '';
      for await (const chunk of stream) {
        if (chunk.type === 'tool') {
          toolRan = true;
          if (heldFacts.length > 0 && !suppressed) {
            if (!playSegments) await hooks.onTextChunk?.(heldFacts);
            heldFacts = '';
          }
          continue;
        }
        if (chunk.type !== 'text') continue;
        if (firstChunkAt === null) firstChunkAt = Date.now();
        if (suppressed) continue;
        held += chunk.text;
        const candidate = held.trim();
        if (SILENCE_TOKEN.startsWith(candidate)) {
          if (candidate === SILENCE_TOKEN) {
            suppressed = true;
            held = '';
          }
          continue;
        }
        if (heldFacts.length > 0 || (!toolRan && findUnbackedFactClaims(held).length > 0)) {
          heldFacts += held;
          held = '';
          continue;
        }
        if (!playSegments) await hooks.onTextChunk?.(held);
        held = '';
      }
      if (!playSegments && !suppressed && held.length > 0) await hooks.onTextChunk?.(held);
      const result = await stream.result;

      // t111 (the「成都阴天 19 到 25 度」bug): the model asserted something only a lookup can know
      // and never called the tool. 铁律 1/3 put this boundary in the program, not in the prompt: the
      // claim must not reach audio, the transcript, or working memory. She says she is not sure
      // instead, and the caller gets a notice with the offending text for the audit trail.
      const unbackedClaims = toolRan ? [] : findUnbackedFactClaims(result.text ?? '');
      let replyText = result.text;
      if (unbackedClaims.length > 0) {
        replyText = UNBACKED_FACT_REPLY;
        heldFacts = '';
        await hooks.onNotice?.({
          code: 'UNBACKED_FACT_CLAIM',
          detail: `未调用工具却给出可核查事实：${unbackedClaims.map((claim) => claim.match).join('、')}`,
        });
        if (!playSegments) await hooks.onTextChunk?.(UNBACKED_FACT_REPLY);
      } else if (heldFacts.length > 0) {
        // A tool ran after the claim was held → the sentence was backed, so it may be spoken now.
        if (!playSegments) await hooks.onTextChunk?.(heldFacts);
        heldFacts = '';
      }

      // §55 is an engine-level rule, not an adapter's promise: whatever the adapter
      // reports, a reply that is only the silence token becomes SILENCE here, so a
      // stray control token can never reach TTS or the transcript. `replyText` (not
      // `result.text`) is what the turn actually says, so a replaced claim never
      // reaches the log either (t111).
      const silent = result.action === 'SILENCE' || replyText === null || isSilenceReply(replyText);
      turnAction = silent ? 'SILENCE' : result.action;
      turnText = silent ? null : replyText;
      turnProvider = result.provider;
      turnModel = result.model;

      this.#store.recordTurn({
        sessionId: input.sessionId,
        role: 'assistant',
        action: turnAction,
        text: turnText,
        toolName: silent ? null : result.toolName,
      });

      // ADR-0010 M6/M7: one turn stays one turn. Splitting here — after the single
      // assistant record, before `onReplyCompleted` — is what keeps the FSM
      // advancing exactly once, and reading the clock after the last segment is
      // what starts the follow-up window from the end of the *last* one. While the
      // segments are being played the state is still ACTIVE (M8), so the user can
      // cut in.
      replySplit = turnText === null ? null : splitReplyIntoSegments(turnText, this.#replyLimits);
      let playbackError: unknown = null;
      if (replySplit !== null) {
        const lastIndex = replySplit.segments.length - 1;
        try {
          for (const [index, segment] of replySplit.segments.entries()) {
            await hooks.onSegment?.({
              index,
              text: segment,
              total: replySplit.segments.length,
              gapMsAfter: index === lastIndex ? null : replySplit.gapMs,
            });
          }
        } catch (cause) {
          // ADR-0010 M9: a failed segment stops the remaining ones and ends the
          // turn — the follow-up window still opens, so one broken TTS call cannot
          // leave the conversation stuck in ACTIVE. The failure is reported to the
          // caller afterwards rather than swallowed, and the log keeps exactly one
          // assistant record (the log is conversation-level, not audio-level).
          playbackError = cause;
        }
      }
      const finishedAt = this.#clock();
      this.#fsm.onReplyCompleted(finishedAt.getTime());
      if (playbackError !== null) throw playbackError;
    } finally {
      // Recorded even when the model throws: "the turn was accepted, then the
      // provider failed" is exactly the fact §21 降级 needs later.
      recordAcceptedDecision(turnAction, this.#fsm.state);
    }

    return {
      accepted: true,
      reason: acceptance.reason,
      state: this.#fsm.state,
      action: turnAction,
      text: turnText,
      // `replySplit` is set even if a hook threw (the split is computed before
      // playback), so a failed playback still reports how the reply was meant to
      // be spoken; a SILENCE turn has no segments.
      segments: replySplit?.segments ?? [],
      segmentGapMs: replySplit?.gapMs ?? this.#replyLimits.gapMs ?? REPLY_LIMITS.defaultGapMs,
      provider: turnProvider,
      model: turnModel,
      latencyMs: Date.now() - startedAt,
      firstTokenMs: firstChunkAt === null ? null : firstChunkAt - startedAt,
      prompt,
    };
  }
}

// ---------------------------------------------------------- unverified concrete claims (t111)

/**
 * A concrete, checkable claim the model can only know by looking it up.
 *
 * Field observation (2026-09-30): 主动开口 said 「成都阴天 19 到 25 度」 without ever calling
 * `xixi_get_weather`. A number like that cannot come from the context window, so it is a
 * fabrication — and 铁律 1/3 say the *program* owns that boundary, not the prompt alone. The
 * prompt forbids it (see `HARD_POLICY` §7); this is the deterministic backstop.
 */
export interface UnbackedFactClaim {
  readonly kind: 'temperature' | 'forecast' | 'attribution';
  /** The offending substring, kept for the audit note (never spoken). */
  readonly match: string;
}

/** `19 到 25 度`, `零下 3 度`, `-2℃`, `180 度` — temperatures, including ranges. */
const TEMPERATURE_SIGN = '(?:(?:零下|负|[-−])\\s*)?';
const TEMPERATURE_NUMBER = '\\d{1,3}'; // t117 (F2): `\d{1,2}` truncated `180 度` into `80 度` in the audit note.
const TEMPERATURE_RANGE = new RegExp(
  `${TEMPERATURE_SIGN}${TEMPERATURE_NUMBER}\\s*(?:到|至|~|～|-|—|–)\\s*${TEMPERATURE_SIGN}${TEMPERATURE_NUMBER}\\s*(?:度|℃|°C)`,
);
const TEMPERATURE_SINGLE = new RegExp(`${TEMPERATURE_SIGN}${TEMPERATURE_NUMBER}\\s*(?:度|℃|°C)`);
/** Numbers only a measurement can produce: 概率 / 湿度 / 风力 / 空气质量 / 紫外线. */
const FORECAST_METRIC = /(?:降水概率|降雨概率|湿度|风力|空气质量|空气指数|紫外线(?:指数)?)\s*(?:为|是|约|大概|在)?\s*\d{1,3}\s*(?:%|％|级|度)?/;
/**
 * Claims attributed to a source that was never consulted — **tightened in t117 (review F1)**.
 *
 * The first version matched any source word (`医生|专家|朋友说|别人说|他们告诉|新闻|…`), which
 * replaced whole ordinary sentences: 「朋友说要来吃饭」「专家都觉得这样安排挺好」、
 * 「今天新闻挺热闹的，说小区门口要办集市」. Two rules now keep it to 「有内容可核查」:
 *   1. the source must be the **speaker** — `天气预报/气象台/预报/报道/新闻` followed by a
 *      reporting verb (`说/称/报/提到/讲/显示/预计`). 「新闻挺热闹的」 has no verb, so it passes;
 *   2. the sentence must carry a fact element (a number, a quotation, or a predicate that can be
 *      true or false). 「天气预报说明天有雨」 and 「新闻里说小区要停水」 still fire;
 *      「医生说多喝水对身体好」 never reaches rule 1 at all.
 * Bare source words (`医生/专家/朋友说/别人说/他们告诉`) are **gone on purpose**: they show up in
 * ordinary talk far more often than in fabrications.
 */
const ATTRIBUTION_SOURCE = /(天气预报|气象台|预报|报道|新闻)\s*里?\s*(?:说|称|报|提到|讲|显示|预计)/;
/** A fact element: a number, a quotation, or a predicate that can be true or false (t117). */
const ATTRIBUTION_CONTENT = /(?:\d|[「“『']|有|要|会|将|是|在|停|降|升|来|去|办|开|改|取消|恢复|雨|雪|风|温|冷|热|晴|阴|涨|跌)/;

/** What she says instead of an unverified claim: no numbers, no new facts, no pretending. */
export const UNBACKED_FACT_REPLY = '这个我记不准，不敢乱说——要不我查一下再告诉你？';

/**
 * Find concrete claims in a reply that need a tool result to be true.
 *
 * Deliberately narrow (t111, tightened in t117): it only fires on *specifics* a lookup would
 * produce — numbers with units, a metric, or a statement by a source that was never consulted and
 * that carries something checkable. It must not fire on ordinary talk (「今天有点冷，多穿点」
 * 「朋友说要来吃饭」「医生说多喝水」): a gate that answers 「我不敢乱说」 to a homey sentence is
 * worse than the bug it fixes, and the review (t114 §3) caught exactly that class of damage.
 */
export function findUnbackedFactClaims(text: string): UnbackedFactClaim[] {
  const claims: UnbackedFactClaim[] = [];
  const add = (kind: UnbackedFactClaim['kind'], match: string): void => {
    if (!claims.some((claim) => claim.kind === kind && claim.match === match)) claims.push({ kind, match });
  };
  const range = TEMPERATURE_RANGE.exec(text);
  if (range !== null) add('temperature', range[0]);
  else {
    const single = TEMPERATURE_SINGLE.exec(text);
    if (single !== null) add('temperature', single[0]);
  }
  const metric = FORECAST_METRIC.exec(text);
  if (metric !== null) add('forecast', metric[0]);
  const attributed = ATTRIBUTION_SOURCE.exec(text);
  if (attributed !== null) {
    // Judge the *sentence* around the source, not the whole reply: the fact element has to sit in
    // the same statement the source is making (t117).
    const sentence = sentenceAround(text, attributed.index);
    if (ATTRIBUTION_CONTENT.test(sentence)) add('attribution', attributed[1] ?? attributed[0]);
  }
  return claims;
}

/** The sentence a match sits in — 「。」「！」「？」「；」and newlines are the boundaries (t117). */
function sentenceAround(text: string, index: number): string {
  const boundaries = ['。', '！', '？', '；', '\n'];
  const before = boundaries.map((mark) => text.lastIndexOf(mark, index));
  const after = boundaries.map((mark) => text.indexOf(mark, index)).filter((at) => at >= 0);
  const start = Math.max(...before, -1);
  const end = after.length === 0 ? text.length : Math.min(...after);
  return text.slice(start + 1, end);
}

function languageName(code: string): string {
  if (code.toLowerCase().startsWith('zh')) return '中文';
  if (code.toLowerCase().startsWith('en')) return 'English';
  return code;
}
