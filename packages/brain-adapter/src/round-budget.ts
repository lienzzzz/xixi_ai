import type { MimoMessage, MimoToolDefinition } from '@xixi/model-adapters';
import { BrainError } from './errors.ts';

export const DEFAULT_MAX_ROUND_BYTES = 65536;
export class RoundContextBudgetExceeded extends BrainError {
  readonly reasonCode = 'ROUND_CONTEXT_BUDGET_EXCEEDED';
  constructor() { super('BAD_REQUEST', 'ROUND_CONTEXT_BUDGET_EXCEEDED'); }
}
export function resolveRoundBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ROUND_BYTES;
  if (!Number.isSafeInteger(value) || value < 8192 || value > 1048576) throw new BrainError('BAD_REQUEST', 'INVALID_ROUND_CONTEXT_BUDGET');
  return value;
}
/** Measure adapter data, including JSON escaping and images; not full HTTP or tokens. */
export function assertRoundBudget(messages: readonly MimoMessage[], tools: readonly MimoToolDefinition[] | undefined, maxBytes: number): void {
  if (Buffer.byteLength(JSON.stringify({ messages, ...(tools === undefined ? {} : { tools }) }), 'utf8') > maxBytes) throw new RoundContextBudgetExceeded();
}
/** Preserve arrays while removing object insertion order from model tool definitions. */
export function canonicalSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalSchema((value as Record<string, unknown>)[key])]));
  return value;
}
