'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  HEADLESS_CONTINUATION_PROMPT,
  INTERRUPTION_CLASS,
  continuationForCandidate,
} = require('./codex-turn-continuation');

const RESUME_STATE_VERSION = 2;
const CONTINUATION_PROMPT = HEADLESS_CONTINUATION_PROMPT;

async function restoreDesktopWithRetry({
  runningPids,
  launch,
  sleep,
  now = Date.now,
  attempts = 2,
  startupTimeoutMs = 10_000,
  stableMs = 10_000,
  pollMs = 250,
  retryDelayMs = 1_000,
}) {
  const existing = [...runningPids()];
  if (existing.length > 0) {
    return { launched: false, attempts: 0, desktopPid: existing[0], history: [] };
  }
  const history = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const record = {
      attempt,
      requestedAtMs: now(),
      launcherPid: launch(attempt)?.pid || null,
      desktopPid: null,
      result: 'startup-timeout',
    };
    history.push(record);

    let startupWaitedMs = 0;
    while (startupWaitedMs <= startupTimeoutMs) {
      const detected = [...runningPids()];
      if (detected.length > 0) {
        record.desktopPid = detected[0];
        record.detectedAtMs = now();
        record.result = 'stabilizing';
        break;
      }
      if (startupWaitedMs === startupTimeoutMs) break;
      const delay = Math.min(pollMs, startupTimeoutMs - startupWaitedMs);
      await sleep(delay);
      startupWaitedMs += delay;
    }

    if (record.desktopPid) {
      let stableForMs = 0;
      while (stableForMs < stableMs) {
        const delay = Math.min(pollMs, stableMs - stableForMs);
        await sleep(delay);
        stableForMs += delay;
        if (![...runningPids()].includes(record.desktopPid)) {
          record.result = 'exited-before-ready';
          record.exitedAtMs = now();
          break;
        }
      }
      if (record.result === 'stabilizing') {
        record.result = 'ready';
        record.readyAtMs = now();
        return {
          launched: true,
          attempts: attempt,
          desktopPid: record.desktopPid,
          history,
        };
      }
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  const error = new Error('DESKTOP_RESTORE_FAILED');
  error.diagnostics = { attempts: history };
  throw error;
}

function desktopRestoreLaunchSpec({ systemdRunBin, desktopLauncher, controllerPid, attempt }) {
  if (!systemdRunBin || !desktopLauncher || !Number.isInteger(controllerPid) || !Number.isInteger(attempt)) {
    throw new Error('DESKTOP_RESTORE_LAUNCH_SPEC_INVALID');
  }
  return {
    command: systemdRunBin,
    args: [
      '--user',
      '--quiet',
      '--collect',
      `--unit=codex-desktop-restore-${controllerPid}-${attempt}`,
      '--',
      desktopLauncher,
    ],
  };
}

function resumeProtocolRequests(threadId) {
  return {
    read: { threadId, includeTurns: false },
    latestTurn: { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' },
    resume: { threadId, excludeTurns: true },
  };
}

function splitJsonLines(buffer, chunk, maxFrameBytes) {
  let remaining = `${buffer || ''}${chunk || ''}`;
  const lines = [];
  let newline;
  while ((newline = remaining.indexOf('\n')) >= 0) {
    const line = remaining.slice(0, newline);
    remaining = remaining.slice(newline + 1);
    const frameBytes = Buffer.byteLength(line);
    if (frameBytes > maxFrameBytes) {
      const error = new Error('APP_SERVER_PROTOCOL_OVERFLOW');
      error.diagnostics = { limitBytes: maxFrameBytes, frameBytes, terminated: true };
      throw error;
    }
    if (line.trim()) lines.push(line);
  }
  const bufferedBytes = Buffer.byteLength(remaining);
  if (bufferedBytes > maxFrameBytes) {
    const error = new Error('APP_SERVER_PROTOCOL_OVERFLOW');
    error.diagnostics = { limitBytes: maxFrameBytes, bufferedBytes, terminated: false };
    throw error;
  }
  return { lines, remaining };
}

function candidateKey(threadId, turnId) {
  return JSON.stringify([threadId, turnId]);
}

function emptyResumeState() {
  return { version: RESUME_STATE_VERSION, attempts: {}, lastError: null };
}

function normalizeResumeState(value) {
  return {
    ...emptyResumeState(),
    ...(value && typeof value === 'object' ? value : {}),
    version: RESUME_STATE_VERSION,
    attempts: value?.attempts && typeof value.attempts === 'object' ? value.attempts : {},
  };
}

function atomicWriteJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filename), 0o700);
  const temporary = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

function pendingInterruptedTurns(eventState, resumeState = emptyResumeState()) {
  const attempts = normalizeResumeState(resumeState).attempts;
  return Object.values(eventState?.interruptedTurns || {})
    .filter(candidate => candidate?.resumable === true && candidate?.threadIdentityVerified === true)
    .filter(candidate => !candidate.parentThreadId && candidate.threadSource !== 'guardian_review')
    .filter(candidate => !attempts[candidateKey(candidate.threadId, candidate.turnId)]?.committedAtMs)
    .sort((left, right) => Number(left.completedAtMs) - Number(right.completedAtMs));
}

function currentResumeProblemLines(resumeState = emptyResumeState()) {
  return Object.values(normalizeResumeState(resumeState).attempts)
    .filter(attempt => attempt.status === 'MANUAL_REQUIRED_AFTER_COMMIT')
    .map(attempt => `MANUAL RESUME / ACTION REQUIRED: …${String(attempt.threadId || '').slice(-8)} was committed; no automatic retry (${attempt.errorKind || 'unknown error'}).`);
}

function interruptedCandidateProblemLines(eventState, resumeState = emptyResumeState(), { autoContinue = false } = {}) {
  const lines = [];
  for (const candidate of pendingInterruptedTurns(eventState, resumeState)) {
    const shortId = `…${String(candidate.threadId || '').slice(-8)}`;
    const headless = continuationForCandidate(candidate);
    if (candidate.interruptionClass === INTERRUPTION_CLASS.UNKNOWN || candidate.classificationVerified !== true) {
      lines.push(`QUOTA CONTINUATION / MANUAL REQUIRED: ${shortId} could not be classified safely.`);
      continue;
    }
    if (candidate.interruptionClass === INTERRUPTION_CLASS.BEFORE_WORK) {
      if (!headless.ok) {
        lines.push(`QUOTA CONTINUATION / MANUAL REQUIRED: ${shortId} original input cannot be reconstructed exactly.`);
        continue;
      }
      const desktop = continuationForCandidate(candidate, { desktop: true });
      if (!autoContinue && !desktop.ok) {
        lines.push(`QUOTA CONTINUATION / MANUAL REQUIRED: ${shortId} was rejected before work; resend its structured input manually.`);
      }
    }
  }
  return lines;
}

function codexErrorKind(error) {
  const value = error?.codexErrorInfo ?? error?.codex_error_info ?? null;
  return typeof value === 'string' ? value.replaceAll('_', '').toLowerCase() : null;
}

function isAppServerProcess(entry) {
  return Array.isArray(entry?.args) && entry.args.includes('app-server');
}

function isVsCodeCodexAppServerProcess(entry) {
  return isAppServerProcess(entry) &&
    /\/\.vscode\/extensions\/openai\.chatgpt-[^/]+\/bin\/[^/]+\/codex$/.test(entry.args[0] || '');
}

function automaticClientBlocker(entries) {
  const servers = (entries || []).filter(isVsCodeCodexAppServerProcess);
  if (servers.length === 0) return null;
  const hosts = [...new Set(servers.map(server => server.ppid))];
  const classified = hosts.every(hostPid => {
    const host = entries.find(entry => entry.pid === hostPid);
    return host?.args?.includes('--utility-sub-type=node.mojom.NodeService');
  });
  return {
    errorKind: classified
      ? 'AUTO_BLOCKED_VSCODE_CODEX_ACTIVE'
      : 'VSCODE_EXTENSION_HOST_UNVERIFIED',
    hosts,
    servers: servers.map(server => server.pid),
  };
}

function appServerExclusivityReport(entries, { desktopPids = [], ignoredPids = [] } = {}) {
  const desktop = new Set(desktopPids);
  const ignored = new Set(ignoredPids);
  const blockers = [];
  for (const entry of entries || []) {
    if (!isAppServerProcess(entry) || ignored.has(entry.pid)) continue;
    const vscode = isVsCodeCodexAppServerProcess(entry);
    if (vscode && ['T', 't'].includes(entry.state)) continue;
    blockers.push({
      pid: entry.pid,
      ppid: entry.ppid,
      state: entry.state || '?',
      role: desktop.has(entry.pid)
        ? 'desktop-app-server'
        : vscode
          ? 'vscode-app-server-not-quiescent'
          : 'other-app-server',
    });
  }
  return { exclusive: blockers.length === 0, blockers };
}

function validateThreadMetadataForResume({ candidate, thread, eventState, resumeState }) {
  if (!candidate?.threadId || !candidate?.turnId || candidate.threadIdentityVerified !== true) {
    throw new Error('CANDIDATE_IDENTITY_UNVERIFIED');
  }
  if (candidate.parentThreadId || candidate.threadSource === 'guardian_review') {
    throw new Error('CANDIDATE_NOT_MAIN_THREAD');
  }
  const key = candidateKey(candidate.threadId, candidate.turnId);
  const continuation = continuationForCandidate(candidate);
  if (candidate.classificationVerified !== true || !continuation.ok) {
    throw new Error(continuation.reason || 'CANDIDATE_CLASSIFICATION_UNVERIFIED');
  }
  const persisted = eventState?.interruptedTurns?.[key];
  const persistedContinuation = continuationForCandidate(persisted);
  if (
    !persisted ||
    persisted.classificationVerified !== true ||
    !persistedContinuation.ok ||
    persisted.interruptionClass !== candidate.interruptionClass ||
    persistedContinuation.inputHash !== continuation.inputHash
  ) throw new Error('CANDIDATE_EVIDENCE_CHANGED');
  if (normalizeResumeState(resumeState).attempts[key]?.committedAtMs) {
    throw new Error('RESUME_ALREADY_COMMITTED');
  }
  if (Object.values(eventState?.activeTurns || {}).some(turn => turn.threadId === candidate.threadId)) {
    throw new Error('THREAD_STILL_ACTIVE');
  }
  if (thread?.id !== candidate.threadId) throw new Error('THREAD_ID_MISMATCH');
  const status = thread?.status?.type;
  if (status !== 'idle' && status !== 'notLoaded') throw new Error('THREAD_NOT_IDLE');
  return true;
}

function validateThreadForResume({ candidate, thread, eventState, resumeState }) {
  validateThreadMetadataForResume({ candidate, thread, eventState, resumeState });
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const latest = turns.at(-1);
  if (!latest || latest.id !== candidate.turnId) throw new Error('CANDIDATE_NOT_LATEST_TURN');
  if (latest.status !== 'failed' || codexErrorKind(latest.error) !== 'usagelimitexceeded') {
    throw new Error('LATEST_TURN_NOT_VERIFIED_EXHAUSTION');
  }
  return true;
}

function markResumeCommitted(stateInput, candidate, details = {}, nowMs = Date.now()) {
  const state = normalizeResumeState(stateInput);
  const key = candidateKey(candidate.threadId, candidate.turnId);
  if (state.attempts[key]?.committedAtMs) throw new Error('RESUME_ALREADY_COMMITTED');
  const continuation = details.continuation;
  if (
    !continuation?.ok ||
    continuation.classification !== candidate.interruptionClass ||
    !/^[0-9a-f]{64}$/.test(continuation.inputHash || '')
  ) throw new Error('RESUME_INPUT_UNVERIFIED');
  state.attempts[key] = {
    threadId: candidate.threadId,
    interruptedTurnId: candidate.turnId,
    accountId: candidate.accountId || null,
    targetAccountId: details.targetAccountId || null,
    interruptionClass: continuation.classification,
    continuationKind: continuation.kind,
    inputHash: continuation.inputHash,
    committedAtMs: nowMs,
    status: 'RESUME_COMMITTED',
    continuationTurnId: null,
    completedAtMs: null,
    terminalStatus: null,
    errorKind: null,
  };
  state.lastError = null;
  return state;
}

function markResumeTerminal(stateInput, candidate, { turnId, status, errorKind = null }, nowMs = Date.now()) {
  const state = normalizeResumeState(stateInput);
  const key = candidateKey(candidate.threadId, candidate.turnId);
  const attempt = state.attempts[key];
  if (!attempt?.committedAtMs) throw new Error('RESUME_NOT_COMMITTED');
  state.attempts[key] = {
    ...attempt,
    continuationTurnId: turnId || attempt.continuationTurnId,
    completedAtMs: nowMs,
    terminalStatus: status || null,
    errorKind,
    status: status === 'completed' ? 'COMPLETED' : 'TERMINAL_AFTER_COMMIT',
  };
  return state;
}

function markResumeFailure(stateInput, candidate, errorKind, { committed = false, diagnostics = null } = {}, nowMs = Date.now()) {
  const state = normalizeResumeState(stateInput);
  const key = candidateKey(candidate.threadId, candidate.turnId);
  if (committed || state.attempts[key]?.committedAtMs) {
    state.attempts[key] = {
      ...(state.attempts[key] || {}),
      threadId: candidate.threadId,
      interruptedTurnId: candidate.turnId,
      committedAtMs: state.attempts[key]?.committedAtMs || nowMs,
      status: 'MANUAL_REQUIRED_AFTER_COMMIT',
      errorKind,
      diagnostics,
      failedAtMs: nowMs,
    };
  } else {
    state.lastError = {
      threadId: candidate.threadId,
      interruptedTurnId: candidate.turnId,
      errorKind,
      diagnostics,
      failedAtMs: nowMs,
      actionRequired: true,
    };
  }
  return state;
}

module.exports = {
  CONTINUATION_PROMPT,
  RESUME_STATE_VERSION,
  atomicWriteJson,
  automaticClientBlocker,
  appServerExclusivityReport,
  candidateKey,
  codexErrorKind,
  currentResumeProblemLines,
  interruptedCandidateProblemLines,
  emptyResumeState,
  markResumeCommitted,
  markResumeFailure,
  markResumeTerminal,
  normalizeResumeState,
  pendingInterruptedTurns,
  resumeProtocolRequests,
  restoreDesktopWithRetry,
  desktopRestoreLaunchSpec,
  splitJsonLines,
  isAppServerProcess,
  isVsCodeCodexAppServerProcess,
  validateThreadMetadataForResume,
  validateThreadForResume,
};
