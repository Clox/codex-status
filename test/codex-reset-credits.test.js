'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  countdownHoursAndMinutes,
  formatResetValue,
  parseResetCreditsResponse,
} = require('../lib/codex-reset-credits');

const NOW_MS = Date.parse('2026-09-19T12:00:00Z');

test('parses every available expiration and chooses the earliest', () => {
  const parsed = parseResetCreditsResponse({
    available_count: 2,
    credits: [
      { status: 'available', reset_type: 'codex_rate_limits', expires_at: '2026-09-22T12:00:00Z' },
      { status: 'available', reset_type: 'codex_rate_limits', expires_at: '2026-09-20T13:04:00Z' },
    ],
  });

  assert.equal(parsed.availableCount, 2);
  assert.equal(parsed.detailsComplete, true);
  assert.deepEqual(parsed.expirationsMs, [
    Date.parse('2026-09-20T13:04:00Z'),
    Date.parse('2026-09-22T12:00:00Z'),
  ]);
  assert.equal(parsed.earliestExpirationMs, Date.parse('2026-09-20T13:04:00Z'));
});

test('marks details incomplete when the authoritative count exceeds returned rows', () => {
  const parsed = parseResetCreditsResponse({
    availableCount: 2,
    credits: [{ status: 'available', resetType: 'codexRateLimits', expiresAt: '2026-09-20T00:00:00Z' }],
  });
  assert.equal(parsed.availableCount, 2);
  assert.equal(parsed.detailsComplete, false);
});

test('formats zero, one and multiple resets with a three-digit hour countdown', () => {
  assert.equal(formatResetValue({ availableCount: 0 }, NOW_MS), '    -    ');
  assert.equal(formatResetValue({
    availableCount: 1,
    detailsComplete: true,
    earliestExpirationMs: NOW_MS + (25 * 60 + 4) * 60_000,
  }, NOW_MS), ' 1×025:04');
  assert.equal(formatResetValue({
    availableCount: 12,
    detailsComplete: true,
    earliestExpirationMs: NOW_MS + (120 * 60 + 45) * 60_000,
  }, NOW_MS), '12×120:45');
});

test('keeps exact hours beyond 999 instead of truncating the countdown', () => {
  assert.equal(formatResetValue({
    availableCount: 2,
    detailsComplete: true,
    earliestExpirationMs: NOW_MS + (1_204 * 60 + 7) * 60_000,
  }, NOW_MS), ' 2×1204:07');
});

test('does not claim an expiration when detail rows are incomplete', () => {
  assert.equal(formatResetValue({
    availableCount: 2,
    detailsComplete: false,
    earliestExpirationMs: NOW_MS + 60_000,
  }, NOW_MS), ' 2×???:??');
});

test('rounds a partial minute upward and clamps expired credits to zero', () => {
  assert.deepEqual(countdownHoursAndMinutes(NOW_MS + 60_001, NOW_MS), { hours: 0, minutes: 2 });
  assert.deepEqual(countdownHoursAndMinutes(NOW_MS - 1, NOW_MS), { hours: 0, minutes: 0 });
});
