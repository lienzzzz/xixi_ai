/**
 * `PluginManager` — pack `03_AGENT_PLUGIN.md` §3, the nine-step lifecycle.
 *
 * ```text
 * discover → validate → permission → load → activate(ctx) → register capabilities
 *          → health → deactivate → dispose
 * ```
 *
 * Six things about this class are deliberate:
 *
 *  1. **The order is data, not prose.** Every run of the pipeline appends to a journal, so
 *     「permission 先于 load 生效」 is an assertion a test can make (`steps()`), not a claim in a
 *     comment. A refused plugin still has a journal — with the failing step and the state it
 *     stopped at.
 *  2. **Every registration is owned here.** The capability disposables live in a bundle per
 *     activation and `deactivate` releases them; that is what makes 「dispose 后能力不再可用」
 *     checkable from the registry side rather than a promise in a docstring.
 *  3. **A refusal is contained.** `loadPlugin` throws for exactly one plugin; `loadAll` records the
 *     failure and keeps the others, so a bad plugin cannot take the household down.
 *  4. **Re-activation is a first-class state.** `deactivate` then `activate` again runs the pipeline
 *     a second time with a fresh bundle, which is how hot-plugging is tested.
 *
 * Two more invariants were added by P2.5-I, both about 「状态不许撒谎」:
 *
 *  5. **Starting is a one-shot contract.** `loadAll` runs once; a second call is refused with
 *     `PluginAlreadyStartedError` instead of re-running the pipeline. The old silent behaviour ran
 *     `activate` twice and left a capability-contributing plugin **inactive** while its tools were
 *     still in the core registry. Cycling a plugin goes through `deactivate` → `activate` (point 4).
 *  6. **Health describes a running plugin.** `deactivate` / `dispose` / rollback drop the health
 *     report together with the capabilities, so nothing can report `ok` (or `degraded`) about a
 *     plugin that is not running; `PluginInstance.online` is the field that says which case it is.
 */
import type { AgentScope, AgentTool, ToolRegistry } from '@xixi/brain-adapter';

import {
  CapabilityRegistry,
  type ActionHandler,
  type ContextLine,
  type ContextProvider,
  type PluginContribution,
  type PluginToolSpec,
  type SensorSource,
  type TopicSource,
} from './capability-registry.ts';
import {
  assertNoPrivilegedSurface,
  buildPluginContext,
  type PluginAuditEvent,
  type PluginAuditRecord,
  type PluginHost,
  type PluginPermissionKey,
  type PluginStorage,
} from './context.ts';
import { DisposableBundle } from './disposal.ts';
import { PluginAlreadyStartedError, PluginError, PluginLifecycleError, PluginPermissionError } from './errors.ts';
import {
  asModuleShape,
  FilePluginSource,
  InlinePluginSource,
  importModule,
  loadPluginModule,
  type DiscoveredPlugin,
  type InlinePlugin,
  type PluginHealthHook,
  type PluginModuleLoader,
  type PluginModuleShape,
  type PluginSource,
} from './discovery.ts';
import { grantedPermissions, validateManifest, type PluginCapability, type PluginManifest, type PluginManifestHealth } from './manifest.ts';
import { CORE_PROMPT_AUTHORITY, type CorePromptAuthority } from './prompt-authority.ts';

/** The nine steps, in order. Exported so a test can assert the pipeline itself, not only a run of it. */
export const PLUGIN_LIFECYCLE_STEPS = [
  'discover',
  'validate',
  'permission',
  'load',
  'activate',
  'register-capabilities',
  'health',
  'deactivate',
  'dispose',
] as const;

export type PluginLifecycleStep = (typeof PLUGIN_LIFECYCLE_STEPS)[number];

export type PluginState = 'discovered' | 'validated' | 'permitted' | 'loaded' | 'active' | 'inactive' | 'failed' | 'disposed';

export type PluginHealthStatus = 'ok' | 'degraded' | 'down';

export interface PluginLifecycleRecord {
  readonly step: PluginLifecycleStep;
  /** The state the plugin is in *after* this step (or `failed` when the step refused). */
  readonly state: PluginState;
  readonly outcome: 'ok' | 'failed';
  readonly at: string;
  readonly detail?: string;
}

export interface PluginHealthReport {
  readonly status: PluginHealthStatus;
  readonly detail?: string;
  readonly at: string;
}

/** One discovered plugin and everything the host knows about it. */
export interface PluginInstance {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly state: PluginState;
  /**
   * Whether this plugin is running right now — exactly `state === 'active'` (P2.5-I ②).
   *
   * It is here because `health` alone cannot answer the question. A console panel that prints only
   * `health?.status` used to show 「ok」 about a plugin that had already been deactivated, and
   * 「1 个 MCP 工具在线」 about a connection that was idle. Read `online` first; `health` is only
   * meaningful while it is `true`.
   */
  readonly online: boolean;
  readonly capabilities: readonly string[];
  /**
   * The last health report of a plugin that is running (or was running until this moment).
   *
   * `undefined` once the plugin is stopped or disposed: a stopped plugin has no live health, and
   * minting an 「offline」 status here would collide with the plugin's own `down`. It is *not* a
   * stale snapshot — it is dropped by the same call that releases the plugin's capabilities.
   */
  readonly health: PluginHealthReport | undefined;
  readonly error: string | undefined;
  readonly journal: readonly PluginLifecycleRecord[];
  readonly activationCount: number;
}

/** The mutable handle the manager keeps per plugin, keyed by id. */
interface Runtime {
  manifest: PluginManifest;
  state: PluginState;
  capabilities: string[];
  health: PluginHealthReport | undefined;
  error: string | undefined;
  journal: PluginLifecycleRecord[];
  activationCount: number;
  activation: DisposableBundle;
  module: PluginModuleShape | undefined;
  discovered: DiscoveredPlugin | undefined;
  loader: PluginModuleLoader;
}

export interface PluginManagerOptions {
  readonly sources?: readonly PluginSource[];
  /**
   * The host. Its `capabilities` registry **is** the manager's registry — the manager never builds
   * a second one, so what a plugin registers is what the host can read and dispose.
   */
  readonly host: PluginHost;
  /** Clock, so journals are deterministic under test. */
  readonly now?: () => Date;
  /** The entry loader; overridable so a test needs no real module on disk. */
  readonly loader?: PluginModuleLoader;
}

const PERMISSION_KEYS: readonly PluginPermissionKey[] = ['network', 'storage', 'notify', 'context.read', 'topic.read', 'tool.register', 'sensor.events'];

/** Why a second start is refused (P2.5-I ①). One constant, so the message cannot drift per call site. */
const ALREADY_STARTED_RUNTIME =
  'loadAll 已经启动过：重复启动是宿主 bug，静默返回会让「插件到底起来了没有」看不出来。要重新启动，先 stop()，再新建一个 runtime。';

/** A step body that threw a boundary/permission refusal keeps that identity: callers assert on it. */
function fail(step: PluginLifecycleStep, cause: unknown): never {
  if (cause instanceof PluginError) throw cause;
  throw new PluginLifecycleError(step, cause instanceof Error ? cause.message : String(cause), { cause });
}

/** The state a successfully completed step leaves the plugin in. */
function stepState(step: PluginLifecycleStep): PluginState {
  switch (step) {
    case 'discover':
      return 'discovered';
    case 'validate':
      return 'validated';
    case 'permission':
      return 'permitted';
    case 'load':
      return 'loaded';
    case 'activate':
    case 'register-capabilities':
    case 'health':
      return 'active';
    case 'deactivate':
      return 'inactive';
    case 'dispose':
      return 'disposed';
  }
}

export class PluginManager {
  readonly #host: PluginHost;
  readonly #sources: readonly PluginSource[];
  readonly #registry: CapabilityRegistry;
  readonly #loader: PluginModuleLoader | undefined;
  readonly #now: () => Date;
  readonly #runtimes = new Map<string, Runtime>();
  readonly #discovered = new Map<string, DiscoveredPlugin>();
  readonly #auditLog: PluginAuditRecord[] = [];
  #disposed = false;
  /** `loadAll` is the host's one-shot start (P2.5-I ①); set before the first step runs. */
  #started = false;

  constructor(options: PluginManagerOptions) {
    this.#host = options.host;
    this.#sources = options.sources ?? [];
    this.#now = options.now ?? (() => new Date());
    this.#loader = options.loader;
    // The host's registry **is** the manager's registry. Building a second one here would mean a
    // plugin's capabilities land somewhere nobody reads, which is exactly the kind of silent
    // disconnect the acceptance criterion 「dispose 后能力不再可用」 is supposed to catch.
    this.#registry = options.host.capabilities;
    // The host itself must not carry any privileged surface: the check belongs at boot, not at the
    // first plugin's expense.
    assertNoPrivilegedSurface(options.host, '(host)', '插件宿主');
  }

  /** The capability registry every plugin registers into. */
  get capabilities(): CapabilityRegistry {
    return this.#registry;
  }

  /** Every audit record the manager produced. The core's event log is wired here by the host. */
  get auditLog(): readonly PluginAuditRecord[] {
    return this.#auditLog;
  }

  instances(): PluginInstance[] {
    return [...this.#runtimes.values()]
      .map((runtime) => this.#view(runtime))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }

  instance(pluginId: string): PluginInstance | undefined {
    const runtime = this.#runtimes.get(pluginId);
    return runtime === undefined ? undefined : this.#view(runtime);
  }

  /** The journal of one plugin, in order. This is the observable evidence for the nine steps. */
  journal(pluginId: string): readonly PluginLifecycleRecord[] {
    return [...(this.#runtimes.get(pluginId)?.journal ?? [])];
  }

  /** Convenience for the common assertion: which steps ran, in order. */
  steps(pluginId: string): PluginLifecycleStep[] {
    return this.journal(pluginId).map((record) => record.step);
  }

  /** Plugins discovered so far, whether or not they loaded. */
  discoveredPlugins(): readonly DiscoveredPlugin[] {
    return [...this.#discovered.values()];
  }

  /**
   * Step 1 — `discover`. Reads the sources; a source that throws contributes nothing but is
   * recorded, so one broken directory cannot stop the others.
   */
  async discover(): Promise<readonly DiscoveredPlugin[]> {
    const found: DiscoveredPlugin[] = [];
    for (const source of this.#sources) {
      try {
        const entries = await source.discover();
        for (const entry of entries) {
          if (this.#discovered.has(entry.id)) {
            // A duplicate id is a source-level finding: the plugin that was found first keeps its
            // own journal — a second copy must not overwrite the record of the first one.
            this.#push('(source)', 'discover', 'failed', `插件 id 重复：${entry.id}（${source.kind}）`);
            continue;
          }
          this.#discovered.set(entry.id, entry);
          this.#push(entry.id, 'discover', 'ok', `${source.kind}${entry.problem === undefined ? '' : `（manifest 有问题：${entry.problem}）`}`);
          found.push(entry);
        }
      } catch (cause) {
        // Nothing to attribute the failure to; the host still needs to see it.
        this.#push('(source)', 'discover', 'failed', `${source.kind} 源读不到：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return found;
  }

  /**
   * Steps 1–7 for every source, isolating per-plugin failures.
   *
   * **This is the host's one-shot start (P2.5-I ①).** A second call is refused with
   * `PluginAlreadyStartedError` rather than re-running the pipeline: repeating a start is a host
   * bug, and quietly doing it again used to leave the plugins in a state that lied. The flag is set
   * *before* the first step, so a concurrent second call is refused as well. To start over, stop
   * this runtime and build a new one — restarting is not a state of this object.
   */
  async loadAll(): Promise<readonly PluginInstance[]> {
    if (this.#started) throw this.#refuseStart('loadAll', '(manager)', ALREADY_STARTED_RUNTIME);
    this.#started = true;
    await this.discover();
    for (const id of [...this.#discovered.keys()]) {
      try {
        await this.loadPlugin(id);
      } catch {
        // Already journaled; `loadAll` is the "bring up what you can" entry point.
      }
    }
    return this.instances();
  }

  /** Steps 2–7 for one plugin. Throws the refusal of the step that said no. */
  async loadPlugin(pluginId: string): Promise<PluginInstance> {
    if (this.#disposed) throw new PluginLifecycleError('load', `${pluginId}：插件管理器已经 dispose，不再接受加载`);
    let discovered = this.#discovered.get(pluginId);
    if (discovered === undefined) {
      await this.discover();
      discovered = this.#discovered.get(pluginId);
    }
    if (discovered === undefined) {
      this.#push(pluginId, 'validate', 'failed', `没有发现这个插件：${pluginId}`);
      throw new PluginLifecycleError('validate', `没有发现这个插件：${pluginId}`);
    }
    return this.#pipeline(discovered, 'loadPlugin');
  }

  /** Steps 2–7 for a plugin the host already holds in memory. */
  async loadInline(plugin: InlinePlugin): Promise<PluginInstance> {
    // 与 `loadPlugin` 同一条先例（内核启动只认一次那条 `#started` 守卫）：**已停用的内核不许再加载插件**。
    // 少了这一行，`disposeAll()` 之后仍能 loadInline 一个插件、把它变成 `active` 并重新登记能力 ——
    // 那就是「关停之后插件层又能被复活」。
    if (this.#disposed) throw new PluginLifecycleError('load', '插件管理器已经 dispose，不再接受 inline 加载');
    const inline = new InlinePluginSource([plugin]).discover()[0];
    if (inline === undefined) throw new PluginLifecycleError('discover', 'inline 插件没有 manifest');
    if (!this.#discovered.has(inline.id)) {
      this.#discovered.set(inline.id, inline);
      this.#push(inline.id, 'discover', 'ok', 'inline');
    }
    return this.#pipeline(inline, 'loadInline');
  }

  /**
   * Steps 2–7, in order, for one discovered plugin.
   *
   * `entry` only names the caller in the refusal of a repeated start (P2.5-I ①); the guard runs
   * before any step, so a refusal cannot leave a half-registered activation behind.
   */
  async #pipeline(discovered: DiscoveredPlugin, entry: string): Promise<PluginInstance> {
    const running = this.#runtimes.get(discovered.id);
    if (running?.state === 'active') {
      throw this.#refuseStart(
        entry,
        discovered.id,
        `${discovered.id} 已经启动过（第 ${running.activationCount} 次激活）：重复启动是宿主 bug，它会重复跑 activate，` +
          '并留下「插件 inactive 但工具仍在核心表里」的半坏状态。要重新起来，先 deactivate() 再 activate()。',
      );
    }
    // ---- step 2: validate
    let manifest: PluginManifest;
    try {
      manifest = validateManifest(discovered.manifest);
    } catch (cause) {
      this.#push(discovered.id, 'validate', 'failed', cause instanceof Error ? cause.message : String(cause));
      this.#ensure(discovered, undefined);
      throw fail('validate', cause);
    }
    const runtime = this.#ensure(discovered, manifest);
    this.#push(manifest.id, 'validate', 'ok', `schemaVersion=${manifest.schemaVersion} version=${manifest.version}`);

    // ---- step 3: permission — before load, so nothing of the plugin has run yet
    const granted = grantedPermissions(manifest);
    for (const permission of manifest.permissions ?? []) {
      this.#audit(manifest.id, { kind: 'permission', permission, granted: true });
    }
    for (const permission of manifest.requiredPermissions ?? []) {
      if (granted.has(permission)) continue;
      const detail = `${manifest.id} 要求 ${permission}，但 permissions 里没有声明`;
      this.#push(manifest.id, 'permission', 'failed', detail);
      this.#audit(manifest.id, { kind: 'permission', permission, granted: false, detail });
      throw new PluginPermissionError(permission, detail);
    }
    this.#push(manifest.id, 'permission', 'ok', granted.size === 0 ? '没有声明任何权限' : `已授予 ${[...granted].join('、')}`);

    // ---- step 4: load
    let module: PluginModuleShape;
    let origin: string;
    try {
      const loaded = await loadPluginModule(discovered, runtime.loader);
      module = asModuleShape(loaded.module);
      runtime.module = module;
      origin = loaded.origin;
      this.#push(manifest.id, 'load', 'ok', origin);
    } catch (cause) {
      this.#push(manifest.id, 'load', 'failed', cause instanceof Error ? cause.message : String(cause));
      throw fail('load', cause);
    }
    void origin;

    // A re-activation after a deactivate starts from a clean, empty bundle.
    runtime.activation = new DisposableBundle();
    const { context } = buildPluginContext({ manifest, host: this.#hostFor(manifest, granted) });

    // ---- step 5: activate(ctx)
    let contribution: PluginContribution | undefined;
    try {
      if (typeof module.activate !== 'function') throw new Error('插件模块没有导出 activate');
      contribution = (await module.activate(context)) as PluginContribution | undefined;
      this.#push(manifest.id, 'activate', 'ok', `第 ${runtime.activationCount + 1} 次激活`);
    } catch (cause) {
      this.#push(manifest.id, 'activate', 'failed', cause instanceof Error ? cause.message : String(cause));
      await this.#rollback(runtime);
      throw fail('activate', cause);
    }

    // ---- step 6: register capabilities
    try {
      const validated = this.#validateContribution(manifest.id, contribution);
      const contextProviders = await Promise.all(
        (validated.contextProviders ?? []).map((provider) => this.#wrapContextProvider(manifest.id, provider)),
      );
      const prepared: PluginContribution = { ...validated, contextProviders };
      for (const disposable of this.#registry.registerContribution(manifest.id, manifest.capabilities ?? [], granted, prepared)) {
        runtime.activation.add(disposable);
      }
      runtime.capabilities = this.#registry
        .list()
        .filter((entry) => entry.pluginId === manifest.id)
        .map((entry) => `${entry.kind}:${entry.name}`);
      for (const entry of this.#registry.list().filter((item) => item.pluginId === manifest.id)) {
        this.#audit(manifest.id, { kind: 'capability', action: 'registered', capability: entry.kind, name: entry.name });
      }
      this.#push(
        manifest.id,
        'register-capabilities',
        'ok',
        runtime.capabilities.length === 0 ? '没有贡献任何能力' : runtime.capabilities.join('、'),
      );
    } catch (cause) {
      this.#push(manifest.id, 'register-capabilities', 'failed', cause instanceof Error ? cause.message : String(cause));
      await this.#rollback(runtime);
      throw fail('register-capabilities', cause);
    }

    // ---- step 7: health
    try {
      const health = await this.#runHealth(manifest, module, runtime);
      runtime.health = health;
      runtime.activationCount += 1;
      runtime.error = undefined;
      this.#push(manifest.id, 'health', 'ok', `${health.status}${health.detail === undefined ? '' : ` — ${health.detail}`}`);
      this.#audit(manifest.id, { kind: 'health', status: health.status, ...(health.detail === undefined ? {} : { detail: health.detail }) });
    } catch (cause) {
      this.#push(manifest.id, 'health', 'failed', cause instanceof Error ? cause.message : String(cause));
      await this.#rollback(runtime);
      throw fail('health', cause);
    }

    return this.#view(runtime);
  }

  /**
   * Step 6's shape gate. A capability may not be contributed unless the manifest declared it and
   * the matching permission was granted (`registerContribution` re-checks the permission, and the
   * registry re-checks the reserved namespaces). This is where the plugin's *own* contribution is
   * checked first, so a malformed one fails with a message naming the plugin rather than a
   * `TypeError` from deep inside the registry.
   */
  #validateContribution(pluginId: string, contribution: PluginContribution | undefined): PluginContribution {
    // A plugin that contributes nothing is the ordinary case (an activation may just wire a timer or
    // report health), so `undefined` and a partial object both normalize to an empty contribution.
    const source: PluginContribution = typeof contribution === 'object' && contribution !== null ? contribution : {};
    const assertArray = (value: unknown, field: string): unknown[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) throw new PluginLifecycleError('register-capabilities', `${pluginId} 的 ${field} 必须是数组`);
      return value;
    };
    const tools = assertArray(source.tools, 'tools').map((entry) => {
      const spec = entry as PluginToolSpec;
      if (typeof spec?.tool?.name !== 'string') throw new PluginLifecycleError('register-capabilities', `${pluginId} 的 tools 里有一项没有 tool.name`);
      return spec;
    });
    return {
      tools,
      topicSources: assertArray(source.topicSources, 'topicSources') as TopicSource[],
      contextProviders: assertArray(source.contextProviders, 'contextProviders') as ContextProvider[],
      sensorSources: assertArray(source.sensorSources, 'sensorSources') as SensorSource[],
      actions: assertArray(source.actions, 'actions') as ActionHandler[],
    };
  }

  /**
   * Every context line a plugin offers passes the core filter before the registry keeps it — and
   * the filter runs **at load time** as well as on every later call.
   *
   * On the *content* side this is the enforcement point for 「插件不能改核心 system prompt」: a
   * provider may contribute material, but text that impersonates program policy is refused while
   * the plugin is loading — at that moment, not at the next turn. The load-time pass uses a
   * placeholder input on purpose: a provider whose output depends on the turn is still a legitimate
   * provider, but one that only emits policy text on a Tuesday is not something the host wants to
   * discover at 08:00 on a Tuesday.
   */
  async #wrapContextProvider(pluginId: string, provider: ContextProvider): Promise<ContextProvider> {
    const authority: CorePromptAuthority = this.#host.corePrompt;
    const filter = (lines: readonly ContextLine[] | undefined): ContextLine[] => {
      const out: ContextLine[] = [];
      for (const line of lines ?? []) {
        authority.assertContextLine(pluginId, line?.text ?? '');
        out.push({ text: line.text, ...(line.kind === undefined ? {} : { kind: line.kind }) });
      }
      return out;
    };
    if (typeof provider.name !== 'string' || provider.name.length === 0) {
      throw new PluginLifecycleError('register-capabilities', `${pluginId} 的 contextProviders 里有一项没有 name`);
    }
    // The dry run, while the plugin is being registered: a line that impersonates program policy
    // fails the plugin's load instead of quietly entering a later turn.
    filter(await provider.provide({ now: this.#now(), timezone: 'UTC', query: '' }));
    return { name: provider.name, provide: async (input) => filter(await provider.provide(input)) };
  }

  /**
   * Step 7 in detail. Two halves: the manifest's declared requirements must be live, and the
   * plugin's own `health()` (when it exports one) must answer with a known status.
   */
  async #runHealth(manifest: PluginManifest, module: PluginModuleShape, runtime: Runtime): Promise<PluginHealthReport> {
    const declared: PluginManifestHealth = manifest.health ?? {};
    const missing = (declared.requires ?? []).filter((requirement) => !this.#capabilityExists(manifest.id, requirement));
    if (missing.length > 0) {
      throw new PluginLifecycleError('health', `${manifest.id} 声明要活着的能力找不到：${missing.join('、')}`);
    }
    const hook: PluginHealthHook | undefined = typeof module.health === 'function' ? module.health : undefined;
    const at = this.#now().toISOString();
    if (hook === undefined) {
      return { status: 'ok', at, detail: declared.requires === undefined ? '未声明 health 钩子' : '声明的能力都在' };
    }
    const reported = await hook();
    if (reported === undefined || !['ok', 'degraded', 'down'].includes(reported.status)) {
      throw new PluginLifecycleError('health', `${manifest.id} 的 health() 返回值不合法`);
    }
    return { status: reported.status, at, ...(reported.detail === undefined ? {} : { detail: reported.detail }) };
  }

  /** A declared requirement may name a capability as `kind:name` or just `name`. */
  #capabilityExists(pluginId: string, requirement: string): boolean {
    if (requirement.includes(':')) {
      const [kind, name] = requirement.split(':');
      return kind !== undefined && name !== undefined && this.#registry.has(kind as PluginCapability, name);
    }
    return this.#registry.list().some((entry) => entry.pluginId === pluginId && entry.name === requirement);
  }

  /**
   * Step 8 — `deactivate`: release the capabilities, then run the plugin's own hook.
   *
   * The running state (capabilities **and** health) is dropped *before* the plugin's hook runs, so a
   * hook that throws leaves `failed` — a state that is honestly not running — instead of `failed`
   * with a health report still claiming it is online (P2.5-I ②).
   */
  async deactivate(pluginId: string): Promise<boolean> {
    const runtime = this.#runtimes.get(pluginId);
    if (runtime === undefined) return false;
    if (runtime.state !== 'active') return false;
    try {
      const released = this.#stopRunning(runtime);
      await runtime.module?.deactivate?.();
      runtime.state = 'inactive';
      this.#push(pluginId, 'deactivate', 'ok', `释放了 ${released} 项能力`);
      return true;
    } catch (cause) {
      runtime.state = 'failed';
      this.#push(pluginId, 'deactivate', 'failed', cause instanceof Error ? cause.message : String(cause));
      throw fail('deactivate', cause);
    }
  }

  /** Step 5 again — `activate` after `deactivate`, on a fresh capability bundle. */
  async activate(pluginId: string): Promise<PluginInstance> {
    // 同 `loadPlugin` / `loadInline`：内核 dispose 之后不许再把任何插件变成 active ——
    // 否则 `disposeAll()` 跑过的 deactivate/dispose 钩子会被绕过，插件层「关停了还能复活」。
    if (this.#disposed) throw new PluginLifecycleError('activate', `${pluginId}：插件管理器已经 dispose，不再接受激活`);
    const runtime = this.#runtimes.get(pluginId);
    if (runtime === undefined) throw new PluginLifecycleError('activate', `没有这个插件：${pluginId}`);
    // Already running: this entry point is the idempotent one (the repeat-start refusals live in
    // `#pipeline`, which a running plugin never reaches).
    if (runtime.state === 'active') return this.#view(runtime);
    const discovered = runtime.discovered ?? this.#discovered.get(pluginId);
    if (discovered === undefined) throw new PluginLifecycleError('activate', `没有这个插件的来源：${pluginId}`);
    return this.#pipeline(discovered, 'activate');
  }

  /** Step 9 — `dispose`: run step 8 first (`deactivate`), then let the plugin tear itself down. */
  async dispose(pluginId: string): Promise<boolean> {
    const runtime = this.#runtimes.get(pluginId);
    if (runtime === undefined) return false;
    if (runtime.state === 'disposed') return false;

    // 先走第 8 步、再走第 9 步 —— 这正是本文件顶部那条生命周期（… → health → deactivate → dispose）。
    // 以前这里直接 `#stopRunning` + `dispose`、跳过第 8 步：能力确实被释放了（`#stopRunning` 是幂等的），
    // 但**只在 `deactivate` 里做清理的插件那个钩子永远不会跑**（例如 `xixi.news` 的 `live.length = 0`）。
    // P2.5-K 的真入口验收探针实测到钩子序列是 activate→dispose、`deactivateRan: false`，与文档契约不符。
    // `deactivate()` 自己判断 `state !== 'active'`（已经停过的插件不会重复跑钩子），失败路径也不伪造这一步。
    //
    // 第 8 步**抛了也要继续走第 9 步**：两个钩子释放的可能是不同的东西（连接 vs 定时器），一个失败不能
    // 让另一个也不跑——所以这里记下错误、把 dispose 钩子跑完，再把错误抛出去（宿主仍能看到失败）。
    let step8Error: unknown;
    try {
      await this.deactivate(pluginId);
    } catch (cause) {
      step8Error = cause;
    }

    try {
      // 到这里能力已经由第 8 步释放；`released` 只用于报告（`deactivate()` 内部已经报过一次）。
      const released = runtime.capabilities.length;
      await runtime.module?.dispose?.();
      runtime.state = 'disposed';
      this.#push(pluginId, 'dispose', 'ok', `释放了 ${released} 项能力`);
    } catch (cause) {
      runtime.state = 'failed';
      this.#push(pluginId, 'dispose', 'failed', cause instanceof Error ? cause.message : String(cause));
      throw fail('dispose', cause);
    }

    if (step8Error !== undefined) {
      // 第 9 步成功了、第 8 步失败了：状态是 disposed，但失败必须让宿主看见。
      throw fail('deactivate', step8Error);
    }
    return true;
  }

  /** Dispose every plugin (shutdown). One failure must not strand the rest. */
  async disposeAll(): Promise<number> {
    let count = 0;
    for (const pluginId of [...this.#runtimes.keys()]) {
      try {
        if (await this.dispose(pluginId)) count += 1;
      } catch {
        this.#push(pluginId, 'dispose', 'failed', 'disposeAll 期间失败，继续处理其余插件');
      }
    }
    this.#disposed = true;
    return count;
  }

  /** Re-run the health check for every active plugin (the `health` step's on-demand form). */
  async checkHealth(): Promise<readonly PluginHealthReport[]> {
    const out: PluginHealthReport[] = [];
    for (const runtime of this.#runtimes.values()) {
      if (runtime.state !== 'active' || runtime.module === undefined) continue;
      try {
        const report = await this.#runHealth(runtime.manifest, runtime.module, runtime);
        runtime.health = report;
        this.#push(runtime.manifest.id, 'health', 'ok', `复查：${report.status}`);
        out.push(report);
      } catch (cause) {
        const report: PluginHealthReport = {
          status: 'down',
          at: this.#now().toISOString(),
          detail: cause instanceof Error ? cause.message : String(cause),
        };
        runtime.health = report;
        this.#push(runtime.manifest.id, 'health', 'failed', `复查失败：${report.detail ?? ''}`);
        out.push(report);
      }
    }
    return out;
  }

  /**
   * The plugin stops running here: its capability registrations are released **and** its health
   * report is dropped (P2.5-I ②).
   *
   * Both halves belong together. Keeping the report after `deactivate`/`dispose` is how a panel ended
   * up showing 「ok」 / 「1 个 MCP 工具在线」 about a plugin that was not running — the same lie as a
   * stale state, one field over. Dropping it (rather than minting an 「offline」 status) keeps `health`
   * meaning 「the last report about a plugin that was running」, with `PluginInstance.online` saying
   * which case a reader is in.
   *
   * Returns how many capability registrations were released.
   */
  #stopRunning(runtime: Runtime): number {
    const released = this.#releaseCapabilities(runtime);
    runtime.health = undefined;
    return released;
  }

  /** Release the capability registrations this activation owns. Returns how many were released. */
  #releaseCapabilities(runtime: Runtime): number {
    const released = runtime.capabilities.length;
    const before = [...runtime.capabilities];
    runtime.activation.dispose();
    runtime.capabilities = [];
    for (const name of before) {
      const [kind, capability] = name.split(':');
      this.#audit(runtime.manifest.id, { kind: 'capability', action: 'disposed', capability: kind ?? 'unknown', name: capability ?? '' });
    }
    return released;
  }

  /** Undo a half-finished activation. Adds no journal entries: the failure is already recorded. */
  async #rollback(runtime: Runtime): Promise<void> {
    // Same invariant as `deactivate`: a plugin that is not running has no capabilities and no
    // health report (P2.5-I ②) — otherwise a failed re-activation would leave the previous
    // report standing about a plugin that no longer runs.
    this.#stopRunning(runtime);
    runtime.state = 'inactive';
    try {
      await runtime.module?.deactivate?.();
    } catch {
      // The failure that sent us here is the one worth reporting.
    }
  }

  /** The host a plugin sees: the storage surface exists only when `storage` was granted. */
  #hostFor(manifest: PluginManifest, granted: ReadonlySet<string>): PluginHost {
    if (!granted.has('storage')) return this.#host;
    const base: PluginHost = this.#host;
    const backing: PluginStorage = base.storage ?? memoryStorage();
    return { ...base, storage: backing };
  }

  #ensure(discovered: DiscoveredPlugin, manifest: PluginManifest | undefined): Runtime {
    const existing = this.#runtimes.get(discovered.id);
    if (existing !== undefined) {
      if (manifest !== undefined) existing.manifest = manifest;
      existing.discovered = discovered;
      return existing;
    }
    const runtime: Runtime = {
      manifest: manifest ?? { schemaVersion: 1, id: discovered.id, name: discovered.name, version: '0.0.0' },
      state: manifest === undefined ? 'discovered' : 'validated',
      capabilities: [],
      health: undefined,
      error: undefined,
      journal: [],
      activationCount: 0,
      activation: new DisposableBundle(),
      module: undefined,
      discovered,
      loader: this.#loader ?? importModule,
    };
    this.#runtimes.set(discovered.id, runtime);
    return runtime;
  }

  /**
   * P2.5-I ① — refuse a repeated start.
   *
   * The refusal goes to the **audit** stream (the host keeps that, so a double start is visible even
   * if the throw is swallowed) but deliberately not into the plugin's journal and not into its state:
   * the journal records which lifecycle steps ran, and marking a running plugin `failed` here would
   * be exactly the lie this task is about.
   */
  #refuseStart(entry: string, pluginId: string, detail: string): PluginAlreadyStartedError {
    this.#audit(pluginId, { kind: 'lifecycle', step: 'load', outcome: 'failed', detail });
    return new PluginAlreadyStartedError(entry, pluginId, detail);
  }

  #push(pluginId: string, step: PluginLifecycleStep, outcome: 'ok' | 'failed', detail?: string): void {
    const runtime = this.#runtimes.get(pluginId) ?? this.#ensure({ id: pluginId, name: pluginId, manifest: undefined }, undefined);
    const state: PluginState = outcome === 'failed' ? 'failed' : stepState(step);
    if (outcome === 'failed') runtime.error = detail;
    // `deactivate`/`dispose` set the state themselves before journaling; every other step's state
    // *is* the state this record reports.
    if (step !== 'deactivate' && step !== 'dispose') runtime.state = state;
    runtime.journal.push({
      step,
      state: step === 'deactivate' || step === 'dispose' ? runtime.state : state,
      outcome,
      at: this.#now().toISOString(),
      ...(detail === undefined ? {} : { detail }),
    });
    this.#audit(pluginId, { kind: 'lifecycle', step, outcome, ...(detail === undefined ? {} : { detail }) });
  }

  #audit(pluginId: string, event: PluginAuditEvent): void {
    const record: PluginAuditRecord = { pluginId, at: this.#now().toISOString(), event };
    this.#auditLog.push(record);
    this.#host.audit?.(record);
  }

  #view(runtime: Runtime): PluginInstance {
    return {
      pluginId: runtime.manifest.id,
      manifest: runtime.manifest,
      state: runtime.state,
      // Derived, never stored: `online` cannot drift away from the state it describes.
      online: runtime.state === 'active',
      capabilities: [...runtime.capabilities],
      health: runtime.health,
      error: runtime.error,
      journal: [...runtime.journal],
      activationCount: runtime.activationCount,
    };
  }
}

/** A per-plugin in-memory store, used when the host granted `storage` but wired no backing store. */
function memoryStorage(): PluginStorage {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => void values.set(key, value),
    delete: (key) => values.delete(key),
    keys: () => [...values.keys()],
  };
}

/** Convenience: a source over plugins the host already holds (what most tests want). */
export function inlinePluginSource(plugins: readonly InlinePlugin[]): PluginSource {
  return new InlinePluginSource(plugins);
}

/** Convenience: a tool spec from a bare `AgentTool`, so a fixture reads short. */
export function pluginTool(tool: AgentTool): PluginToolSpec {
  return { tool };
}

/** Re-exported for callers that only need the file source (e.g. a deployment's plugin directory). */
export { FilePluginSource, InlinePluginSource };

/** The tool view a plugin holds: registration and asking, never execution. */
export type { PluginToolView } from './context.ts';

/** Permission keys, exported so a host can name them without importing the context module. */
export const PLUGIN_PERMISSION_KEYS: readonly PluginPermissionKey[] = PERMISSION_KEYS;

/** Everything the host assembles once and then keeps. */
export interface PluginRuntime {
  readonly manager: PluginManager;
  readonly capabilities: CapabilityRegistry;
  readonly corePrompt: CorePromptAuthority;
  readonly permission: PluginHost['capabilities']['permission'];
  /** Load every configured source and bring up what can be brought up. Call it **once** (P2.5-I ①):
   * a second call is refused rather than re-run; cycling one plugin goes through the manager. */
  start(): Promise<readonly PluginInstance[]>;
  /** Shut everything down: deactivate, release, dispose. */
  stop(): Promise<number>;
}

export interface CreatePluginRuntimeOptions {
  readonly tools: ToolRegistry;
  readonly permission: PluginHost['capabilities']['permission'];
  readonly sources?: readonly PluginSource[];
  readonly inline?: readonly InlinePlugin[];
  readonly pluginDirectory?: string;
  readonly audit?: PluginHost['audit'];
  readonly storage?: PluginStorage;
  readonly fetchImpl?: typeof fetch;
  readonly notify?: (text: string) => void;
  readonly now?: () => Date;
  readonly loader?: PluginModuleLoader;
  readonly pluginToolScopes?: readonly AgentScope[];
  readonly corePrompt?: CorePromptAuthority;
}

/**
 * The assembly point: create the runtime, then wire the tool registry into it.
 *
 * The host keeps the *core* `ToolRegistry` (it is what runs tools); a plugin only ever sees the
 * read-only view the manager builds per activation. `mount()` returns a Disposable like everything
 * else, so unmounting releases the registry without disposing the registry itself.
 */
export function createPluginRuntime(options: CreatePluginRuntimeOptions): PluginRuntime {
  const sources: PluginSource[] = [...(options.sources ?? [])];
  if (options.inline !== undefined && options.inline.length > 0) sources.push(new InlinePluginSource(options.inline));
  if (options.pluginDirectory !== undefined) sources.push(new FilePluginSource(options.pluginDirectory, options.loader === undefined ? {} : { loader: options.loader }));

  const host: PluginHost = {
    tools: options.tools,
    capabilities: new CapabilityRegistry({
      permission: options.permission,
      ...(options.pluginToolScopes === undefined ? {} : { pluginToolScopes: options.pluginToolScopes }),
    }),
    corePrompt: options.corePrompt ?? CORE_PROMPT_AUTHORITY,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.notify === undefined ? {} : { notify: options.notify }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };

  const manager = new PluginManager({
    sources,
    host,
    ...(options.loader === undefined ? {} : { loader: options.loader }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    manager,
    capabilities: manager.capabilities,
    corePrompt: host.corePrompt,
    permission: options.permission,
    start: () => manager.loadAll(),
    stop: () => manager.disposeAll(),
  };
}

/**
 * Mount a plugin's registered tools into the core `ToolRegistry`.
 *
 * The direction matters: capabilities are registered into the plugin `CapabilityRegistry` first
 * (where the manifest and permission checks live), and this is the one step that copies them into
 * the registry the model actually sees. Each copy is a Disposable, so unmounting really unmounts —
 * and what is copied is the tool itself, so the core's permission check applies unchanged.
 */
export function mountPluginTools(registry: ToolRegistry, capabilities: CapabilityRegistry, pluginId?: string): Disposable {
  const mounted = new DisposableBundle();
  const owned = pluginId === undefined ? undefined : new Set(capabilities.list().filter((entry) => entry.pluginId === pluginId).map((entry) => `${entry.kind}:${entry.name}`));
  for (const spec of capabilities.values<PluginToolSpec>('tool')) {
    if (owned !== undefined && !owned.has(`tool:${spec.tool.name}`)) continue;
    mounted.add(registry.register(spec.tool));
  }
  return mounted;
}
