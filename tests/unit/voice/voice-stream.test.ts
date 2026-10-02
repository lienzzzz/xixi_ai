import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { readWavInfo } from '../../../scripts/lib/wav.ts';
import {
  ASSENT_CLIPS,
  AssentBank,
  decideAssent,
  decideBargeIn,
  fourStageLatency,
  isShortAcknowledgementOnly,
  pauseWindows,
  percentiles,
  playbackStateAt,
  PlaybackTimeline,
  SpeechPipeline,
  truncateOnBargeIn,
  XIXI_PLAYBACK_JS,
  XIXI_PLAYBACK_THRESHOLDS,
  type SynthesizedClause,
} from '../../../services/voice-edge/voice_edge/voice_stream.ts';

/**
 * Pack Phase 8: the streaming voice path, tested offline.
 *
 * Three acceptance-relevant behaviours are pinned here, all with an injected clock and a fake
 * synthesizer — no API, no audio device, no browser:
 *
 *   ① 首音 — the first clause is dispatched to TTS as soon as it exists (not after the whole
 *      reply), clause two is dispatched while clause one is still synthesizing, and playback
 *      order always equals generation order;
 *   ② 打断 — `PlaybackTimeline.abort()` stops at a known position, drops exactly the un-played
 *      clauses, and `decideBargeIn` refuses to treat a 「嗯」-length sound as an interruption;
 *   ③ backchannel — the clip is placed at a pause in the user's own speech, costs one TTS call
 *      per clip ever, and a user's own 「嗯」 does not close their turn.
 */

/** A WAV the size of `durationMs` at 16 kHz mono 16-bit — enough for `readWavInfo`. */
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

const durationOf = (wav: Buffer | Uint8Array): number => readWavInfo(Buffer.from(wav)).durationMs;

/** A clock the test advances by hand, so latency is asserted, not slept through. */
function testClock(start = 1_000): { now: () => number; advance: (ms: number) => number } {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

/* ---------------------------------------------------------------------------------------
 * ① Streaming: first clause out first
 * ------------------------------------------------------------------------------------- */

test('the first clause reaches TTS before the reply is finished, and in order', async () => {
  const clock = testClock();
  const dispatched: string[] = [];
  const pipeline = new SpeechPipeline(
    async (text) => {
      dispatched.push(text);
      clock.advance(50); // a real synthesis call is not instant
      return wavOf(900);
    },
    durationOf,
    { now: clock.now },
  );

  // The model streams the reply in small deltas; the first clause is complete long before
  // the last delta arrives. This is the whole point of Phase 8: the last delta has not been
  // generated yet when clause 1 is already on its way to the speaker.
  const deltas = ['明天有小雨，出门记得带伞。', '温度大概十几度，', '不冷。'];
  pipeline.push(deltas[0] as string);
  assert.deepEqual(dispatched, ['明天有小雨，出门记得带伞。'], 'clause 1 is dispatched as soon as it is complete');
  pipeline.push(deltas[1] as string);
  assert.equal(dispatched.length, 1, 'the second sentence is still incomplete, so nothing more goes out');
  pipeline.push(deltas[2] as string);
  assert.equal(dispatched.length, 2, 'clause 2 is dispatched without waiting for flush()');
  const clauses = await pipeline.flush();
  assert.deepEqual(clauses.map((chunk) => chunk.text), ['明天有小雨，出门记得带伞。', '温度大概十几度，不冷。']);
  assert.deepEqual(clauses.map((chunk) => chunk.index), [0, 1], 'playback order equals generation order');
  assert.equal(readWavInfo(Buffer.from(clauses[0]!.wav)).durationMs, 900);
  assert.deepEqual(pipeline.errors, []);
  assert.equal(pipeline.pendingChars, 0);
});

test('a sentence end that is still inside the buffer is not lost while the tail arrives', () => {
  // The chunker waits for more text before cutting at a mark whose verdict depends on what
  // follows (a half-arrived `3.` must not be split). A sentence end that cannot be part of a
  // number or a URL releases its clause immediately, and nothing is lost or reordered.
  const clock = testClock();
  const dispatched: { text: string; atMs: number }[] = [];
  const pipeline = new SpeechPipeline(
    async (text) => {
      dispatched.push({ text, atMs: clock.now() });
      clock.advance(10);
      return wavOf(400);
    },
    durationOf,
    { now: clock.now },
  );
  pipeline.push('第一件事。');
  assert.deepEqual(dispatched.map((item) => item.text), ['第一件事。'], 'a full stop is never ambiguous, so it releases at once');
  clock.advance(300);
  pipeline.push('第二件事还没有说完');
  assert.equal(pipeline.pendingChars, '第二件事还没有说完'.length, 'unpunctuated text is held: the next delta may continue it');
  clock.advance(50);
  pipeline.push('，我先走了。');
  assert.deepEqual(
    dispatched.map((item) => item.text),
    ['第一件事。', '第二件事还没有说完，我先走了。'],
    'nothing is lost: the held text is released with what followed it',
  );
  assert.ok((dispatched[1]?.atMs ?? 0) <= clock.now(), 'both were dispatched');
});

test('the whole V0.1 path needed every clause before any audio existed', async () => {
  // Same reply, same synthesizer cost, but dispatched the V0.1 way: one call with the whole
  // reply. The comparison has to name what it compares — stage ③ in V0.1 was
  // 「首 token → 整段首音」 (all clauses synthesized), in streaming it is
  // 「首 token → 第一段可听」.
  const reply = '明天有小雨，出门记得带伞。温度大概十几度，不冷。';

  const legacyClock = testClock();
  const legacySynthesize = async (text: string): Promise<Buffer> => {
    legacyClock.advance(50 * text.length); // measured TTS cost scales with the text
    return wavOf(1200);
  };
  const legacyStart = legacyClock.now();
  await legacySynthesize(reply);
  const legacyFirstAudioMs = legacyClock.now() - legacyStart;

  const streamClock = testClock();
  const calls: string[] = [];
  let firstClauseAudioAtMs: number | null = null;
  const pipeline = new SpeechPipeline(
    async (text) => {
      calls.push(text);
      streamClock.advance(50 * text.length);
      if (firstClauseAudioAtMs === null) firstClauseAudioAtMs = streamClock.now();
      return wavOf(1200);
    },
    durationOf,
    { now: streamClock.now },
  );
  const streamStart = streamClock.now();
  pipeline.push(reply);
  await pipeline.flush();
  const streamingFirstAudioMs = (firstClauseAudioAtMs ?? streamClock.now()) - streamStart;

  assert.deepEqual(calls, ['明天有小雨，出门记得带伞。', '温度大概十几度，不冷。'], 'one TTS call per clause');
  assert.ok(
    streamingFirstAudioMs < legacyFirstAudioMs,
    `streaming must reach first audio sooner (${streamingFirstAudioMs}ms vs ${legacyFirstAudioMs}ms)`,
  );
  // …and the playback timeline shows the same thing from the listener's side.
  const timeline = new PlaybackTimeline();
  timeline.schedule({ index: 0, text: calls[0] as string, wav: wavOf(1200), durationMs: 1200, atMs: 1234, synthMs: 10 });
  assert.equal(timeline.firstAudibleAtMs, 1234, 'the first clause is audible as soon as it exists');

  const latency = fourStageLatency({ endpointDelayMs: 512, asrMs: 600, firstTokenMs: 2000, firstAudioMs: streamingFirstAudioMs });
  assert.equal(latency.totalToFirstAudioMs, 512 + 600 + 2000 + streamingFirstAudioMs);
  assert.equal(latency.firstTokenToFirstAudioMs, streamingFirstAudioMs);
  assert.equal(latency.asrFinalToFirstTokenMs, 2000, 'stage ② is untouched by Phase 8');
});

test('a failed clause is reported, not turned into silence', async () => {
  const clock = testClock();
  const pipeline = new SpeechPipeline(
    async (text) => {
      clock.advance(10);
      if (text.startsWith('第二')) throw new Error('TTS 502');
      return wavOf(500);
    },
    durationOf,
    { now: clock.now },
  );
  pipeline.push('第一句。第二句。第三句。');
  const clauses = await pipeline.flush();
  assert.deepEqual(clauses.map((chunk) => chunk.text), ['第一句。', '第三句。']);
  assert.equal(pipeline.errors.length, 1);
  assert.match(pipeline.errors[0] as string, /第二句/);
  assert.match(pipeline.errors[0] as string, /TTS 502/);
});

test('earlyFirstClause releases clause 1 without waiting for the rest of the reply', async () => {
  const clock = testClock();
  const dispatched: string[] = [];
  const firstSeen: string[] = [];
  const pipeline = new SpeechPipeline(
    async (text) => {
      dispatched.push(text);
      clock.advance(20);
      return wavOf(300);
    },
    durationOf,
    { earlyFirstClause: true, earlyFirstClauseMinChars: 6, now: clock.now },
  );
  pipeline.onFirstClause((clause) => firstSeen.push(clause.text));

  // The model's sentence-end arrives last: without the early release nothing would be dispatched
  // here, and the reply would only reach TTS at flush (measured as 200–800 ms of lost latency).
  pipeline.push('今天中阵雨，');
  assert.deepEqual(dispatched, ['今天中阵雨，'], 'the comma prefix went to TTS immediately');
  assert.deepEqual(firstSeen, ['今天中阵雨，'], 'and the caller was told, once');
  pipeline.push('18到25度，');
  assert.equal(dispatched.length, 1, 'the second comma is below the early-release minimum, so nothing more goes out');
  pipeline.push('出门记得带伞。');
  const clauses = await pipeline.flush();
  assert.equal(dispatched[0], '今天中阵雨，', 'nothing overtook the first clause');
  assert.equal(clauses[0]?.text, '今天中阵雨，', 'the first clause is the comma prefix, exactly once');
  assert.equal([...new Set(clauses.map((chunk) => chunk.index))].length, clauses.length, 'indices stay unique');
  assert.equal(clauses.map((chunk) => chunk.text).join(''), '今天中阵雨，18到25度，出门记得带伞。', 'and nothing is lost');
});

test('the early release never cuts a number, a URL or an over-short prefix', async () => {
  const dispatched: string[] = [];
  const pipeline = new SpeechPipeline(
    async (text) => {
      dispatched.push(text);
      return wavOf(200);
    },
    durationOf,
    { earlyFirstClause: true, earlyFirstClauseMinChars: 10 },
  );
  pipeline.push('圆周率是 3.');
  assert.deepEqual(dispatched, [], 'a half-read decimal releases nothing');
  pipeline.push('14159 和');
  assert.deepEqual(dispatched, [], 'the buffer is not a decisive mark, and a sentence ending arrives next');
  pipeline.push('这个我记不清了。');
  assert.equal(dispatched.length, 1, 'the full stop releases the whole prefix in one piece');
  assert.ok((dispatched[0] as string).includes('3.14159'), `the decimal is intact: ${dispatched[0] as string}`);
  assert.equal((dispatched[0] as string).endsWith('。'), true, 'and the clause ends at the sentence, not inside the number');
  await pipeline.flush();

  // A comma *after* the number is a legitimate release point; the number itself is not touched.
  const decimalDispatched: string[] = [];
  const decimalPipeline = new SpeechPipeline(
    async (text) => {
      decimalDispatched.push(text);
      return wavOf(200);
    },
    durationOf,
    { earlyFirstClause: true, earlyFirstClauseMinChars: 6 },
  );
  decimalPipeline.push('圆周率是 3.14159，');
  assert.deepEqual(decimalDispatched, ['圆周率是 3.14159，'], 'released at the comma after the number');
  await decimalPipeline.flush();

  // A URL is never cut *inside*: not at the dot of the host, not between the host and the path.
  // The comma right after it is a legitimate release point (the URL is in the first clause), and
  // the sentence end releases whatever is left — nothing is lost either way.
  const urlDispatched: string[] = [];
  const urlPipeline = new SpeechPipeline(
    async (text) => {
      urlDispatched.push(text);
      return wavOf(200);
    },
    durationOf,
    { earlyFirstClause: true, earlyFirstClauseMinChars: 6 },
  );
  urlPipeline.push('地址是 https://example.com/a，');
  urlPipeline.push('打开就能看到。');
  // `flush()` returns exactly the clauses that were dispatched during it, so the union of
  // "dispatched so far" and "just flushed" is the whole reply — and it must be exact.
  const tailChunks = (await urlPipeline.flush('released')).map((chunk) => chunk.text);
  const urlAll = [...urlDispatched, ...tailChunks];
  assert.equal(urlAll.join(''), '地址是 https://example.com/a，打开就能看到。');
  assert.ok(urlAll.some((chunk) => chunk.includes('https://example.com/a')), 'the URL stays whole in one clause');
  for (const chunk of urlAll) {
    assert.ok(!chunk.endsWith('example.'), `cut inside the host name: ${chunk}`);
    assert.ok(!chunk.endsWith('https://example.com/'), `cut between the host and the path: ${chunk}`);
  }
});

test('a single-sentence reply reaches TTS at the last delta, not at flush', async () => {
  // `flush()` is where the old path sent everything; with the early release the clause exists and
  // its request is in flight while the model is still streaming — which is the only way TTS can
  // overlap generation. `textAtMs` is the pipeline's own record of that moment.
  const clock = testClock();
  const dispatched: string[] = [];
  const pipeline = new SpeechPipeline(
    async (text) => {
      dispatched.push(text);
      return wavOf(300);
    },
    durationOf,
    { earlyFirstClause: true, now: clock.now },
  );
  clock.advance(1_000); // the model took a second to produce its first sentence
  const atDelta = clock.now();
  pipeline.push('明天有小雨。');
  assert.equal(dispatched.length, 1, 'dispatched on the delta, not later');
  assert.equal(pipeline.clauses[0]?.textAtMs, atDelta, 'the clause existed at the delta, before any waiting');
  assert.equal(pipeline.clauses[0]?.audioAtMs, null, 'and its audio is not there yet — that is the overlap');
  clock.advance(2_000); // the rest of the reply takes a while
  await pipeline.flush();
  assert.equal(dispatched.length, 1, 'flush added nothing');
  assert.equal(pipeline.clauses[0]?.audioAtMs, atDelta + 2_000, 'the audio landed two seconds after the dispatch');
  assert.equal(pipeline.clauses[0]?.synthMs, 2_000, 'and the synthesis cost is measured from the dispatch');
});

/* ---------------------------------------------------------------------------------------
 * ② Barge-in
 * ------------------------------------------------------------------------------------- */

function clause(index: number, durationMs: number, atMs: number): SynthesizedClause {
  return { index, text: `第${index + 1}段`, wav: wavOf(durationMs), durationMs, atMs, synthMs: 40 };
}

test('abort stops playback where it is and drops exactly the un-played audio', () => {
  const timeline = new PlaybackTimeline();
  timeline.schedule(clause(0, 1000, 2000));
  timeline.schedule(clause(1, 1200, 2400));
  timeline.schedule(clause(2, 800, 2600));
  assert.equal(timeline.firstAudibleAtMs, 2000, 'the first clause is audible as soon as it exists');

  const full = timeline.metrics();
  assert.equal(full.firstAudibleClauses, 3, 'unstoppable playback lists all three');
  assert.equal(full.totalDurationMs, 3000);
  assert.equal(full.droppedMs, 0);

  // The father starts talking 600 ms into the reply.
  const stopped = timeline.abort(9999, { playedMs: 600 });
  assert.equal(stopped.aborted, true);
  assert.equal(stopped.playedMs, 600);
  assert.equal(stopped.droppedMs, 2400, 'everything not heard is dropped, not resumed');
  assert.deepEqual(stopped.droppedClauses, [0, 1, 2], 'clause 0 was still being heard');
  assert.equal(stopped.firstAudibleClauses, 1, 'only clause 1 had been needed to start');
});

test('an abort before the first clause is heard drops the whole reply', () => {
  const timeline = new PlaybackTimeline();
  timeline.schedule(clause(0, 900, 5000));
  const stopped = timeline.abort(6000, { playedMs: 0 });
  assert.equal(stopped.firstAudibleClauses, 0);
  assert.equal(stopped.playedMs, 0);
  assert.equal(stopped.droppedMs, 900);
});

test('playbackStateAt answers 「她还在说吗」, which is what the barge-in criterion is about', () => {
  const timeline = new PlaybackTimeline();
  timeline.schedule(clause(0, 1000, 2000));
  timeline.schedule(clause(1, 1000, 2600));
  const running = timeline.metrics();
  assert.deepEqual(playbackStateAt(running, 500), { audible: true, clause: 0, positionMs: 500 });
  assert.deepEqual(playbackStateAt(running, 1500), { audible: true, clause: 1, positionMs: 1500 });
  assert.deepEqual(playbackStateAt(running, 2500), { audible: false, clause: null, positionMs: 2500 }, 'after the last clause the room is quiet');

  const stopped = timeline.abort(2100, { playedMs: 600 });
  assert.equal(playbackStateAt(stopped, 700).audible, false, 'once interrupted, nothing is audible — including 200 ms later');
  assert.equal(playbackStateAt(stopped, 900).audible, false);
  assert.equal(playbackStateAt(stopped, 900).positionMs, 600, 'and the position does not advance past the stop');
});

test('pauseWindows and the backchannel decision read the pauses inside his own sentence', () => {
  const spans = [
    { startMs: 0, endMs: 900 },
    { startMs: 1400, endMs: 2600 }, // a 500 ms pause before this one
    { startMs: 3000, endMs: 4200 }, // a 400 ms pause before this one
  ];
  const windows = pauseWindows(spans);
  assert.equal(windows.length, 2, 'n spans have n-1 pauses between them');
  assert.equal(windows[0]?.pauseMs, 500);
  assert.equal(windows[0]?.utteranceMs, 900, 'voiced time before the pause is what decides 「他一开口」');
  assert.equal(windows[1]?.pauseMs, 400);
  assert.equal(windows[1]?.utteranceMs, 900 + 1200);

  const longest = windows[0] as (typeof windows)[number];
  assert.equal(
    decideAssent({ assistantSpeaking: false, pauseMs: longest.pauseMs, utteranceMs: longest.utteranceMs, frequency: 1, used: 0 }).play,
    false,
    '900 ms of speech is not enough to interrupt with 「嗯」',
  );
  const later = windows[1] as (typeof windows)[number];
  const decision = decideAssent({ assistantSpeaking: false, pauseMs: later.pauseMs, utteranceMs: later.utteranceMs, frequency: 1, used: 0 });
  assert.equal(decision.play, true, 'after a full sentence in progress, a 400 ms pause is a real pause');
  assert.equal(decision.clip, ASSENT_CLIPS[0]);
  assert.deepEqual(pauseWindows([]), []);
  assert.deepEqual(pauseWindows([{ startMs: 0, endMs: 500 }]), [], 'one span has no pause inside it');
});

test('barge-in needs real user speech inside the playback window', () => {
  const common = { playbackStartMs: 1000, playbackDurationMs: 4000 };
  const talk = decideBargeIn({ ...common, userSpans: [{ startMs: 1200, endMs: 2200 }] });
  assert.equal(talk.stop, true, 'a sentence over her playback stops the audio');
  assert.equal(talk.overlapMs, 1000);

  const nod = decideBargeIn({ ...common, userSpans: [{ startMs: 1200, endMs: 1280 }] });
  assert.equal(nod.stop, false, 'a 「嗯」-length sound is not an interruption (§14.3)');
  assert.equal(nod.reason, 'below-gate');

  const after = decideBargeIn({ ...common, userSpans: [{ startMs: 6000, endMs: 7000 }] });
  assert.equal(after.stop, false, 'speech after she has finished is not barge-in');
  assert.equal(after.reason, 'below-gate');

  const idle = decideBargeIn({ ...common, playbackDurationMs: 0, userSpans: [{ startMs: 0, endMs: 900 }] });
  assert.equal(idle.reason, 'assistant-not-speaking');

  const done = decideBargeIn({ ...common, playbackOffsetMs: 4000, userSpans: [{ startMs: 0, endMs: 900 }] });
  assert.equal(done.reason, 'playback-already-done');
});

test('truncation arithmetic matches the audible stop, not the decision', () => {
  const { stopsAtMs, droppedMs } = truncateOnBargeIn({ decisionMs: 192, playbackOffsetMs: 800, playbackDurationMs: 5120 });
  assert.equal(stopsAtMs, 992, '800 ms already played + 192 ms to decide');
  assert.equal(droppedMs, 4128);
  // A decision that lands after the reply ended must not produce a negative drop.
  assert.deepEqual(truncateOnBargeIn({ decisionMs: 9000, playbackOffsetMs: 0, playbackDurationMs: 900 }), { stopsAtMs: 900, droppedMs: 0 });
});

test('the served playback snippet carries the barge-in rules and no placeholders', () => {
  assert.ok(XIXI_PLAYBACK_JS.includes('xixiStopSpeaking'), 'the page can stop playback');
  assert.ok(XIXI_PLAYBACK_JS.includes('xixiSpeakClause'), 'and can speak one clause at a time');
  assert.ok(XIXI_PLAYBACK_JS.includes('xixiWatchBargeIn'), 'and watches the microphone while she talks');
  assert.ok(XIXI_PLAYBACK_JS.includes(String(XIXI_PLAYBACK_THRESHOLDS.bargeInMs)), 'the voiced-time gate is interpolated for real');
  assert.ok(XIXI_PLAYBACK_JS.includes(String(XIXI_PLAYBACK_THRESHOLDS.voiceRms)), 'the RMS gate is interpolated for real');
  assert.doesNotMatch(XIXI_PLAYBACK_JS, /\$\{/, 'no un-interpolated placeholders');
  assert.doesNotMatch(XIXI_PLAYBACK_JS, /<\/script/i, 'and nothing that would close the page script early');
  // The barge-in gate must be longer than a backchannel: that is the whole §14.3 rule.
  assert.ok(XIXI_PLAYBACK_THRESHOLDS.bargeInMs > 120, 'a 120 ms clipped 「嗯」 must not stop her');
});

/* ---------------------------------------------------------------------------------------
 * The snippet the browser runs, executed for real (t11)
 * ------------------------------------------------------------------------------------- */

/** Minimal AudioContext/HTMLAudioElement doubles, enough to drive `XIXI_PLAYBACK_JS`. */
function runPlaybackSnippet(): {
  readonly sandbox: Record<string, unknown>;
  readonly stopped: () => number;
  readonly started: () => number;
  readonly clipsPlayed: () => number;
} {
  let stopCalls = 0;
  let startCalls = 0;
  let clips = 0;
  const source = (): Record<string, unknown> => ({
    buffer: null,
    onended: null,
    connect: () => undefined,
    start: () => {
      startCalls += 1;
    },
    stop: () => {
      stopCalls += 1;
    },
  });
  const context = {
    state: 'running',
    resume: () => undefined,
    createBufferSource: source,
    destination: {},
    decodeAudioData: async () => ({ duration: 1.5 }),
  };
  const sandbox: Record<string, unknown> = {
    window: { AudioContext: function AudioContext(): unknown { return context; } },
    AudioContext: function AudioContext(): unknown { return context; },
    Audio: function Audio(): { play: () => Promise<void> } {
      clips += 1;
      return { play: () => Promise.resolve() };
    },
    performance: { now: () => 0 },
    Date: { now: () => 1_000 },
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    Uint8Array,
    console,
  };
  sandbox['globalThis'] = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(XIXI_PLAYBACK_JS, sandbox);
  return { sandbox, stopped: () => stopCalls, started: () => startCalls, clipsPlayed: () => clips };
}

test('the browser playback rules really run (node:vm), and a barge-in drops the queue', async () => {
  const run = runPlaybackSnippet();
  const speak = run.sandbox['xixiSpeakClause'] as (audio: string) => Promise<{ skipped?: boolean }>;
  const stop = run.sandbox['xixiStopSpeaking'] as (reason?: string) => void;
  const watch = run.sandbox['xixiWatchBargeIn'] as (rms: number) => boolean;

  // Two clauses are speaking; both went through the real scheduling path.
  const first = await speak(Buffer.from('fake-wav-1').toString('base64'));
  const second = await speak(Buffer.from('fake-wav-2').toString('base64'));
  assert.equal(first.skipped, undefined);
  assert.equal(second.skipped, undefined);
  assert.equal(run.started(), 2, 'both clauses were started on the audio context');

  // A quiet frame is not a barge-in; enough voiced frames are (the gate is interpolated into the
  // served source, so this exercises the browser's own constant).
  const framesNeeded = Math.ceil(XIXI_PLAYBACK_THRESHOLDS.bargeInMs / 20);
  assert.equal(watch(0.001), false, 'silence does not interrupt her');
  assert.equal(watch(0.5), false, 'one loud frame is not enough');
  let interrupted = false;
  for (let frame = 2; frame < framesNeeded; frame += 1) {
    assert.equal(watch(0.5), false, `frame ${frame} is still below the gate`);
  }
  interrupted = watch(0.5);
  assert.equal(interrupted, true, 'enough voiced time stops playback');
  assert.equal(run.stopped(), 2, 'and the queued sources were really stopped');

  // A later clause sees the interruption and is never played: the reply is dropped, not resumed.
  const afterBargeIn = await speak(Buffer.from('fake-wav-3').toString('base64'));
  assert.equal(afterBargeIn.skipped, true, 'clauses after a barge-in are not played');

  // The 応和 clip path plays outside that queue.
  const clip = run.sandbox['xixiPlayClip'] as (audio: string) => void;
  clip(Buffer.from('fake-wav-4').toString('base64'));
  assert.equal(run.clipsPlayed(), 1, 'a backchannel clip is a separate Audio element');

  // An explicit stop (e.g. the user presses stop) clears the queue without a barge-in decision.
  stop('user-stop');
  assert.ok(run.stopped() >= 2);
});

/* ---------------------------------------------------------------------------------------
 * ③ Backchannel
 * ------------------------------------------------------------------------------------- */

test('a backchannel goes into a pause, once or twice a turn, and never over her own voice', () => {
  const base = { assistantSpeaking: false, pauseMs: 400, utteranceMs: 4000, frequency: 1, used: 0 };
  const first = decideAssent(base);
  assert.equal(first.play, true);
  assert.equal(first.clip, ASSENT_CLIPS[0]);

  assert.equal(decideAssent({ ...base, pauseMs: 120 }).reason, 'pause-too-short', 'not mid-word');
  assert.equal(decideAssent({ ...base, utteranceMs: 600 }).reason, 'turn-too-short', 'he has barely started');
  assert.equal(decideAssent({ ...base, assistantSpeaking: true }).reason, 'assistant-idle');
  assert.equal(decideAssent({ ...base, frequency: 0 }).reason, 'frequency', 'personality 0 means never');
  assert.equal(
    decideAssent({ ...base, frequency: 0.5, used: 1, sinceLastMs: 8000 }).reason,
    'frequency',
    'half frequency → one per turn even though the pause is long enough',
  );
  assert.equal(decideAssent({ ...base, used: 2 }).reason, 'already-used', 'two is the cap');
  assert.equal(decideAssent({ ...base, used: 1, sinceLastMs: 1000 }).reason, 'pause-too-short', 'not twice in a row');
  const second = decideAssent({ ...base, used: 1, sinceLastMs: 8000 });
  assert.equal(second.play, true);
  assert.equal(second.clip, ASSENT_CLIPS[1], 'a different clip the second time');
  // Deterministic: the same inputs give the same decision, every time (no RNG in the live path).
  assert.deepEqual(decideAssent(base), decideAssent(base));
});

test('the user own acknowledgement does not close their turn', () => {
  for (const nod of ['嗯', '嗯。', '嗯嗯', '哦', '哦哦', '是啊', '好啊', '嗯…', ' 嗯 ']) {
    assert.equal(isShortAcknowledgementOnly(nod), true, `「${nod}」 is an acknowledgement, not a turn`);
  }
  for (const sentence of ['嗯，我明天下午去镇上。', '我在呢。', '你说什么？', '好，那就这样吧。', '对，嗯']) {
    assert.equal(isShortAcknowledgementOnly(sentence), false, `「${sentence}」 is a real turn`);
  }
  assert.equal(isShortAcknowledgementOnly('', {}), true, 'nothing was heard');
  // The voiced duration is the second, independent signal. Without one, a two-character
  // agreement is all the evidence there is (「好啊」 above); a three-character one is not.
  assert.equal(isShortAcknowledgementOnly('好的'), false);
  assert.equal(isShortAcknowledgementOnly('好对是'), false);
  // With one, the duration decides, for a bare 「好」 and for the full-length clips alike.
  assert.equal(isShortAcknowledgementOnly('好', { energyMs: 300 }), true, 'a 300 ms 「好」 is a nod');
  assert.equal(isShortAcknowledgementOnly('好', { energyMs: 2500 }), false, 'a 2.5 s 「好」 is a sentence');
  assert.equal(isShortAcknowledgementOnly('好', { energyMs: 4000 }), false, 'and a four-second one certainly is');
  assert.equal(isShortAcknowledgementOnly('是', { energyMs: 400 }), true, 'a clipped 「是」 is a nod');
  assert.equal(isShortAcknowledgementOnly('是啊', { energyMs: 600 }), true);
});

test('the clip bank synthesizes each clip once and reuses it forever', async () => {
  let calls = 0;
  const bank = new AssentBank(async (text) => {
    calls += 1;
    return wavOf(text.length * 100);
  });
  const first = await bank.get('嗯');
  assert.ok(first !== null);
  assert.equal(calls, 1);
  const again = await bank.get('嗯');
  assert.equal(again, first, 'the same buffer comes back from the cache');
  assert.equal(calls, 1, 'and no second TTS call was made');
  await Promise.all([bank.get('哦'), bank.get('哦'), bank.get('哦')]);
  assert.equal(calls, 2, 'concurrent asks for one clip still make one call');
  assert.equal(bank.size, 2);
  await bank.prepare();
  assert.equal(bank.size, ASSENT_CLIPS.length, 'prepare() warms the whole bank outside a pause');
  assert.equal(calls, ASSENT_CLIPS.length);
  assert.deepEqual(bank.errors, []);
});

test('a clip that cannot be synthesized is reported and does not break the turn', async () => {
  const bank = new AssentBank(async () => {
    throw new Error('TTS 429');
  });
  assert.equal(await bank.get('嗯'), null);
  assert.equal(bank.errors.length, 1);
  assert.match(bank.errors[0] as string, /嗯/);
  assert.match(bank.errors[0] as string, /TTS 429/);
});

/* ---------------------------------------------------------------------------------------
 * Statistics used by the latency report
 * ------------------------------------------------------------------------------------- */

test('percentiles follow the baseline rule and drop unmeasured rounds', () => {
  assert.equal(percentiles([]), null);
  assert.equal(percentiles([null, null]), null, 'unmeasured is not zero');
  const one = percentiles([123]);
  assert.deepEqual(one, { n: 1, p50: 123, p90: 123, min: 123, max: 123 });
  const many = percentiles([100, null, 200, 300, 400]);
  assert.equal(many?.n, 4, 'the null round is excluded from the count');
  assert.equal(many?.p50, 250, 'linear interpolation between 200 and 300');
  assert.equal(many?.min, 100);
  assert.equal(many?.max, 400);
  // P50 of an even sample is the average of the two middle values — the V0.1 baseline's
  // 「2285.5 ms」 came out of exactly this rule.
  const even = percentiles([1000, 2000, 3000, 4000]);
  assert.equal(even?.p50, 2500);
});
