/**
 * V0.3 P2.5-K — 真入口验收（`npm run verify:p2.5`）。
 *
 * P2.5 的验收要求「不能只测 package」：前面每个任务都在自己的契约里证明了装配点、插件内核、
 * durable 提醒、审批、新闻都**接上了线**，但「活的西西真的用得上它们」这件事必须在**真入口**上
 * 再走一遍。这个脚本就是那条可重跑的门禁，四个场景各自留下可复核的证据：
 *
 *   1. **文字入口问新闻** —— 入口（`scripts/chat.ts` 的 `createChatRuntime`）装配出来的链上真的有
 *      `news.latest`；有密钥时**真模型**会调它、结果带着夹具的标题回到回答里；没有密钥时退化成
 *      离线脚本模型并**明确打印 OFFLINE**（不静默跳过）。
 *   2. **提醒跨重启** —— 子进程写下一条提醒（真工具链 + durable sink）→ 父进程（**另一个进程**）
 *      打开同一个库仍读得到 → 到点由装配点的读接缝变成候选 → 主动循环真的说出口 → 落 `delivered`。
 *   3. **审批** —— 把提醒工具声明成需要确认（`tools.approval.ask`）→ 用户提要求 → 有以待批请求、
 *      业务数据一行未写 → 模型后来那组**不同**的参数只是另一条待批 → 点头第一条执行的是**当时冻结**
 *      的那组参数 → 数据才落库。
 *   4. **插件关停** —— 控制台入口（`createFieldServer`）挂一个探针插件 → 调 `close()` → 插件工具不再
 *      出现在模型可见列表里 → 探针的连接标记被关掉 → 提醒调度不再跑（读接缝连不上已关的库）而待办仍在
 *      库里。**关停走的是内核的第 9 步 `dispose`**（`manager.disposeAll()`），不是第 8 步 `deactivate`
 *      —— 脚本按事实断言 `dispose`，deactivate 跑没跑如实记录在证据里。
 *
 * 用法：
 *   node scripts/verify-p2.5.ts                    # 四个场景全跑（有密钥时场景 1 会真调一次模型）
 *   node scripts/verify-p2.5.ts --scenario=news    # 只跑一个：news / reminder / approval / shutdown
 *   node scripts/verify-p2.5.ts --offline          # 场景 1 强制走离线替身（不花 API 费用）
 *   node scripts/verify-p2.5.ts --phase=reminder-write --state=<dir>   # 内部：跨重启的子进程阶段
 *
 * 口径（AGENTS §9.24，写清楚哪一段是**真的**、哪一段是**模拟的**）：
 *
 *   * 场景 1 的新闻来源是**本地 RSS 夹具**（一个只在 127.0.0.1 上服务几秒的临时 HTTP 服务）。
 *     本机实测：BBC World 那条 feed 直连与代理都超时（`curl` 20–25s 无响应），而这条验收要证明的是
 *     「入口 → 模型 → news 工具 → 结果回到回答」这条链，不是公网可达性。把 URL 换成任何一条真 feed，
 *     被证明的东西一模一样。
 *   * 场景 2 的「到点」是**注入时钟**造的：写提醒那一步把「现在」取成真实时钟往前 30 小时，于是
 *     「明天八点」解析出来的绝对时刻必然落在过去（最坏也比现在早 13 小时）。为什么要注入：入口工厂
 *     `createChatRuntime` 不接受 `now`，而验收要的是「到点」而不是「等一天」。所以**写**那一步用的是
 *     入口们共同调用的装配点 `createResidentRuntime`（控制台/试用页/CLI 都是它）；**读**那一步用的是
 *     文字入口 `createChatRuntime` + 真实时钟，所以「到点」是它自己判断出来的。
 *   * 场景 2 的主动那一步由**循环自己**驱动（V0.3 D1.1 接上之后；在此之前脚本是手调
 *     `runtime.reminderSeams.readDueReminders()` 再喂给循环的 —— 那只证明「接缝可用」，证明不了
 *     「循环在用它」）。现在脚本与本仓库的 live 入口写的是**同一行** `...runtime.reminderSeams`，
 *     并且**不再**手调那对接缝：候选是不是被读出来的，由「循环自己把提醒推进到 candidate / 说出口」证明。
 *     可复核：`git grep -n 'reminderSeams' -- scripts ':!scripts/verify-p2-5.ts'` **应当命中**
 *     `scripts/serve-chat.ts` 与 `scripts/field-test.ts`（必须排除本脚本自己，见 P2.5-K 那次
 *     buildToolChain 的教训）；入口侧的端到端用例在 `tests/console/live-entry-proactive-seams.test.ts`。
 *   * 场景 4 的「相关连接」由探针插件自己用文件标记表示（`activate` 置 `{open:true}`，`deactivate` /
 *     `dispose` 都置 `{open:false}`）：生产里这一处是 MCP transport 的 `close()`，探针要证明的是
 *     **关停真的走到了那个钩子**。
 *
 * 这一步只做验收与门禁，不改任何生产接线（那是前面各任务的交付）。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeBrainAdapter, type AgentTool, type ToolCallRecord } from '@xixi/brain-adapter';
import { parseProactiveSettings } from '@xixi/conversation';
import { ReminderStore, openXixiStore, resolveReminderWhen, type PluginSettings, type XixiConfig } from '@xixi/domain';
import { NEWS_FOR_INTERESTS_TOOL, NEWS_LATEST_TOOL, NEWS_SEARCH_TOOL } from '@xixi/plugins/news';
import type { InlinePlugin } from '@xixi/plugins';
import { CONVERSATION_SCOPE, ProactiveLoop, buildToolChain, createResidentRuntime, type XixiResidentRuntime } from '@xixi/runtime';

import { createChatRuntime } from './chat.ts';
import { createFieldServer } from './field-test.ts';
import { REPO_ROOT, loadConfig, readDotEnv } from './lib/harness.ts';

const NEWS_TOOLS: readonly string[] = [NEWS_SEARCH_TOOL, NEWS_LATEST_TOOL, NEWS_FOR_INTERESTS_TOOL];

/** 夹具头条：出现它在工具返回里，就说明「新闻真的从来源走到了模型看得见的结果里」。 */
const FIXTURE_HEADLINE = '城东地铁 5 号线延长运营时间';
/** 夹具 feed 的条目（都是本脚本自己造的，不是真新闻）。来源名也取一个像样的，免得模型一眼当成测试数据。 */
const FIXTURE_ITEMS: readonly string[] = [FIXTURE_HEADLINE, '本地气象台发布大风蓝色预警', '市图书馆周末举办旧书交换市集'];
const FIXTURE_SOURCE_NAME = '城东日报';

/**
 * 场景 2 的注入时钟：写提醒那一步的「现在」取**真实时钟往前 30 小时**。
 *
 * 为什么不用一个写死的日期：写死会让这条用例变成定时炸弹（AGENTS §10.4）。往前 30 小时 + 「明天八点」
 * 解析出来的那个时刻，无论今天几点跑，都稳稳落在过去（最坏情况也早 13 小时），所以「到点」由真实时钟
 * 自己判断得出来，而这一步又不需要真的等一天。
 */
const REMINDER_WRITTEN_AT = new Date(Date.now() - 30 * 60 * 60 * 1000);

const SCENARIOS = ['news', 'reminder', 'approval', 'shutdown'] as const;
type ScenarioName = (typeof SCENARIOS)[number];

// --------------------------------------------------------------------------------------
// 统计与断言：失败只记账，跑完四个场景再统一 exit 1（一次看到全部问题）
// --------------------------------------------------------------------------------------

const failures: string[] = [];
let checks = 0;

function check(condition: boolean, label: string, detail?: unknown): boolean {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
    return true;
  }
  failures.push(label);
  console.log(`  ✗ ${label}${detail === undefined ? '' : `  ← ${render(detail)}`}`);
  return false;
}

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function hasMimoKey(): boolean {
  const key = process.env.MIMO_API_KEY ?? readDotEnv().MIMO_API_KEY;
  return key !== undefined && key.length > 0;
}

/** 入口脚本（`chat.ts` 的 `main`）在跑之前会把 `.env` 灌进环境；这里照做，但记得还原。 */
function withDotEnv<T>(run: () => Promise<T>): Promise<T> {
  const injected: string[] = [];
  for (const [key, value] of Object.entries(readDotEnv())) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      injected.push(key);
    }
  }
  const restore = (): void => {
    for (const key of injected) delete process.env[key];
  };
  return run().finally(restore);
}

/** 一份「入口的声明 + 部署配置的覆盖」：与入口自己拼配置是同一件事，只是值来自本次验收。 */
function configWith(base: XixiConfig, patch: { readonly tools?: Record<string, unknown>; readonly plugins?: PluginSettings }): XixiConfig {
  return {
    ...base,
    ...(patch.tools === undefined ? {} : { tools: patch.tools }),
    ...(patch.plugins === undefined ? {} : { plugins: patch.plugins }),
  };
}

function newsConfig(base: XixiConfig, url: string): XixiConfig {
  return configWith(base, {
    plugins: {
      enabled: true,
      directories: [],
      news: { enabled: true, sources: [{ name: FIXTURE_SOURCE_NAME, url }], interests: [] },
      mcpServers: [],
    },
  });
}

/** 链上那个**写**工具的名字，从装配点自己造的表里读：T7 改过一次名，写死就会变成假红。 */
function writeToolName(config: XixiConfig): string {
  const write = buildToolChain(config)
    .all()
    .filter((tool) => tool.risk === 'write')
    .map((tool) => tool.name);
  if (write.length === 0) throw new Error('装配点的链上没有任何写工具，下面的验收无从谈起');
  return write[0]!;
}

// --------------------------------------------------------------------------------------
// 场景 1：文字入口问新闻
// --------------------------------------------------------------------------------------

async function scenarioNews(offlineForced: boolean): Promise<Record<string, unknown>> {
  console.log('\n=== 场景 1：文字入口问新闻（入口 = scripts/chat.ts 的 createChatRuntime）===');

  const now = new Date();
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${FIXTURE_SOURCE_NAME}</title><link>http://127.0.0.1/</link>
${FIXTURE_ITEMS.map(
  (title, index) =>
    `<item><title>${title}</title><link>http://127.0.0.1/fixture/${index + 1}</link>` +
    `<pubDate>${new Date(now.getTime() - index * 30 * 60 * 1000).toUTCString()}</pubDate><description>本地夹具条目。</description></item>`,
).join('\n')}
</channel></rss>`;

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
    response.end(feed);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/world.xml`;

  const root = tempDir('xixi-p2-5-news-');
  const live = hasMimoKey() && !offlineForced;
  const toolCalls: ToolCallRecord[] = [];
  let runtime: XixiResidentRuntime | undefined;
  try {
    console.log(`  新闻来源：本地夹具 ${url}`);
    console.log(
      live
        ? '  模型：真实 MiMo（直连；这一条场景会花掉一次真实调用）'
        : `  模型：**OFFLINE**（${offlineForced ? '--offline 指定' : '没有 MIMO_API_KEY'}）——本次不发任何外部模型调用，`
          + '改由脚本模型发起同一次工具调用；「模型自己决定去查新闻」这半条没有跑，另外半条'
          + '（链上有新闻工具、工具真的去取、结果回到回答里）照跑。',
    );

    const config = newsConfig(loadConfig(), url);
    const store = openXixiStore({ dataDir: root });
    try {
      // 注意这里**不能用** `mode: 'fake'`：那会把插件的网络授权换成「一用即抛」的 fetch（`--fake` 的离线
      // 承诺），于是连 127.0.0.1 上的夹具都取不到 —— 而这一条场景要证明的正是「工具真的去取了」。
      // 离线那一半由「注入脚本模型」保证：一个外部请求都不会发出去。
      runtime = createChatRuntime({
        config,
        store,
        mode: 'mimo',
        onToolCall: (record) => void toolCalls.push(record),
        log: () => {},
        ...(live
          ? {}
          : {
              model: ({ toolChain }) =>
                new FakeBrainAdapter({
                  registry: toolChain,
                  scope: CONVERSATION_SCOPE,
                  toolPlan: (_input, round) => (round === 1 ? [{ name: NEWS_LATEST_TOOL }] : []),
                }),
            }),
      });
      await runtime.start();

      const visible = runtime.toolChain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name);
      check(visible.includes(NEWS_LATEST_TOOL), '入口的模型可见链上有 news.latest', visible);
      check(visible.some((name) => name.startsWith('news.')), '入口的模型可见链上有整族新闻工具', visible);

      const session = store.createSession();
      const attempts: Record<string, unknown>[] = [];
      let reply: string | null = null;
      // 真模型有一次重试余量：脚本化替身一次就够，所以离线路径只跑一轮。
      for (let attempt = 1; attempt <= (live ? 2 : 1); attempt += 1) {
        const before = toolCalls.length;
        const utterance = attempt === 1 ? '西西，最近有什么新闻吗？帮我查一下。' : '用你的新闻工具查一下最近有什么新闻。';
        const turn = await runtime.conversation.respond({ sessionId: session.sessionId, text: utterance, addressed: true });
        reply = turn.text;
        const fresh = toolCalls.slice(before);
        attempts.push({
          attempt,
          utterance,
          action: turn.action,
          reply: turn.text,
          toolCalls: fresh.map((call) => ({ name: call.name, ok: call.ok, error: call.error ?? null })),
        });
        console.log(`  第 ${attempt} 轮：action=${turn.action} 工具调用=${fresh.map((call) => `${call.name}(${call.ok ? 'ok' : 'failed'})`).join('、') || '无'}`);
        if (fresh.some((call) => NEWS_TOOLS.includes(call.name) && call.ok)) break;
      }

      const newsCall = toolCalls.find((call) => NEWS_TOOLS.includes(call.name));
      check(newsCall !== undefined, '这一轮**真的形成了新闻工具的调用**（不是回一句「我查不了」）', attempts);
      check(newsCall?.ok === true, '新闻工具调用是成功的（不是降级成 problems）', newsCall === undefined ? '' : { ok: newsCall.ok, error: newsCall.error });
      const payload = JSON.stringify(newsCall?.result ?? {});
      check(payload.includes(FIXTURE_HEADLINE), '工具返回里带着来源的标题（新闻真的从来源走到了模型可见的结果里）', payload.slice(0, 240));
      check(
        reply !== null && reply.length > 0 && !/查不[到了]|没有(这个)?工具|无法查询/.test(reply),
        '回答不是「我查不了」这类兜底话',
        reply,
      );
      console.log(`  西西的回答：${reply ?? '(沉默)'}`);

      // 库里读回来的那一份：`conversation.turn` 事件带着这一轮用的工具名（不是内存里的变量）。
      // `readEvents` 按时间正序返回，所以要取**最后**那条带工具名的助手事件。
      const turnEvents = store.readEvents({ type: 'conversation.turn', limit: 20 });
      const recordedTools = turnEvents
        .map((event) => String((event.payload as { tool_name?: unknown }).tool_name ?? ''))
        .filter((name) => name.length > 0);
      const recordedTool = recordedTools.at(-1) ?? '';
      console.log(`  库里这一轮的对话事件：${render(turnEvents.map((event) => ({ role: (event.payload as { role?: unknown }).role, tool_name: (event.payload as { tool_name?: unknown }).tool_name ?? null })))}`);
      check(NEWS_TOOLS.includes(recordedTool), '对话日志里记着这次调用的工具名（库里的证据）', recordedTool);

      return {
        scenario: 'news',
        mode: live ? 'live-model' : 'offline-scripted',
        newsSource: url,
        visibleTools: visible,
        attempts,
        headlineSeenInToolResult: payload.includes(FIXTURE_HEADLINE),
        toolNameInEventLog: recordedTool,
      };
    } finally {
      if (runtime !== undefined) await runtime.stop().catch(() => undefined);
      store.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------------------
// 场景 2：提醒跨重启（子进程写 → 父进程读 → 主动路径说出口）
// --------------------------------------------------------------------------------------

function scriptedReminderRuntime(config: XixiConfig, store: ReturnType<typeof openXixiStore>, clock: () => Date, tool: string): XixiResidentRuntime {
  return createResidentRuntime({
    config,
    store,
    now: clock,
    log: () => {},
    model: ({ toolChain }) =>
      new FakeBrainAdapter({
        registry: toolChain,
        scope: CONVERSATION_SCOPE,
        now: clock,
        timezone: config.identity.timezone,
        toolPlan: (_input, round) => (round === 1 ? [{ name: tool, arguments: { what: '给儿子打电话', when: '明天八点' } }] : []),
      }),
  });
}

/** 子进程阶段：一个真实入口形态的装配（`createResidentRuntime`，四个入口都调它）写一条提醒。 */
async function reminderWritePhase(stateDir: string): Promise<number> {
  const root = join(stateDir, 'data');
  const config = loadConfig();
  const tool = writeToolName(config);
  const store = openXixiStore({ dataDir: root });
  const before = failures.length;
  try {
    const runtime = scriptedReminderRuntime(config, store, () => REMINDER_WRITTEN_AT, tool);
    await runtime.start();
    const session = store.createSession();
    runtime.reminderSink.beginTurn({ sessionId: session.sessionId, actorId: 'father', sourceEventId: 'evt_verify_p2_5' });
    await runtime.conversation.respond({ sessionId: session.sessionId, text: '提醒我明天八点给儿子打电话', addressed: true, at: REMINDER_WRITTEN_AT });
    runtime.reminderSink.endTurn();

    const rows = new ReminderStore(store).list();
    check(rows.length === 1, `[子进程] 工具真的把提醒写进了 durable 表（${tool}）`, rows.map((row) => row.what));
    const row = rows[0];
    // 「解析成绝对时刻」独立算一遍再比对，而不是写死一个日期：`resolveReminderWhen` 是同一个解析器，
    // 但期望值来自工具入参，所以「工具真的解析了」这件事由它证明，「解析结果对不对」由下面这条钉住。
    const expectedDueAt = resolveReminderWhen('明天八点', { now: REMINDER_WRITTEN_AT, timezone: config.identity.timezone }).dueAt;
    check(row?.dueAt === expectedDueAt, '[子进程] 存的是解析后的绝对时刻（不是「明天八点」原文）', { stored: row?.dueAt, expectedDueAt });
    check(row !== undefined && Date.parse(row.dueAt) < Date.now(), '[子进程] 写下时它已经到点（相对真实时钟是过去）', row?.dueAt);
    check(row?.what === '给儿子打电话', '[子进程] 提醒内容正确', row?.what);
    await runtime.stop();
    writeFileSync(
      join(stateDir, 'write-phase.json'),
      JSON.stringify({ reminderId: row?.id ?? null, sessionId: session.sessionId, what: row?.what ?? null, dueAt: row?.dueAt ?? null, tool, pid: process.pid }, null, 2),
    );
    console.log(`  [子进程 pid=${process.pid}] 已写下提醒 ${row?.id ?? '?'}，到点时刻 ${row?.dueAt ?? '?'}`);
    return failures.length === before ? 0 : 1;
  } finally {
    store.close();
  }
}

async function scenarioReminder(): Promise<Record<string, unknown>> {
  console.log('\n=== 场景 2：提醒跨重启（子进程写 → 父进程读 → 到点 → 主动路径说出口）===');
  const stateDir = tempDir('xixi-p2-5-reminder-');
  const root = join(stateDir, 'data');
  try {
    // ---- 进程 A：写下提醒（工具真的跑了，落的是 durable 表） ----
    const child = await spawnSelf(['--phase=reminder-write', `--state=${stateDir}`]);
    for (const line of child.out.split(/\r?\n/).filter((candidate) => candidate.trim().length > 0)) console.log(`  │ ${line}`);
    check(child.status === 0, '[进程 A] 子进程写下提醒并 exit 0', `status=${String(child.status)}`);
    const stateFile = join(stateDir, 'write-phase.json');
    if (!existsSync(stateFile)) {
      throw new Error(`进程 A 没有留下 ${stateFile}：上面那几行是它自己的输出`);
    }
    const written = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      readonly reminderId: string;
      readonly sessionId: string;
      readonly dueAt: string;
    };
    console.log(`  进程 A pid=${String(child.pid)}，进程 B pid=${process.pid}（**另一个进程**打开同一个库）`);

    // ---- 进程 B：新进程、真实时钟、同一个库 ----
    const config = loadConfig();
    const store = openXixiStore({ dataDir: root });
    let runtime: XixiResidentRuntime | undefined;
    try {
      const persisted = new ReminderStore(store).get(written.reminderId);
      check(persisted !== null, '[进程 B] 重启后待办仍在（读的是库，不是内存）', written.reminderId);
      check(persisted?.status === 'pending', '[进程 B] 还没到点的判定之前它还是 pending', persisted?.status);

      runtime = createChatRuntime({
        config,
        store,
        mode: 'fake',
        log: () => {},
        model: ({ toolChain }) => new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE }),
      });
      await runtime.start();

      // 这里**故意不调** `runtime.reminderSeams.readDueReminders()`（D1.1 之前的写法）：手调只能证明
      // 「接缝可用」，证明不了「循环在用它」。读接缝跑不跑、跑得对不对，由下面那一拍的循环自己交代。
      const before = new ReminderStore(store).get(written.reminderId);
      check(before?.status === 'pending', '[进程 B] 循环还没跑之前它仍是 pending（所以下面的推进只能是循环做的）', before?.status);

      // 主动那一步：接缝来自装配点，**与两个 live 入口写的是同一行** `...runtime.reminderSeams`。
      // V0.3 D1.1 之前本脚本是手调 `runtime.reminderSeams.readDueReminders()` 再喂给循环的 —— 那只证明
      // 「接缝可用」，证明不了「循环在用它」。现在**不再**有那次手调：候选是不是被读出来的，由下面这两步
      // 证明（状态推进 + 候选 id），所以这条验收不会变成空断言。
      const loop = new ProactiveLoop({
        store,
        // 静默时段清零：真实运行时刻可能正落在出厂静默时段里（00:00–24:00 之外没有窗口），
        // 而这一条场景要证明的是「到点会被说出来」，不是「几点允许说话」。
        readSettings: () => parseProactiveSettings({ ...config.proactive, quiet_hours: { start: '00:00', end: '00:00' } }),
        readState: () => 'IDLE',
        readInFlightTurn: () => false,
        readProactivity: () => 0.85,
        readPresence: async () => null,
        readLastUserTurnAt: () => new Date(Date.now() - 6 * 60 * 60 * 1000),
        readRecentUserTopics: () => [],
        readSessionId: () => written.sessionId,
        ...runtime.reminderSeams,
        now: () => new Date(),
        log: () => {},
      });

      // 第一步：**循环自己**读库（读接缝跑整个时钟 pass：markDue → candidateInputs），把这条提醒变成候选。
      const first = await loop.tickOnce();
      const afterDue = new ReminderStore(store).get(written.reminderId);
      check(
        afterDue?.status === 'candidate' || afterDue?.status === 'delivered',
        '[进程 B] 循环自己把到点的提醒推进到了 candidate（本脚本没有手调过读接缝）',
        afterDue?.status,
      );
      check(
        first !== null && first.candidateId.includes(written.reminderId),
        '[进程 B] 这一拍循环考虑的就是这条提醒的候选（候选 id 钉在它身上）',
        first?.candidateId ?? null,
      );

      // 第二步：说出口（这一拍通常就说了：离线兜底 + 确定性推荐；万一是「被拦」就继续 tick 到说出来）。
      const spoken =
        first !== null && first.speak
          ? { text: String(first.text ?? ''), trigger: first.trigger, initiativeKind: first.initiativeKind, candidateId: first.candidateId }
          : await tickUntilSpoken(loop);
      check(spoken !== null, '[进程 B] 主动路径真的把这条提醒说出口了', spoken);
      if (spoken !== null) {
        console.log(`  主动说出口：${spoken.text}（trigger=${spoken.trigger}，候选 ${spoken.candidateId}）`);
        check(spoken.text.includes('给儿子打电话'), '说出口的内容就是那条提醒', spoken.text);
        check(spoken.candidateId.includes(written.reminderId), '说出口的就是**这条**提醒的候选', spoken.candidateId);
      }

      const delivered = new ReminderStore(store).get(written.reminderId);
      check(delivered?.status === 'delivered', '[进程 B] 说出口之后才落 delivered', delivered?.status);
      check(delivered?.deliveredAt !== null && delivered?.deliveredAt !== undefined, '[进程 B] delivered_at 有值', delivered?.deliveredAt);
      const statuses = new ReminderStore(store)
        .history(written.reminderId)
        .map((event) => (event.payload as { status?: string }).status);
      check(
        ['pending', 'due', 'candidate', 'delivered'].every((status) => statuses.includes(status)),
        '[进程 B] 五态链一步不缺（pending → due → candidate → delivered）',
        statuses,
      );

      console.log(
        '  口径：接缝取自装配点（`runtime.reminderSeams`），本脚本**不再**手调它 —— 上面这条链\n' +
          '       （pending → due → candidate → delivered）是**循环自己**走出来的，候选 id 也钉在这条提醒上。\n' +
          "       两个 live 入口写的是同一行；复核 `git grep -n 'reminderSeams' -- scripts ':!scripts/verify-p2-5.ts'`\n" +
          '       应当命中 scripts/serve-chat.ts 与 scripts/field-test.ts（入口侧端到端见\n' +
          '       tests/console/live-entry-proactive-seams.test.ts）。\n' +
          '       「到点」是注入时钟造的（写提醒那一步把 now 往前挪 30 小时），不是真的等到了时间。',
      );

      return {
        scenario: 'reminder',
        writerPid: child.pid ?? null,
        readerPid: process.pid,
        reminderId: written.reminderId,
        dueAt: written.dueAt,
        statuses,
        spoken: spoken === null ? null : { text: spoken.text, trigger: spoken.trigger, initiativeKind: spoken.initiativeKind, candidateId: spoken.candidateId },
        seamsSource: 'runtime.reminderSeams（装配点自己的那一对）',
        seamsWiredByEntry: true,
        seamsNote: "live 入口写的就是同一行 `...runtime.reminderSeams`（复核 git grep -n 'reminderSeams' -- scripts ':!scripts/verify-p2-5.ts' 命中 scripts/serve-chat.ts 与 scripts/field-test.ts）；本脚本不手调接缝，「读成候选」由循环自己走出来",
      };
    } finally {
      if (runtime !== undefined) await runtime.stop().catch(() => undefined);
      store.close();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

interface SpokenProactive {
  readonly text: string;
  readonly trigger: string;
  readonly initiativeKind: string;
  /** 候选 id（循环自己拼的 `loop-<trigger>-<候选 id>`）——「说的是不是**这条**候选」要靠它判。 */
  readonly candidateId: string;
}

async function tickUntilSpoken(loop: ProactiveLoop): Promise<SpokenProactive | null> {
  for (let tick = 0; tick < 10; tick += 1) {
    const entry = await loop.tickOnce();
    if (entry !== null && entry.reasonCode === 'PASSED') {
      return { text: String(entry.text ?? ''), trigger: entry.trigger, initiativeKind: entry.initiativeKind, candidateId: entry.candidateId };
    }
    if (entry !== null) console.log(`  （tick ${tick + 1}：${entry.reasonCode}）`);
  }
  return null;
}

// --------------------------------------------------------------------------------------
// 场景 3：审批闭环（待批时不写业务数据，点头后执行冻结参数）
// --------------------------------------------------------------------------------------

async function scenarioApproval(): Promise<Record<string, unknown>> {
  console.log('\n=== 场景 3：审批闭环（配置声明需要确认 → 待批 → 点头执行冻结参数）===');
  const root = tempDir('xixi-p2-5-approval-');
  const base = loadConfig();
  const tool = writeToolName(base);
  const config = configWith(base, { tools: { approval: { ask: [tool], ttl_seconds: 300 } } });
  const store = openXixiStore({ dataDir: root });
  let runtime: XixiResidentRuntime | undefined;
  try {
    const frozen = { what: '给儿子打电话', when: '明天八点' };
    const regenerated = { what: '买牛奶', when: '后天九点' };
    // 「冻结」的判据不能写死一个日期（今天跑是 10-09，明天跑就是 10-10）：把两组参数各自解析一遍，
    // 断言落库的那一条等于**第一组**的解析结果、且不等于第二组的。
    const zone = base.identity.timezone ?? 'Asia/Shanghai';
    const resolvedAt = (when: string, now: Date): string => resolveReminderWhen(when, { now, timezone: zone }).dueAt;
    const t0 = new Date();
    console.log(`  tools.approval.ask = ['${tool}']（这个部署声明「写工具要先问一句」）`);

    runtime = createChatRuntime({
      config,
      store,
      mode: 'fake',
      log: () => {},
      onToolCall: (record) => console.log(`  [tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error ?? ''}`}`),
      model: ({ toolChain }) =>
        new FakeBrainAdapter({
          registry: toolChain,
          scope: CONVERSATION_SCOPE,
          toolPlan: (input, round) => {
            if (round !== 1) return [];
            if (input.text.includes('儿子')) return [{ name: tool, arguments: frozen }];
            if (input.text.includes('牛奶')) return [{ name: tool, arguments: regenerated }];
            return [];
          },
        }),
    });
    await runtime.start();
    const session = store.createSession();
    const rows = (): string[] => new ReminderStore(store).list().map((reminder) => reminder.what);

    // ① 用户提要求 → 模型发起 → 待批请求落库，业务数据一行都没有写。
    await runtime.conversation.respond({ sessionId: session.sessionId, text: '提醒我给儿子打个电话', addressed: true });
    const first = runtime.approvals.pending();
    check(first.length === 1, '用户提要求之后有**一条**待批请求（写工具没有直接跑）', first.map((row) => row.toolName));
    check(first[0]?.frozenArgs !== undefined && JSON.stringify(first[0].frozenArgs) === JSON.stringify(frozen), '待批请求里冻结的就是模型当时那组参数', first[0]?.frozenArgs);
    check(rows().length === 0, '没点头之前，业务数据一行都没写', rows());

    // ② 模型后来又生成一组**不同**的参数：只能变成另一条待批，不许顶替第一条。
    await runtime.conversation.respond({ sessionId: session.sessionId, text: '提醒我买牛奶', addressed: true });
    const both = runtime.approvals.pending();
    check(both.length === 2, '第二组参数是**另一条**待批请求（不是顶替）', both.map((row) => row.frozenArgs));
    check(rows().length === 0, '两条都还只是待批，业务数据仍是零行', rows());

    // ③ 点头第一条：执行的是**当时冻结**的那组，不是模型后来那组。
    const decision = await runtime.approvals.approve({ approvalId: first[0]!.approvalId, actorId: 'father' });
    check(decision.status === 'executed', '点头第一条：执行成功', decision.status);
    const landed = new ReminderStore(store).list();
    check(landed.length === 1 && landed[0]?.what === '给儿子打电话', '点头之后业务数据才落库，而且只写冻结的那一条', rows());
    // 允许请求跨过一秒：两次解析（请求前后各取一次「现在」）都算合法。
    const t1 = new Date();
    const expectedDue = new Set([resolvedAt(frozen.when, t0), resolvedAt(frozen.when, t1)]);
    const otherDue = new Set([resolvedAt(regenerated.when, t0), resolvedAt(regenerated.when, t1)]);
    check(landed[0]?.dueAt !== undefined && expectedDue.has(landed[0].dueAt), '落库的时刻是**第一组**冻结参数解析出来的', {
      landed: landed[0]?.dueAt,
      expected: [...expectedDue],
    });
    check(landed[0]?.dueAt !== undefined && !otherDue.has(landed[0].dueAt), '落库的时刻**不是**第二组参数（「后天九点」）的解析结果', {
      landed: landed[0]?.dueAt,
      regenerated: [...otherDue],
    });
    check(runtime.approvals.pending().length === 1, '第二条还在等谁点头', runtime.approvals.pending().map((row) => row.approvalId));
    check(rows().length === 1, '第二条没点头，业务数据不许因为「已经批过一条」而动', rows());

    const frozenRow = runtime.approvals.get(first[0]!.approvalId);
    return {
      scenario: 'approval',
      askDeclaration: [tool],
      pendingAfterRequest: 1,
      secondRequestIsAnotherPending: true,
      frozenArgs: frozen,
      regeneratedArgs: regenerated,
      decision: decision.status,
      landed: landed.map((row) => ({ what: row.what, dueAt: row.dueAt, status: row.status })),
      approvalRow: frozenRow === null ? null : { status: frozenRow.status, decidedBy: frozenRow.decidedBy, executedAt: frozenRow.executedAt },
    };
  } finally {
    if (runtime !== undefined) await runtime.stop().catch(() => undefined);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------------------
// 场景 4：插件关停（工具消失、连接关闭、提醒调度停止）
// --------------------------------------------------------------------------------------

async function scenarioShutdown(): Promise<Record<string, unknown>> {
  console.log('\n=== 场景 4：插件关停（控制台入口 close() → 工具消失 / 连接关闭 / 调度停止）===');
  const root = tempDir('xixi-p2-5-shutdown-');
  const lifecycleFile = join(root, 'probe-lifecycle.jsonl');
  const connectionFile = join(root, 'probe-connection.json');
  const note = (event: string): void => {
    appendFileSync(lifecycleFile, `${JSON.stringify({ event, at: new Date().toISOString(), pid: process.pid })}\n`);
  };
  const probeTool: AgentTool = {
    name: 'verify.probe',
    description: 'P2.5 验收用的只读探针工具',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    scopes: ['conversation'],
    async execute(): Promise<Record<string, unknown>> {
      return { ok: true, note: '探针被真的调用了' };
    },
  };
  const plugin: InlinePlugin = {
    manifest: {
      schemaVersion: 1,
      id: 'xixi.verify-probe',
      name: 'P2.5 验收探针',
      version: '0.1.0',
      permissions: ['tool.register'],
      capabilities: ['tool'],
    },
    module: {
      // 插件贡献的工具要包一层 `{ tool }`（`PluginToolSpec`）：内核按 `spec.tool.name` 校验，
      // 直接放一个 AgentTool 进去会被判成「tools 里有一项没有 tool.name」，于是挂载为 0。
      activate: (): { readonly tools: readonly { readonly tool: AgentTool }[] } => {
        note('activate');
        writeFileSync(connectionFile, JSON.stringify({ open: true, at: new Date().toISOString() }));
        return { tools: [{ tool: probeTool }] };
      },
      deactivate: (): void => {
        note('deactivate');
        // 与 MCP 适配器同一个形状：deactivate 断开连接但适配器仍可复用。
        writeFileSync(connectionFile, JSON.stringify({ open: false, reason: 'deactivate', at: new Date().toISOString() }));
      },
      dispose: (): void => {
        note('dispose');
        // 终止：生产里这里是 MCP transport 的 close()。内核的关停路径走的是这一步。
        writeFileSync(connectionFile, JSON.stringify({ open: false, reason: 'dispose', at: new Date().toISOString() }));
      },
    },
  };

  const handle = await createFieldServer({
    port: 0,
    offline: true,
    ttsEnabled: false,
    dataDir: root,
    presenceDataDir: root,
    autoPrune: false,
    plugins: { inline: [plugin] },
    log: () => {},
  });
  try {
    const visible = handle.runtime.toolChain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name);
    const mounted = [...handle.runtime.plugins.notes.mounted];
    check(
      visible.includes('verify.probe') && mounted.includes('verify.probe'),
      '关停前：探针插件工具在控制台入口的模型可见链上，而且是这次 start 挂上去的',
      { visible, mounted },
    );
    check(handle.runtime.state === 'started', '关停前：运行时处于 started', handle.runtime.state);

    // 提醒调度：写一条已经到点的（`scheduleAt` 是 sink 的「非工具入口」，入口/测试都能用它）。
    const scheduled = handle.runtime.reminderSink.scheduleAt({
      what: '该出门了',
      when: '尽快',
      now: new Date(Date.now() - 60 * 60 * 1000),
      identity: { sessionId: 'verify-p2-5' },
    });
    const reminderId = scheduled.change.reminder.id;
    const offeredBefore = handle.runtime.reminderSeams.readDueReminders().map((input) => input.reminderId);
    check(offeredBefore.includes(reminderId), '关停前：提醒调度能把到点的提醒交出来', offeredBefore);

    await handle.close();

    check(handle.runtime.state === 'stopped', '关停后：运行时是 stopped');
    const after = handle.runtime.toolChain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name);
    check(after.length === 0 && !after.includes('verify.probe'), '关停后：插件工具不再出现在模型可见列表里（链已清空）', after);

    const connection = existsSync(connectionFile) ? (JSON.parse(readFileSync(connectionFile, 'utf8')) as { open: boolean }) : null;
    const events = existsSync(lifecycleFile)
      ? readFileSync(lifecycleFile, 'utf8')
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line) => (JSON.parse(line) as { event: string }).event)
      : [];
    // 内核的**关停路径**是 `manager.disposeAll()`（`PluginRuntimeMount.shutdown` → `runtime.stop()`），
    // 它跑的是第 9 步 `dispose`；`deactivate` 是「停用但可复活」的第 8 步，关停不经过它
    // （复核命令：`git grep -n 'disposeAll\\|deactivate(' packages/plugins/src/manager.ts`）。
    // 所以这里断言 dispose 跑过、连接被关掉；deactivate 跑没跑如实记录，不写成断言。
    check(events.includes('dispose'), '关停后：插件的终止钩子 dispose 真的跑了（生产里 MCP 连接是在这里断开的）', events);
    check(connection?.open === false, '关停后：探针的连接标记被关掉（生产里这里是 MCP transport 的 close）', connection);

    let schedulingStopped = false;
    let schedulingError = '';
    try {
      handle.runtime.reminderSeams.readDueReminders();
    } catch (error) {
      schedulingStopped = true;
      schedulingError = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
    }
    check(schedulingStopped, '关停后：提醒调度不再跑（读接缝连不上已经关掉的库）', schedulingError);

    const reopened = openXixiStore({ dataDir: root });
    try {
      const row = new ReminderStore(reopened).get(reminderId);
      check(row !== null, '关停没有丢掉待办：重开库仍读得到那条提醒', reminderId);
    } finally {
      reopened.close();
    }

    return {
      scenario: 'shutdown',
      entry: 'scripts/field-test.ts createFieldServer',
      visibleBefore: visible,
      visibleAfter: after,
      lifecycle: events,
      deactivateRan: events.includes('deactivate'),
      connectionClosed: connection?.open === false,
      reminderId,
      reminderSurvivesStop: true,
      schedulingError,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------------------

async function spawnSelf(args: readonly string[]): Promise<{ readonly status: number | null; readonly pid: number | null; readonly out: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', (error) => resolve({ status: null, pid: child.pid ?? null, out: `${out}${String(error)}` }));
    child.on('close', (status) => resolve({ status, pid: child.pid ?? null, out }));
  });
}

interface Options {
  readonly scenario: ScenarioName | null;
  readonly phase: string | null;
  readonly state: string | null;
  readonly offline: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const scenario = argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length) ?? null;
  if (scenario !== null && !SCENARIOS.includes(scenario as ScenarioName)) {
    throw new Error(`不认识的场景：${scenario}（可选：${SCENARIOS.join(' / ')}）`);
  }
  return {
    scenario: scenario as ScenarioName | null,
    phase: argv.find((arg) => arg.startsWith('--phase='))?.slice('--phase='.length) ?? null,
    state: argv.find((arg) => arg.startsWith('--state='))?.slice('--state='.length) ?? null,
    offline: argv.includes('--offline'),
  };
}

const USAGE = `V0.3 P2.5 真入口验收

  node scripts/verify-p2.5.ts                 四个场景全跑（有 MIMO_API_KEY 时场景 1 会真调一次模型）
  node scripts/verify-p2.5.ts --scenario=news 只跑一个场景：${SCENARIOS.join(' / ')}
  node scripts/verify-p2.5.ts --offline       场景 1 强制走离线替身（不花 API 费用）`;

async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  // 内部阶段：跨重启的子进程只做「写」这一半。
  if (options.phase === 'reminder-write') {
    if (options.state === null) {
      console.error('--phase=reminder-write 需要 --state=<dir>');
      return 2;
    }
    return await reminderWritePhase(options.state);
  }

  const started = Date.now();
  console.log(`P2.5 真入口验收 —— 仓库 ${REPO_ROOT}`);
  console.log(`进程 pid=${process.pid}，密钥 ${hasMimoKey() ? '在' : '不在'}（场景 1 会 ${hasMimoKey() && !options.offline ? '走真实模型' : '走离线替身'}）`);

  const evidence: Record<string, unknown>[] = [];
  const want = (name: ScenarioName): boolean => options.scenario === null || options.scenario === name;
  /** 一个场景抛异常不该把其余三个藏起来：记成失败、继续跑下一个。 */
  const runScenario = async (name: ScenarioName, run: () => Promise<Record<string, unknown>>): Promise<void> => {
    if (!want(name)) return;
    try {
      evidence.push(await run());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`场景 ${name} 抛异常：${message}`);
      console.error(`场景 ${name} 抛异常：${error instanceof Error ? (error.stack ?? message) : message}`);
      evidence.push({ scenario: name, error: message });
    }
  };

  // 场景 1 会用 `.env` 里的密钥（入口脚本自己也是这么做的）；跑完还原环境。
  await runScenario('news', () => withDotEnv(() => scenarioNews(options.offline)));
  await runScenario('reminder', () => scenarioReminder());
  await runScenario('approval', () => scenarioApproval());
  await runScenario('shutdown', () => scenarioShutdown());

  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(evidence, null, 2));
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (failures.length > 0) {
    console.log(`\nP2.5 FAIL：${failures.length} 项断言没过（共 ${checks} 项，${seconds}s）`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    return 1;
  }
  console.log(`\nP2.5 OK：${checks} 项断言全过（${seconds}s）`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
