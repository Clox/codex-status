'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { displaySwitchState, runAccountSwitch } = require('../lib/codex-account-switch-core');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-core-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex');
  const registryPath = path.join(codexHome, 'accounts', 'registry.json');
  const authPath = path.join(codexHome, 'auth.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const accounts = [
    { account_key: 'key-a', chatgpt_account_id: 'account-a', email: 'a@example.test' },
    { account_key: 'key-b', chatgpt_account_id: 'account-b', email: 'b@example.test' },
  ];
  const setActive = key => {
    fs.writeFileSync(registryPath, JSON.stringify({ active_account_key: key, accounts }));
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { account_id: key === 'key-a' ? 'account-a' : 'account-b' } }));
  };
  setActive('key-a');
  return { root, codexHome, registryPath, authPath, setActive,
    statePath: path.join(root, 'runtime', 'account-switch.json') };
}

test('shared core verifies source/target, selector and postcondition; publishes the same phases', t => {
  const f = fixture(t);
  const phases = [];
  const run = (command, args) => {
    assert.equal(command, 'fake-codex-auth');
    assert.deepEqual(args, ['switch', 'b@example.test']);
    phases.push(JSON.parse(fs.readFileSync(f.statePath)).phase);
    f.setActive('key-b');
    return { status: 0 };
  };
  const result = runAccountSwitch({ codexHome: f.codexHome, targetAccountKey: 'key-b',
    authBin: 'fake-codex-auth', statePath: f.statePath, source: 'auto', run });
  assert.deepEqual(phases, ['switching']);
  assert.deepEqual(result.source, { accountId: 'account-a', accountKey: 'key-a' });
  assert.deepEqual(result.target, { accountId: 'account-b', accountKey: 'key-b' });
  const state = JSON.parse(fs.readFileSync(f.statePath));
  assert.equal(state.phase, 'completed');
  assert.equal(state.sourceAccountId, 'account-a');
  assert.equal(state.targetAccountId, 'account-b');
  assert.equal(displaySwitchState(state, Date.now())?.phase, 'completed');
  assert.equal(fs.existsSync(path.join(f.root, 'runtime', 'exclusive-codex-operation.lock')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'runtime')), ['account-switch.json']);
});

test('manual CLI and AUTO module call the same core without Desktop, drafts or commit side effects', t => {
  const f = fixture(t);
  const auth = path.join(f.root, 'fake-auth');
  fs.writeFileSync(auth, `#!/bin/sh\nnode -e 'const fs=require("fs");const p=process.argv.slice(1);const r=JSON.parse(fs.readFileSync(p[0]));r.active_account_key="key-b";fs.writeFileSync(p[0],JSON.stringify(r));fs.writeFileSync(p[1],JSON.stringify({tokens:{account_id:"account-b"}}))' '${f.registryPath}' '${f.authPath}'\n`);
  fs.chmodSync(auth, 0o755);
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'codex-account-switch-core'),
    f.codexHome, 'key-b'], { encoding: 'utf8', env: { ...process.env,
      CODEX_AUTH_BIN: auth, CODEX_ACCOUNT_SWITCH_STATE: f.statePath } });
  assert.equal(cli.status, 0, cli.stderr);
  const state = JSON.parse(fs.readFileSync(f.statePath));
  assert.equal(state.source, 'manual');
  assert.equal(state.phase, 'completed');
  assert.equal(fs.existsSync(path.join(f.root, 'runtime', 'exclusive-codex-operation.lock')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'runtime', 'manual-resume.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'runtime', 'continuation-drafts.json')), false);
});

test('core fails closed on invalid source or auth postcondition and records failure', t => {
  const f = fixture(t);
  fs.writeFileSync(f.authPath, JSON.stringify({ tokens: { account_id: 'wrong' } }));
  assert.throws(() => runAccountSwitch({ codexHome: f.codexHome, targetAccountKey: 'key-b',
    statePath: f.statePath, run: () => { throw new Error('unexpected switch'); } }),
  /ACTIVE_ACCOUNT_STATE_MISMATCH/);
  assert.equal(JSON.parse(fs.readFileSync(f.statePath)).phase, 'failed');
  f.setActive('key-a');
  assert.throws(() => runAccountSwitch({ codexHome: f.codexHome, targetAccountKey: 'key-b',
    statePath: f.statePath, run: () => ({ status: 0 }) }), /ACCOUNT_SWITCH_POSTCONDITION_FAILED/);
  assert.equal(JSON.parse(fs.readFileSync(f.statePath)).phase, 'failed');
});
