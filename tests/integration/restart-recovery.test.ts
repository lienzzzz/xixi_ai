import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DshBrainAdapter, ScriptedDshTransport, collectTurn, FakeBrainAdapter } from '@xixi/brain-adapter';
import { openXixiStore } from '@xixi/domain';

/**
 * Restart recovery at the layer M0 owns: the process dies, a new one opens the
 * same database, and the conversation continues with the same identity.
 * The end-to-end version with real processes and a real model is
 * `scripts/verify-m0.ts`; this one runs offline on every `npm test`.
 */
test('a new store instance continues the session, turns, personality and harness mapping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-restart-'));
  const dbPath = join(dir, 'xixi.sqlite');

  // ---- process 1 -----------------------------------------------------------
  const first = openXixiStore({ dbPath });
  const session = first.createSession();
  first.seedSelfProfile({ proactivity: 0.55, warmth: 0.8 });
  first.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: '明天去镇上' });
  const transportA = new ScriptedDshTransport({ sessionId: 'session-durable-1', turns: [{ text: '记得，路上小心。' }] });
  const adapterA = new DshBrainAdapter({ transport: transportA, store: first });
  const turnA = await collectTurn(
    await adapterA.handleUserTurn({ sessionId: session.sessionId, text: '明天去镇上', context: { identityName: '西西', personality: first.selfProfile() } }),
  );
  first.recordTurn({
    sessionId: session.sessionId,
    role: 'assistant',
    action: turnA.result.action,
    text: turnA.result.text,
    toolName: turnA.result.toolName,
  });
  const brainSessionIdBefore = first.brainSessionId(session.sessionId, 'dsh');
  first.close();

  // ---- process 2 (fresh instance, same file) -------------------------------
  const second = openXixiStore({ dbPath });
  assert.equal(second.appliedMigrations.length, 0, 'restart must not re-run migrations');
  const resumed = second.resume(session.sessionId);
  assert.equal(resumed.session.sessionId, session.sessionId);
  assert.equal(resumed.turns.length, 2);
  assert.equal(resumed.personality.proactivity, 0.55);
  assert.equal(second.brainSessionId(session.sessionId, 'dsh'), brainSessionIdBefore);

  const transportB = new ScriptedDshTransport({ sessionId: 'unused', turns: [{ text: '你昨天说要去镇上。' }] });
  const adapterB = new DshBrainAdapter({ transport: transportB, store: second });
  await collectTurn(
    await adapterB.handleUserTurn({
      sessionId: session.sessionId,
      text: '我昨天说了什么？',
      context: { identityName: '西西', personality: second.selfProfile() },
    }),
  );
  assert.equal(
    transportB.requests[0].resumeBrainSessionId,
    brainSessionIdBefore,
    'the new process must hand the persisted harness session back to the harness',
  );
  assert.equal(
    transportB.requests[0].context.workingMemory.length,
    0,
    'working memory is supplied by the caller, so the reopened store is the only source of history',
  );
  second.close();
});

test('seeding the baseline on every boot restores rather than resets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-reseed-'));
  const dbPath = join(dir, 'xixi.sqlite');

  const first = openXixiStore({ dbPath });
  first.seedSelfProfile({ proactivity: 0.55 });
  first.close();

  const second = openXixiStore({ dbPath });
  second.seedSelfProfile({ proactivity: 0.1 });
  assert.equal(second.selfProfile().proactivity, 0.55, 'a restart must not overwrite what was already learned');
  assert.equal(second.selfProfileHistory().length, 1, 'and must not fabricate a change record');
  second.close();
});

test('the offline fake adapter drives the same seams without a harness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-fake-'));
  const store = openXixiStore({ dbPath: join(dir, 'xixi.sqlite') });
  try {
    const adapter = new FakeBrainAdapter();
    const session = store.createSession();
    const echoed = await collectTurn(await adapter.handleUserTurn({ sessionId: session.sessionId, text: '你好' }));
    assert.equal(echoed.result.action, 'SPEAK');
    assert.equal(echoed.result.text, '模拟回复：你好');

    const silent = await collectTurn(await adapter.handleUserTurn({ sessionId: session.sessionId, text: '   ' }));
    assert.equal(silent.result.action, 'SILENCE');
    assert.equal(silent.result.text, null);

    const tool = await collectTurn(await adapter.handleUserTurn({ sessionId: session.sessionId, text: '/tool 时间' }));
    assert.equal(tool.result.action, 'TOOL');
    assert.equal(tool.result.toolName, 'xixi_get_current_time');
  } finally {
    store.close();
  }
});
