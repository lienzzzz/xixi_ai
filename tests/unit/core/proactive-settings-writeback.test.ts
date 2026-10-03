/**
 * pack v03-preflight ①：控制台把设置**回写**成 `config.proactive` 形状时漏键。
 *
 * 症状（t63 记录、pack §6 点名）：`proactiveSettingsToConfig` 只写回一半的键，而
 * `applyProactiveSettingsPatch` 是「把补丁合并进回写对象、再用 `parseProactiveSettings` 解析」——
 * 于是**改一个字段会把没写回的那些字段打回出厂默认值**，用户看到的数与他在文件里写的数不一致。
 *
 * 两条断言各钉一个层次：
 *   1. 结构层：`parseProactiveSettings(proactiveSettingsToConfig(x))` 必须与 `x` 逐字段相等 ——
 *      回写必须覆盖解析器读的**每一个**键（缺键 → 解析回落到默认值 → 不等）；
 *   2. 用户可见层：改一个字段之后，别的字段**不许**变成默认值。
 *
 * Run: `npm test`。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseProactiveSettings, type ProactiveSettings } from '@xixi/conversation';
import { openXixiStore } from '@xixi/domain';

import {
  applyProactiveSettingsPatch,
  persistProactiveSettings,
  proactiveSettingsToConfig,
  PROACTIVE_SETTINGS_SERVICE,
  restoreProactiveSettings,
} from '../../../scripts/field-test.ts';

/**
 * 一份**每个键都偏离出厂默认值**的设置（默认值见 `DEFAULT_PROACTIVE_SETTINGS`）。
 *
 * 为什么要每个键都不一样：只要有一个键等于默认值，缺键与写回就分不出来。
 */
const TUNED_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  enabled: false,
  base_cooldown_min: 9,
  continuation_cooldown_min: 3,
  max_per_6h: 5,
  max_per_day: 11,
  max_consults_per_day: 7,
  new_session_min_gap_min: 4,
  hot_chat_min_turns: 3,
  hot_chat_window_min: 20,
  topic_repeat_window_h: 6,
  generic_topic_cooldown_h: 30,
  unanswered_penalty: 0.31,
  explicit_reject_penalty: 0.66,
  same_topic_penalty: 0.42,
  unanswered_window_min: 15,
  negative_feedback_cooldown_multiplier: 3,
  quiet_hours: { start: '21:15', end: '06:45' },
  triggers: { random_smalltalk: true },
});

/** 回写形状必须带上的键：就是 `parseProactiveSettings` 读的那些（键名逐字抄自它）。 */
const EXPECTED_KEYS: readonly string[] = Object.freeze([
  'enabled',
  'base_cooldown_min',
  'continuation_cooldown_min',
  'max_per_6h',
  'max_per_day',
  'max_consults_per_day',
  'new_session_min_gap_min',
  'hot_chat_min_turns',
  'hot_chat_window_min',
  'topic_repeat_window_h',
  'generic_topic_cooldown_h',
  'unanswered_penalty',
  'explicit_reject_penalty',
  'same_topic_penalty',
  'unanswered_window_min',
  'negative_feedback_cooldown_multiplier',
  'quiet_hours',
  'triggers',
]);

test('proactiveSettingsToConfig 回写 parseProactiveSettings 读的每一个键（缺一个就打回默认值）', () => {
  const tuned: ProactiveSettings = parseProactiveSettings(TUNED_CONFIG);
  const defaults = parseProactiveSettings({});
  // 前提校验（不写辅助函数按名字推字段：配置键是缩写，机械转换会把 base_cooldown_min 变成
  // baseCooldownMin 而字段其实是 baseCooldownMinutes —— 那样「前提」本身就是错的）。
  assert.notDeepEqual(tuned, defaults, '这份输入必须整体偏离默认值，否则下面的往返断言是空的');
  for (const [field, value] of [
    ['baseCooldownMinutes', 9],
    ['continuationCooldownMinutes', 3],
    ['maxConsultsPerDay', 7],
    ['newSessionMinGapMinutes', 4],
    ['hotChatMinTurns', 3],
    ['hotChatWindowMinutes', 20],
    ['genericTopicCooldownHours', 30],
    ['unansweredPenalty', 0.31],
    ['explicitRejectPenalty', 0.66],
    ['sameTopicPenalty', 0.42],
    ['unansweredWindowMinutes', 15],
    ['negativeFeedbackCooldownMultiplier', 3],
  ] as const) {
    assert.equal(tuned[field], value, `测试输入里「${field}」要取一个与默认值不同的值`);
    assert.notEqual((defaults as unknown as Record<string, unknown>)[field], value, `「${field}」的取值不能等于默认值`);
  }

  const written = proactiveSettingsToConfig(tuned);
  const missing = EXPECTED_KEYS.filter((key) => !(key in written));
  assert.deepEqual(missing, [], `回写漏了这些键：${missing.join('、')}`);
  assert.deepEqual(parseProactiveSettings(written), tuned, '回写再解析必须逐字段等于原设置');
});

test('改一个字段不会把没写回的那些字段打回出厂默认值（用户可见症状）', () => {
  const tuned = parseProactiveSettings(TUNED_CONFIG);
  const patched = applyProactiveSettingsPatch(tuned, { maxPerDay: 12 });
  assert.deepEqual(patched.rejected, [], 'maxPerDay 是认识的字段');
  assert.equal(patched.settings.maxPerDay, 12, '改的那个字段生效');
  assert.equal(patched.settings.unansweredPenalty, tuned.unansweredPenalty, '别的字段保持用户设置');
  assert.equal(patched.settings.continuationCooldownMinutes, tuned.continuationCooldownMinutes, '热聊接话窗口也保持');
  assert.equal(patched.settings.maxConsultsPerDay, tuned.maxConsultsPerDay, '读空气额度也保持');
  assert.deepEqual(patched.settings.quietHours, tuned.quietHours, '静默时段也保持');
  assert.deepEqual(parseProactiveSettings(proactiveSettingsToConfig(patched.settings)), patched.settings);
});

/**
 * 存与读：`system.health` 的 `detail` 有 500 字上限（schema 写死的），而「整份设置 + 变更文案」
 * 在把每个键都写回之后是 600 多字。
 *
 * 这一条就是那个陷阱的看门人：旧代码在超限时**把 JSON 截断**（`slice(0, 470) + '…'`），写出一条
 * 永远解析不回来的记录 —— 症状是「面板上存过的设置，重启后变回了配置文件的值」。所以断言只有两条，
 * 但都是硬要求：写出来的 `detail` 必须是**合法 JSON**，而且必须**原样读得回来**。
 */
test('持久化：整份设置原样读得回来，且 detail 永远是合法 JSON、不超 500 字', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-proactive-audit-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite') });
  try {
    const tuned = parseProactiveSettings(TUNED_CONFIG);
    // 一次改了很多项：变更文案最长的情况（旧代码正是在这里开始截断）。
    const changes = Array.from({ length: 9 }, (_value, index) => `第 ${index + 1} 项：面板上改了一个名字挺长的设置，用来把变更文案撑长`);
    const event = persistProactiveSettings(store, tuned, changes);

    const detail = (event.payload as Record<string, unknown>)['detail'];
    assert.equal(typeof detail, 'string', 'detail 必须是字符串');
    assert.ok((detail as string).length <= 500, `detail 超过 schema 的 500 字上限：${(detail as string).length}`);
    const parsed = JSON.parse(detail as string) as Record<string, unknown>;
    assert.equal(parsed['v'], 1, '记录自带版本号（铁律 10）');

    const restored = restoreProactiveSettings(store, {});
    assert.equal(restored.source, 'console', '存过就必须认 console 这份，而不是回落到配置文件');
    assert.deepEqual(restored.settings, tuned, '存进去的每一个字段都要原样读回来');
    assert.ok(restored.changes.length > 0, '变更文案也要读得回来（被裁到前几条是可以的，全丢不行）');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

/** 旧形状（`settings` 对象）的记录仍然要读得回来：真实数据目录里已经有它们了。 */
test('持久化：旧的对象形状记录仍然读得回来（向后兼容）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-proactive-legacy-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite') });
  try {
    const legacy = JSON.stringify({ v: 1, settings: { max_per_day: 7, unanswered_penalty: 0.31, quiet_hours: { start: '21:15', end: '06:45' } }, changes: ['旧记录'] });
    store.recordHealth(PROACTIVE_SETTINGS_SERVICE, 'ok', legacy);
    const restored = restoreProactiveSettings(store, {});
    assert.equal(restored.source, 'console');
    assert.equal(restored.settings.maxPerDay, 7);
    assert.equal(restored.settings.unansweredPenalty, 0.31);
    assert.deepEqual(restored.settings.quietHours, { startMinutes: 21 * 60 + 15, endMinutes: 6 * 60 + 45 });
    assert.deepEqual(restored.changes, ['旧记录']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

/**
 * 另一半：`PROACTIVE_PATCH_FIELDS` 里的数字字段**必须真的会被应用**。
 *
 * 症状与缺键是同一类但方向相反（t63 记录）：页面列出「未回应惩罚」这类字段，保存返回成功，
 * 设置却一动不动 —— 用户看到的是「存了但没生效」，比明确拒绝更难查。
 */
test('PROACTIVE_PATCH_FIELDS 里的每个数字字段都能真的改到（没有「列了却不用」的字段）', () => {
  const start = parseProactiveSettings({});
  const values: Readonly<Record<string, number>> = Object.freeze({
    baseCooldownMinutes: 9,
    continuationCooldownMinutes: 3,
    maxPer6h: 5,
    maxPerDay: 12,
    topicRepeatWindowHours: 6,
    genericTopicCooldownHours: 30,
    unansweredPenalty: 0.31,
    explicitRejectPenalty: 0.66,
    sameTopicPenalty: 0.42,
    unansweredWindowMinutes: 15,
    negativeFeedbackCooldownMultiplier: 3,
  });

  for (const [field, value] of Object.entries(values)) {
    const patched = applyProactiveSettingsPatch(start, { [field]: value });
    assert.deepEqual(patched.rejected, [], `${field} 必须被认作可改字段`);
    assert.equal(
      (patched.settings as unknown as Record<string, unknown>)[field],
      value,
      `${field} 声明为可改，就必须真的改到（现在是「保存成功但没生效」）`,
    );
    assert.ok(patched.changes.length > 0, `${field} 生效了就必须出现在 changes 里`);
  }
});
