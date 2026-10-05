import { ContractError } from './errors.ts';

/**
 * A deliberately small JSON Schema (2020-12 subset) validator.
 *
 * Why not a full validator library: M0 must not take a dependency it cannot
 * justify, and the shared contract only needs a closed keyword set. The trade
 * this makes explicit is the opposite of a permissive validator: any schema
 * keyword this module does not implement is a hard failure
 * (`UNSUPPORTED_SCHEMA_KEYWORD`), so a contract can never be silently
 * under-enforced. `SUPPORTED_KEYWORDS` is the authoritative list and a unit
 * test fails if a committed schema uses anything outside it.
 */

export const SUPPORTED_KEYWORDS: readonly string[] = [
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };

export interface ValidationResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

interface Context {
  readonly problems: string[];
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      throw new ContractError('MALFORMED_SCHEMA', `unknown JSON Schema type "${expected}"`);
  }
}

function assertSupported(schema: JsonSchema, path: string): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) {
      throw new ContractError('UNSUPPORTED_SCHEMA_KEYWORD', `schema keyword "${key}" is not enforced by this validator`, {
        path: path || '/',
      });
    }
  }
}

function validateNode(schema: JsonSchema, value: unknown, path: string, ctx: Context): void {
  assertSupported(schema, path);
  const at = path || '/';

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    ctx.problems.push(`${at}: expected const ${JSON.stringify(schema.const)}, received ${JSON.stringify(value)}`);
    return;
  }

  if ('enum' in schema) {
    const allowed = schema.enum as JsonValue[];
    if (!allowed.some((candidate) => candidate === value)) {
      ctx.problems.push(`${at}: expected one of ${JSON.stringify(allowed)}, received ${JSON.stringify(value)}`);
      return;
    }
  }

  const declared = schema.type as string | string[] | undefined;
  if (declared !== undefined) {
    const expected = Array.isArray(declared) ? declared : [declared];
    if (!expected.some((candidate) => matchesType(value, candidate))) {
      ctx.problems.push(`${at}: expected type ${expected.join('|')}, received ${typeName(value)}`);
      return;
    }
  }

  if (typeof value === 'string') {
    const minLength = schema.minLength as number | undefined;
    const maxLength = schema.maxLength as number | undefined;
    if (minLength !== undefined && value.length < minLength) {
      ctx.problems.push(`${at}: string shorter than minLength ${minLength}`);
    }
    if (maxLength !== undefined && value.length > maxLength) {
      ctx.problems.push(`${at}: string longer than maxLength ${maxLength}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      ctx.problems.push(`${at}: ${JSON.stringify(value)} does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    const minimum = schema.minimum as number | undefined;
    const maximum = schema.maximum as number | undefined;
    if (minimum !== undefined && value < minimum) ctx.problems.push(`${at}: ${value} below minimum ${minimum}`);
    if (maximum !== undefined && value > maximum) ctx.problems.push(`${at}: ${value} above maximum ${maximum}`);
  }

  if (Array.isArray(value)) {
    const minItems = schema.minItems as number | undefined;
    const maxItems = schema.maxItems as number | undefined;
    if (minItems !== undefined && value.length < minItems) ctx.problems.push(`${at}: fewer than minItems ${minItems}`);
    if (maxItems !== undefined && value.length > maxItems) ctx.problems.push(`${at}: more than maxItems ${maxItems}`);
    const items = schema.items as JsonSchema | undefined;
    if (items !== undefined) {
      value.forEach((entry, index) => validateNode(items, entry, `${at}/${index}`, ctx));
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    const required = (schema.required as string[] | undefined) ?? [];
    const record = value as Record<string, unknown>;

    for (const key of required) {
      if (!(key in record)) ctx.problems.push(`${at}: missing required property "${key}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) ctx.problems.push(`${at}: unexpected property "${key}"`);
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in record) validateNode(subSchema, record[key], `${at}/${key}`, ctx);
    }
  }
}

/**
 * Walk a schema once at load time and fail if any keyword would not be
 * enforced. Contracts are checked when the process starts rather than when the
 * first event arrives, so a typo cannot silently weaken a running system.
 */
export function assertEnforceable(schema: JsonSchema, path = ''): void {
  assertSupported(schema, path);
  const at = path || '/';
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (properties !== undefined) {
    for (const [key, subSchema] of Object.entries(properties)) {
      assertEnforceable(subSchema, `${at}/${key}`);
    }
  }
  if (schema.items !== undefined) {
    assertEnforceable(schema.items as JsonSchema, `${at}/items`);
  }
}

/** Validate `value` against `schema` without throwing; collects every problem. */
export function validateSchema(schema: JsonSchema, value: unknown): ValidationResult {
  const ctx: Context = { problems: [] };
  validateNode(schema, value, '', ctx);
  return { ok: ctx.problems.length === 0, problems: ctx.problems };
}

/** Validate or throw a `ContractError` carrying every problem found. */
export function assertSchema(
  schema: JsonSchema,
  value: unknown,
  code: 'INVALID_EVENT' | 'INVALID_PAYLOAD' | 'MALFORMED_SCHEMA' = 'INVALID_EVENT',
  message = 'value does not satisfy schema',
): void {
  const result = validateSchema(schema, value);
  if (!result.ok) throw new ContractError(code, message, { problems: result.problems });
}
