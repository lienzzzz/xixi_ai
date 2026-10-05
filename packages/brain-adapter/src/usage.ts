export interface BrainRoundUsage {
  readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number;
  readonly cachedTokens: number; readonly reasoningTokens: number;
  readonly reported: boolean; readonly cacheReported: boolean; readonly reasoningReported: boolean;
}
export interface BrainUsage {
  readonly schemaVersion: 1; readonly status: 'complete' | 'partial' | 'unavailable';
  readonly modelRounds: number; readonly reportedRounds: number; readonly cacheReportedRounds: number; readonly reasoningReportedRounds: number;
  readonly promptTokens: number | null; readonly completionTokens: number | null; readonly totalTokens: number | null;
  readonly cachedTokens: number | null; readonly reasoningTokens: number | null;
}
export function aggregateUsage(rounds: number, samples: readonly BrainRoundUsage[]): BrainUsage {
  const known = samples.filter((s) => s.reported);
  const cached = known.filter((s) => s.cacheReported);
  const reasoning = known.filter((s) => s.reasoningReported);
  const sum = (entries: readonly BrainRoundUsage[], key: 'promptTokens' | 'completionTokens' | 'totalTokens' | 'cachedTokens' | 'reasoningTokens') =>
    entries.length === 0 ? null : entries.reduce((n, s) => n + s[key], 0);
  return { schemaVersion: 1, status: known.length === 0 ? 'unavailable' : known.length === rounds ? 'complete' : 'partial',
    modelRounds: rounds, reportedRounds: known.length, cacheReportedRounds: cached.length, reasoningReportedRounds: reasoning.length,
    promptTokens: sum(known, 'promptTokens'), completionTokens: sum(known, 'completionTokens'), totalTokens: sum(known, 'totalTokens'),
    cachedTokens: sum(cached, 'cachedTokens'), reasoningTokens: sum(reasoning, 'reasoningTokens') };
}
