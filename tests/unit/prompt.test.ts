import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HARD_POLICY, PromptAssembler, personalityDirectives, SILENCE_TOKEN, worldStateLite } from '@xixi/conversation';

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

test('the system prompt carries the immutable policy and never the mutable numbers alone', () => {
  const prompt = assembler.assemble(input());
  assert.ok(prompt.system.includes(HARD_POLICY));
  assert.ok(prompt.system.includes(SILENCE_TOKEN), 'the silence channel must be stated where the model can see it');
  assert.ok(prompt.system.includes('有效人格'), 'the structured self-model must be injected (§26.1)');
  assert.ok(prompt.system.includes('verbosity=0.4'));
});

test('personality changes the directives, which is what makes feedback verifiable in behaviour', () => {
  const terse = personalityDirectives({ verbosity: 0.1, curiosity: 0.1, silence_tolerance: 0.9 });
  const chatty = personalityDirectives({ verbosity: 0.95, curiosity: 0.9, silence_tolerance: 0.2 });
  assert.ok(terse.some((line) => line.includes('1 句')));
  assert.ok(chatty.some((line) => line.includes('3~5 句')));
  assert.ok(terse.some((line) => line.includes('沉默')));
  assert.notDeepEqual(terse, chatty);
});

test('the model-visible prompt separates stable prefix from changing suffix', () => {
  const first = assembler.assemble(input({ turnIndex: 1, userText: '那后天呢？' }));
  const second = assembler.assemble(input({ turnIndex: 2, userText: '知道了' }));
  assert.equal(first.system, second.system, 'the system prefix must stay byte-identical for prompt caching (§46.3)');
  assert.notEqual(first.user, second.user);

  // The changing part still has to carry enough context to answer coherently.
  assert.ok(second.user.includes('【当前情境】'));
  assert.ok(second.user.includes('【最近对话】'));
  assert.ok(second.user.includes('用户：西西，明天天气怎么样？'));
  assert.ok(second.user.includes('西西：明天有雨，出门带把伞。'));
  assert.ok(second.user.includes('知道了'), 'the current turn must be present');
  assert.ok(!second.user.includes('那后天呢？'), 'a previous turn must not leak into the current-turn section');
  assert.equal(second.history.length, 2);
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
  assert.deepEqual(names, ['core-identity-and-hard-policy', 'effective-self-model', 'world-state', 'working-memory', 'current-turn']);
  assert.ok(prompt.sections.every((section) => section.part === 'system' || section.part === 'user'));
});
