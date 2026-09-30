import type { TurnAction } from '@xixi/domain';

import type { DshTransport, DshTurnRequest, DshTurnResponse } from './dsh.ts';

export interface ScriptedTurn {
  readonly action?: TurnAction;
  readonly text?: string | null;
  readonly toolName?: string | null;
  readonly ok?: boolean;
  readonly brainSessionId?: string | null;
  readonly error?: { readonly code: string; readonly message: string };
  /** Fail the transport itself instead of returning a failed turn. */
  readonly throwTransport?: string;
  readonly delayMs?: number;
}

export interface ScriptedTransportOptions {
  readonly kind?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly sessionId?: string;
  readonly turns: readonly ScriptedTurn[];
}

/**
 * Offline transport for tests and replay: answers from a script, records every
 * request, and mimics the harness' session semantics (the first turn mints a
 * session id, later turns keep the one they were resumed with).
 */
export class ScriptedDshTransport implements DshTransport {
  readonly kind: string;
  readonly requests: DshTurnRequest[] = [];
  #turns: readonly ScriptedTurn[];
  #index = 0;
  #provider: string;
  #model: string;
  #sessionId: string;
  #minted = false;

  constructor(options: ScriptedTransportOptions) {
    this.kind = options.kind ?? 'scripted';
    this.#turns = options.turns;
    this.#provider = options.provider ?? 'dsh';
    this.#model = options.model ?? 'scripted-model';
    this.#sessionId = options.sessionId ?? 'session-scripted-0001';
  }

  async turn(request: DshTurnRequest): Promise<DshTurnResponse> {
    this.requests.push(request);
    const scripted = this.#turns[this.#index];
    if (scripted === undefined) {
      throw new Error(`ScriptedDshTransport ran out of turns at request ${this.#index + 1}`);
    }
    this.#index += 1;
    if (scripted.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
    }
    if (scripted.throwTransport !== undefined) throw new Error(scripted.throwTransport);

    const resumed = request.resumeBrainSessionId;
    if (resumed === null) this.#minted = true;
    const brainSessionId = scripted.brainSessionId !== undefined ? scripted.brainSessionId : resumed ?? this.#sessionId;

    return {
      requestId: request.requestId,
      ok: scripted.ok ?? true,
      brainSessionId,
      action: scripted.action ?? ((scripted.text ?? '') === '' ? 'SILENCE' : 'SPEAK'),
      text: scripted.text ?? null,
      toolName: scripted.toolName ?? null,
      provider: this.#provider,
      model: this.#model,
      latencyMs: 1,
      ...(scripted.error === undefined ? {} : { error: scripted.error }),
    };
  }

  /** True once a turn ran without a session to resume, i.e. a session was minted. */
  get mintedSession(): boolean {
    return this.#minted;
  }
}
