/**
 * Offline tests for the noise-robust voice front end.
 *
 * The DSP is Python (`services/voice-edge/voice_edge/frontend.py`) because the VAD and the
 * recorder are; this file makes it part of `npm test` by running that module's own unittest
 * suite and then asserting the *published artefacts* (noisy fixtures, manifest, calibration
 * JSON) are internally consistent. No microphone, no network, no VAD model is needed.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { characterSimilarity, FIXTURE_TEXTS, normaliseForComparison } from '../../../scripts/lib/similarity.ts';
import { readWav, readWavInfo } from '../../../scripts/lib/wav.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const PYTHON = process.env.XIXI_PYTHON ?? join(REPO_ROOT, '.venvs', 'voice-pipecat', 'Scripts', 'python.exe');
const VOICE_EDGE = join(REPO_ROOT, 'services', 'voice-edge');
const NOISY_DIR = join(REPO_ROOT, 'tests', 'audio-fixtures', 'noisy');
const manifestPath = join(NOISY_DIR, 'manifest.json');

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

interface NoisyManifest {
  snrDefinition: string;
  snrStepsDb: number[];
  noiseSource: { path: string; noiseFloorDbfs: number };
  measuredByDefault: string[];
  clips: NoisyClip[];
}

function loadManifest(): NoisyManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as NoisyManifest;
}

const pythonAvailable = existsSync(PYTHON);

test('noisy fixture set covers >= 3 SNR tiers with a recorded generation method', () => {
  assert.ok(existsSync(manifestPath), 'tests/audio-fixtures/noisy/manifest.json is missing');
  const manifest = loadManifest();
  assert.ok(manifest.snrStepsDb.length >= 3, `need >= 3 SNR tiers, got ${manifest.snrStepsDb.length}`);
  assert.match(manifest.snrDefinition, /300-3400/, 'the SNR definition must name the band it is measured in');
  assert.ok(manifest.clips.length >= 3 * Object.keys(FIXTURE_TEXTS).length - 5);
});

test('every noisy clip exists, has a measured SNR and holds the declared noise floor', () => {
  const manifest = loadManifest();
  for (const clip of manifest.clips) {
    const path = join(REPO_ROOT, clip.path);
    assert.ok(existsSync(path), `${clip.id}: missing file ${clip.path}`);
    assert.equal(clip.targetSnrDb, clip.measuredSnrDb, `${clip.id}: requested SNR not achieved (${clip.measuredSnrDb})`);
    assert.ok(clip.noiseReferenceSamples > 16_000, `${clip.id}: noise reference segment is too short to measure`);
    const info = readWavInfo(readWav(path));
    const totalSamples = Math.round((info.durationMs / 1000) * info.sampleRate);
    assert.ok(
      totalSamples > clip.noiseReferenceSamples,
      `${clip.id}: clip must contain speech plus the noise reference`,
    );
    // The trailing noise-only segment is the floor reference; it must be a plausible level
    // (a digital-silence tail would mean the generator lost the noise).
    assert.ok(clip.conditionedNoiseFloorDbfs > -80 && clip.conditionedNoiseFloorDbfs < -5, `${clip.id}: implausible floor`);
  }
});

test('hard clips are kept, not deleted (the failing SNR tier must still be on disk)', () => {
  const manifest = loadManifest();
  const lowest = Math.min(...manifest.snrStepsDb);
  const hard = manifest.clips.filter((clip) => clip.targetSnrDb === lowest);
  assert.ok(hard.length >= 4, `the ${lowest} dB tier must keep all its clips as documented boundary evidence`);
  for (const clip of hard) {
    assert.ok(existsSync(join(REPO_ROOT, clip.path)), `${clip.id} was deleted — boundary samples must stay`);
  }
});

test('the fixture text table matches the clean fixtures on disk', () => {
  for (const id of Object.keys(FIXTURE_TEXTS)) {
    assert.ok(existsSync(join(REPO_ROOT, 'tests', 'audio-fixtures', `${id}.wav`)), `${id}.wav missing`);
  }
});

test('similarity scoring is character-level and punctuation-insensitive', () => {
  assert.equal(characterSimilarity('明天天气怎么样？', '明天天气怎么样'), 1);
  assert.equal(characterSimilarity('今天天气怎么样', '明天天气怎么样'), 0.857);
  assert.equal(characterSimilarity('', ''), 1);
  assert.equal(characterSimilarity('', '有内容'), 0);
  assert.equal(normaliseForComparison('西西，明天 天气！'), '西西明天天气');
});

/**
 * Behavioural checks for the verification runner and the calibration contract.
 *
 * These used to grep `scripts/verify-voice-noise.ts` for literal source text
 * (`verdict: failing.length === 0 ? 'PASS' : 'FAIL'`). That is a rename tripwire, not a test:
 * it went red when the runner's variables were renamed even though the behaviour was correct,
 * and it would have stayed green if the behaviour broke while the literal survived. The runner
 * is now executed and its observable results (exit code + the JSON report it writes) are
 * asserted instead.
 */

interface VerifyReport {
  mode: string;
  verdict: string;
  exitCode: number;
  quality: { verdict: string; applies: boolean; failingClips: number; measuredClips: number };
  criteria: Record<string, { applies: boolean }>;
  offlineSummary: { structuralFailureClips: number; qualityOnlyFailureClips: number; detectedClips: number } | null;
  boundary: { lowestPassingTierDb: number | null; claim: string };
  /**
   * Per-tier summaries (`TierSummary` in the runner): one row per measured tier, `clean` included.
   * The test reads `tier` / `verdict`; the runner's row carries more counters, which are not asserted
   * here (the report is read from JSON, so this is a partial view rather than the full shape).
   */
  tiers: { tier: string; verdict: string }[];
  clips: { id: string; tier: string; detected: boolean; failures: string[]; transcript: string | null; similarity: number | null; endpointDelayMs: number | null; vadEndpointDelayMs: number | null }[];
  failureList: { id: string; failures: string[] }[];
}

/**
 * Runs the real runner once per distinct argument set.
 *
 * Two deliberate choices, both about the default gate's wall time (it used to be ~53 s):
 *
 * 1. **Async, memoised.** The runner is spawned with `spawn` (not `spawnSync`) so the three
 *    behaviour checks below can overlap, and identical argument sets share one process. Each
 *    invocation costs ~3.4 s per fixture (Python + pipecat + Silero load), so overlapping the
 *    runs is the difference between ~46 s and ~17 s of the file's dominated cost.
 * 2. **Smallest input that still exercises the path.** The runner always measures the clean
 *    fixtures, so `--tiers` is the only lever the test has: `999` selects no noisy tier
 *    (4 fixtures), `18` adds exactly one tier (8 fixtures). Assertions are unchanged — only
 *    the number of clips each one sees.
 */
const verificationRuns = new Map<string, Promise<{ status: number | null; report: VerifyReport }>>();

function runVerification(options: { tiers?: string; extraArgs?: string[] } = {}): Promise<{ status: number | null; report: VerifyReport }> {
  const tiers = options.tiers ?? '18';
  const extraArgs = options.extraArgs ?? [];
  const key = `${tiers}|${extraArgs.join(' ')}`;
  const cached = verificationRuns.get(key);
  if (cached !== undefined) return cached;
  const promise = new Promise<{ status: number | null; report: VerifyReport }>((resolve, reject) => {
    const outDir = mkdtempSync(join(tmpdir(), 'xixi-verify-noise-'));
    const outPath = join(outDir, 'report.json');
    // The tier list is a parameter (not an override) because the runner's `argValue` takes
    // the *first* occurrence of a flag.
    const child = spawn(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts', 'verify-voice-noise.ts'),
        '--fake',
        '--tiers',
        tiers,
        '--out',
        outPath,
        ...extraArgs,
      ],
      { cwd: REPO_ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      try {
        assert.ok(existsSync(outPath), `runner wrote no report (status ${status}):\n${stdout}\n${stderr}`);
        resolve({ status, report: JSON.parse(readFileSync(outPath, 'utf8')) as VerifyReport });
      } catch (error) {
        reject(error);
      }
    });
  });
  verificationRuns.set(key, promise);
  return promise;
}

/**
 * Async `spawn` wrapper for the checks that shell out to Python.
 *
 * The gate's wall time is dominated by Python interpreter startup (pipecat + Silero load is
 * ~3 s per fixture), so these checks are started together and awaited together: the file then
 * pays the *maximum* of their durations instead of the sum. `spawnSync` would block the event
 * loop and silently serialise everything again.
 */
function runAsync(command: string, args: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function checkPythonUnittest(): Promise<void> {
  const result = await runAsync(PYTHON, ['-m', 'unittest', 'discover', '-s', 'tests'], VOICE_EDGE);
  assert.equal(result.status, 0, `python unittest failed:\n${result.stdout}\n${result.stderr}`);
  // The suite must actually run something: a silent "0 tests" would otherwise pass.
  assert.match(result.stderr, /Ran (\d+) tests?/, 'no python tests ran');
  const ran = Number(/Ran (\d+) tests?/.exec(result.stderr)?.[1] ?? '0');
  assert.ok(ran >= 30, `expected at least 30 python tests, got ${ran}`);
}

async function checkCalibrateContract(): Promise<void> {
  const outDir = mkdtempSync(join(tmpdir(), 'xixi-calibrate-'));
  const reportPath = join(outDir, 'noise-floor.json');
  const profilePath = join(outDir, 'frontend-profile.json');
  const result = await runAsync(
    PYTHON,
    [
      '-m',
      'voice_edge.calibrate',
      '--wav',
      join(REPO_ROOT, 'data', 'recon', 'ambient-5s.wav'),
      '--json-out',
      reportPath,
      '--profile-out',
      profilePath,
    ],
    VOICE_EDGE,
  );
  assert.equal(result.status, 0, `calibrate failed:\n${result.stdout}\n${result.stderr}`);

  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    params: { highpassHz: number; gateThresholdDbfs: number; gateMarginDb: number };
    applied: Record<string, unknown>;
    consistency: { defaults: { highpassHz: number }; profileOverridesDefault: { field: string }[] };
  };
  // 1) recommendation == applied: the tool no longer advises a value the front end ignores.
  assert.equal(report.applied.highpassHz, report.params.highpassHz, 'applied cutoff must equal the recommendation');
  assert.equal(report.applied.gateThresholdDbfs, report.params.gateThresholdDbfs);
  assert.equal(report.applied.gateMarginDb, report.params.gateMarginDb);
  // 2) and the recommendation is the front end's own default for this machine, not a second
  //    hard-coded number that happens to sit next to it.
  assert.equal(report.consistency.defaults.highpassHz, 120);
  assert.equal(report.params.highpassHz, report.consistency.defaults.highpassHz);
  assert.equal(
    report.consistency.profileOverridesDefault.some((entry) => entry.field === 'highpassHz'),
    false,
    'calibration must not move the cutoff away from the measured default',
  );

  // 3) the profile file is the source of truth the front end reads: load it back through the
  //    same entry point the voice path uses and require the values to survive verbatim.
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { applied: Record<string, number> };
  const load = await runAsync(
    PYTHON,
    [
      '-c',
      [
        'import json, sys',
        "sys.path.insert(0, '.')",
        'from voice_edge import frontend as fe',
        `params, origin = fe.load_calibrated_params(${JSON.stringify(profilePath)})`,
        'print(json.dumps({"source": origin["source"], "highpassHz": params.highpass_hz,',
        '  "gateThresholdDbfs": params.gate_threshold_dbfs, "gateMarginDb": params.gate_margin_db,',
        '  "suggestedCaptureGainDb": params.suggested_capture_gain_db}))',
      ].join('\n'),
    ],
    VOICE_EDGE,
  );
  assert.equal(load.status, 0, `load_calibrated_params failed:\n${load.stdout}\n${load.stderr}`);
  const adopted = JSON.parse(load.stdout) as Record<string, number | string>;
  assert.equal(adopted.source, 'profile', 'the front end must read the calibration profile when present');
  assert.equal(adopted.highpassHz, profile.applied.highpassHz);
  assert.equal(adopted.gateThresholdDbfs, profile.applied.gateThresholdDbfs);
  assert.equal(adopted.gateMarginDb, profile.applied.gateMarginDb);
  assert.equal(adopted.suggestedCaptureGainDb, profile.applied.suggestedCaptureGainDb);
}

async function checkFallbackCutoff(): Promise<void> {
  const outDir = mkdtempSync(join(tmpdir(), 'xixi-noprofile-'));
  const result = await runAsync(
    PYTHON,
    [
      '-c',
      [
        'import json, sys',
        "sys.path.insert(0, '.')",
        'from voice_edge import frontend as fe',
        `params, origin = fe.load_calibrated_params(${JSON.stringify(join(outDir, 'missing.json'))})`,
        'print(json.dumps({"source": origin["source"], "derivedFrom": origin.get("derivedFrom"),',
        '  "highpassHz": params.highpass_hz, "defaultHighpassHz": fe.DEFAULT_HIGHPASS_HZ}))',
      ].join('\n'),
    ],
    VOICE_EDGE,
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout) as Record<string, number | string>;
  assert.equal(payload.source, 'derived');
  assert.equal(payload.highpassHz, payload.defaultHighpassHz, 'the fallback cutoff must be the single DEFAULT_HIGHPASS_HZ');
  assert.equal(payload.defaultHighpassHz, 120);
}

/**
 * Every check that shells out to Python lives under this one concurrent parent, so the file pays
 * the *maximum* of their durations instead of the sum. Each assertion is unchanged from when
 * these were separate top-level tests; only the scheduling changed. Before: ~46 s of serial
 * Python; after: ~15 s (the slowest single check).
 */
test('offline voice checks that shell out to Python (run concurrently)', { concurrency: true }, async (parent) => {
  const skip = !pythonAvailable && 'voice-pipecat venv not present';
  await Promise.all([
    parent.test('front-end DSP unit tests pass (python, services/voice-edge/tests)', { skip }, checkPythonUnittest),
    parent.test('the calibrate CLI recommends exactly the parameters the front end applies (F8)', { skip }, checkCalibrateContract),
    parent.test('without a calibration profile the front end falls back to the measured default cutoff', { skip }, checkFallbackCutoff),
    parent.test('the voice-noise runner behaves correctly in offline mode (behaviour, real process)', { skip }, (runner) => runRunnerChecks(runner)),
  ]);
});

async function runRunnerChecks(parent: TestContext): Promise<void> {
  const skip = !pythonAvailable && 'voice-pipecat venv not present';
  // Started together and awaited together on purpose: each check spawns the real runner, whose
  // cost is dominated by Python startup, so running them one after another would make the whole
  // file pay the sum instead of the maximum.
  await Promise.all([
    parent.test('the runner reports an offline pipeline result and its exit code agrees with it', { skip }, async () => {
      // `--tiers 999` (no noisy tier) is the smallest input the runner accepts: it always
      // measures the clean fixtures, and the offline verdict/criteria/exit-code contract does not
      // depend on a noisy tier being present. The noisy-tier path itself is covered by
      // `npm run voice:noise` (real ASR) and by the manifest assertions above; within the default
      // gate the clean fixtures are enough to exercise every assertion below. Identical arguments
      // to the "no boundary" check below, whose report is then produced by the same process.
      const { status, report } = await runVerification({ tiers: '999' });
      // Offline the ASR is a stub, so similarity cannot be judged: the run must say so instead of
      // pretending the feature is broken, and it must not pretend it was verified either.
      assert.equal(report.mode, 'offline-plumbing');
      assert.equal(report.quality.applies, false, 'offline runs must not claim the similarity criterion applies');
      assert.equal(report.criteria.transcriptSimilarity.applies, false);
      assert.equal(report.criteria.endpointDelay.applies, true, 'endpoint delay is a VAD property and still applies');
      assert.ok(report.clips.length > 0, 'the runner must actually measure clips');
      assert.equal(report.offlineSummary?.structuralFailureClips, 0);
      // Exit code and report must agree — whichever way the verdict goes.
      assert.equal(status, report.exitCode, `exit code ${status} disagrees with report.exitCode ${report.exitCode}`);
      assert.equal(status, 0);
      assert.equal(report.verdict, 'PIPELINE-OK');
    },
    ),

    parent.test(
      'a structural failure fails the run and the report records the failure code',
      { skip },
      async () => {
        // A negative endpoint-delay budget is impossible to satisfy, so every measured clip carries
        // an ENDPOINT_DELAY failure. That is a *structural* failure, which the offline path does not
        // exempt (it exempts similarity only) — so the run must exit non-zero and the report must say
        // why. This is the exit-code rule, asserted through observable behaviour. `--tiers 6` keeps
        // it to one noisy tier (4 clips) plus the clean fixtures, and the same report also feeds the
        // untruncated-VAD-endpoint-delay check below, so the noisy tier costs one process, not two.
        const { status, report } = await runVerification({ tiers: '6', extraArgs: ['--max-endpoint-delay', '-1'] });
        assert.equal(report.mode, 'offline-plumbing');
        assert.ok((report.offlineSummary?.structuralFailureClips ?? 0) > 0, 'expected structural failures');
        assert.ok(
          report.failureList.some((row) => row.failures.some((code) => code.startsWith('ENDPOINT_DELAY>'))),
          `expected an ENDPOINT_DELAY failure code, got ${JSON.stringify(report.failureList)}`,
        );
        assert.equal(report.verdict, 'PIPELINE-BROKEN');
        assert.equal(report.exitCode, 1);
        assert.equal(status, 1, 'a structurally broken run must exit non-zero');
      },
    ),

    parent.test(
      'the noisy tier records a real (untruncated) VAD endpoint delay (t23 regression)',
      { skip },
      async () => {
        // t23 fixed a criterion that was structurally unreachable: `ENDPOINT_DELAY > max` used to be
        // measured against `min(speech.endMs, cleanEndMs)`, which is ≤ 0 by construction, so no run
        // could ever fail it. The criterion now uses the untruncated `vadEndpointDelayMs`
        // (`speech.endMs − energyEndMs`). This check is what keeps that fix from dying silently: the
        // values below are the *unclamped* ones, and they only exist because a noisy clip's speech
        // really does run past the clean speech end.
        const { report } = await runVerification({ tiers: '6', extraArgs: ['--max-endpoint-delay', '-1'] });
        const noisy = report.clips.filter((clip) => clip.tier === '6dB');
        assert.equal(noisy.length, 4, `expected the 4 measured fixtures in the 6 dB tier, got ${noisy.length}`);
        const delays = noisy.map((clip) => clip.vadEndpointDelayMs);
        assert.ok(delays.every((value) => value !== null), `every 6 dB clip must report a VAD endpoint delay, got ${JSON.stringify(delays)}`);
        const values = delays as number[];
        assert.ok(
          Math.min(...values) >= 500,
          `the untruncated delay must be a real measurement, not the old clamped ~0: ${JSON.stringify(values)}`,
        );
        assert.ok(
          Math.max(...values) < 1500,
          `these fixtures must stay inside the default 1500 ms budget (so the tier passes by default): ${JSON.stringify(values)}`,
        );
        // And the clamped slicing field really is ≈0 for the same clips — that is exactly why the
        // criterion needed its own field.
        assert.ok(
          noisy.every((clip) => clip.endpointDelayMs !== null && clip.endpointDelayMs <= 0),
          `the ASR-slice delay stays clamped at <= 0 (that was the dead-code defect): ${JSON.stringify(noisy.map((clip) => clip.endpointDelayMs))}`,
        );
        // The failure code must carry the untruncated value, i.e. the criterion reads this field.
        for (const [index, clip] of noisy.entries()) {
          const code = clip.failures.find((failure) => failure.startsWith('ENDPOINT_DELAY>'));
          assert.ok(code !== undefined, `${clip.id}: expected an ENDPOINT_DELAY failure with an impossible budget`);
          assert.match(code, new RegExp(`^ENDPOINT_DELAY>-1ms\\(${values[index]}\\)$`), `${clip.id}: the code must quote the untruncated delay (${code})`);
        }
      },
    ),

    parent.test(
      'a tier that selects no clips is reported as no boundary, not as a pass for that tier',
      { skip },
      async () => {
        // No noisy tier matches. The clean fixtures are still measured, but no SNR boundary can be
        // claimed — a runner that averaged over an empty tier set, or that reported the previous
        // boundary, would hide the fact that nothing was tested.
        const { report } = await runVerification({ tiers: '999' });
        assert.ok(report.clips.length > 0, 'the clean fixtures are measured regardless of the tier filter');
        assert.ok(report.clips.every((clip) => clip.id.length > 0));
        const noisyTiers = report.tiers.filter((tier) => tier.tier !== 'clean');
        assert.equal(noisyTiers.length, 0, `no noisy tier should be measured, got ${JSON.stringify(noisyTiers)}`);
        assert.equal(report.boundary.lowestPassingTierDb, null, 'no measured tier means no claimed boundary');
        assert.equal(report.verdict, 'PIPELINE-OK');
      },
    ),
  ]);
}

