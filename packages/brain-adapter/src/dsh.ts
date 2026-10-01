import type { JsonValue } from '@xixi/contracts';
import type { TurnAction } from '@xixi/domain';

import { BrainError, brainErrorCodeFor, toBrainErrorCauseCode } from './errors.ts';
import {
  createBrainTurnStream,
  flattenPrompt,
  splitIntoChunks,
  type BrainAdapter,
  type BrainContext,
  type BrainDescription,
  type BrainTurnChunk,
  type BrainTurnResult,
  type BrainTurnStream,
  type FeedbackDecision,
  type FeedbackInput,
  type MemoryCandidate,
  type MemoryExtractionInput,
  type ProactiveContext,
  type ProactiveDecision,
  type ReflectionInput,
  type ReflectionResult,
  type UserTurnInput,
} from './types.ts';

/**
 * The DSH side of the seam, expressed in Xixi's own words.
 *
 * `DshTransport` is deliberately harness-shaped but model-agnostic: it takes one
 * user turn with an optional provider session to resume, and answers with the
 * turn outcome plus the provider session id to persist. A transport may be an
 * in-process script, a subprocess speaking NDJSON, or (later) a socket — the
 * adapter above it does not change.
 *
 * M0 transports are request/response. Token-level streaming arrives with M1,
 * when TTS needs to start before the whole reply exists (§46.1).
 */
export interface DshTurnRequest {
  readonly kind: 'turn';
  readonly requestId: string;
  /** Xixi's conversation session; the transport must not need to understand it further. */
  readonly sessionId: string;
  /** Provider session to continue, or null to start a new one. */
  readonly resumeBrainSessionId: string | null;
  readonly text: string;
  /**
   * Fully composed harness task. When the conversation layer owns prompt
   * assembly (§26) it arrives here already flattened; otherwise the transport
   * composes one from `context`.
   */
  readonly task: string | null;
  readonly context: {
    readonly identityName: string;
    readonly personality: Readonly<Record<string, number>>;
    readonly timezone: string | null;
    readonly workingMemory: readonly { readonly role: string; readonly text: string | null }[];
  };
}

export interface DshTurnResponse {
  readonly requestId: string;
  readonly ok: boolean;
  readonly brainSessionId: string | null;
  readonly action: TurnAction;
  readonly text: string | null;
  readonly toolName: string | null;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs?: number;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface DshTransport {
  readonly kind: string;
  turn(request: DshTurnRequest, options?: { readonly timeoutMs?: number }): Promise<DshTurnResponse>;
  close?(): Promise<void> | void;
}

/** The slice of durable state the adapter needs; `XixiStore` satisfies it structurally. */
export interface BrainSessionStore {
  brainSessionId(sessionId: string, provider: string): string | null;
  attachBrainSession(sessionId: string, provider: string, brainSessionId: string): unknown;
}

export interface DshBrainAdapterOptions {
  readonly transport: DshTransport;
  readonly store: BrainSessionStore;
  /** Provider key for the durable session mapping; defaults to `dsh`. */
  readonly provider?: string;
  readonly clock?: () => number;
  readonly requestIdFactory?: () => string;
}

export class DshBrainAdapter implements BrainAdapter {
  readonly provider: string;
  readonly #transport: DshTransport;
  readonly #store: BrainSessionStore;
  readonly #clock: () => number;
  readonly #requestIdFactory: () => string;
  #lastModel = 'unknown';

  constructor(options: DshBrainAdapterOptions) {
    this.#transport = options.transport;
    this.#store = options.store;
    this.provider = options.provider ?? 'dsh';
    this.#clock = options.clock ?? (() => Date.now());
    this.#requestIdFactory = options.requestIdFactory ?? (() => `req_${crypto.randomUUID()}`);
  }

  describe(): BrainDescription {
    return { provider: this.provider, model: this.#lastModel, transport: this.#transport.kind, mode: 'live' };
  }

  async close(): Promise<void> {
    await this.#transport.close?.();
  }

  async handleUserTurn(input: UserTurnInput): Promise<BrainTurnStream> {
    // The harness path flattens a turn into one task string, so it cannot carry
    // an image yet. Dropping `input.images` here would let the model answer as if
    // it had seen the frame, so the seam refuses instead: the caller can fall back
    // to the direct MiMo path (`MimoBrainAdapter`), which does send images
    // (docs/recon/mimo-vision-probe-2026-09-30.md).
    if (input.images !== undefined && input.images.length > 0) {
      throw new BrainError('BAD_REQUEST', 'the DSH harness path cannot send images yet', {
        detail: `${input.images.length} image(s) were supplied; use the direct MiMo path for image turns`,
      });
    }
    const resumeBrainSessionId = this.#store.brainSessionId(input.sessionId, this.provider);
    const context: BrainContext = input.context ?? { identityName: '西西', personality: {} };
    const request: DshTurnRequest = {
      kind: 'turn',
      requestId: this.#requestIdFactory(),
      sessionId: input.sessionId,
      resumeBrainSessionId,
      text: input.text,
      task: input.prompt === undefined ? null : flattenPrompt(input.prompt),
      context: {
        identityName: context.identityName,
        personality: context.personality,
        timezone: context.timezone ?? null,
        workingMemory: (context.workingMemory ?? []).map((turn) => ({ role: turn.role, text: turn.text })),
      },
    };

    const startedAt = this.#clock();
    let response: DshTurnResponse;
    try {
      response = await this.#transport.turn(request, input.timeoutMs === undefined ? undefined : { timeoutMs: input.timeoutMs });
    } catch (cause) {
      if (cause instanceof BrainError) throw cause;
      throw new BrainError('TRANSPORT_FAILED', 'the harness transport did not answer', {
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (response.requestId !== request.requestId) {
      throw new BrainError('INVALID_RESPONSE', 'harness answered a different request', {
        detail: `expected ${request.requestId}, received ${response.requestId}`,
      });
    }
    if (!response.ok) {
      // The harness reports its own error code, and this is where the useful class
      // is lost today: `BrainError.code` stays PROVIDER_FAILED for the harness
      // boundary, but the real code travels in `originalCode` (and the detail), so
      // §21.1 does not have to parse text to tell "bad credential" from "provider
      // fault". `brainErrorCodeFor` is the same table the direct path uses, so the
      // two paths cannot disagree about what a code means.
      const providerCode = response.error?.code ?? 'UNKNOWN';
      throw new BrainError('PROVIDER_FAILED', 'the harness reported a failed turn', {
        detail: `${providerCode}: ${response.error?.message ?? 'no detail'}`,
        originalCode: toBrainErrorCauseCode(providerCode),
      });
    }
    if (response.brainSessionId !== null && response.brainSessionId !== resumeBrainSessionId) {
      this.#store.attachBrainSession(input.sessionId, this.provider, response.brainSessionId);
    }
    this.#lastModel = response.model;

    const result: BrainTurnResult = {
      action: response.action,
      text: response.text,
      toolName: response.toolName,
      provider: response.provider,
      model: response.model,
      brainSessionId: response.brainSessionId ?? resumeBrainSessionId,
      latencyMs: response.latencyMs ?? this.#clock() - startedAt,
      // t21: the harness protocol does not report a stop reason; saying `null` is honest, and the
      // direct path is where `length` truncation shows up.
      finishReason: null,
    };

    const chunks: BrainTurnChunk[] = [];
    if (result.toolName !== null) chunks.push({ type: 'tool', name: result.toolName });
    if (result.text !== null) chunks.push(...splitIntoChunks(result.text));

    async function* replay(): AsyncGenerator<BrainTurnChunk> {
      for (const chunk of chunks) yield chunk;
    }
    return createBrainTurnStream(replay(), Promise.resolve(result));
  }

  evaluateProactiveCandidate(_input: ProactiveContext): Promise<ProactiveDecision> {
    return notImplemented('evaluateProactiveCandidate', 'M5');
  }

  interpretFeedback(_input: FeedbackInput): Promise<FeedbackDecision> {
    return notImplemented('interpretFeedback', 'M3');
  }

  extractMemories(_input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
    return notImplemented('extractMemories', 'M4');
  }

  reflect(_input: ReflectionInput): Promise<ReflectionResult> {
    return notImplemented('reflect', 'M4/M5');
  }
}

function notImplemented(capability: string, milestone: string): Promise<never> {
  return Promise.reject(
    new BrainError('NOT_IMPLEMENTED', `${capability} is not implemented yet`, {
      milestone,
      detail: 'declared in M0 to fix the seam; implemented in the named milestone',
    }),
  );
}

/** Narrow helper for transports that only need to move JSON over a socket. */
export type DshJson = JsonValue;
