'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function decodeSimpleShellValue(value) {
  if (/[$'"`]/.test(value)) throw new Error('UNSUPPORTED_LOCAL_CONFIG_VALUE');
  return value.replace(/\\(.)/g, '$1');
}

function configuredValue(configFile, name) {
  const line = fs.readFileSync(configFile, 'utf8')
    .split(/\r?\n/)
    .find(candidate => candidate.startsWith(`${name}=`));
  if (!line) return null;
  return decodeSimpleShellValue(line.slice(line.indexOf('=') + 1));
}

function configuredSelector(configFile, number) {
  const selector = configuredValue(configFile, `ACCOUNT_${number}`);
  if (!selector) throw new Error('ACCOUNT_SELECTOR_MISSING');
  return selector;
}

function accountIdentifiers(account) {
  return [account.email, account.account_name, account.alias]
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(value => value.toLocaleLowerCase('sv-SE'));
}

function findAccount(accounts, selector) {
  const wanted = selector.toLocaleLowerCase('sv-SE');
  const matches = accounts.filter(account => accountIdentifiers(account)
    .some(identifier => identifier.includes(wanted) || wanted.includes(identifier)));
  if (matches.length !== 1) throw new Error('ACCOUNT_SELECTOR_AMBIGUOUS');
  return matches[0];
}

function loadCredential(codexHome, accountId) {
  const directory = path.join(codexHome, 'accounts');
  for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.auth.json'))) {
    const auth = readJson(path.join(directory, filename));
    if (auth?.tokens?.account_id === accountId && auth?.tokens?.access_token) {
      return auth.tokens.access_token;
    }
  }
  throw new Error('ACCOUNT_CREDENTIAL_MISSING');
}

module.exports = {
  configuredSelector,
  configuredValue,
  findAccount,
  loadCredential,
  readJson,
};
