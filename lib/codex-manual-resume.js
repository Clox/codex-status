'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RESUME_STATE_VERSION = 1;
const CONTINUATION_PROMPT = 'Du blev avbruten på grund av ett verifierat kvotbyte. Kontrollera det befintliga arbetsläget och fortsätt där du slutade utan att upprepa redan utförda sidoeffekter.';

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
  state.attempts[key] = {
    threadId: candidate.threadId,
    interruptedTurnId: candidate.turnId,
    accountId: candidate.accountId || null,
    targetAccountId: details.targetAccountId || null,
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
  emptyResumeState,
  markResumeCommitted,
  markResumeFailure,
  markResumeTerminal,
  normalizeResumeState,
  pendingInterruptedTurns,
  resumeProtocolRequests,
  splitJsonLines,
  isAppServerProcess,
  isVsCodeCodexAppServerProcess,
  validateThreadMetadataForResume,
  validateThreadForResume,
};
