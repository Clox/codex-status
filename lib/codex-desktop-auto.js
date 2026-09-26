'use strict';

const crypto = require('node:crypto');
const { candidateKey, normalizeResumeState } = require('./codex-manual-resume');
const { continuationForCandidate } = require('./codex-turn-continuation');

const DESKTOP_SEND_CONFIRM_TIMEOUT_MS = 30_000;
const DESKTOP_PREFLIGHT_TIMEOUT_MS = 15_000;
const DESKTOP_PREFLIGHT_BACKOFF_MS = [200, 350, 500, 750, 1_000];

function credentialFreeErrorKind(error) {
  const value = String(error?.message || error?.errorKind || error?.name || 'DESKTOP_PREFLIGHT_FAILED');
  return /^[A-Z0-9_:-]{1,160}$/.test(value) ? value : 'DESKTOP_PREFLIGHT_FAILED';
}

function desktopPreflightFallbackRecord(previous, error, context = {}, nowMs = Date.now()) {
  const diagnostics = error?.desktopPreflight && typeof error.desktopPreflight === 'object'
    ? error.desktopPreflight
    : {};
  return {
    ...(previous && typeof previous === 'object' ? previous : {}),
    ...diagnostics,
    phase: 'semantic-readiness',
    status: 'fallback-headless',
    completedAtMs: diagnostics.completedAtMs || nowMs,
    lastErrorKind: diagnostics.lastErrorKind || credentialFreeErrorKind(error),
    threadId: context.threadId || null,
    failedTurnId: context.failedTurnId || null,
    targetAccountId: context.targetAccountId || null,
    desktopRootPid: Number.isInteger(context.desktopRootPid) ? context.desktopRootPid : null,
  };
}

async function waitForDesktopReadiness({
  attempt,
  onObservation = () => {},
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now = Date.now,
  timeoutMs = DESKTOP_PREFLIGHT_TIMEOUT_MS,
  backoffMs = DESKTOP_PREFLIGHT_BACKOFF_MS,
} = {}) {
  if (typeof attempt !== 'function' || typeof onObservation !== 'function' ||
      typeof sleep !== 'function' || typeof now !== 'function' ||
      !Number.isFinite(timeoutMs) || timeoutMs < 0 || !Array.isArray(backoffMs) || backoffMs.length === 0) {
    throw new Error('DESKTOP_PREFLIGHT_CONFIGURATION_INVALID');
  }
  const startedAtMs = now();
  let attempts = 0;
  let lastErrorKind = null;
  while (true) {
    attempts += 1;
    try {
      const capability = await attempt(attempts);
      const completedAtMs = now();
      const diagnostics = {
        phase: 'semantic-readiness', status: 'ready', startedAtMs, completedAtMs,
        attempts, lastErrorKind,
      };
      onObservation(diagnostics);
      return { capability, diagnostics };
    } catch (error) {
      lastErrorKind = credentialFreeErrorKind(error);
      const observedAtMs = now();
      const elapsedMs = Math.max(0, observedAtMs - startedAtMs);
      if (elapsedMs >= timeoutMs) {
        const diagnostics = {
          phase: 'semantic-readiness', status: 'failed', startedAtMs,
          completedAtMs: observedAtMs, attempts, lastErrorKind,
        };
        onObservation(diagnostics);
        const failure = new Error(lastErrorKind);
        failure.desktopPreflight = diagnostics;
        throw failure;
      }
      const diagnostics = {
        phase: 'semantic-readiness', status: 'waiting', startedAtMs,
        observedAtMs, attempts, lastErrorKind,
      };
      onObservation(diagnostics);
      const delay = Math.min(
        backoffMs[Math.min(attempts - 1, backoffMs.length - 1)],
        Math.max(0, timeoutMs - elapsedMs),
      );
      if (delay > 0) await sleep(delay);
    }
  }
}

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
  DESKTOP_PREFLIGHT_TIMEOUT_MS,
  committedDesktopAttempts,
  credentialFreeErrorKind,
  desktopPreflightFallbackRecord,
  desktopPlan,
  desktopPrecommitFailureAction,
  desktopQueueMayContinue,
  markDesktopSendCommitted,
  markDesktopSendInvoked,
  markDesktopPrefillStarted,
  observerCheckpoint,
  reconcileDesktopSend,
  stableFingerprint,
  waitForDesktopReadiness,
};
