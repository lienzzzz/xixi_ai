/**
 * `Disposable` and the composable bundle. Pack `03_AGENT_PLUGIN.md` §3: **every registration
 * returns a Disposable**.
 *
 * The repo already had one shape for this — `ToolRegistry.register` returns a bare `() => void`.
 * Deleting that would break every existing caller, so the plugin layer's disposable is a
 * *callable object*: `dispose()` and `()` do the same thing, and both are idempotent. That is
 * what lets the same value satisfy §3's `Disposable` and the pre-existing function contract
 * (`tests/unit/core/tool-registry.test.ts` still calls `dispose()` the old way).
 */

/**
 * What §3 requires of every registration.
 *
 * Named here rather than reusing the global `Disposable` on purpose: the global one (ES2024
 * explicit resource management) also demands `[Symbol.dispose]`, and requiring that would make the
 * pre-existing `ToolRegistry.register` return value *not* a `Disposable` — the opposite of
 * 「在现有 ToolRegistry 之上加，不推翻」. The method name is what the pack asks for.
 */
export interface Disposable {
  /** Release the registration. Idempotent: the second call is a no-op. */
  dispose(): void;
}

/** A registration that can also be released by calling it, the form callers already used. */
export type Registration = (() => void) & Disposable;

/**
 * Wrap a release callback so it is callable *and* disposable, and safe to call twice.
 *
 * Idempotence matters beyond politeness: the manager disposes on deactivate and again on
 * dispose, and a plugin may also release a capability itself — all three paths must be
 * harmless.
 */
export function toRegistration(release: () => void): Registration {
  let released = false;
  const invoke = (): void => {
    if (released) return;
    released = true;
    release();
  };
  return Object.assign(invoke, { dispose: invoke }) as Registration;
}

/** A disposable that owns a set of registrations and releases them in reverse order (LIFO). */
export class DisposableBundle implements Disposable {
  readonly #disposables: Disposable[] = [];
  #disposed = false;

  add<T extends Disposable>(disposable: T): T {
    if (this.#disposed) {
      // Adding to a released bundle would leak: release it at once instead of holding it.
      disposable.dispose();
      return disposable;
    }
    this.#disposables.push(disposable);
    return disposable;
  }

  get size(): number {
    return this.#disposables.length;
  }

  /** Any failure is returned rather than thrown, so one bad release cannot strand the rest. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    while (this.#disposables.length > 0) {
      const disposable = this.#disposables.pop();
      try {
        disposable?.dispose();
      } catch {
        // A plugin that throws while releasing is already recorded by the manager journal;
        // the remaining registrations still have to go.
      }
    }
  }

  /**
   * `DisposableStack`-style release, so a bundle works with `using` as well.
   *
   * It exists because `Disposable` is also a global name (ES2024 explicit resource management): a
   * consumer that writes `Disposable` without importing ours gets the global one, and a bundle that
   * could not satisfy it would look like a missing method rather than a naming coincidence.
   */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** A registration whose body only runs once, whatever calls it (`once: () => void`). */
export function onceDisposable(release: () => void): Disposable {
  return toRegistration(release);
}

/** Does this value look like a Disposable (rather than the bare function the old API returned)? */
export function isDisposable(value: unknown): value is Disposable {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && typeof (value as Disposable).dispose === 'function');
}
