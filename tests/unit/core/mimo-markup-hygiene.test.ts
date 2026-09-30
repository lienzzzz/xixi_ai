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
 */

function clientWith(content: readonly string[]): MimoClient {
  const events: string[] = [];
  for (const piece of content) {
    events.push(`data: ${JSON.stringify({ model: 'mimo-v2.6-flash', choices: [{ delta: { content: piece }, finish_reason: null }] })}`);
    events.push('');
  }
  events.push(`data: ${JSON.stringify({ model: 'mimo-v2.6-flash', choices: [{ delta: {}, finish_reason: 'stop' }] })}`);
  events.push('', 'data: [DONE]', '', '');
  const sse = events.join('\n');
  const fetchImpl = (async () => {
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode(sse);
      })(),
      json: async () => ({ model: 'mimo-v2.6-flash', choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
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
