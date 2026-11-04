// Taste Score, personal Cultural Influence and achievements.
// All of it is computed from the person's own recorded discoveries (what they liked or saved,
// and how well-known each work was at that moment) compared with how those works rank now.

import { ROLE_WEIGHTS, SAVE_MULTIPLIER, REVIEW_MULTIPLIER } from './scoring.js';

export const MIN_DISCOVERIES = 5;

export const TASTE_TIERS = Object.freeze([
  { min: 95, label: 'Global Tastemaker' },
  { min: 85, label: 'Elite Cultural Scout' },
  { min: 70, label: 'Trend Hunter' },
  { min: 40, label: 'Cultural Scout' },
  { min: 0, label: 'Emerging Eye' },
]);

export const tierFor = (score) => TASTE_TIERS.find((t) => score >= t.min).label;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * discoveries: [{ id, style, rankAt, influenceAt }] recorded when the work was liked or saved.
 * now: { rankOf(id), influenceOf(id), total } — current standings.
 *
 * Three parts, each 0..1:
 * - gems: how often you found work outside the top quarter of the rankings.
 * - foresight: how far the works you found have climbed (rank) or grown (influence) since.
 * - range: how many movements you explore (six or more counts as full range).
 * Confidence grows with the number of discoveries, so a handful of lucky picks can't top the scale.
 */
export function tasteScore(discoveries, now) {
  const found = discoveries.filter((d) => now.rankOf(d.id) != null);
  if (found.length < MIN_DISCOVERIES) return { score: null, needed: MIN_DISCOVERIES - found.length, count: found.length };
  const quarter = Math.max(100, now.total * 0.25);
  const gems = found.filter((d) => d.rankAt > quarter).length / found.length;
  const foresight = found.reduce((sum, d) => {
    const rankNow = now.rankOf(d.id);
    const climbed = clamp01((d.rankAt - rankNow) / Math.max(d.rankAt, 1));
    const grew = clamp01(Math.log2(1 + Math.max(0, now.influenceOf(d.id) - d.influenceAt) / Math.max(d.influenceAt, 10)));
    return sum + Math.max(climbed, grew);
  }, 0) / found.length;
  const range = clamp01(new Set(found.map((d) => d.style)).size / 6);
  const confidence = Math.min(1, 0.55 + found.length / 60);
  const score = Math.round(100 * (0.45 * gems + 0.4 * foresight + 0.15 * range) * confidence);
  return { score, tier: tierFor(score), parts: { gems, foresight, range }, count: found.length };
}

/**
 * Your Cultural Influence: the weight you have added to the rankings.
 * interactions: { id: 'like'|'super'|'pass' }, roles: { id: role }, reviews: [{ rating }].
 */
export function personalInfluence(interactions, roles, reviews = []) {
  let total = 0;
  for (const [id, kind] of Object.entries(interactions)) {
    const w = ROLE_WEIGHTS[roles?.[id] || 'fan'] || 1;
    if (kind === 'like') total += w;
    else if (kind === 'super') total += w * SAVE_MULTIPLIER;
  }
  for (const r of reviews) total += ROLE_WEIGHTS.critic * REVIEW_MULTIPLIER * (r.rating / 5);
  return Math.round(total);
}

/** Points added per day for the last `days` days (oldest first), from the activity log [{ t, pts }]. */
export function dailyActivity(activity, days = 7, now = Date.now()) {
  const dayMs = 86_400_000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const firstDay = start.getTime() - (days - 1) * dayMs;
  const out = new Array(days).fill(0);
  for (const a of activity) {
    const i = Math.floor((a.t - firstDay) / dayMs);
    if (i >= 0 && i < days) out[i] += a.pts;
  }
  return out;
}

export const ACHIEVEMENTS = Object.freeze({
  firstDiscovery: { label: 'First Discovery', desc: 'You liked or saved your first work.' },
  hiddenGem: { label: 'Hidden Gem Finder', desc: 'Five discoveries found outside the top quarter of the rankings.' },
  trendHunter: { label: 'Trend Hunter', desc: 'Three works you found have since climbed 20 or more places.' },
  culturalScout: { label: 'Cultural Scout', desc: '25 discoveries across at least five movements.' },
  masterCurator: { label: 'Master Curator', desc: 'Three collections with five or more works each.' },
  globalTastemaker: { label: 'Global Tastemaker', desc: 'A Taste Score of 95 or higher.' },
  earlyBeliever1k: { label: 'Early Believer', desc: 'You followed an artist before they reached 1,000 followers, and they got there.' },
  earlyBeliever10k: { label: 'Early Believer · 10K', desc: 'You followed an artist before 10,000 followers, and they got there.' },
  earlyBeliever100k: { label: 'Early Believer · 100K', desc: 'You followed an artist before 100,000 followers, and they got there.' },
});

/**
 * follows: { artistId: { followersAt } } recorded when you followed; followersNow(artistId) → current total.
 * collections: [{ ids: [] }]; taste: result of tasteScore().
 */
export function earnedAchievements({ discoveries, now, collections = [], taste, follows = {}, followersNow = () => 0 }) {
  const out = [];
  const quarter = Math.max(100, now.total * 0.25);
  if (discoveries.length >= 1) out.push('firstDiscovery');
  if (discoveries.filter((d) => d.rankAt > quarter).length >= 5) out.push('hiddenGem');
  if (discoveries.filter((d) => now.rankOf(d.id) != null && d.rankAt - now.rankOf(d.id) >= 20).length >= 3) out.push('trendHunter');
  if (discoveries.length >= 25 && new Set(discoveries.map((d) => d.style)).size >= 5) out.push('culturalScout');
  if (collections.filter((c) => c.ids.length >= 5).length >= 3) out.push('masterCurator');
  if (taste?.score >= 95) out.push('globalTastemaker');
  for (const [milestone, id] of [[1000, 'earlyBeliever1k'], [10000, 'earlyBeliever10k'], [100000, 'earlyBeliever100k']]) {
    if (Object.entries(follows).some(([artistId, f]) => f.followersAt < milestone && followersNow(artistId) >= milestone)) out.push(id);
  }
  return out;
}

export const COLLECTION_PRESETS = Object.freeze(['Personal Museum', 'Private Gallery', 'Future Investments', 'Emerging Artists', 'Hidden Gems', 'Masterpieces']);
