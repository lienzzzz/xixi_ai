/**
 * Generate Chinese audio fixtures with MiMo TTS (`mimo-v2.5-tts`).
 *
 * The M1 turn-taking spike must run on real Chinese speech, not on tones: VAD
 * and end-of-utterance behaviour depend on the signal. Fixtures land in
 * `tests/audio-fixtures/` (§24) and are reused later by M2's TV/誤唤醒 tests.
 *
 * Costs a few TTS calls; run manually, not in `npm test`.
 *
 * Usage: node scripts/make-audio-fixtures.ts [--force]
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, printEvidence, readDotEnv, requireMimoApiKey } from './lib/harness.ts';

const OUT_DIR = join(REPO_ROOT, 'tests', 'audio-fixtures');

/** id → the text a real user/TV would say. `speaker` documents who this clip stands for. */
const FIXTURES = [
  { id: 'direct-question', text: '西西，明天天气怎么样？', speaker: 'father, direct address (wake word present)' },
  { id: 'followup-turn', text: '对了，还有个事想问你。', speaker: 'father, conversational continuation' },
  { id: 'backchannel', text: '嗯。', speaker: 'father, backchannel (must not count as an interruption)' },
  { id: 'longer-turn', text: '我明天下午去镇上办点事，可能要到晚上才回来。', speaker: 'father, longer utterance for endpointing' },
  { id: 'tv-dialogue', text: '明天天气怎么样？', speaker: 'television audio (same words, no wake word)' },
];

function voiceFor(): string {
  return process.env.MIMO_TTS_VOICE ?? 'mimo_default';
}

async function synthesize(text: string, apiKey: string): Promise<Buffer> {
  const response = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: text }],
      audio: { format: 'wav', voice: voiceFor() },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json()) as {
    choices?: { message?: { audio?: { data?: string } } }[];
    error?: { message?: string; code?: string };
  };
  if (!response.ok) {
    throw new Error(`TTS failed (HTTP ${response.status}): ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
  }
  const encoded = body.choices?.[0]?.message?.audio?.data;
  if (encoded === undefined || encoded.length === 0) {
    throw new Error(`TTS returned no audio payload: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return Buffer.from(encoded, 'base64');
}

/** Minimal WAV header reader so the fixtures report their real format. */
function describeWav(file: Buffer): { sampleRate: number; channels: number; bitsPerSample: number; seconds: number } {
  const sampleRate = file.readUInt32LE(24);
  const channels = file.readUInt16LE(22);
  const bitsPerSample = file.readUInt16LE(34);
  const dataBytes = wavDataBytes(file);
  const frames = dataBytes / (channels * (bitsPerSample / 8));
  return { sampleRate, channels, bitsPerSample, seconds: Number((frames / sampleRate).toFixed(2)) };
}

function wavDataBytes(file: Buffer): number {
  // Walk the chunks instead of assuming a 44-byte header: TTS output may carry
  // extra chunks, and a wrong offset silently corrupts the fixture.
  let offset = 12;
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    if (id === 'data') return Math.min(size, file.length - offset - 8);
    offset += 8 + size + (size % 2);
  }
  return Math.max(0, file.length - 44);
}

/**
 * Append trailing silence.
 *
 * The LiveKit spike found `followup-turn.wav` ended mid-speech (last-5 ms RMS
 * 236 vs noise floor 44), which makes any "true end of speech" estimate for it
 * uncertain by ±107 ms and would corrupt endpointing assertions. Real calls end
 * with a pause, so fixtures must too.
 */
function padTail(wav: Buffer, milliseconds: number): Buffer {
  const channels = wav.readUInt16LE(22);
  const bitsPerSample = wav.readUInt16LE(34);
  const sampleRate = wav.readUInt32LE(24);
  const dataBytes = wavDataBytes(wav);
  const frames = Math.round((milliseconds / 1000) * sampleRate);
  const silence = Buffer.alloc(frames * channels * (bitsPerSample / 8));
  const dataOffset = wav.length - dataBytes;
  const padded = Buffer.concat([wav.subarray(0, dataOffset), wav.subarray(dataOffset), silence]);
  padded.writeUInt32LE(dataBytes + silence.length, 4); // RIFF size
  padded.writeUInt32LE(dataBytes + silence.length, dataOffset - 4); // data chunk size
  return padded;
}

const apiKey = requireMimoApiKey();
readDotEnv();
mkdirSync(OUT_DIR, { recursive: true });
const force = process.argv.includes('--force');
const results: Record<string, unknown>[] = [];

for (const fixture of FIXTURES) {
  const target = join(OUT_DIR, `${fixture.id}.wav`);
  if (existsSync(target) && !force) {
    const existing = describeWav(await import('node:fs').then((fs) => fs.readFileSync(target)));
    results.push({ id: fixture.id, skipped: true, path: target.replace(REPO_ROOT + '\\', ''), ...existing });
    continue;
  }
  const raw = await synthesize(fixture.text, apiKey);
  // Every real utterance ends in a pause; without one, endpointing assertions
  // are measuring the file boundary rather than end of speech.
  const audio = padTail(raw, Number(process.env.MIMO_FIXTURE_TAIL_MS ?? 600));
  writeFileSync(target, audio);
  results.push({
    id: fixture.id,
    text: fixture.text,
    speaker: fixture.speaker,
    bytes: audio.length,
    path: target.replace(REPO_ROOT + '\\', ''),
    ...describeWav(audio),
  });
  process.stderr.write(`[tts] ${fixture.id}: ${audio.length} bytes\n`);
}

printEvidence('Chinese audio fixtures (MiMo TTS)', { voice: voiceFor(), directory: OUT_DIR.replace(REPO_ROOT + '\\', ''), fixtures: results });
