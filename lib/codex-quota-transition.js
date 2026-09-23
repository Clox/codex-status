'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_VERSION = 1;

function defaultQuotaTransitionPath(env = process.env) {
  const cacheHome = env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache');
  return path.join(cacheHome, 'codex-account-switcher', 'quota-transition.json');
}

function emptyQuotaTransitionState() {
  return {
    version: STATE_VERSION,
    armed: false,
    phase: 'unknown',
    updatedAtMs: null,
    recoveredAtMs: null,
  };
}

function normalizeQuotaTransitionState(value) {
  if (!value || value.version !== STATE_VERSION) return emptyQuotaTransitionState();
  return {
    version: STATE_VERSION,
    armed: value.armed === true,
    phase: ['unknown', 'total-exhaustion', 'available'].includes(value.phase) ? value.phase : 'unknown',
    updatedAtMs: Number.isFinite(value.updatedAtMs) ? value.updatedAtMs : null,
    recoveredAtMs: Number.isFinite(value.recoveredAtMs) ? value.recoveredAtMs : null,
  };
}

function readQuotaTransitionState(filename = defaultQuotaTransitionPath()) {
  try {
    return normalizeQuotaTransitionState(JSON.parse(fs.readFileSync(filename, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyQuotaTransitionState();
    throw new Error('QUOTA_TRANSITION_STATE_INVALID');
  }
}

function atomicWriteJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

function quotaAvailabilitySnapshot(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const verified = rows.length > 0 && rows.every(account =>
    account?.accountId && account.usageQuality === 'verified'
  );
  if (!verified) return { verified: false, totalExhaustion: false, usableAccounts: [] };

  const quotaUnavailable = account => account.verifiedExhausted === true ||
    (account.ordinaryUsageAllowedObserved === true && account.ordinaryUsageAllowed === false);
  const usableAccounts = rows.filter(account =>
    !quotaUnavailable(account) &&
    !(account.ordinaryUsageAllowedObserved === true && account.ordinaryUsageAllowed !== true) &&
    account.fiveHourRemaining > 0 &&
    account.weeklyRemaining > 0
  ).map(account => ({ accountId: account.accountId, label: account.label }));

  return {
    verified: true,
    totalExhaustion: rows.every(quotaUnavailable),
    usableAccounts,
  };
}

function advanceQuotaTransition(previousInput, snapshot, nowMs = Date.now()) {
  const previous = normalizeQuotaTransitionState(previousInput);
  if (!snapshot?.verified) return { state: previous, event: null };
  if (snapshot.totalExhaustion) {
    if (previous.armed && previous.phase === 'total-exhaustion') {
      return { state: previous, event: null };
    }
    return {
      state: {
        ...previous,
        armed: true,
        phase: 'total-exhaustion',
        updatedAtMs: nowMs,
      },
      event: null,
    };
  }
  if (!Array.isArray(snapshot.usableAccounts) || snapshot.usableAccounts.length === 0) {
    return { state: previous, event: null };
  }
  if (!previous.armed && previous.phase === 'available') {
    return { state: previous, event: null };
  }
  const recoveredAtMs = previous.armed ? nowMs : previous.recoveredAtMs;
  return {
    state: {
      ...previous,
      armed: false,
      phase: 'available',
      updatedAtMs: nowMs,
      recoveredAtMs,
    },
    event: previous.armed ? {
      type: 'quota-available',
      accounts: snapshot.usableAccounts,
      fingerprint: `quota-recovered:${nowMs}`,
    } : null,
  };
}

module.exports = {
  STATE_VERSION,
  advanceQuotaTransition,
  atomicWriteJson,
  defaultQuotaTransitionPath,
  emptyQuotaTransitionState,
  normalizeQuotaTransitionState,
  quotaAvailabilitySnapshot,
  readQuotaTransitionState,
};
