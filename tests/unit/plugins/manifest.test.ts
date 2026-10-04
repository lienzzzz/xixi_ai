import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_PERMISSIONS,
  FORBIDDEN_PERMISSIONS,
  parseManifest,
  PLUGIN_CAPABILITIES,
  PLUGIN_MANIFEST_SCHEMA_V1,
  PLUGIN_MANIFEST_SCHEMA_VERSIONS,
  PLUGIN_PERMISSIONS,
  validateManifest,
  type PluginManifest,
} from '@xixi/plugins';

/**
 * Pack `03_AGENT_PLUGIN.md` §2 — the manifest, and nothing but the manifest.
 *
 * The shape is asserted twice on purpose: once against the pack's field list (four required, four
 * optional) and once against the JSON Schema this package publishes, so a reader who only has the
 * schema and a reader who only has the validator reach the same conclusion.
 */

/** The pack's example manifest, verbatim (§2). */
const PACK_EXAMPLE = {
  schemaVersion: 1,
  id: 'xixi.news',
  name: 'News',
  version: '0.1.0',
  entry: './dist/index.js',
  permissions: ['network'],
  capabilities: ['tool', 'topic_source'],
} as const;

const REQUIRED_FIELDS = ['schemaVersion', 'id', 'name', 'version'] as const;
const OPTIONAL_FIELDS = ['entry', 'permissions', 'capabilities', 'health'] as const;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, id: 'xixi.demo', name: 'Demo', version: '0.1.0', ...overrides };
}

test('the pack §2 example validates, and the four required fields are exactly required', () => {
  const parsed: PluginManifest = validateManifest(PACK_EXAMPLE);
  assert.equal(parsed.id, 'xixi.news');
  assert.equal(parsed.version, '0.1.0');
  assert.deepEqual(parsed.capabilities, ['tool', 'topic_source']);

  for (const field of REQUIRED_FIELDS) {
    const withoutField = { ...PACK_EXAMPLE } as Record<string, unknown>;
    delete withoutField[field];
    assert.throws(
      () => validateManifest(withoutField),
      (error: unknown) => error instanceof Error && error.message.includes(field),
      `少了必填字段 ${field} 必须被拒`,
    );
  }

  // Every optional field is genuinely optional: the four required ones alone are a valid manifest.
  const minimal = validateManifest(manifest());
  assert.equal(minimal.id, 'xixi.demo');
  assert.equal(minimal.entry, undefined);
  assert.equal(minimal.permissions, undefined);
  assert.equal(minimal.capabilities, undefined);
  assert.equal(minimal.health, undefined);
});

test('the four optional fields are accepted in the shape pack §2 gives them', () => {
  const parsed = validateManifest({
    schemaVersion: 1,
    id: 'xixi.news',
    name: 'News',
    version: '0.1.0',
    entry: './dist/index.js',
    permissions: ['network', 'topic.read'],
    capabilities: ['tool', 'topic_source'],
    health: { requires: ['tool:news.latest'], intervalMs: 30_000 },
  });
  assert.equal(parsed.entry, './dist/index.js');
  assert.deepEqual(parsed.permissions, ['network', 'topic.read']);
  assert.deepEqual(parsed.capabilities, ['tool', 'topic_source']);
  assert.deepEqual(parsed.health, { requires: ['tool:news.latest'], intervalMs: 30_000 });

  // The published schema and the validator agree on which fields exist at the top level.
  const properties = Object.keys((PLUGIN_MANIFEST_SCHEMA_V1['properties'] ?? {}) as Record<string, unknown>);
  for (const field of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    assert.ok(properties.includes(field), `schema 里应当有 ${field}`);
  }
  assert.deepEqual(
    (PLUGIN_MANIFEST_SCHEMA_V1['required'] ?? []) as readonly string[],
    [...REQUIRED_FIELDS],
    'schema 的 required 就是 pack 的四个必填字段',
  );
  assert.deepEqual(
    ((PLUGIN_MANIFEST_SCHEMA_V1['properties'] as Record<string, { enum?: readonly unknown[] }>)['schemaVersion']?.enum ?? []) as readonly unknown[],
    [...PLUGIN_MANIFEST_SCHEMA_VERSIONS],
  );
});

test('capabilities are the five V0.3 kinds and nothing else', () => {
  assert.deepEqual([...PLUGIN_CAPABILITIES], ['tool', 'topic_source', 'context_provider', 'sensor_source', 'action']);

  // Each of the five is accepted…
  for (const capability of PLUGIN_CAPABILITIES) {
    const parsed = validateManifest(manifest({ capabilities: [capability] }));
    assert.deepEqual(parsed.capabilities, [capability], `${capability} 必须被接受`);
    assert.ok(CAPABILITY_PERMISSIONS[capability].length > 0, `${capability} 必须说明它需要什么权限`);
  }

  // …and a sixth is refused, with the five listed so a plugin author can fix it.
  assert.throws(
    () => validateManifest(manifest({ capabilities: ['tool', 'sensor_bus'] })),
    (error: unknown) => error instanceof Error && error.message.includes('sensor_bus') && error.message.includes('五种能力'),
  );
  assert.throws(() => validateManifest(manifest({ capabilities: 'tool' })), /capabilities 必须是数组/);
});

test('the permission vocabulary is closeable, and the raw-media / database tokens are refused by name', () => {
  for (const permission of PLUGIN_PERMISSIONS) {
    assert.equal(validateManifest(manifest({ permissions: [permission] })).permissions?.[0], permission);
  }

  // The boundary tokens are refused with the *boundary* named, not merely "unknown".
  for (const [token, spec] of Object.entries(FORBIDDEN_PERMISSIONS)) {
    assert.throws(
      () => validateManifest(manifest({ permissions: [token] })),
      (error: unknown) => error instanceof Error && error.message.includes(spec.boundary),
      `${token} 必须按边界 ${spec.boundary} 被拒`,
    );
  }
  assert.throws(() => validateManifest(manifest({ permissions: ['camera'] })), /raw-camera-mic/);
  assert.throws(() => validateManifest(manifest({ permissions: ['sqlite'] })), /sqlite-handle/);
  assert.throws(() => validateManifest(manifest({ permissions: ['system_prompt.write'] })), /core-system-prompt/);
  assert.throws(() => validateManifest(manifest({ permissions: ['tool.permission'] })), /tool-permission/);

  // An unknown token that is not a boundary is still refused (the list is an allow-list).
  assert.throws(() => validateManifest(manifest({ permissions: ['teleport'] })), /不在权限表里/);
});

test('a plugin that asks for more than it declares is refused before anything loads', () => {
  assert.throws(
    () => validateManifest(manifest({ permissions: ['network'], requiredPermissions: ['network', 'storage'] })),
    (error: unknown) => error instanceof Error && error.message.includes('storage') && error.message.includes('没有在 permissions 里声明'),
  );
  // Declared and required agree → fine.
  const parsed = validateManifest(manifest({ permissions: ['network'], requiredPermissions: ['network'] }));
  assert.deepEqual(parsed.requiredPermissions, ['network']);
});

test('the scalar fields are type-checked, and one broken field is one named refusal', () => {
  assert.throws(() => validateManifest(manifest({ schemaVersion: 2 })), /不支持版本 2/);
  assert.throws(() => validateManifest(manifest({ schemaVersion: '1' })), /schemaVersion 必须是整数/);
  assert.throws(() => validateManifest(manifest({ id: 'News' })), /不合规/);
  assert.throws(() => validateManifest(manifest({ id: '' })), /id 不能是空串/);
  assert.throws(() => validateManifest(manifest({ name: 7 })), /name 必须是字符串/);
  assert.throws(() => validateManifest(manifest({ version: 'v1' })), /不是 x\.y\.z 形式/);
  assert.throws(() => validateManifest(manifest({ entry: '' })), /entry 不能是空串/);
  assert.throws(() => validateManifest(manifest({ health: { intervalMs: 0 } })), /health\.intervalMs 必须是正整数毫秒数/);
  assert.throws(() => validateManifest(manifest({ health: { every: 5 } })), /health\.every 不是已知字段/);
  assert.throws(() => validateManifest('not an object'), /manifest 必须是一个 JSON 对象/);
  assert.throws(() => validateManifest([]), /manifest 必须是一个 JSON 对象/);
});

test('parseManifest reads text and reports invalid JSON as a manifest refusal', () => {
  const parsed = parseManifest(JSON.stringify(PACK_EXAMPLE), 'plugin.json');
  assert.equal(parsed.id, 'xixi.news');
  assert.throws(() => parseManifest('{not json', 'plugin.json'), /plugin\.json 不是合法 JSON/);
  assert.throws(() => parseManifest('{"id":"x"}', 'plugin.json'), /manifest 的 schemaVersion/);
});

test('the validator does not mutate what it was given', () => {
  const input = manifest({ permissions: ['network'], capabilities: ['tool'] });
  const before = JSON.stringify(input);
  const parsed = validateManifest(input);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(parsed, input, '返回的是新对象，调用方手里的那份不受影响');
});
