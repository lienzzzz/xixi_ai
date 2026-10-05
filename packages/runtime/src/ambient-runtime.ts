import { createHash } from 'node:crypto';
import { BoundedQueue } from './bounded-queue.ts';
import type { ToolRegistry, TurnModelProvider, ToolCallRecord } from '@xixi/brain-adapter';
import { canonicalToolArguments, ToolPermission } from '@xixi/brain-adapter';
import { toOffsetIso } from '@xixi/contracts';
import { ConversationEngine, ProactiveEngine, TopicEngine, parseProactiveSettings, splitReplyIntoSegments,
  resolveReplyLimits, type ProactiveModelInput, type ProactiveModelDecision } from '@xixi/conversation';
import type { Clock, XixiConfig, XixiStore } from '@xixi/domain';
import { parseReminderSettings } from '@xixi/domain';
import type { WeatherClient } from '@xixi/model-adapters';
import { buildProactiveCandidates } from './proactive-runtime.ts';
import { buildToolChain, resolveToolApprovalSettings } from './tool-runtime.ts';
import { createTurnExtraction, type TurnExtraction } from './turn-extraction.ts';
import { DurableReminderSink, ReminderScheduler } from './reminder-runtime.ts';
import { ToolApprovalManager } from './tool-approval.ts';
import { parseAmbientEvent, type AmbientActor, type AmbientDevice, type AmbientEvent, type AmbientOutput,
  type AmbientResult, type AmbientScene } from './ambient-types.ts';

interface InputRecord { digest: string; status: 'processing' | 'done' | 'interrupted'; result: AmbientResult | null; }
interface State {
  schemaVersion: 1; roomId: string; at: string; sessions: Record<string, string>;
  inputs: Record<string, InputRecord>; outputs: AmbientOutput[];
  online: Record<string, boolean>; occupants: AmbientActor[]; presenceAt: string | null;
  scene: { busy: boolean; mediaPlaying: boolean; consent: boolean; quiet: boolean };
  lastActor: AmbientActor | null; followupUntil: number; lastOwnerTurnAt: string | null;
}
export interface AmbientRuntimeOptions {
  readonly maxPendingEvents?: number;
  readonly store: XixiStore; readonly config: XixiConfig; readonly roomId: string;
  readonly devices: readonly AmbientDevice[]; readonly clock: Clock; readonly consent: boolean;
  readonly modelFactory: (registry: ToolRegistry, actor: AmbientActor) => TurnModelProvider;
  readonly decide: (input: ProactiveModelInput, scene: AmbientScene) => ProactiveModelDecision | Promise<ProactiveModelDecision>;
  readonly compose?: (input: ProactiveModelInput) => Promise<string>;
  readonly offsetMinutes?: number;
  readonly weatherClient?: WeatherClient;
  /** Completion means the software endpoint actually accepted the output. */
  readonly deliverOutput?: (output: Readonly<AmbientOutput>) => Promise<void>;
  readonly deliveryClock?: Clock;
  readonly onToolCall?: (record: ToolCallRecord) => void;
  readonly onNotice?: (notice: { readonly code: string; readonly detail: string }) => void;
}
export interface AmbientSnapshot {
  readonly schemaVersion: 1; readonly revision: number; readonly roomId: string;
  readonly presence: 'present' | 'absent' | 'unknown'; readonly occupants: readonly AmbientActor[];
  readonly outputs: readonly AmbientOutput[]; readonly interruptedInputs: readonly string[];
  readonly sessions: Readonly<Record<string, string>>;
  readonly scene: AmbientScene;
}

/** One software-only endpoint host. The caller owns the database and clock lifetime. */
export class AmbientRuntime {
  readonly #options: AmbientRuntimeOptions;
  readonly #key: string;
  #state: State;
  #revision: number;
  #at: Date;
  readonly #queue: BoundedQueue;
  #closed = false;
  #failed = false;
  readonly #extraction: TurnExtraction;
  readonly #sink: DurableReminderSink;
  readonly #scheduler: ReminderScheduler;
  readonly #approval: ToolApprovalManager;
  readonly #engines = new Map<string, ConversationEngine>();
  readonly #topics: TopicEngine;

  static open(options: AmbientRuntimeOptions): AmbientRuntime { return new AmbientRuntime(options); }

  private constructor(options: AmbientRuntimeOptions) {
    this.#options = options;
    this.#queue = new BoundedQueue(options.maxPendingEvents);
    if (!options.roomId.trim() || options.devices.length === 0 || new Set(options.devices.map((d) => d.id)).size !== options.devices.length ||
      options.devices.some((d) => !d.id.trim() || d.roomId !== options.roomId || !['camera', 'microphone', 'speaker'].includes(d.kind))) throw new Error('INVALID_AMBIENT_DEVICES');
    this.#at = options.clock();
    this.#key = `ambient.${options.roomId}`;
    const row = options.store.readRuntimeCheckpoint(this.#key);
    this.#revision = row?.revision ?? 0;
    this.#state = row === null ? {
      schemaVersion: 1, roomId: options.roomId, at: this.#at.toISOString(), sessions: {}, inputs: {}, outputs: [],
      online: Object.fromEntries(options.devices.map((d) => [d.id, true])), occupants: [], presenceAt: null,
      scene: { busy: false, mediaPlaying: false, consent: options.consent, quiet: false }, lastActor: null, followupUntil: 0, lastOwnerTurnAt: null,
    } : this.#restore(row.value);
    if (Date.parse(this.#state.at) > this.#at.getTime()) throw new Error('TIME_REVERSED');
    // Live evidence and response windows never survive a process restart.
    this.#state.presenceAt = null;
    this.#state.occupants = [];
    this.#state.lastActor = null;
    this.#state.followupUntil = 0;
    this.#state.scene = { busy: false, mediaPlaying: false, consent: options.consent && this.#state.scene.consent, quiet: this.#state.scene.quiet };
    for (const input of Object.values(this.#state.inputs)) if (input.status === 'processing') input.status = 'interrupted';
    for (const output of this.#state.outputs) if (output.status === 'queued' || output.status === 'playing') { output.status = 'interrupted'; output.reasonCode = 'RESTART_INTERRUPTED'; }
    this.#extraction = createTurnExtraction({ store: options.store, config: options.config });
    this.#sink = new DurableReminderSink({ store: options.store, timezone: options.config.identity.timezone,
      settings: parseReminderSettings(options.config.reminders), now: () => this.#at });
    this.#scheduler = new ReminderScheduler({ store: options.store, now: () => this.#at });
    this.#approval = new ToolApprovalManager({ store: options.store, settings: resolveToolApprovalSettings(options.config), now: () => this.#at });
    this.#topics = new TopicEngine({ store: options.store, clock: () => this.#at });
    this.#ensureSession('father.private');
    this.#save(row === null ? 'runtime.created' : 'runtime.recovered');
  }

  #restore(value: Record<string, unknown>): State {
    // The versioned database is trusted storage, but incompatible/corrupt state must fail closed.
    const state = value as unknown as State;
    if (state.schemaVersion !== 1 || state.roomId !== this.#options.roomId || !Number.isFinite(Date.parse(state.at)) ||
      !state.sessions || !state.inputs || !Array.isArray(state.outputs) || !state.online || !state.scene || !Array.isArray(state.occupants)) throw new Error('INVALID_AMBIENT_CHECKPOINT');
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!['father.private', 'father.public', 'guest', 'unknown'].includes(key) || typeof sessionId !== 'string') throw new Error('INVALID_AMBIENT_CHECKPOINT');
      this.#options.store.getSession(sessionId);
    }
    for (const input of Object.values(state.inputs)) if (!['processing', 'done', 'interrupted'].includes(input.status) || typeof input.digest !== 'string') throw new Error('INVALID_AMBIENT_CHECKPOINT');
    for (const output of state.outputs) if (!['queued', 'playing', 'completed', 'interrupted'].includes(output.status) || typeof output.id !== 'string' || !Array.isArray(output.segments)) throw new Error('INVALID_AMBIENT_CHECKPOINT');
    return structuredClone(state);
  }

  #save(reasonCode: string): void {
    const value = JSON.parse(JSON.stringify(this.#state)) as Parameters<XixiStore['writeRuntimeCheckpoint']>[1];
    try { this.#revision = this.#options.store.writeRuntimeCheckpoint(this.#key, value, this.#revision, reasonCode).revision; }
    catch (error) { this.#failed = true; throw error; }
  }

  #assertOwnership(): void {
    if (this.#options.store.readRuntimeCheckpoint(this.#key)?.revision !== this.#revision) {
      this.#failed = true;
      throw new Error('CHECKPOINT_CONFLICT');
    }
  }

  #ensureSession(key: string): string {
    const existing = this.#state.sessions[key];
    if (existing !== undefined) return existing;
    const id = this.#options.store.createSession().sessionId;
    this.#state.sessions[key] = id;
    return id;
  }

  #presence(): 'present' | 'absent' | 'unknown' {
    const cameras = this.#options.devices.filter((d) => d.kind === 'camera');
    const evidenceTime = this.#options.deliveryClock?.() ?? this.#at;
    if (this.#state.presenceAt === null || !cameras.some((d) => this.#state.online[d.id]) || evidenceTime.getTime() - Date.parse(this.#state.presenceAt) >= 60_000) return 'unknown';
    return this.#state.occupants.length > 0 ? 'present' : 'absent';
  }

  #private(): boolean { return this.#presence() === 'present' && this.#state.occupants.length === 1 && this.#state.occupants[0] === 'father'; }

  snapshot(): AmbientSnapshot {
    return structuredClone({ schemaVersion: 1, revision: this.#revision, roomId: this.#state.roomId,
      presence: this.#presence(), occupants: this.#presence() === 'unknown' ? [] : this.#state.occupants,
      outputs: this.#state.outputs, sessions: this.#state.sessions, scene: this.#state.scene,
      interruptedInputs: Object.entries(this.#state.inputs).filter(([, v]) => v.status === 'interrupted').map(([k]) => k) });
  }

  dispatch(raw: AmbientEvent): Promise<AmbientResult> {
    if (this.#closed || this.#failed) return Promise.reject(new Error('AMBIENT_RUNTIME_CLOSED'));
    // Clone before enqueue: callers cannot change identity or arguments during an async turn.
    return this.#queue.enqueuePrepared(() => {
      const event = structuredClone(parseAmbientEvent(raw));
      return () => this.#dispatch(event);
    });
  }

  async #dispatch(raw: AmbientEvent): Promise<AmbientResult> {
    if (this.#failed) throw new Error('AMBIENT_RUNTIME_CLOSED');
    const event = parseAmbientEvent(raw);
    if (event.roomId !== this.#options.roomId) throw new Error('UNKNOWN_ROOM');
    if ('deviceId' in event) {
      const device = this.#options.devices.find((d) => d.id === event.deviceId);
      if (device === undefined) throw new Error('UNKNOWN_DEVICE');
      const kind = event.kind === 'presence' ? 'camera' : event.kind === 'speech' ? 'microphone' : event.kind === 'playback' ? 'speaker' : device.kind;
      if (device.kind !== kind) throw new Error('DEVICE_KIND');
      if (event.kind !== 'device' && !this.#state.online[device.id]) throw new Error('DEVICE_OFFLINE');
    }
    if (event.kind === 'approval' || event.kind === 'acknowledge') {
      if (event.actor !== 'father') throw new Error('OWNER_REQUIRED');
    }
    const time = Date.parse(event.at);
    if (time < Date.parse(this.#state.at)) throw new Error('TIME_REVERSED');
    if (this.#options.clock().getTime() !== time) throw new Error('CLOCK_MISMATCH');
    const key = event.kind === 'speech' ? `utterance.${event.utteranceId}` : `event.${event.eventId}`;
    // Repeated mic observations can have a different device/time, but must name the same utterance.
    const data = event.kind === 'speech' ? { roomId: event.roomId, actor: event.actor, address: event.address, text: event.text } : event;
    const digest = createHash('sha256').update(canonicalToolArguments({ ...data })).digest('hex');
    const prior = this.#state.inputs[key];
    if (prior !== undefined) {
      if (prior.digest !== digest) throw new Error('INPUT_ID_CONFLICT');
      return { reasonCode: prior.status === 'done' ? 'DUPLICATE_INPUT' : 'INTERRUPTED_INPUT', outputId: null };
    }
    this.#at = new Date(time);
    this.#state.at = event.at;
    this.#state.inputs[key] = { digest, status: 'processing', result: null };
    // CAS succeeds before any model/tool/output side effect.
    this.#save('input.claimed');
    try {
      let result = await this.#handle(event);
      if (result.outputId !== null && this.#options.deliverOutput !== undefined) {
        await this.#deliver(result.outputId);
        const output = this.#state.outputs.find((o) => o.id === result.outputId);
        if (output?.status === 'interrupted') result = { ...result, reasonCode: output.reasonCode, outputId: null };
      }
      this.#state.inputs[key] = { digest, status: 'done', result };
      this.#save('input.completed');
      return result;
    } catch (error) {
      this.#state.inputs[key] = { digest, status: 'interrupted', result: null };
      if (!this.#failed) this.#save('input.interrupted');
      throw error;
    }
  }

  #engine(actor: AmbientActor): { engine: ConversationEngine; sessionId: string } {
    const privateAudience = actor === 'father' && this.#private();
    const key = actor === 'father' ? `father.${privateAudience ? 'private' : 'public'}` : actor;
    const sessionId = this.#ensureSession(key);
    let engine = this.#engines.get(key);
    if (engine === undefined) {
      let turnTools: Array<{ record: ToolCallRecord; write: boolean }> = [];
      const policy = new ToolPermission({ role: privateAudience ? 'owner' : 'guest', askTools: resolveToolApprovalSettings(this.#options.config).ask });
      const registry = buildToolChain(this.#options.config, { now: () => this.#options.deliveryClock?.() ?? this.#at,
        onToolCall: (record) => {
          turnTools.push({ record, write: registry.all().some((t) => t.name === record.name && t.risk === 'write') });
          this.#options.onToolCall?.(record);
        },
        ...(this.#options.weatherClient === undefined ? {} : { weatherClient: this.#options.weatherClient }),
        role: privateAudience ? 'owner' : 'guest', reminderSink: this.#sink, approvalGate: this.#approval,
        permission: { check: (tool, request) => {
          this.#assertOwnership();
          if (tool.risk === 'write' && (!this.#private() || !this.#state.scene.consent || this.#state.scene.quiet)) return { verdict: 'deny', reason: 'PRIVATE_OWNER_REQUIRED' };
          return policy.check(tool, request);
        } } });
      if (privateAudience) this.#approval.useRegistry(registry);
      const provider = this.#options.modelFactory(registry, actor);
      const adapter: TurnModelProvider = { provider: provider.provider, describe: () => provider.describe(),
        handleUserTurn: (input) => { turnTools = []; return provider.handleUserTurn(input); } };
      engine = new ConversationEngine({ adapter, store: this.#options.store,
        config: this.#options.config, clock: () => this.#at, offsetMinutes: this.#options.offsetMinutes,
        replyGuard: () => {
          const failed = turnTools.filter((t) => t.write && (!t.record.ok || typeof t.record.result?.['error'] === 'string' || t.record.result?.['registered'] === false)).at(-1)?.record;
          if (failed === undefined) return null;
          return { reasonCode: 'TOOL_WRITE_NOT_COMPLETED', text: failed.error === 'APPROVAL_REQUIRED' ? '这件事还没有执行，需要你确认后才能做。'
            : failed.error?.includes('执行结果未知') ? '这件事的执行结果还不确定，请先核对，不能重复尝试。' : '这件事没有完成，请检查设置后再试。' };
        },
        audience: { mode: privateAudience ? 'private' : 'public', actor: actor === 'father' ? 'father' : 'unknown_person', note: '由模拟宿主提供身份与在场证据' },
        ...(privateAudience ? {} : { contextBuilder: false as const, mood: false as const }),
        ...(actor === 'father' ? { afterTurn: (...args: Parameters<TurnExtraction['afterTurn']>) => {
          this.#assertOwnership();
          return this.#extraction.afterTurn(...args);
        } } : {}),
      });
      this.#engines.set(key, engine);
    }
    return { engine, sessionId };
  }

  #interrupt(reasonCode: string): void {
    for (const output of this.#state.outputs) if (output.status === 'queued' || output.status === 'playing') { output.status = 'interrupted'; output.reasonCode = reasonCode; }
  }

  #output(text: string, actor: AmbientActor, reasonCode: string, reminderId: string | null = null): AmbientResult {
    const device = this.#options.devices.find((d) => d.kind === 'speaker' && this.#state.online[d.id]);
    if (device === undefined) return { reasonCode: 'SPEECH_UNAVAILABLE', outputId: null };
    const output: AmbientOutput = { id: `ambient-output-${this.#state.outputs.length + 1}`, roomId: this.#state.roomId, deviceId: device.id,
      text, segments: [...splitReplyIntoSegments(text, resolveReplyLimits(this.#options.config.reply)).segments], status: 'queued', reminderId, actor,
      at: this.#at.toISOString(), reasonCode, audience: actor === 'father' && this.#private() ? 'private' : 'public' };
    this.#state.outputs.push(output);
    this.#save('output.queued');
    return { reasonCode, outputId: output.id };
  }

  previewPrompt(actor: AmbientActor): ReturnType<ConversationEngine['buildPrompt']> {
    const { engine, sessionId } = this.#engine(actor);
    return engine.buildPrompt({ sessionId, text: '(预览)', at: this.#at });
  }

  #playbackAllowed(output: AmbientOutput): boolean {
    const privateOutput = output.audience === 'private' || (output.audience === undefined && output.actor === 'father');
    return this.#state.scene.consent && !this.#state.scene.quiet && this.#presence() === 'present' && (!privateOutput || this.#private());
  }

  async #deliver(outputId: string): Promise<void> {
    const output = this.#state.outputs.find((o) => o.id === outputId);
    if (output === undefined || output.status !== 'queued') return;
    const refresh = () => {
      const time = this.#options.deliveryClock?.();
      if (time !== undefined) {
        if (time.getTime() < this.#at.getTime()) throw new Error('TIME_REVERSED');
        this.#at = time; this.#state.at = time.toISOString();
      }
      this.#assertOwnership();
    };
    refresh();
    if (!this.#playbackAllowed(output)) { output.status = 'interrupted'; output.reasonCode = 'PLAYBACK_PRIVACY_BLOCKED'; this.#save('output.interrupted'); return; }
    output.status = 'playing'; this.#save('output.started');
    try {
      await this.#options.deliverOutput?.(structuredClone(output));
      refresh();
      output.status = 'completed';
      if (output.reminderId !== null) this.#scheduler.deliver(output.reminderId, this.#at);
      this.#state.lastActor = output.actor; this.#state.followupUntil = this.#at.getTime() + 30_000;
      this.#save('output.completed');
    } catch (error) {
      output.status = 'interrupted'; output.reasonCode = 'OUTPUT_FAILED';
      if (!this.#failed) this.#save('output.interrupted');
      throw error;
    }
  }

  async #handle(event: AmbientEvent): Promise<AmbientResult> {
    const result = (reasonCode: string): AmbientResult => ({ reasonCode, outputId: null });
    switch (event.kind) {
      case 'presence':
        this.#state.occupants = [...event.occupants]; this.#state.presenceAt = event.at;
        this.#options.store.recordPresenceChanged({ present: event.occupants.length > 0, room: event.roomId, source: `ambient.${event.deviceId}`,
          actor: event.occupants.length === 1 && event.occupants[0] === 'father' ? 'father' : 'unknown_person', timestamp: toOffsetIso(this.#at, this.#options.offsetMinutes) });
        if (!this.#private()) { this.#interrupt('AUDIENCE_CHANGED'); this.#state.lastActor = null; this.#state.followupUntil = 0; }
        return result('PRESENCE_UPDATED');
      case 'device':
        this.#state.online[event.deviceId] = event.online;
        if (!event.online) {
          const kind = this.#options.devices.find((d) => d.id === event.deviceId)?.kind;
          if (kind === 'camera') { this.#state.presenceAt = null; this.#state.occupants = []; this.#state.lastActor = null; this.#state.followupUntil = 0; this.#interrupt('PRESENCE_UNKNOWN'); }
          if (kind === 'speaker') this.#interrupt('DEVICE_OFFLINE');
        }
        return result('DEVICE_UPDATED');
      case 'scene':
        this.#state.scene = { ...this.#state.scene, ...('busy' in event ? { busy: event.busy } : {}),
          ...('mediaPlaying' in event ? { mediaPlaying: event.mediaPlaying } : {}), ...('consent' in event ? { consent: event.consent } : {}),
          ...('quiet' in event ? { quiet: event.quiet } : {}) };
        if (!this.#state.scene.consent || this.#state.scene.quiet) { this.#interrupt(this.#state.scene.quiet ? 'DND_ACTIVE' : 'PRIVACY_BLOCKED'); this.#state.lastActor = null; this.#state.followupUntil = 0; }
        return result('SCENE_UPDATED');
      case 'speech': {
        if (!this.#state.scene.consent) return result('PRIVACY_BLOCKED');
        if (this.#state.scene.quiet) return result('DND_ACTIVE');
        if (['media', 'self', 'ambient'].includes(event.address)) return result('NOT_ADDRESSED');
        if (event.address === 'continuation' && (this.#state.lastActor !== event.actor || this.#at.getTime() >= this.#state.followupUntil)) return result('NOT_ADDRESSED');
        this.#interrupt('BARGE_IN');
        const { engine, sessionId } = this.#engine(event.actor);
        this.#sink.beginTurn({ sessionId, actorId: event.actor });
        try {
          const turn = await engine.respond({ sessionId, text: event.text, addressed: true, at: this.#at,
            actor: event.actor === 'father' ? 'father' : 'unknown_person' }, { onNotice: this.#options.onNotice });
          this.#assertOwnership();
          await this.#extraction.drain();
          if (!turn.accepted) return result(turn.reason);
          this.#state.lastActor = event.actor;
          this.#state.followupUntil = this.#at.getTime() + engine.lingerMs;
          if (event.actor === 'father') this.#state.lastOwnerTurnAt = event.at;
          return turn.text === null ? result(turn.silenceReason ?? 'MODEL_SILENCE') : this.#output(turn.text, event.actor, 'REPLY_READY');
        } finally { this.#sink.endTurn(); }
      }
      case 'tick': return this.#tick();
      case 'playback': {
        const output = this.#state.outputs.find((o) => o.id === event.outputId);
        if (output === undefined || output.deviceId !== event.deviceId) throw new Error('UNKNOWN_OUTPUT');
        if (output.status === 'completed' || output.status === 'interrupted') return result('OUTPUT_ALREADY_FINAL');
        if (event.action !== 'interrupt' && !this.#playbackAllowed(output)) {
          output.status = 'interrupted'; output.reasonCode = 'PLAYBACK_PRIVACY_BLOCKED';
          return result('PLAYBACK_PRIVACY_BLOCKED');
        }
        if (event.action === 'interrupt') { output.status = 'interrupted'; output.reasonCode = 'PLAYBACK_INTERRUPTED'; }
        else if (event.action === 'start') output.status = 'playing';
        else {
          output.status = 'completed';
          if (output.reminderId !== null) this.#scheduler.deliver(output.reminderId, this.#at);
          this.#state.lastActor = output.actor; this.#state.followupUntil = this.#at.getTime() + 30_000;
        }
        return result('PLAYBACK_UPDATED');
      }
      case 'approval': {
        if (event.action === 'approve' && (!this.#private() || !this.#state.scene.consent || this.#state.scene.quiet)) return result('PRIVATE_OWNER_REQUIRED');
        const approval = this.#approval.get(event.approvalId);
        if (approval === null || approval.actorId !== 'father') throw new Error('UNKNOWN_APPROVAL');
        this.#engine('father');
        this.#sink.beginTurn({ sessionId: approval.sessionId, actorId: 'father', sourceEventId: approval.sourceEventId ?? undefined });
        try {
          const decision = event.action === 'approve' ? await this.#approval.approve({ approvalId: event.approvalId, actorId: 'father', now: this.#at })
            : this.#approval.deny({ approvalId: event.approvalId, actorId: 'father', now: this.#at });
          return { ...result(decision.reasonCode), approvalId: event.approvalId };
        } finally { this.#sink.endTurn(); }
      }
      case 'acknowledge': {
        if (!this.#private() || !this.#state.scene.consent || this.#state.scene.quiet) return result('PRIVATE_OWNER_REQUIRED');
        const reminder = this.#options.store.reminders().find((r) => r.id === event.reminderId);
        if (reminder?.owner !== 'father') throw new Error('UNKNOWN_REMINDER');
        this.#scheduler.acknowledge(event.reminderId, this.#at);
        return result('REMINDER_ACKNOWLEDGED');
      }
    }
  }

  async #tick(): Promise<AmbientResult> {
    this.#approval.expirePending(this.#at);
    this.#scheduler.tick(this.#at);
    if (this.#presence() !== 'present') {
      this.#interrupt('PRESENCE_UNKNOWN_OR_ABSENT');
      this.#state.lastActor = null; this.#state.followupUntil = 0;
      return { reasonCode: 'PRESENCE_UNKNOWN_OR_ABSENT', outputId: null };
    }
    const { engine, sessionId } = this.#engine('father');
    // Only owner utterances are reconciled by TopicEngine; guests have different event actors.
    if (this.#private()) this.#topics.reconcile(this.#at);
    const remindersDue = this.#scheduler.candidateInputs(this.#at).filter((r) =>
      this.#options.store.reminders().some((stored) => stored.id === r.reminderId && stored.owner === 'father') &&
      !this.#state.outputs.some((o) => o.reminderId === r.reminderId));
    const plans = buildProactiveCandidates({ now: this.#at, presence: { present: true, updatedAt: this.#state.presenceAt, ttlSeconds: 60 },
      lastUserTurnAt: this.#state.lastOwnerTurnAt === null ? null : new Date(this.#state.lastOwnerTurnAt),
      inConversation: this.#state.lastActor === 'father' && this.#at.getTime() < this.#state.followupUntil,
      openThreads: this.#private() ? this.#topics.followUps(this.#at) : [], remindersDue, random: () => 1 });
    let result: AmbientResult = { reasonCode: 'NO_CANDIDATE', outputId: null };
    for (const plan of plans) {
      let modelInput: ProactiveModelInput | null = null;
      const proactive = new ProactiveEngine({ store: this.#options.store, settings: parseProactiveSettings(this.#options.config.proactive),
        clock: () => this.#at, offsetMinutes: this.#options.offsetMinutes,
        decide: (input) => {
          const context = engine.buildProactiveDecisionContext({ fact: plan.fact, at: this.#at });
          modelInput = { ...input, ...(context === null ? {} : { context }) };
          return this.#options.decide(modelInput, { ...this.#state.scene });
        } });
      let output: AmbientResult | null = null;
      const outcome = await proactive.consider({ candidate: plan.candidate, at: this.#at, sessionId,
        conversationState: this.#state.scene.quiet ? 'SUSPENDED' : engine.state, inFlightTurn: this.#state.outputs.some((o) => o.status === 'queued' || o.status === 'playing'),
        privacyAllowed: this.#state.scene.consent && this.#private(), sceneAvailable: !this.#state.scene.mediaPlaying,
        speechAvailable: this.#options.devices.some((d) => d.kind === 'speaker' && this.#state.online[d.id]),
        deliver: async () => {
          const text = this.#options.compose !== undefined && modelInput !== null ? await this.#options.compose(modelInput)
            : plan.candidate.trigger === 'presence_arrived' ? '你回来啦，想聊聊吗？' : plan.line;
          if (!text.trim()) throw new Error('EMPTY_PROACTIVE_OUTPUT');
          const reminderId = plan.candidate.intent === 'reminder_due' ? plan.candidate.topicRef ?? null : null;
          output = this.#output(text, 'father', 'PASSED', reminderId);
          this.#options.store.recordTurn({ sessionId, role: 'assistant', action: 'SPEAK', text, source: 'ambient.proactive' });
        } });
      result = { reasonCode: outcome.reasonCode, outputId: (output as AmbientResult | null)?.outputId ?? null, score: outcome.score };
      if (!['ALREADY_DELIVERED', 'TRIGGER_DISABLED', 'BELOW_RECOMMENDATION', 'CONVERSATION_ACTIVE', 'NEW_SESSION_FLOOR'].includes(outcome.reasonCode)) break;
    }
    return result;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue.close();
    await this.#extraction.drain();
  }
}
