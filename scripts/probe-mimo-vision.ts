/**
 * Probe whether MiMo's chat completions API accepts **image input**, and in which shape.
 *
 * Why this exists: it is the raw evidence behind `docs/recon/mimo-vision-probe-2026-09-30.md`,
 * which decides between two ways of letting 西西 "see" (send one downscaled still frame vs.
 * describe the frame locally and send text). Nothing in `packages/` depends on this script.
 *
 * The API key is read from `MIMO_API_KEY` (falling back to `.env`) and is **never** printed:
 * every string that reaches stdout goes through `redact()`, and image bytes are summarised
 * as `base64:<n chars>` instead of being echoed.
 *
 * Usage:
 *   node scripts/probe-mimo-vision.ts                       # all variants, embedded 64x64 JPEG
 *   node scripts/probe-mimo-vision.ts --image <path.jpg>    # same, with a real frame
 *   node scripts/probe-mimo-vision.ts --model mimo-v2.6-pro # another model id
 *   node scripts/probe-mimo-vision.ts --only text           # just the control variant
 *
 * Exit code: 0 when the probe ran to completion (whatever the API answered), 1 when it could
 * not run at all (no key, unreadable image).
 */
import { readFileSync } from 'node:fs';

import { readDotEnv, requireMimoApiKey } from './lib/harness.ts';

const BASE_URL = (process.env.MIMO_BASE_URL ?? 'https://api.xiaomimimo.com/v1').replace(/\/$/, '');
const ROOT_URL = BASE_URL.replace(/\/v1$/, '');
const DEFAULT_MODEL = 'mimo-v2.6-flash';
const TIMEOUT_MS = 60_000;

/**
 * Embedded 64x64 JPEG fixture: white canvas, one red disc (r=18) plus a small blue square.
 * Generated once with OpenCV (`cv2.circle` / `cv2.rectangle` / `cv2.imencode`, quality 80),
 * so the probe needs no image library at runtime. The prompt asks for the main colour, so a
 * correct answer is 「红」; without an image the same prompt cannot produce that.
 */
const FIXTURE_JPEG_BASE64 = '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';

const PROMPT = '这张图里最主要的是什么颜色？只回答颜色两个字。';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

const apiKey = requireMimoApiKey();
const model = argValue('--model') ?? DEFAULT_MODEL;
const only = argValue('--only');
const imagePath = argValue('--image');

/** Any string on its way to stdout goes through this: the key must never be readable. */
function redact(text: string): string {
  return apiKey.length === 0 ? text : text.split(apiKey).join('<redacted-key>');
}

function imageBase64(): string {
  if (imagePath === null) return FIXTURE_JPEG_BASE64;
  return readFileSync(imagePath).toString('base64');
}

function summarizeImage(): string {
  if (imagePath === null) return 'embedded 64x64 JPEG fixture (white + one red disc + one blue square)';
  return `${imagePath} (${readFileSync(imagePath).length} bytes)`;
}

/** Replace image payloads with a size note so the printed body stays readable. */
function shapeOf(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) return `data:<redacted image, ${value.length} chars>`;
    if (value.length > 120 && /^[A-Za-z0-9+/=]+$/.test(value)) return `base64:<${value.length} chars>`;
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => shapeOf(entry));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = shapeOf(entry);
    return out;
  }
  return value;
}

interface Variant {
  readonly id: string;
  readonly what: string;
  readonly content: unknown;
}

const dataUrl = `data:image/jpeg;base64,${imageBase64()}`;
const variants: Variant[] = [
  {
    id: 'image_url-dataurl',
    what: 'OpenAI-style content array with an image_url data URL (base64 inline)',
    content: [
      { type: 'text', text: PROMPT },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  },
  {
    id: 'image-source-base64',
    what: 'alternative shape: {type:"image", source:{type:"base64",...}} (what a wrong guess looks like)',
    content: [
      { type: 'text', text: PROMPT },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrl.split(',')[1] ?? '' } },
    ],
  },
  {
    id: 'text-control',
    what: 'control: the same prompt with no image at all (it must not answer 「红」)',
    content: PROMPT,
  },
];

function listModels(): void {
  console.log('=== model list: GET /v1/models and GET /models (the status of each is itself evidence) ===');
  for (const path of ['/v1/models', '/models']) {
    void fetch(`${ROOT_URL}${path}`, {
      headers: { 'api-key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then(async (response) => {
        const text = redact(await response.text());
        try {
          const parsed = JSON.parse(text) as { data?: { id?: string }[] };
          const ids = (parsed.data ?? []).map((entry) => entry.id ?? '?');
          console.log(`${path}: status ${response.status}, ids (${ids.length}): ${ids.join(', ')}`);
        } catch {
          console.log(`${path}: status ${response.status}, non-JSON body: ${text.slice(0, 120)}`);
        }
      })
      .catch((error: unknown) => {
        console.log(`${path}: request failed: ${redact(String(error))}`);
      });
  }
}

async function runVariant(variant: Variant): Promise<Record<string, unknown>> {
  const body = {
    model,
    messages: [{ role: 'user', content: variant.content }],
    max_completion_tokens: 32,
    temperature: 0,
    thinking: { type: 'disabled' },
    stream: false,
  };
  console.log(`\n=== ${variant.id} :: ${variant.what} ===`);
  console.log(`body: ${JSON.stringify(shapeOf(body))}`);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = redact(await response.text());
    const elapsedMs = Date.now() - startedAt;
    console.log(`status: ${response.status} (${elapsedMs}ms)`);
    let content: unknown = null;
    let errorText: unknown = null;
    let usage: unknown = null;
    try {
      const parsed = JSON.parse(raw) as {
        choices?: { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }[];
        usage?: unknown;
        error?: unknown;
      };
      content = parsed.choices?.[0]?.message?.content ?? null;
      usage = parsed.usage ?? null;
      if (parsed.error !== undefined) errorText = parsed.error;
      console.log(`content: ${JSON.stringify(content)}`);
      if (parsed.choices?.[0]?.message?.reasoning_content !== undefined) {
        console.log(`reasoning_content: ${JSON.stringify(parsed.choices[0].message.reasoning_content)}`);
      }
      if (usage !== null) console.log(`usage: ${JSON.stringify(usage)}`);
    } catch {
      console.log(`body: ${raw.slice(0, 800)}`);
    }
    if (errorText !== null) console.log(`error: ${JSON.stringify(errorText)}`);
    return { variant: variant.id, status: response.status, elapsedMs, content, error: errorText, usage };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    console.log(`request failed (${elapsedMs}ms): ${message}`);
    return { variant: variant.id, status: null, elapsedMs, content: null, error: message, usage: null };
  }
}

console.log(`endpoint: ${BASE_URL}/chat/completions`);
console.log(`auth header: api-key (value never printed; source: MIMO_API_KEY or .env)`);
console.log(`model: ${model}`);
console.log(`image: ${summarizeImage()}`);
listModels();

const results: Record<string, unknown>[] = [];
for (const variant of variants) {
  if (only !== null && variant.id !== only) continue;
  results.push(await runVariant(variant));
}

console.log(`\n=== summary ===`);
console.log(JSON.stringify(results, null, 2));
const sawImage = results.some((entry) => String(entry['content'] ?? '').includes('红'));
console.log(
  sawImage
    ? `verdict: at least one variant made the model answer 「红」 — compare against the text-control variant`
    : `verdict: no variant produced 「红」; read the statuses/errors above for the reason`,
);
