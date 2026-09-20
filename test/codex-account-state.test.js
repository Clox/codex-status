'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
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
  assert.deepEqual(result.errors, ['registry-active-key-mismatch', 'registry-account-id-mismatch']);
});
