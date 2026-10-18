'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertVerifiedFiveHourDormant,
  executeVerifiedFiveHourActivation,
  fixedResetHours,
  isFixedFiveHourWindow,
  reverifyFiveHourDormantAfterConfirmation,
  verifyFiveHourDormantPrecondition,
} = require('../lib/codex-five-hour-activation');

const NOW_MS = 1_800_000_000_000;
const ACCOUNT_ID = 'account-a';
const ACCESS_TOKEN = 'token-secret';

function rawObservation(observedAtMs, { dormant, resetAt = null } = {}) {
  const serverObservedAtMs = observedAtMs;
  const fixedResetAt = resetAt ?? observedAtMs / 1000 + 18_000;
  return {
    observedAtMs,
    serverObservedAtMs,
    usedPercent: 0,
    limitWindowSeconds: 18_000,
    resetAfterSeconds: dormant ? 18_000 : fixedResetAt - serverObservedAtMs / 1000,
    resetAt: dormant ? serverObservedAtMs / 1000 + 18_000 : fixedResetAt,
  };
}

function dormantCache(observationCount = 2) {
  const observations = [
    rawObservation(NOW_MS - 10_000, { dormant: true }),
    rawObservation(NOW_MS - 5_000, { dormant: true }),
  ].slice(-observationCount);
  return {
    version: 3,
    lastAttemptAtMs: NOW_MS - 5_000,
    worker: { heartbeatAtMs: NOW_MS - 5_000 },
    accounts: {
      [ACCOUNT_ID]: {
        primary: { remainingPercent: 100, usedPercent: 0, resetsAt: NOW_MS / 1000 + 18_000, windowSeconds: 18_000 },
        secondary: { remainingPercent: 50, usedPercent: 50, resetsAt: NOW_MS / 1000 + 86_400, windowSeconds: 604_800 },
        observations: { primary: observations, secondary: [] },
        refresh: {
          lastSuccessAt: NOW_MS - 5_000,
          lastAttemptAt: NOW_MS - 5_000,
          lastErrorAt: null,
          errorKind: null,
          httpStatus: 200,
          consecutiveFailures: 0,
        },
      },
    },
  };
}

function usageEnvelope(observedAtMs, { dormant, resetAt = null } = {}) {
  const observation = rawObservation(observedAtMs, { dormant, resetAt });
  return {
    observedAtMs,
    serverObservedAtMs: observedAtMs,
    payload: {
      rate_limit: {
        primary_window: {
          used_percent: observation.usedPercent,
          limit_window_seconds: observation.limitWindowSeconds,
          reset_after_seconds: observation.resetAfterSeconds,
          reset_at: observation.resetAt,
        },
        secondary_window: {
          used_percent: 50,
          limit_window_seconds: 604_800,
          reset_after_seconds: 86_400,
          reset_at: observedAtMs / 1000 + 86_400,
        },
      },
    },
  };
}

test('precondition requires cached VERIFIED two-observation fiveHourDormant classification', async () => {
  let fetches = 0;
  await assert.rejects(verifyFiveHourDormantPrecondition({
    cache: dormantCache(1),
    accountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
    fetchObservation: async () => {
      fetches += 1;
      return usageEnvelope(NOW_MS, { dormant: true });
    },
    nowMs: NOW_MS,
  }), /ACCOUNT_NOT_FIVE_HOUR_DORMANT/);
  assert.equal(fetches, 0);
});

test('precondition revalidates dormant state with one fresh server observation', async () => {
  const refreshed = await verifyFiveHourDormantPrecondition({
    cache: dormantCache(),
    accountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
    fetchObservation: async () => usageEnvelope(NOW_MS, { dormant: true }),
    nowMs: NOW_MS,
  });
  assert.doesNotThrow(() => assertVerifiedFiveHourDormant(refreshed, ACCOUNT_ID, NOW_MS));
});

test('one isolated turn must be followed by two observations with a fixed decreasing 5H deadline', async () => {
  const resetAt = NOW_MS / 1000 + 18_000;
  const observations = [
    usageEnvelope(NOW_MS, { dormant: true }),
    usageEnvelope(NOW_MS + 6_000, { dormant: true }),
    usageEnvelope(NOW_MS + 8_000, { dormant: false, resetAt }),
    usageEnvelope(NOW_MS + 14_000, { dormant: false, resetAt }),
  ];
  let turns = 0;
  const result = await executeVerifiedFiveHourActivation({
    cache: dormantCache(),
    accountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
    fetchObservation: async () => observations.shift(),
    runTurn: async () => { turns += 1; },
    delay: async () => {},
  });
  assert.equal(turns, 1);
  assert.equal(observations.length, 0);
  assert.equal(isFixedFiveHourWindow(result.after, ACCOUNT_ID), true);
  assert.ok(fixedResetHours(result.after, ACCOUNT_ID) > 4.9);
});

test('ambiguous moving post-turn deadline fails closed and never retries the turn', async () => {
  const observations = [
    usageEnvelope(NOW_MS, { dormant: true }),
    usageEnvelope(NOW_MS + 6_000, { dormant: true }),
    usageEnvelope(NOW_MS + 8_000, { dormant: true }),
    usageEnvelope(NOW_MS + 14_000, { dormant: true }),
  ];
  let turns = 0;
  await assert.rejects(executeVerifiedFiveHourActivation({
    cache: dormantCache(),
    accountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
    fetchObservation: async () => observations.shift(),
    runTurn: async () => { turns += 1; },
    delay: async () => {},
  }), /FIVE_HOUR_ACTIVATION_NOT_VERIFIED/);
  assert.equal(turns, 1);
});

test('confirmation may wait longer than three minutes when two new observations reverify dormant state', async () => {
  const confirmedAtMs = NOW_MS + 4 * 60_000;
  const resetAt = confirmedAtMs / 1000 + 18_000;
  const observations = [
    usageEnvelope(confirmedAtMs, { dormant: true }),
    usageEnvelope(confirmedAtMs + 6_000, { dormant: true }),
    usageEnvelope(confirmedAtMs + 8_000, { dormant: false, resetAt }),
    usageEnvelope(confirmedAtMs + 14_000, { dormant: false, resetAt }),
  ];
  let turns = 0;
  const result = await executeVerifiedFiveHourActivation({
    cache: dormantCache(),
    accountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
    fetchObservation: async () => observations.shift(),
    runTurn: async () => { turns += 1; },
    delay: async () => {},
  });
  assert.equal(turns, 1);
  assert.equal(isFixedFiveHourWindow(result.after, ACCOUNT_ID), true);
});

test('state that changed while confirmation waited stops before any turn', async () => {
  const confirmedAtMs = NOW_MS + 4 * 60_000;
  const fixedResetAt = confirmedAtMs / 1000 + 17_500;
  const observations = [
    usageEnvelope(confirmedAtMs, { dormant: false, resetAt: fixedResetAt }),
    usageEnvelope(confirmedAtMs + 6_000, { dormant: false, resetAt: fixedResetAt }),
  ];
  let turns = 0;
  await assert.rejects(executeVerifiedFiveHourActivation({
    cache: dormantCache(),
    accountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
    fetchObservation: async () => observations.shift(),
    runTurn: async () => { turns += 1; },
    delay: async () => {},
  }), /ACCOUNT_NOT_FIVE_HOUR_DORMANT/);
  assert.equal(turns, 0);
});

test('verified exhaustion guard runs after fresh dormant revalidation and before the 5H turn', async () => {
  const observations = [
    usageEnvelope(NOW_MS, { dormant: true }),
    usageEnvelope(NOW_MS + 6_000, { dormant: true }),
  ];
  let turns = 0;
  let guardCalls = 0;
  await assert.rejects(executeVerifiedFiveHourActivation({
    cache: dormantCache(),
    accountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
    fetchObservation: async () => observations.shift(),
    assertCanActivate: async () => {
      guardCalls += 1;
      throw new Error('ACCOUNT_VERIFIED_EXHAUSTED');
    },
    runTurn: async () => { turns += 1; },
    delay: async () => {},
  }), /ACCOUNT_VERIFIED_EXHAUSTED/);
  assert.equal(guardCalls, 1);
  assert.equal(turns, 0);
});

test('post-confirmation recheck requires two newly fetched observations', async () => {
  let fetches = 0;
  await assert.rejects(reverifyFiveHourDormantAfterConfirmation({
    cache: dormantCache(),
    accountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
    fetchObservation: async () => {
      fetches += 1;
      if (fetches === 1) return usageEnvelope(NOW_MS + 240_000, { dormant: true });
      throw new Error('USAGE_REQUEST_FAILED');
    },
    delay: async () => {},
  }), /USAGE_REQUEST_FAILED/);
  assert.equal(fetches, 2);
});
