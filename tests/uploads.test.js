import test from 'node:test';
import assert from 'node:assert/strict';
import { fitWithin, validateUpload, IMAGE_MAX, THUMB_MAX } from '../src/core/media.js';
import { snapshotToCommunity, imageURL } from '../src/core/community.js';
import { buildSeedWorld } from '../src/core/seed.js';
import { createWorld } from '../src/core/world.js';

test('images shrink to fit, keep their proportions, and are never enlarged', () => {
  assert.deepEqual(fitWithin(4032, 3024, IMAGE_MAX), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3024, 4032, THUMB_MAX), { width: 360, height: 480 });
  assert.deepEqual(fitWithin(800, 600, IMAGE_MAX), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(10000, 3, THUMB_MAX), { width: 480, height: 1 });
});

test('upload form rules match the database', () => {
  const ok = { title: 'Dusk', category: 'oil', style: 'Abstract', price: 450, year: 2026, fileType: 'image/jpeg', fileSize: 2e6 };
  assert.deepEqual(validateUpload(ok), []);
  assert.match(validateUpload({ ...ok, title: '  ' })[0], /title/);
  assert.match(validateUpload({ ...ok, title: 'x'.repeat(61) })[0], /60/);
  assert.match(validateUpload({ ...ok, category: 'crayons' })[0], /medium/);
  assert.match(validateUpload({ ...ok, style: 'Baroque' })[0], /movement/);
  assert.match(validateUpload({ ...ok, price: 5 })[0], /price/);
  assert.match(validateUpload({ ...ok, price: NaN })[0], /price/);
  assert.match(validateUpload({ ...ok, year: 1800 })[0], /year/);
  assert.match(validateUpload({ ...ok, fileType: 'application/pdf' })[0], /image file/);
  assert.match(validateUpload({ ...ok, fileSize: 40e6 })[0], /30 MB/);
});

test('storage paths become public image URLs', () => {
  const base = 'https://x.supabase.co/storage/v1/object/public/artworks/';
  assert.equal(imageURL('abc/def thumb.webp', base), `${base}abc/def%20thumb.webp`);
  assert.equal(imageURL('data:image/png;base64,AA', base), 'data:image/png;base64,AA');
  assert.equal(imageURL('', base), '');
});

const snap = {
  members: 3,
  artists: [{ id: 'm_1', name: 'Eve Studio', country: 'FR', created_at: '2026-11-04T10:00:00Z' }],
  uploads: [
    { id: 'u_a', artist_id: 'm_1', title: 'Dusk', category: 'oil', style: 'Abstract', medium: null, year: 2026, price: 450, image_path: '1/a.webp', thumb_path: '1/a-thumb.webp', width: 1200, height: 1600, created_at: '2026-11-04T11:00:00Z' },
    { id: 'u_b', artist_id: 'm_1', title: 'Bad', category: 'crayons', style: 'Abstract', image_path: '1/b.webp' },
  ],
  reactions: [{ a: 'u_a', k: 'like', r: 'collector', n: 2 }],
};

test('member uploads and artists join the catalog, with community totals', () => {
  const c = snapshotToCommunity(snap, 0, { storageBase: 'https://x/' });
  assert.deepEqual(c.artworks.map((w) => w.id), ['u_a']); // unknown medium skipped
  assert.equal(c.artworks[0].image, 'https://x/1/a.webp');
  assert.equal(c.artworks[0].thumb, 'https://x/1/a-thumb.webp');
  assert.equal(c.artworks[0].medium, 'Oil on canvas');
  assert.deepEqual([c.artists[0].category, c.artists[0].styles, c.artists[0].debutYear], ['oil', ['Abstract'], 2026]);

  const seed = buildSeedWorld();
  const base = { user: { role: 'artist', country: 'US', name: 'Eve' }, follows: {}, elo: {}, uploads: [], deltas: c.deltas };
  const world = createWorld(seed, { ...base, memberArtists: c.artists, memberArtworks: c.artworks, myArtistId: 'm_1' });
  assert.equal(world.influence.u_a, 18);
  assert.equal(world.artistById.m_1.isMe, true);
  assert.ok(!world.artistById.me, 'no local stand-in artist in community mode');
  assert.ok(world.topArtists({ country: 'FR' }).some((r) => r.item.id === 'm_1'));
  assert.ok(world.topArtworks({ category: 'oil' }).some((r) => r.item.id === 'u_a'));
  const other = createWorld(seed, { ...base, memberArtists: c.artists, memberArtworks: c.artworks, myArtistId: 'm_2' });
  assert.ok(!other.artistById.m_1.isMe);
});
