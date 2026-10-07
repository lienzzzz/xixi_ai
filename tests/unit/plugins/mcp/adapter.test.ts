import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolPermission, ToolRegistry, type ToolExecutionContext } from '@xixi/brain-adapter';
import { parseXixiConfig } from '@xixi/domain';
import { CapabilityRegistry, CORE_PROMPT_AUTHORITY, PluginManager, PluginPermissionError } from '@xixi/plugins';
import { createMcpPlugin, isMcpToolName, McpNamingError, mcpServerSegment, mcpToolName, parseMcpToolName } from '@xixi/plugins/mcp';
import { buildPluginRuntime } from '@xixi/runtime';

import { createStubMcpServer } from './stub-server.ts';

/**
 * Pack `03_AGENT_PLUGIN.md` §4 — `discover → normalize to Xixi AgentTool → namespace → ToolRegistry`.
 *
 * The evidence is always the same shape: a **real** stub MCP server (SDK v2 over an in-process
 * linked transport), driven through the same assembly the entries use (`buildPluginRuntime` →
 * `start()` → `mount()`), and asserted on what the *model* is offered — because the name in the tools
 * array is the only thing the model ever sees.
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
const BUILT_INS = ['xixi_get_current_time', 'xixi_get_weather', 'xixi_set_reminder'];

test('the namespace is mcp.<server>.<tool>, and it is built from a conservative sanitizer', () => {
  assert.equal(mcpToolName('weather', 'forecast'), 'mcp.weather.forecast');
  assert.equal(mcpToolName('calendar', 'list_events'), 'mcp.calendar.list_events');
  // An external service's names are its input, not a trusted identifier for our registry.
  assert.equal(mcpToolName('Weather Server', 'get-forecast'), 'mcp.weather_server.get-forecast');
  assert.throws(() => mcpToolName('天气', '查一下'), McpNamingError, '整段没有可用字符时宁可拒绝，也不生成 mcp._._ 这种名字');
  assert.equal(mcpServerSegment('Calendar Service'), 'calendar_service');

  assert.deepEqual(parseMcpToolName('mcp.weather.forecast'), { server: 'weather', tool: 'forecast' });
  assert.equal(isMcpToolName('mcp.weather.forecast'), true);
  assert.equal(isMcpToolName('xixi_get_weather'), false);
  assert.equal(isMcpToolName('mcp.weather'), false);
  assert.equal(parseMcpToolName('mcp..forecast'), null);

  assert.throws(() => mcpToolName('', 'forecast'), McpNamingError);
  assert.throws(() => mcpToolName('mcp', 'forecast'), McpNamingError, '服务器名不能与命名空间前缀重合');
  assert.throws(() => mcpToolName('w'.repeat(80), 'forecast'), McpNamingError);

  // Namespacing is what keeps the two worlds apart: no MCP name can land in the core's namespace.
  for (const name of ['weather', 'core', 'xixi']) {
    assert.ok(!mcpToolName(name, 'forecast').startsWith('xixi_'));
    assert.ok(!mcpToolName(name, 'forecast').startsWith('core.'));
  }
});

test('a stub MCP server’s tools are discovered, namespaced, and offered to the model through the tool chain', async () => {
  const stub = createStubMcpServer({
    name: 'weather',
    tools: [
      {
        name: 'forecast',
        description: '看天气',
        schema: { type: 'object', properties: { place: { type: 'string', description: '地名' } }, required: ['place'], additionalProperties: false },
        text: (args) => `sunny in ${String(args['place'])}`,
      },
    ],
  });

  const mount = buildPluginRuntime(CONFIG, { mcpServers: [{ name: 'weather', connect: stub.transportFactory }] });
  const started = await mount.start();
  const report = mount.notes;

  // --- discovery, through the ordinary nine-step lifecycle
  const instance = mount.runtime.manager.instance('xixi.mcp');
  assert.equal(instance?.state, 'active');
  assert.deepEqual(instance?.capabilities, ['tool:mcp.weather.forecast']);
  assert.equal(instance?.health?.status, 'ok');
  assert.deepEqual(started.map((entry) => entry.pluginId), ['xixi.mcp']);
  assert.deepEqual(report.mounted, ['mcp.weather.forecast']);
  assert.deepEqual(report.skipped, []);

  // --- what the model is offered: the namespaced name, and nothing else
  const definitions = mount.registry.definitionsForRound('conversation', 1) ?? [];
  const offered = definitions.map((definition) => definition.name);
  assert.ok(offered.includes('mcp.weather.forecast'), `模型该看到带命名空间的名字，实际：${offered.join('、')}`);
  assert.ok(!offered.includes('forecast'), '服务器自己的名字不许出现在工具表里');
  assert.equal(offered.filter((name) => name.startsWith('mcp.')).length, 1);

  // --- the built-ins are untouched, and nothing was shadowed
  for (const name of BUILT_INS) assert.ok(mount.registry.names().includes(name), `${name} 必须还在`);
  assert.equal(new Set(mount.registry.names()).size, mount.registry.names().length, '名字不许重复');

  // --- the schema and the description survive normalization, with provenance attached
  const tool = mount.registry.all().find((entry) => entry.name === 'mcp.weather.forecast');
  assert.ok(tool !== undefined);
  assert.deepEqual(Object.keys((tool.parameters['properties'] ?? {}) as Record<string, unknown>), ['place']);
  assert.deepEqual(tool.parameters['required'], ['place']);
  assert.match(tool.description, /MCP weather·forecast/, '说明里要有出处');
  assert.match(tool.description, /不可信数据/, '外部服务的文本必须被标成不可信数据（铁律 8）');
  assert.equal(tool.risk, 'read');

  // --- and the call chain really runs end to end
  const execution = await mount.registry.execute({ name: 'mcp.weather.forecast', arguments: JSON.stringify({ place: '成都' }) }, CONTEXT);
  assert.equal(execution.permission.verdict, 'allow');
  assert.equal(execution.record.ok, true, `调用该成功：${JSON.stringify(execution.record.error)}`);
  assert.equal(execution.record.result?.['text'], 'sunny in 成都');
  assert.equal(execution.record.result?.['server'], 'weather');
  assert.equal(execution.record.result?.['tool'], 'forecast');
  assert.equal(execution.record.result?.['source'], 'mcp');

  // The server saw its own tool name and the arguments the model passed — no more, no less.
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.name, 'forecast');
  assert.deepEqual(stub.calls[0]?.args, { place: '成都' });

  await mount.runtime.stop();
  await stub.dispose();
});

test('an MCP tool is a tool like any other: the same permission policy judges it', async () => {
  const stub = createStubMcpServer({
    name: 'calendar',
    tools: [{ name: 'create_event', description: '建日程', schema: { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: false }, text: '已建' }],
  });

  const mount = buildPluginRuntime(CONFIG, {
    mcpServers: [{ name: 'calendar', connect: stub.transportFactory, risk: 'write' }],
  });
  await mount.start();

  // The operator declared this server's risk; the guest and the proactive scope are refused.
  const asGuest = await mount.registry.execute({ name: 'mcp.calendar.create_event', arguments: '{"title":"复诊"}' }, { ...CONTEXT, role: 'guest' });
  assert.equal(asGuest.permission.verdict, 'deny');
  const inProactive = await mount.registry.execute({ name: 'mcp.calendar.create_event', arguments: '{"title":"复诊"}' }, { ...CONTEXT, scope: 'proactive' });
  assert.equal(inProactive.permission.verdict, 'deny');
  assert.equal(stub.calls.length, 0, '被拒的调用不许到达外部服务');

  const asResident = await mount.registry.execute({ name: 'mcp.calendar.create_event', arguments: '{"title":"复诊"}' }, CONTEXT);
  assert.equal(asResident.permission.verdict, 'allow');
  assert.equal(asResident.record.ok, true);
  assert.equal(stub.calls.length, 1);

  // An argument the server never declared is refused by the core before the call leaves the process.
  const undeclared = await mount.registry.execute({ name: 'mcp.calendar.create_event', arguments: '{"title":"x","nope":1}' }, CONTEXT);
  assert.equal(undeclared.record.ok, false);
  assert.match(String(undeclared.record.error), /不认识的参数/);
  assert.equal(stub.calls.length, 1);

  await mount.runtime.stop();
  await stub.dispose();
});

test('two MCP servers keep their own namespaces, and the same tool name can exist in both', async () => {
  const weather = createStubMcpServer({ name: 'weather', tools: [{ name: 'forecast', description: '天气', text: 'weather 的预报' }] });
  const calendar = createStubMcpServer({ name: 'calendar', tools: [{ name: 'forecast', description: '日程预报', text: 'calendar 的预报' }] });

  const mount = buildPluginRuntime(CONFIG, {
    mcpServers: [
      { name: 'weather', connect: weather.transportFactory },
      { name: 'calendar', connect: calendar.transportFactory },
    ],
  });
  await mount.start();
  const report = mount.notes;

  assert.deepEqual([...report.mounted].sort(), ['mcp.calendar.forecast', 'mcp.weather.forecast']);
  const first = await mount.registry.execute({ name: 'mcp.weather.forecast', arguments: '{}' }, CONTEXT);
  const second = await mount.registry.execute({ name: 'mcp.calendar.forecast', arguments: '{}' }, CONTEXT);
  assert.equal(first.record.result?.['text'], 'weather 的预报');
  assert.equal(second.record.result?.['text'], 'calendar 的预报');
  assert.equal(weather.calls.length, 1);
  assert.equal(calendar.calls.length, 1);

  await mount.runtime.stop();
  await weather.dispose();
  await calendar.dispose();
});

test('the adapter keeps the registry’s own gates: it registers through the plugin lifecycle, not around it', async () => {
  const stub = createStubMcpServer({ name: 'weather', tools: [{ name: 'forecast', description: '看天气', text: 'ok' }] });
  const registry = new ToolRegistry();
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  const manager = new PluginManager({ host: { tools: registry, capabilities, corePrompt: CORE_PROMPT_AUTHORITY }, sources: [] });

  // A plugin that never asked for `tool.register` cannot register MCP tools either: the MCP plugin's
  // contribution goes through exactly the same gate as any other plugin's.
  const { plugin } = createMcpPlugin({ servers: [{ name: 'weather', connect: stub.transportFactory }], permissions: [] });
  await assert.rejects(() => manager.loadInline(plugin), (error: unknown) => error instanceof PluginPermissionError);
  assert.deepEqual(capabilities.names('tool'), []);

  // With the permission declared, the same plugin loads and the tools appear under the namespace.
  const allowed = createMcpPlugin({ servers: [{ name: 'weather', connect: stub.transportFactory }], id: 'xixi.mcp.allowed' });
  const instance = await manager.loadInline(allowed.plugin);
  assert.equal(instance.state, 'active');
  assert.deepEqual(capabilities.names('tool'), ['mcp.weather.forecast']);

  await manager.disposeAll();
  await stub.dispose();
});
