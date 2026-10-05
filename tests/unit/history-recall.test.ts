import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TurnRecord } from '@xixi/domain';
import { historyRecallEnabled, recallHistory } from '../../packages/conversation/src/history-recall.ts';

const turn = (eventId: string, text: string, role: 'user' | 'assistant' = 'user'): TurnRecord => ({
  eventId, text, role, sessionId: 'fixture', turnIndex: 1, action: 'SPEAK', toolName: null,
  createdAt: '2026-10-05T10:00:00+08:00',
});
test('recall keeps whole quotes within byte and item caps and excludes current/recent and assistant', () => {
  const lines = recallHistory('木兰花', [turn('large', `木兰花${'很长'.repeat(2000)}`), turn('a', '木兰花代号蓝鲸'),
    turn('repeat', '木兰花代号蓝鲸'), turn('b', '木兰花暂时放在阳台'), turn('c', '木兰花助手秘密', 'assistant'),
    turn('recent', '木兰花最近原话'), turn('unrelated', '今天下雨了')], new Set(['recent']));
  assert.equal(lines.length, 2);
  assert.ok(Buffer.byteLength(lines.join('\n'), 'utf8') <= 2048);
  assert.ok(!lines.some((l) => l.includes('最近原话') || l.includes('秘密') || l.includes('很长')));
  for (const line of lines) assert.equal(typeof (JSON.parse(line) as { quote: unknown }).quote, 'string');
});
test('generic or unrelated query does not inject arbitrary history', () => {
  assert.deepEqual(recallHistory('天气下雨', [turn('a', '木兰花代号蓝鲸')], new Set()), []);
  assert.deepEqual(recallHistory('', [turn('a', '木兰花代号蓝鲸')], new Set()), []);
});
test('history recall switch validates explicit configuration', () => {
  assert.equal(historyRecallEnabled(undefined), true);
  assert.equal(historyRecallEnabled({ enabled: false }), false);
  for (const raw of [null, [], false, { enabled: 'false' }]) assert.throws(() => historyRecallEnabled(raw), /INVALID_HISTORY_RECALL/);
});
test('recall does not duplicate current or short-history quote text under another event id', () => {
  const text = '木兰花的代号是蓝鲸。';
  assert.deepEqual(recallHistory('木兰花', [turn('old', text), turn('recent', text)], new Set(['recent'])), []);
  assert.deepEqual(recallHistory(text, [turn('old', text)], new Set()), []);
});
