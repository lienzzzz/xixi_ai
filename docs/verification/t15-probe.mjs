#!/usr/bin/env node
/**
 * P1 独立复验探针（V0.3 t15）。**一个进程只做一步** —— pack 的 Phase 1 验收里有一条是
 * 「进程重启后记忆仍在」，而交付用例用的是 `:memory:`，所以这里每一步都开同一个**文件库**，
 * 「重启」是真的新进程。
 *
 * 用法（在仓库根目录跑；`T15_NOW` 是模拟时钟，用来做跨天）：
 *   $env:T15_NOW = '2026-10-05T20:00:00+08:00'
 *   node docs/verification/t15-probe.mjs write   <storeDir> <userText>
 *   node docs/verification/t15-probe.mjs ask     <storeDir> <userText>
 *   node docs/verification/t15-probe.mjs correct <storeDir> <userText>
 *   node docs/verification/t15-probe.mjs dump    <storeDir>
 *   node docs/verification/t15-probe.mjs realdump <storeDir> [storeDir...]
 *
 * 输出是 JSON（stdout），报告里直接引用。`ask` 会同时给出：装配后的 `prompt.user`、
 * `memories` 段的 debug（`injected=/dropped_at_render=`）、检索诊断（含被丢的原因）与
 * 一段机器可读的 prompt 审计（UUID / 内部 id / 长数字 / 调试字段 / 「数据库」）。
 *
 * 真模型那一半不在这里：那是 `scripts/chat.ts` 的活（见报告 §3），本脚本只跑离线替身。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { ConversationEngine, TurnMemoryExtractor } from '@xixi/conversation';
import { MemoryStore, SelfModel, openXixiStore } from '@xixi/domain';

const CONFIG = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: { llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false }, asr: { provider: 'fake', model: 'fake-asr' }, tts: { provider: 'fake', model: 'fake-tts' } },
  personality: { base: {} },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MACHINE_ID = /\b(?:sem|mem|evt|thread|sess|corr)_[0-9a-z]/i;
const LONG_DIGITS = /\d{8,}/;

function out(value) {
  process.stdout.write(`\n${JSON.stringify(value, null, 2)}\n`);
}

/** 直读一个库：语义记忆（含状态）、情节记忆、memory.status 审计、用户轮次。不走任何自述。 */
function realDump(storeDir) {
  const db = new DatabaseSync(join(storeDir, 'xixi.sqlite'), { readOnly: true });
  const rows = db.prepare('SELECT statement, status, source_type, confidence FROM semantic_memory ORDER BY rowid').all();
  const episodic = db.prepare('SELECT summary, kind FROM episodic_memory ORDER BY rowid').all();
  const audit = db
    .prepare("SELECT payload_json FROM events WHERE event_type = 'system.health' AND payload_json LIKE '%memory.status%' ORDER BY sequence")
    .all()
    .map((row) => JSON.parse(row.payload_json).detail);
  const userTurns = db
    .prepare("SELECT payload_json FROM events WHERE event_type = 'conversation.turn' ORDER BY sequence")
    .all()
    .map((row) => JSON.parse(row.payload_json))
    .filter((payload) => payload.role === 'user')
    .map((payload) => payload.text);
  db.close();
  return { storeDir, userTurns, semantic: rows, episodic, memoryStatusAudit: audit };
}

const [cmd, storeDir, text] = process.argv.slice(2);

if (cmd === 'realdump') {
  out({ cmd, dumps: process.argv.slice(3).map((dir) => realDump(dir)) });
  process.exit(0);
}

const now = process.env.T15_NOW === undefined ? new Date() : new Date(process.env.T15_NOW);
const clock = () => new Date(now);
mkdirSync(storeDir, { recursive: true });
const dbPath = join(storeDir, 'xixi.sqlite');
const store = openXixiStore({ dbPath, clock });
store.seedSelfProfile({ talkativeness: 0.75, verbosity: 0.7, silence_tolerance: 0.7, proactivity: 0.85 });
const memory = new MemoryStore(store);
const session = store.latestSession() ?? store.createSession();
const extractor = new TurnMemoryExtractor({
  store,
  selfModel: new SelfModel(store),
  memory,
  // 手动调度：一步跑完再打印，避免「还在排队」的噪声。
  scheduler: () => {},
});
const engine = new ConversationEngine({
  adapter: new FakeBrainAdapter({ reply: () => ({ action: 'SPEAK', text: '（离线替身回复）' }) }),
  store,
  config: CONFIG,
  clock,
  offsetMinutes: 480,
  afterTurn: (job) => extractor.enqueue(job),
});

const semanticRows = () =>
  memory.semantic({ limit: 50 }).map((row) => ({
    memoryId: row.memoryId,
    property: row.property,
    statement: row.statement,
    status: row.status,
    supersededBy: row.supersededBy,
    sourceType: row.sourceType,
    confidence: row.confidence,
  }));
const activeRows = () => memory.activeSemantic({ limit: 50 }).map((row) => `${row.property}:${row.statement}`);
const audit = () =>
  store
    .readEvents({ type: 'system.health', limit: 100 })
    .filter((event) => event.payload?.service === 'memory.status')
    .map((event) => ({ at: event.timestamp, detail: event.payload?.detail }));

try {
  if (cmd === 'dump') {
    out({ cmd, at: now.toISOString(), dbPath, sessionId: session.sessionId, semantic: semanticRows(), active: activeRows(), audit: audit() });
  } else if (cmd === 'write' || cmd === 'correct') {
    const turn = await engine.respond({ sessionId: session.sessionId, text });
    await extractor.flush();
    out({
      cmd,
      at: now.toISOString(),
      dbPath,
      sessionId: session.sessionId,
      text,
      accepted: turn.accepted,
      reason: turn.reason,
      reply: turn.text,
      extracted: { processed: extractor.processed, errors: extractor.errors, pending: extractor.pending },
      semantic: semanticRows(),
      active: activeRows(),
      episodicCorrections: memory.episodic({ kind: 'correction', limit: 10 }).map((row) => row.summary),
      audit: audit(),
    });
  } else if (cmd === 'ask') {
    const context = engine.buildUserTurnContext({ sessionId: session.sessionId, text });
    const prompt = engine.buildPrompt({ sessionId: session.sessionId, text });
    const sections = prompt.sections.map((section) => ({ name: section.name, part: section.part, text: section.text, debug: section.debug ?? null }));
    const memoriesSection = sections.find((section) => section.name === 'memories') ?? null;
    const whole = `${prompt.system}\n${prompt.user}\n${sections.map((section) => section.text).join('\n')}`;
    out({
      cmd,
      at: now.toISOString(),
      dbPath,
      sessionId: session.sessionId,
      text,
      promptUser: prompt.user,
      memoriesSection,
      sectionNames: sections.map((section) => section.name),
      retrieval:
        context === null
          ? null
          : {
              injected: context.memories.length,
              lines: context.memories.map((row) => `${row.kind}:${row.text}`),
              diagnostics: context.memoriesDiagnostics,
            },
      auditPrompt: {
        hasDatabaseWord: whole.includes('数据库'),
        hasUuidShape: UUID_SHAPE.test(whole),
        hasMachineId: MACHINE_ID.test(whole),
        hasLongDigits: LONG_DIGITS.test(whole),
        hasDebugField: whole.includes('injected=') || whole.includes('dropped_at_render='),
      },
      semantic: semanticRows(),
      active: activeRows(),
      audit: audit(),
    });
  } else {
    out({ error: `unknown cmd "${String(cmd)}"`, usage: ['write', 'ask', 'correct', 'dump', 'realdump'] });
    process.exitCode = 2;
  }
} finally {
  store.close();
}
