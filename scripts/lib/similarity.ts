/**
 * Character-level similarity for ASR verification (Chinese: no word boundaries).
 *
 * Lives in `lib/` so `voice-device-check.ts` and `verify-voice-noise.ts` score the same
 * transcripts the same way — two different definitions of "recognised" would make the two
 * reports incomparable. Punctuation and whitespace are dropped before comparing, because
 * ASR output punctuation is not part of what the user said.
 */

export function normaliseForComparison(text: string): string {
  return text.replace(/[\s，。！？、,.!?：:；;"'`（）()【】\[\]…—-]/g, '').toLowerCase();
}

export function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, index) => index);
  for (let j = 1; j <= b.length; j += 1) {
    let diagonal = rows[0] as number;
    rows[0] = j;
    for (let i = 1; i <= a.length; i += 1) {
      const previous = rows[i] as number;
      rows[i] = Math.min(
        (rows[i] as number) + 1,
        (rows[i - 1] as number) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return rows[a.length] as number;
}

/** 0…1, 1 = identical after normalisation. Two empty strings count as identical. */
export function characterSimilarity(actual: string, expected: string): number {
  const left = normaliseForComparison(actual);
  const right = normaliseForComparison(expected);
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const distance = levenshtein(left, right);
  return Number((1 - distance / Math.max(left.length, right.length)).toFixed(3));
}

/**
 * The reference transcripts the Chinese fixtures were synthesised from, kept in sync with
 * `scripts/make-audio-fixtures.ts` (the ids are the WAV file stems). Kept here rather than
 * read from a generated manifest so a fixture that was regenerated with different text
 * cannot silently pass.
 */
export const FIXTURE_TEXTS: Record<string, string> = {
  'direct-question': '西西，明天天气怎么样？',
  'followup-turn': '对了，还有个事想问你。',
  'backchannel': '嗯。',
  'longer-turn': '我明天下午去镇上办点事，可能要到晚上才回来。',
  'tv-dialogue': '明天天气怎么样？',
};
