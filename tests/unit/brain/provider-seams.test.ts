/**
 * V0.3 P2-F / pack `docs/03_AGENT_PLUGIN.md` §8 — the provider seam is three interfaces, not one fat
 * `BrainAdapter`.
 *
 * What this file pins, and why each assertion is the one that can actually fail:
 *
 *   1. **A provider offers the turn seam and nothing more.** The four retired capabilities
 *      (`evaluateProactiveCandidate` / `interpretFeedback` / `extractMemories` / `reflect`) were
 *      declared on every provider and threw `NOT_IMPLEMENTED` in all three implementations. The
 *      runtime half reads the adapters' real properties, so re-adding a stub method (the tempting
 *      way to “keep compatibility”) turns it red; the source half reads the seam block itself, so a
 *      declaration nothing implements is caught as well.
 *   2. **The multimodal seam is a runtime-checkable flag.** `supportsImages` is the literal `true`
 *      on the one adapter that really carries a frame, and **absent** on the one that refuses image
 *      turns. That absence is the honest answer: a caller that branches on the flag must not be
 *      told “yes” by an adapter that would answer blind.
 *   3. **`inferJson` is a real capability of the direct path, not an interface nobody implements.**
 *      The stub client returns what the client's own retry produces (a valid object after a repair),
 *      so this also pins that the brain seam hands over the client's report unchanged — and that the
 *      caller's `validate` really runs, because a client that spends both attempts must end in an
 *      error rather than hand up a value the local schema already refused.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BrainError,
  DshBrainAdapter,
  FakeBrainAdapter,
  MimoBrainAdapter,
  ScriptedDshTransport,
  collectTurn,
  isSilenceReply,
  runInferJson,
  type InferJsonResult,
  type MultimodalTurnProvider,
  type StructuredInferenceProvider,
  type TurnModelProvider,
  type UserTurnInput,
} from '@xixi/brain-adapter';
import { MimoClient, ModelError } from '@xixi/model-adapters';

import { REPO_ROOT } from '../../../scripts/lib/harness.ts';

const RETIRED = ['evaluateProactiveCandidate', 'interpretFeedback', 'extractMemories', 'reflect'] as const;

const SESSION = 'sess_00000000-0000-4000-8000-000000000000';

function turnInput(text = '你好'): UserTurnInput {
  return { sessionId: SESSION, text };
}

/** A minimal store that satisfies `BrainSessionStore` without opening SQLite. */
const MEMORY_STORE = { brainSessionId: () => null, attachBrainSession: () => undefined };

// --------------------------------------------------------------- 1. the required seam, and no more

test('every provider carries the turn seam only — the four retired capabilities are absent at runtime', () => {
  // The adapters are the three real implementations: no key or harness needed for any of them.
  const providers: readonly TurnModelProvider[] = [
    new FakeBrainAdapter(),
    new DshBrainAdapter({ transport: new ScriptedDshTransport({ turns: [] }), store: MEMORY_STORE }),
    new MimoBrainAdapter({}),
  ];
  for (const provider of providers) {
    for (const retired of RETIRED) {
      assert.equal(retired in provider, false, `${provider.provider} must not expose ${retired}`);
    }
    assert.equal(typeof provider.describe, 'function', `${provider.provider} must describe itself`);
    assert.equal(typeof provider.handleUserTurn, 'function', `${provider.provider} must serve a turn`);
    assert.equal(typeof provider.provider, 'string');
  }
  // `FakeBrainAdapter` renders scripts, so its whole own-property surface is the seam: a re-added
  // stub method (the tempting way to “keep compatibility”) turns this red.
  assert.deepEqual(
    Object.keys(providers[0] as FakeBrainAdapter).filter((key) => !key.startsWith('#')).sort(),
    ['provider'],
  );
});

test('the required seam declares the three turn methods and none of the four retired names', () => {
  // The seam's own source, parsed by the declared block instead of by a repo-wide grep. A regex over
  // the whole repo cannot be used here: `interpretFeedback` is also the name of the **deterministic**
  // implementation in `@xixi/conversation` that this change deliberately keeps (`packages/conversation/src/feedback-interpreter.ts`),
  // so a name-based search would call a correct file a violation and invite weakening the check.
  const source = readFileSync(join(REPO_ROOT, 'packages', 'brain-adapter', 'src', 'types.ts'), 'utf8');
  const marker = 'export interface TurnModelProvider {';
  const start = source.indexOf(marker);
  assert.ok(start > 0, 'types.ts must declare TurnModelProvider');
  const block = source.slice(start + marker.length, source.indexOf('\n}', start));
  for (const expected of ['readonly provider: string', 'describe(): BrainDescription', 'handleUserTurn(input: UserTurnInput)']) {
    assert.ok(block.includes(expected), `TurnModelProvider must declare ${expected}`);
  }
  for (const retired of RETIRED) {
    assert.equal(block.includes(retired), false, `TurnModelProvider must not declare ${retired}`);
  }

  // The optional seams are separate interfaces — a provider opts in, nothing is forced on every
  // harness. `MultimodalTurnProvider extends TurnModelProvider`; `StructuredInferenceProvider` is
  // independent of the turn seam.
  assert.match(source, /export interface MultimodalTurnProvider extends TurnModelProvider \{/);
  assert.match(source, /export interface StructuredInferenceProvider \{/);
  assert.equal(/export interface StructuredInferenceProvider extends/.test(source), false);
  // The type-only split must not reintroduce the fat interface under a new name.
  assert.equal(/export interface BrainAdapter/.test(source), false);
});

// ----------------------------------------------------------------------- 2. the multimodal flag

test('supportsImages is declared only by the provider that really receives a frame', () => {
  const direct = new MimoBrainAdapter({});
  const multimodal: MultimodalTurnProvider = direct;
  // The literal `true` is what a caller branches on, so the flag is asserted as a value, not as a type.
  assert.equal(multimodal.supportsImages, true);
  assert.equal(direct.provider, 'mimo-direct');
  assert.equal(direct.describe().transport, 'https-api');

  const harnessPath: TurnModelProvider = new DshBrainAdapter({
    transport: new ScriptedDshTransport({ turns: [] }),
    store: MEMORY_STORE,
  });
  assert.equal('supportsImages' in harnessPath, false, 'the DSH path refuses image turns, so it must not claim the seam');

  const offline: TurnModelProvider = new FakeBrainAdapter();
  assert.equal('supportsImages' in offline, false, 'the scripted stand-in says nothing about pixels');
});

// ------------------------------------------------------------- 3. the structured-inference seam

type ChatJsonOptions = Parameters<MimoClient['chatJson']>[0];
type ChatJsonResult = Awaited<ReturnType<MimoClient['chatJson']>>;

/**
 * Models the client's own retry (`MimoClient.chatJson`): the schema attempt returns an object the
 * caller's check rejects, the repair returns a good one. `runInferJson` must pass that through
 * unchanged — attempts, notes and the parsed value — because it is a pass-through at the brain seam,
 * **not** a second retry. `validateCalls` counts how often the caller's check ran, so the test can
 * tell «the check really gates the result» from «the option was silently dropped on the way down».
 */
function stubClient(): {
  readonly client: Pick<MimoClient, 'chatJson'>;
  readonly calls: ChatJsonOptions[];
  readonly validateCalls: number[];
} {
  const calls: ChatJsonOptions[] = [];
  const validateCalls: number[] = [];
  const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: 0, cachedTokens: 0 };
  const client: Pick<MimoClient, 'chatJson'> = {
    async chatJson(options: ChatJsonOptions): Promise<ChatJsonResult> {
      calls.push(options);
      try {
        validateCalls.push(1);
        options.validate?.({ topic: 7, routine: '我平时喜欢喝铁观音' }); // `topic` is not a string
        return {
          json: { topic: 7, routine: '我平时喜欢喝铁观音' },
          model: 'stub',
          usage,
          attempts: 1,
          notes: [],
          totalMs: 1,
        };
      } catch {
        // Repair attempt: constrained by the fixes in `chatJson` (schema text in the prompt).
        validateCalls.push(1);
        options.validate?.({ topic: '茶叶', routine: '我平时喜欢喝铁观音' });
        return {
          json: { topic: '茶叶', routine: '我平时喜欢喝铁观音' },
          model: 'stub',
          usage,
          attempts: 2,
          notes: ['json_schema 形状不符', '已回退到 json_object（提示词内带 schema）并成功'],
          totalMs: 2,
        };
      }
    },
  };
  return { client, calls, validateCalls };
}

test('inferJson hands the caller the repaired object and the client’s own repair report', async () => {
  const { client, calls, validateCalls } = stubClient();
  const seen: unknown[] = [];
  const result: InferJsonResult = await runInferJson(
    client,
    {
      prompt: '从这句话里抽出话题与习惯：我平时喜欢喝铁观音。',
      schema: { name: 'memory_candidate', schema: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' } } } },
      validate: (value) => {
        seen.push(value);
        assert.equal(typeof (value as { topic?: unknown }).topic, 'string');
      },
    },
    { language: 'zh-CN', model: 'mimo-stub' },
  );

  assert.deepEqual(result.json, { topic: '茶叶', routine: '我平时喜欢喝铁观音' });
  assert.equal(result.model, 'stub');
  // Both facts come from the client, not from a second retry invented at this seam.
  assert.equal(result.attempts, 2, 'the caller must be able to tell an instant answer from a repaired one');
  assert.equal(result.notes.length, 2);
  assert.equal(calls.length, 1, 'the brain seam asks the client once');
  // The caller's check ran on both candidates, and the rejected one never reached the return value.
  assert.equal(validateCalls.length, 2);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], result.json);
  assert.notDeepEqual(seen[0], seen[1]);
});

test('a schema the caller rejects does not come back as a half-parsed object', async () => {
  // A client whose only candidate is unparseable-and-rejected, modelled on `MimoClient.chatJson`:
  // the parse fails, the caller's `validate` throws, and both the schema attempt and the repair are
  // spent. The seam must end in an error — never in a value the local schema already refused.
  const emptied: Pick<MimoClient, 'chatJson'> = {
    async chatJson(options: ChatJsonOptions): Promise<ChatJsonResult> {
      const candidate: unknown = { routine: '我平时喜欢' }; // no `topic`
      options.validate?.(candidate);
      throw new ModelError('INVALID_RESPONSE', 'structured output was unusable after a retry');
    },
  };
  await assert.rejects(
    () =>
      runInferJson(
        emptied,
        {
          prompt: 'x',
          schema: { name: 'memory_candidate', schema: { type: 'object', required: ['topic'] } },
          validate: (value) => {
            if (!Object.prototype.hasOwnProperty.call(value as object, 'topic')) throw new Error('缺少必需字段 topic');
          },
        },
        { language: 'zh-CN', model: 'mimo-stub' },
      ),
    (error: unknown) => error instanceof BrainError,
  );

  // The capability is a real method on the direct adapter, not an interface nobody implements.
  const seam: StructuredInferenceProvider = new MimoBrainAdapter({});
  assert.equal(typeof seam.inferJson, 'function');
});

test('inferJson keeps the failure classes apart instead of collapsing them', async () => {
  // A `BrainError` from the client passes through with its own code: a wrong key and a 500 must stay
  // distinguishable above the seam (§21.1).
  const failing = {
    async chatJson(): Promise<never> {
      throw new BrainError('PROVIDER_FAILED', 'the provider answered 500');
    },
  };
  await assert.rejects(
    () => runInferJson(failing, { prompt: 'x', schema: { name: 's', schema: {} } }, { language: 'zh-CN', model: 'm' }),
    (error: unknown) => error instanceof BrainError && error.code === 'PROVIDER_FAILED',
  );

  // Anything else — a raw `TypeError('fetch failed')` from the transport — must not leak across the
  // seam as itself; the adapter labels it `TRANSPORT_FAILED` (`toBrainError` in `mimo.ts`).
  const broken = {
    async chatJson(): Promise<never> {
      throw new TypeError('fetch failed');
    },
  };
  await assert.rejects(
    () => runInferJson(broken, { prompt: 'x', schema: { name: 's', schema: {} } }, { language: 'zh-CN', model: 'm' }),
    (error: unknown) => error instanceof BrainError && error.code === 'TRANSPORT_FAILED',
  );
});

// ------------------------------------------------------------------- small seam helpers stay put

test('the turn-seam helpers the engine relies on are unchanged', async () => {
  assert.equal(isSilenceReply('[静默]'), true);
  assert.equal(isSilenceReply('好'), false);
  const provider = new FakeBrainAdapter();
  const turn = await collectTurn(await provider.handleUserTurn(turnInput()));
  assert.equal(turn.result.provider, 'fake');
  assert.equal(turn.result.action, 'SPEAK');
});
