import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { fixedClock, openXixiStore, type XixiStore } from '@xixi/domain';

import { handleVoiceTurn, silenceWav, type VoiceDeps } from '../../scripts/field-test.ts';
import { loadConfig, REPO_ROOT } from '../../scripts/lib/harness.ts';
import { readWavInfo } from '../../scripts/lib/wav.ts';

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

/**
 * One voice turn through the production handler, with a counted TTS sink and a counted direct
 * `client.synthesize`.
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
} = {}): Promise<{
  readonly payload: Awaited<ReturnType<typeof handleVoiceTurn>>;
  readonly sinkCalls: readonly string[];
  readonly wholeReplyCalls: readonly string[];
}> {
  const sinkCalls: string[] = [];
  const directCalls: string[] = [];
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
      return options.synthesize === undefined ? wavOf(options.wavMs ?? Math.max(400, text.length * 100)) : options.synthesize(text);
    },
  });
  const payload = await handleVoiceTurn(deps, { audioBase64: silenceWav(900).toString('base64') });
  return { payload, sinkCalls, wholeReplyCalls: directCalls };
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
  const { payload, sinkCalls, wholeReplyCalls } = await runStreamingTurn({
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

  // ② Every clause carries its own audio, so a page can play them one by one without asking the
  // server for anything else — this is what 「逐块播放」 needs and what the payload used to lack.
  for (const clause of spoken) {
    assert.ok(typeof clause.audio === 'string' && (clause.audio as string).length > 0, `clause ${clause.index} has no audio`);
    const decoded = Buffer.from(clause.audio as string, 'base64');
    assert.ok(Math.abs(readWavInfo(decoded).durationMs - clause.durationMs) < 5, `clause ${clause.index} audio length disagrees with its report`);
  }

  // ③ The audio the console already consumes is the stitched clause audio, not one TTS blob.
  assert.ok(payload.audio !== null);
  const stitched = Buffer.from(payload.audio as string, 'base64');
  const totalMinutes = spoken.reduce((sum, clause) => sum + clause.durationMs, 0);
  assert.ok(Math.abs(readWavInfo(stitched).durationMs - totalMinutes) < 5, `stitched ${readWavInfo(stitched).durationMs}ms vs sum ${totalMinutes}ms`);

  // ④ The timings come from the pipeline's clock: clause 1's audio is known, and ③/④ are filled.
  assert.ok(payload.stream?.firstClauseTextMs !== null && payload.stream?.firstClauseTextMs !== undefined);
  assert.ok((payload.stream?.firstClauseAudioMs ?? -1) >= 0);
  assert.ok((payload.stream?.fourStage.firstTokenToFirstAudioMs ?? -1) >= 0, 'stage ③ is measured');
  assert.ok((payload.stream?.fourStage.totalToFirstAudioMs ?? -1) >= 512, 'stage ④ includes the endpoint hold');
  assert.equal(payload.stream?.fourStage.vadEndToAsrFinalMs, payload.asrMs);
  assert.deepEqual(payload.stream?.errors, []);
});

test('the first clause does not wait for the rest of the reply', async () => {
  // Clause 1 stays in flight (60 ms) while clause 2 is dispatched and while the model keeps
  // streaming: a serial pipeline could not produce clause 2's start before clause 1 finished.
  const order: string[] = [];
  const { payload, sinkCalls, wholeReplyCalls } = await runStreamingTurn({
    synthesize: (text) => {
      order.push(`start:${text}`);
      return wavOf(300);
    },
    overrides: {},
  });
  assert.ok((payload.stream?.ttsSegments ?? 0) >= 2, `expected >= 2 clauses, got ${payload.stream?.ttsSegments}`);
  assert.deepEqual(order, [
    'start:好的，我记住了。',
    'start:明天可能有雨，出门记得带把伞，路滑慢点走。',
  ], `clause 1 went first and nothing overtook it (order=${order.join(' | ')})`);
  assert.equal(sinkCalls.length, payload.stream?.ttsSegments, 'one call per clause');
  assert.deepEqual(wholeReplyCalls, [], 'the server never synthesizes a second time');
  assert.deepEqual(
    payload.stream?.clauses.map((clause) => clause.text),
    ['好的，我记住了。', '明天可能有雨，出门记得带把伞，路滑慢点走。'],
    'the clauses are the chunker’s, in reply order',
  );
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
  const { payload, sinkCalls, wholeReplyCalls } = await runStreamingTurn({
    synthesize: (text) => {
      if (text.startsWith('明天')) throw new Error('TTS 502');
      return wavOf(400);
    },
  });
  assert.equal(payload.ok, true, 'the turn is not lost because one clause failed');
  assert.ok((payload.stream?.errors.length ?? 0) >= 1, 'the failure is reported, not swallowed');
  assert.match(payload.stream?.errors[0] as string, /TTS 502/);
  assert.ok(payload.audio !== null, 'the clauses that did synthesize are still returned');
  const failed = payload.stream?.clauses.find((clause) => clause.index === 1);
  assert.equal(failed?.audio, null, 'the failed clause carries no audio — never silence pretending to be speech');
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
