'use strict';

const { resolveActiveAccount, resolveExpectedAccount } = require('./codex-account-state');
const { rankAccounts } = require('./codex-account-ranking');
const { pendingInterruptedTurns } = require('./codex-manual-resume');
const { observerHealth } = require('./codex-turn-observer');
const {
  assessCacheHealth,
  isWeeklyDormant,
  usageQuality,
} = require('./codex-usage-cache');

const AUTO_CONTINUE_STATE_VERSION = 1;

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
  };
}

function normalizeAutoContinueState(value) {
  return {
    ...emptyAutoContinueState(),
    ...(value && typeof value === 'object' ? value : {}),
    version: AUTO_CONTINUE_STATE_VERSION,
  };
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
  return left?.threadId === right?.threadId && left?.turnId === right?.turnId;
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
  AUTO_CONTINUE_STATE_VERSION,
  autoContinueProblemLine,
  automationDecision,
  configuredRegistryAccounts,
  emptyAutoContinueState,
  freshUsage,
  normalizeAutoContinueState,
  rankedConfiguredAccounts,
  sameDecisionPlan,
  usableAccount,
};
