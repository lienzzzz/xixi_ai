/**
 * V0.3 P2-E — Phase 2 验收场景 2 的端到端证据：「明天八点提醒我打电话。」
 *
 * 这条用例把 P2 之前的现状当作反例来钉：那时候 `xixi_set_reminder_stub` 把自然语言的 `when` 原样丢进
 * 进程内数组，**进程一结束就没了，到点也不会响**（工具自己都写着「到点不会自动响」）。今天这条链是：
 *
 *   一轮对话（真实 agent loop + 真实工具链）
 *     → 工具把「明天八点」**解析成绝对时刻 + 时区**写进 `reminders` 表（不是原样存）
 *     → 进程结束、重新打开同一个库：待办仍在
 *     → 到点：`reminder.changed`（status=due）**写进事件日志**（不是打印一行）
 *     → 主动路径读到它 → 真的说出口（delivered）→ 被认下（acknowledged）
 *
 * 每一步的证据都是「从库里/日志里读回来的东西」，不是内存里的变量。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeBrainAdapter, collectTurn } from '@xixi/brain-adapter';
import { validateEvent } from '@xixi/contracts';
import { parseProactiveSettings } from '@xixi/conversation';
import { ReminderStore, openXixiStore, parseXixiConfig, type XixiStore } from '@xixi/domain';
import { DurableReminderSink, ProactiveLoop, ReminderScheduler, buildToolChain } from '@xixi/runtime';

const SPOKEN_AT = new Date('2026-09-30T23:40:00+08:00');
const DUE_AT = new Date('2026-10-01T08:00:00+08:00');
const SHANGHAI = 'Asia/Shanghai';
const TOOL = 'xixi_set_reminder_stub';
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

/** 一轮对话：假的模型（脚本化的 tool plan）+ 真的工具链 + 真的 durable sink。 */
async function speakTheReminder(store: XixiStore): Promise<{ readonly reminderId: string; readonly sessionId: string; readonly turnText: string | null }> {
  const config = parseXixiConfig(CONFIG_YAML, 'test-inline.yaml');
  const sink = new DurableReminderSink({ store, timezone: SHANGHAI });
  const registry = buildToolChain(config, { reminderSink: sink, now: () => SPOKEN_AT, role: 'resident' });
  const session = store.createSession();
  // 入口在动手之前绑定这一轮的身份（与它填 ToolExecutionContext 的是同一组值）。
  sink.beginTurn({ sessionId: session.sessionId, actorId: 'father', sourceEventId: 'evt_turn_1' });
  const adapter = new FakeBrainAdapter({
    registry,
    scope: 'conversation',
    now: () => SPOKEN_AT,
    timezone: SHANGHAI,
    // 一个真实模型会从这句话里抽出 what 与 when 两个参数。
    toolPlan: (_input, round) => (round === 1 ? [{ name: TOOL, arguments: { what: '给儿子打电话', when: '明天八点' } }] : []),
  });
  const turn = await collectTurn(await adapter.handleUserTurn({ sessionId: session.sessionId, text: UTTERANCE, actorId: 'father' }));
  sink.endTurn();
  const [reminder] = new ReminderStore(store).list();
  assert.ok(reminder !== undefined, '这一轮必须留下一条 durable 提醒');
  return { reminderId: reminder.id, sessionId: session.sessionId, turnText: turn.result.text };
}

test('验收场景 2：写进 durable 表 → 重启后仍在 → 到点真的形成提醒事件', async () => {
  const root = tempDir();
  const first: XixiStore = openXixiStore({ dataDir: root, clock: () => SPOKEN_AT });
  let reminderId = '';
  try {
    const spoken = await speakTheReminder(first);
    reminderId = spoken.reminderId;
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
  } finally {
    first.close();
  }

  // ---- 重启：新进程、同一个库（铁律 3） ----
  const reopened = openXixiStore({ dataDir: root, clock: () => DUE_AT });
  try {
    const reminders = new ReminderStore(reopened);
    assert.ok(reminders.get(reminderId) !== null, '重启后待办仍在');
    const scheduler = new ReminderScheduler({ store: reopened });

    // 差一秒不算到点。
    scheduler.markDue(new Date('2026-10-01T07:59:59+08:00'));
    assert.equal(reminders.get(reminderId)?.status, 'pending');

    const tick = scheduler.tick(DUE_AT);
    assert.deepEqual(tick.becameDue.map((row) => row.id), [reminderId], '到点就动');
    assert.equal(tick.events.length, 2, '到点与成为候选各写一条事件');

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

    // 走到这里，提醒已经可以被说出口了：主动路径拿到的正是它。
    const waiting = scheduler.waiting();
    assert.deepEqual(waiting.map((row) => row.id), [reminderId]);
  } finally {
    reopened.close();
  }
});

test('到点的提醒由主动路径真的说出口：candidate → delivered → acknowledged 都有事件', async () => {
  const root = tempDir();
  const store = openXixiStore({ dataDir: root, clock: () => SPOKEN_AT });
  try {
    const spoken = await speakTheReminder(store);
    const scheduler = new ReminderScheduler({ store });
    // 到点：这一步与「说出口」是分开的 —— 先说有没有到点，再说要不要开口。
    scheduler.tick(DUE_AT);

    const loop = new ProactiveLoop({
      store,
      readSettings: () => parseProactiveSettings(parseXixiConfig(CONFIG_YAML, 'test-inline.yaml').proactive),
      readState: () => 'IDLE',
      readInFlightTurn: () => false,
      readProactivity: () => 0.85,
      // 没有在场投影：这一轮唯一该说的话就是那条提醒（不然交付会被记到「有人到家」头上）。
      readPresence: async () => null,
      readLastUserTurnAt: () => SPOKEN_AT,
      readSessionId: () => spoken.sessionId,
      readDueReminders: () => scheduler.candidateInputs(DUE_AT),
      onReminderDelivered: (reminderId, at) => {
        scheduler.deliver(reminderId, at);
      },
      now: () => DUE_AT,
      log: () => {},
    });

    let delivered: { text: string | null; trigger: string; initiativeKind: string } | null = null;
    for (let tick = 0; tick < 30 && delivered === null; tick += 1) {
      const entry = await loop.tickOnce();
      if (entry !== null && entry.reasonCode === 'PASSED') delivered = { text: entry.text, trigger: entry.trigger, initiativeKind: entry.initiativeKind };
    }
    assert.notEqual(delivered, null, '到点的提醒必须被说出口（而不是悄悄丢掉）');
    const outcome = delivered as unknown as { text: string; trigger: string; initiativeKind: string };
    assert.equal(outcome.initiativeKind, 'open_loop_followup', '这是「接着用户交代的事」，不是泛泛搭话');
    assert.equal(outcome.trigger, 'future_hook_due');
    assert.match(outcome.text, /给儿子打电话/, `说出口的内容要提这件事：${outcome.text}`);

    // 说出口这件事落了库：candidate → delivered。
    const rows = new ReminderStore(store).list();
    assert.equal(rows[0]?.status, 'delivered');
    assert.equal(Date.parse(String(rows[0]?.deliveredAt)), DUE_AT.getTime());

    // 用户应了一声：delivered → acknowledged（终态）。
    scheduler.acknowledge(spoken.reminderId, new Date('2026-10-01T08:01:00+08:00'));
    const final = new ReminderStore(store).get(spoken.reminderId);
    assert.equal(final?.status, 'acknowledged');
    assert.deepEqual(
      new ReminderStore(store)
        .history(spoken.reminderId)
        .map((event) => (event.payload as { status: string }).status),
      ['pending', 'due', 'candidate', 'delivered', 'acknowledged'],
      '五态在日志里一步不缺，顺序就是 pack §7 的那条链',
    );

    // 说出口的那句话也进了对话日志：下一轮读得到（主动说的话不能对对话不可见）。
    assert.ok(
      store.readEvents({ type: 'conversation.turn', limit: 50 }).some((event) => String((event.payload as { text?: string }).text ?? '').includes('给儿子打电话')),
      '主动说出口的提醒必须在对话日志里留下痕迹',
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
