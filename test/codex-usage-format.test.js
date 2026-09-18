'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  USAGE_BLOCKS,
  usageBlock,
} = require('../lib/codex-usage-format');

test('maps the complete 0-100% scale to eighth-block glyphs', () => {
  const percentages = [0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  assert.deepEqual(percentages.map(usageBlock), USAGE_BLOCKS);
});

test('rounds intermediate percentages to the nearest block level', () => {
  assert.equal(usageBlock(6), ' ');
  assert.equal(usageBlock(7), '▁');
  assert.equal(usageBlock(73), '▆');
  assert.equal(usageBlock(94), '█');
});

test('clamps out-of-range values and handles missing data', () => {
  assert.equal(usageBlock(-20), ' ');
  assert.equal(usageBlock(140), '█');
  assert.equal(usageBlock(Number.NaN), ' ');
});
