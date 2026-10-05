/**
 * Agent runtime, tool side (pack Phase 2): `ToolRegistry` + `ToolExecutor` + `ToolPermission`.
 *
 * Three boundaries live here, and all three are checked **outside the model**:
 *
 *  1. **Which tools exist for the model at all.** `listForAgent(scope)` is what the
 *     provider is told about; a tool the policy *refuses* is never advertised, so a
 *     model cannot ask for what it was not offered. A tool the policy marks `ask`
 *     **is** offered — the call then stops at the approval gate instead of running
 *     (`execute`, pack §5).
 *  2. **Whether a call may run.** `execute()` re-checks the policy. A provider that
 *     hallucinates a denied tool name gets a refusal, not a side effect.
 *  3. **How many rounds a turn may use.** `MAX_TOOL_ROUNDS` is a program constant, and
 *     `definitionsForRound()` returns nothing past it — the cap cannot be raised by
 *     anything the model says (§2.1 铁律: the program owns rules and boundaries).
 *
 * Errors are contained on purpose: a broken tool becomes a `{ error }` payload the
 * model can talk about, never an exception that takes the conversation down.
 */
import { createHash } from 'node:crypto';
import { canonicalSchema } from './round-budget.ts';
import { assertEnforceable, validateSchema, type JsonSchema } from '@xixi/contracts';

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
    // Order matters (V0.3 P2-B): every **deny** rule is evaluated before the `ask` branch, so an
    // approval can never upgrade a call that is refused on other grounds (a dangerous tool, a scope
    // it does not belong to, a guest, or「她自己开口时不能顺手改东西」). Before this reorder an
    // `askTools` entry short-circuited those rules, which would have turned 「先问一句」 into a way
    // around them.
    if (this.#denied.has(tool.name)) return { verdict: 'deny', reason: `策略里关掉了 ${tool.name}` };
    if (tool.risk === 'dangerous') return { verdict: 'deny', reason: '高风险能力在 PoC 阶段一律不做（铁律 7）' };
    if (!tool.scopes.includes(request.scope)) {
      return { verdict: 'deny', reason: `这个能力不属于 ${request.scope} 场景` };
    }
    if (tool.risk === 'write') {
      if (request.role === 'guest') return { verdict: 'deny', reason: '客人不能改东西' };
      if (request.scope === 'proactive') return { verdict: 'deny', reason: '她自己开口时不能顺手改东西' };
      if (request.role !== 'resident' && request.role !== 'owner') return { verdict: 'deny', reason: '当前角色不能改东西' };
    }
    if (this.#ask.has(tool.name)) return { verdict: 'ask', reason: `${tool.name} 需要先得到同意` };
    return { verdict: 'allow', reason: '允许' };
  }
}

export interface ToolExecutionContext {
  readonly scope: AgentScope;
  readonly timezone: string;
  readonly now: Date;
  readonly role?: ToolRole;
  /**
   * Who is asking, and which turn asked (V0.3 P2-B, pack `03_AGENT_PLUGIN.md` §5).
   *
   * A pending approval has to name its session and its actor, and a durable reminder has to point
   * back at the turn that created it (`source_event_id`). None of the three may come from the model:
   * they are supplied by the **entry** that owns the turn (铁律 1/8). That is why they live on the
   * execution context — the layer `ToolRegistry.execute` owns — and **not** on a plugin's context:
   * P2-A hands plugins no execution context at all.
   *
   * Optional on purpose: entries that do not know an actor yet keep working, and the approval record
   * degrades to `unknown` rather than inventing a person.
   */
  readonly sessionId?: string;
  readonly actorId?: string;
  readonly sourceEventId?: string;
}

/**
 * A host that can record a pending approval for one exact call (pack §5).
 *
 * The registry asks; it never persists anything itself — persistence, the audit event and the TTL
 * belong to the host (`@xixi/runtime`), which owns the store. Returning `null` means「记不下来」:
 * the registry then falls back to the pre-P2 behaviour (a refusal that tells the model to ask
 * first), so a broken host degrades instead of blocking a turn.
 */
export interface ToolApprovalRequest {
  readonly toolName: string;
  /** The **frozen** arguments, exactly as parsed from the call being asked about. */
  readonly args: Readonly<Record<string, unknown>>;
  /** `toolArgumentsDigest(args)` — the value a later execution grant must match. */
  readonly argsDigest: string;
  readonly context: ToolExecutionContext;
  readonly reason: string;
}

export interface ToolApprovalOutcome {
  readonly approvalId: string;
  readonly expiresAt: string;
  /** Spoken/acted on by the model to ask the person; the host supplies its wording. */
  readonly note?: string;
}

export interface ToolApprovalGate {
  request(input: ToolApprovalRequest): Promise<ToolApprovalOutcome | null> | ToolApprovalOutcome | null;
}

/** Proof that a person confirmed one *exact* call (pack §5: 「执行 EXACT frozen call」). */
export interface ToolApprovalGrant {
  readonly approvalId: string;
  /** Digest of the arguments that were confirmed; a different call must be refused. */
  readonly argsDigest: string;
  readonly approvedBy: string;
}

export interface ToolExecutionOptions {
  /** Present only on the confirmation path; absent means「这次调用没有被同意过」. */
  readonly approval?: ToolApprovalGrant;
}

/**
 * Canonical JSON of a tool call's arguments: object keys sorted, recursively.
 *
 * This is what makes 「冻结参数」 checkable. If anything re-serialises or re-generates the arguments,
 * the canonical form changes and the execution is refused. Sorting is what makes the digest
 * independent of the key order the provider happened to use.
 */
export function canonicalToolArguments(args: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(sortJson(args));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortJson(entry));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortJson(source[key]);
    return sorted;
  }
  return value;
}

/** SHA-256 (hex) of {@link canonicalToolArguments}; the one digest both sides of approval use. */
export function toolArgumentsDigest(args: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalToolArguments(args)).digest('hex');
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

class ToolTimeoutError extends Error {}

async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number, label: string, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Reject first: a cooperative cancellation may synchronously resolve the tool promise.
          reject(new ToolTimeoutError(`${label} 超时（${timeoutMs}ms）`));
          controller.abort();
        }, timeoutMs);
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
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string; outcome?: 'unknown' }> {
  const declared = declaredArgumentNames(tool);
  const unknown = Object.keys(args).filter((key) => !declared.includes(key));
  if (unknown.length > 0) return { ok: false, error: `不认识的参数：${unknown.join('、')}` };
  const timeoutMs = Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(1, Math.floor(tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS)));
  try {
    // Use the same fail-closed subset as event contracts; unsupported keywords never pass silently.
    const schema = tool.parameters as JsonSchema;
    assertEnforceable(schema);
    const validation = validateSchema(schema, args);
    if (!validation.ok) return { ok: false, error: `INVALID_TOOL_ARGUMENTS: ${validation.problems.join('; ')}` };
    const controller = new AbortController();
    const result = await withTimeout(() => tool.execute(args, { ...context, signal: controller.signal }), timeoutMs, tool.name, controller);
    return { ok: true, result };
  } catch (cause) {
    if (cause instanceof ToolTimeoutError && tool.risk === 'write') {
      return { ok: false, error: `${cause.message}；执行结果未知，不能自动重试`, outcome: 'unknown' };
    }
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
  /** Host that records pending approvals (pack §5). Absent = `ask` behaves as it did before P2. */
  readonly approval?: ToolApprovalGate;
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
  readonly #approval: ToolApprovalGate | undefined;

  constructor(options: ToolRegistryOptions = {}) {
    this.#permission = options.permission ?? new ToolPermission({ role: options.role ?? 'resident' });
    this.#role = options.role ?? 'resident';
    const requested = options.maxToolRounds ?? MAX_TOOL_ROUNDS;
    this.#maxToolRounds = Math.max(0, Math.min(MAX_TOOL_ROUNDS, Math.floor(Number.isFinite(requested) ? requested : MAX_TOOL_ROUNDS)));
    this.#onToolCall = options.onToolCall;
    this.#approval = options.approval;
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

  /**
   * What the model may see in this scope.
   *
   * `allow` tools and `ask` tools are both offered; only `deny` is invisible (V0.3 P2-B). The
   * distinction matters because of pack §5's flow — `model tool_call → permission ASK → 持久化
   * PendingToolApproval → 西西问一句 → 用户确认 → 执行冻结的调用`. If an `ask` tool were not
   * advertised, the model could never produce the tool call that starts that flow, and the only way
   * to reach the ASK branch would be a hallucinated name — i.e. the审批 would be unreachable from a
   * real turn. Deny semantics are unchanged: a refused tool is still never offered.
   */
  listForAgent(scope: AgentScope): AgentTool[] {
    return this.all().filter((tool) => this.check(tool.name, scope).verdict !== 'deny');
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
    return tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: canonicalSchema(tool.parameters) as Record<string, unknown> }));
  }

  /**
   * Run one requested call, whatever happens: the model always gets a payload back.
   *
   * Three outcomes are possible for a call the policy marks `ask` (V0.3 P2-B, pack §5):
   *
   *  1. **no grant, gate present** — the frozen call is recorded by the host and the model is told to
   *     ask the person; nothing runs (`APPROVAL_REQUIRED`);
   *  2. **no grant, no gate** — the pre-P2 behaviour: a refusal telling the model to ask first;
   *  3. **grant present** — the call runs **only if** its arguments still hash to the confirmed
   *     digest; otherwise the execution is refused (`APPROVAL_MISMATCH`), which is what makes
   *     「确认之后不许重新生成参数」 a property of the execution path rather than of a caller.
   */
  async execute(call: ToolCall, context: ToolExecutionContext, options: ToolExecutionOptions = {}): Promise<ToolExecution> {
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
    if (permission.verdict === 'deny') {
      return reply(
        { error: '这个能力现在不能用：别硬猜，直接说这件事你做不到。' },
        { name: tool.name, args, ok: false, result: null, error: 'PERMISSION_DENIED' },
        permission,
      );
    }

    if (permission.verdict === 'ask') {
      const grant = options.approval;
      if (grant === undefined) {
        const recorded = await this.#askForApproval(tool.name, args, context, permission.reason);
        if (recorded !== null) {
          return reply(
            {
              requiresApproval: true,
              approvalId: recorded.approvalId,
              expiresAt: recorded.expiresAt,
              note: recorded.note ?? '已经记下来了：先问一句要不要这么做，等对方点头再动手；不要自己先做。',
            },
            { name: tool.name, args, ok: false, result: null, error: 'APPROVAL_REQUIRED' },
            permission,
          );
        }
        return reply(
          { error: '这个能力要先得到同意：先问一句，别自己动手。' },
          { name: tool.name, args, ok: false, result: null, error: 'ASK' },
          permission,
        );
      }
      if (toolArgumentsDigest(args) !== grant.argsDigest) {
        // The person confirmed one exact call; this is not it. Nothing runs.
        return reply(
          { error: '这次同意对应的是当时那组参数，现在的参数不一样：不能执行，得重新问一次。' },
          { name: tool.name, args, ok: false, result: null, error: 'APPROVAL_MISMATCH' },
          permission,
        );
      }
    }

    const outcome = await executeTool(tool, args, { timezone: context.timezone, now: context.now,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.actorId === undefined ? {} : { actorId: context.actorId }),
      ...(context.sourceEventId === undefined ? {} : { sourceEventId: context.sourceEventId }) });
    if (!outcome.ok) {
      return reply({ error: outcome.error, ...(outcome.outcome === undefined ? {} : { outcome: outcome.outcome, retrySafe: false }) }, { name: tool.name, args, ok: false, result: null, error: outcome.error }, permission);
    }
    return reply(outcome.result, { name: tool.name, args, ok: true, result: outcome.result, error: null }, permission);
  }

  /** Ask the host to record a pending approval; `null` when there is no host or it refuses to. */
  async #askForApproval(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    reason: string,
  ): Promise<ToolApprovalOutcome | null> {
    if (this.#approval === undefined) return null;
    try {
      return await this.#approval.request({ toolName, args, argsDigest: toolArgumentsDigest(args), context, reason });
    } catch {
      // A host that cannot persist must not take the turn down: fall back to「先问一句」.
      return null;
    }
  }
}

export interface BuiltinToolRegistryOptions extends DefaultToolsOptions {
  readonly maxToolRounds?: number;
  readonly role?: ToolRole;
  readonly permission?: ToolPermissionPolicy;
  readonly onToolCall?: (record: ToolCallRecord) => void;
  readonly approval?: ToolApprovalGate;
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
    ...(options.approval === undefined ? {} : { approval: options.approval }),
  });
}
