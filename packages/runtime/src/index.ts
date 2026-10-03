/**
 * `@xixi/runtime` — Xixi's production runtime, assembled out of `scripts/field-test.ts`.
 *
 * V0.3 P0-A (pack `04_RUNTIME_CONSOLIDATION.md` §1) moves the code that every live entry shares here,
 * one step at a time. `scripts/field-test.ts` keeps a compatibility re-export for each symbol until
 * its last caller has moved, so nothing breaks in between.
 *
 *   Step A: `buildToolChain` + `CONVERSATION_SCOPE`   (tool-runtime.ts)
 *   Step B: the resident loop and its seams       (proactive-runtime.ts)
 *   Step C: the shared voice seams                (voice-runtime.ts)
 *
 * `./wav.ts` / `./repo.ts` / `./errors.ts` moved in the same pass because Steps B and C need them;
 * their old homes (`scripts/lib/wav.ts`, `scripts/lib/harness.ts`) re-export the same declarations.
 *
 * This file only re-exports; the lists are generated from the modules' own `export` statements.
 */

export {
  RuntimeError,
  type LookOnceTrigger,
  type LookOnceUploadInfo,
} from './errors.ts';

export {
  REPO_ROOT,
} from './repo.ts';

export {
  ingestPerceptionLine,
  type PerceptionIngestDeps,
  type PerceptionIngestOutcome,
} from './perception-ingest.ts';

export {
  CONVERSATION_SCOPE,
  buildToolChain,
  type ToolChainOptions,
} from './tool-runtime.ts';

export {
  concatWav,
  readWav,
  readWavInfo,
  sliceWav,
  type WavInfo,
} from './wav.ts';

export {
  buildSpeechAudio,
  planSpeechSegments,
  runVad,
  type DroppedSegment,
  type SegmentPlan,
  type SegmentPlanOptions,
  type SpeechSegment,
  type VadResult,
} from './voice-runtime.ts';

export {
  DEFAULT_LOOP_INTERVAL_MS,
  LOOP_HISTORY_LIMIT,
  MIN_LOOP_INTERVAL_MS,
  PROACTIVE_CLOCK_HOOKS,
  PROACTIVE_DANGLING_AFTER_MINUTES,
  PROACTIVE_GATE_LABELS,
  PROACTIVE_GATE_NEXT_STEPS,
  PROACTIVE_OFFLINE_LINES,
  PROACTIVE_RANDOM_SMALLTALK_CHANCE,
  PROACTIVE_TRIGGERS_WITH_SOURCES,
  PROACTIVE_TRIGGER_LABELS,
  ProactiveLoop,
  buildProactiveCandidates,
  createModelComposer,
  createModelDecider,
  formatClockMinutes,
  lastUserTurnAt,
  localDayOf,
  parseProactiveDecisionText,
  presenceFreshness,
  proactiveComposeDirective,
  proactiveDecideDirective,
  proactiveGateRows,
  readPresence,
  recentUserTopics,
  triggerScoreCeiling,
  type PresenceView,
  type ProactiveCandidateContext,
  type ProactiveCandidatePlan,
  type ProactiveComposeInput,
  type ProactiveComposedContent,
  type ProactiveContentSource,
  type ProactiveGateRow,
  type ProactiveLoopEntry,
  type ProactiveLoopOptions,
} from './proactive-runtime.ts';
