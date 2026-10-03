/**
 * The shared voice seams (V0.3 P0-A, pack `04_RUNTIME_CONSOLIDATION.md` §1 Step C).
 *
 * Moved out of `scripts/field-test.ts` **verbatim**: what lives here is the part of the voice path
 * that more than one entry needs — the VAD process wrapper, the plan that decides which speech
 * spans go into one ASR call, and the stitcher that turns that plan into one WAV.
 *
 * The console, `scripts/voice-turn.ts` and the trial page all used to reach into the console script
 * for these; `scripts/field-test.ts` keeps a compatibility re-export so an un-migrated caller keeps
 * working while the call sites move one at a time (pack `01_ARCHITECTURE.md` §3).
 *
 * What did **not** move: the streaming clause queue (`services/voice-edge/voice_edge/voice_stream.ts`
 * — it is delivered by the Python service directory, and its ownership is settled together with the
 * resident AudioEdge work) and the reply segmentation in `packages/conversation/src/segments.ts`.
 *
 * Failures use `RuntimeError` (see `./errors.ts`), which is the base class of the console's own
 * `ConsoleError`, so an entry that catches either one still gets `code` / `hint` / `status`.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { RuntimeError } from './errors.ts';
import { REPO_ROOT } from './repo.ts';
// The WAV helpers moved into this package in the same step (`./wav.ts`), and `scripts/lib/wav.ts`
// re-exports them: a package must not reach into the scripts directory for them, or the dependency
// would run backwards (scripts are adapters; the runtime must not depend on one).
import { concatWav, sliceWav } from './wav.ts';

// --------------------------------------------------------------------------------------
// VAD: one-shot Python process over a WAV path (the same code path as production)
// --------------------------------------------------------------------------------------

export interface SpeechSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs?: number;
  readonly endpointDelayMs?: number | null;
}

export interface VadResult {
  readonly segments: SpeechSegment[];
  readonly durationMs?: number;
  readonly bargeInDecisionMs?: number | null;
  readonly energyStartMs?: number | null;
  readonly energyEndMs?: number | null;
  readonly timings?: { readonly loadMs?: number; readonly processMs?: number; readonly audioMs?: number };
  readonly frontend?: unknown;
  readonly events?: readonly { readonly atMs: number; readonly state: string }[];
}

/** Run the project's VAD (`voice_edge.segment`) over a file and return its JSON. */
export function runVad(python: string, wavPath: string, timeoutMs = 120_000): Promise<VadResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', 'voice_edge.segment', wavPath], {
      cwd: join(REPO_ROOT, 'services', 'voice-edge'),
      windowsHide: true,
      // Chinese paths/notes in the child's JSON: force UTF-8 so a GBK default
      // console codepage cannot turn them into mojibake.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // An explicit timer instead of spawn's `timeout` option: on Windows the
    // spawn option's internal timer keeps the event loop alive for its full
    // duration even when the process never started (ENOENT), which made a failing
    // self-test hang for two minutes.
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new RuntimeError('VAD_TIMEOUT', `语音检测超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`, '麦克风录音太长或机器负载过高；重试一次，或把录音缩短到 5 秒内')));
    }, timeoutMs);
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
    });
    child.stderr.on('data', (data: string) => {
      stderr += data;
    });
    child.on('error', (cause) => {
      finish(() => reject(new RuntimeError('VAD_UNAVAILABLE', `语音检测程序起不来：${cause.message}`, `检查 ${python} 是否存在（AGENTS.md §7：语音一律用 .venvs 里的 Python，不要用系统 Python 3.14）`)));
    });
    child.on('close', (code) => {
      finish(() => {
        // Exit 2 means "no speech found", which is a result rather than a failure.
        if (code === 0 || code === 2) {
          try {
            resolve(JSON.parse(stdout) as VadResult);
          } catch (cause) {
            reject(new RuntimeError('VAD_BAD_OUTPUT', `语音检测的输出无法解析：${cause instanceof Error ? cause.message : String(cause)}`, '重跑一次；仍然失败就贴 stderr 给维护者'));
          }
        } else {
          reject(new RuntimeError('VAD_FAILED', `语音检测失败（退出码 ${code}）：${stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(-300)}`, '确认 .venvs/voice-pipecat 已装 pipecat-ai（AGENTS.md §7）'));
        }
      });
    });
  });
}

// --------------------------------------------------------------------------------------
// Multi-segment handling: use them all, report what is not used
// --------------------------------------------------------------------------------------

export interface DroppedSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly reason: string;
}

/** How a reply is played: `ADR-0010` segments plus the pause between them. */
export interface SegmentPlan {
  readonly used: SpeechSegment[];
  readonly dropped: DroppedSegment[];
  readonly totalSpeechMs: number;
  readonly gapMs: number;
  /** True when the plan had to leave segments out (never silent — it is reported). */
  readonly capped: boolean;
  readonly capReason: string | null;
}

export interface SegmentPlanOptions {
  /** Ceiling for how much speech one ASR call may carry. */
  readonly maxSpeechMs?: number;
  /** Ceiling for how many segments one ASR call may carry. */
  readonly maxSegments?: number;
  /** Silence inserted between concatenated segments so ASR does not fuse words. */
  readonly gapMs?: number;
}

/**
 * Choose which VAD segments go into one ASR call.
 *
 * Deliberately *not* "take the first one": a user who says two sentences with a
 * pause in between (very common when someone is testing a microphone) used to have
 * the second sentence silently thrown away. Everything left out is returned in
 * `dropped` with the reason, and the page prints it.
 */
export function planSpeechSegments(segments: readonly SpeechSegment[], options: SegmentPlanOptions = {}): SegmentPlan {
  const maxSpeechMs = options.maxSpeechMs ?? 30_000;
  const maxSegments = options.maxSegments ?? 8;
  const gapMs = options.gapMs ?? 300;
  const used: SpeechSegment[] = [];
  const dropped: DroppedSegment[] = [];
  let totalSpeechMs = 0;
  let capReason: string | null = null;
  for (const segment of segments) {
    const duration = segment.durationMs ?? Math.max(0, segment.endMs - segment.startMs);
    if (used.length >= maxSegments) {
      capReason ??= `一次最多处理 ${maxSegments} 段语音`;
      dropped.push({ startMs: segment.startMs, endMs: segment.endMs, reason: `超过单次上限（${maxSegments} 段）` });
      continue;
    }
    if (totalSpeechMs + duration > maxSpeechMs) {
      capReason ??= `语音总时长超过单次上限 ${Math.round(maxSpeechMs / 1000)}s`;
      dropped.push({ startMs: segment.startMs, endMs: segment.endMs, reason: `超过单次语音时长上限（${Math.round(maxSpeechMs / 1000)}s）` });
      continue;
    }
    used.push(segment);
    totalSpeechMs += duration;
  }
  return { used, dropped, totalSpeechMs: Math.round(totalSpeechMs), gapMs, capped: dropped.length > 0, capReason };
}

/** Slice every used segment out of the recording and stitch them into one WAV. */
export function buildSpeechAudio(rawWav: Buffer, plan: SegmentPlan): Buffer {
  if (plan.used.length === 0) throw new RuntimeError('NO_SPEECH', '没有可用的语音段', '对着麦克风说完整的一句话再试');
  const parts = plan.used.map((segment) => sliceWav(rawWav, segment.startMs, segment.endMs));
  if (parts.length === 1) return parts[0] as Buffer;
  return concatWav(parts, plan.gapMs);
}
