import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
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

/** One sink call: when it was dispatched, when it finished, and in which order. */
export interface SinkEvent {
  readonly kind: 'start' | 'finish';
  readonly index: number;
  readonly atMs: number;
  /** 1-based position in the **synchronously recorded** log — the resolution-free ordering evidence. */
  readonly seq: number;
}

/**
 * The property 「clause 2 is dispatched while clause 1 is still synthesizing」, asserted from
 * recorded events.
 *
 * Why it is written this way (t15): the first version compared two `Date.now()` readings
 * (`started[0].atMs < started[1].atMs`). Both sinks are invoked from the same synchronous turn of
 * the event loop, so **half the runs put them in the same millisecond** and the assertion failed —
 * measured: 6 of 12 consecutive runs red with `1790982509710 < 1790982509710`. Clock resolution is
 * not the property we care about, and a test must not depend on it.
 *
 * Two independent readings replace it:
 *   * **order** — a `seq` counter, incremented synchronously at the top of each sink call. It cannot
 *     be affected by millisecond rounding, and a pipeline that dispatched clause 2 first is caught
 *     by it;
 *   * **overlap** — the real gap between the two calls. Clause 1 is held for `slowMs`, clause 2
 *     finishes in ~1 ms, so 「clause 2 started while clause 1 was still running」 is a **hundreds of
 *     milliseconds** fact; the threshold below is 200 ms, which tolerates ordinary jitter and still
 *     fails loudly for a serial pipeline (its clause 2 starts only after clause 1 ends).
 *
 * Nothing here sleeps to make flakiness go away, retries, or relaxes a timeout: the slow clause is
 * the *input* of the experiment (a TTS call that takes time is the normal case), and both readings
 * are of facts the pipeline either has or does not have.
 */
export function assertClauseOverlap(events: readonly SinkEvent[], options: { readonly slowMs: number; readonly clauses: number }): void {
  const starts = events.filter((event) => event.kind === 'start');
  const finishes = events.filter((event) => event.kind === 'finish');
  const first = starts[0];
  const second = starts[1];
  const firstFinish = finishes.find((event) => event.index === 0);

  assert.ok(first !== undefined && second !== undefined, `expected the sink to be called at least twice, got ${starts.length}`);
  // ① Order, without any clock: the seq counter is assigned before the first await.
  assert.equal(first.index, 0, 'clause 1 was dispatched first');
  assert.equal(second.index, 1, 'and clause 2 second');
  assert.ok(first.seq < second.seq, `dispatch order by sequence: clause 1 (seq ${first.seq}) before clause 2 (seq ${second.seq})`);
  // …and the same fact the other way round: swapping the two dispatches would invert these indices.
  assert.deepEqual(starts.map((event) => event.index), [0, 1], 'no dispatch overtook another');
  // ② Overlap, with a gap far larger than any plausible jitter (see the doc comment).
  assert.ok(firstFinish !== undefined, 'clause 1 finished');
  assert.ok(
    second.atMs < firstFinish.atMs - 200,
    `clause 2 must start while clause 1 is still synthesizing: clause 2 at ${second.atMs}, clause 1 finished at ${firstFinish.atMs} (held for ${options.slowMs} ms)`,
  );
  // ③ …and each clause reached the playback seam exactly once, in order.
  assert.equal(finishes.length, options.clauses, 'every clause finished');
}

test('clause 2 is dispatched while clause 1 is still synthesizing (event-order + overlap evidence)', async () => {
  // t13/t15: the test above asserts texts and a call count — it says nothing about *when* the second
  // dispatch happened, so a serial pipeline would pass it too. This one holds clause 1 in flight and
  // records an ordered event log.
  const slowMs = 320;
  const events: SinkEvent[] = [];
  let seq = 0;
  let index = 0;
  const { payload, seam } = await runStreamingTurn({
    synthesizeProvider: () => async () => {
      const mine = index;
      index += 1;
      events.push({ kind: 'start', index: mine, atMs: Date.now(), seq: (seq += 1) });
      await new Promise((resolve) => setTimeout(resolve, mine === 0 ? slowMs : 1));
      events.push({ kind: 'finish', index: mine, atMs: Date.now(), seq: (seq += 1) });
      return wavOf(300);
    },
  });

  assertClauseOverlap(events, { slowMs, clauses: 2 });
  assert.equal(seam.length, 2, 'and the seam delivered exactly those clauses');
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

/* ---------------------------------------------------------------------------------------
 * t20: exactly one clause event per clause on the real route (B1 blocker)
 * ------------------------------------------------------------------------------------- */

/**
 * A local MiMo stub, inlined here on purpose (t20).
 *
 * Why a stub is needed to drive `/api/voice` offline: `--fake` swaps the **brain** only, while ASR
 * and TTS still go through `MimoClient`. So (a) `client.hasKey` gates the streaming sink and (b)
 * `client.transcribe` needs a socket. Pointing the child at this stub (via
 * `startTrialPage({ ttsBaseUrl })`, i.e. `MIMO_BASE_URL`) gives it a real ASR and a real per-clause
 * TTS call with **no network and nothing that costs money**, so the NDJSON the browser actually
 * receives can be asserted instead of inferred. It lives in this file rather than its own module so
 * that the whole t20 fix stays inside the task's declared paths.
 */
interface TtsStub {
  readonly base: string;
  /** One entry per TTS request, in arrival order: the text the server asked to synthesize. */
  readonly ttsTexts: readonly string[];
  /** Byte length of the WAV every TTS call returns, so payload sizes can be compared exactly. */
  readonly wavBytes: number;
  stop: () => Promise<void>;
}

/** The audio every TTS call returns — a real, parseable, signed-in fixture. */
const STUB_WAV = readFileSync(`${REPO_ROOT}/tests/audio-fixtures/bot-reply-fixture.wav`);

async function startTtsStub(): Promise<TtsStub> {
  const ttsTexts: string[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      const answer = (payload: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (raw.includes('mimo-v2.5-tts')) {
        let text = '';
        try {
          const body = JSON.parse(raw) as { messages?: { content?: unknown }[] };
          const content = body.messages?.[0]?.content;
          text = typeof content === 'string' ? content : '';
        } catch {
          text = '(unparsable request)';
        }
        ttsTexts.push(text);
        answer({ model: 'mimo-v2.5-tts', choices: [{ message: { audio: { data: STUB_WAV.toString('base64') } } }] });
        return;
      }
      // The ASR response: a sentence long enough that the chunker produces more than one clause.
      answer({ model: 'mimo-v2.5-asr', choices: [{ message: { content: '西西，明天天气怎么样？' } }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    ttsTexts,
    wavBytes: STUB_WAV.length,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface ClauseSummary {
  /** The `index` of every `clause` event, in the order the browser received them. */
  readonly indices: readonly number[];
  /** Bytes of audio the wire carried (base64-decoded), summed over the clause events. */
  readonly sentBytes: number;
  readonly sentBytesPerIndex: ReadonlyMap<number, number>;
  /** How many times `xixiSpeakClause` would run — once per clause event, this page has no dedupe. */
  readonly playCalls: number;
  readonly eventTypes: readonly string[];
  readonly endClauses: number | null;
  /** Bytes of the stitched WAV on `end` (decoded): what one single-blob playback would consume. */
  readonly stitchedBytes: number;
}

function summarizeClauses(events: readonly Record<string, unknown>[]): ClauseSummary {
  const indices: number[] = [];
  const sentBytesPerIndex = new Map<number, number>();
  let sentBytes = 0;
  for (const event of events) {
    if (event['type'] !== 'clause') continue;
    const index = Number(event['index']);
    const audio = typeof event['audio'] === 'string' ? event['audio'] : '';
    const bytes = Buffer.from(audio, 'base64').length;
    indices.push(index);
    sentBytes += bytes;
    sentBytesPerIndex.set(index, bytes);
  }
  const end = events.find((event) => event['type'] === 'end');
  const stitched = typeof end?.['audio'] === 'string' ? (end['audio'] as string) : '';
  return {
    indices,
    sentBytes,
    sentBytesPerIndex,
    playCalls: indices.length,
    eventTypes: events.map((event) => String(event['type'])),
    endClauses: end === undefined || end['clauses'] === undefined || end['clauses'] === null ? null : Number(end['clauses']),
    stitchedBytes: Buffer.from(stitched, 'base64').length,
  };
}

/** Drive a real `/api/voice` and return the NDJSON events exactly as the browser receives them. */
async function streamVoiceOnce(base: string): Promise<{ readonly status: number; readonly events: readonly Record<string, unknown>[] }> {
  const wav = readFileSync(`${REPO_ROOT}/tests/audio-fixtures/direct-question.wav`);
  const response = await fetch(`${base}/api/voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: wav.toString('base64'), speak: true }),
  });
  const text = await response.text();
  const events = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { status: response.status, events };
}

test('the real /api/voice route sends each clause exactly once (t20, B1)', async () => {
  // The bug this pins: `onClause` wrote every clause event, and then `voiceStreamEvents` wrote them
  // all **again** from the same array — the browser got `[0,1,0,1]` for a two-clause reply while
  // `end.clauses` said 2. The page plays on every `clause` event with no dedupe, so each chunk of
  // audio was spoken twice and the wire carried double the bytes.
  const stub = await startTtsStub();
  const dataDir = mkdtempSync(join(tmpdir(), 'xixi-t20-route-'));
  const page = await startTrialPage({
    dataDir,
    tts: true,
    env: { MIMO_API_KEY: 'sk-test-not-used' },
    ttsBaseUrl: stub.base,
  });
  try {
    const { status, events } = await streamVoiceOnce(page.base);
    assert.equal(status, 200, `route failed: ${page.output().slice(-400)}`);
    const summary = summarizeClauses(events);

    // ① One event per clause, in playback order — and the count agrees with the payload.
    assert.ok(summary.indices.length > 0, `expected clause events, got ${summary.eventTypes.join(',')}`);
    assert.equal(new Set(summary.indices).size, summary.indices.length, `a clause index was sent twice: ${summary.indices.join(',')}`);
    assert.deepEqual(summary.indices, [...summary.indices].sort((left, right) => left - right), 'and in ascending order');
    assert.deepEqual(summary.indices, summary.indices.map((_, position) => position), 'indices start at 0 and are contiguous');
    assert.equal(summary.endClauses, summary.indices.length, 'end.clauses is the truth the wire must match');
    assert.equal(summary.playCalls, summary.endClauses, 'so the page calls xixiSpeakClause once per clause');
    // ② The browser plays exactly the bytes the server synthesized — no more. Per-clause audio is the
    //    raw WAV the stub returned, so the sum of the sent bytes equals the stub's WAV times the
    //    number of clauses; the stitched blob on `end` is that audio **plus one 44-byte header per
    //    concatenation**, which is why the comparison adds those headers instead of comparing totals.
    const perClauseWav = stub.wavBytes;
    for (const [index, bytes] of summary.sentBytesPerIndex) {
      assert.equal(bytes, perClauseWav, `clause ${index} carried ${bytes} bytes, expected one WAV (${perClauseWav})`);
    }
    //    The stitched blob on `end` is the same audio glued together (it is for a caller that wants
    //    one WAV; the page never plays it), so it must stay within a couple of headers of the total —
    //    if clause audio had gone out twice, `sentBytes` would be exactly twice the WAV size.
    assert.equal(summary.sentBytes, perClauseWav * summary.indices.length, `sent bytes must be ${summary.indices.length} WAVs, not twice that`);
    assert.ok(
      Math.abs(summary.stitchedBytes - summary.sentBytes) <= 44 * (summary.indices.length + 1),
      `stitched ${summary.stitchedBytes} vs sent ${summary.sentBytes} differ by more than the concatenation headers`,
    );
    assert.equal(stub.ttsTexts.length, summary.indices.length, `one TTS call per clause: ${JSON.stringify(stub.ttsTexts)}`);

    // ③ The turn event still carries no audio at all (that is what would make the browser wait).
    const turn = events.find((event) => event['type'] === 'turn');
    assert.ok(turn !== undefined, 'a turn event is emitted');
    assert.equal(turn?.['audio'], null);
    assert.equal(turn?.['clauseAudio'], null);
  } finally {
    await page.stop();
    stub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a mapper that is told everything was already sent emits no clause event (t20 partition)', () => {
  // The pure half of the same rule: the two writers must partition the clauses, so a mapper told that
  // `onClause` already wrote them all stays silent on the clause channel — and still stitches the
  // audio for `end`, which is how a single-blob caller keeps its WAV.
  const clauses = [
    { index: 0, text: '好的，我记住了。', audio: wavOf(700).toString('base64'), durationMs: 700, synthMs: 190 },
    { index: 1, text: '明天可能有雨。', audio: wavOf(900).toString('base64'), durationMs: 900, synthMs: 210 },
  ];
  const result = { ok: true, reply: '好的，我记住了。明天可能有雨。', action: 'SPEAK', stream: { enabled: true, ttsSegments: 2, errors: [] } };
  const shared = { result, clauses, segments: ['好的，我记住了。', '明天可能有雨。'], segmentGapMs: 450, ttsMode: 'streaming' as const };

  const allSent = voiceStreamEvents({ ...shared, sentClauses: 2 });
  assert.deepEqual(allSent.map((event) => event['type']), ['turn', 'end'], 'the hook owned every clause');
  const end = allSent.find((event) => event['type'] === 'end');
  assert.ok(typeof end?.['audio'] === 'string' && (end['audio'] as string).length > 0, 'the stitched WAV still travels');

  const noneSent = voiceStreamEvents({ ...shared, sentClauses: 0 });
  assert.deepEqual(noneSent.filter((event) => event['type'] === 'clause').map((event) => event['index']), [0, 1], 'a mapper on its own still sends every clause');

  const oneSent = voiceStreamEvents({ ...shared, sentClauses: 1 });
  assert.deepEqual(oneSent.filter((event) => event['type'] === 'clause').map((event) => event['index']), [1], 'and picks up exactly where the hook stopped');

  // Out-of-range counts must not invent or drop clauses (the wire total is what matters).
  assert.deepEqual(voiceStreamEvents({ ...shared, sentClauses: 99 }).map((event) => event['type']), ['turn', 'end']);
  assert.deepEqual(voiceStreamEvents({ ...shared, sentClauses: -3 }).filter((event) => event['type'] === 'clause').map((event) => event['index']), [0, 1]);
});
