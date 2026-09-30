/** Injectable time so tests and replay are deterministic (§22.3). */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** A clock that advances only when the test says so. */
export function fixedClock(start: Date, stepMs = 1000): Clock {
  let current = start.getTime();
  return () => {
    const value = new Date(current);
    current += stepMs;
    return value;
  };
}
