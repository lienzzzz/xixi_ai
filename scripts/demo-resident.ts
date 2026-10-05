/** Two real terminal processes using an offline provider and temporary durable store. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openXixiStore } from '@xixi/domain';
import { REPO_ROOT } from '@xixi/runtime';

const dir = mkdtempSync(join(tmpdir(), 'xixi-resident-demo-'));
const configPath = join(dir, 'demo.yaml');
try {
  writeFileSync(configPath, readFileSync(join(REPO_ROOT, 'config/xixi.example.yaml'), 'utf8').replace('ask: []', 'ask: [xixi_set_reminder_stub]'));
  const run = (input: string) => {
    const result = spawnSync(process.execPath, ['scripts/chat.ts', '--fake', '--private', '--data-dir', dir, '--config', configPath],
      { cwd: REPO_ROOT, input, encoding: 'utf8', timeout: 30000, env: { ...process.env, MIMO_API_KEY: '', XIXI_DATA_DIR: dir } });
    assert.equal(result.status, 0, result.stderr || String(result.error ?? 'terminal failed'));
    return result.stdout;
  };
  console.log('终端宿主演示：离线模型、临时数据库、无硬件与真实API。');
  const first = run('提醒我喝水\n可以\n/quiet\n/exit\n');
  assert.match(first, /approval_executed/);
  let store = openXixiStore({ dataDir: dir });
  let session: unknown;
  try {
    assert.equal(store.reminders().length, 1);
    assert.equal(store.toolApprovals()[0]?.status, 'executed');
    session = (store.readRuntimeCheckpoint('ambient.living')?.value['sessions'] as Record<string, unknown>)['father.private'];
  } finally { store.close(); }
  const second = run('你好\n/resume\n我喜欢喝茉莉花茶\n/exit\n');
  assert.match(second, /DND_ACTIVE/);
  store = openXixiStore({ dataDir: dir });
  try {
    assert.equal((store.readRuntimeCheckpoint('ambient.living')?.value['sessions'] as Record<string, unknown>)['father.private'], session);
    assert.equal(store.reminders().length, 1);
    assert.ok(store.semanticMemories().some((m) => m.statement.includes('茉莉')));
    console.log('① 提醒请求先等待确认，点头后写入真实提醒表。');
    console.log('② 新终端进程恢复同一会话与提醒；静默持续，显式恢复后继续记忆学习。');
    console.log(JSON.stringify({ schemaVersion: 1, approvalsExecuted: store.toolApprovals().filter((p) => p.status === 'executed').length,
      durableReminders: store.reminders().length, sessionRestored: true, quietRestored: true, hardwareVerified: false, providerVerified: false }));
    console.log('终端软件验收通过。');
  } finally { store.close(); }
} finally { rmSync(dir, { recursive: true, force: true }); }
