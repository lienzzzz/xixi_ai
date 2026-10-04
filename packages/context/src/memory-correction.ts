/**
 * 记忆纠正闭环（pack `docs/02_MEMORY_CONTEXT.md` §5）—— `MemoryCorrectionResolver`。
 *
 * 要解决的问题（审计 §3.2 的原话）：在 `我什么时候喜欢绿茶了，我不喝那个` 之后，
 * 「喜欢绿茶」与「不喜欢绿茶」会**永久并存**，谁也不知道哪条算数。这里的闭环是：
 *
 * ```text
 * 检测到纠正 → 检索候选记忆 → 结构化 resolver → 旧记忆标 revoked / superseded
 *            → 写新的语义记忆 → 留历史（两条都在 + 一条 system.health 审计）
 * ```
 *
 * 三条纪律写进实现里：
 *   1. **只纠 `active` 的记忆**：已经被取代/否定的那条不该再被纠一次（否则同一条事实被标两次，
 *      历史变成噪声）。
 *   2. **只召回、不猜测**：候选靠极性冲突 + 词面相关选，够不着门槛就什么都不做 ——
 *      误把一条不相干的记忆标成 revoked，比「这次没纠正」糟糕得多（铁律 4 的精神：
 *      显式纠正权重最高，正因为它是**确定**的）。
 *   3. **状态与历史分开**：被取代的那条 `statement` / `source_event_id` / `confidence` 一字不改，
 *      只多一个状态与「被谁取代」；要真删是另一件事（`MemoryStore.forgetSemantic`，AGENTS §5）。
 */

import { MemoryStore, type SemanticMemory, type XixiStore } from '@xixi/domain';

import { lexicalRelevance, polarityConflict } from './memory-score.ts';

/** 纠正的两种形态：明确否定（没有替代说法）与带替代说法的更正。 */
export type CorrectionKind = 'revoke' | 'replace';

export interface CorrectionDetection {
  readonly kind: CorrectionKind;
  /** 命中的规则 id（审计里存它，不存用户原话）。 */
  readonly ruleId: string;
  /** 程序渲染的证据（≤40 字）。 */
  readonly evidence: string;
}

/** 「我否定了某个说法」的字面形式：`我不喝那个` / `我不喜欢绿茶`。 */
const NEGATED_FACT = /我(?:不喜欢|不爱|讨厌|不喝|不吃|不去|不用)([^。！？!?，,；;]{1,20})/;

/** 从一句话里取出「被否定的动作」（`我不喝那个` → `不喝`）。没有就返回 null。 */
const NEGATED_VERB = /(不|别)(?:太)?(喜欢|爱|喝|吃|去|用|要|想|碰|住)/;

/**
 * 第一版纠正检测：**确定的模式**，不经过模型（pack §8 的 Tier 1：高精度优先）。
 *
 * 每条规则都要求「否定的对象是**一条记忆**」这件事在字面上成立：`我什么时候…了`（否认曾说过）、
 * `我没…过`、`你记错了`、`忘掉这个`、以及直接给出反命题的 `我不喜欢/不喝…`。
 * 认不出来就返回 `null` —— 不为了「有纠正」而把普通聊天当纠正（与 `interpretFeedback` 同一条纪律）。
 */
const CORRECTION_RULES: readonly {
  readonly id: string;
  /** 规则本身的形态；命中时还会看这句话里有没有给出反命题（有就升级成 replace）。 */
  readonly kind: CorrectionKind;
  readonly patterns: readonly RegExp[];
}[] = [
  // ① 否认「我说过这件事」：最典型的纠正，字面证据最强。
  { id: 'disown_claim', kind: 'replace', patterns: [/我什么时候(?:说过|讲了|喜欢|爱|喝|吃|住|去)/, /我(?:可)?没(?:说过|讲过|这么说过|那么说过)/, /我说过(?:吗|么)/] },
  // ② 直接说「你记错了 / 不是这样」。
  { id: 'wrong_memory', kind: 'replace', patterns: [/你记错/, /记错(?:了|了吧)/, /不是这样(?:的)?/, /我(?:可)?没(?:有)?(?:这么|那么)(?:说|讲)/] },
  // ③ 要求忘掉：这一条**不**写替代说法（他要的是「别再提」，不是「改成另一个」）。
  { id: 'forget_this', kind: 'revoke', patterns: [/忘(?:掉|了)(?:这个|这件事|它)/, /别(?:记|想着)(?:这个|这件事)/, /(?:以后)?别提(?:这个|这件事)/] },
  // ④ 直接给出反命题：`我不喜欢绿茶` / `我不喝那个`。
  { id: 'negated_fact', kind: 'replace', patterns: [NEGATED_FACT] },
];

/** 检测一句用户的话是不是在纠正一条记忆。认不出来返回 `null`。 */
export function detectMemoryCorrection(text: string): CorrectionDetection | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  for (const rule of CORRECTION_RULES) {
    for (const pattern of rule.patterns) {
      const hit = pattern.exec(trimmed);
      if (hit === null) continue;
      // 「忘掉这个」永远是 revoke；其余规则只要这句话里给出了反命题，就是一次 replace。
      const kind: CorrectionKind = rule.id === 'forget_this' ? 'revoke' : NEGATED_FACT.test(trimmed) ? 'replace' : rule.kind;
      return {
        kind,
        ruleId: rule.id,
        evidence: `${rule.id}｜命中「${(hit[0] ?? '').slice(0, 20)}」`,
      };
    }
  }
  return null;
}

/**
 * 从一条记忆的陈述里取出「说的是什么东西」（`我喜欢绿茶` → `绿茶`）。
 *
 * 找一个**谓语**（喜欢/不爱/住在/每天…），取它后面的部分；后面如果还有一个动词（`喜欢喝绿茶`），
 * 再剥掉它。找不到谓语就整句当宾语。剥不出来返回 `null`（那时候只做 revoke，不编新事实）。
 */
const STATEMENT_PREDICATES: readonly string[] = Object.freeze([
  '不喜欢',
  '不爱',
  '不喝',
  '不吃',
  '喜欢',
  '讨厌',
  '住在',
  '老家在',
  '每天',
  '平时',
  '平常',
  '一般',
  '爱',
  '住',
]);
const LEADING_OBJECT_VERB = /^(?:喜欢|爱|喝|吃|去|用|要|想|碰|住)/;

export function objectTermOf(statement: string): string | null {
  // 先去掉开头的第一人称与程度副词（记忆大多是「我很喜欢…」这种形状）。
  let text = statement.trim().replace(/^我(?:很|挺|特别|平时|平常|一般)?/, '').trim();
  if (text.length === 0) return null;
  let best: { readonly index: number; readonly length: number } | null = null;
  for (const predicate of STATEMENT_PREDICATES) {
    const index = text.indexOf(predicate);
    if (index < 0) continue;
    // 取**最靠前**的谓语；同一位置取更长的那个（`不喜欢` 优先于 `喜欢`）。
    if (best === null || index < best.index || (index === best.index && predicate.length > best.length)) {
      best = { index, length: predicate.length };
    }
  }
  if (best !== null) text = text.slice(best.index + best.length).trim();
  text = text.replace(LEADING_OBJECT_VERB, '').trim();
  return text.length === 0 ? null : text;
}

/**
 * 把「旧的陈述 + 这一轮的原话」拼成一条**新的**陈述（程序渲染，不是模型写的）：
 * `我喜欢绿茶` + `我不喝那个` → `我不喝绿茶`。
 *
 * 动词取自这一轮（他说的是「不喝」），宾语取自被纠正的那条（「那个」= 绿茶）。
 */
export function correctedStatement(oldStatement: string, userText: string): string | null {
  const verb = NEGATED_VERB.exec(userText.trim());
  const object = objectTermOf(oldStatement);
  if (verb === null || object === null) return null;
  const phrase = `${verb[1] ?? '不'}${verb[2] ?? ''}`;
  if (phrase.length < 2) return null;
  return `我${phrase}${object}`;
}

export interface CorrectionResolutionInput {
  readonly userText: string;
  readonly at: Date;
  readonly sessionId?: string | null | undefined;
  /** 用户那条 `conversation.turn` 的事件 id：新记忆指回它（铁律 4）。 */
  readonly sourceEventId?: string | null | undefined;
}

export interface CorrectionResolution {
  /** 检测结果（`null` = 这一轮不是在纠正记忆，后面什么都不做）。 */
  readonly detection: CorrectionDetection | null;
  /** 被判为「说的就是它」的那条记忆（没匹配到就是 null）。 */
  readonly target: SemanticMemory | null;
  /** 为什么是它 / 为什么什么都没做（程序渲染的短句，给面板与测试）。 */
  readonly reason: string;
  /** 判定用的词面相关与极性冲突（可复算）。 */
  readonly lexical: number;
  readonly contradictory: boolean;
  /** 写下的新语义记忆（只有 `replace` 真的写出去了才有）。 */
  readonly written: SemanticMemory | null;
  /** 被改状态的那条（改完之后的视图）。 */
  readonly marked: SemanticMemory | null;
  readonly status: 'superseded' | 'revoked' | null;
  /** 一句自解释的审计短句；调用方可以把它记成一条 episodic（记忆里的历史）。 */
  readonly note: string;
}

export interface MemoryCorrectionResolverOptions {
  readonly store: XixiStore;
  readonly memory?: MemoryStore | undefined;
  /** 「这条记忆说的就是它」的词面门槛。够不着就什么都不做。 */
  readonly matchFloor?: number | undefined;
}

/** 判定目标记忆的词面门槛：比检索注入那一道更保守（纠正标错比召回漏掉糟）。 */
export const CORRECTION_MATCH_FLOOR = 0.3;

export class MemoryCorrectionResolver {
  readonly #memory: MemoryStore;
  readonly #matchFloor: number;

  constructor(options: MemoryCorrectionResolverOptions) {
    this.#memory = options.memory ?? new MemoryStore(options.store);
    this.#matchFloor = options.matchFloor ?? CORRECTION_MATCH_FLOOR;
  }

  /**
   * 跑一次闭环。**确定性**：同一份输入（同一份记忆表、同一句话、同一时刻）永远得到同样的结果；
   * 重复调用不会写第二条记忆 —— 目标已经被标掉、不再是 `active`，于是第二次找不到目标。
   */
  resolve(input: CorrectionResolutionInput): CorrectionResolution {
    const detection = detectMemoryCorrection(input.userText);
    if (detection === null) {
      return empty(null, '这一轮不是在纠正记忆（没有命中任何纠正规则）');
    }

    const picked = this.#pickTarget(input.userText);
    if (picked.target === null) {
      // 认得出是纠正，但找不到「说的是哪一条」：记下这次纠正**没有**落地，
      // 不猜、不乱标（误标一条记忆比漏一次纠正糟糕得多）。
      return {
        ...empty(detection, `检测到纠正（${detection.ruleId}），但没找到对得上的记忆：没有改任何东西`),
        lexical: picked.lexical,
        contradictory: picked.contradictory,
      };
    }

    const target = picked.target;
    const reason = `${detection.ruleId}：${picked.reason}`;
    const replacement = this.#replacementFor(detection, target, input);

    // 已经记的就是这条：什么都不用改。
    //
    // 为什么必须有这一步（实测踩到）：第一次纠正把 `我喜欢绿茶` 换成 `我不喝绿茶` 之后，
    // 同一句话再跑一次会**又**选中新那条（`我不喝那个` 与 `我不喝绿茶` 共享被否定的 `喝`），
    // 于是「更正成同一条」——那会写出第三条一模一样的记忆，历史立刻变成噪声。
    if (replacement !== null && replacement.trim() === target.statement.trim()) {
      return {
        detection,
        target,
        reason: `${reason}；但记下的已经就是这条（${target.statement}）→ 什么都不用改`,
        lexical: picked.lexical,
        contradictory: picked.contradictory,
        written: null,
        marked: null,
        status: null,
        note: '这一轮没有纠正任何记忆',
      };
    }

    if (replacement === null) {
      const marked = this.#memory.revokeSemantic({ memoryId: target.memoryId, at: input.at, reason });
      return {
        detection,
        target,
        reason: `${reason}；没有替代说法 → revoked`,
        lexical: picked.lexical,
        contradictory: picked.contradictory,
        written: null,
        marked,
        status: 'revoked',
        // 注意措辞：**不复述被否定的那句**。这条 episodic 会被召回、会进提示词，
        // 把已经不信的说法再写一遍，等于绕开状态机把它送回模型面前（实测踩过）。
        note: '否定了以前记下的一条（从现在起不采信那条说法）',
      };
    }

    const written = this.#memory.recordSemantic({
      property: target.property,
      statement: replacement,
      sourceType: 'explicit_correction',
      sourceEventId: input.sourceEventId ?? null,
      confidence: 1,
    });
    const marked = this.#memory.supersedeSemantic({
      memoryId: target.memoryId,
      supersededBy: written.memoryId,
      at: input.at,
      reason: `${reason}；新说法：${written.statement}`,
    }).previous;
    return {
      detection,
      target,
      reason: `${reason}；${target.statement} → ${written.statement}`,
      lexical: picked.lexical,
      contradictory: picked.contradictory,
      written,
      marked,
      status: 'superseded',
      // 同上：只写**新的**说法。旧的那句留给数据库与日志（`reason` / 审计事件 / 那张标了
      // superseded 的行），不留给会被召回的文本。
      note: `更正了一条以前记下的事：现在按「${written.statement}」记`,
    };
  }

  /**
   * 选出「这一轮说的是哪条记忆」。
   *
   * 两条信号：
   *   * **极性冲突**（`我不喝那个` 打 `我喜欢绿茶`）：纠正最硬的证据，加 0.5 让冲突总排在纯词面之上；
   *   * **词面相关**：他说的话与那条记忆在字面上真的重合（「绿茶」）。
   *
   * 冲突单独成立就够（`polarityConflict` 自己已经要求共享被否定的那个词）；没有冲突时要求词面相关
   * 过 `matchFloor`。
   */
  #pickTarget(userText: string): {
    readonly target: SemanticMemory | null;
    readonly lexical: number;
    readonly contradictory: boolean;
    readonly reason: string;
  } {
    const candidates = this.#memory.activeSemantic({ limit: 200 });
    let best: SemanticMemory | null = null;
    let bestScore = 0;
    let bestLexical = 0;
    let bestContradictory = false;
    let bestReason = '';
    for (const candidate of candidates) {
      const lexical = lexicalRelevance(userText, candidate.statement);
      const contradictory = polarityConflict(userText, candidate.statement);
      const score = lexical + (contradictory ? 0.5 : 0);
      if (score <= bestScore) continue;
      best = candidate;
      bestScore = score;
      bestLexical = lexical;
      bestContradictory = contradictory;
      bestReason = contradictory
        ? `与「${candidate.statement}」结论相反（共享被否定的那个词）`
        : `与「${candidate.statement}」词面重合 ${lexical.toFixed(2)}`;
    }
    if (best === null) return { target: null, lexical: 0, contradictory: false, reason: '库里还没有 active 的语义记忆' };
    if (!bestContradictory && bestLexical < this.#matchFloor) {
      return {
        target: null,
        lexical: bestLexical,
        contradictory: false,
        reason: `最像的是「${best.statement}」（词面 ${bestLexical.toFixed(2)} < 门槛 ${this.#matchFloor}）`,
      };
    }
    return { target: best, lexical: bestLexical, contradictory: bestContradictory, reason: bestReason };
  }

  /** 这一轮有没有给出替代说法；给了就返回程序渲染好的新陈述。 */
  #replacementFor(detection: CorrectionDetection, target: SemanticMemory, input: CorrectionResolutionInput): string | null {
    if (detection.kind === 'revoke') return null;
    const rendered = correctedStatement(target.statement, input.userText);
    if (rendered !== null) return rendered;
    // 拼不出来时退一步：用这一轮那句完整的否定说法 —— 但**只在**它与目标说的确实是同一件事时
    // 才用（否则会写出一条与目标无关的新记忆，那是「凭空记下」而不是「纠正」）。
    const direct = NEGATED_FACT.exec(input.userText.trim());
    if (direct === null) return null;
    const statement = direct[0].trim();
    const sameThing =
      polarityConflict(statement, target.statement) ||
      lexicalRelevance(statement, target.statement) >= this.#matchFloor;
    return sameThing ? statement : null;
  }
}

function empty(detection: CorrectionDetection | null, reason: string): CorrectionResolution {
  return {
    detection,
    target: null,
    reason,
    lexical: 0,
    contradictory: false,
    written: null,
    marked: null,
    status: null,
    note: '这一轮没有纠正任何记忆',
  };
}
