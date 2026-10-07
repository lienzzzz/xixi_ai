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

/**
 * V0.3 P2.5-J 修的缺陷二：关系笔记**没有听众过滤**。
 *
 * 改之前 `buildRelationshipContext` 收下 `notes` 就直接压成散文 —— 它连「谁在听」都不接，
 * 于是「他嫌话多：少说、少主动、少追问」这类相处细节在 `public`（有外人 / 电视 / 媒体在场）
 * 下也会进模型可见的文本。`relationship_notes` 表没有逐条可见性的列，所以能做的只有按听众
 * 模式整批给或整批不给：`private` / `family` 照旧，`public` 一条都不给（计划文档 Issue B 的
 * 保守解，与未完话题在 `public` 下的既有做法一致）。
 *
 * 这条用例压的是**过滤发生在选择阶段**：`notes` 与 `prose` 一起是空的，而不是「散文里有、
 * 指望模型自己不说」。反事实（本任务实测过）：把 `notesVisibleTo` 改成恒等返回（不过滤），
 * 下面 public 那两组断言同时红。
 */
test('关系笔记按听众过滤：public 下一条都不给，而且是选择阶段就丢掉', () => {
  const notes = ['他嫌话多：少说、少主动、少追问', '他喜欢被叫「爸」'];
  const base = { styleHints: relationshipStyleHints({}), recentStats: EMPTY_STATS, notes };

  // 没给听众（= 保守的 family）、家里人在场、只有父亲：三种都照旧看得到（这是既有行为，不许回退）。
  const visible = [
    buildRelationshipContext(base),
    buildRelationshipContext({ ...base, audience: { mode: 'family', actor: null, note: '家里人在场' } }),
    buildRelationshipContext({ ...base, audience: { mode: 'private', actor: 'father', note: '只有父亲' } }),
  ];
  for (const context of visible) {
    assert.deepEqual(context.notes, notes, '这几个听众下笔记照旧全部保留');
    for (const note of notes) {
      assert.ok(context.prose.some((line) => line.includes(note)), `散文里也照旧有它：${note}`);
    }
  }

  // 有外人可能：一条都不给 —— 结构化的 `notes` 与给模型的 `prose` 同时为空。
  const withPublic = buildRelationshipContext({ ...base, audience: { mode: 'public', actor: 'unknown_person', note: '有外人在' } });
  assert.deepEqual(withPublic.notes, [], '结构化字段也一起空：面板看到的 = 模型看到的');
  for (const note of notes) {
    assert.equal(
      withPublic.prose.some((line) => line.includes(note)),
      false,
      `public 下这条笔记不许出现在任何一句里：${note}`,
    );
  }
  // 「整段不出现」与「真的过滤了」长得不一样，所以留一条与听众无关的断言：
  // 没有外人时该说的那几句照旧在（否则这条用例可能只因为散文全空而绿）。
  assert.ok(withPublic.prose.length > 0, `关系摘要本身还在：${JSON.stringify(withPublic.prose)}`);
  assert.ok(withPublic.prose.some((line) => line.includes('还没主动开过口')), '与听众无关的那一句照旧');

  // 限量照旧（过滤不会把 `RELATIONSHIP_NOTE_LIMIT` 一起改掉）。
  const many = buildRelationshipContext({
    styleHints: relationshipStyleHints({}),
    recentStats: EMPTY_STATS,
    notes: Array.from({ length: 6 }, (_, index) => `这是第${index}条相处笔记`),
  });
  assert.equal(many.prose.filter((line) => line.startsWith('这是第')).length, RELATIONSHIP_NOTE_LIMIT);
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
