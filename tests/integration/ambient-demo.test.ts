import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '@xixi/runtime';

test('the real ambient demo CLI completes the offline scenario and a child-process recovery', () => {
  const output = execFileSync(process.execPath, ['scripts/demo-ambient.ts'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 });
  assert.match(output, /软件模拟验收通过/);
  const summary = JSON.parse(output.split('\n').find((line) => line.startsWith('{"schemaVersion":')) ?? '{}') as Record<string, unknown>;
  assert.equal(summary['duplicateInputs'], 1);
  assert.equal(summary['guestMemoryWrites'], 0);
  assert.equal(summary['reminderStatus'], 'acknowledged');
  assert.equal(summary['childRecovery'], true);
  assert.equal(summary['hardwareVerified'], false);
});

test('the same offline host runs with a configured room and one microphone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-demo-profile-'));
  try {
    const path = join(dir, 'devices.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, roomId: 'bedroom', devices: [
      { id: 'network-camera', roomId: 'bedroom', kind: 'camera', adapter: 'filtered-events' },
      { id: 'usb-mic', roomId: 'bedroom', kind: 'microphone', adapter: 'filtered-events' },
      { id: 'bedside-speaker', roomId: 'bedroom', kind: 'speaker', adapter: 'simulated-playback' },
    ] }));
    const output = execFileSync(process.execPath, ['scripts/demo-ambient.ts', '--profile', path], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 });
    assert.match(output, /软件模拟验收通过/);
    const summary = JSON.parse(output.split('\n').find((line) => line.startsWith('{"schemaVersion":')) ?? '{}') as Record<string, unknown>;
    assert.equal(summary['roomId'], 'bedroom');
    assert.equal(summary['deviceCount'], 3);
    assert.equal(summary['childRecovery'], true);
    assert.equal(summary['hardwareVerified'], false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
