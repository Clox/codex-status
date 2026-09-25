'use strict';

const crypto = require('node:crypto');
const { candidateKey, normalizeResumeState } = require('./codex-manual-resume');
const { continuationForCandidate } = require('./codex-turn-continuation');

const DESKTOP_SEND_CONFIRM_TIMEOUT_MS = 30_000;

function stableFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function desktopPlan(candidate, target) {
  const continuation = continuationForCandidate(candidate, { desktop: true });
  if (!continuation.ok || candidate?.classificationVerified !== true) {
    const error = new Error(continuation.reason || 'CANDIDATE_CLASSIFICATION_UNVERIFIED');
    error.safeHeadlessFallback = true;
    throw error;
  }
  const descriptor = {
    strategy: 'DESKTOP',
    sourceAccountId: candidate.accountId || null,
    targetAccountId: target?.accountId || null,
    targetAccountKey: target?.accountKey || null,
    threadId: candidate.threadId,
    failedTurnId: candidate.turnId,
    interruptionClass: candidate.interruptionClass,
    continuationKind: continuation.kind,
    inputHash: continuation.inputHash,
  };
  return {
    ...descriptor,
    fingerprint: stableFingerprint(descriptor),
    input: continuation.input,
    prompt: continuation.desktopPrompt,
  };
}

function observerCheckpoint(eventState) {
  return {
    heartbeatAtMs: Number(eventState?.worker?.heartbeatAtMs) || null,
    activeTurnKeys: Object.keys(eventState?.activeTurns || {}).sort(),
    terminalTurnCount: Array.isArray(eventState?.terminalTurns) ? eventState.terminalTurns.length : 0,
  };
}

function markDesktopSendCommitted(stateInput, candidate, plan, capability, eventState, nowMs = Date.now()) {
  const state = normalizeResumeState(stateInput);
  const key = candidateKey(candidate.threadId, candidate.turnId);
  if (state.attempts[key]?.committedAtMs) throw new Error('DESKTOP_SEND_ALREADY_COMMITTED');
  if (state.attempts[key]?.status === 'PREFILL_STARTED' &&
      state.attempts[key]?.planFingerprint !== plan?.fingerprint) {
    throw new Error('DESKTOP_PREFILL_PLAN_CHANGED');
  }
  if (
    plan?.strategy !== 'DESKTOP' ||
    plan.threadId !== candidate.threadId ||
    plan.failedTurnId !== candidate.turnId ||
    plan.interruptionClass !== candidate.interruptionClass ||
    !/^[0-9a-f]{64}$/.test(plan.inputHash || '') ||
    !/^[0-9a-f]{64}$/.test(plan.fingerprint || '') ||
    capability?.verified !== true
  ) throw new Error('DESKTOP_SEND_PLAN_UNVERIFIED');
  state.attempts[key] = {
    threadId: candidate.threadId,
    interruptedTurnId: candidate.turnId,
    accountId: candidate.accountId || null,
    targetAccountId: plan.targetAccountId,
    targetAccountKey: plan.targetAccountKey,
    strategy: 'DESKTOP',
    interruptionClass: plan.interruptionClass,
    continuationKind: plan.continuationKind,
    inputHash: plan.inputHash,
    planFingerprint: plan.fingerprint,
    committedAtMs: nowMs,
    status: 'SEND_ATTEMPT_COMMITTED',
    sendInvokedAtMs: null,
    continuationTurnId: null,
    completedAtMs: null,
    errorKind: null,
    desktopIdentity: capability.desktopIdentity || null,
    rendererIdentity: capability.rendererIdentity || null,
    atspiIdentity: capability.atspiIdentity || null,
    observerCheckpoint: observerCheckpoint(eventState),
  };
  state.lastError = null;
  return state;
}

function markDesktopPrefillStarted(stateInput, candidate, plan, nowMs = Date.now()) {
  const state = normalizeResumeState(stateInput);
  const key = candidateKey(candidate.threadId, candidate.turnId);
  const existing = state.attempts[key];
  if (existing?.committedAtMs || existing?.status === 'PREFILL_STARTED') {
    throw new Error('DESKTOP_PREFILL_ALREADY_CLAIMED');
  }
  if (plan?.strategy !== 'DESKTOP' || plan.threadId !== candidate.threadId ||
      plan.failedTurnId !== candidate.turnId || !/^[0-9a-f]{64}$/.test(plan.inputHash || '')) {
    throw new Error('DESKTOP_PREFILL_PLAN_UNVERIFIED');
  }
  state.attempts[key] = {
    threadId: candidate.threadId,
    interruptedTurnId: candidate.turnId,
    accountId: candidate.accountId || null,
    targetAccountId: plan.targetAccountId,
    targetAccountKey: plan.targetAccountKey,
    strategy: 'DESKTOP',
    interruptionClass: plan.interruptionClass,
    continuationKind: plan.continuationKind,
    inputHash: plan.inputHash,
    planFingerprint: plan.fingerprint,
    prefillStartedAtMs: nowMs,
    committedAtMs: null,
    status: 'PREFILL_STARTED',
    errorKind: 'DESKTOP_DRAFT_STATE_UNCERTAIN',
  };
  state.lastError = null;
  return state;
}

function markDesktopSendInvoked(stateInput, candidate, nowMs = Date.now()) {
  const state = normalizeResumeState(stateInput);
  const key = candidateKey(candidate.threadId, candidate.turnId);
  const attempt = state.attempts[key];
  if (!attempt?.committedAtMs || attempt.strategy !== 'DESKTOP') throw new Error('DESKTOP_SEND_NOT_COMMITTED');
  if (attempt.sendInvokedAtMs) throw new Error('DESKTOP_SEND_ALREADY_INVOKED');
  state.attempts[key] = { ...attempt, sendInvokedAtMs: nowMs, status: 'SEND_ACTION_INVOKED' };
  return state;
}

function observedTurns(eventState) {
  return [
    ...Object.values(eventState?.activeTurns || {}).map(turn => ({
      ...turn,
      originalInputHash: turn.originalInputHash || turn.evidence?.originalInputHash || null,
    })),
    ...(Array.isArray(eventState?.terminalTurns) ? eventState.terminalTurns : []),
  ];
}

function reconcileDesktopSend(stateInput, candidate, eventState, nowMs = Date.now(), timeoutMs = DESKTOP_SEND_CONFIRM_TIMEOUT_MS) {
  const state = normalizeResumeState(stateInput);
  const key = candidateKey(candidate.threadId, candidate.turnId);
  const attempt = state.attempts[key];
  if (!attempt?.committedAtMs || attempt.strategy !== 'DESKTOP') return { state, outcome: 'not-committed' };
  if (['SEND_CONFIRMED', 'SEND_UNCONFIRMED', 'SEND_CONFLICT'].includes(attempt.status)) {
    return { state, outcome: attempt.status.toLocaleLowerCase('en-US') };
  }
  const relevant = observedTurns(eventState).filter(turn =>
    turn?.threadId === attempt.threadId &&
    turn?.turnId && turn.turnId !== attempt.interruptedTurnId &&
    Number(turn.startedAtMs) >= Number(attempt.committedAtMs) &&
    !turn.parentThreadId && turn.threadSource !== 'guardian_review'
  );
  const matching = relevant.filter(turn =>
    turn.accountId === attempt.targetAccountId &&
    turn.originalInputHash === attempt.inputHash
  );
  if (matching.length === 1 && relevant.length === 1) {
    state.attempts[key] = {
      ...attempt,
      status: 'SEND_CONFIRMED',
      continuationTurnId: matching[0].turnId,
      confirmedAtMs: nowMs,
      errorKind: null,
    };
    return { state, outcome: 'confirmed', turn: matching[0] };
  }
  if (matching.length > 1 || relevant.length > 0) {
    state.attempts[key] = {
      ...attempt,
      status: 'SEND_CONFLICT',
      failedAtMs: nowMs,
      errorKind: 'DESKTOP_SEND_OBSERVER_CONFLICT',
    };
    return { state, outcome: 'conflict' };
  }
  if (nowMs - Number(attempt.committedAtMs) >= timeoutMs) {
    state.attempts[key] = {
      ...attempt,
      status: 'SEND_UNCONFIRMED',
      failedAtMs: nowMs,
      errorKind: 'DESKTOP_SEND_NOT_OBSERVED',
    };
    return { state, outcome: 'unconfirmed' };
  }
  return { state, outcome: 'pending' };
}

function committedDesktopAttempts(stateInput) {
  return Object.values(normalizeResumeState(stateInput).attempts)
    .filter(attempt => attempt.strategy === 'DESKTOP' && attempt.committedAtMs &&
      !['SEND_CONFIRMED', 'SEND_UNCONFIRMED', 'SEND_CONFLICT'].includes(attempt.status));
}

function desktopPrecommitFailureAction({ promptInjected = false, anyCommitted = false, candidateIndex = 0 } = {}) {
  return !promptInjected && !anyCommitted && candidateIndex === 0
    ? 'fallback-headless'
    : 'fail-closed';
}

function desktopQueueMayContinue({ outcome, capabilityReliable }) {
  if (outcome === 'confirmed') return true;
  return outcome === 'unconfirmed' && capabilityReliable === true;
}

module.exports = {
  DESKTOP_SEND_CONFIRM_TIMEOUT_MS,
  committedDesktopAttempts,
  desktopPlan,
  desktopPrecommitFailureAction,
  desktopQueueMayContinue,
  markDesktopSendCommitted,
  markDesktopSendInvoked,
  markDesktopPrefillStarted,
  observerCheckpoint,
  reconcileDesktopSend,
  stableFingerprint,
};
