import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEvent, type EventEnvelope } from '@xixi/contracts';
import {
  DEFAULT_SELF_MODEL_SETTINGS,
  DomainError,
  fixedClock,
  listMigrationFiles,
  loadXixiConfig,
  MemoryStore,
  migrate,
  OpenThreadStore,
  openXixiStore,
  parseSelfModelSettings,
  parseXixiConfig,
  personalityProperty,
  SelfModel,
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
  // The shipped default is 0.85 (ADR-0009 raised it twice: 0.55 → 0.70 → 0.85); it is what moves
  // the proactive threshold from 0.585 down to 0.45 + 0.30 × 0.15 = 0.495.
  assert.equal(config.personality.base.proactivity, 0.85);
  // pack Phase 3 的 `open_threads` 段（可选段；数值与代码默认的一致性在
  // tests/unit/core/topic-engine.test.ts 里逐字比较）。
  assert.equal(config.openThreads?.max_attempts, 2);
  assert.equal(config.openThreads?.followup_window_h, 48);
});

test('未完话题：状态机、投影与日志在同一个事务里保持一致', () => {
  const store = tempStore();
  try {
    const threads = new OpenThreadStore(store);
    const created = threads.create({
      threadId: 'thread_test01',
      summary: '明天下午我要去镇上办证',
      subject: '去镇上办证',
      followAfter: '2026-09-30T14:00:00+08:00',
      expireAt: '2026-10-02T14:00:00+08:00',
      followUpHint: '你之前说过要去镇上办证，后来怎么样了？',
      importance: 0.85,
      sourceEventId: 'evt_00000000-0000-4000-8000-000000000001',
    });
    assert.equal(created.created, true);
    assert.equal(created.thread.status, 'candidate');
    assert.equal(created.event?.event_type, 'open_thread.changed');
    assert.equal(created.event?.schema_version, 1);
    assert.equal((created.event?.payload as { status: string }).status, 'candidate');
    assert.equal((created.event?.payload as { previous_status: string | null }).previous_status, null);

    // 幂等：同一个 id 再建一次不会写第二条事件，也不会覆盖已存在的那条。
    const again = threads.create({ threadId: 'thread_test01', summary: '换一句别的说法' });
    assert.equal(again.created, false);
    assert.equal(again.event, null);
    assert.equal(again.thread.summary, '明天下午我要去镇上办证');
    // 话题去重：归一化后同一句话不再记第二遍（句末标点不算区别）。
    const duplicate = threads.create({ threadId: 'thread_test02', summary: '明天下午我要去镇上办证。' });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.thread.threadId, 'thread_test01');
    assert.equal(store.readEvents({ type: 'open_thread.changed', limit: Number.MAX_SAFE_INTEGER }).length, 1);

    // 「到点了」是严格的时间比较：14:00 之前不问，14:00 起可以问。
    assert.equal(threads.due(new Date('2026-09-30T13:59:00+08:00')).length, 0);
    assert.equal(threads.due(new Date('2026-09-30T14:00:00+08:00')).length, 1);

    // 说出口 → offered，次数加一，事件里留着上一个状态。
    const offered = threads.transition('thread_test01', 'offered', {
      offered: true,
      at: new Date('2026-09-30T15:00:00+08:00'),
      note: '主动追问了',
    });
    assert.equal(offered?.thread.attempts, 1);
    assert.equal(offered?.thread.lastOfferedAt, '2026-09-30T15:00:00.000+08:00');
    assert.equal((offered?.event?.payload as { previous_status: string }).previous_status, 'candidate');
    // 幂等：已经是这个状态就不再写事件。
    assert.equal(threads.transition('thread_test01', 'offered'), null);
    assert.equal(store.readEvents({ type: 'open_thread.changed', limit: Number.MAX_SAFE_INTEGER }).length, 2);

    // 收口之后**不允许**被重新打开（「被回应后不再重复问」靠这里兜底）。
    threads.transition('thread_test01', 'resolved', { at: new Date('2026-09-30T15:05:00+08:00'), note: '用户回答：办好了' });
    expectCode('INVALID_OPEN_THREAD', () => threads.transition('thread_test01', 'candidate'));
    expectCode('UNKNOWN_OPEN_THREAD', () => threads.transition('thread_nope', 'resolved'));

    assert.equal(store.openThreadHistory('thread_test01').length, 3, 'candidate → offered → resolved');
    assert.deepEqual(
      store.openThreads().map((thread) => [thread.threadId, thread.status]),
      [['thread_test01', 'resolved']],
    );
    assert.equal(store.openThreads({ status: 'candidate' }).length, 0);
    assert.equal(store.openThread('thread_nope'), null);
  } finally {
    store.close();
  }
});

test('配置里的 open_threads 段是可选的：没有它的旧配置照旧加载', () => {
  const legacy = parseXixiConfig(
    `xixi:
  identity: {name: 西西, language: zh-CN, timezone: Asia/Shanghai}
  models:
    llm: {provider: mimo, model: mimo-v2.6-flash, thinking_realtime: false}
    asr: {provider: mimo, model: mimo-v2.5-asr}
    tts: {provider: mimo, model: mimo-v2.5-tts}
  personality: {base: {proactivity: 0.85}}
  proactive: {}
  memory: {}
  privacy: {}
  features: {}
`,
    'legacy.yaml',
  );
  assert.equal(legacy.openThreads, undefined, '缺段 = 出厂默认，不是加载失败');
  assert.equal(legacy.selfModel, undefined, 'self_model 段同样是可选的');
});

test('长期记忆：三类记忆都能写、能查、能改、能删（AGENTS §5）', () => {
  const store = tempStore();
  try {
    const memory = new MemoryStore(store);
    const episodic = memory.recordEpisodic({
      summary: '记下一件事：明天下午我要去镇上办证',
      kind: 'plan',
      sourceType: 'program_extraction',
      sourceEventId: 'evt_00000000-0000-4000-8000-000000000001',
      importance: 0.85,
    });
    assert.match(episodic.memoryId, /^mem_/);
    assert.equal(episodic.confidence, 0.8, 'program_extraction 的可信度 0.8（显式纠正才是 1.0）');
    assert.equal(episodic.sourceEventId, 'evt_00000000-0000-4000-8000-000000000001', '每条记忆都指回原始事实');

    const semantic = memory.recordSemantic({ property: 'preference', statement: '我平时喜欢早上听会儿新闻', sourceType: 'explicit_correction' });
    assert.equal(semantic.confidence, 1, '父亲自己说的偏好，可信度 1');
    const note = memory.recordNote({ aspect: 'chat_style', note: '嫌话多：少说、少主动', sourceType: 'explicit_correction' });
    assert.equal(note.aspect, 'chat_style');

    // 查看（可按 kind / property / aspect 过滤）。
    assert.equal(memory.episodic({ kind: 'plan' }).length, 1);
    assert.equal(memory.episodic({ kind: 'correction' }).length, 0);
    assert.equal(memory.semantic({ property: 'preference' }).length, 1);
    assert.equal(memory.notes({ aspect: 'chat_style' }).length, 1);

    // 编辑与删除（父亲说「记错了」「忘掉这个」时程序真的照做）。
    assert.equal(memory.updateEpisodic(episodic.memoryId, { summary: '改过的摘要' }).summary, '改过的摘要');
    assert.equal(memory.updateSemantic(semantic.memoryId, { statement: '改过的事实' }).statement, '改过的事实');
    assert.equal(memory.forget(episodic.memoryId), true);
    assert.equal(memory.episodic().length, 0);
    assert.equal(memory.forgetSemantic(semantic.memoryId), true);
    assert.equal(memory.semantic().length, 0);
    expectCode('UNKNOWN_MEMORY', () => store.episodicMemory(episodic.memoryId));
  } finally {
    store.close();
  }
});

test('三层自我画像：基础 + 学习 + 会话覆盖，会话覆盖次日自动恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-selfmodel-'));
  const DAY1 = new Date(2026, 9, 1, 20, 0, 0);
  const DAY2 = new Date(2026, 9, 2, 9, 0, 0);
  let now = DAY1;
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => now });
  try {
    store.seedSelfProfile({ proactivity: 0.85, talkativeness: 0.75, verbosity: 0.7 });
    const self = new SelfModel(store);

    // 三层都空时，有效人格与基础层逐字相同（旧行为不变）。
    assert.deepEqual(store.selfProfile(), store.baseProfile());

    // 第二层：学习。
    const learned = self.learn({ property: 'proactivity', delta: 0.12, sourceType: 'explicit_correction', evidence: '用户说「你可以主动一点」' });
    assert.equal(learned.applied, 0.12);
    assert.equal(store.selfProfile().proactivity, 0.97);
    assert.equal(store.baseProfile().proactivity, 0.85, '基础层不被改写：学习是单独一层');

    // 第三层：会话覆盖（只对今天）。
    self.overrideToday({
      deltas: { proactivity: -0.3, talkativeness: -0.25, verbosity: -0.2 },
      reason: '用户说「今天想安静点」',
      sourceType: 'explicit_correction',
    });
    assert.equal(store.selfProfile({ now: DAY1 }).proactivity, 0.67, '0.85 + 0.12 − 0.30');
    assert.equal(store.selfProfile({ now: DAY1 }).talkativeness, 0.5);
    assert.equal(self.overrides(DAY1).length, 3);

    // 次日：覆盖失效（读取时按 valid_day 过滤，不需要定时任务）。
    now = DAY2;
    assert.equal(store.selfProfile({ now: DAY2 }).proactivity, 0.97, '学习层留下，覆盖层恢复');
    assert.equal(store.selfProfile({ now: DAY2 }).talkativeness, 0.75);
    assert.equal(self.overrides(DAY2).length, 0);

    // 同一天重复说「今天安静点」不会把偏移叠成 −0.7（同属性只保留一条）。
    now = DAY1;
    self.overrideToday({ deltas: { proactivity: -0.3 }, reason: '用户又说了一次', sourceType: 'explicit_correction' });
    assert.equal(store.selfProfile({ now: DAY1 }).proactivity, 0.67);

    // 可回滚：清掉学习层，历史不删。
    const rolled = self.rollback('proactivity');
    assert.equal(rolled.applied, -0.12);
    assert.equal(self.learned().find((entry) => entry.property === 'proactivity')?.delta, 0);
    const history = self.history('proactivity');
    assert.ok(history.some((change) => change.sourceType === 'learned:rollback'));
    assert.ok(history.some((change) => change.sourceType === 'session_override:explicit_correction'));
    assert.ok(history.every((change) => change.afterValue <= 1 && change.afterValue >= 0), 'history 记的是有效值');

    // 反向换算：面板（有效值）→ 基础层。学习层 −0.12 时，把有效值调到 0.7 要写基础层 0.82，
    // 否则学习偏移会被叠加两次（0.7 − 0.12 = 0.58）。这里用 DAY2 算，避开当天那条会话覆盖。
    self.learn({ property: 'talkativeness', delta: -0.12, sourceType: 'explicit_correction' });
    assert.equal(self.baseValueFor('talkativeness', 0.7, DAY2), 0.82);
    store.overrideSelfProfile({ talkativeness: self.baseValueFor('talkativeness', 0.7, DAY2) }, 'test:panel');
    assert.equal(store.selfProfile({ now: DAY2 }).talkativeness, 0.7, '用户看到的数就是他调的那个数');
  } finally {
    store.close();
  }
});

test('004_memory 是新增迁移：四张表落地，旧库照旧能打开', () => {
  const files = listMigrationFiles();
  assert.deepEqual(
    files.map((file) => file.name),
    ['001_initial.sql', '002_world_state.sql', '003_open_threads.sql', '004_memory.sql'],
    '已发布的迁移只能新增，不能改写',
  );
  const store = tempStore();
  try {
    assert.equal(store.appliedMigrations.length, files.length);
    // 四张表都能写（迁移真的建了表，而不是只写了个文件）。
    const memory = new MemoryStore(store);
    assert.ok(memory.recordEpisodic({ summary: '一件事', kind: 'episode', sourceType: 'program_extraction' }));
    assert.ok(memory.recordSemantic({ property: 'place', statement: '我住在城东', sourceType: 'explicit_correction' }));
    assert.ok(memory.recordNote({ aspect: 'humor', note: '喜欢听笑话', sourceType: 'explicit_correction' }));
    const self = new SelfModel(store);
    assert.equal(self.learn({ property: 'humor', delta: 0.1, sourceType: 'explicit_correction' }).applied, 0.1);
    assert.equal(self.overrides().length, 0);
  } finally {
    store.close();
  }
});

test('self_model 段：出厂配置与代码默认逐字一致，坏值被夹进区间', () => {
  const config = loadXixiConfig(join(REPO_ROOT, 'config', 'xixi.example.yaml'));
  assert.deepEqual(parseSelfModelSettings(config.selfModel), DEFAULT_SELF_MODEL_SETTINGS);
  assert.deepEqual(parseSelfModelSettings(undefined), DEFAULT_SELF_MODEL_SETTINGS);
  assert.equal(parseSelfModelSettings({ daily_limit_explicit: 0.4 }).dailyLimitExplicit, 0.4);
  assert.deepEqual(
    parseSelfModelSettings({ learning_enabled: 'yes', daily_limit_explicit: null, drift_limit: {}, session_override_limit: [] }),
    DEFAULT_SELF_MODEL_SETTINGS,
  );
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
