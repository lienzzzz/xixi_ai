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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeBrainAdapter, type AgentTool, type ScriptedToolRequest, type ToolExecutionContext, type ToolRegistry } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { ReminderStore, loadXixiConfig, openXixiStore, parseXixiConfig, type XixiConfig, type XixiStore } from '@xixi/domain';
import type { InlinePlugin } from '@xixi/plugins';
import { createStubNewsSource, stubItem, type NewsPluginOptions } from '@xixi/plugins/news';
import {
  CONVERSATION_SCOPE,
  DurableReminderSink,
  RuntimeError,
  createResidentRuntime,
  type PluginChainOptions,
  type XixiResidentRuntime,
} from '@xixi/runtime';

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
 * `plugins` 给了就用给的那一批（坏插件那两条用例要的是别的插件，不是这一支）；`chain` 是**入口自己声明的**
 * 插件层入参（news / mcpServers / sources / fetchImpl…），P2.5-H 的「配置 vs 入口声明」两条用例要用它；
 * `toolName` 换掉替身请求的那个工具（默认 `demo.echo`）。
 */
function rig(
  overrides: {
    readonly config?: XixiConfig;
    readonly plugins?: readonly InlinePlugin[];
    readonly chain?: PluginChainOptions;
    readonly toolName?: string;
  } = {},
): Rig {
  const root = mkdtempSync(join(tmpdir(), 'xixi-resident-runtime-'));
  const store = openXixiStore({ dbPath: join(root, 'xixi.sqlite'), clock: () => T0 });
  const options = overrides.config ?? config();
  store.seedSelfProfile(options.personality.base);
  const echo = probeTool('demo.echo');
  const scripted = overrides.toolName ?? 'demo.echo';
  const builtWith: { toolChain?: ToolRegistry } = {};
  const runtime = createResidentRuntime({
    config: options,
    store,
    now: () => T0,
    inline: overrides.plugins ?? [inlinePlugin('xixi.demo', echo)],
    ...(overrides.chain ?? {}),
    conversation: { clock: () => T0, turnTimeoutMs: 5_000 },
    model: ({ toolChain }) => {
      builtWith.toolChain = toolChain;
      return new FakeBrainAdapter({
        registry: toolChain,
        scope: CONVERSATION_SCOPE,
        toolPlan: (input, round): readonly ScriptedToolRequest[] => (round === 1 && input.text.includes('插件') ? [{ name: scripted }] : []),
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

/**
 * stop-before-start：一次都没 `start()` 过就先 `stop()`，之后 `start()` 必须**拒**。
 *
 * 缺陷本体（P2.5-C round 3，修复前实测）：这条路上 `startCalled` 还是 false，旧守卫放行 ——
 * `plugins.start()` 返回空（插件内核已经 dispose，`loadAll` 是「能起来多少起来多少」的入口）、
 * 挂载无事可做，于是对象报 `state: 'started'` 而链是**空的**（内置工具在 `stop()` 时就 dispose 了）。
 * 「看起来起来了、其实什么都调不了」正是这条验收要消灭的静默状态。
 *
 * 判据是事实而不是状态字符串：对照组证明「正常启动后链非空」，实验组证明「关停之后 start 抛错、链
 * 始终为空」。撤掉 `shutdown()` 里那个终态标记（或 `start()` 里那道守卫），实验组会拿到一条空链的
 * `ResidentStartReport`，`assert.rejects` 立刻变红 —— 反事实在仓外副本里跑过（见回报）。
 */
test('stop() 之后再 start()：关停是终态（拒因是「已经关停」而不是「已经启动过」），链不会假装还在', async () => {
  const control = rig(); // 对照组：没关停过，start() 之后链里必须有东西
  const closed = rig(); // 实验组：一次都没 start 就先 stop()
  try {
    // 先把「正常路径上链非空」钉住：否则下面「链是空的」可能只是断言写错了。
    const started = await control.runtime.start();
    assert.ok(started.tools.length > 0, `正常启动后链上该有内置工具：${started.tools.join('、') || '无'}`);
    assert.ok(control.runtime.toolChain.names().length > 0);
    assert.notEqual(control.runtime.toolChain.definitionsForRound(CONVERSATION_SCOPE, 1), undefined);

    // 实验组：从没启动过就先关停 —— 宿主启动失败时就是这么收尾的。
    const shutdown = await closed.runtime.stop();
    assert.equal(shutdown.state, 'stopped');
    assert.deepEqual(closed.runtime.toolChain.names(), [], '关停把链清空（内置工具也一起）');

    // 事实面：这条路上要的是**抛错**，而不是「拿到一条空链却报 started」。
    await assert.rejects(
      () => closed.runtime.start(),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError, '该抛 runtime 自己的错误类型');
        assert.equal(error.code, 'RESIDENT_RUNTIME_ALREADY_STOPPED');
        assert.match(error.message, /已经关停/);
        assert.match(error.message, /新建一个 runtime/, '必须说明「要重启就新建一个 runtime」');
        assert.doesNotMatch(error.message, /已经启动过/, '这条路上它确实没启动过，写成重复启动就是新的谎');
        return true;
      },
    );
    assert.equal(closed.runtime.state, 'stopped', '不许留下「state=started 而链是空的」这种静默状态');
    assert.deepEqual(closed.runtime.toolChain.names(), []);
    assert.equal(closed.runtime.toolChain.definitionsForRound(CONVERSATION_SCOPE, 1), undefined);
  } finally {
    dispose(control);
    dispose(closed);
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

    // 内置提醒工具（名字在 V0.3 P2.5-E 改过一次：`xixi_set_reminder_stub` → `xixi_set_reminder`；
    // 这里仍然按语义找，不写字面量）走的是这个 runtime 的 sink。
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
 * 关库发生在 stop() 之前（`countIfReadable` 那道守卫的坏输入）。
 *
 * 反事实：把 `countIfReadable` 的 try/catch 拿掉、让它直接 `read()`，这条立刻变红 —— 库关了以后
 * `reminders.waiting()` / `approvals.pending()` 会抛，而「关停报告必须给得出来」是装配点的承诺
 * （AGENTS §9.25⑤：每个守卫都要有一条坏输入用例，否则它只是纸面上的防线）。
 */
test('提醒接缝是装配点交出的那一对：先跑到点再取候选；没真的说出口就不许前进（V0.3 P2.5-F）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xixi-resident-seams-'));
  let nowAt = T0;
  const store = openXixiStore({ dbPath: join(root, 'xixi.sqlite'), clock: () => nowAt });
  const options = config();
  store.seedSelfProfile(options.personality.base);
  const runtime = createResidentRuntime({
    config: options,
    store,
    now: () => nowAt,
    conversation: { clock: () => nowAt, turnTimeoutMs: 5_000 },
    model: ({ toolChain }) => new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE }),
  });
  try {
    await runtime.start();

    // 入口路径上的 sink 是 **durable 的那个**，不是工具自己的内存兜底。
    assert.ok(runtime.reminderSink instanceof DurableReminderSink, '装配点必须提供 durable sink');
    const reminderTool = runtime.toolChain.names().find((name) => name.includes('remind'));
    assert.ok(reminderTool !== undefined, `链上该有内置提醒工具：${runtime.toolChain.names().join('、')}`);
    const execution = await runtime.toolChain.execute(
      { name: reminderTool, arguments: { what: '给儿子打电话', when: '明天八点' } },
      { ...CONTEXT, now: nowAt },
    );
    assert.equal(execution.record.ok, true, JSON.stringify(execution.payload));
    const reminderId = String(execution.payload['id']);
    // 工具写进的是这个 runtime 的库：内存 sink 时代这张表会是空的。
    assert.ok(new ReminderStore(store).get(reminderId) !== null, '提醒必须真的落库');

    // 没到点：读接缝什么都不给，状态也不许被提前写成 due。
    assert.deepEqual(runtime.reminderSeams.readDueReminders(), []);
    assert.equal(new ReminderStore(store).get(reminderId)?.status, 'pending', '没到点不许动它');

    // 到点：接缝**自己**跑「先跑到点、再取候选」（`markDue` + `candidateInputs`）。只做后半句的话，
    // 这条提醒会永远停在 pending —— 上面那条断言与这里会一起红。
    nowAt = new Date('2026-10-06T08:00:00+08:00');
    const offered = runtime.reminderSeams.readDueReminders();
    assert.deepEqual(offered.map((input) => input.reminderId), [reminderId], '到点就该被交出来');
    assert.equal(new ReminderStore(store).get(reminderId)?.status, 'candidate');
    assert.equal(offered[0]?.line, '该提醒你了：给儿子打电话');
    // 反复读仍然给（candidate 不是一次性的：说出口或过期才会离开这个状态）。
    assert.deepEqual(runtime.reminderSeams.readDueReminders().map((input) => input.reminderId), [reminderId]);

    // 送达接缝只是记账：没人调它就一步都不许前进。
    assert.equal(new ReminderStore(store).get(reminderId)?.deliveredAt, null, '没说出口就没有 delivered_at');
    runtime.reminderSeams.onReminderDelivered(reminderId, new Date('2026-10-06T08:01:00+08:00'));
    const delivered = new ReminderStore(store).get(reminderId);
    assert.equal(delivered?.status, 'delivered');
    assert.equal(Date.parse(String(delivered?.deliveredAt)), Date.parse('2026-10-06T08:01:00+08:00'));
    // 与 `runtime.reminders` 是同一个调度器：状态从它那边读也是一样的（不是另一份账）。
    assert.deepEqual(runtime.reminders.waiting(), [], '说过的提醒不再等谁点头');
  } finally {
    await runtime.stop().catch(() => {});
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('库先关掉再 stop()：两个计数如实报 null 而不是抛（拿掉那道 try/catch 就会红）', async () => {
  const r = rig();
  try {
    const { runtime, store } = r;
    await runtime.start();
    store.close(); // 反着来：宿主提前关库，装配点的关停仍要给得出报告

    const shutdown = await runtime.stop();
    assert.equal(shutdown.state, 'stopped');
    assert.equal(shutdown.remindersWaiting, null, '读不到就报 null，不许编一个数字');
    assert.equal(shutdown.pendingApprovals, null, '同上：读不到就说读不到');
    assert.equal(runtime.state, 'stopped');
    assert.deepEqual(runtime.toolChain.names(), [], '关停照样把链清空');
  } finally {
    dispose(r);
  }
});

/**
 * 插件层自己的失败不穿透装配点：`start()` / `stop()` 都不因此抛（失败如实记在插件状态里）。
 *
 * 这条同时钉住两件容易想当然的事（实测得来，不是推的）：
 *  * `activate` 抛异常的插件**不会**让 `start()` 失败 —— 内核的 `loadAll` 是「能起来多少起来多少」的
 *    入口，逐插件捕获并记账，所以装配点看到的是 `state: 'inactive'`、工具一个都没挂上；
 *  * `dispose` 抛异常的插件**不会**让 `stop()` 失败 —— `disposeAll` 同样逐插件捕获。
 *
 * 它也是 F4 那两条坏输入用例的登记处：`start()` 与 `stop()` 在今天的公开选项下**都没有可达的抛错
 * 路径**（插件层的失败被逐条吞掉），所以「start 抛过也拒绝重试」与「stop 失败会被重试而不是缓存」
 * 构造不出坏输入。这里只把**可达的那一半**钉死（第二次 start 仍然只认一次），完整登记见文件末尾。
 */
test('插件层失败不穿透装配点：activate / dispose 抛异常都不让 start() / stop() 失败', async () => {
  const hooks = { deactivate: 0, dispose: 0 };
  const stubborn = probeTool('demo.stubborn');
  const r = rig({
    plugins: [
      {
        manifest: { schemaVersion: 1, id: 'xixi.explodes', name: 'xixi.explodes', version: '0.1.0', permissions: ['tool.register'], capabilities: ['tool'] },
        module: { activate: () => { throw new Error('activate 炸了'); } },
      },
      {
        manifest: { schemaVersion: 1, id: 'xixi.stubborn', name: 'xixi.stubborn', version: '0.1.0', permissions: ['tool.register'], capabilities: ['tool'] },
        module: {
          activate: () => ({ tools: [{ tool: stubborn }] }),
          deactivate: () => { hooks.deactivate += 1; throw new Error('deactivate 炸了'); },
          dispose: () => { hooks.dispose += 1; throw new Error('dispose 炸了'); },
        },
      },
    ],
  });
  try {
    const { runtime } = r;
    const report = await runtime.start();

    assert.deepEqual(
      report.plugins,
      [
        { pluginId: 'xixi.explodes', state: 'inactive' },
        { pluginId: 'xixi.stubborn', state: 'active' },
      ],
      '起不来的那个如实标 inactive，起来的那个照常 active',
    );
    assert.deepEqual(report.mounted, ['demo.stubborn'], 'activate 失败的插件不该留下任何工具');
    assert.equal(runtime.state, 'started');
    assert.ok(runtime.toolChain.names().includes('demo.stubborn'));

    // 可达的那一半：第二次 start() 仍然只认一次（`startCalled` 不会因为旁边有个坏插件被放过）。
    await assert.rejects(() => runtime.start(), /已经启动过/);

    // dispose 钩子抛异常，也不能让关停失败：钩子要真的被叫过，撤回与清链照做。
    const shutdown = await runtime.stop();
    assert.equal(shutdown.state, 'stopped');
    assert.equal(hooks.dispose, 1, '关停必须真的叫过插件的 dispose 钩子（抛了也要继续关）');
    assert.deepEqual(shutdown.plugins.unmounted, ['demo.stubborn']);
    assert.deepEqual(runtime.toolChain.names(), []);
  } finally {
    dispose(r);
  }
});

// ---------------------------------------------------------------------------------------------
// V0.3 P2.5-H：配置真的能管插件（`xixi.plugins` → 目录 / 新闻来源 / MCP 服务器）
//
// 这一组的判据不是「源码里出现了某个函数名」，而是**装配之后能观察到什么**：
//   * 配置里的 MCP 服务器 → `runtime.plugins.mcp.serverNames()`（内核真的收到了），且**还没连**；
//   * 配置里的 `command` → 真的连上了一台本地桩服务器，工具挂进模型可见的链并被一轮对话执行；
//   * 配置里的新闻来源 → 插件 `state().sources` 里那一条（全程一个请求都没发）；
//   * 配置里的目录 → 内核真的发现了那个插件并挂上它的工具。
// 反面同样重要：出厂配置（`news.enabled: false`、空 servers）与「入口自己声明的那份」都不许被改变 ——
// 那一条就是「加配置不改变默认工具集」。
// ---------------------------------------------------------------------------------------------

const EXAMPLE_CONFIG = join(REPO_ROOT, 'config', 'xixi.example.yaml');

/** `plugins.mcp.servers` 的一段 YAML：一台真的 stdio 服务器，外加一台被停用的（它不该进内核）。 */
function mcpServersYaml(script: string): string {
  // 单引号是 YAML 的字面量引法：Windows 的 `C:\...` 用双引号会被当成转义序列。
  return `  plugins:
    mcp:
      servers:
        fixture:
          transport: stdio
          command: '${process.execPath}'
          args: ['${script}']
          timeout_ms: 15000
        retired:
          enabled: false
          transport: stdio
          command: '${process.execPath}'
          args: ['${script}']
`;
}

/**
 * 一个**跑在另一个进程里**的桩 MCP 服务器（配置里写的就是「起哪个命令」，所以它必须是个真实的可执行入口）。
 *
 * SDK 用绝对 URL 引：临时目录不在仓库里，Node 从那里向上找不到 `node_modules`。
 */
function writeFixtureMcpServer(dir: string): string {
  const main = import.meta.resolve('@modelcontextprotocol/server');
  const stdio = import.meta.resolve('@modelcontextprotocol/server/stdio');
  const script = join(dir, 'fixture-mcp-server.mjs');
  writeFileSync(
    script,
    [
      `import { fromJsonSchema, McpServer } from '${main}';`,
      `import { StdioServerTransport } from '${stdio}';`,
      "const server = new McpServer({ name: 'fixture', version: '0.0.1' });",
      "server.registerTool('echo', { description: '配置驱动的桩 MCP 工具',",
      "  inputSchema: fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false }) },",
      "  async () => ({ content: [{ type: 'text', text: '来自配置里的 MCP 服务器' }] }));",
      'await server.connect(new StdioServerTransport());',
      '',
    ].join('\n'),
    'utf8',
  );
  return script;
}

test('配置声明的 MCP 服务器在装配时变成连接函数（还没连）；enabled:false 的那台不进内核（P2.5-H）', () => {
  // 这一步故意**不** start()：要证明的是「配置 → McpServerSpec + connect 工厂」这一层在装配时就完成了，
  // 而连接仍然是惰性的（内核在自己的 activate() 里才连）。
  const r = rig({ config: config(mcpServersYaml('/tmp/xixi-never-run.mjs')), plugins: [] });
  try {
    assert.deepEqual(r.runtime.plugins.mcp?.serverNames(), ['fixture'], '配置里的那台进了内核，被停用的那台没进');
    const statuses = r.runtime.plugins.mcp?.status() ?? [];
    assert.deepEqual(statuses.map((entry) => `${entry.server}=${entry.state}`), ['fixture=idle'], '装配只翻译配置，不连接');
    assert.equal(statuses[0]?.stats.connects, 0, '一次连接都不许发生');
  } finally {
    dispose(r);
  }
});

test('配置里的 MCP 服务器真的连得上：工具挂进模型可见的链，并被一轮对话执行（离线本地桩服务器）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-mcp-fixture-'));
  const r = rig({ config: config(mcpServersYaml(writeFixtureMcpServer(dir))), plugins: [], toolName: 'mcp.fixture.echo' });
  try {
    const report = await r.runtime.start();
    const status = r.runtime.plugins.mcp?.status()[0];
    assert.equal(status?.state, 'connected', `配置里那台必须真的连上：${JSON.stringify(status)}`);
    assert.ok(report.tools.includes('mcp.fixture.echo'), `模型可见的工具里该有它：${report.tools.join('、')}`);
    assert.ok(report.mounted.includes('mcp.fixture.echo'), '它必须是「这次启动挂上去的」，不是本来就在链上');
    assert.ok(offeredTools(r.runtime.toolChain).includes('mcp.fixture.echo'));

    // 「接得上」不是读状态：走一轮真实对话，模型请求它、核心执行它。
    const session = r.store.createSession();
    const turn = await r.runtime.conversation.respond({ sessionId: session.sessionId, text: '用插件里的 MCP 工具试试', addressed: true });
    assert.equal(turn.toolName, 'mcp.fixture.echo', '这一轮必须走配置里那台服务器的工具');
    // 回复文案不断言：离线替身不为它不认识的工具说话（`sayToolResult` 的 default 分支）。
    // 「那台服务器真的答了」由核心执行路径证明：工具链 → MCP 适配器 → 子进程 → 结果回读。
    const called = await r.runtime.toolChain.execute({ name: 'mcp.fixture.echo', arguments: {} }, CONTEXT);
    assert.equal(called.record.error, null, `工具调用不该失败：${JSON.stringify(called.record)}`);
    assert.match(JSON.stringify(called.payload), /来自配置里的 MCP 服务器/, '结果必须来自配置里那台服务器');

    // 关停真的把连接放掉（子进程随之结束），链也清空。
    await r.runtime.stop();
    assert.notEqual(r.runtime.plugins.mcp?.status()[0]?.state, 'connected', '关停之后不许还挂着一条连接');
    assert.deepEqual(r.runtime.toolChain.names(), []);
  } finally {
    if (r.runtime.state === 'started') await r.runtime.stop();
    dispose(r);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('配置里的新闻来源真的装进插件（离线、一个请求都不发）；出厂配置不接管，入口自己那份照旧（P2.5-H）', async () => {
  const fetched: string[] = [];
  const spyFetch = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    throw new Error('离线用例不许联网');
  }) as unknown as typeof fetch;

  // ① 配置接管：`enabled: true` + 一条 rss → 没有自带来源的入口也用它。
  const withConfigNews = rig({
    config: config(`  plugins:
    news:
      enabled: true
      sources:
        - type: rss
          name: 配置里的来源
          url: https://example.com/config-feed.xml
`),
    plugins: [],
    chain: { fetchImpl: spyFetch },
  });
  try {
    await withConfigNews.runtime.start();
    assert.deepEqual(
      withConfigNews.runtime.plugins.news?.state().sources.map((source) => `${source.name}:${source.kind}`),
      ['配置里的来源:rss'],
      '配置里那条 RSS 必须真的成为插件的来源',
    );
    assert.deepEqual(fetched, [], '装配来源不许发请求（来源只在被调用时才取）');
  } finally {
    await withConfigNews.runtime.stop();
    dispose(withConfigNews);
  }

  // ② 出厂的 `news.enabled: false`（配置不接管）+ 入口自己声明的那份 → 入口那份照旧。
  //    这正是四个 CLI 入口今天的处境：它们各自在 scripts/ 里带了一条 RSS。
  const ownNews: NewsPluginOptions = {
    sources: [() => createStubNewsSource({ name: '入口自己那份', items: [stubItem({ id: 'own-1', title: '入口的头条' })] })],
  };
  const byEntry = rig({ config: loadXixiConfig(EXAMPLE_CONFIG), plugins: [], chain: { news: ownNews, fetchImpl: spyFetch } });
  try {
    await byEntry.runtime.start();
    assert.deepEqual(byEntry.runtime.plugins.news?.state().sources.map((source) => source.name), ['入口自己那份']);
  } finally {
    await byEntry.runtime.stop();
    dispose(byEntry);
  }

  // ③ 出厂配置 + 入口一个都不声明（现场测试控制台与试用页就是这一类）→ 没有新闻插件。
  //    「加配置不改变默认工具集」在新闻这一半上的证据就是这一条。
  const none = rig({ config: loadXixiConfig(EXAMPLE_CONFIG), plugins: [], chain: { fetchImpl: spyFetch } });
  try {
    const report = await none.runtime.start();
    assert.equal(none.runtime.plugins.news, undefined, '出厂配置不接管新闻：没有自带来源的入口就没有新闻工具');
    assert.deepEqual([...report.tools].sort(), ['xixi_get_current_time', 'xixi_get_weather', 'xixi_set_reminder'].sort());
  } finally {
    await none.runtime.stop();
    dispose(none);
  }

  assert.deepEqual(fetched, [], '整条用例一个请求都没发过');
});

test('plugins.enabled:false 是插件层总开关：入口自己带的 inline 插件也不装，链上只剩三个内置工具（P2.5-H）', async () => {
  // 反面对照就在本文件第一条用例：默认配置（`enabled` 缺省 = true）下，同一个 rig 的 `demo.echo` 是装上的。
  const r = rig({ config: config('  plugins:\n    enabled: false\n') });
  try {
    const report = await r.runtime.start();
    assert.deepEqual(
      [...report.tools].sort(),
      ['xixi_get_current_time', 'xixi_get_weather', 'xixi_set_reminder'].sort(),
      `关掉插件层之后链上只剩内置工具：${report.tools.join('、')}`,
    );
    assert.deepEqual(report.mounted, []);
    assert.equal(report.plugins.length, 0);
    assert.equal(r.echo.calls.count, 0, 'inline 插件也不该被激活');
    assert.equal(r.runtime.plugins.news, undefined);
    assert.equal(r.runtime.plugins.mcp, undefined);
  } finally {
    await r.runtime.stop();
    dispose(r);
  }
});

test('配置里的插件目录真的被内核发现并装上（预装的原生插件，P2.5-H）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-plugin-dir-'));
  const pluginRoot = join(dir, 'native');
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'demo.native',
      name: '配置目录里的原生插件',
      version: '0.1.0',
      entry: './index.mjs',
      permissions: ['tool.register'],
      capabilities: ['tool'],
    }),
    'utf8',
  );
  writeFileSync(
    join(pluginRoot, 'index.mjs'),
    [
      'export function activate() {',
      '  return {',
      '    tools: [{',
      '      tool: {',
      "        name: 'native.echo',",
      "        description: '配置目录里的插件工具',",
      "        parameters: { type: 'object', properties: {}, additionalProperties: false },",
      "        risk: 'read',",
      "        scopes: ['conversation'],",
      "        async execute() { return { from: 'native.echo' }; },",
      '      },',
      '    }],',
      '  };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const r = rig({ config: config(`  plugins:\n    directories:\n      - '${pluginRoot}'\n`), plugins: [] });
  try {
    const report = await r.runtime.start();
    assert.deepEqual(report.plugins.map((entry) => `${entry.pluginId}=${entry.state}`), ['demo.native=active']);
    assert.ok(report.mounted.includes('native.echo'), `目录里的插件工具该被挂上：${report.mounted.join('、') || '无'}`);
    assert.ok(offeredTools(r.runtime.toolChain).includes('native.echo'), '模型该看得到它');
  } finally {
    await r.runtime.stop();
    dispose(r);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/**
 * 接线口径的判据（AGENTS §9.24 / §9.25 ⑤）：**不钉句子，拿事实对口径**。
 *
 * 前一版断言 `resident-runtime.ts` 里存在「入口尚未接线」这句字符串，它栽在同一个坑上两次：t2 把两个
 * 入口接进装配点之后那句话已经是假的，用例照样绿（保护的是句子，不是事实）；等真正改口时它又红了 ——
 * 两次都跟代码事实无关。现在改成两条：
 *
 *  * 口径必须给出**可复核命令**（名单会过期，命令不会），提醒回路那句承重的话不许被顺手删掉；
 *  * 口径里凡**点名了入口文件**的说法，逐个按代码核（这个文件到底调不调 `createResidentRuntime`），
 *    与调用图不符就红。今天口径走的是「给命令、不复述名单」的写法，所以它只在自己点名的地方被核对 ——
 *    这正是它不会过期的那种写法该有的待遇。
 */
const LIVE_ENTRIES = ['chat', 'serve-chat', 'field-test', 'voice-turn'] as const;
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');

/** 一条一条读：「已接 / 未接」按 ` *  * ` 起头的段落分（`resident-runtime.ts` 一直这么写）。 */
function wiringBullets(block: string): string[] {
  return block.split(/\n \* {2}\* /).slice(1);
}

/**
 * 口径与调用图不一致的地方（空数组 = 一致）。
 *
 * `wired` 是「这个入口真的调了 `createResidentRuntime` 吗」——抽成参数是为了让反事实能在同一条用例里
 * 换一张调用图重算一次，而不是靠人去相信这段检查。
 */
function wiringMismatches(block: string, wired: (entry: string) => boolean): string[] {
  const problems: string[] = [];
  // 名单会过期，命令不会：口径必须给得出「谁接了线、谁还在自己拼链」两条可复核命令。
  if (!/git grep -n 'createResidentRuntime\(/.test(block)) {
    problems.push('缺少可复核命令（谁接了线要能用命令重算，不能只写名单）');
  }
  if (!/git grep -n 'buildToolChain\(/.test(block)) {
    problems.push('缺少「谁还在自己拼链」的可复核命令');
  }
  // 提醒回路那句仍然承重（P2.5-F 之前它必须还在），别在改口时被顺手删掉。
  if (!/提醒回路尚未接线/.test(block)) {
    problems.push('「提醒回路尚未接线」这句口径不见了');
  }
  // 口径说「已经接线」不能是空话：四个 live 入口至少要有一个真的在调装配点。
  if (!LIVE_ENTRIES.some((entry) => wired(entry))) {
    problems.push('四个 live 入口一个都没走装配点，口径里「已经接线」就是假的');
  }
  // 点名了某个入口的文件，就要为那句话负责 —— 说「已接」得真有调用，说「未接」得真没有。
  for (const entry of LIVE_ENTRIES) {
    const named = wiringBullets(block).find((bullet) => bullet.includes(`scripts/${entry}.ts`));
    if (named === undefined) continue;
    const claimedWired = !named.includes('尚未接线');
    if (claimedWired !== wired(entry)) {
      problems.push(
        `口径把 scripts/${entry}.ts 写在「${claimedWired ? '已接线' : '尚未接线'}」那一条，调用图却是「${wired(entry) ? '已接线' : '尚未接线'}」`,
      );
    }
  }
  return problems;
}

test('接线口径由调用图判定：给得出可复核命令，点名了入口文件就必须与调用图一致', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const start = source.indexOf('## 接线状态');
  assert.ok(start >= 0, `${SOURCE_PATH} 必须有接线状态块（AGENTS §9.24）`);
  const block = source.slice(start, source.indexOf('*/', start));

  const wiredByCode = (entry: string): boolean => readFileSync(join(SCRIPTS_DIR, `${entry}.ts`), 'utf8').includes('createResidentRuntime');
  assert.deepEqual(wiringMismatches(block, wiredByCode), [], `${SOURCE_PATH} 的接线口径与调用图不一致`);

  // 反事实：同一段口径换两张调用图重算，必须一张判一致、一张判不一致 —— 否则这条检查是空的。
  const synthetic = [
    '## 接线状态（合成的口径，只用来做反事实）',
    ' * ```text',
    " * git grep -n 'createResidentRuntime(' -- scripts",
    " * git grep -n 'buildToolChain(' -- scripts",
    ' * ```',
    ' *  * **live 入口已经接线**：`scripts/chat.ts`、`scripts/serve-chat.ts`、`scripts/field-test.ts`、`scripts/voice-turn.ts`',
    ' *  * **提醒回路尚未接线**：…',
  ].join('\n');
  assert.deepEqual(wiringMismatches(synthetic, () => true), [], '四个入口都接了时它该判一致');
  assert.notDeepEqual(
    wiringMismatches(synthetic, (entry) => entry !== 'chat'),
    [],
    '把 chat 换成「没接」，该判出不一致（这条证明上面的判据不是恒真）',
  );
});

/**
 * 已知缺口登记（AGENTS §9.25⑤）：装配点里两条防线的坏输入**今天构造不出来**，所以它们的用例写不了，
 * 不许拿恒真的假用例充数。这里如实记下为什么不可达，以及什么时候要回来补：
 *
 *  * 「`start()` 抛过也拒绝重试」（`startCalled` 在 `await` 之前置位）：`start()` 在公开选项下没有可达的
 *    抛错路径 —— 插件层的 `loadAll` 逐插件捕获（`activate` 抛异常不算启动失败，实测 `start()` 正常返回、
 *    那个插件 `inactive`），`discover()` 连「源读不到」也只记账，`pluginDirectory` 指向非目录也不抛。
 *  * 「`stop()` 失败会被重试而不是缓存」（`stopPromise` 失败后重置）：同样不可达 —— `extraction.drain()`
 *    走 `TurnMemoryExtractor.flush()`（`allSettled`，永不 reject），`plugins.shutdown()` 走 `disposeAll()`
 *    （逐插件捕获），两个计数又都被 `countIfReadable` 包住。
 *
 * 上面那条「插件层失败不穿透装配点」的用例已经把可达的那一半钉住。**哪天这两条防线真的有了可达的坏输入**
 * （上面任一条被改掉，`npm test` 会先红在那条用例上），就必须回来把对应的坏输入用例补上。
 *
 * 与上面两条不同，**第三道终态门是可测的**：`stop()` 之后 `start()`（哪怕一次都没 `start()` 过）必须抛
 * `RESIDENT_RUNTIME_ALREADY_STOPPED` —— 就是上面那条 stop-before-start 用例；撤掉 `shutdown()` 里的终态
 * 标记或 `start()` 里那道守卫，它都会变红（反事实在仓外副本里跑过）。
 */
