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
import { ToolApprovalStore, openXixiStore, parseToolApprovalSettings, parseXixiConfig, type XixiConfig, type XixiStore } from '@xixi/domain';
import { ToolApprovalManager, buildPluginRuntime, buildToolChain, resolveToolApprovalSettings } from '@xixi/runtime';
import type { InlinePlugin } from '@xixi/plugins';

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

test('approve() is its own expiry gate: no sweep, still expired, still zero calls', async () => {
  // t10 的反事实发现：上面那条先 sweep 再点头的用例**够不到** approve() 自带的到期闸门
  // （把 `if (Date.parse(current.expiresAt) <= at.getTime())` 改成 `if (false)` 时它仍然全绿，
  // 因为 status 已经被 sweep 改成 expired、approve 早退在状态检查那一步）。这条用例**不 sweep**：
  // 越过 TTL 直接点头，唯一的到期判定就是 approve() 里那一道闸门。
  const dir = tempDir();
  let now = REQUESTED_AT;
  const clock = () => now;
  const r = rig(dir, clock);

  const asked = await askOnce(r, { amount: 12, to: '儿子' });
  const approvalId = String(asked.payload['approvalId']);

  now = new Date(REQUESTED_AT.getTime() + 5 * 60_000 + 1_000); // 过了 TTL
  assert.equal(r.manager.get(approvalId)?.status, 'pending', '这一步之前没有任何人 sweep 过');

  const decision = await r.manager.approve({ approvalId, actorId: 'father' });
  assert.equal(decision.status, 'expired');
  assert.equal(decision.reasonCode, 'approval_expired');
  assert.equal(decision.execution, null);
  assert.equal(decision.approval.status, 'expired');
  assert.equal(r.tool.calls.count, 0, '过期 = 不执行（闸门拿掉时这里会变成 1）');

  const reasons = auditPayloads(r.store).map((payload) => payload['reason_code']);
  assert.deepEqual(reasons, ['approval_requested', 'approval_expired']);
  assert.ok(!reasons.includes('user_approved'), '不能留下「人同意了」的记录');
  assert.ok(!reasons.includes('approval_executed'), '更不能留下「执行过」的记录');
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

/**
 * V0.3 P2.5-B — 审批**声明**这一层：声明 → 模型可见工具链的权限策略（pack §5）。
 *
 * 上面那一组钉的是「冻结」（流程里的事）；这一组钉的是「判定从哪来」：
 *
 *   1. 三档优先级（显式声明 > 配置 > 出厂空表）各有一条**可观察的权限判定**，而不只是断言解析
 *      函数返回了什么 —— 判定发生在装配点建出来的那条链上（这才是四个入口共用的东西）；
 *   2. 「没声明就不问」是一条**全表**性质：没声明时注册表里没有任何工具被判成 ask，写工具也不例外
 *      （不做「看起来危险就先问一句」的推断）；
 *   3. 同一份声明对**内置工具与插件工具一视同仁**：两者都被判成需要确认，而且 ask 仍然对模型可见
 *      （ask ≠ deny，否则那条审批流程从真实的一轮里根本走不到）；
 *   4. 越界的声明不会被静默接受：有效期按既有上限夹紧，名字按同一套规则归一化。
 *
 * 全程离线：inline 插件源、真配置解析、临时目录里的库，没有网络、没有模型、没有密钥。
 */

const OTHER_TOOL = 'xixi_pay_probe_approval_second';
const PLUGIN_WRITE = 'demo.writer';

/** 部署改的就是这段 YAML（`config/xixi.yaml` 的 `tools` 段），所以这里走真的配置解析路径。 */
const BASE_YAML = `
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
`;

function configWithAsk(ask: readonly string[] = [], ttlSeconds?: number): XixiConfig {
  const list = ask.map((name) => JSON.stringify(name)).join(', ');
  const approval = [`      ask: [${list}]`, ...(ttlSeconds === undefined ? [] : [`      ttl_seconds: ${ttlSeconds}`])].join('\n');
  return parseXixiConfig(`${BASE_YAML}  tools:\n    approval:\n${approval}\n`);
}

const QUIET_CONFIG = configWithAsk([]);

/** 一个贡献写工具的插件：和内置工具走同一条注册与判定路径，没有任何特权。 */
function writePlugin(id: string, toolName: string): InlinePlugin {
  const tool: AgentTool = {
    name: toolName,
    description: `${toolName} 的用例工具（写）`,
    parameters: { type: 'object', properties: { what: { type: 'string' } }, additionalProperties: false },
    risk: 'write',
    scopes: ['conversation'],
    async execute() {
      return { ok: true };
    },
  };
  return {
    manifest: { schemaVersion: 1, id, name: id, version: '0.1.0', permissions: ['tool.register'], capabilities: ['tool'] },
    module: { activate: () => ({ tools: [{ tool }] }) },
  };
}

/**
 * 内置工具里的写工具名**从装配点自己造的表里读**，不写死字面量：改名（T7 那类）不该让这组用例
 * 变成假红，也不该让它们变成什么都不证明的绿 —— 名字取自「今天的链里到底有什么」。
 */
function builtinWriteTools(): string[] {
  return buildToolChain(QUIET_CONFIG)
    .all()
    .filter((tool) => tool.risk === 'write')
    .map((tool) => tool.name);
}

test('declaration priority: explicit beats config, config beats the factory empty table', () => {
  // 第三档：配置里没有这一段 = 出厂空表（`tools` 段缺省）。
  const factory = buildToolChain(QUIET_CONFIG);
  factory.register(probeTool({ name: TOOL }));
  assert.equal(factory.check(TOOL, 'conversation').verdict, 'allow', '没声明就没有 ask');

  // 第二档：配置里声明了 —— 声明真的进了模型可见工具链的权限策略。
  const fromConfig = buildToolChain(configWithAsk([TOOL]));
  fromConfig.register(probeTool({ name: TOOL }));
  assert.equal(fromConfig.check(TOOL, 'conversation').verdict, 'ask');

  // 第一档：入口显式给了一份，配置就不再参与（换一个名字，配置里那个回到 allow）。
  const explicit = buildToolChain(configWithAsk([TOOL]), { approval: { ask: [OTHER_TOOL], ttlSeconds: 60 } });
  explicit.register(probeTool({ name: TOOL }));
  explicit.register(probeTool({ name: OTHER_TOOL }));
  assert.equal(explicit.check(OTHER_TOOL, 'conversation').verdict, 'ask');
  assert.equal(explicit.check(TOOL, 'conversation').verdict, 'allow', '显式声明不与配置合并');

  // 显式一份**空表**是「这个入口不要任何审批」，不会被配置补回来（`??` 的语义）。
  const muted = buildToolChain(configWithAsk([TOOL]), { approval: { ask: [], ttlSeconds: 60 } });
  muted.register(probeTool({ name: TOOL }));
  assert.equal(muted.check(TOOL, 'conversation').verdict, 'allow', '空表 ≠ 没给');

  // 比声明更强的只有显式**策略对象**：给了它，声明不再参与（文档写明的最高一档）。
  const byPolicy = buildToolChain(configWithAsk([TOOL]), {
    permission: new ToolPermission({ role: 'resident', askTools: [OTHER_TOOL] }),
  });
  byPolicy.register(probeTool({ name: TOOL }));
  byPolicy.register(probeTool({ name: OTHER_TOOL }));
  assert.equal(byPolicy.check(OTHER_TOOL, 'conversation').verdict, 'ask');
  assert.equal(byPolicy.check(TOOL, 'conversation').verdict, 'allow');
});

test('undeclared means never asked: a write risk alone never triggers ASK, built-in or plugin', async () => {
  const mount = buildPluginRuntime(QUIET_CONFIG, { inline: [writePlugin('xixi.writer', PLUGIN_WRITE)] });
  await mount.start();

  // 反空断言：链上真的有东西可判（内置的写工具 + 刚挂上来的插件写工具）。
  const registered = mount.registry.all();
  const writes = registered.filter((tool) => tool.risk === 'write');
  assert.ok(writes.length >= 2, `内置与插件应各有一个写工具：${registered.map((tool) => `${tool.name}/${tool.risk}`).join('、')}`);
  assert.ok(mount.notes.mounted.includes(PLUGIN_WRITE), `插件写工具确实挂进了这条链：${mount.notes.mounted.join('、')}`);

  // 全表性质：一个 ask 都没有（写工具也不问）。
  const asked = registered.filter((tool) => mount.registry.check(tool.name, 'conversation').verdict === 'ask');
  assert.deepEqual(asked.map((tool) => tool.name), [], '没声明就不该有 ask');
  for (const tool of writes) {
    assert.equal(mount.registry.check(tool.name, 'conversation').verdict, 'allow', `${tool.name} 是写工具，但没声明就不问`);
  }
  await mount.shutdown();
});

test('one declaration, one policy: built-in and plugin write tools are judged alike, and ask stays visible', async () => {
  const builtinWrites = builtinWriteTools();
  assert.ok(builtinWrites.length >= 1, '出厂内置里至少要有一个写工具，否则这条用例什么也没证明');

  const mount = buildPluginRuntime(configWithAsk([...builtinWrites, PLUGIN_WRITE]), {
    inline: [writePlugin('xixi.writer', PLUGIN_WRITE)],
  });
  await mount.start();

  for (const name of [...builtinWrites, PLUGIN_WRITE]) {
    assert.equal(mount.registry.check(name, 'conversation').verdict, 'ask', `${name} 被声明了就该被判成需要确认`);
  }

  // ask 仍然被广告给模型（ask ≠ deny）：否则「模型发起 → 权限 ASK → 持久化」这条流程从真实一轮里
  // 根本走不到 —— 模型看不到的工具，是不会去调用的。
  const offered = (mount.registry.definitionsForRound('conversation', 1) ?? []).map((definition) => definition.name);
  for (const name of [...builtinWrites, PLUGIN_WRITE]) {
    assert.ok(offered.includes(name), `${name} 该仍然对模型可见：${offered.join('、')}`);
  }
  await mount.shutdown();
});

test('an out-of-range TTL is clamped by the existing ceiling, never silently accepted', async () => {
  const config = configWithAsk([TOOL]);
  const bad = 999_999; // 越界：既有上限是 24 小时（与配置那条路共用同一个上限）。
  const configPathCeiling = parseToolApprovalSettings({ approval: { ttl_seconds: bad } }).ttlSeconds;
  assert.ok(configPathCeiling <= 24 * 60 * 60, `既有上限不该超过一天：${configPathCeiling}`);

  const clamped = resolveToolApprovalSettings(config, { ask: [TOOL], ttlSeconds: bad });
  assert.equal(clamped.ttlSeconds, configPathCeiling, '显式来源与配置来源共用同一个上限');
  assert.ok(clamped.ttlSeconds < bad, '越界值不许原样通过');

  // 不可用的值退回出厂默认（不是 NaN / Infinity / 负数落进到期计算）。
  const fallback = parseToolApprovalSettings({}).ttlSeconds;
  for (const unusable of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveToolApprovalSettings(config, { ask: [TOOL], ttlSeconds: unusable }).ttlSeconds, fallback, `${unusable} 该退回默认`);
  }
  // 夹紧不是「一律改成默认」：合法区间内的值原样保留。
  assert.equal(resolveToolApprovalSettings(config, { ask: [TOOL], ttlSeconds: 60 }).ttlSeconds, 60);

  // 可观察后果：夹紧发生在算 `expires_at` 之前 —— 宿主拿到的是有界的那一个，落库的到期时间可解析、
  // 且不超过一个上限。这就是「不许静默接受」在数据上的样子（`ttlSeconds: Infinity` 会写到不可解析的
  // 到期时间，而这一行是重启后恢复待批请求的唯一依据）。
  const dir = tempDir();
  const clock = () => REQUESTED_AT;
  const store = openStore(dir, clock);
  try {
    const settings = resolveToolApprovalSettings(config, { ask: [TOOL], ttlSeconds: Number.POSITIVE_INFINITY });
    const manager = new ToolApprovalManager({ store, settings, now: clock });
    const registry = new ToolRegistry({
      permission: new ToolPermission({ role: 'resident', askTools: [...settings.ask] }),
      approval: manager,
    });
    registry.register(probeTool({ name: TOOL }));
    manager.useRegistry(registry);

    assert.equal(manager.ttlSeconds, fallback, '宿主拿到的也是归一化之后的那一份');
    const asked = await registry.execute(
      { name: TOOL, arguments: { amount: 1 } },
      { scope: 'conversation', timezone: 'Asia/Shanghai', now: REQUESTED_AT, sessionId: 'sess_ttl', actorId: 'father' },
    );
    const stored = new ToolApprovalStore(store).get(String(asked.payload['approvalId']));
    assert.ok(stored !== null);
    const expiry = Date.parse(stored.expiresAt);
    assert.ok(Number.isFinite(expiry), `到期时间必须可解析：${stored.expiresAt}`);
    assert.ok(expiry - REQUESTED_AT.getTime() <= 24 * 60 * 60 * 1000, `到期时间不许越过上限：${stored.expiresAt}`);
  } finally {
    store.close();
  }
});

test('a declared name is normalised first, so a sloppy declaration really takes effect', () => {
  // 归一化：去空白、丢空串、去重。两条来源同一套规则。
  assert.deepEqual(resolveToolApprovalSettings(configWithAsk([]), { ask: [` ${TOOL} `, TOOL, ''], ttlSeconds: 300 }), {
    ask: [TOOL],
    ttlSeconds: 300,
  });
  assert.deepEqual(parseToolApprovalSettings({ approval: { ask: [` ${TOOL} `] } }).ask, [TOOL], '配置那条路本来就是归一化的');

  const chain = buildToolChain(configWithAsk([]), { approval: { ask: [` ${TOOL} `], ttlSeconds: 300 } });
  chain.register(probeTool({ name: TOOL }));
  assert.equal(chain.check(TOOL, 'conversation').verdict, 'ask', '带空白的声明要真的命中工具名');

  // 反事实：不归一化时，带空白的名字与工具名不相等 —— 那种声明「看起来生效、实际永远匹配不上」。
  // 这条不是装饰，它说明上面那条断言真的在考归一化（把归一化拿掉，这里仍然绿、上面变红）。
  const raw = buildToolChain(configWithAsk([]), {
    permission: new ToolPermission({ role: 'resident', askTools: [` ${TOOL} `] }),
  });
  raw.register(probeTool({ name: TOOL }));
  assert.equal(raw.check(TOOL, 'conversation').verdict, 'allow');
});
