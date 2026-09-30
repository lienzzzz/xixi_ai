import { ContractError } from './errors.ts';
import { ENVELOPE_SCHEMA, getEventType } from './events.ts';
import { newCorrelationId, newEventId, toOffsetIso } from './ids.ts';
import { assertSchema, validateSchema, type JsonValue } from './schema-validator.ts';

export const EVENT_SCHEMA = 'xixi.event.v1';
/**
 * Contract version of the (envelope + payload) pair, one number for the whole
 * released set: bumping any payload shape bumps it and adds a new schema file
 * rather than editing a released one. Per-event payload versions are declared
 * in the registry and must equal this value for the build that emits them.
 */
export const SCHEMA_VERSION = 1;

/** §19.1 actors. `xixi` and `system` cover assistant-side and service-side events. */
export const ACTORS = Object.freeze([
  'father',
  'admin',
  'family_member',
  'unknown_person',
  'tv_media',
  'xixi',
  'system',
] as const);

export type Actor = (typeof ACTORS)[number];

export interface EventEnvelope<Payload extends JsonValue = JsonValue> {
  readonly schema: typeof EVENT_SCHEMA;
  readonly schema_version: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly source: string;
  readonly room: string | null;
  readonly actor: Actor;
  readonly confidence: number;
  readonly correlation_id: string;
  readonly payload: Payload;
}

export interface BuildEventInput<Payload extends JsonValue = JsonValue> {
  readonly event_type: string;
  readonly source: string;
  readonly actor: Actor;
  readonly confidence: number;
  readonly payload: Payload;
  readonly room?: string | null;
  readonly timestamp?: string;
  readonly correlation_id?: string;
  readonly event_id?: string;
  readonly schema_version?: number;
}

/**
 * Build a validated envelope. Ids and the timestamp are filled when omitted, so
 * every producer gets the same identity and time semantics.
 *
 * Throws `ContractError` (`UNSUPPORTED_EVENT_TYPE`, `UNSUPPORTED_SCHEMA_VERSION`,
 * `INVALID_EVENT`, `INVALID_PAYLOAD`) instead of returning an unvalidated object.
 */
export function buildEvent<Payload extends JsonValue>(input: BuildEventInput<Payload>): EventEnvelope<Payload> {
  const definition = getEventType(input.event_type);
  const schemaVersion = input.schema_version ?? SCHEMA_VERSION;
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new ContractError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `this build implements ${EVENT_SCHEMA} version ${SCHEMA_VERSION}, producer asked for ${schemaVersion}`,
      { path: '/schema_version' },
    );
  }

  const envelope: EventEnvelope<Payload> = {
    schema: EVENT_SCHEMA,
    schema_version: schemaVersion,
    event_id: input.event_id ?? newEventId(),
    event_type: definition.type,
    timestamp: input.timestamp ?? toOffsetIso(),
    source: input.source,
    room: input.room ?? null,
    actor: input.actor,
    confidence: input.confidence,
    correlation_id: input.correlation_id ?? newCorrelationId(),
    payload: input.payload,
  };

  assertSchema(ENVELOPE_SCHEMA, envelope, 'INVALID_EVENT', `event ${envelope.event_id} does not satisfy ${EVENT_SCHEMA}`);
  if (schemaVersion !== definition.payloadVersion) {
    throw new ContractError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `event type "${definition.type}" has payload version ${definition.payloadVersion}, envelope declared ${schemaVersion}`,
      { path: '/schema_version' },
    );
  }
  assertSchema(
    definition.payloadSchema,
    envelope.payload,
    'INVALID_PAYLOAD',
    `payload for "${definition.type}" does not satisfy its v${definition.payloadVersion} schema`,
  );
  return Object.freeze(envelope);
}

/**
 * Validate an already-serialized event (for example one read back from the
 * event log or received over the bus) and return it typed. Nothing is coerced.
 */
export function validateEvent(value: unknown): EventEnvelope {
  const result = validateSchema(ENVELOPE_SCHEMA, value);
  if (!result.ok) {
    throw new ContractError('INVALID_EVENT', 'value is not a xixi.event.v1 envelope', { problems: result.problems });
  }
  const envelope = value as EventEnvelope;
  const definition = getEventType(envelope.event_type);
  if (envelope.schema_version !== definition.payloadVersion) {
    throw new ContractError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `event type "${definition.type}" has payload version ${definition.payloadVersion}, envelope declared ${envelope.schema_version}`,
      { path: '/schema_version' },
    );
  }
  assertSchema(
    definition.payloadSchema,
    envelope.payload,
    'INVALID_PAYLOAD',
    `payload for "${definition.type}" does not satisfy its v${definition.payloadVersion} schema`,
  );
  return envelope;
}

/** Non-throwing convenience for boundaries that must not crash on foreign input. */
export function isEventEnvelope(value: unknown): boolean {
  try {
    validateEvent(value);
    return true;
  } catch {
    return false;
  }
}
