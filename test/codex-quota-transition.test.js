'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  advanceQuotaTransition,
  emptyQuotaTransitionState,
  quotaAvailabilitySnapshot,
} = require('../lib/codex-quota-transition');

const NOW = 1_800_000_000_000;

function account(id, overrides = {}) {
  return {
    accountId: id,
    label: `Account ${id}`,
    usageQuality: 'verified',
    verifiedExhausted: false,
    ordinaryUsageAllowed: true,
    ordinaryUsageAllowedObserved: true,
    fiveHourRemaining: 50,
    weeklyRemaining: 50,
    ...overrides,
  };
}

test('zero percent alone never arms verified total exhaustion', () => {
  const snapshot = quotaAvailabilitySnapshot([
    account('a', { fiveHourRemaining: 0, ordinaryUsageAllowed: true }),
    account('b'),
  ]);
  assert.equal(snapshot.totalExhaustion, false);
  assert.deepEqual(snapshot.usableAccounts.map(entry => entry.accountId), ['b']);
});

test('fresh positive quota is usable when the optional ordinary-usage flag is absent', () => {
  const snapshot = quotaAvailabilitySnapshot([
    account('a', {
      ordinaryUsageAllowed: null,
      ordinaryUsageAllowedObserved: false,
      fiveHourRemaining: 89,
      weeklyRemaining: 83,
    }),
    account('b', { verifiedExhausted: true }),
  ]);
  assert.equal(snapshot.verified, true);
  assert.equal(snapshot.totalExhaustion, false);
  assert.deepEqual(snapshot.usableAccounts, [{ accountId: 'a', label: 'Account a' }]);
  const armed = {
    ...emptyQuotaTransitionState(),
    armed: true,
    phase: 'total-exhaustion',
  };
  const recovered = advanceQuotaTransition(armed, snapshot, NOW);
  assert.deepEqual(recovered.event.accounts, [{ accountId: 'a', label: 'Account a' }]);
  assert.equal(advanceQuotaTransition(recovered.state, snapshot, NOW + 1).event, null);
});

test('an explicit ordinary-usage denial still prevents recovery despite positive percentages', () => {
  const snapshot = quotaAvailabilitySnapshot([
    account('a', {
      ordinaryUsageAllowed: false,
      ordinaryUsageAllowedObserved: true,
      fiveHourRemaining: 89,
      weeklyRemaining: 83,
    }),
  ]);
  assert.equal(snapshot.verified, true);
  assert.equal(snapshot.totalExhaustion, true);
  assert.deepEqual(snapshot.usableAccounts, []);
});

test('simultaneously recovered accounts produce one event listing every usable account', () => {
  const snapshot = quotaAvailabilitySnapshot([
    account('a', { ordinaryUsageAllowed: null, ordinaryUsageAllowedObserved: false }),
    account('b', { ordinaryUsageAllowed: true, ordinaryUsageAllowedObserved: true }),
  ]);
  const result = advanceQuotaTransition({
    ...emptyQuotaTransitionState(),
    armed: true,
    phase: 'total-exhaustion',
  }, snapshot, NOW);
  assert.equal(result.event.type, 'quota-available');
  assert.deepEqual(result.event.accounts, [
    { accountId: 'a', label: 'Account a' },
    { accountId: 'b', label: 'Account b' },
  ]);
});

test('fresh authoritative quota denial arms and one verified recovery notifies once', () => {
  const exhausted = quotaAvailabilitySnapshot([
    account('a', { verifiedExhausted: true }),
    account('b', { ordinaryUsageAllowed: false }),
  ]);
  let result = advanceQuotaTransition(emptyQuotaTransitionState(), exhausted, NOW);
  assert.equal(result.state.armed, true);
  assert.equal(result.event, null);

  const recovered = quotaAvailabilitySnapshot([
    account('a', { verifiedExhausted: true }),
    account('b', { ordinaryUsageAllowed: true }),
  ]);
  result = advanceQuotaTransition(result.state, recovered, NOW + 60_000);
  assert.equal(result.event.type, 'quota-available');
  assert.deepEqual(result.event.accounts, [{ accountId: 'b', label: 'Account b' }]);

  const repeated = advanceQuotaTransition(result.state, recovered, NOW + 120_000);
  assert.equal(repeated.event, null);
});

test('stale or unverified data neither arms nor emits recovery', () => {
  const unknown = quotaAvailabilitySnapshot([
    account('a', { usageQuality: 'stale', ordinaryUsageAllowed: false }),
    account('b', { usageQuality: 'unverified', ordinaryUsageAllowed: false }),
  ]);
  assert.equal(unknown.verified, false);
  const result = advanceQuotaTransition({
    ...emptyQuotaTransitionState(),
    armed: true,
    phase: 'total-exhaustion',
  }, unknown, NOW);
  assert.equal(result.event, null);
  assert.equal(result.state.armed, true);
});

test('a later verified total exhaustion re-arms a future recovery', () => {
  const exhausted = quotaAvailabilitySnapshot([
    account('a', { ordinaryUsageAllowed: false }),
    account('b', { verifiedExhausted: true }),
  ]);
  const recovered = quotaAvailabilitySnapshot([account('a'), account('b')]);
  let result = advanceQuotaTransition(emptyQuotaTransitionState(), exhausted, NOW);
  result = advanceQuotaTransition(result.state, recovered, NOW + 1);
  assert.ok(result.event);
  result = advanceQuotaTransition(result.state, exhausted, NOW + 2);
  assert.equal(result.state.armed, true);
  result = advanceQuotaTransition(result.state, recovered, NOW + 3);
  assert.ok(result.event);
  assert.notEqual(result.event.fingerprint, 'quota-recovered:1800000000001');
});
