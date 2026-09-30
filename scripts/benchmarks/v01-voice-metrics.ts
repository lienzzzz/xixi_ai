/**
 * V0.1 baseline voice metrics: read captured `scripts/voice-turn.ts` output and
 * print P50/P90 for the four latencies the P0 baseline asks for.
 *
 *   node scripts/benchmarks/v01-voice-metrics.ts docs/benchmarks/v01/raw-voice-batchA.txt docs/benchmarks/v01/raw-voice-batchB.txt
 *
 * Stage mapping — V0.1 has **no streaming TTS**, so the four numbers do not have
 * the meaning the streaming milestone (pack Phase 8) will give them. The script
 * prints both the raw stage numbers and this mapping, and never hides a null:
 *
 *   ① VAD end → ASR final        : timings.asrMs
 *      (the VAD's own endpoint hold is `speech.endpointDelayMs`; it is dead time
 *       *before* "VAD end" is declared, so it is reported separately, not folded in)
 *   ② ASR final → first token    : timings.llmFirstChunkMs
 *   ③ first token → first audio  : timings.ttsMs — in V0.1 TTS starts only after
 *      the **whole** reply is complete, so this is an upper bound, not a
 *      "first audio" measurement
 *   ④ total first audible        : timings.e2eToFirstReplyAudioMs
 *      (= endpointDelayMs + asrMs + llmFirstChunkMs + ttsMs)
 *
 * `durationMs`/`sourceDurationMs` are recorded so a reader can tell a long clip
 * from a slow pipeline. A turn with no TTS (SILENCE, or `--fake`) keeps `null`
 * and is excluded from the TTS percentile, with the count printed.
 */
import { readFileSync } from 'node:fs';

import { characterSimilarity } from '../lib/similarity.ts';

interface VoiceTurn {
  readonly wav: string;
  readonly transcript: string | null;
  readonly action: string;
  readonly reply: string | null;
  readonly speech: { startMs: number; endMs: number; endpointDelayMs: number | null } | null;
  readonly timings: Record<string, number | null>;
}

interface Batch {
  readonly file: string;
  readonly provider: string | null;
  readonly mode: string | null;
  readonly turns: readonly VoiceTurn[];
}

function parseBatch(file: string): Batch {
  const raw = readFileSync(file, 'utf8');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`${file}: no JSON payload found`);
  const payload = JSON.parse(raw.slice(start, end + 1)) as {
    adapter?: { provider?: string; mode?: string };
    turns: VoiceTurn[];
  };
  return {
    file,
    provider: payload.adapter?.provider ?? null,
    mode: payload.adapter?.mode ?? null,
    turns: payload.turns,
  };
}

function quantile(values: readonly number[], fraction: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? null;
  const weight = position - lower;
  return Math.round(((sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight) * 10) / 10;
}

function main(): void {
  const args = process.argv.slice(2);
  const expectIndex = args.indexOf('--expect');
  const expectFile = expectIndex >= 0 ? args[expectIndex + 1] : undefined;
  const files = args.filter((argument, index) => !argument.startsWith('--') && index !== expectIndex + 1);
  if (files.length === 0) {
    console.error(
      '用法：node scripts/benchmarks/v01-voice-metrics.ts <voice-turn-output.txt> [...] [--expect <expected-texts.json>]',
    );
    process.exit(2);
  }
  const batches = files.map(parseBatch);
  const turns = batches.flatMap((batch) => batch.turns);

  const series: Record<string, (number | null)[]> = {
    '① VAD end → ASR final (asrMs)': turns.map((turn) => turn.timings.asrMs ?? null),
    '② ASR final → 首 token (llmFirstChunkMs)': turns.map((turn) => turn.timings.llmFirstChunkMs ?? null),
    '③ 首 token → 首个音频 (ttsMs，V0.1 非流式)': turns.map((turn) => turn.timings.ttsMs ?? null),
    '④ 首个可听总延迟 (e2eToFirstReplyAudioMs)': turns.map((turn) => turn.timings.e2eToFirstReplyAudioMs ?? null),
    '参考：VAD 端点保持 (speech.endpointDelayMs)': turns.map((turn) => turn.speech?.endpointDelayMs ?? null),
    '参考：VAD 进程耗时 (vadProcessMs)': turns.map((turn) => turn.timings.vadProcessMs ?? null),
    '参考：整轮回复生成 (llmTotalMs)': turns.map((turn) => turn.timings.llmTotalMs ?? null),
  };

  console.log(`输入文件：${files.join('、')}`);
  for (const batch of batches) {
    console.log(`  ${batch.file}：adapter=${batch.provider}/${batch.mode}，${batch.turns.length} 轮`);
  }
  console.log(`轮数 n = ${turns.length}\n`);
  console.log('| 指标 | n | P50 | P90 | 最小 | 最大 | 逐轮值 |');
  console.log('|---|---:|---:|---:|---:|---:|---|');
  for (const [label, values] of Object.entries(series)) {
    const present = values.filter((value): value is number => value !== null);
    console.log(
      `| ${label} | ${present.length} | ${quantile(present, 0.5) ?? '未测'} | ${quantile(present, 0.9) ?? '未测'} | ` +
        `${quantile(present, 0) ?? '未测'} | ${quantile(present, 1) ?? '未测'} | ${values
          .map((value) => (value === null ? '未测' : value))
          .join(' / ')} |`,
    );
  }
  console.log('\n逐轮明细：');
  for (const turn of turns) {
    const timing = turn.timings;
    console.log(
      `- ${turn.wav} | action=${turn.action} | endpoint=${turn.speech?.endpointDelayMs ?? '未测'}ms | asr=${timing.asrMs ?? '未测'}ms | ` +
        `ttft=${timing.llmFirstChunkMs ?? '未测'}ms | tts=${timing.ttsMs ?? '未测'}ms | e2e=${timing.e2eToFirstReplyAudioMs ?? '未测'}ms`,
    );
  }

  if (expectFile !== undefined) {
    const expected = JSON.parse(readFileSync(expectFile, 'utf8')) as Record<string, string>;
    console.log(`\nASR 转写与夹具原文的字符相似度（期望值来自 ${expectFile}）：`);
    console.log('| 夹具 | 转写 | 原文 | 相似度 |');
    console.log('|---|---|---|---:|');
    for (const turn of turns) {
      const key = turn.wav.split('/').pop() ?? turn.wav;
      const want = expected[key];
      if (want === undefined) continue;
      const transcript = turn.transcript ?? '未测';
      const similarity = turn.transcript === null ? '未测' : characterSimilarity(turn.transcript, want).toFixed(3);
      console.log(`| ${key} | ${transcript} | ${want} | ${similarity} |`);
    }
  }
}

main();
