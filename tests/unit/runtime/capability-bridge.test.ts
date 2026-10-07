/**
 * V0.3 P2.5-C — the plugin capability bridge (`packages/runtime/src/capability-bridge.ts`).
 *
 * P2 shipped `topic_source` and nothing read it: `CapabilityRegistry.values<T>('topic_source')` had
 * zero callers in the whole repository, so `xixi.news` could register `news.topics`, report
 * `capabilities: [tool, topic_source]` in `--print-wiring`, and still never reach the proactive path
 * (`ADR-0019`: 「主动路径不走工具，它走 `topic_source`」). This file is the offline gate for the bridge
 * that closes that gap, and it asserts the boundaries rather than the happy path:
 *
 *   1. what a registry holds becomes a **normalised** candidate — one line, bounded length, provenance
 *      (`pluginId` / capability name) and 来源分 attached;
 *   2. only `topic_source` is read: `context_provider`, `sensor_source` and `action` stay unconsumed
 *      (`context_provider` has to reach a prompt through the context assembly + render gate, never from
 *      here);
 *   3. the candidate joins the **existing** candidate list — 判定归属不变（一条自己过了线的提案仍然被
 *      硬底线拦下），且它只能**追加**、不能把内置来源挤出这一次考虑；
 *   4. a plugin that throws, lies or is deactivated cannot stop the loop, and one topic is never spoken
 *      twice;
 *   5. 一句话都没说时提醒不会被提前标成已送达 —— that invariant belongs to the reminder wiring (T8), but
 *      this task shares the acceptance item and the loop code it rests on, so it is pinned here too.
 *
 * Offline and free: no key, no network, no model. The loop runs with `compose` absent (the 离线兜底
 * path), and the only adapter in the file is `FakeBrainAdapter`.
 *
 * 口径（AGENTS §9.24）：这里证明的是**桥成立、形状可用、以及入口该写的那一行真的能跑**，不是「活的西西
 * 已经在用新闻话题」—— 入口里那一行 `readPluginTopics` 在 `scripts/` 下（本任务 inScope 之外）。包入口
 * `index.ts` 上的再导出同样不在 inScope，所以桥按源码路径引入（仓库里有同样的先例：
 * `tests/unit/core/topic-engine.test.ts`）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeBrainAdapter, ToolPermission } from '@xixi/brain-adapter';
import { parseProactiveSettings, proactiveThreshold, scoreProactiveCandidate, type ProactiveDecider, type ProactiveSettings } from '@xixi/conversation';
import { openXixiStore, parseXixiConfig, type XixiConfig, type XixiStore } from '@xixi/domain';
import { CapabilityRegistry, type InlinePlugin, type TopicSource } from '@xixi/plugins';
import {
  CONVERSATION_SCOPE,
  DurableReminderSink,
  ProactiveLoop,
  ReminderScheduler,
  buildProactiveCandidates,
  createResidentRuntime,
  type ReminderCandidateInput,
  type XixiResidentRuntime,
} from '@xixi/runtime';

import {
  PLUGIN_TOPIC_INTENT,
  PLUGIN_TOPIC_MAX_CHARS,
  PLUGIN_TOPIC_MISSING_REASON,
  createPluginCapabilityBridge,
  pluginTopicComponents,
  type PluginTopicReader,
} from '../../../packages/runtime/src/capability-bridge.ts';

/** 15:00 local: no clock hook is inside its 30-minute window, so 「到点」 is not a candidate either. */
const T0 = new Date('2026-10-05T15:00:00+08:00');
const SHANGHAI = 'Asia/Shanghai';

const BASE_YAML = `
xixi:
  identity:
    name: 西西
    language: zh-CN
    timezone: ${SHANGHAI}
    place: 成都
  models:
    llm: { provider: fake, model: fake-1, thinking_realtime: false }
    asr: { provider: fake, model: fake-asr }
    tts: { provider: fake, model: fake-tts }
  personality:
    base: {}
  proactive: {}
  memory: {}
  privacy: {}
  features: {}
`;

function config(): XixiConfig {
  return parseXixiConfig(BASE_YAML, 'test-inline.yaml');
}

/** Every floor open, no quiet window: the only thing that decides is what the candidate brings. */
const OPEN_SETTINGS: ProactiveSettings = parseProactiveSettings({
  enabled: true,
  base_cooldown_min: 0,
  max_per_6h: 10,
  max_per_day: 10,
  quiet_hours: { start: '00:00', end: '00:00' },
});

/** The same settings with the safety floor down for the whole day. */
const QUIET_ALL_DAY: ProactiveSettings = parseProactiveSettings({
  enabled: true,
  base_cooldown_min: 0,
  max_per_6h: 10,
  max_per_day: 10,
  quiet_hours: { start: '00:00', end: '23:59' },
});

/** A throwaway store, for the cases that need the loop but not the resident runtime. */
function tempStore(prefix: string): { readonly root: string; readonly store: XixiStore } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const store = openXixiStore({ dbPath: join(root, 'xixi.sqlite'), clock: () => T0 });
  const options = config();
  store.seedSelfProfile(options.personality.base);
  return { root, store };
}

function dropStore(rig: { readonly root: string; readonly store: XixiStore }): void {
  rig.store.close();
  rmSync(rig.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

interface TopicRig {
  readonly root: string;
  readonly store: XixiStore;
  readonly runtime: XixiResidentRuntime;
  readonly logs: string[];
}

/** A live resident runtime whose only plugin registers the given `topic_source`s. */
function residentRig(sources: readonly TopicSource[], pluginId = 'xixi.demo'): TopicRig {
  const root = mkdtempSync(join(tmpdir(), 'xixi-capability-bridge-'));
  const store = openXixiStore({ dbPath: join(root, 'xixi.sqlite'), clock: () => T0 });
  const options = config();
  store.seedSelfProfile(options.personality.base);
  const logs: string[] = [];
  const plugin: InlinePlugin = {
    manifest: {
      schemaVersion: 1,
      id: pluginId,
      name: pluginId,
      version: '0.1.0',
      permissions: ['topic.read'],
      capabilities: ['topic_source'],
    },
    module: { activate: () => ({ topicSources: sources }) },
  };
  const runtime = createResidentRuntime({
    config: options,
    store,
    now: () => T0,
    inline: [plugin],
    conversation: { clock: () => T0, turnTimeoutMs: 5_000 },
    log: (line) => logs.push(line),
    model: ({ toolChain }) => new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE, timezone: SHANGHAI }),
  });
  return { root, store, runtime, logs };
}

async function dispose(rig: TopicRig): Promise<void> {
  await rig.runtime.stop();
  dropStore(rig);
}

/** A capability registry with `topic_source` registrations, through the real manifest/permission path. */
function registryWith(entries: readonly { readonly pluginId: string; readonly source: TopicSource }[]): CapabilityRegistry {
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  for (const entry of entries) {
    capabilities.registerContribution(entry.pluginId, ['topic_source'], new Set(['topic.read']), {
      topicSources: [entry.source],
    });
  }
  return capabilities;
}

/**
 * A loop over a throwaway store where every reader is the test's, and — with 「刚刚说过话」 plus
 * `random: 1` — the only thing that can speak is what the test feeds in.
 */
function makeLoop(options: {
  readonly store: XixiStore;
  readonly sessionId: string | null;
  readonly settings?: ProactiveSettings;
  readonly readPluginTopics?: PluginTopicReader | undefined;
  readonly readDueReminders?: (() => readonly ReminderCandidateInput[]) | undefined;
  readonly onReminderDelivered?: ((reminderId: string, at: Date) => void) | undefined;
  readonly decide?: ProactiveDecider | undefined;
  readonly present?: boolean | null;
  readonly logs?: string[];
}): ProactiveLoop {
  return new ProactiveLoop({
    store: options.store,
    readSettings: () => options.settings ?? OPEN_SETTINGS,
    readState: () => 'IDLE',
    readProactivity: () => 0.85,
    readPresence: async () =>
      options.present === undefined || options.present === null
        ? null
        : { present: options.present, updatedAt: new Date(T0.getTime() - 5_000).toISOString(), ttlSeconds: 60, source: 'test' },
    // Zero minutes of silence → 沉默跟进 is not a candidate; `random: 1` → 随机闲聊 is not either.
    readLastUserTurnAt: () => T0,
    readRecentUserTopics: () => [],
    readSessionId: () => options.sessionId,
    readDueReminders: options.readDueReminders,
    onReminderDelivered: options.onReminderDelivered,
    readPluginTopics: options.readPluginTopics,
    decide: options.decide,
    random: () => 1,
    now: () => T0,
    log: (line) => options.logs?.push(line),
  });
}

// --------------------------------------------------------------------------- the bridge itself

test('插件的 topic_source 变成候选：一行、带上限、带来源分与出处', async () => {
  const long = '今天'.repeat(100);
  const source: TopicSource = {
    name: 'demo.topics',
    propose: () => [
      { topic: '  新出的\n 那款电饭煲  在打折  ', reason: '打折', score: 0.72, source: 'demo-feed' },
      { topic: long, reason: '', score: 3.5 },
      { topic: '   ', reason: '没有正文', score: 0.9 },
    ],
  };
  const bridge = createPluginCapabilityBridge({
    capabilities: registryWith([{ pluginId: 'xixi.demo', source }]),
    timezone: SHANGHAI,
  });

  const proposal = await bridge.topics.propose({ now: T0 });

  assert.equal(proposal.candidates.length, 2, '空话题丢掉，其余两条留下');
  const [first, second] = proposal.candidates;
  assert.ok(first !== undefined && second !== undefined);

  // ① 单行化：换行与多余空白被压平（一段「多行文档」不能冒充对话记录）。
  assert.equal(first.topic, '新出的 那款电饭煲 在打折');
  assert.equal(first.reason, '打折');
  assert.equal(first.score, 0.72);
  assert.equal(first.source, 'demo-feed', '插件自己给的来源优先');
  assert.equal(first.capability, 'demo.topics', '注册表里的能力名');
  assert.equal(first.pluginId, 'xixi.demo', '谁注册的');
  assert.equal(first.line, '有个话题想跟你聊：新出的 那款电饭煲 在打折');
  assert.match(first.fact, /xixi\.demo 的 demo\.topics/);
  assert.match(first.fact, /来源分 0\.72/);
  assert.match(first.fact, /打折/);
  assert.equal(first.components['topic_quality'], 0.72);

  // ② 边界：超长截断到事件模式的上限、越界分数夹进 [0,1]、没给理由就不编一个、来源缺省用能力名。
  assert.equal(second.topic.length, PLUGIN_TOPIC_MAX_CHARS);
  assert.equal(second.score, 1);
  assert.equal(second.reason, PLUGIN_TOPIC_MISSING_REASON);
  assert.equal(second.source, 'demo.topics');

  // ③ 逐来源的探针把「提案了几条、收了几条、丢了几条」留在台面上 —— 「在册却从不说话」不能是静默的。
  assert.deepEqual(proposal.probes, [
    {
      capability: 'demo.topics',
      pluginId: 'xixi.demo',
      proposed: 3,
      accepted: 2,
      droppedEmpty: 1,
      capped: 0,
      truncated: 1,
      error: null,
    },
  ]);
});

test('一次提案的条数有上限：插件不能靠多提几条把这一 tick 灌满（多出来的记在 capped 里）', async () => {
  const bridge = createPluginCapabilityBridge({
    capabilities: registryWith([
      {
        pluginId: 'xixi.demo',
        source: {
          name: 'demo.topics',
          propose: () => [1, 2, 3, 4, 5].map((index) => ({ topic: `第 ${index} 条`, reason: '灌水', score: 0.9 })),
        },
      },
    ]),
    timezone: SHANGHAI,
    limit: 2,
  });

  const proposal = await bridge.topics.propose({ now: T0 });

  assert.deepEqual(
    proposal.candidates.map((candidate) => candidate.topic),
    ['第 1 条', '第 2 条'],
  );
  assert.deepEqual(proposal.probes[0], {
    capability: 'demo.topics',
    pluginId: 'xixi.demo',
    proposed: 5,
    accepted: 2,
    droppedEmpty: 0,
    capped: 3,
    truncated: 0,
    error: null,
  });
});

test('只读 topic_source：context_provider / sensor_source / action 一律不进候选', async () => {
  const capabilities = new CapabilityRegistry({ permission: new ToolPermission() });
  capabilities.registerContribution(
    'xixi.demo',
    ['topic_source', 'context_provider', 'sensor_source', 'action'],
    new Set(['topic.read', 'context.read', 'sensor.events', 'notify']),
    {
      topicSources: [{ name: 'demo.topics', propose: () => [{ topic: '小区门口的银杏黄了', reason: 'demo', score: 0.82 }] }],
      contextProviders: [{ name: 'demo.context', provide: () => [{ text: 'SECRET_PROVIDER_LINE' }] }],
      sensorSources: [{ name: 'demo.sensors', onEvent: () => undefined }],
      actions: [{ name: 'demo.action', perform: () => ({ ok: true }) }],
    },
  );
  const bridge = createPluginCapabilityBridge({ capabilities, timezone: SHANGHAI });

  // 注册表里确实四样都在，否则这条用例什么都没证明。
  assert.deepEqual(
    capabilities.list().map((entry) => `${entry.kind}:${entry.name}`),
    ['action:demo.action', 'context_provider:demo.context', 'sensor_source:demo.sensors', 'topic_source:demo.topics'],
  );

  assert.deepEqual(bridge.topics.sources(), [{ capability: 'demo.topics', pluginId: 'xixi.demo' }]);
  const proposal = await bridge.topics.propose({ now: T0 });
  assert.equal(proposal.candidates.length, 1);
  assert.equal(proposal.probes.length, 1, '只有 topic_source 被问了');
  const rendered = JSON.stringify(proposal);
  for (const foreign of ['SECRET_PROVIDER_LINE', 'demo.context', 'demo.sensors', 'demo.action']) {
    assert.equal(rendered.includes(foreign), false, `${foreign} 不该出现在桥的输出里`);
  }
});

test('一条话题源抛错或撒谎：这一轮跳过它、其它来源照常，错误留在探针里而不是被吞掉', async () => {
  const logs: string[] = [];
  const broken: TopicSource = {
    name: 'demo.broken',
    propose: () => {
      throw new Error('来源挂了');
    },
  };
  const lying: TopicSource = {
    name: 'demo.lying',
    // 返回一个不是数组的东西：一个会撒谎的插件也不能把循环搞崩。
    propose: () => undefined as never,
  };
  const good: TopicSource = { name: 'demo.good', propose: () => [{ topic: '还能说话的这条', reason: 'ok', score: 0.8 }] };
  const bridge = createPluginCapabilityBridge({
    capabilities: registryWith([
      { pluginId: 'xixi.a', source: broken },
      { pluginId: 'xixi.b', source: lying },
      { pluginId: 'xixi.c', source: good },
    ]),
    timezone: SHANGHAI,
    log: (line) => logs.push(line),
  });

  const proposal = await bridge.topics.propose({ now: T0 });

  assert.deepEqual(
    proposal.candidates.map((candidate) => candidate.topic),
    ['还能说话的这条'],
  );
  assert.equal(proposal.probes[0]?.error, '来源挂了');
  assert.match(proposal.probes[1]?.error ?? '', /不是候选数组/);
  assert.equal(proposal.probes[2]?.error, null);
  assert.match(logs.join('\n'), /demo\.broken/);
  assert.match(logs.join('\n'), /来源挂了/);
});

test('注册表是现读的：插件停用（能力释放）之后它就不再提案，重挂之后又回来', async () => {
  const capabilities = registryWith([
    { pluginId: 'xixi.demo', source: { name: 'demo.topics', propose: () => [{ topic: '第一条', reason: 'demo', score: 0.6 }] } },
  ]);
  const bridge = createPluginCapabilityBridge({ capabilities, timezone: SHANGHAI });

  assert.equal((await bridge.topics.propose({ now: T0 })).candidates.length, 1);
  assert.equal(capabilities.release('xixi.demo', 'topic_source', 'demo.topics'), true, '停用路径释放能力');

  assert.deepEqual(bridge.topics.sources(), []);
  assert.deepEqual(await bridge.topics.propose({ now: T0 }), { candidates: [], probes: [] });

  // 重挂之后立刻可见：桥不缓存名单，所以没有第二份「哪些来源在册」可以漂移。
  capabilities.registerContribution('xixi.demo', ['topic_source'], new Set(['topic.read']), {
    topicSources: [{ name: 'demo.topics', propose: () => [{ topic: '第二条', reason: 'demo', score: 0.6 }] }],
  });
  assert.equal((await bridge.topics.propose({ now: T0 })).candidates[0]?.topic, '第二条');
});

test('来源分映射：能过线（不是结构性哑巴），但什么都不报的插件拿不到免费分', () => {
  const proactivity = 0.85;
  const bar = proactiveThreshold(proactivity);
  const best = scoreProactiveCandidate({ ...pluginTopicComponents(1), base_proactivity: proactivity });
  const silent = scoreProactiveCandidate({ ...pluginTopicComponents(0), base_proactivity: proactivity });
  const middling = scoreProactiveCandidate({ ...pluginTopicComponents(0.5), base_proactivity: proactivity });

  assert.ok(best >= bar, `来源分 1.0 必须能过线：${best} < ${bar}`);
  assert.ok(silent < bar, `来源分 0 不该过线：${silent} ≥ ${bar}`);
  assert.ok(middling >= bar, `中间档应当能过线（否则只有满分才说得上话）：${middling} < ${bar}`);
  // 三个「插件自己的判断」信号都被来源分夹住：插件说多少就是多少，不能凭空加。
  assert.deepEqual(pluginTopicComponents(2), { topic_quality: 1, personal_relevance: 1, freshness: 1, receptivity: 0.7, engagement: 0.6 });
  assert.deepEqual(pluginTopicComponents(Number.NaN), { topic_quality: 0, personal_relevance: 0, freshness: 0, receptivity: 0.7, engagement: 0.6 });
});

// --------------------------------------------------------------- the candidate in the proactive list

test('插件候选只能追加：内置来源的顺序与内容逐字不变，插件那条带着理由与来源分入列', async () => {
  const topic = '小区门口的银杏黄了';
  const bridge = createPluginCapabilityBridge({
    capabilities: registryWith([
      { pluginId: 'xixi.demo', source: { name: 'demo.topics', propose: () => [{ topic, reason: '树干上贴了告示', score: 0.82 }] } },
      { pluginId: 'xixi.demo2', source: { name: 'demo.other', propose: () => [{ topic: '洗衣机该清洗了', reason: '第二台机器', score: 0.5 }] } },
    ]),
    timezone: SHANGHAI,
  });
  const { candidates } = await bridge.topics.propose({ now: T0 });

  const base = {
    now: T0,
    presence: { present: true, updatedAt: new Date(T0.getTime() - 5_000).toISOString(), ttlSeconds: 60, source: 'test' },
    lastUserTurnAt: new Date(T0.getTime() - 20 * 60_000),
    inConversation: false,
    recentUserTopics: ['明天要去医院复查一下'],
    random: () => 0,
  };
  const before = buildProactiveCandidates({ ...base });
  const after = buildProactiveCandidates({ ...base, pluginTopics: candidates });

  assert.ok(before.length >= 3, `内置来源至少三条才谈得上「顺序不变」：${before.length}`);
  assert.deepEqual(after.slice(0, before.length), before, '内置来源逐字不变（含顺序）');
  assert.equal(after.length, before.length + candidates.length, '插件候选是追加的，没有顶掉任何一条');

  const plan = after.find((entry) => entry.candidate.topicRef === topic);
  assert.ok(plan !== undefined);
  assert.equal(after.indexOf(plan), before.length, '追加的第一条就是先注册的那个来源提案的那一条');
  assert.equal(plan.candidate.trigger, 'topic_pool');
  assert.equal(plan.candidate.intent, PLUGIN_TOPIC_INTENT);
  assert.equal(plan.candidate.components['topic_quality'], 0.82, '来源分原样进入社会预算');
  assert.match(plan.fact, /来源分 0\.82/);
  assert.match(plan.fact, /xixi\.demo 的 demo\.topics/);
  assert.equal(plan.line, `有个话题想跟你聊：${topic}`);
  assert.ok(plan.candidate.candidateId.startsWith('loop-topic_pool-plugin-demo.topics-'), plan.candidate.candidateId);

  // 同一个话题两次提案得到同一个 id（说过就不会再说），两个来源拿到的 id 互不相同。
  const again = buildProactiveCandidates({ ...base, pluginTopics: (await bridge.topics.propose({ now: T0 })).candidates });
  assert.equal(again.find((entry) => entry.candidate.topicRef === topic)?.candidate.candidateId, plan.candidate.candidateId);
  assert.notEqual(after.at(-1)?.candidate.candidateId, plan.candidate.candidateId);
});

// ---------------------------------------------------------------------------- the loop, end to end

test('真入口那一行接线跑通：装配点的桥 → 循环 → 插件那条话题真的被说出口（离线兜底路径）', async () => {
  const topic = '小区门口的银杏黄了';
  const rig = residentRig([{ name: 'demo.topics', propose: () => [{ topic, reason: '树干上贴了告示', score: 0.82 }] }]);
  try {
    await rig.runtime.start();
    const session = rig.store.createSession();
    const loop = makeLoop({
      store: rig.store,
      sessionId: session.sessionId,
      // 这一行就是入口该写的那一行（见 `ProactiveLoopOptions.readPluginTopics` 的注释）。
      readPluginTopics: async (now) => (await rig.runtime.capabilities.topics.propose({ now })).candidates,
    });

    const entry = await loop.tickOnce();

    assert.ok(entry !== null, '有候选就必须留下一条记录');
    assert.equal(entry.speak, true);
    assert.equal(entry.reasonCode, 'PASSED');
    assert.equal(entry.trigger, 'topic_pool');
    assert.equal(entry.initiativeKind, 'external_sharing', '分享外面的事，不是接自己的话');
    assert.equal(entry.text, `有个话题想跟你聊：${topic}`, '离线兜底说的是插件那条话题本身，不是话题池的固定短句');
    assert.equal(entry.contentSource, 'fixed');
    assert.match(entry.fact, /来源分 0\.82/);

    // 判定留在事件日志里（铁律 5）：reason_code + 分数 + 来源，一样不少。
    const decisions = rig.store.readEvents({ type: 'proactive.decision', limit: 10 });
    const said = decisions.filter((event) => (event.payload as Record<string, unknown>)['speak'] === true);
    assert.equal(said.length, 1);
    assert.equal((said[0]?.payload as Record<string, unknown>)['reason_code'], 'PASSED');
    assert.equal((said[0]?.payload as Record<string, unknown>)['candidate_id'], entry.candidateId);

    // 同一条外部话题不会说第二遍：候选 id 钉在话题上，第二次 tick 没有可说的。
    assert.equal(await loop.tickOnce(), null);
  } finally {
    await dispose(rig);
  }
});

test('判定归属不变：插件这条自己过了线，仍然被程序侧的硬底线拦下', async () => {
  const rig = residentRig([{ name: 'demo.topics', propose: () => [{ topic: '下午有雷阵雨', reason: '天气', score: 1 }] }]);
  try {
    await rig.runtime.start();
    const session = rig.store.createSession();
    const loop = makeLoop({
      store: rig.store,
      sessionId: session.sessionId,
      settings: QUIET_ALL_DAY,
      readPluginTopics: async (now) => (await rig.runtime.capabilities.topics.propose({ now })).candidates,
    });

    const entry = await loop.tickOnce();

    assert.ok(entry !== null);
    assert.equal(entry.speak, false);
    assert.equal(entry.reasonCode, 'QUIET_HOURS');
    assert.match(entry.fact, /demo\.topics/);
    assert.ok(
      entry.score >= entry.threshold,
      `这条提案自己过了线（${entry.score} ≥ ${entry.threshold}），却仍然被静默时段拦下 —— 判定不在插件手里`,
    );
    assert.equal(
      rig.store.readEvents({ type: 'proactive.decision', limit: 10 }).filter((event) => (event.payload as Record<string, unknown>)['speak'] === true).length,
      0,
    );
  } finally {
    await dispose(rig);
  }
});

test('坏掉的 reader 不会毁掉这一轮：记一行日志、跳过插件候选，其余来源照常说话', async () => {
  const rig = tempStore('xixi-capability-bridge-bad-reader-');
  try {
    const session = rig.store.createSession();
    const applied: string[] = [];
    const loop = makeLoop({
      store: rig.store,
      sessionId: session.sessionId,
      present: true,
      logs: applied,
      readPluginTopics: () => {
        throw new Error('桥炸了');
      },
    });

    const entry = await loop.tickOnce();

    assert.ok(entry !== null, '其它来源还在，这一轮不该空转');
    assert.equal(entry.trigger, 'presence_arrived');
    assert.equal(entry.speak, true);
    assert.match(applied.join('\n'), /插件话题源读失败/);
    assert.match(applied.join('\n'), /桥炸了/);
  } finally {
    dropStore(rig);
  }
});

// ------------------------------------------------------------------------- the reminder invariant

test('一句话都没说时提醒不会被提前标成已送达（说了才 delivered）', async () => {
  const rig = tempStore('xixi-capability-bridge-reminder-');
  try {
    const { store } = rig;
    const session = store.createSession();
    // 一小时前就到期的一条提醒：它的候选排在插件话题之前（用户自己要求的事优先）。
    const sink = new DurableReminderSink({ store, timezone: SHANGHAI, now: () => T0 });
    const scheduled = sink.scheduleAt({ what: '给妈妈打电话', when: '马上', now: new Date(T0.getTime() - 3_600_000) });
    const scheduler = new ReminderScheduler({ store, now: () => T0 });
    const topic = '小区门口的银杏黄了';
    const bridge = createPluginCapabilityBridge({
      capabilities: registryWith([{ pluginId: 'xixi.demo', source: { name: 'demo.topics', propose: () => [{ topic, reason: '树干上贴了告示', score: 0.9 }] } }]),
      timezone: SHANGHAI,
    });
    const readPluginTopics: PluginTopicReader = async (now) => (await bridge.topics.propose({ now })).candidates;
    const delivered: string[] = [];
    const onReminderDelivered = (reminderId: string, at: Date): void => {
      delivered.push(reminderId);
      scheduler.deliver(reminderId, at);
    };
    /**
     * 生产形状的读法：**先跑一次时钟**（`pending → due → candidate`）再取候选。
     *
     * `candidateInputs` 只把「已经 due 的」变成候选，自己不比较时钟 —— 少写 `tick` 那一半，刚刚存进来
     * 的提醒就永远轮不到开口（这一条是本用例第一次跑出来才注意到的，写在这里给 T8 的接线当参照）。
     */
    const readDueReminders = (): readonly ReminderCandidateInput[] => {
      scheduler.tick(T0);
      return scheduler.candidateInputs(T0);
    };

    // ① 读空气说「这会儿别说」：这一轮一句话都没说。
    const declined = await makeLoop({
      store,
      sessionId: session.sessionId,
      present: null,
      readDueReminders,
      onReminderDelivered,
      readPluginTopics,
      decide: async () => ({ speak: false, reasonCode: 'user_busy' }),
    }).tickOnce();

    assert.ok(declined !== null);
    assert.match(declined.fact, /durable reminder/, '这一轮考虑的确实是那条提醒（而不是插件话题）');
    assert.equal(declined.speak, false);
    assert.equal(declined.reasonCode, 'MODEL_DECLINED');
    assert.equal(declined.text, null, '一句话都没说');
    assert.deepEqual(delivered, [], '决定「不说」时不该调 onReminderDelivered');
    assert.equal(scheduler.waiting().length, 1, '提醒还在候选状态，没有被提前标成已送达');
    assert.equal(
      store
        .readEvents({ type: 'reminder.changed', limit: 20 })
        .filter((event) => (event.payload as Record<string, unknown>)['reason_code'] === 'reminder_delivered').length,
      0,
      '事件日志里不该有 reminder_delivered',
    );
    assert.equal(
      store
        .readEvents({ type: 'conversation.turn', limit: 20 })
        .filter((event) => (event.payload as Record<string, unknown>)['role'] === 'assistant').length,
      0,
      '没有说出口就不该写进对话历史',
    );

    // ② 同一个调度器、同一个循环，这次没人拦：提醒真的被说出口，这时才允许 delivered。
    const spoken = await makeLoop({
      store,
      sessionId: session.sessionId,
      present: null,
      readDueReminders,
      onReminderDelivered,
      readPluginTopics,
    }).tickOnce();

    assert.ok(spoken !== null);
    assert.equal(spoken.speak, true);
    assert.equal(spoken.text, '该提醒你了：给妈妈打电话');
    assert.deepEqual(delivered, [scheduled.change.reminder.id], '只有说出口的那一次才记送达');
    assert.equal(scheduler.waiting().length, 0);
    assert.equal(
      store
        .readEvents({ type: 'reminder.changed', limit: 20 })
        .filter((event) => (event.payload as Record<string, unknown>)['reason_code'] === 'reminder_delivered').length,
      1,
    );
  } finally {
    dropStore(rig);
  }
});
