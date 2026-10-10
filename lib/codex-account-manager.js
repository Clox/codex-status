'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { accountsFromRegistry, accountId } = require('./codex-auth-repair');
const { resolveActiveAccount } = require('./codex-account-state');
const { processExists } = require('./codex-activation-lock');

function acquireOperationLock(directory) {
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(path.join(directory, 'owner'), `${process.pid}\n`, { mode: 0o600 });
      return () => {
        fs.unlinkSync(path.join(directory, 'owner'));
        fs.rmdirSync(directory);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = Number(fs.readFileSync(path.join(directory, 'owner'), 'utf8').trim()); } catch {}
      // An incomplete lock can belong to a process between mkdir and write.
      if (!Number.isInteger(owner) || owner <= 0 || processExists(owner)) {
        throw new Error('En annan Codex-operation pågår. Försök igen när den är klar.');
      }
      fs.unlinkSync(path.join(directory, 'owner'));
      fs.rmdirSync(directory);
    }
  }
  throw new Error('Kunde inte låsa kontohanteringen.');
}

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
