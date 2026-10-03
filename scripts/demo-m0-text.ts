/**
 * Offline demo: one text turn through the whole M0 seam, with no model call.
 *
 * Uses the deterministic `FakeBrainAdapter`, so it always runs — on a plane, on
 * a broken network, or when the key has been rotated. The live version of this
 * path is `npm run verify:provider` / `npm run verify:m0`.
 *
 * Usage: node scripts/demo-m0-text.ts
 */
import { FakeBrainAdapter, collectTurn } from '@xixi/brain-adapter';

import { openXixiStore, resolveCanonicalDataDir } from '@xixi/domain';

import { REPO_ROOT, loadConfig, printEvidence } from './lib/harness.ts';

const config = loadConfig();
// V0.3 P0-B: the demo follows the same default as every other entry (canonical store), so what it
// writes is visible to `npm run chat`. Set `XIXI_DEMO_DATA_DIR` to keep a demo run out of it.
const store = openXixiStore({ dataDir: resolveCanonicalDataDir({ legacyEnv: 'XIXI_DEMO_DATA_DIR', cwd: REPO_ROOT }) });

try {
  store.seedSelfProfile(config.personality.base);
  const session = store.latestSession() ?? store.createSession();
  const adapter = new FakeBrainAdapter();

  const userText = process.argv[2] ?? '西西，明天天气怎么样？';
  const turns = store.recentTurns(session.sessionId, 4);
  store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: userText });

  const stream = await adapter.handleUserTurn({
    sessionId: session.sessionId,
    text: userText,
    context: {
      identityName: config.identity.name,
      personality: store.selfProfile(),
      timezone: config.identity.timezone,
      workingMemory: turns.map((turn) => ({ role: turn.role, text: turn.text, action: turn.action })),
    },
  });

  const chunks: string[] = [];
  for await (const chunk of stream) {
    if (chunk.type === 'text') chunks.push(chunk.text);
    else if (chunk.type === 'tool') chunks.push(`[tool:${chunk.name}]`);
  }
  const { result } = await collectTurn(stream);
  store.recordTurn({
    sessionId: session.sessionId,
    role: 'assistant',
    action: result.action,
    text: result.text,
    toolName: result.toolName,
  });

  printEvidence('离线一轮对话（FakeBrainAdapter，无网络调用）', {
    brain: adapter.describe(),
    sessionId: session.sessionId,
    identity: config.identity.name,
    userText,
    streamedChunks: chunks,
    action: result.action,
    text: result.text,
    toolName: result.toolName,
    effectivePersonality: store.selfProfile(),
    turnCount: store.getSession(session.sessionId).turnCount,
    eventCount: store.eventCount(),
    database: store.dbPath,
  });
} finally {
  store.close();
}
