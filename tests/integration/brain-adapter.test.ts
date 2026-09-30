import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrainError, DshBrainAdapter, ScriptedDshTransport, collectTurn } from '@xixi/brain-adapter';
import { openXixiStore, type XixiStore } from '@xixi/domain';

function freshStore(): XixiStore {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-adapter-'));
  return openXixiStore({ dbPath: join(dir, 'x.sqlite') });
}

function context() {
  return {
    identityName: '西西',
    personality: { proactivity: 0.55 },
    timezone: 'Asia/Shanghai',
    workingMemory: [{ role: 'user' as const, text: '上一句', action: 'SPEAK' as const }],
  };
}

test('the adapter mints a harness session once and resumes it afterwards', async () => {
  const store = freshStore();
  try {
    const session = store.createSession();
    const transport = new ScriptedDshTransport({
      sessionId: 'session-test-0001',
      turns: [{ text: '好的。' }, { text: '还是好的。' }],
    });
    const adapter = new DshBrainAdapter({ transport, store });

    const first = await collectTurn(await adapter.handleUserTurn({ sessionId: session.sessionId, text: '第一句', context: context() }));
    assert.equal(first.result.brainSessionId, 'session-test-0001');
    assert.equal(transport.requests[0].resumeBrainSessionId, null, 'the first turn must not pretend to resume');
    assert.equal(store.brainSessionId(session.sessionId, 'dsh'), 'session-test-0001', 'the mapping must be durable');

    const second = await collectTurn(await adapter.handleUserTurn({ sessionId: session.sessionId, text: '第二句', context: context() }));
    assert.equal(transport.requests[1].resumeBrainSessionId, 'session-test-0001', 'the second turn must resume');
    assert.equal(second.result.brainSessionId, 'session-test-0001');
  } finally {
    store.close();
  }
});

test('a tool call is surfaced as a chunk and as structured result data', async () => {
  const store = freshStore();
  try {
    const session = store.createSession();
    const transport = new ScriptedDshTransport({
      turns: [{ action: 'TOOL', toolName: 'xixi_get_current_time', text: '时间已读取。' }],
    });
    const adapter = new DshBrainAdapter({ transport, store });
    const { chunks, result } = await collectTurn(
      await adapter.handleUserTurn({ sessionId: session.sessionId, text: '几点了', context: context() }),
    );
    assert.equal(result.action, 'TOOL');
    assert.equal(result.toolName, 'xixi_get_current_time');
    assert.deepEqual(chunks[0], { type: 'tool', name: 'xixi_get_current_time' });
    assert.ok(chunks.some((chunk) => chunk.type === 'text'));
  } finally {
    store.close();
  }
});

test('transport and provider failures become typed BrainErrors', async () => {
  const store = freshStore();
  try {
    const session = store.createSession();

    const broken = new DshBrainAdapter({
      transport: new ScriptedDshTransport({ turns: [{ throwTransport: 'spawn failed' }] }),
      store,
    });
    await assert.rejects(
      () => broken.handleUserTurn({ sessionId: session.sessionId, text: 'x', context: context() }),
      (error: unknown) => error instanceof BrainError && error.code === 'TRANSPORT_FAILED',
    );

    const failing = new DshBrainAdapter({
      transport: new ScriptedDshTransport({
        turns: [{ ok: false, error: { code: 'MISSING_CREDENTIAL', message: 'no credential for route "mimo"' } }],
      }),
      store,
    });
    await assert.rejects(
      () => failing.handleUserTurn({ sessionId: session.sessionId, text: 'x', context: context() }),
      (error: unknown) =>
        error instanceof BrainError && error.code === 'PROVIDER_FAILED' && error.detail.includes('MISSING_CREDENTIAL'),
    );
  } finally {
    store.close();
  }
});

test('an answer for a different request id is refused', async () => {
  const store = freshStore();
  try {
    const session = store.createSession();
    const transport = {
      kind: 'mismatched',
      turn: async () => ({
        requestId: 'req_somebody_else',
        ok: true,
        brainSessionId: 'session-x',
        action: 'SPEAK' as const,
        text: 'hi',
        toolName: null,
        provider: 'dsh',
        model: 'mimo-v2.6-flash',
      }),
    };
    const adapter = new DshBrainAdapter({ transport, store });
    await assert.rejects(
      () => adapter.handleUserTurn({ sessionId: session.sessionId, text: 'x', context: context() }),
      (error: unknown) => error instanceof BrainError && error.code === 'INVALID_RESPONSE',
    );
  } finally {
    store.close();
  }
});

test('capabilities that belong to later milestones fail loudly, not silently', async () => {
  const store = freshStore();
  try {
    const adapter = new DshBrainAdapter({ transport: new ScriptedDshTransport({ turns: [] }), store });
    await assert.rejects(
      () => adapter.interpretFeedback({ text: '你话太多了' }),
      (error: unknown) => error instanceof BrainError && error.code === 'NOT_IMPLEMENTED' && error.milestone === 'M3',
    );
    await assert.rejects(
      () => adapter.evaluateProactiveCandidate({ candidateId: 'pc_1', trigger: 'father_returned_home', salience: 0.8, novelty: 0.5, topicCandidates: [] }),
      (error: unknown) => error instanceof BrainError && error.milestone === 'M5',
    );
  } finally {
    store.close();
  }
});
