import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrainError, FakeBrainAdapter, type BrainAdapter, type BrainTurnStream, type ScriptedOutcome, type UserTurnInput } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { fixedClock, openXixiStore, type Clock, type XixiConfig, type XixiStore } from '@xixi/domain';

/**
 * t88: the still-frame seam must reach the adapter **through the engine**.
 *
 * The brain seam (t87) and the model adapters already accepted `images`, but `respond` threw them
 * away — so the console's 「看一眼」 button would have looked at nothing while claiming otherwise.
 * The reviewer caught that; these tests pin the three properties that matter:
 *
 *   1. an image given to `respond` arrives at the adapter, unchanged;
 *   2. a turn *without* images does not grow an `images` key (the t87 byte-equality guarantee);
 *   3. an adapter that refuses pictures (DSH) makes the turn **fail** instead of answering blind.
 */

const T0 = new Date('2026-09-30T10:00:00+08:00');

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: {
    llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false },
    asr: { provider: 'fake', model: 'fake-asr' },
    tts: { provider: 'fake', model: 'fake-tts' },
  },
  personality: { base: {} },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

const IMAGE = { mediaType: 'image/jpeg' as const, base64: 'ZmFrZS1qcGVn' };

interface Harness {
  readonly store: XixiStore;
  readonly engine: ConversationEngine;
  readonly seen: UserTurnInput[];
}

function harness(options: { readonly rejectImages?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'xixi-engine-images-'));
  const store = openXixiStore({ dbPath: join(root, 'x.sqlite'), clock: fixedClock(new Date(T0), 1_000) });
  const seen: UserTurnInput[] = [];
  const base = new FakeBrainAdapter({
    provider: 'fake',
    model: 'fake-1',
    reply: (input): ScriptedOutcome => {
      seen.push(input);
      return { action: 'SPEAK', text: '画面里有一个白色的信箱。' };
    },
  });
  const adapter: BrainAdapter = options.rejectImages === true
    ? {
        provider: 'dsh-like',
        describe: () => base.describe(),
        handleUserTurn: async (input: UserTurnInput): Promise<BrainTurnStream> => {
          seen.push(input);
          if (input.images !== undefined && input.images.length > 0) {
            // Exactly what `DshBrainAdapter` does (t87): refuse before doing anything, because a
            // silently dropped picture would make the model answer as if it had seen the room.
            throw new BrainError('BAD_REQUEST', 'DSH 路径无法接收图像');
          }
          return await base.handleUserTurn(input);
        },
        evaluateProactiveCandidate: (input) => base.evaluateProactiveCandidate(input),
        interpretFeedback: (input) => base.interpretFeedback(input),
        extractMemories: (input) => base.extractMemories(input),
        reflect: (input) => base.reflect(input),
      }
    : base;
  const engine = new ConversationEngine({
    adapter,
    store,
    config: CONFIG,
    clock: fixedClock(new Date(T0), 1_000) as Clock,
    offsetMinutes: 480,
  });
  return { store, engine, seen };
}

function close(store: XixiStore): void {
  const dir = store.dbPath.slice(0, store.dbPath.lastIndexOf('\\'));
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

test('respond() hands the caller’s still frame to the adapter unchanged (t88)', async () => {
  const { store, engine, seen } = harness();
  try {
    const session = store.createSession();
    const turn = await engine.respond({ sessionId: session.sessionId, text: '看一眼：画面里有什么？', addressed: true, images: [IMAGE] });

    assert.equal(seen.length, 1, 'the adapter was called exactly once');
    assert.deepEqual(seen[0]?.images, [IMAGE], 'and it received exactly the frame the caller passed');
    assert.equal(turn.action, 'SPEAK');
    assert.equal(turn.text, '画面里有一个白色的信箱。');

    // The turn is a normal turn: both rows are in the log (that is why 看一眼 needs no recordTurn
    // of its own — the engine writes them).
    const turns = store.recentTurns(session.sessionId, 5);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.role, 'user');
    assert.equal(turns[0]?.text, '看一眼：画面里有什么？');
    assert.equal(turns[1]?.role, 'assistant');
    assert.equal(turns[1]?.text, '画面里有一个白色的信箱。');
    assert.equal(turns[1]?.action, 'SPEAK');
  } finally {
    close(store);
  }
});

test('a turn without images does not grow an images key (t88)', async () => {
  const { store, engine, seen } = harness();
  try {
    const session = store.createSession();
    await engine.respond({ sessionId: session.sessionId, text: '你好', addressed: true });
    assert.equal(seen.length, 1);
    // `Object.hasOwn` rather than a cast to `Record<string, unknown>`: the question is whether the
    // key is present at run time on an object whose type does not declare it.
    assert.equal(Object.hasOwn(seen[0], 'images'), false, 'the text path is unchanged (t87 pins the payload byte-for-byte)');
  } finally {
    close(store);
  }
});

test('an adapter that refuses pictures fails the turn instead of answering blind (t88)', async () => {
  const { store, engine, seen } = harness({ rejectImages: true });
  try {
    const session = store.createSession();
    await assert.rejects(
      () => engine.respond({ sessionId: session.sessionId, text: '看一眼', addressed: true, images: [IMAGE] }),
      (error: unknown) => {
        assert.ok(error instanceof BrainError);
        assert.match(String((error as Error).message), /无法接收图像/);
        return true;
      },
      'the refusal must reach the caller, because the console has to tell the user it did not look',
    );
    assert.equal(seen.length, 1);

    // The user turn is in the log (the caller asked), but no assistant turn pretends to have seen.
    const turns = store.recentTurns(session.sessionId, 5);
    assert.equal(turns.filter((turn) => turn.role === 'assistant').length, 0);
  } finally {
    close(store);
  }
});
