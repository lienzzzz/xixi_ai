/**
 * Offline demo: prove restart recovery with two real OS processes, no model.
 *
 * `--phase=fresh` writes a conversation and exits; `--phase=resume` is a brand
 * new process that reopens the database and reports what it recovered. The live
 * equivalent (real DSH session, real MiMo turn) is `npm run verify:m0`.
 *
 * Usage: node scripts/demo-m0-restart.ts
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { openXixiStore } from '@xixi/domain';

import { REPO_ROOT, loadConfig, printEvidence } from './lib/harness.ts';

const DATA_DIR = join(REPO_ROOT, 'data', 'demo-restart');
const PREFIX = 'EVIDENCE ';

function phase(): 'fresh' | 'resume' {
  const argument = process.argv.find((candidate) => candidate.startsWith('--phase='));
  return argument?.endsWith('resume') === true ? 'resume' : 'fresh';
}

function runPhase(name: 'fresh' | 'resume'): void {
  const config = loadConfig();
  const store = openXixiStore({ dataDir: DATA_DIR });
  try {
    store.seedSelfProfile(config.personality.base);
    if (name === 'fresh') {
      const session = store.createSession();
      store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: '明天下午我去镇上办点事。' });
      store.recordTurn({ sessionId: session.sessionId, role: 'assistant', action: 'SPEAK', text: '好，路上小心。' });
      store.recordHealth('demo', 'ok', 'fresh phase finished');
    }
    const session = store.latestSession();
    const resumed = session === null ? null : store.resume(session.sessionId);
    console.log(
      `${PREFIX}${JSON.stringify({
        phase: name,
        pid: process.pid,
        session: resumed?.session ?? null,
        turns: resumed?.turns.map((turn) => `${turn.role}:${turn.text}`) ?? [],
        effectivePersonality: store.selfProfile(),
        eventCount: store.eventCount(),
      })}`,
    );
  } finally {
    store.close();
  }
}

function spawnPhase(name: 'fresh' | 'resume'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'demo-m0-restart.ts'), `--phase=${name}`], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
    });
    child.on('close', (code) => {
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(PREFIX));
      if (code !== 0 || line === undefined) {
        reject(new Error(`phase ${name} failed (exit ${code})`));
        return;
      }
      resolve(JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>);
    });
  });
}

if (process.argv.some((argument) => argument.startsWith('--phase='))) {
  runPhase(phase());
} else {
  console.log('离线重启演示：两个独立进程，共用同一个 SQLite');
  const fresh = await spawnPhase('fresh');
  const resume = await spawnPhase('resume');
  printEvidence('进程 1（fresh）', fresh);
  printEvidence('进程 2（resume，全新进程）', resume);
  const freshSession = (fresh.session as { sessionId?: string } | null)?.sessionId ?? null;
  const resumeSession = (resume.session as { sessionId?: string } | null)?.sessionId ?? null;
  const freshTurns = (fresh.turns as string[] | undefined) ?? [];
  const resumeTurns = (resume.turns as string[] | undefined) ?? [];
  const sameSession = freshSession !== null && freshSession === resumeSession;
  const recoveredTurns = freshTurns.length === resumeTurns.length && resumeTurns.length > 0;
  const recoveredPersonality =
    JSON.stringify(fresh.effectivePersonality) === JSON.stringify(resume.effectivePersonality) &&
    Object.keys((resume.effectivePersonality as Record<string, number>) ?? {}).length > 0;
  const failures = [
    sameSession ? null : '两个进程拿到的不是同一个会话',
    recoveredTurns ? null : '轮次没有从事件日志恢复',
    recoveredPersonality ? null : '人格没有恢复或与重启前不一致',
  ].filter((entry): entry is string => entry !== null);

  if (failures.length > 0) {
    console.error('\n离线重启演示失败：');
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log('\n结论：新进程恢复了同一段会话、同一份人格与完整轮次（事件日志是唯一来源）。');
}
