/**
 * 心情的**演化**（第五轮 t4）：把原始事件变成心情信号，再把信号应用到有界的状态上。
 *
 * 分工（与 `self-model.ts` / `open-threads.ts` 的既有做法一致）：
 *   * `mood.ts` 只有**纯运算**（信号 → 偏移、回落、时段牵引、区间 → 散文）与有界性证明；
 *   * 这里做**事件源与持久化**：读 `conversation.turn` / `proactive.decision` / `presence.changed`，
 *     按确定性规则算出信号，然后通过 `XixiStore.recordMood` 落库（一次事务：当前行 + 变更历史）。
 *
 * 为什么它落在 domain 而不是会话层：心情的**状态**在 `mood_state` 表里、它的**证据**是原始事件，
 * 两者都归领域层（会话层只消费「现在的心情是散文/有界偏移」这个结果）。这样「谁在什么时候把心情
 * 推进了一格」只需要一个地方说得清，也不会出现「引擎换了一个就没人评估心情」。
 *
 * 三条纪律，每条都在代码里可核对：
 *
 *   1. **不越界**：这条链上唯一的写入是 `applyMoodSignals` / `applyMoodDecay` / `applyTimeOfDay`，
 *      三者都返回 `clamp(prev + delta)`（`mood.ts`）。所以「库里存了越界值」在结构上不可能。
 *   2. **幂等**：同一时刻重复评估不会重复吸收同一批信号 —— 去重看事件序号（不是时间），
 *      且每次评估都会前进 `lastBeatAt`（即使心情没有变化）。`beat(sameAt)` 因此是空操作。
 *   3. **可重放**：信号全部来自事件日志与参数，不读模型输出、不读用户原话进状态
 *      （证据只留程序渲染的短句，铁律 5）。
 *
 * 心情**不参与**任何硬底线判定：静默时段 / 额度 / 隐私都在 `proactive.ts` 的硬门禁里，
 * 这里不提供、也不接收任何「能不能说」的判断，只产出**语气**与一个**有界的软偏移**。
 */

import { toOffsetIso } from '@xixi/contracts';

import {
  applyMoodDecay,
  applyMoodSignals,
  applyTimeOfDay,
  clampMood,
  classifyMoodSignal,
  describeMoodSignal,
  moodBias,
  moodProse,
  NEUTRAL_MOOD,
  parseMoodSettings,
  type MoodSettings,
  type MoodSignal,
  type MoodSignalCode,
  type MoodState,
} from './mood.ts';
import { type StoredMood, type XixiStore } from './store.ts';

/** 一次评估的结果：状态本身 + 这一拍凭什么（面板与审计看它）。 */
export interface MoodBeatResult {
  readonly state: MoodState;
  /** 这一拍实际应用了哪些信号（已按每拍上限截断）。 */
  readonly signals: readonly MoodSignal[];
  /** 因为每拍上限被丢掉的信号数（不丢的话下一拍会吃到）。 */
  readonly dropped: number;
  /** 有没有真的变化（没变化就不写历史行）。 */
  readonly changed: boolean;
  /** 距上一次评估过了多久（小时）；第一次评估是 0。 */
  readonly elapsedHours: number;
  /** 这一拍之后距中性的有界偏移（`-1..1`，见 `moodBias`）。 */
  readonly bias: number;
  /** 给模型看的散文 —— 唯一进提示词的东西（`moodProse` 的输出，没有数字）。 */
  readonly prose: readonly string[];
  /** 这一拍之后最新的行（证据、时间戳、为什么）。 */
  readonly stored: StoredMood;
}

export interface MoodEngineOptions {
  readonly store: XixiStore;
  /** `config.xixi.mood`，原样传进来即可。 */
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  /** 已解析的设置，优先于 `config`（测试与重放用）。 */
  readonly settings?: MoodSettings | undefined;
  readonly clock?: (() => Date) | undefined;
  /** 本机时区偏移（分钟），用于「深夜 / 清晨」的时段牵引；默认取运行环境。 */
  readonly offsetMinutes?: number | undefined;
}

/** 主动开口之后多久之内有用户轮次才算「有人接」。 */
const ANSWER_WINDOW_MINUTES = 30;
/** 「家里一直没人」的判定：这么久没有用户轮次也没有人在场。 */
const EMPTY_HOUSE_HOURS = 6;

export class MoodEngine {
  readonly #store: XixiStore;
  readonly #settings: MoodSettings;
  readonly #clock: () => Date;
  readonly #offsetMinutes: number | undefined;

  constructor(options: MoodEngineOptions) {
    this.#store = options.store;
    this.#settings = options.settings ?? parseMoodSettings(options.config);
    this.#clock = options.clock ?? (() => new Date());
    this.#offsetMinutes = options.offsetMinutes;
  }

  get settings(): MoodSettings {
    return this.#settings;
  }

  /** The stored mood, or neutral when nothing has ever moved it. Never out of bounds. */
  current(): MoodState {
    const stored = this.#store.mood();
    if (stored === null) return NEUTRAL_MOOD;
    return clampMood({ valence: stored.valence, energy: stored.energy });
  }

  /** The stored row (evidence, timestamps, why) or `null` on a fresh database. */
  stored(): StoredMood | null {
    return this.#store.mood();
  }

  /** 现在该说的话（散文）：模型看这个，不看数字。 */
  prose(at: Date = this.#clock()): readonly string[] {
    return moodProse(this.stateAt(at));
  }

  /**
   * 心情「现在是多少」——**只读**，不落库。
   *
   * 它把该回落的部分与时段牵引都算上，所以面板与提示词看到的是同一个数；真正的演化由
   * {@link beat} 落库。这样「查看」不会因为读了一次就把库写了一遍（幂等性也就更容易证）。
   */
  stateAt(at: Date = this.#clock()): MoodState {
    const stored = this.#store.mood();
    if (stored === null) return NEUTRAL_MOOD;
    const base = clampMood({ valence: stored.valence, energy: stored.energy });
    if (!this.#settings.enabled) return base;
    const elapsedHours = elapsedHoursSince(stored.lastBeatAt, at);
    const decayed = applyMoodDecay(base, elapsedHours, this.#settings);
    return applyTimeOfDay(decayed, localHourOf(at, this.#offsetMinutes), elapsedHours);
  }

  /**
   * 演化一拍：读日志 → 算信号 → 落库（当前行 + 变更历史）。
   *
   * 幂等：同一时刻重复调用时第二次没有可吸收的信号、回落为 0，因此不写历史行。
   * 关掉设置时**什么都不做**（已有状态保持原样，仍可查看与复位）。
   */
  beat(at: Date = this.#clock()): MoodBeatResult {
    const snapshot = this.#store.moodSnapshot();
    const storedBefore = snapshot.mood;
    const before = storedBefore === null ? NEUTRAL_MOOD : clampMood({ valence: storedBefore.valence, energy: storedBefore.energy });
    if (!this.#settings.enabled) {
      return {
        state: before,
        signals: [],
        dropped: 0,
        changed: false,
        elapsedHours: 0,
        bias: moodBias(before),
        prose: moodProse(before),
        stored: storedBefore ?? {
          valence: before.valence,
          energy: before.energy,
          evidence: {},
          lastBeatAt: null,
          lastEventSequence: 0,
          source: 'mood:disabled',
          summary: '心情演化已关闭',
          updatedAt: toOffsetIso(at),
        },
      };
    }

    const elapsedHours = elapsedHoursSince(storedBefore?.lastBeatAt ?? null, at);
    // 「读到哪儿为止」来自同一个只读快照（`cursorSequence`）：调用方往往是**先落这一轮、再评估心情**，
    // 所以不能靠时间戳判断哪些事件属于这一拍 —— 序号才是可靠的上界。
    const read = this.#signalsSince(storedBefore?.lastEventSequence ?? 0, snapshot.cursorSequence, at);
    const signals = read.signals;
    const decayed = applyMoodDecay(before, elapsedHours, this.#settings);
    const pulled = applyTimeOfDay(decayed, localHourOf(at, this.#offsetMinutes), elapsedHours);
    // 回落自己也要留证据（`time_passed`，两个维度的偏移都是 0）：否则面板只能说「没有新的信号」，
    // 而回答不了「她为什么从刚才那个心情变回平静了」。
    const decayedMoved =
      Math.abs(decayed.valence - before.valence) > 1e-9 || Math.abs(decayed.energy - before.energy) > 1e-9;
    const application = applyMoodSignals(pulled, signals, this.#settings);
    const moved =
      Math.abs(application.state.valence - before.valence) > 1e-9 || Math.abs(application.state.energy - before.energy) > 1e-9;
    // 只加证据，不改状态（`time_passed` 的偏移是 0，所以这一步不会动数值）。计数对象是只读的，
    // 所以这里换成带标记的副本，而不是往 `application.counts` 上写。
    const counts =
      decayedMoved && signals.length === 0
        ? { ...application.counts, time_passed: 1 }
        : application.counts;

    const evidence = mergeEvidence(storedBefore?.evidence ?? {}, counts);
    const dominant = dominantSignal(counts);

    const stored = this.#store.recordMood({
      state: application.state,
      previous: before,
      source: dominant === null ? 'mood:decay' : `mood:${dominant}`,
      summary: summarizeBeat(application, signals.length === 0),
      signals: counts,
      signalCount: application.applied.length,
      droppedCount: application.dropped,
      evidence,
      cursorSequence: read.cursor,
      // Local-offset ISO (`toOffsetIso`), the same shape every other timestamp in this repo uses;
      // `Date#toISOString()` would write UTC and shift the "since the last beat" boundary.
      at: toOffsetIso(at),
    });

    return {
      state: this.current(),
      signals: application.applied,
      dropped: application.dropped,
      changed: moved,
      elapsedHours,
      bias: moodBias(application.state),
      prose: moodProse(application.state),
      stored,
    };
  }

  /**
   * 复位到中性（可回滚的一侧）。**留痕**：历史里会多一行 `reset: true`，
   * 所以「她为什么突然平静了」在数据里有答案。
   */
  reset(reason = 'admin:reset', at: Date = this.#clock()): MoodState {
    this.#store.resetMood(reason, toOffsetIso(at));
    return NEUTRAL_MOOD;
  }

  /**
   * 自上一条评估之后发生的信号，按时间升序 —— 确定性规则，可重放：
   *
   *   * **被夸 / 被嫌 / 被明确叫停**：用户轮次的文本经 `classifyMoodSignal`（拒绝 > 嫌弃 > 夸奖）；
   *   * **主动开口有人接 / 没人接**：`proactive.decision` 里 `speak=true` 的那些，看它之后
   *     `ANSWER_WINDOW_MINUTES` 内有没有用户轮次；
   *   * **有人到家**：`presence.changed` 里 `present=true`；
   *   * **家里一直没人**：长达 `EMPTY_HOUSE_HOURS` 既没有用户轮次也没有人在场时，记一条（不是每拍一条）。
   *
   * **去重看事件序号，不看时间**：调用方先把这一轮落库、再评估心情，两者常常是同一个时刻，
   * 所以「严格晚于上次评估」会把这一轮漏掉（夸奖要等下一拍才算），而「不早于」又会重复吸收。
   * 序号游标（`StoredMood.lastEventSequence`）把两件事分开了：时间只用于回落与时段，去重看序号。
   * 只有「家里一直没人」是当前观察、不是历史事件，所以它按「距上次评估真的过了时间」为条件，
   * 保证同一时刻的重复评估仍然什么都不做（幂等，见集成用例）。
   */
  #signalsSince(consumedSequence: number, availableSequence: number, at: Date): { readonly signals: MoodSignal[]; readonly cursor: number } {
    const settled = this.#settleCursor(consumedSequence, availableSequence, at);
    const { cursor, settledSequences } = settled;
    const settledSet = new Set(settledSequences);

    /** 这一拍能看见的事件：**已经被游标结算过**的那些。 */
    const isSettled = (sequence: number): boolean =>
      sequence > consumedSequence && sequence <= cursor && settledSet.has(sequence);

    const signals: MoodSignal[] = [];

    const userTurns: Date[] = [];
    for (const event of this.#store.readEvents({ type: 'conversation.turn', limit: Number.MAX_SAFE_INTEGER })) {
      const payload = event.payload as Record<string, unknown>;
      if (payload['role'] !== 'user') continue;
      const text = typeof payload['text'] === 'string' ? payload['text'] : '';
      const occurredAt = new Date(event.timestamp);
      if (!Number.isFinite(occurredAt.getTime())) continue;
      userTurns.push(occurredAt);
      if (!isSettled(event.sequence)) continue;
      const code = classifyMoodSignal(text);
      if (code === null) continue;
      signals.push({ code, at: event.timestamp, evidence: describeMoodSignal(code) });
    }

    for (const event of this.#store.readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })) {
      const payload = event.payload as Record<string, unknown>;
      if (payload['speak'] !== true) continue;
      const deliveredAt = new Date(event.timestamp);
      if (!Number.isFinite(deliveredAt.getTime())) continue;
      if (!(event.sequence <= cursor && settledSet.has(event.sequence))) continue;
      // 「有人接」还是「没人应」要等答案窗口关掉才结算（见 `#settleCursor`），所以到这里时它已经定了。
      const answered = userTurns.some(
        (turnAt) =>
          turnAt.getTime() > deliveredAt.getTime() &&
          turnAt.getTime() - deliveredAt.getTime() <= ANSWER_WINDOW_MINUTES * 60_000,
      );
      const code: MoodSignalCode = answered ? 'answered' : 'missed';
      const topicRef = typeof payload['topic_ref'] === 'string' ? payload['topic_ref'] : null;
      signals.push({
        code,
        at: event.timestamp,
        evidence: `${describeMoodSignal(code)}${topicRef === null ? '' : '（未完话题）'}`,
      });
    }

    for (const event of this.#store.readEvents({ type: 'presence.changed', limit: Number.MAX_SAFE_INTEGER })) {
      const payload = event.payload as Record<string, unknown>;
      if (payload['present'] !== true) continue;
      if (!isSettled(event.sequence)) continue;
      const occurredAt = new Date(event.timestamp);
      if (!Number.isFinite(occurredAt.getTime())) continue;
      signals.push({ code: 'arrived', at: event.timestamp, evidence: describeMoodSignal('arrived') });
    }

    // 「家里一直没人」：整整 EMPTY_HOUSE_HOURS 都没有用户轮次、也没有人在场 —— 每拍只记一条，
    // 而且是**当前**这一拍的观察（不是历史事件），所以它不进序号游标。条件是「距上次评估真的
    // 过了时间」，于是同一时刻的第二次评估不会把同一条观察再记一遍（幂等）。
    const stored = this.#store.mood();
    const beatAdvanced = stored?.lastBeatAt != null && Date.parse(stored.lastBeatAt) < at.getTime();
    if (beatAdvanced && this.#quietForHours(userTurns, at)) {
      signals.push({ code: 'quiet', at: toOffsetIso(at), evidence: describeMoodSignal('quiet') });
    }

    return {
      signals: signals.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)),
      cursor,
    };
  }

  /**
   * 这一拍能消费到哪一条事件（**连续前缀**），以及其中哪些是这一拍**新结算**的。
   *
   * 规则按事件类型分开，因为「什么时候才结算得了」不同：
   *   * 用户轮次、在场事件、以及不参与心情的事件类型：随时可结算；
   *   * 一次主动开口（`speak=true`）：要等**答案窗口关掉**才知道是「有人接」还是「没人应」。
   *
   * 游标只推进到第一个「结算不了」的事件之前，并且**在那一刻冻住**：后面的记录下一拍再看。
   * 这条规则是实测换来的 —— 先前按「这一拍碰到的最大序号」推进，结果 21:30 的主动开口在 21:32
   * 被跳过（那时它的答案窗口还开着）、22:05 再也补不出 `answered`；而「同一时刻重复评估」也
   * 会把同一条 `missed` 再吃一遍（幂等破坏）。
   */
  #settleCursor(
    consumedSequence: number,
    availableSequence: number,
    at: Date,
  ): { readonly cursor: number; readonly settledSequences: readonly number[] } {
    let cursor = consumedSequence;
    let frozen = false;
    const settledSequences: number[] = [];
    for (const event of this.#store.readEvents({ limit: Number.MAX_SAFE_INTEGER })) {
      if (event.sequence > availableSequence) break;
      if (event.sequence <= consumedSequence) continue;
      if (frozen) break;
      if (!this.#settles(event, at)) {
        frozen = true;
        break;
      }
      settledSequences.push(event.sequence);
      cursor = event.sequence;
    }
    return { cursor, settledSequences };
  }

  /** 一条事件现在结算得了吗（见 {@link #settleCursor}）。 */
  #settles(event: { readonly event_type: string; readonly timestamp: string; readonly payload: unknown }, at: Date): boolean {
    if (event.event_type !== 'proactive.decision') return true;
    const payload = event.payload as Record<string, unknown>;
    if (payload['speak'] !== true) return true;
    const deliveredAt = new Date(event.timestamp);
    if (!Number.isFinite(deliveredAt.getTime())) return true;
    // 答案窗口**闭区间**：`deliveredAt + 30min <= at` 就算关掉（那一分钟里没人回就是没人回）。
    return deliveredAt.getTime() + ANSWER_WINDOW_MINUTES * 60_000 <= at.getTime();
  }

  /** 这段时间里家里是不是一直安静（没有用户轮次，也没有人在场）。 */
  #quietForHours(userTurns: readonly Date[], at: Date): boolean {
    const boundary = at.getTime() - EMPTY_HOUSE_HOURS * 3_600_000;
    if (userTurns.some((turnAt) => turnAt.getTime() >= boundary)) return false;
    const presence = this.#store.worldState('presence.home', { now: toOffsetIso(at) });
    if (presence !== null && presence.present === true && !presence.stale) return false;
    return true;
  }
}

// ------------------------------------------------------------------ helpers

/** 心情距中性的有界偏移（`-1..1`）：引擎与提示词处理的是同一个量，不各算一份。 */
export function moodBiasOf(state: MoodState): number {
  return moodBias(state);
}

/** Hours between an ISO timestamp (or nothing) and `at`; never negative, never `NaN`. */
function elapsedHoursSince(lastBeatAt: string | null, at: Date): number {
  if (lastBeatAt === null) return 0;
  const previous = Date.parse(lastBeatAt);
  if (!Number.isFinite(previous)) return 0;
  const hours = (at.getTime() - previous) / 3_600_000;
  return Number.isFinite(hours) && hours > 0 ? hours : 0;
}

/** Local hour (0..23) for the time-of-day pull. */
function localHourOf(at: Date, offsetMinutes: number | undefined): number {
  const offset = offsetMinutes ?? -at.getTimezoneOffset();
  const shifted = new Date(at.getTime() + offset * 60_000);
  return shifted.getUTCHours();
}

function mergeEvidence(
  previous: Readonly<Partial<Record<string, number>>>,
  added: Readonly<Partial<Record<MoodSignalCode, number>>>,
): Readonly<Partial<Record<MoodSignalCode, number>>> {
  const merged: Partial<Record<MoodSignalCode, number>> = { ...(previous as Partial<Record<MoodSignalCode, number>>) };
  for (const [code, count] of Object.entries(added)) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
    merged[code as MoodSignalCode] = (merged[code as MoodSignalCode] ?? 0) + count;
  }
  return merged;
}

function dominantSignal(counts: Readonly<Partial<Record<MoodSignalCode, number>>>): MoodSignalCode | null {
  let best: MoodSignalCode | null = null;
  let bestCount = 0;
  for (const code of Object.keys(counts) as MoodSignalCode[]) {
    const count = counts[code] ?? 0;
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 一拍的摘要（面板与审计读它，不读原始计数）。
 *
 * `noSignals` 是「这一拍没有新信号」的意思：那时如果有位移，位移来自回落/时段牵引，
 * 摘要就该说「自然回落」而不是列一串空信号。
 */
function summarizeBeat(
  application: { readonly counts: Readonly<Partial<Record<MoodSignalCode, number>>>; readonly dropped: number },
  noSignals: boolean,
): string {
  const parts: string[] = [];
  for (const [code, count] of Object.entries(application.counts)) {
    parts.push(`${describeMoodSignal(code as MoodSignalCode)}×${String(count)}`);
  }
  if (parts.length === 0) parts.push(noSignals ? '没有新的信号，心情自然回落' : '没有新的信号');
  if (application.dropped > 0) parts.push(`还有 ${application.dropped} 条信号留到下一拍`);
  return parts.join('；');
}

/**
 * 心情对**语气**的缩放：`1 ± MOOD_TONE_SPAN`，中性时正好是 1。
 *
 * 这就是「轻微影响语气」的可核对版本：最大只有 6%，而人格对同一个量（`silence_tolerance`）
 * 的影响是 `0.5..1.5` 倍（±50%，见 `fsm.ts`）。所以心情永远盖不过人格 —— 这不是靠自觉，
 * 是两条公式的系数比。
 */
export const MOOD_TONE_SPAN = 0.06;

export function moodToneScale(bias: number): number {
  const safe = Number.isFinite(bias) ? Math.max(-1, Math.min(1, bias)) : 0;
  return 1 + safe * MOOD_TONE_SPAN;
}

/**
 * 心情对**主动性**的软偏移：最多 ±`MOOD_PROACTIVITY_NUDGE`（0.03）。
 *
 * 上限刻意取 §7.4 里「隐式反馈单次最多 ±0.03」——即心情的整幅影响力不超过人格能学习到的
 * 最小一步。它**只能**加在软评分/软阈值上：`proactive.ts` 的硬底线（静默时段、额度、隐私、
 * 场景与音频路径）在评分之前就已经返回，拿不到这个数。
 */
export const MOOD_PROACTIVITY_NUDGE = 0.03;

export function moodProactivityNudge(bias: number): number {
  const safe = Number.isFinite(bias) ? Math.max(-1, Math.min(1, bias)) : 0;
  return safe * MOOD_PROACTIVITY_NUDGE;
}
