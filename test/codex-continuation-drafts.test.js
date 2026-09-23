'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CONTINUATION_DRAFT,
  buildContinuationPlan,
  continuationDeepLinks,
  validateContinuationPlan,
} = require('../lib/codex-continuation-drafts');

const NOW = 1_790_190_000_000;

function usageEntry({ primary = 40, secondary = 60, allowed = true, at = NOW } = {}) {
  return {
    primary: { remainingPercent: primary },
    secondary: { remainingPercent: secondary },
    ordinaryUsageAllowedObserved: true,
    ordinaryUsageAllowed: allowed,
    refresh: {
      lastSuccessAt: at,
      lastAttemptAt: at,
      lastErrorAt: null,
      errorKind: null,
      httpStatus: 200,
      consecutiveFailures: 0,
    },
  };
}

function usageCache(overrides = {}) {
  return {
    worker: { heartbeatAtMs: NOW, fatalErrorKind: null },
    accounts: {
      source: usageEntry({ allowed: false }),
      target: usageEntry(),
      ...overrides,
    },
  };
}

function eventState({ heartbeatAtMs = NOW, includeExhaustion = true } = {}) {
  return {
    worker: { heartbeatAtMs, errorKind: null },
    activeTurns: {},
    interruptedTurns: {
      later: {
        threadId: 'thread-later', turnId: 'turn-later', accountId: 'source',
        completedAtMs: NOW - 1_000, resumable: true, threadIdentityVerified: true,
      },
      earlier: {
        threadId: 'thread-earlier', turnId: 'turn-earlier', accountId: 'source',
        completedAtMs: NOW - 2_000, resumable: true, threadIdentityVerified: true,
      },
      guardian: {
        threadId: 'thread-guardian', turnId: 'turn-guardian', accountId: 'source',
        completedAtMs: NOW - 3_000, resumable: true, threadIdentityVerified: true,
        threadSource: 'guardian_review',
      },
      other: {
        threadId: 'thread-other', turnId: 'turn-other', accountId: 'other',
        completedAtMs: NOW - 4_000, resumable: true, threadIdentityVerified: true,
      },
    },
    exhaustions: includeExhaustion ? {
      source: {
        accountId: 'source', verified: true, threadIdentityVerified: true,
        errorKind: 'usageLimitExceeded',
      },
    } : {},
  };
}

function planInput(overrides = {}) {
  return {
    sourceAccountId: 'source',
    sourceAccountKey: 'source-key',
    targetAccountId: 'target',
    targetAccountKey: 'target-key',
    eventState: eventState(),
    resumeState: {},
    usageCache: usageCache(),
    nowMs: NOW,
    ...overrides,
  };
}

test('plans every verified interrupted main thread oldest first so the newest remains visible', () => {
  const plan = buildContinuationPlan(planInput());
  assert.equal(plan.action, 'prefill');
  assert.deepEqual(plan.candidates.map(candidate => candidate.threadId), [
    'thread-earlier',
    'thread-later',
  ]);
  const links = continuationDeepLinks(plan.candidates);
  assert.equal(links.length, 2);
  assert.match(links[0], /^codex:\/\/threads\/thread-earlier\?/);
  assert.equal(new URL(links[0]).searchParams.get('prompt'), CONTINUATION_DRAFT);
  assert.match(links[1], /^codex:\/\/threads\/thread-later\?/);
});

test('ordinary switches and switches to the same account never create a prefill plan', () => {
  assert.equal(buildContinuationPlan(planInput({
    eventState: eventState({ includeExhaustion: false }),
  })).action, 'none');
  assert.equal(buildContinuationPlan(planInput({
    targetAccountId: 'source', targetAccountKey: 'source-key',
  })).action, 'none');
});

test('stale observer or source usage blocks prefill before switching', () => {
  assert.deepEqual(buildContinuationPlan(planInput({
    eventState: eventState({ heartbeatAtMs: NOW - 60_000 }),
  })).reason, 'observer-unverified');
  assert.deepEqual(buildContinuationPlan(planInput({
    usageCache: usageCache({ source: usageEntry({ allowed: false, at: NOW - 4 * 60_000 }) }),
  })).reason, 'source-usage-unverified');
});

test('post-switch validation requires exact target, fresh usable target and unchanged candidates', () => {
  const input = planInput();
  const plan = buildContinuationPlan(input);
  const valid = validateContinuationPlan({
    plan,
    eventState: input.eventState,
    resumeState: input.resumeState,
    usageCache: input.usageCache,
    activeAccountId: 'target',
    activeAccountKey: 'target-key',
    nowMs: NOW,
  });
  assert.equal(valid.ok, true);

  assert.equal(validateContinuationPlan({
    ...input, plan, activeAccountId: 'wrong', activeAccountKey: 'target-key',
  }).reason, 'target-account-mismatch');
  assert.equal(validateContinuationPlan({
    ...input,
    plan,
    usageCache: usageCache({ target: usageEntry({ primary: 0, allowed: false }) }),
    activeAccountId: 'target',
    activeAccountKey: 'target-key',
  }).reason, 'target-not-usable');
  assert.equal(validateContinuationPlan({
    ...input,
    plan,
    eventState: { ...input.eventState, interruptedTurns: {} },
    activeAccountId: 'target',
    activeAccountKey: 'target-key',
  }).reason, 'interrupted-candidates-changed');
});

test('a committed headless resume and subagent candidates are never drafted', () => {
  const resumeState = {
    attempts: {
      '["thread-later","turn-later"]': { committedAtMs: NOW - 500 },
    },
  };
  const plan = buildContinuationPlan(planInput({ resumeState }));
  assert.deepEqual(plan.candidates.map(candidate => candidate.threadId), ['thread-earlier']);
});
