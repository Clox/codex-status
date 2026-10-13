'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
const { isUsageLimitError } = require('./codex-turn-observer');

// The exclusive App Server thread/read remains the commit authority.
function currentRolloutPath(root, threadId) {
  const database = path.join(root, 'state_5.sqlite');
  if (!fs.existsSync(database)) return null;
  let rolloutPath;
  try {
    const connection = new DatabaseSync(database, { readOnly: true });
    try { rolloutPath = connection.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId)?.rollout_path; }
    finally { connection.close(); }
  } catch { throw new Error('ROLLOUT_METADATA_UNVERIFIED'); }
  if (!rolloutPath || !path.isAbsolute(rolloutPath)) throw new Error('ROLLOUT_METADATA_UNVERIFIED');
  const filename = path.resolve(rolloutPath);
  const sessions = path.resolve(root, 'sessions');
  if (!filename.startsWith(`${sessions}${path.sep}`)) throw new Error('ROLLOUT_METADATA_UNVERIFIED');
  return filename;
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
      else if (entry.isFile() && (entry.name.endsWith(`-${threadId}.jsonl`) ||
        (entry.name.includes(`-${threadId}_`) && entry.name.endsWith('.jsonl')))) found.push(filename);
    }
  }
  return found;
}

async function inspectSegment(filename, threadId) {
  const events = [];
  let first = true;
  let firstTime = null;
  let lastTime = null;
  const input = fs.createReadStream(filename, { encoding: 'utf8' });
  try {
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (first) {
        first = false;
        if (record?.type !== 'session_meta' || record.payload?.id !== threadId) {
          return { reason: 'THREAD_ID_MISMATCH' };
        }
      }
      const timestamp = record?.timestamp == null ? null : Date.parse(record.timestamp);
      if (timestamp != null && !Number.isFinite(timestamp)) return { reason: 'ROLLOUT_ORDER_UNVERIFIED' };
      if (timestamp != null) {
        if (lastTime != null && timestamp < lastTime) return { reason: 'ROLLOUT_ORDER_UNVERIFIED' };
        if (firstTime == null) firstTime = timestamp;
        lastTime = timestamp;
      }
      if (record?.type !== 'event_msg') continue;
      const kind = record.payload?.type;
      if (!['task_started', 'task_complete', 'turn_aborted'].includes(kind)) continue;
      if (!record.payload?.turn_id) return { reason: 'ROLLOUT_IDENTITY_UNVERIFIED' };
      events.push({ kind, turnId: record.payload.turn_id, error: record.payload.error,
        timestamp });
    }
  } catch {
    return { reason: 'ROLLOUT_UNREADABLE' };
  } finally {
    input.destroy();
  }
  if (first) return { reason: 'ROLLOUT_IDENTITY_UNVERIFIED' };
  return { filename, firstTime, lastTime, events };
}

async function inspectHistory(files, current, threadId, failedTurnId) {
  const segments = [];
  for (const file of files) {
    const segment = await inspectSegment(file, threadId);
    if (segment.reason) return segment.reason;
    segments.push(segment);
  }
  if (segments.length > 1) {
    if (segments.some(segment => segment.firstTime == null || segment.lastTime == null ||
      segment.events.some(event => event.timestamp == null))) {
      return 'ROLLOUT_ORDER_UNVERIFIED';
    }
    segments.sort((a, b) => a.firstTime - b.firstTime);
    for (let i = 1; i < segments.length; i++) {
      if (segments[i - 1].lastTime >= segments[i].firstTime) return 'ROLLOUT_ORDER_UNVERIFIED';
    }
  }
  if (current && segments.at(-1).filename !== current) return 'ROLLOUT_METADATA_UNVERIFIED';

  const turns = new Map();
  let latest = null;
  for (const segment of segments) {
    for (const event of segment.events) {
      const turn = turns.get(event.turnId);
      if (event.kind === 'task_started') {
        if (turn) return 'FAILED_TURN_AMBIGUOUS';
        turns.set(event.turnId, { completed: false, aborted: false });
        latest = event.turnId;
      } else {
        if (!turn || turn.completed || turn.aborted) {
          return event.turnId === failedTurnId && turn ? 'FAILED_TURN_AMBIGUOUS' :
            'ROLLOUT_IDENTITY_UNVERIFIED';
        }
        if (latest !== event.turnId) return 'ROLLOUT_ORDER_UNVERIFIED';
        turn.completed = event.kind === 'task_complete';
        turn.aborted = event.kind === 'turn_aborted';
        turn.quotaFailure = isUsageLimitError(event.error);
      }
    }
  }
  if ([...turns.values()].some(turn => !turn.completed && !turn.aborted)) {
    return 'ROLLOUT_IDENTITY_UNVERIFIED';
  }
  const failed = turns.get(failedTurnId);
  if (!failed) return 'FAILED_TURN_NOT_FOUND';
  if (!failed.completed || !failed.quotaFailure) return 'FAILED_TURN_NOT_QUOTA_INTERRUPTED';
  if (latest !== failedTurnId) return 'FAILED_TURN_NOT_LATEST';
  return null;
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
    let current;
    try {
      current = currentRolloutPath(codexHome, threadId);
      files = rolloutPaths(codexHome, threadId);
    } catch (error) {
      return { ok: false, threadId, failedTurnId,
        reason: error.message === 'ROLLOUT_METADATA_UNVERIFIED' ? error.message : 'ROLLOUT_SEARCH_FAILED' };
    }
    if (!files.length) {
      return { ok: false, threadId, failedTurnId, reason: 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME' };
    }
    if (current && !files.includes(current)) {
      return { ok: false, threadId, failedTurnId, reason: 'ROLLOUT_METADATA_UNVERIFIED' };
    }
    const reason = await inspectHistory(files, current, threadId, failedTurnId);
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
