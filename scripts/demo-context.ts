/** Exercise the actual resident host with long offline text and a reopened durable store. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openXixiStore, MemoryStore } from '@xixi/domain';
import { FakeBrainAdapter } from '@xixi/brain-adapter';
import type { UserTurnInput } from '@xixi/brain-adapter';
import { TerminalCompanion, REPLAY_CONFIG, loadEndpointProfile, REPO_ROOT } from '@xixi/runtime';
import { promptTextBytes } from '@xixi/conversation';
import type { AssembledPrompt } from '@xixi/conversation';

const dir = mkdtempSync(join(tmpdir(), 'xixi-context-demo-'));
let now = new Date('2026-10-05T09:00:00+08:00');
let store = openXixiStore({ dataDir: dir, clock: () => now });
store.seedSelfProfile(REPLAY_CONFIG.personality.base);
const config = { ...REPLAY_CONFIG, context: { budget: { max_prompt_bytes: 8192, max_history_bytes: 2048 } } };
const profile = loadEndpointProfile(join(REPO_ROOT, 'config/ambient.example.json'));
const hashes = new Set<string>();
const privateHashes = new Set<string>();
let peakTextBytes = 0;
let peakHistoryBytes = 0;
let discardedHistoryMessages = 0;
let duplicateCurrentEvents = 0;
let modelTurns = 0;
let lastPrompt: AssembledPrompt | undefined;
class Observe extends FakeBrainAdapter {
  override handleUserTurn(input: UserTurnInput) {
    const p = input.prompt as AssembledPrompt;
    lastPrompt = p; modelTurns++;
    hashes.add(p.budget.prefixHash);
    if (input.actorId === 'father') privateHashes.add(p.budget.prefixHash);
    peakTextBytes = Math.max(peakTextBytes, promptTextBytes(p));
    peakHistoryBytes = Math.max(peakHistoryBytes, p.history.reduce((n, h) => n + Buffer.byteLength(h.content, 'utf8'), 0));
    discardedHistoryMessages += p.budget.droppedHistory;
    if (p.history.some((h) => h.role === 'user' && h.content === input.text) && input.text.startsWith('离线长轮次')) duplicateCurrentEvents++;
    assert.equal(p.budget.textBytes, promptTextBytes(p));
    assert.ok(promptTextBytes(p) <= 8192);
    return super.handleUserTurn(input);
  }
}
const open = () => TerminalCompanion.open({ store, config, profile, clock: () => now,
  modelFactory: () => new Observe({ reply: () => ({ action: 'SPEAK', text: '嗯，我在听。' }) }),
  decide: () => ({ speak: false, reasonCode: 'wrong_moment' }), write: async () => {} });
let host = open();
async function say(text: string) { now = new Date(now.getTime() + 1000); await host.handle(text); return lastPrompt!; }
const memoryText = (p: AssembledPrompt) => p.sections.find((s) => s.name === 'memories')?.text ?? '';
try {
  console.log('长对话软件演示：120轮文字、假模型、临时数据库，不调用API或硬件。');
  await host.handle('/alone');
  await say('我喜欢喝茉莉花茶');
  const original = store.semanticMemories().find((m) => m.statement.includes('茉莉花茶'));
  assert.ok(original);
  const session = host.snapshot().sessions['father.private'];
  for (let i = 0; i < 120; i++) {
    if (i === 60) {
      await host.close(); store.close();
      store = openXixiStore({ dataDir: dir, clock: () => now }); host = open();
      await host.handle('/alone');
    }
    await say(`离线长轮次${i}：${'今天聊聊院子里的天气和花草。'.repeat(80)}`);
  }
  assert.equal(host.snapshot().sessions['father.private'], session);
  assert.ok(memoryText(await say('茉莉花茶')).includes(original.statement));
  const memory = new MemoryStore(store);
  const replacement = memory.recordSemantic({ property: original.property, statement: '父亲不喜欢茉莉花茶。',
    sourceType: 'explicit_correction', confidence: 1, sourceEventId: store.recentTurns(session!, 2).find((t) => t.role === 'user')!.eventId });
  memory.supersedeSemantic({ memoryId: original.memoryId, supersededBy: replacement.memoryId, at: now, reason: '演示中的显式纠正' });
  const corrected = memoryText(await say('茉莉花茶'));
  assert.ok(corrected.includes(replacement.statement) && !corrected.includes(original.statement));
  memory.revokeSemantic({ memoryId: replacement.memoryId, at: now, reason: '演示中的显式撤销' });
  assert.ok(!memoryText(await say('茉莉花茶')).includes(replacement.statement));
  await host.handle('/guest 我喜欢喝咖啡');
  assert.ok(!memoryText(lastPrompt!).includes('茉莉花茶'));
  assert.ok(!lastPrompt!.history.some((m) => m.content.includes('茉莉花茶')));
  await host.handle('/alone');
  await say('继续聊吧');
  assert.equal(privateHashes.size, 1);
  assert.equal(duplicateCurrentEvents, 0);
  assert.ok(discardedHistoryMessages > 0 && peakHistoryBytes <= 2048);
  console.log(JSON.stringify({ schemaVersion: 1, longTurns: 120, modelTurns, peakTextBytes, peakHistoryBytes,
    discardedHistoryMessages, duplicateCurrentEvents, stablePrefixVariants: privateHashes.size, overallPrefixVariants: hashes.size,
    storeReopened: true, privateSessionRestored: true, correctionAndRevocationVerified: true, guestIsolated: true,
    supplierCacheVerified: false, humanConversationQualityVerified: false, hardwareVerified: false }));
  console.log('上下文软件验收通过；字节预算不等于token预算或供应商缓存命中。');
} finally { await host.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
