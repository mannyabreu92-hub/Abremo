// Merges the seeded world with the user's actions into one queryable model.

import { addRoleCounts, artworkInfluence, artistScore, emptyRoleCounts } from './scoring.js';
import { rank } from './rankings.js';
import { artistBadges } from './badges.js';
import { CURRENT_YEAR } from './seed.js';

export function mergeCounts(base, delta) {
  if (!delta) return base;
  return {
    likes: addRoleCounts(base.likes, delta.likes),
    saves: addRoleCounts(base.saves, delta.saves),
    reviews: {
      count: (base.reviews?.count || 0) + (delta.reviews?.count || 0),
      ratingSum: (base.reviews?.ratingSum || 0) + (delta.reviews?.ratingSum || 0),
    },
  };
}

export function createWorld(seed, state) {
  const artists = seed.artists.slice();
  const hasUploads = state.uploads.length > 0;
  if (hasUploads || state.user.role === 'artist') {
    const cats = state.uploads.map((u) => u.category);
    artists.push({
      id: 'me',
      name: state.user.name,
      country: state.user.country,
      category: cats[0] || 'mixed',
      styles: [...new Set(state.uploads.map((u) => u.style))].slice(0, 2),
      talent: 0.5,
      debutYear: CURRENT_YEAR,
      followers: emptyRoleCounts(),
      palette: 0,
      isMe: true,
    });
  }
  const artworks = seed.artworks.concat(state.uploads);

  const artistById = Object.fromEntries(artists.map((a) => [a.id, a]));
  const artworkById = Object.fromEntries(artworks.map((a) => [a.id, a]));

  const countsCache = new Map();
  const countsOf = (art) => {
    if (!countsCache.has(art.id)) countsCache.set(art.id, mergeCounts(art.counts, state.deltas[art.id]));
    return countsCache.get(art.id);
  };
  const influence = Object.fromEntries(artworks.map((a) => [a.id, artworkInfluence(countsOf(a))]));

  // Community mode passes everyone's follows as followerDeltas; demo mode counts this device's.
  const followersOf = (artist) => {
    const f = { ...artist.followers };
    if (state.followerDeltas) {
      for (const [role, n] of Object.entries(state.followerDeltas[artist.id] || {})) f[role] = (f[role] || 0) + n;
      return f;
    }
    for (const [artistId, role] of Object.entries(state.follows)) if (artistId === artist.id) f[role] = (f[role] || 0) + 1;
    return f;
  };

  const worksByArtist = {};
  for (const w of artworks) (worksByArtist[w.artistId] ||= []).push(w);

  const artistScores = Object.fromEntries(
    artists.map((a) => [a.id, artistScore((worksByArtist[a.id] || []).reduce((s, w) => s + influence[w.id], 0), followersOf(a))]),
  );

  const eloOf = (art) => state.elo[art.id] ?? art.elo;

  const filterArtworks = ({ country, category } = {}) =>
    artworks.filter((w) => (!country || artistById[w.artistId]?.country === country) && (!category || w.category === category));
  const filterArtists = ({ country, category } = {}) =>
    artists.filter((a) => (!country || a.country === country) && (!category || (worksByArtist[a.id] || []).some((w) => w.category === category)));

  const topArtworks = (opts) => rank(filterArtworks(opts), (w) => influence[w.id]);
  const topArtists = (opts) => rank(filterArtists(opts), (a) => artistScores[a.id]);
  const topElo = (opts) => rank(filterArtworks(opts), eloOf);

  const globalArtistRanks = Object.fromEntries(topArtists().map((r) => [r.item.id, r.rank]));
  const countryArtistRanks = {};
  for (const c of new Set(artists.map((a) => a.country))) {
    for (const r of topArtists({ country: c })) countryArtistRanks[r.item.id] = r.rank;
  }

  const badgesOf = (artist) =>
    artistBadges({
      globalRank: globalArtistRanks[artist.id],
      countryRank: countryArtistRanks[artist.id],
      debutYear: artist.debutYear,
      currentYear: CURRENT_YEAR,
      score: artistScores[artist.id],
    });

  return {
    artists, artworks, artistById, artworkById, worksByArtist,
    countsOf, influence, artistScores, followersOf, eloOf,
    topArtworks, topArtists, topElo, globalArtistRanks, countryArtistRanks, badgesOf,
  };
}
