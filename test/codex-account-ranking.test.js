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

test('stays on an active account that is only marginally behind', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 60, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 55 }),
    account(2, { weeklyRemaining: 62, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 60 }),
  ], { nowMs: NOW_MS });
  assert.equal(ranked[0].sourceRow, '2');
  assert.deepEqual(recommendAccount(ranked), {
    action: 'stay',
    account: ranked.find(item => item.sourceRow === '1'),
    reason: 'hysteresis',
  });
});

test('switches within a weekly-near-equal group for a clearly better 5H bucket', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 60, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 20 }),
    account(2, { weeklyRemaining: 62, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 80 }),
  ], { nowMs: NOW_MS });
  const recommendation = recommendAccount(ranked);
  assert.equal(recommendation.action, 'switch');
  assert.equal(recommendation.account.sourceRow, '2');
  assert.equal(recommendation.reason, 'five-hour-availability');
});

test('recommends switching when the active account is clearly worse weekly', () => {
  const ranked = rankAccounts([
    account(1, { active: true, weeklyRemaining: 20, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 100 }),
    account(2, { weeklyRemaining: 60, weeklyResetAt: (NOW_MS + 2 * 3_600_000) / 1000, fiveHourRemaining: 20 }),
  ], { nowMs: NOW_MS });
  const recommendation = recommendAccount(ranked);
  assert.equal(recommendation.action, 'switch');
  assert.equal(recommendation.account.sourceRow, '2');
  assert.equal(recommendation.reason, 'weekly-urgency');
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
