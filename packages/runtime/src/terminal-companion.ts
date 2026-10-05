import { randomUUID } from 'node:crypto';
import { BoundedQueue } from './bounded-queue.ts';
import type { Clock, XixiConfig, XixiStore } from '@xixi/domain';
import type { AmbientEvent, AmbientOutput, AmbientResult } from './ambient-types.ts';
import { AmbientRuntime, type AmbientRuntimeOptions, type AmbientSnapshot } from './ambient-runtime.ts';
import type { EndpointProfile } from './endpoint-profile.ts';

export interface TerminalCompanionOptions {
  readonly maxPendingEvents?: number;
  readonly store: XixiStore; readonly config: XixiConfig; readonly profile: EndpointProfile; readonly clock: Clock;
  readonly modelFactory: AmbientRuntimeOptions['modelFactory']; readonly decide: AmbientRuntimeOptions['decide'];
  readonly write: (output: Readonly<AmbientOutput>) => Promise<void>;
  readonly weatherClient?: AmbientRuntimeOptions['weatherClient']; readonly offsetMinutes?: number;
  readonly onToolCall?: AmbientRuntimeOptions['onToolCall'];
  readonly onNotice?: AmbientRuntimeOptions['onNotice'];
}
export interface TerminalResult { readonly reasonCode: string; readonly message: string; readonly outputId?: string | null; }

/** Human declarations are software evidence, never camera or speaker recognition. */
export class TerminalCompanion {
  readonly #options: TerminalCompanionOptions;
  readonly #runtime: AmbientRuntime;
  #at: Date;
  #alone = false;
  readonly #queue: BoundedQueue;
  #closed = false;

  static open(options: TerminalCompanionOptions): TerminalCompanion { return new TerminalCompanion(options); }
  private constructor(options: TerminalCompanionOptions) {
    this.#options = options; this.#at = options.clock();
    this.#queue = new BoundedQueue(options.maxPendingEvents);
    this.#runtime = AmbientRuntime.open({ store: options.store, config: options.config, roomId: options.profile.roomId,
      devices: options.profile.devices, clock: () => this.#at, consent: true,
      ...(options.maxPendingEvents === undefined ? {} : { maxPendingEvents: options.maxPendingEvents }),
      modelFactory: options.modelFactory, decide: options.decide, deliverOutput: options.write, deliveryClock: options.clock,
      ...(options.weatherClient === undefined ? {} : { weatherClient: options.weatherClient }),
      ...(options.onToolCall === undefined ? {} : { onToolCall: options.onToolCall }),
      ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
      ...(options.offsetMinutes === undefined ? {} : { offsetMinutes: options.offsetMinutes }),
    });
  }
  snapshot(): AmbientSnapshot { return this.#runtime.snapshot(); }
  #enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('TERMINAL_CLOSED'));
    return this.#queue.enqueue(action);
  }
  #send(kind: AmbientEvent['kind'], fields: Record<string, unknown> = {}): Promise<AmbientResult> {
    this.#at = this.#options.clock();
    return this.#runtime.dispatch({ schemaVersion: 1, eventId: randomUUID(), roomId: this.#options.profile.roomId,
      at: this.#at.toISOString(), kind, ...fields } as AmbientEvent);
  }
  #device(kind: 'camera' | 'microphone' | 'speaker'): string { return this.#options.profile.devices.find((d) => d.kind === kind)!.id; }
  async #presence(alone: boolean): Promise<void> {
    await this.#send('presence', { deviceId: this.#device('camera'), occupants: alone ? ['father'] : ['father', 'guest'] });
  }
  #pending() { return this.#options.store.toolApprovals().filter((p) => p.actorId === 'father' && p.status === 'pending' && Date.parse(p.expiresAt) > this.#options.clock().getTime()); }
  tick(): Promise<TerminalResult> { return this.#enqueue(async () => ({ ...await this.#send('tick'), message: '' })); }
  handle(line: string): Promise<TerminalResult> {
    if (line.length > 4096) return Promise.reject(new Error('TERMINAL_INPUT_TOO_LARGE'));
    return this.#enqueue(() => this.#handle(line.trim()));
  }

  async #handle(text: string): Promise<TerminalResult> {
    const reply = (reasonCode: string, message: string): TerminalResult => ({ reasonCode, message });
    if (!text) return reply('EMPTY_INPUT', '');
    if (text === '/exit') return reply('EXIT', '');
    if (text === '/alone' || text === '/public') {
      this.#alone = text === '/alone'; await this.#presence(this.#alone);
      return reply('AUDIENCE_DECLARED', this.#alone ? '已按你的声明进入独处模式；有人在旁时用 /public。' : '已切换公开聊天，私人记忆和写工具关闭。');
    }
    if (text.startsWith('/guest ')) {
      this.#alone = false; await this.#presence(false);
      return { ...await this.#send('speech', { deviceId: this.#device('microphone'), actor: 'guest', address: 'direct', text: text.slice(7), utteranceId: randomUUID() }), message: '' };
    }
    // Only active human input refreshes the declaration; idle ticks do not fabricate evidence.
    await this.#presence(this.#alone);
    if (text === '/quiet' || text === '/resume' || text === '/privacy' || text === '/consent') {
      await this.#send('scene', text === '/quiet' || text === '/resume' ? { quiet: text === '/quiet' } : { consent: text === '/consent' });
      return reply('SCENE_UPDATED', text === '/quiet' ? '已进入安静模式，/resume 恢复。' : text === '/resume' ? '已恢复聊天。' : text === '/privacy' ? '已暂停收听和主动输出，/consent 恢复。' : '已恢复本次聊天同意。');
    }
    if (text === '/state') {
      const { outputs, ...state } = this.snapshot();
      return reply('STATE', JSON.stringify({ ...state, outputs: outputs.map((o) => ({ id: o.id, status: o.status, reasonCode: o.reasonCode })) }));
    }
    if (text === '/prompt') {
      if (!this.snapshot().scene.consent || this.snapshot().scene.quiet) return reply('PRIVATE_OWNER_REQUIRED', '当前隐私或静默设置不允许预览上下文。');
      const prompt = this.#runtime.previewPrompt('father');
      return reply('PROMPT', `--- system ---\n${prompt.system}\n--- user ---\n${prompt.user}`);
    }
    const privateAllowed = this.#alone && this.snapshot().scene.consent && !this.snapshot().scene.quiet;
    if (text === '/approvals') return reply('APPROVALS', privateAllowed ? this.#pending().map((p) => `${p.approvalId}：${p.toolName}（待确认）`).join('\n') || '没有待确认事项。' : '独处模式才能查看待确认事项。');
    if (text === '/reminders') return reply('REMINDERS', privateAllowed ? this.#options.store.reminders().filter((r) => r.owner === 'father').map((r) => `${r.id}：${r.what}，${r.dueAt}（${r.status}）`).join('\n') || '没有提醒。' : '独处模式才能查看私人提醒。');
    if (text === '/tick') return { ...await this.#send('tick'), message: '' };
    const explicit = /^\/(approve|deny|ack)\s+(\S+)$/.exec(text);
    if (explicit !== null) {
      const action = explicit[1]!; const id = explicit[2]!;
      const result = await this.#send(action === 'ack' ? 'acknowledge' : 'approval', action === 'ack'
        ? { actor: 'father', reminderId: id } : { actor: 'father', approvalId: id, action });
      return { ...result, message: `处理结果：${result.reasonCode}` };
    }
    if (['可以', '好', '不用', '不要'].includes(text)) {
      const pending = this.#pending();
      if (pending.length > 1) return reply('AMBIGUOUS_APPROVAL', '有多条待确认事项，请用 /approvals 查看并指明。');
      if (pending.length === 1) {
        const result = await this.#send('approval', { actor: 'father', approvalId: pending[0]!.approvalId, action: ['不用', '不要'].includes(text) ? 'deny' : 'approve' });
        return { ...result, message: `处理结果：${result.reasonCode}` };
      }
    }
    if (text.startsWith('/')) return reply('UNKNOWN_COMMAND', '未识别的命令，请输入 /help 查看用法。');
    return { ...await this.#send('speech', { deviceId: this.#device('microphone'), actor: 'father', address: 'direct', text, utteranceId: randomUUID() }), message: '' };
  }
  async close(): Promise<void> { this.#closed = true; await this.#queue.close(); await this.#runtime.close(); }
}
