import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ContractError } from './errors.ts';
import { assertEnforceable, type JsonSchema } from './schema-validator.ts';

const SCHEMA_ROOT = join(import.meta.dirname, '..', 'schemas');

/**
 * One event type, its payload version, and the schema that payload must
 * satisfy. `payloadVersion` is the version the envelope's `schema_version`
 * refers to for this type: changing a payload shape requires a new version and
 * a new file, never an in-place edit of a released one.
 */
export interface EventTypeDefinition {
  readonly type: string;
  readonly payloadVersion: number;
  readonly description: string;
  readonly payloadSchema: JsonSchema;
}

function loadSchema(relativePath: string): JsonSchema {
  const file = join(SCHEMA_ROOT, relativePath);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new ContractError('MALFORMED_SCHEMA', `cannot read schema ${relativePath}`, {
      problems: [cause instanceof Error ? cause.message : String(cause)],
    });
  }
  let parsed: JsonSchema;
  try {
    parsed = JSON.parse(raw) as JsonSchema;
  } catch (cause) {
    throw new ContractError('MALFORMED_SCHEMA', `schema ${relativePath} is not valid JSON`, {
      problems: [cause instanceof Error ? cause.message : String(cause)],
    });
  }
  assertEnforceable(parsed, `/${relativePath}`);
  return parsed;
}

function define(type: string, payloadVersion: number, description: string, file: string): EventTypeDefinition {
  return { type, payloadVersion, description, payloadSchema: loadSchema(file) };
}

/** Every event type M0 defines. New types join this list and the envelope enum together. */
export const EVENT_TYPES: readonly EventTypeDefinition[] = Object.freeze([
  define('presence.changed', 1, '有人/无人状态变化；M6 摄像头接入前由模拟器产生。', 'events/presence.changed.v1.json'),
  define('conversation.turn', 1, '一轮对话；action 允许 SPEAK/BACKCHANNEL/WAIT/SILENCE/TOOL。', 'events/conversation.turn.v1.json'),
  define(
    'conversation.decision',
    1,
    '一轮的接受判定：为什么这句话被接受/被拒绝（只存 reason_code、状态与分值，不存用户原话与模型推理）。',
    'events/conversation.decision.v1.json',
  ),
  define(
    'proactive.decision',
    1,
    '一次主动开口的判定记录：程序按硬门禁判定该不该说，只存 reason_code 与分值（ADR-0009）。',
    'events/proactive.decision.v1.json',
  ),
  define(
    'open_thread.changed',
    1,
    '一条「没聊完的事」的状态变化（candidate/offered/engaged/resolved/snoozed/exhausted）；pack Phase 3。',
    'events/open_thread.changed.v1.json',
  ),
  define('system.health', 1, '服务健康状态；用于故障降级与可观测性。', 'events/system.health.v1.json'),
]);

const BY_TYPE = new Map(EVENT_TYPES.map((definition) => [definition.type, definition]));

/** Look up a payload definition; throws `UNSUPPORTED_EVENT_TYPE` for unknown types. */
export function getEventType(type: string): EventTypeDefinition {
  const definition = BY_TYPE.get(type);
  if (definition === undefined) {
    throw new ContractError('UNSUPPORTED_EVENT_TYPE', `unknown event type "${type}"`, {
      path: '/event_type',
      problems: [`known types: ${[...BY_TYPE.keys()].join(', ')}`],
    });
  }
  return definition;
}

export function isKnownEventType(type: string): boolean {
  return BY_TYPE.has(type);
}

/** The envelope schema itself, exposed for drift tests and non-TS consumers. */
export const ENVELOPE_SCHEMA: JsonSchema = loadSchema('envelope.v1.json');
