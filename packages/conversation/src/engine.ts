import { isSilenceReply, type BrainAdapter } from '@xixi/brain-adapter';
import type { Clock, TurnAction, XixiConfig, XixiStore } from '@xixi/domain';
import { systemClock } from '@xixi/domain';

import {
  ConversationStateMachine,
  type ConversationState,
  type FsmConfig,
  type TurnAcceptanceReason,
} from './fsm.ts';
import { PromptAssembler, SILENCE_TOKEN, worldStateLite, type AssembledPrompt, type PromptTurn } from './prompt.ts';

export interface ConversationEngineOptions {
  readonly adapter: BrainAdapter;
  readonly store: XixiStore;
  readonly config: XixiConfig;
  readonly clock?: Clock;
  readonly assembler?: PromptAssembler;
  readonly fsm?: Partial<FsmConfig>;
  /** Per-turn model timeout. Realtime replies should fail fast rather than hang. */
  readonly turnTimeoutMs?: number;
  /** How many prior turns enter working memory (§10.2 A). */
  readonly historyLimit?: number;
  /** Local UTC offset override, for tests and replay. */
  readonly offsetMinutes?: number;
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

export interface RespondHooks {
  /** Called for each text delta as it arrives, so TTS can start early (§46.1). */
  readonly onTextChunk?: (text: string) => void | Promise<void>;
}

export interface ConversationTurn {
  readonly accepted: boolean;
  readonly reason: TurnAcceptanceReason;
  readonly state: ConversationState;
  readonly action: TurnAction;
  readonly text: string | null;
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

  constructor(options: ConversationEngineOptions) {
    this.#adapter = options.adapter;
    this.#store = options.store;
    this.#config = options.config;
    this.#clock = options.clock ?? systemClock;
    this.#assembler = options.assembler ?? new PromptAssembler();
    this.#fsm = new ConversationStateMachine(options.fsm, this.#clock().getTime());
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 30_000;
    this.#historyLimit = options.historyLimit ?? 8;
    this.#offsetMinutes = options.offsetMinutes;
  }

  get adapter(): BrainAdapter {
    return this.#adapter;
  }

  get state(): ConversationState {
    return this.#fsm.state;
  }

  snapshot(): ReturnType<ConversationStateMachine['snapshot']> {
    return this.#fsm.snapshot();
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
      conversationState: this.#fsm.state,
      turnIndex: session.turnCount,
      history: this.workingMemory(input.sessionId),
      userText: input.text,
      language: languageName(this.#config.identity.language),
    });
  }

  async respond(input: RespondInput, hooks: RespondHooks = {}): Promise<ConversationTurn> {
    const at = input.at ?? this.#clock();
    const acceptance = this.#fsm.shouldAcceptTurn({ addressed: input.addressed ?? true, at: at.getTime() });
    if (!acceptance.accept) {
      return {
        accepted: false,
        reason: acceptance.reason,
        state: acceptance.state,
        action: 'SILENCE',
        text: null,
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

    const stream = await this.#adapter.handleUserTurn({
      sessionId: input.sessionId,
      text: input.text,
      prompt,
      timeoutMs: this.#turnTimeoutMs,
    });

    let firstChunkAt: number | null = null;
    // The silence token can arrive split across deltas ("[" + "静默" + "]"), so a
    // per-chunk check is not enough. Text is held back only while it could still
    // become the token; anything that diverges is flushed immediately, which
    // keeps normal replies streaming at full speed.
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
      await hooks.onTextChunk?.(held);
      held = '';
    }
    if (!suppressed && held.length > 0) await hooks.onTextChunk?.(held);
    const { result } = await stream.result.then((value) => ({ result: value }));

    // §55 is an engine-level rule, not an adapter's promise: whatever the adapter
    // reports, a reply that is only the silence token becomes SILENCE here, so a
    // stray control token can never reach TTS or the transcript.
    const silent = result.action === 'SILENCE' || result.text === null || isSilenceReply(result.text);
    const action: TurnAction = silent ? 'SILENCE' : result.action;
    const text = silent ? null : result.text;

    this.#store.recordTurn({
      sessionId: input.sessionId,
      role: 'assistant',
      action,
      text,
      toolName: silent ? null : result.toolName,
    });
    const finishedAt = this.#clock();
    this.#fsm.onReplyCompleted(finishedAt.getTime());

    return {
      accepted: true,
      reason: acceptance.reason,
      state: this.#fsm.state,
      action,
      text,
      provider: result.provider,
      model: result.model,
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
