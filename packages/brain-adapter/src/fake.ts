import type { TurnAction } from '@xixi/domain';

import { BrainError } from './errors.ts';
import {
  createBrainTurnStream,
  splitIntoChunks,
  type BrainAdapter,
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

export interface ScriptedOutcome {
  readonly action: TurnAction;
  readonly text: string | null;
  readonly toolName?: string | null;
}

export interface FakeBrainOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly chunkSize?: number;
  /** Deterministic default: `/tool …` exercises the tool path, blank input is silence. */
  readonly reply?: (input: UserTurnInput) => ScriptedOutcome;
}

const DEFAULT_REPLY = (input: UserTurnInput): ScriptedOutcome => {
  const text = input.text.trim();
  if (text.length === 0) return { action: 'SILENCE', text: null };
  if (text.startsWith('/tool')) {
    return { action: 'TOOL', text: '工具结果：时间已读取。', toolName: 'xixi_get_current_time' };
  }
  return { action: 'SPEAK', text: `模拟回复：${text}` };
};

/**
 * Deterministic adapter for tests, replay and offline demos. No network, no
 * key, no harness: it exists so the seams above and below the adapter can be
 * tested without a model in the loop.
 *
 * `input.images` is deliberately ignored: this stand-in makes no claim about
 * seeing anything, and a scripted reply must not depend on pixels. A test that
 * cares about the image pipeline inspects the wire body instead
 * (tests/unit/core/mimo-image-payload.test.ts).
 */
export class FakeBrainAdapter implements BrainAdapter {
  readonly provider: string;
  readonly #model: string;
  readonly #chunkSize: number;
  readonly #reply: (input: UserTurnInput) => ScriptedOutcome;

  constructor(options: FakeBrainOptions = {}) {
    this.provider = options.provider ?? 'fake';
    this.#model = options.model ?? 'fake-1';
    this.#chunkSize = options.chunkSize ?? 12;
    this.#reply = options.reply ?? DEFAULT_REPLY;
  }

  describe(): BrainDescription {
    return { provider: this.provider, model: this.#model, transport: 'in-memory', mode: 'scripted' };
  }

  async handleUserTurn(input: UserTurnInput): Promise<BrainTurnStream> {
    const outcome = this.#reply(input);
    const chunks: BrainTurnChunk[] = [];
    if (outcome.toolName !== undefined && outcome.toolName !== null) {
      chunks.push({ type: 'tool', name: outcome.toolName });
    }
    if (outcome.text !== null) chunks.push(...splitIntoChunks(outcome.text, this.#chunkSize));

    const result: BrainTurnResult = {
      action: outcome.action,
      text: outcome.text,
      toolName: outcome.toolName ?? null,
      provider: this.provider,
      model: this.#model,
      brainSessionId: `fake-${input.sessionId}`,
      latencyMs: 0,
    };

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
