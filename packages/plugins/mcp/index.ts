/**
 * `@xixi/plugins/mcp` — pack `03_AGENT_PLUGIN.md` §4, the MCP client adapter.
 *
 * Kept as a **subpath** of the plugin package rather than folded into its root export, and that is a
 * dependency decision: this module is the only part of `@xixi/plugins` that needs the MCP SDK, so
 * `import '@xixi/plugins'` (the kernel: manifest validation, capability registry, lifecycle) stays
 * free of it. A deployment that runs no MCP servers pays nothing.
 *
 * Dependency surface (铁律 12), measured from the installed tree rather than remembered:
 * `@modelcontextprotocol/client@2.3.0` is a direct dependency and `@modelcontextprotocol/server@2.3.0`
 * a dev one (the stub server), and `npm install` added **13** entries to the lockfile —
 * `@modelcontextprotocol/{client,core,server}`, `cross-spawn`, `eventsource`, `eventsource-parser`,
 * `isexe`, `jose`, `path-key`, `pkce-challenge`, `shebang-command`, `shebang-regex`, `which`.
 * `zod` did **not** get a new entry: it was already in the tree at 4.6.5 (via `@deepseek-ai/dsh-tools`)
 * and the MCP client's requirement is now satisfied by that same copy. So the accurate statement is
 * 「zod 不是我们直接声明的依赖（我们用 SDK 的 `fromJsonSchema`，因此不必自己写 schema 校验），但它
 * 会作为传递依赖被装上，连同 jose 与 cross-spawn 与 eventsource 等」 — never 「没有 zod」.
 *
 * ```ts
 * const { plugin, adapter } = createMcpPlugin({
 *   servers: [{ name: 'weather', connect: () => new StdioClientTransport({ command: 'node', args: ['weather.js'] }) }],
 * });
 * await manager.loadInline(plugin.plugin);       // activate() discovers, namespaces and contributes
 * ```
 */
export {
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  MCP_MAX_DESCRIPTION_CHARS,
  McpClientAdapter,
  type McpAdapterOptions,
  type McpDiscoveredTool,
  type McpDiscoveryResult,
  type McpServerFailure,
  type McpServerSpec,
  type McpServerStatus,
} from './adapter.ts';
export { createSdkMcpClient, McpServerConnection, type McpConnectionOptions } from './connection.ts';
export { isMcpToolName, MCP_TOOL_PREFIX, MCP_TOOL_SEPARATOR, mcpServerSegment, mcpToolName, parseMcpToolName, type ParsedMcpToolName } from './naming.ts';
export { createMcpPlugin, DEFAULT_MCP_PLUGIN_ID, type McpPluginHandle, type McpPluginOptions } from './plugin.ts';
export {
  DEFAULT_MCP_MAX_TEXT_CHARS,
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_MCP_RETRY,
  isRecord,
  McpConnectionError,
  McpNamingError,
  type McpCallRequest,
  type McpCallResult,
  type McpClientLike,
  type McpConnectionEvent,
  type McpConnectionEventKind,
  type McpConnectionState,
  type McpConnectionStats,
  type McpContentSummary,
  type McpListToolsResult,
  type McpRetryPolicy,
  type McpTextBlock,
  type McpToolDescriptor,
  type McpTransport,
} from './types.ts';
