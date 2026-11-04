// Cultural signals computed from real activity: credibility, rising artists, country rankings
// and the Daily Masterpiece. Nothing here invents numbers: every value traces back to likes,
// saves, follows, reviews and battle results.

import { ROLE_WEIGHTS, SAVE_MULTIPLIER, reviewPoints } from './scoring.js';
import { hashString, mulberry32 } from './random.js';

const ROLE_IDS = ['fan', 'artist', 'critic', 'collector'];
const rolePoints = (counts, role) => ROLE_WEIGHTS[role] * ((counts.likes?.[role] || 0) + SAVE_MULTIPLIER * (counts.saves?.[role] || 0));

/**
 * Popularity is the whole influence score. Credibility is the share of it that comes from
 * critics and collectors (including reviews): the people whose judgement carries the most weight.
 */
export function credibility(counts) {
  const review = reviewPoints(counts.reviews);
  const total = ROLE_IDS.reduce((s, r) => s + rolePoints(counts, r), 0) + review;
  if (!total) return { share: 0, collectorShare: 0, total: 0 };
  return {
    share: (rolePoints(counts, 'critic') + rolePoints(counts, 'collector') + review) / total,
    collectorShare: rolePoints(counts, 'collector') / total,
    total,
  };
}

/** Local date key (YYYY-MM-DD) and the moment the next Daily Masterpiece is revealed. */
export function dayKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function nextRevealAt(now = new Date()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d;
}

/**
 * The Daily Masterpiece: one work a day, chosen from the 60 most influential works, weighted
 * towards those that critics and collectors rate (credibility), and never the same two days running.
 * ranked: [{ item, score }] sorted by influence; credOf(artwork) → credibility share 0..1.
 */
export function dailyMasterpiece(ranked, credOf, now = new Date()) {
  const pool = ranked.slice(0, 60);
  if (!pool.length) return null;
  const pickFor = (key, exclude) => {
    const rng = mulberry32(hashString(`masterpiece:${key}`));
    const options = pool.filter((r) => r.item.id !== exclude);
    const weights = options.map((r) => (0.15 + credOf(r.item)) * Math.sqrt(r.score + 1));
    let x = rng() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < options.length; i++) {
      x -= weights[i];
      if (x <= 0) return options[i];
    }
    return options[options.length - 1];
  };
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const prev = pickFor(dayKey(yesterday));
  const pick = pickFor(dayKey(now), prev.item.id);
  return { artwork: pick.item, rank: ranked.indexOf(pick) + 1, day: dayKey(now), revealAt: nextRevealAt(now) };
}

/**
 * Momentum: influence earned per follower. High momentum means the work is landing with far
 * more people than the artist's audience would explain: the signature of an artist about to break out.
 */
export function momentum(artistInfluence, followerTotal) {
  return artistInfluence / Math.sqrt(followerTotal + 25);
}

/**
 * Signals shown next to artists. Inputs are real measurements:
 * rankDelta: places gained since the previous hourly chart (null if no previous chart yet);
 * momentumPercentile: 0..1 among all artists; collectorShare: 0..1; globalRank; debutYear.
 */
export function artistSignals({ rankDelta = null, momentumPercentile = 0, collectorShare = 0, globalRank = Infinity, debutYear = 0, currentYear }) {
  const out = [];
  const recent = debutYear >= currentYear - 3;
  if ((rankDelta !== null && rankDelta >= 10) || (recent && momentumPercentile >= 0.85)) out.push('rising');
  if (globalRank <= 100 && rankDelta !== null && rankDelta > 0) out.push('trending');
  if (collectorShare >= 0.25) out.push('collector');
  return out;
}

export const SIGNALS = Object.freeze({
  rising: { icon: '🔥', label: 'Rising Artist', desc: 'Climbing fast, or earning far more influence than their following would explain.' },
  trending: { icon: '↗', label: 'Trending Globally', desc: 'In the global top 100 and moving up since the last hourly chart.' },
  collector: { icon: '⭐', label: 'Collector Attention', desc: 'A quarter or more of their influence comes from collectors.' },
});

/** Percentile (0..1) of each value within the list. */
export function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (v) => {
    if (sorted.length < 2) return 0;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return lo / (sorted.length - 1);
  };
}

/**
 * Cultural Influence by Country: the sum of artists' scores per country, with each country's
 * leading artist and artwork. artists: [{ id, country }]; scoreOf(artist); works: [{ artistId, id }].
 */
export function countryStandings(artists, scoreOf, works, influenceOf) {
  const by = new Map();
  for (const a of artists) {
    if (!a.country) continue;
    const row = by.get(a.country) || { country: a.country, score: 0, artists: 0, topArtist: null, topArtwork: null };
    row.score += scoreOf(a);
    row.artists += 1;
    if (!row.topArtist || scoreOf(a) > scoreOf(row.topArtist)) row.topArtist = a;
    by.set(a.country, row);
  }
  const artistCountry = new Map(artists.map((a) => [a.id, a.country]));
  for (const w of works) {
    const row = by.get(artistCountry.get(w.artistId));
    if (row && (!row.topArtwork || influenceOf(w) > influenceOf(row.topArtwork))) row.topArtwork = w;
  }
  return [...by.values()].sort((a, b) => b.score - a.score || (a.country < b.country ? -1 : 1)).map((r, i) => ({ ...r, rank: i + 1 }));
}
