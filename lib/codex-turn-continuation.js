'use strict';

const crypto = require('node:crypto');

const INTERRUPTION_CLASS = Object.freeze({
  AFTER_WORK: 'INTERRUPTED_AFTER_WORK',
  BEFORE_WORK: 'REJECTED_BEFORE_WORK',
  UNKNOWN: 'UNKNOWN',
});

const HEADLESS_CONTINUATION_PROMPT = 'Du blev avbruten på grund av ett verifierat kvotbyte. Kontrollera det befintliga arbetsläget och fortsätt där du slutade utan att upprepa redan utförda sidoeffekter.';
const DESKTOP_CONTINUATION_DRAFT = 'Fortsätt där du blev avbruten. Kontrollera det befintliga arbetsläget först och upprepa inte redan utförda sidoeffekter.';

const SUPPORTED_INPUT_KEYS = Object.freeze({
  text: new Set(['type', 'text', 'text_elements']),
  image: new Set(['type', 'url', 'detail']),
  localImage: new Set(['type', 'path', 'detail']),
  audio: new Set(['type', 'url']),
  localAudio: new Set(['type', 'path']),
  skill: new Set(['type', 'name', 'path']),
  mention: new Set(['type', 'name', 'path']),
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function inputHash(input) {
  return crypto.createHash('sha256').update(stableJson(input)).digest('hex');
}

function validString(value) {
  return typeof value === 'string' && value.length > 0;
}

function supportedInputItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const allowed = SUPPORTED_INPUT_KEYS[item.type];
  if (!allowed || Object.keys(item).some(key => !allowed.has(key))) return false;
  switch (item.type) {
    case 'text':
      return typeof item.text === 'string' &&
        (item.text_elements === undefined || Array.isArray(item.text_elements));
    case 'image':
    case 'audio':
      return validString(item.url);
    case 'localImage':
    case 'localAudio':
      return validString(item.path);
    case 'skill':
    case 'mention':
      return validString(item.name) && validString(item.path);
    default:
      return false;
  }
}

function exactAppServerInput(input) {
  return Array.isArray(input) && input.length > 0 && input.every(supportedInputItem);
}

function exactDesktopDraft(input) {
  if (!exactAppServerInput(input) || input.length !== 1 || input[0].type !== 'text') return null;
  if (Array.isArray(input[0].text_elements) && input[0].text_elements.length > 0) return null;
  return input[0].text;
}

function continuationForCandidate(candidate, { desktop = false } = {}) {
  const classification = candidate?.interruptionClass || INTERRUPTION_CLASS.UNKNOWN;
  if (classification === INTERRUPTION_CLASS.AFTER_WORK) {
    const prompt = desktop ? DESKTOP_CONTINUATION_DRAFT : HEADLESS_CONTINUATION_PROMPT;
    const input = [{ type: 'text', text: prompt }];
    return {
      ok: true,
      classification,
      kind: 'continue-after-work',
      input,
      inputHash: inputHash(input),
      desktopPrompt: desktop ? prompt : null,
    };
  }
  if (classification === INTERRUPTION_CLASS.BEFORE_WORK) {
    const input = candidate?.originalInput;
    const hash = exactAppServerInput(input) ? inputHash(input) : null;
    if (!hash || hash !== candidate?.originalInputHash) {
      return { ok: false, classification, reason: 'original-input-unverified' };
    }
    if (desktop) {
      const prompt = exactDesktopDraft(input);
      return prompt === null
        ? { ok: false, classification, reason: 'desktop-input-not-lossless', navigateOnly: true }
        : { ok: true, classification, kind: 'replay-original', input, inputHash: hash, desktopPrompt: prompt };
    }
    return { ok: true, classification, kind: 'replay-original', input, inputHash: hash, desktopPrompt: null };
  }
  return { ok: false, classification: INTERRUPTION_CLASS.UNKNOWN, reason: 'interruption-class-unknown' };
}

module.exports = {
  DESKTOP_CONTINUATION_DRAFT,
  HEADLESS_CONTINUATION_PROMPT,
  INTERRUPTION_CLASS,
  continuationForCandidate,
  exactAppServerInput,
  exactDesktopDraft,
  inputHash,
  stableJson,
  supportedInputItem,
};
