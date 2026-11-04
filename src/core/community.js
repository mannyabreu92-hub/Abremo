// Turns server data into the shapes the app already uses, so the rest of the UI does not
// care whether totals come from this device (demo mode) or from everyone (community mode).

import { emptyRoleCounts, ROLE_IDS } from './scoring.js';

export function emptyCommunity() {
  return { deltas: {}, followerDeltas: {}, elo: {}, members: 0, fetchedAt: 0 };
}

const emptyDelta = () => ({ likes: emptyRoleCounts(), saves: emptyRoleCounts(), reviews: { count: 0, ratingSum: 0 } });

/** community_snapshot() → { deltas, followerDeltas, elo, members } */
export function snapshotToCommunity(snap, now = Date.now()) {
  const out = emptyCommunity();
  const delta = (id) => (out.deltas[id] ||= emptyDelta());
  for (const r of snap?.reactions || []) {
    if (!ROLE_IDS.includes(r.r) || !(r.n > 0)) continue;
    const d = delta(r.a);
    if (r.k === 'super') d.saves[r.r] += r.n;
    else if (r.k === 'like') d.likes[r.r] += r.n;
  }
  for (const r of snap?.reviews || []) {
    const d = delta(r.a);
    d.reviews.count += r.n || 0;
    d.reviews.ratingSum += r.s || 0;
  }
  for (const f of snap?.follows || []) {
    if (!ROLE_IDS.includes(f.r)) continue;
    (out.followerDeltas[f.a] ||= emptyRoleCounts())[f.r] += f.n || 0;
  }
  for (const r of snap?.ratings || []) if (Number.isFinite(r.v)) out.elo[r.a] = r.v;
  out.members = snap?.members || 0;
  out.fetchedAt = now;
  return out;
}

/** The signed-in person's own rows → the app's state fields. */
export function mineToState({ reactions = [], follows = [], reviews = [] } = {}) {
  const interactions = {};
  const interactionRoles = {};
  for (const r of reactions) {
    interactions[r.artwork_id] = r.kind;
    interactionRoles[r.artwork_id] = r.role;
  }
  const followMap = {};
  for (const f of follows) followMap[f.artist_id] = f.role;
  return {
    interactions,
    interactionRoles,
    follows: followMap,
    reviews: reviews.map((r) => ({ artworkId: r.artwork_id, rating: r.rating, text: r.body || '', at: Date.parse(r.created_at) || Date.now() })),
  };
}

/**
 * What a guest did on this device that their account does not have yet.
 * The account wins on conflicts; uploads (ids not in the catalog) stay local.
 */
export function guestContributions(state, mine, { artworkIds, artistIds }) {
  const have = new Set((mine.reactions || []).map((r) => r.artwork_id));
  const following = new Set((mine.follows || []).map((f) => f.artist_id));
  const reactions = Object.entries(state.interactions || {})
    .filter(([id, kind]) => artworkIds.has(id) && !have.has(id) && ['like', 'super', 'pass'].includes(kind))
    .map(([artwork_id, kind]) => ({ artwork_id, kind }));
  const follows = Object.keys(state.follows || {})
    .filter((id) => artistIds.has(id) && !following.has(id))
    .map((artist_id) => ({ artist_id }));
  return { reactions, follows };
}
