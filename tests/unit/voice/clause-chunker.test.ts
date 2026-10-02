import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chunkClauses,
  CLAUSE_CHUNKER_LIMITS,
  ClauseChunker,
  isSafeCutIndex,
  unbreakableSpans,
  type ClauseChunk,
} from '../../../packages/conversation/src/segments.ts';

/**
 * Pack Phase 8's ClauseChunker: the online splitter that lets the first clause reach
 * TTS while the rest of the reply is still being generated.
 *
 * Three things are pinned here because a latency feature that splits text wrongly is
 * worse than no latency feature at all:
 *   1. nothing is invented, dropped or reordered (the concatenation invariant);
 *   2. the two 「不要切坏」 cases from the pack — decimals and URLs — are really safe,
 *      including when the mark arrives at the very end of a delta (lookahead);
 *   3. each of the four triggers fires for the reason it claims to (sentence / pause /
 *      max / flush), because the live path reports that reason next to its latency.
 */

function pushAll(chunker: ClauseChunker, deltas: readonly string[]): ClauseChunk[] {
  const out: ClauseChunk[] = [];
  for (const delta of deltas) out.push(...chunker.push(delta));
  return out;
}

const CONCAT_CASES: readonly (readonly string[])[] = [
  [''],
  ['好。'],
  ['第一句。第二句。'],
  ['嗯', '，', '我知道了。'],
  ['3.14 之后的', '一句。'],
  ['看这个 https://example.com/a，b 里的逗号不切。'],
  ['没有标点的很长一句话'.repeat(4)],
  ['  前导空格，后半句。'],
  ['好的，'],
  ['a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p'],
  ['省略号……然后呢。'],
];

test('ClauseChunker never invents, drops or reorders a character', () => {
  for (const deltas of CONCAT_CASES) {
    const text = deltas.join('');
    const chunker = new ClauseChunker();
    const chunks = pushAll(chunker, deltas);
    const tail = chunker.flush();
    const rejoined = [...chunks, ...tail].map((chunk) => chunk.text).join('');
    assert.equal(rejoined, text.trim(), `lost text for ${JSON.stringify(deltas)}`);
    // Spaces inside a clause are kept verbatim; only whitespace *at a cut* is trimmed,
    // so the stricter statement is about non-whitespace characters.
    assert.equal(rejoined.replace(/\s/g, ''), text.replace(/\s/g, ''), `lost a character for ${JSON.stringify(deltas)}`);
  }
});

test('ClauseChunker emits the first clause at the first sentence end, delta by delta', () => {
  const chunker = new ClauseChunker();
  // A realistic delta stream: the model hands out two or three characters at a time.
  const reply = '明天有小雨，出门记得带伞。温度大概十几度，不冷。';
  const deltas = reply.match(/.{1,3}/g) ?? [];
  const chunks = pushAll(chunker, deltas);
  assert.equal(chunks[0]?.text, '明天有小雨，出门记得带伞。', 'the first clause is emitted as soon as its full stop arrives');
  assert.equal(chunks[0]?.reason, 'sentence');
  // It is emitted before the second sentence has been generated at all: that is the point.
  let emittedAt = -1;
  let seen = '';
  for (let index = 0; index < deltas.length; index += 1) {
    seen += deltas[index];
    if (seen.includes(chunks[0]?.text ?? '') && emittedAt < 0) emittedAt = index;
  }
  assert.ok(emittedAt < deltas.length - 1, `the first clause left early (delta ${emittedAt} of ${deltas.length})`);
  const all = [...chunks, ...chunker.flush()].map((chunk) => chunk.text).join('');
  assert.equal(all, reply);
});

test('a comma is a release valve at the ceiling, guarded by a minimum length', () => {
  // Below the ceiling a comma is ignored: cutting 「好的，」 into its own clause would add a TTS
  // round trip and a hiccup for no latency gain (the sentence end releases the clause anyway).
  const chunker = new ClauseChunker();
  const chunks = pushAll(chunker, ['好的，我这就去看看。']);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['好的，我这就去看看。']);
  assert.equal(chunks[0]?.reason, 'sentence');

  // Past the ceiling the *last* eligible comma-like mark under it is used, so the piece stays
  // within the limit and the cut lands where a speaker would breathe. (A sentence end before the
  // ceiling still wins — that is the case just above.)
  const long = new ClauseChunker();
  const run = '字'.repeat(38); // no mark inside: only the ceiling can release it
  const longText = `${run}，然后呢`;
  const longChunks = pushAll(long, [longText]);
  assert.equal(longChunks[0]?.text, `${run}，`, 'the comma released it at the ceiling');
  assert.equal(longChunks[0]?.reason, 'pause');
  assert.ok((longChunks[0]?.text.length ?? 0) <= CLAUSE_CHUNKER_LIMITS.maxChars);
  assert.equal([...longChunks, ...long.flush()].map((chunk) => chunk.text).join(''), longText);

  // `minCommaChars` is what makes a comma eligible at all; raise it past the ceiling and the
  // ceiling has to chop instead.
  const strict = new ClauseChunker({ minCommaChars: 60 });
  const strictText = `${'字'.repeat(50)}，然后呢`;
  const strictChunks = pushAll(strict, [strictText]);
  assert.equal(strictChunks[0]?.reason, 'max');
  assert.ok((strictChunks[0]?.text.length ?? 0) <= CLAUSE_CHUNKER_LIMITS.maxChars);

  assert.equal(CLAUSE_CHUNKER_LIMITS.minCommaChars, 12, 'the documented threshold');
  assert.equal(CLAUSE_CHUNKER_LIMITS.maxChars, 40, 'and the documented ceiling');
});

test('maxChars releases a reply that has no punctuation at all (最大等待字符数)', () => {
  const chunker = new ClauseChunker({ maxChars: 12 });
  const text = '这句话里一个标点符号都没有整整二十个字符还要多';
  const chunks = pushAll(chunker, [text]);
  assert.equal(chunks.length, 1, 'the first ceiling-length piece is released immediately');
  assert.equal(chunks[0]?.reason, 'max');
  assert.ok((chunks[0]?.text.length ?? 0) <= 12, `the ceiling piece must not exceed maxChars: ${chunks[0]?.text}`);
  assert.ok((chunks[0]?.text.length ?? 0) >= 11, 'and it uses the ceiling rather than stopping early');
  const all = [...chunks, ...chunker.flush()].map((chunk) => chunk.text);
  assert.deepEqual(all.join(''), text, 'and the rest follows at flush time');
  for (const piece of all.slice(0, -1)) assert.ok(piece.length <= 12, `over the ceiling: ${piece}`);
  assert.equal(chunker.overlong, 0, 'nothing was indivisible here');
  // The ceiling is the last resort: with a mark available the cut happens there instead.
  const punctuated = new ClauseChunker({ maxChars: 12 });
  assert.deepEqual(pushAll(punctuated, ['短句。然后是一个更长一些的句子。']).map((chunk) => chunk.text), ['短句。', '然后是一个更长一些的句子。']);
});

test('a decimal number and a URL are never cut, even when the mark is the last delta', () => {
  const chunker = new ClauseChunker({ minCommaChars: 4, maxChars: 30 });
  // Each delta ends right after the dangerous mark — the lookahead case that used to split.
  const deltas = ['圆周率是 3.', '14159，够了。'];
  const chunks = pushAll(chunker, deltas);
  const all = [...chunks, ...chunker.flush()].map((chunk) => chunk.text).join('');
  assert.equal(all, deltas.join(''));
  assert.ok(all.includes('3.14'), 'the number stayed whole');
  for (const chunk of chunks) assert.ok(!chunk.text.endsWith('3.'), `split inside the decimal: ${chunk.text}`);

  const url = new ClauseChunker({ minCommaChars: 4 });
  const urlDeltas = ['地址是 https://examp', 'le.com/a，后面还有字。'];
  const urlChunks = pushAll(url, urlDeltas);
  const urlAll = [...urlChunks, ...url.flush()].map((chunk) => chunk.text).join('');
  assert.equal(urlAll, urlDeltas.join(''));
  for (const chunk of urlChunks) {
    assert.ok(!/https?:\/\/\S*$/.test(chunk.text) || chunk.text.endsWith('。'), `split inside the URL: ${chunk.text}`);
  }
  assert.ok(urlAll.includes('https://example.com/a，'), 'the URL (with its internal comma) is intact');
});

test('isSafeCutIndex and unbreakableSpans expose the guard itself', () => {
  const text = '版本 v2.6 和 https://a.b/c 都在。';
  const spans = unbreakableSpans(text);
  const decimal = text.indexOf('.');
  const url = text.indexOf('https');
  assert.equal(isSafeCutIndex(text, decimal, spans), false, 'the dot of v2.6');
  assert.equal(isSafeCutIndex(text, text.indexOf('.', url), spans), false, 'the dot of the host');
  assert.equal(isSafeCutIndex(text, text.length - 1, spans), true, 'after 。 a cut is fine');
  assert.equal(unbreakableSpans('3.14').length, 1);
  assert.equal(unbreakableSpans('没有数字').length, 0);
});

test('flush releases the tail and chunkClauses is the one-shot form', () => {
  const chunker = new ClauseChunker();
  assert.deepEqual(pushAll(chunker, ['还没说完']), []);
  assert.equal(chunker.pending, '还没说完');
  assert.deepEqual(chunker.flush().map((chunk) => chunk.text), ['还没说完']);
  assert.equal(chunker.pending, '');
  assert.deepEqual(chunker.flush(), [], 'flushing twice is empty, not an empty clause');

  assert.deepEqual(chunkClauses('第一句。第二句'), ['第一句。', '第二句']);
  assert.deepEqual(chunkClauses('   '), []);
  assert.deepEqual(chunkClauses(''), []);
});

test('a run of marks is one clause, not one per mark', () => {
  const chunker = new ClauseChunker();
  const chunks = pushAll(chunker, ['真的吗？！', '我不信……', '算了。']);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['真的吗？！', '我不信……', '算了。']);
});
