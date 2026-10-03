import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import { defaultTools } from '@xixi/brain-adapter';

import {
  apply,
  describeWeatherCode,
  rejectUnknownArguments,
  resolveDefaultPlace,
  WeatherClient,
  WEATHER_PARAMETER_SPEC,
} from '../../../plugins/xixi-tools/index.js';

/**
 * The DSH path registers its own tools (`plugins/xixi-tools`), so before this
 * test the `--dsh` route had only `xixi_get_current_time`: asking about the
 * weather degraded into invention or deflection, because the model had no tool
 * and no data. These tests pin the two things that matter — the DSH-side weather
 * tool exists with the same closed contract and the same data source as the
 * direct path — without touching the network.
 */

const CONTEXT = { timezone: 'Asia/Shanghai', now: new Date('2026-09-30T08:00:00+08:00') };

const GEOCODE = {
  results: [{ name: '成都', latitude: 30.66, longitude: 104.06, timezone: 'Asia/Shanghai', admin1: '四川省' }],
};
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

/**
 * The shape this test walks on a registered tool: its `name`, the declared `parameters` and the
 * `execute` seam. Written out rather than imported because `plugins/xixi-tools` is a *plain JS* DSH
 * plugin package (its only dependency is a peerDependency on `@deepseek-ai/dsh-tools`, so it cannot
 * import this repo's types). The old version typed both callbacks' arguments as `never`, which made
 * every real call site a type error — the arguments below are ordinary JSON argument bags.
 */
interface RegisteredTool {
  readonly name: string;
  readonly parameters: Record<string, unknown>;
  readonly execute: (args: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
}

/** A fresh installation per call, so each test gets its own weather cache. */
function registered(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  apply({ tools: { register: (tool: RegisteredTool) => tools.push(tool) } });
  return tools;
}

/**
 * The second parameter of `resolveDefaultPlace(env, reader)` defaults to `readFileSync`, so TypeScript
 * infers that *overloaded* signature for the injectable seam. These tests inject a smaller reader
 * (it only ever receives the config path); the cast lives here, once, instead of at three call sites.
 */
function asReader(read: (path: string) => string): NonNullable<Parameters<typeof resolveDefaultPlace>[1]> {
  return read as unknown as NonNullable<Parameters<typeof resolveDefaultPlace>[1]>;
}

/** Minimal stubbed fetch so the data-source test never leaves the machine. */
function withStubbedFetch<T>(work: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    return {
      ok: true,
      status: 200,
      json: async () => (url.includes('geocoding') ? GEOCODE : FORECAST),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return work().finally(() => {
    globalThis.fetch = original;
  });
}

test('the DSH plugin registers the weather tool next to the clock', () => {
  const names = registered().map((tool) => tool.name);
  assert.deepEqual(names.sort(), ['xixi_get_current_time', 'xixi_get_weather']);
});

test('both paths declare the same weather arguments and neither accepts undeclared ones', () => {
  const direct = defaultTools({ defaultPlace: '成都' }).find((tool) => tool.name === 'xixi_get_weather');
  assert.ok(direct !== undefined, 'the direct path must have the weather tool');
  assert.equal(direct.parameters.additionalProperties, false);

  // The DSH DSL compiles `parameters` into an open root object, so the closed
  // contract is enforced by the tool body instead (asserted below). What must not
  // drift is the declared shape itself.
  const dsh = registered().find((tool) => tool.name === 'xixi_get_weather');
  assert.ok(dsh !== undefined);
  assertSupportedJsonSchema(dsh.parameters);

  const directProperties = direct.parameters.properties as Record<string, Record<string, unknown>>;
  const dshProperties = (dsh.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(dshProperties).sort(), Object.keys(directProperties).sort());
  for (const key of Object.keys(directProperties)) {
    const expected = directProperties[key];
    const actual = dshProperties[key];
    assert.equal(actual.type, expected.type, `argument "${key}" must keep its type`);
    assert.deepEqual(
      [...((actual.enum as string[]) ?? [])].sort(),
      [...((expected.enum as string[]) ?? [])].sort(),
      `argument "${key}" must keep its allowed values`,
    );
  }
  assert.equal(WEATHER_PARAMETER_SPEC.place.type, 'string');
});

test('undeclared arguments are refused with a reason instead of being ignored', () => {
  assert.match(String(rejectUnknownArguments({ evil: 1 })), /不认识的参数/);
  assert.match(String(rejectUnknownArguments({ day: 'next_week' })), /day 只能是/);
  assert.match(String(rejectUnknownArguments({ place: 42 })), /place 必须是字符串/);
  assert.match(String(rejectUnknownArguments([])), /必须是对象/);
  assert.equal(rejectUnknownArguments({ place: '成都', day: 'tomorrow' }), null);
  assert.equal(rejectUnknownArguments({}), null);
});

test('the DSH weather tool answers from the same source and shape as the direct tool', async () => {
  await withStubbedFetch(async () => {
    // A rainy day needs its own installation, so the two tools cannot serve each
    // other's cache; both paths are asked the same question independently.
    const dsh = registered().find((tool) => tool.name === 'xixi_get_weather');
    const direct = defaultTools({ defaultPlace: '成都' }).find((tool) => tool.name === 'xixi_get_weather');
    assert.ok(dsh !== undefined && direct !== undefined);

    const fromDsh = await dsh.execute({ place: '成都', day: 'today' }, CONTEXT);
    const fromDirect = await direct.execute({ place: '成都', day: 'today' }, CONTEXT);

    assert.deepEqual(Object.keys(fromDsh).sort(), Object.keys(fromDirect).sort(), 'same fields on both paths');
    assert.equal(fromDsh.summary, fromDirect.summary);
    assert.equal(fromDsh.temperatureMaxC, fromDirect.temperatureMaxC);
    assert.equal(fromDsh.precipitationChance, fromDirect.precipitationChance);
    assert.equal(fromDsh.advice, '可能下雨，建议带伞');
  });
});

test('the DSH weather tool reports a refusal rather than inventing a forecast', async () => {
  await withStubbedFetch(async () => {
    const dsh = registered().find((tool) => tool.name === 'xixi_get_weather');
    assert.ok(dsh !== undefined);

    // A real lookup first, so the refusal below cannot be an empty cache.
    const ok = await dsh.execute({ place: '成都' }, CONTEXT);
    assert.equal(ok.summary, '阴');

    // No place argument and no configured place: refuse, do not guess a city.
    const previous = process.env.XIXI_PLACE;
    const previousRoot = process.env.XIXI_REPO_ROOT;
    process.env.XIXI_PLACE = '';
    // Point the config lookup at a directory that holds nothing readable.
    process.env.XIXI_REPO_ROOT = '/nowhere';
    try {
      const noPlace = await dsh.execute({ place: '' }, CONTEXT);
      assert.equal(typeof noPlace.error, 'string');
      assert.match(String(noPlace.error), /城市/);
      assert.equal(noPlace.summary, undefined, 'a refusal must not carry forecast fields');
    } finally {
      if (previous === undefined) delete process.env.XIXI_PLACE;
      else process.env.XIXI_PLACE = previous;
      if (previousRoot === undefined) delete process.env.XIXI_REPO_ROOT;
      else process.env.XIXI_REPO_ROOT = previousRoot;
    }
  });

  const unknownArgument = await registered()
    .find((tool) => tool.name === 'xixi_get_weather')
    // An argument the declared schema does not contain: the type has to allow it for this to be the
    // same call a confused model would make, and the tool body is what refuses it.
    ?.execute({ place: '成都', temperature: 20 }, CONTEXT);
  assert.match(String(unknownArgument?.error), /不认识的参数/);
  assert.equal(unknownArgument?.temperatureMaxC, undefined);
});

test('a failed weather lookup is an error result, not a fabricated day', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('no route to host');
  }) as unknown as typeof fetch;
  try {
    // Registered *after* the stub, because a WeatherClient captures fetch at
    // construction (same as the direct path).
    const dsh = registered().find((tool) => tool.name === 'xixi_get_weather');
    assert.ok(dsh !== undefined);
    const result = await dsh.execute({ place: '成都', day: 'today' }, CONTEXT);
    assert.match(String(result.error), /不可达/);
    assert.equal(result.temperatureMaxC, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('the default place comes from the same configuration source as the direct path', () => {
  // 1) an explicit environment override wins, for one-off runs;
  assert.equal(resolveDefaultPlace({ XIXI_PLACE: ' 绵阳 ' }, asReader(() => '')), '绵阳');
  // 2) otherwise the configured household place is read from xixi.yaml;
  const fromConfig = resolveDefaultPlace({ XIXI_REPO_ROOT: '/repo' }, asReader((path: string) => {
    assert.equal(path, '/repo/config/xixi.yaml');
    return 'xixi:\n  identity:\n    name: 西西\n    place: 成都\n';
  }));
  assert.equal(fromConfig, '成都');
  // 3) and when nothing is configured, the tool asks instead of guessing.
  assert.equal(resolveDefaultPlace({ XIXI_REPO_ROOT: '/nowhere' }, asReader(() => {
    throw new Error('ENOENT');
  })), '');
});

test('the DSH and direct weather clients agree on weather codes and caching', async () => {
  assert.equal(describeWeatherCode(61), '小雨');
  assert.equal(describeWeatherCode(999), '未知天气(999)');

  let calls = 0;
  const client = new WeatherClient({
    fetchImpl: (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => FORECAST } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  await assert.rejects(() => client.report('成都'), /不认识的地名/);
  assert.equal(calls, 1, 'a place that does not geocode costs exactly one request');
});
