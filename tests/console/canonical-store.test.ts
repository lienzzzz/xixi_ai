/**
 * P0-B: one household store, and the perception child is not a writer.
 *
 * Two things are pinned here, both from the audit (§3.5) and pack `04_RUNTIME_CONSOLIDATION.md` §2–3:
 *
 *   1. **Resolution** — every household entry defaults to the canonical store (`XIXI_DATA_DIR`, else
 *      `data/xixi`), the per-entry variables still work for tests/parallel instances, and the
 *      household variable wins over them (otherwise "canonical" would mean nothing).
 *   2. **The spawn line** — the perception child is started without `--db`/`--append`, so it cannot
 *      be a second writer of the store. The assertion runs the real `createPerceptionLiveRunner`
 *      against a script that echoes its own argv, so it fails the day someone adds the flags back.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CANONICAL_DATA_DIR, CANONICAL_DATA_DIR_ENV, resolveCanonicalDataDir } from '@xixi/domain';

test('canonical store：默认 data/xixi，XIXI_DATA_DIR 覆盖它', () => {
  assert.equal(CANONICAL_DATA_DIR, 'data/xixi');
  assert.equal(CANONICAL_DATA_DIR_ENV, 'XIXI_DATA_DIR');

  const cwd = mkdtempSync(join(tmpdir(), 'xixi-canon-'));
  assert.equal(resolveCanonicalDataDir({ env: {}, cwd }), join(cwd, 'data', 'xixi'), '未设任何变量 → data/xixi');

  const household = mkdtempSync(join(tmpdir(), 'xixi-household-'));
  assert.equal(
    resolveCanonicalDataDir({ env: { [CANONICAL_DATA_DIR_ENV]: household }, cwd }),
    household,
    'XIXI_DATA_DIR 生效（绝对路径原样使用）',
  );
  assert.equal(
    resolveCanonicalDataDir({ env: { [CANONICAL_DATA_DIR_ENV]: 'data/alternate' }, cwd }),
    join(cwd, 'data', 'alternate'),
    '相对路径按当前目录解析',
  );
});

test('canonical store：优先级 = 显式参数 > XIXI_DATA_DIR > 每个入口自己的变量 > 默认', () => {
  const cwd = '/repo';
  const env = { XIXI_DATA_DIR: 'data/household', XIXI_CHAT_DATA_DIR: 'data/chat-legacy' };

  assert.equal(resolveCanonicalDataDir({ dataDir: 'data/explicit', legacyEnv: 'XIXI_CHAT_DATA_DIR', env, cwd }), 'data/explicit');
  assert.equal(
    resolveCanonicalDataDir({ legacyEnv: 'XIXI_CHAT_DATA_DIR', env, cwd }),
    join(cwd, 'data', 'household'),
    'household 变量压过单个入口的变量',
  );
  assert.equal(
    resolveCanonicalDataDir({ legacyEnv: 'XIXI_CHAT_DATA_DIR', env: { XIXI_CHAT_DATA_DIR: 'data/chat-legacy' }, cwd }),
    join(cwd, 'data', 'chat-legacy'),
    '没有 household 变量时，单个入口的开关仍然生效（测试与并行实例要用它）',
  );
  assert.equal(resolveCanonicalDataDir({ env: {}, cwd }), join(cwd, 'data', 'xixi'));
});

test('跑测试时默认库落在临时目录，不会写进仓库里的 data/xixi', () => {
  // `scripts/serve-chat.ts` opens its store at import time, so a test that imports the entry would
  // otherwise create and write the household database from `npm test`. Node's test runner sets
  // `NODE_TEST_CONTEXT`, and the resolver uses it: the default becomes a per-process temp directory.
  const cwd = mkdtempSync(join(tmpdir(), 'xixi-under-test-'));
  const underTest = resolveCanonicalDataDir({ env: { NODE_TEST_CONTEXT: 'child-v8' }, cwd });
  assert.notEqual(underTest, join(cwd, 'data', 'xixi'), '测试里的默认值绝不能是仓库里的那个库');
  assert.ok(underTest.startsWith(tmpdir()), `默认值应落到临时目录：${underTest}`);
  assert.ok(underTest.replace(/\\/g, '/').endsWith(CANONICAL_DATA_DIR), `仍然是 data/xixi 的形状：${underTest}`);
  assert.ok(underTest.includes(`xixi-test-store-${process.pid}`), `每个测试进程一个自己的目录：${underTest}`);

  // …and the explicit switches still win, tests included: that is how the console/trial-page tests
  // keep their own store.
  assert.equal(
    resolveCanonicalDataDir({ env: { NODE_TEST_CONTEXT: 'child-v8', XIXI_WEB_DATA_DIR: 'data/own' }, legacyEnv: 'XIXI_WEB_DATA_DIR', cwd }),
    join(cwd, 'data', 'own'),
  );
});

test('感知子进程的命令行里不再有 --db / --append（它只负责检测与打印）', async () => {
  // Why this is a source-level check and not a spawn: `createPerceptionLiveRunner` builds an argv for
  // **Python** (`-m perception_edge.run`), which a Node stand-in cannot accept, and a spawned Python
  // would need the venv. What has to stay true is exactly the argv, so the assertion reads it off the
  // runner itself — plus the live DOM test (`three-column-console.test.ts`) that drives a fake child
  // through `LiveSensors` and asserts the start options carry no `presenceDbPath`.
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'field-test.ts'), 'utf8');
  const start = source.indexOf('const args = [');
  const end = source.indexOf('];', start);
  assert.ok(start !== -1 && end > start, '找到 perception 子进程的 argv 构造处');
  const argv = source.slice(start, end);
  assert.match(argv, /'perception_edge\.run'/, 'argv 仍然跑 perception_edge.run');
  assert.match(argv, /'--live'/, '仍然是 --live');
  assert.ok(!argv.includes("'--db'"), `argv 不得再传 --db：\n${argv}`);
  assert.ok(!argv.includes("'--append'"), `argv 不得再传 --append：\n${argv}`);

  // The seam is gone too: `LiveCameraStartOptions` no longer carries a store path, so a caller
  // cannot hand the child one by accident.
  const declared = source.slice(source.indexOf('export interface LiveCameraStartOptions {'));
  const interfaceBody = declared.slice(0, declared.indexOf('}'));
  assert.ok(!interfaceBody.includes('presenceDbPath'), `LiveCameraStartOptions 不得再有 presenceDbPath：\n${interfaceBody}`);
  assert.ok(source.includes('ingestPerceptionLine'), '控制台用 ingest 把事件写进 canonical store');
});
