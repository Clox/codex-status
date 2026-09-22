'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  candidateKey,
  emptyResumeState,
  markResumeCommitted,
  markResumeFailure,
  markResumeTerminal,
  pendingInterruptedTurns,
  validateThreadForResume,
} = require('../lib/codex-manual-resume');

const candidate = {
  threadId: 'thread-a', turnId: 'turn-failed', accountId: 'account-a',
  status: 'failed', errorKind: 'usagelimitexceeded', resumable: true,
  threadIdentityVerified: true, completedAtMs: 100,
};

function thread(turns = [{
  id: 'turn-failed', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' }, items: [],
}]) {
  return { id: 'thread-a', status: { type: 'idle' }, turns };
}

test('only verified main-thread candidates without a commit are listed', () => {
  const eventState = { interruptedTurns: {
    [candidateKey(candidate.threadId, candidate.turnId)]: candidate,
    child: { ...candidate, threadId: 'child', parentThreadId: 'thread-a' },
  } };
  assert.deepEqual(pendingInterruptedTurns(eventState).map(item => item.threadId), ['thread-a']);
  const committed = markResumeCommitted(emptyResumeState(), candidate, { targetAccountId: 'account-b' }, 200);
  assert.deepEqual(pendingInterruptedTurns(eventState, committed), []);
});

test('resume revalidation requires idle exact thread and latest verified failed turn', () => {
  const eventState = { activeTurns: {} };
  assert.equal(validateThreadForResume({ candidate, thread: thread(), eventState, resumeState: emptyResumeState() }), true);
  assert.throws(() => validateThreadForResume({
    candidate, thread: thread([...thread().turns, { id: 'later', status: 'completed', items: [] }]),
    eventState, resumeState: emptyResumeState(),
  }), /CANDIDATE_NOT_LATEST_TURN/);
  assert.throws(() => validateThreadForResume({
    candidate, thread: { ...thread(), status: { type: 'active', activeFlags: [] } },
    eventState, resumeState: emptyResumeState(),
  }), /THREAD_NOT_IDLE/);
});

test('commit is crash-safe idempotency boundary and can never be committed twice', () => {
  const committed = markResumeCommitted(emptyResumeState(), candidate, { targetAccountId: 'account-b' }, 200);
  assert.equal(committed.attempts[candidateKey('thread-a', 'turn-failed')].status, 'RESUME_COMMITTED');
  assert.throws(() => markResumeCommitted(committed, candidate), /RESUME_ALREADY_COMMITTED/);
  const failed = markResumeFailure(committed, candidate, 'OUTCOME_UNKNOWN', { committed: true }, 300);
  assert.equal(failed.attempts[candidateKey('thread-a', 'turn-failed')].status, 'MANUAL_REQUIRED_AFTER_COMMIT');
  assert.throws(() => validateThreadForResume({ candidate, thread: thread(), eventState: { activeTurns: {} }, resumeState: failed }), /RESUME_ALREADY_COMMITTED/);
});

test('terminal result is recorded against the one committed continuation', () => {
  const committed = markResumeCommitted(emptyResumeState(), candidate, { targetAccountId: 'account-b' }, 200);
  const terminal = markResumeTerminal(committed, candidate, { turnId: 'turn-next', status: 'completed' }, 400);
  const attempt = terminal.attempts[candidateKey('thread-a', 'turn-failed')];
  assert.equal(attempt.continuationTurnId, 'turn-next');
  assert.equal(attempt.status, 'COMPLETED');
});
