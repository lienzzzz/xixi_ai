/**
 * The personality property set from 《方案》§7.2 and its legal range.
 *
 * This is the *schema* of the self model, not the learning engine: M0 only
 * seeds a baseline and restores it. Adjustment policy (per-source deltas,
 * drift limits, rollback) is M3 work and deliberately not implemented here.
 */
export interface PersonalityProperty {
  readonly name: string;
  readonly group: 'interaction' | 'affect' | 'memory' | 'voice';
  readonly min: number;
  readonly max: number;
  readonly description: string;
}

export const PERSONALITY_PROPERTIES: readonly PersonalityProperty[] = Object.freeze([
  { name: 'proactivity', group: 'interaction', min: 0, max: 1, description: '主动找用户讲话的倾向' },
  { name: 'talkativeness', group: 'interaction', min: 0, max: 1, description: '一轮愿意说多少' },
  { name: 'verbosity', group: 'interaction', min: 0, max: 1, description: '内容长度' },
  { name: 'curiosity', group: 'interaction', min: 0, max: 1, description: '追问倾向' },
  { name: 'follow_up_probability', group: 'interaction', min: 0, max: 1, description: '追问概率' },
  { name: 'backchannel_frequency', group: 'interaction', min: 0, max: 1, description: '应和频率' },
  { name: 'silence_tolerance', group: 'interaction', min: 0, max: 1, description: '对沉默的容忍' },
  { name: 'warmth', group: 'affect', min: 0, max: 1, description: '温度' },
  { name: 'humor', group: 'affect', min: 0, max: 1, description: '幽默' },
  { name: 'playfulness', group: 'affect', min: 0, max: 1, description: '玩心' },
  { name: 'emotional_expressiveness', group: 'affect', min: 0, max: 1, description: '情绪表达强度' },
  { name: 'formality', group: 'affect', min: 0, max: 1, description: '正式程度' },
  { name: 'directness', group: 'affect', min: 0, max: 1, description: '直接程度' },
  { name: 'teasing', group: 'affect', min: 0, max: 1, description: '打趣' },
  { name: 'memory_recall_frequency', group: 'memory', min: 0, max: 1, description: '回忆频率' },
  { name: 'old_topic_resurface', group: 'memory', min: 0, max: 1, description: '旧话题重提' },
  { name: 'future_hook_followup', group: 'memory', min: 0, max: 1, description: '未完话题跟进' },
  { name: 'speech_rate', group: 'voice', min: 0, max: 1, description: '语速（0.5 = 常规）' },
  { name: 'energy', group: 'voice', min: 0, max: 1, description: '声音能量' },
  { name: 'volume', group: 'voice', min: 0, max: 1, description: '音量' },
  { name: 'pause_style', group: 'voice', min: 0, max: 1, description: '停顿风格' },
]);

const BY_NAME = new Map(PERSONALITY_PROPERTIES.map((property) => [property.name, property]));

export function personalityProperty(name: string): PersonalityProperty | undefined {
  return BY_NAME.get(name);
}

/** Clamp a value into the property's legal range; the caller decides whether to log the clamp. */
export function clampPersonality(name: string, value: number): number {
  const property = BY_NAME.get(name);
  if (property === undefined) return value;
  return Math.min(property.max, Math.max(property.min, value));
}
