/**
 * Shared helpers for scripts: repo paths, `.env` loading and evidence printing.
 * No dependency on any package beyond the domain layer and the runtime.
 *
 * V0.3 P0-A Step C: `REPO_ROOT` moved to `packages/runtime/src/repo.ts` (the voice runtime needs
 * it to spawn the Python service, and a package must not import from the scripts directory).
 * This file re-exports it, so every `import { REPO_ROOT } from './lib/harness.ts'` keeps working.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadXixiConfig, type XixiConfig } from '@xixi/domain';
import { REPO_ROOT } from '@xixi/runtime';

export { REPO_ROOT };
export const DSH_HOME = join(REPO_ROOT, '.dsh');
export const DSH_PROFILE = 'xixi';
export const DSH_BIN_JS_HINT = join(REPO_ROOT, '.dsh-bin-hint');

/**
 * Minimal `.env` reader. Deliberately not a dependency: the file holds one
 * secret and a couple of proxy switches, and values are never printed.
 */
export function readDotEnv(file = join(REPO_ROOT, '.env')): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (value.length > 0) values[key] = value;
  }
  return values;
}

/** Environment for a spawned harness: process env, then `.env` as a fallback. */
export function harnessEnv(): Record<string, string> {
  const fromFile = readDotEnv();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(fromFile)) env[key] = value;
  for (const key of ['MIMO_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NODE_USE_ENV_PROXY']) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) env[key] = value;
  }
  return env;
}

export function requireMimoApiKey(): string {
  const key = process.env.MIMO_API_KEY ?? readDotEnv().MIMO_API_KEY;
  if (key === undefined || key.length === 0) {
    throw new Error('MIMO_API_KEY is not set; copy .env.example to .env and fill it in');
  }
  return key;
}

/** Configuration file used by scripts: the private one when present, else the example. */
export function configPath(): string {
  const privatePath = join(REPO_ROOT, 'config', 'xixi.yaml');
  return existsSync(privatePath) ? privatePath : join(REPO_ROOT, 'config', 'xixi.example.yaml');
}

export function loadConfig(): XixiConfig {
  return loadXixiConfig(configPath());
}

/** The three venvs the voice/perception scripts use, in the documented fallback order. */
export type VenvName = 'voice-pipecat' | 'voice-livekit' | 'field-probe' | 'cv4';

/**
 * Where an interpreter for `venv` lives, most specific first.
 *
 * Windows layouts put it in `Scripts/python.exe`; POSIX ones in `bin/python3`. Both are
 * always emitted because the candidate list doubles as a diagnostic hint: an error message
 * that shows the paths actually tried is worth more than one that shows a single guess.
 */
export function pythonCandidates(venv: VenvName): string[] {
  const root = join(REPO_ROOT, '.venvs', venv);
  return [
    join(root, 'Scripts', 'python.exe'),
    join(root, 'bin', 'python3'),
    join(root, 'bin', 'python'),
  ];
}

/**
 * Resolve an interpreter: explicit argument, then environment override, then the venvs that
 * actually exist, then whatever `python` is on PATH.
 *
 * Returning the first *existing* candidate (rather than assuming one layout) is what lets the
 * same scripts run on Windows and on POSIX. Note this only checks existence, not that the venv
 * carries the right packages — a probe would cost a process spawn on every entry.
 */
export function resolvePython(options: {
  /** Explicit path, e.g. a `--python` flag. Wins over everything else. */
  readonly explicit?: string | null;
  /** Environment variable to consult before the candidate list (`XIXI_PYTHON` by default). */
  readonly envVar?: string;
  readonly venvs: readonly VenvName[];
}): string {
  const explicit = options.explicit;
  if (explicit !== undefined && explicit !== null && explicit.length > 0) return explicit;
  const envValue = process.env[options.envVar ?? 'XIXI_PYTHON'];
  if (envValue !== undefined && envValue.length > 0) return envValue;
  for (const venv of options.venvs) {
    for (const candidate of pythonCandidates(venv)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Every interpreter the voice tooling would try, for "找不到 Python" error messages.
 * Includes the environment override so the hint matches what was really consulted.
 */
export function pythonCandidateHint(venvs: readonly VenvName[]): string {
  const hints: string[] = [];
  for (const venv of venvs) {
    for (const candidate of pythonCandidates(venv)) hints.push(candidate);
  }
  hints.push('XIXI_PYTHON（本机环境变量）');
  hints.push(process.platform === 'win32' ? 'python' : 'python3');
  return hints.join(' → ');
}

export function printEvidence(title: string, payload: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
}
