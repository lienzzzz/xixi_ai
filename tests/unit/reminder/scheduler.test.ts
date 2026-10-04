/**
 * V0.3 P2-E — durable 提醒的调度侧验收（pack `docs/03_AGENT_PLUGIN.md` §7）。
 *
 * 这一组用例钉的是「到点真的形成提醒事件」这件事，以及五态**各有可观察的转移**：
 *
 *   * `markDue` 只按时钟走，**没到点不许提前**（反例有断言，否则那个守卫等于没有）；
 *   * `pending → due → candidate → delivered → acknowledged` 每一步都是表里的一行变化 +
 *     日志里的一条 `reminder.changed`，两者可以分别读到；
 *   * 重启之后（新进程、同一个库）待办仍在，到点仍然会响 —— 这正是 P2 之前那个内存 sink 做不到的；
 *   * 到点的候选可以**被主动路径读到**（`buildProactiveCandidates` 的 `remindersDue`）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DomainError, ReminderStore, openXixiStore, resolveReminderWhen, type XixiStore } from '@xixi/domain';
import { DurableReminderSink, ReminderScheduler, buildProactiveCandidates } from '@xixi/runtime';

const SPOKEN_AT = new Date('2026-09-30T23:40:00+08:00');
/** 「明天八点」一一对应到 10 月 1 日 08:00。 */
const DUE_AT = new Date('2026-10-01T08:00:00+08:00');
const SHANGHAI = 'Asia/Shanghai';

interface Rig {
  readonly root: string;
  readonly store: XixiStore;
  readonly scheduler: ReminderScheduler;
  readonly reminderId: string;
}

function open(dir: string, clock: () => Date): XixiStore {
  return openXixiStore({ dataDir: dir, clock });
}

/** 记一条提醒：「明天八点提醒我打电话」。 */
function schedule(store: XixiStore, when = '明天八点', at: Date = SPOKEN_AT) {
  const sink = new DurableReminderSink({ store, timezone: SHANGHAI, now: () => at });
  sink.beginTurn({ sessionId: 'sess_reminder', actorId: 'father', sourceEventId: 'evt_turn_1' });
  const scheduled = sink.schedule({ what: '给儿子打电话', when, recordedAt: at.toISOString() });
  return { sink, scheduled };
}

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), 'xixi-reminder-scheduler-'));
  const store = open(root, () => SPOKEN_AT);
  const { scheduled } = schedule(store);
  return { root, store, scheduler: new ReminderScheduler({ store }), reminderId: scheduled.id };
}

function statuses(store: XixiStore, reminderId: string): string[] {
  return new ReminderStore(store)
    .history(reminderId)
    .map((event) => (event.payload as { status: string }).status);
}

function expectCode(code: string, run: () => unknown): void {
  try {
    run();
    assert.fail(`expected DomainError(${code})`);
  } catch (error) {
    assert.ok(error instanceof DomainError, String(error));
    assert.equal(error.code, code);
  }
}

test('没到点不许提前：due_at 还在将来的提醒一条事件都不写', () => {
  const r = rig();
  try {
    const early = r.scheduler.markDue(new Date('2026-10-01T07:59:59+08:00'));
    assert.equal(early.becameDue.length, 0, '差一秒也是没到点');
    assert.equal(early.events.length, 0);
    assert.equal(new ReminderStore(r.store).get(r.reminderId)?.status, 'pending');
    assert.deepEqual(statuses(r.store, r.reminderId), ['pending'], '日志里只有创建那一条');

    // 反例的另一半：到了那一刻就必须动。
    const onTime = r.scheduler.markDue(DUE_AT);
    assert.deepEqual(onTime.becameDue.map((reminder) => reminder.id), [r.reminderId]);
    assert.deepEqual(statuses(r.store, r.reminderId), ['pending', 'due']);
  } finally {
    r.store.close();
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('五态各有可观察转移：到点写 due 事件、成为候选、说出口、被认下', () => {
  const r = rig();
  try {
    const tick = r.scheduler.tick(DUE_AT);
    assert.deepEqual(tick.becameDue.map((reminder) => reminder.id), [r.reminderId]);
    assert.deepEqual(tick.becameCandidate.map((reminder) => reminder.id), [r.reminderId]);
    assert.equal(tick.events.length, 2, '到点与成为候选各写一条事件');
    // 「到点」真的是日志里的一条事件，不是一行打印：类型与状态都能读回来。
    assert.deepEqual(
      r.store
        .readEvents({ type: 'reminder.changed', limit: 10 })
        .map((event) => (event.payload as { status: string }).status),
      ['pending', 'due', 'candidate'],
    );

    // 重复 tick 不重复提醒（同一条提醒只有五步）。
    const again = r.scheduler.tick(new Date('2026-10-01T09:00:00+08:00'));
    assert.equal(again.becameDue.length + again.becameCandidate.length, 0);
    assert.deepEqual(statuses(r.store, r.reminderId), ['pending', 'due', 'candidate']);

    // candidate → delivered → acknowledged：由「真的说了」与「真的被回应了」两头推动。
    assert.deepEqual(r.scheduler.waiting().map((reminder) => reminder.id), [r.reminderId]);
    const delivered = r.scheduler.deliver(r.reminderId, new Date('2026-10-01T08:00:05+08:00'));
    assert.equal(delivered.reminder.status, 'delivered');
    assert.equal(Date.parse(String(delivered.reminder.deliveredAt)), Date.parse('2026-10-01T08:00:05+08:00'));
    const acknowledged = r.scheduler.acknowledge(r.reminderId, new Date('2026-10-01T08:01:00+08:00'));
    assert.equal(acknowledged.reminder.status, 'acknowledged');
    assert.deepEqual(statuses(r.store, r.reminderId), ['pending', 'due', 'candidate', 'delivered', 'acknowledged']);
    assert.equal(r.scheduler.waiting().length, 0, '认下之后不再挂着');
  } finally {
    r.store.close();
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('状态机拦住跳步：没说出口就不许标 delivered，没到点就不许 candidate', () => {
  const r = rig();
  try {
    // 还没到点（due 都还不是），直接说 delivered 会被状态机拒。
    expectCode('INVALID_REMINDER', () => r.scheduler.deliver(r.reminderId, DUE_AT));
    expectCode('INVALID_REMINDER', () => r.scheduler.acknowledge(r.reminderId, DUE_AT));
    r.scheduler.markDue(DUE_AT);
    // due 之后仍然不能跳到 delivered：先成为候选。
    expectCode('INVALID_REMINDER', () => r.scheduler.deliver(r.reminderId, DUE_AT));
    assert.deepEqual(r.scheduler.dueButUnspoken().map((reminder) => reminder.id), [r.reminderId]);
    r.scheduler.takeCandidates(DUE_AT);
    expectCode('INVALID_REMINDER', () => r.scheduler.acknowledge(r.reminderId, DUE_AT));
    assert.equal(r.scheduler.deliver(r.reminderId, DUE_AT).reminder.status, 'delivered');
    expectCode('UNKNOWN_REMINDER', () => r.scheduler.deliver('rem_missing', DUE_AT));
  } finally {
    r.store.close();
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('重启后待办仍在，到点仍然形成事件（P2 之前的内存 sink 做不到）', () => {
  const root = mkdtempSync(join(tmpdir(), 'xixi-reminder-restart-'));
  const first = open(root, () => SPOKEN_AT);
  const { scheduled } = schedule(first);
  first.close();

  // 新进程、同一个库。
  const reopened = open(root, () => DUE_AT);
  try {
    const scheduler = new ReminderScheduler({ store: reopened });
    const reminder = scheduler.store.get(scheduled.id);
    assert.ok(reminder !== null, '重启后提醒还在');
    assert.equal(reminder.dueAt, '2026-10-01T08:00:00.000+08:00');

    const tick = scheduler.tick(DUE_AT);
    assert.deepEqual(tick.becameDue.map((row) => row.id), [scheduled.id]);
    assert.equal(tick.events.length, 2);
    const event = reopened.readEvents({ type: 'reminder.changed', limit: 10 }).at(-1);
    assert.equal((event?.payload as { status: string }).status, 'candidate');
    assert.equal((event?.payload as { what: string }).what, '给儿子打电话', '事件自带「要提醒什么」，读的人不用回表');
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('到点的提醒能作为主动候选被读到（不是只能靠人查表）', () => {
  const r = rig();
  try {
    r.scheduler.tick(DUE_AT);
    const plans = buildProactiveCandidates({
      now: new Date('2026-10-01T08:00:30+08:00'),
      presence: null,
      lastUserTurnAt: SPOKEN_AT,
      inConversation: false,
      remindersDue: r.scheduler.candidateInputs(new Date('2026-10-01T08:00:30+08:00')),
    });
    const reminderPlans = plans.filter((plan) => plan.candidate.intent === 'reminder_due');
    assert.equal(reminderPlans.length, 1, '到点的那一条必须成为候选');
    assert.equal(reminderPlans[0]?.candidate.trigger, 'future_hook_due');
    assert.equal(reminderPlans[0]?.candidate.topicRef, r.reminderId, 'topic_ref 是提醒 id：同一条提醒不会被说第二遍');
    assert.equal(reminderPlans[0]?.candidate.candidateId, `loop-future_hook_due-reminder-${r.reminderId}`);
    assert.match(String(reminderPlans[0]?.line), /给儿子打电话/);
    assert.match(String(reminderPlans[0]?.fact), /due_at 2026-10-01T08:00:00\.000\+08:00/);
    // 候选只在 candidate 状态时存在：说过之后它自己就消失了。
    r.scheduler.deliver(r.reminderId, DUE_AT);
    assert.equal(r.scheduler.candidateInputs(DUE_AT).length, 0);
  } finally {
    r.store.close();
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('多条提醒各自独立：一条到点不影响另一条的时刻', () => {
  const root = mkdtempSync(join(tmpdir(), 'xixi-reminder-multi-'));
  const store = open(root, () => SPOKEN_AT);
  try {
    const sink = new DurableReminderSink({ store, timezone: SHANGHAI, now: () => SPOKEN_AT });
    const soon = sink.schedule({ what: '吃药', when: '半小时后', recordedAt: SPOKEN_AT.toISOString() });
    const later = sink.schedule({ what: '给儿子打电话', when: '明天八点', recordedAt: SPOKEN_AT.toISOString() });
    assert.notEqual(soon.id, later.id);
    const scheduler = new ReminderScheduler({ store });
    const early = scheduler.tick(new Date('2026-10-01T00:10:00+08:00'));
    assert.deepEqual(early.becameDue.map((row) => row.what), ['吃药']);
    const all = scheduler.tick(DUE_AT);
    assert.deepEqual(all.becameDue.map((row) => row.what), ['给儿子打电话']);
    // 解析结果确实不同：一个来自时长，一个来自相对日。
    assert.equal(new ReminderStore(store).get(soon.id)?.resolveKind, 'duration');
    assert.equal(new ReminderStore(store).get(later.id)?.resolveKind, 'day_relative');
    assert.equal(scheduler.waiting().length, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('sink 回给工具的是解析后的绝对时刻，不是用户那句话', () => {
  const root = mkdtempSync(join(tmpdir(), 'xixi-reminder-sink-'));
  const store = open(root, () => SPOKEN_AT);
  try {
    const sink = new DurableReminderSink({ store, timezone: SHANGHAI });
    sink.beginTurn({ actorId: 'father', sessionId: 'sess_1', sourceEventId: 'evt_turn_1' });
    const scheduled = sink.schedule({ what: '打电话', when: '明天早上八点', recordedAt: SPOKEN_AT.toISOString() });
    assert.equal(scheduled.when, '2026-10-01T08:00:00.000+08:00');
    const row = new ReminderStore(store).get(scheduled.id);
    assert.equal(row?.owner, 'father', 'owner 来自这一轮的身份，不是模型编的');
    assert.equal(row?.sessionId, 'sess_1');
    assert.equal(row?.sourceEventId, 'evt_turn_1');
    // endTurn 之后就不再是那一轮的身份了（下一轮由入口重新 beginTurn）。
    sink.endTurn();
    const next = sink.schedule({ what: '喝水', when: '十分钟后', recordedAt: SPOKEN_AT.toISOString() });
    assert.equal(new ReminderStore(store).get(next.id)?.owner, 'unknown', '认不出来就写 unknown，不编造一个人');
    assert.equal(new ReminderStore(store).get(next.id)?.sessionId, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reminders 设置真的接进了解析（default_time 改的是落点）', () => {
  const root = mkdtempSync(join(tmpdir(), 'xixi-reminder-settings-'));
  const store = open(root, () => SPOKEN_AT);
  try {
    const sink = new DurableReminderSink({
      store,
      timezone: SHANGHAI,
      settings: { timezone: null, defaultTime: { hour: 7, minute: 30 }, asapMinutes: 5 },
    });
    const onlyDay = sink.schedule({ what: '买菜', when: '明天', recordedAt: SPOKEN_AT.toISOString() });
    assert.equal(new ReminderStore(store).get(onlyDay.id)?.dueAt, '2026-10-01T07:30:00.000+08:00');
    const asap = sink.schedule({ what: '拿快递', when: '尽快', recordedAt: SPOKEN_AT.toISOString() });
    assert.equal(new ReminderStore(store).get(asap.id)?.dueAt, '2026-09-30T23:45:00.000+08:00');
    assert.equal(new ReminderStore(store).get(asap.id)?.resolveKind, 'asap');
    // 解析与落点一致：`resolveReminderWhen` 是唯一的那把尺子。
    assert.equal(
      resolveReminderWhen('明天', { now: SPOKEN_AT, timezone: SHANGHAI, defaultTime: { hour: 7, minute: 30 } }).dueAt,
      '2026-10-01T07:30:00.000+08:00',
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
