'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  colorAccountTableRow,
  normalizeAccountRow,
  recommendationLines,
  renderAccountTableRow,
} = require('../lib/codex-status-render');
const { rankAccounts, recommendAccount } = require('../lib/codex-account-ranking');

const NOW_MS = 1_800_000_000_000;
const columns = { account: 5, plan: 24, fiveHour: 30, weekly: 44, activity: 60 };

function normalize({ serverEntry = null, account = null, nowMs = NOW_MS } = {}) {
  const visible = '* 01 account-c@example.com Plus  -             -               Now';
  return normalizeAccountRow({
    visible,
    lineIndex: 2,
    rowMatch: visible.match(/^\s*\*?\s*0?(\d+)\s+/),
    columns,
    accounts: account ? [account] : [],
    serverUsageByAccountId: serverEntry ? { 'account-c': serverEntry } : {},
    exhaustionByAccountId: {},
    resetCreditsByAccountId: { 'account-c': { availableCount: 0, detailsComplete: true } },
    nowMs,
    cacheHealth: { healthy: true },
    configuredAccountNumber: matched => matched ? '3' : '-',
    formatRemaining: epoch => {
      const minutes = Math.ceil((epoch * 1000 - nowMs) / 60_000);
      return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
    },
  });
}

function normalizeExhausted({ serverEntry, account }) {
  const visible = '* 01 account-c@example.com Plus  -             -               Now';
  return normalizeAccountRow({
    visible,
    lineIndex: 2,
    rowMatch: visible.match(/^\s*\*?\s*0?(\d+)\s+/),
    columns,
    accounts: [account],
    serverUsageByAccountId: { 'account-c': serverEntry },
    exhaustionByAccountId: { 'account-c': { verified: true, pool: 'account' } },
    resetCreditsByAccountId: {},
    nowMs: NOW_MS,
    cacheHealth: { healthy: true },
    configuredAccountNumber: () => '3',
    formatRemaining: () => '2:00',
  });
}

function render(row) {
  return renderAccountTableRow(row, {
    columns,
    accountWidth: 20,
    resetWidth: 10,
    fiveHourWidth: 14,
    weeklyWidth: 16,
    weeklyUrgencyWidth: 7,
    nowMs: NOW_MS,
  });
}

test('repair followed by fresh refresh uses server usage despite missing registry last_usage', () => {
  const account = {
    account_key: 'user-c::account-c',
    chatgpt_account_id: 'account-c',
    email: 'account-c@example.com',
    alias: '',
  };
  const row = normalize({
    account,
    serverEntry: {
      primary: { remainingPercent: 100, resetsAt: NOW_MS / 1000 + 5 * 3600 },
      secondary: { remainingPercent: 11, resetsAt: NOW_MS / 1000 + 12 * 3600 },
      refresh: {
        lastSuccessAt: NOW_MS,
        lastAttemptAt: NOW_MS,
        lastErrorAt: null,
        errorKind: null,
        httpStatus: 200,
        consecutiveFailures: 0,
      },
    },
  });
  const ranked = rankAccounts([row], { nowMs: NOW_MS });
  const output = render(ranked[0]);

  assert.equal(row.usageQuality, 'verified');
  assert.match(output, /account-c@example\.c/);
  assert.match(output, /100% █ \(5:00\)/);
  assert.match(output, /11% ▁ \(12:00\)/);
  assert.doesNotMatch(output, /\bPlus\b/);
  assert.equal(recommendAccount(ranked).action, 'stay');
});

test('missing or unmapped data still renders inside the normalized schema', () => {
  const row = normalize();
  const ranked = rankAccounts([row], { nowMs: NOW_MS });
  const output = render(ranked[0]);
  const recommendation = recommendAccount(ranked);

  assert.equal(row.usageQuality, 'unverified');
  assert.equal(row.errorKind, 'identity-unmatched');
  assert.match(output, /account-c@example\.c/);
  assert.doesNotMatch(output, /\bPlus\b/);
  assert.match(output, /│\s+-\s*│\s+-\s*│ ERROR/);
  assert.equal(recommendation.action, 'none');
  assert.equal(recommendation.reason, 'active-unverified');
  assert.deepEqual(recommendationLines(recommendation).map(line => line.replace(/\x1b\[[0-9;]*m/g, '')), [
    'RECOMMENDATION PAUSED:',
    'Active account account-c@example.c is UNVERIFIED',
    'No safe account recommendation is available',
  ]);
});

test('missing recommendation object still renders an explicit paused reason', () => {
  assert.deepEqual(recommendationLines(null).map(line => line.replace(/\x1b\[[0-9;]*m/g, '')), [
    'RECOMMENDATION PAUSED:',
    'Insufficient normalized account data',
  ]);
});

test('row coloring leaves vertical column separators in the terminal default color', () => {
  const color = '\x1b[0;32m';
  const rendered = '01 account │ 1×025:04│ 100% READY │ Now  ACTIVE';
  const output = colorAccountTableRow(rendered, color);

  assert.equal(output.replace(/\x1b\[[0-9;]*m/g, ''), rendered);
  assert.equal((output.match(/\x1b\[0m│\x1b\[0;32m/g) || []).length, 3);
  assert.equal(output, `${color}01 account \x1b[0m│${color} 1×025:04\x1b[0m│${color} 100% READY \x1b[0m│${color} Now  ACTIVE\x1b[0m`);
});

test('verified account-level exhaustion is rendered without inventing a 5H or weekly pool', () => {
  const account = { chatgpt_account_id: 'account-c', email: 'account-c@example.com' };
  const serverEntry = {
    primary: { remainingPercent: 0, resetsAt: NOW_MS / 1000 + 7200 },
    secondary: { remainingPercent: 20, resetsAt: NOW_MS / 1000 + 7200 },
    refresh: { lastSuccessAt: NOW_MS, lastAttemptAt: NOW_MS, errorKind: null, consecutiveFailures: 0 },
  };
  const row = normalizeExhausted({ account, serverEntry });
  const ranked = rankAccounts([row], { nowMs: NOW_MS });
  const output = render(ranked[0]);
  assert.equal(row.verifiedExhausted, true);
  assert.match(output, /0%\s+\(2:00\)/);
  assert.match(output, /20% ▂ \(2:00\)/);
  assert.match(output, /ACTIVE$/);
  assert.doesNotMatch(output, /EXHAUSTED/);
  assert.equal(recommendAccount(ranked).reason, 'insufficient-verified-data');
});

test('renders confirmed synthetic moving 5H and weekly deadlines as READY and START', () => {
  const account = {
    account_key: 'user-c::account-c',
    chatgpt_account_id: 'account-c',
    email: 'account-c@example.com',
    alias: '',
  };
  const firstAt = NOW_MS - 60_000;
  const serverEntry = {
    primary: { remainingPercent: 100, resetsAt: NOW_MS / 1000 + 18_000 },
    secondary: { remainingPercent: 100, resetsAt: NOW_MS / 1000 + 604_800 },
    observations: {
      primary: [
        {
          observedAtMs: firstAt,
          serverObservedAtMs: firstAt,
          usedPercent: 0,
          limitWindowSeconds: 18_000,
          resetAfterSeconds: 18_000,
          resetAt: firstAt / 1000 + 18_000,
        },
        {
          observedAtMs: NOW_MS,
          serverObservedAtMs: NOW_MS,
          usedPercent: 0,
          limitWindowSeconds: 18_000,
          resetAfterSeconds: 18_000,
          resetAt: NOW_MS / 1000 + 18_000,
        },
      ],
      secondary: [
        {
          observedAtMs: firstAt,
          serverObservedAtMs: firstAt,
          usedPercent: 0,
          limitWindowSeconds: 604_800,
          resetAfterSeconds: 604_800,
          resetAt: firstAt / 1000 + 604_800,
        },
        {
          observedAtMs: NOW_MS,
          serverObservedAtMs: NOW_MS,
          usedPercent: 0,
          limitWindowSeconds: 604_800,
          resetAfterSeconds: 604_800,
          resetAt: NOW_MS / 1000 + 604_800,
        },
      ],
    },
    refresh: {
      lastSuccessAt: NOW_MS,
      lastAttemptAt: NOW_MS,
      lastErrorAt: null,
      errorKind: null,
      httpStatus: 200,
      consecutiveFailures: 0,
    },
  };

  for (const offset of [0, 10_000, 70_000]) {
    const row = normalize({ account, serverEntry, nowMs: NOW_MS + offset });
    const ranked = rankAccounts([row], { nowMs: NOW_MS + offset });
    assert.equal(row.fiveHourDormant, true);
    assert.equal(row.weeklyDormant, true);
    assert.equal(ranked[0].needsActivation, true);
    assert.equal(row.fiveHour, '100% █ READY');
    assert.equal(row.weekly, '100% █ READY');
    assert.match(render(ranked[0]), /START/);
    assert.doesNotMatch(row.fiveHour, /4:59|5:00|5:01/);
    assert.doesNotMatch(row.weekly, /167:59|168:00|168:01/);
  }
});

test('renders a fixed active 100 percent weekly deadline as a normal countdown', () => {
  const account = {
    account_key: 'user-c::account-c',
    chatgpt_account_id: 'account-c',
    email: 'account-c@example.com',
    alias: '',
  };
  const firstAt = NOW_MS - 60_000;
  const fixedResetAt = NOW_MS / 1000 + 604_800;
  const serverEntry = {
    primary: { remainingPercent: 50, resetsAt: NOW_MS / 1000 + 9_000 },
    secondary: { remainingPercent: 100, resetsAt: fixedResetAt },
    observations: {
      secondary: [
        {
          observedAtMs: firstAt,
          serverObservedAtMs: firstAt,
          usedPercent: 0,
          limitWindowSeconds: 604_800,
          resetAfterSeconds: 604_800,
          resetAt: fixedResetAt,
        },
        {
          observedAtMs: NOW_MS,
          serverObservedAtMs: NOW_MS,
          usedPercent: 0,
          limitWindowSeconds: 604_800,
          resetAfterSeconds: 604_740,
          resetAt: fixedResetAt,
        },
      ],
    },
    refresh: {
      lastSuccessAt: NOW_MS,
      lastAttemptAt: NOW_MS,
      lastErrorAt: null,
      errorKind: null,
      httpStatus: 200,
      consecutiveFailures: 0,
    },
  };
  const row = normalize({ account, serverEntry });
  const ranked = rankAccounts([row], { nowMs: NOW_MS });

  assert.equal(row.weeklyDormant, false);
  assert.equal(row.weekly, '100% █ (168:00)');
  assert.equal(ranked[0].needsActivation, false);
});
