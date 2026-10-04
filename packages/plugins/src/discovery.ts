/**
 * Discovery + loading — pack `03_AGENT_PLUGIN.md` §3 steps 1 and 4.
 *
 * Discovery is source-driven so the same lifecycle can be exercised against a directory on disk
 * or against a module the host already holds. The file source is the real one: it walks the given
 * directory for `plugin.json`, validates each manifest and *stops there* — nothing is imported
 * during discovery. That split is what makes step 3 (`permission`) meaningful: the manifest is
 * checked before any of the plugin's code has run.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseManifest } from './manifest.ts';

export const PLUGIN_MANIFEST_FILENAME = 'plugin.json';

/** A plugin the host knows about but has not validated yet. */
export interface DiscoveredPlugin {
  readonly id: string;
  readonly name: string;
  /** The manifest as read; `validate` is a separate step, so this may be invalid on purpose. */
  readonly manifest: unknown;
  /** Absolute path of the manifest, when it came from disk. */
  readonly manifestPath?: string;
  /** Directory the manifest's `entry` resolves against. */
  readonly root?: string;
  /** A module the host already holds; when present, `load` does not touch the filesystem. */
  readonly module?: PluginModule;
  /** Manifest parse failure, if discovery saw one — recorded instead of thrown, so one bad plugin cannot stop discovery. */
  readonly problem?: string;
}

/** One importable plugin module: a function (the activation shorthand) or a module object. */
export type PluginModule = PluginActivation | PluginModuleShape;

export interface PluginSource {
  readonly kind: string;
  discover(): DiscoveredPlugin[] | Promise<DiscoveredPlugin[]>;
}

/** Load one plugin module from disk. Swappable so a test never needs a real filesystem layout. */
export type PluginModuleLoader = (entryPath: string) => Promise<PluginModule>;

export interface LoadedModule {
  readonly module: PluginModule;
  /** What was actually imported (file URL or a marker for an in-memory module), for the journal. */
  readonly origin: string;
}

/** The runtime signature of what a plugin author writes. */
/**
 * Structural views of the plugin-side types, so this file does not import the whole package and
 * `@xixi/plugins` keeps a single dependency direction (`plugins → brain-adapter`, never back).
 */
export interface PluginContextLike {
  readonly pluginId: string;
  readonly log: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export interface PluginContributionLike {
  readonly tools?: readonly unknown[];
  readonly topicSources?: readonly unknown[];
  readonly contextProviders?: readonly unknown[];
  readonly sensorSources?: readonly unknown[];
  readonly actions?: readonly unknown[];
}

export interface PluginHealthLike {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly detail?: string;
}

/**
 * `unknown` on purpose: the manager hands the real `PluginContext`, while a test fixture may be
 * written against the structural `PluginContextLike`. A narrower parameter type would reject the
 * real one (two different `log` field types), and a cast would hide that.
 */
export type PluginActivation = (context: unknown) => PluginContributionLike | Promise<PluginContributionLike>;
export type PluginHook = () => void | Promise<void>;
export type PluginHealthHook = () => PluginHealthLike | Promise<PluginHealthLike>;

/** What a loaded plugin module may export. Everything past `activate` is optional. */
export interface PluginModuleShape {
  readonly activate?: PluginActivation;
  readonly deactivate?: PluginHook;
  readonly dispose?: PluginHook;
  readonly health?: PluginHealthHook;
}

/** Default loader: one dynamic import of the resolved entry. */
export const importModule: PluginModuleLoader = async (entryPath: string) => {
  const imported: unknown = await import(pathToFileURL(entryPath).href);
  return imported as PluginModule;
};

/** Source over a directory (recursively) or a single manifest file. */
export class FilePluginSource implements PluginSource {
  readonly kind = 'filesystem';
  readonly #path: string;
  readonly #loader: PluginModuleLoader;

  constructor(path: string, options: { readonly loader?: PluginModuleLoader } = {}) {
    this.#path = resolve(path);
    this.#loader = options.loader ?? importModule;
  }

  /** Exposed so the manager can load an entry without knowing where the source came from. */
  get loader(): PluginModuleLoader {
    return this.#loader;
  }

  discover(): DiscoveredPlugin[] {
    const found: DiscoveredPlugin[] = [];
    for (const manifestPath of findManifests(this.#path)) {
      found.push(readOne(manifestPath));
    }
    return found;
  }
}

/** A plugin the host already holds — no filesystem, no import. */
export interface InlinePlugin {
  readonly manifest: unknown;
  readonly module: PluginModule;
}

export class InlinePluginSource implements PluginSource {
  readonly kind = 'inline';
  readonly #plugins: readonly InlinePlugin[];

  constructor(plugins: readonly InlinePlugin[]) {
    this.#plugins = plugins;
  }

  discover(): DiscoveredPlugin[] {
    return this.#plugins.map((plugin) => {
      let id = '(未校验)';
      let name = '(未校验)';
      if (typeof plugin.manifest === 'object' && plugin.manifest !== null) {
        const record = plugin.manifest as Record<string, unknown>;
        if (typeof record['id'] === 'string') id = record['id'];
        if (typeof record['name'] === 'string') name = record['name'];
      }
      return { id, name, manifest: plugin.manifest, module: plugin.module };
    });
  }
}

/** Recursively collect every `plugin.json` under a path (used by discovery and by tests). */
export function findManifestsIn(path: string): string[] {
  return findManifests(resolve(path));
}

function findManifests(path: string): string[] {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return [];
  }
  if (stats.isFile()) return path.endsWith(PLUGIN_MANIFEST_FILENAME) ? [path] : [];
  const found: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) found.push(...findManifests(child));
    else if (entry.name === PLUGIN_MANIFEST_FILENAME) found.push(child);
  }
  return found.sort();
}

function readOne(manifestPath: string): DiscoveredPlugin {
  const fallbackId = manifestPath;
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (cause) {
    return { id: fallbackId, name: fallbackId, manifest: undefined, manifestPath, problem: `读不到 manifest：${cause instanceof Error ? cause.message : String(cause)}` };
  }
  let manifest: unknown;
  let problem: string | undefined;
  try {
    manifest = parseManifest(text, manifestPath);
  } catch (cause) {
    // Discovery must survive one broken manifest: `validate` is where it becomes a finding.
    manifest = safeParse(text);
    problem = cause instanceof Error ? cause.message : String(cause);
  }
  const record = (manifest ?? {}) as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'] : fallbackId;
  const name = typeof record['name'] === 'string' ? record['name'] : fallbackId;
  return {
    id,
    name,
    manifest,
    manifestPath,
    root: resolve(manifestPath, '..'),
    ...(problem === undefined ? {} : { problem }),
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the module for a discovered plugin, importing its entry when it has one.
 *
 * Refusals here are ordinary `Error`s on purpose: a missing entry is a *broken plugin*, not a
 * crossed boundary, and the manager records it as a failed `load` step.
 */
export async function loadPluginModule(discovered: DiscoveredPlugin, loader: PluginModuleLoader): Promise<LoadedModule> {
  if (discovered.module !== undefined) return { module: discovered.module, origin: `inline:${discovered.id}` };
  const raw = discovered.manifest;
  const entry = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['entry'] : undefined;
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error(`插件 ${discovered.id} 没有 entry，宿主也没有在内存里持有它的模块`);
  }
  if (discovered.root === undefined) throw new Error(`插件 ${discovered.id} 的 entry 无法解析：没有 manifest 所在目录`);
  const entryPath = isAbsolute(entry) ? entry : resolve(discovered.root, entry);
  return { module: await loader(entryPath), origin: entryPath };
}

/** Normalize whatever a module exported into the shape the lifecycle calls. */
export function asModuleShape(module: PluginModule): PluginModuleShape {
  if (typeof module === 'function') return { activate: module };
  if (typeof module === 'object' && module !== null) return module as PluginModuleShape;
  throw new Error('插件模块必须导出 activate 函数（或直接导出一个函数）');
}
