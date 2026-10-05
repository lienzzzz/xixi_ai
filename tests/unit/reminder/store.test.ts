/**
 * V0.3 P2-E — `reminders` 表与五态状态机的领域侧验收（pack `docs/03_AGENT_PLUGIN.md` §7）。
 *
 * 要钉住的是四件事：
 *
 *   1. **pack §7 的八个字段**逐个落地（id/owner/what/due_at/timezone/status/created_at/source_event_id），
 *      并且**重启后读得回来**——「记着」必须是长期的，不是进程内数组；
 *   2. **纯新增迁移**：`008_reminders.sql` 是清单里最新的那一个，表的列就是那八个 + 程序事实；
 *   3. **状态机**：`pending → due → candidate → delivered → acknowledged`，非法转移被拒，同状态幂等；
 *   4. **不存自然语言 when**：整行里找不到用户说的那句话（表结构里根本没有能放它的列）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateEvent } from '@xixi/contracts';
import {
  DomainError,
  ReminderStore,
  listMigrationFiles,
  openXixiStore,
  resolveReminderWhen,
  type ReminderStatus,
  type XixiStore,
} from '@xixi/domain';

const NOW = new Date('2026-09-30T23:40:00+08:00');
const SHANGHAI = 'Asia/Shanghai';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'xixi-reminder-'));
}

function openStore(dir: string, at: Date = NOW): XixiStore {
  return openXixiStore({ dataDir: dir, clock: () => at });
}

/** The acceptance sentence, as the tool would hand it over: 「明天八点提醒我打电话。」 */
const WHEN = '明天八点';
const WHAT = '给儿子打电话';

function createOne(store: XixiStore, extra: { readonly what?: string; readonly when?: string } = {}) {
  const resolution = resolveReminderWhen(extra.when ?? WHEN, { now: NOW, timezone: SHANGHAI });
  const change = new ReminderStore(store).create({
    what: extra.what ?? WHAT,
    owner: 'father',
    dueAt: resolution.dueAt,
    timezone: SHANGHAI,
    createdAt: NOW.toISOString(),
    sourceEventId: 'evt_turn_1',
    sessionId: 'sess_1',
    resolveKind: resolution.kind,
  });
  return { resolution, change };
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

test('008_reminders 是独立的已发布迁移：表的列就是 pack §7 的八个字段加程序事实', () => {
  const files = listMigrationFiles();
  const index = files.findIndex((file) => file.name === '008_reminders.sql');
  assert.ok(index >= 0, '已发布提醒迁移仍在清单中');
  assert.equal(files[index - 1]?.name, '007_tool_approvals.sql', '已发布迁移的次序不变');

  const dir = tempDir();
  const store = openStore(dir);
  try {
    assert.deepEqual(
      store.appliedMigrations.map((migration) => migration.name),
      files.map((file) => file.name),
      '空库打开会把清单里的每个迁移都跑一遍（008 也在其中，且旧文件一字未改）',
    );
    const db = new DatabaseSync(store.dbPath);
    const columns = (db.prepare('PRAGMA table_info(reminders)').all() as unknown as { name: string }[]).map((row) => row.name);
    db.close();
    // pack §7 的八个字段，逐个对应（列名是下划线写法，语义一一对应）。
    for (const column of ['id', 'owner', 'what', 'due_at', 'timezone', 'status', 'created_at', 'source_event_id']) {
      assert.ok(columns.includes(column), `缺少 pack §7 的字段：${column}（现有列 ${columns.join(',')}）`);
    }
    // schema_version 是铁律 10 要求的；其余是调度与恢复的程序事实。
    assert.deepEqual(
      [...columns].sort(),
      [
        'acknowledged_at',
        'created_at',
        'delivered_at',
        'due_at',
        'due_at_ms',
        'id',
        'owner',
        'resolve_kind',
        'schema_version',
        'session_id',
        'source_event_id',
        'status',
        'status_changed_at',
        'timezone',
        'what',
      ],
      '列集合就是设计里那一份：八个 pack 字段 + 七列程序事实',
    );
    // 没有任何一列能装下自然语言 when —— 这是结构上的保证，不是纪律。
    for (const forbidden of ['when', 'when_text', 'raw_when', 'text']) {
      assert.ok(!columns.includes(forbidden), `表里不该有能放自然语言 when 的列：${forbidden}`);
    }
  } finally {
    store.close();
  }
});

test('八个字段齐备、due_at 是绝对时刻，重启后读得回来', () => {
  const dir = tempDir();
  const first = openStore(dir);
  const { resolution, change } = createOne(first);
  const id = change.reminder.id;
  assert.match(id, /^rem_[0-9a-f-]{36}$/, 'id 的形状由 payload schema 的 pattern 钉住');
  first.close();

  // 重启：新进程、同一个库（铁律 3）。
  const reopened = openStore(dir);
  try {
    const reminder = new ReminderStore(reopened).get(id);
    assert.ok(reminder !== null, '重启后待办仍在');
    assert.equal(reminder.id, id);
    assert.equal(reminder.owner, 'father');
    assert.equal(reminder.what, WHAT);
    assert.equal(reminder.dueAt, '2026-10-01T08:00:00.000+08:00');
    assert.equal(reminder.timezone, SHANGHAI);
    assert.equal(reminder.status, 'pending');
    // 时间戳按本机偏移渲染（仓库约定：绝不用 `Z`），但必须是同一个瞬间。
    assert.match(reminder.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    assert.equal(Date.parse(reminder.createdAt), NOW.getTime());
    assert.equal(reminder.sourceEventId, 'evt_turn_1');
    // 附加的程序事实（不在 pack 的八个字段里，但恢复要用）。
    assert.equal(reminder.resolveKind, resolution.kind);
    assert.equal(reminder.sessionId, 'sess_1');
    assert.equal(reminder.statusChangedAt, null);
    assert.equal(reminder.deliveredAt, null);
    assert.equal(reminder.acknowledgedAt, null);

    // 创建本身也是一条事件：pending 不是「什么都没发生」。
    const history = new ReminderStore(reopened).history(id);
    assert.deepEqual(
      history.map((event) => (event.payload as { status: string }).status),
      ['pending'],
    );
  } finally {
    reopened.close();
  }
});

test('整行里找不到用户说的那句自然语言（只存解析后的绝对时刻 + 时区）', () => {
  const dir = tempDir();
  const store = openStore(dir);
  try {
    const { change } = createOne(store, { when: '明天早上八点', what: '吃药' });
    const db = new DatabaseSync(store.dbPath);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(change.reminder.id) as unknown as Record<string, unknown>;
    db.close();
    const flat = JSON.stringify(row);
    assert.ok(!flat.includes('明天'), `due_at 不该是原样的「明天」：${flat}`);
    assert.ok(!flat.includes('早上'), `due_at 不该是原样的「早上八点」：${flat}`);
    assert.ok(!flat.includes('吃完'), 'what 是用户要提醒的事，不是 when 的备份');
    assert.equal(row['due_at'], '2026-10-01T08:00:00.000+08:00');
    assert.equal(row['timezone'], SHANGHAI);
    assert.equal(row['resolve_kind'], 'day_relative');
  } finally {
    store.close();
  }
});

test('五态状态机：非法转移被拒、同状态幂等，每一次转移都写一条事件', () => {
  const dir = tempDir();
  const store = openStore(dir);
  try {
    const reminders = new ReminderStore(store);
    const { change } = createOne(store);
    const id = change.reminder.id;

    // 不能跳过状态：pending 只能到 due。
    expectCode('INVALID_REMINDER', () => reminders.transition(id, 'candidate'));
    expectCode('INVALID_REMINDER', () => reminders.transition(id, 'delivered'));
    expectCode('INVALID_REMINDER', () => reminders.transition(id, 'acknowledged'));
    expectCode('UNKNOWN_REMINDER', () => reminders.transition('rem_missing', 'due'));

    const statuses: ReminderStatus[] = ['due', 'candidate', 'delivered', 'acknowledged'];
    for (const status of statuses) {
      const stepped = reminders.transition(id, status, { at: NOW });
      assert.equal(stepped.reminder.status, status);
      assert.ok(stepped.event !== null, `${status} 必须写事件`);
      // 幂等：同一个状态再迁一次，不写第二条事件。
      const again = reminders.transition(id, status, { at: NOW });
      assert.equal(again.event, null, `${status} 重复迁移不该再写事件`);
      assert.equal(again.reminder.status, status);
    }

    // 终态不回退。
    expectCode('INVALID_REMINDER', () => reminders.transition(id, 'pending'));
    expectCode('INVALID_REMINDER', () => reminders.transition(id, 'delivered'));

    const final = reminders.get(id);
    assert.equal(final?.status, 'acknowledged');
    assert.equal(Date.parse(String(final?.deliveredAt)), NOW.getTime(), 'delivered_at 是这一步发生的时刻');
    assert.equal(final?.acknowledgedAt, final?.deliveredAt);

    // 事件序列：创建 + 四步 = 五条，每条都自带原因码与状态。
    const history = reminders.history(id);
    assert.deepEqual(
      history.map((event) => [(event.payload as { status: string }).status, (event.payload as { reason_code: string }).reason_code]),
      [
        ['pending', 'reminder_created'],
        ['due', 'reminder_due'],
        ['candidate', 'reminder_candidate'],
        ['delivered', 'reminder_delivered'],
        ['acknowledged', 'reminder_acknowledged'],
      ],
    );
    // previous_status 让一条事件自解释（与 open_thread.changed 同一取向）。
    assert.equal((history[1]?.payload as { previous_status: string }).previous_status, 'pending');
    assert.equal((history[4]?.payload as { previous_status: string }).previous_status, 'delivered');

    // 三处同改的运行时证明：每一条都过权威校验器（envelope 枚举 + payload schema + define）。
    for (const event of history) {
      const { sequence, ...envelope } = event;
      assert.ok(sequence > 0);
      const validated = validateEvent(JSON.parse(JSON.stringify(envelope)));
      assert.equal(validated.event_type, 'reminder.changed');
      const payload = validated.payload as Record<string, unknown>;
      assert.equal(payload['reminder_id'], id);
      assert.equal(payload['owner'], 'father');
      assert.match(String(payload['due_at']), /^2026-10-01T08:00:00\.000\+08:00$/);
      assert.equal(payload['timezone'], SHANGHAI);
    }
  } finally {
    store.close();
  }
});

test('due 查询按绝对时刻比较：跨偏移的两行不会因文本顺序而错判', () => {
  const dir = tempDir();
  const store = openStore(dir);
  try {
    const reminders = new ReminderStore(store);
    // 同一瞬间写的两条：A 在上海时间 08:00（= 00:00Z），B 在 UTC 01:00（= 01:00Z）。
    // 文本比较会说 B 在 A 前面（'01' < '08'），绝对时刻却是 A 在前 —— 这正是 due_at_ms 的理由。
    const a = reminders.create({ what: 'A', owner: 'father', dueAt: '2026-10-01T08:00:00.000+08:00', timezone: SHANGHAI, resolveKind: 'absolute' });
    const b = reminders.create({ what: 'B', owner: 'father', dueAt: '2026-10-01T01:00:00.000+00:00', timezone: 'UTC', resolveKind: 'absolute' });

    assert.deepEqual(reminders.list().map((row) => row.what), ['A', 'B'], '排序按绝对时刻');
    // 00:30Z：只有 A 已经到点。
    const dueNow = reminders.list({ dueBefore: new Date('2026-10-01T00:30:00Z') });
    assert.deepEqual(dueNow.map((row) => row.id), [a.reminder.id]);
    assert.deepEqual(reminders.due(new Date('2026-10-01T00:30:00Z')).map((row) => row.id), [a.reminder.id]);
    assert.deepEqual(
      reminders.due(new Date('2026-10-01T02:00:00Z')).map((row) => row.id),
      [a.reminder.id, b.reminder.id],
      '过了 B 的点之后两条都到了',
    );
  } finally {
    store.close();
  }
});

test('行被外部改坏（due_at 与 due_at_ms 对不上）时宁可抛错，也不拿半个事实去提醒', () => {
  const dir = tempDir();
  const store = openStore(dir);
  try {
    const reminders = new ReminderStore(store);
    const { change } = createOne(store);
    const db = new DatabaseSync(store.dbPath);
    db.prepare('UPDATE reminders SET due_at_ms = ? WHERE id = ?').run(Date.parse('2099-01-01T00:00:00Z'), change.reminder.id);
    db.close();
    expectCode('INVALID_REMINDER', () => reminders.get(change.reminder.id));
  } finally {
    store.close();
  }
});

test('插一条坏提醒会被拒：空的 what、非绝对时刻的 due_at、空 owner', () => {
  const dir = tempDir();
  const store = openStore(dir);
  try {
    const reminders = new ReminderStore(store);
    const base = { owner: 'father', timezone: SHANGHAI, dueAt: '2026-10-01T08:00:00.000+08:00', resolveKind: 'absolute' as const };
    expectCode('INVALID_REMINDER', () => reminders.create({ ...base, what: '   ' }));
    expectCode('INVALID_REMINDER', () => reminders.create({ ...base, what: '吃药', dueAt: '明天早上八点' }));
    expectCode('INVALID_REMINDER', () => reminders.create({ ...base, what: '吃药', dueAt: '2026-10-01T08:00:00' }));
    expectCode('INVALID_REMINDER', () => reminders.create({ ...base, what: '吃药', owner: '' }));
    expectCode('INVALID_REMINDER', () => reminders.create({ ...base, what: '吃药', timezone: '' }));
    // owner 缺省是 unknown（不编造一个人），不是空串。
    const ok = reminders.create({ ...base, what: '吃药', owner: undefined });
    assert.equal(ok.reminder.owner, 'unknown');
    // `Z` 形式的时间戳会被渲染成同一个瞬间的 offset ISO（事件信封不允许 `Z`）。
    const zulu = reminders.create({ ...base, what: '吃药', createdAt: '2026-10-01T00:00:00.000Z', owner: 'father' });
    assert.equal(Date.parse(zulu.reminder.createdAt), Date.parse('2026-10-01T00:00:00.000Z'));
    expectCode('INVALID_REMINDER', () => reminders.create({ ...base, what: '吃药', createdAt: '不是时间' }));
  } finally {
    store.close();
  }
});
