'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { rankAccounts, recommendAccount } = require('../lib/codex-account-ranking');
const { attentionDecision, advanceAttentionState } = require('../lib/codex-attention-policy');

const NOW = 1_800_000_000_000;
const resetInHours = hours => (NOW + hours * 3_600_000) / 1000;

function account(id, overrides = {}) {
  return {
    accountId: id,
    sourceRow: id === 'a' ? '1' : '2',
    label: id,
    active: id === 'a',
    usageQuality: 'verified',
    usageLastSuccessAtMs: NOW,
    weeklyRemaining: 50,
    weeklyResetAt: resetInHours(5),
    fiveHourRemaining: 50,
    fiveHourResetAt: resetInHours(2),
    ...overrides,
  };
}

function decide(accounts, nowMs = NOW) {
  const ranked = rankAccounts(accounts, { nowMs });
  const recommendation = recommendAccount(ranked);
  return { ranked, recommendation, decision: attentionDecision(ranked, recommendation, { nowMs }) };
}

test('small ranking advantage changes recommendation but requests no attention', () => {
  const { recommendation, decision } = decide([
    account('a', { fiveHourRemaining: 55 }),
    account('b', { active: false, fiveHourRemaining: 60 }),
  ]);
  assert.equal(recommendation.action, 'switch');
  assert.equal(recommendation.account.accountId, 'b');
  assert.equal(decision.worthy, false);
});

test('clear weekly advantage waits for two distinct fresh observations', () => {
  const first = decide([
    account('a', { weeklyRemaining: 20 }),
    account('b', { active: false, weeklyRemaining: 60 }),
  ]).decision;
  assert.equal(first.situationClass, 'weekly-advantage');
  let state = advanceAttentionState(null, first, false);
  assert.equal(state.attention, false);
  state = advanceAttentionState(state, first, false);
  assert.equal(state.attention, false);
  const second = decide([
    account('a', { weeklyRemaining: 20, usageLastSuccessAtMs: NOW + 60_000 }),
    account('b', { active: false, weeklyRemaining: 60, usageLastSuccessAtMs: NOW + 60_000 }),
  ], NOW + 60_000).decision;
  state = advanceAttentionState(state, second, false);
  assert.equal(state.attention, true);
  assert.equal(first.fingerprint, second.fingerprint);
});

test('refreshing only one account does not count as a second observation', () => {
  const first = decide([
    account('a', { weeklyRemaining: 20 }),
    account('b', { active: false, weeklyRemaining: 60 }),
  ]).decision;
  let state = advanceAttentionState(null, first, false);
  const partial = decide([
    account('a', { weeklyRemaining: 20, usageLastSuccessAtMs: NOW + 60_000 }),
    account('b', { active: false, weeklyRemaining: 60 }),
  ], NOW + 60_000).decision;
  state = advanceAttentionState(state, partial, false);
  assert.equal(state.attention, false);
});

test('focus acknowledges the situation and no new alert occurs on blur', () => {
  const decision = decide([
    account('a', { weeklyRemaining: 20 }),
    account('b', { active: false, weeklyRemaining: 60 }),
  ]).decision;
  let state = advanceAttentionState(null, decision, true);
  assert.equal(state.attention, false);
  state = advanceAttentionState(state, decision, false);
  assert.equal(state.attention, false);
  assert.equal(state.acknowledged[decision.fingerprint], true);
});

test('two distinct resolved observations re-arm the same fingerprint', () => {
  const inputs = [account('a', { weeklyRemaining: 0 }), account('b', { active: false })];
  const alert = decide(inputs).decision;
  let state = advanceAttentionState(null, alert, false);
  assert.equal(state.attention, true);
  state = advanceAttentionState(state, alert, true);
  assert.equal(state.attention, false);
  const resolved1 = decide([
    account('a', { usageLastSuccessAtMs: NOW + 60_000 }),
    account('b', { active: false, usageLastSuccessAtMs: NOW + 60_000 }),
  ], NOW + 60_000).decision;
  assert.equal(resolved1.worthy, false);
  state = advanceAttentionState(state, resolved1, false);
  assert.equal(state.acknowledged[alert.fingerprint], true);
  const resolved2 = decide([
    account('a', { usageLastSuccessAtMs: NOW + 120_000 }),
    account('b', { active: false, usageLastSuccessAtMs: NOW + 120_000 }),
  ], NOW + 120_000).decision;
  state = advanceAttentionState(state, resolved2, false);
  assert.equal(state.acknowledged[alert.fingerprint], undefined);
  state = advanceAttentionState(state, alert, false);
  assert.equal(state.attention, true);
});

test('stale observation and unverified active data fail closed', () => {
  const stale = decide([
    account('a', { weeklyRemaining: 20, usageLastSuccessAtMs: NOW - 240_000 }),
    account('b', { active: false, weeklyRemaining: 60 }),
  ]);
  assert.equal(stale.decision.worthy, false);
  const unverified = decide([
    account('a', { usageQuality: 'unverified' }),
    account('b', { active: false, weeklyRemaining: 60 }),
  ]);
  assert.equal(unverified.recommendation.action, 'none');
  assert.equal(unverified.decision.worthy, false);
});

test('NEEDS_ACTIVATION and exhausted active accounts request immediate attention', () => {
  const dormant = decide([
    account('a'),
    account('b', { active: false, weeklyRemaining: 100, weeklyResetAt: NOW / 1000 }),
  ]).decision;
  assert.equal(dormant.situationClass, 'needs-activation');
  assert.equal(advanceAttentionState(null, dormant, false).attention, true);
  const exhausted = decide([
    account('a', { weeklyRemaining: 0 }),
    account('b', { active: false }),
  ]).decision;
  assert.equal(exhausted.situationClass, 'weekly-exhausted');
  assert.equal(advanceAttentionState(null, exhausted, false).attention, true);
  const fiveHour = decide([
    account('a', { fiveHourRemaining: 0 }),
    account('b', { active: false }),
  ]).decision;
  assert.equal(fiveHour.situationClass, 'five-hour-exhausted');
  assert.equal(advanceAttentionState(null, fiveHour, false).attention, true);
});

test('weekly-near-equal 5H attention only when active capacity is critical', () => {
  const critical = decide([
    account('a', { fiveHourRemaining: 1 }),
    account('b', { active: false, fiveHourRemaining: 80 }),
  ]).decision;
  assert.equal(critical.situationClass, 'five-hour-availability');
  const usable = decide([
    account('a', { fiveHourRemaining: 47 }),
    account('b', { active: false, fiveHourRemaining: 69 }),
  ]).decision;
  assert.equal(usable.worthy, false);
});

test('different target or situation class can alert without re-arming old fingerprint', () => {
  const first = decide([
    account('a', { weeklyRemaining: 20 }),
    account('b', { active: false, weeklyRemaining: 60 }),
  ]).decision;
  let state = advanceAttentionState(null, first, true);
  const urgent = decide([
    account('a', { weeklyRemaining: 0 }),
    account('b', { active: false, weeklyRemaining: 60 }),
  ]).decision;
  state = advanceAttentionState(state, urgent, false);
  assert.equal(state.attention, true);
  assert.notEqual(first.fingerprint, urgent.fingerprint);
});
