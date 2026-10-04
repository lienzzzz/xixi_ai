/**
 * `mcp.<server>.<tool>` — the namespace pack §4 asks for.
 *
 * Why a namespace instead of the server's own tool name:
 *
 *  * **no collision with the built-ins.** `xixi_get_weather` comes from the core, and the core's
 *    registry refuses plugin tools in the `xixi_`/`core.` namespaces (`CapabilityRegistry`). The
 *    `mcp.` prefix makes the two sets disjoint by construction, so a server that ships a tool called
 *    `get_weather` cannot shadow anything.
 *  * **the model can tell where a tool came from.** The name in the tools array is the one thing the
 *    model always sees, so provenance belongs in it (铁律 8: data and instructions stay apart — an
 *    external tool's answer is data).
 *  * **two servers may expose the same tool name** (`weather.forecast` and `calendar.forecast`);
 *    namespacing keeps both.
 *
 * The sanitizer is deliberately conservative: lower-case ASCII, digits, `_`, `-` and `.` survive;
 * everything else becomes `_`. An MCP server is an external service, and its tool names are its
 * input, not a trusted identifier for our registry.
 */
import { McpNamingError } from './types.ts';

export const MCP_TOOL_PREFIX = 'mcp';
export const MCP_TOOL_SEPARATOR = '.';

/** Longest name we will hand to a provider's tools array. */
export const MCP_MAX_NAME_CHARS = 64;

function sanitize(segment: string, what: string): string {
  if (typeof segment !== 'string' || segment.trim().length === 0) {
    throw new McpNamingError(`MCP 的${what}不能是空串`);
  }
  const cleaned = segment
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  if (cleaned.length === 0) throw new McpNamingError(`MCP 的${what}「${segment}」里没有可用字符`);
  return cleaned;
}

/** The namespace segment one server occupies. */
export function mcpServerSegment(serverName: string): string {
  const segment = sanitize(serverName, '服务器名');
  if (segment === MCP_TOOL_PREFIX) throw new McpNamingError('MCP 服务器名不能就叫 mcp：那会与命名空间前缀重合');
  return segment;
}

/** `mcp.<server>.<tool>` — the name that reaches the model. */
export function mcpToolName(serverName: string, toolName: string): string {
  const name = `${MCP_TOOL_PREFIX}${MCP_TOOL_SEPARATOR}${mcpServerSegment(serverName)}${MCP_TOOL_SEPARATOR}${sanitize(toolName, '工具名')}`;
  if (name.length > MCP_MAX_NAME_CHARS) {
    throw new McpNamingError(`带命名空间的工具名太长（${name.length} 字符）：${name}`);
  }
  return name;
}

export interface ParsedMcpToolName {
  readonly server: string;
  readonly tool: string;
}

/** Read a namespaced name back. `null` when it is not an MCP name at all. */
export function parseMcpToolName(name: string): ParsedMcpToolName | null {
  const parts = name.split(MCP_TOOL_SEPARATOR);
  if (parts.length !== 3) return null;
  const [prefix, server, tool] = parts;
  if (prefix !== MCP_TOOL_PREFIX || server === undefined || tool === undefined) return null;
  if (server.length === 0 || tool.length === 0) return null;
  return { server, tool };
}

export function isMcpToolName(name: string): boolean {
  return parseMcpToolName(name) !== null;
}
