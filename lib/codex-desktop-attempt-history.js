'use strict';

const crypto = require('node:crypto');

const HISTORY_LIMIT = 24;
const OUTCOMES = new Set(['fallback-headless', 'send-confirmed', 'send-unconfirmed',
  'send-conflict', 'blocked/failed']);
const PHASES = new Set(['input-reconstruction', 'preparing', 'switching auth',
  'verifying target', 'desktop-restore', 'semantic-readiness', 'prefill',
  'send-commit', 'send-reconciliation', 'completed']);

function identifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value) ? value : null;
}

function errorKind(value) {
  return typeof value === 'string' &&
    /^(?:AUTO|DESKTOP|SEND|AT_SPI|CHAT_ACTIONS|COPY_DEEPLINK|COMPOSER|APP_SERVER|SOURCE|CANDIDATE|TURN|ACTIVE|RESUME|CODEX|ROLLOUT|FAILED|THREAD|TARGET|MANUAL|VSCODE|CLIENT|AUTH|RENDERER|PREFILL|ACCOUNT|PLAN|OBSERVER)_[A-Z0-9_:-]{1,150}$/.test(value)
    ? value : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function packageVersion(value) {
  return typeof value === 'string' && /^(?:[0-9]+:)?[0-9][a-zA-Z0-9.+:~_-]{0,79}$/.test(value)
    ? value : null;
}

function beginDesktopAttemptHistory(state, details, nowMs = Date.now()) {
  const entry = {
    attemptId: crypto.randomUUID(), startedAtMs: nowMs,
    threadId: identifier(details.threadId), failedTurnId: identifier(details.failedTurnId),
    sourceAccountId: identifier(details.sourceAccountId),
    targetAccountId: identifier(details.targetAccountId),
    desktopPackage: 'chatgpt',
    desktopPackageVersion: packageVersion(details.desktopPackageVersion),
    desktopRootPid: positiveInteger(details.desktopRootPid),
    desktopRootStartTicks: positiveInteger(details.desktopRootStartTicks),
    rendererPids: [], phase: 'preparing', errorKind: null,
    prefillStarted: false, promptInjected: false, sendAttemptCommitted: false, outcome: null,
    headlessContinuationTurnId: null, headlessTerminalStatus: null,
  };
  return { ...state, desktopAttemptHistory: [...(state.desktopAttemptHistory || []), entry]
    .slice(-HISTORY_LIMIT) };
}

function updateDesktopAttemptHistory(state, attemptId, change, nowMs = Date.now()) {
  if (!attemptId) return state;
  const history = (state.desktopAttemptHistory || []).map(entry => {
    if (entry.attemptId !== attemptId) return entry;
    const outcome = OUTCOMES.has(change.outcome) ? change.outcome : null;
    return {
      ...entry,
      ...(PHASES.has(change.phase) ? { phase: change.phase } : {}),
      ...(errorKind(change.errorKind) ? { errorKind: change.errorKind } : {}),
      ...(packageVersion(change.desktopPackageVersion)
        ? { desktopPackageVersion: change.desktopPackageVersion } : {}),
      ...(positiveInteger(change.desktopRootPid)
        ? { desktopRootPid: change.desktopRootPid } : {}),
      ...(positiveInteger(change.desktopRootStartTicks)
        ? { desktopRootStartTicks: change.desktopRootStartTicks } : {}),
      ...(Array.isArray(change.rendererPids) ? { rendererPids: change.rendererPids
        .map(positiveInteger).filter(Boolean).slice(0, 16) } : {}),
      prefillStarted: entry.prefillStarted || change.prefillStarted === true,
      promptInjected: entry.promptInjected || change.promptInjected === true,
      sendAttemptCommitted: entry.sendAttemptCommitted || change.sendAttemptCommitted === true,
      ...(outcome && (!entry.outcome ||
          (entry.outcome === 'blocked/failed' && outcome.startsWith('send-')))
        ? { outcome, finishedAtMs: nowMs } : {}),
    };
  });
  return { ...state, desktopAttemptHistory: history.slice(-HISTORY_LIMIT) };
}

function finishHeadlessFallbackHistory(state, candidate, result) {
  const history = [...(state.desktopAttemptHistory || [])];
  const index = history.findLastIndex(entry => entry.outcome === 'fallback-headless' &&
    entry.threadId === candidate?.threadId && entry.failedTurnId === candidate?.turnId &&
    !entry.headlessTerminalStatus);
  if (index < 0) return state;
  history[index] = { ...history[index],
    headlessContinuationTurnId: identifier(result?.turnId),
    headlessTerminalStatus: ['completed', 'failed', 'interrupted'].includes(result?.status)
      ? result.status : 'unknown',
  };
  return { ...state, desktopAttemptHistory: history.slice(-HISTORY_LIMIT) };
}

module.exports = { HISTORY_LIMIT, beginDesktopAttemptHistory, updateDesktopAttemptHistory,
  finishHeadlessFallbackHistory };
