'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function install() {
  if (process.env.CODEX_STATUS_TEST_ROOT) throw new Error('TEST_ROOT_ALREADY_SET');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-suite-'));
  for (const [name, relative] of Object.entries({
    HOME: '', CODEX_HOME: 'codex-home', XDG_CONFIG_HOME: 'config',
    XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data',
  })) {
    process.env[name] = path.join(root, relative);
  }
  process.env.CODEX_STATUS_TEST_ROOT = root;
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
}

install();
