/**
 * Noise robustness verification: clean + noisy Chinese fixtures → front end → VAD → ASR.
 *
 * The question this answers is the one the field test turns on: **the user says the
 * microphone is very noisy — can the pipeline still hear them, and up to how much noise?**
 * It runs the same conditioned audio path as production (`voice_edge.segment`), transcribes
 * the detected speech span with the real ASR, and scores the transcript against the text the
 * fixture was synthesised from, per SNR tier.
 *
 * Scoring is character-level similarity (Chinese has no word boundaries) via
 * `scripts/lib/similarity.ts`, the same definition `voice-device-check.ts` uses.
 *
 * Failure rules (a run is a FAIL if any holds):
 *   1. a measured clip produced no speech segment at all;
 *   2. a transcript scored below `--min-similarity` (default 0.6);
 *   3. the VAD endpoint ran more than `--max-endpoint-delay` (default 1500 ms) past the
 *      speech end;
 *   4. a tier where every measured clip failed (that is the documented boundary, and the
 *      run must fail rather than report a passing average).
 *
 * Offline modes (`--fake` / `--dry-run` / `XIXI_FAKE_ASR=1`) are **not** a noise-robustness
 * verdict, and must not look like a broken feature: ASR is a deterministic stub, so rules 1,
 * 2 and 4 cannot apply (the stub's transcript can never match the fixture text). Those
 * records are reported as observations only. What still has to hold offline is the plumbing —
 * at least one clip measured, and rule 3 (endpoint delay is a VAD property, measured without
 * any ASR). If the plumbing holds, the run exits 0 with an explicit 「离线 / 仅验证管线」 line;
 * if it does not, it exits 1. The real-ASR verdict is unchanged.
 *
 * Usage:
 *   node scripts/verify-voice-noise.ts                      # clean + every noisy tier, real ASR
 *   node scripts/verify-voice-noise.ts --fake               # offline: plumbing only, exits 0
 *   node scripts/verify-voice-noise.ts --tiers 18,6         # only those SNR tiers
 *   node scripts/verify-voice-noise.ts --nr                 # A/B: with the noise-reduction stage on
 *   node scripts/verify-voice-noise.ts --dry-run            # VAD + scoring plumbing, no API calls
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MimoClient } from '@xixi/model-adapters';

import { REPO_ROOT, printEvidence, readDotEnv } from './lib/harness.ts';
import { characterSimilarity, FIXTURE_TEXTS } from './lib/similarity.ts';
import { readWav, readWavInfo, sliceWav } from './lib/wav.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const PYTHON = process.env.XIXI_PYTHON ?? join(REPO_ROOT, '.venvs', 'voice-pipecat', 'Scripts', 'python.exe');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'audio-fixtures');
const NOISY_DIR = join(FIXTURE_DIR, 'noisy');
const OUT_DIR = join(REPO_ROOT, 'data', 'voice');

/** Fixtures measured by default: `backchannel.wav` is excluded (Silero cannot see 「嗯。」 — voice.md §2). */
const DEFAULT_MEASURED = ['direct-question', 'followup-turn', 'longer-turn', 'tv-dialogue'];

/**
 * SNR tiers the runner measures out of the box. The fixture set contains more tiers than
 * this (generated at 18/9/6/3/0/−6 dB); this subset keeps one ASR call per clip while still
 * bracketing the measured boundary. Override with `--tiers`.
 */
const DEFAULT_TIERS = [18, 6, 3, 0, -6];

const args = process.argv.slice(2);
function argValue(name: string, fallback: string | null = null): string | null {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? (args[index + 1] as string) : fallback;
}

const fake = args.includes('--fake');
const dryRun = args.includes('--dry-run') || process.env.XIXI_FAKE_ASR === '1';
/**
 * `--nr` adds the spectral-subtraction noise-reduction stage; it is **off by default**
 * because the measured ASR effect is nil at 6 dB SNR and negative at 3 dB (0.62 vs 0.81
 * mean similarity) — see voice.md §1.6. A `--no-nr` argument is accepted and ignored so
 * older invocations keep working.
 */
const useNoiseReduction = args.includes('--nr');
const skipNoiseReduction = !useNoiseReduction;
const minSimilarity = Number(argValue('--min-similarity', '0.6'));
const maxEndpointDelayMs = Number(argValue('--max-endpoint-delay', '1500'));
const tierFilter = argValue('--tiers');
const outPath = argValue('--out', join(OUT_DIR, fake || dryRun ? 'verify-voice-noise-offline.json' : 'verify-voice-noise.json'));

interface NoisyClip {
  id: string;
  fixture: string;
  text: string;
  path: string;
  targetSnrDb: number;
  measuredSnrDb: number;
  noiseReferenceSamples: number;
  conditionedNoiseFloorDbfs: number;
}

interface Segmentation {
  segments: { startMs: number; endMs: number; endpointDelayMs: number | null; durationMs: number }[];
  durationMs: number;
  energyStartMs: number | null;
  energyEndMs: number | null;
  rawEnergyStartMs: number | null;
  bargeInDecisionMs: number | null;
  frontend: {
    highpassHz: number;
    noiseReduction: boolean;
    noiseFloorDbfs: number;
    enhancedNoiseFloorDbfs: number;
    noiseFloorReductionDb: number;
    gateThresholdDbfs: number;
  };
  timings: { loadMs: number; processMs: number; frontendMs: number; noiseReductionMs: number };
}

interface ClipResult {
  readonly id: string;
  readonly fixture: string;
  readonly tier: 'clean' | string;
  readonly targetSnrDb: number | null;
  readonly measuredSnrDb: number | null;
  readonly expected: string;
  readonly wav: string;
  readonly detected: boolean;
  readonly segments: number;
  readonly speechStartMs: number | null;
  readonly speechEndMs: number | null;
  readonly endpointDelayMs: number | null;
  readonly bargeInDecisionMs: number | null;
  readonly rawSpeechStartMs: number | null;
  readonly vadStartLatencyVsCleanMs: number | null;
  readonly noiseFloorDbfs: number;
  readonly enhancedNoiseFloorDbfs: number;
  readonly gateThresholdDbfs: number;
  readonly transcript: string | null;
  readonly similarity: number | null;
  readonly similarityNoNr: number | null;
  readonly asrMs: number | null;
  readonly vadMs: number | null;
  readonly failures: string[];
  readonly note?: string;
}

function runPython(pythonArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, pythonArgs, { cwd: join(REPO_ROOT, 'services', 'voice-edge'), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
    });
    child.stderr.on('data', (data: string) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // Exit 2 means "no speech segments", which is a result, not a failure.
      if (code === 0 || code === 2) resolve(stdout);
      else reject(new Error(`VAD failed (exit ${code}): ${stderr.slice(-400)}`));
    });
  });
}

async function segment(wavPath: string, options: { noiseReduction: boolean; calibratedFloorDbfs?: number }): Promise<Segmentation> {
  const pythonArgs = ['-m', 'voice_edge.segment', wavPath, '--highpass-hz', '120'];
  if (options.noiseReduction) pythonArgs.push('--nr');
  if (options.calibratedFloorDbfs !== undefined) {
    pythonArgs.push('--noise-floor-dbfs', String(options.calibratedFloorDbfs));
  }
  return JSON.parse(await runPython(pythonArgs)) as Segmentation;
}

function requireManifest(): { clips: NoisyClip[]; noiseSource: unknown; snrDefinition: string; measuredByDefault: string[] } {
  const manifestPath = join(NOISY_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `noisy fixtures missing: ${manifestPath}\nrun: ` +
        `cd services/voice-edge && ${PYTHON} -m voice_edge.make_noise_fixtures`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    clips: NoisyClip[];
    noiseSource: unknown;
    snrDefinition: string;
    measuredByDefault: string[];
  };
}

/** Deterministic offline stand-in for ASR: keeps VAD, slicing, scoring and reporting honest. */
function fakeTranscript(expected: string, wav: string): string {
  return `${expected}${wav.includes('noisy') ? '（离线模拟）' : ''}`;
}

const manifest = requireManifest();
const measured = (manifest.measuredByDefault.length > 0 ? manifest.measuredByDefault : DEFAULT_MEASURED).filter(
  (id) => id !== 'backchannel',
);
const tiers = tierFilter === null ? DEFAULT_TIERS : tierFilter.split(',').map((value) => Number(value.trim()));
const clips = manifest.clips
  .filter((clip) => measured.includes(clip.fixture))
  .filter((clip) => tiers === null || tiers.includes(Number(clip.targetSnrDb)))
  .sort((a, b) => (a.fixture === b.fixture ? b.targetSnrDb - a.targetSnrDb : a.fixture.localeCompare(b.fixture)));

const client = fake || dryRun ? null : new MimoClient();
const results: ClipResult[] = [];

async function transcribe(wav: Buffer, expected: string, path: string): Promise<{ text: string; asrMs: number }> {
  if (client === null) return { text: fakeTranscript(expected, path), asrMs: 0 };
  const started = Date.now();
  const response = await client.transcribe(wav);
  return { text: response.text, asrMs: Date.now() - started };
}

const cleanSegmentations = new Map<string, Segmentation>();
for (const fixture of measured) {
  const wavPath = join(FIXTURE_DIR, `${fixture}.wav`);
  if (!existsSync(wavPath)) throw new Error(`clean fixture missing: ${wavPath}`);
  cleanSegmentations.set(fixture, await segment(wavPath, { noiseReduction: !skipNoiseReduction, calibratedFloorDbfs: -33.24 }));
}

async function measure(args: {
  id: string;
  fixture: string;
  tier: 'clean' | string;
  wavPath: string;
  text: string;
  targetSnrDb: number | null;
  measuredSnrDb: number | null;
  calibratedFloorDbfs: number | undefined;
  noiseReferenceSamples: number;
  cleanEndMs: number | null;
  cleanStartMs: number | null;
}): Promise<ClipResult> {
  const failures: string[] = [];
  const vadStarted = Date.now();
  const segmentation = await segment(args.wavPath, {
    noiseReduction: !skipNoiseReduction,
    calibratedFloorDbfs: args.calibratedFloorDbfs,
  });
  const vadMs = Date.now() - vadStarted;
  const speech = segmentation.segments[0] ?? null;
  // The noise reference segment is a tail the fixture generator appended; the speech ends
  // where the clean version ends, so anything detected inside the tail is not the user.
  const speechEndMs = args.cleanEndMs ?? (args.wavPath.includes('noisy') ? null : segmentation.energyEndMs);
  const detectedEnd = speech === null ? null : speechEndMs === null ? speech.endMs : Math.min(speech.endMs, speechEndMs);
  let transcript: string | null = null;
  let similarity: number | null = null;
  let asrMs: number | null = null;

  if (speech === null) {
    failures.push('NO_SPEECH_DETECTED');
  } else {
    const buffer = readWav(args.wavPath);
    const span = sliceWav(buffer, speech.startMs, detectedEnd ?? speech.endMs);
    const asr = await transcribe(span, args.text, args.wavPath);
    transcript = asr.text;
    asrMs = asr.asrMs;
    similarity = characterSimilarity(asr.text, args.text);
    if (similarity < minSimilarity) failures.push(`SIMILARITY<${minSimilarity}(${similarity})`);
  }
  const endpointDelayMs = speech === null || detectedEnd === null || args.cleanEndMs === null
    ? null
    : Math.round(detectedEnd - args.cleanEndMs);
  if (endpointDelayMs !== null && endpointDelayMs > maxEndpointDelayMs) {
    failures.push(`ENDPOINT_DELAY>${maxEndpointDelayMs}ms(${endpointDelayMs})`);
  }

  // Optional A/B: the same clip with noise reduction disabled, no extra ASR call unless the
  // similarity comparison is wanted (it is: it is the only direct evidence for the NR choice).
  let similarityNoNr: number | null = null;
  if (!skipNoiseReduction && !dryRun && client !== null) {
    const plain = await segment(args.wavPath, { noiseReduction: false, calibratedFloorDbfs: args.calibratedFloorDbfs });
    const plainSpeech = plain.segments[0] ?? null;
    if (plainSpeech === null) similarityNoNr = 0;
    else {
      const span = sliceWav(readWav(args.wavPath), plainSpeech.startMs, Math.min(plainSpeech.endMs, speechEndMs ?? plainSpeech.endMs));
      const asr = await client.transcribe(span);
      similarityNoNr = characterSimilarity(asr.text, args.text);
    }
  }

  return {
    id: args.id,
    fixture: args.fixture,
    tier: args.tier,
    targetSnrDb: args.targetSnrDb,
    measuredSnrDb: args.measuredSnrDb,
    expected: args.text,
    wav: args.wavPath.replace(`${REPO_ROOT}\\`, '').replace(/\\/g, '/'),
    detected: speech !== null,
    segments: segmentation.segments.length,
    speechStartMs: speech === null ? null : speech.startMs,
    speechEndMs: detectedEnd,
    endpointDelayMs,
    bargeInDecisionMs: segmentation.bargeInDecisionMs,
    rawSpeechStartMs: segmentation.rawEnergyStartMs,
    vadStartLatencyVsCleanMs:
      speech === null || args.cleanStartMs === null ? null : Math.round(speech.startMs - args.cleanStartMs),
    noiseFloorDbfs: segmentation.frontend.noiseFloorDbfs,
    enhancedNoiseFloorDbfs: segmentation.frontend.enhancedNoiseFloorDbfs,
    gateThresholdDbfs: segmentation.frontend.gateThresholdDbfs,
    transcript,
    similarity,
    similarityNoNr,
    asrMs,
    vadMs,
    failures,
  };
}

mkdirSync(OUT_DIR, { recursive: true });

// 1) clean fixtures
for (const fixture of measured) {
  const wavPath = join(FIXTURE_DIR, `${fixture}.wav`);
  const clean = cleanSegmentations.get(fixture) as Segmentation;
  const cleanSpeech = clean.segments[0] ?? null;
  results.push(
    await measure({
      id: fixture,
      fixture,
      tier: 'clean',
      wavPath,
      text: FIXTURE_TEXTS[fixture] ?? '',
      targetSnrDb: null,
      measuredSnrDb: null,
      calibratedFloorDbfs: -33.24,
      noiseReferenceSamples: 0,
      cleanEndMs: cleanSpeech?.endMs ?? null,
      cleanStartMs: cleanSpeech?.startMs ?? null,
    }),
  );
}

// 2) noisy tiers, using the clean run's speech end as the endpoint reference
for (const clip of clips) {
  const clean = cleanSegmentations.get(clip.fixture) as Segmentation;
  const cleanSpeech = clean.segments[0] ?? null;
  results.push(
    await measure({
      id: clip.id,
      fixture: clip.fixture,
      tier: `${clip.targetSnrDb}dB`,
      wavPath: join(REPO_ROOT, clip.path),
      text: clip.text,
      targetSnrDb: clip.targetSnrDb,
      measuredSnrDb: clip.measuredSnrDb,
      calibratedFloorDbfs: clip.conditionedNoiseFloorDbfs,
      noiseReferenceSamples: clip.noiseReferenceSamples,
      cleanEndMs: cleanSpeech?.endMs ?? null,
      cleanStartMs: cleanSpeech?.startMs ?? null,
    }),
  );
}

// 3) aggregate per tier → the reproducible boundary
interface TierSummary {
  tier: string;
  clips: number;
  detected: number;
  detectionRate: number;
  meanSimilarity: number | null;
  minSimilarity: number | null;
  meanEndPointDelayMs: number | null;
  meanVadStartLatencyMs: number | null;
  meanSimilarityNoNr: number | null;
  failures: number;
  verdict: 'PASS' | 'FAIL';
}

const tierNames = ['clean', ...Array.from(new Set(clips.map((clip) => `${clip.targetSnrDb}dB`))).sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a))];
const mean = (values: (number | null)[]): number | null => {
  const usable = values.filter((value): value is number => value !== null);
  if (usable.length === 0) return null;
  return Number((usable.reduce((sum, value) => sum + value, 0) / usable.length).toFixed(3));
};

const summaries: TierSummary[] = tierNames.map((tier) => {
  const rows = results.filter((row) => row.tier === tier);
  const detected = rows.filter((row) => row.detected).length;
  const failures = rows.filter((row) => row.failures.length > 0).length;
  const meanSimilarity = mean(rows.map((row) => row.similarity));
  return {
    tier,
    clips: rows.length,
    detected,
    detectionRate: rows.length === 0 ? 0 : Number((detected / rows.length).toFixed(3)),
    meanSimilarity,
    minSimilarity: mean(rows.map((row) => row.similarity)),
    meanEndPointDelayMs: mean(rows.map((row) => row.endpointDelayMs)),
    meanVadStartLatencyMs: mean(rows.map((row) => row.vadStartLatencyVsCleanMs)),
    meanSimilarityNoNr: mean(rows.map((row) => row.similarityNoNr)),
    failures,
    verdict: failures === 0 ? 'PASS' : 'FAIL',
  };
});

const failing = results.filter((row) => row.failures.length > 0);
const passingTiers = summaries.filter((summary) => summary.tier !== 'clean' && summary.verdict === 'PASS');
const boundary = passingTiers.length > 0
  ? Math.min(...passingTiers.map((summary) => Number.parseFloat(summary.tier)))
  : null;

/**
 * Offline runs cannot judge quality (the ASR is a stub), so the failure codes are split:
 * similarity / detection are observations, everything else (endpoint delay, and any future
 * structural check) still has to hold. This is what keeps `--fake` from reporting a false
 * "broken" while also keeping it from being a rubber stamp.
 */
const offline = fake || dryRun;
const QUALITY_ONLY_OFFLINE = /^(SIMILARITY<|NO_SPEECH_DETECTED)/;
const qualityOnlyFailures = offline ? failing.filter((row) => row.failures.every((code) => QUALITY_ONLY_OFFLINE.test(code))) : [];
const structuralFailures = offline ? failing.filter((row) => row.failures.some((code) => !QUALITY_ONLY_OFFLINE.test(code))) : failing;
const detectedClips = results.filter((row) => row.detected).length;
const pipelineOk = results.length > 0 && structuralFailures.length === 0;
const exitCode = offline ? (pipelineOk ? 0 : 1) : failing.length > 0 ? 1 : 0;

const report = {
  seed: {
    fakeAsr: fake,
    dryRun,
    noiseReduction: !skipNoiseReduction,
    minSimilarity,
    maxEndpointDelayMs,
    tiers: tiers ?? 'all',
    fixtures: measured,
    snrDefinition: manifest.snrDefinition,
    noiseSource: manifest.noiseSource,
    python: PYTHON,
  },
  /** Which criteria a reader may apply to this run. Offline runs apply far fewer. */
  mode: offline ? 'offline-plumbing' : 'real-asr',
  /**
   * The run verdict, and it always agrees with the exit code: PASS/FAIL for real ASR,
   * PIPELINE-OK/PIPELINE-BROKEN offline. Nobody can read a bare "FAIL" out of an offline
   * run and conclude the feature is broken.
   */
  verdict: offline ? (pipelineOk ? 'PIPELINE-OK' : 'PIPELINE-BROKEN') : failing.length === 0 ? 'PASS' : 'FAIL',
  /**
   * The noise-robustness verdict — the one the real-ASR run judges. Offline it is still
   * computed and reported, but `applies` is false and the run verdict above is what the
   * exit code follows.
   */
  quality: {
    verdict: failing.length === 0 ? 'PASS' : 'FAIL',
    applies: !offline,
    failingClips: failing.length,
    measuredClips: results.length,
    threshold: minSimilarity,
    why: offline
      ? '相似度判据在离线模式下不适用：ASR 是确定性桩，转写文本与期望文本必然不同，所以这里不会是 PASS，但它不代表功能坏了'
      : '真实 MiMo ASR 的转写与夹具原文做字符级相似度比较（≥ 阈值即通过）',
  },
  criteria: {
    transcriptSimilarity: offline
      ? {
          applies: false,
          threshold: minSimilarity,
          why: '相似度判据在离线模式下不适用：ASR 被替换为确定性桩，转写文本与期望文本必然不同，所以 SIMILARITY / NO_SPEECH_DETECTED 只作为观察记录，不代表功能坏了',
        }
      : { applies: true, threshold: minSimilarity, why: '真实 MiMo ASR 的转写与夹具原文做字符级相似度比较' },
    speechDetection: offline
      ? { applies: false, why: '离线模式只记录检出/未检出，不据此判定；真实检出率请跑真实 ASR 模式' }
      : { applies: true, why: '真实 ASR 模式下列 1（没有语音段）算失败' },
    endpointDelay: { applies: true, maxMs: maxEndpointDelayMs, why: '端点延迟是 VAD 的属性，不依赖 ASR，所以离线模式同样必须成立' },
    tierBoundary: offline
      ? { applies: false, why: 'SNR 边界由相似度决定，离线模式下没有意义' }
      : { applies: true, why: '某一档全部失败即判定该档不过，成功边界取最高的通过档' },
  },
  offlineSummary: offline
    ? {
        verdict: pipelineOk ? 'PIPELINE-OK' : 'PIPELINE-BROKEN',
        notAQualityVerdict: true,
        qualityCriterionApplies: false,
        measuredClips: results.length,
        detectedClips,
        notDetectedClips: results.length - detectedClips,
        qualityOnlyFailureClips: qualityOnlyFailures.length,
        structuralFailureClips: structuralFailures.length,
        qualityOnlyFailures: qualityOnlyFailures.map((row) => ({ id: row.id, tier: row.tier, failures: row.failures })),
        structuralFailures: structuralFailures.map((row) => ({ id: row.id, tier: row.tier, failures: row.failures })),
        nextStep: '要判定噪声鲁棒性（相似度边界），请跑真实 ASR：npm run voice:noise（会花钱）',
        verdictRule: '离线判定 = 至少测到 1 条夹具 且 没有结构性问题（端点延迟超限等）；相似度/检出率只记录，不判定',
      }
    : null,
  boundary: {
    claim: `${offline ? '（离线模式：以下边界只用桩 ASR 计算，不代表真实噪声鲁棒性）' : ''}${
      boundary === null
        ? 'no SNR tier passed with the current thresholds; see failures'
        : `SNR_inband ≥ ${boundary} dB 时，干净/噪声夹具的平均字符相似度 ≥ ${minSimilarity}，且没有片段漏检或超长端点`
    }`,
    lowestPassingTierDb: boundary,
    passingTiers: passingTiers.map((summary) => summary.tier),
    failingTiers: summaries.filter((summary) => summary.tier !== 'clean' && summary.verdict === 'FAIL').map((summary) => summary.tier),
  },
  tiers: summaries,
  clips: results,
  failureList: failing.map((row) => ({
    id: row.id,
    tier: row.tier,
    expected: row.expected,
    transcript: row.transcript,
    similarity: row.similarity,
    failures: row.failures,
  })),
  exitCode,
  note: offline
    ? '离线模式（--fake/--dry-run）：ASR 被替换为确定性桩。**这不是噪声鲁棒性判定**——相似度判据在离线模式下不适用（见 criteria.transcriptSimilarity），离线的 SIMILARITY/NO_SPEECH_DETECTED 只作观察；只要管线跑通（≥1 条夹具 + 无端点延迟类结构性问题）就以 exit 0 结束。真实转写与真实边界需要去掉 --fake/--dry-run。'
    : '真实 MiMo ASR（mimo-v2.5-asr）；只有 VAD 检测到的语音段被上传（§20.1）',
};

writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
printEvidence('噪声鲁棒性验证（干净 + 噪声夹具 → 前端 → VAD → ASR）', report);

if (offline) {
  if (!pipelineOk) {
    console.error(`\n离线模式（--fake/--dry-run）判定：管线未跑通 → exit 1`);
    console.error(`  测量 ${results.length} 条夹具，其中结构性问题 ${structuralFailures.length} 条（相似度类不算）：`);
    for (const row of structuralFailures.slice(0, 10)) console.error(`   - ${row.id} [${row.tier}] ${row.failures.join(', ')}`);
    if (results.length === 0) console.error('   - 一条夹具都没测到：检查 --tiers / manifest。measuredByDefault');
    console.error(`  结构性问题不受离线模式豁免（端点延迟是 VAD 属性，不依赖 ASR），必须修。`);
    process.exit(1);
  }
  console.log(`\n离线模式（--fake/--dry-run）结论：管线已跑通 → exit 0`);
  console.log(`  这不是「噪声鲁棒性判定」：相似度判据在离线模式下不适用（ASR 是确定性桩，转写与期望文本必然不同）。`);
  console.log(`  本次测量 ${results.length} 条夹具：检出语音 ${detectedClips} 条、未检出 ${results.length - detectedClips} 条（只记录，不判定）；`);
  console.log(`  质量类记录 ${qualityOnlyFailures.length} 条（同样不算失败，逐条见报告 offlineSummary.qualityOnlyFailures）；`);
  console.log(`  结构性问题（端点延迟 > ${maxEndpointDelayMs}ms 等）0 条。`);
  console.log(`  ${report.offlineSummary?.nextStep ?? ''}`);
  process.exit(0);
}

if (failing.length > 0) {
  console.error(`\n噪声鲁棒性验证 FAILED：${failing.length} 条夹具未通过（详见 failureList）`);
  process.exit(1);
}
console.log(`\n噪声鲁棒性验证 PASS：${results.length} 条夹具全部通过；成功边界 ${report.boundary.claim}`);
