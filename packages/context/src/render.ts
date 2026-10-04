/**
 * 提示词里那几段渲染（pack `docs/02_MEMORY_CONTEXT.md` §3 的样式）。
 *
 * 渲染与装配是两件事：装配决定「这一轮该不该想起它」（排序、预算、audience），
 * 渲染决定「想起来的时候写成哪句话」。分开的好处是渲染可以单独被测试与反事实证明，
 * 而且**出口闸门**只在一个地方 —— 见下面的 `renderGate`。
 *
 * ## 两道闸门，职责不同（P1-D1 复审要求写清；两条用例分别压在它们身上）
 *
 * **第一层：检索前**（`memory-retriever.ts` 的 `usefulText`）。它只拦两类**机器 id 形态**的文本，
 * 命中就整条不进候选（连分数都不算，`MemoriesDiagnostics.dropped` 里记 `unusable_text`）：
 *   * UUID 形状的 id（`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）；
 *   * 8 位以上连续数字。
 *
 * **第二层：渲染前**（本文件的 `renderGate`，下面这个函数）。它在前两层之上**多**拦两类，
 * 而且是**所有出口**共用的最后一道：记忆行、未完话题行、世界状态的附加行、自我状态行。
 *   * 程序里的参数名（`valence` / `confidence` / `verbosity`…，见 `PARAMETER_NAMES`）；
 *   * 空白文本（渲染出空行没有意义）。
 *
 * 为什么两层都要有：第一层挡的是「这条记忆**本身就是**机器 id 拼出来的」（那种文本连当记忆的
 * 资格都没有）；第二层挡的是「这条记忆读起来是人话、但夹带了调试字段」—— 它才是「提示词里
 * 不出现参数名」这条纪律真正的防线，因为检索层**没有**理由为它把一条正常文本整条丢掉。
 * 两层都不信任上游：`ContextBuilder.render` 每次出口都重新过一遍闸门，所以「上游一定干净」
 * 不是任何一条断言的前提。
 *
 * 已知边界（如实记录，不假装它不存在）：`PARAMETER_NAMES` 用词边界（`\b`）判定，所以
 * `valence=0.3`、`confidence 0.9`、`他提过valence这个说法` 都会被拦（`=`、空格、汉字都是边界），
 * 而 ASCII 字母数字紧贴的形式（`valence0.3`）不构成词边界、拦不住 —— 那种形状不是本项目
 * 渲染调试字段的写法（面板与日志里都是 `k=v`），所以这一版不为此放宽整条规则。
 */

import type { DroppedMemory, MemoryKind, RetrievedMemory } from './types.ts';

export interface MemoryRenderResult {
  readonly lines: readonly string[];
  readonly dropped: readonly DroppedMemory[];
}

/** 给模型看的标题（pack §3 的原话，逐字）。 */
export const MEMORY_HEADING = '你们以前真正聊过、这轮可能有用的事：';

const UUID_SHAPE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/u;
const LONG_DIGITS = /\d{8,}/u;
/** 程序里的参数名/字段名：它们是给调试面板看的，不该出现在家里人的提示词里（P1 同款纪律）。 */
const PARAMETER_NAMES = /\b(?:valence|energy|confidence|provenance|sourceEventId|occurredAt|updatedAt|verbosity|talkativeness|curiosity|formality|humor|warmth|proactivity|silence_tolerance)\b/u;

/** 一段文本能不能进提示词（第二道闸门，见文件头「两道闸门」那一节）。 */
export function renderGate(text: string): boolean {
  if (text.trim().length === 0) return false;
  if (UUID_SHAPE.test(text)) return false;
  if (LONG_DIGITS.test(text)) return false;
  if (PARAMETER_NAMES.test(text)) return false;
  return true;
}

/**
 * 确定性标记（pack §3 的例子：`[较确定]` / `[有点旧]`）。
 *
 * 两条**同时**成立时写 `[较确定，但有点旧]` —— 顺序固定，所以同一份输入永远渲染出同一句话。
 */
export function memoryTags(memory: RetrievedMemory, now: Date): readonly string[] {
  const tags: string[] = [];
  if (memory.provenance.confidence >= 0.9) tags.push('较确定');
  else if (memory.provenance.confidence < 0.6) tags.push('不太确定');
  const ageMinutes = (now.getTime() - Date.parse(memory.provenance.updatedAt)) / 60_000;
  if (Number.isFinite(ageMinutes) && ageMinutes > 30 * 24 * 60) tags.push('有点旧');
  return tags;
}

/** 渲染记忆那一段；被闸门挡掉的整条丢掉（不改成「看起来干净」的样子，见 `usefulText` 的说明）。 */
export function renderMemoryLines(memories: readonly RetrievedMemory[], now: Date): MemoryRenderResult {
  const lines: string[] = [];
  const dropped: DroppedMemory[] = [];
  for (const memory of memories) {
    const text = memory.text.trim();
    const tags = memoryTags(memory, now);
    const rendered = tags.length === 0 ? `- ${text}` : `- [${tags.join('，')}] ${text}`;
    if (!renderGate(rendered)) {
      dropped.push({ id: memory.id, kind: memory.kind as MemoryKind, reason: 'unusable_text' });
      continue;
    }
    lines.push(rendered);
  }
  return { lines, dropped };
}

/**
 * 未完话题那一段（pack §7 的措辞：这是「还要接的话」，不是「已经知道的事」）。
 *
 * 与记忆行走**同一道**出口闸门：话题摘要来自父亲自己说的话，但它是程序拼过的（可能夹带
 * 调试字段），所以一样过 `renderGate`。
 */
export function renderOpenThreadLines(threads: readonly { readonly summary: string }[]): readonly string[] {
  const lines: string[] = [];
  for (const thread of threads) {
    const text = thread.summary.trim();
    if (text.length === 0) continue;
    const rendered = `- ${text}`;
    if (!renderGate(rendered)) continue;
    lines.push(rendered);
  }
  return lines;
}

/** 世界状态那几行（时段/星期/在场），全部由程序渲染，不含原始 payload。 */
export function renderWorldLines(world: {
  readonly now: string;
  readonly timezone: string;
  readonly timeOfDay: string;
  readonly weekday: string;
  readonly presence: { readonly present: boolean | null; readonly value?: string | null; readonly stale: boolean } | null;
  readonly extra: readonly string[];
}): readonly string[] {
  const lines = [
    `现在：${world.now}（${world.timezone}）`,
    `时段：${world.timeOfDay}　星期：${world.weekday}`,
  ];
  if (world.presence !== null) {
    if (world.presence.stale) lines.push('在场：最后一次判断已经过期了，现在算「不知道」。');
    else if (world.presence.present === true) lines.push('在场：他这会儿在家。');
    else if (world.presence.present === false) lines.push('在场：他这会儿不在家。');
  }
  for (const extra of world.extra) {
    const text = extra.trim();
    if (text.length === 0) continue;
    const rendered = `- ${text}`;
    if (!renderGate(rendered)) continue;
    lines.push(rendered);
  }
  return lines;
}

/**
 * 自我画像那一句（pack §23 同款边界：只给「说话方式」，数值留在 `self` 里）。
 *
 * 与别的出口一样过 `renderGate`（P1-D1：这类「程序自己写的一行」也要走同一道闸门）。
 * 默认就是原来那一句 —— live 路径的输出逐字不变；参数化只是为了让「它确实被闸门管着」
 * 这件事可被单独断言（传一行带参数名的文本进去，结果必须是空的）。
 */
export const DEFAULT_SELF_LINES: readonly string[] = Object.freeze([
  '（你现在的说话方式与脾气都已经按下面的设定调过了，不用复述。）',
]);

export function renderSelfLines(lines: readonly string[] = DEFAULT_SELF_LINES): readonly string[] {
  const kept: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (text.length === 0) continue;
    if (!renderGate(text)) continue;
    kept.push(text);
  }
  return kept;
}
