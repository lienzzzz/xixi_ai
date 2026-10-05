import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolRegistry, runAgentLoop, MimoBrainAdapter, collectTurn } from '@xixi/brain-adapter';
import type { AgentStep, AgentTool } from '@xixi/brain-adapter';
import { MimoClient } from '@xixi/model-adapters';

const context = { timezone: 'Asia/Shanghai', clock: () => new Date('2026-10-05T09:00:00+08:00') };
async function drain(iterator: ReturnType<typeof runAgentLoop>) { for (;;) { const next = await iterator.next(); if (next.done) return next.value; } }
function probe(name: string, execute: AgentTool['execute'], risk: 'read' | 'write' = 'read'): AgentTool {
  return { name, description: '本地探针', parameters: { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: false },
    scopes: ['conversation'], risk, execute };
}

test('round data budget refuses escaped JSON or images before the first model call', async () => {
  let calls = 0;
  const step: AgentStep = { async *call() { calls++; return { model: 'fake', finishReason: 'stop', rawText: '', spokenText: '', toolCalls: [] }; } };
  for (const message of [
    { role: 'user' as const, content: '\n'.repeat(5000) },
    { role: 'user' as const, content: '图片', images: [{ mediaType: 'image/jpeg', base64: 'a'.repeat(10000) }] },
  ]) await assert.rejects(drain(runAgentLoop(step, [message], { registry: new ToolRegistry(), scope: 'conversation', context, maxRoundBytes: 8192 })), /ROUND_CONTEXT_BUDGET_EXCEEDED/);
  assert.equal(calls, 0);
});

test('an oversized tool call batch is refused before any write executes', async () => {
  let writes = 0;
  const registry = new ToolRegistry({ role: 'owner' });
  registry.register(probe('probe.write', async () => { writes++; return { done: true }; }, 'write'));
  const step: AgentStep = { async *call(_messages, _tools, round) { return { model: 'fake', finishReason: 'tool_calls', rawText: '', spokenText: '',
    toolCalls: round === 1 ? [{ id: 'big', name: 'probe.write', arguments: JSON.stringify({ message: 'x'.repeat(10000) }) }] : [] }; } };
  await assert.rejects(drain(runAgentLoop(step, [{ role: 'user', content: '请求' }], { registry, scope: 'conversation', context, maxRoundBytes: 8192 })), /ROUND_CONTEXT_BUDGET_EXCEEDED/);
  assert.equal(writes, 0);
});

test('a huge tool result stops the next model call and retains the one real execution', async () => {
  let executions = 0;
  let modelCalls = 0;
  const records: string[] = [];
  const registry = new ToolRegistry({ onToolCall: (r) => records.push(r.name) });
  registry.register(probe('probe.large', async () => { executions++; return { data: 'x'.repeat(20000) }; }));
  const step: AgentStep = { async *call(_messages, _tools, round) { modelCalls++; return { model: 'fake', finishReason: 'tool_calls', rawText: '', spokenText: '',
    toolCalls: round === 1 ? [{ id: 'one', name: 'probe.large', arguments: '{}' }] : [] }; } };
  await assert.rejects(drain(runAgentLoop(step, [{ role: 'user', content: '查一下' }], { registry, scope: 'conversation', context, maxRoundBytes: 8192 })), /ROUND_CONTEXT_BUDGET_EXCEEDED/);
  assert.equal(executions, 1); assert.equal(modelCalls, 1); assert.deepEqual(records, ['probe.large']);
});

test('tool definitions have the same serialized order across registry and object insertion orders', () => {
  const one = new ToolRegistry(); const two = new ToolRegistry();
  const tool = (name: string, reverse: boolean): AgentTool => ({ ...probe(name, async () => ({})),
    parameters: { type: 'object', properties: reverse ? { z: { type: 'string' }, a: { type: 'number' } } : { a: { type: 'number' }, z: { type: 'string' } }, additionalProperties: false } });
  one.register(tool('z.tool', true)); one.register(tool('a.tool', true));
  two.register(tool('a.tool', false)); two.register(tool('z.tool', false));
  assert.equal(JSON.stringify(one.definitionsForRound('conversation', 1)), JSON.stringify(two.definitionsForRound('conversation', 1)));
  assert.deepEqual(one.definitionsForRound('conversation', 1)!.map((t) => t.name), ['a.tool', 'z.tool']);
});

test('an oversized first result stops remaining writes in the same tool batch', async () => {
  let writes = 0;
  const registry = new ToolRegistry({ role: 'owner' });
  registry.register(probe('probe.read', async () => ({ data: 'x'.repeat(20000) })));
  registry.register(probe('probe.write', async () => { writes++; return { done: true }; }, 'write'));
  const step: AgentStep = { async *call(_messages, _tools, round) { return { model: 'fake', finishReason: 'tool_calls', rawText: '', spokenText: '',
    toolCalls: round === 1 ? [{ id: 'read', name: 'probe.read', arguments: '{}' }, { id: 'write', name: 'probe.write', arguments: '{}' }] : [] }; } };
  await assert.rejects(drain(runAgentLoop(step, [{ role: 'user', content: '请求' }], { registry, scope: 'conversation', context, maxRoundBytes: 8192 })), /ROUND_CONTEXT_BUDGET_EXCEEDED/);
  assert.equal(writes, 0);
});

function response(event: unknown) { return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }); }
test('real client and direct adapter aggregate reported SSE usage across both tool rounds', async () => {
  let calls = 0;
  const registry = new ToolRegistry(); registry.register(probe('probe.small', async () => ({ value: 42 })));
  const client = new MimoClient({ apiKey: 'offline-fixture', fetchImpl: async () => {
    calls++;
    return response({ model: 'fixture', usage: { prompt_tokens: calls === 1 ? 100 : 120, completion_tokens: calls === 1 ? 5 : 7,
      total_tokens: calls === 1 ? 105 : 127, prompt_tokens_details: { cached_tokens: calls === 1 ? 50 : 60 }, completion_tokens_details: { reasoning_tokens: 0 } },
      choices: [{ delta: calls === 1 ? { tool_calls: [{ index: 0, function: { name: 'probe.small', arguments: '{}' } }] } : { content: '读到了。' }, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] });
  } });
  const result = (await collectTurn(await new MimoBrainAdapter({ client, registry }).handleUserTurn({ sessionId: 'fixture', text: '查一下' }))).result;
  assert.equal(calls, 2);
  assert.deepEqual(result.usage, { schemaVersion: 1, status: 'complete', modelRounds: 2, reportedRounds: 2, cacheReportedRounds: 2, reasoningReportedRounds: 2,
    promptTokens: 220, completionTokens: 12, totalTokens: 232, reasoningTokens: 0, cachedTokens: 110 });
});

test('missing usage remains unavailable and missing cached tokens remains unknown', async () => {
  for (const usage of [undefined, { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 }]) {
    const client = new MimoClient({ apiKey: 'offline-fixture', fetchImpl: async () => response({ model: 'fixture', ...(usage === undefined ? {} : { usage }),
      choices: [{ delta: { content: '你好。' }, finish_reason: 'stop' }] }) });
    const result = (await collectTurn(await new MimoBrainAdapter({ client }).handleUserTurn({ sessionId: 'fixture', text: '你好' }))).result;
    assert.equal(result.usage?.status, usage === undefined ? 'unavailable' : 'complete');
    assert.equal(result.usage?.promptTokens, usage === undefined ? null : 20);
    assert.equal(result.usage?.cachedTokens, null);
  }
});

test('usage missing from one round is partial rather than a full cost or cache measurement', async () => {
  let calls = 0;
  const registry = new ToolRegistry(); registry.register(probe('probe.small', async () => ({ value: 42 })));
  const client = new MimoClient({ apiKey: 'offline-fixture', fetchImpl: async () => {
    calls++;
    return response({ ...(calls === 1 ? { usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } } : {}),
      choices: [{ delta: calls === 1 ? { tool_calls: [{ index: 0, function: { name: 'probe.small', arguments: '{}' } }] } : { content: '读到了。' }, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] });
  } });
  const result = (await collectTurn(await new MimoBrainAdapter({ client, registry }).handleUserTurn({ sessionId: 'fixture', text: '读一下' }))).result;
  assert.equal(result.usage?.status, 'partial'); assert.equal(result.usage?.modelRounds, 2);
  assert.equal(result.usage?.reportedRounds, 1); assert.equal(result.usage?.totalTokens, 23); assert.equal(result.usage?.cachedTokens, null);
});
