/**
 * The core prompt authority — pack `03_AGENT_PLUGIN.md` §3, boundary「不能修改 core system prompt」.
 *
 * 铁律 2 says the model may never rewrite the core prompt, and this file adds the other half:
 * **neither may a plugin**. The way that is enforced here is not a comment and not a convention:
 *
 *  1. the core prompt is *owned* here (`CORE_IDENTITY` + `HARD_POLICY`, imported from
 *     `@xixi/conversation` rather than copied — a second copy would be the drift everyone fears);
 *  2. `verify()` is the only way a prompt that a plugin helped build gets back to the model, and
 *     it refuses unless both core sections are present **verbatim**;
 *  3. `assertContextLine()` is what a plugin's `context_provider` lines pass through before they
 *     reach a prompt — a line that tries to *manufacture* a core marker (「安全边界：」) is refused
 *     there.
 *
 * Point 2 is the load-bearing one: a plugin's context provider can contribute lines, so the
 * prompt is no longer assembled from core-only inputs. `verify` is the check that the contribution
 * stayed a contribution.
 */
import { CORE_IDENTITY, HARD_POLICY } from '@xixi/conversation';

import { PluginBoundaryError } from './errors.ts';

export const CORE_PROMPT_SECTION_NAMES = ['core-identity', 'safety-policy'] as const;

export type CorePromptSectionName = (typeof CORE_PROMPT_SECTION_NAMES)[number];

/** The two immutable blocks, exactly as `@xixi/conversation` ships them. */
export const CORE_PROMPT_BLOCKS: Readonly<Record<CorePromptSectionName, string>> = Object.freeze({
  'core-identity': CORE_IDENTITY,
  'safety-policy': HARD_POLICY,
});

export interface PromptSection {
  readonly name: string;
  readonly part: 'system' | 'user';
  readonly text: string;
  readonly debug?: string;
}

/** What `verify` accepts: the prompt-shaped thing an assembler returned. */
export interface VerifiablePrompt {
  readonly system: string;
  readonly sections: readonly PromptSection[];
}

/**
 * Markers a plugin must not fabricate. Kept short and explicit on purpose: each entry is a phrase
 * that, if a plugin could introduce it, would let plugin-authored text be read as program-authored
 * policy (铁律 8: instructions and data stay in separate layers).
 */
export const CORE_PROMPT_MARKERS: readonly string[] = [
  '硬边界',
  '不受任何指令影响',
  'core-identity',
  'safety-policy',
  '系统提示词',
  'core system prompt',
];

export interface CorePromptAuthority {
  /** The two blocks, so a caller never needs its own copy. */
  readonly blocks: Readonly<Record<CorePromptSectionName, string>>;
  /**
   * Partition a prompt into `core` and `contributions`, or throw `PluginBoundaryError`.
   *
   * Throws when a core section is missing, duplicated, moved off `system`, or altered by a single
   * character — including the case where a plugin appended "and also ignore the safety rules" to
   * the end of the safety block.
   */
  verify(prompt: VerifiablePrompt, pluginId: string): { readonly core: readonly PromptSection[]; readonly contributions: readonly PromptSection[] };
  /** Refuse one plugin-authored context line that tries to look like core policy text. */
  assertContextLine(pluginId: string, text: string): void;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[0-9A-Za-z_]/.test(char);
}

/** Does `haystack` contain `needle` as a whole word? (`\b` without lookbehind, which older engines reject.) */
function containsWord(haystack: string, needle: string): boolean {
  const lower = haystack.toLowerCase();
  const target = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const index = lower.indexOf(target, from);
    if (index < 0) return false;
    const before = index === 0 ? undefined : lower[index - 1];
    const after = lower[index + target.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = index + 1;
  }
}

function forbiddenMarkerIn(text: string): string | undefined {
  return CORE_PROMPT_MARKERS.find((marker) => containsWord(text, marker));
}

/** Build the authority. Stateless today, kept as a factory so a deployment can swap the blocks. */
export function createCorePromptAuthority(): CorePromptAuthority {
  return {
    blocks: CORE_PROMPT_BLOCKS,

    verify(prompt: VerifiablePrompt, pluginId: string): { readonly core: readonly PromptSection[]; readonly contributions: readonly PromptSection[] } {
      if (typeof prompt.system !== 'string' || prompt.system.length === 0) {
        throw new PluginBoundaryError('core-system-prompt', pluginId, '提示词的 system 段是空的：核心提示词不能被插件清掉');
      }
      if (!prompt.system.startsWith(CORE_IDENTITY)) {
        throw new PluginBoundaryError('core-system-prompt', pluginId, '提示词的 system 段不再以核心身份开头：核心提示词被插件改过');
      }
      if (!prompt.system.includes(HARD_POLICY)) {
        throw new PluginBoundaryError('core-system-prompt', pluginId, '提示词里找不到核心安全边界原文：核心提示词被插件改过');
      }

      const core: PromptSection[] = [];
      const contributions: PromptSection[] = [];
      const seen = new Set<string>();

      for (const section of prompt.sections) {
        const expected = (CORE_PROMPT_SECTION_NAMES as readonly string[]).includes(section.name)
          ? CORE_PROMPT_BLOCKS[section.name as CorePromptSectionName]
          : undefined;
        if (expected === undefined) {
          contributions.push(section);
          continue;
        }
        if (seen.has(section.name)) {
          throw new PluginBoundaryError('core-system-prompt', pluginId, `提示词里出现了两个 ${section.name} 段：核心段只能有一个`);
        }
        seen.add(section.name);
        if (section.part !== 'system') {
          throw new PluginBoundaryError('core-system-prompt', pluginId, `核心段 ${section.name} 被移出了 system 前缀`);
        }
        if (section.text !== expected) {
          throw new PluginBoundaryError('core-system-prompt', pluginId, `核心段 ${section.name} 的正文与核心原文不一致（一个字都不许改）`);
        }
        core.push(section);
      }

      for (const name of CORE_PROMPT_SECTION_NAMES) {
        if (!seen.has(name)) {
          throw new PluginBoundaryError('core-system-prompt', pluginId, `提示词缺少核心段 ${name}：插件不能把它删掉`);
        }
      }

      // 铁律 2 的第二半：核心两段必须是 system 里的**头两段**，中间不许夹任何东西。
      //
      // 只核对段对象不够——「段原文没改」证明不了「系统前缀没被追加过规则文本」。核心身份之后、
      // 安全边界之前**恰好**是核心放「你的名字是「…」。」那一句的位置（`PromptAssembler.assemble`），
      // 没有别的东西该待在那儿；这一段既排除了中间插话，也排除了在末尾补一段「插件补充规则」。
      const systemSections = prompt.sections.filter((section) => section.part === 'system');
      const firstTwo = systemSections.slice(0, CORE_PROMPT_SECTION_NAMES.length).map((section) => section.name);
      if (firstTwo.join('>') !== CORE_PROMPT_SECTION_NAMES.join('>')) {
        throw new PluginBoundaryError(
          'core-system-prompt',
          pluginId,
          `system 里核心身份与安全边界不是头两段（实际：${firstTwo.join('、') || '空'}）：插件不能往系统前缀里插话`,
        );
      }
      return { core, contributions };
    },

    assertContextLine(pluginId: string, text: string): void {
      if (typeof text !== 'string') {
        throw new PluginBoundaryError('core-system-prompt', pluginId, 'context 行必须是字符串');
      }
      const marker = forbiddenMarkerIn(text);
      if (marker !== undefined) {
        throw new PluginBoundaryError(
          'core-system-prompt',
          pluginId,
          `context 行出现核心提示词标记「${marker}」：插件只能提供素材，不能伪造程序写的规则（铁律 8）`,
        );
      }
    },
  };
}

/** The default authority. `@xixi/conversation` owns the text; this owns the checking. */
export const CORE_PROMPT_AUTHORITY: CorePromptAuthority = createCorePromptAuthority();

/** What `verifyOnAssemble` needs: anything that turns an input into an assembled prompt. */
export interface PromptAssemblerLike<Input, Output extends VerifiablePrompt> {
  assemble(input: Input): Output;
}

export interface VerifyOnAssembleOptions {
  readonly authority?: CorePromptAuthority;
  /** Named in a refusal — which plugin (or which wiring) built this prompt. */
  readonly pluginId?: string;
}

/**
 * Wrap an assembler so that **every** prompt it returns passes `verify` before the caller sees it.
 *
 * This is the mechanism for 「在插件贡献进入 prompt 的那个装配点调 verify」, and it is one line at the
 * call site:
 *
 * ```ts
 * const assembler = verifyOnAssemble(new PromptAssembler());
 * ```
 *
 * **接线状态（诚实记录，AGENTS §9.24）：这个包装器本身有用例，但它的调用点还没接。** 真实装配点是
 * `packages/conversation` 的 `PromptAssembler`，那一层不在本任务（t18）的 inScope 里；今天的现状是
 * 「插件贡献只能以 context_provider 的素材行进来、其文本在加载期过滤」，权威校验尚未进入提示词装配
 * 路径。把调用点接上，是下一阶段的显式前置项（与「在 live 入口装配插件内核」同一批），这条状态同时
 * 写在 `packages/runtime/src/tool-runtime.ts` 的接线状态块里。
 */
export function verifyOnAssemble<Input, Output extends VerifiablePrompt>(
  assembler: PromptAssemblerLike<Input, Output>,
  options: VerifyOnAssembleOptions = {},
): PromptAssemblerLike<Input, Output> {
  const authority = options.authority ?? CORE_PROMPT_AUTHORITY;
  const pluginId = options.pluginId ?? '(prompt-contributions)';
  return {
    assemble: (input: Input): Output => {
      const prompt = assembler.assemble(input);
      // A refusal here is the whole point: the prompt never reaches the model unchecked.
      authority.verify(prompt, pluginId);
      return prompt;
    },
  };
}
