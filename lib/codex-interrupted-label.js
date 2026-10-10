'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function graphemes(value) {
  return [...segmenter.segment(value)].map(part => part.segment);
}

function cellWidth(cluster) {
  const codePoint = cluster.codePointAt(0);
  if (!codePoint || /^\p{Mark}$/u.test(cluster)) return 0;
  if (/\p{Extended_Pictographic}/u.test(cluster) ||
      (codePoint >= 0x1100 && (codePoint <= 0x115f || codePoint >= 0x2329 && codePoint <= 0x232a ||
      codePoint >= 0x2e80 && codePoint <= 0xa4cf || codePoint >= 0xac00 && codePoint <= 0xd7a3 ||
      codePoint >= 0xf900 && codePoint <= 0xfaff || codePoint >= 0xfe10 && codePoint <= 0xfe6f ||
      codePoint >= 0xff01 && codePoint <= 0xff60 || codePoint >= 0xffe0 && codePoint <= 0xffe6))) return 2;
  return 1;
}

function displayWidth(value) {
  return graphemes(value).reduce((width, cluster) => width + cellWidth(cluster), 0);
}

function truncate(value, width) {
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;
  let result = '';
  for (const cluster of graphemes(value)) {
    if (displayWidth(result) + cellWidth(cluster) > width - 1) break;
    result += cluster;
  }
  return `${result.trimEnd()}…`;
}

function projectFor(metadata) {
  return clean(metadata?.projectName) || clean(metadata?.rootProjectName) || '';
}

function threadNameFor(candidate, metadata) {
  return clean(metadata?.name) || clean(metadata?.title) || clean(candidate?.title) || '';
}

function fallbackPlace(metadata) {
  const origin = clean(metadata?.gitOriginUrl);
  if (origin) {
    const name = origin.replace(/\/?$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '');
    if (name) return name;
  }
  return metadata?.cwd ? clean(path.basename(metadata.cwd)) : '';
}

function candidateLabel(candidate, metadata) {
  const title = threadNameFor(candidate, metadata);
  const project = projectFor(metadata) || fallbackPlace(metadata);
  if (title && project && title.toLocaleLowerCase() !== project.toLocaleLowerCase()) return `${project} · ${title}`;
  return title || project;
}

function longestRootProject(cwd, roots) {
  if (!cwd || !path.isAbsolute(cwd)) return '';
  const normalized = path.resolve(cwd);
  return (roots || []).filter(row => row?.root && path.isAbsolute(row.root) &&
    (normalized === path.resolve(row.root) || normalized.startsWith(`${path.resolve(row.root)}${path.sep}`)))
    .sort((left, right) => right.root.length - left.root.length)[0]?.name || '';
}

function rolloutMetadata(codexHome, threadId, files) {
  for (const [relative, checkpoint] of Object.entries(files || {})) {
    if (checkpoint?.threadId !== threadId || !relative.startsWith(`sessions${path.sep}`)) continue;
    const filename = path.resolve(codexHome, relative);
    if (!filename.startsWith(`${path.resolve(codexHome, 'sessions')}${path.sep}`)) continue;
    try {
      const descriptor = fs.openSync(filename, 'r');
      let first;
      try {
        const buffer = Buffer.alloc(4 * 1024 * 1024);
        const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
        const end = buffer.subarray(0, count).indexOf(0x0a);
        if (end < 0) continue;
        first = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      } finally { fs.closeSync(descriptor); }
      if (first?.type === 'session_meta' && first.payload?.id === threadId) {
        return { cwd: first.payload?.cwd || null };
      }
    } catch {}
  }
  return {};
}

function formatInterruptedCandidate(candidate, accountLabel, metadata, state, columns) {
  const id = `…${String(candidate.threadId || '').slice(-8)}`;
  const suffix = ` | ${id} | ${state}`;
  const maxColumns = Number.isInteger(columns) && columns > 0 ? columns : 120;
  const maxAccount = Math.max(8, maxColumns - displayWidth(suffix) - 5);
  const account = truncate(clean(accountLabel) || 'unknown account', maxAccount);
  const prefix = `${account} | `;
  const available = maxColumns - displayWidth(prefix) - displayWidth(suffix);
  const label = candidateLabel(candidate, metadata);
  if (!label || available < 5) return `${account} | ${id} | ${state}`;
  return `${prefix}${truncate(label, available)}${suffix}`;
}

function readInterruptedMetadata(codexHome, candidates, eventState = {}, run = execFileSync) {
  const ids = [...new Set(candidates.map(candidate => candidate.threadId))]
    .filter(id => /^[0-9a-f-]{20,}$/i.test(id));
  if (!ids.length) return {};
  const metadata = Object.fromEntries(ids.map(id => [id,
    rolloutMetadata(codexHome, id, eventState.files)]));
  if (!fs.existsSync(path.join(codexHome, 'state_5.sqlite'))) return metadata;
  const literals = ids.map(id => `'${id}'`).join(',');
  const query = `SELECT t.id, t.name, t.title, t.cwd, t.git_origin_url AS gitOriginUrl,\n`
    + `p.name AS projectName FROM threads t LEFT JOIN projects p ON p.id=t.project_id\n`
    + `WHERE t.id IN (${literals});`;
  try {
    const output = run('sqlite3', ['-readonly', '-json', path.join(codexHome, 'state_5.sqlite'), query],
      { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const row of JSON.parse(output || '[]')) metadata[row.id] = { ...metadata[row.id], ...row };
    const rootsQuery = 'SELECT r.path AS root, p.name AS name FROM project_roots r JOIN projects p ON p.id=r.project_id;';
    const rootsOutput = run('sqlite3', ['-readonly', '-json', path.join(codexHome, 'state_5.sqlite'), rootsQuery],
      { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    const roots = JSON.parse(rootsOutput || '[]');
    for (const row of Object.values(metadata)) row.rootProjectName = longestRootProject(row.cwd, roots);
  } catch {}
  return metadata;
}

module.exports = { clean, displayWidth, truncate, candidateLabel, formatInterruptedCandidate,
  longestRootProject, readInterruptedMetadata };
