'use strict';

const EVENT_STATE_VERSION = 3;
const DEFAULT_ACTIVE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_PENDING_ERROR_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_OBSERVER_MAX_AGE_MS = 15_000;
const MAX_TERMINAL_TURNS = 256;

function emptyEventState(nowMs = Date.now()) {
  return {
    version: EVENT_STATE_VERSION,
    worker: {
      heartbeatAtMs: nowMs,
      lastScanAtMs: null,
      lastErrorAtMs: null,
      errorKind: null,
    },
    files: {},
    activeTurns: {},
    pendingErrors: {},
    exhaustions: {},
    interruptedTurns: {},
    terminalTurns: [],
  };
}

function normalizeState(state, nowMs = Date.now()) {
  const normalized = state && typeof state === 'object' ? state : emptyEventState(nowMs);
  const previousVersion = Number(normalized.version) || 1;
  const legacyIdentity = previousVersion < 2;
  const migrated = {
    ...normalized,
    version: EVENT_STATE_VERSION,
    worker: { ...emptyEventState(nowMs).worker, ...(normalized.worker || {}) },
    files: normalized.files && typeof normalized.files === 'object' ? normalized.files : {},
    // V1 used the parent session_id for subagents. Do not retain uncertain live
    // identities across the upgrade; only future rollout appends can bind them.
    activeTurns: legacyIdentity ? {} : normalized.activeTurns && typeof normalized.activeTurns === 'object' ? normalized.activeTurns : {},
    pendingErrors: legacyIdentity ? {} : normalized.pendingErrors && typeof normalized.pendingErrors === 'object' ? normalized.pendingErrors : {},
    exhaustions: Object.fromEntries(Object.entries(normalized.exhaustions || {}).map(([key, value]) => [
      key, legacyIdentity ? { ...value, threadIdentityVerified: false } : value,
    ])),
    interruptedTurns: normalized.interruptedTurns && typeof normalized.interruptedTurns === 'object'
      ? normalized.interruptedTurns
      : {},
    terminalTurns: Array.isArray(normalized.terminalTurns)
      ? normalized.terminalTurns.map(turn => legacyIdentity ? { ...turn, threadIdentityVerified: false } : turn)
      : [],
  };
  if (previousVersion === 2) {
    for (const exhaustion of Object.values(migrated.exhaustions)) {
      if (exhaustion?.verified !== true || exhaustion?.threadIdentityVerified !== true) continue;
      const terminal = migrated.terminalTurns.find(turn =>
        turn.threadId === exhaustion.threadId &&
        turn.turnId === exhaustion.turnId &&
        turn.threadIdentityVerified === true &&
        turn.status === 'failed' &&
        turn.errorKind === 'usagelimitexceeded'
      );
      if (!terminal || terminal.parentThreadId || terminal.threadSource === 'guardian_review') continue;
      const key = turnKey(terminal.threadId, terminal.turnId);
      migrated.interruptedTurns[key] = {
        ...terminal,
        title: terminal.title || null,
        resumable: true,
        observedAtMs: exhaustion.observedAtMs || terminal.completedAtMs,
        source: exhaustion.source || 'rollout-terminal',
      };
    }
  }
  return migrated;
}

function turnKey(threadId, turnId) {
  return JSON.stringify([threadId, turnId]);
}

function milliseconds(value, fallback = Date.now()) {
  if (Number.isFinite(Number(value))) {
    const numeric = Number(value);
    return numeric > 0 && numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function errorKind(error) {
  const value = error?.codexErrorInfo ?? error?.codex_error_info ?? null;
  if (typeof value === 'string') return value.replaceAll('_', '').toLocaleLowerCase('en-US');
  return null;
}

function isUsageLimitError(error) {
  return errorKind(error) === 'usagelimitexceeded';
}

function safeTitle(value) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim();
  return clean ? clean.slice(0, 120) : null;
}

function terminalRecord(turn, nowMs) {
  return {
    threadId: turn.threadId,
    turnId: turn.turnId,
    accountId: turn.accountId || null,
    parentThreadId: turn.parentThreadId || null,
    threadSource: turn.threadSource || null,
    title: safeTitle(turn.title),
    status: turn.status,
    errorKind: turn.errorKind || null,
    completedAtMs: turn.completedAtMs || nowMs,
    threadIdentityVerified: true,
  };
}

function startTurn(state, {
  threadId,
  turnId,
  accountId = null,
  accountKey = null,
  title = null,
  parentThreadId = null,
  threadSource = null,
  startedAtMs = Date.now(),
  observedAtMs = Date.now(),
  binding = accountId ? 'registry-at-start' : 'unbound',
} = {}) {
  if (!threadId || !turnId) return state;
  const key = turnKey(threadId, turnId);
  if (state.activeTurns[key] || state.terminalTurns.some(turn =>
    turn.threadId === threadId && turn.turnId === turnId && turn.threadIdentityVerified === true)) return state;
  state.activeTurns[key] = {
    threadId,
    turnId,
    accountId,
    accountKey,
    title: safeTitle(title),
    parentThreadId,
    threadSource,
    state: 'running',
    startedAtMs,
    observedAtMs,
    binding,
  };
  for (const [candidateKey, candidate] of Object.entries(state.interruptedTurns || {})) {
    if (candidate.threadId === threadId && candidate.turnId !== turnId) {
      delete state.interruptedTurns[candidateKey];
    }
  }
  return state;
}

function noteProtocolError(state, params, nowMs = Date.now()) {
  const threadId = params?.threadId;
  const turnId = params?.turnId;
  if (!threadId || !turnId || !isUsageLimitError(params.error)) return state;
  if (state.terminalTurns.some(turn =>
    turn.threadId === threadId && turn.turnId === turnId && turn.threadIdentityVerified === true)) return state;
  state.pendingErrors[turnKey(threadId, turnId)] = {
    threadId,
    turnId,
    usageLimitExceeded: true,
    willRetry: params.willRetry === true,
    observedAtMs: nowMs,
    source: 'app-server',
  };
  return state;
}

function completeTurn(state, {
  threadId,
  turnId,
  status,
  error = null,
  completedAtMs = Date.now(),
  terminalUsageLimit = false,
  source = 'app-server',
} = {}) {
  if (!threadId || !turnId) return state;
  const key = turnKey(threadId, turnId);
  const active = state.activeTurns[key] || null;
  const pending = state.pendingErrors[key] || null;
  if (state.terminalTurns.some(turn =>
    turn.threadId === threadId && turn.turnId === turnId && turn.threadIdentityVerified === true)) return state;
  const usageFailure = status === 'failed' && isUsageLimitError(error);
  const verifiedExhaustion = usageFailure && (
    terminalUsageLimit ||
    (pending?.threadId === threadId && pending.willRetry === false)
  );
  const accountId = active?.accountId || null;

  delete state.activeTurns[key];
  delete state.pendingErrors[key];
  state.terminalTurns = [
    ...state.terminalTurns,
    terminalRecord({
      threadId,
      turnId,
      accountId,
      parentThreadId: active?.parentThreadId || null,
      threadSource: active?.threadSource || null,
      title: active?.title || null,
      status,
      errorKind: errorKind(error),
      completedAtMs,
    }, completedAtMs),
  ].slice(-MAX_TERMINAL_TURNS);

  if (verifiedExhaustion && accountId) {
    state.exhaustions[accountId] = {
      accountId,
      threadId,
      turnId,
      verified: true,
      pool: 'account',
      errorKind: 'usageLimitExceeded',
      willRetry: false,
      turnStatus: 'failed',
      observedAtMs: completedAtMs,
      source,
      threadIdentityVerified: true,
    };
    if (!active?.parentThreadId && active?.threadSource !== 'guardian_review') {
      state.interruptedTurns[key] = {
        threadId,
        turnId,
        accountId,
        accountKey: active?.accountKey || null,
        title: safeTitle(active?.title),
        parentThreadId: null,
        threadSource: active?.threadSource || null,
        status: 'failed',
        errorKind: 'usagelimitexceeded',
        completedAtMs,
        observedAtMs: completedAtMs,
        source,
        resumable: true,
        threadIdentityVerified: true,
      };
    }
  } else if (status === 'completed' && accountId && state.exhaustions[accountId]) {
    delete state.exhaustions[accountId];
  }
  return state;
}

function applyProtocolNotification(stateInput, notification, context = {}) {
  const state = normalizeState(stateInput, context.nowMs);
  const method = notification?.method;
  const params = notification?.params || {};
  const nowMs = milliseconds(context.nowMs, Date.now());
  if (method === 'error') return noteProtocolError(state, params, nowMs);
  if (method === 'turn/started') {
    return startTurn(state, {
      threadId: params.threadId || context.threadId,
      turnId: params.turn?.id,
      accountId: context.accountId,
      accountKey: context.accountKey,
      title: context.title,
      parentThreadId: context.parentThreadId,
      threadSource: context.threadSource,
      startedAtMs: Number(params.turn?.startedAt) * 1000 || nowMs,
      observedAtMs: nowMs,
    });
  }
  if (method === 'turn/completed') {
    return completeTurn(state, {
      threadId: params.threadId || context.threadId,
      turnId: params.turn?.id,
      status: params.turn?.status,
      error: params.turn?.error,
      completedAtMs: Number(params.turn?.completedAt) * 1000 || nowMs,
      source: 'app-server',
    });
  }
  return state;
}

function applyRolloutRecord(stateInput, record, context = {}) {
  const state = normalizeState(stateInput, context.nowMs);
  const payload = record?.payload || {};
  const nowMs = milliseconds(record?.timestamp, context.nowMs || Date.now());
  if (record?.type === 'session_meta') return state;
  if (record?.type !== 'event_msg') return state;
  if (payload.type === 'task_started') {
    return startTurn(state, {
      threadId: context.threadId,
      turnId: payload.turn_id,
      accountId: context.accountId,
      accountKey: context.accountKey,
      title: context.title,
      parentThreadId: context.parentThreadId,
      threadSource: context.threadSource,
      startedAtMs: milliseconds(payload.started_at, nowMs),
      observedAtMs: context.observedAtMs || nowMs,
      binding: context.accountId ? 'registry-at-start' : 'unbound',
    });
  }
  if (payload.type === 'task_complete') {
    const terminalUsageLimit = isUsageLimitError(payload.error);
    return completeTurn(state, {
      threadId: context.threadId,
      turnId: payload.turn_id,
      status: payload.error ? 'failed' : 'completed',
      error: payload.error,
      completedAtMs: milliseconds(payload.completed_at, nowMs),
      terminalUsageLimit,
      source: 'rollout-terminal',
    });
  }
  return state;
}

function recoveryAllowed(entry, exhaustion) {
  if (!entry || !exhaustion) return false;
  const lastSuccessAt = Number(entry.refresh?.lastSuccessAt ?? entry.fetchedAtMs);
  if (!Number.isFinite(lastSuccessAt) || lastSuccessAt <= exhaustion.observedAtMs) return false;
  if (entry.ordinaryUsageAllowed === true) return true;
  return entry.rateLimitReachedTypeObserved === true &&
    entry.rateLimitReachedType === null &&
    Number(entry.primary?.remainingPercent) > 0 &&
    Number(entry.secondary?.remainingPercent) > 0;
}

function clearRecoveredExhaustions(stateInput, usageCache) {
  const state = normalizeState(stateInput);
  for (const [accountId, exhaustion] of Object.entries(state.exhaustions)) {
    if (recoveryAllowed(usageCache?.accounts?.[accountId], exhaustion)) {
      delete state.exhaustions[accountId];
    }
  }
  return state;
}

function pruneEventState(stateInput, nowMs = Date.now(), options = {}) {
  const state = normalizeState(stateInput, nowMs);
  const activeMaxAgeMs = options.activeMaxAgeMs ?? DEFAULT_ACTIVE_MAX_AGE_MS;
  const pendingMaxAgeMs = options.pendingErrorMaxAgeMs ?? DEFAULT_PENDING_ERROR_MAX_AGE_MS;
  for (const [key, turn] of Object.entries(state.activeTurns)) {
    if (!Number.isFinite(turn.startedAtMs) || nowMs - turn.startedAtMs > activeMaxAgeMs) {
      delete state.activeTurns[key];
    }
  }
  for (const [key, error] of Object.entries(state.pendingErrors)) {
    if (!Number.isFinite(error.observedAtMs) || nowMs - error.observedAtMs > pendingMaxAgeMs) {
      delete state.pendingErrors[key];
    }
  }
  return state;
}

function observerHealth(state, nowMs = Date.now(), maxAgeMs = DEFAULT_OBSERVER_MAX_AGE_MS) {
  const heartbeatAtMs = Number(state?.worker?.heartbeatAtMs);
  const ageMs = Number.isFinite(heartbeatAtMs) ? Math.max(0, nowMs - heartbeatAtMs) : Infinity;
  return {
    healthy: !state?.worker?.errorKind && ageMs <= maxAgeMs,
    heartbeatAtMs: Number.isFinite(heartbeatAtMs) ? heartbeatAtMs : null,
    ageMs,
    errorKind: state?.worker?.errorKind || null,
  };
}

module.exports = {
  DEFAULT_ACTIVE_MAX_AGE_MS,
  DEFAULT_OBSERVER_MAX_AGE_MS,
  EVENT_STATE_VERSION,
  applyProtocolNotification,
  applyRolloutRecord,
  clearRecoveredExhaustions,
  completeTurn,
  emptyEventState,
  errorKind,
  isUsageLimitError,
  normalizeState,
  observerHealth,
  pruneEventState,
  recoveryAllowed,
  startTurn,
  turnKey,
};
