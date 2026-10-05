import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openXixiStore } from '@xixi/domain';
import { FakeBrainAdapter, type UserTurnInput, type ToolRegistry } from '@xixi/brain-adapter';
import { AmbientRuntime, TerminalCompanion, parseEndpointProfile, REPLAY_CONFIG } from '@xixi/runtime';

for (const kind of ['ambient', 'terminal'] as const) {
  test(`${kind} rejects input before acceptance when a slow model fills the bounded queue`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xixi-backpressure-'));
    const at = new Date('2026-10-05T10:00:00+08:00');
    const store = openXixiStore({ dataDir: dir, clock: () => at }); store.seedSelfProfile(REPLAY_CONFIG.personality.base);
    const profile = parseEndpointProfile({ schemaVersion: 1, roomId: 'queue', devices: [
      { id: 'camera', roomId: 'queue', kind: 'camera', adapter: 'filtered-events' },
      { id: 'mic', roomId: 'queue', kind: 'microphone', adapter: 'filtered-events' },
      { id: 'speaker', roomId: 'queue', kind: 'speaker', adapter: 'simulated-playback' },
    ] });
    let release!: () => void; let entered!: () => void; let modelCalls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const factory = (registry: ToolRegistry) => {
      const fake = new FakeBrainAdapter({ registry, reply: () => ({ action: 'SPEAK', text: '嗯，我在听。' }) });
      return { provider: fake.provider, describe: () => fake.describe(), async handleUserTurn(input: UserTurnInput) {
        modelCalls++; entered(); await gate; return fake.handleUserTurn(input);
      } };
    };
    const common = { store, config: REPLAY_CONFIG, clock: () => at, modelFactory: factory,
      maxPendingEvents: 2, decide: () => ({ speak: false, reasonCode: 'wrong_moment' as const }) };
    const runtime = kind === 'ambient' ? AmbientRuntime.open({ ...common, roomId: 'queue', devices: profile.devices, consent: true }) : null;
    const terminal = kind === 'terminal' ? TerminalCompanion.open({ ...common, profile, write: async () => {} }) : null;
    const speech = (id: string) => runtime!.dispatch({ schemaVersion: 1, eventId: id, utteranceId: id,
      roomId: 'queue', at: at.toISOString(), kind: 'speech', deviceId: 'mic', actor: 'father', address: 'direct', text: id });
    try {
      if (runtime) await runtime.dispatch({ schemaVersion: 1, eventId: 'present', roomId: 'queue', at: at.toISOString(), kind: 'presence', deviceId: 'camera', occupants: ['father'] });
      else await terminal!.handle('/alone');
      const first = runtime ? speech('first') : terminal!.handle('first');
      await started;
      const second = runtime ? runtime.dispatch({ schemaVersion: 1, eventId: 'quiet', roomId: 'queue', at: at.toISOString(), kind: 'scene', quiet: true }) : terminal!.handle('/quiet');
      const third = runtime ? speech('rejected') : terminal!.handle('rejected');
      await assert.rejects(Promise.race([third, new Promise<void>((resolve) => setTimeout(resolve, 40))]), /INPUT_BACKPRESSURE/);
      assert.equal(modelCalls, 1);
      assert.ok(!store.readEvents({ type: 'conversation.turn' }).some((e) => JSON.stringify(e.payload).includes('rejected')));
      const closing = runtime ? runtime.close() : terminal!.close();
      let secondCloseDone = false;
      const closingAgain = (runtime ? runtime.close() : terminal!.close()).then(() => { secondCloseDone = true; });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.equal(secondCloseDone, false);
      release(); await first; await second; await closing; await closingAgain;
      const snapshot = runtime?.snapshot() ?? terminal!.snapshot();
      assert.equal(snapshot.scene.quiet, true);
      assert.equal(modelCalls, 1);
      if (terminal) {
        const before = store.readRuntimeCheckpoint('ambient.queue')!.revision;
        await assert.rejects(terminal.handle('长'.repeat(4097)), /TERMINAL_INPUT_TOO_LARGE/);
        assert.equal(store.readRuntimeCheckpoint('ambient.queue')!.revision, before);
      }
    } finally { release(); await runtime?.close(); await terminal?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
