import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrainError, DshBrainAdapter, MimoBrainAdapter, ScriptedDshTransport, brainErrorCodeFor } from '@xixi/brain-adapter';
import { openXixiStore } from '@xixi/domain';
import { MimoClient, ModelError } from '@xixi/model-adapters';

/**
 * §21.1 降级 needs to tell failure classes apart: a wrong key ("fix the
 * credential") is not a rate limit ("back off and retry") and neither is a
 * provider fault. Before this test, every `ModelError` except TIMEOUT became
 * `PROVIDER_FAILED`, so that distinction was lost at the adapter seam.
 */
function clientAnswering(status: number, body: unknown = {}): MimoClient {
  const fetchImpl = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
  return new MimoClient({ apiKey: 'test-key', fetchImpl });
}

async function failureFor(status: number): Promise<BrainError> {
  const adapter = new MimoBrainAdapter({ client: clientAnswering(status), stream: false });
  try {
    await adapter.handleUserTurn({ sessionId: 'sess_00000000-0000-4000-8000-000000000000', text: '你好' });
  } catch (error) {
    assert.ok(error instanceof BrainError, `expected a BrainError, received ${String(error)}`);
    return error;
  }
  throw new Error(`expected status ${status} to fail`);
}

test('HTTP status classes survive the adapter seam instead of collapsing into PROVIDER_FAILED', async () => {
  const expected: readonly [number, string, string][] = [
    [401, 'AUTH', 'AUTH'],
    [403, 'AUTH', 'AUTH'],
    [402, 'QUOTA', 'QUOTA'],
    [429, 'RATE_LIMIT', 'RATE_LIMIT'],
    [400, 'BAD_REQUEST', 'BAD_REQUEST'],
    [503, 'PROVIDER_FAILED', 'PROVIDER'],
  ];
  for (const [status, code, originalCode] of expected) {
    const failure = await failureFor(status);
    assert.equal(failure.code, code, `status ${status} must map to ${code}`);
    assert.equal(failure.originalCode, originalCode, `status ${status} must keep the provider code`);
    assert.ok(failure.detail.includes(`${originalCode}:`), 'the raw provider reason stays in the detail');
  }
});

test('a shared classifier keeps both paths honest about the same provider codes', () => {
  assert.deepEqual(brainErrorCodeFor('AUTH'), { code: 'AUTH', isKnown: true });
  assert.deepEqual(brainErrorCodeFor('RATE_LIMIT'), { code: 'RATE_LIMIT', isKnown: true });
  assert.deepEqual(brainErrorCodeFor('QUOTA'), { code: 'QUOTA', isKnown: true });
  assert.deepEqual(brainErrorCodeFor('TIMEOUT'), { code: 'TIMEOUT', isKnown: true });
  assert.deepEqual(brainErrorCodeFor('MISSING_CREDENTIAL'), { code: 'TRANSPORT_FAILED', isKnown: true });
  // An unknown provider code must not be silently dropped: it is still reported
  // as a provider fault, and the original code is preserved alongside it.
  assert.deepEqual(brainErrorCodeFor('SOMETHING_NEW'), { code: 'PROVIDER_FAILED', isKnown: false });
});

test('a network failure is a transport problem, not a model-provider fault', async () => {
  const fetchImpl = (async () => {
    throw new Error('getaddrinfo ENOTFOUND api.xiaomimimo.com');
  }) as unknown as typeof fetch;
  const adapter = new MimoBrainAdapter({ client: new MimoClient({ apiKey: 'test-key', fetchImpl }), stream: false });
  await assert.rejects(
    () => adapter.handleUserTurn({ sessionId: 'sess_00000000-0000-4000-8000-000000000000', text: '你好' }),
    (error: unknown) =>
      error instanceof BrainError && error.code === 'TRANSPORT_FAILED' && error.originalCode === 'NETWORK',
  );
});

test('a missing key arrives as MISSING_KEY before any request is attempted', async () => {
  // `MimoClient.#post` used to build its headers inside the fetch try-block, so a
  // missing key was caught and re-labelled `NETWORK`: a user who forgot to fill
  // `.env` was told the network was broken. The classification is decided before
  // any I/O now, so the local configuration fault keeps its own class (§21.1) and
  // nothing is sent upstream.
  let attempted = 0;
  const fetchImpl = (async () => {
    attempted += 1;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as typeof fetch;
  }) as unknown as typeof fetch;
  const client = new MimoClient({ fetchImpl });

  await assert.rejects(
    () => client.chat({ model: 'mimo-v2.6-flash', messages: [{ role: 'user', content: '你好' }] }),
    (error: unknown) => error instanceof ModelError && error.code === 'MISSING_KEY',
  );
  assert.equal(attempted, 0, 'a missing key must be refused locally, not sent upstream');

  // …and the adapter translates what it is handed, so the class survives the seam.
  const adapter = new MimoBrainAdapter({ client: new MimoClient({ fetchImpl }), stream: false });
  await assert.rejects(
    () => adapter.handleUserTurn({ sessionId: 'sess_00000000-0000-4000-8000-000000000000', text: '你好' }),
    (error: unknown) =>
      error instanceof BrainError &&
      error.code === 'TRANSPORT_FAILED' &&
      error.originalCode === 'MISSING_KEY' &&
      error.detail.includes('MISSING_KEY'),
  );
  assert.equal(attempted, 0, 'both layers must refuse before touching the network');
});

test('the DSH path keeps the harness error code in originalCode', async () => {
  // The harness reports its own error code. `BrainError.code` at this boundary
  // stays PROVIDER_FAILED (the harness answer is a provider-side failure), but the
  // real code is preserved in `originalCode`, so §21.1 can tell "bad credential"
  // from "rate limited" from "provider fault" without parsing the message text.
  const store = openXixiStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-errorclass-')), 'x.sqlite') });
  try {
    const session = store.createSession();
    const context = { identityName: '西西', personality: {}, timezone: 'Asia/Shanghai', workingMemory: [] };
    const expected: readonly [string, string | null][] = [
      ['AUTH', 'AUTH'],
      ['RATE_LIMIT', 'RATE_LIMIT'],
      ['QUOTA', 'QUOTA'],
      ['BAD_REQUEST', 'BAD_REQUEST'],
      // Not part of the closed provider-code set: the raw code stays in the detail.
      ['MISSING_CREDENTIAL', null],
    ];
    for (const [providerCode, originalCode] of expected) {
      const adapter = new DshBrainAdapter({
        transport: new ScriptedDshTransport({ turns: [{ ok: false, error: { code: providerCode, message: 'nope' } }] }),
        store,
      });
      await assert.rejects(
        () => adapter.handleUserTurn({ sessionId: session.sessionId, text: 'x', context }),
        (error: unknown) =>
          error instanceof BrainError &&
          error.code === 'PROVIDER_FAILED' &&
          error.originalCode === originalCode &&
          error.detail.includes(providerCode),
        `${providerCode} must survive as ${String(originalCode)}`,
      );
    }

    // The mapping table itself is shared with the direct path, which is what keeps
    // the two paths from disagreeing about a code's meaning.
    assert.equal(brainErrorCodeFor('AUTH').code, 'AUTH');
    assert.equal(brainErrorCodeFor('MISSING_CREDENTIAL').code, 'TRANSPORT_FAILED');
  } finally {
    store.close();
  }
});
