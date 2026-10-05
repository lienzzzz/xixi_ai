import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolRegistry, type AgentTool } from '@xixi/brain-adapter';

const context = { scope: 'conversation' as const, timezone: 'Asia/Shanghai', now: new Date('2026-10-05T08:00:00+08:00') };

test('tool schemas refuse invalid values before any execution', async () => {
  let calls = 0;
  const tool: AgentTool = {
    name: 'boundary_probe', description: 'offline', risk: 'write', scopes: ['conversation'],
    parameters: { type: 'object', required: ['count', 'target'], additionalProperties: false, properties: {
      count: { type: 'integer', minimum: 1, maximum: 3 },
      target: { type: 'object', required: ['mode'], additionalProperties: false, properties: { mode: { type: 'string', enum: ['local'] } } },
    } },
    async execute() { calls++; return { done: true }; },
  };
  const registry = new ToolRegistry({ tools: [tool] });
  for (const args of [{}, { count: '2', target: { mode: 'local' } }, { count: 4, target: { mode: 'local' } }, { count: 2, target: { mode: 'remote' } }]) {
    const result = await registry.execute({ name: tool.name, arguments: args }, context);
    assert.equal(result.record.ok, false);
  }
  assert.equal(calls, 0);
  assert.equal((await registry.execute({ name: tool.name, arguments: { count: 2, target: { mode: 'local' } } }, context)).record.ok, true);
  assert.equal(calls, 1);
  registry.register({ ...tool, name: 'unsupported_schema', parameters: { type: 'object', oneOf: [] } });
  assert.equal((await registry.execute({ name: 'unsupported_schema', arguments: {} }, context)).record.ok, false);
  assert.equal(calls, 1);
  registry.register({ ...tool, name: 'annotated_schema', parameters: { ...tool.parameters, $comment: 'metadata only' } });
  assert.equal((await registry.execute({ name: 'annotated_schema', arguments: { count: 2, target: { mode: 'local' } } }, context)).record.ok, true);
});

test('a timed out write requests cancellation and reports an unknown outcome', async () => {
  let cancelled = false;
  const tool: AgentTool = {
    name: 'slow_write', description: 'offline', risk: 'write', scopes: ['conversation'],
    parameters: { type: 'object', properties: {} }, timeoutMs: 10,
    async execute(_args, ctx) {
      const signal = (ctx as typeof ctx & { signal?: AbortSignal }).signal;
      return new Promise((resolve) => signal?.addEventListener('abort', () => { cancelled = true; resolve({ cancelled: true }); }, { once: true }));
    },
  };
  const result = await new ToolRegistry({ tools: [tool] }).execute({ name: tool.name, arguments: {} }, context);
  assert.equal(cancelled, true);
  assert.equal(result.record.ok, false);
  assert.equal(result.payload['outcome'], 'unknown');
  assert.equal(result.payload['retrySafe'], false);
});
