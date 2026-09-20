'use strict';

const REPAIRABLE_ERROR_KINDS = new Set([
  'auth-401',
  'auth-403',
  'missing-credentials',
  'invalid-credentials',
]);

function accountsFromRegistry(registry) {
  return Array.isArray(registry?.accounts)
    ? registry.accounts
    : Object.values(registry?.accounts || {});
}

function accountId(account) {
  return account?.chatgpt_account_id || account?.accountId || null;
}

function repairableAccounts(registry, usageCache) {
  return accountsFromRegistry(registry).filter(account => {
    const id = accountId(account);
    const errorKind = usageCache?.accounts?.[id]?.refresh?.errorKind || null;
    return id && REPAIRABLE_ERROR_KINDS.has(errorKind);
  });
}

function validateStagedIdentity({ target, stagedRegistry, stagedAuth }) {
  const targetId = accountId(target);
  const stagedAccounts = accountsFromRegistry(stagedRegistry);
  const stagedActive = stagedAccounts.find(account => account.account_key === stagedRegistry?.active_account_key);
  const errors = [];

  if (!targetId || !target?.account_key) errors.push('target-incomplete');
  if (stagedAccounts.length !== 1) errors.push('staged-account-count');
  if (stagedRegistry?.active_account_key !== target?.account_key) errors.push('account-key-mismatch');
  if (accountId(stagedActive) !== targetId) errors.push('registry-account-id-mismatch');
  if (stagedAuth?.tokens?.account_id !== targetId) errors.push('auth-account-id-mismatch');
  if (
    target?.email && stagedActive?.email &&
    target.email.toLocaleLowerCase('sv-SE') !== stagedActive.email.toLocaleLowerCase('sv-SE')
  ) {
    errors.push('email-mismatch');
  }

  return { ok: errors.length === 0, errors };
}

function validateInactivePrecondition({ target, registry, globalAuth }) {
  const active = accountsFromRegistry(registry)
    .find(account => account.account_key === registry?.active_account_key);
  const errors = [];
  if (target?.account_key === registry?.active_account_key) errors.push('target-is-active');
  if (!active) errors.push('active-account-missing');
  if (accountId(active) !== globalAuth?.tokens?.account_id) errors.push('active-global-mismatch');
  return { ok: errors.length === 0, errors, active };
}

function validatePostImport({
  target,
  beforeRegistry,
  beforeGlobalAuth,
  afterRegistry,
  afterGlobalAuth,
  afterTargetAuth,
}) {
  const beforeKeys = accountsFromRegistry(beforeRegistry).map(account => account.account_key).sort();
  const afterKeys = accountsFromRegistry(afterRegistry).map(account => account.account_key).sort();
  const afterTarget = accountsFromRegistry(afterRegistry)
    .find(account => account.account_key === target?.account_key);
  const errors = [];

  if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) errors.push('account-set-changed');
  if (afterRegistry?.active_account_key !== beforeRegistry?.active_account_key) errors.push('active-key-changed');
  if (afterGlobalAuth?.tokens?.account_id !== beforeGlobalAuth?.tokens?.account_id) errors.push('global-auth-changed');
  if (accountId(afterTarget) !== accountId(target)) errors.push('target-registry-mismatch');
  if (afterTargetAuth?.tokens?.account_id !== accountId(target)) errors.push('target-auth-mismatch');

  return { ok: errors.length === 0, errors };
}

module.exports = {
  REPAIRABLE_ERROR_KINDS,
  accountId,
  accountsFromRegistry,
  repairableAccounts,
  validateInactivePrecondition,
  validatePostImport,
  validateStagedIdentity,
};
