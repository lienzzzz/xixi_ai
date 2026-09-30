/**
 * t103: 「摄像头交不出画面（不是房间没人）」.
 *
 * The failure this pins: a camera that delivers nothing (lens covered, privacy switch off, another
 * program holding the device, unplugged) looked exactly like an empty room on the page, so a user
 * read 「没人」 as a fact about their home. The console now names the state, gives the three checks
 * that actually fix it, prints the frame-probe command, and stops claiming anything about the room
 * while the picture is missing.
 *
 * Run: `npm run test:console` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CAMERA_PROBLEM_GRACE_MS,
  CAMERA_PROBE_COMMAND,
  CAMERA_PROBLEM_STEPS,
  CAMERA_PROBLEM_TITLE,
  LiveSensors,
  buildFieldPage,
  createFakeProbeRunner,
  createFieldServer,
  readCalibration,
  retentionPolicy,
} from '../../scripts/field-test.ts';
import { loadConfig } from '../../scripts/lib/harness.ts';
import { CAMERA_UNAVAILABLE_LINE, fakeLiveRunner, frameLine } from './live-camera-fixture.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A sensors object whose clock the test controls, so the grace window is testable. */
function sensorsAt(nowMs: () => number): { readonly sensors: LiveSensors; readonly child: ReturnType<typeof fakeLiveRunner> } {
  const child = fakeLiveRunner();
  const sensors = new LiveSensors({ runner: child.runner, presenceDbPath: () => 'x.sqlite', cameraIndex: () => 0, now: () => new Date(nowMs()), log: () => {} });
  return { sensors, child };
}

test('the console names the three ways a camera fails to deliver a picture (t103)', () => {
  let now = Date.parse('2026-09-30T16:20:00+08:00');
  const { sensors, child } = sensorsAt(() => now);

  // Nothing has been started: that is 「未启用」, not a fault.
  assert.equal(sensors.cameraProblem(), null);

  sensors.start({ source: 'camera' });
  assert.equal(sensors.cameraProblem(), null, 'just started: give it the grace window first');

  now += CAMERA_PROBLEM_GRACE_MS + 500;
  const noFrames = sensors.cameraProblem();
  assert.equal(noFrames?.kind, 'no-frames', `running for ${CAMERA_PROBLEM_GRACE_MS}ms without a frame is a camera problem`);
  assert.equal(noFrames?.title, CAMERA_PROBLEM_TITLE);
  assert.deepEqual(noFrames?.steps, [...CAMERA_PROBLEM_STEPS]);
  assert.equal(noFrames?.steps.length, 3);
  assert.equal(noFrames?.command, CAMERA_PROBE_COMMAND);

  // Frames arrive but carry no picture (a black/blank grab): still not 「没人」.
  child.push(frameLine({ width: 480, height: 360, bytes: 0, jpeg: null }));
  const empty = sensors.cameraProblem();
  assert.equal(empty?.kind, 'empty-frames');
  assert.equal(empty?.title, CAMERA_PROBLEM_TITLE);

  // A real picture clears it.
  child.push(frameLine({ width: 480, height: 360, bytes: 9000, index: 4 }));
  assert.equal(sensors.cameraProblem(), null, 'a frame with a picture means the camera is fine');

  // The child says the camera itself is the problem.
  child.pushError(CAMERA_UNAVAILABLE_LINE);
  const unavailable = sensors.cameraProblem();
  assert.equal(unavailable?.kind, 'unavailable');
  assert.equal(unavailable?.childNote, CAMERA_UNAVAILABLE_LINE, 'the child’s own words are kept');
  assert.match(String(unavailable?.note), /不等于「房间没人」/);

  // …or it exits with the perception edge's "no camera" code (2) even without a sentence.
  const other = sensorsAt(() => now);
  other.sensors.start({ source: 'camera' });
  other.child.exit(2);
  assert.equal(other.sensors.cameraProblem()?.kind, 'unavailable', 'exit code 2 is the edge saying "no camera"');

  // A clean stop is not a camera problem.
  const stopped = sensorsAt(() => now);
  stopped.sensors.start({ source: 'camera' });
  stopped.child.push(frameLine({ width: 480, height: 360, bytes: 9000 }));
  stopped.child.exit(0);
  assert.equal(stopped.sensors.cameraProblem(), null);
});

test('the page carries the block, the three steps and the probe command (t103)', () => {
  const page = buildFieldPage({
    listen: '127.0.0.1:8792',
    offline: false,
    ttsEnabled: true,
    modelConfigured: true,
    calibration: readCalibration('nope.json'),
    policy: retentionPolicy(loadConfig()),
    databasePath: join('data', 'field-test'),
  });
  for (const marker of ['id="px-cam-problem"', 'id="px-cam-problem-title"', 'id="px-cam-problem-steps"', 'id="px-cam-problem-command"', 'id="px-cam-problem-raw"']) {
    assert.ok(page.includes(marker), `the camera-problem block is missing ${marker}`);
  }
  assert.ok(page.includes(CAMERA_PROBLEM_TITLE), 'the title is in the HTML');
  assert.equal(CAMERA_PROBE_COMMAND, 'python -m perception_edge.run --probe-frames 10', 'the command is the one the engine really supports');
  assert.match(page, /function pxCamProblem\(/, 'and the renderer exists');
  assert.match(page, /px-cam-problem-command/, 'which fills the command element from the payload');
  assert.match(page, /未知（摄像头交不出画面，不是「没人」）/, 'the headline wording is explicit');
  assert.ok(!CAMERA_PROBLEM_TITLE.includes('**') && !CAMERA_PROBLEM_STEPS.join('').includes('**'), 'the block is plain text (it goes into JSON too)');
  // It sits in the sensors column, next to the picture.
  const sensors = page.slice(page.indexOf('id="col-sensors"'), page.indexOf('id="col-config"'));
  assert.ok(sensors.includes('id="px-cam-problem"') && sensors.includes('id="px-cam"'));
});

test('with a broken camera the API never reports 「没人」, and with a working one it does (t103)', { timeout: 60_000 }, async () => {
  const root = tempDir('xixi-t103-http-');
  const live = fakeLiveRunner();
  const handle = await createFieldServer({
    port: 0,
    offline: true,
    ttsEnabled: false,
    voiceDir: join(root, 'voice'),
    dataDir: join(root, 'data'),
    presenceDataDir: join(root, 'presence'),
    reportDir: join(root, 'recon'),
    autoPrune: false,
    probeRunner: createFakeProbeRunner(),
    liveRunner: live.runner,
    log: () => {},
  });
  const post = async (path: string, body: unknown): Promise<Record<string, any>> =>
    (await (await fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json()) as Record<string, any>;
  try {
    await post('/api/field/live', { action: 'start', intervalMs: 30_000 });

    // Healthy first: a frame with a picture → no problem block, and the presence card is the
    // projection's own reading.
    live.push(frameLine({ width: 480, height: 360, bytes: 9000 }));
    let state = (await (await fetch(`${handle.url}/api/field/state`)).json()) as Record<string, any>;
    assert.equal(state.cameraProblem, null);
    assert.equal(state.presence.overriddenByCameraProblem, undefined);

    // Now the child says the camera is unusable.
    live.pushError(CAMERA_UNAVAILABLE_LINE);
    const livePayload = (await (await fetch(`${handle.url}/api/field/live`)).json()) as Record<string, any>;
    assert.equal(livePayload.cameraProblem.kind, 'unavailable');
    assert.equal(livePayload.cameraProblem.title, CAMERA_PROBLEM_TITLE);
    assert.deepEqual(livePayload.cameraProblem.steps, [...CAMERA_PROBLEM_STEPS]);
    assert.equal(livePayload.cameraProblem.command, CAMERA_PROBE_COMMAND);

    state = (await (await fetch(`${handle.url}/api/field/state`)).json()) as Record<string, any>;
    assert.equal(state.cameraProblem.kind, 'unavailable', 'the state payload carries it too (a reload must show it)');
    assert.equal(state.presence.overriddenByCameraProblem, true);
    assert.match(String(state.presence.text), /^未知（摄像头交不出画面/);
    assert.ok(!String(state.presence.text).includes('没人在场'), 'the API must not claim the room is empty');
    assert.ok(!String(state.presence.text).includes('没人'), 'nor imply it in any other wording');
    assert.match(String(state.presence.note), /不是房间没人/);
    // The projection's own fields stay visible, so nothing is hidden by the override.
    assert.ok(state.presence.present === null || typeof state.presence.present === 'boolean', 'the raw reading is still there');
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
