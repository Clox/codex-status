'use strict';

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_FRESH_MAX_AGE_MS = 180_000;
const DEFAULT_UNVERIFIED_MAX_AGE_MS = 900_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const MAX_RAW_OBSERVATIONS = 256;
const FIVE_HOUR_WINDOW_SECONDS = 18_000;
const DORMANT_FIELD_TOLERANCE_SECONDS = 5;
const DORMANT_MOVEMENT_TOLERANCE_SECONDS = 5;
const DORMANT_MIN_OBSERVATION_SEPARATION_MS = 5_000;
const CACHE_VERSION = 3;

const PERMANENT_ERROR_KINDS = new Set([
  'auth-401',
  'auth-403',
  'missing-credentials',
  'invalid-credentials',
  'protocol',
]);

function finiteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function clampPercentage(value) {
  return Math.min(100, Math.max(0, value));
}

function parseWindow(window, nowMs) {
  if (!window || typeof window !== 'object') {
    throw new Error('usage response is missing a rate-limit window');
  }

  const usedPercent = finiteNumber(window.used_percent, window.usedPercent);
  if (usedPercent === null) throw new Error('usage response is missing used_percent');

  const rawResetAt = finiteNumber(window.reset_at, window.resetAt);
  const resetAfterSeconds = finiteNumber(window.reset_after_seconds, window.resetAfterSeconds);
  const windowSeconds = finiteNumber(window.limit_window_seconds, window.limitWindowSeconds);
  let resetsAt = rawResetAt;
  if (resetsAt === null) {
    if (resetAfterSeconds !== null) resetsAt = nowMs / 1000 + resetAfterSeconds;
  }

  return {
    remainingPercent: Math.round(clampPercentage(100 - usedPercent)),
    usedPercent: clampPercentage(usedPercent),
    resetsAt,
    windowSeconds,
    raw: {
      usedPercent,
      limitWindowSeconds: windowSeconds,
      resetAfterSeconds,
      resetAt: rawResetAt,
    },
  };
}

function selectRateLimit(payload) {
  if (payload?.rate_limit) return payload.rate_limit;
  if (payload?.rateLimit) return payload.rateLimit;
  const byLimitId = payload?.rate_limits_by_limit_id || payload?.rateLimitsByLimitId;
  if (byLimitId?.codex) return byLimitId.codex;
  if (byLimitId && typeof byLimitId === 'object') {
    return Object.values(byLimitId).find(Boolean) || null;
  }
  return null;
}

function parseUsageResponse(payload, nowMs = Date.now()) {
  const rateLimit = selectRateLimit(payload);
  if (!rateLimit) throw new Error('usage response is missing rate_limit');
  return {
    primary: parseWindow(rateLimit.primary_window || rateLimit.primaryWindow, nowMs),
    secondary: parseWindow(rateLimit.secondary_window || rateLimit.secondaryWindow, nowMs),
    planType: payload.plan_type || payload.planType || null,
  };
}

function shouldRefreshCache(cache, nowMs = Date.now(), pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
  const attemptedAtMs = Number(cache?.lastAttemptAtMs);
  return !Number.isFinite(attemptedAtMs) || nowMs - attemptedAtMs >= pollIntervalMs;
}

function rawObservation(window, observedAtMs, serverObservedAtMs) {
  return {
    observedAtMs,
    serverObservedAtMs,
    usedPercent: window.raw.usedPercent,
    limitWindowSeconds: window.raw.limitWindowSeconds,
    resetAfterSeconds: window.raw.resetAfterSeconds,
    resetAt: window.raw.resetAt,
  };
}

function appendObservation(previous, observation) {
  const history = Array.isArray(previous) ? previous : [];
  return [...history, observation].slice(-MAX_RAW_OBSERVATIONS);
}

function unwrapFetchedUsage(fetched, fallbackObservedAtMs) {
  if (fetched?.payload && typeof fetched.payload === 'object') {
    return {
      payload: fetched.payload,
      observedAtMs: finiteNumber(fetched.observedAtMs, fallbackObservedAtMs),
      serverObservedAtMs: finiteNumber(fetched.serverObservedAtMs),
    };
  }
  return {
    payload: fetched,
    observedAtMs: fallbackObservedAtMs,
    serverObservedAtMs: null,
  };
}

async function refreshUsageCache({
  accounts,
  credentialsByAccountId,
  previousCache = {},
  fetchUsage,
  nowMs = Date.now(),
}) {
  const oldAccounts = previousCache.accounts || {};
  const results = await Promise.all(accounts.map(async account => {
    const accountId = account.chatgpt_account_id || account.accountId;
    const accessToken = credentialsByAccountId.get(accountId);
    const previous = oldAccounts[accountId] || null;
    const previousRefresh = previous?.refresh || {};
    const previousSuccessAt = previousRefresh.lastSuccessAt ?? previous?.lastSuccessAtMs ?? previous?.fetchedAtMs ?? null;
    const previousFailures = Number(previousRefresh.consecutiveFailures ?? previous?.consecutiveFailures ?? 0);

    if (!accountId || !accessToken) {
      return [accountId, {
        ...(previous || {}),
        refresh: {
          lastSuccessAt: previousSuccessAt,
          lastAttemptAt: nowMs,
          lastErrorAt: nowMs,
          errorKind: 'missing-credentials',
          httpStatus: null,
          consecutiveFailures: previousFailures + 1,
        },
      }];
    }

    try {
      const fetched = await fetchUsage(accountId, accessToken);
      const observation = unwrapFetchedUsage(fetched, nowMs);
      let parsed;
      try {
        parsed = parseUsageResponse(observation.payload, observation.observedAtMs);
      } catch (error) {
        const protocolError = new Error('usage response protocol mismatch');
        protocolError.errorKind = 'protocol';
        protocolError.httpStatus = null;
        throw protocolError;
      }
      return [accountId, {
        ...parsed,
        fetchedAtMs: observation.observedAtMs,
        serverObservedAtMs: observation.serverObservedAtMs,
        observations: {
          primary: appendObservation(
            previous?.observations?.primary,
            rawObservation(parsed.primary, observation.observedAtMs, observation.serverObservedAtMs)
          ),
          secondary: appendObservation(
            previous?.observations?.secondary,
            rawObservation(parsed.secondary, observation.observedAtMs, observation.serverObservedAtMs)
          ),
        },
        refresh: {
          lastSuccessAt: observation.observedAtMs,
          lastAttemptAt: observation.observedAtMs,
          lastErrorAt: null,
          errorKind: null,
          httpStatus: 200,
          consecutiveFailures: 0,
        },
      }];
    } catch (error) {
      return [accountId, {
        ...(previous || {}),
        refresh: {
          lastSuccessAt: previousSuccessAt,
          lastAttemptAt: nowMs,
          lastErrorAt: nowMs,
          errorKind: error?.errorKind || 'unknown',
          httpStatus: Number.isFinite(error?.httpStatus) ? error.httpStatus : null,
          consecutiveFailures: previousFailures + 1,
        },
      }];
    }
  }));

  return {
    ...previousCache,
    version: CACHE_VERSION,
    lastAttemptAtMs: nowMs,
    worker: {
      ...(previousCache.worker || {}),
      version: CACHE_VERSION,
      heartbeatAtMs: nowMs,
      lastStartedAtMs: nowMs,
      lastCompletedAtMs: nowMs,
      lastFatalAtMs: null,
      fatalErrorKind: null,
    },
    accounts: Object.fromEntries(results.filter(([accountId]) => accountId)),
  };
}

function isFiveHourDormant(entry, {
  nowMs = Date.now(),
  cacheHealth = { healthy: true },
  freshMaxAgeMs = DEFAULT_FRESH_MAX_AGE_MS,
} = {}) {
  if (usageQuality(entry, { nowMs, cacheHealth, freshMaxAgeMs }) !== 'verified') return false;
  const observations = Array.isArray(entry?.observations?.primary)
    ? entry.observations.primary
    : [];
  const fresh = observations.filter(observation =>
    Number.isFinite(observation?.observedAtMs) &&
    nowMs - observation.observedAtMs >= 0 &&
    nowMs - observation.observedAtMs <= freshMaxAgeMs
  );
  if (fresh.length < 2) return false;
  const [previous, current] = fresh.slice(-2);

  const matchesDormantShape = observation =>
    observation.usedPercent === 0 &&
    observation.limitWindowSeconds === FIVE_HOUR_WINDOW_SECONDS &&
    Number.isFinite(observation.resetAfterSeconds) &&
    Math.abs(observation.resetAfterSeconds - FIVE_HOUR_WINDOW_SECONDS) <= DORMANT_FIELD_TOLERANCE_SECONDS &&
    Number.isFinite(observation.resetAt) &&
    Number.isFinite(observation.serverObservedAtMs) &&
    Math.abs(
      observation.resetAt -
      (observation.serverObservedAtMs / 1000 + FIVE_HOUR_WINDOW_SECONDS)
    ) <= DORMANT_FIELD_TOLERANCE_SECONDS;

  if (!matchesDormantShape(previous) || !matchesDormantShape(current)) return false;
  const observationDeltaSeconds = (current.serverObservedAtMs - previous.serverObservedAtMs) / 1000;
  const deadlineDeltaSeconds = current.resetAt - previous.resetAt;
  if (observationDeltaSeconds < DORMANT_MIN_OBSERVATION_SEPARATION_MS / 1000) return false;
  return deadlineDeltaSeconds > 0 &&
    Math.abs(deadlineDeltaSeconds - observationDeltaSeconds) <= DORMANT_MOVEMENT_TOLERANCE_SECONDS;
}

function validCachedUsage(entry) {
  return Number.isFinite(entry?.primary?.remainingPercent) &&
    Number.isFinite(entry?.secondary?.remainingPercent);
}

function isPermanentError(entry) {
  return PERMANENT_ERROR_KINDS.has(refreshState(entry).errorKind);
}

function refreshState(entry) {
  const structured = entry?.refresh && typeof entry.refresh === 'object' ? entry.refresh : null;
  return {
    lastSuccessAt: structured ? structured.lastSuccessAt : entry?.lastSuccessAtMs ?? entry?.fetchedAtMs ?? null,
    lastAttemptAt: structured ? structured.lastAttemptAt : entry?.lastAttemptAtMs ?? null,
    lastErrorAt: structured ? structured.lastErrorAt : entry?.lastErrorAtMs ?? null,
    errorKind: structured ? structured.errorKind : entry?.errorKind ?? null,
    httpStatus: structured ? structured.httpStatus : entry?.httpStatus ?? null,
    consecutiveFailures: Number(structured ? structured.consecutiveFailures : entry?.consecutiveFailures ?? 0),
  };
}

function assessCacheHealth(cache, nowMs = Date.now(), maxAgeMs = DEFAULT_UNVERIFIED_MAX_AGE_MS) {
  const heartbeatAtMs = Number(cache?.worker?.heartbeatAtMs ?? cache?.lastAttemptAtMs);
  const ageMs = Number.isFinite(heartbeatAtMs)
    ? Math.max(0, nowMs - heartbeatAtMs)
    : Number.POSITIVE_INFINITY;
  const fatal = Boolean(cache?.worker?.fatalErrorKind);
  return {
    healthy: !fatal && ageMs <= maxAgeMs,
    ageMs,
    heartbeatAtMs: Number.isFinite(heartbeatAtMs) ? heartbeatAtMs : null,
    fatalErrorKind: cache?.worker?.fatalErrorKind || null,
  };
}

function usageQuality(entry, {
  nowMs = Date.now(),
  freshMaxAgeMs = DEFAULT_FRESH_MAX_AGE_MS,
  unverifiedMaxAgeMs = DEFAULT_UNVERIFIED_MAX_AGE_MS,
  maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
  cacheHealth = { healthy: true },
} = {}) {
  if (!validCachedUsage(entry)) return 'unverified';
  const refresh = refreshState(entry);
  const lastSuccessAtMs = Number(refresh.lastSuccessAt);
  const ageMs = Number.isFinite(lastSuccessAtMs)
    ? Math.max(0, nowMs - lastSuccessAtMs)
    : Number.POSITIVE_INFINITY;
  const failures = refresh.consecutiveFailures;

  if (!cacheHealth.healthy || isPermanentError(entry) || failures >= maxConsecutiveFailures) {
    return 'unverified';
  }
  if (!refresh.errorKind && ageMs <= freshMaxAgeMs) return 'verified';
  if (ageMs <= unverifiedMaxAgeMs) return 'stale';
  return 'unverified';
}

function resolveUsage({
  serverEntry,
  localPrimaryRemaining,
  localSecondaryRemaining,
  localUsage,
  nowMs = Date.now(),
  freshMaxAgeMs = DEFAULT_FRESH_MAX_AGE_MS,
  unverifiedMaxAgeMs = DEFAULT_UNVERIFIED_MAX_AGE_MS,
  maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
  cacheHealth = { healthy: true },
}) {
  if (validCachedUsage(serverEntry)) {
    const refresh = refreshState(serverEntry);
    const lastSuccessAtMs = Number(refresh.lastSuccessAt);
    const quality = usageQuality(serverEntry, {
      nowMs,
      freshMaxAgeMs,
      unverifiedMaxAgeMs,
      maxConsecutiveFailures,
      cacheHealth,
    });
    const healthErrorKind = isPermanentError(serverEntry)
      ? refresh.errorKind
      : cacheHealth.fatalErrorKind || (!cacheHealth.healthy ? 'worker-stale' : refresh.errorKind || null);
    return {
      primary: serverEntry.primary,
      secondary: serverEntry.secondary,
      source: quality === 'verified' ? 'server' : quality === 'stale' ? 'server-stale' : 'server-unverified',
      quality,
      fresh: quality === 'verified',
      ageMs: Number.isFinite(lastSuccessAtMs) ? Math.max(0, nowMs - lastSuccessAtMs) : Number.POSITIVE_INFINITY,
      lastSuccessAtMs: Number.isFinite(lastSuccessAtMs) ? lastSuccessAtMs : null,
      lastAttemptAtMs: Number.isFinite(Number(refresh.lastAttemptAt)) ? Number(refresh.lastAttemptAt) : null,
      errorKind: healthErrorKind,
      httpStatus: refresh.httpStatus !== null && refresh.httpStatus !== undefined && Number.isFinite(Number(refresh.httpStatus))
        ? Number(refresh.httpStatus)
        : null,
      consecutiveFailures: refresh.consecutiveFailures,
    };
  }

  const refresh = refreshState(serverEntry);
  return {
    primary: {
      remainingPercent: localPrimaryRemaining,
      resetsAt: localUsage?.primary?.resets_at,
    },
    secondary: {
      remainingPercent: localSecondaryRemaining,
      resetsAt: localUsage?.secondary?.resets_at,
    },
    source: 'local-unverified',
    quality: 'unverified',
    fresh: false,
    ageMs: Number.POSITIVE_INFINITY,
    lastSuccessAtMs: null,
    lastAttemptAtMs: Number.isFinite(Number(refresh.lastAttemptAt)) ? Number(refresh.lastAttemptAt) : null,
    errorKind: refresh.errorKind || (serverEntry ? 'invalid-cache' : 'no-server-data'),
    httpStatus: refresh.httpStatus !== null && refresh.httpStatus !== undefined && Number.isFinite(Number(refresh.httpStatus))
      ? Number(refresh.httpStatus)
      : null,
    consecutiveFailures: refresh.consecutiveFailures,
  };
}

module.exports = {
  CACHE_VERSION,
  DEFAULT_FRESH_MAX_AGE_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_UNVERIFIED_MAX_AGE_MS,
  FIVE_HOUR_WINDOW_SECONDS,
  MAX_RAW_OBSERVATIONS,
  PERMANENT_ERROR_KINDS,
  assessCacheHealth,
  isFiveHourDormant,
  parseUsageResponse,
  refreshUsageCache,
  resolveUsage,
  shouldRefreshCache,
  usageQuality,
};
