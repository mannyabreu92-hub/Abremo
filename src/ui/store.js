// Local persistence for the prototype. Everything the user does is stored as deltas on top of
// the deterministic seed world, so the world itself never needs to be saved.

import { emptyTaste } from '../core/feed.js';

const KEY = 'abremi:v1';
// Saved before the rename to Abremi; moved over on first load so nobody loses their data.
const LEGACY_KEYS = ['gabangi:v1'];

export function defaultState() {
  return {
    user: { name: 'You', role: 'fan', country: 'US', plan: 'free' },
    interactions: {}, // artworkId → 'like' | 'pass' | 'super'
    interactionRoles: {}, // artworkId → role that reacted (so a reaction can be undone exactly)
    deltas: {}, // artworkId → { likes: {role:n}, saves: {role:n}, reviews: {count, ratingSum} }
    follows: {}, // artistId → role at time of follow
    reviews: [], // { artworkId, rating, text, at }
    purchases: [], // { artworkId, price, fee, at }
    messages: [], // { artistId, artworkId, text, at }
    elo: {}, // artworkId → rating override
    battles: { voted: 0, streak: 0, history: [] },
    taste: emptyTaste(),
    uploads: [],
    snapshot: null,
    notifSeenAt: 0,
    discoveries: {}, // artworkId → { at, rankAt, influenceAt, style }: how known a work was when you found it
    followMeta: {}, // artistId → { at, followersAt }: for Early Believer achievements
    activity: [], // [{ t, id, pts }]: influence you added, for your weekly trend
    collections: [], // [{ id, name, private, ids: [], at }]
    achievementsSeen: [],
    masterpieceSeen: '',
  };
}

export function loadState() {
  try {
    let raw = localStorage.getItem(KEY);
    if (!raw) {
      const legacy = LEGACY_KEYS.find((k) => localStorage.getItem(k));
      if (legacy) {
        raw = localStorage.getItem(legacy);
        localStorage.setItem(KEY, raw);
        localStorage.removeItem(legacy);
      }
    }
    if (!raw) return defaultState();
    const saved = JSON.parse(raw);
    const base = defaultState();
    return { ...base, ...saved, battles: { ...base.battles, ...(saved.battles || {}) } };
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
