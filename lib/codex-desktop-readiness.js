'use strict';

// Readiness polling used only for HEADLESS post-restore Desktop navigation.
const DESKTOP_PREFLIGHT_TIMEOUT_MS = 15_000;
const DESKTOP_PREFLIGHT_BACKOFF_MS = [200, 350, 500, 750, 1_000];

function credentialFreeErrorKind(error) {
  const value = String(error?.message || error?.errorKind || error?.name || 'DESKTOP_PREFLIGHT_FAILED');
  return /^[A-Z0-9_:-]{1,160}$/.test(value) ? value : 'DESKTOP_PREFLIGHT_FAILED';
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

module.exports = { waitForDesktopReadiness };
