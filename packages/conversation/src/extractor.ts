/**
 * 异步提取器（pack Phase 4 / 《方案》§11.1）：「用户说完 → 立即回复 → turn completed →
 * 后台提取 memory / open thread / self feedback」。
 *
 * 这个类存在的唯一理由是**不阻塞回复**：
 *
 *   * `enqueue(job)` 只把活放进队列（同步、微秒级），真正的提取由**调度器**在之后的宏任务里跑；
 *   * 生产用默认调度器 `setTimeout(run, 0)`（一个 `unref` 过的宏任务）：回复已经交给 TTS/页面了，
 *     提取才发生。语音路径最怕的就是「回复说完还卡着写库」——但「可以随时退出」不等于「可以随手丢」：
 *     进程退出那一刻队列由 `drainOnExit` 兜底（同步跑完；跑不掉才记一行可见日志，t9 F3）；
 *   * 测试注入一个手动调度器，于是「回复返回时还没提取、`flush()` 之后才提取」是可断言的事实，
 *     而不是靠掐秒表。
 *
 * 提取出来的东西全部落库、并且都带 `sourceEventId`（指回那条 `conversation.turn`）：
 *   * **显式反馈** → 学习偏移（`SelfModel.learn`）或当天会话覆盖（`overrideToday`）+ 关系笔记；
 *   * **将来的事**（复用 Phase 3 的规则提取器）→ episodic memory（kind=plan）；
 *   * **稳定的偏好/事实**（「我喜欢…」「我住在…」「我每天…」）→ semantic memory。
 *
 * **不是每句话都进记忆**（AGENTS §5）：三个写入器各有确定的触发条件，绝大多数轮次什么也不写。
 */

import { toOffsetIso } from '@xixi/contracts';
import {
  MemoryStore,
  SelfModel,
  type EpisodicMemory,
  type LearnedDeltaResult,
  type RelationshipNote,
  type SemanticMemory,
  type SessionOverride,
  type XixiStore,
} from '@xixi/domain';

import { interpretFeedbackInput, type FeedbackInterpretation } from './feedback-interpreter.ts';
import { extractOpenThreads } from './topic-engine.ts';

/** 一轮结束后交给后台提取的事实（只有程序知道的东西，没有模型推理）。 */
export interface PostTurnJob {
  readonly sessionId: string;
  /** 用户这一轮说的话（原文只用于当次规则匹配，不落库）。 */
  readonly userText: string;
  /** 西西这一轮说了什么（`null` = 沉默）。 */
  readonly replyText: string | null;
  readonly at: Date;
  /** 用户那条 `conversation.turn` 的事件 id：所有派生记忆都指回它。 */
  readonly userEventId: string | null;
  /**
   * 读空气时模型给出的白名单码（可选）：显式反馈不存在时才用（权重 0.4）。
   *
   * 生产由 `ConversationEngine` 从 `proactive.decision.model_reason_code` 取（归属边界见它的
   * `#inferredCodeForTurn`）；这里是纯粹的搬运 —— 白名单校验与偏移表都在
   * `interpretInference`，认不出来的码什么也不写。
   */
  readonly inferredCode?: string | null | undefined;
}

export interface ExtractionResult {
  readonly job: PostTurnJob;
  readonly feedback: FeedbackInterpretation | null;
  readonly learned: readonly LearnedDeltaResult[];
  readonly overrides: readonly SessionOverride[];
  readonly episodic: readonly EpisodicMemory[];
  readonly semantic: readonly SemanticMemory[];
  readonly notes: readonly RelationshipNote[];
}

/** 怎么把「跑一次提取」排到回复之后。默认是一个 unref 过的宏任务。 */
export type ExtractionScheduler = (run: () => void) => void;

export interface TurnMemoryExtractorOptions {
  readonly store: XixiStore;
  readonly selfModel?: SelfModel | undefined;
  readonly memory?: MemoryStore | undefined;
  readonly scheduler?: ExtractionScheduler | undefined;
  /** 提取里出的错（写库失败、规则异常）从这里出来，绝不影响已经说完的那句话。 */
  readonly onError?: ((error: unknown) => void) | undefined;
}

/**
 * 默认调度器：宏任务 + `unref`，既不阻塞回复，也不会让脚本因为一个待办而无法退出。
 *
 * 「可以随时退出」不等于「可以随手丢」：排队中的轮次由 {@link TurnMemoryExtractor} 的
 * `drainOnExit` 兜底 —— 进程退出的那一刻把它同步跑完，跑不掉（库已经关了）才记一行可见日志。
 */
export const DEFAULT_EXTRACTION_SCHEDULER: ExtractionScheduler = (run) => {
  const timer = setTimeout(run, 0);
  timer.unref?.();
};

/**
 * 「退出时还有活没跑」的提取器（模块级，只登记真的排着队的那几个）。
 *
 * 数据丢失不能是无声的（t9 评审 T9-F3 / AGENTS §3）：上面那个定时器是 `unref` 的，进程想退就退 ——
 * 于是「回复说完 → 脚本结束」这一瞬间，队列里那一轮会**悄悄消失**，日志里什么也看不出来。
 * 这里的钩子就是那个瞬间的兜底：先把队列**同步**跑完（`runJob` 是同步的，`exit` 里也能跑），
 * 真的跑不掉（库已经关了）才往 stderr 写清丢了几轮、是哪几轮。
 *
 * 只装一个钩子（`process` 上的监听器不随实例增长），登记集合在队列清空时就删掉自己。
 * 强杀 / 断电仍然来不及 —— 那种时刻只能靠持久化待办，而持久化需要新的事件类型与表（不在本任务范围）。
 */
const pendingAtExit = new Set<TurnMemoryExtractor>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const extractor of [...pendingAtExit]) {
      // 退出路径上不能再抛：能跑就跑，跑不掉由 `drainOnExit` 写那一行日志。
      try {
        extractor.drainOnExit();
      } catch {
        /* 已经尽力了 */
      }
    }
  });
}

/** 稳定的偏好/事实（semantic memory）的识别规则：短句、第一人称、非疑问。 */
const SEMANTIC_RULES: readonly { readonly property: string; readonly pattern: RegExp }[] = Object.freeze([
  { property: 'preference', pattern: /我(?:很|挺|特别)?(?:喜欢|爱)([^。！？!?，,；;]{2,20})/ },
  { property: 'preference', pattern: /我(?:不喜欢|不爱|讨厌)([^。！？!?，,；;]{2,20})/ },
  { property: 'place', pattern: /我(?:住|住在|老家在)([^。！？!?，,；;]{2,20})/ },
  { property: 'routine', pattern: /我(?:每天|平常|平时|一般)([^。！？!?，,；;]{2,24})/ },
]);

export class TurnMemoryExtractor {
  readonly #store: XixiStore;
  readonly #selfModel: SelfModel;
  readonly #memory: MemoryStore;
  readonly #scheduler: ExtractionScheduler;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #queue: PostTurnJob[] = [];
  #processed = 0;
  #errors = 0;

  constructor(options: TurnMemoryExtractorOptions) {
    this.#store = options.store;
    this.#selfModel = options.selfModel ?? new SelfModel(options.store);
    this.#memory = options.memory ?? new MemoryStore(options.store);
    this.#scheduler = options.scheduler ?? DEFAULT_EXTRACTION_SCHEDULER;
    this.#onError = options.onError;
  }

  /** 还没跑的活（面板/测试看得见「回复之后还有多少提取在排队」）。 */
  get pending(): number {
    return this.#queue.length;
  }

  /** 已经跑完多少轮提取。 */
  get processed(): number {
    return this.#processed;
  }

  /** 提取里出过几次错（出错不抛出，只计数并交给 `onError`）。 */
  get errors(): number {
    return this.#errors;
  }

  /** 把一轮排进后台队列。**立即返回**，不做任何规则匹配，更不写库。 */
  enqueue(job: PostTurnJob): void {
    this.#queue.push(job);
    // 排队期间进程若退出，这一轮就是「可能丢」的那一轮：装兜底钩子并登记自己。
    installExitHook();
    pendingAtExit.add(this);
    this.#scheduler(() => this.#drain());
  }

  /** 跑掉所有排队的活（测试、关机前、`--self-test`）。 */
  async flush(): Promise<void> {
    while (this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (job === undefined) break;
      this.#runSafely(job);
    }
    pendingAtExit.delete(this);
  }

  /**
   * 退出兜底：把还排着队的活**同步**跑掉（`runJob` 是同步的，所以 `process.once('exit')` 里也能跑）；
   * 跑不掉的（库已经关了、规则抛错）往 stderr 写一行，说清丢了几轮、是哪几轮 —— 每一轮都带着
   * `sourceEventId`，可以回到事件日志重放。返回没能跑掉的轮数。
   *
   * 模块级的 `exit` 钩子会自动调它；调用方也可以在任何「准备关库」的地方显式调一次。
   */
  drainOnExit(): number {
    const lost: PostTurnJob[] = [];
    while (this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (job === undefined) break;
      if (!this.#runSafely(job)) lost.push(job);
    }
    pendingAtExit.delete(this);
    if (lost.length > 0) {
      const rounds = lost.map((job) => `${job.sessionId}/${job.userEventId ?? '（无轮次事件）'}`).join('、');
      process.stderr.write(
        `[xixi] 退出时丢了 ${lost.length} 轮后台提取（${rounds}）：库可能已经关了，这些轮次可在事件日志里重放\n`,
      );
    }
    return lost.length;
  }

  /**
   * 真正干活的同步函数（测试可以直接调它，跳过队列）。
   *
   * 顺序：反馈解释（可能改人格/写覆盖）→ episodic（将来的事、这次纠正）→ semantic（稳定偏好）。
   */
  runJob(job: PostTurnJob): ExtractionResult {
    const feedback = interpretFeedbackInput({ text: job.userText, inferredCode: job.inferredCode ?? null });
    const learned: LearnedDeltaResult[] = [];
    const overrides: SessionOverride[] = [];
    const episodic: EpisodicMemory[] = [];
    const semantic: SemanticMemory[] = [];
    const notes: RelationshipNote[] = [];

    if (feedback !== null) {
      // 落库用**名义值**：权重由 `SelfModel.learn` 按 `sourceType` 乘一次（显式 1.0 / 推断 0.4）。
      // `feedback.deltas` 是已乘权重的视图，拿它落库会把推断乘两遍（0.4 × 0.4）。
      for (const [property, delta] of Object.entries(feedback.nominalDeltas)) {
        learned.push(
          this.#selfModel.learn({
            property,
            delta,
            sourceType: feedback.source,
            evidence: feedback.evidence,
            confidence: feedback.confidence,
            at: job.at,
            sourceEventId: job.userEventId,
          }),
        );
      }
      if (Object.keys(feedback.sessionDeltas).length > 0) {
        overrides.push(
          ...this.#selfModel.overrideToday({
            deltas: feedback.sessionDeltas,
            reason: `用户说：${feedback.evidence}`,
            sourceType: feedback.source,
            sessionId: job.sessionId,
            at: job.at,
          }),
        );
      }
      if (feedback.relationship !== undefined) {
        notes.push(
          this.#memory.recordNote({
            aspect: feedback.relationship.aspect,
            note: feedback.relationship.note,
            sourceType: feedback.source,
            sourceEventId: job.userEventId,
            confidence: feedback.confidence,
          }),
        );
      }
      // 一次明确纠正本身就是「发生过的事」（episodic）：将来她可以回答「你上次说我话多」。
      episodic.push(
        ...this.#recordOnce({
          kind: 'correction',
          summary: `父亲提出：${feedback.relationship?.note ?? feedback.evidence}`,
          sourceType: feedback.source,
          sourceEventId: job.userEventId,
          sessionId: job.sessionId,
          occurredAt: job.at,
          importance: 0.9,
          confidence: feedback.confidence,
        }),
      );
    }

    // 将来的事：复用 Phase 3 的规则提取器（同一套「时间词 + 意愿 + 动作」规则，不另写一套）。
    if (job.userEventId !== null) {
      for (const thread of extractOpenThreads({ text: job.userText, at: job.at, sourceEventId: job.userEventId })) {
        episodic.push(
          ...this.#recordOnce({
            kind: 'plan',
            summary: `记下一件事：${thread.summary}`,
            sourceType: 'program_extraction',
            sourceEventId: job.userEventId,
            sessionId: job.sessionId,
            occurredAt: job.at,
            importance: thread.importance,
          }),
        );
      }
    }

    for (const { property, pattern } of SEMANTIC_RULES) {
      const match = pattern.exec(job.userText);
      if (match === null) continue;
      const statement = match[0].trim();
      if (statement.length === 0 || statement.includes('？') || statement.includes('?')) continue;
      const existing = this.#memory.semantic({ property, limit: 200 });
      if (existing.some((entry) => entry.statement === statement)) continue;
      semantic.push(
        this.#memory.recordSemantic({
          property,
          statement,
          sourceType: 'explicit_correction',
          sourceEventId: job.userEventId,
          confidence: 0.9,
        }),
      );
    }

    return { job, feedback, learned, overrides, episodic, semantic, notes };
  }

  /** 同一条轮次、同一个 kind 只记一次（重放/重启不会把记忆写两遍）。 */
  #recordOnce(input: {
    readonly kind: EpisodicMemory['kind'];
    readonly summary: string;
    readonly sourceType: EpisodicMemory['sourceType'];
    readonly sourceEventId: string | null;
    readonly sessionId: string | null;
    readonly occurredAt: Date;
    readonly importance: number;
    readonly confidence?: number;
  }): EpisodicMemory[] {
    if (input.sourceEventId !== null) {
      const already = this.#memory
        .episodic({ kind: input.kind, limit: 500 })
        .some((entry) => entry.sourceEventId === input.sourceEventId);
      if (already) return [];
    }
    return [
      this.#memory.recordEpisodic({
        summary: input.summary,
        kind: input.kind,
        sourceType: input.sourceType,
        sourceEventId: input.sourceEventId,
        sessionId: input.sessionId,
        occurredAt: toOffsetIso(input.occurredAt),
        importance: input.importance,
        confidence: input.confidence,
      }),
    ];
  }

  #drain(): void {
    while (this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (job === undefined) break;
      this.#runSafely(job);
    }
    pendingAtExit.delete(this);
  }

  /** 跑一轮；出错只计数并交给 `onError`（调用方要不要抛出由它决定）。返回值 = 这一轮跑成了没有。 */
  #runSafely(job: PostTurnJob): boolean {
    try {
      this.runJob(job);
      this.#processed += 1;
      return true;
    } catch (error) {
      this.#errors += 1;
      try {
        this.#onError?.(error);
      } catch {
        // 上报自己炸了也不能把「这一轮失败」变成「整个进程崩」。
      }
      return false;
    }
  }
}
