import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEndpointProfile, loadEndpointProfile } from '@xixi/runtime';

const profile = () => ({ schemaVersion: 1, roomId: 'bedroom', devices: [
  { id: 'cam', roomId: 'bedroom', kind: 'camera', adapter: 'filtered-events' },
  { id: 'mic', roomId: 'bedroom', kind: 'microphone', adapter: 'filtered-events' },
  { id: 'out', roomId: 'bedroom', kind: 'speaker', adapter: 'simulated-playback' },
] });

test('versioned endpoint profile maps capability-compatible sources without opening hardware', () => {
  const source = profile();
  const result = parseEndpointProfile(source);
  assert.equal(result.roomId, 'bedroom');
  assert.deepEqual(result.devices, source.devices);
  source.devices[0]!.id = 'changed';
  assert.equal(result.devices[0]?.id, 'cam');
});

test('profile rejects unsupported versions, ambiguous identity, drivers and capabilities', () => {
  const mutations: Array<(p: ReturnType<typeof profile>) => unknown> = [
    (p) => ({ ...p, schemaVersion: 2 }), (p) => ({ ...p, secret: 'not-accepted' }),
    (p) => ({ ...p, roomId: ' ' }), (p) => ({ ...p, devices: [] }),
    (p) => { p.devices[0]!.id = p.devices[1]!.id; return p; },
    (p) => { p.devices[0]!.roomId = 'other'; return p; },
    (p) => { p.devices[0]!.adapter = 'usb'; return p; },
    (p) => { p.devices[0]!.adapter = 'simulated-playback'; return p; },
    (p) => { p.devices[2]!.adapter = 'filtered-events'; return p; },
    (p) => ({ ...p, devices: p.devices.slice(0, 2) }),
    (p) => ({ ...p, devices: [...p.devices, ...Array.from({ length: 62 }, (_, i) => ({ ...p.devices[1], id: `mic-${i}` }))] }),
  ];
  for (const mutate of mutations) assert.throws(() => parseEndpointProfile(mutate(profile())), /INVALID_ENDPOINT_PROFILE/);
});

test('profile loader bounds input, accepts UTF8 BOM and fails without echoing invalid contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-endpoint-profile-'));
  const file = join(dir, 'profile.json');
  try {
    writeFileSync(file, '\uFEFF' + JSON.stringify(profile()));
    assert.equal(loadEndpointProfile(file).devices.length, 3);
    writeFileSync(file, 'secret-token-is-not-json');
    assert.throws(() => loadEndpointProfile(file), (error: unknown) => error instanceof Error && error.message === 'INVALID_ENDPOINT_PROFILE');
    writeFileSync(file, ' '.repeat(65537));
    assert.throws(() => loadEndpointProfile(file), /ENDPOINT_PROFILE_TOO_LARGE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
