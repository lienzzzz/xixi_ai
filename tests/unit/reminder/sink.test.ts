/**
 * V0.3 P2-E — 工具面的接线：`xixi_set_reminder` 真的写进 durable 表（pack §7）。
 *
 * 这一组用例走的是**真实工具链**（`buildToolChain` + `ToolRegistry.execute` + 真的内置工具），
 * 而不是往 sink 上直接塞数据 —— P2 之前的缺陷正是「工具接的是内存 sink，所以进程一结束就没了」。
 *
 * 另外两条：
 *
 *   * 需要审批的写入口按 P2-B 的 ASK 走：声明 `tools.approval.ask` 之后，第一次调用**只落待批请求、
 *     一条提醒都不写**；点头之后用**冻结的那组参数**执行，才真的写进表；
 *   * `ToolContext` 今天只带 `timezone`/`now`，所以 `owner`/`session_id`/`source_event_id` 由入口在
 *     工具调用之前用 `beginTurn()` 绑定（与它填 `ToolExecutionContext` 的是同一组值）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReminderStore, parseXixiConfig, openXixiStore, type XixiConfig, type XixiStore } from '@xixi/domain';
import { DurableReminderSink, ToolApprovalManager, buildToolChain } from '@xixi/runtime';

const SPOKEN_AT = new Date('2026-09-30T23:40:00+08:00');
const SHANGHAI = 'Asia/Shanghai';
const TOOL = 'xixi_set_reminder';

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
  proactive: {}
  memory: {}
  privacy: {}
  features: {}
`;

function config(extra = ''): XixiConfig {
  return parseXixiConfig(`${CONFIG_YAML}${extra}`, 'test-inline.yaml');
}

/** 一次「明天八点提醒我打电话」的工具调用（身份由入口绑定，模型给不了）。 */
function context(at: Date = SPOKEN_AT) {
  return { scope: 'conversation' as const, timezone: SHANGHAI, now: at, sessionId: 'sess_reminder', actorId: 'father', sourceEventId: 'evt_turn_1' };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'xixi-reminder-tool-'));
}

test('工具真的写进 durable 表：解析后的 due_at 落库，工具回给模型的是绝对时刻', async () => {
  const root = tempDir();
  const store = openXixiStore({ dataDir: root });
  try {
    const sink = new DurableReminderSink({ store, timezone: SHANGHAI });
    sink.beginTurn({ sessionId: 'sess_reminder', actorId: 'father', sourceEventId: 'evt_turn_1' });
    const registry = buildToolChain(config(), { reminderSink: sink, now: () => SPOKEN_AT, role: 'resident' });

    // 工具仍然叫这个名字（改名不在本任务的范围里），但它背后已经是表，不是数组。
    assert.ok(registry.names().includes(TOOL));
    const execution = await registry.execute({ name: TOOL, arguments: { what: '给儿子打电话', when: '明天八点' } }, context());
    assert.equal(execution.record.ok, true, JSON.stringify(execution.payload));
    const id = String(execution.payload['id']);
    assert.match(id, /^rem_[0-9a-f-]{36}$/);
    assert.equal(execution.payload['when'], '2026-10-01T08:00:00.000+08:00', '回给模型的是解析后的绝对时刻');

    const row = new ReminderStore(store).get(id);
    assert.ok(row !== null, '工具调用之后表里真的有这一行');
    assert.equal(row.what, '给儿子打电话');
    assert.equal(row.dueAt, '2026-10-01T08:00:00.000+08:00');
    assert.equal(row.timezone, SHANGHAI);
    assert.equal(row.owner, 'father', 'owner 来自入口绑定的身份');
    assert.equal(row.sessionId, 'sess_reminder');
    assert.equal(row.sourceEventId, 'evt_turn_1', '提醒指回触发它的那一轮');
    assert.equal(row.resolveKind, 'day_relative');
    sink.endTurn();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('声明了审批的写入口按 P2-B 的 ASK 走：点头之前一条提醒都不写', async () => {
  const root = tempDir();
  const store = openXixiStore({ dataDir: root });
  try {
    const settings = { ask: [TOOL], ttlSeconds: 300 };
    const manager = new ToolApprovalManager({ store, settings, now: () => SPOKEN_AT });
    const sink = new DurableReminderSink({ store, timezone: SHANGHAI });
    sink.beginTurn({ sessionId: 'sess_reminder', actorId: 'father', sourceEventId: 'evt_turn_1' });
    const registry = buildToolChain(config(), {
      reminderSink: sink,
      now: () => SPOKEN_AT,
      role: 'resident',
      approval: settings,
      approvalGate: manager,
    });
    manager.useRegistry(registry);

    const asked = await registry.execute({ name: TOOL, arguments: { what: '给儿子打电话', when: '明天八点' } }, context());
    assert.equal(asked.record.error, 'APPROVAL_REQUIRED', 'ask 停在审批，不是执行');
    assert.equal(new ReminderStore(store).list().length, 0, '点头之前不许写提醒');
    const approvalId = String(asked.payload['approvalId']);
    assert.match(approvalId, /^apr_[0-9a-f-]{36}$/);

    // 下一轮（甚至重启之后）用户点头：用**冻结的那组参数**执行，这时才真的写进表。
    sink.beginTurn({ sessionId: 'sess_confirm', actorId: 'father', sourceEventId: 'evt_turn_2' });
    const decision = await manager.approve({ approvalId, actorId: 'father' });
    assert.equal(decision.status, 'executed');
    const rows = new ReminderStore(store).list();
    assert.equal(rows.length, 1, '点头之后写了一条');
    assert.equal(rows[0]?.what, '给儿子打电话');
    assert.equal(rows[0]?.dueAt, '2026-10-01T08:00:00.000+08:00', '冻结的 when 被原样执行');
    assert.equal(rows[0]?.sourceEventId, 'evt_turn_2');
    sink.endTurn();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('出厂配置（没有声明 ask）不 ASK：写提醒不需要审批', async () => {
  const root = tempDir();
  const store = openXixiStore({ dataDir: root });
  try {
    const settings = { ask: [], ttlSeconds: 300 };
    const manager = new ToolApprovalManager({ store, settings, now: () => SPOKEN_AT });
    const sink = new DurableReminderSink({ store, timezone: SHANGHAI });
    sink.beginTurn({ sessionId: 'sess_reminder', actorId: 'father' });
    const registry = buildToolChain(config(), {
      reminderSink: sink,
      now: () => SPOKEN_AT,
      role: 'resident',
      approval: settings,
      approvalGate: manager,
    });
    manager.useRegistry(registry);
    const execution = await registry.execute({ name: TOOL, arguments: { what: '吃药', when: '晚上七点' } }, context());
    assert.equal(execution.record.ok, true);
    assert.equal(new ReminderStore(store).list().length, 1);
    assert.equal(manager.pending(SPOKEN_AT).length, 0, '没声明的工具不会产生待批请求');
    sink.endTurn();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('重启之后工具写下的提醒还在（同一个库、新进程）', async () => {
  const root = tempDir();
  const first: XixiStore = openXixiStore({ dataDir: root });
  let id = '';
  try {
    const sink = new DurableReminderSink({ store: first, timezone: SHANGHAI });
    sink.beginTurn({ actorId: 'father', sessionId: 'sess_reminder' });
    const registry = buildToolChain(config(), { reminderSink: sink, now: () => SPOKEN_AT, role: 'resident' });
    const execution = await registry.execute({ name: TOOL, arguments: { what: '给儿子打电话', when: '明天八点' } }, context());
    id = String(execution.payload['id']);
  } finally {
    first.close();
  }

  const reopened = openXixiStore({ dataDir: root });
  try {
    const row = new ReminderStore(reopened).get(id);
    assert.ok(row !== null, '重启后提醒仍在');
    assert.equal(row.status, 'pending');
    assert.equal(row.dueAt, '2026-10-01T08:00:00.000+08:00');
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});
