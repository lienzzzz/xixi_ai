import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpokenTextFilter, sanitizeSpokenReply, stripForeignReasoning, stripToolCallMarkup } from '@xixi/model-adapters';

/**
 * t7: the two artifacts the household actually heard (V0.1 baseline `docs/benchmarks/v01-baseline.md` §4).
 *
 * Both fixtures below are **verbatim** copies from the baseline transcripts, so these tests fail the
 * day the fix stops covering the real defect rather than a paraphrase of it:
 *   * `docs/benchmarks/v01/raw-voice-batchA.txt` — the reply body *was* the tool-call markup;
 *   * `docs/benchmarks/v01/raw-voice-batchB.txt` — the reply body was English self-reasoning that
 *     ended in the real Chinese line.
 *
 * The pure functions are the contract; the engine and adapter tests next to this file pin where they
 * are applied.
 */

const WEATHER_MARKUP =
  '<tool_call><function=get_weather><parameter=date>today</parameter><parameter=city>上海</parameter></function></tool_call>';

const REASONING_LEAK = `The user is repeating their earlier message about going to town this afternoon and not being back until evening. But it's currently 23:30 at night - late night. So they're probably already back, or... wait, they said "今天下午去镇上办点事，可能要到晚上才回来" - this was the first message of the conversation. Now they're saying it again at 23:30.

Hmm, this could be a repeated message, or maybe they're just chatting. Since it's already 23:30 (late night), if they went in the afternoon and said they'd be back by evening, they should be home by now. I should respond naturally as a family member would - maybe noting it's already late and asking if they got back okay.都这么晚了，还没到家？到家了就早点歇着。`;

test('the weather turn\'s tool-call markup is removed, not spoken (baseline §4.1)', () => {
  const result = sanitizeSpokenReply(WEATHER_MARKUP, { language: 'zh-CN' });
  assert.equal(result.text, '', 'a markup-only reply leaves nothing to say');
  assert.equal(result.removedMarkupChars > 0, true);
  assert.equal(WEATHER_MARKUP.includes('<tool_call>'), true, 'the fixture really is the leaked form');
  // The shape that reached TTS also appears next to a real sentence.
  assert.equal(
    sanitizeSpokenReply(`${WEATHER_MARKUP}我给你查了一下，明天阴天。`, { language: 'zh-CN' }).text,
    '我给你查了一下，明天阴天。',
  );
});

test('an unterminated block is dropped too — a stream cut inside markup is not speech', () => {
  assert.equal(sanitizeSpokenReply('<tool_call><function=get_weather><parameter=date>tomorrow', { language: 'zh-CN' }).text, '');
  // …and a sentence before the cut still survives.
  assert.equal(
    sanitizeSpokenReply('我看看啊<tool_call><function=get_weather>', { language: 'zh-CN' }).text,
    '我看看啊',
  );
});

test('stray inner tags are removed even without their wrapper', () => {
  const stripped = stripToolCallMarkup('<function=get_weather><parameter=city>上海</parameter>');
  assert.equal(stripped.text, '');
  assert.equal(stripped.removedChars > 0, true);
  assert.equal(stripToolCallMarkup('查一下<parameter=city>上海</parameter>。').text, '查一下。');
});

test('the English reasoning leak keeps the Chinese line that was buried in it (baseline §4.2)', () => {
  const result = sanitizeSpokenReply(REASONING_LEAK, { language: 'zh-CN' });
  assert.equal(result.text, '都这么晚了，还没到家？到家了就早点歇着。');
  assert.equal(result.removedReasoningChars > 0, true);
  assert.equal(result.text.includes('The user'), false, 'no English reasoning may survive');
});

test('a reasoning-only reply leaves nothing to say', () => {
  const onlyReasoning = 'The user said they are tired. I should respond gently, maybe let them rest instead of asking questions.';
  const result = sanitizeSpokenReply(onlyReasoning, { language: 'zh-CN' });
  assert.equal(result.text, '');
  assert.equal(result.removedReasoningChars > 0, true);
});

test('ordinary talk is untouched — including a short English sentence', () => {
  for (const sentence of [
    '明天阴天，19到24度，不冷不热的。',
    'WiFi 密码我记不准，你别问我。',
    '那就不说，我陪你坐会儿。',
    'Sure, no problem.',
    '我记得好像你说过下周三要去医院复查。',
  ]) {
    assert.equal(sanitizeSpokenReply(sentence, { language: 'zh-CN' }).text, sentence, `${sentence} must pass through`);
    assert.equal(sanitizeSpokenReply(sentence, { language: 'zh-CN' }).removedChars, 0);
  }
});

test('an English deployment is not "fixed" — only markup goes there', () => {
  const result = sanitizeSpokenReply(REASONING_LEAK, { language: 'en-US' });
  // The Chinese tail is still in there; what matters is that the English body was left alone.
  assert.equal(result.text.includes('The user is repeating'), true);
  assert.equal(result.removedReasoningChars, 0);
  assert.equal(sanitizeSpokenReply(WEATHER_MARKUP, { language: 'en-US' }).text, '');
});

test('sanitizing is idempotent and never invents text', () => {
  const once = sanitizeSpokenReply(`${REASONING_LEAK}\n\n${WEATHER_MARKUP}`, { language: 'zh-CN' });
  const twice = sanitizeSpokenReply(once.text, { language: 'zh-CN' });
  assert.equal(twice.text, once.text);
  assert.equal(twice.removedChars, 0);
  // A reply that is only punctuation is not speech either.
  assert.equal(sanitizeSpokenReply(`${WEATHER_MARKUP}，`, { language: 'zh-CN' }).text, '');
});

test('stripForeignReasoning keeps a Chinese sentence that merely contains an English word', () => {
  assert.equal(stripForeignReasoning('我跟你说，这个 app 挺好用的。').text, '我跟你说，这个 app 挺好用的。');
});

// ---------------------------------------------------------------- the streaming hold

test('the streaming hold never emits half a tool-call marker', () => {
  const hold = createSpokenTextFilter({ language: 'zh-CN' });
  const emitted = [
    hold.push('明天'),
    hold.push('<tool_ca'),
    hold.push('ll><function=get_weather>'),
    hold.push(`</tool_call>明天阴天。`),
  ];
  assert.deepEqual(emitted, ['明天', '', '', '明天阴天。'], 'only text outside the block may be spoken early');
  assert.equal(hold.flush(), '', 'nothing is left over once the block closed');
});

test('a lone "<" is released as soon as the next character disproves a marker', () => {
  const hold = createSpokenTextFilter({ language: 'zh-CN' });
  assert.equal(hold.push('我要是 <'), '我要是 ');
  assert.equal(hold.push('3 点还没睡'), '<3 点还没睡');
  assert.equal(hold.flush(), '');
});

test('an unterminated block cannot buffer a whole turn', () => {
  const hold = createSpokenTextFilter({ language: 'zh-CN' });
  const huge = `<tool_call>${'x'.repeat(3000)}`;
  assert.equal(hold.push(huge), '');
  assert.equal(hold.flush(), '');
});

test('a streamed English opening is held until the Chinese decides it', () => {
  const hold = createSpokenTextFilter({ language: 'zh-CN' });
  assert.equal(hold.push('The user is repeating their earlier message about going'), '');
  assert.equal(hold.push(' to town and not being back until evening. '), '');
  assert.equal(hold.push('都这么晚了，还没到家？'), '都这么晚了，还没到家？', 'the preamble is dropped, the Chinese is spoken');
  assert.equal(hold.push('到家了就早点歇着。'), '到家了就早点歇着。', 'after that the stream flows untouched');
});

test('a short English opening word is not treated as reasoning', () => {
  const hold = createSpokenTextFilter({ language: 'zh-CN' });
  assert.equal(hold.push('OK，'), '', 'held only until the first Chinese character decides it');
  assert.equal(hold.push('我看看。'), 'OK，我看看。', 'a two-letter opening is not a reasoning preamble');
});

test('an all-English reply is released at the end when it is short, dropped when it is reasoning', () => {
  const short = createSpokenTextFilter({ language: 'zh-CN' });
  assert.equal(short.push('Sure, no problem.'), '');
  assert.equal(short.flush(), 'Sure, no problem.', 'a short English line is still a reply');

  const long = createSpokenTextFilter({ language: 'zh-CN' });
  long.push(REASONING_LEAK);
  assert.equal(long.flush(), '', 'a long English body never becomes speech');

  const englishDeployment = createSpokenTextFilter({ language: 'en-US' });
  assert.equal(englishDeployment.push('The user is repeating'), 'The user is repeating', 'no such hold abroad');
});
