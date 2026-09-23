'use strict';

const { formatResetValue } = require('./codex-reset-credits');
const { isFiveHourDormant, isWeeklyDormant, resolveUsage } = require('./codex-usage-cache');
const { fitCell, scoreLabel, tableCell, usageBar } = require('./codex-usage-format');

const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_DIM = '\x1b[2m';
const ANSI_ERROR = '\x1b[1;31m';
const ANSI_WARNING = '\x1b[1;33m';
const ANSI_OK = '\x1b[1;32m';

function quotaColor(percentage) {
  const value = Number.isFinite(percentage) ? Math.min(100, Math.max(0, percentage)) : 0;
  const position = value / 100;
  const red = position < 0.5 ? 255 : Math.round(255 - (position - 0.5) * 350);
  const green = position < 0.5 ? Math.round(70 + position * 240) : Math.round(190 + (position - 0.5) * 40);
  const blue = position < 0.5 ? Math.round(60 - position * 80) : Math.round((position - 0.5) * 100);
  return `\x1b[38;2;${Math.max(80, red)};${Math.min(210, green)};${Math.max(20, blue)}m`;
}

function decorateUsage(value, percentage, quality) {
  const characters = Array.from(String(value));
  const percentEnd = characters.indexOf('%');
  if (percentEnd < 0) return value;
  const coloredLength = Math.min(characters.length, percentEnd + 1 + 5);
  const color = quality === 'unverified' ? ANSI_ERROR : quotaColor(percentage);
  return `${color}${characters.slice(0, coloredLength).join('')}${ANSI_RESET}${characters.slice(coloredLength).join('')}`;
}

function styledCell(value, width, style = '', align = 'left') {
  const content = fitCell(value, width, align);
  return `${style}${content}${style ? ANSI_RESET : ''}│`;
}

function usageCell(value, width, percentage, quality) {
  return `${decorateUsage(fitCell(value, width, 'right'), percentage, quality)}│`;
}

function statusLabel(row, pending = false) {
  if (pending) return typeof pending === 'string' ? pending : 'WAIT/';
  if (row.verifiedExhausted) return 'EXHAU';
  if (row.usageQuality === 'unverified') {
    return row.errorKind === 'auth-401' || row.errorKind === 'auth-403' ? 'AUTH' : 'ERROR';
  }
  if (
    row.usageQuality === 'verified' &&
    row.fiveHourRemaining > 0 &&
    row.weeklyRemaining > 0 &&
    !(row.ordinaryUsageAllowedObserved === true && row.ordinaryUsageAllowed !== true)
  ) return 'OK';
  return '';
}

function statusStyle(row, pending = false) {
  if (pending) return ANSI_WARNING;
  const label = statusLabel(row);
  if (label === 'OK') return ANSI_OK;
  return label ? ANSI_ERROR : '';
}

function accountIdentifiers(account) {
  return [account?.email, account?.account_name, account?.alias]
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(value => value.toLocaleLowerCase('sv-SE'));
}

function normalizeAccountRow({
  visible,
  lineIndex,
  rowMatch,
  columns,
  accounts,
  serverUsageByAccountId,
  exhaustionByAccountId = {},
  resetCreditsByAccountId,
  nowMs,
  cacheHealth,
  configuredAccountNumber,
  formatRemaining,
}) {
  const rawLabel = visible.slice(columns.account, columns.plan).trim();
  const shown = rawLabel.toLocaleLowerCase('sv-SE').replace(/\.+$/, '');
  const account = accounts.find(candidate =>
    accountIdentifiers(candidate).some(identifier => identifier === shown || identifier.startsWith(shown))
  ) || null;
  const usage = account?.last_usage || {};
  const fivePercentMatch = visible.slice(columns.fiveHour, columns.weekly).match(/\d+/);
  const weeklyPercentMatch = visible.slice(columns.weekly, columns.activity).match(/\d+/);
  const resolvedUsage = resolveUsage({
    serverEntry: account ? serverUsageByAccountId[account.chatgpt_account_id] : null,
    localPrimaryRemaining: fivePercentMatch ? Number(fivePercentMatch[0]) : null,
    localSecondaryRemaining: weeklyPercentMatch ? Number(weeklyPercentMatch[0]) : null,
    localUsage: usage,
    nowMs,
    cacheHealth,
  });
  const fiveHourRemaining = resolvedUsage.primary.remainingPercent;
  const weeklyRemaining = resolvedUsage.secondary.remainingPercent;
  const fiveHourDormant = account ? isFiveHourDormant(
    serverUsageByAccountId[account.chatgpt_account_id],
    { nowMs, cacheHealth }
  ) : false;
  const weeklyDormant = account ? isWeeklyDormant(
    serverUsageByAccountId[account.chatgpt_account_id],
    { nowMs, cacheHealth }
  ) : false;
  const exhaustion = account ? exhaustionByAccountId[account.chatgpt_account_id] || null : null;

  return {
    accountId: account?.chatgpt_account_id || null,
    sourceRow: rowMatch[1],
    lineIndex,
    label: rawLabel,
    prefix: visible.slice(0, columns.fiveHour),
    resetCredits: account ? resetCreditsByAccountId[account.chatgpt_account_id] || null : null,
    activity: visible.slice(columns.activity).trimEnd(),
    fiveHour: Number.isFinite(fiveHourRemaining)
      ? fiveHourDormant
        ? `${fiveHourRemaining}%${usageBar(fiveHourRemaining)} READY`
        : `${fiveHourRemaining}%${usageBar(fiveHourRemaining)}(${formatRemaining(resolvedUsage.primary.resetsAt)})`
      : '-',
    weekly: Number.isFinite(weeklyRemaining)
      ? weeklyDormant
        ? `${weeklyRemaining}%${usageBar(weeklyRemaining)} READY`
        : `${weeklyRemaining}%${usageBar(weeklyRemaining)}(${formatRemaining(resolvedUsage.secondary.resetsAt)})`
      : '-',
    fiveHourRemaining,
    fiveHourResetAt: resolvedUsage.primary.resetsAt,
    fiveHourDormant,
    weeklyRemaining,
    weeklyResetAt: resolvedUsage.secondary.resetsAt,
    weeklyDormant,
    usageFresh: resolvedUsage.fresh,
    usageQuality: resolvedUsage.quality,
    usageSource: resolvedUsage.source,
    usageAgeMs: resolvedUsage.ageMs,
    usageLastSuccessAtMs: resolvedUsage.lastSuccessAtMs,
    usageLastAttemptAtMs: resolvedUsage.lastAttemptAtMs,
    errorKind: account ? resolvedUsage.errorKind : 'identity-unmatched',
    httpStatus: resolvedUsage.httpStatus,
    consecutiveFailures: resolvedUsage.consecutiveFailures,
    ordinaryUsageAllowed: account ? serverUsageByAccountId[account.chatgpt_account_id]?.ordinaryUsageAllowed ?? null : null,
    ordinaryUsageAllowedObserved: account
      ? serverUsageByAccountId[account.chatgpt_account_id]?.ordinaryUsageAllowedObserved === true
      : false,
    rateLimitReachedType: account ? serverUsageByAccountId[account.chatgpt_account_id]?.rateLimitReachedType ?? null : null,
    rateLimitReachedTypeObserved: account
      ? serverUsageByAccountId[account.chatgpt_account_id]?.rateLimitReachedTypeObserved === true
      : false,
    accountNumber: configuredAccountNumber(account),
    active: /^\s*\*/.test(visible),
    verifiedExhausted: exhaustion?.verified === true,
    exhaustion,
  };
}

function renderAccountTableRow(row, {
  columns,
  accountWidth,
  statusWidth,
  resetWidth,
  fiveHourWidth,
  weeklyWidth,
  scoreWidth,
  nowMs,
  pending = false,
}) {
  const accountLabel = `${row.active ? '*' : ' '}${String(row.rank).padStart(2, '0')} ${row.label}`;
  const rendered = styledCell(accountLabel, accountWidth, row.usageQuality === 'unverified' ? ANSI_ERROR : '') +
    styledCell(statusLabel(row, pending), statusWidth, statusStyle(row, pending)) +
    tableCell(formatResetValue(row.resetCredits, nowMs), resetWidth, 'center') +
    usageCell(row.fiveHour, fiveHourWidth, row.fiveHourRemaining, row.usageQuality) +
    usageCell(row.weekly, weeklyWidth, row.weeklyRemaining, row.usageQuality) +
    styledCell(scoreLabel(row), scoreWidth, row.verifiedExhausted ? ANSI_DIM : '', 'right') +
    fitCell(row.activity, 8);
  return row.active
    ? `${ANSI_BOLD}${rendered.replaceAll(ANSI_RESET, `${ANSI_RESET}${ANSI_BOLD}`)}${ANSI_RESET}`
    : rendered;
}

function recommendationLines(recommendation) {
  const rank = recommendation?.account?.rank;
  const label = recommendation?.account?.label || 'current account';
  if (!recommendation) {
    return [
      '\x1b[1mRECOMMENDATION:\x1b[0m Waiting for verified server usage',
    ];
  }
  if (recommendation.action === 'none') {
    return ['\x1b[1mRECOMMENDATION:\x1b[0m Waiting for verified server usage'];
  }
  if (recommendation.reason === 'needs-activation') {
    return recommendation.action === 'switch'
      ? [
          `\x1b[1mRECOMMENDATION:\x1b[0m Activate ${label} to start its weekly cycle`,
          `Press [${rank}] to switch`,
        ]
      : [
          `\x1b[1mRECOMMENDATION:\x1b[0m Use ${label} once to start its weekly cycle`,
        ];
  }
  return recommendation.action === 'switch'
    ? [
        `\x1b[1mRECOMMENDATION:\x1b[0m Switch to ${label}`,
        `Press [${rank}] to switch`,
      ]
    : [
        `\x1b[1mRECOMMENDATION:\x1b[0m Stay on ${label}`,
      ];
}

module.exports = {
  accountIdentifiers,
  normalizeAccountRow,
  recommendationLines,
  renderAccountTableRow,
  statusLabel,
};
