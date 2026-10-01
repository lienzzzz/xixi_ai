/**
 * 话题引擎（pack Phase 3）的规则测试。
 *
 * 这一层只问**规则对不对**：什么样的句子算「一件没办完的事」、什么时候才该问、被回应之后落成哪种状态。
 * 端到端的故事（Day1 说 → Day2 问 → 回答后收口）在 `tests/integration/open-thread-followup.test.ts`。
 *
 * 时间一律用本地时间构造（`new Date(2026, 9, 2, 15, 0, 0)`），所以数字在任何时区下都一样。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildEvent, toOffsetIso } from '@xixi/contracts';
import {
  classifyThreadAnswer,
  DEFAULT_TOPIC_ENGINE_SETTINGS,
  extractOpenThreads,
  followUpHintFor,
  parseTopicEngineSettings,
  TopicEngine,
  type TopicEngineSettings,
} from '@xixi/conversation';
import { loadXixiConfig, OpenThreadStore, openXixiStore } from '@xixi/domain';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const DAY1 = new Date(2026, 9, 1, 20, 0, 0);

function extract(text: string, at: Date = DAY1, settings?: TopicEngineSettings) {
  return extractOpenThreads({ text, at, sourceEventId: 'evt_00000000-0000-4000-8000-000000000001', settings });
}

test('「明天下午我要去镇上办证」被认成一件没办完的事', () => {
  const [thread] = extract('明天下午我要去镇上办证。');
  assert.ok(thread !== undefined, '时间词 + 意愿 + 动作三者齐备，就该记下来');
  assert.equal(thread.summary, '明天下午我要去镇上办证');
  assert.equal(thread.subject, '去镇上办证');
  assert.equal(thread.followAfter, toOffsetIso(new Date(2026, 9, 2, 14, 0, 0)), '「明天下午」= 第二天 14:00');
  assert.equal(thread.expireAt, toOffsetIso(new Date(2026, 9, 4, 14, 0, 0)), '追问窗口 = 48 小时');
  assert.equal(thread.importance, 0.85, '办证这类事更值得惦记');
  assert.match(thread.followUpHint ?? '', /去镇上办证/);
  assert.equal(thread.sourceEventId, 'evt_00000000-0000-4000-8000-000000000001');
});

test('同一句话永远得到同一个话题 id（重放不会多记一件事）', () => {
  const first = extract('明天下午我要去镇上办证。')[0];
  const second = extract('明天下午我要去镇上办证。')[0];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.threadId, second.threadId);
  assert.match(first.threadId, /^thread_[a-z0-9]{4,32}$/, '事件 schema 的 pattern');
});

test('不该记的句子：没有意愿、没有动作、没有将来的时间', () => {
  assert.deepEqual(extract('明天天气怎么样？'), [], '有时间词但没有意愿/动作');
  assert.deepEqual(extract('明天会下雨吗'), []);
  assert.deepEqual(extract('昨天我去镇上办了证。'), [], '已经发生的事不是未完话题');
  assert.deepEqual(extract('嗯。'), []);
  assert.deepEqual(extract('明天'), [], '太短，不构成一件事');
});

test('时间词：下周按 7 天后、今晚按当天 19 点算', () => {
  const nextWeek = extract('下周一我要去医院复诊。')[0];
  assert.ok(nextWeek !== undefined);
  assert.equal(nextWeek.followAfter, toOffsetIso(new Date(2026, 9, 8, 9, 0, 0)));

  const tonight = extract('今晚我要开会。')[0];
  assert.ok(tonight !== undefined);
  assert.equal(tonight.followAfter, toOffsetIso(new Date(2026, 9, 1, 19, 0, 0)));

  const tomorrowMorning = extract('明天上午我得去交材料。')[0];
  assert.ok(tomorrowMorning !== undefined);
  assert.equal(tomorrowMorning.followAfter, toOffsetIso(new Date(2026, 9, 2, 9, 0, 0)), '「上午」= 9 点');
});

test('关掉开关就不提取', () => {
  assert.deepEqual(extract('明天下午我要去镇上办证。', DAY1, { ...DEFAULT_TOPIC_ENGINE_SETTINGS, enabled: false }), []);
});

test('追问短句由模板渲染，能看出问的是哪件事', () => {
  assert.equal(followUpHintFor('明天下午我要去镇上办证', '去镇上办证'), '你之前说过要去镇上办证，后来怎么样了？');
  assert.match(followUpHintFor('明天要交材料', null), /交材料/);
});

test('用户的回答落成三种收口，且都不再追问', () => {
  assert.equal(classifyThreadAnswer('办好了，昨天就办完了。'), 'resolved');
  assert.equal(classifyThreadAnswer('办妥了'), 'resolved');
  assert.equal(classifyThreadAnswer('还没办，过两天再去。'), 'snoozed');
  assert.equal(classifyThreadAnswer('没去成，改天再说吧。'), 'snoozed');
  assert.equal(classifyThreadAnswer('嗯，你问这个干嘛。'), 'engaged');
  // 否定优先于肯定：「还没办好」不是「办好了」。
  assert.equal(classifyThreadAnswer('还没办好呢'), 'snoozed');
});

test('设置：非数字/非布尔退回默认，越界被夹进合法区间，出厂 config 与代码默认逐字一致', () => {
  assert.deepEqual(parseTopicEngineSettings(undefined), DEFAULT_TOPIC_ENGINE_SETTINGS);
  assert.deepEqual(
    parseTopicEngineSettings({ enabled: 'yes', reoffer_after_min: null, max_attempts: undefined, followup_window_h: {}, topic_dedupe_h: [] }),
    DEFAULT_TOPIC_ENGINE_SETTINGS,
    '调参段里的坏值不能让对话崩掉',
  );
  // 越界值走的是 `parseProactiveSettings` 同一套口径（夹进区间），不是抛错。
  assert.deepEqual(parseTopicEngineSettings({ reoffer_after_min: -5, max_attempts: 999, followup_window_h: 0 }), {
    ...DEFAULT_TOPIC_ENGINE_SETTINGS,
    reofferAfterMinutes: 1,
    maxAttempts: 10,
    followupWindowHours: 1,
  });
  assert.equal(parseTopicEngineSettings({ reoffer_after_min: 30 }).reofferAfterMinutes, 30);

  // 出厂配置里的 open_threads 段必须与代码默认一致（否则文档与行为会各说各话）。
  const config = loadXixiConfig(join(REPO_ROOT, 'config', 'xixi.example.yaml'));
  assert.deepEqual(parseTopicEngineSettings(config.openThreads), DEFAULT_TOPIC_ENGINE_SETTINGS);
});

test('话题去重：同一件事刚被问过，另一条话题记录不再摆出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-topic-dedupe-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => DAY1 });
  try {
    const threads = new OpenThreadStore(store);
    const followAfter = toOffsetIso(new Date(2026, 9, 1, 10, 0, 0));
    const offeredAt = new Date(2026, 9, 1, 12, 0, 0);

    // 第一件事：12:00 被主动问过，13:00 用户回答「办好了」→ 收口。
    threads.create({ threadId: 'thread_aaaaaaa', summary: '明天下午我要去镇上办证', followAfter });
    store.appendEvent(
      buildEvent({
        event_type: 'proactive.decision',
        source: 'conversation',
        actor: 'system',
        confidence: 1,
        timestamp: toOffsetIso(offeredAt),
        payload: { candidate_id: 'loop-1', trigger: 'future_hook_due', speak: true, reason_code: 'PASSED', topic_ref: 'thread_aaaaaaa' },
      }),
    );
    threads.transition('thread_aaaaaaa', 'offered', { offered: true, at: offeredAt });
    threads.transition('thread_aaaaaaa', 'resolved', { at: new Date(2026, 9, 1, 13, 0, 0) });

    // 第二件事：同一句话又被提了一次（新的轮次 → 新的话题 id），16:00 就轮到它了。
    threads.create({ threadId: 'thread_bbbbbbb', summary: '明天下午我要去镇上办证', followAfter });

    const engine = new TopicEngine({ store, clock: () => new Date(2026, 9, 1, 16, 0, 0) });
    const now = new Date(2026, 9, 1, 16, 0, 0);
    assert.equal(engine.followUps(now).length, 0, '12 小时窗口内同一个话题不再重复问');

    // 窗口过去之后（第二天同一时刻）它可以再被考虑。
    const later = new Date(2026, 9, 2, 16, 0, 0);
    const followUps = engine.followUps(later);
    assert.equal(followUps.length, 1);
    assert.equal(followUps[0]?.threadId, 'thread_bbbbbbb');
    assert.equal(engine.topicCandidates(later)[0]?.source, 'open_thread');
    assert.equal(engine.topicCandidates(later)[0]?.score, 1, 'pack §9：OpenThread 的优先级分是 1.00');
  } finally {
    store.close();
  }
});
