import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { FakeBrainAdapter, MimoBrainAdapter, collectTurn } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { EVENT_TYPES, buildEvent, validateEvent } from '@xixi/contracts';
import { fixedClock, openXixiStore, type XixiConfig } from '@xixi/domain';
import { MimoClient } from '@xixi/model-adapters';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * 语义诚实（铁律：不写做不到的东西）。
 *
 * `TurnAction` declares five actions, but only three have producers. The old
 * documentation said BACKCHANNEL/WAIT were "not implemented" while the code
 * simply never emitted them, and `BrainError.SESSION_MISMATCH` was a code that
 * existed in the type but was never thrown. This file freezes the *verified*
 * facts so the next reader does not have to re-derive them.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const DECLARED = ['SPEAK', 'BACKCHANNEL', 'WAIT', 'SILENCE', 'TOOL'] as const;

function sourceFiles(relativeDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'data') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(entry.name)) found.push(full);
    }
  };
  walk(join(REPO_ROOT, relativeDir));
  return found;
}

test('BACKCHANNEL and WAIT have no producer outside the declared contract', () => {
  // The contract (schema + registry) legitimately names all five §55 actions.
  // Anywhere else mentioning them would be a producer, and the audit found none.
  const declaresOnly = new Set([
    'packages/domain/src/store.ts', // `TurnAction` type definition
    'packages/contracts/src/events.ts', // event registry description
  ]);
  const offenders: string[] = [];
  for (const dir of ['packages', 'apps', 'scripts', 'plugins', 'services']) {
    for (const file of sourceFiles(dir)) {
      const path = relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (declaresOnly.has(path)) continue;
      const text = readFileSync(file, 'utf8');
      if (/(BACKCHANNEL|'WAIT'|"WAIT")/.test(text)) offenders.push(path);
    }
  }
  assert.deepEqual(offenders, [], 'adding a producer is fine — but it must update this test and docs/design/brain-and-models.md §8');
});

test('the real-time adapter can only produce SPEAK, SILENCE or TOOL', async () => {
  const client = new MimoClient({
    apiKey: 'test-key',
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({}),
    })) as unknown as typeof fetch,
  });
  const adapter = new MimoBrainAdapter({ client, stream: false });
  const produced = new Set<string>();
  for (const text of ['你好', '[静默]', '   ']) {
    try {
      const { result } = await collectTurn(await adapter.handleUserTurn({ sessionId: 'sess_x', text }));
      produced.add(result.action);
    } catch {
      // No usable body is fine here: this test only inspects what can be produced.
    }
  }
  assert.ok([...produced].every((action) => ['SPEAK', 'SILENCE', 'TOOL'].includes(action)));
  assert.equal(produced.has('BACKCHANNEL'), false);
  assert.equal(produced.has('WAIT'), false);
});

test('a rejected turn is recorded with SILENCE and never BACKCHANNEL/WAIT', async () => {
  const store = openXixiStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-deadcode-')), 'x.sqlite'),
    clock: fixedClock(new Date('2026-09-30T10:00:00+08:00'), 1000),
  });
  try {
    store.seedSelfProfile({ silence_tolerance: 0.5 });
    const config: XixiConfig = {
      identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
      models: { llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false }, asr: {} as never, tts: {} as never },
      personality: { base: {} },
      proactive: {},
      memory: {},
      privacy: {},
      features: {},
    };
    const engine = new ConversationEngine({
      adapter: new FakeBrainAdapter(),
      store,
      config,
      clock: fixedClock(new Date('2026-09-30T10:00:00+08:00'), 1000),
      fsm: { lingerMs: 30_000 },
    });
    const session = store.createSession();
    const turn = await engine.respond({ sessionId: session.sessionId, text: '电视里在说话', addressed: false });
    assert.equal(turn.action, 'SILENCE');
    const decisions = store.readEvents({ type: 'conversation.decision' });
    assert.equal(decisions.length, 1);
    assert.equal((decisions[0]?.payload as { action: string }).action, 'SILENCE');
  } finally {
    store.close();
  }
});

test('every declared action still round-trips through the event contract', () => {
  const turnSchema = EVENT_TYPES.find((definition) => definition.type === 'conversation.turn')?.payloadSchema;
  assert.ok(turnSchema !== undefined);
  const declared = (turnSchema.properties as Record<string, { enum?: string[] }>).action.enum ?? [];
  assert.deepEqual([...declared].sort(), [...DECLARED].sort(), 'the wire contract keeps all five §55 actions');

  // …and a BACKCHANNEL turn is still a *valid* event, so the contract does not
  // have to change when a producer for it lands.
  const event = buildEvent({
    event_type: 'conversation.turn',
    source: 'test',
    actor: 'xixi',
    confidence: 1,
    payload: {
      session_id: 'sess_00000000-0000-4000-8000-000000000000',
      turn_index: 0,
      role: 'assistant',
      action: 'BACKCHANNEL',
      text: '嗯。',
    },
  });
  // `validateEvent` types the payload as `JsonValue` (the contract cannot know the event type);
  // this test does, so it states the one field it reads.
  const payload = validateEvent(JSON.parse(JSON.stringify(event))).payload as { action: string };
  assert.equal(payload.action, 'BACKCHANNEL');
});
