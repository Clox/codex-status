'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  autoContinueStatusLine,
  autoContinueProblemLine,
  autoPlanFingerprint,
  automationDecision,
  cancelPendingAction,
  createOrResumePending,
  isAutoPlanSuppressed,
  normalizeAutoContinueState,
  pendingAttentionDecision,
  pendingCountdownDecision,
  recordExclusivityBlock,
  clearExclusivityBlock,
  reconcileSuppression,
  requiresPendingCountdown,
  resetAutoContinueForToggle,
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
  assert.equal(first.exclusivityBlock.consecutiveFailures, 1);
  assert.deepEqual(first.exclusivityBlock.blockers, [
    { pid: 20, ppid: 2, state: 'S', role: 'desktop-app-server' },
  ]);
  assert.equal(autoContinueStatusLine({ autoMode: 'HEADLESS' }, first, NOW),
    'AUTO: HEADLESS · WAIT/BLOCKED');
  assert.equal(clearExclusivityBlock(first).exclusivityBlock, null);
});

test('persistent exclusivity blocking escalates only after bounded repeated failures', () => {
  const diagnostics = { blockers: [{ pid: 20, ppid: 2, state: 'S', role: 'desktop-app-server' }] };
  let state = {};
  for (let attempt = 0; attempt < 9; attempt += 1) {
    state = recordExclusivityBlock(state, diagnostics, {
      threadId: 'thread-first', failedTurnId: 'turn-first', targetAccountId: 'account-b',
    }, NOW + attempt * 1_000);
    assert.equal(state.actionRequired, false);
  }
  state = recordExclusivityBlock(state, diagnostics, {
    threadId: 'thread-first', failedTurnId: 'turn-first', targetAccountId: 'account-b',
  }, NOW + 9_000);
  assert.equal(state.status, 'blocked');
  assert.equal(state.actionRequired, true);
  assert.equal(state.exclusivityBlock.consecutiveFailures, 10);

  const manual = recordExclusivityBlock({}, {
    blockers: [{ pid: 30, ppid: 3, state: 'S', role: 'other-app-server' }],
  }, { threadId: 'thread-first' }, NOW);
  assert.equal(manual.actionRequired, true);
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
