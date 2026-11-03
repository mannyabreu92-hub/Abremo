import test from 'node:test';
import assert from 'node:assert/strict';
import { commissionRate, checkoutBreakdown, hasFeature, PLANS } from '../src/core/marketplace.js';

test('commission stays within 5–10%', () => {
  for (const p of [10, 999, 1000, 5000, 9999, 10000, 250000]) {
    const r = commissionRate(p);
    assert.ok(r >= 0.05 && r <= 0.1);
  }
  assert.equal(commissionRate(500), 0.1);
  assert.equal(commissionRate(5000), 0.075);
  assert.equal(commissionRate(50000), 0.05);
});

test('checkout breakdown adds up', () => {
  const b = checkoutBreakdown(2400);
  assert.equal(b.fee, 180);
  assert.equal(b.artistPayout, 2220);
  assert.equal(b.fee + b.artistPayout, b.price);
});

test('plans: free to upload, Pro $7.99, Studio $19.99, features gated', () => {
  assert.deepEqual(PLANS.map((p) => p.price), [0, 7.99, 19.99]);
  assert.equal(hasFeature('free', 'whoLiked'), false);
  assert.equal(hasFeature('pro', 'whoLiked'), true);
  assert.equal(hasFeature('pro', 'portfolio'), false);
  assert.equal(hasFeature('studio', 'portfolio'), true);
});
