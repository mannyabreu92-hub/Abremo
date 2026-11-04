import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedWorld, COUNTRIES, ARTISTS_PER_COUNTRY, CATEGORIES } from '../src/core/seed.js';
import { createWorld } from '../src/core/world.js';
import { artistBadges, userBadges } from '../src/core/badges.js';
import { rollSnapshot, movement, hourKey } from '../src/core/rankings.js';

const emptyState = () => ({ user: { name: 'T', role: 'fan', country: 'US', plan: 'free' }, deltas: {}, follows: {}, elo: {}, uploads: [] });

test('seed world is deterministic and covers every country and category', () => {
  const a = buildSeedWorld(), b = buildSeedWorld();
  assert.deepEqual(a, b);
  assert.equal(a.artists.length, COUNTRIES.length * ARTISTS_PER_COUNTRY);
  for (const c of CATEGORIES) assert.ok(a.artworks.some((w) => w.category === c.id), c.id);
  assert.equal(new Set(a.artists.map((x) => x.name + x.country)).size, a.artists.length);
});

test('pitch artworks and artists are present', () => {
  const { artworks, artists } = buildSeedWorld();
  for (const t of ['Starry Dreams', 'Midnight Ocean', 'Red Revolution']) assert.ok(artworks.some((w) => w.title === t), t);
  for (const n of ['Sarah Lee', 'Mark Jones', 'David Kim', 'Pierre Martin', 'Sophie Laurent']) assert.ok(artists.some((a) => a.name === n), n);
});

test('the pitch artworks lead the global chart, artwork first', () => {
  const world = createWorld(buildSeedWorld(), emptyState());
  assert.deepEqual(world.topArtworks().slice(0, 3).map((r) => r.item.title), ['Starry Dreams', 'Midnight Ocean', 'Red Revolution']);
});

test('a collector like moves an artwork more than a fan like', () => {
  const seed = buildSeedWorld();
  const id = seed.artworks[100].id;
  const base = createWorld(seed, emptyState()).influence[id];
  const fan = createWorld(seed, { ...emptyState(), deltas: { [id]: { likes: { fan: 1 } } } }).influence[id];
  const col = createWorld(seed, { ...emptyState(), deltas: { [id]: { likes: { collector: 1 } } } }).influence[id];
  assert.equal(fan - base, 1);
  assert.equal(col - base, 9);
});

test('country charts only contain that country and ranks are contiguous', () => {
  const world = createWorld(buildSeedWorld(), emptyState());
  const fr = world.topArtists({ country: 'FR' });
  assert.equal(fr.length, ARTISTS_PER_COUNTRY);
  assert.ok(fr.every((r) => r.item.country === 'FR'));
  assert.deepEqual(fr.map((r) => r.rank), fr.map((_, i) => i + 1));
  for (let i = 1; i < fr.length; i++) assert.ok(fr[i - 1].score >= fr[i].score);
});

test('following an artist raises their score by your role weight', () => {
  const seed = buildSeedWorld();
  const id = seed.artists[5].id;
  const before = createWorld(seed, emptyState()).artistScores[id];
  const after = createWorld(seed, { ...emptyState(), follows: { [id]: 'critic' } }).artistScores[id];
  assert.equal(after - before, 5);
});

test('badges', () => {
  assert.deepEqual(artistBadges({ globalRank: 50, countryRank: 3, debutYear: 2025, currentYear: 2026 }), ['rising', 'topCountry', 'topGlobal']);
  assert.deepEqual(artistBadges({ globalRank: 1, countryRank: 1, debutYear: 2026, currentYear: 2026, score: 0 }), []);
  assert.deepEqual(artistBadges({ globalRank: 150, countryRank: 120, debutYear: 2015, currentYear: 2026 }), []);
  assert.deepEqual(userBadges({ role: 'collector', collectedCount: 10 }), ['collectorElite']);
  assert.deepEqual(userBadges({ role: 'fan', collectedCount: 50 }), []);
  assert.deepEqual(userBadges({ role: 'critic', reviewCount: 12, trendHits: 3 }), ['masterCritic', 'trendSetter']);
});

test('chart snapshot rolls over once per hour', () => {
  const t0 = new Date('2026-11-03T10:15:00Z');
  const t1 = new Date('2026-11-03T10:55:00Z');
  const t2 = new Date('2026-11-03T11:05:00Z');
  const s0 = rollSnapshot(null, { x: 2 }, t0).snapshot;
  const r1 = rollSnapshot(s0, { x: 1 }, t1);
  assert.equal(r1.snapshot, s0);
  const r2 = rollSnapshot(s0, { x: 1 }, t2);
  assert.equal(r2.snapshot.hour, hourKey(t2));
  assert.deepEqual(r2.previous, { x: 2 });
  assert.equal(movement('x', 1, r2.previous), 1);
  assert.equal(movement('y', 1, r2.previous), null);
});

test('community catalog: sample works carry no simulated activity, and only real activity is ranked', async () => {
  const { sampleCatalog } = await import('../src/core/community.js');
  const { START_RATING } = await import('../src/core/elo.js');
  const cat = sampleCatalog(buildSeedWorld());
  assert.ok(cat.artworks.every((w) => w.sample && w.elo === START_RATING && Object.values(w.counts.likes).every((n) => n === 0) && w.counts.reviews.count === 0));
  assert.ok(cat.artists.every((a) => a.sample && Object.values(a.followers).every((n) => n === 0)));
  const liked = cat.artworks[42];
  const battled = cat.artworks[7];
  const world = createWorld(cat, {
    ...emptyState(), rankedOnly: true, followerDeltas: {}, memberArtists: [], memberArtworks: [],
    deltas: { [liked.id]: { likes: { fan: 2, artist: 0, critic: 0, collector: 0 }, saves: { fan: 0, artist: 0, critic: 0, collector: 0 }, reviews: { count: 0, ratingSum: 0 } } },
    elo: { [battled.id]: 1216 },
  });
  const ranked = world.topArtworks().filter((r) => r.rank != null);
  assert.deepEqual(ranked.map((r) => [r.item.id, r.rank]), [[liked.id, 1]]);
  assert.equal(world.topArtworks().length, cat.artworks.length, 'everything stays browsable');
  assert.deepEqual(Object.keys(world.globalArtistRanks), [liked.artistId]);
  assert.deepEqual(world.topElo().filter((r) => r.rank != null).map((r) => r.item.id), [battled.id], 'only works that have battled are on the battle chart');
  // Demo mode is unchanged: everything is ranked.
  const demo = createWorld(buildSeedWorld(), emptyState());
  assert.ok(demo.topArtworks().every((r) => r.rank > 0));
});
