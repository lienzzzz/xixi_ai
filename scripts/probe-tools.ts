/**
 * Diagnose the realtime tool path: does the model request `xixi_get_weather`,
 * and does the adapter execute it? Prints the raw decision for each variant.
 *
 * Pack Phase 2: the diagnostic now builds the same `ToolRegistry` the entry points use,
 * so it also shows what the model is actually offered (the four built-ins, the scope
 * filter, and the round cap) before any call is made.
 */
import { MimoBrainAdapter, ToolPermission, collectTurn, createToolRegistry } from '@xixi/brain-adapter';
import { MimoClient } from '@xixi/model-adapters';

import { readDotEnv } from './lib/harness.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const client = new MimoClient();
const registry = createToolRegistry({ defaultPlace: '成都', onToolCall: (record) => console.log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`) });
const conversations = registry.listForAgent('conversation');
console.log(
  JSON.stringify({
    registered: registry.names(),
    offeredToModel: conversations.map((tool) => tool.name),
    risks: Object.fromEntries(conversations.map((tool) => [tool.name, tool.risk])),
    // The programme's own answers, printed so a reader can see the boundaries without a call:
    permissionProbe: {
      guestReminder: new ToolPermission({ role: 'guest' }).check(
        conversations.find((tool) => tool.name === 'xixi_set_reminder_stub') ?? conversations[0]!,
        { scope: 'conversation', role: 'guest' },
      ),
      guestScopeWeather: registry.check('xixi_get_weather', 'guest'),
      roundsOfferedRound5: registry.definitionsForRound('conversation', 5),
    },
    maxToolRounds: registry.maxToolRounds,
  }),
);

// 1) Does the provider return tool_calls when we ask plainly, with no history?
const raw = await client.chat({
  model: 'mimo-v2.6-flash',
  messages: [
    { role: 'system', content: '你是西西。需要外部信息时调用工具，不要凭记忆回答。' },
    { role: 'user', content: '明天成都天气怎么样？' },
  ],
  tools: conversations.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  maxCompletionTokens: 200,
});
console.log(
  JSON.stringify({
    rawFinishReason: raw.finishReason,
    rawToolCalls: raw.toolCalls.map((call) => ({ name: call.name, args: call.arguments })),
    rawText: raw.text.slice(0, 120),
  }),
);

// 2) Does the adapter execute it end to end, through the registry?
const calls: string[] = [];
const adapter = new MimoBrainAdapter({
  client,
  registry: createToolRegistry({ defaultPlace: '成都', onToolCall: (record) => calls.push(`${record.name}:${record.ok ? 'ok' : record.error}`) }),
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
