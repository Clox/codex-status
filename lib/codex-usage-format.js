'use strict';

const USAGE_BLOCKS = Object.freeze([' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']);

function usageBlock(percentage) {
  const normalized = Number.isFinite(percentage)
    ? Math.min(100, Math.max(0, percentage))
    : 0;
  return USAGE_BLOCKS[Math.round(normalized / 12.5)];
}

function weeklyUrgencyLabel(account) {
  if (account?.needsActivation) return 'START';
  if (account?.usageQuality === 'unverified') {
    return account?.errorKind === 'auth-401' || account?.errorKind === 'auth-403'
      ? 'AUTH'
      : 'ERROR';
  }
  const marker = account?.usageQuality === 'stale' ? '~' : '';
  if (!Number.isFinite(account?.weeklyResetHours)) return `?${marker}`;
  return `${account.weeklyUrgency.toFixed(2)}${marker}`;
}

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
  if (errorKind === 'ACTIVATION_OBSERVATION_HOLD') return null;
  if (activationEntry.phase === 'blocked' || activationEntry.phase === 'turn-committed') {
    return `5H ACTIVATION ERROR / ACTION REQUIRED: ${label} — ${errorKind}; ingen automatisk retry för detta dormant-fönster. Använd den manuella diagnostiken.`;
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

function tableCell(value, width) {
  const contentWidth = Math.max(0, width - 1);
  const content = String(value).slice(0, contentWidth).padEnd(contentWidth, ' ');
  return `${content}│ `;
}

module.exports = {
  USAGE_BLOCKS,
  activationObservationHoldLine,
  activationProblemLine,
  activationWorkerProblem,
  tableCell,
  formatAge,
  usageBlock,
  usageProblemLine,
  weeklyUrgencyLabel,
};
