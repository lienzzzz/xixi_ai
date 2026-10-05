import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openXixiStore } from '@xixi/domain';

test('runtime checkpoints survive reopening and stale writers cannot overwrite state or audit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-checkpoint-'));
  let store = openXixiStore({ dataDir: dir });
  try {
    assert.equal(store.readRuntimeCheckpoint('room'), null);
    const row = store.writeRuntimeCheckpoint('room', { schemaVersion: 1, ownerSession: 'one' }, 0, 'runtime.created');
    assert.equal(row.revision, 1);
    store.close();
    store = openXixiStore({ dataDir: dir });
    assert.deepEqual(store.readRuntimeCheckpoint('room')?.value, { schemaVersion: 1, ownerSession: 'one' });
    const audit = store.eventCount();
    assert.throws(() => store.writeRuntimeCheckpoint('room', { schemaVersion: 1 }, 0, 'runtime.updated'), /CHECKPOINT_CONFLICT/);
    assert.equal(store.eventCount(), audit);
    assert.equal(store.readRuntimeCheckpoint('room')?.revision, 1);
    assert.throws(() => store.writeRuntimeCheckpoint('room', { schemaVersion: 2 }, 1, 'runtime.updated'), /CHECKPOINT_VERSION/);
    assert.equal(store.readRuntimeCheckpoint('room')?.revision, 1);
    assert.equal(store.writeRuntimeCheckpoint('room', { schemaVersion: 1, ownerSession: 'two' }, 1, 'runtime.updated').revision, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
