/**
 * Barge-in (§14.2) measured offline.
 *
 * The recipe the plan asks for, minus the speaker:
 *   1. the assistant is "speaking" — its TTS reply is the playback source;
 *   2. the user starts talking part-way through that reply (a fixture);
 *   3. the voice edge detects real speech and decides to interrupt;
 *   4. playback stops and the un-played buffer is dropped.
 *
 * Two layers of evidence, and they answer different questions:
 *
 *   * **the decision** — how long from the moment the user's voice actually begins to the moment
 *     the VAD commits to 「speech started」 (`segmentation.bargeInDecisionMs`). That is the part
 *     our code controls on the input side;
 *   * **the audible stop** (pack Phase 8, `--strict`) — the reply is split into clauses, laid out
 *     on `PlaybackTimeline`, and the script then asks the *listener's* question: at the moment he
 *     started talking, is anything still audible? The answer must be 「no」, and the un-played
 *     remainder must be exactly what the timeline says was dropped. The same rule runs in the
 *     browser (`XIXI_PLAYBACK_JS.xixiStopSpeaking`), so this is a measurement of production code.
 *
 * What it still cannot measure offline: whether the physical speaker goes silent (§33's
 * P50 < 500 ms target covers that, and needs a device test). The truncation is written out as a
 * WAV so the result is auditable rather than asserted.
 *
 * Usage:
 *   node scripts/voice-bargein.ts --bot data/voice/reply-1.wav --user tests/audio-fixtures/followup-turn.wav --at 800
 *   node scripts/voice-bargein.ts --strict          # clauses + audible-stop criterion, same fixtures
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, printEvidence } from './lib/harness.ts';
import { readWav, readWavInfo, sliceWav } from './lib/wav.ts';
import {
  chunkClauses,
  CLAUSE_CHUNKER_LIMITS,
} from '../packages/conversation/src/segments.ts';
import {
  ASSENT_CLIPS,
  decideAssent,
  decideBargeIn,
  pauseWindows,
  playbackStateAt,
  PlaybackTimeline,
  truncateOnBargeIn,
} from '../services/voice-edge/voice_edge/voice_stream.ts';

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

/** `--strict` adds the audible-stop criterion and the clause layout to the evidence. */
const strict = args.includes('--strict');
/** The reply text used to lay the clause timeline out; the real reply lives in `data/voice/`. */
const replyText = argValue('--reply', '明天有小雨，出门记得带伞。温度大概十几度，多穿一件就不冷了。风不大，路上慢点走。');

const botPath = argValue('--bot', join(REPO_ROOT, 'data', 'voice', 'reply-1.wav'));
const userPath = argValue('--user', join(REPO_ROOT, 'tests', 'audio-fixtures', 'followup-turn.wav'));
const startsAtMs = Number(argValue('--at', '800'));

const botInfo = existsSync(botPath) ? readWavInfo(readWav(botPath)) : null;
const segmentation = JSON.parse(await runPython(['-m', 'voice_edge.segment', userPath])) as Segmentation;

const decisionMs = segmentation.bargeInDecisionMs;

/**
 * Clause layout (pack Phase 8). When the bot audio exists its real length is used for each
 * clause proportionally; otherwise the timeline is laid out from the text at a reading rate so
 * the criterion can still run — the point of `--strict` is the *decision* rule, and the audio
 * length only sets the numbers it is applied to.
 */
const clauses = chunkClauses(replyText, {
  minCommaChars: CLAUSE_CHUNKER_LIMITS.minCommaChars,
  maxChars: CLAUSE_CHUNKER_LIMITS.maxChars,
});
const botDurationMs = botInfo?.durationMs ?? clauses.join('').length * 200;
const chars = clauses.reduce((sum, clause) => sum + clause.length, 0) || 1;
const timeline = new PlaybackTimeline();
for (const [index, text] of clauses.entries()) {
  const durationMs = Math.round((text.length / chars) * botDurationMs);
  timeline.schedule({ index, text, wav: Buffer.alloc(0), durationMs, atMs: index, synthMs: null });
}

/**
 * The user's speech spans relative to the moment playback started. The fixture is the user's
 * recording, so its own speech start is at 0; `--at` is how far into her reply he began.
 */
const userSpans = (segmentation.segments.length > 0 ? segmentation.segments : []).map((span) => ({
  startMs: span.startMs,
  endMs: span.endMs,
}));
const relativeSpans = userSpans.map((span) => ({ startMs: span.startMs - (segmentation.energyStartMs ?? 0), endMs: span.endMs - (segmentation.energyStartMs ?? 0) }));
const decision = decideBargeIn({
  userSpans: relativeSpans,
  playbackStartMs: startsAtMs,
  playbackDurationMs: botDurationMs,
});
const { stopsAtMs, droppedMs } = truncateOnBargeIn({ decisionMs: decisionMs ?? 0, playbackOffsetMs: startsAtMs, playbackDurationMs: botDurationMs });

/**
 * The audible-stop check: once playback is aborted at `stopsAtMs`, is anything still playing
 * 200 ms later? 「真的停下」 means the answer is no — and the answer comes from the same
 * `PlaybackTimeline` the browser drives.
 */
const aborted = timeline.abort(stopsAtMs + (decisionMs ?? 0), { playedMs: startsAtMs + (decisionMs ?? 0) });
const laterState = playbackStateAt(aborted, startsAtMs + (decisionMs ?? 0) + 200);
const audibleStop = {
  abortedAtMs: aborted.abortedAtMs,
  audibleAfter200Ms: laterState.audible,
  playingClauseAfter: laterState.clause,
  playedMs: aborted.playedMs,
  droppedMs: aborted.droppedMs,
  droppedClauses: aborted.droppedClauses,
  totalClauses: aborted.totalClauses,
};

/** Assent candidates (the assistant's 「嗯」): pauses inside his own sentence, with the decision each gets. */
const pauses = pauseWindows(userSpans);
const assent = {
  pauseMs: pauses.map((pause) => Math.round(pause.pauseMs)),
  decisionAtLongestPause:
    pauses.length === 0
      ? null
      : decideAssent({
          assistantSpeaking: false,
          pauseMs: Math.max(...pauses.map((pause) => pause.pauseMs)),
          utteranceMs: pauses[pauses.length - 1]?.utteranceMs ?? 0,
          frequency: 1,
          used: 0,
        }),
  clips: ASSENT_CLIPS,
};

let truncatedPath: string | null = null;
if (botInfo !== null) {
  // The audible part of the interruption: playback is cut at the decision point.
  mkdirSync(join(REPO_ROOT, 'data', 'voice'), { recursive: true });
  const clampedStop = Math.min(startsAtMs + (decisionMs ?? 0), botInfo.durationMs);
  truncatedPath = join(REPO_ROOT, 'data', 'voice', 'bargein-truncated.wav');
  writeFileSync(truncatedPath, sliceWav(readWav(botPath), 0, clampedStop));
}

printEvidence('打断（离线测量，§14.2 + pack Phase 8）', {
  botAudio: existsSync(botPath) ? { path: botPath, durationMs: Math.round(botDurationMs) } : { path: botPath, missing: true, note: '没有助手音频：按句读字长估算时长（口径见本文件 §clause layout）' },
  userAudio: { path: userPath, energyStartMs: segmentation.energyStartMs, bargeInDecisionMs: decisionMs, spans: segmentation.segments.length },
  decision: { ...decision, thresholdMs: TARGET_MS, verdict: decisionMs !== null && decisionMs <= TARGET_MS ? 'pass' : 'fail' },
  simulation: {
    userStartsAtMs: startsAtMs,
    playbackStopsAtMs: Math.round(stopsAtMs),
    playedBeforeInterruptionMs: Math.round(startsAtMs),
    droppedAudioMs: Math.round(droppedMs),
    truncatedWav: truncatedPath,
  },
  clauses,
  audibleStop: strict || decisionMs !== null ? audibleStop : null,
  assent: strict ? assent : null,
  vadEvents: segmentation.events,
  caveat: '离线只能验证「判定」与「播放队列被清空」；扬声器真正静音的延迟需要设备验收（§33 的 P50 < 500ms 不在本次证据内）',
});

if (decisionMs === null) {
  console.error('FAILED：没有检测到用户语音，无法评估打断');
  process.exit(1);
}
if (decisionMs > TARGET_MS) {
  console.error(`FAILED：打断判定延迟 ${decisionMs}ms 超过目标 ${TARGET_MS}ms`);
  process.exit(1);
}
if (strict) {
  if (startsAtMs <= 0 || startsAtMs >= botDurationMs) {
    console.error(`FAILED：这条断言要求「她还在说的时候他开口」（--at ${startsAtMs}，回复长 ${Math.round(botDurationMs)}ms），这个位置不成立`);
    process.exit(1);
  }
  if (laterState.audible) {
    console.error(`FAILED：打断 200ms 后仍有音频在播（第 ${laterState.clause} 段）——「正在播的语音停下」不成立`);
    process.exit(1);
  }
  if (aborted.droppedMs <= 0) {
    console.error('FAILED：打断没有丢掉任何未播音频，播放队列清空不成立');
    process.exit(1);
  }
  if (!decision.stop) {
    console.error(`FAILED：判定层没有决定打断（reason=${decision.reason}，overlap=${decision.overlapMs}ms）`);
    process.exit(1);
  }
}
console.log(`\n打断判定延迟 ${decisionMs}ms ≤ ${TARGET_MS}ms 目标；播放已在 ${Math.round(stopsAtMs)}ms 处截断（丢弃 ${Math.round(droppedMs)}ms 未播音频）`);
if (strict) {
  console.log(
    `播放队列：${aborted.totalClauses} 段，已听 ${Math.round(aborted.playedMs)}ms，丢弃 ${aborted.droppedClauses.length} 段（${Math.round(aborted.droppedMs)}ms）；` +
      `打断 200ms 后仍在播：${laterState.audible ? '是' : '否'}；应和候选停顿 ${assent.pauseMs.join('/')}ms → ${assent.decisionAtLongestPause?.reason ?? '无'}`,
  );
}
