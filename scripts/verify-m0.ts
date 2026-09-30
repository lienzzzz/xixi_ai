/**
 * M0 acceptance (§34 M0):
 *
 *   输入文字 → DSH → MiMo → 结构化工具调用 → 回答
 *   restart  → 会话恢复
 *
 * The restart half is proven the only way that counts: **two separate OS
 * processes**. Phase `fresh` talks to the model, writes everything to SQLite and
 * exits. Phase `resume` is a brand-new process that opens the same database,
 * finds the conversation, and continues the same harness session — it must be
 * able to repeat what it said before, which no in-memory trick can fake.
 *
 * Costs two real API turns, so it is a `verify:` script, not part of `npm test`.
 *
 * Usage:
 *   node scripts/verify-m0.ts              # orchestrate both phases
 *   node scripts/verify-m0.ts --phase=fresh
 *   node scripts/verify-m0.ts --phase=resume
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { CliDshTransport } from '@xixi/brain-dsh';
import { DshBrainAdapter, collectTurn } from '@xixi/brain-adapter';
import { openXixiStore, type XixiStore } from '@xixi/domain';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, printEvidence } from './lib/harness.ts';

const DATA_DIR = process.env.XIXI_DATA_DIR ?? join(REPO_ROOT, 'data');
const EVIDENCE_PREFIX = 'EVIDENCE ';

interface PhaseEvidence {
  readonly phase: 'fresh' | 'resume';
  readonly sessionId: string;
  readonly brainProvider: string | null;
  readonly brainSessionId: string | null;
  readonly turnCount: number;
  readonly eventCount: number;
  readonly personality: Record<string, number>;
  readonly userText: string;
  readonly action: string;
  readonly toolName: string | null;
  readonly assistantText: string | null;
  readonly latencyMs: number;
  readonly recentTurns: readonly { readonly role: string; readonly text: string | null }[];
}

function openStore(): XixiStore {
  return openXixiStore({ dataDir: DATA_DIR });
}

function adapterFor(store: XixiStore, identityName: string) {
  const transport = new CliDshTransport({
    dshHome: DSH_HOME,
    profile: DSH_PROFILE,
    cwd: REPO_ROOT,
    env: harnessEnv(),
    timeoutMs: 240_000,
    onDiagnostic: (line) => process.stderr.write(`[dsh] ${line}\n`),
  });
  const adapter = new DshBrainAdapter({ transport, store });
  return { adapter, transport, identityName };
}

async function runPhase(phase: 'fresh' | 'resume'): Promise<void> {
  const config = loadConfig();
  const store = openStore();
  try {
    store.seedSelfProfile(config.personality.base);
    const session = store.latestSession() ?? store.createSession();
    const turns = store.recentTurns(session.sessionId, 8);
    const { adapter } = adapterFor(store, config.identity.name);

    const userText =
      phase === 'fresh'
        ? '调用 xixi_get_current_time 工具，然后只回复该工具返回的时间戳本身，不要添加任何其他字符。'
        : '只回复你上一条消息的完整内容本身，不要添加任何其他字符、代码块或标点。';

    store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: userText });

    const stream = await adapter.handleUserTurn({
      sessionId: session.sessionId,
      text: userText,
      timeoutMs: 240_000,
      context: {
        identityName: config.identity.name,
        personality: store.selfProfile(),
        timezone: config.identity.timezone,
        workingMemory: turns.map((turn) => ({ role: turn.role, text: turn.text, action: turn.action })),
      },
    });
    const { result } = await collectTurn(stream);

    store.recordTurn({
      sessionId: session.sessionId,
      role: 'assistant',
      action: result.action,
      text: result.text,
      toolName: result.toolName,
    });
    store.recordHealth('brain-dsh', 'ok', `M0 ${phase} turn completed in ${result.latencyMs} ms`);

    const refreshed = store.getSession(session.sessionId);
    const evidence: PhaseEvidence = {
      phase,
      sessionId: refreshed.sessionId,
      brainProvider: refreshed.brainProvider,
      brainSessionId: refreshed.brainSessionId,
      turnCount: refreshed.turnCount,
      eventCount: store.eventCount(),
      personality: store.selfProfile(),
      userText,
      action: result.action,
      toolName: result.toolName,
      assistantText: result.text,
      latencyMs: result.latencyMs,
      recentTurns: store.recentTurns(session.sessionId, 4).map((turn) => ({ role: turn.role, text: turn.text })),
    };
    console.log(`${EVIDENCE_PREFIX}${JSON.stringify(evidence)}`);
  } finally {
    store.close();
  }
}

function spawnPhase(phase: 'fresh' | 'resume'): Promise<PhaseEvidence> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'verify-m0.ts'), `--phase=${phase}`], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...harnessEnv() },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
    });
    child.stderr.on('data', (data: string) => {
      stderr += data;
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`phase ${phase} exited with ${code}\n${stderr.slice(-2000)}`));
        return;
      }
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(EVIDENCE_PREFIX));
      if (line === undefined) {
        reject(new Error(`phase ${phase} printed no evidence line\n${stdout.slice(-2000)}`));
        return;
      }
      resolve(JSON.parse(line.slice(EVIDENCE_PREFIX.length)) as PhaseEvidence);
    });
  });
}

function normalize(text: string | null): string {
  return (text ?? '').replace(/[\s`"'。，,.]/g, '');
}

async function main(): Promise<void> {
  const phaseArg = process.argv.find((argument) => argument.startsWith('--phase='));
  if (phaseArg !== undefined) {
    const phase = phaseArg.split('=')[1];
    if (phase !== 'fresh' && phase !== 'resume') throw new Error(`unknown phase ${phase}`);
    await runPhase(phase);
    return;
  }

  console.log('M0 验收：两个独立进程，验证「会话与人格在重启后恢复」');
  console.log(`数据目录：${DATA_DIR}\n`);

  const fresh = await spawnPhase('fresh');
  printEvidence('进程 1（fresh）：文字 → DSH → MiMo → 工具 → 回答', {
    sessionId: fresh.sessionId,
    brainSessionId: fresh.brainSessionId,
    toolName: fresh.toolName,
    action: fresh.action,
    assistantText: fresh.assistantText,
    latencyMs: fresh.latencyMs,
    personality: fresh.personality,
    eventCount: fresh.eventCount,
  });

  const resume = await spawnPhase('resume');
  printEvidence('进程 2（resume，全新进程）：重启后继续同一段会话', {
    sessionId: resume.sessionId,
    brainSessionId: resume.brainSessionId,
    action: resume.action,
    assistantText: resume.assistantText,
    latencyMs: resume.latencyMs,
    turnCount: resume.turnCount,
    eventCount: resume.eventCount,
    recentTurns: resume.recentTurns,
  });

  const failures: string[] = [];
  if (fresh.toolName !== 'xixi_get_current_time') {
    failures.push(`fresh 阶段没有发生工具调用（saw ${String(fresh.toolName)}）— 工具调用是 M0 验收的一部分`);
  }
  if (fresh.brainSessionId === null) failures.push('fresh 阶段没有记录 harness 会话 id，重启恢复将不可能');
  if (fresh.sessionId !== resume.sessionId) failures.push('两个进程拿到的不是同一个西西会话');
  if (resume.brainSessionId !== fresh.brainSessionId) {
    failures.push('恢复阶段没有沿用同一个 harness 会话（说明是新建会话而不是恢复）');
  }
  if (Object.keys(fresh.personality).length === 0) failures.push('人格基线没有落库');
  if (JSON.stringify(fresh.personality) !== JSON.stringify(resume.personality)) {
    failures.push('重启后人格与重启前不一致');
  }
  const expected = normalize(fresh.assistantText);
  const actual = normalize(resume.assistantText);
  if (expected.length === 0) failures.push('fresh 阶段没有拿到回答');
  else if (!actual.includes(expected)) {
    failures.push(`恢复阶段答不出前一个进程说过的话（期望包含 "${expected}"，实际 "${actual}"）`);
  }
  if (resume.turnCount < 4) failures.push(`轮次没有累积（turnCount=${resume.turnCount}）`);

  console.log('');
  if (failures.length > 0) {
    console.error('verify:m0 FAILED');
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log('verify:m0 OK');
  console.log(' - 文字 → DSH → MiMo → 结构化工具调用 → 回答：可用');
  console.log(' - 重启后沿用同一 harness 会话、同一段西西会话、同一份人格：可用');
}

await main();
