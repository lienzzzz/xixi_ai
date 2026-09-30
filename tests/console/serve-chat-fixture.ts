/**
 * The trial page's fixture: start `serve-chat.ts --fake` and wait until it really answers (t96).
 *
 * The earlier version of the console tests waited for the startup line on stdout with a 30 s
 * window and then fetched immediately. On a loaded machine that is exactly the shape of a flaky
 * test: the line can be late, and a port that has been *printed* is not yet a port that *answers*.
 * This fixture waits for the service instead — it polls `GET /api/state` until the server responds
 * (or the deadline passes) — fails immediately with the child's own output when the child dies, and
 * always reaps the process, so runs cannot leak a listener into the next test.
 *
 * Both console test files that need the trial page share this one implementation.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { REPO_ROOT } from '../../scripts/lib/harness.ts';

export interface TrialPageFixture {
  /** `http://127.0.0.1:<port>` of the running page. */
  readonly base: string;
  /** Everything the child wrote, for diagnostics when an assertion fails. */
  readonly output: () => string;
  /** Stop it and wait for the process to actually exit. */
  stop: () => Promise<void>;
}

export interface TrialPageOptions {
  /** Its own SQLite directory (`XIXI_WEB_DATA_DIR`); a temp dir by default. */
  readonly dataDir: string;
  /** Extra environment (e.g. a fake key); `--fake` needs none. */
  readonly env?: Readonly<Record<string, string>>;
  /** How long to wait for a *response* (not just for the startup line). Default 60 s. */
  readonly readyTimeoutMs?: number;
}

/** Poll the page until it answers, or throw with the child's output. */
async function waitUntilReady(child: ChildProcess, base: string, output: () => string, deadline: number): Promise<void> {
  let lastError: string = '还没有收到任何响应';
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`serve-chat 启动后就退出了（exit ${child.exitCode ?? child.signalCode}）：\n${output()}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`serve-chat 在等待窗口内没有给出响应（最后一次：${lastError}）：\n${output()}`);
    }
    try {
      const response = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        await response.arrayBuffer(); // drain, so the socket is not left half-read
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function startTrialPage(options: TrialPageOptions): Promise<TrialPageFixture> {
  const child = spawn(process.execPath, ['scripts/serve-chat.ts', '--fake', '--no-tts', '--port', '0'], {
    cwd: REPO_ROOT,
    env: { ...process.env, XIXI_WEB_DATA_DIR: options.dataDir, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    out += chunk;
  });

  const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
  const output = (): string => out;
  let port: number | null = null;
  while (port === null) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`serve-chat 没起来（exit ${child.exitCode ?? child.signalCode}）：\n${output()}`);
    }
    if (Date.now() > deadline) throw new Error(`serve-chat 没有打印端口：\n${output()}`);
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    if (match !== null) port = Number(match[1]);
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitUntilReady(child, base, output, deadline);
  } catch (error) {
    child.kill();
    throw error;
  }

  return {
    base,
    output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    },
  };
}
