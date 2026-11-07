'use strict';

const ACTION_REQUIRED = 'action-required';
const DIAGNOSTIC = 'diagnostic';
const HISTORY = 'history/resolved';

function problem({ classification, source, subject = '', errorKind = '', explanation,
  state = '', timestamp = null, disposition = '' }) {
  if (![ACTION_REQUIRED, DIAGNOSTIC, HISTORY].includes(classification)) {
    throw new Error('INVALID_PROBLEM_CLASSIFICATION');
  }
  return { classification, source, subject, errorKind, explanation, state,
    timestamp: Number.isFinite(Number(timestamp)) && Number(timestamp) > 0 ? Number(timestamp) : null,
    disposition };
}

function formatDiagnostic(entry) {
  const when = entry.timestamp ? new Date(entry.timestamp).toISOString() : 'time unknown';
  return `${entry.source}${entry.subject ? ` · ${entry.subject}` : ''}${entry.errorKind ? ` · ${entry.errorKind}` : ''}` +
    `\n    ${entry.explanation} · ${entry.state || 'state unknown'} · ${when} · ${entry.disposition || 'informational'}`;
}

module.exports = { ACTION_REQUIRED, DIAGNOSTIC, HISTORY, problem, formatDiagnostic };
