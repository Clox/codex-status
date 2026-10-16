'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_CANDIDATE_AGE_MS = 14 * DAY_MS;
const MIN_CONTINUOUS_MISSING_MS = 7 * DAY_MS;
const MAX_MISSING_CHECK_GAP_MS = 5 * 60 * 1000;
const MAX_RETIRE_HISTORY = 64;
const MISSING_REASON = 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME';

function keyFor(candidate) {
  return JSON.stringify([candidate.threadId, candidate.turnId]);
}

function missingSince(previous, reason, nowMs) {
  if (reason !== MISSING_REASON) return null;
  if (previous?.reason !== MISSING_REASON ||
      !Number.isFinite(previous.lastSeenAtMs) ||
      nowMs < previous.lastSeenAtMs ||
      nowMs - previous.lastSeenAtMs > MAX_MISSING_CHECK_GAP_MS ||
      !Number.isFinite(previous.continuousMissingSinceMs)) return nowMs;
  return previous.continuousMissingSinceMs;
}

function retirementEligible({ candidate, block, eventState, resumeState, draftJournal,
  autoState, storage, observerHealthy, nowMs }) {
  if (!candidate?.threadId || !candidate?.turnId || !Number.isFinite(nowMs) || !observerHealthy) return false;
  const key = keyFor(candidate);
  const persisted = eventState?.interruptedTurns?.[key];
  if (persisted?.threadId !== candidate.threadId || persisted?.turnId !== candidate.turnId ||
      persisted.threadIdentityVerified !== true || persisted.resumable !== true ||
      persisted.classificationVerified !== true) return false;
  if (!Number.isFinite(persisted.completedAtMs) ||
      nowMs - persisted.completedAtMs < MIN_CANDIDATE_AGE_MS) return false;
  if (block?.threadId !== candidate.threadId || block.failedTurnId !== candidate.turnId ||
      block.reason !== MISSING_REASON || storage?.reason !== MISSING_REASON || storage?.ok !== false ||
      storage.threadId !== candidate.threadId || storage.failedTurnId !== candidate.turnId ||
      !Number.isFinite(block.continuousMissingSinceMs) ||
      nowMs - block.continuousMissingSinceMs < MIN_CONTINUOUS_MISSING_MS ||
      !Number.isFinite(block.lastSeenAtMs) || nowMs - block.lastSeenAtMs > MAX_MISSING_CHECK_GAP_MS) return false;
  if (Object.values(eventState?.activeTurns || {}).some(turn => turn.threadId === candidate.threadId)) return false;
  if ((eventState?.terminalTurns || []).some(turn => turn.threadId === candidate.threadId &&
      turn.turnId !== candidate.turnId && Number(turn.startedAtMs || turn.completedAtMs) > persisted.completedAtMs)) return false;
  if (!resumeState?.attempts || resumeState.attempts[key] || resumeState.retiredCandidates?.[key]) return false;
  if (!draftJournal?.claims || draftJournal.claims[key]) return false;
  if (autoState?.pending || autoState?.errorKind ||
      !['idle', 'waiting', 'blocked'].includes(autoState?.status) ||
      (autoState?.candidateThreadId === candidate.threadId && autoState.actionRequired === true) ||
      autoState?.exclusivityBlock?.threadId === candidate.threadId) return false;
  return true;
}

function retireUnavailable(resumeState, candidate, block, nowMs) {
  const key = keyFor(candidate);
  if (resumeState.retiredCandidates?.[key]) return resumeState;
  const entry = { threadId: candidate.threadId, turnId: candidate.turnId,
    completedAtMs: candidate.completedAtMs, missingSinceMs: block.continuousMissingSinceMs,
    retiredAtMs: nowMs, reason: MISSING_REASON };
  return { ...resumeState,
    retiredCandidates: { ...(resumeState.retiredCandidates || {}), [key]: {
      threadId: candidate.threadId, turnId: candidate.turnId, retiredAtMs: nowMs,
      status: 'retired-unavailable', reason: MISSING_REASON,
    } },
    retirementHistory: [...(resumeState.retirementHistory || []), entry].slice(-MAX_RETIRE_HISTORY),
  };
}

function reactivateRetired(resumeState, candidate, eventState, draftJournal, storage) {
  const key = keyFor(candidate);
  if (!resumeState.retiredCandidates?.[key]) throw new Error('CANDIDATE_NOT_RETIRED');
  if (storage?.ok !== true ||
      eventState?.interruptedTurns?.[key]?.threadId !== candidate.threadId ||
      eventState.interruptedTurns[key].turnId !== candidate.turnId ||
      eventState.interruptedTurns[key].threadIdentityVerified !== true ||
      eventState.interruptedTurns[key].resumable !== true ||
      eventState.interruptedTurns[key].classificationVerified !== true ||
      resumeState.attempts?.[key] || draftJournal?.claims?.[key] ||
      (eventState.terminalTurns || []).some(turn => turn.threadId === candidate.threadId &&
        turn.turnId !== candidate.turnId &&
        Number(turn.startedAtMs || turn.completedAtMs) > candidate.completedAtMs) ||
      Object.values(eventState.activeTurns || {}).some(turn => turn.threadId === candidate.threadId)) {
    throw new Error('CANDIDATE_REACTIVATION_UNVERIFIED');
  }
  const retiredCandidates = { ...resumeState.retiredCandidates };
  delete retiredCandidates[key];
  return { ...resumeState, retiredCandidates };
}

module.exports = { MIN_CANDIDATE_AGE_MS, MIN_CONTINUOUS_MISSING_MS,
  MAX_MISSING_CHECK_GAP_MS, MISSING_REASON, missingSince, retirementEligible,
  retireUnavailable, reactivateRetired };
