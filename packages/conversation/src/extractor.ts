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
 *   * **稳定的偏好/事实**（「我喜欢…」「我住在…」「我每天…」）→ semantic memory；
 *     宾语**前置**的句子（「铁观音我平时喜欢」）捕获到的只有动词，不写 —— 见 `lacksObject`。
 *
 * **不是每句话都进记忆**（AGENTS §5）：三个写入器各有确定的触发条件，绝大多数轮次什么也不写。
 */

import { toOffsetIso } from '@xixi/contracts';
import {
  MemoryCorrectionResolver,
  tier2StoredConfidence,
  validateTier2Candidates,
  worthRemembering,
  type CorrectionResolution,
  type StructuredMemoryExtractor,
  type Tier2Validation,
} from '@xixi/context';
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
  /** pack §5 的记忆纠正闭环结果（`null` = 这一轮没命中纠正规则）。 */
  readonly correction: CorrectionResolution | null;
  /** pack §8 的 Tier 2（结构化模型抽取）结果；没接线 / 这一轮不值得记时为 `null`。 */
  readonly tier2: Tier2Extraction | null;
  /**
   * 这一轮里**单独失败**的步骤（preflight ③）：每一步互不牵连，坏的那条丢自己。
   *
   * 空数组 = 全部落地；非空 = 结果里能看出「少写的是哪一步、为什么」，不必去翻进程日志。
   * 整轮失败（库已关、调用方注入的东西在更外层炸）仍然只由 `#runSafely` 计数。
   */
  readonly failures: readonly ExtractionFailure[];
}

/** Tier 2 一轮的结果：模型给了什么、收下了什么、为什么丢。 */
export interface Tier2Extraction {
  /** 这一轮过没过「可能值得记」那道门槛（没过就连模型都没叫）。 */
  readonly attempted: boolean;
  readonly validation: Tier2Validation;
  readonly written: readonly SemanticMemory[];
  /** 调用模型本身失败时的原因（模型挂了不该影响 Tier 1 已经写下的东西）。 */
  readonly failure: string | null;
}

/** 一条被隔离掉的失败：`step` 是产生它的那一步（例如 `self_model.learn:verbosity`）。 */
export interface ExtractionFailure {
  readonly step: string;
  readonly detail: string;
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
  /**
   * pack §5 的记忆纠正闭环。省略 = 自己按 store 建一个（于是「他否定了一条记忆」这件事
   * 默认会被处理，不需要每个入口记得接一次线）。
   */
  readonly correctionResolver?: MemoryCorrectionResolver | undefined;
  /**
   * pack §8 的 Tier 2：**结构化的模型抽取**。省略 = 不叫模型（只有 Tier 1）。
   *
   * 它是注入的，不是为了灵活，而是为了两件事：离线能测「模型给非法输出会怎样」，
   * 以及入口自己决定用哪个模型与哪套 schema（这一层只做校验与写入政策）。
   */
  readonly structuredExtractor?: StructuredMemoryExtractor | undefined;
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

/**
 * 稳定的偏好/事实（semantic memory）的识别规则：短句、第一人称、非疑问。
 *
 * V0.3 t22 **没有**动这四条正则本身：旗舰句的修法是「先按小节切、再让第一人称继承」，
 * 而不是放宽词表 —— 放宽 `不喝`/`不吃` 这类动词会与纠错闭环抢写同一件事
 * （闭环先按纠正写一条 `我不喝茉莉花茶`，规则再补一条 `我不喝那个`，同一件事两行、
 * 而且 t13 的闭环用例会红）。规则词表保持原样，行为只在「怎么切句」这一层变。
 */
const SEMANTIC_RULES: readonly { readonly property: string; readonly pattern: RegExp }[] = Object.freeze([
  { property: 'preference', pattern: /我(?:很|挺|特别)?(?:喜欢|爱)([^。！？!?，,；;]{2,20})/ },
  { property: 'preference', pattern: /我(?:不喜欢|不爱|讨厌)([^。！？!?，,；;]{2,20})/ },
  { property: 'place', pattern: /我(?:住|住在|老家在)([^。！？!?，,；;]{2,20})/ },
  { property: 'routine', pattern: /我(?:每天|平常|平时|一般)([^。！？!?，,；;]{2,24})/ },
]);

/** 一句里的**小节**（V0.3 t22）。 */
export interface UserClause {
  /** 这一小节的正文（已 trim）。 */
  readonly text: string;
  /**
   * 这一小节是不是在说「我」：自己带 `我`/`咱`，**或者同一句的前面某一小节带过**
   * （`我不喝绿茶，平时喜欢茉莉花茶` 的第二小节）。跨句不继承：`他喜欢喝茶。` 不该写成「我」的事。
   */
  readonly firstPerson: boolean;
  /** 这一小节是不是疑问（整句以 `？`/`?` 结尾，或这一小节自己长得像问句）。 */
  readonly question: boolean;
}

/**
 * 疑问句的**字面**判据（V0.3 t22，修掉那个恒假守卫）。
 *
 * 背景：原来那行守卫写的是 `statement.includes('？')`，而 `statement` 来自
 * `[^。！？!?，,；;]{2,20}` 这个字符类 —— 问号在类里被显式排除，于是**条件恒为假**：
 * 写着「规则只给非疑问用」，实际上疑问句照写不误（`你还记得我喜欢喝什么茶吗？`
 * 会落库成 `preference: 我喜欢喝什么茶吗`，置信 0.9、active）。守卫必须判**原始那句话**，
 * 而不是被判过之后的那一段。
 *
 * 四种字面形态：句末/句中问号、小节以 `吗`/`呢`/`吧` 收尾、疑问词
 * （`什么`/`怎么`/`为什么`/`哪儿`/`哪里`/`几点`/`多少`/`什么时候`）、明问记忆的句式
 * （`你还记得…`/`我说过…`/`我什么时候…`）。
 *
 * **拦什么、不拦什么 —— 例子必须是实跑出来的，别凭印象写**（V0.3 t24 修 T23-D1：
 * 上一版注释把「不拦」的例子举成了 `我喜欢喝什么茶`，而它含疑问词 `什么`，**其实会被拦**）：
 *   * **拦**：`我喜欢喝什么茶`（含 `什么` → `QUESTION_WORD`）、`你还记得我喜欢喝什么茶吗？`（问号）、
 *     `我是不是不喜欢喝绿茶呢`（`呢` 收尾）—— 实跑落库 0 条；
 *   * **不拦**：**没有任何疑问标记**的残句，例如 `我喜欢的茶`、`我爱喝的那种茶`
 *     —— 实跑按陈述落库（`preference:我喜欢的茶`）。这是刻意的取舍：判据只能字面，
 *     没有标记就不猜，宁可多记一条陈述，也不靠猜把正常的陈述误伤。
 *
 * 这条边界有用例钉着：`tests/unit/core/semantic-clause-extraction.test.ts` 的
 * 「无标记的疑问残句按陈述读」那一条（含上面两句的对照），所以谁改了口径那里就会红。
 */
const QUESTION_MARK = /[？?]/u;
const QUESTION_TAIL = /(?:吗|呢|吧)$/u;
const QUESTION_WORD = /(?:什么|怎么|为什么|哪儿|哪里|几点|多少|什么时候)/u;
const QUESTION_ABOUT_MEMORY = /(?:你还?记得|记得我|我说过|我什么时候|我有没有)/u;

export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return (
    QUESTION_MARK.test(trimmed) ||
    QUESTION_TAIL.test(trimmed) ||
    QUESTION_WORD.test(trimmed) ||
    QUESTION_ABOUT_MEMORY.test(trimmed)
  );
}

/**
 * 把用户一句话切成小节，并给每一节标注「谁在说话」与「是不是疑问」（V0.3 t22）。
 *
 * 为什么必须分小节：`我不喝绿茶，平时喜欢茉莉花茶。` 是非常自然的一句话，而按整句匹配时
 * 「我」后面接的是「不喝绿茶」，于是 `我…喜欢` 接不上、`我平时喜欢` 也因为前面没有「我」接不上 ——
 * 一句话一条记忆都不写（t15 实测，真模型与离线两次）。
 *
 * 分句 / 分小节：`。！？!?` 断句（并记住这一句是不是疑问），`，,；;、` 与换行断小节；
 * 第一人称**在同一句内**向后继承，跨句不继承。
 */
export function splitUserClauses(text: string): readonly UserClause[] {
  const sentences = text
    .split(/(?<=[。！？!?])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const clauses: UserClause[] = [];
  for (const sentence of sentences) {
    // 整句以问号收尾时，这一句的**每个**小节都按疑问处理（问的是整句）。
    // 但不能拿「整句里出现过疑问词」当整句疑问：`我喜欢喝什么茶，我平时喜欢茉莉花茶。`
    // 的第一小节是问句、第二小节是陈述 —— 按整句判会把第二小节一起吞掉（实测踩到过）。
    const sentenceIsQuestion = QUESTION_MARK.test(sentence.trim().slice(-1));
    let subjectSeen = false;
    for (const raw of sentence.split(/[，,；;、\n]+/u)) {
      const clause = raw.replace(/[。！？!?]+$/u, '').trim();
      if (clause.length === 0) continue;
      const ownSubject = /[我咱]/u.test(clause);
      const firstPerson = ownSubject || subjectSeen;
      if (ownSubject) subjectSeen = true;
      clauses.push({ text: clause, firstPerson, question: sentenceIsQuestion || looksLikeQuestion(clause) });
    }
  }
  return clauses;
}

/** 接续小节常见的开头（连词/副词）：补主语时要先摘掉，否则「我也喜欢下棋」接不上规则。 */
const LEADING_CONNECTIVE = /^(?:也|还|又|再|然后|而且|并且|另外|接着|后来|不过|但是|但|就|都|只)+/u;

/**
 * 一条候选陈述：把小节补成「以我开头」的第一人称句子（第一人称继承来的小节要补主语）。
 *
 * `平时喜欢茉莉花茶`（前面已有「我」）→ `我平时喜欢茉莉花茶`；
 * `也喜欢下棋` → 先摘掉开头的接续词 → `我喜欢下棋`；
 * 自己带「我」的小节原样返回；不是第一人称的小节返回 `null`（`他很喜欢喝茶` 不该被写成「我」的事）。
 */
export function firstPersonCandidate(clause: UserClause): string | null {
  if (!clause.firstPerson) return null;
  if (/[我咱]/u.test(clause.text)) return clause.text;
  const withoutConnective = clause.text.replace(LEADING_CONNECTIVE, '').trim();
  return withoutConnective.length === 0 ? null : `我${withoutConnective}`;
}

/**
 * **光杆动词形**（V0.3 P2-G）：动词后面什么都没有，是一个**裂开的动词短语**，不是一件事。
 *
 * 为什么要有这个判据（真缺陷，不是防御）：宾语前置句（「铁观音我平时喜欢」「绿茶我平时爱喝」）
 * 里，宾语在「我」**前面**，四条正则的捕获组从「我」开始往后吃，于是只吃到那个动词 ——
 * P2-G 用 `node` 探针读工作区实测到的语句逐字是 `routine:我平时喜欢`、`routine:我平时爱喝`、
 * `routine:我平时喜欢喝`：**没有宾语**。这种行进库是 `active`、置信 0.9，P1 之后还会被召回进提示词，
 * 于是模型拿到一条「父亲平时喜欢（什么？）」的残句 —— 比少记一条更糟。
 *
 * 判据是**字面且封闭**的：`偏好动词 [+ 一个光杆身体动词]`，两个词表都写死在这里：
 *   * **拦**：`我平时喜欢`、`我平时爱喝`、`我平时喜欢喝`、`我平时爱`；
 *   * **不拦**：`我平时喜欢茉莉花茶`（有自己的宾语）、`我每天六点起床`、`我平时喜欢早起`、
 *     `我平时吃素`、`我平时喝茶`（名词/形容词短句，动词后面有内容）——**宁可少记一条，也不写半句话**。
 *
 * **已知边界（这一层不假装全覆盖）**：词表之外的光杆动词判不出来，例如
 * `铁观音我平时喜欢泡着喝` → `routine:我平时喜欢泡着喝`（有内容、但宾语仍在前面，照写）。
 * 收窄它的方向是另开一条提取路径去认前置宾语，属下一轮。
 *
 * 反例（**不要**照抄这条注释去删守卫）：把 `lacksObject` 改成恒假，
 * `tests/unit/core/semantic-clause-extraction.test.ts` 的「宾语前置句」那条会红。
 */
const PREFERENCE_VERBS = '喜欢看|喜欢吃|喜欢喝|喜欢听|喜欢|爱看|爱吃|爱喝|爱听|爱';
/** 光杆身体动词：只在偏好动词**后面**单独出现时算「还是没宾语」（`喜欢喝` ✗ / `喝茶` ✓）。 */
const BARE_BODY_VERBS = '看|听|读|写|玩|种|养|买|做|穿|用|吃|喝';
const BARE_VERB_FORM = new RegExp(`^(?:${PREFERENCE_VERBS})(?:${BARE_BODY_VERBS})?$`, 'u');

/** 捕获到的片段是不是**只说了动词、没说宾语**（见 {@link BARE_VERB_FORM} 的判据与例子）。 */
export function lacksObject(fragment: string): boolean {
  return BARE_VERB_FORM.test(fragment.trim());
}

export class TurnMemoryExtractor {
  readonly #store: XixiStore;
  readonly #selfModel: SelfModel;
  readonly #memory: MemoryStore;
  readonly #scheduler: ExtractionScheduler;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #correction: MemoryCorrectionResolver;
  readonly #structured: StructuredMemoryExtractor | undefined;
  readonly #queue: PostTurnJob[] = [];
  /** 在飞的 Tier 2 任务（它们 async，`flush()` 要等它们跑完才算「这一轮提取完了」）。 */
  readonly #tier2InFlight = new Set<Promise<unknown>>();
  #processed = 0;
  #errors = 0;

  constructor(options: TurnMemoryExtractorOptions) {
    this.#store = options.store;
    this.#selfModel = options.selfModel ?? new SelfModel(options.store);
    this.#memory = options.memory ?? new MemoryStore(options.store);
    this.#scheduler = options.scheduler ?? DEFAULT_EXTRACTION_SCHEDULER;
    this.#onError = options.onError;
    this.#correction = options.correctionResolver ?? new MemoryCorrectionResolver({ store: options.store, memory: this.#memory });
    this.#structured = options.structuredExtractor;
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
    // Tier 2 是 async 的：`flush()` 的语义是「这一轮提取真的结束了」，所以必须等它们。
    while (this.#tier2InFlight.size > 0) {
      await Promise.allSettled([...this.#tier2InFlight]);
    }
    pendingAtExit.delete(this);
  }

  /**
   * Tier 2（pack §8）：结构化的模型抽取。
   *
   * 三件事按顺序发生，任何一步不成立都不会走到下一步：
   *   1. `worthRemembering()`（确定性）—— 不值得记的回合**连模型都不叫**；
   *   2. 注入的 `structuredExtractor` 拿这一轮的对话去问模型（形状完全不被信任）；
   *   3. `validateTier2Candidates()` 校验：类别白名单 + schema + 置信阈值，通过的才写库。
   *
   * **它永远不会碰 SelfModel**：这个方法的写入路径只有 `recordSemantic`，
   * 而人格属性（verbosity 之类）在类别白名单之外，第一步就被拒。
   * 模型/网络失败只记进 `failure`，不影响 Tier 1 已经写下的东西（与 preflight ③ 同一条纪律）。
   */
  async runTier2(job: PostTurnJob): Promise<Tier2Extraction> {
    const extractor = this.#structured;
    if (extractor === undefined || !worthRemembering(job.userText)) {
      return {
        attempted: false,
        validation: { accepted: [], rejected: [] },
        written: [],
        failure: extractor === undefined ? '这个入口没有接线结构化抽取（只有 Tier 1）' : '这一轮不值得记（确定性门槛没过）',
      };
    }
    let raw: unknown;
    try {
      raw = await extractor({ userText: job.userText, replyText: job.replyText });
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      try {
        this.#onError?.(new Error(`[memory.tier2] ${failure}`));
      } catch {
        // 上报失败不能把这一轮变成崩溃。
      }
      return { attempted: true, validation: { accepted: [], rejected: [] }, written: [], failure };
    }
    const validation = validateTier2Candidates(raw);
    const written: SemanticMemory[] = [];
    for (const candidate of validation.accepted) {
      try {
        // 判重：同一句话已经记过（Tier 1 或上一轮）就不再写一条。
        const existing = this.#memory.semantic({ property: candidate.property, limit: 200 });
        if (existing.some((entry) => entry.statement === candidate.statement)) continue;
        written.push(
          this.#memory.recordSemantic({
            property: candidate.property,
            statement: candidate.statement,
            sourceType: 'model_inference',
            sourceEventId: job.userEventId,
            confidence: tier2StoredConfidence(candidate.confidence),
          }),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
          this.#onError?.(new Error(`[memory.tier2:${candidate.property}] ${detail}`));
        } catch {
          // 同上。
        }
      }
    }
    return { attempted: true, validation, written, failure: null };
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
   *
   * 每一步**各自**被隔离（preflight ③）：早先这里从头到尾只有调用方一层 `try`，于是
   * 「一个不认识的人格属性」这种单点失败会让同一轮后面**所有**提取一起消失——记忆里没有痕迹，
   * 日志里只有一句「这一轮失败」，而那一轮其实大部分活都是好的。现在每步失败只丢自己，
   * 由 `failures` 如实报出、并经 `onError` 落一行日志（坏的那条必须看得见）。
   */
  runJob(job: PostTurnJob): ExtractionResult {
    const failures: ExtractionFailure[] = [];
    /**
     * 跑一步；失败就记进 `failures` 并上报，不打断这一轮里剩下的步骤。
     *
     * 返回回调的结果（`T | undefined`，失败时 `undefined`）：调用方需要拿到值时必须走这个返回值，
     * 不能像以前那样在回调里给外层的 `let` 赋值——闭包里的赋值在 `if (x !== null)` 处不可见，
     * 类型检查器（正确地）把外层变量收窄成 `null`。行为一字未改：回调仍在同一个 try 里跑。
     */
    const attempt = <T>(step: string, run: () => T): T | undefined => {
      try {
        return run();
      } catch (error) {
        /**
         * 库已经关了（进程正在退、存储出故障）**不算「某一步坏了」**：这一轮整轮都写不进去，
         * 老实往上抛，让 `#runSafely` / `drainOnExit` 把它记成丢掉的一轮（t9 F3 的可见日志）。
         * 隔离只对「这一轮里某个属性/某条规则坏了」成立 —— 下一条提取不该陪葬，但整轮没救要认。
         */
        if (!this.#store.isOpen) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        failures.push({ step, detail });
        try {
          this.#onError?.(new Error(`[${step}] ${detail}（${job.sessionId}/${job.userEventId ?? '（无轮次事件）'}）`));
        } catch {
          // 上报自己炸了也不能把「这一步失败」变成「整轮失败」。
        }
        return undefined;
      }
    };

    const feedback: FeedbackInterpretation | null =
      attempt('feedback.interpret', () =>
        interpretFeedbackInput({ text: job.userText, inferredCode: job.inferredCode ?? null }),
      ) ?? null;
    const learned: LearnedDeltaResult[] = [];
    const overrides: SessionOverride[] = [];
    const episodic: EpisodicMemory[] = [];
    const semantic: SemanticMemory[] = [];
    const notes: RelationshipNote[] = [];

    if (feedback !== null) {
      // 落库用**名义值**：权重由 `SelfModel.learn` 按 `sourceType` 乘一次（显式 1.0 / 推断 0.4）。
      // `feedback.deltas` 是已乘权重的视图，拿它落库会把推断乘两遍（0.4 × 0.4）。
      for (const [property, delta] of Object.entries(feedback.nominalDeltas)) {
        attempt(`self_model.learn:${property}`, () => {
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
        });
      }
      if (Object.keys(feedback.sessionDeltas).length > 0) {
        attempt('self_model.override_today', () => {
          overrides.push(
            ...this.#selfModel.overrideToday({
              deltas: feedback.sessionDeltas,
              reason: `用户说：${feedback.evidence}`,
              sourceType: feedback.source,
              sessionId: job.sessionId,
              at: job.at,
            }),
          );
        });
      }
      // 收窄一次、存进局部常量再进闭包：`feedback.relationship` 的收窄在回调里不成立（回调可能在
      // 之后的任意时刻运行），所以「上面判过 undefined」这件事必须用局部变量带进去。
      const relationship = feedback.relationship;
      if (relationship !== undefined) {
        attempt('memory.relationship_note', () => {
          notes.push(
            this.#memory.recordNote({
              aspect: relationship.aspect,
              note: relationship.note,
              sourceType: feedback.source,
              sourceEventId: job.userEventId,
              confidence: feedback.confidence,
            }),
          );
        });
      }
      // 一次明确纠正本身就是「发生过的事」（episodic）：将来她可以回答「你上次说我话多」。
      attempt('memory.episodic:correction', () => {
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
      });
    }

    // pack §5：**记忆纠正闭环**。它排在语义规则**前面** —— 纠正会写一条新的语义记忆，
    // 后面的规则再看到同一句话时会被「statement 已存在」的判重挡住，于是不会写第二条。
    const correction: CorrectionResolution | null =
      attempt('memory.correction', () =>
        this.#correction.resolve({
          userText: job.userText,
          at: job.at,
          sessionId: job.sessionId,
          sourceEventId: job.userEventId,
        }),
      ) ?? null;
    if (correction !== null && correction.status !== null) {
      // 被改状态的那条记忆也留下一条「发生过的事」：将来她可以回答「你上次说你不喝绿茶」。
      attempt('memory.episodic:memory_correction', () => {
        episodic.push(
          ...this.#recordOnce({
            kind: 'correction',
            summary: correction.note,
            sourceType: 'explicit_correction',
            sourceEventId: job.userEventId,
            sessionId: job.sessionId,
            occurredAt: job.at,
            importance: 0.9,
          }),
        );
      });
    }

    // 将来的事：复用 Phase 3 的规则提取器（同一套「时间词 + 意愿 + 动作」规则，不另写一套）。
    const userEventId = job.userEventId;
    if (userEventId !== null) {
      let threads: ReturnType<typeof extractOpenThreads> = [];
      attempt('open_threads.extract', () => {
        threads = extractOpenThreads({ text: job.userText, at: job.at, sourceEventId: userEventId });
      });
      for (const thread of threads) {
        attempt(`memory.episodic:plan:${thread.summary}`, () => {
          episodic.push(
            ...this.#recordOnce({
              kind: 'plan',
              summary: `记下一件事：${thread.summary}`,
              sourceType: 'program_extraction',
              sourceEventId: userEventId,
              sessionId: job.sessionId,
              occurredAt: job.at,
              // `NewOpenThread.importance` is optional in the domain type (the console creates threads
              // without one), but every draft `extractOpenThreads` produces carries one. When a caller
              // ever omits it, fall back to the same neutral floor `importanceOf` uses in topic-engine.
              importance: thread.importance ?? 0.6,
            }),
          );
        });
      }
    }

    /**
     * 稳定的偏好/事实（V0.3 t22：按**小节**匹配 + 第一人称继承 + 真的会拦疑问句；
     * V0.3 P2-G 再补一条「不写半句话」）。
     *
     * 四件事各修一个已实测的缺陷：
     *   1. 按小节而不是整句匹配 —— `我不喝绿茶，平时喜欢茉莉花茶。` 里的第二小节因此接得上；
     *   2. 第一人称**在同一句内向后继承**（`平时喜欢茉莉花茶` 补成 `我平时喜欢茉莉花茶`），
     *      跨句不继承，所以 `他喜欢喝茶。` 不会被写成「我」的事；
     *   3. 疑问句在**写之前**被拦下，而且判的是原始那句话（旧写法判的是 match 出来的片段，
     *      而那个字符类里根本没有问号，条件恒为假 —— 见 `looksLikeQuestion` 的注释）；
     *   4. **捕获片段里没有宾语就不写**（P2-G，宾语前置句）：`铁观音我平时喜欢` 只吃到
     *      `我平时喜欢`，写下去就是一条没有宾语的 `routine` 行 —— 见 `lacksObject` 的注释。
     *      判据是「这段字面本身成不成一件事」，不猜宾语；宾语在前面的句子这一轮**选择不写**，
     *      而不是编一个宾语出来（AGENTS §1：规则只做确定的事）。
     */
    const clauses = splitUserClauses(job.userText);
    for (const clause of clauses) {
      if (clause.question) continue;
      const candidate = firstPersonCandidate(clause);
      if (candidate === null) continue;
      for (const { property, pattern } of SEMANTIC_RULES) {
        attempt(`memory.semantic:${property}`, () => {
          const match = pattern.exec(candidate);
          if (match === null) return;
          const statement = match[0].trim();
          if (statement.length === 0) return;
          // 四条规则都是**恰好一个捕获组**（宾语那一段）。这里不写 `?? ''`：将来若有人给规则
          // 加/去了捕获组，宁可让这条规则一声不响地不写（本函数的返回语义），也不要静默地
          // 把守卫变成恒假（`lacksObject('')` 为假，等于把 P2-G 修的东西又放回去）。
          if (match[1] !== undefined && lacksObject(match[1])) return;
          // 判重按**全部状态**看（`semantic` 不是 `activeSemantic`）：一句被纠正过的话
          // 不该因为「它已经不 active 了」而被重新写一遍。
          const existing = this.#memory.semantic({ property, limit: 200 });
          if (existing.some((entry) => entry.statement === statement)) return;
          semantic.push(
            this.#memory.recordSemantic({
              property,
              statement,
              sourceType: 'explicit_correction',
              sourceEventId: job.userEventId,
              confidence: 0.9,
            }),
          );
        });
      }
    }

    return { job, feedback, learned, overrides, episodic, semantic, notes, correction, tier2: null, failures };
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
      this.#scheduleTier2(job);
    }
    pendingAtExit.delete(this);
  }

  /**
   * 排一次 Tier 2（异步）。任务被登记在 `#tier2InFlight` 里，所以 `flush()` 会等它 ——
   * 「回复返回时 Tier 1 已经写完了，Tier 2 还在路上」是可以被测试断言的事实，
   * 而不是靠掐秒表（与 `scheduled` 那道手动调度器同一个思路）。
   */
  #scheduleTier2(job: PostTurnJob): void {
    if (this.#structured === undefined) return;
    const task = this.runTier2(job).catch((error: unknown) => {
      try {
        this.#onError?.(error);
      } catch {
        // 同上。
      }
    });
    this.#tier2InFlight.add(task);
    void task.finally(() => this.#tier2InFlight.delete(task));
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
