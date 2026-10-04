/**
 * The resident consideration loop and its candidate builders (V0.3 P0-A, pack
 * `04_RUNTIME_CONSOLIDATION.md` §1 Step B).
 *
 * Moved out of `scripts/field-test.ts` **verbatim**: the loop, the candidate sources it walks, the
 * offline line bank, the gate/trigger labels the page renders, and the two model seams
 * (`createModelComposer` / `createModelDecider`). The deterministic scoring itself already lives in
 * `packages/conversation/src/proactive.ts` and was not touched.
 *
 * `scripts/field-test.ts` keeps a compatibility re-export for every symbol here, so
 * `scripts/serve-chat.ts` (which imports its whole proactive seam list from the console script)
 * keeps working while the call sites move one at a time (pack `01_ARCHITECTURE.md` §3).
 *
 * What did **not** move: the deterministic gates and scores (they are already package code) and the
 * console's own page/panel rendering — the runtime makes the decision, the console explains it.
 */
import { join } from 'node:path';

import type { BrainImageInput } from '@xixi/brain-adapter';
import {
  ConversationEngine,
  PROACTIVE_INITIATIVE_LABELS,
  PROACTIVE_MODEL_REASON_CODES,
  PROACTIVE_MODEL_REASON_LABELS,
  PROACTIVE_REASON_CODES,
  PROACTIVE_SIGNAL_LABELS,
  PROACTIVE_TRIGGERS,
  ProactiveEngine,
  SILENCE_TOKEN,
  openThreadFollowUpComponents,
  resolveReplyLimits,
  scoreProactiveCandidate,
  splitReplyIntoSegments,
} from '@xixi/conversation';
import type {
  ConversationState,
  OpenThreadFollowUp,
  ProactiveCandidate,
  ProactiveContextLines,
  ProactiveDecider,
  ProactiveDelivery,
  ProactiveInitiativeKind,
  ProactiveModelDecision,
  ProactiveModelInput,
  ProactiveModelReasonCode,
  ProactiveReasonCode,
  ProactiveRetiredReasonCode,
  ProactiveSettings,
  ProactiveTrigger,
  TopicEngine,
} from '@xixi/conversation';
import { DEFAULT_PRESENCE_TTL_SECONDS, openXixiStore, type XixiStore } from '@xixi/domain';

// The look-once shapes moved to `./errors.ts` in Step B (the composer's `vision` / `onUpload`
// seams declare them); the repository root moved to `./repo.ts` in Step C. Both are imported
// here rather than re-declared: this file used to be part of `scripts/field-test.ts`, where the
// names were file-local, and the extraction left three references dangling (`join`, `REPO_ROOT`,
// `LookOnce*`) that only a type check could see.
import type { LookOnceTrigger, LookOnceUploadInfo } from './errors.ts';
import { reminderDueComponents, type ReminderCandidateInput } from './reminder-runtime.ts';
import { REPO_ROOT } from './repo.ts';


// --------------------------------------------------------------------------------------
// Camera presence projection (owned by the M6 task; absent is a normal state)
// --------------------------------------------------------------------------------------




// --------------------------------------------------------------------------------------
// Camera presence projection (owned by the M6 task; absent is a normal state)
// --------------------------------------------------------------------------------------

export interface PresenceView {
  readonly mode: 'projection' | 'events' | 'not-integrated' | 'error';
  readonly text: string;
  readonly present: boolean | null;
  readonly confidence: number | null;
  readonly source: string | null;
  readonly updatedAt: string | null;
  readonly stale: boolean | null;
  readonly ttlSeconds: number | null;
  readonly note: string;
  readonly checkedAt: string;
}

/**
 * Read the presence projection written by the M6 camera task.
 *
 * Interface agreed with the vision engineer: `XixiStore.worldState()`
 * (`key = 'presence.home'`, `stale` when past TTL), with `readEvents({type:
 * 'presence.changed'})` as a fallback. Until that lands the page must show
 * 「未接入」 — a *state*, not an error — so every failure path here returns a view
 * instead of throwing. Feature detection is on purpose: the method does not exist
 * yet, and guessing at it would produce a stack trace in the user's face.
 */
export async function readPresence(options: { dataDir?: string; store?: unknown } = {}): Promise<PresenceView> {
  const checkedAt = new Date().toISOString();
  let store: unknown = options.store;
  try {
    if (store === undefined) {
      const opened = openXixiStore({ dataDir: options.dataDir ?? join(REPO_ROOT, 'data') });
      store = opened;
    }
    const candidate = store as Record<string, unknown>;
    const worldState = candidate.worldState;
    if (typeof worldState === 'function') {
      const row = (worldState as (key?: string) => Record<string, unknown> | null).call(store, 'presence.home');
      if (row !== null && row !== undefined && typeof row === 'object') {
        const present = typeof row.present === 'boolean' ? row.present : row.value === 'present' ? true : row.value === 'absent' ? false : null;
        const stale = row.stale === true;
        return {
          mode: 'projection',
          text: present === null ? '未知' : present ? '有人在场' : '没人在场',
          present,
          confidence: typeof row.confidence === 'number' ? row.confidence : null,
          source: typeof row.source === 'string' ? row.source : null,
          updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
          stale,
          ttlSeconds: typeof row.ttlSeconds === 'number' ? row.ttlSeconds : null,
          note: stale
            ? '投影已过期（超过 TTL）：这是「上次看到人」而不是「现在有人」'
            : '来自 world_state 投影（M6 摄像头在场检测）',
          checkedAt,
        };
      }
      return { mode: 'not-integrated', text: '未接入', present: null, confidence: null, source: null, updatedAt: null, stale: null, ttlSeconds: null, note: 'world_state 里还没有 presence.home 这一行（摄像头还没看到过人）', checkedAt };
    }
    const readEvents = candidate.readEvents;
    if (typeof readEvents === 'function') {
      const events = (readEvents as (query: Record<string, unknown>) => unknown[]).call(store, { type: 'presence.changed', limit: 1 });
      const latest = Array.isArray(events) ? (events[0] as Record<string, unknown> | undefined) : undefined;
      if (latest !== undefined && latest !== null) {
        const payload = (latest.payload ?? {}) as Record<string, unknown>;
        const present = typeof payload.present === 'boolean' ? payload.present : null;
        return {
          mode: 'events',
          text: present === null ? '未知' : present ? '有人在场' : '没人在场',
          present,
          confidence: typeof latest.confidence === 'number' ? latest.confidence : null,
          source: typeof latest.source === 'string' ? latest.source : null,
          updatedAt: typeof latest.timestamp === 'string' ? latest.timestamp : null,
          stale: null,
          ttlSeconds: null,
          note: '来自事件日志的 presence.changed（现场投影 world_state 还未接入）',
          checkedAt,
        };
      }
    }
    return { mode: 'not-integrated', text: '未接入', present: null, confidence: null, source: null, updatedAt: null, stale: null, ttlSeconds: null, note: '没有 world_state 投影，也没有 presence.changed 事件：摄像头在场检测（M6）尚未接入', checkedAt };
  } catch (error) {
    return {
      mode: 'error',
      text: '读取失败',
      present: null,
      confidence: null,
      source: null,
      updatedAt: null,
      stale: null,
      ttlSeconds: null,
      note: `在场投影读不出来：${error instanceof Error ? error.message : String(error)}（摄像头自检不受影响）`,
      checkedAt,
    };
  }
}

/**
 * Chinese label for every reason code, in the engine's fixed evaluation order.
 *
 * The three retired ADR-0009 codes stay labelled on purpose: decisions already written to the
 * log carry them, and a page that shows history must be able to explain an old row
 * (ADR-0011: retiring a reason is not rewriting the log).
 */
export const PROACTIVE_GATE_LABELS: Readonly<Record<ProactiveReasonCode | ProactiveRetiredReasonCode, string>> = Object.freeze({
  DISABLED: '主动性总开关关闭',
  TRIGGER_DISABLED: '这个触发源关掉了',
  ALREADY_DELIVERED: '这条已经说过了（不重发）',
  DND_ACTIVE: '安静模式 / 今天安静点',
  QUIET_HOURS: '静默时段（安全底线，不可放宽）',
  PRIVACY_BLOCKED: '隐私与同意（安全底线，不可放宽）',
  QUOTA_6H_EXCEEDED: '6 小时额度已用完',
  QUOTA_DAY_EXCEEDED: '当日额度已用完（只算真正开口的次数，问模型另计）',
  QUOTA_CONSULT_EXCEEDED: '当日问询额度已用完（问模型的次数单独计，不吃开口额度）',
  CONVERSATION_ACTIVE: '正在对话里（或还有一轮没结束）',
  NEW_SESSION_FLOOR: '新会话速率下限：距上一条主动开口太近（热聊接话不受这条限制）',
  SCENE_UNAVAILABLE: '场景不合适（媒体播放中 / 通话中）',
  SPEECH_UNAVAILABLE: '语音输出不可用',
  BELOW_RECOMMENDATION: '社会预算建议这次不说（冷却/重复/未回应只是扣分，不是禁止）',
  MODEL_DECLINED: '模型读空气：这次不说',
  PASSED: '全部通过：可以开口',
  // 已停用（只为读旧记录保留标签）
  COOLDOWN_ACTIVE: '[旧] 距上一条主动开口还没到冷却时间',
  TOPIC_REPEATED: '[旧] 同一话题在抑制窗口内说过了',
  SCORE_BELOW_THRESHOLD: '[旧] 分数没到阈值',
});

/** Chinese label for every trigger source (§16 priority order). */
export const PROACTIVE_TRIGGER_LABELS: Readonly<Record<ProactiveTrigger, string>> = Object.freeze({
  future_hook_due: '未来钩子到期（你之前提过的事）',
  presence_arrived: '有人到家（摄像头在场）',
  conversation_dangling: '对话悬着没说完',
  routine_expected: '作息预期（这个点通常会发生）',
  topic_pool: '话题池里轮到一个',
  random_smalltalk: '随机闲聊（默认关：没合适话题就别开口）',
});

export function formatClockMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${`${Math.floor(wrapped / 60)}`.padStart(2, '0')}:${`${wrapped % 60}`.padStart(2, '0')}`;
}

/**
 * One row of the gate table (`proactiveGateRows`) — moved here verbatim from
 * `scripts/field-test.ts` in Step B: the function that builds the rows is runtime code now, and a
 * package cannot import the console's declarations (the dependency would run backwards).
 */
export interface ProactiveGateRow {
  readonly code: ProactiveReasonCode;
  readonly label: string;
  /** `passed` = evaluated and allowed; `blocked` = the first gate that fired; `skipped` = never reached. */
  readonly status: 'passed' | 'blocked' | 'skipped';
}

/**
 * The gate table for one consideration.
 *
 * The engine evaluates the gates in `PROACTIVE_REASON_CODES` order and reports only the
 * first hit, so the rows are derived from that single code: everything *before* the hit
 * passed, the hit itself blocked (or passed, for `PASSED`), everything after was never
 * evaluated. That keeps the table honest without duplicating any gate logic here.
 */
export function proactiveGateRows(reasonCode: ProactiveReasonCode | null): ProactiveGateRow[] {
  if (reasonCode === null) return PROACTIVE_REASON_CODES.map((code) => ({ code, label: PROACTIVE_GATE_LABELS[code], status: 'skipped' as const }));
  const hit = PROACTIVE_REASON_CODES.indexOf(reasonCode);
  return PROACTIVE_REASON_CODES.map((code, index) => ({
    code,
    label: PROACTIVE_GATE_LABELS[code],
    status: index < hit ? 'passed' : index === hit ? (code === 'PASSED' ? 'passed' : 'blocked') : 'skipped',
  }));
}

/** `YYYY-MM-DD` of the local natural day; `offsetMinutes` is the test/replay seam. */
export function localDayOf(at: Date, offsetMinutes?: number): string {
  const shifted = offsetMinutes === undefined ? at : new Date(at.getTime() + offsetMinutes * 60_000);
  const year = offsetMinutes === undefined ? shifted.getFullYear() : shifted.getUTCFullYear();
  const month = `${(offsetMinutes === undefined ? shifted.getMonth() : shifted.getUTCMonth()) + 1}`.padStart(2, '0');
  const day = `${(offsetMinutes === undefined ? shifted.getDate() : shifted.getUTCDate())}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** What to do about a blocked candidate — the page prints this verbatim. */
export const PROACTIVE_GATE_NEXT_STEPS: Readonly<Record<ProactiveReasonCode, string>> = Object.freeze({
  DISABLED: '把「允许西西主动开口」打开（或点页面上的开关），再试一次。',
  TRIGGER_DISABLED: '在触发源里把这一项打开，或换一个触发源再试。',
  ALREADY_DELIVERED: '这是同一条候选（candidate_id 相同），按「最多说一次」的规矩不再重发；换一个 id 再试。',
  DND_ACTIVE: '西西现在处在安静模式：点「新会话」或 /resume 恢复后再试。',
  QUIET_HOURS: '现在在静默时段内（安全底线，接口不允许放宽）。把静默时段改到自己不在家的时段再试，或等过了这个时段。',
  PRIVACY_BLOCKED: '隐私与同意没给：这是安全底线，先去设置里明确允许，再试（模型与接口都不能越过它）。',
  QUOTA_6H_EXCEEDED: '6 小时额度用完了：等窗口滚动，或把 6 小时额度调大。',
  QUOTA_DAY_EXCEEDED: '当日额度用完了（只算真正开口的次数，问模型另计 max_consults_per_day）：等明天，或把 max_per_day 调大。',
  QUOTA_CONSULT_EXCEEDED: '当日问模型的次数用完了（与开口额度分开计）：等明天，或把 max_consults_per_day 调大。',
  CONVERSATION_ACTIVE: '正在对话里：等这一轮结束（或 FSM 回到 IDLE）再试；热聊中接话用 conversation_continuation 这一类候选，不受这条限制。',
  NEW_SESSION_FLOOR: '距上一条主动开口还不到速率下限（new_session_min_gap_min）：等过了这个间隔再试；热聊中接话不受这条限制。',
  SCENE_UNAVAILABLE: '场景不合适：等媒体播完 / 通话结束再试。',
  SPEECH_UNAVAILABLE: '语音输出不可用：检查 TTS/扬声器，或先只看文字。',
  BELOW_RECOMMENDATION:
    '社会预算建议不说：冷却/话题重复/未回应都只是扣分项，不是禁止——把这几项调小、换一个更有价值的话题，或让模型读空气后决定（模型可以在建议开口时说不）。',
  MODEL_DECLINED: '模型读了空气，这次选择不说：看上面的「依据」行；想让它更愿意开口，可以提高主动性或换一个更相关的话题。',
  PASSED: '已开口。',
});


// ---------------------------------------------------- resident consideration loop (t70)
//
// M5-lite: the console may run the consideration loop by itself. It is **off by default** and
// every candidate it builds is fact-based (the presence projection, the time since the last user
// turn, a documented clock hook) — no model is asked to invent something to say, so 「西西怎么
// 突然说话了」 has an answer that can be checked against the log. When the gates let a candidate
// through, the line goes through the *same* TTS path a reply uses and is played segment by
// segment (ADR-0010); when they block it, the page shows the first blocked gate and its reason.

/** Fixed clock hooks (console-side source): 「到点了」 statements, not opinions. */
export const PROACTIVE_CLOCK_HOOKS: readonly { readonly minutes: number; readonly line: string; readonly intent: string }[] = Object.freeze([
  { minutes: 9 * 60, line: '现在是上午 9 点。要我把今天要做的事记一条吗？', intent: 'morning_hook' },
  { minutes: 12 * 60 + 30, line: '现在是中午 12 点半。记得吃点东西，别又拖到下午。', intent: 'lunch_hook' },
  { minutes: 18 * 60 + 30, line: '现在是傍晚 6 点半。今天的事到这儿就算告一段落了。', intent: 'evening_hook' },
  { minutes: 21 * 60, line: '现在是晚上 9 点。要不要我帮你把明天的事记一下？', intent: 'night_hook' },
]);

/** How long without a user turn before 「长时间没人说话」 becomes a candidate. */
export const PROACTIVE_DANGLING_AFTER_MINUTES = 10;

/**
 * Offline (or no-key) fallback lines, several per trigger and rotated (t74).
 *
 * One fixed sentence per trigger meant every offline message was literally the same words; the
 * loop now rotates through these so a user without a key still hears variety. They stay factual —
 * each is a short statement, never an invented fact.
 */
export const PROACTIVE_OFFLINE_LINES: Readonly<Record<ProactiveTrigger, readonly string[]>> = Object.freeze({
  presence_arrived: [
    '哎，你回来啦。今天外面挺冷的，我看你外套都没穿厚。要不要先喝口热水暖暖手？对了，你要问的那件事我也记着呢，等你想说的时候再问我。',
    '回来啦。家里挺安静的，我先给你留了盏灯。要是累了就先歇会儿，想说的时候再叫我。',
  ],
  conversation_dangling: [
    '你刚才是有一会儿没说话了，我在这儿。想接着说就说，不想说也没关系。',
    '安静了一会儿了。要不要从刚才那件事接着聊？我记着呢。',
  ],
  future_hook_due: [
    '到点了，之前你让我记着的那件事可以开始了。要不要我帮你把下一步写下来？',
    '时间到了。你之前提过的那件事，现在做正合适。需要我提醒得更具体一点吗？',
  ],
  topic_pool: [
    '你前面提到过一件事，我还记着。要不要接着说两句？',
    '我刚才想起你之前说的那件事了，后来怎么样了？',
  ],
  routine_expected: [
    '这个点你通常在忙，我就问一句：需要我帮你看着时间吗？',
    '按你平时的节奏，这会儿该歇一下了。要不要我提醒你？',
  ],
  random_smalltalk: [
    '今天家里挺安静的，我就随口说一句：我在呢。',
    '没什么事，就是忽然想跟你说一声：今天过得还行吧？',
  ],
});

/** How often 「随机闲聊」 fires when the scheduler asks (it is off in the config by default). */
export const PROACTIVE_RANDOM_SMALLTALK_CHANCE = 0.15;

/**
 * Is this presence reading fresh enough to mean 「有人**刚**到家」 (t98)?
 *
 * The bug this replaces: a `present: true` row left in `world_state` long after the person left
 * (the camera child had been stopped, or the row's TTL had simply run out) still produced a
 * `presence_arrived` candidate, so 西西 greeted an empty room. A projection is a *statement with
 * an expiry date*, not a fact about now — so the candidate is only built when we can prove it is
 * still valid:
 *
 *   1. `present === true` — otherwise there is nothing to say;
 *   2. the projection's own `stale` flag is not `true` (the reader already computed the age);
 *   3. `updatedAt` parses — without a timestamp, "just arrived" cannot be proven at all;
 *   4. the age is **within the TTL** (`updatedAt + ttlSeconds >= now`,边界含相等). A missing TTL
 *      falls back to the domain default (`DEFAULT_PRESENCE_TTL_SECONDS`, 60 s) rather than to
 *      "trust it forever" — `scripts/serve-chat.ts` reads presence without passing a TTL, and that
 *      path must stay correct too.
 *
 * **The `stale` flag wins over this function's own arithmetic** (t105): when the caller hands us a
 * projection from the domain store, rule 2 short-circuits on `stale === true` and the timestamps are
 * never compared. The store uses a **greater-or-equal** rule
 * (`packages/domain/src/store.ts`: `stale: Date.parse(now) >= Date.parse(staleAfter)` in
 * `worldState()` / `worldStateEntries()`), so exactly on the boundary
 * (`updatedAt + ttlSeconds === now`) the console path says **not fresh** while rule 4 below
 * (`ageMs > ttlSeconds * 1000`) would have said "still inside the TTL". The two judgements are
 * therefore *not* identical at that one instant — the difference points the safe way (we would
 * rather not claim 「刚到家」), but do not treat them as the same rule: change one, read the other.
 * Check with `git grep -n "stale: Date.parse" -- packages/domain/src/store.ts`.
 */
export function presenceFreshness(
  presence: ProactiveCandidateContext['presence'],
  now: Date,
): { readonly fresh: boolean; readonly reason: string; readonly ageSeconds: number | null; readonly ttlSeconds: number } {
  const ttlSeconds =
    presence !== null && typeof presence.ttlSeconds === 'number' && Number.isFinite(presence.ttlSeconds) && presence.ttlSeconds >= 0
      ? // A TTL that is *given* is used as given — including 0, which means "this statement has
        // already expired". Only a missing/unusable TTL falls back to the domain default.
        presence.ttlSeconds
      : DEFAULT_PRESENCE_TTL_SECONDS;
  if (presence === null) return { fresh: false, reason: '库里还没有在场投影', ageSeconds: null, ttlSeconds };
  if (presence.present !== true) return { fresh: false, reason: `在场投影说 present=${String(presence.present)}`, ageSeconds: null, ttlSeconds };
  if (presence.stale === true) {
    // The flag outranks the arithmetic below: even when the local TTL comparison would still call
    // this "inside the window", the domain store has already judged it expired at the boundary
    // (`>=`). See the function header — the two rules differ only at that instant.
    return { fresh: false, reason: `在场投影已被标为过期（T ${ttlSeconds}s）`, ageSeconds: null, ttlSeconds };
  }
  if (presence.updatedAt === null || presence.updatedAt === undefined) {
    return { fresh: false, reason: '在场投影没有更新时间，无法证明「刚到家」', ageSeconds: null, ttlSeconds };
  }
  const updatedAt = new Date(presence.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) {
    return { fresh: false, reason: `在场投影的更新时间读不出来（${presence.updatedAt}）`, ageSeconds: null, ttlSeconds };
  }
  const ageMs = now.getTime() - updatedAt.getTime();
  const ageSeconds = Math.round(ageMs / 1000);
  if (ageMs > ttlSeconds * 1000) {
    return { fresh: false, reason: `在场投影已过期：${ageSeconds}s 前更新，TTL 只有 ${ttlSeconds}s`, ageSeconds, ttlSeconds };
  }
  return { fresh: true, reason: `${ageSeconds}s 前更新，在 ${ttlSeconds}s 的 TTL 内`, ageSeconds, ttlSeconds };
}

export interface ProactiveCandidatePlan {
  readonly candidate: ProactiveCandidate;
  /** The sentence the candidate would speak (factual, checkable against the log/clock). */
  readonly line: string;
  /** Where the fact comes from, for the page's 「这条凭什么说」 line. */
  readonly fact: string;
  /** Segment plan for that line (ADR-0010), so the page knows what it will hear. */
  readonly segments: readonly string[];
  readonly gapMs: number;
}

export interface ProactiveCandidateContext {
  readonly now: Date;
  /**
   * Presence projection (M6). `present === true` is what 「有人到家」 needs — and it must be
   * **fresh** (t98): `presenceFreshness` checks the projection's own `stale` flag and its TTL
   * *before* a `presence_arrived` candidate is built at all.
   */
  readonly presence: {
    readonly present: boolean | null;
    readonly updatedAt: string | null;
    readonly source?: string | null;
    /** `true` when the reader already decided this row is past its TTL. */
    readonly stale?: boolean | null;
    /** The row's TTL; when omitted the domain default (60 s) is assumed. */
    readonly ttlSeconds?: number | null;
  } | null;
  /** When the last user turn happened (from the event log); `null` = this store has no turns. */
  readonly lastUserTurnAt: Date | null;
  /** True when a conversation is open right now: orders the plans **and** (t9 F5) turns the 话题池 candidate into a `conversation_continuation`, the production path for 「热聊中接话」. */
  readonly inConversation: boolean;
  /** Recent *user* utterances (newest first) — the fact behind 「话题池」 (t74). */
  readonly recentUserTopics?: readonly string[] | undefined;
  /** Injected for tests; defaults to `Math.random`. 「随机闲聊」 only fires below its chance. */
  readonly random?: (() => number) | undefined;
  /** How many prior messages have been sent, used to rotate the offline lines. */
  readonly spokenCount?: number | undefined;
  /** Lines already said (newest last) — they are avoided, so two messages never repeat. */
  readonly recentLines?: readonly string[] | undefined;
  /**
   * 该追问的未完话题（pack Phase 3，来自 `TopicEngine.followUps`）。
   *
   * 这些是**优先级最高的候选**（pack §9：OpenThread 1.00 排第一），因为它们正是「她惦记着的事」：
   * 「昨天你说要去镇上办证」。事实由引擎从用户自己的轮次里提取，调用方只负责问一遍。
   */
  readonly openThreads?: readonly OpenThreadFollowUp[] | undefined;
  /**
   * 到点的提醒（pack 03 §7，来自 `ReminderScheduler.candidateInputs()`）。
   *
   * 排在所有来源之前：这是**用户自己要求、还指定了时刻**的事，到点不说就是失信；而且它与
   * 「刚发生的生活事件」不同，是**时间到了**才成立的候选。事实来自 reminders 表与它的
   * `reminder.changed` 事件，调用方只负责把到点的那几条递进来。
   */
  readonly remindersDue?: readonly ReminderCandidateInput[] | undefined;
  readonly limit?: number;
}

/**
 * Build the candidates the loop may consider, in priority order (§16).
 *
 * Deliberately dumb and factual: each entry traces back to a row in the log or to the clock.
 */
export function buildProactiveCandidates(context: ProactiveCandidateContext): ProactiveCandidatePlan[] {
  const plans: ProactiveCandidatePlan[] = [];
  const day = localDayOf(context.now);
  const minutes = context.now.getHours() * 60 + context.now.getMinutes();
  const limit = context.limit ?? 3;

  // 0a. reminder_due — 到点的提醒（pack 03 §7）。排在所有来源之前：这是**用户自己要求、并且指定了
  //     时刻**的事，到点不说就是失信；候选 id 钉在这一条提醒上（`loop-future_hook_due-reminder-<id>`），
  //     所以同一条提醒不会被说第二遍（说过之后它自己的状态已经走到 delivered/acknowledged，
  //     下一次 tick 就不会再出现在 `remindersDue` 里）。`topic_ref` 是提醒 id：重复判定按「同一条提醒」，
  //     不与别的来源共享话题窗口。
  for (const reminder of context.remindersDue ?? []) {
    plans.push(
      planFor(
        'future_hook_due',
        `reminder-${reminder.reminderId}`,
        reminder.line,
        reminder.fact,
        reminderDueComponents(),
        { intent: 'reminder_due', topicRef: reminder.reminderId, initiativeKind: 'open_loop_followup' },
      ),
    );
  }

  // 0. open_thread — 「没办完的那件事」（pack Phase 3 / §9 §10）。排在所有来源之前：
  // pack §9 的来源优先级里 OpenThread 是 1.00（第一），比「刚发生的生活事件」还高，因为这句话是
  // 父亲**自己说出口**、而且还没办完。候选 id 带上追问次数，所以「问过一次没人答」之后还能再问一次
  // （`ALREADY_DELIVERED` 挡的是同一个 id，不是同一件事）；`topic_ref` 是话题 id，
  // 引擎据此从日志里认出「已经问过了」，并在用户回答后收口、不再重复（TopicEngine.reconcile）。
  for (const followUp of context.openThreads ?? []) {
    plans.push(
      planFor(
        'future_hook_due',
        `open-thread-${followUp.threadId}-a${followUp.attempts + 1}`,
        followUp.line,
        followUp.fact,
        openThreadFollowUpComponents(),
        { intent: 'open_thread_followup', topicRef: followUp.threadId, initiativeKind: 'open_loop_followup' },
      ),
    );
  }

  // 1. presence_arrived — the projection says someone is home **and the projection is still fresh**
  // (t98: a row left over from when the camera stopped used to greet an empty room).
  const presence = context.presence ?? null;
  const freshness = presenceFreshness(presence, context.now);
  if (freshness.fresh) {
    plans.push(
      planFor(
        'presence_arrived',
        `${day}-presence`,
        pickOfflineLine('presence_arrived', context),
        `在场投影：present=true（${freshness.reason}；更新于 ${presence?.updatedAt ?? '—'}）`,
        // A greeting right after someone walks in is a strong candidate on every axis — and these are
        // the P5 social-budget signals (pack §14.2), not a thumb on the scale to sneak past the bar.
        {
          topic_quality: 0.8,
          personal_relevance: 0.9,
          freshness: 1,
          receptivity: 0.9,
          engagement: 0.8,
        },
      ),
    );
  }

  // 2. conversation_dangling — nobody has said anything for a while.
  const silentMinutes = context.lastUserTurnAt === null ? null : Math.round((context.now.getTime() - context.lastUserTurnAt.getTime()) / 60_000);
  if (silentMinutes === null || silentMinutes >= PROACTIVE_DANGLING_AFTER_MINUTES) {
    const fallback = pickOfflineLine('conversation_dangling', context);
    const line = silentMinutes === null ? fallback : `你上次说话是 ${silentMinutes} 分钟前了，还好吗？`;
    plans.push(
      planFor(
        'conversation_dangling',
        // One check-in per local day, exactly like `presence_arrived`'s `${day}-presence`. Two
        // reasons (t9 F1/F3 + the Phase-5 timeline): the old 30-minute-rotating id meant this
        // candidate *never* turned into `ALREADY_DELIVERED` (it kept re-occupying ticks), and a
        // generic line that can re-fire every half hour makes 「generic ≤ 20%」 arithmetically
        // unreachable next to a budget of at most a dozen messages a day. The 24 h generic window
        // still grades any *other* generic line (ADR-0011: the rest stays a score, not a veto).
        `${day}-dangling`,
        line,
        `事件日志：上一条 user 轮次在 ${context.lastUserTurnAt?.toISOString() ?? '（这个库还没有轮次）'}`,
        // t74: this used to sum to 0.30 — below the old 0.45 floor, so 「对话悬着」 could *never*
        // speak no matter how proactivity was tuned. P5 reads the situation properly instead
        // (checking in on someone after a long silence is high-quality and about them; nothing is
        // fresh and the room has gone quiet, which is what the two low signals say):
        {
          topic_quality: 0.85,
          personal_relevance: 0.8,
          freshness: 0.4,
          receptivity: 0.7,
          engagement: 0.3,
        },
      ),
    );
  }

  // 3. future_hook_due — a documented clock hook, valid for 30 minutes after the minute.
  const hook = PROACTIVE_CLOCK_HOOKS.find((entry) => minutes >= entry.minutes && entry.minutes !== undefined && minutes < entry.minutes + 30);
  if (hook !== undefined) {
    plans.push(
      planFor(
        'future_hook_due',
        `${day}-hook-${hook.minutes}`,
        hook.line,
        `时钟：本地时间 ${formatClockMinutes(minutes)} 命中固定钩子 ${formatClockMinutes(hook.minutes)}`,
        // t74: this used to sum to 0.32 — same dead-end as the dangling candidate. A hook that
        // *we* promised to bring up is exactly what a strong topic + relevance is for:
        {
          topic_quality: 0.9,
          personal_relevance: 0.9,
          freshness: 0.7,
          receptivity: 0.85,
          engagement: 0.6,
        },
        { intent: hook.intent, topicRef: hook.intent },
      ),
    );
  }

  // 4. topic_pool — something the user actually said recently (t74). No topic in the log means
  // no candidate: 「话题池」 must not invent a topic.
  const topic = (context.recentUserTopics ?? []).find((text) => text.trim().length >= 4);
  if (topic !== undefined) {
    const snippet = topic.trim().length > 24 ? `${topic.trim().slice(0, 24)}…` : topic.trim();
    plans.push(
      planFor(
        'topic_pool',
        `${day}-topic-${hashText(topic)}`,
        `你前面提到「${snippet}」，要不接着说两句？`,
        `事件日志：最近的用户轮次说过「${snippet}」`,
        // The topic *is* memory, and re-opening it with the person who mentioned it is valuable;
        // quality is a little lower than a live event because nothing happened just now.
        {
          topic_quality: 0.8,
          personal_relevance: 0.9,
          freshness: 0.5,
          receptivity: 0.8,
          engagement: 0.7,
        },
        {
          // t9 F3: the topic text itself is the topic (≤120 chars — the event schema's cap).
          topicRef: snippet,
          // t9 F5: while a conversation is still open this same fact is 「热聊中接话」, not a new
          // external sharing — that is the production path pack §14.3 asks for (the engine lets a
          // continuation past CONVERSATION_ACTIVE and charges it no interruption cost).
          ...(context.inConversation ? { initiativeKind: 'conversation_continuation' as const } : {}),
        },
      ),
    );
  }

  // 5. random_smalltalk — 「没理由，就想说一句」 (t74). It is **off in the shipped config**, and it
  // only fires occasionally even when switched on: a companion that always has something to say
  // is not company, it is noise.
  const random = context.random ?? Math.random;
  if (random() < PROACTIVE_RANDOM_SMALLTALK_CHANCE) {
    plans.push(
      planFor(
        'random_smalltalk',
        `${day}-smalltalk-${Math.floor(minutes)}`,
        pickOfflineLine('random_smalltalk', context),
        '随机闲聊：没有具体事件，只是低概率自发说一句（面板可单独关）',
        {
          // Nothing happened — that is the point of this source, so quality stays low…
          topic_quality: 0.3,
          // …and it is not about anything the household did either.
          personal_relevance: 0.4,
          // It *is* new, in the sense that nothing else is going on.
          freshness: 0.6,
          receptivity: 0.7,
          engagement: 0.6,
        },
      ),
    );
  }

  return plans.slice(0, limit);
}

/**
 * 离线（或无密钥、模型失败）时的兜底内容。
 *
 * 两个来源，优先级不同：
 *
 *   * **未完话题**（`initiative_kind = open_loop_followup`，pack Phase 3）：用候选自己那句
 *     「你之前说过要去镇上办证，后来怎么样了？」——泛泛的钩子句会把「惦记的是哪件事」丢掉，
 *     而这正是这条候选存在的理由。
 *   * 其它来源：继续用轮换的固定短句（t74：同一个来源也不该每次说一模一样的话）。
 */
function offlineLineFor(plan: ProactiveCandidatePlan, spoken: readonly string[]): string {
  if (plan.candidate.initiativeKind === 'open_loop_followup' && plan.line.trim().length > 0) return plan.line;
  return pickOfflineLine(plan.candidate.trigger, { recentLines: spoken, spokenCount: spoken.length });
}

/** Pick an offline line that has not been said recently, rotating with the message count. */
function pickOfflineLine(
  trigger: ProactiveTrigger,
  // Only these two fields are read here, so that is all the parameter asks for. Reusing the whole
  // `ProactiveCandidateContext` would demand a clock/presence/conversation state this caller does
  // not have — and never uses.
  context: { readonly recentLines?: readonly string[]; readonly spokenCount?: number },
): string {
  const lines = PROACTIVE_OFFLINE_LINES[trigger];
  if (lines.length === 0) return '我在。';
  const recent = context.recentLines ?? [];
  const fresh = lines.filter((line) => !recent.includes(line));
  const pool = fresh.length > 0 ? fresh : lines;
  const index = (context.spokenCount ?? 0) % pool.length;
  return pool[index] as string;
}

/** Stable short hash for a candidate id (the text itself is too long to embed). */
function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 1_000_000_007;
  }
  return hash.toString(36);
}

/**
 * The triggers the loop can actually produce today (t74).
 *
 * `routine_expected` (作息预期) is registered in the engine's settings and shown in the panel, but
 * this console has **no routine model** to base it on (M4 work) — and a candidate with no fact
 * behind it would be exactly the "model invents something to say" behaviour this project forbids.
 * The panel labels it as such instead of pretending, and `buildProactiveCandidates` never emits it.
 */
export const PROACTIVE_TRIGGERS_WITH_SOURCES: readonly ProactiveTrigger[] = Object.freeze([
  'presence_arrived',
  'conversation_dangling',
  'future_hook_due',
  'topic_pool',
  'random_smalltalk',
]);

/**
 * The strongest score each live trigger can reach with the facts available to it.
 *
 * Used by the tests (and shown in the panel) so a trigger can never silently become impossible
 * again: 「这个源在最高主动性下能过线吗」 is a question with a numeric answer. The scenario supplies
 * every fact the sources can use (someone home, a long silence, a clock hook, a recent topic).
 */
export function triggerScoreCeiling(now: Date, recentTopic = '明天要去医院复查一下'): Record<ProactiveTrigger, number | null> {
  const ceiling = {} as Record<ProactiveTrigger, number | null>;
  for (const trigger of PROACTIVE_TRIGGERS) ceiling[trigger] = null;
  const rich = buildProactiveCandidates({
    now,
    presence: { present: true, updatedAt: now.toISOString() },
    lastUserTurnAt: new Date(now.getTime() - (PROACTIVE_DANGLING_AFTER_MINUTES + 5) * 60_000),
    inConversation: false,
    recentUserTopics: [recentTopic],
    random: () => 0, // force 「随机闲聊」 to be considered, so its ceiling is included
    limit: 8,
  });
  for (const plan of rich) {
    // `proactivity = 1.0` is the floor of the threshold curve (0.45), and it also supplies the
    // budget's `base_proactivity` term at its maximum — both halves of "could this trigger ever
    // speak, at the most proactive setting there is".
    const score = scoreProactiveCandidate({ ...plan.candidate.components, base_proactivity: 1 });
    const current = ceiling[plan.candidate.trigger];
    ceiling[plan.candidate.trigger] = current === null ? score : Math.max(current, score);
  }
  return ceiling;
}

function planFor(
  trigger: ProactiveTrigger,
  slug: string,
  line: string,
  fact: string,
  components: Readonly<Record<string, number>>,
  options: {
    readonly intent?: string;
    /**
     * The candidate's real topic, or `null` for a generic line (t9 F3: `topicRef` used to be the
     * **trigger name**, which made 「generic 占比」 structurally unable to fail and let two
     * different 沉默跟进 look like 「the same topic」. Only 话题池 / 时间钩子 carry a topic now;
     * 到家打招呼、沉默跟进、随机闲聊 are generic → `null`).
     */
    readonly topicRef?: string | null;
    /** Overrides the trigger's default kind (t9 F5: a live chat turns 话题池 into 热聊接话). */
    readonly initiativeKind?: ProactiveInitiativeKind;
  } = {},
): ProactiveCandidatePlan {
  const split = splitReplyIntoSegments(line);
  return {
    candidate: {
      candidateId: `loop-${trigger}-${slug}`,
      trigger,
      components,
      topicRef: options.topicRef ?? null,
      intent: options.intent ?? trigger,
      ...(options.initiativeKind === undefined ? {} : { initiativeKind: options.initiativeKind }),
    },
    line,
    fact,
    segments: split.segments,
    gapMs: split.gapMs,
  };
}

export interface ProactiveLoopEntry {  readonly at: string;
  readonly candidateId: string;
  readonly trigger: string;
  readonly triggerLabel: string;
  /** pack §14.1 的主动性质（`new_session`/`conversation_continuation`/`open_loop_followup`/…）。 */
  readonly initiativeKind: ProactiveInitiativeKind;
  readonly initiativeLabel: string;
  readonly speak: boolean;
  /** The gate that decided this entry. Typed as the union (not `string`) because every consumer
   * indexes `PROACTIVE_GATE_LABELS` / `PROACTIVE_GATE_NEXT_STEPS` with it. */
  readonly reasonCode: ProactiveReasonCode;
  readonly reasonLabel: string;
  readonly nextStep: string;
  readonly score: number;
  readonly threshold: number;
  /** What the social budget suggested (the model may have decided otherwise). */
  readonly recommendation: 'speak' | 'hold';
  /** The heaviest signal behind the decision, in Chinese (program-rendered). */
  readonly primarySignalLabel: string;
  /** The auditable 依据 lines: numbers from the program, never model prose (铁律 5). */
  readonly basis: readonly string[];
  readonly decidedBy: 'program' | 'model';
  readonly modelConsulted: boolean;
  readonly gates: readonly ProactiveGateRow[];
  readonly text: string | null;
  readonly segments: readonly string[];
  readonly gapMs: number;
  /** One entry per segment: a playable base64 WAV, or `null` when that segment could not be made. */
  readonly audio: readonly (string | null)[] | null;
  /** Why there is no audio (no key, `--no-tts`, a TTS error) — never silently empty. */
  readonly audioNote: string | null;
  readonly fact: string;
  /** Where the *content* came from: the model (key present) or the fixed fallback line (t74). */
  readonly contentSource: ProactiveContentSource;
  /** `true` when this message carried a still frame (t88: only with 「允许西西自己看」 on). */
  readonly imageUsed: boolean;
  /** Anything the reader should know about the content (fallback reason, model error, …). */
  readonly contentNote: string | null;
  /** Sequence of the assistant `conversation.turn` written for this message, when one was. */
  readonly turnEventSequence: number | null;
}

/** Where a proactive line came from. */
export type ProactiveContentSource = 'model' | 'fixed';

export interface ProactiveComposedContent {
  readonly text: string;
  readonly source: ProactiveContentSource;
  readonly note: string | null;
  /** `true` when a still frame was attached to this call (t88: only with the switch on). */
  readonly imageUsed?: boolean;
  /**
   * t111: the tool the model actually ran while composing this line (`null`/absent = none ran).
   * It travels with the content so the recorded assistant turn carries the same `tool_name` the
   * audit relies on — 「说了具体天气就必须有一次工具调用」 can then be checked in the event log.
   */
  readonly toolName?: string | null;
}

export interface ProactiveComposeInput {
  readonly plan: ProactiveCandidatePlan;
  readonly delivery: ProactiveDelivery;
}

export interface ProactiveLoopOptions {
  readonly store: XixiStore;
  readonly readSettings: () => ProactiveSettings;
  readonly readState: () => ConversationState;
  readonly readInFlightTurn?: () => boolean;
  readonly readProactivity: () => number;
  readonly readPresence: () => Promise<{ readonly present: boolean | null; readonly updatedAt: string | null; readonly source?: string | null } | null>;
  readonly readLastUserTurnAt: () => Date | null;
  /** Recent user utterances (newest first) — the fact behind 「话题池」 (t74). */
  readonly readRecentUserTopics?: (() => readonly string[] | undefined) | undefined;
  /**
   * 该追问的未完话题（pack Phase 3）。生产实现应当**先对齐再取**：
   * `topicEngine.reconcile(now); return topicEngine.followUps(now);`（见 scripts/field-test.ts 的装配处）。
   */
  readonly readOpenThreads?: (() => readonly OpenThreadFollowUp[]) | undefined;  /**
   * 可选的 `TopicEngine`：给了它就在每个 tick 里**先对齐再取候选**（提取 → 认下已说出口的 → 按回答
   * 收口 → `followUps`），这正是现场测试控制台 `readOpenThreads` 做的事，只是把「怎么对齐」交给循环，
   * 免得每个调用方各写一遍。给了它就不要再给 {@link readOpenThreads}（两者互斥，前者优先）。
   */
  readonly topicEngine?: TopicEngine | undefined;
  /**
   * 到点的提醒（pack 03 §7）。生产实现是 `() => reminderScheduler.tick(now).becameCandidate` 的
   * 结果映射（`ReminderScheduler.candidateInputs(now)`）——**先跑到点、再取候选**，与 `topicEngine`
   * 那条路同一个取向（对齐交给循环，调用方只提供引擎）。
   */
  readonly readDueReminders?: (() => readonly ReminderCandidateInput[]) | undefined;
  /**
   * 一条提醒**真的被说出口**之后回调（`candidate → delivered` 的那一步）。
   *
   * 由循环在「已经决定了要说、内容也已经生成」之后调用：参数是提醒 id 与这一轮的时刻。生产实现
   * 是 `(id, at) => reminderScheduler.deliver(id, at)`；不接线时提醒会停在 `candidate`，那是**如实**
   * 的状态（说了没说，循环最清楚），不会假装已经提醒过。
   */
  readonly onReminderDelivered?: ((reminderId: string, at: Date) => void) | undefined;
  /** Injected for tests; 「随机闲聊」 only fires below `PROACTIVE_RANDOM_SMALLTALK_CHANCE`. */
  readonly random?: (() => number) | undefined;
  readonly readSessionId: () => string | null;
  readonly replyLimits?: Readonly<Record<string, unknown>> | undefined;
  readonly synthesize?: ((text: string) => Promise<Buffer>) | undefined;
  /**
   * Runtime-resolved TTS seam (t78): the console has a 朗读 switch, so the *availability* of
   * synthesis must be read at delivery time, not fixed when the loop is constructed.
   */
  readonly synthesizeProvider?: (() => ((text: string) => Promise<Buffer>) | undefined) | undefined;
  /**
   * How the spoken line is produced — called **from inside the delivery seam**, i.e. only after
   * every gate has let the candidate through (t74). A model call here means "we already decided
   * to speak"; it can never be what made the decision.
   */
  readonly compose?: ((input: ProactiveComposeInput) => Promise<ProactiveComposedContent>) | undefined;
  /**
   * P5 读空气 (ADR-0011): the model's "say it or not" seam. It is called **only** for candidates
   * the social budget already recommends speaking about, and the call is charged to the daily
   * budget (`model_consulted`). Absent → the deterministic recommendation decides, which is what
   * keeps the offline tests hermetic and free.
   */
  readonly decide?: ProactiveDecider | undefined;
  /**
   * V0.3 P1-b：读空气时给模型的**上下文摘要**（关系 + 未完话题 + 记忆）。
   *
   * 由拿着 `ContextBuilder` 的入口提供（`engine.buildProactiveDecisionContext`）；参数是这一条
   * 候选的决策输入 —— 入口用它挑一个合适的检索查询（例如 `basis` 那几行确定性依据）。
   * 省略时决策输入逐字不变；返回 `null` = 这一轮没有上下文（例如没接线）。
   */
  readonly readContext?: ((input: ProactiveModelInput) => ProactiveContextLines | null) | undefined;
  readonly intervalMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * Local UTC offset for the engine's quiet-hours and day-boundary maths. Unset in production
   * (local wall clock is the truth); the 12-hour timeline passes one so a simulated day judges
   * exactly the same window regardless of the machine's own timezone.
   */
  readonly offsetMinutes?: number | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/** The page cannot make this hammer the gates: 5 s is the floor, 30 s the default. */
export const MIN_LOOP_INTERVAL_MS = 5_000;
export const DEFAULT_LOOP_INTERVAL_MS = 30_000;
/** How many entries the pages keep (memory only; the event log is the durable record). */
export const LOOP_HISTORY_LIMIT = 40;

/**
 * Outcomes that answer a question about **this candidate**, not about the tick (t9 F1): the walk
 * keeps going so a held high-priority plan cannot starve the sources below it. Deliberately not in
 * this set: `PASSED` (a delivery ends the tick), the hard floors that block every plan equally
 * (quiet hours, DND, privacy, quotas, scene, speech) and `MODEL_DECLINED` (the model just read the
 * room — a second paid consultation in the same instant would buy nothing).
 */
const TICK_WALK_CODES: ReadonlySet<ProactiveReasonCode> = new Set<ProactiveReasonCode>([
  'TRIGGER_DISABLED',
  'BELOW_RECOMMENDATION',
  'CONVERSATION_ACTIVE',
  'NEW_SESSION_FLOOR',
]);

/**
 * A resident consideration loop for the console (t70).
 *
 * One tick = build candidates → consider the first one → deliver (TTS + page message) or record
 * why it was blocked. Everything the engine enforces (switch, quiet hours, cooldown, quotas,
 * topic window, conversation active, score) is untouched: the loop only supplies candidates and
 * an id that makes re-delivery impossible (`loop-<trigger>-…`, rejected by ALREADY_DELIVERED).
 */
export class ProactiveLoop {
  readonly #options: ProactiveLoopOptions;
  readonly #entries: ProactiveLoopEntry[] = [];
  /** Every line already spoken (newest last): the source of 「连续两条不重复同一句」 (t74). */
  readonly #spoken: string[] = [];
  #timer: NodeJS.Timeout | null = null;
  #intervalMs: number;
  #ticking = false;
  #startedAt: string | null = null;
  #ticks = 0;

  constructor(options: ProactiveLoopOptions) {
    this.#options = options;
    this.#intervalMs = clampInterval(options.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS);
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  status(): { readonly running: boolean; readonly intervalMs: number; readonly ticks: number; readonly startedAt: string | null; readonly entries: number } {
    return { running: this.running, intervalMs: this.#intervalMs, ticks: this.#ticks, startedAt: this.#startedAt, entries: this.#entries.length };
  }

  entries(): readonly ProactiveLoopEntry[] {
    return this.#entries;
  }

  /** Lines this loop has already spoken, newest last (the no-repeat memory). */
  spokenLines(): readonly string[] {
    return [...this.#spoken];
  }

  /** Entries the page has not seen yet (`cursor` = how many it already has). */
  messagesSince(cursor: number): { readonly cursor: number; readonly entries: readonly ProactiveLoopEntry[] } {
    const from = Math.max(0, Math.min(cursor, this.#entries.length));
    return { cursor: this.#entries.length, entries: this.#entries.slice(from) };
  }

  start(intervalMs?: number): void {
    if (intervalMs !== undefined) this.#intervalMs = clampInterval(intervalMs);
    if (this.#timer !== null) return;
    this.#startedAt = new Date().toISOString();
    this.#options.log?.(`[proactive-loop] 开始自动考虑：每 ${Math.round(this.#intervalMs / 1000)} 秒一次（默认关，随时可停）`);
    void this.tickOnce();
    this.#timer = setInterval(() => void this.tickOnce(), this.#intervalMs);
    // A resident loop must not keep a script alive by itself (tests, `--self-test`).
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#options.log?.('[proactive-loop] 已停止自动考虑');
  }

  /**
   * One consideration, exposed for the page's 「立刻考虑一次」 button and for tests.
   *
   * Returns the entry (spoken or blocked), or `null` when no candidate could be built.
   *
   * t9 F1 (tick starvation): the walk stops only on an outcome that answers **this tick** — a
   * delivery, a hard floor that would block every plan anyway, or the model's own 「不说」. A
   * candidate that merely cleared the floor but scored below the recommendation line (or is
   * blocked for *its* kind only) no longer ends the tick: the old loop returned on the first
   * non-`ALREADY_DELIVERED` result, so the 30-minute-rotating 沉默跟进 held every single tick and
   * the clock hooks below it never even got considered (t9 measured hooks speaking 0 times in 12 h).
   * `ALREADY_DELIVERED` still walks on silently; only the entry this tick *reports* reaches the
   * page (every consideration is in the event log regardless — 铁律 5).
   */
  async tickOnce(): Promise<ProactiveLoopEntry | null> {
    if (this.#ticking) return null; // a slow TTS call must not overlap the next tick
    this.#ticking = true;
    try {
      const now = this.#options.now?.() ?? new Date();
      this.#ticks += 1;
      const presence = await this.#options.readPresence();
      /**
       * 未完话题（pack Phase 3）的两种装配：显式 `readOpenThreads`（控制台那条路，它自己先 reconcile
       * 再取），或者把 `TopicEngine` 交给循环、由这里统一「先对齐再取」。两条都是**同一个生产引擎**
       * 的同一套幂等调用，所以 `open_loop_followup` 候选在两条路上逐字段相同。
       */
      const openThreads = this.#options.topicEngine === undefined
        ? this.#options.readOpenThreads?.()
        : (() => {
            const now2 = this.#options.now?.() ?? now;
            this.#options.topicEngine?.reconcile(now2);
            return this.#options.topicEngine?.followUps(now2);
          })();
      const plans = buildProactiveCandidates({
        now,
        presence,
        lastUserTurnAt: this.#options.readLastUserTurnAt(),
        inConversation: this.#options.readState() !== 'IDLE' || (this.#options.readInFlightTurn?.() ?? false),
        recentUserTopics: this.#options.readRecentUserTopics?.(),
        openThreads,
        remindersDue: this.#options.readDueReminders?.(),
        random: this.#options.random,
        spokenCount: this.#spoken.length,
        recentLines: this.#spoken.slice(-4),
      });
      if (plans.length === 0) {
        this.#options.log?.('[proactive-loop] 这一次没有可说的候选（没有事实支撑就不开口）');
        return null;
      }
      let outcome: ProactiveLoopEntry | null = null;
      for (const plan of plans) {
        const entry = await this.#consider(plan, now);
        if (entry.reasonCode === 'ALREADY_DELIVERED') continue; // this source was used: try the next
        outcome = entry;
        // A global floor (quiet hours, budgets, DND, …) would block every remaining plan too, and
        // `MODEL_DECLINED` just spent a paid call reading the room — neither buys from walking on.
        if (!TICK_WALK_CODES.has(entry.reasonCode)) break;
      }
      if (outcome === null) return null;
      this.#push(outcome);
      this.#options.log?.(
        outcome.speak
          ? `[proactive-loop] 开口：${outcome.triggerLabel}（分数 ${outcome.score} ≥ ${outcome.threshold}）「${outcome.text ?? ''}」`
          : `[proactive-loop] 被拦：${outcome.triggerLabel} → ${outcome.reasonCode}（${outcome.reasonLabel}）`,
      );
      return outcome;
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * 把「读空气」包一层：判定前**现取**一次上下文摘要（关系 + 未完话题 + 记忆）。
   *
   * 为什么在这里而不是在 decider 里：`ProactiveModelInput` 是这一层的输入契约，
   * 而「上下文从哪来」是装配问题 —— 由拿着 `ContextBuilder` 的入口提供（`readContext`）。
   * 没接线时返回原来的 decider，输入一字不改。
   */
  #decideWithContext(): ProactiveDecider | undefined {
    const decide = this.#options.decide;
    if (decide === undefined) return undefined;
    const readContext = this.#options.readContext;
    if (readContext === undefined) return decide;
    return (input) => {
      const context = readContext(input);
      return decide(context === null ? input : { ...input, context });
    };
  }

  async #consider(plan: ProactiveCandidatePlan, now: Date): Promise<ProactiveLoopEntry> {
    const settings = this.#options.readSettings();
    let delivered: string | null = null;
    let contentSource: ProactiveContentSource = 'fixed';
    let imageUsed = false;
    /**
     * t111: the tool the model ran while composing (if any). It is carried into the assistant turn
     * so 「说了具体天气/温度就必须有一次工具调用」 can be checked in the event log, not only in the
     * console's own report.
     */
    let contentToolName: string | null = null;
    let contentNote: string | null = this.#options.compose === undefined ? '离线/无密钥：用固定短句兜底（内容不经过模型）。' : null;
    const engine = new ProactiveEngine({
      store: this.#options.store,
      settings,
      clock: () => now,
      offsetMinutes: this.#options.offsetMinutes,
      /**
       * P5 读空气 (ADR-0011): above the hard floor the **model** decides whether to speak.
       * The seam is only reached for candidates the social budget already considers worth it
       * (`recommendation === 'speak'`), so an obviously-bad moment costs nothing; each call that
       * does happen is recorded as `model_consulted: true` and charged to the daily budget.
       * No `decide` provider (offline/无密钥) → the deterministic recommendation decides.
       *
       * V0.3 P1-b：读空气时**也**给它关系摘要与未完话题（`readContext`）。没有 `readContext`
       * 时传给它的还是原来的 `decide`，输入逐字不变 —— 老调用方与老测试察觉不到这一层。
       */
      decide: this.#decideWithContext(),
    });
    const outcome = await engine.consider({
      candidate: plan.candidate,
      at: now,
      conversationState: this.#options.readState(),
      inFlightTurn: this.#options.readInFlightTurn?.() ?? false,
      proactivity: this.#options.readProactivity(),
      sessionId: this.#options.readSessionId(),
      /**
       * The delivery seam. **This is the first and only place content is produced** (t74): the
       * engine calls it after every gate has passed, so a model call here can never influence a
       * decision. Offline (or without a key) the composer returns the candidate's fixed line, and
       * a model that fails or answers with the silence token falls back the same way.
       */
      deliver: async (delivery) => {
        let composed: ProactiveComposedContent;
        if (this.#options.compose === undefined) {
          composed = { text: offlineLineFor(plan, this.#spoken), source: 'fixed', note: '离线/无密钥：用固定短句兜底（内容不经过模型）。' };
        } else {
          try {
            composed = await this.#options.compose({ plan, delivery });
          } catch (error) {
            composed = {
              text: offlineLineFor(plan, this.#spoken),
              source: 'fixed',
              note: `内容生成失败（${error instanceof Error ? error.message : String(error)}）：用固定短句兜底。`,
            };
          }
        }
        const text = composed.text.trim();
        if (text.length === 0 || text === SILENCE_TOKEN || text.includes(SILENCE_TOKEN)) {
          composed = {
            text: offlineLineFor(plan, this.#spoken),
            source: 'fixed',
            note: '模型这次没有给出可用内容（或返回了沉默标记）：用固定短句兜底。',
          };
        } else if (this.#spoken.includes(text)) {
          // 「连续两条不重复同一句」: a repeated line is treated as unusable and replaced by another
          // of the trigger's lines (a model that echoes itself is not going to be more creative on
          // a second try, and the user should never hear the same sentence twice in a row).
          composed = {
            text: offlineLineFor(plan, this.#spoken),
            source: 'fixed',
            note: '内容与最近说过的一句重复：换成这个触发源下的另一句。',
          };
        }
        delivered = composed.text;
        contentSource = composed.source;
        contentNote = composed.note;
        imageUsed = composed.imageUsed === true;
        contentToolName = composed.toolName ?? null;
      },
    });
    const split = delivered === null ? null : splitReplyIntoSegments(delivered, resolveReplyLimits(this.#options.replyLimits));
    const segments = split?.segments ?? [];
    const gapMs = split?.gapMs ?? 0;
    let audio: (string | null)[] | null = null;
    let audioNote: string | null = null;
    if (outcome.speak) {
      const synthesize = this.#options.synthesizeProvider?.() ?? this.#options.synthesize;
      if (synthesize === undefined) {
        audioNote = '只显示文字：朗读关闭（--no-tts）或没有可用密钥，所以这次没有合成语音。';
      } else {
        // Per segment on purpose: the page plays them with `gapMs` between them, which is what
        // ADR-0010 means by segmented speech (one clip per segment, not one clip split later).
        const clips: (string | null)[] = [];
        for (const segment of segments) {
          try {
            clips.push((await synthesize(segment)).toString('base64'));
          } catch (error) {
            clips.push(null);
            audioNote = `第 ${clips.length} 段合成失败：${error instanceof Error ? error.message : String(error)}`;
          }
        }
        audio = clips;
      }
    }
    // 西西 actually said it, so it belongs in the conversation history: the *next* user turn must
    // see it as context (otherwise a proactive message would be invisible to the dialogue).
    let turnEventSequence: number | null = null;
    if (outcome.speak && delivered !== null) {
      const sessionId = this.#options.readSessionId();
      if (sessionId !== null) {
        try {
          const recorded = this.#options.store.recordTurn({ sessionId, role: 'assistant', action: 'SPEAK', text: delivered, source: 'proactive', toolName: contentToolName });
          turnEventSequence = recorded.event.sequence;
        } catch (error) {
          contentNote = [contentNote, `没能写进对话历史：${error instanceof Error ? error.message : String(error)}`]
            .filter((row): row is string => row !== null && row.length > 0)
            .join('；');
        }
      }
    }
    /**
     * 到点的提醒被**真的说出口**了 —— 这是 pack §7 状态机的 `candidate → delivered`。
     *
     * 判定条件是「循环决定了要说」且「内容确实生成了」（与写进对话历史同一个条件），而不是
     * 「曾经考虑过」：被静默时段/额度拦下的提醒必须留在 `candidate`，否则日志会说谎。
     * 回调失败不影响这一轮：状态是记账，不是说话的前提。
     */
    if (outcome.speak && delivered !== null && plan.candidate.intent === 'reminder_due' && typeof plan.candidate.topicRef === 'string') {
      try {
        this.#options.onReminderDelivered?.(plan.candidate.topicRef, now);
      } catch (error) {
        contentNote = [contentNote, `提醒状态没能落库：${error instanceof Error ? error.message : String(error)}`]
          .filter((row): row is string => row !== null && row.length > 0)
          .join('；');
      }
    }
    // Remember what was said, so the next message cannot repeat it (t74).
    if (delivered !== null) {
      this.#spoken.push(delivered);
      while (this.#spoken.length > 10) this.#spoken.shift();
    }
    return {
      at: now.toISOString(),
      candidateId: plan.candidate.candidateId,
      trigger: plan.candidate.trigger,
      triggerLabel: PROACTIVE_TRIGGER_LABELS[plan.candidate.trigger],
      // pack §14.1 的 `initiativeKind`（新会话 / 热聊接话 / 接着没聊完的事 …）：页面与测试都靠它
      // 区分「这条主动是什么性质」，而不是从 trigger 猜。
      initiativeKind: outcome.initiativeKind,
      initiativeLabel: PROACTIVE_INITIATIVE_LABELS[outcome.initiativeKind],
      speak: outcome.speak,
      reasonCode: outcome.reasonCode,
      reasonLabel: PROACTIVE_GATE_LABELS[outcome.reasonCode],
      nextStep: PROACTIVE_GATE_NEXT_STEPS[outcome.reasonCode],
      score: outcome.score,
      threshold: outcome.threshold,
      recommendation: outcome.recommendation,
      primarySignalLabel: PROACTIVE_SIGNAL_LABELS[outcome.primarySignal === 'score' ? 'topic_quality' : outcome.primarySignal],
      basis: outcome.basis,
      decidedBy: outcome.decidedBy,
      modelConsulted: outcome.modelConsulted,
      gates: proactiveGateRows(outcome.reasonCode),
      text: delivered,
      segments,
      gapMs,
      audio,
      audioNote,
      fact: plan.fact,
      contentSource,
      imageUsed,
      contentNote,
      turnEventSequence,
    };
  }

  #push(entry: ProactiveLoopEntry): void {
    this.#entries.push(entry);
    while (this.#entries.length > LOOP_HISTORY_LIMIT) this.#entries.shift();
  }
}

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOOP_INTERVAL_MS;
  return Math.max(MIN_LOOP_INTERVAL_MS, Math.min(value, 60 * 60_000));
}

/**
 * How each trigger asks the model to open its mouth.
 *
 * The directive carries the **fact** the candidate was built from and, as a hint only, the fixed
 * line. It is a prompt, never a decision: it is only ever built after the gates passed.
 */
export function proactiveComposeDirective(plan: ProactiveCandidatePlan, recentLines: readonly string[] = []): string {
  const avoid =
    recentLines.length === 0
      ? ''
      : `最近已经说过这几句，这次不要再重复（换一种说法）：\n${recentLines.map((line) => `- ${line}`).join('\n')}\n`;
  return [
    '（这是「主动开口」时机，不是用户说话：请用一到两句自然的中文开口，像家里人一样；',
    '不要复述这条指令，不要提问超过一句，不要编造没发生过的事。',
    `触发源：${plan.candidate.trigger}。依据：${plan.fact}。`,
    avoid,
    `如果合适，可以调用工具核对真实信息（例如时间、天气）；也可以参考这句话，但要说得更自然：${plan.line}）`,
  ].join('');
}

/**
 * Compose a proactive line with the model, through the **existing** prompt + adapter path.
 *
 * Why not `engine.respond`: that would write a user turn we never received (the log would claim
 * the user said something). Instead this assembles the same system prompt the engine uses
 * (identity, hard policy, personality directives, world state, recent history) and asks the same
 * adapter — the one wired with the read-only tools — so a proactive line is as "in context" as a
 * reply, and the assistant turn is written by the loop afterwards.
 */
export function createModelComposer(options: {
  readonly engine: ConversationEngine;
  readonly sessionId: () => string | null;
  readonly available: boolean;
  readonly recentLines?: (() => readonly string[]) | undefined;
  /**
   * t88: the *only* way a proactive line can carry a picture. It returns `null` unless the user
   * switched 「允许西西自己看」 on, so the default path sends text only. Whatever it returns is
   * audited through `onUpload` — the composer never uploads silently.
   */
  readonly vision?: (() => { readonly images: readonly BrainImageInput[]; readonly info: LookOnceUploadInfo; readonly note: string } | null) | undefined;
  readonly onUpload?: ((info: LookOnceUploadInfo & { readonly trigger: LookOnceTrigger }) => void) | undefined;
  readonly timeoutMs?: number;
  readonly log?: ((line: string) => void) | undefined;
}): (input: ProactiveComposeInput) => Promise<ProactiveComposedContent> {
  return async (input: ProactiveComposeInput): Promise<ProactiveComposedContent> => {
    if (!options.available) {
      return { text: input.plan.line, source: 'fixed', note: '离线/无密钥：用固定短句兜底（内容不经过模型）。' };
    }
    const sessionId = options.sessionId();
    if (sessionId === null) {
      return { text: input.plan.line, source: 'fixed', note: '没有会话可以承载主动消息：用固定短句兜底。' };
    }
    const vision = options.vision?.() ?? null;
    const directive = proactiveComposeDirective(input.plan, options.recentLines?.() ?? []);
    const at = new Date();
    // V0.3 P1：主动开口走**同一条**上下文装配（`ContextBuilder.buildProactive`）——
    // 依据行代替用户原话做检索，且不做工作记忆展开（把上一轮当「用户刚说」塞进去正是重复的来源）。
    const prompt = options.engine.buildProactivePrompt({ directive, fact: input.plan.fact, at, sessionId });
    const stream = await options.engine.adapter.handleUserTurn({
      sessionId,
      text: directive,
      prompt,
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(vision === null ? {} : { images: vision.images }),
    });
    for await (const chunk of stream) void chunk; // the text is only needed at the end
    const result = await stream.result;
    if (vision !== null) {
      options.onUpload?.({ ...vision.info, trigger: 'auto' });
    }
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (result.action !== 'SPEAK' || text.length === 0 || text.includes(SILENCE_TOKEN)) {
      options.log?.(`[proactive] 模型这次没给出可用内容（action=${result.action}）：用固定短句兜底`);
      return { text: input.plan.line, source: 'fixed', note: `模型返回 action=${result.action}（或沉默标记）：用固定短句兜底。`, toolName: result.toolName };
    }
    // t111: 主动开口 used to say 「成都阴天 19 到 25 度」 without ever calling the weather tool.
    // A concrete claim only a lookup can produce is not allowed to leave this seam unbacked, so it
    // is dropped *before* it is spoken (the fixed line for this trigger has no numbers of its own)
    // — and 「凡说具体数值必有一次工具调用」 stays true in the event log. The rule lives in the
    // engine so both delivery paths judge the same way.
    const screened = options.engine.screenUnbackedFacts(text, result.toolName);
    if (!screened.ok) {
      const detail = screened.claims.map((claim) => claim.match).join('、');
      options.log?.(`[proactive] 模型给出了未经工具核实的可核查事实（${detail}）却没有调用工具：不发出去，改用固定短句`);
      return {
        text: input.plan.line,
        source: 'fixed',
        note: `模型给出未经工具核实的可核查事实（${detail}）且没有调用工具：按 t111 改用固定短句，不把编造的数值说出去。`,
        toolName: result.toolName,
      };
    }
    options.log?.(`[proactive] 内容由模型生成（${result.provider}/${result.model}，${text.length} 字${vision === null ? '' : `，附 1 张静帧 ${vision.info.width}x${vision.info.height}`}）`);
    return { text, source: 'model', note: vision === null ? null : `${vision.note}（已记入上传记录；开关打开时才可能附帧）`, imageUsed: vision !== null, toolName: result.toolName };
  };
}

/**
 * The 读空气 directive (pack §14.1 / ADR-0011 §决定 2).
 *
 * It carries the deterministic 依据 (the same lines the audit stores) and asks for **one JSON
 * object** — the model's answer is a decision plus one code from the fixed allowlist, never prose
 * (铁律 5).
 */
export function proactiveDecideDirective(input: ProactiveModelInput): string {
  return [
    '（这是「要不要主动开口」的判断，不是用户在说话；请只回一个 JSON 对象，不要解释、不要多余文字。）',
    `触发源：${input.candidate.trigger}（${PROACTIVE_INITIATIVE_LABELS[input.initiativeKind]}）；意图：${input.candidate.intent ?? '—'}。`,
    // V0.3 P1-b：关系与未完话题的摘要进**决策**（之前它们只影响开口之后的措辞）。
    // 顺序：记忆 → 关系 → 未完话题；空的那几段不出现（与提示词的增量口径一致）。
    ...contextLines(input.context),
    '确定性依据：',
    ...input.basis.map((line) => `- ${line}`),
    `程序建议：${input.recommendation === 'speak' ? '可以开口，但由你最终决定' : '建议这次不说'}。`,
    '你要读空气：现在真的适合开口吗？对方像是在忙、在休息、刚说过不想聊，就选择不说。',
    `只回：{"speak":true|false,"reason_code":"<${PROACTIVE_MODEL_REASON_CODES.join('|')}>"}`,
  ].join('\n');
}

/**
 * 上下文摘要那几行。
 *
 * 单独一个函数是为了让「给决策看的摘要」有一个可断言的地方：测试直接读它的输出，
 * 不必去解析整段指令；也让「不带上下文时逐字不变」这件事一眼可查（返回空数组）。
 */
export function contextLines(context: ProactiveContextLines | undefined): string[] {
  if (context === undefined) return [];
  const lines: string[] = [];
  if (context.memories.length > 0) {
    lines.push('你们以前真正聊过、这轮可能有用的事：', ...context.memories);
  }
  if (context.relationship.length > 0) {
    lines.push('你们现在相处的方式（只作参考，不要照念）：', ...context.relationship.map((line) => `- ${line}`));
  }
  if (context.openThreads.length > 0) {
    lines.push('还惦记着的事（只是提醒你别忘了，不是这次就要问）：', ...context.openThreads);
  }
  return lines;
}

/**
 * Parse the model's decision out of its text.
 *
 * Anything unusable returns `null` — the caller then falls back to the deterministic
 * recommendation and records `unspecified`, so a chatty or broken answer can never be read as a
 * hidden "yes".
 */
export function parseProactiveDecisionText(raw: string): ProactiveModelDecision | null {
  const match = /\{[\s\S]*?\}/.exec(raw);
  if (match === null) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed['speak'] !== 'boolean') return null;
    const reason = parsed['reason_code'];
    return { speak: parsed['speak'], reasonCode: typeof reason === 'string' ? reason : 'unspecified' };
  } catch {
    return null;
  }
}

/**
 * The console's model-backed 读空气 seam.
 *
 * Real call, through the same prompt + adapter path a reply uses, and **only** for candidates the
 * social budget recommends (the engine never asks otherwise). Without a key it answers with the
 * recommendation itself, which keeps the offline console hermetic and free of API calls.
 */
export function createModelDecider(options: {
  readonly engine: ConversationEngine;
  readonly sessionId: () => string | null;
  readonly available: boolean;
  readonly timeoutMs?: number;
  readonly log?: ((line: string) => void) | undefined;
}): ProactiveDecider {
  return async (input: ProactiveModelInput): Promise<ProactiveModelDecision> => {
    if (!options.available) {
      return { speak: input.recommendation === 'speak', reasonCode: input.recommendation === 'speak' ? 'good_moment' : 'not_worth_it' };
    }
    const sessionId = options.sessionId();
    if (sessionId === null) return { speak: false, reasonCode: 'wrong_moment' };
    const directive = proactiveDecideDirective(input);
    const prompt = options.engine.buildPrompt({ sessionId, text: directive, addressed: true, at: input.now });
    const stream = await options.engine.adapter.handleUserTurn({
      sessionId,
      text: directive,
      prompt,
      timeoutMs: options.timeoutMs ?? 20_000,
    });
    for await (const chunk of stream) void chunk;
    const result = await stream.result;
    const parsed = parseProactiveDecisionText(typeof result.text === 'string' ? result.text : '');
    if (parsed === null) {
      options.log?.(
        `[proactive] 读空气：模型没给出可解析的 JSON（action=${result.action}）——按确定性建议「${
          input.recommendation === 'speak' ? '开口' : '不说'
        }」处理，审计里记 unspecified`,
      );
      return { speak: input.recommendation === 'speak', reasonCode: 'unspecified' };
    }
    options.log?.(
      `[proactive] 读空气：模型选择${parsed.speak ? '开口' : '不说'}（${PROACTIVE_MODEL_REASON_LABELS[parsed.reasonCode as ProactiveModelReasonCode] ?? parsed.reasonCode}）`,
    );
    return parsed;
  };
}

/** Recent *user* utterances, newest first — the fact behind 「话题池」 (t74). */export function recentUserTopics(store: XixiStore, sessionId?: string | null, limit = 5): string[] {
  const events = store.readEvents({
    type: 'conversation.turn',
    ...(sessionId === undefined || sessionId === null ? {} : { sessionId }),
    limit: Number.MAX_SAFE_INTEGER,
  });
  const topics: string[] = [];
  for (let index = events.length - 1; index >= 0 && topics.length < limit; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload['role'] !== 'user') continue;
    const text = typeof payload['text'] === 'string' ? payload['text'].trim() : '';
    if (text.length > 0) topics.push(text);
  }
  return topics;
}

/** When the last *user* turn happened, straight from the event log (t70's 「长时间没人说话」). */
export function lastUserTurnAt(store: XixiStore, sessionId?: string | null): Date | null {
  // `readEvents` can filter by session itself; the envelope field is `session_id` (snake_case,
  // per the schema) — reading `event.sessionId` here silently matched nothing the first time.
  const events = store.readEvents({
    type: 'conversation.turn',
    ...(sessionId === undefined || sessionId === null ? {} : { sessionId }),
    limit: Number.MAX_SAFE_INTEGER,
  });
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload['role'] !== 'user') continue;
    return new Date(event.timestamp);
  }
  return null;
}
