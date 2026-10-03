/**
 * Repository paths for runtime code (V0.3 P0-A, Step C).
 *
 * `runVad` spawns the Python service from `services/voice-edge`, so the runtime needs the repo root
 * as much as the scripts do. This used to live only in `scripts/lib/harness.ts`; the runtime cannot
 * import that (scripts are adapters — the dependency must not run backwards), so the value moved
 * here and `scripts/lib/harness.ts` re-exports it. **One definition**, both directions.
 *
 * Resolved from `import.meta.url`, not from `process.cwd()`, so it does not move when a script is
 * started from another directory.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `…/packages/runtime/src/repo.ts` → `…/` (the repository root). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
