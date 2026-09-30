/**
 * Diagnose the realtime tool path: does the model request `xixi_get_weather`,
 * and does the adapter execute it? Prints the raw decision for each variant.
 */
import { MimoBrainAdapter, collectTurn, defaultTools } from '@xixi/brain-adapter';
import { MimoClient } from '@xixi/model-adapters';

import { readDotEnv } from './lib/harness.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const client = new MimoClient();
const tools = defaultTools({ defaultPlace: '成都' });
console.log(`tools: ${tools.map((tool) => tool.name).join(', ')}`);

// 1) Does the provider return tool_calls when we ask plainly, with no history?
const raw = await client.chat({
  model: 'mimo-v2.6-flash',
  messages: [
    { role: 'system', content: '你是西西。需要外部信息时调用工具，不要凭记忆回答。' },
    { role: 'user', content: '明天成都天气怎么样？' },
  ],
  tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  maxCompletionTokens: 200,
});
console.log(
  JSON.stringify({
    rawFinishReason: raw.finishReason,
    rawToolCalls: raw.toolCalls.map((call) => ({ name: call.name, args: call.arguments })),
    rawText: raw.text.slice(0, 120),
  }),
);

// 2) Does the adapter execute it end to end?
const calls: string[] = [];
const adapter = new MimoBrainAdapter({
  client,
  tools,
  onToolCall: (record) => calls.push(`${record.name}:${record.ok ? 'ok' : record.error}`),
});
const { result, chunks } = await collectTurn(await adapter.handleUserTurn({ sessionId: 'sess_probe', text: '明天成都天气怎么样？' }));
console.log(
  JSON.stringify({
    adapterAction: result.action,
    adapterToolName: result.toolName,
    adapterText: (result.text ?? '').slice(0, 160),
    toolChunks: chunks.filter((chunk) => chunk.type === 'tool'),
    executed: calls,
  }),
);
