/**
 * Barge-in (§14.2) measured offline.
 *
 * The recipe the plan asks for, minus the speaker:
 *   1. the assistant is "speaking" — its TTS reply is the playback source;
 *   2. the user starts talking part-way through that reply (a fixture);
 *   3. the voice edge detects real speech and decides to interrupt;
 *   4. playback stops and the un-played buffer is dropped.
 *
 * Three layers of evidence, and they answer different questions:
 *
 *   * **the decision** — how long from the moment the user's voice actually begins to the moment
 *     the VAD commits to 「speech started」 (`segmentation.bargeInDecisionMs`). That is the part
 *     our code controls on the input side, and it is measured on real audio;
 *   * **the audible stop** (`--strict`) — the reply is split into clauses, laid out on
 *     `PlaybackTimeline`, and the script then asks the *listener's* question: at the moment he
 *     started talking, is anything still audible? The answer must be 「no」, the un-played
 *     remainder must be exactly what the timeline says was dropped, **and the same probe on a
 *     timeline that was not aborted must answer 「yes」** — without that counterfactual the
 *     criterion cannot fail and would be decoration (t5 review);
 *   * **the browser rule** — `XIXI_PLAYBACK_JS` is *executed* (in `node:vm`, by
 *     `tests/unit/voice/voice-stream.test.ts`) rather than merely grepped, which is the only way
 *     「the page stops the audio」 can be checked without a browser.
 *
 * What this still cannot measure offline: whether the physical speaker goes silent (§33's
 * P50 < 500 ms target covers that, and needs a device test). It also cannot interrupt anything by
 * itself — **reachability**: the microphone only runs while 「按住说话」 is held, so this rule is
 * reachable exactly when the father is holding the button *and* she happens to be speaking, which
 * is the regime the page documents and the caveat below repeats. The truncation is written out as
 * a WAV so the result is auditable rather than asserted.
 *
 * Usage:
 *   node scripts/voice-bargein.ts                       # fixtures from tests/audio-fixtures
 *   node scripts/voice-bargein.ts --strict              # …plus the audible-stop criterion
 *   node scripts/voice-bargein.ts --bot tests/audio-fixtures/backchannel.wav --at 400
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

/**
 * Assistant audio: a **checked-in fixture**, not `data/voice/reply-1.wav`.
 *
 * `data/` is gitignored and `reply-1.wav` is rewritten by every `npm run voice:turn`, so the
 * 「未播音频 4128 ms」-style numbers in this script's output used to change with whatever reply ran
 * last (t5 review). The decision latency never depended on this file — it comes from the user's
 * fixture and the VAD — so pinning the bot audio only makes the *playback* numbers reproducible.
 * Override with `--bot` for a deliberate experiment.
 */
const BOT_FIXTURE = join(REPO_ROOT, 'tests', 'audio-fixtures', 'bot-reply-fixture.wav');
const botPath = argValue('--bot', BOT_FIXTURE);
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
 * The audible-stop check, with its counterfactual.
 *
 * 「真的停下」 is a claim we can only make if the *same instant* would have been audible had nobody
 * interrupted: once aborted, `playbackStateAt` answers 「no」 for every instant by construction, so
 * a criterion that only asks the aborted timeline cannot fail (t5 review:
 * `%TEMP%\t5-review\audiblestop-repro.mjs` scanned 10 001 instants and found the question
 * unfalsifiable). A fixed 200 ms offset is not enough either — this script's own clause layout has
 * a gap between clause 1 and clause 2 right around 1.2 s, so the probe measured silence for the
 * wrong reason and the criterion failed for a reason that has nothing to do with barge-in.
 *
 * So the probe is anchored to the audio itself: the **first instant after the abort at which the
 * uninterrupted timeline would still be playing**. On the aborted timeline that same instant must
 * be silent (playback stopped); on the running timeline it is audible by construction (that is how
 * it was chosen), which is the counterfactual that makes the criterion falsifiable. Both answers
 * come from the same `PlaybackTimeline` class the browser drives; the browser *rule* itself is
 * executed in `tests/unit/voice/voice-stream.test.ts` (node:vm), not grepped.
 */
const abortAtMs = startsAtMs + (decisionMs ?? 0);
const running = timeline.metrics();
const probeAtMs = (() => {
  const nextSlot = running.slots.find((slot) => slot.startMs >= abortAtMs);
  if (nextSlot !== undefined) return nextSlot.startMs;
  const inside = running.slots.find((slot) => slot.endMs > abortAtMs);
  return inside === undefined ? abortAtMs : Math.max(abortAtMs, inside.startMs);
})();
const aborted = timeline.abort(abortAtMs, { playedMs: abortAtMs });
const laterState = playbackStateAt(aborted, probeAtMs);
const counterfactualState = playbackStateAt(running, probeAtMs);
const audibleStop = {
  abortedAtMs: aborted.abortedAtMs,
  probeAtMs,
  audibleAfterProbe: laterState.audible,
  playingClauseAfter: laterState.clause,
  playedMs: aborted.playedMs,
  droppedMs: aborted.droppedMs,
  droppedClauses: aborted.droppedClauses,
  totalClauses: aborted.totalClauses,
  // The counterfactual: the same instant, no interruption. It has to be audible, or the probe is
  // pointing at a gap and the criterion is measuring nothing.
  counterfactualNotAborted: counterfactualState.audible,
  counterfactualClause: counterfactualState.clause,
  counterfactualNote:
    '探测点取自主张「未打断时这里必然可听」的第一个瞬间（打断点之后的下一段音频起点）；未打断为可听、打断后为不可听，两者同时成立这条判据才成立',
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
  caveat:
    '离线只能验证「判定」与「播放队列被清空」；扬声器真正静音的延迟需要设备验收（§33 的 P50 < 500ms 不在本次证据内）。' +
    '可达性：麦克风只在「按住说话」按下期间采样（页面这么写，也是这样实现的），所以这条规则可达的条件是「他正按着按钮、而她又恰好在说话」；' +
    '没有按键时她说完一句不会被打断。助手音频固定为 tests/audio-fixtures/bot-reply-fixture.wav，' +
    '判定延迟与它无关（它只由用户夹具与 VAD 决定），固定它只是让「丢弃了多少毫秒」可复现。',
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
    console.error(`FAILED：打断后在 ${Math.round(probeAtMs)}ms 仍有音频在播（第 ${laterState.clause} 段）——「正在播的语音停下」不成立`);
    process.exit(1);
  }
  if (!counterfactualState.audible) {
    console.error(`FAILED：反事实证明不成立——同一时刻（${Math.round(probeAtMs)}ms）未打断也听不到声音，说明探测点落在播放窗口之外，这条判据本身没有意义`);
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
      `探测点 ${Math.round(probeAtMs)}ms：打断后仍在播 ${laterState.audible ? '是' : '否'}／未打断时应为 ${counterfactualState.audible ? '是' : '否'}；` +
      `应和候选停顿 ${assent.pauseMs.join('/')}ms → ${assent.decisionAtLongestPause?.reason ?? '无'}`,
  );
}
