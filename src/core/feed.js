// Personalized feed: the more you swipe, the more it learns.
// Like Monet + Van Gogh → ~80% of your feed becomes Impressionism, ~20% stays exploratory
// so you still stumble on something amazing you didn't know you'd love.

import { weightedPick } from './random.js';

export const EXPLOIT_RATIO = 0.8;

export const SIGNAL = Object.freeze({ like: 1, super: 2.5, pass: -0.6, follow: 1.5, review: 1 });

export function emptyTaste() {
  return { styles: {}, categories: {}, artists: {} };
}

function bump(map, key, delta) {
  return { ...map, [key]: Math.round(((map[key] || 0) + delta) * 100) / 100 };
}

export function updateTaste(taste, artwork, action) {
  const s = SIGNAL[action] ?? 0;
  return {
    styles: bump(taste.styles, artwork.style, s),
    categories: bump(taste.categories, artwork.category, s * 0.6),
    artists: bump(taste.artists, artwork.artistId, s * 0.8),
  };
}

export function affinity(taste, artwork) {
  return (
    (taste.styles[artwork.style] || 0) +
    0.6 * (taste.categories[artwork.category] || 0) +
    0.8 * (taste.artists[artwork.artistId] || 0)
  );
}

export function topStyles(taste, n = 3) {
  return Object.entries(taste.styles)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

/**
 * Choose the next card.
 * pool: artworks; taste: profile; rng: () => [0,1); seen: Set of ids to skip;
 * popularity: (artwork) => number used to weight exploration toward what's hot.
 * @param {any[]} pool
 * @param {any} taste
 * @param {() => number} rng
 * @param {{ seen?: Set<string>, popularity?: (artwork: any) => number }} [opts]
 */
export function nextArtwork(pool, taste, rng, { seen = new Set(), popularity = () => 1 } = {}) {
  const candidates = pool.filter((a) => !seen.has(a.id));
  if (!candidates.length) return null;

  const favorites = topStyles(taste);
  if (favorites.length && rng() < EXPLOIT_RATIO) {
    const matches = candidates.filter((a) => favorites.includes(a.style));
    if (matches.length) {
      const artwork = weightedPick(rng, matches, (a) => 1 + Math.max(0, affinity(taste, a)) + Math.sqrt(popularity(a)) / 10);
      return { artwork, reason: `Because you like ${artwork.style}` };
    }
  }

  const artwork = weightedPick(rng, candidates, (a) => 1 + Math.sqrt(Math.max(0, popularity(a))));
  const reason = favorites.length ? 'Something new for you' : 'Trending worldwide';
  return { artwork, reason };
}
