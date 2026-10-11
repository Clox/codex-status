'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('F stops all PTY writes while collectors continue and resumes without quota transition', () => {
  const result = spawnSync('python3',
    [path.join(__dirname, 'codex-display-freeze.integration.py')],
    { encoding: 'utf8', timeout: 12_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
