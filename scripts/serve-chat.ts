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
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DshBrainAdapter, MimoBrainAdapter, defaultTools, type BrainAdapter } from '@xixi/brain-adapter';
import { CliDshTransport } from '@xixi/brain-dsh';
import { ConversationEngine } from '@xixi/conversation';
import { MimoClient } from '@xixi/model-adapters';
import { openXixiStore } from '@xixi/domain';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, readDotEnv } from './lib/harness.ts';
import { readWav, sliceWav } from './lib/wav.ts';
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
const PYTHON = process.env.XIXI_PYTHON ?? join(REPO_ROOT, '.venvs', 'voice-pipecat', 'Scripts', 'python.exe');
const VOICE_DIR = join(REPO_ROOT, 'data', 'voice-web');

const config = loadConfig();
const client = new MimoClient();
const store = openXixiStore({ dataDir: join(REPO_ROOT, 'data', 'web-chat') });
store.seedSelfProfile(config.personality.base);

function buildAdapter(): BrainAdapter {
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

interface TurnBody {
  readonly text?: string;
  readonly speak?: boolean;
  /** Base64 WAV captured by the browser (16-bit PCM). */
  readonly audioBase64?: string;
}

/** Run the VAD segmenter over a WAV and return its JSON result. */
function runVad(wavPath: string): Promise<{ segments: { startMs: number; endMs: number }[]; bargeInDecisionMs: number | null; timings?: { processMs: number } }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-m', 'voice_edge.segment', wavPath], {
      cwd: join(REPO_ROOT, 'services', 'voice-edge'),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
    });
    child.stderr.on('data', (data: string) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // Exit 2 means "no speech found", which is a result rather than a failure.
      if (code === 0 || code === 2) {
        try {
          resolve(JSON.parse(stdout));
        } catch (cause) {
          reject(new Error(`VAD 输出无法解析：${cause instanceof Error ? cause.message : String(cause)}`));
        }
      } else {
        reject(new Error(`VAD 失败（exit ${code}）：${stderr.slice(-300)}`));
      }
    });
  });
}

/**
 * Voice turn: browser capture → VAD (only the speech span) → ASR → conversation → TTS.
 *
 * The browser captures because the Python `sounddevice` path on this machine
 * delivered no speech-band signal (docs/recon/device-acceptance-2026-09-30.md);
 * the browser brings its own device selection, echo cancellation and noise
 * suppression, which is a genuinely different audio front end.
 */
async function handleVoice(body: TurnBody, response: ServerResponse): Promise<void> {
  if (typeof body.audioBase64 !== 'string' || body.audioBase64.length === 0) throw new Error('没有收到音频');
  mkdirSync(VOICE_DIR, { recursive: true });
  const stamp = Date.now();
  const rawPath = join(VOICE_DIR, `capture-${stamp}.wav`);
  writeFileSync(rawPath, Buffer.from(body.audioBase64, 'base64'));

  const vadStarted = Date.now();
  const vad = await runVad(rawPath);
  const vadMs = Date.now() - vadStarted;
  const speech = vad.segments[0];
  if (speech === undefined) {
    json(response, 200, {
      accepted: false,
      reason: 'NO_SPEECH_DETECTED',
      transcript: null,
      reply: null,
      action: 'SILENCE',
      state: engine.state,
      vadMs,
      latencyMs: vadMs,
      firstTokenMs: null,
      audio: null,
      note: '麦克风里没有检测到语音（音量过低、被静音，或设备选错）',
    });
    return;
  }

  // Only the speech span reaches the model (§20.1).
  const speechPath = join(VOICE_DIR, `speech-${stamp}.wav`);
  writeFileSync(speechPath, sliceWav(readWav(rawPath), speech.startMs, speech.endMs));

  const asrStarted = Date.now();
  const transcript = (await client.transcribe(readWav(speechPath))).text;
  const asrMs = Date.now() - asrStarted;

  const turn = await engine.respond({ sessionId: session.sessionId, text: transcript, addressed: engine.state === 'IDLE' });
  let audio: string | null = null;
  if (TTS_ENABLED && body.speak !== false && turn.action === 'SPEAK' && turn.text !== null) {
    audio = (await client.synthesize(turn.text)).toString('base64');
  }
  json(response, 200, {
    accepted: turn.accepted,
    reason: turn.reason,
    transcript,
    reply: turn.text,
    action: turn.action,
    state: turn.state,
    latencyMs: turn.latencyMs,
    firstTokenMs: turn.firstTokenMs,
    model: turn.model,
    audio,
    speech: { startMs: speech.startMs, endMs: speech.endMs },
    vadMs,
    asrMs,
  });
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
  if (text.length === 0) throw new Error('空消息');
  // IDLE 时把这一次点击当作直呼（M2 之前用按钮代替唤醒词），会话开着就按继续处理。
  const addressed = engine.state === 'IDLE';
  const turn = await engine.respond({ sessionId: session.sessionId, text, addressed });

  let audio: string | null = null;
  if (TTS_ENABLED && body.speak !== false && turn.action === 'SPEAK' && turn.text !== null) {
    audio = (await client.synthesize(turn.text)).toString('base64');
  }
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
      json(response, 404, { error: 'not found' });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
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
<footer>
  <form id="form">
    <input type="text" id="input" placeholder="直接打字，或按住右边的麦克风说话" autocomplete="off" />
    <button class="primary" type="submit">发送</button>
    <button type="button" id="mic" title="按住说话，松开结束">🎤 按住说</button>
  </form>
  <div class="hint" id="hint">打字或按麦克风说话（第一句视为叫醒西西）。语音只上传检测到的语音段；回复由浏览器播放。</div>
</footer>
<script>
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
    + ' · 地点 ' + (state.identity.place ?? '未设置');
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
    if (data.reason === 'NO_SPEECH_DETECTED') {
      add('xixi silent', '（没有听清：麦克风里没检测到语音）', data.note ?? '');
    } else {
      if (data.transcript) add('user', data.transcript);
      const meta = (data.accepted ? data.action : '未接受(' + data.reason + ')')
        + ' · 录音 ' + (data.vadMs + data.asrMs) + 'ms 处理' + ' · ' + data.latencyMs + 'ms'
        + (data.firstTokenMs == null ? '' : ' · 首字' + data.firstTokenMs + 'ms') + ' · ' + data.state;
      if (data.action === 'SILENCE' || !data.accepted) add('xixi silent', '（西西选择沉默）', meta);
      else add('xixi', data.reply ?? '', meta);
      if (data.audio) new Audio('data:audio/wav;base64,' + data.audio).play().catch(() => {});
    }
    setBanner(await (await fetch('/api/state')).json());
    hint.textContent = '说完松开即发送。回复可朗读（右上角开关）。';
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

function add(role, text, meta) {
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
    const meta = (data.accepted ? data.action : '未接受(' + data.reason + ')')
      + ' · ' + data.latencyMs + 'ms' + (data.firstTokenMs == null ? '' : ' · 首字' + data.firstTokenMs + 'ms')
      + ' · ' + data.state;
    pending.parentElement.remove();
    if (data.action === 'SILENCE' || !data.accepted) add('xixi silent', data.accepted ? '（西西选择沉默）' : '（这句不是对西西说的）', meta);
    else add('xixi', data.reply ?? '', meta);
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`西西试用页面： http://127.0.0.1:${PORT}`);
  console.log(
    `大脑 ${USE_DSH ? 'DSH Harness（每轮启动 profile，较慢）' : '直连 MiMo（实时路径）'}` +
      `｜身份 ${config.identity.name}｜地点 ${config.identity.place ?? '未设置'}｜朗读回复 ${TTS_ENABLED ? '开' : '关'}`,
  );
  console.log(`会话 ${session.sessionId}`);
  console.log('语音输入：页面按住🎤说话（浏览器采集，只上传检测到的语音段）。按 Ctrl+C 结束。');
});
