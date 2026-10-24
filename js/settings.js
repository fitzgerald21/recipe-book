// Settings (API keys, chosen provider/model) live in localStorage on this device.
// They are never synced and never leave the phone except as the API call itself.
import { PROVIDERS } from './defaults.js';

const KEY = 'recipe-book.settings';

const DEFAULTS = {
  provider: 'openrouter',
  models: {
    openrouter: PROVIDERS.openrouter.models[0],
    deepinfra: PROVIDERS.deepinfra.models[0],
    anthropic: PROVIDERS.anthropic.models[0],
  },
  keys: { openrouter: '', deepinfra: '', anthropic: '' },
  // When the chosen provider fails, try the others that have keys.
  fallback: true,
};

export function getSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* ignore */ }
  return {
    ...DEFAULTS,
    ...saved,
    models: { ...DEFAULTS.models, ...(saved.models || {}) },
    keys: { ...DEFAULTS.keys, ...(saved.keys || {}) },
  };
}

export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
