import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MimoBrainAdapter, collectTurn } from '@xixi/brain-adapter';
import { MimoClient } from '@xixi/model-adapters';

/**
 * t7 at the provider boundary: `MimoBrainAdapter` must not hand out tool-call markup.
 *
 * The leak's mechanism (baseline §4.1): the provider wrote the call into the *text* stream, so the
 * adapter yielded it as speech and the turn's text *was* the markup. These tests drive a real SSE
 * byte stream — including a delta boundary **inside** `<tool_call>` — because that split is the case
 * a naive filter would miss.
 *
 * t21 (re-checked by t1) added the other two things the t12/t4 reviews measured at *this* seam:
 * mid-reply English reasoning must not stream out either (t12 F1 — the shape its report reproduced
 * independently at the adapter exit), `options.language` selects which language the hold treats as
 * foreign (the acceptance clause 「适配器出口的过滤器带上语言参数」), and the provider's `finish_reason`
 * must reach `result` so a reply cut mid-word can be attributed (t4 F5). The option is **not** what
 * switches the hold on: omitted, the adapter falls back to `zh-CN` and the Chinese rules run anyway —
 * what the wiring is load-bearing for is a deployment that speaks something else, which the
 * `options.language` test below pins on both sides. The engine-seam shapes live in
 * `reply-pipeline.test.ts`; the filter's own shapes in `reply-hygiene.test.ts`.
 */

function clientWith(content: readonly string[], finishReason = 'stop'): MimoClient {
  const events: string[] = [];
  for (const piece of content) {
    events.push(`data: ${JSON.stringify({ model: 'mimo-v2.6-flash', choices: [{ delta: { content: piece }, finish_reason: null }] })}`);
    events.push('');
  }
  events.push(`data: ${JSON.stringify({ model: 'mimo-v2.6-flash', choices: [{ delta: {}, finish_reason: finishReason }] })}`);
  events.push('', 'data: [DONE]', '', '');
  const sse = events.join('\n');
  const fetchImpl = (async () => {
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode(sse);
      })(),
      json: async () => ({ model: 'mimo-v2.6-flash', choices: [{ message: { content: '' }, finish_reason: finishReason }] }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return new MimoClient({ apiKey: 'test-key', fetchImpl });
}

const MARKUP_DELTAS = [
  '明天',
  '<tool_ca',
  'll><function=get_weather><parameter=date>today</parameter>',
  '</tool_call>',
  '阴天，出门带把伞。',
];

const SESSION = 'sess_00000000-0000-4000-8000-000000000000';

test('a text-streamed tool call is never yielded and never becomes the turn text', async () => {
  const adapter = new MimoBrainAdapter({ client: clientWith(MARKUP_DELTAS), maxCompletionTokens: 64, temperature: 0 });
  const { chunks, result } = await collectTurn(await adapter.handleUserTurn({ sessionId: SESSION, text: '明天天气怎么样？' }));

  const spoken = chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.text).join('');
  assert.equal(spoken, '明天阴天，出门带把伞。', 'the half-markup chunks are dropped, the sentence survives');
  assert.equal(spoken.includes('tool_call'), false);
  assert.equal(spoken.includes('<'), false);
  assert.equal(result.text, '明天阴天，出门带把伞。');
  assert.equal(result.toolName, null, 'no tool actually ran');
});

test('a reply that is only markup becomes silence instead of being read out (baseline §4.1)', async () => {
  const deltas = ['<tool_call><function=get_weather>', '<parameter=city>上海</parameter>', '</function></tool_call>'];
  const adapter = new MimoBrainAdapter({ client: clientWith(deltas), maxCompletionTokens: 64, temperature: 0 });
  // The buffered path goes through the same generator (`#handleBuffered` drains it).
  const buffered = new MimoBrainAdapter({ client: clientWith(deltas), stream: false, maxCompletionTokens: 64, temperature: 0 });
  for (const candidate of [adapter, buffered]) {
    const { chunks, result } = await collectTurn(await candidate.handleUserTurn({ sessionId: SESSION, text: '明天天气怎么样？' }));
    assert.equal(chunks.filter((chunk) => chunk.type === 'text').length, 0, 'nothing reached the delta seam');
    assert.equal(result.action, 'SILENCE');
    assert.equal(result.text, null);
  }
});

/** The t12 review's C1 shape: the reply starts in Chinese, reasons in English mid-reply, then answers. */
const REASONING_DELTAS = [
  '嗯，我在的。',
  'The user asked twice in a row about the weather',
  ' and I need to answer with the tool result once it arrives.',
  '明天多云，出门带把伞。',
];

/** What the adapter itself let out of its delta seam (text chunks only). */
function streamedText(chunks: readonly { readonly type: string; readonly text?: string }[]): string {
  return chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.text ?? '').join('');
}

test('the adapter exit never streams mid-reply English reasoning (t12 F1 / t21)', async () => {
  const adapter = new MimoBrainAdapter({ client: clientWith(REASONING_DELTAS), maxCompletionTokens: 64, temperature: 0 });
  const { chunks, result } = await collectTurn(await adapter.handleUserTurn({ sessionId: SESSION, text: '明天天气怎么样？' }));
  const streamed = streamedText(chunks);
  assert.equal(streamed.includes('The user'), false, `the adapter delta seam leaked reasoning: ${streamed}`);
  assert.equal(streamed.includes('I need to'), false, `the adapter delta seam leaked reasoning: ${streamed}`);
  assert.equal(streamed.includes('嗯，我在的'), true, 'the Chinese opening is spoken');
  assert.equal(streamed.includes('明天多云'), true, 'and so is the real answer');
  assert.equal(result.text?.includes('The user'), false, 'the accumulated turn text is clean too');
});

test('options.language selects which language the hold treats as foreign (t12 F1 / t21)', async () => {
  // The acceptance clause is 「适配器出口的过滤器带上语言参数」, and the two sides below are what it
  // buys. The zh-CN side passes with the option omitted too: the adapter falls back to `zh-CN`
  // (`options.language ?? 'zh-CN'`), so the Chinese rules run either way — that assertion pins the
  // behaviour, not the wiring. The en-US side is the one that needs the option: with a hardcoded
  // Chinese hold (or with the option dropped) it goes red, because the deployment's own English text
  // is then held back as reasoning. Measured by deleting both `language:` options and re-running this
  // file: the zh-CN case stayed green, the en-US case failed.
  const zh = new MimoBrainAdapter({ client: clientWith(REASONING_DELTAS), maxCompletionTokens: 64, temperature: 0, language: 'zh-CN' });
  const zhOut = await collectTurn(await zh.handleUserTurn({ sessionId: SESSION, text: '明天天气怎么样？' }));
  assert.equal(streamedText(zhOut.chunks).includes('The user'), false, `zh-CN must hold the English run: ${streamedText(zhOut.chunks)}`);

  const en = new MimoBrainAdapter({ client: clientWith(REASONING_DELTAS), maxCompletionTokens: 64, temperature: 0, language: 'en-US' });
  const enOut = await collectTurn(await en.handleUserTurn({ sessionId: SESSION, text: 'how is the weather' }));
  assert.equal(streamedText(enOut.chunks).includes('The user'), true, `options.language must reach the filter: ${streamedText(enOut.chunks)}`);
});

test('the provider stop reason reaches the turn result, so a mid-word cut can be attributed (t4 F5 / t21)', async () => {
  const ok = new MimoBrainAdapter({ client: clientWith(REASONING_DELTAS), maxCompletionTokens: 64, temperature: 0 });
  const stopped = await collectTurn(await ok.handleUserTurn({ sessionId: SESSION, text: '明天天气怎么样？' }));
  assert.equal(stopped.result.finishReason, 'stop');

  const cut = new MimoBrainAdapter({ client: clientWith(REASONING_DELTAS, 'length'), maxCompletionTokens: 64, temperature: 0 });
  const truncated = await collectTurn(await cut.handleUserTurn({ sessionId: SESSION, text: '明天天气怎么样？' }));
  assert.equal(truncated.result.finishReason, 'length', 'finish_reason=length is what a reply cut mid-word looks like');

  // The buffered path drains the same generator, so it must carry the stop reason too.
  const buffered = new MimoBrainAdapter({ client: clientWith(REASONING_DELTAS, 'length'), stream: false, maxCompletionTokens: 64, temperature: 0 });
  const bufferedOut = await collectTurn(await buffered.handleUserTurn({ sessionId: SESSION, text: '明天天气怎么样？' }));
  assert.equal(bufferedOut.result.finishReason, 'length');
});
