/**
 * Diagnose the realtime tool path: does the model request `xixi_get_weather`,
 * and does the adapter execute it? Prints the raw decision for each variant.
 *
 * Pack Phase 2: the diagnostic now builds the same `ToolRegistry` the entry points use,
 * so it also shows what the model is actually offered (the built-ins, the scope
 * filter, and the round cap) before any call is made.
 *
 * V0.3 P2-D adds two offline-capable news probes, because news is a **plugin** now and its
 * evidence has to be reproducible without a key:
 *
 * ```powershell
 * node scripts/probe-tools.ts --news            # 离线桩：生命周期 → 模型可见 → 真的一次调用，零网络
 * node scripts/probe-tools.ts --news-live       # 真实 RSS 来源（默认一个公开 feed，可换成 --news-live <url>）
 * ```
 *
 * `--news` needs no key and no network (it fails loudly if it ever reaches for the network);
 * `--news-live` is the manual check AGENTS §2 asks for. Without a flag this file behaves exactly as
 * before: it talks to the real model.
 */
import { MimoBrainAdapter, ToolPermission, collectTurn, createToolRegistry } from '@xixi/brain-adapter';
import { MimoClient } from '@xixi/model-adapters';
import { buildPluginRuntime } from '@xixi/runtime';
import { createRssNewsSource, createStubNewsSource, stubItem } from '@xixi/plugins/news';

import { readDotEnv } from './lib/harness.ts';

for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const argv = process.argv.slice(2);
if (argv.includes('--news') || argv.some((entry) => entry.startsWith('--news-live'))) {
  process.exit(await probeNews(argv));
}

const client = new MimoClient();
const registry = createToolRegistry({ defaultPlace: '成都', onToolCall: (record) => console.log(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}`) });
/**
 * The news half. Two modes, one assembly point (`buildPluginRuntime`) — the same one the live
 * entries would use, so what this prints is what a deployment would get.
 */
async function probeNews(args: readonly string[]): Promise<number> {
  const liveIndex = args.findIndex((entry) => entry.startsWith('--news-live'));
  const live = liveIndex >= 0;
  const explicitUrl = args[liveIndex + 1] !== undefined && !args[liveIndex + 1]!.startsWith('--') ? args[liveIndex + 1]! : undefined;
  const url = explicitUrl ?? 'https://feeds.bbci.co.uk/news/world/rss.xml';
  const now = new Date();
  const fetched: string[] = [];

  // Offline mode hands the plugin a fetch that throws: if anything reached for the network, the run
  // would fail here instead of quietly working. Live mode counts every request it really makes.
  const fetchImpl = live
    ? ((async (input: string | URL | Request, init?: RequestInit) => {
        fetched.push(String(input));
        return fetch(input, init);
      }) as unknown as typeof fetch)
    : ((async (input: string | URL | Request) => {
        fetched.push(String(input));
        throw new Error('--news 是离线探针：不该联网');
      }) as unknown as typeof fetch);

  const runtime = buildPluginRuntime(
    {
      identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: '成都' },
      models: { llm: { provider: 'mimo', model: 'm', thinking_realtime: false }, asr: { provider: 'mimo', model: 'a' }, tts: { provider: 'mimo', model: 't' } },
      personality: { base: {} },
      proactive: {},
      memory: {},
      privacy: {},
      features: {},
    },
    {
      now: () => now,
      fetchImpl,
      news: live
        ? {
            now: () => now,
            interests: ['China', 'US', 'weather', 'Ukraine', 'Gaza'],
            // The factory form: the real source is built from the **granted** fetch (`ctx.network`),
            // which is what makes the manifest's `network` permission load-bearing rather than decorative.
            sources: [(env) => createRssNewsSource({ name: 'BBC World', url, fetchImpl: env.fetchImpl, now: () => now })],
          }
        : {
            now: () => now,
            interests: ['茶'],
            sources: [
              createStubNewsSource({
                name: '离线桩',
                now: () => now,
                items: [
                  stubItem({ id: 'probe-1', title: '成都茶博会本周开幕', source: '离线桩', publishedAt: new Date(now.getTime() - 90 * 60_000).toISOString() }),
                  stubItem({ id: 'probe-2', title: '社区书法班新开课', source: '离线桩', publishedAt: new Date(now.getTime() - 30 * 60_000).toISOString() }),
                ],
              }),
            ],
          },
    },
  );

  try {
    const instances = await runtime.start();
    const news = runtime.news;
    const state = news?.state();
    console.log(
      JSON.stringify(
        {
          mode: live ? 'live' : 'offline',
          lifecycle: instances.map((instance) => ({ id: instance.pluginId, state: instance.state, capabilities: instance.capabilities, health: instance.health?.status })),
          journal: news === undefined ? [] : runtime.runtime.manager.steps('xixi.news'),
          sources: state?.sources ?? [],
          mounted: runtime.notes.mounted,
          refused: runtime.notes.refused,
        },
        null,
        1,
      ),
    );

    // Proposing is not mentioning: ask for candidates **before** the tool call, then again after it.
    // The second answer can only be about headlines that were *not* just returned — what was put in
    // front of the model is recorded in the ledger, so it is not offered as a topic a moment later
    // (the items further down the feed are still fair game, which is why this is a filter and not
    // an emptiness check).
    const proposedBefore = await (state?.topicSource.propose({ now, timezone: 'Asia/Shanghai', limit: 3 }) ?? Promise.resolve([]));
    console.log(JSON.stringify({ topicCandidatesBeforeToolCall: proposedBefore }, null, 1));

    const execution = await runtime.registry.execute(
      // A feed cannot search, so the live probe takes the headline path; `news.search` needs a
      // search-capable source (the offline stub, the JSON API, or a web-search adapter).
      { name: 'news.latest', arguments: JSON.stringify(live ? { limit: 3 } : { limit: 3 }) },
      { scope: 'conversation', timezone: 'Asia/Shanghai', now },
    );
    const payload = execution.record.result ?? {};
    const items = Array.isArray(payload['items']) ? (payload['items'] as Record<string, unknown>[]) : [];
    console.log(
      JSON.stringify(
        {
          tool: 'news.latest',
          ok: execution.record.ok,
          error: execution.record.error,
          untrusted: payload['untrusted'],
          flags: items.map((item) => item['flags'] ?? []),
          titles: items.map((item) => item['title']),
          publishedAt: items.map((item) => item['publishedAt'] ?? null),
          digestChars: (Array.isArray(payload['digest']) ? (payload['digest'] as Record<string, unknown>[]) : []).map((entry) => entry['digestChars']),
          problems: payload['problems'],
          // Counted after the call: offline this must stay 0, live this is how many URLs were asked for.
          networkCalls: fetched.length,
          networkUrls: fetched,
        },
        null,
        1,
      ),
    );

    const proposedAfter = await (state?.topicSource.propose({ now, timezone: 'Asia/Shanghai', limit: 3 }) ?? Promise.resolve([]));
    console.log(JSON.stringify({ topicCandidatesAfterToolCall: proposedAfter }, null, 1));
    if (live && items.length === 0) {
      console.error('真实来源这一趟没有取到条目：上面的 problems 就是原因（不要把它当成“今天没新闻”）。');
      return 1;
    }
    return 0;
  } finally {
    await runtime.shutdown();
  }
}

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
