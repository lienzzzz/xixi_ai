/**
 * t88: the console's 「看一眼」 button — one still frame, on demand, with an audit record.
 *
 * These tests drive the whole HTTP path with an injected brain (so nothing is uploaded anywhere)
 * and a fake camera child (so no device is opened), and they check the three guarantees rather
 * than the happy path alone: **manual by default**, **every upload recorded without the picture**,
 * and **nothing persisted / nothing continuous**.
 *
 * Run: `npm run test:console` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { openXixiStore } from '@xixi/domain';

import {
  LOOK_ONCE_MAX_WIDTH,
  LOOK_ONCE_SERVICE,
  LiveSensors,
  VISION_NOTICE,
  buildFieldPage,
  createFakeProbeRunner,
  createFieldServer,
  lookOnceHistory,
  persistVisionSettings,
  readCalibration,
  recordLookOnce,
  restoreVisionSettings,
  retentionPolicy,
} from '../../scripts/field-test.ts';
import { loadConfig } from '../../scripts/lib/harness.ts';
import { fakeLiveRunner, frameLine } from './live-camera-fixture.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const JPEG_BASE64 = 'ZmFrZS1qcGVnLWJ5dGVz';

/** A brain that records what it was sent and answers like a model that looked. */
function recordingBrain(): { readonly adapter: FakeBrainAdapter; readonly calls: { images?: readonly { mediaType: string; base64: string }[]; text: string }[] } {
  const calls: { images?: readonly { mediaType: string; base64: string }[]; text: string }[] = [];
  const adapter = new FakeBrainAdapter({
    provider: 'fake-vision',
    model: 'fake-vision-1',
    reply: (input) => {
      calls.push({ images: input.images, text: input.text });
      return { action: 'SPEAK', text: '画面里有一个白色的信箱。' };
    },
  });
  return { adapter, calls };
}

test('the frame handed to the brain is the newest one, JPEG, and never wider than the cap (t88)', () => {
  const root = tempDir('xixi-t88-frame-');
  const live = fakeLiveRunner();
  const sensors = new LiveSensors({ runner: live.runner, presenceDbPath: () => join(root, 'p'), cameraIndex: () => 0, log: () => {} });
  try {
    const empty = sensors.imageInput(LOOK_ONCE_MAX_WIDTH);
    assert.ok('refused' in empty, 'without a frame there is nothing to send');
    assert.match(empty.refused, /还没有画面/);

    sensors.start({ source: 'camera' });
    live.push(frameLine({ width: 480, height: 360, bytes: 9000 }));
    const ok = sensors.imageInput(LOOK_ONCE_MAX_WIDTH);
    assert.ok(!('refused' in ok), 'a 480px frame is accepted');
    assert.equal(ok.mediaType, 'image/jpeg');
    assert.equal(ok.base64, JPEG_BASE64, 'the data-URL prefix is stripped: the seam wants bare base64');
    assert.equal(ok.bytes, 9000);

    // A newer frame replaces it: only the *current* picture is ever sent.
    live.push(frameLine({ width: 480, height: 360, bytes: 12000 }).replace('"frame_index":3', '"frame_index":4'));
    const newer = sensors.imageInput(LOOK_ONCE_MAX_WIDTH);
    assert.ok(!('refused' in newer));
    assert.equal(newer.bytes, 12000);

    // Too wide → refused with a Chinese reason instead of uploading a bigger picture.
    live.push(frameLine({ width: 640, height: 480, bytes: 30000 }).replace('"frame_index":3', '"frame_index":5'));
    const wide = sensors.imageInput(480);
    assert.ok('refused' in wide);
    assert.match(wide.refused, /超过上限 480px/);
    assert.match(wide.refused, /不会偷偷放大\/缩小/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('an upload is recorded with time/size/trigger and no image bytes (t88)', () => {
  const root = tempDir('xixi-t88-audit-');
  const store = openXixiStore({ dataDir: root });
  try {
    const record = recordLookOnce(store, { trigger: 'manual', width: 480, height: 360, bytes: 9000, question: '画面里有什么？', outcome: 'SPEAK' });
    assert.equal(record.trigger, 'manual');
    assert.equal(record.width, 480);
    assert.equal(record.bytes, 9000);
    assert.equal(record.outcome, 'SPEAK');
    assert.ok(record.sequence !== null, 'the record is an event in the log');

    const events = store.readEvents({ type: 'system.health', limit: 10 }).filter((event) => (event.payload as { service?: string }).service === LOOK_ONCE_SERVICE);
    assert.equal(events.length, 1);
    const detail = String((events[0]?.payload as { detail?: string }).detail ?? '');
    assert.ok(detail.includes('"trigger":"manual"'), 'the trigger is recorded');
    assert.ok(detail.includes('"bytes":9000'), 'the size is recorded');
    assert.ok(!detail.includes('base64'), 'the record never carries the image');
    assert.ok(!detail.includes(JPEG_BASE64), 'and of course not its bytes either');
    assert.ok(detail.length < 500, 'and it fits the system.health detail cap');

    const history = lookOnceHistory(store);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.width, 480);
    assert.equal(history[0]?.question, '画面里有什么？');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('the autonomy switch is off by default and survives a restart (t88)', () => {
  const root = tempDir('xixi-t88-switch-');
  const store = openXixiStore({ dataDir: root });
  try {
    const shipped = restoreVisionSettings(store);
    assert.equal(shipped.autoLook, false, 'shipped default: only the button looks');
    assert.equal(shipped.source, 'default');

    persistVisionSettings(store, true);
    const after = restoreVisionSettings(store);
    assert.equal(after.autoLook, true);
    assert.equal(after.source, 'console');

    persistVisionSettings(store, false);
    assert.equal(restoreVisionSettings(store).autoLook, false, 'and it can be turned back off');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('「看一眼」 sends exactly one image, speaks, logs the turn and refuses with Chinese reasons (t88)', { timeout: 60_000 }, async () => {
  const root = tempDir('xixi-t88-http-');
  const live = fakeLiveRunner();
  const brain = recordingBrain();
  const handle = await createFieldServer({
    port: 0,
    offline: false,
    ttsEnabled: false,
    voiceDir: join(root, 'voice'),
    dataDir: join(root, 'data'),
    presenceDataDir: join(root, 'presence'),
    reportDir: join(root, 'recon'),
    autoPrune: false,
    probeRunner: createFakeProbeRunner(),
    liveRunner: live.runner,
    adapterOverride: brain.adapter,
    log: () => {},
  });
  const post = async (path: string, body: unknown): Promise<Record<string, any>> =>
    (await (await fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json()) as Record<string, any>;
  try {
    // 1. No frame yet → a Chinese refusal, and nothing is uploaded.
    const noFrame = await post('/api/field/look', {});
    assert.equal(noFrame.ok, false);
    assert.equal(noFrame.error.code, 'NO_FRAME');
    assert.match(String(noFrame.error.message), /还没有画面/);
    assert.equal(brain.calls.length, 0, 'a refused look never reaches the model');

    // 2. With the camera running: one press = one request carrying exactly one JPEG + the question.
    await post('/api/field/live', { action: 'start', intervalMs: 30_000 });
    live.push(frameLine({ width: 480, height: 360, bytes: 9000 }));
    const looked = await post('/api/field/look', { question: '画面里有什么？' });
    assert.equal(looked.ok, true, JSON.stringify(looked.error ?? null));
    // The proactive loop also ticks when 「启用」 starts it, and outside quiet hours it may ask the
    // model whether to speak (t8's 读空气 seam) — so count the calls **that carried the frame**
    // instead of every adapter call since server start. Depending on the wall clock for this was a
    // latent flake: inside 23:30–07:30 the tick is blocked by QUIET_HOURS and the count happened to
    // be 1 (the same class of clock dependency 4c0d1d2 fixed for the proactive card).
    const frameCalls = brain.calls.filter((call) => (call.images?.length ?? 0) > 0);
    assert.equal(frameCalls.length, 1, 'exactly one model call carries a frame per press');
    assert.equal(frameCalls[0]?.images?.length, 1, 'and exactly one image');
    assert.equal(frameCalls[0]?.images?.[0]?.base64, JPEG_BASE64);
    assert.equal(frameCalls[0]?.images?.[0]?.mediaType, 'image/jpeg');
    assert.equal(looked.reply, '画面里有一个白色的信箱。');
    assert.equal(looked.segments.length, 1);
    assert.equal(looked.audio, null, '--no-tts: the reply is text, and the note says so');
    assert.match(String(looked.audioNote), /只显示文字/);
    assert.equal(looked.upload.trigger, 'manual');
    assert.equal(looked.upload.bytes, 9000);
    assert.equal(looked.vision.uploads, 1, 'the page can show how many frames went out');
    assert.equal(looked.vision.lastUpload.width, 480);

    // 3. The turn is in the conversation log (both sides), so the right column shows it.
    const recent = looked.state.recent as Record<string, unknown>[];
    assert.equal(recent[0]?.source, '看一眼（manual）');
    assert.equal(recent[0]?.reply, '画面里有一个白色的信箱。');
    assert.equal(recent[0]?.transcript, '画面里有什么？');

    // 4. Manual-only by default; the switch is explicit and persisted through the endpoint.
    const state = (await (await fetch(`${handle.url}/api/field/live`)).json()) as Record<string, any>;
    assert.equal(state.vision.autoLookEnabled, false, '默认只允许手动触发');
    assert.match(String(state.vision.privacyNote), /默认只有你按「看一眼」/);
    const toggled = await post('/api/field/vision', { autoLook: true });
    assert.equal(toggled.ok, true);
    assert.equal(toggled.vision.autoLookEnabled, true);
    assert.equal(toggled.vision.autoLookSource, 'console');
    const bogus = await post('/api/field/vision', { autoLook: 'yes' });
    assert.equal(bogus.ok, false);
    assert.match(String(bogus.error.message), /布尔值/);
    const back = await post('/api/field/vision', { autoLook: false });
    assert.equal(back.vision.autoLookEnabled, false);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('offline and DSH modes refuse to look instead of pretending (t88)', { timeout: 60_000 }, async () => {
  const root = tempDir('xixi-t88-offline-');
  const live = fakeLiveRunner();
  const brain = recordingBrain();
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
    live.push(frameLine({ width: 480, height: 360, bytes: 9000 }));
    const refused = await post('/api/field/look', {});
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'OFFLINE');
    assert.match(String(refused.error.message), /替身适配器不看图/);
    assert.match(String(refused.error.hint), /去掉 --offline/);
    assert.equal(brain.calls.length, 0);
    const payload = (await (await fetch(`${handle.url}/api/field/live`)).json()) as Record<string, any>;
    assert.equal(payload.vision.canLook, false);
    assert.ok((payload.vision.blockers as string[]).some((row) => row.includes('--offline')));
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a silent answer is reported as such, not as a successful description (t88)', { timeout: 60_000 }, async () => {
  const root = tempDir('xixi-t88-silent-');
  const live = fakeLiveRunner();
  const adapter = new FakeBrainAdapter({ provider: 'fake-vision', model: 'fake-silent', reply: () => ({ action: 'SILENCE', text: null }) });
  const handle = await createFieldServer({
    port: 0,
    offline: false,
    ttsEnabled: false,
    voiceDir: join(root, 'voice'),
    dataDir: join(root, 'data'),
    presenceDataDir: join(root, 'presence'),
    reportDir: join(root, 'recon'),
    autoPrune: false,
    probeRunner: createFakeProbeRunner(),
    liveRunner: live.runner,
    adapterOverride: adapter,
    log: () => {},
  });
  const post = async (path: string, body: unknown): Promise<Record<string, any>> =>
    (await (await fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json()) as Record<string, any>;
  try {
    await post('/api/field/live', { action: 'start', intervalMs: 30_000 });
    live.push(frameLine({ width: 480, height: 360, bytes: 9000 }));
    const looked = await post('/api/field/look', { question: '这是桌上的东西吗？画面里有什么？用一句话说。' });
    assert.equal(looked.ok, true, 'the look itself happened');
    assert.equal(looked.reply, null);
    assert.equal(looked.noAnswer, true, 'the page can tell "looked, but nothing came back" apart from a description');
    assert.match(String(looked.noAnswerNote), /模型这次没说话/);
    assert.match(String(looked.noAnswerNote), /已经看过这一帧/);
    assert.equal(looked.upload.outcome.startsWith('no-text'), true, 'and the record says what happened');
    assert.equal(looked.vision.uploads, 1, 'the upload still counts (it was sent)');
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('the page offers the button, the notice and the default-off switch (t88)', () => {
  const page = buildFieldPage({
    listen: '127.0.0.1:8792',
    offline: false,
    ttsEnabled: true,
    modelConfigured: true,
    calibration: readCalibration('nope.json'),
    policy: retentionPolicy(loadConfig()),
    databasePath: join('data', 'field-test'),
  });
  for (const marker of ['id="px-look"', 'id="px-look-question"', 'id="px-look-status"', 'id="px-look-history"', 'id="px-vision-auto"']) {
    assert.ok(page.includes(marker), `the look-once UI is missing ${marker}`);
  }
  assert.match(page, /看一眼（把这一帧发给小米服务器）/, 'the button says where the picture goes');
  assert.ok(page.includes(VISION_NOTICE), 'the notice explains manual-only + the audit');
  assert.match(page, /默认关/, 'and the autonomy switch is labelled default-off');
  assert.match(page, /只有时间\/大小\/触发源，没有图像/, 'and says the record has no image');
  assert.ok(!VISION_NOTICE.includes('**'), 'the notice is plain text (it goes into the JSON too)');
  // The button sits in the sensors column, next to the live picture.
  const sensors = page.slice(page.indexOf('id="col-sensors"'), page.indexOf('id="col-config"'));
  assert.ok(sensors.includes('id="px-look"'), 'the button is next to the live picture');
  assert.ok(sensors.includes('id="px-cam"'));
});
