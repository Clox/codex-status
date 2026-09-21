'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  activationHoldForAccount,
  assertQuotaActivationAllowed,
  readActivationHolds,
} = require('../lib/codex-activation-hold');

const ACCOUNT_ID = 'stable-account-id';

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function holdDocument() {
  return {
    version: 1,
    accounts: {
      [ACCOUNT_ID]: {
        enabled: true,
        blockQuotaActivation: true,
        reason: 'weekly-observation',
      },
    },
  };
}

test('hold matches only the stable account identity', () => {
  const holds = holdDocument();
  assert.deepEqual(activationHoldForAccount(holds, ACCOUNT_ID), {
    reason: 'weekly-observation',
    createdAt: null,
  });
  assert.equal(activationHoldForAccount(holds, 'other-account-id'), null);
});

test('turn-boundary assertion rereads the hold file and fails closed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-hold-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'activation-holds.json');
  writeJson(filename, { version: 1, accounts: {} });
  assert.doesNotThrow(() => assertQuotaActivationAllowed(ACCOUNT_ID, filename));
  writeJson(filename, holdDocument());
  assert.throws(() => assertQuotaActivationAllowed(ACCOUNT_ID, filename), /ACTIVATION_OBSERVATION_HOLD/);
});

test('missing hold file is empty while malformed state fails closed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-hold-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readActivationHolds(path.join(root, 'missing.json')), { version: 1, accounts: {} });
  const malformed = path.join(root, 'malformed.json');
  fs.writeFileSync(malformed, '{}\n');
  assert.throws(() => readActivationHolds(malformed), /ACTIVATION_HOLDS_INVALID/);
  writeJson(malformed, { version: 1, accounts: { [ACCOUNT_ID]: { enabled: true } } });
  assert.throws(() => readActivationHolds(malformed), /ACTIVATION_HOLDS_INVALID/);
});
