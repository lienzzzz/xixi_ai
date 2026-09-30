/**
 * Conversation state machine (《方案》§12, §13).
 *
 *   IDLE --wake / direct address--> ENGAGING --turn--> ACTIVE
 *   ACTIVE --inactivity--> LINGERING --timeout--> IDLE
 *   ACTIVE/LINGERING --user asks for quiet--> SUSPENDED --expiry/resume--> IDLE
 *
 * Deterministic and clock-injected: every decision is reproducible in tests and
 * in replay (§22.3). It decides *whether a turn may be accepted at all*; what to
 * say is the model's job, and whether to speak proactively is the Proactive
 * Engine's (M5).
 */

export type ConversationState = 'IDLE' | 'ENGAGING' | 'ACTIVE' | 'LINGERING' | 'SUSPENDED';

export type TurnAcceptanceReason =
  | 'ACCEPTED_WAKE_OR_DIRECT'
  | 'ACCEPTED_CONTINUATION'
  | 'REJECTED_NOT_ADDRESSED'
  | 'REJECTED_SUSPENDED';

export interface TurnAcceptance {
  readonly accept: boolean;
  readonly reason: TurnAcceptanceReason;
  readonly state: ConversationState;
}

export interface FsmConfig {
  /** How long a reply-less window stays open after the assistant finishes (§12.2). */
  readonly lingerMs: number;
  /** How long ENGAGING waits for the first accepted turn before giving up. */
  readonly engageTimeoutMs: number;
  /**
   * Silence tolerance from the effective personality (§7.2) scales the linger
   * window: a high tolerance means the user is comfortable with pauses, so the
   * assistant keeps listening longer instead of dropping out of the session.
   */
  readonly silenceTolerance?: number;
}

export const DEFAULT_FSM_CONFIG: FsmConfig = Object.freeze({
  lingerMs: 30_000,
  engageTimeoutMs: 15_000,
  silenceTolerance: 0.7,
});

export interface FsmSnapshot {
  readonly state: ConversationState;
  readonly since: number;
  readonly lastTurnAt: number | null;
  readonly suspendedUntil: number | null;
  readonly turnCount: number;
}

export class ConversationStateMachine {
  #config: FsmConfig;
  #state: ConversationState = 'IDLE';
  #since: number;
  #lastTurnAt: number | null = null;
  #suspendedUntil: number | null = null;
  #turnCount = 0;

  constructor(config: Partial<FsmConfig> = {}, at: number = Date.now()) {
    this.#config = { ...DEFAULT_FSM_CONFIG, ...config };
    this.#since = at;
  }

  get state(): ConversationState {
    return this.#state;
  }

  get lingerMs(): number {
    const tolerance = this.#config.silenceTolerance ?? DEFAULT_FSM_CONFIG.silenceTolerance ?? 0.7;
    // tolerance 0 → half the base window; tolerance 1 → 1.5×. Keeps the number
    // bounded and explainable instead of inventing a second magic constant.
    return Math.round(this.#config.lingerMs * (0.5 + tolerance));
  }

  #move(state: ConversationState, at: number): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#since = at;
  }

  /** Expire timed states. Safe to call before every decision. */
  tick(at: number): void {
    if (this.#state === 'SUSPENDED') {
      if (this.#suspendedUntil !== null && at >= this.#suspendedUntil) {
        this.#suspendedUntil = null;
        this.#move('IDLE', at);
      }
      return;
    }
    if (this.#state === 'ENGAGING' && at - this.#since >= this.#config.engageTimeoutMs) {
      this.#move('IDLE', at);
      return;
    }
    if (this.#state === 'LINGERING' && at - this.#since >= this.lingerMs) {
      this.#move('IDLE', at);
    }
  }

  /** Someone addressed Xixi (wake word or very strong direct address, §13). */
  addressed(at: number): void {
    this.tick(at);
    if (this.#state === 'SUSPENDED') return;
    if (this.#state === 'IDLE') this.#move('ENGAGING', at);
  }

  /**
   * The POC rule from §13: in IDLE a wake word / direct address is required; once
   * a session is open, speaker + semantic continuation is enough.
   */
  shouldAcceptTurn(input: { readonly addressed: boolean; readonly at: number }): TurnAcceptance {
    this.tick(input.at);
    switch (this.#state) {
      case 'SUSPENDED':
        return { accept: false, reason: 'REJECTED_SUSPENDED', state: this.#state };
      case 'IDLE':
        return input.addressed
          ? { accept: true, reason: 'ACCEPTED_WAKE_OR_DIRECT', state: this.#state }
          : { accept: false, reason: 'REJECTED_NOT_ADDRESSED', state: this.#state };
      default:
        return { accept: true, reason: 'ACCEPTED_CONTINUATION', state: this.#state };
    }
  }

  /** A user turn entered the conversation. */
  onUserTurn(at: number): void {
    this.#lastTurnAt = at;
    this.#turnCount += 1;
    this.#move('ACTIVE', at);
  }

  /** The assistant finished speaking; the follow-up window opens. */
  onReplyCompleted(at: number): void {
    this.#lastTurnAt = at;
    this.#move('LINGERING', at);
  }

  /** "今天我想安静点" / DND: no turns are accepted until `until` (or resume()). */
  suspend(until: number | null, at: number): void {
    this.#suspendedUntil = until;
    this.#move('SUSPENDED', at);
  }

  resume(at: number): void {
    this.#suspendedUntil = null;
    this.#move('IDLE', at);
  }

  snapshot(): FsmSnapshot {
    return {
      state: this.#state,
      since: this.#since,
      lastTurnAt: this.#lastTurnAt,
      suspendedUntil: this.#suspendedUntil,
      turnCount: this.#turnCount,
    };
  }
}
