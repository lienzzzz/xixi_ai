/**
 * Console-level tests for the field-test console (`scripts/field-test.ts`).
 *
 * These are the parts of the console that must be right *before* anyone touches a
 * microphone: the retention policy, the multi-segment planner, the presence
 * fallback, the report text and the readable error paths. The device path needs
 * hardware and is covered by `node scripts/field-test.ts --acceptance` plus the
 * offline `--self-test` (which drives the real HTTP surface).
 *
 * Run: node --test (point it at this directory; npm test does not glob it yet)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { WeatherClient } from '@xixi/model-adapters';

import { concatWav, readWav, readWavInfo, sliceWav } from '../../scripts/lib/wav.ts';
import {
  RuntimeError,
  buildFieldPage,
  buildSpeechAudio,
  createFakeProbeRunner,
  createFieldServer,
  defaultProbeRunner,
  describeOutcome,
  explainAction,
  explainReason,
  handleVoiceTurn,
  planSpeechSegments,
  pruneVoiceDir,
  readCalibration,
  readPresence,
  renderAcceptanceReport,
  retentionPolicy,
  runVad,
  segmentTtsNote,
  silenceWav,
  type AcceptanceReport,
  type RetentionPolicy,
  type SpeechSegment,
  type VoiceDeps,
} from '../../scripts/field-test.ts';
import { REPO_ROOT, loadConfig } from '../../scripts/lib/harness.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'xixi-console-test-'));
}

/**
 * Wording that belongs to the machinery, never to a spoken reply: tool names, wire keys,
 * the words for "call a tool". The acceptance for Phase 2 is that asking about the weather
 * produces a sentence a person would hear, so the offline case asserts the absence.
 */
const INTERNAL_WORDING = /xixi_[a-z_]+|tool_call|arguments|parameters|schema|JSON|工具调用|调用成功|不认识的参数/;

/** The console's offline run must not touch the network either — so the tool's source is stubbed. */
function stubWeatherClient(): WeatherClient {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes('geocoding')
      ? { results: [{ name: '成都', latitude: 30.66, longitude: 104.06, timezone: 'Asia/Shanghai', admin1: '四川省' }] }
      : {
          timezone: 'Asia/Shanghai',
          daily: {
            time: ['2026-09-30', '2026-10-01', '2026-10-02'],
            weather_code: [61, 3, 0],
            temperature_2m_max: [24.4, 25.1, 27.8],
            temperature_2m_min: [18.2, 19.0, 20.1],
            precipitation_probability_max: [80, 8, 0],
          },
        };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return new WeatherClient({ fetchImpl });
}

const DEFAULT_POLICY = retentionPolicy(loadConfig());

test('the shipped config means "keep no raw audio at all" (§20.1)', () => {
  assert.equal(DEFAULT_POLICY.storeRawAudio, false);
  assert.equal(DEFAULT_POLICY.rawAudioRetentionDays, 0);
  assert.equal(DEFAULT_POLICY.keepSpeechSegments, false);
  assert.match(DEFAULT_POLICY.reason, /§20\.1/);
  assert.match(DEFAULT_POLICY.reason, /整段录音不落盘/);
});

test('an explicit opt-in keeps only speech segments, with a retention window', () => {
  const policy = retentionPolicy({
    memory: { raw_audio_retention_days: 7 },
    privacy: { store_raw_audio: true },
  } as never);
  assert.equal(policy.storeRawAudio, true);
  assert.equal(policy.keepSpeechSegments, true);
  assert.equal(policy.speechRetentionDays, 7);
  assert.match(policy.reason, /保留 7 天/);
});

test('pruning removes legacy whole recordings and honours an explicit retention window', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'capture-1700000000000.wav'), Buffer.alloc(1000));
    writeFileSync(join(dir, 'speech-1700000000000.wav'), Buffer.alloc(500));
    writeFileSync(join(dir, 'ambient-5s.wav'), Buffer.alloc(200));
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    const result = pruneVoiceDir(dir, DEFAULT_POLICY);
    assert.deepEqual(
      result.removed.map((item) => item.name).sort(),
      ['capture-1700000000000.wav', 'speech-1700000000000.wav'],
      'only this script\'s own artefacts may be touched',
    );
    assert.equal(result.kept, 2);
    assert.equal(result.bytesFreed, 1500);

    // With a retention window, a *fresh* legacy capture survives and an old one goes.
    const dir2 = tempDir();
    const old = join(dir2, 'capture-1.wav');
    writeFileSync(old, Buffer.alloc(10));
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(old, longAgo, longAgo);
    writeFileSync(join(dir2, 'capture-2.wav'), Buffer.alloc(10));
    const keepPolicy: RetentionPolicy = { ...DEFAULT_POLICY, storeRawAudio: true, rawAudioRetentionDays: 30, speechRetentionDays: 30, keepSpeechSegments: true };
    const second = pruneVoiceDir(dir2, keepPolicy);
    assert.deepEqual(second.removed.map((item) => item.name), ['capture-1.wav']);
    rmSync(dir2, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every VAD segment is used; anything left out is reported with a reason', () => {
  const segments: SpeechSegment[] = Array.from({ length: 10 }, (_, index) => ({ startMs: index * 1000, endMs: index * 1000 + 900, durationMs: 900 }));
  const plan = planSpeechSegments(segments);
  assert.equal(plan.used.length, 8);
  assert.equal(plan.dropped.length, 2, 'dropped segments are counted, not hidden');
  assert.equal(plan.dropped[0]?.reason.includes('8 段'), true);
  assert.equal(plan.capped, true);
  assert.equal(plan.used.length + plan.dropped.length, segments.length);

  const long = planSpeechSegments([{ startMs: 0, endMs: 20_000, durationMs: 20_000 }, { startMs: 20_000, endMs: 40_000, durationMs: 20_000 }]);
  assert.equal(long.used.length, 1);
  assert.equal(long.dropped.length, 1);
  assert.match(String(long.capReason), /上限/);
});

test('the audio sent to ASR contains every used segment, never the dropped ones', () => {
  const raw = concatWav([readWav(join(REPO_ROOT, 'tests', 'audio-fixtures', 'direct-question.wav')), readWav(join(REPO_ROOT, 'tests', 'audio-fixtures', 'followup-turn.wav'))], 800);
  const info = readWavInfo(raw);
  const plan = planSpeechSegments([
    { startMs: 100, endMs: 500, durationMs: 400 },
    { startMs: 1000, endMs: 1500, durationMs: 500 },
  ]);
  const stitched = buildSpeechAudio(raw, plan);
  const stitchedInfo = readWavInfo(stitched);
  assert.equal(stitchedInfo.sampleRate, info.sampleRate, 'format is preserved');
  assert.equal(stitchedInfo.channels, info.channels);
  // 400 + 500 ms of speech + one 300 ms gap, within a frame.
  assert.ok(Math.abs(stitchedInfo.durationMs - 1200) < 5, `expected ~1200ms, got ${stitchedInfo.durationMs}`);

  const single = buildSpeechAudio(raw, planSpeechSegments([{ startMs: 100, endMs: 500 }]));
  assert.deepEqual(single.length, sliceWav(raw, 100, 500).length, 'one segment is a plain slice');
});

test('missing calibration is reported as uncalibrated, not guessed', () => {
  const view = readCalibration(join(tempDir(), 'nope.json'));
  assert.equal(view.available, false);
  assert.match(view.note, /简易 RMS/);
  assert.equal(view.noiseFloorDbfs, null);

  const dir = tempDir();
  try {
    const file = join(dir, 'frontend-profile.json');
    writeFileSync(file, JSON.stringify({ unit: 'dBFS', noiseFloorDbfs: -33.24, params: { highpass_hz: 120, gate_threshold_dbfs: -18, suggested_capture_gain_db: 0 } }));
    const parsed = readCalibration(file);
    assert.equal(parsed.available, true);
    assert.equal(parsed.noiseFloorDbfs, -33.24);
    assert.equal(parsed.gateThresholdDbfs, -18, 'snake_case params from Python must parse');
    assert.equal(parsed.highpassHz, 120);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('presence is a state, never an exception: projection, events, not-integrated, error', async () => {
  const missing = await readPresence({ store: { readEvents: () => [] } });
  assert.equal(missing.mode, 'not-integrated');
  assert.equal(missing.text, '未接入');
  assert.match(missing.note, /M6/);

  const projection = await readPresence({
    store: {
      worldState: () => ({ key: 'presence.home', value: 'present', present: true, confidence: 0.82, source: 'camera', updatedAt: '2026-09-30T11:00:00+08:00', ttlSeconds: 60, stale: false }),
    },
  });
  assert.equal(projection.mode, 'projection');
  assert.equal(projection.text, '有人在场');
  assert.equal(projection.confidence, 0.82);
  assert.equal(projection.stale, false);

  const stale = await readPresence({ store: { worldState: () => ({ present: null, value: null, stale: true }) } });
  assert.equal(stale.stale, true);
  assert.match(stale.note, /过期/);

  const events = await readPresence({ store: { readEvents: () => [{ payload: { present: false }, confidence: 0.5, source: 'camera', timestamp: '2026-09-30T11:00:00+08:00' }] } });
  assert.equal(events.mode, 'events');
  assert.equal(events.text, '没人在场');

  const broken = await readPresence({ store: { worldState: () => { throw new Error('database is locked'); } } });
  assert.equal(broken.mode, 'error');
  assert.match(broken.note, /database is locked/);
});

test('actions and rejection reasons are explained in Chinese', () => {
  assert.match(explainAction('SILENCE'), /沉默/);
  assert.match(explainReason('REJECTED_SUSPENDED'), /安静点/);
  assert.match(explainReason('REJECTED_NOT_ADDRESSED'), /不是.*西西|不是在跟西西说/);
  assert.match(describeOutcome('SILENCE', 'REJECTED_SUSPENDED'), /沉默.*安静点/);
});

test('the report is self-contained: per-item verdicts, evidence and reproduction', () => {
  const report: AcceptanceReport = {
    at: '2026-09-30T03:00:00.000Z',
    date: '2026-09-30',
    command: 'node scripts/field-test.ts --acceptance',
    overall: 'fail',
    items: [
      {
        id: 'microphone',
        order: 1,
        name: '麦克风（说话能不能进来）',
        verdict: 'pass',
        summary: '通过：能录到声音',
        checks: [{ name: '录了 3 秒环境声', verdict: 'pass', detail: 'RMS -30.9 dBFS' }],
        nextAction: '下一步：扬声器自检',
        evidence: { recording: { rmsDbfs: -30.9 } },
      },
      {
        id: 'speaker',
        order: 2,
        name: '扬声器（西西说话你能不能听到）',
        verdict: 'fail',
        summary: '失败：默认输出设备是静音状态',
        checks: [{ name: '② 麦克风真的听到了', verdict: 'fail', detail: '相对差 2.6 dB（判据 ≥10 dB）' }],
        nextAction: '下一步：解除静音后重跑',
        evidence: {},
      },
    ],
    notes: ['判据说明：「程序渲染了音频」与「麦克风真的听到了」是两件事（勘测 §2.5 的假 PASS 教训）'],
    environment: { host: 'TEST-PC', node: 'v24', platform: 'win32', probePython: 'py', audioPython: 'py', fixture: 'f.wav' },
    reportPath: null,
  };
  const text = renderAcceptanceReport(report, {
    calibration: { available: true, source: 'x', file: 'y', unit: 'dBFS', noiseFloorDbfs: -33.24, noiseRmsDbfs: null, gateThresholdDbfs: -18, highpassHz: 120, suggestedCaptureGainDb: 0, rationale: [], note: '噪声底与门限来自实测校准' },
    privacyNotes: ['整段录音不落盘'],
  });
  assert.match(text, /现场测试报告（设备验收）/);
  assert.match(text, /\| 2 \| .*未通过|未通过（FAIL/);
  assert.match(text, /下一步动作\*\*：解除静音后重跑/, 'the label is not duplicated');
  assert.doesNotMatch(text, /下一步动作：下一步/);
  assert.match(text, /假 PASS/, 'the false-PASS rationale travels with the report');
  assert.match(text, /噪声底与门限来自实测校准/);
  assert.match(text, /复现方式/);
  assert.match(text, /-33\.24 dBFS/);
});

test('the page is Chinese, self-describing and carries the boot state', () => {
  const boot = {
    listen: '127.0.0.1:8792',
    offline: true,
    ttsEnabled: false,
    modelConfigured: false,
    calibration: readCalibration('nope.json'),
    policy: DEFAULT_POLICY,
    // t42: the page prints which store it uses, so the boot object has to carry it.
    databasePath: join(REPO_ROOT, 'data', 'field-test'),
  };
  const page = buildFieldPage(boot);
  // t78 renamed the camera card (it now carries the live picture too) and added the three columns.
  for (const marker of ['麦克风实时电平与噪声底', '摄像头实时画面', '摄像头在场状态', '设备验收引导', '最近几轮', 'dBFS', '沉默', '下一步动作', '127.0.0.1:8792', '整段录音', '未接入', '本页用的是哪个数据库', '主动开口']) {
    assert.ok(page.includes(marker), `page is missing ${marker}`);
  }
  // t78: 左（传感器）中（配置）右（对话记录）三栏 + 一键启用。
  for (const marker of ['id="col-sensors"', 'id="col-config"', 'id="col-conversation"', 'id="px-enable"', 'id="px-disable"', 'id="px-cam"', 'id="px-tts-switch"', 'id="px-camera-switch"']) {
    assert.ok(page.includes(marker), `the three-column layout is missing ${marker}`);
  }
  // t42 acceptance item 3, kept honest under pack Phase 8 (t11): a page must tell the truth about
  // TTS granularity, and that truth is a function of the wiring (`segmentTtsNote(mode)`), not a
  // copied sentence. This boot has 朗读 off, so the page must say there is no sound — claiming
  // either 「边生成边按句读切块」 or 「整条回复一次合成」 would be a claim about a TTS this console
  // is not running.
  assert.ok(page.includes(segmentTtsNote('none')), 'the page renders the note derived from its own wiring');
  assert.ok(page.includes('只有文字、没有声音'), 'and says there is no speech at all');
  assert.doesNotMatch(page, /整条回复一次合成/, 'the stale whole-reply claim must not survive');
  assert.doesNotMatch(page, /边生成边按句读切块/, 'and an offline console must not claim streaming TTS');

  // t13: the console and the trial page must not be able to disagree with the server about
  // granularity, so each boot's note is asserted against `segmentTtsNote(mode)` for **that** boot —
  // a page rendering a sentence that belongs to another mode fails here.
  for (const ttsMode of ['streaming', 'whole-reply'] as const) {
    const withMode = buildFieldPage({ ...boot, offline: false, ttsEnabled: true, ttsMode, modelConfigured: true });
    assert.ok(withMode.includes(segmentTtsNote(ttsMode)), `a '${ttsMode}' boot renders segmentTtsNote('${ttsMode}')`);
    assert.ok(
      !withMode.includes(segmentTtsNote(ttsMode === 'streaming' ? 'whole-reply' : 'streaming')),
      `and not the other mode's sentence ('${ttsMode}')`,
    );
  }
  assert.ok(page.includes('data/field-test'), 'and names its own database path');
  assert.ok(page.includes('px-quiet-start'), 'and carries the proactive knobs');
  assert.ok(page.includes('延迟分段'), 'the per-stage latency line is part of the UI');
  // User-reported (2026-09-30): pressing the mic button moved it, because the hint text shared the
  // button's flex row and the button's own label changed on press. Pin the stable-layout rules.
  assert.ok(page.includes('footer #hint { flex-basis:100%'), 'the hint takes its own line so the controls row never reflows');
  assert.ok(page.includes('footer #mic { min-width:108px'), 'and the mic button keeps its width while its label changes');
  // …and the recording stays playable in the page, with its level, so 「未识别到」 is diagnosable
  // (was: the user saw 「未识别到」 and had no way to hear what had actually been captured).
  assert.ok(page.includes('▶ 播放我这次录音'), 'the page offers playback of the recording it just made');
  assert.ok(page.includes('peakDbfsOf') && page.includes('levelAdvice'), 'and reports the recorded peak level with advice');
  assert.ok(page.includes('录音音量正常') && page.includes('几乎没录到声音'), 'the advice covers both ends');
  assert.doesNotMatch(page, /\$\{/, 'no un-interpolated template placeholders leak into the served HTML');
});

test('voice requests fail with Chinese next steps, not stack traces', async () => {
  const deps = {} as unknown as VoiceDeps;
  await assert.rejects(() => handleVoiceTurn(deps, {}), (error: unknown) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, 'NO_AUDIO');
    assert.match(error.message, /没有收到音频/);
    assert.ok(error.hint.length > 5);
    assert.equal(error.status, 400);
    return true;
  });
  const tiny = Buffer.alloc(64).toString('base64');
  await assert.rejects(() => handleVoiceTurn(deps, { audioBase64: tiny }), (error: unknown) => {
    assert.equal((error as RuntimeError).code, 'AUDIO_TOO_SHORT');
    return true;
  });
  const notWav = Buffer.alloc(4096, 3).toString('base64');
  await assert.rejects(() => handleVoiceTurn(deps, { audioBase64: notWav }), (error: unknown) => {
    assert.equal((error as RuntimeError).code, 'BAD_AUDIO');
    assert.match((error as RuntimeError).hint, /刷新页面|维护者/);
    return true;
  });
});

test('a missing Python or probe binary is a readable error, not a crash', async () => {
  const missing = join(tempDir(), 'definitely-not-python.exe');
  await assert.rejects(() => runVad(missing, join(REPO_ROOT, 'tests', 'audio-fixtures', 'direct-question.wav')), (error: unknown) => {
    assert.equal((error as RuntimeError).code, 'VAD_UNAVAILABLE');
    assert.match((error as RuntimeError).hint, /\.venvs/);
    return true;
  });
  const runner = defaultProbeRunner(join(REPO_ROOT, 'data', 'field-test', 'device-probe.py'), REPO_ROOT);
  await assert.rejects(() => runner('camera', [], missing), (error: unknown) => {
    assert.equal((error as RuntimeError).code, 'PYTHON_MISSING');
    return true;
  });
});

test('the offline probe double reproduces the muted-speaker false-PASS case', async () => {
  const runner = createFakeProbeRunner();
  const endpoints = await runner('endpoints', [], 'py');
  assert.equal((endpoints.render as { muted: boolean }).muted, true);
  const speaker = await runner('speaker', [], 'py');
  assert.equal(speaker.loopbackCorrelation, 0.9996, 'a muted endpoint still correlates: render evidence alone cannot pass or fail a speaker');
  assert.ok(Number(speaker.micRmsDbfs) > -60, 'the absolute RMS is high even when nothing is audible');
  assert.ok(Number(speaker.differentialP95Db) < 10, 'the relative criterion is what fails');
});

test('a silent recording is a 16-bit PCM WAV the VAD can reject', () => {
  const buffer = silenceWav(500);
  const info = readWavInfo(buffer);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.ok(Math.abs(info.durationMs - 500) < 1);
  const file = join(tempDir(), 'silence.wav');
  writeFileSync(file, buffer);
  assert.ok(readFileSync(file).length > 44);
  rmSync(join(file, '..'), { recursive: true, force: true });
});

test('the server binds 127.0.0.1 only and reports its real port on an ephemeral bind', async () => {
  const root = tempDir();
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
  try {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(handle.port > 0);
    const state = (await (await fetch(`${handle.url}/api/field/state`)).json()) as { listen: string; privacy: { policy: RetentionPolicy } };
    assert.equal(state.listen, `127.0.0.1:${handle.port}`);
    assert.equal(state.privacy.policy.storeRawAudio, false);
    const address = handle.server.address() as { address: string };
    assert.equal(address.address, '127.0.0.1');
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Pack Phase 2 acceptance, entirely offline: a voice turn asking about the weather must
 * really call the weather tool, and what comes back must be a person's sentence with no
 * tool internals in it. The VAD and ASR are injected (neither the interpreter nor a key is
 * needed) but everything between them is the production code the console serves: the same
 * registry, the same loop, the same engine — and the same one for the text route, which is
 * what "语音与文字共用一条工具链" has to mean.
 */
test('a voice turn about the weather runs the tool, and text and voice share that one chain', async () => {
  const root = tempDir();
  const called: string[] = [];
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
    // The VAD is the voice entry's only Python dependency; the offline ASR double says a
    // fixed sentence, so an offline test that wants a weather question supplies both.
    vadOverride: async () => ({ segments: [{ startMs: 0, endMs: 1200, durationMs: 1200 }], durationMs: 1200 }),
    asrOverride: async () => '明天成都天气怎么样？',
    // Keep the offline run offline: the tool's data source is stubbed, like the model.
    toolOverrides: { weatherClient: stubWeatherClient() },
    log: (line) => {
      if (line.startsWith('[tool]')) called.push(line);
    },
  });
  const post = async (path: string, body: unknown): Promise<Record<string, any>> =>
    (await (await fetch(handle.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as Record<string, any>;
  try {
    // The console states which capabilities its conversation scope offers: the four
    // built-ins, and the round cap the model cannot raise.
    const state = (await (await fetch(`${handle.url}/api/field/state`)).json()) as Record<string, any>;
    assert.deepEqual([...state.tools.names].sort(), ['xixi_get_current_time', 'xixi_get_weather', 'xixi_news_stub', 'xixi_set_reminder_stub']);
    assert.equal(state.tools.scope, 'conversation');
    assert.equal(state.tools.maxRounds, 4);

    const wav = readWav(join(REPO_ROOT, 'tests', 'audio-fixtures', 'direct-question.wav'));
    const voice = await post('/api/voice', { audioBase64: wav.toString('base64'), speak: false });
    assert.equal(voice.transcript, '明天成都天气怎么样？');
    assert.equal(voice.action, 'SPEAK');
    assert.equal(voice.toolName, 'xixi_get_weather', `the voice turn must go through the weather tool, saw ${String(voice.toolName)}`);
    assert.ok(String(voice.reply).includes('明天成都'), `the reply is built from the tool result: ${String(voice.reply)}`);
    assert.doesNotMatch(String(voice.reply), INTERNAL_WORDING, 'nothing internal may reach a reply a person hears');

    // The typed turn on the same server: same chain, same tool, same words.
    const text = await post('/api/turn', { text: '明天成都天气怎么样？', speak: false });
    assert.equal(text.toolName, 'xixi_get_weather');
    assert.equal(text.reply, voice.reply, 'text and voice must not produce two different answers');
    assert.doesNotMatch(String(text.reply), INTERNAL_WORDING);

    // The tool really ran on both paths (the console logs every execution).
    assert.equal(called.filter((line) => line.startsWith('[tool] xixi_get_weather ok')).length, 2, called.join(' | '));
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

