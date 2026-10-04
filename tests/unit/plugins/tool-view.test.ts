import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolPermission, ToolRegistry, type AgentTool, type ToolExecutionContext } from '@xixi/brain-adapter';
import {
  CapabilityRegistry,
  CORE_PROMPT_AUTHORITY,
  createPluginToolView,
  PluginBoundaryError,
  PluginManager,
  type PluginContext,
  type PluginHost,
  type PluginToolView,
} from '@xixi/plugins';
import { mountPluginTools } from '@xixi/runtime';

/**
 * t18 F1 + F5 — the **tool view** a plugin holds.
 *
 * The defect this file exists for: the view's `register` used to do nothing *except* hand back a
 * handle that released any name on dispose, and `unregister` accepted any name at all. A plugin could
 * therefore write `ctx.tools.register(coreTool).dispose()` — or simply
 * `ctx.tools.unregister('xixi_get_weather')` — and delete a core tool from outside the lifecycle.
 *
 * Two rules replace it, and both are asserted here in both directions:
 *
 *  * **one door**: contributing a tool happens by returning it from `activate()`, where the manifest,
 *    the `tool.register` permission, the namespace and the scope are all checked. `view.register`
 *    refuses loudly and names that door;
 *  * **ownership**: `unregister` may release what this plugin contributed and nothing else — a core
 *    tool, another plugin's capability or a name nobody owns is refused, loudly, with nothing touched.
 */

const CONTEXT: ToolExecutionContext = { scope: 'conversation', timezone: 'Asia/Shanghai', now: new Date('2026-10-05T09:00:00+08:00') };

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

interface Harness {
  readonly manager: PluginManager;
  readonly registry: ToolRegistry;
  readonly capabilities: CapabilityRegistry;
  readonly views: Map<string, PluginToolView>;
  readonly host: PluginHost;
}

/** Load one plugin that contributes `toolName`, and keep the view it was handed. */
async function harness(): Promise<Harness> {
  const registry = new ToolRegistry({ tools: [probeTool('xixi_get_weather', { description: '核心的天气工具' })] });
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  const views = new Map<string, PluginToolView>();
  const host: PluginHost = { tools: registry, capabilities, corePrompt: CORE_PROMPT_AUTHORITY };
  const manager = new PluginManager({ host, sources: [] });

  const load = async (pluginId: string, toolName: string, tool: AgentTool = probeTool(toolName)): Promise<void> => {
    await manager.loadInline({
      manifest: { schemaVersion: 1, id: pluginId, name: pluginId, version: '0.1.0', permissions: ['tool.register'], capabilities: ['tool'] },
      module: {
        activate: (context) => {
          views.set(pluginId, (context as PluginContext).tools);
          return { tools: [{ tool }] };
        },
      },
    });
  };

  await load('xixi.alpha', 'demo.alpha_tool');
  await load('xixi.beta', 'demo.beta_tool');
  return { manager, registry, capabilities, views, host };
}

function viewOf(harness: Harness, pluginId: string): PluginToolView {
  const view = harness.views.get(pluginId);
  assert.ok(view !== undefined, `${pluginId} 该在 activate 里拿到过视图`);
  return view;
}

test('F5+ 正面：受控路径真的把工具交到模型面前，且视图的枚举与核心注册表逐项一致', async () => {
  const h = await harness();
  const mounted = mountPluginTools(h.registry, h.capabilities);

  assert.deepEqual([...mounted.mounted].sort(), ['demo.alpha_tool', 'demo.beta_tool']);
  const view = viewOf(h, 'xixi.alpha');

  // 枚举一致：视图看到的就是核心注册表现在拿着的那些对象（同一个引用，不是复制品）。
  assert.deepEqual([...view.names()].sort(), [...h.registry.names()].sort());
  assert.deepEqual(view.all(), h.registry.all());
  assert.deepEqual(view.listForAgent('conversation'), h.registry.listForAgent('conversation'));
  assert.equal(view.check('demo.alpha_tool', 'conversation').verdict, 'allow');

  // 模型侧可见 + 核心真的执行得动（这就是「register 真的让工具可见/可被核心执行」）。
  const offered = (h.registry.definitionsForRound('conversation', 1) ?? []).map((definition) => definition.name);
  assert.ok(offered.includes('demo.alpha_tool'), `模型该看到它：${offered.join('、')}`);
  const execution = await h.registry.execute({ name: 'demo.alpha_tool', arguments: '{}' }, CONTEXT);
  assert.equal(execution.record.ok, true);
  assert.equal(execution.record.result?.['from'], 'demo.alpha_tool');

  await h.manager.disposeAll();
});

test('F1 反事实 (a)：视图里的 register 响亮拒绝，并指出正确的门（activate 的 contribution）', async () => {
  const h = await harness();
  mountPluginTools(h.registry, h.capabilities);
  const view = viewOf(h, 'xixi.alpha');

  const before = [...h.registry.names()].sort();
  let caught: unknown;
  try {
    (view as unknown as { register(tool: AgentTool): unknown }).register(probeTool('demo.sneaky'));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PluginBoundaryError, '上下文里注册工具必须被拒');
  assert.equal((caught as PluginBoundaryError).boundary, 'tool-permission');
  assert.equal((caught as PluginBoundaryError).pluginId, 'xixi.alpha');
  assert.match((caught as Error).message, /activate/, '拒绝必须告诉插件正确的门在哪');
  assert.match((caught as Error).message, /contribution\.tools/);

  // 拒绝之后什么都没变：既没有多出一个工具，也没有能力登记。
  assert.deepEqual([...h.registry.names()].sort(), before);
  assert.equal(h.capabilities.has('tool', 'demo.sneaky'), false);

  await h.manager.disposeAll();
});

test('F1 反事实 (b)：释放自己没拥有的名字被拒，别人的能力一点没动', async () => {
  const h = await harness();
  mountPluginTools(h.registry, h.capabilities);
  const alpha = viewOf(h, 'xixi.alpha');

  assert.throws(
    () => alpha.unregister('demo.beta_tool'),
    (error: unknown) =>
      error instanceof PluginBoundaryError && error.boundary === 'tool-permission' && /属于 xixi\.beta/.test(error.message),
  );
  // beta 的能力与它挂出去的那份都还在，且仍然能跑。
  assert.equal(h.capabilities.has('tool', 'demo.beta_tool'), true);
  assert.ok(h.registry.names().includes('demo.beta_tool'));
  const stillWorks = await h.registry.execute({ name: 'demo.beta_tool', arguments: '{}' }, CONTEXT);
  assert.equal(stillWorks.record.ok, true);

  await h.manager.disposeAll();
});

test('F1 反事实 (c)：插件删不掉核心工具（连旧的那条「register + dispose」绕路也不存在）', async () => {
  const h = await harness();
  mountPluginTools(h.registry, h.capabilities);
  const alpha = viewOf(h, 'xixi.alpha');

  // 直接点名删核心工具：拒。
  assert.throws(
    () => alpha.unregister('xixi_get_weather'),
    (error: unknown) => error instanceof PluginBoundaryError && /不是任何插件注册的能力/.test(error.message),
  );
  // 旧绕路：先「注册」核心工具再 dispose 那个句柄。register 现在是拒绝，句柄根本拿不到。
  assert.throws(() => (alpha as unknown as { register(tool: AgentTool): unknown }).register(probeTool('xixi_get_weather')), PluginBoundaryError);

  // 核心工具既在表里也还能执行。
  assert.ok(h.registry.names().includes('xixi_get_weather'));
  const execution = await h.registry.execute({ name: 'xixi_get_weather', arguments: '{}' }, CONTEXT);
  assert.equal(execution.record.ok, true, '核心工具必须毫发无损');

  await h.manager.disposeAll();
});

test('F5 正面：释放自己贡献的工具成功，且只带走自己那一个', async () => {
  const h = await harness();
  mountPluginTools(h.registry, h.capabilities);
  const alpha = viewOf(h, 'xixi.alpha');

  assert.equal(alpha.unregister('demo.alpha_tool'), true);
  // 能力登记没了，核心表里的那一份也撤了。
  assert.equal(h.capabilities.has('tool', 'demo.alpha_tool'), false);
  assert.equal(h.registry.names().includes('demo.alpha_tool'), false);
  // 核心与别人的东西原样。
  assert.deepEqual([...h.registry.names()].sort(), ['demo.beta_tool', 'xixi_get_weather']);
  assert.equal(h.capabilities.has('tool', 'demo.beta_tool'), true);

  // 再释放一次不许「静默成功」：名字已经不属于任何人了。
  assert.throws(() => alpha.unregister('demo.alpha_tool'), PluginBoundaryError);

  await h.manager.disposeAll();
});

test('F1 身份校验：同名但不是我贡献的那个对象，拒绝碰（反事实会红）', async () => {
  const h = await harness();
  mountPluginTools(h.registry, h.capabilities);
  const alpha = viewOf(h, 'xixi.alpha');

  // 有人（核心或另一条路径）用同一个名字注册了**另一个**工具对象。
  const impostor = probeTool('demo.alpha_tool', { description: '冒名顶替的那个' });
  h.registry.register(impostor);

  assert.throws(
    () => alpha.unregister('demo.alpha_tool'),
    (error: unknown) => error instanceof PluginBoundaryError && /不是这个插件贡献的那个对象/.test(error.message),
  );
  // 两样都还在：冒名顶替的那份留在核心表里，插件自己的能力也没有被顺手删掉。
  assert.equal(h.registry.all().find((tool) => tool.name === 'demo.alpha_tool'), impostor);
  assert.equal(h.capabilities.has('tool', 'demo.alpha_tool'), true);

  await h.manager.disposeAll();
});

test('F1 边界：没有能力登记表时视图仍然拒绝一切释放（宁可拒绝，也不误伤）', async () => {
  const registry = new ToolRegistry({ tools: [probeTool('xixi_get_weather')] });
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  const view = createPluginToolView({ registry, capabilities, pluginId: 'xixi.nobody' });

  assert.throws(() => view.unregister('xixi_get_weather'), PluginBoundaryError);
  assert.throws(() => view.unregister('demo.whatever'), PluginBoundaryError);
  assert.deepEqual(view.names(), ['xixi_get_weather'], '拒绝之后核心工具表一字未动');
  assert.deepEqual(capabilities.list(), []);
});
