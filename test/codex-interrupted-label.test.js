'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { candidateLabel, displayWidth, formatInterruptedCandidate, longestRootProject,
  readInterruptedMetadata } = require('../lib/codex-interrupted-label');

const candidate = { threadId: '01a0e2d5-e5e2-74e1-9ad1-3194bda82e93', title: 'Observer title' };
const state = 'quota-interrupted-after-work';

test('name, title, project ID, root, repo and cwd presentation precedence', () => {
  assert.equal(candidateLabel(candidate, { name: 'Navigation', title: 'First prompt',
    projectName: 'Spadrig', rootProjectName: 'Wrong' }), 'Spadrig · Navigation');
  assert.equal(candidateLabel(candidate, { title: 'First prompt', rootProjectName: 'Spadrig' }),
    'Spadrig · First prompt');
  assert.equal(candidateLabel({ ...candidate, title: null }, { cwd: '/home/oscar/projects/spadrig',
    gitOriginUrl: 'https://github.com/Clox/tablance.git' }), 'tablance');
  assert.equal(candidateLabel({ ...candidate, title: null }, { cwd: '/home/oscar/projects/spadrig' }),
    'spadrig');
  assert.equal(longestRootProject('/work/spadrig/nested/src', [
    { root: '/work', name: 'General' }, { root: '/work/spadrig', name: 'Spadrig' },
  ]), 'Spadrig');
  assert.equal(longestRootProject('/work/spadrig-other', [{ root: '/work/spadrig', name: 'Wrong' }]), '');
});

test('missing metadata keeps thread ID; names are sanitized and fit terminal cells', () => {
  const fallback = formatInterruptedCandidate({ ...candidate, title: null }, 'marko@example.com',
    {}, state, 100);
  assert.equal(fallback, 'marko@example.com | …bda82e93 | quota-interrupted-after-work');
  const line = formatInterruptedCandidate(candidate, 'marko@example.com',
    { name: 'Tablance navigation cells with a very long description', projectName: 'Spadrig' },
    state, 80);
  assert.ok(displayWidth(line) <= 80);
  assert.match(line, /…bda82e93 \| quota-interrupted-after-work$/);
  assert.equal(displayWidth('Spadrig · 界面 😀'), 17);
  const clean = candidateLabel(candidate, { name: '\u001b[31mDanger\u001b[0m\nline' });
  assert.doesNotMatch(clean, /\u001b/);
});

test('read-only exact-ID metadata lookup and rollout cwd fallback', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-label-'));
  try {
    fs.writeFileSync(path.join(home, 'state_5.sqlite'), 'fixture');
    const relative = `sessions/2026/10/10/rollout-${candidate.threadId}.jsonl`;
    const filename = path.join(home, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `${JSON.stringify({ type: 'session_meta',
      payload: { id: candidate.threadId, cwd: '/work/spadrig/app' } })}\n`);
    const run = (_cmd, args) => args.at(-1).includes('FROM threads')
      ? JSON.stringify([{ id: candidate.threadId, name: 'Navigation', cwd: '/work/spadrig/app',
        projectName: null }])
      : JSON.stringify([{ root: '/work/spadrig', name: 'Spadrig' }]);
    const found = readInterruptedMetadata(home, [candidate], { files: {
      [relative]: { threadId: candidate.threadId },
    } }, run);
    assert.equal(candidateLabel(candidate, found[candidate.threadId]), 'Spadrig · Navigation');
    const missing = readInterruptedMetadata(path.join(home, 'missing'), [candidate]);
    assert.equal(candidateLabel({ ...candidate, title: null }, missing[candidate.threadId]), '');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
