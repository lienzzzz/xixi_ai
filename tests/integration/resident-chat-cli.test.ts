import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openXixiStore } from '@xixi/domain';
import { REPO_ROOT } from '@xixi/runtime';

test('real chat CLI creates durable approved reminder and restores quiet in another process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-resident-cli-'));
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, readFileSync(join(REPO_ROOT, 'config/xixi.example.yaml'), 'utf8').replace('ask: []', 'ask: [xixi_set_reminder_stub]'));
  const run = (input: string, extra: string[] = []) => spawnSync(process.execPath,
    ['scripts/chat.ts', '--fake', '--data-dir', dir, '--config', configPath, ...extra],
    { cwd: REPO_ROOT, encoding: 'utf8', input, timeout: 30000, env: { ...process.env, MIMO_API_KEY: '', XIXI_DATA_DIR: dir } });
  try {
    const first = run('提醒我喝水\n可以\n/quiet\n/exit\n', ['--private']);
    assert.equal(first.status, 0, first.stderr);
    let store = openXixiStore({ dataDir: dir });
    try {
      assert.equal(store.reminders().length, 1);
      assert.equal(store.toolApprovals()[0]?.status, 'executed');
      assert.equal(store.reminders()[0]?.sourceEventId, store.toolApprovals()[0]?.sourceEventId);
      assert.equal((store.readRuntimeCheckpoint('ambient.living')?.value['scene'] as Record<string, unknown>)['quiet'], true);
    } finally { store.close(); }
    const second = run('/alone\n你好\n/resume\n我喜欢喝茉莉花茶\n/exit\n');
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /DND_ACTIVE/);
    assert.match(second.stdout, /茉莉花茶/);
    store = openXixiStore({ dataDir: dir });
    try {
      assert.equal(store.reminders().length, 1);
      assert.ok(store.semanticMemories().some((m) => m.statement.includes('茉莉')));
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('default chat is public and reports no durable write without an explicit private declaration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-public-cli-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/chat.ts', '--fake', '--data-dir', dir],
      { cwd: REPO_ROOT, encoding: 'utf8', input: '提醒我喝水\n/exit\n', timeout: 30000, env: { ...process.env, XIXI_DATA_DIR: dir } });
    assert.equal(result.status, 0, result.stderr);
    const store = openXixiStore({ dataDir: dir });
    try { assert.equal(store.reminders().length, 0); assert.ok(store.readRuntimeCheckpoint('ambient.living')); }
    finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resident demo uses two actual CLI processes and verifies persistent session, approval and quiet', () => {
  const result = spawnSync(process.execPath, ['scripts/demo-resident.ts'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /终端软件验收通过/);
  const summary = JSON.parse(result.stdout.split('\n').find((line) => line.startsWith('{"schemaVersion":')) ?? '{}') as Record<string, unknown>;
  assert.equal(summary['approvalsExecuted'], 1);
  assert.equal(summary['durableReminders'], 1);
  assert.equal(summary['sessionRestored'], true);
  assert.equal(summary['quietRestored'], true);
  assert.equal(summary['providerVerified'], false);
});
