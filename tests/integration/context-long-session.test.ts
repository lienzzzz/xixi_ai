import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBrainAdapter } from '@xixi/brain-adapter';
import type { UserTurnInput } from '@xixi/brain-adapter';
import { openXixiStore, MemoryStore } from '@xixi/domain';
import { TerminalCompanion, REPLAY_CONFIG, parseEndpointProfile } from '@xixi/runtime';
import { promptTextBytes } from '@xixi/conversation';
import type { AssembledPrompt } from '@xixi/conversation';

test('real resident context remains bounded across long history, database reopen and audience changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xixi-long-context-'));
  let now = new Date('2026-10-05T09:00:00+08:00');
  let store = openXixiStore({ dataDir: root, clock: () => now });
  store.seedSelfProfile(REPLAY_CONFIG.personality.base);
  const config = { ...REPLAY_CONFIG, context: { budget: { max_prompt_bytes: 8192, max_history_bytes: 2048 } } };
  const profile = parseEndpointProfile({ schemaVersion: 1, roomId: 'context-test', devices: [
    { id: 'manual', kind: 'camera', roomId: 'context-test', adapter: 'filtered-events' },
    { id: 'text', kind: 'microphone', roomId: 'context-test', adapter: 'filtered-events' },
    { id: 'output', kind: 'speaker', roomId: 'context-test', adapter: 'simulated-playback' },
  ] });
  const prompts: AssembledPrompt[] = [];
  class Capture extends FakeBrainAdapter {
    override handleUserTurn(input: UserTurnInput) { prompts.push(input.prompt as AssembledPrompt); return super.handleUserTurn(input); }
  }
  const open = () => TerminalCompanion.open({ store, config, profile, clock: () => now,
    modelFactory: () => new Capture({ reply: () => ({ action: 'SPEAK', text: '嗯，我在听。' }) }),
    decide: () => ({ speak: false, reasonCode: 'wrong_moment' }), write: async () => {} });
  let host = open();
  const say = async (text: string) => { now = new Date(now.getTime() + 1000); await host.handle(text); return prompts.at(-1)!; };
  const memories = (p: AssembledPrompt) => p.sections.find((s) => s.name === 'memories')?.text ?? '';
  try {
    await host.handle('/alone');
    await say('我喜欢喝茉莉花茶');
    const original = store.semanticMemories().find((m) => m.statement.includes('茉莉花茶'));
    assert.ok(original);
    for (let i = 0; i < 36; i++) {
      const text = `这一轮${i}：${'今天聊聊院子里的天气和花草。'.repeat(80)}`;
      const p = await say(text);
      assert.ok(promptTextBytes(p) <= 8192);
      assert.equal(p.history.some((m) => m.role === 'user' && m.content === text), false);
      assert.equal(p.budget.textBytes, promptTextBytes(p));
    }
    assert.ok(prompts.some((p) => p.budget.droppedHistory > 0));
    assert.equal(new Set(prompts.map((p) => p.budget.prefixHash)).size, 1);
    const privateSession = host.snapshot().sessions['father.private'];
    await host.close(); store.close();
    store = openXixiStore({ dataDir: root, clock: () => now }); host = open();
    await host.handle('/alone');
    const recovered = await say('茉莉花茶');
    assert.equal(host.snapshot().sessions['father.private'], privateSession);
    assert.ok(memories(recovered).includes(original.statement));
    const memory = new MemoryStore(store);
    const replacement = memory.recordSemantic({ property: original.property, statement: '父亲不喜欢茉莉花茶。', sourceType: 'explicit_correction',
      sourceEventId: store.recentTurns(privateSession!, 2).find((t) => t.role === 'user')!.eventId, confidence: 1 });
    memory.supersedeSemantic({ memoryId: original.memoryId, supersededBy: replacement.memoryId, at: now, reason: '测试中的显式纠正' });
    const corrected = await say('茉莉花茶');
    assert.ok(!memories(corrected).includes(original.statement));
    assert.ok(memories(corrected).includes(replacement.statement));
    memory.revokeSemantic({ memoryId: replacement.memoryId, at: now, reason: '测试中的显式撤销' });
    assert.ok(!memories(await say('茉莉花茶')).includes(replacement.statement));
    const count = store.semanticMemories().length;
    await host.handle('/guest 我喜欢喝咖啡');
    const guest = prompts.at(-1)!;
    assert.ok(!memories(guest).includes('茉莉花茶'));
    assert.ok(!guest.history.some((m) => m.content.includes('茉莉花茶')));
    assert.equal(store.semanticMemories().length, count);
    await host.handle('/alone');
    assert.equal((await say('继续聊吧')).budget.prefixHash, recovered.budget.prefixHash);
  } finally { await host.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
