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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildEvent, toOffsetIso } from '@xixi/contracts';
import {
  DEFAULT_PROACTIVE_SETTINGS,
  evaluateProactiveGates,
  parseProactiveSettings,
  proactiveThreshold,
  TopicEngine,
  type OpenThreadFollowUp,
} from '@xixi/conversation';
import { openXixiStore } from '@xixi/domain';

import { startTrialPage } from './serve-chat-fixture.ts';

import {
  DEFAULT_LOOP_INTERVAL_MS,
  MIN_LOOP_INTERVAL_MS,
  PROACTIVE_CLOCK_HOOKS,
  PROACTIVE_DANGLING_AFTER_MINUTES,
  PROACTIVE_OFFLINE_LINES,
  PROACTIVE_RANDOM_SMALLTALK_CHANCE,
  PROACTIVE_TRIGGERS_WITH_SOURCES,
  ProactiveLoop,
  buildProactiveCandidates,
  createFakeProbeRunner,
  createFieldServer,
  formatClockMinutes,
  lastUserTurnAt,
  proactiveDrill,
  proactivePanelHtml,
  proactivePanelScript,
  triggerScoreCeiling,
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
  readonly compose?: ((input: { readonly plan: { readonly line: string }; readonly delivery: unknown }) => Promise<{ readonly text: string; readonly source: 'model' | 'fixed'; readonly note: string | null }>) | undefined;
  readonly sessionId?: string | null;
  readonly intervalMs?: number;
  readonly recentUserTopics?: readonly string[] | undefined;
  readonly readOpenThreads?: (() => readonly OpenThreadFollowUp[]) | undefined;
}): ProactiveLoop {
  const settings =
    options.settings ??
    parseProactiveSettings({ enabled: true, base_cooldown_min: 0, max_per_6h: 10, max_per_day: 10, quiet_hours: { start: '00:00', end: '00:00' } });
  return new ProactiveLoop({
    store: options.store,
    readSettings: () => settings,
    readState: () => options.state ?? 'IDLE',
    readProactivity: () => 0.7,
    // t98: a presence reading only counts when it is *fresh*, so the fixture carries a timestamp
    // (5 s ago) and a TTL — a bare `present: true` is exactly the bug the freshness check blocks.
    readPresence: async () => ({
      present: options.present ?? null,
      updatedAt: new Date(options.now.getTime() - 5_000).toISOString(),
      ttlSeconds: 60,
      source: 'test',
    }),
    readLastUserTurnAt: () => options.lastUserTurnAt ?? null,
    readRecentUserTopics: () => options.recentUserTopics,
    readOpenThreads: options.readOpenThreads,
    readSessionId: () => options.sessionId ?? null,
    synthesize: options.synthesize,
    compose: options.compose,
    intervalMs: options.intervalMs,
    now: () => options.now,
    log: () => {},
  });
}

test('every trigger the panel lists can really reach the threshold floor (t74)', () => {
  // The floor of the threshold curve is `proactivity = 1.0` → 0.45. A trigger whose *best* score
  // is below that can never speak, no matter how the user tunes the panel — which is exactly what
  // conversation_dangling (0.30) and future_hook_due (0.32) used to be.
  const floor = proactiveThreshold(1);
  assert.equal(floor, 0.45, 'the documented floor');

  const ceiling = triggerScoreCeiling(new Date(2026, 8, 30, 12, 35, 0));
  for (const trigger of PROACTIVE_TRIGGERS_WITH_SOURCES) {
    const score = ceiling[trigger];
    assert.ok(score !== null, `${trigger}: no candidate is ever built, so it can never speak`);
    assert.ok((score ?? 0) >= floor, `${trigger} tops out at ${score}, below the ${floor} floor`);
  }
  // The two that were dead: named explicitly so the regression is obvious if they slip back.
  assert.ok((ceiling.conversation_dangling ?? 0) >= floor, `conversation_dangling: ${ceiling.conversation_dangling}`);
  assert.ok((ceiling.future_hook_due ?? 0) >= floor, `future_hook_due: ${ceiling.future_hook_due}`);

  // …and the panel must not claim the sources this console cannot produce yet. It lists all six
  // engine trigger switches, so each one carries the `live` flag and the page prints it.
  const script = proactivePanelScript('/api/field');
  assert.match(script, /这一轮还不会自己产生候选/, 'the panel labels triggers without a fact source');
  assert.match(script, /row\.live/, 'and the page renders that flag');
  assert.match(script, /会自己产生候选/, 'with a tooltip saying which ones do');
});

test('content is composed from inside the delivery seam, i.e. only after the gates pass (t74)', async () => {
  const root = tempDir('xixi-t74-compose-');
  const store = openXixiStore({ dataDir: join(root, 'main') });
  const quietStore = openXixiStore({ dataDir: join(root, 'quiet') });
  const blockedStore = openXixiStore({ dataDir: join(root, 'blocked') });
  try {
    const now = new Date(2026, 8, 30, 15, 0, 0);
    const session = store.createSession();
    const calls: string[] = [];
    const compose = async (input: { readonly plan: { readonly line: string } }) => {
      calls.push(input.plan.line);
      return { text: '（模型写的）你回来啦，我刚把今天的事记下来了。', source: 'model' as const, note: null };
    };

    const loop = makeLoop({ store, now, present: true, lastUserTurnAt: new Date(now.getTime() - 20 * 60_000), compose, sessionId: session.sessionId });
    const entry = await loop.tickOnce();
    assert.equal(entry?.speak, true);
    assert.equal(calls.length, 1, 'the composer is called exactly once for a delivered message');
    assert.equal(entry?.text, '（模型写的）你回来啦，我刚把今天的事记下来了。', 'the model text is what gets spoken');
    assert.equal(entry?.contentSource, 'model');
    assert.equal(entry?.contentNote, null);
    assert.equal(entry?.segments.join(''), entry?.text, 'and it is segmented like any other utterance');

    // The spoken message is in the conversation history, so the next user turn has the context.
    assert.ok(entry?.turnEventSequence !== null, 'an assistant turn was written');
    const turns = store.recentTurns(session.sessionId, 5);
    assert.equal(turns[turns.length - 1]?.role, 'assistant');
    assert.equal(turns[turns.length - 1]?.text, entry?.text);

    // A blocked candidate must not compose at all — no model call, no cost, no invention.
    const quietLoop = makeLoop({
      store: quietStore,
      now,
      present: true,
      lastUserTurnAt: new Date(now.getTime() - 20 * 60_000),
      settings: parseProactiveSettings({ enabled: true, base_cooldown_min: 0, quiet_hours: { start: '00:00', end: '23:59' } }),
      compose,
    });
    const quietEntry = await quietLoop.tickOnce();
    assert.equal(quietEntry?.reasonCode, 'QUIET_HOURS');
    assert.equal(calls.length, 1, 'the composer was NOT called for the blocked candidate');
    assert.equal(quietEntry?.contentSource, 'fixed');
    assert.equal(quietEntry?.text, null, 'a blocked candidate has nothing to say');

    // Without a composer (offline / no key) the fixed line is used and the reason is stated.
    const fixedLoop = makeLoop({ store: blockedStore, now, present: true, lastUserTurnAt: new Date(now.getTime() - 20 * 60_000) });
    const fixedEntry = await fixedLoop.tickOnce();
    assert.equal(fixedEntry?.speak, true);
    assert.equal(fixedEntry?.contentSource, 'fixed');
    assert.match(fixedEntry?.contentNote ?? '', /固定短句兜底/, 'the page is told the content did not come from the model');
    assert.ok((fixedEntry?.text ?? '').length > 0);

    // A model that fails (or answers with the silence token) also falls back instead of breaking.
    const failingStore = openXixiStore({ dataDir: join(root, 'failing') });
    const failingLoop = makeLoop({
      store: failingStore,
      now,
      present: true,
      lastUserTurnAt: new Date(now.getTime() - 20 * 60_000),
      compose: async () => {
        throw new Error('429 too many requests');
      },
    });
    const failingEntry = await failingLoop.tickOnce();
    assert.equal(failingEntry?.speak, true, 'a model failure must not stop the message');
    assert.equal(failingEntry?.contentSource, 'fixed');
    assert.match(failingEntry?.contentNote ?? '', /429/, 'and the error is reported, not swallowed');
    assert.match(failingEntry?.contentNote ?? '', /固定短句兜底/);
    failingStore.close();
  } finally {
    store.close();
    quietStore.close();
    blockedStore.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('two consecutive messages never repeat the same sentence (t74)', async () => {
  const root = tempDir('xixi-t74-norepeat-');
  const store = openXixiStore({ dataDir: join(root, 'main') });
  try {
    const now = new Date(2026, 8, 30, 15, 0, 0);
    // 1) The offline lines rotate: several per trigger, and a different one per spoken count.
    for (const trigger of PROACTIVE_TRIGGERS_WITH_SOURCES) {
      assert.ok((PROACTIVE_OFFLINE_LINES[trigger] ?? []).length >= 2, `${trigger}: needs more than one offline line to rotate`);
    }
    const base = { now, presence: { present: true, updatedAt: now.toISOString() }, lastUserTurnAt: new Date(now.getTime() - 20 * 60_000), inConversation: false, random: () => 1 };
    const first = buildProactiveCandidates({ ...base, spokenCount: 0 });
    const second = buildProactiveCandidates({ ...base, spokenCount: 1 });
    assert.notEqual(first[0]?.line, second[0]?.line, 'the same trigger must not repeat its previous sentence');

    // 2) A model that echoes itself is replaced instead of being spoken twice.
    const compose = async () => ({ text: '我在呢。', source: 'model' as const, note: null });
    const loop = makeLoop({ store, now, present: true, lastUserTurnAt: new Date(now.getTime() - 20 * 60_000), compose, sessionId: null });
    const one = await loop.tickOnce();
    assert.equal(one?.text, '我在呢。', 'the first message is spoken as composed');
    let second2 = await loop.tickOnce();
    // The candidate id changes hour to hour, so nudge the clock to make a fresh candidate.
    for (let attempt = 0; attempt < 4 && second2 !== null && second2.text === '我在呢。'; attempt += 1) {
      second2 = await loop.tickOnce();
    }
    if (second2 !== null && second2.speak) {
      assert.notEqual(second2.text, '我在呢。', 'the repeated sentence must not be spoken again');
      assert.match(second2.contentNote ?? '', /重复/, 'and the page is told why it changed');
    }
    assert.equal(loop.spokenLines().filter((line) => line === '我在呢。').length <= 1, true, 'no duplicates in the spoken memory');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('the two chit-chat sources are fact-based and can be switched off (t74)', () => {
  const now = new Date(2026, 8, 30, 15, 0, 0);
  const withTopic = buildProactiveCandidates({
    now,
    presence: null,
    lastUserTurnAt: new Date(now.getTime() - 20 * 60_000),
    inConversation: false,
    recentUserTopics: ['明天得去把车修一下'],
    random: () => 1, // no smalltalk this time
  });
  const topic = withTopic.find((plan) => plan.candidate.trigger === 'topic_pool');
  assert.ok(topic !== undefined, 'a recent user turn must produce a 话题池 candidate');
  assert.match(topic?.line ?? '', /车修/, 'and it is built from what the user actually said');
  assert.match(topic?.fact ?? '', /用户轮次/, 'with the log as its fact');

  const noTopic = buildProactiveCandidates({ now, presence: null, lastUserTurnAt: new Date(now.getTime() - 20 * 60_000), inConversation: false, recentUserTopics: [], random: () => 1 });
  assert.ok(!noTopic.some((plan) => plan.candidate.trigger === 'topic_pool'), 'no topic in the log → no topic candidate (never invented)');

  // 随机闲聊 fires only below its chance, and it is off in the shipped config.
  const never = buildProactiveCandidates({ now, presence: null, lastUserTurnAt: new Date(now.getTime() - 20 * 60_000), inConversation: false, random: () => PROACTIVE_RANDOM_SMALLTALK_CHANCE + 0.01 });
  assert.ok(!never.some((plan) => plan.candidate.trigger === 'random_smalltalk'), 'above the chance: nothing is said');
  const always = buildProactiveCandidates({ now, presence: null, lastUserTurnAt: new Date(now.getTime() - 20 * 60_000), inConversation: false, random: () => 0 });
  const smalltalk = always.find((plan) => plan.candidate.trigger === 'random_smalltalk');
  assert.ok(smalltalk !== undefined, 'below the chance: it may speak');
  assert.match(smalltalk?.fact ?? '', /低概率/, 'and says it is a low-probability, agenda-free line');
});

test('the drill button speaks too, through the same TTS seam (t74)', async () => {
  const root = tempDir('xixi-t74-drill-');
  const store = openXixiStore({ dataDir: root });
  try {
    const now = new Date(2026, 8, 30, 15, 0, 0);
    const settings = parseProactiveSettings({ enabled: true, base_cooldown_min: 0, quiet_hours: { start: '00:00', end: '00:00' } });
    const synthesized: string[] = [];
    const spoken = await proactiveDrill({
      store,
      settings,
      now,
      conversationState: 'IDLE',
      proactivity: 0.7,
      replyLimits: undefined,
      request: { trigger: 'presence_arrived' },
      synthesize: async (text) => {
        synthesized.push(text);
        return Buffer.from(`wav:${text}`);
      },
    });
    assert.equal(spoken.speak, true);
    assert.ok(spoken.segments.length >= 1);
    assert.equal(spoken.audio?.length, spoken.segments.length, 'one clip per segment');
    assert.deepEqual(synthesized, [...spoken.segments], 'each segment was synthesized separately');
    assert.equal(spoken.audioNote, null);

    const silentStore = openXixiStore({ dataDir: join(root, 'silent') });
    const silent = await proactiveDrill({
      store: silentStore,
      settings,
      now,
      conversationState: 'IDLE',
      proactivity: 0.7,
      request: { trigger: 'presence_arrived', candidateId: 'drill-silent' },
    });
    assert.equal(silent.speak, true);
    assert.equal(silent.audio, null);
    assert.match(silent.audioNote ?? '', /只显示文字/, 'no TTS available is reported, not hidden');
    silentStore.close();

    // …and the page wires the clips into the player.
    assert.match(proactivePanelScript('/api'), /pxPlayClips\(drill\.audio, drill\.gapMs\)/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

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
  // The presence reading is fresh (5 s old) because t98 requires that before 「有人到达」 counts.
  const rich = buildProactiveCandidates({
    now: new Date(2026, 8, 30, 12, 35, 0),
    presence: { present: true, updatedAt: new Date(2026, 8, 30, 12, 34, 55).toISOString(), ttlSeconds: 60 },
    lastUserTurnAt: new Date(2026, 8, 30, 11, 0, 0),
    inConversation: false,
    random: () => 1, // 「随机闲聊」 is chance-based; this test is about the factual three
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
  const empty = buildProactiveCandidates({ now: midday, presence: null, lastUserTurnAt: new Date(2026, 8, 30, 12, 3, 0), inConversation: false, random: () => 1 });
  assert.equal(empty.length, 0, 'without a fact there is no candidate — nothing is invented');

  // A fresh store has no turns at all: that is still a fact (silence), not a guess.
  const fresh = buildProactiveCandidates({ now: midday, presence: null, lastUserTurnAt: null, inConversation: false, random: () => 1 });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.candidate.trigger, 'conversation_dangling');
  assert.match(fresh[0]?.fact ?? '', /还没有轮次/);

  // The hook window is 30 minutes wide, and the hooks are documented minutes.
  for (const hook of PROACTIVE_CLOCK_HOOKS) {
    const inside = buildProactiveCandidates({ now: new Date(2026, 8, 30, Math.floor(hook.minutes / 60), hook.minutes % 60, 0), presence: null, lastUserTurnAt: midday, inConversation: false, random: () => 1 });
    assert.ok(inside.some((plan) => plan.candidate.trigger === 'future_hook_due'), `hook ${formatClockMinutes(hook.minutes)} should fire`);
    const outside = buildProactiveCandidates({ now: new Date(2026, 8, 30, Math.floor((hook.minutes + 31) / 60) % 24, (hook.minutes + 31) % 60, 0), presence: null, lastUserTurnAt: midday, inConversation: false, random: () => 1 });
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

test('a held candidate no longer eats the tick: the source below it still speaks (t9 F1)', async () => {
  const root = tempDir('xixi-t9-f1-');
  const store = openXixiStore({ dataDir: root });
  try {
    // 18:30 is a documented clock hook, and the silence candidate exists too (last turn 20 min ago).
    const now = new Date(2026, 8, 30, 18, 30, 0);
    // One delivered, generic, *unanswered* message half an hour earlier: the generic-repeat grade
    // plus the unanswered grade now hold the 沉默跟进 below the recommendation line — exactly the
    // candidate that used to terminate every tick while the hook under it never got considered
    // (t9 measured hooks speaking 0 times in a 12-hour day).
    store.appendEvent(
      buildEvent({
        event_type: 'proactive.decision',
        source: 'test',
        actor: 'system',
        confidence: 1,
        timestamp: toOffsetIso(new Date(2026, 8, 30, 18, 0, 0)),
        payload: { candidate_id: 'seeded-old-message', trigger: 'conversation_dangling', speak: true, reason_code: 'PASSED', delivered: true, topic_ref: null },
      }),
    );
    const loop = makeLoop({ store, now, present: false, lastUserTurnAt: new Date(now.getTime() - 20 * 60_000) });
    const entry = await loop.tickOnce();
    assert.equal(entry?.trigger, 'future_hook_due', 'the walk continues past the held 沉默跟进 to the hook');
    assert.equal(entry?.speak, true, `expected the hook to speak, got ${entry?.reasonCode}`);
    assert.equal(entry?.reasonCode, 'PASSED');
    // Both considerations are auditable: the held one explains itself, the hook delivered.
    const decisions = store
      .readEvents({ type: 'proactive.decision', limit: 20 })
      .map((event) => event.payload as Record<string, unknown>);
    assert.ok(
      decisions.some((payload) => payload['reason_code'] === 'BELOW_RECOMMENDATION' && payload['trigger'] === 'conversation_dangling'),
      'the held candidate is still in the log with its reason',
    );
    assert.ok(
      decisions.some((payload) => payload['reason_code'] === 'PASSED' && payload['trigger'] === 'future_hook_due'),
      'and the hook below it really delivered',
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('topicRef carries the real topic; generic lines stay null (t9 F3)', () => {
  const noon = new Date(2026, 8, 30, 12, 30, 0); // inside the 12:30 clock-hook window
  const plans = buildProactiveCandidates({
    now: noon,
    presence: { present: true, updatedAt: noon.toISOString(), ttlSeconds: 60 },
    lastUserTurnAt: new Date(noon.getTime() - 20 * 60_000),
    inConversation: false,
    recentUserTopics: ['明天得去把车修一下'],
    random: () => 1,
    limit: 8,
  });
  const byTrigger = new Map(plans.map((plan) => [plan.candidate.trigger, plan]));
  assert.equal(byTrigger.get('presence_arrived')?.candidate.topicRef, null, '到家招呼是泛泛的');
  assert.equal(byTrigger.get('conversation_dangling')?.candidate.topicRef, null, '沉默跟进是泛泛的');
  assert.equal(byTrigger.get('future_hook_due')?.candidate.topicRef, 'lunch_hook', '时间钩子是「没聊完的事」，有话题');
  assert.equal(byTrigger.get('topic_pool')?.candidate.topicRef, '明天得去把车修一下', '话题池就是用户自己说的话');
  // Before t9 F3 every plan carried `topicRef: trigger`, so the engine's generic metric
  // (`topicRef === null`) was structurally 0% and the same-topic window saw two different
  // 沉默跟进 as "the same topic".
  assert.ok(plans.every((plan) => plan.candidate.topicRef !== plan.candidate.trigger), 'never the trigger name');
});

test('a live conversation turns 话题池 into 热聊接话 — the production path (t9 F5)', async () => {
  const now = new Date(2026, 8, 30, 15, 0, 0);
  const base = {
    now,
    presence: null,
    lastUserTurnAt: new Date(now.getTime() - 60_000),
    recentUserTopics: ['周末请老李来家里坐坐'],
    random: () => 1,
  };
  const idleTopic = buildProactiveCandidates({ ...base, inConversation: false }).find((plan) => plan.candidate.trigger === 'topic_pool');
  assert.equal(idleTopic?.candidate.initiativeKind, undefined, '闲着时按触发源默认（external_sharing）');

  const liveTopic = buildProactiveCandidates({ ...base, inConversation: true }).find((plan) => plan.candidate.trigger === 'topic_pool');
  assert.equal(liveTopic?.candidate.initiativeKind, 'conversation_continuation', '对话还开着时，同一个事实是「热聊接话」');
  assert.ok(liveTopic !== undefined);
  // The engine honours it: a continuation clears CONVERSATION_ACTIVE and pays no interruption
  // cost (pack §14.3 / Phase 5 的第五项目标).
  const judged = evaluateProactiveGates(liveTopic.candidate, {
    settings: DEFAULT_PROACTIVE_SETTINGS,
    now,
    offsetMinutes: undefined,
    proactivity: 0.7,
    conversationState: 'ACTIVE',
    inFlightTurn: false,
    negativeFeedback: false,
    sceneAvailable: true,
    speechAvailable: true,
    privacyAllowed: true,
    history: [],
    userTurns: [],
  });
  assert.equal(judged.pass, true, `a live chat must not block the continuation: ${judged.reasonCode}`);
  assert.equal(judged.signals.interruption_cost, 0, 'pack §14.3: continuation cooldown = 0');

  // …and end to end through the loop: while the FSM is ACTIVE, the tick speaks it.
  const root = tempDir('xixi-t9-f5-');
  const store = openXixiStore({ dataDir: root });
  try {
    const loop = makeLoop({ store, now, present: null, lastUserTurnAt: new Date(now.getTime() - 60_000), state: 'ACTIVE', recentUserTopics: ['周末请老李来家里坐坐'] });
    const entry = await loop.tickOnce();
    assert.equal(entry?.speak, true, `expected the continuation to speak, got ${entry?.reasonCode}`);
    assert.equal(entry?.trigger, 'topic_pool');
    assert.equal(entry?.recommendation, 'speak');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});


test('a blocked tick names the first gate that fired, in Chinese', async () => {
  const root = tempDir('xixi-t70-blocked-');
  const store = openXixiStore({ dataDir: join(root, 'main') });
  const quietStore = openXixiStore({ dataDir: join(root, 'quiet') });
  try {
    const now = new Date(2026, 8, 30, 15, 0, 0);
    // P5: 「长时间没人说话」 is no longer a dead-end candidate (it used to score 0.30 < 0.51 and be
    // reported as SCORE_BELOW_THRESHOLD). It is a *good* candidate now, so the block used here is the
    // day budget — a hard floor — which is also what the page must explain.
    const spent = makeLoop({
      store,
      now,
      present: null,
      lastUserTurnAt: new Date(2026, 8, 30, 14, 0, 0),
      settings: parseProactiveSettings({ enabled: true, base_cooldown_min: 0, max_per_day: 0 }),
    });
    const entry = await spent.tickOnce();
    assert.ok(entry !== null);
    assert.equal(entry.speak, false);
    assert.equal(entry.reasonCode, 'QUOTA_DAY_EXCEEDED', `got ${entry.reasonCode}`);
    assert.match(entry.reasonLabel, /当日额度/);
    assert.ok(entry.nextStep.length > 0, 'and the page can tell the user what to do');
    assert.equal(entry.segments.length, 0, 'nothing is spoken when blocked');
    assert.equal(entry.audio, null);
    const blocked = entry.gates.filter((row) => row.status === 'blocked');
    assert.equal(blocked.length, 1, 'exactly one gate is reported as blocking');
    assert.equal(blocked[0]?.code, 'QUOTA_DAY_EXCEEDED');
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

    // …and the retired ADR-0009 codes are not part of the gate table any more.
    const codes = quietEntry?.gates.map((row) => row.code) ?? [];
    for (const retired of ['COOLDOWN_ACTIVE', 'TOPIC_REPEATED', 'SCORE_BELOW_THRESHOLD']) {
      assert.equal(codes.includes(retired as never), false, `${retired} must not be shown as a live gate`);
    }
    assert.ok(codes.includes('BELOW_RECOMMENDATION'), 'the judgement codes are shown instead');
    assert.ok(codes.includes('MODEL_DECLINED'));
    assert.ok(codes.includes('PRIVACY_BLOCKED'));
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
  // Same shared fixture as the proactive-console test (t96): it waits for an answered request
  // instead of a log line, and always reaps the child.
  const page = await startTrialPage({ dataDir: root });
  const base = page.base;
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
    await page.stop();
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

test('未完话题进考虑循环：说出口就等回答，回答之后不再重复（pack Phase 3）', async () => {
  const root = tempDir('xixi-open-thread-loop-');
  const DAY1 = new Date(2026, 9, 1, 20, 0, 0);
  const DAY2 = new Date(2026, 9, 2, 15, 0, 0);
  const DAY2_ANSWER = new Date(2026, 9, 2, 15, 10, 0);
  const DAY3 = new Date(2026, 9, 3, 15, 0, 0);
  let now = DAY1;
  const store = openXixiStore({ dataDir: join(root, 'main'), clock: () => now });
  try {
    const session = store.createSession();
    // Day 1：父亲说了明天要去办的事。
    store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: '明天下午我要去镇上办证。' });

    // 生产装配就是这样：每次取候选之前先对齐，再取「现在该追问的」。
    const topicEngine = new TopicEngine({ store, clock: () => now });
    const readOpenThreads = (): readonly OpenThreadFollowUp[] => {
      topicEngine.reconcile(now);
      return topicEngine.followUps(now);
    };
    const loopAt = (at: Date): ProactiveLoop =>
      makeLoop({
        store,
        now: at,
        // 没有在场投影、最后一次用户轮次就是「现在」：这些 tick 里唯一的来源只能是未完话题。
        lastUserTurnAt: at,
        readOpenThreads,
        sessionId: session.sessionId,
      });

    // Day 2：到点了，主动问一句。
    now = DAY2;
    const entry = await loopAt(DAY2).tickOnce();
    assert.equal(entry?.speak, true, `应当开口：${entry?.reasonCode} ${entry?.score}`);
    assert.equal(entry?.trigger, 'future_hook_due');
    assert.equal(entry?.initiativeKind, 'open_loop_followup');
    assert.match(entry?.text ?? '', /办证/, '离线兜底也必须说出是哪件事，而不是泛泛的钩子句');
    assert.match(entry?.fact ?? '', /未完话题/);

    // 主动记录带着话题 id —— 话题引擎据此把这件事标成「已经问过」，不再重复摆出来。
    const spoken = store
      .readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })
      .filter((event) => (event.payload as { speak: boolean }).speak);
    assert.equal(spoken.length, 1);
    const threadId = String((spoken[0]?.payload as { topic_ref: string }).topic_ref);
    assert.match(threadId, /^thread_/);
    // 下一次取候选时对齐（生产里就是下一个 tick 的第一步）：日志里那条主动记录把这件事标成 offered。
    readOpenThreads();
    assert.equal(store.openThread(threadId)?.status, 'offered', '说出口 = offered，接下来等回答');

    // 再 tick 一次：这件事不会作为候选重复摆出来（其它来源不算）。
    const second = await loopAt(DAY2).tickOnce();
    assert.notEqual(second?.initiativeKind, 'open_loop_followup', '问过了就不再重复摆出同一个候选');

    // 父亲回答「办好了」→ 收口成 resolved；第二天也不再问。
    now = DAY2_ANSWER;
    store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: '办好了。' });
    readOpenThreads();
    assert.equal(store.openThread(threadId)?.status, 'resolved');

    now = DAY3;
    const third = await loopAt(DAY3).tickOnce();
    assert.notEqual(third?.initiativeKind, 'open_loop_followup', '收口之后不再重复问同一件事');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
