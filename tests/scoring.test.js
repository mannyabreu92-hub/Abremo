import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_WEIGHTS, weightedSum, artworkInfluence, artistScore, influenceBreakdown, emptyRoleCounts } from '../src/core/scoring.js';

const none = () => emptyRoleCounts();

test('role weights match the spec: fan 1, artist 3, critic 5, collector 9', () => {
  assert.deepEqual({ ...ROLE_WEIGHTS }, { fan: 1, artist: 3, critic: 5, collector: 9 });
});

test('pitch example: 100 fan + 20 artist + 10 critic + 5 collector likes = 255', () => {
  const likes = { fan: 100, artist: 20, critic: 10, collector: 5 };
  assert.equal(weightedSum(likes), 255);
  assert.equal(artworkInfluence({ likes, saves: none(), reviews: { count: 0, ratingSum: 0 } }), 255);
});

test('a collector like outweighs eight fan likes', () => {
  const a = artworkInfluence({ likes: { ...none(), collector: 1 }, saves: none(), reviews: null });
  const b = artworkInfluence({ likes: { ...none(), fan: 8 }, saves: none(), reviews: null });
  assert.ok(a > b);
});

test('super likes (collects) count double; a 5★ review beats a critic like', () => {
  assert.equal(artworkInfluence({ likes: none(), saves: { ...none(), fan: 1 }, reviews: null }), 2);
  const review = artworkInfluence({ likes: none(), saves: none(), reviews: { count: 1, ratingSum: 5 } });
  assert.equal(review, 10);
  assert.ok(review > ROLE_WEIGHTS.critic);
});

test('breakdown points sum to the influence score', () => {
  const counts = { likes: { fan: 7, artist: 2, critic: 1, collector: 1 }, saves: { fan: 1, artist: 0, critic: 0, collector: 1 }, reviews: { count: 2, ratingSum: 8 } };
  const total = influenceBreakdown(counts).reduce((s, r) => s + r.points, 0);
  assert.equal(total, artworkInfluence(counts));
});

test('artist score = works influence + weighted followers', () => {
  assert.equal(artistScore(100, { fan: 10, artist: 1, critic: 1, collector: 1 }), 100 + 10 + 3 + 5 + 9);
});
