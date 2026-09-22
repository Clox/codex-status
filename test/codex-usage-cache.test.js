'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assessCacheHealth,
  isFiveHourDormant,
  isWeeklyDormant,
  parseUsageResponse,
  refreshUsageCache,
  resolveUsage,
  shouldRefreshCache,
  usageQuality,
} = require('../lib/codex-usage-cache');
const {
  rankAccounts,
  recommendAccount,
} = require('../lib/codex-account-ranking');

const NOW_MS = 1_800_000_000_000;

function response(primaryUsed, secondaryUsed, primaryReset = 1_800_010_000, secondaryReset = 1_800_020_000) {
  return {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: primaryUsed, reset_at: primaryReset, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: secondaryUsed, reset_at: secondaryReset, limit_window_seconds: 604_800 },
    },
  };
}

function observedResponse({
  observedAtMs,
  primaryUsed = 0,
  primaryResetAt,
  primaryResetAfter = 18_000,
  secondaryUsed = 50,
  secondaryResetAt = observedAtMs / 1000 + 100_000,
  secondaryResetAfter = 100_000,
}) {
  return {
    observedAtMs,
    serverObservedAtMs: observedAtMs,
    payload: {
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: primaryUsed,
          limit_window_seconds: 18_000,
          reset_after_seconds: primaryResetAfter,
          reset_at: primaryResetAt,
        },
        secondary_window: {
          used_percent: secondaryUsed,
          limit_window_seconds: 604_800,
          reset_after_seconds: secondaryResetAfter,
          reset_at: secondaryResetAt,
        },
      },
    },
  };
}

async function refreshObserved(previousCache, observed) {
  return refreshUsageCache({
    accounts: [{ accountId: 'account-a' }],
    credentialsByAccountId: new Map([['account-a', 'secret-a']]),
    previousCache,
    fetchUsage: async () => observed,
    nowMs: observed.observedAtMs,
  });
}

test('parses server usage into remaining 5H and weekly percentages', () => {
  const parsed = parseUsageResponse(response(31, 73), NOW_MS);
  assert.equal(parsed.primary.remainingPercent, 69);
  assert.equal(parsed.secondary.remainingPercent, 27);
  assert.equal(parsed.primary.resetsAt, 1_800_010_000);
  assert.equal(parsed.secondary.windowSeconds, 604_800);
});

test('preserves explicit server permission and reached-state without inferring them from percentages', () => {
  const payload = response(100, 100);
  payload.ordinary_usage_allowed = false;
  payload.rate_limit_reached_type = 'rate_limit_reached';
  const parsed = parseUsageResponse(payload, NOW_MS);
  assert.equal(parsed.primary.remainingPercent, 0);
  assert.equal(parsed.ordinaryUsageAllowed, false);
  assert.equal(parsed.ordinaryUsageAllowedObserved, true);
  assert.equal(parsed.rateLimitReachedType, 'rate_limit_reached');
  assert.equal(parsed.rateLimitReachedTypeObserved, true);

  const percentagesOnly = parseUsageResponse(response(100, 100), NOW_MS);
  assert.equal(percentagesOnly.ordinaryUsageAllowed, null);
  assert.equal(percentagesOnly.ordinaryUsageAllowedObserved, false);
  assert.equal(percentagesOnly.rateLimitReachedTypeObserved, false);
});

test('preserves credential-free raw window fields for both 5H and weekly observations', async () => {
  const observed = observedResponse({
    observedAtMs: NOW_MS,
    primaryResetAt: NOW_MS / 1000 + 18_000,
  });
  const cache = await refreshObserved({}, observed);
  const entry = cache.accounts['account-a'];

  assert.deepEqual(entry.observations.primary[0], {
    observedAtMs: NOW_MS,
    serverObservedAtMs: NOW_MS,
    usedPercent: 0,
    limitWindowSeconds: 18_000,
    resetAfterSeconds: 18_000,
    resetAt: NOW_MS / 1000 + 18_000,
  });
  assert.deepEqual(entry.observations.secondary[0], {
    observedAtMs: NOW_MS,
    serverObservedAtMs: NOW_MS,
    usedPercent: 50,
    limitWindowSeconds: 604_800,
    resetAfterSeconds: 100_000,
    resetAt: NOW_MS / 1000 + 100_000,
  });
  assert.equal(JSON.stringify(cache).includes('secret-a'), false);
});

test('pins two server-timed dormant weekly observations beyond the rolling raw history', async () => {
  const beforeAt = NOW_MS - 60_000;
  const before = await refreshObserved({}, observedResponse({
    observedAtMs: beforeAt,
    primaryResetAt: beforeAt / 1000 + 18_000,
    secondaryUsed: 100,
    secondaryResetAt: beforeAt / 1000 + 60,
    secondaryResetAfter: 60,
  }));
  const first = await refreshObserved(before, observedResponse({
    observedAtMs: NOW_MS,
    primaryResetAt: NOW_MS / 1000 + 18_000,
    secondaryUsed: 0,
    secondaryResetAt: NOW_MS / 1000 + 604_800,
    secondaryResetAfter: 604_800,
  }));
  const second = await refreshObserved(first, observedResponse({
    observedAtMs: NOW_MS + 60_000,
    primaryResetAt: (NOW_MS + 60_000) / 1000 + 18_000,
    secondaryUsed: 0,
    secondaryResetAt: (NOW_MS + 60_000) / 1000 + 604_800,
    secondaryResetAfter: 604_800,
  }));
  const evidence = second.accounts['account-a'].weeklyResetEvidence;
  assert.equal(evidence.before.usedPercent, 100);
  assert.equal(evidence.after.length, 2);
  assert.deepEqual(evidence.after.map(value => value.serverObservedAtMs), [NOW_MS, NOW_MS + 60_000]);
  assert.deepEqual(evidence.after.map(value => value.resetAfterSeconds), [604_800, 604_800]);
  assert.equal(JSON.stringify(evidence).includes('secret-a'), false);

  const later = await refreshObserved(second, observedResponse({
    observedAtMs: NOW_MS + 120_000,
    primaryResetAt: (NOW_MS + 120_000) / 1000 + 18_000,
    secondaryUsed: 0,
  }));
  assert.deepEqual(later.accounts['account-a'].weeklyResetEvidence, evidence);
});

test('classifies weekly dormant from two fresh moving full-window observations', async () => {
  const firstAt = NOW_MS - 60_000;
  const first = await refreshObserved({}, observedResponse({
    observedAtMs: firstAt,
    primaryResetAt: firstAt / 1000 + 18_000,
    secondaryUsed: 0,
    secondaryResetAt: firstAt / 1000 + 604_800,
    secondaryResetAfter: 604_800,
  }));
  assert.equal(isWeeklyDormant(first.accounts['account-a'], { nowMs: firstAt }), false);

  const second = await refreshObserved(first, observedResponse({
    observedAtMs: NOW_MS,
    primaryResetAt: NOW_MS / 1000 + 18_000,
    secondaryUsed: 0,
    secondaryResetAt: NOW_MS / 1000 + 604_800,
    secondaryResetAfter: 604_800,
  }));
  assert.equal(isWeeklyDormant(second.accounts['account-a'], { nowMs: NOW_MS }), true);
  assert.equal(isWeeklyDormant(second.accounts['account-a'], { nowMs: NOW_MS + 180_001 }), false);
});

test('fixed weekly deadline stays active even while used_percent still rounds to zero', async () => {
  const fixedResetAt = NOW_MS / 1000 + 604_800;
  const firstAt = NOW_MS - 60_000;
  const first = await refreshObserved({}, observedResponse({
    observedAtMs: firstAt,
    primaryResetAt: firstAt / 1000 + 18_000,
    secondaryUsed: 0,
    secondaryResetAt: fixedResetAt,
    secondaryResetAfter: 604_800,
  }));
  const second = await refreshObserved(first, observedResponse({
    observedAtMs: NOW_MS,
    primaryResetAt: NOW_MS / 1000 + 18_000,
    secondaryUsed: 0,
    secondaryResetAt: fixedResetAt,
    secondaryResetAfter: 604_740,
  }));

  assert.equal(isWeeklyDormant(second.accounts['account-a'], { nowMs: NOW_MS }), false);
});

test('classifies 5H dormant only after two fresh moving full-window observations', async () => {
  const firstAt = NOW_MS - 60_000;
  const first = await refreshObserved({}, observedResponse({
    observedAtMs: firstAt,
    primaryResetAt: firstAt / 1000 + 18_000,
  }));
  assert.equal(isFiveHourDormant(first.accounts['account-a'], { nowMs: firstAt }), false);

  const second = await refreshObserved(first, observedResponse({
    observedAtMs: NOW_MS,
    primaryResetAt: NOW_MS / 1000 + 18_000,
  }));
  assert.equal(isFiveHourDormant(second.accounts['account-a'], { nowMs: NOW_MS }), true);
});

test('fixed 5H deadline stays active even while used_percent still rounds to zero', async () => {
  const fixedResetAt = NOW_MS / 1000 + 18_000;
  const firstAt = NOW_MS - 60_000;
  const first = await refreshObserved({}, observedResponse({
    observedAtMs: firstAt,
    primaryResetAt: fixedResetAt,
    primaryResetAfter: 18_000,
  }));
  const second = await refreshObserved(first, observedResponse({
    observedAtMs: NOW_MS,
    primaryResetAt: fixedResetAt,
    primaryResetAfter: 17_940,
  }));

  assert.equal(isFiveHourDormant(second.accounts['account-a'], { nowMs: NOW_MS }), false);
});

test('dormant classification clears immediately when the window becomes active', async () => {
  const firstAt = NOW_MS - 120_000;
  const secondAt = NOW_MS - 60_000;
  const first = await refreshObserved({}, observedResponse({
    observedAtMs: firstAt,
    primaryResetAt: firstAt / 1000 + 18_000,
  }));
  const dormant = await refreshObserved(first, observedResponse({
    observedAtMs: secondAt,
    primaryResetAt: secondAt / 1000 + 18_000,
  }));
  assert.equal(isFiveHourDormant(dormant.accounts['account-a'], { nowMs: secondAt }), true);

  const active = await refreshObserved(dormant, observedResponse({
    observedAtMs: NOW_MS,
    primaryUsed: 1,
    primaryResetAt: secondAt / 1000 + 18_000,
    primaryResetAfter: 17_940,
  }));
  assert.equal(isFiveHourDormant(active.accounts['account-a'], { nowMs: NOW_MS }), false);
});

test('cache policy refreshes at most once per minute', () => {
  assert.equal(shouldRefreshCache({}, NOW_MS, 60_000), true);
  assert.equal(shouldRefreshCache({ lastAttemptAtMs: NOW_MS - 59_999 }, NOW_MS, 60_000), false);
  assert.equal(shouldRefreshCache({ lastAttemptAtMs: NOW_MS - 60_000 }, NOW_MS, 60_000), true);
});

test('refreshes multiple accounts in parallel without persisting credentials', async () => {
  const credentials = new Map([['account-a', 'secret-a'], ['account-b', 'secret-b']]);
  let started = 0;
  const releases = [];
  const fetchUsage = async accountId => {
    started += 1;
    await new Promise(resolve => releases.push(resolve));
    return accountId === 'account-a' ? response(10, 20) : response(30, 40);
  };
  const pending = refreshUsageCache({
    accounts: [{ accountId: 'account-a' }, { accountId: 'account-b' }],
    credentialsByAccountId: credentials,
    fetchUsage,
    nowMs: NOW_MS,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 2);
  releases.forEach(resolve => resolve());
  const cache = await pending;
  assert.equal(cache.accounts['account-a'].primary.remainingPercent, 90);
  assert.equal(cache.accounts['account-b'].secondary.remainingPercent, 60);
  assert.equal(JSON.stringify(cache).includes('secret-'), false);
});

test('temporary errors retain the last valid observation and mark the attempt', async () => {
  const previous = {
    accounts: {
      'account-a': {
        ...parseUsageResponse(response(25, 50), NOW_MS - 60_000),
        fetchedAtMs: NOW_MS - 60_000,
        lastStatus: 'ok',
      },
    },
  };
  const cache = await refreshUsageCache({
    accounts: [{ accountId: 'account-a' }],
    credentialsByAccountId: new Map([['account-a', 'secret-a']]),
    previousCache: previous,
    fetchUsage: async () => { throw new Error('temporary outage'); },
    nowMs: NOW_MS,
  });
  assert.equal(cache.accounts['account-a'].primary.remainingPercent, 75);
  assert.equal(cache.accounts['account-a'].fetchedAtMs, NOW_MS - 60_000);
  assert.equal(cache.accounts['account-a'].refresh.errorKind, 'unknown');
  assert.equal(cache.accounts['account-a'].refresh.lastSuccessAt, NOW_MS - 60_000);
  assert.equal(cache.accounts['account-a'].refresh.lastAttemptAt, NOW_MS);
  assert.equal(cache.accounts['account-a'].refresh.lastErrorAt, NOW_MS);
  assert.equal(cache.accounts['account-a'].refresh.consecutiveFailures, 1);
  assert.equal(JSON.stringify(cache).includes('temporary outage'), false);
});

test('401 is retained as structured auth failure and immediately UNVERIFIED', async () => {
  const previous = {
    accounts: {
      'account-a': {
        ...parseUsageResponse(response(25, 50), NOW_MS - 60_000),
        fetchedAtMs: NOW_MS - 60_000,
        lastSuccessAtMs: NOW_MS - 60_000,
        lastStatus: 'ok',
      },
    },
  };
  const authError = new Error('unauthorized');
  authError.errorKind = 'auth-401';
  authError.httpStatus = 401;
  const cache = await refreshUsageCache({
    accounts: [{ accountId: 'account-a' }],
    credentialsByAccountId: new Map([['account-a', 'secret-a']]),
    previousCache: previous,
    fetchUsage: async () => { throw authError; },
    nowMs: NOW_MS,
  });
  const entry = cache.accounts['account-a'];
  assert.equal(entry.refresh.errorKind, 'auth-401');
  assert.equal(entry.refresh.httpStatus, 401);
  assert.equal(entry.primary.remainingPercent, 75);
  assert.equal(usageQuality(entry, { nowMs: NOW_MS }), 'unverified');
});

test('a later successful refresh clears transient error state automatically', async () => {
  const failed = {
    accounts: {
      'account-a': {
        ...parseUsageResponse(response(25, 50), NOW_MS - 60_000),
        fetchedAtMs: NOW_MS - 60_000,
        refresh: {
          lastSuccessAt: NOW_MS - 60_000,
          lastAttemptAt: NOW_MS - 30_000,
          lastErrorAt: NOW_MS - 30_000,
          errorKind: 'network',
          httpStatus: null,
          consecutiveFailures: 2,
        },
      },
    },
  };
  const cache = await refreshUsageCache({
    accounts: [{ accountId: 'account-a' }],
    credentialsByAccountId: new Map([['account-a', 'secret-a']]),
    previousCache: failed,
    fetchUsage: async () => response(10, 20),
    nowMs: NOW_MS,
  });
  assert.deepEqual(cache.accounts['account-a'].refresh, {
    lastSuccessAt: NOW_MS,
    lastAttemptAt: NOW_MS,
    lastErrorAt: null,
    errorKind: null,
    httpStatus: 200,
    consecutiveFailures: 0,
  });
  assert.equal(usageQuality(cache.accounts['account-a'], { nowMs: NOW_MS }), 'verified');
});

test('first failure still creates an error entry without credentials or response bodies', async () => {
  const cache = await refreshUsageCache({
    accounts: [{ accountId: 'account-a' }],
    credentialsByAccountId: new Map(),
    fetchUsage: async () => { throw new Error('must not run'); },
    nowMs: NOW_MS,
  });
  assert.deepEqual(cache.accounts['account-a'], {
    refresh: {
      lastSuccessAt: null,
      lastAttemptAt: NOW_MS,
      lastErrorAt: NOW_MS,
      errorKind: 'missing-credentials',
      httpStatus: null,
      consecutiveFailures: 1,
    },
  });
});

test('uses fresh server data, marks stale server data, then falls back locally', () => {
  const entry = {
    ...parseUsageResponse(response(20, 30), NOW_MS),
    fetchedAtMs: NOW_MS,
    lastSuccessAtMs: NOW_MS,
    lastStatus: 'ok',
  };
  const fresh = resolveUsage({ serverEntry: entry, nowMs: NOW_MS + 120_000 });
  assert.equal(fresh.source, 'server');
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.secondary.remainingPercent, 70);

  const stale = resolveUsage({ serverEntry: entry, nowMs: NOW_MS + 180_001 });
  assert.equal(stale.source, 'server-stale');
  assert.equal(stale.quality, 'stale');
  assert.equal(stale.fresh, false);
  assert.equal(stale.secondary.remainingPercent, 70);

  const local = resolveUsage({
    localPrimaryRemaining: 45,
    localSecondaryRemaining: 12,
    localUsage: { primary: { resets_at: 10 }, secondary: { resets_at: 20 } },
    nowMs: NOW_MS,
  });
  assert.equal(local.source, 'local-unverified');
  assert.equal(local.quality, 'unverified');
  assert.equal(local.fresh, false);
  assert.equal(local.primary.remainingPercent, 45);
  assert.equal(local.secondary.resetsAt, 20);
});

test('quality becomes UNVERIFIED after 15 minutes or three consecutive failures', () => {
  const entry = {
    ...parseUsageResponse(response(20, 30), NOW_MS),
    fetchedAtMs: NOW_MS,
    lastSuccessAtMs: NOW_MS,
    lastStatus: 'ok',
    consecutiveFailures: 0,
  };
  assert.equal(usageQuality(entry, { nowMs: NOW_MS + 180_000 }), 'verified');
  assert.equal(usageQuality(entry, { nowMs: NOW_MS + 180_001 }), 'stale');
  assert.equal(usageQuality(entry, { nowMs: NOW_MS + 900_001 }), 'unverified');
  assert.equal(usageQuality({ ...entry, lastStatus: 'error', errorKind: 'network', consecutiveFailures: 3 }, { nowMs: NOW_MS + 60_000 }), 'unverified');
});

test('dead worker heartbeat makes otherwise valid observations UNVERIFIED', () => {
  const cache = { worker: { heartbeatAtMs: NOW_MS } };
  assert.equal(assessCacheHealth(cache, NOW_MS + 899_999).healthy, true);
  const dead = assessCacheHealth(cache, NOW_MS + 900_001);
  assert.equal(dead.healthy, false);
  const entry = {
    ...parseUsageResponse(response(20, 30), NOW_MS),
    fetchedAtMs: NOW_MS + 899_000,
    lastSuccessAtMs: NOW_MS + 899_000,
    lastStatus: 'ok',
  };
  const resolved = resolveUsage({ serverEntry: entry, nowMs: NOW_MS + 900_001, cacheHealth: dead });
  assert.equal(resolved.quality, 'unverified');
  assert.equal(resolved.errorKind, 'worker-stale');
});

test('hours-old account data cannot look current or recommend staying or switching to it', () => {
  const oldAccount = {
    ...parseUsageResponse(response(18, 18), NOW_MS - 4 * 3_600_000),
    fetchedAtMs: NOW_MS - 4 * 3_600_000,
    refresh: {
      lastSuccessAt: NOW_MS - 4 * 3_600_000,
      lastAttemptAt: NOW_MS - 4 * 3_600_000,
      lastErrorAt: null,
      errorKind: null,
      httpStatus: 200,
      consecutiveFailures: 0,
    },
  };
  const resolved = resolveUsage({ serverEntry: oldAccount, nowMs: NOW_MS });
  assert.equal(resolved.quality, 'unverified');

  const ranked = rankAccounts([
    {
      sourceRow: '1',
      label: 'account-a',
      active: true,
      usageQuality: resolved.quality,
      fiveHourRemaining: resolved.primary.remainingPercent,
      fiveHourResetAt: resolved.primary.resetsAt,
      weeklyRemaining: resolved.secondary.remainingPercent,
      weeklyResetAt: resolved.secondary.resetsAt,
    },
    {
      sourceRow: '2',
      label: 'account-b',
      active: false,
      usageQuality: 'verified',
      fiveHourRemaining: 50,
      fiveHourResetAt: (NOW_MS + 2 * 3_600_000) / 1000,
      weeklyRemaining: 50,
      weeklyResetAt: (NOW_MS + 20 * 3_600_000) / 1000,
    },
  ], { nowMs: NOW_MS });
  const recommendation = recommendAccount(ranked);
  assert.equal(ranked[0].label, 'account-b');
  assert.equal(recommendation.action, 'none');
  assert.equal(recommendation.reason, 'active-unverified');
});
