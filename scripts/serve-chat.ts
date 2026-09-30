/**
 * 本地试用页面（浏览器里和西西对话）。
 *
 * 为什么需要它：`npm run chat` 要开终端，而「试试」最省事的方式是点开一个网页。
 * 这个服务只监听 127.0.0.1，用一次性进程 + 同一套对话引擎，不改变任何既有行为。
 *
 * 说明（对应《方案》§M1）：页面上的「发送」按钮就是 M2 之前唤醒词的替身——
 * 状态为 IDLE 时视为直呼，会话已开启时按「继续」处理（不必再喊名字）。
 *
 * 用法：node scripts/serve-chat.ts [--port 8791] [--no-tts]
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { DshBrainAdapter, FakeBrainAdapter, MimoBrainAdapter, defaultTools, type BrainAdapter } from '@xixi/brain-adapter';
import { CliDshTransport } from '@xixi/brain-dsh';
import { ConversationEngine } from '@xixi/conversation';
import { MimoClient } from '@xixi/model-adapters';
import { openXixiStore } from '@xixi/domain';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, readDotEnv } from './lib/harness.ts';
import {
  ConsoleError,
  DEFAULT_LOOP_INTERVAL_MS,
  MIN_LOOP_INTERVAL_MS,
  PROACTIVE_PANEL_CSS,
  ProactiveLoop,
  SEGMENT_TTS_NOTE,
  XIXI_DB_ENTRIES,
  applyAndPersistProactivePatch,
  databaseNoteHtml,
  effectiveProactivity,
  handleVoiceTurn,
  lastUserTurnAt,
  proactiveConsoleState,
  proactiveDrill,
  proactivePanelHtml,
  proactivePanelScript,
  pruneVoiceDir,
  readPresence,
  retentionPolicy,
  restoreProactiveSettings,
  segmentPlan,
  type ProactiveConsoleState,
  type VoiceDeps,
  type VoiceTurnBody,
} from './field-test.ts';
import { toOffsetIso } from '@xixi/contracts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 && args[portArg + 1] !== undefined ? args[portArg + 1] : (process.env.XIXI_WEB_PORT ?? 8791));
const TTS_ENABLED = !args.includes('--no-tts');
/** `--dsh` runs the same page through the DSH harness instead of the direct path (slower). */
const USE_DSH = args.includes('--dsh');
/**
 * `--fake` runs the page against the deterministic offline adapter: no key, no network, no cost.
 *
 * Added in t42 so the multi-segment / proactive behaviour can be *demonstrated and tested*
 * without spending a real call (the console tests drive this page end-to-end).
 */
const USE_FAKE = args.includes('--fake');
const PYTHON = process.env.XIXI_PYTHON ?? join(REPO_ROOT, '.venvs', 'voice-pipecat', 'Scripts', 'python.exe');
const VOICE_DIR = join(REPO_ROOT, 'data', 'voice-web');

const config = loadConfig();
const client = new MimoClient();
/** `XIXI_WEB_DATA_DIR` is the test/parallel-instance seam (the console has the same one). */
const DATA_DIR = process.env.XIXI_WEB_DATA_DIR ?? join(REPO_ROOT, 'data', 'web-chat');
const store = openXixiStore({ dataDir: DATA_DIR });
store.seedSelfProfile(config.personality.base);
const policy = retentionPolicy(config);
// Same privacy fix as the field-test console: apply the retention policy to any
// whole-recording files older versions left behind (audit finding, §20.1).
const pruned = pruneVoiceDir(VOICE_DIR, policy);
if (pruned.removed.length > 0) {
  console.log(`[privacy] 按保留策略清理 ${pruned.removed.length} 个音频文件（${Math.round(pruned.bytesFreed / 1024)} KB）：${pruned.removed.map((item) => item.name).join('、')}`);
}

function buildAdapter(): BrainAdapter {
  if (USE_FAKE) return new FakeBrainAdapter();
  if (!USE_DSH) {
    return new MimoBrainAdapter({
      client,
      maxCompletionTokens: 400,
      tools: defaultTools({ defaultPlace: config.identity.place ?? '' }),
      timezone: config.identity.timezone,
      onToolCall: (record) => console.log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`),
    });
  }
  return new DshBrainAdapter({
    transport: new CliDshTransport({
      dshHome: DSH_HOME,
      profile: DSH_PROFILE,
      cwd: REPO_ROOT,
      env: harnessEnv(),
      timeoutMs: 240_000,
      onDiagnostic: (line) => console.log(`[dsh] ${line}`),
    }),
    store,
  });
}

const engine = new ConversationEngine({ adapter: buildAdapter(), store, config, turnTimeoutMs: 90_000 });

let session = store.latestSession() ?? store.createSession();

// ---------------------------------------------------------------- proactive card (t42)
// Same core as the field-test console (imported from `scripts/field-test.ts`), its own store
// (`data/web-chat`): tuning this page does not silently retune the console's dataset.
let proactiveSnapshot = restoreProactiveSettings(store, config.proactive as unknown as Record<string, unknown>);
function proactivePayload(): ProactiveConsoleState & { readonly ok: true } {
  return {
    ok: true,
    ...proactiveConsoleState({
      store,
      settings: proactiveSnapshot.settings,
      source: proactiveSnapshot.source,
      updatedAt: proactiveSnapshot.updatedAt,
      changes: proactiveSnapshot.changes,
      now: new Date(),
      proactivity: effectiveProactivity(store.selfProfile()),
    }),
  };
}

// Resident consideration loop (t70): same core as the console, off until the page asks for it.
let turnInFlight = false;
const presenceStorePath = join(REPO_ROOT, 'data');
const loopSynthesize = TTS_ENABLED && client.hasKey ? async (text: string): Promise<Buffer> => await client.synthesize(text) : undefined;
const proactiveLoop = new ProactiveLoop({
  store,
  readSettings: () => proactiveSnapshot.settings,
  readState: () => engine.state,
  readInFlightTurn: () => turnInFlight,
  readProactivity: () => effectiveProactivity(store.selfProfile()),
  readPresence: async () => {
    const view = await readPresence({ store: openXixiStore({ dataDir: presenceStorePath }) });
    return view === null ? null : { present: view.present, updatedAt: view.updatedAt, source: view.source };
  },
  readLastUserTurnAt: () => lastUserTurnAt(store, session.sessionId),
  readSessionId: () => session.sessionId,
  replyLimits: config.reply,
  synthesize: loopSynthesize,
  log: (line) => console.log(line),
});
function loopPayload(cursor: number): Record<string, unknown> {
  const since = proactiveLoop.messagesSince(Number.isFinite(cursor) ? cursor : 0);
  return {
    ok: true,
    status: proactiveLoop.status(),
    cursor: since.cursor,
    entries: since.entries,
    minIntervalMs: MIN_LOOP_INTERVAL_MS,
    defaultIntervalMs: DEFAULT_LOOP_INTERVAL_MS,
    tts: {
      available: loopSynthesize !== undefined,
      note:
        loopSynthesize !== undefined
          ? '放行时会用真实 TTS 逐段合成，并在页面上逐条播出来。'
          : '当前没有可用密钥或朗读被关掉：放行时只显示文字，不会发声（这会在每条记录里写明）。',
    },
  };
}

interface TurnBody {
  readonly text?: string;
  readonly speak?: boolean;
  /** Base64 WAV captured by the browser (16-bit PCM). */
  readonly audioBase64?: string;
}

const voiceDeps: VoiceDeps = {
  python: PYTHON,
  voiceDir: VOICE_DIR,
  client,
  engine,
  currentSessionId: () => session.sessionId,
  ttsEnabled: TTS_ENABLED,
  policy,
  log: (line) => console.log(line),
};

/**
 * Voice turn, delegated to the shared core in `scripts/field-test.ts`.
 *
 * Why not inline any more: this handler used to write the whole recording to
 * `data/voice-web/capture-*.wav` *before* the VAD (even when there was no speech,
 * and with no cleanup), and it silently kept only `segments[0]`. Both are fixed in
 * one place now, so this page and the field-test console cannot drift apart.
 */
async function handleVoice(body: TurnBody, response: ServerResponse): Promise<void> {
  const result = await handleVoiceTurn(voiceDeps, body as VoiceTurnBody);
  // The voice path returns the same reply text; re-deriving the plan with the same pure
  // function the engine uses keeps the page's playback identical to a typed turn.
  const plan = segmentPlan(typeof result.reply === 'string' ? result.reply : null, config.reply);
  json(response, 200, { ...result, source: 'reply', sourceLabel: '回应你', segments: plan.segments, segmentGapMs: plan.gapMs, segmentSummary: plan.summary });
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<TurnBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as TurnBody;
  } catch {
    return {};
  }
}

async function handleTurn(body: TurnBody, response: ServerResponse): Promise<void> {
  const text = (body.text ?? '').trim();
  if (text.length === 0) throw new ConsoleError('EMPTY_MESSAGE', '没有输入文字', '在输入框里打一句话再按发送');
  // IDLE 时把这一次点击当作直呼（M2 之前用按钮代替唤醒词），会话开着就按继续处理。
  const addressed = engine.state === 'IDLE';
  const turn = await engine.respond({ sessionId: session.sessionId, text, addressed });

  let audio: string | null = null;
  if (TTS_ENABLED && body.speak !== false && turn.action === 'SPEAK' && turn.text !== null) {
    audio = (await client.synthesize(turn.text)).toString('base64');
  }
  // `segments`/`segmentGapMs` are the engine's own plan (ADR-0010): the page plays them one by
  // one with that pause instead of dropping a wall of text, and labels the source as 回应你.
  const plan = segmentPlan(turn.text, config.reply);
  json(response, 200, {
    reply: turn.text,
    action: turn.action,
    accepted: turn.accepted,
    reason: turn.reason,
    state: turn.state,
    latencyMs: turn.latencyMs,
    firstTokenMs: turn.firstTokenMs,
    model: turn.model,
    audio,
    at: toOffsetIso(),
    source: 'reply',
    sourceLabel: '回应你',
    segments: turn.segments.length > 0 ? turn.segments : plan.segments,
    segmentGapMs: turn.segments.length > 0 ? turn.segmentGapMs : plan.gapMs,
    segmentSummary: plan.summary,
  });
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const recent = store.recentTurns(session.sessionId, 20).map((turn) => ({
          role: turn.role,
          text: turn.text,
          action: turn.action,
          toolName: turn.toolName,
        }));
        json(response, 200, {
          sessionId: session.sessionId,
          turnCount: store.getSession(session.sessionId).turnCount,
          state: engine.state,
          personality: store.selfProfile(),
          identity: config.identity,
          adapter: engine.adapter.describe(),
          recent,
          // Which SQLite file this page writes to (t42 acceptance item 3): four entry points,
          // four stores — the note tells the user that persona/history from `npm run chat`
          // does not appear here.
          database: { path: DATA_DIR, entries: XIXI_DB_ENTRIES, note: '四个入口各用不同的库；在 chat 里设的人格与历史不会带到这里' },
          segmentPlayback: { textSegmented: true, ttsSegmented: false, note: SEGMENT_TTS_NOTE },
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/turn') {
        await handleTurn(await readBody(request), response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/voice') {
        await handleVoice(await readBody(request), response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/quiet') {
        const body = await readBody(request);
        if (body.text === 'resume') engine.resume();
        else engine.quiet();
        json(response, 200, { state: engine.state });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/session') {
        session = store.createSession();
        engine.resume();
        json(response, 200, { sessionId: session.sessionId });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/proactive') {
        json(response, 200, proactivePayload());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/proactive/loop') {
        json(response, 200, loopPayload(Number(url.searchParams.get('cursor') ?? '0')));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/proactive/loop') {
        const body = (await readBody(request)) as Record<string, unknown>;
        const action = typeof body['action'] === 'string' ? body['action'] : 'tick';
        if (action === 'start') proactiveLoop.start(typeof body['intervalMs'] === 'number' ? body['intervalMs'] : undefined);
        else if (action === 'stop') proactiveLoop.stop();
        else if (action === 'tick') await proactiveLoop.tickOnce();
        else throw new ConsoleError('UNKNOWN_LOOP_ACTION', `不认识的循环操作「${action}」`, '可用：start（开始自动考虑）、stop（停止）、tick（立刻考虑一次）');
        json(response, 200, loopPayload(Number(body['cursor'] ?? 0)));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/proactive/settings') {
        const body = (await readBody(request)) as Record<string, unknown>;
        // Shared with the field-test console (t63): engine settings + the personality write
        // (proactivity → self_profile) + one audit row, in that order.
        const applied = applyAndPersistProactivePatch({
          store,
          settings: proactiveSnapshot.settings,
          patch: body,
          proactivityBefore: effectiveProactivity(store.selfProfile()),
          log: (line) => console.log(line),
        });
        if (applied.changes.length > 0) {
          proactiveSnapshot = { settings: applied.settings, source: 'console', updatedAt: applied.auditAt ?? proactiveSnapshot.updatedAt, changes: applied.changes };
        }
        json(response, 200, {
          ok: true,
          changes: applied.changes,
          rejected: applied.rejected,
          proactivity: applied.proactivity,
          auditSequence: applied.auditSequence,
          state: proactivePayload(),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/proactive/drill') {
        const body = (await readBody(request)) as Record<string, unknown>;
        const drill = await proactiveDrill({
          store,
          settings: proactiveSnapshot.settings,
          now: new Date(),
          conversationState: engine.state,
          inFlightTurn: false,
          proactivity: effectiveProactivity(store.selfProfile()),
          sessionId: session.sessionId,
          replyLimits: config.reply,
          request: body,
        });
        console.log(`[proactive] 演练 ${drill.trigger} → ${drill.reasonCode}（分数 ${drill.score}/${drill.threshold}${drill.speak ? `，分 ${drill.segments.length} 段` : ''}）`);
        json(response, 200, { ok: true, drill, state: proactivePayload() });
        return;
      }
      json(response, 404, { error: 'not found' });
    } catch (error) {
      // Readable Chinese errors, never a blank page or a raw stack (§20 audit item).
      if (error instanceof ConsoleError) {
        json(response, error.status, { ok: false, error: error.message, hint: error.hint, code: error.code });
        return;
      }
      console.error(`[error] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      const message = error instanceof Error ? error.message : String(error);
      const missingKey = /MISSING_KEY|api.?key is not set/i.test(message);
      json(response, missingKey ? 503 : 500, {
        ok: false,
        error: missingKey ? '缺少 MIMO_API_KEY：模型调用用不了' : `服务端出错了：${message}`,
        hint: missingKey
          ? '把 .env.example 复制成 .env 并填入 MIMO_API_KEY，然后重启；没有密钥时可用 npm run chat -- --fake 或 npm run field-test -- --offline'
          : '页面不会白屏；完整堆栈在这个终端里，请发给维护者。想用「一条命令」的现场测试控制台：npm run field-test',
      });
    }
  })();
});

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>和西西说话</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font-family: system-ui, "Microsoft YaHei", sans-serif; background:#0f1115; color:#e8e8ea; }
  header { padding:14px 18px; border-bottom:1px solid #262a33; display:flex; gap:12px; align-items:center; flex-wrap:wrap; font-size:13px; color:#9aa3b2; }
  header b { color:#e8e8ea; font-size:15px; }
  #log { padding:16px; display:flex; flex-direction:column; gap:10px; max-width:820px; margin:0 auto; }
  .row { display:flex; }
  .row.user { justify-content:flex-end; }
  .bubble { max-width:78%; padding:10px 13px; border-radius:14px; line-height:1.55; white-space:pre-wrap; }
  .user .bubble { background:#2b6cb0; color:#fff; border-bottom-right-radius:4px; }
  .xixi .bubble { background:#1c2028; border:1px solid #2a2f3a; border-bottom-left-radius:4px; }
  .silent .bubble { background:transparent; border:1px dashed #3a4150; color:#8b93a3; font-style:italic; }
  .meta { font-size:11px; color:#7c869a; margin-top:5px; }
  footer { position:sticky; bottom:0; background:#0f1115; border-top:1px solid #262a33; padding:12px; }
  form { max-width:820px; margin:0 auto; display:flex; gap:8px; }
  input[type=text] { flex:1; padding:12px 14px; border-radius:12px; border:1px solid #2a2f3a; background:#161a21; color:#e8e8ea; font-size:15px; }
  button { padding:12px 16px; border-radius:12px; border:1px solid #2a2f3a; background:#1c2028; color:#e8e8ea; font-size:14px; cursor:pointer; }
  button.primary { background:#2b6cb0; border-color:#2b6cb0; color:#fff; }
  label { font-size:12px; color:#9aa3b2; display:flex; align-items:center; gap:6px; }
  .hint { max-width:820px; margin:8px auto 0; font-size:12px; color:#7c869a; }
  .badge { font-size:11px; color:#9aa3b2; margin-bottom:4px; }
  .badge.reply { color:#8fb8ff; }
  .badge.proactive { color:#ffd479; }
  .seg { font-size:11px; color:#7c869a; margin-top:3px; }
  .card { max-width:820px; margin:14px auto; padding:12px 14px; border:1px solid #262a33; border-radius:12px; background:#13161c; }
  .card h2 { font-size:15px; margin:0 0 8px; }
  .card h3 { color:#c8cfdb; font-weight:600; }
  .card input[type=number], .card input[type=text] { padding:6px 8px; border-radius:8px; border:1px solid #2a2f3a; background:#161a21; color:#e8e8ea; font-size:13px; }
  .card button { padding:8px 12px; font-size:13px; }
  .muted { color:#7c869a; font-size:12px; }
${PROACTIVE_PANEL_CSS}
</style></head>
<body>
<header>
  <b>西西</b>
  <span id="banner">加载中…</span>
  <span style="flex:1"></span>
  <label><input type="checkbox" id="speak" checked /> 朗读回复</label>
  <button id="quiet">今天安静点</button>
  <button id="new">新会话</button>
</header>
<div id="log"></div>
<div class="card">${databaseNoteHtml(DATA_DIR)}</div>
<div class="card" style="border-color:#5c4a22; background:#2a2314; color:#ffe6b8">${SEGMENT_TTS_NOTE}</div>
${proactivePanelHtml()}
<footer>
  <form id="form">
    <input type="text" id="input" placeholder="直接打字，或按住右边的麦克风说话" autocomplete="off" />
    <button class="primary" type="submit">发送</button>
    <button type="button" id="mic" title="按住说话，松开结束">🎤 按住说</button>
  </form>
  <div class="hint" id="hint">打字或按麦克风说话（第一句视为叫醒西西）。语音只把 VAD 检出的语音段送去识别，整段录音不落盘；回复由浏览器播放。</div>
</footer>
<script>
${proactivePanelScript('/api')}
const log = document.getElementById('log');
const banner = document.getElementById('banner');
const input = document.getElementById('input');
const speakBox = document.getElementById('speak');
const form = document.getElementById('form');
const micButton = document.getElementById('mic');
const hint = document.getElementById('hint');

function setBanner(state) {
  banner.textContent = '会话 ' + state.sessionId.slice(5, 13) + ' · ' + state.turnCount + ' 轮 · ' + state.state
    + ' · ' + (state.adapter ? state.adapter.provider : '?')
    + ' · 地点 ' + (state.identity.place ?? '未设置')
    + (state.database ? ' · 库 ' + state.database.path : '');
}

/** Float32 samples → 16-bit PCM WAV (mono). */
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeText(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

let recorder = null;
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (event) => { chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
  source.connect(processor);
  processor.connect(context.destination);
  recorder = { stream, context, source, processor, chunks, sampleRate: context.sampleRate, startedAt: Date.now() };
  micButton.textContent = '⏺ 松开发送';
  hint.textContent = '正在录音…（松开按钮结束）';
}

async function stopRecording() {
  if (!recorder) return;
  const current = recorder;
  recorder = null;
  micButton.textContent = '🎤 按住说';
  current.processor.disconnect();
  current.source.disconnect();
  current.stream.getTracks().forEach((track) => track.stop());
  await current.context.close();

  const total = current.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const seconds = total / current.sampleRate;
  if (seconds < 0.3) { hint.textContent = '太短了，按住多说一会儿。'; return; }

  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of current.chunks) { merged.set(chunk, offset); offset += chunk.length; }

  hint.textContent = '录音 ' + seconds.toFixed(1) + 's，正在识别…';
  const pending = add('xixi', '…');
  try {
    const response = await fetch('/api/voice', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: toBase64(encodeWav(merged, current.sampleRate)), speak: speakBox.checked }),
    });
    const data = await response.json();
    pending.parentElement.remove();
    if (data.ok === false) {
      add('xixi', '语音没成功：' + data.error, data.hint ?? '');
      hint.textContent = '语音没成功：' + data.error + (data.hint ? '（' + data.hint + '）' : '');
      return;
    }
    if (data.reason === 'NO_SPEECH_DETECTED') {
      add('xixi silent', '（没有听清：麦克风里没检测到语音）', data.notes ? data.notes[data.notes.length - 1] : '');
    } else {
      if (data.transcript) add('user', data.transcript);
      const stages = data.stages ?? {};
      const meta = (data.actionText ?? data.action) + ' · ' + (data.reasonText ?? data.reason)
        + ' · VAD ' + Math.round(stages.vadMs ?? 0) + 'ms · ASR ' + Math.round(stages.asrMs ?? 0) + 'ms'
        + ' · 首字 ' + (stages.llmFirstChunkMs == null ? '—' : Math.round(stages.llmFirstChunkMs) + 'ms')
        + ' · 总 ' + Math.round(stages.totalMs ?? data.totalMs ?? 0) + 'ms'
        + ' · 语音段 ' + data.segmentsUsed + '/' + data.segmentsTotal + (data.droppedSegments && data.droppedSegments.length ? '（丢弃' + data.droppedSegments.length + '段）' : '')
        + ' · ' + data.state;
      if (data.action === 'SILENCE' || data.accepted === false) add('xixi silent', data.accepted === false ? '（这句不是对西西说的）' : '（西西选择沉默）', meta);
      else addSegmented('xixi', data.sourceLabel ?? '回应你', data.segments, data.segmentGapMs ?? 450, meta);
      if (data.audio) new Audio('data:audio/wav;base64,' + data.audio).play().catch(() => {});
      if (data.privacy) hint.textContent = data.privacy.note;
    }
    setBanner(await (await fetch('/api/state')).json());
    hint.textContent = '说完松开即发送。回复可朗读（右上角开关）。整段录音不落盘。';
  } catch (error) {
    pending.parentElement.remove();
    add('xixi', '语音出错：' + error.message);
    hint.textContent = '语音出错：' + error.message;
  }
}

micButton.addEventListener('pointerdown', async (event) => {
  event.preventDefault();
  try { await startRecording(); } catch (error) { hint.textContent = '无法访问麦克风：' + error.message; }
});
micButton.addEventListener('pointerup', (event) => { event.preventDefault(); stopRecording(); });
micButton.addEventListener('pointerleave', () => { if (recorder) stopRecording(); });

function add(role, text, meta, source) {
  const row = document.createElement('div');
  row.className = 'row ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  const wrap = document.createElement('div');
  wrap.appendChild(bubble);
  if (meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; wrap.appendChild(m); }
  row.appendChild(wrap);
  log.appendChild(row);
  window.scrollTo(0, document.body.scrollHeight);
  return bubble;
}

/**
 * Say a reply the way the engine says it: one segment at a time, gapMs apart (ADR-0010).
 *
 * The first segment replaces the "…" placeholder; each later one is appended after the real
 * pause, and every bubble carries 「第 i/N 段 · 间隔 xms」 so a user watching the screen can
 * tell "还有一段没到" from "只回了一句".
 */
/**
 * A spoken proactive message also belongs in the conversation log (t70): the shared panel
 * calls this hook when the resident loop actually says something, so the page shows
 * 「主动开口」 in the same stream as replies — with the same per-segment playback.
 */
window.pxOnProactiveMessage = function (entry) {
  if (!entry || entry.speak !== true) return;
  addSegmented('xixi', '主动开口', entry.segments, entry.gapMs, '触发源 ' + entry.trigger + ' · 分数 ' + entry.score + '/' + entry.threshold);
};

function addSegmented(role, label, segments, gapMs, meta) {  const list = Array.isArray(segments) && segments.length > 0 ? segments : [''];
  const badgeText = label ? label + ' · 第 1/' + list.length + ' 段' : null;
  const first = add(role, list[0], null);
  const wrap = first.parentElement;
  if (badgeText) {
    const badge = document.createElement('div');
    badge.className = 'badge ' + (label === '主动开口' ? 'proactive' : 'reply');
    badge.textContent = badgeText + (list.length > 1 ? '（段间 ' + gapMs + 'ms，会逐条出现）' : '');
    wrap.insertBefore(badge, first);
  }
  if (meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; wrap.appendChild(m); }
  for (let index = 1; index < list.length; index += 1) {
    window.setTimeout(function () {
      const bubble = add(role, list[index]);
      const badge = document.createElement('div');
      badge.className = 'badge ' + (label === '主动开口' ? 'proactive' : 'reply');
      badge.textContent = (label ? label + ' · ' : '') + '第 ' + (index + 1) + '/' + list.length + ' 段';
      bubble.parentElement.insertBefore(badge, bubble);
    }, gapMs * index);
  }
  return first;
}

async function refresh() {
  const state = await (await fetch('/api/state')).json();
  setBanner(state);
  log.innerHTML = '';
  for (const turn of state.recent) {
    if (turn.role === 'user') add('user', turn.text ?? '');
    else if (turn.action === 'SILENCE') add('xixi silent', '（西西选择沉默）', 'SILENCE');
    else add('xixi', turn.text ?? '', (turn.toolName ? '工具：' + turn.toolName : ''));
  }
  if (state.recent.length === 0) add('xixi', '我在。想说什么就说吧。');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.disabled = true;
  add('user', text);
  const pending = add('xixi', '…');
  try {
    const response = await fetch('/api/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, speak: speakBox.checked }),
    });
    const data = await response.json();
    const meta = (data.actionText ?? (data.accepted ? data.action : '未接受(' + data.reason + ')'))
      + ' · ' + data.latencyMs + 'ms' + (data.firstTokenMs == null ? '' : ' · 首字' + data.firstTokenMs + 'ms')
      + ' · ' + data.state;
    pending.parentElement.remove();
    if (data.ok === false) { add('xixi', '出错了：' + data.error, data.hint ?? ''); return; }
    if (data.action === 'SILENCE' || !data.accepted) add('xixi silent', data.accepted ? '（西西选择沉默）' : '（这句不是对西西说的）', meta);
    else addSegmented('xixi', data.sourceLabel ?? '回应你', data.segments, data.segmentGapMs ?? 450, meta);
    if (data.audio) { const audio = new Audio('data:audio/wav;base64,' + data.audio); audio.play().catch(() => {}); }
    setBanner(await (await fetch('/api/state')).json());
  } catch (error) {
    pending.parentElement.remove();
    add('xixi', '出错了：' + error.message);
  } finally {
    input.disabled = false;
    input.focus();
  }
});

document.getElementById('quiet').addEventListener('click', async () => {
  const state = await (await fetch('/api/quiet', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' })).json();
  banner.textContent = banner.textContent.split(' · ')[0] + ' · ' + banner.textContent.split(' · ')[1] + ' · ' + state.state;
  add('xixi silent', '（安静模式：现在叫西西也不接话，点“新会话”或刷新可恢复）');
});
document.getElementById('new').addEventListener('click', async () => {
  await fetch('/api/session', { method: 'POST' });
  await refresh();
});

refresh();
input.focus();
</script>
</body></html>`;

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用（可能已经开着一个 npm run web 或现场测试控制台）。`);
    console.error(`换一个端口：npm run web -- --port ${PORT + 1}；或先关掉占用该端口的程序。`);
    console.error('想用「一条命令」的现场测试控制台（含设备验收）：npm run field-test');
  } else {
    console.error(`无法在本机监听 ${PORT}：${error.message}`);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  // `--port 0` binds an ephemeral port; printing the *bound* one lets the console tests
  // drive this page without guessing (and is more honest for a user who typed 0 by accident).
  const bound = server.address();
  const actualPort = typeof bound === 'object' && bound !== null ? bound.port : PORT;
  console.log(`西西试用页面： http://127.0.0.1:${actualPort}`);
  console.log(
    `大脑 ${USE_FAKE ? '离线替身（--fake，不联网、不花钱）' : USE_DSH ? 'DSH Harness（每轮启动 profile，较慢）' : '直连 MiMo（实时路径）'}` +
      `｜身份 ${config.identity.name}｜地点 ${config.identity.place ?? '未设置'}｜朗读回复 ${TTS_ENABLED ? '开' : '关'}`,
  );
  console.log(`会话 ${session.sessionId}`);
  console.log('多段回复（ADR-0010）：西西的回复会按段逐条出现，段间停 450ms；页面上标着「第 i/N 段」。');
  console.log('主动性：页面底部那块可以开关主动开口、调冷却/额度/静默时段，并能看每道门禁的判定。');
  console.log('语音输入：页面按住🎤说话（浏览器采集，只把 VAD 检出的语音段送去识别，整段录音不落盘）。按 Ctrl+C 结束。');
  console.log('现场测试（一条命令、含设备验收与实时状态页）：npm run field-test');
});
