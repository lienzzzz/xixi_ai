import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBrainTurnStream, type BrainTurnResult } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { fixedClock, openXixiStore, type XixiConfig } from '@xixi/domain';

import {
  createModelComposer,
  type ProactiveCandidatePlan,
  type ProactiveComposeInput,
} from '../../scripts/field-test.ts';

/**
 * 主动开口不许编造可核查的具体事实（t111）。
 *
 * 真机观测：控制台的主动开口说出「成都阴天 19 到 25 度」，而那一轮没有调用 `xixi_get_weather`。
 * 提示词（`HARD_POLICY` 第 7 条）是第一层；这里钉住第二层——**投递接缝的确定性闸门**：
 * 模型给了具体数值却没有跑过任何工具 → 这句不发出去，换成该触发源的固定短句，并在 note 里写明原因。
 * （这是「凡说具体数值必有一次工具调用」在事件日志里成立的前提。）
 */

const PLAN = {
  candidate: { candidateId: 'pc_test_1', trigger: 'presence_arrived', components: { event_salience: 1 } },
  line: '回来啦，先喝口水吧。',
  fact: 'presence.changed: present=true',
} as unknown as ProactiveCandidatePlan;

const INPUT = { plan: PLAN, delivery: {} } as unknown as ProactiveComposeInput;

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: {
    llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false },
    asr: { provider: 'fake', model: 'fake-asr' },
    tts: { provider: 'fake', model: 'fake-tts' },
  },
  personality: { base: {} },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

/**
 * The real screening rule, taken from a real engine — only the *composer's* prompt/adapter calls are
 * stubbed (that part needs a live session and would call the network). Delegating the rule keeps
 * this test honest: it cannot pass if `screenUnbackedFacts` changes meaning.
 */
function realScreeningEngine(): ConversationEngine {
  const store = openXixiStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-unbacked-console-')), 'x.sqlite'),
    clock: fixedClock(new Date('2026-09-30T10:00:00+08:00'), 1_000),
  });
  const adapter = {
    provider: 'never-called',
    describe: () => ({ provider: 'never-called', model: 'never', transport: 'in-memory', mode: 'scripted' as const }),
    handleUserTurn: async () => {
      throw new Error('the screening engine never talks to a model in this test');
    },
    evaluateProactiveCandidate: async () => {
      throw new Error('unused');
    },
    interpretFeedback: async () => {
      throw new Error('unused');
    },
    extractMemories: async () => {
      throw new Error('unused');
    },
    reflect: async () => {
      throw new Error('unused');
    },
  } as unknown as ConversationEngine['adapter'];
  return new ConversationEngine({
    adapter,
    store,
    config: CONFIG,
    clock: fixedClock(new Date('2026-09-30T10:00:00+08:00'), 1_000),
    offsetMinutes: 480,
    fsm: { lingerMs: 30_000 },
  });
}

function composerAnswering(text: string, toolName: string | null) {
  const result: BrainTurnResult = {
    action: 'SPEAK',
    text,
    toolName,
    provider: 'scripted',
    model: 'scripted-1',
    brainSessionId: null,
    latencyMs: 1,
  };
  const screening = realScreeningEngine();
  const engine = {
    buildPrompt: () => ({ system: 'S', history: [], user: 'U' }),
    screenUnbackedFacts: (candidate: string, tool: string | null) => screening.screenUnbackedFacts(candidate, tool),
    adapter: {
      handleUserTurn: async () => {
        async function* empty() {
          /* the composer only needs the final result */
        }
        return createBrainTurnStream(empty(), Promise.resolve(result));
      },
    },
  };
  const logged: string[] = [];
  return {
    compose: createModelComposer({
      engine: engine as unknown as ConversationEngine,
      sessionId: () => 'sess_test',
      available: true,
      log: (line) => void logged.push(line),
    }),
    logged,
  };
}

test('a proactive line with a number the model never looked up is replaced before it is spoken', async () => {
  const { compose, logged } = composerAnswering('明天成都阴天 19 到 25 度，出门记得加件衣服。', null);
  const composed = await compose(INPUT);

  assert.equal(composed.source, 'fixed', 'the fabricated line must not be the spoken content');
  assert.equal(composed.text, PLAN.line, 'the trigger\'s fixed short line has no numbers of its own');
  assert.match(composed.note ?? '', /未经工具核实/);
  assert.match(composed.note ?? '', /19 到 25 度/, 'the note names what was dropped, for the audit trail');
  assert.equal(composed.toolName, null, 'no tool ran, and the recorded turn must say so');
  assert.equal(logged.some((line) => line.includes('19 到 25 度')), true, 'the console log explains the replacement');
});

test('the same sentence is spoken when the model did call the weather tool', async () => {
  const text = '明天成都 19 到 25 度，多云，出门刚好。';
  const { compose } = composerAnswering(text, 'xixi_get_weather');
  const composed = await compose(INPUT);

  assert.equal(composed.source, 'model');
  assert.equal(composed.text, text);
  assert.equal(composed.toolName, 'xixi_get_weather', 'the tool travels with the content into the event log');
});

test('an ordinary line with no lookup-only specifics passes through untouched', async () => {
  const text = '你回来啦，先去洗把手吧。';
  const { compose } = composerAnswering(text, null);
  const composed = await compose(INPUT);

  assert.equal(composed.source, 'model');
  assert.equal(composed.text, text);
  assert.equal(composed.note, null);
});
