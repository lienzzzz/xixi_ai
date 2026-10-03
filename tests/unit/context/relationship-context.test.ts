/**
 * 关系摘要那一段（pack `docs/02_MEMORY_CONTEXT.md` §6）。
 *
 * 三条纪律，每条一个用例：
 *   1. 只给**与当前行为有关的摘要**，不把全统计给 LLM（模型看到的是句子，不是 7 天窗口的每个计数）；
 *   2. **没有的数据不编**：打断率恒为 null（还没有落库的打断事件），「最近没主动开口」与
 *      「主动开口没人接」措辞不同；
 *   3. 档位与 `@xixi/conversation` 的 `personalityDirectives` **同一套区间**，所以
 *      「提示词里说她话多」与「关系摘要里说她话多」永远同时成立。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { personalityDirectives } from '@xixi/conversation';
import {
  buildRelationshipContext,
  parseContextMemorySettings,
  RELATIONSHIP_NOTE_LIMIT,
  relationshipRecentStats,
  relationshipStyleHints,
  renderRelationshipProse,
} from '@xixi/context';

const EMPTY_STATS = relationshipRecentStats({
  windowDays: 7,
  proactiveDelivered: 0,
  proactiveAccepted: 0,
  proactiveAcceptRate: null,
  unansweredProactiveRate: null,
  userTurns: 0,
});

test('档位跟着有效人格走，而且与提示词的说话方式用同一套区间', () => {
  const quiet = relationshipStyleHints({ proactivity: 0.1, curiosity: 0.1, verbosity: 0.1, humor: 0.1, talkativeness: 0.1 });
  const chatty = relationshipStyleHints({ proactivity: 0.95, curiosity: 0.9, verbosity: 0.95, humor: 0.9, talkativeness: 0.9 });
  assert.deepEqual(quiet, {
    proactivePreference: 'low',
    questionTolerance: 'low',
    explanationPreference: 'short',
    humorPreference: 'low',
  });
  assert.deepEqual(chatty, {
    proactivePreference: 'high',
    questionTolerance: 'high',
    explanationPreference: 'long',
    humorPreference: 'high',
  });

  // 一致性：关系摘要说「少主动起话头」时，提示词那边也**没有**在鼓励她主动接话。
  const quietPrompt = personalityDirectives({ proactivity: 0.1, talkativeness: 0.1, curiosity: 0.1, verbosity: 0.1, humor: 0.1 });
  assert.ok(quietPrompt.some((line) => line.includes('不要主动找话题') || line.includes('少主动起新话题')));
  const chattyPrompt = personalityDirectives({ proactivity: 0.95, talkativeness: 0.9, curiosity: 0.9, verbosity: 0.95, humor: 0.9 });
  assert.ok(chattyPrompt.some((line) => line.includes('可以主动接话')));
});

test('没有的数据不编：打断率恒为 null，措辞区分「没开口」与「没人接」', () => {
  const stats = relationshipRecentStats({
    windowDays: 7,
    proactiveDelivered: 4,
    proactiveAccepted: 0,
    proactiveAcceptRate: 0,
    unansweredProactiveRate: 1,
    userTurns: 2,
  });
  assert.equal(stats.interruptionRate, null, '打断还没有落库的事件，就不给一个数');
  assert.equal(stats.proactiveDelivered, 4);

  const never = renderRelationshipProse(relationshipStyleHints({}), EMPTY_STATS, []);
  assert.ok(never.some((line) => line.includes('还没主动开过口')), `最近没开口是一种处境：${JSON.stringify(never)}`);
  assert.ok(!never.some((line) => line.includes('大多没接')), '没开口不能写成「没人接」');

  const ignored = renderRelationshipProse(relationshipStyleHints({ proactivity: 0.85 }), stats, []);
  assert.ok(ignored.some((line) => line.includes('大多没接')), `没人接是另一种处境：${JSON.stringify(ignored)}`);

  // 模型看到的那几句里不许出现裸比率或参数名（与说话方式同一条纪律）。
  for (const line of [...never, ...ignored]) {
    assert.doesNotMatch(line, /\d\.\d/, `关系摘要里不该出现裸小数：${line}`);
    assert.doesNotMatch(line, /proactivity|questionTolerance|acceptRate/i, `也不该出现参数名：${line}`);
  }
});

test('关系笔记有限量：它们是「我们怎么相处」，不是「我们说过什么」', () => {
  const notes = Array.from({ length: 6 }, (_, index) => `这是第${index}条相处笔记`);
  const context = buildRelationshipContext({
    styleHints: relationshipStyleHints({}),
    recentStats: EMPTY_STATS,
    notes,
  });
  assert.equal(context.notes.length, 6, '结构化字段保留全部（面板要能核对）');
  assert.equal(
    context.prose.filter((line) => line.startsWith('这是第')).length,
    RELATIONSHIP_NOTE_LIMIT,
    `给模型的最多 ${RELATIONSHIP_NOTE_LIMIT} 条`,
  );
  // 空笔记不会被写成一个空行。
  assert.equal(buildRelationshipContext({ styleHints: relationshipStyleHints({}), recentStats: EMPTY_STATS, notes: ['  '] }).prose.some((line) => line.trim().length === 0), false);
});

test('context.memory 的读取：默认值、新段优先于老段、越界报错', () => {
  const defaults = parseContextMemorySettings(undefined, undefined);
  assert.equal(defaults.maxItems, 6);
  assert.equal(defaults.minConfidence, 0.55);
  assert.equal(parseContextMemorySettings({ max_items: 4 }, { max_items: 7 }).maxItems, 4);
  assert.equal(parseContextMemorySettings(undefined, { max_items: 7 }).maxItems, 7);
  assert.throws(() => parseContextMemorySettings({ max_items: 99 }), RangeError);
  assert.throws(() => parseContextMemorySettings({ min_confidence: -1 }), RangeError);
  assert.throws(() => parseContextMemorySettings({ min_items: '3' }), TypeError);
});
