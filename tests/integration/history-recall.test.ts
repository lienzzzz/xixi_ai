import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openXixiStore } from '@xixi/domain';
import { ConversationEngine } from '@xixi/conversation';
import { FakeBrainAdapter, type UserTurnInput } from '@xixi/brain-adapter';
import { REPLAY_CONFIG } from '@xixi/runtime';

test('private same-session old raw quotes are bounded, restartable and respect history invalidation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-history-recall-'));
  let store = openXixiStore({ dataDir: dir }); store.seedSelfProfile(REPLAY_CONFIG.personality.base);
  const prompts: UserTurnInput[] = [];
  class Capture extends FakeBrainAdapter {
    override handleUserTurn(input: UserTurnInput) { prompts.push(input); return super.handleUserTurn(input); }
  }
  const open = (mode: 'private' | 'public' = 'private', enabled = true) => new ConversationEngine({ store, mood: false,
    config: { ...REPLAY_CONFIG, context: { ...REPLAY_CONFIG.context, history_recall: { enabled } } },
    audience: { mode, actor: 'father', note: '离线测试声明' },
    adapter: new Capture({ reply: () => ({ action: 'SPEAK', text: '嗯，我在听。' }) }) });
  let engine = open();
  try {
    const session = store.createSession(); const other = store.createSession();
    await engine.respond({ sessionId: session.sessionId, text: '木兰花的代号是蓝鲸。', addressed: true });
    const source = store.recentTurns(session.sessionId).find((t) => t.role === 'user')!.eventId;
    await engine.respond({ sessionId: other.sessionId, text: '木兰花的访客密码是禁止跨会话。', addressed: true });
    for (let i = 0; i < 12; i++) await engine.respond({ sessionId: session.sessionId, text: `聊第${i}次天气和雨水`, addressed: true });
    store.close(); store = openXixiStore({ dataDir: dir }); engine = open();
    await engine.respond({ sessionId: session.sessionId, text: '木兰花', addressed: true });
    const p = prompts.at(-1)!.prompt!;
    assert.ok(!p.history.some((t) => t.content.includes('蓝鲸')));
    assert.ok(p.user.includes('木兰花的代号是蓝鲸。'));
    assert.ok(!p.user.includes('禁止跨会话'));
    assert.ok(!p.system.includes('蓝鲸'));
    assert.equal(p.user.split('【用户这句话】').at(-1)!.split('木兰花').length, 2);
    const privatePrefix = p.system;
    await open('private', false).respond({ sessionId: session.sessionId, text: '木兰花', addressed: true });
    assert.ok(!prompts.at(-1)!.prompt!.user.includes('木兰花的代号是蓝鲸。'));
    const publicEngine = open('public');
    await publicEngine.respond({ sessionId: session.sessionId, text: '木兰花', addressed: true });
    assert.ok(!prompts.at(-1)!.prompt!.user.includes('木兰花的代号是蓝鲸。'));
    await engine.respond({ sessionId: session.sessionId, text: '木兰花的代号是蓝鲸。', addressed: true });
    const repeatedCurrent = prompts.at(-1)!.prompt!;
    assert.ok(!repeatedCurrent.user.includes('【更早的用户原话'));
    await engine.respond({ sessionId: session.sessionId, text: '木兰花', addressed: true });
    const repeatedRecent = prompts.at(-1)!.prompt!;
    assert.ok(repeatedRecent.history.some((t) => t.content === '木兰花的代号是蓝鲸。'));
    assert.ok(!repeatedRecent.user.includes('木兰花的代号是蓝鲸。'));
    const memory = store.insertSemanticMemory({ statement: '木兰花的代号是蓝鲸。', property: 'fixture', sourceEventId: source, sourceType: 'explicit_correction' });
    assert.equal(store.deleteSemanticMemory(memory.memoryId), true);
    store.close(); store = openXixiStore({ dataDir: dir }); engine = open();
    await engine.respond({ sessionId: session.sessionId, text: '木兰花', addressed: true });
    assert.ok(!prompts.at(-1)!.prompt!.user.includes('蓝鲸'));
    assert.equal(prompts.at(-1)!.prompt!.system, privatePrefix);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
