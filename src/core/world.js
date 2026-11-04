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

/**
 * state.memberArtists / state.memberArtworks: community members and their uploads (community mode).
 * state.myArtistId: which artist is the viewer (marked isMe). Demo mode uses a local 'me' artist instead.
 */
export function createWorld(seed, state) {
  const members = (state.memberArtists || []).map((a) => (a.id === state.myArtistId ? { ...a, isMe: true } : a));
  const artists = seed.artists.concat(members);
  const hasUploads = state.uploads.length > 0;
  if (!state.memberArtists && (hasUploads || state.user.role === 'artist')) {
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
  const artworks = seed.artworks.concat(state.memberArtworks || [], state.uploads);

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

  // state.rankedOnly (community mode): only what real activity has scored gets a rank number, so a
  // work nobody has liked is never "No. 412". Unscored items stay in the list (rank: null, last),
  // because the same lists also order the catalog for browsing and search.
  const earned = (rows, scored = (r) => r.score > 0) => (state.rankedOnly ? rows.map((r) => (scored(r) ? r : { ...r, rank: null })) : rows);
  const topArtworks = (opts) => earned(rank(filterArtworks(opts), (w) => influence[w.id]));
  const topArtists = (opts) => earned(rank(filterArtists(opts), (a) => artistScores[a.id]));
  const topElo = (opts) => {
    const battled = (w) => !state.rankedOnly || state.elo[w.id] != null;
    const pool = filterArtworks(opts);
    return earned(rank(pool.filter(battled), eloOf), () => true).concat(pool.filter((w) => !battled(w)).map((item) => ({ item, score: eloOf(item), rank: null })));
  };

  const ranksOf = (rows) => Object.fromEntries(rows.filter((r) => r.rank != null).map((r) => [r.item.id, r.rank]));
  const globalArtistRanks = ranksOf(topArtists());
  const countryArtistRanks = {};
  for (const c of new Set(artists.map((a) => a.country))) {
    Object.assign(countryArtistRanks, ranksOf(topArtists({ country: c })));
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
