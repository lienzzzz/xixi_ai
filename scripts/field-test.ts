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
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  DshBrainAdapter,
  FakeBrainAdapter,
  MimoBrainAdapter,
  type ToolRegistry,
  type TurnModelProvider,
} from '@xixi/brain-adapter';
import { CliDshTransport } from '@xixi/brain-dsh';
import {
  ConversationEngine,
  DEFAULT_PROACTIVITY,
  isWithinQuietHours,
  PROACTIVE_MODEL_REASON_LABELS,
  PROACTIVE_SIGNAL_LABELS,
  PROACTIVE_TRIGGERS,
  ProactiveEngine,
  parseProactiveSettings,
  proactiveThreshold,
  readProactiveConsultations,
  readProactiveHistory,
  resolveReplyLimits,
  splitReplyIntoSegments,
  TOPIC_SOURCES,
  TopicEngine,
  type TopicEngineStatus,
  type TopicSource,
  type ProactiveDecider,
  type ProactiveModelReasonCode,
  type ProactiveReasonCode,
  type ProactiveSettings,
  type ProactiveTrigger,
  type ConversationState,
} from '@xixi/conversation';
import { MimoClient, WeatherClient } from '@xixi/model-adapters';
// V0.3 P0-A: the shared runtime lives in `@xixi/runtime` now (pack `04_RUNTIME_CONSOLIDATION.md` §1
// Steps A/B/C). The list below is what this console itself uses; the compatibility block above the
// first declaration re-exports the old public surface for callers that have not migrated yet.
import {
  createResidentRuntime,
  type DroppedSegment,
  type LookOnceTrigger,
  type LookOnceUploadInfo,
  type PluginChainOptions,
  type PresenceView,
  type SpeechSegment,
  type VadResult,
  type XixiResidentRuntime,
} from '@xixi/runtime';
import {
  CANONICAL_DATA_DIR,
  CANONICAL_DATA_DIR_ENV,
  CANONICAL_STORE_ENTRIES,
  openXixiStore,
  resolveCanonicalDataDir,
  SelfModel,
  type XixiConfig,
  type StoredEvent,
  type XixiStore,
} from '@xixi/domain';
// V0.3 P0-B: the perception edge's stdout records are ingested here (single writer, one
// transaction) instead of the Python child opening the store itself.
import { ingestPerceptionLine } from '@xixi/runtime';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, pythonCandidateHint, pythonCandidates, readDotEnv, resolvePython } from './lib/harness.ts';
import { concatWav, readWav, readWavInfo } from './lib/wav.ts';
// Pack Phase 8: the streaming speech pipeline (ClauseChunker → TTS queue → playback clock).
// Shared with `scripts/voice-turn.ts` and asserted by `tests/unit/voice/voice-stream.test.ts`
// so the console, the file-driven entry and the page cannot drift into three behaviours.
import { fourStageLatency, isShortAcknowledgementOnly, SpeechPipeline } from '../services/voice-edge/voice_edge/voice_stream.ts';
// Pack Phase 8 (t11): the page gets the *same* playback rules the offline tests exercise —
// `XIXI_PLAYBACK_JS` is executed for real in `tests/unit/voice/voice-stream.test.ts` (node:vm),
// so what runs in the browser and what the tests pin cannot drift apart.
import { XIXI_PLAYBACK_JS } from '../services/voice-edge/voice_edge/voice_stream.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

export const DEFAULT_PORT = 8792;
export const VOICE_DIR = join(REPO_ROOT, 'data', 'voice-web');
export const CALIBRATION_FILE = join(REPO_ROOT, 'data', 'voice', 'frontend-profile.json');
export const REPORT_DIR = join(REPO_ROOT, 'docs', 'recon');
export const DEFAULT_PYTHON = resolvePython({ venvs: ['voice-pipecat'] });
/** The venv that has sounddevice/pycaw/cv2 (t1's recon venv). */
export const PROBE_PYTHON = resolvePython({ envVar: 'XIXI_PROBE_PYTHON', venvs: ['field-probe'] });
/** The venv that has sounddevice + soundfile + soxr + soundcard. */
export const AUDIO_PYTHON = resolvePython({ envVar: 'XIXI_AUDIO_PYTHON', venvs: ['voice-livekit'] });

// --------------------------------------------------------------------------------------
// One tool chain for every entry point (pack Phase 2) — V0.3 P0-A moved it to the runtime
// --------------------------------------------------------------------------------------

/**
 * `buildToolChain` / `CONVERSATION_SCOPE` now live in `@xixi/runtime` (`tool-runtime.ts`,
 * pack `04_RUNTIME_CONSOLIDATION.md` §1 Step A).
 *
 * This file keeps the compatibility re-export on purpose (pack `01_ARCHITECTURE.md` §3): the
 * console is no longer the owner of the assembly point, but every old
 * `import … from './field-test.ts'` keeps working until its last caller has moved. The symbols
 * are imported **and** re-exported (a bare `export … from` would forward them without creating
 * the local bindings this file needs), so what an old caller gets here is the same declaration
 * the migrated callers get from the package — not a copy that could drift. That identity is
 * asserted in `tests/console/live-entry-tool-chain.test.ts`.
 *
 * V0.3 P2.5-B: **this console no longer calls `buildToolChain` itself** — `createFieldServer` takes
 * its chain from `createResidentRuntime` (see `runtime.toolChain` below). The re-export stays
 * because (a) old callers still import it and (b) that test's expected side is deliberately read
 * through the console's own compatibility surface, which is what keeps this block honest.
 */
import * as runtime from '@xixi/runtime';

// Compatibility surface: the declarations that live in `@xixi/runtime` after V0.3 P0-A, re-exported
// under their old names so an un-migrated caller (`scripts/chat.ts` takes its whole voice/console
// seam list from here) keeps working.
export const CONVERSATION_SCOPE = runtime.CONVERSATION_SCOPE;
export const RuntimeError = runtime.RuntimeError;
export const buildSpeechAudio = runtime.buildSpeechAudio;
export const buildToolChain = runtime.buildToolChain;
export const DEFAULT_LOOP_INTERVAL_MS = runtime.DEFAULT_LOOP_INTERVAL_MS;
export const MIN_LOOP_INTERVAL_MS = runtime.MIN_LOOP_INTERVAL_MS;
export const PROACTIVE_CLOCK_HOOKS = runtime.PROACTIVE_CLOCK_HOOKS;
export const PROACTIVE_DANGLING_AFTER_MINUTES = runtime.PROACTIVE_DANGLING_AFTER_MINUTES;
export const PROACTIVE_GATE_LABELS = runtime.PROACTIVE_GATE_LABELS;
export const PROACTIVE_TRIGGER_LABELS = runtime.PROACTIVE_TRIGGER_LABELS;
export const PROACTIVE_OFFLINE_LINES = runtime.PROACTIVE_OFFLINE_LINES;
export const PROACTIVE_RANDOM_SMALLTALK_CHANCE = runtime.PROACTIVE_RANDOM_SMALLTALK_CHANCE;
export const PROACTIVE_TRIGGERS_WITH_SOURCES = runtime.PROACTIVE_TRIGGERS_WITH_SOURCES;
export const ProactiveLoop = runtime.ProactiveLoop;
export const buildProactiveCandidates = runtime.buildProactiveCandidates;
export const createModelComposer = runtime.createModelComposer;
export const createModelDecider = runtime.createModelDecider;
export const formatClockMinutes = runtime.formatClockMinutes;
export const lastUserTurnAt = runtime.lastUserTurnAt;
export const localDayOf = runtime.localDayOf;
export const parseProactiveDecisionText = runtime.parseProactiveDecisionText;
export const planSpeechSegments = runtime.planSpeechSegments;
export const presenceFreshness = runtime.presenceFreshness;
export const proactiveComposeDirective = runtime.proactiveComposeDirective;
export const proactiveDecideDirective = runtime.proactiveDecideDirective;
export const proactiveGateRows = runtime.proactiveGateRows;
export const readPresence = runtime.readPresence;
export const recentUserTopics = runtime.recentUserTopics;
export const runVad = runtime.runVad;
export const triggerScoreCeiling = runtime.triggerScoreCeiling;
export type ProactiveCandidateContext = runtime.ProactiveCandidateContext;
export type ProactiveCandidatePlan = runtime.ProactiveCandidatePlan;
export type ProactiveComposeInput = runtime.ProactiveComposeInput;
export type ProactiveComposedContent = runtime.ProactiveComposedContent;
export type ProactiveContentSource = runtime.ProactiveContentSource;
export type ProactiveGateRow = runtime.ProactiveGateRow;
export type ProactiveLoopEntry = runtime.ProactiveLoopEntry;
export type SegmentPlanOptions = runtime.SegmentPlanOptions;
export type ToolChainOptions = runtime.ToolChainOptions;
// Declaration-level companions of the re-exported values above: `ProactiveLoop` and `RuntimeError`
// are classes in the package, and an old caller that only has the console's copy needs the *type*
// as well (`field-test.ts` re-exports the constructor as a `const`, which carries no type).
export type ProactiveLoop = runtime.ProactiveLoop;
export type RuntimeError = runtime.RuntimeError;
// `SpeechSegment` / `DroppedSegment` are part of the voice seam this console still shares with
// `scripts/voice-turn.ts`; they are imported from the package above and re-exported here under the
// same name, exactly like the values.
export type { DroppedSegment, SpeechSegment };

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

/**
 * t21 (t12 F2): the plain-language reason a turn ended silent.
 *
 * `MODEL_SILENCE` and `ARTIFACT_ONLY_REPLY` were indistinguishable to every caller before this —
 * one is a choice, the other means her reply was unusable and got removed.
 */
export function explainSilenceReason(reason: 'MODEL_SILENCE' | 'ARTIFACT_ONLY_REPLY' | null): string {
  switch (reason) {
    case 'ARTIFACT_ONLY_REPLY':
      return '整轮只剩工具标记/英文推理这类不能念出来的内容，清洗后没有可说的，所以这轮安静';
    case 'MODEL_SILENCE':
      return '模型自己选择不说话（沉默是一等结果，不是失败）';
    default:
      return '';
  }
}

export function explainReason(reason: string): string {  switch (reason) {
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
  /** t21 (t12 F2): why the turn said nothing — `ARTIFACT_ONLY_REPLY` vs `MODEL_SILENCE` (null = spoke). */
  readonly silenceReason: 'MODEL_SILENCE' | 'ARTIFACT_ONLY_REPLY' | null;
  readonly silenceReasonText: string;
  /** t21: what the hygiene gate removed before anything could be spoken. */
  readonly hygiene: { readonly removedMarkupChars: number; readonly removedMarkdownChars: number; readonly removedReasoningChars: number; readonly emptied: boolean } | null;
  /** t21 (t4 F5): the provider's stop reason — `length` means the reply was cut mid-sentence. */
  readonly finishReason: string | null;
  /** Pack Phase 2: which tool backed this turn, or `null` when none ran. */
  readonly toolName: string | null;
  /** t21: the engine's notices for this turn (`REPLY_HYGIENE` / `REPLY_TRUNCATED` / …). */
  readonly notices: readonly { readonly code: string; readonly detail: string }[];
  readonly audio: string | null;
  readonly at: string;
  readonly privacy: {
    readonly policy: RetentionPolicy;
    readonly speechAudioOnDisk: string | null;
    readonly note: string;
  };
  readonly notes: readonly string[];
  /**
   * Pack Phase 8 (streaming voice): when the caller supplies `speakStream`, the reply is
   * synthesized **clause by clause** and played as it is produced. These fields are absent
   * when it does not, so a console built on the old contract sees exactly what it saw before
   * (and `ttsSegments: 1` in the evidence means the streaming path did not actually run).
   */
  readonly stream?: {
    readonly enabled: boolean;
    /** How many clauses the reply was spoken as; `1` means the whole-reply fallback ran. */
    readonly ttsSegments: number;
    /** Model-clock ms from the first token to the first byte of the **first** clause's audio. */
    readonly firstClauseTextMs: number | null;
    readonly firstClauseAudioMs: number | null;
    readonly clauses: readonly {
      readonly index: number;
      readonly text: string;
      readonly reason: 'sentence' | 'pause' | 'max' | 'flush';
      readonly synthMs: number | null;
      readonly audioMs: number | null;
      readonly durationMs: number;
      readonly bytes: number;
    }[];
    readonly errors: readonly string[];
    /** The four baseline delays (`docs/benchmarks/v01-baseline.md` §3.1), same clock. */
    readonly fourStage: {
      readonly vadEndToAsrFinalMs: number | null;
      readonly asrFinalToFirstTokenMs: number | null;
      readonly firstTokenToFirstAudioMs: number | null;
      readonly totalToFirstAudioMs: number | null;
    };
  } | null;
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
  /**
   * Injected for offline runs: replaces the VAD child process. The voice entry is
   * otherwise the only path in the default gate that needs a Python interpreter.
   */
  readonly vad?: (wavPath: string) => Promise<VadResult>;
  /**
   * Pack Phase 8: the streaming speech sink. When it is supplied the voice turn no longer
   * synthesizes the whole reply once — the model's deltas go through `ClauseChunker`, and each
   * finished clause reaches this callback as soon as it exists, which is what makes 「首音」
   * independent of the reply's length. It returns that clause's WAV, and `SpeechPipeline`
   * measures the timing around it.
   *
   * It **must not** be awaited by the model's streaming callback: the pipeline dispatches it
   * behind the token stream (that is the whole point), so a slow clause never delays the next
   * one's chunking. Omitted by every existing console/test wiring on purpose: without it the
   * old whole-reply path runs unchanged, so no offline gate starts depending on a real TTS.
   */
  readonly speakStream?: (request: {
    readonly text: string;
    readonly signal: AbortSignal;
  }) => Promise<Buffer | Uint8Array>;
  /**
   * t13: the incremental speech seam — every clause, **in playback order**, as soon as its audio
   * exists. A server registers this to write each clause to its response immediately, which is what
   * makes 「边生成边送达」 true on the wire rather than only inside the process. Awaited, so a slow
   * consumer back-pressures the hand-off instead of buffering the whole reply.
   *
   * When it is not supplied the payload still carries the same clauses (text, duration, timing) —
   * only the base64 audio is omitted, because the sink is the only thing that has it.
   */
  readonly onClause?: (clause: {
    readonly index: number;
    readonly text: string;
    readonly audio: string;
    readonly durationMs: number;
    readonly synthMs: number | null;
    readonly audioAtMs: number;
  }) => void | Promise<void>;
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
    throw new RuntimeError('NO_AUDIO', '没有收到音频数据', '按住「按住说」按钮说话，松开后会自动上传');
  }
  const totalStarted = Date.now();
  let raw: Buffer;
  try {
    raw = Buffer.from(body.audioBase64, 'base64');
  } catch {
    throw new RuntimeError('BAD_AUDIO', '音频数据无法解码', '重试一次；仍然失败请刷新页面');
  }
  if (raw.length < 1024) {
    throw new RuntimeError('AUDIO_TOO_SHORT', '录音太短（不足 0.05 秒）', '按住按钮把一整句话说完再松开');
  }
  let info: { durationMs: number; sampleRate: number; channels: number };
  try {
    const parsed = readWavInfo(raw);
    info = { durationMs: Math.round(parsed.durationMs), sampleRate: parsed.sampleRate, channels: parsed.channels };
  } catch {
    throw new RuntimeError('BAD_AUDIO', '上传的不是标准 WAV 录音', '刷新页面重试；若仍失败请把浏览器控制台的报错发给维护者');
  }

  // The whole recording exists only here, only while the VAD needs a path.
  const scratch = mkdtempSync(join(tmpdir(), 'xixi-vad-'));
  const scratchWav = join(scratch, 'capture.wav');
  let vad: VadResult;
  try {
    writeFileSync(scratchWav, raw);
    const vadStarted = Date.now();
    const runVadFor = deps.vad ?? ((wavPath: string): Promise<VadResult> => runVad(deps.python, wavPath));
    vad = await runVadFor(scratchWav);
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
        toolName: null,
        // No speech detected: the model never ran, so there is no model-driven silence and nothing
        // was removed or truncated. The keys are `null` (not absent) because the contract says
        // `string | null` — the page reads them unconditionally.
        silenceReason: null,
        silenceReasonText: explainSilenceReason(null),
        hygiene: null,
        finishReason: null,
        notices: [],
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
        throw new RuntimeError('MISSING_KEY', '缺少 MIMO_API_KEY：语音识别用不了（识别是云端能力）', '把 .env.example 复制成 .env 并填入 MIMO_API_KEY，然后重启现场测试；没有密钥时用 npm run field-test -- --offline 仍可看页面与设备自检', 503);
      }
      throw new RuntimeError('ASR_FAILED', `语音识别失败：${message}`, '若是网络/限流（MiMo 首字 0.3–18s 波动），稍后重试；也可挂代理 HTTPS_PROXY=http://127.0.0.1:7890', 502);
    }
    const asrMs = Date.now() - asrStarted;

    /**
     * Pack Phase 8 (t11): a short acknowledgement is not a turn.
     *
     * 「嗯。」 is the case the VAD was measured to be unable to handle (`docs/design/voice.md` §2:
     * Pipecat's Silero never commits speech for it, and both LiveKit EOU variants call it a
     * *finished* turn). When the father answers her with a nod, the engine must therefore not see
     * a turn: no reply is generated, the conversation keeps its state (she stays in the same
     * exchange), and the next thing he says is still a continuation.
     *
     * `isShortAcknowledgementOnly` owns the text rule; the VAD's voiced duration is the second
     * signal, and it is only used when the span is short enough that no real sentence could have
     * been cut off (the decision itself lives in `services/voice-edge/voice_edge/voice_stream.ts`
     * and is pinned by `tests/unit/voice/voice-stream.test.ts`).
     */
    if (isShortAcknowledgementOnly(transcript, { energyMs: plan.used.reduce((sum, span) => sum + (span.endMs - span.startMs), 0) })) {
      const payload: VoiceTurnPayload = {
        ok: true,
        accepted: false,
        reason: 'ASSENT_ONLY',
        transcript,
        reply: null,
        // `action` stays inside `TurnAction`, and deliberately **not** the value this project
        // reserves for a reply whose whole content is an acknowledgement: that member is still a
        // declared-but-unproduced contract value (see
        // `tests/unit/core/dead-code-truthfulness.test.ts`). What this turn really is — 「他只在
        // 应和」 — is carried by `reason`, which is the field a console renders. The reason code is
        // `ASSENT_ONLY` rather than a name containing that reserved word, so the audit stays
        // meaningful instead of having to allowlist this file.
        action: 'SILENCE',
        actionText: '应和（不打断、不回话）',
        reasonText: '这一句只是「嗯／哦／是啊」一类的应和，不算一轮：西西继续听着，不回话、也不推进会话状态',
        state: deps.engine.state,
        segments: plan.used.map((segment) => ({
          startMs: segment.startMs,
          endMs: segment.endMs,
          durationMs: segment.durationMs ?? Math.round(segment.endMs - segment.startMs),
        })),
        segmentsTotal: vad.segments.length,
        segmentsUsed: plan.used.length,
        droppedSegments: plan.dropped,
        stages: { vadMs, asrMs, llmFirstChunkMs: null, llmTotalMs: null, ttsMs: null, totalMs: Date.now() - totalStarted },
        vadMs,
        asrMs,
        firstTokenMs: null,
        llmMs: null,
        ttsMs: null,
        latencyMs: null,
        totalMs: Date.now() - totalStarted,
        model: null,
        toolName: null,
        silenceReason: null,
        silenceReasonText: '不是沉默：他只是在应和',
        hygiene: null,
        finishReason: null,
        notices: [],
        audio: null,
        stream: null,
        at: new Date().toISOString(),
        privacy: {
          policy: deps.policy,
          speechAudioOnDisk: null,
          note: '应和不进模型：这段录音只用于识别，没有落盘、没有送去对话',
        },
        notes: [...notes, '应和判定：短促的「嗯／哦／是啊」不结束你这一轮，西西继续听；想让她回话就说一句完整的话'],
      };
      deps.log?.(`[voice] acknowledgement only ("${transcript}"): no turn taken, still listening`);
      return payload;
    }

    const chunks: string[] = [];
    let firstChunkAt: number | null = null;
    /** t21 (t12 F2): the engine's notices, so the page can say *why* a turn said nothing. */
    const turnNotices: { readonly code: string; readonly detail: string }[] = [];
    const llmStarted = Date.now();

    // Pack Phase 8: the streaming speech sink. `SpeechPipeline.push()` never blocks the model
    // stream (synthesis runs behind it), so clause 1 is on its way to the speaker while the
    // rest of the reply is still being generated. Without `deps.speakStream` nothing changes.
    const abortController = new AbortController();
    const speakStream = deps.speakStream;
    const pipeline =
      speakStream === undefined || !deps.ttsEnabled
        ? null
        : new SpeechPipeline(
            (text) => speakStream({ text, signal: abortController.signal }),
            (wav) => readWavInfo(Buffer.from(wav)).durationMs,
          );
    // t13: the streaming seam. When the caller supplies `onClause`, every clause is handed over the
    // moment its audio exists (in playback order), so a server can put it on the wire without
    // waiting for the reply — and the payload below then carries only counts and timings.
    if (pipeline !== null && deps.onClause !== undefined) {
      const onClause = deps.onClause;
      pipeline.onClause((clause) =>
        onClause({
          index: clause.index,
          text: clause.text,
          audio: Buffer.from(clause.wav).toString('base64'),
          durationMs: clause.durationMs,
          synthMs: clause.synthMs,
          audioAtMs: clause.atMs - llmStarted,
        }),
      );
    }

    const turn = await deps.engine.respond(
      { sessionId: deps.currentSessionId(), text: transcript, addressed: deps.engine.state === 'IDLE' },
      {
        onTextChunk: (chunk) => {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          chunks.push(chunk);
          pipeline?.push(chunk);
        },
        onNotice: (notice) => void turnNotices.push({ code: notice.code, detail: notice.detail }),
      },
    );
    const llmMs = Date.now() - llmStarted;
    const firstTokenMs = firstChunkAt === null ? null : firstChunkAt - llmStarted;
    const shouldSpeak = deps.ttsEnabled && body.speak !== false && turn.action === 'SPEAK' && turn.text !== null;
    // No TTS this turn (朗读 off, or she chose silence): the pipeline is not flushed at all, so
    // a wired sink is never called — a "would have been spoken" synthesis would be both a cost
    // and a lie in the payload.
    const spoken = pipeline === null || !shouldSpeak ? [] : await pipeline.flush();
    const firstClauseTextMs = pipeline?.clauses[0]?.textAtMs === undefined ? null : pipeline.clauses[0].textAtMs - llmStarted;
    const firstClauseAudioMs = pipeline?.clauses[0]?.audioAtMs === undefined || pipeline.clauses[0].audioAtMs === null
      ? null
      : pipeline.clauses[0].audioAtMs - llmStarted;

    let audio: string | null = null;
    let ttsMs: number | null = null;
    if (shouldSpeak && turn.text !== null) {
      if (pipeline !== null && spoken.length > 0) {
        // t13: when the caller registered the incremental seam (`onClause`) it already received
        // every clause's audio, so the turn payload deliberately carries **no** blob: the page plays
        // from the seam, and the turn stays counts-and-timings. Without a seam the old contract is
        // unchanged — one stitched WAV — so a caller that only consumes the single-object shape
        // (the typed-text route, a script) keeps working.
        if (deps.onClause === undefined) {
          const stitched = concatWav(spoken.map((chunk) => Buffer.from(chunk.wav)), 0);
          audio = stitched.toString('base64');
        }
        ttsMs = firstClauseAudioMs;
      } else {
        // The streaming path produced nothing (every clause failed, or the whole reply arrived
        // as one un-chunked tail): fall back to the whole-reply call rather than saying nothing.
        const ttsStarted = Date.now();
        audio = (await deps.client.synthesize(turn.text)).toString('base64');
        ttsMs = Date.now() - ttsStarted;
      }
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
      // t21: the three things a reader needs to tell "she chose silence" from "her reply was
      // unusable" and from "the provider cut her off mid-sentence".
      silenceReason: turn.silenceReason,
      silenceReasonText: explainSilenceReason(turn.silenceReason),
      hygiene: turn.hygiene,
      finishReason: turn.finishReason,
      toolName: turn.toolName,
      notices: turnNotices,
      audio,
      stream:
        pipeline === null
          ? null
          : {
              enabled: true,
              ttsSegments: pipeline.clauses.length,
              firstClauseTextMs,
              firstClauseAudioMs,
              clauses: pipeline.clauses.map((clause) => {
                const synthesized = spoken.find((chunk) => chunk.index === clause.index);
                return {
                  index: clause.index,
                  text: clause.text,
                  reason: clause.reason,
                  synthMs: clause.synthMs,
                  audioMs: clause.audioAtMs === null ? null : clause.audioAtMs - llmStarted,
                  durationMs: synthesized?.durationMs ?? 0,
                  bytes: clause.bytes,
                };
              }),
              errors: pipeline.errors,
              fourStage: fourStageLatency({
                endpointDelayMs: plan.used[plan.used.length - 1]?.endpointDelayMs ?? null,
                asrMs,
                firstTokenMs,
                firstAudioMs: pipeline.clauses[0]?.audioAtMs === null || pipeline.clauses[0]?.audioAtMs === undefined
                  ? null
                  : pipeline.clauses[0].audioAtMs - (llmStarted + (firstTokenMs ?? 0)),
              }),
            },
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
 * The on-machine probe, written next to the console's own store at runtime (`data/xixi/device-probe.py`
 * by default — it follows `--data-dir` / `XIXI_DATA_DIR`).
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
"""现场测试控制台的设备探测程序（由 scripts/field-test.ts 运行时生成在控制台自己的库目录里，
默认 data/xixi/，随 --data-dir / XIXI_DATA_DIR 走）。

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
        reject(new RuntimeError('PYTHON_MISSING', `找不到 Python：${python}`, 'AGENTS.md §7：语音/视觉一律用 .venvs 里的 Python（voice-pipecat / voice-livekit / field-probe），不要用系统 Python 3.14'));
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
        finish(() => reject(new RuntimeError('PROBE_TIMEOUT', `设备探测（${mode}）超过 120 秒没有返回`, '设备可能被别的程序占用；关掉占用摄像头的程序后重跑')));
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
        finish(() => reject(new RuntimeError('PROBE_FAILED', `设备探测进程起不来：${cause.message}`, '检查 venv 与依赖')));
      });
      child.on('close', (code) => {
        finish(() => {
          const line = stdout.trim().split(/\r?\n/).filter((item) => item.trim().startsWith('{')).pop();
          if (line === undefined) {
            reject(new RuntimeError('PROBE_FAILED', `设备探测没有输出结果（退出码 ${code}）：${stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(-240)}`, '确认 venv 里装了 numpy/sounddevice/pycaw（field-probe）或 soundfile/soxr/soundcard（voice-livekit）'));
            return;
          }
          try {
            resolve(JSON.parse(line) as Record<string, unknown>);
          } catch (cause) {
            reject(new RuntimeError('PROBE_FAILED', `设备探测的输出无法解析：${cause instanceof Error ? cause.message : String(cause)}`, '重跑一次；仍失败请贴 stderr'));
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
  /** t21 (t12 F2): why this turn was silent — the two cases must not look alike in the page. */
  readonly silenceReasonText?: string;
  /** t21: what the hygiene gate removed before anything could be spoken. */
  readonly hygiene?: { readonly removedMarkupChars: number; readonly removedMarkdownChars: number; readonly removedReasoningChars: number; readonly emptied: boolean } | null;
  /** t21 (t4 F5): the provider's stop reason; `length` means the reply was cut mid-sentence. */
  readonly finishReason?: string | null;
  /** Pack Phase 2: the tool that backed this turn (`xixi_get_weather`…), when one ran. */
  readonly toolName?: string | null;
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
  /** Test seam for the live camera loop (t78): the real one spawns the perception edge. */
  readonly liveRunner?: LiveCameraRunner;
  /** Test seam for the brain (t88): lets a test drive 「看一眼」 without a key or a network. */
  readonly adapterOverride?: TurnModelProvider;
  /**
   * Test/offline seams for the voice entry (pack Phase 2): the VAD is the only Python
   * dependency on that path, and the offline ASR double returns a fixed sentence, so
   * a test that wants a *real* transcript supplies both.
   */
  readonly asrOverride?: (audio: Buffer) => Promise<string>;
  readonly vadOverride?: (wavPath: string) => Promise<VadResult>;
  /** Tool data sources (weather/news/reminders), injectable so an offline run stays offline. */
  readonly toolOverrides?: ToolChainOptions;
  /**
   * 插件层（V0.3 P2.5-B/H）：控制台**默认为空**。`XixiConfig` 自 P2.5-H 起**有** `plugins` 段了
   * （`packages/domain/src/plugin-settings.ts` 的 `parsePluginSettings`），装配点的
   * `pluginChainOptions()` 把「配置声明了 news / MCP / directories 就由配置说了算、没声明才用这里给的」
   * 收在一处；所以这个接缝是**测试与「配置没声明时」的注入点**，不再是「把插件交给入口的唯一来源」。
   * `inline`、`news`、`mcpServers`、`pluginDirectory` 都从这里进，装配点照常跑九步生命周期。
   */
  readonly plugins?: PluginChainOptions;
  /**
   * Test seam for the open-thread clock (the same shape `TopicEngine` already takes).
   *
   * The unfinished-topic state machine is time-driven: a thread expires `followupWindowHours`
   * (config default 48 h) after it was spoken, so a test that seeds a fixed sentence and lets
   * the drill run against the wall clock turns into a **time bomb** — it passes on the day it
   * was written and fails two days later. Injecting the clock makes that gate deterministic.
   * Only the open-thread paths read it; everything else keeps the real clock.
   */
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface FieldServerHandle {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  readonly turns: readonly ConsoleTurn[];
  /**
   * V0.3 P2.5-B：这个控制台用的常驻运行时（`createResidentRuntime` 的返回值）。
   *
   * 暴露它是因为页面之外的维护者/测试需要看**真实的装配状态**：链是不是就是 `runtime.plugins.registry`、
   * 插件工具到底挂上没挂上（`toolChain.names()`）、审批是不是这个宿主（`runtime.approvals`）、
   * 提醒调度器上还有几条到点的（`runtime.reminders`）。`close()` 之后它已关停、链已清空。
   */
  readonly runtime: XixiResidentRuntime;
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
  /**
   * V0.3 P0-B: the console's own store is the household canonical one (`XIXI_DATA_DIR`, else
   * `data/xixi`) unless `--data-dir` says otherwise. The previous default (`data/field-test`) made
   * the console a second Xixi: a personality set here never reached `npm run chat`, which the audit
   * (§3.5) and the page's own 「四个入口各用不同的库」 note both called out.
   */
  const dataDir = options.dataDir ?? resolveCanonicalDataDir({ cwd: REPO_ROOT });
  const store = openXixiStore({ dataDir });
  store.seedSelfProfile(config.personality.base);
  const policy = retentionPolicy(config);
  const pruned = options.autoPrune === false ? { dir: voiceDir, removed: [], kept: 0, bytesFreed: 0 } : pruneVoiceDir(voiceDir, policy);
  if (pruned.removed.length > 0) {
    log(`[privacy] 按保留策略清理 ${pruned.removed.length} 个文件（${Math.round(pruned.bytesFreed / 1024)} KB）：${pruned.removed.map((item) => item.name).join('、')}`);
  }
  store.recordHealth('field-test', 'ok', `console started (offline=${offline})`);

  /**
   * V0.3 P2.5-B：控制台不再自己拼一套运行时。
   *
   * `createResidentRuntime` 一次给出全部：工具链、插件内核（MCP 与 news 都从它进来）、审批宿主、
   * durable 提醒 sink 与调度器、一轮之后的记忆提取，以及**提示词权威校验过的** `ConversationEngine`。
   * 控制台从这里取两样东西就够了：
   *
   *   * `runtime.toolChain` —— 文字与语音共用的那条链（与 `runtime.plugins.registry` 是同一个对象），
   *     两个适配器都拿它构造，所以「语音与文字同一条链」现在不是控制台自己保证的，而是装配点给的；
   *   * `runtime.conversation` —— 引擎；`afterTurn` 由装配点内部接到共享的提取器上（此前是控制台
   *     自己 new 一个 `TurnMemoryExtractor`，也就是全仓最后一个「自己拼一套」的位置）。
   *
   * 插件/MCP/news 的工具是在 `start()` 里挂进这条链的，所以下面构造完立刻启动（见 `await runtime.start()`）。
   * `options.plugins` 是这个入口的注入点（测试用），而**生产路径的插件来源是配置**：`XixiConfig` 自
   * P2.5-H 起有 `plugins` 段，装配点的 `pluginChainOptions()` 按「配置声明了就由配置说了算、没声明才用
   * 这里给的」合并（`inline` / `news` / `mcpServers` / `pluginDirectory`）。
   */
  const runtime = createResidentRuntime({
    config,
    store,
    ...(options.toolOverrides ?? {}),
    ...(options.plugins ?? {}),
    // 注入的时钟走**同一个**接缝：工具（`xixi_get_current_time` / 提醒解析）与装配点自己的审批/提醒
    // 宿主读的是同一只钟，测试里不会出现「话题按固定时间走、工具按真实时间走」这种两套时间。
    ...(options.now === undefined ? {} : { now: options.now }),
    onToolCall: (record) => log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`),
    conversation: { turnTimeoutMs: 90_000 },
    // 长期记忆与反馈学习（pack Phase 4）：一轮说完之后**异步**提取，不阻塞回复。`SelfModel` 的三层
    // （基础+学习+会话覆盖）由 `store.selfProfile()` 统一读出来，所以学习到的偏移会自动影响提示词、
    // FSM 窗口与主动引擎的阈值 —— 面板上显示的人格也已经是有效值。
    memory: { onError: (error) => log(`[memory] 后台提取出错（不影响这一轮）：${error instanceof Error ? error.message : String(error)}`) },
    log,
    /**
     * 模型仍是控制台的决定（直连 MiMo / DSH / 离线替身 / 测试注入），装配点只把**它自己那条链**递进来：
     * 适配器每一轮从同一个注册表取工具定义，所以 `start()` 之后挂上的插件工具能被看见。
     */
    model: ({ toolChain }) => buildAdapter(toolChain),
  });
  const engineTools = runtime.toolChain;
  const engine = runtime.conversation;

  function buildAdapter(registry: ToolRegistry): TurnModelProvider {
    if (options.adapterOverride !== undefined) return options.adapterOverride;
    if (offline) return new FakeBrainAdapter({ registry, scope: CONVERSATION_SCOPE });
    if (!options.useDsh) {
      return new MimoBrainAdapter({
        client,
        maxCompletionTokens: 400,
        registry,
        scope: CONVERSATION_SCOPE,
        timezone: config.identity.timezone,
        // t21: the reply-hygiene filter needs the deployment language to tell English reasoning from
        // speech (t12 F1) — the same wiring the trial page uses.
        language: config.identity.language,
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

  /**
   * 插件/MCP/news 的工具**只在 `start()` 里**进入工具链（`buildPluginRuntime.start()` 跑完九步生命周期
   * 再 `mountPluginTools`），所以第一次模型调用之前必须启动；启动失败就如实抛出去，绝不静默降级成
   * 「这个部署没有插件」—— 那是两件事。半启动的内核（MCP 可能已经连上）在抛出之前收掉，库也一并关掉。
   */
  try {
    await runtime.start();
  } catch (error) {
    await runtime.stop().catch(() => undefined);
    store.close();
    throw error;
  }
  let session = store.latestSession() ?? store.createSession();

  // -------------------------------------------------- proactive card state (t42)
  // The engine is rebuilt per consideration with whatever is in the snapshot, so a saved knob
  // takes effect on the very next drill (no restart, no cache to invalidate).
  let proactiveSnapshot = restoreProactiveSettings(store, config.proactive as unknown as Record<string, unknown>);
  if (proactiveSnapshot.source === 'console') {
    log(`[proactive] 已从审计记录恢复设置（${proactiveSnapshot.updatedAt ?? '?'}）：${proactiveSnapshot.settings.enabled ? '允许主动开口' : '已关闭'}`);
  }
  const serverNow = options.now ?? ((): Date => new Date());
  /**
   * 话题引擎（pack Phase 3）：未完话题的提取与追问候选。
   *
   * 它读的是用户自己的轮次与话题日志，**不阻塞任何一次回复**：提取与收口都发生在考虑循环的
   * 下一次 tick（《方案》§11.1 的异步提取）。`config.open_threads` 段控制窗口与次数上限。
   */
  const topicEngine = new TopicEngine({ store, config: config.openThreads, clock: serverNow });
  /**
   * 面板状态：**只读**（pack v03-preflight ②）。
   *
   * 它以前会顺手 `topicEngine.reconcile(at)`（「先与日志对齐，再报告」），于是
   * `GET /api/field/proactive` —— 一个刷新按钮就会打的读接口 —— 每次都在写库（提取话题、收口、作废），
   * 并且与常驻考虑循环的 tick 并发跑同一个投影。**读接口不写库**：对齐只发生在写路径上
   * （考虑循环的每个 tick、以及会写库的 POST，见 `POST /api/field/proactive/drill`），
   * 面板读到的就是投影当前的真实样子 —— 落后一步也是真话，好过「看一次多一条记录」。
   */
  function proactivePayload(): ProactiveConsoleState & { readonly ok: true } {
    const at = new Date();
    return {
      ok: true,
      ...proactiveConsoleState({
        store,
        settings: proactiveSnapshot.settings,
        source: proactiveSnapshot.source,
        updatedAt: proactiveSnapshot.updatedAt,
        changes: proactiveSnapshot.changes,
        now: at,
        personality: store.selfProfile(),
        topicEngine,
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
  // 朗读 is now a runtime switch (t78): the page can turn TTS off without restarting the console,
  // and both the reply path and the proactive loop read it at the moment they speak.
  let ttsOn = ttsEnabled;
  const loopSynthesizeProvider = (): ((text: string) => Promise<Buffer>) | undefined =>
    ttsOn && client.hasKey ? async (text: string): Promise<Buffer> => await client.synthesize(text) : undefined;
  /** The last presence reading's freshness (t98) — the page shows *why* 「有人到达」 is missing. */
  let lastPresenceFreshness: ReturnType<typeof presenceFreshness> | null = null;
  const proactiveLoop = new ProactiveLoop({
    store,
    readSettings: () => proactiveSnapshot.settings,
    readState: () => engine.state,
    readInFlightTurn: () => turnInFlight,
    readProactivity: () => effectiveProactivity(store.selfProfile()),
    readPresence: async () => {
      const view = await readPresence({ store: getPresenceStore() });
      // `stale`/`ttlSeconds` travel with the reading: without them a leftover `present: true` row
      // would look like someone walking in (t98).
      const reading = view === null ? null : { present: view.present, updatedAt: view.updatedAt, source: view.source, stale: view.stale, ttlSeconds: view.ttlSeconds };
      lastPresenceFreshness = presenceFreshness(reading, new Date());
      return reading;
    },
    readLastUserTurnAt: () => lastUserTurnAt(store, session.sessionId),
    readRecentUserTopics: () => recentUserTopics(store, session.sessionId),
    /**
     * pack Phase 3：先对齐（提取新话题、把已说出口的标成 offered、按用户的回答收口），
     * 再取「现在该追问的」。两步都幂等，所以每个 tick 都跑一遍是安全的。
     */
    readOpenThreads: () => {
      const at = serverNow();
      const reconciled = topicEngine.reconcile(at);
      if (reconciled.created.length > 0) {
        log(`[topic] 记下 ${reconciled.created.length} 件未完的事：${reconciled.created.map((thread) => thread.summary).join('｜')}`);
      }
      if (reconciled.settled.length > 0) {
        log(`[topic] 收口 ${reconciled.settled.length} 件：${reconciled.settled.map((thread) => `${thread.summary} → ${thread.status}`).join('｜')}`);
      }
      return topicEngine.followUps(at);
    },
    readSessionId: () => session.sessionId,
    replyLimits: config.reply,
    synthesizeProvider: loopSynthesizeProvider,
    // Content is composed through the same prompt + adapter path a reply uses (tools included),
    // and only from inside the delivery seam — see `ProactiveLoopOptions.compose`.
    compose: createModelComposer({
      engine,
      sessionId: () => session.sessionId,
      available: !offline && client.hasKey,
      recentLines: () => proactiveLoop.spokenLines(),
      // t88: 自主看 is opt-in. With the switch off this returns null and the call is text-only.
      vision: () => {
        if (!vision.autoLook) return null;
        const image = liveSensors.imageInput(lookMaxWidth);
        if ('refused' in image) return null;
        return { images: [{ mediaType: image.mediaType, base64: image.base64 }], info: { width: image.width, height: image.height, bytes: image.bytes }, note: '主动开口时附带了 1 张静帧' };
      },
      onUpload: (info) => {
        const record = recordLookOnce(store, { ...info, question: null, outcome: 'auto-look' });
        log(`[vision] 自主看上传一张静帧（${info.width}x${info.height}，${Math.round(info.bytes / 1024)}KB，审计 #${record.sequence}）`);
      },
      log,
    }),
    /**
     * P5 读空气 (ADR-0011): above the hard floor the model decides whether to open its mouth.
     * Only reached for candidates the social budget already recommends; the consultation is
     * recorded (`model_consulted`) and charged to the daily budget.
     */
    decide: createModelDecider({
      engine,
      sessionId: () => session.sessionId,
      available: !offline && client.hasKey,
      log,
    }),
    log,
  });

  // -------------------------------------------------- live camera + 「启用」 (t78)
  let liveCameraIndex = 0;
  let liveSource: 'camera' | 'synthetic' = 'camera';
  let liveScenario: string | null = 'person-arrives-moves-leaves';
  const liveSensors = new LiveSensors({
    runner: options.liveRunner ?? createPerceptionLiveRunner({ python: () => resolvePerceptionPython(log), serviceDir: PERCEPTION_SERVICE_DIR, repoRoot: REPO_ROOT, log }),
    // V0.3 P0-B: the child prints presence events; **this** is where they enter the canonical store,
    // through the domain's single-transaction append. The child gets no `--db` any more.
    ingest: (line) => {
      const store = getPresenceStore();
      if (store === undefined) {
        log('[perception] 在场投影的库打不开，这条在场事件没有入库（见上面的 [presence] 一行）');
        return;
      }
      ingestPerceptionLine(line, { store, log });
    },
    cameraIndex: () => liveCameraIndex,
    log,
  });
  function livePayload(): Record<string, unknown> {
    return {
      status: liveSensors.status(),
      frame: liveSensors.frame(),
      // t103: 「拿不到画面」 must be visible as its own fact, never as 「没人」.
      cameraProblem: liveSensors.cameraProblem(),
      loop: proactiveLoop.status(),
      vision: visionPayload(),
      ttsEnabled: ttsOn,
      ttsAvailable: ttsOn && client.hasKey,
      cameraIndex: liveCameraIndex,
      source: liveSource,
      scenario: liveScenario,
      privacy: LIVE_PRIVACY_NOTE,
      hint: '「启用」= 摄像头在场检测 + 常驻主动循环立刻先考虑一次；「停用」会把子进程一起停掉。',
    };
  }
  function loopPayload(cursor: number): Record<string, unknown> {
    const since = proactiveLoop.messagesSince(Number.isFinite(cursor) ? cursor : 0);
    return {
      ok: true,
      status: proactiveLoop.status(),
      cursor: since.cursor,
      entries: since.entries,
      minIntervalMs: MIN_LOOP_INTERVAL_MS,
      defaultIntervalMs: DEFAULT_LOOP_INTERVAL_MS,
      // t98: whether 「有人到达」 is even possible right now, and why not when it is not.
      presence: lastPresenceFreshness === null ? null : { ...lastPresenceFreshness },
      tts: {
        available: loopSynthesizeProvider() !== undefined,
        note:
          loopSynthesizeProvider() !== undefined
            ? '放行时会用真实 TTS 逐段合成，并在页面上逐条播出来。'
            : '当前没有可用密钥或朗读被关掉：放行时只显示文字，不会发声（这会在每条记录里写明）。',
      },
    };
  }

  /**
   * Pack Phase 8: the streaming TTS sink this console really installs, or `null` when it cannot
   * synthesize at all. `ttsSegmented` and the note the page renders are derived from **this
   * value**, not from a constant: 「这台控制台到底怎么合成」 is a fact about the wiring, and the
   * page must not claim a granularity the console is not running (t42's rule, kept under the
   * change that flipped it).
   *
   * The sink returns the WAV for one clause, which is exactly what `handleVoiceTurn`'s
   * `SpeechPipeline` expects; `null` here (no key, or 朗读 off) is reported by the payload as
   * `stream: null` plus no audio, never as silence that looks like success.
   */
  const streamSpeak: VoiceDeps['speakStream'] =
    ttsOn && client.hasKey
      ? async ({ text }) => Buffer.from(await client.synthesize(text))
      : undefined;

  const deps: VoiceDeps = {
    python: DEFAULT_PYTHON,
    voiceDir,
    client,
    engine,
    currentSessionId: () => session.sessionId,
    ttsEnabled,
    policy,
    asr: options.asrOverride ?? (offline ? async (audio: Buffer): Promise<string> => `（离线自检）收到 ${audio.length} 字节语音` : undefined),
    ...(options.vadOverride === undefined ? {} : { vad: options.vadOverride }),
    ...(streamSpeak === undefined ? {} : { speakStream: streamSpeak }),
    log,
  };

  // Three states, kept apart on purpose: `undefined` = not opened yet, `null` = opening failed,
  // otherwise the open store. The *type* is `XixiStore` (not `unknown`) because the ingest seam below
  // hands this straight to `ingestPerceptionLine`, which needs `appendPresenceEvent`.
  let presenceStore: XixiStore | null | undefined;
  /**
   * Where the presence projection is read from (V0.3 P0-B).
   *
   * Default: **the same store as everything else** (`dataDir`, i.e. the canonical store). Before
   * P0-B this defaulted to `data/`, which is a *different* database from the console's own — so the
   * console read presence out of one file while Python appended to that same file and the console's
   * history/personality lived in another (§3.5, and the two-store note in `ACTUAL_RUNTIME_MAP.md`
   * §1「perception DB」). `--presence-data-dir` can still point somewhere else for a probe, but the
   * default is now 「one Xixi」: what the camera writes is what the page reads.
   */
  const presenceDataDir = options.presenceDataDir ?? dataDir;
  function getPresenceStore(): XixiStore | undefined {
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
  // V0.3 P0-B: the probe script is a *generated helper*, not data — it goes beside whichever store
  // this console is really using (`--data-dir` / `XIXI_DATA_DIR` / canonical), so the path in the log
  // never claims a directory the console does not write to.
  const probePath = join(dataDir, 'device-probe.py');
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
      if (probe.ok === false) throw new RuntimeError('ENDPOINT_READ_FAILED', `读不到 Windows 端点状态：${String(probe.error ?? '未知原因')}`, '确认 .venvs/field-probe 里有 pycaw + comtypes；没有它也能跑麦克风/扬声器自检，只是看不到系统读数');
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
          message: error instanceof RuntimeError ? error.message : `读不到 Windows 端点状态：${probeError(error)}`,
          hint: error instanceof RuntimeError ? error.hint : '确认 .venvs/field-probe 里有 pycaw + comtypes',
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
    const presenceView = await readPresence({ store: getPresenceStore() });
    const cameraProblem = liveSensors.cameraProblem();
    // t103: while the camera cannot deliver a picture, the presence card must not read as a normal
    // 「没人在场」 — the honest answer is 「未知」, with the reason attached. The projection's own
    // fields (`present`, `stale`, `updatedAt`) are left untouched, so nothing is hidden.
    const presence =
      cameraProblem === null
        ? presenceView
        : {
            ...presenceView,
            mode: 'camera-problem' as const,
            text: `未知（摄像头交不出画面：${cameraProblem.kind}）`,
            note: `${cameraProblem.title}｜${cameraProblem.note}`,
            overriddenByCameraProblem: true,
          };
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
      database: { path: dataDir, presencePath: presenceDataDir, entries: XIXI_DB_ENTRIES, note: storeNoteText() },
      segmentPlayback: (() => {
        // Derived, not asserted: the page's sentence about granularity is a function of the sink
        // this console really installed (`streamSpeak` above, which requires a key) plus the
        // runtime 朗读 switch. No key → the page says 「只有文字、没有声音」, not 「流式」.
        const mode: 'streaming' | 'whole-reply' | 'none' = !ttsOn
          ? 'none'
          : streamSpeak === undefined
            ? (client.hasKey ? 'whole-reply' : 'none')
            : 'streaming';
        return { textSegmented: true, ttsSegmented: mode === 'streaming', mode, note: segmentTtsNote(mode) };
      })(),
      model: { configured: client.hasKey, offline },
      // V0.3 P2.5-B: 这条链现在由常驻运行时给出（`runtime.plugins.registry`），
      // 控制台的状态页因此能说出「模型看得见哪些工具、上限几轮」—— 面板读的是装配点的事实。
      tools: {
        scope: CONVERSATION_SCOPE,
        maxRounds: engineTools.maxToolRounds,
        names: engineTools.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name),
        note: '文字与语音共用这一条工具链；权限与轮数在模型之外判定（模型看不到被拒绝的工具）。插件/MCP/news 的工具在启动时常驻运行时挂进同一条链。',
      },
      calibration,
      presence,
      recent: turns,
      ttsEnabled: ttsOn,
      ttsAvailable: ttsOn && client.hasKey,
      live: liveSensors.status(),
      cameraProblem,
      liveLoop: proactiveLoop.status(),
      vision: visionPayload(),
      reportDir,
    };
  }

  // -------------------------------------------------- 「看一眼」: the manual still-frame path (t88)
  const visionConfig = ((config as unknown as Record<string, unknown>)['vision'] ?? {}) as Record<string, unknown>;
  /** The size cap comes from `config/xixi.example.yaml` (`vision.max_width_px`), default 480. */
  const lookMaxWidth = typeof visionConfig['max_width_px'] === 'number' ? visionConfig['max_width_px'] : LOOK_ONCE_MAX_WIDTH;
  const configuredAutoLook = typeof visionConfig['auto_look'] === 'boolean' ? visionConfig['auto_look'] : VISION_AUTO_LOOK_DEFAULT;
  let vision = restoreVisionSettings(store, configuredAutoLook);
  if (vision.source === 'console') log(`[vision] 从审计记录恢复「允许西西自己看」=${vision.autoLook}（${vision.updatedAt ?? '?'}）`);

  function visionPayload(): Record<string, unknown> {
    const history = lookOnceHistory(store, 10);
    return {
      autoLookEnabled: vision.autoLook,
      autoLookSource: vision.source,
      maxWidthPx: lookMaxWidth,
      uploads: history.length,
      lastUpload: history[0] ?? null,
      history,
      historyNote: '每条只记时间/大小/触发源/结果，没有图像，也没有落盘。',
      privacyNote: VISION_NOTICE,
      canLook: !offline && !options.useDsh && client.hasKey,
      blockers: [
        ...(offline ? ['--offline：替身不看图（它会忽略图片），所以这里不会真的「看见」'] : []),
        ...(options.useDsh ? ['--dsh：DSH 路径一轮压成一个 task 字符串，发不了图（会被明确拒绝）'] : []),
        ...(!client.hasKey ? ['没有 MIMO_API_KEY：无法真的调用模型看图'] : []),
      ],
      frame: liveSensors.frame() === null ? null : { width: liveSensors.frame()?.width ?? 0, height: liveSensors.frame()?.height ?? 0, bytes: liveSensors.frame()?.jpegBytes ?? 0 },
    };
  }

  /**
   * One look: attach the newest frame to *one* model call and turn the answer into a normal turn.
   *
   * It goes through the same pieces a typed turn uses — the engine's prompt assembler (identity,
   * hard policy, personality, world state, recent history) and the same adapter (tools included) —
   * but with `images` on the adapter call, because the conversation engine's `respond` has no image
   * seam yet (packages/ is out of scope for this task). The two turns are written to the log, so the
   * right column and the next user turn both see them; the audit row never contains the picture.
   */
  async function lookOnce(trigger: LookOnceTrigger, questionInput?: string): Promise<Record<string, unknown>> {
    const question = questionInput === undefined || questionInput.trim().length === 0 ? LOOK_ONCE_DEFAULT_QUESTION : questionInput.trim();
    const image = liveSensors.imageInput(lookMaxWidth);
    if ('refused' in image) {
      return { ok: false, error: { code: 'NO_FRAME', message: image.refused, hint: '先点左栏的「启用」，等画面出现后再按「看一眼」。' } };
    }
    // An injected adapter (tests) is a deliberate choice, so it skips the "can this brain really
    // look" checks — but the *real* paths keep them, because a look that cannot look must say so.
    const injected = options.adapterOverride !== undefined;
    if (!injected && offline) {
      return {
        ok: false,
        error: {
          code: 'OFFLINE',
          message: '当前是 --offline：替身适配器不看图（它会忽略图片），所以「看一眼」不会真的看到东西。',
          hint: '去掉 --offline（需要有 MIMO_API_KEY）再试，这样画面才会真的发给模型。',
        },
      };
    }
    if (!injected && options.useDsh) {
      return {
        ok: false,
        error: {
          code: 'DSH_NO_IMAGES',
          message: '--dsh 路径发不了图：DSH 适配器会明确拒绝带图的请求（宁可拒绝，也不假装看见了）。',
          hint: '用直连 MiMo 的控制台（不要 --dsh）按「看一眼」；查资料/工具调用仍可用 --dsh。',
        },
      };
    }
    if (!injected && !client.hasKey) {
      return { ok: false, error: { code: 'NO_KEY', message: '没有 MIMO_API_KEY：无法把画面发给模型。', hint: '配置 .env.local 里的 MIMO_API_KEY 后重启控制台。' } };
    }
    const at = new Date();
    const startedAt = Date.now();
    let reply: string | null = null;
    let action = 'SILENCE';
    let firstTokenMs: number | null = null;
    let provider = engine.adapter.provider;
    let model = engine.adapter.describe().model;
    let segments: readonly string[] = [];
    let gapMs = 0;
    let audio: (string | null)[] | null = null;
    let audioNote: string | null = null;
    try {
      // The whole turn goes through the engine (t88, per t91's review): the frame travels
      // console → `engine.respond({images})` → adapter seam, so the FSM, the decision record, the
      // two `conversation.turn` rows and the segment plan are all exactly the normal turn's.
      const turn = await engine.respond(
        { sessionId: session.sessionId, text: question, addressed: true, at, images: [{ mediaType: image.mediaType, base64: image.base64 }] },
        {
          // Per-segment TTS, the same seam the typed/voice turns use.
          onSegment: async (segment) => {
            const synthesize = loopSynthesizeProvider();
            if (synthesize === undefined) {
              audioNote = '只显示文字：朗读关闭（--no-tts）或没有可用密钥，所以这次没有合成语音。';
              return;
            }
            audio = audio ?? [];
            try {
              (audio as (string | null)[]).push((await synthesize(segment.text)).toString('base64'));
            } catch (error) {
              (audio as (string | null)[]).push(null);
              audioNote = `第 ${segment.index + 1} 段合成失败：${error instanceof Error ? error.message : String(error)}`;
            }
          },
        },
      );
      action = turn.action;
      reply = turn.text === null || turn.text.trim().length === 0 ? null : turn.text.trim();
      firstTokenMs = turn.firstTokenMs;
      provider = turn.provider;
      model = turn.model;
      segments = turn.segments;
      gapMs = turn.segmentGapMs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordLookOnce(store, { ...image, trigger, question, outcome: `failed:${message.slice(0, 60)}` });
      return { ok: false, error: { code: 'LOOK_FAILED', message: `这一次调用失败了：${message}`, hint: '画面没有重试、也没有落盘；可以直接再按一次。' } };
    }
    const latencyMs = Date.now() - startedAt;
    // The two turns are already in the log — `engine.respond` writes them (that is why this path
    // has no `recordTurn` of its own; adding one would double every look in the right column).
    const record = recordLookOnce(store, { ...image, trigger, question, outcome: reply === null ? `no-text:${action}` : action });
    if (reply !== null && segments.length === 0) {
      const split = splitReplyIntoSegments(reply, resolveReplyLimits(config.reply));
      segments = split.segments;
      gapMs = split.gapMs;
    }
    pushTurn({
      kind: 'text',
      at: at.toISOString(),
      action,
      actionText: action === 'SPEAK' ? '说话' : action,
      reason: 'VISION_LOOK_ONCE',
      reasonText: `手动看一眼（${trigger}）`,
      transcript: question,
      reply,
      state: engine.state,
      // Same shape as every other non-voice turn (see the proactive push below): no VAD/ASR/TTS ran,
      // so those are `0` / `null`; the model stages are the real ones. The old literal used the keys
      // `vad` / `asr` / `firstToken` / `total`, so the page printed 「undefined」 for this turn.
      stages: { vadMs: 0, asrMs: null, llmFirstChunkMs: firstTokenMs, llmTotalMs: latencyMs, ttsMs: null, totalMs: latencyMs },
      segmentsTotal: segments.length,
      segmentsUsed: segments.length,
      droppedSegments: [],
      privacyNote: '这一张静帧只发送了一次（' + `${image.width}x${image.height}，${Math.round(image.bytes / 1024)}KB` + '）；没有落盘、没有连续上传，记录里也没有图像。',
      replySegments: segments,
      replyGapMs: gapMs,
      source: `看一眼（${trigger}）`,
    });
    log(`[vision] 看一眼（${trigger}）：${image.width}x${image.height} ${Math.round(image.bytes / 1024)}KB → ${action}${reply === null ? '' : `「${reply.slice(0, 40)}」`}（${latencyMs}ms，审计 #${record.sequence}）`);
    return {
      ok: true,
      action,
      reply,
      noAnswer: reply === null,
      // A manual look that the model answers with silence is not an error — it did look — but the
      // page must not say "看过了" and leave the user guessing why nothing came back.
      noAnswerNote:
        reply === null
          ? `模型这次没说话（action=${action}）：它已经看过这一帧（记录 #${record.sequence}），但没有给出内容。可以换个问法再按一次，或直接问「画面里有什么？」。`
          : null,
      segments,
      gapMs,
      audio,
      audioNote,
      provider,
      model,
      latencyMs,
      upload: record,
      vision: visionPayload(),
      state: statePayloadSync(),
    };
  }

  /** The state the page needs right after a look (sync part; `statePayload` is async). */
  function statePayloadSync(): Record<string, unknown> {
    return { sessionId: session.sessionId, state: engine.state, recent: turns, vision: visionPayload() };
  }

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {          const address = server.address();
          const port = typeof address === 'object' && address !== null ? address.port : options.port;
          const boot = {
            listen: `127.0.0.1:${port}`,
            offline,
            ttsEnabled,
            // The page's sentence about granularity is built from the same fact the state payload
            // reports, so a page cannot claim streaming while the server speaks a whole reply.
            ttsMode: (streamSpeak === undefined ? 'whole-reply' : 'streaming') as 'streaming' | 'whole-reply',
            modelConfigured: client.hasKey,
            calibration,
            policy,
            databasePath: dataDir,
          };
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
        if (request.method === 'GET' && url.pathname === '/api/field/live') {
          json(response, 200, { ok: true, ...livePayload() });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/field/look') {
          // Manual only: the endpoint ignores any `trigger` the page might send that is not
          // 'manual' — autonomy has exactly one switch (the vision settings endpoint below).
          const body = (await readBody(request)) as Record<string, unknown>;
          const question = typeof body['question'] === 'string' ? body['question'] : undefined;
          const payload = await lookOnce('manual', question);
          json(response, payload['ok'] === true ? 200 : 200, payload);
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/field/vision') {
          const body = (await readBody(request)) as Record<string, unknown>;
          if (typeof body['autoLook'] !== 'boolean') {
            throw new RuntimeError('VISION_SWITCH_INVALID', '「允许西西自己看」需要一个布尔值', '页面上的复选框会传 true / false');
          }
          vision = { autoLook: body['autoLook'], source: 'console', updatedAt: new Date().toISOString() };
          persistVisionSettings(store, vision.autoLook);
          log(`[vision] 「允许西西自己看」已${vision.autoLook ? '打开' : '关闭'}（默认是关的；打开后仍要过全部主动开口硬门禁）`);
          json(response, 200, { ok: true, vision: visionPayload(), state: statePayloadSync() });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/field/live') {
          const body = (await readBody(request)) as Record<string, unknown>;
          const action = typeof body['action'] === 'string' ? body['action'] : 'start';
          if (action === 'start') {
            // 「启用」 = 摄像头在场检测 + 常驻主动循环，并且立刻先考虑一次（loop.start 自己会先 tick）。
            liveSensors.setCameraEnabled(body['camera'] !== false);
            if (typeof body['cameraIndex'] === 'number') liveCameraIndex = body['cameraIndex'];
            if (typeof body['source'] === 'string' && (body['source'] === 'camera' || body['source'] === 'synthetic')) {
              liveSource = body['source'];
            }
            if (typeof body['scenario'] === 'string' && body['scenario'].trim().length > 0) liveScenario = body['scenario'].trim();
            if (liveSensors.cameraEnabled()) {
              // Open (and migrate) the presence store *before* the child starts writing into it:
              // the child runs with `--append`, which refuses to create tables itself (t78).
              getPresenceStore();
              liveSensors.start({ source: liveSource, scenario: liveSource === 'synthetic' ? liveScenario : null });
            } else {              log('[live] 摄像头开关是关的：只启动主动循环，不启动在场检测');
            }
            proactiveLoop.start(typeof body['intervalMs'] === 'number' ? body['intervalMs'] : undefined);
          } else if (action === 'stop') {
            proactiveLoop.stop();
            liveSensors.stop();
          } else {
            throw new RuntimeError('UNKNOWN_LIVE_ACTION', `不认识的启用操作「${action}」`, '可用：start（启用西西）、stop（停用）');
          }
          json(response, 200, { ok: true, ...livePayload() });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/field/tts') {
          const body = (await readBody(request)) as Record<string, unknown>;
          if (typeof body['enabled'] !== 'boolean') {
            throw new RuntimeError('TTS_SWITCH_INVALID', 'TTS 开关需要一个布尔值', '页面上的复选框会传 true / false');
          }
          ttsOn = body['enabled'];
          log(`[tts] 朗读已${ttsOn ? '打开' : '关闭'}（回复与主动开口都生效；没有密钥时仍然是只显示文字）`);
          json(response, 200, { ok: true, ttsEnabled: ttsOn, ttsAvailable: ttsOn && client.hasKey, state: statePayload() });
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
            throw new RuntimeError('UNKNOWN_LOOP_ACTION', `不认识的循环操作「${action}」`, '可用：start（开始自动考虑）、stop（停止）、tick（立刻考虑一次）');
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
            personalityBefore: store.selfProfile(),
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
            personality: applied.personality,
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
            now: serverNow(),
            conversationState: engine.state,
            inFlightTurn: false,
            proactivity: effectiveProactivity(store.selfProfile()),
            sessionId: session.sessionId,
            replyLimits: config.reply,
            synthesize: loopSynthesizeProvider(),
            request: body,
          });
          log(`[proactive] 演练 ${drill.trigger} → ${drill.reasonCode}（分数 ${drill.score}/${drill.threshold}${drill.speak ? `，分 ${drill.segments.length} 段` : ''}）`);
          // 写路径可以对齐：演练真的可能说出口，于是话题表要跟着日志走到 offered。
          // （读接口不行 —— preflight ②；见 `proactivePayload`。）
          topicEngine.reconcile(serverNow());
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
          // t13: the console's own page plays the reply clause by clause, so this route collects the
          // incremental seam into a per-clause array and hands it to the page. The turn event keeps
          // counts and timings only — an audio blob on the turn object would mean the browser got
          // everything at once and could not start speaking before the reply ended.
          const clauseAudio: { index: number; text: string; audio: string; durationMs: number }[] = [];
          const payload = await handleVoiceTurn(
            {
              ...deps,
              onClause: async (clause) => {
                clauseAudio.push({ index: clause.index, text: clause.text, audio: clause.audio, durationMs: clause.durationMs });
              },
            },
            await readBody(request),
          );
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
            toolName: payload.toolName,
            source: '回应你',
          });
          json(response, 200, { ...payload, clauseAudio });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/turn') {
          const body = await readBody(request);
          const text = (body.text ?? '').trim();
          if (text.length === 0) throw new RuntimeError('EMPTY_MESSAGE', '没有输入文字', '在输入框里打一句话再按发送');
          // While a turn is being answered, the loop must treat 「最近有对话」 as true (t70): the
          // gate reads this flag, so 西西 cannot talk over a reply that is still being produced.
          turnInFlight = true;
          let turn: Awaited<ReturnType<typeof engine.respond>>;
          const notices: { readonly code: string; readonly detail: string }[] = [];
          try {
            turn = await engine.respond(
              { sessionId: session.sessionId, text, addressed: engine.state === 'IDLE' },
              { onNotice: (notice) => void notices.push({ code: notice.code, detail: notice.detail }) },
            );
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
            toolName: turn.toolName,
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
            // t21 (t12 F2 / t4 F5): the right column must be able to say *why* a turn was silent and
            // whether the provider truncated it — the same three fields the voice path carries.
            silenceReason: turn.silenceReason,
            silenceReasonText: explainSilenceReason(turn.silenceReason),
            hygiene: turn.hygiene,
            finishReason: turn.finishReason,
            // Pack Phase 2: the same fact the voice path reports, so a reader can see that the
            // answer really came from a tool (and an offline test can assert it).
            toolName: turn.toolName,
            notices,
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
        if (error instanceof RuntimeError) {
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

  try {
    await new Promise<void>((resolvePort, rejectPort) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        rejectPort(
          error.code === 'EADDRINUSE'
            ? new RuntimeError('PORT_IN_USE', `端口 ${options.port} 已被占用（可能已经开着一个现场测试或 npm run web）`, `换一个端口：npm run field-test -- --port ${options.port + 1}；或先关掉占用该端口的程序`, 500)
            : new RuntimeError('LISTEN_FAILED', `无法在本机监听 ${options.port}：${error.message}`, '检查防火墙/安全软件是否拦了 Node 监听本机端口', 500),
        );
      };
      server.once('error', onError);
      server.listen(options.port, '127.0.0.1', () => {
        server.off('error', onError);
        resolvePort();
      });
    });
  } catch (error) {
    /**
     * V0.3 P2.5-B：监听失败（端口被占等）时，这个进程里**已经建起来**的运行时与库要收掉再抛出去。
     * 否则调用方看到「启动失败」，而进程里留着一条开着链的插件运行时（MCP 可能已经连上）与一个开着的库 ——
     * 「库不是正常关闭的」正是这个仓库最不想重复的事故形态。
     */
    await runtime.stop().catch(() => undefined);
    store.close();
    throw error;
  }
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    turns,
    runtime,
    close: async () => {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        // Browsers/undici keep sockets alive; without this a test (or Ctrl+C)
        // waits for the keep-alive timeout before the process can exit.
        server.closeAllConnections();
      });
      /**
       * V0.3 P2.5-B：**关库之前**先把常驻运行时停下来，它做两件控制台以前没做的事：
       *
       *  * 把这一轮还没写完的后台提取排空（`extraction.drain()` —— 控制台此前从不 drain，
       *    「说完最后一句就 Ctrl+C」那一轮只能靠提取器自己的定时器，库已经关了就是丢）；
       *  * 让插件层走完关停：九步生命周期收尾（MCP 连接在这里断开）→ 撤回 `mount()` 复制进链的副本 →
       *    清空前链上剩下的内置工具。
       *
       * 幂等（`stop()` 第二次返回同一份报告），所以重复 `close()` 不会关两遍。
       */
      await runtime.stop();
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
    },
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
    throw new RuntimeError('BAD_JSON', '请求体不是合法 JSON', '刷新页面重试');
  }
}

// --------------------------------------------------------------------------------------
// The page (Chinese, aimed at a non-engineer)
// --------------------------------------------------------------------------------------

export interface FieldBootstrap {
  readonly listen: string;
  readonly offline: boolean;
  readonly ttsEnabled: boolean;
  /**
   * How this console really synthesizes, when 朗读 is on: `streaming` (a TTS sink is installed,
   * clause by clause) or `whole-reply` (one call for the whole reply). Omitted by a caller that
   * does not know — the page then says 「整条回复一次合成」, which is the safe direction: it never
   * claims the finer granularity it cannot verify.
   */
  readonly ttsMode?: 'streaming' | 'whole-reply';
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
    /**
     * 两种形状都要读得回来：
     *   * `s` = 紧凑数组（现在写的，布局由 `PROACTIVE_SETTING_KEYS` 决定）；
     *   * `settings` = 旧的对象形状（早先写进库里、已经在真实数据目录里的那些记录）。
     */
    const decoded = decodeProactiveAuditSettings(parsed['s']);
    const legacy = isMapping(parsed['settings']) ? (parsed['settings'] as Record<string, unknown>) : undefined;
    if (decoded === null && legacy === undefined) continue;
    // 变更文案同样是两种键名：`c`（现在写的）与 `changes`（旧记录）。
    const changes = Array.isArray(parsed['c']) ? (parsed['c'] as string[]) : Array.isArray(parsed['changes']) ? (parsed['changes'] as string[]) : [];
    rows.push({
      at: event.timestamp,
      sequence: event.sequence,
      changes,
      settings: decoded ?? parseProactiveSettings(legacy),
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
 * `field-test` already uses for its own startup line. It carries the *effective* values, compactly
 * (see {@link encodeProactiveAuditSettings}), so `restoreProactiveSettings` can rebuild them without
 * trusting any other file.
 *
 * preflight ① found the trap hidden here: the old payload wrote the whole config-shaped object
 * (~640 chars once every key was carried), which no longer fits `detail`'s 500-char schema cap — and
 * the overflow path **truncated the JSON**, i.e. it wrote a record that cannot be parsed back. The
 * symptom was exactly 「面板上存过的设置，重启后变回了配置文件的值」. So: the settings half is now
 * compact and bounded, and what gets dropped under pressure is only the human-readable change list —
 * never the JSON itself.
 */
export function persistProactiveSettings(
  store: XixiStore,
  settings: ProactiveSettings,
  changes: readonly string[],
): StoredEvent {
  const compact = compactAuditChanges(changes);
  const payload = (kept: readonly string[]): string =>
    JSON.stringify({ v: PROACTIVE_SETTINGS_AUDIT_VERSION, s: encodeProactiveAuditSettings(settings), c: kept });
  const room = 480; // 留出余量给 schema 的 500 上限
  let detail = payload(compact);
  if (detail.length > room) detail = payload(compact.slice(0, 3));
  if (detail.length > room) detail = payload([]);
  return store.recordHealth(PROACTIVE_SETTINGS_SERVICE, 'ok', detail);
}

/** Keep at most the first few change lines so the audit payload always fits the schema. */
function compactAuditChanges(changes: readonly string[]): readonly string[] {
  if (changes.length <= 6) return changes;
  return [...changes.slice(0, 5), `…（共 ${changes.length} 项）`];
}

/**
 * The audit record's settings half, as a **compact array** (preflight ①).
 *
 * The layout is derived from {@link PROACTIVE_SETTING_KEYS} and `PROACTIVE_TRIGGERS`, in this order:
 * `[enabled, …每个数字字段, quietStart, quietEnd, …每个触发源]`. Nothing here is a second list of
 * key names — that is what keeps it from drifting away from the write-back. It is deliberately not
 * the readable config shape: 18 keys with their full names do not fit the 500-char `detail` cap, and
 * an audit record that cannot be parsed back is worse than one that takes a comment to read.
 */
function encodeProactiveAuditSettings(settings: ProactiveSettings): readonly (boolean | number | string)[] {
  return [
    settings.enabled,
    ...PROACTIVE_SETTING_KEYS.map(([field]) => settings[field]),
    formatClockMinutes(settings.quietHours.startMinutes),
    formatClockMinutes(settings.quietHours.endMinutes),
    ...PROACTIVE_TRIGGERS.map((trigger) => settings.triggers[trigger]),
  ];
}

/** Inverse of {@link encodeProactiveAuditSettings}; `null` = 看不懂（长度不合 = 布局/版本换了）。 */
function decodeProactiveAuditSettings(value: unknown): ProactiveSettings | null {
  if (!Array.isArray(value)) return null;
  const numericCount = PROACTIVE_SETTING_KEYS.length;
  if (value.length !== 1 + numericCount + 2 + PROACTIVE_TRIGGERS.length) return null;
  const config: Record<string, unknown> = { enabled: value[0] === true };
  PROACTIVE_SETTING_KEYS.forEach(([, key], index) => {
    config[key] = value[index + 1];
  });
  config['quiet_hours'] = { start: value[1 + numericCount], end: value[2 + numericCount] };
  const triggers: Record<string, boolean> = {};
  PROACTIVE_TRIGGERS.forEach((trigger, index) => {
    triggers[trigger] = value[3 + numericCount + index] === true;
  });
  config['triggers'] = triggers;
  // 形状对了还要过一遍引擎自己的解析器：它做的是取值域检查，坏值退回默认（永不抛出）。
  return parseProactiveSettings(config);
}

/**
 * 设置里的**数字**字段（`enabled` / `quiet_hours` / `triggers` 各自单独处理）。
 *
 * 写成联合类型而不是 `keyof ProactiveSettings`：这张表的每一项都会被当成数字回写/编码，
 * 若把对象型字段混进来，类型检查会当场拦住（而不是写进 JSON 变成 `[object Object]`）。
 */
type ProactiveNumericField =
  | 'baseCooldownMinutes'
  | 'continuationCooldownMinutes'
  | 'maxPer6h'
  | 'maxPerDay'
  | 'maxConsultsPerDay'
  | 'newSessionMinGapMinutes'
  | 'hotChatMinTurns'
  | 'hotChatWindowMinutes'
  | 'topicRepeatWindowHours'
  | 'genericTopicCooldownHours'
  | 'unansweredPenalty'
  | 'explicitRejectPenalty'
  | 'sameTopicPenalty'
  | 'unansweredWindowMinutes'
  | 'negativeFeedbackCooldownMultiplier';

/**
 * 设置字段 ↔ `config.proactive` 键的**唯一**一张表（pack v03-preflight ①）。
 *
 * 为什么必须只有一张：回写（`proactiveSettingsToConfig`）与打补丁（`applyProactiveSettingsPatch`）
 * 各自抄一份映射时，两份会各漏一半，而症状是两个方向的静默错误——
 *   * 回写漏键 → 补丁改一个字段，**没写回的字段被 `parseProactiveSettings` 打回出厂默认值**（t63）；
 *   * 补丁漏键 → 一个列在 `PROACTIVE_PATCH_FIELDS` 里、页面以为能改的字段，**保存成功但什么也没变**。
 * 这里逐项抄的是 `parseProactiveSettings`（`packages/conversation/src/proactive.ts`）读的键名。
 */
const PROACTIVE_SETTING_KEYS: readonly (readonly [ProactiveNumericField, string])[] = Object.freeze([
  ['baseCooldownMinutes', 'base_cooldown_min'],
  ['continuationCooldownMinutes', 'continuation_cooldown_min'],
  ['maxPer6h', 'max_per_6h'],
  ['maxPerDay', 'max_per_day'],
  ['maxConsultsPerDay', 'max_consults_per_day'],
  ['newSessionMinGapMinutes', 'new_session_min_gap_min'],
  ['hotChatMinTurns', 'hot_chat_min_turns'],
  ['hotChatWindowMinutes', 'hot_chat_window_min'],
  ['topicRepeatWindowHours', 'topic_repeat_window_h'],
  ['genericTopicCooldownHours', 'generic_topic_cooldown_h'],
  ['unansweredPenalty', 'unanswered_penalty'],
  ['explicitRejectPenalty', 'explicit_reject_penalty'],
  ['sameTopicPenalty', 'same_topic_penalty'],
  ['unansweredWindowMinutes', 'unanswered_window_min'],
  ['negativeFeedbackCooldownMultiplier', 'negative_feedback_cooldown_multiplier'],
]);

/**
 * Typed settings → the `config.proactive` shape, so one parser validates both sources.
 *
 * It must carry **every** key `parseProactiveSettings` reads, not only the ones the console page
 * happens to expose: this object is what a patch is merged into before being parsed again, so a
 * missing key silently returns to the factory default (preflight ①).
 */
export function proactiveSettingsToConfig(settings: ProactiveSettings): Record<string, unknown> {
  const written: Record<string, unknown> = {
    enabled: settings.enabled,
    quiet_hours: { start: formatClockMinutes(settings.quietHours.startMinutes), end: formatClockMinutes(settings.quietHours.endMinutes) },
    triggers: { ...settings.triggers },
  };
  for (const [field, key] of PROACTIVE_SETTING_KEYS) written[key] = settings[field];
  return written;
}

export interface ProactiveSettingsPatchResult {
  readonly settings: ProactiveSettings;
  /** Human-readable list of what changed (empty = the patch was a no-op). */
  readonly changes: readonly string[];
  /** Fields the page sent that were ignored, with the reason. */
  readonly rejected: readonly string[];
  /**
   * The personality writes this patch asked for, already validated into `[0, 1]`.
   *
   * They are *not* part of `ProactiveSettings`: `proactivity` / `talkativeness` / `verbosity` live
   * in `self_profile`, so the caller writes them through `overrideSelfProfile` (with its own
   * history row) while the gate/knob settings go to the audit record.
   */
  readonly personality: Readonly<Record<string, number>>;
}

/** Personality properties the console may tune (t63's proactivity + t74's talkativeness/verbosity). */
export const PROACTIVE_PERSONALITY_FIELDS: readonly string[] = Object.freeze(['proactivity', 'talkativeness', 'verbosity']);

/** The fields `applyProactiveSettingsPatch` understands; anything else is reported, never dropped. */
export const PROACTIVE_PATCH_FIELDS: readonly string[] = Object.freeze([
  'enabled',
  'baseCooldownMinutes',
  'continuationCooldownMinutes',
  'maxPer6h',
  'maxPerDay',
  'topicRepeatWindowHours',
  'genericTopicCooldownHours',
  'unansweredPenalty',
  'explicitRejectPenalty',
  'sameTopicPenalty',
  'unansweredWindowMinutes',
  'negativeFeedbackCooldownMultiplier',
  'quietStart',
  'quietEnd',
  'triggers',
  ...PROACTIVE_PERSONALITY_FIELDS,
]);

/** Chinese label for each tunable personality property (the panel shows these). */
export const PERSONALITY_FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  proactivity: '主动性总强度',
  talkativeness: '话痨程度',
  verbosity: '话的长度',
});

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

  // Personality values (0..1), validated here and written to `self_profile` by the caller.
  const personality: Record<string, number> = {};
  for (const field of PROACTIVE_PERSONALITY_FIELDS) {
    if (patch[field] === undefined) continue;
    const parsed = typeof patch[field] === 'number' ? (patch[field] as number) : Number(String(patch[field]).trim());
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      rejected.push(`${field}：要在 0 到 1 之间（收到 ${JSON.stringify(patch[field])}），已忽略`);
      continue;
    }
    personality[field] = parsed;
  }

  if (patch['enabled'] !== undefined) merged['enabled'] = patch['enabled'] === true || patch['enabled'] === 'true';
  // Numbers go through the same table the write-back uses, so「列在 PROACTIVE_PATCH_FIELDS 里」与
  // 「真的会被应用」不再可能分家（preflight ①：早先六个声明过的字段保存成功却什么也没改）。
  for (const [field, key] of PROACTIVE_SETTING_KEYS) {
    if (!PROACTIVE_PATCH_FIELDS.includes(field)) continue; // 页面不开放的字段：只在回写里带上它的现值
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
  if (settings.baseCooldownMinutes !== current.baseCooldownMinutes) {
    changes.push(`打扰代价衰减：${current.baseCooldownMinutes} → ${settings.baseCooldownMinutes} 分钟（不再是禁止窗口）`);
  }
  if (settings.continuationCooldownMinutes !== current.continuationCooldownMinutes) {
    changes.push(`热聊中接话的代价窗口：${current.continuationCooldownMinutes} → ${settings.continuationCooldownMinutes} 分钟`);
  }
  if (settings.maxPer6h !== current.maxPer6h) changes.push(`6 小时额度：${current.maxPer6h} → ${settings.maxPer6h}`);
  if (settings.maxPerDay !== current.maxPerDay) changes.push(`当日额度：${current.maxPerDay} → ${settings.maxPerDay}`);
  if (settings.topicRepeatWindowHours !== current.topicRepeatWindowHours) {
    changes.push(`同话题窗口：${current.topicRepeatWindowHours} → ${settings.topicRepeatWindowHours} 小时`);
  }
  if (settings.genericTopicCooldownHours !== current.genericTopicCooldownHours) {
    changes.push(`泛泛话题窗口：${current.genericTopicCooldownHours} → ${settings.genericTopicCooldownHours} 小时`);
  }
  if (settings.unansweredPenalty !== current.unansweredPenalty) {
    changes.push(`未回应惩罚：${current.unansweredPenalty} → ${settings.unansweredPenalty}`);
  }
  if (settings.explicitRejectPenalty !== current.explicitRejectPenalty) {
    changes.push(`明确拒绝惩罚：${current.explicitRejectPenalty} → ${settings.explicitRejectPenalty}`);
  }
  if (settings.sameTopicPenalty !== current.sameTopicPenalty) {
    changes.push(`同话题惩罚：${current.sameTopicPenalty} → ${settings.sameTopicPenalty}`);
  }
  if (settings.unansweredWindowMinutes !== current.unansweredWindowMinutes) {
    changes.push(`未回应判定窗口：${current.unansweredWindowMinutes} → ${settings.unansweredWindowMinutes} 分钟`);
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
  return { settings, changes, rejected, personality };
}

/** The change line for one personality write, kept out of `changes` only when nothing moved. */
export function personalityChangeLine(property: string, before: number, after: number): string {
  const label = PERSONALITY_FIELD_LABELS[property] ?? property;
  return `${label}：${before} → ${after}（self_profile / console:personality）`;
}

/** Kept as a named export: t63's page/report wording referred to it by this name. */
export function proactivityChangeLine(before: number, after: number): string {
  return personalityChangeLine('proactivity', before, after);
}

export interface ProactivePatchApplication {
  readonly settings: ProactiveSettings;
  readonly changes: readonly string[];
  readonly rejected: readonly string[];
  /** Personality writes that actually moved a value, keyed by property. */
  readonly personality: Readonly<Record<string, { readonly before: number; readonly after: number }>>;
  /** Sequence of the `system.health` audit row, or `null` when nothing changed. */
  readonly auditSequence: number | null;
  /** Timestamp of that audit row (what the page shows as 「上次保存」), or `null`. */
  readonly auditAt: string | null;
}

/**
 * Apply one patch end-to-end: engine settings + the personality values, then one audit row.
 *
 * Both pages call this, so "调完就生效、还留了痕迹" is one code path (t63, extended in t74 to
 * talkativeness/verbosity). The personality write goes through `overrideSelfProfile`, which is the
 * project's **administrative override** seam: it upserts `self_profile` *and* appends a
 * `self_profile_history` row per property, so the change is both live and auditable — while the
 * engine knobs land in the `system.health` audit record that `restoreProactiveSettings` reads
 * back on the next start.
 */
export function applyAndPersistProactivePatch(options: {
  readonly store: XixiStore;
  readonly settings: ProactiveSettings;
  readonly patch: Readonly<Record<string, unknown>>;
  /** The effective personality before the patch (from `store.selfProfile()`). */
  readonly personalityBefore: Readonly<Record<string, number>>;
  readonly log?: ((line: string) => void) | undefined;
}): ProactivePatchApplication {
  const patched = applyProactiveSettingsPatch(options.settings, options.patch);
  const changes = [...patched.changes];
  const personality: Record<string, { before: number; after: number }> = {};
  const writes: Record<string, number> = {};
  /**
   * pack Phase 4：面板显示与改写的都是**有效值**（基础+学习+当天覆盖），而 `overrideSelfProfile`
   * 写的是**基础层**。两件事都要处理，否则面板上的数就是假的：
   *
   *   1. 学习层有偏移时直接写绝对值和会把它叠加两次（0.63 拉到 0.70 会变成 0.58）；
   *   2. 今天有过「安静点」这类会话覆盖时，基础层可能已经顶到上界，改完仍然到不了目标值 ——
   *      操作者现在明确改这一个属性，就取消它今天在这一属性上的覆盖（其它属性保留）。
   */
  const selfModel = new SelfModel(options.store);
  /** 这次被面板取代掉的「今天」覆盖（写进变更行，别让它们悄悄消失）。 */
  const clearedOverrides = new Set<string>();
  for (const [property, after] of Object.entries(patched.personality)) {
    const before = options.personalityBefore[property];
    if (before === after) continue; // no-op: nothing to write, nothing to audit
    if (selfModel.clearTodayOverride(property) > 0) clearedOverrides.add(property);
    writes[property] = selfModel.baseValueFor(property, after);
    personality[property] = { before: before ?? Number.NaN, after };
  }
  if (Object.keys(writes).length > 0) {
    options.store.overrideSelfProfile(writes, 'console:personality');
    for (const [property, move] of Object.entries(personality)) {
      const note = clearedOverrides.has(property) ? '；今天这一属性上的会话覆盖已取消（面板是更明确的设置）' : '';
      changes.push(`${personalityChangeLine(property, move.before, move.after)}${note}`);
    }
  }
  let auditSequence: number | null = null;
  let auditAt: string | null = null;
  if (changes.length > 0) {
    const event = persistProactiveSettings(options.store, patched.settings, changes);
    auditSequence = event.sequence;
    auditAt = event.timestamp;
    options.log?.(`[proactive] 设置已更新（事件 #${event.sequence}）：${changes.join('；')}`);
  }
  return { settings: patched.settings, changes, rejected: patched.rejected, personality, auditSequence, auditAt };
}

export interface ProactiveUsage {
  readonly deliveries: number;
  readonly lastDeliveryAt: string | null;
  readonly cooldownRemainingMs: number;
  readonly in6h: number;
  readonly today: number;
  /** How many times today the model was asked "说还是不说" (paid calls). */
  readonly consultsToday: number;
  /** The daily budget's real charge: `today + consultsToday` (ADR-0011 代价). */
  readonly spentToday: number;
  readonly day: string;
}

/** Budget/cooldown usage, recomputed from the log (never cached — a restart must not lose it). */
export function proactiveUsage(store: XixiStore, settings: ProactiveSettings, now: Date, offsetMinutes?: number): ProactiveUsage {
  const history = readProactiveHistory(store);
  const consultations = readProactiveConsultations(store);
  const day = localDayOf(now, offsetMinutes);
  const last = history[history.length - 1];
  const cooldownMs = settings.baseCooldownMinutes * 60_000;
  const sinceLast = last === undefined ? Number.POSITIVE_INFINITY : now.getTime() - last.at.getTime();
  const consultsToday = consultations.filter((consultedAt) => localDayOf(consultedAt, offsetMinutes) === day).length;
  const today = history.filter((record) => localDayOf(record.at, offsetMinutes) === day).length;
  return {
    deliveries: history.length,
    lastDeliveryAt: last === undefined ? null : last.at.toISOString(),
    cooldownRemainingMs: last === undefined || cooldownMs === 0 ? 0 : Math.max(0, cooldownMs - sinceLast),
    in6h: history.filter((record) => now.getTime() - record.at.getTime() < 6 * 60 * 60_000).length,
    today,
    consultsToday,
    /** What the daily budget actually charges: spoken messages + paid 读空气 consultations. */
    spentToday: today + consultsToday,
    day,
  };
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
  /** Which initiative the candidate belonged to (pack §14.1). */
  readonly initiativeKind: string;
  /** Who decided: the deterministic budget or the model reading the room. */
  readonly decidedBy: string;
  /** The model's own code when it was asked (an enum, never free text). */
  readonly modelReasonCode: ProactiveModelReasonCode | null;
  /** Whether this consideration paid for a model call. */
  readonly modelConsulted: boolean;
  /** Program-rendered Chinese 依据 (numbers → words), for the panel. */
  readonly basis: readonly string[];
}

/** The last few considerations, straight from the log (this is the auditable trail). */
export function proactiveDecisionHistory(store: XixiStore, limit = 8): ProactiveDecisionRow[] {
  const events = store.readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER });
  return events
    .slice(-limit)
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      const modelReasonCode = typeof payload['model_reason_code'] === 'string' ? payload['model_reason_code'] : null;
      return {
        at: event.timestamp,
        sequence: event.sequence,
        candidateId: typeof payload['candidate_id'] === 'string' ? payload['candidate_id'] : '?',
        trigger: typeof payload['trigger'] === 'string' ? payload['trigger'] : '?',
        speak: payload['speak'] === true,
        reasonCode: typeof payload['reason_code'] === 'string' ? payload['reason_code'] : '?',
        score: typeof payload['score'] === 'number' ? payload['score'] : 0,
        threshold: typeof payload['threshold'] === 'number' ? payload['threshold'] : 0,
        initiativeKind: typeof payload['initiative_kind'] === 'string' ? payload['initiative_kind'] : '?',
        decidedBy: typeof payload['decided_by'] === 'string' ? payload['decided_by'] : '?',
        modelReasonCode:
          modelReasonCode !== null && modelReasonCode in PROACTIVE_MODEL_REASON_LABELS
            ? (modelReasonCode as ProactiveModelReasonCode)
            : null,
        modelConsulted: payload['model_consulted'] === true,
        basis: Array.isArray(payload['basis']) ? (payload['basis'] as string[]) : [],
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

/** Signals that make a drill candidate pass the recommendation bar; penalties stay low. */
export const PROACTIVE_DRILL_COMPONENTS: Readonly<Record<string, number>> = Object.freeze({
  topic_quality: 0.9,
  personal_relevance: 0.85,
  freshness: 0.6,
  receptivity: 0.8,
  engagement: 0.7,
  interruption_cost: 0.0,
  repeated_topic_penalty: 0.0,
  recent_unanswered_penalty: 0.0,
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
  /** What the deterministic social budget suggested (the model may still decline/go ahead). */
  readonly recommendation: 'speak' | 'hold';
  readonly primarySignalLabel: string;
  /** Program-rendered Chinese 依据 for this decision (numbers → words). */
  readonly basis: readonly string[];
  readonly decidedBy: 'program' | 'model';
  readonly modelConsulted: boolean;
  readonly gates: readonly ProactiveGateRow[];
  /** The spoken text when the gates let it through (null when blocked). */
  readonly text: string | null;
  /** The same text as the page should play it: one entry per segment, in order. */
  readonly segments: readonly string[];
  readonly gapMs: number;
  /** One clip per segment (base64 WAV) so the drill button really speaks; `null` = no TTS. */
  readonly audio: readonly (string | null)[] | null;
  /** Why there is no audio, when there is none. */
  readonly audioNote: string | null;
  readonly eventSequence: number | null;
  readonly usage: ProactiveUsage;
  /** What the user should do about a blocked candidate (Chinese, actionable). */
  readonly nextStep: string;
}

/**
 * Run one consideration through the **real** engine and return everything a page needs.
 *
 * "Real" matters: the signals, the hard floor in its fixed order, the 读空气 decision (when a
 * `decide` seam is supplied), the `proactive.decision` audit row and the at-most-once delivery
 * write all go through `ProactiveEngine.consider`. The drill only supplies a candidate
 * (trigger + signals) and the spoken text.
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
  readonly privacyAllowed?: boolean;
  readonly sessionId?: string | null;
  readonly replyLimits?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The 读空气 seam (the console passes the model-backed one). Omitted in tests → the
   * deterministic recommendation decides, and the drill stays hermetic and free.
   */
  readonly decide?: ProactiveDecider | undefined;
  /** Same TTS seam the resident loop uses — the drill must *speak*, not only print (t74). */
  readonly synthesize?: ((text: string) => Promise<Buffer>) | undefined;
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
  const topicRef = typeof options.request.topicRef === 'string' && options.request.topicRef.length > 0 ? options.request.topicRef : null;

  const engine = new ProactiveEngine({
    store: options.store,
    settings: options.settings,
    clock: () => options.now,
    offsetMinutes: options.offsetMinutes,
    decide: options.decide,
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
    privacyAllowed: options.privacyAllowed,
    sessionId: options.sessionId ?? null,
    deliver: (delivery) => {
      delivered = PROACTIVE_DRILL_LINES[delivery.trigger];
    },
  });

  const split = delivered === null ? null : splitReplyIntoSegments(delivered, resolveReplyLimits(options.replyLimits));
  const segments = split?.segments ?? [];
  const gapMs = split?.gapMs ?? 0;
  let audio: (string | null)[] | null = null;
  let audioNote: string | null = null;
  if (outcome.speak) {
    if (options.synthesize === undefined) {
      audioNote = '只显示文字：朗读关闭（--no-tts）或没有可用密钥，所以这次没有合成语音。';
    } else {
      const clips: (string | null)[] = [];
      for (const segment of segments) {
        try {
          clips.push((await options.synthesize(segment)).toString('base64'));
        } catch (error) {
          clips.push(null);
          audioNote = `第 ${clips.length} 段合成失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      audio = clips;
    }
  }
  return {
    speak: outcome.speak,
    delivered: outcome.delivered,
    reasonCode: outcome.reasonCode,
    reasonLabel: PROACTIVE_GATE_LABELS[outcome.reasonCode],
    trigger,
    candidateId,
    score: outcome.score,
    threshold: outcome.threshold,
    recommendation: outcome.recommendation,
    primarySignalLabel: PROACTIVE_SIGNAL_LABELS[outcome.primarySignal === 'score' ? 'topic_quality' : outcome.primarySignal],
    basis: outcome.basis,
    decidedBy: outcome.decidedBy,
    modelConsulted: outcome.modelConsulted,
    gates: proactiveGateRows(outcome.reasonCode),
    text: delivered,
    segments,
    gapMs,
    audio,
    audioNote,
    eventSequence: outcome.event?.sequence ?? null,
    usage: proactiveUsage(options.store, options.settings, options.now, options.offsetMinutes),
    nextStep: runtime.PROACTIVE_GATE_NEXT_STEPS[outcome.reasonCode],
  };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * How a reply is played: `ADR-0010` segments plus the pause between them.
 *
 * This is the *console's* plan (what the page and the terminal print), not the runtime's
 * `SegmentPlan` in `@xixi/runtime` — that one describes which VAD segments go into one ASR call.
 * The two used to share the name here, and TypeScript merged them into a single interface; the
 * V0.3 P0-A move took the runtime copy into the package and left `segmentPlan()` below declaring a
 * return type it did not satisfy. Restored verbatim from `c8616ed:scripts/field-test.ts`.
 */
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
  /** The effective personality values the panel may tune (`proactivity` / `talkativeness` / `verbosity`). */
  readonly personality: Readonly<Record<string, number>>;
  readonly threshold: number;
  readonly usage: ProactiveUsage;
  readonly triggerLabels: readonly {
    readonly trigger: ProactiveTrigger;
    readonly label: string;
    readonly enabled: boolean;
    /** `true` when this console can actually produce a candidate of this kind today (t74). */
    readonly live: boolean;
  }[];
  readonly gateOrder: readonly { readonly code: ProactiveReasonCode; readonly label: string; readonly status: ProactiveGateRow['status'] }[];
  readonly lastDecision: ProactiveDecisionRow | null;
  readonly decisions: readonly ProactiveDecisionRow[];
  readonly audit: readonly { readonly at: string; readonly sequence: number; readonly changes: readonly string[] }[];
  /** `true` when the engine would consider a candidate at all (the switch, in one word). */
  readonly enabled: boolean;
  /**
   * pack Phase 3：现在记着哪些未完话题、哪些该追问了、说过的话题后来怎么样。
   *
   * 有话题引擎时才有（控制台装配处会传）；没有它时是 `null`，而不是假装「没有惦记的事」。
   */
  readonly openThreads?: TopicEngineStatus | null;
  /**
   * 《方案》§9 的话题来源，以及**这个控制台今天真能产出哪些**（Phase 3 只实现 `open_thread`）。
   * 与 `triggerLabels.live` 同一个原则：声明了却没有生产者的来源必须如实标成 `false`，不能装作能用。
   */
  readonly topicSources?: readonly { readonly source: TopicSource; readonly live: boolean }[];
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
  /** The effective personality (from `selfProfile()`); `proactivity` is read from here. */
  readonly personality: Readonly<Record<string, number>>;
  readonly offsetMinutes?: number;
  readonly historyLimit?: number;
  /** pack Phase 3 的话题引擎；传了就在面板里如实报出未完话题与话题历史。 */
  readonly topicEngine?: TopicEngine;
}): ProactiveConsoleState {
  const decisions = proactiveDecisionHistory(options.store, options.historyLimit ?? 8);
  const last = decisions[decisions.length - 1] ?? null;
  const proactivity = typeof options.personality['proactivity'] === 'number' ? (options.personality['proactivity'] as number) : DEFAULT_PROACTIVITY;
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
    proactivity,
    personality: { ...options.personality },
    threshold: proactiveThreshold(proactivity),
    usage: proactiveUsage(options.store, options.settings, options.now, options.offsetMinutes),
    triggerLabels: PROACTIVE_TRIGGERS.map((trigger) => ({
      trigger,
      label: PROACTIVE_TRIGGER_LABELS[trigger],
      enabled: options.settings.triggers[trigger],
      live: PROACTIVE_TRIGGERS_WITH_SOURCES.includes(trigger),
    })),
    gateOrder: proactiveGateRows((last?.reasonCode as ProactiveReasonCode | undefined) ?? null),
    lastDecision: last,
    decisions,
    audit: proactiveSettingsAuditRows(options.store).map((row) => ({ at: row.at, sequence: row.sequence, changes: row.changes })),
    enabled: options.settings.enabled,
    openThreads: options.topicEngine === undefined ? null : options.topicEngine.statusReport(options.now),
    topicSources: TOPIC_SOURCES.map((source) => ({ source, live: source === 'open_thread' })),
  };
}

/** The engine's own default proactivity, for pages that show the threshold before any profile exists. */
export function effectiveProactivity(profile: Readonly<Record<string, unknown>> | undefined): number {
  const value = profile?.['proactivity'];
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_PROACTIVITY;
}

// ---------------------------------------------------- live sensors (t78)
//
// The 「启用」 button starts two things at once: the camera presence loop (the real
// `perception_edge.run --live`, which keeps writing `presence.changed` exactly as before) and the
// resident consideration loop. The picture the page shows comes from the child's stdout as base64
// JPEG and lives **in memory only**: nothing is written to disk, nothing is uploaded, and the
// frame is dropped as soon as a newer one arrives. The page says so, and the tests check it.

/** One live frame, as the page receives it (the bytes stay in this process). */
export interface LiveFrameView {
  readonly at: string;
  readonly frameIndex: number;
  readonly present: boolean;
  readonly confidence: number;
  readonly motionRatio: number;
  readonly faces: number;
  readonly detectMs: number;
  readonly jpegBytes: number;
  readonly width: number;
  readonly height: number;
  /** `data:image/jpeg;base64,…` — the whole picture, inline in the JSON response. */
  readonly dataUrl: string;
}

export interface LiveChildStatus {
  readonly running: boolean;
  readonly pid: number | null;
  readonly source: 'camera' | 'synthetic';
  readonly startedAt: string | null;
  readonly frames: number;
  readonly presenceEvents: number;
  /** The last thing the child said on stderr (camera busy, model missing, …). */
  readonly lastNote: string | null;
  readonly exitCode: number | null;
  /** `true` once the process really exited (the 停用 button must not lie about this). */
  readonly exited: boolean;
}

export interface LiveSensorsStatus {
  readonly running: boolean;
  readonly cameraEnabled: boolean;
  readonly child: LiveChildStatus;
  readonly lastFrame: Omit<LiveFrameView, 'dataUrl'> & { readonly hasPicture: boolean } | null;
  readonly privacy: string;
}

export interface LiveCameraStartOptions {
  readonly source: 'camera' | 'synthetic';
  readonly scenario?: string | null;
  readonly cameraIndex: number;
}

export interface LiveCameraHandle {
  readonly pid: number;
  readonly kill: () => void;
  readonly write: (line: string) => void;
}

/** The seam that lets tests drive the live loop without a camera or Python. */
export interface LiveCameraRunner {
  start(
    options: LiveCameraStartOptions & {
      readonly onLine: (line: string) => void;
      readonly onPresenceEvent: (line: string) => void;
      readonly onExit: (code: number | null) => void;
    },
  ): LiveCameraHandle;
}

/**
 * The privacy sentence both pages show for the live picture (t78, reworded in t81, de-markdowned
 * in t86).
 *
 * It has to be exact in both directions: **no image is saved** (a frame only ever travels through
 * memory and localhost) — *and* the presence events are still written to the local store, because
 * events are the product and the picture is only how you get to look at the camera. The first
 * version said 「不落盘」 without qualifying it, which read as "nothing is written at all".
 *
 * It is plain text on purpose (t86): the same string goes into the page **and** into the JSON of
 * `/api/field/live`, so it must not contain markdown — `**…**` used to show up literally in the
 * browser. Where emphasis is wanted, the *page* adds its own `<b>` tags around its own sentence
 * (see the privacy card); this constant stays readable in both places.
 */
export const LIVE_PRIVACY_NOTE =
  '摄像头画面不保存图像：每一帧只在内存里编码、经 localhost 发给这个页面，不产生图像文件、不上传；' +
  '但在场事件（presence.changed）与 world_state 投影照常写进本地库——事件才是产品，画面只是给你看的。关掉「启用」后子进程一起退出。';

// ---------------------------------------------------- 「摄像头交不出画面」 (t103)
//
// A camera that returns nothing (lens covered, the privacy shutter/F-key switched off, the device
// unplugged, or another program holding it) is not the same fact as an empty room — but the page
// used to show it the same way, so 「没人」 was read as "nobody is home" while the picture was
// simply missing. These strings are plain text (t86: the same constants go into the page and into
// JSON), and the page puts them in a red block next to the picture.

/** The one sentence a user must not misread: no picture is not 「房间没人」. */
export const CAMERA_PROBLEM_TITLE = '摄像头现在交不出画面（不是房间没人）';
/** Three things that actually fix this on a laptop, in the order that costs least. */
export const CAMERA_PROBLEM_STEPS: readonly string[] = Object.freeze([
  '① 看镜头是不是被挡住了，以及机身/键盘上的电控隐私开关（很多笔记本有遮挡片或 F 键开关，指示灯亮才是真的在工作）',
  '② 按一下键盘上的相机隐私快捷键（各家不同，常见 F8 / F10 / Fn+F8；不确定就两个都试一次）',
  '③ 拔插摄像头（USB）或重启一次；仍不行就换一个 USB 口，或换 --camera-index',
]);
/** The command that shows what the camera is really delivering, frame by frame. */
export const CAMERA_PROBE_COMMAND = 'python -m perception_edge.run --probe-frames 10';
/** Why this is not 「无人」, in one line, for the block itself. */
export const CAMERA_PROBLEM_NOTE =
  '这条提示只说「拿不到画面」，不等于「房间没人」：在修好之前，请不要把在场状态当成事实（在场投影读不到新的画面，会慢慢过期）。';

/** Which kind of "no picture" we are looking at. */
export type CameraProblemKind = 'unavailable' | 'no-frames' | 'empty-frames';

export interface CameraProblem {
  readonly kind: CameraProblemKind;
  readonly title: string;
  readonly note: string;
  /** The three checks, verbatim (the page renders them as an ordered list). */
  readonly steps: readonly string[];
  readonly command: string;
  /** What the child said, when it said something (its own Chinese reason, or OpenCV's warning). */
  readonly childNote: string | null;
  /** How long this state has been visible, in seconds (null when it just appeared). */
  readonly forSeconds: number | null;
}

/** How long a running child may deliver nothing before the console calls it a camera problem. */
export const CAMERA_PROBLEM_GRACE_MS = 6_000;
/**
 * Signatures of "the camera itself is the problem" in a child's output: its own Chinese message,
 * or OpenCV's backend warnings (`can't be used to capture by index`, `VIDEOIO`, `out of range`).
 */
const CAMERA_UNAVAILABLE_PATTERN = /摄像头不可用|CameraUnavailable|can't be used to capture|VIDEOIO|out of range|被占用|无法打开/i;

/**
 * The live camera process + the最新一帧 it produced (t78).
 *
 * Everything here is deliberately "latest frame wins": the console keeps at most one picture, so
 * a long session cannot grow memory, and the page always shows *now* rather than a backlog.
 */
export class LiveSensors {
  readonly #options: {
    readonly runner: LiveCameraRunner;
    readonly cameraIndex: () => number;
    /**
     * V0.3 P0-B: where a received presence event goes. The console passes the canonical store's
     * ingest here — the child no longer has a `--db`, so this is the only writer (§3.3).
     */
    readonly ingest?: ((line: string) => void) | undefined;
    readonly now?: (() => Date) | undefined;
    readonly log?: ((line: string) => void) | undefined;
  };
  #handle: LiveCameraHandle | null = null;
  #running = false;
  #cameraEnabled = true;
  #source: 'camera' | 'synthetic' = 'camera';
  #scenario: string | null = null;
  #startedAt: string | null = null;
  #frames = 0;
  #presenceEvents = 0;
  #lastNote: string | null = null;
  #exitCode: number | null = null;
  #exited = false;
  #lastFrame: LiveFrameView | null = null;

  constructor(options: {
    readonly runner: LiveCameraRunner;
    readonly cameraIndex: () => number;
    readonly ingest?: ((line: string) => void) | undefined;
    readonly now?: (() => Date) | undefined;
    readonly log?: ((line: string) => void) | undefined;
  }) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#running;
  }

  setCameraEnabled(enabled: boolean): void {
    this.#cameraEnabled = enabled;
  }

  cameraEnabled(): boolean {
    return this.#cameraEnabled;
  }

  /** Start the camera loop. Returns the status right after the spawn attempt. */
  start(options?: { readonly source?: 'camera' | 'synthetic'; readonly scenario?: string | null }): LiveChildStatus {
    if (this.#running) return this.status().child;
    this.#source = options?.source ?? 'camera';
    this.#scenario = options?.scenario ?? null;
    this.#frames = 0;
    this.#presenceEvents = 0;
    this.#lastNote = null;
    this.#exitCode = null;
    this.#exited = false;
    this.#lastFrame = null;
    const at = this.#options.now?.() ?? new Date();
    try {
      this.#handle = this.#options.runner.start({
        source: this.#source,
        scenario: this.#scenario,
        cameraIndex: this.#options.cameraIndex(),
        onLine: (line) => this.#onLine(line),
        onPresenceEvent: (line) => this.#options.ingest?.(line),
        onExit: (code) => this.#onExit(code),
      });
      this.#running = true;
      this.#startedAt = at.toISOString();
      this.#options.log?.(`[live] 摄像头在场检测已启动（pid ${this.#handle.pid}，source=${this.#source}${this.#scenario === null ? '' : `，scenario=${this.#scenario}`}）`);
    } catch (error) {
      this.#running = false;
      this.#exited = true;
      this.#lastNote = `启动失败：${error instanceof Error ? error.message : String(error)}`;
      this.#options.log?.(`[live] ${this.#lastNote}`);
    }
    return this.status().child;
  }

  /** Stop it: close the pipe, then terminate. `exited` only becomes true when the process is gone. */
  stop(): LiveChildStatus {
    const handle = this.#handle;
    if (handle === null) {
      this.#running = false;
      return this.status().child;
    }
    this.#running = false;
    try {
      handle.kill();
    } catch (error) {
      this.#lastNote = `停止时出错：${error instanceof Error ? error.message : String(error)}`;
    }
    this.#options.log?.('[live] 已发送停止信号（摄像头在场检测进程应随之退出）');
    this.#handle = null;
    return this.status().child;
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (!trimmed.startsWith('{')) {
      this.#lastNote = trimmed.slice(0, 300);
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.#lastNote = trimmed.slice(0, 300);
      return;
    }
    if (parsed['type'] === 'frame') {
      this.#frames += 1;
      const jpeg = typeof parsed['jpeg'] === 'string' ? parsed['jpeg'] : null;
      this.#lastFrame = {
        at: typeof parsed['at'] === 'string' ? parsed['at'] : (this.#options.now?.() ?? new Date()).toISOString(),
        frameIndex: Number(parsed['frame_index'] ?? 0),
        present: parsed['present'] === true,
        confidence: Number(parsed['confidence'] ?? 0),
        motionRatio: Number(parsed['motion_ratio'] ?? 0),
        faces: Number(parsed['faces'] ?? 0),
        detectMs: Number(parsed['detect_ms'] ?? 0),
        jpegBytes: Number(parsed['jpeg_bytes'] ?? 0),
        width: Number(parsed['width'] ?? 0),
        height: Number(parsed['height'] ?? 0),
        dataUrl: jpeg === null ? '' : `data:image/jpeg;base64,${jpeg}`,
      };
      return;
    }
    const payload = parsed['payload'];
    if (parsed['record'] === 'event' && typeof payload === 'object' && payload !== null) {
      const presence = payload as Record<string, unknown>;
      if (typeof presence['present'] === 'boolean') this.#presenceEvents += 1;
      return;
    }
    if (parsed['record'] === 'frame') return; // the child's own evidence line: not needed here
    if (parsed['record'] === 'summary' || parsed['type'] === 'live_summary') return;
  }

  #onExit(code: number | null): void {
    this.#exited = true;
    this.#exitCode = code;
    this.#running = false;
    this.#options.log?.(`[live] 摄像头在场检测进程已退出（exit ${code ?? 'signal'}）`);
  }

  status(): LiveSensorsStatus {
    return {
      running: this.#running,
      cameraEnabled: this.#cameraEnabled,
      child: {
        running: this.#running,
        pid: this.#handle?.pid ?? null,
        source: this.#source,
        startedAt: this.#startedAt,
        frames: this.#frames,
        presenceEvents: this.#presenceEvents,
        lastNote: this.#lastNote,
        exitCode: this.#exitCode,
        exited: this.#exited,
      },
      lastFrame:
        this.#lastFrame === null
          ? null
          : {
              at: this.#lastFrame.at,
              frameIndex: this.#lastFrame.frameIndex,
              present: this.#lastFrame.present,
              confidence: this.#lastFrame.confidence,
              motionRatio: this.#lastFrame.motionRatio,
              faces: this.#lastFrame.faces,
              detectMs: this.#lastFrame.detectMs,
              jpegBytes: this.#lastFrame.jpegBytes,
              width: this.#lastFrame.width,
              height: this.#lastFrame.height,
              hasPicture: this.#lastFrame.dataUrl.length > 0,
            },
      privacy: LIVE_PRIVACY_NOTE,
    };
  }

  /** The frame itself, only for the endpoint that hands it to the page. */
  frame(): LiveFrameView | null {
    return this.#lastFrame;
  }

  /**
   * The latest frame as something the brain seam accepts (t88, 「看一眼」).
   *
   * Two guarantees live here rather than in the caller: the picture is **only** ever the newest
   * one (no backlog to send), and it must already be within the size cap — the perception child
   * encodes at `--frame-max-width` (480 px by default), and a wider frame is refused instead of
   * being sent big "because we could not scale it" (there is no image library in this project).
   */
  imageInput(maxWidthPx: number): { readonly mediaType: 'image/jpeg'; readonly base64: string; readonly width: number; readonly height: number; readonly bytes: number } | {
    readonly refused: string;
  } {
    const frame = this.#lastFrame;
    if (frame === null || frame.dataUrl.length === 0) return { refused: '现在还没有画面：先点「启用」，等到出现第一帧再按「看一眼」。' };
    if (frame.width > maxWidthPx) {
      return { refused: `这一帧宽 ${frame.width}px，超过上限 ${maxWidthPx}px：把「启用」的 --frame-max-width 调小后重试（本仓库没有图像库，不会偷偷放大/缩小再发）。` };
    }
    const prefix = 'data:image/jpeg;base64,';
    if (!frame.dataUrl.startsWith(prefix)) return { refused: '这一帧不是 JPEG，不能作为图片输入。' };
    return {
      mediaType: 'image/jpeg',
      base64: frame.dataUrl.slice(prefix.length),
      width: frame.width,
      height: frame.height,
      bytes: frame.jpegBytes,
    };
  }

  /**
   * Is the camera failing to deliver a picture (t103)?
   *
   * `null` means "no known problem" — either frames with a picture are arriving, or nothing has
   * been started yet (which the page shows as 「未启用」, a third state, not a fault). Otherwise:
   *
   *   * `unavailable`  — the child said so (its own Chinese message or OpenCV's backend warning),
   *                     or it exited with the perception edge's "no camera" code (2);
   *   * `no-frames`    — it has been running for `CAMERA_PROBLEM_GRACE_MS` and produced nothing;
   *   * `empty-frames` — frames arrive but carry no picture (`hasPicture === false`).
   *
   * The distinction matters because 「没人」 (the room is empty) and 「拿不到画面」 (the camera
   * cannot deliver) are different facts, and only one of them is about the room.
   */
  cameraProblem(): CameraProblem | null {
    if (!this.#running && this.#handle === null && this.#frames === 0 && this.#startedAt === null) return null; // never started
    const note = this.#lastNote;
    const forSeconds = (): number | null => {
      if (this.#startedAt === null) return null;
      const started = new Date(this.#startedAt).getTime();
      if (Number.isNaN(started)) return null;
      return Math.max(0, Math.round(((this.#options.now?.() ?? new Date()).getTime() - started) / 1000));
    };
    const noteLooksLikeCamera = note !== null && CAMERA_UNAVAILABLE_PATTERN.test(note);
    const exitLooksLikeCamera = this.#exited && this.#exitCode === 2;
    if (noteLooksLikeCamera || exitLooksLikeCamera) {
      return { kind: 'unavailable', title: CAMERA_PROBLEM_TITLE, note: CAMERA_PROBLEM_NOTE, steps: CAMERA_PROBLEM_STEPS, command: CAMERA_PROBE_COMMAND, childNote: note, forSeconds: forSeconds() };
    }
    if (this.#running && this.#frames === 0 && this.#startedAt !== null) {
      const started = new Date(this.#startedAt).getTime();
      const elapsed = Number.isNaN(started) ? 0 : (this.#options.now?.() ?? new Date()).getTime() - started;
      if (elapsed >= CAMERA_PROBLEM_GRACE_MS) {
        return { kind: 'no-frames', title: CAMERA_PROBLEM_TITLE, note: CAMERA_PROBLEM_NOTE, steps: CAMERA_PROBLEM_STEPS, command: CAMERA_PROBE_COMMAND, childNote: note, forSeconds: forSeconds() };
      }
    }
    if (this.#frames > 0 && this.#lastFrame !== null && this.#lastFrame.dataUrl.length === 0) {
      return { kind: 'empty-frames', title: CAMERA_PROBLEM_TITLE, note: CAMERA_PROBLEM_NOTE, steps: CAMERA_PROBLEM_STEPS, command: CAMERA_PROBE_COMMAND, childNote: note, forSeconds: forSeconds() };
    }
    return null;
  }
}

// ---------------------------------------------------- 「看一眼」 (t88)
//
// The manual still-frame path: the user presses a button, the *current* frame goes to the model
// once, and the reply is spoken and logged like any other turn. Three guarantees are structural:
//
//   1. **It is manual by default.** Nothing here is called by the consideration loop unless the
//      「允许西西自己看」 switch (default off) is on — autonomous looking is a separate decision.
//   2. **Every upload leaves a record** (time, size, trigger, question) with **no image bytes**,
//      written as a `system.health` row like the proactive settings audit.
//   3. **Nothing is persisted and nothing is continuous**: the picture is the newest frame the
//      console already holds in memory, it is sent once per press, and it is never written to disk.

/** Audit rows for still-frame uploads (`system.health`, `service = vision-look-once`). */
export const LOOK_ONCE_SERVICE = 'vision-look-once';
/** Setting rows for the vision switches (`system.health`, `service = vision-settings`). */
export const VISION_SETTINGS_SERVICE = 'vision-settings';
/** The picture sent to the model must be at most this wide (the child encodes at this width too). */
export const LOOK_ONCE_MAX_WIDTH = 480;
/** The question attached to a manual look when the user does not type one. */
export const LOOK_ONCE_DEFAULT_QUESTION = '看一眼：画面里有什么？用一句话说重点。';
/** Default of the 「允许西西自己看」 switch: off, so nothing looks without being asked. */
export const VISION_AUTO_LOOK_DEFAULT = false;

/** One auditable upload. Deliberately has no image field. */
export interface LookOnceRecord {
  readonly at: string;
  readonly trigger: LookOnceTrigger;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly question: string | null;
  readonly outcome: string;
  readonly sequence: number | null;
}

export interface LookOnceSettings {
  readonly autoLook: boolean;
  /** `console` = restored from the audit record; `default` = the shipped default (off). */
  readonly source: 'console' | 'default';
  readonly updatedAt: string | null;
}

/** Write one upload record — time, size, trigger, question; **never** the picture. */
export function recordLookOnce(
  store: XixiStore,
  info: LookOnceUploadInfo & { readonly trigger: LookOnceTrigger; readonly question: string | null; readonly outcome: string },
): LookOnceRecord {
  const at = new Date().toISOString();
  const detail = JSON.stringify({
    v: 1,
    at,
    trigger: info.trigger,
    width: info.width,
    height: info.height,
    bytes: info.bytes,
    question: info.question === null ? null : info.question.slice(0, 120),
    outcome: info.outcome,
    note: '只记录这一次上传的时间/大小/触发源/结果；图像本身没有写进任何记录，也没有落盘。',
  });
  const event = store.recordHealth(LOOK_ONCE_SERVICE, 'ok', detail.slice(0, 480));
  return { at, trigger: info.trigger, width: info.width, height: info.height, bytes: info.bytes, question: info.question, outcome: info.outcome, sequence: event.sequence };
}

/** Every upload recorded in this store, newest first (what the page lists). */
export function lookOnceHistory(store: XixiStore, limit = 20): LookOnceRecord[] {
  const rows: LookOnceRecord[] = [];
  for (const event of store.readEvents({ type: 'system.health', limit: Number.MAX_SAFE_INTEGER })) {
    const payload = event.payload as Record<string, unknown>;
    if (payload['service'] !== LOOK_ONCE_SERVICE) continue;
    const detail = payload['detail'];
    if (typeof detail !== 'string') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(detail) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed['v'] !== 1) continue;
    rows.push({
      at: typeof parsed['at'] === 'string' ? parsed['at'] : event.timestamp,
      trigger: parsed['trigger'] === 'auto' ? 'auto' : 'manual',
      width: Number(parsed['width'] ?? 0),
      height: Number(parsed['height'] ?? 0),
      bytes: Number(parsed['bytes'] ?? 0),
      question: typeof parsed['question'] === 'string' ? parsed['question'] : null,
      outcome: typeof parsed['outcome'] === 'string' ? parsed['outcome'] : '?',
      sequence: event.sequence,
    });
  }
  return rows.sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0)).slice(0, limit);
}

/** Persist the vision switch (default off) so a restart keeps the user's choice. */
export function persistVisionSettings(store: XixiStore, autoLook: boolean): StoredEvent {
  return store.recordHealth(VISION_SETTINGS_SERVICE, 'ok', JSON.stringify({ v: 1, autoLook, at: new Date().toISOString() }));
}

/** Read the vision switch back; anything unreadable falls back to the configured default (off). */
export function restoreVisionSettings(store: XixiStore, fallback: boolean = VISION_AUTO_LOOK_DEFAULT): LookOnceSettings {
  let latest: LookOnceSettings | null = null;
  for (const event of store.readEvents({ type: 'system.health', limit: Number.MAX_SAFE_INTEGER })) {
    const payload = event.payload as Record<string, unknown>;
    if (payload['service'] !== VISION_SETTINGS_SERVICE) continue;
    const detail = payload['detail'];
    if (typeof detail !== 'string') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(detail) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed['v'] !== 1) continue;
    latest = { autoLook: parsed['autoLook'] === true, source: 'console', updatedAt: event.timestamp };
  }
  return latest ?? { autoLook: fallback, source: 'default', updatedAt: null };
}

/** The permission sentence: what leaving this switch off means, in one line. */
export const VISION_NOTICE =
  '默认只有你按「看一眼」时才会把一张画面发给小米服务器；下面这个开关打开后西西才可能自己看（默认关）。每次上传都会留一条记录（时间/大小/触发源），记录里没有图像。';

export const PERCEPTION_SERVICE_DIR = join(REPO_ROOT, 'services', 'perception-edge');/** Enough OpenCV + numpy to run the detector: `verify-camera-presence.ts` probes the same way. */
const PERCEPTION_PROBE = 'import cv2, numpy';
let perceptionPython: string | null = null;

/**
 * Find a Python that can actually run the perception edge (t78).
 *
 * Same candidate order as `scripts/verify-camera-presence.ts` (which cannot be imported here: it
 * runs its verification at module load). The probe result is cached, and a failure is an explicit
 * Chinese error rather than "the picture is just empty".
 */
export function resolvePerceptionPython(log?: ((line: string) => void) | undefined): string {
  if (perceptionPython !== null) return perceptionPython;
  const candidates: string[] = [];
  const fromEnv = process.env.XIXI_PERCEPTION_PYTHON;
  if (fromEnv !== undefined && fromEnv.length > 0) candidates.push(fromEnv);
  for (const name of ['cv4', 'field-probe', 'voice-pipecat'] as const) {
    // POSIX layout first: on Linux `Scripts/python.exe` never exists, and trying it first
    // only adds two doomed `existsSync` calls per venv (the order matters for the hint below).
    candidates.push(...pythonCandidates(name));
  }
  candidates.push('python', 'python3');
  for (const candidate of candidates) {
    if ((candidate.includes('\\') || candidate.includes('/')) && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['-c', PERCEPTION_PROBE], { encoding: 'utf8', timeout: 60_000 });
    if (result.status === 0) {
      perceptionPython = candidate;
      log?.(`[live] 用这个 Python 跑摄像头在场检测：${candidate}`);
      return candidate;
    }
  }
  throw new Error(
    `找不到带 OpenCV 的 Python（试过 ${pythonCandidateHint(['cv4', 'field-probe', 'voice-pipecat'])}）；` +
      '建一个：python3 -m venv .venvs/cv4 然后 .venvs/cv4/bin/python3 -m pip install "opencv-python-headless<5" numpy' +
      '（Windows 上是 py -3.12 -m venv .venvs/cv4 与 .venvs/cv4/Scripts/python.exe）',
  );
}


/**
 * The real runner: the perception edge in `--live` mode.
 *
 * It reuses the shipped detection loop (`perception_edge.run --live`), so the presence events the
 * rest of the system sees are produced by the same code as always — the console only adds a
 * picture on stdout.
 *
 * V0.3 P0-B: the child is started **without `--db`/`--append`**. It used to be handed the store file
 * and append its own `events` + `world_state` rows; now it prints the envelope it built (validated
 * against the released schema by its own `build_presence_event`) and the console appends it through
 * `XixiStore.appendPresenceEvent` — one writer, one transaction, event and projection together
 * (pack `04_RUNTIME_CONSOLIDATION.md` §3). Detection stays in Python; persistence stays in the store.
 */
export function createPerceptionLiveRunner(options: {
  /** Resolved lazily: the probe costs a Python start, so it only happens when 启用 is pressed. */
  readonly python: () => string;
  readonly serviceDir: string;
  readonly repoRoot: string;
  readonly log?: ((line: string) => void) | undefined;
}): LiveCameraRunner {
  return {
    start(settings) {
      const python = options.python();
      const args = [
        '-m',
        'perception_edge.run',
        '--live',
        '--source',
        settings.source,
        ...(settings.scenario === null || settings.scenario === undefined ? [] : ['--scenario', settings.scenario]),
        '--camera-index',
        String(settings.cameraIndex),
        '--quiet-frames',
      ];
      const child = spawn(python, args, {
        cwd: options.serviceDir,
        env: { ...process.env, PYTHONPATH: options.serviceDir, PYTHONUNBUFFERED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffered = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          settings.onLine(line);
          // V0.3 P0-B: presence events travel to the store through this seam — the child has no
          // database of its own any more. `record` is the child's routing key, checked by the ingest.
          if (line.includes('"record":"event"')) settings.onPresenceEvent(line);
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          options.log?.(`[live/child] ${trimmed.slice(0, 300)}`);
          // Non-JSON output is the child complaining (camera busy, bad DB path): the panel must
          // show it, otherwise 启用 looks like it silently did nothing.
          settings.onLine(trimmed);
        }
      });
      child.on('exit', (code) => settings.onExit(code));
      child.on('error', (error) => {
        settings.onLine(`子进程启动失败：${error.message}`);
        settings.onExit(null);
      });
      return {
        pid: child.pid ?? -1,
        kill: () => {
          // Close the pipe first: the child's own watcher stops the loop on stdin EOF, flushes
          // `live_summary` and exits — that is the orderly path. Only if it is still alive after a
          // couple of seconds do we terminate it (Windows `kill()` is TerminateProcess, which gives
          // the child no chance to finish, so it must not be the first move). Either way the camera
          // gets released: 停用 must never leave the device busy.
          try {
            child.stdin?.end();
          } catch {
            /* the pipe may already be gone */
          }
          const hardStop = setTimeout(() => {
            try {
              child.kill('SIGTERM');
            } catch {
              /* already dead */
            }
          }, 2500);
          child.once('exit', () => clearTimeout(hardStop));
        },
        write: (line: string) => {
          try {
            child.stdin?.write(`${line}\n`);
          } catch {
            /* ignore */
          }
        },
      };
    },
  };
}

/**
 * Which database each entry point uses (V0.3 P0-B).
 *
 * The table is no longer hand-written here: `CANONICAL_STORE_ENTRIES` in `@xixi/domain` is the one
 * source, and the resolver that picks the directory reads the same constants. Keeping a second list
 * in this file is exactly how the page ended up claiming 「四个入口各用不同的库」 long after that
 * stopped being the design.
 *
 * The type is the entries' own shape (`typeof CANONICAL_STORE_ENTRIES[number]`), so a field added
 * to the source — `measurement`, `legacyEnv` — reaches the pages without a second declaration here.
 */
export const XIXI_DB_ENTRIES: readonly {
  readonly entry: string;
  readonly command: string;
  readonly dir: string;
  /** `legacyEnv` is dropped: the page has no business printing an environment variable it does not read. */
  readonly measurement?: boolean;
}[] = CANONICAL_STORE_ENTRIES.map((item) => ({
  entry: item.entry,
  command: item.command,
  dir: item.dir,
  ...(item.measurement === true ? { measurement: true } : {}),
}));

/**
 * The one-sentence 「these entries share a store」 note both pages print.
 *
 * Derived from `CANONICAL_STORE_ENTRIES` (the same table the page lists) and from
 * `CANONICAL_DATA_DIR` / `CANONICAL_DATA_DIR_ENV`, so the sentence cannot survive a change to the
 * wiring: the hard-coded 「四个入口各用不同的库」 this replaces was true in V0.2 and false the moment
 * P0-B landed — it outlived the design by a single commit, which is exactly the failure mode
 * `docs/README.md` §5.1 warns about.
 */
export function storeNoteText(
  entries: readonly { readonly dir: string; readonly measurement?: boolean }[] = CANONICAL_STORE_ENTRIES,
): string {
  const shared = entries.filter((item) => item.dir === CANONICAL_DATA_DIR).length;
  const isolatable = entries.filter((item) => item.measurement === true).length;
  return (
    `household 入口默认连同一个库（${CANONICAL_DATA_DIR_ENV}，未设则 ${CANONICAL_DATA_DIR}）：` +
    `${shared} 个入口共用它，人格与历史互通；` +
    `单个入口可用自己的开关隔离（各自的 *DATA_DIR 环境变量、--data-dir${isolatable > 0 ? '、测量入口的 --isolated-store' : ''}），` +
    '测试与评测走临时目录。'
  );
}

/**
 * What is *actually* segmented — one function, three states, no drifting constants.
 *
 * ADR-0010 is about how a reply is spoken; pack Phase 8 changed the other half of the sentence.
 * A page must not claim a granularity it is not running, so the text is derived from the wiring
 * (`createFieldServer` passes the mode it really installed) instead of a module constant that
 * goes stale the moment the wiring changes — the t42 acceptance item this note exists for
 * (「a user must not conclude from the moving bubbles that the audio is segmented too」) is
 * satisfied by telling the truth, not by freezing one version of it.
 */
export function segmentTtsNote(mode: 'streaming' | 'whole-reply' | 'none'): string {
  const head = '多段回复（ADR-0010）：文字与播放计划真的按段（每段之间停 450ms，页面逐条出现）。';
  if (mode === 'streaming') {
    return `${head}语音合成（TTS）现在是**流式**的：回复边生成边按句读切块（ClauseChunker），第一块立刻合成并在浏览器里开始播，后面的块边生成边合成（pack Phase 8）。`;
  }
  if (mode === 'whole-reply') {
    return `${head}这台控制台没有接流式语音（没有 TTS sink），所以语音仍按整条回复一次合成。`;
  }
  return `${head}这台控制台当前没有可用的语音合成（没有密钥或朗读被关掉），所以只有文字、没有声音。`;
}

/** The 「本页用哪个库」block, shared by both pages. `currentDir` is the running page's own path. */
export function databaseNoteHtml(currentDir: string): string {
  // Defensive: this is a pure page helper, and a page must never crash because one display
  // field was missing (t42's `ReferenceError: dataDir is not defined` took the whole console
  // down). An unknown path renders as 「未知」 rather than throwing.
  const current = typeof currentDir === 'string' && currentDir.length > 0 ? currentDir : '（未知）';
  const rows = XIXI_DB_ENTRIES.map((item) => {
    // Exit 6 of the V0.3 repair round: a measurement entry is the one that can be pointed at its own
    // store with a flag, and the page has to say so — otherwise a reader assumes `npm run voice:turn`
    // measures the household Xixi when it happens to be running against a private one.
    const isolatable = item.measurement === true ? '，可 <code>--isolated-store</code> 隔离' : '';
    return `<li><code>${item.command}</code> → <code>${item.dir}</code>（${item.entry}）${isolatable}${current.endsWith(item.dir) ? ' ← <b>本页</b>' : ''}</li>`;
  }).join('');
  return (
    `<div class="muted">本页数据库：<code>${current}</code>｜<b>${storeNoteText()}</b>` +
    `<ul style="margin:4px 0 4px 18px; padding:0">${rows}</ul></div>`
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
  talkativeness: 'px-talkativeness',
  talkativenessNow: 'px-talkativeness-now',
  verbosity: 'px-verbosity',
  verbosityNow: 'px-verbosity-now',
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
    <div class="muted">这一块决定「西西什么时候可以主动开口」。分两层：<b>硬底线由程序判定</b>（静默时段、6 小时与当日额度、安静模式、隐私与同意）——这些旋钮放宽不了它们；底线之上<b>由模型读空气决定说不说</b>，下面这些分数只提供候选与依据（冷却、话题重复、未回应都是<b>扣分项，不是禁止</b>）。保存后<b>立即生效</b>，并入一条审计记录（重启后仍是这套值）。</div>
    <div style="margin:8px 0"><label><input type="checkbox" id="${id.enabled}" /> 允许西西主动开口</label> <span class="muted" id="${id.summary}">加载中…</span></div>
    <div class="px-grid">
      <label>打扰代价衰减（分钟）<input type="number" id="${id.cooldown}" min="0" max="1440" /></label>
      <label>6 小时额度<input type="number" id="${id.per6h}" min="0" max="100" /></label>
      <label>当日额度<input type="number" id="${id.perDay}" min="0" max="100" /></label>
      <label>静默时段起<input type="text" id="${id.quietStart}" placeholder="22:30" /></label>
      <label>静默时段止<input type="text" id="${id.quietEnd}" placeholder="07:00" /></label>
      <label>同话题窗口（小时）<input type="number" id="${id.topic}" min="0" max="720" /></label>
      <label>负面反馈倍率<input type="number" id="${id.negative}" min="1" max="10" step="0.5" /></label>
      <label>主动性总强度（人格 proactivity）<input type="number" id="${id.proactivity}" min="0" max="1" step="0.05" /></label>
      <label>话痨程度（人格 talkativeness）<input type="number" id="${id.talkativeness}" min="0" max="1" step="0.05" /></label>
      <label>话的长度（人格 verbosity）<input type="number" id="${id.verbosity}" min="0" max="1" step="0.05" /></label>
    </div>
    <div class="muted">上面三个是<b>人格</b>值（进 <code>self_profile</code>，留 <code>self_profile_history</code>）：主动性只把<b>建议线</b>改成 <code>0.45 + 0.30 × (1 − proactivity)</code>，<b>硬底线一道都不会被跳过</b>，模型也可以对建议说「不说」；话痨/话长直接改提示词里的说话方式。当前生效值：主动性 <b id="${id.proactivityNow}">—</b>、话痨 <b id="${id.talkativenessNow}">—</b>、话长 <b id="${id.verbosityNow}">—</b></div>
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
  pxSet('talkativeness', state.personality.talkativeness);
  pxSet('verbosity', state.personality.verbosity);
  var nowBoxes = [
    [PX.ids.proactivityNow, state.personality.proactivity],
    [PX.ids.talkativenessNow, state.personality.talkativeness],
    [PX.ids.verbosityNow, state.personality.verbosity],
  ];
  for (var box = 0; box < nowBoxes.length; box += 1) {
    var node = document.getElementById(nowBoxes[box][0]);
    if (node) node.textContent = String(nowBoxes[box][1]);
  }
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
      // row.live distinguishes the sources this console can really produce today from the ones
      // that are registered but have no fact source yet (t74): the panel must not promise a
      // trigger that can never fire.
      return '<label style="margin-right:10px" title="' + (row.live ? '会自己产生候选' : '已登记，但这一轮还不会自己产生候选（缺事实来源）') + '">'
        + '<input type="checkbox" data-trigger="' + row.trigger + '"' + (row.enabled ? ' checked' : '') + ' /> '
        + row.label + (row.live ? '' : '（这一轮还不会自己产生候选）') + '</label>';
    }).join('')
      // pack Phase 3：话题来源与「现在记着哪些没办完的事」。来源里只有 open_thread 会自己产生候选，
      // 其余（新闻/日历/共同记忆…）还没事实来源 —— 如实标出来，不假装能用。
      + '<div class="muted" style="margin-top:6px">话题来源：' + (state.topicSources || []).map(function (row) {
          return row.source + (row.live ? '（会自己产生候选）' : '（已登记，还没有事实来源）');
        }).join('、') + '</div>'
      + (state.openThreads ? '<div class="muted">没办完的事：' + (state.openThreads.threads.length === 0 ? '暂时没有' : state.openThreads.threads.map(function (row) {
          return row.summary + '（' + row.status + (row.attempts > 0 ? '，已问 ' + row.attempts + ' 次' : '') + '）';
        }).join('；')) + '</div>' : '');
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
/** 看一眼 的开关与上传记录（t88）: refreshed with the live payload, so the panel always matches. */
async function pxLoadVision() {
  try {
    var payload = await (await fetch(PX.base + '/live')).json();
    if (payload.ok !== false && payload.vision) pxRenderVision(payload.vision);
  } catch (error) {
    /* the live endpoint is refreshed every second anyway */
  }
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
  // Only send a personality value when the box really holds a number: an empty box must not be
  // read as 0 (which would silently make 西西 maximally willing to speak).
  var personalityFields = ['proactivity', 'talkativeness', 'verbosity'];
  for (var field = 0; field < personalityFields.length; field += 1) {
    var name = personalityFields[field];
    var raw = pxVal(name);
    if (raw !== undefined && String(raw).trim() !== '' && isFinite(Number(raw))) patch[name] = Number(raw);
  }
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
    // The drill speaks too (t74): the same TTS path as the resident loop, so 「演练」 can be used
    // to check the speaker without waiting for the loop to fire.
    if (drill.audio) pxPlayClips(drill.audio, drill.gapMs);
    if (drill.audioNote && target) {
      var drillNote = document.createElement('div');
      drillNote.className = 'muted';
      drillNote.textContent = drill.audioNote;
      target.appendChild(drillNote);
    }
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
  // t98: 为什么没跟你打招呼 —— 在场投影不能当「有人到达」用时要说清原因。
  var presenceNote = payload.presence && payload.presence.fresh !== true
    ? '｜在场投影这次不能当「有人到达」用：' + payload.presence.reason
    : '';
  if (node) {
    node.textContent = (payload.status.running ? '运行中' : '已停止')
      + '（间隔 ' + Math.round(payload.status.intervalMs / 1000) + 's，已考虑 ' + payload.status.ticks + ' 次）'
      + '｜' + (payload.tts && payload.tts.available ? '会真的发声' : '只显示文字：' + ((payload.tts && payload.tts.note) || ''))
      + presenceNote;
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
    + (entry.imageUsed ? ' · 附了 1 张静帧' : '')
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
    // t78: the 对话记录 column shows 西西's own lines too, labelled 「主动开口」.
    pxAppendConversation('xixi', entry.text, entry.segments, entry.gapMs, entry.triggerLabel);
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

/* ---------------------------------------------------------------- 启用 + 传感器（t78） */

/**
 * t103: show 「摄像头交不出画面」 as its own state, never as 「房间没人」.
 *
 * The block is filled from the payload's cameraProblem field; when there is none, it disappears.
 * The presence headline is replaced by 「未知（摄像头交不出画面）」 in that state, because "the
 * camera cannot deliver a picture" says nothing about whether somebody is home.
 */
function pxCamProblem(problem) {
  var box = document.getElementById('px-cam-problem');
  if (!box) return;
  if (!problem) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  var title = document.getElementById('px-cam-problem-title');
  if (title) title.textContent = problem.title;
  var note = document.getElementById('px-cam-problem-note');
  if (note) note.textContent = problem.note;
  var steps = document.getElementById('px-cam-problem-steps');
  if (steps) {
    steps.innerHTML = '';
    for (var i = 0; i < problem.steps.length; i += 1) {
      var li = document.createElement('li');
      li.textContent = problem.steps[i];
      steps.appendChild(li);
    }
  }
  var command = document.getElementById('px-cam-problem-command');
  if (command) command.textContent = problem.command;
  var raw = document.getElementById('px-cam-problem-raw');
  if (raw) {
    raw.textContent = '子进程说：' + (problem.childNote || '（没有输出）')
      + '｜判据：' + problem.kind
      + (problem.forSeconds === null ? '' : '，已经这样 ' + problem.forSeconds + 's');
  }
  // And the headline above must stop claiming anything about the room.
  var presence = document.getElementById('presence-text');
  if (presence) presence.textContent = '未知（摄像头交不出画面，不是「没人」）';
}

/** Append one line to the 对话记录 column (the user's own turns come from renderTurn above). */
function pxAppendConversation(who, text, segments, gapMs, label) {
  var box = document.getElementById('turns');
  if (!box) return;
  if (box.classList.contains('muted')) { box.className = ''; box.innerHTML = ''; }
  var item = document.createElement('div');
  item.className = 'item';
  var head = document.createElement('div');
  head.className = 'head';
  var tag = document.createElement('span');
  tag.className = 'tag pass';
  tag.textContent = who === 'xixi' ? '主动开口' : '你';
  head.appendChild(tag);
  var meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent = (label ? label + ' · ' : '') + new Date().toLocaleTimeString()
    + (segments && segments.length > 1 ? ' · 分 ' + segments.length + ' 段（段间 ' + gapMs + 'ms）' : '');
  head.appendChild(meta);
  item.appendChild(head);
  var rows = segments && segments.length > 0 ? segments : [text];
  for (var i = 0; i < rows.length; i += 1) {
    var line = document.createElement('div');
    line.style.margin = '4px 0';
    line.textContent = (rows.length > 1 ? '第 ' + (i + 1) + '/' + rows.length + ' 段：' : '') + rows[i];
    item.appendChild(line);
  }
  box.insertBefore(item, box.firstChild);
}

function pxLiveState(status) {
  var pill = document.getElementById('px-enable-state');
  var detail = document.getElementById('px-enable-detail');
  var child = status.status.child;
  if (pill) {
    pill.textContent = status.status.running ? '已启用' : '未启用';
    pill.className = 'pill ' + (status.status.running ? 'good' : '');
  }
  if (detail) {
    detail.textContent = '摄像头检测：' + (child.running ? '运行中（pid ' + child.pid + '，已收 ' + child.frames + ' 帧，在场事件 ' + child.presenceEvents + ' 次）' : (child.exited ? '已退出（上次 exit ' + (child.exitCode === null ? '信号' : child.exitCode) + '）' : '未启动'))
      + '；主动循环：' + (status.loop.running ? '运行中（每 ' + Math.round(status.loop.intervalMs / 1000) + 's，已考虑 ' + status.loop.ticks + ' 次）' : '未运行')
      + (child.lastNote ? '｜子进程说：' + child.lastNote : '');
  }
  var ttsBox = document.getElementById('px-tts-switch');
  if (ttsBox) ttsBox.checked = status.ttsEnabled === true;
  var camBox = document.getElementById('px-camera-switch');
  if (camBox) camBox.checked = status.status.cameraEnabled !== false;
}

function pxLiveSensors(payload) {
  var frame = payload.frame;
  var img = document.getElementById('px-cam');
  var note = document.getElementById('px-cam-note');
  if (img && frame && frame.dataUrl) img.src = frame.dataUrl;
  if (note) {
    note.textContent = frame
      ? '第 ' + frame.frameIndex + ' 帧 · ' + frame.width + 'x' + frame.height + ' · ' + Math.round(frame.jpegBytes / 1024) + 'KB · 检测耗时 ' + frame.detectMs.toFixed(1) + 'ms · ' + new Date(frame.at).toLocaleTimeString() + '（不保存图像：只在内存与 localhost；在场事件照常入库）'
      : (payload.status.child.running ? '正在等第一帧…' : '未启用：点上面的「启用」开始——画面只在内存里显示，不产生任何图像文件。');
  }
  var frames = document.getElementById('px-live-frames');
  var frameNote = document.getElementById('px-live-frame-note');
  if (frames) frames.textContent = payload.status.child.frames;
  if (frameNote && frame) frameNote.textContent = '最新一帧 ' + Math.round(frame.jpegBytes / 1024) + 'KB，' + frame.width + 'x' + frame.height + '，置信度 ' + frame.confidence.toFixed(2) + '，faces=' + frame.faces + '，motion=' + frame.motionRatio.toFixed(4);
  if (frame) {
    var presenceText = document.getElementById('presence-text');
    if (presenceText) presenceText.textContent = frame.present ? '有人在场（实时）' : '没看到人（实时）';
  }
  // t103 last, so it wins over the frame wording: 「交不出画面」 is not 「没看到人」.
  pxCamProblem(payload.cameraProblem || null);
}

async function pxLiveRefresh() {
  var payload = await (await fetch(PX.base + '/live')).json();
  if (payload.ok === false) return;
  pxLiveState(payload);
  pxLiveSensors(payload);
  if (payload.vision) pxRenderVision(payload.vision);
  return payload;
}

async function pxEnable(on) {
  var seconds = Number(pxVal('enableInterval'));
  var camBox = document.getElementById('px-camera-switch');
  var body = {
    action: on ? 'start' : 'stop',
    camera: camBox ? camBox.checked : true,
    intervalMs: (isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000,
  };
  var payload = await pxPost('/live', body);
  if (payload.ok === false) {
    showError('px-live-error', '启用失败：' + payload.error, payload.hint);
    return;
  }
  clearError('px-live-error');
  pxLiveState(payload);
  pxLiveSensors(payload);
  pxStatus(on ? '已启用西西：摄像头在场检测 + 常驻主动循环（已立刻考虑一次）' : '已停用：子进程与主动循环都停了');
  // The stop must be visible: ask again right away so the page shows 「已退出」.
  if (!on) setTimeout(function () { void pxLiveRefresh(); }, 800);
}

async function pxTtsToggle(on) {
  var payload = await pxPost('/tts', { enabled: on });
  if (payload.ok === false) { pxStatus('朗读开关失败：' + payload.error); return; }
  pxStatus(on ? '朗读已打开' : '朗读已关闭（只有文字）');
  void pxLiveRefresh();
}

/* ---------------------------------------------------------------- 「看一眼」（t88） */

function pxRenderVision(vision) {
  var box = document.getElementById('px-vision-auto');
  if (box) box.checked = vision.autoLookEnabled === true;
  var histNote = document.getElementById('px-look-history-note');
  if (histNote) {
    histNote.textContent = '上传记录（只有时间/大小/触发源，没有图像）：共 ' + vision.uploads + ' 次' + (vision.historyNote ? '｜' + vision.historyNote : '');
  }
  var hist = document.getElementById('px-look-history');
  if (hist) {
    if (!vision.history || vision.history.length === 0) { hist.textContent = ''; return; }
    hist.innerHTML = vision.history.map(function (row) {
      var when = new Date(row.at).toLocaleTimeString();
      var size = Math.round((row.bytes || 0) / 1024) + 'KB';
      return '<div>· ' + when + '｜' + (row.trigger === 'auto' ? '自己看' : '手动') + '｜' + row.width + 'x' + row.height + '｜' + size + '｜' + row.outcome + '</div>';
    }).join('');
  }
  var privacy = document.getElementById('px-look-privacy');
  if (privacy && vision.privacyNote) privacy.textContent = vision.privacyNote;
}

async function pxLook() {
  var question = pxVal('lookQuestion');
  pxStatus('正在把这一帧发给模型…');
  var payload = await pxPost('/look', { question: question === undefined ? '' : String(question) });
  if (payload.vision) pxRenderVision(payload.vision);
  if (payload.ok === false) {
    pxStatus('这次没看成：' + payload.error.message);
    showError('px-look-status', '', '');
    var status = document.getElementById('px-look-status');
    if (status) status.textContent = '失败：' + payload.error.message;
    return;
  }
  var status = document.getElementById('px-look-status');
  if (status) {
    status.textContent = payload.noAnswer
      ? '看过了，但模型没给内容'
      : '看过了（' + payload.latencyMs + 'ms，' + payload.provider + '/' + payload.model + '）';
  }
  if (payload.noAnswer) {
    pxAppendConversation('xixi', payload.noAnswerNote, [], 0, '看一眼（没给内容）');
    pxStatus(payload.noAnswerNote);
    return;
  }
  pxAppendConversation('xixi', payload.reply, payload.segments, payload.gapMs, '看一眼');
  if (payload.audio) pxPlayClips(payload.audio, payload.gapMs);
  if (payload.audioNote) pxStatus(payload.audioNote);
  else pxStatus('看一眼完成：回复在右栏「对话记录」里（也朗读出来了）');
}

async function pxVisionToggle(on) {
  var payload = await pxPost('/vision', { autoLook: on });
  if (payload.ok === false) { pxStatus('开关失败：' + payload.error.message); return; }
  pxRenderVision(payload.vision);
  pxStatus(on ? '已允许西西自己看（默认关，打开后仍要过全部硬门禁）' : '已恢复为「只有你按看一眼才传画面」');
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
  // t78: the one-button 启用/停用 + the two switches + the live sensor view.
  var enable = document.getElementById('px-enable'); if (enable) enable.addEventListener('click', function () { void pxEnable(true); });
  var disable = document.getElementById('px-disable'); if (disable) disable.addEventListener('click', function () { void pxEnable(false); });
  var tts = document.getElementById('px-tts-switch'); if (tts) tts.addEventListener('change', function () { void pxTtsToggle(tts.checked); });
  var camSwitch = document.getElementById('px-camera-switch'); if (camSwitch) camSwitch.addEventListener('change', function () { pxStatus(camSwitch.checked ? '摄像头在场检测已打开（下次启用生效）' : '摄像头在场检测已关闭（只跑主动循环）'); });
  // t88: the manual 「看一眼」 button and the default-off autonomy switch.
  var look = document.getElementById('px-look'); if (look) look.addEventListener('click', function () { void pxLook(); });
  var visionAuto = document.getElementById('px-vision-auto'); if (visionAuto) visionAuto.addEventListener('change', function () { void pxVisionToggle(visionAuto.checked); });
  void pxLoad();
  void pxLoadVision();
  void pxLoopPoll();
  void pxLiveRefresh();
  PX.loopPoller = setInterval(function () { void pxLoopPoll(); }, 2000);
  // The sensor column must show *now*: frames every second while the camera loop runs.
  PX.livePoller = setInterval(function () { void pxLiveRefresh(); }, 1000);
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
  main { padding:16px; display:grid; gap:14px; align-items:start; grid-template-columns:minmax(320px,1fr) minmax(320px,1fr) minmax(320px,1fr); max-width:1800px; margin:0 auto; }
  /* t78: three columns — 传感器 / 配置 / 对话记录. Below 1200px they stack, so the page stays usable. */
  @media (max-width:1200px) { main { grid-template-columns:1fr; } }
  .col { display:grid; gap:14px; align-content:start; min-width:0; }
  .col > section.card { margin:0; }
  #px-cam:not([src]), #px-cam[src=""] { min-height:180px; }
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
  footer form { max-width:900px; margin:0 auto; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  footer input[type=text] { flex:1; min-width:200px; }
  /* The controls row must not reflow: the mic button's own label changes (按住说 → 松开发送) and the
     hint text changes on every step, so pin the button width and push the hint onto its own line. */
  footer #mic { min-width:108px; }
  footer #hint { flex-basis:100%; margin-top:2px; }
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
  <div class="col" id="col-sensors">
    <section class="card" id="px-enable-card">
      <h2>启用西西（一键）</h2>
      <div class="muted">开启 <b>摄像头在场检测</b>（<code>perception_edge.run --live</code>，画面只在内存里）+ <b>常驻主动循环</b>，并且<b>立刻先考虑一次</b>，之后按间隔继续。</div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:10px 0">
        <button id="px-enable" class="primary">启用</button>
        <button id="px-disable">停用</button>
        <span class="pill" id="px-enable-state">未启用</span>
        <span class="muted" id="px-enable-detail">子进程与循环都还没起来</span>
      </div>
      <div class="muted" id="px-live-privacy">${LIVE_PRIVACY_NOTE}</div>
      <div class="muted" id="px-live-error"></div>
    </section>

    <section class="card">
      <h2>摄像头在场状态（M6）与实时画面</h2>
      <div class="err" id="px-cam-problem" style="display:none; border-color:#7a3b12; background:#2a1a0d; color:#ffd9ad">
        <b id="px-cam-problem-title">摄像头现在交不出画面（不是房间没人）</b>
        <div class="muted" id="px-cam-problem-note" style="margin-top:6px"></div>
        <ol class="steps" id="px-cam-problem-steps" style="margin:6px 0 0"></ol>
        <div class="muted" style="margin-top:6px">自查命令（在 services/perception-edge 下跑）：<code id="px-cam-problem-command"></code></div>
        <div class="muted" id="px-cam-problem-raw" style="margin-top:6px"></div>
      </div>
      <img id="px-cam" alt="摄像头实时画面" style="width:100%; max-width:480px; border-radius:10px; background:#0b0d11; border:1px solid #262a33; display:block" />
      <div class="muted" id="px-cam-note">未启用：点上面的「启用」开始——摄像头实时画面只在内存里显示，不写任何文件。</div>
      <div class="big" id="presence-text" style="margin-top:8px">—</div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:8px 0">
        <button id="px-look" class="primary">看一眼（把这一帧发给小米服务器）</button>
        <input type="text" id="px-look-question" placeholder="想问什么？（可留空）" style="flex:1; min-width:180px" />
        <span class="muted" id="px-look-status">还没看过</span>
      </div>
      <div class="muted" id="px-look-privacy">${VISION_NOTICE}</div>
      <div class="muted" id="px-look-history-note">上传记录（只有时间/大小/触发源，没有图像）：还没有记录。</div>
      <div id="px-look-history" class="muted"></div>
      <table>
        <tr><th style="width:44%">字段</th><th>含义</th></tr>
        <tr><td>来源 <b id="presence-mode">—</b></td><td id="presence-mode-help">在场状态从哪里来</td></tr>
        <tr><td>置信度 <b id="presence-confidence">—</b></td><td>检测器有多确定（0–1）。</td></tr>
        <tr><td>更新时间 <b id="presence-updated">—</b></td><td>这条状态是什么时候写的；<b>过期就不代表「现在」</b>。</td></tr>
        <tr><td>实时帧 <b id="px-live-frames">—</b></td><td id="px-live-frame-note">已收到的帧数 / 最新一帧大小与置信度（来自子进程 stdout，只留在内存）。</td></tr>
      </table>
      <div class="muted" id="presence-note">加载中…</div>
      <div class="muted">摄像头能不能用、画面是否正常，看下面的「设备自检 → 摄像头」；这里显示的是<b>在场判定</b>本身。</div>
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
      <h2>本页用的是哪个数据库</h2>
      ${databaseNoteHtml(boot.databasePath)}
    </section>

    <section class="card">
      <h2>设备验收引导（麦克风 → 扬声器 → 摄像头）</h2>
      <div class="muted">点一次「开始设备自检」：程序会自己录 3 秒环境声、放 3 遍音频并用麦克风回采、再打开摄像头取 15 帧。全程约 20–35 秒，不需要你说话。结果与「下一步动作」会写进 <code>docs/recon/field-test-report-&lt;日期&gt;.md</code>。</div>
      <div class="muted">扬声器一项会给两个口径的数字：<b>能量比</b>（主判据，保守，≥10 dB）与<b>帧级分位</b>（乐观上界，仅参考）。只看分位会高估声学余量。</div>
      <div style="margin:10px 0"><button id="accept" class="primary">开始设备自检</button> <span class="muted" id="accept-status"></span></div>
      <div id="accept-items"></div>
      <div id="accept-error"></div>
    </section>
  </div>

  <div class="col" id="col-config">
    <section class="card" id="px-run-switches">
      <h2>运行开关（启用/停用用左栏那个按钮）</h2>
      <table>
        <tr><th style="width:46%">开关</th><th>说明</th></tr>
        <tr><td><label><input type="checkbox" id="px-camera-switch" checked /> 摄像头在场检测</label></td><td>关掉就只跑主动循环（没有现场画面，也没有「有人到家」这个事实来源）。</td></tr>
        <tr><td><label><input type="checkbox" id="px-tts-switch" /> 朗读（TTS）</label></td><td>回复与主动开口是否合成语音；关掉就只有文字。改完立刻生效，不用重启。</td></tr>
        <tr><td>循环间隔 <input type="number" id="px-enable-interval" min="5" max="3600" step="5" value="30" style="width:88px" /> 秒</td><td>主动循环多久考虑一次（下限 5 秒）；点「启用」会立刻先考虑一次，之后按这个间隔继续。</td></tr>
        <tr><td><label><input type="checkbox" id="px-vision-auto" /> 允许西西自己看（默认关）</label></td><td>打开后，主动开口时可能附带一张当前画面（仍要过全部硬门禁；每次上传都留记录）。默认关 = 只有你按「看一眼」才会传画面。</td></tr>
      </table>
      <div class="muted">这三个开关和下面的「主动性」是同一套设置：都在中栏，改完立刻生效、留审计。</div>
    </section>
    <section class="card">
      <h2>怎么用（三步）</h2>
      <ol class="steps">
        <li>先点左栏最上面的 <b>启用</b>：摄像头在场检测 + 主动循环一起起来，西西会立刻先考虑一次。</li>
        <li>看左栏的<b>摄像头画面</b>与<b>麦克风电平</b>：不说话时电平在 <b>−60 ~ −30 dBFS</b> 之间是正常的。</li>
        <li>按住页面最下面的 <b>🎤 按住说</b> 说一句，然后在右栏看结果（转写、<b>动作</b>：说话 / 沉默 / 拒绝原因、延迟分段）；西西自己开口的话也在右栏，标着「主动开口」。</li>
      </ol>
      <div class="muted" style="margin-top:8px">结束：回到启动它的终端按 <code>Ctrl+C</code>。页面只监听本机（127.0.0.1），别人访问不到。</div>
      <div id="page-error"></div>
    </section>

${proactivePanelHtml()}

    <section class="card">
      <h2>隐私与保留策略</h2>
      <div id="privacy-detail" class="muted">加载中…</div>
      <div class="muted" style="margin-top:8px">原始整段录音<b>不落盘</b>：它只在系统临时目录里存在到 VAD 结束，随后立即删除；没有语音时磁盘上不会留下任何录音。语音段只在配置明确要求时才写入 <code>data/voice-web/</code>，并按保留期自动清理。摄像头同理<b>不保存图像</b>：这一页的每一帧都只在内存与 localhost 之间，不产生图像文件、不上传；<b>但摄像头产生的在场事件（presence.changed 与 world_state 投影）会照常写进本地库</b>——事件才是产品，画面只是给你看的。</div>
    </section>
  </div>

  <div class="col" id="col-conversation">
    <section class="card">
      <h2>对话记录（你 → 西西，以及西西自己开口）</h2>
      <div id="turns" class="muted">还没有轮次。按住 🎤 说一句试试，或先点左栏的「启用」让西西自己开口。</div>
      <div class="muted" style="margin-top:6px">多段回复（ADR-0010）在这里显示为「第 i/N 段 · 段间 450ms」（页面上逐条出现，终端也逐条打印）；完整一条也会写进事件日志。标注「主动开口」的条目是西西<b>没过问你就说的</b>，它也过了全部硬门禁。</div>
      <div class="err" style="border-color:#5c4a22; background:#2a2314; color:#ffe6b8; margin-top:8px">${segmentTtsNote(!boot.ttsEnabled ? 'none' : boot.ttsMode === 'streaming' ? 'streaming' : 'whole-reply')}</div>
    </section>
  </div>
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
var recordingUrls = [];

${proactivePanelScript('/api/field')}
${XIXI_PLAYBACK_JS}

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
  // t21 (t12 F2): why this turn was silent, and whether the provider cut the reply short. Without
  // these lines 「整轮只剩制品」 and 「模型自己选择沉默」 look identical in the right column.
  if (turn.silenceReasonText) {
    var why = document.createElement('div');
    why.className = 'muted';
    why.textContent = '沉默原因：' + turn.silenceReasonText;
    item.appendChild(why);
  }
  if (turn.hygiene) {
    var hygiene = document.createElement('div');
    hygiene.className = 'muted';
    hygiene.textContent = '清洗：剔除标记 ' + turn.hygiene.removedMarkupChars + ' 字、markdown ' + turn.hygiene.removedMarkdownChars
      + ' 字、英文推理 ' + turn.hygiene.removedReasoningChars + ' 字' + (turn.hygiene.emptied ? '（剩余为空）' : '');
    item.appendChild(hygiene);
  }
  if (turn.finishReason && turn.finishReason !== 'stop') {
    var finish = document.createElement('div');
    finish.className = 'muted';
    finish.textContent = '停止原因：' + turn.finishReason + (turn.finishReason === 'length' ? '（被 token 上限截断，句子可能没说完）' : '');
    item.appendChild(finish);
  }
  if (turn.transcript) {
    var said = document.createElement('div');
    said.textContent = '听到：' + turn.transcript;
    item.appendChild(said);
  }
  if (turn.audioUrl) {
    // Play back what this page actually recorded (browser memory only, never uploaded beyond the
    // same /api/voice call) — the direct answer to "为什么显示未识别到".
    var listen = document.createElement('div');
    listen.style.marginTop = '4px';
    var play = document.createElement('button');
    play.type = 'button';
    play.textContent = '▶ 播放我这次录音（' + turn.audioSeconds.toFixed(1) + 's，峰值 ' + fmtDbfs(turn.audioPeakDbfs) + ' dBFS）';
    play.onclick = function () { new Audio(turn.audioUrl).play().catch(function () {}); };
    listen.appendChild(play);
    var advice = document.createElement('span');
    advice.className = 'muted';
    advice.textContent = ' ' + levelAdvice(turn.audioPeakDbfs);
    listen.appendChild(advice);
    item.appendChild(listen);
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
  processor.onaudioprocess = function (event) {
    var frame = new Float32Array(event.inputBuffer.getChannelData(0));
    chunks.push(frame);
    // Pack Phase 8 (t11): the microphone keeps running while she speaks, and 150 ms of voiced
    // frames stop her playback (barge-in). 「按住说话」 is what makes this reachable, so the page
    // says so instead of pretending the microphone is always on.
    var sum = 0;
    for (var i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    if (xixiWatchBargeIn(Math.sqrt(sum / (frame.length || 1)))) {
      el('hint').textContent = '听到你说话了：已经停下（未播的部分丢掉）。松开后这一段会照常上传。';
    }
  };
  source.connect(processor);
  processor.connect(context.destination);
  recorder = { context: context, source: source, processor: processor, chunks: chunks, sampleRate: context.sampleRate };
  el('mic').textContent = '⏺ 松开发送';
  el('hint').textContent = '正在录音…（松开按钮结束；按住期间她说的话会被你的声音打断）';
}

/**
 * Play what came back, clause by clause (pack Phase 8 / t13).
 *
 * Two shapes reach the page, and both are understood here:
 *   * data.clauseAudio — the field-test console's route, which collects the incremental seam and
 *     attaches each clause's WAV to the response ({index, text, audio, durationMs});
 *   * data.stream.clauses[].audio — a caller that put the audio on the clause records instead.
 *
 * A payload with neither (a text turn, or a console whose TTS sink is not installed) falls back to
 * the single whole-reply audio it carries. A barge-in stops the loop: the remaining clauses are
 * dropped, never resumed mid-reply.
 */
async function playReplyAudio(data) {
  var clauses = data.clauseAudio && data.clauseAudio.length > 0
    ? data.clauseAudio
    : data.stream && data.stream.clauses && data.stream.clauses.length > 0 && data.stream.enabled === true
      ? data.stream.clauses
      : null;
  if (clauses) {
    for (var i = 0; i < clauses.length; i += 1) {
      if (!clauses[i].audio) continue;
      var started = await xixiSpeakClause(clauses[i].audio);
      if (started && started.skipped) break; // a barge-in landed: the rest is dropped, not resumed
    }
    return;
  }
  if (data.audio) new Audio('data:audio/wav;base64,' + data.audio).play().catch(function () {});
}

/** Peak level of the just-recorded audio, in dBFS (0 = full scale). -Infinity when silent. */
function peakDbfsOf(samples) {
  var peak = 0;
  for (var i = 0; i < samples.length; i += 1) {
    var value = samples[i] < 0 ? -samples[i] : samples[i];
    if (value > peak) peak = value;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

function fmtDbfs(dbfs) { return isFinite(dbfs) ? dbfs.toFixed(1) : '-∞'; }

/** Turn a recorded peak level into one sentence the user can act on. */
function levelAdvice(dbfs) {
  if (!isFinite(dbfs) || dbfs < -50) return '这一轮几乎没录到声音（峰值接近静音）：检查麦克风是否被静音、是否离得太远。';
  if (dbfs < -35) return '录音峰值偏低（' + fmtDbfs(dbfs) + ' dBFS）：靠近麦克风一点，或把系统输入增益调高。';
  if (dbfs < -20) return '录音峰值略低（' + fmtDbfs(dbfs) + ' dBFS）：噪声大时容易被判成没有语音，靠近一点会更稳。';
  return '录音音量正常（峰值 ' + fmtDbfs(dbfs) + ' dBFS）；若仍识别不到，多半是噪声或吐字问题。';
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
  // Keep the recording in this page so the user can hear what the machine actually got — the most
  // direct answer to "为什么显示未识别到". It never leaves the browser: the same bytes are what the
  // upload already sends, and nothing is written to disk.
  var wav = encodeWav(merged, current.sampleRate);
  var audioUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  recordingUrls.push(audioUrl);
  while (recordingUrls.length > 5) URL.revokeObjectURL(recordingUrls.shift());
  var peak = peakDbfsOf(merged);
  el('hint').textContent = '录音 ' + seconds.toFixed(1) + 's（峰值 ' + fmtDbfs(peak) + ' dBFS），正在识别…';
  clearError('page-error');
  try {
    var response = await post('/api/voice', { audioBase64: toBase64(wav), speak: BOOT.ttsEnabled });
    var data = await response.json();
    if (data.ok === false) {
      showError('page-error', data.error.message, data.error.hint);
      el('hint').textContent = '这一轮没有成功：' + data.error.message + '（' + levelAdvice(peak) + '）';
      return;
    }
    renderTurn({
      kind: 'voice', at: data.at, action: data.action, actionText: data.actionText, reason: data.reason, reasonText: data.reasonText,
      transcript: data.transcript, reply: data.reply, state: data.state, stages: data.stages,
      silenceReasonText: data.silenceReasonText, hygiene: data.hygiene, finishReason: data.finishReason,
      segmentsTotal: data.segmentsTotal, segmentsUsed: data.segmentsUsed, droppedSegments: data.droppedSegments,
      privacyNote: data.privacy.note,
      audioUrl: audioUrl, audioSeconds: seconds, audioPeakDbfs: peak
    });
    // t13: the voice turn's audio goes through the shared player, which prefers the reply's
    // per-clause audio (data.clauseAudio) and only falls back to the stitched blob. Leaving a
    // standalone new Audio(...) here meant the page could not play clause by clause even though the
    // payload carried everything it needed.
    await playReplyAudio(data);
    if (data.reason === 'NO_SPEECH_DETECTED') {
      el('hint').textContent = '没识别到语音：' + levelAdvice(peak) + ' 点右栏那条的「▶ 播放我这次录音」听一下录到了什么。';
    } else if (data.reason === 'ASSENT_ONLY') {
      // Pack Phase 8: a nod is not a turn — say what happened instead of showing a reply she
      // never made, and keep the mic hint where it was (she is still listening).
      el('hint').textContent = '「' + (data.transcript || '嗯') + '」是应和：这一轮不算，西西还在听（想让她回话就说一句完整的话）。';
    } else {
      el('hint').textContent = '说完松开即发送。';
    }
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
/**
 * The weather source the offline self-test uses: the same three days a real lookup would
 * return, served from memory. A self-test must not need a network (nor spend money), and the
 * point of that check is the tool *chain*, not the upstream service.
 */
function selfTestWeatherClient(): WeatherClient {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes('geocoding')
      ? { results: [{ name: '成都', latitude: 30.66, longitude: 104.06, timezone: 'Asia/Shanghai', admin1: '四川省' }] }
      : {
          timezone: 'Asia/Shanghai',
          daily: {
            time: ['2026-10-01', '2026-10-02', '2026-10-03'],
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

    // ---- pack Phase 2: the voice entry really reaches the tools ----------------
    // The offline stand-in runs the same registry and loop the real adapter does, so this
    // proves the *chain* (voice → engine → tool → reply) without a key, a network or a
    // microphone. The weather source is stubbed for the same reason the model is.
    const toolHandle = await createFieldServer({
      port: 0,
      offline: true,
      ttsEnabled: false,
      voiceDir: join(root, 'voice-tools'),
      dataDir: join(root, 'data-tools'),
      presenceDataDir: join(root, 'presence-tools'),
      reportDir: join(root, 'recon-tools'),
      autoPrune: false,
      probeRunner: createFakeProbeRunner(),
      // The VAD is this path's only Python dependency, and the offline ASR double always
      // says the same thing — a test that needs a real question supplies both.
      vadOverride: async () => ({ segments: [{ startMs: 0, endMs: 1200, durationMs: 1200 }], durationMs: 1200 }),
      asrOverride: async () => '明天成都天气怎么样？',
      toolOverrides: { weatherClient: selfTestWeatherClient() },
      log: () => {},
    });
    try {
      const toolState = (await (await fetch(`${toolHandle.url}/api/field/state`)).json()) as Record<string, any>;
      const toolWav = readWav(join(REPO_ROOT, 'tests', 'audio-fixtures', 'direct-question.wav'));
      const toolVoice = (await (
        await fetch(`${toolHandle.url}/api/voice`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audioBase64: toolWav.toString('base64'), speak: false }),
        })
      ).json()) as Record<string, any>;
      const toolText = (await (
        await fetch(`${toolHandle.url}/api/turn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '明天成都天气怎么样？', speak: false }),
        })
      ).json()) as Record<string, any>;
      const internalWording = /xixi_[a-z_]+|tool_call|arguments|parameters|JSON|工具调用|不认识的参数/;
      // 出厂控制台不带任何插件，所以模型可见的就是三个内置工具（V0.3 P2-D 起新闻由插件提供，
      // 不再是内置第四个）。这条以前写死成 `length === 4`，是 P2-D 之后留下来的过期字面量——
      // 它会把「少了一个工具」和「多了一个插件工具」两种情况都判错，所以直接点名三个。
      const builtIns = Array.isArray(toolState.tools?.names) ? [...(toolState.tools.names as string[])].sort() : [];
      check(
        '语音问天气真的调用了工具，回复没有工具内部字样；文字路径走的是同一条链',
        builtIns.join(',') === ['xixi_get_current_time', 'xixi_get_weather', 'xixi_set_reminder'].sort().join(',') &&
          toolState.tools.maxRounds === 4 &&
          toolVoice.toolName === 'xixi_get_weather' &&
          toolText.toolName === 'xixi_get_weather' &&
          String(toolVoice.reply).includes('明天成都') &&
          !internalWording.test(String(toolVoice.reply)) &&
          !internalWording.test(String(toolText.reply)),
        `工具 ${builtIns.join('、')}｜语音 ${String(toolVoice.toolName)}：${String(toolVoice.reply).slice(0, 40)}｜文字 ${String(toolText.toolName)}`,
      );
    } finally {
      await toolHandle.close();
    }

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
      // `find` may come back empty if the report's structure changed; then the checks below must
      // fail visibly (「undefined ≠ 'fail'」) instead of crashing the runner on a property read.
      const f2Speaker = (f2Response.report.items as Record<string, any>[]).find((item) => item.id === 'speaker') ?? {};
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
  npm run field-test -- --data-dir ${CANONICAL_DATA_DIR}-alt          换控制台自己的库（self_profile / 事件日志 /
                                                                      在场投影；默认 ${CANONICAL_DATA_DIR}）
  npm run field-test -- --presence-data-dir ${CANONICAL_DATA_DIR}-presence-alt
                                                                      只换在场投影读的库（默认与主库同一个
                                                                      ${CANONICAL_DATA_DIR}；P0-B 起不再单开一个库）

  node scripts/field-test.ts --self-test      离线自检：隐私 / 多段语音 / 页面 / 报告 / 设备口径，不碰麦克风、不联网
                                              exit 0 = 全过；有任何一项失败会 exit 1。
                                              项数会随回归断言增加（已经漂移过一次：24 → 31），所以这里
                                              不写死数字——看它最后一行的「自检结果：N 项通过」。
                                              它用独立临时目录跑（不碰你的库），所以 --data-dir / --presence-data-dir
                                              在这个模式下不生效（会明确提示，不静默忽略）。
  node scripts/field-test.ts --acceptance     真机设备验收（麦克风 → 扬声器 → 摄像头），逐项打印通过/失败与下一步，
                                              报告写入 docs/recon/field-test-report-<日期>.md；有失败项时 exit 1
  node scripts/field-test.ts --help           显示这份说明后退出（不启动服务、不占端口）

  不认识的参数会报错并以 exit 2 结束（中文说明 + 可用参数列表），不会静默忽略。

页面里能看到：麦克风实时电平与噪声底（含校准门限）、摄像头在场状态（未接入时显示「未接入」而不是报错）、
每轮的延迟分段（VAD / ASR / 首字 / 总时长）与最终动作（含 SILENCE 与拒绝原因）、以及设备验收引导。

环境变量：XIXI_FIELD_PORT 默认端口；XIXI_PYTHON 语音 VAD 用的 Python；
          XIXI_PROBE_PYTHON / XIXI_AUDIO_PYTHON 设备探测与声学回环用的 Python（默认 .venvs/field-probe 与 .venvs/voice-livekit）。
隐私：整段录音不落盘（只在系统临时目录存在到 VAD 结束，随后删除），语音段仅在 config 授权时保留；
      摄像头「启用」后画面不保存图像（每帧只经内存与 localhost 送到本机页面），但在场事件与 world_state 照常写本地库；
      详见页面「隐私与保留策略」一节与 config/xixi.yaml 的 privacy / memory 字段。`;

/** One parse of the console's command line: mode + every switch it understands. */
export interface FieldCliOptions {
  readonly mode: 'serve' | 'self-test' | 'acceptance' | 'help';
  readonly port: number;
  readonly offline: boolean;
  readonly ttsEnabled: boolean;
  readonly useDsh: boolean;
  readonly openBrowser: boolean;
  /**
   * `--data-dir`: the console's own store (self_profile, event log, presence projection).
   * `null` = the household canonical store (`XIXI_DATA_DIR`, else `${CANONICAL_DATA_DIR}`).
   */
  readonly dataDir: string | null;
  /** `--presence-data-dir`: where the presence projection is read. `null` = the same store as `dataDir`. */
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
        // Example values are deliberately neutral directories: `data/field-test-alt` cannot be
        // mistaken for the default (`data/field-test`), and a reader never has to guess whether
        // the suffix means something.
        const example = arg === '--port' ? '8793' : arg === '--presence-data-dir' ? 'data/presence-alt' : 'data/field-test-alt';
        return { ok: false, error: { message: `${arg} 后面需要一个值。`, hint: `例如：node scripts/field-test.ts ${arg} ${example}` } };
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
      if (error instanceof RuntimeError && error.hint.length > 0) console.error(`下一步：${error.hint}`);
      process.exitCode = 1;
    });
}
