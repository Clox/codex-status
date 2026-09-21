'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ACTIVATION_HOLDS_VERSION = 1;

function defaultActivationHoldsPath() {
  return process.env.ACTIVATION_HOLDS_FILE || path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'codex-account-switcher',
    'activation-holds.json'
  );
}

function readActivationHolds(filename = defaultActivationHoldsPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (parsed?.version !== ACTIVATION_HOLDS_VERSION ||
        !parsed.accounts ||
        typeof parsed.accounts !== 'object' ||
        Array.isArray(parsed.accounts) ||
        Object.entries(parsed.accounts).some(([accountId, hold]) =>
          !accountId || !hold || typeof hold !== 'object' || Array.isArray(hold) ||
          typeof hold.enabled !== 'boolean' || typeof hold.blockQuotaActivation !== 'boolean')) {
      throw new Error('ACTIVATION_HOLDS_INVALID');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: ACTIVATION_HOLDS_VERSION, accounts: {} };
    if (error.message === 'ACTIVATION_HOLDS_INVALID') throw error;
    throw new Error('ACTIVATION_HOLDS_INVALID');
  }
}

function activationHoldForAccount(holds, accountId) {
  if (!accountId) return null;
  const hold = holds?.accounts?.[accountId];
  if (!hold || hold.enabled !== true || hold.blockQuotaActivation !== true) return null;
  return {
    reason: hold.reason === 'weekly-observation' ? hold.reason : 'observation',
    createdAt: typeof hold.createdAt === 'string' ? hold.createdAt : null,
  };
}

function assertQuotaActivationAllowed(accountId, filename = defaultActivationHoldsPath()) {
  const hold = activationHoldForAccount(readActivationHolds(filename), accountId);
  if (hold) throw new Error('ACTIVATION_OBSERVATION_HOLD');
}

module.exports = {
  ACTIVATION_HOLDS_VERSION,
  activationHoldForAccount,
  assertQuotaActivationAllowed,
  defaultActivationHoldsPath,
  readActivationHolds,
};
