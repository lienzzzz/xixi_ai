/**
 * One MCP server connection, with the two behaviours pack §4 asks for and nothing else:
 * **a dead or absent server must not take the entry point down**, and **a dropped connection is
 * reconnected** rather than left dead.
 *
 * The shape of that:
 *
 *  * `connect()` is called through a factory, so every (re)connection is a fresh transport. A
 *    transport that died cannot be revived, and pretending otherwise is how "reconnect" turns into
 *    a comment.
 *  * Connect attempts are bounded by a retry policy with a growing delay; exhausting it produces an
 *    `McpConnectionError` — a *value* the adapter turns into a tool result, not a crash.
 *  * An operation that fails on a **live** connection drops it, reconnects once, and retries. The
 *    SDK's own `onclose` flips our state as well, so a server that dies between two calls is
 *    noticed even if nobody called `close()`.
 *  * A timeout drops the connection too: a hung round trip is evidence the pipe is not usable.
 *
 * Everything observable is counted (`stats`) and emitted (`onEvent`), because 「有一次断线重连或重试
 * 的可观察证据」 has to be assertable rather than inferred.
 */
import { Client } from '@modelcontextprotocol/client';

import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_MCP_RETRY,
  McpConnectionError,
  type McpCallRequest,
  type McpCallResult,
  type McpClientLike,
  type McpConnectionEvent,
  type McpConnectionEventKind,
  type McpConnectionState,
  type McpConnectionStats,
  type McpListToolsResult,
  type McpRetryPolicy,
  type McpTransport,
} from './types.ts';

/**
 * The only place the SDK is constructed.
 *
 * `Client` is assigned to `McpClientLike` **without a cast** on purpose: if v2 changes the shape of
 * `listTools` / `callTool` / `connect`, this line stops compiling instead of failing at run time.
 */
export function createSdkMcpClient(): McpClientLike {
  return new Client({ name: 'xixi-mcp-client', version: '0.1.0' });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface McpConnectionOptions {
  readonly server: string;
  /** Opens one transport. Called again for every reconnect. */
  readonly connect: () => McpTransport | Promise<McpTransport>;
  readonly retry?: Partial<McpRetryPolicy> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly createClient?: (() => McpClientLike) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly onEvent?: ((event: McpConnectionEvent) => void) | undefined;
}

interface MutableStats {
  attempts: number;
  connects: number;
  reconnects: number;
  calls: number;
  listings: number;
  failures: number;
  lastError: string | null;
}

export class McpServerConnection {
  readonly server: string;
  readonly #connect: () => McpTransport | Promise<McpTransport>;
  readonly #retry: McpRetryPolicy;
  readonly #timeoutMs: number;
  readonly #createClient: () => McpClientLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onEvent: ((event: McpConnectionEvent) => void) | undefined;
  readonly #stats: MutableStats = { attempts: 0, connects: 0, reconnects: 0, calls: 0, listings: 0, failures: 0, lastError: null };

  #client: McpClientLike | null = null;
  #state: McpConnectionState = 'idle';
  #everConnected = false;
  #disposed = false;
  #closing = false;

  constructor(options: McpConnectionOptions) {
    this.server = options.server;
    this.#connect = options.connect;
    this.#retry = { ...DEFAULT_MCP_RETRY, ...(options.retry ?? {}) };
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS;
    this.#createClient = options.createClient ?? createSdkMcpClient;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#onEvent = options.onEvent;
  }

  get state(): McpConnectionState {
    return this.#state;
  }

  get stats(): McpConnectionStats {
    return { ...this.#stats };
  }

  /** Whether a usable client is held right now (no I/O). */
  get connected(): boolean {
    return this.#client !== null && this.#state === 'connected';
  }

  async listTools(): Promise<McpListToolsResult> {
    return this.#run('listTools', (client) => {
      this.#stats.listings += 1;
      return client.listTools();
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const request: McpCallRequest = { name, arguments: args };
    return this.#run(`callTool ${name}`, (client) => {
      this.#stats.calls += 1;
      return client.callTool(request);
    });
  }

  /** Release the connection. After this the connection is finished: further calls refuse. */
  async close(): Promise<void> {
    this.#disposed = true;
    await this.#drop('主动关闭');
    this.#state = 'idle';
  }

  /** One attempt at an operation, with the reconnect policy around it. */
  async #run<T>(label: string, op: (client: McpClientLike) => Promise<T>): Promise<T> {
    if (this.#disposed) throw new McpConnectionError(this.server, `MCP 连接 ${this.server} 已经关闭`);
    try {
      const client = await this.#ensureConnected();
      return await this.#guard(op(client), label);
    } catch (error) {
      // A connect failure has already been retried by the policy; do not loop on it.
      if (error instanceof McpConnectionError && this.#client === null) throw error;
      this.#stats.failures += 1;
      this.#stats.lastError = messageOf(error);
      this.#event('failure', `${label} 失败：${messageOf(error)}`);
      await this.#drop(`${label} 失败后断开`);
      const client = await this.#ensureConnected();
      return await this.#guard(op(client), `${label}（重连后）`);
    }
  }

  async #ensureConnected(): Promise<McpClientLike> {
    if (this.#client !== null && this.#state === 'connected') return this.#client;
    const attempts = Math.max(1, Math.floor(this.#retry.attempts));
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.#stats.attempts += 1;
      try {
        const client = this.#createClient();
        this.#hookClient(client);
        const transport = await this.#connect();
        await this.#guard(client.connect(transport), `连接 ${this.server}`);
        this.#client = client;
        this.#state = 'connected';
        if (this.#everConnected) {
          this.#stats.reconnects += 1;
          this.#event('reconnect', `第 ${attempt} 次尝试连上了 ${this.server}`);
        } else {
          this.#stats.connects += 1;
          this.#everConnected = true;
          this.#event('connect', `连上了 ${this.server}`);
        }
        return client;
      } catch (error) {
        lastError = error;
        this.#stats.lastError = messageOf(error);
        this.#event('retry', `第 ${attempt}/${attempts} 次连接失败：${messageOf(error)}`);
        if (attempt < attempts) await this.#sleep(this.#retry.delayMs * attempt);
      }
    }
    this.#state = 'failed';
    throw new McpConnectionError(
      this.server,
      `连不上 MCP 服务器 ${this.server}（试了 ${attempts} 次）：${messageOf(lastError)}`,
      { cause: lastError },
    );
  }

  /** The SDK's own lifecycle hooks: the server can die between two calls. */
  #hookClient(client: McpClientLike): void {
    client.onclose = (): void => {
      if (this.#closing) return;
      this.#client = null;
      if (this.#state === 'connected') this.#state = 'disconnected';
      this.#event('disconnect', `${this.server} 的连接被对方关掉了`);
    };
    client.onerror = (error: Error): void => {
      this.#stats.lastError = messageOf(error);
      this.#event('failure', `${this.server} 连接报错：${messageOf(error)}`);
    };
  }

  async #guard<T>(work: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new McpConnectionError(this.server, `${label} 超时（${this.#timeoutMs}ms）`)), this.#timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof McpConnectionError && error.message.includes('超时')) {
        this.#event('timeout', `${label} 超时，断开这条连接`);
        await this.#drop(`${label} 超时`);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #drop(reason: string): Promise<void> {
    const client = this.#client;
    this.#client = null;
    if (this.#state === 'connected') this.#state = 'disconnected';
    if (client === null) return;
    this.#closing = true;
    try {
      await client.close();
    } catch {
      // Closing a broken transport is allowed to fail; the connection is being dropped anyway.
    } finally {
      this.#closing = false;
    }
    this.#event('disconnect', `${this.server}：${reason}`);
  }

  #event(kind: McpConnectionEventKind, detail: string): void {
    this.#onEvent?.({ server: this.server, kind, detail });
  }
}
