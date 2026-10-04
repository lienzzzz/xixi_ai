/**
 * `CapabilityRegistry` — pack `03_AGENT_PLUGIN.md` §1/§2/§3.
 *
 * The registry is the one place a plugin's capability becomes visible to 西西, and it is
 * deliberately narrow:
 *
 *  * **five kinds, no free-form strings.** `tool`, `topic_source`, `context_provider`,
 *    `sensor_source`, `action` — the type union is the pack's list, so a plugin cannot invent a
 *    sixth way into the agent.
 *  * **every registration returns a Disposable** (§3). The reverse direction is a first-class
 *    operation, which is what makes 「dispose 后能力不再可用」 observable rather than a promise.
 *  * **names are unique across plugins.** Two plugins registering `news.latest` is a conflict,
 *    refused at registration time — not a silent "last one wins".
 *  * **the `xixi_` namespace is the core's.** A plugin tool named `xixi_system_prompt_set` is
 *    refused here, before any registry could be asked to run it.
 */
import type { AgentScope, AgentTool, ToolPermissionPolicy } from '@xixi/brain-adapter';

import { toRegistration, type Disposable } from './disposal.ts';
import { PluginError, PluginPermissionError } from './errors.ts';
import { CAPABILITY_PERMISSIONS, type PluginCapability } from './manifest.ts';

/** One tool a plugin contributes, plus who owns it. */
export interface PluginToolSpec {
  readonly tool: AgentTool;
}

/** One candidate topic for a proactive turn (pack `07_PROACTIVE.md` reads these as candidates). */
export interface TopicCandidate {
  readonly topic: string;
  readonly reason: string;
  readonly score?: number;
  readonly source?: string;
}

/** A capability that can propose what to talk about. It never decides — the engine does. */
export interface TopicSource {
  readonly name: string;
  /** A plain function, not a closure over program state: the engine owns ranking and gating. */
  propose(input: { readonly now: Date; readonly timezone: string; readonly limit: number }): Promise<readonly TopicCandidate[]> | readonly TopicCandidate[];
}

/** One line a plugin offers for a turn's context. The host decides where (and whether) it lands. */
export interface ContextLine {
  readonly text: string;
  readonly kind?: string;
}

/** A capability that offers context lines. Nothing here can reach the system prompt. */
export interface ContextProvider {
  readonly name: string;
  provide(input: { readonly now: Date; readonly timezone: string; readonly query: string }): Promise<readonly ContextLine[]> | readonly ContextLine[];
}

/**
 * A **filtered** perception event. Deliberately not a frame and not an audio buffer: 铁律 6 keeps
 * continuous media local, and pack §3 forbids raw camera/mic access. What a plugin may see is
 * what the perception edge already turned into an event.
 */
export interface SensorEvent {
  readonly type: string;
  readonly at: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A capability that receives filtered sensor events (never a device). */
export interface SensorSource {
  readonly name: string;
  onEvent(event: SensorEvent): Promise<void> | void;
}

/** An outbound action a plugin offers. It runs *through* the host, and `ask` means a person confirms. */
export interface ActionHandler {
  readonly name: string;
  readonly approval?: 'none' | 'ask';
  perform(input: { readonly args: Readonly<Record<string, unknown>>; readonly now: Date }): Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
}

export interface CapabilityRegistration {
  readonly pluginId: string;
  readonly kind: PluginCapability;
  readonly name: string;
}

/** Names starting with these prefixes belong to the program, not to plugins (§3 boundary `tool-permission`). */
export const RESERVED_TOOL_PREFIXES: readonly string[] = ['xixi_', 'core.'];

/** Exact names reserved wherever a plugin might try to take them. */
export const RESERVED_CAPABILITY_NAMES: readonly string[] = ['core.system-prompt', 'core.permission-policy'];

function assertNameFree(kind: PluginCapability, name: string): void {
  if (name.trim().length === 0) throw new PluginError('PLUGIN_CAPABILITY_CONFLICT', `${kind} 的名字不能是空串`);
  if (RESERVED_CAPABILITY_NAMES.includes(name)) {
    throw new PluginError('PLUGIN_RESERVED_NAME', `${kind} 的「${name}」是核心自己持有的能力名（pack §3）`);
  }
  if (kind === 'tool' && RESERVED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new PluginError(
      'PLUGIN_RESERVED_NAME',
      `工具名「${name}」落在核心保留前缀 ${RESERVED_TOOL_PREFIXES.join('/')} 上：插件工具必须用自己的命名空间`,
    );
  }
}

export interface CapabilityRegistryOptions {
  /** The policy every registered tool is re-checked against. The registry never runs a tool itself. */
  readonly permission: ToolPermissionPolicy;
  /** The scopes a plugin-registered tool may declare. Narrower than the core's on purpose. */
  readonly pluginToolScopes?: readonly AgentScope[];
}

interface Entry<T> {
  readonly pluginId: string;
  readonly value: T;
}

const ALL_KINDS = ['tool', 'topic_source', 'context_provider', 'sensor_source', 'action'] as const;

/**
 * The registry itself. There is no `execute` here on purpose: a plugin registers a tool and the
 * core's `ToolRegistry` is what runs it, so the permission check cannot be skipped by a plugin.
 */
export class CapabilityRegistry {
  readonly #entries = new Map<PluginCapability, Map<string, Entry<unknown>>>();
  readonly #permission: ToolPermissionPolicy;
  readonly #pluginToolScopes: readonly AgentScope[];

  constructor(options: CapabilityRegistryOptions) {
    this.#permission = options.permission;
    this.#pluginToolScopes = options.pluginToolScopes ?? ['conversation'];
    for (const kind of ALL_KINDS) this.#entries.set(kind, new Map());
  }

  /** The policy the core uses. Exposed so a plugin can *ask* — never so it can replace it. */
  get permission(): ToolPermissionPolicy {
    return this.#permission;
  }

  /** The scopes a plugin tool may live in; the plugin context uses it to explain a refusal. */
  get pluginToolScopes(): readonly AgentScope[] {
    return this.#pluginToolScopes;
  }

  #map<T>(kind: PluginCapability): Map<string, Entry<T>> {
    const map = this.#entries.get(kind);
    if (map === undefined) throw new PluginError('PLUGIN_CAPABILITY_CONFLICT', `未知能力类型：${kind}`);
    return map as Map<string, Entry<T>>;
  }

  #add<T>(kind: PluginCapability, name: string, pluginId: string, value: T): Disposable {
    assertNameFree(kind, name);
    const map = this.#map<T>(kind);
    const existing = map.get(name);
    if (existing !== undefined) {
      throw new PluginError(
        'PLUGIN_CAPABILITY_CONFLICT',
        `${kind}「${name}」已经被 ${existing.pluginId} 注册，${pluginId} 不能再注册同名能力`,
      );
    }
    map.set(name, { pluginId, value });
    return toRegistration(() => {
      // Only remove what this registration put there: a later owner must not be evicted by a stale handle.
      if (map.get(name)?.pluginId === pluginId) map.delete(name);
    });
  }

  /** Register a plugin tool. The core `ToolRegistry` still owns whether it may ever run. */
  registerTool(pluginId: string, spec: PluginToolSpec): Disposable {
    const tool = spec.tool;
    const outOfScope = tool.scopes.filter((scope) => !this.#pluginToolScopes.includes(scope));
    if (tool.scopes.length === 0 || outOfScope.length > 0) {
      throw new PluginPermissionError(
        'scope',
        `工具 ${tool.name} 声明的场景「${tool.scopes.join('、')}」超出插件可用的场景「${this.#pluginToolScopes.join('、')}」`,
      );
    }
    return this.#add<PluginToolSpec>('tool', tool.name, pluginId, { tool });
  }

  registerTopicSource(pluginId: string, source: TopicSource): Disposable {
    return this.#add('topic_source', source.name, pluginId, source);
  }

  registerContextProvider(pluginId: string, provider: ContextProvider): Disposable {
    return this.#add('context_provider', provider.name, pluginId, provider);
  }

  registerSensorSource(pluginId: string, source: SensorSource): Disposable {
    return this.#add('sensor_source', source.name, pluginId, source);
  }

  registerAction(pluginId: string, action: ActionHandler): Disposable {
    return this.#add('action', action.name, pluginId, action);
  }

  /**
   * The lifecycle's「register capabilities」step. Each contributed capability is checked against
   * the **manifest** first — a capability the manifest did not declare, or one whose permission
   * was not granted, is refused *before* it exists.
   *
   * Refusal unwinds what this call already registered, so a half-mounted plugin leaves nothing
   * behind for the caller to hunt down.
   */
  registerContribution(
    pluginId: string,
    declared: readonly PluginCapability[],
    granted: ReadonlySet<string>,
    contribution: PluginContribution,
  ): readonly Disposable[] {
    const registered: Disposable[] = [];
    const attempt = (kind: PluginCapability, name: string, register: () => Disposable): void => {
      if (!declared.includes(kind)) {
        throw new PluginPermissionError(kind, `${pluginId} 没有在 manifest 里声明 ${kind} 能力，不能注册「${name}」`);
      }
      const missing = CAPABILITY_PERMISSIONS[kind].filter((permission) => !granted.has(permission));
      if (missing.length > 0) {
        throw new PluginPermissionError(
          missing.join('、'),
          `${pluginId} 注册 ${kind}「${name}」需要 ${missing.join('、')} 权限，manifest 没有授予`,
        );
      }
      registered.push(register());
    };

    try {
      for (const spec of contribution.tools ?? []) attempt('tool', spec.tool.name, () => this.registerTool(pluginId, spec));
      for (const source of contribution.topicSources ?? []) attempt('topic_source', source.name, () => this.registerTopicSource(pluginId, source));
      for (const provider of contribution.contextProviders ?? []) attempt('context_provider', provider.name, () => this.registerContextProvider(pluginId, provider));
      for (const source of contribution.sensorSources ?? []) attempt('sensor_source', source.name, () => this.registerSensorSource(pluginId, source));
      for (const action of contribution.actions ?? []) attempt('action', action.name, () => this.registerAction(pluginId, action));
    } catch (cause) {
      for (const disposable of [...registered].reverse()) disposable.dispose();
      throw cause;
    }
    return registered;
  }

  /** Everything registered, as `{kind, name}` pairs, sorted for stable assertions. */
  list(): CapabilityRegistration[] {
    const out: CapabilityRegistration[] = [];
    for (const kind of ALL_KINDS) {
      for (const [name, entry] of this.#map<unknown>(kind)) out.push({ pluginId: entry.pluginId, kind, name });
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
  }

  /** Names of one kind, for a caller that just wants to enumerate. */
  names(kind: PluginCapability): string[] {
    return [...this.#map<unknown>(kind).keys()];
  }

  has(kind: PluginCapability, name: string): boolean {
    return this.#map<unknown>(kind).has(name);
  }

  get<T>(kind: PluginCapability, name: string): T | undefined {
    return this.#map<T>(kind).get(name)?.value;
  }

  /** All values of one kind — the proactive engine reads topic sources through this. */
  values<T>(kind: PluginCapability): T[] {
    return [...this.#map<T>(kind).values()].map((entry) => entry.value);
  }

  /**
   * Who owns this name — `undefined` when nobody does.
   *
   * The ownership question is asked *before* anything is released: 「这个插件能不能释放这个名字」 is a
   * question about the registry's records, not about the caller's goodwill.
   */
  ownerOf(kind: PluginCapability, name: string): string | undefined {
    return this.#map<unknown>(kind).get(name)?.pluginId;
  }

  /**
   * Release one capability **this plugin owns**, and only that one.
   *
   * Same ownership check as `#add`'s closure, asked of an explicit `(pluginId, name)` pair: an entry
   * that belongs to someone else — or to nobody — is left exactly where it is and the caller is told
   * `false`. Nothing here can touch a core tool, because core tools are not in this registry at all.
   */
  release(pluginId: string, kind: PluginCapability, name: string): boolean {
    const map = this.#map<unknown>(kind);
    const entry = map.get(name);
    if (entry === undefined || entry.pluginId !== pluginId) return false;
    map.delete(name);
    return true;
  }

  /** Disposables for every capability one plugin owns — the deactivate/dispose path. */
  disposablesOf(pluginId: string): Disposable[] {
    const disposables: Disposable[] = [];
    for (const kind of ALL_KINDS) {
      const map = this.#map<unknown>(kind);
      for (const [name, entry] of [...map.entries()]) {
        if (entry.pluginId !== pluginId) continue;
        disposables.push(toRegistration(() => map.delete(name)));
      }
    }
    return disposables;
  }
}

/** What an activation hands back; every field is optional. */
export interface PluginContribution {
  readonly tools?: readonly PluginToolSpec[];
  readonly topicSources?: readonly TopicSource[];
  readonly contextProviders?: readonly ContextProvider[];
  readonly sensorSources?: readonly SensorSource[];
  readonly actions?: readonly ActionHandler[];
}
