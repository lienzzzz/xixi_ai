import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  FakeBrainAdapter,
  ToolPermission,
  ToolRegistry,
  collectTurn,
  toolArgumentsDigest,
  type AgentTool,
} from '@xixi/brain-adapter';
import { ToolApprovalStore, openXixiStore, parseToolApprovalSettings, type XixiStore } from '@xixi/domain';
import { ToolApprovalManager, buildToolChain } from '@xixi/runtime';

/**
 * V0.3 P2-B — 工具审批（pack `docs/03_AGENT_PLUGIN.md` §5）。
 *
 * 这一组用例要钉住的是「**冻结**」这件事，而不是流程能跑：
 *
 *   1. pack 的七个字段（approvalId / sessionId / actorId / toolName / frozenArgs / requestedAt /
 *      expiresAt）齐备且**持久化** —— 关掉库再打开还取得到同一条待批请求；
 *   2. 确认之后执行的是**当时那一组参数**；行被改过（参数与摘要不再对应）时一律拒执行；
 *   3. 拒绝与超时都不执行、都落审计（原因码 + 谁点的头），而且拒绝之后下一轮照常走完。
 */

interface ProbeTool extends AgentTool {
  readonly calls: { count: number };
  readonly lastArgs: { value: Record<string, unknown> | null };
}

function probeTool(overrides: Partial<AgentTool> & { readonly name: string }): ProbeTool {
  const calls = { count: 0 };
  const lastArgs: { value: Record<string, unknown> | null } = { value: null };
  return {
    description: '测试用的「要花钱」的写工具',
    parameters: { type: 'object', properties: { amount: { type: 'number' }, to: { type: 'string' } }, additionalProperties: false },
    risk: 'write',
    scopes: ['conversation'],
    calls,
    lastArgs,
    async execute(args) {
      calls.count += 1;
      lastArgs.value = args;
      return { done: true, amount: args['amount'] ?? null, to: args['to'] ?? null };
    },
    ...overrides,
  };
}

const TOOL = 'xixi_pay_probe';
const ASK_SETTINGS = { ask: [TOOL], ttlSeconds: 300 } as const;
const REQUESTED_AT = new Date('2026-10-05T09:00:00+08:00');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'xixi-approval-'));
}

function openStore(dir: string, clock: () => Date): XixiStore {
  return openXixiStore({ dataDir: dir, clock });
}

interface Rig {
  readonly store: XixiStore;
  readonly registry: ToolRegistry;
  readonly manager: ToolApprovalManager;
  readonly tool: ProbeTool;
  readonly dbPath: string;
}

/** 一套最小装配：registry（装了审批宿主）+ manager（知道 registry） + 一个写工具。 */
function rig(dir: string, clock: () => Date, tool: ProbeTool = probeTool({ name: TOOL })): Rig {
  const store = openStore(dir, clock);
  const manager = new ToolApprovalManager({ store, settings: ASK_SETTINGS, now: clock });
  const registry = new ToolRegistry({
    permission: new ToolPermission({ role: 'resident', askTools: [...ASK_SETTINGS.ask] }),
    approval: manager,
  });
  registry.register(tool);
  manager.useRegistry(registry);
  return { store, registry, manager, tool, dbPath: store.dbPath };
}

function auditPayloads(store: XixiStore): Record<string, unknown>[] {
  return store
    .readEvents({ type: 'tool.approval.changed', limit: Number.MAX_SAFE_INTEGER })
    .map((event) => event.payload as Record<string, unknown>);
}

async function askOnce(r: Rig, args: Record<string, unknown>, extra: { sessionId?: string; actorId?: string; sourceEventId?: string } = {}) {
  return r.registry.execute(
    { name: TOOL, arguments: args },
    {
      scope: 'conversation',
      timezone: 'Asia/Shanghai',
      now: REQUESTED_AT,
      sessionId: extra.sessionId ?? 'sess_approval',
      actorId: extra.actorId ?? 'father',
      ...(extra.sourceEventId === undefined ? {} : { sourceEventId: extra.sourceEventId }),
    },
  );
}

test('a pending approval keeps the pack seven fields and survives a restart', async () => {
  const dir = tempDir();
  const clock = () => REQUESTED_AT;
  const first = rig(dir, clock);

  const execution = await askOnce(first, { amount: 12, to: '儿子' }, { sourceEventId: 'evt_turn_1' });
  assert.equal(execution.record.error, 'APPROVAL_REQUIRED', 'ask 停在审批，不是执行');
  assert.equal(first.tool.calls.count, 0);
  const approvalId = String(execution.payload['approvalId']);
  assert.match(approvalId, /^apr_[0-9a-f-]{36}$/, 'approval id 的形状由 schema 钉住');

  const stored = new ToolApprovalStore(first.store).get(approvalId);
  assert.ok(stored !== null);
  // pack §5 的七个字段。
  assert.equal(stored.approvalId, approvalId);
  assert.equal(stored.sessionId, 'sess_approval');
  assert.equal(stored.actorId, 'father');
  assert.equal(stored.toolName, TOOL);
  assert.deepEqual(stored.frozenArgs, { amount: 12, to: '儿子' });
  assert.equal(stored.requestedAt, '2026-10-05T09:00:00.000+08:00');
  assert.equal(stored.expiresAt, '2026-10-05T09:05:00.000+08:00');
  assert.equal(stored.status, 'pending');
  // 执行/恢复需要的程序事实，也在同一行里。
  assert.equal(stored.scope, 'conversation');
  assert.equal(stored.timezone, 'Asia/Shanghai');
  assert.equal(stored.sourceEventId, 'evt_turn_1');
  assert.equal(stored.frozenArgsDigest, toolArgumentsDigest({ amount: 12, to: '儿子' }));
  assert.equal(stored.decidedAt, null);
  assert.equal(stored.executedAt, null);

  const pendingEvent = auditPayloads(first.store).at(-1);
  assert.equal(pendingEvent?.['reason_code'], 'approval_requested');
  assert.equal(pendingEvent?.['status'], 'pending');
  assert.equal(pendingEvent?.['score'], 0, '待批不是决定：分数是 0（不是模型给的分数）');
  first.store.close();

  // 重启：新进程、新 store，同一条待批请求还在（铁律 3：断电/重启后仍能恢复）。
  const reopened = openStore(dir, clock);
  try {
    const recovered = new ToolApprovalStore(reopened).get(approvalId);
    assert.ok(recovered !== null, '重启后必须取回同一条待批请求');
    assert.deepEqual(recovered?.frozenArgs, stored.frozenArgs, '冻结参数一字不差');
    assert.equal(recovered?.status, 'pending');
    assert.equal(recovered?.expiresAt, stored.expiresAt);
    assert.equal(reopened.toolApprovals({ status: 'pending' }).length, 1);
  } finally {
    reopened.close();
  }
});

test('the ask path carries the turn identity into the pending record', async () => {
  // 走**真循环**（FakeBrainAdapter + runAgentLoop），而不是直接调 registry：这条链上的
  // sessionId / actorId / sourceEventId 是入口给的，模型不能提供（铁律 1/8）。
  const dir = tempDir();
  const clock = () => REQUESTED_AT;
  const r = rig(dir, clock);
  const session = r.store.createSession();
  const adapter = new FakeBrainAdapter({
    registry: r.registry,
    scope: 'conversation',
    now: clock,
    toolPlan: (input, round) => (round === 1 && input.text.includes('12 块') ? [{ name: TOOL, arguments: { amount: 12, to: '儿子' } }] : []),
  });

  const { result, chunks } = await collectTurn(
    await adapter.handleUserTurn({
      sessionId: session.sessionId,
      text: '帮我转 12 块钱给儿子',
      actorId: 'father',
      sourceEventId: 'evt_turn_from_entry',
    }),
  );

  assert.equal(result.action, 'SPEAK', '轮次照常结束：模型把「要先问一句」说出来');
  assert.match(result.text ?? '', /问一句/, `替身要说的是那句自然的询问：${result.text}`);
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool'), [{ type: 'tool', name: TOOL }]);
  assert.equal(r.tool.calls.count, 0, '没人点头之前，工具体一次都不能跑');
  const [pending] = r.manager.pending(new Date(REQUESTED_AT));
  assert.ok(pending !== undefined, '这次调用被记下来了');
  assert.equal(pending.sessionId, session.sessionId);
  assert.equal(pending.actorId, 'father');
  assert.equal(pending.sourceEventId, 'evt_turn_from_entry');
  r.store.close();
});

test('an approved call runs exactly the frozen arguments', async () => {
  const dir = tempDir();
  let now = REQUESTED_AT;
  const clock = () => now;
  const r = rig(dir, clock);
  const session = r.store.createSession();

  const asked = await askOnce(r, { amount: 12, to: '儿子' }, { sessionId: session.sessionId });
  const approvalId = String(asked.payload['approvalId']);

  now = new Date(REQUESTED_AT.getTime() + 60_000);
  const decision = await r.manager.approve({ approvalId, actorId: 'father' });

  assert.equal(decision.status, 'executed');
  assert.equal(decision.reasonCode, 'approval_executed');
  assert.equal(r.tool.calls.count, 1, '点头之后跑一次');
  assert.deepEqual(r.tool.lastArgs.value, { amount: 12, to: '儿子' }, '执行的就是冻结的那一组参数');
  assert.equal(decision.execution?.record.ok, true);
  assert.equal(decision.approval.status, 'executed');
  assert.equal(decision.approval.decidedBy, 'father');
  // 结果写回对话日志（pack §5 的 append tool result）：下一轮读得到，重启后也在。
  const turns = r.store.recentTurns(session.sessionId, 4);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.action, 'TOOL');
  assert.equal(turns[0]?.toolName, TOOL);
  assert.equal(turns[0]?.role, 'assistant');

  // 重复点头不会重复执行（外部动作只做一次）。
  const again = await r.manager.approve({ approvalId, actorId: 'father' });
  assert.equal(r.tool.calls.count, 1);
  assert.equal(again.approval.status, 'executed');

  const audit = auditPayloads(r.store);
  assert.deepEqual(
    audit.map((payload) => payload['reason_code']),
    ['approval_requested', 'user_approved', 'approval_executed'],
  );
  assert.equal(audit.at(-1)?.['decided_by'], 'father');
  assert.equal(audit.at(-1)?.['score'], 1, '人做的决定是可核查的事实');
  r.store.close();
});

test('a regenerated call cannot reuse an old approval digest', async () => {
  // 「参数被重新生成、拿旧摘要来执行」是这条设计最可能的绕过方式：执行路径必须自己拦住。
  const dir = tempDir();
  const clock = () => REQUESTED_AT;
  const r = rig(dir, clock);
  const asked = await askOnce(r, { amount: 12, to: '儿子' });
  const pending = r.manager.get(String(asked.payload['approvalId']));
  assert.ok(pending !== null);

  const forged = await r.registry.execute(
    { name: TOOL, arguments: { amount: 9999, to: '陌生人' } },
    { scope: 'conversation', timezone: 'Asia/Shanghai', now: REQUESTED_AT, sessionId: pending.sessionId, actorId: 'father' },
    { approval: { approvalId: pending.approvalId, argsDigest: pending.frozenArgsDigest, approvedBy: 'father' } },
  );
  assert.equal(forged.record.error, 'APPROVAL_MISMATCH', '摘要对不上就是拒，不是「差不多就行」');
  assert.equal(r.tool.calls.count, 0);
  // 待批请求本身没有被这次尝试动过：它还在等人点头。
  assert.equal(r.manager.get(pending.approvalId)?.status, 'pending');
  r.store.close();
});

test('a tampered frozen call is refused: arguments and digest stop matching', async () => {
  const dir = tempDir();
  const clock = () => REQUESTED_AT;
  const r = rig(dir, clock);

  const asked = await askOnce(r, { amount: 12, to: '儿子' });
  const approvalId = String(asked.payload['approvalId']);

  // 反事实输入：**行被改过**（参数被重新生成/篡改），摘要却还是原来那一个。
  // 用第二个连接写库，模拟「不是审批路径改的」——这是执行路径必须自己拦住的那种坏输入。
  const raw = new DatabaseSync(r.dbPath);
  try {
    raw
      .prepare('UPDATE tool_approvals SET frozen_args = ? WHERE approval_id = ?')
      .run(JSON.stringify({ amount: 9999, to: '陌生人' }), approvalId);
  } finally {
    raw.close();
  }

  const decision = await r.manager.approve({ approvalId, actorId: 'father' });
  assert.equal(r.tool.calls.count, 0, '参数对不上就绝不执行');
  assert.equal(decision.execution?.record.error, 'APPROVAL_MISMATCH');
  assert.equal(decision.status, 'refused');
  assert.equal(decision.reasonCode, 'approval_mismatch');
  assert.equal(decision.approval.status, 'denied', '这次同意作废，不留在 approved 上骗人');
  const audit = auditPayloads(r.store);
  assert.deepEqual(
    audit.map((payload) => payload['reason_code']),
    ['approval_requested', 'user_approved', 'approval_mismatch'],
  );
  r.store.close();
});

test('a denial never runs, is audited with the actor, and the next turn still works', async () => {
  const dir = tempDir();
  const clock = () => REQUESTED_AT;
  const r = rig(dir, clock);
  const session = r.store.createSession();
  const adapter = new FakeBrainAdapter({
    registry: r.registry,
    scope: 'conversation',
    now: clock,
    toolPlan: (input, round) => (round === 1 && input.text.includes('12 块') ? [{ name: TOOL, arguments: { amount: 12, to: '儿子' } }] : []),
  });

  const first = await collectTurn(
    await adapter.handleUserTurn({ sessionId: session.sessionId, text: '帮我转 12 块钱给儿子', actorId: 'father' }),
  );
  assert.equal(first.result.action, 'SPEAK');
  const [pending] = r.manager.pending(REQUESTED_AT);
  assert.ok(pending !== undefined);

  const denial = r.manager.deny({ approvalId: pending.approvalId, actorId: 'father' });
  assert.equal(denial.status, 'denied');
  assert.equal(denial.reasonCode, 'user_denied');
  assert.equal(denial.execution, null);
  assert.equal(denial.approval.decidedBy, 'father');
  assert.equal(r.tool.calls.count, 0, '拒绝 = 不执行');

  // 审计可查：原因码 + 谁拒绝的（铁律 5：只有原因码与分数，没有模型推理）。
  const audit = auditPayloads(r.store);
  assert.deepEqual(
    audit.map((payload) => payload['reason_code']),
    ['approval_requested', 'user_denied'],
  );
  assert.equal(audit.at(-1)?.['actor_id'], 'father');
  assert.equal(audit.at(-1)?.['decided_by'], 'father');
  // 拒绝之后没有待批请求留在池子里。
  assert.equal(r.manager.pending(REQUESTED_AT).length, 0);

  // 「不会卡死」：拒绝之后**同一段会话的下一轮照常走完**（模型照样回话，不抛异常）。
  const next = await collectTurn(
    await adapter.handleUserTurn({ sessionId: session.sessionId, text: '算了，不用了', actorId: 'father' }),
  );
  assert.equal(next.result.action, 'SPEAK');
  assert.equal(next.result.text, '模拟回复：算了，不用了');
  assert.equal(r.tool.calls.count, 0);

  // 拒绝被记进对话日志（下一轮读得到「这件事没有做」）。
  const turns = r.store.recentTurns(session.sessionId, 8);
  assert.ok(
    turns.some((turn) => turn.action === 'TOOL' && turn.text !== null && turn.text.includes('没有做')),
    `拒绝要留下一条可读的结果轮：${JSON.stringify(turns.map((turn) => [turn.action, turn.text]))}`,
  );
  r.store.close();
});

test('an expired request never runs and is audited as expired', async () => {
  const dir = tempDir();
  let now = REQUESTED_AT;
  const clock = () => now;
  const r = rig(dir, clock);

  const asked = await askOnce(r, { amount: 12, to: '儿子' });
  const approvalId = String(asked.payload['approvalId']);

  now = new Date(REQUESTED_AT.getTime() + 5 * 60_000 + 1_000); // 过了 TTL
  const swept = r.manager.expirePending(now);
  assert.equal(swept.length, 1);
  assert.equal(swept[0]?.status, 'expired');

  // 过期之后再点头也不执行（而且状态机不允许 expired 回到 approved）。
  const late = await r.manager.approve({ approvalId, actorId: 'father' });
  assert.equal(late.status, 'expired');
  assert.equal(r.tool.calls.count, 0, '过期 = 不执行');
  assert.equal(r.manager.pending(now).length, 0);
  const audit = auditPayloads(r.store);
  assert.deepEqual(
    audit.map((payload) => payload['reason_code']),
    ['approval_requested', 'approval_expired'],
  );
  assert.equal(audit.at(-1)?.['score'], 0, '到期是程序判定的结束，不是人的决定');
  r.store.close();
});

test('nothing asks for approval unless a deployment declares it', async () => {
  // 「没声明就不该 ASK」：出厂默认是空表；只有 config.tools.approval.ask 里写了名字才会 ask。
  assert.deepEqual(parseToolApprovalSettings(undefined), { ask: [], ttlSeconds: 300 });
  assert.deepEqual(parseToolApprovalSettings({}), { ask: [], ttlSeconds: 300 });
  assert.deepEqual(parseToolApprovalSettings({ approval: { ask: [TOOL, TOOL, '', '  '], ttl_seconds: 0 } }), {
    ask: [TOOL],
    ttlSeconds: 300,
  });
  assert.deepEqual(parseToolApprovalSettings({ approval: { ask: 'xixi_pay_probe' } }), { ask: [], ttlSeconds: 300 });

  const config = {
    identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
    models: {
      llm: { provider: 'mimo', model: 'm', thinking_realtime: false },
      asr: { provider: 'mimo', model: 'a' },
      tts: { provider: 'mimo', model: 't' },
    },
    personality: { base: {} },
    proactive: {},
    memory: {},
    privacy: {},
    features: {},
  };

  // 默认（没声明）：同一个工具是 allow，不会 ASK。
  const quiet = buildToolChain(config);
  quiet.register(probeTool({ name: TOOL }));
  assert.equal(quiet.check(TOOL, 'conversation').verdict, 'allow');

  // 声明之后：同一个工具变成 ask —— 策略是**从配置构造**的，不是入口各写一份。
  const declared = buildToolChain(config, { approval: { ask: [TOOL], ttlSeconds: 60 } });
  declared.register(probeTool({ name: TOOL }));
  const decision = declared.check(TOOL, 'conversation');
  assert.equal(decision.verdict, 'ask');
  assert.match(decision.reason, /同意/);
});
