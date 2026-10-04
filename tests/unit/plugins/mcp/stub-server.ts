/**
 * A **local stub MCP server** for the adapter tests (pack §4 asks for exactly this: 「起一个本地桩
 * MCP 服务器证明 discover 与命名与调用链真的通」).
 *
 * It is a real MCP server: an `McpServer` from the v2 SDK, with tools registered through
 * `fromJsonSchema`, served over `InMemoryTransport.createLinkedPair()`. Nothing about the protocol is
 * faked — the client under test performs a genuine `initialize` handshake, `tools/list` and
 * `tools/call`, and the SDK validates arguments against the JSON Schema before the handler runs.
 *
 * The two knobs exist because the acceptance criteria need failure to be *reproducible*:
 *
 *  * `failConnects: n` — the transport factory throws for the first `n` calls, which is what "the
 *    server is not up yet" looks like from the client's side;
 *  * `closeServerSide()` — drops the server end of the live link, which is what "the server died"
 *    looks like. A reconnect builds a fresh pair, so the next call succeeds.
 */
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';

import type { McpTransport } from '@xixi/plugins/mcp';

export interface StubToolSpec {
  readonly name: string;
  readonly description?: string;
  /** Raw JSON Schema — the SDK's `fromJsonSchema` means the repo needs no schema library of its own. */
  readonly schema?: Record<string, unknown>;
  /** The text the tool answers with. Defaults to a recognizable line naming the tool. */
  readonly text?: string | ((args: Record<string, unknown>) => string);
  /** When set, the tool answers `isError: true` with this text (a *result*, not a throw). */
  readonly failWith?: string;
}

export interface StubMcpServerOptions {
  readonly name: string;
  readonly tools: readonly StubToolSpec[];
  readonly version?: string;
  /** Number of initial transport-factory calls that fail. Default 0. */
  readonly failConnects?: number;
}

export interface StubMcpServer {
  /** A *factory*, not a transport: every call builds a fresh pair (that is what reconnect needs). */
  readonly transportFactory: () => Promise<McpTransport>;
  /** Every `tools/call` the server actually handled, in order. */
  readonly calls: readonly { readonly name: string; readonly args: Record<string, unknown> }[];
  /** How many times the factory was asked for a transport (failed attempts included). */
  readonly factoryCalls: number;
  /** How many times a server instance actually served a connection. */
  readonly served: number;
  /** Drop the server end of the live link: the client sees the server go away. */
  closeServerSide(): Promise<void>;
  dispose(): Promise<void>;
}

export function createStubMcpServer(options: StubMcpServerOptions): StubMcpServer {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let factoryCalls = 0;
  let served = 0;
  let failRemaining = options.failConnects ?? 0;
  let server: McpServer | undefined;
  let serverTransport: McpTransport | undefined;

  const build = async (transport: McpTransport): Promise<McpServer> => {
    const instance = new McpServer({ name: options.name, version: options.version ?? '0.0.1' });
    for (const tool of options.tools) {
      instance.registerTool(
        tool.name,
        {
          description: tool.description ?? `桩服务器 ${options.name} 的工具 ${tool.name}`,
          // `fromJsonSchema` (JSON Schema in, standard schema out) is what keeps this fixture free of
          // a schema library of its own; the SDK still derives the advertised JSON Schema for it.
          inputSchema: fromJsonSchema<Record<string, unknown>>(tool.schema ?? { type: 'object', properties: {}, additionalProperties: false }),
        },
        async (args: Record<string, unknown>) => {
          calls.push({ name: tool.name, args: { ...args } });
          if (tool.failWith !== undefined) return { content: [{ type: 'text' as const, text: tool.failWith }], isError: true };
          const text = typeof tool.text === 'function' ? tool.text(args) : (tool.text ?? `${tool.name} 的答复`);
          return { content: [{ type: 'text' as const, text }] };
        },
      );
    }
    await instance.connect(transport);
    served += 1;
    return instance;
  };

  return {
    get calls() {
      return [...calls];
    },
    get factoryCalls() {
      return factoryCalls;
    },
    get served() {
      return served;
    },
    transportFactory: async () => {
      factoryCalls += 1;
      if (failRemaining > 0) {
        failRemaining -= 1;
        throw new Error(`桩服务器 ${options.name} 还没起来（故意的第 ${factoryCalls} 次）`);
      }
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      serverTransport = serverSide;
      // Attach the server *before* handing the client its end: a linked pair only buffers once both
      // ends exist, and the client's initialize handshake is the first thing it sends.
      server = await build(serverSide);
      return clientSide;
    },
    closeServerSide: async () => {
      await serverTransport?.close();
      await server?.close().catch(() => {});
      server = undefined;
      serverTransport = undefined;
    },
    dispose: async () => {
      await serverTransport?.close().catch(() => {});
      await server?.close().catch(() => {});
      server = undefined;
      serverTransport = undefined;
    },
  };
}
