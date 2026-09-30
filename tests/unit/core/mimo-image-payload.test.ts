import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrainError, DshBrainAdapter, MimoBrainAdapter, collectTurn } from '@xixi/brain-adapter';
import { openXixiStore } from '@xixi/domain';
import { MimoClient, imageDataUrl } from '@xixi/model-adapters';

/**
 * Optional image input, pinned at the two places it can silently go wrong.
 *
 * 1. **The pure-text path must not change.** Adding a field is only safe if a turn
 *    without images produces the *same bytes* as before, so the first two cases
 *    compare the serialized request body against a literal, not against a parsed
 *    object (a parsed comparison would not notice a reordered or dropped field).
 * 2. **The image path must be the shape the API accepted.** Measured 2026-09-30
 *    (docs/recon/mimo-vision-probe-2026-09-30.md): an OpenAI-style content array
 *    with an `image_url` part carrying a base64 `data:` URL, and nothing else.
 *
 * The third case is the one an offline test can still catch: the DSH harness path
 * cannot send images, and it must **refuse** rather than drop them — a dropped
 * image would let the model answer as if it had seen the frame.
 */
interface Captured {
  readonly raw: string[];
  readonly bodies: Record<string, unknown>[];
}

function capturingClient(): { client: MimoClient; captured: Captured } {
  const captured: Captured = { raw: [], bodies: [] };
  // Both shapes are served from one stub: `json()` for the buffered `chat()`
  // calls, and a real SSE byte stream for `chatStream()` (used by
  // `MimoBrainAdapter` when it drains a turn).
  const sse = [
    `data: ${JSON.stringify({ model: 'mimo-v2.6-flash', choices: [{ delta: { content: '收到' }, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ model: 'mimo-v2.6-flash', choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  const fetchImpl = (async (_url: string, init: { body?: string }) => {
    const raw = String(init.body ?? '');
    captured.raw.push(raw);
    captured.bodies.push(JSON.parse(raw) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode(sse);
      })(),
      json: async () => ({ model: 'mimo-v2.6-flash', choices: [{ message: { content: '收到' }, finish_reason: 'stop' }] }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { client: new MimoClient({ apiKey: 'test-key', fetchImpl }), captured };
}

const IMAGE = [{ mediaType: 'image/jpeg', base64: 'QUJD' }] as const;

test('a text-only chat body is byte-identical to the pre-image shape', async () => {
  const { client, captured } = capturingClient();
  await client.chat({
    model: 'mimo-v2.6-flash',
    messages: [{ role: 'user', content: '你好' }],
    maxCompletionTokens: 8,
    temperature: 0,
  });
  assert.equal(
    captured.raw[0],
    JSON.stringify({
      model: 'mimo-v2.6-flash',
      messages: [{ role: 'user', content: '你好' }],
      max_completion_tokens: 8,
      stream: false,
      temperature: 0,
      thinking: { type: 'disabled' },
    }),
  );
});

test('an image becomes an OpenAI-style content array with a base64 data URL', async () => {
  const { client, captured } = capturingClient();
  await client.chat({
    model: 'mimo-v2.6-flash',
    messages: [
      { role: 'system', content: '你是西西' },
      { role: 'user', content: '这张图是什么颜色？', images: IMAGE },
    ],
    maxCompletionTokens: 8,
    temperature: 0,
  });
  assert.equal(
    captured.raw[0],
    JSON.stringify({
      model: 'mimo-v2.6-flash',
      messages: [
        // Untouched: only the message that carries an image is rewritten.
        { role: 'system', content: '你是西西' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图是什么颜色？' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
          ],
        },
      ],
      max_completion_tokens: 8,
      stream: false,
      temperature: 0,
      thinking: { type: 'disabled' },
    }),
  );
  // `images` is a local field: inventing it upstream would be a wire-shape bug.
  assert.equal(captured.raw[0].includes('"images"'), false, 'the local `images` field must not reach the API');
  assert.equal(imageDataUrl(IMAGE[0]), 'data:image/jpeg;base64,QUJD');
});

test('the brain seam attaches an image to the current user turn only', async () => {
  const { client, captured } = capturingClient();
  const adapter = new MimoBrainAdapter({ client, stream: false, maxCompletionTokens: 8, temperature: 0 });
  const sessionId = 'sess_00000000-0000-4000-8000-000000000000';

  await collectTurn(await adapter.handleUserTurn({ sessionId, text: '这张图是什么颜色？' }));
  await collectTurn(await adapter.handleUserTurn({ sessionId, text: '这张图是什么颜色？', images: IMAGE }));

  const [plain, withImage] = captured.bodies;
  assert.deepEqual(plain?.['messages'], [{ role: 'user', content: '这张图是什么颜色？' }], 'no image → plain string content');
  assert.deepEqual(withImage?.['messages'], [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图是什么颜色？' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      ],
    },
  ]);
  // Everything except `messages` must be identical between the two turns.
  const { messages: _plainMessages, ...plainRest } = plain ?? {};
  const { messages: _imageMessages, ...imageRest } = withImage ?? {};
  assert.deepEqual(imageRest, plainRest, 'adding an image may only change `messages`');
});

test('the DSH path refuses an image turn instead of silently dropping the frame', async () => {
  const store = openXixiStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-image-seam-')), 'x.sqlite') });
  try {
    const session = store.createSession();
    let transportCalls = 0;
    const adapter = new DshBrainAdapter({
      transport: {
        kind: 'counting',
        turn: async () => {
          transportCalls += 1;
          throw new Error('the transport must not be reached for an image turn');
        },
      },
      store,
    });
    await assert.rejects(
      () => adapter.handleUserTurn({ sessionId: session.sessionId, text: '这是什么？', images: IMAGE }),
      (error: unknown) =>
        error instanceof BrainError && error.code === 'BAD_REQUEST' && error.detail.includes('1 image(s)'),
    );
    assert.equal(transportCalls, 0, 'a refused turn must not reach the harness');
  } finally {
    store.close();
  }
});
