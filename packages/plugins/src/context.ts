/**
 * The plugin host and the plugin context — the shape of the *only* thing a plugin ever holds.
 *
 * This file is where three of the four 铁律 boundaries become structural rather than advisory:
 *
 *  * **no main SQLite handle.** There is no `db` on `PluginHost` and none on `PluginContext`. The
 *    persistence a plugin may use is `storage`, and `RestrictedStore` refuses to hold a handle, a
 *    buffer or a function — it is a key/value string store, not a database. `assertNoHandle()` is
 *    the runtime check behind that promise.
 *  * **no way to change the core prompt.** `corePrompt` is read-only and the *only* thing a plugin
 *    can hand over is a context line, which passes `assertContextLine`.
 *  * **no raw camera/mic.** Not present as a property, not available as a permission token
 *    (`FORBIDDEN_PERMISSIONS`), and not delivered as data — `SensorSource.onEvent` receives a
 *    filtered `SensorEvent`.
 *
 * The fourth boundary (ToolPermission) is enforced where the tool actually runs, in the core
 * `ToolRegistry`; the context only exposes `permissions` so a plugin can *ask* what it holds.
 */
import type { AgentScope, AgentTool, ToolPermissionDecision, ToolPermissionPolicy, ToolRegistry } from '@xixi/brain-adapter';

import type { CapabilityRegistry } from './capability-registry.ts';
import type { CorePromptAuthority } from './prompt-authority.ts';
import { PluginBoundaryError, PluginPermissionError } from './errors.ts';
import { grantedPermissions, type PluginManifest } from './manifest.ts';

/**
 * The part of `ToolRegistry` a plugin may hold: **enumeration and asking, never mutation from outside
 * the lifecycle**.
 *
 * Three methods are refusals on purpose, and this is the whole point of the shape:
 *
 *  * `register(tool)` — a plugin must contribute tools by returning them from `activate()`, where the
 *    manifest declaration, the granted permission, the namespace rules and the scope check all run in
 *    one place. The old version of this view quietly did **nothing** for `register` and returned a
 *    handle that released *any* name on dispose — a plugin could call
 *    `ctx.tools.register(coreTool).dispose()` and delete a core tool. The bypass is gone: there is no
 *    second door, and reaching for it is a named refusal that says which door to use.
 *  * `unregister(name)` — allowed, but only for a tool **this plugin contributed**. Ownership is read
 *    from the `CapabilityRegistry` (the same record `#add` guards on), never from the caller.
 *  * `execute(...)` — the model loop runs tools; a plugin does not (铁律 8).
 */
export interface PluginToolView {
  /**
   * Contribute a tool — **refused here**: it always throws `PluginBoundaryError` naming the
   * alternative. Return the tools from `activate()` instead; the manager registers them through
   * `CapabilityRegistry.registerContribution`, which is where the gates live.
   */
  register(tool: AgentTool): never;
  /**
   * Release one tool **this plugin owns** (capability + its mounted copy). Anything else — a core
   * tool, another plugin's capability, a name nobody owns — is refused loudly and left untouched.
   */
  unregister(name: string): boolean;
  /** What the model can call right now (the core registry, read-only). */
  names(): string[];
  all(): AgentTool[];
  listForAgent(scope: AgentScope): AgentTool[];
  check(name: string, scope: AgentScope): ToolPermissionDecision;
  /**
   * Declared as `never`-returning and implemented as a refusal.
   *
   * It is *not* part of the API a plugin is offered (nothing in this package calls it, and the
   * core never needs to); it exists so that reaching for it — via a cast, an untyped call site, or
   * a `'execute' in ctx.tools` probe — gets a named boundary error instead of a live tool call.
   */
  execute(...args: never[]): never;
}

/** The permission tokens a context may hold. Deliberately *not* the manifest's string table. */
export type PluginPermissionKey = 'network' | 'storage' | 'notify' | 'context.read' | 'topic.read' | 'tool.register' | 'sensor.events';

export interface PluginLog {
  (message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Outbound HTTP, and only after `network` is granted. */
export interface NetworkGrant {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** Key/value persistence. Strings in, strings out — never a store handle, never a Buffer. */
export interface StorageGrant {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  keys(): string[];
}

/** Speaking to the household. The host owns rate limits and quiet hours; a plugin only asks. */
export interface NotifyGrant {
  send(text: string): void;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly manifest: PluginManifest;
  /**
   * A **view** of the core tool registry: register, enumerate, ask. Not `execute`.
   *
   * The omission is load-bearing. `ToolRegistry.execute(call, context)` takes the *context* as an
   * argument, so handing a plugin the live registry would hand it "run any registered tool with
   * whatever role I like" — a bypass of 铁律 8 from inside the plugin API. A plugin's job is to
   * contribute a tool; the model loop is what runs one, and it runs it through the core.
   */
  readonly tools: PluginToolView;
  readonly capabilities: CapabilityRegistry;
  /** What may run. A plugin may *ask*; it may not replace it (pack §3, 铁律 8). */
  readonly permissions: ToolPermissionPolicy;
  /** Granted permission surfaces. Each getter throws unless the manifest declared it. */
  readonly network: NetworkGrant;
  readonly storage: StorageGrant;
  readonly notify: NotifyGrant;
  readonly log: PluginLog;
  readonly corePrompt: CorePromptAuthority;
}

export type PluginAuditEvent =
  | { readonly kind: 'lifecycle'; readonly step: string; readonly outcome: 'ok' | 'failed'; readonly detail?: string }
  | { readonly kind: 'permission'; readonly permission: string; readonly granted: boolean; readonly detail?: string }
  | { readonly kind: 'capability'; readonly action: 'registered' | 'disposed'; readonly capability: string; readonly name: string }
  | { readonly kind: 'boundary'; readonly boundary: string; readonly detail: string }
  | { readonly kind: 'health'; readonly status: string; readonly detail?: string }
  | { readonly kind: 'log'; readonly message: string; readonly fields?: Readonly<Record<string, unknown>> };

export interface PluginAuditRecord {
  readonly pluginId: string;
  readonly at: string;
  readonly event: PluginAuditEvent;
}

export interface PluginHost {
  readonly tools: ToolRegistry;
  readonly capabilities: CapabilityRegistry;
  readonly corePrompt: CorePromptAuthority;
  /** Where a plugin's audit records go. Absent = nothing is recorded (tests only). */
  readonly audit?: ((record: PluginAuditRecord) => void) | undefined;
  /** Key/value store backing the `storage` grant. Absent = the grant refuses politely. */
  readonly storage?: PluginStorage | undefined;
  /** Outbound fetch. Absent = the `network` grant refuses politely. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Delivery of `notify`. Absent = the grant rejects loud enough to be seen. */
  readonly notify?: ((text: string) => void) | undefined;
  /** Clock, so the journal and the health checks are deterministic under test. */
  readonly now?: (() => Date) | undefined;
}

/** What a deployment hands the plugin layer to keep values. String keys, string values. */
export interface PluginStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  keys(): string[];
}

/** The privileged surfaces a plugin must never be handed. Names, so any object can be checked. */
export const PRIVILEGED_SURFACE_MARKERS: readonly string[] = ['database', 'sqlite', 'rawCamera', 'rawMicrophone', 'systemPromptWrite'];

/** Property names a smuggled handle would sit under. Checked on any object before a plugin sees it. */
export const FORBIDDEN_CONTEXT_KEYS: readonly string[] = [
  'db',
  'database',
  'sqlite',
  'sqliteHandle',
  'rawCamera',
  'rawMicrophone',
  'rawAudio',
  'systemPrompt',
  'setSystemPrompt',
  'corePromptWrite',
  'toolPermissionOverride',
  ...PRIVILEGED_SURFACE_MARKERS,
];

/** Which boundary a smuggled key belongs to — the message has to name the right one. */
function boundaryOfKey(key: string): 'sqlite-handle' | 'raw-camera-mic' | 'core-system-prompt' | 'tool-permission' {
  if (key === 'rawCamera' || key === 'rawMicrophone' || key === 'rawAudio') return 'raw-camera-mic';
  if (key === 'systemPrompt' || key === 'setSystemPrompt' || key === 'systemPromptWrite' || key === 'corePromptWrite') return 'core-system-prompt';
  if (key === 'toolPermissionOverride') return 'tool-permission';
  return 'sqlite-handle';
}

/**
 * The runtime half of three boundaries: no object handed to a plugin may carry a database handle,
 * a raw media surface, or a prompt-write hook. Called on the context at build time and on the
 * host before a manager starts using it.
 */
export function assertNoPrivilegedSurface(target: object, pluginId: string, label: string): void {
  for (const key of FORBIDDEN_CONTEXT_KEYS) {
    if (key in target) {
      throw new PluginBoundaryError(boundaryOfKey(key), pluginId, `${label} 上出现了「${key}」：插件上下文不得携带这个缝`);
    }
  }
}

export interface PluginToolViewOptions {
  /** The core registry: read-only for the plugin, except for releasing its *own* tool. */
  readonly registry: ToolRegistry;
  /** Where ownership is recorded — the same registry the lifecycle registers capabilities into. */
  readonly capabilities: CapabilityRegistry;
  readonly pluginId: string;
}

/**
 * Build the tool view a plugin holds.
 *
 * The two refusals are the point (see `PluginToolView`): `register` says which door to use instead of
 * silently accepting a call that does nothing, and `unregister` asks the `CapabilityRegistry` who owns
 * the name before it touches anything. The core registry is consulted for one more thing only — the
 * **identity** of the mounted tool: a plugin may release the very object it contributed, and nothing
 * that merely shares its name.
 */
export function createPluginToolView(options: PluginToolViewOptions): PluginToolView {
  const { registry, capabilities, pluginId } = options;
  return Object.freeze({
    register: (_tool: AgentTool): never => {
      throw new PluginBoundaryError(
        'tool-permission',
        pluginId,
        '插件不要在上下文里注册工具：把工具放进 activate() 返回的 contribution.tools，' +
          '由生命周期统一注册（manifest 声明 / tool.register 权限 / 命名空间 / scope 都在那里判）',
      );
    },
    unregister: (name: string): boolean => {
      const owner = capabilities.ownerOf('tool', name);
      if (owner === undefined) {
        throw new PluginBoundaryError(
          'tool-permission',
          pluginId,
          `「${name}」不是任何插件注册的能力，拒绝释放：核心工具表不归插件管（只能释放自己贡献的工具）`,
        );
      }
      if (owner !== pluginId) {
        throw new PluginBoundaryError('tool-permission', pluginId, `「${name}」属于 ${owner}：插件不能释放别的插件的能力`);
      }
      // Identity check before any mutation: only the object this capability contributed may go.
      const mounted = registry.all().find((tool) => tool.name === name);
      if (mounted !== undefined) {
        const spec = capabilities.get<{ readonly tool: AgentTool }>('tool', name);
        if (spec === undefined || spec.tool !== mounted) {
          throw new PluginBoundaryError('tool-permission', pluginId, `工具表里的「${name}」不是这个插件贡献的那个对象，拒绝碰它`);
        }
        registry.unregister(name);
      }
      return capabilities.release(pluginId, 'tool', name);
    },
    names: () => registry.names(),
    all: () => registry.all(),
    listForAgent: (scope: AgentScope) => registry.listForAgent(scope),
    check: (name: string, scope: AgentScope) => registry.check(name, scope),
    execute: (): never => {
      throw new PluginBoundaryError(
        'tool-permission',
        pluginId,
        '插件不执行任何工具：工具由核心的 ToolRegistry 在模型循环里执行，权限在注册表里判（铁律 8）',
      );
    },
  }) as PluginToolView;
}

/**
 * A string store that is *not* a database handle.
 *
 * The check is real: a plugin that tries to keep a `DatabaseSync`, a `Uint8Array` (raw media) or a
 * function (a live handle to something) is refused, so 「插件不能直接拿主 SQLite handle」 is not
 * defeated by proxying the handle through `storage`.
 */
export function createRestrictedStore(backing: PluginStorage | undefined, pluginId: string): StorageGrant {
  const memory = new Map<string, string>();
  const store: PluginStorage = backing ?? {
    get: (key) => memory.get(key),
    set: (key, value) => void memory.set(key, value),
    delete: (key) => memory.delete(key),
    keys: () => [...memory.keys()],
  };
  return {
    get: (key) => store.get(key),
    set: (key, value: unknown) => {
      if (typeof value !== 'string') {
        const isHandle = typeof value === 'object' && value !== null;
        const label = isHandle ? ((value as { constructor?: { name?: string } }).constructor?.name ?? '对象') : typeof value;
        throw new PluginBoundaryError(
          'sqlite-handle',
          pluginId,
          isHandle
            ? `storage 只能存字符串：插件想把一个 ${label} 句柄存进来（主库句柄只属于核心）`
            : `storage 只能存字符串，收到 ${label}`,
        );
      }
      store.set(key, value);
    },
    delete: (key) => store.delete(key),
    keys: () => store.keys(),
  };
}

function grant<T>(granted: ReadonlySet<string>, permission: PluginPermissionKey, pluginId: string, build: () => T): T {
  if (!granted.has(permission)) {
    throw new PluginPermissionError(permission, `${pluginId} 没有声明 ${permission} 权限`);
  }
  return build();
}

export interface PluginContextOptions {
  readonly manifest: PluginManifest;
  readonly host: PluginHost;
}

export interface BuiltPluginContext {
  readonly context: PluginContext;
  readonly granted: ReadonlySet<string>;
  readonly audit: (event: PluginAuditEvent) => void;
}

/** Build the one context a plugin is given. Every privileged getter is gated on the manifest. */
export function buildPluginContext(options: PluginContextOptions): BuiltPluginContext {
  const { manifest, host } = options;
  const granted = grantedPermissions(manifest);
  const client = manifest.id;
  const now = host.now ?? (() => new Date());

  const audit = (event: PluginAuditEvent): void => {
    host.audit?.({ pluginId: client, at: now().toISOString(), event });
  };

  const context: PluginContext = {
    pluginId: client,
    pluginName: manifest.name,
    manifest,
    tools: createPluginToolView({ registry: host.tools, capabilities: host.capabilities, pluginId: client }),
    capabilities: host.capabilities,
    permissions: host.capabilities.permission,
    get network(): NetworkGrant {
      return grant(granted, 'network', client, () => ({
        fetch: (input, init) => {
          const impl = host.fetchImpl ?? globalThis.fetch;
          if (typeof impl !== 'function') {
            throw new PluginPermissionError('network', `${client} 声明了 network，但宿主没有提供 fetch`);
          }
          return impl(input, init);
        },
      }));
    },
    get storage(): StorageGrant {
      return grant(granted, 'storage', client, () => createRestrictedStore(host.storage, client));
    },
    get notify(): NotifyGrant {
      return grant(granted, 'notify', client, () => ({
        send: (text: string) => {
          if (typeof text !== 'string' || text.length === 0) {
            throw new PluginPermissionError('notify', `${client} 的 notify 需要一句非空文本`);
          }
          if (typeof host.notify !== 'function') {
            throw new PluginPermissionError('notify', `${client} 声明了 notify，但宿主没有接上投递缝`);
          }
          host.notify(text);
        },
      }));
    },
    log: (message, fields) => audit({ kind: 'log', message, ...(fields === undefined ? {} : { fields }) }),
    corePrompt: host.corePrompt,
  };

  assertNoPrivilegedSurface(context, client, '插件上下文');

  return { context, granted, audit };
}
