/**
 * The durable reminder's domain face (pack `docs/03_AGENT_PLUGIN.md` §7) — 「记着一件事，到点提醒」.
 *
 * Three things are pinned here and consumed everywhere else:
 *
 *   1. **The eight fields are the pack's eight fields**: `id` / `owner` / `what` / `due_at` /
 *      `timezone` / `status` / `created_at` / `source_event_id`. The extra columns are process
 *      facts the scheduler and a restart need (see `008_reminders.sql`); they do not change the
 *      eight-field table.
 *   2. **Five states, one direction**: `pending → due → candidate → delivered → acknowledged`
 *      (pack §7's `notification/proactive candidate` is the `candidate` state). Every change writes
 *      one `reminder.changed` event **in the same transaction** as the row update, so 「到点」 is a
 *      fact in the log rather than a line printed to a console, and a restart cannot lose it.
 *   3. **No natural-language `when` is ever stored**: {@link resolveReminderWhen} turns 「明天早上八点」
 *      into an absolute instant **plus** the IANA zone it was resolved in, and the table has no
 *      column that could hold the raw text.
 *
 * The model takes part in none of these steps (铁律 1): the parse is a program rule, the states are
 * written by the program, and who/what/when come from the entry that owns the turn (铁律 8).
 */
import { randomUUID } from 'node:crypto';

import { buildEvent, newCorrelationId, toOffsetIso, type EventEnvelope, type JsonValue } from '@xixi/contracts';

import { DomainError } from './errors.ts';
import type { StoredEvent, XixiStore } from './store.ts';

/**
 * pack §7's chain, as five states.
 *
 * `candidate` is the pack's 「notification/proactive candidate」: the reminder has become something
 * she may say out loud, but has not said it yet. Deliberately **no sixth state** (no `cancelled`,
 * no `expired`): the pack lists five, and a reminder nobody acknowledged stays visible in the
 * `delivered` state rather than being quietly dropped.
 */
export const REMINDER_STATUSES = Object.freeze(['pending', 'due', 'candidate', 'delivered', 'acknowledged'] as const);

export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

/**
 * The legal moves. One direction only, one step at a time:
 *
 * ```text
 * pending → due → candidate → delivered → acknowledged
 * ```
 *
 * A reminder may not be delivered before it is due, may not be acknowledged before it was said,
 * and may not be re-opened once acknowledged — 「不得重复执行已发出的外部动作」(AGENTS.md §3) has a
 * reminder-shaped twin: nobody should be reminded of the same thing twice because a state went
 * backwards.
 */
export const REMINDER_NEXT_STATUSES: Readonly<Record<ReminderStatus, readonly ReminderStatus[]>> = Object.freeze({
  pending: Object.freeze(['due'] as const),
  due: Object.freeze(['candidate'] as const),
  candidate: Object.freeze(['delivered'] as const),
  delivered: Object.freeze(['acknowledged'] as const),
  acknowledged: Object.freeze([] as ReminderStatus[]),
});

/** Program reason codes (one per transition); the log carries these, never a model-written sentence. */
export const REMINDER_REASON_CODES = Object.freeze([
  'reminder_created',
  'reminder_due',
  'reminder_candidate',
  'reminder_delivered',
  'reminder_acknowledged',
] as const);

export type ReminderReasonCode = (typeof REMINDER_REASON_CODES)[number];

/**
 * How a `due_at` was obtained. A **program enum**, not the user's words:
 *
 *   * `absolute`   — an explicit calendar date (+ time) was given;
 *   * `day_relative` — 今天/明天/后天 (+ time);
 *   * `weekday`    — 周三 / 下周三 (+ time);
 *   * `clock_only` — a time of day with no day (today, or tomorrow when it has passed);
 *   * `duration`   — 半小时后 / 三小时后 / 两天后;
 *   * `asap`       — 尽快/马上: due now, on purpose, rather than inventing a time;
 *   * `unparsed`   — nothing recognisable was found: due now **and flagged**, so a wrong guess is
 *                    visible in the log instead of hidden behind a default that looks deliberate.
 */
export const REMINDER_RESOLVE_KINDS = Object.freeze([
  'absolute',
  'day_relative',
  'weekday',
  'clock_only',
  'duration',
  'asap',
  'unparsed',
] as const);

export type ReminderResolveKind = (typeof REMINDER_RESOLVE_KINDS)[number];

/** 认不出主人时的 `owner`（与 `UNKNOWN_ACTOR` 同一个取向：不编造一个人，也不留空）。 */
export const UNKNOWN_REMINDER_OWNER = 'unknown';

/**
 * 提醒的声明面（`config/xixi.example.yaml` 的 `reminders` 段）。
 *
 * 只有三个键，而且每个都真的被读：时区（缺省跟随 `identity.timezone`）、只说哪天没说几点时的
 * 默认时刻、以及「尽快」的宽限。**没有「提醒的静默时段」这种键**：几点该不该开口是主动路径的
 * 硬底线决定的（铁律 3），提醒自己没有第二个开关 —— 两个地方判同一件事，迟早会打架。
 */
export interface ReminderSettings {
  /** IANA 时区；`null` = 跟随 `identity.timezone`（家里只有一个时区时不要写这一项）。 */
  readonly timezone: string | null;
  /** 只说了「明天」「周三」而没写几点时的默认时刻（当地时刻）。 */
  readonly defaultTime: { readonly hour: number; readonly minute: number };
  /** 「尽快/认不出」时相对请求时刻推迟多少分钟到期（0 = 立即到期）。 */
  readonly asapMinutes: number;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = Object.freeze({
  timezone: null,
  defaultTime: Object.freeze({ hour: 9, minute: 0 }),
  asapMinutes: 0,
});

/**
 * 读 `config.reminders`。容错取向与 `parseToolApprovalSettings` 一致：坏值退回出厂默认，
 * 不让一个错字把整台西西拦在门外（但也不会静默改掉已经写对的那一项）。
 */
export function parseReminderSettings(source?: Readonly<Record<string, unknown>> | undefined): ReminderSettings {
  if (source === undefined) return DEFAULT_REMINDER_SETTINGS;
  const rawZone = source['timezone'];
  const timezone = typeof rawZone === 'string' && rawZone.trim().length > 0 ? rawZone.trim() : null;
  const rawDefault = source['default_time'];
  let defaultTime = DEFAULT_REMINDER_SETTINGS.defaultTime;
  if (typeof rawDefault === 'string') {
    const match = /^(\d{1,2}):(\d{2})$/.exec(rawDefault.trim());
    if (match !== null) {
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) defaultTime = Object.freeze({ hour, minute });
    }
  }
  const rawAsap = source['asap_minutes'];
  const asapMinutes =
    typeof rawAsap === 'number' && Number.isFinite(rawAsap) && rawAsap >= 0
      ? Math.min(Math.floor(rawAsap), 24 * 60)
      : DEFAULT_REMINDER_SETTINGS.asapMinutes;
  return { timezone, defaultTime, asapMinutes };
}

/** One durable reminder: pack §7's eight fields, plus the process facts a restart needs. */
export interface Reminder {
  /** pack §7 `id`. */
  readonly id: string;
  /** pack §7 `owner`: whose reminder this is (`unknown` when the entry could not name one). */
  readonly owner: string;
  /** pack §7 `what`: what to remind about. */
  readonly what: string;
  /** pack §7 `due_at`: an **absolute** instant with an explicit offset (`2026-10-01T08:00:00.000+08:00`). */
  readonly dueAt: string;
  /** pack §7 `timezone`: the IANA zone `due_at` was resolved in (`Asia/Shanghai`). */
  readonly timezone: string;
  /** pack §7 `status`. */
  readonly status: ReminderStatus;
  /** pack §7 `created_at`. */
  readonly createdAt: string;
  /** pack §7 `source_event_id`: the turn that created it (entry-supplied, never model-supplied). */
  readonly sourceEventId: string | null;
  /** Program facts (not part of the pack's eight fields). */
  readonly statusChangedAt: string | null;
  readonly resolveKind: ReminderResolveKind;
  readonly sessionId: string | null;
  readonly deliveredAt: string | null;
  readonly acknowledgedAt: string | null;
}

export interface NewReminder {
  readonly id?: string;
  readonly owner?: string;
  readonly what: string;
  /** Absolute instant; `due_at` from {@link resolveReminderWhen} already has the right offset. */
  readonly dueAt: string;
  readonly timezone: string;
  readonly createdAt?: string;
  readonly sourceEventId?: string | null;
  readonly sessionId?: string | null;
  readonly resolveKind?: ReminderResolveKind;
}

export interface ReminderQuery {
  readonly status?: ReminderStatus | readonly ReminderStatus[] | undefined;
  readonly owner?: string | undefined;
  /** Only reminders due at or before this instant (`due_at <= dueBefore`) — the scheduler's query. */
  readonly dueBefore?: Date | string | undefined;
  readonly limit?: number | undefined;
}

export interface TransitionReminderOptions {
  readonly at?: Date | undefined;
  readonly reasonCode?: ReminderReasonCode | undefined;
  /** Event envelope `source` (`reminder` by default; `proactive` when she said it herself). */
  readonly source?: string | undefined;
}

/** One state change plus the event it wrote (the event is `null` when the state was already there). */
export interface ReminderChange {
  readonly reminder: Reminder;
  readonly event: StoredEvent | null;
}

/** Where the durable reminder is read and written. SQLite itself is only opened by this package. */
export class ReminderStore {
  readonly #store: XixiStore;

  constructor(store: XixiStore) {
    this.#store = store;
  }

  /** Record a reminder (`pending`) and write `reminder.created`… i.e. the `pending` state, same transaction. */
  create(input: NewReminder): ReminderChange {
    return this.#store.insertReminder(input);
  }

  get(reminderId: string): Reminder | null {
    return this.#store.reminder(reminderId);
  }

  list(query: ReminderQuery = {}): Reminder[] {
    return this.#store.reminders(query);
  }

  /** Due and still untouched: `status = 'pending'` and `due_at <= now`. */
  due(now: Date): Reminder[] {
    return this.#store.reminders({ status: 'pending', dueBefore: now });
  }

  /**
   * Reminders that became proactive candidates and were not said yet (oldest first).
   *
   * This is the read side the conversation / proactive path uses: everything here already has a
   * `reminder.changed` event with `status = 'candidate'` behind it.
   */
  candidates(): Reminder[] {
    return this.#store.reminders({ status: 'candidate' });
  }

  transition(reminderId: string, status: ReminderStatus, options: TransitionReminderOptions = {}): ReminderChange {
    return this.#store.transitionReminder(reminderId, status, options);
  }

  /** Every state change this reminder wrote, in log order (audit; same shape as `openThreadHistory`). */
  history(reminderId: string): StoredEvent[] {
    return this.#store.readEvents({ type: 'reminder.changed', limit: Number.MAX_SAFE_INTEGER }).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload['reminder_id'] === reminderId;
    });
  }
}

/**
 * A reminder event's envelope + payload (used by `store.ts`'s write path; exported so the event's
 * shape has exactly one definition).
 *
 * 铁律 5: the payload carries program facts — id, owner, what, state, reason code, the absolute
 * `due_at` and the zone — and no model reasoning. `what` **is** included, on purpose: this event is
 * what the proactive path and the dialogue read when the time comes, and without it they would have
 * to go back to the table to learn what to say. It is the user's own instruction to be reminded,
 * not something the model inferred.
 */
export function buildReminderEvent(
  reminder: Reminder,
  status: ReminderStatus,
  reasonCode: string,
  at: string,
  source: string,
  previousStatus: ReminderStatus | null,
): EventEnvelope {
  return buildEvent({
    event_type: 'reminder.changed',
    source,
    actor: 'system',
    confidence: 1,
    timestamp: at,
    correlation_id: newCorrelationId(),
    payload: reminderPayload(reminder, status, reasonCode, previousStatus),
  });
}

/** The payload field table (`packages/contracts/schemas/events/reminder.changed.v1.json`). */
export function reminderPayload(
  reminder: Reminder,
  status: ReminderStatus,
  reasonCode: string,
  previousStatus: ReminderStatus | null,
): Record<string, JsonValue> {
  return {
    reminder_id: reminder.id,
    owner: reminder.owner,
    what: reminder.what,
    status,
    previous_status: previousStatus,
    reason_code: reasonCode,
    due_at: reminder.dueAt,
    timezone: reminder.timezone,
    resolve_kind: reminder.resolveKind,
    source_event_id: reminder.sourceEventId,
    session_id: reminder.sessionId,
    status_changed_at: reminder.statusChangedAt,
    delivered_at: reminder.deliveredAt,
    acknowledged_at: reminder.acknowledgedAt,
  };
}

/** Only the transitions the pack's chain allows (`REMINDER_NEXT_STATUSES`). */
export function reminderTransitionAllowed(from: ReminderStatus, to: ReminderStatus): boolean {
  return REMINDER_NEXT_STATUSES[from].includes(to);
}

/** The reason code a transition writes when the caller does not name one. */
export function reminderReasonForStatus(status: ReminderStatus): ReminderReasonCode {
  switch (status) {
    case 'due':
      return 'reminder_due';
    case 'candidate':
      return 'reminder_candidate';
    case 'delivered':
      return 'reminder_delivered';
    case 'acknowledged':
      return 'reminder_acknowledged';
    default:
      return 'reminder_created';
  }
}

/** New id: `rem_` + uuid, the shape the payload schema pins with a pattern. */
export function newReminderId(): string {
  return `rem_${randomUUID()}`;
}

// ------------------------------------------------------------------ time resolution (pack §7)

/** A wall-clock reading in some zone: what a clock on the wall there would show. */
export interface ZonedWallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    // `h23` on purpose: `hour12: false` renders midnight as `24` in some engines, which would put
    // 「明天早上八点」's day arithmetic one day off.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** What a wall clock in `timeZone` shows at `instant`. */
export function zonedWallClock(instant: Date, timeZone: string): ZonedWallClock {
  const parts = zoneFormatter(timeZone).formatToParts(instant);
  const read = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** The zone's UTC offset (minutes east) **at that instant** — not the machine's offset. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const wall = zonedWallClock(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, instant.getMilliseconds());
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * Render an instant as the offset-ISO string a wall clock in `timeZone` would read.
 *
 * `@xixi/contracts`' `toOffsetIso` renders in *this machine's* offset by default, which is wrong for
 * a reminder whose owner lives in another zone: `due_at` has to be readable next to its `timezone`.
 * The offset is computed **at that instant**, so a DST boundary anywhere in the year cannot shift it.
 */
export function formatZonedIso(instant: Date, timeZone: string): string {
  return toOffsetIso(instant, zoneOffsetMinutes(instant, timeZone));
}

/**
 * The instant at which a wall clock in `timeZone` reads the given values.
 *
 * Two passes because the offset used to guess the instant may belong to the other side of a DST
 * transition. A wall time that does not exist (the hour skipped by a spring-forward) resolves to the
 * instant just after the gap rather than to `NaN` — the reminder then fires once, right after.
 */
export function instantFromWallClock(wall: Omit<ZonedWallClock, 'second'>, timeZone: string, second = 0, ms = 0): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, second, ms);
  const first = zoneOffsetMinutes(new Date(naive), timeZone);
  const guessed = naive - first * 60_000;
  const correction = zoneOffsetMinutes(new Date(guessed), timeZone);
  return new Date(correction === first ? guessed : naive - correction * 60_000);
}

export interface ReminderWhenContext {
  /** The instant the request was made ("now" for 明天/半小时后). */
  readonly now: Date;
  /** IANA zone the absolute instant is resolved in (the household's `identity.timezone`). */
  readonly timezone: string;
  /** 只说哪天没说几点时用的默认时刻；缺省是 `09:00`（`DEFAULT_REMINDER_SETTINGS`）。 */
  readonly defaultTime?: { readonly hour: number; readonly minute: number } | undefined;
  /** 「尽快/认不出」相对请求时刻推迟多少分钟到期；缺省 0（立即到期）。 */
  readonly asapMinutes?: number | undefined;
}

/** The result of resolving a natural-language `when`: an absolute instant, its zone, and how it was read. */
export interface ReminderWhenResolution {
  /** Absolute instant, offset-ISO, **in `timezone`**. This is what the `due_at` column gets. */
  readonly dueAt: string;
  readonly timezone: string;
  readonly kind: ReminderResolveKind;
  /** One program-written line about the parse (returned to the caller; **never stored**). */
  readonly explain: string;
}

const CN_DIGIT: Readonly<Record<string, number>> = Object.freeze({
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
});

const SPOKEN_NUMBER = '零〇一二三四五六七八九十两';
const SPOKEN_NUMBER_PATTERN = `(?:\\d+|[${SPOKEN_NUMBER}]+)`;

/** `八` → 8, `十一` → 11, `二十` → 20, `二十三` → 23, `8` → 8. */
export function parseSpokenNumber(text: string): number | null {
  const value = text.trim();
  if (value.length === 0) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const tenish = /^([零〇一二三四五六七八九])?十([零〇一二三四五六七八九])?$/.exec(value);
  if (tenish !== null) {
    const tens = tenish[1] === undefined ? 1 : (CN_DIGIT[tenish[1]] ?? 0);
    const ones = tenish[2] === undefined ? 0 : (CN_DIGIT[tenish[2]] ?? 0);
    return tens * 10 + ones;
  }
  if (value.length === 1 && CN_DIGIT[value] !== undefined) return CN_DIGIT[value];
  return null;
}

/** Full-width digits/colons and stray whitespace are normalised away before any pattern runs. */
function normalizeWhenText(text: string): string {
  return text
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/[：]/g, ':')
    .replace(/[／]/g, '/')
    .replace(/\s+/g, '')
    .trim();
}

interface DayHint {
  /** Days to add to the local day (`0` = today). */
  readonly offset: number;
  /** 「今晚/明晚」: an evening默认 when no clock is given. */
  readonly evening: boolean;
  /** True when a year-less calendar date (`10月1日`) was found. */
  readonly dateParts: { readonly year: number | null; readonly month: number; readonly day: number } | null;
  readonly kind: ReminderResolveKind | null;
}

const DAY_WORDS: readonly { readonly word: string; readonly offset: number; readonly evening: boolean }[] = [
  { word: '大后天', offset: 3, evening: false },
  { word: '后天', offset: 2, evening: false },
  { word: '明晚', offset: 1, evening: true },
  { word: '明天', offset: 1, evening: false },
  { word: '明日', offset: 1, evening: false },
  { word: '今晚', offset: 0, evening: true },
  { word: '今天', offset: 0, evening: false },
  { word: '今日', offset: 0, evening: false },
];

const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 });

/** Time-of-day words, with the hour a bare 「早上」/「晚上」 means and whether they sit after noon. */
const PERIOD_WORDS: readonly { readonly word: string; readonly hour: number; readonly pm: boolean }[] = [
  { word: '凌晨', hour: 5, pm: false },
  { word: '早上', hour: 8, pm: false },
  { word: '早晨', hour: 8, pm: false },
  { word: '上午', hour: 9, pm: false },
  // 中午 is `pm: true` so both readings land right: 中午 12 点 stays 12:00 and 中午 1 点 is 13:00.
  { word: '中午', hour: 12, pm: true },
  { word: '下午', hour: 15, pm: true },
  { word: '傍晚', hour: 18, pm: true },
  { word: '晚上', hour: 20, pm: true },
  { word: '夜里', hour: 21, pm: true },
  // 半夜 12 点 is 00:00, not noon — `pm: false` is what makes the 12 → 0 shift happen.
  { word: '半夜', hour: 23, pm: false },
  // 明晚/今晚 already carry 「晚」; a lone 「晚八点」 is an evening too.
  { word: '晚', hour: 20, pm: true },
];

const ASAP_WORDS = ['尽快', '马上', '立刻', '立即', '现在', '一会儿', '待会', '一会'];

function addDays(wall: Omit<ZonedWallClock, 'second'>, days: number): Omit<ZonedWallClock, 'second'> {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

function wallWeekday(wall: Omit<ZonedWallClock, 'second'>): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

/** An impossible calendar day (`13月32日`, `2月30日`) is not a date — the caller falls through. */
function calendarDay(year: number, month: number, day: number): { readonly year: number; readonly month: number; readonly day: number } | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** A duration with a trailing 后/以后/之后: 「半小时后」「三小时后」「两天后」「3 个月后」. */
function parseDuration(text: string): { readonly minutes: number; readonly label: string } | null {
  if (/半\s*(?:个)?\s*小时\s*(?:后|以后|之后)/.test(text)) return { minutes: 30, label: '半小时' };
  const match = new RegExp(`(${SPOKEN_NUMBER_PATTERN})\\s*(?:个)?\\s*(分钟|小时|钟头|天|周|星期|月)\\s*(?:后|以后|之后)`).exec(text);
  if (match === null) return null;
  const value = parseSpokenNumber(match[1] ?? '');
  if (value === null) return null;
  const unit = match[2] ?? '';
  const scale = unit === '分钟' ? 1 : unit === '小时' || unit === '钟头' ? 60 : unit === '天' ? 1440 : unit === '周' || unit === '星期' ? 10_080 : 43_200;
  return { minutes: value * scale, label: `${value}${unit}` };
}

/** The day the reminder is for: an explicit date, a day word, or a weekday word. */
function parseDayHint(text: string, zoneNow: ZonedWallClock): DayHint {
  const explicit = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/.exec(text);
  if (explicit !== null) {
    const dateParts = calendarDay(Number(explicit[1]), Number(explicit[2]), Number(explicit[3]));
    if (dateParts !== null) return { offset: 0, evening: false, dateParts, kind: 'absolute' };
  }
  const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text);
  if (monthDay !== null) {
    // A year-less date means the next time that day comes: this year, or next year when it has gone.
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (calendarDay(zoneNow.year, month, day) !== null) {
      const target = Date.UTC(zoneNow.year, month - 1, day);
      const today = Date.UTC(zoneNow.year, zoneNow.month - 1, zoneNow.day);
      const year = target < today ? zoneNow.year + 1 : zoneNow.year;
      return { offset: 0, evening: false, dateParts: { year, month, day }, kind: 'absolute' };
    }
  }
  for (const entry of DAY_WORDS) {
    if (text.includes(entry.word)) return { offset: entry.offset, evening: entry.evening, dateParts: null, kind: 'day_relative' };
  }
  const weekday = /(下个|下|这个|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text);
  if (weekday !== null) {
    const target = WEEKDAY_INDEX[weekday[2] ?? ''];
    if (target !== undefined) {
      const today = wallWeekday(zoneNow);
      const daysSinceMonday = (today + 6) % 7;
      const targetFromMonday = (target + 6) % 7;
      let delta = targetFromMonday - daysSinceMonday;
      if (delta < 0) delta += 7;
      const next = weekday[1] === '下' || weekday[1] === '下个';
      if (next) delta += 7;
      return { offset: delta, evening: false, dateParts: null, kind: 'weekday' };
    }
  }
  return { offset: 0, evening: false, dateParts: null, kind: null };
}

/** The clock reading in the text: an explicit `8:30`, or 「八点半」/「晚上八点」/「早上」. */
function parseClockHint(text: string): { readonly hour: number | null; readonly minute: number; readonly periodHour: number | null } {
  let period: { readonly hour: number; readonly pm: boolean } | null = null;
  let periodAt = Number.POSITIVE_INFINITY;
  for (const entry of PERIOD_WORDS) {
    const at = text.indexOf(entry.word);
    if (at === -1) continue;
    // Same offset (晚上 vs 晚): the earlier entry in the list wins, so 晚上 keeps 20:00 + pm.
    if (at < periodAt) {
      period = entry;
      periodAt = at;
    }
  }

  const hhmm = /(\d{1,2}):(\d{1,2})/.exec(text);
  let rawHour: number | null = null;
  let minute = 0;
  if (hhmm !== null) {
    rawHour = Number(hhmm[1]);
    minute = Number(hhmm[2]);
  } else {
    const dian = new RegExp(`(${SPOKEN_NUMBER_PATTERN})\\s*(?:点|时|點)\\s*(半|(?:${SPOKEN_NUMBER_PATTERN})\\s*分?)?`).exec(text);
    if (dian !== null) {
      rawHour = parseSpokenNumber(dian[1] ?? '');
      const tail = (dian[2] ?? '').replace(/分$/, '').trim();
      if (tail === '半') minute = 30;
      else if (tail.length > 0) minute = parseSpokenNumber(tail) ?? 0;
    }
  }

  if (rawHour === null) return { hour: null, minute: 0, periodHour: period?.hour ?? null };
  if (!Number.isFinite(rawHour) || rawHour < 0 || rawHour > 23 || minute < 0 || minute > 59) {
    return { hour: null, minute: 0, periodHour: period?.hour ?? null };
  }
  if (period !== null) {
    if (period.pm && rawHour < 12) rawHour += 12;
    else if (!period.pm && rawHour === 12) rawHour = 0;
  }
  return { hour: rawHour, minute, periodHour: period?.hour ?? null };
}

/**
 * Resolve a natural-language `when` into an absolute instant + the zone it was read in (pack §7).
 *
 * The rules, in order, because a wrong guess must be visible rather than plausible:
 *
 *   1. a duration with 后/以后/之后 → `now + duration`;
 *   2. an explicit date (`2026-10-01`、`10月1日`) → that calendar day;
 *   3. 今天/明天/后天/大后天 or 周三/下周三 → that local day;
 *   4. a time of day (with 早上/晚上/…) → that hour; **no day given** means today, or tomorrow when
 *      the hour has already passed;
 *   5. a day with no hour → `09:00` local (a documented default, never a silent one);
 *   6. nothing recognisable, or 尽快/马上 → **now**, with `kind` saying which of the two it was.
 *
 * Everything is computed on the wall clock of `options.timezone` (not the machine's zone) and comes
 * back as an offset-ISO string in that same zone, which is what `due_at` stores.
 */
export function resolveReminderWhen(when: string, options: ReminderWhenContext): ReminderWhenResolution {
  const timezone = options.timezone;
  const now = options.now;
  const text = normalizeWhenText(when);
  const zoneNow = zonedWallClock(now, timezone);
  const defaultHour = options.defaultTime?.hour ?? DEFAULT_REMINDER_SETTINGS.defaultTime.hour;
  const defaultMinute = options.defaultTime?.minute ?? DEFAULT_REMINDER_SETTINGS.defaultTime.minute;
  const asapMinutes = options.asapMinutes ?? DEFAULT_REMINDER_SETTINGS.asapMinutes;

  const duration = parseDuration(text);
  if (duration !== null) {
    const instant = new Date(now.getTime() + duration.minutes * 60_000);
    const dueAt = formatZonedIso(instant, timezone);
    return { dueAt, timezone, kind: 'duration', explain: `按「${duration.label}之后」解析 → ${dueAt}（${timezone}）` };
  }

  const dayHint = parseDayHint(text, zoneNow);
  const clockHint = parseClockHint(text);
  const hour = clockHint.hour ?? clockHint.periodHour ?? (dayHint.evening ? 20 : null);

  if (dayHint.kind === null && hour === null) {
    const asap = ASAP_WORDS.some((word) => text.includes(word));
    const instant = new Date(now.getTime() + asapMinutes * 60_000);
    const dueAt = formatZonedIso(instant, timezone);
    return {
      dueAt,
      timezone,
      kind: asap ? 'asap' : 'unparsed',
      explain: asap
        ? `${asapMinutes === 0 ? '「尽快/马上」' : `「尽快」+ ${asapMinutes} 分钟宽限`}：按立即到期处理 → ${dueAt}（${timezone}）`
        : `认不出时刻：不编造一个时间，按立即到期处理${asapMinutes === 0 ? '' : `（含 ${asapMinutes} 分钟宽限）`}，并把这次解析记为 unparsed（事件日志里能看出是猜的）`,
    };
  }

  let wall = {
    year: zoneNow.year,
    month: zoneNow.month,
    day: zoneNow.day,
    hour: hour ?? defaultHour,
    minute: clockHint.hour === null ? (hour === null ? defaultMinute : 0) : clockHint.minute,
  };
  let kind: ReminderResolveKind = dayHint.kind ?? 'clock_only';

  if (dayHint.dateParts !== null) {
    const year = dayHint.dateParts.year ?? zoneNow.year;
    wall = {
      year,
      month: dayHint.dateParts.month,
      day: dayHint.dateParts.day,
      hour: hour ?? defaultHour,
      minute: clockHint.hour === null ? (hour === null ? defaultMinute : 0) : clockHint.minute,
    };
    kind = 'absolute';
  } else if (dayHint.kind !== null) {
    wall = addDays(wall, dayHint.offset);
    kind = dayHint.kind;
  }

  let instant = instantFromWallClock(wall, timezone);
  // A time in the past rolls one day forward — except for an explicitly written calendar date,
  // where the literal reading wins (a date that has gone by is simply already due).
  if (kind !== 'absolute' && instant.getTime() <= now.getTime()) {
    wall = addDays(wall, 1);
    instant = instantFromWallClock(wall, timezone);
  }

  const dueAt = formatZonedIso(instant, timezone);
  const why =
    kind === 'absolute'
      ? '按明确日期解析'
      : kind === 'day_relative'
        ? '按相对日（今天/明天/后天）解析'
        : kind === 'weekday'
          ? '按星期几解析'
          : '只有时刻、没写哪一天：按今天算，过了就顺延到明天';
  const defaulted = clockHint.hour === null && clockHint.periodHour === null;
  return {
    dueAt,
    timezone,
    kind,
    explain: `${why}${defaulted ? `，没写具体几点，按默认时刻 ${String(defaultHour).padStart(2, '0')}:${String(defaultMinute).padStart(2, '0')} 处理` : ''} → ${dueAt}（${timezone}）`,
  };
}

/**
 * A reminder is 「到点」 at or after its `due_at` — compared as instants, so the offset a row carries
 * cannot change the answer.
 */
export function reminderIsDue(reminder: Reminder, at: Date): boolean {
  const due = Date.parse(reminder.dueAt);
  return Number.isFinite(due) && due <= at.getTime();
}

/** Validate what a caller hands to `insertReminder`; a bad row must not reach the table. */
export function assertNewReminder(input: NewReminder): void {
  if (typeof input.what !== 'string' || input.what.trim().length === 0) {
    throw new DomainError('INVALID_REMINDER', 'a reminder needs a "what"');
  }
  if (typeof input.timezone !== 'string' || input.timezone.trim().length === 0) {
    throw new DomainError('INVALID_REMINDER', 'a reminder needs the IANA timezone its due_at is in');
  }
  if (typeof input.dueAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?[+-]\d{2}:\d{2}$/.test(input.dueAt)) {
    // Not "an ISO string": `due_at` must be absolute **and** carry the zone's offset, or the local
    // reading of a reminder stored in another zone would be a guess.
    throw new DomainError('INVALID_REMINDER', `due_at must be an offset ISO-8601 instant (resolved, never natural language): ${String(input.dueAt)}`);
  }
  if (!Number.isFinite(Date.parse(input.dueAt))) {
    throw new DomainError('INVALID_REMINDER', `due_at is not a readable instant: ${String(input.dueAt)}`);
  }
  if (input.owner !== undefined && input.owner.trim().length === 0) {
    throw new DomainError('INVALID_REMINDER', 'owner must not be empty when given (use `unknown` instead)');
  }
  if (input.resolveKind !== undefined && !REMINDER_RESOLVE_KINDS.includes(input.resolveKind)) {
    throw new DomainError('INVALID_REMINDER', `unknown resolve_kind: ${String(input.resolveKind)}`);
  }
}
