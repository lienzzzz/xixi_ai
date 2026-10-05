import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openXixiStore } from '@xixi/domain';
import { ConversationEngine } from '@xixi/conversation';
import { MimoBrainAdapter, ToolRegistry } from '@xixi/brain-adapter';
import { MimoClient } from '@xixi/model-adapters';
import { REPLAY_CONFIG } from '@xixi/runtime';

function rig(fetchImpl: typeof fetch, registry = new ToolRegistry()) {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-round-engine-'));
  const now = new Date('2026-10-05T09:00:00+08:00');
  const store = openXixiStore({ dataDir: dir, clock: () => now }); store.seedSelfProfile(REPLAY_CONFIG.personality.base);
  const session = store.createSession();
  const engine = new ConversationEngine({ store, clock: () => now, mood: false, config: { ...REPLAY_CONFIG,
    context: { budget: { max_prompt_bytes: 32768, max_round_bytes: 8192 } } },
    adapter: new MimoBrainAdapter({ registry, client: new MimoClient({ apiKey: 'offline-fixture', fetchImpl }) }) });
  return { store, session, engine, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('configured round data cap is checked at the actual provider seam and failure is audited', async () => {
  let requests = 0;
  const r = rig(async () => { requests++; throw new Error('must not call fixture'); });
  try {
    const text = '长'.repeat(3500);
    await assert.rejects(r.engine.respond({ sessionId: r.session.sessionId, text, addressed: true }), /ROUND_CONTEXT_BUDGET_EXCEEDED/);
    assert.equal(requests, 0);
    assert.equal(r.store.recentTurns(r.session.sessionId)[0]?.text, text);
    const decision = r.store.readEvents({ type: 'conversation.decision', sessionId: r.session.sessionId });
    assert.equal(decision.length, 1);
    assert.equal((decision[0]!.payload as { action: string }).action, 'SILENCE');
    assert.ok(r.store.readEvents({ type: 'system.health' }).some((e) => JSON.stringify(e.payload).includes('ROUND_CONTEXT_BUDGET_EXCEEDED')));
  } finally { r.close(); }
});
test('ConversationTurn carries aggregated reported usage after a real registry tool round', async () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({ name: 'probe.read', description: '本地读', risk: 'read', scopes: ['conversation'], parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ answer: 42 }) });
  const r = rig(async () => {
    calls++;
    const event = { usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_tokens_details: { cached_tokens: 5 } },
      choices: [{ delta: calls === 1 ? { tool_calls: [{ index: 0, function: { name: 'probe.read', arguments: '{}' } }] } : { content: '读到了。' }, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { status: 200 });
  }, registry);
  try {
    const turn = await r.engine.respond({ sessionId: r.session.sessionId, text: '读一下', addressed: true });
    assert.equal(turn.action, 'SPEAK'); assert.equal(turn.usage?.status, 'complete');
    assert.equal(turn.usage?.promptTokens, 40); assert.equal(turn.usage?.cachedTokens, 10);
    assert.equal(turn.usage?.modelRounds, 2); assert.equal(turn.usage?.reasoningTokens, null);
  } finally { r.close(); }
});
