import { buildEvent, toOffsetIso } from '@xixi/contracts';
import { isSilenceReply, type BrainAdapter } from '@xixi/brain-adapter';
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
      });

      // The silence token can arrive split across deltas ("[" + "静默" + "]"), so a
      // per-chunk check is not enough. Text is held back only while it could still
      // become the token; anything that diverges is flushed immediately, which
      // keeps normal replies streaming at full speed. The holding still happens
      // when the caller plays segments — the token must be detected exactly the
      // same way — only the handoff is skipped.
      let held = '';
      let suppressed = false;
      for await (const chunk of stream) {
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
        if (!playSegments) await hooks.onTextChunk?.(held);
        held = '';
      }
      if (!playSegments && !suppressed && held.length > 0) await hooks.onTextChunk?.(held);
      const result = await stream.result;

      // §55 is an engine-level rule, not an adapter's promise: whatever the adapter
      // reports, a reply that is only the silence token becomes SILENCE here, so a
      // stray control token can never reach TTS or the transcript.
      const silent = result.action === 'SILENCE' || result.text === null || isSilenceReply(result.text);
      turnAction = silent ? 'SILENCE' : result.action;
      turnText = silent ? null : result.text;
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

function languageName(code: string): string {
  if (code.toLowerCase().startsWith('zh')) return '中文';
  if (code.toLowerCase().startsWith('en')) return 'English';
  return code;
}
