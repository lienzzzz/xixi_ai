import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolPermission, ToolRegistry, type ToolExecutionContext } from '@xixi/brain-adapter';
import { parseXixiConfig } from '@xixi/domain';
import { CapabilityRegistry, CORE_PROMPT_AUTHORITY, PluginManager, type PluginModuleShape } from '@xixi/plugins';
import { createMcpPlugin } from '@xixi/plugins/mcp';
import { buildPluginRuntime } from '@xixi/runtime';

import { createStubMcpServer } from './stub-server.ts';

/**
 * t20 — the two defects a review found on the **lifecycle** edges of the MCP adapter.
 *
 *  * **F1: `deactivate` used to be a death sentence.** `McpClientAdapter.disconnect()` called
 *    `McpServerConnection.close()`, which set the terminal flag — so after `deactivate → activate` the
 *    connection refused every call and the plugin could never contribute its tools again. Now `close()`
 *    drops the transport and returns to `idle` (reconnectable); only `dispose()` is terminal.
 *  * **F2: `health` could say 「服务器连上了」 about a server that was not connected.** It only treated
 *    `failed` as broken, so an `idle`/`disconnected` connection with zero tools was reported as
 *    "connected but publishing nothing" — and the real reason (`lastError` / `closeReason` /
 *    discovery failure) was never quoted. Now "not connected" means anything but `connected`, and the
 *    detail carries the reason.
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
const BUILT_INS = ['xixi_get_current_time', 'xixi_get_weather', 'xixi_set_reminder_stub'];
const TOOL_NAME = 'mcp.weather.forecast';

function weatherStub() {
  return createStubMcpServer({ name: 'weather', tools: [{ name: 'forecast', description: '看天气', text: '晴' }] });
}

/**
 * Wait for an **observable transition** (bounded), instead of assuming it happens within some number
 * of milliseconds. The SDK delivers `onclose` on its own tick, so a test that just awaits one round
 * would be a timing assertion in disguise (AGENTS §9.25③).
 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

test('F1：start → deactivate → activate 之后工具重新出现，且适配器真的重连过', async () => {
  const stub = weatherStub();
  const mount = buildPluginRuntime(CONFIG, { mcpServers: [{ name: 'weather', connect: stub.transportFactory, retry: { attempts: 2, delayMs: 1 } }] });

  await mount.start();
  assert.deepEqual(mount.runtime.capabilities.names('tool'), [TOOL_NAME]);
  const factoryCallsAfterStart = stub.factoryCalls;
  assert.equal(factoryCallsAfterStart, 1, 'start 建了一次连接');
  const firstCopy = mount.registry.all().find((tool) => tool.name === TOOL_NAME);
  assert.ok(firstCopy !== undefined);

  // 停用：能力释放、连接断开——但**不许**变成终止态。
  assert.equal(await mount.runtime.manager.deactivate('xixi.mcp'), true);
  assert.deepEqual(mount.runtime.capabilities.names('tool'), []);
  assert.equal(mount.mcp?.status()[0]?.state, 'idle', 'deactivate 之后是 idle（可重连），不是终止');
  assert.equal(mount.mcp?.status()[0]?.closeReason, 'deactivate：插件停用，连接断开（可重连）');

  // 再启用：这就是旧实现永久失败的那一步。
  const reactivated = await mount.runtime.manager.activate('xixi.mcp');
  assert.equal(reactivated.state, 'active');
  assert.deepEqual(mount.runtime.capabilities.names('tool'), [TOOL_NAME], '工具必须回来（能力表）');
  assert.equal(stub.factoryCalls, factoryCallsAfterStart + 1, '适配器真的重新建了连接（工厂计数 +1）');

  const stats = mount.mcp?.status()[0]?.stats;
  assert.equal(stats?.connects, 1, '首次连接仍记 1');
  assert.equal(stats?.reconnects, 1, '第二次连接记成 reconnect');
  assert.deepEqual(
    (mount.mcp?.events ?? []).filter((event) => event.kind === 'reconnect').map((event) => event.server),
    ['weather'],
  );

  // 宿主的挂载步骤在热插拔之后再跑一次：模型侧那一份换成当前激活的对象。
  const report = mount.mount();
  assert.deepEqual(report.mounted, [TOOL_NAME], '重挂刷新模型侧的副本');
  const secondCopy = mount.registry.all().find((tool) => tool.name === TOOL_NAME);
  assert.ok(secondCopy !== undefined);
  assert.notEqual(secondCopy, firstCopy, '换成了新激活贡献的那个对象，不是上一次的残留');
  assert.deepEqual([...mount.registry.names()].sort(), [...BUILT_INS, TOOL_NAME].sort(), '内置工具一个不少');

  const execution = await mount.registry.execute({ name: TOOL_NAME, arguments: '{}' }, CONTEXT);
  assert.equal(execution.record.ok, true, `重激活之后工具必须还能用：${JSON.stringify(execution.record.error)}`);
  assert.equal(execution.record.result?.['text'], '晴');
  assert.equal(mount.runtime.manager.instance('xixi.mcp')?.health?.status, 'ok');

  await mount.shutdown();
  await stub.dispose();
});

test('F1：dispose 仍然是终止的（幂等），deactivate 之后才不是', async () => {
  const stub = weatherStub();
  const mount = buildPluginRuntime(CONFIG, { mcpServers: [{ name: 'weather', connect: stub.transportFactory }] });
  await mount.start();

  await mount.runtime.manager.dispose('xixi.mcp');
  assert.equal(mount.mcp?.disposed, true, '适配器 dispose 之后是终止的');
  // 终止之后发现不会偷偷重连：discover 收集失败，不抛。
  const discovery = await mount.mcp?.discover();
  assert.deepEqual(discovery?.tools, []);
  assert.equal(stub.factoryCalls, 1, 'dispose 之后不许再建连接');

  await stub.dispose();
});

test('F2：连接断开后的 health 说出真正的原因，且不出现「连上了」', async () => {
  const stub = weatherStub();
  const mount = buildPluginRuntime(CONFIG, { mcpServers: [{ name: 'weather', connect: stub.transportFactory }] });
  await mount.start();
  assert.match(String(mount.runtime.manager.instance('xixi.mcp')?.health?.detail), /在线/);

  // 对方把连接关掉（真实世界里的服务器重启）。等一下「适配器观察到这件事」，再问 health——
  // 这里等的是一个**可观察的转移**，不是假设它发生在某个固定的毫秒数内。
  await stub.closeServerSide();
  const noticed = await waitFor(() => mount.mcp?.status()[0]?.state !== 'connected', 1_000);
  assert.equal(noticed, true, '适配器该在有限时间内观察到连接掉了');

  await mount.runtime.manager.checkHealth();
  const afterDrop = mount.runtime.manager.instance('xixi.mcp')?.health;
  const detail = String(afterDrop?.detail);
  assert.equal(afterDrop?.status, 'degraded', `断开但工具表还在 → degraded：${detail}`);
  assert.ok(!detail.includes('连上了'), `断开之后不许说「连上了」：${detail}`);
  assert.ok(detail.includes('服务器关闭了连接（onclose）'), `要说清真正的原因：${detail}`);
  assert.ok(detail.includes('weather=disconnected'), `要点名服务器与状态：${detail}`);

  // 再调一次工具会把连接接回来，health 跟着回到 ok（重连本身在 F1 的用例里有计数证据）。
  const execution = await mount.registry.execute({ name: TOOL_NAME, arguments: '{}' }, CONTEXT);
  assert.equal(execution.record.ok, true, `断线后的一次调用该靠重连补上：${JSON.stringify(execution.record.error)}`);
  await mount.runtime.manager.checkHealth();
  assert.equal(mount.runtime.manager.instance('xixi.mcp')?.health?.status, 'ok');

  // 另一条更硬的口径：插件被停用（连接回到 idle），health 必须说「未连接」并带上停用这个原因。
  const dead = createMcpPlugin({ servers: [{ name: 'weather', connect: () => stub.transportFactory() }] });
  const registry = new ToolRegistry();
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  const manager = new PluginManager({ host: { tools: registry, capabilities, corePrompt: CORE_PROMPT_AUTHORITY }, sources: [] });
  await manager.loadInline(dead.plugin);
  await dead.adapter.disconnect();

  const hook = (dead.plugin.module as PluginModuleShape).health;
  const report = await hook?.();
  assert.equal(report?.status, 'down');
  const idleDetail = String(report?.detail);
  assert.ok(!idleDetail.includes('连上了'), `断开之后不许说「连上了」：${idleDetail}`);
  assert.ok(idleDetail.includes('deactivate：插件停用，连接断开（可重连）'), `要说清原因：${idleDetail}`);
  assert.ok(idleDetail.includes('weather=idle'), `要点名服务器与状态：${idleDetail}`);

  await manager.disposeAll();
  await mount.shutdown();
  await stub.dispose();
});

test('F2：连不上的服务器，health 带上真正的失败原因；服务器空手而归才算「连上了但没发布工具」', async () => {
  // ① 根本连不上：lastError 里有尝试次数与底层原因。
  const failing = createMcpPlugin({ servers: [{ name: 'weather', connect: () => Promise.reject(new Error('桩：服务器没起来')), retry: { attempts: 2, delayMs: 1 } }] });
  const registry = new ToolRegistry();
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  const manager = new PluginManager({ host: { tools: registry, capabilities, corePrompt: CORE_PROMPT_AUTHORITY }, sources: [] });
  await manager.loadInline(failing.plugin);

  const failingHealth = await (failing.plugin.module as PluginModuleShape).health?.();
  assert.equal(failingHealth?.status, 'down');
  assert.ok(String(failingHealth?.detail).includes('桩：服务器没起来'), `要说清为什么连不上：${failingHealth?.detail}`);
  assert.ok(!String(failingHealth?.detail).includes('连上了'), '连不上时不许出现「连上了」');
  const failingStatus = failing.adapter.status()[0];
  assert.equal(failingStatus?.state, 'failed');
  assert.match(String(failingStatus?.lastError), /连不上 MCP 服务器 weather（试了 2 次）/);

  // ② 连得上但一个工具都没有：这才是「连上了但没发布工具」。
  const empty = createStubMcpServer({ name: 'weather', tools: [] });
  const quiet = createMcpPlugin({ servers: [{ name: 'weather', connect: empty.transportFactory }] });
  const manager2 = new PluginManager({
    host: { tools: new ToolRegistry(), capabilities: new CapabilityRegistry({ permission: new ToolPermission() }), corePrompt: CORE_PROMPT_AUTHORITY },
    sources: [],
  });
  await manager2.loadInline(quiet.plugin);
  const quietHealth = await (quiet.plugin.module as PluginModuleShape).health?.();
  assert.equal(quietHealth?.status, 'degraded');
  assert.match(String(quietHealth?.detail), /连上了但没发布工具/);
  assert.equal(quiet.adapter.status()[0]?.state, 'connected');

  await manager.disposeAll();
  await manager2.disposeAll();
  await empty.dispose();
});

test('F2：discover 的运行期失败按服务器合并进 status', async () => {
  const good = createStubMcpServer({ name: 'calendar', tools: [{ name: 'list_events', description: '看日程', text: '没有安排' }] });
  const { adapter } = createMcpPlugin({
    servers: [
      { name: 'weather', connect: () => Promise.reject(new Error('桩：天气服务器不在')), retry: { attempts: 1, delayMs: 1 } },
      { name: 'calendar', connect: good.transportFactory, retry: { attempts: 1, delayMs: 1 } },
    ],
  });

  const discovery = await adapter.discover();
  assert.deepEqual(discovery.tools.map((tool) => tool.name), ['mcp.calendar.list_events']);

  const status = adapter.status();
  const weather = status.find((entry) => entry.server === 'weather');
  const calendar = status.find((entry) => entry.server === 'calendar');
  assert.equal(weather?.state, 'failed');
  assert.match(String(weather?.discoverFailure), /天气服务器不在|连不上/);
  assert.match(String(weather?.lastError), /连不上|天气服务器不在/);
  assert.equal(calendar?.state, 'connected');
  assert.equal(calendar?.discoverFailure, null);
  assert.equal(calendar?.tools, 1);

  await adapter.dispose();
  await good.dispose();
});
