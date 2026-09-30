import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationStateMachine, DEFAULT_FSM_CONFIG } from '@xixi/conversation';

const T0 = 1_700_000_000_000;

test('IDLE only accepts a turn when it was addressed (§13)', () => {
  const fsm = new ConversationStateMachine({}, T0);
  assert.equal(fsm.state, 'IDLE');
  const ignored = fsm.shouldAcceptTurn({ addressed: false, at: T0 });
  assert.equal(ignored.accept, false);
  assert.equal(ignored.reason, 'REJECTED_NOT_ADDRESSED');

  const accepted = fsm.shouldAcceptTurn({ addressed: true, at: T0 });
  assert.equal(accepted.accept, true);
  assert.equal(accepted.reason, 'ACCEPTED_WAKE_OR_DIRECT');
});

test('an open session accepts continuations without a wake word, then lingers and times out', () => {
  const fsm = new ConversationStateMachine({ lingerMs: 30_000, silenceTolerance: 0.5 }, T0);
  fsm.addressed(T0);
  assert.equal(fsm.state, 'ENGAGING');
  fsm.onUserTurn(T0 + 100);
  assert.equal(fsm.state, 'ACTIVE');

  const continuation = fsm.shouldAcceptTurn({ addressed: false, at: T0 + 2_000 });
  assert.equal(continuation.accept, true);
  assert.equal(continuation.reason, 'ACCEPTED_CONTINUATION');

  fsm.onReplyCompleted(T0 + 3_000);
  assert.equal(fsm.state, 'LINGERING');
  // silenceTolerance 0.5 → window = 30s × (0.5 + 0.5) = 30s
  fsm.tick(T0 + 3_000 + 29_000);
  assert.equal(fsm.state, 'LINGERING', 'the window must not close early');
  fsm.tick(T0 + 3_000 + 30_001);
  assert.equal(fsm.state, 'IDLE');
});

test('silence tolerance scales the follow-up window instead of inventing a second constant', () => {
  const patient = new ConversationStateMachine({ lingerMs: 30_000, silenceTolerance: 1 }, T0);
  const impatient = new ConversationStateMachine({ lingerMs: 30_000, silenceTolerance: 0 }, T0);
  assert.equal(impatient.lingerMs, 15_000);
  assert.ok(patient.lingerMs > DEFAULT_FSM_CONFIG.lingerMs);
});

test('ENGAGING gives up if nobody actually speaks', () => {
  const fsm = new ConversationStateMachine({ engageTimeoutMs: 1_000 }, T0);
  fsm.addressed(T0);
  assert.equal(fsm.state, 'ENGAGING');
  fsm.tick(T0 + 999);
  assert.equal(fsm.state, 'ENGAGING');
  fsm.tick(T0 + 1_001);
  assert.equal(fsm.state, 'IDLE');
});

test('quiet mode refuses turns until it expires or is lifted', () => {
  const fsm = new ConversationStateMachine({}, T0);
  fsm.suspend(T0 + 60_000, T0);
  const blocked = fsm.shouldAcceptTurn({ addressed: true, at: T0 + 1_000 });
  assert.equal(blocked.accept, false);
  assert.equal(blocked.reason, 'REJECTED_SUSPENDED');

  fsm.tick(T0 + 60_001);
  assert.equal(fsm.state, 'IDLE');
  assert.equal(fsm.shouldAcceptTurn({ addressed: true, at: T0 + 60_002 }).accept, true);
});

test('quiet mode with no expiry only ends on resume', () => {
  const fsm = new ConversationStateMachine({}, T0);
  fsm.suspend(null, T0);
  fsm.tick(T0 + 10 * 60_000);
  assert.equal(fsm.state, 'SUSPENDED');
  fsm.resume(T0 + 10 * 60_001);
  assert.equal(fsm.state, 'IDLE');
});

test('the snapshot is enough to reconstruct why the conversation is where it is', () => {
  const fsm = new ConversationStateMachine({}, T0);
  fsm.addressed(T0);
  fsm.onUserTurn(T0 + 10);
  fsm.onReplyCompleted(T0 + 20);
  const snapshot = fsm.snapshot();
  assert.equal(snapshot.state, 'LINGERING');
  assert.equal(snapshot.turnCount, 1);
  assert.equal(snapshot.lastTurnAt, T0 + 20);
  assert.equal(snapshot.suspendedUntil, null);
});
