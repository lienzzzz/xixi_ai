/**
 * Shared fixtures for the replay tests (`tests/replay/*.test.ts`).
 *
 * Two conventions live here, both because a replay has to mean the same thing on every machine:
 *
 *   1. **The anchor is local time.** `anchorAt(new Date(2026, 9, 5, 8, 0, 0))` — the same
 *      local-time convention the rest of the suite uses (`tests/integration/open-thread-followup.test.ts`
 *      and the topic engine's `atLocalDayHour`), so the fixtures do not depend on the machine's
 *      timezone. A `start` written in the JSON file is only the document's default anchor.
 *   2. **One source per baseline.** `onlyTrigger()` switches every proactive source off except the
 *      one the fixture is about. Otherwise a tick spends its single consideration on whatever
 *      happens to score highest (「长时间没人说话」 pre-empting the open thread, a clock hook
 *      pre-empting the arrival) and the test would be measuring the walk order instead of the
 *      behaviour it names. Writing this down beats implying it (the console's open-thread test
 *      reaches the same place by passing `readPresence: null`).
 */
import { join } from 'node:path';

import { FakeBrainAdapter, type UserTurnInput } from '@xixi/brain-adapter';
import { toOffsetIso } from '@xixi/contracts';
import { REPO_ROOT, loadReplay } from '@xixi/runtime';

/** The prose triggers, in `PROACTIVE_TRIGGERS` order — the ones `onlyTrigger` switches. */
const TRIGGER_NAMES = [
  'future_hook_due',
  'presence_arrived',
  'conversation_dangling',
  'routine_expected',
  'topic_pool',
  'random_smalltalk',
] as const;

/** A local `Date` turned into the offset-ISO string a replay start needs. */
export function anchorAt(local: Date): string {
  return toOffsetIso(local);
}

export function fixturePath(name: string): string {
  return join(REPO_ROOT, 'tests', 'replay', 'fixtures', name);
}

/**
 * When the script starts and ends, computed from the **fixture's own offsets** and the anchor the
 * test passes — not from the report.
 *
 * This matters for the "no wall-clock time leaked in" assertions: `report.start` / `report.end`
 * come from the same clock the run used, so a run that ignored the injected clock would widen its
 * own window and the assertion would pass. Reading the span out of the document instead makes the
 * bound independent of the code under test.
 */
export function scriptWindow(fixtureName: string, anchor: string): { readonly from: number; readonly to: number } {
  const document = loadReplay(fixturePath(fixtureName));
  const lastOffset = document.steps.reduce((max, step) => Math.max(max, step.offsetMs), 0);
  return { from: Date.parse(anchor), to: Date.parse(anchor) + lastOffset };
}

/**
 * A deterministic, offline brain: every reply is `收到：<what he said>`, so a test can tell the
 * turns apart by content and assert that the *injected* adapter is the one that answered.
 */
export function echoAdapter(prefix = '收到：'): FakeBrainAdapter {
  return new FakeBrainAdapter({ reply: (input: UserTurnInput) => ({ action: 'SPEAK', text: `${prefix}${input.text}` }) });
}

/** Hard floors kept out of the way: quotas and cooldowns are not what these baselines measure. */
const PERMISSIVE: Readonly<Record<string, unknown>> = Object.freeze({
  enabled: true,
  base_cooldown_min: 0,
  continuation_cooldown_min: 0,
  new_session_min_gap_min: 0,
  max_per_6h: 20,
  max_per_day: 40,
  max_consults_per_day: 20,
  unanswered_window_min: 10,
  quiet_hours: { start: '23:30', end: '07:30' },
});

/** Settings where exactly one proactive source may speak. */
export function onlyTrigger(trigger: (typeof TRIGGER_NAMES)[number]): Readonly<Record<string, unknown>> {
  const triggers: Record<string, boolean> = {};
  for (const name of TRIGGER_NAMES) triggers[name] = name === trigger;
  return { ...PERMISSIVE, triggers };
}
