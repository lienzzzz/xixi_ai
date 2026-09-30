import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEvent, type EventEnvelope } from '@xixi/contracts';
import {
  DomainError,
  fixedClock,
  listMigrationFiles,
  loadXixiConfig,
  migrate,
  openXixiStore,
  parseXixiConfig,
  personalityProperty,
  XixiStore,
} from '@xixi/domain';
import { DatabaseSync } from 'node:sqlite';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

function tempStore(): XixiStore {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-store-'));
  return openXixiStore({ dbPath: join(dir, 'test.sqlite'), clock: fixedClock(new Date('2026-09-29T20:00:00+08:00')) });
}

function expectCode(code: string, run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected DomainError, received ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, received ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected DomainError(${code}), nothing was thrown`);
}

function healthEvent(): EventEnvelope {
  return buildEvent({
    event_type: 'system.health',
    source: 'brain-dsh',
    actor: 'system',
    confidence: 1,
    payload: { service: 'brain', status: 'ok', detail: null },
  });
}

test('opening a store applies migrations exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-migrate-'));
  const dbPath = join(dir, 'x.sqlite');
  const first = openXixiStore({ dbPath });
  assert.equal(first.appliedMigrations.length, listMigrationFiles().length);
  first.close();

  const second = openXixiStore({ dbPath });
  assert.equal(second.appliedMigrations.length, 0, 'a current database must not re-apply migrations');
  second.close();
});

test('an edited migration file is refused instead of silently re-run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-checksum-'));
  const dbPath = join(dir, 'x.sqlite');
  const store = openXixiStore({ dbPath });
  store.close();

  const altered = join(dir, 'altered');
  mkdirSync(altered);
  for (const file of listMigrationFiles()) {
    const body = file.name === '001_initial.sql' ? `${file.sql}\n-- tampered\n` : file.sql;
    writeFileSync(join(altered, file.name), body, 'utf8');
  }

  const db = new DatabaseSync(dbPath);
  const error = expectCode('MIGRATION_CHECKSUM_MISMATCH', () => migrate(db, '2026-09-29T20:00:00+08:00', altered));
  assert.match(error.detail, /applied=.*file=/);
  db.close();
});

test('the event log rejects duplicates and reads back in order', () => {
  const store = tempStore();
  try {
    const event = healthEvent();
    const stored = store.appendEvent(event);
    assert.equal(stored.sequence, 1);
    expectCode('DUPLICATE_EVENT', () => store.appendEvent(event));

    store.appendEvent(buildEvent({ event_type: 'presence.changed', source: 'simulator', actor: 'father', confidence: 0.8, payload: { present: true, source_detail: null } }));
    assert.equal(store.eventCount(), 2);
    assert.equal(store.readEvents({ type: 'system.health' }).length, 1);
    assert.equal(store.readEvents({ sinceSequence: 1 }).length, 1);
  } finally {
    store.close();
  }
});

test('recording turns keeps indices, projection and log consistent', () => {
  const store = tempStore();
  try {
    const session = store.createSession();
    const first = store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: '西西，明天天气怎么样？' });
    const second = store.recordTurn({ sessionId: session.sessionId, role: 'assistant', action: 'SILENCE', text: null });
    assert.equal(first.turn.turnIndex, 0);
    assert.equal(second.turn.turnIndex, 1);
    assert.equal(store.getSession(session.sessionId).turnCount, 2);
    assert.equal(store.recentTurns(session.sessionId).map((turn) => turn.text).join('|'), '西西，明天天气怎么样？|');
    assert.equal(store.readEvents({ type: 'conversation.turn' }).length, 2);
  } finally {
    store.close();
  }
});

test('unknown and ended sessions fail loudly', () => {
  const store = tempStore();
  try {
    expectCode('UNKNOWN_SESSION', () => store.getSession('sess_00000000-0000-4000-8000-000000000000'));
    const session = store.createSession();
    store.endSession(session.sessionId);
    expectCode('SESSION_ALREADY_ENDED', () => store.endSession(session.sessionId));
    expectCode('SESSION_ALREADY_ENDED', () =>
      store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: '再说一句' }),
    );
  } finally {
    store.close();
  }
});

test('seeding the personality baseline never overwrites what a restart restored', () => {
  const store = tempStore();
  try {
    const seeded = store.seedSelfProfile({ proactivity: 0.55, warmth: 0.8 });
    assert.deepEqual(
      seeded.map((entry) => [entry.property, entry.value]),
      [
        ['proactivity', 0.55],
        ['warmth', 0.8],
      ],
    );
    const history = store.selfProfileHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].beforeValue, null);
    assert.equal(history[0].sourceType, 'config:base');

    // A later run with different values must not reset an existing profile.
    store.seedSelfProfile({ proactivity: 0.1, warmth: 0.1 });
    assert.equal(store.selfProfile().proactivity, 0.55);
    assert.equal(store.selfProfileHistory().length, 2);
  } finally {
    store.close();
  }
});

test('personality seeds are validated against the property schema', () => {
  const store = tempStore();
  try {
    expectCode('UNKNOWN_PERSONALITY_PROPERTY', () => store.seedSelfProfile({ obedience: 1 }));
    expectCode('PROPERTY_OUT_OF_RANGE', () => store.seedSelfProfile({ proactivity: 1.4 }));
    assert.ok(personalityProperty('silence_tolerance'));
    assert.equal(personalityProperty('nope'), undefined);
  } finally {
    store.close();
  }
});

test('resume returns the latest session with its turns and personality', () => {
  const store = tempStore();
  try {
    store.seedSelfProfile({ proactivity: 0.55 });
    const session = store.createSession();
    store.recordTurn({ sessionId: session.sessionId, role: 'user', action: 'SPEAK', text: '一句' });
    const resumed = store.resume();
    assert.equal(resumed.session.sessionId, session.sessionId);
    assert.equal(resumed.turns.length, 1);
    assert.equal(resumed.personality.proactivity, 0.55);
    expectCode('UNKNOWN_SESSION', () => store.resume('sess_00000000-0000-4000-8000-000000000000'));
  } finally {
    store.close();
  }
});

test('the shipped example configuration loads and validates', () => {
  const config = loadXixiConfig(join(REPO_ROOT, 'config', 'xixi.example.yaml'));
  assert.equal(config.identity.name, '西西');
  assert.equal(config.models.llm.model, 'mimo-v2.6-flash');
  assert.equal(config.models.llm.thinking_realtime, false);
  assert.equal(config.personality.base.proactivity, 0.55);
});

test('malformed configuration is refused with a named path', () => {
  const error = expectCode('INVALID_CONFIG', () => parseXixiConfig('xixi:\n  identity:\n    name: 西西\n', 'inline.yaml'));
  assert.match(error.message, /missing section "models"/);
  expectCode('INVALID_CONFIG', () =>
    parseXixiConfig(
      `xixi:
  identity: {name: 西西, language: zh-CN, timezone: Asia/Shanghai}
  models:
    llm: {provider: mimo, model: mimo-v2.6-flash, thinking_realtime: false}
    asr: {provider: mimo, model: mimo-v2.5-asr}
    tts: {provider: mimo, model: mimo-v2.5-tts}
  personality: {base: {obedience: 1}}
  proactive: {}
  memory: {}
  privacy: {}
  features: {}
`,
      'inline.yaml',
    ),
  );
});
