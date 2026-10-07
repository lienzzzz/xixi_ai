/**
 * Install the Xixi DSH profile into a project-local DSH home.
 *
 * Why project-local: the harness version, profile composition and session store
 * then live inside the repo, so the environment is reproducible and can be
 * wiped without touching the user's global `~/.dsh` (§M0「固定版本」).
 *
 * Steps (all idempotent):
 *   1. create `<repo>/.dsh`
 *   2. create profile `xixi` from the shipped `headless` template (no prompts)
 *   3. write the bundle list: dsh-base + dsh-headless + our tool plugin
 *   4. copy the repo-owned patch layer (MiMo route + default model)
 *   5. junction `profiles/xixi/node_modules/dsh-xixi-tool` → `plugins/xixi-tools`
 *
 * Usage: node scripts/install-dsh-profile.ts [--check]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDshBinJs } from '../apps/brain-dsh/src/transport.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_NAME = 'xixi';
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-xixi-tool'];
const TOOL_PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'xixi-tools');
const PATCH_SOURCE = join(REPO_ROOT, 'apps', 'brain-dsh', 'profile', 'cordis.patch.yml');

export const DSH_HOME = join(REPO_ROOT, '.dsh');
export const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME);

function log(message: string): void {
  console.log(message);
}

function dshBinJs(): string {
  // One implementation, in the place that owns spawning the harness: it knows both npm global
  // layouts (Windows `<prefix>/node_modules/…`, POSIX `<prefix>/lib/node_modules/…`). Keeping a
  // second copy here is how the two drift apart — this one only handled the Windows shape.
  return resolveDshBinJs();
}

function runDsh(args: string[]): string {
  return execFileSync(process.execPath, [dshBinJs(), ...args], {
    env: { ...process.env, DSH_HOME },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ensureProfile(): void {
  if (existsSync(join(PROFILE_DIR, 'package.json'))) {
    log(`profile "${PROFILE_NAME}" already exists at ${PROFILE_DIR}`);
    return;
  }
  mkdirSync(join(DSH_HOME, 'profiles'), { recursive: true });
  runDsh(['--profile', PROFILE_NAME, '--from-default-profile', 'headless', '--dump-config']);
  log(`created profile "${PROFILE_NAME}" at ${PROFILE_DIR}`);
}

function writeProfilePackageJson(): void {
  const file = join(PROFILE_DIR, 'package.json');
  const existing = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const next = {
    ...existing,
    private: true,
    dependencies: { 'dsh-xixi-tool': `link:${TOOL_PLUGIN_DIR.replace(/\\/g, '/')}` },
    dsh: { profile: { ...((existing.dsh as { profile?: Record<string, unknown> } | undefined)?.profile ?? {}), bundles: BUNDLES } },
  };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  log(`bundles: ${BUNDLES.join(', ')}`);
}

function writeProfileScaffolding(): void {
  for (const [name, body] of [
    ['cordis.yml', '[]\n'],
    ['pnpm-workspace.yaml', 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n'],
  ] as const) {
    const file = join(PROFILE_DIR, name);
    if (!existsSync(file)) writeFileSync(file, body, 'utf8');
  }
}

function writePatchLayer(): void {
  const target = join(PROFILE_DIR, 'cordis.patch.yml');
  writeFileSync(target, readFileSync(PATCH_SOURCE, 'utf8'), 'utf8');
  log(`patch layer written from ${PATCH_SOURCE}`);
}

function linkToolPlugin(): void {
  const link = join(PROFILE_DIR, 'node_modules', 'dsh-xixi-tool');
  mkdirSync(dirname(link), { recursive: true });
  if (existsSync(link)) {
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(TOOL_PLUGIN_DIR, link, 'junction');
  log(`linked tool plugin: ${link} -> ${TOOL_PLUGIN_DIR}`);
}

function verifyBoot(): void {
  const dump = runDsh(['--profile', PROFILE_NAME, '--dump-config']);
  for (const needle of ['dsh-llm-pi-ai', 'xixi-tools', 'openai-completions']) {
    if (!dump.includes(needle)) {
      throw new Error(`composed profile does not contain "${needle}" — install is not usable`);
    }
  }
  const modelLine = dump.includes('mimo-v2.6-flash');
  if (!modelLine) throw new Error('composed profile does not mention the MiMo model route');
  log('verified: profile composes llm-pi-ai with the MiMo route and the xixi tool plugin');
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    verifyBoot();
    return;
  }
  ensureProfile();
  writeProfilePackageJson();
  writeProfileScaffolding();
  writePatchLayer();
  linkToolPlugin();
  verifyBoot();
  log('');
  log('next: set MIMO_API_KEY (see .env.example) and run: npm run verify:provider');
}

main();
