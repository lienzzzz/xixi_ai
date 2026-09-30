import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBrainTurnStream,
  type BrainAdapter,
  type BrainDescription,
  type BrainTurnChunk,
  type BrainTurnResult,
  type BrainTurnStream,
  type UserTurnInput,
} from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { fixedClock, openXixiStore, type XixiConfig, type XixiStore } from '@xixi/domain';

/**
 * 不许编造可核查的具体事实（t111）。
 *
 * 真机观测：主动开口说出「成都阴天 19 到 25 度」，而那一轮**一次工具调用都没有**——
 * 一个模型不可能知道的数字。提示词里写禁令（`HARD_POLICY` 第 7 条）只是第一层；铁律 1/3
 * 要求边界由程序持有，所以 `ConversationEngine.respond` 还有一道确定性闸门：
 * 这一轮没跑过任何工具、却出现了「只有查得到才知道」的具体值 → 那句**不进音频、不进日志**，
 * 改成「我记不准」，并给调用方一条 `UNBACKED_FACT_CLAIM` 通知。
 */

const T0 = new Date('2026-09-30T10:00:00+08:00');

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

function store(): XixiStore {
  return openXixiStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-unbacked-')), 'x.sqlite'), clock: fixedClock(T0, 1_000) });
}

/** An adapter that emits exactly the chunks a test needs, including a `tool` chunk. */
function scriptedAdapter(chunks: readonly BrainTurnChunk[], result: Partial<BrainTurnResult>): BrainAdapter {
  return {
    provider: 'scripted',
    describe: (): BrainDescription => ({ provider: 'scripted', model: 'scripted-1', transport: 'in-memory', mode: 'scripted' }),
    handleUserTurn: (input: UserTurnInput): Promise<BrainTurnStream> => {
      const text = chunks
        .filter((chunk): chunk is { type: 'text'; text: string } => chunk.type === 'text')
        .map((chunk) => chunk.text)
        .join('');
      async function* emit(): AsyncGenerator<BrainTurnChunk> {
        for (const chunk of chunks) yield chunk;
      }
      return Promise.resolve(
        createBrainTurnStream(emit(), Promise.resolve({
          action: 'SPEAK',
          text,
          toolName: null,
          provider: 'scripted',
          model: 'scripted-1',
          brainSessionId: `scripted-${input.sessionId}`,
          latencyMs: 1,
          ...result,
        })),
      );
    },
    evaluateProactiveCandidate: () => Promise.reject(new Error('unused')),
    interpretFeedback: () => Promise.reject(new Error('unused')),
    extractMemories: () => Promise.reject(new Error('unused')),
    reflect: () => Promise.reject(new Error('unused')),
  };
}

function engineFor(adapter: BrainAdapter, s: XixiStore): ConversationEngine {
  return new ConversationEngine({ adapter, store: s, config: CONFIG, clock: fixedClock(T0, 1_000), offsetMinutes: 480, fsm: { lingerMs: 30_000 } });
}

const FABRICATED = '明天成都阴天 19 到 25 度，记得带伞。';
const TOOL_BACKED = '明天成都 19 到 25 度，多云，适合出门。（来自 xixi_get_weather）';
/** Pinned here on purpose: the repair line must carry no numbers and no new facts. */
const REPAIR = '这个我记不准，不敢乱说——要不我查一下再告诉你？';

test('the detector fires on lookup-only specifics and leaves ordinary talk alone', () => {
  const s = store();
  try {
    const engine = engineFor(scriptedAdapter([], {}), s);
    const kinds = (text: string): string[] => engine.screenUnbackedFacts(text, null).claims.map((claim) => `${claim.kind}:${claim.match}`);

    assert.deepEqual(kinds('明天成都阴天 19 到 25 度'), ['temperature:19 到 25 度']);
    assert.deepEqual(kinds('今天零下 3 度'), ['temperature:零下 3 度']);
    assert.deepEqual(kinds('气温 25℃'), ['temperature:25℃']);
    assert.deepEqual(kinds('降水概率 60%'), ['forecast:降水概率 60%']);
    assert.deepEqual(kinds('湿度 45'), ['forecast:湿度 45']);
    // The review's (t114 §2) other «该拦» fixtures, so the tightening cannot quietly drop them:
    assert.deepEqual(kinds('海上风力 4 级'), ['forecast:风力 4 级']);
    assert.deepEqual(kinds('今天空气质量 120'), ['forecast:空气质量 120']);
    assert.deepEqual(kinds('紫外线指数 7，注意防晒'), ['forecast:紫外线指数 7']);
    // Attribution only fires when the source is the *speaker* and the sentence says something
    // checkable (t117 / review F1):
    assert.deepEqual(kinds('天气预报说明天有雨'), ['attribution:天气预报']);
    assert.deepEqual(kinds('气象台说今晚降温'), ['attribution:气象台']);
    assert.deepEqual(kinds('新闻里说小区要停水'), ['attribution:新闻']);
    assert.deepEqual(kinds('天气预报说今天 19 到 25 度'), ['temperature:19 到 25 度', 'attribution:天气预报']);

    // Ordinary talk must not be blocked: no numbers, no attributed sources.
    assert.deepEqual(kinds('今天有点冷，你多穿点'), []);
    assert.deepEqual(kinds('我在想明天要不要出门走走'), []);
    assert.deepEqual(kinds('收到：你好'), []);

    // A tool result makes the very same sentence legitimate — same rule as inside `respond()`.
    assert.equal(engine.screenUnbackedFacts('明天 19 到 25 度', 'xixi_get_weather').ok, true);
    assert.equal(engine.screenUnbackedFacts('明天 19 到 25 度', null).ok, false);
    assert.equal(engine.screenUnbackedFacts('明天 19 到 25 度', null).text, REPAIR);
  } finally {
    s.close();
  }
});

test('ordinary talk is not blocked — the class promise the review asked for (t117 / F1)', () => {
  const s = store();
  try {
    const engine = engineFor(scriptedAdapter([], {}), s);
    const kinds = (text: string): string[] => engine.screenUnbackedFacts(text, null).claims.map((claim) => `${claim.kind}:${claim.match}`);

    // The five sentences from the review's §3 table that used to be replaced wholesale. Four are
    // bare-source talk (no source word that is *speaking*), one is a temperature the user gave.
    assert.deepEqual(kinds('今天有点冷，多穿点。'), []);
    assert.deepEqual(kinds('朋友说今天有点冷'), []);
    assert.deepEqual(kinds('医生说多喝水对身体好，你也多喝点。'), []);
    assert.deepEqual(kinds('今天新闻挺热闹的，说小区门口要办集市。'), []);
    assert.deepEqual(kinds('朋友说要来吃饭，我先把菜洗上。'), []);
    assert.deepEqual(kinds('专家都觉得这样安排挺好。'), []);
    // …the 5th («你把烤箱预热到 180 度») is *deliberately still a temperature claim* (F2): the
    // number is checkable, so it is flagged — but with the **complete** match, not a suffix:
    assert.deepEqual(kinds('你把烤箱预热到 180 度，我这边切菜。'), ['temperature:180 度']);
    assert.deepEqual(kinds('水开了是 100 度，小心别烫着。'), ['temperature:100 度']);

    // And the class promise stated as behaviour: a homey sentence never becomes the repair line.
    for (const sentence of ['朋友说今天有点冷', '医生说多喝水对身体好', '专家都觉得这样安排挺好']) {
      assert.equal(engine.screenUnbackedFacts(sentence, null).ok, true, `${sentence} must pass through`);
      assert.equal(engine.screenUnbackedFacts(sentence, null).text, sentence);
    }
  } finally {
    s.close();
  }
});

test('a fabricated number never reaches the audio, the log or the caller', async () => {
  const s = store();
  try {
    const session = s.createSession();
    const engine = engineFor(scriptedAdapter([{ type: 'text', text: FABRICATED }], {}), s);
    const spoken: string[] = [];
    const notices: { code: string; detail: string }[] = [];
    const turn = await engine.respond(
      { sessionId: session.sessionId, text: '明天天气怎么样', addressed: true },
      { onTextChunk: (text) => void spoken.push(text), onNotice: (notice) => void notices.push(notice) },
    );

    assert.equal(turn.action, 'SPEAK');
    assert.equal(turn.text, REPAIR, 'the turn reports the repaired line, not the fabrication');
    assert.equal(spoken.join('').includes('19'), false, 'the number must never be streamed to TTS');
    assert.equal(spoken.join(''), REPAIR);
    assert.equal(turn.segments.some((segment) => segment.includes('19')), false, 'segments carry no numbers either');
    assert.deepEqual(notices, [{ code: 'UNBACKED_FACT_CLAIM', detail: '未调用工具却给出可核查事实：19 到 25 度' }]);

    // The conversation log is the durable record: it must hold the repaired line, not the claim.
    const turns = s.recentTurns(session.sessionId, 10);
    const assistant = turns.filter((entry) => entry.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0]?.text, REPAIR);
    assert.equal(assistant[0]?.toolName, null);
  } finally {
    s.close();
  }
});

test('a tool that really ran makes the very same sentence legitimate', async () => {
  const s = store();
  try {
    const session = s.createSession();
    const engine = engineFor(
      scriptedAdapter([{ type: 'tool', name: 'xixi_get_weather' }, { type: 'text', text: TOOL_BACKED }], {
        toolName: 'xixi_get_weather',
      }),
      s,
    );
    const spoken: string[] = [];
    const notices: unknown[] = [];
    const turn = await engine.respond(
      { sessionId: session.sessionId, text: '明天天气怎么样', addressed: true },
      { onTextChunk: (text) => void spoken.push(text), onNotice: (notice) => void notices.push(notice) },
    );

    assert.equal(turn.text, TOOL_BACKED, 'a backed claim is spoken as-is');
    assert.equal(spoken.join(''), TOOL_BACKED);
    assert.deepEqual(notices, [], 'no notice when the turn did look it up');
    const assistant = s.recentTurns(session.sessionId, 10).filter((entry) => entry.role === 'assistant');
    assert.equal(assistant[0]?.toolName, 'xixi_get_weather', 'the log keeps the tool that backed it');
  } finally {
    s.close();
  }
});

test('the segment path is repaired too (the console/CLI playback seam)', async () => {
  const s = store();
  try {
    const session = s.createSession();
    const engine = engineFor(scriptedAdapter([{ type: 'text', text: FABRICATED }], {}), s);
    const played: string[] = [];
    const turn = await engine.respond(
      { sessionId: session.sessionId, text: '明天天气怎么样', addressed: true },
      { onSegment: (segment) => void played.push(segment.text) },
    );

    assert.equal(turn.text, REPAIR);
    assert.deepEqual(played, [REPAIR], 'exactly one segment, and it is the repair line');
    assert.equal(played.join('').includes('度'), false);
  } finally {
    s.close();
  }
});

test('a second fabricated claim shape (forecast metric) is repaired the same way', async () => {
  const s = store();
  try {
    const session = s.createSession();
    const engine = engineFor(scriptedAdapter([{ type: 'text', text: '明天多云，降水概率 60%。' }], {}), s);
    const notices: { code: string; detail: string }[] = [];
    const turn = await engine.respond(
      { sessionId: session.sessionId, text: '明天要带伞吗', addressed: true },
      { onNotice: (notice) => void notices.push(notice) },
    );
    assert.equal(turn.text, REPAIR);
    assert.match(notices[0]?.detail ?? '', /降水概率 60%/);
    assert.equal(s.recentTurns(session.sessionId, 10).some((entry) => (entry.text ?? '').includes('60%')), false);
  } finally {
    s.close();
  }
});
