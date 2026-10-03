import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { printEvidence, REPO_ROOT } from '../../../scripts/lib/harness.ts';
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
  // Both floors are named **and computed** (t21): the numbers must be this batch's own readings, so
  // nobody expects chunk tuning to reach the target and nobody reads a remembered constant.
  assert.match(text, /② 首 token（模型侧，不由语音链路决定）/, 'stage ② is named as the first floor');
  assert.match(text, /③ 首段合成（合成往返，模型供应商侧）/, 'stage ③ is named as the second floor');
  assert.match(text, /本次只给了 1 批，读数是 P50 中位 1500 ms、区间 1500–1500 ms/, 'a single batch is a reading, not a floor');
  assert.match(text, /单批数字不足以称「地板」/, 'and it says so');
  assert.match(text, /必须同时压这两条；调切块参数做不到/, 'with the conclusion that chunking cannot reach the target');
  // The two hand-typed constants that used to live here must be gone (t21): they disagreed with the
  // very batches they described (per-batch ② P50 over eight batches: 903.5–8162.5 ms).
  assert.doesNotMatch(text, /1\.7[–-]2\.0/, 'the remembered ② range must not come back');
  assert.doesNotMatch(text, /MiMo TTS 单次往返/, 'nor a remembered ③ range');
  // And the per-turn rows carry both signs when the data has both.
  assert.match(text, /-1100/, 'the delta column shows the actual per-turn differences');
  assert.match(text, /\+1000/, 'including the turn where streaming was slower');
});

test('the ②/③ floors come from the artefacts, not from a remembered constant (t21)', () => {
  // Same batch, different ②: the printed floor must follow the data. This is the whole point of the
  // fix — a hard-coded 「② 约 1.7–2.0 s」 cannot move when the artefacts say something else.
  const slow = compareBatch(
    evidence({ turns: evidence().turns.map((turn) => ({ ...turn, fourStage: { ...turn.fourStage, asrFinalToFirstTokenMs: 8000 } })) }),
  );
  const normal = compareBatch(evidence());
  // A third batch with a much cheaper first token, so the median is not just the average of two.
  const fast = compareBatch(
    evidence({
      source: 'fast.txt',
      turns: evidence().turns.map((turn) => ({
        ...turn,
        fourStage: { ...turn.fourStage, asrFinalToFirstTokenMs: 500, firstTokenToFirstAudioMs: 500 },
      })),
    }),
  );
  // With three batches the line states the spread over all of them, following the data it was given.
  const text = formatComparison([slow, normal, fast]);
  assert.match(text, /按本次给的 3 批产物算，逐批 P50 中位 1500 ms、区间 500–8000 ms/, 'the ② floor is the artefacts’ own spread');
  assert.match(text, /按本次给的 3 批产物算，逐批 P50 中位 1200 ms、区间 500–1200 ms/, 'and so is the ③ floor');

  // The cross-batch summary exposes the same two spreads for machine checking.
  const summary = summarizeBatches([slow, normal, fast]);
  assert.deepEqual(summary.ttft, { medianP50: 1500, min: 500, max: 8000, batches: 3 }, 'every batch contributes to the ② floor');
  assert.deepEqual(summary.third, { medianP50: 1200, min: 500, max: 1200, batches: 3 });
  const cross = formatCrossBatch(summary);
  assert.match(cross, /② 首 token 逐批 P50 中位 1500 ms（500–8000 ms）/, 'the multi-batch line prints the computed spread');
  assert.match(cross, /③ 首段合成逐批 P50 中位 1200 ms（500–1200 ms）/);
  assert.doesNotMatch(cross, /1\.7[–-]2\.0|1\.0[–-]1\.3/, 'no remembered constants in the summary either');
  assert.doesNotMatch(text, /1\.7[–-]2\.0|1\.0[–-]1\.3/, 'nor in the table');

  // With no usable ② at all, it must say so instead of inventing a number.
  const noTtft = compareBatch(evidence({ turns: evidence().turns.map((turn) => ({ ...turn, fourStage: { ...turn.fourStage, asrFinalToFirstTokenMs: null } })) }));
  assert.equal(summarizeBatches([noTtft]).ttft, null);
  assert.equal(summarizeBatches([noTtft]).third?.medianP50, 1200, 'the other floor is unaffected');
  const missing = formatComparison([noTtft, noTtft]);
  assert.match(missing, /② 首 token（模型侧，不由语音链路决定） —— 本次产物里没有可用数值，这里不给数字。/, 'an unmeasured floor is reported as unmeasured');
});

test('a fresh artefact cannot contain a canned conclusion or a remembered floor (t21)', () => {
  // The regression that closes this task: `voice-turn.ts`'s `latency.note` travels inside *every*
  // artefact, so a canned sentence there ends up contradicting the same file's own recomputation
  // (`--compare` said 「方向不一致（2 快 3 慢）」 while the note said 「多数为正」). The note now points at
  // the command instead of pre-writing the conclusion, and the ②/③ floors are computed.
  //
  // The CLI is run for real (offline: `--fake`), which is the only way to assert what it *writes*
  // rather than what some helper returns.
  const dir = mkdtempSync(join(tmpdir(), 'xixi-t21-artefact-'));
  const out = join(dir, 'batch.txt');
  try {
    execFileSync(
      process.execPath,
      ['scripts/voice-turn.ts', '--fake', '--wav', 'tests/audio-fixtures/direct-question.wav', '--out', out],
      {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        timeout: 120_000,
        // V0.3 P0-B: `voice-turn` defaults to the household canonical store now, so a test that
        // spawns it must point it at its own temporary directory — a test must never create (or
        // touch) `data/xixi`.
        env: { ...process.env, XIXI_VOICE_DATA_DIR: join(dir, 'store') },
      },
    );
    const text = readFileSync(out, 'utf8');
    assert.ok(text.length > 0, 'the tool wrote an artefact');
    const parsed = parseBatchEvidence(text, out);
    assert.ok(parsed.turns.length > 0, 'and it contains the turns');
    const note = (JSON.parse(text.slice(text.indexOf('{', text.indexOf('===')))) as { latency?: { note?: string; reproduce?: string } }).latency;

    // ① No canned direction. The claim must not appear as a standing sentence in the artefact.
    assert.doesNotMatch(text, /方向多数为正、幅度不可复现/, 'the old slogan must not be written into artefacts');
    assert.doesNotMatch(text, /只能写「方向多数为正/, 'nor in that form');
    // …and the note says where the conclusion comes from instead.
    assert.match(note?.note ?? '', /结论由 --compare 按产物计算，本文件不预置结论句/, 'the note delegates the conclusion');
    assert.match(note?.reproduce ?? '', /--compare/, 'and names the command that computes it');
    // ② No remembered floors.
    assert.doesNotMatch(text, /1\.7[–-]2\.0/, 'the remembered ② range must not be written into artefacts');
    assert.doesNotMatch(text, /1\.0[–-]1\.3/, 'nor the remembered ③ range');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the conclusion the artefact points at is the one --compare computes (t21)', () => {
  // The other half: whatever the note claims, the command must be able to produce it. Two artefacts
  // from the same offline run are enough — the point is that the numbers are computed from the files,
  // not remembered. (Built through `printEvidence` so the artefact format is the real one.)
  const title = '语音闭环（夹具音频 → VAD → ASR → 对话 → 流式 TTS）';
  const artefact = (seed: number): string => {
    const lines: string[] = [];
    const write = (line: string): void => {
      lines.push(line);
    };
    const original = console.log;
    console.log = (line: unknown) => write(String(line));
    try {
      printEvidence(title, {
        turns: [
          {
            wav: 'tests/audio-fixtures/direct-question.wav',
            action: 'SPEAK',
            reply: '好的，我记住了。',
            clauses: [{ index: 0, chars: 8 }],
            speech: { endpointDelayMs: 500 },
            legacyTtsMs: 2000 + seed,
            fourStage: { vadEndToAsrFinalMs: 400, asrFinalToFirstTokenMs: 1000 + seed, firstTokenToFirstAudioMs: 900, totalToFirstAudioMs: 2800 },
          },
        ],
        latency: { command: 'node scripts/voice-turn.ts --fake', note: 'x', reproduce: 'y' },
      });
    } finally {
      console.log = original;
    }
    return lines.join('\n');
  };
  const comparison = compareBatch(parseBatchEvidence(artefact(0), 'a.txt'));
  const text = formatComparison([comparison, compareBatch(parseBatchEvidence(artefact(4000), 'b.txt'))]);
  assert.match(text, /方向：流式更快 \d 批、更慢 \d 批、持平 \d 批/, 'the direction is counted from the artefacts');
  assert.match(text, /本次只给了|按本次给的 \d+ 批产物算/, 'and the floors are computed from them too');
  assert.doesNotMatch(text, /1\.7[–-]2\.0|1\.0[–-]1\.3/, 'with no remembered constants anywhere');
});

test('parseBatchEvidence round-trips what the script writes (BOM tolerated)', () => {
  // Round-trip: what `voice-turn.ts` puts on disk must parse back into the same turns and command.
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
