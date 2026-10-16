'use strict';

const { candidateKey } = require('./codex-manual-resume');

const ACTIVE_STATUSES = new Set([
  'running',
]);

function autoDisplayPlan(autoState, resumeState, eventState, candidates, activeTurns, mode) {
  const attempts = Object.values(resumeState?.attempts || {});
  const committed = attempts.filter(attempt => attempt?.strategy !== 'DESKTOP' &&
    attempt?.status === 'RESUME_COMMITTED' &&
    attempt.threadId && attempt.interruptedTurnId && (attempt.automatic === true ||
      (autoState?.candidateThreadId === attempt.threadId &&
        autoState?.candidateTurnId === attempt.interruptedTurnId)))
    .sort((left, right) => Number(right.committedAtMs) - Number(left.committedAtMs))[0];
  const active = activeTurns || [];
  let operation = null;
  if (committed) {
    const turn = active.find(item => item.threadId === committed.threadId);
    operation = {
      threadId: committed.threadId,
      failedTurnId: committed.interruptedTurnId,
      sourceAccountId: committed.accountId || null,
      targetAccountId: committed.targetAccountId || null,
      phase: turn ? 'running' : 'starting continuation',
      committed: true,
      mode: 'HEADLESS',
    };
  } else if (ACTIVE_STATUSES.has(autoState?.status) && autoState.candidateThreadId &&
      autoState.candidateTurnId) {
    const exactMatch = item => item.threadId === autoState.candidateThreadId &&
      item.turnId === autoState.candidateTurnId;
    const candidate = candidates.find(exactMatch) ||
      Object.values(eventState?.interruptedTurns || {}).find(exactMatch);
    operation = {
      threadId: autoState.candidateThreadId,
      failedTurnId: autoState.candidateTurnId,
      sourceAccountId: autoState.sourceAccountId || candidate?.accountId || null,
      targetAccountId: autoState.targetAccountId || null,
      phase: autoState.phase || 'preparing',
      committed: false,
      mode: 'HEADLESS',
    };
  }
  const operationKey = operation && candidateKey(operation.threadId, operation.failedTurnId);
  const interrupted = candidates.filter(candidate =>
    candidateKey(candidate.threadId, candidate.turnId) !== operationKey);
  const shownActive = active.filter(turn => turn.threadId !== operation?.threadId &&
    !attempts.some(attempt => attempt.threadId === turn.threadId && attempt.status === 'COMPLETED' &&
      attempt.continuationTurnId && attempt.continuationTurnId === turn.turnId));
  return { operation, interrupted, activeTurns: shownActive };
}

module.exports = { autoDisplayPlan };
