/**
 * Voice turn: WAV in → VAD → ASR → conversation → TTS → WAV out.
 *
 * This is the M1 slice the plan asks for, minus the microphone: the audio source
 * is a fixture, everything after it is the real pipeline. It is runnable,
 * repeatable, and its per-stage timings come straight from 《方案》§46.4
 * (`vad`, `asr`, `llm_ttft`, `tts_first_chunk`, `e2e`).
 *
 * Privacy (§20.1): only the VAD-detected speech spans are uploaded, never the whole
 * recording, and raw audio is never stored beyond the explicit output files.
 *
 * Multi-segment: a recording that contains more than one speech segment (a pause
 * in the middle of a test sentence is the normal case) now feeds *all* of them to
 * ASR, stitched in order with a short gap. Anything left out by the per-call caps
 * is reported in `droppedSegments` with a reason — never dropped silently.
 *
 * Usage:
 *   node scripts/voice-turn.ts --wav tests/audio-fixtures/direct-question.wav
 *   node scripts/voice-turn.ts --wav a.wav --wav b.wav --wav c.wav   # one voice session
 *   node scripts/voice-turn.ts --wav x.wav --fake                    # offline plumbing test
 *   node scripts/voice-turn.ts --wav a.wav --trace                   # deltas + same-batch legacy
 *
 * Pack Phase 8 — how to read the four delays this script reports (t9 rewrote this after two reviews):
 *
 *   * **④ 「首段可听总延迟」 is the metric the pack's 首音 target is about**: 「说完到听见第一个字」
 *     includes the endpoint hold and the model's first token, so it is the number a user feels.
 *   * **③ 「首 token → 首段可听」 is an attribution quantity only.** It says how much of ④ belongs to
 *     speech synthesis; it is not the target, and comparing it across the two paths compares two
 *     different physical quantities (first *clause* vs whole reply). Quoting 「超出 15 %」 (a ③
 *     statement) as if it were the target is the mistake this header now rules out.
 *   * `--legacy-tts` (implied by `--trace`) adds the V0.1 whole-reply synthesis **in the same batch,
 *     on the same reply text**, which is the only way to say 「首音有没有改善」 honestly. What three
 *     independent batches then showed is that the **sign and size are not reproducible**: one run had
 *     streaming 16 % worse, others a few percent better (t12). So the honest conclusion is 「方向多数
 *     为正、幅度不可复现」 — never a single batch's percentage.
 *   * `--out <path>` (default `data/voice/bench/voice-turn-batch.txt`) writes the evidence this run
 *     produced, so the whole-reply column has an artefact too — that absence is what t5 found.
 *   * `--compare <file …>` reprints the paired table from those artefacts with **no API call**. It is
 *     the recomputation command the report names, and it states the ③/④ distinction on every run.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { FakeBrainAdapter, type BrainAdapter } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { MimoClient } from '@xixi/model-adapters';
import { openXixiStore } from '@xixi/domain';

import { REPO_ROOT, loadConfig, printEvidence, readDotEnv } from './lib/harness.ts';
import { concatWav, readWavInfo, readWav } from './lib/wav.ts';
// Pack Phase 8: the streaming speech pipeline (ClauseChunker → TTS queue → playback clock).
// The same class the console and the page use, so 「第一块立刻进 TTS 队列」 has one home.
import { fourStageLatency, percentiles, SpeechPipeline } from '../services/voice-edge/voice_edge/voice_stream.ts';
import { CLAUSE_CHUNKER_LIMITS } from '../packages/conversation/src/segments.ts';
// The paired-comparison rules live in `scripts/lib/voice-latency.ts` — a library this CLI and
// `tests/unit/voice/voice-latency.test.ts` both import, so the `--compare` output and the assertions
// about it cannot drift apart (t9; moved out of `tests/` in t16 so that production code no longer
// imports from a test directory).
import { compareBatch, formatComparison, parseBatchEvidence } from './lib/voice-latency.ts';
// Shared with the field-test console: the multi-segment planner and the
// speech-only slicer, so "use every segment" lives in exactly one place.
// `buildToolChain`/`CONVERSATION_SCOPE` come from the same file for the same reason:
// this voice entry and the console must not drift into two tool chains (pack Phase 2).
import { buildSpeechAudio, buildToolChain, CONVERSATION_SCOPE, planSpeechSegments, type DroppedSegment } from './field-test.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const PYTHON = process.env.XIXI_PYTHON ?? join(REPO_ROOT, '.venvs', 'voice-pipecat', 'Scripts', 'python.exe');
const OUT_DIR = join(REPO_ROOT, 'data', 'voice');

interface VoiceTurnResult {
  readonly wav: string;
  readonly speech: { startMs: number; endMs: number; endpointDelayMs: number | null } | null;
  /** Every VAD segment of this file, in order (not just the first one). */
  readonly segments: readonly { startMs: number; endMs: number; durationMs: number }[];
  readonly segmentsTotal: number;
  readonly segmentsUsed: number;
  /** Anything left out, with the reason — never a silent drop. */
  readonly droppedSegments: readonly DroppedSegment[];
  readonly transcript: string | null;
  readonly reply: string | null;
  readonly action: string;
  /** Pack Phase 2: the tool that backed this voice turn, when one ran. */
  readonly toolName: string | null;
  /**
   * preflight ⑧: 引擎这一轮报的 notice（沉默原因 `ARTIFACT_ONLY_REPLY` / 被剔掉的清洗、
   * 被替换的无据事实、被截断…）。空数组 = 这一轮没有任何要解释的事。
   */
  readonly notices: readonly { readonly code: string; readonly detail: string }[];
  readonly accepted: boolean;
  readonly reason: string;
  readonly replyWav: string | null;
  readonly timings: Record<string, number | null>;
  /** Pack Phase 8: one entry per clause that went to TTS, with the pipeline's own clock. */
  readonly clauses:
    | readonly {
        readonly index: number;
        readonly chars: number;
        readonly reason: string;
        readonly textMs: number;
        readonly audioMs: number | null;
        readonly synthMs: number | null;
      }[]
    | null;
  /** ③ of the V0.1 whole-reply path on the identical reply (`--legacy-tts`), same batch. */
  readonly legacyTtsMs: number | null;
  /** `--trace` only: each model delta with its arrival time (to explain a ③ number). */
  readonly deltas: readonly { readonly atMs: number; readonly chars: number; readonly text: string }[] | null;
  /** When clause 1's TTS request went out, relative to the first token. */
  readonly firstClauseDispatchedMs: number | null;
  /** The four `docs/benchmarks/v01-baseline.md` §3.1 delays, from this turn's own clock. */
  readonly fourStage: {
    readonly vadEndToAsrFinalMs: number | null;
    readonly asrFinalToFirstTokenMs: number | null;
    readonly firstTokenToFirstAudioMs: number | null;
    readonly totalToFirstAudioMs: number | null;
  };
}

interface SegmentationResult {
  readonly segments: { startMs: number; endMs: number; endpointDelayMs: number | null }[];
  readonly durationMs: number;
  readonly timings?: { loadMs: number; processMs: number; audioMs: number };
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
    child.on('close', (code) => {
      // Exit 2 means "no speech segments", which is a result, not a failure.
      if (code === 0 || code === 2) resolve(stdout);
      else reject(new Error(`VAD failed (exit ${code}): ${stderr.slice(-400)}`));
    });
  });
}

async function segment(wavPath: string): Promise<SegmentationResult> {
  const stdout = await runPython(['-m', 'voice_edge.segment', wavPath]);
  return JSON.parse(stdout) as SegmentationResult;
}

const args = process.argv.slice(2);
const useFake = args.includes('--fake');
/** Read a `--flag value` pair; defined before the flags that use it. */
function argValue(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? (args[index + 1] as string) : fallback;
}
/**
 * `--legacy-tts` synthesizes the **whole reply** once, after the reply is complete, exactly as
 * V0.1 did (`docs/benchmarks/v01-baseline.md` §3.2). It exists so the 「改造前」 column of a
 * latency report can come from the same batch, on the same reply text, rather than from a
 * different run on a different day. It costs one extra TTS call per turn.
 */
const explicitLegacy = args.includes('--legacy-tts');
/**
 * `--trace` records every model delta with its arrival time, **and implies `--legacy-tts`**.
 *
 * The implication is deliberate (t11): a trace exists to explain a first-audio number, and that
 * explanation is only checkable against the same-batch whole-reply column. As two independent
 * flags, a run could land on disk with deltas but no legacy column — the t5 reviewer's own
 * `%TEMP%\t5-review\m3-*.txt` files are exactly that — so the artefact a reviewer reads could not
 * support the conclusions drawn from it.
 */
const trace = args.includes('--trace');
const legacyTts = explicitLegacy || trace;
/**
 * `--min-comma=N` / `--max-chars=N` set the ClauseChunker's thresholds for this batch, so the
 * 「第一块多长」 trade can be measured instead of guessed: a shorter first clause is synthesized
 * sooner (first-audio latency falls) but the reply needs more TTS calls (total time rises).
 * The defaults are `CLAUSE_CHUNKER_LIMITS` — see `packages/conversation/src/segments.ts`.
 */
const minComma = Number(argValue('--min-comma', String(CLAUSE_CHUNKER_LIMITS.minCommaChars)));
const maxChars = Number(argValue('--max-chars', String(CLAUSE_CHUNKER_LIMITS.maxChars)));
/**
 * `--out <path>` lands this run's evidence where a later batch can be paired against it (t9).
 *
 * Why it exists: the reviews kept asking for raw n=12 artefacts, and before this flag the only way
 * to keep one was shell redirection — which PowerShell writes as UTF-16, so the next reader could
 * not even parse it (`%TEMP%\t5-review\m3-*.txt`). Writing the file from inside the script makes the
 * artefact, the command that produced it and its encoding a single, repeatable step.
 */
const outPath = argValue('--out', join(REPO_ROOT, 'data', 'voice', 'bench', 'voice-turn-batch.txt'));
/**
 * `--compare <file> [<file> …]` prints the paired streaming-vs-whole-reply table from **evidence
 * files on disk** — no API call, no audio, no key. It is the recomputation command: every number in
 * the report can be rebuilt from the artefacts it names.
 *
 * Every following bare argument is another artefact (t13 found this the hard way: taking only the
 * argument right after the flag silently compared one batch and dropped the rest, which is exactly
 * the 「只报一批」 problem this whole task exists to fix).
 */
const compareInputs: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== '--compare') continue;
  for (let next = index + 1; next < args.length && !args[next].startsWith('--'); next += 1) {
    compareInputs.push(args[next] as string);
  }
}
if (compareInputs.length > 0) {
  const comparisons = compareInputs.map((file) => {
    const absolute = file.includes(':') || file.startsWith('.') ? file : join(REPO_ROOT, file);
    return compareBatch(parseBatchEvidence(readFileSync(absolute, 'utf8').replace(/^\uFEFF/, ''), file));
  });
  console.log(formatComparison(comparisons));
  process.exit(0);
}
const wavs: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--wav' && args[index + 1] !== undefined) wavs.push(args[index + 1]);
}
if (wavs.length === 0) {
  console.error('用法：node scripts/voice-turn.ts --wav <file.wav> [--wav <file2.wav> ...] [--fake] [--trace] [--legacy-tts] [--min-comma N] [--max-chars N] [--out <file>]');
  console.error('      node scripts/voice-turn.ts --compare <批次产物.txt> [<更多>]   # 不调 API，只复算对照');
  process.exit(2);
}

const config = loadConfig();
const client = useFake ? null : new MimoClient();
const store = openXixiStore({ dataDir: join(REPO_ROOT, 'data', 'voice') });
store.seedSelfProfile(config.personality.base);
const session = store.latestSession() ?? store.createSession();
/**
 * Pack Phase 2: the file-driven voice entry uses the *same* tool chain as the text
 * entries (`buildToolChain` → one registry with the four built-ins). Before this, the
 * voice path had no tools at all: asking about the weather by voice could only be
 * answered from memory.
 */
const toolChain = buildToolChain(config, {
  onToolCall: (record) => console.log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`),
});
const adapter: BrainAdapter = useFake
  ? new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE })
  : new (await import('@xixi/brain-adapter')).MimoBrainAdapter({
      maxCompletionTokens: 400,
      registry: toolChain,
      scope: CONVERSATION_SCOPE,
      timezone: config.identity.timezone,
      language: config.identity.language,
    });
const engine = new ConversationEngine({ adapter, store, config, turnTimeoutMs: 60_000 });
mkdirSync(OUT_DIR, { recursive: true });

const results: VoiceTurnResult[] = [];
const replyBuffers: Buffer[] = [];
let first = true;

for (const wavPath of wavs) {
  const absolute = wavPath.startsWith('.') || wavPath.includes(':') ? wavPath : join(REPO_ROOT, wavPath);
  const info = readWavInfo(readWav(absolute));

  const vadStart = Date.now();
  const segmentation = await segment(absolute);
  const vadMs = Date.now() - vadStart;
  const rawWav = readWav(absolute);
  // Use every detected segment (§20.1: only speech is uploaded; and a second
  // sentence in the same recording must not be dropped silently).
  const plan = planSpeechSegments(segmentation.segments);
  const speech = plan.used[0] ?? null;

  if (speech === null) {
    results.push({
      wav: wavPath,
      speech: null,
      segments: [],
      segmentsTotal: 0,
      segmentsUsed: 0,
      droppedSegments: [],
      transcript: null,
      reply: null,
      action: 'SILENCE',
      accepted: false,
      toolName: null,
      notices: [],
      reason: 'NO_SPEECH_DETECTED',
      replyWav: null,
      timings: { vadMs, sourceDurationMs: Math.round(info.durationMs) },
    });
    continue;
  }

  // Only the speech spans are uploaded (§20.1); several segments are stitched
  // with a short silence so ASR does not fuse the words across the gap.
  const speechBuffer = buildSpeechAudio(rawWav, plan);
  const lastUsed = plan.used[plan.used.length - 1] as (typeof plan.used)[number];

  const asrStart = Date.now();
  const transcript = client === null ? `（离线模拟）${wavPath}` : (await client.transcribe(speechBuffer)).text;
  const asrMs = Date.now() - asrStart;

  const chunks: string[] = [];
  const notices: { readonly code: string; readonly detail: string }[] = [];
  let firstChunkAt: number | null = null;
  const llmStart = Date.now();
  /** `--trace`: every model delta and its arrival time, so a latency number can be explained. */
  const deltas: { atMs: number; chars: number; text: string }[] = [];

  /**
   * Pack Phase 8: the streaming speech sink. Until 2026-10-01 this entry spoke the whole reply
   * in one TTS call *after* the engine had finished, which is why stage ③ (「首 token → 首个音频」)
   * sat at 2.3 s P50 in `docs/benchmarks/v01-baseline.md` §3.2. Now each clause goes to TTS the
   * moment the chunker releases it, so ③ is the cost of the **first clause** and the reply's
   * length no longer delays the first audible sound.
   *
   * `--legacy-tts` keeps the old shape in the same batch, on the same reply text: without it
   * the 「改造前」 column could only come from a different run on a different day.
   */
  const pipeline =
    useFake || client === null
      ? null
      : new SpeechPipeline(
          (text) => client.synthesize(text),
          (wav) => readWavInfo(Buffer.from(wav)).durationMs,
          { earlyFirstClause: true, minCommaChars: minComma, maxChars },
        );
  /** Set by the pipeline the instant clause 1's TTS request is in flight. */
  let firstClauseDispatchedAtMs: number | null = null;
  pipeline?.onFirstClause((clause) => {
    firstClauseDispatchedAtMs = clause.textAtMs;
  });
  const turn = await engine.respond(
    { sessionId: session.sessionId, text: transcript, addressed: first },
    {
      onTextChunk: (chunk) => {
        if (firstChunkAt === null) firstChunkAt = Date.now();
        chunks.push(chunk);
        if (trace) deltas.push({ atMs: Date.now() - llmStart, chars: chunk.length, text: chunk });
        pipeline?.push(chunk);
      },
      // preflight ⑧: 引擎的 notice（沉默原因 / 被剔掉的内容）必须进这条入口的产物，
      // 否则「她为什么没说话」在语音路径上只剩一个 SILENCE，和「模型自己决定不说」分不开。
      onNotice: (notice) => void notices.push({ code: notice.code, detail: notice.detail }),
    },
  );
  const llmMs = Date.now() - llmStart;
  first = false;
  const spoken = pipeline === null ? [] : await pipeline.flush();

  let replyWav: string | null = null;
  let ttsMs: number | null = null;
  let legacyTtsMs: number | null = null;
  if (turn.action === 'SPEAK' && turn.text !== null && client !== null) {
    if (pipeline !== null) {
      // ③ for the streaming path: first token → first clause's audio, both read off the same
      // clock the stages above use (never recomputed from a total).
      const firstTokenAt = firstChunkAt;
      const clause = pipeline.clauses[0];
      ttsMs = clause === undefined || clause.audioAtMs === null || firstTokenAt === null ? null : clause.audioAtMs - firstTokenAt;
      if (legacyTts) {
        // The V0.1 counterfactual, on the identical reply text: one call for the whole reply.
        const legacyStart = Date.now();
        await client.synthesize(turn.text);
        legacyTtsMs = Date.now() - legacyStart;
      }
      const buffers = spoken.map((chunk) => Buffer.from(chunk.wav));
      if (buffers.length > 0) {
        replyWav = join(OUT_DIR, `reply-${results.length + 1}.wav`);
        writeFileSync(replyWav, concatWav(buffers, 0));
        replyBuffers.push(concatWav(buffers, 0));
      }
    } else {
      const ttsStart = Date.now();
      const audio = await client.synthesize(turn.text);
      ttsMs = Date.now() - ttsStart;
      replyWav = join(OUT_DIR, `reply-${results.length + 1}.wav`);
      writeFileSync(replyWav, audio);
      replyBuffers.push(audio);
    }
  }
  const firstClause = pipeline?.clauses[0] ?? null;
  const fourStage = fourStageLatency({
    endpointDelayMs: lastUsed.endpointDelayMs ?? null,
    asrMs,
    firstTokenMs: firstChunkAt === null ? null : firstChunkAt - llmStart,
    firstAudioMs: ttsMs,
  });

  results.push({
    wav: wavPath,
    speech: { startMs: speech.startMs, endMs: speech.endMs, endpointDelayMs: speech.endpointDelayMs ?? null },
    segments: plan.used.map((item) => ({
      startMs: item.startMs,
      endMs: item.endMs,
      durationMs: item.durationMs ?? Math.round(item.endMs - item.startMs),
    })),
    segmentsTotal: segmentation.segments.length,
    segmentsUsed: plan.used.length,
    droppedSegments: plan.dropped,
    transcript,
    reply: turn.text,
    action: turn.action,
    accepted: turn.accepted,
    toolName: turn.toolName,
    notices,
    reason: turn.reason,
    replyWav,
    /** Pack Phase 8: one entry per clause that went to TTS, with its own timings. */
    clauses:
      firstClause === null
        ? null
        : (pipeline?.clauses ?? []).map((clause) => ({
            index: clause.index,
            chars: clause.text.length,
            reason: clause.reason,
            textMs: clause.textAtMs - llmStart,
            audioMs: clause.audioAtMs === null ? null : clause.audioAtMs - llmStart,
            synthMs: clause.synthMs,
          })),
    /** ③ of the V0.1 path on the identical reply (`--legacy-tts`), for a same-batch comparison. */
    legacyTtsMs,
    /** `--trace` only: the model's delta stream, so a ③ number can be diagnosed. */
    deltas: trace ? deltas : null,
    fourStage,
    /** When clause 1's TTS request went out, relative to the first token (`--trace` explains it). */
    firstClauseDispatchedMs: firstClauseDispatchedAtMs === null ? null : firstClauseDispatchedAtMs - llmStart,
    timings: {
      sourceDurationMs: Math.round(info.durationMs),
      vadMs,
      // `processMs` is the streaming cost a resident voice process would pay;
      // `loadMs` + interpreter start are one-off cold-start costs.
      vadProcessMs: segmentation.timings?.processMs ?? null,
      vadModelLoadMs: segmentation.timings?.loadMs ?? null,
      asrMs,
      llmFirstChunkMs: firstChunkAt === null ? null : firstChunkAt - llmStart,
      llmTotalMs: llmMs,
      ttsMs,
      e2eSpeechEndToFirstChunkMs:
        firstChunkAt === null
          ? null
          : Math.round((lastUsed.endpointDelayMs ?? 0) + asrMs + (firstChunkAt - llmStart)),
      e2eToFirstReplyAudioMs:
        ttsMs === null || firstChunkAt === null
          ? null
          : Math.round((lastUsed.endpointDelayMs ?? 0) + asrMs + (firstChunkAt - llmStart) + ttsMs),
    },
  });

  // preflight ⑧: 让人在终端里也看得见（同一份内容同时进产物 `turns[].notices`）。
  for (const notice of notices) console.log(`[提示 ${notice.code}] ${notice.detail}`);
}

let conversationWav: string | null = null;
if (replyBuffers.length > 0) {
  conversationWav = join(OUT_DIR, 'voice-replies.wav');
  writeFileSync(conversationWav, concatWav(replyBuffers, 400));
}

/**
 * Pack Phase 8's latency report, on the Four baseline delays.
 *
 * The before/after comparison only means something if both columns are the same measurement:
 * ① VAD end → ASR final, ② ASR final → first token, ③ first token → first audible, ④ the sum
 * including the endpoint hold. `--legacy-tts` fills ③-of-the-old-path in this very batch; the
 * V0.1 column from `docs/benchmarks/v01-baseline.md` §3.2 is printed next to it for context,
 * and the two are never mixed into one number (the baseline's runs are a different day, a
 * different conversation and a different reply length).
 */
const latency = {
  command: `node scripts/voice-turn.ts ${wavs.map((wav) => `--wav ${wav}`).join(' ')}${legacyTts ? ' --legacy-tts' : ''}${minComma === CLAUSE_CHUNKER_LIMITS.minCommaChars ? '' : ` --min-comma ${minComma}`}`,
  chunker: { minCommaChars: minComma, maxChars, earlyFirstClause: true, defaults: CLAUSE_CHUNKER_LIMITS },
  streaming: {
    '① VAD end → ASR final (asrMs)': percentiles(results.map((turn) => turn.fourStage.vadEndToAsrFinalMs)),
    '② ASR final → 首 token (llmFirstChunkMs)': percentiles(results.map((turn) => turn.fourStage.asrFinalToFirstTokenMs)),
    '③ 首 token → 首段可听（第一块的合成）': percentiles(results.map((turn) => turn.fourStage.firstTokenToFirstAudioMs)),
    '④ 首段可听总延迟（含端点保持）': percentiles(results.map((turn) => turn.fourStage.totalToFirstAudioMs)),
  },
  legacySameBatch: legacyTts
    ? {
        '③ 首 token → 整段音频（--legacy-tts，同一批）': percentiles(results.map((turn) => turn.legacyTtsMs)),
        '④ 合计（--legacy-tts，用同一批 ①②）': percentiles(
          results.map((turn) => {
            const endpoint = turn.speech?.endpointDelayMs ?? null;
            if (endpoint === null || turn.fourStage.asrFinalToFirstTokenMs === null || turn.legacyTtsMs === null) return null;
            return Math.round(endpoint + (turn.fourStage.vadEndToAsrFinalMs ?? 0) + turn.fourStage.asrFinalToFirstTokenMs + turn.legacyTtsMs);
          }),
        ),
      }
    : null,
  v01Baseline: {
    source: 'docs/benchmarks/v01-baseline.md §3.2（n=16，2026-09-29 四批，非同一批）',
    '① P50': 569,
    '② P50': 2629,
    '③ P50': 2285.5,
    '④ P50': 6816,
  },
  clauseCount: percentiles(results.map((turn) => (turn.clauses === null ? null : turn.clauses.length))),
  note:
    '四个延迟的定义与 docs/benchmarks/v01-baseline.md §3.1 逐字对应；③ 在流式下是「第一块」的合成耗时，在旧链路上是「整段回复」的合成耗时 —— 不是同一个物理量，所以两列分开写、不合并。' +
    '承载指标是 ④（pack 的「首音」就是「说话结束到听见第一个字」，含端点保持与模型首 token），③ 只是归因量；把 ③ 的「超出 15%」当成目标是口径错误。' +
    // t21: no canned conclusion here. This note travels inside every artefact, so a hard-coded
    // sentence ends up contradicting the same file's own recomputation (`--compare` on this artefact
    // says 「方向不一致（2 快 3 慢）」 while the note used to say 「多数为正」). The direction, the
    // spread and the two floors are all computed from the artefacts by `--compare`; this note only
    // says where to look.
    '同批对照（流式 vs 整段）的方向与幅度跨批不可复现，**结论由 --compare 按产物计算，本文件不预置结论句** —— 见 latency.reproduce 指向的命令；' +
    '一次运行只看得到一批，单批百分比不是结论，至少要几批并列才能谈方向。' +
    'batching：一次运行 = 一批，n 由 --wav 的个数乘运行的遍数决定；--trace 会同时给出 deltas 与 legacy 列（见 FLAGS）。',
  flags: {
    trace,
    legacyTts: explicitLegacy ? 'explicit' : trace ? 'implied-by-trace' : false,
    batchRuns: 1,
    /** Where this run's evidence was written, so a later `--compare` can name it (t9). */
    wrote: outPath,
  },
  reproduce:
    `node scripts/voice-turn.ts --compare ${outPath}` +
    `   # 不调 API：把这一批的流式与整段逐轮配对重算，并打印 ③/④ 的口径说明`,
};

const evidence = {
  adapter: adapter.describe(),
  sessionId: session.sessionId,
  turns: results,
  stitchedReplyWav: conversationWav,
  latency,
  note: 'e2e 估算含 VAD 端点延迟；每段文件的 segmentsTotal/segmentsUsed/droppedSegments 说明是否丢弃了语音段（不再静默丢弃）；真实麦克风与扬声器验收见 docs/recon/field-test-report-<日期>.md（§33 的 P50 < 500ms 打断目标不在本次证据内）',
};

printEvidence('语音闭环（夹具音频 → VAD → ASR → 对话 → 流式 TTS）', evidence);

/**
 * The artefact itself (t9): the same document the console just printed, on disk, in UTF-8.
 *
 * `data/` is gitignored, so this is a *reproducible* artefact rather than a committed one: the
 * `latency.command` field inside it is the command that produced it, and `--compare` reads any number
 * of such files. `--trace` runs carry the per-delta trace; it is stored compactly (arrival + size)
 * because the full text of every delta is already in `turns[].reply`.
 */
const serializable = JSON.parse(JSON.stringify(evidence)) as { turns: { deltas?: readonly { atMs: number; chars: number; text: string }[] | null }[] };
for (const turn of serializable.turns) {
  if (Array.isArray(turn.deltas)) {
    turn.deltas = turn.deltas.map((delta) => ({ atMs: delta.atMs, chars: delta.chars, text: '' }));
  }
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `=== 语音闭环（夹具音频 → VAD → ASR → 对话 → 流式 TTS）===\n${JSON.stringify(serializable, null, 2)}\n`, 'utf8');
console.log(`\n[evidence] 本批产物已写入 ${outPath}（--compare ${outPath} 可复算对照，不调 API）`);
store.recordHealth('voice-edge', 'ok', `voice turn batch of ${wavs.length}`);
store.close();
