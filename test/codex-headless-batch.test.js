'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runHeadlessBatch } = require('../lib/codex-headless-batch');

test('two terminal candidates replan within one lease, change target and restore once at end', async () => {
  const queue = ['first', 'second'];
  const events = ['lease-acquired'];
  let target = 'source';
  let restored = 0;
  try {
    const result = await runHeadlessBatch({
      nextPlan: async () => queue.length ? { action: 'resume',
        target: { accountId: queue[0] === 'first' ? 'account-a' : 'account-b' },
        candidates: [...queue] } : { action: 'idle', reason: 'no-candidates' },
      switchTarget: async plan => {
        if (target === plan.target.accountId) return false;
        events.push(`switch:${target}->${plan.target.accountId}`);
        target = plan.target.accountId;
        return true;
      },
      runCandidate: async (candidate, plan) => {
        events.push(`commit:${candidate}:${plan.target.accountId}`);
        queue.shift();
        events.push(`terminal:${candidate}`);
      },
      onNoWork: async () => events.push('batch-done'),
    });
    assert.equal(result.completed, 2);
  } finally { restored++; events.push('desktop-restored'); }
  assert.equal(restored, 1);
  assert.deepEqual(events, ['lease-acquired', 'switch:source->account-a',
    'commit:first:account-a', 'terminal:first', 'switch:account-a->account-b',
    'commit:second:account-b', 'terminal:second', 'batch-done', 'desktop-restored']);
});

test('precommit replan does not repeat a committed candidate; unsafe failure restores the lease', async () => {
  const queue = ['first', 'second'];
  const committed = new Set();
  let precommitReplans = 0;
  let restored = 0;
  await assert.rejects(async () => {
    try {
      await runHeadlessBatch({
        nextPlan: async () => ({ action: 'resume', target: { accountId: 'target' },
          candidates: [...queue] }),
        switchTarget: async () => false,
        runCandidate: async candidate => {
          if (candidate === 'first' && precommitReplans++ === 0) return 'replan';
          assert.equal(committed.has(candidate), false);
          committed.add(candidate);
          queue.shift();
          if (candidate === 'second') throw new Error('POSTCOMMIT_UNSAFE');
        },
        onNoWork: async () => {},
      });
    } finally { restored++; }
  }, /POSTCOMMIT_UNSAFE/);
  assert.equal(restored, 1);
  assert.deepEqual([...committed], ['first', 'second']);
  assert.equal(precommitReplans, 2);
});

test('candidate becoming locally unavailable before commit is repartitioned without stopping the next candidate', async () => {
  let candidates = ['stale', 'healthy'];
  const ran = [];
  const result = await runHeadlessBatch({
    nextPlan: async () => candidates.length
      ? { action: 'resume', target: { accountId: 'target' }, candidates }
      : { action: 'waiting', reason: 'unavailable-candidates' },
    switchTarget: async () => false,
    runCandidate: async candidate => {
      if (candidate === 'stale') {
        candidates = ['healthy'];
        return 'replan';
      }
      ran.push(candidate);
      candidates = [];
    },
    onNoWork: async () => {},
  });
  assert.deepEqual(ran, ['healthy']);
  assert.equal(result.completed, 1);
});
