import { validateSchema, type JsonSchema } from '@xixi/contracts';

export type AmbientActor = 'father' | 'guest' | 'unknown';
export interface AmbientDevice { readonly id: string; readonly roomId: string; readonly kind: 'camera' | 'microphone' | 'speaker'; }
interface Base { readonly schemaVersion: 1; readonly eventId: string; readonly roomId: string; readonly at: string; }
export type AmbientEvent = Base & (
  | { readonly kind: 'presence'; readonly deviceId: string; readonly occupants: readonly AmbientActor[] }
  | { readonly kind: 'speech'; readonly deviceId: string; readonly utteranceId: string; readonly actor: AmbientActor; readonly address: 'direct' | 'continuation' | 'ambient' | 'media' | 'self'; readonly text: string }
  | { readonly kind: 'device'; readonly deviceId: string; readonly online: boolean }
  | { readonly kind: 'scene'; readonly busy?: boolean; readonly mediaPlaying?: boolean; readonly consent?: boolean; readonly quiet?: boolean }
  | { readonly kind: 'tick' }
  | { readonly kind: 'playback'; readonly deviceId: string; readonly outputId: string; readonly action: 'start' | 'complete' | 'interrupt' }
  | { readonly kind: 'approval'; readonly actor: AmbientActor; readonly approvalId: string; readonly action: 'approve' | 'deny' }
  | { readonly kind: 'acknowledge'; readonly actor: AmbientActor; readonly reminderId: string }
);
export interface AmbientOutput {
  audience?: 'private' | 'public';
  id: string; deviceId: string; roomId: string; text: string; segments: string[];
  status: 'queued' | 'playing' | 'completed' | 'interrupted';
  reminderId: string | null; actor: AmbientActor; at: string; reasonCode: string;
}
export interface AmbientScene { readonly busy: boolean; readonly mediaPlaying: boolean; readonly consent: boolean; readonly quiet: boolean; }
export interface AmbientResult { readonly reasonCode: string; readonly outputId: string | null; readonly score?: number; readonly approvalId?: string; }

const string: JsonSchema = { type: 'string', minLength: 1, maxLength: 200 };
const actor: JsonSchema = { type: 'string', enum: ['father', 'guest', 'unknown'] };
const fields: Record<string, { readonly required: string[]; readonly properties: Record<string, JsonSchema> }> = {
  presence: { required: ['deviceId', 'occupants'], properties: { deviceId: string, occupants: { type: 'array', maxItems: 10, items: actor } } },
  speech: { required: ['deviceId', 'utteranceId', 'actor', 'address', 'text'], properties: { deviceId: string, utteranceId: string, actor,
    address: { type: 'string', enum: ['direct', 'continuation', 'ambient', 'media', 'self'] }, text: { type: 'string', minLength: 1, maxLength: 4000 } } },
  device: { required: ['deviceId', 'online'], properties: { deviceId: string, online: { type: 'boolean' } } },
  scene: { required: [], properties: { busy: { type: 'boolean' }, mediaPlaying: { type: 'boolean' }, consent: { type: 'boolean' }, quiet: { type: 'boolean' } } },
  tick: { required: [], properties: {} },
  playback: { required: ['deviceId', 'outputId', 'action'], properties: { deviceId: string, outputId: string, action: { type: 'string', enum: ['start', 'complete', 'interrupt'] } } },
  approval: { required: ['actor', 'approvalId', 'action'], properties: { actor, approvalId: string, action: { type: 'string', enum: ['approve', 'deny'] } } },
  acknowledge: { required: ['actor', 'reminderId'], properties: { actor, reminderId: string } },
};

/** This validates filtered event data, not raw audio, identity or a wake-word algorithm. */
export function parseAmbientEvent(raw: unknown): AmbientEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('INVALID_AMBIENT_EVENT');
  const kind = (raw as Record<string, unknown>)['kind'];
  const entry = typeof kind === 'string' && Object.hasOwn(fields, kind) ? fields[kind] : undefined;
  if (entry === undefined) throw new Error('INVALID_AMBIENT_EVENT');
  const schema: JsonSchema = { type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'eventId', 'roomId', 'at', 'kind', ...entry.required],
    properties: { schemaVersion: { const: 1 }, eventId: string, roomId: string, at: string, kind: { const: kind as string }, ...entry.properties } };
  const result = validateSchema(schema, raw);
  if (!result.ok) throw new Error(`INVALID_AMBIENT_EVENT: ${result.problems.join('; ')}`);
  const event = raw as AmbientEvent;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(event.at) || !Number.isFinite(Date.parse(event.at))) throw new Error('INVALID_AMBIENT_EVENT: at');
  return event;
}
