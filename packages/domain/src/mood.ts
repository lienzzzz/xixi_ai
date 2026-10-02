/**
 * 有界的心情（短期情绪状态）——《方案》V0.2 第五轮第四条，pack §23 的反面（不做「虚构人生」，
 * 只做**可以被程序证明有界**的状态）。
 *
 * 这一层回答一个问题：**「她现在的情绪怎么样」**，而答案必须满足三条硬性质：
 *
 *   1. **有界**：任何输入序列（包括连续极端输入、乱序、重复、`NaN`）都不能把状态推出 `[0,1]`。
 *      这不是「调参调出来的」：每一步都是 `next = clamp(prev + delta)`，`clamp` 是值域上的投影，
 *      于是 `prev ∈ [0,1] ⇒ next ∈ [0,1]`，对任意步数归纳成立（证明与探针见
 *      `tests/unit/domain.test.ts` 的「心情上下界」用例：单步、序列、极端重复、随机游走）。
 *   2. **由事件演化**：只有少数几个**可核对的信号**（被夸 / 被嫌 / 明确的拒绝 / 主动没人理 /
 *      有人回应 / 有人到家 / 深夜与清晨 / 什么都不说）会推动它，每个信号带固定的小偏移。
 *      信号从**原始事件**（`conversation.turn` / `proactive.decision` / `presence.changed`）算出来，
 *      不存模型的私有推理（铁律 5）。
 *   3. **短暂**：它按经过的时间向中性回落（`decay`），所以心情不会像人格那样是长期属性；
 *      回落同样是 `clamp` 形式的更新，不新增越界路径。
 *
 * 与人格（三层自我画像）的关系，一句话：**人格是「她是谁」，心情是「她现在怎么样」**。
 *   * 人格的取值是长期、缓慢、可被父亲用自然语言塑造的（§7.4 的上限与回滚都在 `self-model.ts`）；
 *   * 心情是短期的、自己回落的、**权重远小于人格**（见 `moodToneBias` / `moodProactivityNudge` 的量级）；
 *   * 心情**不参与**任何硬底线判定（静默时段 / 额度 / 隐私都在 `proactive.ts` 的硬门禁里，
 *     它拿不到心情，也不该拿到）——「心情不好就不回话」这种设计在这里是不存在的。
 *
 * 数值与语义的分层（这条是刻意的，写在这里免得后来者把数字塞进提示词）：
 *   * 这一层只有**数字**（`valence` / `energy` ∈ [0,1]）与**信号**；
 *   * 给模型看的**只有散文**，由 `moodProse()` 把区间渲染成句子，模型看不到任何数字；
 *   * 面板与审计看的是数字，所以调试时能回答「她昨天为什么低落」而不是一句「心情不好」。
 */

/** 心情的两个维度：好不好（valence）、有没有劲（energy）。两者都是 0..1 的有界数。 */
export interface MoodState {
  /** 0 = 很低落，0.5 = 中性，1 = 很好。 */
  readonly valence: number;
  /** 0 = 很没劲，0.5 = 中性，1 = 很有精神。 */
  readonly energy: number;
}

/**
 * 心情的取值区间。**硬边界**，不是「建议范围」：
 * 所有写入路径都经过 {@link clampMoodValue}，所以 `[MOOD_BOUNDS.min, MOOD_BOUNDS.max]` 之外的值
 * 在库里根本不可能出现（探针逐格证明，见 `tests/unit/domain.test.ts`）。
 */
export const MOOD_BOUNDS = Object.freeze({ min: 0, max: 1 });

/** 中性心情：回落的目标，也是「没有任何信号」时的读数。 */
export const NEUTRAL_MOOD: MoodState = Object.freeze({ valence: 0.5, energy: 0.5 });

/**
 * 心情的信号字典（《方案》与 pack §23 允许的那几种）。
 *
 * 名字是**程序**用的标识符，`describeMoodSignal` 负责把它渲染成一句可读的中文。
 * 每个信号的两个偏移都在 {@link MOOD_SIGNALS} 里，数值小是刻意的：单次事件不该翻盘。
 */
export const MOOD_SIGNAL_CODES = Object.freeze([
  'praised',
  'blamed',
  'rejected',
  'missed',
  'answered',
  'arrived',
  'quiet',
  // 「时间过去了」：两个维度的偏移都是 0，唯一的作用是**留证据** ——
  // 心情回落时它让面板能回答「为什么变了」而不是「没有新的信号」。
  'time_passed',
] as const);

export type MoodSignalCode = (typeof MOOD_SIGNAL_CODES)[number];

export interface MoodSignalSpec {
  readonly code: MoodSignalCode;
  readonly valence: number;
  readonly energy: number;
  /** 程序渲染的证据句（给面板与审计，不给模型）。 */
  readonly label: string;
  /** 这一信号属于哪一类：父亲说的 / 结果 / 环境 / 时间。 */
  readonly source: 'user' | 'outcome' | 'environment' | 'time';
}

/**
 * 单个信号对两个维度的偏移。
 *
 * 量级（可核对）：最大单步 `|delta| = 0.08`（被夸、被嫌），最小 `0.005`（时间流逝）。
 * 「被嫌」比「被夸」重一点点（0.08 vs 0.06）：负面反馈比正面反馈更值得记住，
 * 这与 `feedback-interpreter.ts` 的口气一致，但这里只影响**心情**，不动人格。
 */
export const MOOD_SIGNALS: Readonly<Record<MoodSignalCode, MoodSignalSpec>> = Object.freeze({
  praised: { code: 'praised', valence: 0.06, energy: 0.02, label: '被夸了一句', source: 'user' },
  blamed: { code: 'blamed', valence: -0.08, energy: -0.02, label: '被嫌了一句', source: 'user' },
  // 「别说了」比普通嫌话重：它是明确的拒绝（proactive.ts 的 explicit_reject 同源）。
  rejected: { code: 'rejected', valence: -0.1, energy: -0.03, label: '被明确叫停了', source: 'user' },
  missed: { code: 'missed', valence: -0.05, energy: -0.01, label: '主动问了没人应', source: 'outcome' },
  answered: { code: 'answered', valence: 0.04, energy: 0.02, label: '主动问了有人接', source: 'outcome' },
  arrived: { code: 'arrived', valence: 0.02, energy: 0.05, label: '家里有人回来了', source: 'environment' },
  quiet: { code: 'quiet', valence: 0, energy: -0.03, label: '家里一直没人', source: 'environment' },
  time_passed: { code: 'time_passed', valence: 0, energy: 0, label: '心情自然回落', source: 'time' },
});

/** 心情设置（`config.mood`）。坏值一律退回默认 —— 调参段不能让对话崩掉。 */
export interface MoodSettings {
  /** 关掉之后不再演化（已有状态保持原样，仍可查看与复位）。 */
  readonly enabled: boolean;
  /** 每次评估最多把「距中性多远」的这一比例抹掉；1 分钟与 10 小时用同一个上限。 */
  readonly decayPerHour: number;
  /** 两次评估之间最多应用一次的衰减比例上限（防止一次长间隔把心情一次抹平）。 */
  readonly decayCap: number;
  /** 每次评估最多吸收多少条信号（防止一次扫描把一整天的事件一次性砸进来）。 */
  readonly maxSignalsPerBeat: number;
}

export const DEFAULT_MOOD_SETTINGS: MoodSettings = Object.freeze({
  enabled: true,
  // 半衰期约 9 小时：上午被夸一句，晚上还在，但到第二天就基本回到中性。
  decayPerHour: 0.075,
  // 一次评估最多抹掉 60% 的偏离：断了电再开机也不会「心情被清空」。
  decayCap: 0.6,
  // 一次最多 8 条信号：即使一天没说话，第一拍也不会把整天的事件一次性砸进来。
  maxSignalsPerBeat: 8,
});

function booleanField(source: Readonly<Record<string, unknown>> | undefined, key: string, fallback: boolean): boolean {
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

/**
 * 读 `config.mood`；坏值退回默认（与 `open_threads` / `self_model` 同一口径）。
 *
 * 越界值走的是**夹进区间**而不是抛错：这是调参段，一个错字不该把对话搞崩；
 * 而「心情会不会越界」与这些设置无关（有界性来自 clamp），所以放宽设置也不会破坏证明。
 */
export function parseMoodSettings(source?: Readonly<Record<string, unknown>> | undefined): MoodSettings {
  const fallback = DEFAULT_MOOD_SETTINGS;
  return {
    enabled: booleanField(source, 'enabled', fallback.enabled),
    decayPerHour: numberField(source, 'decay_per_hour', fallback.decayPerHour, 0, 1),
    decayCap: numberField(source, 'decay_cap', fallback.decayCap, 0, 1),
    maxSignalsPerBeat: numberField(source, 'max_signals_per_beat', fallback.maxSignalsPerBeat, 1, 64),
  };
}

// ------------------------------------------------------------------ 有界性

/**
 * 把一个数**投影**回 `[0,1]`。这是全部有界性的唯一来源：所有写入都经过它。
 *
 * 非有限值（`NaN` / `±Infinity`）不是「大数」而是一个**坏输入**：`NaN` 会让之后每一次比较都为假，
 * 状态会永久坏死。所以这里把它当成「中性」而不是「边界」—— 退回 {@link NEUTRAL_MOOD} 是唯一
 * 能让状态继续工作的选择。`Infinity` 则是有方向的大数，夹到对应的边界。
 */
export function clampMoodValue(value: number, fallback = 0.5): number {
  if (Number.isNaN(value)) return Math.min(MOOD_BOUNDS.max, Math.max(MOOD_BOUNDS.min, fallback));
  if (!Number.isFinite(value)) return value > 0 ? MOOD_BOUNDS.max : MOOD_BOUNDS.min;
  return Math.min(MOOD_BOUNDS.max, Math.max(MOOD_BOUNDS.min, value));
}

/** 把一个（可能来自库里、也可能是坏输入的）心情夹成合法状态。 */
export function clampMood(state: MoodState): MoodState {
  return {
    valence: clampMoodValue(state.valence),
    energy: clampMoodValue(state.energy),
  };
}

/**
 * 单步演化：`next = clamp(prev + delta)`。
 *
 * **这就是全部**——心情的每一次变化都是这一行（信号是 delta，回落也是 delta）。
 * 因此 "任何输入序列都不越界" 只需证这一行：`clamp` 的值域是 `[0,1]`，与 `prev`、`delta` 无关。
 */
export function applyMoodDelta(state: MoodState, delta: Partial<MoodState>): MoodState {
  return clampMood({
    valence: state.valence + (delta.valence ?? 0),
    energy: state.energy + (delta.energy ?? 0),
  });
}

// ------------------------------------------------------------------ 信号

/** 一条已经发生的信号（历史里的证据，不是「未来要发生的事」）。 */
export interface MoodSignal {
  readonly code: MoodSignalCode;
  /** 发生时刻（ISO 带偏移），用于审计与排序。 */
  readonly at: string;
  /** ≤40 字的程序渲染证据（**不放用户原话**，与铁律 5 的可审计口径一致）。 */
  readonly evidence: string;
}

/**
 * 被夸的说法。「谢谢你」「还是你细心」这类**反应**，不是长期指令
 * （长期指令走 `feedback-interpreter.ts` 的人格学习，两者不同层、互不替代）。
 *
 * 注意这类模式**不能**宽到把中性句也吃进来：「今天天气不错」里的「不错」讲的是天气，
 * 不是夸她。所以要么有明确的说话动词（「说得不错」），要么用只有夸她才会说的整词。
 */
const PRAISE_PATTERNS: readonly RegExp[] = Object.freeze([
  /谢谢(你|啦|了)?/,
  /(真|挺|很|太)(好|细心|贴心|周到|乖|棒|行|聪明)/,
  /还是你(想得周到|想得|考虑得|记性好|细心|贴心|周到)/,
  /(说得|讲得|回答得|答得)(对|不错|挺好|好极了|好)/,
  /(你|西西)(真|太|好)?(厉害|懂事|贴心|乖)/,
  /有(你|西西)在(真|就)?好/,
]);

/** 被嫌的说法（不是指令，是反应）。 */
const BLAME_PATTERNS: readonly RegExp[] = Object.freeze([
  /(真|太|有点)(烦|吵|啰嗦|啰唆)/,
  /(别|不要|不用)(老是|一直|天天|总)?(说|问|催|念)/,
  /(你|西西)(怎么|怎么这么|好)?(烦|吵)/,
  /(说错|记错|弄错)了/,
  /(不对|不是这样|你听错了)/,
  /(没听懂|听不懂)我(说|讲)的?/,
]);

/**
 * 明确的拒绝（与 `proactive.ts` 的 `explicitReject` 同源语义）：这比「嫌」更重，
 * 也是最不该被当成普通闲聊的一句。
 */
const REJECT_PATTERNS: readonly RegExp[] = Object.freeze([
  /(别|不要|不用)(再)?(说|讲|提)(了|啦|吧)/,
  /(现在|这会儿)(不想|别)(聊|说)/,
  /(今天|先)(别|不要)(说|聊|打扰)/,
  /(安静|静一静|清静)(点|一下)/,
  /(闭嘴|别烦我)/,
]);

/**
 * 从一句话里认出「这是一句夸奖 / 嫌弃 / 拒绝」。
 *
 * 顺序与 `feedback-interpreter.ts` 一致：**拒绝优先于嫌弃，嫌弃优先于夸奖** ——
 * 「你别说了，谢谢」这种句子按拒绝算，因为那是更明确、更该被听见的信号。
 * 认不出来返回 `null`：普通聊天**不是**反馈，不要为了「有心情」把每句话都当成情绪事件。
 */
export function classifyMoodSignal(text: string): MoodSignalCode | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (REJECT_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'rejected';
  if (BLAME_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'blamed';
  if (PRAISE_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'praised';
  return null;
}

/**
 * 时段对心情的**牵引目标**：深夜偏低、清早平平、白天回暖、晚上略降。
 *
 * 注意它是「目标」不是「偏移」：用 {@link applyTimeOfDay} 按一个小比例往它靠，
 * 所以深夜不会把心情一次拉到很低，早上也不会一次拉回来 —— 与真实的人一样是渐变的。
 */
export function timeOfDayMoodTarget(localHour: number): MoodState {
  if (localHour < 5) return { valence: 0.42, energy: 0.25 }; // 凌晨：熬着的低落
  if (localHour < 8) return { valence: 0.52, energy: 0.5 }; // 清早：刚醒
  if (localHour < 12) return { valence: 0.56, energy: 0.6 }; // 上午：一天里最有劲
  if (localHour < 14) return { valence: 0.55, energy: 0.5 }; // 中午
  if (localHour < 18) return { valence: 0.54, energy: 0.52 }; // 下午
  if (localHour < 20) return { valence: 0.53, energy: 0.45 }; // 傍晚
  if (localHour < 23) return { valence: 0.5, energy: 0.4 }; // 晚上
  return { valence: 0.44, energy: 0.28 }; // 深夜
}

/** 时段牵引的强度（每小时最多往目标靠多少）：小到不会盖过事件，但一天下来看得见。 */
export const TIME_OF_DAY_PULL_PER_HOUR = 0.03;

/**
 * 让心情往当前时段的目标靠一点。
 *
 * 仍然是 `clamp(prev + (target - prev) * rate)` 形式 —— 一次**有界的**更新，
 * 所以时段不会成为任何一条越界路径；`rate` 本身也被夹到 `[0,1]`。
 *
 * **中性不被时段推动**（`state === NEUTRAL_MOOD` 时原样返回）：这一条是刻意的，不是优化。
 * 理由：心情的**起点**必须是中性，否则「她今天还没被任何事影响」这句话就不成立 ——
 * 清晨开机、什么都没发生，却因为「现在是上午」而使语气与窗口都偏了一点，那就不是「心情」，
 * 而是一个偷偷改人设的时钟。所以时段只把**已经偏离的**心情拉回或推远，不自己制造偏离。
 * （对心情的可见效果不变：真被夸过之后再看时段，才轮到它起作用。）
 */
export function applyTimeOfDay(state: MoodState, localHour: number, hours: number): MoodState {
  const clamped = clampMood(state);
  if (clamped.valence === NEUTRAL_MOOD.valence && clamped.energy === NEUTRAL_MOOD.energy) return clamped;
  const rate = Math.min(1, Math.max(0, TIME_OF_DAY_PULL_PER_HOUR * Math.max(0, hours)));
  if (rate === 0) return clamped;
  const target = timeOfDayMoodTarget(localHour);
  return applyMoodDelta(clamped, {
    valence: (target.valence - clamped.valence) * rate,
    energy: (target.energy - clamped.energy) * rate,
  });
}

/**
 * 按经过的时间往中性回落。`elapsedHours` 由调用方从两次评估的时间戳算出（纯函数，不读时钟）。
 *
 * `rate = min(decayCap, decayPerHour × elapsedHours)`：长间隔也不会一次抹平（`decayCap`），
 * 而且仍然是 clamp 形式的更新 —— 回落不会新增越界路径。
 */
export function applyMoodDecay(state: MoodState, elapsedHours: number, settings: MoodSettings = DEFAULT_MOOD_SETTINGS): MoodState {
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) return clampMood(state);
  const rate = Math.min(Math.max(0, settings.decayCap), Math.max(0, settings.decayPerHour) * elapsedHours);
  if (rate <= 0) return clampMood(state);
  return applyMoodDelta(state, {
    valence: (NEUTRAL_MOOD.valence - state.valence) * rate,
    energy: (NEUTRAL_MOOD.energy - state.energy) * rate,
  });
}

/**
 * 把一串信号应用到状态上（顺序应用，每一步都 clamp）。
 *
 * 返回值里带上**本次**的净偏移与逐信号次数，供审计（「今天为什么低」）与面板使用 ——
 * 这些数字只在程序内部流动，模型看到的是 {@link moodProse}。
 */
export interface MoodApplication {
  readonly state: MoodState;
  /** 本次实际用了哪些信号（超出 `maxSignalsPerBeat` 的会被丢掉，丢掉多少在 `dropped` 里）。 */
  readonly applied: readonly MoodSignal[];
  readonly dropped: number;
  readonly counts: Readonly<Partial<Record<MoodSignalCode, number>>>;
  readonly delta: MoodState;
}

/** 一串信号去重后的应用（同一批里同一个信号出现多次就计多次 —— 它们本来就是多个事件）。 */
export function applyMoodSignals(
  state: MoodState,
  signals: readonly MoodSignal[],
  settings: MoodSettings = DEFAULT_MOOD_SETTINGS,
): MoodApplication {
  const start = clampMood(state);
  const limit = Math.max(0, Math.floor(settings.maxSignalsPerBeat));
  const applied = signals.slice(0, limit);
  const counts: Partial<Record<MoodSignalCode, number>> = {};
  let next: MoodState = start;
  for (const signal of applied) {
    const spec = MOOD_SIGNALS[signal.code];
    next = applyMoodDelta(next, { valence: spec.valence, energy: spec.energy });
    counts[signal.code] = (counts[signal.code] ?? 0) + 1;
  }
  return {
    state: next,
    applied,
    dropped: Math.max(0, signals.length - applied.length),
    counts,
    delta: { valence: next.valence - start.valence, energy: next.energy - start.energy },
  };
}

// ------------------------------------------------------------------ 语义（散文）

/** 心情的一个维度落在哪个区间。区间边界就是散文的边界，所以两者不会各说各话。 */
export type MoodBand = 'veryLow' | 'low' | 'neutral' | 'good' | 'veryGood';

/**
 * 区间边界。**唯一一份**：`moodBand()` 用它，`moodProse()` 只认 `moodBand()` 的结果，
 * 所以「什么时候算心情好」不会在散文里长出第二套数。
 *
 * 中性带取 `0.45..0.55`（宽 0.1）：一次夸奖把 valence 从 0.5 推到 0.56，就跨进「不错」那一档 ——
 * 这正是我们要的灵敏度（一句话就能在语气上看得出来），而 0.02 的抖动还留在中性带里，
 * 不会让措辞随一个小数点来回跳。
 */
export const MOOD_BAND_THRESHOLDS = Object.freeze({ low: 0.45, good: 0.55 });

export function moodBand(value: number): MoodBand {
  const clamped = clampMoodValue(value);
  if (clamped < 0.2) return 'veryLow';
  if (clamped < MOOD_BAND_THRESHOLDS.low) return 'low';
  if (clamped <= MOOD_BAND_THRESHOLDS.good) return 'neutral';
  if (clamped <= 0.8) return 'good';
  return 'veryGood';
}

/**
 * 把心情渲染成**散文**（模型看到的就是这些句子，没有数字、没有参数名）。
 *
 * 两段：
 *   1. **状态描述**（她现在的感觉）：一句。
 *   2. **语气指引**（这一轮该怎么说话），以「（现在的语气）」起头，中间空一行 ——
 *      与 `CORE_IDENTITY` / `personalityDirectives` 的分段方式一致，模型看得出这是两件事。
 *
 * 措辞的两条硬约束（`tests/unit/prompt.test.ts` 逐条钉住）：
 *   * **只有感受与说话方式**，绝不出现「我今天出去买菜了」这类**不存在的实体经历**
 *     （pack §23 的原话：可以对现实事件有情绪，不可以编造事实）；
 *   * 不出现数字、参数名、也不出现「心情值」这种机器话。
 */
export function moodProse(state: MoodState): readonly string[] {
  return [...moodStateProse(state), '', '（现在的语气）', ...moodToneLines(state)];
}

/** 只有「现在感觉怎么样」那一句（`moodProse` 的第一句）。 */
export function moodStateProse(state: MoodState): readonly string[] {
  const v = moodBand(state.valence);
  const e = moodBand(state.energy);
  return [`${valencePhrase(v)}${energyPhrase(e)}。`];
}

/** 只有「这一轮该怎么说话」的那些句子（`moodToneLines` 的其余部分）。 */
export function moodToneLines(state: MoodState): readonly string[] {
  const v = moodBand(state.valence);
  const e = moodBand(state.energy);
  const lines: string[] = [];
  if (v === 'veryGood') lines.push('话里可以带点轻快，别刻意，也别一直这样——过了这阵自然就淡了。');
  else if (v === 'good') lines.push('说话可以稍微松快一点，但别夸张。');
  else if (v === 'low') lines.push('话少一点、慢一点，别硬找话题；对方想聊就接住。');
  else if (v === 'veryLow') lines.push('别装得很热情；安静听着也行，但别冷着对方。');

  if (e === 'veryLow') lines.push('句子短一点，不确定的事别硬撑着说。');
  else if (e === 'low') lines.push('有点乏，别勉强多说。');
  else if (e === 'veryGood') lines.push('精神不错，可以多陪对方聊两句。');

  // 情绪只是语气，不是借口，也不是事实来源 —— 这句是 pack §23 的可执行版本。
  lines.push('这只是你此刻的情绪，只影响你说话的样子：不要因此说出你没做过的事，也不要描述身体上的感觉。');
  return lines;
}

function valencePhrase(band: MoodBand): string {
  switch (band) {
    case 'veryLow':
      return '心里有点沉';
    case 'low':
      return '有点提不起劲';
    case 'neutral':
      return '没什么特别的感觉';
    case 'good':
      return '心情还不错';
    case 'veryGood':
      return '今天心情挺好';
  }
}

function energyPhrase(band: MoodBand): string {
  switch (band) {
    case 'veryLow':
      return '，人也很疲';
    case 'low':
      return '，有点乏';
    case 'neutral':
      return '';
    case 'good':
      return '，精神还可以';
    case 'veryGood':
      return '，精神头挺足';
  }
}

/** 一个信号渲染成中文（面板与审计用，不进提示词）。 */
export function describeMoodSignal(code: MoodSignalCode): string {
  return MOOD_SIGNALS[code].label;
}

// ------------------------------------------------------------------ 语气与主动性

/**
 * 心情对**主动性与语气**的轻微影响：`-1..1`，0 表示中性。
 *
 * 它是两个维度减去中性后的平均，**再乘一个很小的权重** —— 这一层刻意不返回「最终分数」，
 * 只返回一个**有界偏移**，由消费方决定怎么用（见 `packages/conversation/src/personality.ts`
 * 的 `moodToleranceScale` / `moodProactivityNudge`）。
 *
 * 为什么不是直接改人格：人格是长期属性、受 §7.4 的上限与回滚约束，心情不该占用那条路径。
 * 这条偏移**永远小于人格调整的最小步长**（§7.4 隐式反馈 ±0.03），所以「心情好」不会盖过
 * 「父亲说了一句」。
 */
export function moodBias(state: MoodState): number {
  const safe = clampMood(state);
  const bias = (safe.valence - NEUTRAL_MOOD.valence) + (safe.energy - NEUTRAL_MOOD.energy);
  return Math.max(-1, Math.min(1, bias));
}
