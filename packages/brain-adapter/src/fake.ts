import type { MimoMessage } from '@xixi/model-adapters';
import type { TurnAction } from '@xixi/domain';

import { runAgentLoop, type AgentLoopResult, type AgentStep, type AgentStepOutcome } from './agent-loop.ts';
import type { ToolRegistry } from './tool-registry.ts';
import type { AgentScope } from './tools.ts';
import {
  createBrainTurnStream,
  splitIntoChunks,
  type BrainDescription,
  type BrainTurnChunk,
  type BrainTurnResult,
  type BrainTurnStream,
  type TurnModelProvider,
  type UserTurnInput,
} from './types.ts';

export interface ScriptedOutcome {
  readonly action: TurnAction;
  readonly text: string | null;
  readonly toolName?: string | null;
}

/** One lookup the scripted stand-in decides to make. */
export interface ScriptedToolRequest {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

/**
 * What the scripted stand-in asks for on a given round, from the user's own words.
 * Returning an empty list means "answer now"; a plan that keeps returning requests is
 * how a test exercises the round cap.
 */
export type ScriptedToolPlan = (input: UserTurnInput, round: number) => readonly ScriptedToolRequest[];

const WEATHER_WORDS = /天气|下雨|气温|冷不冷|热不热|要不要带伞/;
const NEWS_WORDS = /新闻|头条|有什么消息/;
const REMINDER_WORDS = /提醒我|提醒一下|别忘了|记一下/;
const CLOCK_WORDS = /几点|几号|星期几|现在的时间|现在时间/;

/**
 * The default plan: one lookup, decided by keywords, on the first round only.
 *
 * Deliberately dumb and deterministic — it is a stand-in for a model, used by the
 * offline pages and by offline tests, so the *tool chain* is what gets exercised.
 */
export function scriptedToolPlan(input: UserTurnInput, round: number): readonly ScriptedToolRequest[] {
  if (round !== 1) return [];
  const text = input.text;
  if (REMINDER_WORDS.test(text)) {
    const what = text.replace(/^(西西[，,]?)?(帮我)?(提醒我|提醒一下|别忘了|记一下)/, '').trim();
    return [{ name: 'xixi_set_reminder_stub', arguments: { what: what.length > 0 ? what : text } }];
  }
  if (WEATHER_WORDS.test(text)) return [{ name: 'xixi_get_weather' }];
  if (NEWS_WORDS.test(text)) return [{ name: 'news.latest' }];
  if (CLOCK_WORDS.test(text)) return [{ name: 'xixi_get_current_time' }];
  return [];
}

export interface FakeBrainOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly chunkSize?: number;
  /** Deterministic default: `/tool …` exercises the tool path, blank input is silence. */
  readonly reply?: (input: UserTurnInput) => ScriptedOutcome;
  /**
   * The shared tool chain. When present this stand-in runs the *real* loop
   * (`runAgentLoop` + `ToolRegistry`), which is what lets an offline test prove that
   * voice and text reach the same tools. Without it the adapter is the old
   * script-only stand-in, unchanged.
   */
  readonly registry?: ToolRegistry;
  readonly scope?: AgentScope;
  /** Defaults to `scriptedToolPlan` once a registry is present. */
  readonly toolPlan?: ScriptedToolPlan;
  readonly timezone?: string;
  readonly now?: () => Date;
}

const DEFAULT_REPLY = (input: UserTurnInput): ScriptedOutcome => {
  const text = input.text.trim();
  if (text.length === 0) return { action: 'SILENCE', text: null };
  if (text.startsWith('/tool')) {
    return { action: 'TOOL', text: '工具结果：时间已读取。', toolName: 'xixi_get_current_time' };
  }
  return { action: 'SPEAK', text: `模拟回复：${text}` };
};

/** `tool` messages carry their payload as JSON; a broken one is not worth throwing over. */
function toolResults(messages: readonly MimoMessage[]): { readonly name: string; readonly payload: Record<string, unknown> }[] {
  // Only the most recent tool round: an earlier round's payload is stale context for the
  // model, and re-saying it would repeat a refusal or a forecast once per round.
  let calls: NonNullable<MimoMessage['tool_calls']> = [];
  const results: { name: string; payload: Record<string, unknown> }[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      calls = message.tool_calls;
      results.length = 0;
      continue;
    }
    if (message.role !== 'tool') continue;
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(message.content);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const call = calls.find((candidate) => candidate.id === message.tool_call_id);
    results.push({ name: call?.function.name ?? '', payload });
  }
  return results;
}

function textField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const CANNOT_LOOK_IT_UP = '这件事我现在查不到，晚点再说吧。';

/**
 * Say a tool result in a person's words.
 *
 * This is the part of the stand-in that matters for acceptance: the reply is built
 * from the *result fields*, never from the payload itself, so nothing internal
 * (`xixi_*`, JSON, argument names) can end up in something a person hears.
 */
export function sayToolResult(name: string, payload: Record<string, unknown>): string {
  // pack §5 的中间一步：这次调用**没有跑**，它在等人点头。离线替身也要「自然地问一句」，
  // 而不是说「查不到」—— 否则「审批流程真的走通了」在离线门禁里就看不出来。
  if (payload.requiresApproval === true) return '这件事我得先问一句：要我帮你做吗？';
  if (typeof payload.error === 'string') return CANNOT_LOOK_IT_UP;
  switch (name) {
    case 'xixi_get_weather': {
      const summary = textField(payload, 'summary');
      if (summary === null) return CANNOT_LOOK_IT_UP;
      const day = textField(payload, 'day') ?? '明天';
      // The geocoder returns "成都 四川省"; a person says just "成都".
      const place = textField(payload, 'place')?.split(/\s+/)[0] ?? null;
      const low = numberField(payload, 'temperatureMinC');
      const high = numberField(payload, 'temperatureMaxC');
      const range = low === null || high === null ? '' : `，${low} 到 ${high} 度`;
      const advice = textField(payload, 'advice');
      return `${day}${place === null ? '' : place}${summary}${range}。${advice === null ? '' : `${advice}。`}`;
    }
    case 'xixi_get_current_time': {
      const date = textField(payload, 'localDate');
      if (date === null) return CANNOT_LOOK_IT_UP;
      const weekday = textField(payload, 'weekday');
      const time = textField(payload, 'localTime');
      const when = [date, weekday].filter((part): part is string => part !== null).join(' ');
      return time === null ? `今天是 ${when}。` : `今天是 ${when}，现在 ${time}。`;
    }
    // 新闻现在由插件提供（pack §6）：名字是 `news.*` 那一族。没有挂插件时注册表会拒绝这次
    // 调用，于是这里走的是上面 `payload.error` 那条分支——离线替身不会替不存在的工具说话。
    case 'news.latest':
    case 'news.search':
    case 'news.for_interests': {
      const items = Array.isArray(payload.items) ? (payload.items as { title?: unknown }[]) : [];
      const titles = items.map((item) => (typeof item.title === 'string' ? item.title : '')).filter((title) => title.length > 0).slice(0, 3);
      if (titles.length > 0) return `刚看到几条：${titles.join('；')}。`;
      const problems = Array.isArray(payload.problems) ? payload.problems.filter((entry) => typeof entry === 'string') : [];
      return problems.length > 0 ? '新闻源现在取不到，晚点再看看。' : '新闻那边现在没有新消息。';
    }
    case 'xixi_set_reminder_stub': {
      const what = textField(payload, 'what');
      if (what === null) return '这件事我还没记清楚，你再说一遍好吗？';
      const when = textField(payload, 'when') ?? '尽快';
      return `好，我记着了：${what}，${when}。`;
    }
    default:
      return CANNOT_LOOK_IT_UP;
  }
}

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
export class FakeBrainAdapter implements TurnModelProvider {
  readonly provider: string;
  readonly #model: string;
  readonly #chunkSize: number;
  readonly #reply: (input: UserTurnInput) => ScriptedOutcome;
  readonly #registry: ToolRegistry | undefined;
  readonly #scope: AgentScope;
  readonly #toolPlan: ScriptedToolPlan;
  readonly #timezone: string;
  readonly #now: () => Date;

  constructor(options: FakeBrainOptions = {}) {
    this.provider = options.provider ?? 'fake';
    this.#model = options.model ?? 'fake-1';
    this.#chunkSize = options.chunkSize ?? 12;
    this.#reply = options.reply ?? DEFAULT_REPLY;
    this.#registry = options.registry;
    this.#scope = options.scope ?? 'conversation';
    this.#toolPlan = options.toolPlan ?? scriptedToolPlan;
    this.#timezone = options.timezone ?? 'Asia/Shanghai';
    this.#now = options.now ?? (() => new Date());
  }

  describe(): BrainDescription {
    return { provider: this.provider, model: this.#model, transport: 'in-memory', mode: 'scripted' };
  }

  async handleUserTurn(input: UserTurnInput): Promise<BrainTurnStream> {
    const registry = this.#registry;
    if (registry === undefined) return this.#scriptedTurn(input);
    return this.#toolTurn(input, registry);
  }

  /** The pre-Phase-2 behaviour, byte for byte: no registry, no loop, no tools. */
  #scriptedTurn(input: UserTurnInput): BrainTurnStream {
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
      /** A scripted turn never hits a token budget — `stop` is the honest value (t21). */
      finishReason: 'stop',
    };

    async function* replay(): AsyncGenerator<BrainTurnChunk> {
      for (const chunk of chunks) yield chunk;
    }
    return createBrainTurnStream(replay(), Promise.resolve(result));
  }

  /** The Phase 2 path: the same loop and registry the real adapter uses. */
  #toolTurn(input: UserTurnInput, registry: ToolRegistry): BrainTurnStream {
    const adapter = this;
    const messages: MimoMessage[] = [{ role: 'user', content: input.text }];

    async function* run(): AsyncGenerator<BrainTurnChunk, BrainTurnResult, void> {
      const step: AgentStep = {
        async *call(roundMessages, tools, round): AsyncGenerator<BrainTurnChunk, AgentStepOutcome, void> {
          const outcome = adapter.#reply(input);
          const planned = tools === undefined ? [] : adapter.#toolPlan(input, round);
          const requests =
            planned.length > 0
              ? planned
              : round === 1 && outcome.toolName !== undefined && outcome.toolName !== null
                ? [{ name: outcome.toolName, arguments: {} }]
                : [];
          if (requests.length > 0) {
            return {
              model: adapter.#model,
              finishReason: 'tool_calls',
              rawText: '',
              spokenText: '',
              toolCalls: requests.map((request, index) => ({
                id: `call_${index + 1}`,
                name: request.name,
                arguments: JSON.stringify(request.arguments ?? {}),
              })),
            };
          }
          const seen = toolResults(roundMessages);
          const text = seen.length > 0 ? seen.map((entry) => sayToolResult(entry.name, entry.payload)).join('') : outcome.text;
          if (text !== null) for (const chunk of splitIntoChunks(text, adapter.#chunkSize)) yield chunk;
          return { model: adapter.#model, finishReason: 'stop', rawText: text ?? '', spokenText: text ?? '', toolCalls: [] };
        },
      };

      const iterator = runAgentLoop(step, messages, {
        registry,
        scope: adapter.#scope,
        context: {
          timezone: adapter.#timezone,
          clock: adapter.#now,
          // P2-B: the turn's identity reaches the tool execution context (approval needs it).
          sessionId: input.sessionId,
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
          ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
        },
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

      const spoken = outcome.text.trim().length > 0 ? outcome.text : null;
      return {
        action: spoken === null ? 'SILENCE' : 'SPEAK',
        text: spoken,
        toolName: outcome.usedTools.at(-1) ?? null,
        provider: adapter.provider,
        model: adapter.#model,
        brainSessionId: `fake-${input.sessionId}`,
        latencyMs: 0,
        finishReason: 'stop',
      };
    }

    // `result` must be the generator's return value, so drive it by hand.
    let settle: { resolve: (result: BrainTurnResult) => void; reject: (cause: unknown) => void } | null = null;
    const result = new Promise<BrainTurnResult>((resolve, reject) => {
      settle = { resolve, reject };
    });
    result.catch(() => {});
    const iterator = run();

    async function* pump(): AsyncGenerator<BrainTurnChunk> {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) {
            settle?.resolve(next.value);
            return;
          }
          yield next.value;
        }
      } catch (cause) {
        settle?.reject(cause);
        throw cause;
      }
    }

    return createBrainTurnStream(pump(), result);
  }
}
