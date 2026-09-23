'use strict';

const { DEFAULTS } = require('./codex-account-ranking');

const FRESH_MAX_AGE_MS = 180_000;

function observationKey(accounts, nowMs) {
  if (accounts.some(account =>
    account?.usageQuality !== 'verified' ||
    !Number.isFinite(account?.usageLastSuccessAtMs) ||
    account.usageLastSuccessAtMs > nowMs ||
    nowMs - account.usageLastSuccessAtMs > FRESH_MAX_AGE_MS
  )) return null;
  return JSON.stringify(accounts.map(account => [account.accountId, account.usageLastSuccessAtMs]));
}

function newerObservation(previousKey, currentKey) {
  if (!previousKey || !currentKey) return false;
  try {
    const previous = new Map(JSON.parse(previousKey));
    const current = new Map(JSON.parse(currentKey));
    return previous.size === current.size && [...previous].every(([id, at]) =>
      Number.isFinite(at) && Number.isFinite(current.get(id)) && current.get(id) > at
    );
  } catch {
    return false;
  }
}

function attentionDecision(ranked, recommendation, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const nowMs = options.nowMs ?? Date.now();
  const active = ranked.find(account => account.active) || null;
  const candidate = recommendation?.account;
  const observed = observationKey(active ? [active, candidate].filter(Boolean) : [candidate].filter(Boolean), nowMs);
  const inactive = { worthy: false, immediate: false, fingerprint: null, observationKey: observed };
  if (!candidate?.accountId || recommendation?.action !== 'switch' || !observed) return inactive;
  if (candidate.usageQuality !== 'verified' || candidate.fiveHourRemaining <= 0 || candidate.weeklyRemaining <= 0) return inactive;
  if (active && (!active.accountId || active.usageQuality !== 'verified')) return inactive;

  let situationClass = null;
  let immediate = false;
  if (recommendation.reason === 'needs-activation') {
    situationClass = 'needs-activation';
    immediate = true;
  } else if (!active) {
    situationClass = 'no-active-account';
    immediate = true;
  } else if (active.weeklyRemaining === 0) {
    situationClass = 'weekly-exhausted';
    immediate = true;
  } else if (active.fiveHourRemaining === 0) {
    situationClass = 'five-hour-exhausted';
    immediate = true;
  } else if (active.weeklyUrgency < candidate.weeklyUrgency * (1 - settings.switchHysteresis)) {
    situationClass = 'weekly-advantage';
  } else {
    const nearEqualWeekly = active.weeklyUrgency >=
      candidate.weeklyUrgency * (1 - settings.weeklyUrgencyTolerance);
    const fiveHourAdvantage = candidate.fiveHourScore - active.fiveHourScore;
    if (nearEqualWeekly &&
        active.fiveHourScore <= settings.fiveHourCriticalScore &&
        fiveHourAdvantage >= settings.fiveHourSwitchMarginPoints &&
        fiveHourAdvantage / Math.max(active.fiveHourScore, 1) >= settings.switchHysteresis) {
      situationClass = 'five-hour-availability';
    }
  }

  if (!situationClass) return inactive;
  return {
    worthy: true,
    immediate,
    fingerprint: `${active?.accountId || 'none'}→${candidate.accountId}:${situationClass}`,
    situationClass,
    observationKey: observed,
  };
}

function advanceAttentionState(previous, decision, focused) {
  const state = {
    acknowledged: { ...(previous?.acknowledged || {}) },
    pendingFingerprint: previous?.pendingFingerprint || null,
    pendingObservationKey: previous?.pendingObservationKey || null,
    resolvedObservationKey: previous?.resolvedObservationKey || null,
    lastFingerprint: previous?.lastFingerprint || null,
    attention: Boolean(previous?.attention),
    persistentUntilFocus: previous?.persistentUntilFocus === true,
  };
  const fingerprint = decision?.worthy ? decision.fingerprint : null;
  if (state.attention && state.persistentUntilFocus && !focused && fingerprint !== state.lastFingerprint) {
    return state;
  }
  if (!fingerprint) {
    if (state.attention && state.persistentUntilFocus && !focused) return state;
    state.attention = false;
    state.persistentUntilFocus = false;
    state.pendingFingerprint = null;
    state.pendingObservationKey = null;
    if (decision?.observationKey) {
      if (newerObservation(state.resolvedObservationKey, decision.observationKey)) {
        state.acknowledged = {};
        state.lastFingerprint = null;
      }
      state.resolvedObservationKey = decision.observationKey;
    }
    return state;
  }

  state.resolvedObservationKey = null;
  state.lastFingerprint = fingerprint;
  if (focused) {
    state.acknowledged[fingerprint] = true;
    state.attention = false;
    state.persistentUntilFocus = false;
    state.pendingFingerprint = null;
    state.pendingObservationKey = null;
    return state;
  }
  if (state.acknowledged[fingerprint]) {
    state.attention = false;
    return state;
  }
  if (decision.immediate) {
    state.attention = true;
    state.persistentUntilFocus = decision.persistentUntilFocus === true;
    return state;
  }
  if (state.pendingFingerprint !== fingerprint) {
    state.pendingFingerprint = fingerprint;
    state.pendingObservationKey = decision.observationKey;
    state.attention = false;
    return state;
  }
  if (newerObservation(state.pendingObservationKey, decision.observationKey)) state.attention = true;
  return state;
}

module.exports = { attentionDecision, advanceAttentionState, observationKey };
