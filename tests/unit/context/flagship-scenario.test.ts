/**
 * V0.3 t22 验收①：pack Phase 1 的**旗舰场景**，用**文件库**跑（不是 `:memory:`），
 * 而且「重启」是真的关库再开库（t21 记的 low：交付用例一直是内存库，跨重启只由复验探针覆盖）。
 *
 * 场景（pack 原话，一个字不改）：
 *   1. 他说「我不喝绿茶，平时喜欢茉莉花茶。」
 *   2. 重启
 *   3. 他问「给我推荐个茶。」→ **她那句话的上下文里必须真的有那条偏好**
 *
 * 修复前实测（t15 独立复验，同一份代码路径）：① 一句自然话一条记忆都没写；
 * ② `injected=0`、`memories` 段整段不存在、`prompt.user` 里没有茉莉花茶。
 *
 * Run: `npm test`（tests/unit 在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { ConversationEngine, TurnMemoryExtractor } from '@xixi/conversation';
import { fixedClock, MemoryStore, openXixiStore, SelfModel, type XixiConfig, type XixiStore } from '@xixi/domain';

const DAY1 = new Date('2026-10-06T20:00:00+08:00');
const DAY2 = new Date('2026-10-07T20:00:00+08:00');

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: { llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false }, asr: {} as never, tts: {} as never },
  personality: { base: {} },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

interface Process {
  readonly store: XixiStore;
  readonly memory: MemoryStore;
  readonly engine: ConversationEngine;
  readonly extractor: TurnMemoryExtractor;
  readonly sessionId: string;
}

/** 一个「进程」：自己的 store / engine / extractor（同一个文件库可以开多次）。 */
function startProcess(dbPath: string, at: Date): Process {
  const store = openXixiStore({ dbPath, clock: fixedClock(at, 60_000) });
  store.seedSelfProfile({ proactivity: 0.85, talkativeness: 0.75, verbosity: 0.7, silence_tolerance: 0.7 });
  const memory = new MemoryStore(store);
  const extractor = new TurnMemoryExtractor({ store, selfModel: new SelfModel(store), memory, scheduler: () => {} });
  const session = store.latestSession() ?? store.createSession();
  const engine = new ConversationEngine({
    adapter: new FakeBrainAdapter({ reply: () => ({ action: 'SPEAK', text: '（离线替身回复）' }) }),
    store,
    config: CONFIG,
    clock: fixedClock(at, 60_000),
    offsetMinutes: 480,
    afterTurn: (job) => extractor.enqueue(job),
  });
  return { store, memory, engine, extractor, sessionId: session.sessionId };
}

test('旗舰场景（文件库 + 关库重开）：先写偏好，重启之后「给我推荐个茶。」的提示词里有它', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-flagship-'));
  const dbPath = join(dir, 'xixi.sqlite');

  // ---------------------------------------------------------------- 第一天：说出偏好
  const first = startProcess(dbPath, DAY1);
  try {
    const turn = await first.engine.respond({ sessionId: first.sessionId, text: '我不喝绿茶，平时喜欢茉莉花茶。', at: DAY1 });
    assert.equal(turn.accepted, true);
    await first.extractor.flush();
    assert.deepEqual(
      first.memory.activeSemantic().map((row) => row.statement),
      ['我平时喜欢茉莉花茶'],
      '一句自然话必须真的写出记忆（修复前这里是空的）',
    );
  } finally {
    first.store.close();
  }

  // ---------------------------------------------------------------- 第二天：**新进程**读同一个库
  const second = startProcess(dbPath, DAY2);
  try {
    assert.deepEqual(
      second.memory.activeSemantic().map((row) => row.statement),
      ['我平时喜欢茉莉花茶'],
      '重启之后记忆还在（文件库的跨进程语义与 pack 的验收一致）',
    );

    const prompt = second.engine.buildPrompt({ sessionId: second.sessionId, text: '给我推荐个茶。', at: DAY2 });
    const memoriesSection = prompt.sections.find((section) => section.name === 'memories');
    assert.ok(memoriesSection !== undefined, `memories 段必须存在（修复前这一轮 injected=0、整段不存在）：\n${prompt.user}`);
    assert.match(memoriesSection.debug ?? '', /injected=1/u, `检索层要真的选中它：${memoriesSection.debug}`);
    assert.match(memoriesSection.debug ?? '', /dropped_at_render=0/u, '渲染层不该丢掉它');
    assert.ok(prompt.user.includes('我平时喜欢茉莉花茶'), `prompt.user 里必须出现这条偏好：\n${prompt.user}`);

    // 提示词审计（与 t15 探针同一批判据）：模型看到的这一段里没有程序内部的东西。
    const whole = `${prompt.system}\n${prompt.user}`;
    assert.doesNotMatch(whole, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu, '不许出现 UUID');
    assert.doesNotMatch(whole, /\b(?:sem|mem|evt|thread|sess|corr)_[0-9a-z]/iu, '不许出现内部 id');
    assert.doesNotMatch(whole, /\d{8,}/u, '不许出现长数字');
    assert.doesNotMatch(whole, /injected=|dropped_at_render=/u, '调试字段只进 sections，不进模型看到的那一份');

    // ---------------------------------------------------------------- 疑问句：不许写成偏好事实
    const question = await second.engine.respond({ sessionId: second.sessionId, text: '你还记得我喜欢喝什么茶吗？', at: DAY2 });
    assert.equal(question.accepted, true);
    await second.extractor.flush();
    assert.deepEqual(
      second.memory.activeSemantic().map((row) => row.statement),
      ['我平时喜欢茉莉花茶'],
      '问句不许被写成新的偏好事实（修复前会多出「我喜欢喝什么茶吗」）',
    );
    assert.equal(
      second.memory.semantic().some((row) => row.statement.includes('什么茶')),
      false,
      `库里不许有任何「…什么茶…」的事实：${JSON.stringify(second.memory.semantic().map((row) => row.statement))}`,
    );
  } finally {
    second.store.close();
  }
});
