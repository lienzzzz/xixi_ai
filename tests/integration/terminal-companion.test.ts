import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { MimoClient } from '@xixi/model-adapters';
import { buildDirectAdapter } from '../../scripts/chat.ts';
import { openXixiStore } from '@xixi/domain';
import { TerminalCompanion, REPLAY_CONFIG, parseEndpointProfile } from '@xixi/runtime';
import type { TerminalCompanionOptions } from '@xixi/runtime';

const profile = parseEndpointProfile({ schemaVersion: 1, roomId: 'terminal', devices: [
  { id: 'declaration', kind: 'camera', roomId: 'terminal', adapter: 'filtered-events' },
  { id: 'keyboard', kind: 'microphone', roomId: 'terminal', adapter: 'filtered-events' },
  { id: 'stdout', kind: 'speaker', roomId: 'terminal', adapter: 'simulated-playback' },
] });
function rig(ask = false, modelFactory?: TerminalCompanionOptions['modelFactory']) {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-terminal-test-'));
  let now = new Date('2026-10-05T08:00:00+08:00');
  const store = openXixiStore({ dataDir: dir, clock: () => now, offsetMinutes: 480 });
  store.seedSelfProfile(REPLAY_CONFIG.personality.base);
  const config = { ...REPLAY_CONFIG, proactive: { enabled: true, base_cooldown_min: 0, new_session_min_gap_min: 0,
    triggers: { presence_arrived: true, future_hook_due: true, random_smalltalk: false, topic_pool: false, conversation_dangling: false } },
    tools: { approval: { ask: ask ? ['xixi_set_reminder_stub'] : [], ttl_seconds: 300 } } };
  const spoken: string[] = [];
  let broken = false;
  const open = () => TerminalCompanion.open({ store, config, profile, clock: () => now, offsetMinutes: 480,
    modelFactory: modelFactory ?? ((registry) => new FakeBrainAdapter({ registry, now: () => now })),
    decide: () => ({ speak: true, reasonCode: 'good_moment' }),
    write: async (output) => { if (broken) throw new Error('OUTPUT_FAILED'); spoken.push(output.text); } });
  let host = open();
  return { store, spoken, get host() { return host; }, advance(seconds: number) { now = new Date(now.getTime() + seconds * 1000); },
    failOutput() { broken = true; }, async reopen() { await host.close(); host = open(); },
    async close() { await host.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('terminal uses explicit private declaration; public conversation works without private writes', async () => {
  const r = rig();
  try {
    await r.host.handle('提醒我喝水');
    assert.equal(r.store.reminders().length, 0);
    await r.host.handle('/public');
    await r.host.handle('你好');
    assert.ok(r.spoken.some((text) => text.includes('你好')));
    await r.host.handle('/alone');
    await r.host.handle('我喜欢喝茉莉花茶');
    const facts = r.store.semanticMemories().length;
    await r.host.handle('/guest 我喜欢喝咖啡');
    assert.equal(r.store.semanticMemories().length, facts);
    await r.host.handle('/alone');
    await r.host.handle('提醒我喝水');
    assert.equal(r.store.reminders().length, 1);
    assert.ok(r.host.snapshot().outputs.every((o) => o.status === 'completed' || o.status === 'interrupted'));
  } finally { await r.close(); }
});

test('quiet survives restart; pending request is listed and approved once after explicit privacy', async () => {
  const r = rig(true);
  try {
    await r.host.handle('/alone');
    await r.host.handle('提醒我喝水');
    assert.equal(r.store.reminders().length, 0);
    const approval = r.store.toolApprovals()[0];
    assert.ok(approval);
    assert.match((await r.host.handle('/approvals')).message, new RegExp(approval.approvalId));
    await r.host.handle('/quiet');
    await r.reopen();
    await r.host.handle('/alone');
    const before = r.spoken.length;
    await r.host.handle('你好');
    assert.equal(r.spoken.length, before);
    await r.host.handle('/resume');
    await r.host.handle('可以');
    assert.equal(r.store.reminders().length, 1);
    await r.host.handle(`/approve ${approval.approvalId}`);
    assert.equal(r.store.reminders().length, 1);
    assert.equal(r.store.reminders()[0]?.sourceEventId, approval.sourceEventId);
  } finally { await r.close(); }
});

test('reminder is delivered only after stdout succeeds; idle tick does not refresh human evidence', async () => {
  const r = rig();
  try {
    await r.host.handle('/alone');
    await r.host.handle('提醒我喝水');
    await r.reopen();
    r.advance(70);
    await r.host.tick();
    assert.equal(r.host.snapshot().presence, 'unknown');
    assert.notEqual(r.store.reminders()[0]?.status, 'delivered');
    await r.host.handle('/alone');
    await r.host.handle('/tick');
    assert.equal(r.store.reminders()[0]?.status, 'delivered');
    const reminder = r.store.reminders()[0]!;
    assert.ok(r.spoken.some((text) => text.includes('喝水')));
    await r.host.handle(`/ack ${reminder.id}`);
    assert.equal(r.store.reminders()[0]?.status, 'acknowledged');
  } finally { await r.close(); }
});

test('output failure interrupts the ledger and cannot claim delivery', async () => {
  const r = rig();
  try {
    await r.host.handle('/alone');
    await r.host.handle('提醒我喝水');
    await r.reopen();
    r.advance(70);
    await r.host.handle('/alone');
    r.failOutput();
    await assert.rejects(r.host.handle('/tick'), /OUTPUT_FAILED/);
    assert.notEqual(r.store.reminders()[0]?.status, 'delivered');
    assert.equal(r.host.snapshot().outputs.at(-1)?.status, 'interrupted');
  } finally { await r.close(); }
});

test('guest approval text and ambiguous approval text never execute owner tools', async () => {
  const r = rig(true);
  try {
    await r.host.handle('/alone');
    await r.host.handle('提醒我喝水');
    await r.host.handle('提醒我吃饭');
    assert.equal(r.store.toolApprovals().length, 2);
    await r.host.handle('/guest 可以');
    assert.equal(r.store.reminders().length, 0);
    await r.host.handle('/alone');
    assert.equal((await r.host.handle('可以')).reasonCode, 'AMBIGUOUS_APPROVAL');
    assert.equal(r.store.reminders().length, 0);
  } finally { await r.close(); }
});

test('public or revoked consent debug commands cannot disclose private output and reminders', async () => {
  const r = rig();
  try {
    await r.host.handle('/alone');
    await r.host.handle('我的私人事情是喜欢茉莉花茶');
    await r.host.handle('提醒我给老朋友打电话');
    await r.host.handle('/public');
    assert.ok(!(await r.host.handle('/state')).message.includes('茉莉花茶'));
    assert.ok(!(await r.host.handle('/reminders')).message.includes('老朋友'));
    await r.host.handle('/alone');
    await r.host.handle('/privacy');
    assert.ok(!(await r.host.handle('/prompt')).message.includes('茉莉花茶'));
    assert.ok(!(await r.host.handle('/reminders')).message.includes('老朋友'));
  } finally { await r.close(); }
});

function httpProvider(what: unknown, requests: Record<string, unknown>[]): MimoClient {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    const messages = body['messages'] as Array<{ role: string }>;
    const completed = messages.some((m) => m.role === 'tool');
    const delta = completed ? { content: '提醒已经设置好了。' } : { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'xixi_set_reminder_stub', arguments: JSON.stringify({ what }) } }] };
    return new Response(`data: ${JSON.stringify({ model: 'test-model', choices: [{ delta }] })}\n\n` +
      `data: ${JSON.stringify({ model: 'test-model', choices: [{ delta: {}, finish_reason: completed ? 'stop' : 'tool_calls' }] })}\n\n` + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return new MimoClient({ apiKey: 'offline-test-only', fetchImpl });
}

test('real API adapter uses the terminal-owned registry and actual durable reminder receipt', async () => {
  const requests: Record<string, unknown>[] = [];
  const client = httpProvider('喝水', requests);
  const r = rig(false, (registry) => buildDirectAdapter({ config: REPLAY_CONFIG, toolChain: registry, client }));
  try {
    await r.host.handle('/alone');
    await r.host.handle('提醒我喝水');
    assert.equal(r.store.reminders()[0]?.what, '喝水');
    assert.equal(r.store.reminders()[0]?.owner, 'father');
    assert.ok(r.store.reminders()[0]?.sourceEventId);
    assert.equal(requests.length, 2);
    const messages = requests[1]?.['messages'] as Array<{ role: string; content: string }>;
    const receipt = JSON.parse(messages.find((m) => m.role === 'tool')!.content) as Record<string, unknown>;
    assert.equal(receipt['registered'], true);
    assert.equal(receipt['id'], r.store.reminders()[0]?.id);
  } finally { await r.close(); }
});

test('failed write cannot be advertised as completed by a dishonest API reply', async () => {
  const requests: Record<string, unknown>[] = [];
  const r = rig(false, (registry) => buildDirectAdapter({ config: REPLAY_CONFIG, toolChain: registry, client: httpProvider(7, requests) }));
  try {
    await r.host.handle('/alone');
    await r.host.handle('提醒我喝水');
    assert.equal(r.store.reminders().length, 0);
    assert.ok(!r.spoken.some((text) => text.includes('设置好了')));
    const session = r.host.snapshot().sessions['father.private']!;
    assert.ok(!JSON.stringify(r.store.readEvents({ type: 'conversation.turn', sessionId: session, limit: 100 })).includes('设置好了'));
  } finally { await r.close(); }
});

test('API transport failure leaves no delivery or false tool success', async () => {
  const fetchImpl: typeof fetch = async () => { throw new Error('offline transport failure'); };
  const client = new MimoClient({ apiKey: 'offline-test-only', fetchImpl });
  const r = rig(false, (registry) => buildDirectAdapter({ config: REPLAY_CONFIG, toolChain: registry, client }));
  try {
    await r.host.handle('/alone');
    await assert.rejects(r.host.handle('提醒我喝水'));
    assert.equal(r.store.reminders().length, 0);
    assert.equal(r.spoken.length, 0);
    assert.equal(r.host.snapshot().outputs.length, 0);
    assert.ok(r.host.snapshot().interruptedInputs.length > 0);
  } finally { await r.close(); }
});

test('a long API wait expires manual presence before executing a private write', async () => {
  let r: ReturnType<typeof rig>;
  r = rig(false, (registry) => {
    const adapter = new FakeBrainAdapter({ registry });
    const respond = adapter.handleUserTurn.bind(adapter);
    adapter.handleUserTurn = async (input) => { r.advance(61); return respond(input); };
    return adapter;
  });
  try {
    await r.host.handle('/alone');
    await r.host.handle('提醒我喝水');
    assert.equal(r.store.reminders().length, 0);
    assert.equal(r.spoken.length, 0);
    assert.equal(r.host.snapshot().outputs.at(-1)?.status, 'interrupted');
  } finally { await r.close(); }
});
