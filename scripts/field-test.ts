/**
 * 现场测试控制台：一条命令跑完「说话 → 看结果 → 设备自检」。
 *
 * Why this file exists
 * --------------------
 * The project had grown a pile of scripts (`npm run web`, `voice:turn`,
 * `voice:bargein`, `voice-device-check`, probe scripts). A user who wants to know
 * "does this thing work on *this* machine with *this* microphone" had to know which
 * one to run and how to read its JSON. This is the single entry point instead:
 *
 *   npm run field-test
 *
 * It serves one Chinese page (127.0.0.1 only) that shows, in plain language and
 * live: the microphone level against the measured noise floor, the camera presence
 * projection, the per-stage latency of every turn and the action the assistant
 * finally took (including SILENCE and the rejection reason), plus a guided
 * microphone → speaker → camera acceptance that writes a report file under
 * `docs/recon/`.
 *
 * Two real defects found by the round's audit are fixed *here*, in the shared core
 * so both this console and `scripts/serve-chat.ts` get them:
 *
 * 1. **Privacy (§20.1)** — the old `/api/voice` wrote the *whole* recording to
 *    `data/voice-web/capture-*.wav` before running the VAD, wrote it even when no
 *    speech was found, and never cleaned anything up. Now the whole recording only
 *    ever exists in the OS temp directory, only for as long as the VAD process
 *    needs it, and is deleted before ASR runs. Speech spans live in memory. Nothing
 *    is written under `docs/`/`data/` unless the config explicitly asks for it
 *    (`privacy.store_raw_audio` + `memory.raw_audio_retention_days`), and legacy
 *    raw captures are pruned at startup according to that policy.
 * 2. **Multi-segment speech** — the old code took `segments[0]` and silently threw
 *    away the rest. Now every detected segment is used (concatenated in order) and
 *    anything not used is reported explicitly with a reason.
 *
 * Usage:
 *   npm run field-test                     # 打开现场测试控制台
 *   npm run field-test -- --port 8792      # 换端口
 *   npm run field-test -- --offline        # 没有密钥也能跑通 UI（ASR/模型用替身）
 *   node scripts/field-test.ts --self-test # 离线自检（不碰麦克风/摄像头/网络）
 *   node scripts/field-test.ts --acceptance # 只跑一次真机设备验收并写报告
 *
 * Shared with `scripts/serve-chat.ts`: the voice-turn core, the retention policy,
 * the presence reader and the report writer are exported from here.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { DshBrainAdapter, FakeBrainAdapter, MimoBrainAdapter, defaultTools, type BrainAdapter } from '@xixi/brain-adapter';
import { CliDshTransport } from '@xixi/brain-dsh';
import {
  ConversationEngine,
  DEFAULT_PROACTIVITY,
  isWithinQuietHours,
  PROACTIVE_REASON_CODES,
  PROACTIVE_TRIGGERS,
  ProactiveEngine,
  parseProactiveSettings,
  proactiveThreshold,
  readProactiveHistory,
  resolveReplyLimits,
  splitReplyIntoSegments,
  type ProactiveReasonCode,
  type ProactiveSettings,
  type ProactiveTrigger,
  type ConversationState,
} from '@xixi/conversation';
import { MimoClient } from '@xixi/model-adapters';
import { openXixiStore, type XixiConfig, type StoredEvent, type XixiStore } from '@xixi/domain';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, readDotEnv } from './lib/harness.ts';
import { concatWav, readWav, readWavInfo, sliceWav } from './lib/wav.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

export const DEFAULT_PORT = 8792;
export const VOICE_DIR = join(REPO_ROOT, 'data', 'voice-web');
export const CALIBRATION_FILE = join(REPO_ROOT, 'data', 'voice', 'frontend-profile.json');
export const REPORT_DIR = join(REPO_ROOT, 'docs', 'recon');
export const DEFAULT_PYTHON = process.env.XIXI_PYTHON ?? join(REPO_ROOT, '.venvs', 'voice-pipecat', 'Scripts', 'python.exe');
/** The venv that has sounddevice/pycaw/cv2 (t1's recon venv). */
export const PROBE_PYTHON = process.env.XIXI_PROBE_PYTHON ?? join(REPO_ROOT, '.venvs', 'field-probe', 'Scripts', 'python.exe');
/** The venv that has sounddevice + soundfile + soxr + soundcard. */
export const AUDIO_PYTHON = process.env.XIXI_AUDIO_PYTHON ?? join(REPO_ROOT, '.venvs', 'voice-livekit', 'Scripts', 'python.exe');

/** Everything the console says is Chinese and aimed at a non-engineer. */
export function explainAction(action: string): string {
  switch (action) {
    case 'SPEAK':
      return '说话（西西回答了）';
    case 'SILENCE':
      return '沉默（西西决定不说话）';
    case 'TOOL':
      return '调用工具后回答';
    default:
      // §55 declares two more actions, but nothing in this repo produces them yet.
      // Naming them here would break the dead-code-truthfulness invariant
      // (tests/unit/core/dead-code-truthfulness.test.ts scans `scripts/`), so an
      // unexpected action is shown verbatim with a plain-language caveat.
      return `${action}（契约里声明的动作，当前没有任何代码会产生它）`;
  }
}

export function explainReason(reason: string): string {
  switch (reason) {
    case 'ACCEPTED_WAKE_OR_DIRECT':
      return '接受：这是一次直呼（会话开始时视为叫醒西西）';
    case 'ACCEPTED_CONTINUATION':
      return '接受：会话已开着，按「继续对话」处理';
    case 'REJECTED_NOT_ADDRESSED':
      return '拒绝：这句话不是在跟西西说（M1 用按钮代替唤醒词）';
    case 'REJECTED_SUSPENDED':
      return '拒绝：正处于「今天安静点」状态';
    case 'NO_SPEECH_DETECTED':
      return '没有听到人声：麦克风里没检测到语音段';
    case 'MISSING_KEY':
      return '缺少模型密钥：无法识别语音（需要 .env 里的 MIMO_API_KEY）';
    default:
      return reason;
  }
}

export function describeOutcome(action: string, reason: string): string {
  return `${explainAction(action)}｜${explainReason(reason)}`;
}

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
      finish(() => reject(new ConsoleError('VAD_TIMEOUT', `语音检测超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`, '麦克风录音太长或机器负载过高；重试一次，或把录音缩短到 5 秒内')));
    }, timeoutMs);
    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
    });
    child.stderr.on('data', (data: string) => {
      stderr += data;
    });
    child.on('error', (cause) => {
      finish(() => reject(new ConsoleError('VAD_UNAVAILABLE', `语音检测程序起不来：${cause.message}`, `检查 ${python} 是否存在（AGENTS.md §7：语音一律用 .venvs 里的 Python，不要用系统 Python 3.14）`)));
    });
    child.on('close', (code) => {
      finish(() => {
        // Exit 2 means "no speech found", which is a result rather than a failure.
        if (code === 0 || code === 2) {
          try {
            resolve(JSON.parse(stdout) as VadResult);
          } catch (cause) {
            reject(new ConsoleError('VAD_BAD_OUTPUT', `语音检测的输出无法解析：${cause instanceof Error ? cause.message : String(cause)}`, '重跑一次；仍然失败就贴 stderr 给维护者'));
          }
        } else {
          reject(new ConsoleError('VAD_FAILED', `语音检测失败（退出码 ${code}）：${stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(-300)}`, '确认 .venvs/voice-pipecat 已装 pipecat-ai（AGENTS.md §7）'));
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
  if (plan.used.length === 0) throw new ConsoleError('NO_SPEECH', '没有可用的语音段', '对着麦克风说完整的一句话再试');
  const parts = plan.used.map((segment) => sliceWav(rawWav, segment.startMs, segment.endMs));
  if (parts.length === 1) return parts[0] as Buffer;
  return concatWav(parts, plan.gapMs);
}

// --------------------------------------------------------------------------------------
// Privacy / retention (§20.1)
// --------------------------------------------------------------------------------------

export interface RetentionPolicy {
  /** May the *whole* recording ever touch the disk? Default: no. */
  readonly storeRawAudio: boolean;
  readonly rawAudioRetentionDays: number;
  /** Retention for VAD-detected speech spans (only kept at all when `storeRawAudio`). */
  readonly speechRetentionDays: number;
  readonly keepSpeechSegments: boolean;
  /** Where the values came from, so the page can show a non-guessed answer. */
  readonly source: string;
  readonly reason: string;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Read the retention decision out of `config/xixi.yaml` (`memory` / `privacy`).
 *
 * The shipped config already answers this question and the audit's complaint was
 * that the code ignored it: `privacy.store_raw_audio: false` and
 * `memory.raw_audio_retention_days: 0`. So the default is "keep nothing at all",
 * which is also the safest reading of §20.1 (no continuous raw audio anywhere, and
 * raw audio is never uploaded). When a maintainer deliberately flips
 * `store_raw_audio: true`, only VAD-detected speech spans are written and the
 * retention window becomes `raw_audio_retention_days`; anything older is pruned.
 */
export function retentionPolicy(config: Pick<XixiConfig, 'memory' | 'privacy'>): RetentionPolicy {
  const privacy = config.privacy ?? {};
  const memory = config.memory ?? {};
  const storeRawAudio = privacy.store_raw_audio === true;
  const rawAudioRetentionDays = numberOr(memory.raw_audio_retention_days, 0);
  const keepSpeechSegments = storeRawAudio && rawAudioRetentionDays > 0;
  const source = `config/${existsSync(join(REPO_ROOT, 'config', 'xixi.yaml')) ? 'xixi.yaml' : 'xixi.example.yaml'}`;
  const reason = keepSpeechSegments
    ? `privacy.store_raw_audio=true 且 memory.raw_audio_retention_days=${rawAudioRetentionDays}：只把 VAD 检出的语音段写入 ${VOICE_DIR}，保留 ${rawAudioRetentionDays} 天，启动时清理过期文件；整段录音永不落盘。`
    : `privacy.store_raw_audio=${String(privacy.store_raw_audio ?? false)}、memory.raw_audio_retention_days=${rawAudioRetentionDays}：整段录音不落盘，语音段也不保留（ASR 直接用内存里的音频）。这是 §20.1 的默认读法：本地不留原始录音、连续音频不上云。`;
  return {
    storeRawAudio,
    rawAudioRetentionDays,
    speechRetentionDays: rawAudioRetentionDays,
    keepSpeechSegments,
    source,
    reason,
  };
}

export interface PrunedFile {
  readonly name: string;
  readonly bytes: number;
  readonly reason: string;
}

export interface PruneResult {
  readonly dir: string;
  readonly removed: readonly PrunedFile[];
  readonly kept: number;
  readonly bytesFreed: number;
}

/**
 * Apply the retention policy to `data/voice-web` (or any directory).
 *
 * Only this script's own artefacts are ever touched (`capture-*.wav`,
 * `speech-*.wav`); anything else in the directory is left alone and merely
 * counted. `capture-*.wav` files are the legacy whole-recording files the audit
 * found lying around with no cleanup, so they are removed whenever the policy does
 * not explicitly ask to keep raw audio.
 */
export function pruneVoiceDir(dir: string, policy: RetentionPolicy, nowMs = Date.now()): PruneResult {
  if (!existsSync(dir)) return { dir, removed: [], kept: 0, bytesFreed: 0 };
  const removed: PrunedFile[] = [];
  let kept = 0;
  let bytesFreed = 0;
  for (const name of readdirSync(dir)) {
    const absolute = join(dir, name);
    let size = 0;
    let modified = nowMs;
    try {
      const info = statSync(absolute);
      if (!info.isFile()) {
        kept += 1;
        continue;
      }
      size = info.size;
      modified = info.mtimeMs;
    } catch {
      continue;
    }
    const ageDays = (nowMs - modified) / 86_400_000;
    let reason: string | null = null;
    if (/^capture-.*\.wav$/i.test(name)) {
      reason = policy.rawAudioRetentionDays > 0
        ? `旧版留下的整段原始录音（保留期 ${policy.rawAudioRetentionDays} 天）`
        : '旧版留下的整段原始录音：策略要求不留原始录音';
      if (policy.rawAudioRetentionDays > 0 && ageDays <= policy.rawAudioRetentionDays) reason = null;
    } else if (/^speech-.*\.wav$/i.test(name)) {
      if (!policy.keepSpeechSegments) reason = '语音段：当前策略不保留语音段';
      else if (ageDays > policy.speechRetentionDays) reason = `语音段：超过保留期 ${policy.speechRetentionDays} 天`;
    }
    if (reason === null) {
      kept += 1;
      continue;
    }
    try {
      rmSync(absolute, { force: true });
      removed.push({ name, bytes: size, reason });
      bytesFreed += size;
    } catch {
      kept += 1;
    }
  }
  return { dir, removed, kept, bytesFreed };
}

// --------------------------------------------------------------------------------------
// Camera presence projection (owned by the M6 task; absent is a normal state)
// --------------------------------------------------------------------------------------

export interface PresenceView {
  readonly mode: 'projection' | 'events' | 'not-integrated' | 'error';
  readonly text: string;
  readonly present: boolean | null;
  readonly confidence: number | null;
  readonly source: string | null;
  readonly updatedAt: string | null;
  readonly stale: boolean | null;
  readonly ttlSeconds: number | null;
  readonly note: string;
  readonly checkedAt: string;
}

/**
 * Read the presence projection written by the M6 camera task.
 *
 * Interface agreed with the vision engineer: `XixiStore.worldState()`
 * (`key = 'presence.home'`, `stale` when past TTL), with `readEvents({type:
 * 'presence.changed'})` as a fallback. Until that lands the page must show
 * 「未接入」 — a *state*, not an error — so every failure path here returns a view
 * instead of throwing. Feature detection is on purpose: the method does not exist
 * yet, and guessing at it would produce a stack trace in the user's face.
 */
export async function readPresence(options: { dataDir?: string; store?: unknown } = {}): Promise<PresenceView> {
  const checkedAt = new Date().toISOString();
  let store: unknown = options.store;
  try {
    if (store === undefined) {
      const opened = openXixiStore({ dataDir: options.dataDir ?? join(REPO_ROOT, 'data') });
      store = opened;
    }
    const candidate = store as Record<string, unknown>;
    const worldState = candidate.worldState;
    if (typeof worldState === 'function') {
      const row = (worldState as (key?: string) => Record<string, unknown> | null).call(store, 'presence.home');
      if (row !== null && row !== undefined && typeof row === 'object') {
        const present = typeof row.present === 'boolean' ? row.present : row.value === 'present' ? true : row.value === 'absent' ? false : null;
        const stale = row.stale === true;
        return {
          mode: 'projection',
          text: present === null ? '未知' : present ? '有人在场' : '没人在场',
          present,
          confidence: typeof row.confidence === 'number' ? row.confidence : null,
          source: typeof row.source === 'string' ? row.source : null,
          updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
          stale,
          ttlSeconds: typeof row.ttlSeconds === 'number' ? row.ttlSeconds : null,
          note: stale
            ? '投影已过期（超过 TTL）：这是「上次看到人」而不是「现在有人」'
            : '来自 world_state 投影（M6 摄像头在场检测）',
          checkedAt,
        };
      }
      return { mode: 'not-integrated', text: '未接入', present: null, confidence: null, source: null, updatedAt: null, stale: null, ttlSeconds: null, note: 'world_state 里还没有 presence.home 这一行（摄像头还没看到过人）', checkedAt };
    }
    const readEvents = candidate.readEvents;
    if (typeof readEvents === 'function') {
      const events = (readEvents as (query: Record<string, unknown>) => unknown[]).call(store, { type: 'presence.changed', limit: 1 });
      const latest = Array.isArray(events) ? (events[0] as Record<string, unknown> | undefined) : undefined;
      if (latest !== undefined && latest !== null) {
        const payload = (latest.payload ?? {}) as Record<string, unknown>;
        const present = typeof payload.present === 'boolean' ? payload.present : null;
        return {
          mode: 'events',
          text: present === null ? '未知' : present ? '有人在场' : '没人在场',
          present,
          confidence: typeof latest.confidence === 'number' ? latest.confidence : null,
          source: typeof latest.source === 'string' ? latest.source : null,
          updatedAt: typeof latest.timestamp === 'string' ? latest.timestamp : null,
          stale: null,
          ttlSeconds: null,
          note: '来自事件日志的 presence.changed（现场投影 world_state 还未接入）',
          checkedAt,
        };
      }
    }
    return { mode: 'not-integrated', text: '未接入', present: null, confidence: null, source: null, updatedAt: null, stale: null, ttlSeconds: null, note: '没有 world_state 投影，也没有 presence.changed 事件：摄像头在场检测（M6）尚未接入', checkedAt };
  } catch (error) {
    return {
      mode: 'error',
      text: '读取失败',
      present: null,
      confidence: null,
      source: null,
      updatedAt: null,
      stale: null,
      ttlSeconds: null,
      note: `在场投影读不出来：${error instanceof Error ? error.message : String(error)}（摄像头自检不受影响）`,
      checkedAt,
    };
  }
}

// --------------------------------------------------------------------------------------
// Microphone calibration artefact (owned by the voice task)
// --------------------------------------------------------------------------------------

export interface CalibrationView {
  readonly available: boolean;
  readonly source: string;
  readonly file: string;
  readonly unit: string;
  readonly noiseFloorDbfs: number | null;
  readonly noiseRmsDbfs: number | null;
  readonly gateThresholdDbfs: number | null;
  readonly highpassHz: number | null;
  readonly suggestedCaptureGainDb: number | null;
  readonly rationale: readonly string[];
  readonly note: string;
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Read `data/voice/frontend-profile.json` (the noise calibration artefact of the
 * voice task). Either key spelling is accepted (`noiseFloorDbfs` /
 * `noise_floor_dbfs`) because the artefact is produced by Python, where the params
 * object is snake_case while the summary is camelCase. Missing artefact → the page
 * says so and falls back to a plain RMS meter, clearly labelled as uncalibrated.
 */
export function readCalibration(file = CALIBRATION_FILE): CalibrationView {
  if (!existsSync(file)) {
    return {
      available: false,
      source: 'none',
      file,
      unit: 'dBFS',
      noiseFloorDbfs: null,
      noiseRmsDbfs: null,
      gateThresholdDbfs: null,
      highpassHz: null,
      suggestedCaptureGainDb: null,
      rationale: [],
      note: '还没做噪声校准（没有 data/voice/frontend-profile.json）：页面用浏览器内存里的简易 RMS，未校准，仅作相对参考',
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const params = (parsed.params ?? {}) as Record<string, unknown>;
    const rationale = Array.isArray(params.rationale) ? params.rationale.filter((item): item is string => typeof item === 'string') : [];
    return {
      available: true,
      source: 'data/voice/frontend-profile.json',
      file,
      unit: typeof parsed.unit === 'string' ? parsed.unit : 'dBFS',
      noiseFloorDbfs: firstNumber(parsed, ['noiseFloorDbfs', 'noise_floor_dbfs']),
      noiseRmsDbfs: firstNumber(parsed, ['rmsDbfs', 'noiseRmsDbfs', 'noise_rms_dbfs']),
      gateThresholdDbfs: firstNumber(params, ['gateThresholdDbfs', 'gate_threshold_dbfs']) ?? firstNumber(parsed, ['gateThresholdDbfs', 'gate_threshold_dbfs']),
      highpassHz: firstNumber(params, ['highpassHz', 'highpass_hz']),
      suggestedCaptureGainDb: firstNumber(params, ['suggestedCaptureGainDb', 'suggested_capture_gain_db']),
      rationale,
      note: '噪声底与门限来自实测校准（voice_edge.calibrate）',
    };
  } catch (error) {
    return {
      available: false,
      source: 'unreadable',
      file,
      unit: 'dBFS',
      noiseFloorDbfs: null,
      noiseRmsDbfs: null,
      gateThresholdDbfs: null,
      highpassHz: null,
      suggestedCaptureGainDb: null,
      rationale: [],
      note: `校准文件读不出来（${error instanceof Error ? error.message : String(error)}）：改用简易 RMS`,
    };
  }
}

// --------------------------------------------------------------------------------------
// Voice turn core (shared with scripts/serve-chat.ts)
// --------------------------------------------------------------------------------------

/** A user-facing failure: always Chinese, always with a next step. */
export class ConsoleError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly status: number;

  constructor(code: string, message: string, hint = '', status = 400) {
    super(message);
    this.name = 'ConsoleError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

export interface VoiceStageTimings {
  readonly vadMs: number;
  readonly asrMs: number | null;
  readonly llmFirstChunkMs: number | null;
  readonly llmTotalMs: number | null;
  readonly ttsMs: number | null;
  readonly totalMs: number;
}

export interface VoiceTurnPayload {
  readonly ok: boolean;
  readonly accepted: boolean;
  readonly reason: string;
  readonly transcript: string | null;
  readonly reply: string | null;
  readonly action: string;
  readonly actionText: string;
  readonly reasonText: string;
  readonly state: string;
  readonly segments: readonly { readonly startMs: number; readonly endMs: number; readonly durationMs: number }[];
  readonly segmentsTotal: number;
  readonly segmentsUsed: number;
  readonly droppedSegments: readonly DroppedSegment[];
  readonly stages: VoiceStageTimings;
  readonly vadMs: number;
  readonly asrMs: number | null;
  readonly firstTokenMs: number | null;
  readonly llmMs: number | null;
  readonly ttsMs: number | null;
  readonly latencyMs: number | null;
  readonly totalMs: number;
  readonly model: string | null;
  readonly audio: string | null;
  readonly at: string;
  readonly privacy: {
    readonly policy: RetentionPolicy;
    readonly speechAudioOnDisk: string | null;
    readonly note: string;
  };
  readonly notes: readonly string[];
}

export interface VoiceDeps {
  readonly python: string;
  readonly voiceDir: string;
  readonly client: MimoClient;
  readonly engine: ConversationEngine;
  readonly currentSessionId: () => string;
  readonly ttsEnabled: boolean;
  readonly policy: RetentionPolicy;
  /** Injected for offline runs (self-test, `--offline`): replaces the ASR call. */
  readonly asr?: (audio: Buffer) => Promise<string>;
  readonly log?: (line: string) => void;
}

export interface VoiceTurnBody {
  readonly audioBase64?: string;
  readonly speak?: boolean;
}

/**
 * One voice turn: browser capture → VAD → (all) speech spans → ASR → conversation → TTS.
 *
 * The recording never touches a durable path: it goes to a private OS temp
 * directory for the VAD child process and is deleted in `finally` *before* ASR
 * runs. Speech spans are sliced from the in-memory buffer.
 */
export async function handleVoiceTurn(deps: VoiceDeps, body: VoiceTurnBody): Promise<VoiceTurnPayload> {
  if (typeof body.audioBase64 !== 'string' || body.audioBase64.length === 0) {
    throw new ConsoleError('NO_AUDIO', '没有收到音频数据', '按住「按住说」按钮说话，松开后会自动上传');
  }
  const totalStarted = Date.now();
  let raw: Buffer;
  try {
    raw = Buffer.from(body.audioBase64, 'base64');
  } catch {
    throw new ConsoleError('BAD_AUDIO', '音频数据无法解码', '重试一次；仍然失败请刷新页面');
  }
  if (raw.length < 1024) {
    throw new ConsoleError('AUDIO_TOO_SHORT', '录音太短（不足 0.05 秒）', '按住按钮把一整句话说完再松开');
  }
  let info: { durationMs: number; sampleRate: number; channels: number };
  try {
    const parsed = readWavInfo(raw);
    info = { durationMs: Math.round(parsed.durationMs), sampleRate: parsed.sampleRate, channels: parsed.channels };
  } catch {
    throw new ConsoleError('BAD_AUDIO', '上传的不是标准 WAV 录音', '刷新页面重试；若仍失败请把浏览器控制台的报错发给维护者');
  }

  // The whole recording exists only here, only while the VAD needs a path.
  const scratch = mkdtempSync(join(tmpdir(), 'xixi-vad-'));
  const scratchWav = join(scratch, 'capture.wav');
  let vad: VadResult;
  try {
    writeFileSync(scratchWav, raw);
    const vadStarted = Date.now();
    vad = await runVad(deps.python, scratchWav);
    const vadMs = Date.now() - vadStarted;
    rmSync(scratch, { recursive: true, force: true });
    const plan = planSpeechSegments(vad.segments);
    const notes: string[] = [];
    if (plan.dropped.length > 0) {
      notes.push(`有 ${plan.dropped.length} 段语音没有送入识别：${plan.capReason ?? '超出单次上限'}（已在「丢弃的语音段」里逐条列出）`);
    }
    if (vad.segments.length > 1) {
      notes.push(`这一段录音里有 ${vad.segments.length} 段语音，已全部使用（按顺序拼接，段间插入 ${plan.gapMs}ms 静音）`);
    }
    notes.push(`原始整段录音没有落盘：只在系统临时目录 ${scratch} 里存在到 VAD 结束，已删除（${info.durationMs}ms / ${info.sampleRate}Hz / ${info.channels} 声道）`);

    const stagesBase = { vadMs, audioDurationMs: info.durationMs };

    if (plan.used.length === 0) {
      const payload: VoiceTurnPayload = {
        ok: true,
        accepted: false,
        reason: 'NO_SPEECH_DETECTED',
        transcript: null,
        reply: null,
        action: 'SILENCE',
        actionText: explainAction('SILENCE'),
        reasonText: explainReason('NO_SPEECH_DETECTED'),
        state: deps.engine.state,
        segments: [],
        segmentsTotal: 0,
        segmentsUsed: 0,
        droppedSegments: [],
        stages: { vadMs, asrMs: null, llmFirstChunkMs: null, llmTotalMs: null, ttsMs: null, totalMs: Date.now() - totalStarted },
        vadMs,
        asrMs: null,
        firstTokenMs: null,
        llmMs: null,
        ttsMs: null,
        latencyMs: null,
        totalMs: Date.now() - totalStarted,
        model: null,
        audio: null,
        at: new Date().toISOString(),
        privacy: {
          policy: deps.policy,
          speechAudioOnDisk: null,
          note: '没有检测到语音：磁盘上不会留下任何录音（连临时文件也已删除）',
        },
        notes: [...notes, '建议：把麦克风靠近一点、确认浏览器选的是正确的输入设备、在系统里把该设备音量调到 60% 以上'],
      };
      deps.log?.(`[voice] no speech (${info.durationMs}ms, vad ${vadMs}ms)`);
      return payload;
    }

    const speechAudio = buildSpeechAudio(raw, plan);
    const asrStarted = Date.now();
    let transcript: string;
    try {
      transcript = deps.asr !== undefined ? await deps.asr(speechAudio) : (await deps.client.transcribe(speechAudio)).text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/MISSING_KEY|not set|api.?key/i.test(message)) {
        throw new ConsoleError('MISSING_KEY', '缺少 MIMO_API_KEY：语音识别用不了（识别是云端能力）', '把 .env.example 复制成 .env 并填入 MIMO_API_KEY，然后重启现场测试；没有密钥时用 npm run field-test -- --offline 仍可看页面与设备自检', 503);
      }
      throw new ConsoleError('ASR_FAILED', `语音识别失败：${message}`, '若是网络/限流（MiMo 首字 0.3–18s 波动），稍后重试；也可挂代理 HTTPS_PROXY=http://127.0.0.1:7890', 502);
    }
    const asrMs = Date.now() - asrStarted;

    const chunks: string[] = [];
    let firstChunkAt: number | null = null;
    const llmStarted = Date.now();
    const turn = await deps.engine.respond(
      { sessionId: deps.currentSessionId(), text: transcript, addressed: deps.engine.state === 'IDLE' },
      {
        onTextChunk: (chunk) => {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          chunks.push(chunk);
        },
      },
    );
    const llmMs = Date.now() - llmStarted;
    const firstTokenMs = firstChunkAt === null ? null : firstChunkAt - llmStarted;

    let audio: string | null = null;
    let ttsMs: number | null = null;
    if (deps.ttsEnabled && body.speak !== false && turn.action === 'SPEAK' && turn.text !== null) {
      const ttsStarted = Date.now();
      audio = (await deps.client.synthesize(turn.text)).toString('base64');
      ttsMs = Date.now() - ttsStarted;
    }

    // Speech spans are only persisted when the policy explicitly asks for them.
    let speechAudioOnDisk: string | null = null;
    if (deps.policy.keepSpeechSegments) {
      mkdirSync(deps.voiceDir, { recursive: true });
      const target = join(deps.voiceDir, `speech-${Date.now()}.wav`);
      writeFileSync(target, speechAudio);
      speechAudioOnDisk = target;
      pruneVoiceDir(deps.voiceDir, deps.policy);
    }

    const payload: VoiceTurnPayload = {
      ok: true,
      accepted: turn.accepted,
      reason: turn.reason,
      transcript,
      reply: turn.text,
      action: turn.action,
      actionText: explainAction(turn.action),
      reasonText: explainReason(turn.reason),
      state: turn.state,
      segments: plan.used.map((segment) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        durationMs: segment.durationMs ?? Math.round(segment.endMs - segment.startMs),
      })),
      segmentsTotal: vad.segments.length,
      segmentsUsed: plan.used.length,
      droppedSegments: plan.dropped,
      stages: {
        vadMs,
        asrMs,
        llmFirstChunkMs: firstTokenMs,
        llmTotalMs: llmMs,
        ttsMs,
        totalMs: Date.now() - totalStarted,
      },
      vadMs,
      asrMs,
      firstTokenMs,
      llmMs,
      ttsMs,
      latencyMs: turn.latencyMs,
      totalMs: Date.now() - totalStarted,
      model: `${turn.provider}/${turn.model}`,
      audio,
      at: new Date().toISOString(),
      privacy: {
        policy: deps.policy,
        speechAudioOnDisk,
        note: speechAudioOnDisk === null
          ? '整段录音不落盘；语音段也没有落盘（只用于这一次识别）'
          : `整段录音不落盘；只保留了 VAD 检出的语音段 ${speechAudioOnDisk}（保留 ${deps.policy.speechRetentionDays} 天，启动时自动清理过期文件）`,
      },
      notes: [...notes, `VAD 参数：${JSON.stringify(stagesBase)}`],
    };
    deps.log?.(`[voice] ${turn.action} ${turn.reason} vad=${vadMs}ms asr=${asrMs}ms first=${firstTokenMs ?? '-'}ms total=${payload.totalMs}ms segments=${plan.used.length}/${vad.segments.length}`);
    return payload;
  } finally {
    // Belt and braces: even if VAD threw or the slicing blew up, the temp dir goes.
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------------------
// Device acceptance: microphone → speaker → camera
// --------------------------------------------------------------------------------------

/**
 * The on-machine probe, written to `data/field-test/device-probe.py` at runtime.
 *
 * It is a single file with four modes because the three devices need three
 * different Windows stacks (pycaw for endpoint mute/volume, sounddevice/soundcard
 * for the acoustic loopback, OpenCV+DSHOW for the camera) and separate processes
 * keep a wedged device from taking the console down.
 *
 * `speaker` mode measures the two things the T1 recon proved must be measured
 * *separately*: WASAPI loopback correlation (the program really rendered audio,
 * 0.9996 in recon §2.5) and a **relative** speech-band level difference between the
 * played window and a pre-roll silence window. The old absolute criterion
 * (`rms > 0.005`) reported `ok` even with the speakers muted — it was a false PASS.
 */
export const DEVICE_PROBE_PY = String.raw`
"""现场测试控制台的设备探测程序（由 scripts/field-test.ts 运行时生成在 data/field-test/）。

用法: python device-probe.py <mode> <repoRoot> [args...]
  mode = endpoints | mic | speaker | camera
输出: stdout 一行 JSON；诊断信息走 stderr。
"""
import importlib.util
import json
import math
import os
import sys
import threading
import time

import numpy as np


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def to_db(value):
    return float(max(-120.0, 20.0 * math.log10(max(float(value), 1e-12))))


def load_frontend(root):
    """Load voice_edge/frontend.py directly (no package __init__, no pipecat import)."""
    path = os.path.join(root, "services", "voice-edge", "voice_edge", "frontend.py")
    if not os.path.exists(path):
        return None, "frontend.py not found at %s" % path
    try:
        spec = importlib.util.spec_from_file_location("xixi_frontend_probe", path)
        module = importlib.util.module_from_spec(spec)
        # dataclasses (and pickling) look the module up in sys.modules while the
        # class body is executed, so it has to be registered *before* exec_module.
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module, None
    except Exception as exc:  # noqa: BLE001 - reported, never fatal
        return None, "%s: %s" % (type(exc).__name__, exc)


def frame_rms(values, rate, frame_ms=50.0):
    size = max(64, int(rate * frame_ms / 1000.0))
    count = len(values) // size
    if count <= 0:
        return np.array([float(np.sqrt(np.mean(values ** 2)))]) if len(values) else np.array([])
    blocks = values[: count * size].reshape(count, size)
    return np.sqrt(np.mean(blocks ** 2, axis=1))


def band_frame_db(values, rate, fe, low=300.0, high=3400.0, frame_ms=50.0):
    """Per-frame speech-band level.

    Every window has the same length (50 ms), so a play-window minus pre-roll
    difference is a valid comparison even if the estimator's absolute scale were
    off; when voice_edge.frontend is available the levels are the project's own
    (comparable with the calibration report and with t1's recon).
    """
    size = max(256, int(rate * frame_ms / 1000.0))
    count = len(values) // size
    out = []
    for index in range(count):
        block = values[index * size : (index + 1) * size]
        if fe is not None:
            out.append(float(fe.band_levels(block, rate, (("speech", low, high),))["speech"]))
            continue
        window = np.hanning(size)
        spectrum = np.abs(np.fft.rfft(block * window)) ** 2
        freqs = np.fft.rfftfreq(size, 1.0 / rate)
        mask = (freqs >= low) & (freqs < high)
        out.append(float(max(-120.0, 10.0 * math.log10(max(float(np.sum(spectrum[mask])), 1e-24)))))
    return np.array(out)


def best_correlation(recorded, expected, rate, max_lag_ms=1500.0):
    """Normalised cross-correlation peak inside +-max_lag_ms (FFT, downsampled).

    Returns (correlation, lagMs). The lag is reported because a loopback capture
    starts whenever WASAPI hands over the first block, which is not the same
    instant as playback start.
    """
    if recorded is None or expected is None:
        return None, None
    if len(recorded) < rate // 2 or len(expected) < rate // 2:
        return None, None
    factor = max(1, int(rate // 4000))
    a = np.asarray(recorded[::factor], dtype=np.float64)
    b = np.asarray(expected[::factor], dtype=np.float64)
    a = a - float(np.mean(a))
    b = b - float(np.mean(b))
    size = 1
    while size < len(a) + len(b):
        size *= 2
    fa = np.fft.rfft(a, size)
    fb = np.fft.rfft(b, size)
    corr = np.fft.irfft(fa * np.conj(fb), size)
    lags = np.arange(size)
    lags = np.where(lags > size // 2, lags - size, lags)
    limit = int(max_lag_ms / 1000.0 * (rate / factor))
    mask = np.abs(lags) <= limit
    if not np.any(mask):
        return None, None
    index = int(np.argmax(np.abs(corr[mask])))
    best_lag = int(lags[mask][index])
    numerator = float(np.abs(corr[mask][index]))
    denominator = math.sqrt(float(np.sum(a ** 2)) * float(np.sum(b ** 2))) + 1e-12
    return float(numerator / denominator), round(best_lag / (rate / factor) * 1000.0, 1)


def mode_endpoints():
    from ctypes import POINTER, cast

    from comtypes import CLSCTX_ALL, CoInitialize
    from pycaw.api.endpointvolume import IAudioEndpointVolume
    from pycaw.pycaw import AudioUtilities

    CoInitialize()

    def interface(device):
        if hasattr(device, "EndpointVolume"):
            return device.EndpointVolume
        return cast(device.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None), POINTER(IAudioEndpointVolume))

    def friendly(device):
        try:
            name = str(device.FriendlyName).strip("\x00")
            if name:
                return name
        except Exception:
            pass
        try:
            device_id = device.GetId()
        except Exception:
            return "<unknown>"
        for candidate in AudioUtilities.GetAllDevices():
            try:
                if candidate.id == device_id:
                    return str(candidate.FriendlyName).strip("\x00")
            except Exception:
                continue
        return "<unknown>"

    def dump(device, label):
        volume = interface(device)
        level_db = round(float(volume.GetMasterVolumeLevel()), 2)
        return {
            "label": label,
            "name": friendly(device),
            "muted": bool(volume.GetMute()),
            "volumeScalar": round(float(volume.GetMasterVolumeLevelScalar()), 4),
            "volumeDb": level_db,
            # On a Windows *capture* endpoint the endpoint volume **is** the microphone
            # gain (t6 measured +0.23 dB). Exposed under an explicit name so the console
            # can show it; nothing in this repo writes it (pycaw is used read-only here).
            "gainDb": level_db if label == "capture" else None,
        }

    emit({"ok": True, "readOnly": True, "render": dump(AudioUtilities.GetSpeakers(), "render"), "capture": dump(AudioUtilities.GetMicrophone(), "capture")})


def mode_mic(root, seconds):
    import sounddevice as sd

    device = sd.query_devices(kind="input")
    rate = int(device["default_samplerate"])
    recorded = sd.rec(int(seconds * rate), samplerate=rate, channels=1, dtype="float32")
    sd.wait()
    values = np.asarray(recorded).reshape(-1).astype(np.float64)
    levels = frame_rms(values, rate)
    emit(
        {
            "ok": True,
            "device": str(device["name"]),
            "rate": rate,
            "seconds": round(len(values) / rate, 2),
            "unit": "dBFS",
            "rmsDbfs": round(to_db(np.sqrt(np.mean(values ** 2))), 2),
            "noiseFloorDbfs": round(to_db(np.percentile(levels, 10)), 2) if levels.size else None,
            "p90FrameDbfs": round(to_db(np.percentile(levels, 90)), 2) if levels.size else None,
            "peakDbfs": round(to_db(np.max(np.abs(values))), 2),
            "frames": int(levels.size),
        }
    )


def mode_speaker(root, fixture, gain):
    import sounddevice as sd
    import soundfile as sf
    import soxr

    rate = 48000
    fe, fe_error = load_frontend(root)
    audio, source_rate = sf.read(fixture, dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if source_rate != rate:
        mono = soxr.resample(mono, source_rate, rate)
    played = np.clip(mono * gain, -1.0, 1.0).astype(np.float64)
    # 1.0 s of silence on both sides of the playback: the noise reference is the
    # average in-band power of every silence frame (pre *and* post), so a single
    # unlucky burst in a 0.6 s pre-roll cannot flatter or spoil the comparison.
    preroll = np.zeros(int(1.0 * rate), dtype=np.float64)
    tail = np.zeros(int(1.0 * rate), dtype=np.float64)
    padded = np.concatenate([preroll, played, tail])

    loop = {}

    def record_loopback():
        try:
            import soundcard as sc

            speaker = sc.default_speaker()
            loopback = sc.get_microphone(id=str(speaker.name), include_loopback=True)
            loop["data"] = np.asarray(loopback.record(samplerate=rate, numframes=len(padded) + int(0.4 * rate)))
        except Exception as exc:  # noqa: BLE001 - reported, not fatal
            loop["error"] = "%s: %s" % (type(exc).__name__, exc)

    thread = threading.Thread(target=record_loopback, daemon=True)
    thread.start()
    time.sleep(0.2)
    captured = np.asarray(sd.playrec(padded.astype(np.float32), samplerate=rate, channels=1, dtype="float32", blocking=True)).reshape(-1).astype(np.float64)
    sd.wait()
    thread.join(timeout=8.0)

    pre = captured[: len(preroll)]
    play = captured[len(preroll) : len(preroll) + len(played)]
    post = captured[len(preroll) + len(played) : len(preroll) + len(played) + len(tail)]
    pre_levels = band_frame_db(pre, rate, fe)
    play_levels = band_frame_db(play, rate, fe)
    post_levels = band_frame_db(post, rate, fe)

    def mean_power_db(*level_sets):
        """Mean in-band power of several equal-length-frame sets, as dBFS.

        Every frame is 50 ms and every level is that frame's in-band level, so the
        mean of 10**(L/10) is the window's mean in-band power. Two windows of
        different length are therefore still comparable, which is what makes the
        *energy ratio* below meaningful.
        """
        values = [float(level) for levels in level_sets for level in np.asarray(levels).reshape(-1)]
        if not values:
            return float("nan")
        return 10.0 * math.log10(max(float(np.mean([10.0 ** (level / 10.0) for level in values])), 1e-24))

    silence_power_db = mean_power_db(pre_levels, post_levels)
    play_power_db = mean_power_db(play_levels)

    def diff(value):
        if math.isnan(value) or math.isnan(silence_power_db):
            return None
        return round(value - silence_power_db, 2)

    # Frame-level percentile: the loudest frames of the playback against the average
    # silence level. Reported as an *upper bound* only — it is the number that made a
    # marginal microphone look comfortable (recon: energy ratio 0.8-2.6 dB vs p95 ~12 dB).
    play_p95_db = float(np.percentile(play_levels, 95)) if play_levels.size else float("nan")

    looped = loop.get("data")
    loop_mono = None
    if looped is not None:
        loop_mono = looped[:, 0] if looped.ndim > 1 else looped
    loop_corr, loop_lag_ms = best_correlation(loop_mono, padded, rate)
    payload = {
        "ok": True,
        "fixture": fixture,
        "gain": gain,
        "rate": rate,
        "unit": "dBFS",
        "playbackPeakDbfs": round(to_db(float(np.max(np.abs(played)))), 2),
        "playbackClipSamples": int(np.count_nonzero(np.abs(played) >= 0.999)),
        "prerollMs": 1000,
        "tailMs": 1000,
        "playedMs": round(len(played) / rate * 1000.0, 1),
        "bandEstimator": "voice_edge.frontend" if fe is not None else "inline-fallback",
        "frontendError": fe_error,
        # --- F2: the two criteria, both reported, neither hidden ---------------------
        # Primary (conservative, integration): average in-band power during playback
        # divided by average in-band power during silence. Same order of magnitude as
        # the recon's 0.8-2.6 dB.
        "energyRatioDb": None if math.isnan(play_power_db) or math.isnan(silence_power_db) else round(play_power_db - silence_power_db, 2),
        "playWindowBandPowerDbfs": None if math.isnan(play_power_db) else round(play_power_db, 2),
        "silenceWindowBandPowerDbfs": None if math.isnan(silence_power_db) else round(silence_power_db, 2),
        "preRollBandPowerDbfs": None if not pre_levels.size else round(mean_power_db(pre_levels), 2),
        "postRollBandPowerDbfs": None if not post_levels.size else round(mean_power_db(post_levels), 2),
        # Secondary (optimistic upper bound, frame percentile): loudest frames vs the
        # average silence level. Never the sole basis for a PASS any more.
        "differentialP95Db": diff(play_p95_db),
        "differentialMeanDb": diff(float(np.mean(play_levels)) if play_levels.size else float("nan")),
        "playWindowP95SpeechBandDbfs": None if math.isnan(play_p95_db) else round(play_p95_db, 2),
        "playWindowMeanSpeechBandDbfs": None if not play_levels.size else round(float(np.mean(play_levels)), 2),
        "preRollSpeechBandDbfs": None if not pre_levels.size else round(float(np.mean(pre_levels)), 2),
        "bandFrames": {"pre": int(pre_levels.size), "play": int(play_levels.size), "post": int(post_levels.size)},
        "micRmsDbfs": round(to_db(np.sqrt(np.mean(captured ** 2))), 2),
        "loopbackCorrelation": None if loop_corr is None else round(loop_corr, 4),
        "loopbackBestLagMs": loop_lag_ms,
        "loopbackFrames": None if looped is None else int(np.asarray(looped).shape[0]),
        "loopbackError": loop.get("error"),
    }
    emit(payload)


def mode_camera():
    import cv2

    result = {"ok": True, "backend": "CAP_DSHOW"}
    capture = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    result["opened"] = bool(capture.isOpened())
    if not capture.isOpened():
        emit(result)
        return
    capture.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    frames = []
    started = time.perf_counter()
    for _ in range(15):
        ok, frame = capture.read()
        if ok and frame is not None:
            frames.append(frame)
    elapsed = time.perf_counter() - started
    result["width"] = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    result["height"] = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    result["frames"] = len(frames)
    result["fps"] = round(len(frames) / elapsed, 1) if elapsed > 0 else None
    if frames:
        gray = cv2.cvtColor(frames[-1], cv2.COLOR_BGR2GRAY)
        result["lumaMean"] = round(float(gray.mean()), 1)
        result["lumaStd"] = round(float(gray.std()), 1)
        result["uniqueLuma"] = int(np.unique(gray).size)
    capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    ok, frame = capture.read()
    if ok and frame is not None:
        result["maxWidth"] = int(frame.shape[1])
        result["maxHeight"] = int(frame.shape[0])
    capture.release()
    emit(result)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    root = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    if mode == "endpoints":
        mode_endpoints()
    elif mode == "mic":
        mode_mic(root, float(sys.argv[3]) if len(sys.argv) > 3 else 3.0)
    elif mode == "speaker":
        mode_speaker(root, sys.argv[3], float(sys.argv[4]) if len(sys.argv) > 4 else 0.6)
    elif mode == "camera":
        mode_camera()
    else:
        emit({"ok": False, "error": "unknown mode: %s" % mode})


try:
    main()
except Exception as exc:  # noqa: BLE001 - every failure is a report line, not a stack trace
    emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)})
`;

export interface AcceptanceCheck {
  readonly name: string;
  readonly verdict: 'pass' | 'fail' | 'info';
  readonly detail: string;
}

export interface AcceptanceItem {
  readonly id: 'microphone' | 'speaker' | 'camera';
  readonly order: number;
  readonly name: string;
  readonly verdict: 'pass' | 'fail' | 'skipped';
  /** One line a non-engineer can act on. */
  readonly summary: string;
  readonly checks: readonly AcceptanceCheck[];
  /** What to do next, always concrete. */
  readonly nextAction: string;
  readonly evidence: Record<string, unknown>;
}

export interface AcceptanceReport {
  readonly at: string;
  readonly date: string;
  readonly command: string;
  readonly overall: 'pass' | 'fail';
  readonly items: readonly AcceptanceItem[];
  readonly notes: readonly string[];
  readonly environment: Record<string, unknown>;
  readonly reportPath: string | null;
}

export type ProbeRunner = (mode: 'endpoints' | 'mic' | 'speaker' | 'camera', args: readonly string[], python: string) => Promise<Record<string, unknown>>;

/** Default runner: spawn the probe with a specific venv Python and parse its JSON line. */
export function defaultProbeRunner(probePath: string, root: string): ProbeRunner {
  return (mode, args, python) =>
    new Promise((resolve, reject) => {
      if (!existsSync(python)) {
        reject(new ConsoleError('PYTHON_MISSING', `找不到 Python：${python}`, 'AGENTS.md §7：语音/视觉一律用 .venvs 里的 Python（voice-pipecat / voice-livekit / field-probe），不要用系统 Python 3.14'));
        return;
      }
      const child = spawn(python, [probePath, mode, root, ...args], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new ConsoleError('PROBE_TIMEOUT', `设备探测（${mode}）超过 120 秒没有返回`, '设备可能被别的程序占用；关掉占用摄像头的程序后重跑')));
      }, 120_000);
      function finish(action: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      }
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (data: string) => {
        stdout += data;
      });
      child.stderr.on('data', (data: string) => {
        stderr += data;
      });
      child.on('error', (cause) => {
        finish(() => reject(new ConsoleError('PROBE_FAILED', `设备探测进程起不来：${cause.message}`, '检查 venv 与依赖')));
      });
      child.on('close', (code) => {
        finish(() => {
          const line = stdout.trim().split(/\r?\n/).filter((item) => item.trim().startsWith('{')).pop();
          if (line === undefined) {
            reject(new ConsoleError('PROBE_FAILED', `设备探测没有输出结果（退出码 ${code}）：${stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(-240)}`, '确认 venv 里装了 numpy/sounddevice/pycaw（field-probe）或 soundfile/soxr/soundcard（voice-livekit）'));
            return;
          }
          try {
            resolve(JSON.parse(line) as Record<string, unknown>);
          } catch (cause) {
            reject(new ConsoleError('PROBE_FAILED', `设备探测的输出无法解析：${cause instanceof Error ? cause.message : String(cause)}`, '重跑一次；仍失败请贴 stderr'));
          }
        });
      });
    });
}

function probeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberField(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface AcceptanceOptions {
  readonly root?: string;
  readonly fixture?: string;
  readonly probePython?: string;
  readonly audioPython?: string;
  readonly probePath?: string;
  readonly probeRunner?: ProbeRunner;
  readonly presence?: PresenceView;
  readonly log?: (line: string) => void;
  readonly writeReport?: boolean;
  readonly reportDir?: string;
}

/**
 * Guided device acceptance in the required order: microphone → speaker → camera.
 *
 * Each item returns pass/fail plus the concrete next step, and the whole run is
 * rendered into `docs/recon/field-test-report-<date>.md`.
 */
export async function runDeviceAcceptance(options: AcceptanceOptions = {}): Promise<AcceptanceReport> {
  const root = options.root ?? REPO_ROOT;
  const probePath = options.probePath ?? join(root, 'data', 'field-test', 'device-probe.py');
  const reportDir = options.reportDir ?? REPORT_DIR;
  const log = options.log ?? ((): void => {});
  mkdirSync(dirname(probePath), { recursive: true });
  writeFileSync(probePath, DEVICE_PROBE_PY, 'utf8');
  const runner = options.probeRunner ?? defaultProbeRunner(probePath, root);
  const probePython = options.probePython ?? PROBE_PYTHON;
  const audioPython = options.audioPython ?? AUDIO_PYTHON;
  const fixture = options.fixture ?? join(root, 'tests', 'audio-fixtures', 'direct-question.wav');
  const notes: string[] = [];
  const items: AcceptanceItem[] = [];

  // Endpoint state first: "出厂静音" was the root cause of the previous failed
  // acceptance (recon §2), so it is read and printed on every run.
  let endpoints: Record<string, unknown> | null = null;
  try {
    endpoints = await runner('endpoints', [], probePython);
    if (endpoints.ok === false) {
      notes.push(`端点状态读取失败：${String(endpoints.error ?? '未知原因')}`);
      endpoints = null;
    }
  } catch (error) {
    notes.push(`端点状态读取失败：${probeError(error)}`);
  }
  const render = (endpoints?.render ?? null) as Record<string, unknown> | null;
  const capture = (endpoints?.capture ?? null) as Record<string, unknown> | null;
  /**
   * F7: the capture endpoint's "volume" on Windows *is* the microphone gain. It is read
   * (pycaw, read-only) and printed, never written — the console only ever suggests
   * setting it to 0 dB when the noise floor is high, because raising/lowering it is a
   * machine setting the user owns (t6 measured +0.23 dB and found no code that sets it).
   */
  const captureGainDb = capture === null ? null : numberField(capture, 'gainDb') ?? numberField(capture, 'volumeDb');
  const gainHint = (floor: number | null): string =>
    floor !== null && floor > -40
      ? `采集增益当前 ${captureGainDb ?? '?'} dB（Windows 输入端点读数，仓库里没有任何代码修改它）：噪声底 ${floor} dBFS 偏高，可考虑在「声音设置 → 输入」里把该麦克风的增益设为 0 dB（实测 1:1 换回约 5.5 dB 噪声余量）；控制台只提示，不会自动改系统设置`
      : `采集增益当前 ${captureGainDb ?? '?'} dB（Windows 输入端点读数，仓库里没有任何代码修改它）：噪声底不高，保持现状即可`;
  if (endpoints !== null) {
    log(`[acceptance] 默认输出「${String(render?.name ?? '?')}」muted=${String(render?.muted)} 音量=${String(render?.volumeScalar)}｜默认输入「${String(capture?.name ?? '?')}」muted=${String(capture?.muted)} 采集增益=${String(captureGainDb)} dB`);
  }

  // ---- 1. microphone ------------------------------------------------------------
  const micChecks: AcceptanceCheck[] = [];
  let micEvidence: Record<string, unknown> = { endpoints: { render, capture }, captureGainDb, readOnly: true };
  let micVerdict: AcceptanceItem['verdict'] = 'skipped';
  let micSummary = '未测到：麦克风探测没有跑起来';
  let micNext = '确认 .venvs/field-probe 里有 numpy + sounddevice，然后重跑这一项';
  if (capture !== null) {
    micChecks.push({
      name: 'Windows 采集端点（默认麦克风）',
      verdict: capture.muted === true ? 'fail' : 'pass',
      detail: `设备「${String(capture.name ?? '?')}」：静音=${String(capture.muted)}，音量=${Math.round(Number(capture.volumeScalar ?? 0) * 100)}%，采集增益=${captureGainDb ?? '?'} dB（= Windows 输入端点音量；pycaw 只读读数，仓库里没有任何代码设置它）`,
    });
  } else {
    micChecks.push({ name: 'Windows 采集端点（默认麦克风）', verdict: 'info', detail: '读不到端点状态（pycaw 不可用），只按录音判断' });
  }
  try {
    const mic = await runner('mic', ['3'], probePython);
    log(`[acceptance] 麦克风录音：${JSON.stringify(mic).slice(0, 200)}`);
    micEvidence = { ...micEvidence, recording: mic };
    if (mic.ok === false) throw new Error(String(mic.error ?? '未知原因'));
    const rms = numberField(mic, 'rmsDbfs');
    const floor = numberField(mic, 'noiseFloorDbfs');
    const peak = numberField(mic, 'peakDbfs');
    micChecks.push({
      name: '录了 3 秒环境声',
      verdict: rms === null ? 'info' : rms > -60 ? 'pass' : 'fail',
      detail: `设备「${String(mic.device ?? '?')}」：整段 RMS ${rms ?? '?'} dBFS，峰值 ${peak ?? '?'} dBFS（0 dBFS = 数字满量程，越接近 0 越响；−60 dBFS 以下说明几乎收不到声音）`,
    });
    micChecks.push({
      name: '噪声底（说话时要明显高于它）',
      verdict: floor === null ? 'info' : floor > -40 ? 'info' : 'pass',
      detail: floor === null ? '算不出来（录音太短）' : `噪声底 ${floor} dBFS（50ms 帧 RMS 的 p10）。高于 −40 dBFS 说明这台机器的底噪偏大（勘测实测 −30.86 dBFS），这是当前最大风险`,
    });
    micChecks.push({
      name: '输入采集增益（系统设置，仅提示）',
      verdict: 'info',
      detail: gainHint(floor),
    });
    const muted = capture?.muted === true;
    if (muted) {
      micVerdict = 'fail';
      micSummary = '失败：Windows 默认麦克风处于静音状态，任何语音都进不来';
      micNext = '打开「声音设置 → 输入」，选中默认麦克风并解除静音、音量调到 60% 以上，然后重跑麦克风一项';
    } else if (rms === null || rms <= -60) {
      micVerdict = 'fail';
      micSummary = `失败：3 秒里几乎收不到声音（RMS ${rms ?? '?'} dBFS）`;
      micNext = '在系统里确认默认输入设备选的是你要用的麦克风；对着它说一句话再重跑。若是 USB 麦克风，检查它上面的静音开关';
    } else {
      micVerdict = 'pass';
      micSummary = floor !== null && floor > -40
        ? `通过（有风险）：麦克风能录到声音，但噪声底 ${floor} dBFS 偏高（采集增益 ${captureGainDb ?? '?'} dB），说话声只比它高几 dB 时识别会不稳`
        : `通过：麦克风能录到声音（RMS ${rms} dBFS，噪声底 ${floor ?? '?'} dBFS，采集增益 ${captureGainDb ?? '?'} dB）`;
      micNext = floor !== null && floor > -40
        ? `下一步：扬声器自检；另外可考虑把输入采集增益从 ${captureGainDb ?? '?'} dB 设为 0 dB（实测 1:1 换回约 5.5 dB 噪声余量，控制台只提示、不改系统设置），或让麦克风离人近一点`
        : '下一步：扬声器自检（不需要你说话，程序会自己放一段音频）';
    }
  } catch (error) {
    micVerdict = 'fail';
    micSummary = `失败：麦克风探测出错（${probeError(error)}）`;
    micChecks.push({ name: '录音探测', verdict: 'fail', detail: probeError(error) });
  }
  items.push({ id: 'microphone', order: 1, name: '麦克风（说话能不能进来）', verdict: micVerdict, summary: micSummary, checks: micChecks, nextAction: micNext, evidence: micEvidence });

  // ---- 2. speaker ---------------------------------------------------------------
  const speakerChecks: AcceptanceCheck[] = [];
  let speakerEvidence: Record<string, unknown> = { endpoints: { render } };
  let speakerVerdict: AcceptanceItem['verdict'] = 'skipped';
  let speakerSummary = '未测：扬声器探测没有跑起来';
  let speakerNext = '确认 .venvs/voice-livekit 里有 sounddevice + soundfile + soxr + soundcard，然后重跑这一项';
  if (render !== null) {
    speakerChecks.push({
      name: 'Windows 输出端点（默认扬声器）',
      verdict: render.muted === true ? 'fail' : 'pass',
      detail: `设备「${String(render.name ?? '?')}」：静音=${String(render.muted)}，音量=${Math.round(Number(render.volumeScalar ?? 0) * 100)}%（勘测发现出厂就是静音，这正是上一轮验收失败的根因）`,
    });
  }
  const speakerTrials: Record<string, unknown>[] = [];
  // Playback gain 1.0: the fixture's speech-band level is −24.6 dBFS, so unity gain
  // still leaves several dB of headroom (no clipping, checked below) and matches what
  // a real TTS reply at the system volume sounds like.
  const SPEAKER_GAIN = '1.0';
  /** Gate for BOTH speaker criteria. The same 10 dB the recon asked for, now applied to the conservative estimator. */
  const SPEAKER_GATE_DB = 10;
  /** Trials are always 3: the gate uses their mean, so an unlucky or lucky single run cannot decide the verdict. */
  const SPEAKER_TRIALS = 3;
  const stats = (values: readonly (number | null)[]): { count: number; best: number; worst: number; mean: number } | null => {
    const usable = values.filter((value): value is number => value !== null);
    if (usable.length === 0) return null;
    return {
      count: usable.length,
      best: Number(Math.max(...usable).toFixed(2)),
      worst: Number(Math.min(...usable).toFixed(2)),
      mean: Number((usable.reduce((sum, value) => sum + value, 0) / usable.length).toFixed(2)),
    };
  };
  try {
    for (let attempt = 0; attempt < SPEAKER_TRIALS; attempt += 1) {
      if (attempt > 0) log(`[acceptance] 扬声器第 ${attempt + 1}/${SPEAKER_TRIALS} 次测量…`);
      const trial = await runner('speaker', [fixture, SPEAKER_GAIN], audioPython);
      speakerTrials.push(trial);
      if (trial.ok === false) break;
    }
    const probe = speakerTrials[0] as Record<string, unknown>;
    const energyStats = stats(speakerTrials.map((item) => numberField(item, 'energyRatioDb')));
    const p95Stats = stats(speakerTrials.map((item) => numberField(item, 'differentialP95Db')));
    speakerEvidence = {
      ...speakerEvidence,
      loopback: probe,
      loopbackTrials: speakerTrials.map((item) => ({
        energyRatioDb: item.energyRatioDb,
        differentialP95Db: item.differentialP95Db,
        differentialMeanDb: item.differentialMeanDb,
        silenceWindowBandPowerDbfs: item.silenceWindowBandPowerDbfs,
        playWindowBandPowerDbfs: item.playWindowBandPowerDbfs,
        loopbackCorrelation: item.loopbackCorrelation,
      })),
      trialStats: { energyRatioDb: energyStats, differentialP95Db: p95Stats, trials: speakerTrials.length },
    };
    if (probe.ok === false) throw new Error(String(probe.error ?? '未知原因'));
    const correlation = numberField(probe, 'loopbackCorrelation');
    const correlationLag = numberField(probe, 'loopbackBestLagMs');
    const energyRatio = energyStats?.mean ?? null;
    const energyBest = energyStats?.best ?? null;
    const energyWorst = energyStats?.worst ?? null;
    const diffP95 = p95Stats?.mean ?? null;
    const p95Best = p95Stats?.best ?? null;
    const p95Worst = p95Stats?.worst ?? null;
    const estimator = String(probe.bandEstimator ?? '?');
    const playbackPeak = numberField(probe, 'playbackPeakDbfs');
    const silencePower = numberField(probe, 'silenceWindowBandPowerDbfs');
    const playPower = numberField(probe, 'playWindowBandPowerDbfs');
    const trialText = energyStats === null || energyStats.count === 1
      ? '单次测量'
      : `${energyStats.count} 次测量的均值（最差 ${energyWorst} / 均值 ${energyRatio} / 最好 ${energyBest} dB）`;
    speakerChecks.push({
      name: '① 程序真的把音频送到了输出流（WASAPI loopback）',
      // Evidence, not a gate: this measurement is 0.9996 on a clean single-stream
      // capture (recon §2.5) but lands lower when the endpoint applies audio
      // enhancements/resampling, and it stays high when the *hardware* is muted —
      // so it can never be the thing that fails a speaker. The endpoint mute state
      // and the energy-ratio criterion below are the gates.
      verdict: correlation === null ? 'info' : correlation >= 0.9 ? 'pass' : 'info',
      detail: correlation === null
        ? `未能独立测量：${String(probe.loopbackError ?? 'soundcard 回采不可用')}。只有端点状态可作参考`
        : `回采信号与播放信号的相关性 ${correlation}（最佳对齐 ${correlationLag ?? '?'} ms；≥0.9 视为独立确认，勘测用单流采集时实测 0.9996）。注意：静音时这个数也是高的，它只能证明「程序渲染了」，不能证明「听到了」`,
    });
    speakerChecks.push({
      name: '测试音频本身（播放增益 1.0）',
      verdict: playbackPeak === null ? 'info' : playbackPeak <= -1 ? 'pass' : 'fail',
      detail: playbackPeak === null
        ? '没读到播放峰值'
        : `播放信号峰值 ${playbackPeak} dBFS（距数字满量程 ${(0 - playbackPeak).toFixed(1)} dB 余量，无削顶采样；夹具语音带电平 −24.6 dBFS，增益 1.0 比 0.6 更接近真实 TTS 播放电平）`,
    });
    speakerChecks.push({
      name: `② 麦克风真的听到了（主判据：能量比 ≥${SPEAKER_GATE_DB} dB，语音带 300–3400 Hz）`,
      verdict: energyRatio === null ? 'fail' : energyRatio >= SPEAKER_GATE_DB ? 'pass' : 'fail',
      detail: energyRatio === null
        ? '算不出能量比（没录到有效数据）'
        : `能量比 ${energyRatio} dB = 播放窗平均带内功率（${playPower ?? '?'} dBFS）− 静音窗平均带内功率（${silencePower ?? '?'} dBFS，前置 1.0s + 尾部 1.0s 的所有 50ms 帧）；${trialText}。`
          + `口径说明：能量比是**相对**口径里最保守的那个（平均功率之比，与勘测实测的 0.8–2.6 dB 同一量级，也与 ASR 实际可用性最相关）；绝对 RMS 不能用——勘测实测扬声器静音时绝对 RMS 反而更高（0.0505 vs 0.0486）`,
    });
    speakerChecks.push({
      name: '③ 参考口径：帧级 dB 分位（乐观上界，不作为判据）',
      verdict: 'info',
      detail: diffP95 === null
        ? '算不出分位差（没录到有效数据）'
        : `分位差（最响 50ms 帧 − 静音窗平均）${diffP95} dB（最差 ${p95Worst} / 均值 ${diffP95} / 最好 ${p95Best} dB，估计器 ${estimator}）。`
          + (energyRatio === null ? '' : `本次它比能量比高 ${Number((diffP95 - energyRatio).toFixed(2))} dB。`)
          + `口径说明：分位只看最响的瞬间，这个差值是定义差异而非额外余量——T6 在 0.6s 单窗参考下实测 11.83 vs 2.69 dB（差约 9 dB），本报告改了参考窗定义，差值与数值都会随噪声条件变化，**不能**用来判断平均声学余量`,
    });
    if (render?.muted === true) {
      speakerVerdict = 'fail';
      speakerSummary = '失败：默认输出设备是静音状态，程序再努力也放不出声';
      speakerNext = '打开「声音设置 → 输出」，选中默认设备并解除静音、音量调到 50% 以上，然后重跑扬声器一项（勘测已把本机音量设为 66%）';
    } else if (energyRatio !== null && energyRatio >= SPEAKER_GATE_DB) {
      speakerVerdict = 'pass';
      speakerSummary = `通过：能量比 ${energyRatio} dB ≥ ${SPEAKER_GATE_DB} dB（分位口径 ${diffP95 ?? '?'} dB 只是上界）`;
      speakerNext = '下一步：摄像头自检';
    } else {
      speakerVerdict = 'fail';
      speakerSummary = `失败（口径修正后）：程序确实渲染了音频（相关 ${correlation ?? '未测'}），但按**能量比**口径麦克风只比噪声底高 ${energyRatio ?? '?'} dB（< ${SPEAKER_GATE_DB} dB）；`
        + `分位口径 ${diffP95 ?? '?'} dB 是乐观上界，不代表平均声学余量。这与勘测实测的 0.8–2.6 dB 一致：瓶颈是本机麦克风自噪，不是扬声器`;
      speakerNext = '先确认：音量 ≥50%、扬声器未被物理静音、麦克风离扬声器 0.3–1 m，然后重跑。若能量比仍 <10 dB，说明本机麦克风自噪过高——按控制台/报告里的「Windows 采集增益」读数把它设为 0 dB（控制台只提示，不改系统设置），或换外接麦克风';
    }
  } catch (error) {
    speakerVerdict = 'fail';
    speakerSummary = `失败：扬声器探测出错（${probeError(error)}）`;
    speakerChecks.push({ name: '声学回环探测', verdict: 'fail', detail: probeError(error) });
  }
  items.push({ id: 'speaker', order: 2, name: '扬声器（西西说话你能不能听到）', verdict: speakerVerdict, summary: speakerSummary, checks: speakerChecks, nextAction: speakerNext, evidence: speakerEvidence });

  // ---- 3. camera ----------------------------------------------------------------
  const cameraChecks: AcceptanceCheck[] = [];
  let cameraEvidence: Record<string, unknown> = {};
  let cameraVerdict: AcceptanceItem['verdict'] = 'skipped';
  let cameraSummary = '未测：摄像头探测没有跑起来';
  let cameraNext = '确认 .venvs/field-probe 里有 opencv-python-headless + numpy，然后重跑这一项';
  try {
    let camera = await runner('camera', [], probePython);
    // DSHOW refuses to open a device that another process holds (a browser tab, a
    // meeting app, or another agent's detector running right now). One short retry
    // separates that transient contention from a real "camera missing" verdict.
    if (camera.opened !== true) {
      log('[acceptance] 摄像头第一次打不开，2 秒后重试一次（可能是被别的程序占用）…');
      await delay(2000);
      const retry = await runner('camera', [], probePython);
      if (retry.opened === true) camera = retry;
      else camera = { ...retry, retried: true };
    }
    cameraEvidence = { camera };
    if (camera.ok === false) throw new Error(String(camera.error ?? '未知原因'));
    cameraChecks.push({
      name: '能以 CAP_DSHOW 打开（本机唯一可用后端）',
      verdict: camera.opened === true ? 'pass' : 'fail',
      detail: camera.opened === true
        ? `已打开：${String(camera.width)}×${String(camera.height)} @ ${String(camera.fps)} fps（本轮采到 ${String(camera.frames)} 帧）`
        : '打不开：最常见的原因是**被别的程序占用**（浏览器标签、会议软件，或另一个正在跑的检测脚本），其次是没插好/驱动问题。本项已在 2 秒后自动重试过一次',
    });
    const lumaStd = numberField(camera, 'lumaStd');
    const lumaMean = numberField(camera, 'lumaMean');
    if (camera.opened === true) {
      cameraChecks.push({
        name: '画面不是全黑/全灰（能看到东西）',
        verdict: lumaStd === null ? 'info' : lumaStd >= 2 ? 'pass' : 'fail',
        detail: lumaStd === null ? '没取到帧' : `亮度均值 ${lumaMean ?? '?'}，标准差 ${lumaStd}（标准差接近 0 = 画面一片死黑或死白；镜头盖、遮挡、强逆光都会这样）`,
      });
    }
    const presence = options.presence ?? (await readPresence({}));
    cameraChecks.push({
      name: '在场检测（M6）投影是否接入',
      verdict: presence.mode === 'projection' || presence.mode === 'events' ? 'pass' : 'info',
      detail: presence.mode === 'not-integrated'
        ? `摄像头能出图，但在场检测还没接入：${presence.note}（这是「未接入」，不是故障）`
        : `${presence.text}｜${presence.note}`,
    });
    cameraEvidence = { ...cameraEvidence, presence };
    if (camera.opened !== true) {
      cameraVerdict = 'fail';
      cameraSummary = '失败：摄像头打不开';
      cameraNext = '关掉占用摄像头的程序（浏览器标签、会议软件），重插 USB，然后重跑摄像头一项';
    } else if (lumaStd !== null && lumaStd < 2) {
      cameraVerdict = 'fail';
      cameraSummary = '失败：摄像头能开，但画面一片死黑或死白，看不出场景';
      cameraNext = '取下镜头盖、擦一下镜头、避免强逆光，然后重跑摄像头一项';
    } else {
      cameraVerdict = 'pass';
      cameraSummary = presence.mode === 'not-integrated'
        ? '通过：摄像头能出清晰的画面；在场检测（M6）尚未接入，页面会显示「未接入」'
        : `通过：摄像头画面正常，在场状态：${presence.text}`;
      cameraNext = presence.mode === 'not-integrated'
        ? '下一步：等视觉任务（M6）接入后，页面会自动显示「有人/无人」；现在可以先用「按住说」跑一轮对话'
        : '下一步：可以开始通话测试（页面底部按住🎤说话）';
    }
  } catch (error) {
    cameraVerdict = 'fail';
    cameraSummary = `失败：摄像头探测出错（${probeError(error)}）`;
    cameraChecks.push({ name: '摄像头探测', verdict: 'fail', detail: probeError(error) });
  }
  items.push({ id: 'camera', order: 3, name: '摄像头（西西在不在场）', verdict: cameraVerdict, summary: cameraSummary, checks: cameraChecks, nextAction: cameraNext, evidence: cameraEvidence });

  const at = new Date();
  const date = at.toISOString().slice(0, 10);
  const overall: AcceptanceReport['overall'] = items.every((item) => item.verdict === 'pass') ? 'pass' : 'fail';
  if (items.some((item) => item.verdict === 'skipped')) notes.push('有项目被跳过（依赖的 venv 或设备不可用），报告里逐项写了原因与下一步');
  notes.push('判据说明：「程序渲染了音频」与「麦克风真的听到了」是两件事，分别测量、分别显示（勘测 §2.5 的假 PASS 教训）');
  notes.push('扬声器「麦克风真的听到了」有**两个口径**，报告里两个都给出：② **能量比**（主判据：播放窗平均带内功率 − 静音窗平均带内功率，保守、与 ASR 可用性最相关，勘测实测 0.8–2.6 dB）与 ③ **帧级 dB 分位**（乐观上界：最响的 50 ms 帧 − 静音窗平均；T6 实测 11.83 vs 2.69 dB，差约 9 dB，本报告的参考窗定义不同故差值不同）。单一分位数字会让读者高估声学余量，所以它不再作为判据');
  notes.push('扬声器复测：固定测 3 次，判据取 3 次的**均值**，同时给出最差/最好（每次的原始数字都在证据里）。不取「最好的一次」，避免把偶然的噪声低谷当成余量');
  notes.push('静音参考窗的定义：前置 1.0 s + 尾部 1.0 s 的所有 50 ms 帧的**平均带内功率**（两个窗都列在证据里）。取两段而不是只看前置，是为了不让采集刚启动时的爬升段把噪声底压低而虚增余量；尾部若混入播放混响，只会让判据更保守');
  notes.push('输入采集增益（Windows 采集端点音量，pycaw 只读读数）会显示在麦克风一项与报告里；噪声底偏高时只提示「可考虑设为 0 dB」，控制台不会修改任何系统设置');
  notes.push('「程序渲染了音频」（WASAPI 回采相关性）是证据不是门禁：本机带音频增强/重采样时实测会低于勘测单流采集的 0.9996，所以它不单独判失败；判失败的是「端点被静音」与「麦克风没听到（相对差 <10 dB）」');
  notes.push('扬声器相对差是噪声测量：本机多次运行实测 9.1–14.7 dB（单次结果会压在 10 dB 阈值上）；因此用更好的播放电平（增益 1.0，无削顶）+ 最多 3 次复测取较好值，每一次的原始数字都写进证据——真坏了的话三次都不会过');
  notes.push('同时有别的程序（浏览器标签、会议软件，或另一个正在跑的检测脚本）占用摄像头时，DSHOW 一定打不开——这是占用而不是设备故障，关掉占用方后重跑本项即可');
  const report: AcceptanceReport = {
    at: at.toISOString(),
    date,
    command: 'node scripts/field-test.ts --acceptance',
    overall,
    items,
    notes,
    environment: {
      host: process.env.COMPUTERNAME ?? 'unknown',
      node: process.version,
      platform: process.platform,
      probePython,
      audioPython,
      fixture,
      endpoints,
    },
    reportPath: null,
  };
  if (options.writeReport === false) return report;
  const reportPath = join(reportDir, `field-test-report-${date}.md`);
  mkdirSync(reportDir, { recursive: true });
  const config = loadConfig();
  const policy = retentionPolicy(config);
  writeFileSync(
    reportPath,
    renderAcceptanceReport(report, {
      calibration: readCalibration(),
      privacyNotes: [
        policy.reason,
        `实测噪声底（校准产物 data/voice/frontend-profile.json）：${readCalibration().noiseFloorDbfs ?? '?'} dBFS，建议门限 ${readCalibration().gateThresholdDbfs ?? '?'} dBFS`,
        '整段录音不落盘：只在系统临时目录里存在到 VAD 结束，随后立即删除；没有语音时磁盘上不留任何录音。',
      ],
    }),
    'utf8',
  );
  return { ...report, reportPath };
}

/** Many next-actions already start with 「下一步：」; the report adds its own label. */
export function stripNextPrefix(text: string): string {
  return text.replace(/^\s*下一步[：:]\s*/, '');
}

/**
 * The fixed 「口径变更说明」 every generated acceptance report starts with.
 *
 * Why it is emitted by the generator instead of hand-written into the report: the speaker
 * verdict's *definition* changed between the t4 delivery (frame-level dB percentile →
 * PASS) and the t21 correction (energy ratio → FAIL). A reader comparing two reports sees
 * PASS turn into FAIL and cannot tell whether the machine or the measurement changed —
 * so the explanation has to survive every regeneration, exactly like the verdict does.
 */
const ACCEPTANCE_CRITERIA_NOTE: readonly string[] = [
  '## 口径变更说明（先看这一节，再看下面的逐项数字）',
  '',
  '**扬声器结论在 t4 交付时为 PASS、t21 修正口径后为 FAIL——变的是测量口径，不是机器；旧口径高估了声学余量。**',
  '',
  '| | t4 交付时（旧口径） | t21 修正后（现行口径） | 为什么变 |',
  '|---|---|---|---|',
  '| 扬声器判据 | **帧级 dB 分位**：最响的 50 ms 帧 − 静音窗平均 ≈ 12.97 dB → PASS | **能量比**（主判据）：播放窗平均带内功率 − 静音窗平均带内功率 → **见下面的逐项表**（本机实测 ~2–3 dB，< 10 dB 即 FAIL） | 分位只看「最响的那一瞬间」，是**乐观上界**；能量比是整段平均，才对应 ASR 真正拿到的信噪比 |',
  '',
  '旧口径虚增约 9 dB，两个原因叠加：',
  '',
  '1. **分位本身是乐观上界**：帧级 p95 取的是播放窗里最响的 50 ms 帧，比平均功率之比天然高 8–10 dB（t6 复核实测 11.83 vs 2.69 dB）。',
  '2. **旧的静音参考窗偏「太低」**：旧实现只取播放前 0.6 s 的帧电平均值，而采集刚启动那一段有爬升（电平偏低），把噪声参考压低 → 相对差被进一步放大。现在改成「前置 1.0 s + 尾部 1.0 s 的平均带内功率」，三个窗的电平都写在证据里，可以自己复算。',
  '',
  '**这不是「功能坏了」**：程序确实把音频送到了输出流（WASAPI 回采相关见逐项表），麦克风也确实能听到最响的那些帧；不达标的是**平均声学余量**——本机麦克风自噪偏高（勘测实测麦克风只比噪声底高 0.8–2.6 dB），扬声器一侧没有问题。',
  '',
  '**改善路径（做完任一条再重跑本报告就会更新数字）**：',
  '',
  '1. 确认输出音量 ≥ 50% 且扬声器没有被物理静音；',
  '2. 麦克风离扬声器 0.3–1 m，避开正对风扇/机箱；',
  '3. 把**输入采集增益**设为 0 dB（「声音设置 → 输入」；当前读数见下面麦克风一项——控制台只显示并提示，不会替你改系统设置）；',
  '4. 仍不达标时用外接麦克风（本机内置阵列的自噪是瓶颈）。',
  '',
  '本节由报告生成器固定输出（`renderAcceptanceReport` 的 `ACCEPTANCE_CRITERIA_NOTE`），**重跑 `--acceptance` 不会丢失**。',
  '',
];

/** Render the acceptance result as the Markdown report the task asks for. */
export function renderAcceptanceReport(report: AcceptanceReport, extra: { readonly privacyNotes?: readonly string[]; readonly calibration?: CalibrationView | null } = {}): string {
  const lines: string[] = [];
  lines.push(`# 现场测试报告（设备验收）— ${report.date}`);
  lines.push('');
  lines.push(`- 生成时间：${report.at}`);
  lines.push(`- 命令：\`${report.command}\``);
  lines.push(`- 机器：${String(report.environment.host ?? '?')}｜Node ${String(report.environment.node ?? '?')}｜${String(report.environment.platform ?? '?')}`);
  lines.push(`- 探测用 Python：\`${String(report.environment.probePython ?? '?')}\`（设备端点/麦克风/摄像头）、\`${String(report.environment.audioPython ?? '?')}\`（声学回环）`);
  lines.push(`- **总体结论：${report.overall === 'pass' ? '通过（PASS）' : '未通过（FAIL，逐项见下）'}**`);
  lines.push('');
  lines.push(...ACCEPTANCE_CRITERIA_NOTE);
  lines.push('| 顺序 | 项目 | 结论 | 摘要 |');
  lines.push('|---|---|---|---|');
  for (const item of [...report.items].sort((a, b) => a.order - b.order)) {
    const label = item.verdict === 'pass' ? '通过' : item.verdict === 'fail' ? '失败' : '跳过';
    lines.push(`| ${item.order} | ${item.name} | ${label} | ${item.summary.replace(/\|/g, '/')} |`);
  }
  lines.push('');
  for (const item of [...report.items].sort((a, b) => a.order - b.order)) {
    lines.push(`## ${item.order}. ${item.name}`);
    lines.push('');
    lines.push(`**结论**：${item.verdict === 'pass' ? '通过' : item.verdict === 'fail' ? '失败' : '跳过'}｜${item.summary}`);
    lines.push('');
    lines.push('| 检查项 | 结果 | 实测 |');
    lines.push('|---|---|---|');
    for (const check of item.checks) {
      lines.push(`| ${check.name} | ${check.verdict === 'pass' ? '通过' : check.verdict === 'fail' ? '失败' : '信息'} | ${check.detail.replace(/\|/g, '/')} |`);
    }
    lines.push('');
    lines.push(`**下一步动作**：${stripNextPrefix(item.nextAction)}`);
    lines.push('');
    lines.push('<details><summary>原始证据（JSON）</summary>');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(item.evidence, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (extra.calibration != null) {
    lines.push('## 麦克风校准与隐私策略');
    lines.push('');
    lines.push(`- 噪声底来源：${extra.calibration.note}`);
    if (extra.calibration.available) {
      lines.push(`- 噪声底 ${extra.calibration.noiseFloorDbfs ?? '?'} dBFS，门限 ${extra.calibration.gateThresholdDbfs ?? '?'} dBFS，高通 ${extra.calibration.highpassHz ?? '?'} Hz，建议采集增益 ${extra.calibration.suggestedCaptureGainDb ?? '?'} dB`);
    }
    for (const note of extra.privacyNotes ?? []) lines.push(`- ${note}`);
    lines.push('');
  }
  lines.push('## 已知风险与判据说明');
  lines.push('');
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push('- 本机实测噪声底 −30.86 dBFS、环境 RMS −27.25 dBFS（勘测 §1.2），麦克风噪声是当前最大风险；麦克风一项的「通过」不等于「识别一定准」。');
  lines.push('- 噪声底每次重新实测，不沿用旧数字：本轮与勘测的差异来自采集音量/设备状态（Windows 采集端点音量、麦克风位置），所以报告里的数字以本文件为准，勘测数字只作对照。');
  lines.push('- 绝对 RMS 不能当扬声器判据：勘测实测扬声器静音时 RMS 反而更高（0.0505 vs 0.0486），因此本报告用「播放窗 − 静音窗」的**相对**判据；其中主判据是**能量比**（保守、≥10 dB），帧级 dB 分位只作乐观上界参考。');
  lines.push('- 扬声器判据的门限（10 dB）没有因为口径变化而改变，但换到能量比口径后本机读数会明显更低——这正是勘测 0.8–2.6 dB 与旧报告「11 dB 通过」之间矛盾的解释。');
  lines.push('');
  lines.push('## 复现方式');
  lines.push('');
  lines.push('```powershell');
  lines.push('npm run field-test                 # 打开现场测试控制台，页面里点「开始设备自检」');
  lines.push('node scripts/field-test.ts --acceptance   # 只跑一次真机验收并重写本报告');
  lines.push('node scripts/field-test.ts --self-test    # 离线自检（隐私/多段语音/页面），不碰硬件');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

// --------------------------------------------------------------------------------------
// Console server: one page, one port, 127.0.0.1 only
// --------------------------------------------------------------------------------------

export interface ConsoleTurn {
  readonly kind: 'voice' | 'text';
  readonly at: string;
  readonly action: string;
  readonly actionText: string;
  readonly reason: string;
  readonly reasonText: string;
  readonly transcript: string | null;
  readonly reply: string | null;
  readonly state: string;
  readonly stages: VoiceStageTimings;
  readonly segmentsTotal: number;
  readonly segmentsUsed: number;
  readonly droppedSegments: readonly DroppedSegment[];
  readonly privacyNote: string;
  /** ADR-0010: how the reply is spoken (1..3 pieces), and the pause between them. */
  readonly replySegments?: readonly string[];
  readonly replyGapMs?: number;
  /** `回应你` for a turn, `主动开口` for a proactive message. */
  readonly source?: string;
}

export interface FieldServerOptions {
  readonly port: number;
  readonly ttsEnabled?: boolean;
  readonly offline?: boolean;
  readonly useDsh?: boolean;
  readonly voiceDir?: string;
  readonly dataDir?: string;
  readonly presenceDataDir?: string;
  readonly reportDir?: string;
  readonly autoPrune?: boolean;
  readonly probeRunner?: ProbeRunner;
  readonly log?: (line: string) => void;
}

export interface FieldServerHandle {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  readonly turns: readonly ConsoleTurn[];
  close(): Promise<void>;
}

/** Build the server (exported so `--self-test` can drive the real HTTP surface). */
export async function createFieldServer(options: FieldServerOptions): Promise<FieldServerHandle> {
  const log = options.log ?? ((line: string): void => console.log(line));
  const offline = options.offline === true;
  const ttsEnabled = options.ttsEnabled !== false;
  const voiceDir = options.voiceDir ?? VOICE_DIR;
  const reportDir = options.reportDir ?? REPORT_DIR;
  const config = loadConfig();
  const client = new MimoClient();
  const dataDir = options.dataDir ?? join(REPO_ROOT, 'data', 'field-test');
  const store = openXixiStore({ dataDir });
  store.seedSelfProfile(config.personality.base);
  const policy = retentionPolicy(config);
  const pruned = options.autoPrune === false ? { dir: voiceDir, removed: [], kept: 0, bytesFreed: 0 } : pruneVoiceDir(voiceDir, policy);
  if (pruned.removed.length > 0) {
    log(`[privacy] 按保留策略清理 ${pruned.removed.length} 个文件（${Math.round(pruned.bytesFreed / 1024)} KB）：${pruned.removed.map((item) => item.name).join('、')}`);
  }
  store.recordHealth('field-test', 'ok', `console started (offline=${offline})`);

  function buildAdapter(): BrainAdapter {
    if (offline) return new FakeBrainAdapter();
    if (!options.useDsh) {
      return new MimoBrainAdapter({
        client,
        maxCompletionTokens: 400,
        tools: defaultTools({ defaultPlace: config.identity.place ?? '' }),
        timezone: config.identity.timezone,
        onToolCall: (record) => log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`),
      });
    }
    return new DshBrainAdapter({
      transport: new CliDshTransport({
        dshHome: DSH_HOME,
        profile: DSH_PROFILE,
        cwd: REPO_ROOT,
        env: harnessEnv(),
        timeoutMs: 240_000,
        onDiagnostic: (line) => log(`[dsh] ${line}`),
      }),
      store,
    });
  }

  const engine = new ConversationEngine({ adapter: buildAdapter(), store, config, turnTimeoutMs: 90_000 });
  let session = store.latestSession() ?? store.createSession();

  // -------------------------------------------------- proactive card state (t42)
  // The engine is rebuilt per consideration with whatever is in the snapshot, so a saved knob
  // takes effect on the very next drill (no restart, no cache to invalidate).
  let proactiveSnapshot = restoreProactiveSettings(store, config.proactive as unknown as Record<string, unknown>);
  if (proactiveSnapshot.source === 'console') {
    log(`[proactive] 已从审计记录恢复设置（${proactiveSnapshot.updatedAt ?? '?'}）：${proactiveSnapshot.settings.enabled ? '允许主动开口' : '已关闭'}`);
  }
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
  const turns: ConsoleTurn[] = [];
  const startedAt = new Date().toISOString();

  // -------------------------------------------------- resident consideration loop (t70)
  // Off until the page asks for it. Everything it needs is a *reader* — the loop never caches
  // settings or the FSM state, so a knob saved a second ago (or a conversation that just
  // started) is honoured on the very next tick.
  let turnInFlight = false;
  const loopSynthesize =
    ttsEnabled && client.hasKey ? async (text: string): Promise<Buffer> => await client.synthesize(text) : undefined;
  const proactiveLoop = new ProactiveLoop({
    store,
    readSettings: () => proactiveSnapshot.settings,
    readState: () => engine.state,
    readInFlightTurn: () => turnInFlight,
    readProactivity: () => effectiveProactivity(store.selfProfile()),
    readPresence: async () => {
      const view = await readPresence({ store: getPresenceStore() });
      return view === null ? null : { present: view.present, updatedAt: view.updatedAt, source: view.source };
    },
    readLastUserTurnAt: () => lastUserTurnAt(store, session.sessionId),
    readSessionId: () => session.sessionId,
    replyLimits: config.reply,
    synthesize: loopSynthesize,
    log,
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

  const deps: VoiceDeps = {
    python: DEFAULT_PYTHON,
    voiceDir,
    client,
    engine,
    currentSessionId: () => session.sessionId,
    ttsEnabled,
    policy,
    asr: offline ? async (audio: Buffer): Promise<string> => `（离线自检）收到 ${audio.length} 字节语音` : undefined,
    log,
  };

  let presenceStore: unknown;
  /** Where the presence projection is read from (`--presence-data-dir`, default `data`). */
  const presenceDataDir = options.presenceDataDir ?? join(REPO_ROOT, 'data');
  function getPresenceStore(): unknown {
    if (presenceStore === undefined) {
      try {
        presenceStore = openXixiStore({ dataDir: presenceDataDir });
      } catch (error) {
        log(`[presence] 打不开在场投影的库：${error instanceof Error ? error.message : String(error)}`);
        presenceStore = null;
      }
    }
    return presenceStore ?? undefined;
  }

  let acceptanceRunning = false;
  const calibration = readCalibration();

  /**
   * F7: the Windows input/output endpoint readings the console shows (mute, volume, and
   * for the input endpoint the *capture gain*, which is the same number Windows calls the
   * endpoint volume). pycaw is used read-only here: nothing in this repo writes these
   * settings, the console only *suggests* 0 dB when the measured noise floor is high.
   */
  const probePath = join(REPO_ROOT, 'data', 'field-test', 'device-probe.py');
  mkdirSync(dirname(probePath), { recursive: true });
  if (!existsSync(probePath)) writeFileSync(probePath, DEVICE_PROBE_PY, 'utf8');
  const endpointsRunner = options.probeRunner ?? defaultProbeRunner(probePath, REPO_ROOT);
  let endpointsCache: { at: number; payload: Record<string, unknown> } | null = null;

  async function readEndpoints(force = false): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (!force && endpointsCache !== null && now - endpointsCache.at < 15_000) return endpointsCache.payload;
    let payload: Record<string, unknown>;
    try {
      const probe = await endpointsRunner('endpoints', [], PROBE_PYTHON);
      if (probe.ok === false) throw new ConsoleError('ENDPOINT_READ_FAILED', `读不到 Windows 端点状态：${String(probe.error ?? '未知原因')}`, '确认 .venvs/field-probe 里有 pycaw + comtypes；没有它也能跑麦克风/扬声器自检，只是看不到系统读数');
      const render = (probe.render ?? {}) as Record<string, unknown>;
      const capture = (probe.capture ?? {}) as Record<string, unknown>;
      const gain = numberField(capture, 'gainDb') ?? numberField(capture, 'volumeDb');
      const noiseFloor = calibration.noiseFloorDbfs;
      const noiseFloorHigh = noiseFloor !== null && noiseFloor > -40;
      payload = {
        ok: true,
        checkedAt: new Date().toISOString(),
        readOnly: true,
        render,
        capture,
        captureGainDb: gain,
        noiseFloorDbfs: noiseFloor,
        noiseFloorHigh,
        hint: noiseFloorHigh
          ? `当前输入采集增益 ${gain ?? '?'} dB；实测噪声底 ${noiseFloor ?? '?'} dBFS 偏高，可考虑在「声音设置 → 输入」里把它设为 0 dB（实测 1:1 换回约 5.5 dB 噪声余量）。控制台只提示，不会修改任何系统设置`
          : `当前输入采集增益 ${gain ?? '?'} dB；实测噪声底 ${noiseFloor ?? '?'} dBFS 不算高，保持现状即可`,
        readOnlyNote: '这组读数由 pycaw 只读取得；本仓库代码不会修改系统音频设置（t6 核实：采集增益为系统值，没有任何代码设置它）',
      };
    } catch (error) {
      payload = {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: {
          message: error instanceof ConsoleError ? error.message : `读不到 Windows 端点状态：${probeError(error)}`,
          hint: error instanceof ConsoleError ? error.hint : '确认 .venvs/field-probe 里有 pycaw + comtypes',
        },
      };
      log(`[endpoints] ${String((payload.error as Record<string, unknown>).message)}`);
    }
    endpointsCache = { at: now, payload };
    return payload;
  }

  function pushTurn(turn: ConsoleTurn): void {
    turns.unshift(turn);
    if (turns.length > 20) turns.pop();
  }

  async function statePayload(): Promise<Record<string, unknown>> {
    const presence = await readPresence({ store: getPresenceStore() });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : options.port;
    return {
      listen: `127.0.0.1:${port}`,
      startedAt,
      sessionId: session.sessionId,
      turnCount: store.getSession(session.sessionId).turnCount,
      state: engine.state,
      adapter: engine.adapter.describe(),
      identity: config.identity,
      personality: store.selfProfile(),
      privacy: { policy, pruned, voiceDir },
      database: { path: dataDir, presencePath: presenceDataDir, entries: XIXI_DB_ENTRIES, note: '四个入口各用不同的库；在别处设的人格与历史不会带到这里' },
      segmentPlayback: { textSegmented: true, ttsSegmented: false, note: SEGMENT_TTS_NOTE },
      model: { configured: client.hasKey, offline },
      calibration,
      presence,
      recent: turns,
      ttsEnabled,
      reportDir,
    };
  }

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          const address = server.address();
          const port = typeof address === 'object' && address !== null ? address.port : options.port;
          const boot = { listen: `127.0.0.1:${port}`, offline, ttsEnabled, modelConfigured: client.hasKey, calibration, policy, databasePath: dataDir };
          // Build first, write second: if the page builder throws, the catch below can still
          // answer with a readable 500 instead of a blank 200 page (t42's crash was exactly
          // that shape — `writeHead` had already gone out when the `ReferenceError` fired).
          const page = buildFieldPage(boot);
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(page);
          return;
        }
        if (request.method === 'GET' && url.pathname === '/favicon.ico') {
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/field/state') {
          json(response, 200, await statePayload());
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/field/presence') {
          json(response, 200, await readPresence({ store: getPresenceStore() }));
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/field/endpoints') {
          json(response, 200, await readEndpoints(url.searchParams.get('force') === '1'));
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/field/proactive') {
          json(response, 200, proactivePayload());
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/field/proactive/loop') {
          json(response, 200, loopPayload(Number(url.searchParams.get('cursor') ?? '0')));
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/field/proactive/loop') {
          const body = (await readBody(request)) as Record<string, unknown>;
          const action = typeof body['action'] === 'string' ? body['action'] : 'tick';
          if (action === 'start') {
            proactiveLoop.start(typeof body['intervalMs'] === 'number' ? body['intervalMs'] : undefined);
          } else if (action === 'stop') {
            proactiveLoop.stop();
          } else if (action === 'tick') {
            await proactiveLoop.tickOnce();
          } else {
            throw new ConsoleError('UNKNOWN_LOOP_ACTION', `不认识的循环操作「${action}」`, '可用：start（开始自动考虑）、stop（停止）、tick（立刻考虑一次）');
          }
          json(response, 200, loopPayload(Number(body['cursor'] ?? 0)));
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/field/proactive/settings') {
          const body = (await readBody(request)) as Record<string, unknown>;
          const applied = applyAndPersistProactivePatch({
            store,
            settings: proactiveSnapshot.settings,
            patch: body,
            proactivityBefore: effectiveProactivity(store.selfProfile()),
            log,
          });
          if (applied.changes.length > 0) {
            proactiveSnapshot = {
              settings: applied.settings,
              source: 'console',
              updatedAt: applied.auditAt ?? proactiveSnapshot.updatedAt,
              changes: applied.changes,
            };
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
        if (request.method === 'POST' && url.pathname === '/api/field/proactive/drill') {
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
          log(`[proactive] 演练 ${drill.trigger} → ${drill.reasonCode}（分数 ${drill.score}/${drill.threshold}${drill.speak ? `，分 ${drill.segments.length} 段` : ''}）`);
          json(response, 200, { ok: true, drill, state: proactivePayload() });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/field/acceptance') {
          if (acceptanceRunning) {
            json(response, 409, { ok: false, error: { code: 'BUSY', message: '设备自检正在跑，请等它结束', hint: '大约需要 10–20 秒（麦克风 3 秒 + 扬声器播放 + 摄像头取 15 帧）' } });
            return;
          }
          acceptanceRunning = true;
          try {
            const report = await runDeviceAcceptance({
              probeRunner: options.probeRunner,
              reportDir,
              presence: await readPresence({ store: getPresenceStore() }),
              log,
            });
            log(`[acceptance] 总体 ${report.overall}｜报告 ${report.reportPath ?? '(未落盘)'}`);
            json(response, 200, { ok: true, report });
          } finally {
            acceptanceRunning = false;
          }
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/voice') {
          const payload = await handleVoiceTurn(deps, await readBody(request));
          pushTurn({
            kind: 'voice',
            at: payload.at,
            action: payload.action,
            actionText: payload.actionText,
            reason: payload.reason,
            reasonText: payload.reasonText,
            transcript: payload.transcript,
            reply: payload.reply,
            state: payload.state,
            stages: payload.stages,
            segmentsTotal: payload.segmentsTotal,
            segmentsUsed: payload.segmentsUsed,
            droppedSegments: payload.droppedSegments,
            privacyNote: payload.privacy.note,
            replySegments: segmentPlan(payload.reply, config.reply).segments,
            replyGapMs: segmentPlan(payload.reply, config.reply).gapMs,
            source: '回应你',
          });
          json(response, 200, payload);
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/turn') {
          const body = await readBody(request);
          const text = (body.text ?? '').trim();
          if (text.length === 0) throw new ConsoleError('EMPTY_MESSAGE', '没有输入文字', '在输入框里打一句话再按发送');
          // While a turn is being answered, the loop must treat 「最近有对话」 as true (t70): the
          // gate reads this flag, so 西西 cannot talk over a reply that is still being produced.
          turnInFlight = true;
          let turn: Awaited<ReturnType<typeof engine.respond>>;
          try {
            turn = await engine.respond({ sessionId: session.sessionId, text, addressed: engine.state === 'IDLE' });
          } finally {
            turnInFlight = false;
          }
          let audio: string | null = null;
          if (ttsEnabled && body.speak !== false && turn.action === 'SPEAK' && turn.text !== null && client.hasKey) {
            audio = (await client.synthesize(turn.text)).toString('base64');
          }
          pushTurn({
            kind: 'text',
            at: new Date().toISOString(),
            action: turn.action,
            actionText: explainAction(turn.action),
            reason: turn.reason,
            reasonText: explainReason(turn.reason),
            transcript: text,
            reply: turn.text,
            state: turn.state,
            stages: { vadMs: 0, asrMs: null, llmFirstChunkMs: turn.firstTokenMs, llmTotalMs: turn.latencyMs, ttsMs: null, totalMs: turn.latencyMs },
            segmentsTotal: 0,
            segmentsUsed: 0,
            droppedSegments: [],
            privacyNote: '打字输入：没有音频，自然也没有录音落盘',
          });
          json(response, 200, {
            ok: true,
            reply: turn.text,
            transcript: text,
            action: turn.action,
            actionText: explainAction(turn.action),
            reason: turn.reason,
            reasonText: explainReason(turn.reason),
            accepted: turn.accepted,
            state: turn.state,
            latencyMs: turn.latencyMs,
            firstTokenMs: turn.firstTokenMs,
            model: `${turn.provider}/${turn.model}`,
            audio,
            at: new Date().toISOString(),
          });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/quiet') {
          const body = await readBody(request);
          if (body.text === 'resume') engine.resume();
          else engine.quiet();
          json(response, 200, { ok: true, state: engine.state });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/session') {
          session = store.createSession();
          engine.resume();
          turns.length = 0;
          json(response, 200, { ok: true, sessionId: session.sessionId });
          return;
        }
        json(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口', hint: '页面上的按钮只用固定的几个接口；直接开 http://127.0.0.1:' + String(options.port) + ' 即可' } });
      } catch (error) {
        /**
         * Never write a second response on the same socket.
         *
         * t42: a page-builder crash *after* `writeHead(200)` left the response half-open and
         * every later `json()` threw `ERR_HTTP_HEADERS_SENT`, which buried the real
         * `ReferenceError` under a confusing second error. The real fix was the crash itself
         * (`dataDir` → `boot.databasePath`), but a guard here keeps the next bug readable:
         * if the headers already went out we can only log.
         */
        const canReply = !response.headersSent && !response.writableEnded;
        if (error instanceof ConsoleError) {
          if (canReply) json(response, error.status, { ok: false, error: { code: error.code, message: error.message, hint: error.hint } });
          else log(`[error] ${error.code}: ${error.message}（响应已发出，无法再写回）`);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/MISSING_KEY|api.?key is not set/i.test(message)) {
          if (canReply) {
            json(response, 503, {
              ok: false,
              error: {
                code: 'MISSING_KEY',
                message: '缺少 MIMO_API_KEY：模型调用用不了',
                hint: '把 .env.example 复制成 .env 并填入 MIMO_API_KEY，然后重启现场测试；没有密钥时用 npm run field-test -- --offline 仍可看页面与设备自检',
              },
            });
          }
          return;
        }
        log(`[error] ${error instanceof Error ? (error.stack ?? message) : message}${canReply ? '' : '（响应已发出，无法再写回；上面这条就是根因）'}`);
        if (!canReply) return;
        json(response, 500, {
          ok: false,
          error: {
            code: 'INTERNAL',
            message: `服务端出错了：${message}`,
            hint: '网页不会白屏，可以继续做设备自检；完整堆栈在启动终端里，请把它发给维护者',
          },
        });
      }
    })();
  });

  await new Promise<void>((resolvePort, rejectPort) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      rejectPort(
        error.code === 'EADDRINUSE'
          ? new ConsoleError('PORT_IN_USE', `端口 ${options.port} 已被占用（可能已经开着一个现场测试或 npm run web）`, `换一个端口：npm run field-test -- --port ${options.port + 1}；或先关掉占用该端口的程序`, 500)
          : new ConsoleError('LISTEN_FAILED', `无法在本机监听 ${options.port}：${error.message}`, '检查防火墙/安全软件是否拦了 Node 监听本机端口', 500),
      );
    };
    server.once('error', onError);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', onError);
      resolvePort();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    turns,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        // Browsers/undici keep sockets alive; without this a test (or Ctrl+C)
        // waits for the keep-alive timeout before the process can exit.
        server.closeAllConnections();
        for (const candidate of [store, presenceStore]) {
          const close = (candidate as { close?: () => void } | null | undefined)?.close;
          if (typeof close === 'function') {
            try {
              (candidate as { close: () => void }).close();
            } catch {
              /* already closed */
            }
          }
        }
      }),
  };
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

interface TurnBodyLike {
  readonly text?: string;
  readonly speak?: boolean;
  readonly audioBase64?: string;
}

async function readBody(request: IncomingMessage): Promise<TurnBodyLike> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as TurnBodyLike;
  } catch {
    throw new ConsoleError('BAD_JSON', '请求体不是合法 JSON', '刷新页面重试');
  }
}

// --------------------------------------------------------------------------------------
// The page (Chinese, aimed at a non-engineer)
// --------------------------------------------------------------------------------------

export interface FieldBootstrap {
  readonly listen: string;
  readonly offline: boolean;
  readonly ttsEnabled: boolean;
  readonly modelConfigured: boolean;
  readonly calibration: CalibrationView;
  readonly policy: RetentionPolicy;
  /**
   * Which SQLite file this console writes to.
   *
   * It has to be *passed in* (t42): the page builder is a pure function of `FieldBootstrap`,
   * and reaching for the server's local variable from inside it crashed the page with
   * `ReferenceError: dataDir is not defined` the first time it was tried.
   */
  readonly databasePath: string;
}

// ==================================================== proactive console core (t42)
//
// ADR-0010 (multi-segment replies) and ADR-0009 (proactive engine) are package-level
// behaviour. What lives here is only what a *human* needs in order to trust them:
//
//   * the segment plan the page renders one-by-one (with the real gap) and the terminal
//     prints one-by-one — so "功能没生效" cannot be confused with "第二段还没到";
//   * the proactive settings a page may tune, persisted as an audit record so a restart
//     keeps them (the engine itself keeps no state: quotas/cooldown are recomputed from
//     the log by `readProactiveHistory`);
//   * a per-gate table for one consideration, so 「为什么西西这次没开口」 has an answer.
//
// `scripts/serve-chat.ts` imports these. They live in this file (rather than a new
// `scripts/lib/*.ts`) because this file already owns the shared console core (voice turn,
// retention policy, report writer) and because `scripts/lib/` is outside t42's scope.

/** `system.health.service` of the audit records that persist console-tuned proactive settings. */
export const PROACTIVE_SETTINGS_SERVICE = 'proactive-settings';

/** Shape version of the audit record's `detail` field. */
const PROACTIVE_SETTINGS_AUDIT_VERSION = 1;

/** Chinese label for every reason code, in the engine's fixed evaluation order. */
export const PROACTIVE_GATE_LABELS: Readonly<Record<ProactiveReasonCode, string>> = Object.freeze({
  DISABLED: '主动性总开关关闭',
  TRIGGER_DISABLED: '这个触发源关掉了',
  ALREADY_DELIVERED: '这条已经说过了（不重发）',
  DND_ACTIVE: '安静模式 / 今天安静点',
  QUIET_HOURS: '静默时段（安全底线，不可放宽）',
  COOLDOWN_ACTIVE: '距上一条主动开口还没到冷却时间',
  QUOTA_6H_EXCEEDED: '6 小时额度已用完',
  QUOTA_DAY_EXCEEDED: '当日额度已用完',
  TOPIC_REPEATED: '同一话题在抑制窗口内说过了',
  CONVERSATION_ACTIVE: '正在对话里（或还有一轮没结束）',
  SCORE_BELOW_THRESHOLD: '分数没到阈值',
  SCENE_UNAVAILABLE: '场景不合适（媒体播放中 / 通话中）',
  SPEECH_UNAVAILABLE: '语音输出不可用',
  PASSED: '全部通过：可以开口',
});

/** Chinese label for every trigger source (§16 priority order). */
export const PROACTIVE_TRIGGER_LABELS: Readonly<Record<ProactiveTrigger, string>> = Object.freeze({
  future_hook_due: '未来钩子到期（你之前提过的事）',
  presence_arrived: '有人到家（摄像头在场）',
  conversation_dangling: '对话悬着没说完',
  routine_expected: '作息预期（这个点通常会发生）',
  topic_pool: '话题池里轮到一个',
  random_smalltalk: '随机闲聊（默认关：没合适话题就别开口）',
});

export function formatClockMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${`${Math.floor(wrapped / 60)}`.padStart(2, '0')}:${`${wrapped % 60}`.padStart(2, '0')}`;
}

/** `"22:30"` → 1350; anything unusable → `null` (the caller decides what to fall back to). */
export function parseClockMinutesInput(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface ProactiveSettingsSnapshot {
  readonly settings: ProactiveSettings;
  /** `console` = restored from the page's audit record; `config` = `config/xixi.yaml`'s `proactive` block. */
  readonly source: 'console' | 'config';
  readonly updatedAt: string | null;
  /** What the last save changed, in Chinese, for the audit trail. */
  readonly changes: readonly string[];
}

export interface ProactiveSettingsAuditRow {
  readonly at: string;
  readonly sequence: number;
  readonly changes: readonly string[];
  readonly settings: ProactiveSettings;
}

function proactiveSettingsAuditRows(store: XixiStore): ProactiveSettingsAuditRow[] {
  const rows: ProactiveSettingsAuditRow[] = [];
  for (const event of store.readEvents({ type: 'system.health', limit: Number.MAX_SAFE_INTEGER })) {
    const payload = event.payload as Record<string, unknown>;
    if (payload['service'] !== PROACTIVE_SETTINGS_SERVICE) continue;
    const detail = payload['detail'];
    if (typeof detail !== 'string') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(detail) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed['v'] !== PROACTIVE_SETTINGS_AUDIT_VERSION) continue;
    const source = parsed['settings'];
    rows.push({
      at: event.timestamp,
      sequence: event.sequence,
      changes: Array.isArray(parsed['changes']) ? (parsed['changes'] as string[]) : [],
      settings: parseProactiveSettings(isMapping(source) ? (source as Record<string, unknown>) : undefined),
    });
  }
  return rows;
}

/** The settings a page should show: the last console save, else the config file's `proactive`. */
export function restoreProactiveSettings(store: XixiStore, config?: Readonly<Record<string, unknown>> | undefined): ProactiveSettingsSnapshot {
  const rows = proactiveSettingsAuditRows(store);
  const last = rows[rows.length - 1];
  if (last !== undefined) {
    return { settings: last.settings, source: 'console', updatedAt: last.at, changes: last.changes };
  }
  return { settings: parseProactiveSettings(config), source: 'config', updatedAt: null, changes: [] };
}

/**
 * Persist tuned settings as a `system.health` record (schema v1, `service = proactive-settings`).
 *
 * Why not a new event type: `packages/` is outside t42's scope, and `system.health` is the
 * existing versioned "something about the running system changed" record — the same channel
 * `field-test` already uses for its own startup line. The payload is compact (one line of
 * JSON, well inside the 500-char `detail` cap) and carries the *effective* values, so
 * `restoreProactiveSettings` can rebuild them without trusting any other file.
 */
export function persistProactiveSettings(
  store: XixiStore,
  settings: ProactiveSettings,
  changes: readonly string[],
): StoredEvent {
  const detail = JSON.stringify({
    v: PROACTIVE_SETTINGS_AUDIT_VERSION,
    settings: proactiveSettingsToConfig(settings),
    changes,
  });
  return store.recordHealth(PROACTIVE_SETTINGS_SERVICE, 'ok', detail);
}

/** Typed settings → the `config.proactive` shape, so one parser validates both sources. */
export function proactiveSettingsToConfig(settings: ProactiveSettings): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    base_cooldown_min: settings.baseCooldownMinutes,
    max_per_6h: settings.maxPer6h,
    max_per_day: settings.maxPerDay,
    topic_repeat_window_h: settings.topicRepeatWindowHours,
    negative_feedback_cooldown_multiplier: settings.negativeFeedbackCooldownMultiplier,
    quiet_hours: { start: formatClockMinutes(settings.quietHours.startMinutes), end: formatClockMinutes(settings.quietHours.endMinutes) },
    triggers: { ...settings.triggers },
  };
}

export interface ProactiveSettingsPatchResult {
  readonly settings: ProactiveSettings;
  /** Human-readable list of what changed (empty = the patch was a no-op). */
  readonly changes: readonly string[];
  /** Fields the page sent that were ignored, with the reason. */
  readonly rejected: readonly string[];
  /**
   * The new 「主动性总强度」 (personality `proactivity`) when the patch asked for one.
   *
   * It is *not* part of `ProactiveSettings`: proactivity is a personality property that lives in
   * `self_profile` (ADR-0009 §4 — it moves the score threshold and nothing else), so the caller
   * writes it through `overrideSelfProfile` while the gate/knob settings go to the audit record.
   */
  readonly proactivity: number | null;
}

/** The fields `applyProactiveSettingsPatch` understands; anything else is reported, never dropped. */
export const PROACTIVE_PATCH_FIELDS: readonly string[] = Object.freeze([
  'enabled',
  'baseCooldownMinutes',
  'maxPer6h',
  'maxPerDay',
  'topicRepeatWindowHours',
  'negativeFeedbackCooldownMultiplier',
  'quietStart',
  'quietEnd',
  'triggers',
  'proactivity',
]);

/**
 * Apply a page patch to the current settings.
 *
 * Validation goes through the engine's own `parseProactiveSettings`, so a bad input can
 * never produce a settings object the engine would not have accepted: out-of-range numbers
 * and malformed clock strings fall back to the *current* value, and the page is told which
 * fields were rejected instead of silently getting a different number than it typed.
 *
 * Unknown keys are rejected too (t63): the first version dropped them, so a caller that sent
 * `proactivity` — or a typo like `max_per_day` — got `changes: []` **and** `rejected: []`, which
 * reads as "saved, nothing to do". A settings API that silently ignores what it does not
 * understand is indistinguishable from a broken one.
 */
export function applyProactiveSettingsPatch(current: ProactiveSettings, patch: Readonly<Record<string, unknown>>): ProactiveSettingsPatchResult {
  const rejected: string[] = [];
  const merged = proactiveSettingsToConfig(current) as Record<string, unknown>;

  for (const key of Object.keys(patch)) {
    if (!PROACTIVE_PATCH_FIELDS.includes(key)) {
      rejected.push(`「${key}」不是这个接口认识的字段，已忽略（可用字段：${PROACTIVE_PATCH_FIELDS.join('、')}）`);
    }
  }

  // 「主动性总强度」 is a personality value, not an engine setting: validate 0..1 here and let
  // the caller write it to `self_profile` (with its own history row).
  let proactivity: number | null = null;
  if (patch['proactivity'] !== undefined) {
    const parsed = typeof patch['proactivity'] === 'number' ? patch['proactivity'] : Number(String(patch['proactivity']).trim());
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      rejected.push(`proactivity：要在 0 到 1 之间（当前 ${current === undefined ? '?' : ''}数值不合法），已忽略`);
    } else {
      proactivity = parsed;
    }
  }

  if (patch['enabled'] !== undefined) merged['enabled'] = patch['enabled'] === true || patch['enabled'] === 'true';
  for (const [field, key] of [
    ['baseCooldownMinutes', 'base_cooldown_min'],
    ['maxPer6h', 'max_per_6h'],
    ['maxPerDay', 'max_per_day'],
    ['topicRepeatWindowHours', 'topic_repeat_window_h'],
    ['negativeFeedbackCooldownMultiplier', 'negative_feedback_cooldown_multiplier'],
  ] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(parsed)) {
      rejected.push(`${field}：不是数字，已忽略`);
      continue;
    }
    merged[key] = parsed;
  }

  const quiet = merged['quiet_hours'] as Record<string, unknown>;
  for (const [field, key] of [
    ['quietStart', 'start'],
    ['quietEnd', 'end'],
  ] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (parseClockMinutesInput(value) === null) {
      rejected.push(`${field}：时间要写成 HH:MM（如 22:30），已忽略`);
      continue;
    }
    quiet[key] = value;
  }

  if (isMapping(patch['triggers'])) {
    const triggers = merged['triggers'] as Record<string, boolean>;
    for (const trigger of PROACTIVE_TRIGGERS) {
      const value = (patch['triggers'] as Record<string, unknown>)[trigger];
      if (value === undefined) continue;
      triggers[trigger] = value === true || value === 'true';
    }
  } else if (patch['triggers'] !== undefined) {
    rejected.push('triggers：要传一个对象（键=触发源，值=开关），已忽略');
  }

  const settings = parseProactiveSettings(merged);
  const changes: string[] = [];
  if (settings.enabled !== current.enabled) changes.push(`主动开口：${current.enabled ? '开' : '关'} → ${settings.enabled ? '开' : '关'}`);
  if (settings.baseCooldownMinutes !== current.baseCooldownMinutes) changes.push(`冷却：${current.baseCooldownMinutes} → ${settings.baseCooldownMinutes} 分钟`);
  if (settings.maxPer6h !== current.maxPer6h) changes.push(`6 小时额度：${current.maxPer6h} → ${settings.maxPer6h}`);
  if (settings.maxPerDay !== current.maxPerDay) changes.push(`当日额度：${current.maxPerDay} → ${settings.maxPerDay}`);
  if (settings.topicRepeatWindowHours !== current.topicRepeatWindowHours) {
    changes.push(`同主题抑制窗口：${current.topicRepeatWindowHours} → ${settings.topicRepeatWindowHours} 小时`);
  }
  if (settings.negativeFeedbackCooldownMultiplier !== current.negativeFeedbackCooldownMultiplier) {
    changes.push(`负面反馈倍率：${current.negativeFeedbackCooldownMultiplier} → ${settings.negativeFeedbackCooldownMultiplier}`);
  }
  if (settings.quietHours.startMinutes !== current.quietHours.startMinutes || settings.quietHours.endMinutes !== current.quietHours.endMinutes) {
    changes.push(
      `静默时段：${formatClockMinutes(current.quietHours.startMinutes)}–${formatClockMinutes(current.quietHours.endMinutes)}` +
        ` → ${formatClockMinutes(settings.quietHours.startMinutes)}–${formatClockMinutes(settings.quietHours.endMinutes)}`,
    );
  }
  for (const trigger of PROACTIVE_TRIGGERS) {
    if (settings.triggers[trigger] !== current.triggers[trigger]) {
      changes.push(`${PROACTIVE_TRIGGER_LABELS[trigger]}：${current.triggers[trigger] ? '开' : '关'} → ${settings.triggers[trigger] ? '开' : '关'}`);
    }
  }
  return { settings, changes, rejected, proactivity };
}

/** The change line for a personality write, kept out of `changes` only when nothing moved. */
export function proactivityChangeLine(before: number, after: number): string {
  return `主动性总强度（人格 proactivity）：${before} → ${after}（写入 self_profile，来源 console:proactivity）`;
}

export interface ProactivePatchApplication {
  readonly settings: ProactiveSettings;
  readonly changes: readonly string[];
  readonly rejected: readonly string[];
  /** The personality write, when the patch asked for one that actually moved the value. */
  readonly proactivity: { readonly before: number; readonly after: number } | null;
  /** Sequence of the `system.health` audit row, or `null` when nothing changed. */
  readonly auditSequence: number | null;
  /** Timestamp of that audit row (what the page shows as 「上次保存」), or `null`. */
  readonly auditAt: string | null;
}

/**
 * Apply one patch end-to-end: engine settings + the personality value, then one audit row.
 *
 * Both pages call this, so "调完就生效、还留了痕迹" is one code path (t63). The personality
 * write goes through `overrideSelfProfile`, which is the project's **administrative override**
 * seam: it upserts `self_profile` *and* appends a `self_profile_history` row, so the change is
 * both live and auditable — while the engine knobs land in the `system.health` audit record
 * that `restoreProactiveSettings` reads back on the next start.
 */
export function applyAndPersistProactivePatch(options: {
  readonly store: XixiStore;
  readonly settings: ProactiveSettings;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly proactivityBefore: number;
  readonly log?: ((line: string) => void) | undefined;
}): ProactivePatchApplication {
  const patched = applyProactiveSettingsPatch(options.settings, options.patch);
  const changes = [...patched.changes];
  let proactivity: { before: number; after: number } | null = null;
  if (patched.proactivity !== null && patched.proactivity !== options.proactivityBefore) {
    options.store.overrideSelfProfile({ proactivity: patched.proactivity }, 'console:proactivity');
    proactivity = { before: options.proactivityBefore, after: patched.proactivity };
    changes.push(proactivityChangeLine(proactivity.before, proactivity.after));
  }
  let auditSequence: number | null = null;
  let auditAt: string | null = null;
  if (changes.length > 0) {
    const event = persistProactiveSettings(options.store, patched.settings, changes);
    auditSequence = event.sequence;
    auditAt = event.timestamp;
    options.log?.(`[proactive] 设置已更新（事件 #${event.sequence}）：${changes.join('；')}`);
  }
  return { settings: patched.settings, changes, rejected: patched.rejected, proactivity, auditSequence, auditAt };
}

export interface ProactiveGateRow {
  readonly code: ProactiveReasonCode;
  readonly label: string;
  /** `passed` = evaluated and allowed; `blocked` = the first gate that fired; `skipped` = never reached. */
  readonly status: 'passed' | 'blocked' | 'skipped';
}

/**
 * The gate table for one consideration.
 *
 * The engine evaluates the gates in `PROACTIVE_REASON_CODES` order and reports only the
 * first hit, so the rows are derived from that single code: everything *before* the hit
 * passed, the hit itself blocked (or passed, for `PASSED`), everything after was never
 * evaluated. That keeps the table honest without duplicating any gate logic here.
 */
export function proactiveGateRows(reasonCode: ProactiveReasonCode | null): ProactiveGateRow[] {
  if (reasonCode === null) return PROACTIVE_REASON_CODES.map((code) => ({ code, label: PROACTIVE_GATE_LABELS[code], status: 'skipped' as const }));
  const hit = PROACTIVE_REASON_CODES.indexOf(reasonCode);
  return PROACTIVE_REASON_CODES.map((code, index) => ({
    code,
    label: PROACTIVE_GATE_LABELS[code],
    status: index < hit ? 'passed' : index === hit ? (code === 'PASSED' ? 'passed' : 'blocked') : 'skipped',
  }));
}

export interface ProactiveUsage {
  readonly deliveries: number;
  readonly lastDeliveryAt: string | null;
  readonly cooldownRemainingMs: number;
  readonly in6h: number;
  readonly today: number;
  readonly day: string;
}

/** Budget/cooldown usage, recomputed from the log (never cached — a restart must not lose it). */
export function proactiveUsage(store: XixiStore, settings: ProactiveSettings, now: Date, offsetMinutes?: number): ProactiveUsage {
  const history = readProactiveHistory(store);
  const day = localDayOf(now, offsetMinutes);
  const last = history[history.length - 1];
  const cooldownMs = settings.baseCooldownMinutes * 60_000;
  const sinceLast = last === undefined ? Number.POSITIVE_INFINITY : now.getTime() - last.at.getTime();
  return {
    deliveries: history.length,
    lastDeliveryAt: last === undefined ? null : last.at.toISOString(),
    cooldownRemainingMs: last === undefined || cooldownMs === 0 ? 0 : Math.max(0, cooldownMs - sinceLast),
    in6h: history.filter((record) => now.getTime() - record.at.getTime() < 6 * 60 * 60_000).length,
    today: history.filter((record) => localDayOf(record.at, offsetMinutes) === day).length,
    day,
  };
}

/** `YYYY-MM-DD` of the local natural day; `offsetMinutes` is the test/replay seam. */
export function localDayOf(at: Date, offsetMinutes?: number): string {
  const shifted = offsetMinutes === undefined ? at : new Date(at.getTime() + offsetMinutes * 60_000);
  const year = offsetMinutes === undefined ? shifted.getFullYear() : shifted.getUTCFullYear();
  const month = `${(offsetMinutes === undefined ? shifted.getMonth() : shifted.getUTCMonth()) + 1}`.padStart(2, '0');
  const day = `${(offsetMinutes === undefined ? shifted.getDate() : shifted.getUTCDate())}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface ProactiveDecisionRow {
  readonly at: string;
  readonly sequence: number;
  readonly candidateId: string;
  readonly trigger: string;
  readonly speak: boolean;
  readonly reasonCode: string;
  readonly score: number;
  readonly threshold: number;
}

/** The last few considerations, straight from the log (this is the auditable trail). */
export function proactiveDecisionHistory(store: XixiStore, limit = 8): ProactiveDecisionRow[] {
  const events = store.readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER });
  return events
    .slice(-limit)
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      return {
        at: event.timestamp,
        sequence: event.sequence,
        candidateId: typeof payload['candidate_id'] === 'string' ? payload['candidate_id'] : '?',
        trigger: typeof payload['trigger'] === 'string' ? payload['trigger'] : '?',
        speak: payload['speak'] === true,
        reasonCode: typeof payload['reason_code'] === 'string' ? payload['reason_code'] : '?',
        score: typeof payload['score'] === 'number' ? payload['score'] : 0,
        threshold: typeof payload['threshold'] === 'number' ? payload['threshold'] : 0,
      };
    });
}

/**
 * The drill's canned utterances.
 *
 * A drill exercises the *pipeline* (score → gates → decision event → delivery seam →
 * segment playback); the wording is a fixture and is labelled as one in the UI, because
 * generating the text is M5's job (the trigger sources). `presence_arrived` is
 * deliberately longer than one segment so the multi-segment playback is demonstrable.
 */
export const PROACTIVE_DRILL_LINES: Readonly<Record<ProactiveTrigger, string>> = Object.freeze({
  future_hook_due: '你上周提过这两天要去复诊，别忘了带医保卡。要不要我到时候再提醒你一次？',
  presence_arrived: '哎，你回来啦。今天外面挺冷的，我看你外套都没穿厚。要不要先喝口热水？对了，我把你要问的天气也一起记下来了，明天出门记得带伞。',
  conversation_dangling: '刚才你说到一半的那件事，后来怎么样了？我记着呢，不用怕我不记得。',
  routine_expected: '这个点你通常在厨房忙，我就问一句：需要我帮你看着时间吗？',
  topic_pool: '你前两天说想找的那本书，我还记着；要不要我念一下当时你说的话？',
  random_smalltalk: '（随口一句）今天家里挺安静的。',
});

/** Score components that make a drill candidate pass the threshold; negative terms stay low. */
export const PROACTIVE_DRILL_COMPONENTS: Readonly<Record<string, number>> = Object.freeze({
  event_salience: 1.0,
  social_value: 0.9,
  memory_relevance: 0.9,
  novelty: 0.7,
  time_since_last_interaction: 1.0,
  user_receptiveness: 0.9,
  future_hook_bonus: 0.8,
  interruption_risk: 0.0,
  recent_proactive_penalty: 0.0,
  repetition_penalty: 0.0,
  uncertainty_penalty: 0.0,
});

export interface ProactiveDrillRequest {
  readonly trigger?: unknown;
  readonly components?: unknown;
  readonly topicRef?: unknown;
  readonly candidateId?: unknown;
}

export interface ProactiveDrillResult {
  readonly speak: boolean;
  readonly delivered: boolean;
  readonly reasonCode: ProactiveReasonCode;
  readonly reasonLabel: string;
  readonly trigger: ProactiveTrigger;
  readonly candidateId: string;
  readonly score: number;
  readonly threshold: number;
  readonly gates: readonly ProactiveGateRow[];
  /** The spoken text when the gates let it through (null when blocked). */
  readonly text: string | null;
  /** The same text as the page should play it: one entry per segment, in order. */
  readonly segments: readonly string[];
  readonly gapMs: number;
  readonly eventSequence: number | null;
  readonly usage: ProactiveUsage;
  /** What the user should do about a blocked candidate (Chinese, actionable). */
  readonly nextStep: string;
}

/**
 * Run one consideration through the **real** engine and return everything a page needs.
 *
 * "Real" matters: the score, the nine gates in their fixed order, the `proactive.decision`
 * audit row and the at-most-once delivery write all go through `ProactiveEngine.consider`.
 * The drill only supplies a candidate (trigger + §15.4 components) and the spoken text.
 */
export async function proactiveDrill(options: {
  readonly store: XixiStore;
  readonly settings: ProactiveSettings;
  readonly now: Date;
  readonly conversationState: ConversationState;
  readonly inFlightTurn?: boolean;
  readonly proactivity?: number;
  readonly negativeFeedback?: boolean;
  readonly sceneAvailable?: boolean;
  readonly speechAvailable?: boolean;
  readonly sessionId?: string | null;
  readonly replyLimits?: Readonly<Record<string, unknown>> | undefined;
  readonly request: ProactiveDrillRequest;
  readonly offsetMinutes?: number;
}): Promise<ProactiveDrillResult> {
  const trigger: ProactiveTrigger = PROACTIVE_TRIGGERS.includes(options.request.trigger as ProactiveTrigger)
    ? (options.request.trigger as ProactiveTrigger)
    : 'presence_arrived';
  const candidateId =
    typeof options.request.candidateId === 'string' && options.request.candidateId.trim().length > 0
      ? options.request.candidateId.trim()
      : `drill-${trigger}-${options.now.getTime()}`;
  const components = isMapping(options.request.components)
    ? (Object.fromEntries(
        Object.entries(options.request.components as Record<string, unknown>).filter(([, value]) => typeof value === 'number'),
      ) as Record<string, number>)
    : { ...PROACTIVE_DRILL_COMPONENTS };
  const topicRef = typeof options.request.topicRef === 'string' && options.request.topicRef.length > 0 ? options.request.topicRef : trigger;

  const engine = new ProactiveEngine({
    store: options.store,
    settings: options.settings,
    clock: () => options.now,
    offsetMinutes: options.offsetMinutes,
  });
  let delivered: string | null = null;
  const outcome = await engine.consider({
    candidate: { candidateId, trigger, components, topicRef, intent: 'drill' },
    at: options.now,
    conversationState: options.conversationState,
    inFlightTurn: options.inFlightTurn ?? false,
    proactivity: options.proactivity,
    negativeFeedback: options.negativeFeedback,
    sceneAvailable: options.sceneAvailable,
    speechAvailable: options.speechAvailable,
    sessionId: options.sessionId ?? null,
    deliver: (delivery) => {
      delivered = PROACTIVE_DRILL_LINES[delivery.trigger];
    },
  });

  const split = delivered === null ? null : splitReplyIntoSegments(delivered, resolveReplyLimits(options.replyLimits));
  return {
    speak: outcome.speak,
    delivered: outcome.delivered,
    reasonCode: outcome.reasonCode,
    reasonLabel: PROACTIVE_GATE_LABELS[outcome.reasonCode],
    trigger,
    candidateId,
    score: outcome.score,
    threshold: outcome.threshold,
    gates: proactiveGateRows(outcome.reasonCode),
    text: delivered,
    segments: split?.segments ?? [],
    gapMs: split?.gapMs ?? 0,
    eventSequence: outcome.event?.sequence ?? null,
    usage: proactiveUsage(options.store, options.settings, options.now, options.offsetMinutes),
    nextStep: PROACTIVE_GATE_NEXT_STEPS[outcome.reasonCode],
  };
}

/** What to do about a blocked candidate — the page prints this verbatim. */
const PROACTIVE_GATE_NEXT_STEPS: Readonly<Record<ProactiveReasonCode, string>> = Object.freeze({
  DISABLED: '把「允许西西主动开口」打开（或点页面上的开关），再试一次。',
  TRIGGER_DISABLED: '在触发源里把这一项打开，或换一个触发源再试。',
  ALREADY_DELIVERED: '这是同一条候选（candidate_id 相同），按「最多说一次」的规矩不再重发；换一个 id 再试。',
  DND_ACTIVE: '西西现在处在安静模式：点「新会话」或 /resume 恢复后再试。',
  QUIET_HOURS: '现在在静默时段内（安全底线，接口不允许放宽）。把静默时段改到自己不在家的时段再试，或等过了这个时段。',
  COOLDOWN_ACTIVE: '还在冷却里：等冷却走完，或把冷却分钟数调小（0 表示不等）。',
  QUOTA_6H_EXCEEDED: '6 小时额度用完了：等窗口滚动，或把 6 小时额度调大。',
  QUOTA_DAY_EXCEEDED: '当日额度用完了：等明天，或把当日额度调大。',
  TOPIC_REPEATED: '同一个话题刚说过：把同主题抑制窗口调小，或换一个 topic_ref。',
  CONVERSATION_ACTIVE: '正在对话里：等这一轮结束（或 FSM 回到 IDLE）再试。',
  SCORE_BELOW_THRESHOLD: '分数不够：提高人格里的 proactivity（阈值 = 0.45 + 0.30 × (1 − proactivity)），或换一个更有价值的事件。',
  SCENE_UNAVAILABLE: '场景不合适：等媒体播完 / 通话结束再试。',
  SPEECH_UNAVAILABLE: '语音输出不可用：检查 TTS/扬声器，或先只看文字。',
  PASSED: '已开口。',
});

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SegmentPlan {
  readonly segments: readonly string[];
  readonly gapMs: number;
  readonly total: number;
  /** 「第 2/3 段 · 间隔 450ms」 — what the page and the terminal print next to a segment. */
  readonly playbackHint: string;
  /** One line a non-engineer can read before the messages start appearing. */
  readonly summary: string;
}

/**
 * How a reply is played: `ADR-0010` segments plus the pause between them.
 *
 * Both pages and `scripts/chat.ts` render from this one plan, so "分三段、每段之间 450ms"
 * is the same statement in the terminal and in the browser — which is the whole point of
 * showing it (a user who sees only the last segment must be able to tell that the others
 * were *earlier*, not lost).
 */
export function segmentPlan(text: string | null | undefined, limits?: Readonly<Record<string, unknown>> | undefined): SegmentPlan {
  if (text === null || text === undefined || text.trim().length === 0) {
    return { segments: [], gapMs: 0, total: 0, playbackHint: '', summary: '没有可播放的内容' };
  }
  const split = splitReplyIntoSegments(text, resolveReplyLimits(limits));
  return {
    segments: split.segments,
    gapMs: split.gapMs,
    total: split.segments.length,
    playbackHint: split.segments.length > 1 ? `按间隔逐条出现：每段之间 ${split.gapMs}ms` : '只有一段',
    summary:
      split.segments.length > 1
        ? `这条回复会分 ${split.segments.length} 段说出，段与段之间停 ${split.gapMs}ms（不是一次说完）`
        : '这条回复只有一段',
  };
}

export interface ProactiveConsoleState {
  readonly settings: ProactiveSettings;
  readonly source: 'console' | 'config';
  readonly updatedAt: string | null;
  readonly changes: readonly string[];
  readonly quietHours: { readonly start: string; readonly end: string; readonly activeNow: boolean };
  readonly proactivity: number;
  readonly threshold: number;
  readonly usage: ProactiveUsage;
  readonly triggerLabels: readonly { readonly trigger: ProactiveTrigger; readonly label: string; readonly enabled: boolean }[];
  readonly gateOrder: readonly { readonly code: ProactiveReasonCode; readonly label: string; readonly status: ProactiveGateRow['status'] }[];
  readonly lastDecision: ProactiveDecisionRow | null;
  readonly decisions: readonly ProactiveDecisionRow[];
  readonly audit: readonly { readonly at: string; readonly sequence: number; readonly changes: readonly string[] }[];
  /** `true` when the engine would consider a candidate at all (the switch, in one word). */
  readonly enabled: boolean;
}

/**
 * Everything the proactive card shows, in one payload.
 *
 * The gate table is rendered for the **last** decision (from the log), so a page reload
 * shows exactly why the last attempt was blocked; a fresh drill returns its own table.
 */
export function proactiveConsoleState(options: {
  readonly store: XixiStore;
  readonly settings: ProactiveSettings;
  readonly source: 'console' | 'config';
  readonly updatedAt: string | null;
  readonly changes: readonly string[];
  readonly now: Date;
  readonly proactivity: number;
  readonly offsetMinutes?: number;
  readonly historyLimit?: number;
}): ProactiveConsoleState {
  const decisions = proactiveDecisionHistory(options.store, options.historyLimit ?? 8);
  const last = decisions[decisions.length - 1] ?? null;
  const localMinutes = options.now.getHours() * 60 + options.now.getMinutes();
  return {
    settings: options.settings,
    source: options.source,
    updatedAt: options.updatedAt,
    changes: options.changes,
    quietHours: {
      start: formatClockMinutes(options.settings.quietHours.startMinutes),
      end: formatClockMinutes(options.settings.quietHours.endMinutes),
      activeNow: isWithinQuietHours(localMinutes, options.settings.quietHours.startMinutes, options.settings.quietHours.endMinutes),
    },
    proactivity: options.proactivity,
    threshold: proactiveThreshold(options.proactivity),
    usage: proactiveUsage(options.store, options.settings, options.now, options.offsetMinutes),
    triggerLabels: PROACTIVE_TRIGGERS.map((trigger) => ({
      trigger,
      label: PROACTIVE_TRIGGER_LABELS[trigger],
      enabled: options.settings.triggers[trigger],
    })),
    gateOrder: proactiveGateRows((last?.reasonCode as ProactiveReasonCode | undefined) ?? null),
    lastDecision: last,
    decisions,
    audit: proactiveSettingsAuditRows(options.store).map((row) => ({ at: row.at, sequence: row.sequence, changes: row.changes })),
    enabled: options.settings.enabled,
  };
}

/** The engine's own default proactivity, for pages that show the threshold before any profile exists. */
export function effectiveProactivity(profile: Readonly<Record<string, unknown>> | undefined): number {
  const value = profile?.['proactivity'];
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_PROACTIVITY;
}

// ---------------------------------------------------- resident consideration loop (t70)
//
// M5-lite: the console may run the consideration loop by itself. It is **off by default** and
// every candidate it builds is fact-based (the presence projection, the time since the last user
// turn, a documented clock hook) — no model is asked to invent something to say, so 「西西怎么
// 突然说话了」 has an answer that can be checked against the log. When the gates let a candidate
// through, the line goes through the *same* TTS path a reply uses and is played segment by
// segment (ADR-0010); when they block it, the page shows the first blocked gate and its reason.

/** Fixed clock hooks (console-side source): 「到点了」 statements, not opinions. */
export const PROACTIVE_CLOCK_HOOKS: readonly { readonly minutes: number; readonly line: string; readonly intent: string }[] = Object.freeze([
  { minutes: 9 * 60, line: '现在是上午 9 点。要我把今天要做的事记一条吗？', intent: 'morning_hook' },
  { minutes: 12 * 60 + 30, line: '现在是中午 12 点半。记得吃点东西，别又拖到下午。', intent: 'lunch_hook' },
  { minutes: 18 * 60 + 30, line: '现在是傍晚 6 点半。今天的事到这儿就算告一段落了。', intent: 'evening_hook' },
  { minutes: 21 * 60, line: '现在是晚上 9 点。要不要我帮你把明天的事记一下？', intent: 'night_hook' },
]);

/** How long without a user turn before 「长时间没人说话」 becomes a candidate. */
export const PROACTIVE_DANGLING_AFTER_MINUTES = 10;

export interface ProactiveCandidatePlan {
  readonly candidate: ProactiveCandidate;
  /** The sentence the candidate would speak (factual, checkable against the log/clock). */
  readonly line: string;
  /** Where the fact comes from, for the page's 「这条凭什么说」 line. */
  readonly fact: string;
  /** Segment plan for that line (ADR-0010), so the page knows what it will hear. */
  readonly segments: readonly string[];
  readonly gapMs: number;
}

export interface ProactiveCandidateContext {
  readonly now: Date;
  /** Presence projection (M6). `present === true` is what 「有人到家」 needs. */
  readonly presence: { readonly present: boolean | null; readonly updatedAt: string | null; readonly source?: string | null } | null;
  /** When the last user turn happened (from the event log); `null` = this store has no turns. */
  readonly lastUserTurnAt: Date | null;
  /** True when a conversation is open right now (the engine blocks it anyway; this only orders). */
  readonly inConversation: boolean;
  readonly limit?: number;
}

/**
 * Build the candidates the loop may consider, in priority order (§16).
 *
 * Deliberately dumb and factual: each entry traces back to a row in the log or to the clock.
 */
export function buildProactiveCandidates(context: ProactiveCandidateContext): ProactiveCandidatePlan[] {
  const plans: ProactiveCandidatePlan[] = [];
  const day = localDayOf(context.now);
  const minutes = context.now.getHours() * 60 + context.now.getMinutes();
  const limit = context.limit ?? 3;

  // 1. presence_arrived — the projection says someone is home.
  if (context.presence?.present === true) {
    plans.push(
      planFor(
        'presence_arrived',
        `${day}-presence`,
        // Long enough to be spoken in two segments (ADR-0010), so the page really shows the
        // pause between them instead of one clip.
        '哎，你回来啦。今天外面挺冷的，我看你外套都没穿厚。要不要先喝口热水暖暖手？对了，你要问的那件事我也记着呢，等你想说的时候再问我。',
        `在场投影：present=true（更新于 ${context.presence.updatedAt ?? '—'}）`,
        // A greeting right after someone walks in is a strong candidate on every axis — and the
        // numbers are the §15.4 ones, not a thumb on the scale to sneak past the threshold.
        {
          event_salience: 1,
          social_value: 1,
          novelty: 0.8,
          memory_relevance: 0.6,
          time_since_last_interaction: 1,
          user_receptiveness: 0.9,
          future_hook_bonus: 0.5,
        },
      ),
    );
  }

  // 2. conversation_dangling — nobody has said anything for a while.
  const silentMinutes = context.lastUserTurnAt === null ? null : Math.round((context.now.getTime() - context.lastUserTurnAt.getTime()) / 60_000);
  if (silentMinutes === null || silentMinutes >= PROACTIVE_DANGLING_AFTER_MINUTES) {
    const line = silentMinutes === null ? '家里安静了一会儿了，我在。' : `你上次说话是 ${silentMinutes} 分钟前了，还好吗？`;
    plans.push(
      planFor(
        'conversation_dangling',
        `${day}-dangling-${Math.floor(minutes / 30)}`,
        line,
        `事件日志：上一条 user 轮次在 ${context.lastUserTurnAt?.toISOString() ?? '（这个库还没有轮次）'}`,
        { time_since_last_interaction: 1, social_value: 0.8, memory_relevance: 0.5, user_receptiveness: 0.7 },
      ),
    );
  }

  // 3. future_hook_due — a documented clock hook, valid for 30 minutes after the minute.
  const hook = PROACTIVE_CLOCK_HOOKS.find((entry) => minutes >= entry.minutes && minutes < entry.minutes + 30);
  if (hook !== undefined) {
    plans.push(
      planFor(
        'future_hook_due',
        `${day}-hook-${hook.minutes}`,
        hook.line,
        `时钟：本地时间 ${formatClockMinutes(minutes)} 命中固定钩子 ${formatClockMinutes(hook.minutes)}`,
        { event_salience: 0.8, future_hook_bonus: 1, social_value: 0.6, user_receptiveness: 0.8 },
        hook.intent,
      ),
    );
  }

  return plans.slice(0, limit);
}

function planFor(
  trigger: ProactiveTrigger,
  slug: string,
  line: string,
  fact: string,
  components: Readonly<Record<string, number>>,
  intent?: string,
): ProactiveCandidatePlan {
  const split = splitReplyIntoSegments(line);
  return {
    candidate: { candidateId: `loop-${trigger}-${slug}`, trigger, components, topicRef: trigger, intent: intent ?? trigger },
    line,
    fact,
    segments: split.segments,
    gapMs: split.gapMs,
  };
}

export interface ProactiveLoopEntry {
  readonly at: string;
  readonly candidateId: string;
  readonly trigger: string;
  readonly triggerLabel: string;
  readonly speak: boolean;
  readonly reasonCode: string;
  readonly reasonLabel: string;
  readonly nextStep: string;
  readonly score: number;
  readonly threshold: number;
  readonly gates: readonly ProactiveGateRow[];
  readonly text: string | null;
  readonly segments: readonly string[];
  readonly gapMs: number;
  /** One entry per segment: a playable base64 WAV, or `null` when that segment could not be made. */
  readonly audio: readonly (string | null)[] | null;
  /** Why there is no audio (no key, `--no-tts`, a TTS error) — never silently empty. */
  readonly audioNote: string | null;
  readonly fact: string;
}

export interface ProactiveLoopOptions {
  readonly store: XixiStore;
  readonly readSettings: () => ProactiveSettings;
  readonly readState: () => ConversationState;
  readonly readInFlightTurn?: () => boolean;
  readonly readProactivity: () => number;
  readonly readPresence: () => Promise<{ readonly present: boolean | null; readonly updatedAt: string | null; readonly source?: string | null } | null>;
  readonly readLastUserTurnAt: () => Date | null;
  readonly readSessionId: () => string | null;
  readonly replyLimits?: Readonly<Record<string, unknown>> | undefined;
  readonly synthesize?: ((text: string) => Promise<Buffer>) | undefined;
  readonly intervalMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/** The page cannot make this hammer the gates: 5 s is the floor, 30 s the default. */
export const MIN_LOOP_INTERVAL_MS = 5_000;
export const DEFAULT_LOOP_INTERVAL_MS = 30_000;
/** How many entries the pages keep (memory only; the event log is the durable record). */
const LOOP_HISTORY_LIMIT = 40;

/**
 * A resident consideration loop for the console (t70).
 *
 * One tick = build candidates → consider the first one → deliver (TTS + page message) or record
 * why it was blocked. Everything the engine enforces (switch, quiet hours, cooldown, quotas,
 * topic window, conversation active, score) is untouched: the loop only supplies candidates and
 * an id that makes re-delivery impossible (`loop-<trigger>-…`, rejected by ALREADY_DELIVERED).
 */
export class ProactiveLoop {
  readonly #options: ProactiveLoopOptions;
  readonly #entries: ProactiveLoopEntry[] = [];
  #timer: NodeJS.Timeout | null = null;
  #intervalMs: number;
  #ticking = false;
  #startedAt: string | null = null;
  #ticks = 0;

  constructor(options: ProactiveLoopOptions) {
    this.#options = options;
    this.#intervalMs = clampInterval(options.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS);
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  status(): { readonly running: boolean; readonly intervalMs: number; readonly ticks: number; readonly startedAt: string | null; readonly entries: number } {
    return { running: this.running, intervalMs: this.#intervalMs, ticks: this.#ticks, startedAt: this.#startedAt, entries: this.#entries.length };
  }

  entries(): readonly ProactiveLoopEntry[] {
    return this.#entries;
  }

  /** Entries the page has not seen yet (`cursor` = how many it already has). */
  messagesSince(cursor: number): { readonly cursor: number; readonly entries: readonly ProactiveLoopEntry[] } {
    const from = Math.max(0, Math.min(cursor, this.#entries.length));
    return { cursor: this.#entries.length, entries: this.#entries.slice(from) };
  }

  start(intervalMs?: number): void {
    if (intervalMs !== undefined) this.#intervalMs = clampInterval(intervalMs);
    if (this.#timer !== null) return;
    this.#startedAt = new Date().toISOString();
    this.#options.log?.(`[proactive-loop] 开始自动考虑：每 ${Math.round(this.#intervalMs / 1000)} 秒一次（默认关，随时可停）`);
    void this.tickOnce();
    this.#timer = setInterval(() => void this.tickOnce(), this.#intervalMs);
    // A resident loop must not keep a script alive by itself (tests, `--self-test`).
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#options.log?.('[proactive-loop] 已停止自动考虑');
  }

  /**
   * One consideration, exposed for the page's 「立刻考虑一次」 button and for tests.
   *
   * Returns the entry (spoken or blocked), or `null` when no candidate could be built.
   */
  async tickOnce(): Promise<ProactiveLoopEntry | null> {
    if (this.#ticking) return null; // a slow TTS call must not overlap the next tick
    this.#ticking = true;
    try {
      const now = this.#options.now?.() ?? new Date();
      this.#ticks += 1;
      const presence = await this.#options.readPresence();
      const plans = buildProactiveCandidates({
        now,
        presence,
        lastUserTurnAt: this.#options.readLastUserTurnAt(),
        inConversation: this.#options.readState() !== 'IDLE' || (this.#options.readInFlightTurn?.() ?? false),
      });
      if (plans.length === 0) {
        this.#options.log?.('[proactive-loop] 这一次没有可说的候选（没有事实支撑就不开口）');
        return null;
      }
      for (const plan of plans) {
        const entry = await this.#consider(plan, now);
        if (entry.reasonCode === 'ALREADY_DELIVERED') continue; // this source was used: try the next
        this.#push(entry);
        this.#options.log?.(
          entry.speak
            ? `[proactive-loop] 开口：${entry.triggerLabel}（分数 ${entry.score} ≥ ${entry.threshold}）「${entry.text ?? ''}」`
            : `[proactive-loop] 被拦：${entry.triggerLabel} → ${entry.reasonCode}（${entry.reasonLabel}）`,
        );
        return entry;
      }
      return null;
    } finally {
      this.#ticking = false;
    }
  }

  async #consider(plan: ProactiveCandidatePlan, now: Date): Promise<ProactiveLoopEntry> {
    const settings = this.#options.readSettings();
    let delivered: string | null = null;
    const engine = new ProactiveEngine({ store: this.#options.store, settings, clock: () => now });
    const outcome = await engine.consider({
      candidate: plan.candidate,
      at: now,
      conversationState: this.#options.readState(),
      inFlightTurn: this.#options.readInFlightTurn?.() ?? false,
      proactivity: this.#options.readProactivity(),
      sessionId: this.#options.readSessionId(),
      deliver: () => {
        delivered = plan.line;
      },
    });
    const split = delivered === null ? null : splitReplyIntoSegments(delivered, resolveReplyLimits(this.#options.replyLimits));
    const segments = split?.segments ?? [];
    const gapMs = split?.gapMs ?? 0;
    let audio: (string | null)[] | null = null;
    let audioNote: string | null = null;
    if (outcome.speak) {
      if (this.#options.synthesize === undefined) {
        audioNote = '只显示文字：朗读关闭（--no-tts）或没有可用密钥，所以这次没有合成语音。';
      } else {
        // Per segment on purpose: the page plays them with `gapMs` between them, which is what
        // ADR-0010 means by segmented speech (one clip per segment, not one clip split later).
        const clips: (string | null)[] = [];
        for (const segment of segments) {
          try {
            clips.push((await this.#options.synthesize(segment)).toString('base64'));
          } catch (error) {
            clips.push(null);
            audioNote = `第 ${clips.length} 段合成失败：${error instanceof Error ? error.message : String(error)}`;
          }
        }
        audio = clips;
      }
    }
    return {
      at: now.toISOString(),
      candidateId: plan.candidate.candidateId,
      trigger: plan.candidate.trigger,
      triggerLabel: PROACTIVE_TRIGGER_LABELS[plan.candidate.trigger],
      speak: outcome.speak,
      reasonCode: outcome.reasonCode,
      reasonLabel: PROACTIVE_GATE_LABELS[outcome.reasonCode],
      nextStep: PROACTIVE_GATE_NEXT_STEPS[outcome.reasonCode],
      score: outcome.score,
      threshold: outcome.threshold,
      gates: proactiveGateRows(outcome.reasonCode),
      text: delivered,
      segments,
      gapMs,
      audio,
      audioNote,
      fact: plan.fact,
    };
  }

  #push(entry: ProactiveLoopEntry): void {
    this.#entries.push(entry);
    while (this.#entries.length > LOOP_HISTORY_LIMIT) this.#entries.shift();
  }
}

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOOP_INTERVAL_MS;
  return Math.max(MIN_LOOP_INTERVAL_MS, Math.min(value, 60 * 60_000));
}

/** When the last *user* turn happened, straight from the event log (t70's 「长时间没人说话」). */
export function lastUserTurnAt(store: XixiStore, sessionId?: string | null): Date | null {
  // `readEvents` can filter by session itself; the envelope field is `session_id` (snake_case,
  // per the schema) — reading `event.sessionId` here silently matched nothing the first time.
  const events = store.readEvents({
    type: 'conversation.turn',
    ...(sessionId === undefined || sessionId === null ? {} : { sessionId }),
    limit: Number.MAX_SAFE_INTEGER,
  });
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload['role'] !== 'user') continue;
    return new Date(event.timestamp);
  }
  return null;
}

/**
 * Which database each entry point uses.
 *
 * Four entry points, four separate SQLite files (by design — a demo must not write into the
 * user's real conversation history). The pages print this **and** their own live path, because
 * "我在 chat 里设的人格/聊过的历史，怎么这里没有" is a guaranteed question otherwise.
 */
export const XIXI_DB_ENTRIES: readonly { readonly entry: string; readonly command: string; readonly dir: string }[] = Object.freeze([
  { entry: '终端对话', command: 'npm run chat', dir: 'data/chat' },
  { entry: '试用页', command: 'npm run web', dir: 'data/web-chat' },
  { entry: '语音闭环', command: 'npm run voice:turn', dir: 'data/voice' },
  { entry: '现场测试控制台', command: 'npm run field-test', dir: 'data/field-test' },
  { entry: '离线演示', command: 'npm run demo:m0:text', dir: 'data/demo' },
]);

/**
 * What is *actually* segmented today.
 *
 * ADR-0010 is about how a reply is spoken, and the honest state of t42 is: the text/plan is
 * segmented (the page shows each piece as it would be played, with the real pause), while TTS
 * still synthesizes the whole reply in one call — so the ear does not hear the pause yet.
 * Saying so on the page is mandatory (t42 acceptance item 3): a user must not conclude from the
 * moving bubbles that the audio is segmented too.
 */
export const SEGMENT_TTS_NOTE =
  '多段回复（ADR-0010）：文字与播放计划**真的按段**（每段之间停 450ms，页面逐条出现）。' +
  '但**语音合成（TTS）目前仍是整条回复一次合成**，所以听感上暂时听不到段间停顿——按段合成属于下一步（M5）。';

/** The 「本页用哪个库」block, shared by both pages. `currentDir` is the running page's own path. */
export function databaseNoteHtml(currentDir: string): string {
  // Defensive: this is a pure page helper, and a page must never crash because one display
  // field was missing (t42's `ReferenceError: dataDir is not defined` took the whole console
  // down). An unknown path renders as 「未知」 rather than throwing.
  const current = typeof currentDir === 'string' && currentDir.length > 0 ? currentDir : '（未知）';
  const rows = XIXI_DB_ENTRIES.map(
    (item) => `<li><code>${item.command}</code> → <code>${item.dir}</code>（${item.entry}）${current.endsWith(item.dir) ? ' ← <b>本页</b>' : ''}</li>`,
  ).join('');
  return (
    `<div class="muted">本页数据库：<code>${current}</code>｜<b>四个入口各用不同的库</b>：` +
    `<ul style="margin:4px 0 4px 18px; padding:0">${rows}</ul>` +
    `在 <code>npm run chat</code> 里设的人格与聊过的历史<b>不会</b>带到这里（各自的库互相独立）。</div>`
  );
}

/** Element ids of the proactive card, shared by both pages (so the tests can assert them). */export const PROACTIVE_PANEL_IDS = Object.freeze({
  card: 'px-card',
  enabled: 'px-enabled',
  cooldown: 'px-cooldown',
  per6h: 'px-6h',
  perDay: 'px-day',
  quietStart: 'px-quiet-start',
  quietEnd: 'px-quiet-end',
  topic: 'px-topic',
  negative: 'px-neg',
  proactivity: 'px-proactivity',
  proactivityNow: 'px-proactivity-now',
  loopEnabled: 'px-loop-enabled',
  loopInterval: 'px-loop-interval',
  loopTick: 'px-loop-tick',
  loopStatus: 'px-loop-status',
  loopLog: 'px-loop-log',
  triggers: 'px-triggers',
  save: 'px-save',
  off: 'px-off',
  drill: 'px-drill',
  status: 'px-status',
  result: 'px-result',
  gates: 'px-gates',
  log: 'px-log',
  audit: 'px-audit',
  summary: 'px-summary',
});

/**
 * The proactive card, identical on both pages.
 *
 * The copy is deliberate: a user tuning "怎么更主动" must see that the gates are *not*
 * part of the knob set. The gate table below the buttons is the answer to 「为什么这次没开口」.
 */
export function proactivePanelHtml(): string {
  const id = PROACTIVE_PANEL_IDS;
  return `  <section class="card" id="${id.card}">
    <h2>主动性（主动开口的开关与强度）</h2>
    <div class="muted">这一块决定「西西什么时候可以主动开口」。<b>九道硬门禁由程序判定</b>——这里的旋钮只改阈值与额度，放宽不了门禁本身（尤其是静默时段）。保存后<b>立即生效</b>，并入一条审计记录（重启后仍是这套值）。</div>
    <div style="margin:8px 0"><label><input type="checkbox" id="${id.enabled}" /> 允许西西主动开口</label> <span class="muted" id="${id.summary}">加载中…</span></div>
    <div class="px-grid">
      <label>冷却（分钟）<input type="number" id="${id.cooldown}" min="0" max="1440" /></label>
      <label>6 小时额度<input type="number" id="${id.per6h}" min="0" max="100" /></label>
      <label>当日额度<input type="number" id="${id.perDay}" min="0" max="100" /></label>
      <label>静默时段起<input type="text" id="${id.quietStart}" placeholder="22:30" /></label>
      <label>静默时段止<input type="text" id="${id.quietEnd}" placeholder="07:00" /></label>
      <label>同主题抑制（小时）<input type="number" id="${id.topic}" min="0" max="720" /></label>
      <label>负面反馈倍率<input type="number" id="${id.negative}" min="1" max="10" step="0.5" /></label>
      <label>主动性总强度（人格 proactivity）<input type="number" id="${id.proactivity}" min="0" max="1" step="0.05" /></label>
    </div>
    <div class="muted">「主动性总强度」写的是<b>人格</b> <code>proactivity</code>（进 <code>self_profile</code>，留一条 <code>self_profile_history</code>）：它只把阈值改成 <code>0.45 + 0.30 × (1 − proactivity)</code>，<b>一道门禁都不会被跳过</b>。当前生效值：<b id="${id.proactivityNow}">—</b></div>
    <div id="${id.triggers}" class="px-triggers"></div>
    <div style="margin:10px 0">
      <button id="${id.save}" class="primary">保存（立即生效并落库）</button>
      <button id="${id.off}">一键关闭主动开口</button>
      <button id="${id.drill}">试一次主动开口（演练）</button>
      <span class="muted" id="${id.status}"></span>
    </div>
    <div id="${id.result}"></div>
    <h3 style="margin:12px 0 4px; font-size:14px">常驻自动考虑（M5-lite，默认关）</h3>
    <div class="muted">打开后每 N 秒自己构造一个候选并过一遍九道门禁。候选只来自<b>事实</b>（在场投影 / 上次说话过了多久 / 固定时钟钩子），不靠模型编内容；放行时用真实 TTS 逐段合成并在下面逐条播放（段间停 segmentGapMs），被拦时写清第一道命中的门禁与中文原因。</div>
    <div style="margin:8px 0">
      <label><input type="checkbox" id="${id.loopEnabled}" /> 开始自动考虑</label>
      <label>间隔（秒）<input type="number" id="${id.loopInterval}" min="5" max="3600" step="5" /></label>
      <button id="${id.loopTick}">立刻考虑一次</button>
      <span class="muted" id="${id.loopStatus}"></span>
    </div>
    <div id="${id.loopLog}" class="muted">还没有自动考虑的记录。</div>
    <h3 style="margin:12px 0 4px; font-size:14px">每道门禁的判定（按引擎的固定顺序）</h3>
    <div id="${id.gates}" class="muted">还没有判定记录。</div>
    <h3 style="margin:12px 0 4px; font-size:14px">最近的考虑记录（来自事件日志，可审计）</h3>
    <div id="${id.log}" class="muted">还没有考虑记录。</div>
    <h3 style="margin:12px 0 4px; font-size:14px">设置变更审计</h3>
    <div id="${id.audit}" class="muted">还没有变更记录。</div>
  </section>
`;
}

/**
 * The proactive card's behaviour, shared by both pages.
 *
 * `apiBase` is `/api/field` on the console and `/api` on the trial page; the routes are the
 * same. It is written as a plain script body (no modules) because both pages are single files
 * with inline scripts.
 */
export function proactivePanelScript(apiBase: string): string {
  const id = PROACTIVE_PANEL_IDS;
  return `var PX = { base: ${JSON.stringify(apiBase)}, timers: [] };
PX.ids = ${JSON.stringify(id)};
function pxSet(name, value) { var node = document.getElementById(PX.ids[name]); if (node) node.value = value; }
function pxVal(name) { var node = document.getElementById(PX.ids[name]); return node ? node.value : undefined; }
function pxStatus(text, rejected) {
  var node = document.getElementById(PX.ids.status);
  if (!node) return;
  node.textContent = text + (rejected && rejected.length ? '（已忽略：' + rejected.join('；') + '）' : '');
}
async function pxPost(path, body) {
  var response = await fetch(PX.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return await response.json();
}
function pxRender(state) {
  var s = state.settings;
  var box = document.getElementById(PX.ids.enabled);
  if (box) box.checked = s.enabled === true;
  pxSet('cooldown', s.baseCooldownMinutes); pxSet('per6h', s.maxPer6h); pxSet('perDay', s.maxPerDay);
  pxSet('quietStart', state.quietHours.start); pxSet('quietEnd', state.quietHours.end);
  pxSet('topic', s.topicRepeatWindowHours); pxSet('negative', s.negativeFeedbackCooldownMultiplier);
  pxSet('proactivity', state.proactivity);
  var proactivityNow = document.getElementById(PX.ids.proactivityNow);
  if (proactivityNow) proactivityNow.textContent = String(state.proactivity);
  var summary = document.getElementById(PX.ids.summary);
  if (summary) {
    summary.textContent = (s.enabled ? '已开启' : '已关闭')
      + '（来源：' + (state.source === 'console' ? '本页保存的值' : 'config/xixi.yaml') + '）'
      + '｜阈值 ' + state.threshold + '（人格 proactivity=' + state.proactivity + '）'
      + '｜静默 ' + state.quietHours.start + '–' + state.quietHours.end + (state.quietHours.activeNow ? '（现在就在静默里）' : '')
      + '｜已开口 ' + state.usage.deliveries + ' 次（今日 ' + state.usage.today + '/' + s.maxPerDay + '，6 小时 ' + state.usage.in6h + '/' + s.maxPer6h + '）'
      + (state.usage.cooldownRemainingMs > 0 ? '｜冷却还剩 ' + Math.round(state.usage.cooldownRemainingMs / 1000) + 's' : '');
  }
  var triggers = document.getElementById(PX.ids.triggers);
  if (triggers) {
    triggers.innerHTML = '<span class="muted">触发源（关了就不会因为这件事开口）：</span>' + state.triggerLabels.map(function (row) {
      return '<label style="margin-right:10px"><input type="checkbox" data-trigger="' + row.trigger + '"' + (row.enabled ? ' checked' : '') + ' /> ' + row.label + '</label>';
    }).join('');
  }
  var gates = document.getElementById(PX.ids.gates);
  if (gates) {
    var verdict = { passed: '通过', blocked: '阻塞 ←', skipped: '未评估' };
    gates.innerHTML = '<table style="width:100%; font-size:12px"><tr><th align="left">门禁</th><th align="left">判定</th></tr>'
      + state.gateOrder.map(function (row) {
          var colour = row.status === 'blocked' ? '#ff9f9f' : row.status === 'passed' ? '#9fe0a8' : '#7c869a';
          return '<tr><td>' + row.label + ' <span class="muted">(' + row.code + ')</span></td><td style="color:' + colour + '">' + verdict[row.status] + '</td></tr>';
        }).join('')
      + '</table>'
      + (state.lastDecision ? '<div class="muted">上一次判定：' + state.lastDecision.reasonCode + '（分数 ' + state.lastDecision.score + ' / 阈值 ' + state.lastDecision.threshold + '，' + state.lastDecision.at + '）</div>' : '<div class="muted">还没有考虑记录（只有被考虑过的候选才会留痕；总开关关掉时按设计不记录）。</div>');
  }
  var log = document.getElementById(PX.ids.log);
  if (log) {
    log.innerHTML = state.decisions.length === 0 ? '还没有考虑记录。' : '<ul style="margin:4px 0; padding-left:18px">' + state.decisions.map(function (row) {
      return '<li>' + row.at + '：' + row.trigger + ' → ' + (row.speak ? '开口' : '没开口') + '（' + row.reasonCode + '，分数 ' + row.score + '/' + row.threshold + '）</li>';
    }).join('') + '</ul>';
  }
  var audit = document.getElementById(PX.ids.audit);
  if (audit) {
    audit.innerHTML = state.audit.length === 0 ? '还没有变更记录（当前值来自配置）。' : '<ul style="margin:4px 0; padding-left:18px">' + state.audit.slice(-5).reverse().map(function (row) {
      return '<li>' + row.at + '：' + (row.changes.length ? row.changes.join('；') : '（无变化）') + '</li>';
    }).join('') + '</ul>';
  }
}
async function pxLoad() {
  try { pxRender(await (await fetch(PX.base + '/proactive')).json()); }
  catch (error) { pxStatus('读取主动性设置失败：' + error.message); }
}
async function pxSave(patch, note) {
  var result = await pxPost('/proactive/settings', patch || pxPatch());
  if (result.ok === false) { pxStatus('保存失败：' + result.error); return; }
  pxRender(result.state);
  pxStatus((note || '已保存') + (result.changes.length ? '：' + result.changes.join('；') : '（没有变化）'), result.rejected);
}
function pxPatch() {
  var triggers = {};
  var boxes = document.querySelectorAll('#' + PX.ids.triggers + ' input[data-trigger]');
  for (var i = 0; i < boxes.length; i += 1) triggers[boxes[i].getAttribute('data-trigger')] = boxes[i].checked;
  var patch = {
    enabled: document.getElementById(PX.ids.enabled).checked,
    baseCooldownMinutes: Number(pxVal('cooldown')),
    maxPer6h: Number(pxVal('per6h')),
    maxPerDay: Number(pxVal('perDay')),
    quietStart: pxVal('quietStart'),
    quietEnd: pxVal('quietEnd'),
    topicRepeatWindowHours: Number(pxVal('topic')),
    negativeFeedbackCooldownMultiplier: Number(pxVal('negative')),
    triggers: triggers,
  };
  // Only send proactivity when the box really holds a number: an empty box must not be read as
  // 0 (which would silently make 西西 maximally willing to speak).
  var raw = pxVal('proactivity');
  if (raw !== undefined && String(raw).trim() !== '' && isFinite(Number(raw))) patch.proactivity = Number(raw);
  return patch;
}
/** Play the drill's reply the way the engine intends: one segment at a time, gapMs apart. */
function pxPlaySegments(target, segments, gapMs, label) {
  if (!target) return;
  while (PX.timers.length) clearTimeout(PX.timers.pop());
  if (!segments || segments.length === 0) { target.innerHTML = '<div class="muted">这次没有开口，所以没有内容。</div>'; return; }
  target.innerHTML = '';
  var index = 0;
  var step = function () {
    if (index >= segments.length) return;
    var row = document.createElement('div');
    row.style.margin = '6px 0';
    row.innerHTML = '<span class="muted">' + label + ' 第 ' + (index + 1) + '/' + segments.length + ' 段</span><div>' + segments[index].replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) + '</div>';
    target.appendChild(row);
    index += 1;
    if (index < segments.length) PX.timers.push(setTimeout(step, gapMs));
  };
  step();
}
async function pxDrill() {
  pxStatus('正在走九道门禁…');
  var result = await pxPost('/proactive/drill', { trigger: (document.getElementById(PX.ids.drill) && document.getElementById(PX.ids.drill).dataset.trigger) || 'presence_arrived' });
  if (result.ok === false) { pxStatus('演练失败：' + result.error); return; }
  pxRender(result.state);
  var drill = result.drill;
  var target = document.getElementById(PX.ids.result);
  if (drill.speak) {
    pxStatus('通过：' + drill.reasonLabel + '（分数 ' + drill.score + ' ≥ 阈值 ' + drill.threshold + '，已写审计事件 #' + drill.eventSequence + '）');
    pxPlaySegments(target, drill.segments, drill.gapMs, '主动开口');
  } else {
    pxStatus('没开口：' + drill.reasonLabel + '（' + drill.reasonCode + '）');
    if (target) target.innerHTML = '<div class="muted">' + drill.nextStep + '</div>';
  }
}

/* ---------------------------------------------------------------- resident loop (t70) */
PX.loopCursor = null;
PX.audioTimers = [];

/* Play one synthesized clip per segment, gapMs apart — the audible half of ADR-0010. */
function pxPlayClips(clips, gapMs) {
  if (!clips || clips.length === 0) return;
  var index = 0;
  var next = function () {
    if (index >= clips.length) return;
    var clip = clips[index];
    index += 1;
    if (clip) {
      try {
        var audio = new Audio('data:audio/wav;base64,' + clip);
        audio.addEventListener('ended', function () { PX.audioTimers.push(setTimeout(next, gapMs)); });
        void audio.play();
        return;
      } catch (error) { /* fall through to the timer-only path */ }
    }
    PX.audioTimers.push(setTimeout(next, gapMs));
  };
  next();
}

function pxLoopStatus(payload) {
  var node = document.getElementById(PX.ids.loopStatus);
  var box = document.getElementById(PX.ids.loopEnabled);
  if (box) box.checked = payload.status.running === true;
  if (node) {
    node.textContent = (payload.status.running ? '运行中' : '已停止')
      + '（间隔 ' + Math.round(payload.status.intervalMs / 1000) + 's，已考虑 ' + payload.status.ticks + ' 次）'
      + '｜' + (payload.tts && payload.tts.available ? '会真的发声' : '只显示文字：' + ((payload.tts && payload.tts.note) || ''));
  }
}

/** One loop entry as a page row: what it decided, why, what it said, and the audio if any. */
function pxLoopEntry(entry) {
  var log = document.getElementById(PX.ids.loopLog);
  if (!log) return;
  if (log.classList.contains('muted')) { log.className = ''; log.innerHTML = ''; }
  var row = document.createElement('div');
  row.style.margin = '8px 0';
  row.style.padding = '8px 10px';
  row.style.borderRadius = '10px';
  row.style.border = '1px solid ' + (entry.speak ? '#2f5c3a' : '#5c4a22');
  row.style.background = entry.speak ? '#14231a' : '#231f14';
  var head = document.createElement('div');
  head.innerHTML = '<b>' + (entry.speak ? '主动开口' : '被拦下') + '</b>'
    + ' · ' + entry.triggerLabel + ' <span class="muted">(' + entry.trigger + ')</span>'
    + ' · 分数 ' + entry.score + '/' + entry.threshold
    + ' · ' + entry.reasonCode + '（' + entry.reasonLabel + '）'
    + ' · ' + new Date(entry.at).toLocaleTimeString();
  row.appendChild(head);
  var fact = document.createElement('div');
  fact.className = 'muted';
  fact.textContent = '依据：' + entry.fact + '｜候选 ' + entry.candidateId;
  row.appendChild(fact);
  if (entry.speak) {
    var body = document.createElement('div');
    body.style.marginTop = '4px';
    row.appendChild(body);
    pxPlaySegments(body, entry.segments, entry.gapMs, '主动开口');
    if (entry.audio) pxPlayClips(entry.audio, entry.gapMs);
    if (entry.audioNote) {
      var note = document.createElement('div');
      note.className = 'muted';
      note.textContent = entry.audioNote;
      row.appendChild(note);
    }
    // Let a host page (the trial page) also show it in its own conversation log.
    if (typeof window.pxOnProactiveMessage === 'function') window.pxOnProactiveMessage(entry);
  } else {
    var why = document.createElement('div');
    why.style.marginTop = '4px';
    why.textContent = entry.nextStep;
    row.appendChild(why);
    var blocked = (entry.gates || []).filter(function (gate) { return gate.status === 'blocked'; });
    if (blocked.length > 0) {
      var gates = document.createElement('div');
      gates.className = 'muted';
      gates.textContent = '第一道命中的门禁：' + blocked[0].label + '（' + blocked[0].code + '）';
      row.appendChild(gates);
    }
  }
  log.insertBefore(row, log.firstChild);
}

async function pxLoopPoll() {
  var url = PX.base + '/proactive/loop' + (PX.loopCursor === null ? '' : '?cursor=' + PX.loopCursor);
  var payload = await (await fetch(url)).json();
  if (payload.ok === false) { return; }
  pxLoopStatus(payload);
  var first = PX.loopCursor === null;
  PX.loopCursor = payload.cursor;
  if (first) return; // a reload must not replay everything the loop did before it
  for (var i = 0; i < payload.entries.length; i += 1) pxLoopEntry(payload.entries[i]);
}

async function pxLoopToggle() {
  var box = document.getElementById(PX.ids.loopEnabled);
  var seconds = Number(pxVal('loopInterval'));
  var action = box && box.checked ? 'start' : 'stop';
  var payload = await pxPost('/proactive/loop', { action: action, intervalMs: (isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000 });
  if (payload.ok === false) { pxStatus('自动考虑操作失败：' + payload.error); return; }
  pxLoopStatus(payload);
  pxStatus(action === 'start' ? '已开始自动考虑' : '已停止自动考虑');
}

async function pxLoopTick() {
  var payload = await pxPost('/proactive/loop', { action: 'tick', cursor: PX.loopCursor === null ? 0 : PX.loopCursor });
  if (payload.ok === false) { pxStatus('立刻考虑失败：' + payload.error); return; }
  pxLoopStatus(payload);
  var first = PX.loopCursor === null;
  PX.loopCursor = payload.cursor;
  if (!first) for (var i = 0; i < payload.entries.length; i += 1) pxLoopEntry(payload.entries[i]);
}

(function pxWire() {
  var save = document.getElementById(PX.ids.save); if (save) save.addEventListener('click', function () { void pxSave(); });
  var off = document.getElementById(PX.ids.off); if (off) off.addEventListener('click', function () { void pxSave({ enabled: false }, '已一键关闭主动开口'); });
  var drill = document.getElementById(PX.ids.drill); if (drill) drill.addEventListener('click', function () { void pxDrill(); });
  var loopBox = document.getElementById(PX.ids.loopEnabled);
  if (loopBox) {
    loopBox.checked = false; // 默认关：页面刷新/重开不会自己开始说话
    loopBox.addEventListener('change', function () { void pxLoopToggle(); });
  }
  var loopTick = document.getElementById(PX.ids.loopTick); if (loopTick) loopTick.addEventListener('click', function () { void pxLoopTick(); });
  void pxLoad();
  void pxLoopPoll();
  PX.loopPoller = setInterval(function () { void pxLoopPoll(); }, 2000);
})();
`;
}

/** Small CSS the two pages share for the proactive card. */
export const PROACTIVE_PANEL_CSS = `
  .px-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:8px; font-size:12px; }
  .px-grid label { display:flex; flex-direction:column; gap:4px; }
  .px-triggers { font-size:12px; margin:8px 0; }
  .px-triggers label { display:inline-flex; flex-direction:row; align-items:center; gap:4px; }
`;

export function buildFieldPage(boot: FieldBootstrap): string {
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>西西 · 现场测试控制台</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: system-ui, "Microsoft YaHei", sans-serif; background:#0f1115; color:#e8e8ea; font-size:14px; }
  header { padding:12px 16px; border-bottom:1px solid #262a33; position:sticky; top:0; background:#0f1115; z-index:5; }
  header .row1 { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  header b { font-size:16px; }
  .pill { font-size:12px; color:#9aa3b2; border:1px solid #2a2f3a; border-radius:999px; padding:2px 9px; background:#161a21; }
  .pill.warn { color:#ffcf7a; border-color:#5c4a1f; background:#241d0d; }
  .pill.bad { color:#ff9d9d; border-color:#5c2222; background:#2a1414; }
  .pill.good { color:#8fe3a2; border-color:#1f5c31; background:#0d2415; }
  main { padding:16px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); max-width:1400px; margin:0 auto; }
  section.card { border:1px solid #262a33; border-radius:12px; padding:14px; background:#14171d; }
  section.card h2 { margin:0 0 10px; font-size:15px; }
  .muted { color:#8b93a3; font-size:12px; line-height:1.6; }
  .big { font-size:30px; font-variant-numeric:tabular-nums; }
  .unit { font-size:13px; color:#9aa3b2; margin-left:4px; }
  .bar { height:12px; border-radius:6px; background:#20242c; position:relative; overflow:hidden; margin:8px 0 4px; }
  .bar > i { position:absolute; left:0; top:0; bottom:0; width:0%; background:linear-gradient(90deg,#2b6cb0,#54a0ff); }
  .bar > span { position:absolute; top:-3px; bottom:-3px; width:2px; background:#ffcf7a; }
  .bar > span.floor { background:#8fe3a2; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #232733; vertical-align:top; }
  th { color:#9aa3b2; font-weight:600; }
  button { padding:9px 13px; border-radius:10px; border:1px solid #2a2f3a; background:#1c2028; color:#e8e8ea; font-size:13px; cursor:pointer; }
  button.primary { background:#2b6cb0; border-color:#2b6cb0; color:#fff; }
  button:disabled { opacity:.5; cursor:default; }
  input[type=text] { padding:11px 13px; border-radius:10px; border:1px solid #2a2f3a; background:#161a21; color:#e8e8ea; font-size:14px; }
  .item { border:1px solid #262a33; border-radius:10px; padding:10px; margin-bottom:8px; }
  .item.pass { border-color:#1f5c31; }
  .item.fail { border-color:#5c2222; }
  .item .head { display:flex; gap:8px; align-items:center; margin-bottom:6px; }
  .tag { font-size:11px; border-radius:6px; padding:2px 7px; }
  .tag.pass { background:#0d2415; color:#8fe3a2; }
  .tag.fail { background:#2a1414; color:#ff9d9d; }
  .tag.skipped { background:#20242c; color:#9aa3b2; }
  footer { border-top:1px solid #262a33; padding:12px 16px; position:sticky; bottom:0; background:#0f1115; }
  footer form { max-width:900px; margin:0 auto; display:flex; gap:8px; flex-wrap:wrap; }
  footer input[type=text] { flex:1; min-width:200px; }
  .steps { margin:0; padding-left:18px; line-height:1.8; }
  .err { border:1px solid #5c2222; background:#2a1414; color:#ffd7d7; padding:10px; border-radius:10px; margin-top:8px; white-space:pre-wrap; }
  details { margin-top:6px; }
  code { background:#1c2028; padding:1px 5px; border-radius:4px; font-size:12px; }
${PROACTIVE_PANEL_CSS}
</style></head>
<body>
<header>
  <div class="row1">
    <b>西西 · 现场测试控制台</b>
    <span class="pill" id="p-listen">地址加载中…</span>
    <span class="pill" id="p-state">状态…</span>
    <span class="pill" id="p-session">会话…</span>
    <span class="pill" id="p-key">密钥…</span>
    <span class="pill" id="p-tts">朗读…</span>
    <span style="flex:1"></span>
    <button id="quiet">今天安静点</button>
    <button id="new">新会话</button>
  </div>
  <div class="muted" id="p-privacy" style="margin-top:8px">隐私策略加载中…</div>
</header>
<main>
  <section class="card">
    <h2>怎么用（三步）</h2>
    <ol class="steps">
      <li>看这块下面的「麦克风电平」：不说话时它在 <b>−60 ~ −30 dBFS</b> 之间是正常的；说话时应明显跳到噪声底之上。</li>
      <li>按住页面最下面的 <b>🎤 按住说</b>，说一句「西西，明天天气怎么样？」，松开。也可以用键盘打字。</li>
      <li>在「最近几轮」里看结果：转写文字、<b>动作</b>（说话 / 沉默 / 拒绝原因）、<b>延迟分段</b>（VAD / ASR / 首字 / 总时长）。</li>
    </ol>
    <div class="muted" style="margin-top:8px">结束：回到启动它的终端按 <code>Ctrl+C</code>。页面只监听本机（127.0.0.1），别人访问不到。</div>
    <div id="page-error"></div>
  </section>

  <section class="card">
    <h2>麦克风实时电平与噪声底</h2>
    <div class="big"><span id="mic-level">—</span><span class="unit">dBFS</span></div>
    <div class="bar"><i id="mic-bar"></i><span id="mic-floor-mark" class="floor"></span><span id="mic-gate-mark"></span></div>
    <table>
      <tr><th style="width:44%">数字</th><th>含义</th></tr>
      <tr><td>当前电平 <b id="mic-level2">—</b> dBFS</td><td>0 = 数字满量程，越接近 0 越响；<b>−60 dBFS 以下基本等于听不见</b>。</td></tr>
      <tr><td>本次会话估计噪声底 <b id="mic-floor">—</b> dBFS</td><td>你说的每句话都应该明显高于它。安静时页面会自己估出来。</td></tr>
      <tr><td>校准噪声底（实测）<b id="mic-cal-floor">—</b> dBFS</td><td id="mic-cal-note">加载中…</td></tr>
      <tr><td>说话门限（校准建议）<b id="mic-gate">—</b> dBFS</td><td>低于它的声音会被当噪声，不会送去识别。</td></tr>
    </table>
    <div class="muted" id="mic-device">输入设备：未获取（点下面按钮授权）</div>
    <div class="muted">电平表用的是<b>原始信号</b>（浏览器的降噪 / 自动增益已关闭），否则看不到真实噪声底。</div>
    <div><button id="mic-on" class="primary" style="margin-top:8px">允许使用麦克风并开始监测</button></div>
    <div id="mic-error"></div>
  </section>

  <section class="card">
    <h2>摄像头在场状态（M6）</h2>
    <div class="big" id="presence-text">—</div>
    <table>
      <tr><th style="width:44%">字段</th><th>含义</th></tr>
      <tr><td>来源 <b id="presence-mode">—</b></td><td id="presence-mode-help">在场状态从哪里来</td></tr>
      <tr><td>置信度 <b id="presence-confidence">—</b></td><td>检测器有多确定（0–1）。</td></tr>
      <tr><td>更新时间 <b id="presence-updated">—</b></td><td>这条状态是什么时候写的；<b>过期就不代表「现在」</b>。</td></tr>
    </table>
    <div class="muted" id="presence-note">加载中…</div>
    <div class="muted">摄像头能不能用、画面是否正常，看下面的「设备自检 → 摄像头」；这里显示的是<b>在场判定</b>本身。</div>
  </section>

  <section class="card">
    <h2>Windows 设备读数（系统设置，只读）</h2>
    <table>
      <tr><th style="width:44%">读数</th><th>含义</th></tr>
      <tr><td>默认输入「<b id="ep-capture-name">—</b>」</td><td>静音 <b id="ep-capture-muted">—</b>，音量 <b id="ep-capture-volume">—</b>%，<b>采集增益 <span id="ep-capture-gain">—</span> dB</b>（Windows 把输入端点音量就叫增益；噪声底偏高时这条最关键）</td></tr>
      <tr><td>默认输出「<b id="ep-render-name">—</b>」</td><td>静音 <b id="ep-render-muted">—</b>，音量 <b id="ep-render-volume">—</b>%（出厂静音过一次，这是上一轮验收失败的根因）</td></tr>
    </table>
    <div class="muted" id="ep-hint">加载中…</div>
    <div class="muted" id="ep-readonly">这组读数由 pycaw 只读取得；本仓库代码不会修改系统音频设置。</div>
    <div style="margin-top:8px"><button id="ep-refresh">刷新设备读数</button> <span class="muted" id="ep-error"></span></div>
  </section>

  <section class="card">
    <h2>设备验收引导（麦克风 → 扬声器 → 摄像头）</h2>
    <div class="muted">点一次「开始设备自检」：程序会自己录 3 秒环境声、放 3 遍音频并用麦克风回采、再打开摄像头取 15 帧。全程约 20–35 秒，不需要你说话。结果与「下一步动作」会写进 <code>docs/recon/field-test-report-&lt;日期&gt;.md</code>。</div>
    <div class="muted">扬声器一项会给两个口径的数字：<b>能量比</b>（主判据，保守，≥10 dB）与<b>帧级分位</b>（乐观上界，仅参考）。只看分位会高估声学余量。</div>
    <div style="margin:10px 0"><button id="accept" class="primary">开始设备自检</button> <span class="muted" id="accept-status"></span></div>
    <div id="accept-items"></div>
    <div id="accept-error"></div>
  </section>

  <section class="card">
    <h2>最近几轮（动作 / 拒绝原因 / 延迟分段）</h2>
    <div id="turns" class="muted">还没有轮次。按住 🎤 说一句试试。</div>
    <div class="muted" style="margin-top:6px">多段回复（ADR-0010）在这里显示为「第 i/N 段 · 段间 450ms」（页面上逐条出现，终端也逐条打印）；完整一条也会写进事件日志。</div>
    <div class="err" style="border-color:#5c4a22; background:#2a2314; color:#ffe6b8; margin-top:8px">${SEGMENT_TTS_NOTE}</div>
  </section>

  <section class="card">
    <h2>本页用的是哪个数据库</h2>
    ${databaseNoteHtml(boot.databasePath)}
  </section>

${proactivePanelHtml()}

  <section class="card">
    <h2>隐私与保留策略</h2>
    <div id="privacy-detail" class="muted">加载中…</div>
    <div class="muted" style="margin-top:8px">原始整段录音<b>不落盘</b>：它只在系统临时目录里存在到 VAD 结束，随后立即删除；没有语音时磁盘上不会留下任何录音。语音段只在配置明确要求时才写入 <code>data/voice-web/</code>，并按保留期自动清理。</div>
  </section>
</main>
<footer>
  <form id="form">
    <input type="text" id="input" placeholder="也可以直接打字给西西" autocomplete="off" />
    <button class="primary" type="submit">发送</button>
    <button type="button" id="mic" title="按住说话，松开结束">🎤 按住说</button>
    <span class="muted" id="hint">按住说话 → 松开自动上传 → 结果出现在「最近几轮」。</span>
  </form>
</footer>
<script>
var BOOT = ${bootJson};
var state = null;
var micCtx = null, micAnalyser = null, micStream = null, micLevels = [], micTimer = null;
var recorder = null;

${proactivePanelScript('/api/field')}

function el(id) { return document.getElementById(id); }
function fmt(value, digits) {
  if (value === null || value === undefined || (typeof value === 'number' && !isFinite(value))) return '—';
  return Number(value).toFixed(digits === undefined ? 1 : digits);
}
function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
}
function showError(containerId, message, hint) {
  var box = el(containerId);
  if (!box) return;
  var div = document.createElement('div');
  div.className = 'err';
  div.textContent = message + (hint ? '\\n下一步：' + hint : '');
  box.appendChild(div);
  box.scrollIntoView({ block: 'nearest' });
}
function clearError(containerId) { var box = el(containerId); if (box) box.innerHTML = ''; }

function actionTag(action) {
  if (action === 'SPEAK' || action === 'TOOL') return 'good';
  if (action === 'SILENCE') return '';
  return 'warn';
}

function renderTurn(turn) {
  var box = el('turns');
  if (box.classList.contains('muted')) { box.className = ''; box.innerHTML = ''; }
  var item = document.createElement('div');
  item.className = 'item';
  var head = document.createElement('div');
  head.className = 'head';
  var tag = document.createElement('span');
  tag.className = 'tag ' + (actionTag(turn.action) === 'good' ? 'pass' : turn.action === 'SILENCE' ? 'skipped' : '');
  tag.textContent = turn.actionText || turn.action;
  head.appendChild(tag);
  var who = document.createElement('span');
  who.className = 'muted';
  who.textContent = (turn.kind === 'voice' ? '语音' : '打字') + ' · ' + turn.state + ' · ' + new Date(turn.at).toLocaleTimeString();
  head.appendChild(who);
  item.appendChild(head);
  if (turn.transcript) {
    var said = document.createElement('div');
    said.textContent = '听到：' + turn.transcript;
    item.appendChild(said);
  }
  if (turn.reply) {
    var reply = document.createElement('div');
    var pieces = turn.replySegments && turn.replySegments.length > 0 ? turn.replySegments : [turn.reply];
    if (pieces.length > 1) {
      // ADR-0010: the reply is spoken in pieces with a pause between them; show the pieces
      // one by one (the page plays them; here the pause is written down) so a reader can
      // tell "还有一段没到" from "只回了一句".
      reply.innerHTML = '<span class="muted">' + (turn.source || '回应你') + '（分 ' + pieces.length + ' 段，段间 ' + (turn.replyGapMs || 450) + 'ms，逐条说）</span>';
      for (var index = 0; index < pieces.length; index += 1) {
        var row = document.createElement('div');
        row.style.marginTop = '4px';
        var label = document.createElement('span');
        label.className = 'muted';
        label.textContent = '第 ' + (index + 1) + '/' + pieces.length + ' 段：';
        row.appendChild(label);
        row.appendChild(document.createTextNode(pieces[index]));
        reply.appendChild(row);
      }
    } else {
      reply.textContent = '西西：' + turn.reply;
    }
    item.appendChild(reply);
  }
  var why = document.createElement('div');
  why.className = 'muted';
  why.textContent = turn.reasonText + '（' + turn.reason + '）';
  item.appendChild(why);
  var stages = document.createElement('div');
  stages.className = 'muted';
  stages.textContent = '延迟分段：VAD ' + fmt(turn.stages.vadMs, 0) + 'ms · ASR ' + fmt(turn.stages.asrMs, 0)
    + 'ms · 首字 ' + fmt(turn.stages.llmFirstChunkMs, 0) + 'ms · 模型 ' + fmt(turn.stages.llmTotalMs, 0)
    + 'ms · 总时长 ' + fmt(turn.stages.totalMs, 0) + 'ms';
  item.appendChild(stages);
  var segs = document.createElement('div');
  segs.className = 'muted';
  var segText = '语音段：用了 ' + turn.segmentsUsed + ' / 共 ' + turn.segmentsTotal + ' 段';
  if (turn.droppedSegments && turn.droppedSegments.length > 0) {
    segText += '，丢弃 ' + turn.droppedSegments.length + ' 段（';
    for (var i = 0; i < turn.droppedSegments.length; i += 1) {
      var d = turn.droppedSegments[i];
      segText += '第' + (i + 1) + '条 ' + fmt(d.startMs, 0) + '-' + fmt(d.endMs, 0) + 'ms：' + d.reason + '；';
    }
    segText += '）';
  } else {
    segText += '，没有丢弃';
  }
  segs.textContent = segText;
  item.appendChild(segs);
  var privacy = document.createElement('div');
  privacy.className = 'muted';
  privacy.textContent = '隐私：' + turn.privacyNote;
  item.appendChild(privacy);
  box.insertBefore(item, box.firstChild);
  while (box.children.length > 12) box.removeChild(box.lastChild);
}

function renderState(payload) {
  state = payload;
  el('p-listen').textContent = '地址 ' + payload.listen;
  el('p-state').textContent = '对话状态 ' + payload.state;
  el('p-session').textContent = '会话 ' + payload.sessionId.slice(5, 13) + ' · ' + payload.turnCount + ' 轮';
  var key = el('p-key');
  if (payload.model.offline) { key.className = 'pill warn'; key.textContent = '离线演示模式（ASR/模型用替身）'; }
  else if (payload.model.configured) { key.className = 'pill good'; key.textContent = '模型密钥已配置（' + payload.adapter.provider + '）'; }
  else { key.className = 'pill bad'; key.textContent = '缺少 MIMO_API_KEY：语音识别用不了'; }
  el('p-tts').textContent = payload.ttsEnabled ? '回复朗读 开' : '回复朗读 关';
  el('p-privacy').textContent = '隐私：' + payload.privacy.policy.reason;
  el('mic-cal-floor').textContent = fmt(payload.calibration.noiseFloorDbfs, 2);
  el('mic-cal-note').textContent = payload.calibration.note;
  el('mic-gate').textContent = fmt(payload.calibration.gateThresholdDbfs, 1);
  el('mic-floor-mark').style.left = pctFromDbfs(payload.calibration.noiseFloorDbfs) + '%';
  el('mic-gate-mark').style.left = pctFromDbfs(payload.calibration.gateThresholdDbfs) + '%';
  var detail = el('privacy-detail');
  detail.textContent = payload.privacy.policy.reason + '　清理结果：删了 ' + payload.privacy.pruned.removed.length
    + ' 个文件（' + Math.round(payload.privacy.pruned.bytesFreed / 1024) + ' KB），保留 ' + payload.privacy.pruned.kept + ' 个非本程序文件。';
  renderPresence(payload.presence);
}

function renderPresence(presence) {
  el('presence-text').textContent = presence.text;
  el('presence-mode').textContent = presence.mode === 'projection' ? 'world_state 投影'
    : presence.mode === 'events' ? '事件日志 presence.changed'
    : presence.mode === 'not-integrated' ? '未接入' : '读取失败';
  el('presence-mode-help').textContent = presence.mode === 'not-integrated'
    ? '摄像头在场检测（M6）还没接入：这是「未接入」，不是故障。'
    : '在场状态从哪里来。';
  el('presence-confidence').textContent = fmt(presence.confidence, 2);
  el('presence-updated').textContent = presence.updatedAt === null ? '—' : presence.updatedAt + (presence.stale ? '（已过期）' : '');
  el('presence-note').textContent = presence.note;
}

function renderEndpoints(payload) {
  el('ep-error').textContent = '';
  if (payload.ok === false) {
    el('ep-capture-name').textContent = '读取失败';
    el('ep-render-name').textContent = '读取失败';
    el('ep-hint').textContent = payload.error ? payload.error.message + '（下一步：' + payload.error.hint + '）' : '读不到端点读数';
    return;
  }
  var capture = payload.capture || {};
  var render = payload.render || {};
  el('ep-capture-name').textContent = capture.name || '(未命名)';
  el('ep-capture-muted').textContent = capture.muted ? '是（麦克风被静音！）' : '否';
  el('ep-capture-volume').textContent = Math.round(Number(capture.volumeScalar || 0) * 100);
  el('ep-capture-gain').textContent = payload.captureGainDb === null || payload.captureGainDb === undefined ? '—' : Number(payload.captureGainDb).toFixed(2);
  el('ep-render-name').textContent = render.name || '(未命名)';
  el('ep-render-muted').textContent = render.muted ? '是（扬声器放不出声）' : '否';
  el('ep-render-volume').textContent = Math.round(Number(render.volumeScalar || 0) * 100);
  el('ep-hint').textContent = payload.hint || '';
  el('ep-readonly').textContent = (payload.readOnlyNote || '这组读数由 pycaw 只读取得。') + '（读数时间 ' + new Date(payload.checkedAt).toLocaleTimeString() + '）';
}

async function refreshEndpoints(force) {
  try {
    var response = await fetch('/api/field/endpoints' + (force ? '?force=1' : ''));
    renderEndpoints(await response.json());
  } catch (error) {
    el('ep-hint').textContent = '读不到 Windows 设备读数：' + error.message + '（下一步：确认启动现场测试的终端还在运行）';
  }
}

function pctFromDbfs(dbfs) {
  if (dbfs === null || dbfs === undefined) return 0;
  var clamped = Math.max(-90, Math.min(0, Number(dbfs)));
  return Math.round(((clamped + 90) / 90) * 100);
}

async function refreshState() {
  try {
    var response = await fetch('/api/field/state');
    renderState(await response.json());
  } catch (error) {
    showError('page-error', '读不到控制台状态：' + error.message + '（页面还能用，只是状态不刷新）', '确认启动现场测试的终端还在运行');
  }
}

async function startMicMeter() {
  clearError('mic-error');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (error) {
    showError('mic-error', '浏览器没能打开麦克风：' + error.message, '点地址栏左边的锁图标允许麦克风；确认系统里默认输入设备没被静音、也没被别的软件独占');
    return;
  }
  var track = micStream.getAudioTracks()[0];
  el('mic-device').textContent = '输入设备：' + (track.label || '(未命名)') + '（原始信号，未降噪）';
  micCtx = new (window.AudioContext || window.webkitAudioContext)();
  var source = micCtx.createMediaStreamSource(micStream);
  micAnalyser = micCtx.createAnalyser();
  micAnalyser.fftSize = 2048;
  source.connect(micAnalyser);
  el('mic-on').disabled = true;
  var buffer = new Float32Array(micAnalyser.fftSize);
  micTimer = setInterval(function () {
    micAnalyser.getFloatTimeDomainData(buffer);
    var sum = 0;
    for (var i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
    var rms = Math.sqrt(sum / buffer.length);
    var dbfs = 20 * Math.log10(Math.max(rms, 1e-7));
    el('mic-level').textContent = dbfs.toFixed(1);
    el('mic-level2').textContent = dbfs.toFixed(1);
    el('mic-bar').style.width = pctFromDbfs(dbfs) + '%';
    micLevels.push(dbfs);
    if (micLevels.length > 200) micLevels.shift();
    if (micLevels.length >= 20) {
      var sorted = micLevels.slice().sort(function (a, b) { return a - b; });
      var floor = sorted[Math.floor(sorted.length * 0.1)];
      el('mic-floor').textContent = floor.toFixed(1);
    }
  }, 100);
}

async function startRecording() {
  if (micStream === null) await startMicMeter();
  if (micStream === null) return;
  var context = new (window.AudioContext || window.webkitAudioContext)();
  await context.resume();
  var source = context.createMediaStreamSource(micStream);
  var processor = context.createScriptProcessor(4096, 1, 1);
  var chunks = [];
  processor.onaudioprocess = function (event) { chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
  source.connect(processor);
  processor.connect(context.destination);
  recorder = { context: context, source: source, processor: processor, chunks: chunks, sampleRate: context.sampleRate };
  el('mic').textContent = '⏺ 松开发送';
  el('hint').textContent = '正在录音…（松开按钮结束）';
}

function encodeWav(samples, sampleRate) {
  var buffer = new ArrayBuffer(44 + samples.length * 2);
  var view = new DataView(buffer);
  var writeText = function (offset, text) { for (var i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeText(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, 'data'); view.setUint32(40, samples.length * 2, true);
  var offset = 44;
  for (var i = 0; i < samples.length; i += 1, offset += 2) {
    var clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function toBase64(bytes) {
  var binary = '';
  var chunk = 0x8000;
  for (var i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function stopRecording() {
  if (recorder === null) return;
  var current = recorder;
  recorder = null;
  el('mic').textContent = '🎤 按住说';
  current.processor.disconnect();
  current.source.disconnect();
  await current.context.close();
  var total = 0;
  for (var i = 0; i < current.chunks.length; i += 1) total += current.chunks[i].length;
  var seconds = total / current.sampleRate;
  if (seconds < 0.3) { el('hint').textContent = '太短了，按住多说一会儿。'; return; }
  var merged = new Float32Array(total);
  var offset = 0;
  for (var j = 0; j < current.chunks.length; j += 1) { merged.set(current.chunks[j], offset); offset += current.chunks[j].length; }
  el('hint').textContent = '录音 ' + seconds.toFixed(1) + 's，正在识别…';
  clearError('page-error');
  try {
    var response = await post('/api/voice', { audioBase64: toBase64(encodeWav(merged, current.sampleRate)), speak: BOOT.ttsEnabled });
    var data = await response.json();
    if (data.ok === false) {
      showError('page-error', data.error.message, data.error.hint);
      el('hint').textContent = '这一轮没有成功：' + data.error.message;
      return;
    }
    renderTurn({
      kind: 'voice', at: data.at, action: data.action, actionText: data.actionText, reason: data.reason, reasonText: data.reasonText,
      transcript: data.transcript, reply: data.reply, state: data.state, stages: data.stages,
      segmentsTotal: data.segmentsTotal, segmentsUsed: data.segmentsUsed, droppedSegments: data.droppedSegments,
      privacyNote: data.privacy.note
    });
    if (data.audio) { new Audio('data:audio/wav;base64,' + data.audio).play().catch(function () {}); }
    el('hint').textContent = '说完松开即发送。';
    await refreshState();
  } catch (error) {
    showError('page-error', '上传失败：' + error.message, '确认启动现场测试的终端还在运行');
  }
}

async function runAcceptance() {
  var button = el('accept');
  button.disabled = true;
  el('accept-status').textContent = '正在自检（麦克风 3 秒 → 扬声器播放并回采 → 摄像头取帧）…';
  clearError('accept-error');
  try {
    var response = await post('/api/field/acceptance', {});
    var data = await response.json();
    if (data.ok === false) {
      showError('accept-error', data.error.message, data.error.hint);
      el('accept-status').textContent = '';
      return;
    }
    renderAcceptance(data.report);
    el('accept-status').textContent = '总体：' + (data.report.overall === 'pass' ? '通过' : '未通过')
      + '｜报告已写入 ' + (data.report.reportPath || '(未落盘)');
  } catch (error) {
    showError('accept-error', '自检失败：' + error.message, '看启动终端里的日志');
    el('accept-status').textContent = '';
  } finally {
    button.disabled = false;
  }
}

function renderAcceptance(report) {
  var box = el('accept-items');
  box.innerHTML = '';
  for (var i = 0; i < report.items.length; i += 1) {
    var item = report.items[i];
    var card = document.createElement('div');
    card.className = 'item ' + (item.verdict === 'fail' ? 'fail' : item.verdict === 'pass' ? 'pass' : '');
    var head = document.createElement('div');
    head.className = 'head';
    var tag = document.createElement('span');
    tag.className = 'tag ' + item.verdict;
    tag.textContent = item.verdict === 'pass' ? '通过' : item.verdict === 'fail' ? '失败' : '跳过';
    head.appendChild(tag);
    var title = document.createElement('b');
    title.textContent = item.order + '. ' + item.name;
    head.appendChild(title);
    card.appendChild(head);
    var summary = document.createElement('div');
    summary.textContent = item.summary;
    card.appendChild(summary);
    var table = document.createElement('table');
    for (var j = 0; j < item.checks.length; j += 1) {
      var check = item.checks[j];
      var row = document.createElement('tr');
      var name = document.createElement('td');
      name.textContent = (check.verdict === 'pass' ? '✔ ' : check.verdict === 'fail' ? '✘ ' : '· ') + check.name;
      var detail = document.createElement('td');
      detail.textContent = check.detail;
      row.appendChild(name);
      row.appendChild(detail);
      table.appendChild(row);
    }
    card.appendChild(table);
    var next = document.createElement('div');
    next.className = 'muted';
    next.style.marginTop = '6px';
    next.textContent = '下一步动作：' + String(item.nextAction).replace(/^\s*下一步[：:]\s*/, '');
    card.appendChild(next);
    box.appendChild(card);
  }
}

el('mic-on').addEventListener('click', startMicMeter);
el('mic').addEventListener('pointerdown', function (event) {
  event.preventDefault();
  startRecording().catch(function (error) { showError('mic-error', '无法开始录音：' + error.message, '检查麦克风权限'); });
});
el('mic').addEventListener('pointerup', function (event) { event.preventDefault(); stopRecording(); });
el('mic').addEventListener('pointerleave', function () { if (recorder !== null) stopRecording(); });
el('accept').addEventListener('click', runAcceptance);
el('quiet').addEventListener('click', async function () {
  var data = await (await post('/api/quiet', {})).json();
  el('p-state').textContent = '对话状态 ' + data.state + '（安静模式：点「新会话」恢复）';
});
el('new').addEventListener('click', async function () {
  await post('/api/session', {});
  el('turns').className = 'muted';
  el('turns').textContent = '新会话已开始。按住 🎤 说一句试试。';
  await refreshState();
});
el('form').addEventListener('submit', async function (event) {
  event.preventDefault();
  var input = el('input');
  var text = input.value.trim();
  if (!text) return;
  input.value = '';
  clearError('page-error');
  try {
    var data = await (await post('/api/turn', { text: text, speak: BOOT.ttsEnabled })).json();
    if (data.ok === false) { showError('page-error', data.error.message, data.error.hint); return; }
    renderTurn({
      kind: 'text', at: data.at, action: data.action, actionText: data.actionText, reason: data.reason, reasonText: data.reasonText,
      transcript: data.transcript, reply: data.reply, state: data.state,
      stages: { vadMs: 0, asrMs: null, llmFirstChunkMs: data.firstTokenMs, llmTotalMs: data.latencyMs, ttsMs: null, totalMs: data.latencyMs },
      segmentsTotal: 0, segmentsUsed: 0, droppedSegments: [], privacyNote: '打字输入：没有音频'
    });
    if (data.audio) { new Audio('data:audio/wav;base64,' + data.audio).play().catch(function () {}); }
    await refreshState();
  } catch (error) {
    showError('page-error', '发送失败：' + error.message, '确认启动现场测试的终端还在运行');
  }
});

refreshState();
refreshEndpoints(false);
el('ep-refresh').addEventListener('click', function () { refreshEndpoints(true); });
setInterval(function () { refreshState(); }, 5000);
setInterval(function () { refreshEndpoints(false); }, 30000);
</script>
</body></html>`;
}

// --------------------------------------------------------------------------------------
// Offline self-test (no devices, no network, no API key)
// --------------------------------------------------------------------------------------

/**
 * A probe runner that answers from constants instead of hardware.
 *
 * `render.muted = true` plus a 2.6 dB play-vs-silence difference is a *deliberate*
 * reproduction of the false-PASS case from the recon: the old absolute criterion
 * (`rms > 0.005`) would call this speaker "ok". The self-test asserts the console
 * calls it FAIL and points at the mute. That makes the fix a regression test
 * rather than a claim.
 */
export interface FakeProbeOptions {
  /** Whether the *render* endpoint is muted (the false-PASS case keeps it muted by default). */
  readonly renderMuted?: boolean;
  /** Primary speaker criterion (dB). */
  readonly energyRatioDb?: number;
  /** Optimistic frame-percentile criterion (dB) — reported, never the gate. */
  readonly differentialP95Db?: number;
  readonly differentialMeanDb?: number;
}

export function createFakeProbeRunner(options: FakeProbeOptions = {}): ProbeRunner {
  return async (mode) => {
    switch (mode) {
      case 'endpoints':
        return {
          ok: true,
          readOnly: true,
          render: { label: 'render', name: 'FAKE 扬声器', muted: options.renderMuted ?? true, volumeScalar: 0.661, volumeDb: -6.19, gainDb: null },
          capture: { label: 'capture', name: 'FAKE 麦克风', muted: false, volumeScalar: 0.66, volumeDb: 0.23, gainDb: 0.23 },
        };
      case 'mic':
        return { ok: true, device: 'FAKE 麦克风', rate: 48000, seconds: 3, unit: 'dBFS', rmsDbfs: -27.25, noiseFloorDbfs: -30.86, p90FrameDbfs: -26.4, peakDbfs: -12.1, frames: 59 };
      case 'speaker':
        return {
          ok: true,
          fixture: 'fake.wav',
          gain: 1.0,
          rate: 48000,
          unit: 'dBFS',
          prerollMs: 1000,
          tailMs: 1000,
          playedMs: 2520,
          // F2: the two criteria disagree by design in this double — the energy ratio is
          // the conservative one, the frame percentile is ~9 dB higher.
          energyRatioDb: options.energyRatioDb ?? -2.6,
          playWindowBandPowerDbfs: -38.6,
          silenceWindowBandPowerDbfs: -36.0,
          preRollSpeechBandDbfs: -41.2,
          playWindowMeanSpeechBandDbfs: -38.6,
          playWindowP95SpeechBandDbfs: -38.6,
          differentialMeanDb: options.differentialMeanDb ?? -2.6,
          differentialP95Db: options.differentialP95Db ?? -2.6,
          micRmsDbfs: -30.1,
          bandEstimator: 'fake',
          playbackPeakDbfs: -5.49,
          playbackClipSamples: 0,
          loopbackCorrelation: 0.9996,
          loopbackError: null,
        };
      case 'camera':
        return { ok: true, backend: 'CAP_DSHOW', opened: true, width: 640, height: 480, fps: 30.1, frames: 15, lumaMean: 121.4, lumaStd: 42.7, uniqueLuma: 210, maxWidth: 1280, maxHeight: 720 };
      default:
        return { ok: false, error: `unknown mode ${mode}` };
    }
  };
}

export interface SelfTestResult {
  readonly ok: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly lines: readonly string[];
}

function countScratchDirs(): number {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith('xixi-vad-')).length;
  } catch {
    return 0;
  }
}

/** A WAV of `ms` milliseconds of digital silence (16 kHz mono PCM16). */
export function silenceWav(ms: number): Buffer {
  const frames = Math.round((ms / 1000) * 16_000);
  const data = Buffer.alloc(frames * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(16_000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * `node scripts/field-test.ts --self-test`: proves the console's promises offline.
 *
 * What it actually exercises: the real HTTP surface, the real VAD (localhost
 * Python, no network), the real conversation engine with the offline adapter, the
 * retention policy, the acceptance renderer and the report writer. What it does
 * not: hardware. The device path is covered by `--acceptance` on the real machine.
 */
export async function runSelfTest(options: { log?: (line: string) => void } = {}): Promise<SelfTestResult> {
  const log = options.log ?? ((): void => {});
  const lines: string[] = [];
  let passed = 0;
  let failed = 0;
  const check = (name: string, condition: boolean, detail: string): void => {
    if (condition) {
      passed += 1;
      lines.push(`PASS  ${name}｜${detail}`);
    } else {
      failed += 1;
      lines.push(`FAIL  ${name}｜${detail}`);
    }
    log(`${condition ? 'PASS' : 'FAIL'}  ${name}｜${detail}`);
  };

  const root = mkdtempSync(join(tmpdir(), 'xixi-field-test-'));
  const voiceDir = join(root, 'voice-web');
  const reportDir = join(root, 'recon');
  mkdirSync(voiceDir, { recursive: true });
  // A legacy whole-recording file, exactly what the audit found un-cleaned.
  writeFileSync(join(voiceDir, 'capture-1700000000000.wav'), Buffer.alloc(2048, 7));
  const scratchBefore = countScratchDirs();
  let handle: FieldServerHandle | null = null;
  try {
    handle = await createFieldServer({
      port: 0,
      offline: true,
      ttsEnabled: false,
      voiceDir,
      dataDir: join(root, 'data'),
      presenceDataDir: join(root, 'presence'),
      reportDir,
      probeRunner: createFakeProbeRunner(),
      log: (line) => log(`      ${line}`),
    });
    const base = handle.url;
    check('服务只监听 127.0.0.1', handle.url.startsWith('http://127.0.0.1:'), handle.url);

    // ---- page -----------------------------------------------------------------
    const page = await (await fetch(`${base}/`)).text();
    const pageMarkers = ['麦克风实时电平与噪声底', '摄像头在场状态', '设备验收引导', '最近几轮', 'VAD', 'ASR', '首字', '总时长', '沉默', '下一步动作', 'dBFS', '127.0.0.1', '采集增益', '能量比', '分位', '只读'];
    const missing = pageMarkers.filter((marker) => !page.includes(marker));
    check('页面包含全部中文说明与数字含义', missing.length === 0, missing.length === 0 ? `${pageMarkers.length} 个标记全部存在` : `缺少：${missing.join('、')}`);

    // ---- state + retention/prune ----------------------------------------------
    const state = (await (await fetch(`${base}/api/field/state`)).json()) as Record<string, any>;
    check('状态接口报告监听地址', state.listen === `127.0.0.1:${handle.port}`, String(state.listen));
    check('隐私策略：整段录音不落盘', state.privacy.policy.storeRawAudio === false && state.privacy.policy.keepSpeechSegments === false, String(state.privacy.policy.reason).slice(0, 120));
    check('旧版整段录音启动时被清理', state.privacy.pruned.removed.length === 1 && !existsSync(join(voiceDir, 'capture-1700000000000.wav')), `删除 ${state.privacy.pruned.removed.length} 个：${state.privacy.pruned.removed.map((item: { name: string }) => item.name).join('、')}`);

    // ---- presence fallback ----------------------------------------------------
    const presence = (await (await fetch(`${base}/api/field/presence`)).json()) as Record<string, unknown>;
    check('摄像头未接入时显示「未接入」而不是报错', presence.mode === 'not-integrated' && presence.text === '未接入', `${String(presence.mode)}｜${String(presence.note)}`);

    // ---- multi-segment voice turn ---------------------------------------------
    const first = readWav(join(REPO_ROOT, 'tests', 'audio-fixtures', 'direct-question.wav'));
    const second = readWav(join(REPO_ROOT, 'tests', 'audio-fixtures', 'followup-turn.wav'));
    const multi = concatWav([first, second], 800);
    const voiceResponse = await fetch(`${base}/api/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: multi.toString('base64'), speak: false }),
    });
    const voice = (await voiceResponse.json()) as Record<string, any>;
    check('多段语音：VAD 检出多段', voice.segmentsTotal >= 2, JSON.stringify(voice.segments));
    check('多段语音：全部送进识别（不再只取第一段）', voice.segmentsUsed === voice.segmentsTotal && voice.droppedSegments.length === 0, `用了 ${voice.segmentsUsed}/${voice.segmentsTotal}，丢弃 ${voice.droppedSegments.length}`);
    const usedMs = (voice.segments as { durationMs: number }[]).reduce((sum, item) => sum + item.durationMs, 0);
    const stubBytes = Number(/收到 (\d+) 字节/.exec(String(voice.transcript))?.[1] ?? 0);
    const firstOnlyBytes = Math.round((voice.segments[0]?.durationMs ?? 0) * 48);
    check('多段语音：识别用的音频确实包含所有段（不只是第一段）', stubBytes >= usedMs * 48 * 0.9 && stubBytes > firstOnlyBytes * 1.2, `识别收到 ${stubBytes} 字节，全部段约 ${Math.round(usedMs * 48)} 字节，仅第一段约 ${firstOnlyBytes} 字节`);
    check('每轮都有延迟分段（VAD/ASR/首字/总时长）', voice.stages.vadMs > 0 && voice.stages.asrMs !== null && voice.stages.totalMs > 0 && voice.stages.llmFirstChunkMs !== null, JSON.stringify(voice.stages));
    check('每轮都有动作与原因的中文解释', typeof voice.actionText === 'string' && voice.actionText.length > 0 && typeof voice.reasonText === 'string' && voice.reasonText.length > 0, `${voice.action}｜${voice.reason}`);
    check('多段语音轮：磁盘上没有原始录音', readdirSync(voiceDir).length === 0, `voice-web 目录：${JSON.stringify(readdirSync(voiceDir))}`);

    // ---- no speech ------------------------------------------------------------
    const silentResponse = await fetch(`${base}/api/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: silenceWav(800).toString('base64'), speak: false }),
    });
    const silent = (await silentResponse.json()) as Record<string, any>;
    check('无语音：判为沉默 + 说明原因', silent.action === 'SILENCE' && silent.reason === 'NO_SPEECH_DETECTED', `${silent.action}｜${silent.reasonText}`);
    check('无语音：磁盘上不留下原始录音', readdirSync(voiceDir).length === 0, `voice-web 目录：${JSON.stringify(readdirSync(voiceDir))}`);
    check('无语音：临时目录已清理', countScratchDirs() <= scratchBefore, `临时 xixi-vad-* 目录 ${countScratchDirs()} 个（开始时 ${scratchBefore} 个）`);

    // ---- readable errors ------------------------------------------------------
    const emptyResponse = await fetch(`${base}/api/voice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const empty = (await emptyResponse.json()) as Record<string, any>;
    check('没有音频时给可读中文错误（不是堆栈）', emptyResponse.status === 400 && typeof empty.error?.message === 'string' && empty.error.message.includes('没有收到音频') && typeof empty.error?.hint === 'string', `HTTP ${emptyResponse.status}｜${String(empty.error?.message)}｜${String(empty.error?.hint).slice(0, 60)}`);
    const notFound = (await (await fetch(`${base}/api/nope`)).json()) as Record<string, any>;
    check('未知接口给中文提示而不是白屏', notFound.ok === false && typeof notFound.error?.message === 'string', String(notFound.error?.message));

    // ---- acceptance (fake devices, deliberately muted speaker) ----------------
    const acceptanceResponse = await fetch(`${base}/api/field/acceptance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const acceptance = (await acceptanceResponse.json()) as Record<string, any>;
    const report = acceptance.report as Record<string, any>;
    check('设备自检按「麦克风→扬声器→摄像头」顺序返回三项', report.items.length === 3 && report.items.map((item: { order: number }) => item.order).join(',') === '1,2,3', report.items.map((item: { name: string }) => item.name).join(' / '));
    check('每项都有通过/失败与下一步动作', report.items.every((item: { verdict: string; nextAction: string }) => ['pass', 'fail', 'skipped'].includes(item.verdict) && item.nextAction.length > 10), report.items.map((item: { verdict: string }) => item.verdict).join(','));
    const speaker = report.items.find((item: { id: string }) => item.id === 'speaker') as Record<string, any>;
    check('扬声器静音 + 播放窗无差异 → 判 FAIL（修掉假 PASS）', speaker.verdict === 'fail' && speaker.nextAction.includes('静音'), speaker.summary);
    check('扬声器判据是相对的，不是绝对 RMS', speaker.checks.some((item: { detail: string }) => item.detail.includes('相对')), speaker.checks.map((item: { name: string }) => item.name).join(' / '));
    check('F2：报告同时给出能量比（主判据）与分位（上界）两个口径', speaker.checks.some((item: { name: string }) => item.name.includes('能量比')) && speaker.checks.some((item: { name: string }) => item.name.includes('分位') && item.name.includes('不作为判据')), speaker.checks.map((item: { name: string }) => item.name).join(' / '));
    check('F6：复测同时报最差/均值/最好', speaker.checks.some((item: { detail: string }) => item.detail.includes('最差') && item.detail.includes('均值') && item.detail.includes('最好')) && (speaker.evidence.trialStats as { trials: number }).trials === 3, JSON.stringify((speaker.evidence.trialStats as { energyRatioDb: unknown }).energyRatioDb));
    check('总体结论与报告落盘', report.overall === 'fail' && typeof report.reportPath === 'string' && existsSync(report.reportPath), String(report.reportPath));
    const reportText = typeof report.reportPath === 'string' && existsSync(report.reportPath) ? readFileSync(report.reportPath, 'utf8') : '';
    // One check, several contract properties: the report must carry its items, its evidence, the
    // reproduction commands, the false-PASS rationale — and the 口径变更说明 the generator emits
    // (kept in the same assertion on purpose: adding a separate item would bump the self-test
    // count in three docs that quote it, which is the drift t9 flagged).
    check(
      '报告文件含逐项结论、证据、复现方式与「口径变更说明」',
      reportText.includes('现场测试报告') &&
        reportText.includes('下一步动作') &&
        reportText.includes('复现方式') &&
        reportText.includes('假 PASS') &&
        reportText.includes('口径变更说明') &&
        reportText.includes('t4 交付时为 PASS、t21 修正口径后为 FAIL') &&
        reportText.includes('ACCEPTANCE_CRITERIA_NOTE'),
      `报告 ${reportText.split('\n').length} 行，含口径变更说明（重跑 --acceptance 不会丢）`,
    );

    // ---- F7: endpoint readings (capture gain) visible --------------------------
    const endpoints = (await (await fetch(`${base}/api/field/endpoints`)).json()) as Record<string, any>;
    check('F7：控制台能给出输入采集增益（pycaw 只读读数）', endpoints.ok === true && endpoints.captureGainDb === 0.23 && endpoints.readOnly === true, `captureGainDb=${String(endpoints.captureGainDb)} | readOnly=${String(endpoints.readOnly)}`);
    check('F7：噪声底偏高时提示「可考虑设为 0 dB」，并声明不改系统设置', String(endpoints.hint).includes('0 dB') && String(endpoints.hint).includes('只提示') && String(endpoints.readOnlyNote).includes('不会修改'), String(endpoints.hint).slice(0, 90));

    // ---- F2 regression: energy ratio below the gate while the percentile is above it
    // This is the exact case the independent verification flagged: a non-muted render,
    // energy ratio 2.69 dB, frame percentile 11.83 dB. The item MUST fail, and both
    // numbers MUST be in the report.
    const f2Handle = await createFieldServer({
      port: 0,
      offline: true,
      ttsEnabled: false,
      voiceDir: join(root, 'voice-f2'),
      dataDir: join(root, 'data-f2'),
      presenceDataDir: join(root, 'presence-f2'),
      reportDir: join(root, 'recon-f2'),
      autoPrune: false,
      probeRunner: createFakeProbeRunner({ renderMuted: false, energyRatioDb: 2.69, differentialP95Db: 11.83, differentialMeanDb: 6.47 }),
      log: () => {},
    });
    try {
      const f2Response = (await (await fetch(`${f2Handle.url}/api/field/acceptance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as Record<string, any>;
      const f2Speaker = (f2Response.report.items as Record<string, any>[]).find((item) => item.id === 'speaker');
      check('F2 回归：能量比 2.69 dB（<10）但分位 11.83 dB（>10）→ 必须判 FAIL', f2Speaker.verdict === 'fail', f2Speaker.summary);
      check('F2 回归：FAIL 的说明里点名能量比与「乐观上界」', String(f2Speaker.summary).includes('能量比') && String(f2Speaker.summary).includes('上界'), String(f2Speaker.summary).slice(0, 120));
      const f2Text = readFileSync(f2Response.report.reportPath as string, 'utf8');
      check('F2 回归：报告里两个口径都出现（2.69 与 11.83）', f2Text.includes('2.69') && f2Text.includes('11.83'), `报告 ${f2Text.split('\n').length} 行`);
    } finally {
      await f2Handle.close();
    }
  } catch (error) {
    check('自检过程未抛异常', false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    if (handle !== null) await handle.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      // Windows keeps SQLite handles alive for a moment; a leftover temp dir is
      // not a functional failure, so it is reported rather than thrown.
      lines.push(`INFO  临时目录未能立即删除（${error instanceof Error ? error.message : String(error)}）：${root}`);
    }
  }
  const leftover = countScratchDirs() - scratchBefore;
  check('自检结束后没有残留临时录音目录', leftover <= 0, `残留 ${leftover} 个`);
  return { ok: failed === 0, passed, failed, lines };
}

// --------------------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------------------

function printStartup(handle: FieldServerHandle, info: { offline: boolean; ttsEnabled: boolean; policy: RetentionPolicy; calibration: CalibrationView; modelConfigured: boolean }): void {
  const line = '─'.repeat(66);
  console.log(`\n${line}`);
  console.log('西西 · 现场测试控制台已启动（一条命令版）');
  console.log(`${line}`);
  console.log(`  地址： ${handle.url}`);
  console.log(`         只监听本机 127.0.0.1，别人访问不到；把上面地址粘进浏览器即可。`);
  console.log(`  大脑： ${info.offline ? '离线演示（ASR/模型都是替身，不花钱、不需要密钥）' : info.modelConfigured ? '直连 MiMo（实时路径）' : '直连 MiMo，但缺少 MIMO_API_KEY —— 语音识别会报中文错误，页面与设备自检仍可用'}`);
  console.log(`  朗读： ${info.ttsEnabled ? '开' : '关'}`);
  console.log('');
  console.log('【三步上手】');
  console.log('  1. 页面左上「麦克风实时电平」：不说话时 −60 ~ −30 dBFS 属正常；说话时应明显跳高。');
  console.log('  2. 按住页面底部「🎤 按住说」，说「西西，明天天气怎么样？」，松开（也可以直接打字）。');
  console.log('  3. 看「最近几轮」：转写文字、动作（说话/沉默/拒绝原因）、延迟分段（VAD/ASR/首字/总时长）。');
  console.log('');
  console.log('【设备验收】页面里点「开始设备自检」：麦克风 → 扬声器 → 摄像头，逐项给出通过/失败与下一步动作；');
  console.log(`  报告写到 docs/recon/field-test-report-<日期>.md。也可以只跑一次：node scripts/field-test.ts --acceptance`);
  console.log('');
  console.log('【结束】回到这个终端按 Ctrl+C。');
  console.log(`【隐私】${info.policy.reason}`);
  console.log(`【校准】${info.calibration.note}`);
  console.log(`${line}\n`);
}

/** `--help` output. Kept beside the CLI so the flags and the text cannot drift apart. */
const FIELD_TEST_USAGE = `西西 · 现场测试控制台 —— 用法

  npm run field-test                      打开控制台（默认 http://127.0.0.1:8792，只监听本机）
  npm run field-test -- --port 8793       换端口（等价：XIXI_FIELD_PORT=8793）
  npm run field-test -- --offline         没有 MIMO_API_KEY 也能用页面：ASR/对话模型换成替身，不花钱
  npm run field-test -- --no-tts          关闭回复朗读
  npm run field-test -- --dsh             走 DSH Harness 路径（慢，实时对话不建议）
  npm run field-test -- --no-open         不自动打开浏览器（非交互终端本来就不会打开）
  npm run field-test -- --data-dir data/whatever        换控制台自己的库（self_profile / 事件日志；默认 data/field-test）
  npm run field-test -- --presence-data-dir data/whatever-presence
                                                        换在场状态投影读的库（默认 data，与感知边共用）

  node scripts/field-test.ts --self-test      离线自检：隐私 / 多段语音 / 页面 / 报告 / 设备口径，不碰麦克风、不联网
                                              exit 0 = 全过；有任何一项失败会 exit 1。
                                              项数会随回归断言增加（已经漂移过一次：24 → 31），所以这里
                                              **不写死数字**——看它最后一行的「自检结果：N 项通过」。
                                              它用独立临时目录跑（不碰你的库），所以 --data-dir / --presence-data-dir
                                              在这个模式下不生效（会明确提示，不静默忽略）。
  node scripts/field-test.ts --acceptance     真机设备验收（麦克风 → 扬声器 → 摄像头），逐项打印通过/失败与下一步，
                                              报告写入 docs/recon/field-test-report-<日期>.md；有失败项时 exit 1
  node scripts/field-test.ts --help           显示这份说明后退出（不启动服务、不占端口）

  **不认识的参数会报错并以 exit 2 结束**（中文说明 + 可用参数列表），不会静默忽略。

页面里能看到：麦克风实时电平与噪声底（含校准门限）、摄像头在场状态（未接入时显示「未接入」而不是报错）、
每轮的延迟分段（VAD / ASR / 首字 / 总时长）与最终动作（含 SILENCE 与拒绝原因）、以及设备验收引导。

环境变量：XIXI_FIELD_PORT 默认端口；XIXI_PYTHON 语音 VAD 用的 Python；
          XIXI_PROBE_PYTHON / XIXI_AUDIO_PYTHON 设备探测与声学回环用的 Python（默认 .venvs/field-probe 与 .venvs/voice-livekit）。
隐私：整段录音不落盘（只在系统临时目录存在到 VAD 结束，随后删除），语音段仅在 config 授权时保留；
      详见页面「隐私与保留策略」一节与 config/xixi.yaml 的 privacy / memory 字段。`;

/** One parse of the console's command line: mode + every switch it understands. */
export interface FieldCliOptions {
  readonly mode: 'serve' | 'self-test' | 'acceptance' | 'help';
  readonly port: number;
  readonly offline: boolean;
  readonly ttsEnabled: boolean;
  readonly useDsh: boolean;
  readonly openBrowser: boolean;
  /** `--data-dir`: the console's own store (self_profile, event log). `null` = default `data/field-test`. */
  readonly dataDir: string | null;
  /** `--presence-data-dir`: the store the presence projection is read from. `null` = default `data`. */
  readonly presenceDataDir: string | null;
}

export interface FieldCliParseResult {
  readonly ok: boolean;
  readonly options?: FieldCliOptions;
  readonly error?: { readonly message: string; readonly hint: string };
}

/** Flags that take the next argv entry as their value. */
const FIELD_CLI_VALUE_FLAGS = ['--port', '--data-dir', '--presence-data-dir'] as const;
/** Flags that are on/off by presence. */
const FIELD_CLI_BOOLEAN_FLAGS = ['--self-test', '--acceptance', '--offline', '--no-tts', '--dsh', '--no-open', '--help', '-h'] as const;

function fieldCliErrorMessage(unknown: string): { message: string; hint: string } {
  return {
    message: `不认识的参数「${unknown}」——现场测试控制台不会忽略它，以免你以为某个开关生效了。`,
    hint:
      `可用参数：${FIELD_CLI_VALUE_FLAGS.join(' <值>、')} <值>、${FIELD_CLI_BOOLEAN_FLAGS.join('、')}。` +
      `完整说明：node scripts/field-test.ts --help`,
  };
}

/**
 * Parse the console's CLI (t68).
 *
 * Why a real parser instead of the old `argv.includes(...)`: every unrecognised argument was
 * dropped on the floor, so `--data-dir data/whatever` **looked** like it worked (the run
 * continued against the default store, exit 0). Two consequences, both silent: a typo in a
 * switch (`--data-dri`) meant the intended store was never used, and a flag the console does
 * not implement at all was reported as "done". Anything unknown is now a usage error with a
 * Chinese explanation and a non-zero exit.
 */
export function parseFieldCliArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): FieldCliParseResult {
  const options = {
    mode: 'serve' as FieldCliOptions['mode'],
    port: Number(env['XIXI_FIELD_PORT'] ?? String(DEFAULT_PORT)),
    offline: false,
    ttsEnabled: true,
    useDsh: false,
    openBrowser: true,
    dataDir: null as string | null,
    presenceDataDir: null as string | null,
  };
  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65535) {
    return {
      ok: false,
      error: {
        message: `XIXI_FIELD_PORT 不是合法端口：${String(env['XIXI_FIELD_PORT'])}`,
        hint: '端口要在 0–65535 之间（0 = 让系统挑一个空闲端口）。',
      },
    };
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if ((FIELD_CLI_VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, error: { message: `${arg} 后面需要一个值。`, hint: `例如：node scripts/field-test.ts ${arg} ${arg === '--port' ? '8793' : 'data/whatever'}` } };
      }
      index += 1;
      if (arg === '--port') {
        const port = Number(value);
        if (!Number.isFinite(port) || port < 0 || port > 65535) {
          return { ok: false, error: { message: `--port 收到了不是端口的值：「${value}」。`, hint: '端口要在 0–65535 之间（0 = 让系统挑一个空闲端口）。' } };
        }
        options.port = port;
      } else if (arg === '--data-dir') {
        options.dataDir = value;
      } else {
        options.presenceDataDir = value;
      }
      continue;
    }
    if ((FIELD_CLI_BOOLEAN_FLAGS as readonly string[]).includes(arg)) {
      if (arg === '--help' || arg === '-h') options.mode = 'help';
      else if (arg === '--self-test' && options.mode === 'serve') options.mode = 'self-test';
      else if (arg === '--acceptance' && options.mode === 'serve') options.mode = 'acceptance';
      else if (arg === '--offline') options.offline = true;
      else if (arg === '--no-tts') options.ttsEnabled = false;
      else if (arg === '--dsh') options.useDsh = true;
      else if (arg === '--no-open') options.openBrowser = false;
      continue;
    }
    return { ok: false, error: fieldCliErrorMessage(arg) };
  }
  return { ok: true, options };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseFieldCliArgs(argv);
  if (!parsed.ok || parsed.options === undefined) {
    // A usage error, not a crash: print it in Chinese and exit non-zero (t68).
    console.error(`现场测试控制台：${parsed.error?.message ?? '参数解析失败'}`);
    console.error(`下一步：${parsed.error?.hint ?? 'node scripts/field-test.ts --help'}`);
    return 2;
  }
  const options = parsed.options;
  if (options.mode === 'help') {
    // Printed *before* anything binds a port on purpose: `--help` must never start
    // the console (it used to start it, which made the flag look broken and could
    // collide with an already-running field test).
    console.log(FIELD_TEST_USAGE);
    return 0;
  }
  const dirNote = (): void => {
    if (options.dataDir !== null || options.presenceDataDir !== null) {
      console.log(
        '提示：--self-test / --acceptance 在独立临时目录里跑（故意不碰你的库），所以 --data-dir / --presence-data-dir 在这个模式下不生效；' +
          '要指定库就直接起控制台（不加 --self-test）。',
      );
    }
  };
  if (options.mode === 'self-test') {
    dirNote();
    console.log('现场测试控制台 · 离线自检（不碰麦克风/摄像头/网络）\n');
    const result = await runSelfTest({ log: (line) => console.log(line) });
    console.log(`\n自检结果：${result.passed} 项通过 / ${result.failed} 项失败`);
    return result.ok ? 0 : 1;
  }
  if (options.mode === 'acceptance') {
    dirNote();
    const report = await runDeviceAcceptance({ log: (line) => console.log(line) });
    console.log('');
    for (const item of report.items) {
      console.log(`${item.verdict === 'pass' ? '通过' : item.verdict === 'fail' ? '失败' : '跳过'}  ${item.order}. ${item.name}｜${item.summary}`);
      console.log(`      下一步：${stripNextPrefix(item.nextAction)}`);
    }
    console.log(`\n总体：${report.overall === 'pass' ? '通过' : '未通过'}｜报告：${report.reportPath ?? '(未落盘)'}`);
    return report.overall === 'pass' ? 0 : 1;
  }
  const handle = await createFieldServer({
    port: options.port,
    offline: options.offline,
    ttsEnabled: options.ttsEnabled,
    useDsh: options.useDsh,
    dataDir: options.dataDir ?? undefined,
    presenceDataDir: options.presenceDataDir ?? undefined,
    log: (line) => console.log(line),
  });
  const config = loadConfig();
  printStartup(handle, { offline: options.offline, ttsEnabled: options.ttsEnabled, policy: retentionPolicy(config), calibration: readCalibration(), modelConfigured: new MimoClient().hasKey });
  if (options.dataDir !== null) console.log(`库（self_profile / 事件日志）：${options.dataDir}（--data-dir）`);
  if (options.presenceDataDir !== null) console.log(`在场投影读的库：${options.presenceDataDir}（--presence-data-dir）`);
  if (options.openBrowser && process.platform === 'win32' && process.stdout.isTTY === true) {
    try {
      spawn('cmd', ['/c', 'start', '', handle.url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {
      /* opening a browser is a convenience, never a requirement */
    }
  }
  await new Promise<void>((resolvePromise) => {
    process.on('SIGINT', () => {
      console.log('\n收到 Ctrl+C：正在关闭现场测试控制台…');
      void handle.close().then(() => resolvePromise());
    });
  });
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      console.error(`现场测试控制台启动失败：${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof ConsoleError && error.hint.length > 0) console.error(`下一步：${error.hint}`);
      process.exitCode = 1;
    });
}
