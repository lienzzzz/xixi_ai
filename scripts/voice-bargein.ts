/**
 * Barge-in (§14.2) measured offline.
 *
 * The recipe the plan asks for, minus the speaker:
 *   1. the assistant is "speaking" — its TTS reply is the playback source;
 *   2. the user starts talking part-way through that reply (a fixture);
 *   3. the voice edge detects real speech and decides to interrupt;
 *   4. playback stops and the未播放 buffer is dropped.
 *
 * What this measures: the *decision* latency from the moment the user's voice
 * actually begins to the moment the VAD commits to "speech started" — that is the
 * part our code controls. What it cannot measure offline: whether the speaker
 * actually goes silent (§33's P50 < 500 ms target covers the audible stop, which
 * needs a device test). The truncation is written out as a WAV so the result is
 * auditable rather than asserted.
 *
 * Usage:
 *   node scripts/voice-bargein.ts --bot data/voice/reply-1.wav --user tests/audio-fixtures/followup-turn.wav --at 800
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, printEvidence } from './lib/harness.ts';
import { readWav, readWavInfo, sliceWav } from './lib/wav.ts';

const PYTHON = process.env.XIXI_PYTHON ?? join(REPO_ROOT, '.venvs', 'voice-pipecat', 'Scripts', 'python.exe');
/** §33 target for "user starts speaking → stop playing". */
const TARGET_MS = 500;

interface Segmentation {
  energyStartMs: number | null;
  energyEndMs: number | null;
  bargeInDecisionMs: number | null;
  segments: { startMs: number; endMs: number }[];
  events: { atMs: number; state: string }[];
}

function runPython(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, { cwd: join(REPO_ROOT, 'services', 'voice-edge'), windowsHide: true });
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
    child.on('close', (code) => (code === 0 || code === 2 ? resolve(stdout) : reject(new Error(`VAD failed (${code}): ${stderr.slice(-300)}`))));
  });
}

const args = process.argv.slice(2);
function argValue(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? (args[index + 1] as string) : fallback;
}

const botPath = argValue('--bot', join(REPO_ROOT, 'data', 'voice', 'reply-1.wav'));
const userPath = argValue('--user', join(REPO_ROOT, 'tests', 'audio-fixtures', 'followup-turn.wav'));
const startsAtMs = Number(argValue('--at', '800'));

if (!existsSync(botPath)) {
  console.error(`找不到助手音频：${botPath}`);
  console.error('先运行 node scripts/voice-turn.ts --wav tests/audio-fixtures/direct-question.wav 生成一条回复音频。');
  process.exit(2);
}

const bot = readWav(botPath);
const botInfo = readWavInfo(bot);
const segmentation = JSON.parse(await runPython(['-m', 'voice_edge.segment', userPath])) as Segmentation;

const decisionMs = segmentation.bargeInDecisionMs;
const playbackStopAtMs = startsAtMs + (decisionMs ?? 0);
const clampedStop = Math.min(playbackStopAtMs, botInfo.durationMs);
const playedBeforeMs = Math.min(startsAtMs, botInfo.durationMs);
const droppedMs = Math.max(0, Math.round(botInfo.durationMs - clampedStop));

// The audible part of the interruption: playback is cut at the decision point.
mkdirSync(join(REPO_ROOT, 'data', 'voice'), { recursive: true });
const truncatedPath = join(REPO_ROOT, 'data', 'voice', 'bargein-truncated.wav');
writeFileSync(truncatedPath, sliceWav(bot, 0, clampedStop));

printEvidence('打断（离线测量，§14.2）', {
  botAudio: { path: botPath, durationMs: Math.round(botInfo.durationMs) },
  userAudio: { path: userPath, energyStartMs: segmentation.energyStartMs, bargeInDecisionMs: decisionMs },
  simulation: {
    userStartsAtMs: startsAtMs,
    playbackStopsAtMs: Math.round(clampedStop),
    playedBeforeInterruptionMs: Math.round(playedBeforeMs),
    droppedAudioMs: droppedMs,
    truncatedWav: truncatedPath,
  },
  vadEvents: segmentation.events,
  caveat: '离线只能验证「判定」延迟；扬声器真正静音的延迟需要设备验收（§33 的 P50 < 500ms 不在本次证据内）',
});

if (decisionMs === null) {
  console.error('FAILED：没有检测到用户语音，无法评估打断');
  process.exit(1);
}
if (decisionMs > TARGET_MS) {
  console.error(`FAILED：打断判定延迟 ${decisionMs}ms 超过目标 ${TARGET_MS}ms`);
  process.exit(1);
}
console.log(`\n打断判定延迟 ${decisionMs}ms ≤ ${TARGET_MS}ms 目标；播放已在 ${Math.round(clampedStop)}ms 处截断（丢弃 ${droppedMs}ms 未播音频）`);
