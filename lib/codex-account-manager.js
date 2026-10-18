'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { accountsFromRegistry, accountId } = require('./codex-auth-repair');
const { resolveActiveAccount } = require('./codex-account-state');
const { acquireOperationLock } = require('./codex-operation-lock');

function validateRemoval(registry, globalAuth, targetKey) {
  const active = resolveActiveAccount(registry, globalAuth);
  const matches = accountsFromRegistry(registry).filter(a => a.account_key === targetKey);
  if (matches.length !== 1 || !accountId(matches[0])) throw new Error('Kontot finns inte längre. Öppna kontomenyn igen.');
  if (active.accountKey === targetKey || active.accountId === accountId(matches[0])) {
    throw new Error('Det aktiva kontot kan inte tas bort. Byt till ett annat konto först.');
  }
  return matches[0];
}

function validateAddition(registry, stagedRegistry, stagedAuth) {
  const staged = accountsFromRegistry(stagedRegistry);
  if (staged.length !== 1 || !staged[0].account_key || !accountId(staged[0]) ||
      stagedRegistry.active_account_key !== staged[0].account_key ||
      stagedAuth?.tokens?.account_id !== accountId(staged[0])) {
    throw new Error('Inloggningens kontoidentitet kunde inte verifieras. Inget konto lades till.');
  }
  const target = staged[0];
  if (accountsFromRegistry(registry).some(a => a.account_key === target.account_key || accountId(a) === accountId(target))) {
    throw new Error('Kontot finns redan. Använd auth-reparation om inloggningen behöver förnyas.');
  }
  return target;
}

function verifyMutation(before, after, targetKey, operation, globalBefore, globalAfter) {
  const expected = accountsFromRegistry(before).map(a => a.account_key);
  if (operation === 'add') expected.push(targetKey);
  const keys = operation === 'remove' ? expected.filter(key => key !== targetKey) : expected;
  const actual = accountsFromRegistry(after).map(a => a.account_key);
  if (JSON.stringify(keys.sort()) !== JSON.stringify(actual.sort()) ||
      before.active_account_key !== after.active_account_key || !globalBefore.equals(globalAfter)) {
    throw new Error('Efterkontrollen misslyckades. Kontoläget är osäkert; kontrollera codex-auth list innan du försöker igen.');
  }
}

function safeLabel(account) {
  return String(account.alias || account.email || account.account_name || account.account_key)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

module.exports = { acquireOperationLock, validateAddition, validateRemoval, verifyMutation, safeLabel };
