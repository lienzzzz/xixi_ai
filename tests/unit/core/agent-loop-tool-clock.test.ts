/**
 * pack v03-preflight ⑨：agent-loop 交给工具的 `now` 是**回合开始时的快照**，不是这一调用的真实时刻。
 *
 * 事实：`runAgentLoop` 把 `options.context.now`（适配器在回合开始时读的一次）原样传给每一次工具调用。
 * 后果不是理论上的：一轮里模型可能连问四次工具、每次都在几十秒之后；`xixi_get_current_time`
 * （以及任何与静默时段、提醒时间比较的工具）拿到的却是「回合刚开始的那一刻」。
 * pack 给的两条出路是「按真实执行时刻」或「改名成 turnStartedAt」——这里选**前者**：
 * `context` 交出一个**时钟**（`clock`），每次调用各读一次；名字不再叫 `now`，免得下一个人又以为
 * 它是一次快照。
 *
 * 判红方式：时钟每次读都前进 1 秒；修好之前两次调用拿到的是同一个时刻（快照），断言不等。
 *
 * Run: `npm test`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_TOOL_ROUNDS,
  ToolRegistry,
  runAgentLoop,
  type AgentStep,
  type AgentStepOutcome,
  type BrainTurnChunk,
} from '@xixi/brain-adapter';

/** 每被读一次就前进一秒：把「快照」与「每次调用各读一次」区分开。 */
function tickingClock(start: Date): { clock: () => Date; reads: () => number } {
  let reads = 0;
  return {
    clock: () => new Date(start.getTime() + reads++ * 1000),
    reads: () => reads,
  };
}

/** 一个只会记录「我被调用时看到的时刻」的工具。 */
function stampingRegistry(stamps: Date[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'xixi_probe_stamp',
    description: '记录调用时刻的探针',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    scopes: ['conversation'],
    async execute(_args, context) {
      stamps.push(context.now);
      // 让每次调用之间真的隔开（同步返回的话三次调用会在同一毫秒里完成，断言就分不出来了）。
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { stamp: context.now.toISOString() };
    },
  });
  return registry;
}

test('每一次工具调用都按自己的执行时刻读时钟，而不是回合开始的一次快照', async () => {
  const stamps: Date[] = [];
  const registry = stampingRegistry(stamps);
  const { clock, reads } = tickingClock(new Date('2026-10-01T09:00:00.000Z'));

  const step: AgentStep = {
    async *call(_messages, tools, round): AsyncGenerator<BrainTurnChunk, AgentStepOutcome, void> {
      if (round <= 2 && tools !== undefined) {
        return { model: 'probe', finishReason: 'tool_calls', rawText: '', spokenText: '', toolCalls: [{ id: `call_${round}`, name: 'xixi_probe_stamp', arguments: '{}' }] };
      }
      const text = '读完了。';
      yield { type: 'text', text };
      return { model: 'probe', finishReason: 'stop', rawText: text, spokenText: text, toolCalls: [] };
    },
  };

  const iterator = runAgentLoop(step, [{ role: 'user', content: '现在几点？' }], {
    registry,
    scope: 'conversation',
    context: { timezone: 'Asia/Shanghai', clock },
  });
  let outcome: { usedTools: readonly string[] } | undefined;
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) {
      outcome = next.value;
      break;
    }
  }

  assert.equal(outcome?.usedTools.length, 2, '两次调用都真的跑了');
  assert.equal(stamps.length, 2);
  assert.equal(reads(), 2, '时钟被读了两次 —— 一次一读，不是一次快照');
  assert.equal(stamps[0]?.getTime(), new Date('2026-10-01T09:00:00.000Z').getTime());
  assert.ok(
    (stamps[1]?.getTime() ?? 0) > (stamps[0]?.getTime() ?? 0),
    `第二次调用必须拿到更晚的时刻：${stamps.map((stamp) => stamp.toISOString()).join(' / ')}`,
  );
  assert.ok(MAX_TOOL_ROUNDS >= 2, '本条用例假设至少允许两次工具调用');
});
