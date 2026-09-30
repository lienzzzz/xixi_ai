/**
 * pack `xixi_v02_refactor_pack/tests/golden_conversations.md` as an executable
 * corpus (12 entries, G01–G12).
 *
 * The pack says these are **not** verbatim expectations but "节奏与关系" 的标杆, so
 * each entry carries:
 *   - `runnable`: can this repo actually run it today?
 *   - `expectations`: only the mechanically checkable ones are marked for
 *     enforcement; the rest are `observe` and are reported, not judged;
 *   - the pack's own 好/不好 examples, including which detector is *supposed* to
 *     catch the bad one (`badExample.detect`). `detect: 'none'` is a deliberate,
 *     honest gap: no word-level signal exists, only a human/评审 can judge it.
 *
 * Anything not runnable is kept in the corpus with the missing capability named,
 * so the uncovered part of the golden set is visible instead of silently absent.
 */

export interface GoldenTurn {
  readonly user: string;
  readonly addressed?: boolean;
}

export interface GoldenExpectations {
  /** At least this many turns must be accepted. */
  readonly minAccepted?: number;
  /** At least this many turns must be spoken (SPEAK). */
  readonly minSpeaks?: number;
  /** Silence is an acceptable outcome here. */
  readonly allowSilence?: boolean;
  /** No spoken reply may contain a question mark (pack G02: 不需要每次问问题). */
  readonly forbidQuestion?: boolean;
  /** Every spoken reply must be at least this many characters (pack G04: 知识问题允许展开). */
  readonly minChars?: number;
  /** No spoken reply may hit the banned-template list. */
  readonly forbidBannedTemplate?: boolean;
}

export interface GoldenGateCase {
  readonly id: string;
  readonly description: string;
  /** Candidate + context the gate function is called with. */
  readonly candidate: {
    readonly trigger: string;
    readonly components: Readonly<Record<string, number>>;
    readonly topicRef?: string | null;
  };
  /** Minutes past a recent delivery (0 = delivered just now). */
  readonly deliveredMinutesAgo: number | null;
  /** Topic of that earlier delivery, for the topic-repeat window. */
  readonly deliveredTopicRef?: string | null;
  readonly expectedReasonCode: string;
}

export interface GoldenConversation {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly kind: 'conversation' | 'proactive-gate' | 'unrunnable';
  readonly turns?: readonly GoldenTurn[];
  readonly personality?: Readonly<Record<string, number>>;
  readonly expectations?: GoldenExpectations;
  readonly gateCases?: readonly GoldenGateCase[];
  readonly goodExample?: string;
  readonly badExample?: {
    readonly text: string;
    /** Which detector must fire on it; 'none' means only a human can judge it. */
    readonly detect: 'template' | 'scaffolding' | 'none';
    readonly note?: string;
  };
  /** Why this entry cannot be executed in this repo *today*. */
  readonly notRunnableReason?: string;
  readonly note?: string;
}

const SOURCE = 'xixi_v02_refactor_pack/tests/golden_conversations.md';

export const GOLDEN_CONVERSATIONS: readonly GoldenConversation[] = Object.freeze([
  {
    id: 'G01',
    title: '普通多句接话',
    source: SOURCE,
    kind: 'conversation',
    turns: [{ user: '今天去镇上，人真多。', addressed: true }],
    expectations: { minAccepted: 1, minSpeaks: 1, forbidBannedTemplate: true },
    goodExample: '今天是不是赶上活动了？那边一有活动就挤。你事情办得还顺利不？',
    badExample: {
      text: '听起来你今天在镇上遇到了很多人。人多可能会让人感到疲惫。你愿意分享一下你今天去镇上做什么吗？',
      detect: 'template',
      note: 'pack 的「不好」例子：客服式共情 + 采访式提问',
    },
  },
  {
    id: 'G02',
    title: '不需要每次问问题',
    source: SOURCE,
    kind: 'conversation',
    turns: [{ user: '今天事情都办完了。', addressed: true }],
    // The pack's 好 example answers and stops; asking again is the failure mode.
    expectations: { minAccepted: 1, minSpeaks: 1, forbidQuestion: true, forbidBannedTemplate: true },
    goodExample: '那行，终于不用明天再跑一趟了。昨天听你说的时候我就觉得挺折腾。',
  },
  {
    id: 'G03',
    title: 'OpenThread（跨天 follow-up）',
    source: SOURCE,
    kind: 'unrunnable',
    notRunnableReason:
      '需要 OpenThreadStore + TopicEngine（pack Phase 3）与跨天的主动决策；本仓库当前没有 open thread 存储，ProactiveEngine 的 candidate 由调用方构造，无法端到端跑「Day1 记下 → Day2 回来追问」',
    goodExample: '证办下来了吗？',
  },
  {
    id: 'G04',
    title: '知识问题允许展开',
    source: SOURCE,
    kind: 'conversation',
    turns: [{ user: '国债和定期存款有啥区别？', addressed: true }],
    // "重点：不能为了陪伴风格强行只说一句" → enforce a floor, not a ceiling.
    expectations: { minAccepted: 1, minSpeaks: 1, minChars: 60, forbidBannedTemplate: true },
    goodExample: '国债相当于把钱借给国家，定期是存银行。两种都比较稳，不过流动性、提前取的规则和利率不一样。……',
  },
  {
    id: 'G05',
    title: '短回应可以沉默',
    source: SOURCE,
    kind: 'conversation',
    turns: [{ user: '嗯。', addressed: true }],
    // Both outcomes are legitimate (pack: 「上文自然结束」), so silence is allowed
    // but not required; what must never happen is the客服收尾.
    expectations: { minAccepted: 1, allowSilence: true, forbidBannedTemplate: true },
    badExample: {
      text: '好的，如果还有什么想聊的，随时告诉我。',
      detect: 'template',
      note: 'pack 的「不好」例子，对应 pack §2.1 的「如果还有什么」警报',
    },
  },
  {
    id: 'G06',
    title: '用户反馈调整自身',
    source: SOURCE,
    kind: 'conversation',
    turns: [{ user: '你今天话有点多。', addressed: true }],
    expectations: { minAccepted: 1, minSpeaks: 1, forbidBannedTemplate: true },
    goodExample: '哈哈，是有点。那我收着点。',
    notRunnableReason:
      '只跑第一轮（接受反馈）；「后续回复长度和追问率真实降低」需要 M3 的 feedback 学习回路，未实现，属未测',
  },
  {
    id: 'G07',
    title: '高主动，但有具体话题',
    source: SOURCE,
    kind: 'proactive-gate',
    gateCases: [
      {
        id: 'G07-specific-topic',
        description: '有具体话题（上午去医院看老朋友）且分数够高时，门禁应当放行',
        candidate: {
          trigger: 'future_hook_due',
          components: {
            event_salience: 1,
            social_value: 1,
            memory_relevance: 1,
            novelty: 1,
            time_since_last_interaction: 1,
            user_receptiveness: 1,
            future_hook_bonus: 1,
            interruption_risk: 0,
          },
          topicRef: '上午去医院看老朋友',
        },
        deliveredMinutesAgo: null,
        expectedReasonCode: 'PASSED',
      },
    ],
    goodExample: '回来了。你上午去看的那个老朋友怎么样？',
    badExample: { text: '欢迎回家！今天过得怎么样呀？', detect: 'none', note: '泛泛的热情开场——词表抓不到，只能人工/评审判' },
    note:
      '只验证「门禁层允许带具体话题开口」；消息内容是否具体属 Phase 3/5 的内容生成，本任务未测。' +
      '与 G12 同理：门禁语义若被 ADR-0011 改动，这条期望要一起重审。',
  },
  {
    id: 'G08',
    title: '新闻 Agent',
    source: SOURCE,
    kind: 'unrunnable',
    notRunnableReason: 'news 工具与插件系统（pack Phase 6/7）未实现，工具不存在就无法评测「先听哪个」这种多话题接话',
  },
  {
    id: 'G09',
    title: '工具隐形',
    source: SOURCE,
    kind: 'conversation',
    turns: [{ user: '明天下雨不？', addressed: true }],
    expectations: { minAccepted: 1, minSpeaks: 1, forbidBannedTemplate: true },
    goodExample: '[weather tool] 下午有雨，上午还行。你要下午出去就带把伞。',
    badExample: {
      text: '正在调用天气工具……工具调用成功……',
      detect: 'scaffolding',
      note: '工具报幕，由 FORBIDDEN_PATTERNS/脚手架检测覆盖，不是「AI 套话」词表的职责',
    },
  },
  {
    id: 'G10',
    title: '打断',
    source: SOURCE,
    kind: 'unrunnable',
    notRunnableReason: '要求 TTS 立即停 + 不补完上一段：需要真实播放/打断链路（pack Phase 8/§33），离线夹具测不了「扬声器真的停了」',
  },
  {
    id: 'G11',
    title: '对方有兴致时主动继续',
    source: SOURCE,
    kind: 'conversation',
    turns: [{ user: '我今天碰到老张了。', addressed: true }, { user: '他儿子也回来了。' }],
    expectations: { minAccepted: 2, minSpeaks: 2, forbidBannedTemplate: true },
    goodExample: '哦？好久没听你说他了。 / 过节回来看看吧。他之前不是一直在外地嘛。',
  },
  {
    id: 'G12',
    title: '没话题就别硬聊',
    source: SOURCE,
    kind: 'proactive-gate',
    gateCases: [
      {
        id: 'G12-cooldown',
        description: '刚主动聊过 → 冷却门禁挡住（不是「更热情」就能压过）',
        candidate: {
          trigger: 'topic_pool',
          components: { event_salience: 1, novelty: 1, social_value: 1, user_receptiveness: 1, interruption_risk: 0 },
          topicRef: '电视里在放的节目',
        },
        // pack 原文写的是「十分钟前」；本仓库出厂的 base_cooldown_min 只有 5 分钟，
        // 所以用「2 分钟前」测同一条门禁。10 分钟在 5 分钟冷却下本来就不该被挡——
        // 这个差异本身是 V0.1「话痨档」的事实，报告里会写明，不靠改数字掩盖。
        deliveredMinutesAgo: 2,
        expectedReasonCode: 'COOLDOWN_ACTIVE',
      },
      {
        id: 'G12-topic-repeated',
        description: '十分钟前刚聊过同一个话题 → 主题重复窗口挡住（topic_repeat_window 2h）',
        candidate: {
          trigger: 'topic_pool',
          components: { event_salience: 1, novelty: 1, social_value: 1, user_receptiveness: 1, interruption_risk: 0 },
          topicRef: '电视里在放的节目',
        },
        deliveredMinutesAgo: 10,
        deliveredTopicRef: '电视里在放的节目',
        expectedReasonCode: 'TOPIC_REPEATED',
      },
      {
        id: 'G12-no-topic-source',
        description: '随机闲聊触发源出厂关闭 → 没有合适话题时不允许为了主动而主动',
        candidate: {
          trigger: 'random_smalltalk',
          components: { event_salience: 1, novelty: 1, social_value: 1, user_receptiveness: 1, interruption_risk: 0 },
          topicRef: null,
        },
        deliveredMinutesAgo: null,
        expectedReasonCode: 'TRIGGER_DISABLED',
      },
    ],
    note:
      '期望 SILENCE 的机械镜像：门禁必须挡住「刚聊过」与「没有话题来源」两种硬聊。' +
      '注意：本用例断言的是 ADR-0009 时代的当前硬门禁实现；ADR-0011（2026-10-01）把主动决策改成' +
      '「硬底线 + 模型读空气」，冷却/话题重复是否仍属硬底线要由 Phase 5 重新审定——改完后这两条期望必须重审，' +
      '不要把它们当成永久契约。',
  },
]);

export function goldenById(id: string): GoldenConversation | undefined {
  return GOLDEN_CONVERSATIONS.find((entry) => entry.id === id);
}
