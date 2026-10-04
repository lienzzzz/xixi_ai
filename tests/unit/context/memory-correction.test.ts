/**
 * 记忆纠正闭环（V0.3 P1-b / pack `docs/02_MEMORY_CONTEXT.md` §5）。
 *
 * 这一层要证明的三件事：
 *   1. **检测只认确定的说法**：`我什么时候喜欢…了` / `你记错了` / `忘掉这个` / `我不喝…` 算纠正，
 *      普通聊天不算 —— 不为了「有纠正」而把每句话当纠正；
 *   2. **状态真的被写下来**：旧的那条标 `superseded`（带 `supersededBy`）或 `revoked`，
 *      `statement` 一字不改，两条都在（pack §5 的要求是「不许并存而**不带状态**」，不是「不许并存」）；
 *   3. **旧事实真的不再被召回**：`MemoryRetriever` 只认 active 的语义记忆。
 *
 * Run: `npm test`（tests/unit 在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  correctedStatement,
  detectMemoryCorrection,
  MemoryCorrectionResolver,
  objectTermOf,
} from '@xixi/context';
import { fixedClock, MemoryStore, openXixiStore, type XixiStore } from '@xixi/domain';

import { MemoryRetriever } from '@xixi/context';

const NOW = new Date('2026-10-01T20:00:00+08:00');

function freshStore(): XixiStore {
  return openXixiStore({ dbPath: ':memory:', clock: fixedClock(NOW, 1_000) });
}

/** 一条「他明确说过的偏好」（显式纠正 = 置信 1、family 可见）。 */
function seed(memory: MemoryStore, statement: string, property = 'preference'): string {
  return memory.recordSemantic({
    property,
    statement,
    sourceType: 'explicit_correction',
    sourceEventId: 'evt_00000000-0000-4000-8000-000000000008',
  }).memoryId;
}

test('纠正检测只认确定的说法：四类纠正命中，普通聊天不命中', () => {
  const disown = detectMemoryCorrection('我什么时候喜欢绿茶了，我不喝那个。');
  assert.equal(disown?.ruleId, 'disown_claim');
  assert.equal(disown?.kind, 'replace', '这句话里给了反命题（我不喝那个），所以是「更正」而不是「单纯否定」');

  assert.equal(detectMemoryCorrection('我不喜欢绿茶了。')?.ruleId, 'negated_fact');
  assert.equal(detectMemoryCorrection('你记错了。')?.kind, 'replace');
  assert.equal(detectMemoryCorrection('忘掉这个。')?.kind, 'revoke', '「忘掉」不写替代说法');
  assert.equal(detectMemoryCorrection('以后别提这件事了。')?.kind, 'revoke');

  // 不命中：普通聊天、问句、太短的话。
  assert.equal(detectMemoryCorrection('今天天气不错。'), null);
  assert.equal(detectMemoryCorrection('你喜欢喝什么茶？'), null);
  assert.equal(detectMemoryCorrection('嗯。'), null);
  assert.equal(detectMemoryCorrection(''), null);
});

test('新陈述是程序拼出来的：动词取自这一轮、宾语取自被纠正的那条', () => {
  assert.equal(objectTermOf('我喜欢绿茶'), '绿茶');
  assert.equal(objectTermOf('父亲喜欢喝绿茶'), '绿茶', '剥掉宾语前重复的动词');
  assert.equal(objectTermOf('我住在城东'), '城东');
  assert.equal(correctedStatement('我喜欢绿茶', '我什么时候喜欢绿茶了，我不喝那个。'), '我不喝绿茶');
  // 拼不出来时返回 null（那时候只做 revoke，不编一条新事实）。
  assert.equal(correctedStatement('我喜欢绿茶', '你记错了。'), null);
});

test('纠正之后：旧行标 superseded（statement 一字不改）、新行写下来、两条都在', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    const oldId = seed(memory, '我喜欢绿茶');
    const resolver = new MemoryCorrectionResolver({ store });

    const outcome = resolver.resolve({
      userText: '我什么时候喜欢绿茶了，我不喝那个。',
      at: NOW,
      sessionId: 'sess_test',
      sourceEventId: 'evt_00000000-0000-4000-8000-000000000009',
    });

    assert.equal(outcome.status, 'superseded');
    assert.equal(outcome.target?.memoryId, oldId);
    assert.equal(outcome.written?.statement, '我不喝绿茶');
    assert.equal(outcome.written?.sourceType, 'explicit_correction');
    assert.equal(outcome.written?.sourceEventId, 'evt_00000000-0000-4000-8000-000000000009', '新记忆指回那一轮（铁律 4）');

    const old = memory.semanticMemory(oldId);
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededBy, outcome.written?.memoryId);
    assert.equal(old.statement, '我喜欢绿茶', '旧的说法一字不改：历史不许被改写');
    assert.equal(
      Date.parse(old.statusChangedAt ?? ''),
      NOW.getTime(),
      '状态变化记的是那一刻（不是「现在的机器时间」）',
    );

    // 「不许并存而不带状态」：两条都在，但只有一条算数。
    assert.equal(memory.semantic().length, 2, '历史留着');
    assert.deepEqual(memory.activeSemantic().map((entry) => entry.statement), ['我不喝绿茶']);
    // 状态变化也留了痕（事件日志里的一条 system.health）。
    const audit = store.readEvents({ type: 'system.health', limit: 20 }).filter((event) => (event.payload as { service?: string }).service === 'memory.status');
    assert.equal(audit.length, 1, '状态变化必须能在日志里查到');
    assert.match(String((audit[0]?.payload as { detail?: string }).detail ?? ''), /superseded/);
  } finally {
    store.close();
  }
});

test('明确否定（没有替代说法）标 revoked，且不写新记忆', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    const oldId = seed(memory, '我喜欢绿茶');
    const outcome = new MemoryCorrectionResolver({ store }).resolve({ userText: '我什么时候说过我喜欢绿茶了', at: NOW });

    assert.equal(outcome.status, 'revoked');
    assert.equal(outcome.written, null);
    assert.equal(memory.semanticMemory(oldId).status, 'revoked');
    assert.equal(memory.semantic().length, 1, '没有替代说法就不写第二条');
    assert.deepEqual(memory.activeSemantic(), []);
  } finally {
    store.close();
  }
});

test('找不到「说的是哪一条」时什么都不做（宁可漏一次纠正，也不错标一条记忆）', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    const id = seed(memory, '我住在城东');
    const outcome = new MemoryCorrectionResolver({ store }).resolve({ userText: '我什么时候喜欢喝白茶了', at: NOW });

    assert.notEqual(outcome.detection, null, '检测本身命中了');
    assert.equal(outcome.target, null, '但没有任何一条记忆对得上');
    assert.equal(outcome.status, null);
    assert.match(outcome.reason, /没找到对得上的记忆/);
    assert.equal(memory.semanticMemory(id).status, 'active', '不相干的记忆不许被误标');
  } finally {
    store.close();
  }
});

test('旧事实不再被召回：检索器只认 active 的语义记忆', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    seed(memory, '我喜欢绿茶');
    const retriever = new MemoryRetriever(store);
    const query = '我想喝点茶，你记得我喜欢喝什么茶吗';

    const before = retriever.retrieve({ query, now: NOW, audience: { mode: 'private', actor: 'father', note: '' }, recentTurns: [] });
    assert.equal(before.memories.some((entry) => entry.text.includes('喜欢绿茶')), true, '纠正之前它会被想起来');

    new MemoryCorrectionResolver({ store }).resolve({ userText: '我什么时候喜欢绿茶了，我不喝那个。', at: NOW });

    const after = retriever.retrieve({ query, now: NOW, audience: { mode: 'private', actor: 'father', note: '' }, recentTurns: [] });
    assert.equal(after.memories.some((entry) => entry.text.includes('喜欢绿茶')), false, '纠正之后它不再被召回');
    // 取而代之的那条是不是「算数的」：直接查库（召回还要过相关性门槛，那是检索器自己的用例）
    // 并且用一句点名它的问法证明它**能**被想起来。
    assert.deepEqual(memory.activeSemantic().map((entry) => entry.statement), ['我不喝绿茶']);
    const asked = retriever.retrieve({ query: '我不喝绿茶吗', now: NOW, audience: { mode: 'private', actor: 'father', note: '' }, recentTurns: [] });
    assert.equal(asked.memories.some((entry) => entry.text.includes('不喝绿茶')), true, '点名问它时会被想起来');
  } finally {
    store.close();
  }
});

test('闭环是幂等的：同一句话跑两次不会写第二条记忆、也不会再动状态', () => {
  const store = freshStore();
  try {
    const memory = new MemoryStore(store);
    seed(memory, '我喜欢绿茶');
    const resolver = new MemoryCorrectionResolver({ store });
    const input = { userText: '我什么时候喜欢绿茶了，我不喝那个。', at: NOW };

    const first = resolver.resolve(input);
    const second = resolver.resolve(input);
    assert.equal(first.status, 'superseded');
    assert.equal(second.status, null, '目标已经不是 active，第二次没有可纠的对象');
    assert.equal(memory.semantic().length, 2, '两条：被取代的那条 + 新写下的那条');
    assert.equal(store.readEvents({ type: 'system.health', limit: 20 }).length, 1, '审计也只有一条');
  } finally {
    store.close();
  }
});
