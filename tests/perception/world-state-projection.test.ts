/**
 * WorldState-lite 的领域侧验收（M6 第二个阶段）：`presence.changed` 事件 + 当前在场投影。
 *
 * 这些断言针对的是**代码里的语义**，不是文档里的承诺：
 *   * 事件日志是历史（唯一事实来源），`world_state` 只是「现在」——《方案》§5.3/§5.4；
 *   * 每个状态都带 value / source / updated_at / confidence / TTL，并且过期就是过期；
 *   * 写入是**一个事务**（事件 + 投影），不会出现「日志里有事件但投影没更新」。
 *
 * 真实摄像头抓帧与检测器耗时属于另一件事：`scripts/verify-camera-presence.ts`，
 * 离线部分是 `tests/perception/test_presence.py`（由同目录的 camera-presence.test.ts 驱动）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateEvent } from '@xixi/contracts';
import {
  DEFAULT_PRESENCE_TTL_SECONDS,
  DomainError,
  PRESENCE_KEY,
  fixedClock,
  listMigrationFiles,
  openXixiStore,
} from '@xixi/domain';

const START = new Date('2026-09-30T10:00:00+08:00');

function tempStore(stepMs = 0) {
  return openXixiStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-worldstate-')), 'x.sqlite'),
    clock: fixedClock(START, stepMs),
  });
}

test('002_world_state is a new, additive migration', () => {
  const files = listMigrationFiles();
  // 契约外的必要改动（第三轮 t6 → t8）：未完话题（003_open_threads.sql）与长期记忆
  // （004_memory.sql）各要一批新表，所以多了两个**新增**的迁移。这条断言的用意是
  // 「已发布的迁移只能新增、不能改写」，因此列表必须把每一个已发布文件都写出来
  // （改写 001/002/003 仍然会被抓住），新迁移就把它加进来。
  //
  // 第五轮 t4：有界的心情新增 `005_mood.sql`（`mood_state` + `mood_history` 两张表，
  // 见 docs/adr/0013-bounded-mood-state.md）。它同样是**新增**，没有改写任何已发布的迁移。
  assert.deepEqual(
    files.map((file) => file.name),
    ['001_initial.sql', '002_world_state.sql', '003_open_threads.sql', '004_memory.sql', '005_mood.sql'],
    '已发布的迁移只能新增，不能改写',
  );
  const store = tempStore();
  try {
    // 打开一个空库会把所有迁移都跑掉；第二次打开不重跑（checksum 守护见 domain.test.ts）。
    assert.equal(store.appliedMigrations.length, files.length);
    assert.equal(store.worldStateSchemaVersion(), 1, '投影也带 schema_version（铁律 10）');
  } finally {
    store.close();
  }

  const reopened = openXixiStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-worldstate-')), 'x.sqlite'),
    clock: fixedClock(new Date(START.getTime() + 1000), 0),
  });
  reopened.close();
});

test('a presence transition writes one event and one projection row', () => {
  const store = tempStore();
  try {
    const recorded = store.recordPresenceChanged({
      present: true,
      source: 'perception.laptop_camera',
      confidence: 0.9,
      sourceDetail: 'state=present frames=16 motion_ratio=0.0318 faces=1 gate=motion+face reason=present_confirmed',
    });

    // 1) 事件是合法的 xixi.event.v1（用权威校验器，不是「看起来对」）。
    //    StoredEvent 在信封之外多一个日志位置 `sequence`，校验前要去掉。
    const { sequence, ...envelope } = recorded.event;
    assert.equal(sequence, 1);
    const validated = validateEvent(JSON.parse(JSON.stringify(envelope)));
    assert.equal(validated.event_type, 'presence.changed');
    assert.equal(validated.source, 'perception.laptop_camera');
    assert.equal(validated.confidence, 0.9);
    assert.deepEqual(Object.keys(validated.payload).sort(), ['present', 'source_detail']);

    // 2) 投影就是 §5.3 要求的五件事
    const state = store.worldState(PRESENCE_KEY);
    assert.ok(state !== null);
    assert.equal(state.value, 'present');
    assert.equal(state.present, true);
    assert.equal(state.source, 'perception.laptop_camera');
    assert.equal(state.confidence, 0.9);
    assert.equal(state.ttlSeconds, DEFAULT_PRESENCE_TTL_SECONDS);
    assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    assert.match(state.staleAfter, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    assert.equal(state.stale, false);
    assert.equal(recorded.state.previousState, null, '第一次写入之前没有值');
  } finally {
    store.close();
  }
});

test('a reading older than its TTL is stale, not "now"', () => {
  const store = tempStore();
  try {
    store.recordPresenceChanged({ present: true, confidence: 0.9, ttlSeconds: 60 });
    const fresh = store.worldState(PRESENCE_KEY, { now: '2026-09-30T10:00:30.000+08:00' });
    assert.equal(fresh?.stale, false, '30 秒后仍然是「现在」');
    const expired = store.worldState(PRESENCE_KEY, { now: '2026-09-30T10:01:31.000+08:00' });
    assert.equal(expired?.stale, true, 'TTL 边界之后必须判 stale（TTL 本身是占用时间，不是过期时刻）');
    assert.equal(expired?.staleAfter, '2026-09-30T10:01:00.000+08:00', 'staleAfter = updated_at + ttl');
  } finally {
    store.close();
  }
});

test('the event log stays the history while the projection keeps only the current value', () => {
  const store = tempStore(1000);
  try {
    store.recordPresenceChanged({ present: true, confidence: 0.75, sourceDetail: 'arrival' });
    store.recordPresenceChanged({ present: false, confidence: 0.85, sourceDetail: 'left' });
    store.recordPresenceChanged({ present: true, confidence: 0.9, sourceDetail: 'arrival again' });

    const history = store.readEvents({ type: 'presence.changed' });
    assert.equal(history.length, 3, '每一次翻转都在事件日志里');
    assert.deepEqual(
      history.map((event) => (event.payload as { present: boolean }).present),
      [true, false, true],
    );

    // 投影只有一行，值是最新那次；历史不会出现在投影里。
    assert.equal(store.worldStateEntries().length, 1);
    assert.equal(store.worldState(PRESENCE_KEY)?.present, true);
    assert.equal(store.worldState(PRESENCE_KEY)?.updatedAt, history[2]?.timestamp);
  } finally {
    store.close();
  }
});

test('the projection is derived data: it can be rebuilt from the log alone', () => {
  const store = tempStore(1000);
  try {
    store.recordPresenceChanged({ present: true, confidence: 0.75, sourceDetail: 'arrival' });
    store.recordPresenceChanged({ present: false, confidence: 0.85, sourceDetail: 'left' });
    const before = store.worldState(PRESENCE_KEY);

    // 模拟「投影丢了」：直接删掉表里的行，然后用日志重建。
    const db = new DatabaseSync(store.dbPath);
    db.exec('DELETE FROM world_state');
    db.close();
    assert.equal(store.worldState(PRESENCE_KEY), null);

    const rebuilt = store.rebuildWorldStateFromEvents();
    assert.equal(rebuilt.scanned, 2);
    const after = store.worldState(PRESENCE_KEY);
    assert.equal(after?.value, 'absent');
    assert.equal(after?.value, before?.value);
    assert.equal(after?.updatedAt, before?.updatedAt, '重建不改变事实，只重建投影');
  } finally {
    store.close();
  }
});

test('presence cannot be written without its event (one transaction, no second writer)', () => {
  const store = tempStore();
  try {
    // setWorldState 存在，但它是给「已知事实」用的低层写入；presence 的公开路径只有
    // recordPresenceChanged，后者在同一事务里同时写日志 —— 这条测试固定住这个约定。
    store.recordPresenceChanged({ present: true, confidence: 0.9 });
    const events = store.readEvents({ type: 'presence.changed' });
    const state = store.worldState(PRESENCE_KEY);
    assert.equal(events.length, 1);
    assert.equal(state?.value, 'present');
    // 事件时间与投影时间必须一致：不一致就说明两个写入被拆开了。
    assert.equal(state?.updatedAt, events[0]?.timestamp);
  } finally {
    store.close();
  }
});

test('invalid projection writes fail loudly instead of storing nonsense', () => {
  const store = tempStore();
  try {
    const expectCode = (code: string, run: () => unknown): void => {
      try {
        run();
        assert.fail(`expected DomainError(${code})`);
      } catch (error) {
        assert.ok(error instanceof DomainError, String(error));
        assert.equal(error.code, code);
      }
    };
    expectCode('INVALID_WORLD_STATE', () => store.setWorldState({ key: '   ', value: 'x', source: 'test', confidence: 1 }));
    expectCode('INVALID_WORLD_STATE', () => store.setWorldState({ key: 'presence.home', value: 'x', source: 'test', confidence: 1.5 }));
    expectCode('INVALID_WORLD_STATE', () => store.setWorldState({ key: 'presence.home', value: 'x', source: 'test', confidence: 1, ttlSeconds: 0 }));
  } finally {
    store.close();
  }
});
