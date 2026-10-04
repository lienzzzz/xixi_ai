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
  /**
   * Multi-segment reply limits (ADR-0010). Optional on purpose: a configuration
   * written before the section existed must keep loading, and the conversation
   * engine falls back to the hard defaults. Unusable values are tolerated here as
   * well — the limits are a tuning knob, and `resolveReplyLimits` clamps whatever
   * it is given, so a typo tightens or widens nothing beyond the ADR ceilings.
   */
  readonly reply?: Record<string, unknown>;
  /**
   * 未完话题（pack Phase 3）。可选：早于本段写下的配置必须照旧能加载，缺段就是出厂默认
   * （`packages/conversation/src/topic-engine.ts` 的 `DEFAULT_TOPIC_ENGINE_SETTINGS`）。
   */
  readonly openThreads?: Record<string, unknown>;
  /**
   * 三层自我画像与反馈学习（pack Phase 4 / 《方案》§7.4）。可选：缺段 = 出厂默认
   * （`packages/domain/src/self-model.ts` 的 `DEFAULT_SELF_MODEL_SETTINGS`）。
   */
  readonly selfModel?: Record<string, unknown>;
  /**
   * 有界的心情（第五轮 t4）。可选：缺段 = 出厂默认（`packages/domain/src/mood.ts` 的
   * `DEFAULT_MOOD_SETTINGS`）。**心情不参与硬底线**，所以这一段里没有任何能把主动开口
   * 关掉的开关 —— 它只能调「回落多快、一次吸收多少信号」。
   */
  readonly mood?: Record<string, unknown>;
  readonly memory: Record<string, unknown>;
  readonly privacy: Record<string, unknown>;
  readonly features: Record<string, unknown>;
  /**
   * 工具面（V0.3 P2-B，pack `03_AGENT_PLUGIN.md` §5）。可选：缺段 = **没有任何工具需要审批**
   * （`parseToolApprovalSettings` 的出厂默认）。今天这一段只有 `approval.ask` 与
   * `approval.ttl_seconds` 两个键——「没声明就不该 ASK」是从这里落到 `ToolPermission` 的。
   */
  readonly tools?: Record<string, unknown>;
  /**
   * 提醒的声明面（V0.3 P2-E，pack `03_AGENT_PLUGIN.md` §7）。可选：缺段 = 出厂默认
   * （`parseReminderSettings` 的 `DEFAULT_REMINDER_SETTINGS`）。今天这一段只有三个键：
   * `timezone`（缺省跟随 `identity.timezone`）、`default_time`（只说哪天没说几点时的默认时刻）、
   * `asap_minutes`（「尽快」的宽限）。**没有「提醒静默时段」**：那属于主动路径的硬底线（铁律 3）。
   */
  readonly reminders?: Record<string, unknown>;
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

/**
 * A section whose absence (or unusable shape) is not fatal: the caller has a
 * documented default. Used for tuning sections such as `reply` — the only
 * required sections are the ones a conversation cannot start without.
 */
function optionalSection(document: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = document[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
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
    reply: optionalSection(xixi, 'reply'),
    openThreads: optionalSection(xixi, 'open_threads'),
    selfModel: optionalSection(xixi, 'self_model'),
    mood: optionalSection(xixi, 'mood'),
    memory: section(xixi, 'memory', file),
    privacy: section(xixi, 'privacy', file),
    features: section(xixi, 'features', file),
    tools: optionalSection(xixi, 'tools'),
    reminders: optionalSection(xixi, 'reminders'),
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
