'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveActiveAccount, resolveExpectedAccount } = require('./codex-account-state');
const { rankAccounts } = require('./codex-account-ranking');
const { pendingInterruptedTurns, isCompletedObserverTimeoutAttempt } = require('./codex-manual-resume');
const { observerHealth } = require('./codex-turn-observer');
const { continuationForCandidate } = require('./codex-turn-continuation');
const { manualDraftClaimsForCandidates } = require('./codex-continuation-ownership');
const { missingSince } = require('./codex-candidate-lifecycle');
const { AUTO_MODE, effectiveAutoMode } = require('./codex-status-preferences');
const {
  assessCacheHealth,
  isWeeklyDormant,
  usageQuality,
} = require('./codex-usage-cache');

const AUTO_CONTINUE_STATE_VERSION = 4;
const AUTO_CONTINUE_PENDING_MS = 10_000;
const AUTO_EXCLUSIVITY_ESCALATE_AFTER_MS = 5 * 60_000;
const AUTO_EXCLUSIVITY_HISTORY_LIMIT = 12;

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
    modeEnabledAtMs: null,
    waitingReason: null,
    candidateBlocks: {},
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
    errorKind: null,
    actionRequired: false,
    candidateThreadId: null,
    candidateTurnId: null,
    targetAccountId: null,
    pending: null,
    lastNotifiedPendingFingerprint: null,
    suppression: null,
    desktopRestore: null,
    restoreRetryHalt: false,
    restoreRetryHaltGeneration: null,
    desktopRestoreHistory: [],
    desktopNavigation: null,
    desktopNavigationHistory: [],
    planChangeHistory: [],
    // Historical DESKTOP diagnostics are archival only; no DESKTOP plan is active.
    desktopAttemptHistory: [],
    exclusivityBlock: null,
    exclusivityHistory: [],
  };
}

function normalizeAutoContinueState(value) {
  const legacyDesktopInProgress = Boolean(value?.desktopPreflight);
  const normalized = {
    ...emptyAutoContinueState(),
    ...(value && typeof value === 'object' ? value : {}),
    version: AUTO_CONTINUE_STATE_VERSION,
  };
  normalized.pending = normalized.pending && typeof normalized.pending === 'object'
    ? normalized.pending
    : null;
  normalized.candidateBlocks = normalized.candidateBlocks && typeof normalized.candidateBlocks === 'object' &&
    !Array.isArray(normalized.candidateBlocks) ? normalized.candidateBlocks : {};
  normalized.suppression = normalized.suppression && typeof normalized.suppression === 'object'
    ? normalized.suppression
    : null;
  normalized.desktopRestore = normalized.desktopRestore && typeof normalized.desktopRestore === 'object'
    ? normalized.desktopRestore
    : null;
  normalized.restoreRetryHalt = normalized.restoreRetryHalt === true;
  normalized.restoreRetryHaltGeneration = typeof normalized.restoreRetryHaltGeneration === 'string'
    ? normalized.restoreRetryHaltGeneration : null;
  normalized.desktopRestoreHistory = Array.isArray(normalized.desktopRestoreHistory)
    ? normalized.desktopRestoreHistory.slice(-AUTO_EXCLUSIVITY_HISTORY_LIMIT) : [];
  normalized.desktopNavigation = normalized.desktopNavigation && typeof normalized.desktopNavigation === 'object'
    ? normalized.desktopNavigation
    : null;
  normalized.desktopNavigationHistory = Array.isArray(normalized.desktopNavigationHistory)
    ? normalized.desktopNavigationHistory.slice(-AUTO_EXCLUSIVITY_HISTORY_LIMIT) : [];
  normalized.planChangeHistory = Array.isArray(normalized.planChangeHistory)
    ? normalized.planChangeHistory.slice(-AUTO_EXCLUSIVITY_HISTORY_LIMIT) : [];
  delete normalized.desktopPreflight;
  normalized.desktopAttemptHistory = Array.isArray(normalized.desktopAttemptHistory)
    ? normalized.desktopAttemptHistory.slice(-24) : [];
  if (legacyDesktopInProgress || ['desktop-preparing', 'desktop-ready', 'desktop-preflight',
    'desktop-fallback-headless', 'reconciling'].includes(normalized.status)) {
    normalized.status = 'idle';
    normalized.phase = null;
    normalized.candidateThreadId = null;
    normalized.candidateTurnId = null;
    normalized.targetAccountId = null;
    normalized.pending = null;
    normalized.errorKind = null;
    normalized.actionRequired = false;
  }
  normalized.exclusivityBlock = normalized.exclusivityBlock && typeof normalized.exclusivityBlock === 'object'
    ? normalized.exclusivityBlock
    : null;
  normalized.exclusivityHistory = Array.isArray(normalized.exclusivityHistory)
    ? normalized.exclusivityHistory.slice(-AUTO_EXCLUSIVITY_HISTORY_LIMIT)
    : [];
  return normalized;
}

function migrateLegacyDesktopAutoState(stateInput, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  const unresolvedRestore = state.desktopRestore?.status === 'failed' ||
    (state.restoreRetryHalt === true && state.desktopRestore?.status !== 'ready') ||
    state.exclusivityBlock?.actionRequired === true;
  return {
    ...state,
    status: unresolvedRestore ? 'blocked' : 'idle',
    heartbeatAtMs: nowMs,
    modeEnabledAtMs: nowMs,
    waitingReason: null,
    phase: null,
    sourceAccountId: null,
    candidateThreadId: null,
    candidateTurnId: null,
    targetAccountId: null,
    pending: null,
    suppression: null,
    restoreRetryHalt: unresolvedRestore && state.restoreRetryHalt,
    restoreRetryHaltGeneration: unresolvedRestore ? state.restoreRetryHaltGeneration : null,
    exclusivityBlock: unresolvedRestore ? state.exclusivityBlock : null,
    errorKind: unresolvedRestore ? state.desktopRestore?.errorKind ||
      state.errorKind || 'AUTO_RESTORE_UNRESOLVED' : null,
    actionRequired: unresolvedRestore,
  };
}

function safeExclusivityBlockers(diagnostics) {
  return Array.isArray(diagnostics?.blockers) ? diagnostics.blockers.map(blocker => ({
    pid: Number.isInteger(blocker?.pid) ? blocker.pid : null,
    ppid: Number.isInteger(blocker?.ppid) ? blocker.ppid : null,
    ...(Number.isFinite(Number(blocker?.startTicks)) ? { startTicks: Number(blocker.startTicks) } : {}),
    state: typeof blocker?.state === 'string' ? blocker.state.slice(0, 8) : '?',
    role: typeof blocker?.role === 'string' ? blocker.role.slice(0, 80) : 'unknown-app-server',
  })) : [];
}

function exclusivityBlockerFingerprint(blockers) {
  const identity = blockers.map(blocker => ({
    pid: blocker.pid,
    ppid: blocker.ppid,
    startTicks: blocker.startTicks ?? null,
    role: blocker.role,
  })).sort((left, right) =>
    String(left.role).localeCompare(String(right.role)) ||
    Number(left.pid || 0) - Number(right.pid || 0) ||
    Number(left.ppid || 0) - Number(right.ppid || 0));
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function appendExclusivityHistory(historyInput, block, resolvedAtMs = null) {
  if (!block?.fingerprint) return Array.isArray(historyInput) ? historyInput : [];
  const history = Array.isArray(historyInput) ? [...historyInput] : [];
  const entry = {
    phase: block.phase,
    failureReason: block.failureReason,
    fingerprint: block.fingerprint,
    firstSeenAtMs: block.firstSeenAtMs,
    lastSeenAtMs: block.lastSeenAtMs,
    durationMs: Math.max(0, Number(block.lastSeenAtMs) - Number(block.firstSeenAtMs)),
    attempts: block.attempts,
    threadId: block.threadId,
    failedTurnId: block.failedTurnId,
    targetAccountId: block.targetAccountId,
    blockers: block.blockers,
    escalated: block.escalated === true,
    resolvedAtMs: Number.isFinite(Number(resolvedAtMs)) ? Number(resolvedAtMs) : null,
  };
  const previous = history.at(-1);
  if (previous?.fingerprint === entry.fingerprint &&
      previous?.threadId === entry.threadId && previous?.failedTurnId === entry.failedTurnId) {
    history[history.length - 1] = entry;
  } else {
    history.push(entry);
  }
  return history.slice(-AUTO_EXCLUSIVITY_HISTORY_LIMIT);
}

function recordExclusivityBlock(stateInput, diagnostics = {}, context = {}, nowMs = Date.now(), policy = {}) {
  const state = normalizeAutoContinueState(stateInput);
  const previous = state.exclusivityBlock;
  const blockers = safeExclusivityBlockers(diagnostics);
  const fingerprint = exclusivityBlockerFingerprint(blockers);
  const samePlan = previous?.threadId === (context.threadId || null) &&
    previous?.failedTurnId === (context.failedTurnId || null) &&
    previous?.targetAccountId === (context.targetAccountId || null);
  const sameBlocker = samePlan && previous?.fingerprint === fingerprint;
  const firstSeenAtMs = sameBlocker && Number.isFinite(Number(previous?.firstSeenAtMs))
    ? Number(previous.firstSeenAtMs)
    : nowMs;
  const attempts = sameBlocker ? Number(previous?.attempts || 0) + 1 : 1;
  const explicitlyManual = blockers.some(blocker => blocker.role !== 'desktop-app-server');
  const escalateAfterMs = Number(policy.escalateAfterMs ?? AUTO_EXCLUSIVITY_ESCALATE_AFTER_MS);
  const escalated = explicitlyManual || nowMs - firstSeenAtMs >= escalateAfterMs;
  const block = {
    phase: diagnostics?.phase || 'acquire-app-server-exclusivity',
    failureReason: diagnostics?.failureReason || 'APP_SERVER_EXCLUSIVITY_FAILED',
    fingerprint,
    firstSeenAtMs,
    lastSeenAtMs: nowMs,
    attempts,
    threadId: context.threadId || null,
    failedTurnId: context.failedTurnId || null,
    targetAccountId: context.targetAccountId || null,
    blockers,
    escalated,
  };
  const history = previous && !sameBlocker
    ? appendExclusivityHistory(state.exclusivityHistory, previous, nowMs)
    : state.exclusivityHistory;
  return {
    ...state,
    status: escalated ? 'blocked' : 'waiting',
    errorKind: 'APP_SERVER_EXCLUSIVITY_FAILED',
    actionRequired: escalated,
    candidateThreadId: block.threadId,
    candidateTurnId: block.failedTurnId,
    targetAccountId: block.targetAccountId,
    pending: null,
    exclusivityBlock: block,
    exclusivityHistory: history,
  };
}

function clearExclusivityBlock(stateInput, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  return {
    ...state,
    ...(state.errorKind === 'APP_SERVER_EXCLUSIVITY_FAILED'
      ? { errorKind: null, actionRequired: false, status: 'waiting' } : {}),
    exclusivityHistory: appendExclusivityHistory(state.exclusivityHistory, state.exclusivityBlock, nowMs),
    exclusivityBlock: null,
  };
}

function resolveDesktopRestoreFailure(stateInput, verifiedRoot, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  if (!Number.isInteger(verifiedRoot?.pid) || verifiedRoot.pid <= 0 ||
      !Number.isFinite(verifiedRoot.startTicks) || verifiedRoot.startTicks <= 0) {
    throw new Error('DESKTOP_ROOT_IDENTITY_UNVERIFIED');
  }
  const failed = state.desktopRestore?.status === 'failed' ? state.desktopRestore : null;
  return {
    ...state,
    restoreRetryHalt: false,
    restoreRetryHaltGeneration: null,
    ...(failed && state.errorKind === failed.errorKind
      ? { errorKind: null, actionRequired: false, status: 'waiting' } : {}),
    desktopRestore: { status: 'ready', completedAtMs: nowMs,
      desktopPid: verifiedRoot.pid, desktopStartTicks: verifiedRoot.startTicks,
      desktopCgroup: verifiedRoot.cgroup || null },
    desktopRestoreHistory: failed
      ? [...state.desktopRestoreHistory, { ...failed, resolvedAtMs: nowMs }]
        .slice(-AUTO_EXCLUSIVITY_HISTORY_LIMIT) : state.desktopRestoreHistory,
  };
}

function automaticAttemptGeneration(decision) {
  if (decision?.action !== 'resume' || !Array.isArray(decision.candidates) || !decision.candidates.length) return null;
  return crypto.createHash('sha256').update(JSON.stringify({
    targetAccountId: decision.target?.accountId || null,
    candidates: decision.candidates.map(candidate => ({
      threadId: candidate.threadId || null,
      turnId: candidate.turnId || null,
      accountId: candidate.accountId || null,
      inputHash: candidate.inputHash || null,
      interruptionClass: candidate.interruptionClass || null,
    })),
  })).digest('hex');
}

function armAutomaticAttemptRetryHalt(stateInput, decision) {
  const generation = automaticAttemptGeneration(decision);
  if (!generation) throw new Error('AUTO_ATTEMPT_GENERATION_UNVERIFIED');
  return { ...normalizeAutoContinueState(stateInput), restoreRetryHalt: true,
    restoreRetryHaltGeneration: generation };
}

function reconcileFailedAutomaticAttempt(stateInput, decision) {
  const state = normalizeAutoContinueState(stateInput);
  if (state.desktopRestore?.status === 'ready' && state.restoreRetryHalt) {
    return { ...state, restoreRetryHalt: false, restoreRetryHaltGeneration: null,
      ...(state.errorKind === 'DESKTOP_RESTORE_RETRY_HALTED'
        ? { errorKind: null, actionRequired: false, status: 'waiting' } : {}) };
  }
  return state;
}

function restoreFailureBlocksAuto(stateInput, decision) {
  const state = normalizeAutoContinueState(stateInput);
  if (state.desktopRestore?.status === 'failed') return true;
  if (state.desktopRestore?.status === 'ready') return false;
  if (!state.restoreRetryHalt) return false;
  // A legacy latch without a generation is fail-closed until AUTO is explicitly
  // turned OFF. New latches follow the exact failed candidate plan.
  const generation = automaticAttemptGeneration(decision);
  return !state.restoreRetryHaltGeneration || generation === state.restoreRetryHaltGeneration;
}

function archiveDesktopNavigation(stateInput, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  const navigation = state.desktopNavigation;
  if (!navigation) return state;
  const entry = { ...navigation, archivedAtMs: nowMs };
  const previous = state.desktopNavigationHistory.at(-1);
  const duplicate = previous?.threadId === entry.threadId && previous?.failedTurnId === entry.failedTurnId &&
    previous?.status === entry.status && previous?.errorKind === entry.errorKind;
  return { ...state, desktopNavigation: null,
    desktopNavigationHistory: duplicate ? state.desktopNavigationHistory :
      [...state.desktopNavigationHistory, entry].slice(-AUTO_EXCLUSIVITY_HISTORY_LIMIT) };
}

function archiveTerminalDesktopNavigation(stateInput, resumeState, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  const navigation = state.desktopNavigation;
  if (navigation?.status !== 'failed' || !navigation.threadId) return state;
  const terminal = Object.entries(resumeState?.attempts || {}).filter(([key, attempt]) => {
    let identity;
    try { identity = JSON.parse(key); } catch { return false; }
    return Array.isArray(identity) && identity[0] === navigation.threadId &&
      (!navigation.failedTurnId || identity[1] === navigation.failedTurnId) &&
      attempt?.status === 'COMPLETED';
  });
  if (terminal.length !== 1) return state;
  const [threadId, failedTurnId] = JSON.parse(terminal[0][0]);
  return archiveDesktopNavigation({ ...state,
    desktopNavigation: { ...navigation, threadId, failedTurnId } }, nowMs);
}

function recordPrecommitPlanChange(stateInput, reason, context = {}, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  return { ...state, status: 'waiting', waitingReason: 'plan-changed',
    errorKind: null, actionRequired: false, pending: null,
    planChangeHistory: [...state.planChangeHistory, {
      reason, threadId: context.threadId || null, failedTurnId: context.failedTurnId || null,
      targetAccountId: context.targetAccountId || null, observedAtMs: nowMs,
    }].slice(-AUTO_EXCLUSIVITY_HISTORY_LIMIT) };
}

function waitForResumeOperationLock(stateInput, nowMs = Date.now()) {
  return { ...normalizeAutoContinueState(stateInput), status: 'waiting',
    waitingReason: 'resume-already-running', phase: null, errorKind: null,
    actionRequired: false, pending: null, lastAttemptAtMs: nowMs };
}

function shouldReplanAutomaticError(error, committed) {
  return committed !== true && (/^AUTO_PLAN_CHANGED_/.test(error?.message || '') ||
    error?.message === 'SOURCE_EXHAUSTION_CHANGED');
}

function adoptAutomaticPlan(stateInput, nowMs = Date.now()) {
  const state = archiveDesktopNavigation(reconcileFailedAutomaticAttempt(stateInput), nowMs);
  return { ...state, status: 'running', waitingReason: null, errorKind: null,
    actionRequired: false, pending: null };
}

function beginExclusivityAttempt(stateInput, context = {}, updates = {}) {
  const state = normalizeAutoContinueState(stateInput);
  const block = state.exclusivityBlock;
  const samePlan = block?.threadId === (context.threadId || null) &&
    block?.failedTurnId === (context.failedTurnId || null) &&
    block?.targetAccountId === (context.targetAccountId || null);
  if (!samePlan) return { ...state, ...updates };
  return {
    ...state,
    ...updates,
    status: block.escalated ? 'blocked' : 'waiting',
    errorKind: 'APP_SERVER_EXCLUSIVITY_FAILED',
    actionRequired: block.escalated === true,
    exclusivityBlock: block,
  };
}

function hasMatchingExclusivityBlock(stateInput, context = {}) {
  const block = normalizeAutoContinueState(stateInput).exclusivityBlock;
  return Boolean(block && block.threadId === (context.threadId || null) &&
    block.failedTurnId === (context.failedTurnId || null) &&
    block.targetAccountId === (context.targetAccountId || null));
}

function unresolvedExclusivityBlockerPresent(stateInput, entries) {
  const block = normalizeAutoContinueState(stateInput).exclusivityBlock;
  if (!block?.blockers?.length) return false;
  return block.blockers.some(blocker => (entries || []).some(entry =>
    entry.pid === blocker.pid && Number.isFinite(entry.startTicks) &&
    entry.startTicks === blocker.startTicks));
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
  if (decision.strategy && decision.strategy !== AUTO_MODE.HEADLESS) {
    throw new Error('AUTO_STRATEGY_UNSUPPORTED');
  }
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
    strategy: AUTO_MODE.HEADLESS,
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
    notificationClaimed: state.lastNotifiedPendingFingerprint !== fingerprint,
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

function resetAutoContinueForToggle(stateInput, mode, nowMs = Date.now()) {
  const state = normalizeAutoContinueState(stateInput);
  const enabled = mode === true || mode === AUTO_MODE.HEADLESS;
  const acknowledgedRestore = !enabled && state.desktopRestore?.status === 'failed';
  return {
    ...state,
    status: enabled ? 'idle' : 'disabled',
    heartbeatAtMs: nowMs,
    modeEnabledAtMs: enabled ? nowMs : null,
    waitingReason: null,
    candidateBlocks: {},
    pending: null,
    suppression: null,
    errorKind: null,
    actionRequired: false,
    ...(!enabled ? { restoreRetryHalt: false } : {}),
    ...(!enabled ? { restoreRetryHaltGeneration: null } : {}),
    ...(acknowledgedRestore ? {
      desktopRestore: null,
      desktopRestoreHistory: [...state.desktopRestoreHistory,
        { ...state.desktopRestore, acknowledgedAtMs: nowMs }].slice(-AUTO_EXCLUSIVITY_HISTORY_LIMIT),
    } : {}),
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

function autoContinueStatusLine(preferences, stateInput, nowMs = Date.now(), { operation = null } = {}) {
  const mode = effectiveAutoMode(preferences);
  const enabled = mode !== AUTO_MODE.OFF;
  const state = normalizeAutoContinueState(stateInput);
  if (enabled && state.status === 'pending' && state.pending?.fingerprint &&
      Number(state.pending.deadlineAtMs) > nowMs) {
    const seconds = Math.max(0, Math.ceil((Number(state.pending.deadlineAtMs) - nowMs) / 1000));
    return `AUTO: ${mode} · Restart om ${seconds}s [X] Avbryt`;
  }
  if (enabled && state.status === 'pending' && state.pending?.fingerprint) {
    return `AUTO: ${mode} · WAIT: countdown-expired`;
  }
  if (enabled && operation?.committed &&
      (state.waitingReason === 'resume-already-running' || state.status === 'running')) {
    return `AUTO: ${mode} · RUNNING`;
  }
  if (enabled && state.errorKind === 'APP_SERVER_EXCLUSIVITY_FAILED' && state.actionRequired !== true) {
    return `AUTO: ${mode} · WAIT/BLOCKED`;
  }
  if (enabled && state.status === 'waiting') {
    return `AUTO: ${mode} · WAIT: ${state.waitingReason || 'reason-unavailable'}`;
  }
  if (enabled && (state.status === 'suppressed' || state.status === 'canceled')) {
    return `AUTO: ${mode} · WAIT: canceled-plan`;
  }
  if (enabled && state.status === 'blocked' && onlyIsolatedUnavailableCandidates(state)) {
    return `AUTO: ${mode} · WAIT: unavailable-candidates`;
  }
  if (enabled && state.status === 'blocked') {
    return `AUTO: ${mode} · BLOCKED`;
  }
  if (enabled && state.status === 'running') {
    return `AUTO: ${mode} · WORKING: ${operation?.phase || state.status}`;
  }
  return `AUTO: ${mode} [A] mode`;
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
  manualDraftJournal,
  selectors,
  nowMs = Date.now(),
}) {
  const strategy = effectiveAutoMode(preferences);
  if (strategy === AUTO_MODE.OFF) return { action: 'disabled', reason: 'auto-off', strategy };
  if (!observerHealth(eventState, nowMs).healthy) {
    return { action: 'blocked', reason: 'observer-unverified', actionRequired: true };
  }
  if (Object.keys(eventState?.activeTurns || {}).length > 0) {
    return { action: 'waiting', reason: 'active-turns' };
  }
  const pendingCandidates = pendingInterruptedTurns(eventState, resumeState);
  if (pendingCandidates.length === 0) return { action: 'idle', reason: 'no-candidates' };
  if (manualDraftJournal?.unverified === true) return { action: 'blocked',
    reason: 'MANUAL_DRAFT_JOURNAL_UNVERIFIED', actionRequired: true };
  const manualClaims = manualDraftClaimsForCandidates(pendingCandidates, manualDraftJournal);
  const claimedKeys = new Set(manualClaims.map(candidate => JSON.stringify([candidate.threadId, candidate.turnId])));
  const candidates = pendingCandidates.filter(candidate => !claimedKeys.has(JSON.stringify([candidate.threadId, candidate.turnId])));
  if (candidates.length === 0) return { action: 'blocked', reason: 'MANUAL_DRAFT_OWNERSHIP_PENDING',
    actionRequired: true, candidateThreadId: manualClaims[0].threadId, candidateTurnId: manualClaims[0].turnId };
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
    strategy,
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
    expected.strategy === actual.strategy &&
    expected.target?.accountId === actual.target?.accountId &&
    expected.target?.accountKey === actual.target?.accountKey &&
    expected.candidates.length === actual.candidates.length &&
    expected.candidates.every((candidate, index) => sameCandidate(candidate, actual.candidates[index]));
}

function autoCandidateKey(candidate) {
  return JSON.stringify([candidate.threadId, candidate.turnId]);
}

function isolatedUnavailableReason(reason) {
  return reason === 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME' ||
    reason === 'ROLLOUT_METADATA_UNVERIFIED' || reason === 'SOURCE_EXHAUSTION_CHANGED' ||
    reason === 'CANDIDATE_NO_LONGER_RESUMABLE' || reason === 'FAILED_TURN_NOT_LATEST';
}

function onlyIsolatedUnavailableCandidates(state) {
  const blocks = Object.values(state.candidateBlocks || {});
  return blocks.length > 0 && blocks.every(block =>
    isolatedUnavailableReason(block?.reason) && block.blocksAutomation !== true &&
    !block.requiredAction) &&
    !state.errorKind && state.actionRequired !== true && !state.exclusivityBlock &&
    state.desktopRestore?.status !== 'failed' && !state.restoreRetryHalt;
}

function headlessDiagnosticCandidates(eventState, resumeState, manualDraftJournal) {
  if (manualDraftJournal?.unverified === true) return [];
  const pending = pendingInterruptedTurns(eventState, resumeState);
  const claimed = new Set(manualDraftClaimsForCandidates(pending, manualDraftJournal).map(autoCandidateKey));
  return pending.filter(candidate => !claimed.has(autoCandidateKey(candidate)) &&
    candidate.classificationVerified === true && continuationForCandidate(candidate).ok);
}

function automaticCandidateEligibility(candidate, eventState, storage) {
  if (!storage?.ok) return storage || { ok: false, reason: 'ROLLOUT_UNVERIFIED' };
  const key = autoCandidateKey(candidate);
  const observed = eventState?.interruptedTurns?.[key];
  if (!observed?.resumable || observed.threadIdentityVerified !== true ||
      observed.classificationVerified !== true || observed.accountId !== candidate.accountId) {
    return { ok: false, reason: 'CANDIDATE_NO_LONGER_RESUMABLE', actionRequired: false };
  }
  const exhaustion = eventState?.exhaustions?.[candidate.accountId];
  if (exhaustion?.verified !== true || exhaustion?.errorKind !== 'usageLimitExceeded') {
    return { ok: false, reason: 'SOURCE_EXHAUSTION_CHANGED', actionRequired: false };
  }
  return { ok: true };
}

async function partitionAutomaticCandidates(decision, inspectCandidate, previousBlocks = {}, nowMs = Date.now()) {
  const available = [];
  const blocked = [];
  const candidateBlocks = {};
  for (const candidate of decision.candidates) {
    const result = await inspectCandidate(candidate);
    if (result.ok) {
      available.push(candidate);
      continue;
    }
    const key = autoCandidateKey(candidate);
    const reason = result.reason || 'ROLLOUT_UNVERIFIED';
    blocked.push(candidate);
    candidateBlocks[key] = {
      threadId: candidate.threadId,
      failedTurnId: candidate.turnId,
      reason,
      blocksAutomation: result.blocksAutomation === true,
      actionRequired: result.requiredAction ? true :
        (!isolatedUnavailableReason(reason) && result.actionRequired !== false),
      ...(result.requiredAction ? { requiredAction: result.requiredAction } : {}),
      firstSeenAtMs: previousBlocks[key]?.reason === reason
        ? previousBlocks[key].firstSeenAtMs : nowMs,
      lastSeenAtMs: nowMs,
      continuousMissingSinceMs: missingSince(previousBlocks[key], reason, nowMs),
    };
  }
  return { plan: { ...decision, candidates: available }, blocked, candidateBlocks };
}

const partitionHeadlessCandidates = partitionAutomaticCandidates;

function selectHeadlessPlan(actual, blocked) {
  const blockedKeys = new Set(blocked.map(autoCandidateKey));
  return {
    ...actual,
    candidates: actual.candidates.filter(candidate => !blockedKeys.has(autoCandidateKey(candidate))),
  };
}

function sameHeadlessDecisionPlan(expected, actual, blocked) {
  if (actual?.action !== 'resume') return false;
  if (!blocked.every(candidate => actual.candidates.some(other => sameCandidate(candidate, other)))) return false;
  return sameDecisionPlan(expected, selectHeadlessPlan(actual, blocked));
}

function autoContinueProblemLines(stateInput, enabled,
  { candidateKeys = null, resumeState = null, eventState = null } = {}) {
  const lines = [];
  if (!enabled) return null;
  const state = normalizeAutoContinueState(stateInput);
  for (const [key, block] of Object.entries(state.candidateBlocks)) {
    if (candidateKeys && !candidateKeys.has(key)) continue;
    if (isolatedUnavailableReason(block?.reason) && block.blocksAutomation !== true &&
        !block.requiredAction) continue;
    if (isolatedUnavailableReason(block?.reason) && !block.requiredAction) {
      lines.push(`AUTO-CONTINUE BLOCKED: …${String(block.threadId || '').slice(-8)} ${block.reason}`);
      continue;
    }
    lines.push(`AUTO-CONTINUE BLOCKED / ACTION REQUIRED: …${String(block.threadId || '').slice(-8)} ${block.reason || 'CANDIDATE_UNAVAILABLE_IN_ACTIVE_CODEX_HOME'}`);
  }
  if (state.desktopNavigation?.status === 'failed') {
    lines.push(`AUTO-CONTINUE / ACTION REQUIRED: continuation completed, but Desktop navigation failed (${state.desktopNavigation.errorKind || 'DESKTOP_DEEPLINK_FAILED'}).`);
  }
  if (state.exclusivityBlock) {
    lines.push(`AUTO-CONTINUE BLOCKED / ACTION REQUIRED: APP_SERVER_EXCLUSIVITY_FAILED`);
  }
  if (state.desktopRestore?.status === 'failed') {
    lines.push(`AUTO-CONTINUE BLOCKED / ACTION REQUIRED: ${state.desktopRestore.errorKind || 'DESKTOP_RESTORE_FAILED'}`);
  } else if (state.restoreRetryHalt && state.desktopRestore?.status !== 'ready') {
    lines.push('AUTO-CONTINUE BLOCKED / ACTION REQUIRED: DESKTOP_RESTORE_RETRY_HALTED');
  }
  const exactKey = JSON.stringify([state.candidateThreadId, state.candidateTurnId]);
  const resolvedObserverTimeout = state.errorKind === 'TURN_OBSERVER_DID_NOT_SETTLE' &&
    isCompletedObserverTimeoutAttempt(resumeState?.attempts?.[exactKey], eventState);
  const unrelatedCandidateError = candidateKeys && state.candidateThreadId &&
    state.candidateTurnId && !candidateKeys.has(exactKey);
  if (state.actionRequired === true && state.errorKind && !resolvedObserverTimeout &&
      !unrelatedCandidateError &&
      !(state.errorKind === 'DESKTOP_RESTORE_RETRY_HALTED' && state.desktopRestore?.status === 'ready') &&
      !(state.errorKind === 'APP_SERVER_EXCLUSIVITY_FAILED' && state.exclusivityBlock) &&
      !(state.desktopRestore?.status === 'failed' && state.errorKind === state.desktopRestore.errorKind)) {
    lines.push(state.errorKind === 'AUTO_BLOCKED_VSCODE_CODEX_ACTIVE'
      ? 'AUTO-CONTINUE BLOCKED / ACTION REQUIRED: VS Code Codex är aktivt; automatiken manipulerar inte VS Code.'
      : `AUTO-CONTINUE BLOCKED / ACTION REQUIRED: ${state.errorKind}`);
  }
  return lines;
}

function autoContinueProblemLine(stateInput, enabled) {
  return autoContinueProblemLines(stateInput, enabled)?.[0] || null;
}

module.exports = {
  AUTO_CONTINUE_PENDING_MS,
  AUTO_EXCLUSIVITY_HISTORY_LIMIT,
  AUTO_EXCLUSIVITY_ESCALATE_AFTER_MS,
  AUTO_CONTINUE_STATE_VERSION,
  migrateLegacyDesktopAutoState,
  autoContinueStatusLine,
  autoContinueProblemLine,
  autoContinueProblemLines,
  autoPlanDescriptor,
  autoPlanFingerprint,
  automationDecision,
  cancelPendingAction,
  beginExclusivityAttempt,
  clearExclusivityBlock,
  configuredRegistryAccounts,
  createOrResumePending,
  emptyAutoContinueState,
  freshUsage,
  hasMatchingExclusivityBlock,
  unresolvedExclusivityBlockerPresent,
  normalizeAutoContinueState,
  isAutoPlanSuppressed,
  pendingAttentionDecision,
  pendingCountdownDecision,
  partitionHeadlessCandidates,
  partitionAutomaticCandidates,
  automaticCandidateEligibility,
  isolatedUnavailableReason,
  headlessDiagnosticCandidates,
  recordExclusivityBlock,
  resolveDesktopRestoreFailure,
  automaticAttemptGeneration,
  armAutomaticAttemptRetryHalt,
  reconcileFailedAutomaticAttempt,
  archiveDesktopNavigation,
  archiveTerminalDesktopNavigation,
  recordPrecommitPlanChange,
  waitForResumeOperationLock,
  shouldReplanAutomaticError,
  adoptAutomaticPlan,
  restoreFailureBlocksAuto,
  rankedConfiguredAccounts,
  reconcileSuppression,
  requiresPendingCountdown,
  resetAutoContinueForToggle,
  sameDecisionPlan,
  sameHeadlessDecisionPlan,
  selectHeadlessPlan,
  usableAccount,
  writeAutoContinueStateFile,
};
