/**
 * Offline tests for the noise-robust voice front end.
 *
 * The DSP is Python (`services/voice-edge/voice_edge/frontend.py`) because the VAD and the
 * recorder are; this file makes it part of `npm test` by running that module's own unittest
 * suite and then asserting the *published artefacts* (noisy fixtures, manifest, calibration
 * JSON) are internally consistent. No microphone, no network, no VAD model is needed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
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

test('front-end DSP unit tests pass (python, services/voice-edge/tests)', { skip: !pythonAvailable && 'voice-pipecat venv not present' }, () => {
  const result = spawnSync(PYTHON, ['-m', 'unittest', 'discover', '-s', 'tests'], {
    cwd: VOICE_EDGE,
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  assert.equal(result.status, 0, `python unittest failed:\n${result.stdout}\n${result.stderr}`);
  // The suite must actually run something: a silent "0 tests" would otherwise pass.
  assert.match(result.stderr, /Ran (\d+) tests?/, 'no python tests ran');
  const ran = Number(/Ran (\d+) tests?/.exec(result.stderr)?.[1] ?? '0');
  assert.ok(ran >= 30, `expected at least 30 python tests, got ${ran}`);
});

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

test('verification script fails loudly when an SNR tier has no passing clips', () => {
  // The boundary is only meaningful if the runner treats a fully failing tier as a failure:
  // a report that averages a total miss into a pass would hide the documented limit.
  const runner = readFileSync(join(REPO_ROOT, 'scripts', 'verify-voice-noise.ts'), 'utf8');
  assert.match(runner, /verdict: failing\.length === 0 \? 'PASS' : 'FAIL'/);
  assert.match(runner, /process\.exit\(1\)/);
  assert.match(runner, /failureList/);
  assert.match(runner, /NO_SPEECH_DETECTED/);
});
