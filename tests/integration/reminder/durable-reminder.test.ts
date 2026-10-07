/**
 * V0.3 P2-E / P2.5-F — Phase 2 验收场景 2 的端到端证据：「明天八点提醒我打电话。」
 *
 * 这条用例把 P2 之前的现状当作反例来钉：那时候提醒工具把自然语言的 `when` 原样丢进进程内数组，
 * **进程一结束就没了，到点也不会响**（工具自己都写着「到点不会自动响」）。今天这条链是：
 *
 *   一轮对话（真实引擎 + 真实工具链 + **常驻装配点**）
 *     → 工具把「明天八点」**解析成绝对时刻 + 时区**写进 `reminders` 表（不是原样存）
 *     → 进程结束、重新打开同一个库：待办仍在
 *     → 到点：`reminder.changed`（status=due）**写进事件日志**（不是打印一行）
 *     → 装配点交出的**提醒接缝**把候选喂给主动循环 → 真的说出口（delivered）→ 被认下（acknowledged）
 *
 * V0.3 P2.5-F 起，这条链的每一段都取自 `createResidentRuntime`（控制台/CLI 用的同一个工厂）：
 * 链是 `runtime.toolChain`、sink 是 `runtime.reminderSink`、调度器是 `runtime.reminders`、
 * 喂给循环的两条接缝是 `runtime.reminderSeams`。测试不再自己拼 sink / 链 / 调度器 ——
 * 「代码里已经有 durable 提醒」与「活的装配点把它交给了主动路径」是两件事，这里钉的是后者。
 *
 * 每一步的证据都是「从库里/日志里读回来的东西」，不是内存里的变量。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { validateEvent } from '@xixi/contracts';
import { parseProactiveSettings } from '@xixi/conversation';
import { ReminderStore, openXixiStore, parseXixiConfig, type XixiStore } from '@xixi/domain';
import { DurableReminderSink, ProactiveLoop, createResidentRuntime, type XixiResidentRuntime } from '@xixi/runtime';

const SPOKEN_AT = new Date('2026-09-30T23:40:00+08:00');
const DUE_AT = new Date('2026-10-01T08:00:00+08:00');
const SHANGHAI = 'Asia/Shanghai';
const TOOL = 'xixi_set_reminder';
const UTTERANCE = '明天八点提醒我打电话。';

const CONFIG_YAML = `
xixi:
  identity:
    name: 西西
    language: zh-CN
    timezone: Asia/Shanghai
    place: 城东
  models:
    llm: { provider: mimo, model: mimo-v2.6-flash, thinking_realtime: false }
    asr: { provider: x, model: y }
    tts: { provider: x, model: y }
  personality:
    base: {}
  proactive:
    enabled: true
    base_cooldown_min: 0
    max_per_6h: 10
    max_per_day: 10
    quiet_hours: { start: '23:30', end: '07:30' }
  memory: {}
  privacy: {}
  features: {}
`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'xixi-reminder-e2e-'));
}

function config() {
  return parseXixiConfig(CONFIG_YAML, 'test-inline.yaml');
}

/**
 * 一个「真实入口」的装配：控制台、试用页与四个 CLI 调的就是这一个工厂。
 *
 * 时钟必须由入口给同一个（接缝 `readDueReminders()` 没有参数，读的是装配点自己的 `now`），所以这里
 * 把 `clock` 同时给运行时与下面那个循环 —— 两个不同的时钟会让「到点」与「取候选」各看一个时刻。
 */
function entryRuntime(store: XixiStore, clock: () => Date): XixiResidentRuntime {
  return createResidentRuntime({
    config: config(),
    store,
    now: clock,
    model: ({ toolChain }) =>
      new FakeBrainAdapter({
        registry: toolChain,
        scope: 'conversation',
        now: clock,
        timezone: SHANGHAI,
        // 一个真实模型会从这句话里抽出 what 与 when 两个参数。
        toolPlan: (_input, round) => (round === 1 ? [{ name: TOOL, arguments: { what: '给儿子打电话', when: '明天八点' } }] : []),
      }),
  });
}

/** 一轮对话：常驻装配点的链 + 它的 durable sink + 它的引擎。 */
async function speakTheReminder(store: XixiStore): Promise<{ readonly runtime: XixiResidentRuntime; readonly reminderId: string; readonly sessionId: string; readonly turnText: string | null }> {
  const runtime = entryRuntime(store, () => SPOKEN_AT);
  await runtime.start();
  const session = store.createSession();
  // 入口在动手之前绑定这一轮的身份（与它填 ToolExecutionContext 的是同一组值）。
  runtime.reminderSink.beginTurn({ sessionId: session.sessionId, actorId: 'father', sourceEventId: 'evt_turn_1' });
  const turn = await runtime.conversation.respond({ sessionId: session.sessionId, text: UTTERANCE, addressed: true, at: SPOKEN_AT });
  runtime.reminderSink.endTurn();
  const [reminder] = new ReminderStore(store).list();
  assert.ok(reminder !== undefined, '这一轮必须留下一条 durable 提醒');
  return { runtime, reminderId: reminder.id, sessionId: session.sessionId, turnText: turn.text };
}

/** 主动循环的装配：除了提醒接缝取自装配点，其余与入口同样的输入。 */
function loopOver(runtime: XixiResidentRuntime, options: { readonly clock: () => Date; readonly sessionId: string; readonly proactivity: number }): ProactiveLoop {
  return new ProactiveLoop({
    store: runtime.store,
    readSettings: () => parseProactiveSettings(config().proactive),
    readState: () => 'IDLE',
    readInFlightTurn: () => false,
    readProactivity: () => options.proactivity,
    // 没有在场投影：这一轮唯一该说的话就是那条提醒（不然交付会被记到「有人到家」头上）。
    readPresence: async () => null,
    readLastUserTurnAt: () => SPOKEN_AT,
    readSessionId: () => options.sessionId,
    // ← 本任务交付的就是这一行：不是测试自己写的闭包，而是装配点的两条接缝。
    ...runtime.reminderSeams,
    now: options.clock,
    log: () => {},
  });
}

async function tickUntilSpoken(loop: ProactiveLoop): Promise<{ readonly text: string; readonly trigger: string; readonly initiativeKind: string } | null> {
  for (let tick = 0; tick < 30; tick += 1) {
    const entry = await loop.tickOnce();
    if (entry !== null && entry.reasonCode === 'PASSED') {
      return { text: String(entry.text ?? ''), trigger: entry.trigger, initiativeKind: entry.initiativeKind };
    }
  }
  return null;
}

test('验收场景 2：写进 durable 表 → 重启后仍在 → 到点成为候选（读取走装配点的接缝）', async () => {
  const root = tempDir();
  let reminderId = '';

  const first = openXixiStore({ dataDir: root, clock: () => SPOKEN_AT });
  try {
    const spoken = await speakTheReminder(first);
    reminderId = spoken.reminderId;
    // 链上的提醒工具写的是这个 runtime 的 durable sink（不是内存 sink）。
    assert.ok(spoken.runtime.reminderSink instanceof DurableReminderSink, '入口路径上的 sink 必须是 durable 的那个');
    const row = new ReminderStore(first).get(reminderId);
    assert.ok(row !== null);
    // 存的是解析后的绝对时刻 + 时区，不是「明天八点」。
    assert.equal(row.dueAt, '2026-10-01T08:00:00.000+08:00');
    assert.equal(row.timezone, SHANGHAI);
    assert.equal(row.what, '给儿子打电话');
    assert.equal(row.owner, 'father');
    assert.equal(row.sourceEventId, 'evt_turn_1');
    // 到点之前：只有创建那一条事件，没有任何「响了」的假动作。
    assert.deepEqual(
      new ReminderStore(first).history(reminderId).map((event) => (event.payload as { status: string }).status),
      ['pending'],
    );
    // 读接缝在没到点时什么都不给（它不是「有机会就提前报」）。
    assert.deepEqual(spoken.runtime.reminderSeams.readDueReminders(), []);
    await spoken.runtime.stop();
  } finally {
    first.close();
  }

  // ---- 重启：新进程、同一个库、**新的常驻装配点**（铁律 3） ----
  const reopened = openXixiStore({ dataDir: root, clock: () => DUE_AT });
  try {
    // 新进程的入口只做两件事：开库、装配。待办是它读回来的，不是谁在内存里传过来的。
    let nowAt = new Date('2026-10-01T07:59:59+08:00');
    const runtime = entryRuntime(reopened, () => nowAt);
    await runtime.start();
    try {
      const reminders = new ReminderStore(reopened);
      assert.ok(reminders.get(reminderId) !== null, '重启后待办仍在');

      // 差一秒不算到点：读接缝跑完**整个时钟 pass** 也不许提前动它。
      assert.deepEqual(runtime.reminderSeams.readDueReminders(), [], '没到点时读接缝不给候选');
      assert.equal(reminders.get(reminderId)?.status, 'pending', '没到点不许被写成 due');

      // 到点：**读接缝自己**跑「先跑到点、再取候选」—— 不需要谁在旁边补一次 tick（少了 markDue 那一半
      // 的话，这条提醒会永远停在 pending，循环连看都看不到它）。
      nowAt = DUE_AT;
      const offered = runtime.reminderSeams.readDueReminders();
      assert.deepEqual(offered.map((input) => input.reminderId), [reminderId], '到点就该被读接缝交出来');
      assert.equal(offered[0]?.line, '该提醒你了：给儿子打电话');
      assert.match(String(offered[0]?.fact), /due_at 2026-10-01T08:00:00.000\+08:00/);

      // 「到点」是日志里的事实：从库里读回来，逐条过权威校验器（三处同改）。
      const history = reminders.history(reminderId);
      assert.deepEqual(
        history.map((event) => (event.payload as { status: string }).status),
        ['pending', 'due', 'candidate'],
      );
      for (const event of history) {
        const { sequence, ...envelope } = event;
        assert.ok(sequence > 0);
        const validated = validateEvent(JSON.parse(JSON.stringify(envelope)));
        assert.equal(validated.event_type, 'reminder.changed');
        const payload = validated.payload as Record<string, unknown>;
        assert.equal(payload['reminder_id'], reminderId);
        // 事件自带「要提醒什么」与绝对时刻：主动行为与对话都读得到（不必回表）。
        assert.equal(payload['what'], '给儿子打电话');
        assert.equal(payload['due_at'], '2026-10-01T08:00:00.000+08:00');
        assert.equal(payload['timezone'], SHANGHAI);
      }
      assert.equal((history[1]?.payload as { reason_code: string }).reason_code, 'reminder_due');

      // 走到这里，提醒已经可以被说出口了：装配点的读接缝给出的正是它（与循环拿到的同一个来源）。
      assert.deepEqual(runtime.reminders.waiting().map((row) => row.id), [reminderId]);
      // 再读一次仍然是它（candidate 会被反复提议，直到真的说出口或过期 —— 不是只报一次就丢）。
      assert.deepEqual(runtime.reminderSeams.readDueReminders().map((input) => input.reminderId), [reminderId]);
    } finally {
      await runtime.stop();
    }
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('候选跨重启仍在，并由主动路径真的说出口：candidate → delivered → acknowledged 都有事件', async () => {
  const root = tempDir();
  let reminderId = '';
  let sessionId = '';

  // 进程 A：写下提醒。
  const first = openXixiStore({ dataDir: root, clock: () => SPOKEN_AT });
  try {
    const spoken = await speakTheReminder(first);
    reminderId = spoken.reminderId;
    sessionId = spoken.sessionId;
    await spoken.runtime.stop();
  } finally {
    first.close();
  }

  // 进程 B：到点了，装配点的读接缝把候选交出来 —— 但它现在还是**没说出口**的状态。
  const second = openXixiStore({ dataDir: root, clock: () => DUE_AT });
  try {
    const runtime = entryRuntime(second, () => DUE_AT);
    await runtime.start();
    try {
      const offered = runtime.reminderSeams.readDueReminders();
      assert.deepEqual(offered.map((input) => input.reminderId), [reminderId], '到点后读接缝必须交出它');
      assert.equal(new ReminderStore(second).get(reminderId)?.status, 'candidate');
      assert.equal(new ReminderStore(second).get(reminderId)?.deliveredAt, null, '还没说出口');
    } finally {
      await runtime.stop();
    }
  } finally {
    second.close();
  }

  // 进程 C：新装配点、新循环 —— 候选经**接缝**喂进主动路径，真的说出口，才落 delivered。
  const third = openXixiStore({ dataDir: root, clock: () => DUE_AT });
  try {
    const runtime = entryRuntime(third, () => DUE_AT);
    await runtime.start();
    try {
      const loop = loopOver(runtime, { clock: () => DUE_AT, sessionId, proactivity: 0.85 });
      const delivered = await tickUntilSpoken(loop);
      assert.notEqual(delivered, null, '到点的提醒必须被说出口（而不是悄悄丢掉）');
      const outcome = delivered as { readonly text: string; readonly trigger: string; readonly initiativeKind: string };
      assert.equal(outcome.initiativeKind, 'open_loop_followup', '这是「接着用户交代的事」，不是泛泛搭话');
      assert.equal(outcome.trigger, 'future_hook_due');
      assert.match(outcome.text, /给儿子打电话/, `说出口的内容要提这件事：${outcome.text}`);

      // 说出口这件事落了库：candidate → delivered，时刻就是这一轮的时刻。
      const rows = new ReminderStore(third).list();
      assert.equal(rows[0]?.status, 'delivered');
      assert.equal(Date.parse(String(rows[0]?.deliveredAt)), DUE_AT.getTime());

      // 用户应了一声：delivered → acknowledged（终态）。
      runtime.reminders.acknowledge(reminderId, new Date('2026-10-01T08:01:00+08:00'));
      assert.equal(new ReminderStore(third).get(reminderId)?.status, 'acknowledged');
      assert.deepEqual(
        new ReminderStore(third)
          .history(reminderId)
          .map((event) => (event.payload as { status: string }).status),
        ['pending', 'due', 'candidate', 'delivered', 'acknowledged'],
        '五态在日志里一步不缺，顺序就是 pack §7 的那条链',
      );

      // 说出口的那句话也进了对话日志：下一轮读得到（主动说的话不能对对话不可见）。
      assert.ok(
        third.readEvents({ type: 'conversation.turn', limit: 50 }).some((event) => String((event.payload as { text?: string }).text ?? '').includes('给儿子打电话')),
        '主动说出口的提醒必须在对话日志里留下痕迹',
      );
    } finally {
      await runtime.stop();
    }
  } finally {
    third.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('反例：一句话都没说时，提醒不许被提前标成已送达（停在 candidate，没有 delivered 事件）', async () => {
  const root = tempDir();
  const store = openXixiStore({ dataDir: root, clock: () => SPOKEN_AT });
  try {
    const spoken = await speakTheReminder(store);
    await spoken.runtime.stop();

    const runtime = entryRuntime(store, () => DUE_AT);
    await runtime.start();
    try {
      // 记下循环**确实看见过**这条候选：否则「没变 delivered」可能只是因为它压根没被读。
      //
      // 这条反例钉的是**记账的位置**：把 `onReminderDelivered` 从「决定了要说、内容也生成了」挪到
      // 「考虑过这条候选」（`proactive-runtime.ts` 里那一行的条件），它就会变红 —— 仓外副本里实测过。
      // 反过来，那一行里 `delivered !== null` 这一半今天无法单独证伪（内容生成必然伴随 speak），
      // 所以这条用例不作那个声明。
      const offered: string[] = [];
      const seams = {
        readDueReminders: () => {
          const inputs = runtime.reminderSeams.readDueReminders();
          offered.push(...inputs.map((input) => input.reminderId));
          return inputs;
        },
        onReminderDelivered: runtime.reminderSeams.onReminderDelivered,
      };
      const loop = new ProactiveLoop({
        store,
        // 硬底线（铁律 3）：把静默时段调到盖住 08:00 —— 到点了也不许开口，而且不许被记成「已经说过」。
        readSettings: () => parseProactiveSettings({ ...config().proactive, quiet_hours: { start: '07:00', end: '09:00' } }),
        readState: () => 'IDLE',
        readInFlightTurn: () => false,
        readProactivity: () => 0.85,
        readPresence: async () => null,
        readLastUserTurnAt: () => SPOKEN_AT,
        readSessionId: () => spoken.sessionId,
        ...seams,
        now: () => DUE_AT,
        log: () => {},
      });

      const entries = [];
      for (let tick = 0; tick < 5; tick += 1) entries.push(await loop.tickOnce());

      assert.ok(offered.includes(spoken.reminderId), `循环必须看见过这条候选（否则这条反例是空的）：${offered.join('、') || '一次都没读到'}`);
      assert.ok(entries.every((entry) => entry === null || entry.speak === false), '这一轮不该有任何开口');

      const row = new ReminderStore(store).get(spoken.reminderId);
      assert.equal(row?.status, 'candidate', '没说话就只许停在 candidate');
      assert.equal(row?.deliveredAt, null, 'delivered_at 不许被提前写上');
      assert.deepEqual(
        new ReminderStore(store)
          .history(spoken.reminderId)
          .map((event) => (event.payload as { status: string }).status),
        ['pending', 'due', 'candidate'],
        '没说话时状态一步都不许前进',
      );
      assert.ok(
        !new ReminderStore(store)
          .history(spoken.reminderId)
          .some((event) => (event.payload as { reason_code?: string }).reason_code === 'reminder_delivered'),
        '日志里不该出现「已送达」这条原因码',
      );
    } finally {
      await runtime.stop();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
