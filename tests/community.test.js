import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotToCommunity, mineToState, guestContributions, emptyCommunity } from '../src/core/community.js';
import { resolveConfig, configSource } from '../scripts/write-config.js';
import { buildSeedWorld } from '../src/core/seed.js';
import { createWorld } from '../src/core/world.js';

test('snapshot totals become influence deltas, follower counts and ratings', () => {
  const c = snapshotToCommunity({
    reactions: [{ a: 'w1', k: 'like', r: 'fan', n: 3 }, { a: 'w1', k: 'super', r: 'collector', n: 2 }, { a: 'w1', k: 'like', r: 'hacker', n: 99 }],
    reviews: [{ a: 'w1', n: 2, s: 9 }],
    follows: [{ a: 'a1', r: 'critic', n: 4 }],
    ratings: [{ a: 'w1', v: 1300 }],
    members: 12,
  }, 5);
  assert.deepEqual(c.deltas.w1.likes, { fan: 3, artist: 0, critic: 0, collector: 0 });
  assert.equal(c.deltas.w1.saves.collector, 2);
  assert.deepEqual(c.deltas.w1.reviews, { count: 2, ratingSum: 9 });
  assert.equal(c.followerDeltas.a1.critic, 4);
  assert.equal(c.elo.w1, 1300);
  assert.equal(c.members, 12);
  assert.deepEqual(snapshotToCommunity(null, 0), emptyCommunity());
});

test('community totals move the rankings exactly like local ones', () => {
  const seed = buildSeedWorld();
  const base = { user: { role: 'fan', country: 'US' }, follows: {}, elo: {}, uploads: [] };
  const id = seed.artworks[50].id;
  const before = createWorld(seed, { ...base, deltas: {} }).influence[id];
  const c = snapshotToCommunity({ reactions: [{ a: id, k: 'like', r: 'collector', n: 2 }] });
  const after = createWorld(seed, { ...base, deltas: c.deltas }).influence[id];
  assert.equal(after - before, 18);
});

test('in community mode follower counts come from everyone, not this device', () => {
  const seed = buildSeedWorld();
  const a = seed.artists[3].id;
  const base = { user: { role: 'fan', country: 'US' }, deltas: {}, elo: {}, uploads: [] };
  const local = createWorld(seed, { ...base, follows: { [a]: 'fan' } }).artistScores[a];
  const plain = createWorld(seed, { ...base, follows: {} }).artistScores[a];
  assert.equal(local - plain, 1);
  const community = createWorld(seed, { ...base, follows: { [a]: 'fan' }, followerDeltas: { [a]: { critic: 2 } } }).artistScores[a];
  assert.equal(community - plain, 10);
});

test('own rows map back to app state', () => {
  const s = mineToState({
    reactions: [{ artwork_id: 'w1', kind: 'super', role: 'artist' }],
    follows: [{ artist_id: 'a2', role: 'fan' }],
    reviews: [{ artwork_id: 'w3', rating: 4, body: 'Yes', created_at: '2026-11-04T10:00:00Z' }],
  });
  assert.deepEqual(s.interactions, { w1: 'super' });
  assert.deepEqual(s.interactionRoles, { w1: 'artist' });
  assert.deepEqual(s.follows, { a2: 'fan' });
  assert.deepEqual(s.reviews, [{ artworkId: 'w3', rating: 4, text: 'Yes', at: Date.parse('2026-11-04T10:00:00Z') }]);
});

test('guest activity is imported without overriding the account or uploading private uploads', () => {
  const state = { interactions: { w1: 'like', w2: 'super', w3: 'pass', u123: 'like' }, follows: { a1: 'fan', a9: 'fan', me: 'fan' } };
  const mine = { reactions: [{ artwork_id: 'w2', kind: 'pass' }], follows: [{ artist_id: 'a1' }] };
  const out = guestContributions(state, mine, { artworkIds: new Set(['w1', 'w2', 'w3']), artistIds: new Set(['a1', 'a9']) });
  assert.deepEqual(out.reactions, [{ artwork_id: 'w1', kind: 'like' }, { artwork_id: 'w3', kind: 'pass' }]);
  assert.deepEqual(out.follows, [{ artist_id: 'a9' }]);
});

test('build config: demo without env, community with public keys, refuses secrets', () => {
  assert.equal(resolveConfig({}).mode, 'demo');
  const cfg = resolveConfig({ NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co/', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.x' });
  assert.equal(cfg.mode, 'community');
  assert.equal(cfg.url, 'https://abc.supabase.co');
  assert.match(configSource(cfg), /export const SUPABASE_URL = "https:\/\/abc\.supabase\.co";/);
  const serviceJwt = `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.y`;
  assert.throws(() => resolveConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: serviceJwt }), /secret/);
  assert.throws(() => resolveConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_123' }), /secret/);
  assert.throws(() => resolveConfig({ SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_ANON_KEY: 'k' }), /https/);
  assert.equal(resolveConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc' }).key, 'sb_publishable_abc');
});
