/**
 * 三层自我画像（pack Phase 4 / 《方案》§7 §13）：BaseProfile + LearnedProfile + SessionOverride = EffectiveProfile。
 *
 * 为什么要分三层，而不是直接改一个数：
 *
 *   * **基础**（`self_profile`）来自配置或管理员，是「出厂/运维」的事实；
 *   * **学习**（`self_profile_learned`）是父亲用自然语言调出来的累计偏移 —— 它必须**可回滚**、
 *     有来源、有证据（§7.4/§7.5），所以单独一层、单独历史；
 *   * **会话覆盖**（`session_overrides`）只对**当天的本地自然日**生效：「今天想安静点」不该变成
 *     「以后都安静」。次日自动失效（没有定时任务，读取时按 `valid_day` 过滤）。
 *
 * 上限来自《方案》§7.4，写在这里而不是散在各调用点：
 *   * 明确长期指令：一次最大 ±0.15；
 *   * 隐式/推断反馈：单次最多 ±0.03（多次再累计）；
 *   * 学习层累计漂移上限 ±0.30 —— 不允许单次抱怨把属性拉到极端；
 *   * 会话覆盖单次最大 ±0.35（它本来就是「今天特殊」）。
 * 单日上限按**净变化**算：同一属性一天之内的累计偏移不超过 ±0.15（推断是 ±0.03）。
 *
 * 权重（`SELF_MODEL_SOURCE_WEIGHTS`）是「显式纠正的权重高于模型推断」这句话的可执行版本：
 * 同一句输入里，显式规则与推断规则都命中同一个属性时，**只取显式**（推断被丢弃，不是叠加）——
 * 这条优先级在 `packages/conversation/src/feedback-interpreter.ts` 里落实。
 */

import { clampPersonality, personalityProperty } from './personality.ts';
import { type SelfProfileChange, type XixiStore } from './store.ts';

/** 一个偏移是谁给的。 */
export const SELF_MODEL_SOURCES = Object.freeze(['explicit_correction', 'model_inference', 'admin'] as const);
export type SelfModelSource = (typeof SELF_MODEL_SOURCES)[number];

/** 可信度权重：显式纠正 1.0，模型推断 0.4（铁律 4）。 */
export const SELF_MODEL_SOURCE_WEIGHTS: Readonly<Record<SelfModelSource, number>> = Object.freeze({
  explicit_correction: 1,
  model_inference: 0.4,
  admin: 1,
});

/** 基础层没种过这个属性、但学习/覆盖层提到了它时用的中性值。 */
export const NEUTRAL_PROFILE_VALUE = 0.5;

export interface SelfModelSettings {
  /** 关掉之后不再学习（已有偏移保持原样，可回滚）。 */
  readonly learningEnabled: boolean;
  /** 明确长期指令单日累计上限（《方案》§7.4：一次最大 ±0.15）。 */
  readonly dailyLimitExplicit: number;
  /** 推断/隐式反馈单日累计上限（§7.4：单次最多 ±0.01~0.03）。 */
  readonly dailyLimitInferred: number;
  /** 学习层累计漂移上限（不允许单次抱怨把属性拉到极端）。 */
  readonly driftLimit: number;
  /** 会话覆盖单次上限。 */
  readonly sessionOverrideLimit: number;
}

export const DEFAULT_SELF_MODEL_SETTINGS: SelfModelSettings = Object.freeze({
  learningEnabled: true,
  dailyLimitExplicit: 0.15,
  dailyLimitInferred: 0.03,
  driftLimit: 0.3,
  sessionOverrideLimit: 0.35,
});

/** 读 `config.self_model`；坏值退回默认（调参段不能让对话崩掉）。 */
export function parseSelfModelSettings(
  source?: Readonly<Record<string, unknown>> | undefined,
): SelfModelSettings {
  const fallback = DEFAULT_SELF_MODEL_SETTINGS;
  return {
    learningEnabled: booleanField(source, 'learning_enabled', fallback.learningEnabled),
    dailyLimitExplicit: numberField(source, 'daily_limit_explicit', fallback.dailyLimitExplicit, 0, 0.5),
    dailyLimitInferred: numberField(source, 'daily_limit_inferred', fallback.dailyLimitInferred, 0, 0.5),
    driftLimit: numberField(source, 'drift_limit', fallback.driftLimit, 0, 1),
    sessionOverrideLimit: numberField(source, 'session_override_limit', fallback.sessionOverrideLimit, 0, 1),
  };
}

export interface LearnedDelta {
  readonly property: string;
  /** 累计偏移（不是单次）。 */
  readonly delta: number;
  readonly sourceType: string;
  /** 程序渲染的证据（哪条规则、哪次反馈），不是用户原话。 */
  readonly evidence: string | null;
  readonly confidence: number;
  readonly updatedAt: string;
}

export interface SessionOverride {
  readonly overrideId: string;
  readonly sessionId: string | null;
  readonly property: string;
  readonly delta: number;
  readonly reason: string;
  readonly sourceType: string;
  /** 本地自然日 `YYYY-MM-DD`：只有这一天生效。 */
  readonly validDay: string;
  readonly createdAt: string;
}

export interface LearnedDeltaInput {
  readonly property: string;
  /** 名义偏移（调用方按规则给），本方法负责权重、单日上限与漂移上限。 */
  readonly delta: number;
  readonly sourceType: SelfModelSource;
  readonly evidence?: string | null | undefined;
  readonly confidence?: number | undefined;
  readonly at?: Date | undefined;
  /** 这条反馈来自哪条事件（写进 history，可回到日志核对）。 */
  readonly sourceEventId?: string | null | undefined;
}

export interface LearnedDeltaResult {
  readonly property: string;
  /** 学习层在这一层里的累计值（改前 / 改后）。 */
  readonly before: number;
  readonly after: number;
  /** 真正落库的偏移（可能被单日上限或漂移上限削减）。 */
  readonly applied: number;
  readonly clampedByDailyLimit: boolean;
  readonly clampedByDriftLimit: boolean;
  /** 改完之后的**有效值**（三层相加），面板与测试看的是它。 */
  readonly effective: number;
}

export interface SessionOverrideInput {
  readonly deltas: Readonly<Record<string, number>>;
  readonly reason: string;
  readonly sourceType: SelfModelSource;
  readonly sessionId?: string | null | undefined;
  readonly at?: Date | undefined;
}

/** 本地自然日 `YYYY-MM-DD`（与 proactive.ts 的 `localDayOf` 同一口径：读本地日历字段）。 */
export function localDayOf(at: Date): string {
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * 三层相加并夹进属性范围。
 *
 * 只返回**至少有一层提到过**的属性：基础层没有、学习层也没有的属性不会凭空出现（否则
 * 「她怎么突然有了一个没人设过的性格值」就没有答案）。
 */
export function effectivePersonality(
  base: Readonly<Record<string, number>>,
  learned: readonly LearnedDelta[],
  overrides: readonly SessionOverride[],
): Record<string, number> {
  const learnedMap = new Map(learned.map((entry) => [entry.property, entry.delta]));
  const overrideMap = new Map<string, number>();
  for (const override of overrides) {
    overrideMap.set(override.property, (overrideMap.get(override.property) ?? 0) + override.delta);
  }
  const properties = new Set<string>([...Object.keys(base), ...learnedMap.keys(), ...overrideMap.keys()]);
  const effective: Record<string, number> = {};
  for (const property of [...properties].sort()) {
    if (personalityProperty(property) === undefined) continue;
    const value =
      (base[property] ?? NEUTRAL_PROFILE_VALUE) + (learnedMap.get(property) ?? 0) + (overrideMap.get(property) ?? 0);
    // 四舍五入到 4 位：审计与测试里不该出现 0.09999999999999999 这种浮点噪声。
    effective[property] = round4(clampPersonality(property, value));
  }
  return effective;
}

/**
 * 自我画像的读写门面（同 `OpenThreadStore`：不打开 SQLite，只翻译领域动作）。
 */
export class SelfModel {
  readonly #store: XixiStore;
  readonly #settings: SelfModelSettings;

  constructor(store: XixiStore, settings: SelfModelSettings = DEFAULT_SELF_MODEL_SETTINGS) {
    this.#store = store;
    this.#settings = settings;
  }

  get settings(): SelfModelSettings {
    return this.#settings;
  }

  learned(): LearnedDelta[] {
    return this.#store.learnedDeltas();
  }

  /** 今天生效的会话覆盖（传 `at` 可以问「那一天」）。 */
  overrides(at: Date = this.#store.clock()): SessionOverride[] {
    return this.#store.sessionOverrides({ day: localDayOf(at) });
  }

  /** 有效人格（三层相加）。 */
  effective(at: Date = this.#store.clock()): Record<string, number> {
    return this.#store.selfProfile({ now: at });
  }

  history(property?: string): SelfProfileChange[] {
    return this.#store.selfProfileHistory(property);
  }

  /**
   * 学习一次反馈。
   *
   * 顺序即规则：**权重 → 单日上限 → 漂移上限**。每一步削减都如实回报
   * （`clampedByDailyLimit` / `clampedByDriftLimit`），并且每次真的改了值就写一条 history（§7.5），
   * 所以「她怎么变成现在这样的」永远可以逐条回放；history 里的 before/after 是**有效值**
   * （面板与用户看到的那两个数），而单日上限的统计只看 `learned:*` 那些行的差值。
   */
  learn(input: LearnedDeltaInput): LearnedDeltaResult {
    const at = input.at ?? this.#store.clock();
    if (personalityProperty(input.property) === undefined) {
      throw new Error(`"${input.property}" is not a self-model property`);
    }
    const current = this.#store.learnedDelta(input.property)?.delta ?? 0;
    const before = this.#effectiveValue(input.property, at);
    const noop = (clampedByDailyLimit = false, clampedByDriftLimit = false): LearnedDeltaResult => ({
      property: input.property,
      before: current,
      after: current,
      applied: 0,
      clampedByDailyLimit,
      clampedByDriftLimit,
      effective: before,
    });

    if (!this.#settings.learningEnabled) return noop();

    const weight = SELF_MODEL_SOURCE_WEIGHTS[input.sourceType];
    const nominal = input.delta * weight;
    const dailyLimit =
      input.sourceType === 'model_inference' ? this.#settings.dailyLimitInferred : this.#settings.dailyLimitExplicit;
    // 单日上限按**净变化**算（同一属性一天之内的累计偏移不超过 ±dailyLimit）：
    // 连着抱怨同一个方向会被削（保护「不允许单次抱怨把属性拉到极端」），
    // 而方向相反的两次调整（先说「主动一点」、后说「话太多」）各自算得清。
    const appliedToday = this.#appliedToday(input.property, input.sourceType, at);
    const targetNet = Math.max(-dailyLimit, Math.min(dailyLimit, appliedToday + nominal));
    const afterDaily = round4(targetNet - appliedToday);
    const clampedByDailyLimit = Math.abs(afterDaily - nominal) > 1e-9;

    const driftLimit = this.#settings.driftLimit;
    const target = current + afterDaily;
    const clamped = round4(Math.max(-driftLimit, Math.min(driftLimit, target)));
    const clampedByDriftLimit = Math.abs(target) > driftLimit + 1e-9;
    const applied = round4(clamped - current);
    if (Math.abs(applied) < 1e-9) return noop(clampedByDailyLimit, clampedByDriftLimit);

    this.#store.writeLearnedDelta(input.property, clamped, {
      sourceType: `learned:${input.sourceType}`,
      evidence: input.evidence ?? null,
      confidence: input.confidence ?? weight,
    });
    const effectiveAfter = this.#effectiveValue(input.property, at);
    this.#store.recordSelfProfileChange({
      property: input.property,
      before,
      after: effectiveAfter,
      sourceType: `learned:${input.sourceType}`,
      summary: `${input.evidence ?? '反馈学习'}：${input.property} 学习偏移 ${applied >= 0 ? '+' : ''}${applied}（累计 ${clamped}）`,
      confidence: input.confidence ?? weight,
      sourceEventId: input.sourceEventId ?? null,
    });
    return {
      property: input.property,
      before: current,
      after: clamped,
      applied,
      clampedByDailyLimit,
      clampedByDriftLimit,
      effective: effectiveAfter,
    };
  }

  /**
   * 「今天想安静点」：写会话覆盖，**只对今天生效**（次日自动恢复）。
   *
   * 同一天同一属性重复说，只保留一条（重复说「今天安静点」不该把偏移叠成 −0.7）。
   */
  overrideToday(input: SessionOverrideInput): SessionOverride[] {
    const at = input.at ?? this.#store.clock();
    const day = localDayOf(at);
    const written: SessionOverride[] = [];
    for (const [property, nominal] of Object.entries(input.deltas)) {
      if (personalityProperty(property) === undefined) {
        throw new Error(`"${property}" is not a self-model property`);
      }
      const limit = this.#settings.sessionOverrideLimit;
      const delta = round4(Math.max(-limit, Math.min(limit, nominal)));
      const before = this.#effectiveValue(property, at);
      this.#store.clearSessionOverride({ property, day, sessionId: input.sessionId ?? null });
      written.push(
        this.#store.insertSessionOverride({
          property,
          delta,
          reason: input.reason,
          sourceType: `session_override:${input.sourceType}`,
          sessionId: input.sessionId ?? null,
          validDay: day,
        }),
      );
      const after = this.#effectiveValue(property, at);
      this.#store.recordSelfProfileChange({
        property,
        before,
        after,
        sourceType: `session_override:${input.sourceType}`,
        summary: `${input.reason}（只对 ${day} 生效，次日自动恢复）`,
        confidence: SELF_MODEL_SOURCE_WEIGHTS[input.sourceType],
      });
    }
    return written;
  }

  /** 可回滚：把某一属性学习到的偏移清零（写 history 行，历史不删）。 */
  rollback(property: string, reason = 'admin:rollback'): LearnedDeltaResult {
    const at = this.#store.clock();
    const current = this.#store.learnedDelta(property)?.delta ?? 0;
    const before = this.#effectiveValue(property, at);
    if (Math.abs(current) > 1e-9) {
      this.#store.writeLearnedDelta(property, 0, { sourceType: 'learned:rollback', evidence: reason, confidence: 1 });
      this.#store.recordSelfProfileChange({
        property,
        before,
        after: this.#effectiveValue(property, at),
        sourceType: 'learned:rollback',
        summary: `${reason}：清零学习到的 ${property} 偏移 ${current}`,
        confidence: 1,
      });
    }
    return {
      property,
      before: current,
      after: 0,
      applied: round4(-current),
      clampedByDailyLimit: false,
      clampedByDriftLimit: false,
      effective: this.#effectiveValue(property, at),
    };
  }

  /**
   * 取消某属性**今天**的会话覆盖（返回取消了几条）。
   *
   * 用在「面板/CLI 明确改了人格」这条路径上：操作者现在把 talkativeness 调到 0.7，就该是 0.7 ——
   * 今天早些时候口头的「安静点」在**这一个属性**上被更明确的设置取代（其它属性上的覆盖保留）。
   */
  clearTodayOverride(property: string, at: Date = this.#store.clock()): number {
    return this.#store.clearSessionOverride({ property, day: localDayOf(at) });
  }

  #effectiveValue(property: string, at: Date): number {
    return this.#store.selfProfile({ now: at })[property] ?? NEUTRAL_PROFILE_VALUE;
  }

  /**
   * 反向换算：要让**有效值**（面板上显示的那个数）等于 `target`，基础层该写多少。
   *
   * 为什么需要它：控制台的人格控件读写的是有效值，而 `overrideSelfProfile` 写的是基础层。
   * 学习层里有 −0.12 时，若把 0.70 直接写进基础层，有效值会变成 0.58 —— 学习偏移被叠加两次。
   */
  baseValueFor(property: string, target: number, at: Date = this.#store.clock()): number {
    const learned = this.#store.learnedDelta(property)?.delta ?? 0;
    const override = this.overrides(at)
      .filter((entry) => entry.property === property)
      .reduce((sum, entry) => sum + entry.delta, 0);
    return round4(clampPersonality(property, target - learned - override));
  }

  /** 今天已经学进去多少（按来源、按符号），用来算单日净变化上限：只看 `learned:<source>` 那些行的差值。 */
  #appliedToday(property: string, sourceType: SelfModelSource, at: Date): number {
    const day = localDayOf(at);
    const prefix = `learned:${sourceType}`;
    let total = 0;
    for (const change of this.#store.selfProfileHistory(property)) {
      if (change.sourceType !== prefix) continue;
      if (change.beforeValue === null) continue;
      if (localDayOf(new Date(change.createdAt)) !== day) continue;
      total += change.afterValue - change.beforeValue;
    }
    return round4(total);
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function booleanField(
  source: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

function numberField(
  source: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = source?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
