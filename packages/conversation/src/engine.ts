import { buildEvent, toOffsetIso } from '@xixi/contracts';
import {
  ContextBuilder,
  MemoryRetriever,
  parseContextMemorySettings,
  type AudienceContext,
  type ConversationContext,
  type ProactiveContext,
  type ProactiveTurnContextInput,
} from '@xixi/context';
import {
  createSpokenTextFilter,
  isSilenceReply,
  sanitizeSpokenReply,
  type BrainImageInput,
  type ReplyHygieneResult,
  type TurnModelProvider,
} from '@xixi/brain-adapter';
import type { Clock, MoodBeatResult, MoodEngine, MoodState, TurnAction, XixiConfig, XixiStore } from '@xixi/domain';
import { MemoryStore, MoodEngine as MoodEngineImpl, moodBiasOf, moodProactivityNudge, systemClock } from '@xixi/domain';

import {
  ConversationStateMachine,
  type ConversationState,
  type FsmConfig,
  type TurnAcceptance,
  type TurnAcceptanceReason,
} from './fsm.ts';
import { PromptAssembler, SILENCE_TOKEN, worldStateLite, type AssembledPrompt, type MoodContext, type PromptTurn } from './prompt.ts';
import { DEFAULT_SILENCE_TOLERANCE, moodToleranceScale } from './personality.ts';
import type { ProactiveContextLines } from './proactive.ts';
import type { PostTurnJob } from './extractor.ts';
import { REPLY_LIMITS, resolveReplyLimits, splitReplyIntoSegments, type ReplySegmentOptions, type SegmentedReply } from './segments.ts';

export interface ConversationEngineOptions {
  readonly adapter: TurnModelProvider;
  readonly store: XixiStore;
  readonly config: XixiConfig;
  readonly clock?: Clock;
  readonly assembler?: PromptAssembler;
  /**
   * 上下文装配（V0.3 P1 / pack `docs/02_MEMORY_CONTEXT.md` §1）。
   *
   * 省略时引擎自己按 `store` / `config` / 时钟建一个 `@xixi/context` 的 `ContextBuilder`，
   * 于是「上下文只有一个装配入口」是**结构事实**而不是约定：想换一套上下文就换这一个对象。
   * 显式传 `false` 表示这个入口不要这一层（提示词与 P0 逐字相同）—— 它是给「验证记忆层本身
   * 有没有改变回复行为」的对照实验留的开关，不是给生产用的。
   */
  readonly contextBuilder?: ContextBuilder | false | undefined;
  /** 显式的「谁在听」（P1 只有「有没有外人」这一层）：省略 = 保守的 `family`。 */
  readonly audience?: AudienceContext | undefined;
  /**
   * FSM tuning. `lingerMs` / `engageTimeoutMs` are decisions this layer owns;
   * `silenceTolerance` is an explicit override for tests and replay, because the
   * normal source is the persisted personality (§7.2) — see
   * `ConversationEngine.#syncSilenceTolerance`.
   */
  readonly fsm?: Partial<FsmConfig>;
  /** Per-turn model timeout. Realtime replies should fail fast rather than hang. */
  readonly turnTimeoutMs?: number;
  /** How many prior turns enter working memory (§10.2 A). */
  readonly historyLimit?: number;
  /** Local UTC offset override, for tests and replay. */
  readonly offsetMinutes?: number;
  /**
   * Multi-segment reply limits (ADR-0010). `config.reply` is the normal source;
   * this is the explicit test/replay override. Neither can exceed the hard
   * ceilings in `REPLY_LIMITS` — see `resolveReplyLimits`.
   */
  readonly reply?: ReplySegmentOptions;
  /**
   * pack Phase 4（《方案》§11.1）：一轮结束后的**后台提取**接缝。
   *
   * 引擎在回复说完、`conversation.turn` 都落库之后调用它，**不 await、不抛错**：写记忆、
   * 学反馈、记未完话题都是回复之后的事，不能拖慢语音。生产传的是
   * `TurnMemoryExtractor.enqueue`（见 `packages/conversation/src/extractor.ts`）。
   */
  readonly afterTurn?: ((job: PostTurnJob) => void) | undefined;
  /**
   * 有界的心情（第五轮 t4）。省略 = 引擎自己用 `store` 与 `config.mood` 建一个（默认开启）；
   * 显式传 `false` 表示「入口不要这一层」（提示词与 V0.1 逐字相同，见 `prompt.ts` 的 `mood`）。
   *
   * 为什么由引擎持有：心情的演化要读原始事件（`conversation.turn` / `proactive.decision` /
   * `presence.changed`），而引擎是唯一同时拿着 store、时钟与轮次的地方 —— 与
   * `#syncSilenceTolerance` 同一条理由（别让调用方各自记着接一次线）。
   */
  readonly mood?: MoodEngine | false | undefined;
}

export interface RespondInput {
  readonly sessionId: string;
  readonly text: string;
  /**
   * Wake word or very strong direct address (§13). The caller owns detection:
   * M1 has no wake word yet, so a UI button sets it; M2 supplies the detector.
   */
  readonly addressed?: boolean;
  readonly at?: Date;
  /**
   * Optional still image(s) for **this** turn (t88: the console's 「看一眼」 button).
   *
   * The *caller* decides what, when and whether to attach — the engine never picks a picture
   * itself, and iron rule 6 still holds: no continuous video, one explicitly chosen frame per
   * call. It goes straight to the adapter's own `images` seam (t87); an adapter that cannot send
   * pictures (DSH) refuses such a turn instead of silently dropping the image.
   */
  readonly images?: readonly BrainImageInput[];
  /**
   * 记忆检索用的**查询文本**（V0.3 P1）。省略 = 用 `text`（普通轮次就是这么用的）。
   *
   * 为什么有这条缝：一入口会把程序写的指令（「触发源：… 依据：…」）当 `text` 传进来
   * （主动开口那条路），拿它做词面相关会把候选全判成不相关。它只影响检索，不进提示词 ——
   * 模型读到的仍然是 `text`。同名字段在 `AssembleInput` 上有一份更长的说明。
   */
  readonly gate?: string | undefined;
}

/** One segment as it is handed to the playback seam (ADR-0010). */
export interface ReplySegmentPlayback {
  readonly index: number;
  readonly text: string;
  readonly total: number;
  /** Pause to leave after this segment; `null` on the last one (the turn ends). */
  readonly gapMsAfter: number | null;
}

export interface RespondHooks {
  /** Called for each text delta as it arrives, so TTS can start early (§46.1). */
  readonly onTextChunk?: (text: string) => void | Promise<void>;
  /**
   * The playback seam for multi-segment replies (ADR-0010): awaited once per
   * segment, in order, so the caller speaks them with `gapMsAfter` between them.
   *
   * Mutually exclusive with `onTextChunk` **on purpose**: when this hook is
   * supplied the engine stops handing out raw deltas, because driving audio from
   * both seams would speak the same reply twice. A caller that wants segmented
   * playback passes `onSegment`; a caller that wants the legacy single-utterance
   * streaming passes `onTextChunk`.
   */
  readonly onSegment?: (segment: ReplySegmentPlayback) => void | Promise<void>;
  /**
   * t111: a structured, non-spoken note about what the engine had to change (today: an unverified
   * concrete claim was replaced). Never fed to TTS — it exists so the caller can audit the turn
   * instead of guessing why the reply differs from the model's raw text.
   */
  readonly onNotice?: (notice: { readonly code: string; readonly detail: string }) => void | Promise<void>;
}

/**
 * t21: why a turn ended silent — the two cases every caller used to see as one.
 *
 *  * `MODEL_SILENCE` — the model (or the §55 token) chose not to speak;
 *  * `ARTIFACT_ONLY_REPLY` — it *did* answer, but the whole reply was an artifact (tool-call markup,
 *    English reasoning, markdown-only) and the hygiene gate removed it. 「她本来想调工具、没有结果所以
 *    没说」 is this one, and a console must be able to tell the user that (t12 F2).
 */
export type SilenceReason = 'MODEL_SILENCE' | 'ARTIFACT_ONLY_REPLY' | null;

/** t21: a compact, JSON-able summary of what the hygiene gate removed (for the turn + the console). */
export interface ReplyHygieneSummary {
  readonly removedMarkupChars: number;
  readonly removedMarkdownChars: number;
  readonly removedReasoningChars: number;
  readonly emptied: boolean;
}

export interface ConversationTurn {
  readonly accepted: boolean;
  readonly reason: TurnAcceptanceReason;
  readonly state: ConversationState;
  readonly action: TurnAction;
  readonly text: string | null;
  /** How the reply is spoken: 1..3 segments (ADR-0010); empty on SILENCE. */
  readonly segments: readonly string[];
  /** Pause between those segments, in milliseconds. */
  readonly segmentGapMs: number;
  readonly provider: string;
  readonly model: string;
  /**
   * t21 (t4 F5): the provider's stop reason (`stop` / `length` / `tool_calls`…), or `null` when the
   * transport does not report one. `length` is what a reply cut off mid-word looks like.
   */
  readonly finishReason: string | null;
  /** t21 (t12 F2): why this turn was silent, or `null` when it spoke. */
  readonly silenceReason: SilenceReason;
  /**
   * Pack Phase 2: which tool backed this turn, or `null` when none ran. The event log already
   * carried `tool_name`; the turn now carries it too, so a console can show the same fact
   * without re-reading the store (and so an offline test can assert a tool really ran).
   */
  readonly toolName: string | null;
  /** t21: what had to be removed before anything could be spoken, or `null` when nothing was. */
  readonly hygiene: ReplyHygieneSummary | null;
  readonly latencyMs: number;
  /** Model first-token latency, when the adapter streams (§46.4). */
  readonly firstTokenMs: number | null;
  /** Exactly what the model saw; kept for the Debug UI and for replay evidence. */
  readonly prompt: AssembledPrompt | null;
}

/**
 * One conversation turn, end to end: state machine → prompt assembly → adapter →
 * durable event log → state machine.
 *
 * The engine owns everything deterministic (§2.1): whether a turn is accepted,
 * what context the model sees, what is recorded, and when the session closes.
 * The model only decides what to say.
 */
export class ConversationEngine {
  readonly #adapter: TurnModelProvider;
  readonly #store: XixiStore;
  readonly #config: XixiConfig;
  readonly #clock: Clock;
  readonly #assembler: PromptAssembler;
  readonly #fsm: ConversationStateMachine;
  readonly #turnTimeoutMs: number;
  readonly #historyLimit: number;
  readonly #offsetMinutes: number | undefined;
  /** Effective reply limits, already clamped to the hard ceilings (ADR-0010 §3). */
  readonly #replyLimits: ReplySegmentOptions;
  /** pack Phase 4：一轮之后的异步提取接缝（见 `ConversationEngineOptions.afterTurn`）。 */
  readonly #afterTurn: ((job: PostTurnJob) => void) | undefined;
  /** Set only when the caller passed `fsm.silenceTolerance` explicitly. */
  readonly #silenceToleranceOverride: number | null;
  /**
   * How many decisions this process has recorded, so a decision event always
   * advances `turn_index`. Derived from the durable projection, a rejected turn
   * would repeat the previous index because it never writes a turn.
   */
  #decisionCount = 0;
  /** 有界的心情（第五轮 t4）。`null` = 这个入口不要心情这一层。 */
  readonly #mood: MoodEngine | null;
  /**
   * 上下文装配的那一个入口（V0.3 P1）。`null` = 这个入口显式关掉了它（对照实验用）。
   *
   * 引擎**不再自己决定上下文来源**（pack §1「不再自己决定所有 context 来源」）：工作记忆与
   * 心情由引擎传进去（它们是引擎已经算出的一拍），记忆/关系/未完话题/世界状态/自我画像由
   * `ContextBuilder` 决定，渲染也由它做。引擎剩下的是它该有的那部分：FSM、事件与回复安全。
   */
  readonly #context: ContextBuilder | null;

  constructor(options: ConversationEngineOptions) {
    this.#adapter = options.adapter;
    this.#store = options.store;
    this.#config = options.config;
    this.#clock = options.clock ?? systemClock;
    this.#assembler = options.assembler ?? new PromptAssembler();
    this.#fsm = new ConversationStateMachine(options.fsm, this.#clock().getTime());
    this.#silenceToleranceOverride = options.fsm?.silenceTolerance ?? null;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 30_000;
    this.#historyLimit = options.historyLimit ?? 8;
    this.#offsetMinutes = options.offsetMinutes;
    // `reply` is a declaration in `config/xixi.example.yaml` until something reads
    // it; reading it here is what makes the section true. Every value is clamped,
    // so neither the config nor a caller can raise the ADR-0010 ceilings.
    this.#replyLimits = resolveReplyLimits(this.#config.reply, options.reply);
    this.#afterTurn = options.afterTurn;
    // 心情：默认按 `config.mood` 建一个（与 topic engine / self model 同样的默认开启口径），
    // `false` 显式关掉。它只影响语气与窗口（见 `personality.ts`），**不参与硬底线**。
    this.#mood =
      options.mood === false
        ? null
        : options.mood ??
          new MoodEngineImpl({
            store: this.#store,
            config: this.#config.mood,
            clock: this.#clock,
            offsetMinutes: this.#offsetMinutes,
          });
    // 上下文装配：默认按 `config.context.memory`（新段）与 `config.memory`（老段）建一个。
    // 与 `reply` 一样，「配置里写了」不等于生效 —— 这里读它才是。
    const memorySettings = parseContextMemorySettings(
      (this.#config as { readonly context?: { readonly memory?: Record<string, unknown> } }).context?.memory,
      this.#config.memory,
    );
    this.#context =
      options.contextBuilder === false
        ? null
        : options.contextBuilder ??
          new ContextBuilder({
            store: this.#store,
            clock: this.#clock,
            offsetMinutes: this.#offsetMinutes,
            identity: { timezone: this.#config.identity.timezone, place: this.#config.identity.place },
            memory: memorySettings,
            audience: options.audience,
            retriever: new MemoryRetriever(this.#store),
            memoryStore: new MemoryStore(this.#store),
          });
    // The personality is the source of truth, so it is read at construction and
    // re-read on every turn. Forgetting this wiring is no longer invisible: an
    // unset tolerance leaves the window unscaled instead of silently matching
    // the seeded 0.7.
    this.#syncSilenceTolerance();
  }

  /** 心情引擎（`null` = 这个入口关掉了心情这一层）。查看与复位都走它。 */
  get mood(): MoodEngine | null {
    return this.#mood;
  }

  /**
   * 现在的心情（只读，不落库）：面板与测试读它，`prose` 就是进提示词的那几句话。
   *
   * 读它**不会**推进状态：真正的演化只在 {@link beatMood}（`respond()` 与 `buildPrompt()` 各调一次）。
   */
  moodStatus(at: Date = this.#clock()): { readonly state: MoodState; readonly bias: number; readonly prose: readonly string[] } | null {
    if (this.#mood === null) return null;
    const state = this.#mood.stateAt(at);
    return { state, bias: moodBiasOf(state), prose: this.#mood.prose(at) };
  }

  /**
   * 演化一拍并把结果落库（幂等：同一时刻重复调用不写第二行历史）。
   *
   * `respond()` 与 `buildPrompt()` 都会调用它，所以「谁在什么时候把心情推进了一格」是可以从
   * `mood_history` 逐条对回来的（每条都带时间戳与信号摘要）。
   */
  beatMood(at: Date = this.#clock()): MoodBeatResult | null {
    return this.#mood?.beat(at) ?? null;
  }

  /** 心情对软评分/软阈值的有界偏移（最多 ±0.03）：给主动开口的**软**那一侧用，不碰硬门禁。 */
  moodProactivityNudge(at: Date = this.#clock()): number {
    if (this.#mood === null) return 0;
    return moodProactivityNudge(moodBiasOf(this.#mood.stateAt(at)));
  }

  get adapter(): TurnModelProvider {
    return this.#adapter;
  }

  /**
   * The conversation state **as of now**, not as of the last transition.
   *
   * Why reads advance the clock: the FSM only expires timed states when someone
   * calls `tick`, and no production caller ever did — `chat.ts`, `serve-chat.ts`
   * and `scripts/field-test.ts` read `engine.state` to decide whether the next
   * utterance is a wake-up. After a pause longer than the follow-up window the
   * getter returned the remembered `LINGERING`, the callers computed
   * `addressed = false`, and the user's first sentence after the pause was
   * `REJECTED_NOT_ADDRESSED` while their second was accepted (t19 / t6 F1).
   *
   * Trade-offs, stated explicitly:
   *   * this is a getter with a side effect — it advances injected time. That is
   *     inherent: the value it reports is time-dependent, and the alternative
   *     (every caller remembering to `tick`) is exactly what failed.
   *   * it also re-reads the personality window, because the window decides when
   *     the state expires: an admin override that raises `silence_tolerance`
   *     must not be able to produce an early expiry on a read. Cost is one small
   *     indexed SELECT; `serve-chat`'s `/api/state` already reads the profile.
   *   * therefore a caller must not read state after closing the store.
   *   * `respond()` does not use this: it ticks at the turn's own `at` (replay
   *     must follow the supplied timestamp, not the wall clock).
   */
  #advance(now: Date = this.#clock()): ConversationState {
    this.#syncSilenceTolerance();
    this.#fsm.tick(now.getTime());
    return this.#fsm.state;
  }

  get state(): ConversationState {
    return this.#advance();
  }

  /** How long the follow-up window currently is, personality included (§12.2). */
  get lingerMs(): number {
    return this.#fsm.lingerMs;
  }

  snapshot(): ReturnType<ConversationStateMachine['snapshot']> {
    // Same reason as `state`: the snapshot a caller reads must describe now, so
    // `snapshot().state` and `state` can never disagree about the same instant.
    this.#advance();
    return this.#fsm.snapshot();
  }

  /**
   * Read the effective personality and push `silence_tolerance` into the FSM.
   *
   * The engine is the only place that knows both the store and the state
   * machine, which is why the wiring lives here: a caller that builds an FSM by
   * hand (tests, replay) must pass the value explicitly.
   */
  #syncSilenceTolerance(): void {
    const fromStore = this.#store.selfProfile()['silence_tolerance'];
    // Precedence, and the only place it is decided:
    //   1. the persisted personality (the real source, re-read every turn);
    //   2. an explicit `fsm.silenceTolerance` from the caller — tests and replay;
    //   3. `DEFAULT_SILENCE_TOLERANCE` for a store that never seeded the property
    //      (e.g. a profile created before it existed).
    // The FSM itself has no default, so none of these can silently stand in for
    // "personality not wired" the way the old hidden 0.7 did.
    const tolerance = fromStore ?? this.#silenceToleranceOverride ?? DEFAULT_SILENCE_TOLERANCE;
    // 第五轮 t4：心情**乘**在人格算出来的容忍度上，最多 ±6%（`moodToleranceScale`），
    // 所以它永远盖不过人格（人格那侧的倍率是 0.5..1.5）。心情关掉时乘数恒为 1，
    // 于是这一行在有/没有心情两种配置下都不会改变既有行为。
    const moodScale = this.#mood === null ? 1 : moodToleranceScale(moodBiasOf(this.#mood.stateAt(this.#clock())));
    this.#fsm.setSilenceTolerance(tolerance * moodScale);
  }

  /** The tolerance currently scaling the follow-up window (never null). */
  get silenceTolerance(): number {
    return this.#fsm.silenceTolerance ?? DEFAULT_SILENCE_TOLERANCE;
  }

  /**
   * Append the auditable acceptance decision (铁律 5: a reason code and scores,
   * never the user's words and never model reasoning).
   *
   * Without this the log could not answer "why wasn't this sentence accepted?" —
   * a rejected turn used to leave no trace at all.
   */
  #recordDecision(input: {
    readonly sessionId: string;
    readonly at: Date;
    readonly addressed: boolean;
    readonly acceptance: TurnAcceptance;
    readonly before: ConversationState;
    readonly state: ConversationState;
    readonly action: TurnAction;
  }): void {
    const { acceptance } = input;
    const turnIndex = this.#decisionCount;
    this.#decisionCount += 1;
    this.#store.appendEvent(
      buildEvent({
        event_type: 'conversation.decision',
        source: 'brain',
        actor: 'system',
        confidence: acceptance.accept ? 1 : 0.5,
        timestamp: toOffsetIso(input.at, this.#offsetMinutes),
        payload: {
          session_id: input.sessionId,
          turn_index: turnIndex,
          accepted: acceptance.accept,
          reason: acceptance.reason,
          action: input.action,
          fsm_state: input.state,
          fsm_state_before: input.before,
          addressed: input.addressed,
          acceptance_score: acceptance.accept ? 1 : 0,
          linger_ms: this.#fsm.lingerMs,
          // 这个数是**人格算出来的容忍度**（见 `#syncSilenceTolerance` 的注释：心情乘在它上面，
          // 但它本身不带心情）—— 字段名与语义保持不变，心情的数值不塞进这个契约字段。
          silence_tolerance: this.silenceTolerance,
        },
      }),
    );
  }

  /** Expire timed states without producing a turn (used by the loop and by tests). */
  tick(at: Date = this.#clock()): void {
    this.#fsm.tick(at.getTime());
  }

  /** "今天我想安静点": no turn is accepted until `until` (null = until resume()). */
  quiet(until: Date | null = null, at: Date = this.#clock()): void {
    this.#fsm.suspend(until === null ? null : until.getTime(), at.getTime());
    this.#store.recordHealth('conversation', 'ok', `quiet mode until ${until === null ? 'resume' : until.toISOString()}`);
  }

  resume(at: Date = this.#clock()): void {
    this.#fsm.resume(at.getTime());
  }

  /** Working memory for the next turn: the last N turns of this session (§10.2 A). */
  workingMemory(sessionId: string): PromptTurn[] {
    return this.#store.recentTurns(sessionId, this.#historyLimit).map((turn) => ({
      role: turn.role,
      text: turn.text ?? '',
      action: turn.action,
    }));
  }

  /**
   * 组装这一轮的提示词（不调用模型）—— Debug UI、测试、重放都用它。
   *
   * `moodBeat` 是**已经评估好**的那一拍（`respond()` 会在把这一轮落库之后先评估，再调这里）。
   * 省略时它自己评估一拍（Debug UI 与测试走这条默认路径）。两条路径都只评估**一次**，
   * 而且都用同一份 `#moodContext` 渲染，所以「提示词里写的心情」与「库里那行心情」永远是同一个。
   *
   * V0.3 P1：上下文（记忆/关系/未完话题/世界/自我/听众）全部来自 `ContextBuilder` —— 见
   * `buildUserTurnContext()`。引擎只负责把「这一拍」的三样东西传进去：会话、心情、以及
   * 它自己的 FSM 状态。
   */
  buildPrompt(input: RespondInput, moodBeat: MoodBeatResult | null = this.beatMood(input.at ?? this.#clock())): AssembledPrompt {
    const at = input.at ?? this.#clock();
    const session = this.#store.getSession(input.sessionId);
    const mood = this.#moodContext(at, moodBeat);
    const context = this.#context?.buildUserTurn({
      userText: input.gate ?? input.text,
      at,
      recentTurns: this.workingMemory(input.sessionId),
      ...(mood === undefined ? {} : { mood }),
    });
    return this.#assembler.assemble({
      identityName: this.#config.identity.name,
      personality: this.#store.selfProfile(),
      // 世界状态的**回退**（P2.5-J）：上下文层开着时，进提示词的是 `#contextSections` 里那份
      // `ContextBuilder` 渲染的世界行（含在场判断）；这一份轻量写法只在关掉上下文层时被读。
      world: worldStateLite(at, this.#config.identity.timezone, this.#offsetMinutes),
      // Advanced at the turn's own timestamp, not the wall clock: replay must
      // follow the supplied `at`, which is also what `respond()` decides with.
      conversationState: this.#advance(at),
      turnIndex: session.turnCount,
      history: this.workingMemory(input.sessionId),
      userText: input.text,
      language: languageName(this.#config.identity.language),
      mood,
      ...this.#contextSections(context, at),
    });
  }

  /**
   * 主动开口那一条路的提示词（V0.3 P1 / pack §1 的 `buildProactive`）。
   *
   * 它与 `buildPrompt` **走同一个装配器与同一个 ContextBuilder**，只有两处不同，都是刻意的：
   *   * 依据行（`fact`）代替用户原话做词面相关的查询，因为主动开口时没有「对方刚说的一句话」；
   *   * 不带最近几轮当工作记忆 —— 把上一轮当成「用户刚说」塞进去，正是「刚说完就重复」的来源
   *     （主动循环自己用 `recentLines` 防重复，那是候选层的事）。
   *
   * 没有 `sessionId` 时不会去读会话（这时它也不该假装自己知道会话状态）。
   */
  buildProactivePrompt(input: {
    /** 给模型看的那段指令（就是 `user` 里的内容）。 */
    readonly directive: string;
    /** 程序给这一轮检索用的依据行（不会出现在提示词里，见 `AssembleInput.gate`）。 */
    readonly fact: string;
    readonly at?: Date;
    readonly sessionId?: string | null;
    readonly conversationState?: ConversationState;
  }): AssembledPrompt {
    const at = input.at ?? this.#clock();
    const mood = this.#moodContext(at, this.beatMood(at));
    const context = this.#context?.buildProactive({
      fact: input.fact,
      at,
      ...(mood === undefined ? {} : { mood }),
    });
    // 会话状态与轮次按调用方给的那一刻推进（与 `buildPrompt` 同一条纪律：重放跟着 `at` 走）。
    const conversationState = input.conversationState ?? this.#advance(at);
    const sessionId = input.sessionId ?? null;
    const turnIndex = sessionId === null ? 0 : this.#store.getSession(sessionId).turnCount;
    return this.#assembler.assemble({
      identityName: this.#config.identity.name,
      personality: this.#store.selfProfile(),
      // 与 `buildPrompt` 同一条：这是回退，上下文层给的世界行（含在场）优先。
      world: worldStateLite(at, this.#config.identity.timezone, this.#offsetMinutes),
      conversationState,
      turnIndex,
      // 主动开口不是「接住对方的话」：不做工作记忆展开（见方法注释）。
      history: [],
      userText: input.directive,
      // 记忆检索的查询用**依据行**，而不是那段指令（见 `AssembleInput.gate`）。
      gate: input.fact,
      language: languageName(this.#config.identity.language),
      mood,
      ...this.#contextSections(context, at),
    });
  }

  /** 上下文对象（引擎这一侧的可核对视图）：面板与测试读它，不必重新跑一遍装配。 */
  buildUserTurnContext(input: RespondInput, moodBeat: MoodBeatResult | null = this.beatMood(input.at ?? this.#clock())): ConversationContext | null {
    if (this.#context === null) return null;
    const at = input.at ?? this.#clock();
    const mood = this.#moodContext(at, moodBeat);
    return this.#context.buildUserTurn({
      userText: input.text,
      at,
      recentTurns: this.workingMemory(input.sessionId),
      ...(mood === undefined ? {} : { mood }),
    });
  }

  /** 主动开口那一条路的上下文对象（见 `buildProactivePrompt`）。 */
  buildProactiveContext(input: ProactiveTurnContextInput): ProactiveContext | null {
    return this.#context?.buildProactive(input) ?? null;
  }

  /**
   * 读空气（「说还是不说」）时给模型的**上下文摘要**（V0.3 P1-b / pack §6 §7）。
   *
   * 与 `buildProactivePrompt` 走同一份 `ContextBuilder`、同一个渲染出口闸门，区别只在用途：
   * 那份是**开口之后**组句子用的，这份是**判定之前**读空气用的。两处从同一个 `ProactiveContext`
   * 渲染，所以「决策时看到的」与「说话时看到的」不会互相漂。
   *
   * 没有上下文层（`contextBuilder: false`）时返回 `null`：调用方省略 `context` 即可，
   * 决策输入于是与从前逐字相同。
   */
  buildProactiveDecisionContext(input: ProactiveTurnContextInput): ProactiveContextLines | null {
    const context = this.buildProactiveContext(input);
    if (context === null || this.#context === null) return null;
    const rendered = this.#context.render(context, input.at);
    return {
      memories: rendered.memoryLines,
      relationship: rendered.relationshipLines,
      openThreads: rendered.openThreadLines,
    };
  }

  /**
   * 把上下文里的每一块交给提示词装配器。
   *
   * 这是「上下文只有一处装配入口」这句话的**唯一**落地点：引擎不在这里增删任何一块，
   * 它只做搬运（渲染由 `ContextBuilder.render` 做，于是出口闸门在那一侧只有一处）。
   *
   * P2.5-J：`worldState` 也是搬的一块 —— `ContextBuilder` 算出来的世界行（含在场判断）以前在这里
   * 被漏掉了，提示词用的是 `worldStateLite` 的轻量版本，于是库里写着「他这会儿在家」模型也看不到。
   * 现在这里的 `worldState` 进提示词，`buildPrompt` / `buildProactivePrompt` 里那个 `worldStateLite`
   * 只在**这一块缺席**（= 关掉上下文层）时才被读，两条路互斥，不会重复。
   * （字段名不叫 `world`：那个名字是 `AssembleInput` 上的轻量回退，重名会让展开后的类型变成联合。）
   */
  #contextSections(
    context: ConversationContext | ProactiveContext | undefined,
    at: Date,
  ): {
    worldState?: { readonly lines: readonly string[] };
    memories?: { readonly lines: readonly string[]; readonly injected: number; readonly droppedAtRender: number };
    relationship?: { readonly lines: readonly string[] };
    openThreads?: { readonly lines: readonly string[] };
    self?: { readonly lines: readonly string[]; readonly profile: Readonly<Record<string, number>> };
    audience?: { readonly lines: readonly string[] };
  } {
    if (context === undefined) return {};
    const rendered = this.#context?.render(context, at);
    if (rendered === undefined) return {};
    return {
      worldState: { lines: rendered.worldLines },
      memories: {
        lines: rendered.memoryLines,
        injected: context.memories.length,
        droppedAtRender: context.memoriesDiagnostics.droppedAtRender,
      },
      relationship: { lines: rendered.relationshipLines },
      openThreads: { lines: rendered.openThreadLines },
      self: { lines: rendered.selfLines, profile: context.self.profile },
      audience: { lines: audienceLines(context.audience) },
    };
  }

  /**
   * 心情进提示词的那一小块：散文给模型，数字只进 `sections`（Debug UI）。
   *
   * `staleAfterMinutes` 用的是回落时间常数（`3 / decay_per_hour` 分钟 = 抹掉约 20% 的时间），
   * 所以「这份心情算不算旧」与心情真的回落到哪儿是一致的一套数，不是随手写的第二个常数。
   */
  #moodContext(at: Date, beat: MoodBeatResult | null): MoodContext | undefined {
    if (this.#mood === null) return undefined;
    const state = beat?.state ?? this.#mood.stateAt(at);
    const stored = beat?.stored ?? this.#mood.stored();
    const decayPerHour = this.#mood.settings.decayPerHour;
    const staleAfterMinutes = decayPerHour > 0 ? Math.round((0.2 / decayPerHour) * 60) : 6 * 60;
    return {
      valence: state.valence,
      energy: state.energy,
      prose: beat?.prose ?? this.#mood.prose(at),
      updatedAt: stored?.updatedAt ?? null,
      staleAfterMinutes,
      now: toOffsetIso(at),
    };
  }

  /**
   * t111: the deterministic backstop for a caller that composes a line **outside** `respond()` —
   * today the console's proactive delivery seam, which builds its own prompt and calls the adapter
   * directly. The rule is the same as inside `respond()`: a concrete claim that only a lookup can
   * produce may not be spoken unless a tool actually ran in that turn.
   *
   * Returns the text to speak (`text`), whether it had to be replaced (`ok === false`) and the
   * offending substrings for the audit note. Callers must not throw the claims away silently:
   * 「说了具体数值却没有查」 should always be visible somewhere.
   */
  screenUnbackedFacts(
    text: string,
    toolName: string | null,
  ): { readonly ok: boolean; readonly text: string; readonly claims: readonly UnbackedFactClaim[] } {
    // t7: this is the backstop for a line composed *outside* `respond()` — today the console's
    // proactive delivery, which builds its own prompt and calls the adapter directly. The same reply
    // hygiene therefore applies here: tool-call markup and leaked English reasoning never become a
    // spoken line, whichever seam produced them.
    const cleaned = sanitizeSpokenReply(text, { language: this.#config.identity.language }).text;
    if (toolName !== null) return { ok: true, text: cleaned, claims: [] };
    // t21: the clock is part of the same boundary — this seam has the turn's own timestamp available.
    const claims = findUnbackedFactClaims(cleaned, {
      now: this.#clock(),
      offsetMinutes: this.#offsetMinutes,
    });
    if (claims.length === 0) return { ok: true, text: cleaned, claims: [] };
    return { ok: false, text: UNBACKED_FACT_REPLY, claims };
  }

  async respond(input: RespondInput, hooks: RespondHooks = {}): Promise<ConversationTurn> {
    const at = input.at ?? this.#clock();
    // `#advance(at)` re-reads the personality (which scales the follow-up window)
    // and expires timed states at the turn's own timestamp, so both the decision
    // below and the audited `before` describe this instant. Ordering matters: the
    // window must be current before it is used to decide anything.
    const before = this.#advance(at);
    // Not "just a read": this is a guard and it is kept on purpose. `getSession` throws
    // `UNKNOWN_SESSION` for a session the store has never seen, and `respond()` must keep refusing
    // such a turn (it was added in f5a54be for exactly that). The *value* is unused, so the binding
    // is gone — but the call stays.
    this.#store.getSession(input.sessionId);
    const addressed = input.addressed ?? true;
    const acceptance = this.#fsm.shouldAcceptTurn({ addressed, at: at.getTime() });
    if (!acceptance.accept) {
      this.#recordDecision({
        sessionId: input.sessionId,
        at,
        addressed,
        acceptance,
        before,
        state: acceptance.state,
        action: 'SILENCE',
      });
      return {
        accepted: false,
        reason: acceptance.reason,
        state: acceptance.state,
        action: 'SILENCE',
        text: null,
        segments: [],
        segmentGapMs: this.#replyLimits.gapMs ?? REPLY_LIMITS.defaultGapMs,
        provider: this.#adapter.provider,
        model: this.#adapter.describe().model,
        // A rejected turn never reached the model: no stop reason, and the silence is the FSM's
        // refusal rather than something the model or the hygiene gate did.
        finishReason: null,
        silenceReason: null,
        // No tool ran on a rejected turn, and the field is `string | null` — so `null`, not a
        // missing key (a console reading `.toolName` used to get `undefined` here).
        toolName: null,
        hygiene: null,
        latencyMs: 0,
        firstTokenMs: null,
        prompt: null,
      };
    }

    this.#fsm.onUserTurn(at.getTime());
    // pack Phase 4：用户这条轮次的事件 id 要交给后台提取器 —— 派生出来的记忆/学习/未完话题
    // 都靠它指回原始事实（铁律 4：Raw Event 与 Memory 分层）。
    const userTurnEventId = this.#store.recordTurn({
      sessionId: input.sessionId,
      role: 'user',
      action: 'SPEAK',
      text: input.text,
    }).event.event_id;
    // 心情在**落库之后**评估：真实的一轮是「判接受 → 落 turn → 组装提示词」，而心情的信号源就是
    // 刚落的这一轮（「谢谢你啊」）。评估放在落库之前会看不到它（现象：夸奖要等到下一拍才算），
    // 所以这里把评估结果**传给** `buildPrompt`，两边用的是同一拍。
    const prompt = this.buildPrompt({ ...input, at }, this.beatMood(at));
    const startedAt = Date.now();

    let decisionRecorded = false;
    const recordAcceptedDecision = (action: TurnAction, state: ConversationState): void => {
      if (decisionRecorded) return;
      decisionRecorded = true;
      this.#recordDecision({
        sessionId: input.sessionId,
        at,
        addressed,
        acceptance,
        before,
        state,
        action,
      });
    };

    let turnAction: TurnAction = 'SILENCE';
    let turnText: string | null = null;
    /** Pack Phase 2: the last tool that actually ran in this turn, if any. */
    let turnToolName: string | null = null;
    let turnProvider = this.#adapter.provider;
    let turnModel = this.#adapter.describe().model;
    /** t21: the provider's stop reason, carried onto the turn (t4 F5 — attribute a mid-word cut). */
    let turnFinishReason: string | null = null;
    /** t21: why the turn ended silent, when it did (t12 F2 — artifact-only vs a chosen silence). */
    let turnSilenceReason: SilenceReason = null;
    /** t21: what the hygiene gate had to remove, or null when the reply was clean. */
    let turnHygiene: ReplyHygieneSummary | null = null;
    let firstChunkAt: number | null = null;
    // Supplying `onSegment` selects segmented playback, and the two audio seams
    // are mutually exclusive (see `RespondHooks`): otherwise this reply would be
    // spoken once by the delta consumer and once by the segment player.
    const playSegments = hooks.onSegment !== undefined;
    /** How the accepted reply is spoken; computed once, from the final text. */
    let replySplit: SegmentedReply | null = null;
    try {
      const stream = await this.#adapter.handleUserTurn({
        sessionId: input.sessionId,
        text: input.text,
        prompt,
        timeoutMs: this.#turnTimeoutMs,
        // t88: the caller's still frame(s) for this turn, passed straight through. Absent for every
        // ordinary turn, so the text path is byte-for-byte what it was (t87 pins that in tests).
        ...(input.images === undefined ? {} : { images: input.images }),
      });

      // The silence token can arrive split across deltas ("[" + "静默" + "]"), so a
      // per-chunk check is not enough. Text is held back only while it could still
      // become the token; anything that diverges is flushed immediately, which
      // keeps normal replies streaming at full speed. The holding still happens
      // when the caller plays segments — the token must be detected exactly the
      // same way — only the handoff is skipped.
      let held = '';
      let suppressed = false;
      /** t111: did any tool actually run in this turn? Only then may a lookup-only claim stand. */
      let toolRan = false;
      /**
       * t111: text holding a concrete claim that only a lookup can know is kept back until this turn
       * proves it (a `tool` chunk arrives) or ends (then it is replaced below). Once holding starts,
       * everything after it is held too — otherwise the next sentence would be spoken before it.
       * The segment path never streams, so it only needs the end-of-turn decision.
       */
      let heldFacts = '';
      /**
       * t7: the streaming seam, and the reason it is not `hooks.onTextChunk` directly. A provider
       * can put tool-call markup in the *text* stream (measured: 7 of 8 weather turns, baseline §4),
       * and a TTS driven by deltas would speak it a piece at a time. `markupHold` buffers from the
       * first possible marker until the block closes or the stream ends; the final text is gated
       * again below, for every adapter — including ones this file knows nothing about.
       */
      const markupHold = createSpokenTextFilter({ language: this.#config.identity.language });
      const speak = async (text: string): Promise<void> => {
        if (playSegments) return;
        const safe = markupHold.push(text);
        if (safe.length > 0) await hooks.onTextChunk?.(safe);
      };
      /**
       * t21: program-generated lines (`UNBACKED_FACT_REPLY`, the silence notices) are already final
       * text — they are not model deltas that could still turn into reasoning or markup, so they must
       * not go through the hold. Holding them would swallow a trailing 「？」 (the hold releases only up
       * to the last Han character), and the repair line *is* a question.
       */
      const speakProgram = async (text: string): Promise<void> => {
        if (playSegments) return;
        await hooks.onTextChunk?.(text);
      };
      for await (const chunk of stream) {
        if (chunk.type === 'tool') {
          toolRan = true;
          turnToolName = chunk.name;
          if (heldFacts.length > 0 && !suppressed) {
            await speak(heldFacts);
            heldFacts = '';
          }
          continue;
        }
        if (chunk.type !== 'text') continue;
        if (firstChunkAt === null) firstChunkAt = Date.now();
        if (suppressed) continue;
        held += chunk.text;
        const candidate = held.trim();
        if (SILENCE_TOKEN.startsWith(candidate)) {
          if (candidate === SILENCE_TOKEN) {
            suppressed = true;
            held = '';
          }
          continue;
        }
        if (heldFacts.length > 0 || (!toolRan && findUnbackedFactClaims(held).length > 0)) {
          heldFacts += held;
          held = '';
          continue;
        }
        await speak(held);
        held = '';
      }
      if (!suppressed && held.length > 0) await speak(held);
      if (!suppressed) {
        const heldTail = markupHold.flush();
        if (!playSegments && heldTail.length > 0) await hooks.onTextChunk?.(heldTail);
      }
      const result = await stream.result;

      // t7 (baseline §4): two artifacts were heard on the real voice path — a reply whose whole body
      // was tool-call markup, and a reply that was English self-reasoning. 铁律 1 says the program
      // owns that boundary, so both are removed here, before TTS, the transcript or working memory can
      // see them, whatever adapter produced them. A reply that was nothing but an artifact is silence
      // (§55), and the removal is reported through `onNotice` so it stays auditable.
      const hygiene = sanitizeSpokenReply(result.text ?? '', { language: this.#config.identity.language });
      if (hygiene.removedChars > 0) {
        await hooks.onNotice?.({ code: 'REPLY_HYGIENE', detail: describeHygiene(hygiene) });
      }
      // t21 (t4 F5): a reply that stops mid-word is a provider truncation, and without the stop reason
      // it is indistinguishable from a model that simply ended there. `length` means the token budget
      // ran out; a broken sentence at the very end is the visible symptom (t4 measured 1/39 turns).
      const truncated = result.finishReason === 'length';
      if (truncated) {
        await hooks.onNotice?.({
          code: 'REPLY_TRUNCATED',
          detail: `模型输出被 token 上限截断（finish_reason=length，provider=${result.provider}/${result.model}，${(hygiene.text || result.text || '').length} 字）`,
        });
      }

      // t111 (the「成都阴天 19 到 25 度」bug): the model asserted something only a lookup can know
      // and never called the tool. 铁律 1/3 put this boundary in the program, not in the prompt: the
      // claim must not reach audio, the transcript, or working memory. She says she is not sure
      // instead, and the caller gets a notice with the offending text for the audit trail.
      //
      // t21 (t4 F2) added the clock to that boundary: the program knows the real time (it is in the
      // prompt), so 「凌晨一点半」 at 00:29 is a checkable claim that contradicts the world state — no
      // tool needed to refute it. Past-tense talk (「昨天三点半」) is left alone on purpose.
      const unbackedClaims =
        toolRan || hygiene.text.length === 0
          ? []
          : findUnbackedFactClaims(hygiene.text, { now: at, offsetMinutes: this.#offsetMinutes });
      let replyText: string | null = result.text === null ? null : hygiene.text;
      if (unbackedClaims.length > 0) {
        replyText = UNBACKED_FACT_REPLY;
        heldFacts = '';
        await hooks.onNotice?.({
          code: 'UNBACKED_FACT_CLAIM',
          detail: `未调用工具却给出可核查事实：${unbackedClaims.map((claim) => claim.match).join('、')}`,
        });
        await speakProgram(UNBACKED_FACT_REPLY);
      } else if (heldFacts.length > 0) {
        // A tool ran after the claim was held → the sentence was backed, so it may be spoken now.
        await speak(heldFacts);
        heldFacts = '';
      }

      // §55 is an engine-level rule, not an adapter's promise: whatever the adapter
      // reports, a reply that is only the silence token becomes SILENCE here, so a
      // stray control token can never reach TTS or the transcript. `replyText` (not
      // `result.text`) is what the turn actually says, so a replaced claim never
      // reaches the log either (t111).
      //
      // t21 (t12 F2): 「为什么她这次没说话」 has two very different answers — the model chose silence,
      // or the whole reply was an artifact (a tool marker / English reasoning / markdown) that the
      // hygiene gate removed. They used to look identical in every caller, so the turn now carries a
      // `silenceReason` (and the hygiene summary) that a console can print.
      const artifactOnly = result.text !== null && hygiene.text.length === 0 && result.action !== 'SILENCE';
      const silent = result.action === 'SILENCE' || replyText === null || isSilenceReply(replyText);
      turnAction = silent ? 'SILENCE' : result.action;
      turnText = silent ? null : replyText;
      turnProvider = result.provider;
      turnModel = result.model;
      turnFinishReason = result.finishReason;
      turnSilenceReason = silent ? (artifactOnly ? 'ARTIFACT_ONLY_REPLY' : 'MODEL_SILENCE') : null;
      turnHygiene = hygiene.removedChars === 0 ? null : summarizeHygiene(hygiene);

      this.#store.recordTurn({
        sessionId: input.sessionId,
        role: 'assistant',
        action: turnAction,
        text: turnText,
        toolName: silent ? null : result.toolName,
      });

      // ADR-0010 M6/M7: one turn stays one turn. Splitting here — after the single
      // assistant record, before `onReplyCompleted` — is what keeps the FSM
      // advancing exactly once, and reading the clock after the last segment is
      // what starts the follow-up window from the end of the *last* one. While the
      // segments are being played the state is still ACTIVE (M8), so the user can
      // cut in.
      replySplit = turnText === null ? null : splitReplyIntoSegments(turnText, this.#replyLimits);
      let playbackError: unknown = null;
      if (replySplit !== null) {
        const lastIndex = replySplit.segments.length - 1;
        try {
          for (const [index, segment] of replySplit.segments.entries()) {
            await hooks.onSegment?.({
              index,
              text: segment,
              total: replySplit.segments.length,
              gapMsAfter: index === lastIndex ? null : replySplit.gapMs,
            });
          }
        } catch (cause) {
          // ADR-0010 M9: a failed segment stops the remaining ones and ends the
          // turn — the follow-up window still opens, so one broken TTS call cannot
          // leave the conversation stuck in ACTIVE. The failure is reported to the
          // caller afterwards rather than swallowed, and the log keeps exactly one
          // assistant record (the log is conversation-level, not audio-level).
          playbackError = cause;
        }
      }
      const finishedAt = this.#clock();
      this.#fsm.onReplyCompleted(finishedAt.getTime());
      // pack Phase 4 /《方案》§11.1：回复已经说完、两个 turn 都已落库，现在把「这一轮」交给
      // 后台提取（记忆 / 反馈学习 / 未完话题）。**不 await**：提取慢不慢与用户听到回复无关；
      // 提取里出错也不能让这一轮失败（只记 notice，调用方可以打日志）。
      if (this.#afterTurn !== undefined) {
        try {
          this.#afterTurn({
            sessionId: input.sessionId,
            userText: input.text,
            replyText: turnText,
            at: finishedAt,
            userEventId: userTurnEventId,
            // pack Phase 4 的推断侧（铁律 4）：读空气时模型给出的白名单码，只在他「上一条轮次之后、
            // 这一条轮次之前」真的有过一次读法时才有值（边界与理由见 `#inferredCodeForTurn`）。
            inferredCode: this.#inferredCodeForTurn(input.sessionId, finishedAt),
          });
        } catch (error) {
          await hooks.onNotice?.({
            code: 'EXTRACTION_ENQUEUE_FAILED',
            detail: `后台提取没能入队：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (playbackError !== null) throw playbackError;
    } finally {
      // Recorded even when the model throws: "the turn was accepted, then the
      // provider failed" is exactly the fact §21 降级 needs later.
      recordAcceptedDecision(turnAction, this.#fsm.state);
    }

    return {
      accepted: true,
      reason: acceptance.reason,
      state: this.#fsm.state,
      action: turnAction,
      text: turnText,
      // `replySplit` is set even if a hook threw (the split is computed before
      // playback), so a failed playback still reports how the reply was meant to
      // be spoken; a SILENCE turn has no segments.
      segments: replySplit?.segments ?? [],
      segmentGapMs: replySplit?.gapMs ?? this.#replyLimits.gapMs ?? REPLY_LIMITS.defaultGapMs,
      provider: turnProvider,
      model: turnModel,
      finishReason: turnFinishReason,
      silenceReason: turnSilenceReason,
      toolName: turnAction === 'SILENCE' ? null : turnToolName,
      hygiene: turnHygiene,
      /**
       * V0.3 P0-D: **measurement, deliberately not on the injected clock.**
       *
       * Everything else this turn reports is a function of the injected `clock` (the FSM's instants,
       * `conversationState`, the mood beat, the store's timestamps) — that is what makes a replay
       * reproducible. These two are the exception *on purpose*: they are how long the machine took,
       * so they must come from the real wall clock even when the run is a replay. A replay that
       * reported them would leak this machine into a comparable artefact, and two runs of the same
       * script would disagree in a field that no behaviour change explains.
       *
       * The boundary is enforced on the other side: `ReplayTurnResult`
       * (`packages/runtime/src/replay-runtime.ts`) has no latency field at all, and
       * `tests/replay/replay-format.test.ts` asserts that shape at compile time.
       */
      latencyMs: Date.now() - startedAt,
      firstTokenMs: firstChunkAt === null ? null : firstChunkAt - startedAt,
      prompt,
    };
  }

  /**
   * 这一轮的**推断反馈码**（pack Phase 4 / 铁律 4 的推断侧）：读空气时模型在
   * `proactive.decision.model_reason_code` 上给出的白名单码。
   *
   * 它不是「模型对这一轮的评价」，而是**在他两次开口之间读到的东西** —— 所以归属只用一条可复算的
   * 边界，不做任何猜测：
   *
   *   * 只看**这一轮之前**写下的判断（`at` 之后的属于未来）；
   *   * 只看**他上一条轮次之后**写下的判断：他再开口一次边界就前移，同一个读法不会再解释下一轮
   *     （同一次读法只学一次，不会反复学）；
   *   * 只看**同一个会话**（读的是这一段对话里的空气）：别的会话的读法不借过来；
   *   * 取其中**最新**的一条带码判断；会话第一轮没有「上一条轮次」作边界，因此不吃推断。
   *
   * 取不到就返回 `null`：提取器这时只按显式反馈解释 —— **宁可不学，也不瞎归因**。至于这个码算不算
   * 学习信号，由 `interpretInference` 的白名单与偏移表决定（`good_moment` / `not_worth_it` /
   * `wrong_moment` / `unspecified` 都没有偏移，取到也不会学）。
   */
  #inferredCodeForTurn(sessionId: string, at: Date): string | null {
    const previousUserTurnAt = this.#previousUserTurnAt(sessionId);
    if (previousUserTurnAt === null) return null;
    const decisions = this.#store.readEvents({
      type: 'proactive.decision',
      sessionId,
      limit: Number.MAX_SAFE_INTEGER,
    });
    for (let index = decisions.length - 1; index >= 0; index -= 1) {
      const event = decisions[index];
      if (event === undefined) continue;
      const decisionAt = Date.parse(event.timestamp);
      if (!Number.isFinite(decisionAt) || decisionAt > at.getTime()) continue;
      // 从新往旧扫：第一条落在边界之外的判断意味着**窗口里没有**可用的读法。
      if (decisionAt <= previousUserTurnAt) return null;
      const code = (event.payload as Record<string, unknown>)['model_reason_code'];
      if (typeof code === 'string' && code.length > 0) return code;
    }
    return null;
  }

  /**
   * 这个会话里**上一条用户轮次**的时刻（毫秒），没有就返回 `null`。
   *
   * 调用它时这一轮的两条 `conversation.turn`（用户 + 西西）都已经落库，所以最近的一条 user 轮次
   * 就是**这一轮自己**，再往前第一条才是「上一条」。
   */
  #previousUserTurnAt(sessionId: string): number | null {
    const turns = this.#store.recentTurns(sessionId, 8);
    let seenCurrentTurn = false;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn === undefined || turn.role !== 'user') continue;
      if (!seenCurrentTurn) {
        seenCurrentTurn = true;
        continue;
      }
      const parsed = Date.parse(turn.createdAt);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
}

// ---------------------------------------------------------- unverified concrete claims (t111)

/**
 * A concrete, checkable claim the model can only know by looking it up.
 *
 * Field observation (2026-09-30): 主动开口 said 「成都阴天 19 到 25 度」 without ever calling
 * `xixi_get_weather`. A number like that cannot come from the context window, so it is a
 * fabrication — and 铁律 1/3 say the *program* owns that boundary, not the prompt alone. The
 * prompt forbids it (see `HARD_POLICY` §7); this is the deterministic backstop.
 */
export interface UnbackedFactClaim {
  readonly kind: 'temperature' | 'forecast' | 'attribution' | 'clock';
  /** The offending substring, kept for the audit note (never spoken). */
  readonly match: string;
}

/** `19 到 25 度`, `零下 3 度`, `-2℃`, `180 度` — temperatures, including ranges. */
const TEMPERATURE_SIGN = '(?:(?:零下|负|[-−])\\s*)?';
const TEMPERATURE_NUMBER = '\\d{1,3}'; // t117 (F2): `\d{1,2}` truncated `180 度` into `80 度` in the audit note.
const TEMPERATURE_RANGE = new RegExp(
  `${TEMPERATURE_SIGN}${TEMPERATURE_NUMBER}\\s*(?:到|至|~|～|-|—|–)\\s*${TEMPERATURE_SIGN}${TEMPERATURE_NUMBER}\\s*(?:度|℃|°C)`,
);
const TEMPERATURE_SINGLE = new RegExp(`${TEMPERATURE_SIGN}${TEMPERATURE_NUMBER}\\s*(?:度|℃|°C)`);
/** Numbers only a measurement can produce: 概率 / 湿度 / 风力 / 空气质量 / 紫外线. */
const FORECAST_METRIC = /(?:降水概率|降雨概率|湿度|风力|空气质量|空气指数|紫外线(?:指数)?)\s*(?:为|是|约|大概|在)?\s*\d{1,3}\s*(?:%|％|级|度)?/;
/**
 * Claims attributed to a source that was never consulted — **tightened in t117 (review F1)**.
 *
 * The first version matched any source word (`医生|专家|朋友说|别人说|他们告诉|新闻|…`), which
 * replaced whole ordinary sentences: 「朋友说要来吃饭」「专家都觉得这样安排挺好」、
 * 「今天新闻挺热闹的，说小区门口要办集市」. Two rules now keep it to 「有内容可核查」:
 *   1. the source must be the **speaker** — `天气预报/气象台/预报/报道/新闻` followed by a
 *      reporting verb (`说/称/报/提到/讲/显示/预计`). 「新闻挺热闹的」 has no verb, so it passes;
 *   2. the sentence must carry a fact element (a number, a quotation, or a predicate that can be
 *      true or false). 「天气预报说明天有雨」 and 「新闻里说小区要停水」 still fire;
 *      「医生说多喝水对身体好」 never reaches rule 1 at all.
 * Bare source words (`医生/专家/朋友说/别人说/他们告诉`) are **gone on purpose**: they show up in
 * ordinary talk far more often than in fabrications.
 */
const ATTRIBUTION_SOURCE = /(天气预报|气象台|预报|报道|新闻)\s*里?\s*(?:说|称|报|提到|讲|显示|预计)/;
/** A fact element: a number, a quotation, or a predicate that can be true or false (t117). */
const ATTRIBUTION_CONTENT = /(?:\d|[「“『']|有|要|会|将|是|在|停|降|升|来|去|办|开|改|取消|恢复|雨|雪|风|温|冷|热|晴|阴|涨|跌)/;

/** What she says instead of an unverified claim: no numbers, no new facts, no pretending. */
export const UNBACKED_FACT_REPLY = '这个我记不准，不敢乱说——要不我查一下再告诉你？';

/**
 * The audit line for a reply the hygiene gate had to clean (t7).
 *
 * It names what was removed and whether anything was left to say, so a reader of the log never has
 * to re-run the model to find out what the household did *not* hear.
 */
function describeHygiene(hygiene: ReplyHygieneResult): string {
  const parts: string[] = [];
  if (hygiene.removedMarkupChars > 0) parts.push(`${hygiene.removedMarkupChars} 字的工具调用标记`);
  if (hygiene.removedMarkdownChars > 0) parts.push(`${hygiene.removedMarkdownChars} 字的 markdown 记号`);
  if (hygiene.removedReasoningChars > 0) parts.push(`${hygiene.removedReasoningChars} 字的英文推理`);
  const remainder = hygiene.text.length === 0 ? '剩余为空，按沉默处理' : `剩余：${hygiene.text.slice(0, 40)}`;
  return `回复里剔除了${parts.join('、')}（${remainder}）`;
}

/** The turn-level view of the same hygiene result (t21, t12 F2: the console must see the reason). */
function summarizeHygiene(hygiene: ReplyHygieneResult): ReplyHygieneSummary {
  return {
    removedMarkupChars: hygiene.removedMarkupChars,
    removedMarkdownChars: hygiene.removedMarkdownChars,
    removedReasoningChars: hygiene.removedReasoningChars,
    emptied: hygiene.text.length === 0,
  };
}

/**
 * Find concrete claims in a reply that need a tool result to be true.
 *
 * Deliberately narrow (t111, tightened in t117): it only fires on *specifics* a lookup would
 * produce — numbers with units, a metric, or a statement by a source that was never consulted and
 * that carries something checkable. It must not fire on ordinary talk (「今天有点冷，多穿点」
 * 「朋友说要来吃饭」「医生说多喝水」): a gate that answers 「我不敢乱说」 to a homey sentence is
 * worse than the bug it fixes, and the review (t114 §3) caught exactly that class of damage.
 *
 * t21 added the **clock** (t4 F2): the program hands the model the real time in the prompt, so
 * 「凌晨一点半」 said at 00:29 is checkable — and wrong — without any tool call. The rule is narrow on
 * purpose: it fires only when (a) the sentence names a clock time, (b) the *time of day* matches the
 * real local period (or the sentence has a "now" cue), (c) there is no past-tense marker, and
 * (d) **every** plausible reading of the claimed time is more than `CLOCK_TOLERANCE_MINUTES` away
 * from the real one. 「昨天三点半就醒了」 and 「我平时三点半起床」 therefore pass; 「凌晨两点多」 at
 * 00:32 does not.
 *
 * The readings are folded before the distance check (t1 round 2, found by probing the t21 snapshot):
 *   * a period word picks the hour it names — 「下午三点」 is 15:00, not 03:00. Without this, every
 *     PM clock sentence spoken *during its own period* (the exact case `periodMatches` arms on) was
 *     measured against the AM reading and gated as a fabrication — 「现在下午三点了」 at 15:32 and
 *     「现在已经晚上八点半了」 at 20:15 were both replaced by the repair line;
 *   * a bare 12-hour form (no period word) has two readings — 「现在十二点半了」 at 00:32 means
 *     00:30 (t4's own live example) — and the sentence is only a contradiction if **both** readings
 *     miss the real clock. The repair line must not fire on a true statement: that is the over-gate
 *     class the t114 review warned about;
 *   * the minute token is read as written (t2 review of the t21 snapshot): every Chinese minute token
 *     used to be folded as 30 past the hour, so 「现在凌晨三点五十分了」 at 03:00 measured 03:30 — 30
 *     minutes away — and slipped through the gate. Digits were always read as written; see
 *     `clockMinute` for the numerals.
 */
export function findUnbackedFactClaims(
  text: string,
  context: { readonly now?: Date; readonly offsetMinutes?: number | undefined } = {},
): UnbackedFactClaim[] {
  const claims: UnbackedFactClaim[] = [];
  const add = (kind: UnbackedFactClaim['kind'], match: string): void => {
    if (!claims.some((claim) => claim.kind === kind && claim.match === match)) claims.push({ kind, match });
  };
  const range = TEMPERATURE_RANGE.exec(text);
  if (range !== null) add('temperature', range[0]);
  else {
    const single = TEMPERATURE_SINGLE.exec(text);
    if (single !== null) add('temperature', single[0]);
  }
  const metric = FORECAST_METRIC.exec(text);
  if (metric !== null) add('forecast', metric[0]);
  const attributed = ATTRIBUTION_SOURCE.exec(text);
  if (attributed !== null) {
    // Judge the *sentence* around the source, not the whole reply: the fact element has to sit in
    // the same statement the source is making (t117).
    const sentence = sentenceAround(text, attributed.index);
    if (ATTRIBUTION_CONTENT.test(sentence)) add('attribution', attributed[1] ?? attributed[0]);
  }
  const clock = context.now === undefined ? null : findClockClaim(text, context.now, context.offsetMinutes);
  if (clock !== null) add('clock', clock);
  return claims;
}

/** How far a spoken clock time may sit from the real one before it counts as invented (t21). */
export const CLOCK_TOLERANCE_MINUTES = 45;

/** A "this is happening now" cue; without one, only a matching time-of-day word can make a claim. */
const NOW_CUE = /(现在|这会儿|这个点|这么晚|都\d|已经|还没|还在|才)/;
/** Past-tense markers: 「昨天三点半」 is a memory, not a claim about now. */
const PAST_CUE = /(昨天|昨晚|昨天晚上|前天|上周|上个?月|去年|以前|平时|小时候|当年|那次|那天|当时|刚刚?才)/;
/** `凌晨一点半`, `两点多`, `23:30`, `晚上 7 点`, `3 点五十分` — a clock time with an optional period word. */
const CLOCK_SPOKEN = /(凌晨|清早|早上|上午|中午|下午|傍晚|晚上|深夜|半夜)?\s*([0-9]{1,2})\s*点(?:(半)|([0-9]{1,2}|[零一二两三四五六七八九十]{1,3})\s*分)?([多几])?/;
const CLOCK_DIGITAL = /(?:^|[^\d])([01]?[0-9]|2[0-3])[:：]([0-5][0-9])(?![\d])/;

const CN_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
});

/** Parse a spoken Chinese numeral token (`一`, `两`, `三`, `十`, `十一`, `五十`) into its value. */
function chineseNumeral(token: string): number | null {
  if (token.length === 1) return CN_DIGITS[token] ?? null;
  if (token.startsWith('十')) return 10 + (CN_DIGITS[token[1] as string] ?? 0);
  if (token.endsWith('十')) return (CN_DIGITS[token[0] as string] ?? 0) * 10;
  const [tens, ones] = token.split('十');
  if (tens !== undefined && ones !== undefined) {
    return (CN_DIGITS[tens] ?? 0) * 10 + (CN_DIGITS[ones] ?? 0);
  }
  return null;
}

/**
 * The minutes a clock sentence names, read as written (t2 review of the t21 snapshot).
 *
 * It used to be the constant 30 for **every** Chinese minute token, so a sentence whose real reading
 * sat more than `CLOCK_TOLERANCE_MINUTES` (45) from the clock was still measured as 30 past the hour:
 * 「现在凌晨三点五十分了」 at 03:00 read as 03:30 (30 min away) and slipped through the gate. Digits
 * are `Number`-parsed as before; `半` is still 30; a token the numerals cannot read keeps the old
 * coarse 30 rather than being silently folded to 0. A leading 零 is the spoken filler before a
 * one-digit minute (「三点零五分」 is 5, 「三点零五十分」 is 50), not a digit to add.
 */
function clockMinute(token: string | undefined): number {
  if (token === undefined || token.length === 0) return 0;
  if (token === '半') return 30;
  if (/^[0-9]+$/.test(token)) return Number(token);
  const stripped = token.replace(/^零+/, '') || '零';
  const value = chineseNumeral(stripped);
  return value !== null && value >= 0 && value <= 59 ? value : 30;
}

/** The period word → the hours it covers, for "does this time of day match now". */
const TIME_OF_DAY_HOURS: readonly { readonly word: string; readonly from: number; readonly to: number }[] = [
  { word: '凌晨', from: 0, to: 5 },
  { word: '清早', from: 5, to: 8 },
  { word: '早上', from: 5, to: 9 },
  { word: '上午', from: 8, to: 11 },
  { word: '中午', from: 11, to: 13 },
  { word: '下午', from: 13, to: 17 },
  { word: '傍晚', from: 17, to: 19 },
  { word: '晚上', from: 18, to: 23 },
  { word: '深夜', from: 22, to: 24 },
  { word: '半夜', from: 23, to: 24 },
];

/**
 * The clock time a sentence claims, when that claim is about *now* and contradicts the real clock.
 * Returns the offending substring, or `null` (see `findUnbackedFactClaims` for the rule).
 */
function findClockClaim(text: string, now: Date, offsetMinutes: number | undefined): string | null {
  const local = offsetMinutes === undefined ? now : new Date(now.getTime() + offsetMinutes * 60_000);
  const realMinutes =
    offsetMinutes === undefined
      ? local.getHours() * 60 + local.getMinutes()
      : local.getUTCHours() * 60 + local.getUTCMinutes();
  const realHour = Math.floor(realMinutes / 60);

  // Chinese numerals are the common form in speech; digits are handled by both patterns below.
  const spoken = /(凌晨|清早|早上|上午|中午|下午|傍晚|晚上|深夜|半夜)?\s*([零一二两三四五六七八九十]{1,3})\s*点(?:(半)|([0-9零一二两三四五六七八九十]{1,3})\s*分)?([多几])?/.exec(text);
  const digital = CLOCK_DIGITAL.exec(text);
  const ascii = CLOCK_SPOKEN.exec(text);

  let claimedHour: number | null = null;
  let claimedMinutes = 0;
  /** `15:30` is written in 24-hour form: it has exactly one reading, unlike a bare 「三点」. */
  let unambiguous = false;
  let match = '';
  let period = '';
  if (ascii !== null) {
    period = ascii[1] ?? '';
    const hour = Number(ascii[2]);
    const minutes = clockMinute(ascii[3] ?? ascii[4]);
    if (Number.isFinite(hour) && hour < 24 && Number.isFinite(minutes)) {
      claimedHour = hour;
      claimedMinutes = minutes;
      match = ascii[0].trim();
    }
  }
  if (claimedHour === null && spoken !== null) {
    period = spoken[1] ?? '';
    const token = spoken[2] as string;
    const hour = /^[0-9]+$/.test(token) ? Number(token) : chineseNumeral(token);
    if (hour !== null && hour < 24) {
      claimedMinutes = clockMinute(spoken[3] ?? spoken[4]);
      claimedHour = hour;
      match = spoken[0].trim();
    }
  }
  if (claimedHour === null && digital !== null) {
    claimedHour = Number(digital[1]);
    claimedMinutes = Number(digital[2]);
    unambiguous = true;
    match = digital[0].trim();
  }
  if (claimedHour === null || match.length === 0) return null;

  const sentence = sentenceAround(text, text.indexOf(match));
  if (PAST_CUE.test(sentence)) return null;
  const periodMatches =
    period !== '' && TIME_OF_DAY_HOURS.some((entry) => entry.word === period && realHour >= entry.from && realHour < entry.to);
  if (!periodMatches && !NOW_CUE.test(sentence)) return null;

  // The readings a sentence may name: the hour as written, plus the 12-hour alternate for a bare
  // 1..12 form, narrowed to the period the sentence itself says (see the rule doc above).
  const readings: number[] = [];
  const addReading = (hour: number): void => {
    const minutes = (((hour % 24) + 24) % 24) * 60 + claimedMinutes;
    if (!readings.includes(minutes)) readings.push(minutes);
  };
  addReading(claimedHour);
  if (!unambiguous && claimedHour >= 1 && claimedHour <= 12) addReading(claimedHour === 12 ? 0 : claimedHour + 12);
  let candidates = readings;
  if (period !== '') {
    const range = TIME_OF_DAY_HOURS.find((entry) => entry.word === period);
    if (range !== undefined) {
      const inPeriod = candidates.filter((minutes) => {
        const hour = Math.floor(minutes / 60);
        return hour >= range.from && hour < range.to;
      });
      // 「晚上十二点」 names 00:00, which no period range claims — fall back to every reading.
      if (inPeriod.length > 0) candidates = inPeriod;
    }
  }
  const conflicts = candidates.every((candidate) => {
    const distance = Math.abs(candidate - realMinutes);
    return Math.min(distance, 1440 - distance) > CLOCK_TOLERANCE_MINUTES;
  });
  return conflicts ? match : null;
}

/** The sentence a match sits in — 「。」「！」「？」「；」and newlines are the boundaries (t117). */
function sentenceAround(text: string, index: number): string {
  const boundaries = ['。', '！', '？', '；', '\n'];
  const before = boundaries.map((mark) => text.lastIndexOf(mark, index));
  const after = boundaries.map((mark) => text.indexOf(mark, index)).filter((at) => at >= 0);
  const start = Math.max(...before, -1);
  const end = after.length === 0 ? text.length : Math.min(...after);
  return text.slice(start + 1, end);
}

/**
 * 「谁在听」那一段的正文。
 *
 * 只有**偏离默认**时才说话：家里人在场是常态，不值得每轮说一遍；有外人（电视、来访、媒体）
 * 才需要提醒她换个说法。这是 V0.3 P6「读空气」的第一个可执行版本，口径保守 ——
 * 拿不准就不说（`DEFAULT_AUDIENCE` 按 family 处理）。
 */
function audienceLines(audience: AudienceContext | undefined): string[] {
  if (audience === undefined) return [];
  if (audience.mode === 'public') return ['可能有外人或者电视媒体在场：别提到家里人的私事与没办完的事。'];
  if (audience.mode === 'private') return ['现在只有他自己，不用顾忌别人。'];
  return [];
}

function languageName(code: string): string {
  if (code.toLowerCase().startsWith('zh')) return '中文';
  if (code.toLowerCase().startsWith('en')) return 'English';
  return code;
}
