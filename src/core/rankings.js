// Charts: Top Artworks / Top Artists, global, per country, per category. Refreshed hourly.

/** Sort desc by score; ties broken by id for stable charts. Adds a 1-based rank. */
export function rank(items, scoreOf) {
  return items
    .map((item) => ({ item, score: scoreOf(item) }))
    .sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

export function hourKey(date = new Date()) {
  return Math.floor(date.getTime() / 3_600_000);
}

export function rankMap(ranked) {
  const m = {};
  for (const r of ranked) m[r.item.id] = r.rank;
  return m;
}

/** Positive = moved up. null = new entry. */
export function movement(id, currentRank, previousRanks) {
  if (!previousRanks || previousRanks[id] == null) return null;
  return previousRanks[id] - currentRank;
}

/**
 * Hourly snapshot logic: the chart you compare against only rolls over once per hour,
 * like Spotify charts. Returns { snapshot, previous } where previous is what to diff against.
 */
export function rollSnapshot(stored, currentRanks, now = new Date()) {
  const hour = hourKey(now);
  if (!stored) return { snapshot: { hour, ranks: currentRanks, prev: null }, previous: null };
  if (stored.hour === hour) return { snapshot: stored, previous: stored.prev };
  return { snapshot: { hour, ranks: currentRanks, prev: stored.ranks }, previous: stored.ranks };
}
