/**
 * `@xixi/contracts` — the one schema package every Xixi service shares (§23.2,
 * §41.17). Envelope plus per-event payload schemas, versioned by file.
 */
export { ContractError, type ContractErrorCode } from './errors.ts';
export {
  ACTORS,
  buildEvent,
  EVENT_SCHEMA,
  isEventEnvelope,
  SCHEMA_VERSION,
  validateEvent,
  type Actor,
  type BuildEventInput,
  type EventEnvelope,
} from './envelope.ts';
export { ENVELOPE_SCHEMA, EVENT_TYPES, getEventType, isKnownEventType, type EventTypeDefinition } from './events.ts';
export { newCorrelationId, newEventId, newSessionId, toOffsetIso } from './ids.ts';
export {
  assertEnforceable,
  assertSchema,
  SUPPORTED_KEYWORDS,
  validateSchema,
  type JsonSchema,
  type JsonValue,
  type ValidationResult,
} from './schema-validator.ts';
