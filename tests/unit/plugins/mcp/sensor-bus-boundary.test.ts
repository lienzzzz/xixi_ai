import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ToolPermission, ToolRegistry, type AgentTool, type ToolExecutionContext } from '@xixi/brain-adapter';
import { CapabilityRegistry, CORE_PROMPT_AUTHORITY, PLUGIN_CAPABILITIES, PluginManager } from '@xixi/plugins';
import { createMcpPlugin } from '@xixi/plugins/mcp';

import { createStubMcpServer } from './stub-server.ts';

/**
 * Pack `03_AGENT_PLUGIN.md` §4, the last line: **「MCP 不作为高频 sensor bus」**。
 *
 * A boundary that only lives in a sentence is not a boundary, so this file turns it into three
 * checks that can fail:
 *
 *  1. **shape** — an MCP plugin's contribution offers `tool` and nothing else; the adapter has no
 *     subscribe/poll API at all;
 *  2. **counter** — with nobody calling a tool, the server sees *zero* calls and *zero* re-listings.
 *     A high-frequency path would show up here as a number that grows on its own;
 *  3. **source probe** — the MCP package's own sources must not reach for the perception/在场 path,
 *     and must not contain a timer that could drive one.
 *
 * The probe is deliberately written so it cannot pass by accident: it asserts the file list it
 * actually read (so a moved/renamed directory fails loudly instead of checking nothing).
 */

const CONTEXT: ToolExecutionContext = { scope: 'conversation', timezone: 'Asia/Shanghai', now: new Date('2026-10-05T09:00:00+08:00') };

const MCP_DIR = fileURLToPath(new URL('../../../../packages/plugins/mcp/', import.meta.url));

function mcpSources(): { readonly name: string; readonly text: string }[] {
  return readdirSync(MCP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({ name: entry.name, text: readFileSync(join(MCP_DIR, entry.name), 'utf8') }));
}

test('an MCP plugin contributes tools and nothing else: no sensor, no subscription, no context provider', async () => {
  const stub = createStubMcpServer({ name: 'weather', tools: [{ name: 'forecast', description: '看天气', text: '晴' }] });
  const { plugin, adapter } = createMcpPlugin({ servers: [{ name: 'weather', connect: stub.transportFactory }] });

  await adapter.discover();
  const contribution = adapter.contribution();

  assert.deepEqual(Object.keys(contribution), ['tools'], 'MCP 的贡献里只能有 tools 一项');
  for (const kind of ['topic_source', 'context_provider', 'sensor_source', 'action'] as const) {
    assert.equal((contribution as Record<string, unknown>)[kind], undefined, `MCP 不许贡献 ${kind}`);
  }
  assert.ok(PLUGIN_CAPABILITIES.includes('sensor_source'), '五种能力里确实有 sensor_source——正是因此要证明 MCP 没用它');

  // The plugin's manifest says the same thing: one capability, `tool`.
  const manifest = plugin.manifest as { capabilities?: readonly string[] };
  assert.deepEqual(manifest.capabilities, ['tool']);

  // And the adapter has no API an event loop could be hung on.
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
  for (const forbidden of ['subscribe', 'onEvent', 'poll', 'start', 'listen', 'watch']) {
    assert.ok(!surface.includes(forbidden), `适配器不该有 ${forbidden} 这样的入口：${surface.join('、')}`);
  }

  await adapter.dispose();
  await stub.dispose();
});

test('nothing about MCP runs on its own: with no tool call, the server sees no traffic', async () => {
  const stub = createStubMcpServer({ name: 'weather', tools: [{ name: 'forecast', description: '看天气', text: '晴' }] });
  const registry = new ToolRegistry();
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  const manager = new PluginManager({ host: { tools: registry, capabilities, corePrompt: CORE_PROMPT_AUTHORITY }, sources: [] });
  const { plugin, adapter } = createMcpPlugin({ servers: [{ name: 'weather', connect: stub.transportFactory }] });
  await manager.loadInline(plugin);

  const listingsAfterDiscovery = adapter.status()[0]?.stats.listings ?? 0;
  assert.equal(listingsAfterDiscovery, 1, '发现只做了 tools/list 一次');

  // Give an event loop every chance to do something it should not be doing.
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(stub.calls.length, 0, '没人调工具时，外部服务不该收到任何 tools/call');
  assert.equal(adapter.status()[0]?.stats.calls, 0, 'callTool 计数必须恒为 0');
  assert.equal(adapter.status()[0]?.stats.listings, listingsAfterDiscovery, '也不许偷偷重列工具（那就成了轮询）');
  assert.equal(stub.served, 1, '没有任何重连');

  // One deliberate call moves the counter by exactly one — the counter is measuring the right thing.
  const mounted = capabilities.values<{ tool: AgentTool }>('tool').map((spec) => registry.register(spec.tool));
  await registry.execute({ name: 'mcp.weather.forecast', arguments: '{}' }, CONTEXT);
  assert.equal(adapter.status()[0]?.stats.calls, 1);
  assert.equal(stub.calls.length, 1);

  for (const release of mounted) release.dispose();
  await manager.disposeAll();
  await stub.dispose();
});

test('the MCP sources do not touch the perception path, and hold no timer that could drive one', () => {
  const sources = mcpSources();
  assert.ok(sources.length >= 5, `探针要真的读到 MCP 的源码，实际只读到 ${sources.length} 个文件`);
  const names = sources.map((entry) => entry.name);
  for (const required of ['adapter.ts', 'connection.ts', 'naming.ts', 'plugin.ts', 'types.ts']) {
    assert.ok(names.includes(required), `探针该读到 ${required}，实际：${names.join('、')}`);
  }

  // 1. No import of the perception/在场 side, and no event-stream vocabulary at all.
  const forbiddenImports = ['perception', '@xixi/runtime', 'world-state', 'presence', 'SensorEvent', 'SensorSource', 'sensor_source'];
  for (const source of sources) {
    for (const token of forbiddenImports) {
      assert.ok(!source.text.includes(token), `${source.name} 里出现了「${token}」：MCP 不许碰感知/在场通路`);
    }
  }

  // 2. Exactly one timer family, and it is request-scoped: the per-request timeout in `connection.ts`
  //    and the injected retry sleep. A polling loop would need `setInterval` (or a scheduler import).
  for (const source of sources) {
    assert.ok(!source.text.includes('setInterval'), `${source.name} 里有 setInterval：那就是轮询，不是工具调用`);
    assert.ok(!source.text.includes('setImmediate'), `${source.name} 里有 setImmediate`);
    assert.ok(!/from 'node:timers/.test(source.text), `${source.name} 引入了 node:timers`);
  }
  const withTimeout = sources.filter((source) => source.text.includes('setTimeout')).map((source) => source.name);
  assert.deepEqual(withTimeout, ['connection.ts'], `只有连接层允许有超时定时器，实际：${withTimeout.join('、')}`);

  // 3. The one place a timer exists is bounded by a constant, not by an interval.
  const connection = sources.find((source) => source.name === 'connection.ts');
  assert.match(String(connection?.text), /DEFAULT_MCP_REQUEST_TIMEOUT_MS/, '超时必须来自常量');
  assert.match(String(connection?.text), /clearTimeout/, '超时定时器必须被清掉');
});
