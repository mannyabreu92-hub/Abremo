// Local persistence for the prototype. Everything the user does is stored as deltas on top of
// the deterministic seed world, so the world itself never needs to be saved.

import { emptyTaste } from '../core/feed.js';

const KEY = 'gabangi:v1';

export function defaultState() {
  return {
    user: { name: 'You', role: 'fan', country: 'US', plan: 'free' },
    interactions: {}, // artworkId → 'like' | 'pass' | 'super'
    deltas: {}, // artworkId → { likes: {role:n}, saves: {role:n}, reviews: {count, ratingSum} }
    follows: {}, // artistId → role at time of follow
    reviews: [], // { artworkId, rating, text, at }
    purchases: [], // { artworkId, price, fee, at }
    messages: [], // { artistId, artworkId, text, at }
    elo: {}, // artworkId → rating override
    battles: { voted: 0, streak: 0 },
    taste: emptyTaste(),
    uploads: [],
    snapshot: null,
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function resetState() {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  return defaultState();
}
