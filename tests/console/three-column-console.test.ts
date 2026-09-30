/**
 * t78: the three-column console (传感器 / 配置 / 对话记录) and the one-button 启用.
 *
 * The live camera is driven through the same kind of seam the device probe uses, so these tests
 * never touch a camera, never start Python and never write a file: they check that 启用 starts
 * both halves (camera loop + resident loop, with an immediate consideration), that 停用 really
 * stops them, and that the picture the page gets is handed over in memory only.
 *
 * Run: `npm run test:console` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  LIVE_PRIVACY_NOTE,
  LiveSensors,
  PROACTIVE_PANEL_IDS,
  buildFieldPage,
  createFakeProbeRunner,
  createFieldServer,
  readCalibration,
  retentionPolicy,
  type LiveCameraHandle,
  type LiveCameraRunner,
} from '../../scripts/field-test.ts';
import { loadConfig } from '../../scripts/lib/harness.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fake perception child: it answers with scripted frames and records how it was stopped. */
function fakeLiveRunner(): LiveCameraRunner & {
  readonly started: { source: string; cameraIndex: number; dbPath: string }[];
  readonly kills: number;
  readonly handles: LiveCameraHandle[];
  push: (line: string) => void;
  exit: (code: number | null) => void;
} {
  const started: { source: string; cameraIndex: number; dbPath: string }[] = [];
  const handles: LiveCameraHandle[] = [];
  let killCount = 0;
  let onLine: ((line: string) => void) | null = null;
  let onExit: ((code: number | null) => void) | null = null;
  return {
    started,
    handles,
    get kills() {
      return killCount;
    },
    push: (line) => onLine?.(line),
    exit: (code) => onExit?.(code),
    start(options) {
      started.push({ source: options.source, cameraIndex: options.cameraIndex, dbPath: options.presenceDbPath });
      onLine = options.onLine;
      onExit = options.onExit;
      const handle: LiveCameraHandle = {
        pid: 7000 + started.length,
        kill: () => {
          killCount += 1;
        },
        write: () => {},
      };
      handles.push(handle);
      return handle;
    },
  };
}

const FRAME_LINE = JSON.stringify({
  type: 'frame',
  at: '2026-09-30T16:20:00.000+08:00',
  frame_index: 7,
  present: true,
  state: 'present',
  confidence: 0.91,
  changed: false,
  motion_ratio: 0.021,
  faces: 1,
  detect_ms: 8.4,
  jpeg_bytes: 4096,
  width: 320,
  height: 240,
  jpeg: 'ZmFrZS1qcGVn',
});

test('the page is three columns: sensors, config, conversation (t78)', () => {
  const page = buildFieldPage({
    listen: '127.0.0.1:8792',
    offline: true,
    ttsEnabled: false,
    modelConfigured: false,
    calibration: readCalibration('nope.json'),
    policy: retentionPolicy(loadConfig()),
    databasePath: join('data', 'field-test'),
  });
  const sensors = page.slice(page.indexOf('id="col-sensors"'), page.indexOf('id="col-config"'));
  const config = page.slice(page.indexOf('id="col-config"'), page.indexOf('id="col-conversation"'));
  const conversation = page.slice(page.indexOf('id="col-conversation"'), page.indexOf('</main>'));
  assert.ok(sensors.length > 0 && config.length > 0 && conversation.length > 0, 'three columns exist');

  // 左栏：传感器状态。
  for (const marker of ['px-enable', 'px-disable', 'px-cam', 'presence-text', 'presence-confidence', 'mic-level', 'mic-floor', 'mic-cal-floor', 'ep-capture-muted', 'ep-capture-gain', '本页用的是哪个数据库']) {
    assert.ok(sensors.includes(marker), `左栏（传感器）缺 ${marker}`);
  }
  // 中栏：全部配置项。
  for (const marker of [PROACTIVE_PANEL_IDS.proactivity, PROACTIVE_PANEL_IDS.talkativeness, PROACTIVE_PANEL_IDS.verbosity, PROACTIVE_PANEL_IDS.cooldown, PROACTIVE_PANEL_IDS.perDay, PROACTIVE_PANEL_IDS.per6h, PROACTIVE_PANEL_IDS.quietStart, PROACTIVE_PANEL_IDS.triggers, 'px-tts-switch', 'px-camera-switch', 'px-enable-interval']) {
    assert.ok(config.includes(marker), `中栏（配置）缺 ${marker}`);
  }
  // 右栏：对话记录。
  for (const marker of ['id="turns"', '主动开口', '第 i/N 段']) {
    assert.ok(conversation.includes(marker), `右栏（对话记录）缺 ${marker}`);
  }
  assert.ok(page.includes(LIVE_PRIVACY_NOTE), 'the page states the memory-only camera policy');
  assert.match(page, /不落盘/, 'and that nothing is written to disk');
  assert.match(page, /不上传/, 'and that nothing is uploaded');
});

test('the camera preview keeps the picture in memory and drops old frames (t78)', () => {
  const root = tempDir('xixi-t78-live-');
  const runner = fakeLiveRunner();
  const sensors = new LiveSensors({ runner, presenceDbPath: () => join(root, 'presence'), cameraIndex: () => 0, log: () => {} });
  try {
    // Nothing has started yet: no picture, and the status says so instead of pretending.
    assert.equal(sensors.status().child.running, false);
    assert.equal(sensors.frame(), null);

    sensors.start({ source: 'camera' });
    assert.equal(sensors.status().child.running, true);
    assert.equal(sensors.status().child.pid, 7001, 'the pid comes from the spawned child');
    assert.equal(runner.started[0]?.source, 'camera', 'the shipped detection loop is what gets spawned');

    runner.push(FRAME_LINE);
    const frame = sensors.frame();
    assert.ok(frame !== null, 'the frame reached the console');
    assert.equal(frame?.dataUrl, 'data:image/jpeg;base64,ZmFrZS1qcGVn');
    assert.equal(frame?.jpegBytes, 4096);
    assert.equal(frame?.present, true);
    assert.equal(frame?.confidence, 0.91);
    assert.equal(sensors.status().child.frames, 1);
    assert.equal(sensors.status().lastFrame?.hasPicture, true);

    // A second frame replaces the first: only the latest picture is ever kept.
    runner.push(FRAME_LINE.replace('"frame_index":7', '"frame_index":8'));
    assert.equal(sensors.status().child.frames, 2);
    assert.equal(sensors.frame()?.frameIndex, 8);

    // The child's own evidence/summary lines are not mistaken for frames.
    runner.push(JSON.stringify({ record: 'frame', frame: 3, state: 'absent' }));
    runner.push(JSON.stringify({ record: 'summary', frames: 3 }));
    assert.equal(sensors.status().child.frames, 2, 'only real frame records count');

    // A presence event line counts as presence activity (it is what the rest of the system reads).
    runner.push(JSON.stringify({ record: 'event', event_type: 'presence.changed', payload: { present: true } }));
    assert.equal(sensors.status().child.presenceEvents, 1);

    sensors.stop();
    assert.equal(runner.kills, 1, '停用 kills the child');
    assert.equal(sensors.status().child.running, false);
    assert.equal(sensors.status().child.exited, false, 'and it does not claim the process is gone before it is');
    runner.exit(0);
    assert.equal(sensors.status().child.exited, true, 'once it exits, the page can say so');
    assert.equal(sensors.status().child.exitCode, 0);

    // No image file was produced anywhere by this path.
    assert.deepEqual(readdirSync(root), [], 'the live preview writes nothing');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('「启用」 starts both halves and considers once immediately; 停用 stops them (t78)', { timeout: 60_000 }, async () => {
  const root = tempDir('xixi-t78-enable-');
  const runner = fakeLiveRunner();
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
    liveRunner: runner,
    log: () => {},
  });
  const post = async (path: string, body: unknown): Promise<Record<string, any>> =>
    (await (await fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json()) as Record<string, any>;
  try {
    const before = (await (await fetch(`${handle.url}/api/field/live`)).json()) as Record<string, any>;
    assert.equal(before.status.child.running, false, 'nothing runs before 启用');
    assert.equal(before.loop.running, false);
    assert.equal(before.privacy, LIVE_PRIVACY_NOTE);

    const started = await post('/api/field/live', { action: 'start', intervalMs: 30_000 });
    assert.equal(started.ok, true);
    assert.equal(started.status.child.running, true, '摄像头在场检测起来了');
    assert.equal(runner.started.length, 1);
    assert.equal(
      runner.started[0]?.dbPath,
      join(root, 'presence', 'xixi.sqlite'),
      'the child appends into the presence store *file* (opened first, so migrations have run)',
    );
    assert.equal(started.loop.running, true, '主动循环也起来了');
    assert.ok(started.loop.ticks >= 1, `启用后必须立刻先考虑一次（ticks=${started.loop.ticks}）`);

    runner.push(FRAME_LINE);
    const withFrame = (await (await fetch(`${handle.url}/api/field/live`)).json()) as Record<string, any>;
    assert.equal(withFrame.frame?.dataUrl, 'data:image/jpeg;base64,ZmFrZS1qcGVn');
    assert.equal(withFrame.status.child.frames, 1);

    // 朗读 switch: runtime, and reflected in the same payload the page polls.
    const ttsOff = await post('/api/field/tts', { enabled: false });
    assert.equal(ttsOff.ttsEnabled, false);
    assert.equal(ttsOff.ttsAvailable, false, 'offline + off: nothing will be synthesized');
    const bogus = await post('/api/field/tts', { enabled: 'yes' });
    assert.equal(bogus.ok, false);
    assert.match(String(bogus.error.message), /布尔值/);

    const stopped = await post('/api/field/live', { action: 'stop' });
    assert.equal(stopped.status.child.running, false);
    assert.equal(runner.kills, 1, '停用 kills the camera child (it really exits)');
    assert.equal(stopped.loop.running, false, 'and the resident loop stops: no more proactive speech');
    assert.ok(stopped.loop.ticks >= 1, 'the record of what it did stays');

    // A stop with nothing running is a no-op, not an error.
    const again = await post('/api/field/live', { action: 'stop' });
    assert.equal(again.ok, true);
    assert.equal(runner.kills, 1);

    const unknown = await post('/api/field/live', { action: 'dance' });
    assert.equal(unknown.ok, false);
    assert.match(String(unknown.error.message), /不认识的启用操作/);

    // The camera switch is honoured: with it off, 启用 only starts the loop.
    const noCamera = await post('/api/field/live', { action: 'start', camera: false });
    assert.equal(noCamera.status.child.running, false, '摄像头开关关着：不起子进程');
    assert.equal(noCamera.status.cameraEnabled, false);
    assert.equal(runner.started.length, 1, 'and nothing extra was spawned');
    assert.equal(noCamera.loop.running, true, 'but the resident loop still runs');
    await post('/api/field/live', { action: 'stop' });
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
