/**
 * Plugin manifest — pack `03_AGENT_PLUGIN.md` §2, transcribed as data *and* as a checker.
 *
 * ```json
 * { "schemaVersion": 1, "id": "xixi.news", "name": "News", "version": "0.1.0",
 *   "entry": "./dist/index.js", "permissions": ["network"],
 *   "capabilities": ["tool", "topic_source"] }
 * ```
 *
 * Two fields are required for a reason and one field is *not* in the pack's table:
 *
 *  * `schemaVersion` / `id` / `name` / `version` are the four required fields (铁律 10: every
 *    persistent record carries a schema version; `id` + `version` say which plugin is speaking);
 *  * `entry` / `permissions` / `capabilities` / `health` are optional — an entry-less plugin is
 *    one whose module the host already holds (see `InlinePluginSource`), and a plugin without
 *    `capabilities` simply contributes nothing;
 *  * a **fifth** optional field, `requiredPermissions`, is this implementation's addition to the
 *    pack's shape. It is how the pack's「permissions 里的东西没声明就不给」gets a *static* check:
 *    a plugin can state up front what it will ask for at runtime, and the validator refuses the
 *    manifest when `requiredPermissions ⊄ permissions`. Without it the only way to learn that a
 *    plugin wanted too much is to let it run and watch it fail.
 */

import { PluginManifestError } from './errors.ts';

/** The five V0.3 capability kinds (§2). Nothing outside this list can be declared. */
export const PLUGIN_CAPABILITIES = ['tool', 'topic_source', 'context_provider', 'sensor_source', 'action'] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/**
 * Permission vocabulary of the plugin system — an **allow-list**, not a denylist.
 *
 * This is the first of the two places the "cannot read raw camera/mic" boundary is enforced:
 * the tokens that would express raw-media access (`camera`, `microphone`, `raw_audio`, …) are
 * simply not in the vocabulary, so `validateManifest` refuses a plugin that asks for them with a
 * reason naming the boundary. The second place is the context: even a granted permission never
 * hands out a device — `sensor_source` subscriptions receive *events the perception edge already
 * filtered* (铁律 6).
 *
 * **Tool-level approval is deliberately NOT here (yet)** — V0.3 P2-B 的 ASK 声明面是部署配置
 * `config.tools.approval.ask`（`@xixi/runtime` 的 `resolveToolApprovalSettings`），**manifest 侧未实现**：
 * 权限表里没有「这个工具要先问一句」的 token，`ActionHandler.approval` 只作用于 `action` 能力，
 * 而 action 今天还没有被挂成模型可见的工具。给 manifest 加一个 approval token（并让
 * `registerContribution` / 工具视图把它接到 `ToolPermission.askTools`）是**下一轮的小任务**——
 * 在那之前，插件工具与内置工具一样，只能靠部署声明变成 `ask`，插件不能自己给自己加一道确认。
 */
export const PLUGIN_PERMISSIONS = ['network', 'storage', 'notify', 'context.read', 'topic.read', 'tool.register', 'sensor.events'] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** Tokens that are refused by name, with the boundary each one belongs to. */
export const FORBIDDEN_PERMISSIONS: Readonly<Record<string, { readonly boundary: 'raw-camera-mic' | 'sqlite-handle' | 'core-system-prompt' | 'tool-permission'; readonly because: string }>> = {
  camera: { boundary: 'raw-camera-mic', because: '插件拿不到摄像头（只拿感知边过滤过的事件，铁律 6）' },
  microphone: { boundary: 'raw-camera-mic', because: '插件拿不到麦克风（只拿感知边过滤过的事件，铁律 6）' },
  mic: { boundary: 'raw-camera-mic', because: '插件拿不到麦克风（只拿感知边过滤过的事件，铁律 6）' },
  raw_camera: { boundary: 'raw-camera-mic', because: '原始帧不进插件（铁律 6）' },
  raw_mic: { boundary: 'raw-camera-mic', because: '原始音频不进插件（铁律 6）' },
  raw_audio: { boundary: 'raw-camera-mic', because: '原始音频不进插件（铁律 6）' },
  raw_video: { boundary: 'raw-camera-mic', because: '原始视频不进插件（铁律 6）' },
  sqlite: { boundary: 'sqlite-handle', because: '主库句柄只属于 @xixi/domain（pack §3 第一条）' },
  database: { boundary: 'sqlite-handle', because: '主库句柄只属于 @xixi/domain（pack §3 第一条）' },
  'storage.raw': { boundary: 'sqlite-handle', because: '插件不直接开库；持久化走宿主给的 storage 缝' },
  system_prompt: { boundary: 'core-system-prompt', because: '核心提示词由程序持有（铁律 2）' },
  'system_prompt.write': { boundary: 'core-system-prompt', because: '核心提示词由程序持有（铁律 2）' },
  'tool.permission': { boundary: 'tool-permission', because: '权限策略在模型与插件之外校验（铁律 8）' },
};

/** `schemaVersion` values the validator knows. Only 1 exists today. */
export const PLUGIN_MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1];

export interface PluginManifestHealth {
  /** Capability names that must be live for the plugin to count as healthy. */
  readonly requires?: readonly string[];
  /** How often the host may re-run `health()`, in milliseconds. */
  readonly intervalMs?: number;
}

export interface PluginManifest {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Path to the plugin module, relative to the manifest. Absent = the host already holds it. */
  readonly entry?: string;
  readonly permissions?: readonly string[];
  readonly capabilities?: readonly PluginCapability[];
  readonly health?: PluginManifestHealth;
  /** Permissions the plugin admits it will request at run time; must be a subset of `permissions`. */
  readonly requiredPermissions?: readonly string[];
}

/** The pack §2 shape as a JSON Schema, for tooling and for a runtime-readable contract. */
export const PLUGIN_MANIFEST_SCHEMA_V1: Readonly<Record<string, unknown>> = {
  $id: 'xixi://plugin-manifest/v1',
  type: 'object',
  required: ['schemaVersion', 'id', 'name', 'version'],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', enum: PLUGIN_MANIFEST_SCHEMA_VERSIONS },
    id: { type: 'string', pattern: '^[a-z0-9]+([._-][a-z0-9]+)*$' },
    name: { type: 'string', minLength: 1 },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+' },
    entry: { type: 'string', minLength: 1 },
    permissions: { type: 'array', items: { type: 'string', enum: PLUGIN_PERMISSIONS } },
    capabilities: { type: 'array', items: { type: 'string', enum: PLUGIN_CAPABILITIES } },
    health: {
      type: 'object',
      properties: {
        requires: { type: 'array', items: { type: 'string' } },
        intervalMs: { type: 'integer', minimum: 1 },
      },
    },
    requiredPermissions: { type: 'array', items: { type: 'string', enum: PLUGIN_PERMISSIONS } },
  },
};

const ID_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+/;

function refuse(field: string, reason: string): never {
  throw new PluginManifestError(`manifest 的 ${field} ${reason}`);
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginManifestError('manifest 必须是一个 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string') refuse(field, '必须是字符串');
  if (value.length === 0) refuse(field, '不能是空串');
  return value;
}

/** Unknown, forbidden or non-string entries in a permission list — one refusal per offender. */
function checkPermissionList(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) refuse(field, '必须是数组');
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) refuse(field, '里只能放非空字符串');
    const forbidden = FORBIDDEN_PERMISSIONS[entry];
    if (forbidden !== undefined) {
      // Name the boundary in the message: an operator reading the log should not have to look
      // up why `camera` is refused.
      refuse(field, `里的「${entry}」不允许：${forbidden.because}（边界 ${forbidden.boundary}）`);
    }
    if (!(PLUGIN_PERMISSIONS as readonly string[]).includes(entry)) {
      refuse(field, `里的「${entry}」不在权限表里（可用：${PLUGIN_PERMISSIONS.join('、')}）`);
    }
    seen.add(entry);
  }
  return [...seen];
}

function checkCapabilities(raw: unknown): PluginCapability[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) refuse('capabilities', '必须是数组');
  const seen = new Set<PluginCapability>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || !(PLUGIN_CAPABILITIES as readonly string[]).includes(entry)) {
      refuse('capabilities', `里的「${String(entry)}」不是 V0.3 的五种能力之一（可用：${PLUGIN_CAPABILITIES.join('、')}）`);
    }
    seen.add(entry as PluginCapability);
  }
  return [...seen];
}

function checkHealth(raw: unknown): PluginManifestHealth | undefined {
  if (raw === undefined) return undefined;
  const health = asPlainObject(raw);
  for (const key of Object.keys(health)) {
    if (key !== 'requires' && key !== 'intervalMs') refuse(`health.${key}`, '不是已知字段');
  }
  const result: { requires?: readonly string[]; intervalMs?: number } = {};
  if (health['requires'] !== undefined) {
    const requires = health['requires'];
    if (!Array.isArray(requires) || requires.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      refuse('health.requires', '必须是非空字符串数组');
    }
    result.requires = [...(requires as string[])];
  }
  if (health['intervalMs'] !== undefined) {
    const interval = health['intervalMs'];
    if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1) refuse('health.intervalMs', '必须是正整数毫秒数');
    result.intervalMs = interval;
  }
  return result;
}

/**
 * Validate one manifest and return the same object, narrowed.
 *
 * Throws `PluginManifestError` (never a bare `Error`) so callers can distinguish "this plugin is
 * not allowed to exist" from "this plugin is broken". The order is fixed: required fields first,
 * then the optional ones, then the cross-field rule.
 */
export function validateManifest(value: unknown): PluginManifest {
  const source = asPlainObject(value);

  const schemaVersion = source['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) refuse('schemaVersion', '必须是整数');
  if (!PLUGIN_MANIFEST_SCHEMA_VERSIONS.includes(schemaVersion)) {
    refuse('schemaVersion', `不支持版本 ${String(schemaVersion)}（支持：${PLUGIN_MANIFEST_SCHEMA_VERSIONS.join('、')}）`);
  }

  const id = requireString(source, 'id');
  if (!ID_PATTERN.test(id)) refuse('id', `「${id}」不合规（小写字母数字，可用 . _ - 分隔）`);
  const name = requireString(source, 'name');
  const version = requireString(source, 'version');
  if (!VERSION_PATTERN.test(version)) refuse('version', `「${version}」不是 x.y.z 形式`);

  const entry = source['entry'] === undefined ? undefined : requireString(source, 'entry');
  const permissions = checkPermissionList(source['permissions'], 'permissions');
  const capabilities = checkCapabilities(source['capabilities']);
  const health = checkHealth(source['health']);
  const requiredPermissions = checkPermissionList(source['requiredPermissions'], 'requiredPermissions');

  // 静态的「要求多于声明」检查：pack §3「permissions 里的东西没声明就不给」，这句话的静态一半。
  const undeclared = requiredPermissions.filter((permission) => !permissions.includes(permission));
  if (undeclared.length > 0) {
    refuse('requiredPermissions', `里的 ${undeclared.join('、')} 没有在 permissions 里声明`);
  }

  return {
    schemaVersion,
    id,
    name,
    version,
    ...(entry === undefined ? {} : { entry }),
    ...(permissions.length === 0 ? {} : { permissions }),
    ...(capabilities.length === 0 ? {} : { capabilities }),
    ...(health === undefined ? {} : { health }),
    ...(requiredPermissions.length === 0 ? {} : { requiredPermissions }),
  };
}

/** Parse manifest text (a file's contents) and validate it. */
export function parseManifest(text: string, origin = 'manifest'): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new PluginManifestError(`${origin} 不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return validateManifest(parsed);
}

/** The permissions a loaded plugin actually holds: what it declared, nothing else. */
export function grantedPermissions(manifest: PluginManifest): ReadonlySet<string> {
  return new Set(manifest.permissions ?? []);
}

/** What a capability kind requires before it may be registered (pack §3 「permission」步). */
export const CAPABILITY_PERMISSIONS: Readonly<Record<PluginCapability, readonly string[]>> = {
  tool: ['tool.register'],
  topic_source: ['topic.read'],
  context_provider: ['context.read'],
  sensor_source: ['sensor.events'],
  action: ['notify'],
};
