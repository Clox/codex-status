'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { isUsageLimitError } = require('./codex-turn-observer');

// This is only a local availability check. The exclusive App Server thread/read
// remains the authority on whether a continuation can be committed.
async function inspectRollout(filename, threadId, failedTurnId) {
  let first = true;
  let started = false;
  let completed = false;
  let latest = true;
  let quotaFailure = false;
  const input = fs.createReadStream(filename, { encoding: 'utf8' });
  try {
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (first) {
        first = false;
        if (record?.type !== 'session_meta' || record.payload?.id !== threadId) {
          return 'THREAD_ID_MISMATCH';
        }
      }
      if (record?.type !== 'event_msg') continue;
      if (record.payload?.type === 'task_started') {
        if (record.payload.turn_id === failedTurnId) {
          if (started) return 'FAILED_TURN_AMBIGUOUS';
          started = true;
        } else if (started) latest = false;
      }
      if (record.payload?.type === 'task_complete' && record.payload.turn_id === failedTurnId) {
        if (completed) return 'FAILED_TURN_AMBIGUOUS';
        completed = true;
        quotaFailure = isUsageLimitError(record.payload.error);
      }
    }
  } catch {
    return 'ROLLOUT_UNREADABLE';
  } finally {
    input.destroy();
  }
  if (!started || !completed) return 'FAILED_TURN_NOT_FOUND';
  if (!quotaFailure) return 'FAILED_TURN_NOT_QUOTA_INTERRUPTED';
  if (!latest) return 'FAILED_TURN_NOT_LATEST';
  return null;
}

function rolloutPaths(root, threadId) {
  const found = [];
  const pending = [path.join(root, 'sessions')];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) found.push(filename);
    }
  }
  return found;
}

async function headlessStoragePreflight(codexHome, candidates) {
  for (const candidate of candidates) {
    const threadId = candidate?.threadId;
    const failedTurnId = candidate?.turnId;
    if (!threadId || !failedTurnId) {
      return { ok: false, threadId: threadId || null, failedTurnId: failedTurnId || null,
        reason: 'CANDIDATE_IDENTITY_MISSING' };
    }
    let files;
    try { files = rolloutPaths(codexHome, threadId); }
    catch { return { ok: false, threadId, failedTurnId, reason: 'ROLLOUT_SEARCH_FAILED' }; }
    if (files.length !== 1) {
      return { ok: false, threadId, failedTurnId,
        reason: files.length ? 'MULTIPLE_ROLLOUTS' : 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME' };
    }
    const reason = await inspectRollout(files[0], threadId, failedTurnId);
    if (reason) return { ok: false, threadId, failedTurnId, reason };
  }
  return { ok: true };
}

async function acquireHeadlessClientsAfterStoragePreflight(codexHome, candidates, acquireClients) {
  const storage = await headlessStoragePreflight(codexHome, candidates);
  if (!storage.ok) {
    const error = new Error('CANDIDATE_UNAVAILABLE_IN_ACTIVE_CODEX_HOME');
    error.diagnostics = { phase: 'local-storage-preflight', reason: storage.reason,
      threadId: storage.threadId, failedTurnId: storage.failedTurnId };
    throw error;
  }
  return acquireClients();
}

module.exports = { headlessStoragePreflight, acquireHeadlessClientsAfterStoragePreflight };
