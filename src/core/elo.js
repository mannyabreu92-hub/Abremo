// Art Battles: two artworks, one vote, chess-style ratings.
// Winner gains points; the loser loses fewer points than the winner gains,
// so taking part in battles never feels like a harsh penalty for artists.

import { ROLE_WEIGHTS } from './scoring.js';

export const START_RATING = 1200;
export const BASE_K = 16;
export const LOSS_FACTOR = 0.75;

export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/** Heavier voters move ratings more: fan 20, artist 28, critic 36, collector 52. */
export function kFactor(role = 'fan') {
  return BASE_K + 4 * (ROLE_WEIGHTS[role] ?? 1);
}

export function battleResult(winnerRating, loserRating, role = 'fan') {
  const k = kFactor(role);
  const gain = Math.max(1, Math.round(k * (1 - expectedScore(winnerRating, loserRating))));
  const loss = Math.floor(gain * LOSS_FACTOR);
  return {
    gain,
    loss,
    winner: winnerRating + gain,
    loser: loserRating - loss,
    upset: winnerRating < loserRating,
  };
}

/** Pick two artworks by different artists at random. */
export function pickBattlePair(artworks, rng) {
  if (artworks.length < 2) return null;
  const a = artworks[Math.floor(rng() * artworks.length)];
  for (let tries = 0; tries < 50; tries++) {
    const b = artworks[Math.floor(rng() * artworks.length)];
    if (b.id !== a.id && b.artistId !== a.artistId) return [a, b];
  }
  const b = artworks.find((x) => x.id !== a.id);
  return b ? [a, b] : null;
}
