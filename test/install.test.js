'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const installer = path.join(__dirname, '..', 'install.sh');

test('existing installation verifies and updates payload without changing private state', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, '.config', 'codex-account-switcher');
  const cacheDir = path.join(home, '.cache', 'codex-account-switcher');
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const privateFiles = [
    [path.join(configDir, 'accounts.conf'), 'ACCOUNT_1=private\n'],
    [path.join(configDir, 'status-preferences.json'), '{"autoMode":"HEADLESS"}\n'],
    [path.join(cacheDir, 'auto-continue.json'), '{"status":"blocked"}\n'],
    [path.join(cacheDir, 'account-switch.json'), '{"phase":"completed"}\n'],
    [path.join(cacheDir, 'manual-resume.json'), '{"attempts":{}}\n'],
    [path.join(binDir, 'codex-usage-resets'), 'legacy-local-file\n'],
  ];
  for (const [file, content] of privateFiles) fs.writeFileSync(file, content);
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined,
    CODEX_STATUS_PREFERENCES: undefined, CODEX_AUTO_CONTINUE_STATE: undefined,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache') };
  const run = mode => spawnSync('bash', [installer, mode], { env, encoding: 'utf8' });

  const before = run('--verify');
  assert.equal(before.status, 1);
  assert.equal(fs.existsSync(path.join(binDir, 'codex-account')), false);
  const updated = run('--update');
  assert.equal(updated.status, 0, updated.stderr);
  const after = run('--verify');
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /0 payload files differ/);
  assert.equal(fs.readFileSync(path.join(binDir, 'codex-status-viewport'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'bin', 'codex-status-viewport'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(binDir, 'codex-account-switch-core'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'bin', 'codex-account-switch-core'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(home, '.local', 'lib', 'codex-status-viewport.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-status-viewport.js'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(home, '.local', 'lib', 'codex-display-snapshots.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-display-snapshots.js'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(home, '.local', 'lib', 'codex-desktop-attempt-history.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-desktop-attempt-history.js'), 'utf8'));
  for (const [file, content] of privateFiles) assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.equal(fs.existsSync(path.join(home, '.local', 'state', 'codex-auth-setup-backups')), false);
});

test('state-preserving update migrates an old DESKTOP preference to HEADLESS', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-mode-update-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, '.config', 'codex-account-switcher');
  const cache = path.join(home, '.cache', 'codex-account-switcher');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(config, 'accounts.conf'), 'ACCOUNT_1=private\n');
  fs.writeFileSync(path.join(config, 'status-preferences.json'),
    JSON.stringify({ version: 2, autoMode: 'DESKTOP' }));
  fs.writeFileSync(path.join(cache, 'auto-continue.json'), JSON.stringify({
    status: 'desktop-preflight', phase: 'semantic-readiness', pending: { fingerprint: 'old' },
    desktopAttemptHistory: [{ outcome: 'fallback-headless', errorKind: 'CHAT_ACTIONS_COUNT_0' }],
  }));
  const resume = path.join(cache, 'manual-resume.json');
  const committed = '{"attempts":{"old":{"strategy":"DESKTOP","status":"SEND_UNCONFIRMED"}}}\n';
  fs.writeFileSync(resume, committed);
  const result = spawnSync('bash', [installer, '--update'], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined,
      CODEX_STATUS_PREFERENCES: undefined, CODEX_AUTO_CONTINUE_STATE: undefined,
      HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      CODEX_SYSTEMCTL_BIN: path.join(__dirname, 'fixtures', 'systemctl-test') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config, 'status-preferences.json'))).autoMode,
    'HEADLESS');
  const state = JSON.parse(fs.readFileSync(path.join(cache, 'auto-continue.json')));
  assert.equal(state.status, 'idle');
  assert.equal(state.pending, null);
  assert.equal(state.desktopAttemptHistory.length, 1);
  assert.equal(fs.readFileSync(resume, 'utf8'), committed);
});
