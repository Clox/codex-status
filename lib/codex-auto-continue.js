'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveActiveAccount, resolveExpectedAccount } = require('./codex-account-state');
const { rankAccounts } = require('./codex-account-ranking');
const { pendingInterruptedTurns } = require('./codex-manual-resume');
const { observerHealth } = require('./codex-turn-observer');
const { continuationForCandidate } = require('./codex-turn-continuation');
const {
  assessCacheHealth,
  isWeeklyDormant,
  usageQuality,
} = require('./codex-usage-cache');

const AUTO_CONTINUE_STATE_VERSION = 2;
const AUTO_CONTINUE_PENDING_MS = 10_000;

function accountsFromRegistry(registry) {
  return Array.isArray(registry?.accounts)
    ? registry.accounts
    : Object.values(registry?.accounts || {});
}

function emptyAutoContinueState() {
  return {
    version: AUTO_CONTINUE_STATE_VERSION,
    status: 'idle',
    heartbeatAtMs: null,
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
    errorKind: null,
    actionRequired: false,
    candidateThreadId: null,
    candidateTurnId: null,
    targetAccountId: null,
    pending: null,
    suppression: null,
  };
}

function normalizeAutoContinueState(value) {
  const normalized = {
    ...emptyAutoContinueState(),
    ...(value && typeof value === 'object' ? value : {}),
    version: AUTO_CONTINUE_STATE_VERSION,
  };
  normalized.pending = normalized.pending && typeof normalized.pending === 'object'
    ? normalized.pending
    : null;
  normalized.suppression = normalized.suppression && typeof normalized.suppression === 'object'
    ? normalized.suppression
    : null;
  return normalized;
}

function writeAutoContinueStateFile(filePath, stateInput) {
  const state = normalizeAutoContinueState(stateInput);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return state;
}

function autoPlanDescriptor(decision) {
  if (decision?.action !== 'resume') return null;
  const candidates = decision.candidates.map(candidate => {
    const continuation = continuationForCandidate(candidate);
    if (!continuation.ok) throw new Error(continuation.reason || 'AUTO_CONTINUATION_UNVERIFIED');
    return {
      sourceAccountId: candidate.accountId || null,
      threadId: candidate.threadId,
      failedTurnId: candidate.turnId,
      interruptionClass: candidate.interruptionClass,
      inputHash: continuation.inputHash,
    };
  });
  return {
    sourceAccountId: decision.active?.accountId || null,
    targetAccountId: decision.target?.accountId || null,
    targetAccountKey: decision.target?.accountKey || null,
    candidates,
  };
}

function autoPlanFingerprint(decision) {
  const descriptor = autoPlanDescriptor(decision);
  if (!descriptor) return null;
  return crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
}

function isAutoPlanSuppressed(stateInput, decision) {
  const fingerprint = autoPlanFingerprint(decision);
  return Boolean(fingerprint && normalizeAutoContinueState(stateInput).suppression?.fingerprint === fingerprint);
}

function requiresPendingCountdown(decision, desktopRunning) {
  return desktopRunning === true && decision?.action === 'resume' &&
    Boolean(decision.active?.accountId) &&
    decision.active.accountId !== decision.target?.accountId;
}

function createOrResumePending(stateInput, decision, nowMs = Date.now(), durationMs = AUTO_CONTINUE_PENDING_MS) {
  const state = normalizeAutoContinueState(stateInput);
  const descriptor = autoPlanDescriptor(decision);
  const fingerprint = autoPlanFingerprint(decision);
  if (!descriptor || !fingerprint) throw new Error('AUTO_PENDING_PLAN_INVALID');
  if (state.suppression?.fingerprint === fingerprint) {
    return {
      state: { ...state, status: 'suppressed', pending: null },
      outcome: 'suppressed',
      notificationClaimed: false,
    };
  }
  if (state.pending?.fingerprint === fingerprint) {
    return {
      state,
      outcome: 'resumed',
      notificationClaimed: state.pending.notificationDeliveredAtMs == null &&
        state.pending.notificationErrorKind == null,
    };
  }
  const primary = descriptor.candidates[0];
  const pending = {
    version: 1,
    fingerprint,
    sourceAccountId: descriptor.sourceAccountId,
    targetAccountId: descriptor.targetAccountId,
    threadId: primary?.threadId || null,
    failedTurnId: primary?.failedTurnId || null,
    interruptionClass: primary?.interruptionClass || null,
    inputHash: primary?.inputHash || null,
    candidates: descriptor.candidates,
    createdAtMs: nowMs,
    deadlineAtMs: nowMs + durationMs,
    notificationClaimedAtMs: nowMs,
    notificationReplaceId: Math.max(1, Number.parseInt(fingerprint.slice(0, 7), 16)),
    notificationDeliveredAtMs: null,
    notificationErrorKind: null,
  };
  return {
    state: {
      ...state,
      status: 'pending',
      errorKind: null,
      actionRequired: false,
      candidateThreadId: pending.threadId,
      candidateTurnId: pending.failedTurnId,
      targetAccountId: pending.targetAccountId,
      pending,
      suppression: null,
    },
    outcome: 'created',
    notificationClaimed: true,
  };
}

function pendingCountdownDecision(stateInput, decision, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  const fingerprint = autoPlanFingerprint(decision);
  if (!fingerprint) return { action: 'changed', remainingMs: 0 };
  if (state.suppression?.fingerprint === fingerprint) return { action: 'canceled', remainingMs: 0 };
  if (state.pending?.fingerprint !== fingerprint) return { action: 'changed', remainingMs: 0 };
  const remainingMs = Math.max(0, Number(state.pending.deadlineAtMs) - nowMs);
  return { action: remainingMs > 0 ? 'wait' : 'execute', remainingMs };
}

function cancelPendingAction(stateInput, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  if (!state.pending?.fingerprint) return { state, canceled: false };
  const suppression = {
    fingerprint: state.pending.fingerprint,
    canceledAtMs: nowMs,
    threadId: state.pending.threadId || null,
    failedTurnId: state.pending.failedTurnId || null,
    targetAccountId: state.pending.targetAccountId || null,
  };
  return {
    canceled: true,
    state: {
      ...state,
      status: 'canceled',
      heartbeatAtMs: nowMs,
      pending: null,
      suppression,
      errorKind: null,
      actionRequired: false,
    },
  };
}

function resetAutoContinueForToggle(stateInput, enabled, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  return {
    ...state,
    status: enabled ? 'idle' : 'disabled',
    heartbeatAtMs: nowMs,
    pending: null,
    suppression: null,
    errorKind: null,
    actionRequired: false,
  };
}

function reconcileSuppression(stateInput, decision) {
  const state = normalizeAutoContinueState(stateInput);
  if (!state.suppression) return state;
  if (decision?.action === 'idle' && decision?.reason === 'no-candidates') {
    return { ...state, suppression: null };
  }
  return state;
}

function pendingAttentionDecision(stateInput, enabled, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  const pending = state.pending;
  if (!enabled || state.status !== 'pending' || !pending?.fingerprint || Number(pending.deadlineAtMs) <= nowMs) {
    return null;
  }
  return {
    worthy: true,
    immediate: true,
    persistentUntilFocus: true,
    fingerprint: `auto-pending:${pending.fingerprint}`,
    situationClass: 'auto-continue-pending',
    observationKey: `auto-pending:${pending.fingerprint}`,
  };
}

function autoContinueStatusLine(preferences, stateInput, nowMs = Date.now()) {
  const enabled = preferences?.autoContinue === true;
  const state = normalizeAutoContinueState(stateInput);
  if (enabled && state.status === 'pending' && state.pending?.fingerprint) {
    const seconds = Math.max(0, Math.ceil((Number(state.pending.deadlineAtMs) - nowMs) / 1000));
    return `AUTO-CONTINUE: ON · Restart om ${seconds}s [X] Avbryt`;
  }
  return `AUTO-CONTINUE: ${enabled ? 'ON' : 'OFF'} [A] toggle`;
}

function configuredRegistryAccounts(registry, selectors) {
  const registryAccounts = accountsFromRegistry(registry);
  const resolved = selectors.map((selector, index) => {
    const identity = resolveExpectedAccount(registry, selector);
    const account = registryAccounts.find(item => item.account_key === identity.accountKey);
    if (!account) throw new Error('AUTO_CONFIGURED_ACCOUNT_MISSING');
    return {
      ...account,
      accountId: identity.accountId,
      accountKey: identity.accountKey,
      selector,
      sourceRow: String(index + 1),
    };
  });
  if (new Set(resolved.map(account => account.accountId)).size !== resolved.length) {
    throw new Error('AUTO_CONFIGURED_ACCOUNTS_NOT_UNIQUE');
  }
  return resolved;
}

function verifiedExhaustion(eventState, accountId) {
  const exhaustion = eventState?.exhaustions?.[accountId];
  return exhaustion?.verified === true &&
    exhaustion?.threadIdentityVerified === true &&
    exhaustion?.errorKind === 'usageLimitExceeded';
}

function freshUsage(usageCache, accountId, nowMs) {
  const cacheHealth = assessCacheHealth(usageCache, nowMs);
  const entry = usageCache?.accounts?.[accountId] || null;
  return {
    entry,
    quality: usageQuality(entry, { nowMs, cacheHealth }),
    cacheHealth,
  };
}

function usableAccount(row, usageEntry) {
  if (row.usageQuality !== 'verified' || row.verifiedExhausted) return false;
  if (usageEntry?.ordinaryUsageAllowedObserved === true && usageEntry.ordinaryUsageAllowed !== true) return false;
  return row.fiveHourRemaining > 0 && row.weeklyRemaining > 0;
}

function rankedConfiguredAccounts({ registry, globalAuth, usageCache, eventState, selectors, nowMs }) {
  const active = resolveActiveAccount(registry, globalAuth);
  const configured = configuredRegistryAccounts(registry, selectors);
  const rows = configured.map(account => {
    const usage = freshUsage(usageCache, account.accountId, nowMs);
    return {
      ...account,
      active: account.accountId === active.accountId,
      usageQuality: usage.quality,
      fiveHourRemaining: Number(usage.entry?.primary?.remainingPercent),
      fiveHourResetAt: Number(usage.entry?.primary?.resetsAt),
      weeklyRemaining: Number(usage.entry?.secondary?.remainingPercent),
      weeklyResetAt: Number(usage.entry?.secondary?.resetsAt),
      weeklyDormant: usage.quality === 'verified' && isWeeklyDormant(usage.entry, { nowMs }),
      verifiedExhausted: verifiedExhaustion(eventState, account.accountId),
      usageEntry: usage.entry,
    };
  });
  return { active, ranked: rankAccounts(rows, { nowMs }) };
}

function automationDecision({
  preferences,
  registry,
  globalAuth,
  usageCache,
  eventState,
  resumeState,
  selectors,
  nowMs = Date.now(),
}) {
  if (preferences?.autoContinue !== true) return { action: 'disabled', reason: 'auto-off' };
  if (!observerHealth(eventState, nowMs).healthy) {
    return { action: 'blocked', reason: 'observer-unverified', actionRequired: true };
  }
  if (Object.keys(eventState?.activeTurns || {}).length > 0) {
    return { action: 'waiting', reason: 'active-turns' };
  }
  const candidates = pendingInterruptedTurns(eventState, resumeState);
  if (candidates.length === 0) return { action: 'idle', reason: 'no-candidates' };
  for (const candidate of candidates) {
    const continuation = continuationForCandidate(candidate);
    if (!continuation.ok || candidate.classificationVerified !== true) {
      return {
        action: 'blocked',
        reason: continuation.reason || 'candidate-classification-unverified',
        actionRequired: true,
      };
    }
  }

  let rankedState;
  try {
    rankedState = rankedConfiguredAccounts({ registry, globalAuth, usageCache, eventState, selectors, nowMs });
  } catch (error) {
    return { action: 'blocked', reason: error.message || 'account-state-unverified', actionRequired: true };
  }
  const configuredIds = new Set(rankedState.ranked.map(account => account.accountId));
  if (candidates.some(candidate => !configuredIds.has(candidate.accountId))) {
    return { action: 'blocked', reason: 'candidate-account-unconfigured', actionRequired: true };
  }
  for (const sourceAccountId of new Set(candidates.map(candidate => candidate.accountId))) {
    if (freshUsage(usageCache, sourceAccountId, nowMs).quality !== 'verified') {
      return { action: 'blocked', reason: 'source-usage-unverified', actionRequired: true };
    }
  }

  const target = rankedState.ranked.find(account => usableAccount(account, account.usageEntry));
  if (!target) {
    const allVerified = rankedState.ranked.every(account => account.usageQuality === 'verified');
    return allVerified
      ? { action: 'waiting', reason: 'no-usable-target' }
      : { action: 'blocked', reason: 'target-usage-unverified', actionRequired: true };
  }
  return {
    action: 'resume',
    reason: null,
    active: rankedState.active,
    target: {
      accountId: target.accountId,
      accountKey: target.accountKey,
      selector: target.selector,
      sourceRow: target.sourceRow,
    },
    candidates,
  };
}

function sameCandidate(left, right) {
  const leftContinuation = continuationForCandidate(left);
  const rightContinuation = continuationForCandidate(right);
  return left?.threadId === right?.threadId && left?.turnId === right?.turnId &&
    left?.interruptionClass === right?.interruptionClass &&
    left?.classificationVerified === right?.classificationVerified &&
    leftContinuation.ok && rightContinuation.ok &&
    leftContinuation.inputHash === rightContinuation.inputHash;
}

function sameDecisionPlan(expected, actual) {
  return expected?.action === 'resume' && actual?.action === 'resume' &&
    expected.target?.accountId === actual.target?.accountId &&
    expected.target?.accountKey === actual.target?.accountKey &&
    expected.candidates.length === actual.candidates.length &&
    expected.candidates.every((candidate, index) => sameCandidate(candidate, actual.candidates[index]));
}

function autoContinueProblemLine(stateInput, enabled) {
  if (!enabled) return null;
  const state = normalizeAutoContinueState(stateInput);
  if (state.actionRequired !== true || !state.errorKind) return null;
  if (state.errorKind === 'AUTO_BLOCKED_VSCODE_CODEX_ACTIVE') {
    return 'AUTO-CONTINUE BLOCKED / ACTION REQUIRED: VS Code Codex är aktivt; automatiken manipulerar inte VS Code.';
  }
  return `AUTO-CONTINUE BLOCKED / ACTION REQUIRED: ${state.errorKind}`;
}

module.exports = {
  AUTO_CONTINUE_PENDING_MS,
  AUTO_CONTINUE_STATE_VERSION,
  autoContinueStatusLine,
  autoContinueProblemLine,
  autoPlanDescriptor,
  autoPlanFingerprint,
  automationDecision,
  cancelPendingAction,
  configuredRegistryAccounts,
  createOrResumePending,
  emptyAutoContinueState,
  freshUsage,
  normalizeAutoContinueState,
  isAutoPlanSuppressed,
  pendingAttentionDecision,
  pendingCountdownDecision,
  rankedConfiguredAccounts,
  reconcileSuppression,
  requiresPendingCountdown,
  resetAutoContinueForToggle,
  sameDecisionPlan,
  usableAccount,
  writeAutoContinueStateFile,
};
