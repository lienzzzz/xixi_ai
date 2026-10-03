import { MimoClient, ModelError, createSpokenTextFilter, type MimoChatResult, type MimoMessage } from '@xixi/model-adapters';

import { runAgentLoop, type AgentLoopResult, type AgentStep, type AgentStepOutcome } from './agent-loop.ts';
import { BrainError, brainErrorCodeFor } from './errors.ts';
import { MAX_TOOL_ROUNDS, ToolRegistry } from './tool-registry.ts';
import { asAgentTool, type AgentScope, type ToolCallRecord, type XixiTool } from './tools.ts';
import {
  createBrainTurnStream,
  flattenPrompt,
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

export const SILENCE_TOKEN = '[静默]';

export interface MimoBrainAdapterOptions {
  readonly client?: MimoClient;
  readonly model?: string;
  /** Real-time dialogue must not think (§46.1); background roles can turn it on. */
  readonly thinking?: boolean;
  readonly maxCompletionTokens?: number;
  readonly temperature?: number;
  /** Off when the caller wants the whole reply before acting (e.g. evaluation). */
  readonly stream?: boolean;
  /** Read-only tools the model may request (§27). Empty means none. */
  readonly tools?: readonly XixiTool[];
  /**
   * The tool chain to use instead of `tools` (pack Phase 2): the *same* registry the
   * other entry points build, so text and voice run identical permissions and rounds.
   * When supplied, the registry's own `onToolCall` (not this option's) reports calls.
   */
  readonly registry?: ToolRegistry;
  /** Which agent surface this adapter is serving; the registry filters by it. */
  readonly scope?: AgentScope;
  /**
   * t21: the deployment's reply language (`config.identity.language`). The reply-hygiene filter judges
   * a foreign (reasoning) run against it.
   *
   * Omitting it is **not** a pass-through: the constructor falls back to `zh-CN`, so the Chinese rules
   * then apply to every deployment, and a deployment that speaks something else has its own long
   * Han-free lines held back or dropped as if they were reasoning. Pass the configured language so the
   * filter follows the deployment (t14/T5-F3 — the wording here used to promise a pass-through leak
   * this seam never had).
   */
  readonly language?: string;
  /**
   * How many tool rounds a single turn may use before the model must answer. Built from
   * `tools`, it is clamped by the registry to `MAX_TOOL_ROUNDS` (= 4, pack Phase 2).
   */
  readonly maxToolRounds?: number;
  readonly timezone?: string;
  readonly now?: () => Date;
  readonly onToolCall?: (record: ToolCallRecord) => void;
}

/**
 * Translate a provider-layer failure without losing its class (§21.1).
 *
 * The old mapping collapsed everything except TIMEOUT into PROVIDER_FAILED, so a
 * wrong key, a rate limit and a 500 were indistinguishable above this seam and
 * §21 降级 could not tell "fix the credential" from "back off and retry" from
 * "the provider is broken". `originalCode` keeps the provider code as well, so a
 * consumer never has to parse the message text.
 */
function toBrainError(cause: unknown): BrainError {
  if (cause instanceof BrainError) return cause;
  if (cause instanceof ModelError) {
    const { code } = brainErrorCodeFor(cause.code);
    return new BrainError(code, 'model call failed', {
      detail: `${cause.code}: ${cause.message}`,
      originalCode: cause.code,
    });
  }
  return new BrainError('TRANSPORT_FAILED', 'model call failed', {
    detail: cause instanceof Error ? cause.message : String(cause),
  });
}

/** §55: silence is a first-class outcome, and the token is never spoken. */
export function isSilenceReply(text: string): boolean {
  const trimmed = text.trim().replace(/[。．.!！?？\s"'`]/g, '');
  return trimmed.length === 0 || trimmed === SILENCE_TOKEN;
}

/**
 * Direct MiMo conversation adapter — the real-time path.
 *
 * Why this exists next to `DshBrainAdapter`: DSH is a full agent harness, and a
 * companion turn should neither pay for nor be framed by an agent runtime.
 * Measured on this machine, a `dsh` turn costs 4–7 s wall clock because every turn
 * boots a profile, while a direct chat call is one HTTP round trip. The plan keeps
 * the harness replaceable precisely so this choice can be made on evidence
 * (§3.2, §25, §44); DSH remains the harness path proven in M0 and the home for the
 * structured meta-agents that need its session and tool machinery.
 *
 * Thinking is disabled by default: MiMo reasons by default, which costs latency
 * and can consume the entire completion budget on a short reply.
 *
 * Streaming note: when `stream` is on, the turn result settles only after the
 * chunk generator has been consumed (that is how an async generator's return
 * value is observed). `collectTurn` does both; a consumer that awaits `result`
 * without iterating must use `stream: false`.
 */
export class MimoBrainAdapter implements BrainAdapter {
  readonly provider = 'mimo-direct';
  readonly #client: MimoClient;
  readonly #model: string;
  readonly #thinking: boolean;
  readonly #maxCompletionTokens: number;
  readonly #temperature: number;
  readonly #stream: boolean;
  readonly #registry: ToolRegistry;
  readonly #scope: AgentScope;
  readonly #timezone: string;
  /** t21: reply language, used by the hygiene filter on the streaming seam. */
  readonly #language: string;
  readonly #now: () => Date;

  constructor(options: MimoBrainAdapterOptions = {}) {
    this.#client = options.client ?? new MimoClient();
    this.#model = options.model ?? this.#client.defaultModel;
    this.#thinking = options.thinking ?? false;
    this.#maxCompletionTokens = options.maxCompletionTokens ?? 400;
    this.#temperature = options.temperature ?? 0.8;
    this.#stream = options.stream ?? true;
    this.#scope = options.scope ?? 'conversation';
    // The program's tool chain: either injected (shared with the rest of the entry
    // point) or built here from a plain tool list. Either way the round cap and the
    // permission checks happen inside the registry, never in the model.
    this.#registry =
      options.registry ??
      new ToolRegistry({
        tools: (options.tools ?? []).map((tool) => asAgentTool(tool)),
        maxToolRounds: options.maxToolRounds ?? MAX_TOOL_ROUNDS,
        ...(options.onToolCall === undefined ? {} : { onToolCall: options.onToolCall }),
      });
    this.#timezone = options.timezone ?? 'Asia/Shanghai';
    this.#language = options.language ?? 'zh-CN';
    this.#now = options.now ?? (() => new Date());
  }

  describe(): BrainDescription {
    return {
      provider: this.provider,
      model: this.#model,
      transport: 'https-api',
      mode: this.#client.hasKey ? 'live' : 'offline',
    };
  }

  #messages(input: UserTurnInput): MimoMessage[] {
    const messages: MimoMessage[] = [];
    // Images belong to the current user turn, so they ride on the last user
    // message of whichever path builds the list.
    const images = input.images === undefined || input.images.length === 0 ? undefined : input.images;
    if (input.prompt !== undefined) {
      messages.push({ role: 'system', content: input.prompt.system });
      for (const turn of input.prompt.history) {
        if (turn.content.length === 0) continue;
        messages.push({ role: turn.role === 'user' ? 'user' : 'assistant', content: turn.content });
      }
      messages.push({ role: 'user', content: input.prompt.user, ...(images === undefined ? {} : { images }) });
      return messages;
    }
    if (input.context !== undefined) {
      messages.push({
        role: 'system',
        content: `你是「${input.context.identityName}」，一个陪伴家人的存在。说话自然、简短，不要提及实现细节。`,
      });
      for (const turn of input.context.workingMemory ?? []) {
        if (turn.text === null || turn.text.length === 0) continue;
        messages.push({ role: turn.role === 'user' ? 'user' : 'assistant', content: turn.text });
      }
    }
    messages.push({ role: 'user', content: input.text, ...(images === undefined ? {} : { images }) });
    return messages;
  }

  #interpret(
    text: string,
    toolName: string | null,
    modelName: string,
    latencyMs: number,
    finishReason: string | null,
  ): BrainTurnResult {
    const silent = isSilenceReply(text);
    // §55 semantics: the action describes what the turn *did*. A turn that used a
    // tool and then spoke is SPEAK, with `toolName` kept for the audit trail;
    // TOOL is reserved for a turn that produced no spoken answer at all.
    const action = !silent ? 'SPEAK' : toolName === null ? 'SILENCE' : 'TOOL';
    return {
      action,
      text: silent ? null : text.trim(),
      toolName,
      provider: this.provider,
      model: modelName,
      brainSessionId: null,
      latencyMs,
      finishReason,
    };
  }

  #requestOptions(input: UserTurnInput): {
    model: string;
    messages: MimoMessage[];
    thinking: boolean;
    maxCompletionTokens: number;
    temperature: number;
    timeoutMs?: number;
  } {
    return {
      model: this.#model,
      messages: this.#messages(input),
      thinking: this.#thinking,
      maxCompletionTokens: this.#maxCompletionTokens,
      temperature: this.#temperature,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    };
  }

  handleUserTurn(input: UserTurnInput): Promise<BrainTurnStream> {
    if (!this.#stream) return this.#handleBuffered(input);
    return Promise.resolve(this.#handleStreaming(input));
  }

  /**
   * Buffered mode = the streaming path, drained and replayed as one chunk. One
   * code path means tool calls cannot behave differently between the two modes.
   */
  async #handleBuffered(input: UserTurnInput): Promise<BrainTurnStream> {
    const stream = this.#handleStreaming(input);
    const chunks: BrainTurnChunk[] = [];
    try {
      for await (const chunk of stream) chunks.push(chunk);
      const result = await stream.result;
      return createBrainTurnStream(replay(chunks), Promise.resolve(result));
    } catch (cause) {
      throw toBrainError(cause);
    }
  }

  #handleStreaming(input: UserTurnInput): BrainTurnStream {
    const adapter = this;
    const messages: MimoMessage[] = this.#messages(input);
    const startedAt = Date.now();
    let settle: { resolve: (result: BrainTurnResult) => void; reject: (cause: unknown) => void } | null = null;
    const result = new Promise<BrainTurnResult>((resolve, reject) => {
      settle = { resolve, reject };
    });
    result.catch(() => {});

    async function* run(): AsyncGenerator<BrainTurnChunk> {
      try {
        /**
         * One streaming model round. The provider's deltas go through the reply-hygiene hold
         * *inside* the step, so nothing a mouth should not hear ever leaves it; the loop above
         * only decides how many rounds there are and which tools run.
         */
        const step: AgentStep = {
          call: async function* (roundMessages, tools): AsyncGenerator<BrainTurnChunk, AgentStepOutcome, void> {
            const generator = adapter.#client.chatStream({
              ...adapter.#requestOptions(input),
              messages: [...roundMessages],
              ...(tools === undefined ? {} : { tools }),
            });

            // t7/t21: the provider can put tool-call markup in the *text* stream (measured on the voice
            // path: 7 of 8 weather turns, and TTS read it out — baseline §4), and the model can reason
            // in English mid-answer. Nothing a mouth should hear leaves this step, so the deltas go
            // through the hygiene hold with the deployment **language**: omitted, the adapter falls
            // back to `zh-CN` and applies the Chinese rules to a deployment that may not speak Chinese
            // (t14/T5-F3) — and the round's text is accumulated from what the hold let through, never
            // from the raw deltas.
            const markupHold = createSpokenTextFilter({ language: adapter.#language });
            let spokenText = '';
            let completed: MimoChatResult;
            for (;;) {
              const next = await generator.next();
              if (next.done === true) {
                completed = next.value;
                break;
              }
              const safe = markupHold.push(next.value.text);
              spokenText += safe;
              if (safe.length > 0) yield { type: 'text', text: safe };
            }
            const heldTail = markupHold.flush();
            spokenText += heldTail;
            if (heldTail.length > 0) yield { type: 'text', text: heldTail };

            return {
              model: completed.model,
              finishReason: completed.finishReason,
              rawText: completed.text,
              spokenText,
              toolCalls: completed.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
            };
          },
        };

        const iterator = runAgentLoop(step, messages, {
          registry: adapter.#registry,
          scope: adapter.#scope,
          context: { timezone: adapter.#timezone, clock: adapter.#now },
        });
        let outcome: AgentLoopResult;
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) {
            outcome = next.value;
            break;
          }
          yield next.value;
        }

        const final = adapter.#interpret(
          outcome.text,
          outcome.usedTools.at(-1) ?? null,
          outcome.model,
          Date.now() - startedAt,
          outcome.finishReason,
        );
        settle?.resolve(final);
      } catch (cause) {
        const error = toBrainError(cause);
        settle?.reject(error);
        throw error;
      }
    }

    return createBrainTurnStream(run(), result);
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

async function* replay(chunks: readonly BrainTurnChunk[]): AsyncGenerator<BrainTurnChunk> {
  for (const chunk of chunks) yield chunk;
}

function notImplemented(capability: string, milestone: string): Promise<never> {
  return Promise.reject(
    new BrainError('NOT_IMPLEMENTED', `${capability} is not implemented yet`, {
      milestone,
      detail: 'declared in M0 to fix the seam; implemented in the named milestone',
    }),
  );
}

export { flattenPrompt };
