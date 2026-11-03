import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTaste, updateTaste, nextArtwork, topStyles, EXPLOIT_RATIO } from '../src/core/feed.js';
import { buildSeedWorld } from '../src/core/seed.js';
import { mulberry32 } from '../src/core/random.js';

const { artworks } = buildSeedWorld();

test('liking Impressionism makes it the top style', () => {
  let taste = emptyTaste();
  const imp = artworks.filter((a) => a.style === 'Impressionism').slice(0, 5);
  for (const a of imp) taste = updateTaste(taste, a, 'like');
  taste = updateTaste(taste, artworks.find((a) => a.style === 'Cubism'), 'pass');
  assert.equal(topStyles(taste)[0], 'Impressionism');
  assert.ok(taste.styles.Cubism < 0);
});

test('feed becomes ~80% your taste, still exploring the rest', () => {
  let taste = emptyTaste();
  for (const a of artworks.filter((x) => x.style === 'Impressionism').slice(0, 6)) taste = updateTaste(taste, a, 'like');
  const rng = mulberry32(42);
  const N = 3000;
  let hits = 0;
  for (let i = 0; i < N; i++) if (nextArtwork(artworks, taste, rng).artwork.style === 'Impressionism') hits++;
  const share = hits / N;
  const baseShare = artworks.filter((a) => a.style === 'Impressionism').length / artworks.length;
  assert.ok(share > EXPLOIT_RATIO - 0.03, `share ${share}`);
  assert.ok(share < EXPLOIT_RATIO + (1 - EXPLOIT_RATIO) * baseShare + 0.05, `share ${share}`);
});

test('cold start shows trending art and never repeats seen cards', () => {
  const rng = mulberry32(1);
  const seen = new Set();
  const pool = artworks.slice(0, 20);
  for (let i = 0; i < 20; i++) {
    const n = nextArtwork(pool, emptyTaste(), rng, { seen });
    assert.equal(n.reason, 'Trending worldwide');
    assert.ok(!seen.has(n.artwork.id));
    seen.add(n.artwork.id);
  }
  assert.equal(nextArtwork(pool, emptyTaste(), rng, { seen }), null);
});
