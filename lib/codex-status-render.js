'use strict';

const { formatResetValue } = require('./codex-reset-credits');
const { isFiveHourDormant, isWeeklyDormant, resolveUsage } = require('./codex-usage-cache');
const { tableCell, usageBlock, weeklyUrgencyLabel } = require('./codex-usage-format');

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
        ? `${fiveHourRemaining}% ${usageBlock(fiveHourRemaining)} READY`
        : `${fiveHourRemaining}% ${usageBlock(fiveHourRemaining)} (${formatRemaining(resolvedUsage.primary.resetsAt)})`
      : '-',
    weekly: Number.isFinite(weeklyRemaining)
      ? weeklyDormant
        ? `${weeklyRemaining}% ${usageBlock(weeklyRemaining)} READY`
        : `${weeklyRemaining}% ${usageBlock(weeklyRemaining)} (${formatRemaining(resolvedUsage.secondary.resetsAt)})`
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
    accountNumber: configuredAccountNumber(account),
    active: /^\s*\*/.test(visible),
    verifiedExhausted: exhaustion?.verified === true,
    exhaustion,
  };
}

function renderAccountTableRow(row, {
  columns,
  accountWidth,
  resetWidth,
  fiveHourWidth,
  weeklyWidth,
  weeklyUrgencyWidth,
  nowMs,
}) {
  const markerAndRank = `${row.active ? '*' : ' '} ${String(row.rank).padStart(2, '0')}`;
  const rankedPrefix = row.prefix.replace(/^\s*\*?\s*0?\d+/, markerAndRank);
  return rankedPrefix.slice(0, columns.account) +
    tableCell(row.label, accountWidth) +
    tableCell(formatResetValue(row.resetCredits, nowMs), resetWidth) +
    tableCell(row.fiveHour, fiveHourWidth) +
    tableCell(row.weekly, weeklyWidth) +
    tableCell(weeklyUrgencyLabel(row), weeklyUrgencyWidth) +
    row.activity +
    (row.active ? '  ACTIVE' : '');
}

function colorAccountTableRow(rendered, color) {
  const coloredSeparators = rendered.replaceAll('│', `\x1b[0m│${color}`);
  return `${color}${coloredSeparators}\x1b[0m`;
}

function recommendationLines(recommendation) {
  const rank = recommendation?.account?.rank;
  const label = recommendation?.account?.label || 'current account';
  if (!recommendation) {
    return [
      '\x1b[1mRECOMMENDATION PAUSED:\x1b[0m',
      'Insufficient normalized account data',
    ];
  }
  if (recommendation.action === 'none') {
    return recommendation.reason === 'active-unverified'
      ? [
          '\x1b[1mRECOMMENDATION PAUSED:\x1b[0m',
          `Active account ${label} is UNVERIFIED`,
          'No safe account recommendation is available',
        ]
      : [
          '\x1b[1mRECOMMENDATION PAUSED:\x1b[0m',
          'Waiting for verified server usage',
        ];
  }
  if (recommendation.reason === 'needs-activation') {
    return recommendation.action === 'switch'
      ? [
          '\x1b[1mRECOMMENDATION:\x1b[0m',
          `Activate ${label}`,
          'Use it once to start its weekly cycle',
          `Press [${rank}] to switch`,
        ]
      : [
          '\x1b[1mRECOMMENDATION:\x1b[0m',
          `Use ${label} once`,
          'Start its weekly cycle',
        ];
  }
  return recommendation.action === 'switch'
    ? [
        '\x1b[1mRECOMMENDATION:\x1b[0m',
        `Switch to ${label}`,
        `Press [${rank}] to switch`,
      ]
    : [
        '\x1b[1mRECOMMENDATION:\x1b[0m',
        `Stay on ${label}`,
      ];
}

module.exports = {
  accountIdentifiers,
  colorAccountTableRow,
  normalizeAccountRow,
  recommendationLines,
  renderAccountTableRow,
};
