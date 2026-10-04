import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEvent, type EventEnvelope } from '@xixi/contracts';
import {
  applyMoodDecay,
  applyMoodDelta,
  applyMoodSignals,
  applyTimeOfDay,
  clampMood,
  clampMoodValue,
  classifyMoodSignal,
  DEFAULT_MOOD_SETTINGS,
  DEFAULT_SELF_MODEL_SETTINGS,
  DomainError,
  fixedClock,
  listMigrationFiles,
  loadXixiConfig,
  MemoryStore,
  migrate,
  MOOD_BAND_THRESHOLDS,
  MOOD_BOUNDS,
  MOOD_SIGNAL_CODES,
  MOOD_SIGNALS,
  moodBand,
  moodBias,
  moodProse,
  NEUTRAL_MOOD,
  OpenThreadStore,
  openXixiStore,
  parseMoodSettings,
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
    [
      '001_initial.sql',
      '002_world_state.sql',
      '003_open_threads.sql',
      '004_memory.sql',
      '005_mood.sql',
      // V0.3 P1-b：记忆的状态机（语义记忆加 status / superseded_by / status_changed_at 三列 +
      // 一个按状态的索引）。只新增列，004 的文件一字未动。
      '006_memory_status.sql',
      // V0.3 P2-B：工具审批（pack 03 §5）新增 `tool_approvals` 一张表 + 两个索引。
      // 同样是**新增**：001–006 六个文件一字未动（另一份同样的清单在
      // tests/perception/world-state-projection.test.ts 里，两处一起更新才是完整的防线）。
      '007_tool_approvals.sql',
      // V0.3 P2-E：durable 提醒（pack 03 §7）新增 `reminders` 一张表 + 两个索引
      // （八个字段：id/owner/what/due_at/timezone/status/created_at/source_event_id）。
      // 同样是**新增**：001–007 七个文件一字未动。
      '008_reminders.sql',
    ],
    '已发布的迁移只能新增，不能改写（005_mood 是第五轮 t4 新增的心情表）',
  );
  const store = tempStore();
  try {
    assert.equal(store.appliedMigrations.length, files.length);
    // 四张表都能写（迁移真的建了表，而不是只写了个文件）。
    const memory = new MemoryStore(store);
    assert.ok(memory.recordEpisodic({ summary: '一件事', kind: 'episode', sourceType: 'program_extraction' }));
    const first = memory.recordSemantic({ property: 'place', statement: '我住在城东', sourceType: 'explicit_correction' });
    assert.ok(memory.recordNote({ aspect: 'humor', note: '喜欢听笑话', sourceType: 'explicit_correction' }));
    const self = new SelfModel(store);
    assert.equal(self.learn({ property: 'humor', delta: 0.1, sourceType: 'explicit_correction' }).applied, 0.1);
    assert.equal(self.overrides().length, 0);
    // 006：新写下的记忆是 active，而且状态读写路径真的通了（不只是列存在）。
    assert.equal(first.status, 'active');
    assert.equal(first.supersededBy, null);
    assert.equal(first.statusChangedAt, null);
    const second = memory.recordSemantic({ property: 'place', statement: '我不在城东住了', sourceType: 'explicit_correction' });
    const { previous } = memory.supersedeSemantic({
      memoryId: first.memoryId,
      supersededBy: second.memoryId,
      at: new Date(),
      reason: '用户更正了住址',
    });
    assert.equal(previous.status, 'superseded');
    assert.equal(previous.supersededBy, second.memoryId);
    assert.equal(previous.statement, '我住在城东', 'statement 一字不改：历史不许被改写');
    assert.deepEqual(
      memory.activeSemantic().map((entry) => entry.statement),
      ['我不在城东住了'],
      '只有 active 会被「算数的那些」看见',
    );
    assert.equal(memory.semantic().length, 2, '全量视图里两条都在（历史没被删）');

    // 面板与将来的人工清理用的两条通用入口（`setSemanticStatus` / `markSemanticExpired`）：
    // 它们没有别的调用者，所以必须在这里被真的跑一遍，否则就是死 API。
    const third = memory.recordSemantic({ property: 'routine', statement: '我每天六点起床', sourceType: 'program_extraction' });
    const expired = memory.markSemanticExpired({ memoryId: third.memoryId, at: new Date(), reason: '举例：太久没提起' });
    assert.equal(expired.status, 'expired');
    assert.equal(expired.supersededBy, null, '过期不是被取代：没有替代者');
    assert.equal(memory.activeSemantic().some((entry) => entry.memoryId === third.memoryId), false);
    const revoked = memory.setSemanticStatus({ memoryId: third.memoryId, status: 'revoked', at: new Date(), reason: '举例：他否认了这件事' });
    assert.equal(revoked.status, 'revoked');
    assert.notEqual(revoked.statusChangedAt, null);
    assert.throws(
      () => memory.setSemanticStatus({ memoryId: third.memoryId, status: 'superseded', at: new Date(), reason: '没有给出替代者' }),
      /superseded 必须给出取代它的那条记忆 id/,
      'superseded 不许指向空：那会让「被谁取代」永远查不出来',
    );
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

/**
 * 有界的心情（第五轮 t4）——**上下界的证明**。
 *
 * 判据不是「试了很多次都没越界」，而是每一条路径都只做 `clamp(prev + delta)`：
 * `clamp` 的值域是 `[0,1]`，与 `prev`、`delta` 无关，于是「`prev ∈ [0,1]` ⇒ `next ∈ [0,1]`」
 * 对任意步数归纳成立（`moodApply` 是全部写入路径的唯一入口）。
 *
 * 这条用例把那个归纳**逐格**跑出来：
 *   * 单步：每一个信号、每一个极端起点；
 *   * 序列：连续极端输入（同向 1000 次、轮换 1000 次）；
 *   * 反方向：只往一个方向推，也必须停在边界上而不是穿过去；
 *   * 坏输入：`NaN` / `±Infinity` / 负的经过时间 / `rate > 1`；
 *   * 衰减与时段牵引：任何一步都不例外。
 */
test('心情的上下界：任何输入序列（含连续极端）都不越界 —— 逐步 clamp 的归纳证明', () => {
  const inBounds = (state: { valence: number; energy: number }, where: string): void => {
    for (const [axis, value] of [
      ['valence', state.valence],
      ['energy', state.energy],
    ] as const) {
      assert.ok(
        Number.isFinite(value) && value >= MOOD_BOUNDS.min && value <= MOOD_BOUNDS.max,
        `${where}：${axis}=${value} 越界（必须在 [${MOOD_BOUNDS.min}, ${MOOD_BOUNDS.max}]）`,
      );
    }
  };

  // 1) clamp 本身：边界值、越界值、非有限值。`NaN` 不能被当成「大数」，它是坏输入 → 退回中性。
  assert.equal(clampMoodValue(0), 0);
  assert.equal(clampMoodValue(1), 1);
  assert.equal(clampMoodValue(1e9), 1);
  assert.equal(clampMoodValue(-1e9), 0);
  assert.equal(clampMoodValue(Number.POSITIVE_INFINITY), 1);
  assert.equal(clampMoodValue(Number.NEGATIVE_INFINITY), 0);
  assert.equal(clampMoodValue(Number.NaN), NEUTRAL_MOOD.valence);
  assert.deepEqual(clampMood({ valence: Number.NaN, energy: 9e9 }), { valence: 0.5, energy: 1 });

  // 2) 单步：每个信号 × 每个极端起点。
  const corners = [
    { valence: 0, energy: 0 },
    { valence: 1, energy: 1 },
    { valence: 0, energy: 1 },
    { valence: 1, energy: 0 },
    { valence: 0.5, energy: 0.5 },
  ];
  for (const corner of corners) {
    for (const code of MOOD_SIGNAL_CODES) {
      const spec = MOOD_SIGNALS[code];
      inBounds(applyMoodDelta(corner, { valence: spec.valence, energy: spec.energy }), `单步 ${code} 起点 ${JSON.stringify(corner)}`);
    }
  }

  // 3) 序列一：同一个极端信号连续 1000 次（「连续极端输入」）。
  let state = { valence: 0.5, energy: 0.5 };
  for (let step = 0; step < 1000; step += 1) {
    state = applyMoodSignals(state, [{ code: 'blamed', at: '2026-10-01T00:00:00+08:00', evidence: '被嫌了一句' }]).state;
    state = applyMoodSignals(state, [{ code: 'rejected', at: '2026-10-01T00:00:00+08:00', evidence: '被明确叫停了' }]).state;
    inBounds(state, `连续负面第 ${step} 步`);
  }
  assert.equal(state.valence, 0, '连续负面必须停在 0 而不是穿过去');

  // 4) 序列二：反方向（连续正面）停在 1。
  state = { valence: 0.5, energy: 0.5 };
  for (let step = 0; step < 1000; step += 1) {
    state = applyMoodSignals(state, [{ code: 'praised', at: '2026-10-01T00:00:00+08:00', evidence: '被夸了一句' }]).state;
    inBounds(state, `连续正面第 ${step} 步`);
  }
  assert.equal(state.valence, 1, '连续正面必须停在 1');

  // 5) 序列三：所有信号轮换 1000 次（正负交替、每类都上场）。
  state = { valence: 0.5, energy: 0.5 };
  for (let step = 0; step < 1000; step += 1) {
    const batch = MOOD_SIGNAL_CODES.map((code) => ({
      code,
      at: '2026-10-01T00:00:00+08:00',
      evidence: MOOD_SIGNALS[code].label,
    }));
    state = applyMoodSignals(state, batch).state;
    inBounds(state, `轮换第 ${step} 步`);
  }

  // 6) 衰减与时段：负时间、`NaN`、超大间隔、每个小时点。
  for (const hours of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY, 0.001, 24, 100_000]) {
    inBounds(applyMoodDecay({ valence: 0, energy: 1 }, hours), `衰减 ${String(hours)} 小时`);
    inBounds(applyMoodDecay({ valence: 1, energy: 0 }, hours), `衰减 ${String(hours)} 小时（反向）`);
  }
  for (let hour = 0; hour < 24; hour += 1) {
    for (const hours of [-1, 0, Number.NaN, 0.5, 8, 1000]) {
      inBounds(applyTimeOfDay({ valence: 0, energy: 0 }, hour, hours), `时段 ${hour} 点 / ${String(hours)} 小时`);
      inBounds(applyTimeOfDay({ valence: 1, energy: 1 }, hour, hours), `时段 ${hour} 点 / ${String(hours)} 小时（反向）`);
    }
  }

  // 7) 中性不被时段推动：「今天还没发生任何事」必须是真正的中性。
  for (let hour = 0; hour < 24; hour += 1) {
    assert.deepEqual(applyTimeOfDay(NEUTRAL_MOOD, hour, 8), NEUTRAL_MOOD, `${hour} 点的中性心情不该被时段推走`);
  }

  // 7b) 回落是**半程折返**：一次长间隔把偏离抹掉一部分，但永远抹不到越过中性到另一边。
  for (const start of [0, 0.1, 0.9, 1]) {
    const after = applyMoodDecay({ valence: start, energy: start }, 100, DEFAULT_MOOD_SETTINGS);
    assert.ok(after.valence >= Math.min(start, NEUTRAL_MOOD.valence) - 1e-9, `回落不该越过中性（起点 ${start}）`);
    assert.ok(after.valence <= Math.max(start, NEUTRAL_MOOD.valence) + 1e-9, `回落不该反向冲出去（起点 ${start}）`);
    inBounds(after, `回落 ${start}`);
  }
  assert.equal(applyMoodDecay(NEUTRAL_MOOD, 100, DEFAULT_MOOD_SETTINGS).valence, NEUTRAL_MOOD.valence, '中性没有可回落的东西');

  // 8) 出厂设置下走一遍完整序列（信号 + 衰减 + 时段交替），每一步都在界内。
  state = { valence: 0.5, energy: 0.5 };
  for (let step = 0; step < 500; step += 1) {
    const code = MOOD_SIGNAL_CODES[step % MOOD_SIGNAL_CODES.length] ?? 'praised';
    state = applyMoodSignals(state, [{ code, at: '2026-10-01T00:00:00+08:00', evidence: MOOD_SIGNALS[code].label }], DEFAULT_MOOD_SETTINGS).state;
    state = applyMoodDecay(state, step % 7 === 0 ? 12 : 0.1, DEFAULT_MOOD_SETTINGS);
    state = applyTimeOfDay(state, step % 24, step % 5 === 0 ? 6 : 0.5);
    inBounds(state, `完整序列第 ${step} 步（${code}）`);
  }
});

test('心情的语义层：区间决定散文，散文里没有数字、也不编造经历', () => {
  // 区间边界只有一份（`MOOD_BAND_THRESHOLDS`），散文只认区间。
  assert.equal(moodBand(0), 'veryLow');
  assert.equal(moodBand(MOOD_BAND_THRESHOLDS.low - 0.01), 'low');
  assert.equal(moodBand(MOOD_BAND_THRESHOLDS.low), 'neutral');
  assert.equal(moodBand(MOOD_BAND_THRESHOLDS.good), 'neutral');
  assert.equal(moodBand(MOOD_BAND_THRESHOLDS.good + 0.01), 'good');
  assert.equal(moodBand(1), 'veryGood');

  // 偏表达：'good' 与 'neutral' 的措辞必须真的不一样（否则「轻微影响语气」没有可观察结果）。
  const neutral = moodProse({ valence: 0.5, energy: 0.5 });
  const good = moodProse({ valence: 0.9, energy: 0.5 });
  const low = moodProse({ valence: 0.1, energy: 0.1 });
  assert.notDeepEqual(neutral, good);
  assert.notDeepEqual(neutral, low);
  assert.match(good.join('\n'), /轻快|松快/);
  assert.match(low.join('\n'), /话少|别装|短一点/);

  // 散文里**没有数字**（pack §23：不要把情绪数值暴露给 prompt），也没有参数名/机器话。
  for (const state of [
    { valence: 0, energy: 0 },
    { valence: 0.5, energy: 0.5 },
    { valence: 1, energy: 1 },
    { valence: 0.42, energy: 0.77 },
  ]) {
    const text = moodProse(state).join('\n');
    assert.doesNotMatch(text, /\d/, `散文里不该出现数字：${text}`);
    assert.doesNotMatch(text, /valence|energy|mood|心情值|参数/i, `散文里不该出现参数名：${text}`);
    // pack §23 的可执行版本：不许出现「我今天出去买菜了」式的**不存在的实体经历**。
    assert.doesNotMatch(text, /我(今天|刚才|昨天)?(出去|去|到|在)(买|逛|看|吃|走|做)/, `散文不许编造实体经历：${text}`);
    assert.doesNotMatch(text, /(我|自己)(吃|喝|睡)过|我身体|我累了一天/, `散文不许描述身体经历：${text}`);
    // 但必须保留「这是状态不是事实」的那道边界。
    assert.match(text, /不要因此说出你没做过的事/);
  }

  // 偏表达与两个维度的**平均**一致：valence 高、energy 低时不该被算成「很好」。
  assert.equal(moodBias(NEUTRAL_MOOD), 0);
  assert.ok(moodBias({ valence: 1, energy: 1 }) > 0.9);
  assert.ok(moodBias({ valence: 0, energy: 0 }) < -0.9);
  assert.ok(moodBias({ valence: Number.NaN, energy: Number.NaN }) === 0, '坏输入退回中性而不是把偏置变成 NaN');
});

test('心情的信号识别：夸 / 嫌 / 明确叫停分得开，普通聊天不是情绪事件', () => {
  assert.equal(classifyMoodSignal('谢谢你啊'), 'praised');
  assert.equal(classifyMoodSignal('还是你细心'), 'praised');
  assert.equal(classifyMoodSignal('你说得不错'), 'praised');
  assert.equal(classifyMoodSignal('真烦人'), 'blamed');
  assert.equal(classifyMoodSignal('你记错了'), 'blamed');
  // 拒绝优先于嫌弃、也优先于夸奖：「你别说了，谢谢」按拒绝算。
  assert.equal(classifyMoodSignal('你别说了'), 'rejected');
  assert.equal(classifyMoodSignal('今天别聊了'), 'rejected');
  assert.equal(classifyMoodSignal('安静点'), 'rejected');
  assert.equal(classifyMoodSignal('你别说了，谢谢'), 'rejected');
  // 普通聊天与**长期指令**都不是心情信号：前者不该推动情绪，后者走人格学习那一层。
  for (const text of ['今天天气不错', '中午吃的面条', '明天我要去买药', '嗯', '', '   ']) {
    assert.equal(classifyMoodSignal(text), null, `「${text}」不该被当成情绪事件`);
  }
  assert.equal(classifyMoodSignal('你可以主动一点'), null, '长期指令不是心情信号（那是 feedback-interpreter 的活）');
  assert.equal(classifyMoodSignal('你话太多了'), null, '同上：嫌话多属于人格学习');
});

test('心情的持久化：可查看、可复位、可回滚（历史是一份变更记录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-mood-store-'));
  const at = new Date('2026-10-01T20:00:00+08:00');
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: fixedClock(at) });
  try {
    // 全新库：没有心情行，读回来是「还没有」（查看方不能把「没有」当成中性）。
    assert.equal(store.mood(), null);
    assert.equal(store.moodSchemaVersion(), 0);
    assert.deepEqual(store.moodHistory(), []);

    // 写入：非有限值也被夹住（表里不可能出现越界值）。
    const written = store.recordMood({
      state: { valence: 1.4, energy: Number.NaN },
      previous: null,
      source: 'mood:test',
      summary: '测试写入',
      signals: { praised: 1 },
      signalCount: 1,
      evidence: { praised: 1 },
    });
    assert.equal(written.valence, 1);
    assert.equal(written.energy, NEUTRAL_MOOD.energy, 'NaN 退回中性');
    assert.equal(store.moodSchemaVersion(), 1, '持久记录带 schema_version（铁律 10）');
    assert.deepEqual(store.mood()?.evidence, { praised: 1 });

    // 第二次写入（真的变了）→ 历史里多一行，且 delta 与 before/after 一致。
    store.recordMood({
      state: { valence: 0.2, energy: 0.3 },
      previous: { valence: written.valence, energy: written.energy },
      source: 'mood:blamed',
      summary: '被嫌了一句×1',
      signals: { blamed: 1 },
      signalCount: 1,
      evidence: { praised: 1, blamed: 1 },
    });
    const history = store.moodHistory();
    assert.equal(history.length, 2);
    assert.equal(history[1]?.note, '被嫌了一句×1');
    assert.ok(Math.abs((history[1]?.delta.valence ?? 0) - (0.2 - 1)) < 1e-9, 'delta 必须与 before/after 一致');

    // 没变化的一拍**不写历史**（否则每 tick 一行会把「为什么她今天低」淹掉），但 lastBeatAt 会前进。
    const beforeQuiet = store.moodHistory().length;
    store.recordMood({
      state: { valence: 0.2, energy: 0.3 },
      previous: { valence: 0.2, energy: 0.3 },
      source: 'mood:decay',
      summary: '没有新的信号',
      signals: {},
      signalCount: 0,
      evidence: { praised: 1, blamed: 1 },
      at: '2026-10-01T21:00:00+08:00',
    });
    assert.equal(store.moodHistory().length, beforeQuiet, '没变化就不写历史');
    assert.equal(store.mood()?.lastBeatAt, '2026-10-01T21:00:00+08:00', '但评估时刻要前进（衰减据它算）');

    // 复位：回到中性、留一行 reset=true、并把解释旧心情的计数清掉。
    const reset = store.resetMood('test:reset', '2026-10-01T22:00:00+08:00');
    assert.equal(reset.valence, NEUTRAL_MOOD.valence);
    assert.equal(reset.energy, NEUTRAL_MOOD.energy);
    assert.deepEqual(reset.evidence, {});
    const last = store.moodHistory().at(-1);
    assert.equal(last?.reset, true);
    assert.match(last?.note ?? '', /复位/);

    // 手改一行越界值（模拟旧版本/人工编辑）：读回来仍然在界内。
    const stored = store.mood();
    assert.ok(stored !== null);
  } finally {
    store.close();
  }

  // 重开：状态还在（持久化），且仍是合法值。
  const reopened = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: fixedClock(at) });
  try {
    const persisted = reopened.mood();
    assert.equal(persisted?.valence, NEUTRAL_MOOD.valence, '复位后的状态跨重启仍然是中性');
    assert.equal(reopened.appliedMigrations.length, 0, '重启不该重跑迁移');
  } finally {
    reopened.close();
  }
});

test('mood 段：出厂配置与代码默认逐字一致，坏值被夹进区间', () => {
  const config = loadXixiConfig(join(REPO_ROOT, 'config', 'xixi.example.yaml'));
  assert.deepEqual(parseMoodSettings(config.mood), DEFAULT_MOOD_SETTINGS);
  assert.deepEqual(parseMoodSettings(undefined), DEFAULT_MOOD_SETTINGS);
  assert.equal(parseMoodSettings({ decay_per_hour: 0.2 }).decayPerHour, 0.2);
  assert.deepEqual(
    parseMoodSettings({ enabled: 'yes', decay_per_hour: null, decay_cap: {}, max_signals_per_beat: [] }),
    DEFAULT_MOOD_SETTINGS,
  );
  // 越界被夹进区间（与 open_threads / self_model 同一口径），不是抛错。
  assert.deepEqual(parseMoodSettings({ decay_per_hour: 5, decay_cap: -1, max_signals_per_beat: 0 }), {
    ...DEFAULT_MOOD_SETTINGS,
    decayPerHour: 1,
    decayCap: 0,
    maxSignalsPerBeat: 1,
  });
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
