/**
 * V0.1 baseline text metrics: read a captured `scripts/chat.ts` transcript and
 * print the numbers the P0 baseline has to record before anything is changed.
 *
 * The input is the console output as it was written to disk (`data/…/*.txt`), so
 * the baseline numbers can be recomputed without paying for another live run:
 *
 *   node scripts/benchmarks/v01-text-metrics.ts data/benchmarks/v01/chat-real-raw.txt
 *   node scripts/benchmarks/v01-text-metrics.ts docs/benchmarks/v01/raw-chat-real.txt --json
 *
 * What it reports, and why each one matters for "真人感":
 *   - reply length distribution (chars / segments per turn) — V0.1 was suspected
 *     of clamping every reply to at most 3 segments of 60 chars;
 *   - question rate — the target band is 30–50%, so both "never asks" and "asks
 *     every turn" are wrong;
 *   - banned filler templates — "听起来 / 看起来 / 我理解" style openers;
 *   - cross-turn repeated sentences and longest common substring with the
 *     previous reply — the "复述上文" failure mode of a long session.
 *
 * This is a baseline instrument, not the final metric harness (the P1 work grows
 * its own tool); it deliberately depends on nothing but `node:fs`.
 */
import { readFileSync } from 'node:fs';

export interface ParsedTurn {
  readonly reply: string;
  readonly segments: number;
  readonly action: string | null;
  readonly latencyMs: number | null;
  readonly firstTokenMs: number | null;
}

export interface TranscriptMetrics {
  readonly turns: number;
  /** Turns with a spoken reply; a SILENCE turn has an empty reply and is excluded from length/question rates. */
  readonly spokenTurns: number;
  readonly silenceTurns: number;
  readonly chars: readonly number[];
  readonly charsP50: number;
  readonly charsMax: number;
  readonly charsMean: number;
  readonly segments: readonly number[];
  readonly segmentHistogram: Record<string, number>;
  readonly questionTurns: number;
  readonly questionRate: number;
  readonly templateHits: readonly { template: string; turn: number }[];
  readonly repeatedSentences: readonly { sentence: string; turns: readonly number[] }[];
  /** Per-turn longest common substring with the previous reply (index 0 is null). */
  readonly restatedLcs: readonly (number | null)[];
  readonly restatedTurns: readonly { turn: number; longestCommonSubstring: number }[];
  /**
   * Character n-grams (n = PHRASE_N) that appear in at least PHRASE_MIN_TURNS
   * different turns, with the turns named. This is what catches "she closes every
   * answer the same way" — the paraphrase-level repetition the sentence check misses.
   */
  readonly repeatedPhrases: readonly { phrase: string; turns: readonly number[] }[];
}

const PHRASE_N = 6;
const PHRASE_MIN_TURNS = 3;

const TURN_LINE = /^西西(?:【第 (\d+)(?:\/(\d+))? 段】)?：(.*)$/;
const TIMING_LINE = /^\[(\w+) (\d+)ms(?: 首字(\d+)ms)?/;

/** Sentence splitter used by the repetition checks (no NLP dependency). */
function sentences(text: string): string[] {
  return text
    .split(/[。！？!?…\n]/)
    .map((part) => part.replace(/[\s，,、；;"'“”（）()]/g, ''))
    .filter((part) => part.length > 0);
}

function longestCommonSubstring(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = (previous[j - 1] ?? 0) + 1;
        if ((current[j] ?? 0) > best) best = current[j] ?? 0;
      }
    }
    previous = current;
  }
  return best;
}

/** Repo-standard filler openers a "human-like" change is supposed to remove. */
const TEMPLATES = [
  '听起来',
  '看起来',
  '我理解',
  '我明白',
  '首先',
  '其次',
  '总之',
  '希望对你有帮助',
  '还有什么可以帮',
  '我在这里陪着',
];

export function parseTranscript(raw: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  let current: { segments: string[]; action: string | null; latencyMs: number | null; firstTokenMs: number | null } | null =
    null;

  const flush = (): void => {
    if (current === null) return;
    turns.push({
      reply: current.segments.join(''),
      segments: current.segments.length,
      action: current.action,
      latencyMs: current.latencyMs,
      firstTokenMs: current.firstTokenMs,
    });
    current = null;
  };

  for (const line of raw.split(/\r?\n/)) {
    const turnMatch = TURN_LINE.exec(line);
    if (turnMatch !== null) {
      const index = turnMatch[1] === undefined ? 1 : Number(turnMatch[1]);
      // Segment 2+ of the same reply is a continuation, not a new turn.
      if (index <= 1) flush();
      if (current === null) current = { segments: [], action: null, latencyMs: null, firstTokenMs: null };
      current.segments.push(turnMatch[3] ?? '');
      continue;
    }
    const timingMatch = TIMING_LINE.exec(line);
    if (timingMatch !== null && current !== null) {
      current.action = timingMatch[1] ?? null;
      current.latencyMs = Number(timingMatch[2]);
      current.firstTokenMs = timingMatch[3] === undefined ? null : Number(timingMatch[3]);
      // The `[SPEAK …]` line is printed once per turn, after its last segment:
      // it terminates the turn. Without this flush a following `（沉默）` line
      // would be attributed to the previous turn.
      flush();
      continue;
    }
    if (line.startsWith('（沉默）')) {
      // A SILENCE turn prints no 西西 line at all, so it has to be created here —
      // otherwise the denominator of every rate silently loses it.
      if (current === null) current = { segments: [], action: null, latencyMs: null, firstTokenMs: null };
      const silenceMatch = TIMING_LINE.exec(line.replace(/^（沉默）/, ''));
      if (silenceMatch !== null) {
        current.action = silenceMatch[1] ?? 'SILENCE';
        current.latencyMs = Number(silenceMatch[2]);
        current.firstTokenMs = silenceMatch[3] === undefined ? null : Number(silenceMatch[3]);
      } else if (current.action === null) {
        current.action = 'SILENCE';
      }
      flush();
    }
  }
  flush();
  return turns;
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = position - lower;
  return Math.round(((sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight) * 10) / 10;
}

export function measure(turns: readonly ParsedTurn[]): TranscriptMetrics {
  const spoken = turns.filter((turn) => turn.reply.trim().length > 0);
  const chars = spoken.map((turn) => [...turn.reply].length);
  const sortedChars = [...chars].sort((a, b) => a - b);
  const segments = spoken.map((turn) => turn.segments);
  const histogram: Record<string, number> = {};
  for (const count of segments) histogram[`${count}段`] = (histogram[`${count}段`] ?? 0) + 1;

  const questionTurns = spoken.filter((turn) => /[？?]/.test(turn.reply)).length;

  const templateHits: { template: string; turn: number }[] = [];
  turns.forEach((turn, index) => {
    for (const template of TEMPLATES) {
      if (turn.reply.includes(template)) templateHits.push({ template, turn: index + 1 });
    }
  });

  const bySentence = new Map<string, number[]>();
  turns.forEach((turn, index) => {
    for (const sentence of new Set(sentences(turn.reply))) {
      if ([...sentence].length < 6) continue;
      const list = bySentence.get(sentence) ?? [];
      list.push(index + 1);
      bySentence.set(sentence, list);
    }
  });
  const repeatedSentences = [...bySentence.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([sentence, list]) => ({ sentence, turns: list }));

  const restatedLcs: (number | null)[] = [];
  const restatedTurns: { turn: number; longestCommonSubstring: number }[] = [];
  turns.forEach((turn, index) => {
    if (index === 0) {
      restatedLcs.push(null);
      return;
    }
    const previous = turns[index - 1];
    if (previous === undefined) {
      restatedLcs.push(null);
      return;
    }
    const overlap = longestCommonSubstring(turn.reply, previous.reply);
    restatedLcs.push(overlap);
    if (overlap >= 8) restatedTurns.push({ turn: index + 1, longestCommonSubstring: overlap });
  });

  const byPhrase = new Map<string, number[]>();
  turns.forEach((turn, index) => {
    const charsOfTurn = [...turn.reply];
    if (charsOfTurn.length < PHRASE_N) return;
    for (let start = 0; start + PHRASE_N <= charsOfTurn.length; start += 1) {
      const phrase = charsOfTurn.slice(start, start + PHRASE_N).join('');
      const list = byPhrase.get(phrase) ?? [];
      if (!list.includes(index + 1)) list.push(index + 1);
      byPhrase.set(phrase, list);
    }
  });
  const candidates = [...byPhrase.entries()]
    .filter(([, list]) => list.length >= PHRASE_MIN_TURNS)
    .map(([phrase, list]) => ({ phrase, turns: list }))
    .sort((a, b) => b.turns.length - a.turns.length || b.phrase.length - a.phrase.length);
  // Keep only maximal phrases: drop a phrase whose turn set is a subset of another
  // phrase that contains it (otherwise every 6-character window is reported).
  const repeatedPhrases = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate &&
          other.phrase.includes(candidate.phrase) &&
          candidate.turns.every((turn) => other.turns.includes(turn)),
      ),
  );

  return {
    turns: turns.length,
    spokenTurns: spoken.length,
    silenceTurns: turns.length - spoken.length,
    chars,
    charsP50: quantile(sortedChars, 0.5),
    charsMax: sortedChars[sortedChars.length - 1] ?? 0,
    charsMean: Math.round((chars.reduce((sum, value) => sum + value, 0) / Math.max(1, chars.length)) * 10) / 10,
    segments,
    segmentHistogram: histogram,
    questionTurns,
    questionRate: Math.round((questionTurns / Math.max(1, spoken.length)) * 1000) / 10,
    templateHits,
    repeatedSentences,
    restatedLcs,
    restatedTurns,
    repeatedPhrases,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((argument) => !argument.startsWith('--'));
  if (file === undefined) {
    console.error('用法：node scripts/benchmarks/v01-text-metrics.ts <chat-transcript.txt> [--json]');
    process.exit(2);
  }
  const turns = parseTranscript(readFileSync(file, 'utf8'));
  const metrics = measure(turns);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ file, metrics, turns }, null, 2));
    return;
  }
  console.log(`文件：${file}`);
  console.log(`轮数：${metrics.turns}（开口 ${metrics.spokenTurns}，沉默 ${metrics.silenceTurns}）`);
  console.log(`每轮字符数：${metrics.chars.join(' / ')}（P50 ${metrics.charsP50}，均值 ${metrics.charsMean}，最大 ${metrics.charsMax}）`);
  console.log(`每轮段数：${metrics.segments.join(' / ')}（${JSON.stringify(metrics.segmentHistogram)}）`);
  console.log(`含问号的轮数：${metrics.questionTurns}/${metrics.spokenTurns}（开口轮）= ${metrics.questionRate}%`);
  console.log(
    `客套模板命中：${metrics.templateHits.length === 0 ? '无' : metrics.templateHits.map((hit) => `第${hit.turn}轮「${hit.template}」`).join('、')}`,
  );
  console.log(
    `跨轮重复句子（>=6 字）：${metrics.repeatedSentences.length === 0 ? '无' : metrics.repeatedSentences.map((item) => `「${item.sentence}」@${item.turns.join(',')}`).join('、')}`,
  );
  console.log(
    `与上一轮回复的最长公共子串（字，逐轮）：${metrics.restatedLcs.map((value) => (value === null ? '-' : value)).join(' / ')}`,
  );
  console.log(
    `与上一轮回复最长公共子串 >=8 字的轮：${
      metrics.restatedTurns.length === 0
        ? '无'
        : metrics.restatedTurns.map((item) => `第${item.turn}轮（${item.longestCommonSubstring}字）`).join('、')
    }`,
  );
  console.log(
    `跨轮重复短语（${PHRASE_N} 字窗口，出现在 >=${PHRASE_MIN_TURNS} 轮）：${
      metrics.repeatedPhrases.length === 0
        ? '无'
        : metrics.repeatedPhrases
            .slice(0, 12)
            .map((item) => `「${item.phrase}」@${item.turns.join(',')}`)
            .join('、')
    }`,
  );
}

if (import.meta.main) main();
