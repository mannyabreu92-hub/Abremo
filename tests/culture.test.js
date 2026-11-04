import test from 'node:test';
import assert from 'node:assert/strict';
import { credibility, dailyMasterpiece, dayKey, nextRevealAt, artistSignals, percentiles, countryStandings, momentum } from '../src/core/insights.js';
import { tasteScore, tierFor, personalInfluence, dailyActivity, earnedAchievements, MIN_DISCOVERIES } from '../src/core/taste.js';

const counts = (likes = {}, saves = {}, reviews = { count: 0, ratingSum: 0 }) => ({ likes, saves, reviews });

test('credibility is the share of influence from critics and collectors', () => {
  const c = credibility(counts({ fan: 100, artist: 20, critic: 10, collector: 5 })); // 100 + 60 + 50 + 45 = 255
  assert.equal(Math.round(c.total), 255);
  assert.ok(Math.abs(c.share - 95 / 255) < 1e-9);
  assert.ok(Math.abs(c.collectorShare - 45 / 255) < 1e-9);
  assert.deepEqual(credibility(counts()), { share: 0, collectorShare: 0, total: 0 });
});

test('the Daily Masterpiece is stable for a day, changes daily, and never repeats two days running', () => {
  const ranked = Array.from({ length: 80 }, (_, i) => ({ item: { id: `w${i}` }, score: 1000 - i }));
  const cred = () => 0.3;
  const d1 = new Date(2026, 10, 4, 9), d1b = new Date(2026, 10, 4, 23, 59);
  assert.equal(dailyMasterpiece(ranked, cred, d1).artwork.id, dailyMasterpiece(ranked, cred, d1b).artwork.id);
  const picks = Array.from({ length: 30 }, (_, i) => dailyMasterpiece(ranked, cred, new Date(2026, 10, 4 + i, 12)).artwork.id);
  for (let i = 1; i < picks.length; i++) assert.notEqual(picks[i], picks[i - 1]);
  assert.ok(new Set(picks).size > 15);
  for (const p of picks) assert.ok(Number(p.slice(1)) < 60, 'chosen from the top 60');
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(nextRevealAt(new Date(2026, 10, 4, 15)).getTime(), new Date(2026, 10, 5, 0).getTime());
});

test('artist signals need real movement or real momentum', () => {
  const base = { currentYear: 2026 };
  assert.deepEqual(artistSignals({ ...base }), []);
  assert.deepEqual(artistSignals({ ...base, rankDelta: 12, globalRank: 50 }), ['rising', 'trending']);
  assert.deepEqual(artistSignals({ ...base, momentumPercentile: 0.9, debutYear: 2025 }), ['rising']);
  assert.deepEqual(artistSignals({ ...base, momentumPercentile: 0.9, debutYear: 2015 }), [], 'momentum alone flags only recent debuts');
  assert.deepEqual(artistSignals({ ...base, collectorShare: 0.3 }), ['collector']);
  assert.deepEqual(artistSignals({ ...base, rankDelta: null, globalRank: 3 }), [], 'no previous chart yet means no trend claim');
  assert.ok(momentum(500, 0) > momentum(500, 10000));
  const pct = percentiles([1, 2, 3, 4, 5]);
  assert.equal(pct(1), 0);
  assert.equal(pct(5), 1);
});

test('countries are ranked by their artists’ combined score', () => {
  const artists = [{ id: 'a', country: 'FR' }, { id: 'b', country: 'FR' }, { id: 'c', country: 'DO' }];
  const score = { a: 10, b: 5, c: 20 };
  const works = [{ id: 'w1', artistId: 'a' }, { id: 'w2', artistId: 'c' }];
  const rows = countryStandings(artists, (x) => score[x.id], works, (w) => ({ w1: 3, w2: 9 })[w.id]);
  assert.deepEqual(rows.map((r) => [r.country, r.score, r.artists, r.topArtist.id, r.topArtwork.id, r.rank]), [['DO', 20, 1, 'c', 'w2', 1], ['FR', 15, 2, 'a', 'w1', 2]]);
});

const now = (ranks, influence = {}) => ({ rankOf: (id) => ranks[id] ?? null, influenceOf: (id) => influence[id] ?? 0, total: 600 });

test('Taste Score unlocks after five discoveries and rewards finding work early', () => {
  const d = (id, rankAt, style = 'Abstract', influenceAt = 50) => ({ id, rankAt, style, influenceAt });
  assert.deepEqual(tasteScore([d('a', 10)], now({ a: 10 })), { score: null, needed: MIN_DISCOVERIES - 1, count: 1 });
  const popular = ['a', 'b', 'c', 'd', 'e'].map((id, i) => d(id, i + 1));
  const ranksSame = Object.fromEntries(popular.map((x) => [x.id, x.rankAt]));
  const followed = tasteScore(popular, now(ranksSame));
  const styles = ['Abstract', 'Realism', 'Cubism', 'Pop Art', 'Surrealism'];
  const gems = ['f', 'g', 'h', 'i', 'j'].map((id, i) => d(id, 400 + i, styles[i]));
  const early = tasteScore(gems, now({ f: 60, g: 80, h: 150, i: 90, j: 300 }));
  assert.ok(early.score > followed.score + 40, `scout ${early.score} vs crowd ${followed.score}`);
  assert.equal(followed.parts.gems, 0);
  assert.equal(early.parts.gems, 1);
  assert.equal(tierFor(97), 'Global Tastemaker');
  assert.equal(tierFor(86), 'Elite Cultural Scout');
  assert.equal(tierFor(10), 'Emerging Eye');
});

test('personal influence uses the role you had when you acted', () => {
  assert.equal(personalInfluence({ a: 'like', b: 'super', c: 'pass' }, { a: 'collector', b: 'fan' }, [{ rating: 5 }]), 9 + 2 + 10);
});

test('daily activity buckets the last week', () => {
  const t0 = new Date(2026, 10, 10, 12).getTime();
  const day = 86_400_000;
  const series = dailyActivity([{ t: t0, pts: 3 }, { t: t0 - day, pts: 9 }, { t: t0 - 10 * day, pts: 99 }], 7, t0);
  assert.deepEqual(series, [0, 0, 0, 0, 0, 9, 3]);
});

test('achievements are earned from real milestones only', () => {
  const discoveries = Array.from({ length: 25 }, (_, i) => ({ id: `w${i}`, rankAt: i < 5 ? 500 : 10, style: ['A', 'B', 'C', 'D', 'E'][i % 5], influenceAt: 1 }));
  const ranks = Object.fromEntries(discoveries.map((d, i) => [d.id, i < 3 ? 100 : d.rankAt]));
  const got = earnedAchievements({
    discoveries,
    now: now(ranks),
    collections: [{ ids: [1, 2, 3, 4, 5] }, { ids: [1, 2, 3, 4, 5] }, { ids: [1, 2, 3, 4, 5] }],
    taste: { score: 60 },
    follows: { x: { followersAt: 800 }, y: { followersAt: 5000 } },
    followersNow: (id) => ({ x: 1200, y: 9000 })[id],
  });
  assert.deepEqual(got, ['firstDiscovery', 'hiddenGem', 'trendHunter', 'culturalScout', 'masterCurator', 'earlyBeliever1k']);
  assert.deepEqual(earnedAchievements({ discoveries: [], now: now({}) }), []);
});

test('daily masterpiece works with a single ranked work', () => {
  const only = [{ item: { id: 'w1' }, score: 3, rank: 1 }];
  const pick = dailyMasterpiece(only, () => 0, new Date(2026, 10, 4, 12));
  assert.equal(pick.artwork.id, 'w1');
  assert.equal(pick.rank, 1);
});
