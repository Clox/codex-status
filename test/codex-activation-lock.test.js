'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  acquireAccountActivationLock,
  lockPathForAccount,
  releaseAccountActivationLock,
} = require('../lib/codex-activation-lock');

test('per-account activation lock prevents parallel activation and can be released', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-lock-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lock = acquireAccountActivationLock(directory, 'account-secret');
  assert.throws(() => acquireAccountActivationLock(directory, 'account-secret'), /ACTIVATION_ALREADY_RUNNING/);
  assert.equal(path.basename(lock.filename).includes('account-secret'), false);
  releaseAccountActivationLock(lock);
  const second = acquireAccountActivationLock(directory, 'account-secret');
  releaseAccountActivationLock(second);
});

test('dead owner lock is recovered without storing the account id', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-lock-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(directory, { recursive: true });
  const filename = lockPathForAccount(directory, 'account-secret');
  fs.writeFileSync(filename, JSON.stringify({ pid: 2_000_000_000, createdAtMs: 1 }));
  const lock = acquireAccountActivationLock(directory, 'account-secret');
  assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /account-secret/);
  releaseAccountActivationLock(lock);
});
