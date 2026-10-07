/**
 * The plugin layer's declaration face — V0.3 P2.5-H (pack `03_AGENT_PLUGIN.md` §1/§4/§6,
 * `XIXI_CURRENT_REVIEW_AND_NEXT_PLAN_2026-10-07.md` §13).
 *
 * Before this file, `config/xixi.example.yaml`'s news block was **21 lines of comment** that said so
 * itself: 「这一段今天是注释，不是可调键 —— `parseXixiConfig` 不读它」. A deployment could edit a feed
 * URL, restart, and nothing would change. Here that section becomes real keys with one reader each,
 * and the whole subtree is parsed **strictly** rather than tolerantly.
 *
 * Three decisions make this file different from the tuning sections next to it
 * (`parseToolApprovalSettings`, `parseReminderSettings`, which fall back to defaults on a bad value):
 *
 *   1. **A bad value here is refused, not defaulted.** Those sections are knobs (a typo tightens or
 *      widens nothing) — this one decides **what runs**: a misspelled key, an unknown transport, a
 *      value out of range, an unresolvable URL. Silently defaulting would leave the operator with a
 *      config that looks set and does nothing, which is the exact failure this phase exists to
 *      remove. Every rejection names its path (`plugins.mcp.servers.weather.transport`).
 *   2. **The types hold data, never functions.** `McpServerSpec.connect` is a factory, and a YAML file
 *      cannot spell one; so the config carries 「命令或地址」 and the **assembly point** turns it into a
 *      connection (`packages/runtime/src/resident-runtime.ts` is that one layer). Nothing in this
 *      package imports the MCP SDK or a transport.
 *   3. **Precedence is「入口显式声明的优先，配置是部署默认」**，与 `resolveToolApprovalSettings` 同一条先例。
 *      A live entry that already hands the assembly point its own news/servers keeps them; the config
 *      fills the gap for the entries that declare nothing. Absent section = today's behaviour,
 *      byte for byte.
 *
 * Scope (V0.3): pre-installed native plugins (a directory of `plugin.json`s), the news plugin's
 * sources, configured MCP servers, and enable/disable. **No remote plugin marketplace**, and no
 * `json_api` / `web-search` news sources: those two families need a `map` function and a search
 * engine respectively, neither of which is a string, so a YAML key for them would be a key that
 * cannot work. `plugins.news.sources[].type` therefore accepts exactly `rss` and says why.
 */
import { DomainError } from './errors.ts';

/** `read` / `write` / `dangerous`, the core's own vocabulary (`AgentTool.risk`). */
export type PluginMcpRisk = 'read' | 'write' | 'dangerous';

/** The transport families a YAML file can name. `stdio` spawns a command, `http` dials a URL. */
export type PluginMcpTransportKind = 'stdio' | 'http';

/**
 * One news source the deployment declares.
 *
 * Only RSS: `createNewsPlugin` also accepts a public-JSON-API source and a web-search adapter, but
 * both take **behaviour** (a mapper, an engine) rather than a URL, so they belong to a native plugin
 * (`packages/plugins/news/*`) rather than to a config key.
 */
export interface PluginNewsSourceSetting {
  /** The feed URL. Absolute `http(s)`; validated when the config is parsed. */
  readonly url: string;
  /** Provenance name shown in payloads and health lines. Default: the URL's host. */
  readonly name: string;
}

/**
 * `plugins.news` — the deployment's default news.
 *
 * `enabled: false` means 「这个部署的默认：没有自带来源的入口不要新闻」; a live entry that declares its own
 * sources keeps them (the precedence above). To take the whole plugin layer down, use
 * `plugins.enabled: false`.
 */
export interface PluginNewsSetting {
  readonly enabled: boolean;
  readonly sources: readonly PluginNewsSourceSetting[];
  /** What the household cares about (`news.for_interests` ranks by it). */
  readonly interests: readonly string[];
}

interface PluginMcpServerBase {
  /** Namespace segment: this server's tools become `mcp.<name>.<tool>`. */
  readonly name: string;
  /** `false` keeps the server in the config but out of the kernel: no connection, no advertised tool. */
  readonly enabled: boolean;
  /**
   * What this server's tools may do — the **operator's** declaration, never the server's own claim
   * (铁律 1/8). Default `read`. A `dangerous` server is refused by the core policy on every call
   * (铁律 7), so declaring it is honest but useless.
   */
  readonly risk: PluginMcpRisk;
  /** Per-request ceiling in ms; `null` = the adapter's own default. */
  readonly timeoutMs: number | null;
}

/** A command this machine spawns (`StdioClientTransport`), the form `transport: stdio` uses. */
export interface PluginStdioMcpServer extends PluginMcpServerBase {
  readonly transport: 'stdio';
  /** Executable to run. Required for `stdio`, refused for `http`. */
  readonly command: string;
  readonly args: readonly string[];
}

/** A URL this machine dials (`StreamableHTTPClientTransport`), the form `transport: http` uses. */
export interface PluginHttpMcpServer extends PluginMcpServerBase {
  readonly transport: 'http';
  /** Absolute `http(s)` endpoint. Required for `http`, refused for `stdio`. */
  readonly url: string;
}

export type PluginMcpServerSetting = PluginStdioMcpServer | PluginHttpMcpServer;

/**
 * The parsed `plugins` section.
 *
 * Two fields use an empty value to mean「配置没管这一层」(so the entry's own declaration applies),
 * because that is exactly how the two live consumers behave today:
 *
 *  * `news: null` — the section was not written; an entry that brings its own news keeps it and an
 *    entry that brings none has none (today: the console and the trial page have no news, the CLI
 *    entries carry their own feeds);
 *  * `mcpServers: []` — no server declared. No live entry declares any today, so this is where a
 *    deployment's MCP servers actually come from.
 */
export interface PluginSettings {
  /** `plugins.enabled` — master switch for the whole plugin layer (news, MCP, directories, inline). */
  readonly enabled: boolean;
  /** `plugins.directories` — directories of pre-installed native plugins (`plugin.json` each). */
  readonly directories: readonly string[];
  readonly news: PluginNewsSetting | null;
  readonly mcpServers: readonly PluginMcpServerSetting[];
}

/** Absent `plugins` section = today's behaviour: the layer is on and declares nothing of its own. */
export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = Object.freeze({
  enabled: true,
  directories: Object.freeze([]) as readonly string[],
  news: null,
  mcpServers: Object.freeze([]) as readonly PluginMcpServerSetting[],
});

/** Longest server name accepted: the namespace `mcp.<name>.<tool>` has to stay readable back. */
export const MCP_SERVER_NAME_MAX_CHARS = 32;

/** Per-request ceiling bounds. Below a second is a guaranteed timeout; above ten minutes nothing waits. */
export const MCP_TIMEOUT_MS_MIN = 1_000;
export const MCP_TIMEOUT_MS_MAX = 600_000;

function fail(problem: string, file: string): never {
  throw new DomainError('INVALID_CONFIG', `configuration is not usable: ${problem}`, file);
}

function mapping(value: unknown, path: string, file: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`"${path}" must be a mapping`, file);
  return value as Record<string, unknown>;
}

/**
 * A key this section does not know is **refused**, unlike the tuning sections: `news.source` next to
 * `news.sources` would otherwise be a line the operator believes is doing something.
 */
function knownKeys(parent: Record<string, unknown>, path: string, allowed: readonly string[], file: string): void {
  for (const key of Object.keys(parent)) {
    if (!allowed.includes(key)) {
      fail(`"${path}.${key}" is not a key of this section (known: ${allowed.join(', ')})`, file);
    }
  }
}

function requiredString(value: unknown, path: string, file: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`"${path}" must be a non-empty string`, file);
  return value.trim();
}

function booleanAt(parent: Record<string, unknown>, key: string, path: string, file: string, fallback: boolean): boolean {
  const value = parent[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`"${path}.${key}" must be a boolean`, file);
  return value;
}

/** A list of non-empty strings, de-duplicated, order kept. `undefined`/`null` = absent = empty. */
function stringList(value: unknown, path: string, file: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`"${path}" must be a list`, file);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = requiredString(value[index], `${path}[${index}]`, file);
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** An absolute `http(s)` URL, returned trimmed. `example.com` is not one — the scheme is required. */
function httpUrl(value: unknown, path: string, file: string): string {
  const text = requiredString(value, path, file);
  let parsed: URL | null = null;
  try {
    parsed = new URL(text);
  } catch {
    parsed = null;
  }
  if (parsed === null || parsed.hostname.length === 0) fail(`"${path}" must be an absolute URL, got "${text}"`, file);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`"${path}" must be http or https, got "${parsed.protocol}"`, file);
  }
  return text;
}

/** A value that must not be there: the two transports take different keys, and a stray one is a typo. */
function forbidden(parent: Record<string, unknown>, key: string, path: string, why: string, file: string): void {
  if (parent[key] !== undefined) fail(`"${path}.${key}" must not be given: ${why}`, file);
}

/** A server name is one namespace segment, so it has to survive `mcp.<name>.<tool>` being read back. */
function mcpServerName(rawName: string, file: string): string {
  const name = rawName.trim();
  if (name.length === 0) fail('"plugins.mcp.servers" has a server without a name', file);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    fail(
      `"plugins.mcp.servers.${rawName}" is not a usable server name: it becomes the "mcp.<name>.<tool>" segment,` +
        ' so only ASCII letters, digits, "_" and "-" can appear in it',
      file,
    );
  }
  if (name.length > MCP_SERVER_NAME_MAX_CHARS) {
    fail(`"plugins.mcp.servers.${rawName}" is longer than ${MCP_SERVER_NAME_MAX_CHARS} characters`, file);
  }
  if (name.toLowerCase() === 'mcp') fail('"plugins.mcp.servers.mcp" would collide with the "mcp." namespace prefix', file);
  return name;
}

function mcpRisk(value: unknown, path: string, file: string): PluginMcpRisk {
  if (value === undefined) return 'read';
  if (value === 'read' || value === 'write' || value === 'dangerous') return value;
  fail(`"${path}" must be one of read, write, dangerous (got ${JSON.stringify(value)})`, file);
}

function mcpTimeoutMs(value: unknown, path: string, file: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail(`"${path}" must be a whole number of milliseconds`, file);
  }
  if (value < MCP_TIMEOUT_MS_MIN || value > MCP_TIMEOUT_MS_MAX) {
    fail(`"${path}" must be within [${MCP_TIMEOUT_MS_MIN}, ${MCP_TIMEOUT_MS_MAX}] ms, got ${value}`, file);
  }
  return value;
}

function parseNewsSources(raw: unknown, file: string): PluginNewsSourceSetting[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('"plugins.news.sources" must be a list', file);
  return raw.map((entry, index) => {
    const path = `plugins.news.sources[${index}]`;
    const source = mapping(entry, path, file);
    knownKeys(source, path, ['type', 'name', 'url'], file);
    const type = requiredString(source['type'], `${path}.type`, file);
    if (type !== 'rss') {
      fail(
        `"${path}.type" must be "rss": an RSS/Atom feed is the only news family a YAML file can spell` +
          ' (a json_api source needs a map function, a web-search source needs a search engine — neither is a string)',
        file,
      );
    }
    const url = httpUrl(source['url'], `${path}.url`, file);
    const name = source['name'] === undefined ? new URL(url).host : requiredString(source['name'], `${path}.name`, file);
    return { url, name };
  });
}

function parseNews(raw: unknown, file: string): PluginNewsSetting {
  const news = mapping(raw, 'plugins.news', file);
  knownKeys(news, 'plugins.news', ['enabled', 'sources', 'interests'], file);
  const enabled = booleanAt(news, 'enabled', 'plugins.news', file, true);
  const sources = parseNewsSources(news['sources'], file);
  if (enabled && sources.length === 0) {
    fail(
      '"plugins.news" is enabled but names no source: the news plugin would advertise news.search / news.latest /' +
        ' news.for_interests to the model and every call would answer "nothing today" — give it a source or set enabled: false',
      file,
    );
  }
  return { enabled, sources, interests: stringList(news['interests'], 'plugins.news.interests', file) };
}

function parseMcpServer(rawName: string, raw: unknown, file: string): PluginMcpServerSetting {
  const name = mcpServerName(rawName, file);
  const path = `plugins.mcp.servers.${name}`;
  const spec = mapping(raw, path, file);
  knownKeys(spec, path, ['enabled', 'transport', 'command', 'args', 'url', 'risk', 'timeout_ms'], file);
  const common = {
    name,
    enabled: booleanAt(spec, 'enabled', path, file, true),
    risk: mcpRisk(spec['risk'], `${path}.risk`, file),
    timeoutMs: mcpTimeoutMs(spec['timeout_ms'], `${path}.timeout_ms`, file),
  };
  const transport = spec['transport'];
  if (transport === undefined) {
    fail(`"${path}.transport" is required ("stdio" or "http"): it decides whether the connection spawns a command or dials a URL`, file);
  }
  if (transport === 'stdio') {
    forbidden(spec, 'url', path, 'a stdio server is reached by running `command`, not by dialing a URL', file);
    return {
      ...common,
      transport: 'stdio',
      command: requiredString(spec['command'], `${path}.command`, file),
      args: stringList(spec['args'], `${path}.args`, file),
    };
  }
  if (transport === 'http') {
    forbidden(spec, 'command', path, 'an http server is reached by `url`, not by spawning a command', file);
    forbidden(spec, 'args', path, 'an http server is reached by `url`, not by spawning a command', file);
    return { ...common, transport: 'http', url: httpUrl(spec['url'], `${path}.url`, file) };
  }
  fail(`"${path}.transport" must be "stdio" or "http", got ${JSON.stringify(transport)}`, file);
}

function parseMcpServers(raw: unknown, file: string): PluginMcpServerSetting[] {
  if (raw === undefined || raw === null) return [];
  const mcp = mapping(raw, 'plugins.mcp', file);
  knownKeys(mcp, 'plugins.mcp', ['servers'], file);
  const servers = mcp['servers'];
  if (servers === undefined || servers === null) return [];
  const entries = Object.entries(mapping(servers, 'plugins.mcp.servers', file));
  return entries.map(([key, value]) => parseMcpServer(key, value, file));
}

/**
 * Parse the `plugins` section (strictly — see the file header for why).
 *
 * `raw` is what `xixi.plugins` held (or `undefined` when the section is absent, which is not an
 * error: it is the deployment that declares nothing, and every entry then keeps its own wiring).
 */
export function parsePluginSettings(raw: unknown, file = '<inline>'): PluginSettings {
  if (raw === undefined || raw === null) return DEFAULT_PLUGIN_SETTINGS;
  const plugins = mapping(raw, 'plugins', file);
  knownKeys(plugins, 'plugins', ['enabled', 'directories', 'news', 'mcp'], file);
  return {
    enabled: booleanAt(plugins, 'enabled', 'plugins', file, true),
    directories: stringList(plugins['directories'], 'plugins.directories', file),
    news: plugins['news'] === undefined ? null : parseNews(plugins['news'], file),
    mcpServers: parseMcpServers(plugins['mcp'], file),
  };
}
