/** Exercise durable history invalidation through the real conversation engine, offline. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openXixiStore } from '@xixi/domain';
import { ConversationEngine } from '@xixi/conversation';
import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { REPLAY_CONFIG } from '@xixi/runtime';

const dir = mkdtempSync(join(tmpdir(), 'xixi-history-demo-'));
let store = openXixiStore({ dataDir: dir });
store.seedSelfProfile(REPLAY_CONFIG.personality.base);
const open = () => new ConversationEngine({ store, config: REPLAY_CONFIG, mood: false,
  adapter: new FakeBrainAdapter({ reply: () => ({ action: 'SPEAK', text: '嗯，我在听。' }) }) });
let engine = open();
try {
  const session = store.createSession(); const other = store.createSession();
  await engine.respond({ sessionId: session.sessionId, text: '旧代号是蓝鲸。', addressed: true });
  await engine.respond({ sessionId: other.sessionId, text: '另一会话的独立内容', addressed: true });
  const source = store.recentTurns(session.sessionId).find((t) => t.role === 'user')!.eventId;
  const memory = store.insertSemanticMemory({ property: 'fixture.code', statement: '旧代号蓝鲸', sourceType: 'explicit_correction', sourceEventId: source });
  const previousHistory = engine.workingMemory(session.sessionId).length;
  assert.equal(store.deleteSemanticMemory(memory.memoryId), true);
  assert.equal(engine.workingMemory(session.sessionId).length, 0);
  const rawRetained = store.recentTurns(session.sessionId).length;
  store.close(); store = openXixiStore({ dataDir: dir }); engine = open();
  assert.equal(engine.workingMemory(session.sessionId).length, 0);
  const otherHistory = engine.workingMemory(other.sessionId).length;
  assert.ok(otherHistory > 0);
  await engine.respond({ sessionId: session.sessionId, text: '新的话题：散步', addressed: true });
  assert.equal(engine.workingMemory(session.sessionId).length, 2);
  console.log(JSON.stringify({ schemaVersion: 1, previousHistory, historyAfterRestart: 0, rawRetained, otherHistory,
    newHistory: 2, realProviderCalled: false, hardwareVerified: false }));
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
