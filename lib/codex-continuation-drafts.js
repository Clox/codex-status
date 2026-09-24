'use strict';

const { pendingInterruptedTurns } = require('./codex-manual-resume');
const { observerHealth } = require('./codex-turn-observer');
const { assessCacheHealth, usageQuality } = require('./codex-usage-cache');
const {
  DESKTOP_CONTINUATION_DRAFT,
  INTERRUPTION_CLASS,
  continuationForCandidate,
} = require('./codex-turn-continuation');

const PLAN_VERSION = 2;
const CONTINUATION_DRAFT = DESKTOP_CONTINUATION_DRAFT;

function verifiedExhaustion(eventState, accountId) {
  const exhaustion = eventState?.exhaustions?.[accountId];
  return exhaustion?.verified === true &&
    exhaustion?.threadIdentityVerified === true &&
    exhaustion?.errorKind === 'usageLimitExceeded';
}

function verifiedUsageEntry(usageCache, accountId, nowMs) {
  const cacheHealth = assessCacheHealth(usageCache, nowMs);
  const entry = usageCache?.accounts?.[accountId] || null;
  return {
    cacheHealth,
    entry,
    verified: cacheHealth.healthy && usageQuality(entry, { nowMs, cacheHealth }) === 'verified',
  };
}

function usableUsageEntry(entry) {
  if (!entry) return false;
  if (entry.ordinaryUsageAllowedObserved === true && entry.ordinaryUsageAllowed !== true) return false;
  return Number(entry.primary?.remainingPercent) > 0 &&
    Number(entry.secondary?.remainingPercent) > 0;
}

function sourceCandidates(eventState, resumeState, sourceAccountId) {
  return pendingInterruptedTurns(eventState, resumeState)
    .filter(candidate => candidate.accountId === sourceAccountId)
    .map(candidate => {
      const desktop = continuationForCandidate(candidate, { desktop: true });
      const headless = continuationForCandidate(candidate);
      return {
        threadId: candidate.threadId,
        turnId: candidate.turnId,
        completedAtMs: Number(candidate.completedAtMs || candidate.observedAtMs || 0),
        interruptionClass: candidate.interruptionClass || INTERRUPTION_CLASS.UNKNOWN,
        classificationVerified: candidate.classificationVerified === true,
        mode: desktop.ok ? 'prefill' : desktop.navigateOnly && headless.ok ? 'navigate' : 'skip',
        prompt: desktop.ok ? desktop.desktopPrompt : null,
        inputHash: desktop.ok ? desktop.inputHash : headless.ok ? headless.inputHash : null,
        reason: desktop.ok ? null : desktop.reason || headless.reason || 'unverified',
      };
    })
    .sort((left, right) => left.completedAtMs - right.completedAtMs ||
      left.threadId.localeCompare(right.threadId) || left.turnId.localeCompare(right.turnId));
}

function sameCandidates(left, right) {
  return left.length === right.length && left.every((candidate, index) =>
    candidate.threadId === right[index].threadId &&
    candidate.turnId === right[index].turnId &&
    candidate.completedAtMs === right[index].completedAtMs &&
    candidate.interruptionClass === right[index].interruptionClass &&
    candidate.classificationVerified === right[index].classificationVerified &&
    candidate.mode === right[index].mode &&
    candidate.inputHash === right[index].inputHash);
}

function buildContinuationPlan({
  sourceAccountId,
  sourceAccountKey,
  targetAccountId,
  targetAccountKey,
  eventState,
  resumeState,
  usageCache,
  nowMs = Date.now(),
}) {
  const base = {
    version: PLAN_VERSION,
    action: 'none',
    reason: 'source-not-exhausted',
    createdAtMs: nowMs,
    sourceAccountId,
    sourceAccountKey,
    targetAccountId,
    targetAccountKey,
    candidates: [],
  };
  if (sourceAccountId === targetAccountId) return { ...base, reason: 'target-is-source' };
  if (!verifiedExhaustion(eventState, sourceAccountId)) return base;
  if (!observerHealth(eventState, nowMs).healthy) {
    return { ...base, action: 'blocked', reason: 'observer-unverified' };
  }
  const sourceUsage = verifiedUsageEntry(usageCache, sourceAccountId, nowMs);
  if (!sourceUsage.verified) {
    return { ...base, action: 'blocked', reason: 'source-usage-unverified' };
  }
  const candidates = sourceCandidates(eventState, resumeState, sourceAccountId);
  if (candidates.length === 0) {
    return { ...base, reason: 'no-interrupted-main-threads' };
  }
  if (candidates.every(candidate => candidate.mode === 'skip')) {
    return { ...base, action: 'blocked', reason: 'candidate-classification-unverified', candidates };
  }
  return { ...base, action: 'prefill', reason: null, candidates };
}

function validateContinuationPlan({
  plan,
  eventState,
  resumeState,
  usageCache,
  activeAccountId,
  activeAccountKey,
  nowMs = Date.now(),
}) {
  if (plan?.version !== PLAN_VERSION || plan?.action !== 'prefill') {
    return { ok: false, reason: 'invalid-plan' };
  }
  if (activeAccountId !== plan.targetAccountId || activeAccountKey !== plan.targetAccountKey) {
    return { ok: false, reason: 'target-account-mismatch' };
  }
  if (!observerHealth(eventState, nowMs).healthy) {
    return { ok: false, reason: 'observer-unverified' };
  }
  if (!verifiedExhaustion(eventState, plan.sourceAccountId)) {
    return { ok: false, reason: 'source-no-longer-exhausted' };
  }
  const sourceUsage = verifiedUsageEntry(usageCache, plan.sourceAccountId, nowMs);
  if (!sourceUsage.verified) return { ok: false, reason: 'source-usage-unverified' };
  const targetUsage = verifiedUsageEntry(usageCache, plan.targetAccountId, nowMs);
  if (!targetUsage.verified) return { ok: false, reason: 'target-usage-unverified' };
  if (verifiedExhaustion(eventState, plan.targetAccountId) || !usableUsageEntry(targetUsage.entry)) {
    return { ok: false, reason: 'target-not-usable' };
  }
  const candidates = sourceCandidates(eventState, resumeState, plan.sourceAccountId);
  if (!sameCandidates(candidates, plan.candidates)) {
    return { ok: false, reason: 'interrupted-candidates-changed' };
  }
  return { ok: true, candidates };
}

function continuationDeepLinks(candidates) {
  return candidates.filter(candidate => candidate.mode === 'prefill' || candidate.mode === 'navigate').map(candidate => {
    const url = new URL(`codex://threads/${encodeURIComponent(candidate.threadId)}`);
    if (candidate.mode === 'prefill') url.searchParams.set('prompt', candidate.prompt);
    return url.toString();
  });
}

module.exports = {
  CONTINUATION_DRAFT,
  PLAN_VERSION,
  buildContinuationPlan,
  continuationDeepLinks,
  sameCandidates,
  sourceCandidates,
  usableUsageEntry,
  validateContinuationPlan,
  verifiedExhaustion,
};
