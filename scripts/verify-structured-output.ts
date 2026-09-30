/**
 * Model-contract check for structured output (《方案》§52).
 *
 * Guards the one provider behaviour that silently breaks meta-agents: MiMo's
 * `json_schema` + `strict: true` pads the reply with whitespace until it hits the
 * completion cap, so the JSON is truncated. `strict: false` returns a clean
 * object. This script asserts the working path, records the defect as a canary,
 * and validates the result locally with the project's own schema validator —
 * because `strict` is not enforced either way, local validation is the real gate.
 *
 * Costs two API calls. Usage: node scripts/verify-structured-output.ts
 */
import { assertSchema, type JsonSchema } from '@xixi/contracts';
import { MimoClient } from '@xixi/model-adapters';

import { printEvidence, readDotEnv } from './lib/harness.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['naturalness', 'coherence', 'in_character', 'problems'],
  properties: {
    naturalness: { type: 'integer', minimum: 1, maximum: 5 },
    coherence: { type: 'integer', minimum: 1, maximum: 5 },
    in_character: { type: 'boolean' },
    problems: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
  },
};

const MESSAGES = [
  { role: 'system' as const, content: '你是严格的对话质量评审，只输出 JSON。' },
  { role: 'user' as const, content: '场景：weather\n\n用户：明天天气怎么样？\n西西：明天下雨，记得带伞。' },
];

const client = new MimoClient();
const failures: string[] = [];

// --- the path every meta-agent uses: chatJson with a bounded repair --------
const ATTEMPTS = 3;
const callResults: Record<string, unknown>[] = [];
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  try {
    const result = await client.chatJson({
      model: 'mimo-v2.6-flash',
      messages: MESSAGES,
      maxCompletionTokens: 500,
      schema: { name: 'conversation_quality', schema: SCHEMA },
      // The contract check is ours and participates in the retry decision, so a
      // shape mismatch triggers the fallback instead of bubbling up as a caller bug.
      validate: (value) => assertSchema(SCHEMA, value, 'INVALID_PAYLOAD', 'chatJson output does not match the requested schema'),
    });
    callResults.push({
      attempt,
      ok: true,
      attemptsUsed: result.attempts,
      notes: result.notes,
      totalMs: result.totalMs,
      json: result.json,
    });
  } catch (error) {
    callResults.push({ attempt, ok: false, error: error instanceof Error ? error.message : String(error) });
    failures.push(`chatJson 第 ${attempt} 次失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
const degraded = callResults.filter((result) => result.attemptsUsed === 2).length;

// --- the provider defect, kept as a canary ----------------------------------
// Probed repeatedly because the defect is intermittent: one clean run proves
// nothing, and a flaky structured-output path would corrupt meta-agents silently.
const STRICT_ATTEMPTS = 3;
const strictOutcomes: { attempt: number; parseable: boolean; finishReason: string | null; length: number }[] = [];
for (let attempt = 1; attempt <= STRICT_ATTEMPTS; attempt += 1) {
  try {
    const strict = await client.chat({
      model: 'mimo-v2.6-flash',
      messages: MESSAGES,
      maxCompletionTokens: 500,
      jsonSchema: { name: 'conversation_quality', schema: SCHEMA, strict: true },
    });
    let parseable = true;
    try {
      JSON.parse(strict.text);
    } catch {
      parseable = false;
    }
    strictOutcomes.push({ attempt, parseable, finishReason: strict.finishReason, length: strict.text.length });
  } catch (error) {
    strictOutcomes.push({
      attempt,
      parseable: false,
      finishReason: `error: ${error instanceof Error ? error.message : String(error)}`,
      length: 0,
    });
  }
}
const strictFailures = strictOutcomes.filter((outcome) => !outcome.parseable).length;
const strictDefect =
  strictFailures === 0
    ? `连续 ${STRICT_ATTEMPTS} 次都正常——可能已修复，切换默认值前请再确认`
    : `仍不稳定：${strictFailures}/${STRICT_ATTEMPTS} 次返回不可解析的输出（因此默认 strict:false）`;

printEvidence('结构化输出（MiMo json_schema + 回退路径）', {
  model: 'mimo-v2.6-flash',
  chatJson: {
    attempts: ATTEMPTS,
    succeeded: callResults.filter((result) => result.ok === true).length,
    neededFallback: degraded,
    results: callResults,
  },
  rawJsonSchema: { knownDefect: strictDefect, attempts: strictOutcomes },
});

if (failures.length > 0) {
  console.error('\nverify:structured-output FAILED');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`\nverify:structured-output OK — ${ATTEMPTS} 次结构化调用全部可用（其中 ${degraded} 次走到了 json_object 回退），本地 schema 校验通过`);
console.log(`（原始 json_schema 通道的已知缺陷：${strictDefect}；因此所有结构化结果都必须本地校验）`);
