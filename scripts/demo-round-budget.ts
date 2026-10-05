/** Actual resident host with a local SSE fixture; no external network or credentials. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openXixiStore } from '@xixi/domain';
import { MimoClient } from '@xixi/model-adapters';
import type { MimoMessage } from '@xixi/model-adapters';
import { TerminalCompanion, REPLAY_CONFIG, REPO_ROOT, loadEndpointProfile } from '@xixi/runtime';
import type { BrainUsage } from '@xixi/brain-adapter';
import { buildDirectAdapter } from './chat.ts';

const dir = mkdtempSync(join(tmpdir(), 'xixi-round-demo-'));
let now = new Date('2026-10-05T09:00:00+08:00');
const store = openXixiStore({ dataDir: dir, clock: () => now }); store.seedSelfProfile(REPLAY_CONFIG.personality.base);
const config = { ...REPLAY_CONFIG, context: { budget: { max_prompt_bytes: 32768, max_round_bytes: 8192 } } };
let providerCalls = 0;
let smallExecutions = 0;
let largeExecutions = 0;
const reported: BrainUsage[] = [];
const spoken: string[] = [];
const client = new MimoClient({ apiKey: 'offline-fixture', fetchImpl: async (_url, init) => {
  providerCalls++;
  const body = JSON.parse(String(init?.body)) as { messages: MimoMessage[] };
  const latest = body.messages.at(-1)!;
  const hasResult = latest.role === 'tool';
  const delta = hasResult ? { content: '嗯，读到了。' } : { tool_calls: [{ index: 0,
    function: { name: latest.content.includes('大数据') ? 'probe.large' : 'probe.small', arguments: '{}' } }] };
  const event = { model: 'offline-fixture', usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23,
    prompt_tokens_details: { cached_tokens: 5 } }, choices: [{ delta, finish_reason: hasResult ? 'stop' : 'tool_calls' }] };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { status: 200 });
} });
const host = TerminalCompanion.open({ store, config, clock: () => now, profile: loadEndpointProfile(join(REPO_ROOT, 'config/ambient.example.json')),
  write: async (output) => { spoken.push(output.text); }, decide: () => ({ speak: false, reasonCode: 'wrong_moment' }),
  modelFactory: (registry) => {
    for (const name of ['probe.small', 'probe.large']) registry.register({ name, description: '本地离线读探针', risk: 'read', scopes: ['conversation'],
      parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => {
        if (name === 'probe.large') { largeExecutions++; return { data: 'x'.repeat(20000) }; }
        smallExecutions++; return { answer: 42 };
      } });
    const adapter = buildDirectAdapter({ config, toolChain: registry, client });
    return { provider: adapter.provider, describe: () => adapter.describe(), handleUserTurn: async (input) => {
      const stream = await adapter.handleUserTurn(input);
      void stream.result.then((result) => { if (result.usage !== undefined) reported.push(result.usage); }, () => {});
      return stream;
    } };
  } });
try {
  console.log('工具循环软件演示：真实宿主/registry/HTTP客户端，SSE本地替身，不调用供应商。');
  await host.handle('/alone');
  now = new Date(now.getTime() + 1000);
  await assert.rejects(host.handle('长'.repeat(3500)), /ROUND_CONTEXT_BUDGET_EXCEEDED/);
  assert.equal(providerCalls, 0);
  now = new Date(now.getTime() + 1000);
  await host.handle('读小数据');
  assert.equal(spoken.length, 1); assert.equal(providerCalls, 2); assert.equal(smallExecutions, 1);
  assert.equal(reported[0]?.promptTokens, 40); assert.equal(reported[0]?.cachedTokens, 10);
  now = new Date(now.getTime() + 1000);
  await assert.rejects(host.handle('读大数据'), /ROUND_CONTEXT_BUDGET_EXCEEDED/);
  assert.equal(providerCalls, 3); assert.equal(largeExecutions, 1); assert.equal(spoken.length, 1);
  assert.equal(store.readEvents({ type: 'conversation.decision' }).length, 3);
  console.log(JSON.stringify({ schemaVersion: 1, fixtureProviderCalls: providerCalls, readExecutions: smallExecutions + largeExecutions,
    completedOutputs: spoken.length, auditedDecisions: 3, budgetRefusals: 2, fakeUsage: reported[0], supplierCacheVerified: false, hardwareVerified: false }));
  console.log('工具循环软件验收通过；用量来自替身，不代表真实缓存收益。');
} finally { await host.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
