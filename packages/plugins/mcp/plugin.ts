/**
 * The MCP servers, expressed as **one plugin** (pack `03_AGENT_PLUGIN.md` §4 on top of §3).
 *
 * This is the "接在 P2-A 之上，不另起一套注册" decision made concrete: an MCP server needs no special
 * path into 西西's tool surface. It is a plugin that declares the `tool` capability, and its tools
 * enter through the same nine-step lifecycle as any other plugin:
 *
 *  * `activate(ctx)` performs discovery and hands back a contribution;
 *  * the contribution is registered by `CapabilityRegistry.registerContribution`, which re-checks the
 *    manifest declaration and the `tool.register` permission — an MCP tool therefore cannot be
 *    registered by a plugin that did not ask for that capability;
 *  * once registered, the tools are `AgentTool`s like the built-ins: the same `ToolPermission`,
 *    the same round cap, the same `executeTool` timeout, the same "an undeclared argument is
 *    refused" rule.
 *
 * Two more things are deliberate:
 *
 *  * **`id` is `xixi.mcp`** — no `xixi_`-prefixed *tool* name is possible, because every tool name
 *    comes from `naming.ts` and starts with `mcp.`. The plugin id is a plugin id, not a tool name.
 *  * **the id is parameterized** because two independently configured MCP plugins (say one per
 *    household member's calendar) must not collide in the manager's registry.
 */
import type { PluginContext } from '../src/context.ts';
import type { PluginModuleShape, InlinePlugin } from '../src/discovery.ts';
import { McpClientAdapter, type McpAdapterOptions, type McpServerStatus } from './adapter.ts';

export const DEFAULT_MCP_PLUGIN_ID = 'xixi.mcp';

/**
 * The honest one-line reason a server is not usable: a real failure first, then why it was closed,
 * then what discovery recorded. Never an empty "state" — a health report has to be quotable.
 */
function reasonOf(entry: McpServerStatus): string {
  const why = entry.lastError ?? entry.closeReason ?? entry.discoverFailure;
  return `${entry.server}=${entry.state}${why === null ? '' : `（${why}）`}`;
}

export interface McpPluginOptions extends McpAdapterOptions {
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  /**
   * What the plugin declares. `tool.register` is the requirement for the `tool` capability; a
   * deployment that reaches remote servers over HTTP can add `network` here, and the adapter's
   * permission gate then has something to check.
   */
  readonly permissions?: readonly string[];
}

export interface McpPluginHandle {
  /** Hand this to `PluginManager.loadInline()`. */
  readonly plugin: InlinePlugin;
  /** The live adapter, for status/health inspection outside the lifecycle. */
  readonly adapter: McpClientAdapter;
}

/**
 * Build the MCP plugin. Nothing is connected here: discovery happens in `activate()`, which is what
 * makes a dead server a *lifecycle* fact (a `degraded` health report and zero contributed tools)
 * instead of a startup crash.
 */
export function createMcpPlugin(options: McpPluginOptions): McpPluginHandle {
  const adapter = new McpClientAdapter(options);
  const manifest = {
    schemaVersion: 1,
    id: options.id ?? DEFAULT_MCP_PLUGIN_ID,
    name: options.name ?? 'MCP',
    version: options.version ?? '0.1.0',
    permissions: [...(options.permissions ?? ['tool.register'])],
    capabilities: ['tool'],
    health: { intervalMs: 60_000 },
  };

  const module: PluginModuleShape = {
    activate: async (context) => {
      const ctx = context as PluginContext;
      // No try/catch here on purpose: `McpClientAdapter.discover()` is contractually non-throwing
      // (per-server failures are collected), and that contract has the red evidence to back it —
      // `tests/unit/plugins/mcp/degradation.test.ts` goes red the moment discovery throws. A second,
      // unreachable catch would be a guard nobody can test (AGENTS §9.25④), so containment lives in
      // exactly one place.
      const discovery = await adapter.discover();
      ctx.log(
        `mcp.discover 服务器 ${adapter.serverNames().length} 个，工具 ${discovery.tools.length} 个，失败 ${discovery.failures.length} 个`,
      );
      for (const failure of discovery.failures) ctx.log(`mcp.server.unavailable ${failure.server}：${failure.error}`);
      return adapter.contribution();
    },
    health: () => {
      if (adapter.disposed) return { status: 'down' as const, detail: '适配器已释放（dispose），连接是终止的' };
      const statuses = adapter.status();
      if (statuses.length === 0) return { status: 'ok' as const, detail: '没有配置 MCP 服务器' };

      // 「未连接」= 不是 connected。idle / disconnected / failed 都不算连上（t20 F2：早先只把 failed
      // 当坏，于是 deactivate 之后的 idle 会被写成「服务器连上了但没发布工具」——一句假话）。
      const notConnected = statuses.filter((entry) => entry.state !== 'connected');
      const tools = adapter.tools().length;

      if (tools > 0 && notConnected.length === 0) return { status: 'ok' as const, detail: `${tools} 个 MCP 工具在线` };
      if (tools > 0) {
        return {
          status: 'degraded' as const,
          detail: `${notConnected.map((entry) => entry.server).join('、')} 未连接（${notConnected.map(reasonOf).join('；')}），其余 ${tools} 个工具照常`,
        };
      }
      // 一个工具都没有：区分「真连上了但服务器没发布工具」与「根本没连上/已断开」。
      if (notConnected.length === 0) {
        return { status: 'degraded' as const, detail: '服务器连上了但没发布工具（discover 返回空列表）' };
      }
      return {
        status: 'down' as const,
        detail: `MCP 未连接，一个工具都没有：${statuses.map(reasonOf).join('；')}`,
      };
    },
    deactivate: () => adapter.disconnect(),
    dispose: () => adapter.dispose(),
  };

  return { plugin: { manifest, module }, adapter };
}
