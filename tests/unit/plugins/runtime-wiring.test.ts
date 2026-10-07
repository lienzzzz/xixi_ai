import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_TOOL_ROUNDS, ToolPermission, ToolRegistry, type AgentTool, type ToolExecutionContext } from '@xixi/brain-adapter';
import { parseXixiConfig } from '@xixi/domain';
import { CapabilityRegistry, PluginAlreadyStartedError, type InlinePlugin } from '@xixi/plugins';
import { buildPluginRuntime } from '@xixi/runtime';

/**
 * t18 F3 + F4 — the **runtime** end of the plugin kernel: what `start()` makes visible, and what
 * `dispose()`/`shutdown()` actually release.
 *
 * The two findings behind this file:
 *
 *  * F3: `mountPluginTools` existed but nothing in the assembly point called it, so 「插件工具对模型可见」
 *    depended on a second call a host could forget. `start()` now runs the lifecycle **and** mounts,
 *    and this file asserts model visibility after `start()` alone.
 *  * F4: `ToolRegistry.dispose()` released everything and was called by nothing. It is now the host's
 *    shutdown handle inside `PluginRuntimeMount.shutdown()`, and the last test says what it does and
 *    what it deliberately does not do (it is a clear, not a tombstone).
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

function probeTool(name: string, overrides: Partial<AgentTool> = {}): AgentTool & { readonly calls: { count: number } } {
  const calls = { count: 0 };
  return {
    name,
    description: `${name} 的用例工具`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    scopes: ['conversation'],
    calls,
    async execute() {
      calls.count += 1;
      return { ok: true, from: name };
    },
    ...overrides,
  } as AgentTool & { readonly calls: { count: number } };
}

function inlinePlugin(id: string, toolName: string): InlinePlugin {
  const tool = probeTool(toolName);
  return {
    manifest: { schemaVersion: 1, id, name: id, version: '0.1.0', permissions: ['tool.register'], capabilities: ['tool'] },
    module: { activate: () => ({ tools: [{ tool }] }) },
  };
}

test('F3：start() 之后插件工具就对模型可见（不需要另一次 mount 调用）', async () => {
  const mount = buildPluginRuntime(CONFIG, { inline: [inlinePlugin('xixi.demo', 'demo.echo')] });
  assert.deepEqual(mount.registry.names().sort(), [...BUILT_INS].sort(), 'start 之前只有内置工具');

  const instances = await mount.start();

  assert.deepEqual(instances.map((instance) => instance.state), ['active']);
  assert.deepEqual(mount.notes.mounted, ['demo.echo']);
  assert.deepEqual([...mount.registry.names()].sort(), [...BUILT_INS, 'demo.echo'].sort());

  // 模型侧：definitionsForRound 真的列出了它（这就是「可见」的可观察定义）。
  const offered = (mount.registry.definitionsForRound('conversation', 1) ?? []).map((definition) => definition.name);
  assert.ok(offered.includes('demo.echo'), `模型该看到插件工具：${offered.join('、')}`);
  // 并且核心执行得动它。
  const execution = await mount.registry.execute({ name: 'demo.echo', arguments: '{}' }, CONTEXT);
  assert.equal(execution.record.ok, true);
  assert.equal(execution.record.result?.['from'], 'demo.echo');

  await mount.shutdown();
});

test('F3：热插拔后 mount() 只补新名字，不重复挂老的', async () => {
  const mount = buildPluginRuntime(CONFIG, { inline: [inlinePlugin('xixi.one', 'demo.one')] });
  await mount.start();
  assert.deepEqual(mount.notes.mounted, ['demo.one']);

  await mount.runtime.manager.loadInline(inlinePlugin('xixi.two', 'demo.two'));
  const report = mount.mount();

  assert.deepEqual(report.mounted, ['demo.two'], '第二次挂载只报新名字');
  assert.deepEqual(report.skipped, ['demo.one'], '第一次已经挂进核心表的那一个会被如实报成 skipped，而不是再挂一次');
  assert.deepEqual([...mount.registry.names()].sort(), [...BUILT_INS, 'demo.one', 'demo.two'].sort());
  assert.equal(new Set(mount.registry.names()).size, mount.registry.names().length);

  await mount.shutdown();
});

test('F4：shutdown() 是宿主的关停句柄——停插件、撤自己挂的、再清空工具链', async () => {
  const mount = buildPluginRuntime(CONFIG, { inline: [inlinePlugin('xixi.demo', 'demo.echo')] });
  await mount.start();
  assert.ok(mount.registry.names().includes('demo.echo'));

  const report = await mount.shutdown();

  assert.equal(report.pluginsDisposed, 1, '一个插件被 dispose');
  assert.deepEqual(report.unmounted, ['demo.echo'], '自己挂进去的那一个被撤');
  assert.deepEqual([...report.remainingBeforeClear].sort(), [...BUILT_INS].sort(), '撤完之后、清空之前链上还剩什么（就是那四个内置）');
  assert.deepEqual(mount.registry.names(), [], '最后一步是清空');
  assert.equal(mount.registry.definitionsForRound('conversation', 1), undefined);

  // 插件层也被停掉了：能力登记为空，插件的 dispose 钩子跑过（manager 的实例状态是 disposed）。
  assert.deepEqual(mount.runtime.capabilities.list(), []);
  assert.equal(mount.runtime.manager.instance('xixi.demo')?.state, 'disposed');

  // 幂等：再关一次不抛。
  await mount.shutdown();
});

test('F4：ToolRegistry.dispose() 做什么、不做什么（它是清空，不是墓碑）', async () => {
  const registry = new ToolRegistry({
    permission: new ToolPermission({ role: 'resident', askTools: ['demo.ask'] }),
    tools: [probeTool('xixi_keep_a'), probeTool('xixi_keep_b')],
  });

  // ① per-registration Disposable 只放一个：它和「关停句柄」是两件事。
  const releaseOne = registry.register(probeTool('demo.temp'));
  assert.deepEqual([...registry.names()].sort(), ['demo.temp', 'xixi_keep_a', 'xixi_keep_b']);
  releaseOne.dispose();
  assert.deepEqual([...registry.names()].sort(), ['xixi_keep_a', 'xixi_keep_b'], '只走了这一个');

  // ② dispose() 一次性释放全部。
  registry.dispose();
  assert.deepEqual(registry.names(), []);
  assert.deepEqual(registry.all(), []);
  assert.equal(registry.definitionsForRound('conversation', 1), undefined, '一次都不再广告');
  registry.dispose(); // 幂等

  // ③ 不做的三件事：
  //    - 权限策略没被换掉：同一个策略对象继续守 ask / dangerous；
  const ask = probeTool('demo.ask');
  const dangerous = probeTool('demo.danger', { risk: 'dangerous' });
  registry.register(ask);
  registry.register(dangerous);
  assert.equal(registry.check('demo.ask', 'conversation').verdict, 'ask', '策略还在守');
  assert.equal(registry.check('demo.danger', 'conversation').verdict, 'deny', 'dangerous 照旧一律拒');
  assert.equal(registry.execute({ name: 'demo.danger', arguments: '{}' }, CONTEXT) instanceof Promise, true, '执行路径仍然在');
  //    - 轮次上限没被重置/放宽；
  assert.equal(registry.maxToolRounds, MAX_TOOL_ROUNDS);
  //    - 注册表仍然可用（清空之后还能再装东西，名字都在）。
  assert.deepEqual([...registry.names()].sort(), ['demo.ask', 'demo.danger']);

  // ④ 它不去碰插件层的能力登记：那是插件运行时的活（shutdown() 的第一步）。
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  const specTool = probeTool('demo.plugin_tool');
  capabilities.registerTool('xixi.demo', { tool: specTool });
  const pluginSideRegistry = new ToolRegistry();
  pluginSideRegistry.dispose();
  assert.deepEqual(capabilities.names('tool'), ['demo.plugin_tool'], '核心注册表清空不影响能力登记表');
  assert.equal(capabilities.get<{ tool: AgentTool }>('tool', 'demo.plugin_tool')?.tool, specTool);
});

/**
 * P2.5-I ① — the registered finding (t19 的 O1) read: 「第二次 start() 留下『插件 inactive 但工具仍在核心
 * 表里』的半坏状态，模型仍能调用一个已失活插件的工具」. The kernel now refuses the second start before
 * any step runs, so this test asserts both halves of the fixed behaviour: the host hears a written
 * refusal, **and** the plugin it already started keeps running with its tool still mounted.
 */
test('P2.5-I ①：repeat start() 响亮拒绝，不会留下「插件 inactive 但工具还在核心表里」的半坏状态', async () => {
  const mount = buildPluginRuntime(CONFIG, { inline: [inlinePlugin('xixi.demo', 'demo.echo')] });
  await mount.start();
  assert.deepEqual([...mount.registry.names()].sort(), [...BUILT_INS, 'demo.echo'].sort());
  const before = mount.runtime.manager.instance('xixi.demo');
  assert.equal(before?.state, 'active');
  assert.equal(before?.health?.status, 'ok');

  await assert.rejects(
    () => mount.start(),
    (error: unknown) => {
      assert.ok(error instanceof PluginAlreadyStartedError, '重复 start() 必须抛内核写明的错误，而不是静默再跑一遍');
      assert.equal(error.code, 'PLUGIN_ALREADY_STARTED');
      assert.equal(error.entry, 'loadAll');
      assert.match(error.message, /已经启动过/);
      return true;
    },
  );

  // 半坏状态没有了：插件还在跑，模型侧那一份也还在，而且两边的说法一致。
  const after = mount.runtime.manager.instance('xixi.demo');
  assert.equal(after?.state, 'active');
  assert.equal(after?.online, true);
  assert.equal(after?.activationCount, 1, '没有第二次激活');
  assert.deepEqual(after?.health, before?.health, '第二次没有重跑 health');
  assert.deepEqual(mount.notes.mounted, ['demo.echo'], '也没有重复挂载');
  assert.ok(mount.registry.names().includes('demo.echo'), '工具仍在核心表里——插件确实还在跑，所以这是对的');

  const execution = await mount.registry.execute({ name: 'demo.echo', arguments: '{}' }, CONTEXT);
  assert.equal(execution.record.ok, true, '重复 start() 之后工具照旧执行得动（没有把运行中的插件弄坏）');

  await mount.shutdown();
});

/**
 * P2.5-I ② — the other registered finding (t21 复审的 O1): `instance().health` was 「最后一次记录的
 * 报告」, so after `deactivate`/`shutdown` it still reported the plugin as if it were running.
 */
test('P2.5-I ②：shutdown 之后调试面读到的是「已停用」，不是一份还在线的健康报告', async () => {
  const mount = buildPluginRuntime(CONFIG, { inline: [inlinePlugin('xixi.demo', 'demo.echo')] });
  await mount.start();
  const live = mount.runtime.manager.instance('xixi.demo');
  assert.equal(live?.online, true);
  assert.equal(live?.health?.status, 'ok');

  await mount.shutdown();

  const stopped = mount.runtime.manager.instance('xixi.demo');
  assert.equal(stopped?.state, 'disposed');
  assert.equal(stopped?.online, false);
  assert.equal(stopped?.health, undefined, '关停之后不许再显示在线');
  assert.deepEqual(stopped?.capabilities, []);
});
