/**
 * The knobs the FSM takes from the effective personality (§7.2) **and** from the short-term mood
 * (第五轮 t4).
 *
 * `silence_tolerance` scales the follow-up window in `fsm.ts`. The value must
 * come from the persisted personality — that is the whole point of 「人格可调」 —
 * so this file holds only the *named* fallback used when a store has no value
 * (a profile created before the property was seeded).
 *
 * Why an explicit constant instead of a default inside the FSM: with the
 * fallback hidden in the state machine, forgetting to wire the personality was
 * indistinguishable from wiring it, because the seeded baseline and the hidden
 * default were both 0.7. Keeping it here means the engine has exactly one place
 * to read, and tests can assert "no personality → the named default, not a
 * silently injected one".
 *
 * 心情那部分（`moodToleranceScale`）**乘在**人格算出来的窗口上，不是加在上面：
 *   * 人格影响窗口的倍率是 `0.5..1.5`（`silenceTolerance` ∈ [0,1] → `0.5 + tolerance`）；
 *   * 心情最多只改 ±6%（`mood-engine.ts` 的 `MOOD_TONE_SPAN`）。
 * 所以「心情不好就不理人」在这条公式里不可能发生：即使心情到底，窗口仍有 94% 宽。
 */

export const DEFAULT_SILENCE_TOLERANCE = 0.7;

import { moodToneScale } from '@xixi/domain';

/**
 * 心情对**对话窗口**（`silence_tolerance`）的缩放系数：中性时正好是 1。
 *
 * 为什么是窗口而不是别的：窗口决定「她说完一句之后还愿意等多久」，是唯一既能被心情轻微影响、
 * 又**不可能**影响硬底线（静默时段 / 额度 / 隐私）的量。心情好 → 多等一会儿；心情低 → 少等一会儿，
 * 但两种情况下她都会等（`MOOD_TONE_SPAN` 只有 0.06）。
 *
 * 实现上它就是 domain 的 `moodToneScale` —— 这里再导出一次是为了让**人格层**有一个
 * 与 `DEFAULT_SILENCE_TOLERANCE` 并列的、名字里写明「这是窗口缩放」的入口，避免调用方
 * 在 `engine.ts` 里手写 `1 + bias * 0.06` 这种把系数复制一份的做法。
 */
export function moodToleranceScale(moodBiasValue: number): number {
  return moodToneScale(moodBiasValue);
}
