'use strict';

const crypto = require('crypto');
const { assessCacheHealth, isFiveHourDormant, usageQuality } = require('./codex-usage-cache');

const ACTIVATION_STATE_VERSION = 1;
const PRE_TURN_FAILURE_COOLDOWN_MS = 15 * 60_000;
const WORKER_STALE_AFTER_MS = 3 * 60_000;

const SAFE_ERROR_CODES = new Set([
  'ACCOUNT_CREDENTIAL_MISSING',
  'ACTIVATION_STATE_READ_FAILED',
  'ACCOUNT_NOT_FIVE_HOUR_DORMANT',
  'ACTIVATION_OBSERVATION_HOLD',
  'ACTIVATION_HOLDS_INVALID',
  'ACTIVATION_ALREADY_RUNNING',
  'ACTIVATION_LOCK_UNAVAILABLE',
  'APP_SERVER_CAPABILITY_MISMATCH',
  'APP_SERVER_START_FAILED',
  'APP_SERVER_EXITED',
  'APP_SERVER_PROTOCOL_OVERFLOW',
  'APP_SERVER_PROTOCOL_MISMATCH',
  'APP_SERVER_CREDENTIAL_ECHO',
  'APP_SERVER_UNEXPECTED_SERVER_REQUEST',
  'APP_SERVER_UNEXPECTED_TOOL_USE',
  'APP_SERVER_REQUEST_FAILED',
  'APP_SERVER_AUTH_MISMATCH',
  'APP_SERVER_THREAD_MISMATCH',
  'APP_SERVER_TURN_MISMATCH',
  'APP_SERVER_TURN_FAILED',
  'APP_SERVER_TIMEOUT',
  'FIVE_HOUR_ACTIVATION_NOT_VERIFIED',
  'GLOBAL_AUTH_STATE_CHANGED',
  'USAGE_REFRESHER_FAILED',
  'USAGE_REQUEST_FAILED',
  'USAGE_PROTOCOL_MISMATCH',
]);

function safeErrorKind(error) {
  const code = String(error?.message || 'UNKNOWN_ERROR');
  if (SAFE_ERROR_CODES.has(code) || /^USAGE_HTTP_\d{3}$/.test(code)) return code;
  return 'UNEXPECTED_ERROR';
}

function safeDiagnosticFields(error) {
  if (!Array.isArray(error?.authStateChanges)) return null;
  const safe = error.authStateChanges.filter(value =>
    typeof value === 'string' &&
    /^(auth\.(globalAuthHash|snapshotHash:[A-Za-z0-9._-]+)|registry\.(activeAccountKey|activeAccountActivatedAtMs|accountIdentities))$/.test(value)
  );
  return safe.length > 0 ? [...new Set(safe)].sort() : null;
}

function accountIdOf(account) {
  return account?.chatgpt_account_id || account?.accountId || null;
}

function latestDormantObservationAt(entry) {
  const observations = entry?.observations?.primary;
  if (!Array.isArray(observations) || observations.length === 0) return null;
  const observedAtMs = Number(observations.at(-1)?.observedAtMs);
  return Number.isFinite(observedAtMs) ? observedAtMs : null;
}

function verifiedNonDormant(entry, cacheHealth, nowMs) {
  return usageQuality(entry, { nowMs, cacheHealth }) === 'verified' &&
    !isFiveHourDormant(entry, { nowMs, cacheHealth });
}

function newDormantWindowAfterSuccess(entry, accountState) {
  const activatedResetAt = Number(accountState?.activatedResetAt);
  const observedAtMs = latestDormantObservationAt(entry);
  return Number.isFinite(activatedResetAt) &&
    Number.isFinite(observedAtMs) &&
    observedAtMs > activatedResetAt * 1000 + 60_000;
}

function initialState(previousState, nowMs) {
  return {
    version: ACTIVATION_STATE_VERSION,
    enabled: true,
    worker: {
      ...(previousState?.worker || {}),
      pid: process.pid,
      heartbeatAtMs: nowMs,
      lastStartedAtMs: nowMs,
      lastFatalAtMs: null,
      fatalErrorKind: null,
    },
    accounts: { ...(previousState?.accounts || {}) },
  };
}

async function runFiveHourActivationCycle({
  accounts,
  usageCache,
  previousState = {},
  activateAccount,
  activationHoldForAccount = () => null,
  persistState = async () => {},
  now = () => Date.now(),
  createAttemptId = () => crypto.randomUUID(),
}) {
  let state = initialState(previousState, now());
  await persistState(state);
  const cacheHealth = assessCacheHealth(usageCache, now());

  for (const account of accounts) {
    const accountId = accountIdOf(account);
    if (!accountId) continue;
    const entry = usageCache?.accounts?.[accountId];
    const dormant = isFiveHourDormant(entry, { nowMs: now(), cacheHealth });
    const prior = state.accounts[accountId] || { phase: 'idle' };

    if (!dormant) {
      if (verifiedNonDormant(entry, cacheHealth, now())) {
        state.accounts[accountId] = {
          phase: 'idle',
          lastObservedActiveAtMs: now(),
          lastSuccessAtMs: prior.lastSuccessAtMs || null,
        };
      }
      continue;
    }

    const hold = activationHoldForAccount(account);
    if (hold) {
      // A hold must never erase a journal entry that forbids retrying a possibly sent turn.
      if (!['succeeded', 'blocked', 'turn-committed'].includes(prior.phase)) {
        state.accounts[accountId] = {
          ...prior,
          phase: 'held',
          holdReason: hold.reason,
          heldAtMs: now(),
          actionRequired: false,
          errorKind: null,
        };
      }
      continue;
    }

    const representsNewWindow = newDormantWindowAfterSuccess(entry, prior);
    if (!representsNewWindow && ['succeeded', 'blocked', 'turn-committed'].includes(prior.phase)) {
      if (prior.phase === 'turn-committed') {
        state.accounts[accountId] = {
          ...prior,
          phase: 'blocked',
          errorKind: 'INTERRUPTED_AFTER_TURN_COMMIT',
          actionRequired: true,
          lastErrorAtMs: now(),
        };
        await persistState(state);
      }
      continue;
    }
    if (!representsNewWindow && Number(prior.cooldownUntilMs) > now()) continue;

    const attemptId = createAttemptId();
    const dormantObservedAtMs = latestDormantObservationAt(entry);
    let turnCommitted = false;
    state.accounts[accountId] = {
      phase: 'revalidating',
      attemptId,
      dormantObservedAtMs,
      lastAttemptAtMs: now(),
      actionRequired: false,
      errorKind: null,
    };
    await persistState(state);

    try {
      const result = await activateAccount(account, {
        beforeTurn: async () => {
          turnCommitted = true;
          state.accounts[accountId] = {
            ...state.accounts[accountId],
            phase: 'turn-committed',
            turnCommittedAtMs: now(),
          };
          await persistState(state);
        },
      });
      state.accounts[accountId] = {
        ...state.accounts[accountId],
        phase: 'succeeded',
        lastSuccessAtMs: now(),
        activatedResetAt: Number.isFinite(Number(result?.activatedResetAt))
          ? Number(result.activatedResetAt)
          : null,
        actionRequired: false,
        errorKind: null,
      };
    } catch (error) {
      const errorKind = safeErrorKind(error);
      const changedBeforeTurn = !turnCommitted && errorKind === 'ACCOUNT_NOT_FIVE_HOUR_DORMANT';
      state.accounts[accountId] = {
        ...state.accounts[accountId],
        phase: turnCommitted ? 'blocked' : 'cooldown',
        lastErrorAtMs: now(),
        errorKind,
        diagnosticFields: safeDiagnosticFields(error),
        actionRequired: turnCommitted,
        turnSentOrUncertain: turnCommitted,
        cooldownUntilMs: turnCommitted
          ? null
          : now() + (changedBeforeTurn ? 5 * 60_000 : PRE_TURN_FAILURE_COOLDOWN_MS),
      };
    }
    await persistState(state);
  }

  state.worker = {
    ...state.worker,
    heartbeatAtMs: now(),
    lastCompletedAtMs: now(),
    pid: null,
  };
  await persistState(state);
  return state;
}

function activationWorkerHealth(state, nowMs = Date.now()) {
  const heartbeatAtMs = Number(state?.worker?.heartbeatAtMs);
  const ageMs = Number.isFinite(heartbeatAtMs)
    ? Math.max(0, nowMs - heartbeatAtMs)
    : Number.POSITIVE_INFINITY;
  return {
    enabled: state?.enabled === true,
    healthy: state?.enabled === true && !state?.worker?.fatalErrorKind && ageMs <= WORKER_STALE_AFTER_MS,
    heartbeatAtMs: Number.isFinite(heartbeatAtMs) ? heartbeatAtMs : null,
    ageMs,
    fatalErrorKind: state?.worker?.fatalErrorKind || null,
  };
}

module.exports = {
  ACTIVATION_STATE_VERSION,
  PRE_TURN_FAILURE_COOLDOWN_MS,
  WORKER_STALE_AFTER_MS,
  activationWorkerHealth,
  newDormantWindowAfterSuccess,
  runFiveHourActivationCycle,
  safeDiagnosticFields,
  safeErrorKind,
};
