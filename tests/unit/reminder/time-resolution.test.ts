/**
 * V0.3 P2-E — 自然语言时刻 → 绝对时刻 + 时区（pack `docs/03_AGENT_PLUGIN.md` §7）。
 *
 * 这一组用例钉的是「解析结果对不对」，不是「解析器长什么样」：
 *
 *   1. **跨天**：「明天早上八点」在 9 月 30 日晚上说，落点是 10 月 1 日 08:00 —— 不是「今天」；
 *   2. **跨时区**：同一个瞬间、同一句话，在 Asia/Shanghai 与 America/New_York 解析出**不同的绝对时刻**
 *      （各自按当地墙上时间八点），这正是 due_at 必须连时区一起存的原因；
 *   3. 明确的日期、星期几、时长、「尽快」与「认不出来」各有可核对的落点与 `kind`；
 *   4. 默认时刻（只说哪天没说几点）来自 `reminders.default_time`，不是写死的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  DEFAULT_REMINDER_SETTINGS,
  formatZonedIso,
  loadXixiConfig,
  parseReminderSettings,
  resolveReminderWhen,
  zoneOffsetMinutes,
  zonedWallClock,
} from '@xixi/domain';
import { REPO_ROOT } from '@xixi/runtime';

const SHANGHAI = 'Asia/Shanghai';
const NEW_YORK = 'America/New_York';

/** 「今天有什么新闻？」那句话的提醒版：9 月 30 日 23:40（上海的晚上）。 */
const LATE_NIGHT = new Date('2026-09-30T23:40:00+08:00');

function resolve(when: string, now: Date = LATE_NIGHT, timezone = SHANGHAI, extra: { defaultTime?: { hour: number; minute: number }; asapMinutes?: number } = {}) {
  return resolveReminderWhen(when, { now, timezone, ...extra });
}

test('「明天早上八点」跨天解析：落点是第二天早上八点，不是今天', () => {
  const resolution = resolve('明天早上八点');
  assert.equal(resolution.kind, 'day_relative');
  assert.equal(resolution.timezone, SHANGHAI);
  assert.equal(resolution.dueAt, '2026-10-01T08:00:00.000+08:00');
  // 绝对时刻也对得上：2026-09-30T23:40+08:00 的次日 08:00 就是 2026-10-01T00:00Z。
  assert.equal(Date.parse(resolution.dueAt), Date.parse('2026-10-01T00:00:00Z'));
  assert.match(resolution.explain, /2026-10-01T08:00:00\.000\+08:00/);
});

test('同一句话、同一个瞬间，换个时区就换个绝对时刻（跨时区）', () => {
  const shanghai = resolve('明天早上八点', LATE_NIGHT, SHANGHAI);
  const newYork = resolve('明天早上八点', LATE_NIGHT, NEW_YORK);

  // 上海 23:40 的那一刻，纽约还是 9 月 30 日 11:40（-04:00）——「明天」是同一天，但绝对时刻不同。
  assert.equal(zonedWallClock(LATE_NIGHT, NEW_YORK).hour, 11);
  assert.equal(shanghai.dueAt, '2026-10-01T08:00:00.000+08:00');
  assert.equal(newYork.dueAt, '2026-10-01T08:00:00.000-04:00');
  assert.equal(Date.parse(shanghai.dueAt), Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(Date.parse(newYork.dueAt), Date.parse('2026-10-01T12:00:00Z'));
  assert.notEqual(shanghai.dueAt, newYork.dueAt, '时区不同，落点必须不同');
  // 偏移也各自对：这就是「due_at 必须与 timezone 一起存」的理由。
  assert.equal(zoneOffsetMinutes(new Date(Date.parse(shanghai.dueAt)), SHANGHAI), 480);
  assert.equal(zoneOffsetMinutes(new Date(Date.parse(newYork.dueAt)), NEW_YORK), -240);
});

test('时刻的几种说法：早上/晚上/下午/点半/只给小时', () => {
  const morning = new Date('2026-09-30T10:00:00+08:00');
  assert.equal(resolve('晚上七点', morning).dueAt, '2026-09-30T19:00:00.000+08:00');
  assert.equal(resolve('下午三点半', morning).dueAt, '2026-09-30T15:30:00.000+08:00');
  assert.equal(resolve('明晚八点').dueAt, '2026-10-01T20:00:00.000+08:00', '「明晚八点」是晚上八点，不是早上八点');
  assert.equal(resolve('中午12点', morning).dueAt, '2026-09-30T12:00:00.000+08:00', '中午 12 点仍是 12 点');
  assert.equal(resolve('凌晨一点', morning).dueAt, '2026-10-01T01:00:00.000+08:00', '凌晨一点已经过了：顺延到明天');
  // 只有时刻、没写哪一天：今天算过就顺延到明天（文档化的规则，不是猜）。
  const evening = resolve('晚上九点', morning);
  assert.equal(evening.kind, 'clock_only');
  assert.equal(evening.dueAt, '2026-09-30T21:00:00.000+08:00');
  assert.equal(resolve('晚上九点', new Date('2026-09-30T22:00:00+08:00')).dueAt, '2026-10-01T21:00:00.000+08:00');
});

test('时长、明确日期、星期几各有落点', () => {
  assert.equal(resolve('半小时后').dueAt, '2026-10-01T00:10:00.000+08:00');
  assert.equal(resolve('三小时后').dueAt, '2026-10-01T02:40:00.000+08:00');
  assert.equal(resolve('两天后').dueAt, '2026-10-02T23:40:00.000+08:00');
  assert.equal(resolve('半小时后').kind, 'duration');

  const absolute = resolve('2026-10-05 09:00');
  assert.equal(absolute.kind, 'absolute');
  assert.equal(absolute.dueAt, '2026-10-05T09:00:00.000+08:00');

  // 没写年份：今年这一天还没到就是今年，已经过了就是明年（9 月 30 日说 1 月 5 日）。
  assert.equal(resolve('10月1日').dueAt, '2026-10-01T09:00:00.000+08:00');
  assert.equal(resolve('1月5日').dueAt, '2027-01-05T09:00:00.000+08:00');

  // 星期几：断言的是「那一天确实是周三、且在未来一周半以内」，不写死日历常量。
  const nextWeek = resolve('下周三');
  assert.equal(nextWeek.kind, 'weekday');
  const wall = zonedWallClock(new Date(Date.parse(nextWeek.dueAt)), SHANGHAI);
  assert.equal(new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay(), 3, '落点必须是周三');
  const daysOut = (Date.parse(nextWeek.dueAt) - LATE_NIGHT.getTime()) / 86_400_000;
  assert.ok(daysOut > 1 && daysOut <= 14, `下周三应在 1–14 天之间：${daysOut}`);
});

test('「尽快」与「认不出来」都不编造时间，并且如实标出是哪一种', () => {
  const asap = resolve('尽快');
  assert.equal(asap.kind, 'asap');
  assert.equal(asap.dueAt, formatZonedIso(LATE_NIGHT, SHANGHAI), '尽快 = 立即到期（不假装有个时刻）');
  const garbage = resolve('看情况吧');
  assert.equal(garbage.kind, 'unparsed');
  assert.equal(garbage.dueAt, formatZonedIso(LATE_NIGHT, SHANGHAI));
  assert.match(garbage.explain, /unparsed/);
  // 空串走的是同一个分支（工具没给 when 时的默认值）。
  assert.equal(resolve('').kind, 'unparsed');
});

test('默认时刻与「尽快」的宽限来自 reminders 设置，而不是写死的 09:00', () => {
  const onlyDay = resolve('明天');
  assert.equal(onlyDay.dueAt, '2026-10-01T09:00:00.000+08:00', '出厂默认 09:00');
  const custom = resolve('明天', LATE_NIGHT, SHANGHAI, { defaultTime: { hour: 7, minute: 30 } });
  assert.equal(custom.dueAt, '2026-10-01T07:30:00.000+08:00');
  const asap = resolve('尽快', LATE_NIGHT, SHANGHAI, { asapMinutes: 5 });
  assert.equal(asap.kind, 'asap');
  assert.equal(asap.dueAt, '2026-09-30T23:45:00.000+08:00', '「尽快」+ 5 分钟宽限');
});

test('reminders 设置的解析：坏值退回出厂默认，不让一个错字把配置拦在门外', () => {
  assert.deepEqual(parseReminderSettings(undefined), DEFAULT_REMINDER_SETTINGS);
  assert.deepEqual(parseReminderSettings({ default_time: '09:00', asap_minutes: 0 }), DEFAULT_REMINDER_SETTINGS);
  const parsed = parseReminderSettings({ timezone: ' America/New_York ', default_time: '7:05', asap_minutes: 3 });
  assert.equal(parsed.timezone, NEW_YORK);
  assert.deepEqual(parsed.defaultTime, { hour: 7, minute: 5 });
  assert.equal(parsed.asapMinutes, 3);
  // 坏值：默认时刻回 09:00，宽限回 0；时区坏值回 null（跟随 identity.timezone）。
  const broken = parseReminderSettings({ timezone: '', default_time: '25:99', asap_minutes: -3 });
  assert.equal(broken.timezone, null);
  assert.deepEqual(broken.defaultTime, DEFAULT_REMINDER_SETTINGS.defaultTime);
  assert.equal(broken.asapMinutes, 0);
});

test('示例配置里的 reminders 段真的被读到（出厂值与代码默认逐字一致）', () => {
  const config = loadXixiConfig(join(REPO_ROOT, 'config', 'xixi.example.yaml'));
  assert.ok(config.reminders !== undefined, '示例配置必须有 reminders 段：文档与代码不能各说各话');
  assert.deepEqual(
    parseReminderSettings(config.reminders),
    DEFAULT_REMINDER_SETTINGS,
    '示例配置写的三项与出厂默认一致（改一处就要改另一处）',
  );
});
