/**
 * Agent runtime, tool side (pack Phase 2): `ToolRegistry` + `ToolExecutor` + `ToolPermission`.
 *
 * Three boundaries live here, and all three are checked **outside the model**:
 *
 *  1. **Which tools exist for the model at all.** `listForAgent(scope)` is what the
 *     provider is told about; a tool the policy refuses is never advertised, so a
 *     model cannot ask for what it was not offered.
 *  2. **Whether a call may run.** `execute()` re-checks the policy. A provider that
 *     hallucinates a denied tool name gets a refusal, not a side effect.
 *  3. **How many rounds a turn may use.** `MAX_TOOL_ROUNDS` is a program constant, and
 *     `definitionsForRound()` returns nothing past it — the cap cannot be raised by
 *     anything the model says (§2.1 铁律: the program owns rules and boundaries).
 *
 * Errors are contained on purpose: a broken tool becomes a `{ error }` payload the
 * model can talk about, never an exception that takes the conversation down.
 */
import type { MimoToolDefinition } from '@xixi/model-adapters';

import {
  asAgentTool,
  defaultTools,
  type AgentScope,
  type AgentTool,
  type DefaultToolsOptions,
  type ToolCallRecord,
  type ToolContext,
  type XixiTool,
} from './tools.ts';

/** The pack's cap: `model → tool_calls → execute → append → model`, at most 4 rounds. */
export const MAX_TOOL_ROUNDS = 4;

/** Who is being served; the permission policy narrows `write`/`dangerous` by role. */
export type ToolRole = 'owner' | 'resident' | 'guest';

export type ToolPermissionVerdict = 'allow' | 'deny' | 'ask';

export interface ToolPermissionDecision {
  readonly verdict: ToolPermissionVerdict;
  readonly reason: string;
}

export interface ToolPermissionRequest {
  readonly scope: AgentScope;
  readonly role: ToolRole;
}

/**
 * The program's answer to "may this tool run here?". Kept as an interface so a
 * deployment can swap it; the model never supplies one.
 */
export interface ToolPermissionPolicy {
  check(tool: AgentTool, request: ToolPermissionRequest): ToolPermissionDecision;
}

export interface ToolPermissionOptions {
  readonly role?: ToolRole;
  /** Tool names refused outright, whatever their risk (deployment/owner config). */
  readonly deniedTools?: readonly string[];
  /** `ask` tools: they work, but only after a person confirms (the pack's ASK branch). */
  readonly askTools?: readonly string[];
}

/**
 * Default policy for the PoC:
 *  * `dangerous` — refused, always (铁律 7: 门锁/支付/紧急呼叫不做);
 *  * `write` — only for a resident/owner, and only in `conversation`/`admin`;
 *  * `read` — allowed wherever the tool declared itself.
 */
export class ToolPermission implements ToolPermissionPolicy {
  readonly #role: ToolRole;
  readonly #denied: ReadonlySet<string>;
  readonly #ask: ReadonlySet<string>;

  constructor(options: ToolPermissionOptions = {}) {
    this.#role = options.role ?? 'resident';
    this.#denied = new Set(options.deniedTools ?? []);
    this.#ask = new Set(options.askTools ?? []);
  }

  get role(): ToolRole {
    return this.#role;
  }

  check(tool: AgentTool, request: ToolPermissionRequest): ToolPermissionDecision {
    if (this.#denied.has(tool.name)) return { verdict: 'deny', reason: `策略里关掉了 ${tool.name}` };
    if (this.#ask.has(tool.name)) return { verdict: 'ask', reason: `${tool.name} 需要先得到同意` };
    if (tool.risk === 'dangerous') return { verdict: 'deny', reason: '高风险能力在 PoC 阶段一律不做（铁律 7）' };
    if (!tool.scopes.includes(request.scope)) {
      return { verdict: 'deny', reason: `这个能力不属于 ${request.scope} 场景` };
    }
    if (tool.risk === 'write') {
      if (request.role === 'guest') return { verdict: 'deny', reason: '客人不能改东西' };
      if (request.scope === 'proactive') return { verdict: 'deny', reason: '她自己开口时不能顺手改东西' };
      if (request.role !== 'resident' && request.role !== 'owner') return { verdict: 'deny', reason: '当前角色不能改东西' };
    }
    return { verdict: 'allow', reason: '允许' };
  }
}

export interface ToolExecutionContext {
  readonly scope: AgentScope;
  readonly timezone: string;
  readonly now: Date;
  readonly role?: ToolRole;
}

export interface ToolCall {
  readonly id?: string;
  readonly name: string;
  readonly arguments: string | Record<string, unknown>;
}

export interface ToolExecution {
  readonly record: ToolCallRecord;
  readonly permission: ToolPermissionDecision;
  /** Exactly what is appended back to the model as the tool result. */
  readonly payload: Record<string, unknown>;
}

const MAX_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

function declaredArgumentNames(tool: AgentTool): string[] {
  const properties = tool.parameters['properties'];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return [];
  return Object.keys(properties as Record<string, unknown>);
}

/** Parse the provider's argument string; a non-object is an empty argument set, not a crash. */
export function parseToolArguments(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  return {};
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The pack's `ToolExecutor`: validate the declared shape, run the tool with a hard
 * timeout, and turn every failure into a value. Returns `null` result on any refusal.
 */
export async function executeTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
  const declared = declaredArgumentNames(tool);
  const unknown = Object.keys(args).filter((key) => !declared.includes(key));
  if (unknown.length > 0) return { ok: false, error: `不认识的参数：${unknown.join('、')}` };
  const timeoutMs = Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(1, Math.floor(tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS)));
  try {
    const result = await withTimeout(tool.execute(args, context), timeoutMs, tool.name);
    return { ok: true, result };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * What `ToolRegistry.register` returns (V0.3 P2-A, pack `03_AGENT_PLUGIN.md` §3: 「所有注册返回
 * Disposable」).
 *
 * It is a *callable object* rather than a new shape because the old contract — a bare `() => void`
 * that removes the tool — is already used by the console, the entries and the unit tests. A caller
 * that keeps calling the result works exactly as before; a caller that expects a `Disposable` finds
 * one. Both directions are idempotent, so registering and releasing twice is harmless.
 */
export type ToolRegistration = (() => void) & { readonly dispose: () => void };

function asRegistration(release: () => void): ToolRegistration {
  let released = false;
  const invoke = (): void => {
    if (released) return;
    released = true;
    release();
  };
  return Object.assign(invoke, { dispose: invoke }) as ToolRegistration;
}

export interface ToolRegistryOptions {
  readonly tools?: readonly (XixiTool | AgentTool)[];
  readonly permission?: ToolPermissionPolicy;
  readonly role?: ToolRole;
  readonly maxToolRounds?: number;
  readonly onToolCall?: (record: ToolCallRecord) => void;
}

/**
 * The registry. `definitionsForRound` is the only way the model ever hears about a
 * tool, and `execute` is the only way one ever runs.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool>();
  readonly #permission: ToolPermissionPolicy;
  readonly #role: ToolRole;
  readonly #maxToolRounds: number;
  readonly #onToolCall: ((record: ToolCallRecord) => void) | undefined;

  constructor(options: ToolRegistryOptions = {}) {
    this.#permission = options.permission ?? new ToolPermission({ role: options.role ?? 'resident' });
    this.#role = options.role ?? 'resident';
    const requested = options.maxToolRounds ?? MAX_TOOL_ROUNDS;
    this.#maxToolRounds = Math.max(0, Math.min(MAX_TOOL_ROUNDS, Math.floor(Number.isFinite(requested) ? requested : MAX_TOOL_ROUNDS)));
    this.#onToolCall = options.onToolCall;
    for (const tool of options.tools ?? []) this.register(tool);
  }

  /** Registering and unregistering are symmetric: nothing stays reachable after the disposable runs. */
  register(tool: XixiTool | AgentTool): ToolRegistration {
    const agentTool = asAgentTool(tool);
    this.#tools.set(agentTool.name, agentTool);
    return asRegistration(() => this.unregister(agentTool.name));
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  /**
   * Release every registration this registry owns. It is a `Disposable` so a plugin host can hold
   * one handle for "the tool chain" — the per-tool registrations returned by `register` keep
   * working unchanged.
   */
  dispose(): void {
    this.#tools.clear();
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }

  /** Every registered tool; prefer `listForAgent` when building a model request. */
  all(): AgentTool[] {
    return [...this.#tools.values()];
  }

  /** What the model may see in this scope: refused tools are not advertised at all. */
  listForAgent(scope: AgentScope): AgentTool[] {
    return this.all().filter((tool) => this.check(tool.name, scope).verdict === 'allow');
  }

  check(name: string, scope: AgentScope, role: ToolRole = this.#role): ToolPermissionDecision {
    const tool = this.#tools.get(name);
    if (tool === undefined) return { verdict: 'deny', reason: `没有这个工具：${name}` };
    return this.#permission.check(tool, { scope, role });
  }

  get maxToolRounds(): number {
    return this.#maxToolRounds;
  }

  /**
   * The tool schemas for round `round` (1-based), or `undefined` past the cap.
   * `undefined` is what makes the loop stop asking the model for tool calls.
   */
  definitionsForRound(scope: AgentScope, round: number): MimoToolDefinition[] | undefined {
    if (round > this.#maxToolRounds) return undefined;
    const tools = this.listForAgent(scope);
    if (tools.length === 0) return undefined;
    return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  }

  /** Run one requested call, whatever happens: the model always gets a payload back. */
  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecution> {
    const args = parseToolArguments(call.arguments);
    const role = context.role ?? this.#role;
    const tool = this.#tools.get(call.name);
    const reply = (payload: Record<string, unknown>, record: ToolCallRecord, permission: ToolPermissionDecision): ToolExecution => {
      this.#onToolCall?.(record);
      return { record, permission, payload };
    };

    if (tool === undefined) {
      // A hallucinated name is a refusal, not a crash: the turn must still finish.
      const permission: ToolPermissionDecision = { verdict: 'deny', reason: 'UNKNOWN_TOOL' };
      return reply({ error: '没有这个工具，请直接用已有信息回答' }, { name: call.name, args, ok: false, result: null, error: 'UNKNOWN_TOOL' }, permission);
    }

    const permission = this.#permission.check(tool, { scope: context.scope, role });
    if (permission.verdict !== 'allow') {
      const error = permission.verdict === 'ask' ? 'ASK' : 'PERMISSION_DENIED';
      const hint =
        permission.verdict === 'ask'
          ? '这个能力要先得到同意：先问一句，别自己动手。'
          : '这个能力现在不能用：别硬猜，直接说这件事你做不到。';
      return reply({ error: hint }, { name: tool.name, args, ok: false, result: null, error }, permission);
    }

    const outcome = await executeTool(tool, args, { timezone: context.timezone, now: context.now });
    if (!outcome.ok) {
      return reply({ error: outcome.error }, { name: tool.name, args, ok: false, result: null, error: outcome.error }, permission);
    }
    return reply(outcome.result, { name: tool.name, args, ok: true, result: outcome.result, error: null }, permission);
  }
}

export interface BuiltinToolRegistryOptions extends DefaultToolsOptions {
  readonly maxToolRounds?: number;
  readonly role?: ToolRole;
  readonly permission?: ToolPermissionPolicy;
  readonly onToolCall?: (record: ToolCallRecord) => void;
}

/**
 * The one place the built-in set is assembled. Every entry point that talks to the
 * model — text or voice — builds its registry here, which is what makes "voice and
 * text share one tool chain" a property of the code rather than of a call site.
 */
export function createToolRegistry(options: BuiltinToolRegistryOptions): ToolRegistry {
  return new ToolRegistry({
    tools: defaultTools(options),
    ...(options.permission === undefined ? {} : { permission: options.permission }),
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.maxToolRounds === undefined ? {} : { maxToolRounds: options.maxToolRounds }),
    ...(options.onToolCall === undefined ? {} : { onToolCall: options.onToolCall }),
  });
}
