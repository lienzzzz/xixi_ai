import type { JsonValue } from '@xixi/contracts';
import type { TurnAction, TurnRole } from '@xixi/domain';

/**
 * The BrainAdapter seam from 《方案》§25.
 *
 * Everything above this interface speaks Xixi's own vocabulary. Nothing above
 * it may know that DSH, a provider plugin or a model name exists: that is what
 * makes the harness replaceable (§3.2, §44).
 *
 * M0 implements `handleUserTurn` for real. The other four capabilities are
 * declared so their signatures are fixed early, and each throws
 * `BrainError('NOT_IMPLEMENTED')` naming the milestone that will build it —
 * an honest gap, not a silent stub.
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
  readonly sessionId: string;
  readonly text: string;
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

// ---------------------------------------------------------------- M5: proactive (§15.5)

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

// ------------------------------------------------------- M3: feedback interpretation (§7.3)

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

// ------------------------------------------------------------- M4: memory extraction (§10.6)

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

// --------------------------------------------------------------- M4/M5: reflection (§18)

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

export interface BrainAdapter {
  /** Stable provider name used as the key of the durable brain-session mapping. */
  readonly provider: string;
  describe(): BrainDescription;
  handleUserTurn(input: UserTurnInput): Promise<BrainTurnStream>;
  evaluateProactiveCandidate(input: ProactiveContext): Promise<ProactiveDecision>;
  interpretFeedback(input: FeedbackInput): Promise<FeedbackDecision>;
  extractMemories(input: MemoryExtractionInput): Promise<MemoryCandidate[]>;
  reflect(input: ReflectionInput): Promise<ReflectionResult>;
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
