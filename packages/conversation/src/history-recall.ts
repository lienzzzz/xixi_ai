import { bestBigramCoverage, lexicalRelevance } from '@xixi/context';
import type { TurnRecord } from '@xixi/domain';

export function historyRecallEnabled(raw: unknown): boolean {
  if (raw === undefined) return true;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('INVALID_HISTORY_RECALL');
  const enabled = (raw as Record<string, unknown>)['enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('INVALID_HISTORY_RECALL');
  return enabled ?? true;
}

/** Historical quotes are data, never inferred facts or renewed permissions. */
export function recallHistory(query: string, candidates: readonly TurnRecord[], excluded: ReadonlySet<string>, presentTexts: readonly string[] = []): string[] {
  const ranked = candidates.filter((t) => t.role === 'user' && t.text !== null && !excluded.has(t.eventId))
    .map((turn, index) => ({ turn, index, score: bestBigramCoverage(query, turn.text!) + lexicalRelevance(query, turn.text!) }))
    .filter(({ turn }) => bestBigramCoverage(query, turn.text!) >= 0.34 && lexicalRelevance(query, turn.text!) >= 0.25)
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const lines: string[] = [];
  const seen = new Set([query, ...presentTexts, ...candidates.filter((t) => excluded.has(t.eventId)).map((t) => t.text ?? '')]);
  let bytes = 0;
  for (const { turn } of ranked) {
    if (seen.has(turn.text!)) continue;
    const line = JSON.stringify({ at: turn.createdAt, quote: turn.text });
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > 2048) continue;
    lines.push(line); seen.add(turn.text!); bytes += size;
    if (lines.length === 2) break;
  }
  return lines;
}
