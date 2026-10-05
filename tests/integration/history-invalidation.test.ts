import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openXixiStore } from '@xixi/domain';
import { ConversationEngine } from '@xixi/conversation';
import { FakeBrainAdapter, type UserTurnInput } from '@xixi/brain-adapter';
import { REPLAY_CONFIG } from '@xixi/runtime';

for (const operation of ['semantic.revoke', 'semantic.edit', 'semantic.delete', 'episodic.edit', 'episodic.delete'] as const) {
  test(`${operation} invalidates source-session history durably while keeping audit and other sessions`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xixi-history-invalidation-'));
    const clock = () => new Date('2026-10-05T10:00:00+08:00');
    let store = openXixiStore({ dataDir: dir, clock });
    store.seedSelfProfile(REPLAY_CONFIG.personality.base);
    const prompts: UserTurnInput[] = [];
    class Capture extends FakeBrainAdapter {
      override handleUserTurn(input: UserTurnInput) { prompts.push(input); return super.handleUserTurn(input); }
    }
    const open = () => new ConversationEngine({ store, clock, mood: false, config: REPLAY_CONFIG,
      adapter: new Capture({ reply: () => ({ action: 'SPEAK', text: '旧代号蓝鲸，我听到了。' }) }) });
    let engine = open();
    try {
      const session = store.createSession(); const other = store.createSession();
      await engine.respond({ sessionId: session.sessionId, text: '旧代号是蓝鲸。', addressed: true });
      const source = store.recentTurns(session.sessionId, 10).find((t) => t.role === 'user')!.eventId;
      await engine.respond({ sessionId: session.sessionId, text: '刚才那个代号呢', addressed: true });
      await engine.respond({ sessionId: other.sessionId, text: '另一会话的独立话题', addressed: true });
      const auditCount = store.recentTurns(session.sessionId, 20).length;
      const otherBefore = engine.workingMemory(other.sessionId);
      assert.ok(engine.workingMemory(session.sessionId).some((t) => t.text.includes('蓝鲸')));
      if (operation.startsWith('semantic')) {
        const m = store.insertSemanticMemory({ statement: '旧代号蓝鲸', property: 'fixture.code', sourceType: 'explicit_correction', sourceEventId: source });
        if (operation === 'semantic.revoke') store.setSemanticMemoryStatus({ memoryId: m.memoryId, status: 'revoked', at: clock(), reason: 'explicit_correction' });
        if (operation === 'semantic.edit') store.updateSemanticMemory(m.memoryId, { statement: '新代号海豚' });
        if (operation === 'semantic.delete') assert.equal(store.deleteSemanticMemory(m.memoryId), true);
      } else {
        const m = store.insertEpisodicMemory({ summary: '旧代号蓝鲸', kind: 'episode', sourceType: 'explicit_correction', sourceEventId: source, occurredAt: clock().toISOString() });
        if (operation === 'episodic.edit') store.updateEpisodicMemory(m.memoryId, { summary: '新代号海豚' });
        else assert.equal(store.deleteEpisodicMemory(m.memoryId), true);
      }
      assert.deepEqual(engine.workingMemory(session.sessionId), []);
      assert.equal(store.recentTurns(session.sessionId, 20).length, auditCount);
      assert.deepEqual(engine.workingMemory(other.sessionId), otherBefore);
      store.close(); store = openXixiStore({ dataDir: dir, clock }); engine = open();
      assert.deepEqual(engine.workingMemory(session.sessionId), []);
      await engine.respond({ sessionId: session.sessionId, text: '新的话题：散步', addressed: true });
      const prompt = prompts.at(-1)!.prompt;
      assert.ok(prompt);
      assert.ok(!prompt.history.some((t) => t.content.includes('蓝鲸')));
      assert.ok(prompt.user.includes('新的话题：散步'));
      assert.equal(store.recentTurns(session.sessionId, 20).length, auditCount + 2);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('failed memory deletion rolls back its context cutoff and missing provenance changes no session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-history-rollback-'));
  const store = openXixiStore({ dataDir: dir });
  store.seedSelfProfile(REPLAY_CONFIG.personality.base);
  const engine = new ConversationEngine({ store, mood: false, config: REPLAY_CONFIG, adapter: new FakeBrainAdapter() });
  let probe: DatabaseSync | undefined;
  try {
    const session = store.createSession();
    await engine.respond({ sessionId: session.sessionId, text: '这是需要保留的原文', addressed: true });
    const source = store.recentTurns(session.sessionId, 10).find((t) => t.role === 'user')!.eventId;
    const before = engine.workingMemory(session.sessionId);
    const memory = store.insertSemanticMemory({ property: 'fixture', statement: '原记录', sourceType: 'program_extraction', sourceEventId: source });
    probe = new DatabaseSync(store.dbPath);
    probe.exec("CREATE TRIGGER deny_memory_delete BEFORE DELETE ON semantic_memory BEGIN SELECT RAISE(ABORT, 'fixture_abort'); END");
    assert.throws(() => store.deleteSemanticMemory(memory.memoryId), /fixture_abort/);
    assert.equal(store.semanticMemory(memory.memoryId).statement, '原记录');
    assert.deepEqual(engine.workingMemory(session.sessionId), before);
    assert.equal((probe.prepare('SELECT COUNT(*) AS n FROM context_history_cutoffs').get() as { n: number }).n, 0);
    probe.exec('DROP TRIGGER deny_memory_delete');
    for (const sourceEventId of [null, 'missing_fixture_event']) {
      const m = store.insertSemanticMemory({ property: 'fixture', statement: '无来源', sourceType: 'program_extraction', sourceEventId });
      assert.equal(store.deleteSemanticMemory(m.memoryId), true);
      assert.deepEqual(engine.workingMemory(session.sessionId), before);
    }
    assert.equal(store.deleteSemanticMemory('missing_memory'), false);
    assert.equal(store.deleteEpisodicMemory('missing_memory'), false);
  } finally { probe?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
