/** Measure actual checkpoint growth under sequential offline ticks in a temporary store. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openXixiStore } from '@xixi/domain';
import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { AmbientRuntime, REPLAY_CONFIG } from '@xixi/runtime';

const argument = process.argv.slice(2);
if (argument.some((a) => !/^--events=\d+$/.test(a)) || argument.length > 1) throw new Error('INVALID_PROBE_ARGUMENTS');
const count = argument.length === 0 ? 1024 : Number(argument[0]!.slice('--events='.length));
if (!Number.isSafeInteger(count) || count < 4 || count > 4096) throw new Error('INVALID_PROBE_ARGUMENTS');
const targets = [...new Set([Math.floor(count / 4), Math.floor(count / 2), count])];
const dir = mkdtempSync(join(tmpdir(), 'xixi-ledger-probe-'));
let at = new Date('2026-10-05T10:00:00+08:00'); let modelCalls = 0; let decisions = 0;
const store = openXixiStore({ dataDir: dir, clock: () => at }); store.seedSelfProfile(REPLAY_CONFIG.personality.base);
const runtime = AmbientRuntime.open({ store, config: REPLAY_CONFIG, roomId: 'probe', clock: () => at, consent: true,
  devices: [{ id: 'camera', roomId: 'probe', kind: 'camera' }, { id: 'mic', roomId: 'probe', kind: 'microphone' }, { id: 'speaker', roomId: 'probe', kind: 'speaker' }],
  modelFactory: () => new FakeBrainAdapter({ reply: () => { modelCalls++; return { action: 'SILENCE', text: '' }; } }),
  decide: () => { decisions++; return { speak: false, reasonCode: 'wrong_moment' }; } });
const samples: Array<Record<string, number>> = []; let previous = 0; let batchStart = performance.now();
try {
  for (let i = 1; i <= count; i++) {
    at = new Date(at.getTime() + 1000);
    await runtime.dispatch({ schemaVersion: 1, kind: 'tick', eventId: `probe-${i}`, roomId: 'probe', at: at.toISOString() });
    if (!targets.includes(i)) continue;
    const now = performance.now(); const row = store.readRuntimeCheckpoint('ambient.probe')!;
    const inputs = row.value['inputs']; assert.ok(inputs && typeof inputs === 'object' && !Array.isArray(inputs));
    assert.equal(Object.keys(inputs).length, i);
    const sqliteBytes = ['', '-wal', '-shm'].reduce((n, suffix) => n + (existsSync(store.dbPath + suffix) ? statSync(store.dbPath + suffix).size : 0), 0);
    const batchEvents = i - previous;
    samples.push({ events: i, batchEvents, batchMs: now - batchStart, msPerEvent: (now - batchStart) / batchEvents,
      checkpointBytes: Buffer.byteLength(JSON.stringify(row.value), 'utf8'), sqliteFilesBytes: sqliteBytes,
      rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, auditEvents: store.eventCount() });
    previous = i; batchStart = performance.now();
  }
  assert.equal(modelCalls, 0); assert.equal(decisions, 0);
  console.log(JSON.stringify({ schemaVersion: 1, fixture: 'unknown_presence_sequential_ticks', samples, modelCalls, decisions,
    includesSqliteWalAndShm: true, rssIsSampleNotPeak: true, realProviderCalled: false, hardwareVerified: false }));
} finally { await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
