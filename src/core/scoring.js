// Weighted Influence: not every like is equal.
// A collector liking a painting matters more than a fan liking it.

export const ROLE_WEIGHTS = Object.freeze({ fan: 1, artist: 3, critic: 5, collector: 9 });

export const ROLES = Object.freeze([
  { id: 'fan', label: 'Fan', emoji: '❤️', weight: 1, blurb: 'Like, share, comment and follow. Lowest influence, largest community.' },
  { id: 'artist', label: 'Artist', emoji: '🎨', weight: 3, blurb: 'Upload art. Earn points from likes, follows, collects and critic reviews.' },
  { id: 'critic', label: 'Critic', emoji: '📝', weight: 5, blurb: 'Verified reviewers. Reviews carry more weight than regular likes.' },
  { id: 'collector', label: 'Collector', emoji: '💎', weight: 9, blurb: 'Buy, collect and sponsor. Highest weight — collectors move the charts.' },
]);

export const ROLE_IDS = Object.freeze(ROLES.map((r) => r.id));

/** A Super Like (collect / save) counts this many times a normal like. */
export const SAVE_MULTIPLIER = 2;
/** A critic review is worth this many critic likes at a 5★ rating (scaled by stars). */
export const REVIEW_MULTIPLIER = 2;

export function emptyRoleCounts() {
  return { fan: 0, artist: 0, critic: 0, collector: 0 };
}

export function addRoleCounts(a, b) {
  const out = emptyRoleCounts();
  for (const r of ROLE_IDS) out[r] = (a?.[r] || 0) + (b?.[r] || 0);
  return out;
}

/** Σ weight(role) × count(role) */
export function weightedSum(counts) {
  let s = 0;
  for (const r of ROLE_IDS) s += ROLE_WEIGHTS[r] * (counts?.[r] || 0);
  return s;
}

/** reviews = { count, ratingSum } with ratings 1–5. A 5★ review = 10 pts, vs 5 for a critic like. */
export function reviewPoints(reviews) {
  if (!reviews) return 0;
  return ROLE_WEIGHTS.critic * REVIEW_MULTIPLIER * ((reviews.ratingSum || 0) / 5);
}

/**
 * Influence Score of an artwork.
 * counts = { likes: RoleCounts, saves: RoleCounts, reviews: { count, ratingSum } }
 */
export function artworkInfluence(counts) {
  return Math.round(
    weightedSum(counts.likes) + SAVE_MULTIPLIER * weightedSum(counts.saves) + reviewPoints(counts.reviews),
  );
}

/** Per-role contribution, for the "why is this ranked here" breakdown. */
export function influenceBreakdown(counts) {
  const rows = ROLES.map((role) => {
    const likes = counts.likes?.[role.id] || 0;
    const saves = counts.saves?.[role.id] || 0;
    return { role: role.id, label: role.label, emoji: role.emoji, likes, saves, points: role.weight * (likes + SAVE_MULTIPLIER * saves) };
  });
  const rp = Math.round(reviewPoints(counts.reviews));
  rows.push({ role: 'review', label: 'Critic reviews', emoji: '⭐', likes: counts.reviews?.count || 0, saves: 0, points: rp });
  return rows;
}

/**
 * Artist score: their works' influence plus weighted followers.
 * Artists earn when art gets liked/collected, when followed, and when critics review them.
 */
export function artistScore(artworksInfluenceTotal, followers) {
  return Math.round(artworksInfluenceTotal + weightedSum(followers));
}
