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

export function printEvidence(title: string, payload: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
}
