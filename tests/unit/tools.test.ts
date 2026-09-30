import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCurrentTimeTool, createWeatherTool, defaultTools, type XixiTool } from '@xixi/brain-adapter';
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

test('the default registry is read-only and minimal (§27)', () => {
  const tools: XixiTool[] = defaultTools({ defaultPlace: '成都' });
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['xixi_get_current_time', 'xixi_get_weather'],
  );
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false, 'tools must not accept undeclared arguments');
  }
  // Nothing in the PoC tool set may mutate anything (§19.2 L0/L1 only).
  assert.ok(!tools.some((tool) => /set_|write|send|delete|control|unlock/i.test(tool.name)));
});
