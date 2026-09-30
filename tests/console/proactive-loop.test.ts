/**
 * Console tests for the resident consideration loop (t70, M5-lite).
 *
 * The loop is the first thing in this project that speaks *without* being asked, so the tests
 * are about the boundaries rather than the happy path: the switch starts off, a candidate must
 * trace back to a fact (presence projection, time since the last user turn, a clock hook), every
 * gate still applies, and one candidate is never delivered twice.
 *
 * TTS is not exercised here (no key in the gate): a synthesized clip is replaced by the seam, so
 * what is asserted is that the *audio path* is taken and that a missing key is reported instead
 * of being silently dropped. The real spoken run is evidence in the task report.
 *
 * Run: `npm run test:console` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildEvent, toOffsetIso } from '@xixi/contracts';
import { parseProactiveSettings } from '@xixi/conversation';
import { openXixiStore } from '@xixi/domain';

import { REPO_ROOT } from '../../scripts/lib/harness.ts';

import {
  DEFAULT_LOOP_INTERVAL_MS,
  MIN_LOOP_INTERVAL_MS,
  PROACTIVE_CLOCK_HOOKS,
  PROACTIVE_DANGLING_AFTER_MINUTES,
  ProactiveLoop,
  buildProactiveCandidates,
  createFakeProbeRunner,
  createFieldServer,
  formatClockMinutes,
  lastUserTurnAt,
  proactivePanelHtml,
  proactivePanelScript,
} from '../../scripts/field-test.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A loop over a throwaway store, with every reader under the test's control. */
function makeLoop(options: {
  readonly store: ReturnType<typeof openXixiStore>;
  readonly now: Date;
  readonly present?: boolean | null;
  readonly lastUserTurnAt?: Date | null;
  readonly state?: 'IDLE' | 'LINGERING' | 'ACTIVE' | 'SUSPENDED' | 'ENGAGING';
  readonly settings?: ReturnType<typeof parseProactiveSettings>;
  readonly synthesize?: ((text: string) => Promise<Buffer>) | undefined;
  readonly intervalMs?: number;
}): ProactiveLoop {
  const settings =
    options.settings ??
    parseProactiveSettings({ enabled: true, base_cooldown_min: 0, max_per_6h: 10, max_per_day: 10, quiet_hours: { start: '00:00', end: '00:00' } });
  return new ProactiveLoop({
    store: options.store,
    readSettings: () => settings,
    readState: () => options.state ?? 'IDLE',
    readProactivity: () => 0.7,
    readPresence: async () => ({ present: options.present ?? null, updatedAt: null, source: 'test' }),
    readLastUserTurnAt: () => options.lastUserTurnAt ?? null,
    readSessionId: () => null,
    synthesize: options.synthesize,
    intervalMs: options.intervalMs,
    now: () => options.now,
    log: () => {},
  });
}

test('the loop starts off, and the panel says so', () => {
  const html = proactivePanelHtml();
  assert.ok(html.includes('id="px-loop-enabled"'), 'the page has the 「开始自动考虑」 switch');
  assert.match(html, /<input type="checkbox" id="px-loop-enabled" \/>/, 'and it is a checkbox (off by default)');
  assert.ok(html.includes('id="px-loop-interval"'), 'with an interval knob');
  assert.match(html, /默认关/, 'and the copy says it is off by default');
  assert.match(html, /在场投影 \/ 上次说话过了多久 \/ 固定时钟钩子/, 'and names the factual sources');
  const script = proactivePanelScript('/api/field');
  assert.match(script, /loopBox\.checked = false/, 'the script never pre-checks the switch');
  assert.match(script, /this\.loopPoller = setInterval|PX\.loopPoller = setInterval/, 'the page polls for new messages');
  assert.match(script, /function pxPlayClips/, 'and plays the synthesized segments');
  assert.match(script, /window\.pxOnProactiveMessage/, 'and hands spoken messages to the host page');
});

test('candidates come from facts, and only from facts', () => {
  const midday = new Date(2026, 8, 30, 12, 5, 0);

  // Present now + nothing said for an hour + just after the 12:30 hook → all three sources.
  const rich = buildProactiveCandidates({
    now: new Date(2026, 8, 30, 12, 35, 0),
    presence: { present: true, updatedAt: '2026-09-30T04:30:00.000Z' },
    lastUserTurnAt: new Date(2026, 8, 30, 11, 0, 0),
    inConversation: false,
  });
  const triggers = rich.map((plan) => plan.candidate.trigger);
  assert.ok(triggers.includes('presence_arrived'), `在场到达 must be a source: ${JSON.stringify(triggers)}`);
  assert.ok(triggers.includes('conversation_dangling'), `长时间没人说话 must be a source: ${JSON.stringify(triggers)}`);
  assert.ok(triggers.includes('future_hook_due'), `时间钩子 must be a source: ${JSON.stringify(triggers)}`);
  for (const plan of rich) {
    assert.ok(plan.line.length > 0, 'every candidate can actually say something');
    assert.ok(plan.fact.length > 0, 'and says which fact it is based on');
    assert.ok(Object.keys(plan.candidate.components).length > 0, 'with §15.4 components, never an empty score');
    assert.ok(plan.candidate.candidateId.startsWith(`loop-${plan.candidate.trigger}-`), 'the id is what makes re-delivery impossible');
    assert.equal(plan.segments.join(''), plan.line, 'M4: the segments are the line, not a summary of it');
  }

  // Nothing to go on: no presence reading, a turn two minutes ago, no hook in window.
  const empty = buildProactiveCandidates({ now: midday, presence: null, lastUserTurnAt: new Date(2026, 8, 30, 12, 3, 0), inConversation: false });
  assert.equal(empty.length, 0, 'without a fact there is no candidate — nothing is invented');

  // A fresh store has no turns at all: that is still a fact (silence), not a guess.
  const fresh = buildProactiveCandidates({ now: midday, presence: null, lastUserTurnAt: null, inConversation: false });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.candidate.trigger, 'conversation_dangling');
  assert.match(fresh[0]?.fact ?? '', /还没有轮次/);

  // The hook window is 30 minutes wide, and the hooks are documented minutes.
  for (const hook of PROACTIVE_CLOCK_HOOKS) {
    const inside = buildProactiveCandidates({ now: new Date(2026, 8, 30, Math.floor(hook.minutes / 60), hook.minutes % 60, 0), presence: null, lastUserTurnAt: midday, inConversation: false });
    assert.ok(inside.some((plan) => plan.candidate.trigger === 'future_hook_due'), `hook ${formatClockMinutes(hook.minutes)} should fire`);
    const outside = buildProactiveCandidates({ now: new Date(2026, 8, 30, Math.floor((hook.minutes + 31) / 60) % 24, (hook.minutes + 31) % 60, 0), presence: null, lastUserTurnAt: midday, inConversation: false });
    assert.ok(!outside.some((plan) => plan.candidate.trigger === 'future_hook_due'), `hook ${formatClockMinutes(hook.minutes)} should stop after 30 minutes`);
  }
  assert.ok(PROACTIVE_DANGLING_AFTER_MINUTES >= 5, 'the silence threshold is a documented, sane number');
});

test('a tick speaks when the gates allow it, and reports the auditable path', async () => {
  const root = tempDir('xixi-t70-allowed-');
  const store = openXixiStore({ dataDir: root });
  try {
    const now = new Date(2026, 8, 30, 15, 0, 0);
    let synthesized: string[] = [];
    const loop = makeLoop({
      store,
      now,
      present: true,
      lastUserTurnAt: new Date(2026, 8, 30, 14, 0, 0),
      synthesize: async (text) => {
        synthesized.push(text);
        return Buffer.from(`wav:${text}`);
      },
    });
    const entry = await loop.tickOnce();
    assert.ok(entry !== null, 'a tick with a fact available must produce an entry');
    assert.equal(entry.speak, true, `expected the gates to allow it, got ${entry.reasonCode}`);
    assert.equal(entry.reasonCode, 'PASSED');
    assert.ok(entry.score >= entry.threshold, `${entry.score} >= ${entry.threshold}`);
    assert.equal(entry.trigger, 'presence_arrived');
    assert.ok(entry.text !== null && entry.text.length > 0, 'and there is something to say');
    assert.equal(entry.segments.join(''), entry.text, 'spoken as the engine segmented it');
    assert.ok((entry.audio ?? []).length === entry.segments.length, 'one synthesized clip per segment');
    assert.deepEqual(synthesized, [...entry.segments], 'each segment was synthesized separately (not one clip split later)');
    assert.equal(entry.audioNote, null, 'and there is nothing to explain away');
    assert.ok((entry.audio ?? []).every((clip) => clip !== null && clip.length > 0), 'the clips are really there');
    assert.equal(entry.gates.filter((row) => row.status === 'blocked').length, 0);
    assert.ok(entry.fact.includes('present'), 'the entry says which fact it came from');

    // The decision is in the log, so the spoken message is auditable after the fact.
    const decisions = store.readEvents({ type: 'proactive.decision', limit: 10 });
    assert.equal(decisions.length, 1);
    assert.equal((decisions[0]?.payload as Record<string, unknown>)['speak'], true);

    // Same candidate again: the engine refuses to repeat it, and the loop does not speak twice.
    const second = await loop.tickOnce();
    assert.notEqual(second?.reasonCode, 'PASSED', 'the same candidate must not be delivered twice');
    assert.equal(loop.entries().filter((row) => row.speak).length, 1, 'only one spoken entry');
    assert.equal(store.readEvents({ type: 'proactive.decision', limit: 10 }).filter((event) => (event.payload as Record<string, unknown>)['speak'] === true).length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('a blocked tick names the first gate that fired, in Chinese', async () => {
  const root = tempDir('xixi-t70-blocked-');
  const store = openXixiStore({ dataDir: join(root, 'main') });
  const quietStore = openXixiStore({ dataDir: join(root, 'quiet') });
  try {
    const now = new Date(2026, 8, 30, 15, 0, 0);
    // Only the weak 「长时间没人说话」 candidate is available (score 0.30 < threshold 0.54).
    const loop = makeLoop({ store, now, present: null, lastUserTurnAt: new Date(2026, 8, 30, 14, 0, 0) });
    const entry = await loop.tickOnce();
    assert.ok(entry !== null);
    assert.equal(entry.speak, false);
    assert.equal(entry.reasonCode, 'SCORE_BELOW_THRESHOLD', `got ${entry.reasonCode}`);
    assert.equal(entry.reasonLabel, '分数没到阈值');
    assert.ok(entry.nextStep.length > 0, 'and the page can tell the user what to do');
    assert.equal(entry.segments.length, 0, 'nothing is spoken when blocked');
    assert.equal(entry.audio, null);
    const blocked = entry.gates.filter((row) => row.status === 'blocked');
    assert.equal(blocked.length, 1, 'exactly one gate is reported as blocking');
    assert.equal(blocked[0]?.code, 'SCORE_BELOW_THRESHOLD');
    assert.ok(entry.gates.filter((row) => row.status === 'skipped').length > 0, 'later gates are marked not-evaluated');

    // Quiet hours block even a strong candidate — the safety floor is untouched by the loop.
    const quiet = makeLoop({
      store: quietStore,
      now,
      present: true,
      lastUserTurnAt: new Date(2026, 8, 30, 14, 0, 0),
      settings: parseProactiveSettings({ enabled: true, base_cooldown_min: 0, quiet_hours: { start: '00:00', end: '23:59' } }),
    });
    const quietEntry = await quiet.tickOnce();
    assert.equal(quietEntry?.speak, false);
    assert.equal(quietEntry?.reasonCode, 'QUIET_HOURS');
    assert.match(quietEntry?.nextStep ?? '', /静默时段/);
  } finally {
    store.close();
    quietStore.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('with the switch off nothing is considered, and with no key the missing audio is explained', async () => {
  const root = tempDir('xixi-t70-off-');
  const store = openXixiStore({ dataDir: join(root, 'main') });
  const noKeyStore = openXixiStore({ dataDir: join(root, 'nokey') });
  try {
    const now = new Date(2026, 8, 30, 15, 0, 0);
    const off = makeLoop({ store, now, present: true, settings: parseProactiveSettings({ enabled: false }) });
    const offEntry = await off.tickOnce();
    assert.equal(offEntry?.speak, false);
    assert.equal(offEntry?.reasonCode, 'DISABLED');
    assert.equal(offEntry?.audio, null);
    assert.equal(store.readEvents({ type: 'proactive.decision', limit: 10 }).length, 0, 'a switched-off engine logs no decision');

    const noKey = makeLoop({ store: noKeyStore, now, present: true, synthesize: undefined });
    const noKeyEntry = await noKey.tickOnce();
    assert.equal(noKeyEntry?.speak, true, 'the gates still allow it');
    assert.equal(noKeyEntry?.audio, null);
    assert.match(noKeyEntry?.audioNote ?? '', /没有可用密钥|朗读关闭/, 'the page is told why there is no voice');
  } finally {
    store.close();
    noKeyStore.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('the interval is bounded, and the loop can be started and stopped', async () => {
  const root = tempDir('xixi-t70-interval-');
  const store = openXixiStore({ dataDir: root });
  try {
    const loop = makeLoop({ store, now: new Date(), present: null, lastUserTurnAt: new Date(), intervalMs: 1 });
    assert.equal(loop.intervalMs, MIN_LOOP_INTERVAL_MS, 'a page cannot hammer the gates faster than the floor');
    assert.equal(loop.running, false, 'constructed stopped');
    loop.start(Number.NaN);
    assert.equal(loop.running, true);
    assert.equal(loop.intervalMs, DEFAULT_LOOP_INTERVAL_MS, 'a nonsense interval falls back to the default');
    // `start` immediately ticks once; let that settle so the test does not end mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 50));
    loop.stop();
    assert.equal(loop.running, false);
    loop.start(DEFAULT_LOOP_INTERVAL_MS);
    assert.equal(loop.status().running, true);
    assert.ok(loop.status().intervalMs === DEFAULT_LOOP_INTERVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, 50));
    loop.stop();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('lastUserTurnAt reads the fact from the log, and only user turns count', () => {
  const root = tempDir('xixi-t70-lastturn-');
  const store = openXixiStore({ dataDir: root });
  try {
    const session = store.createSession();
    assert.equal(lastUserTurnAt(store, session.sessionId), null, 'a fresh store has no turns');
    const turn = (role: 'user' | 'assistant', text: string, timestamp: string, turnIndex: number) =>
      buildEvent({
        event_type: 'conversation.turn',
        source: 'test',
        actor: role === 'user' ? 'father' : 'xixi',
        confidence: 1,
        session_id: session.sessionId,
        timestamp,
        payload: { session_id: session.sessionId, turn_index: turnIndex, role, text, action: 'SPEAK' },
      });
    store.appendEvent(turn('assistant', '我在。', toOffsetIso(new Date(2026, 8, 30, 6, 0, 0)), 0));
    assert.equal(lastUserTurnAt(store, session.sessionId), null, 'an assistant turn is not 「你上次说话」');
    store.appendEvent(turn('user', '你好', toOffsetIso(new Date(2026, 8, 30, 6, 5, 0)), 1));
    assert.equal(lastUserTurnAt(store, session.sessionId)?.getTime(), new Date(2026, 8, 30, 6, 5, 0).getTime());
    assert.equal(lastUserTurnAt(store, 'sess_someone_else'), null, 'another session does not count');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('the trial page runs the same loop, and a spoken message lands in its conversation log', { timeout: 90_000 }, async () => {
  const root = tempDir('xixi-t70-web-');
  const child = spawn(process.execPath, ['scripts/serve-chat.ts', '--fake', '--no-tts', '--port', '0'], {
    cwd: REPO_ROOT,
    env: { ...process.env, XIXI_WEB_DATA_DIR: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { out += chunk; });
  child.stderr.on('data', (chunk: string) => { out += chunk; });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve-chat 没有打印端口：\n${out}`)), 60_000);
    const check = (): void => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match !== null) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    check();
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('px-loop-enabled'), 'the trial page carries the loop switch');
    assert.ok(html.includes('window.pxOnProactiveMessage'), 'and the hook that puts a spoken message into the log');

    const initial = (await (await fetch(`${base}/api/proactive/loop`)).json()) as Record<string, any>;
    assert.equal(initial.status.running, false, 'off by default here too');
    assert.equal(initial.tts.available, false, '--no-tts / no key: the page is told it will not speak');

    const ticked = (await (await fetch(`${base}/api/proactive/loop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'tick' }) })).json()) as Record<string, any>;
    assert.equal(ticked.ok, true);
    assert.equal(ticked.entries.length, 1);
    assert.ok(typeof ticked.entries[0].reasonCode === 'string');
    assert.ok(ticked.entries[0].fact.length > 0, 'with its fact, so the page can show why');
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('the console serves the loop over HTTP, off by default, with a readable action error', { timeout: 60_000 }, async () => {
  const root = tempDir('xixi-t70-http-');
  const handle = await createFieldServer({
    port: 0,
    offline: true,
    ttsEnabled: false,
    voiceDir: join(root, 'voice'),
    dataDir: join(root, 'data'),
    presenceDataDir: join(root, 'presence'),
    reportDir: join(root, 'recon'),
    autoPrune: false,
    probeRunner: createFakeProbeRunner(),
    log: () => {},
  });
  const post = async (path: string, body: unknown): Promise<Record<string, any>> =>
    (await (await fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json()) as Record<string, any>;
  try {
    const page = await (await fetch(handle.url)).text();
    assert.ok(page.includes('px-loop-enabled'), 'the console page carries the loop switch');
    assert.ok(page.includes('pxPlayClips'), 'and the audio player');

    const initial = (await (await fetch(`${handle.url}/api/field/proactive/loop`)).json()) as Record<string, any>;
    assert.equal(initial.status.running, false, 'the loop is off until asked');
    assert.equal(initial.status.ticks, 0);
    assert.equal(initial.minIntervalMs, MIN_LOOP_INTERVAL_MS);
    assert.equal(initial.tts.available, false, 'offline: no TTS available, and the payload says so');
    assert.match(String(initial.tts.note), /只显示文字/);

    const ticked = await post('/api/field/proactive/loop', { action: 'tick' });
    assert.equal(ticked.ok, true);
    assert.equal(ticked.status.ticks, 1);
    assert.equal(ticked.entries.length, 1, 'the tick produced one record (spoken or blocked)');
    const entry = ticked.entries[0];
    assert.ok(typeof entry.reasonCode === 'string' && entry.reasonCode.length > 0);
    assert.ok(typeof entry.fact === 'string' && entry.fact.length > 0, 'every record carries its fact');
    assert.ok(Array.isArray(entry.gates) && entry.gates.length > 0, 'and the gate table');

    // A cursor means each entry is handed to the page exactly once.
    const drained = (await (await fetch(`${handle.url}/api/field/proactive/loop?cursor=${ticked.cursor}`)).json()) as Record<string, any>;
    assert.equal(drained.entries.length, 0, 'already-seen entries are not replayed');

    const started = await post('/api/field/proactive/loop', { action: 'start', intervalMs: 5_000 });
    assert.equal(started.status.running, true);
    assert.equal(started.status.intervalMs, 5_000);
    const stopped = await post('/api/field/proactive/loop', { action: 'stop' });
    assert.equal(stopped.status.running, false);

    const bogus = await post('/api/field/proactive/loop', { action: 'dance' });
    assert.equal(bogus.ok, false);
    assert.match(String(bogus.error.message), /不认识的循环操作/);
    assert.match(String(bogus.error.hint), /start/);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});
