import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TOOL_ROUNDS,
  ToolPermission,
  ToolRegistry,
  createToolRegistry,
  executeTool,
  parseToolArguments,
  toolArgumentsDigest,
  type AgentTool,
} from '@xixi/brain-adapter';

/**
 * Pack Phase 2 — the tool chain's program-owned boundaries.
 *
 * The point of these tests is *not* that a tool works; it is that the three things the
 * model must never decide are decided here: which tools it may see, whether a call may
 * run, and how many rounds a turn gets.
 */

const CONTEXT = { scope: 'conversation' as const, timezone: 'Asia/Shanghai', now: new Date('2026-10-01T09:00:00+08:00') };
// V0.3 P2-D: three built-ins. The news tool left this package — it is a plugin tool now
// (`news.search` / `news.latest` / `news.for_interests`), pinned in tests/unit/core/tool-loop.test.ts.
const BUILT_INS = ['xixi_get_current_time', 'xixi_get_weather', 'xixi_set_reminder_stub'];

function probeTool(overrides: Partial<AgentTool> & { readonly name: string }): AgentTool & { readonly calls: { count: number } } {
  const calls = { count: 0 };
  const tool: AgentTool & { readonly calls: { count: number } } = {
    description: '测试用',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
    risk: 'read',
    scopes: ['conversation'],
    calls,
    async execute() {
      calls.count += 1;
      return { ok: true };
    },
    ...overrides,
  };
  return tool;
}

test('the built-in set is offered to the model as exactly the three Phase 2 tools', () => {
  const registry = createToolRegistry({ defaultPlace: '成都' });
  assert.deepEqual(registry.names().sort(), [...BUILT_INS].sort());
  assert.deepEqual(
    registry.listForAgent('conversation').map((tool) => tool.name).sort(),
    [...BUILT_INS].sort(),
  );
  // A guest may read, but the one write tool is not even advertised.
  const forGuest = registry.listForAgent('guest').map((tool) => tool.name);
  assert.ok(!forGuest.includes('xixi_set_reminder_stub'), `a guest must not see the write tool: ${forGuest.join(',')}`);
  const guestDecision = registry.check('xixi_set_reminder_stub', 'guest');
  assert.equal(guestDecision.verdict, 'deny');
  assert.match(guestDecision.reason, /guest|客人|不属于/);
});

test('the round cap is a program constant: round 5 is offered nothing, whatever the model says', () => {
  const registry = createToolRegistry({ defaultPlace: '成都' });
  assert.equal(registry.maxToolRounds, MAX_TOOL_ROUNDS);
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    assert.equal(registry.definitionsForRound('conversation', round)?.length, 3, `round ${round} must offer every tool`);
  }
  assert.equal(registry.definitionsForRound('conversation', MAX_TOOL_ROUNDS + 1), undefined, 'past the cap there are no tools to ask for');
  // …and it cannot be raised by configuration either: an absurd request is clamped.
  assert.equal(createToolRegistry({ defaultPlace: '成都', maxToolRounds: 99 }).maxToolRounds, MAX_TOOL_ROUNDS);
});

test('a dangerous tool is refused even when it is registered: nothing runs', async () => {
  const registry = new ToolRegistry();
  const dangerous = probeTool({ name: 'xixi_delete_everything', risk: 'dangerous' });
  registry.register(dangerous);
  assert.equal(registry.listForAgent('conversation').length, 0, 'a refused tool is not advertised');
  const execution = await registry.execute({ name: dangerous.name, arguments: '{}' }, CONTEXT);
  assert.equal(execution.permission.verdict, 'deny');
  assert.equal(execution.record.ok, false);
  assert.equal(execution.record.error, 'PERMISSION_DENIED');
  assert.equal(dangerous.calls.count, 0, 'the tool body must never run');
  assert.match(String(execution.payload.error), /做不到/);
});

test('a write tool runs for the resident in a conversation and is refused elsewhere', async () => {
  const registry = new ToolRegistry();
  const write = probeTool({ name: 'xixi_write_probe', risk: 'write', scopes: ['conversation', 'proactive'] });
  registry.register(write);

  const allowed = await registry.execute({ name: write.name, arguments: '{"value":"x"}' }, CONTEXT);
  assert.equal(allowed.permission.verdict, 'allow');
  assert.equal(allowed.record.ok, true);
  assert.equal(write.calls.count, 1);

  const proactive = await registry.execute({ name: write.name, arguments: '{}' }, { ...CONTEXT, scope: 'proactive' });
  assert.equal(proactive.permission.verdict, 'deny');
  assert.match(proactive.permission.reason, /自己开口/);
  assert.equal(write.calls.count, 1, 'a refused call must not reach the tool');

  const guest = await registry.execute({ name: write.name, arguments: '{}' }, { scope: 'conversation', timezone: 'Asia/Shanghai', now: new Date(), role: 'guest' });
  assert.equal(guest.permission.verdict, 'deny');
  assert.equal(write.calls.count, 1);
});

test('an ask tool is offered, and a call to it stops instead of running (pack §5)', async () => {
  const registry = new ToolRegistry({ permission: new ToolPermission({ role: 'resident', askTools: ['xixi_write_probe'] }) });
  const tool = probeTool({ name: 'xixi_write_probe', risk: 'write' });
  registry.register(tool);
  // V0.3 P2-B：`ask` 的工具**必须被广告出来**。pack §5 的审批流程从「模型真的发起这次 tool_call」
  // 开始（model tool_call → permission ASK → 持久化 → 问一句 → 确认 → 执行冻结调用）；看不见的
  // 工具永远不会被调用，审批就成了够不到的死代码。`deny` 仍然不可见（上面两条用例钉着）。
  assert.deepEqual(registry.listForAgent('conversation').map((entry) => entry.name), ['xixi_write_probe']);
  // 没有审批宿主时：调用得到「先问一句」的拒绝，工具体一次都不跑。
  const execution = await registry.execute({ name: tool.name, arguments: '{}' }, CONTEXT);
  assert.equal(execution.permission.verdict, 'ask');
  assert.equal(execution.record.error, 'ASK');
  assert.match(String(execution.payload.error), /同意/);
  assert.equal(tool.calls.count, 0);
  // 装了审批宿主：这次调用被**记下来**（冻结参数 + 摘要），工具体仍然不跑。
  const asked: { readonly toolName: string; readonly digest: string }[] = [];
  const gated = new ToolRegistry({
    permission: new ToolPermission({ role: 'resident', askTools: ['xixi_write_probe'] }),
    approval: {
      request: (input) => {
        asked.push({ toolName: input.toolName, digest: input.argsDigest });
        return { approvalId: 'apr_test', expiresAt: '2099-01-01T00:00:00+08:00' };
      },
    },
  });
  gated.register(tool);
  const recorded = await gated.execute({ name: tool.name, arguments: '{"value":"x"}' }, CONTEXT);
  assert.equal(recorded.record.error, 'APPROVAL_REQUIRED');
  assert.equal(recorded.payload['approvalId'], 'apr_test');
  assert.equal(recorded.payload['requiresApproval'], true);
  assert.equal(tool.calls.count, 0, '记下来不等于执行');
  assert.deepEqual(asked.map((entry) => entry.toolName), ['xixi_write_probe']);
  assert.equal(asked[0]?.digest.length, 64, '宿主拿到的是冻结参数本身的摘要');
});

test('an ask entry cannot widen a call the other rules refuse', async () => {
  // 「先问一句」不是一条绕过规则的路：deny 先判，同意凭据也救不回被拒的调用。
  const registry = new ToolRegistry({ role: 'guest', permission: new ToolPermission({ role: 'guest', askTools: ['xixi_write_probe'] }) });
  const tool = probeTool({ name: 'xixi_write_probe', risk: 'write' });
  registry.register(tool);
  assert.equal(registry.check('xixi_write_probe', 'conversation', 'guest').verdict, 'deny');
  assert.equal(registry.listForAgent('conversation').length, 0);
  const execution = await registry.execute({ name: tool.name, arguments: '{}' }, { ...CONTEXT, role: 'guest' }, {
    approval: { approvalId: 'apr_x', argsDigest: toolArgumentsDigest({}), approvedBy: 'father' },
  });
  assert.equal(execution.record.error, 'PERMISSION_DENIED');
  assert.equal(tool.calls.count, 0);
});

test('undeclared arguments, an unknown tool and a hanging tool all answer the model', async () => {
  const registry = new ToolRegistry();
  const tool = probeTool({ name: 'xixi_probe', timeoutMs: 30 });
  registry.register(tool);

  const unknownArg = await registry.execute({ name: 'xixi_probe', arguments: '{"nope":1}' }, CONTEXT);
  assert.equal(unknownArg.record.ok, false);
  assert.match(String(unknownArg.record.error), /不认识的参数/);

  const unknownTool = await registry.execute({ name: 'xixi_does_not_exist', arguments: '{}' }, CONTEXT);
  assert.equal(unknownTool.record.error, 'UNKNOWN_TOOL');
  assert.match(String(unknownTool.payload.error), /没有这个工具/);

  // Broken JSON is an empty argument set, not a crash (the provider does emit it).
  assert.deepEqual(parseToolArguments('{not json'), {});
  assert.deepEqual(parseToolArguments(''), {});

  const hanging = probeTool({
    name: 'xixi_hangs',
    timeoutMs: 20,
    execute: () => new Promise(() => {}),
  });
  registry.register(hanging);
  const timedOut = await registry.execute({ name: 'xixi_hangs', arguments: '{}' }, CONTEXT);
  assert.equal(timedOut.record.ok, false);
  assert.match(String(timedOut.record.error), /超时/);

  // A tool that throws becomes a value, never an exception that ends the turn.
  const broken = probeTool({
    name: 'xixi_broken',
    execute: () => {
      throw new Error('boom');
    },
  });
  registry.register(broken);
  const failed = await registry.execute({ name: 'xixi_broken', arguments: '{}' }, CONTEXT);
  assert.equal(failed.record.ok, false);
  assert.equal(failed.record.error, 'boom');
});

test('registration is reversible and observable', async () => {
  const registry = new ToolRegistry({ onToolCall: (record) => seen.push(`${record.name}:${record.ok ? 'ok' : record.error}`) });
  const seen: string[] = [];
  const dispose = registry.register(probeTool({ name: 'xixi_probe' }));
  assert.deepEqual(registry.names(), ['xixi_probe']);
  await registry.execute({ name: 'xixi_probe', arguments: '{}' }, CONTEXT);
  assert.deepEqual(seen, ['xixi_probe:ok']);
  dispose();
  assert.deepEqual(registry.names(), [], 'a disposed registration leaves nothing behind');
  assert.equal(registry.unregister('xixi_probe'), false);
});

test('executeTool refuses an undeclared argument before the tool body sees it', async () => {
  const tool = probeTool({ name: 'xixi_probe' });
  const refused = await executeTool(tool, { nope: 1 }, { timezone: 'Asia/Shanghai', now: new Date() });
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : '', /不认识的参数/);
  assert.equal(tool.calls.count, 0);
  const allowed = await executeTool(tool, { value: 'x' }, { timezone: 'Asia/Shanghai', now: new Date() });
  assert.equal(allowed.ok, true);
  assert.equal(tool.calls.count, 1);
});
