'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertAccountNotVerifiedExhausted,
  verifiedExhaustionForAccount,
} = require('../lib/codex-activation-account');

const ACCOUNT_ID = 'account-a';

function verifiedExhaustion(overrides = {}) {
  return {
    accountId: ACCOUNT_ID,
    verified: true,
    errorKind: 'usageLimitExceeded',
    willRetry: false,
    turnStatus: 'failed',
    threadIdentityVerified: true,
    observedAtMs: 1_000,
    ...overrides,
  };
}

test('only the complete terminal usageLimitExceeded invariant blocks activation', () => {
  const state = { exhaustions: { [ACCOUNT_ID]: verifiedExhaustion() } };
  assert.equal(verifiedExhaustionForAccount(state, ACCOUNT_ID)?.observedAtMs, 1_000);
  for (const incomplete of [
    verifiedExhaustion({ verified: false }),
    verifiedExhaustion({ willRetry: true }),
    verifiedExhaustion({ turnStatus: 'completed' }),
    verifiedExhaustion({ errorKind: 'other' }),
    verifiedExhaustion({ threadIdentityVerified: false }),
  ]) {
    assert.equal(verifiedExhaustionForAccount({ exhaustions: { [ACCOUNT_ID]: incomplete } }, ACCOUNT_ID), null);
  }
});

test('persistent exhaustion guard fails closed without treating a percentage as exhaustion', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-exhaustion-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'turn-events.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    exhaustions: {},
    usage: { remainingPercent: 0 },
  }));
  assert.doesNotThrow(() => assertAccountNotVerifiedExhausted(stateFile, ACCOUNT_ID));

  fs.writeFileSync(stateFile, JSON.stringify({
    exhaustions: { [ACCOUNT_ID]: verifiedExhaustion() },
  }));
  assert.throws(() => assertAccountNotVerifiedExhausted(stateFile, ACCOUNT_ID), /ACCOUNT_VERIFIED_EXHAUSTED/);
  assert.throws(() => assertAccountNotVerifiedExhausted(path.join(root, 'missing.json'), ACCOUNT_ID), /ACTIVATION_EXHAUSTION_STATE_UNVERIFIED/);
});
