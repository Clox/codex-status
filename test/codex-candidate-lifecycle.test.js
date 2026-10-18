'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const test = require('node:test');
const { pendingInterruptedTurns } = require('../lib/codex-manual-resume');
const { startTurn, turnKey } = require('../lib/codex-turn-observer');
const { missingSince, retirementEligible, retireUnavailable, reactivateRetired,
  MIN_CANDIDATE_AGE_MS, MIN_CONTINUOUS_MISSING_MS } = require('../lib/codex-candidate-lifecycle');

const NOW = 1_800_000_000_000;
const candidate = { threadId: 'thread-a', turnId: 'turn-a', accountId: 'account-a',
  completedAtMs: NOW - MIN_CANDIDATE_AGE_MS - 1, resumable: true,
  threadIdentityVerified: true, classificationVerified: true };
const key = turnKey(candidate.threadId, candidate.turnId);

function context(overrides = {}) {
  return { candidate, block: { threadId: candidate.threadId, failedTurnId: candidate.turnId,
    reason: 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME',
    continuousMissingSinceMs: NOW - MIN_CONTINUOUS_MISSING_MS,
    lastSeenAtMs: NOW }, eventState: { activeTurns: {}, terminalTurns: [],
    interruptedTurns: { [key]: candidate } },
  resumeState: { attempts: {}, retiredCandidates: {} }, draftJournal: { claims: {} },
  autoState: { status: 'waiting', errorKind: null }, storage: { ok: false, reason: 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME',
    threadId: candidate.threadId, failedTurnId: candidate.turnId },
  observerHealthy: true, nowMs: NOW, ...overrides };
}

test('14 days old and seven continuous days of verified missing rollout retires once', () => {
  const input = context();
  assert.equal(retirementEligible(input), true);
  const journal = retireUnavailable(input.resumeState, candidate, input.block, NOW);
  assert.equal(journal.retiredCandidates[key].status, 'retired-unavailable');
  assert.equal(pendingInterruptedTurns(input.eventState, journal).length, 0);
  assert.equal(journal.retirementHistory.length, 1);
  assert.equal(journal.retirementHistory[0].reason, 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME');
  assert.deepEqual(retireUnavailable(journal, candidate, input.block, NOW), journal);
  assert.equal(pendingInterruptedTurns(input.eventState, journal).length, 0);
  assert.throws(() => reactivateRetired(journal, candidate, input.eventState,
    input.draftJournal, input.storage), /CANDIDATE_REACTIVATION_UNVERIFIED/);
  const restored = reactivateRetired(journal, candidate, input.eventState,
    input.draftJournal, { ok: true });
  assert.equal(pendingInterruptedTurns(input.eventState, restored).length, 1);
});

test('less than seven continuous days missing or less than 14 days old stays active', () => {
  const input = context();
  assert.equal(retirementEligible({ ...input, block: { ...input.block,
    continuousMissingSinceMs: NOW - MIN_CONTINUOUS_MISSING_MS + 1 } }), false);
  assert.equal(retirementEligible({ ...input, candidate: { ...candidate,
    completedAtMs: NOW - MIN_CANDIDATE_AGE_MS + 1 },
  eventState: { ...input.eventState, interruptedTurns: { [key]: { ...candidate,
    completedAtMs: NOW - MIN_CANDIDATE_AGE_MS + 1 } } } }), false);
  assert.equal(missingSince(null, input.block.reason, NOW), NOW);
  assert.equal(missingSince({ reason: input.block.reason, lastSeenAtMs: NOW - 10 * 60_000,
    continuousMissingSinceMs: NOW - MIN_CONTINUOUS_MISSING_MS }, input.block.reason, NOW), NOW);
  assert.equal(missingSince({ reason: input.block.reason, lastSeenAtMs: NOW - 30_000,
    continuousMissingSinceMs: NOW - MIN_CONTINUOUS_MISSING_MS }, input.block.reason, NOW),
  NOW - MIN_CONTINUOUS_MISSING_MS);
});

test('old but verifiable, unreadable, multiple or ambiguous rollout never retires', () => {
  for (const reason of [null, 'ROLLOUT_UNREADABLE', 'MULTIPLE_ROLLOUTS', 'ROLLOUT_SEARCH_FAILED']) {
    const input = context({ storage: reason ? { ok: false, reason } : { ok: true } });
    assert.equal(retirementEligible(input), false, String(reason));
  }
  assert.equal(retirementEligible(context({ observerHealthy: false })), false);
  assert.equal(retirementEligible(context({ resumeState: { attempts: { [key]: { status: 'failed' } } } })), false);
  assert.equal(retirementEligible(context({ draftJournal: { claims: { [key]: { owner: 'manual-draft' } } } })), false);
});

test('later real turn resolves before retirement and cannot become retired', () => {
  const input = context();
  const observed = startTurn(input.eventState, { threadId: candidate.threadId, turnId: 'later',
    accountId: 'account-b', startedAtMs: NOW - 1000, observedAtMs: NOW });
  assert.equal(observed.interruptedTurns[key], undefined);
  assert.equal(retirementEligible({ ...input, eventState: observed }), false);
});

test('retirement diagnostics are bounded while exact tombstones remain authoritative', () => {
  let journal = { attempts: {}, retiredCandidates: {}, retirementHistory: [] };
  for (let index = 0; index < 70; index += 1) {
    const item = { ...candidate, threadId: `thread-${index}` };
    journal = retireUnavailable(journal, item,
      { continuousMissingSinceMs: NOW - MIN_CONTINUOUS_MISSING_MS }, NOW + index);
  }
  assert.equal(journal.retirementHistory.length, 64);
  assert.equal(Object.keys(journal.retiredCandidates).length, 70);
  assert.ok(journal.retiredCandidates['["thread-0","turn-a"]']);
});
