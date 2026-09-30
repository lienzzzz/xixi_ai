import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BrainError, type DshTransport, type DshTurnRequest, type DshTurnResponse } from '@xixi/brain-adapter';
import type { TurnAction } from '@xixi/domain';

/**
 * Runs one DSH turn by launching the harness CLI, exactly like a fresh user of
 * the tool would (§M0: 输入文字 → DSH → MiMo → 结构化工具 → 回答).
 *
 * Why a process per turn in M0: it makes "restart → session recover" the
 * *natural* behaviour instead of a special case — the durable DSH session lives
 * on disk, and a brand-new process continues it with `--session-id`. The cost is
 * a full profile boot per turn, which is why M1 replaces this with a long-lived
 * host when voice latency starts to matter (§46.4).
 *
 * Constraints confirmed by recon (see docs/progress.md): resuming requires the
 * same cwd and the same profile composition, so both are pinned here.
 */
export interface CliDshTransportOptions {
  /** Project-local DSH home; keeps the profile and sessions inside the repo. */
  readonly dshHome: string;
  /** Profile name, e.g. `xixi`. */
  readonly profile: string;
  /** Working directory for the harness; resume requires it to be stable. */
  readonly cwd: string;
  /** Path to bin.js; resolved automatically when omitted. */
  readonly dshBinJs?: string;
  /** Extra environment for the harness, e.g. `{ MIMO_API_KEY }`. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Streams harness diagnostics; never receives the API key. */
  readonly onDiagnostic?: (line: string) => void;
}

export interface DshTurnDiagnostics {
  readonly sessionId: string | null;
  readonly toolCalls: readonly { readonly tool: string; readonly callId: string | null }[];
  readonly stderrTail: string;
  readonly exitCode: number | null;
  readonly eventTypes: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Locate the harness entry point.
 *
 * The npm shim on Windows is a `.cmd` that cannot be spawned directly, so the
 * shim's location is used only to find the real `lib/bin.js` beside it, which is
 * then run with the current Node.
 */
export function resolveDshBinJs(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) {
    if (!existsSync(explicit)) throw new BrainError('TRANSPORT_FAILED', `DSH_BIN_JS does not exist: ${explicit}`);
    return explicit;
  }
  const fromEnv = process.env.DSH_BIN_JS;
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv;

  const finder = process.platform === 'win32' ? 'where' : 'which';
  let shim: string;
  try {
    shim = execFileSync(finder, ['dsh'], { encoding: 'utf8' }).split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  } catch (cause) {
    throw new BrainError('TRANSPORT_FAILED', 'cannot find the dsh executable on PATH', {
      detail: `${cause instanceof Error ? cause.message : String(cause)}; set DSH_BIN_JS to .../@deepseek-ai/dsh/lib/bin.js`,
    });
  }
  const candidate = join(dirname(shim.trim()), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(candidate)) {
    throw new BrainError('TRANSPORT_FAILED', 'cannot derive the harness entry point from the dsh shim', {
      detail: `looked for ${candidate}; set DSH_BIN_JS explicitly`,
    });
  }
  return candidate;
}

export interface ParsedDshOutput {
  readonly sessionId: string | null;
  readonly finalText: string | null;
  readonly toolCalls: readonly { readonly tool: string; readonly callId: string | null }[];
  readonly eventTypes: readonly string[];
  readonly errorMessage: string | null;
  readonly raw: readonly Record<string, unknown>[];
}

/** Parse `dsh --json` NDJSON output. Unknown event types are retained, not guessed at. */
export function parseDshJsonLines(stdout: string): ParsedDshOutput {
  const raw: Record<string, unknown>[] = [];
  const eventTypes: string[] = [];
  const toolCalls: { tool: string; callId: string | null }[] = [];
  let sessionId: string | null = null;
  let finalText: string | null = null;
  let errorMessage: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    raw.push(event);
    const type = typeof event.type === 'string' ? event.type : 'unknown';
    eventTypes.push(type);
    if (type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId;
    if (type === 'tool_call' && typeof event.tool === 'string') {
      toolCalls.push({ tool: event.tool, callId: typeof event.callId === 'string' ? event.callId : null });
    }
    if (type === 'final' && typeof event.text === 'string') finalText = event.text;
    if (type === 'error') {
      errorMessage = typeof event.message === 'string' ? event.message : JSON.stringify(event);
    }
  }
  return { sessionId, finalText, toolCalls, eventTypes, errorMessage, raw };
}

export class CliDshTransport implements DshTransport {
  readonly kind = 'dsh-cli';
  readonly #options: CliDshTransportOptions;
  readonly #binJs: string;
  lastDiagnostics: DshTurnDiagnostics | null = null;

  constructor(options: CliDshTransportOptions) {
    this.#options = options;
    this.#binJs = resolveDshBinJs(options.dshBinJs);
    if (!existsSync(options.cwd)) {
      throw new BrainError('TRANSPORT_FAILED', `harness cwd does not exist: ${options.cwd}`);
    }
  }

  /**
   * Compose the harness task text.
   *
   * Prompt assembly proper (§26) belongs to the brain and arrives with M1. M0
   * passes only what this milestone can honestly supply: identity, the
   * persisted personality baseline, and the recent turns from the event log —
   * enough that the personality is not decorative and a resumed session can be
   * proven to carry history.
   */
  static composeTask(request: DshTurnRequest): string {
    const { context } = request;
    const personality = Object.entries(context.personality)
      .map(([property, value]) => `${property}=${value}`)
      .join(', ');
    const history = context.workingMemory
      .filter((turn) => turn.text !== null && turn.text.length > 0)
      .map((turn) => `${turn.role === 'user' ? '用户' : '西西'}：${turn.text}`)
      .join('\n');

    return [
      '【西西运行时上下文】',
      `身份：${context.identityName}`,
      `有效人格：${personality.length > 0 ? personality : '(未提供)'}`,
      `时区：${context.timezone ?? '(未提供)'}`,
      history.length > 0 ? `最近对话：\n${history}` : '最近对话：(无)',
      '【用户当前输入】',
      request.text,
    ].join('\n');
  }

  async turn(request: DshTurnRequest, options?: { readonly timeoutMs?: number }): Promise<DshTurnResponse> {
    const timeoutMs = options?.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = [this.#binJs, '--profile', this.#options.profile, '--json'];
    if (request.resumeBrainSessionId !== null) args.push('--session-id', request.resumeBrainSessionId);
    args.push(request.task ?? CliDshTransport.composeTask(request));

    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: this.#options.dshHome, ...this.#options.env };
    const startedAt = Date.now();

    const child = spawn(process.execPath, args, { cwd: this.#options.cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
    });
    child.stderr.on('data', (data: string) => {
      stderr += data;
      for (const line of data.split(/\r?\n/)) {
        if (line.trim().length > 0) this.#options.onDiagnostic?.(line.trim());
      }
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code));
    }).finally(() => clearTimeout(timer));

    const parsed = parseDshJsonLines(stdout);
    this.lastDiagnostics = {
      sessionId: parsed.sessionId,
      toolCalls: parsed.toolCalls,
      stderrTail: stderr.slice(-2000),
      exitCode,
      eventTypes: parsed.eventTypes,
    };

    if (timedOut) {
      throw new BrainError('TIMEOUT', `harness turn exceeded ${timeoutMs} ms`, { detail: stderr.slice(-500) });
    }

    const latencyMs = Date.now() - startedAt;
    const toolName = parsed.toolCalls[0]?.tool ?? null;
    const text = parsed.finalText;
    const action: TurnAction = text === null || text.trim().length === 0 ? (toolName === null ? 'SILENCE' : 'TOOL') : 'SPEAK';

    if (exitCode !== 0 || (parsed.errorMessage !== null && text === null)) {
      return {
        requestId: request.requestId,
        ok: false,
        brainSessionId: parsed.sessionId ?? request.resumeBrainSessionId,
        action: 'SILENCE',
        text: null,
        toolName,
        provider: 'dsh',
        model: this.#options.profile,
        latencyMs,
        error: {
          code: parsed.errorMessage === null ? `EXIT_${exitCode ?? 'UNKNOWN'}` : 'HARNESS_ERROR',
          message: parsed.errorMessage ?? (stderr.trim().slice(-600) || 'harness exited without a final answer'),
        },
      };
    }

    return {
      requestId: request.requestId,
      ok: true,
      brainSessionId: parsed.sessionId ?? request.resumeBrainSessionId,
      action,
      text,
      toolName,
      provider: 'dsh',
      model: currentModelOf(parsed),
      latencyMs,
    };
  }

  close(): void {
    // Each turn owns its process; nothing stays alive between turns in M0.
  }
}

/** The harness reports the model it used in status events; fall back to the configured route. */
function currentModelOf(parsed: ParsedDshOutput): string {
  for (let index = parsed.raw.length - 1; index >= 0; index -= 1) {
    const model = parsed.raw[index].model;
    if (typeof model === 'string' && model.length > 0) return model;
  }
  return 'mimo-v2.6-flash';
}
