'use strict';

function accountsFromRegistry(registry) {
  return Array.isArray(registry?.accounts)
    ? registry.accounts
    : Object.values(registry?.accounts || {});
}

function identifiers(account) {
  return [account.email, account.account_name, account.alias]
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(value => value.toLocaleLowerCase('sv-SE'));
}

function resolveExpectedAccount(registry, selector) {
  const wanted = String(selector).toLocaleLowerCase('sv-SE');
  const matches = accountsFromRegistry(registry).filter(account =>
    identifiers(account).some(identifier => identifier === wanted || identifier.includes(wanted) || wanted.includes(identifier))
  );
  if (matches.length !== 1) throw new Error('ACCOUNT_SELECTOR_NOT_UNIQUE');
  const account = matches[0];
  const accountId = account.chatgpt_account_id || account.accountId;
  if (!accountId || !account.account_key) throw new Error('ACCOUNT_STATE_INCOMPLETE');
  return { accountId, accountKey: account.account_key };
}

function verifyActiveAccountState({ registry, globalAuth, expectedAccountId, expectedAccountKey }) {
  const accounts = accountsFromRegistry(registry);
  const target = accounts.find(account => account.account_key === expectedAccountKey);
  const active = accounts
    .find(account => account.account_key === registry?.active_account_key);
  const targetAccountId = target?.chatgpt_account_id || target?.accountId || null;
  const registryAccountId = active?.chatgpt_account_id || active?.accountId || null;
  const globalAccountId = globalAuth?.tokens?.account_id || null;
  const errors = [];
  if (!target) errors.push('registry-target-account-missing');
  else if (targetAccountId !== expectedAccountId) errors.push('registry-target-account-id-mismatch');
  if (registry?.active_account_key !== expectedAccountKey) errors.push('registry-active-key-mismatch');
  if (!active) errors.push('registry-active-account-missing');
  else if (registryAccountId !== expectedAccountId) errors.push('registry-active-account-id-mismatch');
  if (globalAccountId !== expectedAccountId) errors.push('global-auth-account-id-mismatch');
  return { ok: errors.length === 0, errors };
}

module.exports = {
  resolveExpectedAccount,
  verifyActiveAccountState,
};
