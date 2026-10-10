'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireOperationLock, validateAddition, validateRemoval, verifyMutation, safeLabel } = require('../lib/codex-account-manager');
const { upstreamSelector, resolveExpectedAccount } = require('../lib/codex-account-state');
const a = { account_key: 'user::a', chatgpt_account_id: 'a', email: 'a@example.test' };
const b = { account_key: 'user::b', chatgpt_account_id: 'b', email: 'b@example.test' };
const registry = { active_account_key: a.account_key, accounts: [a, b] };
const auth = { tokens: { account_id: 'a' } };

test('removal rejects active, missing, mismatched auth and duplicate account identities', () => {
  assert.equal(validateRemoval(registry, auth, b.account_key), b);
  assert.throws(() => validateRemoval(registry, auth, a.account_key), /aktiva/);
  assert.throws(() => validateRemoval(registry, auth, 'removed'), /inte längre/);
  assert.throws(() => validateRemoval(registry, { tokens: { account_id: 'other' } }, b.account_key), /MISMATCH/);
  assert.throws(() => validateRemoval({ ...registry, accounts: [a, { ...b, chatgpt_account_id: 'a' }] }, auth, b.account_key), /aktiva/);
});

test('addition accepts only one consistent fresh identity and rejects duplicate credentials', () => {
  const staged = { active_account_key: b.account_key, accounts: [b] };
  assert.equal(validateAddition({ accounts: [a] }, staged, { tokens: { account_id: 'b' } }), b);
  assert.throws(() => validateAddition(registry, staged, { tokens: { account_id: 'b' } }), /redan/);
  assert.throws(() => validateAddition({ accounts: [a] }, staged, auth), /verifieras/);
  assert.throws(() => validateAddition({ accounts: [a] }, { ...staged, accounts: [a, b] }, auth), /verifieras/);
});

test('postcondition detects wrong removal, unrelated additions and changed global credentials', () => {
  const original = Buffer.from(JSON.stringify(auth));
  const after = { ...registry, accounts: [a] };
  verifyMutation(registry, after, b.account_key, 'remove', original, original);
  verifyMutation(after, registry, b.account_key, 'add', original, original);
  assert.throws(() => verifyMutation(registry, registry, b.account_key, 'remove', original, original), /Efterkontrollen/);
  assert.throws(() => verifyMutation(registry, after, b.account_key, 'remove', original, Buffer.from('changed')), /Efterkontrollen/);
});

test('stable keys survive row reorder and upstream selector fails closed for duplicate emails', () => {
  assert.equal(resolveExpectedAccount(registry, b.account_key).accountId, 'b');
  assert.equal(upstreamSelector({ ...registry, accounts: [b, a] }, b.account_key), b.email);
  assert.throws(() => upstreamSelector({ ...registry, accounts: [a, { ...b, email: a.email }] }, b.account_key), /NOT_UNIQUE/);
  assert.equal(upstreamSelector({ ...registry, accounts: [a, { ...b, email: a.email, alias: 'work' }] }, b.account_key), 'work');
  assert.throws(() => upstreamSelector(registry, 'missing'), /KEY_MISSING/);
});

test('operation lock excludes another manager and preserves incomplete locks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-lock-test-'));
  const lock = path.join(root, 'operation.lock');
  try {
    const release = acquireOperationLock(lock);
    assert.throws(() => acquireOperationLock(lock), /pågår/);
    release();
    fs.mkdirSync(lock);
    assert.throws(() => acquireOperationLock(lock), /pågår/);
    assert.ok(fs.existsSync(lock));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dynamic names cannot inject terminal controls', () => {
  assert.equal(safeLabel({ email: 'hello\x1b[2J\nworld' }), 'hello[2Jworld');
});
