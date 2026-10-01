import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeBrainAdapter,
  MAX_TOOL_ROUNDS,
  ToolRegistry,
  collectTurn,
  createToolRegistry,
  runAgentLoop,
  type AgentStep,
  type AgentStepOutcome,
  type AgentTool,
  type XixiTool,
} from '@xixi/brain-adapter';
import { WeatherClient, type MimoMessage } from '@xixi/model-adapters';

/**
 * Pack Phase 2 — the loop itself, driven without a network.
 *
 * `runAgentLoop` is the one loop both the streaming adapter and the offline stand-in run.
 * These tests pin the parts a model must not be able to change: that a tool result really
 * goes back to the model, that the round cap ends the loop, and that nothing internal
 * reaches something a person would hear.
 */

const GEOCODE = { results: [{ name: '成都', latitude: 30.66, longitude: 104.06, timezone: 'Asia/Shanghai', admin1: '四川省' }] };
const FORECAST = {
  timezone: 'Asia/Shanghai',
  daily: {
    time: ['2026-10-01', '2026-10-02', '2026-10-03'],
    weather_code: [61, 3, 0],
    temperature_2m_max: [25.1, 27.8, 26.4],
    temperature_2m_min: [19.0, 20.1, 18.6],
    precipitation_probability_max: [80, 8, 0],
  },
};

/** The internal wording a spoken reply must never contain (tool names, wire keys, JSON). */
const INTERNAL_MARKERS = /xixi_[a-z_]+|tool_call|arguments|parameters|schema|JSON|json|工具|调用|超时|不认识的参数/;

function stubWeatherRegistry(onToolCall?: (name: string) => void): ToolRegistry {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    return { ok: true, status: 200, json: async () => (url.includes('geocoding') ? GEOCODE : FORECAST) } as unknown as Response;
  }) as unknown as typeof fetch;
  return createToolRegistry({
    defaultPlace: '成都',
    weatherClient: new WeatherClient({ fetchImpl }),
    ...(onToolCall === undefined ? {} : { onToolCall: (record) => onToolCall(record.name) }),
  });
}

test('an offline text turn asking about the weather really runs the weather tool', async () => {
  const called: string[] = [];
  const adapter = new FakeBrainAdapter({ registry: stubWeatherRegistry((name) => called.push(name)) });
  const { chunks, result } = await collectTurn(await adapter.handleUserTurn({ sessionId: 'sess_loop', text: '明天天气怎么样？' }));

  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool'), [{ type: 'tool', name: 'xixi_get_weather' }]);
  assert.equal(result.toolName, 'xixi_get_weather', 'the turn says which tool backed it');
  assert.deepEqual(called, ['xixi_get_weather'], 'the registry executed exactly one call');
  assert.equal(result.action, 'SPEAK');
  assert.ok(result.text !== null && result.text.includes('明天成都阴'), `the reply is built from the tool result: ${result.text}`);
  assert.match(result.text ?? '', /20 到 28 度/, 'and carries the numbers the tool returned');
  assert.doesNotMatch(result.text ?? '', INTERNAL_MARKERS, 'no internal wording may reach a spoken reply');
});

test('a question that needs no lookup still answers without any tool', async () => {
  const called: string[] = [];
  const adapter = new FakeBrainAdapter({ registry: stubWeatherRegistry((name) => called.push(name)) });
  const { chunks, result } = await collectTurn(await adapter.handleUserTurn({ sessionId: 'sess_loop', text: '今天心情不错' }));
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool'), []);
  assert.equal(result.toolName, null);
  assert.equal(result.text, '模拟回复：今天心情不错');
  assert.deepEqual(called, []);
});

test('the loop appends the tool result back to the model (model → tool → model)', async () => {
  const registry = new ToolRegistry();
  const tool: XixiTool & AgentTool = {
    name: 'xixi_probe',
    description: '探针',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    scopes: ['conversation'],
    async execute() {
      return { answer: 42 };
    },
  };
  registry.register(tool);

  const roundTwoMessages: MimoMessage[][] = [];
  const step: AgentStep = {
    async *call(messages, tools, round): AsyncGenerator<never, AgentStepOutcome, void> {
      if (round === 1) {
        return { model: 'probe', finishReason: 'tool_calls', rawText: '', spokenText: '', toolCalls: [{ id: 'call_1', name: 'xixi_probe', arguments: '{}' }] };
      }
      roundTwoMessages.push([...messages]);
      const text = '答案拿到了。';
      yield { type: 'text', text };
      return { model: 'probe', finishReason: 'stop', rawText: text, spokenText: text, toolCalls: [] };
    },
  };

  const iterator = runAgentLoop(step, [{ role: 'user', content: '？' }], {
    registry,
    scope: 'conversation',
    context: { timezone: 'Asia/Shanghai', now: new Date('2026-10-01T09:00:00+08:00') },
  });
  const chunks: unknown[] = [];
  let outcome;
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) {
      outcome = next.value;
      break;
    }
    chunks.push(next.value);
  }

  assert.deepEqual(chunks, [{ type: 'tool', name: 'xixi_probe' }, { type: 'text', text: '答案拿到了。' }]);
  assert.deepEqual(outcome.usedTools, ['xixi_probe']);
  assert.equal(outcome.rounds, 2);
  assert.equal(outcome.text, '答案拿到了。');
  // The second round saw both the assistant tool_calls message and the tool result.
  const seen = roundTwoMessages[0] ?? [];
  assert.deepEqual(seen.map((message) => message.role), ['user', 'assistant', 'tool']);
  assert.equal(seen[1]?.tool_calls?.[0]?.function.name, 'xixi_probe');
  assert.deepEqual(JSON.parse(seen[2]?.content ?? '{}'), { answer: 42 });
});

test('a model that never stops asking for a tool is stopped after four rounds', async () => {
  const registry = new ToolRegistry();
  let executed = 0;
  registry.register({
    name: 'xixi_greedy',
    description: '永不满足的探针',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    scopes: ['conversation'],
    async execute() {
      executed += 1;
      return { n: executed };
    },
  });

  const roundsSeen: number[] = [];
  const step: AgentStep = {
    async *call(_messages, tools, round): AsyncGenerator<never, AgentStepOutcome, void> {
      roundsSeen.push(round);
      // The model keeps asking for as long as it is offered a tool; only the programme's
      // cap takes the tools away, and that is what ends the turn.
      if (tools !== undefined) {
        return { model: 'greedy', finishReason: 'tool_calls', rawText: '', spokenText: '', toolCalls: [{ id: `call_${round}`, name: 'xixi_greedy', arguments: '{}' }] };
      }
      const text = '查不完了，我先说到这儿。';
      yield { type: 'text', text };
      return { model: 'greedy', finishReason: 'stop', rawText: text, spokenText: text, toolCalls: [] };
    },
  };

  const iterator = runAgentLoop(step, [{ role: 'user', content: '？' }], {
    registry,
    scope: 'conversation',
    context: { timezone: 'Asia/Shanghai', now: new Date() },
  });
  let outcome;
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) {
      outcome = next.value;
      break;
    }
  }
  assert.equal(executed, MAX_TOOL_ROUNDS, `expected ${MAX_TOOL_ROUNDS} executions, saw ${executed}`);
  assert.deepEqual(roundsSeen, [1, 2, 3, 4, 5], 'the fifth round is asked, but with no tools on offer');
  assert.equal(outcome.usedTools.length, MAX_TOOL_ROUNDS);
  assert.equal(outcome.text, '查不完了，我先说到这儿。', 'the turn still ends with something said');
});

test('a tool the policy refuses is not executed, and the reply says so without leaking anything', async () => {
  // The guest scope cannot see the reminder stub, so a scripted model that asks for it
  // gets a refusal — and the tool body never runs (there is no sink write to observe,
  // because the registry refuses before the call).
  const registry = createToolRegistry({ defaultPlace: '成都' });
  const adapter = new FakeBrainAdapter({
    registry,
    scope: 'guest',
    toolPlan: () => [{ name: 'xixi_set_reminder_stub', arguments: { what: '吃药' } }],
  });
  const { result } = await collectTurn(await adapter.handleUserTurn({ sessionId: 'sess_guest', text: '提醒我吃药' }));
  assert.equal(result.text, '这件事我现在查不到，晚点再说吧。');
  assert.doesNotMatch(result.text ?? '', INTERNAL_MARKERS);
});
