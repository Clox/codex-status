'use strict';

const {
  INTERRUPTION_CLASS,
  exactAppServerInput,
  inputHash,
} = require('./codex-turn-continuation');

const EVENT_STATE_VERSION = 4;
const DEFAULT_ACTIVE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_PENDING_ERROR_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_OBSERVER_MAX_AGE_MS = 15_000;
const MAX_TERMINAL_TURNS = 256;
const MAX_EVIDENCE_TYPES = 24;
const MAX_ORIGINAL_INPUT_BYTES = 256 * 1024;

const WORK_ITEM_TYPES = new Set([
  'agentmessage',
  'collabagenttoolcall',
  'commandexecution',
  'contextcompaction',
  'customtoolcall',
  'customtoolcalloutput',
  'dynamictoolcall',
  'enteredreviewmode',
  'exitedreviewmode',
  'extension',
  'filechange',
  'functioncalloutput',
  'functioncall',
  'imagegeneration',
  'imageview',
  'mcptoolcall',
  'localshellcall',
  'plan',
  'reasoning',
  'sleep',
  'subagentactivity',
  'websearch',
  'websearchcall',
]);

function emptyTurnEvidence() {
  return {
    sawTaskStarted: true,
    sawTurnContext: false,
    sawUserResponseItem: false,
    sawUserMessage: false,
    sawTokenCount: false,
    preWorkSequenceValid: true,
    workItemTypes: [],
    supportingTokenUsage: false,
    unexpectedRecordTypes: [],
    originalInput: null,
    originalInputHash: null,
    originalInputError: null,
  };
}

function normalizedType(value) {
  return String(value || '').replaceAll('_', '').replaceAll('-', '').toLocaleLowerCase('en-US');
}

function appendBounded(values, value) {
  if (!value || values.includes(value) || values.length >= MAX_EVIDENCE_TYPES) return;
  values.push(value);
}

function retainOriginalInput(evidence, content) {
  if (!Array.isArray(content) || content.length === 0 || evidence.originalInput) return;
  let serialized;
  try { serialized = JSON.stringify(content); } catch {
    evidence.originalInputError = 'original-input-not-json';
    return;
  }
  if (Buffer.byteLength(serialized) > MAX_ORIGINAL_INPUT_BYTES) {
    evidence.originalInputError = 'original-input-too-large';
    return;
  }
  const copy = JSON.parse(serialized);
  evidence.originalInputHash = inputHash(copy);
  if (!exactAppServerInput(copy)) {
    evidence.originalInputError = 'original-input-unsupported';
    return;
  }
  evidence.originalInput = copy;
}

function noteWorkItem(evidence, itemType) {
  const normalized = normalizedType(itemType);
  if (WORK_ITEM_TYPES.has(normalized)) appendBounded(evidence.workItemTypes, normalized);
  else if (normalized && normalized !== 'usermessage') {
    evidence.preWorkSequenceValid = false;
    appendBounded(evidence.unexpectedRecordTypes, `item:${normalized}`);
  }
}

function observeRolloutEvidence(evidenceInput, record) {
  const evidence = evidenceInput || emptyTurnEvidence();
  const payload = record?.payload || {};
  if (record?.type === 'turn_context') {
    evidence.sawTurnContext = true;
    return evidence;
  }
  if (record?.type === 'response_item') {
    const type = normalizedType(payload.type);
    if (type === 'message' && payload.role === 'user') {
      evidence.sawUserResponseItem = true;
      return evidence;
    }
    if (type === 'message' && payload.role === 'assistant') {
      noteWorkItem(evidence, 'AgentMessage');
      return evidence;
    }
    noteWorkItem(evidence, payload.type);
    return evidence;
  }
  if (record?.type === 'event_msg') {
    const eventType = normalizedType(payload.type);
    if (eventType === 'taskstarted' || eventType === 'taskcomplete') return evidence;
    if (eventType === 'tokencount') {
      evidence.sawTokenCount = true;
      return evidence;
    }
    if (eventType === 'tokenusagerecord') {
      evidence.supportingTokenUsage = true;
      return evidence;
    }
    if (eventType === 'itemstarted' || eventType === 'itemcompleted') {
      const item = payload.item || {};
      if (normalizedType(item.type) === 'usermessage') {
        evidence.sawUserMessage = true;
        retainOriginalInput(evidence, item.content);
      } else {
        noteWorkItem(evidence, item.type);
      }
      return evidence;
    }
    evidence.preWorkSequenceValid = false;
    appendBounded(evidence.unexpectedRecordTypes, `event:${eventType || 'unknown'}`);
    return evidence;
  }
  evidence.preWorkSequenceValid = false;
  appendBounded(evidence.unexpectedRecordTypes, `record:${normalizedType(record?.type) || 'unknown'}`);
  return evidence;
}

function observeProtocolItem(evidenceInput, item) {
  const evidence = evidenceInput || emptyTurnEvidence();
  if (normalizedType(item?.type) === 'usermessage') {
    evidence.sawUserMessage = true;
    retainOriginalInput(evidence, item.content);
  } else {
    noteWorkItem(evidence, item?.type);
  }
  return evidence;
}

function classifyTurnEvidence(evidence) {
  if (Array.isArray(evidence?.workItemTypes) && evidence.workItemTypes.length > 0) {
    return INTERRUPTION_CLASS.AFTER_WORK;
  }
  if (
    evidence?.preWorkSequenceValid === true &&
    evidence?.sawTaskStarted === true &&
    evidence?.sawTurnContext === true &&
    evidence?.sawUserResponseItem === true &&
    evidence?.sawUserMessage === true &&
    evidence?.sawTokenCount === true
  ) return INTERRUPTION_CLASS.BEFORE_WORK;
  return INTERRUPTION_CLASS.UNKNOWN;
}

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
    displaySnapshots: {},
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
    activeTurns: legacyIdentity ? {} : Object.fromEntries(Object.entries(
      normalized.activeTurns && typeof normalized.activeTurns === 'object' ? normalized.activeTurns : {}
    ).map(([key, turn]) => [key, previousVersion < EVENT_STATE_VERSION
      ? {
          ...turn,
          evidence: {
            ...emptyTurnEvidence(),
            preWorkSequenceValid: false,
            unexpectedRecordTypes: ['migration:partial-turn'],
          },
        }
      : turn])),
    pendingErrors: legacyIdentity ? {} : normalized.pendingErrors && typeof normalized.pendingErrors === 'object' ? normalized.pendingErrors : {},
    exhaustions: Object.fromEntries(Object.entries(normalized.exhaustions || {}).map(([key, value]) => [
      key, legacyIdentity ? { ...value, threadIdentityVerified: false } : value,
    ])),
    interruptedTurns: Object.fromEntries(Object.entries(
      normalized.interruptedTurns && typeof normalized.interruptedTurns === 'object'
        ? normalized.interruptedTurns
        : {}
    ).map(([key, candidate]) => [key, previousVersion < EVENT_STATE_VERSION
      ? {
          ...candidate,
          interruptionClass: INTERRUPTION_CLASS.UNKNOWN,
          classificationVerified: false,
          originalInput: null,
          originalInputHash: null,
        }
      : candidate])),
    displaySnapshots: normalized.displaySnapshots && typeof normalized.displaySnapshots === 'object' &&
      !Array.isArray(normalized.displaySnapshots) ? normalized.displaySnapshots : {},
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
        interruptionClass: INTERRUPTION_CLASS.UNKNOWN,
        classificationVerified: false,
        originalInput: null,
        originalInputHash: null,
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
    interruptionClass: turn.interruptionClass || null,
    startedAtMs: turn.startedAtMs || null,
    originalInputHash: turn.originalInputHash || null,
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
    evidence: emptyTurnEvidence(),
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
  const interruptionClass = verifiedExhaustion
    ? classifyTurnEvidence(active?.evidence)
    : null;

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
      interruptionClass,
      startedAtMs: active?.startedAtMs || null,
      originalInputHash: active?.evidence?.originalInputHash || null,
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
        interruptionClass,
        classificationVerified: interruptionClass !== INTERRUPTION_CLASS.UNKNOWN,
        classificationSource: source === 'rollout-terminal' ? 'live-rollout' : 'app-server',
        classificationAttemptedAtMs: completedAtMs,
        workItemTypes: [...(active?.evidence?.workItemTypes || [])],
        originalInput: interruptionClass === INTERRUPTION_CLASS.BEFORE_WORK
          ? active?.evidence?.originalInput || null
          : null,
        originalInputHash: interruptionClass === INTERRUPTION_CLASS.BEFORE_WORK
          ? active?.evidence?.originalInputHash || null
          : null,
        originalInputError: interruptionClass === INTERRUPTION_CLASS.BEFORE_WORK
          ? active?.evidence?.originalInputError || null
          : null,
        threadIdentityVerified: true,
      };
    }
  } else if (status === 'completed' && accountId && state.exhaustions[accountId]) {
    delete state.exhaustions[accountId];
  }
  return state;
}

function abortTurn(state, {
  threadId,
  turnId,
  completedAtMs = Date.now(),
} = {}) {
  if (!threadId || !turnId) return state;
  const key = turnKey(threadId, turnId);
  const active = state.activeTurns[key] || null;

  // An abort is terminal even when a usage error was observed immediately
  // beforehand. Clear the exact pair before the replay guard so an
  // inconsistent/replayed checkpoint cannot retain stale live state.
  delete state.activeTurns[key];
  delete state.pendingErrors[key];
  if (state.terminalTurns.some(turn =>
    turn.threadId === threadId && turn.turnId === turnId && turn.threadIdentityVerified === true)) return state;

  state.terminalTurns = [
    ...state.terminalTurns,
    terminalRecord({
      threadId,
      turnId,
      accountId: active?.accountId || null,
      parentThreadId: active?.parentThreadId || null,
      threadSource: active?.threadSource || null,
      title: active?.title || null,
      status: 'aborted',
      errorKind: null,
      completedAtMs,
    }, completedAtMs),
  ].slice(-MAX_TERMINAL_TURNS);
  return state;
}

function applyProtocolNotification(stateInput, notification, context = {}) {
  const state = normalizeState(stateInput, context.nowMs);
  const method = notification?.method;
  const params = notification?.params || {};
  const nowMs = milliseconds(context.nowMs, Date.now());
  if (method === 'error') return noteProtocolError(state, params, nowMs);
  if (method === 'turn/started') {
    const started = startTurn(state, {
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
    const key = turnKey(params.threadId || context.threadId, params.turn?.id);
    for (const item of params.turn?.items || []) {
      if (started.activeTurns[key]) {
        started.activeTurns[key].evidence = observeProtocolItem(started.activeTurns[key].evidence, item);
      }
    }
    return started;
  }
  if (method === 'item/started' || method === 'item/completed') {
    const key = turnKey(params.threadId || context.threadId, params.turnId || context.turnId);
    if (state.activeTurns[key]) {
      state.activeTurns[key].evidence = observeProtocolItem(state.activeTurns[key].evidence, params.item);
    }
    return state;
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
  if (record?.type === 'event_msg' && payload.type === 'task_started') {
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
  const recordTurnId = payload.turn_id || context.turnId;
  const key = recordTurnId && context.threadId ? turnKey(context.threadId, recordTurnId) : null;
  if (key && state.activeTurns[key]) {
    state.activeTurns[key].evidence = observeRolloutEvidence(state.activeTurns[key].evidence, record);
  }
  if (record?.type !== 'event_msg') return state;
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
  if (payload.type === 'turn_aborted') {
    return abortTurn(state, {
      threadId: context.threadId,
      turnId: payload.turn_id,
      completedAtMs: milliseconds(payload.completed_at, nowMs),
    });
  }
  return state;
}

function classifyRolloutTurn(records, turnId) {
  let evidence = null;
  let inTurn = false;
  let startCount = 0;
  let terminalCount = 0;
  let terminalUsageLimit = false;
  for (const record of records || []) {
    const payload = record?.payload || {};
    if (record?.type === 'event_msg' && payload.type === 'task_started' && payload.turn_id === turnId) {
      startCount += 1;
      if (startCount > 1) return { found: true, verified: false, interruptionClass: INTERRUPTION_CLASS.UNKNOWN };
      evidence = emptyTurnEvidence();
      inTurn = true;
      continue;
    }
    if (!inTurn) continue;
    if (record?.type === 'event_msg' && payload.type === 'task_started') {
      return { found: true, verified: false, interruptionClass: INTERRUPTION_CLASS.UNKNOWN };
    }
    evidence = observeRolloutEvidence(evidence, record);
    if (record?.type === 'event_msg' && payload.type === 'task_complete') {
      if (payload.turn_id !== turnId) return { found: true, verified: false, interruptionClass: INTERRUPTION_CLASS.UNKNOWN };
      terminalCount += 1;
      terminalUsageLimit = isUsageLimitError(payload.error);
      inTurn = false;
      break;
    }
    if (record?.type === 'event_msg' && payload.type === 'turn_aborted') {
      return { found: true, verified: false, interruptionClass: INTERRUPTION_CLASS.UNKNOWN };
    }
  }
  if (startCount !== 1 || terminalCount !== 1 || !terminalUsageLimit || !evidence) {
    return { found: startCount > 0, verified: false, interruptionClass: INTERRUPTION_CLASS.UNKNOWN };
  }
  const interruptionClass = classifyTurnEvidence(evidence);
  return {
    found: true,
    verified: interruptionClass !== INTERRUPTION_CLASS.UNKNOWN,
    interruptionClass,
    workItemTypes: [...evidence.workItemTypes],
    originalInput: interruptionClass === INTERRUPTION_CLASS.BEFORE_WORK ? evidence.originalInput : null,
    originalInputHash: interruptionClass === INTERRUPTION_CLASS.BEFORE_WORK ? evidence.originalInputHash : null,
    originalInputError: interruptionClass === INTERRUPTION_CLASS.BEFORE_WORK ? evidence.originalInputError : null,
  };
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
  abortTurn,
  applyProtocolNotification,
  applyRolloutRecord,
  classifyRolloutTurn,
  classifyTurnEvidence,
  clearRecoveredExhaustions,
  completeTurn,
  emptyTurnEvidence,
  emptyEventState,
  errorKind,
  isUsageLimitError,
  normalizeState,
  observerHealth,
  observeProtocolItem,
  observeRolloutEvidence,
  pruneEventState,
  recoveryAllowed,
  startTurn,
  turnKey,
};
