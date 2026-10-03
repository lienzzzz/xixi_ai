/**
 * 长期记忆检索（pack `docs/02_MEMORY_CONTEXT.md` §2 §3）。
 *
 * 第一版**没有向量库**（pack 的硬规则），排序是确定性的混合打分：
 *
 * ```text
 * score = 词面相关 + 近因 + 重要度 + 置信 + 主语匹配 + 与未完话题的关系
 *         − 陈旧 − 已经说过的惩罚 − 极性冲突
 * ```
 *
 * 三件必须成立的事，写在这里而不是留给调用方记：
 *   1. **每条都有 provenance 与 confidence**：没有来源的记忆不许进提示词（铁律 4），
 *      而 `confidence` 低于 `minConfidence` 的候选在排序前就被挡掉 —— 不是排到最后。
 *   2. **audience filter 先于检索**（pack `01_ARCHITECTURE.md` §5.7）：`visibleTo` 是**先决条件**，
 *      被挡掉的候选连分数都不算，所以它不可能在「候选不够」时被偷偷放回来。
 *   3. **不是每轮 dump 全部记忆**：注入 3~8 条（下限靠配置、上限靠配置且被夹进 [3, 8]），
 *      并且每条都要过一条分数下限 —— 凑不满下限时就少给几条，绝不拿不相关的记忆凑数。
 */

import {
  OpenThreadStore,
  type EpisodicMemory,
  type OpenThread,
  type RelationshipNote,
  type SemanticMemory,
  type XixiStore,
} from '@xixi/domain';

import {
  alreadyMentionedPenalty,
  bestBigramCoverage,
  lexicalRelevance,
  MIN_BIGRAM_RELEVANCE,
  MIN_LEXICAL_RELEVANCE,
  openThreadScore,
  POLARITY_CONFLICT_PENALTY,
  polarityConflict,
  recencyScore,
  stalePenalty,
  subjectScore,
} from './memory-score.ts';
import {
  MEMORY_KINDS,
  type AudienceContext,
  type DroppedMemory,
  type MemoryKind,
  type MemoryProvenance,
  type MemoryRetrievalResult,
  type MemoryScoreWeights,
  type MemoryVisibility,
  type RetrievedMemory,
} from './types.ts';

/** 一条候选记忆（三种来源归一成同一个形状，排序只看这一份）。 */
export interface MemoryCandidate {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly subject: string | null;
  readonly confidence: number;
  readonly sourceType: string;
  readonly sourceEventId: string | null;
  /** 事情发生的时间；语义记忆没有，null。 */
  readonly occurredAt: string | null;
  readonly updatedAt: string;
  readonly importance: number;
  readonly visibility: MemoryVisibility;
}

export interface RetrieveMemoriesInput {
  /** 这一轮要接的话（用户原话或主动开口的依据行）。 */
  readonly query: string;
  readonly now: Date;
  /** 显式传入，不读系统时钟：重放与测试必须得到同一份结果。 */
  readonly minConfidence?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly audience?: AudienceContext | undefined;
  /** 这一会话最近几轮（已说过的惩罚用），由调用方提供 —— 它是雇主的工作记忆，不是库的投影。 */
  readonly recentTurns?: readonly { readonly role: string; readonly text: string }[] | undefined;
  /** 未完话题：既是排序信号，也是「这件事还没完」的上下文。 */
  readonly openThreads?: readonly OpenThread[] | undefined;
}

/** 每个分项在总分里的最大贡献。公开成常量，测试与面板可以逐项核对（同 `PROACTIVE_SCORE_WEIGHTS`）。 */
export const MEMORY_SCORE_WEIGHTS: MemoryScoreWeights = Object.freeze({
  lexical: 1.2,
  recency: 0.7,
  importance: 0.5,
  confidence: 0.6,
  subject: 0.55,
  openThread: 0.4,
  stale: 0.6,
  alreadyMentioned: 0.5,
});

/**
 * 分数下限：低于它的候选不进提示词。
 *
 * 它的意思是「这一轮**有理由**想起它」：一条只有置信与近因的记忆（0.7 + 0.6 = 1.3）能过，
 * 一条既没词面相关、也没主语匹配、也没关联未完话题、还很旧的记忆过不去。
 */
export const MEMORY_SCORE_FLOOR = 0.35;

/**
 * 超出前两条之后，第三条起要求的那条更高的下限。
 *
 * 为什么需要它：`minItems` 是「尽量给到几条」，而「尽量」不能变成「随便凑」。
 * 一条与这一轮毫无关系的记忆被塞进提示词，比少给一条更糟（它会被说成「你们以前聊过的事」）。
 * 所以前两条按 `MEMORY_SCORE_FLOOR` 收，第三条起要求确实有信号（词面/主语/话题）。
 */
export const MEMORY_STRONG_SCORE_FLOOR = 0.9;

/** 一次检索最多扫多少条候选（按 `updated_at` 倒序取，见 `MemoryStore` 的排序）。 */
export const DEFAULT_CANDIDATE_LIMIT = 200;

/** 提示词里注入条数的硬边界（pack §2：**最多 3~8 条**）。 */
export const MIN_INJECTED = 3;
export const MAX_INJECTED = 8;

/** 显式纠正的可信度下限：低于它的候选不许进提示词（`minConfidence` 的出厂值）。 */
export const DEFAULT_MIN_CONFIDENCE = 0.55;

interface Scored {
  readonly candidate: MemoryCandidate;
  readonly total: number;
  /** 过没过相关性先决条件（见 `MIN_LEXICAL_RELEVANCE`）。 */
  readonly relevant: boolean;
  readonly lexical: number;
  readonly recency: number;
  readonly importance: number;
  readonly confidence: number;
  readonly subject: number;
  readonly openThread: number;
  readonly stale: number;
  readonly alreadyMentioned: number;
  readonly reason: string;
}

/**
 * 记忆的检索器。
 *
 * 它**不打开 SQLite**（`@xixi/domain` 的 `XixiStore` 是唯一开库的地方），也不写任何东西：
 * 检索是纯读，读接口不写库是既有纪律（控制台面板那条测试压着的就是它）。
 */
export class MemoryRetriever {
  readonly #store: XixiStore;
  readonly #threads: OpenThreadStore;

  constructor(store: XixiStore) {
    this.#store = store;
    this.#threads = new OpenThreadStore(store);
  }

  /** 读候选并按混合分数排序、截断、给出诊断。 */
  retrieve(input: RetrieveMemoriesInput): MemoryRetrievalResult {
    const minConfidence = clamp(input.minConfidence ?? DEFAULT_MIN_CONFIDENCE, 0, 1);
    const maxItems = clampInt(input.maxItems ?? 6, MIN_INJECTED, MAX_INJECTED);
    const minItems = clampInt(input.minItems ?? MIN_INJECTED, 0, maxItems);
    const audience = input.audience;
    const openThreads = input.openThreads ?? this.#threads.list({ limit: 20 });

    const candidates = this.#candidates();
    const dropped: DroppedMemory[] = [];
    const eligible: MemoryCandidate[] = [];
    for (const candidate of candidates) {
      if (!visibleTo(candidate.visibility, audience)) {
        dropped.push({ id: candidate.id, kind: candidate.kind, reason: 'not_visible' });
        continue;
      }
      if (!usefulText(candidate.text)) {
        dropped.push({ id: candidate.id, kind: candidate.kind, reason: 'unusable_text' });
        continue;
      }
      if (candidate.confidence < minConfidence) {
        dropped.push({ id: candidate.id, kind: candidate.kind, reason: 'low_confidence' });
        continue;
      }
      eligible.push(candidate);
    }

    const history = mentionedText(input.recentTurns ?? []);
    const scored = eligible
      .map((candidate) => scoreCandidate(candidate, input, openThreads, history))
      .sort((left, right) => right.total - left.total || left.candidate.id.localeCompare(right.candidate.id));

    const kept: Scored[] = [];
    for (const entry of scored) {
      if (!entry.relevant) {
        dropped.push({ id: entry.candidate.id, kind: entry.candidate.kind, reason: 'not_relevant' });
        continue;
      }
      if (kept.length >= maxItems) {
        dropped.push({ id: entry.candidate.id, kind: entry.candidate.kind, reason: 'over_budget' });
        continue;
      }
      const floor = kept.length < 2 ? MEMORY_SCORE_FLOOR : MEMORY_STRONG_SCORE_FLOOR;
      if (entry.total < floor) {
        dropped.push({ id: entry.candidate.id, kind: entry.candidate.kind, reason: 'not_relevant' });
        continue;
      }
      kept.push(entry);
    }
    // `minItems` 只是「尽量给到」：上面已经把不相关的挡掉了，这里的不足是**诚实**的结果，
    // 而不是需要掩盖的失败（诊断里带着 candidates/eligible，面板能看出是「库里就没有」还是「都不相关」）。
    // **不在这里按 `minItems` 截断**：条数上限由 `maxItems`（已夹进 3~8）在循环里负责。
    const memories = kept.map((entry) => toRetrievedMemory(entry));

    return {
      memories,
      diagnostics: {
        candidates: candidates.length,
        eligible: eligible.length,
        injected: memories.length,
        droppedAtRender: 0,
        minItems,
        maxItems,
        weights: MEMORY_SCORE_WEIGHTS,
        dropped,
      },
    };
  }

  /** 三种来源归一成候选：字段名不同，语义相同（见 `types.ts` 的说明）。 */
  #candidates(): MemoryCandidate[] {
    const limit = DEFAULT_CANDIDATE_LIMIT;
    const episodic = this.#store.episodicMemories({ limit }).map((memory) => fromEpisodic(memory));
    const semantic = this.#store.semanticMemories({ limit }).map((memory) => fromSemantic(memory));
    const notes = this.#store.relationshipNotes({ limit }).map((note) => fromNote(note));
    return [...episodic, ...semantic, ...notes];
  }
}

export function fromEpisodic(memory: EpisodicMemory): MemoryCandidate {
  return {
    id: memory.memoryId,
    kind: 'episodic',
    text: memory.summary,
    subject: null,
    confidence: memory.confidence,
    sourceType: memory.sourceType,
    sourceEventId: memory.sourceEventId,
    occurredAt: memory.occurredAt,
    updatedAt: memory.updatedAt,
    importance: memory.importance,
    // 发生过的事默认是家里的事：它写下来的前提就是父亲在家里说的（AGENTS §5：不是每句话都进记忆）。
    visibility: 'family',
  };
}

export function fromSemantic(memory: SemanticMemory): MemoryCandidate {
  return {
    id: memory.memoryId,
    kind: 'semantic',
    text: memory.statement,
    subject: memory.property,
    confidence: memory.confidence,
    sourceType: memory.sourceType,
    sourceEventId: memory.sourceEventId,
    occurredAt: null,
    updatedAt: memory.updatedAt,
    // 语义记忆存的就是「一句稳定的事实」，它的重要度由来源决定（显式纠正 > 程序提炼 > 模型推断）。
    importance: memory.sourceType === 'explicit_correction' ? 0.8 : 0.5,
    visibility: memory.sourceType === 'explicit_correction' ? 'family' : 'private',
  };
}

export function fromNote(note: RelationshipNote): MemoryCandidate {
  return {
    id: note.noteId,
    kind: 'relationship',
    text: note.note,
    subject: note.aspect,
    confidence: note.confidence,
    sourceType: note.sourceType,
    sourceEventId: note.sourceEventId,
    occurredAt: null,
    updatedAt: note.updatedAt,
    importance: 0.5,
    visibility: 'private',
  };
}

/**
 * audience filter（pack §5.7）：**先于**检索的先决条件。
 *
 * 口径保守：不知道谁在听时就按 `family` 处理 —— `private` 的记忆（程序/模型推断出来的那些）
 * 不外泄到「可能有别人在」的场合；反之只有父亲一个人时，什么都看得到。
 */
export function visibleTo(visibility: MemoryVisibility, audience: AudienceContext | undefined): boolean {
  if (audience === undefined) return visibility !== 'private';
  switch (audience.mode) {
    case 'private':
      return true;
    case 'family':
      return visibility !== 'private';
    case 'public':
      return visibility === 'public';
  }
}

/**
 * 记忆文本本身可不可用。
 *
 * 两条硬禁令（pack §3「Prompt 里不要暴露 UUID」的可执行版本，t12 验收第 2 条）：
 *   * 不出现 UUID 形态的 id；
 *   * 不出现 8 位以上的连续数字（那是程序内部的号，不是家里人说的话）。
 * 命中的候选**整条丢掉**，而不是把它改成「看起来没问题」的样子 —— 一条被清洗过的记忆
 * 已经不是记忆了，而提示词里说「你们以前聊过」的时候必须是原话。
 */
export function usefulText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/u.test(trimmed)) return false;
  if (/\d{8,}/u.test(trimmed)) return false;
  return true;
}

function scoreCandidate(
  candidate: MemoryCandidate,
  input: RetrieveMemoriesInput,
  openThreads: readonly OpenThread[],
  history: string,
): Scored {
  const nowMs = input.now.getTime();
  const updatedMs = parseTime(candidate.updatedAt);
  const occurredMs = candidate.occurredAt === null ? null : parseTime(candidate.occurredAt);
  const ageDays = (nowMs - (occurredMs ?? updatedMs)) / 86_400_000;
  const recency = recencyScore(ageDays);
  const stale = stalePenalty(ageDays);
  // 极性冲突单独算：字面重合度高但结论相反（`喜欢` vs `不喜欢`）的候选要往后排，
  // 而不是被算成「很相关」—— 铁律 4 的显式纠正不该被纠正前的说法挤掉。
  const conflicting = polarityConflict(input.query, candidate.text);
  const lexical = Math.max(0, lexicalRelevance(input.query, candidate.text) - (conflicting ? POLARITY_CONFLICT_PENALTY : 0));
  // 双字词命中是「说的就是这件事」的独立强信号（见 `bestBigramCoverage`）。
  const bestBigram = bestBigramCoverage(input.query, candidate.text);
  const subject = subjectScore(candidate.subject, input.query);
  const thread = openThreadScore(
    openThreads.flatMap((entry) => [entry.summary, entry.subject]),
    [candidate.text, candidate.subject],
  );
  const overlap = overlapWithHistory(history, candidate.text);
  const mentioned = alreadyMentionedPenalty(overlap);
  const importance = clamp01(candidate.importance);
  const confidence = clamp01(candidate.confidence);

  const total =
    MEMORY_SCORE_WEIGHTS.lexical * lexical +
    MEMORY_SCORE_WEIGHTS.recency * recency +
    MEMORY_SCORE_WEIGHTS.importance * importance +
    MEMORY_SCORE_WEIGHTS.confidence * confidence +
    MEMORY_SCORE_WEIGHTS.subject * subject +
    MEMORY_SCORE_WEIGHTS.openThread * thread -
    MEMORY_SCORE_WEIGHTS.stale * stale -
    MEMORY_SCORE_WEIGHTS.alreadyMentioned * mentioned;

  return {
    candidate,
    // 相关性先决条件（见 `MIN_LEXICAL_RELEVANCE`）：一条信号都不沾，就是「跟这一轮没关系」。
    // 硬门槛保持高（0.25，挡住「一个字碰巧重合」这种弱信号），逼着弱候选去拿另外两条证据。
    relevant:
      bestBigram >= MIN_BIGRAM_RELEVANCE ||
      lexical >= MIN_LEXICAL_RELEVANCE ||
      subject >= 0.6 ||
      thread >= 0.2,
    total,
    lexical,
    recency,
    importance,
    confidence,
    subject,
    openThread: thread,
    stale,
    alreadyMentioned: mentioned,
    reason: describeReason({ lexical, recency, stale, mentioned, subject, thread, importance, confidence }),
  };
}

/**
 * `retrievalReason` 的正文：**哪几项起了作用**，按名字写出来。
 *
 * 它不进提示词（`RetrievedMemory` 是程序这一侧的视图），所以可以直白；用名字而不是数字，
 * 是为了让面板与测试读到的东西和 §9.10 的复算对得上。
 */
function describeReason(parts: {
  readonly lexical: number;
  readonly recency: number;
  readonly stale: number;
  readonly mentioned: number;
  readonly subject: number;
  readonly thread: number;
  readonly importance: number;
  readonly confidence: number;
}): string {
  const clauses: string[] = [];
  if (parts.lexical >= 0.2) clauses.push('和这一轮说的是同一件事');
  if (parts.subject >= 0.6) clauses.push('主语对得上');
  if (parts.thread >= 0.2) clauses.push('和没办完的那件事有关');
  if (parts.importance >= 0.7) clauses.push('这件事本身就重要');
  if (parts.confidence >= 0.8) clauses.push('是他明确说过的');
  if (clauses.length === 0) clauses.push(parts.recency >= 0.5 ? '是最近的事' : '还没被遗忘');
  if (parts.stale > 0.2) clauses.push('但有点旧了');
  if (parts.mentioned > 0) clauses.push('而且刚才已经提到过');
  return clauses.join('，');
}

function toRetrievedMemory(entry: Scored): RetrievedMemory {
  const candidate = entry.candidate;
  const provenance: MemoryProvenance = {
    sourceEventId: candidate.sourceEventId,
    sourceType: candidate.sourceType,
    confidence: candidate.confidence,
    occurredAt: candidate.occurredAt,
    updatedAt: candidate.updatedAt,
  };
  return {
    id: candidate.id,
    kind: candidate.kind,
    text: candidate.text,
    provenance,
    visibility: candidate.visibility,
    retrievalReason: entry.reason,
  };
}

/**
 * 「这件事刚才说过吗」——**逐字重合**，不是模糊相似。
 *
 * 为什么不用词面相关：相似度算的是「两条文本有多像」，而这里要问的是**内容有没有真的重复**。
 * 实测踩过：`那他喜欢喝什么茶` 对 `父亲不喜欢绿茶` 的词面相关是 0.28（高于阈值），于是两条
 * 毫不相干的记忆都会被算「刚说过」。逐字重合的判据简单、确定，而且不会误伤 ——
 * 记忆的正文本来就来自家里人说过的话，重复时通常是原样重复。
 */
function overlapWithHistory(history: string, text: string): number {
  if (history.length === 0) return 0;
  const needle = text.trim();
  if (needle.length === 0) return 0;
  if (history.includes(needle)) return 1;
  const normalized = normalizeForCompare(text);
  if (normalized.length >= 4 && normalizeForCompare(history).includes(normalized)) return 1;
  return 0;
}

/** 去掉标点与空白，只留内容字：`那罐茶叶是我买的。` 与 `那罐茶叶是我买的` 应当算同一句。 */
function normalizeForCompare(text: string): string {
  return [...text]
    .filter((character) => /[\p{Script=Han}\p{L}\p{N}]/u.test(character))
    .join('')
    .toLowerCase();
}

/** 最近几轮说过的话拼起来，供「已提及惩罚」用（只读，不落库）。 */
function mentionedText(turns: readonly { readonly role: string; readonly text: string }[]): string {
  return turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.text)
    .join('\n');
}

function parseTime(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.max(low, Math.min(high, value));
}

function clampInt(value: number, low: number, high: number): number {
  return Math.round(clamp(value, low, high));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** 运行时校验一条 kind（候选来自库，库里的值不该悄悄变成陌生字符串）。 */
export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}
