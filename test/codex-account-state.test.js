'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  resolveActiveAccount,
  resolveExpectedAccount,
  verifyActiveAccountState,
} = require('../lib/codex-account-state');

function registry(active = 'key-a') {
  return {
    active_account_key: active,
    accounts: [
      { account_key: 'key-a', email: 'a@example.com', chatgpt_account_id: 'account-a' },
      { account_key: 'key-b', email: 'b@example.com', chatgpt_account_id: 'account-b' },
    ],
  };
}

test('resolves the configured selector to one stable account id and key', () => {
  assert.deepEqual(resolveExpectedAccount(registry(), 'b@example.com'), {
    accountId: 'account-b',
    accountKey: 'key-b',
  });
});

test('resolves and verifies the currently active stable account identity', () => {
  assert.deepEqual(resolveActiveAccount(
    registry('key-b'),
    { tokens: { account_id: 'account-b', access_token: 'not-inspected' } },
  ), { accountId: 'account-b', accountKey: 'key-b' });
  assert.throws(() => resolveActiveAccount(
    registry('key-b'),
    { tokens: { account_id: 'account-a' } },
  ), /ACTIVE_ACCOUNT_STATE_MISMATCH/);
});

test('postcondition accepts matching global auth and registry state', () => {
  assert.deepEqual(verifyActiveAccountState({
    registry: registry('key-b'),
    globalAuth: { tokens: { account_id: 'account-b', access_token: 'secret-not-read' } },
    expectedAccountId: 'account-b',
    expectedAccountKey: 'key-b',
  }), { ok: true, errors: [] });
});

test('postcondition fails closed for either global auth or registry mismatch', () => {
  const result = verifyActiveAccountState({
    registry: registry('key-a'),
    globalAuth: { tokens: { account_id: 'account-b' } },
    expectedAccountId: 'account-b',
    expectedAccountKey: 'key-b',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['registry-active-key-mismatch', 'registry-active-account-id-mismatch']);
});

test('postcondition distinguishes missing registry target, active key, account id and global auth', () => {
  const missing = verifyActiveAccountState({
    registry: { active_account_key: 'missing-key', accounts: registry().accounts },
    globalAuth: { tokens: { account_id: 'wrong-global' } },
    expectedAccountId: 'account-c',
    expectedAccountKey: 'key-c',
  });
  assert.deepEqual(missing.errors, [
    'registry-target-account-missing',
    'registry-active-key-mismatch',
    'registry-active-account-missing',
    'global-auth-account-id-mismatch',
  ]);

  const wrongId = verifyActiveAccountState({
    registry: registry('key-b'),
    globalAuth: { tokens: { account_id: 'account-b' } },
    expectedAccountId: 'different-account-b',
    expectedAccountKey: 'key-b',
  });
  assert.deepEqual(wrongId.errors, [
    'registry-target-account-id-mismatch',
    'registry-active-account-id-mismatch',
    'global-auth-account-id-mismatch',
  ]);
});
