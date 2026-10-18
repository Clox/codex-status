'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  headlessStoragePreflight,
  acquireHeadlessClientsAfterStoragePreflight,
} = require('../lib/codex-headless-storage-preflight');
const {
  autoContinueStatusLine,
  autoContinueProblemLine,
  autoContinueProblemLines,
  autoPlanFingerprint,
  automationDecision,
  beginExclusivityAttempt,
  cancelPendingAction,
  createOrResumePending,
  hasMatchingExclusivityBlock,
  unresolvedExclusivityBlockerPresent,
  isAutoPlanSuppressed,
  normalizeAutoContinueState,
  pendingAttentionDecision,
  pendingCountdownDecision,
  partitionHeadlessCandidates,
  partitionAutomaticCandidates,
  automaticCandidateEligibility,
  headlessDiagnosticCandidates,
  recordExclusivityBlock,
  clearExclusivityBlock,
  resolveDesktopRestoreFailure,
  archiveDesktopNavigation,
  archiveTerminalDesktopNavigation,
  recordPrecommitPlanChange,
  waitForResumeOperationLock,
  adoptAutomaticPlan,
  shouldReplanAutomaticError,
  armAutomaticAttemptRetryHalt,
  reconcileFailedAutomaticAttempt,
  restoreFailureBlocksAuto,
  reconcileSuppression,
  requiresPendingCountdown,
  resetAutoContinueForToggle,
  sameHeadlessDecisionPlan,
  writeAutoContinueStateFile,
} = require('../lib/codex-auto-continue');
const {
  automaticClientBlocker,
  markResumeCommitted,
} = require('../lib/codex-manual-resume');
const {
  INTERRUPTION_CLASS,
  continuationForCandidate,
  inputHash,
} = require('../lib/codex-turn-continuation');

const NOW = 1_790_200_000_000;
const selectors = ['a@example.com', 'b@example.com', 'c@example.com'];

function registry(active = 'key-a') {
  return {
    active_account_key: active,
    accounts: selectors.map((email, index) => ({
      account_key: `key-${String.fromCharCode(97 + index)}`,
      chatgpt_account_id: `account-${String.fromCharCode(97 + index)}`,
      email,
    })),
  };
}

function usage(primary, secondary, overrides = {}) {
  return {
    primary: { remainingPercent: primary, resetsAt: (NOW + 2 * 3_600_000) / 1000 },
    secondary: { remainingPercent: secondary, resetsAt: (NOW + 24 * 3_600_000) / 1000 },
    ordinaryUsageAllowedObserved: true,
    ordinaryUsageAllowed: primary > 0 && secondary > 0,
    refresh: {
      lastSuccessAt: NOW,
      lastAttemptAt: NOW,
      errorKind: null,
      consecutiveFailures: 0,
    },
    ...overrides,
  };
}

function usageCache(overrides = {}) {
  return {
    worker: { heartbeatAtMs: NOW, fatalErrorKind: null },
    accounts: {
      'account-a': usage(0, 40),
      'account-b': usage(70, 80),
      'account-c': usage(60, 30),
      ...overrides,
    },
  };
}

function eventState(overrides = {}) {
  return {
    worker: { heartbeatAtMs: NOW, errorKind: null },
    activeTurns: {},
    interruptedTurns: {
      first: {
        threadId: 'thread-first', turnId: 'turn-first', accountId: 'account-a',
        completedAtMs: NOW - 2_000, resumable: true, threadIdentityVerified: true,
        interruptionClass: INTERRUPTION_CLASS.AFTER_WORK, classificationVerified: true,
      },
      second: {
        threadId: 'thread-second', turnId: 'turn-second', accountId: 'account-a',
        completedAtMs: NOW - 1_000, resumable: true, threadIdentityVerified: true,
        interruptionClass: INTERRUPTION_CLASS.AFTER_WORK, classificationVerified: true,
      },
    },
    exhaustions: {
      'account-a': { verified: true, threadIdentityVerified: true, errorKind: 'usageLimitExceeded' },
    },
    ...overrides,
  };
}

function decide(overrides = {}) {
  return automationDecision({
    preferences: { version: 1, autoContinue: true },
    registry: registry(),
    globalAuth: { tokens: { account_id: 'account-a' } },
    usageCache: usageCache(),
    eventState: eventState(),
    resumeState: {},
    selectors,
    nowMs: NOW,
    ...overrides,
  });
}

test('HEADLESS missing active-home rollout blocks before Desktop quiesce or restore', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-headless-storage-'));
  try {
    const decision = decide();
    assert.equal(decision.action, 'resume');
    assert.equal(decision.candidates[0].resumable, true);
    assert.equal(decision.candidates[0].classificationVerified, true);
    // The observer journal still has both candidates, but the active home has
    // neither a thread row nor a rollout for either one.
    let quiesces = 0;
    const storage = await headlessStoragePreflight(home, decision.candidates);
    assert.deepEqual(storage, { ok: false, threadId: 'thread-first',
      failedTurnId: 'turn-first', reason: 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME' });
    await assert.rejects(acquireHeadlessClientsAfterStoragePreflight(home, decision.candidates,
      () => { quiesces += 1; return { desktopRestore: true }; }), error =>
      error.message === 'CANDIDATE_UNAVAILABLE_IN_ACTIVE_CODEX_HOME' &&
      error.diagnostics.threadId === 'thread-first' &&
      error.diagnostics.failedTurnId === 'turn-first');
    assert.equal(quiesces, 0);
    const halted = armAutomaticAttemptRetryHalt({ status: 'blocked', actionRequired: true,
      errorKind: 'CANDIDATE_UNAVAILABLE_IN_ACTIVE_CODEX_HOME',
      candidateThreadId: storage.threadId, candidateTurnId: storage.failedTurnId }, decision);
    assert.equal(restoreFailureBlocksAuto(halted, decision), true);
    assert.equal(decision.candidates.length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('HEADLESS partitions unavailable and eligible exact candidates', async () => {
  const stale = { ...eventState().interruptedTurns.first };
  const healthy = { ...eventState().interruptedTurns.second };
  const decision = { action: 'resume', strategy: 'HEADLESS', candidates: [stale, healthy] };
  const observed = eventState({ interruptedTurns: {
    [JSON.stringify([stale.threadId, stale.turnId])]: stale,
    [JSON.stringify([healthy.threadId, healthy.turnId])]: healthy,
  } });
  const inspect = async item => automaticCandidateEligibility(item, observed,
    item.threadId === stale.threadId
      ? { ok: false, reason: 'ROLLOUT_METADATA_UNVERIFIED' } : { ok: true });
  const result = await partitionAutomaticCandidates(decision, inspect);
  assert.deepEqual(result.plan.candidates, [healthy]);
  assert.deepEqual(result.blocked, [stale]);
  assert.equal(result.candidateBlocks[JSON.stringify([stale.threadId, stale.turnId])].actionRequired, false);
  delete observed.exhaustions['account-a'];
  assert.deepEqual(automaticCandidateEligibility(healthy, observed, { ok: true }),
    { ok: false, reason: 'SOURCE_EXHAUSTION_CHANGED', actionRequired: false });
  assert.deepEqual(autoContinueProblemLines({ status: 'waiting', candidateBlocks: {
    [JSON.stringify([healthy.threadId, healthy.turnId])]: {
      threadId: healthy.threadId, failedTurnId: healthy.turnId,
      reason: 'SOURCE_EXHAUSTION_CHANGED', actionRequired: false,
    },
  } }, true), []);
  assert.deepEqual(automaticCandidateEligibility({ ...healthy, turnId: 'other-turn' }, observed,
    { ok: true }), { ok: false, reason: 'CANDIDATE_NO_LONGER_RESUMABLE', actionRequired: false });
  assert.equal(shouldReplanAutomaticError(new Error('SOURCE_EXHAUSTION_CHANGED'), false), true);
  assert.equal(shouldReplanAutomaticError(new Error('SOURCE_EXHAUSTION_CHANGED'), true), false);
});

test('HEADLESS storage preflight checks every exact candidate and failed turn', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-headless-storage-'));
  try {
    const directory = path.join(home, 'sessions', '2026', '10', '06');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'rollout-2026-10-06T09-00-00-thread-first.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-first' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-first' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-first',
        error: { codexErrorInfo: 'usageLimitExceeded' } } }),
    ].join('\n') + '\n');
    const candidates = decide().candidates;
    assert.deepEqual(await headlessStoragePreflight(home, candidates), {
      ok: false, threadId: 'thread-second', failedTurnId: 'turn-second',
      reason: 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME',
    });
    assert.deepEqual(await headlessStoragePreflight(home, [{ ...candidates[0], turnId: 'other-turn' }]), {
      ok: false, threadId: 'thread-first', failedTurnId: 'other-turn', reason: 'FAILED_TURN_NOT_FOUND',
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('missing oldest rollout is reported locally while the next candidate reaches the exact commit boundary', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-headless-queue-'));
  try {
    const directory = path.join(home, 'sessions', '2026', '10', '06');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'rollout-2026-10-06T09-00-00-thread-second.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-second' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-second' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-second',
        error: { codexErrorInfo: 'usageLimitExceeded' } } }),
    ].join('\n') + '\n');
    const full = decide();
    const inspect = candidate => headlessStoragePreflight(home, [candidate]);
    const selected = await partitionHeadlessCandidates(full, inspect, {}, NOW);
    assert.deepEqual(selected.blocked.map(candidate => candidate.threadId), ['thread-first']);
    assert.deepEqual(selected.plan.candidates.map(candidate => candidate.threadId), ['thread-second']);
    assert.equal(selected.candidateBlocks['["thread-first","turn-first"]'].reason,
      'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME');
    assert.equal(selected.candidateBlocks['["thread-first","turn-first"]'].actionRequired, false);
    assert.deepEqual(autoContinueProblemLines({ candidateBlocks: selected.candidateBlocks }, true), []);
    assert.equal(sameHeadlessDecisionPlan(selected.plan, decide(), selected.blocked), true);
    assert.deepEqual(await headlessStoragePreflight(home, selected.plan.candidates), { ok: true });
    const oldFailedAttempt = { status: 'blocked', actionRequired: true,
      errorKind: 'APP_SERVER_REQUEST_FAILED', desktopRestore: { status: 'ready' },
      candidateThreadId: 'thread-first', candidateTurnId: 'turn-first',
      targetAccountId: 'account-b' };
    assert.equal(reconcileFailedAutomaticAttempt(oldFailedAttempt, selected.plan).restoreRetryHalt,
      false);

    const second = selected.plan.candidates[0];
    const journal = markResumeCommitted({}, second, {
      targetAccountId: 'account-b', continuation: continuationForCandidate(second),
    }, NOW + 1);
    assert.equal(journal.attempts['["thread-second","turn-second"]'].status, 'RESUME_COMMITTED');
    assert.throws(() => markResumeCommitted(journal, second, {
      targetAccountId: 'account-b', continuation: continuationForCandidate(second),
    }, NOW + 2), /RESUME_ALREADY_COMMITTED/);
    const retry = decide({ resumeState: journal });
    assert.deepEqual(retry.candidates.map(candidate => candidate.threadId), ['thread-first']);
    assert.equal(sameHeadlessDecisionPlan({ ...selected.plan, candidates: [] }, retry,
      selected.blocked), true);
    const restarted = await partitionHeadlessCandidates(retry, inspect, selected.candidateBlocks, NOW + 3);
    assert.deepEqual(restarted.plan.candidates, []);
    assert.equal(restarted.candidateBlocks['["thread-first","turn-first"]'].firstSeenAtMs, NOW);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isolated missing rollout is informational while a genuine global blocker remains visible', () => {
  const missing = { '["thread-first","turn-first"]': {
    threadId: 'thread-first', failedTurnId: 'turn-first',
    reason: 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME', actionRequired: false,
  } };
  assert.deepEqual(autoContinueProblemLines({ status: 'blocked', candidateBlocks: missing }, true), []);
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' },
    { status: 'blocked', candidateBlocks: missing }, NOW),
  'AUTO: HEADLESS · WAIT: unavailable-candidates');
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' },
    { status: 'waiting', waitingReason: 'active-turns', candidateBlocks: missing }, NOW),
  'AUTO: HEADLESS · WAIT: active-turns');
  const global = { status: 'blocked', candidateBlocks: missing,
    actionRequired: true, errorKind: 'MANUAL_DRAFT_JOURNAL_UNVERIFIED' };
  assert.deepEqual(autoContinueProblemLines(global, true), [
    'AUTO-CONTINUE BLOCKED / ACTION REQUIRED: MANUAL_DRAFT_JOURNAL_UNVERIFIED',
  ]);
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' }, global, NOW),
    'AUTO: HEADLESS · BLOCKED');
});

test('candidate-local unverified rollout metadata remains unavailable without global action', async () => {
  const candidate = { threadId: 'thread-first', turnId: 'turn-first' };
  const healthy = { threadId: 'thread-second', turnId: 'turn-second' };
  const partition = await partitionHeadlessCandidates({ action: 'resume', candidates: [candidate, healthy] },
    async item => item === candidate ? { ok: false, reason: 'ROLLOUT_METADATA_UNVERIFIED' } : { ok: true },
    {}, NOW);
  assert.deepEqual(partition.plan.candidates, [healthy]);
  assert.equal(partition.candidateBlocks['["thread-first","turn-first"]'].actionRequired, false);
  const local = { status: 'blocked', candidateBlocks: partition.candidateBlocks };
  assert.deepEqual(autoContinueProblemLines(local, true), []);
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' }, local, NOW),
    'AUTO: HEADLESS · WAIT: unavailable-candidates');
  assert.deepEqual(autoContinueProblemLines({ ...local, status: 'waiting',
    waitingReason: 'active-turns' }, true), []);
  const dangerous = { ...local, actionRequired: true, errorKind: 'MANUAL_DRAFT_JOURNAL_UNVERIFIED' };
  assert.match(autoContinueProblemLines(dangerous, true)[0], /ACTION REQUIRED/);
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' }, dangerous, NOW),
    'AUTO: HEADLESS · BLOCKED');
  const explicit = { status: 'blocked', candidateBlocks: {
    '["thread-first","turn-first"]': { ...partition.candidateBlocks['["thread-first","turn-first"]'],
      blocksAutomation: true, requiredAction: 'repair ambiguous rollout ownership' },
  } };
  assert.match(autoContinueProblemLines(explicit, true)[0], /ACTION REQUIRED/);
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' }, explicit, NOW),
    'AUTO: HEADLESS · BLOCKED');
});

test('active-turn waiting reason remains visible in AUTO status', () => {
  const observed = eventState({ activeTurns: { running: { threadId: 'other' } } });
  const waiting = decide({ eventState: observed });
  assert.equal(waiting.reason, 'active-turns');
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' }, {
    status: waiting.action, waitingReason: waiting.reason,
  }, NOW), 'AUTO: HEADLESS · WAIT: active-turns');
  const candidates = headlessDiagnosticCandidates(observed, {}, { version: 1, claims: {} });
  assert.deepEqual(candidates.map(candidate => candidate.threadId), ['thread-first', 'thread-second']);
  const claimed = headlessDiagnosticCandidates(observed, {}, { version: 1, claims: {
    '["thread-first","turn-first"]': { owner: 'manual-draft' },
  } });
  assert.deepEqual(claimed.map(candidate => candidate.threadId), ['thread-second']);
  assert.deepEqual(headlessDiagnosticCandidates(observed, {}, { unverified: true }), []);
});

test('OFF never acts even when an older resumable candidate exists', () => {
  assert.deepEqual(decide({ preferences: { version: 1, autoContinue: false } }), {
    action: 'disabled', reason: 'auto-off', strategy: 'OFF',
  });
});

test('ON picks up candidates created before the toggle and orders multiple candidates deterministically', () => {
  const decision = decide();
  assert.equal(decision.action, 'resume');
  assert.equal(decision.target.accountId, 'account-b');
  assert.deepEqual(decision.candidates.map(candidate => candidate.threadId), [
    'thread-first', 'thread-second',
  ]);
});

test('ON waits with no error while all verified accounts are quota-unusable, then becomes ready after recovery', () => {
  const exhausted = eventState({
    exhaustions: {
      'account-a': { verified: true, threadIdentityVerified: true, errorKind: 'usageLimitExceeded' },
      'account-b': { verified: true, threadIdentityVerified: true, errorKind: 'usageLimitExceeded' },
      'account-c': { verified: true, threadIdentityVerified: true, errorKind: 'usageLimitExceeded' },
    },
  });
  const waiting = decide({
    eventState: exhausted,
    usageCache: usageCache({
      'account-b': usage(0, 80),
      'account-c': usage(0, 30),
    }),
  });
  assert.equal(waiting.action, 'waiting');
  assert.equal(waiting.reason, 'no-usable-target');
  assert.equal(waiting.actionRequired, undefined);

  const recoveredState = eventState();
  const ready = decide({ eventState: recoveredState });
  assert.equal(ready.action, 'resume');
  assert.equal(ready.target.accountId, 'account-b');
});

test('banked reset metadata has no effect and is never part of an automation decision', () => {
  const baseline = decide();
  const withCredits = decide({
    usageCache: { ...usageCache(), rate_limit_reset_credits: { available_count: 99 } },
  });
  assert.deepEqual(withCredits, baseline);
  assert.equal(Object.hasOwn(withCredits, 'resetAction'), false);
});

test('stale usage and stale observer fail closed', () => {
  const staleUsage = usageCache({
    'account-b': usage(70, 80, { refresh: { lastSuccessAt: NOW - 4 * 60_000, lastAttemptAt: NOW, errorKind: null, consecutiveFailures: 0 } }),
    'account-c': usage(60, 30, { refresh: { lastSuccessAt: NOW - 4 * 60_000, lastAttemptAt: NOW, errorKind: null, consecutiveFailures: 0 } }),
  });
  const usageBlocked = decide({ usageCache: staleUsage });
  assert.equal(usageBlocked.action, 'blocked');
  assert.equal(usageBlocked.reason, 'target-usage-unverified');

  const observerBlocked = decide({
    eventState: eventState({ worker: { heartbeatAtMs: NOW - 60_000, errorKind: null } }),
  });
  assert.equal(observerBlocked.action, 'blocked');
  assert.equal(observerBlocked.reason, 'observer-unverified');
});

test('an active or unclassifiable VS Code Codex client is a blocker without a process action', () => {
  const entries = [
    { pid: 10, ppid: 1, args: ['/usr/share/code/code', '--utility-sub-type=node.mojom.NodeService'] },
    { pid: 11, ppid: 10, args: ['/home/u/.vscode/extensions/openai.chatgpt-1/bin/linux-x64/codex', 'app-server'] },
  ];
  assert.deepEqual(automaticClientBlocker(entries), {
    errorKind: 'AUTO_BLOCKED_VSCODE_CODEX_ACTIVE', hosts: [10], servers: [11],
  });
  assert.equal(autoContinueProblemLine({ actionRequired: true, errorKind: 'AUTO_BLOCKED_VSCODE_CODEX_ACTIVE' }, true),
    'AUTO-CONTINUE BLOCKED / ACTION REQUIRED: VS Code Codex är aktivt; automatiken manipulerar inte VS Code.');

  entries[0].args = ['/unknown-host'];
  assert.equal(automaticClientBlocker(entries).errorKind, 'VSCODE_EXTENSION_HOST_UNVERIFIED');
});

test('post-restore Desktop navigation failure is visible without changing continuation state', () => {
  assert.equal(autoContinueProblemLine({
    status: 'completed',
    actionRequired: false,
    errorKind: null,
    desktopNavigation: {
      status: 'failed',
      threadId: 'thread-a',
      errorKind: 'DESKTOP_DEEPLINK_LAUNCH_FAILED',
    },
  }, true),
  'AUTO-CONTINUE / ACTION REQUIRED: continuation completed, but Desktop navigation failed (DESKTOP_DEEPLINK_LAUNCH_FAILED).');
});

test('a changed target before commit is requeued and old plan problems become history', () => {
  const original = decide();
  const changed = decide({ usageCache: usageCache({ 'account-b': usage(0, 0) }) });
  assert.equal(original.action, 'resume');
  assert.equal(changed.action, 'resume');
  assert.notEqual(original.target.accountId, changed.target.accountId);
  const error = new Error('AUTO_PLAN_CHANGED_BEFORE_COMMIT');
  assert.equal(shouldReplanAutomaticError(error, false), true);
  const recorded = recordPrecommitPlanChange({ status: 'blocked', actionRequired: true,
    errorKind: error.message }, error.message, {
    threadId: original.candidates[0].threadId, failedTurnId: original.candidates[0].turnId,
    targetAccountId: original.target.accountId,
  }, NOW);
  assert.deepEqual(autoContinueProblemLines(recorded, true), []);
  const next = adoptAutomaticPlan(recorded, NOW + 1);
  assert.equal(next.status, 'running');
  assert.equal(next.planChangeHistory[0].reason, error.message);
  assert.deepEqual(autoContinueProblemLines(next, true), []);
  assert.equal(changed.candidates[0].turnId, original.candidates[0].turnId);
});

test('changed target after commit never enters replan and committed turn remains exact once', () => {
  const candidate = decide().candidates[0];
  assert.equal(shouldReplanAutomaticError(new Error('AUTO_PLAN_CHANGED_BEFORE_RESUME'), true), false);
  const journal = markResumeCommitted({}, candidate, {
    targetAccountId: 'account-b', continuation: continuationForCandidate(candidate),
  }, NOW);
  assert.throws(() => markResumeCommitted(journal, candidate, {
    targetAccountId: 'account-c', continuation: continuationForCandidate(candidate),
  }, NOW + 1), /RESUME_ALREADY_COMMITTED/);
});

test('candidate list changing before commit replans only the remaining eligible turns', () => {
  const first = decide();
  const changedEvents = eventState();
  delete changedEvents.interruptedTurns.first;
  const next = decide({ eventState: changedEvents });
  assert.equal(shouldReplanAutomaticError(new Error('AUTO_PLAN_CHANGED_BEFORE_RESUME'), false), true);
  assert.deepEqual(next.candidates.map(candidate => candidate.turnId), ['turn-second']);
  assert.notDeepEqual(first.candidates.map(candidate => candidate.turnId),
    next.candidates.map(candidate => candidate.turnId));
});

test('completed navigation failure is archived when the next candidate plan starts', () => {
  const failed = { status: 'completed', errorKind: null, actionRequired: false,
    desktopRestore: { status: 'ready', desktopPid: 4, desktopStartTicks: 5 },
    desktopNavigation: { status: 'failed', threadId: 'thread-first', failedTurnId: 'turn-first',
      errorKind: 'DESKTOP_DEEPLINK_LAUNCH_FAILED' } };
  const next = adoptAutomaticPlan(failed, NOW);
  assert.equal(next.desktopNavigation, null);
  assert.equal(next.desktopNavigationHistory.length, 1);
  assert.equal(next.desktopNavigationHistory[0].threadId, 'thread-first');
  assert.deepEqual(autoContinueProblemLines(next, true), []);
  const restarted = normalizeAutoContinueState(JSON.parse(JSON.stringify(next)));
  assert.equal(restarted.desktopNavigationHistory[0].errorKind, 'DESKTOP_DEEPLINK_LAUNCH_FAILED');
  assert.equal(archiveDesktopNavigation(restarted, NOW + 1).desktopNavigationHistory.length, 1);
});

test('legacy navigation failure is archived only for one verified completed turn', () => {
  const state = { desktopNavigation: { status: 'failed', threadId: 'thread-first',
    errorKind: 'COMPOSER_COUNT_0' } };
  const completed = { attempts: {
    '["thread-first","turn-first"]': { status: 'COMPLETED' },
    '["thread-second","turn-second"]': { status: 'RESUME_COMMITTED' },
  } };
  const archived = archiveTerminalDesktopNavigation(state, completed, NOW);
  assert.equal(archived.desktopNavigation, null);
  assert.equal(archived.desktopNavigationHistory[0].failedTurnId, 'turn-first');
  assert.deepEqual(autoContinueProblemLines(archived, true), []);
  assert.equal(archiveTerminalDesktopNavigation(state, { attempts: {
    '["thread-first","turn-first"]': { status: 'RESUME_COMMITTED' },
  } }, NOW).desktopNavigation.status, 'failed');
  assert.equal(archiveTerminalDesktopNavigation(state, { attempts: {
    '["thread-first","turn-first"]': { status: 'COMPLETED' },
    '["thread-first","turn-second"]': { status: 'COMPLETED' },
  } }, NOW).desktopNavigation.status, 'failed');
});

test('ready Desktop resolves a stale restore latch and its active problem', () => {
  const stale = { status: 'blocked', actionRequired: true,
    errorKind: 'DESKTOP_RESTORE_RETRY_HALTED', restoreRetryHalt: true,
    restoreRetryHaltGeneration: 'old-plan',
    desktopRestore: { status: 'ready', desktopPid: 4, desktopStartTicks: 5 } };
  assert.deepEqual(autoContinueProblemLines(stale, true), []);
  const adopted = adoptAutomaticPlan(stale, NOW);
  assert.equal(adopted.restoreRetryHalt, false);
  assert.equal(adopted.restoreRetryHaltGeneration, null);
  assert.equal(adopted.actionRequired, false);
  assert.deepEqual(autoContinueProblemLines(adopted, true), []);
});

test('temporary pre-commit exclusivity blocking waits and self-heals without action required', () => {
  const diagnostics = {
    phase: 'acquire-app-server-exclusivity',
    failureReason: 'APP_SERVER_EXCLUSIVITY_FAILED',
    blockers: [{ pid: 20, ppid: 2, state: 'S', role: 'desktop-app-server', secret: 'omit' }],
  };
  const first = recordExclusivityBlock({}, diagnostics, {
    threadId: 'thread-first', failedTurnId: 'turn-first', targetAccountId: 'account-b',
  }, NOW);
  assert.equal(first.status, 'waiting');
  assert.equal(first.actionRequired, false);
  assert.equal(first.exclusivityBlock.attempts, 1);
  assert.deepEqual(first.exclusivityBlock.blockers, [
    { pid: 20, ppid: 2, state: 'S', role: 'desktop-app-server' },
  ]);
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' }, first, NOW),
    'AUTO: HEADLESS · WAIT/BLOCKED');
  const recovered = clearExclusivityBlock(first, NOW + 2_000);
  assert.equal(recovered.exclusivityBlock, null);
  assert.equal(recovered.exclusivityHistory.length, 1);
  assert.equal(recovered.exclusivityHistory[0].resolvedAtMs, NOW + 2_000);
});

test('stable exclusivity blocker escalates by actual duration, not retry count', () => {
  const diagnostics = { blockers: [{ pid: 20, ppid: 2, state: 'S', role: 'desktop-app-server' }] };
  let state = {};
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = recordExclusivityBlock(state, diagnostics, {
      threadId: 'thread-first', failedTurnId: 'turn-first', targetAccountId: 'account-b',
    }, NOW + attempt * 1_000);
    assert.equal(state.actionRequired, false);
  }
  state = recordExclusivityBlock(state, diagnostics, {
    threadId: 'thread-first', failedTurnId: 'turn-first', targetAccountId: 'account-b',
  }, NOW + 5 * 60_000);
  assert.equal(state.status, 'blocked');
  assert.equal(state.actionRequired, true);
  assert.equal(state.exclusivityBlock.attempts, 21);

  const manual = recordExclusivityBlock({}, {
    blockers: [{ pid: 30, ppid: 3, state: 'S', role: 'other-app-server' }],
  }, { threadId: 'thread-first' }, NOW);
  assert.equal(manual.actionRequired, true);
});

test('restored Desktop blockers with new process identities do not inherit stuck evidence', () => {
  const context = { threadId: 'thread-first', failedTurnId: 'turn-first', targetAccountId: 'account-b' };
  let state = {};
  for (let pid = 20; pid < 32; pid += 1) {
    state = recordExclusivityBlock(state, {
      blockers: [{ pid, ppid: 2, state: 'S', role: 'desktop-app-server' }],
    }, context, NOW + (pid - 20) * 30_000);
    assert.equal(state.actionRequired, false);
    assert.equal(state.exclusivityBlock.attempts, 1);
  }
  assert.equal(state.exclusivityHistory.length, 11);
  assert.equal(new Set(state.exclusivityHistory.map(entry => entry.fingerprint)).size, 11);
});

test('PID reuse with a new process start identity begins a new blocker observation', () => {
  const context = { threadId: 'thread-first', failedTurnId: 'turn-first', targetAccountId: 'account-b' };
  const first = recordExclusivityBlock({}, {
    blockers: [{ pid: 20, ppid: 2, startTicks: 100, state: 'S', role: 'desktop-app-server' }],
  }, context, NOW);
  const reused = recordExclusivityBlock(first, {
    blockers: [{ pid: 20, ppid: 2, startTicks: 200, state: 'S', role: 'desktop-app-server' }],
  }, context, NOW + 5 * 60_000);
  assert.equal(reused.actionRequired, false);
  assert.equal(reused.exclusivityBlock.attempts, 1);
  assert.equal(reused.exclusivityHistory.length, 1);
});

test('new exclusivity attempt retains WAIT problem until ownership is actually acquired', () => {
  const context = { threadId: 'thread-first', failedTurnId: 'turn-first', targetAccountId: 'account-b' };
  const blocked = recordExclusivityBlock({}, {
    blockers: [{ pid: 20, ppid: 2, state: 'S', role: 'desktop-app-server' }],
  }, context, NOW);
  const retrying = beginExclusivityAttempt(blocked, context, {
    status: 'running', errorKind: null, actionRequired: false, lastAttemptAtMs: NOW + 30_000,
  });
  assert.equal(retrying.status, 'waiting');
  assert.equal(retrying.errorKind, 'APP_SERVER_EXCLUSIVITY_FAILED');
  assert.equal(retrying.actionRequired, false);
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' }, retrying, NOW + 30_000),
    'AUTO: HEADLESS · WAIT/BLOCKED');
  assert.equal(hasMatchingExclusivityBlock(retrying, context), true);
  assert.equal(hasMatchingExclusivityBlock(retrying, { ...context, targetAccountId: 'account-c' }), false);
  assert.match(autoContinueProblemLine({ ...retrying, status: 'waiting', errorKind: null }, true), /APP_SERVER_EXCLUSIVITY_FAILED/);
  assert.equal(unresolvedExclusivityBlockerPresent(retrying, [{ pid: 20, startTicks: 100 }]), false);
});

test('same live blocker suppresses a repeated quiesce and restore cycle', () => {
  const blocked = recordExclusivityBlock({}, { blockers: [
    { pid: 20, ppid: 2, startTicks: 100, state: 'S', role: 'other-app-server' },
  ] }, { threadId: 'thread-a', failedTurnId: 'turn-a', targetAccountId: 'target' }, NOW);
  assert.equal(unresolvedExclusivityBlockerPresent(blocked, [{ pid: 20, startTicks: 100 }]), true);
  assert.equal(unresolvedExclusivityBlockerPresent(blocked, [{ pid: 20, startTicks: 101 }]), false);
  assert.equal(unresolvedExclusivityBlockerPresent(blocked, []), false);
});

test('a prior manual draft claim blocks AUTO ownership transfer for the exact candidate', () => {
  const journal = { version: 1, claims: {
    '["thread-first","turn-first"]': { owner: 'manual-draft', status: 'dispatch-attempted' },
  } };
  assert.deepEqual(decide({ manualDraftJournal: journal }).candidates.map(candidate => candidate.threadId),
    ['thread-second']);
  assert.equal(decide({ manualDraftJournal: { unverified: true } }).reason,
    'MANUAL_DRAFT_JOURNAL_UNVERIFIED');
  const withoutClaimedCandidate = eventState();
  delete withoutClaimedCandidate.interruptedTurns.first;
  assert.equal(decide({ manualDraftJournal: journal, eventState: withoutClaimedCandidate }).action, 'resume');
  const onlyClaimedCandidate = eventState();
  delete onlyClaimedCandidate.interruptedTurns.second;
  assert.deepEqual(decide({ manualDraftJournal: journal, eventState: onlyClaimedCandidate }), {
    action: 'blocked', reason: 'MANUAL_DRAFT_OWNERSHIP_PENDING', actionRequired: true,
    candidateThreadId: 'thread-first', candidateTurnId: 'turn-first',
  });
});

test('unresolved failures survive waiting; successful resolution removes active problems', () => {
  const blocked = recordExclusivityBlock({}, { blockers: [
    { pid: 20, ppid: 2, startTicks: 100, state: 'S', role: 'other-app-server' },
  ] }, { threadId: 'thread-a', failedTurnId: 'turn-a', targetAccountId: 'target' }, NOW);
  const waiting = { ...blocked, status: 'waiting', errorKind: null, actionRequired: false,
    desktopRestore: { status: 'failed', errorKind: 'DESKTOP_RESTORE_FAILED' } };
  assert.equal(autoContinueProblemLines(waiting, true).length, 2);
  const resolved = clearExclusivityBlock({ ...waiting, desktopRestore: { status: 'ready' } }, NOW + 1000);
  assert.deepEqual(autoContinueProblemLines(resolved, true), []);
  assert.equal(resolved.exclusivityHistory.length, 1);
});

test('late verified Desktop root resolves restore failure but retains bounded diagnostics', () => {
  const blocked = recordExclusivityBlock({}, { blockers: [
    { pid: 20, ppid: 2, startTicks: 100, state: 'S', role: 'desktop-app-server' },
  ] }, { threadId: 'thread-a', failedTurnId: 'turn-a', targetAccountId: 'target' }, NOW);
  const failed = { ...blocked, status: 'waiting', errorKind: 'DESKTOP_RESTORE_FAILED',
    desktopRestore: { status: 'failed', errorKind: 'DESKTOP_RESTORE_FAILED',
      completedAtMs: NOW + 1 } };
  assert.equal(autoContinueProblemLines(failed, true).length, 2);
  const restored = resolveDesktopRestoreFailure(failed,
    { pid: 42, startTicks: 12345, cgroup: '/user.slice/codex-desktop-restore-9-1.service' }, NOW + 2);
  assert.equal(restored.desktopRestore.status, 'ready');
  assert.equal(restored.errorKind, null);
  assert.equal(restored.desktopRestoreHistory[0].resolvedAtMs, NOW + 2);
  assert.equal(restored.restoreRetryHalt, false);
  assert.equal(autoContinueProblemLines(restored, true).length, 1);
  const exclusive = clearExclusivityBlock(restored, NOW + 3);
  assert.deepEqual(autoContinueProblemLines(exclusive, true), []);
  assert.equal(exclusive.exclusivityHistory[0].resolvedAtMs, NOW + 3);
});

test('failed restore blocks timer retries until explicit OFF acknowledgement', () => {
  const failed = { status: 'blocked', errorKind: 'DESKTOP_ROOT_AMBIGUOUS', actionRequired: true,
    desktopRestore: { status: 'failed', errorKind: 'DESKTOP_ROOT_AMBIGUOUS' } };
  assert.equal(restoreFailureBlocksAuto(failed), true);
  assert.deepEqual(autoContinueProblemLines(failed, true), [
    'AUTO-CONTINUE BLOCKED / ACTION REQUIRED: DESKTOP_ROOT_AMBIGUOUS',
  ]);
  const waiting = { ...failed, status: 'waiting', errorKind: 'observer-unverified' };
  assert.equal(restoreFailureBlocksAuto(waiting), true);
  const acknowledged = resetAutoContinueForToggle(waiting, 'OFF', NOW);
  assert.equal(restoreFailureBlocksAuto(acknowledged), false);
  assert.equal(acknowledged.desktopRestoreHistory[0].acknowledgedAtMs, NOW);
  assert.deepEqual(autoContinueProblemLines(acknowledged, true), []);
});

test('successful Desktop restore after pre-commit App Server error permits the next safe plan', () => {
  const plan = decide();
  const armed = armAutomaticAttemptRetryHalt({}, plan);
  // Mirrors HEADLESS: a pre-commit App Server request fails, finally restores
  // Desktop successfully, then the next timer activation sees the same plan.
  const failedAttempt = { ...armed, status: 'blocked', errorKind: 'APP_SERVER_REQUEST_FAILED',
    actionRequired: true, candidateThreadId: plan.candidates[0].threadId,
    candidateTurnId: plan.candidates[0].turnId,
    desktopRestore: { status: 'ready', desktopPid: 7001, desktopStartTicks: 9001 } };
  let restoreUnitsStarted = 1;
  let continuationControllersStarted = 1;
  const nextPlan = decide();
  if (!restoreFailureBlocksAuto(failedAttempt, nextPlan)) {
    restoreUnitsStarted += 1;
    continuationControllersStarted += 1;
  }
  assert.equal(failedAttempt.errorKind, 'APP_SERVER_REQUEST_FAILED');
  assert.equal(restoreFailureBlocksAuto(failedAttempt, nextPlan), false);
  assert.equal(restoreUnitsStarted, 2);
  assert.equal(continuationControllersStarted, 2);
  assert.equal(restoreFailureBlocksAuto(failedAttempt, decide({
    preferences: { version: 2, autoMode: 'OFF', autoContinue: false },
  })), false);
});

test('legacy APP_SERVER_REQUEST_FAILED plus ready Desktop is not latched before another timer iteration', () => {
  const plan = decide();
  const stateFromFailedLiveRun = { status: 'blocked', errorKind: 'APP_SERVER_REQUEST_FAILED',
    actionRequired: true, candidateThreadId: plan.candidates[0].threadId,
    candidateTurnId: plan.candidates[0].turnId, targetAccountId: plan.target.accountId,
    desktopRestore: { status: 'ready', desktopPid: 7001, desktopStartTicks: 9001 } };
  const migrated = reconcileFailedAutomaticAttempt(stateFromFailedLiveRun, decide());
  assert.equal(migrated.errorKind, 'APP_SERVER_REQUEST_FAILED');
  assert.equal(migrated.restoreRetryHalt, false);

  // This is the next systemd timer firing in the reproduced loop. Its entry
  // gate sees the same (threadId, turnId, target) and never starts restore.
  let restoreStarts = 1;
  let resumeStarts = 1;
  if (!restoreFailureBlocksAuto(migrated, decide())) {
    restoreStarts += 1;
    resumeStarts += 1;
  }
  assert.equal(restoreStarts, 2);
  assert.equal(resumeStarts, 2);
});

test('already committed candidates are excluded after crash/restart and can never be sent twice', () => {
  const state = eventState();
  const candidate = state.interruptedTurns.first;
  const resumeState = markResumeCommitted({}, candidate, {
    targetAccountId: 'account-b', continuation: continuationForCandidate(candidate),
  }, NOW - 500);
  const decision = decide({ eventState: state, resumeState });
  assert.equal(decision.action, 'resume');
  assert.deepEqual(decision.candidates.map(item => item.threadId), ['thread-second']);

  assert.throws(() =>
    markResumeCommitted(resumeState, candidate, {
      targetAccountId: 'account-b', continuation: continuationForCandidate(candidate),
    }, NOW),
  /RESUME_ALREADY_COMMITTED/);
});

test('AUTO replays exact original structured input only when its hash and classification verify', () => {
  const originalInput = [
    { type: 'text', text: 'Inspect this image' },
    { type: 'image', url: 'https://example.test/image.png', detail: 'low' },
  ];
  const state = eventState();
  state.interruptedTurns = {
    before: {
      threadId: 'thread-before', turnId: 'turn-before', accountId: 'account-a',
      completedAtMs: NOW - 1_000, resumable: true, threadIdentityVerified: true,
      interruptionClass: INTERRUPTION_CLASS.BEFORE_WORK, classificationVerified: true,
      originalInput, originalInputHash: inputHash(originalInput),
    },
  };
  const decision = decide({ eventState: state });
  assert.equal(decision.action, 'resume');
  const continuation = continuationForCandidate(decision.candidates[0]);
  assert.equal(continuation.kind, 'replay-original');
  assert.deepEqual(continuation.input, originalInput);

  state.interruptedTurns.before.originalInputHash = '0'.repeat(64);
  const blocked = decide({ eventState: state });
  assert.equal(blocked.action, 'blocked');
  assert.equal(blocked.reason, 'original-input-unverified');
});

test('AUTO fails closed for unknown interruption classification', () => {
  const state = eventState();
  state.interruptedTurns.first.interruptionClass = INTERRUPTION_CLASS.UNKNOWN;
  state.interruptedTurns.first.classificationVerified = false;
  const result = decide({ eventState: state });
  assert.equal(result.action, 'blocked');
  assert.equal(result.reason, 'interruption-class-unknown');
});

test('AUTO fails closed when rejected structured input cannot be losslessly reconstructed', () => {
  const unsupported = [{ type: 'futureAttachment', opaqueId: 'attachment-a' }];
  const state = eventState();
  state.interruptedTurns = {
    unsupported: {
      threadId: 'thread-unsupported', turnId: 'turn-unsupported', accountId: 'account-a',
      completedAtMs: NOW, resumable: true, threadIdentityVerified: true,
      interruptionClass: INTERRUPTION_CLASS.BEFORE_WORK, classificationVerified: true,
      originalInput: unsupported, originalInputHash: inputHash(unsupported),
    },
  };
  const result = decide({ eventState: state });
  assert.equal(result.action, 'blocked');
  assert.equal(result.reason, 'original-input-unverified');
});

test('a later real turn removes an advanced candidate from the automation set', () => {
  const state = eventState();
  delete state.interruptedTurns.first;
  const decision = decide({ eventState: state });
  assert.deepEqual(decision.candidates.map(item => item.threadId), ['thread-second']);
});

test('pending countdown persists the exact plan and claims one notification across restart', () => {
  const decision = decide();
  const created = createOrResumePending({}, decision, NOW);
  assert.equal(created.outcome, 'created');
  assert.equal(created.notificationClaimed, true);
  assert.equal(created.state.pending.sourceAccountId, 'account-a');
  assert.equal(created.state.pending.targetAccountId, 'account-b');
  assert.equal(created.state.pending.threadId, 'thread-first');
  assert.equal(created.state.pending.failedTurnId, 'turn-first');
  assert.equal(created.state.pending.interruptionClass, INTERRUPTION_CLASS.AFTER_WORK);
  assert.equal(created.state.pending.inputHash, continuationForCandidate(decision.candidates[0]).inputHash);
  assert.equal(created.state.pending.candidates.length, 2);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auto-pending-'));
  const statePath = path.join(root, 'auto-continue.json');
  writeAutoContinueStateFile(statePath, created.state);
  const restarted = createOrResumePending(
    normalizeAutoContinueState(JSON.parse(fs.readFileSync(statePath, 'utf8'))),
    decision,
    NOW + 4_000,
  );
  assert.equal(restarted.outcome, 'resumed');
  assert.equal(restarted.notificationClaimed, true);
  assert.equal(restarted.state.pending.notificationReplaceId, created.state.pending.notificationReplaceId);
  assert.equal(restarted.state.pending.deadlineAtMs, NOW + 10_000);
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' }, restarted.state, NOW + 3_100),
    'AUTO: HEADLESS · Restart om 7s [X] Avbryt');
  assert.equal(pendingAttentionDecision(restarted.state, true, NOW + 3_100).situationClass,
    'auto-continue-pending');
});

test('cancel suppresses the same plan but changed target or candidate re-arms it', () => {
  const decision = decide();
  const created = createOrResumePending({}, decision, NOW).state;
  const canceled = cancelPendingAction(created, NOW + 1_000);
  assert.equal(canceled.canceled, true);
  assert.equal(canceled.state.pending, null);
  assert.equal(canceled.state.suppression.fingerprint, autoPlanFingerprint(decision));
  assert.equal(createOrResumePending(canceled.state, decision, NOW + 2_000).outcome, 'suppressed');
  assert.equal(isAutoPlanSuppressed(canceled.state, decision), true);

  const changedTarget = decide();
  changedTarget.target = { ...changedTarget.target, accountId: 'account-c', accountKey: 'key-c' };
  const targetRearmed = createOrResumePending(canceled.state, changedTarget, NOW + 2_000);
  assert.equal(targetRearmed.outcome, 'created');
  assert.equal(targetRearmed.state.suppression, null);

  const changedCandidate = decide();
  changedCandidate.candidates = changedCandidate.candidates.slice(1);
  assert.equal(createOrResumePending(canceled.state, changedCandidate, NOW + 2_000).outcome, 'created');

  const cleared = reconcileSuppression(canceled.state, { action: 'idle', reason: 'no-candidates' });
  assert.equal(cleared.suppression, null);
  assert.equal(resetAutoContinueForToggle(canceled.state, true, NOW + 3_000).suppression, null);
});

test('countdown expiry hands the unchanged plan to existing execution while changes fail closed', () => {
  const decision = decide();
  const state = createOrResumePending({}, decision, NOW).state;
  assert.deepEqual(pendingCountdownDecision(state, decision, NOW + 9_500), {
    action: 'wait', remainingMs: 500,
  });
  assert.deepEqual(pendingCountdownDecision(state, decision, NOW + 10_000), {
    action: 'execute', remainingMs: 0,
  });
  assert.equal(pendingCountdownDecision(cancelPendingAction(state, NOW + 2_000).state, decision, NOW + 10_000).action,
    'canceled');
  const changed = decide();
  changed.candidates = changed.candidates.slice(1);
  assert.equal(pendingCountdownDecision(state, changed, NOW + 10_000).action, 'changed');
  assert.equal(requiresPendingCountdown(decision, true), true);
  assert.equal(requiresPendingCountdown(decision, false), false);
  assert.equal(requiresPendingCountdown({ ...decision, target: { ...decision.target, accountId: 'account-a' } }, true), false);
});

test('DESKTOP countdown keeps a separate unavailable candidate outside the locked plan', () => {
  const raw = decide();
  const unavailable = raw.candidates[0];
  const locked = { ...raw, candidates: raw.candidates.slice(1) };
  const pending = createOrResumePending({}, locked, NOW).state;
  assert.equal(sameHeadlessDecisionPlan(locked, raw, [unavailable]), true);
  assert.equal(pendingCountdownDecision(pending,
    { ...raw, candidates: raw.candidates.filter(candidate => candidate !== unavailable) },
    NOW + 10_000).action, 'execute');
  assert.equal(pendingCountdownDecision(pending, raw, NOW + 10_000).action, 'changed');
});

test('changed expired countdown clears pending, replans, and does not notify the same plan again', () => {
  const plan = decide();
  const pending = createOrResumePending({}, plan, NOW).state;
  const changed = { ...plan, candidates: plan.candidates.slice(1) };
  assert.equal(pendingCountdownDecision(pending, changed, NOW + 10_000).action, 'changed');
  const replanning = recordPrecommitPlanChange(pending,
    'AUTO_PLAN_CHANGED_DURING_COUNTDOWN', {}, NOW + 10_000);
  assert.equal(replanning.pending, null);
  assert.equal(replanning.status, 'waiting');
  assert.match(autoContinueStatusLine({ autoMode: 'HEADLESS' }, pending, NOW + 10_000),
    /WAIT: countdown-expired/);
  assert.doesNotMatch(autoContinueStatusLine({ autoMode: 'HEADLESS' }, pending, NOW + 10_000), /Restart om 0s/);
  assert.doesNotMatch(autoContinueStatusLine({ autoMode: 'HEADLESS' }, replanning, NOW + 10_000), /Restart om 0s/);
  const notified = { ...replanning, lastNotifiedPendingFingerprint: autoPlanFingerprint(plan) };
  assert.equal(createOrResumePending(notified, plan, NOW + 10_001).notificationClaimed, false);
  assert.equal(createOrResumePending(notified, changed, NOW + 10_001).notificationClaimed, true);
});

test('short operation lock contention remains a retryable wait', () => {
  const waiting = waitForResumeOperationLock({ status: 'pending', pending: { fingerprint: 'old' },
    errorKind: 'RESUME_ALREADY_RUNNING', actionRequired: true }, NOW);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.waitingReason, 'resume-already-running');
  assert.equal(waiting.pending, null);
  assert.equal(waiting.actionRequired, false);
  assert.deepEqual(autoContinueProblemLines(waiting, true), []);
});

test('historical observer timeout does not become an active AUTO problem for a new candidate', () => {
  const oldKey = JSON.stringify(['old-thread', 'old-failed']);
  const state = { status: 'blocked', actionRequired: true,
    errorKind: 'TURN_OBSERVER_DID_NOT_SETTLE', candidateThreadId: 'old-thread',
    candidateTurnId: 'old-failed' };
  const resumeState = { attempts: { [oldKey]: { threadId: 'old-thread',
    interruptedTurnId: 'old-failed', continuationTurnId: 'old-continuation',
    status: 'MANUAL_REQUIRED_AFTER_COMMIT', errorKind: 'TURN_OBSERVER_DID_NOT_SETTLE',
    committedAtMs: 100, completedAtMs: 200, terminalStatus: 'completed' } } };
  assert.deepEqual(autoContinueProblemLines(state, true, { resumeState }), []);
  assert.deepEqual(autoContinueProblemLines(state, true,
    { candidateKeys: new Set([JSON.stringify(['new-thread', 'new-failed'])]) }), []);
  assert.equal(autoContinueProblemLines(state, true, { candidateKeys: new Set([oldKey]) }).length, 1);
});
