// Member leaderboards: Top Collectors, Top Critics and Top Discoverers.
// The database computes these in member_leaderboards() (supabase/migrations/0003_member_leaderboards.sql);
// this file is the same maths in JavaScript, used by the test backend and checked against the SQL
// in tests/db.test.js so the two can never drift apart.

import { ROLE_WEIGHTS } from './scoring.js';

const w = (role) => ROLE_WEIGHTS[role] || 1;
export const MIN_DISCOVERIES = 3;
export const BOARDS = ['collectors', 'critics', 'discoverers'];

/**
 * Discovery Score (0–100): credit for liking work before others did.
 * For each like or Super Like: ln(1 + weight of the likes that came after yours) / (1 + weight of those before).
 * Later likes are weighted by role (fan 1 … collector 9), so throwaway accounts barely move it.
 * reactions: [{ user, artwork, kind, role, at }] — `at` orders reactions on the same artwork.
 * Returns Map(user → { score, discoveries }), score null below MIN_DISCOVERIES.
 */
export function discoveryScores(reactions) {
  const byArtwork = new Map();
  for (const r of reactions) {
    if (r.kind !== 'like' && r.kind !== 'super') continue;
    if (!byArtwork.has(r.artwork)) byArtwork.set(r.artwork, []);
    byArtwork.get(r.artwork).push(r);
  }
  const raw = new Map();
  for (const list of byArtwork.values()) {
    list.sort((a, b) => a.at - b.at || (a.user < b.user ? -1 : a.user > b.user ? 1 : 0));
    const total = list.reduce((s, r) => s + w(r.role), 0);
    let before = 0;
    for (const r of list) {
      const after = total - before - w(r.role);
      const cur = raw.get(r.user) || { sum: 0, n: 0 };
      cur.sum += Math.log(1 + after) / (1 + before);
      cur.n += 1;
      raw.set(r.user, cur);
      before += w(r.role);
    }
  }
  const out = new Map();
  for (const [user, { sum, n }] of raw) {
    out.set(user, { discoveries: n, score: n >= MIN_DISCOVERIES ? Math.round(100 * (1 - Math.exp(-sum / 8))) : null });
  }
  return out;
}

/**
 * All three boards. profiles: [{ id, name, country, role, public }]; reviews: [{ user, rating }].
 * Only public members appear, plus the viewer (`me`), who always sees their own standing.
 */
export function memberBoards({ profiles, reactions, reviews }, { me = null, country = null, limit = 50 } = {}) {
  const contrib = new Map();
  for (const r of reactions) {
    const pts = r.kind === 'like' ? w(r.role) : r.kind === 'super' ? 2 * w(r.role) : 0;
    const key = `${r.user}|${r.role}`;
    contrib.set(key, (contrib.get(key) || 0) + pts);
  }
  const reviewPts = new Map(), reviewCount = new Map();
  for (const r of reviews) {
    reviewPts.set(r.user, (reviewPts.get(r.user) || 0) + 2 * r.rating);
    reviewCount.set(r.user, (reviewCount.get(r.user) || 0) + 1);
  }
  const disc = discoveryScores(reactions);
  const rows = { collectors: [], critics: [], discoverers: [] };
  for (const p of profiles) {
    if (!(p.public || p.id === me) || (country && p.country !== country)) continue;
    const base = { id: p.id, name: p.name, country: p.country };
    const collector = contrib.get(`${p.id}|collector`) || 0;
    const critic = (contrib.get(`${p.id}|critic`) || 0) + (reviewPts.get(p.id) || 0);
    if (p.role === 'collector' && collector > 0) rows.collectors.push({ ...base, score: collector, detail: collector });
    if (p.role === 'critic' && critic > 0) rows.critics.push({ ...base, score: critic, detail: reviewCount.get(p.id) || 0 });
    const d = disc.get(p.id);
    if (d?.score != null) rows.discoverers.push({ ...base, score: d.score, detail: d.discoveries });
  }
  const result = { me: {} };
  for (const board of BOARDS) {
    const sorted = rows[board].sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let rank = 0;
    sorted.forEach((r, i) => { if (i === 0 || r.score !== sorted[i - 1].score) rank = i + 1; r.rank = rank; });
    result[board] = sorted.filter((r) => r.rank <= limit)
      .map(({ id, ...r }) => ({ rank: r.rank, name: r.name, country: r.country, score: r.score, detail: r.detail, me: id === me }));
    const mine = sorted.find((r) => r.id === me);
    if (mine) result.me[board] = { rank: mine.rank, score: mine.score, detail: mine.detail };
  }
  result.members = profiles.filter((p) => p.public).length;
  return result;
}
