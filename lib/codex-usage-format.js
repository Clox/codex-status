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
  if (!Number.isFinite(account?.weeklyResetHours)) return '?';
  return account.weeklyUrgency.toFixed(2);
}

module.exports = {
  USAGE_BLOCKS,
  usageBlock,
  weeklyUrgencyLabel,
};
