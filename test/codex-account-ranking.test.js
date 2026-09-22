'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  rankAccounts,
  recommendAccount,
  scoreAccount,
} = require('../lib/codex-account-ranking');

const NOW_MS = 1_800_000_000_000;

function account(sourceRow, overrides = {}) {
  const resetInHours = hours => (NOW_MS + hours * 3_600_000) / 1000;
  return {
    sourceRow: String(sourceRow),
    label: `Account ${sourceRow}`,
    active: false,
    usageQuality: 'verified',
    weeklyRemaining: 50,
    weeklyResetAt: resetInHours(5),
    fiveHourRemaining: 50,
    fiveHourResetAt: resetInHours(2),
    ...overrides,
  };
}

function ranks(accounts) {
  return rankAccounts(accounts, { nowMs: NOW_MS }).map(item => item.sourceRow);
}

test('weekly urgency is remaining weekly percentage per reset hour', () => {
  const scored = scoreAccount(account(1, {
    weeklyRemaining: 60,
    weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000,
  }), { nowMs: NOW_MS });
  assert.equal(scored.weeklyUrgency, 30);
});

test('100% weekly with no running window needs activation and ranks first', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 60 }),
    account(2, { weeklyRemaining: 100, weeklyDormant: true, weeklyResetAt: (NOW_MS + 168 * 3_600_000) / 1000 }),
  ], { nowMs: NOW_MS });

  assert.deepEqual(ranked.map(item => item.sourceRow), ['2', '1']);
  assert.equal(ranked[0].needsActivation, true);
  assert.equal(ranked[0].weeklyUrgency, 0);
  assert.deepEqual(recommendAccount(ranked), {
    action: 'switch',
    account: ranked[0],
    reason: 'needs-activation',
  });
});

test('stale 100% weekly data never creates NEEDS_ACTIVATION', () => {
  const scored = scoreAccount(account(1, {
    usageQuality: 'stale',
    weeklyRemaining: 100,
    weeklyDormant: true,
    weeklyResetAt: (NOW_MS + 168 * 3_600_000) / 1000,
  }), { nowMs: NOW_MS });

  assert.equal(scored.needsActivation, false);
});

test('VERIFIED accounts rank ahead of stronger stale and unverified values', () => {
  const ranked = rankAccounts([
    account(1, { usageQuality: 'stale', weeklyRemaining: 100, weeklyResetAt: (NOW_MS + 1 * 3_600_000) / 1000 }),
    account(2, { usageQuality: 'verified', weeklyRemaining: 10, weeklyResetAt: (NOW_MS + 100 * 3_600_000) / 1000 }),
    account(3, { usageQuality: 'unverified', weeklyRemaining: 100, weeklyResetAt: (NOW_MS + 1 * 3_600_000) / 1000 }),
  ], { nowMs: NOW_MS });
  assert.deepEqual(ranked.map(item => item.sourceRow), ['2', '1', '3']);
});

test('an UNVERIFIED active account pauses recommendation instead of saying stay', () => {
  const ranked = rankAccounts([
    account(1, { active: true, usageQuality: 'unverified', weeklyRemaining: 90, fiveHourRemaining: 90 }),
    account(2, { usageQuality: 'verified', weeklyRemaining: 50, fiveHourRemaining: 50 }),
  ], { nowMs: NOW_MS });
  assert.deepEqual(recommendAccount(ranked), {
    action: 'none',
    account: ranked.find(item => item.sourceRow === '1'),
    reason: 'active-unverified',
  });
});

test('an exhausted verified active account pauses when no verified usable alternative exists', () => {
  const ranked = rankAccounts([
    account(1, { active: true, fiveHourRemaining: 0 }),
    account(2, { usageQuality: 'unverified', fiveHourRemaining: 90, weeklyRemaining: 90 }),
  ], { nowMs: NOW_MS });
  const recommendation = recommendAccount(ranked);
  assert.equal(recommendation.action, 'none');
  assert.equal(recommendation.reason, 'insufficient-verified-data');
});

test('terminally verified exhausted account ranks behind and is never recommended', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 20, fiveHourRemaining: 20 }),
    account(2, { verifiedExhausted: true, weeklyRemaining: 100, fiveHourRemaining: 100 }),
    account(3, { weeklyRemaining: 10, fiveHourRemaining: 10 }),
  ], { nowMs: NOW_MS });
  assert.deepEqual(ranked.map(item => item.sourceRow), ['1', '3', '2']);
  assert.equal(recommendAccount(ranked).account.sourceRow, '1');
});

test('verified exhaustion on ACTIVE excludes it but does not pause a safe alternative', () => {
  const ranked = rankAccounts([
    account(1, { active: true, verifiedExhausted: true, weeklyRemaining: 60, fiveHourRemaining: 60 }),
    account(2, { weeklyRemaining: 30, fiveHourRemaining: 40 }),
  ], { nowMs: NOW_MS });
  const recommendation = recommendAccount(ranked);
  assert.equal(recommendation.action, 'switch');
  assert.equal(recommendation.account.sourceRow, '2');
  assert.equal(recommendation.reason, 'ranked-best');
});

test('a stale active account pauses recommendation until refresh recovers', () => {
  const ranked = rankAccounts([
    account(1, { active: true, usageQuality: 'stale' }),
    account(2, { usageQuality: 'verified' }),
  ], { nowMs: NOW_MS });
  assert.equal(recommendAccount(ranked).action, 'none');
  assert.equal(recommendAccount(ranked).reason, 'active-stale');
});

test('an active unstarted weekly cycle recommends one activation use without switching', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 100, weeklyDormant: true, weeklyResetAt: (NOW_MS + 168 * 3_600_000) / 1000 }),
    account(2, { weeklyRemaining: 60 }),
  ], { nowMs: NOW_MS });

  assert.equal(recommendAccount(ranked).action, 'stay');
  assert.equal(recommendAccount(ranked).reason, 'needs-activation');
});

test('100% weekly with a new 168-hour window uses normal W%/H', () => {
  const scored = scoreAccount(account(1, {
    weeklyRemaining: 100,
    weeklyResetAt: (NOW_MS + 168 * 3_600_000) / 1000,
  }), { nowMs: NOW_MS });

  assert.equal(scored.needsActivation, false);
  assert.ok(Math.abs(scored.weeklyUrgency - 100 / 168) < 1e-12);
});

test('0% weekly with a future automatic reset never needs activation', () => {
  const scored = scoreAccount(account(1, {
    weeklyRemaining: 0,
    weeklyResetAt: (NOW_MS + 30 * 60_000) / 1000,
  }), { nowMs: NOW_MS });

  assert.equal(scored.needsActivation, false);
  assert.equal(scored.weeklyUrgency, 0);
});

test('a clear weekly-urgency winner ranks first despite weaker 5H', () => {
  assert.deepEqual(ranks([
    account(1, { weeklyRemaining: 60, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 20 }),
    account(2, { weeklyRemaining: 80, weeklyResetAt: (NOW_MS + 10 * 3_600_000) / 1000, fiveHourRemaining: 100 }),
  ]), ['1', '2']);
});

test('near-equal weekly urgency lets a large 5H difference decide', () => {
  assert.deepEqual(ranks([
    account(1, { weeklyRemaining: 60, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 80 }),
    account(2, { weeklyRemaining: 62, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 1, fiveHourResetAt: (NOW_MS + 5 * 60_000) / 1000 }),
  ]), ['1', '2']);
});

test('an almost empty 5H bucket benefits from an imminent reset', () => {
  assert.deepEqual(ranks([
    account(1, { fiveHourRemaining: 1, fiveHourResetAt: (NOW_MS + 5 * 60_000) / 1000 }),
    account(2, { fiveHourRemaining: 1, fiveHourResetAt: (NOW_MS + 2 * 3_600_000) / 1000 }),
  ]), ['1', '2']);
});

test('an account with zero weekly quota ranks last and an exhausted active account switches', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 0 }),
    account(2, { weeklyRemaining: 10 }),
  ], { nowMs: NOW_MS });
  assert.deepEqual(ranked.map(item => item.sourceRow), ['2', '1']);
  assert.equal(recommendAccount(ranked).action, 'switch');
  assert.equal(recommendAccount(ranked).account.sourceRow, '2');
});

test('recommendation follows rank one even when active is only marginally behind', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 60, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 55 }),
    account(2, { weeklyRemaining: 62, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 60 }),
  ], { nowMs: NOW_MS });
  assert.equal(ranked[0].sourceRow, '2');
  assert.deepEqual(recommendAccount(ranked), {
    action: 'switch',
    account: ranked[0],
    reason: 'ranked-best',
  });
});

test('recommendation follows 5H-ranked winner within weekly-near-equal group', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 60, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 20 }),
    account(2, { weeklyRemaining: 62, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 80 }),
  ], { nowMs: NOW_MS });
  const recommendation = recommendAccount(ranked);
  assert.equal(recommendation.action, 'switch');
  assert.equal(recommendation.account.sourceRow, '2');
  assert.equal(recommendation.reason, 'ranked-best');
});

test('switches within a weekly-near-equal group when active 5H is critically low', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 60, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 1, fiveHourResetAt: (NOW_MS + 2 * 3_600_000) / 1000 }),
    account(2, { weeklyRemaining: 62, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 80 }),
  ], { nowMs: NOW_MS });
  const recommendation = recommendAccount(ranked);
  assert.equal(recommendation.action, 'switch');
  assert.equal(recommendation.account.sourceRow, '2');
  assert.equal(recommendation.reason, 'ranked-best');
});

test('recommendation still follows rank one when active 5H reset is imminent', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 60, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 1, fiveHourResetAt: (NOW_MS + 5 * 60_000) / 1000 }),
    account(2, { weeklyRemaining: 62, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 80 }),
  ], { nowMs: NOW_MS });
  const recommendation = recommendAccount(ranked);
  assert.equal(recommendation.action, 'switch');
  assert.equal(recommendation.account.sourceRow, '2');
  assert.equal(recommendation.reason, 'ranked-best');
});

test('recommends switching when the active account is clearly worse weekly', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 20, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 100 }),
    account(2, { weeklyRemaining: 60, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 20 }),
  ], { nowMs: NOW_MS });
  const recommendation = recommendAccount(ranked);
  assert.equal(recommendation.action, 'switch');
  assert.equal(recommendation.account.sourceRow, '2');
  assert.equal(recommendation.reason, 'ranked-best');
});

test('ranking changes after a 5H reset', () => {
  const shared = { weeklyRemaining: 50, weeklyResetAt: (NOW_MS + 5 * 3_600_000) / 1000 };
  assert.deepEqual(ranks([
    account(1, { ...shared, fiveHourRemaining: 1, fiveHourResetAt: (NOW_MS + 5 * 60_000) / 1000 }),
    account(2, { ...shared, fiveHourRemaining: 80 }),
  ]), ['2', '1']);
  assert.deepEqual(ranks([
    account(1, { ...shared, fiveHourRemaining: 100, fiveHourResetAt: (NOW_MS + 5 * 3_600_000) / 1000 }),
    account(2, { ...shared, fiveHourRemaining: 80 }),
  ]), ['1', '2']);
});

test('equal accounts use the active account then stable source order', () => {
  assert.deepEqual(ranks([
    account(2),
    account(3, { active: true }),
    account(1),
  ]), ['3', '1', '2']);
});

test('ranked recommendation can differ from highest-urgency active account without attention', () => {
  const resetInHours = hours => (NOW_MS + hours * 3_600_000) / 1000;
  const ranked = rankAccounts([
    account(1, {
      label: 'account-a',
      fiveHourRemaining: 69,
      fiveHourResetAt: resetInHours(1 + 10 / 60),
      weeklyRemaining: 27,
      weeklyResetAt: resetInHours(24 + 20 / 60),
    }),
    account(2, {
      label: 'account-b',
      active: true,
      fiveHourRemaining: 47,
      fiveHourResetAt: resetInHours(2 + 45 / 60),
      weeklyRemaining: 14,
      weeklyResetAt: resetInHours(12),
    }),
    account(3, {
      label: 'account-c',
      fiveHourRemaining: 100,
      fiveHourResetAt: resetInHours(0),
      weeklyRemaining: 42,
      weeklyResetAt: resetInHours(63 + 25 / 60),
    }),
  ], { nowMs: NOW_MS });

  assert.deepEqual(ranked.map(item => item.sourceRow), ['1', '2', '3']);
  assert.deepEqual(ranked.map(item => Number(item.weeklyUrgency.toFixed(2))), [1.11, 1.17, 0.66]);
  assert.deepEqual(recommendAccount(ranked), {
    action: 'switch',
    account: ranked[0],
    reason: 'ranked-best',
  });
});
