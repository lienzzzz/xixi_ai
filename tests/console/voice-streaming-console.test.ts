import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { fixedClock, openXixiStore, type XixiStore } from '@xixi/domain';

import { buildFieldPage, handleVoiceTurn, readCalibration, retentionPolicy, segmentTtsNote, silenceWav, type VoiceDeps } from '../../scripts/field-test.ts';
import { voiceStreamEvents } from '../../scripts/serve-chat.ts';
import { loadConfig, REPO_ROOT } from '../../scripts/lib/harness.ts';
import { readWavInfo } from '../../scripts/lib/wav.ts';
import { startTrialPage } from './serve-chat-fixture.ts';

/**
 * Pack Phase 8 on the **production** voice path: `handleVoiceTurn` with a streaming TTS sink.
 *
 * What the offline tests here can and cannot show:
 *   * can — the reply is really spoken **clause by clause**, clause 1 is dispatched without
 *     waiting for clause 2's synthesis (latency must not grow with the reply), the clause audio
 *     is stitched into the same single-WAV contract the console already consumes, the timings
 *     the page displays are the pipeline's own clock, and a clause that fails is reported;
 *   * cannot — how long a real MiMo TTS call takes. That is measured by
 *     `node scripts/voice-turn.ts --legacy-tts` against real audio (see the task report).
 *
 * The wiring is injected through `VoiceDeps.vad` / `asr` / `speakStream`, so no Python and no
 * network are needed: the same shape the existing console tests use. The store is a real one in
 * a temp directory (the engine reads `self_profile` and writes the event log; a fake that only
 * looked like a store would make these tests pass while the production path was broken).
 */
const openStores: XixiStore[] = [];
const tempDirs: string[] = [];

function depsWith(overrides: Partial<VoiceDeps> = {}): VoiceDeps {
  const config = loadConfig();
  const root = mkdtempSync(join(tmpdir(), 'xixi-t3-voice-'));
  tempDirs.push(root);
  const store = openXixiStore({ dbPath: join(root, 'x.sqlite'), clock: fixedClock(new Date(), 1_000) });
  openStores.push(store);
  store.seedSelfProfile(config.personality.base);
  const session = store.createSession();
  // A multi-clause scripted reply: one sentence would be a single clause and would say nothing
  // about clause-by-clause behaviour. The second sentence is deliberately longer than the first
  // so 「首段」 and 「整段」 cannot be confused in the timings.
  const engine = new ConversationEngine({
    adapter: new FakeBrainAdapter({ reply: () => ({ action: 'SPEAK', text: '好的，我记住了。明天可能有雨，出门记得带把伞，路滑慢点走。' }) }),
    store,
    config,
  });
  return {
    python: join(REPO_ROOT, '.venvs', 'voice-pipecat', 'Scripts', 'python.exe'),
    voiceDir: join(root, 'voice'),
    // Counted, so a turn that synthesizes more than once per clause is visible.
    client: {
      synthesize: async (text: string) => wavOf(500),
    } as unknown as VoiceDeps['client'],
    engine,
    currentSessionId: () => session.sessionId,
    ttsEnabled: true,
    policy: { keepSpeechSegments: false, speechRetentionDays: 1 } as VoiceDeps['policy'],
    asr: async () => '西西，明天天气怎么样？',
    vad: async () => ({ segments: [{ startMs: 0, endMs: 1200, durationMs: 1200, endpointDelayMs: 512 }], durationMs: 1500 }) as never,
    log: () => {},
    ...overrides,
  };
}

/** One clause as the incremental seam hands it over. */
interface SeamClause {
  readonly index: number;
  readonly text: string;
  readonly audio: string;
  readonly durationMs: number;
  readonly synthMs: number | null;
  readonly audioAtMs: number;
  /** Wall clock when the seam received it — the ordering evidence (t13). */
  readonly atMs: number;
}

/**
 * One voice turn through the production handler, with a counted TTS sink, a counted direct
 * `client.synthesize`, and the incremental `onClause` seam captured.
 *
 * Both counters are returned instead of being module state, so no test can pass because of another
 * test's calls. The point of counting is the t11 finding that `streamVoice` synthesized every
 * clause a second time: 「TTS 调用次数 == 块数」 is only an assertion if somebody counts.
 */
async function runStreamingTurn(options: {
  readonly text?: string;
  readonly wavMs?: number;
  readonly overrides?: Partial<VoiceDeps>;
  readonly synthesize?: (text: string) => Buffer;
  /** Async variant for timing tests (a `Promise`-returning sink). Wins over `synthesize`. */
  readonly synthesizeProvider?: () => (text: string) => Promise<Buffer>;
} = {}): Promise<{
  readonly payload: Awaited<ReturnType<typeof handleVoiceTurn>>;
  readonly sinkCalls: readonly string[];
  readonly wholeReplyCalls: readonly string[];
  readonly seam: readonly SeamClause[];
}> {
  const sinkCalls: string[] = [];
  const directCalls: string[] = [];
  const seam: SeamClause[] = [];
  const asyncSink = options.synthesizeProvider?.();
  const deps = depsWith({
    ...options.overrides,
    client: {
      synthesize: async (text: string) => {
        directCalls.push(text);
        return wavOf(options.wavMs ?? 500);
      },
    } as unknown as VoiceDeps['client'],
    speakStream: async ({ text }) => {
      sinkCalls.push(text);
      if (asyncSink !== undefined) return asyncSink(text);
      return options.synthesize === undefined ? wavOf(options.wavMs ?? Math.max(400, text.length * 100)) : options.synthesize(text);
    },
    onClause: async (clause) => {
      seam.push({ ...clause, atMs: Date.now() });
    },
  });
  const payload = await handleVoiceTurn(deps, { audioBase64: silenceWav(900).toString('base64') });
  return { payload, sinkCalls, wholeReplyCalls: directCalls, seam };
}

test.after(() => {
  for (const store of openStores) store.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A 16 kHz WAV of `durationMs`, so the pipeline's duration probe has something real to read. */
function wavOf(durationMs: number): Buffer {
  const samples = Math.round((durationMs / 1000) * 16_000);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

test('a voice turn streams clause by clause through the production handler (pack Phase 8)', async () => {
  const { payload, sinkCalls, wholeReplyCalls, seam } = await runStreamingTurn({
    synthesize: (text) => wavOf(Math.max(400, text.length * 100)),
  });

  assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 300));
  assert.ok(payload.reply !== null, 'the fake adapter replied');

  // ① It really spoke in clauses, and the reply covers the whole reply text.
  assert.ok(payload.stream !== null, 'the stream report is present when a sink is wired');
  assert.ok((payload.stream?.ttsSegments ?? 0) >= 1, `expected at least one clause, got ${payload.stream?.ttsSegments}`);
  const spoken = payload.stream?.clauses ?? [];
  assert.equal(spoken.length, sinkCalls.length, 'every clause is one sink call');
  // t11: 「TTS 调用次数 == 块数」. Both halves matter — one call per clause from the sink, and
  // NOT a second call per clause from anywhere else (the bug this assertion exists for: the
  // server used to synthesize each clause again when writing the NDJSON events).
  assert.equal(sinkCalls.length, spoken.length, 'TTS 调用次数 == 块数（sink 侧）');
  assert.deepEqual(wholeReplyCalls, [], 'and nothing synthesizes the whole reply (or a clause) a second time');
  assert.deepEqual(spoken.map((clause) => clause.text), sinkCalls, 'the clauses sent to TTS are the ones reported');
  assert.deepEqual(spoken.map((clause) => clause.index), spoken.map((_clause, index) => index), 'indices are 0..n-1 in order');
  assert.ok(spoken.every((clause) => clause.text.trim().length > 0), 'no empty clause is sent to TTS');
  assert.equal(spoken.some((clause) => clause.reason === 'flush' || clause.reason === 'sentence' || clause.reason === 'pause' || clause.reason === 'max'), true);

  // ② The turn payload carries **counts and timings only** — no base64 audio anywhere on it
  // (t13). The clause audio travels through `onClause`, one clause at a time; an audio blob on the
  // turn object would mean the browser received everything at once and could not start speaking
  // before the reply ended.
  const turnJson = JSON.stringify(payload);
  assert.doesNotMatch(turnJson, /"audio"\s*:\s*"[A-Za-z0-9+/=]{100,}"/, 'no base64 blob anywhere on the payload');
  for (const clause of spoken) {
    assert.equal((clause as Record<string, unknown>)['audio'], undefined, `clause ${clause.index} must not carry audio on the payload`);
    assert.equal(typeof clause.durationMs, 'number');
  }
  void turnJson;

  // …and the same audio does arrive through the incremental seam, once per clause, in order, as a
  // real WAV. This is the seam a streaming server writes to the socket clause by clause.
  assert.equal(seam.length, spoken.length, 'the seam delivered one entry per clause');
  assert.deepEqual(seam.map((entry) => entry.index), spoken.map((clause) => clause.index), 'and in playback order');
  assert.deepEqual(seam.map((entry) => entry.text), spoken.map((clause) => clause.text), 'with the clause texts');
  for (const entry of seam) {
    const decoded = Buffer.from(entry.audio, 'base64');
    assert.ok(decoded.length > 44, `clause ${entry.index} delivered no audio bytes`);
    assert.equal(Math.round(readWavInfo(decoded).durationMs), entry.durationMs, `clause ${entry.index} audio length disagrees with its report`);
  }

  // ③ The payload carries no stitched blob when the seam is registered (the audio already went out
  // clause by clause); a caller that does not register the seam still gets the single WAV — that
  // fallback is asserted in the "without a streaming sink" test below.
  assert.equal(payload.audio, null, 'seam mode: no stitched blob on the turn payload');
  assert.ok(seam.length > 0 && seam.every((entry) => entry.audio.length > 0), 'the audio travelled on the seam instead');

  // ④ The timings come from the pipeline's clock: clause 1's audio is known, and ③/④ are filled.
  assert.ok(payload.stream?.firstClauseTextMs !== null && payload.stream?.firstClauseTextMs !== undefined);
  assert.ok((payload.stream?.firstClauseAudioMs ?? -1) >= 0);
  assert.ok((payload.stream?.fourStage.firstTokenToFirstAudioMs ?? -1) >= 0, 'stage ③ is measured');
  assert.ok((payload.stream?.fourStage.totalToFirstAudioMs ?? -1) >= 512, 'stage ④ includes the endpoint hold');
  assert.equal(payload.stream?.fourStage.vadEndToAsrFinalMs, payload.asrMs);
  assert.deepEqual(payload.stream?.errors, []);
});

test('the first clause does not wait for the rest of the reply', async () => {
  const { payload, sinkCalls, wholeReplyCalls } = await runStreamingTurn({
    synthesize: () => wavOf(300),
    overrides: {},
  });
  assert.ok((payload.stream?.ttsSegments ?? 0) >= 2, `expected >= 2 clauses, got ${payload.stream?.ttsSegments}`);
  assert.equal(sinkCalls.length, payload.stream?.ttsSegments, 'one call per clause');
  assert.deepEqual(wholeReplyCalls, [], 'the server never synthesizes a second time');
  assert.deepEqual(
    payload.stream?.clauses.map((clause) => clause.text),
    ['好的，我记住了。', '明天可能有雨，出门记得带把伞，路滑慢点走。'],
    'the clauses are the chunker’s, in reply order',
  );
});

test('clause 2 is dispatched while clause 1 is still synthesizing (start/end evidence)', async () => {
  // t13: the test above asserts texts and a call count — it says nothing about *when* the second
  // dispatch happened, so a serial pipeline would have passed it too. This run holds clause 1 in
  // flight (80 ms) and records the start and end instants of each sink call: clause 2 must have been
  // dispatched **inside** clause 1's window.
  const started: { index: number; atMs: number }[] = [];
  const finished: { index: number; atMs: number }[] = [];
  let index = 0;
  const { payload, seam } = await runStreamingTurn({
    synthesizeProvider: () => async (text: string) => {
      const mine = index;
      index += 1;
      started.push({ index: mine, atMs: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, mine === 0 ? 80 : 5));
      finished.push({ index: mine, atMs: Date.now() });
      void text;
      return wavOf(300);
    },
  });

  assert.ok(started.length >= 2, `expected the sink to be called at least twice, got ${started.length}`);
  assert.equal(seam.length, started.length, 'and the seam delivered exactly those clauses');
  assert.equal(started[0]?.index, 0, 'clause 1 went first');
  assert.equal(started[1]?.index, 1);
  // The evidence, in two independent readings of the same fact:
  const firstFinish = finished.find((entry) => entry.index === 0)?.atMs ?? 0;
  const secondStart = started.find((entry) => entry.index === 1)?.atMs ?? 0;
  assert.ok(
    (started[0]?.atMs ?? 0) < secondStart,
    `clause 2 started after clause 1 started (${started[0]?.atMs} < ${secondStart})`,
  );
  assert.ok(
    secondStart < firstFinish,
    `clause 2 was dispatched BEFORE clause 1 resolved (${secondStart} < ${firstFinish}) — a serial pipeline cannot do that`,
  );
  assert.ok((payload.stream?.ttsSegments ?? 0) >= 2);
});

test('the sink is never called when TTS is off, and the payload keeps its old shape', async () => {
  const { payload, sinkCalls, wholeReplyCalls } = await runStreamingTurn({ overrides: { ttsEnabled: false } });
  assert.equal(sinkCalls.length, 0, 'no TTS call at all with 朗读 off');
  assert.equal(wholeReplyCalls.length, 0);
  assert.equal(payload.audio, null);
  assert.equal(payload.ttsMs, null);
  assert.equal(payload.stream, null, 'and no stream report either');
});

test('a clause that fails to synthesize is reported and the turn still completes', async () => {
  const { payload, sinkCalls, wholeReplyCalls, seam } = await runStreamingTurn({
    synthesize: (text) => {
      if (text.startsWith('明天')) throw new Error('TTS 502');
      return wavOf(400);
    },
  });
  assert.equal(payload.ok, true, 'the turn is not lost because one clause failed');
  assert.ok((payload.stream?.errors.length ?? 0) >= 1, 'the failure is reported, not swallowed');
  assert.match(payload.stream?.errors[0] as string, /TTS 502/);
  const failed = payload.stream?.clauses.find((clause) => clause.index === 1);
  // t13: the payload no longer attaches audio to a clause at all, so the failure shows up in the
  // numbers instead — the clause *exists* (it was dispatched to TTS) with no bytes and no timestamp.
  // Nothing was delivered on the seam for it either, which is the other half of the same fact.
  assert.ok(failed !== undefined, 'the failed clause is still listed (it was dispatched to TTS)');
  assert.equal(failed?.bytes, 0, 'the failed clause produced no audio bytes');
  assert.equal(failed?.audioMs, null, 'and has no audio timestamp');
  assert.deepEqual(seam.map((entry) => entry.index), [0], 'only the successful clause reached the seam');
  assert.equal(sinkCalls.length, payload.stream?.ttsSegments, 'and still exactly one call per clause');
  assert.deepEqual(wholeReplyCalls, []);
});

test('without a streaming sink the handler keeps the whole-reply behaviour', async () => {
  const synthesized: string[] = [];
  const deps = depsWith({
    client: {
      synthesize: async (text: string) => {
        synthesized.push(text);
        return wavOf(500);
      },
    } as unknown as VoiceDeps['client'],
  });
  const payload = await handleVoiceTurn(deps, { audioBase64: silenceWav(900).toString('base64') });
  assert.equal(payload.stream, null, 'no stream report without a sink');
  assert.equal(synthesized.length, 1, 'exactly one call, with the whole reply');
  assert.equal(synthesized[0], payload.reply);
  assert.ok(payload.audio !== null);
  assert.ok(payload.ttsMs !== null);
});

test('a short acknowledgement does not take a turn on the voice entry (t11)', async () => {
  // 「嗯。」 is the case the VAD cannot see (docs/design/voice.md §2): the rule has to live in the
  // voice entry, before the transcript reaches the engine — otherwise a nod is answered with a
  // paragraph and the conversation state advances.
  const { payload, sinkCalls } = await runStreamingTurn({
    overrides: { asr: async () => '嗯。' },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.reason, 'ASSENT_ONLY', `expected the acknowledgement rule, got ${payload.reason}`);
  assert.equal(payload.accepted, false, 'no turn was taken');
  assert.equal(payload.reply, null, 'and she did not reply');
  assert.equal(payload.transcript, '嗯。', 'the words are still reported, so the page can say what it heard');
  assert.equal(payload.stream, null, 'no speech was produced');
  assert.equal(sinkCalls.length, 0, 'and no TTS call was spent on a nod');
  assert.match(payload.reasonText, /应和/, 'the reason is explained in Chinese');
});

test('a real sentence still takes a turn on the same path (t11)', async () => {
  // The counterfactual to the test above: the rule must not swallow ordinary speech.
  const { payload, sinkCalls } = await runStreamingTurn({
    overrides: { asr: async () => '西西，明天天气怎么样？' },
  });
  assert.notEqual(payload.reason, 'ASSENT_ONLY', 'the rule must not swallow a real sentence');
  assert.equal(payload.action, 'SPEAK');
  assert.ok(sinkCalls.length >= 1, 'and the reply was synthesized');
});

/* ---------------------------------------------------------------------------------------
 * t13: the wire format, and the two pages that have to agree with the server
 * ------------------------------------------------------------------------------------- */

test('the NDJSON mapping is pure: one clause event per clause, no synthesis, no blob on the turn', () => {
  const clauses = [
    { index: 0, text: '好的，我记住了。', audio: wavOf(700).toString('base64'), durationMs: 700, synthMs: 190 },
    { index: 1, text: '明天可能有雨。', audio: wavOf(900).toString('base64'), durationMs: 900, synthMs: 210 },
  ];
  const synthesizeCalls: string[] = [];
  const events = voiceStreamEvents({
    result: {
      ok: true,
      reply: '好的，我记住了。明天可能有雨。',
      action: 'SPEAK',
      audio: 'STITCHED-BLOB-THAT-MUST-NOT-SURVIVE',
      clauseAudio: [{ index: 0, audio: 'x' }],
      stream: { enabled: true, ttsSegments: 2, clauses: [{ index: 0, audio: 'y' }], errors: [], firstClauseAudioMs: 12 },
      stages: { ttsMs: 190 },
    },
    clauses,
    segments: ['好的，我记住了。', '明天可能有雨。'],
    segmentGapMs: 450,
    ttsMode: 'streaming',
    synthesize: (text) => {
      synthesizeCalls.push(text);
      return 'never';
    },
  });

  const clauseEvents = events.filter((event) => event['type'] === 'clause');
  assert.equal(clauseEvents.length, clauses.length, 'clause 事件数 == 块数');
  assert.deepEqual(clauseEvents.map((event) => event['index']), [0, 1], 'in playback order');
  for (const [position, event] of clauseEvents.entries()) {
    assert.equal(event['audio'], clauses[position]?.audio, '音频逐字相等');
    assert.equal(event['text'], clauses[position]?.text);
    assert.equal(event['ttsMs'], clauses[position]?.synthMs);
  }
  assert.deepEqual(synthesizeCalls, [], 'the mapper never synthesizes anything');

  const turn = events.find((event) => event['type'] === 'turn');
  assert.ok(turn !== undefined, 'a turn event is emitted');
  assert.equal(turn?.['audio'], null, 'no stitched blob on the turn event');
  assert.equal(turn?.['clauseAudio'], null, 'and no per-clause audio array either');
  assert.equal((turn?.['stream'] as { readonly ttsSegments?: number } | undefined)?.ttsSegments, 2, 'the count survives');
  assert.equal((turn?.['stream'] as Record<string, unknown> | undefined)?.['clauses'], undefined, 'the per-clause records do not');
  const turnText = JSON.stringify(turn);
  assert.doesNotMatch(turnText, /STITCHED-BLOB-THAT-MUST-NOT-SURVIVE/, 'the payload blob was dropped');
  assert.doesNotMatch(turnText, new RegExp(clauses[0]?.audio.slice(0, 40) ?? 'never'), 'no clause audio leaked onto the turn');
  assert.doesNotMatch(turnText, /"audio":"x"/, 'and not the per-clause array either');

  const end = events.find((event) => event['type'] === 'end');
  assert.ok(end !== undefined, 'an end event is emitted');
  assert.equal(end?.['clauses'], 2);
  assert.equal(end?.['ttsMode'], 'streaming');
  assert.ok(typeof end?.['audio'] === 'string' && (end['audio'] as string).length > 0, 'the stitched WAV travels on end, where a single-blob caller expects it');
});

test('the field-test console page calls the shared player and keeps no standalone reply playback', () => {
  const boot = {
    listen: '127.0.0.1:8792',
    offline: false,
    ttsEnabled: true,
    ttsMode: 'streaming' as const,
    modelConfigured: true,
    calibration: readCalibration('nope.json'),
    policy: retentionPolicy(loadConfig()),
    databasePath: join(REPO_ROOT, 'data', 'field-test'),
  };
  const page = buildFieldPage(boot);
  // The submit handler must go through the shared player (t13): that is what makes 「逐块播放」
  // reachable from the page at all.
  assert.match(page, /await playReplyAudio\(data\)/, 'the voice submit handler awaits playReplyAudio');
  assert.ok(page.includes('async function playReplyAudio(data)'), 'and the player itself is defined');
  assert.ok(page.includes('xixiSpeakClause'), 'and it speaks clause by clause through the shared browser rules');
  // No reply playback may bypass it. Two standalone `new Audio('data:audio/wav;base64,' + data.audio)`
  // calls remain on purpose, and both are fallbacks rather than the reply path:
  //   * one inside `playReplyAudio` itself (single-blob payloads, e.g. a console with no sink);
  //   * one in the **typed-text** route, which has no clause stream at all.
  const strayReplyPlayback = page.split('\n').filter((line) => /new Audio\('data:audio\/wav;base64,' \+ data\.audio\)/.test(line));
  assert.equal(
    strayReplyPlayback.length,
    2,
    `expected exactly the two documented fallbacks, got:\n${strayReplyPlayback.join('\n')}`,
  );
  const voiceHandler = page.slice(page.indexOf('async function stopRecording'), page.indexOf('async function runAcceptance'));
  assert.doesNotMatch(voiceHandler, /new Audio\('data:audio\/wav;base64,' \+ data\.audio\)/, 'the voice route must not play the reply itself');
  // …and the page agrees with the server about granularity for this boot.
  assert.ok(page.includes(segmentTtsNote('streaming')), 'a streaming boot renders the streaming note');
  assert.doesNotMatch(page, /整条回复一次合成/, 'and never the stale whole-reply claim');
});

test('both entries say the same granularity as the boot they were served with (t13)', async () => {
  const config = loadConfig();
  for (const ttsMode of ['streaming', 'whole-reply'] as const) {
    const page = buildFieldPage({
      listen: '127.0.0.1:8792',
      offline: false,
      ttsEnabled: true,
      ttsMode,
      modelConfigured: true,
      calibration: readCalibration('nope.json'),
      policy: retentionPolicy(config),
      databasePath: join(REPO_ROOT, 'data', 'field-test'),
    });
    assert.ok(page.includes(segmentTtsNote(ttsMode)), `the console page must render segmentTtsNote('${ttsMode}')`);
    assert.ok(
      !page.includes(segmentTtsNote(ttsMode === 'streaming' ? 'whole-reply' : 'streaming')),
      `and must not render the other mode's note ('${ttsMode}')`,
    );
  }

  // The trial page is served from a real process: with a key and 朗读 on it must claim streaming,
  // with neither it must say there is no sound. Nothing here hits `/api/voice`, so the fake key is
  // never used for a request — it only decides which sink the process installs.
  const dataDir = mkdtempSync(join(tmpdir(), 'xixi-t13-trial-'));
  const streamingPage = await startTrialPage({ dataDir, tts: true, env: { MIMO_API_KEY: 'sk-test-not-used' } });
  try {
    const html = await (await fetch(`${streamingPage.base}/`)).text();
    const state = (await (await fetch(`${streamingPage.base}/api/state`)).json()) as { segmentPlayback?: { mode?: string; ttsSegmented?: boolean; note?: string } };
    assert.equal(state.segmentPlayback?.mode, 'streaming', `expected a streaming trial page, got ${state.segmentPlayback?.mode}`);
    assert.equal(state.segmentPlayback?.ttsSegmented, true);
    assert.equal(state.segmentPlayback?.note, segmentTtsNote('streaming'));
    assert.ok(html.includes(segmentTtsNote('streaming')), 'the served page says the same thing as its state payload');
    assert.doesNotMatch(html, /整条回复一次合成/);
  } finally {
    await streamingPage.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
