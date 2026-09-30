import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeReplyText,
  REPLY_LIMITS,
  resolveReplyLimits,
  splitReplyIntoSegments,
} from '@xixi/conversation';

/**
 * ADR-0010's M1–M5 clauses, tested as behaviour rather than by example.
 *
 * The splitter is the whole "multi-segment" feature's deterministic half, so the
 * assertions here are the contract: segment counts, per-segment length, the gap,
 * the concatenation invariant and where a split may fall. What the state machine
 * does with them (M6/M7/M8) is covered in the integration test.
 */

/** A sentence of exactly `length` characters ending in a full stop. */
function sentence(length: number, filler = '字'): string {
  return filler.repeat(length - 1) + '。';
}

test('M4: segments always concatenate back to the normalized reply', () => {
  const cases = [
    '',
    '   ',
    '\n\n',
    '好。',
    sentence(20) + sentence(20),
    sentence(70),
    sentence(40).repeat(5),
    '一。\n二。\n\n三。',
    '[静默]',
    '前半句没有标点后半句也没有',
  ];
  for (const text of cases) {
    const { segments } = splitReplyIntoSegments(text);
    assert.equal(
      segments.join(''),
      normalizeReplyText(text),
      `join must equal normalize(${JSON.stringify(text)}) — no character may be added or dropped`,
    );
  }
});

test('normalizeReplyText only removes line breaks and surrounding whitespace', () => {
  assert.equal(normalizeReplyText('一。\n二。'), '一。二。');
  assert.equal(normalizeReplyText('  一。二。  '), '一。二。');
  assert.equal(normalizeReplyText('一。\r\n二。'), '一。二。');
  // Characters are never changed, only whitespace between lines is removed.
  assert.equal(normalizeReplyText('一。\n\n二。'), '一。二。');
});

test('M1/M2: a reply that fits the capacity is split into at most 3 segments of at most 60', () => {
  // Two 40-character sentences: 80 characters, so it cannot be one segment.
  const two = splitReplyIntoSegments(sentence(40, '甲') + sentence(40, '乙'));
  assert.equal(two.segments.length, 2);
  assert.deepEqual(two.segments, [sentence(40, '甲'), sentence(40, '乙')]);
  assert.equal(two.mergedOverflow, false);

  // Three 50-character sentences: 150 characters, exactly the 3 × 50 an ADR
  // expects, and every segment stays under the ceiling.
  const three = splitReplyIntoSegments(sentence(50, '甲') + sentence(50, '乙') + sentence(50, '丙'));
  assert.equal(three.segments.length, 3);
  for (const segment of three.segments) {
    assert.ok(segment.length >= 1 && segment.length <= REPLY_LIMITS.segmentMaxChars, `bad length ${segment.length}`);
  }
  assert.equal(three.mergedOverflow, false);

  // A single sentence longer than the ceiling is chopped at the ceiling.
  const long = splitReplyIntoSegments(sentence(130));
  assert.equal(long.segments.length, 3);
  assert.deepEqual(long.segments.map((segment) => segment.length), [60, 60, 10]);
  assert.equal(long.segments.join(''), sentence(130));
});

test('M1 beyond capacity: the tail merges into the last segment and mergedOverflow says so', () => {
  // 5 × 40 = 200 characters > 3 × 60 = 180: both ceilings cannot hold, and the
  // documented choice is to keep every character instead of dropping the tail.
  const text = sentence(40, '甲') + sentence(40, '乙') + sentence(40, '丙') + sentence(40, '丁') + sentence(40, '戊');
  const result = splitReplyIntoSegments(text);
  assert.equal(result.segments.length, 3, 'the segment ceiling is the one that holds');
  assert.deepEqual(result.segments.map((segment) => segment.length), [40, 40, 120]);
  assert.equal(result.mergedOverflow, true);
  assert.equal(result.segments.join(''), text, 'nothing may be dropped to satisfy the length ceiling');
});

test('asking for more segments than allowed is clamped, never honoured', () => {
  const result = splitReplyIntoSegments(sentence(40, '甲') + sentence(40, '乙') + sentence(40, '丙') + sentence(40, '丁'), {
    maxSegments: 5,
  });
  assert.equal(result.segments.length, 3);
  assert.equal(result.mergedOverflow, true, 'a caller asking for 5 must be told it did not get 5');
});

test('M3: the gap is clamped into [250, 1200] and defaults to 450', () => {
  assert.equal(splitReplyIntoSegments('好。').gapMs, REPLY_LIMITS.defaultGapMs);
  assert.equal(splitReplyIntoSegments('好。').gapMs, 450);
  assert.equal(splitReplyIntoSegments('好。', { gapMs: 100 }).gapMs, 250);
  assert.equal(splitReplyIntoSegments('好。', { gapMs: 5_000 }).gapMs, 1_200);
  assert.equal(splitReplyIntoSegments('好。', { gapMs: 300 }).gapMs, 300);
  assert.equal(splitReplyIntoSegments('好。', { gapMs: Number.NaN }).gapMs, 450);
});

test('M5: a split falls after sentence enders, not in the middle of a sentence', () => {
  const result = splitReplyIntoSegments('一二三四五。六七八九十。', { segmentMaxChars: 10 });
  assert.deepEqual(result.segments, ['一二三四五。', '六七八九十。']);
  // Every segment but the last ends on a sentence ender, which is the property
  // the audible pause depends on.
  const enders = /[。！？!?…]$/;
  for (const segment of result.segments.slice(0, -1)) assert.match(segment, enders);
});

test('M5: the silence token is never split, whatever the limits say', () => {
  // §55 judges the token as a whole; segmenting it would break that rule.
  assert.deepEqual(splitReplyIntoSegments('[静默]').segments, ['[静默]']);
  assert.deepEqual(splitReplyIntoSegments('[静默]', { segmentMaxChars: 1, maxSegments: 1 }).segments, ['[静默]']);
  assert.deepEqual(splitReplyIntoSegments('  [静默]  ', { segmentMaxChars: 2 }).segments, ['[静默]']);
});

test('empty or whitespace-only text yields no segments', () => {
  assert.deepEqual(splitReplyIntoSegments('').segments, []);
  assert.deepEqual(splitReplyIntoSegments('   \n  ').segments, []);
});

test('resolveReplyLimits reads the config section, clamps it and lets an override win', () => {
  // The config as written in config/xixi.example.yaml.
  assert.deepEqual(resolveReplyLimits({ max_segments: 3, segment_max_chars: 60, gap_ms: 450 }), {
    maxSegments: 3,
    segmentMaxChars: 60,
    gapMs: 450,
  });
  // Tightening is allowed…
  assert.deepEqual(resolveReplyLimits({ max_segments: 2, segment_max_chars: 30, gap_ms: 300 }), {
    maxSegments: 2,
    segmentMaxChars: 30,
    gapMs: 300,
  });
  // …raising a ceiling is not.
  assert.deepEqual(resolveReplyLimits({ max_segments: 9, segment_max_chars: 999, gap_ms: 60_000 }), {
    maxSegments: 3,
    segmentMaxChars: 60,
    gapMs: 1_200,
  });
  // Unusable values fall back to the documented defaults instead of crashing a turn.
  assert.deepEqual(resolveReplyLimits({ max_segments: '3', segment_max_chars: null, gap_ms: -5 }), {
    maxSegments: 3,
    segmentMaxChars: 60,
    gapMs: 250,
  });
  assert.deepEqual(resolveReplyLimits(undefined), { maxSegments: 3, segmentMaxChars: 60, gapMs: 450 });
  // The explicit test/replay override wins over the config and is clamped too.
  assert.equal(resolveReplyLimits({ max_segments: 3 }, { maxSegments: 1 }).maxSegments, 1);
  assert.equal(resolveReplyLimits({ max_segments: 1 }, { maxSegments: 3 }).maxSegments, 3);
  assert.equal(resolveReplyLimits({ max_segments: 1 }, { maxSegments: 3 }).maxSegments <= REPLY_LIMITS.maxSegments, true);
});

test('the splitter is pure: the same text always yields the same split', () => {
  const text = sentence(45, '甲') + sentence(45, '乙') + sentence(45, '丙');
  assert.deepEqual(splitReplyIntoSegments(text), splitReplyIntoSegments(text));
});
