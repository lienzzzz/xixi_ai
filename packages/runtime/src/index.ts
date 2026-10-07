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
  REPLAY_CONFIG,
  createReplayClock,
  loadReplay,
  offsetMinutesOf,
  parseReplayDocument,
  parseReplayOffset,
  runReplay,
  type ParseReplayOptions,
  type ReplayClock,
  type ReplayDecision,
  type ReplayDocument,
  type ReplayHealthResult,
  type ReplayPresenceResult,
  type ReplayReport,
  type ReplayRunOptions,
  type ReplayStep,
  type ReplayStepKind,
  type ReplayStepResult,
  type ReplayTickResult,
  type ReplayTurnResult,
  type ReplayWorldResult,
} from './replay-runtime.ts';

export {
  CONVERSATION_SCOPE,
  buildPluginRuntime,
  buildToolChain,
  mountPluginTools,
  resolveToolApprovalSettings,
  type PluginChainOptions,
  type PluginMountReport,
  type PluginRuntimeMount,
  type PluginShutdownReport,
  type ToolChainOptions,
} from './tool-runtime.ts';

// V0.3 P2-B：工具审批（pack 03 §5）的宿主侧。`buildToolChain` 用它当 `ToolApprovalGate`，
// 入口用它恢复「谁在等谁点头」。
export {
  ToolApprovalError,
  ToolApprovalManager,
  UNKNOWN_ACTOR,
  type ToolApprovalDecision,
  type ToolApprovalManagerOptions,
} from './tool-approval.ts';

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
  contextLines,
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
// V0.3 P1-b：三个入口共用的「一轮之后的记忆提取」装配（chat / 试用页 / voice-turn 都调它）。
export { createTurnExtraction, type TurnExtraction, type TurnExtractionOptions } from './turn-extraction.ts';

// V0.3 P2-E：durable 提醒（pack 03 §7）的宿主侧。`DurableReminderSink` 接进工具链当 `reminderSink`，
// `ReminderScheduler` 跑到点与五态；两条都写 `reminder.changed` 事件（与表同一事务）。
export {
  DurableReminderSink,
  REMINDER_SOURCE,
  ReminderScheduler,
  reminderDueComponents,
  type DurableReminderSinkOptions,
  type ReminderCandidateInput,
  type ReminderSchedulerOptions,
  type ReminderTickReport,
  type ReminderTurnIdentity,
} from './reminder-runtime.ts';

// V0.3 P2.5-A：**唯一的常驻装配点**。上面这些零件（工具链、插件内核、审批宿主、durable 提醒、
// 提取、引擎）在这里被组装成一个对象，live 入口只调一次取用。
// **接线状态：四个 live 入口尚未接线**（它们仍然各自拼一套），提醒也还没有接进主动循环 ——
// 这两句的完整口径与逐条说明在 `./resident-runtime.ts` 顶部的接线状态块里，别在别处另写一份。
export {
  createResidentRuntime,
  type ResidentConversationOptions,
  type ResidentMemoryOptions,
  type ResidentModelContext,
  type ResidentModelInput,
  type ResidentPluginStartSummary,
  type ResidentRuntimeOptions,
  type ResidentRuntimeState,
  type ResidentShutdownReport,
  type ResidentStartReport,
  type XixiResidentRuntime,
} from './resident-runtime.ts';
