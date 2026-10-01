/**
 * 话题引擎（TopicEngine，pack Phase 3 / 《方案》§9 §10）。
 *
 * 它回答一个问题：**「西西惦记着什么、现在该不该提」**，而且答案全部来自可核对的事实 ——
 * 用户自己说过的轮次（`conversation.turn`）与程序记下的话题状态（`open_thread.changed`），
 * 没有一句话是模型编的（铁律 1/5）。
 *
 * 三个动作，按发生顺序：
 *
 *   1. **提取**（`extractOpenThreads`）：从用户的一轮话里认出「将来要做的一件事」，纯规则、可单测。
 *      认出「明天下午我要去镇上办证」→ 明天 14:00 之后可以问，48 小时后过期。
 *   2. **对齐**（`reconcile`）：把日志与话题表对齐 —— 主动问过了就是 `offered`；在那之后用户**答的是那件事**
 *      才按回答收口（`resolved`/`snoozed`/`engaged`，**收口后不再重复问**）；说别的事不算回答，
 *      话题留在 `offered`，过一阵子（`reofferAfterMinutes`）还能在窗口内再问一次；过了追问窗口或试过太多次
 *      就是 `exhausted`。对齐是幂等的：同一条日志重放多少次，结果都一样。
 *   3. **出候选**（`followUps`）：到点、还没收口的那些，变成主动开口的候选，交给既有的
 *      `ProactiveEngine`（分数、硬门禁、读空气都在那边，这里不重复实现）。
 *
 * 与 `packages/conversation/src/proactive.ts` 的分工：那边管「能不能说、该不该说」，这里管「有什么可说」。
 */

import { toOffsetIso } from '@xixi/contracts';
import {
  normalizeThreadSummary,
  OpenThreadStore,
  OPEN_THREAD_SETTLED_STATUSES,
  systemClock,
  threadIdFromSourceEvent,
  type Clock,
  type NewOpenThread,
  type OpenThread,
  type XixiStore,
} from '@xixi/domain';

import { readTopicHistory, TopicHistory, topicOfferedWithin, type TopicHistoryEntry } from './topic-history.ts';

// ------------------------------------------------------------------ topic shape

/**
 * 话题的来源（《方案》§9 的 `TopicCandidate.source`）。
 *
 * Phase 3 只实现 `open_thread` —— 其余来源（新闻/日历/共同记忆…）要么属于别的阶段，要么在仓库里
 * 还没有事实来源。**声明了却没有生产者，就等于撒谎**，所以这里不假装它们已经能用：
 * 只有 `open_thread` 会被 `TopicEngine` 产出，其余取值留作契约，等有事实来源再实现。
 */
export const TOPIC_SOURCES = Object.freeze([
  'open_thread',
  'recent_event',
  'shared_memory',
  'current_activity',
  'interest',
  'news',
  'weather',
  'calendar',
  'generic',
] as const);

export type TopicSource = (typeof TOPIC_SOURCES)[number];

/** 一个可以聊的话题（《方案》§9）：带分数与新鲜度，不是一句话。 */
export interface TopicCandidate {
  readonly id: string;
  readonly source: TopicSource;
  /** 一句话说清这是什么（页面上显示；也是 `fact` 的标题）。 */
  readonly title: string;
  /** 提议怎么开口（可交给模型润色，但内容必须来自 `title`/`hook`）。 */
  readonly hook: string;
  /** 来源优先级分（pack §9：OpenThread 1.00，随机闲聊 0.10）。 */
  readonly score: number;
  readonly freshness: number;
  readonly personalRelevance: number;
  readonly interruptCost: number;
  readonly requiresTool?: string | undefined;
  /** 过了这一刻这个话题就不该再提（毫秒时间戳）。 */
  readonly expiresAt?: number | undefined;
}

// -------------------------------------------------------------------- settings

export interface TopicEngineSettings {
  /** 关掉之后不再提取、不再出候选（库里的历史话题保持不变）。 */
  readonly enabled: boolean;
  /** 一次追问没人回答之后，隔多久才允许再问一次。 */
  readonly reofferAfterMinutes: number;
  /** 同一件事最多主动问几次（超过就 `exhausted`，不再打扰）。 */
  readonly maxAttempts: number;
  /** 追问窗口：`followAfter` 之后这么久还没收口就作废。 */
  readonly followupWindowHours: number;
  /** 同一话题重复出现在候选里的抑制窗口（话题去重）。 */
  readonly topicDedupeHours: number;
}

/**
 * 工厂默认值，与 `config/xixi.example.yaml` 的 `open_threads` 段逐字对应
 * （一个测试比较两者，免得又出现「文档说 3 小时、代码是 6 小时」）。
 */
export const DEFAULT_TOPIC_ENGINE_SETTINGS: TopicEngineSettings = Object.freeze({
  enabled: true,
  reofferAfterMinutes: 180,
  maxAttempts: 2,
  followupWindowHours: 48,
  topicDedupeHours: 12,
});

/** 读 `config.open_threads`；坏值退回默认（这是调参段，不能让一个错字把对话搞崩）。 */
export function parseTopicEngineSettings(
  source?: Readonly<Record<string, unknown>> | undefined,
): TopicEngineSettings {
  const fallback = DEFAULT_TOPIC_ENGINE_SETTINGS;
  return {
    enabled: booleanField(source, 'enabled', fallback.enabled),
    reofferAfterMinutes: numberField(source, 'reoffer_after_min', fallback.reofferAfterMinutes, 1, 24 * 60),
    maxAttempts: numberField(source, 'max_attempts', fallback.maxAttempts, 1, 10),
    followupWindowHours: numberField(source, 'followup_window_h', fallback.followupWindowHours, 1, 24 * 30),
    topicDedupeHours: numberField(source, 'topic_dedupe_h', fallback.topicDedupeHours, 0, 24 * 30),
  };
}

// ------------------------------------------------------------------ extraction

/** 一套「将来的事」的说法：口语里能认出来的时间词。 */
const DAY_MARKERS: readonly { readonly pattern: RegExp; readonly dayOffset: number }[] = Object.freeze([
  { pattern: /大后天/, dayOffset: 3 },
  { pattern: /后天/, dayOffset: 2 },
  { pattern: /明天|明日|明早|明晚/, dayOffset: 1 },
  { pattern: /下个星期|下星期|下周/, dayOffset: 7 },
  { pattern: /今晚|今天晚上|今天|待会儿|一会儿/, dayOffset: 0 },
]);

const HOUR_MARKERS: readonly { readonly pattern: RegExp; readonly hour: number }[] = Object.freeze([
  { pattern: /早上|早晨|一早/, hour: 8 },
  { pattern: /上午/, hour: 9 },
  { pattern: /中午/, hour: 12 },
  { pattern: /下午/, hour: 14 },
  { pattern: /傍晚|日落/, hour: 18 },
  { pattern: /晚上|夜里|晚点/, hour: 19 },
]);

/**
 * 「打算做点什么」的说法。必须是**意愿**，不是随口的将来时 ——
 * 「明天会下雨吗」里有时间词，但没有意愿，不该记成一件没办完的事。
 */
const INTENTION_MARKERS = /我要|我得|我得去|我打算|我准备|我计划|我想去|需要去|要去|得去|打算|准备|计划|约了|约好/;

/** 能构成「一件事」的动词/场景。没有它，光有意愿也不记（「我要是明天有空…」不是一件事）。 */
const ACTION_MARKERS =
  /去|办|证|看|见|拿|买|取|交|修|做|开会|出差|上班|复诊|体检|看病|住院|聚会|上课|考试|面试|搬家|寄|还|请|签|接|送|参加|报名/;

/** 从意愿词后面抽出的动作短语（「明天下午我**要去镇上办证**」→「去镇上办证」）。 */
const SUBJECT_PATTERN = /(?:我要|我得|我打算|我准备|我计划|我要去|要去|得去|打算|准备|计划|约了|约好)([^。！？!?；;]{2,40})/;

export interface ExtractOpenThreadInput {
  readonly text: string;
  /** 说这句话的时刻（用来算 `followAfter`）。 */
  readonly at: Date;
  /** 这句话所在轮次的事件 id：thread id 由它推出，所以重放不会多出一条话题。 */
  readonly sourceEventId: string;
  readonly settings?: TopicEngineSettings | undefined;
}

/**
 * 从一轮用户的话里抽出「没办完的事」。**纯函数**：同样的输入永远得到同样的输出。
 *
 * 认不出来的情况（绝大多数）返回空数组 —— 「没有合适的话题就不要开口」同样适用于记忆：
 * 宁可什么都不记，也不要记错一件父亲根本没说过的事。
 */
export function extractOpenThreads(input: ExtractOpenThreadInput): NewOpenThread[] {
  const settings = input.settings ?? DEFAULT_TOPIC_ENGINE_SETTINGS;
  if (!settings.enabled) return [];
  const summary = normalizeSummary(input.text);
  if (summary.length < 4) return [];
  const day = DAY_MARKERS.find((marker) => marker.pattern.test(summary));
  if (day === undefined) return [];
  if (!INTENTION_MARKERS.test(summary)) return [];
  if (!ACTION_MARKERS.test(summary)) return [];

  const hour = HOUR_MARKERS.find((marker) => marker.pattern.test(summary))?.hour ?? (day.dayOffset === 0 ? 19 : 9);
  const followAfter = atLocalDayHour(input.at, day.dayOffset, hour);
  const expireAt = new Date(followAfter.getTime() + settings.followupWindowHours * 60 * 60 * 1000);
  const subject = subjectOf(summary);
  return [
    {
      threadId: threadIdFromSourceEvent(input.sourceEventId),
      summary,
      subject,
      followAfter: toOffsetIso(followAfter),
      expireAt: toOffsetIso(expireAt),
      followUpHint: followUpHintFor(summary, subject),
      importance: importanceOf(summary),
      sourceEventId: input.sourceEventId,
      createdAt: toOffsetIso(input.at),
      note: `从用户 ${toOffsetIso(input.at)} 的轮次里提取`,
    },
  ];
}

/** 追问的短句：程序按模板渲染（不是模型写的），所以「她为什么问这句」可以回到摘要核对。 */
export function followUpHintFor(summary: string, subject: string | null): string {
  const what = subject ?? snippetOf(summary);
  return `你之前说过要${what}，后来怎么样了？`;
}

function subjectOf(text: string): string | null {
  const match = SUBJECT_PATTERN.exec(text);
  if (match === null) return null;
  const subject = (match[1] ?? '').trim().replace(/[。！？!?，,；;、\s]+$/u, '');
  return subject.length >= 2 ? subject : null;
}

function snippetOf(text: string, max = 24): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function importanceOf(text: string): number {
  // 跟证件、身体、约好的事有关 → 更值得惦记（《方案》§10 的 `importance`）。
  return /办|证|医院|复诊|体检|看病|住院|开会|面试|考试|交|取|签|约/.test(text) ? 0.85 : 0.6;
}

function normalizeSummary(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[。！？!?]+$/u, '').slice(0, 120);
}

/**
 * `base` 本地日的第 N 天、`hour` 点。
 *
 * 本机时区就是家里的时区（《方案》§42 `identity.timezone` = Asia/Shanghai，现场设备与开发机一致），
 * 所以用 `Date` 的本地字段算「明天下午两点」；仓库里所有本地时间判定（`localMinutesOf`、
 * `localDayOf`）都是这个口径 —— 要换时区应当整体改口径，而不是在这里单独加偏移。
 */
function atLocalDayHour(base: Date, dayOffset: number, hour: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0);
}

// ------------------------------------------------------------------- answers

/** 用户对追问的回应落成哪种收口。 */
export type ThreadAnswerKind = 'resolved' | 'snoozed' | 'engaged';

const NOT_DONE_YET = /还没|还没有|没有办|没办|没去|没弄|没做|没来得及|来不及|没成|改天|再说|晚点|过两天|下周再|明天再|暂时|放弃|不去了|不办了|算了/;
const DONE = /办好了|办完了|办下来了|办妥了|搞定了|弄好了|弄完了|完成了|结束了|拿到了|已经办|已经去|已经弄|已经拿|已经交|都办了|妥了|好了/;

/**
 * 「办好了」这类回答把话题收口成 `resolved`；「还没办」收口成 `snoozed`（**不再追问** ——
 * 追着问没办完的事是打扰，不是惦记）；其余有关这件事的回答是 `engaged`。
 *
 * 三种都是**收口**：被回应之后不再重复问，这是 Phase 3 的验收要求。
 *
 * 它**只看这一轮话本身**：这句话是不是在回答「那件事」由 {@link isAnswerAboutThread} 先判
 * （`reconcile` 里两者配合 —— 先过相关性门槛，再在这里分三种收口）。
 */
export function classifyThreadAnswer(text: string): ThreadAnswerKind {
  const trimmed = text.trim();
  if (NOT_DONE_YET.test(trimmed)) return 'snoozed';
  if (DONE.test(trimmed)) return 'resolved';
  return 'engaged';
}

/**
 * 时间词：说明「什么时候」，不说明「哪件事」。比对相关性前先从话题文本里去掉 ——
 * 否则「今天天气不错啊」会靠一个「天」字粘上「明天去办证」。
 */
const TOPIC_TIME_WORDS =
  /(?:大后天|后天|明天|明日|明早|明晚|下个星期|下星期|下周|今晚|今天晚上|今天|待会儿|一会儿|早上|早晨|一早|上午|中午|下午|傍晚|日落|晚上|夜里|晚点|时候|时间|点钟)/gu;

/**
 * 换个话题也照样出现的字：人称、虚词、语气词、量词，以及「去/来/上/到」这类只表示位移的字。
 * 它们单独出现说明不了「在说那件事」（「去」在「去散步」里也有），所以不算**信号字**。
 */
const TOPIC_GENERIC_CHARS = new Set([
  ...'我你他她它你们的了是有在要得想会能就都也还不好很太再又只把被给让跟和与或而但如果这那哪谁什么怎样为因所以上下来到过走进回出起个点些一二三几多少事儿子时候号天',
]);

/**
 * 这一轮话是不是在回答「那件事」。
 *
 * 只看**字面证据**（铁律 1：判断由规则做、可复算，不需要模型理解）：
 *
 *   1. 强证据：回答里出现话题的**信号字** —— `subject`（没有就用 `summary`）去掉时间词、
 *      人称与虚词之后剩下的字（「去镇上办证」→ 镇/办/证）。
 *   2. 弱证据：回答是**答复形状**（「办好了」/「还没办」这两组收口模板，与 `classifyThreadAnswer`
 *      用的是同一组词），并且命中的那几个字里有一个是话题里的字 —— 「没去成，改天再说吧。」
 *      没有「证」字，但它确实在回答这件事。
 *
 * 两条都不成立就是**不相关**：他只是接着聊别的（「今天天气不错啊。」），不是回答。
 *
 * 边界（如实记下，不假装它是理解）：字面证据不是语义理解 —— 一句同样带「去」的答复形状的话
 * （「我今天没去散步。」）会被算作相关；反过来只说「算了」而一个字都不提话题的回答不会被算作回答。
 * 前者的代价是话题收口、后者的代价是过一阵子再问一次，都比「他随口聊了句天气就静默丢一件事」轻。
 */
export function isAnswerAboutThread(thread: Pick<OpenThread, 'summary' | 'subject'>, text: string): boolean {
  const answer = text.trim();
  if (answer.length === 0) return false;

  const topicChars = [...new Set([...(thread.subject ?? thread.summary).replace(TOPIC_TIME_WORDS, '')])];
  if (topicChars.some((char) => !TOPIC_GENERIC_CHARS.has(char) && answer.includes(char))) return true;

  const template = NOT_DONE_YET.exec(answer) ?? DONE.exec(answer);
  if (template === null) return false;
  const hit = template[0];
  return topicChars.some((char) => hit.includes(char));
}

// ------------------------------------------------------------------ follow-ups

/** 一条「该追问了」的候选事实（由 `TopicEngine.followUps` 产出）。 */
export interface OpenThreadFollowUp {
  readonly threadId: string;
  readonly summary: string;
  readonly subject: string | null;
  /** 兜底要说的话（模型不可用时就是它）。 */
  readonly line: string;
  /** 这条凭什么说：来源摘要 + 第几次追问 + 状态。 */
  readonly fact: string;
  readonly topicRef: string;
  readonly importance: number;
  readonly attempts: number;
  readonly createdAt: string;
  readonly followAfter: string | null;
  /** 过了这一刻就不再提这件事（`open_threads.expire_at`）。 */
  readonly expireAt: string | null;
}

/**
 * 未完话题在**社会预算**里的信号（pack §14.2 的六项正分）。
 *
 * 依据是 pack §9 的来源优先级：OpenThread 排第一（1.00），比「刚发生的生活事件」还高 ——
 * 因为这件事是父亲**自己说的**、而且还没办完。新鲜度只有 0.7：不是刚发生的事，是记着的事。
 * 互动热度（engagement）给 0.6：这是她主动起的话题，不是顺着热聊接话。
 */
export function openThreadFollowUpComponents(): Readonly<Record<string, number>> {
  return Object.freeze({
    topic_quality: 0.95,
    personal_relevance: 0.95,
    freshness: 0.7,
    receptivity: 0.85,
    engagement: 0.6,
  });
}

// -------------------------------------------------------------------- engine

export interface TopicEngineOptions {
  readonly store: XixiStore;
  /** `config.xixi.open_threads`，原样传进来即可。 */
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  /** 已解析的设置，优先于 `config`（测试与重放用）。 */
  readonly settings?: TopicEngineSettings | undefined;
  readonly clock?: Clock | undefined;
}

export interface ReconcileResult {
  /** 这次新提取出来的话题。 */
  readonly created: readonly OpenThread[];
  /** 这次从日志里确认「已经主动说过」的话题。 */
  readonly offered: readonly OpenThread[];
  /** 这次被用户回应收口的话题（含收口状态）。 */
  readonly settled: readonly OpenThread[];
  /** 这次作废的话题（过了窗口或试过太多次）。 */
  readonly expired: readonly OpenThread[];
  /**
   * 追问之后用户说了话、但那一轮与话题对不上（见 `isAnswerAboutThread`）：**不写事件、不算收口**，
   * 只列出来供核对「为什么这件事还开着」。同一轮次会在每次对齐里重新算一次（无状态、幂等）。
   */
  readonly ignored: readonly IgnoredThreadTurn[];
}

/** 追问之后与话题对不上的一轮话（它可能是聊天，也可能是在说别的事）。 */
export interface IgnoredThreadTurn {
  readonly threadId: string;
  /** 那一轮是什么时候说的。 */
  readonly at: string;
  /** 那一轮说的话（裁剪到 30 字，与收口 `note` 同一口径）。 */
  readonly text: string;
}

export interface TopicEngineStatus {
  readonly threads: readonly OpenThreadView[];
  readonly candidates: readonly TopicCandidate[];
  readonly history: readonly TopicHistoryEntry[];
}

/** 面板上的一条未完话题：状态 + 上一次问过之后他的反应（来自话题历史）。 */
export interface OpenThreadView extends OpenThread {
  readonly lastOutcome: TopicHistoryEntry['outcome'] | null;
}

/**
 * 话题引擎。它的每个方法都是**幂等**的：重复调用不会重复写事件、不会重复出候选。
 */
export class TopicEngine {
  readonly #store: XixiStore;
  readonly #threads: OpenThreadStore;
  readonly #history: TopicHistory;
  readonly #settings: TopicEngineSettings;
  readonly #clock: Clock;

  constructor(options: TopicEngineOptions) {
    this.#store = options.store;
    this.#threads = new OpenThreadStore(options.store);
    this.#history = new TopicHistory(options.store);
    this.#settings = options.settings ?? parseTopicEngineSettings(options.config);
    this.#clock = options.clock ?? systemClock;
  }

  get settings(): TopicEngineSettings {
    return this.#settings;
  }

  get threads(): OpenThreadStore {
    return this.#threads;
  }

  /** 话题历史（哪些话题说过、反应如何）—— 日志的一个视图，没有自己的表。 */
  get history(): TopicHistory {
    return this.#history;
  }

  /**
   * 把日志与话题表对齐（提取 → 确认已说过 → 收口 → 作废/允许再问一次）。
   *
   * 生产路径在常驻考虑循环的每一次 tick 里调用它（`scripts/field-test.ts` 的
   * `readOpenThreads`），所以「用户昨天说的那件事」会在下一次考虑时变成候选，不阻塞任何一次回复
   * （《方案》§11.1：提取是异步的）。
   */
  reconcile(now: Date = this.#clock()): ReconcileResult {
    const created: OpenThread[] = [];
    const offered: OpenThread[] = [];
    const settled: OpenThread[] = [];
    const expired: OpenThread[] = [];
    const ignored: IgnoredThreadTurn[] = [];
    if (!this.#settings.enabled) return { created, offered, settled, expired, ignored };

    const turns = readUserTurns(this.#store);

    // 1) 提取。thread id 由轮次事件 id 推出 → 同一轮次重放多少次都只是同一条（幂等）。
    for (const turn of turns) {
      for (const draft of extractOpenThreads({ text: turn.text, at: turn.at, sourceEventId: turn.eventId, settings: this.#settings })) {
        const change = this.#threads.create(draft);
        if (change.created) created.push(change.thread);
      }
    }

    // 2) 确认「已经主动问过」：日志里真的说出口、且带着这个话题的主动记录。
    for (const delivery of readThreadDeliveries(this.#store)) {
      const thread = this.#store.openThread(delivery.topicRef);
      if (thread === null) continue;
      if (OPEN_THREAD_SETTLED_STATUSES.includes(thread.status)) continue;
      if (thread.lastOfferedAt !== null && Date.parse(thread.lastOfferedAt) >= delivery.at.getTime()) continue;
      const change = this.#store.transitionOpenThread(thread.threadId, 'offered', {
        at: delivery.at,
        offered: true,
        note: `主动追问了（${delivery.candidateId}）`,
      });
      if (change !== null) offered.push(change.thread);
    }

    // 3) 收口：问过之后用户**真的答了那件事**。**收口之后不再重复问**（三种收口都算回应过）。
    //
    // 不是「追问之后他说的第一句话」就算回答：他可能只是接着聊别的（「今天天气不错啊。」）。
    // 把那种轮次当成回答，会让这件事被静默收口、第二天再也不问（t7 评审 T7-F1）；
    // 所以他说的每一轮都要先过 `isAnswerAboutThread` 这道字面证据门槛，只有对得上的那一轮才收口，
    // 对不上的记进 `ignored`（不写事件）。话题因此留在 `offered` —— 第 4 步会在
    // `reofferAfterMinutes` 之后把它放回候选，于是同一件事在这个窗口内还能再问一次，
    // 问够 `maxAttempts` 次仍然作废（不会没完没了地问）。
    //
    // 也认「已经回到候选、但这次还没被再问出去」的话题（`candidate` + `lastOfferedAt`）：
    // 他可能在回到候选之后、真的被再问一次之前就把事情答了（再问会被硬门禁 / 静默时段推迟），
    // 那时候不该再问第二遍。
    for (const thread of this.#store.openThreads({ status: ['candidate', 'offered'] })) {
      const offeredAt = thread.lastOfferedAt;
      if (offeredAt === null) continue;
      const after = turns.filter((turn) => turn.at.getTime() > Date.parse(offeredAt));
      if (after.length === 0) continue;
      const answer = after.find((turn) => isAnswerAboutThread(thread, turn.text));
      if (answer === undefined) {
        for (const turn of after) {
          ignored.push({ threadId: thread.threadId, at: toOffsetIso(turn.at), text: snippetOf(turn.text, 30) });
        }
        continue;
      }
      const kind = classifyThreadAnswer(answer.text);
      const change = this.#store.transitionOpenThread(thread.threadId, kind, {
        at: answer.at,
        note: `用户回答：${snippetOf(answer.text, 30)}`,
      });
      if (change !== null) settled.push(change.thread);
    }

    // 4) 作废与「允许再问一次」。
    const nowMs = now.getTime();
    for (const thread of this.#store.openThreads({ status: ['candidate', 'offered'] })) {
      if (thread.expireAt !== null && Date.parse(thread.expireAt) <= nowMs) {
        const change = this.#store.transitionOpenThread(thread.threadId, 'exhausted', {
          at: now,
          note: '过了追问窗口，没人回应',
        });
        if (change !== null) expired.push(change.thread);
        continue;
      }
      if (thread.status !== 'offered' || thread.lastOfferedAt === null) continue;
      const waited = nowMs - Date.parse(thread.lastOfferedAt);
      if (waited < this.#settings.reofferAfterMinutes * 60_000) continue;
      if (thread.attempts >= this.#settings.maxAttempts) {
        const change = this.#store.transitionOpenThread(thread.threadId, 'exhausted', {
          at: now,
          note: `问过 ${thread.attempts} 次都没得到回答`,
        });
        if (change !== null) expired.push(change.thread);
        continue;
      }
      // 没得到回答（没人回应，或他说的是别的事）、还没问够 → 回到候选，允许过一阵子再问一次
      // （`attempts` 记着问过几次）。
      this.#store.transitionOpenThread(thread.threadId, 'candidate', {
        at: now,
        note: `追问没得到回答，${this.#settings.reofferAfterMinutes} 分钟后可再问一次`,
      });
    }

    return { created, offered, settled, expired, ignored };
  }

  /**
   * 现在「该追问」的候选（到点、还没收口、且不在去重窗口里）。
   *
   * 注意它**不做判定**：说不说、什么时候说由 `ProactiveEngine` 的硬门禁与社会预算决定
   * （铁律 3、ADR-0011）。这里只是把「有件事可以问」摆出来。
   */
  followUps(now: Date = this.#clock()): OpenThreadFollowUp[] {
    if (!this.#settings.enabled) return [];
    const dedupeMinutes = this.#settings.topicDedupeHours * 60;
    const history = dedupeMinutes > 0 ? this.#history.entries() : [];
    const all = this.#threads.list({ limit: 200 });
    const followUps: OpenThreadFollowUp[] = [];
    for (const thread of this.#threads.due(now)) {
      // 话题去重：**同一件事**如果在窗口内已经被主动说过（哪怕它是由另一条话题记录承载的 ——
      // 例如上次那条已经收口、用户又提了一次而新建了一条），就不再重复摆出来。
      // 注意只比「别的话题」，同一条话题自己的重试由 `reoffer_after_min` 与 `max_attempts` 管。
      if (dedupeMinutes > 0) {
        const normalized = normalizeThreadSummary(thread.summary);
        const repeated = all.some(
          (other) =>
            other.threadId !== thread.threadId &&
            normalizeThreadSummary(other.summary) === normalized &&
            topicOfferedWithin(history, other.threadId, now, dedupeMinutes) !== null,
        );
        if (repeated) continue;
      }
      const line = thread.followUpHint ?? `你之前说过的「${snippetOf(thread.summary)}」，后来怎么样了？`;
      followUps.push({
        threadId: thread.threadId,
        summary: thread.summary,
        subject: thread.subject,
        line,
        fact: `未完话题（pack Phase 3）：${thread.summary}｜记于 ${thread.createdAt}｜${
          thread.attempts === 0 ? '第一次问' : `第 ${thread.attempts + 1} 次问`
        }`,
        topicRef: thread.threadId,
        importance: thread.importance,
        attempts: thread.attempts,
        createdAt: thread.createdAt,
        followAfter: thread.followAfter,
        expireAt: thread.expireAt,
      });
    }
    return followUps;
  }

  /** 《方案》§9 形状的话题候选（Phase 3 只有 `open_thread` 这一个来源）。 */
  topicCandidates(now: Date = this.#clock()): TopicCandidate[] {
    return this.followUps(now).map((followUp) => ({
      id: followUp.threadId,
      source: 'open_thread' as const,
      title: followUp.summary,
      hook: followUp.line,
      // pack §9 的优先级表：OpenThread 1.00（排第一），随机闲聊 0.10。
      score: 1,
      freshness: 0.5,
      personalRelevance: followUp.importance,
      interruptCost: 0.3,
      ...(followUp.expireAt === null ? {} : { expiresAt: Date.parse(followUp.expireAt) }),
    }));
  }

  /** 控制台面板用：现在存着哪些话题、哪些该问了、说过的话题后来怎么样（全部来自日志与表）。 */
  statusReport(now: Date = this.#clock()): TopicEngineStatus {
    const history = this.#history.entries();
    return {
      threads: this.#threads.list({ limit: 50 }).map((thread) => ({
        ...thread,
        lastOutcome: this.#history.outcome(thread.threadId),
      })),
      candidates: this.topicCandidates(now),
      history: history.slice(-20),
    };
  }
}

// ------------------------------------------------------------------ log reads

interface UserTurn {
  readonly eventId: string;
  readonly at: Date;
  readonly text: string;
}

/** 所有带正文的用户轮次，按日志顺序。 */
function readUserTurns(store: XixiStore): UserTurn[] {
  const turns: UserTurn[] = [];
  for (const event of store.readEvents({ type: 'conversation.turn', limit: Number.MAX_SAFE_INTEGER })) {
    const payload = event.payload as Record<string, unknown>;
    if (payload['role'] !== 'user') continue;
    const text = typeof payload['text'] === 'string' ? payload['text'].trim() : '';
    if (text.length === 0) continue;
    const at = new Date(event.timestamp);
    if (!Number.isFinite(at.getTime())) continue;
    turns.push({ eventId: event.event_id, at, text });
  }
  return turns;
}

interface ThreadDelivery {
  readonly at: Date;
  readonly topicRef: string;
  readonly candidateId: string;
}

/** 日志里「真的说出口、而且带着话题」的主动记录。 */
function readThreadDeliveries(store: XixiStore): ThreadDelivery[] {
  const deliveries: ThreadDelivery[] = [];
  for (const event of store.readEvents({ type: 'proactive.decision', limit: Number.MAX_SAFE_INTEGER })) {
    const payload = event.payload as Record<string, unknown>;
    if (payload['speak'] !== true) continue;
    const topicRef = payload['topic_ref'];
    if (typeof topicRef !== 'string' || !topicRef.startsWith('thread_')) continue;
    const at = new Date(event.timestamp);
    if (!Number.isFinite(at.getTime())) continue;
    deliveries.push({
      at,
      topicRef,
      candidateId: typeof payload['candidate_id'] === 'string' ? payload['candidate_id'] : '?',
    });
  }
  return deliveries;
}

// ------------------------------------------------------------------ helpers

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
