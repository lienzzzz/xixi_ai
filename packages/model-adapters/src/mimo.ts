import { classifyStatus, ModelError } from './errors.ts';

/**
 * Xiaomi MiMo client, verified against the live API (docs/recon/mimo-api-probe-2026-09-29.md).
 *
 * Facts this file encodes, all measured rather than assumed:
 *   * `POST /v1/chat/completions`; `api-key:` header (Bearer also works, api-key wins).
 *   * Thinking is **on by default**; only `thinking: {type:'disabled'}` or
 *     `reasoning_effort:'none'` actually turns it off (`enable_thinking` is ignored).
 *   * `tool_choice` is ignored except `auto`, so a forced tool call is impossible.
 *   * `response_format` accepts `json_schema` / `json_object`; `strict` is not proven
 *     to be enforced, so structured results are validated locally.
 *   * `GET /models` (no `/v1`) is the working model list; `/v1/models` is 404.
 *
 * The API key is never logged, echoed in errors, or included in thrown details.
 */

export type MimoRole = 'system' | 'user' | 'assistant' | 'tool';

export interface MimoMessage {
  readonly role: MimoRole;
  readonly content: string;
  /** Present on the assistant message that requested tools. */
  readonly tool_calls?: {
    readonly id: string;
    readonly type: 'function';
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
  /** Present on the `tool` message that answers a `tool_calls` entry. */
  readonly tool_call_id?: string;
}

export interface MimoToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON string as returned by the API (arguments are not pre-parsed). */
  readonly arguments: string;
}

export interface MimoUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number;
  readonly cachedTokens: number;
}

export interface MimoChatResult {
  readonly text: string;
  readonly toolCalls: readonly MimoToolCall[];
  readonly model: string;
  readonly usage: MimoUsage;
  readonly finishReason: string | null;
  readonly firstTokenMs: number | null;
  readonly totalMs: number;
}

export interface MimoChatOptions {
  readonly model?: string;
  readonly messages: readonly MimoMessage[];
  readonly maxCompletionTokens?: number;
  /** Default `false`: realtime dialogue runs without deep thinking (§46.1). */
  readonly thinking?: boolean;
  readonly temperature?: number;
  readonly jsonSchema?: { readonly name: string; readonly schema: Record<string, unknown>; readonly strict?: boolean };
  readonly jsonObject?: boolean;
  readonly tools?: readonly MimoToolDefinition[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface MimoToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface MimoClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_MODEL = 'mimo-v2.6-flash';
const DEFAULT_TIMEOUT_MS = 60_000;

interface RawChoice {
  message?: {
    content?: string | null;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] | null;
  };
  finish_reason?: string | null;
}
interface RawResponse {
  model?: string;
  choices?: RawChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; code?: string | number; type?: string };
}

export class MimoClient {
  readonly baseUrl: string;
  readonly defaultModel: string;
  #apiKey: string | undefined;
  #timeoutMs: number;
  #fetch: typeof fetch;

  constructor(options: MimoClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.MIMO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.#apiKey = options.apiKey ?? process.env.MIMO_API_KEY;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get hasKey(): boolean {
    return this.#apiKey !== undefined && this.#apiKey.length > 0;
  }

  #headers(): Record<string, string> {
    if (!this.hasKey) {
      throw new ModelError('MISSING_KEY', 'MIMO_API_KEY is not set');
    }
    return { 'api-key': this.#apiKey as string, 'content-type': 'application/json' };
  }

  async #post(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/abort/i.test(message)) throw new ModelError('TIMEOUT', `request exceeded ${timeoutMs} ms`);
      throw new ModelError('NETWORK', 'could not reach the model endpoint', { detail: message });
    }
    if (!response.ok) {
      let detail = '';
      try {
        const payload = (await response.json()) as RawResponse;
        detail = payload.error?.message ?? JSON.stringify(payload).slice(0, 300);
      } catch {
        detail = (await response.text().catch(() => '')).slice(0, 300);
      }
      throw new ModelError(classifyStatus(response.status), `model request failed`, { status: response.status, detail });
    }
    return response;
  }

  /** One non-streaming chat completion. */
  async chat(options: MimoChatOptions): Promise<MimoChatResult> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const startedAt = Date.now();
    const body = this.#body(options, false);
    const response = await this.#post('/chat/completions', body, timeoutMs, options.signal);
    let payload: RawResponse;
    try {
      payload = (await response.json()) as RawResponse;
    } catch (cause) {
      throw new ModelError('INVALID_RESPONSE', 'model returned a non-JSON body', {
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const choice = payload.choices?.[0];
    if (choice === undefined) throw new ModelError('INVALID_RESPONSE', 'model returned no choices');
    return {
      text: choice.message?.content ?? '',
      toolCalls: (choice.message?.tool_calls ?? []).map((call) => ({
        id: call.id ?? '',
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '{}',
      })),
      model: payload.model ?? options.model ?? this.defaultModel,
      usage: toUsage(payload),
      finishReason: choice.finish_reason ?? null,
      firstTokenMs: null,
      totalMs: Date.now() - startedAt,
    };
  }

  /**
   * Streaming chat. Yields text deltas as they arrive so TTS can start before the
   * reply is complete (§46.1 Level 2); the returned result carries usage and timing.
   */
  async *chatStream(options: MimoChatOptions): AsyncGenerator<{ type: 'text'; text: string }, MimoChatResult, void> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const startedAt = Date.now();
    const response = await this.#post('/chat/completions', this.#body(options, true), timeoutMs, options.signal);
    if (response.body === null) throw new ModelError('INVALID_RESPONSE', 'streaming response had no body');

    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let firstTokenMs: number | null = null;
    const toolCalls = new Map<string, { name: string; args: string }>();
    let usage: MimoUsage = emptyUsage();
    let model = options.model ?? this.defaultModel;
    let finishReason: string | null = null;

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        let event: {
          model?: string;
          choices?: {
            delta?: {
              content?: string | null;
              tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] | null;
            };
            finish_reason?: string | null;
          }[];
          usage?: RawResponse['usage'];
        };
        try {
          event = JSON.parse(data) as typeof event;
        } catch {
          continue;
        }
        if (event.model !== undefined) model = event.model;
        if (event.usage !== undefined) usage = toUsage({ usage: event.usage });
        const choice = event.choices?.[0];
        if (choice === undefined) continue;
        if (choice.finish_reason != null) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta?.content != null && delta.content.length > 0) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
          text += delta.content;
          yield { type: 'text', text: delta.content };
        }
        for (const call of delta?.tool_calls ?? []) {
          const key = String(call.index ?? 0);
          const existing = toolCalls.get(key) ?? { name: '', args: '' };
          toolCalls.set(key, {
            name: call.function?.name ?? existing.name,
            args: existing.args + (call.function?.arguments ?? ''),
          });
        }
      }
    }

    return {
      text,
      toolCalls: [...toolCalls.values()].map((call, index) => ({ id: `call_${index}`, name: call.name, arguments: call.args || '{}' })),
      model,
      usage,
      finishReason,
      firstTokenMs,
      totalMs: Date.now() - startedAt,
    };
  }

  /** Speech recognition. Fixtures are WAV/MP3 buffers; the API takes base64 inline audio. */
  async transcribe(audio: Buffer | Uint8Array, options: { language?: string; format?: 'wav' | 'mp3'; timeoutMs?: number } = {}): Promise<{ text: string; model: string }> {
    const format = options.format ?? 'wav';
    const mime = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const payload = {
      model: 'mimo-v2.5-asr',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: `data:${mime};base64,${Buffer.from(audio).toString('base64')}` },
            },
          ],
        },
      ],
      asr_options: { language: options.language ?? 'zh' },
    };
    const response = await this.#post('/chat/completions', payload, options.timeoutMs ?? 120_000);
    const body = (await response.json()) as RawResponse;
    const text = body.choices?.[0]?.message?.content;
    if (text == null) throw new ModelError('INVALID_RESPONSE', 'ASR returned no transcript');
    return { text: text.trim(), model: body.model ?? 'mimo-v2.5-asr' };
  }

  /** Speech synthesis; returns a WAV buffer. */
  async synthesize(
    text: string,
    options: { voice?: string; timeoutMs?: number; speed?: number; emotion?: string } = {},
  ): Promise<Buffer> {
    const payload = {
      model: 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: text }],
      audio: {
        format: 'wav',
        voice: options.voice ?? 'mimo_default',
        ...(options.speed === undefined ? {} : { speed: options.speed }),
        ...(options.emotion === undefined ? {} : { emotion: options.emotion }),
      },
    };
    const response = await this.#post('/chat/completions', payload, options.timeoutMs ?? 120_000);
    const body = (await response.json()) as { choices?: { message?: { audio?: { data?: string } } }[] };
    const encoded = body.choices?.[0]?.message?.audio?.data;
    if (encoded === undefined || encoded.length === 0) {
      throw new ModelError('INVALID_RESPONSE', 'TTS returned no audio payload');
    }
    return Buffer.from(encoded, 'base64');
  }

  /**
   * Structured call with a bounded repair path.
   *
   * Measured defect (2026-09-30): MiMo's `response_format: json_schema`
   * *intermittently* pads the completion with whitespace until it hits the token
   * cap, returning truncated JSON with `finish_reason: "length"`. It happened
   * with `strict: true` (2/3 attempts) and with `strict: false` (1/3), so this is
   * a provider-path problem, not a `strict` problem.
   *
   * Meta-agents cannot be built on a path that fails a third of the time, so the
   * client owns the workaround: try `json_schema`, and on a failed parse retry
   * once with `json_object` plus an explicit "no padding" instruction. Parsing is
   * still done here; **schema validation stays with the caller**, who owns the
   * schema (§52: validate contracts locally, never trust the provider).
   */
  async chatJson(
    options: MimoChatOptions & {
      readonly schema: { readonly name: string; readonly schema: Record<string, unknown> };
      /** Contract check owned by the caller (e.g. `assertSchema`); throwing triggers the fallback. */
      readonly validate?: (value: unknown) => void;
    },
  ): Promise<{ json: unknown; model: string; usage: MimoUsage; attempts: number; notes: string[]; totalMs: number }> {
    const notes: string[] = [];
    const startedAt = Date.now();
    const check = (value: unknown): string | null => {
      if (options.validate === undefined) return null;
      try {
        options.validate(value);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const first = await this.chat({
      ...options,
      jsonSchema: { name: options.schema.name, schema: options.schema.schema, strict: false },
    });
    const parsedFirst = tryParse(first.text);
    if (parsedFirst.ok) {
      const problem = check(parsedFirst.value);
      if (problem === null) {
        return { json: parsedFirst.value, model: first.model, usage: first.usage, attempts: 1, notes, totalMs: Date.now() - startedAt };
      }
      notes.push(`json_schema 形状不符：${problem.slice(0, 200)}`);
    } else {
      notes.push(`json_schema 返回不可解析内容（finish_reason=${first.finishReason}, ${first.text.length} 字）：${parsedFirst.reason}`);
    }

    // Fallback: json_object has no schema field, so the required shape has to be
    // carried in the prompt. Naming the required keys explicitly (not just pasting
    // the schema) measurably reduces shape drift, and a lower temperature does the
    // rest: "missing required property" was the failure mode that survived a
    // schema-only instruction.
    const requiredKeys = Array.isArray(options.schema.schema.required) ? (options.schema.schema.required as string[]) : [];
    const second = await this.chat({
      ...options,
      jsonSchema: undefined,
      jsonObject: true,
      temperature: Math.min(options.temperature ?? 0.8, 0.2),
      messages: [
        ...options.messages,
        {
          role: 'system',
          content:
            '只输出一个 JSON 对象，不要输出解释、Markdown 代码块或填充字符。' +
            (requiredKeys.length > 0 ? `必须包含且只包含这些键：${requiredKeys.join('、')}。` : '') +
            '键名与类型必须严格符合下面的 JSON Schema：\n' +
            JSON.stringify(options.schema.schema),
        },
      ],
    });
    const parsedSecond = tryParse(second.text);
    if (parsedSecond.ok) {
      const problem = check(parsedSecond.value);
      if (problem === null) {
        notes.push('已回退到 json_object（提示词内带 schema）并成功');
        return {
          json: parsedSecond.value,
          model: second.model,
          usage: second.usage,
          attempts: 2,
          notes,
          totalMs: Date.now() - startedAt,
        };
      }
      notes.push(`json_object 回退形状不符：${problem.slice(0, 200)}`);
    } else {
      notes.push(`json_object 回退不可解析：${parsedSecond.reason}`);
    }

    throw new ModelError('INVALID_RESPONSE', 'structured output was unusable after a retry', {
      detail: notes.join(' | ').slice(0, 600),
    });
  }

  #body(options: MimoChatOptions, stream: boolean): Record<string, unknown> {
    const thinking = options.thinking ?? false;
    return {
      model: options.model ?? this.defaultModel,
      messages: options.messages,
      max_completion_tokens: options.maxCompletionTokens ?? 400,
      stream,
      temperature: options.temperature ?? 0.8,
      thinking: thinking ? { type: 'enabled' } : { type: 'disabled' },
      ...(thinking ? { reasoning_effort: 'high' } : {}),
      ...(options.jsonSchema === undefined
        ? options.jsonObject === true
          ? { response_format: { type: 'json_object' } }
          : {}
        : {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: options.jsonSchema.name,
                // DEFAULT FALSE ON PURPOSE. Measured 2026-09-30: with `strict: true`
                // MiMo *intermittently* emits the first key and then pads with
                // whitespace until it hits max_completion_tokens (finish_reason
                // "length"), returning truncated JSON. `strict: false` was clean on
                // every attempt. An intermittent failure is worse than a reliable
                // one, so `verify:structured-output` keeps a canary for it. `strict`
                // is not enforced either way, so every structured result must be
                // validated locally (§52, §53).
                strict: options.jsonSchema.strict ?? false,
                schema: options.jsonSchema.schema,
              },
            },
          }),
      ...(options.tools === undefined
        ? {}
        : {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
            tool_choice: 'auto',
          }),
    };
  }
}

function toUsage(payload: RawResponse): MimoUsage {
  const usage = payload.usage ?? {};
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function emptyUsage(): MimoUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
}

/** Parse a model's JSON reply, treating whitespace padding as the defect it is. */
export function tryParse(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: '空回复' };
  if (/\s{200,}/.test(text)) return { ok: false, reason: '出现大段空白填充，说明模型耗尽 token 后仍在补白' };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
