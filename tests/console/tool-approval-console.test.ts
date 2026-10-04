/**
 * V0.3 P2-B — 审批的**声明面**在控制台这条链上也要成立（pack `docs/03_AGENT_PLUGIN.md` §5）。
 *
 * 为什么这个用例在 tests/console 而不是 tests/unit：它用的是**入口自己那条链**
 * （`scripts/field-test.ts` 的 `buildToolChain`，也就是控制台与四个 live 入口共用的兼容表面）与
 * 入口自己的配置加载（`loadConfig()`），证明的是「审批策略是从部署声明构造的、入口不需要各自接线」，
 * 而不是某个函数单独能算出什么。
 *
 * 两件事：① 出厂配置里没有任何工具需要审批（「没声明就不该 ASK」）；② 声明之后那一个才变成 `ask`，
 * 而且**仍然被广告给模型** —— 否则 pack §5 的流程（模型先发起 tool_call）根本没有起点。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONVERSATION_SCOPE, buildToolChain } from '../../scripts/field-test.ts';
import { loadConfig } from '../../scripts/lib/harness.ts';

const BUILT_INS = ['xixi_get_current_time', 'xixi_get_weather', 'xixi_set_reminder_stub'];

test('控制台的工具链：出厂不 ASK，声明之后才 ask 且仍然可见', () => {
  const config = loadConfig();

  const shipped = buildToolChain(config);
  const permissions = Object.fromEntries(shipped.names().map((name) => [name, shipped.check(name, CONVERSATION_SCOPE).verdict]));
  assert.deepEqual(
    permissions,
    {
      xixi_get_current_time: 'allow',
      xixi_get_weather: 'allow',
      xixi_set_reminder_stub: 'allow',
    },
    '出厂配置（config/xixi.example.yaml 的 tools.approval.ask 为空）不该有任何工具需要审批',
  );

  const declared = buildToolChain(config, { approval: { ask: ['xixi_set_reminder_stub'], ttlSeconds: 120 } });
  assert.equal(declared.check('xixi_set_reminder_stub', CONVERSATION_SCOPE).verdict, 'ask', '声明了才 ask');
  assert.equal(declared.check('xixi_get_weather', CONVERSATION_SCOPE).verdict, 'allow', '没声明的照旧 allow');
  // 同一个工具集：ask 不是「藏起来」，而是「调用时停下来等人点头」。
  assert.deepEqual(
    declared.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name).sort(),
    [...BUILT_INS].sort(),
    '被广告的工具集不变：ask 的工具仍然要被模型看见（pack §5 的起点）',
  );
});
