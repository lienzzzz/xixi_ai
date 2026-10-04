import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCurrentTimeTool,
  createMemoryReminderSink,
  createReminderTool,
  createWeatherTool,
  defaultTools,
  type AgentTool,
} from '@xixi/brain-adapter';
import { describeWeatherCode, WeatherClient } from '@xixi/model-adapters';

const CONTEXT = { timezone: 'Asia/Shanghai', now: new Date('2026-09-30T08:00:00+08:00') };

/** A stubbed fetch that records the URLs it was asked for. */
function stubFetch(payloads: Record<string, unknown>): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const key = url.includes('geocoding') ? 'geocode' : 'forecast';
    return {
      ok: true,
      status: 200,
      json: async () => payloads[key],
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const GEOCODE = { results: [{ name: '成都', latitude: 30.66, longitude: 104.06, timezone: 'Asia/Shanghai', admin1: '四川省' }] };
const FORECAST = {
  timezone: 'Asia/Shanghai',
  daily: {
    time: ['2026-09-30', '2026-10-01', '2026-10-02'],
    weather_code: [61, 3, 0],
    temperature_2m_max: [24.4, 25.1, 27.8],
    temperature_2m_min: [18.2, 19.0, 20.1],
    precipitation_probability_max: [80, 8, 0],
  },
};

test('weather codes become Chinese a person would actually say', () => {
  assert.equal(describeWeatherCode(61), '小雨');
  assert.equal(describeWeatherCode(0), '晴');
  assert.equal(describeWeatherCode(999), '未知天气(999)');
});

test('the weather tool asks for the default place and returns a compact day', async () => {
  const stub = stubFetch({ geocode: GEOCODE, forecast: FORECAST });
  const tool = createWeatherTool({ client: new WeatherClient({ fetchImpl: stub.fetchImpl }), defaultPlace: '成都' });
  const result = await tool.execute({ day: 'tomorrow' }, CONTEXT);

  assert.equal(result.place, '成都 四川省');
  assert.equal(result.day, '明天');
  assert.equal(result.summary, '阴');
  assert.equal(result.temperatureMaxC, 25);
  assert.equal(result.temperatureMinC, 19);
  assert.equal(result.precipitationChance, 8);
  assert.equal(result.advice, null, 'a dry day must not produce umbrella advice');
  assert.ok(stub.urls[0]?.includes('geocoding'));
  assert.ok(stub.urls[1]?.includes('forecast'));
});

test('a rainy day carries umbrella advice, and the place argument wins over the default', async () => {
  const stub = stubFetch({ geocode: GEOCODE, forecast: FORECAST });
  const tool = createWeatherTool({ client: new WeatherClient({ fetchImpl: stub.fetchImpl }), defaultPlace: '成都' });
  const result = await tool.execute({ place: '绵阳', day: 'today' }, CONTEXT);
  assert.equal(result.day, '今天');
  assert.equal(result.summary, '小雨');
  assert.equal(result.precipitationChance, 80);
  assert.equal(result.advice, '可能下雨，建议带伞');
  assert.ok(decodeURIComponent(stub.urls[0] ?? '').includes('绵阳'));
});

test('an unknown place is a typed refusal, not a crash', async () => {
  const stub = stubFetch({ geocode: { results: [] }, forecast: FORECAST });
  const tool = createWeatherTool({ client: new WeatherClient({ fetchImpl: stub.fetchImpl }), defaultPlace: '不存在的地方' });
  await assert.rejects(
    () => tool.execute({}, CONTEXT),
    (error: unknown) => error instanceof Error && error.message.includes('unknown place'),
  );
});

test('the forecast is cached so a household does not hammer the upstream service', async () => {
  const stub = stubFetch({ geocode: GEOCODE, forecast: FORECAST });
  const client = new WeatherClient({ fetchImpl: stub.fetchImpl });
  await client.report('成都');
  await client.report('成都');
  assert.equal(stub.urls.length, 2, 'second lookup must be served from cache');
});

test('the current-time tool answers with local date and weekday', async () => {
  const tool = createCurrentTimeTool(() => new Date('2026-09-30T08:00:00+08:00'));
  const result = await tool.execute({}, CONTEXT);
  assert.equal(result.weekday, '星期三');
  assert.ok(String(result.localDate).includes('2026'));
});

test('the built-in set is the three Phase 2 tools, and each carries its risk', () => {
  const tools: AgentTool[] = defaultTools({ defaultPlace: '成都' });
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['xixi_get_current_time', 'xixi_get_weather', 'xixi_set_reminder_stub'],
  );
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false, 'tools must not accept undeclared arguments');
    assert.ok(tool.scopes.length > 0, `${tool.name} must declare which surfaces it belongs to`);
  }
  // The one write tool is a *stub* and declares itself as such: the registry narrows it
  // (resident, conversation only). Nothing dangerous exists in the PoC (§19.2, 铁律 7).
  assert.equal(tools.find((tool) => tool.name === 'xixi_set_reminder_stub')?.risk, 'write');
  assert.ok(tools.filter((tool) => tool.risk === 'read').length >= 2, 'the rest are read-only');
  assert.ok(!tools.some((tool) => tool.risk === 'dangerous'));
  assert.ok(!tools.some((tool) => /delete|control|unlock|pay/i.test(tool.name)));
});

/**
 * V0.3 P2-D: news left this package entirely.
 *
 * The old placeholder was a core tool named `xixi_news_stub`; the real thing is a plugin
 * (`@xixi/plugins/news`) whose three tools live in the plugin namespace, so the `xixi_` prefix is
 * the core's own again. Two halves of that are checked here — the built-in set has no news tool, and
 * the module has no news factory to reach for (a type-level import of a deleted export would not
 * even compile). The behaviour of the three tools is pinned in `tests/unit/core/tool-loop.test.ts`,
 * where they are brought up through the real plugin lifecycle.
 */
test('no core tool carries a news seam any more (P2-D moved it into a plugin)', () => {
  const names = defaultTools({ defaultPlace: '成都' }).map((tool) => tool.name);
  assert.ok(!names.some((name) => name.includes('news')), `内置工具里不该再有新闻：${names.join('、')}`);
  assert.ok(!names.includes('xixi_news_stub'), 'P2-D 删掉了这个命名');
});

test('the reminder stub records what it was told and still declares a write risk', async () => {
  const sink = createMemoryReminderSink();
  const tool = createReminderTool({ sink });
  const result = await tool.execute({ what: '吃药', when: '晚上七点' }, CONTEXT);
  assert.equal(result.registered, true);
  assert.equal(sink.reminders.length, 1);
  assert.equal(sink.reminders[0]?.what, '吃药');
  assert.equal(sink.reminders[0]?.when, '晚上七点');
  // Nothing to remind about is a refusal, not an empty reminder row.
  const empty = await tool.execute({ what: '  ' }, CONTEXT);
  assert.equal(empty.registered, false);
  assert.equal(sink.reminders.length, 1);
});
