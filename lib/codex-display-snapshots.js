'use strict';

const path = require('node:path');

const MAX_UNREFERENCED_SNAPSHOTS = 128;
const DISPLAY_FIELDS = ['threadName', 'threadTitle', 'projectName', 'cwd', 'repoName'];

function clean(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, 160) : null;
}

function snapshotFields(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const cwd = clean(metadata.cwd);
  const origin = clean(metadata.gitOriginUrl);
  const repoName = clean(metadata.repoName) || (origin
    ? clean(origin.replace(/\/?$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '')) : null);
  return {
    threadName: clean(metadata.threadName) || clean(metadata.name),
    threadTitle: clean(metadata.threadTitle) || clean(metadata.title),
    projectName: clean(metadata.projectName) || clean(metadata.rootProjectName),
    cwd: cwd && path.isAbsolute(cwd) ? cwd : null,
    repoName,
  };
}

function updateDisplaySnapshot(state, threadId, metadata, source, capturedAt = Date.now()) {
  if (typeof threadId !== 'string' || !threadId ||
      !metadata || typeof metadata !== 'object' ||
      !['thread-db', 'rollout-session-meta', 'observer-title'].includes(source)) return state;
  const incoming = snapshotFields(metadata);
  const previous = state.displaySnapshots?.[threadId] || null;
  const next = previous ? { ...previous, fieldSources: { ...(previous.fieldSources || {}) },
    fieldQuality: { ...(previous.fieldQuality || {}) } }
    : { threadId, fieldSources: {}, fieldQuality: {} };
  let changed = false;
  for (const [field, value] of Object.entries(incoming)) {
    if (!value) continue;
    const current = clean(next[field]);
    const currentSource = next.fieldSources[field] || null;
    const incomingRank = source === 'thread-db' ? 3 : source === 'observer-title' ? 2 : 1;
    const currentRank = currentSource === 'thread-db' ? 3
      : currentSource === 'observer-title' ? 2 : currentSource ? 1 : 0;
    const quality = field === 'projectName' && !clean(metadata.projectName) ? 1 : 2;
    const currentQuality = next.fieldQuality[field] || 1;
    if (current && incomingRank < currentRank) continue;
    if (current && incomingRank === currentRank && quality < currentQuality) continue;
    if (current && incomingRank === currentRank && ['cwd', 'repoName'].includes(field)) continue;
    if (current === value) {
      if (incomingRank > currentRank || (incomingRank === currentRank && quality > currentQuality)) {
        next.fieldSources[field] = source;
        next.fieldQuality[field] = quality;
        changed = true;
      }
      continue;
    }
    // A DB name/title/project can improve a rollout-only cwd fallback.
    // Empty observations never erase earlier verified values.
    next[field] = value;
    next.fieldSources[field] = source;
    next.fieldQuality[field] = quality;
    changed = true;
  }
  if (!changed) return state;
  next.capturedAt = capturedAt;
  next.source = source;
  return { ...state, displaySnapshots: { ...(state.displaySnapshots || {}), [threadId]: next } };
}

function referencedThreadIds(state, resumeState) {
  const ids = new Set();
  for (const collection of [state.activeTurns, state.interruptedTurns]) {
    for (const entry of Object.values(collection || {})) if (entry?.threadId) ids.add(entry.threadId);
  }
  for (const entry of state.terminalTurns || []) if (entry?.threadId) ids.add(entry.threadId);
  for (const entry of Object.values(resumeState?.retiredCandidates || {})) {
    if (entry?.threadId) ids.add(entry.threadId);
  }
  for (const entry of resumeState?.retirementHistory || []) if (entry?.threadId) ids.add(entry.threadId);
  for (const [key] of Object.entries(resumeState?.attempts || {})) {
    try { const [threadId] = JSON.parse(key); if (threadId) ids.add(threadId); } catch {}
  }
  return ids;
}

function pruneDisplaySnapshots(state, resumeState, maxUnreferenced = MAX_UNREFERENCED_SNAPSHOTS) {
  const referenced = referencedThreadIds(state, resumeState);
  const snapshots = state.displaySnapshots || {};
  const unreferenced = Object.entries(snapshots).filter(([id]) => !referenced.has(id))
    .sort((left, right) => Number(right[1]?.capturedAt || 0) - Number(left[1]?.capturedAt || 0));
  const keep = new Set(unreferenced.slice(0, maxUnreferenced).map(([id]) => id));
  return { ...state, displaySnapshots: Object.fromEntries(Object.entries(snapshots)
    .filter(([id]) => referenced.has(id) || keep.has(id))) };
}

function displayMetadata(snapshot, live = {}) {
  const fields = snapshotFields(live);
  const result = { ...fields };
  for (const field of DISPLAY_FIELDS) {
    if (snapshot?.[field]) result[field] = snapshot[field];
  }
  return result;
}

module.exports = { clean, snapshotFields, updateDisplaySnapshot, pruneDisplaySnapshots,
  referencedThreadIds, displayMetadata };
