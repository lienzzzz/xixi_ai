/**
 * Realism metrics: the mechanical half of "does this sound like a person" (pack
 * `docs/05_TEST_AND_ACCEPTANCE.md` §2.1, adapted to this repo).
 *
 * Everything here is a pure function over turn records, so the numbers can be
 * recomputed from a saved transcript without paying for another model run, and
 * the same definition can be applied to the V0.1 baseline and to the V0.2
 * attempt. Definitions are documented on each metric because "提问率" means
 * different things to different readers:
 *
 *   - `questionRate`        回复**含**问号的开口轮占比（"她这一轮问了吗"）
 *   - `questionEndingRate`  回复**以**问号结尾的开口轮占比（pack 的 wording）
 *   - `lengthBuckets`       半句 / 短句 / 中句 / 长解释 四档（见 BUCKETS）
 *   - `bannedTemplateRate`  命中「AI 套话」词表的开口轮占比
 *   - `repeatedPhraseRate`  同一 6 字窗口出现在 >=3 轮的占比（模板化痕迹）
 *   - `silenceRate`         沉默轮占全部被接受轮的比例
 *
 * A "turn" is one accepted conversation turn; metrics that describe replies are
 * computed over *spoken* turns only, so a silence-heavy conversation is not
 * silently turned into a "low question rate" one.
 *
 * Scope note: `scripts/benchmarks/v01-text-metrics.ts` is the one-off V0.1
 * transcript instrument from the P0 baseline. This module is the canonical
 * implementation for corpus/session runs going forward; keep new definitions
 * here so the before/after numbers cannot drift apart.
 */

export interface RealismTurn {
  /** Scenario/conversation id the turn belongs to. */
  readonly scenario: string;
  /** 0-based turn index inside its scenario. */
  readonly index: number;
  readonly user: string;
  readonly action: string;
  readonly accepted: boolean;
  readonly reply: string | null;
  /**
   * Character count of each delivered segment (ADR-0010 splits a reply into
   * several spoken chunks). Optional because older recordings and `--replay`
   * runs may not carry it; when present it answers the question the raw length
   * cannot: "was the long answer delivered as one huge chunk or several short
   * ones?"
   */
  readonly segmentChars?: readonly number[] | undefined;
  readonly totalMs?: number | null;
  readonly firstTokenMs?: number | null;
}

/** 半句 → 长解释。Boundaries are char counts, inclusive on both ends. */
export const BUCKETS: readonly { readonly name: string; readonly max: number }[] = [
  { name: '半句(<=15)', max: 15 },
  { name: '短句(16-40)', max: 40 },
  { name: '中句(41-90)', max: 90 },
  { name: '长解释(>=91)', max: Number.POSITIVE_INFINITY },
];

/**
 * 「AI 套话」词表：模型在客服腔里反复用的开场/收尾。每条都写清楚为什么算套话，
 * 免得后来者把它当成"禁用词洁癖"。pack 的原话是「听起来、我理解、随时告诉、
 * 当然可以」这一类；这里给出可执行的补集。
 */
export const BANNED_TEMPLATES: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /听起来/, why: '客服式共情开场，不是家里人的说法（pack G01 的「不好」例子）' },
  { pattern: /看起来/, why: '隔着屏幕观察的口气，父亲不是被观察对象' },
  { pattern: /我理解/, why: '客服/咨询话术，用「我理解」代替真实回应' },
  { pattern: /我明白/, why: '机械确认，和「我理解」同一类空转' },
  { pattern: /随时(告诉我|跟我说|找我|可以)/, why: '标准收尾话术，把关系说成服务关系（pack G05 的「不好」例子）' },
  { pattern: /(如果|要是)还有什么(想|需要|可以)/, why: '客服收尾模板，pack §2.1 明确列为警报' },
  { pattern: /(还有)?(什么|啥)(可以|能)帮(您|你)(的)?(吗|呢)/, why: '助手腔：开口就问「需要什么帮助」，家里人不会这么说' },
  { pattern: /当然可以/, why: '许可式回应，家里人直接答内容而不是批准请求' },
  { pattern: /希望对(你|您)有帮助/, why: '助手收尾：把对话当成一次交付' },
  { pattern: /感谢(你|您)?的?(分享|理解|支持)/, why: '客服/课堂腔，日常聊天不会先致谢再说话' },
  { pattern: /作为(一个)?(AI|人工智能|语言模型|助手)/, why: '自称 AI，直接破坏陪伴角色（也属角色泄漏）' },
  { pattern: /我在这里陪(着|伴)/, why: '产品文案腔，把陪伴说成功能' },
  { pattern: /让我(来)?(帮你|为你)(分析|解决|看看怎么)/, why: '工具型助手腔：先报「我来帮你」再处理事情' },
];

export function bannedTemplatesIn(reply: string): { template: string; matched: string; why: string }[] {
  return BANNED_TEMPLATES.flatMap((entry) => {
    const match = entry.pattern.exec(reply);
    return match === null ? [] : [{ template: entry.pattern.source, matched: match[0], why: entry.why }];
  });
}

export interface LengthDistribution {
  readonly counts: Record<string, number>;
  readonly shares: Record<string, number>;
  /** Share of spoken turns in the most common bucket (the "always the same length" alarm). */
  readonly dominantShare: number;
  readonly dominantBucket: string | null;
}

export interface RealismMetrics {
  readonly turns: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly spokenTurns: number;
  readonly silenceTurns: number;
  readonly silenceRate: number;
  readonly questionTurns: number;
  readonly questionRate: number;
  readonly questionEndingTurns: number;
  readonly questionEndingRate: number;
  readonly chars: readonly number[];
  readonly charsP50: number;
  readonly charsMax: number;
  readonly length: LengthDistribution;
  /**
   * How the reply was *delivered*: segments per turn and per-segment length.
   * `n` is the number of spoken turns that carried segment data.
   */
  readonly segments: {
    readonly n: number;
    readonly perTurnHistogram: Record<string, number>;
    readonly perTurnMean: number;
    readonly segmentCharsP50: number;
    readonly segmentCharsMax: number;
    /** Turns with a segment longer than `segmentLimit` (the splitter's ceiling). */
    readonly overLimitTurns: number;
  };
  readonly bannedTemplateTurns: number;
  readonly bannedTemplateRate: number;
  readonly bannedTemplateHits: readonly { scenario: string; index: number; matched: string; why: string }[];
  readonly repeatedPhrases: readonly { phrase: string; turns: readonly number[] }[];
  readonly repeatedPhraseRate: number;
  /** Longest run of consecutive spoken turns with the same (bucket, question?) signature. */
  readonly longestSameStructureRun: number;
  /** Alarms copied from pack §2.1; each one is a named, explainable condition. */
  readonly alarms: readonly string[];
  /** Where the question rate sits relative to the project band (pack says 30–50%). */
  readonly questionBand: 'below' | 'in-band' | 'above';
}

export const QUESTION_BAND: readonly [number, number] = [0.3, 0.5];
/** Default per-segment ceiling; callers can override for a repo whose config differs. */
const SEGMENT_LIMIT = 60;
const PHRASE_N = 6;
const PHRASE_MIN_TURNS = 3;

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = position - lower;
  return Math.round(((sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight) * 10) / 10;
}

export function bucketOf(chars: number): string {
  return BUCKETS.find((bucket) => chars <= bucket.max)?.name ?? '长解释(>=91)';
}

export function replyChars(reply: string): number {
  return [...reply.replace(/\s+/g, '')].length;
}

export function measureRealism(turns: readonly RealismTurn[]): RealismMetrics {
  const accepted = turns.filter((turn) => turn.accepted);
  const spoken = accepted.filter((turn) => turn.action === 'SPEAK' && (turn.reply ?? '').trim().length > 0);
  const silences = accepted.filter((turn) => turn.action === 'SILENCE');

  const chars = spoken.map((turn) => replyChars(turn.reply ?? ''));
  const sortedChars = [...chars].sort((a, b) => a - b);

  const counts: Record<string, number> = {};
  for (const bucket of BUCKETS) counts[bucket.name] = 0;
  for (const value of chars) {
    const name = bucketOf(value);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const shares: Record<string, number> = {};
  for (const [name, count] of Object.entries(counts)) {
    shares[name] = spoken.length === 0 ? 0 : Math.round((count / spoken.length) * 1000) / 1000;
  }
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const dominantBucket = dominant === undefined || dominant[1] === 0 ? null : dominant[0];
  const dominantShare = dominantBucket === null || spoken.length === 0 ? 0 : Math.round(((dominant?.[1] ?? 0) / spoken.length) * 1000) / 1000;

  const questionTurns = spoken.filter((turn) => /[？?]/.test(turn.reply ?? '')).length;
  const questionEndingTurns = spoken.filter((turn) => /[？?]\s*$/.test((turn.reply ?? '').trim())).length;

  const bannedTemplateHits: { scenario: string; index: number; matched: string; why: string }[] = [];
  for (const turn of spoken) {
    for (const hit of bannedTemplatesIn(turn.reply ?? '')) {
      bannedTemplateHits.push({ scenario: turn.scenario, index: turn.index, matched: hit.matched, why: hit.why });
    }
  }
  const turnsWithTemplateHit = new Set(bannedTemplateHits.map((hit) => `${hit.scenario}#${hit.index}`)).size;

  // Repeated 6-char windows across spoken turns, then reduced to maximal phrases.
  const byPhrase = new Map<string, number[]>();
  spoken.forEach((turn, position) => {
    const characters = [...(turn.reply ?? '')];
    for (let start = 0; start + PHRASE_N <= characters.length; start += 1) {
      const phrase = characters.slice(start, start + PHRASE_N).join('');
      const list = byPhrase.get(phrase) ?? [];
      if (!list.includes(position + 1)) list.push(position + 1);
      byPhrase.set(phrase, list);
    }
  });
  const candidates = [...byPhrase.entries()]
    .filter(([, list]) => list.length >= PHRASE_MIN_TURNS)
    .map(([phrase, list]) => ({ phrase, turns: list }))
    .sort((a, b) => b.turns.length - a.turns.length);
  const repeatedPhrases = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) => other !== candidate && other.phrase.includes(candidate.phrase) && candidate.turns.every((turn) => other.turns.includes(turn)),
      ),
  );
  const repeatedPhraseRate = spoken.length === 0 ? 0 : Math.round((repeatedPhrases.length / spoken.length) * 1000) / 1000;

  let longestRun = 0;
  let run = 0;
  let previousSignature: string | null = null;
  for (const turn of spoken) {
    const signature = `${bucketOf(replyChars(turn.reply ?? ''))}|${/[？?]/.test(turn.reply ?? '') ? 'q' : 'n'}`;
    run = signature === previousSignature ? run + 1 : 1;
    previousSignature = signature;
    if (run > longestRun) longestRun = run;
  }

  const withSegments = spoken.filter((turn) => (turn.segmentChars ?? []).length > 0);
  const perTurnHistogram: Record<string, number> = {};
  let segmentTotal = 0;
  const allSegmentChars: number[] = [];
  let overLimitTurns = 0;
  for (const turn of withSegments) {
    const counts = turn.segmentChars ?? [];
    perTurnHistogram[`${counts.length}段`] = (perTurnHistogram[`${counts.length}段`] ?? 0) + 1;
    segmentTotal += counts.length;
    allSegmentChars.push(...counts);
    if (counts.some((count) => count > SEGMENT_LIMIT)) overLimitTurns += 1;
  }
  const sortedSegments = [...allSegmentChars].sort((a, b) => a - b);
  const segmentsSummary = {
    n: withSegments.length,
    perTurnHistogram,
    perTurnMean: withSegments.length === 0 ? 0 : Math.round((segmentTotal / withSegments.length) * 10) / 10,
    segmentCharsP50: quantile(sortedSegments, 0.5),
    segmentCharsMax: sortedSegments[sortedSegments.length - 1] ?? 0,
    overLimitTurns,
  };

  const questionRate = spoken.length === 0 ? 0 : Math.round((questionTurns / spoken.length) * 1000) / 1000;
  const alarms: string[] = [];
  if (spoken.length > 0 && dominantShare > 0.8) {
    alarms.push(`回复长度 >80% 落在同一档（${dominantBucket}，${Math.round(dominantShare * 100)}%）`);
  }
  if (spoken.length > 0 && questionRate > 0.8) {
    alarms.push(`>80% 的回复都带问题（${Math.round(questionRate * 100)}%）`);
  }
  if (bannedTemplateHits.some((hit) => hit.matched.includes('还有什么') || hit.matched.includes('随时'))) {
    alarms.push('出现了「如果还有什么…」/「随时告诉我」这类客服收尾');
  }
  if (longestRun >= 3) {
    alarms.push(`连续 ${longestRun} 轮回复同结构（同一长度档 + 同样有没有问号）`);
  }
  if (segmentsSummary.n > 0 && segmentsSummary.overLimitTurns / segmentsSummary.n > 0.2) {
    alarms.push(
      `${segmentsSummary.overLimitTurns}/${segmentsSummary.n} 轮出现超过 ${SEGMENT_LIMIT} 字的单段（分段没兜住，朗读会一口气念很长）`,
    );
  }

  return {
    turns: turns.length,
    accepted: accepted.length,
    rejected: turns.length - accepted.length,
    spokenTurns: spoken.length,
    silenceTurns: silences.length,
    silenceRate: accepted.length === 0 ? 0 : Math.round((silences.length / accepted.length) * 1000) / 1000,
    questionTurns,
    questionRate,
    questionEndingTurns,
    questionEndingRate: spoken.length === 0 ? 0 : Math.round((questionEndingTurns / spoken.length) * 1000) / 1000,
    chars,
    charsP50: quantile(sortedChars, 0.5),
    charsMax: sortedChars[sortedChars.length - 1] ?? 0,
    length: { counts, shares, dominantShare, dominantBucket },
    segments: segmentsSummary,
    bannedTemplateTurns: turnsWithTemplateHit,
    bannedTemplateRate: spoken.length === 0 ? 0 : Math.round((turnsWithTemplateHit / spoken.length) * 1000) / 1000,
    bannedTemplateHits,
    repeatedPhrases,
    repeatedPhraseRate,
    longestSameStructureRun: longestRun,
    alarms,
    questionBand: questionRate < QUESTION_BAND[0] ? 'below' : questionRate > QUESTION_BAND[1] ? 'above' : 'in-band',
  };
}

/** Merge several scenario metrics into one line for the report table. */
export function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
