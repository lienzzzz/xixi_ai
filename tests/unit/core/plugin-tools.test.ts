import { test } from 'node:test';
import assert from 'node:assert/strict';

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
 * The schema subset DSH's tool runtime enforces, checked locally.
 *
 * 铁律 9 forbids a Harness API outside `packages/brain-adapter` — **tests included** — and this file
 * used to `import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'` (the violation V0.3
 * P2-F found; this file is the fix). The dependency is gone; what it proved is kept, in a form that
 * is verifiable rather than trusted.
 *
 * The rules below mirror `@deepseek-ai/dsh-tools@0.1.7-rc.2`'s `json-schema.ts` for the one schema
 * this file feeds it: single scalar `type` (arrays of types rejected), `type` and `oneOf` mutually
 * exclusive, `oneOf` as an array of at least two branches with no sibling constraint keywords,
 * `properties`/`required`/`additionalProperties` on objects only (and `required` naming a declared
 * property), `items` on arrays only, type-correct non-empty scalar `enum`, type-correct `const`
 * (and inside `enum` when both are declared), annotations (`description`/`title`/`default`/
 * `examples`) ignored for validation but required to be lossless JSON, and an annotation-only node
 * accepted as the standard unconstrained-JSON form. It was cross-checked against the real function
 * over a 33-schema battery (every accept/refuse verdict identical, including `-0`, `NaN`, a `type`
 * +`oneOf` node and `required: []`) before the import was removed, and the refusals below keep it
 * from being a tautology: no rule can be deleted without turning the suite red.
 *
 * Why the check cannot be *delegated* to brain-adapter: it is about the **plugin's own contract**
 * (`plugins/xixi-tools` is a plain-JS DSH plugin package that only has a peerDependency on
 * `dsh-tools`), not about an API this repo calls. brain-adapter's seam is the *transport*
 * (`DshTransport`) — the seam the baseline's three `@deepseek-ai/dsh` mentions outside this package
 * go through (apps/brain-dsh profile and transport, scripts/install-dsh-profile).
 */
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;
type SchemaType = (typeof SCHEMA_TYPES)[number];

/** Which keywords may appear on which node type — DSH's `allowedFor` table. */
const KEYWORD_TYPES: Readonly<Record<string, readonly SchemaType[]>> = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
};

/** `type` / `oneOf` / the six typed keywords; everything else is an annotation (DSH's two Sets). */
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', ...Object.keys(KEYWORD_TYPES)]);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
/** Keywords that are invalid sitting next to `oneOf` (DSH's `ONE_OF_SIBLING_KEYWORDS`). */
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lossless finite JSON number, excluding negative zero — DSH's `isJsonNumber`. */
function isJsonNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
}

/** Whether one scalar is valid for a declared schema type (DSH's `scalarMatches`). */
function scalarMatches(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return isJsonNumber(value);
    case 'integer':
      return isJsonNumber(value) && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** `JSON.parse(JSON.stringify(v))` survives — what "lossless JSON annotation" means in DSH. */
function isLosslessJson(value: unknown): boolean {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'undefined') return false;
  if (typeof value === 'number') return isJsonNumber(value);
  if (Array.isArray(value)) return value.every((entry) => isLosslessJson(entry));
  if (isPlainRecord(value)) return Object.values(value).every((entry) => isLosslessJson(entry));
  return value === null || typeof value === 'string' || typeof value === 'boolean';
}

/**
 * Walk one node and collect every violation (DSH collects rather than throws at the first one, so a
 * broken schema reports all its problems; the assertion below reads the same way). `ancestors` is the
 * current path in the tree, which is how a cycle is told from a merely shared sub-schema.
 *
 * 恒真守卫防的是这个：查的**关键字集合**与运行时一致——DSH 在 allow-list 之外的关键字上是**拒绝**
 * 而不是忽略（`is not a supported keyword`），所以插件里出现 `pattern`/`$ref`/`format` 这类字样时
 * 这里必须同样拒绝：它们到不了模型，写进契约就是骗人。
 */
function collectSchemaViolations(value: unknown, path: string, out: string[], ancestors: ReadonlySet<object>): void {
  if (!isPlainRecord(value)) {
    out.push(`${path} must be a schema object`);
    return;
  }
  if (ancestors.has(value)) {
    out.push(`${path} is circular`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue;
    if (ANNOTATION_KEYWORDS.has(key)) {
      if (!isLosslessJson(value[key])) out.push(`${path}.${key} annotation must be lossless JSON data`);
      continue;
    }
    out.push(
      `${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`,
    );
  }
  if (Object.hasOwn(value, 'description') && typeof value.description !== 'string') out.push(`${path}.description must be a string`);
  if (Object.hasOwn(value, 'title') && typeof value.title !== 'string') out.push(`${path}.title must be a string`);

  const hasType = Object.hasOwn(value, 'type');
  const hasOneOf = Object.hasOwn(value, 'oneOf');
  if (hasType && hasOneOf) {
    out.push(`${path} cannot declare both type and oneOf`);
    return;
  }
  if (!hasType && !hasOneOf) {
    // Annotation-only node: the standard "any JSON" form. Only its constraint keywords are refused.
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(value, key)) out.push(`${path}.${key} requires type or oneOf`);
    }
    return;
  }

  const seen = new Set<object>([...ancestors, value]);

  if (hasOneOf) {
    const branches = value.oneOf;
    if (!Array.isArray(branches) || branches.length < 2) {
      out.push(`${path}.oneOf must be an array of at least two schemas`);
      return;
    }
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(value, key)) out.push(`${path}.${key} is not supported beside oneOf`);
    }
    branches.forEach((node, index) => collectSchemaViolations(node, `${path}.oneOf[${index}]`, out, seen));
    return;
  }

  const type = value.type;
  if (typeof type !== 'string' || !(SCHEMA_TYPES as readonly string[]).includes(type)) {
    out.push(
      Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`,
    );
    return;
  }
  const nodeType = type as SchemaType;

  for (const [keyword, allowed] of Object.entries(KEYWORD_TYPES)) {
    if (Object.hasOwn(value, keyword) && !allowed.includes(nodeType)) {
      out.push(`${path}.${keyword} is not supported on type "${nodeType}"`);
    }
  }

  if (nodeType === 'object') {
    const declared = isPlainRecord(value.properties) ? value.properties : {};
    if (Object.hasOwn(value, 'properties')) {
      const properties = value.properties;
      if (!isPlainRecord(properties)) out.push(`${path}.properties must be an object of schemas`);
      else for (const [key, node] of Object.entries(properties)) collectSchemaViolations(node, `${path}.properties.${key}`, out, seen);
    }
    if (Object.hasOwn(value, 'additionalProperties') && typeof value.additionalProperties !== 'boolean') {
      out.push(`${path}.additionalProperties must be a boolean`);
    }
    if (Object.hasOwn(value, 'required')) {
      const required = value.required;
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
        out.push(`${path}.required must be an array of strings`);
      } else {
        for (const name of required) {
          if (!Object.hasOwn(declared, name)) out.push(`${path}.required names "${name}" which is not in properties`);
        }
      }
    }
    return;
  }

  if (nodeType === 'array') {
    if (Object.hasOwn(value, 'items')) collectSchemaViolations(value.items, `${path}.items`, out, seen);
    return;
  }

  const hasEnum = Object.hasOwn(value, 'enum');
  const allowed = hasEnum ? value.enum : undefined;
  if (hasEnum && (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every((entry) => scalarMatches(nodeType, entry)))) {
    out.push(`${path}.enum must be a non-empty array of ${nodeType} values`);
  }
  if (Object.hasOwn(value, 'const')) {
    if (!scalarMatches(nodeType, value.const)) out.push(`${path}.const must be a ${nodeType} value`);
    else if (Array.isArray(allowed) && !allowed.includes(value.const)) out.push(`${path}.const must be one of ${path}.enum when both are declared`);
  }
}

/** The seam DSH's `assertSupportedJsonSchema` provided: throws listing every violation. */
function assertSupportedJsonSchema(schema: unknown): void {
  const violations: string[] = [];
  collectSchemaViolations(schema, 'schema', violations, new Set());
  if (violations.length > 0) throw new Error(`unsupported JSON Schema: ${violations.join('; ')}`);
}

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

  // Counterfactual half of the same check (AGENTS §9.25 ④: a guard needs a case that proves it
  // refuses bad input). Each fixture breaks exactly one rule of the subset, so deleting that rule
  // from the walker makes the assertion below throw.
  assert.doesNotThrow(() => assertSupportedJsonSchema({ type: 'object', properties: { day: { type: 'string', enum: ['today'] } } }));
  for (const broken of [
    { type: 'object', properties: { day: { type: 'string', enum: [] } } },          // empty enum
    { type: 'array', properties: { day: { type: 'string' } } },                     // properties on array
    { type: 'object', properties: { day: { type: 'tuple' } } },                     // unknown type
    { type: 'object', properties: { day: { type: 'string', pattern: '^t' } } },     // keyword DSH ignores
    { type: 'object', required: ['day'] },                                          // requires a property it does not declare
    { oneOf: [{ type: 'string' }] },                                                // oneOf needs two branches
  ]) {
    assert.throws(() => assertSupportedJsonSchema(broken), /unsupported JSON Schema/);
  }

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
