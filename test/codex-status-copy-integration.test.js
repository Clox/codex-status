'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('C copies the full status from cache without changing AUTO or refreshing quota', () => {
  const result = spawnSync('python3', [path.join(__dirname, 'codex-status-copy.integration.py')],
    { encoding: 'utf8', timeout: 12_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
