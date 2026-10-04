/**
 * The types that make the MCP client seam testable — pack `03_AGENT_PLUGIN.md` §4.
 *
 * Two decisions live in this file, and both are deliberate:
 *
 *  1. **The connection is a *factory*, not a live object.** A `McpServerSpec` carries
 *     `connect(): Promise<McpTransport>`. Reconnecting is "call the factory again", so
 *     「断线后重连」 is an operation with an observable count instead of a hope. A spec that held one
 *     transport could never be reconnected after that transport died.
 *  2. **The client is described structurally (`McpClientLike`), not by the SDK's class type.** The
 *     SDK's `Client` satisfies this interface (checked by the compiler in `connection.ts`), and a
 *     test can hand in a fake to exercise the failure paths without a real server. It also keeps the
 *     SDK's own type names out of the adapter's signature — the SDK is v2 today and the interface
 *     here is the part we actually use.
 */
import type { Client } from '@modelcontextprotocol/client';

/**
 * One MCP transport, as the SDK defines it.
 *
 * Derived from the SDK rather than re-declared: if v2 renames or narrows the transport contract,
 * this alias follows it instead of drifting. `@modelcontextprotocol/client` exports
 * `InMemoryTransport` (in-process, what the stub server uses) and `/stdio` exports
 * `StdioClientTransport` (a spawned server process); either can be handed to `connect()`.
 */
export type McpTransport = Parameters<Client['connect']>[0];

/** How many content blocks a call returned, by kind. Binaries are counted, never inlined (铁律 6). */
export interface McpContentSummary {
  readonly text: number;
  readonly image: number;
  readonly audio: number;
  readonly resource: number;
  readonly other: number;
}

export interface McpTextBlock {
  readonly type: string;
  readonly text?: string;
}

export interface McpCallResult {
  readonly content?: readonly McpTextBlock[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** JSON Schema, as the server published it (threat model: it is data from an external service). */
  readonly inputSchema?: unknown;
}

export interface McpListToolsResult {
  readonly tools: readonly McpToolDescriptor[];
}

export interface McpCallRequest {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

/**
 * The part of the SDK's `Client` this adapter uses.
 *
 * `onclose` / `onerror` are the SDK's own lifecycle hooks: `onclose` is what turns "the server went
 * away" into a state change on our side, so the *next* call reconnects instead of failing forever.
 */
export interface McpClientLike {
  connect(transport: McpTransport): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<McpListToolsResult>;
  callTool(request: McpCallRequest): Promise<McpCallResult>;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
}

export interface McpRetryPolicy {
  /** Total connect attempts per (re)connection — 1 means "try once, no retry". */
  readonly attempts: number;
  /** Base delay between attempts; the nth wait is `delayMs * n`. */
  readonly delayMs: number;
}

export const DEFAULT_MCP_RETRY: McpRetryPolicy = { attempts: 2, delayMs: 150 };

/** Per-request ceiling for one MCP round trip (the core's `executeTool` cap is separate). */
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 15_000;

/** How much of an external service's text may reach the model in one tool result. */
export const DEFAULT_MCP_MAX_TEXT_CHARS = 4_000;

export type McpConnectionState = 'idle' | 'connected' | 'disconnected' | 'failed';

/** What one server's connection did — the evidence for「有一次断线重连或重试」. */
export interface McpConnectionStats {
  readonly attempts: number;
  readonly connects: number;
  readonly reconnects: number;
  readonly calls: number;
  readonly listings: number;
  readonly failures: number;
  readonly lastError: string | null;
}

export type McpConnectionEventKind = 'connect' | 'reconnect' | 'disconnect' | 'failure' | 'retry' | 'timeout';

export interface McpConnectionEvent {
  readonly server: string;
  readonly kind: McpConnectionEventKind;
  readonly detail: string;
}

/** A refusal the adapter already retried — carried as a value at the tool boundary, never thrown there. */
export class McpConnectionError extends Error {
  readonly server: string;

  constructor(server: string, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'McpConnectionError';
    this.server = server;
  }
}

/** A server name or tool name that cannot be namespaced. */
export class McpNamingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpNamingError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
