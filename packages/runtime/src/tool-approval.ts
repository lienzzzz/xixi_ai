/**
 * 工具审批的宿主侧（pack `docs/03_AGENT_PLUGIN.md` §5）。
 *
 * pack 的流程，逐段对应到代码：
 *
 * ```text
 * model tool_call                      → ToolRegistry.execute（brain-adapter）
 * → permission ASK                     → ToolPermission.check 返回 'ask'
 * → persist PendingToolApproval        → ToolApprovalManager.request（本文件）+ 007 迁移的表
 * → 西西自然问「要我帮你记下来吗？」      → 工具结果里回 { requiresApproval, approvalId, note }，模型照这句话说
 * → 用户确认                            → approve({ approvalId, actorId })
 * → execute EXACT frozen call          → registry.execute(冻结的调用, 上下文, { approval: 摘要 })
 * → append tool result                 → conversation.turn（action TOOL），下一轮读得到
 * → resume agent turn / new turn       → 由入口决定用哪一轮接住（本文件只负责把事实写全）
 * ```
 *
 * 三条不变量由**程序**保证，不是靠调用方自觉：
 *
 *   1. **冻结参数**：确认之后执行的是表里那一组参数；执行路径比对摘要（`frozen_args_digest`），
 *      不一致就拒（`APPROVAL_MISMATCH`）。
 *   2. **到期与拒绝都不执行**：两者都落 `tool.approval.changed`（原因码 + 谁点的头），
 *      并且 `pending → denied|expired` 之后没有可能再走到 `executed`（domain 的状态机拒绝）。
 *   3. **没声明就不 ASK**：`ask` 表来自 `config.tools.approval.ask`（缺省为空）。没有任何工具
 *      会因为「看起来危险」被自动加进来 —— 审批和权限一样，要先声明。
 */
import {
  DEFAULT_TOOL_APPROVAL_SETTINGS,
  ToolApprovalStore,
  approvalExpiry,
  type ToolApproval,
  type ToolApprovalSettings,
  type XixiStore,
} from '@xixi/domain';
import {
  type AgentScope,
  type ToolApprovalGate,
  type ToolApprovalOutcome,
  type ToolApprovalRequest,
  type ToolExecution,
  type ToolRegistry,
} from '@xixi/brain-adapter';
import { toOffsetIso } from '@xixi/contracts';

/** 认不出提问者时的 actor（不编造一个人，也不留空）。 */
export const UNKNOWN_ACTOR = 'unknown';

export interface ToolApprovalManagerOptions {
  readonly store: XixiStore;
  /**
   * 执行冻结调用用的工具链。装配顺序上它常常还没建好（`ToolRegistry` 需要本对象当
   * `approval` 宿主），所以可以先不给，建好后用 `useRegistry()` 补上；
   * `request()`（记待批）不需要它，`approve()` 需要。
   */
  readonly registry?: ToolRegistry | undefined;
  /**
   * 审批设置。缺省 = `DEFAULT_TOOL_APPROVAL_SETTINGS`（**没有任何工具需要审批**）。
   * 入口用 `parseToolApprovalSettings(config.tools)` 把 `config/xixi.yaml` 的声明传进来。
   */
  readonly settings?: ToolApprovalSettings | undefined;
  readonly now?: () => Date;
  /** 事件信封的 `source`，默认 `tools`。 */
  readonly source?: string | undefined;
  /** 记「工具结果」那条 `conversation.turn` 时用的 role/source（默认 assistant / tools）。 */
  readonly turnSource?: string | undefined;
}

/** 一次决定的结果，给调用方（入口/面板）用来决定说什么，不再自己解读字符串。 */
export interface ToolApprovalDecision {
  readonly status: 'executed' | 'denied' | 'expired' | 'refused';
  readonly approvalId: string;
  /** 决定之后的那一行（已落库）。 */
  readonly approval: ToolApproval;
  /** 只有 `executed` 才有：冻结调用的执行结果。 */
  readonly execution: ToolExecution | null;
  /** 程序原因码（`user_denied` / `approval_expired` / `approval_executed` …）。 */
  readonly reasonCode: string;
}

export class ToolApprovalError extends Error {
  readonly code: 'UNKNOWN_APPROVAL' | 'NO_REGISTRY';
  constructor(code: 'UNKNOWN_APPROVAL' | 'NO_REGISTRY', message: string) {
    super(message);
    this.name = 'ToolApprovalError';
    this.code = code;
  }
}

export class ToolApprovalManager implements ToolApprovalGate {
  readonly #approvals: ToolApprovalStore;
  readonly #store: XixiStore;
  readonly #settings: ToolApprovalSettings;
  readonly #now: () => Date;
  readonly #source: string;
  readonly #turnSource: string;
  #registry: ToolRegistry | undefined;

  constructor(options: ToolApprovalManagerOptions) {
    this.#store = options.store;
    this.#approvals = new ToolApprovalStore(options.store);
    this.#registry = options.registry;
    this.#settings = options.settings ?? DEFAULT_TOOL_APPROVAL_SETTINGS;
    this.#now = options.now ?? (() => new Date());
    this.#source = options.source ?? 'tools';
    this.#turnSource = options.turnSource ?? 'tools';
  }

  /** 装配顺序的接口：`ToolRegistry` 建好之后把执行路径补上（`approve()` 用它）。 */
  useRegistry(registry: ToolRegistry): this {
    this.#registry = registry;
    return this;
  }

  /** 这一套设置里声明的、需要人工确认的工具名（空 = 不 ASK）。 */
  get askTools(): readonly string[] {
    return this.#settings.ask;
  }

  get ttlSeconds(): number {
    return this.#settings.ttlSeconds;
  }

  /**
   * pack §5 的「persist PendingToolApproval」：把**这一组参数**记下来，返回它的 id 与到期时刻。
   *
   * 由 `ToolRegistry` 在 `ask` 分支里调用（`ToolApprovalGate`）；异常不会往上冒 —— registry 把
   * 记不下来当作「退回到先问一句」，而不是让整轮对话失败。
   */
  request(input: ToolApprovalRequest): ToolApprovalOutcome {
    const at = input.context.now ?? this.#now();
    const change = this.#approvals.request({
      sessionId: input.context.sessionId ?? 'unknown',
      actorId: input.context.actorId ?? UNKNOWN_ACTOR,
      toolName: input.toolName,
      frozenArgs: input.args,
      frozenArgsDigest: input.argsDigest,
      scope: input.context.scope,
      timezone: input.context.timezone,
      requestedAt: toOffsetIso(at),
      expiresAt: approvalExpiry(at, this.#settings.ttlSeconds),
      sourceEventId: input.context.sourceEventId ?? null,
    });
    return {
      approvalId: change.approval.approvalId,
      expiresAt: change.approval.expiresAt,
      note: `已经记下来了：先问一句要不要做「${input.toolName}」，等对方点头再做；别自己先动手。`,
    };
  }

  get(approvalId: string): ToolApproval | null {
    return this.#approvals.get(approvalId);
  }

  /** 还活着、还没到期的待批请求（入口启动时用它恢复「谁在等谁点头」）。 */
  pending(now: Date = this.#now()): ToolApproval[] {
    return this.#approvals.pending(now);
  }

  /** 过期的那些：落 `approval_expired` 并返回，**一个都不执行**。 */
  expirePending(now: Date = this.#now()): ToolApproval[] {
    return this.#approvals.expire(now, this.#source).map((change) => change.approval);
  }

  /**
   * 用户点头：先落 `approved`（人的决定是事实），再执行**冻结的那个调用**。
   *
   * 执行路径把摘要交给 registry 比对；`approved` 之后无论执行成功与否都落 `executed`
   * （`approval_executed` / `approval_execution_failed`），这样「外部动作做过没有」有据可查。
   */
  async approve(input: { readonly approvalId: string; readonly actorId?: string; readonly now?: Date }): Promise<ToolApprovalDecision> {
    const at = input.now ?? this.#now();
    const current = this.#approvals.get(input.approvalId);
    if (current === null) throw new ToolApprovalError('UNKNOWN_APPROVAL', `没有这条待批请求：${input.approvalId}`);
    if (current.status !== 'pending') {
      // 幂等：已决定过的请求就照着它现在的状态回答，不重新执行（外部动作只做一次）。
      return this.#alreadyDecided(current);
    }
    if (Date.parse(current.expiresAt) <= at.getTime()) {
      return this.#expire(current, at);
    }

    const actorId = input.actorId ?? UNKNOWN_ACTOR;
    const approved = this.#approvals.transition(current.approvalId, 'approved', {
      at,
      actorId,
      reasonCode: 'user_approved',
      source: this.#source,
    });

    if (this.#registry === undefined) {
      throw new ToolApprovalError('NO_REGISTRY', '审批宿主还没有接上工具链（useRegistry）');
    }
    const execution = await this.#registry.execute(
      { name: approved.approval.toolName, arguments: approved.approval.frozenArgs },
      {
        scope: approved.approval.scope as AgentScope,
        timezone: approved.approval.timezone,
        now: at,
        sessionId: approved.approval.sessionId,
        actorId,
        ...(approved.approval.sourceEventId === null ? {} : { sourceEventId: approved.approval.sourceEventId }),
      },
      {
        // 摘要就是「冻结」这件事本身：参数被重新生成/篡改时，这里是第一道闸。
        approval: { approvalId: approved.approval.approvalId, argsDigest: approved.approval.frozenArgsDigest, approvedBy: actorId },
      },
    );

    const ok = execution.record.ok;
    const tampered = execution.record.error === 'APPROVAL_MISMATCH';
    const decided = tampered
      ? // 冻结参数对不上（行被改过）：这次同意作废，落 denied 与 approval_mismatch，绝不执行。
        this.#approvals.transition(current.approvalId, 'denied', {
          at,
          actorId: 'system',
          reasonCode: 'approval_mismatch',
          source: this.#source,
        })
      : this.#approvals.transition(current.approvalId, 'executed', {
          at,
          actorId,
          reasonCode: ok ? 'approval_executed' : 'approval_execution_failed',
          outcomeOk: ok,
          outcomeError: execution.record.error,
          source: this.#source,
        });
    if (!tampered) this.#recordToolResult(decided.approval, execution);
    return {
      status: tampered ? 'refused' : 'executed',
      approvalId: decided.approval.approvalId,
      approval: decided.approval,
      execution,
      reasonCode: decided.approval.reasonCode ?? 'approval_executed',
    };
  }

  /** 用户拒绝：落 `denied` 与审计，**不执行**。 */
  deny(input: { readonly approvalId: string; readonly actorId?: string; readonly now?: Date }): ToolApprovalDecision {
    const at = input.now ?? this.#now();
    const current = this.#approvals.get(input.approvalId);
    if (current === null) throw new ToolApprovalError('UNKNOWN_APPROVAL', `没有这条待批请求：${input.approvalId}`);
    if (current.status !== 'pending') {
      return this.#alreadyDecided(current);
    }
    const denied = this.#approvals.transition(current.approvalId, 'denied', {
      at,
      actorId: input.actorId ?? UNKNOWN_ACTOR,
      reasonCode: 'user_denied',
      source: this.#source,
    });
    // 拒绝也写一条结果轮：下一轮读得到「这件事没有做」，不用模型去猜（pack §5 的 append tool result）。
    this.#recordTurn(denied.approval, '这件事没有做：对方没有同意。');
    return {
      status: 'denied',
      approvalId: denied.approval.approvalId,
      approval: denied.approval,
      execution: null,
      reasonCode: 'user_denied',
    };
  }

  /** 已经决定过的请求：照着现在的状态回答，绝不重新执行。 */
  #alreadyDecided(current: ToolApproval): ToolApprovalDecision {
    const status: ToolApprovalDecision['status'] =
      current.status === 'executed' ? 'executed' : current.status === 'denied' ? 'denied' : current.status === 'expired' ? 'expired' : 'refused';
    return {
      status,
      approvalId: current.approvalId,
      approval: current,
      execution: null,
      reasonCode: current.reasonCode ?? current.status,
    };
  }

  #expire(approval: ToolApproval, at: Date): ToolApprovalDecision {
    const expired = this.#approvals.transition(approval.approvalId, 'expired', {
      at,
      reasonCode: 'approval_expired',
      source: this.#source,
    });
    this.#recordTurn(expired.approval, '这件事没有做：等太久了，已经作废。');
    return {
      status: 'expired',
      approvalId: expired.approval.approvalId,
      approval: expired.approval,
      execution: null,
      reasonCode: 'approval_expired',
    };
  }

  /**
   * pack §5 的「append tool result」：把这次执行（或它的失败）写进对话日志。
   *
   * 为什么写 `conversation.turn` 而不是新开一种事件：日志里的轮次是**下一轮读得到**的东西
   * （`recentTurns` 直接按 `conversation.turn` 查），所以「确认之后的结果」在重启后仍然在。
   * 会话不存在或已经结束时静默跳过 —— 审批本身已经落库落日志，不该因为写不进一条轮次而失败。
   */
  #recordToolResult(approval: ToolApproval, execution: ToolExecution): void {
    const ok = execution.record.ok;
    const text = ok
      ? `（${approval.toolName} 已经按你同意的做了。）`
      : `（${approval.toolName} 没有做成：${execution.record.error ?? '未知原因'}。）`;
    this.#recordTurn(approval, text);
  }

  #recordTurn(approval: ToolApproval, text: string): void {
    try {
      this.#store.recordTurn({
        sessionId: approval.sessionId,
        role: 'assistant',
        action: 'TOOL',
        text,
        toolName: approval.toolName,
        source: this.#turnSource,
        confidence: 1,
      });
    } catch {
      // 没有这条会话（或审批发生在会话结束之后）：审批的 row 与事件已经写全，这里跳过。
    }
  }
}
