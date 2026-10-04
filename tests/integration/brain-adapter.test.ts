import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrainError, DshBrainAdapter, ScriptedDshTransport, collectTurn } from '@xixi/brain-adapter';
import { ModelError, MimoClient } from '@xixi/model-adapters';
import { openXixiStore, type XixiStore } from '@xixi/domain';

import { REPO_ROOT } from '../../scripts/lib/harness.ts';

/** V0.3 P2-F: the four capabilities the provider seam no longer declares (pack `docs/03_AGENT_PLUGIN.md` §8). */
const RETIRED = ['evaluateProactiveCandidate', 'interpretFeedback', 'extractMemories', 'reflect'] as const;

/**
 * A missing credential must stay `MISSING_KEY`.
 *
 * `MimoClient.#post` used to build its headers inside the fetch try-block, so
 * this local configuration fault was caught and re-labelled `NETWORK`: a user who
 * forgot to fill `.env` was told the network was broken. The classification is
 * now decided before any I/O, so the two diagnoses stay apart (§21.1) and the
 * request is never attempted.
 * （已修复：t12 把 `#headers()` 提到 fetch 的 try 之前；t14 把断言改成钉住已修复行为。下面的用例仍然有效，它防的是回归。）
 *
 * This case must control its own premise (本用例必须自己控制无密钥前提):
 * `MimoClient` resolves the key as `options.apiKey ?? process.env.MIMO_API_KEY`, so
 * omitting `apiKey` makes the test pass only on a machine whose environment has no
 * key. Passing `apiKey: undefined` does NOT help — `undefined` is exactly what
 * triggers the fallback — so the key is pinned to `''` (an empty string is not
 * nullish, so no fallback happens) and `hasKey === false` is asserted below.
 */
test('a missing API key fails as MISSING_KEY before any request is attempted', async () => {
  let attempted = 0;
  const fetchImpl = (async () => {
    attempted += 1;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  const client = new MimoClient({ apiKey: '', fetchImpl });
  assert.equal(client.hasKey, false, 'the no-key premise must hold regardless of process.env');

  await assert.rejects(
    () => client.chat({ model: 'mimo-v2.6-flash', messages: [{ role: 'user', content: '你好' }] }),
    (error: unknown) =>
      error instanceof ModelError &&
      error.code === 'MISSING_KEY' &&
      (error as ModelError).detail !== 'could not reach the model endpoint',
  );
  await assert.rejects(
    // `chatJson` takes a named schema (`{ name, schema }`), not a bare JSON Schema: the name is what
    // the provider's `json_schema` response format is keyed by.
    () => client.chatJson({ messages: [{ role: 'user', content: '你好' }], schema: { name: 'probe', schema: { type: 'object' } } }),
    (error: unknown) => error instanceof ModelError && error.code === 'MISSING_KEY',
  );
  assert.equal(attempted, 0, 'a missing key is refused locally, not sent upstream');
});

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

test('the retired capabilities are gone from the provider seam, and no declaration survives', () => {
  const store = freshStore();
  try {
    const adapter = new DshBrainAdapter({ transport: new ScriptedDshTransport({ turns: [] }), store });
    // V0.3 pack 03 §8: `evaluateProactiveCandidate` / `interpretFeedback` / `extractMemories` /
    // `reflect` used to be declared on every provider and threw `NOT_IMPLEMENTED` in all three of
    // them (docs/v03/ACTUAL_RUNTIME_MAP.md confirmed no production caller). They are **not**
    // capabilities every harness has, so the seam no longer advertises them and no adapter carries
    // a stub that lies about having one.
    for (const retired of RETIRED) {
      assert.equal(retired in adapter, false, `${retired} must not be on the provider seam any more`);
    }
    // Byte-independent structural judge over the seam's own source: the provider declarations are
    // read, not grepped, so the assertions and comments in this very file cannot produce a false hit.
    for (const file of ['types.ts', 'mimo.ts', 'dsh.ts', 'fake.ts']) {
      const source = readFileSync(join(REPO_ROOT, 'packages', 'brain-adapter', 'src', file), 'utf8');
      for (const retired of RETIRED) {
        assert.equal(
          source.includes(`${retired}(`),
          false,
          `${file} must not declare ${retired}() — the capability now lives where its input lives`,
        );
      }
    }
    // The one allowed mention: the retirement note plus the retired **data contracts** in `types.ts`
    // (plain shapes that no provider implements). It is named in prose, never as a method.
    const types = readFileSync(join(REPO_ROOT, 'packages', 'brain-adapter', 'src', 'types.ts'), 'utf8');
    assert.match(types, /NOT a provider method/, 'types.ts must say why these names are still there');
  } finally {
    store.close();
  }
});
