import { MimoClient, ModelError, createSpokenTextFilter, type MimoChatResult, type MimoMessage, type MimoToolDefinition } from '@xixi/model-adapters';

import { BrainError, brainErrorCodeFor } from './errors.ts';
import type { ToolCallRecord, XixiTool } from './tools.ts';
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
  /** How many tool rounds a single turn may use before the model must answer. */
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
  readonly #tools: readonly XixiTool[];
  readonly #maxToolRounds: number;
  readonly #timezone: string;
  readonly #now: () => Date;
  readonly #onToolCall: ((record: ToolCallRecord) => void) | undefined;

  constructor(options: MimoBrainAdapterOptions = {}) {
    this.#client = options.client ?? new MimoClient();
    this.#model = options.model ?? this.#client.defaultModel;
    this.#thinking = options.thinking ?? false;
    this.#maxCompletionTokens = options.maxCompletionTokens ?? 400;
    this.#temperature = options.temperature ?? 0.8;
    this.#stream = options.stream ?? true;
    this.#tools = options.tools ?? [];
    this.#maxToolRounds = options.maxToolRounds ?? 2;
    this.#timezone = options.timezone ?? 'Asia/Shanghai';
    this.#now = options.now ?? (() => new Date());
    this.#onToolCall = options.onToolCall;
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

  #interpret(text: string, toolName: string | null, modelName: string, latencyMs: number): BrainTurnResult {
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
      let model = adapter.#model;
      let usedTool: string | null = null;
      // The model may (and does) emit a spoken preamble together with tool_calls
      // ("明天成都的天气我帮你查一下。" + xixi_get_weather). Text is therefore not
      // proof that the turn is answered: only the absence of tool_calls is.
      let latestText = '';
      try {
        for (let round = 1; ; round += 1) {
          const tools = adapter.#toolDefinitions(round);
          const generator = adapter.#client.chatStream({
            ...adapter.#requestOptions(input),
            messages: [...messages],
            ...(tools === undefined ? {} : { tools }),
          });

          // t7: the provider can put tool-call markup in the *text* stream (measured on the voice
          // path: 7 of 8 weather turns, and TTS read it out — baseline §4). Nothing a mouth should
          // hear leaves this loop, so the deltas go through the hygiene hold and the round's text is
          // accumulated from what the hold let through — never from the raw deltas. The hold is
          // markup-only here: the deployment language (which decides about English reasoning) is the
          // engine's configuration, not this adapter's.
          const markupHold = createSpokenTextFilter();
          let roundText = '';
          let completed: MimoChatResult;
          for (;;) {
            const next = await generator.next();
            if (next.done === true) {
              completed = next.value;
              break;
            }
            const safe = markupHold.push(next.value.text);
            roundText += safe;
            if (safe.length > 0) yield { type: 'text', text: safe };
          }
          const heldTail = markupHold.flush();
          roundText += heldTail;
          if (heldTail.length > 0) yield { type: 'text', text: heldTail };

          model = completed.model;
          if (roundText.trim().length > 0) latestText = roundText;
          if (tools === undefined || completed.toolCalls.length === 0) break;

          // Execute the requested tools, feed the results back, and let the model
          // answer in the next round.
          messages.push({
            role: 'assistant',
            content: completed.text,
            tool_calls: completed.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          });
          for (const call of completed.toolCalls) {
            const { record, message } = await adapter.#executeTool(call.name, call.arguments, input);
            usedTool = record.name;
            yield { type: 'tool', name: record.name };
            messages.push(message);
          }
        }

        const final = adapter.#interpret(latestText, usedTool, model, Date.now() - startedAt);
        settle?.resolve(final);
      } catch (cause) {
        const error = toBrainError(cause);
        settle?.reject(error);
        throw error;
      }
    }

    return createBrainTurnStream(run(), result);
  }

  #toolDefinitions(round: number): MimoToolDefinition[] | undefined {
    if (this.#tools.length === 0 || round > this.#maxToolRounds) return undefined;
    return this.#tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async #executeTool(
    name: string,
    rawArguments: string,
    input: UserTurnInput,
  ): Promise<{ record: ToolCallRecord; message: MimoMessage }> {
    const tool = this.#tools.find((candidate) => candidate.name === name);
    const reply = (payload: Record<string, unknown>, id: string): MimoMessage => ({
      role: 'tool',
      tool_call_id: id,
      content: JSON.stringify(payload),
    });
    const callId = `call_${name}_${Math.random().toString(36).slice(2, 10)}`;

    if (tool === undefined) {
      // An unknown tool is a refusal, not a crash: the model gets told and must
      // still answer, which keeps a hallucinated tool name from breaking the turn.
      const record: ToolCallRecord = { name, args: {}, ok: false, result: null, error: 'UNKNOWN_TOOL' };
      this.#onToolCall?.(record);
      return { record, message: reply({ error: '没有这个工具，请直接用已有信息回答' }, callId) };
    }

    let args: Record<string, unknown> = {};
    try {
      const parsed = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      args = {};
    }

    try {
      const result = await tool.execute(args, {
        timezone: this.#timezone,
        now: this.#now(),
      });
      const record: ToolCallRecord = { name, args, ok: true, result, error: null };
      this.#onToolCall?.(record);
      return { record, message: reply(result, callId) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const record: ToolCallRecord = { name, args, ok: false, result: null, error: message };
      this.#onToolCall?.(record);
      return { record, message: reply({ error: message }, callId) };
    }
    void input;
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
