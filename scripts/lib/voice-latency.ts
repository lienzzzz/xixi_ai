/**
 * The first-audio comparison, as a **pure** module (t9; moved to `scripts/lib/` in t16).
 *
 * Why this file exists at all (the gap two reviews in a row pointed at):
 *   * t5: the 「整段合成」 column of the latency table had no raw n=12 artefact on disk, so nobody
 *     could recompute it — only the streaming column had one;
 *   * t12: the same-batch deltas were reported from **one** batch, while three independent batches
 *     disagree in sign and size (one run had streaming 16 % *worse*, two were a few percent better).
 *     A single batch's percentage is therefore not a finding.
 *
 * The module turns a run's own evidence file into the four baseline delays for every turn, pairs the
 * streaming turn with the whole-reply measurement taken **in the same run on the same reply text**,
 * and reports the per-turn table plus percentiles. It is pure: `scripts/voice-turn.ts` uses it for
 * its `--compare` mode (and writes the artefacts `--out`), and
 * `tests/unit/voice/voice-latency.test.ts` drives the same functions with synthetic evidence, so the
 * CLI cannot drift away from what the tests pin.
 *
 * It lives in `scripts/lib/` because it is *not* a test: the production CLI imports it. Before t16
 * it sat in `tests/unit/voice/`, which meant production code imported from a test directory — the
 * kind of shortcut that makes 「只跑测试就能改行为」 possible.
 *
 * ## The 1.5 s target belongs to ④, not to ③
 *
 * pack Phase 8's acceptance is 「普通闲聊 P50 first audible < 1.5s」 — 「说完一句到听见第一个字」.
 * In the four-stage vocabulary of `docs/benchmarks/v01-baseline.md` §3.1 the only delay with that
 * meaning is **④ 「首段可听总延迟」** = endpoint hold + ① + ② + ③. ③ is 「first token → first audible
 * piece」 and is an **attribution** quantity: it says how much of ④ belongs to synthesis, and it is
 * *not* comparable across the two paths (one side is the first *clause*, the other the whole reply).
 * Mixing them is exactly how 「超出 15%」 (a ③ statement) and 「目标的 3.5 倍」 (a ④ statement) ended up
 * in the same document. The 口径 is restated in the design doc's streaming section
 * (`docs/design/voice.md` §7) and in `docs/recon/voice-streaming-2026-10-01.md`.
 *
 * ④ is bounded from below by two things this project does not control: ② (the model's first token;
 * measured P50 ≈ 1.7–2.0 s in these runs, already above 1.5 s on its own) and ③'s floor (MiMo TTS
 * round trip: 2 chars 0.58–1.05 s, 13 chars 0.97–1.19 s, 30 chars 1.61–2.02 s). So a run whose ④ is
 * below 1.5 s cannot be produced by changing the chunking alone.
 */

/** One turn as `scripts/voice-turn.ts` writes it into its evidence file. */
export interface VoiceTurnEvidence {
  readonly wav?: string;
  readonly speech?: { readonly endpointDelayMs?: number | null } | null;
  readonly reply?: string | null;
  readonly action?: string;
  readonly clauses?: readonly { readonly index: number; readonly chars: number }[] | null;
  /** ③ of the V0.1 whole-reply path, measured in the same run (`--legacy-tts`). */
  readonly legacyTtsMs?: number | null;
  readonly fourStage?: {
    readonly vadEndToAsrFinalMs?: number | null;
    readonly asrFinalToFirstTokenMs?: number | null;
    readonly firstTokenToFirstAudioMs?: number | null;
    readonly totalToFirstAudioMs?: number | null;
  };
}

/** One evidence file: the header the script prints plus its turns. */
export interface VoiceBatchEvidence {
  /** Where it came from, for the report (a path or a label). */
  readonly source: string;
  readonly command?: string;
  readonly turns: readonly VoiceTurnEvidence[];
}

/** The four delays for one turn, in both paths. `null` = not measured (never 0). */
export interface PairedTurn {
  readonly index: number;
  readonly wav: string;
  readonly action: string;
  readonly replyChars: number;
  readonly clauses: number;
  /** ① VAD end → ASR final; identical in both paths (one recording, one recognition). */
  readonly asrMs: number | null;
  /** ② ASR final → first token; identical in both paths (one model stream). */
  readonly ttftMs: number | null;
  /** ③ streaming: first token → first audible **clause**. */
  readonly stream3Ms: number | null;
  /** ③ whole-reply: first token → the **whole reply's** audio (the V0.1 way). */
  readonly legacy3Ms: number | null;
  /** ④ streaming: endpoint hold + ① + ② + ③, as the script reports it. */
  readonly stream4Ms: number | null;
  /** ④ whole-reply, computed with the same formula and the same batch's ①②. */
  readonly legacy4Ms: number | null;
  /** `stream4 − legacy4`, or `null` when either side is unmeasured. */
  readonly delta4Ms: number | null;
}

export interface LatencyStats {
  readonly n: number;
  readonly p50: number;
  readonly p90: number;
  readonly min: number;
  readonly max: number;
}

/** P50/P90 by linear interpolation — the same rule as `docs/benchmarks/v01-baseline.md`. */
export function latencyStats(values: readonly (number | null | undefined)[]): LatencyStats | null {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const at = (percent: number): number => {
    const rank = (percent / 100) * (numbers.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.min(lower + 1, numbers.length - 1);
    if (lower === upper) return numbers[lower] as number;
    return (numbers[lower] as number) * (1 - (rank - lower)) + (numbers[upper] as number) * (rank - lower);
  };
  return { n: numbers.length, p50: Math.round(at(50)), p90: Math.round(at(90)), min: numbers[0] as number, max: numbers[numbers.length - 1] as number };
}

/**
 * The whole-reply ④, from the **same** batch's ①②: `endpoint + ① + ② + ③(whole reply)`.
 *
 * This is the baseline's own formula (`e2eToFirstReplyAudioMs` in `scripts/voice-turn.ts`), applied
 * to the legacy column instead of the streaming one. Using the same ①② is what makes the pairing
 * meaningful: the recording and the model stream are shared, only the synthesis differs.
 */
export function legacyTotalMs(turn: VoiceTurnEvidence): number | null {
  const endpoint = turn.speech?.endpointDelayMs;
  const asr = turn.fourStage?.vadEndToAsrFinalMs;
  const ttft = turn.fourStage?.asrFinalToFirstTokenMs;
  const legacy = turn.legacyTtsMs;
  if (typeof endpoint !== 'number' || typeof asr !== 'number' || typeof ttft !== 'number' || typeof legacy !== 'number') return null;
  return Math.round(endpoint + asr + ttft + legacy);
}

/** Pair every turn of one batch: streaming ③④ against the whole-reply ③④ of the same run. */
export function pairTurns(evidence: VoiceBatchEvidence): readonly PairedTurn[] {
  return evidence.turns.map((turn, index) => {
    const stream3 = typeof turn.fourStage?.firstTokenToFirstAudioMs === 'number' ? turn.fourStage.firstTokenToFirstAudioMs : null;
    const stream4 = typeof turn.fourStage?.totalToFirstAudioMs === 'number' ? turn.fourStage.totalToFirstAudioMs : null;
    const legacy3 = typeof turn.legacyTtsMs === 'number' ? turn.legacyTtsMs : null;
    const legacy4 = legacyTotalMs(turn);
    return {
      index,
      wav: (turn.wav ?? '?').split(/[\\/]/).pop() ?? '?',
      action: turn.action ?? '?',
      replyChars: typeof turn.reply === 'string' ? turn.reply.length : 0,
      clauses: turn.clauses?.length ?? 0,
      asrMs: typeof turn.fourStage?.vadEndToAsrFinalMs === 'number' ? turn.fourStage.vadEndToAsrFinalMs : null,
      ttftMs: typeof turn.fourStage?.asrFinalToFirstTokenMs === 'number' ? turn.fourStage.asrFinalToFirstTokenMs : null,
      stream3Ms: stream3,
      legacy3Ms: legacy3,
      stream4Ms: stream4,
      legacy4Ms: legacy4,
      delta4Ms: stream4 === null || legacy4 === null ? null : stream4 - legacy4,
    };
  });
}

export interface BatchComparison {
  readonly source: string;
  readonly n: number;
  readonly paired: number;
  readonly rows: readonly PairedTurn[];
  readonly streaming: { readonly asr: LatencyStats | null; readonly ttft: LatencyStats | null; readonly third: LatencyStats | null; readonly fourth: LatencyStats | null };
  readonly legacy: { readonly third: LatencyStats | null; readonly fourth: LatencyStats | null };
  /** Per-turn ④ deltas, and the median of them — never a single turn's number. */
  readonly delta4: LatencyStats | null;
  /** ≥1 means streaming is slower. Reported next to, never inside, the pack comparison. */
  readonly streamOverLegacy: number | null;
  /** ④ P50 over the pack's 1.5 s target — ④, because ④ is what the target names. */
  readonly packRatio: number | null;
  /** ③ P50 over 1.5 s, for context only: ③ is an attribution quantity, not the target. */
  readonly packRatioOfThird: number | null;
}

export const VOICE_PACK_TARGET_MS = 1_500;

export function compareBatch(evidence: VoiceBatchEvidence): BatchComparison {
  const rows = pairTurns(evidence);
  const fourth = latencyStats(rows.map((row) => row.stream4Ms));
  const third = latencyStats(rows.map((row) => row.stream3Ms));
  const legacyFourth = latencyStats(rows.map((row) => row.legacy4Ms));
  return {
    source: evidence.source,
    n: evidence.turns.length,
    paired: rows.filter((row) => row.legacy4Ms !== null).length,
    rows,
    streaming: {
      asr: latencyStats(rows.map((row) => row.asrMs)),
      ttft: latencyStats(rows.map((row) => row.ttftMs)),
      third,
      fourth,
    },
    legacy: {
      third: latencyStats(rows.map((row) => row.legacy3Ms)),
      fourth: legacyFourth,
    },
    delta4: latencyStats(rows.map((row) => row.delta4Ms)),
    // ≥1 means streaming is slower. Reported next to, never inside, the pack comparison.
    streamOverLegacy: fourth === null || legacyFourth === null || legacyFourth.p50 === 0 ? null : Number((fourth.p50 / legacyFourth.p50).toFixed(3)),
    // ④ P50 over the pack's target — ④, because ④ is what the target names.
    packRatio: fourth === null ? null : Number((fourth.p50 / VOICE_PACK_TARGET_MS).toFixed(2)),
    // ③ P50 over the same number, for context only: ③ is an attribution quantity, not the target.
    packRatioOfThird: third === null ? null : Number((third.p50 / VOICE_PACK_TARGET_MS).toFixed(2)),
  };
}

/** A short, unambiguous label for one evidence file (its basename plus the run it came from). */
export function batchLabel(source: string): string {
  const base = source.split(/[\\/]/).pop() ?? source;
  return base.replace(/\.txt$/i, '');
}

function cell(value: number | null): string {
  return value === null ? '—' : String(Math.round(value));
}

function signed(value: number | null): string {
  if (value === null) return '—';
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

/**
 * The per-turn paired table, four stages wide, ready to print.
 *
 * Column meanings are stated in the header lines because this is the artefact a reader uses to check
 * a claim: ① ② are shared by both paths, ③ differs in *meaning* between them, and ④ is the number the
 * pack's 1.5 s refers to.
 */
/** One line of the four-stage summary, or an explicit 「未测」 when a side has no data. */
function statLine(label: string, value: LatencyStats | null): string {
  if (value === null) return `${label}：未测（n=0）`;
  return `${label}：n=${value.n} P50 ${value.p50} P90 ${value.p90} 最小 ${value.min} 最大 ${value.max}`;
}

export interface CrossBatchSummary {
  readonly batches: number;
  readonly pairedBatches: number;
  /** Per batch: the ④ P50 ratio stream/legacy (≥1 means streaming was slower), or `null`. */
  readonly ratios: readonly (number | null)[];
  /** Batches where streaming reached audio **sooner**. */
  readonly better: number;
  /** Batches where streaming was **slower**. */
  readonly worse: number;
  readonly unmoved: number;
  /**
   * Does the claim 「方向多数为正」 survive these batches?
   *
   * 「多数为正」 means more batches than not got a *shorter* ④ with streaming. It is computed, not
   * asserted, because the answer changes with the data: the first three-batch report claimed it, and
   * t12's own numbers (including a run where streaming was 16 % worse) already contradicted it. When
   * this is false the honest sentence is 「方向不一致」, not 「多数为正」.
   */
  readonly mostlyBetter: boolean;
  /** The spread of the per-batch ④ deltas, in percent. Reported as a **range**, never a single value. */
  readonly deltaPercentRange: { readonly min: number; readonly max: number } | null;
}

/**
 * The only conclusion shape this project allows for the same-batch comparison: across independent
 * batches the deltas do not agree in sign or size, so a single percentage is noise (t12). The
 * summary counts the directions, reports the spread as a **range**, and says whether the
 * 「方向多数为正」 claim is even true for the batches it was given.
 */
export function summarizeBatches(comparisons: readonly BatchComparison[]): CrossBatchSummary {
  const ratios = comparisons.map((comparison) => comparison.streamOverLegacy);
  const better = ratios.filter((ratio) => ratio !== null && ratio < 1).length;
  const worse = ratios.filter((ratio) => ratio !== null && ratio > 1).length;
  const usable = comparisons.filter((comparison) => comparison.streaming.fourth !== null && comparison.legacy.fourth !== null);
  const percents = usable.map(
    (comparison) => ((comparison.streaming.fourth?.p50 ?? 0) - (comparison.legacy.fourth?.p50 ?? 0)) / (comparison.legacy.fourth?.p50 ?? 1) * 100,
  );
  return {
    batches: comparisons.length,
    pairedBatches: ratios.filter((ratio) => ratio !== null).length,
    ratios,
    better,
    worse,
    unmoved: ratios.filter((ratio) => ratio === 1).length,
    mostlyBetter: better > worse,
    deltaPercentRange: percents.length === 0 ? null : { min: Number(Math.min(...percents).toFixed(1)), max: Number(Math.max(...percents).toFixed(1)) },
  };
}

export function formatCrossBatch(summary: CrossBatchSummary): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('多批并列（这样写才成立，单批百分比不是结论）：');
  lines.push(
    `  批次 ${summary.batches} 批（其中 ${summary.pairedBatches} 批两列齐全）；④ 流式/整段 P50 比：${summary.ratios.map((ratio) => (ratio === null ? '—' : ratio)).join(' / ')}`,
  );
  lines.push(`  方向：流式更快 ${summary.better} 批、更慢 ${summary.worse} 批、持平 ${summary.unmoved} 批`);
  lines.push(
    summary.mostlyBetter
      ? '  → 方向多数为正（多数批次流式更快），但幅度跨批不可复现'
      : '  → 方向不一致（多数批次并没有更快）：连「方向多数为正」这句都不能写，只能写「方向不一致、幅度不可复现」',
  );
  lines.push(
    `  幅度（④ 相对整段的百分比）：${
      summary.deltaPercentRange === null ? '—' : `约 ${summary.deltaPercentRange.min}% 到 ${summary.deltaPercentRange.max}%`
    } —— 跨批不可复现，所以不给任何单批百分比当结论`,
  );
  lines.push('');
  lines.push(`pack 的 ${VOICE_PACK_TARGET_MS} ms 目标：是 ④（端点后到首段可听），不是 ③；这些批次里没有一批达到。`);
  lines.push('④ 的下界由 ②（模型首 token，P50 约 1.7–2.0 s）与 MiMo TTS 单次往返（1.0–1.3 s）先卡住。');
  return lines.join('\n');
}

export function formatComparison(comparisons: readonly BatchComparison[]): string {
  const lines: string[] = [];
  lines.push('口径（与 docs/benchmarks/v01-baseline.md §3.1 逐字对应）：');
  lines.push('  ① VAD end → ASR final    ② ASR final → 首 token    （这两条两条链路共用：同一段录音、同一次模型流）');
  lines.push('  ③ 首 token → 首段可听    ④ 端点保持 + ① + ② + ③');
  lines.push(`  pack Phase 8 的 ${VOICE_PACK_TARGET_MS} ms 目标指的是 ③ 还是 ④：是 ④「端点后到首段可听」，不是 ③。`);
  lines.push('  ③ 只是归因量（流式那边是「第一块」，旧链路那边是「整段回复」，两者不是同一个物理量，不能直接比）。');
  lines.push('');
  for (const comparison of comparisons) {
    lines.push(`${batchLabel(comparison.source)}  n=${comparison.n}  配对=${comparison.paired}`);
    lines.push('  #  夹具                 块  字数   ①asr   ②ttft   ③流式   ③整段   ④流式   ④整段      Δ④');
    comparison.rows.forEach((row, position) => {
      lines.push(
        `  ${String(position + 1).padStart(2, ' ')} ${row.wav.padEnd(20, ' ')} ${String(row.clauses).padStart(2, ' ')} ${String(row.replyChars).padStart(4, ' ')} ` +
          `${cell(row.asrMs).padStart(7, ' ')} ${cell(row.ttftMs).padStart(7, ' ')} ${cell(row.stream3Ms).padStart(7, ' ')} ${cell(row.legacy3Ms).padStart(7, ' ')} ` +
          `${cell(row.stream4Ms).padStart(7, ' ')} ${cell(row.legacy4Ms).padStart(7, ' ')} ${signed(row.delta4Ms).padStart(8, ' ')}`,
      );
    });
    lines.push(`  ${statLine('④流式', comparison.streaming.fourth)}`);
    lines.push(`  ${statLine('④整段', comparison.legacy.fourth)}`);
    lines.push(`  ${statLine('Δ④  ', comparison.delta4)}   ④ 流式/整段 P50 比 = ${comparison.streamOverLegacy === null ? '—' : comparison.streamOverLegacy}`);
    lines.push(`  ${statLine('①    ', comparison.streaming.asr)}`);
    lines.push(`  ${statLine('②    ', comparison.streaming.ttft)}`);
    lines.push(`  ${statLine('③流式', comparison.streaming.third)}`);
    lines.push(`  ${statLine('③整段', comparison.legacy.third)}`);
    lines.push(
      `  pack 比值：④ P50 / ${VOICE_PACK_TARGET_MS} = ${comparison.packRatio === null ? '—' : `${comparison.packRatio} 倍`}` +
        `；③ P50 / ${VOICE_PACK_TARGET_MS} = ${comparison.packRatioOfThird === null ? '—' : `${comparison.packRatioOfThird} 倍`}（③ 的比值不是目标口径，列在这里只为说明两者别混用）`,
    );
    lines.push('');
  }
  lines.push('结论写法（t12 的要求）：多批并列时只能写方向统计与幅度区间，不给任何单批百分比当结论；');
  lines.push('「方向多数为正」只有在多数批次真的更快时才成立 —— 不成立就写「方向不一致」，见下面这段的计算结果。');
  lines.push(`④ 的下界不在这条链路里：② 首 token（这几批 P50 约 1.7–2.0 s，单独就已超过 ${VOICE_PACK_TARGET_MS} ms）与 ③ 的地板（MiMo TTS 单次往返 1.0–1.3 s）先卡住；`);
  lines.push('要把 ④ 压到 1.5 s 以内，必须同时换更快的合成与更快的首 token，调切块参数做不到。');
  if (comparisons.length > 1) lines.push(formatCrossBatch(summarizeBatches(comparisons)));
  else lines.push('（只给了 1 批：单批百分比不是结论，至少给 2 批才能谈方向。）');
  return lines.join('\n');
}

/** Parse one evidence file's text (the script prints a title line, then one JSON object). */
export function parseBatchEvidence(text: string, source: string): VoiceBatchEvidence {
  const start = text.indexOf('{', text.indexOf('===') >= 0 ? text.indexOf('===') : 0);
  if (start < 0) throw new Error(`${source}: 找不到 JSON 主体（应含 '=== ' 标题行与一个 JSON 对象）`);
  const parsed = JSON.parse(text.slice(start)) as { turns?: unknown; latency?: { command?: string } };
  if (!Array.isArray(parsed.turns)) throw new Error(`${source}: JSON 里没有 turns 数组`);
  return { source, command: parsed.latency?.command, turns: parsed.turns as readonly VoiceTurnEvidence[] };
}
