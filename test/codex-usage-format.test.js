'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  USAGE_BLOCKS,
  activationObservationHoldLine,
  activationProblemLine,
  activationWorkerProblem,
  tableCell,
  usageBlock,
  usageProblemLine,
  weeklyUrgencyLabel,
} = require('../lib/codex-usage-format');

test('maps the complete 0-100% scale to eighth-block glyphs', () => {
  const percentages = [0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  assert.deepEqual(percentages.map(usageBlock), USAGE_BLOCKS);
});

test('rounds intermediate percentages to the nearest block level', () => {
  assert.equal(usageBlock(6), ' ');
  assert.equal(usageBlock(7), '▁');
  assert.equal(usageBlock(73), '▆');
  assert.equal(usageBlock(94), '█');
});

test('clamps out-of-range values and handles missing data', () => {
  assert.equal(usageBlock(-20), ' ');
  assert.equal(usageBlock(140), '█');
  assert.equal(usageBlock(Number.NaN), ' ');
});

test('shows START instead of a false W%/H value for an unstarted weekly cycle', () => {
  assert.equal(weeklyUrgencyLabel({
    needsActivation: true,
    weeklyResetHours: 0,
    weeklyUrgency: 0,
  }), 'START');
});

test('shows normal W%/H after the weekly cycle has started', () => {
  assert.equal(weeklyUrgencyLabel({
    needsActivation: false,
    weeklyResetHours: 168,
    weeklyUrgency: 100 / 168,
  }), '0.60');
});

test('marks stale usage and replaces unverified urgency with an error status', () => {
  assert.equal(weeklyUrgencyLabel({
    needsActivation: false,
    weeklyResetHours: 10,
    weeklyUrgency: 1.23,
    usageQuality: 'stale',
  }), '1.23~');
  assert.equal(weeklyUrgencyLabel({
    needsActivation: false,
    weeklyResetHours: Number.POSITIVE_INFINITY,
    weeklyUrgency: 1.23,
    usageQuality: 'unverified',
    errorKind: 'no-server-data',
  }), 'ERROR');
  assert.equal(weeklyUrgencyLabel({
    usageQuality: 'unverified',
    errorKind: 'auth-401',
  }), 'AUTH');
});

test('problem text makes 401 and dead refresher action-required without leaking details', () => {
  assert.match(usageProblemLine({
    label: 'Account A',
    usageQuality: 'unverified',
    errorKind: 'auth-401',
    httpStatus: 401,
  }), /AUTH ERROR \/ ACTION REQUIRED.*HTTP 401.*re-login/);
  assert.match(usageProblemLine({
    label: 'Account B',
    usageQuality: 'unverified',
    errorKind: 'worker-stale',
    usageAgeMs: 8 * 3_600_000,
  }), /UNVERIFIED \/ ACTION REQUIRED.*8 h sedan.*Starta om statusfönstret/);
});

test('activation failures and dead worker are visible without changing usage quality', () => {
  assert.match(activationProblemLine({ label: 'Account A', usageQuality: 'verified' }, {
    phase: 'blocked',
    errorKind: 'FIVE_HOUR_ACTIVATION_NOT_VERIFIED',
  }), /5H ACTIVATION ERROR \/ ACTION REQUIRED.*ingen automatisk retry/);
  assert.match(activationWorkerProblem({
    enabled: true,
    healthy: false,
    ageMs: 4 * 60_000,
    fatalErrorKind: null,
  }), /heartbeat uppdateras inte.*4 min sedan/);
  assert.equal(activationWorkerProblem({ enabled: true, healthy: true }), null);
});

test('activation auth-state diagnostics expose only normalized changed field names', () => {
  const line = activationProblemLine({ label: 'Account A' }, {
    phase: 'blocked',
    errorKind: 'GLOBAL_AUTH_STATE_CHANGED',
    diagnosticFields: ['auth.globalAuthHash', 'registry.activeAccountKey'],
  });
  assert.match(line, /auth\.globalAuthHash/);
  assert.match(line, /registry\.activeAccountKey/);
});

test('observation hold is informational and not presented as an activation error', () => {
  const line = activationObservationHoldLine({ label: 'Account A' }, { reason: 'weekly-observation' });
  assert.match(line, /WEEKLY OBSERVATION HOLD.*activation-turns är blockerade.*rå weekly-historik fortsätter/);
  assert.doesNotMatch(line, /ERROR|ACTION REQUIRED/);
  assert.equal(activationProblemLine({ label: 'Account A' }, {
    phase: 'cooldown',
    errorKind: 'ACTIVATION_OBSERVATION_HOLD',
  }), null);
});

test('renders a vertical boundary while preserving the cell content width', () => {
  assert.equal(tableCell('ACCOUNT', 10), 'ACCOUNT  │ ');
  assert.equal(tableCell('a-long-account', 10), 'a-long-ac│ ');
  assert.equal(Array.from(tableCell('RESET', 9)).length, 10);
});
