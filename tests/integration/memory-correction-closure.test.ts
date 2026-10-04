/**
 * 记忆纠正闭环的**端到端**证据（V0.3 P1-b / pack `docs/02_MEMORY_CONTEXT.md` §5）。
 *
 * 这一条打的正是审计 §3.2 抱怨的那个场景：西西先记下「他喜欢喝茉莉花茶」，
 * 后来他说「我什么时候喜欢喝茉莉花茶了，我不喝那个」—— 闭环必须让**旧的说法不再算数**，
 * 而且这件事要能从他真的走过的路上复现（真 `ConversationEngine.respond` 落库 + 真
 * `TurnMemoryExtractor` 提取，不是直接调 resolver）。
 *
 * 四个断言各钉一段：
 *   1. 旧行 `superseded`、新行 `active`，两条都在（pack：不许并存而**不带状态**）；
 *   2. **提示词里不再有旧事实**（这是「不再算数」对模型可见的那一面）；
 *   3. 记忆里留下一条 `correction`（发生过的事），下一轮还能被召回；
 *   4. 事件日志里有一条 `system.health`（状态变化也是事实）。
 *
 * Run: `npm test`（integration 也在默认门禁里）。
 *
 * **库是文件库、不是 `:memory:`**（t16 收口时改）：Phase 1 的验收里有一条是「**进程重启后记忆仍在**」，
 * 而 `:memory:` 一关就没，那条验收在默认门禁里当时没有任何守护（t21 复审记的 low，只由跨进程探针覆盖）。
 * 现在每条用例都在系统临时目录里建一个真文件库，文件末尾那条用例还会**关库再开**，把「重启后仍在」钉进默认门禁。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { ConversationEngine, TurnMemoryExtractor } from '@xixi/conversation';
import { fixedClock, MemoryStore, openXixiStore, SelfModel, type XixiConfig, type XixiStore } from '@xixi/domain';

const T0 = new Date('2026-10-01T20:00:00+08:00');
const T1 = new Date('2026-10-01T20:01:00+08:00');
const T2 = new Date('2026-10-01T20:05:00+08:00');

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: { llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false }, asr: {} as never, tts: {} as never },
  personality: { base: {} },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

interface Harness {
  readonly dir: string;
  readonly dbPath: string;
  readonly store: XixiStore;
  readonly memory: MemoryStore;
  readonly engine: ConversationEngine;
  readonly extractor: TurnMemoryExtractor;
  readonly sessionId: string;
  readonly say: (text: string, at: Date) => Promise<void>;
  /** 关库并删掉临时目录（每条用例都调它，别把库留在系统临时目录里）。 */
  readonly close: () => void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-closure-'));
  const dbPath = join(dir, 'xixi.sqlite');
  const store = openXixiStore({ dbPath, clock: fixedClock(T0, 60_000) });
  store.seedSelfProfile({ talkativeness: 0.75, verbosity: 0.7 });
  const session = store.createSession();
  const memory = new MemoryStore(store);
  const extractor = new TurnMemoryExtractor({
    store,
    selfModel: new SelfModel(store),
    memory,
    // 手动调度：这一层要断言「提取之后」的状态，所以不让它自己跑（与 memory-feedback 同款）。
    scheduler: () => {},
  });
  const engine = new ConversationEngine({
    adapter: new FakeBrainAdapter(),
    store,
    config: CONFIG,
    clock: fixedClock(T1, 60_000),
    offsetMinutes: 480,
    afterTurn: (job) => extractor.enqueue(job),
  });
  return {
    dir,
    dbPath,
    store,
    memory,
    engine,
    extractor,
    sessionId: session.sessionId,
    say: async (text, at) => {
      const turn = await engine.respond({ sessionId: session.sessionId, text, at });
      assert.equal(turn.accepted, true, `这一轮要被接受：${JSON.stringify(turn.reason)}`);
      await extractor.flush();
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('端到端：先记下、再被纠正，旧事实不再算数（prompt 里也没有它了）', async () => {
  const h = harness();
  try {
    // 第一轮：他说了自己的偏好 → Tier 1 规则记下一条语义记忆。
    await h.say('我很喜欢喝茉莉花茶。', T0);
    const remembered = h.memory.semantic({ property: 'preference', limit: 10 });
    assert.equal(remembered.length, 1, `Tier 1 应该记下这一条：${JSON.stringify(remembered.map((entry) => entry.statement))}`);
    const oldId = remembered[0]?.memoryId ?? '';
    assert.equal(remembered[0]?.status, 'active');

    // 第二轮：他否认了这件事并给出反命题。
    await h.say('我什么时候喜欢喝茉莉花茶了，我不喝那个。', T1);

    const old = h.memory.semanticMemory(oldId);
    const all = h.memory.semantic({ property: 'preference', limit: 10 });
    assert.equal(old.status, 'superseded', `旧事实必须被标掉：${JSON.stringify(all.map((entry) => [entry.statement, entry.status]))}`);
    assert.equal(old.statement, '我很喜欢喝茉莉花茶', '旧说法一字不改（历史不许被改写）');
    assert.notEqual(old.supersededBy, null, '要知道「被哪一条取代」');

    const active = h.memory.activeSemantic({ property: 'preference', limit: 10 });
    assert.equal(active.length, 1, '只剩一条算数');
    assert.equal(active[0]?.statement, '我不喝茉莉花茶', `程序拼出来的反命题：${active[0]?.statement}`);
    assert.equal(active[0]?.sourceType, 'explicit_correction');
    assert.equal(all.length, 2, '两条都在：pack 要求的是「不许并存而不带状态」，不是「不许并存」');

    // 对模型可见的那一面：问的还是同一件事（茉莉花茶），提示词里却只剩新的说法。
    const prompt = h.engine.buildPrompt({ sessionId: h.sessionId, text: '那茉莉花茶呢', at: T2 });
    assert.ok(!prompt.user.includes('我很喜欢喝茉莉花茶'), `旧事实不该再进提示词：\n${prompt.user}`);
    assert.ok(prompt.user.includes('我不喝茉莉花茶'), `新事实应该进提示词：\n${prompt.user}`);

    // 记忆里的历史：一条 correction（发生过的事）。
    const corrections = h.memory.episodic({ kind: 'correction', limit: 10 });
    assert.equal(corrections.length, 1, `纠正本身也要留一条记忆：${JSON.stringify(corrections.map((entry) => entry.summary))}`);
    assert.match(corrections[0]?.summary ?? '', /更正了一条以前记下的事/);
    assert.match(corrections[0]?.summary ?? '', /我不喝茉莉花茶/, '留下的是**新的**说法');
    assert.doesNotMatch(
      corrections[0]?.summary ?? '',
      /我很喜欢喝茉莉花茶/,
      '这条记忆会被召回、会进提示词：它不许复述已经不信的那句（否则绕开状态机把它送回模型面前）',
    );
    assert.notEqual(corrections[0]?.sourceEventId, null, '它指回那条用户轮次（铁律 4）');

    // 状态变化也是事实：日志里有一条 system.health。
    const audit = h.store
      .readEvents({ type: 'system.health', limit: 50 })
      .filter((event) => (event.payload as { service?: string }).service === 'memory.status');
    assert.equal(audit.length, 1);
    assert.match(String((audit[0]?.payload as { detail?: string }).detail ?? ''), /superseded/);
  } finally {
    h.close();
  }
});

test('普通聊天不会误触发纠正：没有纠正规则命中时一条记忆都不动', async () => {
  const h = harness();
  try {
    await h.say('我很喜欢喝茉莉花茶。', T0);
    const before = h.memory.semantic({ property: 'preference', limit: 10 });
    await h.say('今天天气不错，你昨天说的那个新闻我也看到了。', T1);
    const after = h.memory.semantic({ property: 'preference', limit: 10 });
    assert.deepEqual(
      after.map((entry) => [entry.statement, entry.status]),
      before.map((entry) => [entry.statement, entry.status]),
      '普通聊天不许改任何记忆的状态',
    );
    assert.equal(h.memory.episodic({ kind: 'correction', limit: 10 }).length, 0);
  } finally {
    h.close();
  }
});

/**
 * Phase 1 验收里的**「进程重启后记忆仍在」**（t16 收口补的默认门禁守护）。
 *
 * 这条用例刻意不碰 `:memory:`：它写完之后**关库**，再从同一个文件路径**重新打开**，
 * 用一个全新的 `MemoryStore` / `ContextBuilder` / `ConversationEngine` 读——这正是「重启」在
 * 单进程里能做到的最接近的形态（跨真进程由 `docs/verification/` 的复验探针覆盖，两者互为补充）。
 *
 * 三个断言各钉一段：
 *   1. 库文件真的落在磁盘上（`existsSync`，`:memory:` 的写法在这里会直接失败）；
 *   2. 关库再开之后，那条偏好**仍是 active**，且 `statement` 与 `sourceEventId` 一字不改；
 *   3. 重启之后它**仍然能被召回**——新引擎装配出的提示词里出现这句（光「库里还在」不够，
 *      链路必须是通的：检索 → 渲染 → `prompt.user`）。
 */
test('进程重启后记忆仍在：关库、重开同一个文件库、新引擎照样召回它', async () => {
  const h = harness();
  // 这两样要在「关库」之前取出来，重启之后才有的比。
  let statement = '';
  let sourceEventId: string | null = null;
  try {
    await h.say('我很喜欢喝茉莉花茶。', T0);
    const before = h.memory.activeSemantic({ property: 'preference', limit: 10 });
    assert.equal(before.length, 1, '先确认这一轮真的写进去了');
    statement = before[0]?.statement ?? '';
    sourceEventId = before[0]?.sourceEventId ?? null;
    assert.ok(existsSync(h.dbPath), '这是文件库：库文件必须真的在磁盘上（:memory: 在这里就红了）');
  } finally {
    h.store.close();
  }

  // ↓ 下面是「重启」：同一个路径、全新的进程内对象。
  const reopened = openXixiStore({ dbPath: h.dbPath, clock: fixedClock(T2, 60_000) });
  try {
    const memory = new MemoryStore(reopened);
    const session = reopened.latestSession();
    assert.notEqual(session, null, '会话也是持久的，重启后取得到');
    const after = memory.activeSemantic({ property: 'preference', limit: 10 });
    assert.equal(after.length, 1, '重启后那条偏好还在，而且仍算数（active）');
    assert.equal(after[0]?.statement, '我很喜欢喝茉莉花茶');
    assert.equal(after[0]?.sourceEventId, sourceEventId, '来源事件 id 不许在重启后变化');

    // 链路也要是通的：新引擎装配提示词时它还能进 `prompt.user`。
    const engine = new ConversationEngine({
      adapter: new FakeBrainAdapter(),
      store: reopened,
      config: CONFIG,
      clock: fixedClock(T2, 60_000),
      offsetMinutes: 480,
    });
    const prompt = engine.buildPrompt({ sessionId: session?.sessionId ?? '', text: '茉莉花茶还有吗？', at: T2 });
    assert.ok(prompt.user.includes(statement), `重启后仍应被召回：\n${prompt.user}`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/i.test(prompt.user), '召回进提示词的不许是内部 id');
  } finally {
    reopened.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});
