/**
 * 工具审批的领域面（pack `docs/03_AGENT_PLUGIN.md` §5）——「一条待批的工具调用」这件事。
 *
 * 三件事在这里定死，别处只消费：
 *
 *   1. **七个字段就是 pack 的七个字段**：`approvalId` / `sessionId` / `actorId` / `toolName` /
 *      `frozenArgs` / `requestedAt` / `expiresAt`。表里另有四列是执行与恢复需要的程序事实
 *      （`frozen_args_digest`、`scope`、`timezone`、`source_event_id`），它们不改变这七个语义。
 *   2. **状态机 + 事件**：每次状态变化在**同一事务**里改表并追加一条 `tool.approval.changed`
 *      （与未完话题同一套做法）。日志是事实来源，表可以被日志重建，所以重启后「谁在等谁点头」
 *      不会丢，也不会重复执行已经做过的外部动作（AGENTS.md §3）。
 *   3. **冻结参数是摘要化的**：表里存参数正文，日志里只留 `frozen_args_digest`。确认之后执行的
 *      必须是当时那一组参数 —— 这条不变量由 runtime 的执行路径比对摘要，而不是靠调用方自觉。
 *
 * 模型不参与这里任何一步（铁律 1）：状态由程序写、事件由程序写、谁点的头由入口告诉程序。
 */
import { randomUUID } from 'node:crypto';

import { buildEvent, newCorrelationId, toOffsetIso, type EventEnvelope, type JsonValue } from '@xixi/contracts';

import type { StoredEvent, XixiStore } from './store.ts';

/** 一条待批调用的生命周期状态；与 pack §5 的 `PendingToolApproval.status` 同一套取值。 */
export const TOOL_APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'denied', 'expired', 'executed'] as const);

export type ToolApprovalStatus = (typeof TOOL_APPROVAL_STATUSES)[number];

/**
 * 事件里的原因码（程序写的枚举，不是模型写的句子）。
 *
 * `approval_requested` 落一次待批；`user_approved`/`user_denied` 是**人**的决定；
 * `approval_expired` 是程序判定的结束；`approval_executed`/`approval_execution_failed` 是真正跑过
 * 冻结调用之后的结果。铁律 5：事件里只有原因码、状态与分数，没有模型私有推理。
 */
export const TOOL_APPROVAL_REASON_CODES = Object.freeze([
  'approval_requested',
  'user_approved',
  'user_denied',
  'approval_expired',
  'approval_executed',
  'approval_execution_failed',
] as const);

export type ToolApprovalReasonCode = (typeof TOOL_APPROVAL_REASON_CODES)[number];

/** 一条待批的工具调用（pack §5 的 `PendingToolApproval` + 恢复执行需要的程序事实）。 */
export interface ToolApproval {
  readonly approvalId: string;
  /** pack §5 的 `sessionId`：哪一段会话在等。 */
  readonly sessionId: string;
  /** pack §5 的 `actorId`：谁在问；认不出来时是 `unknown`，不编造一个人。 */
  readonly actorId: string;
  /** pack §5 的 `toolName`。 */
  readonly toolName: string;
  /** pack §5 的 `frozenArgs`：**确认之后要一字不差执行的那一组**参数。 */
  readonly frozenArgs: Readonly<Record<string, unknown>>;
  /** pack §5 的 `requestedAt` / `expiresAt`（offset ISO）。 */
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly status: ToolApprovalStatus;
  /** `frozenArgs` 的规范化摘要；执行前要比对的就是它。 */
  readonly frozenArgsDigest: string;
  /** 恢复执行时重建 `ToolExecutionContext` 用（模型不能提供）。 */
  readonly scope: string;
  readonly timezone: string;
  /** 触发它的那一轮事件 id（`source_event_id`）。 */
  readonly sourceEventId: string | null;
  readonly reasonCode: string | null;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly executedAt: string | null;
  readonly outcomeOk: boolean | null;
  readonly outcomeError: string | null;
}

export interface NewToolApproval {
  readonly approvalId?: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly toolName: string;
  readonly frozenArgs: Readonly<Record<string, unknown>>;
  readonly frozenArgsDigest: string;
  readonly scope: string;
  readonly timezone: string;
  readonly requestedAt?: string;
  readonly expiresAt: string;
  readonly sourceEventId?: string | null;
  readonly reasonCode?: string;
}

export interface ToolApprovalQuery {
  readonly status?: ToolApprovalStatus | readonly ToolApprovalStatus[] | undefined;
  readonly sessionId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface TransitionToolApprovalOptions {
  readonly at?: Date | undefined;
  /** 谁的点头/拒绝（入口给的身份）；程序判定（到期）时不传。 */
  readonly actorId?: string | undefined;
  readonly reasonCode?: string | undefined;
  /** `executed` 时这次调用的结果；失败也记下来（外部动作做过没做过要比对得到）。 */
  readonly outcomeOk?: boolean | undefined;
  readonly outcomeError?: string | null | undefined;
  /** 事件信封的 `source`（默认 `tools`）。 */
  readonly source?: string | undefined;
}

/** 一次状态变化 + 它写下的那条事件（已经是目标状态时 `event` 为 null，幂等）。 */
export interface ToolApprovalChange {
  readonly approval: ToolApproval;
  readonly event: StoredEvent | null;
}

/**
 * 审批设置的出厂默认：**没有任何工具需要审批**。
 *
 * 这直接对应 pack §3 的「permissions 里的东西没声明就不给」：审批同样要先声明。
 * `config/xixi.yaml` 的 `tools.approval.ask` 是声明面，没写就是空表 —— 不做「默认先 ASK 再说」
 * 的反向默认，否则每个部署都会突然多出一步人工确认。
 */
export const DEFAULT_TOOL_APPROVAL_SETTINGS: ToolApprovalSettings = Object.freeze({
  ask: Object.freeze([]) as readonly string[],
  ttlSeconds: 300,
});

export interface ToolApprovalSettings {
  /** 需要人工确认的工具名（精确匹配）。空 = 不 ASK。 */
  readonly ask: readonly string[];
  /** 待批请求的有效期（秒）：过了这个点不执行，落 `approval_expired`。 */
  readonly ttlSeconds: number;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name.length === 0 || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * 读 `config.tools`（`tools.approval.ask` / `tools.approval.ttl_seconds`）。
 *
 * 容错取向与 `open_threads` / `self_model` 一致：坏值退回默认，不让一个错字把工具链搞崩。
 * 名字只做「非空去重」，**不校验存在性**：声明了一个不存在的工具名只是没有效果，而拒绝加载配置
 * 会把整台西西拦在门外。
 */
export function parseToolApprovalSettings(source?: Readonly<Record<string, unknown>> | undefined): ToolApprovalSettings {
  const section = source?.['approval'];
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return DEFAULT_TOOL_APPROVAL_SETTINGS;
  const approval = section as Record<string, unknown>;
  const ask = stringList(approval['ask']);
  const rawTtl = approval['ttl_seconds'];
  const ttlSeconds =
    typeof rawTtl === 'number' && Number.isFinite(rawTtl) && rawTtl >= 1
      ? Math.min(Math.floor(rawTtl), 24 * 60 * 60)
      : DEFAULT_TOOL_APPROVAL_SETTINGS.ttlSeconds;
  return { ask, ttlSeconds };
}

/** 到期时刻：`requestedAt` + TTL（秒），仍然是 offset ISO。 */
export function approvalExpiry(requestedAt: Date, ttlSeconds: number): string {
  return toOffsetIso(new Date(requestedAt.getTime() + ttlSeconds * 1000));
}

/**
 * `XixiStore` 之上的薄门面（与 `OpenThreadStore` 同一套做法：SQLite 仍只由 domain 包打开）。
 *
 * 注意它**不执行任何工具**：执行是 runtime 的事（`ToolApprovalManager`），这里只负责
 * 「这条待批是什么状态、下一步该是什么状态」，这样「谁执行、谁审批」不会缠在一起。
 */
export class ToolApprovalStore {
  readonly #store: XixiStore;

  constructor(store: XixiStore) {
    this.#store = store;
  }

  /** 记一条待批请求（`pending`），并写下 `approval_requested`。 */
  request(input: NewToolApproval): ToolApprovalChange {
    return this.#store.insertToolApproval(input);
  }

  get(approvalId: string): ToolApproval | null {
    return this.#store.toolApproval(approvalId);
  }

  list(query: ToolApprovalQuery = {}): ToolApproval[] {
    return this.#store.toolApprovals(query);
  }

  /** 还活着、还没到期的待批请求（按请求时间从早到晚）。 */
  pending(now: Date): ToolApproval[] {
    const at = now.getTime();
    return this.#store
      .toolApprovals({ status: 'pending' })
      .filter((approval) => Date.parse(approval.expiresAt) > at)
      .sort((a, b) => (a.requestedAt === b.requestedAt ? a.approvalId.localeCompare(b.approvalId) : a.requestedAt.localeCompare(b.requestedAt)));
  }

  /** 状态迁移；同一个状态再迁一次是幂等（返回的 `event` 为 null）。 */
  transition(approvalId: string, status: ToolApprovalStatus, options: TransitionToolApprovalOptions = {}): ToolApprovalChange {
    return this.#store.transitionToolApproval(approvalId, status, options);
  }

  /** 扫一遍过期的待批请求，逐个落 `expired`；返回这次真的结束掉的那些。 */
  expire(now: Date, source = 'tools'): ToolApprovalChange[] {
    const at = now.getTime();
    const changes: ToolApprovalChange[] = [];
    for (const approval of this.#store.toolApprovals({ status: 'pending' })) {
      if (Date.parse(approval.expiresAt) > at) continue;
      changes.push(
        this.#store.transitionToolApproval(approval.approvalId, 'expired', {
          at: now,
          reasonCode: 'approval_expired',
          source,
        }),
      );
    }
    return changes;
  }

  /** 这条待批写过的事件，按日志顺序（审计用；与 `openThreadHistory` 对齐）。 */
  history(approvalId: string): StoredEvent[] {
    return this.#store.readEvents({ type: 'tool.approval.changed', limit: Number.MAX_SAFE_INTEGER }).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload['approval_id'] === approvalId;
    });
  }
}

/**
 * 一条审批事件的信封与 payload（store.ts 的写入路径用；导出是为了让「事件形状」只有一份）。
 *
 * 铁律 5：payload 里没有冻结参数正文、没有对话原文、没有模型推理，只有
 * `reason_code` 与一次状态变化的分数（`1` = 人明确做的决定，`0` = 程序判定的结束）。
 */
export function buildToolApprovalEvent(
  approval: ToolApproval,
  status: ToolApprovalStatus,
  reasonCode: string,
  at: string,
  source: string,
): EventEnvelope {
  return buildEvent({
    event_type: 'tool.approval.changed',
    source,
    actor: 'system',
    confidence: 1,
    timestamp: at,
    correlation_id: newCorrelationId(),
    payload: toolApprovalPayload(approval, status, reasonCode),
  });
}

/** 事件 payload 的字段表（`packages/contracts/schemas/events/tool.approval.changed.v1.json`）。 */
export function toolApprovalPayload(
  approval: ToolApproval,
  status: ToolApprovalStatus,
  reasonCode: string,
): Record<string, JsonValue> {
  return {
    approval_id: approval.approvalId,
    tool_name: approval.toolName,
    status,
    reason_code: reasonCode,
    session_id: approval.sessionId,
    actor_id: approval.actorId,
    source_event_id: approval.sourceEventId,
    frozen_args_digest: approval.frozenArgsDigest,
    requested_at: approval.requestedAt,
    expires_at: approval.expiresAt,
    decided_at: approval.decidedAt,
    decided_by: approval.decidedBy,
    score: approvalDecisionScore(status),
  };
}

/** 这次状态变化的可信度：人的决定是 1，程序判定的结束是 0（不是模型给的分数）。 */
export function approvalDecisionScore(status: ToolApprovalStatus): number {
  switch (status) {
    case 'approved':
    case 'denied':
    case 'executed':
      return 1;
    default:
      return 0;
  }
}

/** 新 id：与事件/会话 id 一样带前缀，schema 用 pattern 钉住形状（`apr_` + uuid）。 */
export function newApprovalId(): string {
  return `apr_${randomUUID()}`;
}
