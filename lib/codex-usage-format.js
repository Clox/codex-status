'use strict';

const { displayWidth } = require('./codex-interrupted-label');
const cellSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const USAGE_BLOCKS = Object.freeze([' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']);
const USAGE_BAR_WIDTH = 5;

function usageBlock(percentage) {
  const normalized = Number.isFinite(percentage)
    ? Math.min(100, Math.max(0, percentage))
    : 0;
  return USAGE_BLOCKS[Math.round(normalized / 12.5)];
}

function usageBar(percentage) {
  const normalized = Number.isFinite(percentage)
    ? Math.min(100, Math.max(0, percentage))
    : 0;
  const eighths = Math.round(normalized / 100 * USAGE_BAR_WIDTH * 8);
  const fullBlocks = Math.floor(eighths / 8);
  const partial = eighths % 8;
  const visible = `${'█'.repeat(fullBlocks)}${partial > 0 ? USAGE_BLOCKS[partial] : ''}`;
  return visible.padEnd(USAGE_BAR_WIDTH, ' ');
}

function scoreLabel(account) {
  if (account?.needsActivation) return 'START';
  if (account?.verifiedExhausted) return '—';
  if (account?.usageQuality === 'unverified') {
    return account?.errorKind === 'auth-401' || account?.errorKind === 'auth-403'
      ? 'AUTH'
      : 'ERROR';
  }
  const marker = account?.usageQuality === 'stale' ? '~' : '';
  if (!Number.isFinite(account?.weeklyResetHours)) return `?${marker}`;
  const score = Math.max(0, Math.round(account.weeklyUrgency * 100));
  return `${score > 999 ? '999+' : score}${marker}`;
}

const weeklyUrgencyLabel = scoreLabel;

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return 'aldrig';
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 1) return 'mindre än 1 minut sedan';
  if (minutes < 60) return `${minutes} min sedan`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${hours} h sedan`
    : `${hours} h ${remainingMinutes} min sedan`;
}

function usageProblemLine(account) {
  if (account?.usageQuality !== 'unverified') return null;
  const label = account.label || 'Okänt konto';
  if (account.errorKind === 'auth-401' || account.errorKind === 'auth-403') {
    const status = account.httpStatus ? `HTTP ${account.httpStatus}` : 'auth-fel';
    return `AUTH ERROR / ACTION REQUIRED: ${label} — ${status}; re-authentication/re-login krävs.`;
  }
  if (account.errorKind === 'missing-credentials' || account.errorKind === 'invalid-credentials') {
    return `AUTH ERROR / ACTION REQUIRED: ${label} — sparad credential saknas eller är ogiltig; re-login krävs.`;
  }
  const age = formatAge(account.usageAgeMs);
  if (account.errorKind === 'worker-stale' || account.errorKind === 'state-read' || account.errorKind === 'worker-fatal') {
    return `UNVERIFIED / ACTION REQUIRED: ${label} — refreshern uppdateras inte; senast verifierad ${age}. Starta om statusfönstret.`;
  }
  if (account.errorKind === 'protocol') {
    return `UNVERIFIED / ACTION REQUIRED: ${label} — serverprotokollet kunde inte tolkas; senast verifierad ${age}.`;
  }
  if (account.errorKind === 'identity-unmatched') {
    return `UNVERIFIED / ACTION REQUIRED: ${label} — kontot kunde inte kopplas till registry-identiteten; kontrollera codex-auth-registret.`;
  }
  if (account.consecutiveFailures >= 3) {
    return `UNVERIFIED / ACTION REQUIRED: ${label} — ${account.consecutiveFailures} refreshfel i följd; senast verifierad ${age}. Kontrollera nätverket eller starta om statusfönstret.`;
  }
  return `UNVERIFIED: ${label} — ingen tillräckligt färsk verifierad serverdata; senast verifierad ${age}.`;
}

function activationProblemLine(account, activationEntry) {
  if (!activationEntry || !['blocked', 'cooldown', 'turn-committed'].includes(activationEntry.phase)) return null;
  const label = account?.label || 'Okänt konto';
  const errorKind = activationEntry.errorKind || 'UNKNOWN_ERROR';
  const diagnostics = Array.isArray(activationEntry.diagnosticFields) && activationEntry.diagnosticFields.length > 0
    ? ` Ändrat state: ${activationEntry.diagnosticFields.join(', ')}.`
    : '';
  if (errorKind === 'ACTIVATION_OBSERVATION_HOLD') return null;
  if (activationEntry.phase === 'blocked' || activationEntry.phase === 'turn-committed') {
    return `5H ACTIVATION ERROR / ACTION REQUIRED: ${label} — ${errorKind}; ingen automatisk retry för detta dormant-fönster.${diagnostics} Använd den manuella diagnostiken.`;
  }
  return `5H ACTIVATION WARNING: ${label} — pre-turn-kontrollen misslyckades (${errorKind}); ingen turn skickades. Automatiken väntar före ny kontroll.`;
}

function activationObservationHoldLine(account, hold) {
  if (!hold) return null;
  const label = account?.label || 'Okänt konto';
  return `WEEKLY OBSERVATION HOLD: ${label} — activation-turns är blockerade; usage och rå weekly-historik fortsätter.`;
}

function activationWorkerProblem(workerHealth) {
  if (workerHealth?.healthy) return null;
  if (!workerHealth?.enabled) {
    return '5H ACTIVATION ERROR / ACTION REQUIRED: background-workerns state saknas eller är inaktiverad.';
  }
  const age = formatAge(workerHealth.ageMs);
  if (workerHealth.fatalErrorKind) {
    return `5H ACTIVATION ERROR / ACTION REQUIRED: background-workern rapporterade ${workerHealth.fatalErrorKind}; heartbeat ${age}.`;
  }
  return `5H ACTIVATION ERROR / ACTION REQUIRED: background-workerns heartbeat uppdateras inte; senast ${age}.`;
}

function fitCell(value, width, align = 'left') {
  let content = '';
  let occupied = 0;
  for (const { segment } of cellSegmenter.segment(String(value))) {
    const cells = displayWidth(segment);
    if (occupied + cells > width) break;
    content += segment;
    occupied += cells;
  }
  const padding = Math.max(0, width - occupied);
  if (align === 'right') return `${' '.repeat(padding)}${content}`;
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return `${' '.repeat(left)}${content}${' '.repeat(padding - left)}`;
  }
  return `${content}${' '.repeat(padding)}`;
}

function tableCell(value, width, align = 'left') {
  return `${fitCell(value, width, align)}│`;
}

module.exports = {
  USAGE_BLOCKS,
  USAGE_BAR_WIDTH,
  activationObservationHoldLine,
  activationProblemLine,
  activationWorkerProblem,
  fitCell,
  tableCell,
  formatAge,
  usageBlock,
  usageBar,
  usageProblemLine,
  scoreLabel,
  weeklyUrgencyLabel,
};
