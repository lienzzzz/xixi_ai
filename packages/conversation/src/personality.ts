/**
 * The one knob the FSM takes from the effective personality (§7.2).
 *
 * `silence_tolerance` scales the follow-up window in `fsm.ts`. The value must
 * come from the persisted personality — that is the whole point of "人格可调" —
 * so this file holds only the *named* fallback used when a store has no value
 * (a profile created before the property was seeded).
 *
 * Why an explicit constant instead of a default inside the FSM: with the
 * fallback hidden in the state machine, forgetting to wire the personality was
 * indistinguishable from wiring it, because the seeded baseline and the hidden
 * default were both 0.7. Keeping it here means the engine has exactly one place
 * to read, and tests can assert "no personality → the named default, not a
 * silently injected one".
 */
export const DEFAULT_SILENCE_TOLERANCE = 0.7;
