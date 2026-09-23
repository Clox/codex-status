'use strict';

const {
  FIVE_HOUR_WINDOW_SECONDS,
  assessCacheHealth,
  isFiveHourDormant,
  refreshUsageCache,
} = require('./codex-usage-cache');

const POST_DEADLINE_MIN_SECONDS = 17_400;
const POST_DEADLINE_MAX_SECONDS = 18_060;
const POST_FIELD_TOLERANCE_SECONDS = 6;
const DEFAULT_POST_SETTLE_MS = 1_500;
const DEFAULT_POST_OBSERVATION_DELAY_MS = 6_000;
const DEFAULT_PRE_TURN_OBSERVATION_DELAY_MS = 6_000;

function accountEntry(cache, accountId) {
  return cache?.accounts?.[accountId] || null;
}

async function appendFreshObservation({
  cache,
  accountId,
  accessToken,
  fetchObservation,
}) {
  const observation = await fetchObservation();
  if (!observation?.payload || !Number.isFinite(observation.observedAtMs)) {
    throw new Error('USAGE_PROTOCOL_MISMATCH');
  }
  return refreshUsageCache({
    accounts: [{ accountId }],
    credentialsByAccountId: new Map([[accountId, accessToken]]),
    previousCache: cache,
    fetchUsage: async () => observation,
    nowMs: observation.observedAtMs,
  });
}

function assertVerifiedFiveHourDormant(cache, accountId, nowMs = Date.now()) {
  const entry = accountEntry(cache, accountId);
  const cacheHealth = assessCacheHealth(cache, nowMs);
  if (!isFiveHourDormant(entry, { nowMs, cacheHealth })) {
    throw new Error('ACCOUNT_NOT_FIVE_HOUR_DORMANT');
  }
  return entry;
}

async function verifyFiveHourDormantPrecondition({
  cache,
  accountId,
  accessToken,
  fetchObservation,
  nowMs = Date.now(),
}) {
  assertVerifiedFiveHourDormant(cache, accountId, nowMs);
  const refreshedCache = await appendFreshObservation({
    cache,
    accountId,
    accessToken,
    fetchObservation,
  });
  const refreshedEntry = accountEntry(refreshedCache, accountId);
  const refreshedAtMs = Number(refreshedEntry?.refresh?.lastSuccessAt);
  assertVerifiedFiveHourDormant(refreshedCache, accountId, refreshedAtMs);
  return refreshedCache;
}

function clearPrimaryObservationHistory(cache, accountId) {
  const entry = accountEntry(cache, accountId);
  return {
    ...cache,
    accounts: {
      ...(cache?.accounts || {}),
      [accountId]: {
        ...(entry || {}),
        observations: {
          ...(entry?.observations || {}),
          primary: [],
        },
      },
    },
  };
}

async function reverifyFiveHourDormantAfterConfirmation({
  cache,
  accountId,
  accessToken,
  fetchObservation,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  observationDelayMs = DEFAULT_PRE_TURN_OBSERVATION_DELAY_MS,
}) {
  let refreshedCache = clearPrimaryObservationHistory(cache, accountId);
  refreshedCache = await appendFreshObservation({
    cache: refreshedCache,
    accountId,
    accessToken,
    fetchObservation,
  });
  await delay(observationDelayMs);
  refreshedCache = await appendFreshObservation({
    cache: refreshedCache,
    accountId,
    accessToken,
    fetchObservation,
  });
  const refreshedEntry = accountEntry(refreshedCache, accountId);
  const refreshedAtMs = Number(refreshedEntry?.refresh?.lastSuccessAt);
  assertVerifiedFiveHourDormant(refreshedCache, accountId, refreshedAtMs);
  return refreshedCache;
}

function lastPrimaryObservations(cache, accountId) {
  const observations = accountEntry(cache, accountId)?.observations?.primary;
  return Array.isArray(observations) ? observations.slice(-2) : [];
}

function isFixedFiveHourWindow(cache, accountId) {
  const entry = accountEntry(cache, accountId);
  const currentAtMs = Number(entry?.refresh?.lastSuccessAt);
  if (!Number.isFinite(currentAtMs)) return false;
  const cacheHealth = assessCacheHealth(cache, currentAtMs);
  if (isFiveHourDormant(entry, { nowMs: currentAtMs, cacheHealth })) return false;

  const [previous, current] = lastPrimaryObservations(cache, accountId);
  if (!previous || !current) return false;
  const validShape = observation =>
    observation.limitWindowSeconds === FIVE_HOUR_WINDOW_SECONDS &&
    Number.isFinite(observation.resetAfterSeconds) &&
    Number.isFinite(observation.resetAt) &&
    Number.isFinite(observation.serverObservedAtMs) &&
    Math.abs(
      observation.resetAt -
      (observation.serverObservedAtMs / 1000 + observation.resetAfterSeconds)
    ) <= POST_FIELD_TOLERANCE_SECONDS;
  if (!validShape(previous) || !validShape(current)) return false;

  const firstHorizonSeconds = previous.resetAt - previous.serverObservedAtMs / 1000;
  if (firstHorizonSeconds < POST_DEADLINE_MIN_SECONDS || firstHorizonSeconds > POST_DEADLINE_MAX_SECONDS) {
    return false;
  }
  const observationDeltaSeconds = (current.serverObservedAtMs - previous.serverObservedAtMs) / 1000;
  if (observationDeltaSeconds < 5) return false;
  if (Math.abs(current.resetAt - previous.resetAt) > POST_FIELD_TOLERANCE_SECONDS) return false;
  const countdownDeltaSeconds = previous.resetAfterSeconds - current.resetAfterSeconds;
  return countdownDeltaSeconds > 0 &&
    Math.abs(countdownDeltaSeconds - observationDeltaSeconds) <= POST_FIELD_TOLERANCE_SECONDS;
}

function fixedResetHours(cache, accountId) {
  const observations = lastPrimaryObservations(cache, accountId);
  const current = observations.at(-1);
  if (!current) return null;
  return (current.resetAt - current.serverObservedAtMs / 1000) / 3600;
}

async function executeVerifiedFiveHourActivation({
  cache,
  accountId,
  accessToken,
  fetchObservation,
  runTurn,
  assertCanActivate = () => {},
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  postSettleMs = DEFAULT_POST_SETTLE_MS,
  postObservationDelayMs = DEFAULT_POST_OBSERVATION_DELAY_MS,
  preTurnObservationDelayMs = DEFAULT_PRE_TURN_OBSERVATION_DELAY_MS,
}) {
  const before = await reverifyFiveHourDormantAfterConfirmation({
    cache,
    accountId,
    accessToken,
    fetchObservation,
    delay,
    observationDelayMs: preTurnObservationDelayMs,
  });
  await assertCanActivate();
  await runTurn();

  await delay(postSettleMs);
  const afterFirst = await appendFreshObservation({
    cache: before,
    accountId,
    accessToken,
    fetchObservation,
  });
  await delay(postObservationDelayMs);
  const afterSecond = await appendFreshObservation({
    cache: afterFirst,
    accountId,
    accessToken,
    fetchObservation,
  });
  if (!isFixedFiveHourWindow(afterSecond, accountId)) {
    throw new Error('FIVE_HOUR_ACTIVATION_NOT_VERIFIED');
  }
  return { before, after: afterSecond };
}

module.exports = {
  DEFAULT_POST_OBSERVATION_DELAY_MS,
  DEFAULT_POST_SETTLE_MS,
  DEFAULT_PRE_TURN_OBSERVATION_DELAY_MS,
  POST_DEADLINE_MAX_SECONDS,
  POST_DEADLINE_MIN_SECONDS,
  appendFreshObservation,
  assertVerifiedFiveHourDormant,
  executeVerifiedFiveHourActivation,
  fixedResetHours,
  isFixedFiveHourWindow,
  reverifyFiveHourDormantAfterConfirmation,
  verifyFiveHourDormantPrecondition,
};
