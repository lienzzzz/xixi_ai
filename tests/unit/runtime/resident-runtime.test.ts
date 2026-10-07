/**
 * V0.3 P2.5-A — the resident assembly point (`@xixi/runtime`'s `createResidentRuntime`).
 *
 * P2.5 exists because the delivered Agent abilities were wired **only in tests**: the plugin kernel,
 * the durable reminders and the approval host could all be exercised, and none of them were part of a
 * live runtime. This file is the offline gate for the one object that changes that, and it asserts the
 * three properties the assembly point is responsible for — not the features themselves:
 *
 *   1. **`start()` makes a plugin's tool visible to the model and executable by the core.** Visibility
 *      is read the way the model reads it (`definitionsForRound`), and execution is proven by running a
 *      real turn through `runtime.conversation`: engine → adapter → `runAgentLoop` → `ToolRegistry` →
 *      the plugin's tool. A test that only asked the registry whether the name exists would pass on a
 *      chain the adapter never sees (AGENTS §9.24: 「接线」 must be checked through the call graph).
 *   2. **`stop()` takes it away again** — out of the chain and out of the plugin layer, with a
 *      shutdown report that says what was released.
 *   3. **The hosts are the runtime's own**, not a second set: the approval gate the chain consults is
 *      `runtime.approvals` (a declared `ask` tool lands in *its* pending list, and confirming it
 *      executes the frozen call), and the reminder tool writes through the same durable sink the
 *      scheduler walks.
 *
 * Offline and free: no key, no network, no model — the adapter is the repo's scripted stand-in.
 *
 * 口径（AGENTS §9.24）：这个文件证明的是**装配点**成立，不是「活的西西已经用上它」。
 * 四个 live 入口尚未接线、提醒也尚未接进主动循环 —— 那两句话的事实锚点在
 * `packages/runtime/src/resident-runtime.ts` 的接线状态块，最后一条用例会守着它。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeBrainAdapter, type AgentTool, type ScriptedToolRequest, type ToolExecutionContext, type ToolRegistry } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { openXixiStore, parseXixiConfig, type XixiConfig, type XixiStore } from '@xixi/domain';
import type { InlinePlugin } from '@xixi/plugins';
import { CONVERSATION_SCOPE, RuntimeError, createResidentRuntime, type XixiResidentRuntime } from '@xixi/runtime';

/** A fixed instant: 「明天八点」 is 2026-10-06 08:00 in Shanghai, and nothing here reads the wall clock. */
const T0 = new Date('2026-10-05T09:00:00+08:00');
const SHANGHAI = 'Asia/Shanghai';
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SOURCE_PATH = join(REPO_ROOT, 'packages', 'runtime', 'src', 'resident-runtime.ts');

const BASE_YAML = `
xixi:
  identity:
    name: 西西
    language: zh-CN
    timezone: ${SHANGHAI}
    place: 成都
  models:
    llm: { provider: fake, model: fake-1, thinking_realtime: false }
    asr: { provider: fake, model: fake-asr }
    tts: { provider: fake, model: fake-tts }
  personality:
    base: {}
  proactive: {}
  memory: {}
  privacy: {}
  features: {}
`;

function config(extra = ''): XixiConfig {
  return parseXixiConfig(`${BASE_YAML}${extra}`, 'test-inline.yaml');
}

const CONTEXT: ToolExecutionContext = { scope: 'conversation', timezone: SHANGHAI, now: T0, sessionId: 'sess_runtime', actorId: 'father' };

interface ProbeTool extends AgentTool {
  readonly calls: { count: number };
}

/** A write-free stand-in tool so a run leaves no side effect beyond its own counter. */
function probeTool(name: string): ProbeTool {
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
      return { from: name };
    },
  };
}

function inlinePlugin(id: string, tool: AgentTool): InlinePlugin {
  return {
    manifest: { schemaVersion: 1, id, name: id, version: '0.1.0', permissions: ['tool.register'], capabilities: ['tool'] },
    module: { activate: () => ({ tools: [{ tool }] }) },
  };
}

interface Rig {
  readonly root: string;
  readonly store: XixiStore;
  readonly runtime: XixiResidentRuntime;
  readonly echo: ProbeTool;
  /** What the model builder was handed — it must be the runtime's own chain. */
  readonly builtWith: { readonly toolChain?: ToolRegistry };
}

/**
 * One runtime over a throwaway store, with one inline plugin exposing `demo.echo`.
 *
 * The adapter is scripted to ask for that tool on the first round of a turn whose text contains
 * 「插件」, so the same rig serves both the visibility assertions and a real end-to-end turn.
 */
function rig(overrides: { readonly config?: XixiConfig } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), 'xixi-resident-runtime-'));
  const store = openXixiStore({ dbPath: join(root, 'xixi.sqlite'), clock: () => T0 });
  const options = overrides.config ?? config();
  store.seedSelfProfile(options.personality.base);
  const echo = probeTool('demo.echo');
  const builtWith: { toolChain?: ToolRegistry } = {};
  const runtime = createResidentRuntime({
    config: options,
    store,
    now: () => T0,
    inline: [inlinePlugin('xixi.demo', echo)],
    conversation: { clock: () => T0, turnTimeoutMs: 5_000 },
    model: ({ toolChain }) => {
      builtWith.toolChain = toolChain;
      return new FakeBrainAdapter({
        registry: toolChain,
        scope: CONVERSATION_SCOPE,
        toolPlan: (input, round): readonly ScriptedToolRequest[] => (round === 1 && input.text.includes('插件') ? [{ name: 'demo.echo' }] : []),
      });
    },
  });
  return { root, store, runtime, echo, builtWith };
}

function dispose(rig: Rig): void {
  rig.store.close();
  rmSync(rig.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** What the model is offered this round — the only way a tool ever reaches it. */
function offeredTools(registry: ToolRegistry): string[] {
  return (registry.definitionsForRound(CONVERSATION_SCOPE, 1) ?? []).map((definition) => definition.name);
}

test('start() 之后：插件工具对模型可见，并且真的能被核心执行；stop() 之后它就不在了', async () => {
  const r = rig();
  try {
    const { runtime, store, echo } = r;

    // 装配时它已经拿到了链 —— 但插件还没启动，所以链上还没有插件工具。
    assert.equal(runtime.state, 'created');
    assert.equal(r.builtWith.toolChain, runtime.toolChain, '模型适配器必须拿到这个 runtime 自己的工具链');
    assert.equal(runtime.toolChain, runtime.plugins.registry, '同一个对象，不是两份');
    assert.ok(runtime.conversation instanceof ConversationEngine);
    assert.equal(runtime.store, store);
    assert.equal(runtime.toolChain.names().includes('demo.echo'), false, 'start 之前不该有插件工具');
    assert.equal(offeredTools(runtime.toolChain).includes('demo.echo'), false);

    const report = await runtime.start();

    assert.equal(runtime.state, 'started');
    assert.deepEqual(report.plugins, [{ pluginId: 'xixi.demo', state: 'active' }]);
    assert.deepEqual(report.mounted, ['demo.echo']);
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(report.refused, []);
    assert.ok(report.tools.includes('demo.echo'), `模型可见的工具里该有它：${report.tools.join('、')}`);
    // 模型侧的可观察定义：`definitionsForRound` 列出了它。
    assert.ok(offeredTools(runtime.toolChain).includes('demo.echo'), '模型该看到插件工具');

    // 「能被核心执行」不是读注册表，而是走一轮真实对话：引擎 → 适配器 → runAgentLoop → registry。
    const session = store.createSession();
    const turn = await runtime.conversation.respond({ sessionId: session.sessionId, text: '用插件工具试试', addressed: true });
    assert.equal(turn.accepted, true);
    assert.equal(turn.toolName, 'demo.echo');
    assert.equal(echo.calls.count, 1, '插件工具必须真的被执行了一次');

    // stop()：插件工具从模型可见的工具链里消失，插件层也被停掉。
    const shutdown = await runtime.stop();
    assert.equal(runtime.state, 'stopped');
    assert.equal(shutdown.state, 'stopped');
    assert.deepEqual(shutdown.plugins.unmounted, ['demo.echo']);
    assert.equal(shutdown.extractionDrained, true);
    assert.deepEqual(runtime.toolChain.names(), []);
    assert.equal(runtime.toolChain.definitionsForRound(CONVERSATION_SCOPE, 1), undefined);
    assert.deepEqual(runtime.plugins.runtime.capabilities.list(), []);
    assert.equal(runtime.plugins.runtime.manager.instance('xixi.demo')?.state, 'disposed');

    // 幂等：再关一次不抛，而且是同一份报告（第二次调用不再重复关停）。
    assert.equal(await runtime.stop(), shutdown);
  } finally {
    dispose(r);
  }
});

test('start() 只认一次：重复启动报声明性错误，关停之后也不能再启动', async () => {
  const r = rig();
  try {
    await r.runtime.start();
    await assert.rejects(
      () => r.runtime.start(),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError, '该抛 runtime 自己的错误类型');
        assert.equal(error.code, 'RESIDENT_RUNTIME_ALREADY_STARTED');
        assert.match(error.message, /已经启动过/);
        return true;
      },
    );

    await r.runtime.stop();
    await assert.rejects(() => r.runtime.start(), /已经启动过/);
  } finally {
    dispose(r);
  }
});

test('审批宿主就是这个 runtime 自己的那个：声明的 ASK 落进它的待批列表，点头后执行冻结的那次调用', async () => {
  const r = rig({ config: config("  tools:\n    approval:\n      ask: ['demo.echo']\n      ttl_seconds: 300\n") });
  try {
    const { runtime, echo } = r;
    await runtime.start();

    // 声明面从 `config.tools.approval.ask` 来，而且同时落到了审批宿主与工具链两处。
    assert.deepEqual(runtime.approvals.askTools, ['demo.echo']);
    assert.equal(runtime.toolChain.check('demo.echo', CONVERSATION_SCOPE).verdict, 'ask');

    const asked = await runtime.toolChain.execute({ name: 'demo.echo', arguments: {} }, CONTEXT);
    assert.equal(asked.record.error, 'APPROVAL_REQUIRED');
    assert.equal(asked.payload['requiresApproval'], true);
    assert.equal(echo.calls.count, 0, 'ASK 的工具在点头之前一次都不许跑');

    const pending = runtime.approvals.pending(T0);
    assert.equal(pending.length, 1, '待批请求落在**这个**宿主里');
    assert.equal(pending[0]?.toolName, 'demo.echo');

    // 点头之后执行的是冻结的那一组参数 —— 这也证明 `useRegistry()` 被补上了（装配顺序的闭环）。
    const decision = await runtime.approvals.approve({ approvalId: pending[0]!.approvalId, actorId: 'father', now: T0 });
    assert.equal(decision.status, 'executed');
    assert.equal(echo.calls.count, 1);
    assert.deepEqual(runtime.approvals.pending(T0), [], '决定过的不再等谁点头');
  } finally {
    dispose(r);
  }
});

test('提醒落地：工具写进的是 durable sink，调度器在同一个库上按时读到它', async () => {
  const r = rig();
  try {
    const { runtime } = r;
    await runtime.start();

    // 内置提醒工具（名字在 V0.3 P2.5-G 会改，所以这里按语义找，不写字面量）走的是这个 runtime 的 sink。
    const reminderTool = runtime.toolChain.names().find((name) => name.includes('remind'));
    assert.ok(reminderTool !== undefined, `链上该有内置提醒工具：${runtime.toolChain.names().join('、')}`);
    const execution = await runtime.toolChain.execute({ name: reminderTool, arguments: { what: '给儿子打电话', when: '明天八点' } }, CONTEXT);
    assert.equal(execution.record.ok, true, JSON.stringify(execution.payload));
    const fromTool = String(execution.payload['id']);
    assert.equal(execution.payload['when'], '2026-10-06T08:00:00.000+08:00', '工具回给模型的是解析后的绝对时刻');
    assert.deepEqual(runtime.reminders.waiting(), [], '还没到点，没有谁「等着说」');

    // 第二条走宿主侧入口（入口没有模型调用时就是这么写提醒的）：它落在同一张表里，
    // 所以下面调度器读到的是**两行**，而不是只有工具写的那一行。
    const fromSink = runtime.reminderSink.scheduleAt({ what: '买牛奶', when: '明天八点', now: T0 }).change.reminder.id;
    assert.notEqual(fromSink, fromTool);

    // 没到点，调度器一步都不许走；到点之后两条都成为「可以说了」的候选。
    // 两条的 due_at 完全相同，所以按**集合**比，不依赖并列时的先后（AGENTS §9.25 ④）。
    assert.deepEqual(runtime.reminders.tick(T0).becameDue, [], '没到点不许提前动它');
    const atDue = runtime.reminders.tick(new Date('2026-10-06T08:00:00+08:00'));
    assert.deepEqual([...atDue.becameCandidate.map((reminder) => reminder.id)].sort(), [fromTool, fromSink].sort());
    assert.deepEqual(runtime.reminders.waiting().map((reminder) => reminder.what).sort(), ['买牛奶', '给儿子打电话'].sort());

    const shutdown = await runtime.stop();
    assert.equal(shutdown.remindersWaiting, 2, '关停报告如实说出还有几条等着说');
    assert.equal(shutdown.pendingApprovals, 0, '没有待批请求时如实报 0');
  } finally {
    dispose(r);
  }
});

/**
 * The honesty pin (AGENTS §9.24 / §9.25 ⑤).
 *
 * 「入口尚未接线」 and 「提醒回路尚未接线」 are load-bearing sentences, not decoration: without them the
 * file reads as if the four live entries and the proactive loop already used it. Pinning them here
 * means a rewrite that quietly flips them goes red — and wiring them for real (P2.5-B / P2.5-F) must
 * update **both** the comment and this test in the same change, which is the point. The counterfactual
 * below proves the check is not vacuous.
 */
function missingHonestyMarkers(source: string): string[] {
  const missing: string[] = [];
  if (!source.includes('入口尚未接线')) missing.push('入口尚未接线');
  if (!source.includes('提醒回路尚未接线')) missing.push('提醒回路尚未接线');
  return missing;
}

test('诚实口径：装配点写明「入口尚未接线」与「提醒回路尚未接线」（改口要连这条用例一起改）', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  assert.deepEqual(missingHonestyMarkers(source), [], `${SOURCE_PATH} 的两句接线状态不见了`);

  // 反事实：把任一句改成「已接线」的说法，必须被这条检查判出来。
  assert.deepEqual(missingHonestyMarkers(source.replace('入口尚未接线', '入口已接线')), ['入口尚未接线']);
  assert.deepEqual(missingHonestyMarkers(source.replace('提醒回路尚未接线', '提醒回路已接线')), ['提醒回路尚未接线']);
});
