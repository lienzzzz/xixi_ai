/**
 * 混合排序的算术（pack `docs/02_MEMORY_CONTEXT.md` §2）。
 *
 * 这个文件是**纯函数**：给它同一份候选、同一个查询和同一个现在，它永远给同样的名次。
 * 这正是第一版不上向量数据库的理由 —— 排序必须能被逐项复算，而不是只能被观察。
 *
 * 词面相关用的是**字级 unigram + bigram**，不是词：中文没有空格，而这个仓库里没有分词器
 * （加一个依赖要走 ADR）。字级重合对「绿茶 / 不喝那个」这种口语说法足够，而且完全确定。
 *
 * 极性不同要被罚：`不喜欢绿茶` 与 `喜欢绿茶` 的字重合度很高，但它们是相反的结论。
 * 只看字面会把纠正前的那条记忆当成「相关」推到前面 —— 那正是铁律 4 要避免的事
 * （显式纠正的权重高于模型推断，所以一条被纠正过的说法不该再被当成事实召回）。
 */

/** 否定词：出现在命题词前面就翻转极性。顺序即匹配顺序，长词优先。 */
export const NEGATION_MARKERS = Object.freeze(['不喜欢', '不爱', '不喝', '不吃', '不去', '不想', '不要', '不用', '不是', '没有', '别', '不', '没'] as const);

/** 极性不一致的扣分：它不是一个「弱相关」，而是一个**方向相反**的候选。 */
export const POLARITY_CONFLICT_PENALTY = 0.45;

/**
 * 「这条记忆够不够相关」的字面门槛。
 *
 * 为什么需要一道**相关性的先决条件**，而不是只靠总分排序：近因 + 置信 + 重要度三项加起来就有
 * 1.8 分，足够把一条与这一轮毫无关系的新记忆推到前面。一条「弟弟周六可能回来」被塞进
 * 「今天天气怎么样」的提示词里，读起来就是「她突然想起来一件不相干的事」——
 * 比少给几条更糟（pack §2：不要每轮 dump 全部记忆）。
 *
 * 低于这道门槛的候选**仍然**可以用另外两条信号留下：主语对得上（他/她说的是这条记忆的主角），
 * 或与一件没办完的事有关。三条都不沾，才判 `not_relevant`。
 */
export const MIN_LEXICAL_RELEVANCE = 0.25;

/**
 * 双字词先决条件：查询里有一个双字词命中，就足以说「这一轮在说这件事」。
 *
 * 一个双字词命中（`喝乌`、`喝点`、`绿茶`）意味着两条文本共享**至少两个字组成的词**，
 * 而不是一个字碰巧重合。有了它，加权平均那一路就不必再为「两个字的说得着」放宽。
 *
 * 例：`他喜欢喝什么茶` 对 `他喜欢喝乌龙茶` 命中 `喜欢`（双字命中 → 相关）；
 * 而对 `他每天早上六点起床` 只剩一个 `点`（既不满足双字，加权平均也只有 0.086 → 不相关）。
 */
export const MIN_BIGRAM_RELEVANCE = 0.34;

/**
 * 极性冲突：一边用否定词否定了某个词、另一边**肯定**地说着同一个词（或反过来）。
 *
 * 判据只有一条：**有一条文本在否定某个词，而另一条里出现了这个词的肯定形式**。
 *   * `不喜欢绿茶` vs `喜欢绿茶`：前者否定了 `喜欢`，后者里有 `喜欢` → 冲突；
 *   * `那他喜欢喝什么茶` vs `父亲不喜欢绿茶`：后者否定了 `喜欢`，而**前者里没有 `不喜欢`**
 *     —— 它是被提到的，不是被否定的 → 不冲突（「正好问到点子上」不该被罚，实测踩过）；
 *   * `那绿茶呢` vs `父亲不喜欢绿茶`：同上，不冲突。
 *
 * 单字否定词（`不`、`没`）在 `stemNegated` 里被跳过：空串是任何字符串的子串，
 * 不跳过的话每个含「不」的句子都会被判成冲突。
 */
export function polarityConflict(left: string, right: string): boolean {
  const negated = stemNegated(left, right);
  if (negated !== null) return true;
  return stemNegated(right, left) !== null;
}

/**
 * 「这条文本否定了哪个词」：`不喜欢绿茶` → `喜欢`；`不喝绿茶` → `喝`；没有可用的否定词就返回 null。
 *
 * 两条细节都是实测换来的：
 *   * 单字否定词（`不`、`没`）必须跳过 —— 空串是任何字符串的子串，否则每个含「不」的句子都算冲突；
 *   * 命中的否定词前面如果还是否定词（`那**不**喜欢`），那不是「否定喜欢」，不算。
 */
function stemNegated(text: string, other: string): string | null {
  for (const marker of NEGATION_MARKERS) {
    const index = text.indexOf(marker);
    if (index < 0) continue;
    const stem = marker.slice(1);
    if (stem.length === 0 || !other.includes(stem)) continue;
    const before = text.slice(0, index).slice(-1);
    if (before.length > 0 && NEGATION_MARKERS.includes(before as (typeof NEGATION_MARKERS)[number])) continue;
    return stem;
  }
  return null;
}

function unigrams(text: string): string[] {
  const characters = [...text].filter((character) => /[\p{Script=Han}\p{L}\p{N}]/u.test(character));
  return characters.map((character) => character.toLowerCase());
}

function bigrams(text: string): string[] {
  const characters = unigrams(text);
  const pairs: string[] = [];
  for (let index = 0; index + 1 < characters.length; index += 1) {
    pairs.push(`${characters[index]}${characters[index + 1]}`);
  }
  return pairs;
}

function coverage(needles: readonly string[], haystack: Set<string>): number {
  if (needles.length === 0) return 0;
  let hit = 0;
  for (const needle of needles) if (haystack.has(needle)) hit += 1;
  return hit / needles.length;
}

/**
 * 词面相关 ∈ [0, 1]：**不对称**的覆盖率（查询里有多少出现在记忆里），不是对称相似度。
 *
 * 不对称是刻意的：`成都有没有下雨` 对上一条长记忆 `他说明天要去成都开会` 应该算「提到了」，
 * 反过来一条长记忆里只有两个字与短查询重合则不该算。bigram 权重是 unigram 的两倍，
 * 因为「绿茶」这种双字词比两个随机单字更能说明说的是同一件事。
 */
export function lexicalRelevance(query: string, text: string): number {
  const pair = bestBigramCoverage(query, text);
  return clamp01(0.6 * unigramCoverage(query, text) + 0.4 * pair);
}

/**
 * 查询里的双字词有多少出现在文本里 —— 「说的是同一件事」的最强单信号。
 *
 * `那绿茶呢` 对 `父亲不喜欢绿茶`：单字覆盖率只有一半（`茶`、`绿` 命中，`那`、`呢` 不命中），
 * 但 `绿茶` 这个双字词是命中的。只看加权平均会让这个**明确的**相关信号被两个语气词稀释掉，
 * 于是「他喜不喜欢绿茶」这种最该被想起来的一轮反而一条记忆都没有。
 */
export function bestBigramCoverage(query: string, text: string): number {
  return coverage(bigrams(query), new Set(bigrams(text)));
}

function unigramCoverage(query: string, text: string): number {
  return coverage(unigrams(query), new Set(unigrams(text)));
}

/**
 * 「这句话在说哪个话题」用的**功能字表**（V0.3 t22）。
 *
 * 为什么要它：`给我推荐个茶。` 与 `我很喜欢喝茉莉花茶` 在**词面**上几乎不重合（共同的只有
 * `我` 与 `茶`，而且不构成共同双字词），于是最该被想起来的一条茶偏好进不了提示词 —— 用户看到的
 * 是引擎的兜底句。而人读这两句时不会犹豫：它们说的是**同一个话题**（茶）。
 *
 * 判据只能是「去掉不承载话题的字之后，剩下的字还对不对得上」，所以这里列的是**功能字**：
 * 代词、助词、介词、连词、判断词、常见谓词（言语/心理/动作）、程度与疑问副词、语气词，
 * 以及请求类动词（推荐/建议/请/帮…）。它们在任何话题里都会出现，因此不携带话题信息。
 *
 * 两条纪律：
 *   * 这张表只影响**话题覆盖率**这一条相关性信号，不参与词面相关与排序权重（那些公式一个字没改）；
 *   * 表里**不放名词**（茶/伞/药/饭/家…），否则话题信号会被自己抹掉。
 */
export const CONTENT_STOP_CHARS: ReadonlySet<string> = new Set([
  // 代词与称谓
  '我', '你', '他', '她', '它', '咱', '们', '您', '谁',
  // 助词 / 语气 / 标点残留
  '的', '了', '着', '过', '地', '得', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '嘛', '么',
  // 判断与存在 / 副词
  '是', '有', '在', '没', '不', '别', '无', '为', '就', '都', '也', '还', '再', '又', '只', '才',
  '很', '太', '挺', '蛮', '更', '最', '真', '好', '坏', '多', '少', '大', '小', '快', '慢',
  // 介词 / 连词 / 量词 / 方位
  '和', '跟', '与', '把', '被', '给', '对', '向', '从', '于', '或', '而', '但', '却', '以', '及',
  '个', '些', '点', '这', '那', '哪', '几', '时', '候',
  // 「说听想问」这类言说/心理/请求动词：它们在任何话题里都会出现，不承载话题
  '说', '讲', '问', '答', '聊', '看', '听', '想', '要', '会', '能', '可', '该', '去', '来', '做',
  '干', '用', '拿', '推', '荐', '请', '帮', '让', '使', '叫', '记',
  // 疑问词根
  '什', '怎', '样', '如', '何', '甚',
]);

/**
 * 一句话里的**内容字**（去重、保持出现顺序）：去掉标点与非汉字，再去掉 `CONTENT_STOP_CHARS`。
 *
 * `给我推荐个茶。` → `['茶']`；`我平时喜欢茉莉花茶` → `['平','喜','欢','茉','莉','花','茶']`。
 */
export function contentChars(text: string): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const character of unigrams(text)) {
    if (!/[\u4e00-\u9fff]/u.test(character)) continue;
    if (CONTENT_STOP_CHARS.has(character)) continue;
    if (seen.has(character)) continue;
    seen.add(character);
    kept.push(character);
  }
  return kept;
}

/**
 * 这个内容字在文本里是不是**成词出现的**（而不是被功能字夹着的孤字）。
 *
 * 为什么要这一层（实测换来的）：只看「字出现过」的话，`给我推荐个茶。` 会把
 * `遥控器在茶几上` 也算成「说的是同一件事」（它含 `茶`），而 `茶几` 与茶没关系 —— 那是**误召回**。
 * 判据因此收紧为：这个字自己出现的位置上，**左右至少一侧紧邻另一个内容字**（即它是一个
 * 至少两字的词的一部分）。
 *
 *   * `茉莉花茶` → `花`、`茶` 都是内容字且相邻 → `茶` 成词 ✓
 *   * `茶叶罐`   → `茶`、`叶` 相邻 → 成词 ✓
 *   * `茶几上`   → `几`、`上` 都是功能字 → `茶` 是孤字 ✗（不会被当成话题命中）
 */
export function appearsAsContentTerm(character: string, text: string): boolean {
  const characters = unigrams(text);
  const isContent = characters.map(
    (current) => /[\u4e00-\u9fff]/u.test(current) && !CONTENT_STOP_CHARS.has(current),
  );
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== character || !isContent[index]) continue;
    if (isContent[index - 1] === true || isContent[index + 1] === true) return true;
  }
  return false;
}

/**
 * 话题覆盖率 ∈ [0, 1]：查询的**内容字**有多少在文本里**成词出现**。
 *
 * 与 `lexicalRelevance` 的分工：词面相关问「两条读起来像不像」，话题覆盖率问「说的是不是同一件事」
 * —— `给我推荐个茶。` 与 `我平时喜欢茉莉花茶` 的后者是 1（查询唯一的内容字 `茶` 在记忆里成词），
 * 前者只有 0.2。检索器把 `topicCoverage === 1`（**查询的每个内容字都成词出现在记忆里**）
 * 当成一条独立的相关性路径：对长查询很严（要**全部**内容字都对上），对短查询就是一次话题点名。
 */
export function topicCoverage(query: string, text: string): number {
  const needles = contentChars(query);
  if (needles.length === 0) return 0;
  let hit = 0;
  for (const needle of needles) if (appearsAsContentTerm(needle, text)) hit += 1;
  return hit / needles.length;
}

/** 话题点名成立的门槛：查询的每个内容字都要出现在记忆里。 */
export const TOPIC_COVERAGE_FLOOR = 1;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 近因 ∈ [0, 1]：半衰期 30 天。
 *
 * 为什么是 30 天而不是一条硬边界：家里的记忆大多是「上周说的」，三五个月前的也该留着
 * （重要的事靠 `importance` 拉回来），所以近因是**连续**的，而「过期」是另一个单独的扣分项。
 */
export const RECENCY_HALF_LIFE_DAYS = 30;

export function recencyScore(ageDays: number): number {
  if (!Number.isFinite(ageDays)) return 0;
  const days = Math.max(0, ageDays);
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
}

/** 过了这个天数（还按 `occurredAt` 算年龄，而不是 `updatedAt`）就要扣「陈旧」分。 */
export const STALE_AFTER_DAYS = 30;
/** 陈旧扣分的上限：再老也只扣这么多，不能让一条重要记忆因为久远就消失。 */
export const MAX_STALE_PENALTY = 0.6;

export function stalePenalty(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays <= STALE_AFTER_DAYS) return 0;
  const excess = (ageDays - STALE_AFTER_DAYS) / 180;
  return Math.min(MAX_STALE_PENALTY, excess * MAX_STALE_PENALTY);
}

/** 上面那句「这件事已经说过了」的扣分上限与阈值。 */
export const ALREADY_MENTIONED_THRESHOLD = 0.34;
export const MAX_ALREADY_MENTIONED_PENALTY = 0.5;

export function alreadyMentionedPenalty(overlap: number): number {
  if (!Number.isFinite(overlap) || overlap < ALREADY_MENTIONED_THRESHOLD) return 0;
  return Math.min(MAX_ALREADY_MENTIONED_PENALTY, overlap * MAX_ALREADY_MENTIONED_PENALTY);
}

/**
 * 主语匹配：查询里出现了这条记忆的主语时的加分。
 *
 * 只看一个方向（查询里有没有这个主语），**不看**反方向。反方向（「主语里包含查询」）看起来更宽，
 * 实际会误伤：`他每天早上六点起床` 的主语是 `routine`，而 `今天天气怎么样` 去掉标点后是
 * `今天天气怎么样`——两者互不包含。真正的问题在别的例子上：查询 `六点` 会被判成
 * 「主语对得上」而把一条不相干的记忆拉进来。主语匹配要的是「这一轮真的在说这条记忆的主角」。
 *
 * `subject` 来自库里的 `property` / `aspect` 字段，里面有一批是**程序的分类名**
 * （`preference`、`routine`、`chat_style`…）。分类名不是主语，拿它去比会把所有同类记忆都算
 * 「主语对得上」，所以它们一律不算（见 `GENERIC_SUBJECTS`）。
 */
export function subjectScore(subject: string | null, query: string): number {
  if (subject === null) return 0;
  const needle = subject.trim();
  if (needle.length === 0) return 0;
  if (GENERIC_SUBJECTS.has(needle)) return 0;
  return query.includes(needle) ? 1 : 0;
}

/**
 * 程序用的分类名（不是「主语」）：`semantic_memory.property` 与 `relationship_notes.aspect`
 * 里的那些固定词。它们用来分类，不用来指代谁，所以不参与主语匹配。
 */
export const GENERIC_SUBJECTS: ReadonlySet<string> = new Set([
  'preference',
  'person',
  'place',
  'routine',
  'plan',
  'correction',
  'episode',
  'fact',
  'chat_style',
  'question_density',
  'humor',
  'proactivity',
  'feedback',
]);

/**
 * 一条记忆与某个未完话题的关系 ∈ [0, 1]。
 *
 * 「未完话题」在提醒「这件事还没完」，所以与它相关的记忆这一轮更可能有用
 * （pack §2 的 `+ open-thread relationship`）。判据仍然是词面：话题摘要/主语 与 记忆文本/主语
 * 任一方向的重合，取最大值，避免「两条都很像」被平均成一个中间值。
 */
export function openThreadScore(threadTexts: readonly (string | null)[], memoryTexts: readonly (string | null)[]): number {
  let best = 0;
  for (const left of threadTexts) {
    if (left === null || left.trim().length === 0) continue;
    for (const right of memoryTexts) {
      if (right === null || right.trim().length === 0) continue;
      best = Math.max(best, Math.min(lexicalRelevance(left, right), lexicalRelevance(right, left)));
    }
  }
  return best;
}
