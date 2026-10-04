import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryTransport } from '@modelcontextprotocol/client';
import { ToolPermission, ToolRegistry, type AgentTool, type ToolExecutionContext } from '@xixi/brain-adapter';
import { parseXixiConfig } from '@xixi/domain';
import { CapabilityRegistry, CORE_PROMPT_AUTHORITY, PluginManager } from '@xixi/plugins';
import { createMcpPlugin, type McpClientLike } from '@xixi/plugins/mcp';
import { buildPluginRuntime } from '@xixi/runtime';

import { createStubMcpServer } from './stub-server.ts';

/**
 * Pack §4 — 「工具发现失败不得让入口崩」, and the reconnect/retry evidence the acceptance asks for.
 *
 * The rule these tests defend: **an external service's problems are 西西's absence of those tools,
 * never 西西's crash.** So the assertions are about what the entry point looks like afterwards — the
 * four built-ins still offered, the plugin loaded, the health report saying what is wrong — and about
 * the counters that make a retry visible.
 */

const CONFIG = parseXixiConfig(`
xixi:
  identity:
    name: 西西
    language: zh-CN
    timezone: Asia/Shanghai
    place: 成都
  models:
    llm: { provider: mimo, model: mimo-v2.6-flash, thinking_realtime: false }
    asr: { provider: mimo, model: asr-1 }
    tts: { provider: mimo, model: tts-1 }
  personality:
    base: {}
  proactive: {}
  memory: {}
  privacy: {}
  features: {}
`);

const CONTEXT: ToolExecutionContext = { scope: 'conversation', timezone: 'Asia/Shanghai', now: new Date('2026-10-05T09:00:00+08:00') };
const BUILT_INS = ['xixi_get_current_time', 'xixi_get_weather', 'xixi_news_stub', 'xixi_set_reminder_stub'];
const FAILING = (): never => {
  throw new Error('服务器没起来');
};

test('a server that cannot be reached is “these tools are not here today”, not a crash', async () => {
  const mount = buildPluginRuntime(CONFIG, {
    mcpServers: [{ name: 'weather', connect: FAILING, retry: { attempts: 1, delayMs: 1 } }],
  });

  // The entry point comes up: no throw here is the whole point of the test.
  const started = await mount.runtime.start();
  const report = mount.mount();
  assert.deepEqual(report.mounted, []);
  assert.deepEqual(started.map((entry) => entry.state), ['active'], '插件本身是活的，只是没有工具');

  const instance = mount.runtime.manager.instance('xixi.mcp');
  assert.equal(instance?.state, 'active');
  assert.deepEqual(instance?.capabilities, []);
  assert.equal(instance?.health?.status, 'down');
  assert.match(String(instance?.health?.detail), /一个工具都没有|weather=failed/);

  // The chain the model gets is exactly the old one: the four built-ins, nothing missing, nothing broken.
  assert.deepEqual(mount.registry.names().sort(), [...BUILT_INS].sort());
  assert.equal((mount.registry.definitionsForRound('conversation', 1) ?? []).length, 4);

  // And a model that somehow asks for a name that is not there still gets a refusal, not a crash.
  const missing = await mount.registry.execute({ name: 'mcp.weather.forecast', arguments: '{}' }, CONTEXT);
  assert.equal(missing.record.error, 'UNKNOWN_TOOL');

  await mount.runtime.stop();
});

test('a connect that fails once and then succeeds is retried — and the retry is visible in the counters', async () => {
  const stub = createStubMcpServer({ name: 'weather', tools: [{ name: 'forecast', description: '看天气', text: '晴' }], failConnects: 1 });
  const mount = buildPluginRuntime(CONFIG, {
    mcpServers: [{ name: 'weather', connect: stub.transportFactory, retry: { attempts: 3, delayMs: 1 } }],
  });

  await mount.runtime.start();
  const report = mount.mount();
  assert.deepEqual(report.mounted, ['mcp.weather.forecast'], '重试之后工具必须真的在');
  assert.equal(stub.factoryCalls, 2, '第一次工厂调用是失败的，第二次才成');
  assert.equal(stub.served, 1);

  const status = mount.mcp?.status() ?? [];
  assert.equal(status.length, 1);
  assert.equal(status[0]?.state, 'connected');
  assert.equal(status[0]?.stats.attempts, 2, 'attempts 记了两次');
  assert.equal(status[0]?.stats.connects, 1);
  const kinds = (mount.mcp?.events ?? []).map((event) => event.kind);
  assert.deepEqual(kinds.slice(0, 2), ['retry', 'connect'], `事件轨迹该是 retry→connect，实际：${kinds.join('、')}`);
  assert.match(String(mount.mcp?.events[0]?.detail), /没起来/);

  await mount.runtime.stop();
  await stub.dispose();
});

test('a connection that drops mid-life is noticed, reconnected, and the call still answers', async () => {
  const stub = createStubMcpServer({ name: 'weather', tools: [{ name: 'forecast', description: '看天气', text: '晴' }] });
  const mount = buildPluginRuntime(CONFIG, {
    mcpServers: [{ name: 'weather', connect: stub.transportFactory, retry: { attempts: 2, delayMs: 1 } }],
  });
  await mount.runtime.start();
  mount.mount();

  const first = await mount.registry.execute({ name: 'mcp.weather.forecast', arguments: '{}' }, CONTEXT);
  assert.equal(first.record.ok, true);

  // The server goes away between two calls — the failure mode a long-running household actually sees.
  await stub.closeServerSide();
  const second = await mount.registry.execute({ name: 'mcp.weather.forecast', arguments: '{}' }, CONTEXT);

  assert.equal(second.record.ok, true, `断线之后的一次调用该靠重连自己补上：${JSON.stringify(second.record.error)}`);
  assert.equal(second.record.result?.['text'], '晴');
  assert.equal(stub.served, 2, '第二次服务实例是重连建起来的');

  const status = mount.mcp?.status() ?? [];
  assert.equal(status[0]?.stats.reconnects, 1, 'reconnects 必须记到 1');
  assert.equal(status[0]?.stats.connects, 1);
  const kinds = (mount.mcp?.events ?? []).map((event) => event.kind);
  assert.ok(kinds.includes('disconnect'), `事件轨迹里该有 disconnect：${kinds.join('、')}`);
  assert.ok(kinds.includes('reconnect'), `事件轨迹里该有 reconnect：${kinds.join('、')}`);
  assert.equal(stub.calls.length, 2);

  await mount.runtime.stop();
  await stub.dispose();
});

test('a server that answers with isError is a readable result, and one that never answers at all is a readable absence', async () => {
  const stub = createStubMcpServer({
    name: 'weather',
    tools: [{ name: 'forecast', description: '看天气', failWith: '上游超时了' }],
  });
  const registry = new ToolRegistry();
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  const manager = new PluginManager({ host: { tools: registry, capabilities, corePrompt: CORE_PROMPT_AUTHORITY }, sources: [] });
  const { plugin } = createMcpPlugin({ servers: [{ name: 'weather', connect: stub.transportFactory }] });
  await manager.loadInline(plugin);
  const mounted = capabilities.values<{ tool: AgentTool }>('tool').map((spec) => registry.register(spec.tool));

  // 1. The server ran and said "this failed": the model gets the server's own words in the payload.
  //    Two `ok`s on purpose: the registry's means "the tool ran", the payload's means "the external
  //    service said yes". An MCP `isError` is a *business* answer, not our exception — so it is not
  //    recorded as a broken core tool.
  const failed = await registry.execute({ name: 'mcp.weather.forecast', arguments: '{}' }, CONTEXT);
  assert.equal(failed.record.ok, true, '工具跑完了');
  assert.equal(failed.record.result?.['ok'], false, '外部服务说这次失败了');
  assert.equal(failed.record.result?.['text'], '上游超时了');
  assert.match(String(failed.record.result?.['note']), /不要编造/, '失败要直说，不许编（pack §6 的诚实性同款）');

  // 2. A tool name that was never discovered: refused by the registry, and the adapter says why.
  const unknown = await registry.execute({ name: 'mcp.weather.not_a_tool', arguments: '{}' }, CONTEXT);
  assert.equal(unknown.record.error, 'UNKNOWN_TOOL');

  // 3. The adapter's own view of an unknown name is a value too (used when a caller reaches it directly).
  const adapter = createMcpPlugin({ servers: [{ name: 'weather', connect: stub.transportFactory }] }).adapter;
  await adapter.discover();
  assert.deepEqual(await adapter.invoke('mcp.nope.tool', {}), { ok: false, error: '没有这个 MCP 工具：mcp.nope.tool' });

  for (const release of mounted) release.dispose();
  await manager.disposeAll();
  await adapter.dispose();
  await stub.dispose();
});

test('a transport that dies without telling anyone is recovered by the reconnect path', async () => {
  // The *other* reconnect path. The test above rides the SDK's own `onclose` (the server closed the
  // link, so the state flips before the next call). This one is the case where nothing tells us: the
  // first call fails outright, and the only way the second one can answer is the connection noticing,
  // reconnecting once and retrying. Both paths must be exercised, or one of them is decoration.
  const state = { connects: 0, calls: 0 };
  let failNext = true;
  const createClient = (): McpClientLike => ({
    async connect() {
      state.connects += 1;
    },
    async close() {
      /* the fake stays silent on purpose: no onclose is ever fired */
    },
    async listTools() {
      return { tools: [{ name: 'forecast', description: '看天气' }] };
    },
    async callTool() {
      state.calls += 1;
      if (failNext) {
        failNext = false;
        throw new Error('Not connected');
      }
      return { content: [{ type: 'text', text: '晴' }] };
    },
  });
  // The injected client ignores its transport argument; a real linked end keeps the type honest.
  const [transport] = InMemoryTransport.createLinkedPair();

  const { adapter } = createMcpPlugin({
    // `createClient` is an adapter-level seam (how to build the SDK client), not a per-server one.
    createClient,
    servers: [{ name: 'weather', connect: () => transport, retry: { attempts: 2, delayMs: 1 } }],
  });
  await adapter.discover();

  const result = await adapter.invoke('mcp.weather.forecast', {});
  assert.equal(result['ok'], true, `第一次失败之后该重连重试：${JSON.stringify(result)}`);
  assert.equal(result['text'], '晴');
  assert.equal(state.connects, 2, '连了两次：初次 + 重连');
  assert.equal(state.calls, 2, '调用被转发两次：第一次失败、重试成功');
  assert.equal(adapter.status()[0]?.stats.failures, 1);
  assert.equal(adapter.status()[0]?.stats.reconnects, 1);

  const kinds = adapter.events.map((event) => event.kind);
  assert.ok(kinds.includes('failure'), `事件里该记下失败：${kinds.join('、')}`);
  assert.ok(kinds.indexOf('reconnect') > kinds.indexOf('failure'), `重连要发生在失败之后：${kinds.join('、')}`);

  await adapter.dispose();
  await transport.close().catch(() => {});
});

test('an unreachable server does not hide the reachable one', async () => {
  const good = createStubMcpServer({ name: 'calendar', tools: [{ name: 'list_events', description: '看日程', text: '没有安排' }] });
  const { adapter } = createMcpPlugin({
    servers: [
      { name: 'weather', connect: FAILING, retry: { attempts: 1, delayMs: 1 } },
      { name: 'calendar', connect: good.transportFactory, retry: { attempts: 1, delayMs: 1 } },
    ],
  });

  const discovery = await adapter.discover();
  assert.deepEqual(discovery.tools.map((tool) => tool.name), ['mcp.calendar.list_events']);
  assert.equal(discovery.failures.length, 1);
  assert.equal(discovery.failures[0]?.server, 'weather');
  assert.match(String(discovery.failures[0]?.error), /服务器没起来|连不上/);

  const status = adapter.status();
  assert.deepEqual(status.map((entry) => `${entry.server}:${entry.state}`).sort(), ['calendar:connected', 'weather:failed']);

  await adapter.dispose();
  await good.dispose();
});

test('a bogus server name is a recorded configuration failure, not a thrown constructor', async () => {
  const stub = createStubMcpServer({ name: '天气', tools: [{ name: 'forecast', description: '看天气', text: '晴' }] });
  const { adapter } = createMcpPlugin({ servers: [{ name: '天气', connect: stub.transportFactory }] });

  const discovery = await adapter.discover();
  assert.deepEqual(discovery.tools, []);
  assert.equal(discovery.failures.length, 1);
  assert.match(String(discovery.failures[0]?.error), /命名空间/);
  // Nothing was connected at all: a name we cannot namespace means we never even open a transport.
  assert.equal(stub.factoryCalls, 0);
  await adapter.dispose();
  await stub.dispose();
});

test('an empty tool list is an ordinary outcome, and no transport is left hanging', async () => {
  const stub = createStubMcpServer({ name: 'weather', tools: [] });
  const { plugin, adapter } = createMcpPlugin({ servers: [{ name: 'weather', connect: stub.transportFactory }] });

  const registry = new ToolRegistry();
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  const manager = new PluginManager({ host: { tools: registry, capabilities, corePrompt: CORE_PROMPT_AUTHORITY }, sources: [] });
  const instance = await manager.loadInline(plugin);

  assert.equal(instance.state, 'active', '连上了但没工具，仍然是「今天没有这些工具」');
  assert.equal(instance.health?.status, 'degraded');
  assert.match(String(instance.health?.detail), /没发布工具|一个工具都没有/);
  assert.deepEqual(capabilities.names('tool'), []);
  assert.equal(stub.served, 1, '连上过一次');

  await manager.disposeAll();
  assert.equal(adapter.disposed, true);
  await stub.dispose();
});
