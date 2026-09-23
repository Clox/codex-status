'use strict';

const STANDARD_RESET_VALUE_WIDTH = 8;

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function parseTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const timestampMs = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function parseResetCreditsResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;

  const availableCount = nonNegativeInteger(response.available_count ?? response.availableCount);
  if (availableCount === null) return null;

  const creditDetails = Array.isArray(response.credits) ? response.credits : null;
  const availableCredits = creditDetails?.filter(credit =>
    credit &&
    typeof credit === 'object' &&
    (credit.status === undefined || credit.status === 'available') &&
    (credit.reset_type === undefined || credit.reset_type === 'codex_rate_limits') &&
    (credit.resetType === undefined || credit.resetType === 'codexRateLimits')
  ) ?? [];
  const expirationsMs = availableCredits
    .map(credit => parseTimestamp(credit.expires_at ?? credit.expiresAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  return {
    availableCount,
    detailsComplete: creditDetails !== null && availableCredits.length >= availableCount,
    expirationsMs,
    earliestExpirationMs: expirationsMs[0] ?? null,
  };
}

function countdownHoursAndMinutes(expiresAtMs, nowMs) {
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return null;
  const totalMinutes = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 60_000));
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

function formatResetValue(resetInfo, nowMs = Date.now()) {
  const count = nonNegativeInteger(resetInfo?.availableCount);
  if (count === 0) return '-';
  if (count === null) return '?';

  const remaining = resetInfo?.detailsComplete
    ? countdownHoursAndMinutes(resetInfo.earliestExpirationMs, nowMs)
    : null;
  const countdown = remaining
    ? remaining.hours > 999
      ? '>999h'
      : `${String(remaining.hours).padStart(3, '0')}:${String(remaining.minutes).padStart(2, '0')}`
    : '???:??';
  return `${Math.min(count, 9)}×${countdown}`;
}

module.exports = {
  STANDARD_RESET_VALUE_WIDTH,
  countdownHoursAndMinutes,
  formatResetValue,
  parseResetCreditsResponse,
};
