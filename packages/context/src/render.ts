/**
 * 提示词里那几段渲染（pack `docs/02_MEMORY_CONTEXT.md` §3 的样式）。
 *
 * 渲染与装配是两件事：装配决定「这一轮该不该想起它」（排序、预算、audience），
 * 渲染决定「想起来的时候写成哪句话」。分开的好处是渲染可以单独被测试与反事实证明，
 * 而且**出口闸门**只在一个地方 —— 见下面的 `renderGate`。
 *
 * 出口闸门（t12 验收第 2 条「prompt 里不暴露 UUID」的最后一层）：
 * 一条候选在检索阶段就被 `usefulText` 挡掉了，这一层是**独立**的第二道 —— 任何一段
 * 要进提示词的文本，只要含 UUID 形态的 id、8 位以上连续数字、或程序里的参数名，
 * 整段丢掉并记在 `dropped` 里。这样「提示词里没有 id 与调试数字」不依赖于
 * 「上游一定干净」，而是每次渲染都重新成立。
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

/** 一段文本能不能进提示词。 */
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

/** 未完话题那一段（pack §7 的措辞：这是「还要接的话」，不是「已经知道的事」）。 */
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

/** 自我画像：只给「说话方式」那一句，数值留在 `self` 里（pack §23 同款边界）。 */
export function renderSelfLines(): readonly string[] {
  return ['（你现在的说话方式与脾气都已经按下面的设定调过了，不用复述。）'];
}
