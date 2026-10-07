/**
 * Durable reminder scheduling — the host side of pack `docs/03_AGENT_PLUGIN.md` §7.
 *
 * What was wrong before this file existed: the reminder tool (then named `xixi_set_reminder_stub`; it
 * became `xixi_set_reminder` in V0.3 P2.5-E, when the `_stub` name and this wording stopped being
 * true) wrote the user's words into an in-process array, and answered 「到点不会自动响，需要人看一眼」.
 * Nothing survived the process, and nothing ever fired. Two pieces replace that:
 *
 *   * {@link DurableReminderSink} is a `ReminderSink` backed by the domain's `reminders` table, so
 *     「明天八点提醒我打电话」 becomes an absolute `due_at` + `timezone` row that is still there after a
 *     restart;
 *   * {@link ReminderScheduler} walks the pack's five states, and every step writes a
 *     `reminder.changed` event **in the same transaction** as the row it changes. 「到点」 is therefore
 *     a fact in the event log that the proactive path or the dialogue can read, not a log line.
 *
 * Ordering discipline: `MarkDue` only compares the clock; `takeCandidates` is the step that turns a
 * due reminder into something she may say. `deliver` and `acknowledge` are called by whoever actually
 * said it and by whoever heard the answer — the scheduler never decides to speak (铁律 3 belongs to
 * the proactive path, not to this file).
 */
import type { ReminderSink, ScheduledReminder } from '@xixi/brain-adapter';
import {
  DEFAULT_REMINDER_SETTINGS,
  ReminderStore,
  reminderIsDue,
  resolveReminderWhen,
  UNKNOWN_REMINDER_OWNER,
  type NewReminder,
  type Reminder,
  type ReminderChange,
  type ReminderSettings,
  type ReminderWhenResolution,
  type StoredEvent,
  type XixiStore,
} from '@xixi/domain';

/** Event-envelope `source` for reminders the tool/host wrote. */
export const REMINDER_SOURCE = 'reminder';

/**
 * Who is asking, and which turn asked — the same three values the entry hands to
 * `ToolExecutionContext` (V0.3 P2-B).
 *
 * They are supplied **by the entry**, never by the model (铁律 1/8): `owner` decides whose reminder
 * this is, `sourceEventId` points the reminder back at the turn that created it. The tool layer
 * cannot see them yet — `ToolContext` carries only `timezone`/`now` — so the host rebinds them at the
 * turn boundary through {@link DurableReminderSink.beginTurn}; that is the same information, taken
 * from the same place, one layer up.
 */
export interface ReminderTurnIdentity {
  readonly sessionId?: string | undefined;
  readonly actorId?: string | undefined;
  readonly sourceEventId?: string | undefined;
}

export interface DurableReminderSinkOptions {
  readonly store: XixiStore;
  /** IANA zone the natural-language `when` is resolved in (the household's `identity.timezone`). */
  readonly timezone: string;
  /**
   * `config.reminders`（`parseReminderSettings` 的结果）。缺省 = 出厂默认：`default_time` 09:00、
   * `asap_minutes` 0。`settings.timezone` 有值时**覆盖**上面的 `timezone`。
   */
  readonly settings?: ReminderSettings | undefined;
  /** Fallback owner when the turn identity does not name one; defaults to `unknown` (不编造一个人). */
  readonly owner?: string | undefined;
  /** Clock override; the tool stamps `recordedAt`, which is what resolution uses when present. */
  readonly now?: (() => Date) | undefined;
}

/**
 * A `ReminderSink` that persists. Wire it into the tool chain as the `reminderSink` option and
 * `xixi_set_reminder` stops being a memory hole.
 *
 * The returned `ScheduledReminder.when` is the **resolved absolute instant**, not the user's words:
 * the tool result then tells the model the exact time it recorded, and the raw 「明天早上八点」 never
 * leaves this call (it is not stored anywhere — see `008_reminders.sql`).
 */
export class DurableReminderSink implements ReminderSink {
  readonly #reminders: ReminderStore;
  readonly #timezone: string;
  readonly #settings: ReminderSettings;
  readonly #owner: string;
  readonly #now: () => Date;
  #identity: ReminderTurnIdentity = {};

  constructor(options: DurableReminderSinkOptions) {
    this.#reminders = new ReminderStore(options.store);
    this.#settings = options.settings ?? DEFAULT_REMINDER_SETTINGS;
    this.#timezone = this.#settings.timezone ?? options.timezone;
    this.#owner = options.owner ?? UNKNOWN_REMINDER_OWNER;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Bind the identity of the turn about to run. The entry calls this next to building its
   * `ToolExecutionContext`, with the same three values; `endTurn()` is the other end of it.
   */
  beginTurn(identity: ReminderTurnIdentity = {}): void {
    this.#identity = identity;
  }

  endTurn(): void {
    this.#identity = {};
  }

  /** The non-tool way in: an entry (or a test) may schedule a reminder without a model call. */
  scheduleAt(input: {
    readonly what: string;
    readonly when: string;
    readonly now: Date;
    readonly owner?: string | undefined;
    readonly identity?: ReminderTurnIdentity | undefined;
    readonly timezone?: string | undefined;
  }): { readonly resolution: ReminderWhenResolution; readonly change: ReminderChange } {
    const timezone = input.timezone ?? this.#timezone;
    const resolution = resolveReminderWhen(input.when, {
      now: input.now,
      timezone,
      defaultTime: this.#settings.defaultTime,
      asapMinutes: this.#settings.asapMinutes,
    });
    const identity = input.identity ?? this.#identity;
    const row: NewReminder = {
      what: input.what,
      owner: input.owner ?? identity.actorId ?? this.#owner,
      dueAt: resolution.dueAt,
      timezone,
      createdAt: input.now.toISOString(),
      sourceEventId: identity.sourceEventId ?? null,
      sessionId: identity.sessionId ?? null,
      resolveKind: resolution.kind,
    };
    const change = this.#reminders.create(row);
    return { resolution, change };
  }

  schedule(input: { readonly what: string; readonly when: string; readonly recordedAt: string }): ScheduledReminder {
    const at = new Date(input.recordedAt);
    const now = Number.isFinite(at.getTime()) ? at : this.#now();
    const { change } = this.scheduleAt({ what: input.what, when: input.when, now });
    return {
      id: change.reminder.id,
      what: change.reminder.what,
      // The resolved instant goes back instead of the natural-language text: whoever asked learns
      // exactly when it will ring, and the words they used are not echoed back as if they were a time.
      when: change.reminder.dueAt,
      recordedAt: input.recordedAt,
    };
  }
}

/** What one `markDue` / `takeCandidates` pass did, so a host can say it out loud instead of guessing. */
export interface ReminderTickReport {
  /** The instant this pass ran at (offset ISO). */
  readonly at: string;
  /** `pending → due`: the clock reached them. */
  readonly becameDue: readonly Reminder[];
  /** `due → candidate`: they became something she may say. */
  readonly becameCandidate: readonly Reminder[];
  /** Every `reminder.changed` event this pass appended, in order. */
  readonly events: readonly StoredEvent[];
}

/**
 * One due reminder, shaped for the proactive path (`buildProactiveCandidates`).
 *
 * `line` is what she may say about it; `fact` is why she may say it (the row and the clock), in the
 * same 「这条凭什么说」 form the other candidates use.
 */
export interface ReminderCandidateInput {
  readonly reminderId: string;
  readonly owner: string;
  readonly what: string;
  readonly dueAt: string;
  readonly line: string;
  readonly fact: string;
}

/**
 * A due reminder's signals in the **social budget** (pack §14.2), next to
 * `openThreadFollowUpComponents()`.
 *
 * Why these numbers: this is something the user **asked to be told**, at a time they named — the most
 * explicit kind of 「她惦记着的事」 there is, so topic quality and personal relevance are both full. It is
 * fresh because it is due **now**, and engagement stays at 0.6 like an open thread because she is the
 * one bringing it up. These are scores and a reason, not a verdict: whether she actually speaks is
 * still 读空气's call (铁律 3).
 */
export function reminderDueComponents(): Readonly<Record<string, number>> {
  return Object.freeze({ topic_quality: 1, personal_relevance: 1, freshness: 1, receptivity: 0.85, engagement: 0.6 });
}

export interface ReminderSchedulerOptions {
  readonly store: XixiStore;
  readonly now?: (() => Date) | undefined;
  /** Event-envelope `source` (default {@link REMINDER_SOURCE}). */
  readonly source?: string | undefined;
}

export class ReminderScheduler {
  readonly #reminders: ReminderStore;
  readonly #now: () => Date;
  readonly #source: string;

  constructor(options: ReminderSchedulerOptions) {
    this.#reminders = new ReminderStore(options.store);
    this.#now = options.now ?? (() => new Date());
    this.#source = options.source ?? REMINDER_SOURCE;
  }

  get store(): ReminderStore {
    return this.#reminders;
  }

  /**
   * `pending → due` for everything whose `due_at` has passed.
   *
   * **The only place the clock is compared** (the store's state machine deliberately does not), and it
   * refuses to age a reminder early: a `pending` row whose `due_at` is still in the future is left
   * alone and writes no event — 「到点」 has to mean the time actually came.
   */
  markDue(at: Date = this.#now()): ReminderTickReport {
    const becameDue: Reminder[] = [];
    const events: StoredEvent[] = [];
    for (const reminder of this.#reminders.list({ status: 'pending' })) {
      if (!reminderIsDue(reminder, at)) continue;
      const change = this.#reminders.transition(reminder.id, 'due', {
        at,
        reasonCode: 'reminder_due',
        source: this.#source,
      });
      becameDue.push(change.reminder);
      if (change.event !== null) events.push(change.event);
    }
    return { at: at.toISOString(), becameDue, becameCandidate: [], events };
  }

  /**
   * `due → candidate` for everything already due, returning them in the shape the proactive path
   * consumes. Idempotent per reminder: a row already in `candidate` is not transitioned again.
   */
  takeCandidates(at: Date = this.#now()): { readonly candidates: readonly Reminder[]; readonly events: readonly StoredEvent[] } {
    const candidates: Reminder[] = [];
    const events: StoredEvent[] = [];
    for (const reminder of this.#reminders.list({ status: 'due' })) {
      if (!reminderIsDue(reminder, at)) continue; // due_at moved forward by hand: not ours to offer
      const change = this.#reminders.transition(reminder.id, 'candidate', {
        at,
        reasonCode: 'reminder_candidate',
        source: this.#source,
      });
      candidates.push(change.reminder);
      if (change.event !== null) events.push(change.event);
    }
    return { candidates, events };
  }

  /** The whole clock pass a host runs on every tick: 到点 → 成为候选. */
  tick(at: Date = this.#now()): ReminderTickReport {
    const due = this.markDue(at);
    const offered = this.takeCandidates(at);
    return {
      at: due.at,
      becameDue: due.becameDue,
      becameCandidate: offered.candidates,
      events: [...due.events, ...offered.events],
    };
  }

  /** Reminders waiting to be said (oldest `due_at` first) — the queue a host reads at startup. */
  waiting(): Reminder[] {
    return this.#reminders.list({ status: 'candidate' });
  }

  /** Due but not yet offered (a `markDue` pass that has not been followed by `takeCandidates`). */
  dueButUnspoken(): Reminder[] {
    return this.#reminders.list({ status: 'due' });
  }

  /**
   * The proactive path's input: everything waiting to be said, as lines + the fact behind each one.
   *
   * It first advances anything that is due but not yet offered (`takeCandidates`), then returns
   * **every** row in the `candidate` state — not only the ones this call transitioned. A reminder
   * that became a candidate on an earlier tick (because the room was quiet, or she was asleep) is
   * still waiting to be said, and dropping it here would silently lose it.
   */
  candidateInputs(at: Date = this.#now()): ReminderCandidateInput[] {
    this.takeCandidates(at);
    return this.#reminders.list({ status: 'candidate' }).map((reminder) => this.#inputFor(reminder));
  }

  /** `candidate → delivered`: she actually said it (called by whoever spoke, after the fact). */
  deliver(reminderId: string, at: Date = this.#now()): ReminderChange {
    return this.#reminders.transition(reminderId, 'delivered', {
      at,
      reasonCode: 'reminder_delivered',
      source: this.#source,
    });
  }

  /** `delivered → acknowledged`: the person answered (called by whoever heard the answer). */
  acknowledge(reminderId: string, at: Date = this.#now()): ReminderChange {
    return this.#reminders.transition(reminderId, 'acknowledged', {
      at,
      reasonCode: 'reminder_acknowledged',
      source: this.#source,
    });
  }

  /** Every state change one reminder wrote, in log order (the audit trail). */
  history(reminderId: string): StoredEvent[] {
    return this.#reminders.history(reminderId);
  }

  #inputFor(reminder: Reminder): ReminderCandidateInput {
    return {
      reminderId: reminder.id,
      owner: reminder.owner,
      what: reminder.what,
      dueAt: reminder.dueAt,
      line: `该提醒你了：${reminder.what}`,
      fact: `durable reminder ${reminder.id}：due_at ${reminder.dueAt}（${reminder.timezone}，解析方式 ${reminder.resolveKind}），到点事件已写进日志`,
    };
  }
}
