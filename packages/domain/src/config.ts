import { readFileSync } from 'node:fs';

import { load as loadYaml } from 'js-yaml';

import { DomainError } from './errors.ts';
import { personalityProperty } from './personality.ts';

/**
 * Project configuration (§42). YAML is required by the plan's own config
 * format, and Node has no built-in YAML parser, so `js-yaml` is this repo's
 * one runtime dependency — the same parser DSH itself uses. See
 * docs/adr/0006-runtime-and-dependency-choices.md.
 */
export interface XixiConfig {
  readonly identity: {
    readonly name: string;
    readonly language: string;
    readonly timezone: string;
    /**
     * The household's usual place. Optional: it exists so "明天天气怎么样？" can be
     * answered without naming a city. When absent, the weather tool has to ask.
     */
    readonly place: string | null;
  };
  readonly models: {
    readonly llm: { readonly provider: string; readonly model: string; readonly thinking_realtime: boolean };
    readonly asr: { readonly provider: string; readonly model: string };
    readonly tts: { readonly provider: string; readonly model: string };
  };
  readonly personality: {
    readonly base: Record<string, number>;
  };
  readonly proactive: Record<string, unknown>;
  readonly memory: Record<string, unknown>;
  readonly privacy: Record<string, unknown>;
  readonly features: Record<string, unknown>;
}

function fail(problem: string, file: string): never {
  throw new DomainError('INVALID_CONFIG', `configuration is not usable: ${problem}`, file);
}

function section(document: Record<string, unknown>, key: string, file: string): Record<string, unknown> {
  const value = document[key];
  if (value === undefined) fail(`missing section "${key}"`, file);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`section "${key}" must be a mapping`, file);
  return value as Record<string, unknown>;
}

function stringField(parent: Record<string, unknown>, key: string, path: string, file: string): string {
  const value = parent[key];
  if (typeof value !== 'string' || value.length === 0) fail(`"${path}" must be a non-empty string`, file);
  return value;
}

function booleanField(parent: Record<string, unknown>, key: string, path: string, file: string): boolean {
  const value = parent[key];
  if (typeof value !== 'boolean') fail(`"${path}" must be a boolean`, file);
  return value;
}

function optionalStringField(parent: Record<string, unknown>, key: string, path: string, file: string): string | null {
  const value = parent[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(`"${path}" must be a string when present`, file);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Parse and validate a configuration file. Every problem names its path. */
export function parseXixiConfig(source: string, file = '<inline>'): XixiConfig {
  let document: unknown;
  try {
    document = loadYaml(source);
  } catch (cause) {
    fail(`YAML is malformed: ${cause instanceof Error ? cause.message : String(cause)}`, file);
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) fail('top level must be a mapping', file);
  const root = document as Record<string, unknown>;
  if (!('xixi' in root)) fail('top level must contain "xixi"', file);
  const xixi = section(root, 'xixi', file);

  const identity = section(xixi, 'identity', file);
  const models = section(xixi, 'models', file);
  const llm = section(models, 'llm', file);
  const asr = section(models, 'asr', file);
  const tts = section(models, 'tts', file);
  const personality = section(xixi, 'personality', file);
  const base = section(personality, 'base', file);

  for (const [property, value] of Object.entries(base)) {
    const definition = personalityProperty(property);
    if (definition === undefined) fail(`personality.base."${property}" is not a self-model property`, file);
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`personality.base."${property}" must be a number`, file);
    if (value < definition.min || value > definition.max) {
      fail(`personality.base."${property}" must be within [${definition.min}, ${definition.max}]`, file);
    }
  }

  return {
    identity: {
      name: stringField(identity, 'name', 'identity.name', file),
      language: stringField(identity, 'language', 'identity.language', file),
      timezone: stringField(identity, 'timezone', 'identity.timezone', file),
      place: optionalStringField(identity, 'place', 'identity.place', file),
    },
    models: {
      llm: {
        provider: stringField(llm, 'provider', 'models.llm.provider', file),
        model: stringField(llm, 'model', 'models.llm.model', file),
        thinking_realtime: booleanField(llm, 'thinking_realtime', 'models.llm.thinking_realtime', file),
      },
      asr: { provider: stringField(asr, 'provider', 'models.asr.provider', file), model: stringField(asr, 'model', 'models.asr.model', file) },
      tts: { provider: stringField(tts, 'provider', 'models.tts.provider', file), model: stringField(tts, 'model', 'models.tts.model', file) },
    },
    personality: { base: { ...base } as Record<string, number> },
    proactive: section(xixi, 'proactive', file),
    memory: section(xixi, 'memory', file),
    privacy: section(xixi, 'privacy', file),
    features: section(xixi, 'features', file),
  };
}

export function loadXixiConfig(file: string): XixiConfig {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new DomainError('INVALID_CONFIG', `cannot read configuration`, `${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return parseXixiConfig(source, file);
}
