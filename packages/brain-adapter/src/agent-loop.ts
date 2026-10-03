/**
 * Agent runtime, model side (pack Phase 2): the tool loop.
 *
 * ```text
 * messages ──▶ model round ──▶ tool_calls? ──▶ execute ──▶ append tool result ──▶ next round
 *                                   │
 *                                   └─ no tool calls ──▶ spoken text + outcome
 * ```
 *
 * The loop owns the round budget and the tool execution; the *step* owns one model
 * call. That split is what lets the streaming path (`MimoBrainAdapter`) and the
 * scripted/offline path (`FakeBrainAdapter`) share exactly one loop — the voice and
 * text entries therefore behave the same here, and a test can drive the real loop
 * without a network.
 *
 * Everything the model may not decide lives on this side: which tools a round is
 * offered (`registry.definitionsForRound`, capped at `MAX_TOOL_ROUNDS`) and whether a
 * requested call may run (`registry.execute`).
 */
import type { MimoMessage, MimoToolDefinition } from '@xixi/model-adapters';

import type { ToolRegistry } from './tool-registry.ts';
import type { AgentScope } from './tools.ts';
import type { BrainTurnChunk } from './types.ts';

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON string exactly as the provider returned it. */
  readonly arguments: string;
}

export interface AgentStepOutcome {
  /** Which model actually answered this round. */
  readonly model: string;
  readonly finishReason: string | null;
  /**
   * The round's raw text. It goes back to the model as the assistant message of a
   * tool-calling round, so it must not be pre-filtered here.
   */
  readonly rawText: string;
  /** The part of the round the caller may speak (already hygiene-filtered by the step). */
  readonly spokenText: string;
  readonly toolCalls: readonly AgentToolCall[];
}

/**
 * One model call. Yields the text it wants spoken as it arrives (so TTS can start
 * early, §46.1) and settles with the round outcome. May throw: the loop does not
 * swallow provider failures.
 */
export interface AgentStep {
  call(messages: readonly MimoMessage[], tools: readonly MimoToolDefinition[] | undefined, round: number): AsyncGenerator<BrainTurnChunk, AgentStepOutcome, void>;
}

export interface AgentLoopResult {
  /** Last non-empty spoken text of the turn (`''` when nothing was said). */
  readonly text: string;
  readonly model: string;
  readonly finishReason: string | null;
  /** Every tool that actually ran, in order. */
  readonly usedTools: readonly string[];
  /** Model rounds consumed (1 means the model answered without tools). */
  readonly rounds: number;
  readonly messages: readonly MimoMessage[];
}

export interface AgentLoopOptions {
  readonly registry: ToolRegistry;
  readonly scope: AgentScope;
  /**
   * Program truth handed to every tool: the timezone and **the clock a call is stamped with**.
   *
   * Pack v03-preflight ⑨: this used to be `now: Date`, one reading taken when the turn began, and
   * every tool in the loop received that same snapshot — so a call that ran half a minute later
   * (a long round, a chain of four tool calls) still saw the turn's start. Tools are stamped with
   * `context.clock()`, read **at the moment the call runs**; the name says what it does, so nobody
   * can mistake it for a turn-start snapshot again.
   *
   * The clock is injectable for the same reason the adapters have one: an offline test with a fixed
   * clock must stay reproducible.
   */
  readonly context: { readonly timezone: string; readonly clock: () => Date };
}

/**
 * Drive `step` until the model answers without asking for a tool, or until the
 * registry's round cap is reached (it then stops offering tools, which is what ends
 * the loop — never the model's own promise to stop).
 */
export async function* runAgentLoop(
  step: AgentStep,
  initial: readonly MimoMessage[],
  options: AgentLoopOptions,
): AsyncGenerator<BrainTurnChunk, AgentLoopResult, void> {
  const messages: MimoMessage[] = [...initial];
  const usedTools: string[] = [];
  let text = '';
  let model = '';
  let finishReason: string | null = null;
  let rounds = 0;

  for (let round = 1; ; round += 1) {
    const tools = options.registry.definitionsForRound(options.scope, round);
    const iterator = step.call(messages, tools, round);
    let outcome: AgentStepOutcome;
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        outcome = next.value;
        break;
      }
      yield next.value;
    }
    rounds = round;
    model = outcome.model;
    finishReason = outcome.finishReason;
    if (outcome.spokenText.trim().length > 0) text = outcome.spokenText;

    // Text is not proof the turn is answered: a provider can return a spoken
    // preamble *together with* tool_calls (measured, see scripts/probe-tools.ts).
    if (tools === undefined || outcome.toolCalls.length === 0) break;

    messages.push({
      role: 'assistant',
      content: outcome.rawText,
      tool_calls: outcome.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    });
    for (const call of outcome.toolCalls) {
      const execution = await options.registry.execute(call, {
        scope: options.scope,
        timezone: options.context.timezone,
        // Read per call, after the model round that asked for it: 「现在几点」 must be the moment
        // the tool runs, not the moment the turn started (preflight ⑨).
        now: options.context.clock(),
      });
      usedTools.push(execution.record.name);
      yield { type: 'tool', name: execution.record.name };
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(execution.payload) });
    }
  }

  return { text, model, finishReason, usedTools, rounds, messages };
}
