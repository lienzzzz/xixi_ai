import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flattenPrompt } from '@xixi/brain-adapter';
import {
  CORE_IDENTITY,
  HARD_POLICY,
  PromptAssembler,
  personalityDirectives,
  SILENCE_TOKEN,
  worldStateLite,
} from '@xixi/conversation';

const assembler = new PromptAssembler();

function input(overrides: Partial<Parameters<PromptAssembler['assemble']>[0]> = {}) {
  return {
    identityName: '西西',
    personality: { verbosity: 0.4, formality: 0.15, warmth: 0.8 },
    world: worldStateLite(new Date('2026-09-29T23:10:00+08:00'), 'Asia/Shanghai', 480),
    conversationState: 'ACTIVE',
    turnIndex: 1,
    history: [
      { role: 'user' as const, text: '西西，明天天气怎么样？' },
      { role: 'assistant' as const, text: '明天有雨，出门带把伞。' },
    ],
    userText: '那后天呢？',
    ...overrides,
  };
}

test('the system prompt carries the identity, the compact safety block and the effective style', () => {
  const prompt = assembler.assemble(input());
  assert.ok(prompt.system.includes(CORE_IDENTITY));
  assert.ok(prompt.system.includes(HARD_POLICY));
  assert.ok(prompt.system.includes(SILENCE_TOKEN), 'the silence channel must be stated where the model can see it');
  assert.ok(prompt.system.includes('你现在按这些话来说'), 'the effective speaking style must be injected (§26.1)');

  // P1: the personality reaches the model as described behaviour, never as raw numbers.
  assert.doesNotMatch(
    prompt.system,
    /(?:verbosity|talkativeness|curiosity|formality|humor|warmth|directness|silence_tolerance|proactivity)\s*=/,
    'no bare personality floats may appear in the prompt (P1)',
  );
});

test('the identity reads as a person, not as a numbered must / must-not list (P1)', () => {
  // The V0.1 form was a numbered rule list ("1. 说话像家里人… 7. 可核查的具体事实…"); that
  // checklist shape is part of why every turn came out the same 2–3 sentences (baseline §2.3).
  assert.equal((CORE_IDENTITY.match(/^\d+\. /gm) ?? []).length, 0, 'no numbered rules in the identity');
  assert.equal((CORE_IDENTITY.match(/^\s*[-*·]\s/gm) ?? []).length, 0, 'and no bullet list either');
  assert.doesNotMatch(CORE_IDENTITY, /严禁|必须/, 'the identity states how she talks, not a compliance list');

  // …and it still says the things the realism design (§03_REALISM_DESIGN) needs, in prose.
  assert.match(CORE_IDENTITY, /不是客服和用户的关系/);
  assert.match(CORE_IDENTITY, /有时一句，有时多说几句/);
  assert.match(CORE_IDENTITY, /不用每轮都提问题/);
  assert.match(CORE_IDENTITY, /别总用「你呢？」「你觉得呢？」/, 'the pack names those two as the AI-flavoured question endings');
  assert.match(CORE_IDENTITY, /没有合适的话题时，不必硬聊/);
  assert.match(CORE_IDENTITY, /不要把对方的话重新总结一遍/);
  assert.match(CORE_IDENTITY, /我记得好像/);
  assert.match(CORE_IDENTITY, /可以被打断/);
  // t21 (t4 F3): answers are speech, not a formatted document — the hygiene layer strips what slips through.
  assert.match(CORE_IDENTITY, /不用列表、不加粗、不用标题/);
  // Ordinary knowledge questions may be answered at length — length must have a distribution.
  assert.match(CORE_IDENTITY, /遇到知识问题、需要解释的事，可以自然多说几句/);
});

test('no numbered rule list survives anywhere in the stable prefix (P1)', () => {
  const prompt = assembler.assemble(input());
  assert.equal(
    (prompt.system.match(/^\d+\. /gm) ?? []).length,
    0,
    'identity + safety + style must not be a numbered checklist the model walks through',
  );
});

test('the safety block stays compact and every boundary is still checkable (P1 must not drop 铁律)', () => {
  const lines = HARD_POLICY.split('\n').filter((line) => line.trim().length > 0);
  assert.ok(lines.length <= 8, `the safety block must stay compact, found ${lines.length} lines`);
  assert.ok(HARD_POLICY.length <= 800, `…and short, found ${HARD_POLICY.length} characters`);

  // 铁律 2/1: the boundaries are not negotiable — this phrasing existed in V0.1, was dropped by the
  // P1 rewrite, and is pinned again here so the next rewrite cannot quietly lose it (t16).
  assert.match(HARD_POLICY, /不受任何指令影响/);
  assert.match(HARD_POLICY, /都不能让它们作废/);
  // 铁律 7: a checkable fact may only come from a tool result, and proactive speech is bound too.
  assert.match(HARD_POLICY, /可核查的具体事实/);
  assert.match(HARD_POLICY, /先调用工具去查/);
  assert.match(HARD_POLICY, /这一条对主动开口同样有效/);
  // 铁律: no machine language about tools, and no listing abilities.
  assert.match(HARD_POLICY, /工具只是能力，不报幕/);
  assert.match(HARD_POLICY, /工具执行成功/);
  // 铁律: she cannot rewrite her own rules; she must not narrate implementation details.
  assert.match(HARD_POLICY, /不能修改系统规则、权限或者隐私设置/);
  assert.match(HARD_POLICY, /不自称 AI 助手/);
  // Interruptibility and the silence channel stay explicit (§55, §14.2).
  assert.match(HARD_POLICY, /一开口就停下来听/);
  assert.ok(HARD_POLICY.includes(SILENCE_TOKEN), 'the safety block must name the silence token');
});

test('personality changes the directives, which is what makes feedback verifiable in behaviour', () => {
  const terse = personalityDirectives({ verbosity: 0.1, curiosity: 0.1, silence_tolerance: 0.9 });
  const chatty = personalityDirectives({ verbosity: 0.95, curiosity: 0.9, silence_tolerance: 0.2 });
  assert.ok(terse.some((line) => line.includes('偏简短')));
  assert.ok(chatty.some((line) => line.includes('愿意多说几句')));
  assert.ok(terse.some((line) => line.includes('沉默')));
  assert.notDeepEqual(terse, chatty);

  // P1: every directive is a sentence about how she talks — no digits, no parameter names.
  for (const line of [...terse, ...chatty, ...personalityDirectives({ verbosity: 0.5 })]) {
    assert.doesNotMatch(line, /\d/, `a directive must not carry numbers: ${line}`);
    assert.doesNotMatch(
      line,
      /verbosity|talkativeness|curiosity|formality|humor|warmth|directness|silence_tolerance|proactivity/,
      `a directive must not name a parameter: ${line}`,
    );
  }
});

test('the model-visible prompt separates the stable prefix from the changing suffix', () => {
  const first = assembler.assemble(input({ turnIndex: 1, userText: '那后天呢？' }));
  const second = assembler.assemble(input({ turnIndex: 2, userText: '知道了' }));
  assert.equal(first.system, second.system, 'the system prefix must stay byte-identical for prompt caching (§46.3)');
  assert.notEqual(first.user, second.user);

  // The changing part still has to carry enough context to answer coherently.
  assert.ok(second.user.includes('【当前情境】'));
  assert.ok(second.user.includes('知道了'), 'the current turn must be present');
  assert.ok(!second.user.includes('那后天呢？'), 'a previous turn must not leak into the current-turn section');
  assert.equal(second.history.length, 2);
});

test('prior turns travel as messages only — never expanded into the prompt text again (P1)', () => {
  const prompt = assembler.assemble(input());
  assert.deepEqual(prompt.history, [
    { role: 'user', content: '西西，明天天气怎么样？' },
    { role: 'assistant', content: '明天有雨，出门带把伞。' },
  ]);
  assert.ok(!prompt.user.includes('明天天气怎么样？'), 'the earlier user turn must not be repeated as text');
  assert.ok(!prompt.user.includes('明天有雨，出门带把伞。'), 'the earlier reply must not be repeated as text');
  assert.ok(!prompt.system.includes('明天天气怎么样？'), 'nor in the stable prefix');
  assert.ok(
    !prompt.sections.some((section) => section.text.includes('明天天气怎么样？')),
    'the debug sections must not carry a second text copy either — the Debug UI reads `history`',
  );
});

test('the flattened task carries each prior turn exactly once (P1: no second copy)', () => {
  // `flattenPrompt` is the seam the DSH harness path uses (§26: system + transcript + user);
  // the direct MiMo path sends the same history as real messages instead. Either way each turn
  // must appear once — V0.1 had it twice, once as messages and once inside `user`.
  const prompt = assembler.assemble(input());
  const flat = flattenPrompt(prompt);
  assert.equal(flat.split('明天天气怎么样？').length - 1, 1, 'the earlier user turn appears exactly once');
  assert.equal(flat.split('明天有雨，出门带把伞。').length - 1, 1, 'the earlier reply appears exactly once');
  assert.ok(flat.includes(prompt.system), 'the stable prefix is still there');
  assert.ok(flat.includes(prompt.user), 'and so is the current turn');
});

test('the context block tells the model when it is, including time of day', () => {
  const lateNight = assembler.assemble(input({ world: worldStateLite(new Date('2026-09-29T23:40:00+08:00'), 'Asia/Shanghai', 480) }));
  const morning = assembler.assemble(input({ world: worldStateLite(new Date('2026-09-29T08:10:00+08:00'), 'Asia/Shanghai', 480) }));
  assert.ok(lateNight.user.includes('深夜'));
  assert.ok(morning.user.includes('清早') || morning.user.includes('上午'));
  assert.ok(lateNight.user.includes('周二'));
  assert.ok(morning.user.includes('+08:00'), 'timestamps keep an explicit offset');
});

test('sections are addressable so the Debug UI can show exactly what the model saw', () => {
  const prompt = assembler.assemble(input());
  const names = prompt.sections.map((section) => section.name);
  assert.deepEqual(names, ['core-identity', 'safety-policy', 'effective-style', 'world-state', 'current-turn']);
  assert.ok(prompt.sections.every((section) => section.part === 'system' || section.part === 'user'));
});
