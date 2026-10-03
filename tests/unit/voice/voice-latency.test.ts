import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  batchLabel,
  compareBatch,
  formatComparison,
  formatCrossBatch,
  latencyStats,
  legacyTotalMs,
  pairTurns,
  parseBatchEvidence,
  summarizeBatches,
  VOICE_PACK_TARGET_MS,
  type VoiceBatchEvidence,
} from '../../../scripts/lib/voice-latency.ts';

/**
 * The first-audio comparison, pinned (t9; the module moved to `scripts/lib/` in t16).
 *
 * Two reviews in a row asked for the same thing and neither could get it from the code:
 *   * t5 — the 「整段合成」 column had no raw artefact, so its numbers could not be recomputed;
 *   * t12 — the same-batch delta was reported from one batch while three batches disagree in sign,
 *     so a single percentage is not a finding.
 *
 * These tests therefore pin the *rules*, not one run's numbers: how a turn is paired, which formula
 * produces the whole-reply ④, that ③ and ④ are kept apart (the target is ④), and that unmeasured
 * rounds are excluded rather than counted as zero.
 */

/** A synthetic evidence file with both paths measured, so the expectations can be exact. */
function evidence(overrides: Partial<VoiceBatchEvidence> = {}): VoiceBatchEvidence {
  return {
    source: 'synthetic.txt',
    command: 'node scripts/voice-turn.ts --wav a.wav --wav b.wav --trace',
    turns: [
      {
        wav: 'tests/audio-fixtures/a.wav',
        action: 'SPEAK',
        reply: '好的，我记住了。'.repeat(3),
        clauses: [{ index: 0, chars: 8 }, { index: 1, chars: 16 }],
        speech: { endpointDelayMs: 500 },
        legacyTtsMs: 2000,
        fourStage: { vadEndToAsrFinalMs: 400, asrFinalToFirstTokenMs: 1000, firstTokenToFirstAudioMs: 900, totalToFirstAudioMs: 2800 },
      },
      {
        wav: 'tests/audio-fixtures/b.wav',
        action: 'SPEAK',
        reply: '嗯。',
        clauses: [{ index: 0, chars: 2 }],
        speech: { endpointDelayMs: 600 },
        legacyTtsMs: 500,
        fourStage: { vadEndToAsrFinalMs: 600, asrFinalToFirstTokenMs: 2000, firstTokenToFirstAudioMs: 1500, totalToFirstAudioMs: 4700 },
      },
    ],
    ...overrides,
  };
}

test('a whole-reply ④ uses the same batch’s ①② and the same formula as the script', () => {
  const turn = evidence().turns[0];
  // endpoint + ① + ② + ③(whole reply) — exactly `e2eToFirstReplyAudioMs` from scripts/voice-turn.ts.
  assert.equal(legacyTotalMs(turn), 500 + 400 + 1000 + 2000);
  // Unmeasured is `null`, never 0: a missing endpoint, ASR, TTFT or legacy call all disqualify it.
  assert.equal(legacyTotalMs({ ...turn, legacyTtsMs: null }), null);
  assert.equal(legacyTotalMs({ ...turn, speech: null }), null);
  assert.equal(legacyTotalMs({ ...turn, fourStage: { ...turn.fourStage, asrFinalToFirstTokenMs: null } }), null);
  assert.equal(legacyTotalMs({ ...turn, fourStage: {} }), null);
});

test('pairTurns pairs streaming against whole-reply per turn, four stages wide', () => {
  const rows = pairTurns(evidence());
  assert.equal(rows.length, 2, 'one row per turn');
  const [first, second] = rows;
  assert.equal(first?.wav, 'a.wav', 'the fixture name is the label');
  assert.equal(first?.asrMs, 400);
  assert.equal(first?.ttftMs, 1000);
  assert.equal(first?.stream3Ms, 900, '③ streaming is the clause synthesis');
  assert.equal(first?.legacy3Ms, 2000, '③ whole-reply is the full-text synthesis');
  assert.equal(first?.stream4Ms, 2800);
  assert.equal(first?.legacy4Ms, 3900);
  assert.equal(first?.delta4Ms, -1100, 'negative = streaming reached audio sooner');
  assert.equal(first?.clauses, 2);
  assert.equal(first?.replyChars, 24, 'the reply is counted as written, punctuation included');
  // The second turn is ④-worse for streaming: the pairing must show that too (a table that only ever
  // shows one sign is the artefact t12 was complaining about).
  assert.equal(second?.delta4Ms, 4700 - (600 + 600 + 2000 + 500));
  assert.ok((second?.delta4Ms ?? 0) > 0, 'this synthetic turn is a counterexample in the other direction');
});

test('compareBatch reports every stage, and names ④ as the pack target', () => {
  const comparison = compareBatch(evidence());
  assert.equal(comparison.n, 2);
  assert.equal(comparison.paired, 2);
  assert.deepEqual(comparison.streaming.asr, { n: 2, p50: 500, p90: 580, min: 400, max: 600 });
  assert.deepEqual(comparison.streaming.ttft, { n: 2, p50: 1500, p90: 1900, min: 1000, max: 2000 });
  assert.deepEqual(comparison.legacy.third, { n: 2, p50: 1250, p90: 1850, min: 500, max: 2000 });
  assert.deepEqual(comparison.streaming.fourth, { n: 2, p50: 3750, p90: 4510, min: 2800, max: 4700 });
  // Whole reply: 500+400+1000+2000 = 3900 and 600+600+2000+500 = 3700.
  assert.deepEqual(comparison.legacy.fourth, { n: 2, p50: 3800, p90: 3880, min: 3700, max: 3900 });
  assert.equal(comparison.streamOverLegacy, Number((3750 / 3800).toFixed(3)), 'streaming is fractionally faster here');
  // The pack ratio is a ④ statement; ③'s ratio is printed separately precisely so the two are not
  // confused (the t5 finding: 「超 15%」 and 「超 3 倍」 described different stages).
  assert.equal(comparison.packRatio, Number((3750 / VOICE_PACK_TARGET_MS).toFixed(2)));
  assert.notEqual(comparison.packRatio, comparison.packRatioOfThird);
  assert.equal(VOICE_PACK_TARGET_MS, 1_500);
});

test('a batch without the whole-reply column is still usable, and marked as unpaired', () => {
  const noLegacy = evidence({
    turns: evidence().turns.map((turn) => ({ ...turn, legacyTtsMs: null })),
  });
  const comparison = compareBatch(noLegacy);
  assert.equal(comparison.paired, 0, 'nothing to pair against');
  assert.equal(comparison.legacy.fourth, null, 'no whole-reply ④ to report');
  assert.equal(comparison.delta4, null);
  assert.equal(comparison.streamOverLegacy, null);
  assert.ok(comparison.streaming.fourth !== null, 'but the streaming column is still there');
  assert.ok(comparison.packRatio !== null);
});

test('percentiles follow the baseline rule and ignore unmeasured rounds', () => {
  assert.equal(latencyStats([]), null);
  assert.equal(latencyStats([null, undefined]), null, 'unmeasured is not zero');
  assert.deepEqual(latencyStats([100]), { n: 1, p50: 100, p90: 100, min: 100, max: 100 });
  assert.deepEqual(latencyStats([100, null, 200, 300, 400]), { n: 4, p50: 250, p90: 370, min: 100, max: 400 });
});

test('the printed table states the ③/④ distinction and refuses a single-batch conclusion', () => {
  const text = formatComparison([compareBatch(evidence())]);
  assert.match(text, /① VAD end → ASR final/, 'stage ① is named');
  assert.match(text, /② ASR final → 首 token/, 'stage ② is named');
  assert.match(text, /③ 首 token → 首段可听/, 'stage ③ is named');
  assert.match(text, /④ 端点保持 \+ ① \+ ② \+ ③/, 'stage ④ is defined by its formula');
  // The sentence the acceptance asks for, in the artefact itself:
  assert.match(text, /1500 ms 目标指的是 ③ 还是 ④：是 ④/, 'the pack target is tied to ④ explicitly');
  assert.match(text, /③ 只是归因量/, 'and ③ is labelled as an attribution quantity');
  // The conclusion rule that t12 asked for:
  // The conclusion rule that t12 asked for: a direction count plus a range, never a single batch's
  // percentage. The old slogan 「方向多数为正、幅度不可复现」 is *not* hard-coded any more — the
  // summary computes whether the claim holds for the data it was given (see the cross-batch test).
  assert.match(text, /多批并列时只能写方向统计与幅度区间/, 'the permitted conclusion shape');
  assert.match(text, /方向多数为正.*只有在多数批次真的更快时才成立/, 'and the slogan is made conditional, not quoted');
  assert.match(text, /只给了 1 批/, 'a single batch is refused as a conclusion');
  assert.doesNotMatch(text, /(?<!不可)复现的单批百分比/, 'no single-batch percentage is presented as a finding');
  // Both floors are named, so nobody expects chunk tuning to reach the target:
  assert.match(text, /② 首 token/);
  assert.match(text, /MiMo TTS 单次往返/);
  // And the per-turn rows carry both signs when the data has both.
  assert.match(text, /-1100/, 'the delta column shows the actual per-turn differences');
  assert.match(text, /\+1000/, 'including the turn where streaming was slower');
});

test('parseBatchEvidence round-trips what the script writes (BOM tolerated)', () => {
  const written = `=== 语音闭环（夹具音频 → VAD → ASR → 对话 → 流式 TTS）===\n${JSON.stringify({ turns: evidence().turns, latency: { command: 'node …' } }, null, 2)}\n`;
  const parsed = parseBatchEvidence(written, 'data/voice/bench/x.txt');
  assert.equal(parsed.turns.length, 2);
  assert.equal(parsed.command, 'node …');
  assert.equal(compareBatch(parsed).paired, 2);
  // PowerShell's `Out-File -Encoding utf8` writes a BOM; the reader must not choke on it.
  const withBom = parseBatchEvidence(`\uFEFF${written}`, 'bom.txt');
  assert.equal(withBom.turns.length, 2);
  assert.throws(() => parseBatchEvidence('no json here', 'bad.txt'), /找不到 JSON 主体/);
  assert.throws(() => parseBatchEvidence('=== x ===\n{"latency":{}}', 'bad2.txt'), /没有 turns 数组/);
});

test('batchLabel keeps the artefact recognisable', () => {
  assert.equal(batchLabel('data/voice/bench/t11-batch1.txt'), 't11-batch1');
  assert.equal(batchLabel('C:\\Users\\x\\AppData\\Local\\Temp\\t5-review\\m3legacy-2.txt'), 'm3legacy-2');
  assert.equal(batchLabel('plain'), 'plain');
});

test('the cross-batch summary counts directions and reports a range, never a single percentage', () => {
  // Three batches that disagree, which is exactly the t12 finding: two better, one worse.
  // A costly whole-reply synthesis makes streaming look good (it only pays for the first clause)…
  const better = compareBatch(
    evidence({
      source: 'better.txt',
      turns: evidence().turns.map((turn) => ({ ...turn, legacyTtsMs: 6000 })),
    }),
  );
  // …while a cheap whole reply plus a slow clause makes it look worse, on the same fixtures.
  const worse = compareBatch(
    evidence({
      source: 'worse.txt',
      turns: evidence().turns.map((turn) => ({ ...turn, legacyTtsMs: 100, fourStage: { ...turn.fourStage, firstTokenToFirstAudioMs: 5000 } })),
    }),
  );
  const summary = summarizeBatches([worse, better, better]);
  assert.equal(summary.batches, 3);
  assert.equal(summary.pairedBatches, 3);
  assert.equal(summary.worse, 1);
  assert.equal(summary.better, 2);
  assert.equal(summary.mostlyBetter, true, 'two of three batches were faster: the claim survives here');
  assert.ok(summary.deltaPercentRange !== null);
  assert.ok((summary.deltaPercentRange?.min ?? 0) < 0, 'the range reaches into the streaming-faster side');
  assert.ok((summary.deltaPercentRange?.max ?? 0) > 0, 'and into the streaming-slower side');
  assert.notEqual(summary.deltaPercentRange?.min, summary.deltaPercentRange?.max);

  const text = formatCrossBatch(summary);
  assert.match(text, /方向：流式更快 2 批、更慢 1 批、持平 0 批/, 'the directions are counted');
  assert.match(text, /方向多数为正/, 'and the claim is stated because it holds for this data');
  assert.match(text, /跨批不可复现/, 'the range comes with that warning');
  assert.match(text, /1500 ms 目标：是 ④（端点后到首段可听），不是 ③/, 'the target is still tied to ④');

  // …and when the claim does NOT hold, the report must say so instead of repeating the slogan.
  // This is what the five real artefacts (2 better, 3 worse) look like.
  const reversed = summarizeBatches([worse, worse, better]);
  assert.equal(reversed.mostlyBetter, false);
  assert.match(formatCrossBatch(reversed), /方向不一致/, 'the slogan is dropped when the data contradicts it');

  // A single batch cannot be summarised as a conclusion — the function says so honestly.
  const single = summarizeBatches([better]);
  assert.equal(single.pairedBatches, 1);
  assert.equal(single.mostlyBetter, true, 'one batch trivially agrees with itself');
  assert.equal(summarizeBatches([]).deltaPercentRange, null);
  assert.equal(summarizeBatches([]).pairedBatches, 0);
});

test('the real artefacts on disk pair up (skipped when they are absent)', () => {
  // `data/` is gitignored, so this runs only where a batch was actually produced. It is the bridge
  // between the synthetic rules above and the number the report quotes.
  const batches = [
    'data/voice/bench/t9-legacy-batch1.txt',
    'data/voice/bench/t9-legacy-batch2.txt',
    'data/voice/bench/t11-batch1.txt',
    'data/voice/bench/t11-batch2.txt',
    'data/voice/bench/t11-batch3.txt',
  ];
  const present = batches.filter((file) => {
    try {
      readFileSync(file);
      return true;
    } catch {
      return false;
    }
  });
  if (present.length === 0) return; // nothing to check on a fresh clone
  const comparisons = present.map((file) => compareBatch(parseBatchEvidence(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), file)));
  const totalTurns = comparisons.reduce((sum, comparison) => sum + comparison.n, 0);
  assert.ok(totalTurns >= present.length, `expected turns in every artefact, got ${totalTurns}`);
  for (const comparison of comparisons) {
    assert.equal(comparison.paired, comparison.n, `${comparison.source}: every turn should have both paths`);
    assert.ok(comparison.streaming.fourth !== null && comparison.legacy.fourth !== null);
    assert.ok(comparison.packRatio !== null && comparison.packRatio > 1, 'the pack target is not met in these runs');
  }
  // The t12 point, asserted rather than described: across batches the direction does not stay one
  // way. The **④ P50 ratio** is the quantity that decides it — the per-turn Δ④ median can carry the
  // opposite sign when the distributions differ, and mixing the two would make this test meaningless.
  const summary = summarizeBatches(comparisons);
  assert.equal(summary.pairedBatches, comparisons.length);
  const directions = comparisons.map((comparison) => Math.sign((comparison.streamOverLegacy ?? 1) - 1));
  assert.ok(new Set(directions).size > 1, `expected both directions across batches, got ${directions.join(',')}`);
  assert.equal(summary.better + summary.worse, comparisons.length, 'every paired batch lands in one bucket');
  // And whenever the slogan would be false, the printed report must not carry it.
  if (!summary.mostlyBetter) {
    assert.match(formatCrossBatch(summary), /方向不一致/);
  }
  if (summary.deltaPercentRange !== null) {
    assert.ok(summary.deltaPercentRange.max - summary.deltaPercentRange.min > 10, 'the spread is large: this is why a single batch is not a finding');
  }
});
