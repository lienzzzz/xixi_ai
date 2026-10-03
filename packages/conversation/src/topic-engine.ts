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

import { TopicHistory, topicOfferedWithin, type TopicHistoryEntry } from './topic-history.ts';

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
 * 换一件事也照样出现的常用动词：「去 / 来 / 走 / 做 / 买 / 看 / 吃 / 拿 / 说 / 放」……
 *
 * 它们**单独**出现说明不了「在说那件事」：「我去楼下买了点水果。」里有「买」，
 * 「老李家的孙子回来了。」里有「看」在别处，都只是在聊别的。所以它们**不能**当收口依据。
 *
 * 这是 t7 评审 T7-R1/R2 与 t8 记下的两条残余（ADR-0012「判据升级」段）两次实测的共同教训：
 * 「去」是位移字，「买 / 看 / 吃 / 拿」只是通用动词 —— 真正能区分「那件事」的是**对象**
 * （药 / 证 / 孙子 / 材料），不是这些谁都能用的动词。
 */
const FRAME_WORDS = new Set<string>([
  ...'去来往走做弄搞说讲问吃喝拿着放想会能要得把给让跟和与或而但的了是有在就都也还不好很太再又只被这那哪谁什么怎样因为所以上下里外到过进出起开用完别没',
  // 「买」也是通用动词：买药 / 买水果 / 买菜 / 买票……换一件事照样出现，单独出现说明不了在说那件事
  // （t8 残余的两条误收口里就有一条是「买」）。
  '买',
]);

/**
 * 话题里可能出现的**具体东西**（对象词）：药、证、孙子、材料、电视……
 *
 * 对象词是判据的主力：**说了那件东西，才算在说那件事**。
 *   * 「明天我要去买药。」的话题下，「我去楼下买了点水果。」不带「药」→ 不算回答（t8 记下的那条残余）；
 *   * 「办证」这类**动宾复合词**（办 + 证）整体登记为对象词，于是「办好了」「还没办」照旧算回答
 *     —— 它们是「办证」的一部分，不是「拿一个通用动词蒙过去」。
 *
 * 这份清单是**受控词表**（铁律 1：规则由程序负责），不是分词器：仓库里没有词典依赖，也不该为
 * 一条收口判据引入一个（铁律 12）。代价写在 ADR-0012「判据升级 §代价与已知边界」：**没登记进来的
 * 名词等于没有对象词** —— 那时判据退回它下面的动作词规则（与 t7 之后的行为一致，不会比字级更糟）。
 */
const OBJECT_WORDS: readonly string[] = Object.freeze([
  // 证件与手续（动宾复合词「办证」整体登记，见上：它让「办好了」「还没办」照旧算回答）
  '身份证', '医保卡', '办证', '证', '材料', '手续', '证明',
  // 身体与看病
  '社区医院', '医院', '复诊', '体检', '住院', '挂号', '看病', '药',
  // 家里的物件（「理发」也是动宾复合词）
  '电视', '被子', '衣服', '戏', '照片', '报纸', '理发',
  // 吃的
  '水果', '面条', '豆腐', '鸡蛋', '牛奶', '排骨', '菜', '油', '米', '面', '肉', '饭',
  // 家里的人
  '小孙子', '孙子', '孙女', '老伴', '儿子', '女儿', '孩子', '娃',
]);

/**
 * 话题里可能出现的**有辨识度的动作**：办 / 取 / 交 / 签 / 修 / 接 / 送 / 洗……
 *
 * 它们只在**两种**情况下算数（见 `isAnswerAboutThread`）：话题里压根没有对象词，或者对象词带着
 * 「不在回答那件事」的标记。像「办好了」这种不含对象词的真回答就是靠这里过线的。
 *
 * 与 {@link FRAME_WORDS} 的分界是**可核对**的：`FRAME_WORDS` 里的动词在换一件事时也照旧出现
 * （买药 / 买水果 / 看电视 / 看孙子），这里的动词则指向具体的手续或家务。
 */
const ACTION_WORDS: readonly string[] = Object.freeze([
  '挂号', '复诊', '看病', '体检', '住院', '理发', '报名',
  '办', '修', '交', '缴', '取', '领', '签', '寄', '接', '送', '洗', '晒', '浇', '种', '喂', '收', '记', '约', '请',
  '借',
  // 上面的长词在匹配时优先（「复诊」比「诊」准），`wordsIn` 按长度降序。
  // 通用动词（去 / 来 / 买 / 拿 / 看 / 吃 / 还 / 做 / 弄…）不在这里：编进 `FRAME_WORDS`，
  // 而 `assertVocabularyShape()` 会在启动时把「放错表」报出来。
]);

/**
 * 「别人家的东西」的写法：那种回答即便撞上了同一个对象词，说的也不是**他**那件事
 * （ADR-0012 的第二个残余：「老李家的孙子回来了。」不是「我去看孙子」的回答）。
 *
 * 只在**对象词已经对上**之后才查它，所以不会误伤「我家的孙子挺好的」这类真回答。
 * 「我家 / 咱家 / 俺家」等第一人称不在表里；否定式「不在家 / 没在家」描述的是行踪，也不在表里
 * （`不在家` 里「家」前面是「不」，`老李家的` 前面是姓氏或「隔壁」）。
 */
const OTHER_OWNER_PATTERN = /(?:[老小]?[叫姓张李王刘陈杨赵黄周吴徐孙马胡郭林何高罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤]家|隔壁|邻居|人家)/u;

/** 词表按长度降序排一次的缓存（词表是常量，没必要每次判定都重排）。 */
const sortedCache = new WeakMap<readonly string[], readonly string[]>();

/**
 * 三张表的**关系**必须成立，否则静默退化（加了词却没人用）。
 *
 *   * `FRAME_WORDS` 与 `OBJECT_WORDS` / `ACTION_WORDS` **不相交** —— 一个词不能既被当成「换一件事也照样
 *     出现的通用动词」又被当成收口依据（这正是「买」踩过的坑）；
 *   * `OBJECT_WORDS` 与 `ACTION_WORDS` **允许重合**：「复诊」「理发」「看病」本身就是动宾复合词，
 *     既是那件事、也是那个动作，两边都登记是对的；
 *   * 表里没有空串、没有重复。
 *
 * 在模块加载时**跑一次**（失败就抛，等于启动即崩）：这样上面那张「通用动词」清单是**真的在把关**，
 * 而不是一段写着好看、其实没人读的注释。加词时如果放错表，这里立刻报出来。
 */
function assertVocabularyShape(): void {
  const tables: readonly (readonly [string, readonly string[]])[] = [
    ['OBJECT_WORDS', OBJECT_WORDS],
    ['ACTION_WORDS', ACTION_WORDS],
  ];
  for (const [name, words] of tables) {
    const seen = new Set<string>();
    for (const word of words) {
      if (word.length === 0) throw new Error(`${name} 里有空词`);
      if (seen.has(word)) throw new Error(`${name} 里有重复词：${word}`);
      seen.add(word);
      if (FRAME_WORDS.has(word)) throw new Error(`${word} 既在 FRAME_WORDS 里又在 ${name} 里`);
    }
  }
}

assertVocabularyShape();

/** 话题里出现过的字（去掉时间词之后）——守卫判定「这轮话有没有把话题里没有的东西换进来」时用。 */
function charsOf(text: string): Set<string> {
  return new Set([...text]);
}

function sortedVocabulary(vocabulary: readonly string[]): readonly string[] {
  const cached = sortedCache.get(vocabulary);
  if (cached !== undefined) return cached;
  const sorted = [...vocabulary].sort((left, right) => right.length - left.length);
  sortedCache.set(vocabulary, sorted);
  return sorted;
}

/** `haystack` 里有没有 `needle`（子串，按词表逐词比 —— 判据是「词/对象」，不是「字」）。 */
function containsWord(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

/** 一个片段里出现的**对象词**（长词优先：`办证` 命中就不再单独记 `证`）。 */
export function objectWordsIn(text: string): string[] {
  return wordsIn(text, OBJECT_WORDS).map((match) => match.word);
}

/** 一个片段里出现的**动作词**（长词优先，同上）。 */
export function actionWordsIn(text: string): string[] {
  return wordsIn(text, ACTION_WORDS).map((match) => match.word);
}

/**
 * 这个词是不是**通用动词**（换一件事也照样出现，不能当收口依据）。
 *
 * 收口判据不直接用这个函数（它靠词表本身的成员资格），导出是为了让测试能把「`买`/`拿` 这类词
 * 不许进动作表」这条关系**显式**钉住，而不是靠一条注释。
 */
export function isFrameWord(word: string): boolean {
  return FRAME_WORDS.has(word);
}

function wordsIn(text: string, vocabulary: readonly string[]): readonly WordMatch[] {
  const matches: WordMatch[] = [];
  const covered: string[] = [];
  // 词表按长度降序（`sortedVocabulary`），所以先命中的一定是最长的词形。
  for (const word of sortedVocabulary(vocabulary)) {
    if (!containsWord(text, word)) continue;
    // 已经被更长的词形盖住了（命中「办证」之后的「证」）：它不是独立证据，但也**确实被说了**，
    // 所以照样挂到覆盖它的长词下（见 `covered`）。
    if (covered.includes(word)) continue;
    // 后面那些更短的词表项只要是这个词的一部分，就不再单独成条 —— 判定只看「说到没说到」，
    // 而「说了『办证』」同时意味着「说了『证』」（`covered` 里记下来）。
    for (const shorter of sortedVocabulary(vocabulary)) {
      if (shorter.length >= word.length) continue;
      if (word.includes(shorter) && containsWord(text, shorter) && !covered.includes(shorter)) covered.push(shorter);
    }
    matches.push({ word, covered: [] });
  }
  // 回头把「被覆盖」的短词挂到覆盖它的长词上：判定「回答有没有说到话题里那件东西」时，
  // 「办证」这个话题遇到「证已经拿到了」也算说到（见 `topicFormMatches` / `formsOf`）。
  return matches.map((match) => ({
    word: match.word,
    covered: covered.filter((word) => word !== match.word && match.word.includes(word)),
  }));
}

/** 一个片段里说到的一个词：`word` 本身，以及被它以更长词形盖住的 `covered`（「办证」`covered` = 「证」）。 */
interface WordMatch {
  readonly word: string;
  readonly covered: readonly string[];
}

/**
 * 这一轮话是不是在回答「那件事」。
 *
 * 判据是**词 / 对象**级（t8 之后本轮升级；旧版是「字」级，见 ADR-0012「已知残余」）：
 * 只看字面证据、纯函数、可复算（铁律 1），但比对的单位是**词**，不是「碰巧共享的一个字」。
 *
 * 三步，按顺序：
 *
 *   1. **对象词**：话题（`subject`，没有就用 `summary`，去掉时间词）里有对象词时，回答必须带上
 *      其中之一 —— 说了那件东西才算在说那件事。「明天我要去买药。」的话题下「我去楼下买了点水果。」
 *      不带「药」→ 不算回答（t8 的 1/13）。
 *   2. **别人家的**：对象词对上了，但回答把它放进「别人的」框里（「老李家的孙子回来了。」「隔壁老王家
 *      孙子回来了。」），而话题里没有这个框 → 不算回答（t8 的另一个 1/13）。要过这一关，回答得同时
 *      说得出话题的动作（「看」）才行。
 *   3. **动作词**：话题里没有对象词时（「明天我要去」这种极罕见的情况），退回到比对有辨识度的动作词
 *      （办 / 取 / 交 / 修 / 洗……），**通用动词不算**（`FRAME_WORDS`：去 / 来 / 买 / 看 / 吃 / 拿…）。
 *
 * 取舍与边界（已实测，探针表见 tests/unit/core/topic-engine.test.ts）：
 *   * 不相关的话**永远不会**关掉话题：它们进 `ReconcileResult.ignored`，话题保持 `offered`；
 *   * 反过来，**没有提到那件事**的真回答（「没去成，改天再说吧。」「不去了」）也不算回答：
 *     话题留在窗口里，`reofferAfterMinutes` 之后可以再问一次 —— 而且还要过主动引擎的硬门禁与
 *     社会预算，不是一定会开口。这是**有意**的取舍：多问一次是有界、看得见的，静默丢掉一件事是无界的；
 *   * 话题里一个对象词、一个动作词都没有时（「明天我要去」这种，极罕见）没有回答能收口它，
 *     只能等到过期 —— 宁可多问一次，也不要靠一个「去」字猜；
 *   * 词表是**受控清单**：新出现的名词若没登记，等于没有对象词（退回第 3 步）。加词是改词表，
 *     不是改判定逻辑；探针表（同一份测试文件）是加词之后的回归依据。
 */
export function isAnswerAboutThread(thread: Pick<OpenThread, 'summary' | 'subject'>, text: string): boolean {
  const answer = text.trim();
  if (answer.length === 0) return false;

  const topicText = (thread.subject ?? thread.summary).replace(TOPIC_TIME_WORDS, '');
  const topicObjects = wordsIn(topicText, OBJECT_WORDS);
  const topicActions = wordsIn(topicText, ACTION_WORDS);
  const answerObjects = formsOf(wordsIn(answer, OBJECT_WORDS));
  const answerActions = formsOf(wordsIn(answer, ACTION_WORDS));
  const topicChars = charsOf(topicText);

  // 1) 对象词：话题里有的东西，回答里必须也提到其中一个。
  //
  // 「提到」按**词**比（不是字），两条证据：
  //   a. 回答里的词形与话题词形相同（「证已经拿到了」对「办证」：「证」是「办证」的部分）；
  //   b. 回答说了**话题的动作词**，而且要说得一样完整（「办好了」「还没办」对「办证」：都是「办」）。
  // 「我去楼下买了点水果」两条都不满足：`买` 是通用动词（进 `FRAME_WORDS`），不在话题动作词里。
  if (topicObjects.length > 0) {
    const topicForms = formsOf(topicObjects);
    const answerForms = [...new Set([...answerObjects, ...answerActions])];
    // 「说得一样完整」很关键：回答里的**短**动作词被话题**长**动作词盖住不算数，
    // 否则「拿」会对上「拿药」——「东西拿到了」就会被当成回答了「去拿药」，那还是「共享一个字」。
    const saidTopicAction = topicActions.some((action) =>
      answerActions.some((word) => word.length >= action.word.length && action.word.includes(word)),
    );
    const mentioned = topicForms.some((form) => answerForms.includes(form)) || saidTopicAction;
    if (!mentioned) return false;
    // 2) 别人家的：话题说的是**他**那件事（第一人称、没有定语），回答却把它换进了别人的框里
    //    （「老李家的孙子回来了」）。
    if (outsideReference(topicText, answer, topicChars)) {
      return answerActions.some((word) => topicFormMatches(topicActions, word));
    }
    return true;
  }

  // 3) 话题里没有对象词：退回到有辨识度的动作词（通用动词不在 `ACTION_WORDS` 里）。
  return answerActions.some((word) => topicFormMatches(topicActions, word));
}

/** 一个片段里说到的全部词形：命中的词，以及被它盖住、但随时可能单独被说出来的短词。 */
function formsOf(matches: readonly WordMatch[]): string[] {
  return matches.flatMap((match) => [match.word, ...match.covered]);
}

/**
 * 回答里的一个动作词，是不是话题动作词。
 *
 * 只在「话题里没有对象词」或「对象被换进别人家的框里」这两条兜底路径上用：这时没有对象可比，
 * 只能比动作词，而且**通用动词不算**（`FRAME_WORDS`：去 / 来 / 买 / 拿 / 吃…）。
 * 「办好了」里的「办」对「办证」成立（「办」就是话题动作词）。
 */
function topicFormMatches(topicActions: readonly WordMatch[], word: string): boolean {
  return topicActions.some((action) => action.word === word);
}

/**
 * 回答有没有把对象换进**别人的**框里（ADR-0012 的第二个残余）。
 *
 * 只在对象词已经对上之后才问这个问题（对象对不上前面就返回 false 了），所以判据可以写得很窄：
 * 回答里出现「别人的」写法 —— 「老李家的」「隔壁」「人家」—— 而且那个**定语**在话题里没有对应
 * （「去隔壁老王家拿东西」这个话题里的「隔壁」就是对得上的），就算换了个东西：
 * 「老李家的孙子回来了」不是「我去看孙子」的回答。
 *
 * 两种写法不算「别人的」：
 *   * 否定式「孙子不在家」「没在家」讲的是行踪，不是归属；
 *   * 第一人称定语「我家的孙子」「咱家的」讲的就是他那件事。
 */
function outsideReference(topic: string, answer: string, topicChars: Set<string>): boolean {
  const found = OTHER_OWNER_PATTERN.exec(answer);
  if (found === null) return false;
  const marker = found[0];
  const prefix = answer.slice(0, found.index);
  if (/[不没未]$/.test(prefix)) return false;
  const owner = prefix.match(/[我咱俺自家]{1,2}$/u)?.[0] ?? '';
  if (owner.length > 0) return false;
  // 话题里没有这个定语（逐字比：话题里出现过「隔壁」就说明它本来就是这件事的一部分）。
  return [...marker].some((char) => !topicChars.has(char));
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
