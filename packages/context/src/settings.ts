/**
 * `context.memory` 那一段配置的读取（pack `config/xixi.v03.additions.example.yaml` §context）。
 *
 * 三段优先级写死在这里，别处不再决定：
 *   1. `xixi.context.memory.*`（V0.3 的新段，pack 的写法）；
 *   2. `xixi.memory.*` 里同名的键（老配置文件也有这几个旋钮，早于新段写下的配置照旧能调）；
 *   3. 出厂默认（与 `MemoryRetriever` 的常量一致）。
 *
 * **不用默认值掩盖一个写错的配置**：越界或类型不对不会静默取默认，而是抛 `RangeError` /
 * `TypeError` 说清是哪个键 —— 「她怎么突然什么都想起来了」如果来自一个被忽略的配置，那条线索
 * 在日志里必须存在。上限仍然被夹进 pack 的硬边界（3~8 条）。
 */

import { DEFAULT_MIN_CONFIDENCE, MAX_INJECTED, MIN_INJECTED } from './memory-retriever.ts';

export interface ContextMemorySettings {
  readonly enabled: boolean;
  readonly minConfidence: number;
  readonly minItems: number;
  readonly maxItems: number;
  readonly includeRelationship: boolean;
  readonly includeOpenThreads: boolean;
}

export const DEFAULT_CONTEXT_MEMORY_SETTINGS: ContextMemorySettings = Object.freeze({
  enabled: true,
  minConfidence: DEFAULT_MIN_CONFIDENCE,
  minItems: MIN_INJECTED,
  maxItems: 6,
  includeRelationship: true,
  includeOpenThreads: true,
});

/** 配置里允许写的键；不认识的键会被忽略（不是每个人都会跟着升级配置文件）。 */
const KNOWN_KEYS = Object.freeze([
  'enabled',
  'min_confidence',
  'min_items',
  'max_items',
  'include_relationship',
  'include_open_threads',
]);

function pick(context: Record<string, unknown> | undefined, legacy: Record<string, unknown> | undefined, key: string): unknown {
  if (context !== undefined && KNOWN_KEYS.includes(key) && context[key] !== undefined) return context[key];
  return legacy?.[key];
}

function boolAt(value: unknown, fallback: boolean, key: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`context.memory.${key} must be a boolean`);
  return value;
}

function numberAt(value: unknown, fallback: number, key: string, low: number, high: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`context.memory.${key} must be a number`);
  if (value < low || value > high) throw new RangeError(`context.memory.${key} must be within [${low}, ${high}], got ${value}`);
  return value;
}

/**
 * 读一段内存配置。`contextMemory` 是 `config.context.memory`（新段），
 * `legacyMemory` 是 `config.memory`（老段）。
 */
export function parseContextMemorySettings(
  contextMemory?: Record<string, unknown> | undefined,
  legacyMemory?: Record<string, unknown> | undefined,
): ContextMemorySettings {
  const defaults = DEFAULT_CONTEXT_MEMORY_SETTINGS;
  const enabled = boolAt(pick(contextMemory, legacyMemory, 'enabled'), defaults.enabled, 'enabled');
  const minConfidence = numberAt(pick(contextMemory, legacyMemory, 'min_confidence'), defaults.minConfidence, 'min_confidence', 0, 1);
  const maxItems = Math.round(numberAt(pick(contextMemory, legacyMemory, 'max_items'), defaults.maxItems, 'max_items', MIN_INJECTED, MAX_INJECTED));
  const minItems = Math.round(numberAt(pick(contextMemory, legacyMemory, 'min_items'), defaults.minItems, 'min_items', 0, maxItems));
  return {
    enabled,
    minConfidence,
    minItems,
    maxItems,
    includeRelationship: boolAt(pick(contextMemory, legacyMemory, 'include_relationship'), defaults.includeRelationship, 'include_relationship'),
    includeOpenThreads: boolAt(pick(contextMemory, legacyMemory, 'include_open_threads'), defaults.includeOpenThreads, 'include_open_threads'),
  };
}
