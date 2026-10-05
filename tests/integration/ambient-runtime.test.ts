import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeBrainAdapter, type ToolRegistry, type UserTurnInput } from '@xixi/brain-adapter';
import { MemoryStore, openXixiStore } from '@xixi/domain';
import { AmbientRuntime, REPLAY_CONFIG, type AmbientEvent } from '@xixi/runtime';

const START = '2026-10-05T08:00:00+08:00';
const devices = [
  { id: 'camera', roomId: 'living', kind: 'camera' as const },
  { id: 'mic1', roomId: 'living', kind: 'microphone' as const },
  { id: 'mic2', roomId: 'living', kind: 'microphone' as const },
  { id: 'speaker', roomId: 'living', kind: 'speaker' as const },
];

function rig(ask = false) {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-ambient-test-'));
  let at = new Date(START);
  let calls = 0;
  const prompts: UserTurnInput[] = [];
  let gate: Promise<void> | null = null;
  let entered: (() => void) | null = null;
  const config = { ...REPLAY_CONFIG, proactive: { enabled: true, base_cooldown_min: 0, new_session_min_gap_min: 0,
    triggers: { presence_arrived: true, future_hook_due: true, random_smalltalk: false, topic_pool: false, conversation_dangling: false } },
    tools: { approval: { ask: ask ? ['xixi_set_reminder_stub'] : [], ttl_seconds: 60 } } };
  let store = openXixiStore({ dataDir: dir, clock: () => at, offsetMinutes: 480 });
  store.seedSelfProfile({ proactivity: 0.85, silence_tolerance: 0.7 });
  const factory = (registry: ToolRegistry) => {
    const adapter = new FakeBrainAdapter({ registry, now: () => at,
      reply: (input) => { calls++; prompts.push(input); return { action: 'SPEAK', text: `收到：${input.text}` }; } });
    const respond = adapter.handleUserTurn.bind(adapter);
    adapter.handleUserTurn = async (input) => { entered?.(); if (gate !== null) await gate; return respond(input); };
    return adapter;
  };
  const open = () => AmbientRuntime.open({ store, config, roomId: 'living', devices, clock: () => at,
    consent: true, offsetMinutes: 480, modelFactory: factory,
    decide: (_input, scene) => ({ speak: !scene.busy, reasonCode: scene.busy ? 'user_busy' : 'good_moment' }) });
  let runtime = open();
  let serial = 0;
  const send = async (kind: AmbientEvent['kind'], values: Record<string, unknown> = {}, seconds = 0) => {
    at = new Date(Date.parse(START) + seconds * 1000);
    return runtime.dispatch({ schemaVersion: 1, eventId: `e${++serial}`, roomId: 'living', at: at.toISOString(), kind, ...values } as AmbientEvent);
  };
  return {
    get runtime() { return runtime; }, get store() { return store; }, get calls() { return calls; }, prompts, send, dir,
    pause(next: Promise<void>, onEntered: () => void) { gate = next; entered = onEntered; },
    otherHost: open,
    async reopen() { await runtime.close(); store.close(); store = openXixiStore({ dataDir: dir, clock: () => at, offsetMinutes: 480 }); runtime = open(); },
    async close() { await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('fresh owner arrival is considered by the model; busy and quiet hours remain silent', async () => {
  const r = rig();
  try {
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] });
    await r.send('scene', { busy: true });
    assert.equal((await r.send('tick', {}, 1)).reasonCode, 'MODEL_DECLINED');
    assert.equal(r.runtime.snapshot().outputs.length, 0);
    await r.send('scene', { busy: false }, 2);
    const greeting = await r.send('tick', {}, 3);
    assert.equal(greeting.reasonCode, 'PASSED');
    assert.equal(r.runtime.snapshot().outputs.length, 1);
    assert.equal(r.runtime.snapshot().outputs[0]?.status, 'queued');
    await r.send('playback', { deviceId: 'speaker', outputId: greeting.outputId, action: 'complete' }, 4);
    await r.send('scene', { busy: false }, 39.75 * 3600);
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 39.75 * 3600);
    assert.equal((await r.send('tick', {}, 39.75 * 3600 + 1)).reasonCode, 'QUIET_HOURS');
  } finally { await r.close(); }
});

test('guest and unknown speech cannot read or change the owner memory and private history', async () => {
  const r = rig();
  try {
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'owner', actor: 'father', address: 'direct', text: '我喜欢喝茉莉花茶' });
    const memory = new MemoryStore(r.store);
    const before = memory.snapshot();
    const factsBefore = memory.semantic();
    assert.ok(r.store.semanticMemories().length > 0);
    await r.send('presence', { deviceId: 'camera', occupants: ['father', 'guest'] }, 1);
    assert.notEqual((await r.send('tick', {}, 2)).reasonCode, 'PASSED');
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'guest', actor: 'guest', address: 'direct', text: '我喜欢喝咖啡，明天我要去办证' }, 3);
    await r.send('speech', { deviceId: 'mic2', utteranceId: 'unknown', actor: 'unknown', address: 'direct', text: '不是，我不喜欢茉莉花茶了' }, 4);
    assert.deepEqual(memory.snapshot(), before);
    assert.deepEqual(memory.semantic(), factsBefore);
    const last = r.prompts.at(-1);
    assert.ok(last);
    assert.ok(!JSON.stringify(last.prompt?.history).includes('我喜欢喝茉莉花茶'));
    assert.ok(!last.prompt?.user.includes('[较确定] 我喜欢喝茉莉花茶'));
    const users = r.store.readEvents({ type: 'conversation.turn', limit: 100 }).filter((e) => (e.payload as Record<string, unknown>)['role'] === 'user');
    assert.deepEqual(users.map((e) => e.actor), ['father', 'unknown_person', 'unknown_person']);
  } finally { await r.close(); }
});

test('same utterance across microphones and restarts executes once; distinct ids remain distinct', async () => {
  const r = rig();
  try {
    const values = { utteranceId: 'u1', actor: 'father', address: 'direct', text: '你好' };
    await r.send('speech', { ...values, deviceId: 'mic1' });
    const before = r.calls;
    assert.equal((await r.send('speech', { ...values, deviceId: 'mic2' }, 1)).reasonCode, 'DUPLICATE_INPUT');
    await r.reopen();
    assert.equal((await r.send('speech', { ...values, deviceId: 'mic1' }, 2)).reasonCode, 'DUPLICATE_INPUT');
    assert.equal(r.calls, before);
    await r.send('speech', { ...values, utteranceId: 'u2', deviceId: 'mic1' }, 3);
    assert.ok(r.calls > before);
    await assert.rejects(r.send('speech', { ...values, text: 'different', deviceId: 'mic1' }, 4), /INPUT_ID_CONFLICT/);
  } finally { await r.close(); }
});

test('media, self and ambient speech do not call the model; identity changes close continuation', async () => {
  const r = rig();
  try {
    for (const address of ['media', 'self', 'ambient']) await r.send('speech', { deviceId: 'mic1', utteranceId: address, actor: 'father', address, text: '电视里说西西' });
    assert.equal(r.calls, 0);
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'a', actor: 'father', address: 'direct', text: '你好' }, 1);
    const before = r.calls;
    assert.equal((await r.send('speech', { deviceId: 'mic1', utteranceId: 'b', actor: 'guest', address: 'continuation', text: '我也喜欢' }, 2)).reasonCode, 'NOT_ADDRESSED');
    assert.equal(r.calls, before);
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'c', actor: 'father', address: 'continuation', text: '接着聊吧' }, 3);
    assert.ok(r.calls > before);
    assert.equal((await r.send('speech', { deviceId: 'mic1', utteranceId: 'd', actor: 'father', address: 'continuation', text: '接着聊吧' }, 90)).reasonCode, 'NOT_ADDRESSED');
  } finally { await r.close(); }
});

test('barge-in clears playback and a restart never replays queued or playing output', async () => {
  const r = rig();
  try {
    const a = await r.send('speech', { deviceId: 'mic1', utteranceId: 'a', actor: 'father', address: 'direct', text: '你好' });
    await r.send('playback', { deviceId: 'speaker', outputId: a.outputId, action: 'start' }, 1);
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'b', actor: 'father', address: 'direct', text: '等等' }, 2);
    assert.equal(r.runtime.snapshot().outputs[0]?.status, 'interrupted');
    assert.equal(r.runtime.snapshot().outputs[1]?.status, 'queued');
    await r.reopen();
    assert.equal(r.runtime.snapshot().outputs[1]?.status, 'interrupted');
    assert.equal(r.runtime.snapshot().outputs.filter((o) => o.status === 'queued' || o.status === 'playing').length, 0);
  } finally { await r.close(); }
});

test('camera loss, stale evidence and restart report unknown presence without greetings', async () => {
  const r = rig();
  try {
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] });
    await r.send('tick', {}, 61);
    assert.equal(r.runtime.snapshot().presence, 'unknown');
    assert.equal(r.runtime.snapshot().outputs.length, 0);
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 62);
    await r.send('device', { deviceId: 'camera', online: false }, 63);
    await r.send('tick', {}, 64);
    assert.equal(r.runtime.snapshot().presence, 'unknown');
    await r.send('device', { deviceId: 'camera', online: true }, 65);
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 65);
    await r.reopen();
    assert.equal(r.runtime.snapshot().presence, 'unknown');
    await r.send('tick', {}, 66);
    assert.equal(r.runtime.snapshot().outputs.length, 0);
  } finally { await r.close(); }
});

test('real reminder tool persists across restart and marks delivered only on playback completion', async () => {
  const r = rig();
  try {
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] });
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'rem', actor: 'father', address: 'direct', text: '提醒我喝水' });
    const reminder = r.store.reminders()[0];
    assert.ok(reminder);
    assert.equal(reminder.owner, 'father');
    assert.ok(reminder.sourceEventId, 'the reminder points at the actual originating user event');
    await r.reopen();
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 70);
    const result = await r.send('tick', {}, 71);
    assert.equal(result.reasonCode, 'PASSED');
    assert.equal(r.store.reminders()[0]?.status, 'candidate');
    await r.send('playback', { deviceId: 'speaker', outputId: result.outputId, action: 'complete' }, 72);
    assert.equal(r.store.reminders()[0]?.status, 'delivered');
    await r.send('acknowledge', { actor: 'father', reminderId: reminder.id }, 73);
    assert.equal(r.store.reminders()[0]?.status, 'acknowledged');
    await r.reopen();
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 80);
    await r.send('tick', {}, 81);
    assert.equal(r.runtime.snapshot().outputs.filter((o) => o.reminderId === reminder.id).length, 1);
  } finally { await r.close(); }
});

test('guest cannot write reminders; owner confirmation executes the frozen approved call once', async () => {
  const r = rig(true);
  try {
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'g', actor: 'guest', address: 'direct', text: '提醒我喝水' });
    assert.equal(r.store.reminders().length, 0);
    assert.equal(r.store.toolApprovals().length, 0);
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 1);
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'o', actor: 'father', address: 'direct', text: '提醒我喝水' }, 1);
    const pending = r.store.toolApprovals()[0];
    assert.ok(pending);
    await assert.rejects(r.send('approval', { actor: 'guest', approvalId: pending.approvalId, action: 'approve' }, 2), /OWNER_REQUIRED/);
    await r.send('approval', { actor: 'father', approvalId: pending.approvalId, action: 'approve' }, 3);
    assert.equal(r.store.reminders().length, 1);
    await r.send('approval', { actor: 'father', approvalId: pending.approvalId, action: 'approve' }, 4);
    assert.equal(r.store.reminders().length, 1);
    assert.equal(r.store.reminders()[0]?.owner, 'father');
  } finally { await r.close(); }
});

test('invalid device, malformed event and backward time fail before side effects', async () => {
  const r = rig();
  try {
    const revision = r.runtime.snapshot().revision;
    await assert.rejects(r.send('speech', { deviceId: 'not-registered', actor: 'father', address: 'direct', text: 'hi', utteranceId: 'x' }), /UNKNOWN_DEVICE/);
    await assert.rejects(r.send('presence', { deviceId: 'mic1', occupants: ['father'] }), /DEVICE_KIND/);
    await assert.rejects(r.runtime.dispatch({ kind: 'tick' } as AmbientEvent), /INVALID_AMBIENT_EVENT/);
    assert.equal(r.runtime.snapshot().revision, revision);
    await r.send('scene', { busy: true }, 5);
    await assert.rejects(r.send('tick', {}, 4), /TIME_REVERSED/);
    assert.equal(r.calls, 0);
  } finally { await r.close(); }
});

test('revoking consent survives restart and blocks model calls until an explicit new consent', async () => {
  const r = rig();
  try {
    await r.send('scene', { consent: false });
    await r.reopen();
    assert.equal((await r.send('speech', { deviceId: 'mic1', utteranceId: 'blocked', actor: 'father', address: 'direct', text: '你好' }, 1)).reasonCode, 'PRIVACY_BLOCKED');
    assert.equal(r.calls, 0);
    await r.send('scene', { consent: true }, 2);
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'allowed', actor: 'father', address: 'direct', text: '你好' }, 3);
    assert.ok(r.calls > 0);
  } finally { await r.close(); }
});

test('expiry or an empty room interrupts pending speech instead of finishing it unseen', async () => {
  const r = rig();
  try {
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] });
    const greeting = await r.send('tick', {}, 1);
    assert.ok(greeting.outputId);
    await r.send('tick', {}, 61);
    assert.equal(r.runtime.snapshot().outputs[0]?.status, 'interrupted');
    await r.send('presence', { deviceId: 'camera', occupants: [] }, 62);
    assert.equal((await r.send('tick', {}, 63)).reasonCode, 'PRESENCE_UNKNOWN_OR_ABSENT');
  } finally { await r.close(); }
});

test('approval denial and expiry are durable and never schedule a reminder', async () => {
  const r = rig(true);
  try {
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] });
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'deny', actor: 'father', address: 'direct', text: '提醒我喝水' });
    const denied = r.store.toolApprovals()[0];
    assert.ok(denied);
    await r.send('approval', { actor: 'father', approvalId: denied.approvalId, action: 'deny' }, 1);
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'expire', actor: 'father', address: 'direct', text: '提醒我吃饭' }, 2);
    const expiring = r.store.toolApprovals().find((p) => p.status === 'pending');
    assert.ok(expiring);
    await r.reopen();
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 63);
    await r.send('approval', { actor: 'father', approvalId: expiring.approvalId, action: 'approve' }, 63);
    assert.equal(r.store.toolApprovals().find((p) => p.approvalId === denied.approvalId)?.status, 'denied');
    assert.equal(r.store.toolApprovals().find((p) => p.approvalId === expiring.approvalId)?.status, 'expired');
    assert.equal(r.store.reminders().length, 0);
  } finally { await r.close(); }
});

test('claimed input recovery refuses to replay a turn with unknown execution results', async () => {
  const r = rig();
  try {
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'crash', actor: 'father', address: 'direct', text: '你好' });
    await r.runtime.close();
    const row = r.store.readRuntimeCheckpoint('ambient.living');
    assert.ok(row);
    const value = structuredClone(row.value);
    const inputs = value['inputs'] as Record<string, { status: string }>;
    const input = inputs['utterance.crash'];
    assert.ok(input);
    input.status = 'processing';
    r.store.writeRuntimeCheckpoint('ambient.living', value, row.revision, 'test.crash_window');
    const before = r.calls;
    await r.reopen();
    assert.deepEqual(r.runtime.snapshot().interruptedInputs, ['utterance.crash']);
    const result = await r.send('speech', { deviceId: 'mic2', utteranceId: 'crash', actor: 'father', address: 'direct', text: '你好' }, 1);
    assert.equal(result.reasonCode, 'INTERRUPTED_INPUT');
    assert.equal(r.calls, before);
  } finally { await r.close(); }
});

test('a stale runtime instance fails CAS before calling a model or tool', async () => {
  const r = rig();
  try {
    const row = r.store.readRuntimeCheckpoint('ambient.living');
    assert.ok(row);
    r.store.writeRuntimeCheckpoint('ambient.living', row.value, row.revision, 'test.other_writer');
    await assert.rejects(r.send('speech', { deviceId: 'mic1', utteranceId: 'conflict', actor: 'father', address: 'direct', text: '提醒我喝水' }), /CHECKPOINT_CONFLICT/);
    assert.equal(r.calls, 0);
    assert.equal(r.store.reminders().length, 0);
  } finally { await r.close(); }
});

test('owner public speech never receives the previous private session history', async () => {
  const r = rig();
  try {
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] });
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'private', actor: 'father', address: 'direct', text: '我的私人事情不想让别人知道' }, 1);
    await r.send('presence', { deviceId: 'camera', occupants: ['father', 'guest'] }, 2);
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'public', actor: 'father', address: 'direct', text: '刚才聊了什么' }, 3);
    const prompt = r.prompts.at(-1)?.prompt;
    assert.ok(prompt);
    assert.ok(!JSON.stringify(prompt.history).includes('私人事情'));
    assert.ok(!prompt.user.includes('私人事情'));
    assert.notEqual(r.runtime.snapshot().sessions['father.private'], r.runtime.snapshot().sessions['father.public']);
  } finally { await r.close(); }
});

test('quiet mode is durable and stops both replies and proactive speech until explicitly resumed', async () => {
  const r = rig();
  try {
    await r.send('scene', { quiet: true });
    await r.reopen();
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 1);
    assert.equal((await r.send('tick', {}, 2)).reasonCode, 'DND_ACTIVE');
    assert.equal((await r.send('speech', { deviceId: 'mic1', utteranceId: 'quiet', actor: 'father', address: 'direct', text: '你好' }, 3)).reasonCode, 'DND_ACTIVE');
    assert.equal(r.calls, 0);
    await r.send('scene', { quiet: false }, 4);
    assert.equal((await r.send('tick', {}, 5)).reasonCode, 'PASSED');
  } finally { await r.close(); }
});

test('owner writes require fresh exclusive presence and playback rechecks TTL without tick', async () => {
  const r = rig();
  try {
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'unknown-write', actor: 'father', address: 'direct', text: '提醒我喝水' });
    assert.equal(r.store.reminders().length, 0);
    await r.send('presence', { deviceId: 'camera', occupants: ['father', 'guest'] }, 1);
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'public-write', actor: 'father', address: 'direct', text: '提醒我喝水' }, 2);
    assert.equal(r.store.reminders().length, 0);
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 3);
    const reply = await r.send('speech', { deviceId: 'mic1', utteranceId: 'private-write', actor: 'father', address: 'direct', text: '提醒我喝水' }, 4);
    assert.equal(r.store.reminders().length, 1);
    const result = await r.send('playback', { deviceId: 'speaker', outputId: reply.outputId, action: 'start' }, 64);
    assert.equal(result.reasonCode, 'PLAYBACK_PRIVACY_BLOCKED');
    assert.equal(r.runtime.snapshot().outputs.at(-1)?.status, 'interrupted');
  } finally { await r.close(); }
});

test('default due reminder speaks the requested action instead of internal metadata', async () => {
  const r = rig();
  try {
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] });
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'rem-text', actor: 'father', address: 'direct', text: '提醒我喝水' });
    await r.reopen();
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 80);
    const result = await r.send('tick', {}, 81);
    const output = r.runtime.snapshot().outputs.find((o) => o.id === result.outputId);
    assert.ok(output);
    assert.ok(output.text.includes('喝水'));
    assert.ok(!output.text.includes('durable reminder'));
    assert.ok(!output.text.includes('due_at'));
  } finally { await r.close(); }
});

test('takeover while an old host awaits a model fences the old write tool', async () => {
  const r = rig();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  r.pause(new Promise<void>((resolve) => { release = resolve; }), entered);
  try {
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] });
    const pending = r.send('speech', { deviceId: 'mic1', utteranceId: 'active', actor: 'father', address: 'direct', text: '提醒我喝水' });
    const rejected = assert.rejects(pending, /CHECKPOINT_CONFLICT/);
    await ready;
    const other = r.otherHost();
    release();
    await rejected;
    assert.equal(r.store.reminders().length, 0);
    await other.close();
  } finally { release(); await r.close(); }
});

test('private-public-private audience changes restore the owner approval registry', async () => {
  const r = rig(true);
  try {
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] });
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'pending-private', actor: 'father', address: 'direct', text: '提醒我喝水' });
    const approval = r.store.toolApprovals()[0];
    assert.ok(approval);
    await r.send('presence', { deviceId: 'camera', occupants: ['father', 'guest'] }, 1);
    await r.send('speech', { deviceId: 'mic1', utteranceId: 'public-chat', actor: 'father', address: 'direct', text: '你好' }, 2);
    assert.equal((await r.send('approval', { actor: 'father', approvalId: approval.approvalId, action: 'approve' }, 3)).reasonCode, 'PRIVATE_OWNER_REQUIRED');
    assert.equal(r.store.toolApprovals()[0]?.status, 'pending');
    await r.send('presence', { deviceId: 'camera', occupants: ['father'] }, 4);
    await r.send('approval', { actor: 'father', approvalId: approval.approvalId, action: 'approve' }, 5);
    assert.equal(r.store.reminders().length, 1);
  } finally { await r.close(); }
});
