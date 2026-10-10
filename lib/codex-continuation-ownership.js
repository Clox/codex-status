'use strict';

const { AUTO_MODE } = require('./codex-status-preferences');

const OWNER = Object.freeze({ MANUAL_DRAFT: 'manual-draft', HEADLESS: 'headless', DESKTOP: 'desktop' });

function candidateIdentity(candidate) {
  const turnId = candidate?.turnId || candidate?.failedTurnId;
  if (!candidate?.threadId || !turnId) throw new Error('CANDIDATE_IDENTITY_MISSING');
  return JSON.stringify([candidate.threadId, turnId]);
}

function manualDraftClaimsForCandidates(candidates, journal) {
  const claims = journal?.claims && typeof journal.claims === 'object' ? journal.claims : {};
  return (candidates || []).filter(candidate => claims[candidateIdentity(candidate)]?.owner === OWNER.MANUAL_DRAFT);
}

function continuationOwner(candidate, preferences) {
  candidateIdentity(candidate);
  switch (preferences?.autoMode) {
    case AUTO_MODE.HEADLESS: return OWNER.HEADLESS;
    case AUTO_MODE.DESKTOP: return OWNER.DESKTOP;
    case AUTO_MODE.OFF: return OWNER.MANUAL_DRAFT;
    default: throw new Error('CONTINUATION_MODE_UNVERIFIED');
  }
}

module.exports = { OWNER, candidateIdentity, continuationOwner, manualDraftClaimsForCandidates };
