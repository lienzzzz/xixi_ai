/**
 * V0.3 D1.1 + D1.2 — 两个接缝接进 **live 入口自己的** 主动循环（`npm run test:console`，也进 `npm test`）。
 *
 * 装配点 `createResidentRuntime` 早就交出了 `reminderSeams`（到点的 durable 提醒）与 `capabilities`
 * （插件的 `topic_source` 提案），但 P2.5 里只有**测试**与**验收脚本**用过它们：两个 live 入口那一处
 * `new ProactiveLoop({ … })` 里一个字都没写，于是「到点她会说出来」当时只有手调 `tick()` 才看得见。
 * 这个文件是那条接线的门禁，判据是**入口自己的循环的可观察行为**，不是源码里有没有那行字
 * （AGENTS §9.24：字符串断言看不见调用图——那正是本任务要还的债）。
 *
 *   1. **提醒（D1.1）**：往入口的库里写一条**已经到点**的提醒 → 让入口自己的定时器去跑
 *      （`/api/…/proactive/loop` 的 `start`，第一拍是立即的）→ 断言那条提醒在**入口的日志里**走完
 *      `pending → due → candidate`，并且循环推给页面的那一条记录的 `candidateId` 就是它。
 *      整个用例里**没有** `{action:'tick'}`，也**没有**任何地方手调 `runtime.reminderSeams`：如果入口
 *      没把那一对接上，提醒会一直停在 `pending`（读接缝从没跑过 markDue），这条用例必红。
 *   2. **插件提案（D1.2）**：控制台挂一个注册 `topic_source` 的 inline 插件 → 静默时段覆盖此刻时它
 *      **照样进候选**（循环考虑了它、候选 id 是它）但被硬底线拦成 `QUIET_HOURS`；关掉静默时段后同一份
 *      提案被说出来，且说的就是它自己那句。开口与否仍由既有的硬底线与评分决定，插件只提供候选（铁律 3）。
 *
 * 反事实（把 `...runtime.reminderSeams` / `readPluginTopics` 从入口里删掉）在回报里给了命令与哈希；
 * 那一行消失时本文件的对应用例变红，所以它不是「看起来接了」。
 *
 * **试用页那半的插件证据（t30 补上）**：上面第 2 条一开始只有控制台的证据 —— `createTrialRuntime()` 造出来
 * 的 runtime 与**入口那个模块级循环**不是同一个实例，所以离线用例给不了试用页一个「会提案的插件」：
 * 删掉 `readPluginTopics` 也全绿（t25 的 S4 突变实测）。现在入口的循环由
 * `createTrialProactiveLoop(runtime, deps)` 装配（接缝全部取自**传进来的那个** runtime，形状与现场测试
 * 控制台的 `createFieldServer({ plugins })` 一致），于是用例可以拿一个带 inline 插件的 trial runtime
 * 调**同一个函数** —— 第 3 条就是那条接线的行为证据，删掉工厂里那一行时它必红。
 * 第 4 条是它的小弟：只证明**入口真的用了这个工厂**（否则行为证据可以被「入口里另写一个循环」绕开）。
 *
 * 全程离线、不花钱：没有密钥、没有网络、没有模型（控制台用 `offline: true`，试用页用 `--fake`）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TopicEngine } from '@xixi/conversation';
import { formatZonedIso, openXixiStore, ReminderStore, type XixiStore } from '@xixi/domain';
import type { InlinePlugin, TopicSource } from '@xixi/plugins';

import {
  applyProactiveSettingsPatch,
  createFakeProbeRunner,
  createFieldServer,
  restoreProactiveSettings,
} from '../../scripts/field-test.ts';
import { loadConfig, REPO_ROOT } from '../../scripts/lib/harness.ts';
import { createTrialProactiveLoop, createTrialRuntime } from '../../scripts/serve-chat.ts';

import { startTrialPage } from './serve-chat-fixture.ts';

const TIMEZONE = 'Asia/Shanghai';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function dropDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * 一条**已经到点**的提醒：`due_at` 相对真实时钟往前 60 秒。
 *
 * 相对而不是写死日期（AGENTS §10.4）：写死的种子时间要么今天绿、两天后红，要么一上来就过期。
 */
function dueReminder(store: XixiStore, what: string): string {
  const change = new ReminderStore(store).create({
    what,
    dueAt: formatZonedIso(new Date(Date.now() - 60_000), TIMEZONE),
    timezone: TIMEZONE,
    resolveKind: 'asap',
  });
  return change.reminder.id;
}

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${url} 必须 200：${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function statusOf(payload: Record<string, unknown>): Record<string, unknown> {
  const status = payload['status'];
  return typeof status === 'object' && status !== null ? (status as Record<string, unknown>) : {};
}

/** 循环推给页面的那些记录（`entries`），最新一条在末尾。 */
function entriesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const entries = payload['entries'];
  return Array.isArray(entries) ? (entries as Record<string, unknown>[]) : [];
}

function lastEntry(payload: Record<string, unknown>): Record<string, unknown> {
  const entries = entriesOf(payload);
  assert.ok(entries.length > 0, `这一拍循环什么记录都没推出来：${JSON.stringify(payload)}`);
  return entries[entries.length - 1] as Record<string, unknown>;
}

/** 提醒在日志里走过的状态，按顺序。 */
function reminderStatuses(store: XixiStore, reminderId: string): (string | undefined)[] {
  return new ReminderStore(store)
    .history(reminderId)
    .map((event) => (event.payload as { status?: string }).status);
}

async function waitUntil(what: string, probe: () => boolean, deadlineMs = 20_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) throw new Error(`等不到「${what}」`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** `HH:MM`，与静默时段判据同一个口径（都是本地墙上时间）。 */
function clockOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 一个覆盖「此刻」的静默时段：前后各一小时（跨午夜时判据本来就按绕圈处理，出厂配置也是跨午夜的）。 */
function quietWindowAround(now: Date): { readonly start: string; readonly end: string } {
  return { start: clockOf(new Date(now.getTime() - 60 * 60_000)), end: clockOf(new Date(now.getTime() + 60 * 60_000)) };
}

/** 一个注册 `topic_source` 的原生插件：`activate` 时把来源登记进能力注册表。 */
function topicPlugin(topic: string, capability = 'demo.topics', pluginId = 'xixi.demo'): InlinePlugin {
  const source: TopicSource = {
    name: capability,
    propose: () => [{ topic, reason: '用例来源：这条是插件自己提的', score: 1 }],
  };
  return {
    manifest: {
      schemaVersion: 1,
      id: pluginId,
      name: pluginId,
      version: '0.1.0',
      permissions: ['topic.read'],
      capabilities: ['topic_source'],
    },
    module: { activate: () => ({ topicSources: [source] }) },
  };
}

test('试用页（serve-chat.ts）：到点的提醒由入口自己的循环读成候选（不手调接缝、不手调 tick）', async () => {
  const dataDir = tempDir('xixi-trial-seams-');
  const page = await startTrialPage({ dataDir });
  let store: XixiStore | null = null;
  try {
    store = openXixiStore({ dataDir });
    const reminderId = dueReminder(store, '给儿子打电话');

    // 「start」= 入口自己的定时器（`start()` 的第一拍立即，之后每 5 秒一拍）。
    // 这个用例里没有 `{action:'tick'}`，也没有任何地方手调 `runtime.reminderSeams`。
    const started = await post(`${page.base}/api/proactive/loop`, { action: 'start', intervalMs: 5_000 });
    assert.equal(statusOf(started)['running'], true, '入口自己的循环必须真的在跑');

    await waitUntil('提醒被试用页的循环读成候选', () => new ReminderStore(store as XixiStore).get(reminderId)?.status !== 'pending');

    const after = new ReminderStore(store).get(reminderId);
    assert.ok(after !== null, '提醒必须还在库里');
    assert.ok(
      ['candidate', 'delivered', 'acknowledged'].includes(after.status),
      `到点之后状态必须往前走（读接缝会推到 candidate）：${after.status}`,
    );
    const statuses = reminderStatuses(store, reminderId);
    assert.ok(statuses.includes('due') && statuses.includes('candidate'), `日志里要有 due 与 candidate：${statuses.join(' → ')}`);

    // 「循环自己读到了它」的可复核形态：循环推给页面的那条记录，候选 id 就是这条提醒。
    const stopped = await post(`${page.base}/api/proactive/loop`, { action: 'stop' });
    const ids = entriesOf(stopped).map((entry) => String(entry['candidateId']));
    assert.ok(ids.some((id) => id.includes(reminderId)), `循环得自己把这条提醒读成候选：entries=${JSON.stringify(ids)}`);
  } finally {
    store?.close();
    await page.stop();
    dropDir(dataDir);
  }
});

test('控制台（field-test.ts）：到点的提醒由入口自己的循环读成候选（不手调接缝、不手调 tick）', async () => {
  const root = tempDir('xixi-console-seams-');
  const handle = await createFieldServer({
    port: 0,
    offline: true,
    ttsEnabled: false,
    dataDir: join(root, 'data'),
    voiceDir: join(root, 'voice'),
    presenceDataDir: join(root, 'presence'),
    reportDir: join(root, 'recon'),
    autoPrune: false,
    probeRunner: createFakeProbeRunner(),
    log: () => {},
  });
  try {
    const store = handle.runtime.store;
    const reminderId = dueReminder(store, '给儿子打电话');

    const started = await post(`${handle.url}/api/field/proactive/loop`, { action: 'start', intervalMs: 5_000 });
    assert.equal(statusOf(started)['running'], true, '入口自己的循环必须真的在跑');

    await waitUntil('提醒被控制台的循环读成候选', () => new ReminderStore(store).get(reminderId)?.status !== 'pending');

    const after = new ReminderStore(store).get(reminderId);
    assert.ok(after !== null && after.status !== 'pending', `到点之后状态必须往前走：${after?.status}`);
    const statuses = reminderStatuses(store, reminderId);
    assert.ok(statuses.includes('due') && statuses.includes('candidate'), `日志里要有 due 与 candidate：${statuses.join(' → ')}`);

    const stopped = await post(`${handle.url}/api/field/proactive/loop`, { action: 'stop' });
    const ids = entriesOf(stopped).map((entry) => String(entry['candidateId']));
    assert.ok(ids.some((id) => id.includes(reminderId)), `循环得自己把这条提醒读成候选：entries=${JSON.stringify(ids)}`);
  } finally {
    await handle.close();
    dropDir(root);
  }
});

test('插件提案的话题进入控制台的主动候选；开口与否仍由硬底线与评分决定（D1.2）', async () => {
  const topic = '小区门口的银杏黄了';
  const root = tempDir('xixi-console-plugin-topic-');
  const handle = await createFieldServer({
    port: 0,
    offline: true,
    ttsEnabled: false,
    dataDir: join(root, 'data'),
    voiceDir: join(root, 'voice'),
    presenceDataDir: join(root, 'presence'),
    reportDir: join(root, 'recon'),
    autoPrune: false,
    probeRunner: createFakeProbeRunner(),
    plugins: { inline: [topicPlugin(topic)] },
    log: () => {},
  });
  try {
    // 只留 topic_pool（插件候选借的就是这个 trigger），其余来源全关：这一拍**只有**插件那一条候选，
    // 所以下面两条断言的对象不可能是别的来源（否则它们会变成「碰巧」）。
    const quiet = quietWindowAround(new Date());
    const patched = await post(`${handle.url}/api/field/proactive/settings`, {
      enabled: true,
      quietStart: quiet.start,
      quietEnd: quiet.end,
      triggers: {
        future_hook_due: false,
        presence_arrived: false,
        conversation_dangling: false,
        routine_expected: false,
        random_smalltalk: false,
        topic_pool: true,
      },
    });
    assert.deepEqual(patched['rejected'], [], `设置补丁不许有被拒字段：${JSON.stringify(patched['rejected'])}`);

    // ① 静默时段覆盖此刻：提案**照样进候选**（循环考虑了它），但被硬底线拦下 —— 决定权不在插件。
    const blocked = lastEntry(await post(`${handle.url}/api/field/proactive/loop`, { action: 'tick' }));
    assert.equal(blocked['speak'], false, `静默时段里不许开口（实际 ${JSON.stringify(blocked['reasonCode'])}）`);
    assert.equal(blocked['reasonCode'], 'QUIET_HOURS', '被拦的原因必须是硬底线，而不是「插件说了不算」');
    // 候选 id 由循环拼成 `loop-<trigger>-<候选自己的 id>`；插件候选借的就是 topic_pool 这个 trigger。
    assert.match(String(blocked['candidateId']), /^loop-topic_pool-plugin-demo\.topics-/, '被考虑的那条候选必须正是插件提的');

    // ② 关掉静默时段：同一份提案被说出来，说的就是它自己那句（离线兜底 = 候选自己的 line）。
    const opened = await post(`${handle.url}/api/field/proactive/settings`, { quietStart: '00:00', quietEnd: '00:00' });
    assert.deepEqual(opened['rejected'], []);
    const spoken = lastEntry(await post(`${handle.url}/api/field/proactive/loop`, { action: 'tick' }));
    assert.equal(spoken['speak'], true, `没有静默时段时插件提案该被说出来（实际 ${JSON.stringify(spoken['reasonCode'])}）`);
    assert.equal(spoken['text'], `有个话题想跟你聊：${topic}`, '说出口的必须是插件那条候选自己那一句');
    assert.equal(spoken['contentSource'], 'fixed', '离线：内容是兜底短句，不经过模型');
  } finally {
    await handle.close();
    dropDir(root);
  }
});

/**
 * 试用页那半（t30）：与控制台那条同一个模板，对象换成**试用页自己的装配路径**。
 *
 * 差别只在「谁给它一个会提案的插件」：控制台是 `createFieldServer({ plugins })`，试用页是
 * `createTrialRuntime({ plugins })` + `createTrialProactiveLoop(runtime, deps)` —— 两者都是**入口自己
 * 用的那个装配函数**，不是为测试另写一份。
 *
 * 断言的对象与上面那条逐字对应：插件提案**真的进了候选**（候选 id 就是它）却先被硬底线拦下，
 * 关掉静默时段后说的就是它自己那一句。
 */
test('插件提案的话题进入试用页的主动候选；开口与否仍由硬底线与评分决定（D1.2，试用页那半）', async () => {
  const topic = '小区门口的银杏黄了';
  const presenceDir = tempDir('xixi-trial-plugin-presence-');
  const runtime = createTrialRuntime({ plugins: { inline: [topicPlugin(topic)] } });
  try {
    // 插件走的是入口自己的九步生命周期：`start()` 之后它的 `topic_source` 才在能力注册表里 ——
    // 这一句同时说明「插件真的被启动了」，不是把提案硬塞进候选池。
    await runtime.start();
    const store = runtime.store;
    const config = loadConfig();
    const quiet = quietWindowAround(new Date());
    // 只留 topic_pool（插件候选借的就是这个 trigger），其余来源全关：这一拍**只有**插件那一条候选，
    // 所以下面两条断言的对象不可能是别的来源。补丁走的是 `/api/proactive/settings` 背后同一个函数。
    const patched = applyProactiveSettingsPatch(
      restoreProactiveSettings(store, config.proactive as unknown as Record<string, unknown>).settings,
      {
        enabled: true,
        quietStart: quiet.start,
        quietEnd: quiet.end,
        triggers: {
          future_hook_due: false,
          presence_arrived: false,
          conversation_dangling: false,
          routine_expected: false,
          random_smalltalk: false,
          topic_pool: true,
        },
      },
    );
    assert.deepEqual(patched.rejected, [], `设置补丁不许有被拒字段：${JSON.stringify(patched.rejected)}`);
    let settings = patched.settings;

    const session = store.createSession();
    const loop = createTrialProactiveLoop(runtime, {
      topicEngine: new TopicEngine({ store, config: config.openThreads, clock: () => new Date() }),
      sessionId: () => session.sessionId,
      settings: () => settings,
      inFlightTurn: () => false,
      presenceDataDir: presenceDir,
      synthesizeProvider: () => undefined,
      modelAvailable: () => false,
      log: () => {},
    });

    // ① 静默时段覆盖此刻：提案**照样进候选**（循环考虑了它），但被硬底线拦下 —— 决定权不在插件。
    const blocked = await loop.tickOnce();
    assert.ok(blocked !== null, '这一拍必须有候选被考虑过');
    assert.equal(blocked.speak, false, `静默时段里不许开口（实际 ${JSON.stringify(blocked.reasonCode)}）`);
    assert.equal(blocked.reasonCode, 'QUIET_HOURS', '被拦的原因必须是硬底线，而不是「插件说了不算」');
    assert.match(
      String(blocked.candidateId),
      /^loop-topic_pool-plugin-demo\.topics-/,
      '被考虑的那条候选必须正是插件提的',
    );

    // ② 关掉静默时段：同一份提案被说出来，说的就是它自己那句（离线兜底 = 候选自己的 line）。
    settings = applyProactiveSettingsPatch(settings, { quietStart: '00:00', quietEnd: '00:00' }).settings;
    const spoken = await loop.tickOnce();
    assert.ok(spoken !== null, '这一拍必须有候选被考虑过');
    assert.equal(spoken.speak, true, `没有静默时段时插件提案该被说出来（实际 ${JSON.stringify(spoken.reasonCode)}）`);
    assert.equal(spoken.text, `有个话题想跟你聊：${topic}`, '说出口的必须是插件那条候选自己那一句');
    assert.equal(spoken.contentSource, 'fixed', '离线：内容是兜底短句，不经过模型');
  } finally {
    await runtime.stop();
    dropDir(presenceDir);
  }
});

/**
 * 上面那条行为证据调的是 `createTrialProactiveLoop`；这条证明**入口自己也在调它**。
 *
 * 为什么需要它（AGENTS §9.24）：行为证据落在「工厂」这一层，如果哪天有人在 `serve-chat.ts` 的模块层
 * 重新写一个自己的字面量循环，工厂里的接线照样被测到，而**入口**已经不走它了 —— 那又变回纸面防线。
 * 这条是源码级断言（比行为证据弱），所以它只给上一条封边、不替代它。
 */
test('试用页入口自己的循环由 createTrialProactiveLoop 装配（模块层字面量不许回来）', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'serve-chat.ts'), 'utf8');
  // 先去掉注释再数：注释里正当地引着旧写法（`new ProactiveLoop({…})`），那不是代码路径。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(
    code,
    /const proactiveLoop = createTrialProactiveLoop\(runtime, \{/,
    '入口必须用工厂装配自己的循环（接缝才会取自同一个 runtime 实例）',
  );
  const literals = code.match(/new ProactiveLoop\(/g) ?? [];
  assert.equal(literals.length, 1, `new ProactiveLoop 只应出现在工厂里（实际 ${literals.length} 处）`);
});
