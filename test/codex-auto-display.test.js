'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { autoDisplayPlan } = require('../lib/codex-auto-display');
const { autoContinueStatusLine } = require('../lib/codex-auto-continue');

const candidate = { threadId: 'thread-a', turnId: 'turn-failed', accountId: 'source' };
const later = { threadId: 'thread-b', turnId: 'turn-later', accountId: 'source' };

test('interrupted candidate moves to preparing then committed/running without duplicate active row', () => {
  const waiting = autoDisplayPlan({}, {}, {}, [candidate, later], [], 'HEADLESS');
  assert.equal(waiting.operation, null);
  assert.deepEqual(waiting.interrupted, [candidate, later]);
  const auto = { status: 'running', phase: 'switching auth', candidateThreadId: candidate.threadId,
    candidateTurnId: candidate.turnId, sourceAccountId: 'source', targetAccountId: 'target' };
  const preparing = autoDisplayPlan(auto, {}, {}, [candidate, later], [], 'HEADLESS');
  assert.equal(preparing.operation.phase, 'switching auth');
  assert.equal(preparing.operation.sourceAccountId, 'source');
  assert.equal(preparing.operation.targetAccountId, 'target');
  assert.deepEqual(preparing.interrupted, [later]);
  const journal = { attempts: { one: { threadId: candidate.threadId,
    interruptedTurnId: candidate.turnId, accountId: 'source', targetAccountId: 'target',
    committedAtMs: 123, status: 'RESUME_COMMITTED', automatic: true } } };
  const committed = autoDisplayPlan(auto, journal, {}, [later], [], 'HEADLESS');
  assert.equal(committed.operation.phase, 'starting continuation');
  const running = autoDisplayPlan({ status: 'waiting', waitingReason: 'resume-already-running' },
    journal, {}, [later], [{ threadId: candidate.threadId }, { threadId: 'other' }], 'HEADLESS');
  assert.equal(running.operation.phase, 'running');
  assert.deepEqual(running.activeTurns.map(turn => turn.threadId), ['other']);
  assert.deepEqual(running.interrupted, [later]);
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' },
    { status: 'waiting', waitingReason: 'resume-already-running' }, 1,
    { operation: running.operation }), 'AUTO: HEADLESS · RUNNING');
  journal.attempts.one.status = 'COMPLETED';
  journal.attempts.one.continuationTurnId = 'turn-resumed';
  const completed = autoDisplayPlan({ status: 'completed' }, journal, {}, [later],
    [{ threadId: candidate.threadId, turnId: 'turn-resumed' }], 'HEADLESS');
  assert.equal(completed.operation, null);
  assert.deepEqual(completed.activeTurns, []);
  assert.deepEqual(completed.interrupted, [later]);
  const laterOrdinaryTurn = autoDisplayPlan({ status: 'waiting', waitingReason: 'active-turns' },
    journal, {}, [later], [{ threadId: candidate.threadId, turnId: 'later-ordinary-turn' }],
    'HEADLESS');
  assert.deepEqual(laterOrdinaryTurn.activeTurns.map(turn => turn.turnId), ['later-ordinary-turn']);
});

test('manual committed attempt is not mislabeled as AUTO continuation', () => {
  const journal = { attempts: { one: { threadId: candidate.threadId,
    interruptedTurnId: candidate.turnId, committedAtMs: 123,
    status: 'RESUME_COMMITTED', automatic: false } } };
  assert.equal(autoDisplayPlan({ status: 'idle' }, journal, {}, [], [], 'HEADLESS').operation, null);
});

test('AUTO-owned exact turn stays in continuation across lagging observer refreshes', () => {
  const auto = { status: 'running', phase: 'preparing', candidateThreadId: candidate.threadId,
    candidateTurnId: candidate.turnId, sourceAccountId: 'source', targetAccountId: 'target' };
  const event = { interruptedTurns: { stale: candidate } };
  for (const pending of [[candidate, later], [later], [candidate, later]]) {
    const frame = autoDisplayPlan(auto, {}, event, pending, [], 'HEADLESS');
    assert.equal(frame.operation.threadId, candidate.threadId);
    assert.equal(frame.operation.failedTurnId, candidate.turnId);
    assert.equal(frame.operation.phase, 'preparing');
    assert.deepEqual(frame.interrupted, [later]);
  }
  const abandoned = autoDisplayPlan({ ...auto, status: 'waiting', waitingReason: 'plan-changed' },
    {}, event, [candidate, later], [], 'HEADLESS');
  assert.equal(abandoned.operation, null);
  assert.deepEqual(abandoned.interrupted, [candidate, later]);
});

test('queued candidate becomes the only running continuation after the prior turn is terminal', () => {
  const third = { threadId: 'thread-c', turnId: 'turn-third', accountId: 'source' };
  const journal = { attempts: {
    first: { threadId: candidate.threadId, interruptedTurnId: candidate.turnId,
      continuationTurnId: 'continued-a', status: 'COMPLETED', automatic: true },
    second: { threadId: later.threadId, interruptedTurnId: later.turnId,
      targetAccountId: 'target-b', committedAtMs: 200, status: 'RESUME_COMMITTED', automatic: true },
  } };
  const displayed = autoDisplayPlan({ status: 'running', phase: 'running',
    candidateThreadId: later.threadId, candidateTurnId: later.turnId }, journal, {},
  [later, third], [{ threadId: later.threadId, turnId: 'continued-b' }], 'HEADLESS');
  assert.equal(displayed.operation.threadId, later.threadId);
  assert.equal(displayed.operation.phase, 'running');
  assert.deepEqual(displayed.interrupted, [third]);
  assert.deepEqual(displayed.activeTurns, []);
});

test('countdown derives seconds from local deadline without usage data', () => {
  const state = { status: 'pending', pending: { fingerprint: 'plan', deadlineAtMs: 20_000 } };
  assert.match(autoContinueStatusLine({ autoMode: 'HEADLESS' }, state, 10_000), /om 10s/);
  assert.match(autoContinueStatusLine({ autoMode: 'HEADLESS' }, state, 11_001), /om 9s/);
});
