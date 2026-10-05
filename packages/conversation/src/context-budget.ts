import { createHash } from 'node:crypto';
import type { AssembleInput, AssembledPrompt } from './prompt.ts';

export interface ContextBudgetSettings { readonly maxPromptBytes: number; readonly maxHistoryBytes: number; readonly maxRoundBytes?: number; }
export interface PromptBudgetReport {
  readonly schemaVersion: 1; readonly maxPromptBytes: number; readonly textBytes: number;
  readonly historyBytes: number; readonly droppedHistory: number; readonly droppedContextLines: number;
  readonly prefixHash: string;
}
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetSettings = Object.freeze({ maxPromptBytes: 32768, maxHistoryBytes: 8192, maxRoundBytes: 65536 });
export class ContextBudgetExceeded extends Error {
  readonly code = 'CONTEXT_BUDGET_EXCEEDED';
  constructor() { super('CONTEXT_BUDGET_EXCEEDED'); }
}

/** Byte limits deliberately do not claim to count model tokens or tool payloads. */
export function resolveContextBudget(raw?: Record<string, unknown>): ContextBudgetSettings {
  const value = (name: string, fallback: number, min: number, max: number) => {
    const configured = raw?.[name];
    if (configured === undefined) return fallback;
    if (typeof configured !== 'number' || !Number.isSafeInteger(configured) || configured < min || configured > max) throw new Error('INVALID_CONTEXT_BUDGET');
    return configured;
  };
  return { maxPromptBytes: value('max_prompt_bytes', 32768, 8192, 131072), maxHistoryBytes: value('max_history_bytes', 8192, 0, 65536),
    maxRoundBytes: value('max_round_bytes', 65536, 8192, 1048576) };
}
type Rendered = Omit<AssembledPrompt, 'budget'>;
export function promptTextBytes(prompt: Pick<AssembledPrompt, 'system' | 'history' | 'user'>): number {
  return Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(prompt.user, 'utf8') + historyBytes(prompt.history);
}
function historyBytes(history: readonly { readonly content: string }[]): number {
  return history.reduce((n, turn) => n + Buffer.byteLength(turn.content, 'utf8'), 0);
}

/** Keep a contiguous history suffix and whole context rows; never trim mandatory text. */
export function assembleWithinBudget(input: AssembleInput, render: (value: AssembleInput) => Rendered): AssembledPrompt {
  const settings = input.budget === undefined ? DEFAULT_CONTEXT_BUDGET : resolveContextBudget({
    max_prompt_bytes: input.budget.maxPromptBytes, max_history_bytes: input.budget.maxHistoryBytes,
  });
  const mandatory = render({ ...input, history: [], memories: undefined, relationship: undefined, openThreads: undefined, recalledHistory: undefined });
  if (promptTextBytes(mandatory) > settings.maxPromptBytes) throw new ContextBudgetExceeded();
  let selected = { ...input, history: [...input.history] };
  let prompt = render(selected);
  let droppedHistory = 0;
  let droppedContextLines = 0;
  while (selected.history.length > 0 && (historyBytes(prompt.history) > settings.maxHistoryBytes || promptTextBytes(prompt) > settings.maxPromptBytes)) {
    selected.history.shift(); droppedHistory++; prompt = render(selected);
  }
  for (const field of ['recalledHistory', 'relationship', 'openThreads', 'memories'] as const) {
    while (promptTextBytes(prompt) > settings.maxPromptBytes && (selected[field]?.lines.length ?? 0) > 0) {
      const section = selected[field]!;
      const lines = section.lines.slice(0, -1);
      selected = { ...selected, [field]: { ...section, lines } };
      droppedContextLines++; prompt = render(selected);
    }
  }
  if (promptTextBytes(prompt) > settings.maxPromptBytes) throw new ContextBudgetExceeded();
  return { ...prompt, budget: { schemaVersion: 1, maxPromptBytes: settings.maxPromptBytes, textBytes: promptTextBytes(prompt),
    historyBytes: historyBytes(prompt.history), droppedHistory, droppedContextLines,
    prefixHash: createHash('sha256').update(prompt.system).digest('hex') } };
}
