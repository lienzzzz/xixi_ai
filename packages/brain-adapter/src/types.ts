import type { JsonValue } from '@xixi/contracts';
import type { TurnAction, TurnRole } from '@xixi/domain';
import type { BrainUsage } from './usage.ts';

/**
 * The provider seam from 《方案》§25, shrunk to what every harness really has
 * (V0.3 pack `docs/03_AGENT_PLUGIN.md` §8).
 *
 * Everything above this interface speaks Xixi's own vocabulary. Nothing above
 * it may know that DSH, a provider plugin or a model name exists: that is what
 * makes the harness replaceable (§3.2, §44).
 *
 * Until V0.3 the seam was one fat `BrainAdapter` carrying four capabilities no
 * provider ever implemented (each threw `NOT_IMPLEMENTED`, every caller either
 * ignored it or was a test): `evaluateProactiveCandidate`, `interpretFeedback`,
 * `extractMemories`, `reflect`. That is the “假统一” `00_CODE_AUDIT.md` §3.8
 * tells V0.3 not to maintain. The seam is now three interfaces:
 *
 *   * {@link TurnModelProvider} — **required** of every harness: one user turn in,
 *     one stream out. This is all `ConversationEngine` ever needed.
 *   * {@link MultimodalTurnProvider} — **optional**: the same turn, plus a still
 *     image this turn may carry.
 *   * {@link StructuredInferenceProvider} — **optional**: JSON under a schema.
 *
 * The four retired capabilities are **not declared here**, on the provider or
 * anywhere else: they already exist, deterministically, where their inputs are
 * (`ProactiveEngine` / `evaluateProactiveGates`, `interpretFeedback`,
 * `TurnMemoryExtractor`, `TopicEngine` in `@xixi/conversation`). A capability
 * interface would have to be implemented by someone, and the only reason the
 * old one existed was so a model could fill a shape something else already
 * computes. Their old shapes stay below as plain data contracts, with a note
 * saying who owns each one now.
 */

export interface ConversationTurnView {
  readonly role: TurnRole;
  readonly text: string | null;
  readonly action: TurnAction;
}

/** Assembled per-turn context (§26). Sections arrive milestone by milestone. */
export interface BrainContext {
  readonly identityName: string;
  /** Effective personality (§7.1). M0 passes the persisted baseline. */
  readonly personality: Readonly<Record<string, number>>;
  readonly timezone?: string;
  /** Working memory: the last N turns (§10.2 A). */
  readonly workingMemory?: readonly ConversationTurnView[];
  /** Current projection (§5). M1+. */
  readonly worldState?: Readonly<Record<string, JsonValue>>;
}

/**
 * One still image attached to a user turn.
 *
 * Deliberately **optional and per-turn**: 铁律 6 forbids continuous audio/video
 * leaving the machine, so the caller (a program, not the model) decides when a
 * single frame accompanies a turn. Adapters that cannot send images must refuse
 * the turn rather than drop it — otherwise the model would answer as if it had
 * seen something it never received.
 */
export interface BrainImageInput {
  /** MIME type of the encoded image, e.g. `image/jpeg`. */
  readonly mediaType: string;
  /** Base64 of the encoded bytes, without a `data:` prefix. */
  readonly base64: string;
}

export interface UserTurnInput {
  readonly maxRoundBytes?: number;
  readonly sessionId: string;
  readonly text: string;
  /**
   * Who is speaking, from the program's point of view (V0.3 P2-B). Optional: an entry that has no
   * identity resolution yet leaves it out, and a pending approval records `unknown` instead of
   * guessing. The model never supplies these — it cannot claim to be someone (铁律 1/8).
   */
  readonly actorId?: string;
  /** The event that started this turn, so a durable record can point back at it (`source_event_id`). */
  readonly sourceEventId?: string;
  readonly context?: BrainContext;
  /**
   * Prompt assembled by the conversation layer (§26), if the caller owns it.
   * Adapters that talk to a chat model keep the roles separate; adapters that
   * must flatten everything into one task string join them deterministically.
   */
  readonly prompt?: AssembledPromptLike;
  /** Optional still image(s) for **this** turn; attached to the last user message. */
  readonly images?: readonly BrainImageInput[];
  readonly timeoutMs?: number;
}

/** The prompt shape produced by `@xixi/conversation`'s PromptAssembler. */
export interface AssembledPromptLike {
  /** Stable prefix: identity, hard policy, effective personality (§46.3). */
  readonly system: string;
  /** Prior turns as real roles. */
  readonly history: readonly { readonly role: TurnRole; readonly content: string }[];
  /** Changing suffix: world state, conversation state, current turn. */
  readonly user: string;
}

/** Flatten an assembled prompt into the single task string harnesses expect. */
export function flattenPrompt(prompt: AssembledPromptLike): string {
  const transcript = prompt.history
    .filter((turn) => turn.content.length > 0)
    .map((turn) => `${turn.role === 'user' ? '用户' : '西西'}：${turn.content}`)
    .join('\n');
  return [prompt.system, transcript.length > 0 ? `【最近对话】\n${transcript}` : '', prompt.user]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

export type BrainTurnChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool'; readonly name: string }
  | { readonly type: 'notice'; readonly code: string; readonly detail: string };

export interface BrainTurnResult {
  readonly usage?: BrainUsage;
  /** §55: silence and backchannel are first-class outcomes, not failures. */
  readonly action: TurnAction;
  readonly text: string | null;
  readonly toolName: string | null;
  /** Which harness served the turn, and with which model. */
  readonly provider: string;
  readonly model: string;
  /** The provider's own session id, to persist for a later restart (§21.6). */
  readonly brainSessionId: string | null;
  readonly latencyMs: number;
  /**
   * t21 (t4's F5): why the provider stopped generating — `stop`, `length`, `tool_calls`, `content_filter`
   * … `length` is what a reply cut off mid-word looks like from here, so it is carried up to the turn
   * and to the console instead of being dropped on the floor. `null` when the transport does not say.
   */
  readonly finishReason: string | null;
}

export interface BrainTurnStream extends AsyncIterable<BrainTurnChunk> {
  /** Settles once the turn is complete; rejects with `BrainError` on failure. */
  readonly result: Promise<BrainTurnResult>;
}

export interface BrainDescription {
  readonly provider: string;
  readonly model: string;
  readonly transport: string;
  readonly mode: 'live' | 'scripted' | 'offline';
}

// ------------------------------------------------ retired capability: proactive (§15.5)
//
// NOT a provider method, and no longer a provider interface: 「该不该开口」is decided by
// `evaluateProactiveGates` + `scoreProactiveCandidate` + `ProactiveEngine` in
// `@xixi/conversation` (铁律 3: the hard floor is the program's, never the model's). The model
// only ever *advises* on a candidate the deterministic side already accepted, through
// `ProactiveDecider` / `ProactiveModelInput` there. These two shapes stay as the data contract of
// that advisory step, so a future provider seam has one definition to implement instead of a new
// one to invent.

export interface ProactiveContext {
  readonly candidateId: string;
  readonly trigger: string;
  readonly salience: number;
  readonly novelty: number;
  readonly topicCandidates: readonly string[];
  readonly worldState?: Readonly<Record<string, JsonValue>>;
  readonly futureHooks?: readonly { readonly id: string; readonly topic: string }[];
  readonly timeoutMs?: number;
}

export interface ProactiveDecision {
  readonly speak: boolean;
  readonly intent: string | null;
  readonly topicRef: string | null;
  readonly length: 'short' | 'medium' | 'long';
  readonly tone: string | null;
  readonly askQuestion: boolean;
  /** §15.5: store the reason code and scores, never model private reasoning. */
  readonly reasonCode: string;
}

// ------------------------------------------- retired capability: feedback interpretation (§7.3)
//
// NOT a provider method: `interpretFeedback` / `interpretFeedbackInput` in `@xixi/conversation`
// interpret a sentence deterministically, with `FEEDBACK_RULES` and explicit-vs-inferred weights
// (`EXPLICIT_FEEDBACK_WEIGHT` / `INFERRED_FEEDBACK_WEIGHT`), and 铁律 4 puts an explicit user
// correction above anything a model infers. The shapes stay as the data contract of that
// interpretation.

export interface FeedbackInput {
  readonly text: string;
  readonly sourceEventId?: string;
  readonly timeoutMs?: number;
}

export interface FeedbackAdjustment {
  readonly property: string;
  readonly delta: number;
  readonly confidence: number;
}

export interface FeedbackDecision {
  readonly isFeedback: boolean;
  readonly scope: 'none' | 'session_override' | 'persistent_soft' | 'persistent_explicit';
  readonly adjustments: readonly FeedbackAdjustment[];
  /** `next_day_or_session_end` for session overrides; null for persistent changes. */
  readonly expires: string | null;
  readonly reasonCode: string;
}

// ----------------------------------------------- retired capability: memory extraction (§10.6)
//
// NOT a provider method: `TurnMemoryExtractor` in `@xixi/conversation` (with the Tier-2 pass in
// `@xixi/context`) extracts memories from a turn and writes them through the domain layer. The
// shape stays as the data contract of an extracted candidate.

export interface MemoryExtractionInput {
  readonly sessionId: string;
  readonly turns: readonly ConversationTurnView[];
  readonly timeoutMs?: number;
}

export interface MemoryCandidate {
  readonly type: 'semantic' | 'episodic' | 'preference' | 'relationship' | 'self' | 'future_hook';
  readonly subject: string;
  readonly content: string;
  readonly confidence: number;
  readonly sourceEventIds: readonly string[];
  readonly sensitivity: 'normal' | 'private';
  readonly ttl: string | null;
}

// --------------------------------------------------- retired capability: reflection (§18)
//
// NOT a provider method: the day's statistics, open threads and relationship updates are derived by
// `TopicEngine` / `MemoryStore` / the domain layer from the event log, not asked of a model. The
// shapes stay as the data contract of a daily reflection.

export interface ReflectionInput {
  readonly day: string;
  readonly turns: readonly ConversationTurnView[];
  readonly proactiveActions: readonly { readonly at: string; readonly accepted: boolean | null }[];
  readonly timeoutMs?: number;
}

export interface ReflectionResult {
  readonly dailySummary: string;
  readonly memoryCandidates: readonly MemoryCandidate[];
  readonly relationshipUpdates: readonly string[];
  readonly selfAdjustmentCandidates: readonly FeedbackAdjustment[];
  readonly routineStatistics: readonly string[];
  readonly futureHooks: readonly { readonly topic: string; readonly earliestAt: string | null; readonly expiresAt: string | null }[];
}

// ------------------------------------------------------------------- the provider seam (§8)

/**
 * What **every** harness must be able to do: serve one user turn.
 *
 * This is the whole contract `ConversationEngine` depends on (plus `provider` for the durable
 * session key and `describe()` for the console). Anything a harness may *not* have lives on a
 * separate, optional interface below — never here.
 */
export interface TurnModelProvider {
  /** Stable provider name used as the key of the durable brain-session mapping. */
  readonly provider: string;
  describe(): BrainDescription;
  handleUserTurn(input: UserTurnInput): Promise<BrainTurnStream>;
}

/**
 * A {@link TurnModelProvider} that can also receive still images.
 *
 * `supportsImages` is the literal `true`, not `boolean`: the flag exists so a **runtime** check
 * (`provider.supportsImages === true`) can be trusted. An adapter that cannot send an image must
 * not declare this interface and must refuse an image turn instead of dropping the frame — a
 * silently dropped picture makes the model answer as if it had seen the room (铁律 6).
 */
export interface MultimodalTurnProvider extends TurnModelProvider {
  readonly supportsImages: true;
}

/**
 * Structured inference under a caller-owned schema (§52/§53).
 *
 * Optional and independent of the turn seam: a harness may be able to serve a conversation and
 * still have no schema-constrained path. Validation belongs to the **caller** (`validate`), because
 * the provider's `response_format` is not enforced — see `MimoClient.chatJson` in
 * `@xixi/model-adapters` for the measured defect and the retry it owns.
 */
export interface StructuredInferenceProvider {
  inferJson(options: InferJsonOptions): Promise<InferJsonResult>;
}

export interface InferJsonOptions {
  /** The user-role instruction. */
  readonly prompt: string;
  /** Schema name and body, sent as `response_format.json_schema`. */
  readonly schema: { readonly name: string; readonly schema: Record<string, unknown> };
  /** Contract check owned by the caller; throwing it makes the structured call fail. */
  readonly validate?: (value: unknown) => void;
  /** Overrides the deployment language for the repair instruction (default: the adapter's own). */
  readonly language?: string;
  readonly timeoutMs?: number;
}

export interface InferJsonResult {
  readonly json: unknown;
  readonly model: string;
  /** How many provider round trips it took (a repair counts as a second one). */
  readonly attempts: number;
  /** What the client had to do to get a usable object (e.g. the json_object fallback). */
  readonly notes: readonly string[];
  readonly totalMs: number;
}

/** Build a stream from a chunk source plus its eventual result. */
export function createBrainTurnStream(
  source: AsyncIterable<BrainTurnChunk>,
  result: Promise<BrainTurnResult>,
): BrainTurnStream {
  return {
    [Symbol.asyncIterator]: () => source[Symbol.asyncIterator](),
    result,
  };
}

/** Drain a turn: every chunk in order, then the result. */
export async function collectTurn(stream: BrainTurnStream): Promise<{ chunks: BrainTurnChunk[]; result: BrainTurnResult }> {
  const chunks: BrainTurnChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { chunks, result: await stream.result };
}

/** Split assistant text into streamable chunks; TTS starts before the whole reply exists (§46.1). */
export function* splitIntoChunks(text: string, size = 24): Generator<BrainTurnChunk> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  for (let index = 0; index < trimmed.length; index += size) {
    yield { type: 'text', text: trimmed.slice(index, index + size) };
  }
}
