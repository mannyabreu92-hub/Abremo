// Turns server data into the shapes the app already uses, so the rest of the UI does not
// care whether totals come from this device (demo mode) or from everyone (community mode).

import { emptyRoleCounts, ROLE_IDS } from './scoring.js';
import { CATEGORIES, STYLES, PALETTES, CURRENT_YEAR } from './seed.js';
import { hashString } from './random.js';
import { START_RATING } from './elo.js';

export function emptyCommunity() {
  return { deltas: {}, followerDeltas: {}, elo: {}, battles: {}, scores: null, members: 0, fetchedAt: 0, artists: [], artworks: [] };
}

const emptyDelta = () => ({ likes: emptyRoleCounts(), saves: emptyRoleCounts(), reviews: { count: 0, ratingSum: 0 } });
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

/**
 * The shared catalog in community mode: the same sample works and artists, but with none of the
 * demo's simulated likes, followers, reviews or battle ratings. Every number shown in community
 * mode comes from real members.
 */
export function sampleCatalog(seed) {
  return {
    ...seed,
    artists: seed.artists.map((a) => ({ ...a, followers: emptyRoleCounts(), sample: true })),
    artworks: seed.artworks.map((w) => ({ ...w, counts: emptyDelta(), elo: START_RATING, sample: true })),
  };
}

/** Storage paths become public URLs; data: and http(s) URLs (the test backend) pass through. */
export function imageURL(path, storageBase = '') {
  if (!path) return '';
  if (/^(data:|https?:)/.test(path)) return path;
  return `${storageBase}${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Member uploads → artworks in the same shape as the catalog. Unknown categories/styles are skipped. */
export function uploadsToArtworks(uploads = [], storageBase = '') {
  return (uploads || [])
    .filter((u) => CATEGORY_IDS.has(u.category) && STYLES.includes(u.style) && u.image_path)
    .map((u) => ({
      id: u.id,
      title: u.title,
      artistId: u.artist_id,
      category: u.category,
      style: u.style,
      medium: u.medium || CATEGORIES.find((c) => c.id === u.category).medium,
      year: u.year || CURRENT_YEAR,
      price: u.price,
      image: imageURL(u.image_path, storageBase),
      thumb: imageURL(u.thumb_path || u.image_path, storageBase),
      width: u.width,
      height: u.height,
      quality: 0.5,
      palette: PALETTES[hashString(u.id) % PALETTES.length],
      counts: emptyDelta(),
      elo: 1200,
      createdAt: Date.parse(u.created_at) || 0,
      description: u.description || '',
      dimensions: u.dimensions || '',
      availability: u.availability || 'available',
      member: true,
    }));
}

/** Member artists, with medium and movements taken from their own uploads. */
export function membersToArtists(members = [], artworks = [], storageBase = '') {
  return (members || []).map((m) => {
    const works = artworks.filter((w) => w.artistId === m.id);
    const ranked = (key) => {
      const tally = {};
      for (const w of works) tally[w[key]] = (tally[w[key]] || 0) + 1;
      return Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    };
    return {
      id: m.id,
      name: m.name,
      country: m.country,
      category: ranked('category')[0] || 'mixed',
      styles: ranked('style').slice(0, 2),
      talent: 0.5,
      debutYear: new Date(Date.parse(m.created_at) || Date.now()).getFullYear(),
      followers: emptyRoleCounts(),
      palette: hashString(m.id) % PALETTES.length,
      member: true,
      bio: m.bio || '',
      statement: m.statement || '',
      website: /^https:\/\//.test(m.website || '') ? m.website : '',
      instagram: m.instagram || '',
      city: m.city || '',
      avatarPath: m.avatar_path || '',
      avatar: m.avatar_path ? imageURL(m.avatar_path, storageBase) : '',
    };
  });
}

/** community_snapshot() → { deltas, followerDeltas, elo, members, artists, artworks } */
export function snapshotToCommunity(snap, now = Date.now(), { storageBase = '' } = {}) {
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
  for (const r of snap?.ratings || []) {
    if (Number.isFinite(r.v)) out.elo[r.a] = r.v;
    if (Number.isFinite(r.n)) out.battles[r.a] = r.n;
  }
  // The server's scores (databases from before 0007 send none, and the app computes them as before).
  if (Array.isArray(snap?.scores)) {
    out.scores = { popularity: {}, trending: {}, collector: {}, critic: {}, reputation: {} };
    for (const x of snap.scores) {
      out.scores.popularity[x.a] = x.p || 0;
      out.scores.trending[x.a] = Number(x.t) || 0;
      out.scores.collector[x.a] = x.c || 0;
      out.scores.critic[x.a] = x.cr || 0;
    }
    for (const x of snap.artist_scores || []) out.scores.reputation[x.a] = x.s || 0;
  }
  out.members = snap?.members || 0;
  out.artworks = uploadsToArtworks(snap?.uploads, storageBase);
  out.artists = membersToArtists(snap?.artists, out.artworks, storageBase);
  out.fetchedAt = now;
  return out;
}

/** The signed-in person's own rows → the app's state fields. */
/** The app's labels for artwork availability (as reported by the artist). */
export const AVAILABILITY = {
  available: 'Available',
  on_request: 'Price on request',
  sold: 'Sold',
  not_for_sale: 'Not for sale',
};

/** Server collections → the shape the app uses ({ id, name, description, private, ids, at }). */
export function collectionsToState(rows = [], items = []) {
  return (rows || []).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description || '',
    private: c.is_private !== false,
    ids: (items || []).filter((i) => i.collection_id === c.id).sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at)).map((i) => i.artwork_id),
    at: Date.parse(c.created_at) || 0,
    server: true,
  }));
}

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
