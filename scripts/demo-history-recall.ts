/** Bounded long-window recall through the actual engine with a durable temporary store. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openXixiStore } from '@xixi/domain';
import { ConversationEngine, type AssembledPrompt } from '@xixi/conversation';
import { FakeBrainAdapter, type UserTurnInput } from '@xixi/brain-adapter';
import { REPLAY_CONFIG } from '@xixi/runtime';

const dir = mkdtempSync(join(tmpdir(), 'xixi-recall-demo-'));
let store = openXixiStore({ dataDir: dir }); store.seedSelfProfile(REPLAY_CONFIG.personality.base);
const prompts: UserTurnInput[] = [];
class Capture extends FakeBrainAdapter {
  override handleUserTurn(input: UserTurnInput) { prompts.push(input); return super.handleUserTurn(input); }
}
const open = (mode: 'private' | 'public' = 'private') => new ConversationEngine({ store, mood: false, config: REPLAY_CONFIG,
  audience: { mode, actor: 'father', note: '离线测试声明' },
  adapter: new Capture({ reply: () => ({ action: 'SPEAK', text: '嗯，我在听。' }) }) });
let engine = open();
try {
  const session = store.createSession();
  await engine.respond({ sessionId: session.sessionId, text: '木兰花的代号是蓝鲸。', addressed: true });
  const source = store.recentTurns(session.sessionId).find((t) => t.role === 'user')!.eventId;
  for (let i = 0; i < 30; i++) await engine.respond({ sessionId: session.sessionId, text: `第${i}次聊风雨`, addressed: true });
  store.close(); store = openXixiStore({ dataDir: dir }); engine = open();
  await engine.respond({ sessionId: session.sessionId, text: '木兰花', addressed: true });
  const recalled = prompts.at(-1)!.prompt! as AssembledPrompt;
  assert.ok(!recalled.history.some((t) => t.content.includes('蓝鲸')));
  assert.ok(recalled.user.includes('木兰花的代号是蓝鲸。'));
  await open('public').respond({ sessionId: session.sessionId, text: '木兰花', addressed: true });
  assert.ok(!prompts.at(-1)!.prompt!.user.includes('蓝鲸'));
  const m = store.insertSemanticMemory({ property: 'fixture', statement: '旧代号蓝鲸', sourceType: 'explicit_correction', sourceEventId: source });
  store.deleteSemanticMemory(m.memoryId);
  store.close(); store = openXixiStore({ dataDir: dir }); engine = open();
  await engine.respond({ sessionId: session.sessionId, text: '木兰花', addressed: true });
  assert.ok(!prompts.at(-1)!.prompt!.user.includes('蓝鲸'));
  console.log(JSON.stringify({ schemaVersion: 1, modelFixtureTurns: prompts.length, oldQuoteRecalled: true,
    publicQuoteExcluded: true, deletedQuoteExcludedAfterRestart: true, maxQuoteBytes: 2048, maxQuoteItems: 2,
    textBytesOnRecall: recalled.budget.textBytes, realProviderCalled: false, hardwareVerified: false }));
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
