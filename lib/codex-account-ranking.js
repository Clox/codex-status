'use strict';

const DEFAULTS = Object.freeze({
  weeklyUrgencyTolerance: 0.10,
  switchHysteresis: 0.10,
  fiveHourCriticalScore: 10,
  fiveHourSwitchMarginPoints: 10,
  fiveHourResetHorizonHours: 1,
  fiveHourResetBonusPoints: 20,
  minimumResetHours: 1 / 60,
});

function clampPercentage(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function hoursUntil(resetAt, nowMs) {
  if (!Number.isFinite(resetAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (resetAt * 1000 - nowMs) / 3_600_000);
}

function scoreAccount(account, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const nowMs = options.nowMs ?? Date.now();
  const weeklyRemaining = clampPercentage(account.weeklyRemaining);
  const fiveHourRemaining = clampPercentage(account.fiveHourRemaining);
  const weeklyResetHours = hoursUntil(account.weeklyResetAt, nowMs);
  const fiveHourResetHours = hoursUntil(account.fiveHourResetAt, nowMs);
  const needsActivation = weeklyRemaining === 100 && weeklyResetHours === 0;
  const weeklyUrgency = needsActivation || weeklyRemaining === 0 || !Number.isFinite(weeklyResetHours)
    ? 0
    : weeklyRemaining / Math.max(weeklyResetHours, settings.minimumResetHours);
  const resetProximity = Number.isFinite(fiveHourResetHours)
    ? Math.max(0, 1 - fiveHourResetHours / settings.fiveHourResetHorizonHours)
    : 0;
  const depletedFraction = 1 - fiveHourRemaining / 100;
  const fiveHourScore = fiveHourRemaining +
    settings.fiveHourResetBonusPoints * depletedFraction * resetProximity;

  return {
    ...account,
    weeklyRemaining,
    fiveHourRemaining,
    weeklyResetHours,
    fiveHourResetHours,
    needsActivation,
    weeklyUrgency,
    fiveHourScore,
  };
}

function stableOrder(account) {
  const numericSource = Number(account.sourceRow);
  if (Number.isFinite(numericSource)) return numericSource;
  return String(account.id ?? account.label ?? '');
}

function compareWithinUrgencyGroup(left, right) {
  if (Math.abs(left.fiveHourScore - right.fiveHourScore) > 0.001) {
    return right.fiveHourScore - left.fiveHourScore;
  }
  if (Math.abs(left.weeklyUrgency - right.weeklyUrgency) > 0.001) {
    return right.weeklyUrgency - left.weeklyUrgency;
  }
  if (left.active !== right.active) return left.active ? -1 : 1;
  return stableOrder(left) < stableOrder(right) ? -1 : 1;
}

function rankAccounts(accounts, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const scored = accounts.map(account => scoreAccount(account, settings));
  const activationAccounts = scored
    .filter(account => account.needsActivation)
    .sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      return stableOrder(left) < stableOrder(right) ? -1 : 1;
    });
  const availableWeekly = scored.filter(account => account.weeklyRemaining > 0 && !account.needsActivation);
  const exhaustedWeekly = scored.filter(account => account.weeklyRemaining === 0);
  const ranked = [...activationAccounts];
  let remaining = availableWeekly;

  while (remaining.length > 0) {
    const bestUrgency = Math.max(...remaining.map(account => account.weeklyUrgency));
    const cutoff = bestUrgency * (1 - settings.weeklyUrgencyTolerance);
    const group = remaining
      .filter(account => bestUrgency === 0 || account.weeklyUrgency >= cutoff)
      .sort(compareWithinUrgencyGroup);
    const grouped = new Set(group);
    ranked.push(...group);
    remaining = remaining.filter(account => !grouped.has(account));
  }

  exhaustedWeekly.sort((left, right) => {
    if (left.weeklyResetHours !== right.weeklyResetHours) {
      return left.weeklyResetHours - right.weeklyResetHours;
    }
    return compareWithinUrgencyGroup(left, right);
  });
  ranked.push(...exhaustedWeekly);

  return ranked.map((account, index) => ({ ...account, rank: index + 1 }));
}

function recommendAccount(rankedAccounts, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const active = rankedAccounts.find(account => account.active);
  const activationCandidate = rankedAccounts.find(account => account.needsActivation);

  if (activationCandidate) {
    return {
      action: activationCandidate.sourceRow === active?.sourceRow ? 'stay' : 'switch',
      account: activationCandidate,
      reason: 'needs-activation',
    };
  }

  const candidate = rankedAccounts.find(account =>
    account.weeklyRemaining > 0 && account.fiveHourRemaining > 0
  );

  if (!candidate) {
    return { action: 'stay', account: active ?? rankedAccounts[0] ?? null, reason: 'no-usable-alternative' };
  }
  if (!active) {
    return { action: 'switch', account: candidate, reason: 'no-active-account' };
  }
  if (candidate.sourceRow === active.sourceRow) {
    return { action: 'stay', account: active, reason: 'active-is-best' };
  }
  if (active.weeklyRemaining === 0) {
    return { action: 'switch', account: candidate, reason: 'active-weekly-exhausted' };
  }
  if (active.fiveHourRemaining === 0) {
    return { action: 'switch', account: candidate, reason: 'active-five-hour-exhausted' };
  }

  const clearWeeklyWinner = active.weeklyUrgency <
    candidate.weeklyUrgency * (1 - settings.switchHysteresis);
  if (clearWeeklyWinner) {
    return { action: 'switch', account: candidate, reason: 'weekly-urgency' };
  }

  if (active.fiveHourScore > settings.fiveHourCriticalScore) {
    return { action: 'stay', account: active, reason: 'active-five-hour-usable' };
  }

  const fiveHourAdvantage = candidate.fiveHourScore - active.fiveHourScore;
  const relativeFiveHourAdvantage = fiveHourAdvantage / Math.max(active.fiveHourScore, 1);
  if (
    fiveHourAdvantage >= settings.fiveHourSwitchMarginPoints &&
    relativeFiveHourAdvantage >= settings.switchHysteresis
  ) {
    return { action: 'switch', account: candidate, reason: 'five-hour-availability' };
  }

  return { action: 'stay', account: active, reason: 'hysteresis' };
}

module.exports = {
  DEFAULTS,
  hoursUntil,
  rankAccounts,
  recommendAccount,
  scoreAccount,
};
