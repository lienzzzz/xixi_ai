import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptAssembler, HARD_POLICY, ConversationEngine, worldStateLite } from '@xixi/conversation';
import { FakeBrainAdapter } from '@xixi/brain-adapter';
import type { UserTurnInput } from '@xixi/brain-adapter';
import { openXixiStore } from '@xixi/domain';
import { REPLAY_CONFIG } from '@xixi/runtime';

const assembler = new PromptAssembler();
const now = new Date('2026-10-05T09:00:00+08:00');
function input() { return { identityName: '西西', personality: REPLAY_CONFIG.personality.base,
  world: worldStateLite(now, 'Asia/Shanghai', 480), conversationState: 'ACTIVE', turnIndex: 1,
  history: [] as { role: 'user' | 'assistant'; text: string }[], userText: '接着说吧' }; }
function bytes(prompt: { system: string; user: string; history: readonly { content: string }[] }) {
  return Buffer.byteLength(prompt.system + prompt.user, 'utf8') + prompt.history.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0);
}

test('changing mood, time and audience keeps the system prefix while dynamic facts remain visible', () => {
  const first = assembler.assemble({ ...input(), mood: { valence: 0.1, energy: 0.2, prose: ['今天安静一些。'] }, audience: { lines: ['只有主人在听。'] } });
  const second = assembler.assemble({ ...input(), world: worldStateLite(new Date(now.getTime() + 60000), 'Asia/Shanghai', 480),
    mood: { valence: 0.9, energy: 0.8, prose: ['今天轻快一些。'] }, audience: { lines: ['有访客在听。'] } });
  assert.equal(first.system, second.system);
  assert.match(first.user, /安静一些|只有主人/);
  assert.match(second.user, /轻快一些|有访客/);
  assert.ok(first.system.includes(HARD_POLICY));
  assert.notEqual(assembler.assemble({ ...input(), identityName: '另一个名字' }).system, first.system);
});

test('history byte budget retains a whole-message suffix and complete current input', () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: `轮次${i}：${'天气不错😀'.repeat(70)}` }));
  const prompt = assembler.assemble({ ...input(), history, budget: { maxPromptBytes: 8192, maxHistoryBytes: 2048 } });
  assert.ok(bytes(prompt) <= 8192);
  assert.ok(prompt.history.reduce((n, t) => n + Buffer.byteLength(t.content), 0) <= 2048);
  assert.ok(prompt.history.length > 0 && prompt.history.length < history.length);
  assert.deepEqual(prompt.history, history.slice(-prompt.history.length).map((t) => ({ role: t.role, content: t.text })));
  assert.match(prompt.user, /接着说吧/);
});

test('large auxiliary context loses whole rows without cutting policy or current input', () => {
  const lines = Array.from({ length: 9 }, (_, i) => `完整记忆${i}：${'家庭事情'.repeat(180)}`);
  const prompt = assembler.assemble({ ...input(), memories: { lines, injected: 9, droppedAtRender: 0 },
    relationship: { lines: ['相处记录'.repeat(900)] }, budget: { maxPromptBytes: 8192, maxHistoryBytes: 2048 } });
  assert.ok(bytes(prompt) <= 8192);
  assert.ok(prompt.system.includes(HARD_POLICY));
  for (const line of lines) if (prompt.user.includes(line.slice(0, 8))) assert.ok(prompt.user.includes(line));
  assert.ok(!prompt.user.includes('相处记录'.repeat(900)));
});

test('mandatory text overflow is an explicit failure instead of silent truncation', () => {
  assert.throws(() => assembler.assemble({ ...input(), userText: '用户完整话语'.repeat(1000),
    budget: { maxPromptBytes: 8192, maxHistoryBytes: 0 } }), /CONTEXT_BUDGET_EXCEEDED/);
});

class Capture extends FakeBrainAdapter {
  readonly inputs: UserTurnInput[] = [];
  override handleUserTurn(value: UserTurnInput) { this.inputs.push(value); return super.handleUserTurn(value); }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xixi-context-test-'));
  const store = openXixiStore({ dataDir: root, clock: () => now });
  store.seedSelfProfile(REPLAY_CONFIG.personality.base);
  const session = store.createSession();
  const adapter = new Capture();
  const engine = new ConversationEngine({ store, adapter, config: { ...REPLAY_CONFIG,
    context: { budget: { max_prompt_bytes: 8192, max_history_bytes: 2048 } } }, clock: () => now, mood: false });
  return { store, session, engine, adapter, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('real respond excludes only the current event, preserving a repeated previous utterance', async () => {
  const r = fixture();
  try {
    await r.engine.respond({ sessionId: r.session.sessionId, text: '这句重复原话', addressed: true });
    assert.equal(r.adapter.inputs[0]!.prompt!.history.filter((m) => m.content === '这句重复原话').length, 0);
    await r.engine.respond({ sessionId: r.session.sessionId, text: '这句重复原话', addressed: true });
    assert.equal(r.adapter.inputs[1]!.prompt!.history.filter((m) => m.role === 'user' && m.content === '这句重复原话').length, 1);
    assert.equal(r.store.recentTurns(r.session.sessionId, 20).filter((t) => t.role === 'user').length, 2);
  } finally { r.close(); }
});

test('config budget is enforced before invoking the actual provider seam', async () => {
  const r = fixture();
  try {
    const text = '这是很长的原话'.repeat(800);
    await assert.rejects(r.engine.respond({ sessionId: r.session.sessionId, text, addressed: true }), /CONTEXT_BUDGET_EXCEEDED/);
    assert.equal(r.adapter.inputs.length, 0);
    assert.equal(r.store.recentTurns(r.session.sessionId)[0]?.text, text);
    const decisions = r.store.readEvents({ type: 'conversation.decision', sessionId: r.session.sessionId });
    assert.equal(decisions.length, 1);
    assert.equal((decisions[0]!.payload as { action: string }).action, 'SILENCE');
    const health = r.store.readEvents({ type: 'system.health' });
    assert.ok(health.some((e) => JSON.stringify(e.payload).includes('CONTEXT_BUDGET_EXCEEDED')));
  } finally { r.close(); }
});
